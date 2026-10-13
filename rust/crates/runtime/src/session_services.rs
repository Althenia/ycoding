use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
    message::message,
};
use ycoding_core::{
    session::{completion, store::Service as SessionStore},
    ycoding_schema::{DomainDecode, DomainEncode, JsonValue, instruction_entry, session},
    ycoding_store::Error,
};
use ycoding_protocol::v5;

const COMPLETIONS_LIMIT: usize = 200;

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
