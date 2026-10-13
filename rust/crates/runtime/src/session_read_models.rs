use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString, ObjectEncoder, provider_request,
    schema::NonNegativeInt, session, session_captured_changes, session_compaction, token_usage,
};
use ycoding_core::ycoding_store::Error;
use ycoding_protocol::v5;

const GROUPS: [&str; 7] = [
    "model", "hour", "day", "month", "session", "project", "agent",
];
const INVALIDATIONS: [&str; 12] = [
    "first-request",
    "compaction-reset",
    "model-switched",
    "model-variant-switched",
    "stable-hit",
    "prefix-changed",
    "system-prefix-changed",
    "tool-prefix-changed",
    "below-minimum",
    "provider-not-reported",
    "cache-disabled",
    "retry-fallback",
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
    let summary = core
        .sessions
        .usage(&id, None)
        .map_err(|error| failure(error, &id))?;
    Ok(v5::SessionUsageResult {
        data: wire_summary(&summary)?,
    })
}

pub async fn usage_report(
    invocation: Invocation,
    request: v5::SessionUsageReportRequest,
) -> Result<v5::SessionUsageReportResult, Failure> {
    let core = invocation.core()?;
    let id = invocation.session(&request.params.session_id)?;
    let input = report_input(&request.query)?;
    let report = core
        .sessions
        .usage_report(&id, &input, None)
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
        .map_err(|error| failure(error, &id))?;
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
        Error::Rejected(message) => Failure::Invalid(message.into()),
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

fn report_input(
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

fn timing(timing: &provider_request::Timing) -> v5::ProviderRequestTiming {
    v5::ProviderRequestTiming {
        first_output_ms: timing.first_output_ms.map(count),
        total_ms: timing.total_ms.map(count),
        retry_wait_ms: timing.retry_wait_ms.map(count),
        prompt_eval_duration_ns: timing.prompt_eval_duration_ns.map(count),
        generation_duration_ns: timing.generation_duration_ns.map(count),
        observed_generation_duration_ns: timing
            .observed_generation_duration_ns
            .map(|value| value.get() as u64),
        generated_tokens: timing.generated_tokens.map(|value| value.get() as u64),
        load_duration_ns: timing.load_duration_ns.map(count),
    }
}

fn provenance(value: &provider_request::CostProvenance) -> Result<i32, Failure> {
    tag(&PROVENANCES, literal(&value.0)?)
}

fn wire_summary(
    summary: &provider_request::Summary,
) -> Result<v5::ProviderRequestSummary, Failure> {
    let models = summary
        .models
        .as_ref()
        .map(|models| {
            models
                .iter()
                .map(|spend| {
                    Ok(v5::ProviderRequestSummaryModelsItem {
                        model: convert::model_ref(&spend.model.encode())
                            .map_err(|_| unrepresentable())?,
                        requests: count(spend.requests),
                        tokens: tokens(&spend.tokens),
                        cache_read_reported: spend.cache_read_reported,
                        cost: spend.cost.map(|cost| cost.get()),
                        cost_provenance: spend
                            .cost_provenance
                            .as_ref()
                            .map(provenance)
                            .transpose()?,
                    })
                })
                .collect::<Result<_, Failure>>()
                .map(|items| v5::ProviderRequestSummaryModels { items })
        })
        .transpose()?;
    Ok(v5::ProviderRequestSummary {
        logical: count(summary.logical),
        physical: count(summary.physical),
        helpers: count(summary.helpers),
        continued: count(summary.continued),
        fallback: count(summary.fallback),
        cache_read_reported: summary.cache_read_reported,
        cost: summary.cost.map(|cost| cost.get()),
        models,
        tokens: tokens(&summary.tokens),
        latest_invalidation: summary
            .latest_invalidation
            .as_ref()
            .map(|value| tag(&INVALIDATIONS, literal(&value.0)?))
            .transpose()?,
        latest_namespace: summary.latest_namespace.as_ref().map(convert::wire),
        latest_timing: summary.latest_timing.as_ref().map(timing),
    })
}

fn wire_report(report: &provider_request::Report) -> Result<v5::ProviderRequestReport, Failure> {
    let rows = report
        .rows
        .iter()
        .map(|row| {
            Ok(v5::ProviderRequestReportRowsItem {
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
