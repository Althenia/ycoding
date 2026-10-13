use super::{key, projector::record_error, store::Service, usage};
use chrono::{DateTime, Offset, Utc};
use std::{
    collections::{BTreeMap, HashMap},
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

pub struct PricingRef {
    pub directory: LosslessString,
    pub workspace_id: Option<LosslessString>,
    pub provider: LosslessString,
    pub model: LosslessString,
    pub profile: Option<LosslessString>,
}

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
        let (_, samples) = load(&snapshot, Some(id), None, None, pricer)?;
        provider_request::Summary::decode(&summary(&samples)).map_err(record_error)
    }

    pub fn usage_report(
        &self,
        id: &session::Id,
        input: &provider_request::ReportInput,
        pricer: Pricer<'_>,
    ) -> Result<provider_request::Report, Error> {
        self.client
            .snapshot()?
            .get::<SessionTable>(&key(id.as_lossless()))?
            .ok_or(Error::Domain {
                kind: "not_found",
                message: "Session not found",
            })?;
        analytics_report(&self.client, Some(id), input, pricer)
    }

    pub fn usage_all(&self, pricer: Pricer<'_>) -> Result<provider_request::Summary, Error> {
        let snapshot = self.client.snapshot()?;
        let (_, samples) = load(&snapshot, None, None, None, pricer)?;
        provider_request::Summary::decode(&summary(&samples)).map_err(record_error)
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

const CHECKPOINT: &str = "SELECT source_order FROM analytics_checkpoint";
const PRICING_REFS: &str = "WITH RECURSIVE family(id) AS (
    SELECT id FROM session WHERE id = $1 UNION SELECT s.id FROM session s JOIN family f ON s.parent_id = f.id
    WHERE EXISTS (SELECT 1 FROM session WHERE id = $1 AND parent_id IS NULL))
    SELECT DISTINCT s.directory, s.workspace_id, r.provider, r.model, r.profile,
        hex(s.directory) || ':' || coalesce(hex(s.workspace_id), '~') || ':' || hex(r.provider) || ':' || hex(r.model) || ':' || coalesce(hex(r.profile), '~') AS reference
    FROM session_provider_request r JOIN session s ON s.id = r.session_id
    WHERE ($1 IS NULL OR s.id IN (SELECT id FROM family)) AND ($2 IS NULL OR r.time_created >= $2) AND ($3 IS NULL OR r.time_created < $3)
        AND r.cost IS NULL AND r.source <> 'decision'
    GROUP BY ALL HAVING ($4 IS NULL OR reference > $4) ORDER BY reference LIMIT 200";
const TIMES: &str = "WITH RECURSIVE family(id) AS (
    SELECT id FROM session WHERE id = $1 UNION SELECT s.id FROM session s JOIN family f ON s.parent_id = f.id
    WHERE EXISTS (SELECT 1 FROM session WHERE id = $1 AND parent_id IS NULL))
    SELECT DISTINCT r.time_created FROM session_provider_request r JOIN session s ON s.id = r.session_id
    WHERE ($1 IS NULL OR s.id IN (SELECT id FROM family)) AND ($2 IS NULL OR r.time_created >= $2) AND ($3 IS NULL OR r.time_created < $3)
        AND ($4 IS NULL OR r.time_created > $4) ORDER BY r.time_created LIMIT 200";

fn analytics_report(
    client: &ycoding_store::Client,
    id: Option<&session::Id>,
    input: &provider_request::ReportInput,
    pricer: Pricer<'_>,
) -> Result<provider_request::Report, Error> {
    let zone = zone(input)?;
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
    let checkpoint_query = || Query {
        sql: CHECKPOINT,
        parameters: Vec::new(),
        max_rows: 1,
    };
    let checkpoint = handle
        .report(vec![checkpoint_query()])
        .map_err(analytics_error)?
        .remove(0)
        .remove(0)
        .remove(0);
    let mut prices = Vec::new();
    if let Some(pricer) = pricer {
        let mut after = Value::Null;
        loop {
            let mut result = handle
                .report(vec![
                    checkpoint_query(),
                    Query {
                        sql: PRICING_REFS,
                        parameters: selection.iter().cloned().chain([after]).collect(),
                        max_rows: 200,
                    },
                ])
                .map_err(analytics_error)?;
            if result[0][0][0] != checkpoint {
                return Err(analytics_error(ycoding_store::analytics::Error::Invalid));
            }
            let rows = result.remove(1);
            for row in &rows {
                let reference = PricingRef {
                    directory: reports::value_text(&row[0])?.into(),
                    workspace_id: (!matches!(row[1], Value::Null))
                        .then(|| reports::value_text(&row[1]).map(Into::into))
                        .transpose()?,
                    provider: reports::value_text(&row[2])?.into(),
                    model: reports::value_text(&row[3])?.into(),
                    profile: (!matches!(row[4], Value::Null))
                        .then(|| reports::value_text(&row[4]).map(Into::into))
                        .transpose()?,
                };
                if let Some(pricing) = pricer(&reference) {
                    for (priority, costs) in
                        [pricing.provider, pricing.router].into_iter().enumerate()
                    {
                        for (ordinal, cost) in costs.into_iter().enumerate() {
                            prices.push(format!(
                                "{}|{priority}|{}|{ordinal}|{}|{}|{}|{}",
                                reports::value_text(&row[5])?,
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
            if rows.len() < 200 {
                break;
            }
            after = rows
                .last()
                .ok_or(Error::Rejected("missing usage price cursor"))?[5]
                .clone();
        }
    }
    let mut offsets = Vec::new();
    if let Some(zone) = &zone {
        match zone {
            Zone::Fixed(seconds) => {
                offsets.push(format!("{}|{seconds}|{}", i64::MIN, offset_label(*seconds)))
            }
            Zone::Iana(zone) => {
                let mut after = Value::Null;
                let mut previous = None;
                loop {
                    let mut result = handle
                        .report(vec![
                            checkpoint_query(),
                            Query {
                                sql: TIMES,
                                parameters: selection.iter().cloned().chain([after]).collect(),
                                max_rows: 200,
                            },
                        ])
                        .map_err(analytics_error)?;
                    if result[0][0][0] != checkpoint {
                        return Err(analytics_error(ycoding_store::analytics::Error::Invalid));
                    }
                    let rows = result.remove(1);
                    for row in &rows {
                        let Value::BigInt(time) = row[0] else {
                            return Err(Error::Rejected("invalid usage time"));
                        };
                        let utc = DateTime::<Utc>::from_timestamp_millis(time)
                            .ok_or(Error::Rejected("invalid usage time"))?;
                        let seconds = utc.with_timezone(zone).offset().fix().local_minus_utc();
                        if previous != Some(seconds) {
                            offsets.push(format!("{time}|{seconds}|{}", offset_label(seconds)));
                            previous = Some(seconds);
                        }
                    }
                    if rows.len() < 200 {
                        break;
                    }
                    after = rows
                        .last()
                        .ok_or(Error::Rejected("missing usage time cursor"))?[0]
                        .clone();
                }
            }
        }
    }
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
        .report(vec![
            checkpoint_query(),
            Query {
                sql: include_str!("usage_report.sql"),
                parameters,
                max_rows: limit as usize + 1,
            },
        ])
        .map_err(analytics_error)?;
    if (pricer.is_some() || matches!(zone, Some(Zone::Iana(_)))) && result[0][0][0] != checkpoint {
        return Err(analytics_error(ycoding_store::analytics::Error::Invalid));
    }
    let mut result = result.remove(1).into_iter();
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
    first: usize,
    logical: u64,
    physical: u64,
    helpers: u64,
    continued: u64,
    fallback: u64,
    input: f64,
    output: f64,
    reasoning: f64,
    read: f64,
    write: f64,
    cost: f64,
    priced: u64,
    correction: Option<f64>,
    unreported: bool,
}

impl Acc {
    fn add(&mut self, index: usize, sample: &Sample) {
        if self.logical == 0 {
            self.first = index;
        }
        self.logical += 1;
        self.physical += sample.attempts as u64;
        self.helpers += u64::from(!sample.step);
        self.continued += u64::from(sample.continued);
        self.fallback += u64::from(sample.fallback);
        self.input += sample.tokens.input.get();
        self.output += sample.tokens.output.get();
        self.reasoning += sample.tokens.reasoning.get();
        self.read += sample.tokens.cache.read.get();
        self.write += sample.tokens.cache.write.get();
        if let Some(cost) = sample.cost {
            self.cost += cost;
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
        self.cost + self.correction.unwrap_or(0.0)
    }

    fn tokens(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("input", &self.input)
            .field("output", &self.output)
            .field("reasoning", &self.reasoning)
            .field(
                "cache",
                &ObjectEncoder::new()
                    .field("read", &self.read)
                    .field("write", &self.write)
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

fn load(
    snapshot: &Snapshot,
    id: Option<&session::Id>,
    from: Option<i64>,
    to: Option<i64>,
    pricer: Pricer<'_>,
) -> Result<(Vec<Session>, Vec<Sample>), Error> {
    let family = match id {
        Some(id) => family(snapshot, id)?,
        None => all_sessions(snapshot)?,
    };
    let mut prices: HashMap<String, Option<Pricing>> = HashMap::new();
    let mut samples = Vec::new();
    for (index, session) in family.iter().enumerate() {
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
                if from.is_some_and(|from| row.time_created < from)
                    || to.is_some_and(|to| row.time_created >= to)
                {
                    continue;
                }
                samples.push(sample(index, session, row, pricer, &mut prices)?);
            }
        }
    }
    Ok((family, samples))
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
        let mut children = snapshot.index::<SessionTable>(
            "session_parent_idx",
            &tuple_key(&[KeyPart::String(&sessions[current].id)]),
            None,
            usize::MAX,
        )?;
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
    prices: &mut HashMap<String, Option<Pricing>>,
) -> Result<Sample, Error> {
    let model = row.model.domain()?;
    let tokens = row.tokens.domain()?;
    let estimate = match pricer {
        Some(pricer) if row.cost.is_none() && row.source.as_str() != Some("decision") => {
            let reference = PricingRef {
                directory: session.directory.clone(),
                workspace_id: session.workspace_id.clone(),
                provider: model.provider_id.0.clone(),
                model: model.id.clone(),
                profile: model.profile.as_ref().map(|profile| profile.0.clone()),
            };
            let identity = format!(
                "{:?}",
                (
                    text(&reference.directory),
                    reference.workspace_id.as_ref().map(text),
                    text(&reference.provider),
                    text(&reference.model),
                    reference.profile.as_ref().map(text),
                )
            );
            let pricing = prices
                .entry(identity)
                .or_insert_with(|| pricer(&reference))
                .as_ref();
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

fn summary(samples: &[Sample]) -> JsonValue {
    let mut total = Acc::default();
    let mut groups: BTreeMap<String, Acc> = BTreeMap::new();
    for (index, sample) in samples.iter().enumerate() {
        total.add(index, sample);
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
        groups.entry(identity).or_default().add(index, sample);
    }
    let mut models = groups.into_values().collect::<Vec<_>>();
    models.sort_by(|left, right| {
        let (left_model, right_model) = (&samples[left.first].model, &samples[right.first].model);
        right
            .priced()
            .then(|| right.cost())
            .partial_cmp(&left.priced().then(|| left.cost()))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| model_order(left_model).cmp(&model_order(right_model)))
    });
    let latest = samples
        .iter()
        .max_by_key(|sample| (sample.time, sample.family, sample.request));
    total
        .metrics(ObjectEncoder::new())
        .optional(
            "models",
            &(!models.is_empty()).then(|| {
                JsonValue::Array(
                    models
                        .iter()
                        .map(|group| {
                            ObjectEncoder::new()
                                .field("model", &samples[group.first].model)
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
        .finish()
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
