use super::{projector::record_error, store::Service};
use chrono::{DateTime, Offset, Utc};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque, btree_map::Entry},
    ops::Bound,
    sync::Arc,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, model, provider_request,
    session, usage_anchor,
};
use ycoding_store::{
    Decimal, Error, KeyPart, Snapshot, TableSpec,
    analytics::{self, Value, reports},
    session::SessionTable,
    tuple_key,
    usage_cells::{Cell, CellTable, Sample, SampleTable},
};

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct PricingRef {
    pub directory: LosslessString,
    pub workspace_id: Option<LosslessString>,
    pub provider: LosslessString,
    pub model: LosslessString,
    pub profile: Option<LosslessString>,
}
impl PricingRef {
    pub(crate) fn key(&self) -> analytics::UsagePriceKey {
        (
            self.directory.clone(),
            self.workspace_id.clone(),
            self.provider.clone(),
            self.model.clone(),
            self.profile.clone(),
        )
    }
}
#[derive(Clone)]
pub struct Pricing {
    pub provider: Vec<model::Cost>,
    pub router: Vec<model::Cost>,
}

impl Service {
    pub fn usage(&self, id: &session::Id) -> Result<provider_request::Summary, Error> {
        Ok(prepared(&self.client, Some(id), &[])?.summary)
    }
    pub fn usage_all(&self) -> Result<provider_request::Summary, Error> {
        Ok(prepared(&self.client, None, &[])?.summary)
    }
    pub fn usage_report(
        &self,
        id: &session::Id,
        input: &provider_request::ReportInput,
    ) -> Result<provider_request::Report, Error> {
        read_report(&self.client, Some(id), input)
    }
    pub fn usage_report_all(
        &self,
        input: &provider_request::ReportInput,
    ) -> Result<provider_request::Report, Error> {
        read_report(&self.client, None, input)
    }
}

pub(crate) fn analytics_error(error: analytics::Error) -> Error {
    match error {
        analytics::Error::Unavailable => unavailable(),
        error => Error::Record(Box::new(error)),
    }
}
fn unavailable() -> Error {
    Error::Domain {
        kind: "Usage.PreparedUnavailable",
        message: "Prepared Usage is unavailable",
    }
}

pub(crate) struct Read {
    pub snapshot: Snapshot,
    pub data: Arc<analytics::UsageData>,
    handle: analytics::Handle,
    price_refs: std::cell::RefCell<BTreeSet<analytics::UsagePriceKey>>,
}
pub(crate) struct PreparedCell {
    pub cell: Cell,
    pub key: Vec<u8>,
    pub corrections: i64,
    price_ref: Option<analytics::UsagePriceKey>,
}

impl PreparedCell {
    fn visit_samples(
        &self,
        samples: &mut SampleRange<'_>,
        mut visit: impl FnMut(usize, u64, i64) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let counts = &self.cell.counts[11..14];
        let mut stored = [false; 3];
        for (metric, &count) in counts.iter().enumerate() {
            stored[metric] = count > 1;
            if count == 1 {
                let amounts = &self.cell.amounts;
                let value = match metric {
                    0 | 1 => amounts[6 + metric].to_f64()?,
                    _ => {
                        let rate = amounts[8].to_f64()? / (amounts[9].to_f64()? / 1_000_000_000.0);
                        if rate.to_bits() != self.cell.generation_rate.to_bits() {
                            stored[metric] = true;
                            continue;
                        }
                        rate
                    }
                };
                if !value.is_finite() || value < 0.0 {
                    return Err(Error::Incompatible("Invalid Usage sample"));
                }
                visit(metric, if value == 0.0 { 0 } else { value.to_bits() }, 1)?;
            }
        }
        if stored.iter().any(|&needed| needed) {
            samples.visit(&self.key, |metric, value, count| {
                if stored[metric] {
                    visit(metric, value, count)?;
                }
                Ok(())
            })?;
        }
        Ok(())
    }
}

struct SampleRange<'a> {
    read: &'a Read,
    end: Vec<u8>,
    pending: VecDeque<(Vec<u8>, Sample)>,
    after: Option<Vec<u8>>,
    exhausted: bool,
}

impl SampleRange<'_> {
    fn visit(
        &mut self,
        key: &[u8],
        mut visit: impl FnMut(usize, u64, i64) -> Result<(), Error>,
    ) -> Result<(), Error> {
        loop {
            while let Some((cell_key, row)) = self.pending.front() {
                match cell_key.as_slice().cmp(key) {
                    std::cmp::Ordering::Greater => return Ok(()),
                    std::cmp::Ordering::Equal => {
                        let value = row.source_value()?;
                        visit(
                            row.metric as usize,
                            if value == 0.0 { 0 } else { value.to_bits() },
                            row.count,
                        )?;
                    }
                    std::cmp::Ordering::Less => {}
                }
                self.pending.pop_front();
            }
            if self.exhausted {
                return Ok(());
            }
            self.read.finish()?;
            let prefix = tuple_key(&[KeyPart::Bytes(key)]);
            let statement = self.read.snapshot.read_statement(10_000);
            let rows = statement.scan::<SampleTable>(
                self.after
                    .as_deref()
                    .filter(|after| *after >= prefix.as_slice())
                    .map_or(Bound::Included(prefix.as_slice()), Bound::Excluded),
                Bound::Excluded(&self.end),
                128,
            )?;
            self.exhausted = rows.len() < 128;
            self.after = rows.last().map(SampleTable::primary_key);
            self.pending = rows.into_iter().map(|row| (row.cell.key(), row)).collect();
            std::thread::yield_now();
        }
    }
}

pub(crate) fn upper(prefix: &[u8]) -> Vec<u8> {
    let mut end = prefix.to_vec();
    while let Some(last) = end.pop() {
        if last < u8::MAX {
            end.push(last + 1);
            break;
        }
    }
    end
}
impl Read {
    pub fn new(client: &ycoding_store::Client) -> Result<Self, Error> {
        let handle = client.analytics().map_err(analytics_error)?;
        let data = handle
            .usage_data()
            .map_err(analytics_error)?
            .ok_or_else(unavailable)?;
        let snapshot = client.snapshot()?;
        let read = Self {
            snapshot,
            data,
            handle,
            price_refs: Default::default(),
        };
        read.finish()?;
        Ok(read)
    }
    pub fn finish(&self) -> Result<(), Error> {
        if self
            .handle
            .usage_data()
            .map_err(analytics_error)?
            .is_some_and(|data| Arc::ptr_eq(&data, &self.data))
        {
            Ok(())
        } else {
            Err(unavailable())
        }
    }
    fn track(&self, row: &PreparedCell) {
        if let Some(reference) = &row.price_ref {
            self.price_refs.borrow_mut().insert(reference.clone());
        }
    }
    pub fn members(
        &self,
        id: &session::Id,
        descendants: bool,
    ) -> Result<BTreeSet<LosslessString>, Error> {
        let root = self
            .data
            .sessions
            .get(id.as_lossless())
            .ok_or(Error::Domain {
                kind: "not_found",
                message: "Session not found",
            })?;
        let mut selected = BTreeSet::from([root.id.clone()]);
        if !descendants && root.parent.is_some() {
            return Ok(selected);
        }
        let mut children = BTreeMap::<LosslessString, Vec<LosslessString>>::new();
        for (index, member) in self.data.sessions.values().enumerate() {
            if let Some(parent) = &member.parent {
                children
                    .entry(parent.clone())
                    .or_default()
                    .push(member.id.clone());
            }
            if index.is_multiple_of(128) {
                std::thread::yield_now();
            }
        }
        let mut frontier = vec![root.id.clone()];
        while let Some(parent) = frontier.pop() {
            if let Some(children) = children.get(&parent) {
                for child in children {
                    if selected.insert(child.clone()) {
                        frontier.push(child.clone());
                    }
                }
            }
            std::thread::yield_now();
        }
        Ok(selected)
    }
    pub fn cells(
        &self,
        family: &str,
        selected: Option<&BTreeSet<LosslessString>>,
        max_span: i64,
        from: Option<i64>,
        to: Option<i64>,
        mut visit: impl FnMut(PreparedCell) -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.cells_with_samples(family, selected, max_span, from, to, |row, _| visit(row))
    }
    fn cells_with_samples(
        &self,
        family: &str,
        selected: Option<&BTreeSet<LosslessString>>,
        max_span: i64,
        from: Option<i64>,
        to: Option<i64>,
        mut visit: impl FnMut(PreparedCell, &mut SampleRange<'_>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if from.is_none() && to.is_none() {
            let span = if max_span >= 900_000 {
                900_000
            } else if max_span >= 60_000 {
                60_000
            } else {
                1
            };
            return self.cells_at(family, selected, span, None, None, visit);
        }
        let mut remaining = vec![(from.unwrap_or(i64::MIN), to.unwrap_or(i64::MAX))];
        let mut ranges = Vec::new();
        for span in [900_000_i64, 60_000] {
            if span > max_span {
                continue;
            }
            let mut edges = Vec::new();
            for (from, to) in remaining {
                let first = from
                    .checked_add((span - from.rem_euclid(span)) % span)
                    .unwrap_or(to);
                let last = to.checked_sub(to.rem_euclid(span)).unwrap_or(from);
                if first < last {
                    ranges.push((first, last, span));
                    if from < first {
                        edges.push((from, first));
                    }
                    if last < to {
                        edges.push((last, to));
                    }
                } else if from < to {
                    edges.push((from, to));
                }
            }
            remaining = edges;
        }
        ranges.extend(remaining.into_iter().map(|(from, to)| (from, to, 1)));
        ranges.sort_unstable_by_key(|range| range.0);
        for (from, to, span) in ranges {
            self.cells_at(family, selected, span, Some(from), Some(to), &mut visit)?;
            std::thread::yield_now();
        }
        Ok(())
    }
    fn cells_at(
        &self,
        family: &str,
        selected: Option<&BTreeSet<LosslessString>>,
        span: i64,
        from: Option<i64>,
        to: Option<i64>,
        mut visit: impl FnMut(PreparedCell, &mut SampleRange<'_>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let family: LosslessString = family.into();
        let lower = tuple_key(&[
            KeyPart::String(&family),
            KeyPart::I64(span),
            KeyPart::I64(from.unwrap_or(i64::MIN)),
        ]);
        let end = to
            .map(|to| {
                tuple_key(&[
                    KeyPart::String(&family),
                    KeyPart::I64(span),
                    KeyPart::I64(to),
                ])
            })
            .unwrap_or_else(|| upper(&tuple_key(&[KeyPart::String(&family), KeyPart::I64(span)])));
        let Some(selected) = selected else {
            return self.cell_range(&family, &lower, &end, &mut visit);
        };
        let mut buckets = BTreeMap::new();
        for session in selected {
            let Some(occupied) = self
                .data
                .buckets
                .get(&(family.clone(), span, session.clone()))
            else {
                continue;
            };
            let mut range = occupied.range((
                Bound::Included(from.unwrap_or(i64::MIN)),
                to.map_or(Bound::Unbounded, Bound::Excluded),
            ));
            if let Some(&bucket) = range.next() {
                buckets.insert((bucket, session), range);
            }
        }
        while let Some(((bucket, session), mut range)) = buckets.pop_first() {
            self.finish()?;
            let bucket = tuple_key(&[
                KeyPart::String(&family),
                KeyPart::I64(span),
                KeyPart::I64(bucket),
            ]);
            let prefix = analytics::session_cell_prefix(&bucket, session)?;
            self.cell_range(&family, &prefix, &upper(&prefix), &mut visit)?;
            if let Some(&next) = range.next() {
                buckets.insert((next, session), range);
            }
            std::thread::yield_now();
        }
        self.finish()
    }
    fn cell_range(
        &self,
        family: &LosslessString,
        lower: &[u8],
        end: &[u8],
        visit: &mut impl FnMut(PreparedCell, &mut SampleRange<'_>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let mut after = None;
        let mut samples = SampleRange {
            read: self,
            end: tuple_key(&[KeyPart::Bytes(end)]),
            pending: VecDeque::new(),
            after: None,
            exhausted: false,
        };
        loop {
            self.finish()?;
            let statement = self.snapshot.read_statement(10_000);
            let page = statement.scan::<CellTable>(
                after
                    .as_deref()
                    .map_or(Bound::Included(lower), Bound::Excluded),
                Bound::Excluded(end),
                128,
            )?;
            if page.is_empty() {
                break;
            }
            after = page.last().map(CellTable::primary_key);
            for mut cell in page {
                let key = cell.key();
                if family.as_str() == Some("session") {
                    let session = statement
                        .get::<SessionTable>(&super::key(&cell.dimensions.session_id))?
                        .ok_or(Error::Rejected("Usage Session is missing"))?;
                    cell.dimensions.directory = session.directory;
                    cell.dimensions.workspace_id = session.workspace_id;
                    cell.dimensions.project_id = session.project_id;
                    cell.dimensions.session_updated = session.time_updated;
                    if cell.dimensions.anchor_session_id.is_none()
                        && let Some(hint) = cell
                            .dimensions
                            .input_key
                            .as_ref()
                            .and_then(|key| key.as_str())
                            .and_then(|key| self.data.hints.get(key))
                    {
                        cell.dimensions.anchor_session_id = hint
                            .resolved
                            .as_ref()
                            .map(|anchor| anchor.session_id.as_lossless().clone());
                        cell.dimensions.anchor_input_id = hint
                            .resolved
                            .as_ref()
                            .map(|anchor| anchor.input_id.as_lossless().clone());
                    }
                }
                let (corrections, price_ref) =
                    if let Some(correction) = self.data.corrections.get(&key) {
                        cell.amounts[0] = cell.amounts[0].checked_add(&correction.amount)?;
                        (correction.requests, Some(correction.price_ref.clone()))
                    } else {
                        (0, None)
                    };
                cell.counts[6] = cell.counts[6]
                    .checked_add(corrections)
                    .ok_or(Error::Rejected("Usage count overflow"))?;
                cell.counts[7] = cell.counts[7]
                    .checked_sub(corrections)
                    .filter(|value| *value >= 0)
                    .ok_or(Error::Rejected("Invalid Usage coverage"))?;
                visit(
                    PreparedCell {
                        cell,
                        key,
                        corrections,
                        price_ref,
                    },
                    &mut samples,
                )?;
            }
            std::thread::yield_now();
        }
        self.finish()
    }
}

fn read_report(
    client: &ycoding_store::Client,
    id: Option<&session::Id>,
    input: &provider_request::ReportInput,
) -> Result<provider_request::Report, Error> {
    cached(client, id, Some(input), false)?
        .ok_or_else(unavailable)?
        .reports
        .first()
        .cloned()
        .ok_or(Error::Rejected("Missing Usage report"))
}
pub(crate) fn prepared(
    client: &ycoding_store::Client,
    id: Option<&session::Id>,
    inputs: &[provider_request::ReportInput],
) -> Result<crate::usage_view::Prepared, Error> {
    presentation(client, id, inputs, false)
}
pub(crate) fn presentation(
    client: &ycoding_store::Client,
    id: Option<&session::Id>,
    inputs: &[provider_request::ReportInput],
    refresh: bool,
) -> Result<crate::usage_view::Prepared, Error> {
    for input in inputs {
        zone(input)?;
    }
    if let Some(id) = id {
        identity(id.as_lossless())?;
        if client
            .snapshot()?
            .get::<SessionTable>(&super::key(id.as_lossless()))?
            .is_none()
        {
            return Err(Error::Domain {
                kind: "not_found",
                message: "Session not found",
            });
        }
    }
    let handle = client.analytics().map_err(analytics_error)?;

    let summary = cached(client, id, None, refresh)?;
    let reports = inputs
        .iter()
        .map(|input| cached(client, id, Some(input), refresh))
        .collect::<Result<Vec<_>, _>>()?;
    let summary = summary.ok_or_else(unavailable)?;
    let reports = reports
        .into_iter()
        .map(|value| value.ok_or_else(unavailable))
        .collect::<Result<Vec<_>, _>>()?;
    if reports
        .iter()
        .any(|value| value.revision != summary.revision)
        || handle
            .prepared_revision()
            .map_err(analytics_error)?
            .as_ref()
            != Some(&summary.revision)
    {
        return Err(unavailable());
    }
    let as_of = reports.iter().fold(summary.as_of, |time, value| {
        if value.as_of.get() < time.get() {
            value.as_of
        } else {
            time
        }
    });
    Ok(crate::usage_view::Prepared {
        summary: summary
            .summary
            .clone()
            .ok_or(Error::Rejected("Missing Usage summary"))?,
        reports: reports
            .into_iter()
            .map(|value| {
                value
                    .reports
                    .first()
                    .cloned()
                    .ok_or(Error::Rejected("Missing Usage report"))
            })
            .collect::<Result<_, _>>()?,
        revision: summary.revision.clone(),
        as_of,
    })
}

fn cached(
    client: &ycoding_store::Client,
    id: Option<&session::Id>,
    input: Option<&provider_request::ReportInput>,
    refresh: bool,
) -> Result<Option<Arc<analytics::UsagePresentation>>, Error> {
    if let Some(input) = input {
        provider_request::ReportInput::decode(&input.encode()).map_err(record_error)?;
    }
    if let Some(id) = id {
        identity(id.as_lossless())?;
        if client
            .snapshot()?
            .get::<SessionTable>(&super::key(id.as_lossless()))?
            .is_none()
        {
            return Err(Error::Domain {
                kind: "not_found",
                message: "Session not found",
            });
        }
    }
    let handle = client.analytics().map_err(analytics_error)?;
    let normalized = input
        .map(|input| {
            let zone = zone(input)?;
            Ok::<_, Error>(
                ObjectEncoder::new()
                    .field("group", &input.group)
                    .optional("from", &input.from)
                    .optional("to", &input.to)
                    .field(
                        "offset",
                        &(input.offset.map_or(0, |value| value.get()) as f64),
                    )
                    .field(
                        "limit",
                        &(input.limit.map_or(100, |value| value.get()) as f64),
                    )
                    .field(
                        "sort",
                        &input
                            .sort
                            .as_ref()
                            .map(|sort| sort.0.clone())
                            .unwrap_or_else(|| "key".into()),
                    )
                    .field(
                        "order",
                        &input
                            .order
                            .as_ref()
                            .map(|order| order.0.clone())
                            .unwrap_or_else(|| "asc".into()),
                    )
                    .optional(
                        "timeZone",
                        &match zone {
                            None => None,
                            Some(Zone::Iana(zone)) => Some(LosslessString::from(zone.name())),
                            Some(Zone::Fixed(seconds)) => Some(offset_label(seconds).into()),
                        },
                    )
                    .optional("providerID", &input.provider_id)
                    .optional("modelID", &input.model_id)
                    .optional("profile", &input.profile)
                    .optional("selectedEffort", &input.selected_effort)
                    .finish(),
            )
        })
        .transpose()?;
    let key = ycoding_schema::stringify_json(&JsonValue::Array(vec![
        id.map(DomainEncode::encode).unwrap_or(JsonValue::Null),
        normalized.unwrap_or(JsonValue::Null),
    ]));
    let client = client.clone();
    let id = id.cloned();
    let inputs = input.cloned().into_iter().collect::<Vec<_>>();
    handle
        .presentation(key, refresh, move || {
            prepare_presentation(&client, id.as_ref(), &inputs)
        })
        .map_err(analytics_error)
}

#[derive(Default)]
struct Aggregate {
    counts: [i64; 17],
    amounts: [Decimal; 11],
    generation_rate: f64,
    corrections: i64,
}
impl Aggregate {
    fn add(&mut self, row: &PreparedCell) -> Result<(), Error> {
        for (target, value) in self.counts.iter_mut().zip(&row.cell.counts) {
            *target = target
                .checked_add(*value)
                .ok_or(Error::Rejected("Usage count overflow"))?;
        }
        for (target, value) in self.amounts.iter_mut().zip(&row.cell.amounts) {
            *target = target.checked_add(value)?;
        }
        self.generation_rate += row.cell.generation_rate;
        if !self.generation_rate.is_finite() {
            return Err(Error::Rejected("Usage rate overflow"));
        }
        self.corrections = self
            .corrections
            .checked_add(row.corrections)
            .ok_or(Error::Rejected("Usage count overflow"))?;
        Ok(())
    }
    fn metrics(&self) -> Result<JsonValue, Error> {
        let mut values = self.counts[..5]
            .iter()
            .copied()
            .map(Value::BigInt)
            .collect::<Vec<_>>();
        values.extend(
            self.amounts[1..6]
                .iter()
                .map(|value| value.to_bytes().map(Value::Blob))
                .collect::<Result<Vec<_>, _>>()?,
        );
        values.extend([
            Value::Blob(self.amounts[0].to_bytes()?),
            Value::BigInt(self.counts[6]),
            Value::Boolean(self.counts[5] == self.counts[0]),
            Value::BigInt(self.corrections),
            Value::BigInt(self.counts[8]),
            Value::BigInt(self.counts[9]),
            Value::BigInt(self.counts[10]),
        ]);
        reports::metrics(&values)
    }
    fn speed(&self, distribution: &Distribution) -> Result<Option<JsonValue>, Error> {
        if self.counts[11] == 0 && self.counts[12] == 0 && self.amounts[9].is_zero() {
            return Ok(None);
        }
        let mut object = ObjectEncoder::new()
            .field("generationSamples", &(self.counts[13] as f64))
            .field("providerTimedSamples", &(self.counts[14] as f64))
            .field("observedSamples", &(self.counts[15] as f64))
            .field("samples", &(self.counts[11] as f64));
        let names = [
            ["firstOutputP50Ms", "firstOutputP95Ms", "firstOutputP99Ms"],
            ["totalP50Ms", "totalP95Ms", "totalP99Ms"],
            [
                "generationP50TokensPerSecond",
                "generationP90TokensPerSecond",
                "generationP95TokensPerSecond",
            ],
        ];
        for (metric, (targets, names)) in distribution.targets.iter().zip(names).enumerate() {
            if metric == 2 && self.counts[13] < 3 {
                continue;
            }
            for (target, name) in targets.iter().zip(names) {
                if let Some(quantile) = target {
                    object = object.field(name, &f64::from_bits(quantile.prefix));
                }
            }
        }
        if self.counts[13] >= 3 {
            object = object.field(
                "meanTokensPerSecond",
                &(self.generation_rate / self.counts[13] as f64),
            );
        }
        if !self.amounts[9].is_zero() {
            object = object.field(
                "outputTokensPerSecond",
                &self.amounts[8].ratio_f64(&self.amounts[9].scale10(9)?)?,
            );
        }
        Ok(Some(object.finish()))
    }
}

const FIRST_RADIX_SHIFT: usize = 56;
const EXACT_HISTOGRAM_ENTRIES: usize = 1 << 19;

struct ExactHistogram {
    weights: BTreeMap<(u32, u8, u64), i64>,
    limit: usize,
}

impl ExactHistogram {
    fn new(limit: usize) -> Self {
        Self {
            weights: BTreeMap::new(),
            limit,
        }
    }

    fn add(&mut self, destination: u32, metric: u8, value: u64, count: i64) -> Result<bool, Error> {
        let full = self.weights.len() >= self.limit;
        match self.weights.entry((destination, metric, value)) {
            Entry::Occupied(mut entry) => {
                let weight = entry.get_mut();
                *weight = weight
                    .checked_add(count)
                    .ok_or(Error::Rejected("Usage count overflow"))?;
            }
            Entry::Vacant(entry) if !full => {
                entry.insert(count);
            }
            Entry::Vacant(_) => return Ok(false),
        }
        Ok(true)
    }
}

struct Quantile {
    prefix: u64,
    rank: i64,
    bins: Box<[i64; 256]>,
}
struct Distribution {
    destination: u32,
    targets: [[Option<Quantile>; 3]; 3],
}
impl Distribution {
    fn new(aggregate: &Aggregate, destination: u32) -> Self {
        Self {
            destination,
            targets: std::array::from_fn(|metric| {
                std::array::from_fn(|index| {
                    let count = aggregate.counts[11 + metric];
                    if count == 0 || (metric == 2 && count < 3) {
                        return None;
                    }
                    let numerator = if metric == 2 {
                        [50, 90, 95][index]
                    } else {
                        [50, 95, 99][index]
                    };
                    Some(Quantile {
                        prefix: 0,
                        rank: (count / 100) * numerator + ((count % 100) * numerator + 99) / 100,
                        bins: Box::new([0; 256]),
                    })
                })
            }),
        }
    }
    fn empty(&self) -> bool {
        self.targets.iter().flatten().all(Option::is_none)
    }
    fn sample(
        &mut self,
        metric: usize,
        value: u64,
        count: i64,
        shift: usize,
        histogram: &mut Option<ExactHistogram>,
    ) -> Result<(), Error> {
        let targets = self
            .targets
            .get_mut(metric)
            .ok_or(Error::Incompatible("Invalid Usage distribution metric"))?;
        if let Some(exact) = histogram
            && targets.iter().any(Option::is_some)
            && !exact.add(self.destination, metric as u8, value, count)?
        {
            *histogram = None;
        }
        for target in targets.iter_mut().flatten() {
            if shift == FIRST_RADIX_SHIFT || value >> (shift + 8) == target.prefix >> (shift + 8) {
                let bin = &mut target.bins[((value >> shift) & 255) as usize];
                *bin = bin
                    .checked_add(count)
                    .ok_or(Error::Rejected("Usage count overflow"))?;
            }
        }
        Ok(())
    }
    fn select_exact(&mut self, histogram: &ExactHistogram) -> Result<(), Error> {
        let destination = self.destination;
        for (metric, targets) in self.targets.iter_mut().enumerate() {
            let mut pending = targets.iter_mut().flatten().peekable();
            if pending.peek().is_none() {
                continue;
            }
            let metric = metric as u8;
            let mut seen = 0_i64;
            for (&(_, _, value), &count) in histogram
                .weights
                .range((destination, metric, 0)..=(destination, metric, u64::MAX))
            {
                seen = seen
                    .checked_add(count)
                    .ok_or(Error::Rejected("Usage count overflow"))?;
                while let Some(target) = pending.next_if(|target| target.rank <= seen) {
                    target.prefix = value;
                }
                if pending.peek().is_none() {
                    break;
                }
            }
            if pending.next().is_some() {
                return Err(Error::Incompatible("Usage distribution counts disagree"));
            }
        }
        Ok(())
    }
    fn select(&mut self, shift: usize) -> Result<(), Error> {
        for target in self.targets.iter_mut().flatten().flatten() {
            let mut rank = target.rank;
            let mut selected = None;
            for (index, count) in target.bins.iter().enumerate() {
                if rank <= *count {
                    selected = Some(index);
                    break;
                }
                rank = rank
                    .checked_sub(*count)
                    .ok_or(Error::Rejected("Usage count overflow"))?;
            }
            let selected =
                selected.ok_or(Error::Incompatible("Usage distribution counts disagree"))?;
            target.prefix |= (selected as u64) << shift;
            target.rank = rank;
            target.bins.fill(0);
        }
        Ok(())
    }
}

fn model_key(model: &model::Ref) -> Result<String, Error> {
    let mut parts = Vec::new();
    for value in [
        Some(&model.provider_id.0),
        Some(&model.id),
        model.variant.as_ref(),
        model.profile.as_ref().map(|profile| &profile.0),
    ]
    .into_iter()
    .flatten()
    {
        parts.push(
            identity(value)?
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
                    | 39
                    | b'('
                    | b')' => (byte as char).to_string(),
                    _ => format!("%{byte:02X}"),
                })
                .collect::<String>(),
        );
    }
    Ok(parts.join("/"))
}
fn group_key(group: &str, parts: &[Option<&LosslessString>]) -> String {
    ycoding_schema::stringify_json(&JsonValue::Array(
        std::iter::once(JsonValue::String(group.into()))
            .chain(
                parts
                    .iter()
                    .map(|part| part.map(DomainEncode::encode).unwrap_or(JsonValue::Null)),
            )
            .collect(),
    ))
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
fn anchor(cell: &Cell) -> Result<Option<usage_anchor::Ref>, Error> {
    cell.dimensions
        .anchor_session_id
        .as_ref()
        .zip(cell.dimensions.anchor_input_id.as_ref())
        .map(|(session, input)| {
            Ok(usage_anchor::Ref {
                session_id: session::Id::new(session.clone()).map_err(record_error)?,
                input_id: ycoding_schema::session_message_id::Id::new(input.clone())
                    .map_err(record_error)?,
            })
        })
        .transpose()
}

fn prepare_presentation(
    client: &ycoding_store::Client,
    id: Option<&session::Id>,
    inputs: &[provider_request::ReportInput],
) -> Result<analytics::UsagePresentation, Error> {
    let read = Read::new(client)?;
    let members = id.map(|id| read.members(id, false)).transpose()?;
    let family = if id.is_some() { "session" } else { "backend" };
    let summary = if inputs.is_empty() {
        let mut total = Aggregate::default();
        let mut models = BTreeMap::<String, (model::Ref, Aggregate)>::new();
        read.cells(family, members.as_ref(), 900_000, None, None, |row| {
            let model = row.cell.dimensions.model.domain()?;
            let key = ycoding_schema::stringify_json(&model.encode());
            read.track(&row);
            total.add(&row)?;
            models
                .entry(key)
                .or_insert_with(|| (model, Aggregate::default()))
                .1
                .add(&row)
        })?;
        let totals =
            provider_request::ReportMetrics::decode(&total.metrics()?).map_err(record_error)?;
        let mut models = models
            .into_values()
            .map(|(model, spend)| {
                let metrics = provider_request::ReportMetrics::decode(&spend.metrics()?)
                    .map_err(record_error)?;
                Ok(provider_request::ModelSpend {
                    model,
                    requests: metrics.logical,
                    tokens: metrics.tokens,
                    cache_read_reported: metrics.cache_read_reported,
                    cost: metrics.cost,
                    cost_provenance: metrics.cost_provenance,
                })
            })
            .collect::<Result<Vec<_>, Error>>()?;
        models.sort_by(|left, right| {
            right
                .cost
                .as_ref()
                .map(|cost| cost.get())
                .partial_cmp(&left.cost.as_ref().map(|cost| cost.get()))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| model_order(&left.model).cmp(&model_order(&right.model)))
        });
        let latest = latest(&read, id, members.as_ref())?;
        Some(provider_request::Summary {
            logical: totals.logical,
            physical: totals.physical,
            helpers: totals.helpers,
            continued: totals.continued,
            fallback: totals.fallback,
            tokens: totals.tokens,
            cost: totals.cost,
            cache_read_reported: totals.cache_read_reported,
            models: (!models.is_empty()).then_some(models),
            latest_invalidation: latest.0,
            latest_namespace: latest.1,
            latest_timing: latest.2,
        })
    } else {
        None
    };
    let reports = inputs
        .iter()
        .map(|input| report(&read, id, members.as_ref(), input))
        .collect::<Result<Vec<_>, Error>>()?;
    read.finish()?;
    Ok(analytics::UsagePresentation {
        summary,
        reports,
        revision: read.data.revision.clone(),
        as_of: read.data.as_of,
        price_refs: read.price_refs.take().into_iter().collect(),
    })
}

type Latest = (
    Option<provider_request::Invalidation>,
    Option<LosslessString>,
    Option<provider_request::Timing>,
);
fn latest(
    read: &Read,
    id: Option<&session::Id>,
    members: Option<&BTreeSet<LosslessString>>,
) -> Result<Latest, Error> {
    let family: LosslessString = if id.is_some() { "session" } else { "backend" }.into();
    let mut positions = BTreeMap::<LosslessString, (usize, Vec<usize>)>::new();
    if let Some(id) = id {
        positions.insert(id.as_lossless().clone(), (0, vec![0]));
        let mut frontier = vec![id.as_lossless().clone()];
        while let Some(parent) = frontier.pop() {
            let mut children = Vec::new();
            for member in read
                .data
                .sessions
                .values()
                .filter(|member| member.parent.as_ref() == Some(&parent))
            {
                if let Some(row) = read
                    .snapshot
                    .read_statement(10_000)
                    .get::<SessionTable>(&super::key(&member.id))?
                {
                    children.push((row.time_updated, member.id.clone()));
                }
                if children.len().is_multiple_of(128) {
                    std::thread::yield_now();
                }
            }
            children.sort_by(|left, right| right.cmp(left));
            let (depth, path) = positions
                .get(&parent)
                .cloned()
                .ok_or(Error::Rejected("Invalid Usage tree"))?;
            for (index, (_, child)) in children.into_iter().enumerate() {
                if positions.contains_key(&child) {
                    continue;
                }
                let mut path = path.clone();
                path.push(index + 1);
                positions.insert(child.clone(), (depth + 1, path));
                frontier.push(child);
            }
        }
    }
    let mut selected = None;
    let mut ordering = None;
    for (index, ((kind, session), rep)) in read.data.representatives.iter().enumerate() {
        if kind != &family || members.is_some_and(|members| !members.contains(session)) {
            continue;
        }
        let (depth, position) = positions.get(session).cloned().unwrap_or_default();
        let key = (
            rep.time_created,
            if id.is_some() {
                depth as i64
            } else {
                rep.session_updated
            },
            position,
            if id.is_none() {
                session.clone()
            } else {
                "".into()
            },
            rep.request,
        );
        if ordering.as_ref().is_none_or(|current| current < &key) {
            ordering = Some(key);
            selected = Some(rep);
        }
        if index.is_multiple_of(128) {
            std::thread::yield_now();
        }
    }
    match selected {
        None => Ok((None, None, None)),
        Some(rep) => Ok((
            Some(
                provider_request::Invalidation::decode(&JsonValue::String(
                    rep.invalidation.clone(),
                ))
                .map_err(record_error)?,
            ),
            Some(rep.namespace.clone()),
            rep.timing.clone(),
        )),
    }
}

struct Group {
    key: String,
    label: String,
    model: model::Ref,
    anchor: Option<usage_anchor::Ref>,
    task: Option<LosslessString>,
    observation: (
        Vec<(i64, LosslessString)>,
        i64,
        i64,
        LosslessString,
        Vec<u8>,
    ),
    hour: i64,
    aggregate: Aggregate,
}
fn report_groups(
    read: &Read,
    id: Option<&session::Id>,
    grouping: &str,
    requested_zone: Option<Zone>,
    row: &PreparedCell,
) -> Result<Vec<Group>, Error> {
    let model = row.cell.dimensions.model.domain()?;
    let d = &row.cell.dimensions;
    let anchor = anchor(&row.cell)?;
    let mut tasks = Vec::new();
    if grouping == "task" {
        if id.is_some() {
            let mut current = Some(d.session_id.clone());
            let mut seen = BTreeSet::new();
            while let Some(id) = current {
                if !seen.insert(id.clone()) {
                    break;
                }
                if read.data.tasks.contains_key(&id) {
                    tasks.push(Some(id.clone()));
                }
                current = read
                    .data
                    .sessions
                    .get(&id)
                    .and_then(|member| member.parent.clone());
                std::thread::yield_now();
            }
        } else {
            tasks.extend(d.task_path.iter().cloned().map(Some));
        }
    }
    if tasks.is_empty() {
        tasks.push(None);
    }
    let mut groups = Vec::new();
    for task in tasks {
        let instant = DateTime::<Utc>::from_timestamp_millis(row.cell.bucket)
            .ok_or(Error::Rejected("Invalid Usage time"))?;
        let seconds = match requested_zone {
            None => 0,
            Some(Zone::Fixed(seconds)) if matches!(grouping, "hour" | "day" | "month") => seconds,
            Some(Zone::Iana(zone)) if matches!(grouping, "hour" | "day" | "month") => instant
                .with_timezone(&zone)
                .offset()
                .fix()
                .local_minus_utc(),
            _ => 0,
        };
        let local = instant + chrono::Duration::seconds(i64::from(seconds));
        let hour = local.timestamp().div_euclid(3600) * 3600 - i64::from(seconds);
        let (key, label) = match grouping {
            "model" => (
                model_key(&model)?,
                format!(
                    "{}/{}{}{}",
                    text(&model.provider_id.0),
                    text(&model.id),
                    model
                        .variant
                        .as_ref()
                        .filter(|value| value.as_str() != Some(""))
                        .map(|value| format!(" ({})", text(value)))
                        .unwrap_or_default(),
                    model
                        .profile
                        .as_ref()
                        .filter(|profile| profile.0.as_str() != Some(""))
                        .map(|profile| format!(" · {}", text(&profile.0)))
                        .unwrap_or_default()
                ),
            ),
            "session" => {
                let row = read
                    .snapshot
                    .read_statement(10_000)
                    .get::<SessionTable>(&super::key(&d.session_id))?;
                (
                    text(&d.session_id),
                    row.map(|row| text(&row.title)).unwrap_or_else(|| {
                        format!("Session {} · title unreported", text(&d.session_id))
                    }),
                )
            }
            "project" => {
                let project =
                    read.snapshot
                        .read_statement(10_000)
                        .get::<ycoding_store::project::ProjectTable>(&super::key(&d.project_id))?;
                (
                    text(&d.project_id),
                    if d.project_id.as_str() == Some("global") {
                        "Global (no project)".to_owned()
                    } else {
                        project
                            .map(|project| {
                                project
                                    .name
                                    .filter(|name| name.as_str() != Some(""))
                                    .map_or_else(
                                        || text(&project.worktree),
                                        |name| {
                                            format!("{} · {}", text(&name), text(&project.worktree))
                                        },
                                    )
                            })
                            .unwrap_or_else(|| text(&d.project_id))
                    },
                )
            }
            "agent" => (text(&d.agent), text(&d.agent)),
            "provider" => (
                group_key(grouping, &[Some(&model.provider_id.0)]),
                text(&model.provider_id.0),
            ),
            "provider-model" => (
                group_key(grouping, &[Some(&model.provider_id.0), Some(&model.id)]),
                format!("{}/{}", text(&model.provider_id.0), text(&model.id)),
            ),
            "provider-profile-model" => (
                group_key(
                    grouping,
                    &[
                        Some(&model.provider_id.0),
                        model.profile.as_ref().map(|profile| &profile.0),
                        Some(&model.id),
                    ],
                ),
                format!(
                    "{}/{} · {}",
                    text(&model.provider_id.0),
                    text(&model.id),
                    model
                        .profile
                        .as_ref()
                        .map(|profile| text(&profile.0))
                        .unwrap_or_else(|| "Provider default".to_owned())
                ),
            ),
            "model-id" => (group_key(grouping, &[Some(&model.id)]), text(&model.id)),
            "profile" => (
                group_key(
                    grouping,
                    &[
                        Some(&model.provider_id.0),
                        model.profile.as_ref().map(|profile| &profile.0),
                    ],
                ),
                format!(
                    "{} · {}",
                    text(&model.provider_id.0),
                    model
                        .profile
                        .as_ref()
                        .map(|profile| text(&profile.0))
                        .unwrap_or_else(|| "Provider default".to_owned())
                ),
            ),
            "prompt" => (
                group_key(
                    grouping,
                    &[
                        anchor
                            .as_ref()
                            .map(|anchor| anchor.session_id.as_lossless()),
                        anchor.as_ref().map(|anchor| anchor.input_id.as_lossless()),
                    ],
                ),
                anchor
                    .as_ref()
                    .map(|anchor| text(anchor.input_id.as_lossless()))
                    .unwrap_or_else(|| "Unattributed".to_owned()),
            ),
            "task" => (
                group_key(grouping, &[task.as_ref()]),
                task.as_ref()
                    .map(text)
                    .unwrap_or_else(|| "Main Session / unattributed".to_owned()),
            ),
            "day" => {
                let key = local.format("%Y-%m-%d").to_string();
                (key.clone(), key)
            }
            "month" => {
                let key = local.format("%Y-%m").to_string();
                (key.clone(), key)
            }
            "hour" => {
                let offset = requested_zone.map(|_| offset_label(seconds));
                (
                    format!(
                        "{}{}",
                        local.format("%Y-%m-%dT%H:00:00"),
                        offset.as_deref().unwrap_or(".000Z")
                    ),
                    format!(
                        "{} {}",
                        local.format("%Y-%m-%dT%H:00"),
                        offset.as_deref().unwrap_or("UTC")
                    ),
                )
            }
            _ => return Err(Error::Rejected("Invalid Usage grouping")),
        };
        let mut family_order = Vec::new();
        if let Some(root) = id {
            let mut current = &d.session_id;
            let mut seen = BTreeSet::new();
            while current != root.as_lossless() {
                if !seen.insert(current.clone()) {
                    return Err(Error::Rejected("Invalid Usage session ancestry"));
                }
                let member = read
                    .data
                    .sessions
                    .get(current)
                    .ok_or(Error::Rejected("Invalid Usage session ancestry"))?;
                family_order.push((member.time_created, member.id.clone()));
                current = member
                    .parent
                    .as_ref()
                    .ok_or(Error::Rejected("Invalid Usage session ancestry"))?;
            }
            family_order.reverse();
        }
        let observation = (
            family_order,
            row.cell.bucket,
            d.session_updated,
            d.session_id.clone(),
            row.key.clone(),
        );
        groups.push(Group {
            key,
            label,
            model: model.clone(),
            anchor: anchor.clone(),
            task,
            observation,
            hour,
            aggregate: Aggregate::default(),
        });
    }
    Ok(groups)
}

fn report_matches(
    input: &provider_request::ReportInput,
    row: &PreparedCell,
) -> Result<bool, Error> {
    if input.provider_id.is_none()
        && input.model_id.is_none()
        && input.profile.is_none()
        && input.selected_effort.is_none()
    {
        return Ok(true);
    }
    let model = row.cell.dimensions.model.domain()?;
    Ok(!input
        .provider_id
        .as_ref()
        .is_some_and(|provider| provider != &model.provider_id)
        && !input
            .model_id
            .as_ref()
            .is_some_and(|selected| selected != &model.id)
        && !input
            .profile
            .as_ref()
            .is_some_and(|profile| Some(profile) != model.profile.as_ref())
        && !input
            .selected_effort
            .as_ref()
            .is_some_and(|effort| Some(effort) != model.variant.as_ref()))
}

fn report(
    read: &Read,
    id: Option<&session::Id>,
    members: Option<&BTreeSet<LosslessString>>,
    input: &provider_request::ReportInput,
) -> Result<provider_request::Report, Error> {
    let requested_zone = zone(input)?;
    let grouping = input
        .group
        .0
        .as_str()
        .ok_or(Error::Rejected("Invalid Usage grouping"))?;
    let family = if id.is_some() { "session" } else { "backend" };
    let mut total = Aggregate::default();
    let mut groups = BTreeMap::<String, (u32, Group)>::new();
    let mut histogram = Some(ExactHistogram::new(EXACT_HISTOGRAM_ENTRIES));
    let max_span = if matches!(grouping, "hour" | "day" | "month")
        && !matches!(requested_zone, None | Some(Zone::Iana(chrono_tz::UTC)))
    {
        1
    } else {
        900_000
    };
    read.cells_with_samples(
        family,
        members,
        max_span,
        input.from.map(|value| value.get()),
        input.to.map(|value| value.get()),
        |row, samples| {
            if !report_matches(input, &row)? {
                return Ok(());
            }
            read.track(&row);
            total.add(&row)?;
            let mut destinations = Vec::new();
            for candidate in report_groups(read, id, grouping, requested_zone, &row)? {
                let next = u32::try_from(groups.len() + 1)
                    .map_err(|_| Error::Rejected("Too many Usage groups"))?;
                let (destination, group) = match groups.entry(candidate.key.clone()) {
                    Entry::Vacant(entry) => entry.insert((next, candidate)),
                    Entry::Occupied(mut entry) => {
                        let (_, group) = entry.get_mut();
                        let hour = group.hour.min(candidate.hour);
                        if candidate.observation < group.observation {
                            let aggregate = std::mem::take(&mut group.aggregate);
                            *group = candidate;
                            group.aggregate = aggregate;
                        }
                        group.hour = hour;
                        entry.into_mut()
                    }
                };
                group.aggregate.add(&row)?;
                destinations.push(*destination);
            }
            if histogram.is_some() {
                row.visit_samples(samples, |metric, value, count| {
                    if let Some(exact) = &mut histogram {
                        for &destination in std::iter::once(&0).chain(&destinations) {
                            if !exact.add(destination, metric as u8, value, count)? {
                                histogram = None;
                                break;
                            }
                        }
                    }
                    Ok(())
                })?;
            }
            Ok(())
        },
    )?;
    let row_count = groups.len();
    let sorting = input
        .sort
        .as_ref()
        .and_then(|sort| sort.0.as_str())
        .unwrap_or("key");
    let descending = input
        .order
        .as_ref()
        .is_some_and(|order| order.0.as_str() == Some("desc"));
    let metric = |group: &Group| -> Result<Decimal, Error> {
        Ok(match sorting {
            "tokens" => group.aggregate.amounts[1..6]
                .iter()
                .try_fold(Decimal::default(), |sum, value| sum.checked_add(value))?,
            "cost" => group.aggregate.amounts[0].clone(),
            "steps" => Decimal::from_i64(group.aggregate.counts[0]),
            "input" => group.aggregate.amounts[1].clone(),
            "output" => group.aggregate.amounts[2].clone(),
            "reasoning" => group.aggregate.amounts[3].clone(),
            "cacheRead" => group.aggregate.amounts[4].clone(),
            "cacheWrite" => group.aggregate.amounts[5].clone(),
            _ if grouping == "hour" && requested_zone.is_some() => Decimal::from_i64(group.hour),
            _ => Decimal::default(),
        })
    };
    let mut groups = groups
        .into_values()
        .map(|(destination, group)| Ok((metric(&group)?, destination, group)))
        .collect::<Result<Vec<_>, Error>>()?;
    groups.sort_by(|(left_metric, _, left), (right_metric, _, right)| {
        let order = left_metric.cmp(right_metric);
        let order = if descending { order.reverse() } else { order };
        order.then_with(|| {
            if sorting == "key" && descending {
                right.key.cmp(&left.key)
            } else {
                left.key.cmp(&right.key)
            }
        })
    });
    let groups = groups
        .into_iter()
        .map(|(_, destination, group)| (destination, group))
        .collect::<Vec<_>>();
    let offset = input.offset.map_or(0, |value| value.get() as usize);
    let limit = input.limit.map_or(100, |value| value.get() as usize);
    let groups = groups
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();
    let mut total_distribution = Distribution::new(&total, 0);
    let mut distributions = groups
        .iter()
        .map(|(destination, group)| {
            (
                group.key.clone(),
                Distribution::new(&group.aggregate, *destination),
            )
        })
        .collect::<BTreeMap<_, _>>();
    if let Some(histogram) = &histogram {
        total_distribution.select_exact(histogram)?;
        for distribution in distributions.values_mut() {
            distribution.select_exact(histogram)?;
        }
    } else if !total_distribution.empty()
        || distributions
            .values()
            .any(|distribution| !distribution.empty())
    {
        for shift in (0..=FIRST_RADIX_SHIFT).rev().step_by(8) {
            read.cells_with_samples(
                family,
                members,
                max_span,
                input.from.map(|value| value.get()),
                input.to.map(|value| value.get()),
                |row, samples| {
                    if !report_matches(input, &row)?
                        || row.cell.counts[11..14].iter().all(|count| *count == 0)
                    {
                        return Ok(());
                    }
                    let keys = report_groups(read, id, grouping, requested_zone, &row)?
                        .into_iter()
                        .map(|group| group.key)
                        .filter(|key| distributions.contains_key(key))
                        .collect::<Vec<_>>();
                    row.visit_samples(samples, |metric, value, count| {
                        total_distribution.sample(metric, value, count, shift, &mut histogram)?;
                        for key in &keys {
                            distributions
                                .get_mut(key)
                                .ok_or(Error::Rejected("Missing Usage group"))?
                                .sample(metric, value, count, shift, &mut histogram)?;
                        }
                        Ok(())
                    })
                },
            )?;
            total_distribution.select(shift)?;
            for distribution in distributions.values_mut() {
                distribution.select(shift)?;
            }
        }
    }
    let rows = groups
        .into_iter()
        .map(|(_, group)| {
            let mut object = ObjectEncoder::new()
                .field("key", &LosslessString::from(group.key.as_str()))
                .field("label", &LosslessString::from(group.label));
            let dimensions = ObjectEncoder::new().field("group", &input.group);
            let dimensions = match grouping {
                "model" => {
                    object = object.field("model", &group.model);
                    None
                }
                "provider" => Some(dimensions.field("providerID", &group.model.provider_id)),
                "provider-model" => Some(
                    dimensions
                        .field("providerID", &group.model.provider_id)
                        .field("modelID", &group.model.id),
                ),
                "provider-profile-model" | "profile" => {
                    let dimensions = dimensions
                        .field("providerID", &group.model.provider_id)
                        .optional("profile", &group.model.profile)
                        .field(
                            "profileState",
                            &LosslessString::from(if group.model.profile.is_some() {
                                "recorded"
                            } else {
                                "provider-default"
                            }),
                        );
                    Some(if grouping == "provider-profile-model" {
                        dimensions.field("modelID", &group.model.id)
                    } else {
                        dimensions
                    })
                }
                "model-id" => Some(dimensions.field("modelID", &group.model.id)),
                "prompt" => Some(dimensions.optional("anchor", &group.anchor).field(
                    "attribution",
                    &LosslessString::from(if group.anchor.is_some() {
                        "complete"
                    } else {
                        "unattributed"
                    }),
                )),
                "task" => Some(dimensions.optional("sessionID", &group.task).field(
                    "attribution",
                    &LosslessString::from(if group.task.is_some() {
                        "complete"
                    } else {
                        "unattributed"
                    }),
                )),
                _ => None,
            };
            if let Some(dimensions) = dimensions {
                object = object.field("dimensions", &dimensions.finish());
            }
            let JsonValue::Object(metrics) = group.aggregate.metrics()? else {
                return Err(Error::Rejected("Invalid Usage metrics"));
            };
            for (key, value) in metrics.iter() {
                object = object.field(
                    key.as_str().ok_or(Error::Rejected("Invalid Usage field"))?,
                    value,
                );
            }
            object = object.optional(
                "speed",
                &group.aggregate.speed(
                    distributions
                        .get(&group.key)
                        .ok_or(Error::Rejected("Missing Usage distribution"))?,
                )?,
            );
            if let Some(span) = temporal_span(input, &group.key)?
                && group.aggregate.counts[12] > 0
            {
                object = object.field(
                    "concurrency",
                    &group.aggregate.amounts[7].ratio_f64(&Decimal::from_f64(span)?)?,
                );
            }
            Ok(object.finish())
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let next = (offset.saturating_add(rows.len()) < row_count)
        .then_some(offset.saturating_add(rows.len()) as f64);
    provider_request::Report::decode(
        &ObjectEncoder::new()
            .field("group", &input.group)
            .field("rows", &JsonValue::Array(rows))
            .field("total", &total.metrics()?)
            .optional("speed", &total.speed(&total_distribution)?)
            .field("rowCount", &(row_count as f64))
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

fn temporal_span(input: &provider_request::ReportInput, key: &str) -> Result<Option<f64>, Error> {
    let group = input.group.0.as_str();
    if group == Some("hour") {
        return Ok(Some(3_600_000.0));
    }
    if !matches!(group, Some("day" | "month")) {
        return Ok(None);
    }
    let key = if group == Some("month") {
        format!("{key}-01")
    } else {
        key.to_owned()
    };
    let date = chrono::NaiveDate::parse_from_str(&key, "%Y-%m-%d")
        .map_err(|_| Error::Rejected("invalid calendar key"))?;
    let next = if group == Some("month") {
        date.checked_add_months(chrono::Months::new(1))
    } else {
        date.succ_opt()
    }
    .ok_or(Error::Rejected("calendar overflow"))?;
    let zone = zone(input)?;
    Ok(Some((midnight(next, zone)? - midnight(date, zone)?) as f64))
}

fn midnight(date: chrono::NaiveDate, zone: Option<Zone>) -> Result<i64, Error> {
    use chrono::TimeZone;
    let midnight = date
        .and_hms_opt(0, 0, 0)
        .ok_or(Error::Rejected("invalid calendar date"))?;
    let resolved = match zone {
        None => Some(midnight.and_utc().timestamp_millis()),
        Some(Zone::Fixed(offset)) => {
            Some(midnight.and_utc().timestamp_millis() - i64::from(offset) * 1000)
        }
        Some(Zone::Iana(zone)) => zone
            .from_local_datetime(&midnight)
            .earliest()
            .map(|date| date.timestamp_millis()),
    };
    if let Some(value) = resolved {
        return Ok(value);
    }
    let Some(Zone::Iana(zone)) = zone else {
        return Err(Error::Rejected("invalid calendar time zone"));
    };
    let utc = midnight.and_utc().timestamp_millis();
    let mut lower = utc - 48 * 3_600_000;
    let mut upper = utc + 48 * 3_600_000;
    while lower + 1 < upper {
        let middle = lower + (upper - lower) / 2;
        if chrono::DateTime::from_timestamp_millis(middle)
            .ok_or(Error::Rejected("invalid calendar boundary"))?
            .with_timezone(&zone)
            .date_naive()
            >= date
        {
            upper = middle;
        } else {
            lower = middle;
        }
    }
    Ok(upper)
}

#[derive(Clone, Copy)]
enum Zone {
    Fixed(i32),
    Iana(chrono_tz::Tz),
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
    value
        .to_utf8()
        .unwrap_or_else(|_| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()))
}

pub(crate) fn identity(value: &LosslessString) -> Result<String, Error> {
    value
        .to_utf8()
        .map_err(|_| Error::Rejected("Usage identity is not representable"))
}
pub(crate) fn standard(
    now: i64,
    time_zone: Option<LosslessString>,
) -> Result<Vec<provider_request::ReportInput>, Error> {
    use chrono::Datelike;
    let base = provider_request::ReportInput::decode(
        &ObjectEncoder::new()
            .field("group", &LosslessString::from("day"))
            .optional("timeZone", &time_zone)
            .finish(),
    )
    .map_err(record_error)?;
    let zone = zone(&base)?;
    let now = DateTime::<Utc>::from_timestamp_millis(now)
        .ok_or(Error::Rejected("Invalid Usage clock"))?;
    let date = match zone {
        None => now.date_naive(),
        Some(Zone::Fixed(seconds)) => {
            (now + chrono::Duration::seconds(i64::from(seconds))).date_naive()
        }
        Some(Zone::Iana(zone)) => now.with_timezone(&zone).date_naive(),
    };
    let from = midnight(
        date.checked_sub_days(chrono::Days::new(29))
            .ok_or(Error::Rejected("Usage calendar overflow"))?,
        zone,
    )?;
    let to = midnight(
        date.succ_opt()
            .ok_or(Error::Rejected("Usage calendar overflow"))?,
        zone,
    )?;
    let month = midnight(
        date.with_day(1)
            .ok_or(Error::Rejected("Usage calendar overflow"))?,
        zone,
    )?;
    [
        ("day", from, 30, None, "key", "asc"),
        ("model", month, 200, None, "cost", "desc"),
        ("model", from, 25, Some(0.0), "cost", "desc"),
    ]
    .into_iter()
    .map(|(group, from, limit, offset, sort, order)| {
        provider_request::ReportInput::decode(
            &ObjectEncoder::new()
                .field("group", &LosslessString::from(group))
                .field("from", &(from as f64))
                .field("to", &(to as f64))
                .field("limit", &f64::from(limit))
                .optional("offset", &offset)
                .field("sort", &LosslessString::from(sort))
                .field("order", &LosslessString::from(order))
                .optional("timeZone", &time_zone)
                .finish(),
        )
        .map_err(record_error)
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_weighted_ranks_survive_shared_histogram_overflow() {
        let largest = ((1_u64 << 52) + 1) as f64;
        let samples = [
            (1, 3.0, 11),
            (2, 2.0, 84),
            (1, 0.0, 100),
            (2, largest, 5),
            (1, 0.0, 1),
        ];
        for (cap, expected_passes) in [(8, 1), (7, 8)] {
            let mut distributions = [(0, 201), (1, 112), (2, 89)].map(|(index, count)| {
                let mut aggregate = Aggregate::default();
                aggregate.counts[11] = count;
                Distribution::new(&aggregate, index)
            });
            let mut histogram = Some(ExactHistogram::new(cap));
            let mut passes = 0;
            for shift in (0..=FIRST_RADIX_SHIFT).rev().step_by(8) {
                passes += 1;
                for (group, value, count) in samples {
                    for index in [0, group] {
                        distributions[index]
                            .sample(0, value.to_bits(), count, shift, &mut histogram)
                            .unwrap();
                    }
                }
                if let Some(histogram) = &histogram {
                    for distribution in &mut distributions {
                        distribution.select_exact(histogram).unwrap();
                    }
                    break;
                }
                for distribution in &mut distributions {
                    distribution.select(shift).unwrap();
                }
            }
            assert_eq!(passes, expected_passes);
            assert_eq!(
                histogram.map(|histogram| histogram.weights.len()),
                (cap == 8).then_some(cap)
            );
            let ranks = distributions.map(|distribution| {
                distribution.targets[0]
                    .each_ref()
                    .map(|target| f64::from_bits(target.as_ref().unwrap().prefix))
            });
            assert_eq!(
                ranks,
                [
                    [0.0, 3.0, largest],
                    [0.0, 3.0, 3.0],
                    [2.0, largest, largest]
                ]
            );
        }
    }
}
