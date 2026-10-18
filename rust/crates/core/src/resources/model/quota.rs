use super::super::catalog::{field, models_dev::text};
use std::{
    collections::BTreeMap,
    fmt,
    future::Future,
    sync::{Arc, Mutex},
};
use tokio::{sync::watch, task::JoinHandle};
use ycoding_schema::{
    JsonValue, provider,
    provider_usage::{Snapshot, Window},
    schema::NonNegativeInt,
};
pub mod forecast;
pub mod pace;
pub mod pace_alerts;
mod service;
pub use service::{Endpoints, Service};
pub use ycoding_ai::muse::{normalize_usage, unreported};
mod normalize;
pub use normalize::{normalize_claude, normalize_codex, normalize_organization, normalize_zai};
mod app_server;
pub use app_server::{AppServerCommand, load_app_server};
mod spend;
pub use spend::{LocalSpendRow, local_spend_from_store, local_spend_snapshots};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Request(Option<u16>),
    RequestWithRetry { status: u16, retry_after_ms: u64 },
    InvalidResponse,
    Closed,
    Worker,
    Rpc,
    Timeout,
    BufferLimit,
    Storage,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Request(_) | Self::RequestWithRetry { .. } => "Provider usage refresh failed",
            Self::InvalidResponse => "Invalid provider usage response",
            Self::Closed => "Provider usage cache closed",
            Self::Worker => "Provider usage worker failed",
            Self::Rpc => "Codex app-server RPC failed",
            Self::Timeout => "Codex app-server request timed out",
            Self::BufferLimit => "Codex app-server response exceeded 1 MiB",
            Self::Storage => "Provider usage storage failed",
        })
    }
}
impl std::error::Error for Error {}
type Pending = watch::Receiver<Option<Result<Snapshot, Error>>>;
struct Entry {
    value: Option<Snapshot>,
    retry: Option<(i64, Error)>,
    expires_at: i64,
    pending: Option<Pending>,
}
#[derive(Default)]
struct State {
    entries: BTreeMap<String, Entry>,
    tasks: Vec<JoinHandle<()>>,
    closed: bool,
}
#[derive(Clone, Default)]
pub struct Cache(Arc<Mutex<State>>);
impl Cache {
    pub fn new() -> Self {
        Self::default()
    }
    pub async fn get<F, Fut>(
        &self,
        key: String,
        now: i64,
        ttl: i64,
        refresh: bool,
        load: F,
    ) -> Result<Snapshot, Error>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = Result<Snapshot, Error>> + Send + 'static,
    {
        let mut receiver = {
            let mut state = self.0.lock().map_err(|_| Error::Worker)?;
            if state.closed {
                return Err(Error::Closed);
            }
            let current = state.entries.get(&key);
            if let Some(current) = current
                && let Some((deadline, error)) = current.retry
                && deadline > now
            {
                return current.value.clone().map(Ok).unwrap_or(Err(error));
            }
            if !refresh
                && let Some(current) = current
                && current.expires_at > now
                && let Some(value) = &current.value
            {
                return Ok(value.clone());
            }
            if let Some(pending) = current.and_then(|e| e.pending.clone()) {
                pending
            } else {
                let previous = current.and_then(|e| e.value.clone());
                let (sender, receiver) = watch::channel(None);
                state.entries.insert(
                    key.clone(),
                    Entry {
                        value: previous.clone(),
                        retry: None,
                        expires_at: 0,
                        pending: Some(receiver.clone()),
                    },
                );
                let weak = Arc::downgrade(&self.0);
                let task = tokio::spawn(async move {
                    let started = std::time::Instant::now();
                    let loaded = load().await;
                    let Some(state) = weak.upgrade() else {
                        return;
                    };
                    let Ok(mut state) = state.lock() else {
                        let _ = sender.send(Some(Err(Error::Worker)));
                        return;
                    };
                    let completed = now
                        .saturating_add(started.elapsed().as_millis().min(i64::MAX as u128) as i64);
                    let result = match loaded {
                        Ok(snapshot) => {
                            state.entries.insert(
                                key,
                                Entry {
                                    value: Some(snapshot.clone()),
                                    retry: None,
                                    expires_at: completed.saturating_add(ttl),
                                    pending: None,
                                },
                            );
                            Ok(snapshot)
                        }
                        Err(error) => {
                            let retry = if let Error::RequestWithRetry { retry_after_ms, .. } =
                                error
                            {
                                Some((
                                    completed
                                        .saturating_add(retry_after_ms.min(i64::MAX as u64) as i64),
                                    error,
                                ))
                            } else {
                                None
                            };
                            if let Some(previous) = previous {
                                let mut stale = previous.clone();
                                stale.status = "stale".into();
                                stale.profile = None;
                                stale.message = Some("Provider usage refresh failed".into());
                                state.entries.insert(
                                    key,
                                    Entry {
                                        value: Some(stale.clone()),
                                        retry,
                                        expires_at: completed.saturating_add(ttl.min(30_000)),
                                        pending: None,
                                    },
                                );
                                Ok(stale)
                            } else {
                                if retry.is_some() {
                                    state.entries.insert(
                                        key,
                                        Entry {
                                            value: None,
                                            retry,
                                            expires_at: completed,
                                            pending: None,
                                        },
                                    );
                                } else {
                                    state.entries.remove(&key);
                                }
                                Err(error)
                            }
                        }
                    };
                    let _ = sender.send(Some(result));
                });
                state.tasks.push(task);
                receiver
            }
        };
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result;
            }
            receiver.changed().await.map_err(|_| Error::Worker)?;
        }
    }
    pub fn peek(&self, key: &str) -> Result<Option<Snapshot>, Error> {
        let state = self.0.lock().map_err(|_| Error::Worker)?;
        if state.closed {
            return Err(Error::Closed);
        }
        Ok(state.entries.get(key).and_then(|entry| entry.value.clone()))
    }
    pub fn put(&self, key: String, snapshot: Snapshot, now: i64, ttl: i64) -> Result<(), Error> {
        let mut state = self.0.lock().map_err(|_| Error::Worker)?;
        if state.closed {
            return Err(Error::Closed);
        }
        state.entries.insert(
            key,
            Entry {
                value: Some(snapshot),
                retry: None,
                expires_at: now.saturating_add(ttl),
                pending: None,
            },
        );
        Ok(())
    }
    pub fn clear(&self, key: Option<&str>) -> Result<(), Error> {
        let mut state = self.0.lock().map_err(|_| Error::Worker)?;
        if let Some(key) = key {
            state.entries.remove(key);
            return Ok(());
        }
        state.entries.clear();
        Ok(())
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        let tasks = {
            let mut state = self.0.lock().map_err(|_| Error::Worker)?;
            state.closed = true;
            std::mem::take(&mut state.tasks)
        };
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            if let Err(error) = task.await
                && !error.is_cancelled()
            {
                return Err(Error::Worker);
            }
        }
        Ok(())
    }
}
impl Drop for State {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

pub fn normalize_openrouter(
    provider: provider::Id,
    label: &str,
    updated: i64,
    response: &JsonValue,
    credits: Option<&JsonValue>,
) -> Result<Snapshot, Error> {
    let data = field(response, "data")
        .filter(|v| matches!(v, JsonValue::Object(_)))
        .ok_or(Error::InvalidResponse)?;
    for key in [
        "usage",
        "usage_daily",
        "usage_weekly",
        "usage_monthly",
        "limit",
        "limit_remaining",
    ] {
        amount(field(data, key))?;
    }
    let mut snapshot = empty(provider, label, updated, "provider_api", "stable");
    if let Some(JsonValue::Bool(free)) = field(data, "is_free_tier") {
        snapshot.label = format!(
            "{label} · {}",
            if *free { "Free tier" } else { "Pay as you go" }
        )
        .into();
    }
    let limit = amount(field(data, "limit"))?;
    let remaining = amount(field(data, "limit_remaining"))?;
    if let Some(limit) = limit.filter(|v| *v != 0.0) {
        let mut window = window("key", "Key Limit", "usd");
        window.limit = Some(limit);
        window.remaining = remaining;
        window.used = remaining.map(|r| (limit - r).max(0.0));
        snapshot.windows.push(window);
    }
    for (id, label, key) in [
        ("daily", "Today", "usage_daily"),
        ("weekly", "This Week", "usage_weekly"),
        ("monthly", "This Month", "usage_monthly"),
    ] {
        if let Some(used) = amount(field(data, key))? {
            let mut window = window(id, label, "usd");
            window.used = Some(used);
            snapshot.windows.push(window);
        }
    }
    if let Some(credits) = credits {
        let data = field(credits, "data").ok_or(Error::InvalidResponse)?;
        let limit = amount(field(data, "total_credits"))?.ok_or(Error::InvalidResponse)?;
        let used = amount(field(data, "total_usage"))?.ok_or(Error::InvalidResponse)?;
        let balance = (limit - used).max(0.0);
        if limit != 0.0 {
            let mut w = window("credits", "Credits", "usd");
            w.limit = Some(limit);
            w.used = Some(used);
            w.remaining = Some(balance);
            snapshot.windows.push(w);
        }
        let mut w = window("balance", "Balance", "usd");
        w.remaining = Some(balance);
        snapshot.windows.push(w);
    }
    Ok(snapshot)
}
pub fn normalize_cursor(
    provider: provider::Id,
    label: &str,
    updated: i64,
    usage: &JsonValue,
    plan: Option<&JsonValue>,
) -> Result<Snapshot, Error> {
    let data = field(usage, "planUsage")
        .filter(|v| matches!(v, JsonValue::Object(_)))
        .ok_or(Error::InvalidResponse)?;
    let mut snapshot = empty(
        provider,
        label,
        updated,
        "provider_internal_api",
        "best_effort",
    );
    if let Some(name) = plan
        .and_then(|p| field(p, "planInfo"))
        .and_then(|p| field(p, "planName"))
        .and_then(text)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        snapshot.label = format!("{label} {name}").into();
    }
    for (id, label, key) in [
        ("included", "Included", "totalPercentUsed"),
        ("auto", "Auto", "autoPercentUsed"),
        ("api", "API", "apiPercentUsed"),
    ] {
        if let Ok(Some(used)) = amount(field(data, key)) {
            let mut w = window(id, label, "percent");
            w.used = Some(used.min(100.0));
            if id == "included" {
                let start = epoch(field(usage, "billingCycleStart"));
                let end = epoch(field(usage, "billingCycleEnd"));
                w.reset_at = end;
                if let (Some(start), Some(end)) = (start, end)
                    && end.get() > start.get()
                {
                    w.period_seconds = NonNegativeInt::new(
                        ((end.get() - start.get()) as f64 / 1000.0).round() as i64,
                    )
                    .ok();
                }
            }
            snapshot.windows.push(w);
        }
    }
    Ok(snapshot)
}
fn epoch(value: Option<&JsonValue>) -> Option<NonNegativeInt> {
    let value = match value? {
        JsonValue::String(s) => s.as_str()?.trim().parse::<f64>().ok()?,
        JsonValue::Number(n) => *n,
        _ => return None,
    };
    if value.is_finite() && value >= 0.0 {
        NonNegativeInt::new(value.trunc() as i64).ok()
    } else {
        None
    }
}
pub(crate) fn amount(value: Option<&JsonValue>) -> Result<Option<f64>, Error> {
    match value {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::Number(n)) if n.is_finite() && *n >= 0.0 => Ok(Some(*n)),
        _ => Err(Error::InvalidResponse),
    }
}
pub(crate) fn empty(
    provider: provider::Id,
    label: &str,
    updated: i64,
    source: &str,
    stability: &str,
) -> Snapshot {
    Snapshot {
        provider_id: provider,
        label: label.into(),
        profile: None,
        status: "available".into(),
        source: source.into(),
        stability: stability.into(),
        updated_at: NonNegativeInt::new(updated.max(0)).expect("nonnegative"),
        windows: vec![],
        message: None,
    }
}
pub(crate) fn window(id: &str, label: &str, unit: &str) -> Window {
    Window {
        id: id.into(),
        label: label.into(),
        unit: unit.into(),
        used: None,
        limit: None,
        remaining: None,
        unlimited: None,
        reset_at: None,
        period_seconds: None,
    }
}
