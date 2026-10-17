use crate::session::retention::Settings;
use chrono::{DateTime, SecondsFormat};
use std::ops::Bound;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ycoding_schema::{DomainDecode, DomainEncode, schema::Int, telemetry};
use ycoding_store::analytics::{Query, Value, reports};
use ycoding_store::{Client, KeyPart, TableSpec, Write, resources, session::Document, tuple_key};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
pub const MAX_ROWS: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Storage,
    Derived,
    Disabled,
    InvalidSample,
    InvalidConsent,
    InvalidCursor,
    InvalidLimit,
}
impl From<ycoding_store::Error> for Error {
    fn from(_: ycoding_store::Error) -> Self {
        Self::Storage
    }
}

#[derive(Clone)]
pub struct Service {
    store: Client,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    settings: Arc<dyn Fn() -> Settings + Send + Sync>,
}
impl Service {
    pub fn new(store: Client, settings: Arc<dyn Fn() -> Settings + Send + Sync>) -> Self {
        Self::with_clock(
            store,
            Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64
            }),
            settings,
        )
    }
    pub fn with_clock(
        store: Client,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        settings: Arc<dyn Fn() -> Settings + Send + Sync>,
    ) -> Self {
        Self {
            store,
            clock,
            settings,
        }
    }
    fn cutoff(&self, now: i64) -> i64 {
        now.saturating_sub((self.settings)().latency_days.saturating_mul(DAY_MS))
    }

    pub fn consent(&self) -> Result<telemetry::ConsentState, Error> {
        let row = self
            .store
            .snapshot()?
            .get::<resources::ConsentTable>(&tuple_key(&[KeyPart::I64(1)]))?;
        Ok(telemetry::ConsentState {
            notice_version: telemetry::NoticeVersion,
            consent: row
                .map(|row| {
                    if row.notice_version != telemetry::CURRENT_NOTICE_VERSION
                        || ![0, 1].contains(&row.enabled)
                        || row.decided_at < 0
                    {
                        return Err(Error::InvalidConsent);
                    }
                    Ok(telemetry::Consent {
                        enabled: row.enabled == 1,
                        notice_version: telemetry::NoticeVersion,
                        decided_at: Int::new(row.decided_at).map_err(|_| Error::InvalidConsent)?,
                    })
                })
                .transpose()?,
        })
    }
    pub async fn set_consent(
        &self,
        input: telemetry::ConsentInput,
    ) -> Result<telemetry::Consent, Error> {
        let decided_at = (self.clock)();
        let consent = telemetry::Consent::decode(
            &ycoding_schema::ObjectEncoder::new()
                .field("enabled", &input.enabled)
                .field("noticeVersion", &input.notice_version)
                .field(
                    "decidedAt",
                    &Int::new(decided_at).map_err(|_| Error::InvalidConsent)?,
                )
                .finish(),
        )
        .map_err(|_| Error::InvalidConsent)?;
        let enabled = input.enabled;
        self.store
            .submit(move |tx| {
                resources::ConsentTable::put(
                    tx,
                    &resources::Consent {
                        id: 1,
                        enabled: i64::from(enabled),
                        notice_version: telemetry::CURRENT_NOTICE_VERSION,
                        decided_at,
                    },
                )?;
                if !enabled {
                    resources::purge_telemetry(tx)?;
                }
                Ok(())
            })?
            .await?;
        purge_pending(&self.store).await?;
        Ok(consent)
    }
    pub async fn append(&self, samples: Vec<telemetry::Sample>) -> Result<usize, Error> {
        let batch = telemetry::Batch::decode(&telemetry::Batch { samples }.encode())
            .map_err(|_| Error::InvalidSample)?;
        if !batch.samples.iter().all(valid_sample) {
            return Err(Error::InvalidSample);
        }
        let received_at = (self.clock)();
        let cutoff = self.cutoff(received_at);
        if received_at < 0 {
            return Err(Error::Storage);
        }
        let samples = batch
            .samples
            .iter()
            .map(Document::from_domain)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Error::InvalidSample)?;
        let accepted = self
            .store
            .submit(move |tx| {
                if !allowed(tx)? {
                    return Ok(Err(Error::Disabled));
                }
                prune(tx, cutoff)?;
                for sample in &samples {
                    resources::append_latency(tx, received_at, sample)?;
                }
                let mut count = 0;
                let mut after = None;
                loop {
                    let page = tx.scan::<resources::LatencyTable>(
                        after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                        Bound::Unbounded,
                        128,
                    )?;
                    count += page.len();
                    if page.len() < 128 {
                        break;
                    }
                    after = page.last().map(resources::LatencyTable::primary_key);
                }
                let mut excess = count.saturating_sub(MAX_ROWS);
                while excess > 0 {
                    let page = tx.scan::<resources::LatencyTable>(
                        Bound::Unbounded,
                        Bound::Unbounded,
                        excess.min(128),
                    )?;
                    for row in &page {
                        resources::LatencyTable::delete(
                            tx,
                            &resources::LatencyTable::primary_key(row),
                        )?;
                    }
                    excess -= page.len();
                }
                if count > MAX_ROWS {
                    ycoding_store::analytics::privacy_changed(tx, Vec::new(), true)?;
                }
                Ok(Ok(samples.len()))
            })?
            .await??;
        purge_pending(&self.store).await?;
        Ok(accepted)
    }
    pub async fn list(
        &self,
        limit: Option<usize>,
        before: Option<&str>,
    ) -> Result<telemetry::Page, Error> {
        let limit = limit.unwrap_or(60);
        if !(1..=200).contains(&limit) {
            return Err(Error::InvalidLimit);
        }
        let before = before.map(parse_cursor).transpose()?;
        let cutoff = self.cutoff((self.clock)());
        self.prune_before(cutoff).await?;
        let snapshot = self.store.snapshot()?;
        if !resources::telemetry_allowed(&snapshot, &[])? {
            return Ok(telemetry::Page {
                data: Vec::new(),
                cursor: telemetry::Cursor { next: None },
            });
        }
        drop(snapshot);
        let handle = self.store.analytics().map_err(|_| Error::Storage)?;
        let mut selected = tokio::task::spawn_blocking(move || handle.report(vec![Query {
            sql: "SELECT id, received_at, kind, sampled_at, operation, outcome, reason, queue_ms, settlement_ms, total_ms, surface, metric, duration_ms FROM web_latency WHERE received_at >= $1 AND ($2 IS NULL OR id < $2) ORDER BY id DESC LIMIT $3",
            parameters: vec![Value::BigInt(cutoff), before.map(Value::BigInt).unwrap_or(Value::Null), Value::BigInt(limit as i64 + 1)],
            max_rows: limit + 1,
        }])).await.map_err(|_| Error::Storage)?.map_err(|_| Error::Storage)?.remove(0);
        let next = if selected.len() > limit {
            let Value::BigInt(id) = selected[limit - 1][0] else {
                return Err(Error::Storage);
            };
            Some(encode_cursor(id).into())
        } else {
            None
        };
        selected.truncate(limit);
        Ok(telemetry::Page {
            data: selected
                .into_iter()
                .map(|row| {
                    let Value::BigInt(received_at) = row[1] else {
                        return Err(Error::Storage);
                    };
                    Ok(telemetry::PageEntry {
                        received_at: Int::new(received_at).map_err(|_| Error::Storage)?,
                        sample: reports::latency_sample(&row[2..])?,
                    })
                })
                .collect::<Result<_, Error>>()?,
            cursor: telemetry::Cursor { next },
        })
    }
    pub async fn prune(&self) -> Result<(), Error> {
        self.prune_before(self.cutoff((self.clock)())).await
    }
    async fn prune_before(&self, cutoff: i64) -> Result<(), Error> {
        self.store
            .submit(move |tx| prune(tx, cutoff))?
            .await
            .map_err(Error::from)?;
        purge_pending(&self.store).await
    }
    pub async fn housekeeping(
        &self,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
        on_error: impl Fn(Error) + Send + 'static,
    ) -> Result<tokio::task::JoinHandle<()>, Error> {
        if *shutdown.borrow() {
            return Ok(tokio::spawn(async {}));
        }
        match self.prune().await {
            Ok(()) => {}
            Err(Error::Derived) => on_error(Error::Derived),
            Err(error) => return Err(error),
        }
        let service = self.clone();
        Ok(tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(3600),
                Duration::from_secs(3600),
            );
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                if *shutdown.borrow() {
                    return;
                }
                tokio::select! {
                    _ = interval.tick() => if let Err(error) = service.prune().await { on_error(error); },
                    changed = shutdown.changed() => if changed.is_err() || *shutdown.borrow() { return; },
                }
            }
        }))
    }
}

fn allowed(tx: &mut Write<'_>) -> Result<bool, ycoding_store::Error> {
    Ok(tx
        .get::<resources::ConsentTable>(&tuple_key(&[KeyPart::I64(1)]))?
        .is_some_and(|row| {
            row.enabled == 1
                && row.notice_version == telemetry::CURRENT_NOTICE_VERSION
                && row.decided_at >= 0
                && Int::new(row.decided_at).is_ok()
        }))
}
fn prune(tx: &mut Write<'_>, cutoff: i64) -> Result<(), ycoding_store::Error> {
    let mut deleted = false;
    loop {
        let page = tx.index_range::<resources::LatencyTable>(
            "web_latency_received_at_idx",
            ycoding_store::IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Excluded(&tuple_key(&[KeyPart::I64(cutoff)])),
                prefix: None,
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 128,
            },
        )?;
        if page.is_empty() {
            break;
        }
        deleted = true;
        for row in page {
            resources::LatencyTable::delete(
                tx,
                &resources::LatencyTable::primary_key(&row.record),
            )?;
        }
    }
    if deleted {
        ycoding_store::analytics::privacy_changed(tx, Vec::new(), true)?;
    }
    Ok(())
}

async fn purge_pending(store: &Client) -> Result<(), Error> {
    let pending = store
        .snapshot()?
        .get::<ycoding_store::analytics::DeliveryTable>(&[])?
        .is_some_and(|state| state.purge_all || !state.purges.is_empty());
    if !pending {
        return Ok(());
    }
    let handle = store.analytics().map_err(derived)?;
    tokio::task::spawn_blocking(move || handle.purge())
        .await
        .map_err(|_| Error::Storage)?
        .map_err(derived)
}
pub fn derived_engine_unavailable(error: &ycoding_store::analytics::Error) -> bool {
    use ycoding_store::analytics::Error;
    matches!(
        error,
        Error::Unavailable
            | Error::Closed
            | Error::Busy
            | Error::Configuration
            | Error::Io(_)
            | Error::Duck(_)
    )
}
fn derived(error: ycoding_store::analytics::Error) -> Error {
    if derived_engine_unavailable(&error) {
        Error::Derived
    } else {
        Error::Storage
    }
}
fn valid_sample(sample: &telemetry::Sample) -> bool {
    let at = match sample {
        telemetry::Sample::Request(row) => {
            if (row.reason.is_some() && row.outcome != telemetry::Outcome::Unavailable)
                || row.queue_ms.get() + row.settlement_ms.map_or(0, |n| n.get())
                    != row.total_ms.get()
            {
                return false;
            }
            &row.at
        }
        telemetry::Sample::LongTask(row) => &row.at,
        telemetry::Sample::Client(row) => &row.at,
    };
    at.as_str()
        .and_then(|at| {
            DateTime::parse_from_rfc3339(at)
                .ok()
                .map(|parsed| parsed.to_rfc3339_opts(SecondsFormat::Millis, true) == at)
        })
        .unwrap_or(false)
}
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
fn encode_cursor(id: i64) -> String {
    let mut output = String::new();
    for chunk in id.to_string().as_bytes().chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..chunk.len() + 1 {
            output.push(ALPHABET[((n >> (18 - 6 * index)) & 63) as usize] as char);
        }
    }
    output
}
fn parse_cursor(cursor: &str) -> Result<i64, Error> {
    if cursor.is_empty() || cursor.len() > 256 {
        return Err(Error::InvalidCursor);
    }
    let mut bytes = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for byte in cursor.bytes() {
        let n = ALPHABET
            .iter()
            .position(|b| *b == byte)
            .ok_or(Error::InvalidCursor)?;
        bits = (bits << 6) | n as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| Error::InvalidCursor)?;
    let id: i64 = text.parse().map_err(|_| Error::InvalidCursor)?;
    if id <= 0 || id > 9_007_199_254_740_991 || encode_cursor(id) != cursor {
        return Err(Error::InvalidCursor);
    }
    Ok(id)
}
