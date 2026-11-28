use super::{
    Fallible, GoalDecisions, Kind, Outcome, PAGE, RECEIPT_PREFIX, RECEIPT_SCAN_LIMIT, Requirement,
    SCAN_PAGES, TEXT_LIMIT, readable, trigger::Answered,
};
use crate::{
    process::guardrails::redact_value,
    session::{key, pending::Request, projector, prompt_cache::sha256},
};
use std::ops::Bound;
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, session, session_message,
    session_pending,
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart, Snapshot,
    session::{ContextStateTable, Event, EventTable, MessageTable, PendingTable},
    tuple_key,
};

#[derive(Clone, Debug)]
pub(super) struct Reference {
    pub kind: Kind,
    pub session: session::Id,
    pub request: LosslessString,
    pub fingerprint: LosslessString,
    pub action: LosslessString,
    pub source: Option<(LosslessString, LosslessString)>,
}

pub(super) struct Record<'a> {
    pub owner: &'a session::Id,
    pub requirement: &'a Requirement,
    pub reference: &'a Reference,
    pub outcome: Outcome,
    pub discriminator: &'a str,
    pub rationale: &'a str,
    pub via: Option<&'a str>,
    pub reason: Option<&'a str>,
}

fn redacted(text: &str) -> String {
    match redact_value(&JsonValue::String(text.into())) {
        JsonValue::String(text) => readable(&text),
        _ => String::new(),
    }
}

fn bounded(text: &str) -> LosslessString {
    LosslessString::from_utf16(text.encode_utf16().take(TEXT_LIMIT).collect())
}

fn label(reference: &Reference) -> String {
    let name = match reference.kind {
        Kind::Guardrail => "guardrail review",
        Kind::ChildQuestion => "child question",
        other => other.as_str(),
    };
    let action = if matches!(reference.kind, Kind::Permission | Kind::Guardrail) {
        format!(" ({})", redacted(&readable(&reference.action)))
    } else {
        String::new()
    };
    format!("{name} {}{action}", readable(&reference.request))
}

fn receipt_text(
    reference: &Reference,
    outcome: Outcome,
    via: Option<&str>,
    reason: Option<&str>,
) -> LosslessString {
    let subject = label(reference);
    let text = match outcome {
        Outcome::Waiting => format!(
            "Pending {subject} is still waiting ({}); the goal loop did not settle it. This record authorizes nothing.",
            reason.unwrap_or("unspecified")
        ),
        Outcome::Settled => {
            let settled_by = if via == Some("goal") {
                "by the Goal agent under the active goal from bounded task context; this automatic answer is never a human reply".to_owned()
            } else {
                format!("by the native {} path", via.unwrap_or("coordination"))
            };
            format!(
                "Pending {subject} was settled ({}) {settled_by}; the waiting call received that result. This record authorizes nothing.",
                reason.unwrap_or("unspecified")
            )
        }
        Outcome::Resumed => format!(
            "Pending {subject} was settled or answered natively. This record authorizes nothing."
        ),
    };
    bounded(&redacted(&text))
}

fn path<'a>(value: &'a JsonValue, names: &[&str]) -> Option<&'a JsonValue> {
    names.iter().try_fold(value, |value, name| match value {
        JsonValue::Object(object) => object.get(&(*name).into()),
        _ => None,
    })
}

fn string<'a>(value: &'a JsonValue, names: &[&str]) -> Option<&'a LosslessString> {
    match path(value, names)? {
        JsonValue::String(text) => Some(text),
        _ => None,
    }
}

fn parse(data: &JsonValue, goal_digest: &str) -> Option<(LosslessString, Reference)> {
    let input_id = string(data, &["inputID"])?;
    let receipt = path(data, &["input", "data", "metadata", "goalDecision"])?;
    if string(receipt, &["outcome"])?.as_str() != Some("waiting")
        || string(receipt, &["requirement", "goalDigest"])?.as_str() != Some(goal_digest)
    {
        return None;
    }
    let kind = Kind::parse(string(receipt, &["candidate", "kind"])?.as_str()?)?;
    Some((
        input_id.clone(),
        Reference {
            kind,
            session: session::Id::new(string(receipt, &["candidate", "sessionID"])?.clone())
                .ok()?,
            request: string(receipt, &["candidate", "requestID"])?.clone(),
            fingerprint: string(receipt, &["candidate", "fingerprint"])?.clone(),
            action: kind.as_str().into(),
            source: string(receipt, &["source", "messageID"])
                .zip(string(receipt, &["source", "callID"]))
                .map(|(message, call)| (message.clone(), call.clone())),
        },
    ))
}

impl GoalDecisions {
    pub(super) fn receipt_id(
        &self,
        owner: &session::Id,
        reference: &Reference,
        outcome: Outcome,
        discriminator: &str,
    ) -> Option<session_message::Id> {
        let digest = sha256(
            &[
                readable(owner.as_lossless()),
                reference.kind.as_str().to_owned(),
                readable(&reference.request),
                readable(&reference.fingerprint),
                outcome.as_str().to_owned(),
                discriminator.to_owned(),
            ]
            .join("\0"),
        );
        session_message::Id::new(format!("{RECEIPT_PREFIX}{}", &digest[..24])).ok()
    }

    fn scan(
        &self,
        snapshot: &Snapshot,
        owner: &session::Id,
        event_type: &str,
        mut visit: impl FnMut(&Event) -> bool,
    ) -> Fallible<bool> {
        let kind = LosslessString::from(event_type);
        let prefix = tuple_key(&[KeyPart::String(owner.as_lossless()), KeyPart::String(&kind)]);
        let mut after = None;
        for _ in 0..SCAN_PAGES {
            let page = snapshot.index_range::<EventTable>(
                "event_aggregate_type_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Descending,
                    after: after.as_ref(),
                    limit: PAGE,
                },
            )?;
            let Some(last) = page.last() else {
                return Ok(true);
            };
            after = Some(last.cursor.clone());
            for entry in &page {
                if !visit(&entry.record) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn reverted_after(&self, snapshot: &Snapshot, owner: &session::Id, seq: i64) -> Fallible<bool> {
        let kind = LosslessString::from("session.revert.committed.1");
        let prefix = tuple_key(&[KeyPart::String(owner.as_lossless()), KeyPart::String(&kind)]);
        let lower = tuple_key(&[
            KeyPart::String(owner.as_lossless()),
            KeyPart::String(&kind),
            KeyPart::I64(seq),
        ]);
        Ok(!snapshot
            .index_range::<EventTable>(
                "event_aggregate_type_seq_idx",
                IndexQuery {
                    lower: Bound::Excluded(lower.as_slice()),
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Descending,
                    after: None,
                    limit: 1,
                },
            )?
            .is_empty())
    }

    pub(super) fn receipt_exists(
        &self,
        owner: &session::Id,
        id: &session_message::Id,
    ) -> Fallible<bool> {
        let snapshot = self.0.client.snapshot()?;
        let row = key(id.as_lossless());
        if snapshot
            .get::<PendingTable>(&row)?
            .is_some_and(|pending| &pending.session_id == owner.as_lossless())
            || snapshot
                .get::<MessageTable>(&row)?
                .is_some_and(|message| &message.session_id == owner.as_lossless())
        {
            return Ok(true);
        }
        if !snapshot
            .get::<ContextStateTable>(&key(owner.as_lossless()))?
            .is_some_and(|state| state.covered_through_seq.is_some())
        {
            return Ok(false);
        }
        let mut promoted = None;
        let reliable = self.scan(&snapshot, owner, "session.input.promoted.1", |event| {
            if string(&event.data, &["inputID"]) == Some(id.as_lossless()) {
                promoted = Some(event.seq);
                return false;
            }
            true
        })?;
        let Some(seq) = promoted else {
            return Ok(!reliable);
        };
        if self.reverted_after(&snapshot, owner, seq)? {
            return Ok(false);
        }
        let mut admitted = false;
        let complete = self.scan(&snapshot, owner, "session.input.admitted.1", |event| {
            if string(&event.data, &["inputID"]) == Some(id.as_lossless()) {
                admitted = true;
                return false;
            }
            true
        })?;
        Ok(admitted || !complete)
    }

    pub(super) async fn record(&self, input: Record<'_>) -> bool {
        let Some(id) = self.receipt_id(
            input.owner,
            input.reference,
            input.outcome,
            input.discriminator,
        ) else {
            return false;
        };
        match self.receipt_exists(input.owner, &id) {
            Ok(false) => {}
            Ok(true) => return false,
            Err(error) => {
                tracing::warn!(error = %error, "Goal decision receipt lookup failed");
                return false;
            }
        }
        let reference = input.reference;
        let candidate = ObjectEncoder::new()
            .field("kind", reference.kind.as_str())
            .field("sessionID", &reference.session)
            .field("requestID", &reference.request)
            .field("fingerprint", &reference.fingerprint)
            .finish();
        let requirement = ObjectEncoder::new()
            .field("goalDigest", input.requirement.goal_digest.as_str())
            .field("iteration", &(input.requirement.iteration as f64))
            .field("revision", &(input.requirement.revision as f64))
            .finish();
        let source = reference.source.as_ref().map(|(message, call)| {
            ObjectEncoder::new()
                .field("messageID", message)
                .field("callID", call)
                .finish()
        });
        let receipt = ObjectEncoder::new()
            .field("outcome", input.outcome.as_str())
            .optional("via", &input.via.map(LosslessString::from))
            .optional("reason", &input.reason.map(LosslessString::from))
            .field("rationale", input.rationale)
            .field("requirement", &requirement)
            .field("candidate", &candidate)
            .optional("source", &source)
            .finish();
        let text = receipt_text(reference, input.outcome, input.via, input.reason);
        let message = session_pending::Message::decode(
            &ObjectEncoder::new()
                .field("type", "synthetic")
                .field(
                    "data",
                    &ObjectEncoder::new()
                        .field("text", &text)
                        .field("description", "Goal · decision")
                        .field(
                            "metadata",
                            &ObjectEncoder::new()
                                .field("goalDecision", &receipt)
                                .finish(),
                        )
                        .finish(),
                )
                .field("delivery", "steer")
                .finish(),
        );
        let Ok(message) = message else {
            tracing::warn!("Goal decision receipt could not be encoded");
            return false;
        };
        let Ok(event_id) = projector::random_event_id() else {
            tracing::warn!("Goal decision receipt identity unavailable");
            return false;
        };
        match self
            .0
            .sessions
            .admit_input(Request {
                id,
                session_id: input.owner.clone(),
                input: message,
                event_id,
                created: self.now(),
            })
            .await
        {
            Ok(admitted) => admitted.fresh,
            Err(ycoding_store::Error::Domain {
                kind: "input_identity",
                ..
            }) => false,
            Err(error) => {
                tracing::warn!(error = %error, "Goal decision receipt admission failed");
                false
            }
        }
    }

    pub(super) fn waiting_for(
        &self,
        owner: &session::Id,
        answered: &Answered,
        goal_digest: &str,
    ) -> Fallible<Vec<Reference>> {
        let snapshot = self.0.client.snapshot()?;
        let mut found = Vec::new();
        self.scan(&snapshot, owner, "session.input.admitted.1", |event| {
            let Some((input_id, reference)) = parse(&event.data, goal_digest) else {
                return true;
            };
            if !readable(&input_id).starts_with(RECEIPT_PREFIX)
                || reference.kind != answered.kind
                || reference.session != answered.session
                || reference.request != answered.request
            {
                return true;
            }
            found.push((input_id, reference));
            found.len() < RECEIPT_SCAN_LIMIT
        })?;
        let mut live = Vec::new();
        for (input_id, reference) in found {
            let Ok(id) = session_message::Id::new(input_id) else {
                continue;
            };
            if self.receipt_exists(owner, &id)? {
                live.push(reference);
            }
        }
        Ok(live)
    }
}
