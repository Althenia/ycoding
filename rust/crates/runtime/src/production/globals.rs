use super::{Production, composition::Composition, meeting::Meetings, unavailable};
use crate::dispatch::Failure;
use std::sync::{Arc, Mutex, PoisonError};
use ycoding_core::{
    event_feed::Feed,
    platform::{browser, git, repository_cache, ripgrep_binary},
    resources::{auth, catalog, credential, discovery, model, project_artifact},
    session::store::Service,
    ycoding_store::Client,
};

pub(super) struct Globals {
    pub composition: Composition,
    pub catalog: Arc<catalog::models_dev::Service>,
    pub providers: model::ProviderContext,
    pub preparation: auth::Preparation,
    pub accounts: tokio::sync::Mutex<catalog::AccountCatalog>,
    pub claude: model::ClaudeHost,
    pub wellknown: Arc<auth::integration::WellKnown>,
    pub auth: auth::integration::Draft,
    pub repositories: Arc<repository_cache::Service>,
    pub ripgrep: Arc<ripgrep_binary::Service>,
    pub artifacts: project_artifact::store::Service,
    pub accounting: project_artifact::accounting::Service,
    pub sources: Arc<Mutex<project_artifact::source_registry::Registry>>,
    pub browser: Arc<browser::service::Service>,
    pub isolated_executor: Arc<dyn browser::isolated::Executor>,
    pub admission: Arc<browser::admission::Admission>,
    pub sessions: browser::bridge::SessionCheck,
    pub meetings: Meetings,
    pub watcher: Arc<ycoding_core::platform::filesystem::watcher::Service>,
    worker: Mutex<Option<catalog::models_dev::RefreshWorker>>,
}

impl Globals {
    pub fn start(
        client: Client,
        production: &Production,
        credentials: credential::Service,
        events: Feed,
        git: Arc<git::Service>,
        reports: bool,
    ) -> Result<Arc<Self>, Failure> {
        let composition = if reports {
            Composition::start_reports(client.clone(), production.configuration.roots.data.join("analytics"))?
        } else {
            Composition::start()?
        };
        let catalog = Arc::new(catalog::models_dev::Service::new(production.catalog.clone())
            .map_err(|_| unavailable("model catalog"))?);
        catalog.event_source.bind(events.clone(), None)
            .map_err(|_| unavailable("model catalog events"))?;
        let providers = model::ProviderContext::new(production.configuration.env.clone(), env!("CARGO_PKG_VERSION"))
            .map_err(|_| unavailable("provider context"))?;
        let cursor = auth::cursor::Store::new(auth::Client::provider("cursor", env!("CARGO_PKG_VERSION"))
            .map_err(|_| unavailable("Cursor account store"))?);
        let preparation = auth::Preparation {
            cursor: Some(cursor),
            providers: Some(providers.clone()),
            ..Default::default()
        };
        let accounts = auth::claude::Store::new(
            auth::claude::Source::system(production.configuration.roots.home.join(".claude"))
                .map_err(|_| unavailable("Claude account source"))?,
            auth::Client::provider("anthropic", env!("CARGO_PKG_VERSION"))
                .map_err(|_| unavailable("Claude account store"))?,
        );
        let quota = model::quota::Service::new(credentials.clone(), model::quota::Endpoints::provider())
            .map_err(|_| unavailable("provider usage"))?
            .with_version(env!("CARGO_PKG_VERSION"))
            .with_auth(preparation.clone(), Some(accounts.clone()))
            .with_store(client.clone());
        let claude = model::ClaudeHost {
            accounts: accounts.clone(),
            credentials: credentials.clone(),
            sessions: Service::new(client.clone()),
            quota,
            settings: Default::default(),
        };
        let mut auth = auth::integration::Draft::default();
        preparation.register(&mut auth, &production.configuration.env, Some(&accounts))
            .map_err(|_| unavailable("native account methods"))?;
        let mut account_catalog = catalog::AccountCatalog::new(preparation.clone(), production.configuration.env.clone())
            .map_err(|_| unavailable("account catalog"))?;
        account_catalog.claude = Some(accounts);
        let wellknown = Arc::new(auth::integration::WellKnown::new(
            discovery::wellknown::Service::new(client.clone(), production.configuration.env.clone())
                .map_err(|_| unavailable("wellknown source"))?,
        ));
        let roots = &production.configuration.roots;
        // Like the TypeScript accounting layer, cohort buckets use a fresh secret per process.
        let secret = (0..2)
            .map(|_| ycoding_core::meeting::store::uuid().map(|uuid| uuid.replace('-', "")))
            .collect::<Result<String, _>>()
            .map_err(|_| unavailable("artifact accounting secret"))?;
        let accounting = project_artifact::accounting::Service::new(client.clone(), secret);
        let sources = Arc::new(Mutex::new(project_artifact::source_registry::Registry::default()));
        let artifacts = project_artifact::store::Service::new(
            client.clone(),
            project_artifact::store::Paths {
                data: roots.data.clone(), home: roots.home.clone(), config: roots.config.clone(),
            },
            sources.clone(),
        )
        .with_accounting(accounting.clone());
        let admission = Arc::new(browser::admission::Admission::default());
        let store = Service::new(client);
        let sessions: browser::bridge::SessionCheck = Arc::new(move |id| {
            ycoding_core::ycoding_schema::session::Id::new(id.as_lossless().clone())
                .ok().and_then(|id| store.get(&id).ok().flatten())
                .is_some_and(|session| session.time.archived.is_none())
        });
        let browser = browser::service::Service::new(credentials, admission.clone(), sessions.clone(), Default::default());
        #[cfg(unix)]
        let isolated_executor: Arc<dyn browser::isolated::Executor> = Arc::new(browser::chrome_executor::IsolatedChrome::installed());
        #[cfg(not(unix))]
        let isolated_executor: Arc<dyn browser::isolated::Executor> = Arc::new(UnsupportedIsolated);
        let repositories = Arc::new(repository_cache::Service::new(roots.repos.clone(), roots.state.clone(), git));
        let ripgrep = Arc::new(ripgrep_binary::Service::new(roots.bin.clone())
            .map_err(|_| unavailable("ripgrep acquisition"))?);
        // The refresh worker is the only owner started here; starting it last keeps every
        // earlier failure free of started work beyond the composition runtime, which Drop joins.
        let worker = composition.run(async {
            catalog.get().await.map_err(|_| unavailable("model catalog"))?;
            Ok(catalog.start())
        })?;
        Ok(Arc::new(Self {
            composition, catalog, providers, preparation,
            accounts: tokio::sync::Mutex::new(account_catalog),
            claude, wellknown, auth, repositories, ripgrep,
            artifacts, accounting, sources, browser, isolated_executor, admission, sessions,
            meetings: Meetings::new(production.meeting),
            watcher: Arc::new(ycoding_core::platform::filesystem::watcher::Service::new(true)),
            worker: Mutex::new(worker),
        }))
    }

    pub async fn close(&self) -> Result<(), Failure> {
        let worker = self.worker.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(worker) = worker {
            worker.shutdown().await.map_err(|_| unavailable("model catalog worker"))?;
        }
        self.browser.shutdown();
        self.claude.quota.shutdown().await.map_err(|_| unavailable("provider usage"))?;
        self.providers.shutdown().await;
        if let Some(cursor) = &self.preparation.cursor {
            cursor.shutdown().await.map_err(|_| unavailable("Cursor accounts"))?;
        }
        self.claude.accounts.shutdown().await.map_err(|_| unavailable("Claude accounts"))
    }
}

#[cfg(not(unix))]
struct UnsupportedIsolated;
#[cfg(not(unix))]
impl browser::isolated::Executor for UnsupportedIsolated {
    fn launch(&self, _: browser::isolated::Launch, _: tokio::sync::watch::Receiver<bool>) ->
        ycoding_core::platform::computer::Future<'_, Result<Arc<dyn browser::isolated::Runtime>, browser::isolated::ExecutorError>> {
        Box::pin(async {
            Err(browser::isolated::ExecutorError {
                message: "Isolated browser requires macOS arm64".into(),
                phase: browser::isolated::Phase::Predispatch,
            })
        })
    }
}
