use super::{Error, empty, window};
use std::collections::BTreeMap;
use ycoding_schema::{provider, provider_usage::Snapshot};
use ycoding_store::{
    Client,
    analytics::{Query, Value, reports},
};

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
            || !["anthropic", "openai"]
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
                Some("anthropic") => "Claude",
                Some("openai") => "Openai",
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
    let rows = store.analytics().map_err(|_| Error::Storage)?.report(vec![Query {
        sql: "SELECT provider, sum(cost) FROM session_provider_request WHERE time_created >= $1 AND time_created < $2 AND cost >= 0 AND isfinite(cost) AND provider IN ('anthropic', 'openai') GROUP BY provider ORDER BY provider",
        parameters: vec![Value::BigInt(start), Value::BigInt(end)], max_rows: 2,
    }]).map_err(|_| Error::Storage)?.remove(0).into_iter().map(|row| {
        Ok(LocalSpendRow { provider_id: provider::Id(reports::value_text(&row[0]).map_err(|_| Error::Storage)?.into()),
            cost: Some(reports::value_number(&row[1]).map_err(|_| Error::Storage)?), time_created: now })
    }).collect::<Result<Vec<_>, Error>>()?;
    local_spend_snapshots(&rows, now)
}
