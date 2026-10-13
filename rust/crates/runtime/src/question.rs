use crate::{
    convert,
    dispatch::{Failure, Invocation},
    locations::LocationServices,
};
use ycoding_core::tools::policy::questions::Error;
use ycoding_core::ycoding_schema::{question, session_id::SessionId};
use ycoding_protocol::v5;

pub async fn list(
    invocation: Invocation,
    request: v5::SessionQuestionListRequest,
) -> Result<v5::SessionQuestionListResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    Ok(v5::SessionQuestionListResult {
        data: v5::SessionQuestionListResultData {
            items: services
                .questions
                .list()
                .iter()
                .filter(|pending| pending.session_id == session)
                .map(wire)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn request_list(
    invocation: Invocation,
    request: v5::QuestionRequestListRequest,
) -> Result<v5::QuestionRequestListResult, Failure> {
    let services = invocation.location(request.query.location.as_ref())?;
    Ok(v5::QuestionRequestListResult {
        location: convert::location_info(&services.info),
        data: v5::QuestionRequestListResultData {
            items: services
                .questions
                .list()
                .iter()
                .map(wire)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn reply(
    invocation: Invocation,
    request: v5::SessionQuestionReplyRequest,
) -> Result<v5::SessionQuestionReplyResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    let id = owned(&services, &session, &request.params.request_id)?;
    let answers = request
        .payload
        .answers
        .items
        .iter()
        .map(|answer| answer.items.iter().map(convert::domain).collect())
        .collect::<Result<_, _>>()?;
    services
        .questions
        .reply(&id, answers)
        .map_err(|error| failure(error, &request.params.request_id))?;
    Ok(v5::SessionQuestionReplyResult { data: v5::Empty {} })
}

pub async fn reject(
    invocation: Invocation,
    request: v5::SessionQuestionRejectRequest,
) -> Result<v5::SessionQuestionRejectResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    let id = owned(&services, &session, &request.params.request_id)?;
    services
        .questions
        .reject(&id)
        .map_err(|error| failure(error, &request.params.request_id))?;
    Ok(v5::SessionQuestionRejectResult { data: v5::Empty {} })
}

fn owned(
    services: &LocationServices,
    session: &SessionId,
    requested: &v5::LosslessString,
) -> Result<question::Id, Failure> {
    let id = convert::identifier::<question::Id>(requested)?;
    services
        .questions
        .list()
        .iter()
        .any(|pending| pending.id == id && &pending.session_id == session)
        .then_some(id)
        .ok_or_else(|| missing(requested))
}

pub(crate) fn wire(request: &question::Request) -> Result<v5::QuestionRequest, Failure> {
    Ok(v5::QuestionRequest {
        id: convert::identity(&request.id)?,
        session_id: convert::wire(request.session_id.as_lossless()),
        questions: v5::QuestionRequestQuestions {
            items: request
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
        tool: request.tool.as_ref().map(|tool| v5::QuestionTool {
            message_id: convert::wire(&tool.message_id),
            call_id: convert::wire(&tool.call_id),
        }),
    })
}

fn failure(error: Error, id: &v5::LosslessString) -> Failure {
    match error {
        Error::NotFound => missing(id),
        _ => Failure::Unavailable("Question service unavailable".into()),
    }
}

fn missing(id: &v5::LosslessString) -> Failure {
    Failure::QuestionNotFound(
        convert::domain(id)
            .map(|id| convert::readable(&id))
            .unwrap_or_default(),
    )
}
