use crate::session::codec::Field;
use crate::{
    Decimal, Error, IndexDefinition, KeyPart, TableDeclaration, TableSpec, Write, analytics,
    resources, session, tuple_key,
};
use std::ops::Bound;
use ycoding_schema::{
    DomainEncode, LosslessString, model, provider_request, stringify_json, token_usage,
};

pub const COUNTS: &[&str] = &[
    "logical",
    "physical",
    "helpers",
    "continued",
    "fallback",
    "cache_reported",
    "priced",
    "unpriced",
    "completed",
    "failed",
    "cancelled",
    "first_samples",
    "total_samples",
    "generation_samples",
    "generation_provider",
    "generation_observed",
    "cost_nonnegative_requests",
];
pub const AMOUNTS: &[&str] = &[
    "cost",
    "input",
    "output",
    "reasoning",
    "cache_read",
    "cache_write",
    "first_total",
    "total_total",
    "generation_tokens",
    "generation_ns",
    "cost_nonnegative",
];

macro_rules! record {
    ($name:ident {$($field:ident: $ty:ty),* $(,)?}) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name { $(pub $field: $ty),* }
        impl Field for $name {
            fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> { $(Field::encode(&self.$field,bytes)?;)* Ok(()) }
            fn decode(input: &mut &[u8]) -> Result<Self, Error> { Ok(Self { $($field: <$ty as Field>::decode(input)?),* }) }
        }
    };
}
macro_rules! table {
    ($table:ident, $row:ty, $name:literal, $key:expr) => {
        pub struct $table;
        impl TableSpec for $table {
            type Record = $row;
            const NAME: &'static str = $name;
            const INDEXES: &'static [IndexDefinition] = &[];
            fn primary_key(row: &$row) -> Vec<u8> {
                ($key)(row)
            }
            fn encode(row: &$row) -> Result<Vec<u8>, Error> {
                row.check()?;
                let mut bytes = vec![2];
                row.encode(&mut bytes)?;
                Ok(bytes)
            }
            fn decode(mut bytes: &[u8]) -> Result<$row, Error> {
                if bytes.first() != Some(&2) {
                    return Err(Error::Incompatible("prepared Usage codec"));
                }
                bytes = &bytes[1..];
                let row = <$row as Field>::decode(&mut bytes)?;
                if !bytes.is_empty() {
                    return Err(Error::Incompatible("prepared Usage trailing bytes"));
                }
                row.check()?;
                Ok(row)
            }
            fn index_key(_: &IndexDefinition, _: &$row) -> Result<Option<Vec<u8>>, Error> {
                Err(Error::UnregisteredIndex)
            }
        }
    };
}
record!(Dimensions {
    session_id: LosslessString, project_id: LosslessString, directory: LosslessString,
    workspace_id: Option<LosslessString>, session_updated: i64, agent: LosslessString,
    source: LosslessString, model: session::Document<model::Ref>,
    anchor_session_id: Option<LosslessString>, anchor_input_id: Option<LosslessString>,
    input_key: Option<LosslessString>, task_path: Vec<LosslessString>
});
record!(Cell { family: LosslessString, span: i64, bucket: i64, dimensions: Dimensions, counts: Vec<i64>, amounts: Vec<Decimal>, generation_rate: f64 });
record!(Leaf { family: LosslessString, source_id: LosslessString, span: i64, contribution: Cell, samples: Vec<Option<Decimal>>, generation_sample: Option<f64>, context: Decimal });
record!(Sample {
    cell: Cell,
    metric: i64,
    value: Option<Decimal>,
    generation_rate: Option<f64>,
    count: i64
});
record!(Unpriced { cell: Cell, context: Decimal, requests: i64, tokens: Vec<Decimal> });
record!(Backfill { family: LosslessString, after: Option<LosslessString>, complete: i64 });

impl Cell {
    fn check(&self) -> Result<(), Error> {
        if !matches!(self.family.as_str(), Some("session" | "backend"))
            || ![1, 60_000, 900_000].contains(&self.span)
            || self.bucket.rem_euclid(self.span) != 0
            || self.counts.len() != COUNTS.len()
            || self.amounts.len() != AMOUNTS.len()
            || self.counts.iter().any(|value| *value < 0)
            || !self.generation_rate.is_finite()
            || self.generation_rate < 0.0
            || self.amounts[6..].iter().any(Decimal::is_negative)
            || self.counts[16] > self.counts[6]
            || (self.counts[16] == 0 && self.amounts[10] != Decimal::default())
        {
            return Err(Error::Incompatible("invalid prepared Usage cell"));
        }
        Ok(())
    }
    pub fn key(&self) -> Vec<u8> {
        let mut dimensions = Vec::new();
        self.dimensions
            .encode(&mut dimensions)
            .expect("bounded prepared Usage dimensions");
        tuple_key(&[
            KeyPart::String(&self.family),
            KeyPart::I64(self.span),
            KeyPart::I64(self.bucket),
            KeyPart::Bytes(&dimensions),
        ])
    }
}
impl Leaf {
    fn check(&self) -> Result<(), Error> {
        self.contribution.check()?;
        if self.family != self.contribution.family
            || self.span != self.contribution.span
            || self.samples.len() != 2
            || self.samples.iter().flatten().any(Decimal::is_negative)
            || self
                .generation_sample
                .is_some_and(|value| !value.is_finite() || value < 0.0)
            || self.contribution.counts[0] != 1
            || self.contribution.counts[6].checked_add(self.contribution.counts[7]) != Some(1)
            || self.contribution.counts[16]
                != i64::from(
                    self.contribution.counts[6] == 1 && !self.contribution.amounts[0].is_negative(),
                )
            || self.contribution.amounts[10]
                != if self.contribution.counts[16] == 1 {
                    self.contribution.amounts[0].clone()
                } else {
                    Decimal::default()
                }
        {
            return Err(Error::Incompatible("invalid prepared Usage leaf"));
        }
        Ok(())
    }
}
impl Sample {
    pub(crate) fn key_for_cell(&self, cell_key: &[u8]) -> Vec<u8> {
        let value = self
            .value
            .as_ref()
            .map(|value| value.to_bytes().expect("validated sample decimal"))
            .unwrap_or_else(|| {
                self.generation_rate
                    .expect("validated generation sample")
                    .to_bits()
                    .to_be_bytes()
                    .to_vec()
            });
        tuple_key(&[
            KeyPart::Bytes(cell_key),
            KeyPart::I64(self.metric),
            KeyPart::Bytes(&value),
        ])
    }

    pub fn source_value(&self) -> Result<f64, Error> {
        match (&self.value, self.generation_rate) {
            (Some(value), None) => value.to_f64(),
            (None, Some(value)) => Ok(value),
            _ => Err(Error::Incompatible("invalid prepared Usage sample value")),
        }
    }
    fn check(&self) -> Result<(), Error> {
        self.cell.check()?;
        if !(0..3).contains(&self.metric)
            || match self.metric {
                0 | 1 => {
                    self.value.as_ref().is_none_or(Decimal::is_negative)
                        || self.generation_rate.is_some()
                }
                2 => {
                    self.value.is_some()
                        || self
                            .generation_rate
                            .is_none_or(|value| !value.is_finite() || value < 0.0)
                }
                _ => true,
            }
            || self.count < 1
        {
            return Err(Error::Incompatible("invalid prepared Usage histogram"));
        }
        Ok(())
    }
}
impl Unpriced {
    fn check(&self) -> Result<(), Error> {
        self.cell.check()?;
        if self.requests < 1 || self.tokens.len() != 5 {
            return Err(Error::Incompatible("invalid prepared Usage price context"));
        }
        Ok(())
    }
}
impl Backfill {
    fn check(&self) -> Result<(), Error> {
        if !matches!(self.family.as_str(), Some("session" | "backend"))
            || ![0, 1].contains(&self.complete)
        {
            return Err(Error::Incompatible("invalid prepared Usage readiness"));
        }
        Ok(())
    }
}
table!(CellTable, Cell, "usage_cell", |row: &Cell| row.key());
table!(LeafTable, Leaf, "usage_cell_leaf", |row: &Leaf| leaf_key(
    &row.family,
    &row.source_id,
    row.span
));
table!(SampleTable, Sample, "usage_cell_sample", |row: &Sample| {
    row.key_for_cell(&row.cell.key())
});
table!(
    UnpricedTable,
    Unpriced,
    "usage_cell_unpriced",
    |row: &Unpriced| tuple_key(&[
        KeyPart::Bytes(&row.cell.key()),
        KeyPart::Bytes(
            &row.context
                .to_bytes()
                .expect("validated price context decimal")
        )
    ])
);
table!(
    BackfillTable,
    Backfill,
    "usage_cell_backfill",
    |row: &Backfill| tuple_key(&[KeyPart::String(&row.family)])
);
pub const TABLES: &[TableDeclaration] = &[
    TableDeclaration::of::<CellTable>(),
    TableDeclaration::of::<LeafTable>(),
    TableDeclaration::of::<SampleTable>(),
    TableDeclaration::of::<UnpricedTable>(),
    TableDeclaration::of::<BackfillTable>(),
];

fn leaf_key(family: &LosslessString, source: &LosslessString, span: i64) -> Vec<u8> {
    tuple_key(&[
        KeyPart::String(family),
        KeyPart::String(source),
        KeyPart::I64(span),
    ])
}
fn source_id(key: &[u8]) -> LosslessString {
    key.iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .into()
}

struct Projection {
    time: i64,
    dimensions: Dimensions,
    counts: Vec<i64>,
    amounts: Vec<Decimal>,
    generation_rate: f64,
    samples: Vec<Option<Decimal>>,
    context: Decimal,
}
struct Measures<'a> {
    attempts: i64,
    source: &'a LosslessString,
    continuation: &'a LosslessString,
    cache_read_reported: Option<i64>,
    cost: Option<f64>,
    tokens: &'a session::Document<token_usage::Info>,
    timing: Option<&'a session::Document<provider_request::Timing>>,
    outcome: Option<&'a LosslessString>,
    time_created: i64,
}
fn projection(request: Measures<'_>, dimensions: Dimensions) -> Result<Projection, Error> {
    let tokens = request.tokens.domain()?;
    let timing = request
        .timing
        .as_ref()
        .map(|value| value.domain())
        .transpose()?;
    let first = timing
        .as_ref()
        .and_then(|value| value.first_output_ms.map(|value| value.get() as f64));
    let total = timing
        .as_ref()
        .and_then(|value| value.total_ms.map(|value| value.get() as f64));
    let generation = timing.as_ref().and_then(|value| {
        let tokens = value.generated_tokens?.get();
        let provider = value.generation_duration_ns.map(|value| value.get());
        let (duration, provider) = match provider {
            Some(duration) if duration >= 1_000_000_000 => (duration, true),
            Some(0) => return None,
            _ => (
                value
                    .observed_generation_duration_ns
                    .map(|value| value.get())
                    .filter(|value| *value >= 1_000_000_000)?,
                false,
            ),
        };
        (tokens > 0).then_some((tokens as f64, duration as f64, provider))
    });
    let rate = generation.map(|(tokens, duration, _)| tokens / (duration / 1_000_000_000.0));
    let counts = vec![
        1,
        request.attempts,
        i64::from(request.source.as_str() != Some("step")),
        i64::from(request.continuation.as_str() == Some("continued")),
        i64::from(request.continuation.as_str() == Some("fallback")),
        i64::from(request.cache_read_reported == Some(1)),
        i64::from(request.cost.is_some()),
        i64::from(request.cost.is_none()),
        i64::from(request.outcome.and_then(LosslessString::as_str) == Some("completed")),
        i64::from(request.outcome.and_then(LosslessString::as_str) == Some("failed")),
        i64::from(request.outcome.and_then(LosslessString::as_str) == Some("cancelled")),
        i64::from(first.is_some()),
        i64::from(total.is_some()),
        i64::from(rate.is_some()),
        i64::from(generation.is_some_and(|(_, _, provider)| provider)),
        i64::from(generation.is_some_and(|(_, _, provider)| !provider)),
        i64::from(
            request
                .cost
                .is_some_and(|cost| cost.is_finite() && cost >= 0.0),
        ),
    ];
    let amounts = vec![
        request.cost.unwrap_or(0.0),
        tokens.input.get(),
        tokens.output.get(),
        tokens.reasoning.get(),
        tokens.cache.read.get(),
        tokens.cache.write.get(),
        first.unwrap_or(0.0),
        total.unwrap_or(0.0),
        generation.map_or(0.0, |(tokens, _, _)| tokens),
        generation.map_or(0.0, |(_, duration, _)| duration),
        request
            .cost
            .filter(|cost| cost.is_finite() && *cost >= 0.0)
            .unwrap_or(0.0),
    ];
    if counts.iter().any(|value| *value < 0) || amounts.iter().any(|value| !value.is_finite()) {
        return Err(Error::Rejected("invalid prepared Usage contribution"));
    }
    let amounts = amounts
        .into_iter()
        .map(Decimal::from_f64)
        .collect::<Result<Vec<_>, _>>()?;
    let context = amounts[1]
        .checked_add(&amounts[4])?
        .checked_add(&amounts[5])?;
    Ok(Projection {
        time: request.time_created,
        dimensions,
        counts,
        amounts,
        generation_rate: rate.unwrap_or(0.0),
        samples: vec![
            first.map(Decimal::from_f64).transpose()?,
            total.map(Decimal::from_f64).transpose()?,
        ],
        context,
    })
}
fn request_projection(tx: &mut Write<'_>, key: &[u8]) -> Result<Option<Projection>, Error> {
    let Some(row) = tx.get::<resources::RequestTable>(key)? else {
        return Ok(None);
    };
    let parent = tx
        .get::<session::SessionTable>(&tuple_key(&[KeyPart::String(&row.session_id)]))?
        .ok_or(Error::Rejected("prepared Usage Session is missing"))?;
    let anchor = row
        .usage_anchor
        .as_ref()
        .map(|value| value.domain())
        .transpose()?;
    let dimensions = Dimensions {
        session_id: row.session_id.clone(),
        project_id: parent.project_id,
        directory: parent.directory,
        workspace_id: parent.workspace_id,
        session_updated: parent.time_updated,
        agent: row.agent.clone(),
        source: row.source.clone(),
        model: row.model.clone(),
        anchor_session_id: anchor
            .as_ref()
            .map(|value| value.session_id.as_lossless().clone()),
        anchor_input_id: anchor
            .as_ref()
            .map(|value| value.input_id.as_lossless().clone()),
        input_key: row.input_id.as_ref().map(|id| {
            stringify_json(&ycoding_schema::JsonValue::Array(vec![
                DomainEncode::encode(&row.session_id),
                DomainEncode::encode(id),
            ]))
            .into()
        }),
        task_path: vec![],
    };
    projection(
        Measures {
            attempts: row.attempts,
            source: &row.source,
            continuation: &row.continuation,
            cache_read_reported: row.cache_read_reported,
            cost: row.cost,
            tokens: &row.tokens,
            timing: row.timing.as_ref(),
            outcome: row.outcome.as_ref(),
            time_created: row.time_created,
        },
        dimensions,
    )
    .map(Some)
}
fn fact_projection(tx: &mut Write<'_>, key: &[u8]) -> Result<Option<Projection>, Error> {
    let Some(row) = tx.get::<resources::UsageAnalyticsRequestTable>(key)? else {
        return Ok(None);
    };
    let anchor = row
        .usage_anchor
        .as_ref()
        .map(|value| value.domain())
        .transpose()?;
    let dimensions = Dimensions {
        session_id: row.session_id.clone(),
        project_id: row.project_id,
        directory: row.directory,
        workspace_id: row.workspace_id,
        session_updated: row.session_updated,
        agent: row.agent.clone(),
        source: row.source.clone(),
        model: row.model.clone(),
        anchor_session_id: anchor
            .as_ref()
            .map(|value| value.session_id.as_lossless().clone()),
        anchor_input_id: anchor
            .as_ref()
            .map(|value| value.input_id.as_lossless().clone()),
        input_key: None,
        task_path: row.task_path.domain()?,
    };
    projection(
        Measures {
            attempts: row.attempts,
            source: &row.source,
            continuation: &row.continuation,
            cache_read_reported: row.cache_read_reported,
            cost: row.cost,
            tokens: &row.tokens,
            timing: row.timing.as_ref(),
            outcome: row.outcome.as_ref(),
            time_created: row.time_created,
        },
        dimensions,
    )
    .map(Some)
}
fn put<T: TableSpec>(tx: &mut Write<'_>, row: &T::Record) -> Result<(), Error> {
    tx.put::<T>(row)?;
    analytics::record(
        tx,
        analytics::Change {
            source: T::NAME,
            identity: T::primary_key(row),
            delete: false,
        },
    )?;
    Ok(())
}
fn delete<T: TableSpec>(tx: &mut Write<'_>, key: &[u8]) -> Result<(), Error> {
    if tx.delete::<T>(key)? {
        analytics::record(
            tx,
            analytics::Change {
                source: T::NAME,
                identity: key.to_vec(),
                delete: true,
            },
        )?;
    }
    Ok(())
}
fn count(left: i64, right: i64, sign: i64) -> Result<i64, Error> {
    let value = if sign > 0 {
        left.checked_add(right)
    } else {
        left.checked_sub(right)
    }
    .ok_or(Error::Rejected("prepared Usage counter overflow"))?;
    if value < 0 {
        return Err(Error::Incompatible("negative prepared Usage counter"));
    }
    Ok(value)
}
fn apply(tx: &mut Write<'_>, leaf: &Leaf, sign: i64) -> Result<(), Error> {
    let key = leaf.contribution.key();
    let mut cell = tx.get::<CellTable>(&key)?.unwrap_or_else(|| Cell {
        counts: vec![0; COUNTS.len()],
        amounts: vec![Decimal::default(); AMOUNTS.len()],
        generation_rate: 0.0,
        ..leaf.contribution.clone()
    });
    if cell.counts.len() != COUNTS.len()
        || cell.amounts.len() != AMOUNTS.len()
        || leaf.contribution.counts.len() != COUNTS.len()
        || leaf.contribution.amounts.len() != AMOUNTS.len()
        || leaf.samples.len() != 2
    {
        return Err(Error::Incompatible("prepared Usage shape"));
    }
    for (left, right) in cell.counts.iter_mut().zip(&leaf.contribution.counts) {
        *left = count(*left, *right, sign)?;
    }
    for (left, right) in cell.amounts.iter_mut().zip(&leaf.contribution.amounts) {
        *left = if sign > 0 {
            left.checked_add(right)?
        } else {
            left.checked_sub(right)?
        };
    }
    cell.generation_rate = if sign > 0 {
        cell.generation_rate + leaf.contribution.generation_rate
    } else {
        (cell.generation_rate - leaf.contribution.generation_rate).max(0.0)
    };
    if !cell.generation_rate.is_finite() {
        return Err(Error::Rejected("prepared Usage rate overflow"));
    }
    if cell.counts[0] == 0 {
        delete::<CellTable>(tx, &key)?;
    } else {
        put::<CellTable>(tx, &cell)?;
    }
    for metric in 0..3 {
        let value = leaf.samples.get(metric).cloned().flatten();
        let generation_rate = (metric == 2).then_some(leaf.generation_sample).flatten();
        if value.is_none() && generation_rate.is_none() {
            continue;
        }
        let mut sample = Sample {
            cell: leaf.contribution.clone(),
            metric: metric as i64,
            value,
            generation_rate,
            count: 0,
        };
        let key = SampleTable::primary_key(&sample);
        sample.count = count(
            tx.get::<SampleTable>(&key)?.map_or(0, |row| row.count),
            1,
            sign,
        )?;
        if sample.count == 0 {
            delete::<SampleTable>(tx, &key)?;
        } else {
            put::<SampleTable>(tx, &sample)?;
        }
    }
    if leaf.contribution.counts[7] > 0 {
        let mut row = Unpriced {
            cell: leaf.contribution.clone(),
            context: leaf.context.clone(),
            requests: 0,
            tokens: vec![Decimal::default(); 5],
        };
        let key = UnpricedTable::primary_key(&row);
        if let Some(old) = tx.get::<UnpricedTable>(&key)? {
            row = old;
        }
        if row.tokens.len() != 5 {
            return Err(Error::Incompatible("prepared Usage price context"));
        }
        row.requests = count(row.requests, 1, sign)?;
        for (left, right) in row.tokens.iter_mut().zip(&leaf.contribution.amounts[1..6]) {
            *left = if sign > 0 {
                left.checked_add(right)?
            } else {
                left.checked_sub(right)?
            };
        }
        if row.requests == 0 {
            delete::<UnpricedTable>(tx, &key)?;
        } else {
            put::<UnpricedTable>(tx, &row)?;
        }
    }
    Ok(())
}
fn update(
    tx: &mut Write<'_>,
    family: &str,
    id: &LosslessString,
    projection: Option<Projection>,
    missing_only: bool,
) -> Result<(), Error> {
    let family = LosslessString::from(family);
    for span in [1, 60_000, 900_000] {
        let key = leaf_key(&family, id, span);
        if let Some(old) = tx.get::<LeafTable>(&key)? {
            if missing_only {
                continue;
            }
            apply(tx, &old, -1)?;
            delete::<LeafTable>(tx, &key)?;
        }
        if let Some(projection) = &projection {
            let leaf = Leaf {
                family: family.clone(),
                source_id: id.clone(),
                span,
                contribution: Cell {
                    family: family.clone(),
                    span,
                    bucket: projection.time.div_euclid(span) * span,
                    dimensions: projection.dimensions.clone(),
                    counts: projection.counts.clone(),
                    amounts: projection.amounts.clone(),
                    generation_rate: projection.generation_rate,
                },
                samples: projection.samples.clone(),
                generation_sample: (projection.counts[13] > 0)
                    .then_some(projection.generation_rate),
                context: projection.context.clone(),
            };
            apply(tx, &leaf, 1)?;
            put::<LeafTable>(tx, &leaf)?;
        }
    }
    Ok(())
}
pub(crate) fn changed(
    tx: &mut Write<'_>,
    table: &str,
    key: &[u8],
    deleted: bool,
) -> Result<(), Error> {
    if !tx.registered::<LeafTable>() {
        return Ok(());
    }
    let (family, projection) = match table {
        resources::RequestTable::NAME => (
            "session",
            if deleted {
                None
            } else {
                request_projection(tx, key)?
            },
        ),
        resources::UsageAnalyticsRequestTable::NAME => (
            "backend",
            if deleted {
                None
            } else {
                fact_projection(tx, key)?
            },
        ),
        _ => return Ok(()),
    };
    update(tx, family, &source_id(key), projection, false)
}
pub fn ready(snapshot: &crate::Snapshot) -> Result<bool, Error> {
    for family in ["session", "backend"] {
        if !snapshot
            .get::<BackfillTable>(&tuple_key(&[KeyPart::String(&family.into())]))?
            .is_some_and(|row| row.complete == 1)
        {
            return Ok(false);
        }
    }
    Ok(true)
}
pub fn maintain(client: &crate::Client) -> Result<bool, Error> {
    let complete = {
        let snapshot = client.snapshot()?;
        ready(&snapshot)?
    };
    if complete {
        return Ok(true);
    }
    client
        .submit(|tx| {
            for family in ["session", "backend"] {
                let name = LosslessString::from(family);
                let key = tuple_key(&[KeyPart::String(&name)]);
                let mut state = tx.get::<BackfillTable>(&key)?.unwrap_or(Backfill {
                    family: name,
                    after: None,
                    complete: 0,
                });
                if state.complete == 1 {
                    continue;
                }
                let after = state
                    .after
                    .as_ref()
                    .map(|id| tuple_key(&[KeyPart::String(id)]));
                let lower = after.as_deref().map_or(Bound::Unbounded, Bound::Excluded);
                let ids = if family == "session" {
                    tx.scan::<resources::RequestTable>(lower, Bound::Unbounded, 128)?
                        .into_iter()
                        .map(|row| row.id)
                        .collect::<Vec<_>>()
                } else {
                    tx.scan::<resources::UsageAnalyticsRequestTable>(lower, Bound::Unbounded, 128)?
                        .into_iter()
                        .map(|row| row.id)
                        .collect::<Vec<_>>()
                };
                for id in &ids {
                    let primary = tuple_key(&[KeyPart::String(id)]);
                    let projection = if family == "session" {
                        request_projection(tx, &primary)?
                    } else {
                        fact_projection(tx, &primary)?
                    };
                    update(tx, family, &source_id(&primary), projection, true)?;
                }
                if let Some(id) = ids.last() {
                    state.after = Some(id.clone());
                }
                state.complete = i64::from(ids.len() < 128);
                put::<BackfillTable>(tx, &state)?;
                return Ok(family == "backend" && state.complete == 1);
            }
            Ok(true)
        })?
        .wait()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_bucket_codec_preserves_alignment_and_numeric_validation() {
        let mut row = Cell {
            family: "backend".into(),
            span: 1,
            bucket: 0,
            dimensions: Dimensions {
                session_id: "ses_synthetic".into(),
                project_id: "prj_synthetic".into(),
                directory: "/synthetic".into(),
                workspace_id: None,
                session_updated: 0,
                agent: "build".into(),
                source: "step".into(),
                model: session::Document::new(
                    ycoding_schema::parse_json(r#"{"providerID":"local","id":"synthetic"}"#)
                        .unwrap(),
                )
                .unwrap(),
                anchor_session_id: None,
                anchor_input_id: None,
                input_key: None,
                task_path: vec![],
            },
            counts: vec![0; COUNTS.len()],
            amounts: vec![Decimal::default(); AMOUNTS.len()],
            generation_rate: 0.0,
        };
        for (span, bucket, accepted) in [
            (1, i64::MIN, true),
            (1, i64::MAX, true),
            (1, -1, true),
            (60_000, -60_000, true),
            (900_000, -900_000, true),
            (1, 0, true),
            (60_000, 60_000, true),
            (900_000, 900_000, true),
            (60_000, -1, false),
            (900_000, -900_001, false),
            (60_000, i64::MIN, false),
            (900_000, i64::MAX, false),
            (60_000, 1, false),
            (900_000, 900_001, false),
            (0, 0, false),
            (i64::MIN, i64::MIN, false),
            (2, 0, false),
        ] {
            row.span = span;
            row.bucket = bucket;
            assert_eq!(
                CellTable::encode(&row).is_ok(),
                accepted,
                "encode {span}/{bucket}"
            );
            let mut bytes = vec![2];
            Field::encode(&row, &mut bytes).unwrap();
            assert_eq!(
                CellTable::decode(&bytes).is_ok(),
                accepted,
                "decode {span}/{bucket}"
            );
        }
        row.span = 1;
        row.bucket = -1;
        row.counts[0] = -1;
        assert!(CellTable::encode(&row).is_err());
        row.counts[0] = 0;
        row.generation_rate = f64::NAN;
        assert!(CellTable::encode(&row).is_err());
    }
}
