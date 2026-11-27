use crate::session::{
    store,
    usage_read::{self, Pricing, PricingRef},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};
use ycoding_schema::{
    JsonValue, LosslessString, location, provider_request, session, session_message_id,
    usage_anchor,
};
use ycoding_store::Decimal;
use ycoding_store::{
    Error, KeyPart, Snapshot, TableSpec,
    analytics::{
        self, UsageFamily, UsageHint, UsagePrice, UsageRepresentative, UsageSession,
        UsageStageFence, UsageStagePage, UsageTask,
    },
    resources::{CredentialTable, RequestTable, UsageAnalyticsRequestTable},
    session::{EventTable, MessageTable, SessionTable, TaskTable},
    tuple_key,
    usage_cells::UnpricedTable,
};

pub type PricingReader = Arc<dyn Fn(&PricingRef) -> Result<Option<Pricing>, Error> + Send + Sync>;
type PriceCache = BTreeMap<PricingRef, (Instant, Option<Pricing>)>;

#[derive(Clone)]
pub struct Service {
    sessions: store::Service,
    pricing: Option<PricingReader>,
    epoch: Arc<Mutex<u64>>,
    prices: Arc<Mutex<PriceCache>>,
    price_epochs: Arc<Mutex<BTreeMap<analytics::UsagePriceKey, u64>>>,
}

#[derive(Clone)]
pub struct Prepared {
    pub summary: provider_request::Summary,
    pub reports: Vec<provider_request::Report>,
    pub revision: LosslessString,
    pub as_of: ycoding_schema::schema::NonNegativeInt,
}

impl Service {
    pub fn new(sessions: store::Service, pricing: Option<PricingReader>) -> Self {
        Self {
            sessions,
            pricing,
            epoch: Arc::new(Mutex::new(0)),
            prices: Arc::default(),
            price_epochs: Arc::default(),
        }
    }

    pub fn invalidate(&self) {
        self.catalog_changed(None, || {});
    }

    pub fn catalog_changed<T>(
        &self,
        location: Option<&location::Ref>,
        change: impl FnOnce() -> T,
    ) -> T {
        let mut epoch = self.epoch.lock().unwrap_or_else(PoisonError::into_inner);
        let result = change();
        *epoch = epoch.wrapping_add(1);
        let mut prices = self.prices.lock().unwrap_or_else(PoisonError::into_inner);
        let mut epochs = self
            .price_epochs
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        prices.retain(|reference, _| {
            let matches = location.is_none_or(|location| {
                reference.directory == *location.directory.as_lossless()
                    && reference.workspace_id.as_ref()
                        == location.workspace_id.as_ref().map(|id| id.as_lossless())
            });
            if matches {
                epochs.insert(reference.key(), *epoch);
            }
            !matches
        });
        result
    }

    pub fn location_changed(&self, location: &location::Ref) {
        let cached = self
            .prices
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|(reference, _)| {
                reference.directory == *location.directory.as_lossless()
                    && reference.workspace_id.as_ref()
                        == location.workspace_id.as_ref().map(|id| id.as_lossless())
            })
            .map(|(reference, (_, value))| (reference.clone(), value.clone()))
            .collect::<Vec<_>>();
        let unchanged = self.pricing.as_ref().is_some_and(|reader| {
            cached
                .iter()
                .all(|(reference, value)| reader(reference).is_ok_and(|current| current == *value))
        });
        if !unchanged {
            self.catalog_changed(Some(location), || {});
        }
    }

    pub fn epoch(&self) -> u64 {
        *self.epoch.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn epoch_handle(&self) -> Arc<Mutex<u64>> {
        self.epoch.clone()
    }

    pub fn read_prepared(
        &self,
        inputs: &[provider_request::ReportInput],
    ) -> Result<Option<Prepared>, Error> {
        match usage_read::prepared(&self.sessions.client, None, inputs) {
            Ok(value) => Ok(Some(value)),
            Err(Error::Domain {
                kind: "Usage.PreparedUnavailable",
                ..
            }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn refresh_prepared(&self, inputs: &[provider_request::ReportInput]) -> Result<(), Error> {
        match usage_read::presentation(&self.sessions.client, None, inputs, true) {
            Ok(_)
            | Err(Error::Domain {
                kind: "Usage.PreparedUnavailable",
                ..
            }) => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn publish(&self) -> Result<bool, Error> {
        let result = self.publish_inner();
        if result.is_err() {
            self.sessions
                .client
                .analytics()
                .map_err(usage_read::analytics_error)?
                .fail_usage()
                .map_err(usage_read::analytics_error)?;
        }
        result
    }

    pub fn register_standard(&self, now: i64) -> Result<(), Error> {
        let environment = std::env::var("TZ").ok().filter(|value| !value.is_empty());
        let local = std::fs::read_link("/etc/localtime").ok().and_then(|path| {
            path.to_str().and_then(|path| {
                path.split_once("zoneinfo/")
                    .map(|(_, zone)| zone.to_owned())
            })
        });
        let server = environment.or(local).or_else(|| {
            std::fs::read_to_string("/etc/timezone")
                .ok()
                .map(|zone| zone.trim().to_owned())
        });
        self.read_prepared(&[])?;
        for time in [now, now.saturating_add(3_600_000)] {
            for zone in [
                None,
                server
                    .as_ref()
                    .map(|zone| LosslessString::from(zone.trim_start_matches(':'))),
            ] {
                for input in usage_read::standard(time, zone)? {
                    self.read_prepared(std::slice::from_ref(&input))?;
                }
            }
        }
        if server.is_none() {
            return Err(Error::Rejected("Server time zone identity is unavailable"));
        }
        Ok(())
    }

    fn publish_inner(&self) -> Result<bool, Error> {
        let handle = self
            .sessions
            .client
            .analytics()
            .map_err(usage_read::analytics_error)?;
        let published = match handle.usage_data() {
            Ok(value) => value,
            Err(analytics::Error::Preparation) => None,
            Err(error) => return Err(usage_read::analytics_error(error)),
        };
        if published.is_some() {
            if !self
                .prices
                .lock()
                .map_err(|_| Error::Rejected("Usage prices unavailable"))?
                .values()
                .any(|(at, value)| value.is_none() && at.elapsed() >= Duration::from_secs(60))
            {
                return Ok(true);
            }
            let mut epoch = self
                .epoch
                .lock()
                .map_err(|_| Error::Rejected("Usage epoch unavailable"))?;
            *epoch = epoch.wrapping_add(1);
        }
        let mut snapshot = self.sessions.client.snapshot()?;
        if !ycoding_store::usage_cells::ready(&snapshot)? {
            return Ok(false);
        }
        let Some(delivery) = UsageStageFence::capture_delivery(&snapshot, &self.sessions.client)?
        else {
            return Ok(false);
        };
        let tables = [
            SessionTable::NAME,
            MessageTable::NAME,
            EventTable::NAME,
            TaskTable::NAME,
            CredentialTable::NAME,
            RequestTable::NAME,
            UsageAnalyticsRequestTable::NAME,
            ycoding_store::project::ProjectTable::NAME,
            ycoding_store::usage_cells::CellTable::NAME,
            ycoding_store::usage_cells::SampleTable::NAME,
            UnpricedTable::NAME,
            ycoding_store::usage_cells::BackfillTable::NAME,
        ];
        let Some(versions) = UsageStageFence::versions(&snapshot, &tables) else {
            return Ok(false);
        };
        let fence = UsageStageFence {
            delivery,
            source_versions: versions,
            epoch: self.epoch_handle(),
            expected_epoch: self.epoch(),
            price_epochs: self.price_epochs.clone(),
        };
        let build = match handle.begin_usage(fence) {
            Ok(build) => build,
            Err(analytics::Error::Unavailable) => return Ok(false),
            Err(error) => return Err(usage_read::analytics_error(error)),
        };
        let result = self.prepare(&mut snapshot, &handle, &build).and_then(|()| {
            let versions = UsageStageFence::versions(&snapshot, &tables)
                .ok_or(Error::Rejected("Usage snapshot retired"))?;
            handle
                .publish_usage(build, versions)
                .map_err(usage_read::analytics_error)
        });
        match result {
            Ok(()) => Ok(true),
            Err(Error::Domain {
                kind: "Usage.PreparedUnavailable",
                ..
            }) => {
                handle
                    .abort_usage(build, false)
                    .map_err(usage_read::analytics_error)?;
                Ok(false)
            }
            Err(error) => {
                handle
                    .abort_usage(build, true)
                    .map_err(usage_read::analytics_error)?;
                Err(error)
            }
        }
    }

    fn prepare(
        &self,
        snapshot: &mut Snapshot,
        handle: &analytics::Handle,
        build: &analytics::UsageBuild,
    ) -> Result<(), Error> {
        let mut after = None;
        loop {
            let rows = snapshot.scan::<UsageAnalyticsRequestTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                analytics::BATCH_SIZE,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(UsageAnalyticsRequestTable::primary_key);
            let range = rows.iter().fold(None, |range, row| {
                let time = row.time_created;
                Some(range.map_or((time, time), |(first, last): (i64, i64)| {
                    (first.min(time), last.max(time))
                }))
            });
            let page = UsageStagePage {
                range,
                representatives: rows
                    .into_iter()
                    .map(|row| {
                        for value in [&row.session_id, &row.project_id, &row.directory, &row.agent]
                        {
                            usage_read::identity(value)?;
                        }
                        if let Some(workspace) = &row.workspace_id {
                            usage_read::identity(workspace)?;
                        }
                        validate_model(&row.model.domain()?)?;
                        if let Some(anchor) = &row.usage_anchor {
                            validate_anchor(&anchor.domain()?)?;
                        }
                        let key = UsageAnalyticsRequestTable::primary_key(&row);
                        Ok(UsageRepresentative {
                            family: UsageFamily::Backend,
                            source_key: key,
                            session_id: row.session_id,
                            session_updated: row.session_updated,
                            request: row.request,
                            time_created: row.time_created,
                            invalidation: row.invalidation,
                            namespace: namespace(&row.prompt_cache_key),
                            timing: row.timing.map(|value| value.domain()).transpose()?,
                        })
                    })
                    .collect::<Result<_, Error>>()?,
                ..Default::default()
            };
            handle
                .append_usage(build, page)
                .map_err(usage_read::analytics_error)?;
            std::thread::yield_now();
        }
        after = None;
        loop {
            let rows = snapshot.scan::<RequestTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                analytics::BATCH_SIZE,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(RequestTable::primary_key);
            let mut page = UsageStagePage::default();
            for row in rows {
                let Some(session) =
                    snapshot.get::<SessionTable>(&super::session::key(&row.session_id))?
                else {
                    continue;
                };
                usage_read::identity(&row.session_id)?;
                usage_read::identity(&row.agent)?;
                validate_model(&row.model.domain()?)?;
                if let Some(anchor) = &row.usage_anchor {
                    validate_anchor(&anchor.domain()?)?;
                }
                if row.usage_anchor.is_none()
                    && let Some(input) = &row.input_id
                {
                    let input = usage_anchor::Ref {
                        session_id: session::Id::new(row.session_id.clone())
                            .map_err(|error| Error::Record(Box::new(error)))?,
                        input_id: session_message_id::Id::new(input.clone())
                            .map_err(|error| Error::Record(Box::new(error)))?,
                    };
                    let resolved = crate::session::usage_attribution::resolve(snapshot, &input)?;
                    let started = crate::session::usage_attribution::started(snapshot, &input)?;
                    page.hints.push(UsageHint {
                        input,
                        resolved,
                        started,
                    });
                }
                page.representatives.push(UsageRepresentative {
                    family: UsageFamily::Session,
                    source_key: RequestTable::primary_key(&row),
                    session_id: row.session_id,
                    session_updated: session.time_updated,
                    request: row.request,
                    time_created: row.time_created,
                    invalidation: row.invalidation,
                    namespace: namespace(&row.prompt_cache_key),
                    timing: row.timing.map(|value| value.domain()).transpose()?,
                });
            }
            handle
                .append_usage(build, page)
                .map_err(usage_read::analytics_error)?;
            std::thread::yield_now();
        }
        after = None;
        loop {
            let rows = snapshot.scan::<SessionTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                analytics::BATCH_SIZE,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(SessionTable::primary_key);
            let mut page = UsageStagePage::default();
            for row in rows {
                for value in [&row.id, &row.project_id, &row.directory] {
                    usage_read::identity(value)?;
                }
                if let Some(workspace) = &row.workspace_id {
                    usage_read::identity(workspace)?;
                }
                if let Some(parent) = &row.parent_id {
                    usage_read::identity(parent)?;
                }
                let current_anchor = crate::session::usage_attribution::current(snapshot, &row.id)?;
                page.sessions.push(UsageSession {
                    id: row.id,
                    parent: row.parent_id,
                    time_created: row.time_created,
                    directory: row.directory,
                    workspace_id: row.workspace_id,
                    pruned_through: row.usage_pruned_through,
                    current_anchor,
                });
            }
            handle
                .append_usage(build, page)
                .map_err(usage_read::analytics_error)?;
            std::thread::yield_now();
        }
        after = None;
        loop {
            let rows = snapshot.scan::<ycoding_store::project::ProjectTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                analytics::BATCH_SIZE,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows
                .last()
                .map(ycoding_store::project::ProjectTable::primary_key);
            let page = UsageStagePage {
                projects: rows
                    .into_iter()
                    .map(|row| (row.id, row.name, row.worktree))
                    .collect(),
                ..UsageStagePage::default()
            };
            handle
                .append_usage(build, page)
                .map_err(usage_read::analytics_error)?;
            std::thread::yield_now();
        }
        after = None;
        loop {
            let rows = snapshot.scan::<TaskTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                analytics::BATCH_SIZE,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(TaskTable::primary_key);
            let mut page = UsageStagePage::default();
            for row in rows {
                let hint = hint(snapshot, &row.session_id, &row.input_id)?;
                let anchor = match row.usage_anchor {
                    Some(anchor) => Some(anchor.domain()?),
                    None => hint.resolved.clone(),
                };
                page.hints.push(hint);
                page.tasks.push(UsageTask {
                    id: row.session_id,
                    time_created: row.time_created,
                    state: row.state,
                    anchor,
                });
            }
            handle
                .append_usage(build, page)
                .map_err(usage_read::analytics_error)?;
            std::thread::yield_now();
        }
        after = None;
        loop {
            let rows = snapshot.scan::<MessageTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                analytics::BATCH_SIZE,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(MessageTable::primary_key);
            let mut page = UsageStagePage::default();
            for row in rows {
                page.hints.push(hint(snapshot, &row.session_id, &row.id)?);
            }
            handle
                .append_usage(build, page)
                .map_err(usage_read::analytics_error)?;
            std::thread::yield_now();
        }
        after = None;
        loop {
            let rows = snapshot.scan::<EventTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                analytics::BATCH_SIZE,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(EventTable::primary_key);
            let mut page = UsageStagePage::default();
            for row in rows {
                if row.type_.as_str() != Some("session.input.admitted.1") {
                    continue;
                }
                if let JsonValue::Object(fields) = &row.data
                    && let Some(JsonValue::String(input)) = fields.get(&"inputID".into())
                {
                    page.hints.push(hint(snapshot, &row.aggregate_id, input)?);
                }
            }
            handle
                .append_usage(build, page)
                .map_err(usage_read::analytics_error)?;
            std::thread::yield_now();
        }
        after = None;
        let mut prices = BTreeMap::<PricingRef, Option<Pricing>>::new();
        loop {
            let rows = snapshot.scan::<UnpricedTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                analytics::BATCH_SIZE,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(UnpricedTable::primary_key);
            let mut page = UsageStagePage::default();
            for row in rows {
                if row.cell.dimensions.source.as_str() == Some("decision") {
                    continue;
                }
                let key = row.cell.key();
                let dimensions = row.cell.dimensions;
                let model = dimensions.model.domain()?;
                let (directory, workspace_id) = if row.cell.family.as_str() == Some("session") {
                    let session = snapshot
                        .get::<SessionTable>(&crate::session::key(&dimensions.session_id))?
                        .ok_or(Error::Rejected("Usage Session is missing"))?;
                    (session.directory, session.workspace_id)
                } else {
                    (dimensions.directory, dimensions.workspace_id)
                };
                let reference = PricingRef {
                    directory,
                    workspace_id,
                    provider: model.provider_id.0,
                    model: model.id,
                    profile: model.profile.map(|value| value.0),
                };
                if !prices.contains_key(&reference) {
                    let cached = self
                        .prices
                        .lock()
                        .map_err(|_| Error::Rejected("Usage prices unavailable"))?
                        .get(&reference)
                        .filter(|(at, value)| {
                            value.is_some() || at.elapsed() < Duration::from_secs(60)
                        })
                        .map(|(_, value)| value.clone());
                    let pricing = if let Some(value) = cached {
                        value
                    } else {
                        let before = self.epoch();
                        let value = match self
                            .pricing
                            .as_ref()
                            .map(|reader| reader(&reference))
                            .transpose()
                        {
                            Ok(value) => value.flatten(),
                            Err(_) => {
                                tracing::warn!("Usage catalog pricing is unavailable");
                                None
                            }
                        };
                        let epoch = self
                            .epoch
                            .lock()
                            .map_err(|_| Error::Rejected("Usage epoch unavailable"))?;
                        if *epoch == before {
                            self.prices
                                .lock()
                                .map_err(|_| Error::Rejected("Usage prices unavailable"))?
                                .insert(reference.clone(), (Instant::now(), value.clone()));
                        }
                        value
                    };
                    page.prices.push(UsagePrice {
                        directory: reference.directory.clone(),
                        workspace_id: reference.workspace_id.clone(),
                        provider: reference.provider.clone(),
                        model: reference.model.clone(),
                        profile: reference.profile.clone(),
                        costs: pricing.as_ref().map(|pricing| analytics::UsageCosts {
                            provider: pricing.provider.clone(),
                            router: pricing.router.clone(),
                        }),
                    });
                    prices.insert(reference.clone(), pricing);
                }
                let choose = |costs: &[ycoding_schema::model::Cost]| {
                    costs
                        .iter()
                        .filter(|cost| {
                            cost.tier.as_ref().is_some_and(|tier| {
                                row.context > Decimal::from_i64(tier.size.get())
                            })
                        })
                        .min_by_key(|cost| {
                            std::cmp::Reverse(cost.tier.as_ref().map(|tier| tier.size.get()))
                        })
                        .or_else(|| costs.iter().find(|cost| cost.tier.is_none()))
                        .cloned()
                };
                let price = prices
                    .get(&reference)
                    .and_then(Option::as_ref)
                    .and_then(|pricing| {
                        choose(&pricing.provider).or_else(|| choose(&pricing.router))
                    });
                let (amount, requests) = if let Some(price) = price {
                    let amount = row.tokens[0]
                        .checked_mul(&Decimal::from_f64(price.input.get())?)?
                        .checked_add(
                            &row.tokens[1]
                                .checked_add(&row.tokens[2])?
                                .checked_mul(&Decimal::from_f64(price.output.get())?)?,
                        )?
                        .checked_add(
                            &row.tokens[3]
                                .checked_mul(&Decimal::from_f64(price.cache.read.get())?)?,
                        )?
                        .checked_add(
                            &row.tokens[4]
                                .checked_mul(&Decimal::from_f64(price.cache.write.get())?)?,
                        )?
                        .scale10(6)?;
                    (amount, row.requests)
                } else {
                    (Decimal::default(), 0)
                };
                page.corrections.push((
                    key,
                    analytics::UsageCorrection {
                        amount,
                        requests,
                        price_ref: reference.key(),
                    },
                ));
            }
            handle
                .append_usage(build, page)
                .map_err(usage_read::analytics_error)?;
            std::thread::yield_now();
        }
        let _epoch = self
            .epoch
            .lock()
            .map_err(|_| Error::Rejected("Usage epoch unavailable"))?;
        self.prices
            .lock()
            .map_err(|_| Error::Rejected("Usage prices unavailable"))?
            .retain(|reference, _| prices.contains_key(reference));
        let keys = prices.keys().map(PricingRef::key).collect::<BTreeSet<_>>();
        self.price_epochs
            .lock()
            .map_err(|_| Error::Rejected("Usage prices unavailable"))?
            .retain(|key, _| keys.contains(key));
        drop(_epoch);
        let session = "session".into();
        let start = tuple_key(&[KeyPart::String(&session)]);
        let end = usage_read::upper(&start);
        after = None;
        loop {
            let rows = snapshot.scan::<ycoding_store::usage_cells::CellTable>(
                after
                    .as_deref()
                    .map_or(Bound::Included(start.as_slice()), Bound::Excluded),
                Bound::Excluded(&end),
                analytics::BATCH_SIZE,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows
                .last()
                .map(ycoding_store::usage_cells::CellTable::primary_key);
            let mut page = UsageStagePage::default();
            for row in rows {
                page.buckets
                    .push((row.family, row.span, row.dimensions.session_id, row.bucket));
            }
            handle
                .append_usage(build, page)
                .map_err(usage_read::analytics_error)?;
            std::thread::yield_now();
        }
        Ok(())
    }
}

fn hint(
    snapshot: &mut Snapshot,
    session: &LosslessString,
    input: &LosslessString,
) -> Result<UsageHint, Error> {
    usage_read::identity(session)?;
    usage_read::identity(input)?;
    let input = usage_anchor::Ref {
        session_id: session::Id::new(session.clone())
            .map_err(|error| Error::Record(Box::new(error)))?,
        input_id: session_message_id::Id::new(input.clone())
            .map_err(|error| Error::Record(Box::new(error)))?,
    };
    let resolved = crate::session::usage_attribution::resolve(snapshot, &input)?;
    if let Some(anchor) = &resolved {
        validate_anchor(anchor)?;
    }
    let started = crate::session::usage_attribution::started(snapshot, &input)?;
    Ok(UsageHint {
        input,
        resolved,
        started,
    })
}

fn validate_model(model: &ycoding_schema::model::Ref) -> Result<(), Error> {
    usage_read::identity(&model.provider_id.0)?;
    usage_read::identity(&model.id)?;
    if let Some(profile) = &model.profile {
        usage_read::identity(&profile.0)?;
    }
    if let Some(variant) = &model.variant {
        usage_read::identity(variant)?;
    }
    Ok(())
}

fn validate_anchor(anchor: &usage_anchor::Ref) -> Result<(), Error> {
    usage_read::identity(anchor.session_id.as_lossless())?;
    usage_read::identity(anchor.input_id.as_lossless())?;
    Ok(())
}

fn namespace(value: &LosslessString) -> LosslessString {
    value
        .to_utf8()
        .unwrap_or_else(|_| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()))
        .chars()
        .take(8)
        .collect::<String>()
        .into()
}
