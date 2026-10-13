use super::{Error, empty, window};
use std::{collections::BTreeMap, ops::Bound};
use ycoding_schema::{provider, provider_usage::Snapshot};
use ycoding_store::{Client, TableSpec, resources::RequestTable};

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
    let snapshot = store.snapshot().map_err(|_| Error::Storage)?;
    let mut cursor = None;
    let mut rows = Vec::new();
    loop {
        let page = snapshot
            .scan::<RequestTable>(
                cursor.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                128,
            )
            .map_err(|_| Error::Storage)?;
        cursor = page.last().map(RequestTable::primary_key);
        for row in page {
            rows.push(LocalSpendRow {
                provider_id: row.model.domain().map_err(|_| Error::Storage)?.provider_id,
                cost: row.cost,
                time_created: row.time_created,
            });
        }
        if cursor.is_none() {
            return local_spend_snapshots(&rows, now);
        }
    }
}
