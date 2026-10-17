use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
};
use std::sync::Arc;
use ycoding_core::{
    session::{
        autonomy::{self, Error, GoalChange},
        goal,
        helper_generation::trim,
        pending,
        prompt_cache::sha256,
    },
    tools::code_mode::Cancellation,
    ycoding_schema::{DomainDecode, ObjectEncoder, session_message, session_pending},
};
use ycoding_protocol::v5;

pub async fn get(
    invocation: Invocation,
    request: v5::SessionAutonomyGetRequest,
) -> Result<v5::SessionAutonomyGetResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    Ok(v5::SessionAutonomyGetResult {
        data: view(core, &id)?,
    })
}

pub async fn set(
    invocation: Invocation,
    request: v5::SessionAutonomySetRequest,
) -> Result<v5::SessionAutonomySetResult, Failure> {
    use v5::{session_autonomy_set::Kind, session_autonomy_set_value1_goal::Kind as Goal};
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    match request.payload.kind {
        Some(Kind::Value2(only)) => {
            core.autonomy
                .set_yolo(&id, convert::yolo_level(&only.yolo)?)
                .await
        }
        Some(Kind::Value1(change)) => {
            let yolo = change.yolo.as_ref().map(convert::yolo_level).transpose()?;
            let goal = match change.goal.kind {
                Some(Goal::Clear(_)) => GoalChange::Stop,
                Some(Goal::Value2(true)) => {
                    if core.autonomy.get(&id).map_err(failure)?.goal.is_none() {
                        return Err(Failure::InvalidField {
                            message: "No retained goal to resume. Set a goal with /goal <text>."
                                .into(),
                            field: "goal",
                        });
                    }
                    GoalChange::Resume
                }
                Some(Goal::Value1(text)) => {
                    let raw_text = trim(&convert::readable(&convert::domain(&text)?));
                    if raw_text.is_empty() {
                        return Err(Failure::InvalidField {
                            message: "goal must not be blank".into(),
                            field: "goal",
                        });
                    }
                    let snapshot = core.autonomy.snapshot(&id).map_err(failure)?;
                    let (session, location) = core.locations.session(&id)?;
                    let (catalogs, services) = core
                        .session_services(&location)
                        .map_err(|_| goal_failure(goal::Error::ModelUnavailable))?;
                    let environment = goal::Environment {
                        location: services.runner.location().clone(),
                        agents: catalogs.agents,
                        generate: Arc::new(services.runner),
                    };
                    let goals = goal::Service::new(
                        core.sessions.clone(),
                        Arc::new(move |reference| {
                            (reference == &environment.location).then(|| environment.clone())
                        }),
                    );
                    let cancellation = Cancellation::default();
                    let synthesized = goals
                        .synthesize(&session, &raw_text, &cancellation)
                        .await
                        .map_err(goal_failure)?;
                    let candidate =
                        autonomy::Goal::new(&synthesized, Some(&raw_text), change.max_no_progress);
                    let steer = goals
                        .start(&session, &candidate, &cancellation)
                        .await
                        .map_err(goal_failure)?;
                    let applied = core
                        .autonomy
                        .set_goal_if_current(&id, snapshot.sequence, yolo, candidate)
                        .await
                        .map_err(failure)?;
                    if !applied.applied {
                        return Err(Failure::GoalStaleCalculation(convert::readable(
                            id.as_lossless(),
                        )));
                    }
                    let event_id = ids::event_id()
                        .map_err(|_| Failure::Unavailable("event ID generation failed".into()))?;
                    let input_id = session_message::Id::new(format!(
                        "msg_goal_{}",
                        &sha256(&convert::readable(event_id.as_lossless()))[..24]
                    ))
                    .map_err(|_| Failure::Unavailable("goal input ID generation failed".into()))?;
                    let input = session_pending::Message::decode(
                        &ObjectEncoder::new()
                            .field("type", "synthetic")
                            .field(
                                "data",
                                &ObjectEncoder::new()
                                    .field("text", steer.as_str())
                                    .field("description", "Goal · steer")
                                    .field(
                                        "metadata",
                                        &ObjectEncoder::new()
                                            .field(
                                                "autonomy",
                                                &ObjectEncoder::new()
                                                    .field(
                                                        "yolo",
                                                        &f64::from(applied.state.yolo.get()),
                                                    )
                                                    .field("goal", &true)
                                                    .field("iteration", &0.0)
                                                    .finish(),
                                            )
                                            .finish(),
                                    )
                                    .finish(),
                            )
                            .field("delivery", "steer")
                            .finish(),
                    )
                    .map_err(|_| Failure::Unavailable("goal steer is not representable".into()))?;
                    core.execution
                        .prompt_with_origin(
                            pending::Request {
                                id: input_id,
                                session_id: id.clone(),
                                input,
                                event_id,
                                created: ids::now_millis(),
                            },
                            None,
                            autonomy::Origin::Runtime,
                        )
                        .await
                        .map_err(|_| {
                            Failure::Unavailable("Session input admission unavailable".into())
                        })?;
                    return Ok(v5::SessionAutonomySetResult {
                        data: view(core, &id)?,
                    });
                }
                Some(Goal::Value2(false)) | None => {
                    return Err(Failure::InvalidField {
                        message: "A goal change is a goal string, true, or null".into(),
                        field: "goal",
                    });
                }
            };
            core.autonomy.change(&id, yolo, Some(goal)).await
        }
        Some(Kind::Value3(change)) => {
            let state = core.autonomy.set_sleep(&id, change.sleep).await;
            if change.sleep && state.is_ok() {
                crate::session_review::convert_family(core, &id).await?;
            }
            state
        }
        Some(Kind::Value4(change)) => core.autonomy.set_auto_answer(&id, change.auto_answer).await,
        None => return Err(Failure::Invalid("missing autonomy change".into())),
    }
    .map_err(failure)?;
    Ok(v5::SessionAutonomySetResult {
        data: view(core, &id)?,
    })
}

fn view(
    core: &crate::Core,
    id: &ycoding_core::ycoding_schema::session::Id,
) -> Result<v5::SessionAutonomyView, Failure> {
    let state = core.autonomy.get(id).map_err(failure)?;
    let effective = core.autonomy.effective(id).map_err(failure)?;
    let root = core.autonomy.root(id).map_err(failure)?;
    let ordinary = core
        .autonomy
        .effective(&root)
        .map_err(failure)?
        .can_auto_guardrail()
        && !effective.asleep;
    let (_, services) = core.locations.session(id)?;
    let policy = services.guardrails.review_policy();
    Ok(convert::autonomy_view(
        &state,
        v5::SessionAutonomyEffective {
            yolo: convert::yolo(effective.yolo),
            asleep: effective.asleep,
            guardrails_enabled: policy.enabled,
            ordinary_reviews_auto: ordinary,
            model_reviews: policy.enabled && policy.decide_reviews,
            hard_model_reviews: policy.decide_reviews && policy.decide_hard_reviews,
        },
    ))
}

fn failure(error: Error) -> Failure {
    match error {
        Error::NotFound(id) => Failure::SessionNotFound(convert::readable(id.as_lossless())),
        Error::Store(_) => Failure::Unavailable("Session store unavailable".into()),
    }
}

fn goal_failure(error: goal::Error) -> Failure {
    let reference = ids::subscription_id();
    let reference = format!("err_{}", &sha256(&reference)[..8]);
    let category = match error {
        goal::Error::ModelUnavailable => "goal.model_unavailable",
        goal::Error::CalculationFailed => "goal.calculation_failed",
        goal::Error::Interrupted => "goal.interrupted",
    };
    tracing::warn!(category, reference, "Goal calculation failed");
    Failure::Unknown {
        message: if error == goal::Error::ModelUnavailable {
            "Goal model is unavailable. Check the goal model configuration before retrying."
        } else {
            "Goal calculation failed. The existing goal was not replaced; retry when the provider is available."
        }.into(),
        reference,
    }
}

pub(crate) async fn wake_root(
    core: &crate::Core,
    id: &ycoding_core::ycoding_schema::session::Id,
) -> Result<(), Failure> {
    let root = core
        .sessions
        .get(id)
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?
        .is_some_and(|session| session.parent_id.is_none());
    if root {
        core.autonomy.set_sleep(id, false).await.map_err(failure)?;
    }
    Ok(())
}
