use super::{
    Cache, Error, empty, forecast::Publication, normalize_codex, normalize_cursor, normalize_go,
    normalize_grok, normalize_openrouter, normalize_organization, normalize_zai,
};
use crate::resources::catalog::{
    field,
    models_dev::{date_millis, text},
};
use crate::{event_feed::Data, resources::credential::Info};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use ycoding_schema::{
    JsonValue, LosslessString, credential, location, model, provider,
    provider_usage::{self, Observation, Snapshot},
    schema::NonNegativeInt,
    usage_forecast,
};

#[derive(Clone, Default)]
pub struct Endpoints(pub BTreeMap<String, String>);
impl Endpoints {
    pub fn provider() -> Self {
        Self(BTreeMap::from([
            ("openrouter".into(), "https://openrouter.ai/api/v1".into()),
            ("anthropic".into(), "https://api.anthropic.com".into()),
            ("opencode-go".into(), "https://opencode.ai/zen/go/v1".into()),
            ("openai".into(), "https://api.openai.com/v1".into()),
            ("codex".into(), "https://chatgpt.com/backend-api".into()),
            ("meta".into(), "https://api.llama.com/v1".into()),
            ("xai".into(), "https://cli-chat-proxy.grok.com/v1".into()),
            ("zai".into(), "https://api.z.ai".into()),
            ("zai-coding-plan".into(), "https://api.z.ai".into()),
            ("github-copilot".into(), "https://api.github.com".into()),
            (
                "cursor".into(),
                "https://api2.cursor.sh/aiserver.v1.DashboardService".into(),
            ),
        ]))
    }
}
#[derive(Clone)]
pub struct Service {
    credentials: crate::resources::credential::Service,
    cache: Cache,
    client: reqwest::Client,
    endpoints: Endpoints,
    observations: Arc<Mutex<Observations>>,
    accepted: Arc<Mutex<AcceptedSnapshots>>,
    history: Arc<Mutex<super::forecast::History>>,
    matched_orgs: Arc<Mutex<CopilotAccounts>>,
    user_agent: String,
    app_server: Option<super::AppServerCommand>,
    store: Option<ycoding_store::Client>,
    auxiliary_errors: Arc<Mutex<BTreeMap<&'static str, Error>>>,
    preparation: crate::resources::auth::Preparation,
    claude: Option<crate::resources::auth::claude::Store>,
    events: Option<crate::event_feed::Feed>,
    alerts: Arc<super::alert_queue::Queue<AlertJob>>,
    publication: Arc<Mutex<PublicationState>>,
    observers: Arc<Mutex<Vec<Observer>>>,
}

type Observer = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Default)]
struct PublicationState {
    revision: u64,
    closed: bool,
    values: BTreeMap<(LosslessString, Option<LosslessString>), Published>,
    refresh: BTreeSet<(LosslessString, Option<LosslessString>, u64)>,
    requests: u64,
    polled: BTreeMap<(LosslessString, Option<LosslessString>), Polled>,
    demands: BTreeMap<(LosslessString, Option<LosslessString>), (u64, Instant)>,
}

struct Polled {
    generation: u64,
    at: Instant,
    providers: Vec<provider::Id>,
    credentials: ycoding_store::Versions,
    auxiliary: Vec<(Snapshot, Option<LosslessString>)>,
}

#[derive(Clone)]
struct Published {
    generation: u64,
    observation: u64,
    epoch: Arc<Mutex<u64>>,
    expected_epoch: u64,
    credentials: ycoding_store::Versions,
    accounting: Accounting,
    value: Result<Arc<Publication>, Error>,
    expires: Instant,
}

#[derive(Clone)]
struct Accounting {
    versions: Option<ycoding_store::Versions>,
    revision: Option<LosslessString>,
}

impl Accounting {
    fn capture(store: Option<&ycoding_store::Client>) -> Self {
        Self {
            versions: store.and_then(|store| {
                let snapshot = store.snapshot().ok()?;
                let tables = store
                    .catalog()
                    .tables()
                    .iter()
                    .map(|table| table.name)
                    .collect::<Vec<_>>();
                snapshot.versions(&tables)
            }),
            revision: store
                .and_then(|store| store.analytics().ok()?.prepared_revision().ok().flatten()),
        }
    }

    fn current(&self, store: Option<&ycoding_store::Client>) -> bool {
        let versions = match (&self.versions, store) {
            (Some(versions), Some(store)) => store.versions_current(versions),
            (None, Some(store)) => store.snapshot().is_err(),
            (None, None) => true,
            (Some(_), None) => false,
        };
        versions
            && self.revision
                == store
                    .and_then(|store| store.analytics().ok()?.prepared_revision().ok().flatten())
    }
}

fn publication_key(location: &location::Ref) -> (LosslessString, Option<LosslessString>) {
    (
        location.directory.as_lossless().clone(),
        location
            .workspace_id
            .as_ref()
            .map(|id| id.as_lossless().clone()),
    )
}
struct AlertJob {
    observation: super::pace_alerts::Observation,
    events: Option<crate::event_feed::Feed>,
}
type Observations = BTreeMap<(provider::Id, Option<LosslessString>), Snapshot>;
type AcceptedSnapshots =
    BTreeMap<(provider::Id, Option<LosslessString>, Option<LosslessString>), Snapshot>;
type CopilotAccounts = BTreeMap<(provider::Id, LosslessString, i64), String>;
impl Service {
    pub fn new(
        credentials: crate::resources::credential::Service,
        endpoints: Endpoints,
    ) -> Result<Self, Error> {
        let evaluator = super::pace_alerts::Evaluator::new();
        let alerts = super::alert_queue::Queue::spawn(super::alert_queue::CAPACITY, move |job| {
            deliver(&evaluator, job)
        })
        .map_err(|_| Error::Worker)?;
        Ok(Self {
            credentials,
            cache: Cache::new(),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| Error::Request(None))?,
            endpoints,
            observations: Arc::new(Mutex::new(BTreeMap::new())),
            accepted: Arc::new(Mutex::new(BTreeMap::new())),
            history: Arc::new(Mutex::new(super::forecast::History::new(256, 256))),
            matched_orgs: Arc::new(Mutex::new(BTreeMap::new())),
            user_agent: "ycoding".into(),
            app_server: None,
            store: None,
            auxiliary_errors: Arc::new(Mutex::new(BTreeMap::new())),
            preparation: Default::default(),
            claude: None,
            events: None,
            alerts: Arc::new(alerts),
            publication: Arc::default(),
            observers: Arc::default(),
        })
    }

    pub fn observe_changes(&self, observer: impl Fn() -> bool + Send + Sync + 'static) {
        self.observers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(Arc::new(observer));
    }

    fn notify_changes(&self) {
        self.observers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|observer| observer());
    }

    fn accept(
        &self,
        snapshot: &Snapshot,
        account: Option<&LosslessString>,
        now: i64,
    ) -> Result<(), Error> {
        let mut state = self.publication.lock().map_err(|_| Error::Worker)?;
        if state.closed {
            return Err(Error::Closed);
        }
        let mut accepted = self.accepted.lock().map_err(|_| Error::Worker)?;
        let key = (
            snapshot.provider_id.clone(),
            account.cloned(),
            if account.is_none() {
                snapshot.profile.clone()
            } else {
                None
            },
        );
        if accepted
            .get(&key)
            .is_some_and(|current| current.updated_at > snapshot.updated_at)
        {
            return Ok(());
        }
        let changed = accepted.get(&key) != Some(snapshot);
        if changed {
            accepted.insert(key, snapshot.clone());
            if accepted.len() > 256 {
                let oldest = accepted
                    .iter()
                    .min_by_key(|(_, value)| value.updated_at)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    accepted.remove(&oldest);
                }
            }
            if let Some(account) = account {
                self.record(snapshot, account);
            }
            state.revision = state.revision.wrapping_add(1);
        }
        drop(accepted);
        drop(state);
        if let Some(account) = account {
            self.alert(snapshot, account, now);
        }
        if changed {
            self.notify_changes();
        }
        Ok(())
    }

    fn snapshots(
        &self,
        providers: &[provider::Id],
        now: i64,
    ) -> Result<Vec<(Snapshot, Option<LosslessString>)>, Error> {
        let mut providers = providers.to_vec();
        providers.sort();
        providers.dedup();
        let accepted = self.accepted.lock().map_err(|_| Error::Worker)?;
        let observations = self.observations.lock().map_err(|_| Error::Worker)?;
        let mut result = Vec::new();
        for provider in &providers {
            let saved = self
                .credentials
                .list(&provider.0)
                .map_err(|_| Error::Storage)?;
            let selected = if saved.len() > 1 {
                let mut selected = saved.iter().collect::<Vec<_>>();
                selected.sort_by(|a, b| a.label().cmp(b.label()));
                selected
            } else {
                saved
                    .iter()
                    .find(|account| account.active())
                    .or_else(|| saved.first())
                    .into_iter()
                    .collect()
            };
            let accounts = if selected.is_empty() {
                vec![None]
            } else {
                selected.into_iter().map(Some).collect()
            };
            for account in accounts {
                let identity = account.map(super::super::account_identity);
                let key = (provider.clone(), identity.clone());
                let unbound = (provider.clone(), None);
                let cached = if provider.0 == "anthropic".into() {
                    account
                        .map(|account| {
                            self.cache
                                .peek(&cache_key(provider, account), account.generation())
                        })
                        .transpose()?
                        .flatten()
                        .map(|snapshot| (snapshot, identity.clone()))
                } else {
                    accepted
                        .get(&(provider.clone(), identity.clone(), None))
                        .map(|snapshot| (snapshot.clone(), identity.clone()))
                        .or_else(|| {
                            (saved.len() <= 1)
                                .then(|| {
                                    accepted
                                        .get(&(provider.clone(), None, None))
                                        .map(|snapshot| (snapshot.clone(), None))
                                })
                                .flatten()
                        })
                };
                let observed = observations
                    .get(&key)
                    .and_then(|snapshot| current_observation(snapshot, now))
                    .map(|snapshot| (snapshot, identity.clone()))
                    .or_else(|| {
                        (saved.len() <= 1)
                            .then(|| {
                                observations
                                    .get(&unbound)
                                    .and_then(|snapshot| current_observation(snapshot, now))
                                    .map(|snapshot| (snapshot, None))
                            })
                            .flatten()
                    });
                let snapshot = match (observed, cached) {
                    (Some((observed, account)), Some((cached, _)))
                        if provider.0 == "anthropic".into()
                            && account.is_some()
                            && observed.source == "response_headers".into()
                            && cached.source == "provider_internal_api".into()
                            && matches!(cached.status.as_str(), Some("available" | "stale")) =>
                    {
                        Some((merge_claude_observation(&observed, &cached, now), account))
                    }
                    (Some((observed, account)), Some((cached, cached_account))) => {
                        Some(if observed.updated_at >= cached.updated_at {
                            (observed, account)
                        } else {
                            (cached, cached_account)
                        })
                    }
                    (Some((snapshot, account)), None) | (None, Some((snapshot, account))) => {
                        Some((snapshot, account))
                    }
                    (None, None) => None,
                };
                let (mut snapshot, identity) = snapshot.unwrap_or_else(|| {
                    (
                        unavailable(
                            provider.clone(),
                            &label(provider),
                            now,
                            "unsupported",
                            "Provider usage has not been observed",
                        ),
                        identity,
                    )
                });
                if identity.is_some() {
                    snapshot.profile = account.and_then(safe_profile);
                }
                result.push((snapshot, identity));
            }
            if saved.len() > 1
                && let Some(snapshot) = observations.get(&(provider.clone(), None))
                && let Some(snapshot) = current_observation(snapshot, now)
            {
                result.push((snapshot, None));
            }
        }
        Ok(result)
    }

    pub fn retire_publications(&self) {
        let mut state = self
            .publication
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.closed = true;
        state.values.clear();
        state.refresh.clear();
        state.polled.clear();
        state.demands.clear();
        state.revision = state.revision.wrapping_add(1);
    }

    pub fn retain_publications(&self, locations: &[(location::Ref, u64)]) {
        let mut state = self
            .publication
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.values.retain(|key, value| {
            locations.iter().any(|(location, generation)| {
                publication_key(location) == *key && *generation == value.generation
            })
        });
        state.refresh.retain(|(directory, workspace, requested)| {
            locations.iter().any(|(location, generation)| {
                let key = publication_key(location);
                key.0 == *directory && key.1 == *workspace && generation == requested
            })
        });
        state.polled.retain(|key, value| {
            locations.iter().any(|(location, generation)| {
                publication_key(location) == *key && *generation == value.generation
            })
        });
        state.demands.retain(|key, (requested, _)| {
            locations.iter().any(|(location, generation)| {
                publication_key(location) == *key && generation == requested
            })
        });
    }

    pub fn request_preparation(
        &self,
        location: &location::Ref,
        generation: u64,
    ) -> Result<(), Error> {
        let mut state = self.publication.lock().map_err(|_| Error::Worker)?;
        if state.closed {
            return Err(Error::Closed);
        }
        let key = publication_key(location);
        let wake = state.demands.get(&key).is_none_or(|(owner, used)| {
            *owner != generation || used.elapsed() >= Duration::from_secs(300)
        });
        state.demands.insert(key, (generation, Instant::now()));
        drop(state);
        if wake {
            self.notify_changes();
        }
        Ok(())
    }

    pub fn requested(&self, location: &location::Ref, generation: u64) -> bool {
        let mut state = self
            .publication
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let key = publication_key(location);
        if state.closed
            || state.demands.get(&key).is_none_or(|(owner, used)| {
                *owner != generation || used.elapsed() >= Duration::from_secs(300)
            })
        {
            state.values.remove(&key);
            state.polled.remove(&key);
            state.demands.remove(&key);
            return false;
        }
        true
    }

    pub fn request_refresh(&self, location: &location::Ref, generation: u64) -> Result<(), Error> {
        self.request_preparation(location, generation)?;
        let mut state = self.publication.lock().map_err(|_| Error::Worker)?;
        if state.closed {
            return Err(Error::Closed);
        }
        let key = publication_key(location);
        if state
            .refresh
            .insert((key.0.clone(), key.1.clone(), generation))
        {
            state.requests = state.requests.wrapping_add(1);
            state.values.remove(&key);
        }
        drop(state);
        self.notify_changes();
        Ok(())
    }

    pub fn prepared(
        &self,
        location: &location::Ref,
        generation: u64,
    ) -> Result<Option<Arc<Publication>>, Error> {
        self.request_preparation(location, generation)?;
        let state = self.publication.lock().map_err(|_| Error::Worker)?;
        if state.closed {
            return Err(Error::Closed);
        }
        let Some(value) = state.values.get(&publication_key(location)).cloned() else {
            return Ok(None);
        };
        if value.generation != generation
            || value.observation != state.revision
            || Instant::now() >= value.expires
        {
            return Ok(None);
        }
        drop(state);
        if *value.epoch.lock().map_err(|_| Error::Worker)? != value.expected_epoch
            || !self.credentials.versions_current(&value.credentials)
        {
            return Ok(None);
        }
        let current = value.accounting.current(self.store.as_ref());
        let state = self.publication.lock().map_err(|_| Error::Worker)?;
        if state.closed {
            return Err(Error::Closed);
        }
        if !current
            || state.revision != value.observation
            || Instant::now() >= value.expires
            || *value.epoch.lock().map_err(|_| Error::Worker)? != value.expected_epoch
            || !self.credentials.versions_current(&value.credentials)
        {
            return Ok(None);
        }
        value.value.clone().map(Some)
    }

    pub async fn publish(
        &self,
        views: &crate::usage_view::Service,
        location: &location::Ref,
        generation: u64,
        providers: &[provider::Id],
        now: NonNegativeInt,
    ) -> Result<bool, Error> {
        let active = providers
            .iter()
            .filter(|id| !retired(id))
            .cloned()
            .collect::<Vec<_>>();
        let providers = active.as_slice();
        let started = Instant::now();
        let credentials = self.credentials.versions().map_err(|_| Error::Storage)?;
        let (refresh, requests, poll) = {
            let mut state = self.publication.lock().map_err(|_| Error::Worker)?;
            if state.closed {
                return Err(Error::Closed);
            }
            let key = publication_key(location);
            let refresh = state
                .refresh
                .remove(&(key.0.clone(), key.1.clone(), generation));
            let poll = refresh
                || state.polled.get(&key).is_none_or(|value| {
                    value.generation != generation
                        || value.providers.as_slice() != providers
                        || value.at.elapsed() >= Duration::from_secs(30)
                        || !self.credentials.versions_current(&value.credentials)
                });
            (refresh, state.requests, poll)
        };
        if poll {
            let snapshots = self.bound_list(providers, refresh, now.get()).await;
            if !self.credentials.versions_current(&credentials) {
                return Ok(false);
            }
            let auxiliary = snapshots
                .into_iter()
                .filter(|(snapshot, _)| snapshot.source == "local_client_rpc".into())
                .collect();
            let mut state = self.publication.lock().map_err(|_| Error::Worker)?;
            if state.closed {
                return Err(Error::Closed);
            }
            state.polled.insert(
                publication_key(location),
                Polled {
                    generation,
                    at: Instant::now(),
                    providers: providers.to_vec(),
                    credentials: credentials.clone(),
                    auxiliary,
                },
            );
        }
        let epoch = views.epoch_handle();
        let expected_epoch = *epoch.lock().map_err(|_| Error::Worker)?;
        let accounting = Accounting::capture(self.store.as_ref());
        let prepared = views.read_prepared(&[]).ok().flatten();
        let (observation, snapshots) = {
            let state = self.publication.lock().map_err(|_| Error::Worker)?;
            if state.closed {
                return Err(Error::Closed);
            }
            let mut snapshots = self.snapshots(providers, now.get())?;
            if let Some(polled) = state.polled.get(&publication_key(location)) {
                let auxiliary = polled
                    .auxiliary
                    .iter()
                    .filter(|(snapshot, _)| {
                        !snapshots.iter().any(|(current, _)| {
                            current.provider_id == snapshot.provider_id
                                && current.profile == snapshot.profile
                        })
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                snapshots.extend(auxiliary);
            }
            (state.revision, snapshots)
        };
        let lifetime = self
            .observations
            .lock()
            .map_err(|_| Error::Worker)?
            .values()
            .filter(|snapshot| {
                providers.contains(&snapshot.provider_id)
                    && snapshot.provider_id.0 == "anthropic".into()
                    && snapshot.source == "response_headers".into()
            })
            .flat_map(|snapshot| &snapshot.windows)
            .filter_map(|window| window.reset_at)
            .map(NonNegativeInt::get)
            .filter(|reset| *reset > now.get())
            .map(|reset| (reset - now.get()) as u64)
            .min()
            .unwrap_or(60_000)
            .min(60_000);
        let expires = started + Duration::from_millis(lifetime);
        let value = (|| {
            let local = self
                .store
                .as_ref()
                .filter(|_| {
                    prepared.as_ref().is_some_and(|prepared| {
                        accounting.revision.as_ref() == Some(&prepared.revision)
                    })
                })
                .map(|store| {
                    Ok::<_, Error>((
                        super::forecast::local_usage(store, None, now.get())?,
                        super::forecast::local_usage(store, Some(location), now.get())?,
                        super::local_spend_from_store(store, now.get())?,
                    ))
                })
                .transpose();
            let local = match local {
                Ok(local) => local,
                Err(Error::Storage) => None,
                Err(error) => return Err(error),
            };
            let accounting_revision = local.as_ref().and(accounting.revision.clone());
            let (backend_rates, location_rates, spend) = match local {
                Some((backend, location, spend)) => (Some(backend), Some(location), spend),
                None => (None, None, vec![]),
            };
            let backend = self.forecast_snapshot(&snapshots, false, now, backend_rates)?;
            let location = self.forecast_snapshot(&snapshots, true, now, location_rates)?;
            let mut primary = BTreeMap::new();
            for provider in providers {
                let saved = self
                    .credentials
                    .list(&provider.0)
                    .map_err(|_| Error::Storage)?;
                let selected = saved
                    .iter()
                    .find(|account| account.active())
                    .or_else(|| saved.first());
                let account = selected.map(super::super::account_identity);
                let index = snapshots
                    .iter()
                    .position(|(snapshot, identity)| {
                        &snapshot.provider_id == provider && identity == &account
                    })
                    .or_else(|| {
                        if saved.len() > 1 {
                            return None;
                        }
                        snapshots.iter().position(|(snapshot, identity)| {
                            &snapshot.provider_id == provider
                                && identity.is_none()
                                && snapshot.profile.is_none()
                        })
                    });
                if let Some(index) = index {
                    primary.insert(provider.clone(), index);
                }
            }
            let mut snapshots = snapshots
                .into_iter()
                .map(|(snapshot, _)| snapshot)
                .collect::<Vec<_>>();
            snapshots.extend(
                spend
                    .into_iter()
                    .filter(|snapshot| providers.contains(&snapshot.provider_id)),
            );
            Ok(Arc::new(Publication {
                accounting_revision,
                providers: snapshots,
                primary,
                backend,
                location,
            }))
        })();
        let mut state = self.publication.lock().map_err(|_| Error::Worker)?;
        if state.closed {
            return Err(Error::Closed);
        }
        if state.revision != observation
            || state.requests != requests
            || *epoch.lock().map_err(|_| Error::Worker)? != expected_epoch
            || !self.credentials.versions_current(&credentials)
            || !accounting.current(self.store.as_ref())
        {
            return Ok(false);
        }
        state.values.insert(
            publication_key(location),
            Published {
                generation,
                observation,
                epoch,
                expected_epoch,
                credentials,
                accounting,
                value,
                expires,
            },
        );
        Ok(true)
    }
    pub fn with_version(mut self, version: &str) -> Self {
        self.user_agent = format!("ycoding/{version}");
        self
    }
    pub fn with_auth(
        mut self,
        preparation: crate::resources::auth::Preparation,
        claude: Option<crate::resources::auth::claude::Store>,
    ) -> Self {
        self.preparation = preparation;
        self.claude = claude;
        self
    }
    pub fn with_store(mut self, store: ycoding_store::Client) -> Self {
        self.store = Some(store);
        self
    }
    pub fn with_events(mut self, events: crate::event_feed::Feed) -> Self {
        self.events = Some(events);
        self
    }
    pub fn with_configuration(
        mut self,
        configuration: &crate::resources::config::Configuration,
    ) -> Result<Self, Error> {
        self.app_server = configuration
            .latest("provider_usage")
            .and_then(|value| field(value, "codex_app_server"))
            .map(|value| {
                let command = field(value, "command")
                    .and_then(text)
                    .ok_or(Error::InvalidResponse)?
                    .into();
                let args = match field(value, "args") {
                    None => vec![],
                    Some(JsonValue::Array(args)) => args
                        .iter()
                        .map(|value| text(value).map(str::to_owned).ok_or(Error::InvalidResponse))
                        .collect::<Result<_, _>>()?,
                    _ => return Err(Error::InvalidResponse),
                };
                let timeout_ms = match field(value, "timeoutMs") {
                    None => None,
                    Some(JsonValue::Number(value)) => Some(*value),
                    _ => return Err(Error::InvalidResponse),
                };
                let cwd = field(value, "cwd")
                    .map(|value| {
                        text(value)
                            .map(std::path::PathBuf::from)
                            .ok_or(Error::InvalidResponse)
                    })
                    .transpose()?;
                Ok(super::AppServerCommand {
                    command,
                    args,
                    timeout_ms,
                    cwd,
                })
            })
            .transpose()?;
        Ok(self)
    }
    pub fn auxiliary_errors(&self) -> Result<BTreeMap<&'static str, Error>, Error> {
        Ok(self
            .auxiliary_errors
            .lock()
            .map_err(|_| Error::Worker)?
            .clone())
    }
    pub async fn get(
        &self,
        provider: provider::Id,
        credential_id: Option<&LosslessString>,
        refresh: bool,
        now: i64,
    ) -> Snapshot {
        if retired(&provider) {
            let label = label(&provider);
            return unavailable(
                provider,
                &label,
                now,
                "unsupported",
                provider::RETIRED_DIAGNOSTIC,
            );
        }
        self.bound(provider, credential_id, refresh, now).await.0
    }
    async fn bound(
        &self,
        provider: provider::Id,
        credential_id: Option<&LosslessString>,
        refresh: bool,
        now: i64,
    ) -> (Snapshot, Option<LosslessString>) {
        let result = self.load_bound(provider, credential_id, refresh, now).await;
        if self.accept(&result.0, result.1.as_ref(), now).is_err() {
            return (
                unavailable(
                    result.0.provider_id.clone(),
                    &label(&result.0.provider_id),
                    now,
                    "error",
                    "Provider usage publication failed",
                ),
                None,
            );
        }
        result
    }
    async fn load_bound(
        &self,
        provider: provider::Id,
        credential_id: Option<&LosslessString>,
        refresh: bool,
        now: i64,
    ) -> (Snapshot, Option<LosslessString>) {
        let label = label(&provider);
        let saved = match self.credentials.list(&provider.0) {
            Ok(saved) => saved,
            Err(_) => {
                return (
                    unavailable(
                        provider,
                        &label,
                        now,
                        "error",
                        "Provider usage refresh failed",
                    ),
                    None,
                );
            }
        };
        let selected = credential_id
            .and_then(|id| saved.iter().find(|c| c.id() == id))
            .or_else(|| {
                if credential_id.is_none() {
                    saved.iter().find(|c| c.active()).or_else(|| saved.first())
                } else {
                    None
                }
            });
        let profile_source = selected.and_then(|selected| {
            let value = selected.secret().domain().ok()?;
            match value {
                credential::Value::OAuth(oauth)
                    if oauth.metadata.as_ref().is_some_and(|m| {
                        m.get(&"managed".into()) == Some(&JsonValue::Bool(true))
                            && m.get(&"source".into())
                                .is_some_and(|v| matches!(v, JsonValue::String(_)))
                    }) =>
                {
                    Some(super::super::account_identity(selected))
                }
                _ => None,
            }
        });
        let has_endpoint = self
            .endpoints
            .0
            .contains_key(provider.0.as_str().unwrap_or_default());
        if (!refresh || !has_endpoint)
            && (profile_source.is_some() || credential_id.is_none())
            && let Ok(observations) = self.observations.lock()
            && let Some(observed) = observations
                .get(&(provider.clone(), profile_source.clone()))
                .and_then(|snapshot| current_observation(snapshot, now))
        {
            if profile_source.is_some()
                && let Some(selected) = selected
            {
                let current = self
                    .credentials
                    .get(selected.id())
                    .ok()
                    .flatten()
                    .filter(|c| c.account_generation() == selected.account_generation());
                let Some(current) = current else {
                    return (
                        unavailable(
                            provider,
                            &label,
                            now,
                            "unsupported",
                            "Provider usage account changed during refresh",
                        ),
                        None,
                    );
                };
                let claude_headers = provider.0 == "anthropic".into()
                    && observed.source == "response_headers".into()
                    && self.endpoints.0.contains_key("anthropic");
                if !claude_headers {
                    let mut observed = observed;
                    observed.profile = safe_profile(&current);
                    return (observed, profile_source.clone());
                }
            } else {
                return (observed, None);
            }
        }
        if !has_endpoint {
            return (
                unavailable(
                    provider,
                    &label,
                    now,
                    "unsupported",
                    "Provider usage is unsupported",
                ),
                None,
            );
        }
        let Some(selected) = selected else {
            if credential_id.is_none()
                && let Ok(observations) = self.observations.lock()
                && let Some(observed) = observations
                    .get(&(provider.clone(), None))
                    .and_then(|snapshot| current_observation(snapshot, now))
            {
                return (observed, None);
            }
            return (
                unavailable(
                    provider,
                    &label,
                    now,
                    "unsupported",
                    "No supported credential is configured",
                ),
                None,
            );
        };
        let key = cache_key(&provider, selected);
        let generation = selected.generation();
        let selected = selected.clone();
        let result = {
            let input = selected.clone();
            let service = self.clone();
            let provider_copy = provider.clone();
            let label_copy = label.clone();
            self.cache
                .get(
                    key,
                    generation,
                    now,
                    if provider.0 == "anthropic".into() {
                        300_000
                    } else {
                        60_000
                    },
                    refresh,
                    move || async move { service.load(provider_copy, &label_copy, input, now).await },
                )
                .await
        };
        let mut snapshot = match result {
            Ok(snapshot) => snapshot,
            Err(
                Error::Request(Some(401 | 403))
                | Error::RequestWithRetry {
                    status: 401 | 403, ..
                },
            ) => unavailable(
                provider.clone(),
                &label,
                now,
                "unauthorized",
                "Provider usage credentials are unauthorized",
            ),
            Err(Error::Request(Some(404)) | Error::RequestWithRetry { status: 404, .. }) => {
                unavailable(
                    provider.clone(),
                    &label,
                    now,
                    "unsupported",
                    "Provider usage refresh failed",
                )
            }
            Err(_) => unavailable(
                provider.clone(),
                &label,
                now,
                "error",
                "Provider usage refresh failed",
            ),
        };
        if provider.0 == "anthropic".into() || provider.0 == "openai".into() && selected.secret().domain().is_ok_and(|value| matches!(value,credential::Value::OAuth(oauth) if ["chatgpt-browser","chatgpt-headless"].iter().any(|method| oauth.method_id.as_lossless() == &(*method).into()))) { snapshot.source = "provider_internal_api".into(); snapshot.stability = "best_effort".into(); }
        let current = self.credentials.list(&provider.0);
        let current = match current {
            Ok(current) => current,
            Err(_) => {
                return (
                    unavailable(
                        provider,
                        &label,
                        now,
                        "error",
                        "Provider usage refresh failed",
                    ),
                    None,
                );
            }
        };
        let Some(credential) = current.iter().find(|c| {
            c.id() == selected.id() && c.account_generation() == selected.account_generation()
        }) else {
            return (
                unavailable(
                    provider,
                    &label,
                    now,
                    "unsupported",
                    "Provider usage account changed during refresh",
                ),
                None,
            );
        };
        snapshot.profile = safe_profile(credential);
        let account = super::super::account_identity(credential);
        let observed = if profile_source.is_some() || credential_id.is_none() {
            self.observations.lock().ok().and_then(|observations| {
                observations
                    .get(&(provider.clone(), profile_source.clone()))
                    .and_then(|snapshot| current_observation(snapshot, now))
            })
        } else {
            None
        };
        if let Some(mut observed) = observed {
            let claude_headers = provider.0 == "anthropic".into()
                && profile_source.is_some()
                && observed.source == "response_headers".into();
            if claude_headers
                && matches!(snapshot.status.as_str(), Some("available" | "stale"))
                && observed
                    .windows
                    .iter()
                    .any(|window| exhausted_window(window, now))
            {
                let mut merged = merge_claude_observation(&observed, &snapshot, now);
                merged.profile = safe_profile(credential);
                return (merged, profile_source.clone());
            }
            if claude_headers
                && matches!(
                    snapshot.status.as_str(),
                    Some("error" | "unauthorized" | "unsupported")
                )
            {
                observed.message = snapshot.message.clone();
                observed.profile = safe_profile(credential);
                return (observed, profile_source.clone());
            }
            if observed.updated_at < snapshot.updated_at
                && !(snapshot.status == "unsupported".into() && snapshot.windows.is_empty())
            {
                return (snapshot, Some(account));
            }
            if profile_source.is_some() {
                let mut merged = if observed.provider_id.0 == "anthropic".into()
                    && observed.source == "response_headers".into()
                    && snapshot.source == "provider_internal_api".into()
                    && (snapshot.status == "available".into() || snapshot.status == "stale".into())
                {
                    merge_claude_observation(&observed, &snapshot, now)
                } else {
                    observed
                };
                merged.profile = safe_profile(credential);
                return (merged, profile_source.clone());
            }
            return (observed, None);
        }
        (snapshot, Some(account))
    }
    pub async fn list(&self, providers: &[provider::Id], refresh: bool, now: i64) -> Vec<Snapshot> {
        self.bound_list(providers, refresh, now)
            .await
            .into_iter()
            .map(|(snapshot, _)| snapshot)
            .collect()
    }
    async fn bound_list(
        &self,
        providers: &[provider::Id],
        refresh: bool,
        now: i64,
    ) -> Vec<(Snapshot, Option<LosslessString>)> {
        let available = providers
            .iter()
            .filter(|id| !retired(id))
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut targets = Vec::new();
        for provider in available.iter().cloned() {
            let saved = match self.credentials.list(&provider.0) {
                Ok(saved) => saved,
                Err(_) => {
                    targets.push((provider, None));
                    continue;
                }
            };
            if self
                .endpoints
                .0
                .contains_key(provider.0.as_str().unwrap_or(""))
                && saved.len() > 1
            {
                let mut saved = saved;
                saved.sort_by(|a, b| a.label().cmp(b.label()));
                targets.extend(
                    saved
                        .into_iter()
                        .map(|c| (provider.clone(), Some(c.id().clone()))),
                );
                continue;
            }
            targets.push((provider, None));
        }
        let mut snapshots = Vec::new();
        for chunk in targets.chunks(4) {
            let mut workers = tokio::task::JoinSet::new();
            for (index, (provider, credential)) in chunk.iter().enumerate() {
                let service = self.clone();
                let provider = provider.clone();
                let credential = credential.clone();
                workers.spawn(async move {
                    (
                        index,
                        service
                            .bound(provider, credential.as_ref(), refresh, now)
                            .await,
                    )
                });
            }
            let mut results = Vec::new();
            while let Some(result) = workers.join_next().await {
                match result {
                    Ok(result) => results.push(result),
                    Err(_) => continue,
                }
            }
            for (index, (provider, _)) in chunk.iter().enumerate() {
                if !results.iter().any(|(existing, _)| *existing == index) {
                    results.push((
                        index,
                        (
                            unavailable(
                                provider.clone(),
                                &label(provider),
                                now,
                                "error",
                                "Provider usage worker failed",
                            ),
                            None,
                        ),
                    ));
                }
            }
            results.sort_by_key(|(index, _)| *index);
            snapshots.extend(results.into_iter().map(|(_, snapshot)| snapshot));
        }
        if let Ok(observations) = self.observations.lock() {
            snapshots.extend(
                observations
                    .iter()
                    .filter(|((provider, source), _)| {
                        source.is_none()
                            && available.contains(provider)
                            && self
                                .credentials
                                .list(&provider.0)
                                .is_ok_and(|saved| saved.len() > 1)
                    })
                    .filter_map(|(_, snapshot)| {
                        current_observation(snapshot, now).map(|snapshot| (snapshot, None))
                    }),
            );
        }
        if let Some(command) = &self.app_server {
            let command = command.clone();
            let result = self
                .cache
                .get(
                    "openai:codex-app-server".into(),
                    0,
                    now,
                    60000,
                    refresh,
                    move || async move {
                        let mut snapshot = super::load_app_server(
                            &command,
                            provider::Id("openai".into()),
                            "Codex",
                            now,
                        )
                        .await?;
                        snapshot.profile = Some("Codex app-server".into());
                        Ok(snapshot)
                    },
                )
                .await;
            match result {
                Ok(snapshot) => {
                    if available.contains(&snapshot.provider_id) {
                        snapshots.push((snapshot, None));
                    }
                    if let Ok(mut errors) = self.auxiliary_errors.lock() {
                        errors.remove("codex-app-server");
                    }
                }
                Err(error) => {
                    if let Ok(mut errors) = self.auxiliary_errors.lock() {
                        errors.insert("codex-app-server", error);
                    }
                }
            }
        }
        if let Some(store) = &self.store {
            let store = store.clone();
            let local =
                tokio::task::spawn_blocking(move || super::local_spend_from_store(&store, now))
                    .await
                    .unwrap_or(Err(Error::Worker));
            match local {
                Ok(local) => {
                    snapshots.extend(
                        local
                            .into_iter()
                            .filter(|s| available.contains(&s.provider_id))
                            .map(|snapshot| (snapshot, None)),
                    );
                    if let Ok(mut errors) = self.auxiliary_errors.lock() {
                        errors.remove("local-spend");
                    }
                }
                Err(error) => {
                    if let Ok(mut errors) = self.auxiliary_errors.lock() {
                        errors.insert("local-spend", error);
                    }
                }
            }
        }
        snapshots
    }
    pub fn observe(
        &self,
        observation: Observation,
        profile_source: Option<LosslessString>,
    ) -> Result<(), Error> {
        if retired(&observation.provider_id) {
            return Err(Error::ProviderRetired);
        }
        let key = (observation.provider_id.clone(), profile_source.clone());
        let profile = if let Some(source) = &profile_source {
            self.credentials
                .list(&observation.provider_id.0)
                .map_err(|_| Error::Storage)?
                .iter()
                .find(|credential| super::super::account_identity(credential) == *source)
                .and_then(safe_profile)
        } else {
            None
        };
        let mut snapshot = Snapshot {
            provider_id: observation.provider_id,
            label: observation.label,
            profile,
            status: "available".into(),
            source: observation.source,
            stability: observation.stability,
            updated_at: observation.observed_at,
            windows: observation.windows,
            message: None,
        };
        let mut state = self.publication.lock().map_err(|_| Error::Worker)?;
        if state.closed {
            return Err(Error::Closed);
        }
        {
            let mut observations = self.observations.lock().map_err(|_| Error::Worker)?;
            if let Some(current) = observations.get(&key) {
                if current.updated_at > snapshot.updated_at {
                    return Ok(());
                }
                if snapshot.provider_id.0 == "anthropic".into() {
                    let retained = current
                        .windows
                        .iter()
                        .filter(|window| {
                            exhausted_window(window, snapshot.updated_at.get())
                                && !snapshot
                                    .windows
                                    .iter()
                                    .any(|reported| reported.id == window.id)
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    snapshot.windows.extend(retained);
                }
                if current == &snapshot {
                    return Ok(());
                }
            }
            observations.insert(key, snapshot.clone());
        }
        if let Some(account) = &profile_source {
            self.record(&snapshot, account);
        }
        state.revision = state.revision.wrapping_add(1);
        drop(state);
        if let Some(account) = &profile_source {
            self.alert(&snapshot, account, snapshot.updated_at.get());
        }
        self.notify_changes();
        Ok(())
    }
    fn forecast_snapshot(
        &self,
        snapshots: &[(Snapshot, Option<LosslessString>)],
        location: bool,
        now: NonNegativeInt,
        local_rates: Option<Vec<usage_forecast::LocalRate>>,
    ) -> Result<usage_forecast::Info, Error> {
        let as_of = now.get();
        let history = self.history.lock().map_err(|_| Error::Worker)?;
        let quotas = Some({
            snapshots
                .iter()
                .filter(|(snapshot, _)| snapshot.source != "local_session".into())
                .flat_map(|(snapshot, account)| {
                    let history = &history;
                    snapshot.windows.iter().map(move |window| {
                        let semantics = super::forecast::semantics(&snapshot.provider_id, window);
                        let pace = (snapshot.status == "available".into()
                            && snapshot.updated_at.get() <= as_of
                            && as_of - snapshot.updated_at.get() <= super::forecast::FRESHNESS)
                            .then(|| super::pace::pace(window, semantics, as_of))
                            .flatten()
                            .map(|pace| usage_forecast::Pace {
                                verdict: usage_forecast::PaceVerdict(pace.verdict.as_str().into()),
                                projected_used_at_reset: pace.projected_used_at_reset,
                                exhaustion_at: pace
                                    .exhaustion_at
                                    .and_then(|at| NonNegativeInt::new(at).ok()),
                            });
                        let estimate = history.quota(super::forecast::QuotaRequest {
                            account: account.as_ref(),
                            snapshot,
                            window,
                            now: as_of,
                            semantics,
                            whole_window_mean: snapshot.provider_id.0 == "cursor".into()
                                && window.id == "included".into(),
                        });
                        usage_forecast::Quota {
                            provider_id: snapshot.provider_id.clone(),
                            profile: snapshot.profile.clone().map(model::ProfileName),
                            window_id: window.id.clone(),
                            unit: provider_usage::Unit(window.unit.clone()),
                            source: provider_usage::Source(estimate.source),
                            stability: provider_usage::Stability(estimate.stability),
                            updated_at: observed(estimate.updated_at),
                            state: usage_forecast::QuotaState(estimate.state.into()),
                            method: estimate
                                .method
                                .map(|method| usage_forecast::Method(method.into())),
                            evidence: usage_forecast::Evidence(estimate.evidence.into()),
                            reason: estimate.reason.map(Into::into),
                            observed_from: estimate.observed_from.map(observed),
                            observed_to: estimate.observed_to.map(observed),
                            rate_per_hour: estimate.rate_per_hour,
                            exhaustion_at: estimate
                                .exhaustion_at
                                .and_then(|at| NonNegativeInt::new(at).ok()),
                            projected_used_at_reset: estimate.projected_used_at_reset,
                            pace,
                        }
                    })
                })
                .collect()
        });
        Ok(usage_forecast::Info {
            as_of: now,
            local_scope: usage_forecast::LocalScope(
                if location { "location" } else { "backend" }.into(),
            ),
            local_rates,
            quotas,
        })
    }
    fn record(&self, snapshot: &Snapshot, account: &LosslessString) {
        if let Ok(mut history) = self.history.lock() {
            for window in &snapshot.windows {
                history.observe(
                    account,
                    snapshot,
                    window,
                    super::forecast::semantics(&snapshot.provider_id, window),
                );
            }
        }
    }
    fn alert(&self, snapshot: &Snapshot, account: &LosslessString, now: i64) {
        for window in &snapshot.windows {
            self.alerts.offer(AlertJob {
                observation: super::pace_alerts::Observation {
                    account: account.clone(),
                    provider_id: snapshot.provider_id.clone(),
                    label: snapshot.label.clone(),
                    profile: snapshot.profile.clone(),
                    available: snapshot.status == "available".into(),
                    updated_at: snapshot.updated_at.get(),
                    window: window.clone(),
                    semantics: super::forecast::semantics(&snapshot.provider_id, window),
                    now,
                },
                events: self.events.clone(),
            });
        }
    }
    pub async fn flush_alerts(&self) {
        let alerts = self.alerts.clone();
        let _ = tokio::task::spawn_blocking(move || alerts.flush()).await;
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        self.retire_publications();
        self.flush_alerts().await;
        self.cache.shutdown().await
    }
    async fn load(
        &self,
        provider: provider::Id,
        label: &str,
        credential: Info,
        now: i64,
    ) -> Result<Snapshot, Error> {
        let prepared = self
            .preparation
            .prepare_value(
                &self.credentials,
                credential.clone(),
                now,
                self.claude.as_ref(),
            )
            .await
            .map_err(|_| Error::Request(Some(401)))?;
        let value = prepared.domain().map_err(|_| Error::InvalidResponse)?;
        let key = match &value {
            credential::Value::Key(key) => key.key.to_utf8().map_err(|_| Error::InvalidResponse)?,
            credential::Value::OAuth(oauth) => {
                oauth.access.to_utf8().map_err(|_| Error::InvalidResponse)?
            }
        };
        let base = self
            .endpoints
            .0
            .get(provider.0.as_str().ok_or(Error::InvalidResponse)?)
            .ok_or(Error::InvalidResponse)?;
        match provider.0.as_str() {
            Some("anthropic") => {
                let stored = credential
                    .secret()
                    .domain()
                    .map_err(|_| Error::InvalidResponse)?;
                let source = crate::resources::auth::claude::credential_source(&stored);
                let Some(source) = source else {
                    let mut snapshot = unavailable(
                        provider,
                        "Claude",
                        now,
                        "unsupported",
                        "Claude subscription usage requires a Claude Code OAuth account",
                    );
                    snapshot.source = "provider_internal_api".into();
                    snapshot.stability = "best_effort".into();
                    return Ok(snapshot);
                };
                let store = self.claude.as_ref().ok_or(Error::Request(Some(401)))?;
                let current = store
                    .resolve(source, now, false)
                    .await
                    .map_err(|_| Error::Request(Some(401)))?
                    .ok_or(Error::Request(Some(401)))?;
                let request = |access: &str| {
                    self.client
                        .get(format!("{base}/api/oauth/usage"))
                        .bearer_auth(access)
                        .header("anthropic-beta", "oauth-2025-04-20")
                };
                let first = self.response(request(&current.access_token)).await;
                let (response, subscription, access) = if matches!(
                    first,
                    Err(Error::Request(Some(401)) | Error::RequestWithRetry { status: 401, .. })
                ) {
                    match store.resolve(source, now, true).await {
                        Ok(Some(rotated)) if rotated.access_token != current.access_token => {
                            self.credentials
                                .current_account(&credential)
                                .map_err(|_| Error::InvalidResponse)?;
                            let access = rotated.access_token.clone();
                            (
                                self.response(request(&access)).await,
                                rotated.subscription_type,
                                access,
                            )
                        }
                        _ => (
                            first,
                            current.subscription_type,
                            current.access_token.clone(),
                        ),
                    }
                } else {
                    (
                        first,
                        current.subscription_type,
                        current.access_token.clone(),
                    )
                };
                self.credentials
                    .current_account(&credential)
                    .map_err(|_| Error::InvalidResponse)?;
                let label = match subscription
                    .as_deref()
                    .map(str::trim)
                    .map(str::to_ascii_lowercase)
                    .as_deref()
                {
                    Some("pro") => "Claude Pro",
                    Some("max") => "Claude Max",
                    _ => "Claude",
                };
                let mut snapshot = super::normalize_claude(provider, label, now, &response?)?;
                match self
                    .claude_prepaid_balance(base, store, source, &access, now)
                    .await
                {
                    Some(balance) => snapshot.windows.push(balance),
                    None => snapshot.message = Some("Prepaid balance unavailable".into()),
                }
                Ok(snapshot)
            }
            Some("openai") => {
                if let credential::Value::OAuth(oauth) = &value {
                    if ["chatgpt-browser", "chatgpt-headless"]
                        .iter()
                        .any(|method| oauth.method_id.as_lossless() == &(*method).into())
                    {
                        let base = self
                            .endpoints
                            .0
                            .get("codex")
                            .ok_or(Error::InvalidResponse)?;
                        let mut request = self
                            .client
                            .get(format!("{base}/wham/usage"))
                            .bearer_auth(&key);
                        if let Some(account) = oauth
                            .metadata
                            .as_ref()
                            .and_then(|m| m.get(&"accountID".into()))
                            .and_then(text)
                        {
                            request = request.header("ChatGPT-Account-ID", account);
                        }
                        return normalize_codex(
                            provider,
                            "Codex",
                            now,
                            &self.response(request).await?,
                            "provider_internal_api",
                            "best_effort",
                        );
                    }
                    return Err(Error::InvalidResponse);
                }
                let credential::Value::Key(key_value) = &value else {
                    return Err(Error::InvalidResponse);
                };
                if !key_value.metadata.as_ref().is_some_and(|m| {
                    ["usageAdmin", "usage_admin"]
                        .iter()
                        .any(|key| m.get(&(*key).into()) == Some(&JsonValue::Bool(true)))
                }) {
                    let window = self.openai_credit_balance(base, &key).await?;
                    let mut snapshot =
                        empty(provider, label, now, "provider_internal_api", "best_effort");
                    snapshot.windows = vec![window];
                    return Ok(snapshot);
                }
                let (week, month) = utc_starts(now);
                let query = format!(
                    "start_time={}&end_time={}&bucket_width=1d&limit=31",
                    week.min(month),
                    now.div_euclid(1000)
                );
                let organization = async {
                    let usage = self
                        .pages(
                            format!("{base}/organization/usage/completions?{query}"),
                            &key,
                        )
                        .await?;
                    let costs = self
                        .pages(format!("{base}/organization/costs?{query}"), &key)
                        .await?;
                    normalize_organization(
                        provider.clone(),
                        label,
                        now,
                        (week as f64, month as f64),
                        &usage,
                        &costs,
                        false,
                    )
                }
                .await;
                match organization {
                    Ok(mut snapshot) => {
                        match self.openai_credit_balance(base, &key).await {
                            Ok(window) => {
                                snapshot.source = "provider_internal_api".into();
                                snapshot.stability = "best_effort".into();
                                snapshot.windows.push(window);
                            }
                            Err(_) => {
                                snapshot.message = Some("API credit balance unavailable".into());
                            }
                        }
                        Ok(snapshot)
                    }
                    Err(usage_error) => {
                        let window = self
                            .openai_credit_balance(base, &key)
                            .await
                            .map_err(|_| usage_error)?;
                        let mut snapshot =
                            empty(provider, label, now, "provider_internal_api", "best_effort");
                        snapshot.windows = vec![window];
                        snapshot.message = Some("Organization usage unavailable".into());
                        Ok(snapshot)
                    }
                }
            }
            Some("meta") => {
                if !matches!(value, credential::Value::Key(_)) {
                    return Err(Error::InvalidResponse);
                }
                let (week, month) = utc_starts(now);
                let query = format!(
                    "start_time={}&end_time={}&bucket_width=1d&limit=31",
                    week.min(month),
                    now.div_euclid(1000)
                );
                let usage = self
                    .pages(
                        format!("{base}/organization/usage/completions?{query}"),
                        &key,
                    )
                    .await?;
                let costs = self
                    .pages(format!("{base}/organization/costs?{query}"), &key)
                    .await?;
                normalize_organization(
                    provider,
                    label,
                    now,
                    (week as f64, month as f64),
                    &usage,
                    &costs,
                    true,
                )
            }
            Some("xai") => {
                if !matches!(&value,credential::Value::OAuth(oauth) if ["browser","device"].iter().any(|method| oauth.method_id.as_lossless() == &(*method).into()))
                {
                    let mut snapshot = unavailable(
                        provider,
                        "Grok",
                        now,
                        "unsupported",
                        "Grok Build usage requires a connected xAI subscription account",
                    );
                    snapshot.source = "provider_internal_api".into();
                    snapshot.stability = "best_effort".into();
                    return Ok(snapshot);
                }
                normalize_grok(
                    provider,
                    "Grok",
                    now,
                    &self
                        .request(format!("{base}/billing?format=credits"), &key, false)
                        .await?,
                )
            }
            Some("zai" | "zai-coding-plan") => {
                if !matches!(value, credential::Value::Key(_)) {
                    return Err(Error::InvalidResponse);
                }
                let quota = self
                    .request(format!("{base}/api/monitor/usage/quota/limit"), &key, false)
                    .await?;
                if field(&quota, "success") == Some(&JsonValue::Bool(false))
                    && field(&quota, "msg")
                        .and_then(text)
                        .is_some_and(|s| s.to_lowercase().contains("coding plan"))
                {
                    let mut snapshot = unavailable(
                        provider,
                        "Z.ai",
                        now,
                        "unsupported",
                        "No active GLM Coding Plan",
                    );
                    snapshot.source = "provider_internal_api".into();
                    snapshot.stability = "best_effort".into();
                    return Ok(snapshot);
                }
                let plan = self
                    .request(format!("{base}/api/biz/subscription/list"), &key, false)
                    .await
                    .ok();
                normalize_zai(provider, "Z.ai", now, &quota, plan.as_ref())
            }
            Some("github-copilot") => {
                let credential::Value::OAuth(oauth) = &value else {
                    return Err(Error::InvalidResponse);
                };
                if oauth
                    .metadata
                    .as_ref()
                    .and_then(|m| m.get(&"enterpriseUrl".into()))
                    .and_then(text)
                    .is_some_and(|s| !s.is_empty())
                {
                    return Ok(unavailable(
                        provider,
                        label,
                        now,
                        "unsupported",
                        "GitHub Copilot usage reporting supports github.com accounts",
                    ));
                }
                let token = oauth
                    .refresh
                    .to_utf8()
                    .map_err(|_| Error::InvalidResponse)?;
                let account = (
                    provider.clone(),
                    credential.id().clone(),
                    credential.account_generation(),
                );
                let remembered = self
                    .matched_orgs
                    .lock()
                    .map_err(|_| Error::Worker)?
                    .get(&account)
                    .cloned();
                let result =
                    super::load_copilot(provider, label, now, remembered.as_deref(), |path| {
                        self.response(
                            self.client
                                .get(format!("{base}{path}"))
                                .header("Authorization", format!("token {token}"))
                                .header("X-GitHub-Api-Version", "2025-04-01")
                                .header("Editor-Version", &self.user_agent)
                                .header("Editor-Plugin-Version", &self.user_agent),
                        )
                    })
                    .await?;
                let mut organizations = self.matched_orgs.lock().map_err(|_| Error::Worker)?;
                if let Some(matched) = result.matched_org {
                    organizations.insert(account, matched);
                } else {
                    organizations.remove(&account);
                }
                Ok(result.snapshot)
            }
            Some("openrouter") => {
                if !matches!(value, credential::Value::Key(_)) {
                    return Err(Error::InvalidResponse);
                }
                let response = self.request(format!("{base}/key"), &key, false).await;
                let initial = match &response {
                    Ok(response) => {
                        normalize_openrouter(provider.clone(), label, now, response, None)?
                    }
                    Err(
                        Error::Request(Some(401 | 403))
                        | Error::RequestWithRetry {
                            status: 401 | 403, ..
                        },
                    ) => empty(provider.clone(), label, now, "provider_api", "stable"),
                    Err(error) => return Err(*error),
                };
                match self.request(format!("{base}/credits"), &key, false).await {
                    Ok(credits) => {
                        let payload = response.as_ref().ok().cloned().unwrap_or_else(|| {
                            ycoding_schema::parse_json(r#"{"data":{}}"#).expect("static JSON")
                        });
                        match normalize_openrouter(provider, label, now, &payload, Some(&credits)) {
                            Ok(snapshot) => Ok(snapshot),
                            Err(_) if response.is_ok() => Ok(initial),
                            Err(error) => Err(error),
                        }
                    }
                    Err(_) if response.is_ok() => Ok(initial),
                    Err(error) => Err(error),
                }
            }
            Some("opencode-go") => normalize_go(
                provider,
                "OpenCode Go",
                now,
                &self.request(format!("{base}/usage"), &key, false).await?,
            ),
            Some("cursor") => {
                let usage = self
                    .request(format!("{base}/GetCurrentPeriodUsage"), &key, true)
                    .await?;
                let plan = self
                    .request(format!("{base}/GetPlanInfo"), &key, true)
                    .await
                    .ok();
                normalize_cursor(provider, "Cursor", now, &usage, plan.as_ref())
            }
            _ => Err(Error::InvalidResponse),
        }
    }
    async fn openai_credit_balance(
        &self,
        base: &str,
        key: &str,
    ) -> Result<provider_usage::Window, Error> {
        let body = self
            .request(
                format!("{base}/dashboard/billing/credit_grants"),
                key,
                false,
            )
            .await?;
        let Some(JsonValue::Number(total)) = field(&body, "total_available") else {
            return Err(Error::InvalidResponse);
        };
        if !total.is_finite() || *total < 0.0 {
            return Err(Error::InvalidResponse);
        }
        let mut window = super::window("api-credit-balance", "API credit balance", "usd");
        window.remaining = Some(*total);
        Ok(window)
    }
    async fn claude_prepaid_balance(
        &self,
        base: &str,
        store: &crate::resources::auth::claude::Store,
        source: &str,
        access: &str,
        now: i64,
    ) -> Option<provider_usage::Window> {
        let profile = self
            .request(format!("{base}/api/oauth/profile"), access, false)
            .await
            .ok()?;
        let organization = field(&profile, "organization")?;
        let organization = field(organization, "uuid").and_then(text)?;
        if !valid_organization_uuid(organization) {
            return None;
        }
        let current = store.reload(source, now).await.ok().flatten()?;
        if current.access_token != access {
            return None;
        }
        let body = self
            .response(
                self.client
                    .get(format!(
                        "{base}/api/oauth/organizations/{organization}/prepaid/credits"
                    ))
                    .bearer_auth(access)
                    .header("x-organization-uuid", organization)
                    .header("anthropic-version", "2023-06-01"),
            )
            .await
            .ok()?;
        let Some(JsonValue::Number(amount)) = field(&body, "amount") else {
            return None;
        };
        if !amount.is_finite() || *amount < 0.0 {
            return None;
        }
        if !field(&body, "currency")
            .and_then(text)
            .is_some_and(|currency| currency.eq_ignore_ascii_case("USD"))
        {
            return None;
        }
        let latest = store.reload(source, now).await.ok().flatten()?;
        if latest.access_token != access {
            return None;
        }
        let mut window = super::window("prepaid-balance", "Prepaid balance", "usd");
        window.remaining = Some(amount / 100.0);
        Some(window)
    }
    async fn request(&self, url: String, key: &str, rpc: bool) -> Result<JsonValue, Error> {
        let request = if rpc {
            self.client
                .post(url)
                .header("connect-protocol-version", "1")
                .header("Content-Type", "application/json")
                .body("{}")
        } else {
            self.client.get(url)
        };
        self.response(request.bearer_auth(key)).await
    }
    async fn response(&self, request: reqwest::RequestBuilder) -> Result<JsonValue, Error> {
        let response = request
            .header("Accept", "application/json")
            .header("User-Agent", &self.user_agent)
            .send()
            .await
            .map_err(|_| Error::Request(None))?;
        if !response.status().is_success() {
            if let Some(retry) = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| {
                    value
                        .parse::<f64>()
                        .ok()
                        .filter(|value| value.is_finite() && *value >= 0.0)
                        .map(|value| (value * 1000.0) as u64)
                })
            {
                return Err(Error::RequestWithRetry {
                    status: response.status().as_u16(),
                    retry_after_ms: retry,
                });
            }
            return Err(Error::Request(Some(response.status().as_u16())));
        }
        ycoding_schema::parse_json(&response.text().await.map_err(|_| Error::InvalidResponse)?)
            .map_err(|_| Error::InvalidResponse)
    }
    async fn pages(&self, url: String, key: &str) -> Result<Vec<JsonValue>, Error> {
        let mut values = Vec::new();
        let mut next = None;
        loop {
            let target = next
                .as_ref()
                .map(|next: &String| {
                    format!(
                        "{url}&page={}",
                        url::form_urlencoded::byte_serialize(next.as_bytes()).collect::<String>()
                    )
                })
                .unwrap_or_else(|| url.clone());
            let response = self.request(target, key, false).await?;
            let Some(JsonValue::Array(data)) = field(&response, "data") else {
                return Err(Error::InvalidResponse);
            };
            values.extend(data.iter().cloned());
            next = if field(&response, "has_more") == Some(&JsonValue::Bool(true)) {
                field(&response, "next_page")
                    .and_then(text)
                    .map(str::to_owned)
            } else {
                None
            };
            if next.is_none() {
                return Ok(values);
            }
        }
    }
}
fn utc_starts(now: i64) -> (i64, i64) {
    let day = now.div_euclid(86400000);
    let week = day - (day + 3).rem_euclid(7);
    let z = day + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (
        week * 86400,
        date_millis(&format!("{year:04}-{month:02}-01")).unwrap_or(0.0) as i64 / 1000,
    )
}
fn observed(at: i64) -> NonNegativeInt {
    NonNegativeInt::new(at).expect("observation times come from validated snapshot times")
}
fn valid_organization_uuid(value: &str) -> bool {
    let groups = value.split('-').collect::<Vec<_>>();
    if groups.len() != 5
        || groups.iter().zip([8, 4, 4, 4, 12]).any(|(group, length)| {
            group.len() != length || !group.chars().all(|c| c.is_ascii_hexdigit())
        })
    {
        return false;
    }
    groups[2]
        .chars()
        .next()
        .is_some_and(|c| ('1'..='8').contains(&c))
        && groups[3]
            .chars()
            .next()
            .is_some_and(|c| matches!(c, '8' | '9' | 'a' | 'b' | 'A' | 'B'))
}
fn merge_claude_observation(observation: &Snapshot, fetched: &Snapshot, now: i64) -> Snapshot {
    let Some(mut observation) = current_observation(observation, now) else {
        return fetched.clone();
    };
    if observation.updated_at < fetched.updated_at {
        observation
            .windows
            .retain(|window| exhausted_window(window, now));
    }
    if observation.windows.is_empty() {
        return fetched.clone();
    }
    let mut windows = observation.windows.clone();
    windows.extend(
        fetched
            .windows
            .iter()
            .filter(|window| !observation.windows.iter().any(|seen| seen.id == window.id))
            .cloned(),
    );
    if windows.len() == observation.windows.len()
        && fetched.status == "available".into()
        && fetched.message.is_none()
    {
        return observation;
    }
    let mut merged = fetched.clone();
    merged.windows = windows;
    if fetched.status == "stale".into() || now - fetched.updated_at.get() >= 300_000 {
        merged.status = "stale".into();
    }
    merged
}
fn cache_key(provider: &provider::Id, credential: &Info) -> String {
    format!(
        "{:?}:{:?}:{}",
        provider,
        credential.id(),
        credential.account_generation()
    )
}
fn safe_profile(credential: &Info) -> Option<LosslessString> {
    let label = credential.label();
    (!label.is_empty() && !label.code_units().any(|unit| unit == u16::from(b'@')))
        .then(|| label.clone())
}
fn current_observation(snapshot: &Snapshot, now: i64) -> Option<Snapshot> {
    let mut snapshot = snapshot.clone();
    if snapshot.provider_id.0 == "anthropic".into() && snapshot.source == "response_headers".into()
    {
        snapshot
            .windows
            .retain(|window| window.reset_at.is_none_or(|reset| reset.get() > now));
        if snapshot.windows.is_empty() {
            return None;
        }
    }
    Some(snapshot)
}
fn exhausted_window(window: &provider_usage::Window, now: i64) -> bool {
    window.unit == "percent".into()
        && window.used.is_some_and(|used| used >= 100.0)
        && window.reset_at.is_some_and(|reset| reset.get() > now)
}
fn unavailable(
    provider: provider::Id,
    label: &str,
    now: i64,
    status: &str,
    message: &str,
) -> Snapshot {
    let mut snapshot = empty(provider, label, now, "provider_api", "stable");
    snapshot.status = status.into();
    snapshot.message = Some(message.into());
    snapshot
}
fn retired(id: &provider::Id) -> bool {
    id.0.as_str().is_some_and(provider::is_retired)
}

fn label(provider: &provider::Id) -> String {
    if provider.0 == "anthropic".into() {
        return "Claude".into();
    }
    provider
        .0
        .as_str()
        .unwrap_or("Provider")
        .split(['-', '_'])
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut c = s.chars();
            c.next()
                .map(|c| c.to_uppercase().collect::<String>())
                .unwrap_or_default()
                + c.as_str()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn deliver(evaluator: &super::pace_alerts::Evaluator, job: AlertJob) {
    let mut queue = VecDeque::from(evaluator.observe(job.observation));
    while let Some(delivery) = queue.pop_front() {
        let sent = publish(job.events.as_ref(), delivery.alert());
        queue.extend(delivery.settle(sent));
    }
}

fn publish(events: Option<&crate::event_feed::Feed>, alert: &super::pace_alerts::Alert) -> bool {
    let (Some(events), Ok(reset_at)) = (events, NonNegativeInt::new(alert.reset_at)) else {
        return false;
    };
    events
        .emit(
            Data::ProviderQuotaPace(Box::new(provider_usage::QuotaPaceAlert {
                provider_id: alert.provider_id.clone(),
                window_id: alert.window_id.clone(),
                milestone: provider_usage::PaceMilestone(alert.milestone.as_str().into()),
                reset_at,
                title: alert.milestone.title().into(),
                body: alert.body.clone(),
            })),
            None,
        )
        .is_ok()
}
