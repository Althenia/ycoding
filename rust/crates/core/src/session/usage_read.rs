use super::{key, projector::record_error, store::Service, usage};
use chrono::{DateTime, Offset, Utc};
use std::{
    collections::{BTreeMap, VecDeque},
    ops::Bound,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, model, provider_request,
    session, token_usage,
};
use ycoding_store::{
    Error, IndexOrder, KeyPart, Snapshot, TableSpec,
    analytics::{Query, Value, reports},
    resources::{Request, requests},
    session::{Session, SessionTable},
    tuple_key,
};

const PAGE: usize = 128;
const DEFAULT_LIMIT: usize = 100;

#[derive(Clone, PartialEq, Eq)]
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
    let snapshot = client.snapshot()?;
    let sessions = match id {
        Some(id) => family(&snapshot, id)?,
        None => all_sessions(&snapshot)?,
    };
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
    scan(&snapshot, &sessions, |_, session, row| {
        if input.from.is_some_and(|from| row.time_created < from.get())
            || input.to.is_some_and(|to| row.time_created >= to.get())
        {
            return Ok(());
        }
        first = Some(first.map_or(row.time_created, |time| time.min(row.time_created)));
        last = Some(last.map_or(row.time_created, |time| time.max(row.time_created)));
        if let Some(pricer) = pricer
            && row.cost.is_none()
            && row.source.as_str() != Some("decision")
        {
            let model = row.model.domain()?;
            let reference = pricing_ref(session, &model);
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
    })?;
    let offsets = time_zone_offsets(zone.as_ref(), first.zip(last))?;
    let offset = input.offset.map_or(0, |value| value.get());
    let limit = input
        .limit
        .map_or(DEFAULT_LIMIT as i64, |value| value.get());
    let parameters = selection
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
        ])
        .collect();
    let mut result = handle
        .report_snapshot(
            snapshot,
            &["session", "project", "session_provider_request"],
            vec![Query {
                sql: include_str!("usage_report.sql"),
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

fn pricing_ref(session: &Session, model: &model::Ref) -> PricingRef {
    PricingRef {
        directory: session.directory.clone(),
        workspace_id: session.workspace_id.clone(),
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

struct Sample {
    family: usize,
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
    mut visit: impl FnMut(usize, &Session, Request) -> Result<(), Error>,
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
                let row = entry.record;
                visit(index, session, row)?;
            }
            std::thread::yield_now();
        }
    }
    Ok(())
}

fn all_sessions(snapshot: &Snapshot) -> Result<Vec<Session>, Error> {
    let mut sessions = Vec::new();
    let mut cursor = None;
    loop {
        let page = snapshot.scan::<SessionTable>(
            cursor.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            PAGE,
        )?;
        let Some(last) = page.last() else {
            break;
        };
        cursor = Some(SessionTable::primary_key(last));
        sessions.extend(page);
        std::thread::yield_now();
    }
    sessions.sort_by(|left, right| {
        left.time_updated
            .cmp(&right.time_updated)
            .then_with(|| text(&left.id).cmp(&text(&right.id)))
    });
    Ok(sessions)
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
    family: usize,
    session: &Session,
    row: Request,
    pricer: Pricer<'_>,
    prices: &mut VecDeque<(PricingRef, Option<Pricing>)>,
) -> Result<Sample, Error> {
    let model = row.model.domain()?;
    let tokens = row.tokens.domain()?;
    let estimate = match pricer {
        Some(pricer) if row.cost.is_none() && row.source.as_str() != Some("decision") => {
            let reference = pricing_ref(session, &model);
            if !prices.iter().any(|(key, _)| key == &reference) {
                if prices.len() == 256 {
                    prices.pop_front();
                }
                let pricing = pricer(&reference);
                prices.push_back((reference.clone(), pricing));
            }
            let pricing = prices
                .iter()
                .find(|(key, _)| key == &reference)
                .and_then(|(_, value)| value.as_ref());
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
    let sessions = match id {
        Some(id) => family(snapshot, id)?,
        None => all_sessions(snapshot)?,
    };
    let mut total = Acc::default();
    let mut groups: BTreeMap<String, (model::Ref, Acc)> = BTreeMap::new();
    let mut latest = None::<Sample>;
    let mut prices = VecDeque::new();
    scan(snapshot, &sessions, |index, session, row| {
        let sample = sample(index, session, row, pricer, &mut prices)?;
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
            (sample.time, sample.family, sample.request)
                > (latest.time, latest.family, latest.request)
        }) {
            latest = Some(sample);
        }
        Ok(())
    })?;
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

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap_or_default()
}
