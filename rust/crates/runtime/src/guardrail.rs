use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::process::guardrails::Error;
use ycoding_core::tools::policy::Error as AuthorityError;
use ycoding_core::ycoding_schema::{guardrail, schema::NonNegativeInt};
use ycoding_protocol::v5;

pub async fn status(
    invocation: Invocation,
    request: v5::SessionGuardrailStatusRequest,
) -> Result<v5::SessionGuardrailStatusResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    let status = services
        .guardrails
        .status(&session)
        .map_err(|error| failure(error, None))?;
    let count = |value: NonNegativeInt| value.get() as u64;
    Ok(v5::SessionGuardrailStatusResult {
        data: v5::GuardrailStatus {
            root_session_id: convert::wire(status.root_session_id.as_lossless()),
            profile: convert::wire(&status.profile),
            custom_rules: count(status.custom_rules),
            approvals: count(status.approvals),
            blocked: count(status.blocked),
            counters: v5::GuardrailStatusCounters {
                items: status
                    .counters
                    .iter()
                    .map(|counter| v5::GuardrailCounter {
                        id: convert::wire(&counter.id),
                        current: count(counter.current),
                        limit: count(counter.limit),
                        scope: match counter.scope {
                            guardrail::CounterScope::Session => v5::GuardrailCounterScope::Session,
                            guardrail::CounterScope::Family => v5::GuardrailCounterScope::Family,
                        } as i32,
                    })
                    .collect(),
            },
            invalid_files: v5::GuardrailStatusInvalidFiles {
                items: status.invalid_files.iter().map(convert::wire).collect(),
            },
        },
    })
}

pub async fn request_list(
    invocation: Invocation,
    request: v5::SessionGuardrailRequestListRequest,
) -> Result<v5::SessionGuardrailRequestListResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    Ok(v5::SessionGuardrailRequestListResult {
        data: v5::SessionGuardrailRequestListResultData {
            items: invocation
                .core()?
                .locations
                .policy_sets(&services.info)
                .iter()
                .map(|services| services.guardrails.for_session(&session))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| failure(error, None))?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .iter()
                .map(wire)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn reply(
    invocation: Invocation,
    request: v5::SessionGuardrailRequestReplyRequest,
) -> Result<v5::SessionGuardrailRequestReplyResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    let id = convert::identifier::<guardrail::RequestId>(&request.params.request_id)?;
    let services = invocation
        .core()?
        .locations
        .policy_sets(&services.info)
        .into_iter()
        .find(|services| {
            services
                .guardrails
                .for_session(&session)
                .is_ok_and(|requests| requests.iter().any(|request| request.id == id))
        })
        .ok_or_else(|| {
            Failure::GuardrailRequestNotFound(convert::readable(
                &convert::domain(&request.params.request_id).unwrap_or_default(),
            ))
        })?;
    let reply = match v5::GuardrailReply::try_from(request.payload.reply) {
        Ok(v5::GuardrailReply::Once) => guardrail::Reply::Once,
        Ok(v5::GuardrailReply::Always) => guardrail::Reply::Always,
        Ok(v5::GuardrailReply::Reject) => guardrail::Reply::Reject,
        Err(_) => return Err(Failure::Invalid("invalid guardrail reply".into())),
    };
    services
        .guardrails
        .reply(&session, &id, reply)
        .map_err(|error| failure(error, Some(&request.params.request_id)))?;
    Ok(v5::SessionGuardrailRequestReplyResult { data: v5::Empty {} })
}

pub(crate) fn wire(request: &guardrail::Request) -> Result<v5::GuardrailRequest, Failure> {
    Ok(v5::GuardrailRequest {
        id: convert::identity(&request.id)?,
        root_session_id: convert::wire(request.root_session_id.as_lossless()),
        session_id: convert::wire(request.session_id.as_lossless()),
        action: convert::wire(&request.action),
        resources: v5::GuardrailRequestResources {
            items: request.resources.iter().map(convert::wire).collect(),
        },
        rule_i_ds: v5::GuardrailRequestRuleIDs {
            items: request.rule_ids.iter().map(convert::wire).collect(),
        },
        reason: convert::wire(&request.reason),
        standard: request.standard,
        hard_review: request.hard_review,
        risk: request.risk.as_ref().map(|risk| v5::GuardrailRisk {
            level: risk.level.get() as u64,
            label: convert::wire(&risk.label),
            score: risk.score.get(),
            metric: match risk.metric {
                guardrail::Metric::Confidence => v5::GuardrailRiskMetric::Confidence,
                guardrail::Metric::Probability => v5::GuardrailRiskMetric::Probability,
            } as i32,
        }),
        metadata: request
            .metadata
            .as_ref()
            .map(|metadata| v5::GuardrailRequestMetadata {
                entries: metadata
                    .iter()
                    .map(|(key, value)| v5::GuardrailRequestMetadataEntry {
                        key: convert::wire(key),
                        value: convert::json_to_value(value),
                    })
                    .collect(),
            }),
    })
}

fn failure(error: Error, request: Option<&v5::LosslessString>) -> Failure {
    match error {
        Error::Authority(AuthorityError::NotFound(id)) => {
            Failure::SessionNotFound(convert::readable(id.as_lossless()))
        }
        Error::NotFound => Failure::GuardrailRequestNotFound(
            request
                .and_then(|request| convert::domain(request).ok())
                .map(|request| convert::readable(&request))
                .unwrap_or_default(),
        ),
        _ => Failure::Unavailable("Guardrail service unavailable".into()),
    }
}
