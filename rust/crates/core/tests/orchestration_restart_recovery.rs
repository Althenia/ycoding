use std::{
    ops::Bound,
    sync::{Arc, Mutex, OnceLock},
};
use ycoding_core::{
    platform::shell::ledger,
    process::guardrails::{Guardrails, Limits, Paths, Settings},
    session::{
        orchestration::{Execution, LaunchInput, Prepared, Service as Orchestration},
        review::{
            self, ChildAnswer, Conflict, DecideInput, Delivery, DeliveryFuture, RecoveryResolution,
        },
        run_coordinator::{self, Outcome, RunFuture},
        store,
    },
    tools::policy::{Authority, Publisher, permissions::Permissions},
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, model, parse_json, permission, session,
    session_message::{self, AssistantContent, Info, ToolState},
    session_orchestration::{QuestionId, State},
    session_review::{Decision, Item, Kind, Origin, Payload, Reason, RecoveryChoice},
};
use ycoding_store::{
    KeyPart, Store,
    session::{EventTable, NewEvent, NotificationTable, SessionTable, TaskTable},
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

const NOT_RESUMED: &str =
    "The service restarted while the child task was active. Provider execution was not resumed.";
const NOT_RESUMED_AGAIN: &str = "The service restarted again before the recovered child task completed a step. Provider execution was not resumed.";
const RESUMED_EXCERPT: &str =
    "The service restarted while this subagent was working; it resumed with one recovery step.";

#[derive(Default)]
struct Recorder {
    woken: Mutex<Vec<String>>,
    resumed: Mutex<Vec<String>>,
    closed: Mutex<bool>,
}

impl Recorder {
    fn woken(&self) -> Vec<String> {
        self.woken.lock().unwrap().clone()
    }
    fn resumed(&self) -> Vec<String> {
        self.resumed.lock().unwrap().clone()
    }
}

impl Execution for Recorder {
    fn wake(&self, id: &session::Id) -> Outcome {
        self.woken.lock().unwrap().push(text(id.as_lossless()));
        Ok(())
    }
    fn interrupt(&self, _: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
    fn resume(&self, id: &session::Id) -> RunFuture {
        self.resumed.lock().unwrap().push(text(id.as_lossless()));
        let closed = *self.closed.lock().unwrap();
        Box::pin(async move {
            if closed {
                return Err(run_coordinator::Error::Closed);
            }
            Ok(())
        })
    }
}

#[derive(Default)]
struct Bridge(OnceLock<Orchestration>);

impl Delivery for Bridge {
    fn wake(&self, _: &session::Id) {}
    fn answer_child<'a>(&'a self, answer: ChildAnswer) -> DeliveryFuture<'a> {
        Box::pin(self.0.get().unwrap().answer_review(answer))
    }
    fn resolve_recovery<'a>(&'a self, resolution: RecoveryResolution) -> DeliveryFuture<'a> {
        Box::pin(self.0.get().unwrap().resolve_recovery(resolution))
    }
}

struct Harness {
    store: Store,
    sessions: store::Service,
    orchestration: Orchestration,
    review: review::Service,
    recorder: Arc<Recorder>,
}

fn harness() -> Harness {
    let store = support::store();
    let sessions = store::Service::new(store.client());
    let recorder = Arc::new(Recorder::default());
    let orchestration = Orchestration::new(sessions.clone(), recorder.clone());
    let bridge = Arc::new(Bridge::default());
    assert!(bridge.0.set(orchestration.clone()).is_ok());
    Harness {
        review: review::Service::new(sessions.clone(), bridge),
        store,
        sessions,
        orchestration,
        recorder,
    }
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap()
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

const CEILING: &str = r#"[{"action":"bash","resource":"*","effect":"deny"}]"#;

async fn launched(harness: &Harness, call: &str) -> session::Id {
    let child = harness
        .orchestration
        .launch(LaunchInput {
            parent_id: id("ses_one"),
            parent_assistant_message_id: session_message::Id::new("msg_parent").unwrap(),
            tool_call_id: call.into(),
            description: "Explore".into(),
            prompt: "Look around".into(),
            depth_limit: 1,
            prepared: Prepared {
                agent: "explore".into(),
                caller_permissions: permission::Ruleset::decode(&parse_json(CEILING).unwrap())
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
    harness.recorder.woken.lock().unwrap().clear();
    child
}

async fn event(harness: &Harness, session: &session::Id, type_: &str, label: &str, fields: &str) {
    let session_text = text(session.as_lossless());
    harness
        .sessions
        .publish(NewEvent {
            id: format!("evt_{label}_{}", &session_text[4..]).into(),
            aggregate_id: session.as_lossless().clone(),
            created: 70,
            type_: format!("{type_}.1").into(),
            data: parse_json(&format!(r#"{{"sessionID":"{session_text}"{fields}}}"#)).unwrap(),
        })
        .await
        .unwrap();
}

fn assistant_id(child: &session::Id) -> String {
    format!("msg_asst_{}", &text(child.as_lossless())[4..])
}

async fn change(harness: &Harness, child: &session::Id, label: &str, change: &str) {
    event(
        harness,
        child,
        "session.task.updated",
        label,
        &format!(r#","change":{change}"#),
    )
    .await;
}

async fn running(harness: &Harness, call: &str) -> session::Id {
    let child = launched(harness, call).await;
    harness.sessions.promote_steers(&child, 60).await.unwrap();
    if task_row(&harness.store, &child).state.as_str() == Some("starting") {
        change(harness, &child, "started", r#"{"type":"started"}"#).await;
    }
    event(
        harness,
        &child,
        "session.execution.started",
        "execution",
        "",
    )
    .await;
    let assistant = assistant_id(&child);
    event(
        harness,
        &child,
        "session.step.started",
        "step",
        &format!(
            r#","assistantMessageID":"{assistant}","agent":"explore","model":{{"providerID":"local","id":"test"}}"#
        ),
    )
    .await;
    child
}

async fn tool(harness: &Harness, child: &session::Id, call: &str, name: &str, called: bool) {
    let assistant = assistant_id(child);
    event(
        harness,
        child,
        "session.tool.input.started",
        &format!("input_{call}"),
        &format!(r#","assistantMessageID":"{assistant}","callID":"{call}","name":"{name}""#),
    )
    .await;
    if called {
        event(
            harness,
            child,
            "session.tool.called",
            &format!("called_{call}"),
            &format!(
                r#","assistantMessageID":"{assistant}","callID":"{call}","input":{{}},"executed":true"#
            ),
        )
        .await;
    }
}

async fn finished_tool(harness: &Harness, child: &session::Id, call: &str) {
    tool(harness, child, call, "read", true).await;
    let assistant = assistant_id(child);
    event(
        harness,
        child,
        "session.tool.success",
        &format!("success_{call}"),
        &format!(
            r#","assistantMessageID":"{assistant}","callID":"{call}","structured":{{}},"content":[],"executed":true"#
        ),
    )
    .await;
}

async fn crash(harness: &Harness) {
    harness.sessions.reconcile_interrupted(80).await.unwrap();
}

async fn dead_owner(harness: &Harness, child: &session::Id) {
    let mut row = task_row(&harness.store, child);
    row.owner_pid = Some(2_000_000_000);
    row.owner_started = Some("dead".into());
    harness
        .store
        .submit(move |tx| TaskTable::put(tx, &row))
        .unwrap()
        .await
        .unwrap();
}

async fn starting_child(harness: &Harness, call: &str) -> session::Id {
    let child = launched(harness, call).await;
    let mut row = task_row(&harness.store, &child);
    row.state = "starting".into();
    harness
        .store
        .submit(move |tx| TaskTable::put(tx, &row))
        .unwrap()
        .await
        .unwrap();
    child
}

async fn recover(harness: &Harness) -> usize {
    harness
        .orchestration
        .recover_restart_with_processes(|| async { Ok(Vec::new()) })
        .await
        .unwrap()
}

fn task_row(store: &Store, child: &session::Id) -> ycoding_store::session::Task {
    store
        .snapshot()
        .unwrap()
        .get::<TaskTable>(&tuple_key(&[KeyPart::String(child.as_lossless())]))
        .unwrap()
        .unwrap()
}

fn state(harness: &Harness, child: &session::Id) -> State {
    harness
        .orchestration
        .get(&id("ses_one"), child)
        .unwrap()
        .state
}

fn events(store: &Store, session: &session::Id, type_: &str) -> Vec<(LosslessString, JsonValue)> {
    let mut rows = store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
        .into_iter()
        .filter(|row| {
            &row.aggregate_id == session.as_lossless() && row.type_.as_str() == Some(type_)
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| row.seq);
    rows.into_iter().map(|row| (row.id, row.data)).collect()
}

fn field<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a JsonValue> {
    path.iter().try_fold(value, |value, name| match value {
        JsonValue::Object(object) => object.get(&(*name).into()),
        _ => None,
    })
}

fn string(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(value)) => value.to_utf8().ok(),
        _ => None,
    }
}

fn changes(store: &Store, child: &session::Id) -> Vec<String> {
    events(store, child, "session.task.updated.1")
        .iter()
        .filter_map(|(_, data)| string(field(data, &["change", "type"])))
        .collect()
}

fn notices(store: &Store, child: &session::Id) -> Vec<ycoding_store::session::Notification> {
    store
        .snapshot()
        .unwrap()
        .scan::<NotificationTable>(Bound::Unbounded, Bound::Unbounded, 100)
        .unwrap()
        .into_iter()
        .filter(|notice| &notice.task_session_id == child.as_lossless())
        .collect()
}

fn tools(harness: &Harness, child: &session::Id) -> Vec<session_message::AssistantTool> {
    match harness.sessions.latest(child, "assistant").unwrap() {
        Some(Info::Assistant(assistant)) => assistant
            .content
            .into_iter()
            .filter_map(|part| match part {
                AssistantContent::Tool(tool) => Some(*tool),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn provider_starts(store: &Store, child: &session::Id) -> usize {
    events(store, child, "session.step.started.1").len()
}

fn tool_calls(store: &Store, child: &session::Id) -> usize {
    events(store, child, "session.tool.called.1").len()
}

fn items(harness: &Harness, child: &session::Id) -> Vec<Item> {
    harness
        .review
        .list(child)
        .unwrap()
        .into_iter()
        .filter(|item| &item.session_id == child)
        .collect()
}

async fn decide(
    harness: &Harness,
    child: &session::Id,
    item: &Item,
    choice: RecoveryChoice,
) -> Result<(), review::Error> {
    harness
        .review
        .decide(DecideInput {
            session_id: child.clone(),
            item_id: item.deferral.item_id.clone(),
            decision: Decision::Recovery { choice },
            now: 90,
        })
        .await
}

async fn held(harness: &Harness, call: &str) -> (session::Id, Item) {
    let child = running(harness, call).await;
    tool(harness, &child, &format!("{call}_write"), "write", true).await;
    crash(harness).await;
    dead_owner(harness, &child).await;
    assert_eq!(recover(harness).await, 1);
    let mut open = items(harness, &child);
    assert_eq!(open.len(), 1);
    (child, open.remove(0))
}

#[tokio::test]
async fn an_interrupted_child_without_uncertain_tools_resumes_once_from_projected_history() {
    let harness = harness();
    let child = running(&harness, "call_resume").await;
    finished_tool(&harness, &child, "call_read").await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;
    let revision = task_row(&harness.store, &child).revision;
    let steps = provider_starts(&harness.store, &child);
    let calls = tool_calls(&harness.store, &child);

    assert_eq!(recover(&harness).await, 1);

    assert_eq!(state(&harness, &child), State::Running);
    assert_eq!(harness.recorder.resumed(), [text(child.as_lossless())]);
    assert!(harness.recorder.woken().is_empty());
    let row = task_row(&harness.store, &child);
    assert_eq!(row.revision, revision + 1);
    assert_eq!(row.attempt_started, 0);
    let identity = ledger::identify(std::process::id()).await.unwrap();
    assert_eq!(row.owner_pid, Some(i64::from(identity.pid)));
    assert_eq!(row.owner_started, Some(identity.started.into()));
    let resumed = events(&harness.store, &child, "session.task.updated.1")
        .into_iter()
        .filter(|(_, data)| string(field(data, &["change", "type"])).as_deref() == Some("resumed"))
        .collect::<Vec<_>>();
    assert_eq!(resumed.len(), 1);
    assert_eq!(
        text(&resumed[0].0),
        format!(
            "evt_task_restart_resumed_{}_{}",
            text(child.as_lossless()),
            revision + 1
        )
    );
    let resumed_notices = notices(&harness.store, &child)
        .into_iter()
        .filter(|notice| notice.type_.as_str() == Some("resumed"))
        .collect::<Vec<_>>();
    assert_eq!(resumed_notices.len(), 1);
    assert_eq!(
        resumed_notices[0].excerpt.as_ref().map(text).as_deref(),
        Some(RESUMED_EXCERPT)
    );
    assert_eq!(provider_starts(&harness.store, &child), steps);
    assert_eq!(tool_calls(&harness.store, &child), calls);
    assert!(harness.sessions.pending_list(&child).unwrap().is_empty());
    assert!(items(&harness, &child).is_empty());
}

#[tokio::test]
async fn a_second_restart_before_the_recovered_step_completes_loses_the_child_without_resuming() {
    let harness = harness();
    let child = running(&harness, "call_again").await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;
    assert_eq!(recover(&harness).await, 1);
    assert_eq!(harness.recorder.resumed().len(), 1);

    event(
        &harness,
        &child,
        "session.execution.started",
        "execution_again",
        "",
    )
    .await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;
    assert_eq!(recover(&harness).await, 1);

    assert_eq!(state(&harness, &child), State::Lost);
    assert_eq!(harness.recorder.resumed().len(), 1);
    let lost = notices(&harness.store, &child)
        .into_iter()
        .filter(|notice| notice.type_.as_str() == Some("lost"))
        .collect::<Vec<_>>();
    assert_eq!(lost.len(), 1);
    assert_eq!(
        lost[0].excerpt.as_ref().map(text).as_deref(),
        Some(NOT_RESUMED_AGAIN)
    );
}

#[tokio::test]
async fn a_completed_recovery_step_allows_a_later_restart_to_resume_again() {
    let harness = harness();
    let child = running(&harness, "call_progress").await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;
    assert_eq!(recover(&harness).await, 1);

    event(
        &harness,
        &child,
        "session.execution.started",
        "execution_next",
        "",
    )
    .await;
    let assistant = format!("{}_next", assistant_id(&child));
    event(
        &harness,
        &child,
        "session.step.started",
        "step_next",
        &format!(
            r#","assistantMessageID":"{assistant}","agent":"explore","model":{{"providerID":"local","id":"test"}}"#
        ),
    )
    .await;
    event(
        &harness,
        &child,
        "session.step.ended",
        "step_next_ended",
        &format!(r#","assistantMessageID":"{assistant}","finish":"tool-calls","cost":0,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#),
    )
    .await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;
    assert_eq!(recover(&harness).await, 1);

    assert_eq!(state(&harness, &child), State::Running);
    assert_eq!(harness.recorder.resumed().len(), 2);
}

#[tokio::test]
async fn streaming_tool_inputs_fail_unexecuted_before_the_child_resumes() {
    let harness = harness();
    let child = running(&harness, "call_streaming").await;
    tool(&harness, &child, "call_partial", "edit", false).await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;

    assert_eq!(recover(&harness).await, 1);

    let partial = tools(&harness, &child)
        .into_iter()
        .find(|tool| tool.id == "call_partial".into())
        .unwrap();
    let ToolState::Error(error) = &partial.state else {
        panic!("incomplete input was not failed: {:?}", partial.state);
    };
    assert_eq!(error.error.r#type, "tool.input-json".into());
    assert_eq!(partial.executed, Some(false));
    assert_eq!(tool_calls(&harness.store, &child), 0);
    assert_eq!(state(&harness, &child), State::Running);
    assert_eq!(harness.recorder.resumed(), [text(child.as_lossless())]);
    assert!(items(&harness, &child).is_empty());
}

#[tokio::test]
async fn uncertain_dispatched_tools_hold_the_child_for_a_human_only_recovery_decision() {
    let harness = harness();
    let child = running(&harness, "call_uncertain").await;
    finished_tool(&harness, &child, "call_done").await;
    tool(&harness, &child, "call_write", "write", true).await;
    tool(&harness, &child, "call_shell", "bash", true).await;
    tool(&harness, &child, "call_partial", "edit", false).await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;
    let revision = task_row(&harness.store, &child).revision;
    let calls = tool_calls(&harness.store, &child);
    let steps = provider_starts(&harness.store, &child);

    assert_eq!(recover(&harness).await, 1);

    assert!(harness.recorder.resumed().is_empty());
    assert!(harness.recorder.woken().is_empty());
    assert_eq!(tool_calls(&harness.store, &child), calls);
    assert_eq!(provider_starts(&harness.store, &child), steps);
    let parts = tools(&harness, &child);
    for call in ["call_write", "call_shell"] {
        let part = parts.iter().find(|tool| tool.id == call.into()).unwrap();
        let ToolState::Error(error) = &part.state else {
            panic!("{call} was not settled: {:?}", part.state);
        };
        assert_eq!(error.error.r#type, "aborted".into());
        assert_eq!(part.executed, Some(true));
    }
    let partial = parts
        .iter()
        .find(|tool| tool.id == "call_partial".into())
        .unwrap();
    assert!(
        matches!(&partial.state, ToolState::Error(error) if error.error.r#type == "tool.input-json".into())
    );
    assert!(matches!(
        &parts
            .iter()
            .find(|tool| tool.id == "call_done".into())
            .unwrap()
            .state,
        ToolState::Completed(_)
    ));

    let row = task_row(&harness.store, &child);
    assert_eq!(state(&harness, &child), State::Waiting);
    assert_eq!(row.revision, revision + 1);
    let question = row.question_id.clone().unwrap();
    assert_eq!(text(&question).len(), "qst_".len() + 24);
    assert!(text(&question).starts_with("qst_"));
    let asked = text(row.question.as_ref().unwrap());
    assert!(asked.contains("write, bash"), "{asked}");
    assert!(asked.contains("The user must choose Continue or Stop"));

    let open = items(&harness, &child);
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].deferral.kind, Kind::Recovery);
    assert_eq!(open[0].deferral.reason, Reason::Restart);
    assert_eq!(
        open[0].deferral.origin,
        Origin::Question {
            question_id: QuestionId(question.clone())
        }
    );
    let Payload::Recovery(payload) = &open[0].deferral.payload else {
        panic!("recovery payload expected");
    };
    assert_eq!(
        payload
            .tools
            .iter()
            .map(|tool| (
                text(tool.message_id.as_lossless()),
                text(&tool.call_id),
                text(&tool.name)
            ))
            .collect::<Vec<_>>(),
        [
            (assistant_id(&child), "call_write".into(), "write".into()),
            (assistant_id(&child), "call_shell".into(), "bash".into()),
        ]
    );
    assert!(harness.review.has_open(&id("ses_one")).unwrap());

    let answered = harness
        .orchestration
        .answer(
            &id("ses_one"),
            &child,
            &QuestionId(question.clone()),
            Some("Continue"),
            None,
        )
        .await;
    assert!(
        answered.is_err(),
        "the parent answered a human-only recovery"
    );
    assert_eq!(state(&harness, &child), State::Waiting);

    assert_eq!(
        recover(&harness).await,
        0,
        "a held child is not recovered twice"
    );
    assert_eq!(items(&harness, &child).len(), 1);
}

#[tokio::test]
async fn continue_on_the_open_hold_answers_once_with_a_provenance_input_and_no_tool_replay() {
    let harness = harness();
    let (child, item) = held(&harness, "call_continue").await;
    let calls = tool_calls(&harness.store, &child);
    let question = task_row(&harness.store, &child).question_id.unwrap();

    decide(&harness, &child, &item, RecoveryChoice::Continue)
        .await
        .unwrap();

    assert_eq!(state(&harness, &child), State::Running);
    assert_eq!(harness.recorder.woken(), [text(child.as_lossless())]);
    assert!(harness.recorder.resumed().is_empty());
    assert_eq!(tool_calls(&harness.store, &child), calls);
    let answered = events(&harness.store, &child, "session.task.updated.1")
        .into_iter()
        .filter(|(_, data)| {
            string(field(data, &["change", "type"])).as_deref() == Some("question_answered")
        })
        .collect::<Vec<_>>();
    assert_eq!(answered.len(), 1);
    assert_eq!(
        string(field(&answered[0].1, &["change", "answer", "questionID"])),
        Some(text(&question))
    );
    assert_eq!(
        string(field(&answered[0].1, &["change", "answer", "text"])).as_deref(),
        Some("Continue")
    );
    let pending = harness.sessions.pending_list(&child).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        &pending[0].id,
        review::prompt_id(&item.deferral.item_id).as_lossless()
    );
    let admitted = events(&harness.store, &child, "session.input.admitted.1");
    let input = &admitted.last().unwrap().1;
    assert_eq!(
        string(field(input, &["input", "type"])).as_deref(),
        Some("synthetic")
    );
    assert_eq!(
        string(field(input, &["input", "delivery"])).as_deref(),
        Some("steer")
    );
    assert_eq!(
        string(field(input, &["input", "data", "description"])).as_deref(),
        Some("Restart recovery · continue")
    );
    assert!(
        string(field(input, &["input", "data", "text"]))
            .unwrap()
            .contains("they were not retried")
    );
    assert_eq!(
        string(field(
            input,
            &["input", "data", "metadata", "review", "itemID"]
        )),
        Some(text(item.deferral.item_id.as_lossless()))
    );
    assert_eq!(
        string(field(
            input,
            &["input", "data", "metadata", "review", "kind"]
        ))
        .as_deref(),
        Some("recovery")
    );
    assert!(items(&harness, &child).is_empty());

    let repeated = decide(&harness, &child, &item, RecoveryChoice::Continue).await;
    assert!(matches!(
        repeated,
        Err(review::Error::Conflict {
            reason: Conflict::Decided,
            ..
        })
    ));
    let stopped = decide(&harness, &child, &item, RecoveryChoice::Stop).await;
    assert!(stopped.is_err());
    assert_eq!(harness.recorder.woken().len(), 1);
    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 1);
    assert_eq!(state(&harness, &child), State::Running);
}

#[tokio::test]
async fn stop_loses_the_child_and_only_one_later_human_continue_restarts_it() {
    let harness = harness();
    let (child, item) = held(&harness, "call_stop").await;

    decide(&harness, &child, &item, RecoveryChoice::Stop)
        .await
        .unwrap();

    assert_eq!(state(&harness, &child), State::Lost);
    assert!(harness.recorder.woken().is_empty());
    assert!(harness.sessions.pending_list(&child).unwrap().is_empty());
    let lost = notices(&harness.store, &child)
        .into_iter()
        .filter(|notice| notice.type_.as_str() == Some("lost"))
        .collect::<Vec<_>>();
    assert_eq!(lost.len(), 1);
    let excerpt = lost[0].excerpt.as_ref().map(text).unwrap();
    assert!(
        excerpt.contains("The user stopped this subagent"),
        "{excerpt}"
    );
    assert!(excerpt.contains("Only the user can continue it"));

    let sent = harness
        .orchestration
        .send(
            &id("ses_one"),
            &child,
            &session_message::Id::new("msg_parent_after_stop").unwrap(),
            "keep going",
            "steer",
        )
        .await;
    assert!(sent.is_err(), "the parent restarted a user-stopped child");
    assert!(harness.sessions.pending_list(&child).unwrap().is_empty());
    assert_eq!(recover(&harness).await, 0);
    assert!(harness.recorder.woken().is_empty() && harness.recorder.resumed().is_empty());

    decide(&harness, &child, &item, RecoveryChoice::Continue)
        .await
        .unwrap();

    assert_eq!(state(&harness, &child), State::Running);
    assert_eq!(harness.recorder.woken(), [text(child.as_lossless())]);
    assert_eq!(
        harness
            .sessions
            .pending_list(&child)
            .unwrap()
            .iter()
            .map(|pending| pending.id.clone())
            .collect::<Vec<_>>(),
        [review::prompt_id(&item.deferral.item_id)
            .as_lossless()
            .clone()]
    );
    assert_eq!(
        changes(&harness.store, &child)
            .iter()
            .rev()
            .take(2)
            .cloned()
            .collect::<Vec<_>>(),
        ["started", "lost"]
    );
    let decided = events(&harness.store, &child, "session.review.decided.1");
    assert_eq!(decided.len(), 2);

    for choice in [RecoveryChoice::Continue, RecoveryChoice::Stop] {
        assert!(decide(&harness, &child, &item, choice).await.is_err());
    }
    assert_eq!(harness.recorder.woken().len(), 1);
    assert_eq!(
        events(&harness.store, &child, "session.review.decided.1").len(),
        2
    );
}

#[tokio::test]
async fn a_continued_hold_is_not_reopened_by_a_later_restart() {
    let harness = harness();
    let (child, item) = held(&harness, "call_continued").await;
    decide(&harness, &child, &item, RecoveryChoice::Continue)
        .await
        .unwrap();
    harness.sessions.promote_steers(&child, 95).await.unwrap();
    event(
        &harness,
        &child,
        "session.execution.started",
        "execution_after",
        "",
    )
    .await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;

    assert_eq!(recover(&harness).await, 1);

    assert!(items(&harness, &child).is_empty());
    assert_eq!(state(&harness, &child), State::Running);
    assert_eq!(harness.recorder.resumed(), [text(child.as_lossless())]);
}

#[tokio::test]
async fn recovery_decisions_reject_mismatched_or_settled_tasks() {
    let harness = harness();
    let (child, item) = held(&harness, "call_cancelled").await;
    harness
        .orchestration
        .cancel(&id("ses_one"), &child)
        .await
        .unwrap();

    let decided = decide(&harness, &child, &item, RecoveryChoice::Continue).await;

    assert!(decided.is_err());
    assert!(harness.recorder.woken().is_empty());
    assert!(harness.sessions.pending_list(&child).unwrap().is_empty());
    assert_eq!(state(&harness, &child), State::Cancelled);
}

#[tokio::test]
async fn live_owners_root_sessions_and_unrelated_children_are_never_recovered() {
    let harness = harness();
    let live = running(&harness, "call_live").await;
    tool(&harness, &live, "call_live_write", "write", true).await;
    let settled = running(&harness, "call_settled").await;
    event(
        &harness,
        &settled,
        "session.step.ended",
        "settled_step",
        &format!(
            r#","assistantMessageID":"{}","finish":"stop","cost":0,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#,
            assistant_id(&settled)
        ),
    )
    .await;
    harness
        .orchestration
        .settle(
            &settled,
            ycoding_core::session::orchestration::Settlement::Completed { excerpt: None },
        )
        .await
        .unwrap();
    event(
        &harness,
        &id("ses_one"),
        "session.execution.started",
        "root",
        "",
    )
    .await;
    crash(&harness).await;
    dead_owner(&harness, &settled).await;
    let live_before = task_row(&harness.store, &live);
    let settled_before = task_row(&harness.store, &settled);
    let root_before = harness
        .store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
        .unwrap()
        .unwrap();
    let owner = ledger::identify(std::process::id()).await.unwrap();

    let recovered = harness
        .orchestration
        .recover_restart_with_processes(move || async move { Ok(vec![owner]) })
        .await
        .unwrap();

    assert_eq!(recovered, 0);
    assert_eq!(task_row(&harness.store, &live), live_before);
    assert_eq!(task_row(&harness.store, &settled), settled_before);
    assert!(items(&harness, &live).is_empty());
    assert!(harness.recorder.resumed().is_empty());
    assert!(harness.recorder.woken().is_empty());
    let root_after = harness
        .store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
        .unwrap()
        .unwrap();
    assert_eq!(root_after.permission, root_before.permission);
    assert!(!harness.recorder.resumed().contains(&"ses_one".to_owned()));
}

#[tokio::test]
async fn resumption_preserves_the_child_permission_ceiling_and_parent_ownership() {
    let harness = harness();
    let child = running(&harness, "call_ceiling").await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;
    let session = |harness: &Harness| {
        harness
            .store
            .snapshot()
            .unwrap()
            .get::<SessionTable>(&tuple_key(&[KeyPart::String(child.as_lossless())]))
            .unwrap()
            .unwrap()
    };
    let before = session(&harness);

    assert_eq!(recover(&harness).await, 1);

    let after = session(&harness);
    assert_eq!(after.permission, before.permission);
    assert!(after.permission.is_some());
    assert_eq!(after.parent_id, Some("ses_one".into()));
    let row = task_row(&harness.store, &child);
    assert_eq!(row.parent_id, "ses_one".into());
    assert_eq!(row.agent, "explore".into());
    assert!(harness.orchestration.get(&id("ses_two"), &child).is_err());
    assert_eq!(harness.recorder.resumed(), [text(child.as_lossless())]);
}

#[tokio::test]
async fn waiting_questions_restore_unchanged_while_other_active_states_settle_without_replay() {
    let harness = harness();
    let waiting = running(&harness, "call_waiting").await;
    let asked = harness
        .orchestration
        .question(&waiting, "Which database?", None)
        .await
        .unwrap();
    let cancelling = running(&harness, "call_cancelling").await;
    change(
        &harness,
        &cancelling,
        "cancel_requested",
        r#"{"type":"cancel_requested"}"#,
    )
    .await;
    let starting = starting_child(&harness, "call_starting").await;
    let idle = starting_child(&harness, "call_idle").await;
    harness.sessions.promote_steers(&idle, 60).await.unwrap();
    let quiet = running(&harness, "call_quiet").await;
    event(
        &harness,
        &quiet,
        "session.step.ended",
        "quiet_step",
        &format!(
            r#","assistantMessageID":"{}","finish":"tool-calls","cost":0,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#,
            assistant_id(&quiet)
        ),
    )
    .await;
    event(
        &harness,
        &quiet,
        "session.execution.succeeded",
        "quiet_done",
        "",
    )
    .await;
    for child in [&waiting, &cancelling, &starting, &idle, &quiet] {
        dead_owner(&harness, child).await;
    }
    crash(&harness).await;
    let waiting_before = task_row(&harness.store, &waiting);
    let tasks_before = harness.orchestration.list(&id("ses_one")).unwrap().len();

    assert_eq!(recover(&harness).await, 4);

    assert_eq!(task_row(&harness.store, &waiting), waiting_before);
    assert_eq!(state(&harness, &waiting), State::Waiting);
    assert_eq!(
        task_row(&harness.store, &waiting).question_id,
        Some(asked.question.id.0.clone())
    );
    harness
        .orchestration
        .answer(
            &id("ses_one"),
            &waiting,
            &asked.question.id,
            Some("Postgres"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(state(&harness, &cancelling), State::Lost);
    assert_eq!(state(&harness, &starting), State::Running);
    assert_eq!(state(&harness, &idle), State::Lost);
    assert_eq!(state(&harness, &quiet), State::Lost);
    for child in [&cancelling, &idle, &quiet] {
        let lost = notices(&harness.store, child)
            .into_iter()
            .filter(|notice| notice.type_.as_str() == Some("lost"))
            .collect::<Vec<_>>();
        assert_eq!(lost.len(), 1);
        assert_eq!(
            lost[0].excerpt.as_ref().map(text).as_deref(),
            Some(NOT_RESUMED)
        );
    }
    assert!(
        harness
            .recorder
            .woken()
            .contains(&text(starting.as_lossless()))
    );
    assert!(harness.recorder.resumed().is_empty());
    assert_eq!(
        harness.orchestration.list(&id("ses_one")).unwrap().len(),
        tasks_before
    );
    assert_eq!(
        notices(&harness.store, &waiting)
            .iter()
            .filter(|notice| notice.type_.as_str() == Some("question"))
            .count(),
        1
    );
}

#[tokio::test]
async fn an_interrupted_child_with_a_final_answer_and_no_pending_work_completes_without_a_step() {
    let harness = harness();
    let child = running(&harness, "call_final").await;
    let assistant = assistant_id(&child);
    event(
        &harness,
        &child,
        "session.text.started",
        "final_text_started",
        &format!(r#","assistantMessageID":"{assistant}","ordinal":0"#),
    )
    .await;
    event(
        &harness,
        &child,
        "session.text.ended",
        "final_text",
        &format!(
            r#","assistantMessageID":"{assistant}","ordinal":0,"text":"All findings recorded.""#
        ),
    )
    .await;
    event(
        &harness,
        &child,
        "session.step.ended",
        "final_step",
        &format!(r#","assistantMessageID":"{assistant}","finish":"stop","cost":0,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#),
    )
    .await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;

    assert_eq!(recover(&harness).await, 1);

    assert_eq!(state(&harness, &child), State::Completed);
    assert!(harness.recorder.resumed().is_empty());
    assert!(harness.recorder.woken().is_empty());
    let completed = events(&harness.store, &child, "session.task.updated.1")
        .into_iter()
        .filter(|(_, data)| {
            string(field(data, &["change", "type"])).as_deref() == Some("completed")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        string(field(&completed[0].1, &["change", "excerpt"])).as_deref(),
        Some("All findings recorded.")
    );
}

#[tokio::test]
async fn a_graceful_shutdown_counts_as_interrupted_only_for_suspended_sessions() {
    let harness = harness();
    let suspended = running(&harness, "call_suspended").await;
    let unsuspended = running(&harness, "call_unsuspended").await;
    for child in [&suspended, &unsuspended] {
        event(
            &harness,
            child,
            "session.step.failed",
            "shutdown_step",
            &format!(
                r#","assistantMessageID":"{}","error":{{"type":"aborted","message":"stopped"}}"#,
                assistant_id(child)
            ),
        )
        .await;
        event(
            &harness,
            child,
            "session.execution.interrupted",
            "shutdown",
            r#","reason":"shutdown""#,
        )
        .await;
        dead_owner(&harness, child).await;
    }
    harness
        .sessions
        .suspend(std::slice::from_ref(&suspended), 85)
        .await
        .unwrap();

    assert_eq!(recover(&harness).await, 2);

    assert_eq!(state(&harness, &suspended), State::Running);
    assert_eq!(harness.recorder.resumed(), [text(suspended.as_lossless())]);
    assert_eq!(state(&harness, &unsuspended), State::Lost);
}

#[tokio::test]
async fn a_closed_executor_leaves_the_durable_resumption_for_the_next_restart_to_settle() {
    let harness = harness();
    *harness.recorder.closed.lock().unwrap() = true;
    let child = running(&harness, "call_closed").await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;

    assert_eq!(recover(&harness).await, 1);
    assert_eq!(harness.recorder.resumed(), [text(child.as_lossless())]);
    assert_eq!(state(&harness, &child), State::Running);

    dead_owner(&harness, &child).await;
    assert_eq!(recover(&harness).await, 1);
    assert_eq!(state(&harness, &child), State::Lost);
    assert_eq!(harness.recorder.resumed().len(), 1);
}

#[tokio::test]
async fn a_process_listing_failure_defers_recovery_without_changes() {
    let harness = harness();
    let child = running(&harness, "call_unlisted").await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;
    let before = task_row(&harness.store, &child);

    let recovered = harness
        .orchestration
        .recover_restart_with_processes(|| async {
            Err(std::io::Error::other("process listing unavailable"))
        })
        .await
        .unwrap();

    assert_eq!(recovered, 0);
    assert_eq!(task_row(&harness.store, &child), before);
    assert!(harness.recorder.resumed().is_empty());
}

#[tokio::test]
async fn pending_work_recovery_never_restarts_a_user_stopped_child() {
    let harness = harness();
    let (child, item) = held(&harness, "call_stopped_pending").await;
    decide(&harness, &child, &item, RecoveryChoice::Stop)
        .await
        .unwrap();
    harness
        .sessions
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new("msg_stopped_pending").unwrap(),
            session_id: child.clone(),
            input: ycoding_schema::session_pending::Message::decode(
                &parse_json(r#"{"type":"user","data":{"text":"work"},"delivery":"steer"}"#)
                    .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_msg_stopped_pending").unwrap(),
            created: 96,
        })
        .await
        .unwrap();

    assert_eq!(harness.orchestration.recover().await.unwrap(), 0);

    assert_eq!(state(&harness, &child), State::Lost);
    assert!(harness.recorder.woken().is_empty());
    assert!(harness.recorder.resumed().is_empty());
}

#[tokio::test]
async fn recovery_holds_are_recorded_even_when_the_family_review_box_is_full() {
    let harness = harness();
    let request = review::OpenInput {
        session_id: id("ses_one"),
        kind: Kind::Question,
        reason: Reason::FreeText,
        choice: None,
        confidence: None,
        grades: None,
        origin: Origin::Request {
            request_id: "form_capacity".into(),
        },
        payload: Payload::decode(
            &parse_json(r#"{"type":"form","title":"Plan","fields":[{"key":"plan","type":"string","required":true}]}"#).unwrap(),
        ).unwrap(),
        limit: 1,
        conversion: false,
        created: 65,
    };
    harness.review.open(request.clone()).await.unwrap();
    assert!(matches!(
        harness.review.open(request).await,
        Err(review::Error::Full { limit: 1, .. })
    ));

    let (child, item) = held(&harness, "call_full").await;

    assert_eq!(item.deferral.kind, Kind::Recovery);
    assert_eq!(state(&harness, &child), State::Waiting);
    assert_eq!(harness.review.list(&id("ses_one")).unwrap().len(), 2);
    assert!(harness.recorder.resumed().is_empty());
    assert!(harness.recorder.woken().is_empty());
}

#[tokio::test]
async fn concurrent_continue_decisions_admit_and_settle_exactly_once() {
    let harness = harness();
    let (child, item) = held(&harness, "call_race").await;

    let (left, right) = tokio::join!(
        decide(&harness, &child, &item, RecoveryChoice::Continue),
        decide(&harness, &child, &item, RecoveryChoice::Continue),
    );

    assert_ne!(left.is_ok(), right.is_ok());
    assert_eq!(state(&harness, &child), State::Running);
    assert_eq!(harness.sessions.pending_list(&child).unwrap().len(), 1);
    assert_eq!(harness.recorder.woken().len(), 1);
    assert_eq!(
        events(&harness.store, &child, "session.review.decided.1").len(),
        1
    );
    assert_eq!(
        changes(&harness.store, &child)
            .iter()
            .filter(|kind| kind.as_str() == "question_answered")
            .count(),
        1
    );
}

#[tokio::test]
async fn an_input_identity_conflict_rolls_back_the_recovery_decision_and_task_transition() {
    let harness = harness();
    let (child, item) = held(&harness, "call_atomic").await;
    harness
        .sessions
        .admit(ycoding_core::session::pending::Request {
            id: review::prompt_id(&item.deferral.item_id),
            session_id: id("ses_two"),
            input: ycoding_schema::session_pending::Message::decode(
                &parse_json(r#"{"type":"user","data":{"text":"other input"},"delivery":"steer"}"#)
                    .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_other_review_input").unwrap(),
            created: 86,
        })
        .await
        .unwrap();
    let before = task_row(&harness.store, &child);

    assert!(
        decide(&harness, &child, &item, RecoveryChoice::Continue)
            .await
            .is_err()
    );

    assert_eq!(task_row(&harness.store, &child), before);
    assert_eq!(items(&harness, &child).len(), 1);
    assert!(harness.sessions.pending_list(&child).unwrap().is_empty());
    assert!(events(&harness.store, &child, "session.review.decided.1").is_empty());
    assert!(harness.recorder.woken().is_empty());
}

#[tokio::test]
async fn an_already_aborted_dispatched_tool_still_requires_human_recovery() {
    let harness = harness();
    let child = running(&harness, "call_aborted").await;
    tool(&harness, &child, "call_aborted_write", "write", true).await;
    event(
        &harness,
        &child,
        "session.tool.failed",
        "aborted_tool",
        &format!(
            r#","assistantMessageID":"{}","callID":"call_aborted_write","error":{{"type":"aborted","message":"shutdown"}},"executed":true"#,
            assistant_id(&child)
        ),
    ).await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;
    let failures = events(&harness.store, &child, "session.tool.failed.1").len();

    assert_eq!(recover(&harness).await, 1);

    assert_eq!(state(&harness, &child), State::Waiting);
    assert_eq!(items(&harness, &child).len(), 1);
    assert_eq!(
        events(&harness.store, &child, "session.tool.failed.1").len(),
        failures
    );
    assert!(harness.recorder.resumed().is_empty());
}

#[tokio::test]
async fn a_task_that_changes_during_process_discovery_is_not_recovered() {
    let harness = harness();
    let child = running(&harness, "call_fence").await;
    crash(&harness).await;
    dead_owner(&harness, &child).await;

    let recovered = harness
        .orchestration
        .recover_restart_with_processes(|| async {
            let mut row = task_row(&harness.store, &child);
            row.revision += 1;
            row.owner_pid = Some(i64::from(std::process::id()));
            row.owner_started = Some("replacement".into());
            harness
                .store
                .submit(move |tx| TaskTable::put(tx, &row))
                .unwrap()
                .await
                .unwrap();
            Ok(Vec::new())
        })
        .await
        .unwrap();

    assert_eq!(recovered, 0);
    assert_eq!(state(&harness, &child), State::Running);
    assert_eq!(
        task_row(&harness.store, &child).owner_started,
        Some("replacement".into())
    );
    assert!(harness.recorder.resumed().is_empty());
    assert!(harness.recorder.woken().is_empty());
}
