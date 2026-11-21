use super::{Production, composition::Composition, meeting::Meetings, unavailable};
use crate::dispatch::Failure;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use ycoding_core::{
    event_feed::Feed,
    platform::{browser, computer, git, repository_cache, ripgrep_binary},
    resources::{auth, catalog, credential, discovery, model, project_artifact},
    session::{execution, store::Service},
    ycoding_schema::location,
    ycoding_store::Client,
};

pub(super) struct Globals {
    pub composition: Composition,
    pub clock: Arc<dyn ycoding_core::session::runner::Clock>,
    pub generation: ycoding_core::generation_activity::Service,
    pub usage_dashboard: ycoding_core::usage_dashboard::Service,
    pub usage_views: ycoding_core::usage_view::Service,
    pub coordination: ycoding_core::coordination::Service,
    pub coordination_runtime:
        Arc<std::sync::OnceLock<ycoding_core::coordination::runtime::Runtime>>,
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
    pub interaction: Arc<ycoding_core::platform::interaction::Authority>,
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
        let interaction = interaction(
            &client,
            &events,
            production
                .configuration
                .env
                .get(crate::launch::FRONTEND_EXECUTABLE_KEY)
                .map(String::as_str),
            roots,
            &composition,
        )?;
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
        let store = Service::new(client.clone());
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
        computer.set_history_directory(
            roots
                .data
                .join(ycoding_core::platform::computer::history::DIRECTORY_NAME),
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
        let clock: Arc<dyn ycoding_core::session::runner::Clock> =
            Arc::new(ycoding_core::session::runner::WallClock);
        let generation =
            ycoding_core::generation_activity::Service::new(clock.now(), clock.nanos());
        let locations: Arc<std::sync::OnceLock<crate::locations::WeakLocations>> = Arc::default();
        let pricing_locations = locations.clone();
        let coordination = ycoding_core::coordination::Service::new(client.clone(), events.clone());
        let views = ycoding_core::usage_view::Service::new(
            Service::new(client.clone()),
            Some(Arc::new(move |reference| {
                pricing_locations
                    .get()
                    .and_then(|locations| locations.upgrade())
                    .ok_or(ycoding_core::ycoding_store::Error::Incompatible(
                        "Location pricing unavailable",
                    ))?
                    .pricing(reference)
            })),
        );
        let meter_clock = clock.clone();
        let usage_dashboard = composition.run(async {
            Ok(ycoding_core::usage_dashboard::Service::new(
                views.clone(),
                generation.clone(),
                Arc::new(move || (meter_clock.now(), meter_clock.nanos())),
            ))
        })?;
        let globals = Arc::new(Self {
            composition,
            clock,
            generation,
            usage_dashboard,
            usage_views: views,
            coordination,
            coordination_runtime: Arc::default(),
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
            interaction,
            isolated_executor,
            admission,
            sessions,
            meetings: Meetings::new(production.meeting),
            watcher: Arc::new(ycoding_core::platform::filesystem::watcher::Service::new(
                true,
            )),
            computer,
            locations,
            computer_client,
            controls: tokio::sync::Mutex::new(None),
            worker: Mutex::new(worker),
        });
        globals.composition.bind_reports(
            &client,
            globals.usage_views.clone(),
            globals.claude.quota.clone(),
            globals.locations.clone(),
        );
        globals.composition.run(async {
            *globals.controls.lock().await = Some(globals.control_owner(events)?);
            Ok(())
        })?;
        Ok(globals)
    }

    pub fn usage_changed(&self, location: Option<&location::Ref>) {
        if let Some(location) = location
            && self
                .locations
                .get()
                .and_then(|locations| locations.upgrade())
                .and_then(|locations| {
                    locations
                        .loaded_location(
                            location.directory.as_lossless(),
                            location.workspace_id.as_ref().map(|id| id.as_lossless()),
                        )
                        .ok()
                })
                .is_none()
        {
            return;
        }
        self.usage_views.catalog_changed(location, || {});
        self.composition.wake().notify();
    }

    pub fn replace_models(
        &self,
        location: &location::Ref,
        models: &model::Resolver,
        catalog: catalog::Catalog,
    ) -> Result<(), model::Error> {
        let loaded = self
            .locations
            .get()
            .and_then(|locations| locations.upgrade())
            .and_then(|locations| {
                locations
                    .loaded_location(
                        location.directory.as_lossless(),
                        location.workspace_id.as_ref().map(|id| id.as_lossless()),
                    )
                    .ok()
            });
        let result = if loaded.is_some() {
            self.usage_views
                .catalog_changed(Some(location), || models.replace(catalog))
        } else {
            models.replace(catalog)
        };
        self.composition.wake().notify();
        result
    }

    fn control_owner(&self, events: Feed) -> Result<super::controls::Owner, Failure> {
        let paired = self.browser.clone();
        let native = self.computer.clone();
        let locations = self.locations.clone();
        let usage_views = self.usage_views.clone();
        let wake = self.composition.wake();
        let usage_locations = self.locations.clone();
        super::controls::Owner::start(
            events,
            Arc::new(move |location| {
                if let Some(location) = location
                    && usage_locations
                        .get()
                        .and_then(|locations| locations.upgrade())
                        .and_then(|locations| {
                            locations
                                .loaded_location(
                                    location.directory.as_lossless(),
                                    location.workspace_id.as_ref().map(|id| id.as_lossless()),
                                )
                                .ok()
                        })
                        .is_none()
                {
                    return;
                }
                usage_views.catalog_changed(location, || {});
                wake.notify();
            }),
            Arc::new(move |session, lifecycle| {
                let paired = paired.clone();
                let native = native.clone();
                let locations = locations.get().and_then(|locations| locations.upgrade());
                Box::pin(async move {
                    let interrupt = !matches!(lifecycle, browser::service::Lifecycle::Archived);
                    if interrupt && let Some(execution) = execution::Execution::global() {
                        let _ = execution.request_interrupt(&session);
                    }
                    let local = match locations.filter(|_| interrupt) {
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
                    if interrupt && let Some(execution) = execution::Execution::global() {
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
        self.interaction.admit_captures(None);
        let interaction = self
            .interaction
            .shutdown()
            .await
            .map_err(|_| unavailable("interaction platforms"));
        let dashboard = self
            .usage_dashboard
            .shutdown()
            .await
            .map_err(|_| unavailable("Usage dashboard worker"));
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
            .and(interaction)
            .and(dashboard)
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
fn interaction_application(
    platform: &str,
    frontend: Option<&str>,
) -> Result<Option<PathBuf>, Failure> {
    use ycoding_core::platform::interaction::macos;
    let Some(frontend) = frontend.map(std::path::Path::new).filter(|p| {
        platform == "darwin"
            && p.is_absolute()
            && p.file_name()
                .is_some_and(|n| n == "ycoding" || n == "ycoding-node")
    }) else {
        return Ok(None);
    };
    let Some(directory) = frontend.parent() else {
        return Ok(None);
    };
    let application = directory.join(macos::APPLICATION);
    let executable = application.join("Contents/MacOS").join(macos::EXECUTABLE);
    let metadata = match std::fs::metadata(executable) {
        Ok(metadata) => metadata,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound
                    | std::io::ErrorKind::NotADirectory
                    | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            return Ok(None);
        }
        Err(_) => return Err(unavailable("Interaction helper discovery")),
    };
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    Ok((metadata.is_file() && executable).then_some(application))
}
fn interaction(
    client: &Client,
    events: &Feed,
    frontend: Option<&str>,
    roots: &ycoding_core::resources::config::Roots,
    composition: &Composition,
) -> Result<Arc<ycoding_core::platform::interaction::Authority>, Failure> {
    use ycoding_core::{
        platform::interaction::{self, Authority, Error, Options},
        ycoding_schema::session,
    };
    let usable = Service::new(client.clone());
    let label = usable.clone();
    let changed = usable.clone();
    let feed = events.clone();
    let authority = Authority::new(Options {
        usable: Arc::new(move |raw| {
            session::Id::new(raw)
                .ok()
                .and_then(|id| usable.get(&id).ok().flatten())
                .is_some_and(|info| {
                    info.scope == session::Scope::Bound && info.time.archived.is_none()
                })
        }),
        label: Arc::new(move |raw| {
            label
                .get(&session::Id::new(raw).map_err(|_| Error("unavailable"))?)
                .map_err(|_| Error("unavailable"))?
                .ok_or(Error("unavailable"))?
                .title
                .to_utf8()
                .map_err(|_| Error("unavailable"))
        }),
        changed: Arc::new(move |raw, generation| {
            let Ok(id) = session::Id::new(raw) else {
                return;
            };
            let Ok(Some(info)) = changed.get(&id) else {
                return;
            };
            if feed
                .emit(
                    ycoding_core::event_feed::Data::InteractionChanged(Box::new(
                        ycoding_core::event_feed::ephemeral::InteractionChanged {
                            session_id: id,
                            generation: ycoding_core::ycoding_schema::interaction::Generation(
                                generation.into(),
                            ),
                        },
                    )),
                    Some(info.location),
                )
                .is_err()
            {
                tracing::warn!("Interaction state event could not be published");
            }
        }),
        ..Options::default()
    });
    let macos = interaction_application(
        if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        },
        frontend,
    )?
    .map(|application| {
        interaction::macos::Adapter::installed(application, interaction::macos::SIGNING_SHA1)
    })
    .transpose()
    .map_err(|_| unavailable("Interaction helper"))?;
    let attachments = Arc::new(
        ycoding_core::resources::attachment_store::Store::new(roots.data.clone())
            .map_err(|_| unavailable("Interaction attachments"))?,
    );
    authority.admit_captures(Some(Arc::new(move |session, _generation, capture| {
        let attachments = attachments.clone();
        Box::pin(async move {
            let request = capture_request(&attachments, &session, capture)?;
            execution::Execution::global()
                .ok_or(Error("unavailable"))?
                .prompt(request, None)
                .await
                .map_err(|_| Error("unavailable"))?;
            Ok(())
        })
    })));
    composition.run(async {
        authority
            .mount_platforms(macos, roots.state.join("interaction-chrome-profiles.json"))
            .await
            .map_err(|_| unavailable("Interaction platforms"))
    })?;
    let weak = Arc::downgrade(&authority);
    client.observe_events(move |events| {
        let Some(authority) = weak.upgrade() else {
            return false;
        };
        for event in events {
            if matches!(
                event.type_.as_str(),
                Some("session.moved.1" | "session.archived.2" | "session.deleted.2")
            ) && let Some(id) = event.aggregate_id.as_str()
            {
                authority.revoke(id);
            }
        }
        true
    });
    Ok(authority)
}
fn capture_request(
    attachments: &ycoding_core::resources::attachment_store::Store,
    session: &str,
    capture: ycoding_core::platform::interaction::Value,
) -> Result<ycoding_core::session::pending::Request, ycoding_core::platform::interaction::Error> {
    use ycoding_core::{
        platform::interaction::{Error, Value},
        ycoding_schema::{prompt, session_delivery, session_message, session_pending},
    };
    fn text<'a>(value: &'a Value, key: &str) -> &'a str {
        value[key].as_str().unwrap_or_default()
    }
    let bytes = ycoding_core::meeting::pcm::decode_base64(text(&capture["frame"], "base64"))
        .ok_or(Error("invalid"))?;
    let content = attachments
        .import(&bytes)
        .map_err(|_| Error("unavailable"))?;
    let title = text(&capture, "title");
    let url = text(&capture, "url");
    let page = [
        title.to_owned(),
        if url.is_empty() {
            String::new()
        } else {
            format!("<{url}>")
        },
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    let caption = format!(
        "Interaction capture from {}{}",
        text(&capture, "label"),
        if page.is_empty() {
            String::new()
        } else {
            format!(": {page}")
        }
    );
    let event_id = crate::ids::event_id().map_err(|_| Error("unavailable"))?;
    Ok(ycoding_core::session::pending::Request {
        id: session_message::Id::from_event(&event_id),
        session_id: ycoding_core::ycoding_schema::session::Id::new(session)
            .map_err(|_| Error("invalid"))?,
        input: session_pending::Message::User(session_pending::UserMessage {
            data: session_pending::UserData {
                text: caption.into(),
                files: Some(vec![prompt::FileAttachment {
                    content,
                    mime: text(&capture["frame"], "mimeType").into(),
                    name: Some(
                        if capture["frame"]["mimeType"] == "image/png" {
                            "interaction-capture.png"
                        } else {
                            "interaction-capture.jpg"
                        }
                        .into(),
                    ),
                    description: None,
                    mention: None,
                }]),
                agents: None,
                metadata: None,
            },
            delivery: session_delivery::Delivery::Steer,
        }),
        event_id,
        created: crate::ids::now_millis(),
    })
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
#[cfg(all(test, unix))]
mod interaction_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use ycoding_core::platform::interaction::{from_domain, macos};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "interaction-layout-{}",
                ycoding_core::meeting::store::uuid().unwrap()
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn frontend(&self) -> PathBuf {
            self.0.join("ycoding")
        }
        fn install(&self, mode: u32) -> PathBuf {
            let application = self.0.join(macos::APPLICATION);
            let directory = application.join("Contents/MacOS");
            std::fs::create_dir_all(&directory).unwrap();
            let path = directory.join(macos::EXECUTABLE);
            std::fs::write(&path, "synthetic fixture").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
            application
        }
        fn resolve(&self) -> Option<PathBuf> {
            interaction_application("darwin", self.frontend().to_str()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn installed_interaction_helper_is_resolved_beside_the_frontend() {
        let f = Fixture::new();
        let application = f.install(0o700);
        assert_eq!(f.resolve(), Some(application));
    }
    #[test]
    fn missing_interaction_helper_disables_the_native_adapter() {
        let f = Fixture::new();
        assert_eq!(f.resolve(), None);
    }
    #[test]
    fn non_executable_interaction_helper_disables_the_native_adapter() {
        let f = Fixture::new();
        f.install(0o600);
        assert_eq!(f.resolve(), None);
    }
    #[test]
    fn interaction_helper_requires_the_frontend_flag_on_macos() {
        let f = Fixture::new();
        f.install(0o700);
        assert_eq!(interaction_application("darwin", None).unwrap(), None);
        assert_eq!(
            interaction_application("darwin", Some("relative/ycoding")).unwrap(),
            None
        );
        assert_eq!(
            interaction_application("linux", f.frontend().to_str()).unwrap(),
            None
        );
    }
    #[test]
    fn capture_becomes_a_steer_prompt_with_a_managed_image() {
        use ycoding_core::{
            resources::attachment_store,
            ycoding_schema::{parse_json, session_delivery, session_pending},
        };
        let f = Fixture::new();
        let attachments = attachment_store::Store::new(f.0.clone()).unwrap();
        let capture=from_domain(&parse_json(r#"{"label":"Selected Chrome tab","title":"Example","url":"https://example.test/page","frame":{"mimeType":"image/png","base64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=","width":1,"height":1}}"#).unwrap()).unwrap();
        let request = capture_request(&attachments, "ses_capture", capture).unwrap();
        assert_eq!(
            request.session_id.as_lossless().as_str(),
            Some("ses_capture")
        );
        let session_pending::Message::User(input) = request.input else {
            panic!("user prompt expected");
        };
        assert_eq!(input.delivery, session_delivery::Delivery::Steer);
        assert_eq!(
            input.data.text.as_str(),
            Some(
                "Interaction capture from Selected Chrome tab: Example <https://example.test/page>"
            )
        );
        let files = input.data.files.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].name.as_ref().unwrap().as_str(),
            Some("interaction-capture.png")
        );
        assert_eq!(files[0].mime.as_str(), Some("image/png"));
        let uri = attachment_store::managed_uri(&files[0].content);
        assert!(uri.starts_with("ycoding-attachment://sha256/"));
        assert_eq!(attachments.resolve_uri(&uri).unwrap(), files[0].content);
        assert!(
            attachments
                .read(&files[0].content)
                .unwrap()
                .starts_with(b"\x89PNG\r\n\x1a\n")
        );
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
