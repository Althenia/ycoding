include!("policy_fixture.rs");

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use ycoding_core::{
    coordination::{
        decision_context,
        decisions::{Gate, Settings, Source},
        runtime::{DecisionOutcome, Future as CoordinationFuture},
    },
    process::guardrails::{
        Guardrails, Input as GuardrailInput, Limits, Paths, Settings as GuardrailSettings,
    },
    session::{
        autonomy::Service as Autonomy,
        goal_decisions::{
            AuthorityProof, BoxFuture, Execution, GoalDecisions, Located, Options, ProofFuture,
            Synthesize,
        },
        orchestration,
        run_coordinator::{Outcome, RunFuture},
        store,
    },
    tools::policy::{
        forms::Forms, goal_answer::GoalReconsider, permissions::Permissions, questions::Questions,
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, coordination as c, form, parse_json, permission,
    project_id::ProjectId, question, session,
};
use ycoding_store::session::{Document, TaskTable};

const BOUND: Duration = Duration::from_secs(5);
const BRANCH: &str = "Which branch name should the feature use?";

struct Synth {
    prompts: Mutex<Vec<String>>,
    reply: Mutex<Result<String, String>>,
}

impl Synth {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            prompts: Mutex::default(),
            reply: Mutex::new(Ok("feature/synthetic".to_owned())),
        })
    }

    fn answer_with(&self, reply: Result<&str, &str>) {
        *self.reply.lock().unwrap() = reply.map(str::to_owned).map_err(str::to_owned);
    }

    fn calls(&self) -> usize {
        self.prompts.lock().unwrap().len()
    }
}

impl Synthesize for Synth {
    fn synthesize(
        &self,
        _owner: &session::Id,
        prompt: String,
    ) -> BoxFuture<'_, Result<String, String>> {
        self.prompts.lock().unwrap().push(prompt);
        let reply = self.reply.lock().unwrap().clone();
        Box::pin(async move { reply })
    }
}

struct Wakes(Mutex<Vec<session::Id>>);

impl Execution for Wakes {
    fn active(&self) -> Vec<session::Id> {
        Vec::new()
    }

    fn wake(&self, id: &session::Id) -> Result<(), String> {
        self.0.lock().unwrap().push(id.clone());
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

struct Proof;

impl AuthorityProof for Proof {
    fn authority_digest(&self, _session: &session::Id) -> ProofFuture<'_> {
        Box::pin(async { Ok::<_, decision_context::Error>("proof".to_owned()) })
    }
}

struct Harness {
    fixture: Fixture,
    autonomy: Autonomy,
    questions: Questions,
    forms: Forms,
    permissions: Permissions,
    guardrails: Guardrails,
    orchestration: orchestration::Service,
    synth: Arc<Synth>,
    wakes: Arc<Wakes>,
    enabled: Arc<AtomicBool>,
}

impl Harness {
    fn new() -> Self {
        let fixture = Fixture::default();
        fixture.rules.lock().unwrap().push(permission::Rule {
            action: "read".into(),
            resource: "*".into(),
            effect: permission::Effect("ask".into()),
        });
        let client = fixture.store.client();
        let permissions = Permissions::new(
            fixture.authority(),
            ProjectId::new("project").unwrap(),
            fixture.publisher(),
        );
        let guardrails = Guardrails::new(
            fixture.authority(),
            permissions.clone(),
            GuardrailSettings {
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
            },
            fixture.publisher(),
        );
        Self {
            autonomy: Autonomy::new(client.clone()),
            questions: Questions::new(fixture.authority(), fixture.publisher()),
            forms: Forms::new(fixture.authority(), fixture.publisher()),
            permissions,
            guardrails,
            orchestration: orchestration::Service::new(store::Service::new(client), Arc::new(Idle)),
            synth: Synth::new(),
            wakes: Arc::new(Wakes(Mutex::default())),
            enabled: Arc::new(AtomicBool::new(true)),
            fixture,
        }
    }

    fn goals(&self) -> GoalDecisions {
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
        let questions = self.questions.clone();
        let forms = self.forms.clone();
        let permissions = self.permissions.clone();
        let guardrails = self.guardrails.clone();
        GoalDecisions::new(Options {
            client: self.fixture.store.client(),
            autonomy: self.autonomy.clone(),
            execution: self.wakes.clone(),
            orchestration: self.orchestration.clone(),
            settings,
            locate: Arc::new(
                move |_id: session::Id| -> BoxFuture<'static, Option<Located>> {
                    let located = Located {
                        permissions: Some(permissions.clone()),
                        guardrails: Some(guardrails.clone()),
                        forms: Some(forms.clone()),
                        questions: Some(questions.clone()),
                        shell_active: None,
                        lease: Arc::new(()),
                        is_current: Arc::new(|| true),
                    };
                    Box::pin(async move { Some(located) })
                },
            ),
            proof: Arc::new(Proof),
            synthesize: self.synth.clone(),
            now: None,
        })
    }

    fn owner(&self, permissions: &str) -> session::Id {
        self.fixture.session_with(
            "ses_owner",
            None,
            [permissions, "manual", "manual"],
            true,
            None,
        )
    }

    fn receipts(&self, owner: &session::Id) -> Vec<JsonValue> {
        store::Service::new(self.fixture.store.client())
            .pending_list(owner)
            .unwrap()
            .into_iter()
            .filter_map(|pending| field(field(&pending.data, "metadata")?, "goalDecision").cloned())
            .collect()
    }

    fn outcomes(&self, owner: &session::Id) -> Vec<String> {
        self.receipts(owner)
            .iter()
            .map(|receipt| {
                let outcome = text(field(receipt, "outcome").unwrap());
                match field(receipt, "reason") {
                    Some(reason) => format!("{outcome}:{}", text(reason)),
                    None => outcome,
                }
            })
            .collect()
    }

    fn receipt_text(&self, owner: &session::Id) -> String {
        store::Service::new(self.fixture.store.client())
            .pending_list(owner)
            .unwrap()
            .into_iter()
            .filter(|pending| {
                field(&pending.data, "metadata")
                    .and_then(|metadata| field(metadata, "goalDecision"))
                    .is_some()
            })
            .map(|pending| text(field(&pending.data, "text").expect("receipt text")))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn events(&self, kind: &str) -> Vec<JsonValue> {
        self.fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.type_ == kind)
            .map(|event| event.data.clone())
            .collect()
    }

    fn ask_question(
        &self,
        owner: &session::Id,
        id: &str,
        question: &str,
        options: &str,
    ) -> tokio::task::JoinHandle<Option<Vec<question::Answer>>> {
        let request = question::Request::decode(
            &parse_json(&format!(
                r#"{{"id":"{id}","sessionID":"{}","questions":[{{"header":"Branch","question":"{question}","options":{options}}}]}}"#,
                owner.as_lossless().as_str().unwrap()
            ))
            .unwrap(),
        )
        .unwrap();
        let ycoding_core::tools::policy::questions::Admission::Pending(wait) =
            self.questions.ask(request).unwrap()
        else {
            panic!("a manual answers mode leaves the question pending");
        };
        tokio::spawn(async move { wait.await.ok().and_then(Result::ok) })
    }

    fn ask_form(
        &self,
        owner: &session::Id,
        id: &str,
        field: &str,
    ) -> ycoding_core::tools::policy::Wait<form::State> {
        let info = form::Info::decode(
            &parse_json(&format!(
                r#"{{"id":"{id}","sessionID":{},"title":"Questions","metadata":{{"kind":"question"}},"fields":[{field}]}}"#,
                ycoding_schema::stringify_json(&owner.encode())
            ))
            .unwrap(),
        )
        .unwrap();
        self.forms.ask(info).unwrap()
    }

    fn ask_permission(&self, owner: &session::Id) -> tokio::task::JoinHandle<()> {
        let request = permission::Request {
            id: permission::Id::new("per_goal").unwrap(),
            session_id: owner.clone(),
            action: "read".into(),
            resources: vec!["notes/plan.md".into()],
            save: None,
            metadata: None,
            source: None,
            escalation: None,
            coordination_escalation: None,
        };
        let permissions = self.permissions.clone();
        tokio::spawn(async move {
            let _ = permissions.assert(request, None).await;
        })
    }

    async fn child_question(&self, owner: &session::Id, text: &str) -> session::Id {
        let child = self.fixture.session_with(
            "ses_child",
            Some("ses_owner"),
            ["manual", "manual", "manual"],
            false,
            None,
        );
        insert_running_child(self, &child, owner);
        let asked = self
            .orchestration
            .question(&child, text, None)
            .await
            .unwrap();
        assert!(!asked.auto_answered);
        child
    }
}

fn insert_running_child(harness: &Harness, child: &session::Id, parent: &session::Id) {
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

fn free_field(description: &str) -> String {
    format!(
        r#"{{"key":"q0","title":"Branch","description":"{description}","type":"string","options":[],"custom":true,"required":true}}"#
    )
}

fn answer_of(state: form::State) -> JsonValue {
    match state {
        form::State::Answered(answer) => JsonValue::Object(answer.0),
        other => panic!("expected an answered form, found {other:?}"),
    }
}

async fn settled<T>(wait: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(BOUND, wait)
        .await
        .expect("the request settles")
}

fn coordinator(source: &JsonValue) -> (String, String) {
    assert_eq!(text(field(source, "kind").unwrap()), "coordinator");
    (
        text(field(source, "coordinatorSessionID").unwrap()),
        text(field(source, "via").unwrap()),
    )
}

#[tokio::test]
async fn the_goal_agent_answers_an_ordinary_free_text_question_under_manual_answers() {
    let harness = Harness::new();
    let owner = harness.owner("manual");
    let wait = harness.ask_question(&owner, "que_branch", BRANCH, "[]");
    harness.goals().inspect(&owner).await;

    assert_eq!(
        settled(wait).await.unwrap().unwrap(),
        vec![vec!["feature/synthetic".into()]]
    );
    assert!(harness.questions.list().is_empty());
    assert_eq!(harness.outcomes(&owner), vec!["settled:allowed"]);
    let receipt = &harness.receipts(&owner)[0];
    assert_eq!(text(field(receipt, "via").unwrap()), "goal");
    assert!(
        harness
            .receipt_text(&owner)
            .contains("Goal agent under the active goal")
    );
    let prompts = harness.synth.prompts.lock().unwrap().clone();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains(BRANCH) && prompts[0].contains("Synthetic goal"));
    assert!(harness.wakes.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_goal_agent_answers_an_ordinary_free_text_form_and_attributes_the_reply_to_the_goal() {
    let harness = Harness::new();
    let owner = harness.owner("manual");
    let wait = harness.ask_form(&owner, "frm_branch", &free_field(BRANCH));
    harness.goals().inspect(&owner).await;

    let state = settled(wait).await.unwrap();
    assert_eq!(
        answer_of(state),
        parse_json(r#"{"q0":"feature/synthetic"}"#).unwrap()
    );
    let replied = harness.events("form.replied");
    assert_eq!(replied.len(), 1);
    let (session, via) = coordinator(field(&replied[0], "source").unwrap());
    assert_eq!((session.as_str(), via.as_str()), ("ses_owner", "goal"));
    assert_eq!(harness.outcomes(&owner), vec!["settled:allowed"]);
    assert_eq!(
        text(field(&harness.receipts(&owner)[0], "via").unwrap()),
        "goal"
    );
    assert_eq!(harness.synth.calls(), 1);
}

#[tokio::test]
async fn the_goal_agent_answers_an_ordinary_free_text_child_question() {
    let harness = Harness::new();
    let owner = harness.owner("manual");
    let child = harness.child_question(&owner, BRANCH).await;
    harness.goals().inspect(&owner).await;

    let answers = store::Service::new(harness.fixture.store.client())
        .pending_list(&child)
        .unwrap();
    assert_eq!(answers.len(), 1);
    assert!(text(field(&answers[0].data, "text").unwrap()).contains("feature/synthetic"));
    assert!(
        harness
            .orchestration
            .question_snapshots(&owner)
            .unwrap()
            .is_empty()
    );
    assert_eq!(harness.outcomes(&owner), vec!["settled:allowed"]);
    assert_eq!(
        text(field(&harness.receipts(&owner)[0], "via").unwrap()),
        "goal"
    );
    assert_eq!(harness.synth.calls(), 1);
}

#[tokio::test]
async fn a_recommended_option_settles_deterministically_without_the_goal_agent() {
    let harness = Harness::new();
    let owner = harness.owner("manual");
    let options = r#"[{"label":"Fast (Recommended)","description":"Use the fast path"},{"label":"Slow","description":"Use the slow path"}]"#;
    let wait = harness.ask_question(&owner, "que_plan", "Which path?", options);
    harness.goals().inspect(&owner).await;

    assert_eq!(
        settled(wait).await.unwrap().unwrap(),
        vec![vec!["Fast (Recommended)".into()]]
    );
    assert_eq!(harness.outcomes(&owner), vec!["settled:allowed"]);
    assert_eq!(
        text(field(&harness.receipts(&owner)[0], "via").unwrap()),
        "auto-answer"
    );
    assert_eq!(harness.synth.calls(), 0);
}

#[tokio::test]
async fn a_synthesis_the_goal_agent_cannot_settle_leaves_questions_and_forms_pending() {
    for (reply, reason) in [
        (Err("refused"), "refused"),
        (Err("low_confidence"), "low_confidence"),
        (Err("provider-failed"), "provider-failed"),
        (Ok("   "), "refused"),
    ] {
        let harness = Harness::new();
        harness.synth.answer_with(reply);
        let owner = harness.owner("manual");
        let _question = harness.ask_question(&owner, "que_branch", BRANCH, "[]");
        let _form = harness.ask_form(&owner, "frm_branch", &free_field(BRANCH));
        let goals = harness.goals();
        goals.inspect(&owner).await;
        goals.inspect(&owner).await;

        assert_eq!(harness.synth.calls(), 2, "{reason}");
        assert_eq!(
            harness.outcomes(&owner),
            vec![format!("waiting:{reason}"); 2],
            "{reason}"
        );
        assert_eq!(harness.questions.list().len(), 1, "{reason}");
        assert_eq!(harness.forms.snapshots(&owner, 8).len(), 1, "{reason}");
        assert!(harness.events("question.replied").is_empty(), "{reason}");
        assert!(harness.events("form.replied").is_empty(), "{reason}");
    }
}

#[test]
fn a_multiselect_with_multiple_recommendations_has_no_deterministic_answer() {
    let request = question::Request::decode(
        &parse_json(
            r#"{"id":"que_plan","sessionID":"ses_owner","questions":[{"header":"Plan","question":"Which paths?","multiple":true,"options":[{"label":"Fast (Recommended)","description":"Use the fast path"},{"label":"Careful (Recommended)","description":"Use the careful path"}]}]}"#,
        )
        .unwrap(),
    )
    .unwrap();

    assert!(ycoding_core::tools::policy::questions::deterministic_goal_answers(&request).is_none());
}

#[tokio::test]
async fn sensitive_questions_forms_and_child_questions_reach_the_goal_agent() {
    let harness = Harness::new();
    let owner = harness.owner("manual");
    let _question = harness.ask_question(
        &owner,
        "que_buy",
        "Approve the purchase of the paid plan?",
        "[]",
    );
    let _password = harness.ask_form(
        &owner,
        "frm_password",
        &free_field("What password should the deployment use?"),
    );
    harness
        .child_question(
            &owner,
            "Approve the purchase of the paid plan for evidence?",
        )
        .await;
    harness.goals().inspect(&owner).await;

    let outcomes = harness.outcomes(&owner);
    assert_eq!(outcomes.len(), 3, "{outcomes:?}");
    assert!(
        outcomes
            .iter()
            .all(|outcome| outcome.starts_with("settled:")),
        "{outcomes:?}"
    );
    assert_eq!(harness.synth.calls(), 3);
    assert!(harness.questions.list().is_empty());
    assert!(harness.forms.snapshots(&owner, 8).is_empty());
    assert!(
        harness
            .orchestration
            .question_snapshots(&owner)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn the_goal_agent_settles_a_hard_review_under_manual_guardrails() {
    for (answer, expected) in [
        ("approve", "settled:allowed"),
        ("decline", "settled:denied"),
    ] {
        let harness = Harness::new();
        harness.synth.answer_with(Ok(answer));
        let owner = harness.owner("manual");
        let admission = harness
            .guardrails
            .assert(GuardrailInput {
                session_id: owner.clone(),
                action: "shell".into(),
                resources: vec!["git reset --hard".into()],
                metadata: None,
                skip_review: false,
                holder: None,
                source: None,
            })
            .unwrap();
        assert_eq!(admission.request.as_ref().unwrap().hard_review, Some(true));
        let wait = admission.wait.unwrap();
        harness.goals().inspect(&owner).await;

        assert_eq!(harness.outcomes(&owner), vec![expected], "{answer}");
        assert_eq!(harness.synth.calls(), 1);
        let result = tokio::time::timeout(BOUND, wait).await.unwrap().unwrap();
        if answer == "approve" {
            result.unwrap().release();
        } else {
            assert!(result.is_err());
        }
    }
}

#[tokio::test]
async fn the_goal_loop_settles_a_permission_ask_under_manual_permissions() {
    let harness = Harness::new();
    harness.synth.answer_with(Ok("approve"));
    let owner = harness.owner("manual");
    let waiting = harness.ask_permission(&owner);
    tokio::time::timeout(BOUND, async {
        while harness.permissions.list().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the ask becomes pending");
    harness.goals().inspect(&owner).await;

    assert_eq!(harness.outcomes(&owner), vec!["settled:allowed"]);
    assert!(harness.permissions.list().is_empty());
    assert_eq!(harness.synth.calls(), 1);
    let prompts = harness.synth.prompts.lock().unwrap();
    assert!(prompts[0].contains("read") && prompts[0].contains("notes/plan.md"));
    drop(prompts);
    tokio::time::timeout(BOUND, waiting)
        .await
        .expect("the ask is answered")
        .unwrap();
}

#[tokio::test]
async fn an_invalid_goal_decision_does_not_approve_a_permission() {
    let harness = Harness::new();
    harness.synth.answer_with(Ok("not a decision"));
    let owner = harness.owner("manual");
    let _waiting = harness.ask_permission(&owner);
    tokio::time::timeout(BOUND, async {
        while harness.permissions.list().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the ask becomes pending");
    harness.goals().inspect(&owner).await;

    assert_eq!(harness.outcomes(&owner), vec!["waiting:refused"]);
    assert_eq!(harness.permissions.list().len(), 1);
    assert_eq!(harness.synth.calls(), 1);
}

#[tokio::test]
async fn the_goal_agent_can_decline_a_permission_ask_under_manual_permissions() {
    let harness = Harness::new();
    harness.synth.answer_with(Ok("decline"));
    let owner = harness.owner("manual");
    let waiting = harness.ask_permission(&owner);
    tokio::time::timeout(BOUND, async {
        while harness.permissions.list().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the ask becomes pending");
    harness.goals().inspect(&owner).await;

    assert_eq!(harness.outcomes(&owner), vec!["settled:denied"]);
    assert!(harness.permissions.list().is_empty());
    assert_eq!(harness.synth.calls(), 1);
    tokio::time::timeout(BOUND, waiting)
        .await
        .expect("the ask is answered")
        .unwrap();
}

#[tokio::test]
async fn an_explicit_user_reply_keeps_normal_attribution_and_resumes_nothing_by_the_goal_agent() {
    let harness = Harness::new();
    harness.synth.answer_with(Err("refused"));
    let owner = harness.owner("manual");
    let wait = harness.ask_form(&owner, "frm_branch", &free_field(BRANCH));
    harness.goals().inspect(&owner).await;
    assert_eq!(harness.outcomes(&owner), vec!["waiting:refused"]);

    let id = form::Id::decode(&JsonValue::String("frm_branch".into())).unwrap();
    harness
        .forms
        .reply(
            &id,
            form::Answer::decode(&parse_json(r#"{"q0":"feature/human"}"#).unwrap()).unwrap(),
        )
        .unwrap();
    assert_eq!(
        answer_of(settled(wait).await.unwrap()),
        parse_json(r#"{"q0":"feature/human"}"#).unwrap()
    );
    let replied = harness.events("form.replied");
    assert_eq!(replied.len(), 1);
    assert!(field(&replied[0], "source").is_none());
    assert!(!harness.forms.answered_automatically(&id).unwrap());
}

fn goal_gate<T: Send + 'static>() -> Gate<T> {
    Gate {
        validate: Arc::new(|_| Box::pin(async { true })),
        current: Arc::new(|| true),
    }
}

fn goal_source(owner: &session::Id) -> Source {
    Source {
        coordinator_session_id: owner.clone(),
        group_id: None,
        rationale: "The Goal agent settled a routine form request.".into(),
    }
}

#[tokio::test]
async fn a_goal_reconsideration_settles_a_form_marked_require_explicit_decision() {
    let harness = Harness::new();
    let owner = harness.owner("manual");
    let info = form::Info::decode(
        &parse_json(&format!(
            r#"{{"id":"frm_explicit","sessionID":{},"title":"Questions","metadata":{{"kind":"question","requireExplicitDecision":true}},"fields":[{}]}}"#,
            ycoding_schema::stringify_json(&owner.encode()),
            free_field(BRANCH)
        ))
        .unwrap(),
    )
    .unwrap();
    let wait = harness.forms.ask(info.clone()).unwrap();
    let fingerprint = harness.forms.snapshot(&info.id).unwrap().fingerprint;
    let answer =
        form::Answer::decode(&parse_json(r#"{"q0":"feature/synthetic"}"#).unwrap()).unwrap();

    let result = harness
        .forms
        .reconsider_goal(
            &info.id,
            GoalReconsider {
                fingerprint,
                source: goal_source(&owner),
                answer: Some(answer),
                confidence: None,
                gate: goal_gate(),
            },
        )
        .await
        .unwrap();

    assert!(result.settled, "{result:?}");
    assert!(matches!(result.outcome, DecisionOutcome::Allowed));
    assert_eq!(
        answer_of(settled(wait).await.unwrap()),
        parse_json(r#"{"q0":"feature/synthetic"}"#).unwrap()
    );
    assert!(harness.forms.snapshots(&owner, 8).is_empty());
}

#[tokio::test]
async fn a_goal_answer_below_the_confidence_floor_is_not_applied() {
    let harness = Harness::new();
    let owner = harness.owner("manual");
    let _wait = harness.ask_question(&owner, "que_branch", BRANCH, "[]");
    let snapshot = harness.questions.snapshots(&owner, 8).remove(0);
    let id = snapshot.request.id.clone();

    let result = harness
        .questions
        .reconsider_goal(
            &id,
            GoalReconsider {
                fingerprint: snapshot.fingerprint,
                source: goal_source(&owner),
                answer: Some(vec![vec!["feature/synthetic".into()]]),
                confidence: Some(0.5),
                gate: goal_gate(),
            },
        )
        .await
        .unwrap();

    assert!(!result.settled);
    assert_eq!(
        text(&JsonValue::String(result.reason.unwrap())),
        "low_confidence"
    );
    assert_eq!(harness.questions.list().len(), 1);
}

#[tokio::test]
async fn a_coordinator_supplied_form_answer_skips_the_deterministic_check_and_manual_modes_require_one()
 {
    let harness = Harness::new();
    let auto =
        harness
            .fixture
            .session_with("ses_auto", None, ["manual", "manual", "auto"], false, None);
    let manual = harness.owner("manual");
    let ask = |owner: &session::Id, id: &str| {
        let info = form::Info::decode(
            &parse_json(&format!(
                r#"{{"id":"{id}","sessionID":{},"title":"Questions","metadata":{{"kind":"question"}},"fields":[{}]}}"#,
                ycoding_schema::stringify_json(&owner.encode()),
                free_field(BRANCH)
            ))
            .unwrap(),
        )
        .unwrap();
        let wait = harness.forms.ask(info.clone()).unwrap();
        let fingerprint = harness.forms.snapshot(&info.id).unwrap().fingerprint;
        (info.id, fingerprint, wait)
    };
    let reconsider = |fingerprint, answer| ycoding_core::coordination::decisions::Reconsider {
        fingerprint,
        source: goal_source(&auto),
        decision: None,
        answer,
        confidence: None,
        gate: goal_gate(),
    };

    let (id, fingerprint, wait) = ask(&auto, "frm_supplied");
    let supplied =
        form::Answer::decode(&parse_json(r#"{"q0":"feature/coordinated"}"#).unwrap()).unwrap();
    let settled_result = harness
        .forms
        .reconsider(&id, reconsider(fingerprint, Some(supplied)))
        .await
        .unwrap();
    assert!(settled_result.settled);
    assert_eq!(settled_result.via, Some("coordination"));
    assert!(matches!(
        settled(wait).await.unwrap(),
        form::State::Answered(_)
    ));

    let (id, fingerprint, _wait) = ask(&manual, "frm_manual");
    let required = harness
        .forms
        .reconsider(&id, reconsider(fingerprint, None))
        .await
        .unwrap();
    assert!(!required.settled);
    assert_eq!(
        text(&JsonValue::String(required.reason.unwrap())),
        "answer-required"
    );
}
