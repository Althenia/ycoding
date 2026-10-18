use super::{
    Cancellation, HttpRequest, Service, identity, random_id, storage, timestamp, unavailable, utf8,
};
use ring::hmac;
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString,
    mcp_events::{EventData, Failure, FailureCategory, Name, Payload, Principal, State},
    session,
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart, TableSpec,
    mcp_events::{Outbox, OutboxTable, SubscriptionTable},
    tuple_key,
};

const RETENTION: i64 = 7 * 86_400_000;

pub fn headers(
    id: &str,
    timestamp: i64,
    body: &str,
    secrets: &[&[u8]],
    subscription: &str,
) -> BTreeMap<String, String> {
    let signed = format!("{id}.{timestamp}.{body}");
    let signature = secrets
        .iter()
        .map(|secret| {
            format!(
                "v1,{}",
                crate::resources::mcp::skills::encode_base64(
                    hmac::sign(
                        &hmac::Key::new(hmac::HMAC_SHA256, secret),
                        signed.as_bytes()
                    )
                    .as_ref(),
                    false
                )
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    BTreeMap::from([
        ("Content-Type".into(), "application/json".into()),
        ("webhook-id".into(), id.into()),
        ("webhook-timestamp".into(), timestamp.to_string()),
        ("webhook-signature".into(), signature),
        ("X-MCP-Subscription-Id".into(), subscription.into()),
    ])
}

impl Service {
    pub(super) async fn watermark(&self, id: &LosslessString) -> Result<(i64, i64), Failure> {
        let snapshot = self.deps.store.snapshot().map_err(storage)?;
        let pruned = snapshot
            .get::<SubscriptionTable>(&tuple_key(&[KeyPart::String(id)]))
            .map_err(storage)?
            .map_or(0, |row| row.pruned_through);
        let prefix = tuple_key(&[KeyPart::String(id)]);
        let mut after = None;
        let mut last = pruned;
        loop {
            let entries = snapshot
                .index_range::<OutboxTable>(
                    "mcp_event_outbox_subscription_seq_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 100,
                    },
                )
                .map_err(storage)?;
            if entries.is_empty() {
                return Ok((last, pruned));
            }
            for entry in &entries {
                let row = &entry.record;
                if row.delivered_at.is_none() && row.dead == 0 {
                    return Ok((row.seq.saturating_sub(1), pruned));
                }
                last = last.max(row.seq);
            }
            after = entries.last().map(|entry| entry.cursor.clone());
            tokio::task::yield_now().await;
        }
    }

    pub(super) async fn replay(
        &self,
        id: &LosslessString,
        seq: i64,
        now: i64,
    ) -> Result<(), Failure> {
        let _dispatch = self.dispatch_gate.lock().await;
        let prefix = tuple_key(&[KeyPart::String(id)]);
        let lower = tuple_key(&[KeyPart::String(id), KeyPart::I64(seq)]);
        let mut after = None;
        loop {
            let entries = self
                .deps
                .store
                .snapshot()
                .map_err(storage)?
                .index_range::<OutboxTable>(
                    "mcp_event_outbox_subscription_seq_idx",
                    IndexQuery {
                        lower: Bound::Excluded(&lower),
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 100,
                    },
                )
                .map_err(storage)?;
            if entries.is_empty() {
                return Ok(());
            }
            after = entries.last().map(|entry| entry.cursor.clone());
            self.deps
                .store
                .submit(move |tx| {
                    for entry in entries {
                        if let Some(mut row) =
                            tx.get::<OutboxTable>(&OutboxTable::primary_key(&entry.record))?
                        {
                            if row.delivered_at.is_none() || row.time_created < now - RETENTION {
                                continue;
                            }
                            row.delivered_at = None;
                            row.dead = 0;
                            row.next_attempt_at = now;
                            OutboxTable::put(tx, &row)?;
                        }
                    }
                    Ok(())
                })
                .map_err(storage)?
                .await
                .map_err(storage)?;
            tokio::task::yield_now().await;
        }
    }

    async fn prune(&self, now: i64) -> Result<(), Failure> {
        let mut after: Option<Vec<u8>> = None;
        loop {
            let rows = self
                .deps
                .store
                .snapshot()
                .map_err(storage)?
                .scan::<OutboxTable>(
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    100,
                )
                .map_err(storage)?;
            let total = rows.len();
            if total == 0 {
                return Ok(());
            }
            after = rows.last().map(OutboxTable::primary_key);
            let expired = rows
                .into_iter()
                .filter(|row| {
                    row.time_created < now - RETENTION
                        && (row.delivered_at.is_some() || row.dead != 0)
                })
                .collect::<Vec<_>>();
            if !expired.is_empty() {
                self.deps
                    .store
                    .submit(move |tx| {
                        for row in expired {
                            let key = OutboxTable::primary_key(&row);
                            let Some(current) = tx.get::<OutboxTable>(&key)? else {
                                continue;
                            };
                            if current.time_created >= now - RETENTION
                                || (current.delivered_at.is_none() && current.dead == 0)
                            {
                                continue;
                            }
                            let subkey = tuple_key(&[KeyPart::String(&current.subscription_id)]);
                            if let Some(mut sub) = tx.get::<SubscriptionTable>(&subkey)? {
                                sub.pruned_through = sub.pruned_through.max(current.seq);
                                SubscriptionTable::put(tx, &sub)?;
                            }
                            tx.delete::<OutboxTable>(&key)?;
                        }
                        Ok(())
                    })
                    .map_err(storage)?
                    .await
                    .map_err(storage)?;
            }
            if total < 100 {
                return Ok(());
            }
            tokio::task::yield_now().await;
        }
    }

    async fn earlier_pending(&self, row: &Outbox) -> Result<bool, Failure> {
        let snapshot = self.deps.store.snapshot().map_err(storage)?;
        let prefix = tuple_key(&[KeyPart::String(&row.subscription_id)]);
        let upper = tuple_key(&[KeyPart::String(&row.subscription_id), KeyPart::I64(row.seq)]);
        let mut after = None;
        loop {
            let entries = snapshot
                .index_range::<OutboxTable>(
                    "mcp_event_outbox_subscription_seq_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Excluded(&upper),
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 100,
                    },
                )
                .map_err(storage)?;
            if entries
                .iter()
                .any(|entry| entry.record.delivered_at.is_none() && entry.record.dead == 0)
            {
                return Ok(true);
            }
            if entries.len() < 100 {
                return Ok(false);
            }
            after = entries.last().map(|entry| entry.cursor.clone());
            tokio::task::yield_now().await;
        }
    }

    async fn retire(&self, row: &Outbox, disable: bool, now: i64) -> Result<(), Failure> {
        let row = row.clone();
        self.abort_subscription(&row.subscription_id);
        self.deps
            .store
            .submit(move |tx| {
                if disable {
                    let key = tuple_key(&[KeyPart::String(&row.subscription_id)]);
                    if let Some(mut sub) = tx.get::<SubscriptionTable>(&key)? {
                        sub.disabled = 1;
                        sub.time_updated = now;
                        SubscriptionTable::put(tx, &sub)?;
                    }
                }
                if let Some(mut current) = tx.get::<OutboxTable>(&OutboxTable::primary_key(&row))? {
                    current.dead = 1;
                    OutboxTable::put(tx, &current)?;
                }
                Ok(())
            })
            .map_err(storage)?
            .await
            .map_err(storage)
    }

    pub async fn dispatch_once(&self, cancellation: Cancellation) -> Result<(), Failure> {
        let _dispatch = self.dispatch_gate.lock().await;
        self.require_active(&cancellation)?;
        let now = (self.deps.clock)();
        self.prune(now).await?;
        let prefix = tuple_key(&[KeyPart::Null, KeyPart::I64(0)]);
        let upper = tuple_key(&[
            KeyPart::Null,
            KeyPart::I64(0),
            KeyPart::I64(now.saturating_add(1)),
        ]);
        let mut rows = self
            .deps
            .store
            .snapshot()
            .map_err(storage)?
            .index_range::<OutboxTable>(
                "mcp_event_outbox_dispatch_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Excluded(&upper),
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: None,
                    limit: 100,
                },
            )
            .map_err(storage)?
            .into_iter()
            .map(|entry| entry.record)
            .collect::<Vec<_>>();
        rows.sort_by_key(|row| row.seq);
        let mut blocked = BTreeSet::new();
        for row in rows {
            self.require_active(&cancellation)?;
            if blocked.contains(&row.subscription_id) || self.earlier_pending(&row).await? {
                blocked.insert(row.subscription_id.clone());
                continue;
            }
            let subkey = tuple_key(&[KeyPart::String(&row.subscription_id)]);
            let sub = self
                .deps
                .store
                .snapshot()
                .map_err(storage)?
                .get::<SubscriptionTable>(&subkey)
                .map_err(storage)?;
            let now = (self.deps.clock)();
            let Some(sub) = sub.filter(|sub| sub.disabled == 0 && sub.expires_at > now) else {
                self.retire(&row, false, now).await?;
                continue;
            };
            let principal = Principal {
                owner_id: sub.owner_id.clone(),
                device_id: sub.device_id.clone(),
                client_id: sub.client_id.clone(),
                grant_id: sub.grant_id.clone(),
                epoch: sub.epoch.clone(),
            };
            let permit = match self
                .deps
                .authorization
                .check(principal, cancellation.clone())
                .await
            {
                Ok(permit) => permit,
                Err(error) => {
                    if error.category == FailureCategory::Unavailable {
                        let saved = row.clone();
                        self.deps
                            .store
                            .submit(move |tx| {
                                if let Some(mut row) =
                                    tx.get::<OutboxTable>(&OutboxTable::primary_key(&saved))?
                                {
                                    row.next_attempt_at = now.saturating_add(30_000);
                                    OutboxTable::put(tx, &row)?;
                                }
                                Ok(())
                            })
                            .map_err(storage)?
                            .await
                            .map_err(storage)?;
                    } else {
                        self.retire(&row, true, now).await?;
                    }
                    blocked.insert(row.subscription_id.clone());
                    continue;
                }
            };
            let now = (self.deps.clock)();
            if permit.cancellation.is_cancelled() || permit.expires_at <= now {
                self.retire(&row, true, now).await?;
                blocked.insert(row.subscription_id.clone());
                continue;
            }
            let handoff = self.handoff.lock().await;
            let current = self
                .deps
                .store
                .snapshot()
                .map_err(storage)?
                .get::<SubscriptionTable>(&subkey)
                .map_err(storage)?;
            let Some(sub) = current.filter(|sub| sub.disabled == 0 && sub.expires_at > now) else {
                drop(handoff);
                self.retire(&row, false, now).await?;
                continue;
            };
            let box_ = self.secret_box()?;
            let Some(secret) = box_.decrypt(&utf8(&sub.secret_ciphertext)?) else {
                drop(handoff);
                self.retire(&row, true, now).await?;
                continue;
            };
            let previous = if sub.previous_secret_until.is_some_and(|until| until > now) {
                sub.previous_secret_ciphertext
                    .as_ref()
                    .and_then(|value| value.as_str())
                    .and_then(|value| box_.decrypt(value))
            } else {
                None
            };
            let name = Name::decode(&row.name.encode()).map_err(|_| unavailable())?;
            let payload = Payload {
                event_id: row.id.clone(),
                name,
                timestamp: timestamp(row.time_created)?.into(),
                data: EventData {
                    session_id: session::Id::new(row.session_id.clone())
                        .map_err(|_| unavailable())?,
                    root_session_id: session::Id::new(row.root_session_id.clone())
                        .map_err(|_| unavailable())?,
                    state: State::decode(&row.state.encode()).map_err(|_| unavailable())?,
                    request_id: row.request_id.clone(),
                    item_id: row.item_id.clone(),
                    task_id: row.task_id.clone(),
                    category: row.category.clone(),
                    reason: row.reason.clone(),
                },
                cursor: if identity::replayable(name) {
                    Some(
                        box_.encode_cursor(&utf8(&sub.identity_hash)?, row.seq)
                            .ok_or_else(unavailable)?
                            .into(),
                    )
                } else {
                    None
                },
            };
            let body = ycoding_schema::stringify_json(&payload.encode());
            if body.len() > 262_144 {
                drop(handoff);
                self.retire(&row, false, now).await?;
                continue;
            }
            let mut secrets = vec![secret.as_slice()];
            if let Some(previous) = &previous {
                secrets.push(previous.as_slice());
            }
            let token = Cancellation::default();
            self.inflight
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(sub.id.clone(), token.clone());
            drop(handoff);
            let timeout = 10_000i64
                .min(sub.expires_at.saturating_sub(now))
                .min(permit.expires_at.saturating_sub(now))
                .max(0) as u64;
            let request = HttpRequest {
                url: utf8(&sub.callback_url)?,
                body: body.clone(),
                headers: headers(
                    &utf8(&row.id)?,
                    now / 1000,
                    &body,
                    &secrets,
                    &utf8(&sub.id)?,
                ),
                timeout_ms: timeout,
            };
            let sent = tokio::select! {biased;_=cancellation.cancelled()=>{token.cancel();Err(super::authorization_unavailable())},result=self.send(request,token.clone(),Some(permit.cancellation.clone()))=>result};
            self.inflight
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&sub.id);
            let at = (self.deps.clock)();
            let success = sent
                .as_ref()
                .is_ok_and(|reply| (200..300).contains(&reply.status));
            let terminal = sent
                .as_ref()
                .is_ok_and(|reply| matches!(reply.status, 410 | 413));
            if !success {
                blocked.insert(row.subscription_id.clone());
            }
            self.deps
                .store
                .submit(move |tx| {
                    let Some(mut current) =
                        tx.get::<OutboxTable>(&OutboxTable::primary_key(&row))?
                    else {
                        return Ok(());
                    };
                    if current.dead != 0 || current.delivered_at.is_some() {
                        return Ok(());
                    }
                    if success {
                        current.delivered_at = Some(at);
                    } else {
                        current.attempts = current.attempts.saturating_add(1);
                        if terminal || current.attempts >= 5 {
                            current.dead = 1;
                        } else {
                            current.next_attempt_at = at.saturating_add(
                                5_000i64
                                    .saturating_mul(
                                        1i64 << ((current.attempts - 1).clamp(0, 16) as u32),
                                    )
                                    .min(300_000),
                            );
                        }
                    }
                    OutboxTable::put(tx, &current)
                })
                .map_err(storage)?
                .await
                .map_err(storage)?;
        }
        Ok(())
    }

    pub async fn reconcile(&self) -> Result<(), Failure> {
        let mut after: Option<Vec<u8>> = None;
        loop {
            let snapshot = self.deps.store.snapshot().map_err(storage)?;
            let rows = snapshot
                .scan::<OutboxTable>(
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    100,
                )
                .map_err(storage)?;
            let total = rows.len();
            if total == 0 {
                return Ok(());
            }
            after = rows.last().map(OutboxTable::primary_key);
            for row in rows {
                if !matches!(
                    row.name.as_str(),
                    Some(
                        "session.guardrail.changed"
                            | "session.permission.changed"
                            | "session.question.changed"
                            | "session.form.changed"
                    )
                ) || row.state.as_str() != Some("pending")
                    || row.item_id.is_some()
                    || row.request_id.is_none()
                {
                    continue;
                }
                let prefix = tuple_key(&[KeyPart::String(&row.subscription_id)]);
                let lower =
                    tuple_key(&[KeyPart::String(&row.subscription_id), KeyPart::I64(row.seq)]);
                let mut cursor = None;
                let mut later = false;
                loop {
                    let entries = snapshot
                        .index_range::<OutboxTable>(
                            "mcp_event_outbox_subscription_seq_idx",
                            IndexQuery {
                                lower: Bound::Excluded(&lower),
                                upper: Bound::Unbounded,
                                prefix: Some(&prefix),
                                order: IndexOrder::Ascending,
                                after: cursor.as_ref(),
                                limit: 100,
                            },
                        )
                        .map_err(storage)?;
                    if entries.iter().any(|entry| {
                        entry.record.name == row.name && entry.record.request_id == row.request_id
                    }) {
                        later = true;
                        break;
                    }
                    if entries.len() < 100 {
                        break;
                    }
                    cursor = entries.last().map(|entry| entry.cursor.clone());
                    tokio::task::yield_now().await;
                }
                if later {
                    continue;
                }
                let mut cancellation = row;
                cancellation.id = random_id("evt_")?;
                cancellation.dedupe_key =
                    format!("{}:restart-cancelled", utf8(&cancellation.dedupe_key)?).into();
                cancellation.state = "cancelled".into();
                cancellation.reason = Some("restart".into());
                cancellation.time_created = (self.deps.clock)();
                cancellation.attempts = 0;
                cancellation.next_attempt_at = cancellation.time_created;
                cancellation.delivered_at = None;
                cancellation.dead = 0;
                self.deps
                    .store
                    .submit(move |tx| {
                        if !tx
                            .index::<OutboxTable>(
                                "mcp_event_outbox_dedupe_idx",
                                &tuple_key(&[KeyPart::String(&cancellation.dedupe_key)]),
                                None,
                                1,
                            )?
                            .is_empty()
                        {
                            return Ok(());
                        }
                        cancellation.seq = ycoding_store::mcp_events::next_sequence(tx)?;
                        if cancellation.seq > 9_007_199_254_740_991 {
                            return Err(tx.reject(ycoding_store::Error::Rejected(
                                "MCP Events sequence exceeds the cursor range",
                            )));
                        }
                        OutboxTable::insert(tx, &cancellation)
                    })
                    .map_err(storage)?
                    .await
                    .map_err(storage)?;
            }
            if total < 100 {
                return Ok(());
            }
            tokio::task::yield_now().await;
        }
    }
}
