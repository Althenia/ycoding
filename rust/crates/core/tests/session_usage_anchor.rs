use std::{
    ops::Bound,
    sync::{Arc, Mutex},
};
use ycoding_core::{
    process::guardrails::{Guardrails, Limits, Paths, Settings},
    session::{
        autonomy,
        compaction_job::AdmitInput,
        orchestration::{Execution, LaunchInput, Prepared, Service},
        pending::{Promotion, Request},
        provider_request::{self, Begin, Completion, recorded_fields},
        run_coordinator::{Outcome, RunFuture},
        store, usage,
        usage_attribution::Attribution,
    },
    tools::policy::{Authority, Publisher, permissions::Permissions},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, model, parse_json, permission, session,
    session_message, session_pending,
};
use ycoding_store::{
    KeyPart, Store,
    resources::{RequestTable, UsageAnalyticsRequestTable},
    session::{
        Append, ContextState, ContextStateTable, EventTable, Message, MessageTable, NewEvent,
        Pending, PendingTable, Revision, RevisionTable, TaskTable, append,
    },
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

#[derive(Default)]
struct Recorder {
    woken: Mutex<Vec<String>>,
}

impl Execution for Recorder {
    fn resume(&self, _: &session::Id) -> RunFuture {
        panic!("unexpected explicit resumption")
    }

    fn wake(&self, id: &session::Id) -> Outcome {
        self.woken
            .lock()
            .unwrap()
            .push(id.as_lossless().as_str().unwrap().into());
        Ok(())
    }
    fn interrupt(&self, _: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

struct Harness {
    store: Store,
    sessions: store::Service,
    service: Service,
}

fn harness() -> Harness {
    let store = support::store();
    let sessions = store::Service::new(store.client());
    Harness {
        service: Service::new(sessions.clone(), Arc::new(Recorder::default())),
        store,
        sessions,
    }
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn message(value: &str) -> session_message::Id {
    session_message::Id::new(value).unwrap()
}

fn anchor(session: &str, input: &str) -> JsonValue {
    parse_json(&format!(
        r#"{{"sessionID":"{session}","inputID":"{input}"}}"#
    ))
    .unwrap()
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.into())
}

fn events(store: &Store, session: &str, kind: &str) -> Vec<JsonValue> {
    let mut rows = store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.aggregate_id.as_str() == Some(session) && event.type_.as_str() == Some(kind)
        })
        .map(|event| (event.seq, event.data))
        .collect::<Vec<_>>();
    rows.sort_by_key(|row| row.0);
    rows.into_iter().map(|row| row.1).collect()
}

fn admitted_for(store: &Store, session: &str, input: &str) -> JsonValue {
    events(store, session, "session.input.admitted.1")
        .into_iter()
        .find(|data| field(data, "inputID") == Some(&text(input)))
        .unwrap_or_else(|| panic!("no admitted event for {input}"))
}

fn task(store: &Store, child: &session::Id) -> ycoding_store::session::Task {
    store
        .snapshot()
        .unwrap()
        .get::<TaskTable>(&tuple_key(&[KeyPart::String(child.as_lossless())]))
        .unwrap()
        .unwrap()
}

fn user(text: &str) -> session_pending::Message {
    session_pending::Message::decode(
        &parse_json(&format!(
            r#"{{"type":"user","data":{{"text":"{text}"}},"delivery":"steer"}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

async fn prompt(harness: &Harness, session: &str, input: &str, created: i64) {
    harness
        .sessions
        .admit_input(Request {
            id: message(input),
            session_id: id(session),
            input: user("Work"),
            event_id: ycoding_schema::event::Id::new(format!("evt_{input}")).unwrap(),
            created,
        })
        .await
        .unwrap();
    assert_eq!(
        harness
            .sessions
            .promote_input(&id(session), message(input).as_lossless(), created + 1)
            .await
            .unwrap(),
        Promotion::Promoted
    );
}

fn guarded(store: &Store) -> Guardrails {
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

fn launch_input(harness: &Harness, call: &str, prompt: &str) -> LaunchInput {
    LaunchInput {
        parent_id: id("ses_one"),
        parent_assistant_message_id: message("msg_parent"),
        tool_call_id: call.into(),
        description: "Explore".into(),
        prompt: prompt.into(),
        depth_limit: 1,
        prepared: Prepared {
            agent: "explore".into(),
            caller_permissions: permission::Ruleset::decode(&parse_json("[]").unwrap()).unwrap(),
            model: model::Ref::decode(
                &parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
            )
            .unwrap(),
            profile_binding: None,
        },
        guardrails: guarded(&harness.store),
    }
}

async fn launched(harness: &Harness, call: &str, prompt: &str) -> session::Id {
    harness
        .service
        .launch(launch_input(harness, call, prompt))
        .await
        .unwrap()
        .session_id
}

fn launch_change(store: &Store, child: &session::Id) -> JsonValue {
    let data = events(
        store,
        child.as_lossless().as_str().unwrap(),
        "session.task.updated.1",
    )
    .into_iter()
    .find(|data| {
        field(data, "change").and_then(|change| field(change, "type")) == Some(&text("launched"))
    })
    .unwrap();
    field(&data, "change").unwrap().clone()
}

#[tokio::test]
async fn w40_parent_tool_dispatch_preserves_explicit_and_unset_attribution() {
    for attribution in [
        Attribution::Anchored(
            ycoding_schema::usage_anchor::Ref::decode(&anchor("ses_one", "msg_a")).unwrap(),
        ),
        Attribution::Unanchored,
        Attribution::Unset,
    ] {
        let harness = harness();
        prompt(&harness, "ses_one", "msg_a", 10).await;
        prompt(&harness, "ses_one", "msg_b", 20).await;
        let expected = match &attribution {
            Attribution::Anchored(value) => Some(value.encode()),
            Attribution::Unanchored => None,
            Attribution::Unset => Some(anchor("ses_one", "msg_b")),
        };
        let child = harness
            .service
            .launch_attributed(
                launch_input(&harness, "call_ambient", "Explore"),
                &ycoding_core::tools::code_mode::Cancellation::default(),
                &attribution,
            )
            .await
            .unwrap()
            .session_id;
        let row = task(&harness.store, &child);
        assert_eq!(
            row.usage_anchor.as_ref().map(|value| value.value().clone()),
            expected
        );
        assert_eq!(
            field(&launch_change(&harness.store, &child), "usageAnchor"),
            expected.as_ref()
        );
        let child_name = child.as_lossless().as_str().unwrap();
        assert_eq!(
            field(
                &admitted_for(&harness.store, child_name, row.input_id.as_str().unwrap()),
                "causedBy"
            ),
            expected.as_ref()
        );
        harness
            .service
            .send_attributed(
                &id("ses_one"),
                &child,
                &message("msg_ambient_send"),
                "Continue",
                "steer",
                &attribution,
            )
            .await
            .unwrap();
        assert_eq!(
            field(
                &admitted_for(&harness.store, child_name, "msg_ambient_send"),
                "causedBy"
            ),
            expected.as_ref()
        );
        let asked = harness
            .service
            .question(&child, "Which option?", None)
            .await
            .unwrap();
        harness
            .service
            .answer_attributed(
                &id("ses_one"),
                &child,
                &asked.question.id,
                Some("A"),
                None,
                &attribution,
            )
            .await
            .unwrap();
        let admitted = events(&harness.store, child_name, "session.input.admitted.1");
        assert_eq!(
            field(admitted.last().unwrap(), "causedBy"),
            expected.as_ref()
        );
    }
}

#[tokio::test]
async fn w40_automatic_tool_answer_preserves_explicit_and_child_current_attribution() {
    for attribution in [
        Attribution::Anchored(
            ycoding_schema::usage_anchor::Ref::decode(&anchor("ses_one", "msg_a")).unwrap(),
        ),
        Attribution::Unanchored,
        Attribution::Unset,
    ] {
        let harness = harness();
        prompt(&harness, "ses_one", "msg_a", 10).await;
        let child = launched(&harness, "call_auto_ambient", "Explore").await;
        let row = task(&harness.store, &child);
        harness
            .sessions
            .promote_input(&child, &row.input_id, 20)
            .await
            .unwrap();
        let child_name = child.as_lossless().as_str().unwrap();
        prompt(&harness, child_name, "msg_child_current", 30).await;
        autonomy::Service::new(harness.store.client())
            .set_auto_answer(&child, true)
            .await
            .unwrap();
        let expected = match &attribution {
            Attribution::Anchored(value) => Some(value.encode()),
            Attribution::Unanchored => None,
            Attribution::Unset => Some(anchor(child_name, "msg_child_current")),
        };
        assert!(
            harness
                .service
                .question_attributed(&child, "Which option?", None, &attribution)
                .await
                .unwrap()
                .auto_answered
        );
        let admitted = events(&harness.store, child_name, "session.input.admitted.1");
        assert_eq!(
            field(admitted.last().unwrap(), "causedBy"),
            expected.as_ref()
        );
    }
}

#[tokio::test]
async fn a_launch_captures_the_parents_current_prompt_on_the_task_the_launch_fact_and_the_child_input()
 {
    let harness = harness();
    prompt(&harness, "ses_one", "msg_user_one", 10).await;
    let child = launched(&harness, "call_anchor", "Look around").await;
    let expected = anchor("ses_one", "msg_user_one");

    let row = task(&harness.store, &child);
    assert_eq!(
        row.usage_anchor
            .as_ref()
            .map(|anchor| anchor.value().clone()),
        Some(expected.clone())
    );
    assert_eq!(
        field(&launch_change(&harness.store, &child), "usageAnchor"),
        Some(&expected)
    );
    let child_input = admitted_for(
        &harness.store,
        child.as_lossless().as_str().unwrap(),
        row.input_id.as_str().unwrap(),
    );
    assert_eq!(field(&child_input, "causedBy"), Some(&expected));
}

#[tokio::test]
async fn a_launch_without_a_parent_prompt_has_no_anchor_anywhere() {
    let harness = harness();
    let child = launched(&harness, "call_none", "Look around").await;
    let row = task(&harness.store, &child);
    assert!(row.usage_anchor.is_none());
    assert_eq!(
        field(&launch_change(&harness.store, &child), "usageAnchor"),
        None
    );
    let child_input = admitted_for(
        &harness.store,
        child.as_lossless().as_str().unwrap(),
        row.input_id.as_str().unwrap(),
    );
    assert_eq!(field(&child_input, "causedBy"), None);
}

#[tokio::test]
async fn a_retried_launch_keeps_its_original_anchor_and_a_later_launch_takes_the_new_prompt() {
    let harness = harness();
    prompt(&harness, "ses_one", "msg_user_one", 10).await;
    let child = launched(&harness, "call_retry", "Look around").await;
    prompt(&harness, "ses_one", "msg_user_two", 20).await;

    assert_eq!(launched(&harness, "call_retry", "Look around").await, child);
    let row = task(&harness.store, &child);
    let first = anchor("ses_one", "msg_user_one");
    assert_eq!(
        row.usage_anchor
            .as_ref()
            .map(|anchor| anchor.value().clone()),
        Some(first.clone())
    );
    let inputs = events(
        &harness.store,
        child.as_lossless().as_str().unwrap(),
        "session.input.admitted.1",
    );
    assert_eq!(inputs.len(), 1);
    assert_eq!(field(&inputs[0], "causedBy"), Some(&first));

    let later = launched(&harness, "call_later", "Look around").await;
    assert_eq!(
        task(&harness.store, &later)
            .usage_anchor
            .as_ref()
            .map(|anchor| anchor.value().clone()),
        Some(anchor("ses_one", "msg_user_two"))
    );
}

#[tokio::test]
async fn parent_send_and_answer_capture_the_prompt_current_when_they_are_sent() {
    let harness = harness();
    prompt(&harness, "ses_one", "msg_user_one", 10).await;
    let child = launched(&harness, "call_send", "Look around").await;
    let child_name = child.as_lossless().as_str().unwrap().to_owned();

    prompt(&harness, "ses_one", "msg_user_two", 20).await;
    harness
        .service
        .send(&id("ses_one"), &child, &message("msg_send"), "hi", "steer")
        .await
        .unwrap();
    assert_eq!(
        field(
            &admitted_for(&harness.store, &child_name, "msg_send"),
            "causedBy"
        ),
        Some(&anchor("ses_one", "msg_user_two"))
    );

    let asked = harness
        .service
        .question(&child, "Which database?", None)
        .await
        .unwrap();
    prompt(&harness, "ses_one", "msg_user_three", 30).await;
    harness
        .service
        .answer(
            &id("ses_one"),
            &child,
            &asked.question.id,
            Some("Postgres"),
            None,
        )
        .await
        .unwrap();
    let answers = events(&harness.store, &child_name, "session.input.admitted.1")
        .into_iter()
        .filter(|data| {
            field(data, "inputID") != Some(&text("msg_send"))
                && field(data, "input").and_then(|input| field(input, "type"))
                    == Some(&text("synthetic"))
        })
        .collect::<Vec<_>>();
    let [answer] = answers.as_slice() else {
        panic!("expected one answer input, found {}", answers.len())
    };
    assert_eq!(
        field(answer, "causedBy"),
        Some(&anchor("ses_one", "msg_user_three"))
    );
}

#[tokio::test]
async fn the_anchor_never_changes_the_prompt_digest_or_the_child_input() {
    let anchored = harness();
    prompt(&anchored, "ses_one", "msg_user_one", 10).await;
    let plain = harness();
    let (with, without) = (
        launched(&anchored, "call_digest", "Look around").await,
        launched(&plain, "call_digest", "Look around").await,
    );
    assert_eq!(with, without);
    let (anchored_row, plain_row) = (task(&anchored.store, &with), task(&plain.store, &without));
    assert!(anchored_row.usage_anchor.is_some());
    assert!(plain_row.usage_anchor.is_none());
    assert_eq!(anchored_row.prompt_digest, plain_row.prompt_digest);
    let (a, b) = (
        launch_change(&anchored.store, &with),
        launch_change(&plain.store, &without),
    );
    for key in [
        "promptDigest",
        "inputID",
        "toolCallID",
        "description",
        "agent",
        "model",
    ] {
        assert_eq!(field(&a, key), field(&b, key), "{key}");
    }
    let name = with.as_lossless().as_str().unwrap();
    let input = anchored_row.input_id.as_str().unwrap();
    let (a, b) = (
        admitted_for(&anchored.store, name, input),
        admitted_for(&plain.store, name, input),
    );
    for key in ["sessionID", "inputID", "input"] {
        assert_eq!(field(&a, key), field(&b, key), "{key}");
    }
    let projected = |harness: &Harness| {
        let rendered = format!(
            "{:?}",
            harness
                .sessions
                .pending(&message(input))
                .unwrap()
                .map(|pending| pending.data)
        );
        assert!(!rendered.contains("causedBy") && !rendered.contains("usageAnchor"));
        rendered
    };
    assert_eq!(projected(&anchored), projected(&plain));
}

#[tokio::test]
async fn a_prompt_body_can_never_supply_its_own_anchor() {
    let harness = harness();
    let forged = parse_json(&format!(
        r#"{{"type":"user","data":{{"text":"Work"}},"delivery":"steer","causedBy":{}}}"#,
        r#"{"sessionID":"ses_two","inputID":"msg_forged"}"#
    ))
    .unwrap();
    let input = session_pending::Message::decode(&forged).unwrap();
    assert_eq!(field(&input.encode(), "causedBy"), None);
    harness
        .sessions
        .admit_input(Request {
            id: message("msg_forged_prompt"),
            session_id: id("ses_one"),
            input,
            event_id: ycoding_schema::event::Id::new("evt_forged_prompt").unwrap(),
            created: 10,
        })
        .await
        .unwrap();
    assert_eq!(
        field(
            &admitted_for(&harness.store, "ses_one", "msg_forged_prompt"),
            "causedBy"
        ),
        None
    );
}

fn recorded_event(id: &str, request: &str, anchor: Option<&str>) -> NewEvent {
    NewEvent {
        id: id.into(),
        aggregate_id: "ses_one".into(),
        type_: "session.provider.request.recorded.1".into(),
        created: 5000,
        data: parse_json(&format!(
            r#"{{"sessionID":"ses_one","id":"{request}","source":"step","agent":"build","model":{{"providerID":"openai","id":"gpt"}},"routeID":"test","promptCacheKey":"abcdefghijkl","systemDigest":"{}","toolDigest":"{}","request":1,"attempts":1,"invalidation":"first-request","continuation":"full","tokens":{{"input":1,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"time":5000{}}}"#,
            "b".repeat(64),
            "c".repeat(64),
            anchor.map_or_else(String::new, |anchor| format!(r#","usageAnchor":{anchor}"#))
        ))
        .unwrap(),
    }
}

fn ledger_anchor(store: &Store, request: &str) -> Option<Option<JsonValue>> {
    store
        .snapshot()
        .unwrap()
        .get::<RequestTable>(&tuple_key(&[KeyPart::String(&request.into())]))
        .unwrap()
        .map(|row| row.usage_anchor.map(|anchor| anchor.value().clone()))
}

fn fact_anchor(store: &Store, request: &str) -> Option<Option<JsonValue>> {
    store
        .snapshot()
        .unwrap()
        .get::<UsageAnalyticsRequestTable>(&tuple_key(&[KeyPart::String(&request.into())]))
        .unwrap()
        .map(|row| row.usage_anchor.map(|anchor| anchor.value().clone()))
}

#[tokio::test]
async fn a_recorded_request_stores_its_anchor_on_the_ledger_row_and_the_retained_fact_first_id_wins()
 {
    let harness = harness();
    let expected = anchor("ses_one", "msg_user_one");
    harness
        .sessions
        .publish(recorded_event(
            "evt_anchor_one",
            "prq_anchor_one",
            Some(r#"{"sessionID":"ses_one","inputID":"msg_user_one"}"#),
        ))
        .await
        .unwrap();
    assert_eq!(
        ledger_anchor(&harness.store, "prq_anchor_one"),
        Some(Some(expected.clone()))
    );
    assert_eq!(
        fact_anchor(&harness.store, "prq_anchor_one"),
        Some(Some(expected.clone()))
    );

    harness
        .sessions
        .publish(recorded_event(
            "evt_anchor_again",
            "prq_anchor_one",
            Some(r#"{"sessionID":"ses_one","inputID":"msg_user_two"}"#),
        ))
        .await
        .unwrap();
    assert_eq!(
        ledger_anchor(&harness.store, "prq_anchor_one"),
        Some(Some(expected.clone()))
    );
    assert_eq!(
        fact_anchor(&harness.store, "prq_anchor_one"),
        Some(Some(expected))
    );
}

#[tokio::test]
async fn an_old_recorded_payload_without_an_anchor_stays_unanchored() {
    let harness = harness();
    harness
        .sessions
        .publish(recorded_event("evt_old", "prq_old", None))
        .await
        .unwrap();
    assert_eq!(ledger_anchor(&harness.store, "prq_old"), Some(None));
    assert_eq!(fact_anchor(&harness.store, "prq_old"), Some(None));
}

#[tokio::test]
async fn an_invalid_recorded_anchor_is_rejected_without_any_partial_write() {
    let harness = harness();
    let before = events(
        &harness.store,
        "ses_one",
        "session.provider.request.recorded.1",
    )
    .len();
    for (index, invalid) in [
        "null",
        r#"{"sessionID":"ses_one"}"#,
        r#"{"sessionID":"msg_one","inputID":"msg_one"}"#,
        r#"{"sessionID":"ses_one","inputID":"msg_one","extra":1}"#,
        r#""ses_one""#,
    ]
    .into_iter()
    .enumerate()
    {
        let request = format!("prq_invalid_{index}");
        assert!(
            harness
                .sessions
                .publish(recorded_event(
                    &format!("evt_invalid_{index}"),
                    &request,
                    Some(invalid)
                ))
                .await
                .is_err(),
            "accepted {invalid}"
        );
        assert_eq!(ledger_anchor(&harness.store, &request), None);
        assert_eq!(fact_anchor(&harness.store, &request), None);
    }
    assert_eq!(
        events(
            &harness.store,
            "ses_one",
            "session.provider.request.recorded.1"
        )
        .len(),
        before
    );
}

fn begin(session: &str) -> Begin {
    Begin {
        session: id(session),
        model: model::Ref::decode(
            &parse_json(r#"{"providerID":"openai","id":"gpt-5.6"}"#).unwrap(),
        )
        .unwrap(),
        route_id: "openai-responses".into(),
        connection_identity_digest: None,
        prompt_cache_key: "a".repeat(64),
        system_digest: "b".repeat(64),
        tool_digest: "c".repeat(64),
    }
}

async fn finish(
    harness: &Harness,
    begin: &Begin,
    pending: &provider_request::Pending,
    source: &str,
    event: &str,
) -> JsonValue {
    let fields = recorded_fields(
        begin,
        pending,
        &Completion {
            source,
            agent: &"build".into(),
            invalidation: "provider-not-reported",
            continuation: "full",
            attempts: 1,
            cache_read_reported: None,
            timing: None,
            cost: None,
            tokens: &usage::tokens(None),
            time: 7,
        },
    )
    .unwrap();
    let JsonValue::Object(fields_object) = fields.clone() else {
        panic!()
    };
    let JsonValue::Object(mut data) = ObjectEncoder::new()
        .field("sessionID", &begin.session)
        .finish()
    else {
        panic!()
    };
    for (key, value) in fields_object.iter() {
        data.insert(key.clone(), value.clone());
    }
    harness
        .sessions
        .publish(NewEvent {
            id: event.into(),
            aggregate_id: begin.session.as_lossless().clone(),
            type_: "session.provider.request.recorded.1".into(),
            created: 7,
            data: JsonValue::Object(data),
        })
        .await
        .unwrap();
    fields
}

fn without(fields: &JsonValue, keys: &[&str]) -> Vec<(String, JsonValue)> {
    let JsonValue::Object(object) = fields else {
        panic!()
    };
    object
        .iter()
        .map(|(key, value)| (key.as_str().unwrap().to_owned(), value.clone()))
        .filter(|(key, _)| !keys.contains(&key.as_str()))
        .collect()
}

#[tokio::test]
async fn a_started_request_keeps_the_anchor_it_started_under_and_cache_identity_is_unchanged() {
    let harness = harness();
    let begin = begin("ses_one");
    let unanchored = harness
        .sessions
        .begin_provider_request(&begin)
        .await
        .unwrap();
    let before = finish(&harness, &begin, &unanchored, "step", "evt_rec_before").await;
    assert_eq!(
        ledger_anchor(
            &harness.store,
            unanchored.id.as_lossless().as_str().unwrap()
        ),
        Some(None)
    );
    assert_eq!(field(&before, "usageAnchor"), None);

    prompt(&harness, "ses_one", "msg_user_one", 10).await;
    let started = harness
        .sessions
        .begin_provider_request(&begin)
        .await
        .unwrap();
    prompt(&harness, "ses_one", "msg_user_two", 20).await;
    let first = finish(&harness, &begin, &started, "step", "evt_rec_first").await;
    assert_eq!(
        ledger_anchor(&harness.store, started.id.as_lossless().as_str().unwrap()),
        Some(Some(anchor("ses_one", "msg_user_one")))
    );
    assert_eq!(
        fact_anchor(&harness.store, started.id.as_lossless().as_str().unwrap()),
        Some(Some(anchor("ses_one", "msg_user_one")))
    );

    let next = harness
        .sessions
        .begin_provider_request(&begin)
        .await
        .unwrap();
    let second = finish(&harness, &begin, &next, "title", "evt_rec_second").await;
    assert_eq!(
        ledger_anchor(&harness.store, next.id.as_lossless().as_str().unwrap()),
        Some(Some(anchor("ses_one", "msg_user_two")))
    );

    let volatile = ["id", "request", "invalidation", "usageAnchor", "source"];
    assert_eq!(without(&before, &volatile), without(&first, &volatile));
    assert_eq!(without(&first, &volatile), without(&second, &volatile));
    for fields in [&before, &first, &second] {
        for key in ["promptCacheKey", "systemDigest", "toolDigest", "routeID"] {
            let value = field(fields, key).unwrap();
            assert!(!format!("{value:?}").contains("msg_user"), "{key}");
        }
        assert_eq!(
            field(fields, "promptCacheKey"),
            Some(&text(&"a".repeat(64)))
        );
    }
}

#[tokio::test]
async fn a_session_without_a_prompt_records_requests_without_an_anchor() {
    let harness = harness();
    prompt(&harness, "ses_one", "msg_user_one", 10).await;
    let begin = begin("ses_two");
    let pending = harness
        .sessions
        .begin_provider_request(&begin)
        .await
        .unwrap();
    let fields = finish(&harness, &begin, &pending, "step", "evt_rec_two").await;
    assert_eq!(field(&fields, "usageAnchor"), None);
    assert_eq!(
        ledger_anchor(&harness.store, pending.id.as_lossless().as_str().unwrap()),
        Some(None)
    );
}

async fn prepared_compaction() -> (Harness, session_message::Id, i64) {
    let harness = harness();
    harness
        .store
        .submit(|tx| {
            RevisionTable::insert(
                tx,
                &Revision {
                    session_id: "ses_one".into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            ContextStateTable::insert(
                tx,
                &ContextState {
                    session_id: "ses_one".into(),
                    status: "active".into(),
                    revision: 0,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activated_event_id: None,
                    time_activated: None,
                    error_code: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    prompt(&harness, "ses_one", "msg_input", 1).await;
    let seq = harness
        .store
        .snapshot()
        .unwrap()
        .get::<MessageTable>(&tuple_key(&[KeyPart::String(&"msg_input".into())]))
        .unwrap()
        .unwrap()
        .seq;
    (harness, message("msg_input"), seq)
}

fn admission(message: &session_message::Id, seq: i64) -> AdmitInput {
    AdmitInput {
        id: None,
        session: id("ses_one"),
        trigger: ycoding_schema::session_compaction::Trigger::Mandatory,
        requested_through_message: message.clone(),
        requested_through_seq: seq,
        base_context_revision: 0,
        target_max_input_tokens: 1000,
        config_digest: "c".repeat(64),
        pressure: None,
    }
}

#[tokio::test]
async fn a_compaction_admission_captures_the_current_prompt_on_the_job_and_its_event() {
    let (harness, message, seq) = prepared_compaction().await;
    let job = harness
        .sessions
        .compaction_admit(admission(&message, seq), 10)
        .await
        .unwrap();
    let expected = anchor("ses_one", "msg_input");
    assert_eq!(
        job.usage_anchor
            .as_ref()
            .map(|anchor| anchor.value().clone()),
        Some(expected.clone())
    );
    let admitted = events(&harness.store, "ses_one", "session.compaction.admitted.2");
    let [event] = admitted.as_slice() else {
        panic!("expected one admission event")
    };
    assert_eq!(field(event, "usageAnchor"), Some(&expected));

    let retried = harness
        .sessions
        .compaction_admit(admission(&message, seq), 11)
        .await
        .unwrap();
    assert_eq!(retried.id, job.id);
    assert_eq!(retried.usage_anchor, job.usage_anchor);
    assert_eq!(
        events(&harness.store, "ses_one", "session.compaction.admitted.2").len(),
        1
    );
}

async fn launch_event(
    anchor: Option<&str>,
) -> (
    Harness,
    Result<ycoding_store::session::Event, ycoding_store::Error>,
) {
    let harness = harness();
    let result = harness
        .sessions
        .publish(NewEvent {
            id: "evt_direct_launch".into(),
            aggregate_id: "ses_two".into(),
            type_: "session.task.updated.1".into(),
            created: 9,
            data: parse_json(&format!(
                r#"{{"sessionID":"ses_two","change":{{"type":"launched","parentID":"ses_one","parentAssistantMessageID":"msg_parent","toolCallID":"call_direct","inputID":"msg_direct","description":"task","agent":"explore","model":{{"providerID":"local","id":"test"}},"promptDigest":"digest","background":true,"delivery":"steer"{}}}}}"#,
                anchor.map_or_else(String::new, |anchor| format!(r#","usageAnchor":{anchor}"#))
            ))
            .unwrap(),
        })
        .await;
    (harness, result)
}

#[tokio::test]
async fn a_launch_fact_stores_its_anchor_on_the_task_and_an_old_one_stores_none() {
    let (harness, result) =
        launch_event(Some(r#"{"sessionID":"ses_one","inputID":"msg_user_one"}"#)).await;
    result.unwrap();
    assert_eq!(
        task(&harness.store, &id("ses_two"))
            .usage_anchor
            .map(|anchor| anchor.value().clone()),
        Some(anchor("ses_one", "msg_user_one"))
    );
    let (harness, result) = launch_event(None).await;
    result.unwrap();
    assert!(task(&harness.store, &id("ses_two")).usage_anchor.is_none());
}

#[tokio::test]
async fn an_invalid_launch_anchor_is_rejected_and_creates_no_task() {
    for invalid in [
        "null",
        r#"{"sessionID":"ses_one"}"#,
        r#"{"sessionID":"ses_one","inputID":"ses_one"}"#,
        r#"{"sessionID":"ses_one","inputID":"msg_user_one","extra":1}"#,
    ] {
        let (harness, result) = launch_event(Some(invalid)).await;
        assert!(result.is_err(), "accepted {invalid}");
        assert!(
            harness
                .store
                .snapshot()
                .unwrap()
                .get::<TaskTable>(&tuple_key(&[KeyPart::String(&"ses_two".into())]))
                .unwrap()
                .is_none()
        );
    }
}

async fn step_anchor(harness: &Harness, session: &str, event: &str) -> Option<JsonValue> {
    let begin = begin(session);
    let pending = harness
        .sessions
        .begin_provider_request(&begin)
        .await
        .unwrap();
    finish(harness, &begin, &pending, "step", event).await;
    ledger_anchor(&harness.store, pending.id.as_lossless().as_str().unwrap()).unwrap()
}

fn admit_raw(
    harness: &Harness,
    session: &str,
    input: &str,
    caused_by: Option<JsonValue>,
    pending: bool,
    created: i64,
) {
    let (session, input) = (session.to_owned(), input.to_owned());
    harness
        .store
        .submit(move |tx| {
            let event = append(
                tx,
                &NewEvent {
                    id: format!("evt_{input}").into(),
                    aggregate_id: session.as_str().into(),
                    created,
                    type_: "session.input.admitted.1".into(),
                    data: ObjectEncoder::new()
                        .field("sessionID", session.as_str())
                        .field("inputID", input.as_str())
                        .field("input", &user("Work"))
                        .optional("causedBy", &caused_by)
                        .finish(),
                },
                None,
            )?;
            let Append::Appended(event) = event else {
                return Err(ycoding_store::Error::Rejected("duplicate admitted event"));
            };
            if pending {
                PendingTable::insert(
                    tx,
                    &Pending {
                        id: input.as_str().into(),
                        session_id: session.as_str().into(),
                        type_: "user".into(),
                        data: parse_json(r#"{"text":"Work"}"#).unwrap(),
                        delivery: Some("steer".into()),
                        admitted_seq: event.seq,
                        time_created: created,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

async fn promote(harness: &Harness, session: &str, input: &str, now: i64) {
    assert_eq!(
        harness
            .sessions
            .promote_input(&id(session), message(input).as_lossless(), now)
            .await
            .unwrap(),
        Promotion::Promoted
    );
}

async fn commit_revert(harness: &Harness, session: &str, to: &str, created: i64) {
    harness
        .sessions
        .publish(NewEvent {
            id: format!("evt_revert_{to}").into(),
            aggregate_id: session.into(),
            created,
            type_: "session.revert.committed.1".into(),
            data: parse_json(&format!(r#"{{"sessionID":"{session}","to":"{to}"}}"#)).unwrap(),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn a_committed_revert_hides_the_prompts_it_removed_from_attribution() {
    let harness = harness();
    prompt(&harness, "ses_one", "msg_user_one", 10).await;
    prompt(&harness, "ses_one", "msg_user_two", 20).await;
    assert_eq!(
        step_anchor(&harness, "ses_one", "evt_before_revert").await,
        Some(anchor("ses_one", "msg_user_two"))
    );
    commit_revert(&harness, "ses_one", "msg_user_two", 30).await;
    assert_eq!(
        step_anchor(&harness, "ses_one", "evt_after_revert").await,
        Some(anchor("ses_one", "msg_user_one"))
    );
}

#[tokio::test]
async fn reverting_every_prompt_leaves_no_anchor_until_a_new_prompt_is_promoted() {
    let harness = harness();
    prompt(&harness, "ses_one", "msg_user_one", 10).await;
    commit_revert(&harness, "ses_one", "msg_user_one", 20).await;
    assert_eq!(step_anchor(&harness, "ses_one", "evt_none").await, None);
    prompt(&harness, "ses_one", "msg_user_three", 30).await;
    assert_eq!(
        step_anchor(&harness, "ses_one", "evt_three").await,
        Some(anchor("ses_one", "msg_user_three"))
    );
}

#[tokio::test]
async fn a_prompt_caused_by_another_sessions_prompt_attributes_to_that_prompt() {
    let harness = harness();
    admit_raw(&harness, "ses_two", "msg_origin", None, false, 5);
    admit_raw(
        &harness,
        "ses_one",
        "msg_follow",
        Some(anchor("ses_two", "msg_origin")),
        true,
        10,
    );
    promote(&harness, "ses_one", "msg_follow", 11).await;
    assert_eq!(
        step_anchor(&harness, "ses_one", "evt_follow").await,
        Some(anchor("ses_two", "msg_origin"))
    );
}

#[tokio::test]
async fn causal_cycles_and_dangling_references_resolve_to_nothing_and_fall_back_to_older_prompts() {
    for cycle in ["self", "pair", "dangling"] {
        for older in [false, true] {
            let harness = harness();
            if older {
                prompt(&harness, "ses_one", "msg_older", 5).await;
            }
            let cause = match cycle {
                "self" => anchor("ses_one", "msg_loop"),
                "pair" => {
                    admit_raw(
                        &harness,
                        "ses_two",
                        "msg_partner",
                        Some(anchor("ses_one", "msg_loop")),
                        false,
                        8,
                    );
                    anchor("ses_two", "msg_partner")
                }
                _ => anchor("ses_two", "msg_missing"),
            };
            admit_raw(&harness, "ses_one", "msg_loop", Some(cause), true, 10);
            promote(&harness, "ses_one", "msg_loop", 11).await;
            let expected = older.then(|| anchor("ses_one", "msg_older"));
            assert_eq!(
                step_anchor(&harness, "ses_one", "evt_cycle").await,
                expected,
                "{cycle} older={older}"
            );
        }
    }
}

#[tokio::test]
async fn a_task_stored_without_an_anchor_resolves_to_the_parent_prompt_before_its_assistant_message()
 {
    let harness = harness();
    prompt(&harness, "ses_one", "msg_user_one", 10).await;
    harness
        .store
        .submit(|tx| {
            MessageTable::insert(
                tx,
                &Message {
                    id: "msg_parent".into(),
                    session_id: "ses_one".into(),
                    type_: "assistant".into(),
                    seq: 1_000,
                    time_created: 20,
                    time_updated: 20,
                    data: parse_json(
                        r#"{"agent":"build","model":{"providerID":"openai","id":"gpt"},"content":[{"type":"text","text":"ok"}],"finish":"stop","time":{"created":20,"completed":20}}"#,
                    )
                    .unwrap(),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    harness
        .sessions
        .publish(NewEvent {
            id: "evt_legacy_launch".into(),
            aggregate_id: "ses_two".into(),
            created: 30,
            type_: "session.task.updated.1".into(),
            data: parse_json(
                r#"{"sessionID":"ses_two","change":{"type":"launched","parentID":"ses_one","parentAssistantMessageID":"msg_parent","toolCallID":"call_legacy","inputID":"msg_child_legacy","description":"task","agent":"explore","model":{"providerID":"local","id":"test"},"promptDigest":"digest","background":true,"delivery":"steer"}}"#,
            )
            .unwrap(),
        })
        .await
        .unwrap();
    admit_raw(&harness, "ses_two", "msg_child_legacy", None, true, 40);
    promote(&harness, "ses_two", "msg_child_legacy", 41).await;
    assert_eq!(
        step_anchor(&harness, "ses_two", "evt_legacy").await,
        Some(anchor("ses_one", "msg_user_one"))
    );
}

#[tokio::test]
async fn an_autonomous_child_answer_takes_the_childs_own_resolved_anchor_not_the_parents_latest_prompt()
 {
    let harness = harness();
    prompt(&harness, "ses_one", "msg_user_one", 10).await;
    let child = launched(&harness, "call_auto", "Look around").await;
    let row = task(&harness.store, &child);
    harness
        .sessions
        .promote_input(&child, &row.input_id, 20)
        .await
        .unwrap();
    prompt(&harness, "ses_one", "msg_user_two", 30).await;
    autonomy::Service::new(harness.store.client())
        .set_auto_answer(&child, true)
        .await
        .unwrap();
    assert!(
        harness
            .service
            .question_attributed(&child, "Which cache?", None, &Attribution::Unset)
            .await
            .unwrap()
            .auto_answered
    );
    let answers = events(
        &harness.store,
        child.as_lossless().as_str().unwrap(),
        "session.input.admitted.1",
    )
    .into_iter()
    .filter(|data| {
        field(data, "input").and_then(|input| field(input, "type")) == Some(&text("synthetic"))
    })
    .collect::<Vec<_>>();
    let [answer] = answers.as_slice() else {
        panic!("expected one automatic answer, found {}", answers.len())
    };
    assert_eq!(
        field(answer, "causedBy"),
        Some(&anchor("ses_one", "msg_user_one"))
    );
}

#[tokio::test]
async fn w40_compaction_admission_dispatches_the_ambient_attribution_before_the_current_prompt() {
    let origin =
        ycoding_schema::usage_anchor::Ref::decode(&anchor("ses_two", "msg_origin")).unwrap();
    for (ambient, expected) in [
        (
            Attribution::Anchored(origin.clone()),
            Some(anchor("ses_two", "msg_origin")),
        ),
        (Attribution::Unanchored, None),
        (Attribution::Unset, Some(anchor("ses_one", "msg_input"))),
    ] {
        let (harness, message, seq) = prepared_compaction().await;
        let job = harness
            .sessions
            .compaction_admit_attributed(admission(&message, seq), 10, ambient.clone())
            .await
            .unwrap();
        assert_eq!(
            job.usage_anchor
                .as_ref()
                .map(|anchor| anchor.value().clone()),
            expected,
            "{ambient:?}"
        );
        let admitted = events(&harness.store, "ses_one", "session.compaction.admitted.2");
        let [event] = admitted.as_slice() else {
            panic!("expected one admission event")
        };
        assert_eq!(
            field(event, "usageAnchor").cloned(),
            expected,
            "{ambient:?}"
        );

        let other = if matches!(ambient, Attribution::Unanchored) {
            Attribution::Anchored(origin.clone())
        } else {
            Attribution::Unanchored
        };
        let retried = harness
            .sessions
            .compaction_admit_attributed(admission(&message, seq), 11, other)
            .await
            .unwrap();
        assert_eq!(retried.id, job.id);
        assert_eq!(retried.usage_anchor, job.usage_anchor, "{ambient:?}");
        assert_eq!(
            events(&harness.store, "ses_one", "session.compaction.admitted.2").len(),
            1
        );
    }
}
