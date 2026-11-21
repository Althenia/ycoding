use super::{GoalDecisions, Kind};
use crate::{
    coordination::decisions::id_text,
    event_feed::{Data, Payload},
    session::review_fold,
};
use ycoding_schema::{
    JsonValue, LosslessString, guardrail, session,
    session_review::{Decision, Origin, Payload as ReviewPayload},
};

#[derive(Clone, Debug)]
pub(super) struct Answered {
    pub kind: Kind,
    pub session: session::Id,
    pub request: LosslessString,
}

pub(super) struct Trigger {
    pub session: session::Id,
    pub answered: Option<Answered>,
}

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}

fn text<'a>(value: &'a JsonValue, name: &str) -> Option<&'a LosslessString> {
    match field(value, name)? {
        JsonValue::String(text) => Some(text),
        _ => None,
    }
}

fn session_of(id: &LosslessString) -> Option<session::Id> {
    session::Id::new(id.clone()).ok()
}

fn trigger(
    kind: Kind,
    session: &LosslessString,
    request: &LosslessString,
    answered: bool,
) -> Option<Trigger> {
    let id = session_of(session)?;
    Some(Trigger {
        answered: answered.then(|| Answered {
            kind,
            session: id.clone(),
            request: request.clone(),
        }),
        session: id,
    })
}

impl GoalDecisions {
    pub(super) fn trigger(&self, payload: &Payload) -> Option<Trigger> {
        match payload {
            Payload::Ephemeral(event) => ephemeral(&event.data),
            Payload::Durable(event) => self.durable(event.type_.as_str()?, &event.data),
        }
    }

    fn durable(&self, kind: &str, data: &JsonValue) -> Option<Trigger> {
        match kind {
            "session.guardrail.decided.1" => {
                let reply = text(data, "reply")?;
                trigger(
                    Kind::Guardrail,
                    text(data, "reviewSessionID")?,
                    text(data, "requestID")?,
                    reply.as_str() != Some("reject"),
                )
            }
            "session.review.deferred.1" | "session.review.withdrawn.1" => Some(Trigger {
                session: session_of(text(data, "sessionID")?)?,
                answered: None,
            }),
            "session.review.decided.1" => self.decided(data),
            "session.task.updated.1" => {
                let session = text(data, "sessionID")?;
                let change = field(data, "change")?;
                match text(change, "type")?.as_str()? {
                    "question_answered" => trigger(
                        Kind::ChildQuestion,
                        session,
                        text(field(change, "answer")?, "questionID")?,
                        true,
                    ),
                    "question_asked" => trigger(
                        Kind::ChildQuestion,
                        session,
                        text(field(change, "question")?, "id")?,
                        false,
                    ),
                    "question_timed_out" => trigger(
                        Kind::ChildQuestion,
                        session,
                        text(change, "questionID")?,
                        false,
                    ),
                    _ => None,
                }
            }
            "session.context.observed.1" => {
                (text(data, "source")?.as_str() == Some("session-state")).then_some(())?;
                Some(Trigger {
                    session: session_of(text(data, "sessionID")?)?,
                    answered: None,
                })
            }
            _ => None,
        }
    }

    fn decided(&self, data: &JsonValue) -> Option<Trigger> {
        let session = session_of(text(data, "sessionID")?)?;
        let item_id = text(data, "itemID")?;
        let plain = || Trigger {
            session: session.clone(),
            answered: None,
        };
        let Ok(snapshot) = self.0.client.snapshot() else {
            return Some(plain());
        };
        let Ok(items) = review_fold::fold(&snapshot, &[session.as_lossless().clone()]) else {
            return Some(plain());
        };
        let Some(item) = items.iter().find(|item| &id_text(&item.item_id) == item_id) else {
            return Some(plain());
        };
        if matches!(
            item.decision,
            None | Some(Decision::Dismissed { .. }) | Some(Decision::Recovery { .. })
        ) {
            return Some(plain());
        }
        let found = match (&item.deferral.payload, &item.deferral.origin) {
            (ReviewPayload::Permission(payload), _) => {
                Some((Kind::Permission, id_text(&payload.request_id)))
            }
            (ReviewPayload::Guardrail(payload), _) => {
                Some((Kind::Guardrail, id_text(&payload.request_id)))
            }
            (ReviewPayload::Form(_), Origin::Request { request_id, .. }) => {
                Some((Kind::Form, request_id.clone()))
            }
            (ReviewPayload::Question(_), Origin::Request { request_id, .. }) => {
                Some((Kind::Question, request_id.clone()))
            }
            (ReviewPayload::SubagentQuestion(_), Origin::Question { question_id }) => {
                Some((Kind::ChildQuestion, question_id.0.clone()))
            }
            _ => None,
        };
        Some(Trigger {
            answered: found.map(|(kind, request)| Answered {
                kind,
                session: item.session_id.clone(),
                request,
            }),
            session,
        })
    }
}

fn ephemeral(data: &Data) -> Option<Trigger> {
    let permission = |session: &session::Id, request: &LosslessString, answered: bool| {
        trigger(Kind::Permission, session.as_lossless(), request, answered)
    };
    let guardrail_ = |session: &session::Id, request: &LosslessString, answered: bool| {
        trigger(Kind::Guardrail, session.as_lossless(), request, answered)
    };
    let question = |session: &session::Id, request: &LosslessString, answered: bool| {
        trigger(Kind::Question, session.as_lossless(), request, answered)
    };
    match data {
        Data::PermissionAsked(request) => {
            permission(&request.session_id, &id_text(&request.id), false)
        }
        Data::PermissionReplied(data) => permission(
            &data.session_id,
            &id_text(&data.request_id),
            data.reply.0.as_str() != Some("reject"),
        ),
        Data::PermissionDeferred(data) => {
            permission(&data.session_id, &id_text(&data.request_id), false)
        }
        Data::GuardrailAsked(request) => {
            guardrail_(&request.session_id, &id_text(&request.id), false)
        }
        Data::GuardrailReplied(data) => guardrail_(
            &data.session_id,
            &id_text(&data.request_id),
            data.reply != guardrail::Reply::Reject,
        ),
        Data::GuardrailDeferred(data) => {
            guardrail_(&data.session_id, &id_text(&data.request_id), false)
        }
        Data::FormCreated(data) => trigger(
            Kind::Form,
            &data.form.session_id,
            &id_text(&data.form.id),
            false,
        ),
        Data::FormReplied(data) => trigger(Kind::Form, &data.session_id, &id_text(&data.id), true),
        Data::FormCancelled(data) => {
            trigger(Kind::Form, &data.session_id, &id_text(&data.id), false)
        }
        Data::FormTimedOut(data) => {
            trigger(Kind::Form, &data.session_id, &id_text(&data.id), false)
        }
        Data::FormDeferred(data) => {
            trigger(Kind::Form, &data.session_id, &id_text(&data.id), false)
        }
        Data::QuestionAsked(request) => question(&request.session_id, &id_text(&request.id), false),
        Data::QuestionReplied(data) => question(&data.session_id, &id_text(&data.request_id), true),
        Data::QuestionRejected(data) => {
            question(&data.session_id, &id_text(&data.request_id), false)
        }
        Data::QuestionTimedOut(data) => {
            question(&data.session_id, &id_text(&data.request_id), false)
        }
        Data::QuestionDeferred(data) => {
            question(&data.session_id, &id_text(&data.request_id), false)
        }
        _ => None,
    }
}
