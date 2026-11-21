use super::{Column, ColumnType, Engine, Source, SourceRow, Value};
use crate::{Client, Error, Snapshot, TableSpec, project, resources, session};
use std::{ops::Bound, path::Path};
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectEncoder, model, provider_request, telemetry,
    token_usage, usage_anchor,
};

pub fn start(client: Client, directory: impl AsRef<Path>) -> Result<Engine, super::Error> {
    Engine::start(client, directory, SOURCES)
}

fn retained(_: &Snapshot, _: &[u8]) -> Result<bool, Error> {
    Ok(true)
}

fn text(value: &LosslessString) -> Value {
    Value::Text(
        value
            .to_utf8()
            .unwrap_or_else(|_| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())),
    )
}

fn optional_text(value: Option<&LosslessString>) -> Value {
    value.map(text).unwrap_or(Value::Null)
}

fn integer(value: Option<i64>) -> Value {
    value.map(Value::BigInt).unwrap_or(Value::Null)
}

fn component(value: &LosslessString) -> String {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let utf8 = value.to_utf8().unwrap_or_default();
    let mut text = String::with_capacity(utf8.len());
    for byte in utf8.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => text.push(byte as char),
            _ => {
                text.push('%');
                text.push(DIGITS[(byte >> 4) as usize] as char);
                text.push(DIGITS[(byte & 0xf) as usize] as char);
            }
        }
    }
    text
}

macro_rules! source {
    ($load:ident, $page:ident, $table:ty, $normalize:ident) => {
        fn $load(snapshot: &Snapshot, identity: &[u8]) -> Result<Option<SourceRow>, Error> {
            snapshot
                .get::<$table>(identity)?
                .map($normalize)
                .transpose()
        }
        fn $page(
            snapshot: &Snapshot,
            after: Option<&[u8]>,
            limit: usize,
        ) -> Result<Vec<SourceRow>, Error> {
            snapshot
                .scan::<$table>(
                    after.map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    limit,
                )?
                .into_iter()
                .map($normalize)
                .collect()
        }
    };
}

source!(load_request, page_request, resources::RequestTable, request);
source!(load_task, page_task, session::TaskTable, task);
source!(
    load_usage_fact,
    page_usage_fact,
    resources::UsageAnalyticsRequestTable,
    usage_fact
);
source!(
    load_session,
    page_session,
    session::SessionTable,
    session_row
);
source!(
    load_project,
    page_project,
    project::ProjectTable,
    project_row
);
source!(load_usage, page_usage, resources::UsageTable, usage);
source!(load_consent, page_consent, resources::ConsentTable, consent);
source!(load_latency, page_latency, resources::LatencyTable, latency);
source!(
    load_cell,
    page_cell,
    crate::usage_cells::CellTable,
    cell_row
);
source!(
    load_leaf,
    page_leaf,
    crate::usage_cells::LeafTable,
    leaf_row
);
source!(
    load_unpriced,
    page_unpriced,
    crate::usage_cells::UnpricedTable,
    unpriced_row
);
source!(
    load_backfill,
    page_backfill,
    crate::usage_cells::BackfillTable,
    backfill_row
);

fn cell_dimensions(row: &crate::usage_cells::Cell, identity: &[u8]) -> Result<Vec<Value>, Error> {
    let dimensions = &row.dimensions;
    let model = dimensions.model.domain()?;
    let key = [
        Some(&model.provider_id.0),
        Some(&model.id),
        model.variant.as_ref(),
        model.profile.as_ref().map(|value| &value.0),
    ]
    .into_iter()
    .flatten()
    .map(component)
    .collect::<Vec<_>>()
    .join("/");
    Ok(vec![
        text(&row.family),
        Value::BigInt(row.span),
        Value::BigInt(row.bucket),
        text(&dimensions.session_id),
        text(&dimensions.source),
        text(&dimensions.agent),
        text(&model.provider_id.0),
        text(&model.id),
        optional_text(model.variant.as_ref()),
        optional_text(model.profile.as_ref().map(|value| &value.0)),
        Value::Text(key),
        text(&dimensions.project_id),
        text(&dimensions.directory),
        optional_text(dimensions.workspace_id.as_ref()),
        Value::BigInt(dimensions.session_updated),
        optional_text(dimensions.anchor_session_id.as_ref()),
        optional_text(dimensions.anchor_input_id.as_ref()),
        optional_text(dimensions.input_key.as_ref()),
        Value::Text(
            dimensions
                .task_path
                .iter()
                .map(task_entry)
                .collect::<Vec<_>>()
                .join("|"),
        ),
        Value::Text(stringify_model(&model)),
        group_key("provider", &[Some(&model.provider_id.0)]),
        group_key(
            "provider-model",
            &[Some(&model.provider_id.0), Some(&model.id)],
        ),
        group_key(
            "provider-profile-model",
            &[
                Some(&model.provider_id.0),
                model.profile.as_ref().map(|value| &value.0),
                Some(&model.id),
            ],
        ),
        group_key("model-id", &[Some(&model.id)]),
        group_key(
            "profile",
            &[
                Some(&model.provider_id.0),
                model.profile.as_ref().map(|value| &value.0),
            ],
        ),
        group_key(
            "prompt",
            &[
                dimensions.anchor_session_id.as_ref(),
                dimensions.anchor_input_id.as_ref(),
            ],
        ),
        Value::Text(hex(identity)),
        dimensions
            .anchor_session_id
            .as_ref()
            .zip(dimensions.anchor_input_id.as_ref())
            .map(|(session, input)| {
                Value::Text(ycoding_schema::stringify_json(
                    &ObjectEncoder::new()
                        .field("sessionID", session)
                        .field("inputID", input)
                        .finish(),
                ))
            })
            .unwrap_or(Value::Null),
    ])
}
fn stringify_model(model: &model::Ref) -> String {
    ycoding_schema::stringify_json(&model.encode())
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(DIGITS[(byte >> 4) as usize] as char);
        text.push(DIGITS[(byte & 0xf) as usize] as char);
    }
    text
}
fn cell_values(row: &crate::usage_cells::Cell, identity: &[u8]) -> Result<Vec<Value>, Error> {
    if row.counts.len() != crate::usage_cells::COUNTS.len()
        || row.amounts.len() != crate::usage_cells::AMOUNTS.len()
    {
        return Err(Error::Incompatible("prepared Usage shape"));
    }
    let mut values = cell_dimensions(row, identity)?;
    values.extend(row.counts[..16].iter().copied().map(Value::BigInt));
    values.extend(
        row.amounts[..8]
            .iter()
            .map(|value| value.to_bytes().map(Value::Blob))
            .collect::<Result<Vec<_>, _>>()?,
    );
    values.push(Value::Double(row.generation_rate));
    values.extend(
        row.amounts[8..10]
            .iter()
            .map(|value| value.to_bytes().map(Value::Blob))
            .collect::<Result<Vec<_>, _>>()?,
    );
    Ok(values)
}
fn cell_scope(row: &crate::usage_cells::Cell) -> Vec<u8> {
    if row.family.as_str() == Some("session") {
        crate::tuple_key(&[crate::KeyPart::String(&row.dimensions.session_id)])
    } else {
        vec![]
    }
}
fn cell_row(row: crate::usage_cells::Cell) -> Result<SourceRow, Error> {
    let identity = row.key();
    let mut values = cell_values(&row, &identity)?;
    values.extend([
        Value::BigInt(row.counts[16]),
        Value::Blob(row.amounts[10].to_bytes()?),
    ]);
    Ok(SourceRow {
        identity: identity.clone(),
        scope: cell_scope(&row),
        values,
    })
}
fn leaf_row(row: crate::usage_cells::Leaf) -> Result<SourceRow, Error> {
    let mut values = cell_values(&row.contribution, &row.contribution.key())?;
    values.push(text(&row.source_id));
    values.extend([
        Value::BigInt(row.contribution.counts[16]),
        Value::Blob(row.contribution.amounts[10].to_bytes()?),
    ]);
    Ok(SourceRow {
        identity: crate::usage_cells::LeafTable::primary_key(&row),
        scope: cell_scope(&row.contribution),
        values,
    })
}
fn load_sample(snapshot: &Snapshot, identity: &[u8]) -> Result<Option<SourceRow>, Error> {
    let Some(row) = snapshot.get::<crate::usage_cells::SampleTable>(identity)? else {
        return Ok(None);
    };
    let cell_key = row.cell.key();
    let values = cell_dimensions(&row.cell, &cell_key)?;
    sample_row(row, &cell_key, values).map(Some)
}

fn page_sample(
    snapshot: &Snapshot,
    after: Option<&[u8]>,
    limit: usize,
) -> Result<Vec<SourceRow>, Error> {
    let mut previous = None::<(Vec<u8>, Vec<Value>)>;
    snapshot
        .scan::<crate::usage_cells::SampleTable>(
            after.map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            limit,
        )?
        .into_iter()
        .map(|row| {
            let cell_key = row.cell.key();
            let (key, values) = match &previous {
                Some(projection) if projection.0 == cell_key => projection,
                _ => {
                    let values = cell_dimensions(&row.cell, &cell_key)?;
                    &*previous.insert((cell_key, values))
                }
            };
            sample_row(row, key, values.clone())
        })
        .collect()
}

fn sample_row(
    row: crate::usage_cells::Sample,
    cell_key: &[u8],
    mut values: Vec<Value>,
) -> Result<SourceRow, Error> {
    values.extend([
        Value::BigInt(row.metric),
        row.value
            .as_ref()
            .map(|value| value.to_bytes().map(Value::Blob))
            .transpose()?
            .unwrap_or(Value::Null),
        row.generation_rate.map_or(Value::Null, Value::Double),
        Value::BigInt(row.count),
    ]);
    Ok(SourceRow {
        identity: row.key_for_cell(cell_key),
        scope: cell_scope(&row.cell),
        values,
    })
}
fn unpriced_row(row: crate::usage_cells::Unpriced) -> Result<SourceRow, Error> {
    if row.tokens.len() != 5 {
        return Err(Error::Incompatible("prepared Usage price context"));
    }
    let mut values = cell_dimensions(&row.cell, &row.cell.key())?;
    values.extend([
        Value::Blob(row.context.to_bytes()?),
        Value::BigInt(row.requests),
    ]);
    values.extend(
        row.tokens
            .iter()
            .map(|value| value.to_bytes().map(Value::Blob))
            .collect::<Result<Vec<_>, _>>()?,
    );
    Ok(SourceRow {
        identity: crate::usage_cells::UnpricedTable::primary_key(&row),
        scope: cell_scope(&row.cell),
        values,
    })
}
fn backfill_row(row: crate::usage_cells::Backfill) -> Result<SourceRow, Error> {
    Ok(SourceRow {
        identity: crate::usage_cells::BackfillTable::primary_key(&row),
        scope: vec![],
        values: vec![
            text(&row.family),
            optional_text(row.after.as_ref()),
            Value::Boolean(row.complete == 1),
        ],
    })
}

fn request(row: resources::Request) -> Result<SourceRow, Error> {
    let anchor = row
        .usage_anchor
        .as_ref()
        .map(|value| value.domain())
        .transpose()?;
    Ok(SourceRow {
        identity: resources::RequestTable::primary_key(&row),
        scope: crate::tuple_key(&[crate::KeyPart::String(&row.session_id)]),
        values: normalized_values(Normalized {
            session_id: &row.session_id,
            source: &row.source,
            agent: &row.agent,
            model: &row.model,
            request: row.request,
            attempts: row.attempts,
            continuation: &row.continuation,
            cache_read_reported: row.cache_read_reported,
            cost: row.cost,
            tokens: &row.tokens,
            time_created: row.time_created,
            timing: row.timing.as_ref(),
            usage_anchor: row.usage_anchor.as_ref(),
            outcome: row.outcome.as_ref(),
        })?
        .into_iter()
        .chain([
            optional_text(anchor.as_ref().map(|value| value.session_id.as_lossless())),
            optional_text(anchor.as_ref().map(|value| value.input_id.as_lossless())),
            row.input_id
                .as_ref()
                .map(|input| {
                    Value::Text(ycoding_schema::stringify_json(&JsonValue::Array(vec![
                        row.session_id.encode(),
                        input.encode(),
                    ])))
                })
                .unwrap_or(Value::Null),
        ])
        .collect(),
    })
}

fn task(row: session::Task) -> Result<SourceRow, Error> {
    Ok(SourceRow {
        identity: session::TaskTable::primary_key(&row),
        scope: Vec::new(),
        values: vec![
            text(&row.session_id),
            text(&row.parent_id),
            Value::Text(task_entry(&row.session_id)),
        ],
    })
}

fn usage_fact(row: resources::UsageAnalyticsRequest) -> Result<SourceRow, Error> {
    let anchor = row
        .usage_anchor
        .as_ref()
        .map(|anchor| anchor.domain())
        .transpose()?;
    let mut values = normalized_values(Normalized {
        session_id: &row.session_id,
        source: &row.source,
        agent: &row.agent,
        model: &row.model,
        request: row.request,
        attempts: row.attempts,
        continuation: &row.continuation,
        cache_read_reported: row.cache_read_reported,
        cost: row.cost,
        tokens: &row.tokens,
        time_created: row.time_created,
        timing: row.timing.as_ref(),
        usage_anchor: row.usage_anchor.as_ref(),
        outcome: row.outcome.as_ref(),
    })?;
    values.extend([
        text(&row.project_id),
        text(&row.directory),
        optional_text(row.workspace_id.as_ref()),
        Value::BigInt(row.session_updated),
        optional_text(
            anchor
                .as_ref()
                .map(|anchor| anchor.session_id.as_lossless()),
        ),
        optional_text(anchor.as_ref().map(|anchor| anchor.input_id.as_lossless())),
        Value::Text(
            row.task_path
                .domain()?
                .iter()
                .map(task_entry)
                .collect::<Vec<_>>()
                .join("|"),
        ),
    ]);
    Ok(SourceRow {
        identity: resources::UsageAnalyticsRequestTable::primary_key(&row),
        scope: Vec::new(),
        values,
    })
}

struct Normalized<'a> {
    outcome: Option<&'a LosslessString>,
    usage_anchor: Option<&'a session::Document<usage_anchor::Ref>>,
    session_id: &'a LosslessString,
    source: &'a LosslessString,
    agent: &'a LosslessString,
    model: &'a session::Document<model::Ref>,
    request: i64,
    attempts: i64,
    continuation: &'a LosslessString,
    cache_read_reported: Option<i64>,
    cost: Option<f64>,
    tokens: &'a session::Document<token_usage::Info>,
    time_created: i64,
    timing: Option<&'a session::Document<provider_request::Timing>>,
}

fn normalized_values(row: Normalized<'_>) -> Result<Vec<Value>, Error> {
    let model = row.model.domain()?;
    let anchor = row.usage_anchor.map(|value| value.domain()).transpose()?;
    let tokens = row.tokens.domain()?;
    let timing = row.timing.map(|value| value.domain()).transpose()?;
    let key = [
        Some(&model.provider_id.0),
        Some(&model.id),
        model.variant.as_ref(),
        model.profile.as_ref().map(|profile| &profile.0),
    ]
    .into_iter()
    .flatten()
    .map(component)
    .collect::<Vec<_>>()
    .join("/");
    Ok(vec![
        text(row.session_id),
        text(row.source),
        text(row.agent),
        text(&model.provider_id.0),
        text(&model.id),
        optional_text(model.variant.as_ref()),
        optional_text(model.profile.as_ref().map(|profile| &profile.0)),
        Value::Text(key),
        Value::BigInt(row.request),
        Value::BigInt(row.attempts),
        text(row.continuation),
        Value::Boolean(row.cache_read_reported == Some(1)),
        row.cost.map(Value::Double).unwrap_or(Value::Null),
        Value::Double(tokens.input.get()),
        Value::Double(tokens.output.get()),
        Value::Double(tokens.reasoning.get()),
        Value::Double(tokens.cache.read.get()),
        Value::Double(tokens.cache.write.get()),
        Value::BigInt(row.time_created),
        integer(
            timing
                .as_ref()
                .and_then(|timing| timing.first_output_ms.map(|value| value.get())),
        ),
        integer(
            timing
                .as_ref()
                .and_then(|timing| timing.total_ms.map(|value| value.get())),
        ),
        integer(
            timing
                .as_ref()
                .and_then(|timing| timing.generated_tokens.map(|value| value.get())),
        ),
        integer(timing.as_ref().and_then(|timing| {
            timing
                .generation_duration_ns
                .map(|value| value.get())
                .filter(|value| *value >= 1_000_000_000)
                .or_else(|| {
                    timing
                        .observed_generation_duration_ns
                        .map(|value| value.get())
                        .filter(|value| *value >= 1_000_000_000)
                })
        })),
        Value::Boolean(timing.as_ref().is_some_and(|timing| {
            timing
                .generation_duration_ns
                .is_some_and(|value| value.get() >= 1_000_000_000)
        })),
        group_key("provider", &[Some(&model.provider_id.0)]),
        group_key(
            "provider-model",
            &[Some(&model.provider_id.0), Some(&model.id)],
        ),
        group_key(
            "provider-profile-model",
            &[
                Some(&model.provider_id.0),
                model.profile.as_ref().map(|value| &value.0),
                Some(&model.id),
            ],
        ),
        group_key("model-id", &[Some(&model.id)]),
        group_key(
            "profile",
            &[
                Some(&model.provider_id.0),
                model.profile.as_ref().map(|value| &value.0),
            ],
        ),
        group_key(
            "prompt",
            &[
                anchor.as_ref().map(|value| value.session_id.as_lossless()),
                anchor.as_ref().map(|value| value.input_id.as_lossless()),
            ],
        ),
        Value::Text(ycoding_schema::stringify_json(&model.encode())),
        anchor
            .as_ref()
            .map(|value| Value::Text(ycoding_schema::stringify_json(&value.encode())))
            .unwrap_or(Value::Null),
        optional_text(row.outcome),
    ])
}

fn group_key(group: &str, parts: &[Option<&LosslessString>]) -> Value {
    Value::Text(ycoding_schema::stringify_json(&JsonValue::Array(
        std::iter::once(LosslessString::from(group).encode())
            .chain(
                parts
                    .iter()
                    .map(|value| value.map(|value| value.encode()).unwrap_or(JsonValue::Null)),
            )
            .collect(),
    )))
}

fn task_entry(id: &LosslessString) -> String {
    let hex = |value: &str| {
        value
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    format!(
        "{}.{}",
        hex(&String::from_utf16_lossy(
            &id.code_units().collect::<Vec<_>>()
        )),
        hex(&ycoding_schema::stringify_json(&id.encode()))
    )
}

fn session_row(row: session::Session) -> Result<SourceRow, Error> {
    Ok(SourceRow {
        identity: session::SessionTable::primary_key(&row),
        scope: Vec::new(),
        values: vec![
            text(&row.id),
            optional_text(row.parent_id.as_ref()),
            text(&row.title),
            text(&row.project_id),
            text(&row.directory),
            optional_text(row.workspace_id.as_ref()),
            Value::BigInt(row.time_updated),
        ],
    })
}

fn project_row(row: project::Project) -> Result<SourceRow, Error> {
    Ok(SourceRow {
        identity: project::ProjectTable::primary_key(&row),
        scope: Vec::new(),
        values: vec![
            text(&row.id),
            optional_text(row.name.as_ref()),
            text(&row.worktree),
        ],
    })
}

fn usage(row: resources::Usage) -> Result<SourceRow, Error> {
    Ok(SourceRow {
        identity: resources::UsageTable::primary_key(&row),
        scope: Vec::new(),
        values: vec![
            text(&row.session_id),
            text(&row.model_key),
            Value::BigInt(row.logical),
        ],
    })
}

fn consent(row: resources::Consent) -> Result<SourceRow, Error> {
    Ok(SourceRow {
        identity: resources::ConsentTable::primary_key(&row),
        scope: Vec::new(),
        values: vec![
            Value::Boolean(row.enabled == 1),
            Value::BigInt(row.notice_version),
        ],
    })
}

fn latency(row: resources::Latency) -> Result<SourceRow, Error> {
    let ycoding_schema::JsonValue::Object(sample) = row.sample.domain()?.encode() else {
        return Err(Error::Rejected("invalid latency sample"));
    };
    let values = LATENCY_FIELDS
        .iter()
        .map(|field| match sample.get(&(*field).into()) {
            Some(ycoding_schema::JsonValue::String(value)) => Ok(text(value)),
            Some(ycoding_schema::JsonValue::Number(value)) => Ok(Value::BigInt(*value as i64)),
            None => Ok(Value::Null),
            _ => Err(Error::Rejected("invalid latency field")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SourceRow {
        identity: resources::LatencyTable::primary_key(&row),
        scope: Vec::new(),
        values: [
            vec![Value::BigInt(row.id), Value::BigInt(row.received_at)],
            values,
        ]
        .concat(),
    })
}

macro_rules! columns {
    ($($name:literal : $kind:ident),* $(,)?) => { &[$(Column { name: $name, kind: ColumnType::$kind }),*] };
}
macro_rules! cell_columns {
    ($($name:literal:$kind:ident),* $(,)?)=>{columns!["family":Text,"span":Integer,"bucket":Integer,"session_id":Text,"source":Text,"agent":Text,"provider":Text,"model":Text,"variant":Text,"profile":Text,"model_key":Text,"project_id":Text,"directory":Text,"workspace_id":Text,"session_updated":Integer,"anchor_session_id":Text,"anchor_input_id":Text,"input_key":Text,"task_entries":Text,"model_json":Text,"provider_key":Text,"provider_model_key":Text,"provider_profile_model_key":Text,"model_id_key":Text,"profile_key":Text,"prompt_key":Text,"cell_identity":Text,"anchor_json":Text,$($name:$kind),*]};
}
macro_rules! cell_metrics_columns {
    ($($name:literal:$kind:ident),* $(,)?)=>{cell_columns!["logical":Integer,"physical":Integer,"helpers":Integer,"continued":Integer,"fallback":Integer,"cache_reported":Integer,"priced":Integer,"unpriced":Integer,"completed":Integer,"failed":Integer,"cancelled":Integer,"first_samples":Integer,"total_samples":Integer,"generation_samples":Integer,"generation_provider":Integer,"generation_observed":Integer,"cost":Decimal,"input":Decimal,"output":Decimal,"reasoning":Decimal,"cache_read":Decimal,"cache_write":Decimal,"first_total":Decimal,"total_total":Decimal,"generation_rate":Double,"generation_tokens":Decimal,"generation_ns":Decimal,$($name:$kind),*]};
}

pub const SOURCES: &[Source] = &[
    Source {
        name: "usage_cell",
        version: 2,
        allowed: retained,
        load: load_cell,
        page: page_cell,
        columns: cell_metrics_columns!["cost_nonnegative_requests":Integer,"cost_nonnegative":Decimal],
    },
    Source {
        name: "usage_cell_leaf",
        version: 2,
        allowed: retained,
        load: load_leaf,
        page: page_leaf,
        columns: cell_metrics_columns!["source_identity":Text,"cost_nonnegative_requests":Integer,"cost_nonnegative":Decimal],
    },
    Source {
        name: "usage_cell_sample",
        version: 2,
        allowed: retained,
        load: load_sample,
        page: page_sample,
        columns: cell_columns!["metric":Integer,"value":Decimal,"generation_rate":Double,"count":Integer],
    },
    Source {
        name: "usage_cell_unpriced",
        version: 2,
        allowed: retained,
        load: load_unpriced,
        page: page_unpriced,
        columns: cell_columns!["context":Decimal,"requests":Integer,"input":Decimal,"output":Decimal,"reasoning":Decimal,"cache_read":Decimal,"cache_write":Decimal],
    },
    Source {
        name: "usage_cell_backfill",
        version: 2,
        allowed: retained,
        load: load_backfill,
        page: page_backfill,
        columns: columns!["family":Text,"after_key":Text,"complete":Boolean],
    },
    Source {
        name: "task",
        version: 1,
        allowed: retained,
        load: load_task,
        page: page_task,
        columns: columns!["session_id":Text, "parent_id":Text, "path_entry":Text],
    },
    Source {
        name: "session_provider_request",
        version: 3,
        allowed: retained,
        load: load_request,
        page: page_request,
        columns: columns!["session_id":Text, "source":Text, "agent":Text, "provider":Text, "model":Text, "variant":Text, "profile":Text, "model_key":Text,
            "request_order":Integer, "attempts":Integer, "continuation":Text, "cache_reported":Boolean, "cost":Double,
            "input":Double, "output":Double, "reasoning":Double, "cache_read":Double, "cache_write":Double, "time_created":Integer,
            "first_ms":Integer, "total_ms":Integer, "generated_tokens":Integer, "generation_ns":Integer, "provider_timed":Boolean,
            "provider_key":Text, "provider_model_key":Text, "provider_profile_model_key":Text, "model_id_key":Text, "profile_key":Text, "prompt_key":Text, "model_json":Text, "anchor_json":Text, "outcome":Text,
            "anchor_session_id":Text, "anchor_input_id":Text, "input_key":Text],
    },
    Source {
        name: "usage_analytics_request",
        version: 2,
        allowed: retained,
        load: load_usage_fact,
        page: page_usage_fact,
        columns: columns!["session_id":Text, "source":Text, "agent":Text, "provider":Text, "model":Text, "variant":Text, "profile":Text, "model_key":Text,
            "request_order":Integer, "attempts":Integer, "continuation":Text, "cache_reported":Boolean, "cost":Double,
            "input":Double, "output":Double, "reasoning":Double, "cache_read":Double, "cache_write":Double, "time_created":Integer,
            "first_ms":Integer, "total_ms":Integer, "generated_tokens":Integer, "generation_ns":Integer, "provider_timed":Boolean,
            "provider_key":Text, "provider_model_key":Text, "provider_profile_model_key":Text, "model_id_key":Text, "profile_key":Text, "prompt_key":Text, "model_json":Text, "anchor_json":Text, "outcome":Text,
            "project_id":Text, "directory":Text, "workspace_id":Text, "session_updated":Integer, "anchor_session_id":Text, "anchor_input_id":Text, "task_entries":Text],
    },
    Source {
        name: "session",
        version: 1,
        allowed: retained,
        load: load_session,
        page: page_session,
        columns: columns!["id":Text, "parent_id":Text, "title":Text, "project_id":Text, "directory":Text, "workspace_id":Text, "time_updated":Integer],
    },
    Source {
        name: "project",
        version: 1,
        allowed: retained,
        load: load_project,
        page: page_project,
        columns: columns!["id":Text, "name":Text, "worktree":Text],
    },
    Source {
        name: "session_usage",
        version: 1,
        allowed: retained,
        load: load_usage,
        page: page_usage,
        columns: columns!["session_id":Text, "model_key":Text, "logical":Integer],
    },
    Source {
        name: "telemetry_consent",
        version: 1,
        allowed: retained,
        load: load_consent,
        page: page_consent,
        columns: columns!["enabled":Boolean, "notice_version":Integer],
    },
    Source {
        name: "web_latency",
        version: 1,
        allowed: resources::telemetry_allowed,
        load: load_latency,
        page: page_latency,
        columns: columns!["id":Integer, "received_at":Integer, "kind":Text, "sampled_at":Text, "operation":Text, "outcome":Text, "reason":Text,
            "queue_ms":Integer, "settlement_ms":Integer, "total_ms":Integer, "surface":Text, "metric":Text, "duration_ms":Integer],
    },
];

pub fn value_number(value: &Value) -> Result<f64, Error> {
    match value {
        Value::Blob(value) => crate::Decimal::from_bytes(value)?.to_f64(),
        Value::Double(value) => Ok(*value),
        Value::BigInt(value) => Ok(*value as f64),
        Value::UBigInt(value) => Ok(*value as f64),
        Value::Int(value) => Ok(f64::from(*value)),
        Value::HugeInt(value) => Ok(*value as f64),
        _ => Err(Error::Rejected("invalid analytics numeric result")),
    }
}

pub fn value_text(value: &Value) -> Result<&str, Error> {
    match value {
        Value::Text(value) => Ok(value),
        _ => Err(Error::Rejected("invalid analytics text result")),
    }
}

pub fn metrics(row: &[Value]) -> Result<ycoding_schema::JsonValue, Error> {
    let value = |index| value_number(&row[index]);
    let priced = value(11)? > 0.0;
    let corrections = value(13)? > 0.0;
    let outcomes = if row.len() >= 17 && value(14)? + value(15)? + value(16)? > 0.0 {
        Some(
            ObjectEncoder::new()
                .field("completed", &value(14)?)
                .field("failed", &value(15)?)
                .field("cancelled", &value(16)?)
                .finish(),
        )
    } else {
        None
    };
    Ok(ObjectEncoder::new()
        .optional("outcomes", &outcomes)
        .field(
            "costCoverage",
            &ObjectEncoder::new()
                .field("pricedRequests", &value(11)?)
                .field("unpricedRequests", &(value(0)? - value(11)?))
                .finish(),
        )
        .field("logical", &value(0)?)
        .field("physical", &value(1)?)
        .field("helpers", &value(2)?)
        .field("continued", &value(3)?)
        .field("fallback", &value(4)?)
        .field(
            "tokens",
            &ObjectEncoder::new()
                .field("input", &value(5)?)
                .field("output", &value(6)?)
                .field("reasoning", &value(7)?)
                .field(
                    "cache",
                    &ObjectEncoder::new()
                        .field("read", &value(8)?)
                        .field("write", &value(9)?)
                        .finish(),
                )
                .finish(),
        )
        .optional("cost", &priced.then(|| value(10)).transpose()?)
        .optional(
            "costProvenance",
            &priced.then(|| {
                LosslessString::from(if corrections {
                    "current_catalog"
                } else {
                    "recorded"
                })
            }),
        )
        .optional(
            "cacheReadReported",
            &(value(0)? > 0.0).then(|| matches!(&row[12], Value::Boolean(true))),
        )
        .finish())
}

const LATENCY_FIELDS: &[&str] = &[
    "kind",
    "at",
    "operation",
    "outcome",
    "reason",
    "queueMs",
    "settlementMs",
    "totalMs",
    "surface",
    "metric",
    "durationMs",
];

pub fn latency_sample(values: &[Value]) -> Result<telemetry::Sample, Error> {
    use ycoding_schema::DomainDecode;
    let mut object = ObjectEncoder::new();
    for (field, value) in LATENCY_FIELDS.iter().zip(values) {
        if matches!(value, Value::Null) {
            continue;
        }
        object = match value {
            Value::Text(value) => object.field(field, &LosslessString::from(value.as_str())),
            _ => object.field(field, &value_number(value)?),
        };
    }
    telemetry::Sample::decode(&object.finish())
        .map_err(|error| Error::Record(Box::new(error)))
}
