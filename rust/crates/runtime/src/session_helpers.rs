use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::resources::memory::Scope;
use ycoding_core::session::{
    prediction,
    prompt_generator::{self, Mode},
};
use ycoding_protocol::v5;

pub async fn prediction(
    invocation: Invocation,
    request: v5::SessionPredictionRequest,
) -> Result<v5::SessionPredictionResult, Failure> {
    use v5::{
        SessionPredictionRequestPayloadMemoryItem as Item, session_prediction_response_data::Kind,
    };
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let (_, services) = core.locations.session(&id)?;
    let memory = request
        .payload
        .memory
        .items
        .iter()
        .map(|item| match Item::try_from(*item) {
            Ok(Item::SessionPredictionRequestPayloadMemoryitemRepository) => Ok(Scope::Repository),
            Ok(Item::SessionPredictionRequestPayloadMemoryitemKnowledge) => Ok(Scope::Knowledge),
            Err(_) => Err(Failure::Invalid("unknown memory scope".into())),
        })
        .collect::<Result<_, _>>()?;
    let hint = request
        .payload
        .hint
        .as_ref()
        .map(|hint| convert::domain(hint).map(|hint| convert::readable(&hint)))
        .transpose()?;
    let suggestion = match &services.prediction {
        Some(service) => {
            service
                .request(&id, prediction::Input { memory, hint })
                .await
        }
        None => None,
    };
    Ok(v5::SessionPredictionResult {
        data: v5::SessionPredictionResponse {
            data: v5::SessionPredictionResponseData {
                kind: Some(match suggestion {
                    Some(text) => Kind::Value1(v5::SessionPredictionResponseDataValue1 {
                        status: v5::SessionPredictionResponseDataValue1Status::SessionpredictionresponseDatavalue1StatusSuggested as i32,
                        text: convert::text(&text),
                    }),
                    None => Kind::Value2(v5::SessionPredictionResponseDataValue2 {
                        status: v5::SessionPredictionResponseDataValue2Status::SessionpredictionresponseDatavalue2StatusUnavailable as i32,
                    }),
                }),
            },
        },
    })
}

pub async fn prompt_generate(
    invocation: Invocation,
    request: v5::SessionPromptGenerateRequest,
) -> Result<v5::SessionPromptGenerateResult, Failure> {
    use v5::{
        SessionPromptGenerateRequestPayloadMemoryItem as Item,
        SessionPromptGenerateRequestPayloadMode as WireMode,
        session_prompt_generate_response_data::Kind,
    };
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let (_, services) = core.locations.session(&id)?;
    let mode = match WireMode::try_from(request.payload.mode) {
        Ok(WireMode::SessionPromptgenerateRequestPayloadModeStart) => Mode::Start,
        Ok(WireMode::SessionPromptgenerateRequestPayloadModeSteer) => Mode::Steer,
        Ok(WireMode::SessionPromptgenerateRequestPayloadModeQueue) => Mode::Queue,
        Ok(WireMode::SessionPromptgenerateRequestPayloadModeGoal) => Mode::Goal,
        Err(_) => return Err(Failure::Invalid("unknown prompt mode".into())),
    };
    let memory = request
        .payload
        .memory
        .items
        .iter()
        .map(|item| match Item::try_from(*item) {
            Ok(Item::SessionPromptgenerateRequestPayloadMemoryitemRepository) => {
                Ok(Scope::Repository)
            }
            Ok(Item::SessionPromptgenerateRequestPayloadMemoryitemKnowledge) => {
                Ok(Scope::Knowledge)
            }
            Err(_) => Err(Failure::Invalid("unknown memory scope".into())),
        })
        .collect::<Result<_, _>>()?;
    let intent = convert::readable(&convert::domain(&request.payload.intent)?);
    if intent.trim().is_empty() {
        return Err(Failure::InvalidField {
            message: "intent must not be blank".into(),
            field: "intent",
        });
    }
    let draft = match &services.prompts {
        Some(service) => {
            service
                .request(
                    &id,
                    prompt_generator::Input {
                        mode,
                        intent,
                        memory,
                    },
                )
                .await
        }
        None => None,
    };
    Ok(v5::SessionPromptGenerateResult {
        data: v5::SessionPromptGenerateResponse {
            data: v5::SessionPromptGenerateResponseData {
                kind: Some(match draft {
                    Some(text) => Kind::Value1(v5::SessionPromptGenerateResponseDataValue1 {
                        status: v5::SessionPromptGenerateResponseDataValue1Status::SessionpromptgenerateresponseDatavalue1StatusGenerated as i32,
                        text: convert::text(&text),
                    }),
                    None => Kind::Value2(v5::SessionPromptGenerateResponseDataValue2 {
                        status: v5::SessionPromptGenerateResponseDataValue2Status::SessionpromptgenerateresponseDatavalue2StatusUnavailable as i32,
                    }),
                }),
            },
        },
    })
}
