use super::{key, projector::record_error, store::Service, usage};
use chrono::{DateTime, Duration, Utc};
use std::collections::{BTreeMap, HashMap};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, model, provider_request,
    session, token_usage,
};
use ycoding_store::{
    Error, IndexOrder, KeyPart, Snapshot,
    project::ProjectTable,
    resources::{Request, requests},
    session::{Session, SessionTable},
    tuple_key,
};

const PAGE: usize = 128;
const DEFAULT_LIMIT: usize = 100;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const ONE_SECOND_NS: i64 = 1_000_000_000;
const UTC_ZONES: [&str; 7] = ["utc", "etc/utc", "gmt", "etc/gmt", "uct", "etc/uct", "z"];

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
        let (_, samples) = load(&snapshot, id, None, None, pricer)?;
        provider_request::Summary::decode(&summary(&samples)).map_err(record_error)
    }

    pub fn usage_report(
        &self,
        id: &session::Id,
        input: &provider_request::ReportInput,
        pricer: Pricer<'_>,
    ) -> Result<provider_request::Report, Error> {
        let zone = zone(input)?;
        let snapshot = self.client.snapshot()?;
        let (family, samples) = load(
            &snapshot,
            id,
            input.from.map(|from| from.get()),
            input.to.map(|to| to.get()),
            pricer,
        )?;
        let projects = project_labels(&snapshot, input, &family)?;
        provider_request::Report::decode(&report(
            input,
            zone.as_ref(),
            &family,
            &samples,
            &projects,
        ))
        .map_err(record_error)
    }
}

struct Zone {
    seconds: i64,
    label: String,
}

struct Sample {
    family: usize,
    model: model::Ref,
    agent: LosslessString,
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
    first_ms: Vec<i64>,
    total_ms: Vec<i64>,
    generated: f64,
    duration: f64,
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
        let Some(timing) = &sample.timing else {
            return;
        };
        self.first_ms
            .extend(timing.first_output_ms.map(|value| value.get()));
        self.total_ms
            .extend(timing.total_ms.map(|value| value.get()));
        let duration = timing
            .generation_duration_ns
            .map(|value| value.get())
            .or_else(|| {
                timing
                    .observed_generation_duration_ns
                    .map(|value| value.get())
                    .filter(|value| *value >= ONE_SECOND_NS)
            });
        if let (Some(duration), Some(tokens)) = (duration, timing.generated_tokens)
            && duration > 0
            && duration as f64 <= MAX_SAFE
            && tokens.get() > 0
        {
            self.generated += tokens.get() as f64;
            self.duration += duration as f64;
        }
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

    fn speed(&self) -> Option<JsonValue> {
        if self.first_ms.is_empty() && self.total_ms.is_empty() && self.duration == 0.0 {
            return None;
        }
        let first = percentiles(&self.first_ms);
        let total = percentiles(&self.total_ms);
        Some(
            ObjectEncoder::new()
                .optional("firstOutputP50Ms", &first.map(|(p50, _)| p50 as f64))
                .optional("firstOutputP95Ms", &first.map(|(_, p95)| p95 as f64))
                .optional("totalP50Ms", &total.map(|(p50, _)| p50 as f64))
                .optional("totalP95Ms", &total.map(|(_, p95)| p95 as f64))
                .optional(
                    "outputTokensPerSecond",
                    &(self.duration != 0.0).then(|| self.generated / (self.duration / 1e9)),
                )
                .field("samples", &(self.first_ms.len() as f64))
                .finish(),
        )
    }
}

fn percentiles(values: &[i64]) -> Option<(i64, i64)> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let size = sorted.len();
    Some((
        sorted[size.div_ceil(2) - 1],
        sorted[(95 * size).div_ceil(100) - 1],
    ))
}

fn load(
    snapshot: &Snapshot,
    id: &session::Id,
    from: Option<i64>,
    to: Option<i64>,
    pricer: Pricer<'_>,
) -> Result<(Vec<Session>, Vec<Sample>), Error> {
    let family = family(snapshot, id)?;
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
        agent: row.agent,
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

fn report(
    input: &provider_request::ReportInput,
    zone: Option<&Zone>,
    family: &[Session],
    samples: &[Sample],
    projects: &HashMap<String, String>,
) -> JsonValue {
    let group = text(&input.group.0);
    let mut total = Acc::default();
    let mut groups: BTreeMap<String, (String, Acc)> = BTreeMap::new();
    for (index, sample) in samples.iter().enumerate() {
        total.add(index, sample);
        let (key, label) = group_of(&group, zone, &family[sample.family], sample, projects);
        groups
            .entry(key)
            .or_insert_with(|| (label, Acc::default()))
            .1
            .add(index, sample);
    }
    let mut rows = groups.into_iter().collect::<Vec<_>>();
    let sort = input.sort.as_ref().map_or("key", |sort| sort_name(&sort.0));
    let descending = input
        .order
        .as_ref()
        .is_some_and(|order| order.0.as_str() == Some("desc"));
    rows.sort_by(|(left_key, (_, left)), (right_key, (_, right))| {
        let by_key = sort == "key" && !(group == "hour" && zone.is_some());
        let ordering = if sort == "key" {
            if by_key {
                left_key.cmp(right_key)
            } else {
                instant(left_key).cmp(&instant(right_key))
            }
        } else {
            metric(sort, left)
                .partial_cmp(&metric(sort, right))
                .unwrap_or(std::cmp::Ordering::Equal)
        };
        let ordering = if descending {
            ordering.reverse()
        } else {
            ordering
        };
        ordering.then_with(|| left_key.cmp(right_key))
    });
    let count = rows.len();
    let offset = input.offset.map_or(0, |offset| offset.get() as usize);
    let limit = input
        .limit
        .map_or(DEFAULT_LIMIT, |limit| limit.get() as usize);
    let page = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let next = (offset + page.len() < count).then(|| (offset + page.len()) as f64);
    ObjectEncoder::new()
        .field("group", &input.group)
        .field(
            "rows",
            &JsonValue::Array(
                page.iter()
                    .map(|(key, (label, acc))| {
                        acc.metrics(
                            ObjectEncoder::new()
                                .field("key", &LosslessString::from(key.as_str()))
                                .field("label", &LosslessString::from(label.as_str())),
                        )
                        .optional("speed", &acc.speed())
                        .finish()
                    })
                    .collect(),
            ),
        )
        .field("total", &total.metrics(ObjectEncoder::new()).finish())
        .field("rowCount", &(count as f64))
        .optional("nextOffset", &next)
        .finish()
}

fn metric(sort: &str, acc: &Acc) -> f64 {
    match sort {
        "cost" => acc.cost(),
        "tokens" => acc.input + acc.output + acc.reasoning + acc.read + acc.write,
        "steps" => acc.logical as f64,
        "input" => acc.input,
        "output" => acc.output,
        "reasoning" => acc.reasoning,
        "cacheRead" => acc.read,
        _ => acc.write,
    }
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

fn instant(key: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(key)
        .ok()
        .map(|time| time.timestamp())
}

fn group_of(
    group: &str,
    zone: Option<&Zone>,
    session: &Session,
    sample: &Sample,
    projects: &HashMap<String, String>,
) -> (String, String) {
    match group {
        "model" => {
            let model = &sample.model;
            let variant = model.variant.as_ref().map(text);
            let profile = model.profile.as_ref().map(|profile| text(&profile.0));
            let key = [
                Some(text(&model.provider_id.0)),
                Some(text(&model.id)),
                variant.clone(),
                profile.clone(),
            ]
            .into_iter()
            .flatten()
            .map(|part| encode_uri_component(&part))
            .collect::<Vec<_>>()
            .join("/");
            let label = format!(
                "{}/{}{}{}",
                text(&model.provider_id.0),
                text(&model.id),
                variant
                    .filter(|variant| !variant.is_empty())
                    .map_or(String::new(), |variant| format!(" ({variant})")),
                profile
                    .filter(|profile| !profile.is_empty())
                    .map_or(String::new(), |profile| format!(" · {profile}")),
            );
            (key, label)
        }
        "session" => (text(&session.id), text(&session.title)),
        "project" => {
            let project = text(&session.project_id);
            let label = projects.get(&project).cloned().unwrap_or(project.clone());
            (project, label)
        }
        "agent" => (text(&sample.agent), text(&sample.agent)),
        _ => time_group(group, zone, sample.time),
    }
}

fn time_group(group: &str, zone: Option<&Zone>, millis: i64) -> (String, String) {
    let time = DateTime::<Utc>::from_timestamp_millis(millis).unwrap_or_default()
        + Duration::seconds(zone.map_or(0, |zone| zone.seconds));
    let day = time.format("%Y-%m-%d").to_string();
    match (group, zone) {
        ("day", _) => (day.clone(), day),
        ("month", _) => (day[..7].to_string(), day[..7].to_string()),
        ("hour", Some(zone)) => (
            format!("{}T{}:00:00{}", day, time.format("%H"), zone.label),
            format!("{}T{}:00 {}", day, time.format("%H"), zone.label),
        ),
        _ => (
            format!("{}T{}:00:00.000Z", day, time.format("%H")),
            format!("{}T{}:00 UTC", day, time.format("%H")),
        ),
    }
}

fn zone(input: &provider_request::ReportInput) -> Result<Option<Zone>, Error> {
    let Some(requested) = &input.time_zone else {
        return Ok(None);
    };
    let name = text(requested);
    if UTC_ZONES.contains(&name.to_lowercase().as_str()) {
        return Ok(Some(Zone {
            seconds: 0,
            label: "+00:00".into(),
        }));
    }
    fixed_offset(&name)
        .map(Some)
        .ok_or(Error::Rejected("Unsupported time zone"))
}

fn fixed_offset(name: &str) -> Option<Zone> {
    let sign = match name.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let (hours, minutes) = name[1..].split_once(':').unwrap_or((&name[1..], "00"));
    let valid = |part: &str| part.len() == 2 && part.chars().all(|digit| digit.is_ascii_digit());
    if !valid(hours) || !valid(minutes) {
        return None;
    }
    let (hours, minutes) = (hours.parse::<i64>().ok()?, minutes.parse::<i64>().ok()?);
    (hours <= 23 && minutes <= 59).then(|| Zone {
        seconds: sign * (hours * 3600 + minutes * 60),
        label: format!(
            "{}{hours:02}:{minutes:02}",
            if sign < 0 { '-' } else { '+' }
        ),
    })
}

fn project_labels(
    snapshot: &Snapshot,
    input: &provider_request::ReportInput,
    family: &[Session],
) -> Result<HashMap<String, String>, Error> {
    let mut labels = HashMap::new();
    if input.group.0.as_str() != Some("project") {
        return Ok(labels);
    }
    for session in family {
        let id = text(&session.project_id);
        if labels.contains_key(&id) {
            continue;
        }
        let label = if id == "global" {
            "Global (no project)".to_string()
        } else {
            match snapshot.get::<ProjectTable>(&key(&session.project_id))? {
                Some(project) => match &project.name {
                    Some(name) if !name.is_empty() => {
                        format!("{} · {}", text(name), text(&project.worktree))
                    }
                    _ => text(&project.worktree),
                },
                None => id.clone(),
            }
        };
        labels.insert(id, label);
    }
    Ok(labels)
}

fn encode_uri_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
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
            | b')' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap_or_default()
}
