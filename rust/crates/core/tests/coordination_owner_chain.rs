include!("policy_fixture.rs");

#[path = "autonomy_support/mod.rs"]
mod support;

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use ycoding_core::{
    coordination::{
        self, Service,
        decisions::{
            CoordinationDecisions, Evidence, Options as DecisionOptions, Services,
            coordinator_decision_reason, id_text,
        },
        runtime::{
            Decision, DecisionActor, DecisionEscalateInput, DecisionEscalateResult,
            DecisionOutcome, DecisionResult, Decisions, Delegation, EscalateOutcome,
            EscalationTarget, EvaluateInput, Future, Options, Pending, PendingInput, RequestDetail,
            Runtime, SendInput,
        },
    },
    event_feed::Feed,
    job,
    process::guardrails::{Guardrails, Input as GuardrailInput, Limits, Paths, Settings},
    session::{
        execution::{Execution as SessionExecution, Locations, Runner},
        orchestration::{Execution as OrchestrationExecution, Service as Orchestration},
        run_coordinator::{DrainRequest, Outcome, RunFuture},
        store::Service as SessionStore,
    },
    tools::{
        builtin::project::Project,
        context::Context,
        policy::{forms::Forms, permissions::Error as PermissionError},
        registry::Tool,
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, coordination as c, form, parse_json,
    permission, session, session_delivery::Delivery, session_id::SessionId, session_message,
    stringify_json,
};
use ycoding_store::{
    KeyPart,
    session::{Document, Notification, NotificationTable, SessionTable, Task, TaskTable},
    tuple_key,
};

const BOUND: Duration = Duration::from_secs(10);
const OUTSIDE: &str = "touch /outside/private-target";

async fn until(condition: impl Fn() -> bool) {
    tokio::time::timeout(BOUND, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("condition holds");
}

fn sid(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn rule(action: &str, resource: &str, effect: &str) -> permission::Rule {
    permission::Rule {
        action: action.into(),
        resource: resource.into(),
        effect: permission::Effect(effect.into()),
    }
}

fn reason(result: &DecisionResult) -> Option<String> {
    result
        .reason
        .as_ref()
        .and_then(|reason| reason.to_utf8().ok())
}

fn via(result: &DecisionResult) -> Option<String> {
    result.via.as_ref().and_then(|via| via.to_utf8().ok())
}

fn guardrail_settings() -> Settings {
    Settings {
        paths: Paths {
            workdir: "/workspace/project".into(),
            project: "/workspace/project".into(),
            home: "/home/operator".into(),
            tmpdir: None,
            trusted_paths: vec![],
        },
        global_roots: vec![],
        custom: Arc::new(Vec::new),
        enabled: true,
        limits: Limits::default(),
        decide_reviews: false,
        decide_hard_reviews: false,
    }
}

struct Chain {
    fixture: Fixture,
    permissions: ycoding_core::tools::policy::permissions::Permissions,
    guardrails: Guardrails,
    forms: Forms,
    decisions: CoordinationDecisions,
    group: c::GroupId,
    master: SessionId,
    member: SessionId,
}

async fn chain(modes: [&str; 3]) -> Chain {
    let fixture = Fixture::default();
    fixture
        .rules
        .lock()
        .unwrap()
        .extend([rule("shell", "*", "ask"), rule("edit", "*", "ask")]);
    let master = fixture.session_with("ses_master", None, ["manual"; 3], false, None);
    let member = fixture.session_with("ses_member", None, modes, false, None);
    let client = fixture.store.client();
    let coordination = Service::new(client.clone(), Feed::attach(&client));
    let group = coordination
        .create(c::CreateInput {
            name: "Owner chain".into(),
            master_session_id: master.clone(),
            member_session_ids: vec![member.clone()],
        })
        .await
        .unwrap();
    coordination.activate(&group.id).unwrap();
    let permissions = fixture.permissions();
    let guardrails = Guardrails::new(
        fixture.authority(),
        permissions.clone(),
        guardrail_settings(),
        fixture.publisher(),
    );
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    let services = Services {
        permissions: permissions.clone(),
        forms: forms.clone(),
        guardrails: guardrails.clone(),
        lease: Arc::new(()),
        is_current: Arc::new(|| true),
    };
    let decisions = CoordinationDecisions::new(DecisionOptions {
        coordination,
        settings: Arc::new(|| {
            Box::pin(async {
                Ok(c::Settings {
                    enabled: true,
                    categories: vec![
                        c::RequestKind::Permission,
                        c::RequestKind::Review,
                        c::RequestKind::Question,
                    ],
                    actions: None,
                    resources: None,
                    expires_at: None,
                })
            })
        }),
        services: Arc::new(move |_| {
            let services = services.clone();
            Box::pin(async move { Ok(Some(services)) })
        }),
        now: None,
    });
    Chain {
        fixture,
        permissions,
        guardrails,
        forms,
        decisions,
        group: group.id,
        master,
        member,
    }
}

impl Chain {
    fn input(
        &self,
        kind: c::RequestKind,
        request_id: LosslessString,
        fingerprint: LosslessString,
    ) -> EvaluateInput {
        EvaluateInput {
            group_id: self.group.clone(),
            coordinator_session_id: self.master.clone(),
            target_session_id: self.member.clone(),
            descendant_session_ids: vec![],
            request_id,
            kind,
            fingerprint,
            rationale: "Assigned routine work.".into(),
            confidence: None,
            answer: None,
            decision: None,
        }
    }

    async fn ask(
        &self,
        id: &str,
        action: &str,
        resource: &str,
        metadata: Option<&str>,
    ) -> (
        permission::Id,
        LosslessString,
        tokio::task::JoinHandle<Result<(), PermissionError>>,
    ) {
        let request = permission::Request {
            id: permission::Id::new(id).unwrap(),
            session_id: self.member.clone(),
            action: action.into(),
            resources: vec![resource.into()],
            save: None,
            metadata: metadata.map(|text| match parse_json(text).unwrap() {
                JsonValue::Object(object) => object,
                _ => unreachable!(),
            }),
            source: None,
            escalation: None,
            coordination_escalation: None,
        };
        let id = request.id.clone();
        let waiting = tokio::spawn({
            let permissions = self.permissions.clone();
            async move { permissions.assert(request, None).await }
        });
        until(|| self.permissions.snapshot(&id).is_some()).await;
        let fingerprint = self.permissions.snapshot(&id).unwrap().fingerprint;
        (id, fingerprint, waiting)
    }

    async fn permission(
        &self,
        id: &permission::Id,
        fingerprint: LosslessString,
        decision: Option<Decision>,
    ) -> DecisionResult {
        let mut input = self.input(c::RequestKind::Permission, id_text(id), fingerprint);
        input.decision = decision;
        self.decisions.evaluate(input).await.unwrap()
    }
}

async fn joined(
    waiting: tokio::task::JoinHandle<Result<(), PermissionError>>,
) -> Result<(), PermissionError> {
    tokio::time::timeout(BOUND, waiting).await.unwrap().unwrap()
}

#[tokio::test]
async fn owner_approval_settles_any_member_permission_once_under_manual_permissions() {
    let chain = chain(["manual", "manual", "manual"]).await;
    for (id, resource) in [
        ("per_python", "python script.py"),
        ("per_push", "git push origin main"),
        ("per_curl", "curl -X POST https://example.invalid/hook"),
    ] {
        let (id, fingerprint, waiting) = chain.ask(id, "shell", resource, None).await;
        let result = chain.permission(&id, fingerprint, None).await;
        assert_eq!(
            result.outcome,
            DecisionOutcome::Allowed,
            "{resource}: {result:?}"
        );
        assert!(result.settled, "{resource}");
        assert_eq!(via(&result).as_deref(), Some("coordination"), "{resource}");
        assert!(joined(waiting).await.is_ok(), "{resource}");
        assert!(chain.permissions.snapshot(&id).is_none(), "{resource}");
    }
}

#[tokio::test]
async fn owner_decline_settles_an_explicit_decision_request_under_manual_permissions() {
    let chain = chain(["manual", "manual", "manual"]).await;
    let (id, fingerprint, waiting) = chain
        .ask(
            "per_explicit",
            "edit",
            "src/a.rs",
            Some(r#"{"requireExplicitDecision":true}"#),
        )
        .await;
    let result = chain
        .permission(&id, fingerprint, Some(Decision::Decline))
        .await;
    assert_eq!(result.outcome, DecisionOutcome::Denied, "{result:?}");
    assert!(result.settled);
    assert_eq!(via(&result).as_deref(), Some("coordination"));
    let Err(PermissionError::Corrected(feedback)) = joined(waiting).await else {
        panic!("a coordinator decline is delivered as corrective feedback")
    };
    assert!(
        feedback
            .to_utf8()
            .unwrap()
            .contains("Assigned routine work.")
    );
}

#[tokio::test]
async fn owner_approval_never_overrides_a_deny_rule_current_at_settlement() {
    let chain = chain(["manual", "manual", "manual"]).await;
    let (id, fingerprint, waiting) = chain.ask("per_denied", "shell", "bun test", None).await;
    chain
        .fixture
        .rules
        .lock()
        .unwrap()
        .push(rule("shell", "*", "deny"));
    let result = chain.permission(&id, fingerprint, None).await;
    assert_eq!(result.outcome, DecisionOutcome::Denied, "{result:?}");
    assert!(result.settled);
    assert_eq!(via(&result).as_deref(), Some("permission-rules"));
    assert!(joined(waiting).await.is_err());
}

async fn review(
    chain: &Chain,
) -> (
    LosslessString,
    LosslessString,
    ycoding_core::tools::policy::Wait<
        Result<
            ycoding_core::process::guardrails::Reservation,
            ycoding_core::process::guardrails::Error,
        >,
    >,
) {
    let admission = chain
        .guardrails
        .assert(GuardrailInput {
            session_id: chain.member.clone(),
            action: "shell".into(),
            resources: vec![OUTSIDE.into()],
            metadata: None,
            skip_review: false,
            holder: None,
            source: None,
        })
        .unwrap();
    let request = admission.request.expect("the outside write is reviewed");
    assert!(
        request
            .rule_ids
            .iter()
            .any(|rule| rule.as_str() == Some("standard.review.outside-repo"))
    );
    let fingerprint = chain
        .guardrails
        .request_snapshot(&chain.member, &request.id)
        .unwrap()
        .unwrap()
        .fingerprint;
    (id_text(&request.id), fingerprint, admission.wait.unwrap())
}

#[tokio::test]
async fn owner_settles_an_outside_repository_review_under_manual_guardrails() {
    let chain = chain(["manual", "manual", "manual"]).await;
    let (id, fingerprint, wait) = review(&chain).await;
    let pending = chain
        .decisions
        .pending(PendingInput {
            group_id: chain.group.clone(),
            coordinator_session_id: chain.master.clone(),
            target_session_id: chain.member.clone(),
            descendant_session_ids: vec![],
            limit: None,
        })
        .await
        .unwrap();
    let RequestDetail::Review { delegation, .. } = &pending[0].detail else {
        panic!("the pending item is the review")
    };
    assert_eq!(
        delegation,
        &Delegation::ExplicitDecision("outside-repository".into())
    );
    let result = chain
        .decisions
        .evaluate(chain.input(c::RequestKind::Review, id, fingerprint))
        .await
        .unwrap();
    assert_eq!(result.outcome, DecisionOutcome::Allowed, "{result:?}");
    assert!(result.settled);
    assert_eq!(via(&result).as_deref(), Some("coordination"));
    tokio::time::timeout(BOUND, wait)
        .await
        .unwrap()
        .unwrap()
        .expect("the approved review grants the action")
        .release();
}

#[tokio::test]
async fn owner_decline_settles_a_review_under_manual_guardrails() {
    let chain = chain(["manual", "manual", "manual"]).await;
    let (id, fingerprint, wait) = review(&chain).await;
    let mut input = chain.input(c::RequestKind::Review, id, fingerprint);
    input.decision = Some(Decision::Decline);
    let result = chain.decisions.evaluate(input).await.unwrap();
    assert_eq!(result.outcome, DecisionOutcome::Denied, "{result:?}");
    assert!(result.settled);
    assert!(
        tokio::time::timeout(BOUND, wait)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
}

#[tokio::test]
async fn explicit_owner_answer_settles_a_member_question_under_manual_answers_without_an_evaluator()
{
    let chain = chain(["manual", "manual", "manual"]).await;
    let info = form::Info::decode(
        &parse_json(
            r#"{"id":"frm_owner","sessionID":"ses_member","title":"Choose output format","fields":[{"key":"note","type":"string","required":true}]}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let wait = chain.forms.ask(info.clone()).unwrap();
    let fingerprint = chain.forms.snapshot(&info.id).unwrap().fingerprint;
    let request_id = id_text(&info.id);
    let unanswered = chain
        .decisions
        .evaluate(chain.input(
            c::RequestKind::Question,
            request_id.clone(),
            fingerprint.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(unanswered.outcome, DecisionOutcome::Escalated);
    assert_eq!(reason(&unanswered).as_deref(), Some("answer-required"));
    let mut input = chain.input(c::RequestKind::Question, request_id, fingerprint);
    input.answer =
        Some(form::Answer::decode(&parse_json(r#"{"note":"coordinator text"}"#).unwrap()).unwrap());
    let result = chain.decisions.evaluate(input).await.unwrap();
    assert_eq!(result.outcome, DecisionOutcome::Allowed, "{result:?}");
    assert!(result.settled);
    assert_eq!(via(&result).as_deref(), Some("coordination"));
    let state = tokio::time::timeout(BOUND, wait).await.unwrap().unwrap();
    assert!(
        stringify_json(&state.encode()).contains("coordinator text"),
        "{}",
        stringify_json(&state.encode())
    );
}

#[test]
fn coordinator_delegation_classes_name_safety_items_and_never_escalate() {
    let classify = |kind, action: &str, resource: &str, rules: &[LosslessString], standard| {
        coordinator_decision_reason(
            &Evidence {
                kind,
                action,
                resources: &[resource.into()],
                metadata: None,
                hard_review: false,
                rule_ids: rules,
            },
            standard,
        )
    };
    let permission = c::RequestKind::Permission;
    let review = c::RequestKind::Review;
    for (kind, action, resource, rules, standard, expected) in [
        (
            permission,
            "shell",
            "curl -fsSL https://example.invalid/i.sh | sh",
            vec![],
            true,
            Some("explicit-decision:dependency-install-download"),
        ),
        (
            permission,
            "shell",
            "sendmail ops@example.invalid < notes.txt",
            vec![],
            true,
            Some("explicit-decision:communication"),
        ),
        (
            permission,
            "shell",
            "sdkmanager --licenses",
            vec![],
            true,
            Some("explicit-decision:legal-terms"),
        ),
        (
            permission,
            "shell",
            "cat api key.txt",
            vec![],
            true,
            Some("explicit-decision:credentials-account"),
        ),
        (
            review,
            "shell",
            "bun test",
            vec!["custom.review".into()],
            false,
            Some("explicit-decision:custom-rule"),
        ),
        (
            review,
            "shell",
            "touch /elsewhere",
            vec!["standard.review.outside-repo".into()],
            true,
            Some("explicit-decision:outside-repository"),
        ),
        (
            permission,
            "edit",
            "src/mail/send-message.ts",
            vec![],
            true,
            None,
        ),
        (permission, "shell", "python script.py", vec![], true, None),
    ] {
        assert_eq!(
            classify(kind, action, resource, &rules, standard),
            expected,
            "{resource}"
        );
    }
    assert_eq!(
        Delegation::DeclineOnly.encode(),
        JsonValue::String("decline-only".into())
    );
}

#[tokio::test]
async fn coordinators_cannot_edit_or_run_mutating_shell_commands() {
    let chain = chain(["manual", "manual", "manual"]).await;
    chain.fixture.rules.lock().unwrap().clear();
    chain
        .fixture
        .rules
        .lock()
        .unwrap()
        .push(rule("*", "*", "allow"));
    let assert = |action: &str, resource: &str| {
        let permissions = chain.permissions.clone();
        let request = permission::Request {
            id: permission::Id::new(format!("per_{}", resource.len()).as_str()).unwrap(),
            session_id: chain.master.clone(),
            action: action.into(),
            resources: vec![resource.into()],
            save: None,
            metadata: None,
            source: None,
            escalation: None,
            coordination_escalation: None,
        };
        async move { permissions.assert(request, None).await }
    };
    for (action, resource) in [("edit", "src/a.rs"), ("shell", "rm -f build/out.txt")] {
        let Err(PermissionError::Blocked { coordinator, .. }) = assert(action, resource).await
        else {
            panic!("{action} {resource} is denied to a coordinator")
        };
        assert!(coordinator, "{action} {resource}");
    }
    for command in [
        "git status",
        "ycoding api GET /api/session/ses_member",
        "gh run view 42",
        "! grep -q TODO notes.md",
    ] {
        assert!(assert("shell", command).await.is_ok(), "{command}");
    }
    assert!(
        chain
            .permissions
            .assert(
                permission::Request {
                    id: permission::Id::new("per_member_edit").unwrap(),
                    session_id: chain.member.clone(),
                    action: "edit".into(),
                    resources: vec!["src/a.rs".into()],
                    save: None,
                    metadata: None,
                    source: None,
                    escalation: None,
                    coordination_escalation: None,
                },
                None,
            )
            .await
            .is_ok(),
        "member Sessions keep their edit permissions"
    );
}

#[tokio::test]
async fn a_restart_keeps_projects_active_and_a_user_pause_persists() {
    let fixture = Fixture::default();
    let master = fixture.session_with("ses_master", None, ["manual"; 3], false, None);
    let member = fixture.session_with("ses_member", None, ["manual"; 3], false, None);
    let client = fixture.store.client();
    let service = Service::new(client.clone(), Feed::attach(&client));
    let active = service
        .create(c::CreateInput {
            name: "Active".into(),
            master_session_id: master,
            member_session_ids: vec![member],
        })
        .await
        .unwrap();
    let restarted = Service::new(client.clone(), Feed::attach(&client));
    let group = restarted.get(&active.id).unwrap();
    assert!(group.active);
    assert_eq!(group.paused_reason, None);
    restarted.pause(&active.id).unwrap();
    let again = Service::new(client.clone(), Feed::attach(&client));
    let group = again.get(&active.id).unwrap();
    assert!(!group.active);
    assert_eq!(group.paused_reason, Some(c::PausedReason::Interrupted));
    again.activate(&active.id).unwrap();
    assert!(
        Service::new(client.clone(), Feed::attach(&client))
            .get(&active.id)
            .unwrap()
            .active
    );
}

#[derive(Default)]
struct Waits {
    pending: Mutex<BTreeMap<String, Vec<Pending>>>,
}

impl Waits {
    fn set(&self, target: &str, items: Vec<Pending>) {
        self.pending
            .lock()
            .unwrap()
            .insert(target.to_owned(), items);
    }
}

fn waiting(kind: c::RequestKind, id: &str) -> Pending {
    Pending {
        summary: c::PendingRequest {
            kind,
            request_id: id.into(),
            fingerprint: "fp_wait".into(),
            summary: "Synthetic pending request".into(),
            request_session_id: None,
        },
        detail: RequestDetail::Permission {
            request_id: id.into(),
            fingerprint: "fp_wait".into(),
            action: "shell".into(),
            resources: vec!["bun test".into()],
            delegation: Delegation::Routine,
            coordination_escalation: None,
            request_session_id: None,
        },
    }
}

struct Fake(Arc<Waits>);
impl Decisions for Fake {
    fn settings(&self) -> Future<'_, c::Settings> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
    fn pending(&self, input: PendingInput) -> Future<'_, Vec<Pending>> {
        let items = self
            .0
            .pending
            .lock()
            .unwrap()
            .get(input.target_session_id.as_lossless().as_str().unwrap())
            .cloned()
            .unwrap_or_default();
        Box::pin(async move { Ok(items) })
    }
    fn evaluate(&self, _input: EvaluateInput) -> Future<'_, DecisionResult> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
    fn escalate(&self, input: DecisionEscalateInput) -> Future<'_, DecisionEscalateResult> {
        Box::pin(async move {
            Ok(DecisionEscalateResult {
                outcome: EscalateOutcome::Escalated,
                kind: input.kind,
                request_id: input.request_id,
                fingerprint: input.fingerprint,
                actor: DecisionActor::Coordinator,
                settled: false,
                to: Some(EscalationTarget::Client),
                coordination_escalation: None,
                reason: None,
                review_item_id: None,
                request_session_id: None,
            })
        })
    }
}

struct Park;
impl Runner for Park {
    fn drain(&self, _request: DrainRequest) -> RunFuture {
        Box::pin(async {
            std::future::pending::<()>().await;
            Ok(())
        })
    }
}

struct Counted(Arc<AtomicUsize>);
impl Locations for Counted {
    fn get(
        &self,
        _session: &ycoding_schema::session::Info,
    ) -> Result<Arc<dyn Runner>, ycoding_core::session::run_coordinator::Error> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(Park))
    }
}

fn task(session_id: &str, parent_id: &str, state: &str) -> Task {
    Task {
        session_id: session_id.into(),
        parent_id: parent_id.into(),
        parent_assistant_message_id: "msg_parent".into(),
        tool_call_id: format!("call_{session_id}").as_str().into(),
        input_id: format!("msg_input_{session_id}").as_str().into(),
        description: "Work".into(),
        agent: "test".into(),
        model: Document::new(parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap()).unwrap(),
        prompt_digest: "0".repeat(64).as_str().into(),
        background: 1,
        delivery: "steer".into(),
        state: state.into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        usage_anchor: None,
        attempt_started: 0,
        owner_pid: None,
        owner_started: None,
        revision: 1,
        time_created: 1,
        time_updated: 1,
    }
}

fn put(store: &ycoding_store::Store, row: Task) {
    store
        .submit(move |tx| TaskTable::put(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
}

fn send(id: &str, text: &str, delivery: Delivery, message: Option<&str>) -> SendInput {
    SendInput {
        session_id: sid(id),
        text: text.into(),
        delivery: Some(delivery),
        message_id: message.map(|id| session_message::Id::new(id).unwrap()),
        model: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_member_waiting_on_a_pending_request_refuses_project_input_and_the_master_learns_where_the_user_answers()
 {
    let fixture = Fixture::default();
    let master = fixture.session_with("ses_master", None, ["manual"; 3], false, None);
    let alpha = fixture.session_with("ses_alpha", None, ["manual"; 3], false, None);
    let owner = fixture.session_with("ses_owner", Some("ses_master"), ["manual"; 3], false, None);
    put(&fixture.store, task("ses_owner", "ses_master", "running"));
    let client = fixture.store.client();
    let coordination = Service::new(client.clone(), Feed::attach(&client));
    let group = coordination
        .create(c::CreateInput {
            name: "Waiting".into(),
            master_session_id: master.clone(),
            member_session_ids: vec![alpha.clone()],
        })
        .await
        .unwrap();
    coordination.activate(&group.id).unwrap();
    let sessions = SessionStore::new(client.clone());
    let jobs = job::Jobs::new();
    let wakes = Arc::new(AtomicUsize::new(0));
    let execution = SessionExecution::install(
        sessions.clone(),
        Arc::new(Counted(wakes.clone())),
        jobs.clone(),
        None,
    )
    .unwrap();
    let waits = Arc::new(Waits::default());
    let runtime = Runtime::new(Options {
        coordination,
        sessions: sessions.clone(),
        execution,
        decisions: Arc::new(Fake(waits.clone())),
        jobs,
        validate_model: Arc::new(|_, _| Box::pin(async { Ok(()) })),
        model_services: Arc::new(|_| {
            Box::pin(async {
                Err(coordination::Error::refused(
                    "model switching is outside this owner chain fixture",
                ))
            })
        }),
        creator: None,
    });
    runtime
        .assign(
            &master,
            coordination::runtime::AssignInput {
                session_id: alpha.clone(),
                owner_session_id: owner.clone(),
            },
        )
        .await
        .unwrap();
    let admitted = || sessions.pending_list(&alpha).unwrap().len();

    let first = runtime
        .send(
            &master,
            send("ses_alpha", "Once", Delivery::Queue, Some("msg_once")),
        )
        .await
        .unwrap();
    assert!(!first.reconciled);
    assert_eq!(admitted(), 1);
    until(|| wakes.load(Ordering::SeqCst) > 0).await;
    let woken = wakes.load(Ordering::SeqCst);

    for (kind, id, label) in [
        (c::RequestKind::Question, "frm_wait", "question frm_wait"),
        (
            c::RequestKind::Permission,
            "per_wait",
            "permission per_wait",
        ),
        (c::RequestKind::Review, "grq_wait", "review grq_wait"),
    ] {
        waits.set("ses_alpha", vec![waiting(kind, id)]);
        for caller in [&master, &owner] {
            for delivery in [Delivery::Steer, Delivery::Queue] {
                let refused = runtime
                    .send(caller, send("ses_alpha", "Status?", delivery, None))
                    .await
                    .unwrap_err()
                    .to_string();
                for text in [label, "answer", "escalate", "interrupt"] {
                    assert!(refused.contains(text), "{refused}");
                }
            }
        }
    }
    let reconciled = runtime
        .send(
            &master,
            send("ses_alpha", "Once", Delivery::Queue, Some("msg_once")),
        )
        .await
        .unwrap();
    assert!(reconciled.reconciled);
    assert_eq!(admitted(), 1, "refused sends admit nothing");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        wakes.load(Ordering::SeqCst),
        woken,
        "refused sends wake nothing"
    );

    let project = Project {
        runtime: Arc::new(OnceLock::from(runtime.clone())),
    };
    let escalated = project
        .settle(
            parse_json(
                r#"{"action":"escalate","sessionID":"ses_alpha","requestID":"frm_wait","kind":"question","fingerprint":"fp_wait","reason":"Needs the user"}"#,
            )
            .unwrap(),
            Context::new("ses_master", "test", "msg_master", "call_escalate").unwrap(),
        )
        .await
        .unwrap();
    let text = stringify_json(&escalated.structured);
    assert!(text.contains("stays open as the member's prompt"), "{text}");
    assert!(
        text.contains("answers it in member Session ses_alpha (authority)"),
        "{text}"
    );
    assert!(
        text.contains("messages or answers relayed through the Master cannot settle it"),
        "{text}"
    );
    waits.set("ses_alpha", vec![]);
    let later = runtime
        .send(&owner, send("ses_alpha", "Twice", Delivery::Queue, None))
        .await
        .unwrap();
    assert!(!later.reconciled);
    assert_eq!(admitted(), 2);
}

#[derive(Default)]
struct Wakes(Mutex<Vec<String>>);
impl OrchestrationExecution for Wakes {
    fn wake(&self, id: &session::Id) -> Outcome {
        self.0
            .lock()
            .unwrap()
            .push(id.as_lossless().to_utf8().unwrap());
        Ok(())
    }
    fn resume(&self, _: &session::Id) -> RunFuture {
        panic!("unexpected explicit resumption")
    }
    fn interrupt(&self, _: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

fn notifier(kind: &str) -> (ycoding_store::Store, Orchestration, Arc<Wakes>) {
    let store = support::store();
    let kind = kind.to_owned();
    store
        .submit(move |tx| {
            for (id, parent) in [("ses_child", "ses_one"), ("ses_grand", "ses_child")] {
                let mut row = support::record(id);
                row.parent_id = Some(parent.into());
                SessionTable::insert(tx, &row)?;
            }
            TaskTable::put(tx, &task("ses_child", "ses_one", "completed"))?;
            TaskTable::put(tx, &task("ses_grand", "ses_child", "completed"))?;
            NotificationTable::insert(
                tx,
                &Notification {
                    id: "ntf_grand".into(),
                    task_session_id: "ses_grand".into(),
                    parent_id: "ses_child".into(),
                    type_: kind.as_str().into(),
                    revision: 1,
                    excerpt: Some("Grandchild result".into()),
                    delivered: 0,
                    time_created: 1,
                    time_delivered: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let wakes = Arc::new(Wakes::default());
    let service = Orchestration::new(SessionStore::new(store.client()), wakes.clone());
    (store, service, wakes)
}

fn task_state(store: &ycoding_store::Store, id: &str) -> String {
    store
        .snapshot()
        .unwrap()
        .get::<TaskTable>(&tuple_key(&[KeyPart::String(&id.into())]))
        .unwrap()
        .unwrap()
        .state
        .to_utf8()
        .unwrap()
}

#[tokio::test]
async fn a_completed_coordinator_wakes_and_revives_for_its_subagent_notification() {
    let (store, service, wakes) = notifier("completed");
    assert_eq!(service.dispatch_notifications().await.unwrap(), 1);
    assert_eq!(task_state(&store, "ses_child"), "running");
    assert!(wakes.0.lock().unwrap().contains(&"ses_child".to_owned()));
}

#[tokio::test]
async fn handback_text_reaches_the_parent_without_waking_it() {
    let (store, service, wakes) = notifier("handback");
    assert_eq!(service.dispatch_notifications().await.unwrap(), 1);
    assert_eq!(task_state(&store, "ses_child"), "completed");
    assert!(wakes.0.lock().unwrap().is_empty());
    assert_eq!(
        SessionStore::new(store.client())
            .pending_list(&sid("ses_child"))
            .unwrap()
            .len(),
        1
    );
}
