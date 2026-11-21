include!("policy_fixture.rs");
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use ycoding_core::{
    dots::{
        Admission, DecisionServices, Decisions,
        access::{Access, ConfigurationStatus, Error},
        native::{
            Backend, Channel, ChannelAddress, Configuration, Host, Listener, Model, NativeFuture,
            Options, Pins, RemovalLease, ResolvedCredential, Skill, Subscription,
        },
    },
    process::guardrails::{Guardrails, Limits, Paths, Settings},
    resources::{config, credential},
    session::{orchestration, pending, review, run_coordinator, store::Service},
    tools::policy::{forms::Forms, permissions::Permissions, questions::Questions},
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, ObjectEncoder, form, guardrail, location, model,
    parse_json, permission, session, session_pending,
};

type AsyncGate = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);
type BlockingGate = (
    tokio::sync::oneshot::Sender<()>,
    std::sync::mpsc::Receiver<()>,
);

struct Execution {
    client: ycoding_store::Client,
    recoveries: Arc<AtomicUsize>,
    recovery_gate: Arc<std::sync::Mutex<Option<AsyncGate>>>,
}
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
        Box::pin(async {
            Err(review::DeliveryError::Conflict(
                "outside selected fixture".into(),
            ))
        })
    }
    fn resolve_recovery<'a>(
        &'a self,
        resolution: review::RecoveryResolution,
    ) -> review::DeliveryFuture<'a> {
        Box::pin(async move {
            let gate = self.recovery_gate.lock().unwrap().take();
            if let Some((entered, release)) = gate {
                entered.send(()).unwrap();
                release.await.unwrap();
            }
            let claim = resolution.claim;
            self.client
                .submit(move |tx| claim.commit(tx, 8))
                .map_err(review::DeliveryError::Store)?
                .await
                .map_err(review::DeliveryError::Store)?;
            self.recoveries.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
    }
}
struct NativeBackend {
    sessions: Service,
    decisions: Arc<Decisions>,
    calls: AtomicUsize,
    interrupted: AtomicUsize,
    active: Arc<AtomicBool>,
    listeners: std::sync::Mutex<Vec<Listener>>,
    failing_selections: std::sync::Mutex<std::collections::BTreeSet<String>>,
    archiving_selections: std::sync::Mutex<std::collections::BTreeSet<String>>,
    client: ycoding_store::Client,
    pause_catalog: std::sync::Mutex<Option<AsyncGate>>,
}
struct NativeRemoval {
    members: Vec<session::Id>,
    active: Arc<AtomicBool>,
}
impl RemovalLease for NativeRemoval {
    fn members(&self) -> &[session::Id] {
        &self.members
    }
    fn is_current(&self) -> bool {
        !self.active.load(Ordering::Acquire)
    }
}
impl Backend for NativeBackend {
    fn decisions(&self, _: session::Info) -> NativeFuture<'_, Arc<Decisions>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let service = self.decisions.clone();
        Box::pin(async move { Ok(service) })
    }
    fn selected_model(&self, session: session::Info) -> NativeFuture<'_, Option<model::Ref>> {
        let id = session.id.as_lossless().to_utf8().unwrap_or_default();
        let archiving = self.archiving_selections.lock().unwrap().contains(&id);
        let failing = self.failing_selections.lock().unwrap().contains(&id);
        let client = self.client.clone();
        Box::pin(async move {
            if archiving {
                let root = id.clone();
                if let Ok(receipt) = client.submit(move |tx| {
                    let root = LosslessString::from(root.as_str());
                    let key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&root)]);
                    let mut row = tx
                        .get::<ycoding_store::session::SessionTable>(&key)?
                        .unwrap();
                    row.time_archived = Some(9);
                    tx.put::<ycoding_store::session::SessionTable>(&row)
                }) {
                    let _ = receipt.await;
                }
            }
            if failing {
                return Err(Error::Unavailable);
            }
            Ok(None)
        })
    }
    fn models(&self, location: location::Ref) -> NativeFuture<'_, Vec<Model>> {
        let pause = self.pause_catalog.lock().unwrap().take();
        Box::pin(async move {
            if let Some((started, released)) = pause {
                started.send(()).unwrap();
                released.await.unwrap();
            }
            Ok(vec![Model {
                id: location.directory.as_lossless().to_utf8().unwrap(),
                provider_id: "fixture".into(),
                name: None,
                profile: None,
                active: None,
                variants: None,
                is_default: None,
            }])
        })
    }
    fn validate_model(&self, _: location::Ref, _: model::Ref) -> NativeFuture<'_, model::Ref> {
        Box::pin(async { Err(Error::Unavailable) })
    }
    fn switch_model(&self, _: session::Info, _: model::Ref, _: Admission) -> NativeFuture<'_, ()> {
        Box::pin(async { Err(Error::Unavailable) })
    }
    fn retire_root(
        &self,
        root: session::Id,
        admission: Admission,
    ) -> NativeFuture<'_, Box<dyn RemovalLease>> {
        Box::pin(async move {
            admission
                .validate(&self.sessions, Some(&root))
                .map_err(|_| Error::Unavailable)?;
            if self.active.load(Ordering::Acquire) {
                return Err(Error::Unavailable);
            }
            let snapshot = self.client.snapshot().map_err(|_| Error::Unavailable)?;
            let mut reader = ycoding_core::session::family::Reader::Snapshot(&snapshot);
            let members = ycoding_core::session::family::members(&mut reader, root.as_lossless())
                .map_err(|_| Error::Unavailable)?
                .into_iter()
                .map(session::Id::new)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| Error::Unavailable)?;
            Ok(Box::new(NativeRemoval {
                members,
                active: self.active.clone(),
            }) as Box<dyn RemovalLease>)
        })
    }
    fn skills(&self, _: session::Info) -> NativeFuture<'_, Vec<Skill>> {
        Box::pin(async {
            Ok(vec![Skill {
                id: "fixture-skill".into(),
                name: None,
            }])
        })
    }
    fn active(&self, _: &session::Id) -> bool {
        self.active.load(Ordering::Acquire)
    }
    fn prompt(&self, request: pending::Request, admission: Admission) -> NativeFuture<'_, ()> {
        Box::pin(async move {
            admission
                .admit_input(&self.sessions, request)
                .await
                .map(|_| ())
                .map_err(|_| Error::Unavailable)
        })
    }
    fn interrupt(&self, _: session::Id) -> NativeFuture<'_, ()> {
        self.interrupted.fetch_add(1, Ordering::Relaxed);
        Box::pin(async { Ok(()) })
    }
    fn subscribe(
        &self,
        listener: Listener,
        _: ycoding_core::dots::native::Retirement,
    ) -> Result<Subscription, Error> {
        self.listeners.lock().unwrap().push(listener);
        Ok(Subscription::new(|| {}))
    }
}
struct NativeFixture {
    fixture: Fixture,
    host: Host,
    access: Access,
    backend: Arc<NativeBackend>,
    forms: Forms,
    permissions: Permissions,
    reviews: review::Service,
    orchestration: orchestration::Service,
    guardrails: Guardrails,
    custom_decision: Arc<std::sync::Mutex<guardrail::RuleDecision>>,
    recoveries: Arc<AtomicUsize>,
    recovery_gate: Arc<std::sync::Mutex<Option<AsyncGate>>>,
    live: Arc<AtomicBool>,
    checks: Arc<AtomicUsize>,
    checked: Arc<std::sync::Mutex<Option<BlockingGate>>>,
    root: session::Id,
    directory: PathBuf,
    profile_file: PathBuf,
}
impl NativeFixture {
    async fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "ycoding-native-fixture-{}-{}",
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
        let fixture = Fixture::default();
        let root = fixture.session("ses_native_root", None, 0, false, None);
        let credentials = credential::Service::new(fixture.store.client());
        credentials.create("credential_selected".into(), "openai".into(), Some("selected".into()), ycoding_store::resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-access","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{"accountID":"synthetic-account"}}"#).unwrap()).unwrap(), 1).await.unwrap();
        let access = Access::new(
            fixture.store.client(),
            Arc::new(|| {
                Ok(ConfigurationStatus {
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
        let custom_decision = Arc::new(std::sync::Mutex::new(guardrail::RuleDecision::Ask));
        let selected = custom_decision.clone();
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
                custom: Arc::new(move || {
                    vec![ycoding_core::process::guardrails::CustomLayer {
                        rules: vec![guardrail::Rule {
                            id: "synthetic_policy".into(),
                            source: guardrail::RuleSource::Custom,
                            decision: *selected.lock().unwrap(),
                            actions: vec!["file_mutation".into()],
                            resources: vec!["*".into()],
                            reason: "Synthetic review".into(),
                            priority: ycoding_schema::schema::Int::new(0).unwrap(),
                        }],
                        invalid_files: vec![],
                    }]
                }),
                enabled: true,
                limits: Limits::default(),
                decide_reviews: false,
                decide_hard_reviews: false,
            },
            fixture.publisher(),
        );
        let recoveries = Arc::new(AtomicUsize::new(0));
        let recovery_gate = Arc::new(std::sync::Mutex::new(None));
        let execution = Arc::new(Execution {
            client: fixture.store.client(),
            recoveries: recoveries.clone(),
            recovery_gate: recovery_gate.clone(),
        });
        let reviews = review::Service::new(sessions.clone(), execution.clone());
        let orchestration = orchestration::Service::new(sessions.clone(), execution);
        let live = Arc::new(AtomicBool::new(true));
        let checks = Arc::new(AtomicUsize::new(0));
        let checked = Arc::new(std::sync::Mutex::new(None::<BlockingGate>));
        let current = live.clone();
        let counted = checks.clone();
        let notified = checked.clone();
        let decisions = Arc::new(Decisions::new(DecisionServices {
            forms: forms.clone(),
            permissions: permissions.clone(),
            questions: Questions::new(fixture.authority(), fixture.publisher()),
            guardrails: guardrails.clone(),
            reviews: reviews.clone(),
            orchestration: orchestration.clone(),
            lease: Arc::new(()),
            is_current: Arc::new(move || {
                let current = current.load(Ordering::Acquire);
                if counted.fetch_add(1, Ordering::AcqRel) == 1
                    && let Some((notify, released)) = notified.lock().unwrap().take()
                {
                    let _ = notify.send(());
                    released.recv().unwrap();
                }
                current
            }),
        }));
        let backend = Arc::new(NativeBackend {
            sessions: sessions.clone(),
            decisions,
            calls: AtomicUsize::new(0),
            interrupted: AtomicUsize::new(0),
            active: Arc::new(AtomicBool::new(false)),
            listeners: std::sync::Mutex::new(Vec::new()),
            failing_selections: std::sync::Mutex::new(Default::default()),
            archiving_selections: std::sync::Mutex::new(Default::default()),
            client: fixture.store.client(),
            pause_catalog: std::sync::Mutex::new(None),
        });
        let host = Host::new(Options {
            access: access.clone(),
            global,
            credentials,
            sessions,
            client: fixture.store.client(),
            backend: backend.clone(),
            credential: Arc::new(|profile, _| {
                Box::pin(async move {
                    Ok(Some(ResolvedCredential {
                        profile,
                        credential_id: "credential_selected".into(),
                        account_id: "synthetic-account".into(),
                        account_generation: 0,
                        access_token: "synthetic-access".into(),
                    }))
                })
            }),
        })
        .unwrap();
        Self {
            fixture,
            host,
            access,
            backend,
            forms,
            permissions,
            reviews,
            orchestration,
            guardrails,
            custom_decision,
            recoveries,
            recovery_gate,
            live,
            checks,
            checked,
            root,
            directory,
            profile_file,
        }
    }
    fn receipts(&self) -> Vec<JsonValue> {
        self.fixture
            .store
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::session::EventTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                100,
            )
            .unwrap()
            .into_iter()
            .filter(|event| event.type_.as_str() == Some("session.dots.decision.settled.1"))
            .map(|event| event.data)
            .collect()
    }
    fn event_count(&self, type_: &str, aggregate: &session::Id) -> usize {
        self.fixture
            .store
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::session::EventTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                1000,
            )
            .unwrap()
            .into_iter()
            .filter(|event| {
                event.type_.as_str() == Some(type_)
                    && &event.aggregate_id == aggregate.as_lossless()
            })
            .count()
    }
    fn emit(&self, aggregate: &str, type_: &str) {
        let item = ycoding_core::event_feed::Item {
            position: 1,
            payload: ycoding_core::event_feed::Payload::Durable(ycoding_store::session::Event {
                id: format!("evt_synthetic_{type_}_{aggregate}").into(),
                aggregate_id: aggregate.into(),
                seq: 1,
                created: 1,
                type_: type_.into(),
                data: parse_json("{}").unwrap(),
            }),
        };
        let listeners = self.backend.listeners.lock().unwrap().clone();
        for listener in listeners {
            listener(&item);
        }
    }
    fn pins(&self) -> Pins {
        let Configuration::Enabled {
            access_revision,
            profile,
            credential_id,
            account_id,
            account_generation,
        } = self.host.configuration().unwrap()
        else {
            panic!("fixture must enable native access");
        };
        Pins {
            access_revision,
            profile,
            credential_id,
            account_id,
            account_generation,
            environment_id: "environment_fixture".into(),
            connection_id: "connection_fixture".into(),
            is_current: Arc::new(|| true),
        }
    }
    fn channel(&self, stream: &str) -> Channel {
        self.host
            .attach(self.pins())
            .unwrap()
            .channel(ChannelAddress {
                client_id: "client_fixture".into(),
                stream_id: stream.into(),
            })
            .unwrap()
    }
    fn form(&self, id: &str) -> form::Info {
        let form = form::Info::decode(
            &ObjectEncoder::new()
                .field("id", id)
                .field("sessionID", &self.root)
                .field("title", "Synthetic choice")
                .field(
                    "fields",
                    &parse_json(r#"[{"type":"string","key":"value","required":true}]"#).unwrap(),
                )
                .finish(),
        )
        .unwrap();
        self.forms.create(form).unwrap()
    }
    async fn recovery(&self) {
        self.reviews.open(review::OpenInput { session_id: self.root.clone(), kind: ycoding_schema::session_review::Kind::Recovery, reason: ycoding_schema::session_review::Reason::decode(&JsonValue::String("restart".into())).unwrap(), choice: None, confidence: None, grades: None, origin: ycoding_schema::session_review::Origin::Request { request_id: "synthetic_recovery".into(), executor: false }, payload: ycoding_schema::session_review::Payload::decode(&parse_json(r#"{"type":"recovery","tools":[{"messageID":"msg_tool","callID":"call_synthetic","name":"edit"}]}"#).unwrap()).unwrap(), limit: 8, conversion: false, created: 4 }).await.unwrap();
    }
}
impl Drop for NativeFixture {
    fn drop(&mut self) {
        self.host.close();
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}
#[tokio::test]
async fn native_approval_preserves_exact_labels_and_rechecks_live_explicit_denies() {
    let fixture = NativeFixture::new().await;
    let request = permission::Request::decode(
        &ObjectEncoder::new()
            .field("id", "per_native_approval")
            .field("sessionID", &fixture.root)
            .field("action", "read")
            .field(
                "resources",
                &vec![LosslessString::from("/workspace/project/synthetic")],
            )
            .finish(),
    )
    .unwrap();
    let _pending = fixture.permissions.ask(request, None).unwrap();
    assert_eq!(fixture.permissions.list().len(), 1);
    let channel = fixture.channel("stream_a");
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    assert_eq!(candidate.questions.len(), 1);
    assert_eq!(candidate.questions[0].id, "answer");
    assert_eq!(
        candidate.questions[0]
            .options
            .as_ref()
            .unwrap()
            .iter()
            .map(|option| option.label.as_str())
            .collect::<Vec<_>>(),
        vec!["Allow once", "Reject"]
    );
    assert!(
        channel
            .settle(
                &candidate.handle,
                &BTreeMap::from([("answer".into(), vec!["always".into()])])
            )
            .await
            .is_err()
    );
    *fixture.fixture.rules.lock().unwrap() = permission::Ruleset::decode(
        &parse_json(r#"[{"action":"read","resource":"*","effect":"deny"}]"#).unwrap(),
    )
    .unwrap();
    assert!(
        channel
            .settle(
                &candidate.handle,
                &BTreeMap::from([("answer".into(), vec!["Allow once".into()])])
            )
            .await
            .is_err()
    );
    assert_eq!(fixture.permissions.list().len(), 1);
    assert!(fixture.receipts().is_empty());
    channel
        .settle(
            &candidate.handle,
            &BTreeMap::from([("answer".into(), vec!["Reject".into()])]),
        )
        .await
        .unwrap();
    assert!(fixture.permissions.list().is_empty());
    assert_eq!(fixture.receipts().len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn location_generation_retirement_after_the_decision_snapshot_cannot_settle_a_native_form() {
    let fixture = NativeFixture::new().await;
    let channel = fixture.channel("stream_a");
    let form = fixture.form("frm_generation");
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    let (release, released) = std::sync::mpsc::channel();
    fixture.checks.store(0, Ordering::Release);
    let (notify, checked) = tokio::sync::oneshot::channel();
    *fixture.checked.lock().unwrap() = Some((notify, released));
    let settling =
        tokio::spawn(async move { channel.settle(&candidate.handle, &answer("yes")).await });
    checked.await.unwrap();
    fixture.live.store(false, Ordering::Release);
    release.send(()).unwrap();
    assert!(settling.await.unwrap().is_err());
    assert_eq!(fixture.forms.state(&form.id).unwrap(), form::State::Pending);
    assert!(fixture.receipts().is_empty());
}

#[tokio::test]
async fn hard_guardrail_decisions_are_explicit_once_only_and_native_rejection_is_current_attribution()
 {
    let fixture = NativeFixture::new().await;
    let channel = fixture.channel("stream_a");
    let input = || ycoding_core::process::guardrails::Input {
        session_id: fixture.root.clone(),
        action: "shell".into(),
        resources: vec!["rm -rf ~/notes".into()],
        metadata: None,
        skip_review: false,
        holder: None,
        source: None,
    };
    let admission = fixture.guardrails.assert(input()).unwrap();
    assert_eq!(admission.request.as_ref().unwrap().hard_review, Some(true));
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    channel
        .settle(
            &candidate.handle,
            &BTreeMap::from([("answer".into(), vec!["Allow once".into()])]),
        )
        .await
        .unwrap();
    admission.wait.unwrap().await.unwrap().unwrap().release();
    let admission = fixture.guardrails.assert(input()).unwrap();
    assert!(admission.request.is_some());
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    channel
        .settle(
            &candidate.handle,
            &BTreeMap::from([("answer".into(), vec!["Reject".into()])]),
        )
        .await
        .unwrap();
    assert!(admission.wait.unwrap().await.unwrap().is_err());
    assert_eq!(fixture.receipts().len(), 2);
}

#[tokio::test]
async fn custom_guardrail_denies_added_after_projection_cannot_be_overridden_by_native_approval() {
    let fixture = NativeFixture::new().await;
    let admission = fixture
        .guardrails
        .assert(ycoding_core::process::guardrails::Input {
            session_id: fixture.root.clone(),
            action: "file_mutation".into(),
            resources: vec!["/workspace/project/synthetic".into()],
            metadata: None,
            skip_review: false,
            holder: None,
            source: None,
        })
        .unwrap();
    assert!(admission.request.is_some());
    let channel = fixture.channel("stream_a");
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    *fixture.custom_decision.lock().unwrap() = guardrail::RuleDecision::Deny;
    assert!(
        channel
            .settle(
                &candidate.handle,
                &BTreeMap::from([("answer".into(), vec!["Allow once".into()])])
            )
            .await
            .is_err()
    );
    assert_eq!(
        fixture.guardrails.for_session(&fixture.root).unwrap().len(),
        1
    );
    assert!(fixture.receipts().is_empty());
    channel
        .settle(
            &candidate.handle,
            &BTreeMap::from([("answer".into(), vec!["Reject".into()])]),
        )
        .await
        .unwrap();
    assert!(admission.wait.unwrap().await.unwrap().is_err());
    assert_eq!(fixture.receipts().len(), 1);
}

#[tokio::test]
async fn current_incident_admission_rejects_historical_human_attribution_before_resolving_a_model()
{
    let fixture = NativeFixture::new().await;
    let root = fixture.root.clone();
    let result = fixture
        .fixture
        .store
        .submit(move |tx| {
            ycoding_core::model_incident::record::rejection(
                tx,
                &ycoding_schema::model_incident::Id("inc_synthetic".into()),
                &ycoding_core::model_incident::record::GuardrailInput {
                    session_id: root,
                    request_id: guardrail::RequestId::decode(&JsonValue::String(
                        "grq_synthetic".into(),
                    ))
                    .unwrap(),
                    message_id: None,
                    rule_ids: vec!["synthetic".into()],
                    hard_review: true,
                    time: 1,
                },
                &ycoding_schema::model_incident::DecidedBy("human".into()),
            )
        })
        .unwrap()
        .wait();
    assert!(result.is_err());
    assert!(fixture.receipts().is_empty());
}

#[tokio::test]
async fn recovery_native_delivery_commits_exactly_one_claim_and_receipt() {
    let fixture = NativeFixture::new().await;
    fixture.recovery().await;
    let channel = fixture.channel("stream_a");
    let pending = channel.pending(&fixture.root).await.unwrap();
    assert_eq!(pending.len(), 1);
    let candidate = &pending[0];
    assert_eq!(candidate.questions[0].id, "answer");
    assert_eq!(
        candidate.questions[0]
            .options
            .as_ref()
            .unwrap()
            .iter()
            .map(|option| option.label.as_str())
            .collect::<Vec<_>>(),
        ["Continue", "Stop"]
    );
    channel
        .settle(
            &candidate.handle,
            &BTreeMap::from([("answer".into(), vec!["Continue".into()])]),
        )
        .await
        .unwrap();
    assert!(fixture.reviews.list(&fixture.root).unwrap().is_empty());
    assert_eq!(fixture.recoveries.load(Ordering::Relaxed), 1);
    assert_eq!(fixture.receipts().len(), 1);
    assert!(
        channel
            .settle(
                &candidate.handle,
                &BTreeMap::from([("answer".into(), vec!["Continue".into()])])
            )
            .await
            .is_err()
    );
    assert_eq!(fixture.recoveries.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn stream_retirement_while_recovery_delivery_awaits_preserves_the_review_without_a_receipt() {
    let fixture = NativeFixture::new().await;
    fixture.recovery().await;
    let channel = fixture.channel("stream_a");
    let retiring = channel.clone();
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    let (entered_send, entered) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    *fixture.recovery_gate.lock().unwrap() = Some((entered_send, held));
    let settling = tokio::spawn(async move {
        channel
            .settle(
                &candidate.handle,
                &BTreeMap::from([("answer".into(), vec!["Continue".into()])]),
            )
            .await
    });
    entered.await.unwrap();
    retiring.retire();
    release.send(()).unwrap();
    assert!(settling.await.unwrap().is_err());
    assert_eq!(fixture.reviews.list(&fixture.root).unwrap().len(), 1);
    assert_eq!(fixture.recoveries.load(Ordering::Relaxed), 0);
    assert!(fixture.receipts().is_empty());
}

fn answer(value: &str) -> BTreeMap<String, Vec<String>> {
    BTreeMap::from([
        ("value".into(), vec![value.into()]),
        ("action".into(), vec!["Continue".into()]),
    ])
}

#[tokio::test]
async fn native_handles_reject_foreign_invalid_replayed_and_retired_candidates_without_consuming_the_owner()
 {
    let fixture = NativeFixture::new().await;
    let form = fixture.form("frm_native_one");
    let channel = fixture.channel("stream_a");
    let foreign = fixture.channel("stream_b");
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    assert!(
        foreign
            .settle(&candidate.handle, &answer("value"))
            .await
            .is_err()
    );
    assert!(
        channel
            .settle(&candidate.handle, &BTreeMap::new())
            .await
            .is_err()
    );
    assert_eq!(fixture.forms.state(&form.id).unwrap(), form::State::Pending);
    channel
        .settle(&candidate.handle, &answer("value"))
        .await
        .unwrap();
    assert!(matches!(
        fixture.forms.state(&form.id).unwrap(),
        form::State::Answered(_)
    ));
    assert!(
        channel
            .settle(&candidate.handle, &answer("value"))
            .await
            .is_err()
    );
    let form = fixture.form("frm_native_two");
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    channel.retire();
    assert!(
        channel
            .settle(&candidate.handle, &answer("value"))
            .await
            .is_err()
    );
    assert_eq!(fixture.forms.state(&form.id).unwrap(), form::State::Pending);
    let events = fixture
        .fixture
        .store
        .snapshot()
        .unwrap()
        .scan::<ycoding_store::session::EventTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            100,
        )
        .unwrap();
    let receipts = events
        .iter()
        .filter(|event| event.type_.as_str() == Some("session.dots.decision.settled.1"))
        .collect::<Vec<_>>();
    assert_eq!(receipts.len(), 1);
    let JsonValue::Object(receipt) = &receipts[0].data else {
        unreachable!()
    };
    let source = form::NativeReplySource::decode(receipt.get(&"source".into()).unwrap()).unwrap();
    assert_eq!(source.kind, form::NativeReplyKind::DotsNative);
    assert_eq!(source.client_id.0.as_str(), Some("client_fixture"));
    assert_eq!(source.stream_id.0.as_str(), Some("stream_a"));
    assert_eq!(source.root_session_id, fixture.root);
}

#[tokio::test]
async fn off_then_on_profile_replacement_and_archive_retire_old_authority_without_interrupting_admitted_work()
 {
    let fixture = NativeFixture::new().await;
    let channel = fixture.channel("stream_a");
    let input = channel
        .prompt(
            &fixture.root,
            "input_one",
            "Synthetic prompt",
            "queue",
            None,
        )
        .await
        .unwrap();
    fixture.backend.active.store(true, Ordering::Release);
    fixture.access.set(false, 1).await.unwrap();
    assert!(
        channel
            .prompt(&fixture.root, "input_two", "No admission", "steer", None)
            .await
            .is_err()
    );
    fixture.access.set(true, 2).await.unwrap();
    assert!(
        channel
            .prompt(&fixture.root, "input_two", "No admission", "steer", None)
            .await
            .is_err()
    );
    assert!(fixture.backend.sessions.pending(&input).unwrap().is_some());
    assert!(fixture.backend.active.load(Ordering::Acquire));
    assert_eq!(fixture.backend.interrupted.load(Ordering::Relaxed), 0);
    let channel = fixture.channel("stream_b");
    let form = fixture.form("frm_native_archive");
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    let root = fixture.root.clone();
    fixture
        .fixture
        .store
        .submit(move |tx| {
            let key =
                ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(root.as_lossless())]);
            let mut row = tx
                .get::<ycoding_store::session::SessionTable>(&key)?
                .unwrap();
            row.time_archived = Some(3);
            tx.put::<ycoding_store::session::SessionTable>(&row)
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        channel
            .settle(&candidate.handle, &answer("value"))
            .await
            .is_err()
    );
    assert_eq!(fixture.forms.state(&form.id).unwrap(), form::State::Pending);
}

#[tokio::test]
async fn catalogs_do_not_initialize_decision_services_and_roots_exclude_children_archives_and_foreign_ownership()
 {
    let fixture = NativeFixture::new().await;
    fixture
        .fixture
        .session("ses_child", Some("ses_native_root"), 0, false, None);
    let channel = fixture.channel("stream_a");
    assert_eq!(channel.models().await.unwrap().len(), 1);
    assert_eq!(channel.skills().await.unwrap().len(), 1);
    assert_eq!(fixture.backend.calls.load(Ordering::Relaxed), 0);
    let roots = channel.list_roots().await.unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].session.id, fixture.root);
}

#[tokio::test]
async fn native_root_listing_isolates_snapshot_failures_and_keeps_other_roots_readable() {
    let fixture = NativeFixture::new().await;
    fixture
        .fixture
        .session("ses_native_other", None, 0, false, None);
    fixture
        .backend
        .failing_selections
        .lock()
        .unwrap()
        .insert("ses_native_root".into());
    let channel = fixture.channel("stream_snapshot_error");
    let roots = channel.list_roots().await.unwrap();
    let mut ids = roots
        .iter()
        .map(|root| root.session.id.as_lossless().to_utf8().unwrap())
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids, ["ses_native_other", "ses_native_root"]);
    let broken = roots
        .iter()
        .find(|root| root.session.id == fixture.root)
        .unwrap();
    assert!(broken.snapshot_error);
    assert!(!broken.active);
    assert!(broken.waiting.is_empty());
    assert_eq!(broken.selected_model, None);
    let other = roots
        .iter()
        .find(|root| root.session.id != fixture.root)
        .unwrap();
    assert!(!other.snapshot_error);
    let other_id = other.session.id.clone();
    assert_eq!(
        channel
            .get_root(&other_id)
            .await
            .unwrap()
            .map(|root| root.session.id),
        Some(other_id.clone())
    );
    assert_eq!(
        channel.read_root(&other_id).await.unwrap().messages.len(),
        0
    );
    assert!(channel.get_root(&fixture.root).await.is_err());
    assert!(channel.read_root(&fixture.root).await.is_err());
}

#[tokio::test]
async fn native_root_listing_revalidates_roots_whose_snapshots_fail() {
    let fixture = NativeFixture::new().await;
    fixture
        .fixture
        .session("ses_native_other", None, 0, false, None);
    fixture
        .backend
        .archiving_selections
        .lock()
        .unwrap()
        .insert("ses_native_root".into());
    fixture
        .backend
        .failing_selections
        .lock()
        .unwrap()
        .insert("ses_native_root".into());
    let channel = fixture.channel("stream_snapshot_revalidate");
    let roots = channel.list_roots().await.unwrap();
    assert_eq!(roots.len(), 1);
    assert_ne!(roots[0].session.id, fixture.root);
    assert!(!roots[0].snapshot_error);
}

#[tokio::test]
async fn prompt_and_create_retries_share_durable_identity_and_native_source_is_pinned() {
    let fixture = NativeFixture::new().await;
    let channel = fixture.channel("stream_a");
    let first = channel
        .prompt(&fixture.root, "input_one", "First text", "queue", None)
        .await
        .unwrap();
    let retried = channel
        .prompt(
            &fixture.root,
            "input_one",
            "Different retry text",
            "steer",
            None,
        )
        .await
        .unwrap();
    assert_eq!(first, retried);
    let pending = fixture.backend.sessions.pending(&first).unwrap().unwrap();
    let session_pending::Info::User(pending) = session_pending::Info::decode(
        &ObjectEncoder::new()
            .field("type", "user")
            .field("id", &pending.id)
            .field("sessionID", &pending.session_id)
            .field("admittedSeq", &(pending.admitted_seq as f64))
            .field("timeCreated", &(pending.time_created as f64))
            .optional("delivery", &pending.delivery)
            .field("data", &pending.data)
            .finish(),
    )
    .unwrap() else {
        unreachable!()
    };
    assert_eq!(pending.data.text.as_str(), Some("First text"));
    let metadata = pending.data.metadata.unwrap();
    let source =
        form::NativeReplySource::decode(metadata.get(&"nativeSource".into()).unwrap()).unwrap();
    assert_eq!(source.request_id.0.as_str(), Some("input_one"));
    let root = channel
        .create_root(
            "create_one",
            "/workspace/project",
            Some("Synthetic root"),
            None,
        )
        .await
        .unwrap();
    let retry = channel
        .create_root(
            "create_one",
            "/workspace/project",
            Some("Retry title"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(root.session.id, retry.session.id);
    assert_eq!(root.session.title, retry.session.title);
    assert!(
        channel
            .create_root("create_two", "/not-a-recorded-directory", None, None)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn native_root_creation_marks_the_executor_origin_on_the_event_row_and_info_and_retries_keep_it()
 {
    let fixture = NativeFixture::new().await;
    let channel = fixture.channel("stream_a");
    let root = channel
        .create_root(
            "origin_one",
            "/workspace/project",
            Some("Executor root"),
            None,
        )
        .await
        .unwrap();
    let retry = channel
        .create_root(
            "origin_one",
            "/workspace/project",
            Some("Retry title"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(root.session.id, retry.session.id);
    assert_eq!(root.session.origin, Some(session::Origin::DotsExecutor));
    assert_eq!(retry.session.origin, Some(session::Origin::DotsExecutor));
    let id = root.session.id.clone();
    assert_eq!(
        fixture.backend.sessions.get(&id).unwrap().unwrap().origin,
        Some(session::Origin::DotsExecutor)
    );
    let snapshot = fixture.fixture.store.snapshot().unwrap();
    let key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(id.as_lossless())]);
    let row = snapshot
        .get::<ycoding_store::session::SessionTable>(&key)
        .unwrap()
        .unwrap();
    assert_eq!(
        row.origin.as_ref().and_then(|origin| origin.as_str()),
        Some("dots-executor")
    );
    let created = snapshot
        .scan::<ycoding_store::session::EventTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            256,
        )
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.type_.as_str() == Some("session.created.2")
                && event.aggregate_id.as_str() == id.as_lossless().as_str()
        })
        .collect::<Vec<_>>();
    assert_eq!(created.len(), 1);
    let data = ycoding_schema::stringify_json(&created[0].data);
    assert!(data.contains(r#""origin":"dots-executor""#), "{data}");
    assert_eq!(
        fixture
            .backend
            .sessions
            .get(&fixture.root)
            .unwrap()
            .unwrap()
            .origin,
        None
    );
}

#[tokio::test]
async fn trusted_global_configuration_cannot_be_replaced_by_location_documents_or_caller_profile_fallback()
 {
    let fixture = NativeFixture::new().await;
    std::fs::write(&fixture.profile_file, r#"{"dots":{"enabled":false}}"#).unwrap();
    assert_eq!(
        fixture.host.configuration().unwrap(),
        Configuration::Disabled
    );
    assert!(
        fixture
            .host
            .credential("selected", None)
            .await
            .unwrap()
            .is_none()
    );
    std::fs::write(&fixture.profile_file, r#"{"dots":{"enabled":true}}"#).unwrap();
    assert_eq!(
        fixture.host.configuration().unwrap(),
        Configuration::Disabled
    );
    std::fs::write(&fixture.profile_file, "{").unwrap();
    assert_eq!(
        fixture.host.configuration().unwrap(),
        Configuration::Disabled
    );
}

#[tokio::test]
async fn catalogs_merge_each_eligible_location_and_recheck_root_authority_after_waiting() {
    let fixture = NativeFixture::new().await;
    let other = fixture
        .fixture
        .session("ses_native_other", None, 0, false, None);
    let other_copy = other.clone();
    fixture
        .fixture
        .store
        .submit(move |tx| {
            let key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
                other_copy.as_lossless(),
            )]);
            let mut row = tx
                .get::<ycoding_store::session::SessionTable>(&key)?
                .unwrap();
            row.directory = "/workspace/another".into();
            tx.put::<ycoding_store::session::SessionTable>(&row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let channel = fixture.channel("stream_a");
    let models = channel.models().await.unwrap();
    assert_eq!(models.len(), 2);
    assert!(models.iter().any(|model| model.id == "/workspace/another"));
    assert!(models.iter().any(|model| model.id == "/workspace/project"));
    assert_eq!(fixture.backend.calls.load(Ordering::Relaxed), 0);
    let (started, waiting) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    *fixture.backend.pause_catalog.lock().unwrap() = Some((started, released));
    let reading = channel.clone();
    let result = tokio::spawn(async move { reading.models().await });
    waiting.await.unwrap();
    let root = fixture.root.clone();
    fixture
        .fixture
        .store
        .submit(move |tx| {
            for id in [root, other] {
                let key =
                    ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(id.as_lossless())]);
                let mut row = tx
                    .get::<ycoding_store::session::SessionTable>(&key)?
                    .unwrap();
                row.time_archived = Some(9);
                tx.put::<ycoding_store::session::SessionTable>(&row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    release.send(()).unwrap();
    assert!(result.await.unwrap().unwrap().is_empty());
    assert_eq!(fixture.backend.calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn replacing_the_selected_account_invalidates_pinned_candidates_without_consuming_the_form() {
    let fixture = NativeFixture::new().await;
    let channel = fixture.channel("stream_a");
    let form = fixture.form("frm_account");
    let candidate = channel.pending(&fixture.root).await.unwrap().remove(0);
    credential::Service::new(fixture.fixture.store.client()).create("credential_replacement".into(), "openai".into(), Some("selected".into()), ycoding_store::resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-replacement-access","refresh":"synthetic-replacement-refresh","expires":9007199254740000,"metadata":{"accountID":"another-synthetic-account"}}"#).unwrap()).unwrap(), 2).await.unwrap();
    assert!(
        channel
            .settle(
                &candidate.handle,
                &BTreeMap::from([
                    ("action".into(), vec!["Continue".into()]),
                    ("value".into(), vec!["yes".into()])
                ])
            )
            .await
            .is_err()
    );
    assert_eq!(
        fixture.forms.list(Some(fixture.root.as_lossless())).len(),
        1
    );
    assert_eq!(
        fixture.forms.list(Some(fixture.root.as_lossless()))[0].id,
        form.id
    );
    assert!(fixture.receipts().is_empty());
    assert!(
        fixture
            .host
            .credential("selected", None)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn deferred_review_reply_commits_its_decision_continuation_and_native_receipt_together() {
    let fixture = NativeFixture::new().await;
    let item = fixture
        .reviews
        .open(review::OpenInput {
            session_id: fixture.root.clone(),
            kind: ycoding_schema::session_review::Kind::Question,
            reason: ycoding_schema::session_review::Reason::DeferEntry,
            choice: None,
            confidence: None,
            grades: None,
            origin: ycoding_schema::session_review::Origin::Request {
                request_id: "synthetic_review".into(),
                executor: false,
            },
            payload: ycoding_schema::session_review::Payload::Form(
                ycoding_schema::session_review::FormPayload {
                    title: "Synthetic review".into(),
                    fields: Vec::<form::Field>::decode(
                        &parse_json(r#"[{"type":"string","key":"value","required":true}]"#)
                            .unwrap(),
                    )
                    .unwrap(),
                    question_tool: false,
                    coordination_escalation: None,
                },
            ),
            limit: 8,
            conversion: false,
            created: 4,
        })
        .await
        .unwrap();
    let channel = fixture.channel("stream_a");
    let pending = channel.pending(&fixture.root).await.unwrap();
    assert_eq!(pending.len(), 1);
    let candidate = &pending[0];
    assert!(
        channel
            .settle(
                &candidate.handle,
                &BTreeMap::from([("value".into(), vec!["yes".into()])])
            )
            .await
            .is_err()
    );
    assert_eq!(fixture.reviews.list(&fixture.root).unwrap().len(), 1);
    assert!(fixture.receipts().is_empty());
    channel
        .settle(
            &candidate.handle,
            &BTreeMap::from([
                ("action".into(), vec!["Continue".into()]),
                ("value".into(), vec!["yes".into()]),
            ]),
        )
        .await
        .unwrap();
    assert!(fixture.reviews.list(&fixture.root).unwrap().is_empty());
    assert_eq!(
        fixture
            .backend
            .sessions
            .pending_list(&fixture.root)
            .unwrap()
            .len(),
        1
    );
    let receipts = fixture.receipts();
    assert_eq!(receipts.len(), 1);
    assert!(
        ycoding_schema::stringify_json(&receipts[0])
            .contains(item.deferral.item_id.as_lossless().as_str().unwrap())
    );
    assert!(
        channel
            .settle(&candidate.handle, &BTreeMap::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn an_unreusable_browser_identity_does_not_consume_a_review_grant() {
    use ycoding_core::tools::{
        context::{Context, policy::LeafPolicy},
        policy::Reviews,
    };
    use ycoding_schema::session_review::{Decision, Kind, Origin, Payload, Reason};
    let fixture = NativeFixture::new().await;
    let permissions = fixture.permissions.clone().with_reviews(
        Reviews {
            service: fixture.reviews.clone(),
            limit: 8,
        },
        "/workspace/project".into(),
    );
    let metadata = match parse_json(r#"{"operationDigest":"synthetic-browser-operation"}"#).unwrap()
    {
        JsonValue::Object(value) => value,
        _ => unreachable!(),
    };
    let resources = vec!["https://example.test".into()];
    let fingerprint = review::fingerprint(&review::FingerprintInput {
        action: "browser_read".into(),
        resources: resources.clone(),
        workdir: "/workspace/project".into(),
        rule_ids: vec![],
        hard_review: false,
        metadata: Some(metadata.clone()),
    });
    let item = fixture
        .reviews
        .open(review::OpenInput {
            session_id: fixture.root.clone(),
            kind: Kind::Permission,
            reason: Reason::DeferEntry,
            choice: None,
            confidence: None,
            grades: None,
            origin: Origin::Request {
                request_id: "per_browser_fixture".into(),
                executor: false,
            },
            payload: Payload::decode(
                &ycoding_schema::ObjectEncoder::new()
                    .field("type", "permission")
                    .field("action", "browser_read")
                    .field("resources", &resources)
                    .field("fingerprint", &fingerprint)
                    .field("fingerprintVersion", &2.0_f64)
                    .field("requestID", "per_browser_fixture")
                    .finish(),
            )
            .unwrap(),
            limit: 8,
            conversion: false,
            created: 4,
        })
        .await
        .unwrap();
    fixture
        .reviews
        .decide(review::DecideInput {
            session_id: fixture.root.clone(),
            item_id: item.deferral.item_id,
            decision: Decision::decode(
                &parse_json(r#"{"kind":"permission","reply":"once"}"#).unwrap(),
            )
            .unwrap(),
            now: 5,
        })
        .await
        .unwrap();
    let policy = LeafPolicy {
        permissions: permissions.clone(),
        guardrails: fixture.guardrails.clone(),
    };
    let context = Context::new("ses_native_root", "test", "msg_browser", "call_browser").unwrap();
    let mut pending = Box::pin(policy.assert_with_review(
        &context,
        "browser_read",
        resources.clone(),
        vec![],
        Some(metadata.clone()),
        false,
    ));
    assert!(matches!(
        std::future::poll_fn(|context| std::task::Poll::Ready(std::future::Future::poll(
            pending.as_mut(),
            context
        )))
        .await,
        std::task::Poll::Pending
    ));
    assert_eq!(permissions.for_session(&fixture.root).len(), 1);
    drop(pending);
    assert!(permissions.for_session(&fixture.root).is_empty());
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        policy.assert_with_review(
            &context,
            "browser_read",
            resources,
            vec![],
            Some(metadata),
            true,
        ),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert!(
        !fixture
            .reviews
            .consume(
                &fixture.root,
                review::GrantKind::Permission,
                &fingerprint,
                6
            )
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn child_question_reply_preserves_direct_parent_ownership_and_admits_exactly_one_continuation()
 {
    let fixture = NativeFixture::new().await;
    let task = fixture
        .orchestration
        .launch(orchestration::LaunchInput {
            parent_id: fixture.root.clone(),
            parent_assistant_message_id: ycoding_schema::session_message::Id::new(
                "msg_synthetic_parent",
            )
            .unwrap(),
            tool_call_id: "call_synthetic_child".into(),
            description: "Synthetic child".into(),
            prompt: "Inspect synthetic input".into(),
            depth_limit: 2,
            prepared: orchestration::Prepared {
                agent: "explore".into(),
                caller_permissions: permission::Ruleset::decode(&parse_json("[]").unwrap())
                    .unwrap(),
                model: model::Ref::decode(
                    &parse_json(r#"{"providerID":"fixture","id":"fixture"}"#).unwrap(),
                )
                .unwrap(),
                profile_binding: None,
            },
            guardrails: fixture.guardrails.clone(),
        })
        .await
        .unwrap();
    let asked = fixture
        .orchestration
        .question(&task.session_id, "Which synthetic option?", None)
        .await
        .unwrap();
    assert!(!asked.auto_answered);
    let channel = fixture.channel("stream_a");
    let pending = channel.pending(&fixture.root).await.unwrap();
    assert_eq!(pending.len(), 1);
    let candidate = &pending[0];
    assert_eq!(
        candidate.thread_id,
        fixture.root.as_lossless().to_utf8().unwrap()
    );
    assert!(candidate.id.contains("child"));
    let before = fixture
        .backend
        .sessions
        .pending_list(&task.session_id)
        .unwrap()
        .len();
    channel
        .settle(
            &candidate.handle,
            &BTreeMap::from([
                ("action".into(), vec!["Continue".into()]),
                ("value".into(), vec!["First synthetic option".into()]),
            ]),
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .backend
            .sessions
            .pending_list(&task.session_id)
            .unwrap()
            .len(),
        before
    );
    assert!(fixture.receipts().is_empty());
    let next = channel.pending(&fixture.root).await.unwrap().remove(0);
    channel
        .settle(
            &next.handle,
            &BTreeMap::from([("action".into(), vec!["Skip field".into()])]),
        )
        .await
        .unwrap();
    assert!(
        fixture.orchestration.list(&fixture.root).unwrap()[0]
            .question
            .is_none()
    );
    assert_eq!(
        fixture
            .backend
            .sessions
            .pending_list(&task.session_id)
            .unwrap()
            .len(),
        before + 1
    );
    assert_eq!(fixture.receipts().len(), 1);
    assert!(
        channel
            .settle(&candidate.handle, &BTreeMap::new())
            .await
            .is_err()
    );
}

fn notified() -> (
    Arc<std::sync::Mutex<Vec<session::Id>>>,
    ycoding_core::dots::native::EscalationListener,
) {
    let roots = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = roots.clone();
    (
        roots,
        Arc::new(move |root: &session::Id| sink.lock().unwrap().push(root.clone())),
    )
}

#[tokio::test]
async fn rename_appends_one_gated_event_and_refuses_blank_titles_children_and_retired_authority() {
    let fixture = NativeFixture::new().await;
    let child =
        fixture
            .fixture
            .session("ses_native_child", Some("ses_native_root"), 0, false, None);
    let channel = fixture.channel("stream_rename");
    assert_eq!(channel.profile().unwrap(), "selected");
    assert!(matches!(
        channel.rename_root(&fixture.root, "   ").await,
        Err(Error::InvalidInput)
    ));
    assert!(matches!(
        channel
            .rename_root(&fixture.root, "\u{feff}\u{a0}\u{2028}")
            .await,
        Err(Error::InvalidInput)
    ));
    assert!(matches!(
        channel
            .prompt(
                &fixture.root,
                "input_blank",
                "\u{feff} \u{a0}",
                "steer",
                None
            )
            .await,
        Err(Error::InvalidInput)
    ));
    assert_eq!(fixture.event_count("session.renamed.1", &fixture.root), 0);
    channel.rename_root(&fixture.root, "\u{85}").await.unwrap();
    assert_eq!(fixture.event_count("session.renamed.1", &fixture.root), 1);
    channel
        .rename_root(&fixture.root, "  Renamed ")
        .await
        .unwrap();
    let title = fixture
        .backend
        .sessions
        .get(&fixture.root)
        .unwrap()
        .unwrap()
        .title;
    assert_eq!(title.as_str(), Some("  Renamed "));
    assert_eq!(fixture.event_count("session.renamed.1", &fixture.root), 2);
    assert!(channel.rename_root(&child, "Child").await.is_err());
    assert_eq!(fixture.event_count("session.renamed.1", &child), 0);
    fixture.access.set(false, 1).await.unwrap();
    assert!(channel.profile().is_err());
    assert!(channel.rename_root(&fixture.root, "After").await.is_err());
    assert_eq!(fixture.event_count("session.renamed.1", &fixture.root), 2);
}

#[tokio::test]
async fn archive_retires_its_subscription_hides_the_root_and_unarchive_restores_it_once() {
    let fixture = NativeFixture::new().await;
    let child =
        fixture
            .fixture
            .session("ses_native_child", Some("ses_native_root"), 0, false, None);
    let channel = fixture.channel("stream_archive");
    let retired = Arc::new(AtomicBool::new(false));
    let flag = retired.clone();
    let _subscription = channel
        .subscribe(
            &fixture.root,
            Arc::new(|_| {}),
            Some(Box::new(move || flag.store(true, Ordering::Release))),
        )
        .unwrap();
    assert!(channel.archive_root(&child).await.is_err());
    assert_eq!(fixture.event_count("session.archived.2", &child), 0);
    channel.archive_root(&fixture.root).await.unwrap();
    assert!(retired.load(Ordering::Acquire));
    assert_eq!(fixture.event_count("session.archived.2", &fixture.root), 1);
    assert!(channel.list_roots().await.unwrap().is_empty());
    assert!(channel.get_root(&fixture.root).await.unwrap().is_none());
    assert!(channel.archive_root(&fixture.root).await.is_err());
    assert!(
        channel
            .rename_root(&fixture.root, "Archived")
            .await
            .is_err()
    );
    assert_eq!(fixture.event_count("session.archived.2", &fixture.root), 1);
    assert!(channel.unarchive_root(&child).await.is_err());
    let restored = channel.unarchive_root(&fixture.root).await.unwrap();
    assert_eq!(restored.session.id, fixture.root);
    assert_eq!(
        fixture.event_count("session.unarchived.2", &fixture.root),
        1
    );
    assert_eq!(channel.list_roots().await.unwrap().len(), 1);
    assert_eq!(
        channel
            .unarchive_root(&fixture.root)
            .await
            .unwrap()
            .session
            .id,
        fixture.root
    );
    assert_eq!(
        fixture.event_count("session.unarchived.2", &fixture.root),
        1
    );
    fixture.access.set(false, 1).await.unwrap();
    assert!(channel.unarchive_root(&fixture.root).await.is_err());
    assert_eq!(
        fixture.event_count("session.unarchived.2", &fixture.root),
        1
    );
}

#[tokio::test]
async fn remove_deletes_the_whole_family_atomically_and_refuses_foreign_owned_descendants() {
    let fixture = NativeFixture::new().await;
    let child =
        fixture
            .fixture
            .session("ses_native_child", Some("ses_native_root"), 0, false, None);
    let owned = child.clone();
    fixture
        .fixture
        .store
        .submit(move |tx| {
            ycoding_store::session::SequenceTable::put(
                tx,
                &ycoding_store::session::Sequence {
                    aggregate_id: owned.as_lossless().clone(),
                    seq: 0,
                    owner_id: Some("foreign_owner".into()),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let channel = fixture.channel("stream_remove");
    assert!(channel.remove_root(&child).await.is_err());
    assert!(channel.remove_root(&fixture.root).await.is_err());
    assert!(
        fixture
            .backend
            .sessions
            .get(&fixture.root)
            .unwrap()
            .is_some()
    );
    assert!(fixture.backend.sessions.get(&child).unwrap().is_some());
    assert_eq!(fixture.event_count("session.deleted.2", &fixture.root), 0);
    assert_eq!(fixture.event_count("session.deleted.2", &child), 0);
    let released = child.clone();
    fixture
        .fixture
        .store
        .submit(move |tx| {
            ycoding_store::session::SequenceTable::put(
                tx,
                &ycoding_store::session::Sequence {
                    aggregate_id: released.as_lossless().clone(),
                    seq: 0,
                    owner_id: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    channel.remove_root(&fixture.root).await.unwrap();
    assert!(
        fixture
            .backend
            .sessions
            .get(&fixture.root)
            .unwrap()
            .is_none()
    );
    assert!(fixture.backend.sessions.get(&child).unwrap().is_none());
    assert_eq!(fixture.event_count("session.deleted.2", &fixture.root), 1);
    assert_eq!(fixture.event_count("session.deleted.2", &child), 1);
    assert!(channel.remove_root(&fixture.root).await.is_err());
}

#[tokio::test]
async fn escalations_report_roots_with_pending_decisions_and_only_for_current_authority() {
    let fixture = NativeFixture::new().await;
    let child =
        fixture
            .fixture
            .session("ses_native_child", Some("ses_native_root"), 0, false, None);
    let channel = fixture.channel("stream_escalation");
    let (quiet, listener) = notified();
    let idle = channel.subscribe_escalations(listener).await.unwrap();
    assert!(quiet.lock().unwrap().is_empty());
    idle.stop();
    fixture.form("frm_native_escalated");
    let (roots, listener) = notified();
    let subscription = channel.subscribe_escalations(listener).await.unwrap();
    assert_eq!(*roots.lock().unwrap(), vec![fixture.root.clone()]);
    fixture.emit("ses_native_root", "session.task.updated.1");
    fixture.emit(
        child.as_lossless().as_str().unwrap(),
        "session.review.decided.1",
    );
    assert_eq!(roots.lock().unwrap().len(), 3);
    assert_eq!(roots.lock().unwrap()[2], fixture.root);
    fixture.emit("ses_native_root", "session.step.started.1");
    fixture.emit("ses_native_missing", "session.task.updated.1");
    assert_eq!(roots.lock().unwrap().len(), 3);
    channel.archive_root(&fixture.root).await.unwrap();
    fixture.emit("ses_native_root", "session.task.updated.1");
    assert_eq!(roots.lock().unwrap().len(), 3);
    channel.unarchive_root(&fixture.root).await.unwrap();
    fixture.emit("ses_native_root", "session.unarchived.2");
    assert_eq!(roots.lock().unwrap().len(), 4);
    subscription.stop();
    fixture.emit("ses_native_root", "session.task.updated.1");
    assert_eq!(roots.lock().unwrap().len(), 4);
    let (after, listener) = notified();
    let _retained = channel.subscribe_escalations(listener).await.unwrap();
    let before = after.lock().unwrap().len();
    fixture.access.set(false, 1).await.unwrap();
    fixture.emit("ses_native_root", "session.task.updated.1");
    assert_eq!(after.lock().unwrap().len(), before);
    assert!(
        channel
            .subscribe_escalations(Arc::new(|_| {}))
            .await
            .is_err()
    );
}
