use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::session::autonomy::{Error, GoalChange};
use ycoding_protocol::v5;

pub async fn get(
    invocation: Invocation,
    request: v5::SessionAutonomyGetRequest,
) -> Result<v5::SessionAutonomyGetResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    Ok(v5::SessionAutonomyGetResult {
        data: convert::autonomy_state(&core.autonomy.get(&id).map_err(failure)?),
    })
}

pub async fn set(
    invocation: Invocation,
    request: v5::SessionAutonomySetRequest,
) -> Result<v5::SessionAutonomySetResult, Failure> {
    use v5::{session_autonomy_set::Kind, session_autonomy_set_value1_goal::Kind as Goal};
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let state = match request.payload.kind {
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
                Some(Goal::Value1(_)) => {
                    return Err(Failure::Unavailable(
                        "goal calculation is not wired to the local bridge".into(),
                    ));
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
        None => return Err(Failure::Invalid("missing autonomy change".into())),
    }
    .map_err(failure)?;
    Ok(v5::SessionAutonomySetResult {
        data: convert::autonomy_state(&state),
    })
}

fn failure(error: Error) -> Failure {
    match error {
        Error::NotFound(id) => Failure::SessionNotFound(convert::readable(id.as_lossless())),
        Error::Store(_) => Failure::Unavailable("Session store unavailable".into()),
    }
}
