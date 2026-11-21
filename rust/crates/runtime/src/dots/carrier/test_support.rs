use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::{
    dots::{Admission, DecisionServices, Decisions, access, native},
    process::guardrails::{Guardrails, Limits, Paths, Settings},
    resources::{config, credential},
    session::{orchestration, pending, review, run_coordinator, store::Service},
    tools::policy::{forms::Forms, questions::Questions},
    ycoding_schema::{self, location, model, parse_json, session},
    ycoding_store,
};

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../core/tests/policy_fixture.rs"
));

struct Execution;
impl orchestration::Execution for Execution {
    fn wake(&self, _: &session::Id) -> run_coordinator::Outcome {
        Ok(())
    }
    fn resume(&self, _: &session::Id) -> run_coordinator::RunFuture {
        Box::pin(async { Ok(()) })
    }
    fn interrupt(&self, _: &session::Id) -> run_coordinator::RunFuture {
        Box::pin(async { Ok(()) })
    }
}
impl review::Delivery for Execution {
    fn wake(&self, _: &session::Id) {}
    fn answer_child<'a>(&'a self, _: review::ChildAnswer) -> review::DeliveryFuture<'a> {
        Box::pin(async { Err(review::DeliveryError::Conflict("outside fixture".into())) })
    }
    fn resolve_recovery<'a>(&'a self, _: review::RecoveryResolution) -> review::DeliveryFuture<'a> {
        Box::pin(async { Err(review::DeliveryError::Conflict("outside fixture".into())) })
    }
}

struct Backend {
    sessions: Service,
    client: ycoding_store::Client,
    decisions: Arc<Decisions>,
    subscriptions: Arc<AtomicUsize>,
}
struct Removal(Vec<session::Id>);
impl native::RemovalLease for Removal {
    fn members(&self) -> &[session::Id] {
        &self.0
    }
    fn is_current(&self) -> bool {
        true
    }
}

impl native::Backend for Backend {
    fn decisions(&self, _: session::Info) -> native::NativeFuture<'_, Arc<Decisions>> {
        let decisions = self.decisions.clone();
        Box::pin(async move { Ok(decisions) })
    }
    fn selected_model(
        &self,
        session: session::Info,
    ) -> native::NativeFuture<'_, Option<model::Ref>> {
        Box::pin(async move { Ok(session.model) })
    }
    fn models(&self, _: location::Ref) -> native::NativeFuture<'_, Vec<native::Model>> {
        Box::pin(async {
            Ok(vec![native::Model {
                id: "model-fixture".into(),
                provider_id: "provider-fixture".into(),
                name: None,
                profile: None,
                active: None,
                variants: Some(Vec::new()),
                is_default: None,
            }])
        })
    }
    fn validate_model(
        &self,
        location: location::Ref,
        model: model::Ref,
    ) -> native::NativeFuture<'_, model::Ref> {
        Box::pin(async move {
            if self.models(location).await?.iter().any(|candidate| {
                model.id.as_str() == Some(candidate.id.as_str())
                    && model.provider_id.0.as_str() == Some(candidate.provider_id.as_str())
                    && model.profile.is_none()
                    && model.variant.is_none()
            }) {
                Ok(model)
            } else {
                Err(access::Error::Unavailable)
            }
        })
    }
    fn switch_model(
        &self,
        session: session::Info,
        model: model::Ref,
        admission: Admission,
    ) -> native::NativeFuture<'_, ()> {
        Box::pin(async move {
            let model = self.validate_model(session.location, model).await?;
            self.client
                .submit(move |tx| {
                    admission.validate_in(tx, Some(&session.id))?;
                    let key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
                        session.id.as_lossless(),
                    )]);
                    let mut row = tx
                        .get::<ycoding_store::session::SessionTable>(&key)?
                        .ok_or(ycoding_store::Error::Rejected(
                            "fixture session unavailable",
                        ))?;
                    row.model = Some(ycoding_store::session::Document::from_domain(&model)?);
                    tx.put::<ycoding_store::session::SessionTable>(&row)
                })
                .map_err(|_| access::Error::Unavailable)?
                .await
                .map_err(|_| access::Error::Unavailable)
        })
    }
    fn retire_root(
        &self,
        root: session::Id,
        admission: Admission,
    ) -> native::NativeFuture<'_, Box<dyn native::RemovalLease>> {
        Box::pin(async move {
            admission
                .validate(&self.sessions, Some(&root))
                .map_err(|_| access::Error::Unavailable)?;
            let members = crate::handlers::removal_family(&self.client, &root)
                .map_err(|_| access::Error::Unavailable)?;
            Ok(Box::new(Removal(members)) as Box<dyn native::RemovalLease>)
        })
    }
    fn skills(&self, _: session::Info) -> native::NativeFuture<'_, Vec<native::Skill>> {
        Box::pin(async {
            Ok(vec![native::Skill {
                id: "skill-fixture".into(),
                name: None,
            }])
        })
    }
    fn active(&self, _: &session::Id) -> bool {
        false
    }
    fn prompt(
        &self,
        request: pending::Request,
        admission: Admission,
    ) -> native::NativeFuture<'_, ()> {
        Box::pin(async move {
            admission
                .admit_input(&self.sessions, request)
                .await
                .map_err(|_| access::Error::Unavailable)?;
            Ok(())
        })
    }
    fn interrupt(&self, _: session::Id) -> native::NativeFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn subscribe(
        &self,
        _: native::Listener,
        _: native::Retirement,
    ) -> Result<native::Subscription, access::Error> {
        let count = self.subscriptions.clone();
        count.fetch_add(1, Ordering::SeqCst);
        Ok(native::Subscription::new(move || {
            count.fetch_sub(1, Ordering::SeqCst);
        }))
    }
}

pub(super) struct HostFixture {
    pub host: native::Host,
    pub access: access::Access,
    pub root: session::Id,
    subscriptions: Arc<AtomicUsize>,
    directory: PathBuf,
    _fixture: Fixture,
}
impl HostFixture {
    pub async fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "ycoding-dots-carrier-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        let roots = config::Roots::runtime(
            &directory,
            &directory.join("tmp"),
            &BTreeMap::from([(
                "YCODING_CONFIG_DIR".into(),
                directory.join("global").to_str().unwrap().into(),
            )]),
        )
        .unwrap();
        std::fs::create_dir_all(&roots.config).unwrap();
        std::fs::write(
            roots.config.join("ycoding.json"),
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
        let fixture = Fixture::default();
        let root = fixture.session("ses_carrier_root", None, 0, false, None);
        fixture.session(
            "ses_carrier_child",
            Some("ses_carrier_root"),
            0,
            false,
            None,
        );
        let credentials = credential::Service::new(fixture.store.client());
        credentials.create("credential_selected".into(), "openai".into(), Some("selected".into()), ycoding_store::resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-access","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{"accountID":"synthetic-account"}}"#).unwrap()).unwrap(), 1).await.unwrap();
        let access = access::Access::new(
            fixture.store.client(),
            Arc::new(|| {
                Ok(access::ConfigurationStatus {
                    ready: true,
                    profile: Some("selected".into()),
                    message: None,
                })
            }),
        );
        access.set(true, 0).await.unwrap();
        let sessions = Service::new(fixture.store.client());
        let forms = Forms::new(fixture.authority(), fixture.publisher());
        let permissions = fixture.permissions();
        let guardrails = Guardrails::new(
            fixture.authority(),
            permissions.clone(),
            Settings {
                paths: Paths {
                    workdir: "/workspace/project".into(),
                    project: "/workspace/project".into(),
                    home: "/synthetic-home".into(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom: Arc::new(Vec::new),
                enabled: true,
                limits: Limits::default(),
                decide_reviews: false,
                decide_hard_reviews: false,
            },
            fixture.publisher(),
        );
        let decisions = Arc::new(Decisions::new(DecisionServices {
            forms: forms.clone(),
            permissions,
            questions: Questions::new(fixture.authority(), fixture.publisher()),
            guardrails,
            reviews: review::Service::new(sessions.clone(), Arc::new(Execution)),
            orchestration: orchestration::Service::new(sessions.clone(), Arc::new(Execution)),
            lease: Arc::new(()),
            is_current: Arc::new(|| true),
        }));
        let resolver_credentials = credentials.clone();
        let subscriptions = Arc::new(AtomicUsize::new(0));
        let host = native::Host::new(native::Options {
            access: access.clone(),
            global,
            credentials: credentials.clone(),
            sessions: sessions.clone(),
            client: fixture.store.client(),
            backend: Arc::new(Backend {
                sessions,
                client: fixture.store.client(),
                decisions,
                subscriptions: subscriptions.clone(),
            }),
            credential: Arc::new(move |profile, _| {
                let credentials = resolver_credentials.clone();
                Box::pin(async move {
                    let binding = credentials
                        .bind("openai".into(), "openai".into(), profile.as_str().into())
                        .map_err(|_| access::Error::Unavailable)?;
                    let selected = credentials
                        .resolve_binding(&binding)
                        .map_err(|_| access::Error::Unavailable)?;
                    let ycoding_schema::credential::Value::OAuth(value) = selected
                        .secret()
                        .domain()
                        .map_err(|_| access::Error::Unavailable)?
                    else {
                        return Err(access::Error::Unavailable);
                    };
                    let account_id = value
                        .metadata
                        .as_ref()
                        .and_then(|metadata| metadata.get(&"accountID".into()))
                        .and_then(|value| {
                            if let ycoding_schema::JsonValue::String(value) = value {
                                value.as_str()
                            } else {
                                None
                            }
                        })
                        .ok_or(access::Error::Unavailable)?
                        .to_owned();
                    Ok(Some(native::ResolvedCredential {
                        profile,
                        credential_id: "credential_selected".into(),
                        account_id,
                        account_generation: selected.account_generation(),
                        access_token: value
                            .access
                            .to_utf8()
                            .map_err(|_| access::Error::Unavailable)?,
                    }))
                })
            }),
        })
        .unwrap();
        Self {
            host,
            access,
            root,
            subscriptions,
            directory,
            _fixture: fixture,
        }
    }
    pub fn state_path(&self) -> PathBuf {
        self.directory.join("carrier-state.json")
    }
    pub fn subscriptions(&self) -> usize {
        self.subscriptions.load(Ordering::SeqCst)
    }
    pub fn admission_counts(&self) -> (usize, usize) {
        let pending = Service::new(self._fixture.store.client())
            .pending_list(&self.root)
            .unwrap()
            .len();
        let events = self
            ._fixture
            .store
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::session::EventTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                100,
            )
            .unwrap();
        let admitted = events
            .iter()
            .filter(|event| {
                event.type_.as_str() == Some("session.input.admitted.1")
                    && event.aggregate_id.as_str() == self.root.as_lossless().as_str()
            })
            .count();
        (pending, admitted)
    }
}
impl Drop for HostFixture {
    fn drop(&mut self) {
        self.host.close();
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

pub(super) type TestSocket = tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>;
pub(super) type TestDial = Arc<dyn Fn() -> native::NativeFuture<'static, TestSocket> + Send + Sync>;

pub(super) fn dial() -> (TestDial, tokio::sync::mpsc::UnboundedReceiver<TestSocket>) {
    let (send, receive) = tokio::sync::mpsc::unbounded_channel();
    let connect = Arc::new(move || {
        let send = send.clone();
        Box::pin(async move {
            use tokio_tungstenite::tungstenite::protocol::Role;
            let (client, peer) = tokio::io::duplex(256 * 1024);
            let client = TestSocket::from_raw_socket(client, Role::Client, None).await;
            let peer = TestSocket::from_raw_socket(peer, Role::Server, None).await;
            send.send(peer).map_err(|_| access::Error::Unavailable)?;
            Ok(client)
        }) as native::NativeFuture<'static, TestSocket>
    });
    (connect, receive)
}

#[derive(Clone)]
pub(super) struct TestClock {
    now: tokio::sync::watch::Sender<u64>,
    armed: tokio::sync::mpsc::UnboundedSender<u64>,
}
pub(super) const WALL_BASE: u64 = 1_793_440_800_000;

impl TestClock {
    pub fn now(&self) -> u64 {
        *self.now.borrow()
    }
    pub fn wall(&self) -> u64 {
        WALL_BASE + self.now()
    }
    pub fn advance_to(&self, now: u64) {
        self.now.send_replace(now);
    }
    pub async fn sleep_until(&self, deadline: u64) {
        let mut now = self.now.subscribe();
        let _ = self.armed.send(deadline);
        while *now.borrow_and_update() < deadline {
            now.changed().await.unwrap();
        }
    }
}
pub(super) fn clock() -> (TestClock, tokio::sync::mpsc::UnboundedReceiver<u64>) {
    let (now, _) = tokio::sync::watch::channel(0);
    let (armed, receive) = tokio::sync::mpsc::unbounded_channel();
    (TestClock { now, armed }, receive)
}
