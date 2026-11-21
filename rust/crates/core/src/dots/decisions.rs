use super::{
    access::Error,
    authority::{Gate, fingerprint},
    native::{NativeFuture, Waiting},
    projection::{self, Stage},
};
use crate::{
    process::guardrails::{Guardrails, Input},
    session::{orchestration, review},
    tools::policy::{Effect, forms::Forms, permissions::Permissions, questions::Questions},
};
use std::sync::Arc;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, domain, form,
    guardrail, permission, question, session,
    session_orchestration::QuestionId,
    session_review::{self, Answers, Decision, Dismissable, Payload, RecoveryChoice},
};

pub struct DecisionServices {
    pub forms: Forms,
    pub permissions: Permissions,
    pub questions: Questions,
    pub guardrails: Guardrails,
    pub reviews: review::Service,
    pub orchestration: orchestration::Service,
    pub lease: Arc<dyn Send + Sync>,
    pub is_current: Arc<dyn Fn() -> bool + Send + Sync>,
}
pub struct Decisions {
    services: DecisionServices,
}
#[derive(Clone)]
pub(crate) enum Kind {
    Form(form::Id),
    Permission(permission::Id),
    Question(question::Id),
    Guardrail(guardrail::RequestId),
    Review {
        item_id: session_review::Id,
        payload: Payload,
    },
    Child {
        parent_id: session::Id,
        child_id: session::Id,
        question_id: QuestionId,
    },
}
#[derive(Clone)]
pub(crate) struct Pending {
    pub id: String,
    pub session_id: session::Id,
    pub turn_id: String,
    pub fingerprint: String,
    pub stage: Stage,
    pub waiting: Waiting,
    kind: Kind,
}
impl Decisions {
    pub fn new(services: DecisionServices) -> Self {
        Self { services }
    }
    pub(crate) fn identity(&self) -> [usize; 4] {
        [
            self.services.forms.native_identity(),
            self.services.permissions.native_identity(),
            self.services.questions.native_identity(),
            self.services.guardrails.native_identity(),
        ]
    }
    pub(crate) fn pending(&self, owner: &session::Id) -> Result<Vec<Pending>, Error> {
        if !(self.services.is_current)() {
            return Err(Error::Unavailable);
        }
        let mut pending = Vec::new();
        for request in self
            .services
            .permissions
            .list()
            .into_iter()
            .filter(|request| &request.session_id == owner)
        {
            let key =
                ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(&request.id));
            pending.push(Pending {
                id: format!("permission:{key}"),
                session_id: owner.clone(),
                turn_id: request
                    .source
                    .as_ref()
                    .map(|source| source.message_id.to_utf8().map_err(|_| Error::Unavailable))
                    .transpose()?
                    .unwrap_or_else(|| key.clone()),
                fingerprint: fingerprint(&request),
                stage: projection::approval(&format!(
                    "{}: {}",
                    text(&request.action),
                    joined(&request.resources)
                )),
                waiting: Waiting::Approval,
                kind: Kind::Permission(request.id),
            });
        }
        for request in self
            .services
            .guardrails
            .for_session(owner)
            .map_err(|_| Error::Unavailable)?
            .into_iter()
            .filter(|request| &request.session_id == owner)
        {
            let key =
                ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(&request.id));
            pending.push(Pending {
                id: format!("guardrail:{key}"),
                session_id: owner.clone(),
                turn_id: key,
                fingerprint: fingerprint(&request),
                stage: projection::approval(&format!(
                    "{}: {}; rules: {}",
                    text(&request.action),
                    joined(&request.resources),
                    joined(&request.rule_ids)
                )),
                waiting: Waiting::Approval,
                kind: Kind::Guardrail(request.id),
            });
        }
        for request in self
            .services
            .forms
            .list(Some(owner.as_lossless()))
            .into_iter()
        {
            let key =
                ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(&request.id));
            pending.push(Pending {
                id: format!("form:{key}"),
                session_id: owner.clone(),
                turn_id: key,
                fingerprint: fingerprint(&request),
                stage: projection::form(
                    &request.title.to_utf8().map_err(|_| Error::Unavailable)?,
                    request.fields.clone(),
                )?,
                waiting: Waiting::UserInput,
                kind: Kind::Form(request.id),
            });
        }
        for request in self
            .services
            .questions
            .list()
            .into_iter()
            .filter(|request| &request.session_id == owner)
        {
            let key =
                ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(&request.id));
            pending.push(Pending {
                id: format!("question:{key}"),
                session_id: owner.clone(),
                turn_id: key,
                fingerprint: fingerprint(&request),
                stage: projection::questions(&request.questions)?,
                waiting: Waiting::UserInput,
                kind: Kind::Question(request.id),
            });
        }
        for (item, fingerprint) in self
            .services
            .reviews
            .pending_snapshots(owner)
            .map_err(|_| Error::Unavailable)?
            .into_iter()
            .filter(|(item, _)| item.session_id.as_lossless() == owner.as_lossless())
        {
            let payload = item.deferral.payload.clone();
            let (stage, waiting) = match &payload {
                Payload::Permission(payload) => (
                    projection::approval(&format!(
                        "{}: {}",
                        text(&payload.action),
                        joined(&payload.resources)
                    )),
                    Waiting::Approval,
                ),
                Payload::Guardrail(payload) => (
                    projection::approval(&format!(
                        "{}: {}",
                        text(&payload.action),
                        joined(&payload.resources)
                    )),
                    Waiting::Approval,
                ),
                Payload::Recovery(_) => (projection::recovery(), Waiting::UserInput),
                Payload::Form(payload) => (
                    projection::form(&text(&payload.title), form::Fields(payload.fields.clone()))?,
                    Waiting::UserInput,
                ),
                Payload::Question(payload) => (
                    projection::questions(&payload.questions)?,
                    Waiting::UserInput,
                ),
                Payload::SubagentQuestion(payload) => {
                    (projection::child(&text(&payload.text)), Waiting::UserInput)
                }
            };
            let key = ycoding_schema::stringify_json(&item.deferral.item_id.encode());
            pending.push(Pending {
                id: format!("review:{key}"),
                session_id: owner.clone(),
                turn_id: key,
                fingerprint,
                stage,
                waiting,
                kind: Kind::Review {
                    item_id: item.deferral.item_id,
                    payload,
                },
            });
        }
        if let Some(parent_id) = self
            .services
            .orchestration
            .parent_of(owner)
            .map_err(|_| Error::Unavailable)?
        {
            for snapshot in self
                .services
                .orchestration
                .question_snapshots(&parent_id)
                .map_err(|_| Error::Unavailable)?
            {
                let task = snapshot.task;
                if task.session_id.as_lossless() != owner.as_lossless() {
                    continue;
                }
                let Some(question) = task.question else {
                    continue;
                };
                if question.deferred == Some(true) {
                    continue;
                }
                let key = ycoding_schema::stringify_json(&question.id.encode());
                pending.push(Pending {
                    id: format!("child:{key}"),
                    session_id: owner.clone(),
                    turn_id: key,
                    fingerprint: snapshot
                        .fingerprint
                        .to_utf8()
                        .map_err(|_| Error::Unavailable)?,
                    stage: projection::child(&text(&question.text)),
                    waiting: Waiting::UserInput,
                    kind: Kind::Child {
                        parent_id: parent_id.clone(),
                        child_id: owner.clone(),
                        question_id: question.id,
                    },
                });
            }
        }
        Ok(pending)
    }
    pub(crate) fn current(&self, pending: &Pending) -> Result<bool, Error> {
        Ok(self
            .pending(&pending.session_id)?
            .iter()
            .any(|current| current.id == pending.id && current.fingerprint == pending.fingerprint))
    }
    pub(crate) fn settle(
        &self,
        pending: Pending,
        mut gate: Gate,
        answer: Option<JsonValue>,
    ) -> NativeFuture<'_, ()> {
        Box::pin(async move {
            if !(self.services.is_current)() {
                return Err(Error::Unavailable);
            }
            gate.current = Some(self.services.is_current.clone());
            match pending.kind {
                Kind::Form(id) => self
                    .services
                    .forms
                    .reply_native(
                        &id,
                        &pending.fingerprint,
                        answer
                            .map(|answer| {
                                form::Answer::decode(&answer).map_err(|_| Error::InvalidInput)
                            })
                            .transpose()?,
                        &gate,
                    )
                    .map_err(|_| Error::InvalidInput),
                Kind::Question(id) => self
                    .services
                    .questions
                    .reply_native(
                        &id,
                        &pending.fingerprint,
                        answer
                            .map(|answer| {
                                Vec::<question::Answer>::decode(&answer)
                                    .map_err(|_| Error::InvalidInput)
                            })
                            .transpose()?,
                        &gate,
                    )
                    .map_err(|_| Error::InvalidInput),
                Kind::Permission(id) => self
                    .services
                    .permissions
                    .reply_native(&id, &pending.fingerprint, reply(answer)?, &gate)
                    .map_err(|_| Error::InvalidInput),
                Kind::Guardrail(id) => self
                    .services
                    .guardrails
                    .reply_native(
                        &pending.session_id,
                        &id,
                        &pending.fingerprint,
                        reply(answer)?,
                        &gate,
                    )
                    .map_err(|_| Error::InvalidInput),
                Kind::Review { item_id, payload } => {
                    let Some(decision) = review_decision(&payload, answer)? else {
                        return Ok(());
                    };
                    let eligible = self.eligible(&pending.session_id, &decision, &payload);
                    self.services
                        .reviews
                        .decide_delegated(
                            review::DecideInput {
                                session_id: pending.session_id.clone(),
                                item_id,
                                decision,
                                now: chrono::Utc::now().timestamp_millis(),
                            },
                            review::Native {
                                gate,
                                fingerprint: pending.fingerprint,
                                eligible,
                            },
                        )
                        .await
                        .map_err(|_| Error::InvalidInput)
                }
                Kind::Child {
                    parent_id,
                    child_id,
                    question_id,
                } => {
                    let Some(answer) = answer else {
                        return Ok(());
                    };
                    let (text, data) = child_answer(&answer)?;
                    self.services
                        .orchestration
                        .answer_native(
                            &parent_id,
                            &child_id,
                            &question_id,
                            (text, data),
                            &LosslessString::from(pending.fingerprint.as_str()),
                            &gate,
                        )
                        .await
                        .map(|_| ())
                        .map_err(|_| Error::InvalidInput)
                }
            }
        })
    }
    fn eligible(
        &self,
        session_id: &session::Id,
        decision: &Decision,
        payload: &Payload,
    ) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let (action, resources, guardrail) = match (decision, payload) {
            (Decision::Permission { reply }, Payload::Permission(payload))
                if reply.0.as_str() == Some("once") =>
            {
                (payload.action.clone(), payload.resources.clone(), false)
            }
            (
                Decision::Guardrail {
                    reply: guardrail::Reply::Once,
                },
                Payload::Guardrail(payload),
            ) => (payload.action.clone(), payload.resources.clone(), true),
            _ => return Arc::new(|| true),
        };
        let permissions = self.services.permissions.clone();
        let guardrails = self.services.guardrails.clone();
        let session_id = session_id.clone();
        Arc::new(move || {
            if !resources.iter().all(|resource| {
                permissions
                    .evaluate_effective(&session_id, None, &action, resource)
                    .is_ok_and(|effect| effect != Effect::Deny)
            }) {
                return false;
            }
            if guardrail {
                let Ok(action) = action.to_utf8() else {
                    return false;
                };
                return guardrails
                    .evaluate(&Input {
                        session_id: session_id.clone(),
                        action,
                        resources: resources.clone(),
                        metadata: None,
                        skip_review: false,
                        holder: None,
                        source: None,
                    })
                    .is_ok_and(|current| current.effect != Effect::Deny);
            }
            true
        })
    }
}
fn reply(answer: Option<JsonValue>) -> Result<bool, Error> {
    let Some(answer) = answer else {
        return Ok(false);
    };
    let path = JsonPath::default();
    let reply: LosslessString = ObjectDecoder::new(&answer, &path)
        .and_then(|object| object.field("reply"))
        .map_err(|_| Error::InvalidInput)?;
    match reply.as_str() {
        Some("once") => Ok(true),
        Some("reject") => Ok(false),
        _ => Err(Error::InvalidInput),
    }
}
fn text(value: &LosslessString) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()))
}
fn joined(values: &[LosslessString]) -> String {
    values.iter().map(text).collect::<Vec<_>>().join(", ")
}
fn child_answer(
    answer: &JsonValue,
) -> Result<(Option<LosslessString>, Option<domain::Json>), Error> {
    let path = JsonPath::default();
    let object = ObjectDecoder::new(answer, &path).map_err(|_| Error::InvalidInput)?;
    let text: Option<LosslessString> = object.optional("text").map_err(|_| Error::InvalidInput)?;
    let data: Option<domain::Json> = object.optional("data").map_err(|_| Error::InvalidInput)?;
    if text.is_none() && data.is_none() {
        return Err(Error::InvalidInput);
    }
    Ok((text, data))
}
fn review_decision(
    payload: &Payload,
    answer: Option<JsonValue>,
) -> Result<Option<Decision>, Error> {
    let Some(answer) = answer else {
        return match payload {
            Payload::Form(_) | Payload::Question(_) => Ok(Some(Decision::Dismissed {
                kind: Dismissable::Question,
            })),
            Payload::SubagentQuestion(_) => Ok(None),
            _ => Err(Error::InvalidInput),
        };
    };
    Ok(Some(match payload {
        Payload::Form(_) => Decision::Question {
            answers: Answers::Form(form::Answer::decode(&answer).map_err(|_| Error::InvalidInput)?),
        },
        Payload::Question(_) => Decision::Question {
            answers: Answers::Questions(
                Vec::<question::Answer>::decode(&answer).map_err(|_| Error::InvalidInput)?,
            ),
        },
        Payload::SubagentQuestion(_) => {
            let (text, data) = child_answer(&answer)?;
            Decision::SubagentQuestion {
                text: text.unwrap_or_default(),
                data,
            }
        }
        Payload::Permission(_) => Decision::Permission {
            reply: permission::Reply(if reply(Some(answer))? {
                "once".into()
            } else {
                "reject".into()
            }),
        },
        Payload::Guardrail(_) => Decision::Guardrail {
            reply: if reply(Some(answer))? {
                guardrail::Reply::Once
            } else {
                guardrail::Reply::Reject
            },
        },
        Payload::Recovery(_) => {
            let JsonValue::String(choice) = &answer else {
                return Err(Error::InvalidInput);
            };
            Decision::Recovery {
                choice: match choice.as_str() {
                    Some("Continue") => RecoveryChoice::Continue,
                    Some("Stop") => RecoveryChoice::Stop,
                    _ => return Err(Error::InvalidInput),
                },
            }
        }
    }))
}
