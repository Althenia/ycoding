use super::{Production, composition::Composition, meeting::Meetings, unavailable};
use crate::dispatch::Failure;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use ycoding_core::{
    event_feed::Feed,
    platform::{browser, computer, git, repository_cache, ripgrep_binary},
    resources::{auth, catalog, credential, discovery, model, project_artifact},
    session::{execution, store::Service},
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
    pub computer: Arc<ycoding_core::platform::computer::service::Coordinator>,
    pub locations: Arc<std::sync::OnceLock<crate::locations::WeakLocations>>,
    computer_client: Arc<ComputerClient>,
    controls: tokio::sync::Mutex<Option<super::controls::Owner>>,
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
        analytics: PathBuf,
    ) -> Result<Arc<Self>, Failure> {
        let composition = if reports {
            Composition::start_reports(client.clone(), analytics)?
        } else {
            Composition::start()?
        };
        let catalog = Arc::new(
            catalog::models_dev::Service::new(production.catalog.clone())
                .map_err(|_| unavailable("model catalog"))?,
        );
        catalog
            .event_source
            .bind(events.clone(), None)
            .map_err(|_| unavailable("model catalog events"))?;
        let providers = model::ProviderContext::new(
            production.configuration.env.clone(),
            env!("CARGO_PKG_VERSION"),
        )
        .map_err(|_| unavailable("provider context"))?;
        let cursor = auth::cursor::Store::new(
            auth::Client::provider("cursor", env!("CARGO_PKG_VERSION"))
                .map_err(|_| unavailable("Cursor account store"))?,
        );
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
        let quota =
            model::quota::Service::new(credentials.clone(), model::quota::Endpoints::provider())
                .map_err(|_| unavailable("provider usage"))?
                .with_version(env!("CARGO_PKG_VERSION"))
                .with_auth(preparation.clone(), Some(accounts.clone()))
                .with_events(events.clone())
                .with_store(client.clone());
        let claude = model::ClaudeHost {
            accounts: accounts.clone(),
            credentials: credentials.clone(),
            sessions: Service::new(client.clone()),
            quota,
            settings: Default::default(),
        };
        let mut auth = auth::integration::Draft::default();
        preparation
            .register(&mut auth, &production.configuration.env, Some(&accounts))
            .map_err(|_| unavailable("native account methods"))?;
        let mut account_catalog =
            catalog::AccountCatalog::new(preparation.clone(), production.configuration.env.clone())
                .map_err(|_| unavailable("account catalog"))?;
        account_catalog.claude = Some(accounts);
        let wellknown = Arc::new(auth::integration::WellKnown::new(
            discovery::wellknown::Service::new(
                client.clone(),
                production.configuration.env.clone(),
            )
            .map_err(|_| unavailable("wellknown source"))?,
        ));
        let roots = &production.configuration.roots;
        // Like the TypeScript accounting layer, cohort buckets use a fresh secret per process.
        let secret = (0..2)
            .map(|_| ycoding_core::meeting::store::uuid().map(|uuid| uuid.replace('-', "")))
            .collect::<Result<String, _>>()
            .map_err(|_| unavailable("artifact accounting secret"))?;
        let accounting = project_artifact::accounting::Service::new(client.clone(), secret);
        let sources = Arc::new(Mutex::new(
            project_artifact::source_registry::Registry::default(),
        ));
        let artifacts = project_artifact::store::Service::new(
            client.clone(),
            project_artifact::store::Paths {
                data: roots.data.clone(),
                home: roots.home.clone(),
                config: roots.config.clone(),
            },
            sources.clone(),
        )
        .with_accounting(accounting.clone());
        let admission = Arc::new(browser::admission::Admission::default());
        let store = Service::new(client);
        let sessions: browser::bridge::SessionCheck = Arc::new(move |id| {
            ycoding_core::ycoding_schema::session::Id::new(id.as_lossless().clone())
                .ok()
                .and_then(|id| store.get(&id).ok().flatten())
                .is_some_and(|session| session.time.archived.is_none())
        });
        let browser = browser::service::Service::new(
            credentials,
            admission.clone(),
            sessions.clone(),
            Default::default(),
        );
        #[cfg(unix)]
        let isolated_executor: Arc<dyn browser::isolated::Executor> =
            Arc::new(browser::chrome_executor::IsolatedChrome::installed());
        #[cfg(not(unix))]
        let isolated_executor: Arc<dyn browser::isolated::Executor> = Arc::new(UnsupportedIsolated);
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let computer_client = Arc::new(
            match helper_application(
                production
                    .configuration
                    .env
                    .get(crate::launch::FRONTEND_EXECUTABLE_KEY)
                    .map(String::as_str),
            ) {
                Ok(application) => ComputerClient::Ready(Arc::new(computer::bridged::Client {
                    native: Arc::new(ycoding_core::platform::computer::macos::NativeClient::new(
                        platform,
                        application,
                        Arc::new(ycoding_core::platform::computer::macos::LaunchServices),
                        std::time::Duration::from_secs(30),
                    )),
                    electron: Arc::new(
                        ycoding_core::platform::computer::electron::Bridge::new(Arc::new(
                            ycoding_core::platform::computer::electron::NativeRuntime,
                        ))
                        .map_err(|_| unavailable("computer Electron bridge"))?,
                    ),
                    platform: platform.into(),
                })),
                Err(error) => ComputerClient::Unavailable(error),
            },
        );
        let computer = ycoding_core::platform::computer::service::Coordinator::new(
            computer_client.clone(),
            platform,
        );
        let repositories = Arc::new(repository_cache::Service::new(
            roots.repos.clone(),
            roots.state.clone(),
            git,
        ));
        let ripgrep = Arc::new(
            ripgrep_binary::Service::new(roots.bin.clone())
                .map_err(|_| unavailable("ripgrep acquisition"))?,
        );
        let worker = composition.run(async {
            catalog
                .get()
                .await
                .map_err(|_| unavailable("model catalog"))?;
            Ok(catalog.start())
        })?;
        let globals = Arc::new(Self {
            composition,
            catalog,
            providers,
            preparation,
            accounts: tokio::sync::Mutex::new(account_catalog),
            claude,
            wellknown,
            auth,
            repositories,
            ripgrep,
            artifacts,
            accounting,
            sources,
            browser,
            isolated_executor,
            admission,
            sessions,
            meetings: Meetings::new(production.meeting),
            watcher: Arc::new(ycoding_core::platform::filesystem::watcher::Service::new(
                true,
            )),
            computer,
            locations: Default::default(),
            computer_client,
            controls: tokio::sync::Mutex::new(None),
            worker: Mutex::new(worker),
        });
        globals.composition.run(async {
            *globals.controls.lock().await = Some(globals.control_owner(events)?);
            Ok(())
        })?;
        Ok(globals)
    }

    fn control_owner(&self, events: Feed) -> Result<super::controls::Owner, Failure> {
        let paired = self.browser.clone();
        let native = self.computer.clone();
        let locations = self.locations.clone();
        super::controls::Owner::start(
            events,
            Arc::new(move |session, lifecycle| {
                let paired = paired.clone();
                let native = native.clone();
                let locations = locations.get().and_then(|locations| locations.upgrade());
                Box::pin(async move {
                    if let Some(execution) = execution::Execution::global() {
                        let _ = execution.request_interrupt(&session);
                    }
                    let local = match locations {
                        Some(locations) => locations.release_controls(&session).await,
                        None => Ok(()),
                    };
                    let browser = paired
                        .lifecycle(&session, lifecycle)
                        .await
                        .map_err(|_| unavailable("paired browser Session release"));
                    let computer = native
                        .release_session(
                            &session
                                .as_lossless()
                                .to_utf8()
                                .map_err(|_| unavailable("Session identity"))?,
                        )
                        .await
                        .map_err(|_| unavailable("computer Session release"));
                    if let Some(execution) = execution::Execution::global() {
                        execution.await_idle(&session).await;
                    }
                    local.and(browser).and(computer)
                })
            }),
        )
    }

    pub async fn release_session(
        &self,
        session: ycoding_core::ycoding_schema::session::Id,
    ) -> Result<(), Failure> {
        match self.controls.lock().await.as_ref() {
            Some(owner) => {
                owner
                    .release(session, browser::service::Lifecycle::Moved)
                    .await
            }
            None => Err(unavailable("control lifecycle owner")),
        }
    }

    pub async fn flush_controls(&self) -> Result<(), Failure> {
        match self.controls.lock().await.as_ref() {
            Some(owner) => owner.flush().await,
            None => Ok(()),
        }
    }

    pub async fn stop_controls(&self) -> Result<(), Failure> {
        match self.controls.lock().await.take() {
            Some(owner) => owner.close().await,
            None => Ok(()),
        }
    }

    #[cfg(test)]
    pub async fn replace_computer(
        &mut self,
        computer: Arc<computer::service::Coordinator>,
        events: Feed,
    ) -> Result<(), Failure> {
        self.stop_controls().await?;
        self.computer = computer;
        *self.controls.lock().await = Some(self.control_owner(events)?);
        Ok(())
    }

    pub async fn close(&self) -> Result<(), Failure> {
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let worker = match worker {
            Some(worker) => worker
                .shutdown()
                .await
                .map_err(|_| unavailable("model catalog worker")),
            None => Ok(()),
        };
        let controls = self.stop_controls().await;
        self.browser.shutdown();
        let computer = self
            .computer
            .shutdown()
            .await
            .map_err(|_| unavailable("computer coordinator"));
        let helper = self
            .computer_client
            .shutdown()
            .await
            .map_err(|_| unavailable("computer helper"));
        let quota = self
            .claude
            .quota
            .shutdown()
            .await
            .map_err(|_| unavailable("provider usage"));
        self.providers.shutdown().await;
        let cursor = match &self.preparation.cursor {
            Some(cursor) => cursor
                .shutdown()
                .await
                .map_err(|_| unavailable("Cursor accounts")),
            None => Ok(()),
        };
        let claude = self
            .claude
            .accounts
            .shutdown()
            .await
            .map_err(|_| unavailable("Claude accounts"));
        worker
            .and(controls)
            .and(computer)
            .and(helper)
            .and(quota)
            .and(cursor)
            .and(claude)
    }
}

#[cfg(not(unix))]
struct UnsupportedIsolated;
#[cfg(not(unix))]
impl browser::isolated::Executor for UnsupportedIsolated {
    fn launch(
        &self,
        _: browser::isolated::Launch,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> ycoding_core::platform::computer::Future<
        '_,
        Result<Arc<dyn browser::isolated::Runtime>, browser::isolated::ExecutorError>,
    > {
        Box::pin(async {
            Err(browser::isolated::ExecutorError {
                message: "Isolated browser requires macOS arm64".into(),
                phase: browser::isolated::Phase::Predispatch,
            })
        })
    }
}

fn helper_application(
    frontend: Option<&str>,
) -> Result<std::path::PathBuf, computer::types::NativeError> {
    frontend.and_then(|executable| std::path::Path::new(executable).parent()).map(|directory| directory.join(computer::macos::HELPER_APPLICATION)).ok_or_else(|| computer::types::NativeError::new(
        computer::types::Code::HelperUnavailable,
        "Computer use requires --frontend-executable with the installed YCoding frontend path",
        computer::types::Outcome::NotStarted,
    ))
}

enum ComputerClient {
    Ready(Arc<computer::bridged::Client>),
    Unavailable(computer::types::NativeError),
}

impl computer::service::Invoke for ComputerClient {
    fn invoke<'a>(
        &'a self,
        request: computer::types::Request,
        signal: tokio::sync::watch::Receiver<bool>,
    ) -> computer::Future<'a, Result<computer::types::Success, computer::types::NativeError>> {
        match self {
            Self::Ready(client) => client.invoke(request, signal),
            Self::Unavailable(error) => Box::pin(async { Err(error.clone()) }),
        }
    }
}

impl ComputerClient {
    async fn shutdown(&self) -> Result<(), computer::types::NativeError> {
        match self {
            Self::Ready(client) => client.shutdown().await,
            Self::Unavailable(_) => Ok(()),
        }
    }
}

#[cfg(test)]
mod frontend_helper_tests {
    use super::{ComputerClient, helper_application};
    use std::path::Path;
    use ycoding_core::platform::computer::{
        service::Invoke,
        types::{Code, Outcome, Owner, Request},
    };

    #[test]
    fn frontend_helper_uses_installed_directory_not_runtime_extraction_directory() {
        let root = std::env::temp_dir().join("ycoding-helper-path");
        let frontend = root.join("installed").join("ycoding");
        let runtime = root.join("cache/bin/runtime/version/digest/ycoding-runtime");
        let application = helper_application(Some(frontend.to_str().unwrap())).unwrap();
        assert_eq!(
            application,
            frontend
                .parent()
                .unwrap()
                .join(ycoding_core::platform::computer::macos::HELPER_APPLICATION)
        );
        assert_ne!(
            application,
            runtime
                .parent()
                .unwrap()
                .join(ycoding_core::platform::computer::macos::HELPER_APPLICATION)
        );
        assert!(application.starts_with(Path::new(&root.join("installed"))));
    }

    #[tokio::test]
    async fn missing_frontend_flag_reports_helper_unavailable_without_a_launch() {
        let error = helper_application(None).unwrap_err();
        let client = ComputerClient::Unavailable(error);
        let (_, signal) = tokio::sync::watch::channel(false);
        let result = client
            .invoke(
                Request::list(Owner {
                    session_id: "ses_fixture".into(),
                    call_id: "call_fixture".into(),
                }),
                signal,
            )
            .await
            .unwrap_err();
        assert_eq!(result.code, Code::HelperUnavailable);
        assert_eq!(result.outcome, Some(Outcome::NotStarted));
        assert!(result.message.contains("--frontend-executable"));
        client.shutdown().await.unwrap();
    }
}
