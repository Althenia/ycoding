use std::{
    ops::Bound,
    sync::{Arc, Mutex, OnceLock},
};
use ycoding_core::{
    process::guardrails::{Guardrails, Limits, Paths, Settings},
    session::{
        orchestration::{Error, Execution, LaunchInput, Prepared, Service as Orchestration},
        review::{
            self, ChildAnswer, DecideInput, Delivery, DeliveryError, DeliveryFuture, OpenInput,
            RecoveryResolution, WithdrawReason,
        },
        run_coordinator::{Outcome, RunFuture},
        store,
    },
    tools::policy::{Authority, Publisher, permissions::Permissions},
};
use ycoding_schema::{
    DomainDecode, JsonValue, model, parse_json, permission, session, session_message,
    session_orchestration::{QuestionId, State},
    session_review::{Decision, Id, Kind, Origin, Payload, Reason, SubagentQuestionPayload},
};
use ycoding_store::{Store, session::EventTable};

#[path = "autonomy_support/mod.rs"]
mod support;

const DECIDED: &str = "session.review.decided.1";
const TASK_UPDATED: &str = "session.task.updated.1";
const ADMITTED: &str = "session.input.admitted.1";
const WITHDRAWN: &str = "session.review.withdrawn.1";

#[derive(Default)]
struct Recorder(Mutex<Vec<String>>);

impl Recorder {
    fn woken(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

impl Execution for Recorder {
    fn resume(&self, _: &session::Id) -> RunFuture {
        panic!("unexpected explicit resumption")
    }

    fn wake(&self, id: &session::Id) -> Outcome {
        self.0
            .lock()
            .unwrap()
            .push(id.as_lossless().as_str().unwrap().into());
        Ok(())
    }
    fn interrupt(&self, _id: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Clone, Copy)]
enum Interference {
    Withdraw,
    Defer,
}

#[derive(Default)]
struct Bridge {
    orchestration: OnceLock<Orchestration>,
    review: OnceLock<review::Service>,
    interference: Mutex<Option<(Interference, QuestionId)>>,
}

impl Delivery for Bridge {
    fn wake(&self, _session_id: &session::Id) {}

    fn answer_child<'a>(&'a self, answer: ChildAnswer) -> DeliveryFuture<'a> {
        Box::pin(async move {
            let interference = self.interference.lock().unwrap().take();
            if let Some((interference, question_id)) = interference {
                let review = self.review.get().unwrap();
                match interference {
                    Interference::Withdraw => {
                        review
                            .withdraw(&answer.child_id, WithdrawReason::TaskClosed, 20)
                            .await
                            .unwrap();
                    }
                    Interference::Defer => {
                        review
                            .open(deferral(&answer.child_id, &question_id))
                            .await
                            .unwrap();
                    }
                }
            }
            self.orchestration
                .get()
                .unwrap()
                .answer_review(answer)
                .await
        })
    }

    fn resolve_recovery<'a>(&'a self, _resolution: RecoveryResolution) -> DeliveryFuture<'a> {
        Box::pin(async {
            Err(DeliveryError::Conflict(
                "recovery resolution is not available".into(),
            ))
        })
    }
}

struct Harness {
    store: Store,
    sessions: store::Service,
    orchestration: Orchestration,
    review: review::Service,
    recorder: Arc<Recorder>,
    bridge: Arc<Bridge>,
}

fn harness() -> Harness {
    let store = support::store();
    let sessions = store::Service::new(store.client());
    let recorder = Arc::new(Recorder::default());
    let orchestration = Orchestration::new(sessions.clone(), recorder.clone());
    let bridge = Arc::new(Bridge::default());
    let review = review::Service::new(sessions.clone(), bridge.clone());
    assert!(bridge.orchestration.set(orchestration.clone()).is_ok());
    assert!(bridge.review.set(review.clone()).is_ok());
    Harness {
        store,
        sessions,
        orchestration,
        review,
        recorder,
        bridge,
    }
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn guardrails(store: &Store) -> Guardrails {
    let authority = Authority {
        store: store.client(),
        agents: Arc::new(|agent| {
            Some((agent.cloned().unwrap_or_else(|| "build".into()), Vec::new()))
        }),
    };
    let publisher: Publisher = Arc::new(|_| Ok(()));
    Guardrails::new(
        authority.clone(),
        Permissions::new(
            authority,
            ycoding_schema::project_id::ProjectId::new("prj_one").unwrap(),
            publisher.clone(),
        ),
        Settings {
            paths: Paths {
                workdir: "/project".into(),
                project: "/project".into(),
                home: "/home/operator".into(),
                tmpdir: None,
                trusted_paths: vec![],
            },
            global_roots: vec![],
            custom: Arc::new(Vec::new),
            enabled: true,
            limits: Limits {
                subagents: 8,
                ..Limits::default()
            },
            decide_reviews: false,
            decide_hard_reviews: true,
        },
        publisher,
    )
}

async fn waiting_child(harness: &Harness) -> (session::Id, QuestionId) {
    let child = harness
        .orchestration
        .launch(LaunchInput {
            parent_id: id("ses_one"),
            parent_assistant_message_id: session_message::Id::new("msg_parent").unwrap(),
            tool_call_id: "call_review".into(),
            description: "Explore".into(),
            prompt: "Look around".into(),
            depth_limit: 1,
            prepared: Prepared {
                agent: "explore".into(),
                caller_permissions: permission::Ruleset::decode(&parse_json("[]").unwrap())
                    .unwrap(),
                model: model::Ref::decode(
                    &parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
                )
                .unwrap(),
                profile_binding: None,
            },
            guardrails: guardrails(&harness.store),
        })
        .await
        .unwrap()
        .session_id;
    let asked = harness
        .orchestration
        .question(&child, "Which database?", None)
        .await
        .unwrap();
    assert!(!asked.auto_answered);
    (child, asked.question.id)
}

fn deferral(child: &session::Id, question: &QuestionId) -> OpenInput {
    OpenInput {
        session_id: child.clone(),
        kind: Kind::SubagentQuestion,
        reason: Reason::SleepEntry,
        choice: None,
        confidence: None,
        grades: None,
        origin: Origin::Question {
            question_id: question.clone(),
        },
        payload: Payload::SubagentQuestion(SubagentQuestionPayload {
            text: "Which database?".into(),
            data: None,
        }),
        limit: 8,
        conversion: true,
        created: 10,
    }
}

async fn deferred(harness: &Harness, child: &session::Id, question: &QuestionId) -> Id {
    harness
        .review
        .open(deferral(child, question))
        .await
        .unwrap()
        .deferral
        .item_id
}

fn answer(text: &str) -> Decision {
    Decision::SubagentQuestion {
        text: text.into(),
        data: None,
    }
}

fn decide(child: &session::Id, item: &Id, text: &str) -> DecideInput {
    DecideInput {
        session_id: child.clone(),
        item_id: item.clone(),
        decision: answer(text),
        now: 30,
    }
}

fn events(store: &Store, session: &session::Id, kind: &str) -> Vec<JsonValue> {
    let mut rows = store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
        .into_iter()
        .filter(|event| {
            &event.aggregate_id == session.as_lossless() && event.type_.as_str() == Some(kind)
        })
        .map(|event| (event.seq, event.data))
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| row.0);
    rows.into_iter().map(|row| row.1).collect()
}

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    object.get(&name.into())
}

fn ordered(store: &Store, child: &session::Id) -> Vec<String> {
    let mut rows = store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
        .into_iter()
        .filter(|event| &event.aggregate_id == child.as_lossless())
        .collect::<Vec<_>>();
    rows.sort_by_key(|event| event.seq);
    rows.into_iter()
        .filter_map(|event| match event.type_.as_str() {
            Some(WITHDRAWN) => Some(WITHDRAWN.to_owned()),
            Some(TASK_UPDATED) => {
                match field(&event.data, "change").and_then(|change| field(change, "type")) {
                    Some(JsonValue::String(kind))
                        if matches!(kind.as_str(), Some("cancel_requested" | "cancelled")) =>
                    {
                        kind.to_utf8().ok()
                    }
                    _ => None,
                }
            }
            _ => None,
        })
        .collect()
}

fn answered(store: &Store, child: &session::Id) -> usize {
    events(store, child, TASK_UPDATED)
        .iter()
        .filter(|data| {
            field(data, "change").and_then(|change| field(change, "type"))
                == Some(&JsonValue::String("question_answered".into()))
        })
        .count()
}

fn answer_admissions(store: &Store, child: &session::Id) -> Vec<String> {
    events(store, child, ADMITTED)
        .iter()
        .filter_map(|data| {
            let text = field(data, "input")
                .and_then(|input| field(input, "data"))
                .and_then(|data| field(data, "text"))?;
            let JsonValue::String(text) = text else {
                return None;
            };
            let text = text.to_utf8().unwrap();
            text.starts_with("Parent answer:").then_some(text)
        })
        .collect()
}

fn state(harness: &Harness, child: &session::Id) -> State {
    harness
        .orchestration
        .get(&id("ses_one"), child)
        .unwrap()
        .state
}

#[tokio::test]
async fn a_human_review_answer_commits_the_decision_admission_and_task_answer_together() {
    let harness = harness();
    let (child, question) = waiting_child(&harness).await;
    let item = deferred(&harness, &child, &question).await;
    let woken = harness.recorder.woken().len();

    harness
        .review
        .decide(decide(&child, &item, "Postgres"))
        .await
        .unwrap();

    assert_eq!(state(&harness, &child), State::Running);
    assert!(
        harness
            .orchestration
            .get(&id("ses_one"), &child)
            .unwrap()
            .question
            .is_none()
    );
    assert_eq!(events(&harness.store, &child, DECIDED).len(), 1);
    assert_eq!(answered(&harness.store, &child), 1);
    let admissions = answer_admissions(&harness.store, &child);
    assert_eq!(admissions.len(), 1);
    assert!(admissions[0].contains("Postgres"));
    assert!(
        harness
            .sessions
            .pending_list(&child)
            .unwrap()
            .iter()
            .any(|row| ycoding_schema::stringify_json(&row.data).contains("Postgres"))
    );
    assert!(!harness.review.has_open(&child).unwrap());
    assert_eq!(
        harness.recorder.woken()[woken..],
        [child.as_lossless().as_str().unwrap().to_owned()]
    );

    assert!(matches!(
        harness.review.decide(decide(&child, &item, "MySQL")).await,
        Err(review::Error::Conflict {
            reason: review::Conflict::Decided,
            ..
        })
    ));
    assert_eq!(answer_admissions(&harness.store, &child).len(), 1);
    assert_eq!(answered(&harness.store, &child), 1);
}

#[tokio::test]
async fn a_withdrawal_before_commit_leaves_no_decision_admission_or_task_answer() {
    let harness = harness();
    let (child, question) = waiting_child(&harness).await;
    let item = deferred(&harness, &child, &question).await;
    *harness.bridge.interference.lock().unwrap() = Some((Interference::Withdraw, question.clone()));
    let woken = harness.recorder.woken().len();

    assert!(matches!(
        harness
            .review
            .decide(decide(&child, &item, "Postgres"))
            .await,
        Err(review::Error::Conflict {
            reason: review::Conflict::Withdrawn,
            ..
        })
    ));

    assert_eq!(state(&harness, &child), State::Waiting);
    assert!(events(&harness.store, &child, DECIDED).is_empty());
    assert_eq!(answered(&harness.store, &child), 0);
    assert!(answer_admissions(&harness.store, &child).is_empty());
    assert_eq!(harness.recorder.woken().len(), woken);
}

#[tokio::test]
async fn a_concurrent_deferral_before_commit_retries_and_answers_exactly_once() {
    let harness = harness();
    let (child, question) = waiting_child(&harness).await;
    let item = deferred(&harness, &child, &question).await;
    *harness.bridge.interference.lock().unwrap() = Some((Interference::Defer, question.clone()));

    harness
        .review
        .decide(decide(&child, &item, "Postgres"))
        .await
        .unwrap();

    assert_eq!(state(&harness, &child), State::Running);
    assert_eq!(events(&harness.store, &child, DECIDED).len(), 1);
    assert_eq!(answered(&harness.store, &child), 1);
    assert_eq!(answer_admissions(&harness.store, &child).len(), 1);
}

#[tokio::test]
async fn cancelling_a_waiting_child_withdraws_its_open_question_items_with_the_cancel_request() {
    let harness = harness();
    let (child, question) = waiting_child(&harness).await;
    let item = deferred(&harness, &child, &question).await;
    harness
        .orchestration
        .cancel(&id("ses_one"), &child)
        .await
        .unwrap();

    assert_eq!(state(&harness, &child), State::Cancelled);
    assert!(!harness.review.has_open(&child).unwrap());
    let withdrawn = events(&harness.store, &child, WITHDRAWN);
    assert_eq!(withdrawn.len(), 1);
    assert_eq!(
        field(&withdrawn[0], "itemID"),
        Some(&JsonValue::String(item.as_lossless().clone()))
    );
    assert_eq!(
        field(&withdrawn[0], "reason"),
        Some(&JsonValue::String("task_closed".into()))
    );
    assert_eq!(
        ordered(&harness.store, &child),
        [
            WITHDRAWN.to_owned(),
            "cancel_requested".to_owned(),
            "cancelled".to_owned()
        ]
    );

    assert!(matches!(
        harness
            .review
            .decide(decide(&child, &item, "Postgres"))
            .await,
        Err(review::Error::Conflict {
            reason: review::Conflict::Withdrawn,
            ..
        })
    ));
    assert!(events(&harness.store, &child, DECIDED).is_empty());
    assert!(answer_admissions(&harness.store, &child).is_empty());
    assert_eq!(answered(&harness.store, &child), 0);

    harness
        .orchestration
        .cancel(&id("ses_one"), &child)
        .await
        .unwrap();
    assert_eq!(events(&harness.store, &child, WITHDRAWN).len(), 1);
}

#[tokio::test]
async fn cancelling_a_child_without_review_items_keeps_its_cancellation_order() {
    let harness = harness();
    let (child, _) = waiting_child(&harness).await;
    harness
        .orchestration
        .cancel(&id("ses_one"), &child)
        .await
        .unwrap();
    assert_eq!(state(&harness, &child), State::Cancelled);
    assert!(events(&harness.store, &child, WITHDRAWN).is_empty());
    assert_eq!(
        ordered(&harness.store, &child),
        ["cancel_requested".to_owned(), "cancelled".to_owned()]
    );
}

#[tokio::test]
async fn ordinary_answers_are_refused_while_the_review_box_owns_the_question() {
    let harness = harness();
    let (child, question) = waiting_child(&harness).await;
    deferred(&harness, &child, &question).await;
    let woken = harness.recorder.woken().len();

    let refused = harness
        .orchestration
        .answer(&id("ses_one"), &child, &question, Some("Postgres"), None)
        .await;
    assert!(matches!(refused, Err(Error::Conflict(_))), "{refused:?}");
    assert_eq!(state(&harness, &child), State::Waiting);
    assert!(answer_admissions(&harness.store, &child).is_empty());
    assert_eq!(answered(&harness.store, &child), 0);
    assert_eq!(harness.recorder.woken().len(), woken);

    harness
        .review
        .withdraw(&child, WithdrawReason::TaskClosed, 40)
        .await
        .unwrap();
    let answered_task = harness
        .orchestration
        .answer(&id("ses_one"), &child, &question, Some("Postgres"), None)
        .await
        .unwrap();
    assert_eq!(answered_task.state, State::Running);
    assert_eq!(answer_admissions(&harness.store, &child).len(), 1);
    assert_eq!(answered(&harness.store, &child), 1);
    assert_eq!(
        harness.recorder.woken()[woken..],
        [child.as_lossless().as_str().unwrap().to_owned()]
    );
    assert!(events(&harness.store, &child, DECIDED).is_empty());
}

#[tokio::test]
async fn ordinary_answers_to_unreviewed_questions_keep_their_existing_behavior() {
    let harness = harness();
    let (child, question) = waiting_child(&harness).await;
    let answered_task = harness
        .orchestration
        .answer(
            &id("ses_one"),
            &child,
            &question,
            None,
            Some(
                ycoding_schema::domain::Json::decode(&parse_json(r#"{"pick":1}"#).unwrap())
                    .unwrap(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(answered_task.state, State::Running);
    assert_eq!(answered(&harness.store, &child), 1);
    let admissions = answer_admissions(&harness.store, &child);
    assert_eq!(admissions.len(), 1);
    assert!(admissions[0].contains("pick"));
    assert!(matches!(
        harness
            .orchestration
            .answer(&id("ses_one"), &child, &question, Some("again"), None)
            .await,
        Err(Error::Conflict(_) | Error::QuestionNotFound { .. })
    ));
}
