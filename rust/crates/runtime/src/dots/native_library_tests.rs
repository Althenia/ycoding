use super::*;
use crate::locations::Locations;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::{Notify, Semaphore};
use ycoding_core::{
    cca::error::{AuthorizationDenied, AuthorizationInput, Authorize, Grant},
    dots::native::executor_scope::LibraryPrincipal,
    event_feed::Feed,
    platform::git,
    process::guardrails::{Limits, Paths, Settings},
    resources::agent,
    session::autonomy,
    ycoding_schema::{DomainDecode, LosslessString, location, parse_json},
    ycoding_store::{
        KeyPart, Metadata, Options as StoreOptions, Store,
        project::{Project, ProjectTable},
        session::SessionTable,
        tuple_key,
    },
};

struct Fixture {
    client: ycoding_core::ycoding_store::Client,
    sessions: SessionStore,
    locations: Locations,
    session: session::Info,
    lease: Arc<LocationServices>,
}

fn session_info() -> session::Info {
    session::Info::decode(&parse_json(r#"{"id":"ses_native_library","projectID":"prj_native_library","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1,"updated":1},"title":"Synthetic Library","location":{"directory":"/synthetic-native-library"}}"#).unwrap()).unwrap()
}

impl Fixture {
    fn new() -> (Store, Self) {
        let store = Store::disposable(
            StoreOptions::core(),
            ycoding_core::ycoding_store::native::catalog(
                ycoding_core::ycoding_store::native::DatabaseKind::Core,
            ),
            Metadata::new([91; 16], 1),
        )
        .unwrap();
        let sessions = SessionStore::new(store.client());
        let info = session_info();
        let row = ycoding_core::ycoding_store::session::Session {
            id: info.id.as_lossless().clone(),
            project_id: info.project_id.as_lossless().clone(),
            workspace_id: None,
            parent_id: None,
            fork_session_id: None,
            fork_message_id: None,
            fork_seq: None,
            directory: info.location.directory.as_lossless().clone(),
            path: None,
            title: info.title.clone(),
            cost: 0.0,
            tokens_input: 0,
            tokens_output: 0,
            tokens_reasoning: 0,
            tokens_cache_read: 0,
            tokens_cache_write: 0,
            revert: None,
            permission: None,
            autonomy: None,
            autonomy_revision: 0,
            orchestration_revision: 0,
            agent: None,
            model: None,
            profile_binding: None,
            daybreak: None,
            time_created: 1,
            time_updated: 1,
            time_archived: None,
            time_active: None,
            time_pinned: None,
            time_suspended: None,
            usage_pruned_through: None,
            origin: None,
            scope: "bound".into(),
        };
        store
            .submit(move |tx| {
                ProjectTable::insert(
                    tx,
                    &Project {
                        id: row.project_id.clone(),
                        worktree: row.directory.clone(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )?;
                SessionTable::insert(tx, &row)
            })
            .unwrap()
            .wait()
            .unwrap();
        let locations = Locations::new(
            store.client(),
            sessions.clone(),
            crate::Configuration {
                agents: Arc::new(agent::Service::new(vec![])),
                publisher: Arc::new(|_| Ok(())),
                guardrails: Settings {
                    paths: Paths {
                        workdir: "/synthetic-native-library".into(),
                        project: "/synthetic-native-library".into(),
                        home: "/synthetic-home".into(),
                        tmpdir: None,
                        trusted_paths: vec![],
                    },
                    global_roots: vec![],
                    custom: Arc::new(Vec::new),
                    enabled: true,
                    limits: Limits::default(),
                    decide_reviews: false,
                    decide_hard_reviews: true,
                },
                snapshots: crate::SnapshotSettings {
                    git: Arc::new(git::Service::new(1024)),
                    data: "/synthetic-native-library-data".into(),
                    enabled: false,
                },
                helpers: None,
            },
            Feed::attach(&store.client()),
            autonomy::Service::new(store.client()),
            crate::session_review::service(sessions.clone()).0,
        );
        let lease = locations
            .move_location(&location::Info {
                directory: info.location.directory.clone(),
                workspace_id: None,
                project: location::Project {
                    id: info.project_id.clone(),
                    directory: info.location.directory.clone(),
                },
            })
            .unwrap();
        let fixture = Self {
            client: store.client(),
            sessions,
            locations,
            session: info,
            lease,
        };
        (store, fixture)
    }

    fn fence(&self, current: CurrentCheck) -> Fence {
        Fence {
            locations: self.locations.downgrade(),
            sessions: self.sessions.clone(),
            expected: self.session.clone(),
            lease: Arc::downgrade(&self.lease),
            original: current,
        }
    }

    async fn change(
        &self,
        change: impl FnOnce(&mut ycoding_core::ycoding_store::session::Session) + Send + 'static,
    ) {
        let key = tuple_key(&[KeyPart::String(self.session.id.as_lossless())]);
        self.client
            .submit(move |tx| {
                let mut row = tx.get::<SessionTable>(&key)?.unwrap();
                change(&mut row);
                SessionTable::put(tx, &row)
            })
            .unwrap()
            .await
            .unwrap();
    }
}

fn owned<T: Send + 'static>(
    runtime: &tokio::runtime::Runtime,
    test: impl FnOnce(Context) -> BoxFuture<'static, T>,
) -> (T, Report) {
    let joined = crate::production::owner::ProductionOwner::scope(runtime, |root| {
        let context = runtime
            .block_on(root.production_context().unwrap())
            .unwrap();
        runtime.block_on(test(context))
    });
    let body = joined.body.unwrap_or_else(|_| {
        panic!(
            "test body panicked; owner cleanup: {:?}",
            joined.cleanup.result()
        )
    });
    (body, joined.cleanup)
}

async fn library_context(context: &Context) -> Context {
    context
        .handle()
        .register(
            |context| Box::pin(async move { context }),
            |_| Box::pin(async { Report::default() }),
        )
        .unwrap()
        .await
        .unwrap()
}

fn owned_fixture(
    test: impl FnOnce(Context, Fixture) -> BoxFuture<'static, ()> + Send + 'static,
) -> Report {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let entered = runtime.enter();
    let (_store, fixture) = Fixture::new();
    drop(entered);
    let ((), report) = owned(&runtime, move |production| {
        Box::pin(async move {
            let context = library_context(&production).await;
            test(context, fixture).await;
        })
    });
    report
}

struct Deny;
impl Authorize for Deny {
    fn authorize(
        &self,
        _: AuthorizationInput,
    ) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>> {
        Box::pin(async { Err(AuthorizationDenied::default()) })
    }
}

fn current() -> CurrentCheck {
    Arc::new(|| Box::pin(async { Ok(()) }))
}

#[test]
fn selected_location_supplies_its_actual_managed_store() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let first = crate::production::tests::fixture("{}", "{}");
    let second = crate::production::tests::fixture("{}", "{}");
    let entered = runtime.enter();
    let first_locations = first.locations();
    let second_locations = second.locations();
    let first_lease = first.services(&first_locations);
    let second_lease = second.services(&second_locations);
    let first_session = first
        .sessions()
        .get(&session::Id::new("ses_one").unwrap())
        .unwrap()
        .unwrap();
    let second_session = second
        .sessions()
        .get(&session::Id::new("ses_one").unwrap())
        .unwrap()
        .unwrap();
    let first_fence = Fence {
        locations: first_locations.downgrade(),
        sessions: first.sessions(),
        expected: first_session.clone(),
        lease: Arc::downgrade(&first_lease),
        original: current(),
    };
    let second_fence = Fence {
        locations: second_locations.downgrade(),
        sessions: second.sessions(),
        expected: second_session.clone(),
        lease: Arc::downgrade(&second_lease),
        original: current(),
    };
    drop(entered);
    let ((), report) = owned(&runtime, move |_production| {
        Box::pin(async move {
            let first_input =
                library_input(scope(&first_session, current()), &first_lease, first_fence).unwrap();
            let second_input = library_input(
                scope(&second_session, current()),
                &second_lease,
                second_fence,
            )
            .unwrap();
            assert!(Arc::ptr_eq(
                &first_input.attachments,
                &first_lease
                    .production
                    .as_ref()
                    .unwrap()
                    .session_generate
                    .attachments
            ));
            assert!(Arc::ptr_eq(
                &second_input.attachments,
                &second_lease
                    .production
                    .as_ref()
                    .unwrap()
                    .session_generate
                    .attachments
            ));
            assert!(!Arc::ptr_eq(
                &first_input.attachments,
                &second_input.attachments
            ));
            assert!(Arc::ptr_eq(
                &first_input.configuration,
                &first_lease.production.as_ref().unwrap().configuration
            ));
            assert!(Arc::ptr_eq(
                &second_input.configuration,
                &second_lease.production.as_ref().unwrap().configuration
            ));
            drop(first_input);
            drop(second_input);
            drop(first_lease);
            drop(second_lease);
        })
    });
    report.result().unwrap();
    first_locations.close().unwrap();
    second_locations.close().unwrap();
}

fn scope(info: &session::Info, check: CurrentCheck) -> LibraryScope {
    LibraryScope {
        session_id: info.id.clone(),
        principal: LibraryPrincipal {
            profile: "synthetic-profile".into(),
            credential_id: "synthetic-credential".into(),
            account_id: "synthetic-account".into(),
            account_generation: 7,
            access_revision: 11,
        },
        roots: vec![
            "/synthetic-native-library".into(),
            "/synthetic-other".into(),
        ],
        current: check,
        authorize: Arc::new(Deny),
    }
}

fn input() -> LibraryOpenInput {
    LibraryOpenInput {
        process_id: "synthetic-process".into(),
        cwd: "/synthetic-native-library".into(),
        read_file: Arc::new(|_| Box::pin(async { panic!("reader must remain lazy") })),
    }
}

struct Backend {
    closes: AtomicUsize,
    close_gate: Semaphore,
    failure: Option<ExecutorError>,
    denied: bool,
    after_call: Option<Arc<dyn Fn() + Send + Sync>>,
    close_entered: Notify,
    after_close: Option<Arc<dyn Fn() + Send + Sync>>,
    values: Mutex<Vec<Value>>,
}

impl Backend {
    fn new(permits: usize, failure: Option<ExecutorError>) -> Arc<Self> {
        Arc::new(Self {
            closes: AtomicUsize::new(0),
            close_gate: Semaphore::new(permits),
            failure,
            denied: false,
            after_call: None,
            close_entered: Notify::new(),
            after_close: None,
            values: Mutex::new(vec![]),
        })
    }
}

impl LibraryProcess for Backend {
    fn check(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn tools(&self) -> Vec<LibraryTool> {
        vec![LibraryTool {
            name: "synthetic.tool".into(),
            definition: Value::String(LosslessString::from_utf16(vec![0xd800, 0x0061])),
        }]
    }
    fn call(&self, _: &str, arguments: Value) -> BoxFuture<'_, Result<Value, LibraryCallError>> {
        Box::pin(async move {
            if self.denied {
                return Err(LibraryCallError::Denied(AuthorizationDenied {
                    busy: true,
                    ..Default::default()
                }));
            }
            self.values.lock().unwrap().push(arguments.clone());
            if let Some(after_call) = &self.after_call {
                after_call();
            }
            Ok(arguments)
        })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async move {
            self.closes.fetch_add(1, Ordering::AcqRel);
            self.close_entered.notify_one();
            self.close_gate.acquire().await.unwrap().forget();
            if let Some(after_close) = &self.after_close {
                after_close();
            }
            self.failure.clone().map_or(Ok(()), Err)
        })
    }
}

struct BackendFactory {
    process: Arc<Backend>,
    gate: Semaphore,
    after_open: Option<Arc<dyn Fn() + Send + Sync>>,
    entered: Notify,
}

impl LibraryFactory for BackendFactory {
    fn open(
        &self,
        _: LibraryOpenInput,
    ) -> BoxFuture<'_, Result<Arc<dyn LibraryProcess>, ExecutorError>> {
        Box::pin(async move {
            self.entered.notify_one();
            self.gate.acquire().await.unwrap().forget();
            if let Some(after_open) = &self.after_open {
                after_open();
            }
            Ok(self.process.clone() as Arc<dyn LibraryProcess>)
        })
    }
}

#[test]
fn supplied_and_stored_identity_changes_refuse() {
    let expected = session_info();
    assert!(same_session(&expected, &expected));
    for changed in 0..8 {
        let mut actual = expected.clone();
        match changed {
            0 => actual.id = session::Id::new("ses_other").unwrap(),
            1 => {
                actual.project_id =
                    ycoding_core::ycoding_schema::project_id::ProjectId::new("prj_other").unwrap()
            }
            2 => {
                actual.location.directory =
                    ycoding_core::ycoding_schema::schema::AbsolutePath::new("/synthetic-other")
                        .unwrap()
            }
            3 => {
                actual.location.workspace_id = Some(
                    ycoding_core::ycoding_schema::workspace_id::WorkspaceId::new("wrk_other")
                        .unwrap(),
                )
            }
            4 => actual.time.archived = Some(actual.time.updated),
            5 => actual.parent_id = Some(session::Id::new("ses_parent").unwrap()),
            6 => {
                actual.time.created =
                    ycoding_core::ycoding_schema::schema::DateTimeUtcFromMillis::new(2.0).unwrap()
            }
            _ => {
                actual.subpath =
                    Some(ycoding_core::ycoding_schema::schema::RelativePath::new("other").unwrap())
            }
        }
        assert!(!same_session(&expected, &actual));
    }
}

#[test]
fn scope_and_supplied_session_mismatch_refuses_before_acquisition() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let calls = Arc::new(AtomicUsize::new(0));
            let check = calls.clone();
            let mut supplied_scope = scope(
                &f.session,
                Arc::new(move || {
                    check.fetch_add(1, Ordering::AcqRel);
                    Box::pin(async { Ok(()) })
                }),
            );
            supplied_scope.session_id = session::Id::new("ses_foreign").unwrap();
            let provider = provider(Options {
                locations: f.locations.downgrade(),
                sessions: f.sessions.clone(),
                owner: context.handle(),
            });
            assert!(provider.factory(supplied_scope, &f.session).await.is_err());
            assert_eq!(calls.load(Ordering::Acquire), 0);
            assert_eq!(Arc::strong_count(&f.lease), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn stored_move_and_archive_refuse_existing_fence() {
    for archive in [false, true] {
        let report = owned_fixture(move |_context, f| {
            Box::pin(async move {
                let fence = f.fence(current());
                fence.check().await.unwrap();
                f.change(move |row| {
                    if archive {
                        row.time_archived = Some(2);
                    } else {
                        row.directory = "/synthetic-other".into();
                    }
                })
                .await;
                assert!(fence.check().await.is_err());
            })
        });
        assert!(report.failures.is_empty());
    }
}

#[test]
fn retired_and_replaced_locations_refuse_existing_fence() {
    let report = owned_fixture(|_context, f| {
        Box::pin(async move {
            let fence = f.fence(current());
            f.locations
                .evict(f.session.location.directory.as_lossless(), None)
                .unwrap();
            assert!(fence.check().await.is_err());
            let replacement = f.locations.move_location(&f.lease.info).unwrap();
            assert!(f.locations.is_current(&replacement));
            assert!(fence.check().await.is_err());
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn original_currentness_is_checked_before_and_after_async_work() {
    let report = owned_fixture(|_context, f| {
        Box::pin(async move {
            let locations = f.locations.clone();
            let info = f.lease.info.clone();
            let calls = Arc::new(AtomicUsize::new(0));
            let count = calls.clone();
            let fence = f.fence(Arc::new(move || {
                let (locations, info) = (locations.clone(), info.clone());
                count.fetch_add(1, Ordering::AcqRel);
                Box::pin(async move {
                    locations.evict(info.directory.as_lossless(), None).unwrap();
                    Ok(())
                })
            }));
            assert!(fence.check().await.is_err());
            assert_eq!(calls.load(Ordering::Acquire), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn principal_roots_and_authorization_transfer_unchanged() {
    let report = owned_fixture(|_context, f| {
        Box::pin(async move {
            let scope = scope(&f.session, current());
            let original = scope.current.clone();
            let authorization = scope.authorize.clone();
            let roots = scope.roots.clone();
            let checked = checked_scope(scope, f.fence(original));
            assert_eq!(checked.principal.profile, "synthetic-profile");
            assert_eq!(checked.principal.credential_id, "synthetic-credential");
            assert_eq!(checked.principal.account_id, "synthetic-account");
            assert_eq!(checked.principal.account_generation, 7);
            assert_eq!(checked.principal.access_revision, 11);
            assert_eq!(checked.roots, roots);
            assert!(Arc::ptr_eq(&checked.authorize, &authorization));
            (checked.current)().await.unwrap();
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn constructor_is_lazy_and_global_locations_remain_weak() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let weak = f.locations.downgrade();
            let before = f.locations.cached();
            let provider = provider(Options {
                locations: weak.clone(),
                sessions: f.sessions.clone(),
                owner: context.handle(),
            });
            assert_eq!(f.locations.cached(), before);
            drop(f.locations);
            assert!(weak.upgrade().is_none());
            assert!(
                provider
                    .factory(scope(&f.session, current()), &f.session)
                    .await
                    .is_err()
            );
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn failed_factory_acquisition_releases_the_location_lease() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let before = Arc::strong_count(&f.lease);
            let provider = provider(Options {
                locations: f.locations.downgrade(),
                sessions: f.sessions.clone(),
                owner: context.handle(),
            });
            assert!(
                provider
                    .factory(scope(&f.session, current()), &f.session)
                    .await
                    .is_err()
            );
            assert_eq!(Arc::strong_count(&f.lease), before);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn process_preserves_lossless_tools_arguments_results_and_denials() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let backend = Backend::new(1, None);
            let process = Process::new(
                &context,
                backend.clone(),
                f.lease.clone(),
                f.fence(current()),
            );
            assert_eq!(process.tools(), backend.tools());
            let value = Value::String(LosslessString::from_utf16(vec![0xd800, 0x0000, 0xdc00]));
            assert_eq!(
                process.call("synthetic.tool", value.clone()).await.unwrap(),
                value
            );
            assert_eq!(*backend.values.lock().unwrap(), vec![value]);
            process.close().await.unwrap();
            let denied = Arc::new(Backend {
                denied: true,
                closes: AtomicUsize::new(0),
                close_gate: Semaphore::new(1),
                failure: None,
                after_call: None,
                close_entered: Notify::new(),
                after_close: None,
                values: Mutex::new(vec![]),
            });
            let process = Process::new(
                &context,
                denied.clone(),
                f.lease.clone(),
                f.fence(current()),
            );
            assert!(matches!(
                process.call("synthetic.tool", Value::Null).await,
                Err(LibraryCallError::Denied(AuthorizationDenied {
                    busy: true,
                    ..
                }))
            ));
            assert!(denied.values.lock().unwrap().is_empty());
            process.close().await.unwrap();
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn factory_and_process_retain_location_without_global_cycle() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let weak = Arc::downgrade(&f.lease);
            let locations = f.locations.downgrade();
            let backend = Backend::new(1, None);
            let core = Arc::new(BackendFactory {
                process: backend,
                gate: Semaphore::new(0),
                after_open: None,
                entered: Notify::new(),
            });
            let factory = Arc::new(Factory::new(
                &context,
                core.clone(),
                f.lease.clone(),
                f.fence(current()),
            ));
            let clone = factory.clone();
            let mut opening = factory.open(input());
            assert!(futures_util::poll!(&mut opening).is_pending());
            drop(f.lease);
            assert!(weak.upgrade().is_some());
            core.gate.add_permits(1);
            let process = opening.await.unwrap();
            drop(factory);
            cleanup_result(clone.resource.close().await).unwrap();
            drop(clone);
            assert!(weak.upgrade().is_some());
            process.close().await.unwrap();
            drop(f.locations);
            assert!(locations.upgrade().is_none());
            assert!(weak.upgrade().is_none());
            drop(process);
            assert!(weak.upgrade().is_none());
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn cancelled_close_resumes_retained_work_and_preserves_failure() {
    let expected = ExecutorError::new(-32123, "synthetic cleanup failure");
    let retained = expected.clone();
    let report = owned_fixture(move |context, f| {
        Box::pin(async move {
            let expected = retained;
            let backend = Backend::new(0, Some(expected.clone()));
            let process = Arc::new(Process::new(
                &context,
                backend.clone(),
                f.lease.clone(),
                f.fence(current()),
            ));
            let weak = Arc::downgrade(&f.lease);
            drop(f.lease);
            let mut closing = process.close();
            assert!(futures_util::poll!(&mut closing).is_pending());
            drop(closing);
            assert!(weak.upgrade().is_some());
            assert!(process.call("synthetic.tool", Value::Null).await.is_err());
            backend.close_gate.add_permits(1);
            assert_eq!(process.close().await, Err(expected.clone()));
            assert_eq!(process.close().await, Err(expected));
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
            drop(process);
            assert!(weak.upgrade().is_none());
        })
    });
    assert_eq!(report.failures, vec![OwnerFailure::Library(expected)]);
}

#[test]
fn retired_location_still_allows_successful_cleanup() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let backend = Backend::new(1, None);
            let process = Process::new(
                &context,
                backend.clone(),
                f.lease.clone(),
                f.fence(current()),
            );
            f.locations
                .evict(f.session.location.directory.as_lossless(), None)
                .unwrap();
            process.close().await.unwrap();
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn retirement_during_open_cleans_up_before_refusing_publication() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let backend = Backend::new(1, None);
            let locations = f.locations.clone();
            let info = f.lease.info.clone();
            let core = Arc::new(BackendFactory {
                process: backend.clone(),
                gate: Semaphore::new(1),
                entered: Notify::new(),
                after_open: Some(Arc::new(move || {
                    locations.evict(info.directory.as_lossless(), None).unwrap();
                })),
            });
            let factory = Factory::new(&context, core, f.lease.clone(), f.fence(current()));
            assert!(factory.open(input()).await.is_err());
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn retirement_during_call_withholds_the_result() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let locations = f.locations.clone();
            let info = f.lease.info.clone();
            let backend = Arc::new(Backend {
                closes: AtomicUsize::new(0),
                close_gate: Semaphore::new(1),
                failure: None,
                denied: false,
                values: Mutex::new(vec![]),
                close_entered: Notify::new(),
                after_close: None,
                after_call: Some(Arc::new(move || {
                    locations.evict(info.directory.as_lossless(), None).unwrap();
                })),
            });
            let process = Process::new(
                &context,
                backend.clone(),
                f.lease.clone(),
                f.fence(current()),
            );
            assert!(
                process
                    .call("synthetic.tool", Value::Bool(true))
                    .await
                    .is_err()
            );
            assert_eq!(*backend.values.lock().unwrap(), vec![Value::Bool(true)]);
            process.close().await.unwrap();
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn cancelled_unacquired_open_drains_its_eventual_process() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let weak = Arc::downgrade(&f.lease);
            let backend = Backend::new(1, None);
            let core = Arc::new(BackendFactory {
                process: backend.clone(),
                gate: Semaphore::new(0),
                after_open: None,
                entered: Notify::new(),
            });
            let factory = Factory::new(&context, core.clone(), f.lease.clone(), f.fence(current()));
            drop(f.lease);
            let mut opening = factory.open(input());
            assert!(futures_util::poll!(&mut opening).is_pending());
            assert!(weak.upgrade().is_some());
            core.entered.notified().await;
            drop(opening);
            drop(factory);
            core.gate.add_permits(1);
            backend.close_entered.notified().await;
            assert!(context.drain_library().await.failures.is_empty());
            assert!(weak.upgrade().is_none());
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn core_retirement_before_close_keeps_cleanup_successful() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let live = Arc::new(AtomicBool::new(true));
            let checks = Arc::new(AtomicUsize::new(0));
            let (active, count) = (live.clone(), checks.clone());
            let check: CurrentCheck = Arc::new(move || {
                count.fetch_add(1, Ordering::AcqRel);
                let active = active.clone();
                Box::pin(async move {
                    if active.load(Ordering::Acquire) {
                        Ok(())
                    } else {
                        Err(ExecutorError::session_closed())
                    }
                })
            });
            let backend = Backend::new(1, None);
            let process = Process::new(&context, backend.clone(), f.lease.clone(), f.fence(check));
            process.check().await.unwrap();
            live.store(false, Ordering::Release);
            assert!(process.check().await.is_err());
            assert!(process.call("synthetic.tool", Value::Null).await.is_err());
            let before = checks.load(Ordering::Acquire);
            process.close().await.unwrap();
            assert_eq!(checks.load(Ordering::Acquire), before);
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn retired_close_preserves_actual_cleanup_failure_for_all_waiters() {
    let failure = ExecutorError::new(-32123, "synthetic joined cleanup failure");
    let retained = failure.clone();
    let report = owned_fixture(move |context, f| {
        Box::pin(async move {
            let failure = retained;
            let backend = Backend::new(1, Some(failure.clone()));
            let process = Process::new(
                &context,
                backend.clone(),
                f.lease.clone(),
                f.fence(current()),
            );
            f.locations
                .evict(f.session.location.directory.as_lossless(), None)
                .unwrap();
            let (first, second) = tokio::join!(process.close(), process.close());
            assert_eq!(first, Err(failure.clone()));
            assert_eq!(second, Err(failure));
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert_eq!(report.failures, vec![OwnerFailure::Library(failure)]);
}

#[test]
fn stale_open_retains_its_refusal_and_actual_cleanup_failure() {
    let failure = ExecutorError::new(-32123, "synthetic open cleanup failure");
    let retained = failure.clone();
    let report = owned_fixture(move |context, f| {
        Box::pin(async move {
            let failure = retained;
            let backend = Backend::new(1, Some(failure.clone()));
            let locations = f.locations.clone();
            let info = f.lease.info.clone();
            let core = Arc::new(BackendFactory {
                process: backend.clone(),
                gate: Semaphore::new(1),
                entered: Notify::new(),
                after_open: Some(Arc::new(move || {
                    locations.evict(info.directory.as_lossless(), None).unwrap();
                })),
            });
            let factory = Factory::new(&context, core, f.lease.clone(), f.fence(current()));
            let error = match factory.open(input()).await {
                Ok(_) => panic!("stale process was published"),
                Err(error) => error,
            };
            assert_eq!(error, combined(unavailable(), failure));
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert_eq!(report.failures, vec![OwnerFailure::Library(failure)]);
}

#[test]
fn cancelled_open_after_backend_publication_is_driven_to_cleanup() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let entered = Arc::new(Notify::new());
            let release = Arc::new(Semaphore::new(0));
            let count = Arc::new(AtomicUsize::new(0));
            let (notice, gate, calls) = (entered.clone(), release.clone(), count.clone());
            let check: CurrentCheck = Arc::new(move || {
                let (notice, gate) = (notice.clone(), gate.clone());
                let after_open = calls.fetch_add(1, Ordering::AcqRel) == 1;
                Box::pin(async move {
                    if after_open {
                        notice.notify_one();
                        gate.acquire().await.unwrap().forget();
                    }
                    Ok(())
                })
            });
            let backend = Backend::new(0, None);
            let core = Arc::new(BackendFactory {
                process: backend.clone(),
                gate: Semaphore::new(1),
                after_open: None,
                entered: Notify::new(),
            });
            let factory = Arc::new(Factory::new(
                &context,
                core,
                f.lease.clone(),
                f.fence(check),
            ));
            let weak = Arc::downgrade(&f.lease);
            let mut opening = factory.open(input());
            tokio::select! {
                biased;
                result = &mut opening => panic!("post-open fence escaped: {}", result.is_ok()),
                _ = entered.notified() => {},
            }
            drop(opening);
            drop(factory);
            drop(f.lease);
            assert!(weak.upgrade().is_some());
            release.add_permits(1);
            backend.close_entered.notified().await;
            assert!(weak.upgrade().is_some());
            backend.close_gate.add_permits(1);
            assert!(context.drain_library().await.failures.is_empty());
            assert!(weak.upgrade().is_none());
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn final_process_token_drop_is_independently_driven() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let backend = Backend::new(0, None);
            let process = Process::new(
                &context,
                backend.clone(),
                f.lease.clone(),
                f.fence(current()),
            );
            let weak = Arc::downgrade(&f.lease);
            drop(f.lease);
            drop(process);
            backend.close_entered.notified().await;
            assert!(weak.upgrade().is_some());
            backend.close_gate.add_permits(1);
            assert!(context.drain_library().await.failures.is_empty());
            assert!(weak.upgrade().is_none());
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn completed_close_releases_lease_while_wrapper_is_alive() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let backend = Backend::new(1, None);
            let process = Process::new(
                &context,
                backend.clone(),
                f.lease.clone(),
                f.fence(current()),
            );
            let weak = Arc::downgrade(&f.lease);
            drop(f.lease);
            process.close().await.unwrap();
            assert!(weak.upgrade().is_none());
            assert!(process.check().await.is_err());
            assert!(process.tools().is_empty());
            process.close().await.unwrap();
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert!(report.failures.is_empty());
}

#[test]
fn production_cleanup_waits_for_library_join_with_wrappers_alive() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (_store, f) = Fixture::new();
    let order = Arc::new(Mutex::new(Vec::new()));
    let library_order = order.clone();
    let core_order = order.clone();
    let weak = Arc::downgrade(&f.lease);
    let ((process, core), report) = owned(&runtime, move |production| {
        Box::pin(async move {
            let context = library_context(&production).await;
            let backend = Arc::new(Backend {
                closes: AtomicUsize::new(0),
                close_gate: Semaphore::new(1),
                failure: None,
                denied: false,
                after_call: None,
                values: Mutex::new(vec![]),
                close_entered: Notify::new(),
                after_close: Some(Arc::new(move || {
                    library_order.lock().unwrap().push("library");
                })),
            });
            let process = Process::new(&context, backend, f.lease.clone(), f.fence(current()));
            drop(f.lease);
            let core = production.retain(
                production.production_retirement(),
                Box::pin(async move {
                    core_order.lock().unwrap().push("core");
                    Report::default()
                }),
            );
            (process, core)
        })
    });
    report.result().unwrap();
    assert_eq!(*order.lock().unwrap(), vec!["library", "core"]);
    assert!(weak.upgrade().is_none());
    assert!(runtime.block_on(process.check()).is_err());
    assert!(process.tools().is_empty());
    assert!(core.is_retired());
}

#[test]
fn orphan_process_cleanup_failure_reaches_owner_after_final_token_drop() {
    let failure = ExecutorError::new(-32123, "synthetic orphan cleanup failure");
    let retained = failure.clone();
    let report = owned_fixture(move |context, f| {
        Box::pin(async move {
            let backend = Backend::new(1, Some(retained.clone()));
            let process = Process::new(
                &context,
                backend.clone(),
                f.lease.clone(),
                f.fence(current()),
            );
            let weak = Arc::downgrade(&f.lease);
            drop(f.lease);
            drop(process);
            let drained = context.drain_library().await;
            assert_eq!(drained.failures, vec![OwnerFailure::Library(retained)]);
            assert!(weak.upgrade().is_none());
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert_eq!(report.failures, vec![OwnerFailure::Library(failure)]);
}

#[test]
fn cleanup_panic_returns_sanitized_join_failure_and_releases_lease() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let backend = Arc::new(Backend {
                closes: AtomicUsize::new(0),
                close_gate: Semaphore::new(1),
                failure: None,
                denied: false,
                after_call: None,
                values: Mutex::new(vec![]),
                close_entered: Notify::new(),
                after_close: Some(Arc::new(|| panic!("synthetic native cleanup panic"))),
            });
            let process = Process::new(&context, backend, f.lease.clone(), f.fence(current()));
            let weak = Arc::downgrade(&f.lease);
            drop(f.lease);
            assert_eq!(
                process.close().await,
                Err(ExecutorError::new(
                    -32603,
                    "production resource cleanup panicked"
                ))
            );
            assert!(weak.upgrade().is_none());
        })
    });
    assert_eq!(
        report.failures,
        vec![OwnerFailure::Join(
            "production resource cleanup panicked".into()
        )]
    );
}

#[test]
fn equal_stale_operation_and_cleanup_failures_preserve_both_boundaries() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let backend = Backend::new(1, Some(unavailable()));
            let locations = f.locations.clone();
            let info = f.lease.info.clone();
            let core = Arc::new(BackendFactory {
                process: backend.clone(),
                gate: Semaphore::new(1),
                entered: Notify::new(),
                after_open: Some(Arc::new(move || {
                    locations.evict(info.directory.as_lossless(), None).unwrap();
                })),
            });
            let factory = Factory::new(&context, core, f.lease.clone(), f.fence(current()));
            let error = match factory.open(input()).await {
                Ok(_) => panic!("stale process was published"),
                Err(error) => error,
            };
            assert_eq!(
                error,
                ExecutorError::new(
                    -32603,
                    "Native Library Session or Location retired; additional Library failure: Native Library Session or Location retired"
                )
            );
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert_eq!(report.failures, vec![OwnerFailure::Library(unavailable())]);
}

#[test]
fn registered_factory_orphan_settlement_joins_its_resource_close() {
    let report = owned_fixture(|context, f| {
        Box::pin(async move {
            let backend = Backend::new(1, None);
            let core = Arc::new(BackendFactory {
                process: backend,
                gate: Semaphore::new(1),
                after_open: None,
                entered: Notify::new(),
            });
            let factory = Arc::new(Factory::new(
                &context,
                core,
                f.lease.clone(),
                f.fence(current()),
            ));
            let lease = Arc::downgrade(&f.lease);
            let created = Arc::new(Notify::new());
            let output = Arc::new(Semaphore::new(0));
            let (notice, gate) = (created.clone(), output.clone());
            let (completed, completion) = tokio::sync::oneshot::channel();
            let request = context
                .handle()
                .register(
                    move |_| {
                        Box::pin(async move {
                            notice.notify_one();
                            gate.acquire().await.unwrap().forget();
                            Ok(factory)
                        })
                    },
                    move |result| {
                        Box::pin(async move {
                            let report = abandon_factory(result).await;
                            completed.send(lease.upgrade().is_none()).unwrap();
                            report
                        })
                    },
                )
                .unwrap();
            drop(f.lease);
            created.notified().await;
            drop(request);
            output.add_permits(1);
            assert!(completion.await.unwrap());
            assert_eq!(context.drain_library().await, Report::default());
        })
    });
    assert_eq!(report, Report::default());
}

#[test]
fn registered_process_orphan_settlement_joins_failure_without_rerecording() {
    let failure = ExecutorError::new(-32123, "synthetic registered orphan cleanup failure");
    let retained = failure.clone();
    let report = owned_fixture(move |context, f| {
        Box::pin(async move {
            let backend = Backend::new(0, Some(retained.clone()));
            let native = backend.clone();
            let fence = f.fence(current());
            let lease = f.lease.clone();
            let weak = Arc::downgrade(&lease);
            let released = weak.clone();
            let created = Arc::new(Notify::new());
            let output = Arc::new(Semaphore::new(0));
            let (notice, gate) = (created.clone(), output.clone());
            let (completed, completion) = tokio::sync::oneshot::channel();
            let request = context
                .handle()
                .register(
                    move |context| {
                        Box::pin(async move {
                            let process = Arc::new(Process::new(&context, native, lease, fence))
                                as Arc<dyn LibraryProcess>;
                            notice.notify_one();
                            gate.acquire().await.unwrap().forget();
                            Ok(process)
                        })
                    },
                    move |result| {
                        Box::pin(async move {
                            let report = abandon_process(result).await;
                            completed.send(released.upgrade().is_none()).unwrap();
                            report
                        })
                    },
                )
                .unwrap();
            drop(f.lease);
            created.notified().await;
            drop(request);
            output.add_permits(1);
            backend.close_entered.notified().await;
            let held = weak.upgrade().is_some();
            let mut completion = Box::pin(completion);
            let premature = match futures_util::poll!(&mut completion) {
                std::task::Poll::Ready(result) => Some(result.unwrap()),
                std::task::Poll::Pending => None,
            };
            backend.close_gate.add_permits(1);
            assert!(held);
            assert!(
                premature.is_none(),
                "orphan settlement completed before native cleanup joined"
            );
            assert!(completion.await.unwrap());
            assert_eq!(
                context.drain_library().await.failures,
                vec![OwnerFailure::Library(retained)]
            );
            assert!(weak.upgrade().is_none());
            assert_eq!(backend.closes.load(Ordering::Acquire), 1);
        })
    });
    assert_eq!(report.failures, vec![OwnerFailure::Library(failure)]);
}

#[test]
fn abandoned_native_errors_without_resources_are_not_cleanup_failures() {
    let report = owned_fixture(|_context, _f| {
        Box::pin(async move {
            let failure = ExecutorError::new(-32123, "synthetic unobserved native refusal");
            assert_eq!(
                abandon_factory(Err(failure.clone())).await,
                Report::default()
            );
            assert_eq!(abandon_process(Err(failure)).await, Report::default());
        })
    });
    assert_eq!(report, Report::default());
}
