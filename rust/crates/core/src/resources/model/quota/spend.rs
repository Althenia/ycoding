use super::{Error, empty, window};
use std::collections::BTreeMap;
use ycoding_schema::{provider, provider_usage::Snapshot};
use ycoding_store::{Client, Decimal};

pub struct LocalSpendRow {
    pub provider_id: provider::Id,
    pub cost: Option<f64>,
    pub time_created: i64,
}
pub fn local_spend_snapshots(rows: &[LocalSpendRow], now: i64) -> Result<Vec<Snapshot>, Error> {
    let (start, end) =
        crate::resources::catalog::date::day_bounds(now).ok_or(Error::InvalidResponse)?;
    let mut totals = BTreeMap::new();
    for row in rows {
        let Some(cost) = row.cost.filter(|cost| cost.is_finite() && *cost >= 0.0) else {
            continue;
        };
        if row.time_created < start
            || row.time_created >= end
            || !["anthropic", "openai", "opencode", "opencode-go", "xai"]
                .iter()
                .any(|id| row.provider_id.0 == (*id).into())
        {
            continue;
        }
        *totals.entry(row.provider_id.clone()).or_insert(0.0) += cost;
    }
    Ok(totals
        .into_iter()
        .map(|(provider, used)| {
            let label = match provider.0.as_str() {
                Some("opencode") => "OpenCode Zen",
                Some("opencode-go") => "OpenCode Go",
                Some("anthropic") => "Claude",
                Some("openai") => "Openai",
                Some("xai") => "Xai",
                _ => unreachable!(),
            };
            let mut snapshot = empty(provider, label, now, "local_session", "stable");
            snapshot.profile = Some("YCoding local".into());
            let mut today = window("today", "Today", "usd");
            today.used = Some(used);
            snapshot.windows.push(today);
            snapshot
        })
        .collect())
}
pub fn local_spend_from_store(store: &Client, now: i64) -> Result<Vec<Snapshot>, Error> {
    let (start, end) =
        crate::resources::catalog::date::day_bounds(now).ok_or(Error::InvalidResponse)?;
    let read = crate::session::usage_read::Read::new(store).map_err(|_| Error::Storage)?;
    let mut totals = BTreeMap::<provider::Id, Decimal>::new();
    read.cells("backend", None, 900_000, Some(start), Some(end), |row| {
        let model = row.cell.dimensions.model.domain()?;
        if row.cell.counts[16] > 0
            && ["anthropic", "openai", "opencode", "opencode-go", "xai"]
                .iter()
                .any(|id| model.provider_id.0 == (*id).into())
        {
            let total = totals.entry(model.provider_id).or_default();
            *total = total.checked_add(&row.cell.amounts[10])?;
        }
        Ok(())
    })
    .map_err(|_| Error::Storage)?;
    let rows = totals
        .into_iter()
        .map(|(provider_id, cost)| {
            Ok(LocalSpendRow {
                provider_id,
                cost: Some(cost.to_f64().map_err(|_| Error::Storage)?),
                time_created: now,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    local_spend_snapshots(&rows, now)
}
