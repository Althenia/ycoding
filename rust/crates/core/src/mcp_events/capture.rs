use super::{EventInput, Service, storage, unavailable};
use std::ops::Bound;

pub const TYPES: &[&str] = &[
    "guardrail.asked",
    "guardrail.replied",
    "guardrail.deferred",
    "guardrail.decided",
    "permission.asked",
    "permission.replied",
    "permission.deferred",
    "question.asked",
    "question.replied",
    "question.rejected",
    "question.timed_out",
    "question.deferred",
    "form.created",
    "form.replied",
    "form.cancelled",
    "form.timed_out",
    "form.deferred",
    "session.guardrail.escalated.1",
    "session.guardrail.decided.1",
    "session.guardrail.approved.1",
    "session.guardrail.dismissed.1",
    "session.review.deferred.1",
    "session.review.decided.1",
    "session.review.withdrawn.1",
    "session.execution.started.1",
    "session.execution.succeeded.1",
    "session.execution.interrupted.1",
    "session.execution.failed.1",
    "session.work.completed.1",
    "session.task.updated.1",
];
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString,
    mcp_events::{Failure, Name, State},
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart, TableSpec,
    mcp_events::{Outbox, OutboxTable, SubscriptionTable},
    session::SessionTable,
    tuple_key,
};

pub struct Notification {
    pub name: Name,
    pub session_id: LosslessString,
    pub state: State,
    pub source_id: LosslessString,
    pub request_id: Option<LosslessString>,
    pub item_id: Option<LosslessString>,
    pub task_id: Option<LosslessString>,
    pub category: Option<LosslessString>,
    pub reason: Option<LosslessString>,
}

pub fn identifier(value: Option<&JsonValue>, category: bool) -> Option<LosslessString> {
    let JsonValue::String(value) = value? else {
        return None;
    };
    let text = value.as_str()?;
    let max = if category { 64 } else { 128 };
    (!text.is_empty()
        && text.len() <= max
        && text.bytes().enumerate().all(|(at, byte)| {
            if category {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || (at > 0 && matches!(byte, b'.' | b'_' | b'-'))
            } else {
                byte.is_ascii_alphanumeric() || (at > 0 && matches!(byte, b'_' | b'-'))
            }
        }))
    .then(|| value.clone())
}

fn get<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(value) => value.get(&key.into()),
        _ => None,
    }
}
fn text(value: Option<&JsonValue>) -> Option<&str> {
    match value? {
        JsonValue::String(value) => value.as_str(),
        _ => None,
    }
}

pub fn map_event(input: &EventInput) -> Option<Notification> {
    let kind = input.event_type.as_str()?;
    let kind = kind.strip_suffix(".1").unwrap_or(kind);
    let data = &input.data;
    let sid = identifier(get(data, "sessionID"), false);
    let mut result = Notification {
        name: Name::Progress,
        session_id: sid.unwrap_or_default(),
        state: State::Running,
        source_id: identifier(Some(&input.id.encode()), false)?,
        request_id: None,
        item_id: None,
        task_id: None,
        category: None,
        reason: None,
    };
    match kind {
        "guardrail.asked" | "permission.asked" | "question.asked" => {
            result.name = match kind {
                "guardrail.asked" => Name::GuardrailChanged,
                "permission.asked" => Name::PermissionChanged,
                _ => Name::QuestionChanged,
            };
            result.state = State::Pending;
            result.request_id = identifier(get(data, "id"), false);
            if kind == "permission.asked" {
                result.category = identifier(get(data, "action"), true);
            }
        }
        "guardrail.replied" | "permission.replied" | "question.replied" | "question.rejected"
        | "question.timed_out" => {
            result.name = if kind.starts_with("guardrail.") {
                Name::GuardrailChanged
            } else if kind.starts_with("permission.") {
                Name::PermissionChanged
            } else {
                Name::QuestionChanged
            };
            result.request_id = identifier(get(data, "requestID"), false);
            result.state = if matches!(kind, "question.rejected" | "question.timed_out") {
                State::Cancelled
            } else {
                State::Resolved
            };
            result.reason = match kind {
                "question.rejected" => Some("rejected".into()),
                "question.timed_out" => Some("timed_out".into()),
                "question.replied" => None,
                _ => identifier(get(data, "reply"), true),
            };
        }
        "guardrail.deferred" | "permission.deferred" | "question.deferred" => {
            result.name = match kind {
                "guardrail.deferred" => Name::GuardrailChanged,
                "permission.deferred" => Name::PermissionChanged,
                _ => Name::QuestionChanged,
            };
            result.state = State::Deferred;
            result.request_id = identifier(get(data, "requestID"), false);
            result.item_id = identifier(get(data, "itemID"), false);
        }
        "guardrail.decided" => {
            result.name = Name::GuardrailChanged;
            result.state = if text(get(data, "decision")) == Some("ask") {
                State::Pending
            } else {
                State::Resolved
            };
            result.reason = identifier(get(data, "decision"), true);
        }
        "form.created" => {
            let form = get(data, "form")?;
            result.name = Name::FormChanged;
            result.state = State::Pending;
            result.session_id = identifier(get(form, "sessionID"), false)?;
            result.request_id = identifier(get(form, "id"), false);
        }
        "form.replied" | "form.cancelled" | "form.timed_out" | "form.deferred" => {
            result.name = Name::FormChanged;
            result.state = match kind {
                "form.replied" => State::Resolved,
                "form.deferred" => State::Deferred,
                _ => State::Cancelled,
            };
            result.request_id = identifier(get(data, "id"), false);
            result.item_id = identifier(get(data, "itemID"), false);
            if kind == "form.timed_out" {
                result.reason = Some("timed_out".into());
            }
        }
        "session.guardrail.escalated"
        | "session.guardrail.decided"
        | "session.guardrail.approved"
        | "session.guardrail.dismissed" => {
            result.name = Name::GuardrailChanged;
            result.state = if kind == "session.guardrail.escalated" {
                State::Pending
            } else {
                State::Resolved
            };
            result.request_id = identifier(get(data, "requestID"), false);
            if matches!(
                kind,
                "session.guardrail.decided" | "session.guardrail.dismissed"
            ) && let Some(sid) = identifier(get(data, "reviewSessionID"), false)
            {
                result.session_id = sid;
            }
            result.reason = match kind {
                "session.guardrail.approved" => Some("approved".into()),
                "session.guardrail.dismissed" => Some("dismissed".into()),
                _ => identifier(get(data, "reply"), true),
            };
            if kind == "session.guardrail.dismissed" {
                result.category = identifier(get(data, "ruleID"), true);
            }
        }
        "session.review.deferred" | "session.review.decided" | "session.review.withdrawn" => {
            let payload = get(data, "payload");
            let origin = get(data, "origin");
            result.name = if text(payload.and_then(|value| get(value, "type"))) == Some("form") {
                Name::FormChanged
            } else {
                match text(get(data, "kind"))? {
                    "guardrail" => Name::GuardrailChanged,
                    "permission" => Name::PermissionChanged,
                    "question" | "subagent_question" => Name::QuestionChanged,
                    "form" => Name::FormChanged,
                    _ => return None,
                }
            };
            result.state = match kind {
                "session.review.deferred" => State::Deferred,
                "session.review.decided" => State::Resolved,
                _ => State::Cancelled,
            };
            result.item_id = identifier(get(data, "itemID"), false);
            result.request_id =
                identifier(payload.and_then(|value| get(value, "requestID")), false)
                    .or_else(|| identifier(origin.and_then(|value| get(value, "requestID")), false))
                    .or_else(|| {
                        identifier(origin.and_then(|value| get(value, "questionID")), false)
                    });
            result.reason = if kind == "session.review.withdrawn" {
                identifier(get(data, "reason"), true)
            } else {
                identifier(
                    get(data, "decision").and_then(|value| get(value, "reply")),
                    true,
                )
            };
        }
        "session.execution.started" => {}
        "session.execution.succeeded" => result.state = State::Completed,
        "session.execution.interrupted" => {
            result.state = State::Interrupted;
            result.reason = identifier(get(data, "reason"), true);
        }
        "session.execution.failed" => {
            result.name = Name::Error;
            result.state = State::Failed;
            result.category = identifier(
                get(data, "error").and_then(|value| get(value, "type")),
                true,
            );
        }
        "session.work.completed" => {
            result.name = Name::Completed;
            result.state = State::Completed;
        }
        "session.task.updated" => {
            let change = get(data, "change")?;
            result.task_id = Some(result.session_id.clone());
            match text(get(change, "type"))? {
                "launched" | "started" | "backgrounded" | "resumed" => {}
                "completed" => result.state = State::Completed,
                "cancelled" => result.state = State::Cancelled,
                "lost" => {
                    result.state = State::Cancelled;
                    result.reason = Some("lost".into());
                }
                "failed" => {
                    result.name = Name::Error;
                    result.state = State::Failed;
                }
                _ => return None,
            }
        }
        _ => return None,
    }
    if !result.session_id.as_str()?.starts_with("ses") {
        return None;
    }
    result.source_id = result
        .request_id
        .clone()
        .or_else(|| result.item_id.clone())
        .or_else(|| result.task_id.clone())
        .unwrap_or(result.source_id);
    Some(result)
}

impl Service {
    pub async fn capture(&self, mut input: EventInput) -> Result<(), Failure> {
        let _capture = self.capture_gate.lock().await;
        if matches!(
            input.event_type.as_str(),
            Some(
                "session.review.decided"
                    | "session.review.withdrawn"
                    | "session.review.decided.1"
                    | "session.review.withdrawn.1"
            )
        ) && let Some(JsonValue::String(sid)) = get(&input.data, "sessionID")
        {
            let snapshot = self.deps.store.snapshot().map_err(storage)?;
            let folded = crate::session::review_fold::fold(&snapshot, std::slice::from_ref(sid))
                .map_err(storage)?;
            if let Some(item) = folded
                .into_iter()
                .find(|item| Some(&item.item_id.encode()) == get(&input.data, "itemID"))
                && let JsonValue::Object(data) = &mut input.data
            {
                data.insert("sessionID".into(), item.session_id.encode());
                data.insert("kind".into(), item.deferral.kind.encode());
                data.insert("origin".into(), item.deferral.origin.encode());
                data.insert("payload".into(), item.deferral.payload.encode());
            }
        }
        let Some(notification) = map_event(&input) else {
            return Ok(());
        };
        let snapshot = self.deps.store.snapshot().map_err(storage)?;
        let mut chain = vec![];
        let mut current = Some(notification.session_id.clone());
        while let Some(id) = current {
            if chain.len() >= 64 || chain.contains(&id) {
                break;
            }
            chain.push(id.clone());
            current = snapshot
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&id)]))
                .map_err(storage)?
                .and_then(|row| row.parent_id);
        }
        let root = chain.last().cloned().ok_or_else(unavailable)?;
        let mut after: Option<Vec<u8>> = None;
        loop {
            let rows = snapshot
                .scan::<SubscriptionTable>(
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    100,
                )
                .map_err(storage)?;
            let next = rows.last().map(SubscriptionTable::primary_key);
            let total = rows.len();
            let now = (self.deps.clock)();
            let matched = rows
                .into_iter()
                .filter(|sub| {
                    sub.name.as_str() == Some(notification.name.as_str())
                        && sub.disabled == 0
                        && sub.expires_at > now
                        && (sub.session_id == notification.session_id
                            || (sub.include_descendants == 1 && chain.contains(&sub.session_id)))
                })
                .collect::<Vec<_>>();
            for sub in matched {
                let dedupe = format!(
                    "{}:{}:{}:{}",
                    super::utf8(&sub.id)?,
                    notification.name.as_str(),
                    super::utf8(&notification.source_id)?,
                    notification.state.as_str()
                );
                let notification = &notification;
                let row = Outbox {
                    seq: 0,
                    id: super::random_id("evt_")?,
                    subscription_id: sub.id.clone(),
                    dedupe_key: dedupe.into(),
                    name: notification.name.as_str().into(),
                    session_id: notification.session_id.clone(),
                    root_session_id: root.clone(),
                    state: notification.state.as_str().into(),
                    request_id: notification.request_id.clone(),
                    item_id: notification.item_id.clone(),
                    task_id: notification.task_id.clone(),
                    category: notification.category.clone(),
                    reason: notification.reason.clone(),
                    time_created: input.created,
                    attempts: 0,
                    next_attempt_at: now,
                    delivered_at: None,
                    dead: 0,
                };
                let progress = notification.name == Name::Progress;
                let mut recent = None;
                if progress {
                    let prefix = tuple_key(&[KeyPart::String(&sub.id)]);
                    let mut cursor = None;
                    loop {
                        let entries = snapshot
                            .index_range::<OutboxTable>(
                                "mcp_event_outbox_subscription_seq_idx",
                                IndexQuery {
                                    lower: Bound::Unbounded,
                                    upper: Bound::Unbounded,
                                    prefix: Some(&prefix),
                                    order: IndexOrder::Descending,
                                    after: cursor.as_ref(),
                                    limit: 100,
                                },
                            )
                            .map_err(storage)?;
                        if let Some(found) = entries.iter().find(|entry| {
                            entry.record.name == row.name
                                && entry.record.session_id == row.session_id
                        }) {
                            recent = Some(found.record.clone());
                            break;
                        }
                        if entries.len() < 100 {
                            break;
                        }
                        cursor = entries.last().map(|entry| entry.cursor.clone());
                        tokio::task::yield_now().await;
                    }
                }
                self.deps
                    .store
                    .submit(move |tx| {
                        if !tx
                            .index::<OutboxTable>(
                                "mcp_event_outbox_dedupe_idx",
                                &tuple_key(&[KeyPart::String(&row.dedupe_key)]),
                                None,
                                1,
                            )?
                            .is_empty()
                        {
                            return Ok(());
                        }
                        let Some(current) =
                            tx.get::<SubscriptionTable>(&SubscriptionTable::primary_key(&sub))?
                        else {
                            return Ok(());
                        };
                        if current.disabled != 0 || current.expires_at <= now {
                            return Ok(());
                        }
                        if recent.is_some_and(|last| {
                            last.state == row.state && now - last.time_created < 30_000
                        }) {
                            return Ok(());
                        }
                        let mut row = row;
                        row.seq = ycoding_store::mcp_events::next_sequence(tx)?;
                        if row.seq > 9_007_199_254_740_991 {
                            return Err(tx.reject(ycoding_store::Error::Rejected(
                                "MCP Events sequence exceeds the cursor range",
                            )));
                        }
                        OutboxTable::insert(tx, &row)
                    })
                    .map_err(storage)?
                    .await
                    .map_err(storage)?;
            }
            if total < 100 {
                break;
            }
            after = next;
            tokio::task::yield_now().await;
        }
        Ok(())
    }
}
