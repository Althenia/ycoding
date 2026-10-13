use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids, session_revert,
};
use ycoding_core::event_feed::Ephemeral;
use ycoding_core::session::{lifecycle::Change, revert};
use ycoding_core::ycoding_schema::{DomainDecode, JsonValue, session_todo};
use ycoding_core::ycoding_store::Error;
use ycoding_protocol::v5;

pub async fn archive(
    invocation: Invocation,
    request: v5::SessionArchiveRequest,
) -> Result<v5::SessionArchiveResult, Failure> {
    change(&invocation, &request.params.session_id, Change::Archive).await?;
    Ok(v5::SessionArchiveResult { data: v5::Empty {} })
}

pub async fn unarchive(
    invocation: Invocation,
    request: v5::SessionUnarchiveRequest,
) -> Result<v5::SessionUnarchiveResult, Failure> {
    change(&invocation, &request.params.session_id, Change::Unarchive).await?;
    Ok(v5::SessionUnarchiveResult { data: v5::Empty {} })
}

pub async fn pin(
    invocation: Invocation,
    request: v5::SessionPinRequest,
) -> Result<v5::SessionPinResult, Failure> {
    change(&invocation, &request.params.session_id, Change::Pin).await?;
    Ok(v5::SessionPinResult { data: v5::Empty {} })
}

pub async fn unpin(
    invocation: Invocation,
    request: v5::SessionUnpinRequest,
) -> Result<v5::SessionUnpinResult, Failure> {
    change(&invocation, &request.params.session_id, Change::Unpin).await?;
    Ok(v5::SessionUnpinResult { data: v5::Empty {} })
}

pub async fn rename(
    invocation: Invocation,
    request: v5::SessionRenameRequest,
) -> Result<v5::SessionRenameResult, Failure> {
    let title = convert::domain(&request.payload.title)?;
    change(
        &invocation,
        &request.params.session_id,
        Change::Rename(title),
    )
    .await?;
    Ok(v5::SessionRenameResult { data: v5::Empty {} })
}

pub async fn active(
    invocation: Invocation,
    _request: v5::SessionActiveRequest,
) -> Result<v5::SessionActiveResult, Failure> {
    let core = invocation.core()?;
    Ok(v5::SessionActiveResult {
        data: v5::SessionActiveResultData {
            entries: core
                .execution
                .active()
                .iter()
                .map(|id| v5::SessionActiveResultDataEntry {
                    key: convert::wire(id.as_lossless()),
                    value: v5::SessionActive {
                        r#type: v5::SessionActiveType::SessionactiveTypeRunning as i32,
                    },
                })
                .collect(),
        },
    })
}

pub async fn todo_list(
    invocation: Invocation,
    request: v5::SessionTodoListRequest,
) -> Result<v5::SessionTodoListResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let items = core
        .sessions
        .todos(&id)
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?
        .iter()
        .map(|todo| {
            use v5::{SessionTodoInfoPriority as Priority, SessionTodoInfoStatus as Status};
            let status = match todo.status.as_str() {
                Some("pending") => Status::SessiontodoInfoStatusPending,
                Some("in_progress") => Status::SessiontodoInfoStatusInProgress,
                Some("completed") => Status::SessiontodoInfoStatusCompleted,
                Some("cancelled") => Status::SessiontodoInfoStatusCancelled,
                _ => return Err(unrepresentable()),
            };
            let priority = match todo.priority.as_str() {
                Some("high") => Priority::SessiontodoInfoPriorityHigh,
                Some("medium") => Priority::SessiontodoInfoPriorityMedium,
                Some("low") => Priority::SessiontodoInfoPriorityLow,
                _ => return Err(unrepresentable()),
            };
            Ok(v5::SessionTodoInfo {
                content: convert::wire(&todo.content),
                status: status as i32,
                priority: priority as i32,
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(v5::SessionTodoListResult {
        data: v5::SessionTodoListResultData { items },
    })
}

pub async fn todo_update(
    invocation: Invocation,
    request: v5::SessionTodoUpdateRequest,
) -> Result<v5::SessionTodoUpdateResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let todos = request
        .payload
        .todos
        .items
        .iter()
        .map(todo_domain)
        .collect::<Result<Vec<_>, _>>()?;
    core.sessions
        .update_todos(&id, &todos)
        .await
        .map_err(|error| match error {
            Error::Domain {
                kind: "not_found", ..
            } => Failure::SessionNotFound(convert::readable(id.as_lossless())),
            _ => Failure::Unavailable("Session store unavailable".into()),
        })?;
    core.events.publish(Ephemeral {
        id: ids::event_id()
            .map_err(|_| Failure::Unavailable("event identifier unavailable".into()))?
            .as_lossless()
            .clone(),
        created: ids::now_millis(),
        session: Some(id.clone()),
        metadata: None,
        location: core
            .sessions
            .get(&id)
            .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?
            .map(|session| session.location),
        data: ycoding_core::event_feed::Data::TodoUpdated(Box::new(session_todo::UpdatedData {
            session_id: id,
            todos,
        })),
    });
    Ok(v5::SessionTodoUpdateResult {
        data: v5::SessionTodoUpdateResultData {
            items: request.payload.todos.items,
        },
    })
}

fn todo_domain(todo: &v5::SessionTodoInfo) -> Result<session_todo::Info, Failure> {
    use v5::{SessionTodoInfoPriority as Priority, SessionTodoInfoStatus as Status};
    let status = match Status::try_from(todo.status) {
        Ok(Status::SessiontodoInfoStatusPending) => "pending",
        Ok(Status::SessiontodoInfoStatusInProgress) => "in_progress",
        Ok(Status::SessiontodoInfoStatusCompleted) => "completed",
        Ok(Status::SessiontodoInfoStatusCancelled) => "cancelled",
        Err(_) => return Err(Failure::Invalid("unknown todo status".into())),
    };
    let priority = match Priority::try_from(todo.priority) {
        Ok(Priority::SessiontodoInfoPriorityHigh) => "high",
        Ok(Priority::SessiontodoInfoPriorityMedium) => "medium",
        Ok(Priority::SessiontodoInfoPriorityLow) => "low",
        Err(_) => return Err(Failure::Invalid("unknown todo priority".into())),
    };
    Ok(session_todo::Info {
        content: convert::domain(&todo.content)?,
        status: session_todo::Status::decode(&JsonValue::String(status.into()))
            .map_err(|_| unrepresentable())?,
        priority: session_todo::Priority::decode(&JsonValue::String(priority.into()))
            .map_err(|_| unrepresentable())?,
    })
}

pub async fn diagnostics(
    invocation: Invocation,
    request: v5::SessionDiagnosticsRequest,
) -> Result<v5::SessionDiagnosticsResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let diagnostics = core
        .sessions
        .diagnostics(&id, None)
        .map_err(|_| Failure::Unavailable("Session diagnostics unavailable".into()))?;
    if diagnostics
        .as_ref()
        .is_some_and(|info| info.requests.is_some() || info.generation_speed.is_some())
    {
        return Err(unrepresentable());
    }
    Ok(v5::SessionDiagnosticsResult {
        data: diagnostics
            .as_ref()
            .map(convert::cache_diagnostics)
            .transpose()
            .map_err(|_| unrepresentable())?,
    })
}

pub async fn revert_commit(
    invocation: Invocation,
    request: v5::SessionRevertCommitRequest,
) -> Result<v5::SessionRevertCommitResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let sessions = core.sessions.clone();
    let execution = core.execution;
    let handle = tokio::runtime::Handle::current();
    let committed = {
        let id = id.clone();
        tokio::task::spawn_blocking(move || {
            handle.block_on(revert::commit_idle(
                &sessions,
                execution,
                &id,
                crate::ids::now_millis(),
            ))
        })
        .await
        .map_err(|_| Failure::Unavailable("Session revert unavailable".into()))?
    };
    committed.map_err(|error| session_revert::failure(error, &id))?;
    Ok(v5::SessionRevertCommitResult { data: v5::Empty {} })
}

async fn change(
    invocation: &Invocation,
    session_id: &v5::LosslessString,
    change: Change,
) -> Result<(), Failure> {
    let core = invocation.core()?;
    let id = invocation.session(session_id)?;
    match core.sessions.change(&id, change).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(Failure::SessionNotFound(convert::readable(
            id.as_lossless(),
        ))),
        Err(_) => Err(Failure::Unavailable("Session store unavailable".into())),
    }
}

fn unrepresentable() -> Failure {
    Failure::Unavailable("stored Session state is not representable on the wire".into())
}
