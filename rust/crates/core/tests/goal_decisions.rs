include!("policy_fixture.rs");

use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use ycoding_core::{
    coordination::{
        decision_context,
        decisions::{Gate, Reconsider, Settings, Source},
        runtime::Future as CoordinationFuture,
    },
    event_feed::{Data, Ephemeral, Feed, Payload},
    process::guardrails::decision::{EvaluateFuture, Evaluator},
    resources::decision,
    session::{
        autonomy::{self, DecisionChange, DecisionMode},
        goal_decisions::{
            AuthorityProof, BoxFuture, Execution, GoalDecisions, HANDLED_EVENTS, Located, Options,
            ProofFuture, Synthesize,
        },
        orchestration,
        run_coordinator::{
            self, Coordinator, Drain, DrainRequest, InterruptReason, Outcome, RunFuture,
        },
        store,
    },
    tools::policy::questions::{Admission, Questions},
};
use ycoding_schema::{
    DomainDecode, JsonValue, coordination as c, domain, parse_json, question, session,
};
use ycoding_store::{
    KeyPart, Write,
    session::{Document, SessionTable, TaskTable},
    tuple_key,
};

const FAST: &str = r#"[{"label":"Fast (Recommended)","description":"Use the fast path"},{"label":"Slow","description":"Use the slow path"}]"#;
const PLAIN: &str = r#"[{"label":"Fast","description":"Use the fast path"},{"label":"Slow","description":"Use the slow path"}]"#;

struct Observe {
    coordinator: Arc<OnceLock<Coordinator>>,
    seen: Arc<Mutex<Vec<bool>>>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    runs: AtomicUsize,
    wake_after_first: bool,
    block_second: bool,
    fail: bool,
    panic: bool,
    block_after: bool,
}

impl Observe {
    fn new() -> Self {
        Self {
            coordinator: Arc::new(OnceLock::new()),
            seen: Arc::default(),
            entered: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
            runs: AtomicUsize::new(0),
            wake_after_first: false,
            block_second: false,
            fail: false,
            panic: false,
            block_after: true,
        }
    }
}

impl Drain for Observe {
    fn drain(&self, _request: DrainRequest) -> RunFuture {
        let run = self.runs.fetch_add(1, Ordering::SeqCst);
        let fail = self.fail;
        let block = self.block_second && run > 0;
        let release = self.release.clone();
        Box::pin(async move {
            if block {
                release.notified().await;
            }
            if fail {
                return Err(run_coordinator::Error::Closed);
            }
            Ok(())
        })
    }

    fn settled(&self, id: session::Id, _outcome: Outcome) -> RunFuture {
        let wake = self.wake_after_first && self.runs.load(Ordering::SeqCst) == 1;
        let coordinator = self.coordinator.clone();
        Box::pin(async move {
            if wake {
                coordinator.get().unwrap().wake(&id)?;
            }
            Ok(())
        })
    }

    fn after_settled(&self, id: session::Id) -> RunFuture {
        let coordinator = self.coordinator.clone();
        let seen = self.seen.clone();
        let entered = self.entered.clone();
        let release = self.release.clone();
        let panic = self.panic;
        let block = self.block_after;
        Box::pin(async move {
            if panic {
                panic!("post-settlement observation failed");
            }
            let active = coordinator.get().unwrap().active().contains(&id);
            seen.lock().unwrap().push(active);
            entered.notify_one();
            if block {
                release.notified().await;
            }
            Ok(())
        })
    }
}

fn observed(drain: Observe) -> (Coordinator, Arc<Observe>) {
    let drain = Arc::new(drain);
    let coordinator = Coordinator::new(drain.clone());
    drain.coordinator.set(coordinator.clone()).ok().unwrap();
    (coordinator, drain)
}

fn execution_id() -> session::Id {
    session::Id::new("ses_status").unwrap()
}

#[tokio::test]
async fn post_settlement_observation_runs_after_cleanup_without_delaying_the_result() {
    let (coordinator, drain) = observed(Observe::new());
    let id = execution_id();
    tokio::time::timeout(Duration::from_secs(2), coordinator.run(&id))
        .await
        .expect("the original result is not delayed by the observation")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), drain.entered.notified())
        .await
        .unwrap();
    assert_eq!(*drain.seen.lock().unwrap(), vec![false]);
    drain.release.notify_one();
    coordinator.await_idle(&id).await;
    assert!(coordinator.active().is_empty());
}

#[tokio::test]
async fn post_settlement_observation_sees_a_late_wake_successor_as_active() {
    let mut observe = Observe::new();
    observe.wake_after_first = true;
    observe.block_second = true;
    let (coordinator, drain) = observed(observe);
    let id = execution_id();
    coordinator.run(&id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), drain.entered.notified())
        .await
        .unwrap();
    assert_eq!(*drain.seen.lock().unwrap(), vec![true]);
    drain.release.notify_one();
    drain.release.notify_one();
    coordinator.await_idle(&id).await;
}

#[tokio::test]
async fn post_settlement_observation_runs_once_for_failure_and_interruption() {
    let mut failing = Observe::new();
    failing.fail = true;
    failing.block_after = false;
    let (coordinator, drain) = observed(failing);
    let id = execution_id();
    assert!(coordinator.run(&id).await.is_err());
    coordinator.await_idle(&id).await;
    tokio::time::timeout(Duration::from_secs(2), drain.entered.notified())
        .await
        .unwrap();
    assert_eq!(*drain.seen.lock().unwrap(), vec![false]);

    let mut blocked = Observe::new();
    blocked.block_second = true;
    blocked.runs.store(1, Ordering::SeqCst);
    blocked.block_after = false;
    let (coordinator, drain) = observed(blocked);
    let waiting = {
        let coordinator = coordinator.clone();
        let id = id.clone();
        tokio::spawn(async move { coordinator.run(&id).await })
    };
    while coordinator.active().is_empty() {
        tokio::task::yield_now().await;
    }
    coordinator
        .interrupt(&id, InterruptReason::User)
        .await
        .unwrap();
    assert!(waiting.await.unwrap().is_err());
    coordinator.await_idle(&id).await;
    tokio::time::timeout(Duration::from_secs(2), drain.entered.notified())
        .await
        .unwrap();
    assert_eq!(*drain.seen.lock().unwrap(), vec![false]);
}

#[tokio::test]
async fn post_settlement_observation_defect_cannot_change_the_execution_result() {
    let mut observe = Observe::new();
    observe.panic = true;
    let (coordinator, _drain) = observed(observe);
    let id = execution_id();
    coordinator.run(&id).await.unwrap();
    coordinator.await_idle(&id).await;
    assert!(coordinator.active().is_empty());
}

#[test]
fn handled_events_are_the_decision_surface_and_exclude_receipts_and_execution_noise() {
    for required in [
        "permission.asked",
        "permission.replied",
        "permission.deferred",
        "guardrail.asked",
        "guardrail.replied",
        "guardrail.deferred",
        "session.guardrail.decided.1",
        "form.created",
        "form.replied",
        "form.cancelled",
        "form.timed_out",
        "form.deferred",
        "question.asked",
        "question.replied",
        "question.rejected",
        "question.timed_out",
        "question.deferred",
        "session.review.deferred.1",
        "session.review.decided.1",
        "session.review.withdrawn.1",
        "session.task.updated.1",
    ] {
        assert!(HANDLED_EVENTS.contains(&required), "{required}");
    }
    for forbidden in [
        "session.input.admitted.1",
        "session.execution.started.1",
        "session.execution.succeeded.1",
        "session.guardrail.dismissed.1",
        "permission.cancelled",
        "session.status",
    ] {
        assert!(!HANDLED_EVENTS.contains(&forbidden), "{forbidden}");
    }
}

struct Wakes {
    active: Mutex<Vec<session::Id>>,
    wakes: Mutex<Vec<session::Id>>,
}

impl Execution for Wakes {
    fn active(&self) -> Vec<session::Id> {
        self.active.lock().unwrap().clone()
    }

    fn wake(&self, id: &session::Id) -> Result<(), String> {
        self.wakes.lock().unwrap().push(id.clone());
        Ok(())
    }
}

struct Idle;

impl orchestration::Execution for Idle {
    fn wake(&self, _id: &session::Id) -> Outcome {
        Ok(())
    }

    fn resume(&self, _id: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }

    fn interrupt(&self, _id: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Default)]
struct Synth(AtomicUsize);

impl Synthesize for Synth {
    fn synthesize(
        &self,
        _owner: &session::Id,
        _prompt: String,
    ) -> BoxFuture<'_, Result<String, String>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err("refused".to_owned()) })
    }
}

fn explicit(session: &session::Id, id: &str) -> question::Request {
    question::Request::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":"{}","questions":[{{"header":"Plan","question":"Approve the purchase of the paid plan?","options":{FAST}}}]}}"#,
            session.as_lossless().as_str().unwrap()
        ))
        .unwrap(),
    )
    .unwrap()
}

struct Proof(bool);

impl AuthorityProof for Proof {
    fn authority_digest(&self, _session: &session::Id) -> ProofFuture<'_> {
        let proved = self.0;
        Box::pin(async move {
            if proved {
                Ok("proof".to_owned())
            } else {
                Err(decision_context::Error::Store(
                    ycoding_store::Error::Rejected("context unavailable"),
                ))
            }
        })
    }
}

struct Harness {
    fixture: Fixture,
    autonomy: autonomy::Service,
    questions: Questions,
    execution: Arc<Wakes>,
    enabled: Arc<AtomicBool>,
    synth: Arc<Synth>,
}

impl Harness {
    fn new() -> Self {
        let fixture = Fixture::default();
        let autonomy = autonomy::Service::new(fixture.store.client());
        let questions = Questions::new(fixture.authority(), fixture.publisher());
        Self {
            fixture,
            autonomy,
            questions,
            execution: Arc::new(Wakes {
                active: Mutex::default(),
                wakes: Mutex::default(),
            }),
            enabled: Arc::new(AtomicBool::new(true)),
            synth: Arc::default(),
        }
    }

    fn goals(&self, proved: bool) -> GoalDecisions {
        GoalDecisions::new(self.goals_options_with(proved))
    }

    fn goals_options_with(&self, proved: bool) -> Options {
        let enabled = self.enabled.clone();
        let settings: Settings = Arc::new(move || -> CoordinationFuture<'static, c::Settings> {
            let enabled = enabled.load(Ordering::SeqCst);
            Box::pin(async move {
                Ok(c::Settings {
                    enabled,
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
        });
        let locate = locate_with(self.questions.clone(), Arc::new(|| true));
        let client = self.fixture.store.client();
        Options {
            client: client.clone(),
            autonomy: self.autonomy.clone(),
            execution: self.execution.clone(),
            orchestration: orchestration::Service::new(store::Service::new(client), Arc::new(Idle)),
            settings,
            locate,
            proof: Arc::new(Proof(proved)),
            synthesize: self.synth.clone(),
            now: None,
        }
    }

    fn owner(&self, name: &str, goal: bool, answers: &str) -> session::Id {
        self.fixture
            .session_with(name, None, ["manual", "manual", answers], goal, None)
    }

    fn ask(&self, session: &session::Id, id: &str, options: &str) -> impl Future<Output = ()> {
        let admission = self.questions.ask(question(session, id, options)).unwrap();
        let Admission::Pending(wait) = admission else {
            panic!("a manual answers mode must leave the question pending");
        };
        async move {
            let _ = wait.await;
        }
    }

    fn judged_by(self, judge: &Arc<Judge>) -> Self {
        let _ = self.questions.clone().with_decision(judge.clone());
        self
    }

    fn ask_request(&self, request: question::Request) -> impl Future<Output = ()> {
        let Admission::Pending(wait) = self.questions.ask(request).unwrap() else {
            panic!("a manual answers mode must leave the question pending");
        };
        async move {
            let _ = wait.await;
        }
    }

    async fn answers(&self, session: &session::Id, mode: DecisionMode) {
        self.autonomy
            .set_decisions(
                session,
                DecisionChange::new(None, None, Some(mode)).unwrap(),
            )
            .await
            .unwrap();
    }

    fn outcomes(&self, owner: &session::Id) -> Vec<String> {
        store::Service::new(self.fixture.store.client())
            .pending_list(owner)
            .unwrap()
            .into_iter()
            .filter_map(|pending| {
                let receipt = field(field(&pending.data, "metadata")?, "goalDecision")?;
                let outcome = text(field(receipt, "outcome")?);
                Some(match field(receipt, "reason") {
                    Some(reason) => format!("{outcome}:{}", text(reason)),
                    None => outcome,
                })
            })
            .collect()
    }
}

struct Judge {
    replies: Mutex<VecDeque<Result<JsonValue, decision::Error>>>,
    seen: Mutex<Vec<JsonValue>>,
}

impl Judge {
    fn new(replies: Vec<Result<JsonValue, decision::Error>>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            seen: Mutex::default(),
        })
    }

    fn calls(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

impl Evaluator for Judge {
    fn evaluate<'a>(&'a self, input: JsonValue, _: decision::Invocation<'a>) -> EvaluateFuture<'a> {
        self.seen.lock().unwrap().push(input);
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected helper call");
        Box::pin(async move { reply })
    }
}

fn judged(answers: &str) -> Result<JsonValue, decision::Error> {
    Ok(parse_json(&format!(
        r#"{{"provider":"agent","response":{{"model":{{"providerID":"local","id":"judge"}},"semantics":"model-estimate","version":1,"answers":[{answers}]}}}}"#
    ))
    .unwrap())
}

fn chosen(name: &str, value: &str, confidence: f64) -> Result<JsonValue, decision::Error> {
    judged(&format!(
        r#"{{"name":"{name}","type":"choice","answer":null,"choice":"{value}","score":null,"confidence":{confidence}}}"#
    ))
}

fn refused(name: &str) -> Result<JsonValue, decision::Error> {
    judged(&format!(
        r#"{{"name":"{name}","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}}"#
    ))
}

fn closed(session: &session::Id, id: &str, questions: &[&str]) -> question::Request {
    let questions = questions
        .iter()
        .map(|options| {
            format!(
                r#"{{"header":"Plan","question":"Which plan?","options":{options},"custom":false}}"#
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    question::Request::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":"{}","questions":[{questions}]}}"#,
            session.as_lossless().as_str().unwrap()
        ))
        .unwrap(),
    )
    .unwrap()
}

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}

fn text(value: &JsonValue) -> String {
    match value {
        JsonValue::String(text) => text.as_str().unwrap().to_owned(),
        other => panic!("expected text, found {other:?}"),
    }
}

fn question(session: &session::Id, id: &str, options: &str) -> question::Request {
    question::Request::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","sessionID":"{}","questions":[{{"header":"Plan","question":"Which plan?","options":{options}}}]}}"#,
            session.as_lossless().as_str().unwrap()
        ))
        .unwrap(),
    )
    .unwrap()
}

fn que(id: &str) -> question::Id {
    question::Id::decode(&JsonValue::String(id.into())).unwrap()
}

fn replied(session: &session::Id, id: &str, rejected: bool) -> Payload {
    let session_id = session.clone();
    let request_id = que(id);
    Payload::Ephemeral(Ephemeral {
        id: format!("evt_{id}").into(),
        created: 1,
        session: Some(session.clone()),
        location: None,
        metadata: None,
        data: if rejected {
            Data::QuestionRejected(Box::new(question::RejectedData {
                session_id,
                request_id,
            }))
        } else {
            Data::QuestionReplied(Box::new(question::RepliedData {
                session_id,
                request_id,
                answers: vec![vec!["Fast".into()]],
            }))
        },
    })
}

#[tokio::test]
async fn authority_proof_failure_fails_closed_and_never_settles() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let _wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    let goals = harness.goals(false);
    goals.inspect(&owner).await;
    goals.inspect(&owner).await;
    assert_eq!(harness.questions.list().len(), 1);
    assert_eq!(
        harness.outcomes(&owner),
        vec!["waiting:authority-unavailable"]
    );
    assert!(harness.execution.wakes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn auto_answers_settle_a_unique_recommended_question_without_waking_the_owner() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    let goals = harness.goals(true);
    goals.inspect(&owner).await;
    tokio::time::timeout(Duration::from_secs(2), wait)
        .await
        .unwrap();
    assert!(harness.questions.list().is_empty());
    assert_eq!(harness.outcomes(&owner), vec!["settled:allowed"]);
    assert!(harness.execution.wakes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn manual_answers_wait_once_for_an_explicit_decision_question() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let _wait = harness.ask_request(explicit(&owner, "que_plan"));
    let goals = harness.goals(true);
    goals.inspect(&owner).await;
    goals.inspect(&owner).await;
    assert_eq!(harness.questions.list().len(), 1);
    assert_eq!(
        harness.outcomes(&owner),
        vec!["waiting:explicit-decision:purchase-spend"]
    );
}

#[tokio::test]
async fn explicit_decision_questions_and_missing_recommendations_stay_with_the_human() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let _first = harness.ask(&owner, "que_plain", PLAIN);
    harness.answers(&owner, DecisionMode::Auto).await;
    let goals = harness.goals(true);
    goals.inspect(&owner).await;
    assert_eq!(harness.questions.list().len(), 1);
    assert_eq!(harness.outcomes(&owner), vec!["waiting:refused"]);

    let other = harness.owner("ses_purchase", true, "manual");
    let request = question::Request::decode(
        &parse_json(
            r#"{"id":"que_buy","sessionID":"ses_purchase","questions":[{"header":"Billing","question":"Approve purchase of a license?","options":[{"label":"Yes (Recommended)","description":"Buy"}]}]}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let Admission::Pending(_wait) = harness.questions.ask(request).unwrap() else {
        panic!("manual answers leave the question pending");
    };
    harness.answers(&other, DecisionMode::Auto).await;
    goals.inspect(&other).await;
    assert_eq!(harness.questions.list().len(), 2);
    assert_eq!(
        harness.outcomes(&other),
        vec!["waiting:explicit-decision:purchase-spend"]
    );
}

#[tokio::test]
async fn a_revoked_delegation_policy_waits_for_a_human() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let _wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    harness.enabled.store(false, Ordering::SeqCst);
    harness.goals(true).inspect(&owner).await;
    assert_eq!(harness.questions.list().len(), 1);
    assert_eq!(harness.outcomes(&owner), vec!["waiting:delegation-revoked"]);
}

#[tokio::test]
async fn sessions_without_an_active_goal_are_never_inspected() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", false, "manual");
    let _wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    let goals = harness.goals(true);
    goals.inspect(&owner).await;
    goals.reconcile(&owner).await;
    assert_eq!(harness.questions.list().len(), 1);
    assert!(harness.outcomes(&owner).is_empty());
}

#[tokio::test]
async fn a_request_belongs_only_to_its_nearest_goal_owner() {
    let harness = Harness::new();
    let parent = harness.owner("ses_parent", true, "manual");
    let child = harness.fixture.session_with(
        "ses_child",
        Some("ses_parent"),
        ["manual", "manual", "manual"],
        true,
        None,
    );
    let wait = harness.ask(&child, "que_plan", FAST);
    harness.answers(&parent, DecisionMode::Auto).await;
    harness.answers(&child, DecisionMode::Auto).await;
    let goals = harness.goals(true);
    goals.inspect(&parent).await;
    assert_eq!(harness.questions.list().len(), 1);
    assert!(harness.outcomes(&parent).is_empty());
    assert!(harness.outcomes(&child).is_empty());
    goals.inspect(&child).await;
    tokio::time::timeout(Duration::from_secs(2), wait)
        .await
        .unwrap();
    assert_eq!(harness.outcomes(&child), vec!["settled:allowed"]);
    assert!(harness.outcomes(&parent).is_empty());
}

#[tokio::test]
async fn a_waiting_receipt_survives_a_new_loop_instance_without_a_duplicate() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let _wait = harness.ask(&owner, "que_plain", PLAIN);
    harness.answers(&owner, DecisionMode::Auto).await;
    harness.goals(true).inspect(&owner).await;
    harness.goals(true).inspect(&owner).await;
    assert_eq!(harness.questions.list().len(), 1);
    assert_eq!(harness.outcomes(&owner), vec!["waiting:refused"]);
    assert_eq!(harness.synth.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_native_answer_resumes_the_owner_exactly_once() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let wait = harness.ask_request(explicit(&owner, "que_plan"));
    let goals = harness.goals(true);
    goals.inspect(&owner).await;
    assert_eq!(
        harness.outcomes(&owner),
        vec!["waiting:explicit-decision:purchase-spend"]
    );
    let id = que("que_plan");
    harness
        .questions
        .reply(&id, vec![vec!["Fast (Recommended)".into()]])
        .unwrap();
    wait.await;
    let event = replied(&owner, "que_plan", false);
    goals.handle(&event).await;
    goals.handle(&event).await;
    assert_eq!(
        *harness.execution.wakes.lock().unwrap(),
        vec![owner.clone()]
    );
    assert_eq!(
        harness.outcomes(&owner),
        vec!["waiting:explicit-decision:purchase-spend", "resumed"]
    );
}

#[tokio::test]
async fn a_question_rejection_never_resumes_the_owner() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let wait = harness.ask_request(explicit(&owner, "que_plan"));
    let goals = harness.goals(true);
    goals.inspect(&owner).await;
    harness.questions.reject(&que("que_plan")).unwrap();
    wait.await;
    goals.handle(&replied(&owner, "que_plan", true)).await;
    assert!(harness.execution.wakes.lock().unwrap().is_empty());
    assert_eq!(
        harness.outcomes(&owner),
        vec!["waiting:explicit-decision:purchase-spend"]
    );
}

#[tokio::test]
async fn a_running_owner_records_the_resume_without_a_second_wake() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let wait = harness.ask_request(explicit(&owner, "que_plan"));
    let goals = harness.goals(true);
    goals.inspect(&owner).await;
    harness.execution.active.lock().unwrap().push(owner.clone());
    harness
        .questions
        .reply(&que("que_plan"), vec![vec!["Fast (Recommended)".into()]])
        .unwrap();
    wait.await;
    let event = replied(&owner, "que_plan", false);
    goals.handle(&event).await;
    harness.execution.active.lock().unwrap().clear();
    goals.handle(&event).await;
    assert!(harness.execution.wakes.lock().unwrap().is_empty());
    assert_eq!(harness.outcomes(&owner).len(), 2);
}

#[tokio::test]
async fn a_stopped_goal_does_not_resume_the_owner() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let wait = harness.ask_request(explicit(&owner, "que_plan"));
    let goals = harness.goals(true);
    goals.inspect(&owner).await;
    harness.autonomy.stop(&owner).await.unwrap();
    harness
        .questions
        .reply(&que("que_plan"), vec![vec!["Fast (Recommended)".into()]])
        .unwrap();
    wait.await;
    goals.handle(&replied(&owner, "que_plan", false)).await;
    assert!(harness.execution.wakes.lock().unwrap().is_empty());
    assert_eq!(
        harness.outcomes(&owner),
        vec!["waiting:explicit-decision:purchase-spend"]
    );
}

fn gate(
    validate: impl Fn(question::Request) -> Pin<Box<dyn Future<Output = bool> + Send>>
    + Send
    + Sync
    + 'static,
) -> Gate<question::Request> {
    Gate {
        validate: Arc::new(validate),
        current: Arc::new(|| true),
    }
}

fn open_gate() -> Gate<question::Request> {
    gate(|_| Box::pin(async { true }))
}

fn input(
    questions: &Questions,
    session: &session::Id,
    gate: Gate<question::Request>,
) -> Reconsider<question::Request> {
    let snapshot = questions.snapshots(session, 8).remove(0);
    Reconsider {
        fingerprint: snapshot.fingerprint,
        source: Source {
            coordinator_session_id: session.clone(),
            group_id: None,
            rationale: "The goal loop re-applied the current policy.".into(),
        },
        decision: None,
        answer: None,
        confidence: None,
        gate,
    }
}

fn reason(result: &ycoding_core::coordination::decisions::Reconsidered) -> Option<String> {
    result
        .reason
        .as_ref()
        .map(|reason| reason.as_str().unwrap().to_owned())
}

#[tokio::test]
async fn question_reconsider_settles_a_unique_recommendation_only_under_auto() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", false, "manual");
    let wait = harness.ask(&owner, "que_plan", FAST);
    let id = que("que_plan");
    let manual = harness
        .questions
        .reconsider(&id, input(&harness.questions, &owner, open_gate()))
        .await
        .unwrap();
    assert!(!manual.settled);
    assert_eq!(
        reason(&manual).as_deref(),
        Some("explicit-decision:manual-answers")
    );
    assert_eq!(harness.questions.list().len(), 1);
    harness.answers(&owner, DecisionMode::Auto).await;
    let auto = harness
        .questions
        .reconsider(&id, input(&harness.questions, &owner, open_gate()))
        .await
        .unwrap();
    assert!(auto.settled);
    assert_eq!(auto.via, Some("auto-answer"));
    wait.await;
    assert!(harness.questions.list().is_empty());
}

#[tokio::test]
async fn question_reconsider_keeps_free_text_and_unmarked_options_pending_under_auto() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", false, "manual");
    let _free = harness.ask(&owner, "que_free", "[]");
    harness.answers(&owner, DecisionMode::Auto).await;
    let free = harness
        .questions
        .reconsider(
            &que("que_free"),
            input(&harness.questions, &owner, open_gate()),
        )
        .await
        .unwrap();
    assert_eq!(reason(&free).as_deref(), Some("free_text"));
    let other = harness.owner("ses_plain", false, "manual");
    let _plain = harness.ask(&other, "que_plain", PLAIN);
    harness.answers(&other, DecisionMode::Auto).await;
    let plain = harness
        .questions
        .reconsider(
            &que("que_plain"),
            input(&harness.questions, &other, open_gate()),
        )
        .await
        .unwrap();
    assert_eq!(reason(&plain).as_deref(), Some("disabled"));
    assert_eq!(harness.questions.list().len(), 2);
}

#[tokio::test]
async fn question_reconsider_rejects_stale_fingerprints_and_invalid_delegation() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", false, "manual");
    let _wait = harness.ask_pending(&owner, "que_plan");
    harness.answers(&owner, DecisionMode::Auto).await;
    let id = que("que_plan");
    let mut stale = input(&harness.questions, &owner, open_gate());
    stale.fingerprint = "stale".into();
    let result = harness.questions.reconsider(&id, stale).await.unwrap();
    assert!(!result.settled);
    assert!(reason(&result).is_none());
    let denied = harness
        .questions
        .reconsider(
            &id,
            input(
                &harness.questions,
                &owner,
                gate(|_| Box::pin(async { false })),
            ),
        )
        .await
        .unwrap();
    assert_eq!(reason(&denied).as_deref(), Some("delegation-invalid"));
    assert_eq!(harness.questions.list().len(), 1);
}

#[tokio::test]
async fn question_reconsider_fences_an_autonomy_change_before_the_commit() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", false, "manual");
    let _wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let autonomy = harness.autonomy.clone();
    let target = owner.clone();
    let counted = calls.clone();
    let flip = gate(move |_| {
        let autonomy = autonomy.clone();
        let target = target.clone();
        let call = counted.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if call == 1 {
                autonomy
                    .set_decisions(
                        &target,
                        DecisionChange::new(None, None, Some(DecisionMode::Manual)).unwrap(),
                    )
                    .await
                    .unwrap();
            }
            true
        })
    });
    let result = harness
        .questions
        .reconsider(&que("que_plan"), input(&harness.questions, &owner, flip))
        .await
        .unwrap();
    assert!(!result.settled);
    assert_eq!(reason(&result).as_deref(), Some("stale-assessment"));
    assert_eq!(harness.questions.list().len(), 1);
}

#[tokio::test]
async fn question_reconsider_serializes_concurrent_attempts() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", false, "manual");
    let _wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let blocked = {
        let entered = entered.clone();
        let release = release.clone();
        gate(move |_| {
            let entered = entered.clone();
            let release = release.clone();
            Box::pin(async move {
                entered.notify_one();
                release.notified().await;
                true
            })
        })
    };
    let id = que("que_plan");
    let first = {
        let questions = harness.questions.clone();
        let id = id.clone();
        let request = input(&harness.questions, &owner, blocked);
        tokio::spawn(async move { questions.reconsider(&id, request).await.unwrap() })
    };
    entered.notified().await;
    let second = harness
        .questions
        .reconsider(&id, input(&harness.questions, &owner, open_gate()))
        .await
        .unwrap();
    assert_eq!(
        reason(&second).as_deref(),
        Some("native-assessment-in-progress")
    );
    release.notify_one();
    release.notify_one();
    assert!(first.await.unwrap().settled);
}

impl Harness {
    fn ask_pending(&self, session: &session::Id, id: &str) -> impl Future<Output = ()> {
        self.ask(session, id, FAST)
    }
}

#[tokio::test]
async fn autonomy_changes_are_published_once_per_committed_write() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let mut changes = harness.autonomy.changes();
    harness.answers(&owner, DecisionMode::Auto).await;
    assert_eq!(changes.next().await, Some(owner.clone()));
    harness.answers(&owner, DecisionMode::Auto).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), changes.next())
            .await
            .is_err(),
        "an unchanged write publishes nothing"
    );
}

fn locate_with(
    questions: Questions,
    current: Arc<dyn Fn() -> bool + Send + Sync>,
) -> ycoding_core::session::goal_decisions::Locate {
    Arc::new(
        move |_id: session::Id| -> BoxFuture<'static, Option<Located>> {
            let questions = questions.clone();
            let current = current.clone();
            Box::pin(async move {
                Some(Located {
                    permissions: None,
                    guardrails: None,
                    forms: None,
                    questions: Some(questions),
                    shell_active: None,
                    lease: Arc::new(()),
                    is_current: current,
                })
            })
        },
    )
}

#[tokio::test]
async fn yolo_reconsider_reports_the_model_confidence_and_the_coordinator_source() {
    let harness = Harness::new();
    let judge = Judge::new(vec![chosen("q0", "Slow", 0.9)]);
    let harness = harness.judged_by(&judge);
    let owner = harness.owner("ses_owner", false, "manual");
    let wait = harness.ask_request(closed(&owner, "que_plan", &[FAST]));
    harness.answers(&owner, DecisionMode::Yolo).await;
    let result = harness
        .questions
        .reconsider(
            &que("que_plan"),
            input(&harness.questions, &owner, open_gate()),
        )
        .await
        .unwrap();
    assert!(result.settled);
    assert_eq!(result.via, Some("yolo"));
    assert_eq!(result.confidence, Some(0.9));
    assert!(result.source.is_some());
    assert_eq!(judge.calls(), 1);
    wait.await;
    assert!(harness.questions.list().is_empty());
}

#[tokio::test]
async fn auto_reconsider_reports_no_fabricated_confidence() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", false, "manual");
    let _wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    let result = harness
        .questions
        .reconsider(
            &que("que_plan"),
            input(&harness.questions, &owner, open_gate()),
        )
        .await
        .unwrap();
    assert!(result.settled);
    assert_eq!(result.confidence, None);
}

#[tokio::test]
async fn a_duplicate_label_question_does_not_skip_the_independent_candidate() {
    let harness = Harness::new();
    let judge = Judge::new(vec![chosen("q1", "Slow", 0.9)]);
    let harness = harness.judged_by(&judge);
    let owner = harness.owner("ses_owner", false, "manual");
    let duplicated = r#"[{"label":"A","description":"x"},{"label":"A","description":"y"}]"#;
    let _wait = harness.ask_request(closed(&owner, "que_plan", &[duplicated, FAST]));
    harness.answers(&owner, DecisionMode::Yolo).await;
    let result = harness
        .questions
        .reconsider(
            &que("que_plan"),
            input(&harness.questions, &owner, open_gate()),
        )
        .await
        .unwrap();
    assert!(!result.settled);
    assert_eq!(reason(&result).as_deref(), Some("invalid-request"));
    assert_eq!(judge.calls(), 1);
    assert_eq!(harness.questions.list().len(), 1);
}

#[tokio::test]
async fn a_blocked_attempt_never_reinvokes_the_goal_agent_after_a_restart() {
    let harness = Harness::new();
    let judge = Judge::new(vec![refused("q0")]);
    let harness = harness.judged_by(&judge);
    let owner = harness.owner("ses_owner", true, "manual");
    let _wait = harness.ask_request(closed(&owner, "que_plan", &[PLAIN]));
    harness.answers(&owner, DecisionMode::Yolo).await;
    harness.goals(true).inspect(&owner).await;
    assert_eq!(judge.calls(), 0);
    assert_eq!(harness.synth.0.load(Ordering::SeqCst), 1);
    assert_eq!(harness.outcomes(&owner), vec!["waiting:refused"]);
    harness.goals(true).inspect(&owner).await;
    harness.goals(true).reconcile(&owner).await;
    assert_eq!(judge.calls(), 0);
    assert_eq!(harness.synth.0.load(Ordering::SeqCst), 1);
    assert_eq!(harness.outcomes(&owner), vec!["waiting:refused"]);
    assert_eq!(harness.questions.list().len(), 1);
}

fn data(options: &str) -> domain::Json {
    domain::Json::new(parse_json(&format!(r#"{{"options":{options}}}"#)).unwrap()).unwrap()
}

fn running_child(harness: &Harness, child: &session::Id, parent: &session::Id) {
    let child = child.as_lossless().clone();
    let parent = parent.as_lossless().clone();
    harness
        .fixture
        .store
        .submit(move |tx| {
            TaskTable::insert(
                tx,
                &ycoding_store::session::Task {
                    session_id: child,
                    parent_id: parent,
                    parent_assistant_message_id: "msg_parent".into(),
                    tool_call_id: "call_child".into(),
                    input_id: "msg_input_child".into(),
                    description: "Work".into(),
                    agent: "test".into(),
                    model: Document::<ycoding_schema::model::Ref>::new(
                        parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
                    )?,
                    prompt_digest: "0".repeat(64).as_str().into(),
                    background: 1,
                    delivery: "steer".into(),
                    state: "running".into(),
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
                    revision: 0,
                    time_created: 1,
                    time_updated: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[tokio::test]
async fn child_question_revocation_between_assessment_and_commit_writes_nothing() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let child = harness.fixture.session_with(
        "ses_child",
        Some("ses_owner"),
        ["manual", "manual", "manual"],
        false,
        None,
    );
    running_child(&harness, &child, &owner);
    let client = harness.fixture.store.client();
    let orchestration =
        orchestration::Service::new(store::Service::new(client.clone()), Arc::new(Idle));
    let asked = orchestration
        .question(
            &child,
            "Which plan?",
            Some(data(r#"["Fast (Recommended)","Slow"]"#)),
        )
        .await
        .unwrap();
    assert!(!asked.auto_answered);
    harness.answers(&child, DecisionMode::Auto).await;

    let flips = Arc::new(AtomicUsize::new(0));
    let revoke = {
        let flips = flips.clone();
        let writer = harness.fixture.store.client();
        let target = owner.clone();
        Arc::new(move || {
            flips.fetch_add(1, Ordering::SeqCst);
            let key = tuple_key(&[KeyPart::String(target.as_lossless())]);
            writer
                .submit(move |tx: &mut Write<'_>| {
                    let mut row = tx.get::<SessionTable>(&key)?.expect("owner row");
                    row.autonomy_revision += 1;
                    SessionTable::put(tx, &row)
                })
                .unwrap()
                .wait()
                .unwrap();
            true
        }) as Arc<dyn Fn() -> bool + Send + Sync>
    };
    let mut options = harness.goals_options_with(true);
    options.locate = locate_with(harness.questions.clone(), revoke);
    let goals = GoalDecisions::new(options);
    goals.inspect(&owner).await;

    assert!(flips.load(Ordering::SeqCst) >= 1);
    assert!(
        store::Service::new(client.clone())
            .pending_list(&child)
            .unwrap()
            .is_empty(),
        "a revoked authority commits no answer"
    );
    let snapshots = orchestration.question_snapshots(&owner).unwrap();
    assert_eq!(snapshots.len(), 1, "the child question stays open");
    assert!(
        harness
            .outcomes(&owner)
            .iter()
            .all(|outcome| !outcome.starts_with("settled")),
        "no settled receipt for a revoked commit"
    );
}

struct CountingProof(AtomicUsize);

impl AuthorityProof for CountingProof {
    fn authority_digest(&self, _session: &session::Id) -> ProofFuture<'_> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok("proof".to_owned()) })
    }
}

struct Held(Arc<AtomicBool>);

impl Drop for Held {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct BlockingProof {
    entered: Arc<Notify>,
    dropped: Arc<AtomicBool>,
}

impl AuthorityProof for BlockingProof {
    fn authority_digest(&self, _session: &session::Id) -> ProofFuture<'_> {
        let held = Held(self.dropped.clone());
        let entered = self.entered.clone();
        Box::pin(async move {
            let _held = held;
            entered.notify_one();
            std::future::pending::<()>().await;
            Ok("proof".to_owned())
        })
    }
}

fn flood(feed: &Feed, count: usize) {
    for index in 0..count {
        feed.emit(
            Data::QuestionRejected(Box::new(question::RejectedData {
                session_id: session::Id::new("ses_noise").unwrap(),
                request_id: que(&format!("que_noise_{index}")),
            })),
            None,
        )
        .unwrap();
    }
}

async fn until(mut done: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the awaited state was not reached");
}

fn small_feed(harness: &Harness) -> Feed {
    Feed::attach_with(&harness.fixture.store.client(), 16, 2)
}

fn asked(session: &session::Id) -> Data {
    Data::QuestionAsked(Box::new(question(session, "que_plan", FAST)))
}

fn emit_asked_after_a_flood(feed: &Feed, session: &session::Id) {
    flood(feed, 50);
    feed.emit(asked(session), None).unwrap();
}

#[tokio::test]
async fn a_flood_past_the_subscriber_capacity_still_settles_the_pending_question_once() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    let feed = small_feed(&harness);
    let goals = harness.goals(true);
    let _started = goals.start(&feed, harness.autonomy.clone()).unwrap();
    emit_asked_after_a_flood(&feed, &owner);
    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .unwrap();
    until(|| harness.outcomes(&owner) == vec!["settled:allowed"]).await;
    assert!(harness.questions.list().is_empty());
    assert!(harness.execution.wakes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_flood_before_the_native_answer_still_resumes_the_owner_exactly_once() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let wait = harness.ask_request(explicit(&owner, "que_plan"));
    let feed = small_feed(&harness);
    let goals = harness.goals(true);
    goals.inspect(&owner).await;
    assert_eq!(
        harness.outcomes(&owner),
        vec!["waiting:explicit-decision:purchase-spend"]
    );
    let _started = goals.start(&feed, harness.autonomy.clone()).unwrap();
    harness
        .questions
        .reply(&que("que_plan"), vec![vec!["Fast (Recommended)".into()]])
        .unwrap();
    wait.await;
    flood(&feed, 50);
    let Payload::Ephemeral(reply) = replied(&owner, "que_plan", false) else {
        unreachable!("the helper builds an ephemeral reply");
    };
    feed.publish(reply);
    until(|| harness.outcomes(&owner).len() == 2).await;
    assert_eq!(
        *harness.execution.wakes.lock().unwrap(),
        vec![owner.clone()]
    );
    assert_eq!(
        harness.outcomes(&owner),
        vec!["waiting:explicit-decision:purchase-spend", "resumed"]
    );
}

#[tokio::test]
async fn starting_the_loop_never_scans_or_assesses_existing_state() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    let feed = small_feed(&harness);
    let goals = harness.goals(true);
    let _started = goals.start(&feed, harness.autonomy.clone()).unwrap();
    let mut wait = Box::pin(wait);
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut wait)
            .await
            .is_err()
    );
    assert_eq!(harness.questions.list().len(), 1);
    assert!(harness.outcomes(&owner).is_empty());
}

#[tokio::test]
async fn blocked_gates_prevent_settlement_after_a_flood() {
    for (case, expected) in [
        ("proof", "waiting:authority-unavailable"),
        ("revoked", "waiting:delegation-revoked"),
        ("manual", "waiting:explicit-decision:purchase-spend"),
    ] {
        let harness = Harness::new();
        let owner = harness.owner("ses_owner", true, "manual");
        let _wait = if case == "manual" {
            harness.ask_request(explicit(&owner, "que_plan"))
        } else {
            harness.ask_request(question(&owner, "que_plan", FAST))
        };
        if case != "manual" {
            harness.answers(&owner, DecisionMode::Auto).await;
        }
        if case == "revoked" {
            harness.enabled.store(false, Ordering::SeqCst);
        }
        let feed = small_feed(&harness);
        let goals = harness.goals(case != "proof");
        let _started = goals.start(&feed, harness.autonomy.clone()).unwrap();
        emit_asked_after_a_flood(&feed, &owner);
        until(|| harness.outcomes(&owner) == vec![expected.to_owned()]).await;
        assert_eq!(harness.questions.list().len(), 1, "{case}");
        assert!(harness.execution.wakes.lock().unwrap().is_empty(), "{case}");
    }
}

#[tokio::test]
async fn repeated_floods_never_reinvoke_a_blocked_attempt() {
    let harness = Harness::new();
    let judge = Judge::new(vec![refused("q0")]);
    let harness = harness.judged_by(&judge);
    let owner = harness.owner("ses_owner", true, "manual");
    let _wait = harness.ask_request(closed(&owner, "que_plan", &[PLAIN]));
    harness.answers(&owner, DecisionMode::Yolo).await;
    let proof = Arc::new(CountingProof(AtomicUsize::new(0)));
    let mut options = harness.goals_options_with(true);
    options.proof = proof.clone();
    let goals = GoalDecisions::new(options);
    let feed = small_feed(&harness);
    let _started = goals.start(&feed, harness.autonomy.clone()).unwrap();
    let request = closed(&owner, "que_plan", &[PLAIN]);
    flood(&feed, 50);
    feed.emit(Data::QuestionAsked(Box::new(request.clone())), None)
        .unwrap();
    until(|| harness.outcomes(&owner) == vec!["waiting:refused"]).await;
    assert_eq!(judge.calls(), 0);
    assert_eq!(harness.synth.0.load(Ordering::SeqCst), 1);
    let first = proof.0.load(Ordering::SeqCst);
    flood(&feed, 50);
    feed.emit(Data::QuestionAsked(Box::new(request)), None)
        .unwrap();
    until(|| proof.0.load(Ordering::SeqCst) > first).await;
    assert_eq!(judge.calls(), 0);
    assert_eq!(harness.synth.0.load(Ordering::SeqCst), 1);
    assert_eq!(harness.outcomes(&owner), vec!["waiting:refused"]);
    assert_eq!(harness.questions.list().len(), 1);
}

#[tokio::test]
async fn shutdown_aborts_the_subscription_and_an_in_flight_handler() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let _wait = harness.ask(&owner, "que_plan", FAST);
    harness.answers(&owner, DecisionMode::Auto).await;
    let entered = Arc::new(Notify::new());
    let dropped = Arc::new(AtomicBool::new(false));
    let mut options = harness.goals_options_with(true);
    options.proof = Arc::new(BlockingProof {
        entered: entered.clone(),
        dropped: dropped.clone(),
    });
    let goals = GoalDecisions::new(options);
    let feed = small_feed(&harness);
    let started = goals.start(&feed, harness.autonomy.clone()).unwrap();
    emit_asked_after_a_flood(&feed, &owner);
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    assert!(!dropped.load(Ordering::SeqCst));
    drop(started);
    until(|| dropped.load(Ordering::SeqCst) && feed.subscribers() == 0).await;
    assert_eq!(harness.questions.list().len(), 1);
}

#[tokio::test]
async fn autonomy_changes_are_delivered_without_loss_to_a_stalled_subscriber() {
    let harness = Harness::new();
    let owner = harness.owner("ses_owner", true, "manual");
    let mut changes = harness.autonomy.changes();
    let writes = 1_100;
    for index in 0..writes {
        let mode = if index % 2 == 0 {
            DecisionMode::Auto
        } else {
            DecisionMode::Manual
        };
        harness.answers(&owner, mode).await;
    }
    for _ in 0..writes {
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), changes.next())
                .await
                .unwrap(),
            Some(owner.clone())
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), changes.next())
            .await
            .is_err()
    );
}
