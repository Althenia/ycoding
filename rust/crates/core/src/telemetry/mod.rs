use chrono::{DateTime, SecondsFormat};
use std::ops::Bound;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ycoding_schema::{DomainDecode, DomainEncode, schema::Int, telemetry};
use ycoding_store::{Client, KeyPart, TableSpec, Write, resources, session::Document, tuple_key};

pub const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const MAX_ROWS: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Storage,
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
}
impl Service {
    pub fn new(store: Client) -> Self {
        Self::with_clock(
            store,
            Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64
            }),
        )
    }
    pub fn with_clock(store: Client, clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self { store, clock }
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
        Ok(consent)
    }
    pub async fn append(&self, samples: Vec<telemetry::Sample>) -> Result<usize, Error> {
        let batch = telemetry::Batch::decode(&telemetry::Batch { samples }.encode())
            .map_err(|_| Error::InvalidSample)?;
        if !batch.samples.iter().all(valid_sample) {
            return Err(Error::InvalidSample);
        }
        let received_at = (self.clock)();
        if received_at < 0 {
            return Err(Error::Storage);
        }
        let samples = batch
            .samples
            .iter()
            .map(Document::from_domain)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Error::InvalidSample)?;
        self.store
            .submit(move |tx| {
                if !allowed(tx)? {
                    return Ok(Err(Error::Disabled));
                }
                prune(tx, received_at)?;
                for sample in &samples {
                    resources::append_latency(tx, received_at, sample)?;
                }
                let rows = rows(tx)?;
                for row in rows.iter().take(rows.len().saturating_sub(MAX_ROWS)) {
                    resources::LatencyTable::delete(
                        tx,
                        &resources::LatencyTable::primary_key(row),
                    )?;
                }
                Ok(Ok(samples.len()))
            })?
            .await?
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
        let now = (self.clock)();
        self.store
            .submit(move |tx| {
                prune(tx, now)?;
                if !allowed(tx)? {
                    return Ok(telemetry::Page {
                        data: Vec::new(),
                        cursor: telemetry::Cursor { next: None },
                    });
                }
                let mut selected = rows(tx)?
                    .into_iter()
                    .rev()
                    .filter(|row| before.is_none_or(|id| row.id < id))
                    .take(limit + 1)
                    .collect::<Vec<_>>();
                let next =
                    (selected.len() > limit).then(|| encode_cursor(selected[limit - 1].id).into());
                selected.truncate(limit);
                Ok(telemetry::Page {
                    data: selected
                        .into_iter()
                        .map(|row| {
                            Ok(telemetry::PageEntry {
                                received_at: Int::new(row.received_at).map_err(|_| {
                                    ycoding_store::Error::Rejected("invalid receipt time")
                                })?,
                                sample: row.sample.domain()?,
                            })
                        })
                        .collect::<Result<_, ycoding_store::Error>>()?,
                    cursor: telemetry::Cursor { next },
                })
            })?
            .await
            .map_err(Error::from)
    }
    pub async fn prune(&self) -> Result<(), Error> {
        let now = (self.clock)();
        self.store
            .submit(move |tx| prune(tx, now))?
            .await
            .map_err(Error::from)
    }
    pub async fn housekeeping(
        &self,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
        on_error: impl Fn(Error),
    ) -> Result<(), Error> {
        if *shutdown.borrow() {
            return Ok(());
        }
        self.prune().await?;
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(3600),
            Duration::from_secs(3600),
        );
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            if *shutdown.borrow() {
                return Ok(());
            }
            tokio::select! {
                _ = interval.tick() => if let Err(error) = self.prune().await { on_error(error); },
                changed = shutdown.changed() => if changed.is_err() || *shutdown.borrow() { return Ok(()); },
            }
        }
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
fn rows(tx: &mut Write<'_>) -> Result<Vec<resources::Latency>, ycoding_store::Error> {
    let mut rows = Vec::new();
    let mut after = None;
    loop {
        let page = tx.scan::<resources::LatencyTable>(
            after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            256,
        )?;
        if page.is_empty() {
            return Ok(rows);
        }
        after = page.last().map(resources::LatencyTable::primary_key);
        rows.extend(page);
    }
}
fn prune(tx: &mut Write<'_>, now: i64) -> Result<(), ycoding_store::Error> {
    for row in rows(tx)?
        .into_iter()
        .filter(|row| row.received_at < now.saturating_sub(RETENTION_MS))
    {
        resources::LatencyTable::delete(tx, &resources::LatencyTable::primary_key(&row))?;
    }
    Ok(())
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
