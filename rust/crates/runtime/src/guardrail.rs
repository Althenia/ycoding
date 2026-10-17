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
    Ok(v5::SessionGuardrailStatusResult {
        data: status_wire(&status),
    })
}

fn status_wire(status: &guardrail::Status) -> v5::GuardrailStatus {
    let count = |value: NonNegativeInt| value.get() as u64;
    v5::GuardrailStatus {
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
        dismissals: status
            .dismissals
            .as_ref()
            .map(|items| v5::GuardrailStatusDismissals {
                items: items
                    .iter()
                    .map(|dismissal| v5::GuardrailStatusDismissalsItem {
                        session_id: convert::wire(dismissal.session_id.as_lossless()),
                        created: count(dismissal.created),
                        event_id: convert::wire(&dismissal.event_id),
                        rule_id: convert::wire(&dismissal.rule_id),
                        confidence: dismissal.confidence,
                        source: dismissal.source.as_ref().map(convert::guardrail_source),
                    })
                    .collect(),
            }),
        decisions: status
            .decisions
            .as_ref()
            .map(|items| v5::GuardrailStatusDecisions {
                items: items
                    .iter()
                    .map(|decision| v5::GuardrailStatusDecisionsItem {
                        session_id: convert::wire(decision.session_id.as_lossless()),
                        created: count(decision.created),
                        request_id: convert::wire(&decision.request_id),
                        reply: convert::guardrail_reply(decision.reply),
                        choice: decision.choice.map(convert::decision_choice),
                        confidence: decision.confidence.map(guardrail::Confidence::get),
                        grades: decision.grades.as_ref().map(|grades| {
                            v5::GuardrailStatusDecisionsItemGrades {
                                items: convert::grades(grades),
                            }
                        }),
                        rule_i_ds: decision.rule_ids.as_ref().map(|rules| {
                            v5::GuardrailStatusDecisionsItemRuleIDs {
                                items: rules.iter().map(convert::wire).collect(),
                            }
                        }),
                        source: decision.source.as_ref().map(convert::guardrail_source),
                    })
                    .collect(),
            }),
    }
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
        escalation: request.escalation.as_ref().map(convert::escalation),
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

#[cfg(test)]
mod tests {
    use super::*;
    use ycoding_core::ycoding_schema::{DomainDecode, parse_json};

    #[test]
    fn request_and_status_wire_carry_escalation_dismissals_and_decision_provenance() {
        let request = guardrail::Request::decode(&parse_json(r#"{"id":"grq_fixture","rootSessionID":"ses_root","sessionID":"ses_child","action":"shell","resources":[],"ruleIDs":["standard.review.fixture"],"reason":"outside","standard":true,"escalation":{"choice":"escalate","confidence":0.5,"grades":[{"choice":"approve","confidence":0.5,"evidence":"close"}]}}"#).unwrap()).unwrap();
        let escalation = wire(&request).unwrap().escalation.unwrap();
        assert_eq!(
            (escalation.choice, escalation.confidence),
            (Some(4), Some(0.5))
        );
        assert_eq!(escalation.grades.unwrap().items[0].choice, 2);
        let status = guardrail::Status::decode(&parse_json(r#"{"rootSessionID":"ses_root","profile":"standard","customRules":0,"approvals":0,"blocked":0,"counters":[],"invalidFiles":[],"dismissals":[{"sessionID":"ses_child","created":5,"eventID":"evt_dismissed","ruleID":"standard.review.fixture","confidence":0.95,"source":{"messageID":"msg_tool","callID":"call_one"}}],"decisions":[{"sessionID":"ses_child","created":6,"requestID":"grq_fixture","reply":"always","choice":"approve_all","confidence":0.9,"grades":[{"choice":"approve_all","confidence":0.9,"evidence":"broad"}],"ruleIDs":["standard.review.fixture"]}]}"#).unwrap()).unwrap();
        let status = status_wire(&status);
        let dismissal = &status.dismissals.unwrap().items[0];
        assert_eq!((dismissal.created, dismissal.confidence), (5, 0.95));
        assert_eq!(
            dismissal.source.as_ref().unwrap().call_id,
            convert::text("call_one")
        );
        let decision = &status.decisions.unwrap().items[0];
        assert_eq!(
            (decision.reply, decision.choice, decision.confidence),
            (2, Some(1), Some(0.9))
        );
        assert_eq!(decision.grades.as_ref().unwrap().items.len(), 1);
        assert_eq!(decision.rule_i_ds.as_ref().unwrap().items.len(), 1);
        assert!(decision.source.is_none());
        assert!(
            status_wire(&guardrail::Status::decode(&parse_json(r#"{"rootSessionID":"ses_root","profile":"standard","customRules":0,"approvals":0,"blocked":0,"counters":[],"invalidFiles":[]}"#).unwrap()).unwrap())
                .dismissals
                .is_none()
        );
    }
}
