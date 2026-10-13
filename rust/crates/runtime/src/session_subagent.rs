use crate::{
    convert, cursor,
    dispatch::{Failure, Invocation},
};
use ycoding_core::session::orchestration::Error;
use ycoding_core::ycoding_schema::{
    domain::Json,
    session, session_message,
    session_orchestration::{ListAnchor, QuestionId},
};
use ycoding_protocol::v5;

const DEFAULT_LIMIT: usize = 10;

pub async fn list(
    invocation: Invocation,
    request: v5::SessionSubagentListRequest,
) -> Result<v5::SessionSubagentListResult, Failure> {
    let core = invocation.core()?;
    let parent = invocation.session(&request.params.parent_id)?;
    let anchor = request
        .query
        .cursor
        .as_ref()
        .map(|value| {
            convert::domain(value)?
                .to_utf8()
                .map_err(|_| Failure::InvalidCursor("Invalid cursor".into()))
                .and_then(|value| cursor::decode_subagent(&parent, &value))
        })
        .transpose()?;
    let page = core
        .orchestration
        .page(
            &parent,
            Some(
                request
                    .query
                    .limit
                    .map_or(DEFAULT_LIMIT, |limit| limit as usize),
            ),
            anchor.as_ref(),
        )
        .map_err(failure)?;
    let count = |value: ycoding_core::ycoding_schema::schema::NonNegativeInt| value.get() as u64;
    let link = |anchor: &ListAnchor| convert::text(&cursor::encode_subagent(&parent, anchor));
    Ok(v5::SessionSubagentListResult {
        data: v5::SessionOrchestrationPage {
            data: v5::SessionOrchestrationPageData {
                items: page
                    .data
                    .iter()
                    .map(convert::task)
                    .collect::<Result<_, _>>()
                    .map_err(|_| unrepresentable())?,
            },
            summary: v5::SessionOrchestrationSummary {
                total: count(page.summary.total),
                active: count(page.summary.active),
                running: count(page.summary.running),
                waiting: count(page.summary.waiting),
            },
            cursor: v5::SessionOrchestrationPageCursor {
                previous: page.previous.as_ref().map(link),
                next: page.next.as_ref().map(link),
            },
        },
    })
}

pub async fn message(
    invocation: Invocation,
    request: v5::SessionSubagentMessageRequest,
) -> Result<v5::SessionSubagentMessageResult, Failure> {
    let core = invocation.core()?;
    let parent = invocation.session(&request.params.parent_id)?;
    let child = convert::identifier::<session::Id>(&request.params.child_id)?;
    let message_id = convert::identifier::<session_message::Id>(&request.payload.message_id)?;
    let delivery = match v5::SessionSubagentMessageDelivery::try_from(request.payload.delivery) {
        Ok(v5::SessionSubagentMessageDelivery::SessionsubagentmessageDeliveryQueue) => "queue",
        Ok(v5::SessionSubagentMessageDelivery::SessionsubagentmessageDeliverySteer) => "steer",
        Err(_) => return Err(Failure::Invalid("invalid delivery".into())),
    };
    let text = convert::domain(&request.payload.text)?
        .to_utf8()
        .map_err(|_| Failure::Invalid("message text is not valid UTF-8".into()))?;
    let task = core
        .orchestration
        .send(&parent, &child, &message_id, &text, delivery)
        .await
        .map_err(failure)?;
    Ok(v5::SessionSubagentMessageResult {
        data: convert::task(&task).map_err(|_| unrepresentable())?,
    })
}

pub async fn answer(
    invocation: Invocation,
    request: v5::SessionSubagentAnswerRequest,
) -> Result<v5::SessionSubagentAnswerResult, Failure> {
    let core = invocation.core()?;
    let parent = invocation.session(&request.params.parent_id)?;
    let child = convert::identifier::<session::Id>(&request.params.child_id)?;
    let question = QuestionId(convert::domain(&request.params.question_id)?);
    let text = request
        .payload
        .text
        .as_ref()
        .map(|text| {
            convert::domain(text)?
                .to_utf8()
                .map_err(|_| Failure::Invalid("answer text is not valid UTF-8".into()))
        })
        .transpose()?;
    let data = request
        .payload
        .data
        .as_ref()
        .map(|value| {
            Json::new(convert::value_to_json(value)?)
                .map_err(|_| Failure::Invalid("invalid answer data".into()))
        })
        .transpose()?;
    let task = core
        .orchestration
        .answer(&parent, &child, &question, text.as_deref(), data)
        .await
        .map_err(failure)?;
    Ok(v5::SessionSubagentAnswerResult {
        data: convert::task(&task).map_err(|_| unrepresentable())?,
    })
}

pub async fn cancel(
    invocation: Invocation,
    request: v5::SessionSubagentCancelRequest,
) -> Result<v5::SessionSubagentCancelResult, Failure> {
    let core = invocation.core()?;
    let parent = invocation.session(&request.params.parent_id)?;
    let child = convert::identifier::<session::Id>(&request.params.child_id)?;
    let task = core
        .orchestration
        .cancel(&parent, &child)
        .await
        .map_err(failure)?;
    Ok(v5::SessionSubagentCancelResult {
        data: convert::task(&task).map_err(|_| unrepresentable())?,
    })
}

pub async fn resume(
    invocation: Invocation,
    request: v5::SessionSubagentResumeRequest,
) -> Result<v5::SessionSubagentResumeResult, Failure> {
    let core = invocation.core()?;
    let parent = invocation.session(&request.params.parent_id)?;
    let child = convert::identifier::<session::Id>(&request.params.child_id)?;
    let task = core
        .orchestration
        .resume(&parent, &child)
        .await
        .map_err(failure)?;
    Ok(v5::SessionSubagentResumeResult {
        data: convert::task(&task).map_err(|_| unrepresentable())?,
    })
}

fn failure(error: Error) -> Failure {
    match error {
        Error::SessionNotFound(id) | Error::TaskNotFound(id) => {
            Failure::SessionNotFound(convert::readable(id.as_lossless()))
        }
        Error::NotFound { child_id, .. } => {
            Failure::SessionNotFound(convert::readable(child_id.as_lossless()))
        }
        Error::Forbidden {
            parent_id,
            child_id,
        } => Failure::Forbidden(format!(
            "Session {} is not a direct managed child of {}",
            convert::readable(child_id.as_lossless()),
            convert::readable(parent_id.as_lossless())
        )),
        Error::QuestionNotFound { question_id, .. } => {
            Failure::QuestionNotFound(convert::readable(&question_id.0))
        }
        Error::Conflict(message) => Failure::Conflict(message),
        Error::InvalidRequest(message) => Failure::Invalid(message),
        Error::DepthLimit(limit) => {
            Failure::Invalid(format!("Subagent depth limit reached ({limit})"))
        }
        Error::Store(_) | Error::Execution(_) | Error::Cancelled => {
            Failure::Unavailable("Session orchestration unavailable".into())
        }
    }
}

fn unrepresentable() -> Failure {
    Failure::Unavailable("stored task is not representable on the wire".into())
}

#[cfg(test)]
mod tests {
    use super::{Error, Failure, failure};

    #[test]
    fn cancelled_orchestration_uses_the_declared_unavailable_result() {
        assert_eq!(
            failure(Error::Cancelled),
            Failure::Unavailable("Session orchestration unavailable".into())
        );
    }
}
