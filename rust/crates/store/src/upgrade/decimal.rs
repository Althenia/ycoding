use crate::{
    Catalog, Decimal, Error, KeyPart, TableSpec,
    catalog::definition,
    session::codec::Field,
    tuple_key,
    usage_cells::{
        self as cells, Backfill, BackfillTable, Cell, CellTable, Dimensions, Leaf, LeafTable,
        Sample, SampleTable, Unpriced, UnpricedTable,
    },
};
use redb::{ReadTransaction, ReadableTable, WriteTransaction};
use std::{
    collections::BTreeMap,
    ops::Bound::{Excluded, Included, Unbounded},
    thread,
};
use ycoding_schema::LosslessString;

const TABLES: [&str; 5] = [
    CellTable::NAME,
    LeafTable::NAME,
    SampleTable::NAME,
    UnpricedTable::NAME,
    BackfillTable::NAME,
];
const MEMORY_BYTES: usize = 256 * 1024 * 1024;

#[derive(Default)]
pub(super) struct Budget(usize);

impl Budget {
    fn add(&mut self, bytes: usize) -> Result<(), Error> {
        self.0 = self.0.checked_add(bytes).ok_or_else(unproven)?;
        if self.0 > MEMORY_BYTES {
            return Err(Error::Rejected(
                "Usage decimal upgrade exceeds existing memory budget",
            ));
        }
        Ok(())
    }
}

pub(super) struct Plan {
    rows: BTreeMap<&'static str, BTreeMap<Vec<u8>, Vec<u8>>>,
}

impl Plan {
    fn put<T: TableSpec>(&mut self, row: &T::Record, budget: &mut Budget) -> Result<(), Error> {
        let key = T::primary_key(row);
        let value = T::encode(row)?;
        let table = self.rows.get_mut(T::NAME).ok_or_else(unproven)?;
        let previous = table.get(&key).map(Vec::capacity);
        budget.add(key.capacity() + value.capacity() + if previous.is_none() { 128 } else { 0 })?;
        let transient = key.capacity();
        table.insert(key, value);
        if let Some(previous) = previous {
            budget.0 -= previous + transient;
        }
        Ok(())
    }

    fn get<T: TableSpec>(&self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        self.rows
            .get(T::NAME)
            .and_then(|table| table.get(key))
            .map(|value| T::decode(value))
            .transpose()
    }

    fn contribute(&mut self, leaf: &Leaf, budget: &mut Budget) -> Result<(), Error> {
        let contribution = &leaf.contribution;
        let mut cell = self
            .get::<CellTable>(&contribution.key())?
            .ok_or_else(unproven)?;
        for (target, value) in cell.counts.iter_mut().zip(&contribution.counts) {
            *target = target.checked_add(*value).ok_or_else(unproven)?;
        }
        for (target, value) in cell.amounts.iter_mut().zip(&contribution.amounts) {
            *target = target.checked_add(value)?;
        }
        self.put::<CellTable>(&cell, budget)?;
        for metric in 0..3 {
            let value = if metric < 2 {
                leaf.samples[metric].clone()
            } else {
                None
            };
            let generation_rate = if metric == 2 {
                leaf.generation_sample
            } else {
                None
            };
            if value.is_none() && generation_rate.is_none() {
                continue;
            }
            let mut row = Sample {
                cell: contribution.clone(),
                metric: metric as i64,
                value,
                generation_rate,
                count: 1,
            };
            if let Some(previous) = self.get::<SampleTable>(&SampleTable::primary_key(&row))? {
                row.count = previous.count.checked_add(1).ok_or_else(unproven)?;
                row.cell = previous.cell;
            }
            self.put::<SampleTable>(&row, budget)?;
        }
        if contribution.counts[7] == 1 {
            let mut row = Unpriced {
                cell: contribution.clone(),
                context: leaf.context.clone(),
                requests: 1,
                tokens: contribution.amounts[1..6].to_vec(),
            };
            if let Some(previous) = self.get::<UnpricedTable>(&UnpricedTable::primary_key(&row))? {
                row.requests = previous.requests.checked_add(1).ok_or_else(unproven)?;
                for (target, value) in row.tokens.iter_mut().zip(&previous.tokens) {
                    *target = target.checked_add(value)?;
                }
                row.cell = previous.cell;
            }
            self.put::<UnpricedTable>(&row, budget)?;
        }
        self.put::<LeafTable>(leaf, budget)
    }

    pub(super) fn apply(self, write: &WriteTransaction) -> Result<(), Error> {
        for (name, rows) in self.rows {
            write.delete_table(definition(name))?;
            let mut table = write.open_table(definition(name))?;
            for (key, value) in rows {
                table.insert(key.as_slice(), value.as_slice())?;
            }
        }
        Ok(())
    }

    pub(super) fn verify(&self, read: &ReadTransaction) -> Result<(), Error> {
        for (name, expected) in &self.rows {
            let table = read.open_table(definition(name))?;
            let mut actual = table.iter()?;
            for (key, value) in expected {
                let (actual_key, actual_value) = actual.next().transpose()?.ok_or_else(unproven)?;
                if actual_key.value() != key || actual_value.value() != value {
                    return Err(unproven());
                }
            }
            if actual.next().is_some() {
                return Err(unproven());
            }
        }
        Ok(())
    }
}

pub(super) fn changed(name: &str) -> bool {
    TABLES.contains(&name)
}

fn unproven() -> Error {
    Error::Incompatible("retained Usage decimal reconstruction is unproven")
}

macro_rules! legacy {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Clone)]
        struct $name { $($field: $ty),* }
        impl Field for $name {
            fn encode(&self, out: &mut Vec<u8>) -> Result<(), Error> { $(self.$field.encode(out)?;)* Ok(()) }
            fn decode(input: &mut &[u8]) -> Result<Self, Error> { Ok(Self { $($field: <$ty as Field>::decode(input)?),* }) }
        }
    };
}

legacy!(LegacyCell { family: LosslessString, span: i64, bucket: i64, dimensions: Dimensions, counts: Vec<i64>, amounts: Vec<f64> });
legacy!(LegacyLeaf { family: LosslessString, source_id: LosslessString, span: i64, contribution: LegacyCell, samples: Vec<Option<f64>>, context: f64 });
legacy!(LegacySample {
    cell: LegacyCell,
    metric: i64,
    value: f64,
    count: i64
});
legacy!(LegacyUnpriced { cell: LegacyCell, context: f64, requests: i64, tokens: Vec<f64> });

fn decode<T: Field>(bytes: &[u8]) -> Result<T, Error> {
    decode_record(bytes, 1)
}

fn decode_record<T: Field>(bytes: &[u8], tag: u8) -> Result<T, Error> {
    if bytes.first() != Some(&tag) || bytes.len() > crate::analytics::ROW_BYTES {
        return Err(unproven());
    }
    let mut bytes = &bytes[1..];
    let row = T::decode(&mut bytes)?;
    if !bytes.is_empty() {
        return Err(unproven());
    }
    Ok(row)
}

impl LegacyCell {
    fn native(&self, empty: bool) -> Result<Cell, Error> {
        if self.counts.len() != 16
            || self.amounts.len() != 11
            || self.counts.iter().any(|value| *value < 0)
            || self.amounts.iter().any(|value| !value.is_finite())
        {
            return Err(unproven());
        }
        let qualifies = !empty && self.counts[6] == 1 && self.amounts[0] >= 0.0;
        let row = Cell {
            family: self.family.clone(),
            span: self.span,
            bucket: self.bucket,
            dimensions: self.dimensions.clone(),
            counts: if empty {
                vec![0; cells::COUNTS.len()]
            } else {
                self.counts
                    .iter()
                    .copied()
                    .chain([i64::from(qualifies)])
                    .collect()
            },
            amounts: if empty {
                vec![Decimal::default(); cells::AMOUNTS.len()]
            } else {
                self.amounts
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| *index != 8)
                    .map(|(_, value)| Decimal::from_f64(*value))
                    .chain([Decimal::from_f64(if qualifies {
                        self.amounts[0]
                    } else {
                        0.0
                    })])
                    .collect::<Result<Vec<_>, _>>()?
            },
            generation_rate: self.amounts[8],
        };
        CellTable::encode(&row)?;
        Ok(row)
    }
}

fn sample_key(cell: &Cell, metric: i64, value: f64) -> Vec<u8> {
    tuple_key(&[
        KeyPart::Bytes(&cell.key()),
        KeyPart::I64(metric),
        KeyPart::Bytes(&value.to_bits().to_be_bytes()),
    ])
}

fn unpriced_key(cell: &Cell, context: f64) -> Vec<u8> {
    tuple_key(&[
        KeyPart::Bytes(&cell.key()),
        KeyPart::Bytes(&context.to_bits().to_be_bytes()),
    ])
}

fn witness(
    rows: &mut BTreeMap<Vec<u8>, i64>,
    key: Vec<u8>,
    budget: &mut Budget,
) -> Result<(), Error> {
    if !rows.contains_key(&key) {
        budget.add(key.capacity() + 128)?;
    }
    let count = rows.entry(key).or_default();
    *count = count.checked_add(1).ok_or_else(unproven)?;
    Ok(())
}

fn prior_cell(mut cell: Cell, empty: bool) -> Result<Cell, Error> {
    if cell.counts.len() != 16 || cell.amounts.len() != 10 {
        return Err(unproven());
    }
    cell.counts.push(0);
    cell.amounts.push(Decimal::default());
    CellTable::encode(&cell)?;
    if empty {
        cell.counts.fill(0);
        cell.amounts.fill(Decimal::default());
    } else if cell.counts[6] == 1 && !cell.amounts[0].is_negative() {
        cell.counts[16] = 1;
        cell.amounts[10] = cell.amounts[0].clone();
    }
    Ok(cell)
}

fn validate_current_row(name: &str, key: &[u8], bytes: &[u8]) -> Result<(), Error> {
    if name == BackfillTable::NAME {
        let row = BackfillTable::decode(bytes)?;
        return if key == BackfillTable::primary_key(&row) {
            Ok(())
        } else {
            Err(unproven())
        };
    }
    if bytes.first() != Some(&2) || bytes.len() > crate::analytics::ROW_BYTES {
        return Err(unproven());
    }
    match name {
        CellTable::NAME => CellTable::decode(bytes).map(|_| ()),
        LeafTable::NAME => LeafTable::decode(bytes).map(|_| ()),
        SampleTable::NAME => SampleTable::decode(bytes).map(|_| ()),
        UnpricedTable::NAME => UnpricedTable::decode(bytes).map(|_| ()),
        _ => Err(unproven()),
    }
}

fn validate_current_decimal(read: &ReadTransaction) -> Result<(), Error> {
    let cuts = [
        ("backend", 60_000),
        ("backend", 900_000),
        ("session", 1),
        ("session", 60_000),
        ("session", 900_000),
    ]
    .map(|(family, span)| {
        let cell_prefix = tuple_key(&[
            KeyPart::String(&family.into()),
            KeyPart::I64(span),
            KeyPart::I64(i64::MIN),
        ]);
        tuple_key(&[KeyPart::Bytes(&cell_prefix)])
    });
    if cuts.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(unproven());
    }
    let lower = std::iter::once(Unbounded).chain(cuts.iter().map(|key| Included(key.as_slice())));
    let upper = cuts
        .iter()
        .map(|key| Excluded(key.as_slice()))
        .chain(std::iter::once(Unbounded));
    let leaf_cut = tuple_key(&[KeyPart::String(&"session".into())]);
    let scans = TABLES
        .into_iter()
        .filter(|&name| !matches!(name, LeafTable::NAME | SampleTable::NAME))
        .map(|name| (name, (Unbounded, Unbounded)))
        .chain([
            (LeafTable::NAME, (Unbounded, Excluded(leaf_cut.as_slice()))),
            (LeafTable::NAME, (Included(leaf_cut.as_slice()), Unbounded)),
        ])
        .chain(lower.zip(upper).map(|range| (SampleTable::NAME, range)));
    thread::scope(|scope| {
        let workers = scans
            .map(|(name, range)| {
                thread::Builder::new().spawn_scoped(scope, move || {
                    let table = read.open_table(definition(name))?;
                    for entry in table.range::<&[u8]>(range)? {
                        let (key, value) = entry?;
                        validate_current_row(name, key.value(), value.value())?;
                    }
                    Ok(())
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut validation = Ok(());
        for worker in workers {
            match worker.join().map_err(|_| Error::WriterPanicked)? {
                Err(error @ (Error::Io(_) | Error::Storage(_))) => return Err(error),
                result => validation = validation.and(result),
            }
        }
        validation
    })
}

fn prior_decimal_shape(read: &ReadTransaction) -> Result<bool, Error> {
    let mut prior = false;
    for name in &TABLES[..4] {
        for entry in read.open_table(definition(name))?.iter()? {
            let (_, value) = entry?;
            let bytes = value.value();
            let cell = match *name {
                CellTable::NAME => decode_record::<Cell>(bytes, 2)?,
                LeafTable::NAME => decode_record::<Leaf>(bytes, 2)?.contribution,
                SampleTable::NAME => decode_record::<Sample>(bytes, 2)?.cell,
                UnpricedTable::NAME => decode_record::<Unpriced>(bytes, 2)?.cell,
                _ => return Err(unproven()),
            };
            match (cell.counts.len(), cell.amounts.len()) {
                (16, 10) => {
                    prior_cell(cell, false)?;
                    prior = true;
                }
                (17, 11) if !prior => {
                    validate_current_decimal(read)?;
                    return Ok(false);
                }
                _ => return Err(unproven()),
            }
        }
    }
    for entry in read.open_table(definition(BackfillTable::NAME))?.iter()? {
        let (key, value) = entry?;
        validate_current_row(BackfillTable::NAME, key.value(), value.value())?;
    }
    Ok(prior)
}

fn prepare_decimal(read: &ReadTransaction, budget: &mut Budget) -> Result<Option<Plan>, Error> {
    if !prior_decimal_shape(read)? {
        return Ok(None);
    }
    let mut plan = Plan {
        rows: TABLES
            .into_iter()
            .map(|name| (name, BTreeMap::new()))
            .collect(),
    };
    for entry in read.open_table(definition(CellTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let cell = prior_cell(decode_record(value.value(), 2)?, true)?;
        if key.value() != cell.key() {
            return Err(unproven());
        }
        plan.put::<CellTable>(&cell, budget)?;
    }
    let mut group: Option<(Vec<u8>, u8, i64, Vec<u8>)> = None;
    let mut samples = BTreeMap::new();
    let mut unpriced = BTreeMap::new();
    for entry in read.open_table(definition(LeafTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let mut leaf: Leaf = decode_record(value.value(), 2)?;
        leaf.contribution = prior_cell(leaf.contribution, false)?;
        LeafTable::encode(&leaf)?;
        let contribution = &leaf.contribution;
        if key.value() != LeafTable::primary_key(&leaf)
            || leaf.context
                != contribution.amounts[1]
                    .checked_add(&contribution.amounts[4])?
                    .checked_add(&contribution.amounts[5])?
            || leaf.generation_sample.unwrap_or(0.0) != contribution.generation_rate
            || contribution.counts[13] != i64::from(leaf.generation_sample.is_some())
        {
            return Err(unproven());
        }
        for (metric, value) in leaf.samples.iter().enumerate() {
            if contribution.counts[11 + metric] != i64::from(value.is_some())
                || contribution.amounts[6 + metric] != value.clone().unwrap_or_default()
            {
                return Err(unproven());
            }
        }
        let identity = tuple_key(&[
            KeyPart::String(&leaf.family),
            KeyPart::String(&leaf.source_id),
        ]);
        let bit = match leaf.span {
            1 => 1,
            60_000 => 2,
            900_000 => 4,
            _ => return Err(unproven()),
        };
        let mut comparable = contribution.clone();
        comparable.span = 1;
        comparable.bucket = 0;
        let signature = CellTable::encode(&comparable)?;
        if group
            .as_ref()
            .is_none_or(|(current, _, _, _)| *current != identity)
        {
            if group.as_ref().is_some_and(|(_, mask, _, _)| *mask != 7) || bit != 1 {
                return Err(unproven());
            }
            group = Some((identity, 0, contribution.bucket, signature.clone()));
        }
        let (_, mask, time, expected) = group.as_mut().ok_or_else(unproven)?;
        if *mask & bit != 0
            || *expected != signature
            || time.div_euclid(leaf.span).checked_mul(leaf.span) != Some(contribution.bucket)
        {
            return Err(unproven());
        }
        *mask |= bit;
        for metric in 0..3 {
            let value = if metric < 2 {
                leaf.samples[metric].clone()
            } else {
                None
            };
            let generation_rate = if metric == 2 {
                leaf.generation_sample
            } else {
                None
            };
            if value.is_some() || generation_rate.is_some() {
                witness(
                    &mut samples,
                    SampleTable::primary_key(&Sample {
                        cell: contribution.clone(),
                        metric: metric as i64,
                        value,
                        generation_rate,
                        count: 1,
                    }),
                    budget,
                )?;
            }
        }
        if contribution.counts[7] == 1 {
            witness(
                &mut unpriced,
                UnpricedTable::primary_key(&Unpriced {
                    cell: contribution.clone(),
                    context: leaf.context.clone(),
                    requests: 1,
                    tokens: contribution.amounts[1..6].to_vec(),
                }),
                budget,
            )?;
        }
        plan.contribute(&leaf, budget)?;
    }
    if group.as_ref().is_some_and(|(_, mask, _, _)| *mask != 7) {
        return Err(unproven());
    }
    for entry in read.open_table(definition(CellTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let old: Cell = decode_record(value.value(), 2)?;
        let rebuilt = plan.get::<CellTable>(key.value())?.ok_or_else(unproven)?;
        if old.counts[0] == 0
            || rebuilt.counts[..16] != old.counts
            || rebuilt.amounts[..10] != old.amounts
            || rebuilt.generation_rate.to_bits() != old.generation_rate.to_bits()
        {
            return Err(unproven());
        }
    }
    for entry in read.open_table(definition(SampleTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let mut row: Sample = decode_record(value.value(), 2)?;
        row.cell = prior_cell(row.cell, false)?;
        SampleTable::encode(&row)?;
        if key.value() != SampleTable::primary_key(&row)
            || samples.remove(key.value()) != Some(row.count)
        {
            return Err(unproven());
        }
        plan.put::<SampleTable>(&row, budget)?;
    }
    for entry in read.open_table(definition(UnpricedTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let mut row: Unpriced = decode_record(value.value(), 2)?;
        row.cell = prior_cell(row.cell, false)?;
        UnpricedTable::encode(&row)?;
        let rebuilt = plan
            .get::<UnpricedTable>(key.value())?
            .ok_or_else(unproven)?;
        if key.value() != UnpricedTable::primary_key(&row)
            || unpriced.remove(key.value()) != Some(row.requests)
            || row.tokens != rebuilt.tokens
        {
            return Err(unproven());
        }
        plan.put::<UnpricedTable>(&row, budget)?;
    }
    if !samples.is_empty() || !unpriced.is_empty() {
        return Err(unproven());
    }
    for entry in read.open_table(definition(BackfillTable::NAME))?.iter()? {
        let (_, value) = entry?;
        plan.put::<BackfillTable>(&BackfillTable::decode(value.value())?, budget)?;
    }
    Ok(Some(plan))
}

pub(super) fn prepare(
    read: &ReadTransaction,
    catalog: Catalog,
    budget: &mut Budget,
) -> Result<Option<Plan>, Error> {
    if !catalog.names().contains(&CellTable::NAME) {
        return Ok(None);
    }
    if catalog.version == 5 {
        return prepare_decimal(read, budget);
    }
    let mut plan = Plan {
        rows: TABLES
            .into_iter()
            .map(|name| (name, BTreeMap::new()))
            .collect(),
    };
    for entry in read.open_table(definition(CellTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let old = decode::<LegacyCell>(value.value())?;
        let cell = old.native(true)?;
        if old.counts[0] == 0 {
            return Err(unproven());
        }
        if key.value() != cell.key() {
            return Err(unproven());
        }
        plan.put::<CellTable>(&cell, budget)?;
    }
    let mut samples = BTreeMap::new();
    let mut unpriced = BTreeMap::new();
    let mut group: Option<(Vec<u8>, u8, i64, Vec<u8>)> = None;
    for entry in read.open_table(definition(LeafTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let old = decode::<LegacyLeaf>(value.value())?;
        if old.samples.len() != 3
            || !old.context.is_finite()
            || old
                .samples
                .iter()
                .flatten()
                .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(unproven());
        }
        let contribution = old.contribution.native(false)?;
        let context = contribution.amounts[1]
            .checked_add(&contribution.amounts[4])?
            .checked_add(&contribution.amounts[5])?;
        let leaf = Leaf {
            family: old.family,
            source_id: old.source_id,
            span: old.span,
            contribution: contribution.clone(),
            context,
            samples: old.samples[..2]
                .iter()
                .map(|value| value.map(Decimal::from_f64).transpose())
                .collect::<Result<Vec<_>, _>>()?,
            generation_sample: old.samples[2],
        };
        if key.value() != LeafTable::primary_key(&leaf)
            || contribution.counts[6].checked_add(contribution.counts[7]) != Some(1)
        {
            return Err(unproven());
        }
        for (index, value) in old.samples.iter().enumerate() {
            if contribution.counts[11 + index] != i64::from(value.is_some())
                || old.contribution.amounts[6 + index] != value.unwrap_or(0.0)
            {
                return Err(unproven());
            }
        }
        let identity = tuple_key(&[
            KeyPart::String(&leaf.family),
            KeyPart::String(&leaf.source_id),
        ]);
        let bit = match leaf.span {
            1 => 1,
            60_000 => 2,
            900_000 => 4,
            _ => return Err(unproven()),
        };
        let mut comparable = contribution.clone();
        comparable.span = 1;
        comparable.bucket = 0;
        let signature = CellTable::encode(&comparable)?;
        if group
            .as_ref()
            .is_none_or(|(current, _, _, _)| *current != identity)
        {
            if group.as_ref().is_some_and(|(_, mask, _, _)| *mask != 7) || bit != 1 {
                return Err(unproven());
            }
            group = Some((identity, 0, contribution.bucket, signature.clone()));
        }
        let (_, mask, time, expected) = group.as_mut().ok_or_else(unproven)?;
        if *mask & bit != 0
            || *expected != signature
            || time.div_euclid(leaf.span).checked_mul(leaf.span) != Some(contribution.bucket)
        {
            return Err(unproven());
        }
        *mask |= bit;
        for (metric, value) in old
            .samples
            .iter()
            .enumerate()
            .filter_map(|(metric, value)| value.map(|value| (metric as i64, value)))
        {
            witness(
                &mut samples,
                sample_key(&contribution, metric, value),
                budget,
            )?;
        }
        if contribution.counts[7] == 1 {
            witness(
                &mut unpriced,
                unpriced_key(&contribution, old.context),
                budget,
            )?;
        }
        plan.contribute(&leaf, budget)?;
    }
    if group.as_ref().is_some_and(|(_, mask, _, _)| *mask != 7) {
        return Err(unproven());
    }
    for entry in read.open_table(definition(CellTable::NAME))?.iter()? {
        let (key, value) = entry?;
        if plan
            .get::<CellTable>(key.value())?
            .ok_or_else(unproven)?
            .counts[..16]
            != decode::<LegacyCell>(value.value())?.counts
        {
            return Err(unproven());
        }
    }
    for entry in read.open_table(definition(SampleTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let row = decode::<LegacySample>(value.value())?;
        let cell = row.cell.native(false)?;
        if !row.value.is_finite()
            || row.value < 0.0
            || key.value() != sample_key(&cell, row.metric, row.value)
            || samples.remove(key.value()) != Some(row.count)
        {
            return Err(unproven());
        }
    }
    if !samples.is_empty() {
        return Err(unproven());
    }
    for entry in read.open_table(definition(UnpricedTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let row = decode::<LegacyUnpriced>(value.value())?;
        let cell = row.cell.native(false)?;
        if !row.context.is_finite()
            || row.tokens.len() != 5
            || row.tokens.iter().any(|value| !value.is_finite())
            || key.value() != unpriced_key(&cell, row.context)
            || unpriced.remove(key.value()) != Some(row.requests)
        {
            return Err(unproven());
        }
    }
    if !unpriced.is_empty() {
        return Err(unproven());
    }
    for entry in read.open_table(definition(BackfillTable::NAME))?.iter()? {
        let (key, value) = entry?;
        let row = decode::<Backfill>(value.value())?;
        if key.value() != BackfillTable::primary_key(&row) {
            return Err(unproven());
        }
        plan.put::<BackfillTable>(&row, budget)?;
    }
    Ok(Some(plan))
}

pub(super) fn verify(
    original: &ReadTransaction,
    upgraded: &ReadTransaction,
    catalog: Catalog,
    budget: &mut Budget,
) -> Result<(), Error> {
    let before = budget.0;
    if let Some(plan) = prepare(original, catalog, budget)? {
        plan.verify(upgraded)?;
    }
    budget.0 = before;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Metadata, Options, Store, backup,
        native::{self, DatabaseKind},
        session::Document,
        upgrade::{self, Outcome, Predecessor},
    };
    use redb::ReadableDatabase;
    use std::{
        ops::Bound,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };
    use ycoding_schema::parse_json;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
        key: Vec<u8>,
    }

    fn previous() -> Catalog {
        Catalog::new(
            4,
            Box::leak(
                native::catalog(DatabaseKind::Core)
                    .tables()
                    .iter()
                    .chain(crate::upgrade::artifact_removal::TABLES)
                    .copied()
                    .collect::<Vec<_>>()
                    .into_boxed_slice(),
            ),
        )
    }

    fn encoded(row: &impl Field) -> Vec<u8> {
        let mut bytes = vec![1];
        row.encode(&mut bytes).unwrap();
        bytes
    }

    impl Fixture {
        fn new(unknown: bool) -> Self {
            let root = std::env::temp_dir().join(format!(
                "ycoding-decimal-upgrade-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            let path = root.join("synthetic.redb");
            Store::initialize(
                &path,
                Options::core(),
                previous(),
                Metadata::new([89; 16], 1),
            )
            .unwrap()
            .shutdown()
            .unwrap();
            let dimensions = Dimensions {
                session_id: "ses_legacy".into(),
                project_id: "prj_legacy".into(),
                directory: "/synthetic".into(),
                workspace_id: None,
                session_updated: 1,
                agent: "build".into(),
                source: "step".into(),
                model: Document::new(
                    parse_json(r#"{"providerID":"local","id":"legacy"}"#).unwrap(),
                )
                .unwrap(),
                anchor_session_id: None,
                anchor_input_id: None,
                input_key: None,
                task_path: Vec::new(),
            };
            let database = redb::Database::open(&path).unwrap();
            let write = database.begin_write().unwrap();
            let mut key = Vec::new();
            for span in [1, 60_000, 900_000] {
                let mut aggregate = LegacyCell {
                    family: "backend".into(),
                    span,
                    bucket: 0,
                    dimensions: dimensions.clone(),
                    counts: vec![0; 16],
                    amounts: vec![0.0; 11],
                };
                let mut histograms = BTreeMap::<Vec<u8>, LegacySample>::new();
                let mut prices = BTreeMap::<Vec<u8>, LegacyUnpriced>::new();
                for index in 0..3 {
                    let input = if index == 0 || (unknown && index == 1) {
                        9_007_199_254_740_992.0
                    } else {
                        1.0
                    };
                    let mut cell = aggregate.clone();
                    cell.counts.fill(0);
                    cell.amounts.fill(0.0);
                    cell.counts[0] = 1;
                    cell.counts[1] = 1;
                    cell.counts[if unknown { 7 } else { 6 }] = 1;
                    cell.counts[11..15].fill(1);
                    cell.amounts[0] = if unknown { 0.0 } else { input };
                    cell.amounts[1] = input;
                    if unknown && index == 0 {
                        cell.amounts[4] = 1.0;
                        cell.amounts[5] = 1.0;
                    }
                    let rate = 20.0 + index as f64 * 10.0;
                    cell.amounts[6] = 10.0;
                    cell.amounts[7] = 100.0;
                    cell.amounts[8] = rate;
                    cell.amounts[9] = rate;
                    cell.amounts[10] = 1_000_000_000.0;
                    let context = (cell.amounts[1] + cell.amounts[4]) + cell.amounts[5];
                    let source_id: LosslessString = format!("req_{index}").into();
                    let leaf = LegacyLeaf {
                        family: "backend".into(),
                        source_id: source_id.clone(),
                        span,
                        contribution: cell.clone(),
                        samples: vec![Some(10.0), Some(100.0), Some(rate)],
                        context,
                    };
                    let leaf_key = tuple_key(&[
                        KeyPart::String(&leaf.family),
                        KeyPart::String(&source_id),
                        KeyPart::I64(span),
                    ]);
                    write
                        .open_table(definition(LeafTable::NAME))
                        .unwrap()
                        .insert(leaf_key.as_slice(), encoded(&leaf).as_slice())
                        .unwrap();
                    for (metric, value) in [(0, 10.0), (1, 100.0), (2, rate)] {
                        let native_cell = cell.native(false).unwrap();
                        let row = histograms
                            .entry(sample_key(&native_cell, metric, value))
                            .or_insert_with(|| LegacySample {
                                cell: cell.clone(),
                                metric,
                                value,
                                count: 0,
                            });
                        row.count += 1;
                    }
                    if unknown {
                        let native_cell = cell.native(false).unwrap();
                        let row = prices
                            .entry(unpriced_key(&native_cell, context))
                            .or_insert_with(|| LegacyUnpriced {
                                cell: cell.clone(),
                                context,
                                requests: 0,
                                tokens: vec![0.0; 5],
                            });
                        row.requests += 1;
                        for (target, amount) in row.tokens.iter_mut().zip(&cell.amounts[1..6]) {
                            *target += amount;
                        }
                    }
                    for (target, value) in aggregate.counts.iter_mut().zip(cell.counts) {
                        *target += value;
                    }
                    for (target, value) in aggregate.amounts.iter_mut().zip(cell.amounts) {
                        *target += value;
                    }
                }
                let cell_key = aggregate.native(true).unwrap().key();
                if span == 1 {
                    key = cell_key.clone();
                }
                write
                    .open_table(definition(CellTable::NAME))
                    .unwrap()
                    .insert(cell_key.as_slice(), encoded(&aggregate).as_slice())
                    .unwrap();
                for (key, row) in histograms {
                    write
                        .open_table(definition(SampleTable::NAME))
                        .unwrap()
                        .insert(key.as_slice(), encoded(&row).as_slice())
                        .unwrap();
                }
                for (key, row) in prices {
                    write
                        .open_table(definition(UnpricedTable::NAME))
                        .unwrap()
                        .insert(key.as_slice(), encoded(&row).as_slice())
                        .unwrap();
                }
            }
            let backfill = Backfill {
                family: "backend".into(),
                after: Some("req_2".into()),
                complete: 1,
            };
            write
                .open_table(definition(BackfillTable::NAME))
                .unwrap()
                .insert(
                    BackfillTable::primary_key(&backfill).as_slice(),
                    encoded(&backfill).as_slice(),
                )
                .unwrap();
            write.commit().unwrap();
            drop(database);
            Self { root, key }
        }
        fn path(&self) -> PathBuf {
            self.root.join("synthetic.redb")
        }

        fn decimal(unknown: bool, mixed_sign: bool) -> Self {
            let fixture = Self::new(unknown);
            let database = redb::Database::open(fixture.path()).unwrap();
            let read = database.begin_read().unwrap();
            let mut plan = prepare(&read, previous(), &mut Budget::default())
                .unwrap()
                .unwrap();
            drop(read);
            if mixed_sign {
                for value in plan.rows.get_mut(CellTable::NAME).unwrap().values_mut() {
                    let mut cell = CellTable::decode(value).unwrap();
                    cell.amounts[0] = Decimal::from_f64(2.0).unwrap();
                    cell.amounts[10] = Decimal::from_f64(3.0).unwrap();
                    cell.counts[16] = 2;
                    *value = CellTable::encode(&cell).unwrap();
                }
                for value in plan.rows.get_mut(LeafTable::NAME).unwrap().values_mut() {
                    let mut leaf = LeafTable::decode(value).unwrap();
                    let cost = match leaf.source_id.as_str().unwrap() {
                        "req_0" => 3.0,
                        "req_1" => -1.0,
                        "req_2" => 0.0,
                        _ => unreachable!(),
                    };
                    leaf.contribution.amounts[0] = Decimal::from_f64(cost).unwrap();
                    leaf.contribution.counts[16] = i64::from(cost >= 0.0);
                    leaf.contribution.amounts[10] = Decimal::from_f64(cost.max(0.0)).unwrap();
                    *value = LeafTable::encode(&leaf).unwrap();
                }
            }
            let write = database.begin_write().unwrap();
            plan.apply(&write).unwrap();
            for name in &TABLES[..4] {
                let mut table = write.open_table(definition(name)).unwrap();
                let rows = table
                    .iter()
                    .unwrap()
                    .map(|entry| {
                        let (key, value) = entry.unwrap();
                        (key.value().to_vec(), value.value().to_vec())
                    })
                    .collect::<Vec<_>>();
                for (key, value) in rows {
                    let mut bytes = vec![2];
                    let strip = |cell: &mut Cell| {
                        cell.counts.truncate(16);
                        cell.amounts.truncate(10);
                    };
                    match *name {
                        CellTable::NAME => {
                            let mut row = CellTable::decode(&value).unwrap();
                            strip(&mut row);
                            row.encode(&mut bytes).unwrap();
                        }
                        LeafTable::NAME => {
                            let mut row = LeafTable::decode(&value).unwrap();
                            strip(&mut row.contribution);
                            row.encode(&mut bytes).unwrap();
                        }
                        SampleTable::NAME => {
                            let mut row = SampleTable::decode(&value).unwrap();
                            strip(&mut row.cell);
                            row.encode(&mut bytes).unwrap();
                        }
                        UnpricedTable::NAME => {
                            let mut row = UnpricedTable::decode(&value).unwrap();
                            strip(&mut row.cell);
                            row.encode(&mut bytes).unwrap();
                        }
                        _ => unreachable!(),
                    }
                    table.insert(key.as_slice(), bytes.as_slice()).unwrap();
                }
            }
            let mut metadata = write.open_table(definition("storage_metadata")).unwrap();
            let catalog = native::catalog(DatabaseKind::Core);
            metadata
                .insert(
                    b"catalog_manifest".as_slice(),
                    catalog.manifest().as_slice(),
                )
                .unwrap();
            metadata
                .insert(
                    b"catalog_version".as_slice(),
                    5_u64.to_be_bytes().as_slice(),
                )
                .unwrap();
            drop(metadata);
            write.commit().unwrap();
            drop(database);
            fixture
        }
        fn corrupt(&self, path: &Path, uncovered: bool) {
            let database = redb::Database::open(path).unwrap();
            let write = database.begin_write().unwrap();
            let mut table = write.open_table(definition(LeafTable::NAME)).unwrap();
            let key = table.first().unwrap().unwrap().0.value().to_vec();
            if uncovered {
                table.remove(key.as_slice()).unwrap();
            } else {
                table.insert(key.as_slice(), &[1, 255][..]).unwrap();
            }
            drop(table);
            write.commit().unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn same_catalog_codec_two_appends_exact_spend_and_preserves_prefixes_and_pre_prune_history() {
        let fixture = Fixture::decimal(false, true);
        let path = fixture.path();
        std::fs::copy(&path, backup::path(&path)).unwrap();
        let before = redb::ReadOnlyDatabase::open(&path).unwrap();
        let original_bytes = before
            .begin_read()
            .unwrap()
            .open_table(definition(CellTable::NAME))
            .unwrap()
            .get(fixture.key.as_slice())
            .unwrap()
            .unwrap()
            .value()
            .to_vec();
        assert!(CellTable::decode(&original_bytes).is_err());
        let original = decode_record::<Cell>(&original_bytes, 2).unwrap();
        drop(before);
        assert_eq!(
            super::super::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap(),
            Outcome::Upgraded(Predecessor::BeforeNonnegativeUsageCost)
        );
        for upgraded in [&path, &backup::path(&path)] {
            let store = Store::open(
                upgraded,
                Options::core(),
                native::catalog(DatabaseKind::Core),
            )
            .unwrap();
            let snapshot = store.snapshot().unwrap();
            let cell = snapshot.get::<CellTable>(&fixture.key).unwrap().unwrap();
            assert_eq!(cell.counts[..16], original.counts);
            assert_eq!(cell.amounts[..10], original.amounts);
            assert_eq!(
                cell.generation_rate.to_bits(),
                original.generation_rate.to_bits()
            );
            assert_eq!(cell.counts[16], 2);
            assert_eq!(cell.amounts[10], Decimal::from_f64(3.0).unwrap());
            assert_eq!(CellTable::encode(&cell).unwrap()[0], 2);
            assert_eq!(cell.amounts[0], Decimal::from_f64(2.0).unwrap());
            assert_eq!(
                cell.amounts[1],
                Decimal::from_f64(9_007_199_254_740_992.0)
                    .unwrap()
                    .checked_add(&Decimal::from_f64(2.0).unwrap())
                    .unwrap()
            );
            drop(snapshot);
            store.shutdown().unwrap();
            assert!(backup::upgrade_path(upgraded).exists());
        }
        assert_eq!(
            super::super::core(&path, Options::core(), |_| panic!(
                "current store requested backup space"
            ))
            .unwrap(),
            Outcome::Current
        );
    }

    #[test]
    fn same_catalog_codec_two_preserves_exact_unpriced_contexts_and_markers() {
        let fixture = Fixture::decimal(true, false);
        let path = fixture.path();
        super::super::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap();
        let store =
            Store::open(&path, Options::core(), native::catalog(DatabaseKind::Core)).unwrap();
        let snapshot = store.snapshot().unwrap();
        let cell = snapshot.get::<CellTable>(&fixture.key).unwrap().unwrap();
        assert_eq!(cell.counts[16], 0);
        assert_eq!(cell.amounts[10], Decimal::default());
        let rows = snapshot
            .scan::<UnpricedTable>(Bound::Unbounded, Bound::Unbounded, 20)
            .unwrap();
        assert_eq!(rows.iter().filter(|row| row.cell.span == 1).count(), 3);
        assert_eq!(
            rows.iter()
                .filter(|row| row.cell.span == 1)
                .map(|row| row.requests)
                .sum::<i64>(),
            3
        );
        assert_eq!(
            snapshot
                .get::<BackfillTable>(&tuple_key(&[KeyPart::String(&"backend".into())]))
                .unwrap()
                .unwrap()
                .complete,
            1
        );
        drop(snapshot);
        store.shutdown().unwrap();
    }

    #[test]
    fn invalid_sample_in_the_last_populated_range_refuses_startup_without_writes() {
        let fixture = Fixture::new(false);
        let path = fixture.path();
        let catalog = native::catalog(DatabaseKind::Core);
        upgrade::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap();
        let store = Store::open(&path, Options::core(), catalog).unwrap();
        assert_eq!(
            store.prepare_pruning(0, |_| Ok(u64::MAX)).unwrap(),
            backup::Status::Ready
        );
        store.shutdown().unwrap();
        let unexpected_backup = |_: &Path| panic!("current store requested backup space");
        let options = Options {
            cache_bytes: 64 * 1024,
            ..Options::core()
        };
        assert!(std::fs::metadata(&path).unwrap().len() > options.cache_bytes as u64);
        assert_eq!(
            upgrade::core(&path, options, unexpected_backup).unwrap(),
            Outcome::Current
        );

        let database = redb::Database::open(&path).unwrap();
        let write = database.begin_write().unwrap();
        {
            let mut samples = write.open_table(definition(SampleTable::NAME)).unwrap();
            let (key, mut sample) = samples
                .last()
                .unwrap()
                .map(|(key, value)| {
                    (
                        key.value().to_vec(),
                        SampleTable::decode(value.value()).unwrap(),
                    )
                })
                .unwrap();
            assert_eq!(sample.cell.span, 900_000);
            sample.count = 0;
            let mut malformed = vec![2];
            sample.encode(&mut malformed).unwrap();
            samples
                .insert(key.as_slice(), malformed.as_slice())
                .unwrap();
        }
        write.commit().unwrap();
        drop(database);

        let files = [path.clone(), backup::path(&path), backup::marker(&path)];
        let before = files.each_ref().map(|file| std::fs::read(file).unwrap());
        assert!(matches!(
            upgrade::core(&path, options, unexpected_backup),
            Err(Error::Incompatible("invalid prepared Usage histogram"))
        ));
        assert_eq!(
            files.each_ref().map(|file| std::fs::read(file).unwrap()),
            before
        );
    }

    #[test]
    fn malformed_leaves_outside_known_family_keys_refuse_startup_without_writes() {
        for edge in [[0], [u8::MAX]] {
            let fixture = Fixture::new(false);
            let path = fixture.path();
            upgrade::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap();
            let database = redb::Database::open(&path).unwrap();
            let write = database.begin_write().unwrap();
            {
                let mut leaves = write.open_table(definition(LeafTable::NAME)).unwrap();
                let mut leaf = leaves
                    .first()
                    .unwrap()
                    .map(|(_, value)| LeafTable::decode(value.value()).unwrap())
                    .unwrap();
                leaf.contribution.counts[0] = 2;
                let mut malformed = vec![2];
                leaf.encode(&mut malformed).unwrap();
                leaves
                    .insert(edge.as_slice(), malformed.as_slice())
                    .unwrap();
            }
            write.commit().unwrap();
            drop(database);

            let before = std::fs::read(&path).unwrap();
            assert!(matches!(
                upgrade::core(&path, Options::core(), |_| panic!(
                    "current store requested backup space"
                )),
                Err(Error::Incompatible("invalid prepared Usage leaf"))
            ));
            assert_eq!(std::fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn same_catalog_codec_two_rejects_mixed_malformed_uncovered_and_overflowing_main_or_history_before_writes()
     {
        for history in [false, true] {
            for fault in 0..9 {
                let fixture = Fixture::decimal(false, true);
                let path = fixture.path();
                let pruned = backup::path(&path);
                std::fs::copy(&path, &pruned).unwrap();
                let target = if history { &pruned } else { &path };
                if fault < 2 {
                    fixture.corrupt(target, fault == 0);
                } else {
                    let database = redb::Database::open(target).unwrap();
                    let write = database.begin_write().unwrap();
                    if fault == 7 {
                        let mut table = write.open_table(definition(LeafTable::NAME)).unwrap();
                        let rows = table
                            .iter()
                            .unwrap()
                            .map(|entry| {
                                let (key, value) = entry.unwrap();
                                (key.value().to_vec(), value.value().to_vec())
                            })
                            .collect::<Vec<_>>();
                        for (key, value) in rows {
                            let mut leaf: Leaf = decode_record(&value, 2).unwrap();
                            if leaf.source_id == "req_0".into() {
                                leaf.contribution.counts[1] = i64::MAX;
                                let mut bytes = vec![2];
                                leaf.encode(&mut bytes).unwrap();
                                table.insert(key.as_slice(), bytes.as_slice()).unwrap();
                            }
                        }
                    } else {
                        let mut table = write.open_table(definition(CellTable::NAME)).unwrap();
                        let (key, value) = table
                            .first()
                            .unwrap()
                            .map(|(key, value)| (key.value().to_vec(), value.value().to_vec()))
                            .unwrap();
                        let mut cell: Cell = decode_record(&value, 2).unwrap();
                        match fault {
                            2 => {
                                cell = prior_cell(cell, false).unwrap();
                            }
                            3 => {
                                cell.counts.push(0);
                            }
                            4 => {
                                cell.amounts[0] = Decimal::from_f64(7.0).unwrap();
                            }
                            5 => {
                                table.remove(key.as_slice()).unwrap();
                            }
                            6 => {
                                cell.counts[0] = -1;
                            }
                            8 => {
                                cell.amounts.push(Decimal::default());
                            }
                            _ => unreachable!(),
                        }
                        if fault != 5 {
                            let mut bytes = vec![2];
                            cell.encode(&mut bytes).unwrap();
                            table.insert(key.as_slice(), bytes.as_slice()).unwrap();
                        }
                    }
                    write.commit().unwrap();
                    drop(database);
                }
                let main_before = std::fs::read(&path).unwrap();
                let history_before = std::fs::read(&pruned).unwrap();
                assert!(
                    super::super::core(&path, Options::core(), |_| panic!(
                        "unproven store requested backup space"
                    ))
                    .is_err(),
                    "history={history} fault={fault}"
                );
                assert_eq!(std::fs::read(&path).unwrap(), main_before);
                assert_eq!(std::fs::read(&pruned).unwrap(), history_before);
                assert!(!backup::upgrade_path(&path).exists());
                assert!(!backup::upgrade_path(&pruned).exists());
            }
        }
    }

    #[test]
    fn same_catalog_codec_two_resumes_proven_history_and_refuses_modified_upgraded_history() {
        for tamper in [false, true] {
            let fixture = Fixture::decimal(false, true);
            let path = fixture.path();
            let pruned = backup::path(&path);
            std::fs::copy(&path, &pruned).unwrap();
            super::super::core(&pruned, Options::core(), |_| Ok(u64::MAX)).unwrap();
            if tamper {
                let database = redb::Database::open(&pruned).unwrap();
                let write = database.begin_write().unwrap();
                let mut table = write.open_table(definition(CellTable::NAME)).unwrap();
                let (key, value) = table
                    .first()
                    .unwrap()
                    .map(|(key, value)| (key.value().to_vec(), value.value().to_vec()))
                    .unwrap();
                let mut cell = CellTable::decode(&value).unwrap();
                cell.amounts[10] = Decimal::from_f64(4.0).unwrap();
                table
                    .insert(key.as_slice(), CellTable::encode(&cell).unwrap().as_slice())
                    .unwrap();
                drop(table);
                write.commit().unwrap();
                drop(database);
            }
            let main_before = std::fs::read(&path).unwrap();
            let history_before = std::fs::read(&pruned).unwrap();
            let result = super::super::core(&path, Options::core(), |_| {
                assert!(!tamper, "unproven history requested backup space");
                Ok(u64::MAX)
            });
            if tamper {
                assert!(result.is_err());
                assert_eq!(std::fs::read(&path).unwrap(), main_before);
                assert_eq!(std::fs::read(&pruned).unwrap(), history_before);
                assert!(!backup::upgrade_path(&path).exists());
            } else {
                assert_eq!(
                    result.unwrap(),
                    Outcome::Upgraded(Predecessor::BeforeNonnegativeUsageCost)
                );
                assert_eq!(
                    super::super::core(&path, Options::core(), |_| panic!(
                        "current store requested backup space"
                    ))
                    .unwrap(),
                    Outcome::Current
                );
            }
        }
    }

    #[test]
    fn current_or_empty_main_still_upgrades_same_catalog_predecessor_history_without_rewriting_main()
     {
        for empty in [false, true] {
            let fixture = Fixture::decimal(false, true);
            let path = fixture.path();
            let pruned = backup::path(&path);
            std::fs::copy(&path, &pruned).unwrap();
            let database = redb::Database::open(&path).unwrap();
            let read = database.begin_read().unwrap();
            let plan = prepare(
                &read,
                native::catalog(DatabaseKind::Core),
                &mut Budget::default(),
            )
            .unwrap()
            .unwrap();
            drop(read);
            let write = database.begin_write().unwrap();
            plan.apply(&write).unwrap();
            if empty {
                for name in &TABLES[..4] {
                    let mut table = write.open_table(definition(name)).unwrap();
                    let keys = table
                        .iter()
                        .unwrap()
                        .map(|entry| entry.unwrap().0.value().to_vec())
                        .collect::<Vec<_>>();
                    for key in keys {
                        table.remove(key.as_slice()).unwrap();
                    }
                }
            }
            write.commit().unwrap();
            drop(database);
            let main_before = std::fs::read(&path).unwrap();
            assert_eq!(
                super::super::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap(),
                Outcome::Upgraded(Predecessor::BeforeNonnegativeUsageCost)
            );
            assert_eq!(std::fs::read(&path).unwrap(), main_before);
            assert!(!backup::upgrade_path(&path).exists());
            assert!(backup::upgrade_path(&pruned).exists());
            let store = Store::open(
                &pruned,
                Options::core(),
                native::catalog(DatabaseKind::Core),
            )
            .unwrap();
            assert_eq!(
                store
                    .snapshot()
                    .unwrap()
                    .get::<CellTable>(&fixture.key)
                    .unwrap()
                    .unwrap()
                    .counts[16],
                2
            );
            store.shutdown().unwrap();
            assert_eq!(
                super::super::core(&path, Options::core(), |_| panic!(
                    "current store requested backup space"
                ))
                .unwrap(),
                Outcome::Current
            );
        }
    }

    #[test]
    fn same_catalog_codec_two_reconstruction_obeys_existing_shared_memory_budget() {
        let fixture = Fixture::decimal(false, true);
        let database = redb::ReadOnlyDatabase::open(fixture.path()).unwrap();
        assert!(
            prepare(
                &database.begin_read().unwrap(),
                native::catalog(DatabaseKind::Core),
                &mut Budget(MEMORY_BYTES)
            )
            .is_err()
        );
        assert!(!backup::upgrade_path(&fixture.path()).exists());
    }

    #[test]
    fn retained_legacy_leaves_reconstruct_exact_cells_and_pre_prune_history_before_version_commit()
    {
        let fixture = Fixture::new(false);
        let path = fixture.path();
        std::fs::copy(&path, backup::path(&path)).unwrap();
        assert_eq!(
            upgrade::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap(),
            Outcome::Upgraded(Predecessor::BeforeUsageDecimal)
        );
        for upgraded in [&path, &backup::path(&path)] {
            let store = Store::open(
                upgraded,
                Options::core(),
                native::catalog(DatabaseKind::Core),
            )
            .unwrap();
            let snapshot = store.client().snapshot().unwrap();
            let cell = snapshot.get::<CellTable>(&fixture.key).unwrap().unwrap();
            assert_eq!(cell.amounts[0].to_f64().unwrap(), 9_007_199_254_740_994.0);
            assert_eq!(cell.amounts[1].to_f64().unwrap(), 9_007_199_254_740_994.0);
            assert_eq!(cell.generation_rate.to_bits(), 90.0_f64.to_bits());
            assert_eq!(cell.counts[0], 3);
            assert_eq!(cell.counts[13], 3);
            drop(snapshot);
            store.shutdown().unwrap();
        }
        assert_eq!(
            upgrade::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap(),
            Outcome::Current
        );
        assert!(Store::open(&path, Options::core(), previous()).is_err());
        let store =
            Store::open(&path, Options::core(), native::catalog(DatabaseKind::Core)).unwrap();
        let snapshot = store.client().snapshot().unwrap();
        assert_eq!(
            snapshot
                .get::<CellTable>(&fixture.key)
                .unwrap()
                .unwrap()
                .amounts[0]
                .to_f64()
                .unwrap(),
            9_007_199_254_740_994.0
        );
        drop(snapshot);
        store.shutdown().unwrap();
        assert!(backup::upgrade_path(&path).exists());
        assert!(backup::upgrade_path(&backup::path(&path)).exists());
    }

    #[test]
    fn legacy_price_contexts_split_from_exact_leaf_inputs_instead_of_rounded_group_totals() {
        let fixture = Fixture::new(true);
        let path = fixture.path();
        upgrade::core(&path, Options::core(), |_| Ok(u64::MAX)).unwrap();
        let store =
            Store::open(&path, Options::core(), native::catalog(DatabaseKind::Core)).unwrap();
        let snapshot = store.client().snapshot().unwrap();
        let cell = snapshot.get::<CellTable>(&fixture.key).unwrap().unwrap();
        let context = Decimal::from_f64(9_007_199_254_740_994.0).unwrap();
        let row = Unpriced {
            cell,
            context,
            requests: 1,
            tokens: Vec::new(),
        };
        let row = snapshot
            .get::<UnpricedTable>(&UnpricedTable::primary_key(&row))
            .unwrap()
            .unwrap();
        assert_eq!(row.requests, 1);
        assert_eq!(row.tokens[3], Decimal::from_i64(1));
        assert_eq!(row.tokens[4], Decimal::from_i64(1));
        drop(snapshot);
        store.shutdown().unwrap();
    }

    #[test]
    fn unproven_or_corrupt_main_and_pre_prune_history_refuses_before_any_file_changes() {
        for failure in 0..3 {
            let fixture = Fixture::new(false);
            let path = fixture.path();
            let pruned = backup::path(&path);
            std::fs::copy(&path, &pruned).unwrap();
            let bad = if failure == 2 { &pruned } else { &path };
            fixture.corrupt(bad, failure != 1);
            let before = [
                std::fs::read(&path).unwrap(),
                std::fs::read(&pruned).unwrap(),
            ];
            let files = std::fs::read_dir(&fixture.root).unwrap().count();
            assert!(upgrade::core(&path, Options::core(), |_| Ok(u64::MAX)).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), before[0]);
            assert_eq!(std::fs::read(&pruned).unwrap(), before[1]);
            assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), files);
            assert!(!backup::upgrade_path(&path).exists());
            assert!(!backup::upgrade_path(&pruned).exists());
        }
    }
}
