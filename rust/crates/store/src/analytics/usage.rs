use super::{BATCH_SIZE, Delivery, Error};
use crate::{Client, Decimal, Versions};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectEncoder, model, provider_request,
    schema::NonNegativeInt, usage_anchor,
};

#[derive(Clone)]
pub struct UsagePresentation {
    pub summary: Option<provider_request::Summary>,
    pub reports: Vec<provider_request::Report>,
    pub revision: LosslessString,
    pub as_of: NonNegativeInt,
    pub price_refs: Vec<UsagePriceKey>,
}

pub type UsagePriceKey = (
    LosslessString,
    Option<LosslessString>,
    LosslessString,
    LosslessString,
    Option<LosslessString>,
);

pub struct UsageData {
    pub revision: LosslessString,
    pub source_revision: String,
    pub as_of: NonNegativeInt,
    pub range: Option<(i64, i64)>,
    pub hints: BTreeMap<String, UsageHint>,
    pub prices: BTreeMap<UsagePriceKey, UsageCosts>,
    pub corrections: BTreeMap<Vec<u8>, UsageCorrection>,
    pub buckets: BTreeMap<(LosslessString, i64, LosslessString), BTreeSet<i64>>,
    pub sessions: BTreeMap<LosslessString, UsageSession>,
    pub tasks: BTreeMap<LosslessString, UsageTask>,
    pub projects: BTreeMap<LosslessString, (Option<LosslessString>, LosslessString)>,
    pub representatives: BTreeMap<(LosslessString, LosslessString), UsageRepresentative>,
}

impl Default for UsageData {
    fn default() -> Self {
        Self {
            revision: "".into(),
            source_revision: String::new(),
            as_of: NonNegativeInt::new(0).expect("nonnegative time"),
            range: None,
            hints: BTreeMap::new(),
            prices: BTreeMap::new(),
            corrections: BTreeMap::new(),
            buckets: BTreeMap::new(),
            sessions: BTreeMap::new(),
            tasks: BTreeMap::new(),
            projects: BTreeMap::new(),
            representatives: BTreeMap::new(),
        }
    }
}

#[derive(Clone)]
pub(super) struct Publication {
    pub fence: UsageStageFence,
    pub versions: Versions,
    pub revision: LosslessString,
    pub data: Arc<UsageData>,
}

impl Publication {
    pub fn current(&self, store: &Client) -> bool {
        *self
            .fence
            .epoch
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            == self.fence.expected_epoch
            && self.source_current(store)
    }
    pub fn source_current(&self, store: &Client) -> bool {
        store.versions_current(&self.versions) && self.fence.source_current(store)
    }
    pub fn verified(&self, value: &UsagePresentation) -> bool {
        let epochs = self
            .fence
            .price_epochs
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        value.price_refs.iter().all(|key| {
            epochs
                .get(key)
                .is_none_or(|epoch| *epoch <= self.fence.expected_epoch)
        })
    }
}

#[derive(Clone)]
pub struct UsageStageFence {
    pub delivery: Delivery,
    pub source_versions: Versions,
    pub epoch: Arc<Mutex<u64>>,
    pub expected_epoch: u64,
    pub price_epochs: Arc<Mutex<BTreeMap<UsagePriceKey, u64>>>,
}

impl UsageStageFence {
    pub fn capture_delivery(
        snapshot: &crate::Snapshot,
        store: &Client,
    ) -> Result<Option<Delivery>, crate::Error> {
        let delivery = snapshot
            .get::<super::DeliveryTable>(&[])?
            .unwrap_or_else(|| Delivery::initial(store.metadata()));
        Ok((delivery.matches(store.metadata()) && !delivery.pending_purge()).then_some(delivery))
    }

    pub fn versions(snapshot: &crate::Snapshot, tables: &[&'static str]) -> Option<Versions> {
        let mut versions = snapshot.versions(tables)?;
        versions.exclude::<super::DeliveryTable>();
        Some(versions)
    }

    pub(super) fn source_current(&self, store: &Client) -> bool {
        !store.is_fenced()
            && store.snapshot().is_ok_and(|snapshot| {
                self.source_versions.current(&snapshot)
                    && Self::capture_delivery(&snapshot, store).is_ok_and(|delivery| {
                        delivery.is_some_and(|current| {
                            current.order == self.delivery.order
                                && current.privacy == self.delivery.privacy
                        })
                    })
            })
    }

    pub(super) fn current(&self, store: &Client) -> bool {
        *self.epoch.lock().unwrap_or_else(|error| error.into_inner()) == self.expected_epoch
            && self.source_current(store)
    }
}

#[derive(Clone, Copy)]
pub enum UsageFamily {
    Backend,
    Session,
}
impl UsageFamily {
    fn name(self) -> &'static str {
        match self {
            Self::Backend => "backend",
            Self::Session => "session",
        }
    }
}

pub struct UsageRepresentative {
    pub family: UsageFamily,
    pub source_key: Vec<u8>,
    pub session_id: LosslessString,
    pub session_updated: i64,
    pub request: i64,
    pub time_created: i64,
    pub invalidation: LosslessString,
    pub namespace: LosslessString,
    pub timing: Option<provider_request::Timing>,
}

pub struct UsageHint {
    pub input: usage_anchor::Ref,
    pub resolved: Option<usage_anchor::Ref>,
    pub started: Option<i64>,
}

pub struct UsageSession {
    pub id: LosslessString,
    pub directory: LosslessString,
    pub workspace_id: Option<LosslessString>,
    pub parent: Option<LosslessString>,
    pub time_created: i64,
    pub pruned_through: Option<i64>,
    pub current_anchor: Option<usage_anchor::Ref>,
}

pub struct UsageTask {
    pub id: LosslessString,
    pub time_created: i64,
    pub state: LosslessString,
    pub anchor: Option<usage_anchor::Ref>,
}

pub struct UsageCosts {
    pub provider: Vec<model::Cost>,
    pub router: Vec<model::Cost>,
}

pub struct UsageCorrection {
    pub amount: Decimal,
    pub requests: i64,
    pub price_ref: UsagePriceKey,
}

pub struct UsagePrice {
    pub directory: LosslessString,
    pub workspace_id: Option<LosslessString>,
    pub provider: LosslessString,
    pub model: LosslessString,
    pub profile: Option<LosslessString>,
    pub costs: Option<UsageCosts>,
}

#[derive(Default)]
pub struct UsageStagePage {
    pub representatives: Vec<UsageRepresentative>,
    pub hints: Vec<UsageHint>,
    pub prices: Vec<UsagePrice>,
    pub sessions: Vec<UsageSession>,
    pub tasks: Vec<UsageTask>,
    pub projects: Vec<(LosslessString, Option<LosslessString>, LosslessString)>,
    pub corrections: Vec<(Vec<u8>, UsageCorrection)>,
    pub buckets: Vec<(LosslessString, i64, LosslessString, i64)>,
    pub range: Option<(i64, i64)>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct UsageBuild(u64);

#[derive(Default)]
pub(super) struct Stage {
    sequence: u64,
    candidate: Option<(UsageBuild, UsageStageFence, UsageData)>,
    active: Option<Publication>,
    failed: bool,
}

fn price_key(key: &UsagePriceKey) -> JsonValue {
    JsonValue::Array(vec![
        key.0.encode(),
        key.1.as_ref().map_or(JsonValue::Null, DomainEncode::encode),
        key.2.encode(),
        key.3.encode(),
        key.4.as_ref().map_or(JsonValue::Null, DomainEncode::encode),
    ])
}

pub(super) fn prices(data: &UsageData, key: &UsagePriceKey) -> String {
    let value = data
        .prices
        .get(key)
        .map(|costs| JsonValue::Array(vec![costs.provider.encode(), costs.router.encode()]))
        .unwrap_or(JsonValue::Null);
    let mut hash = crate::digest::Digest::new();
    hash.update(ycoding_schema::stringify_json(&value).as_bytes());
    hash.finish()
}

fn revisions(data: &UsageData, delivery: &Delivery) -> (String, LosslessString) {
    let mut source = crate::digest::Digest::new();
    for (id, (name, worktree)) in &data.projects {
        source.update(
            ycoding_schema::stringify_json(&JsonValue::Array(vec![
                id.encode(),
                name.as_ref().map_or(JsonValue::Null, DomainEncode::encode),
                worktree.encode(),
            ]))
            .as_bytes(),
        );
    }
    for (key, row) in &data.hints {
        source.update(
            ycoding_schema::stringify_json(&JsonValue::Array(vec![
                key.encode(),
                row.resolved
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
                row.started
                    .map_or(JsonValue::Null, |time| JsonValue::Number(time as f64)),
            ]))
            .as_bytes(),
        );
    }
    for row in data.sessions.values() {
        source.update(
            ycoding_schema::stringify_json(&JsonValue::Array(vec![
                row.id.encode(),
                row.directory.encode(),
                row.workspace_id
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
                row.parent
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
                JsonValue::Number(row.time_created as f64),
                row.pruned_through
                    .map_or(JsonValue::Null, |time| JsonValue::Number(time as f64)),
                row.current_anchor
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
            ]))
            .as_bytes(),
        );
    }
    for row in data.tasks.values() {
        source.update(
            ycoding_schema::stringify_json(&JsonValue::Array(vec![
                row.id.encode(),
                JsonValue::Number(row.time_created as f64),
                row.state.encode(),
                row.anchor
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
            ]))
            .as_bytes(),
        );
    }
    for ((family, _), row) in &data.representatives {
        source.update(
            ycoding_schema::stringify_json(&JsonValue::Array(vec![
                family.encode(),
                row.session_id.encode(),
                JsonValue::Number(row.session_updated as f64),
                JsonValue::Number(row.request as f64),
                JsonValue::Number(row.time_created as f64),
                row.invalidation.encode(),
                row.namespace.encode(),
                row.timing
                    .as_ref()
                    .map_or(JsonValue::Null, DomainEncode::encode),
            ]))
            .as_bytes(),
        );
    }
    for ((family, span, session), buckets) in &data.buckets {
        source.update(
            ycoding_schema::stringify_json(&JsonValue::Array(vec![
                family.encode(),
                JsonValue::Number(*span as f64),
                session.encode(),
            ]))
            .as_bytes(),
        );
        source.update(&(buckets.len() as u64).to_be_bytes());
        for bucket in buckets {
            source.update(&bucket.to_be_bytes());
        }
    }
    let source = format!(
        "native-usage-4-{}-{}-{}",
        delivery.source_generation,
        delivery.order,
        source.finish()
    );
    let mut pricing = crate::digest::Digest::new();
    for key in data.prices.keys() {
        pricing.update(ycoding_schema::stringify_json(&price_key(key)).as_bytes());
        pricing.update(prices(data, key).as_bytes());
    }
    let revision = format!("{source}-{}", pricing.finish()).into();
    (source, revision)
}

pub(super) fn payload(data: &UsageData, value: &UsagePresentation) -> String {
    let prices = value
        .price_refs
        .iter()
        .map(|key| {
            JsonValue::Array(vec![
                price_key(key),
                JsonValue::String(prices(data, key).into()),
            ])
        })
        .collect();
    ycoding_schema::stringify_json(
        &ObjectEncoder::new()
            .optional("summary", &value.summary)
            .field("reports", &value.reports)
            .field("asOf", &value.as_of)
            .field("prices", &JsonValue::Array(prices))
            .finish(),
    )
}

impl Stage {
    pub(super) fn failed(&mut self) {
        self.failed = true;
        self.active = None;
        self.candidate = None;
    }
    pub(super) fn published(&self) -> Result<&Publication, Error> {
        self.active.as_ref().ok_or(if self.failed {
            Error::Preparation
        } else {
            Error::Unavailable
        })
    }
    pub(super) fn candidate(&self, build: UsageBuild) -> Result<&UsageStageFence, Error> {
        self.candidate
            .as_ref()
            .filter(|(id, _, _)| *id == build)
            .map(|(_, fence, _)| fence)
            .ok_or(Error::Invalid)
    }
    pub(super) fn begin(&mut self, fence: UsageStageFence) -> Result<UsageBuild, Error> {
        if self.candidate.is_some() {
            return Err(Error::Busy);
        }
        self.sequence = self.sequence.checked_add(1).ok_or(Error::Limit)?;
        let build = UsageBuild(self.sequence);
        self.candidate = Some((build, fence, UsageData::default()));
        Ok(build)
    }
    pub(super) fn append(&mut self, build: UsageBuild, page: UsageStagePage) -> Result<(), Error> {
        self.candidate(build)?;
        if [
            page.representatives.len(),
            page.hints.len(),
            page.prices.len(),
            page.sessions.len(),
            page.tasks.len(),
            page.projects.len(),
            page.corrections.len(),
            page.buckets.len(),
        ]
        .into_iter()
        .any(|length| length > BATCH_SIZE)
        {
            return Err(Error::Limit);
        }
        let (_, _, data) = self.candidate.as_mut().ok_or(Error::Invalid)?;
        for row in page.representatives {
            let key = (
                LosslessString::from(row.family.name()),
                row.session_id.clone(),
            );
            if data.representatives.get(&key).is_none_or(|current| {
                (
                    current.time_created,
                    current.session_updated,
                    current.request,
                ) < (row.time_created, row.session_updated, row.request)
            }) {
                data.representatives.insert(key, row);
            }
        }
        for row in page.hints {
            let key = ycoding_schema::stringify_json(&JsonValue::Array(vec![
                row.input.session_id.encode(),
                row.input.input_id.encode(),
            ]));
            if data.hints.get(&key).is_some_and(|current| {
                current.resolved != row.resolved || current.started != row.started
            }) {
                return Err(Error::Invalid);
            }
            data.hints.insert(key, row);
        }
        for row in page.prices {
            let key = (
                row.directory,
                row.workspace_id,
                row.provider,
                row.model,
                row.profile,
            );
            if let Some(costs) = row.costs {
                data.prices.insert(key, costs);
            }
        }
        for row in page.sessions {
            data.sessions.insert(row.id.clone(), row);
        }
        for row in page.tasks {
            data.tasks.insert(row.id.clone(), row);
        }
        for (id, name, worktree) in page.projects {
            data.projects.insert(id, (name, worktree));
        }
        for (key, row) in page.corrections {
            if row.requests < 0 {
                return Err(Error::Invalid);
            }
            let current = data
                .corrections
                .entry(key)
                .or_insert_with(|| UsageCorrection {
                    amount: Decimal::default(),
                    requests: 0,
                    price_ref: row.price_ref.clone(),
                });
            if current.price_ref != row.price_ref {
                return Err(Error::Invalid);
            }
            let amount = current
                .amount
                .checked_add(&row.amount)
                .map_err(|_| Error::Limit)?;
            let requests = current
                .requests
                .checked_add(row.requests)
                .ok_or(Error::Limit)?;
            current.amount = amount;
            current.requests = requests;
        }
        for (family, span, session, bucket) in page.buckets {
            if !matches!(family.as_str(), Some("backend" | "session"))
                || ![1, 60_000, 900_000].contains(&span)
                || bucket.rem_euclid(span) != 0
            {
                return Err(Error::Invalid);
            }
            data.buckets
                .entry((family, span, session))
                .or_default()
                .insert(bucket);
        }
        if let Some((first, last)) = page.range {
            data.range = Some(
                data.range
                    .map_or((first, last), |(a, b)| (a.min(first), b.max(last))),
            );
        }
        Ok(())
    }
    pub(super) fn publish(
        &mut self,
        store: &Client,
        build: UsageBuild,
        versions: Versions,
    ) -> Result<(), Error> {
        let fence = self.candidate(build)?.clone();
        if !fence.current(store) || !store.versions_current(&versions) {
            return Err(Error::Unavailable);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::Invalid)?
            .as_millis();
        let now = i64::try_from(now).map_err(|_| Error::Limit)?;
        let (_, _, mut data) = self.candidate.take().ok_or(Error::Invalid)?;
        (data.source_revision, data.revision) = revisions(&data, &fence.delivery);
        data.as_of = NonNegativeInt::new(now).map_err(|_| Error::Invalid)?;
        let revision = data.revision.clone();
        if !fence.current(store) || !store.versions_current(&versions) {
            return Err(Error::Unavailable);
        }
        self.active = Some(Publication {
            fence,
            versions,
            revision,
            data: Arc::new(data),
        });
        self.failed = false;
        Ok(())
    }
    pub(super) fn abort(&mut self, build: UsageBuild, failed: bool) -> Result<(), Error> {
        if self.candidate.is_some() {
            self.candidate(build)?;
        }
        self.candidate = None;
        if failed {
            self.failed();
        }
        Ok(())
    }
}
