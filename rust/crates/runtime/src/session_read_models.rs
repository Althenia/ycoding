use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
};
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString, ObjectEncoder, provider_request,
    schema::NonNegativeInt, session, session_captured_changes, session_compaction, token_usage,
};
use ycoding_core::ycoding_store::Error;
use ycoding_protocol::v5;

const GROUPS: [&str; 14] = [
    "model",
    "hour",
    "day",
    "month",
    "session",
    "project",
    "agent",
    "provider",
    "provider-profile-model",
    "provider-model",
    "model-id",
    "profile",
    "prompt",
    "task",
];
const SORTS: [&str; 9] = [
    "key",
    "tokens",
    "cost",
    "steps",
    "input",
    "output",
    "reasoning",
    "cacheRead",
    "cacheWrite",
];
const ORDERS: [&str; 2] = ["asc", "desc"];
const PROVENANCES: [&str; 2] = ["recorded", "current_catalog"];
const INPUT_TYPES: [&str; 3] = ["user", "synthetic", "assistant"];
const TRIGGERS: [&str; 4] = ["consider", "advised", "mandatory", "manual"];
const STATUSES: [&str; 4] = ["pending", "running", "completed", "failed"];
const CODES: [&str; 7] = [
    "cancelled",
    "superseded",
    "invalid_manifest",
    "protected_state_changed",
    "context_limit_unresolved",
    "migration_failed",
    "provider_failed",
];
const CAPTURED_LIMIT: u64 = 200;

pub async fn usage(
    invocation: Invocation,
    request: v5::SessionUsageRequest,
) -> Result<v5::SessionUsageResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let sessions = core.sessions.clone();
    let pricer = core.usage_pricer.clone();
    let read_id = id.clone();
    let summary = tokio::task::spawn_blocking(move || {
        sessions.usage(&read_id, pricer.as_deref().map(|pricer| pricer as &_))
    })
    .await
    .map_err(|_| Failure::Unavailable("Usage read worker unavailable".into()))?
    .map_err(|error| failure(error, &id))?;
    Ok(v5::SessionUsageResult {
        data: convert::provider_summary(&summary).map_err(|_| unrepresentable())?,
    })
}

pub async fn usage_report(
    invocation: Invocation,
    request: v5::SessionUsageReportRequest,
) -> Result<v5::SessionUsageReportResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let input = report_input(&request.query)?;
    let sessions = core.sessions.clone();
    let pricer = core.usage_pricer.clone();
    let read_id = id.clone();
    let report = tokio::task::spawn_blocking(move || {
        sessions.usage_report(
            &read_id,
            &input,
            pricer.as_deref().map(|pricer| pricer as &_),
        )
    })
    .await
    .map_err(|_| Failure::Unavailable("Usage read worker unavailable".into()))?
    .map_err(|error| failure(error, &id))?;
    Ok(v5::SessionUsageReportResult {
        data: wire_report(&report)?,
    })
}

pub async fn captured_inputs(
    invocation: Invocation,
    request: v5::SessionCapturedInputsRequest,
) -> Result<v5::SessionCapturedInputsResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let after = request
        .query
        .after
        .map(i64::try_from)
        .transpose()
        .map_err(|_| Failure::Invalid("invalid captured input page".into()))?;
    let limit = usize::try_from(request.query.limit.unwrap_or(CAPTURED_LIMIT))
        .map_err(|_| Failure::Invalid("invalid captured input page".into()))?;
    let page = core
        .sessions
        .captured_inputs(&id, after, limit)
        .map_err(|error| {
            if let Error::Record(record) = &error
                && let Some(decode) = record
                    .downcast_ref::<ycoding_core::session::captured_changes::MessageDecodeError>(
                )
            {
                let reference = format!(
                    "err_{:08x}",
                    RandomState::new().build_hasher().finish() as u32
                );
                tracing::error!(
                    r#ref = reference,
                    session_id = convert::readable(id.as_lossless()),
                    message_id = convert::readable(&decode.message_id),
                    "failed to decode captured change input"
                );
                return Failure::Unknown {
                    message: "Unexpected server error. Check server logs for details.".into(),
                    reference,
                };
            }
            failure(error, &id)
        })?;
    Ok(v5::SessionCapturedInputsResult {
        data: wire_captured(&page)?,
    })
}

pub async fn compaction_list(
    invocation: Invocation,
    request: v5::SessionCompactionListRequest,
) -> Result<v5::SessionCompactionListResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let history = core
        .sessions
        .compaction_history(&id)
        .map_err(|error| failure(error, &id))?;
    Ok(v5::SessionCompactionListResult {
        data: wire_history(&history)?,
    })
}

fn failure(error: Error, id: &session::Id) -> Failure {
    match error {
        Error::Domain {
            kind: "not_found", ..
        } => Failure::SessionNotFound(convert::readable(id.as_lossless())),
        Error::Rejected(message) => Failure::InvalidField {
            message: message.into(),
            field: "timeZone",
        },
        _ => Failure::Unavailable("Session store unavailable".into()),
    }
}

fn unrepresentable() -> Failure {
    Failure::Unavailable("stored Session state is not representable on the wire".into())
}

fn name(names: &[&'static str], number: i32) -> Result<&'static str, Failure> {
    usize::try_from(number - 1)
        .ok()
        .and_then(|index| names.get(index).copied())
        .ok_or_else(|| Failure::Invalid("invalid usage report query".into()))
}

fn tag(names: &[&str], value: &str) -> Result<i32, Failure> {
    names
        .iter()
        .position(|candidate| *candidate == value)
        .map(|index| index as i32 + 1)
        .ok_or_else(unrepresentable)
}

fn literal(value: &LosslessString) -> Result<&str, Failure> {
    value.as_str().ok_or_else(unrepresentable)
}

pub(crate) fn report_input(
    query: &v5::SessionUsageReportRequestQuery,
) -> Result<provider_request::ReportInput, Failure> {
    let time_zone = query.time_zone.as_ref().map(convert::domain).transpose()?;
    let sort = query
        .sort
        .map(|sort| name(&SORTS, sort).map(LosslessString::from))
        .transpose()?;
    let order = query
        .order
        .map(|order| name(&ORDERS, order).map(LosslessString::from))
        .transpose()?;
    let value = ObjectEncoder::new()
        .optional(
            "providerID",
            &query
                .provider_id
                .as_ref()
                .map(convert::domain)
                .transpose()?,
        )
        .optional(
            "modelID",
            &query.model_id.as_ref().map(convert::domain).transpose()?,
        )
        .optional(
            "profile",
            &query.profile.as_ref().map(convert::domain).transpose()?,
        )
        .optional(
            "selectedEffort",
            &query
                .selected_effort
                .as_ref()
                .map(convert::domain)
                .transpose()?,
        )
        .field("group", &LosslessString::from(name(&GROUPS, query.group)?))
        .optional("timeZone", &time_zone)
        .optional("from", &query.from.map(|value| value as f64))
        .optional("to", &query.to.map(|value| value as f64))
        .optional("offset", &query.offset.map(|value| value as f64))
        .optional("limit", &query.limit.map(|value| value as f64))
        .optional("sort", &sort)
        .optional("order", &order)
        .finish();
    provider_request::ReportInput::decode(&value)
        .map_err(|_| Failure::Invalid("invalid usage report query".into()))
}

fn count(value: NonNegativeInt) -> u64 {
    value.get() as u64
}

fn tokens(info: &token_usage::Info) -> v5::TokenUsageInfo {
    v5::TokenUsageInfo {
        input: info.input.get(),
        output: info.output.get(),
        reasoning: info.reasoning.get(),
        cache: v5::TokenUsageInfoCache {
            read: info.cache.read.get(),
            write: info.cache.write.get(),
        },
    }
}

fn provenance(value: &provider_request::CostProvenance) -> Result<i32, Failure> {
    tag(&PROVENANCES, literal(&value.0)?)
}

pub(crate) fn wire_report(
    report: &provider_request::Report,
) -> Result<v5::ProviderRequestReport, Failure> {
    let rows = report
        .rows
        .iter()
        .map(|row| {
            Ok(v5::ProviderRequestReportRowsItem {
                model: row
                    .model
                    .as_ref()
                    .map(|model| convert::model_ref(&model.encode()))
                    .transpose()
                    .map_err(|_| unrepresentable())?,
                dimensions: row.dimensions.as_ref().map(wire_dimensions).transpose()?,
                cost_coverage: row.metrics.cost_coverage.as_ref().map(wire_coverage),
                key: convert::wire(&row.key),
                label: convert::wire(&row.label),
                logical: count(row.metrics.logical),
                physical: count(row.metrics.physical),
                helpers: count(row.metrics.helpers),
                continued: count(row.metrics.continued),
                fallback: count(row.metrics.fallback),
                tokens: tokens(&row.metrics.tokens),
                cost: row.metrics.cost.map(|cost| cost.get()),
                cost_provenance: row
                    .metrics
                    .cost_provenance
                    .as_ref()
                    .map(provenance)
                    .transpose()?,
                cache_read_reported: row.metrics.cache_read_reported,
                speed: row.speed.as_ref().map(|speed| v5::ProviderRequestSpeed {
                    generation_samples: count(speed.generation_samples),
                    provider_timed_samples: count(speed.provider_timed_samples),
                    observed_samples: count(speed.observed_samples),
                    generation_p50_tokens_per_second: speed.generation_p50_tokens_per_second,
                    generation_p90_tokens_per_second: speed.generation_p90_tokens_per_second,
                    first_output_p50_ms: speed.first_output_p50_ms.map(count),
                    first_output_p95_ms: speed.first_output_p95_ms.map(count),
                    total_p50_ms: speed.total_p50_ms.map(count),
                    total_p95_ms: speed.total_p95_ms.map(count),
                    output_tokens_per_second: speed.output_tokens_per_second,
                    samples: count(speed.samples),
                }),
            })
        })
        .collect::<Result<_, Failure>>()?;
    let total = &report.total;
    Ok(v5::ProviderRequestReport {
        group: tag(&GROUPS, literal(&report.group.0)?)?,
        rows: v5::ProviderRequestReportRows { items: rows },
        total: v5::ProviderRequestReportTotal {
            cost_coverage: total.cost_coverage.as_ref().map(wire_coverage),
            logical: count(total.logical),
            physical: count(total.physical),
            helpers: count(total.helpers),
            continued: count(total.continued),
            fallback: count(total.fallback),
            tokens: tokens(&total.tokens),
            cost: total.cost.map(|cost| cost.get()),
            cost_provenance: total.cost_provenance.as_ref().map(provenance).transpose()?,
            cache_read_reported: total.cache_read_reported,
        },
        row_count: count(report.row_count),
        next_offset: report.next_offset.map(count),
    })
}

pub(crate) fn wire_coverage(
    coverage: &provider_request::CostCoverage,
) -> v5::ProviderRequestCostCoverage {
    v5::ProviderRequestCostCoverage {
        priced_requests: count(coverage.priced_requests),
        unpriced_requests: count(coverage.unpriced_requests),
    }
}

fn wire_dimensions(
    value: &provider_request::ReportDimensions,
) -> Result<v5::ProviderRequestReportDimensions, Failure> {
    use provider_request::ReportDimensions;
    use v5::provider_request_report_dimensions::Kind;
    let kind = match value {
        ReportDimensions::Provider { provider_id } => {
            Kind::Value1(v5::ProviderRequestReportDimensionsValue1 {
                group: 1,
                provider_id: convert::wire(&provider_id.0),
            })
        }
        ReportDimensions::ProviderProfileModel {
            provider_id,
            profile,
            model_id,
        } => Kind::Value2(v5::ProviderRequestReportDimensionsValue2 {
            group: 1,
            provider_id: convert::wire(&provider_id.0),
            profile: profile.as_ref().map(|value| convert::wire(&value.0)),
            profile_state: if profile.is_some() { 1 } else { 2 },
            model_id: convert::wire(model_id),
        }),
        ReportDimensions::ProviderModel {
            provider_id,
            model_id,
        } => Kind::Value3(v5::ProviderRequestReportDimensionsValue3 {
            group: 1,
            provider_id: convert::wire(&provider_id.0),
            model_id: convert::wire(model_id),
        }),
        ReportDimensions::ModelId { model_id } => {
            Kind::Value4(v5::ProviderRequestReportDimensionsValue4 {
                group: 1,
                model_id: convert::wire(model_id),
            })
        }
        ReportDimensions::Profile {
            provider_id,
            profile,
        } => Kind::Value5(v5::ProviderRequestReportDimensionsValue5 {
            group: 1,
            provider_id: convert::wire(&provider_id.0),
            profile: profile.as_ref().map(|value| convert::wire(&value.0)),
            profile_state: if profile.is_some() { 1 } else { 2 },
        }),
        ReportDimensions::Prompt {
            anchor,
            attribution,
        } => Kind::Value6(v5::ProviderRequestReportDimensionsValue6 {
            group: 1,
            anchor: anchor.as_ref().map(|value| v5::UsageAnchorRef {
                session_id: convert::wire(value.session_id.as_lossless()),
                input_id: convert::wire(value.input_id.as_lossless()),
            }),
            attribution: tag(
                &["complete", "partial", "unattributed"],
                attribution.as_str(),
            )?,
        }),
        ReportDimensions::Task {
            session_id,
            attribution,
        } => Kind::Value7(v5::ProviderRequestReportDimensionsValue7 {
            group: 1,
            session_id: session_id
                .as_ref()
                .map(|value| convert::wire(value.as_lossless())),
            attribution: tag(
                &["complete", "partial", "unattributed"],
                attribution.as_str(),
            )?,
        }),
    };
    Ok(v5::ProviderRequestReportDimensions { kind: Some(kind) })
}

fn wire_captured(
    page: &session_captured_changes::Page,
) -> Result<v5::SessionCapturedChangesPage, Failure> {
    let items = page
        .data
        .iter()
        .map(|input| {
            Ok(v5::SessionCapturedChangesInput {
                id: convert::identity(&input.id)?,
                r#type: tag(&INPUT_TYPES, input.kind.as_str())?,
                metadata: input.metadata.as_ref().map(|metadata| {
                    v5::SessionCapturedChangesInputMetadata {
                        kind: metadata.kind.as_ref().map(convert::wire),
                        question_id: metadata.question_id.as_ref().map(convert::wire),
                    }
                }),
                content: input.content.as_ref().map(|tools| {
                    v5::SessionCapturedChangesInputContent {
                        items: tools.iter().map(wire_tool).collect(),
                    }
                }),
            })
        })
        .collect::<Result<_, Failure>>()?;
    Ok(v5::SessionCapturedChangesPage {
        data: v5::SessionCapturedChangesPageData { items },
        next: page.next.map(count),
    })
}

fn wire_tool(tool: &session_captured_changes::Tool) -> v5::SessionCapturedChangesInputContentItem {
    v5::SessionCapturedChangesInputContentItem {
        r#type: v5::SessionCapturedChangesInputContentItemType::SessioncapturedchangesInputContentitemTypeTool as i32,
        id: tool.id.as_ref().map(convert::wire),
        name: convert::wire(&tool.name),
        state: v5::SessionCapturedChangesInputContentItemState {
            status: tool.state.status.as_ref().map(convert::wire),
            input: tool.state.input.as_ref().map(|input| {
                v5::SessionCapturedChangesInputContentItemStateInput {
                    question_id: input.question_id.as_ref().map(convert::wire),
                }
            }),
            structured: tool.state.structured.as_ref().map(|structured| {
                v5::SessionCapturedChangesInputContentItemStateStructured {
                    files: structured.files.as_ref().map(|files| {
                        v5::SessionCapturedChangesInputContentItemStateStructuredFiles {
                            items: files
                                .iter()
                                .map(|file| {
                                    v5::SessionCapturedChangesInputContentItemStateStructuredFilesItem {
                                        file: file.file.as_ref().map(convert::wire),
                                        patch: convert::wire(&file.patch),
                                        status: file.status.as_ref().map(convert::wire),
                                    }
                                })
                                .collect(),
                        }
                    }),
                    session_id: structured.session_id.as_ref().map(convert::wire),
                    action: structured.action.as_ref().map(convert::wire),
                    task: structured.task.as_ref().map(|task| {
                        v5::SessionCapturedChangesInputContentItemStateStructuredTask {
                            session_id: task.session_id.as_ref().map(convert::wire),
                        }
                    }),
                }
            }),
        },
    }
}

fn wire_history(
    history: &session_compaction::History,
) -> Result<v5::SessionCompactionHistory, Failure> {
    let items = history
        .data
        .iter()
        .map(|job| {
            Ok(v5::SessionCompactionHistoryJob {
                job_id: convert::identity(&job.job_id)?,
                trigger: tag(&TRIGGERS, job.trigger.as_str())?,
                status: tag(&STATUSES, job.status.as_str())?,
                created: count(job.created),
                metrics: job
                    .metrics
                    .as_ref()
                    .map(|metrics| v5::SessionCompactionMetrics {
                        excluded_messages: count(metrics.excluded_messages),
                        excluded_parts: count(metrics.excluded_parts),
                        input_tokens: count(metrics.input_tokens),
                        retained_tokens: count(metrics.retained_tokens),
                    }),
                code: job
                    .code
                    .map(|code| tag(&CODES, code.as_str()))
                    .transpose()?,
            })
        })
        .collect::<Result<_, Failure>>()?;
    Ok(v5::SessionCompactionHistory {
        data: v5::SessionCompactionHistoryData { items },
        truncated: history.truncated,
        completed_before: count(history.completed_before),
        completed_count: count(history.completed_count),
        total_saved_tokens: history.total_saved_tokens.get(),
    })
}

#[cfg(test)]
mod usage_wire_tests {
    use super::{report_input, wire_report};
    use crate::convert;
    use ycoding_core::ycoding_schema::{DomainDecode, DomainEncode, parse_json, provider_request};
    use ycoding_protocol::v5;

    #[test]
    fn usage_wire_preserves_filters_and_report_populations() {
        let input = report_input(&v5::SessionUsageReportRequestQuery {
            group: 1,
            provider_id: Some(convert::text("p")),
            model_id: Some(convert::text("m")),
            profile: Some(convert::text("work")),
            selected_effort: Some(convert::text("high")),
            ..Default::default()
        })
        .unwrap();
        let encoded = ycoding_core::ycoding_schema::stringify_json(&input.encode());
        for name in ["providerID", "modelID", "profile", "selectedEffort"] {
            assert!(encoded.contains(name), "{name}");
        }
        let report = provider_request::Report::decode(&parse_json(r#"{"group":"model","rows":[{"key":"k","label":"l","model":{"providerID":"p","id":"m"},"logical":2,"physical":2,"helpers":0,"continued":0,"fallback":0,"tokens":{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"costCoverage":{"pricedRequests":1,"unpricedRequests":1},"speed":{"samples":3,"generationSamples":2,"providerTimedSamples":1,"observedSamples":1,"generationP50TokensPerSecond":4,"generationP90TokensPerSecond":8}}],"total":{"logical":2,"physical":2,"helpers":0,"continued":0,"fallback":0,"tokens":{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"costCoverage":{"pricedRequests":1,"unpricedRequests":1}},"rowCount":1}"#).unwrap()).unwrap();
        let wire = wire_report(&report).unwrap();
        let row = &wire.rows.items[0];
        assert!(row.model.is_some());
        assert_eq!(row.cost_coverage.as_ref().unwrap().unpriced_requests, 1);
        assert_eq!(wire.total.cost_coverage.unwrap().priced_requests, 1);
        let speed = row.speed.as_ref().unwrap();
        assert_eq!(speed.generation_samples, 2);
        assert_eq!(speed.provider_timed_samples, 1);
        assert_eq!(speed.observed_samples, 1);
        assert_eq!(speed.generation_p50_tokens_per_second, Some(4.0));
        assert_eq!(speed.generation_p90_tokens_per_second, Some(8.0));
    }
}
