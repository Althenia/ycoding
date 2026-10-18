use super::{key, projector::record_error, store::Service, usage};
use chrono::{DateTime, Offset, Utc};
use std::{
    collections::{BTreeMap, VecDeque},
    ops::Bound,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, model, provider_request,
    session, session_id::SessionId, session_message_id, token_usage, usage_anchor,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec,
    analytics::{Query, Value, reports},
    resources::{Request, UsageAnalyticsRequest, UsageAnalyticsRequestTable, requests},
    session::{Document, Session, SessionTable},
    tuple_key,
};

const PAGE: usize = 128;
const DEFAULT_LIMIT: usize = 100;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct PricingRef {
    pub directory: LosslessString,
    pub workspace_id: Option<LosslessString>,
    pub provider: LosslessString,
    pub model: LosslessString,
    pub profile: Option<LosslessString>,
}

#[derive(Clone)]
pub struct Pricing {
    pub provider: Vec<model::Cost>,
    pub router: Vec<model::Cost>,
}

pub type Pricer<'a> = Option<&'a dyn Fn(&PricingRef) -> Option<Pricing>>;

#[derive(Default)]
struct SummaryPrices {
    order: VecDeque<PricingRef>,
    values: BTreeMap<PricingRef, Option<Pricing>>,
}

impl Service {
    pub fn usage(
        &self,
        id: &session::Id,
        pricer: Pricer<'_>,
    ) -> Result<provider_request::Summary, Error> {
        let snapshot = self.client.snapshot()?;
        read_summary(&snapshot, Some(id), pricer)
    }

    pub fn usage_report(
        &self,
        id: &session::Id,
        input: &provider_request::ReportInput,
        pricer: Pricer<'_>,
    ) -> Result<provider_request::Report, Error> {
        analytics_report(&self.client, Some(id), input, pricer)
    }

    pub fn usage_all(&self, pricer: Pricer<'_>) -> Result<provider_request::Summary, Error> {
        let snapshot = self.client.snapshot()?;
        read_summary(&snapshot, None, pricer)
    }

    pub fn usage_report_all(
        &self,
        input: &provider_request::ReportInput,
        pricer: Pricer<'_>,
    ) -> Result<provider_request::Report, Error> {
        analytics_report(&self.client, None, input, pricer)
    }
}

fn analytics_error(error: ycoding_store::analytics::Error) -> Error {
    Error::Record(Box::new(error))
}

fn analytics_report(
    client: &ycoding_store::Client,
    id: Option<&session::Id>,
    input: &provider_request::ReportInput,
    pricer: Pricer<'_>,
) -> Result<provider_request::Report, Error> {
    let zone = zone(input)?;
    let mut snapshot = client.snapshot()?;
    let sessions = id.map(|id| family(&snapshot, id)).transpose()?;
    let prompts = sessions.is_some() && input.group.0.as_str() == Some("prompt");
    let mut hints = BTreeMap::<String, (LosslessString, LosslessString)>::new();
    let handle = client.analytics().map_err(analytics_error)?;
    let selection = vec![
        id.map(|id| Value::Text(text(id.as_lossless())))
            .unwrap_or(Value::Null),
        input
            .from
            .map(|value| Value::BigInt(value.get()))
            .unwrap_or(Value::Null),
        input
            .to
            .map(|value| Value::BigInt(value.get()))
            .unwrap_or(Value::Null),
    ];
    let mut prices = Vec::new();
    let mut resolved = std::collections::BTreeSet::new();
    let mut first = None::<i64>;
    let mut last = None::<i64>;
    let filters_model = input.provider_id.is_some()
        || input.model_id.is_some()
        || input.profile.is_some()
        || input.selected_effort.is_some();
    let mut observe = |_: Family, row: Row| -> Result<(), Error> {
        if filters_model {
            let model = row.model.domain()?;
            if input
                .provider_id
                .as_ref()
                .is_some_and(|value| value != &model.provider_id)
                || input
                    .model_id
                    .as_ref()
                    .is_some_and(|value| value != &model.id)
                || input
                    .profile
                    .as_ref()
                    .is_some_and(|value| Some(value) != model.profile.as_ref())
                || input
                    .selected_effort
                    .as_ref()
                    .is_some_and(|value| Some(value) != model.variant.as_ref())
            {
                return Ok(());
            }
        }
        if input.from.is_some_and(|from| row.time_created < from.get())
            || input.to.is_some_and(|to| row.time_created >= to.get())
        {
            return Ok(());
        }
        if prompts && let Some((session, input)) = &row.hint {
            hints.insert(
                ycoding_schema::stringify_json(&JsonValue::Array(vec![
                    session.encode(),
                    input.encode(),
                ])),
                (session.clone(), input.clone()),
            );
        }
        first = Some(first.map_or(row.time_created, |time| time.min(row.time_created)));
        last = Some(last.map_or(row.time_created, |time| time.max(row.time_created)));
        if let Some(pricer) = pricer
            && row.cost.is_none()
            && row.source.as_str() != Some("decision")
        {
            let model = row.model.domain()?;
            let reference = pricing_ref(&row, &model);
            let identity = price_identity(&reference);
            if resolved.insert(identity.clone())
                && let Some(pricing) = pricer(&reference)
            {
                for (priority, costs) in [pricing.provider, pricing.router].into_iter().enumerate()
                {
                    for (ordinal, cost) in costs.into_iter().enumerate() {
                        prices.push(format!(
                            "{identity}|{priority}|{}|{ordinal}|{}|{}|{}|{}",
                            cost.tier
                                .map_or("~".to_string(), |tier| tier.size.get().to_string()),
                            cost.input.get(),
                            cost.output.get(),
                            cost.cache.read.get(),
                            cost.cache.write.get()
                        ));
                    }
                }
            }
        }
        Ok(())
    };
    match &sessions {
        Some(sessions) => scan(&snapshot, sessions, &mut observe)?,
        None => scan_facts(
            &snapshot,
            input.from.map(|value| value.get()),
            input.to.map(|value| value.get()),
            &mut observe,
        )?,
    }
    let mut resolved_hints = Vec::new();
    for (lookup, (session, input)) in hints {
        let session_id = SessionId::new(session).map_err(record_error)?;
        let input_id = session_message_id::Id::new(input).map_err(record_error)?;
        if let Some(anchor) = super::usage_attribution::resolve(
            &mut snapshot,
            &usage_anchor::Ref {
                session_id,
                input_id,
            },
        )? {
            let anchor_session = lossy(anchor.session_id.as_lossless());
            let anchor_input = lossy(anchor.input_id.as_lossless());
            let key = ycoding_schema::stringify_json(&JsonValue::Array(vec![
                LosslessString::from("prompt").encode(),
                anchor.session_id.as_lossless().encode(),
                anchor.input_id.as_lossless().encode(),
            ]));
            resolved_hints.push(
                [
                    lookup,
                    anchor_session,
                    anchor_input,
                    key,
                    ycoding_schema::stringify_json(&anchor.encode()),
                ]
                .map(|part| hex(&part))
                .join("|"),
            );
        }
        std::thread::yield_now();
    }
    let offsets = time_zone_offsets(zone.as_ref(), first.zip(last))?;
    let offset = input.offset.map_or(0, |value| value.get());
    let limit = input
        .limit
        .map_or(DEFAULT_LIMIT as i64, |value| value.get());
    let mut parameters: Vec<Value> = selection
        .into_iter()
        .chain([
            Value::Text(text(&input.group.0)),
            Value::Text(
                input
                    .sort
                    .as_ref()
                    .map_or("key", |value| sort_name(&value.0))
                    .into(),
            ),
            Value::Boolean(
                input
                    .order
                    .as_ref()
                    .is_some_and(|value| value.0.as_str() == Some("desc")),
            ),
            Value::BigInt(offset),
            Value::BigInt(limit),
            Value::Text(offsets.join(";")),
            Value::Text(prices.join(";")),
            input
                .provider_id
                .as_ref()
                .map(|value| Value::Text(text(&value.0)))
                .unwrap_or(Value::Null),
            input
                .model_id
                .as_ref()
                .map(|value| Value::Text(text(value)))
                .unwrap_or(Value::Null),
            input
                .profile
                .as_ref()
                .map(|value| Value::Text(text(&value.0)))
                .unwrap_or(Value::Null),
            input
                .selected_effort
                .as_ref()
                .map(|value| Value::Text(text(value)))
                .unwrap_or(Value::Null),
        ])
        .collect();
    if sessions.is_some() {
        parameters.push(Value::Text(resolved_hints.join(";")));
    }
    let mut result = handle
        .report_snapshot(
            snapshot,
            if sessions.is_some() {
                &["session", "project", "session_provider_request", "task"]
            } else {
                &["usage_analytics_request", "session", "project"]
            },
            vec![Query {
                sql: if sessions.is_some() {
                    concat!(
                        include_str!("usage_report_ledger.sql"),
                        include_str!("usage_report_tail.sql")
                    )
                } else {
                    concat!(
                        include_str!("usage_report_facts.sql"),
                        include_str!("usage_report_tail.sql")
                    )
                },
                parameters,
                max_rows: limit as usize + 1,
            }],
        )
        .map_err(analytics_error)?;
    let mut result = result.remove(0).into_iter();
    let total = result
        .next()
        .ok_or(Error::Rejected("missing usage totals"))?;
    let count = reports::value_number(&total[25])?;
    let rows = result
        .map(|row| {
            let mut object = ObjectEncoder::new()
                .field("key", &LosslessString::from(reports::value_text(&row[1])?))
                .field(
                    "label",
                    &LosslessString::from(reports::value_text(&row[2])?),
                );
            let json = |index| -> Result<Option<JsonValue>, Error> {
                if matches!(row[index], Value::Null) {
                    return Ok(None);
                }
                ycoding_schema::parse_json(reports::value_text(&row[index])?)
                    .map(Some)
                    .map_err(|error| Error::Record(Box::new(error)))
            };
            let model = model::Ref::decode(
                &json(31)?.ok_or(Error::Rejected("missing report model identity"))?,
            )
            .map_err(record_error)?;
            let dimensions = ObjectEncoder::new().field("group", &input.group);
            let dimensions = match input.group.0.as_str() {
                Some("model") => {
                    object = object.field("model", &model);
                    None
                }
                Some("provider") => Some(dimensions.field("providerID", &model.provider_id)),
                Some("provider-model") => Some(
                    dimensions
                        .field("providerID", &model.provider_id)
                        .field("modelID", &model.id),
                ),
                Some("provider-profile-model" | "profile") => {
                    let dimensions = dimensions
                        .field("providerID", &model.provider_id)
                        .optional("profile", &model.profile)
                        .field(
                            "profileState",
                            &LosslessString::from(if model.profile.is_some() {
                                "recorded"
                            } else {
                                "provider-default"
                            }),
                        );
                    Some(
                        if input.group.0.as_str() == Some("provider-profile-model") {
                            dimensions.field("modelID", &model.id)
                        } else {
                            dimensions
                        },
                    )
                }
                Some("model-id") => Some(dimensions.field("modelID", &model.id)),
                Some("prompt") => {
                    let anchor = json(32)?;
                    Some(dimensions.optional("anchor", &anchor).field(
                        "attribution",
                        &LosslessString::from(if anchor.is_some() {
                            "complete"
                        } else {
                            "unattributed"
                        }),
                    ))
                }
                Some("task") => {
                    let session = json(33)?;
                    Some(dimensions.optional("sessionID", &session).field(
                        "attribution",
                        &LosslessString::from(if session.is_some() {
                            "complete"
                        } else {
                            "unattributed"
                        }),
                    ))
                }
                _ => None,
            };
            if let Some(dimensions) = dimensions {
                object = object.field("dimensions", &dimensions.finish());
            }
            let JsonValue::Object(metrics) = reports::metrics(&row[3..17])? else {
                return Err(Error::Rejected("invalid usage metrics"));
            };
            for (key, value) in metrics.iter() {
                object = object.field(
                    key.as_str().ok_or(Error::Rejected("invalid metric key"))?,
                    value,
                );
            }
            let value = |index| reports::value_number(&row[index]);
            if value(17)? > 0.0 || value(18)? > 0.0 || value(24)? > 0.0 {
                object = object.field(
                    "speed",
                    &ObjectEncoder::new()
                        .field("generationSamples", &value(26)?)
                        .field("providerTimedSamples", &value(27)?)
                        .field("observedSamples", &value(28)?)
                        .optional(
                            "generationP50TokensPerSecond",
                            &(!matches!(row[29], Value::Null))
                                .then(|| value(29))
                                .transpose()?,
                        )
                        .optional(
                            "generationP90TokensPerSecond",
                            &(!matches!(row[30], Value::Null))
                                .then(|| value(30))
                                .transpose()?,
                        )
                        .optional(
                            "firstOutputP50Ms",
                            &(!matches!(row[19], Value::Null))
                                .then(|| value(19))
                                .transpose()?,
                        )
                        .optional(
                            "firstOutputP95Ms",
                            &(!matches!(row[20], Value::Null))
                                .then(|| value(20))
                                .transpose()?,
                        )
                        .optional(
                            "totalP50Ms",
                            &(!matches!(row[21], Value::Null))
                                .then(|| value(21))
                                .transpose()?,
                        )
                        .optional(
                            "totalP95Ms",
                            &(!matches!(row[22], Value::Null))
                                .then(|| value(22))
                                .transpose()?,
                        )
                        .optional(
                            "outputTokensPerSecond",
                            &(value(24)? > 0.0)
                                .then(|| Ok::<_, Error>(value(23)? / (value(24)? / 1e9)))
                                .transpose()?,
                        )
                        .field("samples", &value(17)?)
                        .finish(),
                );
            }
            Ok(object.finish())
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let next = (((offset as usize + rows.len()) as f64) < count)
        .then(|| (offset as usize + rows.len()) as f64);
    provider_request::Report::decode(
        &ObjectEncoder::new()
            .field("group", &input.group)
            .field("rows", &JsonValue::Array(rows))
            .field("total", &reports::metrics(&total[3..17])?)
            .field("rowCount", &count)
            .optional("nextOffset", &next)
            .finish(),
    )
    .map_err(record_error)
}

fn offset_label(seconds: i32) -> String {
    let absolute = seconds.unsigned_abs();
    format!(
        "{}{:02}:{:02}{}",
        if seconds < 0 { '-' } else { '+' },
        absolute / 3600,
        absolute / 60 % 60,
        if absolute.is_multiple_of(60) {
            String::new()
        } else {
            format!(":{:02}", absolute % 60)
        }
    )
}

fn time_zone_offsets(zone: Option<&Zone>, range: Option<(i64, i64)>) -> Result<Vec<String>, Error> {
    let Some(zone) = zone else {
        return Ok(Vec::new());
    };
    if let Zone::Fixed(seconds) = zone {
        return Ok(vec![format!(
            "{}|{seconds}|{}",
            i64::MIN,
            offset_label(*seconds)
        )]);
    }
    let Zone::Iana(zone) = zone else {
        unreachable!()
    };
    let Some((first, last)) = range else {
        return Ok(Vec::new());
    };
    let offset = |time| {
        DateTime::<Utc>::from_timestamp_millis(time)
            .map(|utc| utc.with_timezone(zone).offset().fix().local_minus_utc())
            .ok_or(Error::Rejected("invalid usage time"))
    };
    let mut seconds = offset(first)?;
    let mut result = vec![format!("{first}|{seconds}|{}", offset_label(seconds))];
    let mut start = first;
    while start < last {
        let end = start.saturating_add(86_400_000).min(last);
        if offset(end)? == seconds {
            start = end;
            std::thread::yield_now();
            continue;
        }
        let mut before = start;
        let mut after = end;
        while after - before > 1 {
            let middle = before + (after - before) / 2;
            if offset(middle)? == seconds {
                before = middle;
            } else {
                after = middle;
            }
        }
        seconds = offset(after)?;
        result.push(format!("{after}|{seconds}|{}", offset_label(seconds)));
        start = after;
        std::thread::yield_now();
    }
    Ok(result)
}

fn pricing_ref(row: &Row, model: &model::Ref) -> PricingRef {
    PricingRef {
        directory: row.directory.clone(),
        workspace_id: row.workspace_id.clone(),
        provider: model.provider_id.0.clone(),
        model: model.id.clone(),
        profile: model.profile.as_ref().map(|profile| profile.0.clone()),
    }
}

fn price_identity(reference: &PricingRef) -> String {
    [
        Some(&reference.directory),
        reference.workspace_id.as_ref(),
        Some(&reference.provider),
        Some(&reference.model),
        reference.profile.as_ref(),
    ]
    .into_iter()
    .map(|value| {
        value.map_or_else(
            || "~".to_string(),
            |value| {
                value
                    .to_utf8()
                    .unwrap_or_else(|_| {
                        String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
                    })
                    .bytes()
                    .map(|byte| format!("{byte:02X}"))
                    .collect()
            },
        )
    })
    .collect::<Vec<_>>()
    .join(":")
}

enum Zone {
    Fixed(i32),
    Iana(chrono_tz::Tz),
}

type Family = (i64, String);

struct Row {
    hint: Option<(LosslessString, LosslessString)>,
    directory: LosslessString,
    workspace_id: Option<LosslessString>,
    source: LosslessString,
    attempts: i64,
    continuation: LosslessString,
    cache_read_reported: Option<i64>,
    timing: Option<Document<provider_request::Timing>>,
    cost: Option<f64>,
    tokens: Document<token_usage::Info>,
    model: Document<model::Ref>,
    time_created: i64,
    request: i64,
    invalidation: LosslessString,
    prompt_cache_key: LosslessString,
}

impl Row {
    fn ledger(session: &Session, row: Request) -> Self {
        Self {
            hint: row
                .usage_anchor
                .is_none()
                .then(|| row.input_id.clone())
                .flatten()
                .map(|input| (row.session_id.clone(), input)),
            directory: session.directory.clone(),
            workspace_id: session.workspace_id.clone(),
            source: row.source,
            attempts: row.attempts,
            continuation: row.continuation,
            cache_read_reported: row.cache_read_reported,
            timing: row.timing,
            cost: row.cost,
            tokens: row.tokens,
            model: row.model,
            time_created: row.time_created,
            request: row.request,
            invalidation: row.invalidation,
            prompt_cache_key: row.prompt_cache_key,
        }
    }

    fn fact(row: UsageAnalyticsRequest) -> (Family, Self) {
        (
            (row.session_updated, text(&row.session_id)),
            Self {
                hint: None,
                directory: row.directory,
                workspace_id: row.workspace_id,
                source: row.source,
                attempts: row.attempts,
                continuation: row.continuation,
                cache_read_reported: row.cache_read_reported,
                timing: row.timing,
                cost: row.cost,
                tokens: row.tokens,
                model: row.model,
                time_created: row.time_created,
                request: row.request,
                invalidation: row.invalidation,
                prompt_cache_key: row.prompt_cache_key,
            },
        )
    }
}

struct Sample {
    family: Family,
    model: model::Ref,
    step: bool,
    attempts: i64,
    continued: bool,
    fallback: bool,
    reported: bool,
    timing: Option<provider_request::Timing>,
    cost: Option<f64>,
    estimate: Option<f64>,
    tokens: token_usage::Info,
    time: i64,
    request: i64,
    invalidation: LosslessString,
    namespace: String,
}

#[derive(Default)]
struct Acc {
    logical: u64,
    physical: u64,
    helpers: u64,
    continued: u64,
    fallback: u64,
    input: Sum,
    output: Sum,
    reasoning: Sum,
    read: Sum,
    write: Sum,
    cost: Sum,
    priced: u64,
    correction: Option<f64>,
    unreported: bool,
}

impl Acc {
    fn add(&mut self, sample: &Sample) {
        self.logical += 1;
        self.physical += sample.attempts as u64;
        self.helpers += u64::from(!sample.step);
        self.continued += u64::from(sample.continued);
        self.fallback += u64::from(sample.fallback);
        self.input.add(sample.tokens.input.get());
        self.output.add(sample.tokens.output.get());
        self.reasoning.add(sample.tokens.reasoning.get());
        self.read.add(sample.tokens.cache.read.get());
        self.write.add(sample.tokens.cache.write.get());
        if let Some(cost) = sample.cost {
            self.cost.add(cost);
            self.priced += 1;
        }
        if let Some(estimate) = sample.estimate {
            self.correction = Some(self.correction.unwrap_or(0.0) + estimate);
        }
        self.unreported |= !sample.reported;
    }

    fn priced(&self) -> bool {
        self.priced > 0 || self.correction.is_some()
    }

    fn cost(&self) -> f64 {
        self.cost.get() + self.correction.unwrap_or(0.0)
    }

    fn tokens(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("input", &self.input.get())
            .field("output", &self.output.get())
            .field("reasoning", &self.reasoning.get())
            .field(
                "cache",
                &ObjectEncoder::new()
                    .field("read", &self.read.get())
                    .field("write", &self.write.get())
                    .finish(),
            )
            .finish()
    }

    fn provenance(&self) -> LosslessString {
        LosslessString::from(if self.correction.is_some() {
            "current_catalog"
        } else {
            "recorded"
        })
    }

    fn cache_read_reported(&self) -> Option<bool> {
        (self.logical > 0).then_some(!self.unreported)
    }

    fn metrics(&self, encoder: ObjectEncoder) -> ObjectEncoder {
        encoder
            .field("logical", &(self.logical as f64))
            .field("physical", &(self.physical as f64))
            .field("helpers", &(self.helpers as f64))
            .field("continued", &(self.continued as f64))
            .field("fallback", &(self.fallback as f64))
            .field("tokens", &self.tokens())
            .optional("cost", &self.priced().then(|| self.cost()))
            .optional("costProvenance", &self.priced().then(|| self.provenance()))
            .optional("cacheReadReported", &self.cache_read_reported())
    }
}

#[derive(Default)]
struct Sum {
    value: f64,
    error: f64,
}

impl Sum {
    fn add(&mut self, value: f64) {
        let next = self.value + value;
        self.error += if self.value.abs() > value.abs() {
            (self.value - next) + value
        } else {
            (value - next) + self.value
        };
        self.value = next;
    }

    fn get(&self) -> f64 {
        if self.value.is_infinite() {
            return self.value;
        }
        self.value + self.error
    }
}

fn scan(
    snapshot: &Snapshot,
    sessions: &[Session],
    visit: &mut dyn FnMut(Family, Row) -> Result<(), Error>,
) -> Result<(), Error> {
    for (index, session) in sessions.iter().enumerate() {
        let mut after = None;
        loop {
            let page = requests(
                snapshot,
                &session.id,
                IndexOrder::Ascending,
                after.as_ref(),
                PAGE,
            )?;
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.cursor.clone());
            for entry in page {
                visit(
                    (index as i64, String::new()),
                    Row::ledger(session, entry.record),
                )?;
            }
            std::thread::yield_now();
        }
    }
    Ok(())
}

fn scan_facts(
    snapshot: &Snapshot,
    from: Option<i64>,
    to: Option<i64>,
    visit: &mut dyn FnMut(Family, Row) -> Result<(), Error>,
) -> Result<(), Error> {
    let lower = from.map(|time| tuple_key(&[KeyPart::I64(time)]));
    let upper = to.map(|time| tuple_key(&[KeyPart::I64(time)]));
    let mut after = None;
    loop {
        let page = snapshot.index_range::<UsageAnalyticsRequestTable>(
            "usage_analytics_request_time_created_id_idx",
            IndexQuery {
                lower: lower.as_deref().map_or(Bound::Unbounded, Bound::Included),
                upper: upper.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                prefix: None,
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: PAGE,
            },
        )?;
        let Some(last) = page.last() else {
            break;
        };
        after = Some(last.cursor.clone());
        for entry in page {
            let (family, row) = Row::fact(entry.record);
            visit(family, row)?;
        }
        std::thread::yield_now();
    }
    Ok(())
}

fn family(snapshot: &Snapshot, id: &session::Id) -> Result<Vec<Session>, Error> {
    let Some(root) = snapshot.get::<SessionTable>(&key(id.as_lossless()))? else {
        return Err(Error::Domain {
            kind: "not_found",
            message: "Session not found",
        });
    };
    let mut sessions = vec![root];
    if sessions[0].parent_id.is_some() {
        return Ok(sessions);
    }
    let mut current = 0;
    while current < sessions.len() {
        let mut children = Vec::new();
        let mut after = None;
        loop {
            let page = snapshot.index::<SessionTable>(
                "session_parent_idx",
                &tuple_key(&[KeyPart::String(&sessions[current].id)]),
                after.as_deref(),
                PAGE,
            )?;
            let Some(last) = page.last() else { break };
            after = Some(SessionTable::primary_key(last));
            children.extend(page);
            std::thread::yield_now();
        }
        children.sort_by(|left, right| {
            right
                .time_updated
                .cmp(&left.time_updated)
                .then_with(|| text(&right.id).cmp(&text(&left.id)))
        });
        for child in children {
            if sessions.iter().all(|seen| seen.id != child.id) {
                sessions.push(child);
            }
        }
        current += 1;
    }
    Ok(sessions)
}

fn sample(
    family: Family,
    row: Row,
    pricer: Pricer<'_>,
    prices: &mut SummaryPrices,
) -> Result<Sample, Error> {
    let model = row.model.domain()?;
    let tokens = row.tokens.domain()?;
    let estimate = match pricer {
        Some(pricer) if row.cost.is_none() && row.source.as_str() != Some("decision") => {
            let reference = pricing_ref(&row, &model);
            if !prices.values.contains_key(&reference) {
                if prices.order.len() == 256
                    && let Some(expired) = prices.order.pop_front()
                {
                    prices.values.remove(&expired);
                }
                let pricing = pricer(&reference);
                prices.order.push_back(reference.clone());
                prices.values.insert(reference.clone(), pricing);
            }
            let pricing = prices.values.get(&reference).and_then(Option::as_ref);
            pricing.and_then(|pricing| {
                let encoded = tokens.encode();
                usage::estimated_cost(&pricing.provider, &encoded, None)
                    .or_else(|| usage::estimated_cost(&pricing.router, &encoded, None))
            })
        }
        _ => None,
    };
    Ok(Sample {
        family,
        model,
        step: row.source.as_str() == Some("step"),
        attempts: row.attempts,
        continued: row.continuation.as_str() == Some("continued"),
        fallback: row.continuation.as_str() == Some("fallback"),
        reported: row.cache_read_reported == Some(1),
        timing: row.timing.map(|timing| timing.domain()).transpose()?,
        cost: row.cost,
        estimate,
        tokens,
        time: row.time_created,
        request: row.request,
        invalidation: row.invalidation,
        namespace: text(&row.prompt_cache_key).chars().take(8).collect(),
    })
}

fn read_summary(
    snapshot: &Snapshot,
    id: Option<&session::Id>,
    pricer: Pricer<'_>,
) -> Result<provider_request::Summary, Error> {
    let mut total = Acc::default();
    let mut groups: BTreeMap<String, (model::Ref, Acc)> = BTreeMap::new();
    let mut latest = None::<Sample>;
    let mut prices = SummaryPrices::default();
    let mut observe = |family: Family, row: Row| -> Result<(), Error> {
        let sample = sample(family, row, pricer, &mut prices)?;
        total.add(&sample);
        let identity = format!(
            "{:?}",
            (
                text(&sample.model.provider_id.0),
                text(&sample.model.id),
                sample.model.variant.as_ref().map(text),
                sample
                    .model
                    .profile
                    .as_ref()
                    .map(|profile| text(&profile.0)),
            )
        );
        groups
            .entry(identity)
            .or_insert_with(|| (sample.model.clone(), Acc::default()))
            .1
            .add(&sample);
        if latest.as_ref().is_none_or(|latest| {
            (sample.time, &sample.family, sample.request)
                > (latest.time, &latest.family, latest.request)
        }) {
            latest = Some(sample);
        }
        Ok(())
    };
    match id {
        Some(id) => scan(snapshot, &family(snapshot, id)?, &mut observe)?,
        None => scan_facts(snapshot, None, None, &mut observe)?,
    }
    let mut models = groups.into_values().collect::<Vec<_>>();
    models.sort_by(|(left_model, left), (right_model, right)| {
        right
            .priced()
            .then(|| right.cost())
            .partial_cmp(&left.priced().then(|| left.cost()))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| model_order(left_model).cmp(&model_order(right_model)))
    });
    let latest = latest.as_ref();
    let value = total
        .metrics(ObjectEncoder::new())
        .optional(
            "models",
            &(!models.is_empty()).then(|| {
                JsonValue::Array(
                    models
                        .iter()
                        .map(|(model, group)| {
                            ObjectEncoder::new()
                                .field("model", model)
                                .field("requests", &(group.logical as f64))
                                .field("tokens", &group.tokens())
                                .optional("cacheReadReported", &group.cache_read_reported())
                                .optional("cost", &group.priced().then(|| group.cost()))
                                .optional(
                                    "costProvenance",
                                    &group.priced().then(|| group.provenance()),
                                )
                                .finish()
                        })
                        .collect(),
                )
            }),
        )
        .optional(
            "latestInvalidation",
            &latest.map(|sample| sample.invalidation.clone()),
        )
        .optional(
            "latestNamespace",
            &latest.map(|sample| LosslessString::from(sample.namespace.as_str())),
        )
        .optional(
            "latestTiming",
            &latest
                .and_then(|sample| sample.timing.as_ref())
                .map(DomainEncode::encode),
        )
        .finish();
    provider_request::Summary::decode(&value).map_err(record_error)
}

fn model_order(model: &model::Ref) -> (String, String, String, String) {
    (
        text(&model.provider_id.0),
        text(&model.id),
        model.variant.as_ref().map(text).unwrap_or_default(),
        model
            .profile
            .as_ref()
            .map(|profile| text(&profile.0))
            .unwrap_or_default(),
    )
}

fn sort_name(sort: &LosslessString) -> &str {
    match sort.as_str() {
        Some("tokens") => "tokens",
        Some("cost") => "cost",
        Some("steps") => "steps",
        Some("input") => "input",
        Some("output") => "output",
        Some("reasoning") => "reasoning",
        Some("cacheRead") => "cacheRead",
        Some("cacheWrite") => "cacheWrite",
        _ => "key",
    }
}

fn zone(input: &provider_request::ReportInput) -> Result<Option<Zone>, Error> {
    let Some(requested) = &input.time_zone else {
        return Ok(None);
    };
    let name = text(requested);
    if ["CST6CDT", "EST5EDT", "MST7MDT", "PST8PDT"]
        .iter()
        .any(|zone| zone.eq_ignore_ascii_case(&name))
    {
        return Err(Error::Rejected("Invalid IANA time zone"));
    }
    fixed_offset(&name)
        .or_else(|| {
            chrono_tz::TZ_VARIANTS
                .iter()
                .find(|zone| zone.name().eq_ignore_ascii_case(&name))
                .copied()
                .map(Zone::Iana)
        })
        .map(Some)
        .ok_or(Error::Rejected("Invalid IANA time zone"))
}

fn fixed_offset(name: &str) -> Option<Zone> {
    let sign = match name.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let offset = &name[1..];
    let (hours, minutes) = offset.split_once(':').unwrap_or_else(|| {
        if offset.len() == 4 && offset.is_ascii() {
            (&offset[..2], &offset[2..])
        } else {
            (offset, "00")
        }
    });
    let valid = |part: &str| part.len() == 2 && part.chars().all(|digit| digit.is_ascii_digit());
    if !valid(hours) || !valid(minutes) {
        return None;
    }
    let (hours, minutes) = (hours.parse::<i64>().ok()?, minutes.parse::<i64>().ok()?);
    (hours <= 23 && minutes <= 59)
        .then(|| Zone::Fixed((sign * (hours * 3600 + minutes * 60)) as i32))
}

fn lossy(value: &LosslessString) -> String {
    value
        .to_utf8()
        .unwrap_or_else(|_| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()))
}

fn hex(value: &str) -> String {
    value.bytes().map(|byte| format!("{byte:02x}")).collect()
}

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fact_discovery_visits_only_half_open_time_bounds_across_equal_timestamp_pages() {
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core),
            ycoding_store::Metadata::new([79; 16], 1),
        )
        .unwrap();
        store
            .submit(|tx| {
                for index in 0..405 {
                    UsageAnalyticsRequestTable::insert(
                        tx,
                        &UsageAnalyticsRequest {
                            id: format!("prq_{:04}", 404 - index).into(),
                            session_id: "ses_report".into(),
                            project_id: "prj_report".into(),
                            directory: "/project".into(),
                            workspace_id: None,
                            session_updated: 1,
                            agent: "build".into(),
                            source: "step".into(),
                            model: Document::new(ycoding_schema::parse_json(
                                r#"{"providerID":"openai","id":"model"}"#,
                            ).unwrap())?,
                            usage_anchor: None,
                            task_path: Document::new(JsonValue::Array(vec![]))?,
                            request: index,
                            attempts: 1,
                            continuation: "full".into(),
                            invalidation: "none".into(),
                            prompt_cache_key: "cache".into(),
                            cache_read_reported: None,
                            tokens: Document::new(ycoding_schema::parse_json(
                                r#"{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#,
                            ).unwrap())?,
                            cost: Some(0.0),
                            timing: None,
                            time_created: match index {
                                0 => 99,
                                404 => 101,
                                _ => 100,
                            },
                        },
                    )?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let snapshot = store.client().snapshot().unwrap();
        for (from, to, expected) in [
            (Some(100), Some(101), 403),
            (Some(101), None, 1),
            (None, Some(100), 1),
            (None, None, 405),
            (Some(101), Some(100), 0),
        ] {
            let mut visited = Vec::new();
            scan_facts(&snapshot, from, to, &mut |_, row| {
                assert!(from.is_none_or(|lower| row.time_created >= lower));
                assert!(to.is_none_or(|upper| row.time_created < upper));
                visited.push(row.request);
                Ok(())
            })
            .unwrap();
            assert_eq!(visited.len(), expected);
            visited.sort();
            visited.dedup();
            assert_eq!(
                visited.len(),
                expected,
                "page cursors must not revisit a request"
            );
        }
    }
}
