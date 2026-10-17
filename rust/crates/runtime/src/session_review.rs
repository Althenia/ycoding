use crate::{
    convert,
    dispatch::{Failure, Invocation},
    form, ids,
};
use std::sync::{Arc, OnceLock};
use ycoding_core::{
    session::{
        execution::Execution,
        orchestration,
        review::{
            ChildAnswer, Conflict, DecideInput, Delivery, DeliveryError, DeliveryFuture, Error,
            RecoveryResolution, Service,
        },
        store::Service as SessionStore,
    },
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonObject, JsonValue, ObjectEncoder, session,
        session_review::{Decision, Id, Item, Origin, Payload, Reason},
    },
};
use ycoding_protocol::v5;

pub(crate) struct ReviewDelivery {
    bound: OnceLock<(orchestration::Service, &'static Execution)>,
}

impl ReviewDelivery {
    pub(crate) fn bind(
        &self,
        orchestration: orchestration::Service,
        execution: &'static Execution,
    ) {
        let _ = self.bound.set((orchestration, execution));
    }
}

impl Delivery for ReviewDelivery {
    fn wake(&self, session_id: &session::Id) {
        let Some((_, execution)) = self.bound.get() else {
            tracing::warn!("reviewed Session wake requested before Session execution started");
            return;
        };
        if let Err(error) = execution.wake(session_id) {
            tracing::warn!(?error, "reviewed Session wake failed");
        }
    }

    fn answer_child<'a>(&'a self, answer: ChildAnswer) -> DeliveryFuture<'a> {
        let Some((orchestration, _)) = self.bound.get() else {
            return Box::pin(async {
                Err(DeliveryError::Conflict(
                    "Subagent delivery is not ready until Session execution starts".into(),
                ))
            });
        };
        Box::pin(orchestration.answer_review(answer))
    }

    fn resolve_recovery<'a>(&'a self, resolution: RecoveryResolution) -> DeliveryFuture<'a> {
        let Some((orchestration, _)) = self.bound.get() else {
            return Box::pin(async {
                Err(DeliveryError::Conflict(
                    "Recovery delivery is not ready until Session execution starts".into(),
                ))
            });
        };
        Box::pin(orchestration.resolve_recovery(resolution))
    }
}

pub(crate) fn service(sessions: SessionStore) -> (Service, Arc<ReviewDelivery>) {
    let delivery = Arc::new(ReviewDelivery {
        bound: OnceLock::new(),
    });
    (Service::new(sessions, delivery.clone()), delivery)
}

pub async fn list(
    invocation: Invocation,
    request: v5::SessionReviewListRequest,
) -> Result<v5::SessionReviewListResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let reviews = core.reviews.clone();
    let items = tokio::task::spawn_blocking(move || reviews.list(&id))
        .await
        .map_err(|_| Failure::Unavailable("Session review unavailable".into()))?
        .map_err(failure)?;
    Ok(v5::SessionReviewListResult {
        data: v5::SessionReviewListResultData {
            items: items.iter().map(item_wire).collect::<Result<_, _>>()?,
        },
    })
}

pub async fn decide(
    invocation: Invocation,
    request: v5::SessionReviewDecideRequest,
) -> Result<v5::SessionReviewDecideResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let requested = convert::domain(&request.params.item_id)?;
    let item_id = Id::new(requested.clone())
        .map_err(|_| Failure::ReviewItemNotFound(convert::readable(&requested)))?;
    let decision = decision(&request.payload.decision)?;
    core.reviews
        .decide(DecideInput {
            session_id: id,
            item_id,
            decision,
            now: ids::now_millis(),
        })
        .await
        .map_err(failure)?;
    Ok(v5::SessionReviewDecideResult { data: v5::Empty {} })
}

pub(crate) async fn convert_family(
    core: &crate::Core,
    session_id: &session::Id,
) -> Result<(), Failure> {
    for member in core.reviews.family(session_id).map_err(failure)? {
        let (_, services) = core.locations.session(&member)?;
        let converted = [
            (
                "guardrail",
                services
                    .guardrails
                    .defer_pending(&member)
                    .await
                    .err()
                    .map(|error| format!("{error:?}")),
            ),
            (
                "form",
                services
                    .forms
                    .defer_pending(&member)
                    .await
                    .err()
                    .map(|error| format!("{error:?}")),
            ),
            (
                "question",
                services
                    .questions
                    .defer_pending(&member)
                    .await
                    .err()
                    .map(|error| format!("{error:?}")),
            ),
            (
                "permission",
                services
                    .permissions
                    .defer_pending(&member)
                    .await
                    .err()
                    .map(|error| format!("{error:?}")),
            ),
            (
                "subagent_question",
                core.reviews
                    .defer_child_question(&member, ids::now_millis())
                    .await
                    .err()
                    .map(|error| error.to_string()),
            ),
        ];
        for (kind, error) in converted {
            if let Some(error) = error {
                tracing::warn!(
                    kind,
                    error,
                    "unable to defer a pending request for a sleeping Session"
                );
            }
        }
    }
    Ok(())
}

fn failure(error: Error) -> Failure {
    match error {
        Error::SessionNotFound(id) => Failure::SessionNotFound(convert::readable(id.as_lossless())),
        Error::NotFound(id) => Failure::ReviewItemNotFound(convert::readable(id.as_lossless())),
        Error::Conflict { reason, .. } => Failure::Conflict(match reason {
            Conflict::Decided => "Review item already decided".into(),
            Conflict::Withdrawn => "Review item was withdrawn".into(),
            Conflict::Archived => "Review item belongs to an archived Session".into(),
            Conflict::Delivery(message) => message,
        }),
        Error::InvalidDecision { message, .. } => Failure::Invalid(message),
        Error::InvalidDeferral(message) => Failure::Invalid(message),
        Error::Full { limit, .. } => {
            Failure::Conflict(format!("The review box already holds {limit} open items"))
        }
        Error::Store(_) => Failure::Unavailable("Session review store unavailable".into()),
    }
}

fn decision(wire: &v5::SessionReviewDecision) -> Result<Decision, Failure> {
    use v5::session_review_decision::Kind;
    let encoded = match wire.kind.as_ref() {
        Some(Kind::Value1(value)) => ObjectEncoder::new()
            .field("kind", "question")
            .field("answers", &answers(&value.answers)?)
            .finish(),
        Some(Kind::Value2(value)) => ObjectEncoder::new()
            .field("kind", "subagent_question")
            .field("text", &convert::domain(&value.text)?)
            .optional(
                "data",
                &value
                    .data
                    .as_ref()
                    .map(convert::value_to_json)
                    .transpose()?,
            )
            .finish(),
        Some(Kind::Value3(value)) => ObjectEncoder::new()
            .field("kind", "guardrail")
            .field("reply", reply(value.reply)?)
            .finish(),
        Some(Kind::Value4(value)) => ObjectEncoder::new()
            .field("kind", "permission")
            .field("reply", reply(value.reply)?)
            .finish(),
        Some(Kind::Value5(value)) => ObjectEncoder::new()
            .field("kind", "recovery")
            .field(
                "choice",
                match value.choice {
                    1 => "continue",
                    2 => "stop",
                    _ => return Err(Failure::Invalid("unknown recovery choice".into())),
                },
            )
            .finish(),
        Some(Kind::Value6(value)) => ObjectEncoder::new()
            .field(
                "kind",
                match value.kind {
                    1 => "question",
                    2 => "subagent_question",
                    _ => return Err(Failure::Invalid("unknown dismissible review kind".into())),
                },
            )
            .field("dismissed", &value.dismissed)
            .finish(),
        None => return Err(Failure::Invalid("missing review decision".into())),
    };
    Decision::decode(&encoded).map_err(|error| Failure::Invalid(error.to_string()))
}

fn answers(wire: &v5::SessionReviewDecisionValue1Answers) -> Result<JsonValue, Failure> {
    use v5::session_review_decision_value1_answers::Kind;
    match wire.kind.as_ref() {
        Some(Kind::Value1(answer)) => {
            let mut object = JsonObject::new();
            for entry in &answer.entries {
                object.insert(
                    convert::domain(&entry.key)?,
                    form::value_json(&entry.value)?,
                );
            }
            Ok(JsonValue::Object(object))
        }
        Some(Kind::Value2(questions)) => Ok(JsonValue::Array(
            questions
                .items
                .iter()
                .map(|answer| {
                    answer
                        .items
                        .iter()
                        .map(|value| convert::domain(value).map(JsonValue::String))
                        .collect::<Result<Vec<_>, _>>()
                        .map(JsonValue::Array)
                })
                .collect::<Result<_, _>>()?,
        )),
        None => Err(Failure::Invalid("missing review answers".into())),
    }
}

fn reply(value: i32) -> Result<&'static str, Failure> {
    match value {
        1 => Ok("once"),
        2 => Ok("always"),
        3 => Ok("reject"),
        _ => Err(Failure::Invalid("unknown review reply".into())),
    }
}

fn reason(reason: Reason) -> i32 {
    match reason {
        Reason::Disabled => 1,
        Reason::FreeText => 2,
        Reason::Refused => 3,
        Reason::LowConfidence => 4,
        Reason::Escalated => 5,
        Reason::Error => 6,
        Reason::Timeout => 7,
        Reason::SleepEntry => 8,
        Reason::Restart => 9,
    }
}

fn origin(origin: &Origin) -> v5::SessionReviewOrigin {
    use v5::session_review_origin::Kind;
    v5::SessionReviewOrigin {
        kind: Some(match origin {
            Origin::Tool {
                message_id,
                call_id,
            } => Kind::Value1(v5::SessionReviewOriginValue1 {
                message_id: convert::wire(message_id.as_lossless()),
                call_id: convert::wire(call_id),
            }),
            Origin::Question { question_id } => Kind::Value2(v5::SessionReviewOriginValue2 {
                question_id: convert::wire(&question_id.0),
            }),
            Origin::Request { request_id } => Kind::Value3(v5::SessionReviewOriginValue3 {
                request_id: convert::wire(request_id),
            }),
        }),
    }
}

fn text(value: &impl DomainEncode) -> Result<v5::LosslessString, Failure> {
    match value.encode() {
        JsonValue::String(value) => Ok(convert::wire(&value)),
        _ => Err(Failure::Unavailable("review identifier is not text".into())),
    }
}

fn strings(values: &[ycoding_core::ycoding_schema::LosslessString]) -> Vec<v5::LosslessString> {
    values.iter().map(convert::wire).collect()
}

macro_rules! item {
    ($variant:ident, $value:ident, $grades:ident, $child:ident, $item:expr, $payload:expr) => {{
        let item = $item;
        let deferral = &item.deferral;
        v5::session_review_item::Kind::$variant(v5::$value {
            item_id: convert::wire(deferral.item_id.as_lossless()),
            kind: 1,
            reason: reason(deferral.reason),
            choice: deferral.choice.as_ref().map(convert::wire),
            confidence: deferral.confidence.map(|confidence| confidence.get()),
            grades: deferral.grades.as_ref().map(|grades| v5::$grades {
                items: convert::grades(grades),
            }),
            origin: origin(&deferral.origin),
            payload: $payload,
            session_id: convert::wire(item.session_id.as_lossless()),
            root_session_id: convert::wire(item.root_session_id.as_lossless()),
            session_title: convert::wire(&item.session_title),
            created: item.created.get() as u64,
            child: item.child.as_ref().map(|child| v5::$child {
                agent: convert::wire(&child.agent),
                description: convert::wire(&child.description),
            }),
        })
    }};
}

fn item_wire(item: &Item) -> Result<v5::SessionReviewItem, Failure> {
    use v5::session_review_item_value1_payload::Kind as QuestionKind;
    let kind = match &item.deferral.payload {
        Payload::Form(payload) => item!(
            Value1,
            SessionReviewItemValue1,
            SessionReviewItemValue1Grades,
            SessionReviewItemValue1Child,
            item,
            v5::SessionReviewItemValue1Payload {
                kind: Some(QuestionKind::Value1(v5::SessionReviewFormPayload {
                    r#type: 1,
                    title: convert::wire(&payload.title),
                    fields: v5::FormFields {
                        items: payload.fields.iter().map(form::field_wire).collect(),
                    },
                    question_tool: payload.question_tool.then_some(true),
                })),
            }
        ),
        Payload::Question(payload) => item!(
            Value1,
            SessionReviewItemValue1,
            SessionReviewItemValue1Grades,
            SessionReviewItemValue1Child,
            item,
            v5::SessionReviewItemValue1Payload {
                kind: Some(QuestionKind::Value2(v5::SessionReviewQuestionPayload {
                    r#type: 1,
                    questions: v5::SessionReviewQuestionPayloadQuestions {
                        items: payload
                            .questions
                            .iter()
                            .map(|info| v5::QuestionInfo {
                                question: convert::wire(&info.question),
                                header: convert::wire(&info.header),
                                options: v5::QuestionInfoOptions {
                                    items: info
                                        .options
                                        .iter()
                                        .map(|option| v5::QuestionOption {
                                            label: convert::wire(&option.label),
                                            description: convert::wire(&option.description),
                                        })
                                        .collect(),
                                },
                                multiple: info.multiple,
                                custom: info.custom,
                            })
                            .collect(),
                    },
                })),
            }
        ),
        Payload::SubagentQuestion(payload) => item!(
            Value2,
            SessionReviewItemValue2,
            SessionReviewItemValue2Grades,
            SessionReviewItemValue2Child,
            item,
            v5::SessionReviewSubagentQuestionPayload {
                r#type: 1,
                text: convert::wire(&payload.text),
                data: payload
                    .data
                    .as_ref()
                    .map(|data| convert::json_to_value(&data.encode())),
            }
        ),
        Payload::Guardrail(payload) => item!(
            Value3,
            SessionReviewItemValue3,
            SessionReviewItemValue3Grades,
            SessionReviewItemValue3Child,
            item,
            v5::SessionReviewGuardrailPayload {
                r#type: 1,
                action: convert::wire(&payload.action),
                resources: v5::SessionReviewGuardrailPayloadResources {
                    items: strings(&payload.resources),
                },
                rule_i_ds: v5::SessionReviewGuardrailPayloadRuleIDs {
                    items: strings(&payload.rule_ids),
                },
                reason: convert::wire(&payload.reason),
                hard_review: payload.hard_review,
                directories: v5::SessionReviewGuardrailPayloadDirectories {
                    items: strings(&payload.directories),
                },
                fingerprint: convert::wire(payload.fingerprint.as_lossless()),
                request_id: text(&payload.request_id)?,
            }
        ),
        Payload::Permission(payload) => item!(
            Value4,
            SessionReviewItemValue4,
            SessionReviewItemValue4Grades,
            SessionReviewItemValue4Child,
            item,
            v5::SessionReviewPermissionPayload {
                r#type: 1,
                action: convert::wire(&payload.action),
                resources: v5::SessionReviewPermissionPayloadResources {
                    items: strings(&payload.resources),
                },
                save: payload
                    .save
                    .as_ref()
                    .map(|save| v5::SessionReviewPermissionPayloadSave {
                        items: strings(save),
                    }),
                fingerprint: convert::wire(payload.fingerprint.as_lossless()),
                request_id: text(&payload.request_id)?,
            }
        ),
        Payload::Recovery(payload) => item!(
            Value5,
            SessionReviewItemValue5,
            SessionReviewItemValue5Grades,
            SessionReviewItemValue5Child,
            item,
            v5::SessionReviewRecoveryPayload {
                r#type: 1,
                tools: v5::SessionReviewRecoveryPayloadTools {
                    items: payload
                        .tools
                        .iter()
                        .map(|tool| v5::SessionReviewRecoveryTool {
                            message_id: convert::wire(tool.message_id.as_lossless()),
                            call_id: convert::wire(&tool.call_id),
                            name: convert::wire(&tool.name),
                        })
                        .collect(),
                },
            }
        ),
    };
    Ok(v5::SessionReviewItem { kind: Some(kind) })
}
