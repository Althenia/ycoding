use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
    message::{self, message},
};
use ycoding_core::{
    session::{
        completion, lifecycle::Change, pending, run_coordinator, store::Service as SessionStore,
    },
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonValue, instruction_entry, model, session, session_delivery,
        session_message, session_pending,
    },
    ycoding_store::Error,
};
use ycoding_protocol::v5;

const COMPLETIONS_LIMIT: usize = 200;

pub async fn fork(
    invocation: Invocation,
    request: v5::SessionForkRequest,
) -> Result<v5::SessionForkResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let boundary = request
        .payload
        .message_id
        .as_ref()
        .map(convert::identifier::<session_message::Id>)
        .transpose()?;
    let info = core
        .sessions
        .fork(&id, boundary.clone())
        .await
        .map_err(|error| match error {
            Error::Domain {
                kind: "history_pruned",
                ..
            } => Failure::HistoryPruned {
                session: id.as_lossless().clone(),
                message: boundary
                    .as_ref()
                    .map(|id| id.as_lossless().clone())
                    .unwrap_or_else(|| "".into()),
            },
            Error::Domain {
                kind: "message_not_found",
                ..
            } => Failure::MessageNotFound {
                session: convert::readable(id.as_lossless()),
                message: boundary
                    .as_ref()
                    .map(|id| convert::readable(id.as_lossless()))
                    .unwrap_or_default(),
            },
            error => failure(error, &id),
        })?;
    Ok(v5::SessionForkResult {
        data: convert::session_info(&info)
            .map_err(|_| Failure::Unavailable("forked Session is not representable".into()))?,
    })
}

pub async fn daybreak_set(
    invocation: Invocation,
    request: v5::SessionDaybreakSetRequest,
) -> Result<v5::SessionDaybreakSetResult, Failure> {
    use v5::session_daybreak_set_request_payload_daybreak::Kind;
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let daybreak = match request.payload.daybreak.kind {
        Some(Kind::Clear(_)) => None,
        Some(Kind::Value1(value)) => Some(
            model::Daybreak::decode(&JsonValue::String(match value {
                value if value == v5::ModelDaybreak::DaybreakBlue as i32 => "daybreak_blue".into(),
                value if value == v5::ModelDaybreak::DaybreakRed as i32 => "daybreak_red".into(),
                _ => return Err(Failure::Invalid("invalid Daybreak program".into())),
            }))
            .map_err(|_| Failure::Invalid("invalid Daybreak program".into()))?,
        ),
        None => return Err(Failure::Invalid("missing Daybreak program".into())),
    };
    if !core
        .sessions
        .change(&id, Change::Daybreak(daybreak))
        .await
        .map_err(|error| failure(error, &id))?
    {
        return Err(Failure::SessionNotFound(convert::readable(
            id.as_lossless(),
        )));
    }
    let info = core
        .sessions
        .get(&id)
        .map_err(|error| failure(error, &id))?
        .ok_or_else(|| Failure::SessionNotFound(convert::readable(id.as_lossless())))?;
    Ok(v5::SessionDaybreakSetResult {
        data: convert::session_info(&info)
            .map_err(|_| Failure::Unavailable("Session is not representable".into()))?,
    })
}

pub async fn synthetic(
    invocation: Invocation,
    request: v5::SessionSyntheticRequest,
) -> Result<v5::SessionSyntheticResult, Failure> {
    let core = invocation.core()?;
    let session_id = invocation.session(&request.params.session_id)?;
    let payload = request.payload;
    let event_id =
        ids::event_id().map_err(|_| Failure::Unavailable("event ID generation failed".into()))?;
    let id = payload
        .id
        .as_ref()
        .map(convert::identifier::<session_message::Id>)
        .transpose()?
        .unwrap_or_else(|| session_message::Id::from_event(&event_id));
    let input = session_pending::Message::Synthetic(session_pending::SyntheticMessage {
        data: session_pending::SyntheticData {
            text: convert::domain(&payload.text)?,
            description: payload
                .description
                .as_ref()
                .map(convert::domain)
                .transpose()?,
            metadata: payload
                .metadata
                .as_ref()
                .map(|metadata| {
                    let mut object = ycoding_core::ycoding_schema::JsonObject::new();
                    for entry in &metadata.entries {
                        object.insert(
                            convert::domain(&entry.key)?,
                            convert::value_to_json(&entry.value)?,
                        );
                    }
                    Ok::<_, Failure>(object)
                })
                .transpose()?,
        },
        delivery: session_delivery::Delivery::decode(&JsonValue::String(
            if payload.delivery == Some(v5::SessionSyntheticRequestPayloadDelivery::Queue as i32) {
                "queue"
            } else {
                "steer"
            }
            .into(),
        ))
        .map_err(|_| Failure::Invalid("invalid delivery".into()))?,
    });
    let admitted = core
        .execution
        .prompt_with_origin(
            pending::Request {
                id,
                session_id: session_id.clone(),
                input,
                event_id,
                created: ids::now_millis(),
            },
            payload.resume,
            ycoding_core::session::autonomy::Origin::Runtime,
        )
        .await
        .map_err(|error| match error {
            run_coordinator::Error::Store(error) => match error.as_ref() {
                Error::Domain {
                    kind: "input_identity",
                    message,
                } => Failure::Conflict((*message).into()),
                _ => Failure::Unavailable("Session input admission unavailable".into()),
            },
            _ => Failure::Unavailable("Session execution unavailable".into()),
        })?;
    let Some(v5::session_pending_info::Kind::Value2(data)) = message::pending(&admitted)
        .map_err(|_| Failure::Unavailable("admitted synthetic input is not representable".into()))?
        .kind
    else {
        return Err(Failure::Unavailable(
            "admitted input is not synthetic".into(),
        ));
    };
    Ok(v5::SessionSyntheticResult { data })
}

pub async fn file_change_list(
    invocation: Invocation,
    request: v5::SessionFileChangeListRequest,
) -> Result<v5::SessionFileChangeListResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let changes = core
        .sessions
        .file_changes(&id)
        .map_err(|error| failure(error, &id))?;
    let count = |value| {
        u64::try_from(value)
            .ok()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or_else(|| Failure::Unavailable("file change count is not representable".into()))
    };
    Ok(v5::SessionFileChangeListResult {
        data: v5::SessionFileChangeListResultData {
            items: changes
                .iter()
                .map(|change| {
                    Ok(v5::SessionEventFileChangeInfo {
                        path: convert::wire(&change.path),
                        patch: convert::wire(&change.patch),
                        additions: count(change.additions)?,
                        deletions: count(change.deletions)?,
                    })
                })
                .collect::<Result<_, Failure>>()?,
        },
    })
}

pub async fn context(
    invocation: Invocation,
    request: v5::SessionContextRequest,
) -> Result<v5::SessionContextResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let context = core
        .sessions
        .context(&id)
        .map_err(|error| failure(error, &id))?;
    let items = context
        .iter()
        .map(message)
        .collect::<Result<_, _>>()
        .map_err(|_| Failure::Unavailable("Session context is not representable".into()))?;
    Ok(v5::SessionContextResult {
        data: v5::SessionContextResultData { items },
    })
}

pub async fn completions(
    invocation: Invocation,
    request: v5::SessionCompletionsRequest,
) -> Result<v5::SessionCompletionsResult, Failure> {
    let core = invocation.core()?;
    let after = request
        .query
        .after
        .as_ref()
        .map(convert::identifier::<session::Id>)
        .transpose()?;
    let limit = usize::try_from(request.query.limit.unwrap_or(COMPLETIONS_LIMIT as u64))
        .map_err(|_| Failure::Invalid("invalid completion page".into()))?;
    let page = completion::Completion::new(core.sessions.clone(), core.execution.jobs().clone())
        .latest(completion::Page { after, limit })
        .map_err(|error| match error {
            Error::Rejected(message) => Failure::Invalid(message.into()),
            _ => Failure::Unavailable("Session completions unavailable".into()),
        })?;
    Ok(v5::SessionCompletionsResult {
        data: v5::SessionWorkCompletionPage {
            data: v5::SessionWorkCompletionPageData {
                items: page
                    .data
                    .iter()
                    .map(|receipt| {
                        Ok(v5::SessionWorkCompletionReceipt {
                            id: convert::wire(receipt.id.as_lossless()),
                            seq: u64::try_from(receipt.seq).map_err(|_| {
                                Failure::Unavailable("completion sequence is invalid".into())
                            })?,
                            created: u64::try_from(receipt.created).map_err(|_| {
                                Failure::Unavailable("completion timestamp is invalid".into())
                            })?,
                            session_id: convert::wire(receipt.session_id.as_lossless()),
                            input_id: convert::wire(receipt.input_id.as_lossless()),
                            assistant_message_id: convert::wire(
                                receipt.assistant_message_id.as_lossless(),
                            ),
                        })
                    })
                    .collect::<Result<_, Failure>>()?,
            },
            next: page.next.as_ref().map(|id| convert::wire(id.as_lossless())),
        },
    })
}

pub async fn instruction_entry_list(
    invocation: Invocation,
    request: v5::SessionInstructionsEntryListRequest,
) -> Result<v5::SessionInstructionsEntryListResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    require_session(&core.sessions, &id)?;
    let entries = core
        .sessions
        .instruction_entries(&id)
        .map_err(|_| Failure::Unavailable("Session instruction entries unavailable".into()))?;
    Ok(v5::SessionInstructionsEntryListResult {
        data: v5::SessionInstructionsEntryListResultData {
            items: entries
                .iter()
                .map(|entry| {
                    let JsonValue::String(key) = entry.key.encode() else {
                        unreachable!("instruction entry keys encode as strings")
                    };
                    v5::InstructionEntryInfo {
                        key: convert::wire(&key),
                        value: convert::json_to_value(entry.value.as_value()),
                    }
                })
                .collect(),
        },
    })
}

pub async fn instruction_entry_put(
    invocation: Invocation,
    request: v5::SessionInstructionsEntryPutRequest,
) -> Result<v5::SessionInstructionsEntryPutResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    require_session(&core.sessions, &id)?;
    let key =
        instruction_entry::Key::decode(&JsonValue::String(convert::domain(&request.params.key)?))
            .map_err(|_| Failure::Invalid("invalid instruction entry key".into()))?;
    let value = convert::value_to_json(&request.payload.value)?;
    let entry = instruction_entry::Info {
        key,
        value: ycoding_core::ycoding_schema::domain::Json::new(value)
            .map_err(|_| Failure::Invalid("invalid instruction entry value".into()))?,
    };
    core.sessions
        .put_instruction_entry(&id, entry, ids::now_millis())
        .await
        .map_err(|error| match error {
            ycoding_core::session::instruction_entry::EntryError::ValueTooLarge(error) => {
                Failure::InstructionEntryValueTooLarge {
                    actual_bytes: error.actual_bytes.get(),
                    max_bytes: error.max_bytes.get(),
                    message: error.message,
                }
            }
            ycoding_core::session::instruction_entry::EntryError::Store(_) => {
                Failure::Unavailable("Session instruction entries unavailable".into())
            }
        })?;
    Ok(v5::SessionInstructionsEntryPutResult { data: v5::Empty {} })
}

pub async fn instruction_entry_remove(
    invocation: Invocation,
    request: v5::SessionInstructionsEntryRemoveRequest,
) -> Result<v5::SessionInstructionsEntryRemoveResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    require_session(&core.sessions, &id)?;
    let key =
        instruction_entry::Key::decode(&JsonValue::String(convert::domain(&request.params.key)?))
            .map_err(|_| Failure::Invalid("invalid instruction entry key".into()))?;
    core.sessions
        .remove_instruction_entry(&id, &key, ids::now_millis())
        .await
        .map_err(|_| Failure::Unavailable("Session instruction entries unavailable".into()))?;
    Ok(v5::SessionInstructionsEntryRemoveResult { data: v5::Empty {} })
}

pub async fn wait(
    invocation: Invocation,
    request: v5::SessionWaitRequest,
) -> Result<v5::SessionWaitResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    core.execution.await_idle(&id).await;
    Ok(v5::SessionWaitResult { data: v5::Empty {} })
}

pub async fn background(
    invocation: Invocation,
    request: v5::SessionBackgroundRequest,
) -> Result<v5::SessionBackgroundResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    core.execution.jobs().background_all(&id, None);
    Ok(v5::SessionBackgroundResult { data: v5::Empty {} })
}

fn require_session(sessions: &SessionStore, id: &session::Id) -> Result<(), Failure> {
    match sessions.get(id) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(Failure::SessionNotFound(convert::readable(
            id.as_lossless(),
        ))),
        Err(_) => Err(Failure::Unavailable("Session store unavailable".into())),
    }
}

fn failure(error: Error, id: &session::Id) -> Failure {
    match error {
        Error::Domain {
            kind: "not_found", ..
        } => Failure::SessionNotFound(convert::readable(id.as_lossless())),
        Error::Rejected(message) => Failure::Invalid(message.into()),
        _ => Failure::Unavailable("Session store unavailable".into()),
    }
}
