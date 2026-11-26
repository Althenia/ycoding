use super::*;
use crate::{
    cca::error::{AuthorizationDenied, AuthorizationInput, Grant},
    dots::{
        Admission,
        access::{Access, ConfigurationStatus, Error},
        native::{
            Backend, Listener, Model, NativeFuture, Options, RemovalLease, Retirement, Skill,
        },
    },
    resources::{config, credential},
};
use std::collections::BTreeMap;
use tokio::sync::oneshot;
use ycoding_schema::{location, model, parse_json};

#[derive(Default)]
struct Pause(Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>);
impl Pause {
    fn arm(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (entered, started) = oneshot::channel();
        let (release, released) = oneshot::channel();
        *self.0.lock().unwrap() = Some((entered, released));
        (started, release)
    }
    async fn wait(&self) {
        let pause = self.0.lock().unwrap().take();
        if let Some((entered, released)) = pause {
            entered.send(()).unwrap();
            released.await.unwrap();
        }
    }
}

#[derive(Default)]
struct NativeBackend {
    listeners: Arc<Mutex<BTreeMap<usize, Listener>>>,
    next: AtomicUsize,
}
impl Backend for NativeBackend {
    fn decisions(&self, _: session::Info) -> NativeFuture<'_, Arc<crate::dots::Decisions>> {
        Box::pin(async { Err(Error::Unavailable) })
    }
    fn selected_model(&self, _: session::Info) -> NativeFuture<'_, Option<model::Ref>> {
        Box::pin(async { Ok(None) })
    }
    fn models(&self, _: location::Ref) -> NativeFuture<'_, Vec<Model>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn validate_model(&self, _: location::Ref, _: model::Ref) -> NativeFuture<'_, model::Ref> {
        Box::pin(async { Err(Error::Unavailable) })
    }
    fn switch_model(&self, _: session::Info, _: model::Ref, _: Admission) -> NativeFuture<'_, ()> {
        Box::pin(async { Err(Error::Unavailable) })
    }
    fn retire_root(&self, _: session::Id, _: Admission) -> NativeFuture<'_, Box<dyn RemovalLease>> {
        Box::pin(async { Err(Error::Unavailable) })
    }
    fn skills(&self, _: session::Info) -> NativeFuture<'_, Vec<Skill>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn active(&self, _: &session::Id) -> bool {
        false
    }
    fn prompt(&self, _: crate::session::pending::Request, _: Admission) -> NativeFuture<'_, ()> {
        Box::pin(async { Err(Error::Unavailable) })
    }
    fn interrupt(&self, _: session::Id) -> NativeFuture<'_, ()> {
        Box::pin(async { Err(Error::Unavailable) })
    }
    fn subscribe(&self, listener: Listener, _: Retirement) -> Result<Subscription, Error> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.listeners.lock().unwrap().insert(id, listener);
        let listeners = Arc::downgrade(&self.listeners);
        Ok(Subscription::new(move || {
            if let Some(listeners) = listeners.upgrade() {
                listeners.lock().unwrap().remove(&id);
            }
        }))
    }
}

struct TestAuthorization {
    current: CurrentCheck,
    held: Mutex<Vec<Arc<AtomicBool>>>,
    released: Arc<AtomicUsize>,
    closes: AtomicUsize,
    close_pause: Arc<Pause>,
}
impl Authorize for TestAuthorization {
    fn authorize(
        &self,
        _: AuthorizationInput,
    ) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>> {
        let current = self.current.clone();
        let live = Arc::new(AtomicBool::new(true));
        self.held.lock().unwrap().push(live.clone());
        let released = self.released.clone();
        Box::pin(async move {
            if current().await.is_err() {
                live.store(false, Ordering::Release);
                return Err(AuthorizationDenied::default());
            }
            Ok(Grant::new(vec![], move || {
                Box::pin(async move {
                    if live.swap(false, Ordering::AcqRel) {
                        released.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(())
                })
            }))
        })
    }
    fn close(&self) -> BoxFuture<'static, Result<(), ExecutorError>> {
        self.closes.fetch_add(1, Ordering::Relaxed);
        for live in self.held.lock().unwrap().iter() {
            if live.swap(false, Ordering::AcqRel) {
                self.released.fetch_add(1, Ordering::Relaxed);
            }
        }
        let pause = self.close_pause.clone();
        Box::pin(async move {
            pause.wait().await;
            Ok(())
        })
    }
}

#[derive(Default)]
struct Services {
    checks: Mutex<Vec<CurrentCheck>>,
    authorizations: Mutex<Vec<std::sync::Weak<TestAuthorization>>>,
    authorization_pause: Pause,
    fail: AtomicBool,
}
impl ScopeServices for Services {
    fn open_directory(
        &self,
        directory: &str,
    ) -> BoxFuture<'_, Result<OpenedDirectory, ExecutorError>> {
        let directory = directory.to_owned();
        Box::pin(async move {
            Ok(OpenedDirectory {
                directory,
                project_id: "project".into(),
            })
        })
    }
    fn project_root(&self, _: &str) -> Option<String> {
        None
    }
    fn projects(&self) -> BoxFuture<'_, Result<Vec<CatalogProject>, ExecutorError>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn rename_session(
        &self,
        _: &session::Id,
        _: &LosslessString,
    ) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn authorization(
        &self,
        _: &session::Info,
        current: CurrentCheck,
    ) -> BoxFuture<'_, Result<Arc<dyn Authorize>, ExecutorError>> {
        self.checks.lock().unwrap().push(current.clone());
        Box::pin(async move {
            current().await?;
            self.authorization_pause.wait().await;
            if self.fail.load(Ordering::Acquire) {
                return Err(scope_unavailable());
            }
            let authorization = Arc::new(TestAuthorization {
                current,
                held: Mutex::new(vec![]),
                released: Arc::new(AtomicUsize::new(0)),
                closes: AtomicUsize::new(0),
                close_pause: Arc::new(Pause::default()),
            });
            self.authorizations
                .lock()
                .unwrap()
                .push(Arc::downgrade(&authorization));
            Ok(authorization as Arc<dyn Authorize>)
        })
    }
}

#[derive(Default)]
struct Process {
    check_pause: Pause,
    call_pause: Pause,
    close_pause: Pause,
    checks: AtomicUsize,
    calls: AtomicUsize,
    closes: AtomicUsize,
    fail_close: AtomicBool,
}
impl LibraryProcess for Process {
    fn check(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async move {
            self.checks.fetch_add(1, Ordering::Relaxed);
            self.check_pause.wait().await;
            Ok(())
        })
    }
    fn tools(&self) -> Vec<LibraryTool> {
        vec![]
    }
    fn call(&self, _: &str, _: Value) -> BoxFuture<'_, Result<Value, LibraryCallError>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.call_pause.wait().await;
            Ok(Value::String("synthetic-result".into()))
        })
    }
    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async move {
            self.closes.fetch_add(1, Ordering::Relaxed);
            self.close_pause.wait().await;
            if self.fail_close.load(Ordering::Acquire) {
                Err(scope_unavailable())
            } else {
                Ok(())
            }
        })
    }
}

#[derive(Default)]
struct Library {
    scopes: Mutex<Vec<LibraryScope>>,
    sessions: Mutex<Vec<session::Info>>,
    factory_pause: Pause,
    open_pause: Pause,
    fail_factory: AtomicBool,
    fail_open: AtomicBool,
    opens: Arc<AtomicUsize>,
    backend: Arc<Process>,
}
impl LibraryProvider for Library {
    fn factory(
        &self,
        scope: LibraryScope,
        session: &session::Info,
    ) -> BoxFuture<'_, Result<Arc<dyn LibraryFactory>, ExecutorError>> {
        self.scopes.lock().unwrap().push(scope);
        self.sessions.lock().unwrap().push(session.clone());
        Box::pin(async move {
            self.factory_pause.wait().await;
            if self.fail_factory.load(Ordering::Acquire) {
                return Err(scope_unavailable());
            }
            Ok(Arc::new(TestFactory {
                backend: self.backend.clone(),
                pause: Pause(Mutex::new(self.open_pause.0.lock().unwrap().take())),
                opens: self.opens.clone(),
                fail: self.fail_open.load(Ordering::Acquire),
            }) as Arc<dyn LibraryFactory>)
        })
    }
}
struct TestFactory {
    backend: Arc<Process>,
    pause: Pause,
    opens: Arc<AtomicUsize>,
    fail: bool,
}
impl LibraryFactory for TestFactory {
    fn open(
        &self,
        _: LibraryOpenInput,
    ) -> BoxFuture<'_, Result<Arc<dyn LibraryProcess>, ExecutorError>> {
        Box::pin(async move {
            self.opens.fetch_add(1, Ordering::Relaxed);
            self.pause.wait().await;
            if self.fail {
                return Err(scope_unavailable());
            }
            Ok(self.backend.clone() as Arc<dyn LibraryProcess>)
        })
    }
}

struct Fixture {
    store: ycoding_store::Store,
    directory: PathBuf,
    profile_file: PathBuf,
    host: Host,
    access: Access,
    backend: Arc<NativeBackend>,
    services: Arc<Services>,
    library: Arc<Library>,
    scopes: ExecutorScopes,
    root: session::Id,
    key: LosslessString,
}
impl Fixture {
    async fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "ycoding-entry-fixture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        let roots =
            config::Roots::runtime(&directory, &directory.join("tmp"), &BTreeMap::new()).unwrap();
        std::fs::create_dir_all(&roots.config).unwrap();
        let profile_file = roots.config.join("ycoding.json");
        std::fs::write(
            &profile_file,
            r#"{"dots":{"enabled":true,"profile":"selected"}}"#,
        )
        .unwrap();
        let global = Arc::new(
            config::Configuration::load(config::LoadOptions {
                directory: directory.clone(),
                roots,
                project: false,
                file: None,
                content: None,
                env: BTreeMap::new(),
            })
            .unwrap(),
        );
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::native::catalog(ycoding_store::native::DatabaseKind::Core),
            ycoding_store::Metadata::new([19; 16], 1),
        )
        .unwrap();
        store.submit(|tx| {
            tx.put::<ycoding_store::project::ProjectTable>(&ycoding_store::project::Project {
                id: "project".into(), worktree: "/workspace/project".into(), vcs: None, name: None,
                icon_url: None, icon_url_override: None, icon_color: None, time_created: 1,
                time_updated: 1, time_initialized: None, sandboxes: vec![], commands: None,
            })?;
            tx.put::<ycoding_store::session::SessionTable>(&ycoding_store::session::Session {
                id: "ses_entry".into(), project_id: "project".into(), workspace_id: None, parent_id: None,
                fork_session_id: None, fork_message_id: None, fork_seq: None,
                directory: "/workspace/project".into(), path: None, title: "authority".into(),
                cost: 0.0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0,
                tokens_cache_read: 0, tokens_cache_write: 0, revert: None, permission: None,
                autonomy: Some(parse_json(r#"{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","goal":{"text":"Synthetic goal","iteration":0,"noProgress":0,"maxNoProgress":3,"status":"completed"}}"#).unwrap()),
                autonomy_revision: 0, orchestration_revision: 0, agent: Some("test".into()),
                model: None, profile_binding: None, daybreak: None, time_created: 1,
                time_updated: 1, time_archived: None, time_active: None, time_pinned: None,
                time_suspended: None, usage_pruned_through: None, origin: None, scope: "bound".into(),
            })?;
            Ok(())
        }).unwrap().wait().unwrap();
        let root = session::Id::new("ses_entry").unwrap();
        let credentials = credential::Service::new(store.client());
        credentials.create("credential_selected".into(), "openai".into(), Some("selected".into()), ycoding_store::resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-access","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{"accountID":"synthetic-account"}}"#).unwrap()).unwrap(), 1).await.unwrap();
        let access = Access::new(
            store.client(),
            Arc::new(|| {
                Ok(ConfigurationStatus {
                    ready: true,
                    profile: Some("selected".into()),
                    message: None,
                })
            }),
        );
        access.set(true, 0).await.unwrap();
        let backend = Arc::new(NativeBackend::default());
        let host = Host::new(Options {
            access: access.clone(),
            global,
            credentials,
            sessions: crate::session::store::Service::new(store.client()),
            client: store.client(),
            backend: backend.clone(),
            credential: Arc::new(|_, _| Box::pin(async { Err(Error::Unavailable) })),
        })
        .unwrap();
        let services = Arc::new(Services::default());
        let library = Arc::new(Library::default());
        let scopes = ExecutorScopes::new(
            host.clone(),
            services.clone(),
            Some(library.clone()),
            "synthetic-environment".into(),
            "/synthetic-home".into(),
            directory.join("data"),
        )
        .unwrap();
        let key = LosslessString::from_utf16(vec![100, 111, 116, 115, 0xd800]);
        let mapped_key = key.clone();
        let mapped_root = root.clone();
        store
            .submit(move |tx| {
                resources::set_kv(
                    tx,
                    &mapped_key,
                    &Document::from_domain(
                        &ycoding_schema::domain::Json::new(
                            ObjectEncoder::new()
                                .field("sessionID", &mapped_root)
                                .finish(),
                        )
                        .unwrap(),
                    )?,
                    1,
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        Self {
            store,
            directory,
            profile_file,
            host,
            access,
            backend,
            services,
            library,
            scopes,
            root,
            key,
        }
    }
    async fn scope(&self) -> Arc<dyn ExecutorScope> {
        self.scopes
            .scope(self.key.clone(), Kind::Thread, None)
            .await
            .unwrap()
    }
    fn entry(&self) -> Arc<Entry> {
        self.scopes
            .0
            .entries
            .lock()
            .unwrap()
            .get(&self.key)
            .unwrap()
            .clone()
    }
    fn check(&self) -> CurrentCheck {
        self.services.checks.lock().unwrap().last().unwrap().clone()
    }
    fn authorization(&self) -> Arc<TestAuthorization> {
        self.services
            .authorizations
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .upgrade()
            .unwrap()
    }
    fn change(&self, apply: impl FnOnce(&mut ycoding_store::session::Session) + Send + 'static) {
        let root = self.root.clone();
        self.store
            .submit(move |tx| {
                let mut row = tx
                    .get::<ycoding_store::session::SessionTable>(&crate::session::key(
                        root.as_lossless(),
                    ))?
                    .unwrap();
                apply(&mut row);
                tx.put::<ycoding_store::session::SessionTable>(&row)
            })
            .unwrap()
            .wait()
            .unwrap();
    }
    fn emit(&self, type_: &str) {
        let item = crate::event_feed::Item {
            position: 1,
            payload: crate::event_feed::Payload::Durable(ycoding_store::session::Event {
                id: "evt_entry".into(),
                aggregate_id: self.root.as_lossless().clone(),
                seq: 1,
                created: 1,
                type_: type_.into(),
                data: parse_json("{}").unwrap(),
            }),
        };
        let listeners = self
            .backend
            .listeners
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for listener in listeners {
            listener(&item);
        }
    }
    async fn rotate_access(&self) {
        let revision = self.access.get().unwrap().revision;
        self.access.set(false, revision).await.unwrap();
        self.access.set(true, revision + 1).await.unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.host.close();
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}
fn input() -> LibraryOpenInput {
    LibraryOpenInput {
        process_id: "synthetic-process".into(),
        cwd: "/workspace/project".into(),
        read_file: Arc::new(|_| Box::pin(async { Err(scope_unavailable()) })),
    }
}

#[tokio::test]
async fn authorization_current_survives_publication_and_closes_grants_once() {
    let fixture = Fixture::new().await;
    let handle = fixture.scope().await;
    fixture.check()().await.unwrap();
    let authorization = fixture.authorization();
    let grant = handle
        .authorization()
        .authorize(AuthorizationInput::new(
            "read",
            vec!["/workspace/project/synthetic".into()],
        ))
        .await
        .unwrap();
    assert_eq!(fixture.entry().key, fixture.key);
    handle.close().await.unwrap();
    handle.close().await.unwrap();
    grant.release().await.unwrap();
    assert_eq!(authorization.closes.load(Ordering::Relaxed), 1);
    assert_eq!(authorization.released.load(Ordering::Relaxed), 1);
    assert!(fixture.check()().await.is_err());
    assert_eq!(fixture.backend.listeners.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn library_uses_published_entry_session_principal_and_roots() {
    let fixture = Fixture::new().await;
    let handle = fixture.scope().await;
    let factory = handle.library().unwrap();
    let process = factory.open(input()).await.unwrap();
    process.check().await.unwrap();
    assert_eq!(
        process.call("synthetic", Value::Null).await.unwrap(),
        Value::String("synthetic-result".into())
    );
    let check = {
        let scopes = fixture.library.scopes.lock().unwrap();
        let scope = scopes.last().unwrap();
        assert_eq!(scope.session_id, fixture.root);
        assert_eq!(scope.roots, vec!["/workspace/project", "/synthetic-home"]);
        assert_eq!(scope.principal.profile, "selected");
        assert_eq!(scope.principal.credential_id, "credential_selected");
        assert_eq!(scope.principal.account_id, "synthetic-account");
        assert_eq!(scope.principal.account_generation, 0);
        assert_eq!(scope.principal.access_revision, 1);
        scope.current.clone()
    };
    check().await.unwrap();
    assert_eq!(fixture.library.sessions.lock().unwrap()[0].id, fixture.root);
    handle.close().await.unwrap();
    assert!(check().await.is_err());
    assert!(factory.open(input()).await.is_err());
    assert!(process.check().await.is_err());
    assert_eq!(fixture.library.backend.closes.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn library_rechecks_after_factory_and_does_not_open_a_retired_backend() {
    let fixture = Fixture::new().await;
    let handle = fixture.scope().await;
    let factory = handle.library().unwrap();
    let (started, release) = fixture.library.factory_pause.arm();
    let opening = factory.open(input());
    tokio::pin!(opening);
    tokio::select! { _ = started => {}, result = &mut opening => panic!("factory did not wait: {}", result.is_ok()) }
    fixture.rotate_access().await;
    release.send(()).unwrap();
    assert!(opening.await.is_err());
    assert_eq!(fixture.library.opens.load(Ordering::Relaxed), 0);
    assert!(fixture.check()().await.is_err());
    handle.close().await.unwrap();
}

#[tokio::test]
async fn library_rechecks_after_open_and_closes_the_retired_process() {
    let fixture = Fixture::new().await;
    let handle = fixture.scope().await;
    let factory = handle.library().unwrap();
    let (started, release) = fixture.library.open_pause.arm();
    let opening = factory.open(input());
    tokio::pin!(opening);
    tokio::select! { _ = started => {}, result = &mut opening => panic!("open did not wait: {}", result.is_ok()) }
    let closing = handle.close();
    tokio::pin!(closing);
    tokio::select! { biased; _ = &mut closing => panic!("close did not retain the opening owner"), _ = std::future::ready(()) => {} }
    assert!(fixture.check()().await.is_err());
    release.send(()).unwrap();
    let (opened, closed) = tokio::join!(opening, closing);
    assert!(opened.is_err());
    closed.unwrap();
    assert_eq!(fixture.library.backend.closes.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn library_rechecks_after_backend_check_and_call() {
    for during_call in [false, true] {
        let fixture = Fixture::new().await;
        let handle = fixture.scope().await;
        let process = handle.library().unwrap().open(input()).await.unwrap();
        let (started, release) = if during_call {
            fixture.library.backend.call_pause.arm()
        } else {
            fixture.library.backend.check_pause.arm()
        };
        let call = process.call("synthetic", Value::Null);
        tokio::pin!(call);
        tokio::select! { _ = started => {}, result = &mut call => panic!("backend did not wait: {}", result.is_ok()) }
        fixture.change(|row| row.time_archived = Some(2));
        release.send(()).unwrap();
        assert!(call.await.is_err());
        assert_eq!(
            fixture.library.backend.calls.load(Ordering::Relaxed),
            usize::from(during_call)
        );
        handle.close().await.unwrap();
    }
}

#[tokio::test]
async fn access_configuration_profile_account_and_generation_rotation_retire_currentness() {
    for rotation in 0..5 {
        let fixture = Fixture::new().await;
        let handle = fixture.scope().await;
        handle.ensure_current().await.unwrap();
        match rotation {
            0 => fixture.rotate_access().await,
            1 => std::fs::write(
                &fixture.profile_file,
                r#"{"dots":{"enabled":false,"profile":"selected"}}"#,
            )
            .unwrap(),
            2 => std::fs::write(
                &fixture.profile_file,
                r#"{"dots":{"enabled":true,"profile":"rotated"}}"#,
            )
            .unwrap(),
            _ => {
                fixture.store.submit(move |tx| {
                    let mut row = tx.get::<ycoding_store::resources::CredentialTable>(&crate::session::key(&"credential_selected".into()))?.unwrap();
                    if rotation == 3 {
                        row.value = ycoding_store::resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-access","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{"accountID":"rotated-account"}}"#).unwrap()).unwrap();
                    } else { row.account_generation += 1; }
                    tx.put::<ycoding_store::resources::CredentialTable>(&row)
                }).unwrap().wait().unwrap();
            }
        }
        assert!(handle.ensure_current().await.is_err());
        assert!(fixture.check()().await.is_err());
        assert!(handle.library().unwrap().open(input()).await.is_err());
        assert!(fixture.library.scopes.lock().unwrap().is_empty());
        assert!(handle.library_signal().unwrap().is_cancelled());
        handle.close().await.unwrap();
    }
}

#[tokio::test]
async fn session_location_workspace_project_archive_parent_and_replacement_reject() {
    for change in 0..6 {
        let fixture = Fixture::new().await;
        let handle = fixture.scope().await;
        fixture.change(move |row| match change {
            0 => row.directory = "/workspace/moved".into(),
            1 => row.workspace_id = Some("workspace_replaced".into()),
            2 => row.project_id = "project_replaced".into(),
            3 => row.time_archived = Some(2),
            4 => row.parent_id = Some("ses_parent".into()),
            _ => row.time_created = 99,
        });
        assert!(fixture.check()().await.is_err());
        assert!(handle.library().unwrap().open(input()).await.is_err());
        assert!(fixture.library.scopes.lock().unwrap().is_empty());
        assert!(handle.library_signal().unwrap().is_cancelled());
        handle.close().await.unwrap();
    }
}

#[tokio::test]
async fn move_and_archive_events_do_not_revive_old_authority_after_restoration() {
    for event in ["session.moved.1", "session.archived.2", "session.deleted.2"] {
        let fixture = Fixture::new().await;
        let handle = fixture.scope().await;
        let original = fixture
            .store
            .snapshot()
            .unwrap()
            .get::<ycoding_store::session::SessionTable>(&crate::session::key(
                fixture.root.as_lossless(),
            ))
            .unwrap()
            .unwrap();
        match event {
            "session.moved.1" => fixture.change(|row| row.directory = "/workspace/moved".into()),
            "session.archived.2" => fixture.change(|row| row.time_archived = Some(2)),
            _ => {
                let root = fixture.root.clone();
                fixture
                    .store
                    .submit(move |tx| {
                        tx.delete::<ycoding_store::session::SessionTable>(&crate::session::key(
                            root.as_lossless(),
                        ))
                        .map(|_| ())
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
            }
        }
        fixture.emit(event);
        fixture
            .store
            .submit(move |tx| tx.put::<ycoding_store::session::SessionTable>(&original))
            .unwrap()
            .wait()
            .unwrap();
        assert!(fixture.check()().await.is_err());
        assert!(handle.library_signal().unwrap().is_cancelled());
        handle.close().await.unwrap();
    }
}

#[tokio::test]
async fn shared_handles_keep_authority_until_last_release_without_reviving_old_entries() {
    let fixture = Fixture::new().await;
    let first = fixture.scope().await;
    let second = fixture.scope().await;
    let old = fixture.entry();
    let current = fixture.check();
    first.close().await.unwrap();
    current().await.unwrap();
    assert_eq!(fixture.authorization().closes.load(Ordering::Relaxed), 0);
    second.close().await.unwrap();
    assert!(current().await.is_err());
    let replacement = fixture.scope().await;
    assert!(!Arc::ptr_eq(&old, &fixture.entry()));
    assert!(current().await.is_err());
    fixture.check()().await.unwrap();
    replacement.close().await.unwrap();
}

#[tokio::test]
async fn failed_authorization_and_cancelled_construction_publish_nothing() {
    for cancelled in [false, true] {
        let fixture = Fixture::new().await;
        if cancelled {
            let (started, release) = fixture.services.authorization_pause.arm();
            {
                let constructing = fixture
                    .scopes
                    .scope(fixture.key.clone(), Kind::Thread, None);
                tokio::pin!(constructing);
                tokio::select! { _ = started => {}, result = &mut constructing => panic!("construction did not wait: {}", result.is_ok()) }
            }
            drop(release);
        } else {
            fixture.services.fail.store(true, Ordering::Release);
            assert!(
                fixture
                    .scopes
                    .scope(fixture.key.clone(), Kind::Thread, None)
                    .await
                    .is_err()
            );
        }
        assert!(fixture.scopes.0.entries.lock().unwrap().is_empty());
        assert!(fixture.check()().await.is_err());
        assert_eq!(fixture.backend.listeners.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn rotation_during_authorization_closes_unpublished_owner() {
    let fixture = Fixture::new().await;
    let (started, release) = fixture.services.authorization_pause.arm();
    let constructing = fixture
        .scopes
        .scope(fixture.key.clone(), Kind::Thread, None);
    tokio::pin!(constructing);
    tokio::select! { _ = started => {}, result = &mut constructing => panic!("construction did not wait: {}", result.is_ok()) }
    fixture.rotate_access().await;
    release.send(()).unwrap();
    assert!(constructing.await.is_err());
    assert!(fixture.scopes.0.entries.lock().unwrap().is_empty());
    assert!(fixture.check()().await.is_err());
    assert!(
        fixture.services.authorizations.lock().unwrap()[0]
            .upgrade()
            .is_none()
    );
}

#[tokio::test]
async fn failed_library_factory_and_open_publish_no_process_owner() {
    for fail_factory in [false, true] {
        let fixture = Fixture::new().await;
        let handle = fixture.scope().await;
        fixture
            .library
            .fail_factory
            .store(fail_factory, Ordering::Release);
        fixture
            .library
            .fail_open
            .store(!fail_factory, Ordering::Release);
        assert!(handle.library().unwrap().open(input()).await.is_err());
        assert!(fixture.entry().library_processes.lock().unwrap().is_empty());
        assert_eq!(fixture.library.backend.closes.load(Ordering::Relaxed), 0);
        fixture.check()().await.unwrap();
        handle.close().await.unwrap();
    }
}

#[tokio::test]
async fn closing_process_rejects_work_before_backend_close_settles() {
    let fixture = Fixture::new().await;
    let handle = fixture.scope().await;
    let process = handle.library().unwrap().open(input()).await.unwrap();
    let (started, release) = fixture.library.backend.close_pause.arm();
    let closing = process.close();
    tokio::pin!(closing);
    tokio::select! { _ = started => {}, _ = &mut closing => panic!("close did not wait") }
    assert!(process.check().await.is_err());
    assert!(process.call("synthetic", Value::Null).await.is_err());
    release.send(()).unwrap();
    closing.await.unwrap();
    handle.close().await.unwrap();
    assert_eq!(fixture.library.backend.closes.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn cancelled_last_close_resumes_backend_and_authorization_cleanup_once() {
    for during_authorization in [false, true] {
        let fixture = Fixture::new().await;
        let handle = fixture.scope().await;
        let process = handle.library().unwrap().open(input()).await.unwrap();
        let authorization = fixture.authorization();
        let (started, release) = if during_authorization {
            authorization.close_pause.arm()
        } else {
            fixture.library.backend.close_pause.arm()
        };
        {
            let closing = handle.close();
            tokio::pin!(closing);
            tokio::select! { _ = started => {}, _ = &mut closing => panic!("close did not wait") }
        }
        release.send(()).unwrap();
        assert!(fixture.check()().await.is_err());
        assert!(process.check().await.is_err());
        handle.close().await.unwrap();
        assert_eq!(fixture.library.backend.closes.load(Ordering::Relaxed), 1);
        assert_eq!(authorization.closes.load(Ordering::Relaxed), 1);
    }
}

#[tokio::test]
async fn library_cleanup_failure_is_reported_by_process_and_scope_close() {
    let fixture = Fixture::new().await;
    let handle = fixture.scope().await;
    let process = handle.library().unwrap().open(input()).await.unwrap();
    fixture
        .library
        .backend
        .fail_close
        .store(true, Ordering::Release);
    assert!(process.close().await.is_err());
    assert!(handle.close().await.is_err());
    assert!(handle.close().await.is_err());
    assert_eq!(fixture.library.backend.closes.load(Ordering::Relaxed), 1);
    assert_eq!(fixture.authorization().closes.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn callbacks_and_library_do_not_retain_entry_or_scope_cycles() {
    let fixture = Fixture::new().await;
    let handle = fixture.scope().await;
    let entry = fixture.entry();
    let weak_entry = Arc::downgrade(&entry);
    let weak_scopes = Arc::downgrade(&fixture.scopes.0);
    let current = fixture.check();
    let library = handle.library().unwrap();
    let authorization = handle.authorization();
    let transcript = handle.transcript().unwrap();
    let process = library.open(input()).await.unwrap();
    handle.close().await.unwrap();
    drop(entry);
    drop(handle);
    assert!(weak_entry.upgrade().is_none());
    drop(fixture);
    assert!(weak_scopes.upgrade().is_none());
    assert!(current().await.is_err());
    assert!(library.open(input()).await.is_err());
    assert!(
        authorization
            .authorize(AuthorizationInput::new("read", vec![]))
            .await
            .is_err()
    );
    assert!(process.check().await.is_err());
    drop(transcript);
}

#[tokio::test]
async fn dropping_scope_owner_retires_callbacks_without_reference_cycles() {
    let fixture = Fixture::new().await;
    let handle = fixture.scope().await;
    let entry = fixture.entry();
    let weak_entry = Arc::downgrade(&entry);
    let weak_scopes = Arc::downgrade(&fixture.scopes.0);
    let current = fixture.check();
    let signal = handle.library_signal().unwrap();
    drop(entry);
    drop(handle);
    drop(fixture);
    assert!(weak_scopes.upgrade().is_none());
    assert!(weak_entry.upgrade().is_none());
    assert!(signal.is_cancelled());
    assert!(current().await.is_err());
}
