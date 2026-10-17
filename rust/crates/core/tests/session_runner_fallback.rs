use std::{
    ops::Bound,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use ycoding_core::{
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        config::{Configuration, LoadOptions, Roots},
        credential, model,
    },
    session::{
        run_coordinator::{Coordinator, Error, InterruptReason},
        runner::{Clock, Local, Services},
        store::Service,
    },
    tools::registry::{DynamicTool, Registry},
};
use ycoding_schema::{
    DomainDecode, JsonValue, ObjectEncoder, parse_json, session, session_message, session_pending,
};
use ycoding_store::{
    Store, TableDeclaration, analytics,
    model_incident::{self, Incident, IncidentTable},
    project,
    resources::{self, Request},
    session::{self as tables, Document, NewEvent},
};

#[path = "session_support/guardrails.rs"]
mod guardrails;
#[path = "session_support/record.rs"]
mod record;

const PACKAGE: &str = "@ycoding-ai/ai/providers/openai-compatible";
const TEXT: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
const TOOL: &str = "data: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_fixture\",\"type\":\"function\",\"function\":{\"name\":\"echo\",\"arguments\":\"{\\\"value\\\":\\\"observed\\\"}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
const PARTIAL: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Partial\"},\"finish_reason\":null}]}\n\n";
const WHITESPACE: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" \"},\"finish_reason\":null}]}\n\n";
const RESPONSES: &str = include_str!("../../ai/tests/fixtures/openai-responses-reasoning.sse");
const RESPONSE_ID: &str = "resp_05f7e55dc1d2d743016a1235e5bb3c8193b4c0e30fa316700c";
const RATE_LIMITED: &str = r#"{"error":{"message":"rate limited"}}"#;
const QUOTA: &str =
    r#"{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}"#;

#[derive(Clone, Copy)]
enum Reply {
    Stream(&'static str),
    Status(u16, &'static str, &'static str),
    Truncated(&'static str),
    Hang(&'static str),
}

#[derive(Clone, Copy, Default)]
enum Tool {
    #[default]
    None,
    Echo,
    Select(&'static str),
}

#[derive(Default)]
struct Setup {
    fallbacks: &'static str,
    global: Option<&'static str>,
    responses: bool,
    replies: Vec<Reply>,
    selected: Option<&'static str>,
    agent: Option<&'static str>,
    child: bool,
    without_incidents: bool,
    deny_guidance: bool,
    guidance: Vec<(&'static str, &'static str, &'static str)>,
    tool: Tool,
    clock: Option<Arc<dyn Clock>>,
}

struct Fixture {
    store: Store,
    service: Service,
    requests: mpsc::UnboundedReceiver<JsonValue>,
    streaming: mpsc::UnboundedReceiver<()>,
    server: tokio::task::JoinHandle<()>,
    coordinator: Coordinator,
    slept: Arc<Mutex<Vec<u64>>>,
    _tools: Box<dyn std::any::Any>,
}

struct Steady {
    now: AtomicI64,
    slept: Arc<Mutex<Vec<u64>>>,
}
impl Clock for Steady {
    fn now(&self) -> i64 {
        self.now.fetch_add(1, Ordering::Relaxed)
    }
    fn sleep(
        &self,
        milliseconds: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        self.slept.lock().unwrap().push(milliseconds);
        Box::pin(async {})
    }
}

struct Stalled(mpsc::UnboundedSender<u64>);
impl Clock for Stalled {
    fn now(&self) -> i64 {
        1_000
    }
    fn sleep(
        &self,
        milliseconds: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        self.0.send(milliseconds).unwrap();
        Box::pin(std::future::pending())
    }
}

#[tokio::test]
async fn retry_exhaustion_reruns_the_same_step_on_the_next_configured_model() {
    let mut replies = vec![Reply::Status(429, "", RATE_LIMITED); 10];
    replies.push(Reply::Stream(TEXT));
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies,
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Fall back after retries").await;
    fixture.coordinator.run(&id()).await.unwrap();

    let mut expected = vec!["fake-model"; 10];
    expected.push("backup");
    assert_eq!(requested(&mut fixture.requests), expected);
    assert_eq!(
        *fixture.slept.lock().unwrap(),
        vec![
            2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000, 120000
        ]
    );
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.retry.scheduled"), 9);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(count(&events, "session.step.rerouted"), 1);
    assert_eq!(count(&events, "session.step.ended"), 1);
    assert_eq!(count(&events, "session.step.failed"), 0);
    assert_eq!(count(&events, "session.model.selected"), 0);
    let assistant = only_assistant(&fixture.service);
    let rerouted = data(&events, "session.step.rerouted");
    assert_eq!(
        text(field(&rerouted[0], "assistantMessageID")),
        assistant.id.as_lossless().to_utf8().unwrap()
    );
    assert_eq!(
        reference_of(field(&rerouted[0], "model")),
        reference("backup")
    );
    assert_eq!(
        text(field(field(&rerouted[0], "error"), "type")),
        "provider.rate-limit"
    );
    assert_eq!(assistant.model, reference("backup"));
    let reroutes = assistant.reroutes.clone().unwrap();
    assert_eq!(reroutes.len(), 1);
    assert_eq!(reroutes[0].from, reference("fake-model"));
    assert_eq!(reroutes[0].model, reference("backup"));
    assert_eq!(
        reroutes[0].error.r#type.as_str(),
        Some("provider.rate-limit")
    );
    assert!(assistant.error.is_none());

    let rows = provider_requests(&fixture.store);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].model.domain().unwrap(), reference("fake-model"));
    assert_eq!(rows[0].attempts, 10);
    assert_eq!(rows[0].invalidation.as_str(), Some("retry-fallback"));
    assert_eq!(rows[0].continuation.as_str(), Some("fallback"));
    assert_eq!(rows[0].connection_identity_digest, None);
    assert_eq!(rows[0].cost, None);
    assert_eq!(total_tokens(&rows[0]), 0.0);
    assert_eq!(rows[1].model.domain().unwrap(), reference("backup"));
    assert_eq!(rows[1].attempts, 1);
    assert!(rows[1].connection_identity_digest.is_some());
    assert!(rows[1].cost.is_some_and(|cost| cost > 0.0));
    assert!(total_tokens(&rows[1]) > 0.0);
    assert_ne!(rows[1].prompt_cache_key, rows[0].prompt_cache_key);
    for row in &rows {
        assert_eq!(
            row.assistant_message_id.as_ref(),
            Some(assistant.id.as_lossless())
        );
    }
    assert_eq!(
        fixture.service.get(&id()).unwrap().unwrap().model,
        None,
        "a switch never changes the Session's model selection"
    );
    finish(fixture).await;
}

#[tokio::test]
async fn exhausted_quota_switches_at_once_and_records_one_incident_in_the_reroute() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![Reply::Status(429, "", QUOTA), Reply::Stream(TEXT)],
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Fall back on quota").await;
    fixture.coordinator.run(&id()).await.unwrap();

    assert_eq!(requested(&mut fixture.requests), ["fake-model", "backup"]);
    assert!(fixture.slept.lock().unwrap().is_empty());
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.retry.scheduled"), 0);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(count(&events, "session.step.ended"), 1);
    assert_eq!(
        reroute_errors(&events),
        [("backup".to_string(), "provider.quota".to_string())]
    );
    let incidents = incidents(&fixture.store);
    assert_eq!(incidents.len(), 1);
    let incident = &incidents[0];
    assert_eq!(incident.kind.as_str(), Some("fallback"));
    assert_eq!(incident.provider_id.as_str(), Some("fake"));
    assert_eq!(incident.model_id.as_str(), Some("fake-model"));
    assert_eq!(incident.agent.as_str(), Some("build"));
    assert_eq!(incident.session_id.as_str(), Some("ses_one"));
    assert_eq!(incident.project_id.as_str(), Some("prj_one"));
    assert_eq!(incident.category.as_str(), Some("provider.quota"));
    assert_eq!(incident.request_id, None);
    assert_eq!(incident.decided_by, None);
    assert_eq!(
        incident.target.as_ref().unwrap().domain().unwrap(),
        reference("backup")
    );
    finish(fixture).await;
}

#[tokio::test]
async fn a_retry_delay_beyond_the_ceiling_switches_without_waiting() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![
            Reply::Status(429, "retry-after-ms: 130000\r\n", RATE_LIMITED),
            Reply::Stream(TEXT),
        ],
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Fall back on a long wait").await;
    fixture.coordinator.run(&id()).await.unwrap();

    assert_eq!(requested(&mut fixture.requests), ["fake-model", "backup"]);
    assert!(fixture.slept.lock().unwrap().is_empty());
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.retry.scheduled"), 0);
    assert_eq!(
        reroute_errors(&events),
        [("backup".to_string(), "provider.rate-limit".to_string())]
    );
    assert_eq!(count(&events, "session.step.ended"), 1);
    finish(fixture).await;
}

#[tokio::test]
async fn an_unresolvable_selected_model_starts_the_step_before_rerouting() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/missing":["fake/backup"]}"#,
        replies: vec![Reply::Stream(TEXT)],
        selected: Some("missing"),
        ..Setup::default()
    })
    .await;
    admit(
        &fixture.service,
        "input",
        "Fall back on an unavailable model",
    )
    .await;
    fixture.coordinator.run(&id()).await.unwrap();

    assert_eq!(requested(&mut fixture.requests), ["backup"]);
    let events = events(&fixture.store);
    let started = data(&events, "session.step.started");
    assert_eq!(started.len(), 1);
    assert_eq!(
        reference_of(field(&started[0], "model")),
        reference("missing")
    );
    assert_eq!(
        reroute_errors(&events),
        [("backup".to_string(), "model.unavailable".to_string())]
    );
    assert_eq!(terminals(&events), ["session.step.ended"]);
    let assistant = only_assistant(&fixture.service);
    assert_eq!(assistant.model, reference("backup"));
    assert_eq!(
        text(field(&started[0], "assistantMessageID")),
        assistant.id.as_lossless().to_utf8().unwrap()
    );
    assert_eq!(
        fixture.service.get(&id()).unwrap().unwrap().model,
        Some(reference("missing"))
    );
    finish(fixture).await;
}

#[tokio::test]
async fn failures_outside_the_fallback_classes_fail_on_the_selected_model() {
    for (name, reply) in [
        (
            "authentication",
            Reply::Status(401, "", r#"{"error":{"message":"bad key"}}"#),
        ),
        (
            "content policy",
            Reply::Status(
                400,
                "",
                r#"{"error":{"message":"blocked by content_filter"}}"#,
            ),
        ),
        (
            "invalid request",
            Reply::Status(
                400,
                "",
                r#"{"error":{"message":"bad field","code":"invalid_request_error"}}"#,
            ),
        ),
        (
            "unclassified",
            Reply::Status(418, "", r#"{"error":{"message":"teapot"}}"#),
        ),
        (
            "context overflow",
            Reply::Status(
                400,
                "",
                r#"{"error":{"message":"maximum context length exceeded","code":"context_length_exceeded"}}"#,
            ),
        ),
    ] {
        let mut fixture = fixture(Setup {
            fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
            replies: vec![reply, Reply::Stream(TEXT)],
            ..Setup::default()
        })
        .await;
        admit(&fixture.service, "input", "No fallback").await;
        assert!(fixture.coordinator.run(&id()).await.is_err(), "{name}");

        assert_eq!(requested(&mut fixture.requests), ["fake-model"], "{name}");
        let events = events(&fixture.store);
        assert_eq!(count(&events, "session.step.rerouted"), 0, "{name}");
        assert_eq!(terminals(&events), ["session.step.failed"], "{name}");
        assert_eq!(
            only_assistant(&fixture.service).model,
            reference("fake-model"),
            "{name}"
        );
        assert!(incidents(&fixture.store).is_empty(), "{name}");
        finish(fixture).await;
    }
}

#[tokio::test]
async fn a_failure_after_observable_output_never_switches_models() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![Reply::Truncated(PARTIAL), Reply::Stream(TEXT)],
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Fail after output").await;
    assert!(fixture.coordinator.run(&id()).await.is_err());

    assert_eq!(requested(&mut fixture.requests), ["fake-model"]);
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.step.rerouted"), 0);
    assert_eq!(terminals(&events), ["session.step.failed"]);
    assert!(incidents(&fixture.store).is_empty());
    finish(fixture).await;
}

#[tokio::test]
async fn an_exhausted_chain_fails_the_step_once_with_the_last_models_error() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![Reply::Status(429, "", QUOTA), Reply::Status(429, "", QUOTA)],
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Exhaust the chain").await;
    assert!(matches!(
        fixture.coordinator.run(&id()).await,
        Err(Error::Runner(error)) if error.r#type.as_str() == Some("provider.quota")
    ));

    assert_eq!(requested(&mut fixture.requests), ["fake-model", "backup"]);
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(count(&events, "session.step.rerouted"), 1);
    assert_eq!(terminals(&events), ["session.step.failed"]);
    let assistant = only_assistant(&fixture.service);
    assert_eq!(assistant.model, reference("backup"));
    assert_eq!(
        assistant.error.as_ref().unwrap().r#type.as_str(),
        Some("provider.quota")
    );
    let rows = provider_requests(&fixture.store);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].invalidation.as_str(), Some("retry-fallback"));
    assert_eq!(rows[1].model.domain().unwrap(), reference("backup"));
    assert_ne!(rows[1].invalidation.as_str(), Some("retry-fallback"));
    finish(fixture).await;
}

#[tokio::test]
async fn a_drain_tries_at_most_three_fallbacks_in_configured_order() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/third","fake/backup","fake/spare"]}"#,
        replies: vec![Reply::Status(429, "", QUOTA); 4],
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Walk the whole chain").await;
    assert!(fixture.coordinator.run(&id()).await.is_err());

    assert_eq!(
        requested(&mut fixture.requests),
        ["fake-model", "third", "backup", "spare"]
    );
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(
        reroute_errors(&events)
            .into_iter()
            .map(|(model, _)| model)
            .collect::<Vec<_>>(),
        ["third", "backup", "spare"]
    );
    assert_eq!(terminals(&events), ["session.step.failed"]);
    assert_eq!(
        incidents(&fixture.store)
            .iter()
            .map(|incident| incident.model_id.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["fake-model", "third", "backup"]
    );
    finish(fixture).await;
}

#[tokio::test]
async fn later_steps_stay_on_the_fallback_and_the_next_drain_starts_on_the_selected_model() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![
            Reply::Status(429, "", QUOTA),
            Reply::Stream(TOOL),
            Reply::Stream(TEXT),
            Reply::Stream(TEXT),
        ],
        tool: Tool::Echo,
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Stay on the fallback").await;
    fixture.coordinator.run(&id()).await.unwrap();

    assert_eq!(
        requested(&mut fixture.requests),
        ["fake-model", "backup", "backup"]
    );
    let first = events(&fixture.store);
    assert_eq!(
        started_models(&first),
        [reference("fake-model"), reference("backup")]
    );
    assert_eq!(count(&first, "session.step.rerouted"), 1);
    assert_eq!(incidents(&fixture.store).len(), 1);

    admit(&fixture.service, "next", "Next drain").await;
    fixture.coordinator.run(&id()).await.unwrap();
    assert_eq!(requested(&mut fixture.requests), ["fake-model"]);
    let events = events(&fixture.store);
    assert_eq!(
        started_models(&events).last(),
        Some(&reference("fake-model"))
    );
    assert_eq!(count(&events, "session.step.rerouted"), 1);
    assert_eq!(incidents(&fixture.store).len(), 1);
    finish(fixture).await;
}

#[tokio::test]
async fn a_later_step_failing_on_the_fallback_moves_on_without_returning_to_the_primary() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup","fake/spare"]}"#,
        replies: vec![
            Reply::Status(429, "", QUOTA),
            Reply::Stream(TOOL),
            Reply::Status(429, "", QUOTA),
            Reply::Stream(TEXT),
        ],
        tool: Tool::Echo,
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Move along the chain").await;
    fixture.coordinator.run(&id()).await.unwrap();

    assert_eq!(
        requested(&mut fixture.requests),
        ["fake-model", "backup", "backup", "spare"]
    );
    let events = events(&fixture.store);
    assert_eq!(
        started_models(&events),
        [reference("fake-model"), reference("backup")]
    );
    assert_eq!(
        reroute_errors(&events),
        [
            ("backup".to_string(), "provider.quota".to_string()),
            ("spare".to_string(), "provider.quota".to_string())
        ]
    );
    assert_eq!(
        terminals(&events),
        ["session.step.ended", "session.step.ended"]
    );
    finish(fixture).await;
}

#[tokio::test]
async fn selecting_another_model_during_the_drain_clears_the_switch_state() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![
            Reply::Status(429, "", QUOTA),
            Reply::Stream(TOOL),
            Reply::Stream(TEXT),
        ],
        tool: Tool::Select("spare"),
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Select another model").await;
    fixture.coordinator.run(&id()).await.unwrap();

    assert_eq!(
        requested(&mut fixture.requests),
        ["fake-model", "backup", "spare"]
    );
    let events = events(&fixture.store);
    assert_eq!(
        started_models(&events),
        [reference("fake-model"), reference("spare")]
    );
    assert_eq!(count(&events, "session.step.rerouted"), 1);
    finish(fixture).await;
}

#[tokio::test]
async fn a_fallback_that_cannot_hold_the_request_is_skipped_as_a_context_limit_without_compaction()
{
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/narrow","fake/backup"]}"#,
        replies: vec![Reply::Status(429, "", QUOTA), Reply::Stream(TEXT)],
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Skip the narrow fallback").await;
    fixture.coordinator.run(&id()).await.unwrap();

    assert_eq!(requested(&mut fixture.requests), ["fake-model", "backup"]);
    let events = events(&fixture.store);
    assert_eq!(
        reroute_errors(&events),
        [
            ("narrow".to_string(), "provider.quota".to_string()),
            ("backup".to_string(), "context.limit".to_string())
        ]
    );
    assert!(
        !events
            .iter()
            .any(|(kind, _)| kind.starts_with("session.compaction.")),
        "a fallback never compacts the Session"
    );
    assert_eq!(terminals(&events), ["session.step.ended"]);
    assert_eq!(
        only_assistant(&fixture.service)
            .reroutes
            .unwrap()
            .iter()
            .map(|reroute| reroute.from.clone())
            .collect::<Vec<_>>(),
        [reference("fake-model"), reference("narrow")]
    );
    assert_eq!(
        incidents(&fixture.store)
            .iter()
            .map(|incident| (
                incident.model_id.to_utf8().unwrap(),
                incident.category.to_utf8().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("fake-model".to_string(), "provider.quota".to_string()),
            ("narrow".to_string(), "context.limit".to_string())
        ]
    );
    finish(fixture).await;
}

#[tokio::test]
async fn an_unavailable_fallback_profile_fails_the_step_without_trying_later_entries() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["Work#fake/fake-model","fake/backup"]}"#,
        replies: vec![Reply::Status(429, "", QUOTA), Reply::Stream(TEXT)],
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Fallback profile unavailable").await;
    assert!(matches!(
        fixture.coordinator.run(&id()).await,
        Err(Error::Runner(error)) if error.r#type.as_str() == Some("model.profile")
    ));

    assert_eq!(requested(&mut fixture.requests), ["fake-model"]);
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(count(&events, "session.step.rerouted"), 1);
    assert_eq!(terminals(&events), ["session.step.failed"]);
    finish(fixture).await;
}

#[tokio::test]
async fn an_unresolvable_last_fallback_settles_the_step_once() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/missing"]}"#,
        replies: vec![Reply::Status(429, "", QUOTA)],
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Last fallback unavailable").await;
    assert!(matches!(
        fixture.coordinator.run(&id()).await,
        Err(Error::Runner(error)) if error.r#type.as_str() == Some("model.unavailable")
    ));

    assert_eq!(requested(&mut fixture.requests), ["fake-model"]);
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(count(&events, "session.step.rerouted"), 1);
    assert_eq!(terminals(&events), ["session.step.failed"]);
    let assistant = only_assistant(&fixture.service);
    assert_eq!(assistant.model, reference("missing"));
    assert_eq!(
        assistant.error.as_ref().unwrap().r#type.as_str(),
        Some("model.unavailable")
    );
    finish(fixture).await;
}

#[tokio::test]
async fn a_chain_with_no_resolvable_model_settles_one_started_step() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/missing":["fake/gone"]}"#,
        selected: Some("missing"),
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Whole chain unavailable").await;
    assert!(matches!(
        fixture.coordinator.run(&id()).await,
        Err(Error::Runner(error)) if error.r#type.as_str() == Some("model.unavailable")
    ));

    assert!(requested(&mut fixture.requests).is_empty());
    let events = events(&fixture.store);
    assert_eq!(started_models(&events), [reference("missing")]);
    assert_eq!(
        reroute_errors(&events),
        [("gone".to_string(), "model.unavailable".to_string())]
    );
    assert_eq!(terminals(&events), ["session.step.failed"]);
    let assistant = only_assistant(&fixture.service);
    assert_eq!(assistant.model, reference("gone"));
    assert!(assistant.time.completed.is_some());
    finish(fixture).await;
}

#[tokio::test]
async fn interrupting_a_fallback_retry_backoff_closes_the_step_once() {
    let (slept, mut backoff) = mpsc::unbounded_channel();
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![
            Reply::Status(429, "", QUOTA),
            Reply::Status(429, "", RATE_LIMITED),
        ],
        clock: Some(Arc::new(Stalled(slept))),
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Interrupt the fallback backoff").await;
    let running = fixture.coordinator.clone();
    let mut task = tokio::spawn(async move { running.run(&id()).await });
    tokio::select! {
        delay = backoff.recv() => assert_eq!(delay, Some(2000)),
        settled = &mut task => panic!("the run settled before the fallback retried: {settled:?}"),
    }
    fixture
        .coordinator
        .interrupt(&id(), InterruptReason::User)
        .await
        .unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Interrupted(_))));

    assert_eq!(requested(&mut fixture.requests), ["fake-model", "backup"]);
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(count(&events, "session.step.rerouted"), 1);
    assert_eq!(count(&events, "session.retry.scheduled"), 1);
    assert_eq!(terminals(&events), ["session.step.failed"]);
    let assistant = only_assistant(&fixture.service);
    assert_eq!(assistant.model, reference("backup"));
    assert_eq!(
        assistant.error.as_ref().unwrap().r#type.as_str(),
        Some("aborted")
    );
    let rows = provider_requests(&fixture.store);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].invalidation.as_str(), Some("retry-fallback"));
    assert_eq!(rows[0].connection_identity_digest, None);
    assert_eq!(rows[1].model.domain().unwrap(), reference("backup"));
    finish(fixture).await;
}

#[tokio::test]
async fn interrupting_a_streaming_fallback_closes_the_step_once_without_another_fallback() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup","fake/spare"]}"#,
        replies: vec![
            Reply::Status(429, "", QUOTA),
            Reply::Hang(WHITESPACE),
            Reply::Stream(TEXT),
        ],
        ..Setup::default()
    })
    .await;
    admit(
        &fixture.service,
        "input",
        "Interrupt the streaming fallback",
    )
    .await;
    let running = fixture.coordinator.clone();
    let mut task = tokio::spawn(async move { running.run(&id()).await });
    tokio::select! {
        streamed = fixture.streaming.recv() => assert_eq!(streamed, Some(())),
        settled = &mut task => panic!("the run settled before the fallback streamed: {settled:?}"),
    }
    fixture
        .coordinator
        .interrupt(&id(), InterruptReason::User)
        .await
        .unwrap();
    assert!(matches!(task.await.unwrap(), Err(Error::Interrupted(_))));

    assert_eq!(requested(&mut fixture.requests), ["fake-model", "backup"]);
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(count(&events, "session.step.rerouted"), 1);
    assert_eq!(terminals(&events), ["session.step.failed"]);
    let assistant = only_assistant(&fixture.service);
    assert_eq!(assistant.model, reference("backup"));
    assert_eq!(
        assistant.error.as_ref().unwrap().r#type.as_str(),
        Some("aborted")
    );
    assert_eq!(incidents(&fixture.store).len(), 1);
    finish(fixture).await;
}

#[tokio::test]
async fn the_nearest_document_supplies_the_whole_fallback_map() {
    for (name, global, nearest) in [
        (
            "another key",
            r#"{"fake/fake-model":["fake/backup"]}"#,
            r#"{"fake/other":["fake/spare"]}"#,
        ),
        (
            "an empty chain",
            r#"{"fake/fake-model":["fake/backup"]}"#,
            r#"{"fake/fake-model":[]}"#,
        ),
    ] {
        let mut fixture = fixture(Setup {
            fallbacks: nearest,
            global: Some(global),
            replies: vec![Reply::Status(429, "", QUOTA), Reply::Stream(TEXT)],
            ..Setup::default()
        })
        .await;
        admit(&fixture.service, "input", "Nearest map only").await;
        assert!(
            matches!(
                fixture.coordinator.run(&id()).await,
                Err(Error::Runner(error)) if error.r#type.as_str() == Some("provider.quota")
            ),
            "{name}"
        );

        assert_eq!(requested(&mut fixture.requests), ["fake-model"], "{name}");
        let events = events(&fixture.store);
        assert_eq!(count(&events, "session.step.rerouted"), 0, "{name}");
        assert_eq!(terminals(&events), ["session.step.failed"], "{name}");
        assert!(incidents(&fixture.store).is_empty(), "{name}");
        finish(fixture).await;
    }
}

#[tokio::test]
async fn a_fallback_never_replays_the_primary_responses_continuation() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"openai/gpt-5.5":["openai/gpt-5.4"]}"#,
        responses: true,
        replies: vec![
            Reply::Stream(RESPONSES),
            Reply::Status(429, "", QUOTA),
            Reply::Stream(RESPONSES),
        ],
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Answer the prompt").await;
    fixture.coordinator.run(&id()).await.unwrap();
    admit(&fixture.service, "again", "Again").await;
    fixture.coordinator.run(&id()).await.unwrap();

    let bodies = std::iter::from_fn(|| fixture.requests.try_recv().ok())
        .map(|body| {
            (
                text(field(&body, "model")),
                ycoding_schema::stringify_json(&body),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        bodies
            .iter()
            .map(|(model, _)| model.as_str())
            .collect::<Vec<_>>(),
        ["gpt-5.5", "gpt-5.5", "gpt-5.4"]
    );
    assert!(
        bodies[1]
            .1
            .contains(&format!("\"previous_response_id\":\"{RESPONSE_ID}\"")),
        "the selected model continues its own stored response"
    );
    assert!(!bodies[2].1.contains("previous_response_id"));
    assert!(!bodies[2].1.contains(RESPONSE_ID));
    assert!(bodies[2].1.contains("Answer the prompt"));
    assert!(bodies[2].1.contains("Again"));
    let rows = provider_requests(&fixture.store);
    assert_eq!(
        rows.iter()
            .map(|row| (
                row.model.domain().unwrap().id.to_utf8().unwrap(),
                row.continuation.to_utf8().unwrap(),
                row.invalidation.to_utf8().unwrap()
            ))
            .map(|(model, continuation, invalidation)| (
                model,
                continuation,
                invalidation == "retry-fallback"
            ))
            .collect::<Vec<_>>(),
        [
            ("gpt-5.5".to_string(), "full".to_string(), false),
            ("gpt-5.5".to_string(), "fallback".to_string(), true),
            ("gpt-5.4".to_string(), "full".to_string(), false)
        ]
    );
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.step.rerouted"), 1);
    assert_eq!(
        terminals(&events),
        ["session.step.ended", "session.step.ended"]
    );
    finish(fixture).await;
}

#[tokio::test]
async fn a_child_reroute_is_attributed_to_the_child_and_its_selected_agent() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![Reply::Status(429, "", QUOTA), Reply::Stream(TEXT)],
        agent: Some("reviewer"),
        child: true,
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Child fallback").await;
    fixture.coordinator.run(&id()).await.unwrap();

    assert_eq!(requested(&mut fixture.requests), ["fake-model", "backup"]);
    assert_eq!(
        incidents(&fixture.store)
            .iter()
            .map(|incident| (
                incident.session_id.to_utf8().unwrap(),
                incident.agent.to_utf8().unwrap(),
                incident.model_id.to_utf8().unwrap()
            ))
            .collect::<Vec<_>>(),
        [(
            "ses_one".to_string(),
            "reviewer".to_string(),
            "fake-model".to_string()
        )]
    );
    finish(fixture).await;
}

#[tokio::test]
async fn a_failed_incident_write_rolls_back_the_reroute() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![Reply::Status(429, "", QUOTA), Reply::Stream(TEXT)],
        without_incidents: true,
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "Fail the incident write").await;
    assert!(fixture.coordinator.run(&id()).await.is_err());

    assert_eq!(requested(&mut fixture.requests), ["fake-model"]);
    let events = events(&fixture.store);
    assert_eq!(count(&events, "session.step.rerouted"), 0);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(terminals(&events), ["session.step.failed"]);
    assert_eq!(
        only_assistant(&fixture.service).model,
        reference("fake-model")
    );
    finish(fixture).await;
}

const FORCE_PUSH: &str = "standard.review.force-push";
const GIT_DESTRUCTIVE: &str = "standard.review.git-destructive";

fn guidance_incidents() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("fake-model", FORCE_PUSH, "req_a"),
        ("fake-model", FORCE_PUSH, "req_b"),
        ("backup", GIT_DESTRUCTIVE, "req_x"),
        ("backup", GIT_DESTRUCTIVE, "req_y"),
    ]
}

#[tokio::test]
async fn the_selected_models_guidance_reaches_the_initial_instructions() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{}"#,
        replies: vec![Reply::Stream(TEXT)],
        guidance: guidance_incidents(),
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "First").await;
    fixture.coordinator.run(&id()).await.unwrap();

    let bodies = bodies(&mut fixture.requests);
    assert_eq!(bodies.len(), 1);
    let system = system(&bodies[0]);
    assert!(system.contains("<model-guidance>"), "{system}");
    assert!(system.contains(FORCE_PUSH), "{system}");
    assert!(!system.contains(GIT_DESTRUCTIVE), "{system}");
    finish(fixture).await;
}

#[tokio::test]
async fn a_denied_guidance_capability_omits_the_notes() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{}"#,
        replies: vec![Reply::Stream(TEXT)],
        guidance: guidance_incidents(),
        deny_guidance: true,
        ..Setup::default()
    })
    .await;
    admit(&fixture.service, "input", "First").await;
    fixture.coordinator.run(&id()).await.unwrap();

    let bodies = bodies(&mut fixture.requests);
    assert_eq!(bodies.len(), 1);
    assert!(!ycoding_schema::stringify_json(&bodies[0]).contains("<model-guidance>"));
    finish(fixture).await;
}

#[tokio::test]
async fn a_fallback_keeps_the_selected_models_guidance_without_an_update() {
    let mut fixture = fixture(Setup {
        fallbacks: r#"{"fake/fake-model":["fake/backup"]}"#,
        replies: vec![Reply::Status(429, "", QUOTA), Reply::Stream(TEXT)],
        guidance: guidance_incidents(),
        ..Setup::default()
    })
    .await;
    admit(
        &fixture.service,
        "input",
        "Fallback keeps the primary notes",
    )
    .await;
    fixture.coordinator.run(&id()).await.unwrap();

    let bodies = bodies(&mut fixture.requests);
    assert_eq!(
        bodies
            .iter()
            .map(|body| text(field(body, "model")))
            .collect::<Vec<_>>(),
        ["fake-model", "backup"]
    );
    assert_eq!(system(&bodies[1]), system(&bodies[0]));
    assert!(system(&bodies[1]).contains(FORCE_PUSH));
    assert!(!system(&bodies[1]).contains(GIT_DESTRUCTIVE));
    assert_eq!(
        count(&events(&fixture.store), "session.instructions.updated"),
        1
    );
    finish(fixture).await;
}

fn bodies(requests: &mut mpsc::UnboundedReceiver<JsonValue>) -> Vec<JsonValue> {
    std::iter::from_fn(|| requests.try_recv().ok()).collect()
}

fn system(body: &JsonValue) -> String {
    let JsonValue::Array(messages) = field(body, "messages") else {
        panic!("expected chat messages")
    };
    messages
        .iter()
        .filter(|message| text(field(message, "role")) == "system")
        .map(ycoding_schema::stringify_json)
        .collect::<Vec<_>>()
        .join("\n")
}

async fn fixture(setup: Setup) -> Fixture {
    let store = store(&setup);
    if setup.responses {
        initial_context(&store);
    }
    let (endpoint, requests, streaming, server) = server(setup.replies.clone()).await;
    let slept = Arc::new(Mutex::new(Vec::new()));
    let clock = setup.clock.clone().unwrap_or_else(|| {
        Arc::new(Steady {
            now: AtomicI64::new(1_000),
            slept: slept.clone(),
        })
    });
    let (registry, tools) = registry(&store, setup.tool);
    let services = Services {
        store: Service::new(store.client()),
        events: ycoding_core::event_feed::Feed::attach(&store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(if setup.responses {
            responses_catalog(&endpoint)
        } else {
            catalog(&endpoint)
        })),
        agents: Arc::new(agent::Service::new(vec![
            agent::empty("build".into()),
            agent::empty("reviewer".into()),
        ])),
        credentials: credential::Service::new(store.client()),
        tools: registry,
        attachments: Arc::new(
            attachment_store::Store::new(std::env::temp_dir().join("ycoding-fallback-attachments"))
                .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: None,
        clock,
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: guardrails::guardrails(&store),
        helpers: Default::default(),
        cursor: None,
        claude: None,
        auth: None,
        skill_resolver: None,
        snapshots: None,
        configuration: Some(configuration(
            setup.fallbacks,
            setup.global,
            setup.deny_guidance || setup.without_incidents,
        )),
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
    };
    Fixture {
        service: Service::new(store.client()),
        coordinator: Coordinator::new(Arc::new(Local::new(services))),
        store,
        requests,
        streaming,
        server,
        slept,
        _tools: tools,
    }
}

async fn finish(fixture: Fixture) {
    fixture.server.abort();
    fixture.coordinator.shutdown().await.unwrap();
}

fn store(setup: &Setup) -> Store {
    let declarations = project::TABLES
        .iter()
        .chain(tables::TABLES)
        .chain(resources::TABLES)
        .chain(if setup.without_incidents {
            &[]
        } else {
            model_incident::TABLES
        })
        .copied()
        .chain([
            TableDeclaration::of::<analytics::DeliveryTable>(),
            TableDeclaration::of::<analytics::IntentTable>(),
        ])
        .collect::<Vec<_>>();
    let store = Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, Box::leak(declarations.into_boxed_slice())),
        ycoding_store::Metadata::new([11; 16], 1),
    )
    .unwrap();
    let mut session = record::record("ses_one");
    session.model = setup
        .selected
        .map(|id| Document::from_domain(&reference(id)).unwrap());
    session.agent = setup.agent.map(Into::into);
    if setup.child {
        session.parent_id = Some("ses_two".into());
    }
    let guidance = setup.guidance.clone();
    store
        .submit(move |tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_one".into(),
                    worktree: "/project".into(),
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
            tables::SessionTable::insert(tx, &record::record("ses_two"))?;
            for (model, rule, request) in &guidance {
                IncidentTable::insert(
                    tx,
                    &Incident {
                        id: format!("inc_{model}_{request}").into(),
                        time_created: 500,
                        kind: "guardrail-escalated".into(),
                        provider_id: "fake".into(),
                        model_id: (*model).into(),
                        variant: None,
                        profile: None,
                        agent: "build".into(),
                        project_id: "prj_one".into(),
                        session_id: "ses_two".into(),
                        request_id: Some((*request).into()),
                        category: "hard".into(),
                        rule_ids: Document::new(JsonValue::Array(vec![JsonValue::String(
                            (*rule).into(),
                        )]))?,
                        target: None,
                        decided_by: None,
                    },
                )?;
            }
            tables::SessionTable::insert(tx, &session)
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

fn catalog(endpoint: &str) -> Catalog {
    let entry = |id: &str, context: u32, output: u32| {
        format!(
            r#""{id}":{{"id":"{id}","name":"{id}","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"modalities":{{"input":["text"],"output":["text"]}},"cost":{{"input":1,"output":2}},"limit":{{"context":{context},"output":{output}}}}}"#
        )
    };
    let models = [
        entry("fake-model", 128_000, 8_192),
        entry("backup", 128_000, 8_192),
        entry("spare", 128_000, 8_192),
        entry("third", 128_000, 8_192),
        entry("narrow", 2_048, 1_024),
    ]
    .join(",");
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(&format!(
                r#"{{"fake":{{"id":"fake","name":"Fake","env":[],"npm":"{PACKAGE}","api":"https://example.test/v1","models":{{{models}}}}}}}"#
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog
        .configure(&[parse_json(&format!(
            r#"{{"model":{{"providerID":"fake","model":"fake-model"}},"providers":{{"fake":{{"package":"{PACKAGE}","models":{{{models}}},"settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#
        ))
        .unwrap()])
        .unwrap();
    catalog
}

fn responses_catalog(endpoint: &str) -> Catalog {
    let entry = |id: &str| {
        format!(
            r#""{id}":{{"id":"{id}","name":"{id}","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"limit":{{"context":128000,"output":8192}}}}"#
        )
    };
    let models = [entry("gpt-5.5"), entry("gpt-5.4")].join(",");
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(&format!(
                r#"{{"openai":{{"id":"openai","name":"OpenAI","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai","api":"https://api.openai.com/v1","models":{{{models}}}}}}}"#
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog
        .configure(&[parse_json(&format!(
            r#"{{"model":{{"providerID":"openai","model":"gpt-5.5"}},"providers":{{"openai":{{"package":"@ai-sdk/openai","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#
        ))
        .unwrap()])
        .unwrap();
    catalog
}

fn initial_context(store: &Store) {
    store
        .submit(|tx| {
            tables::RevisionTable::insert(
                tx,
                &tables::Revision {
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
            tables::ContextStateTable::insert(
                tx,
                &tables::ContextState {
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
}

fn configuration(fallbacks: &str, global: Option<&str>, deny_guidance: bool) -> Arc<Configuration> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "ycoding-runner-fallback-config-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(root.join("config/ycoding")).unwrap();
    if let Some(global) = global {
        std::fs::write(
            root.join("config/ycoding/ycoding.json"),
            format!(r#"{{"model_fallbacks":{global}}}"#),
        )
        .unwrap();
    }
    let configuration = Configuration::load(LoadOptions {
        directory: root.clone(),
        roots: Roots::development(&root).unwrap(),
        project: false,
        file: None,
        content: Some(format!(
            r#"{{"model_fallbacks":{fallbacks}{}}}"#,
            if deny_guidance {
                r#","capabilities":{"builtin_instructions":{"deny":["model-guidance"]}}"#
            } else {
                ""
            }
        )),
        env: Default::default(),
    })
    .unwrap();
    assert!(
        configuration.diagnostics.is_empty(),
        "{:?}",
        configuration.diagnostics
    );
    Arc::new(configuration)
}

fn registry(store: &Store, tool: Tool) -> (Arc<Registry>, Box<dyn std::any::Any>) {
    let registry = Arc::new(Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &Roots::development(&std::env::temp_dir().join("ycoding-fallback-output")).unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    ));
    let selection = match tool {
        Tool::None => return (registry, Box::new(())),
        Tool::Echo => None,
        Tool::Select(model) => Some(model),
    };
    let service = Service::new(store.client());
    let registration = registry
        .register(
            vec![(
                "echo".into(),
                Arc::new(DynamicTool::new(
                    "Echo input",
                    parse_json(
                        r#"{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}"#,
                    )
                    .unwrap(),
                    None,
                    None,
                    move |input, _| {
                        let service = service.clone();
                        Box::pin(async move {
                            if let Some(model) = selection {
                                service
                                    .publish(NewEvent {
                                        id: "evt_select_model".into(),
                                        aggregate_id: "ses_one".into(),
                                        created: 2,
                                        type_: "session.model.selected.1".into(),
                                        data: ObjectEncoder::new()
                                            .field("sessionID", "ses_one")
                                            .field("model", &reference(model))
                                            .finish(),
                                    })
                                    .await
                                    .unwrap();
                            }
                            Ok(ycoding_ai::llm::ToolOutput {
                                structured: input,
                                content: Vec::new(),
                            })
                        })
                    },
                )),
            )],
            ycoding_core::tools::registry::Options::direct(),
        )
        .unwrap();
    (registry, Box::new(registration))
}

async fn server(
    replies: Vec<Reply>,
) -> (
    String,
    mpsc::UnboundedReceiver<JsonValue>,
    mpsc::UnboundedReceiver<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::unbounded_channel();
    let (streamed, streaming) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        for reply in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let boundary = loop {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
                if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break boundary + 4;
                }
            };
            let length = std::str::from_utf8(&request[..boundary])
                .unwrap()
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            while request.len() - boundary < length {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            send.send(
                parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap())
                    .unwrap(),
            )
            .unwrap();
            let (status, extra, body, declared) = match reply {
                Reply::Stream(body) => (200, "", body, body.len()),
                Reply::Status(status, extra, body) => (status, extra, body, body.len()),
                Reply::Truncated(body) | Reply::Hang(body) => (200, "", body, body.len() + 4096),
            };
            let response = format!(
                "HTTP/1.1 {status} Response\r\nContent-Type: {}\r\nContent-Length: {declared}\r\n{extra}Connection: close\r\n\r\n{body}",
                if status == 200 {
                    "text/event-stream"
                } else {
                    "application/json"
                }
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            if let Reply::Hang(_) = reply {
                stream.flush().await.unwrap();
                streamed.send(()).unwrap();
                std::future::pending::<()>().await;
            }
        }
    });
    (address, receive, streaming, task)
}

async fn admit(service: &Service, name: &str, text: &str) {
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new(format!("msg_{name}")).unwrap(),
            session_id: id(),
            input: session_pending::Message::decode(
                &parse_json(&format!(
                    r#"{{"type":"user","data":{{"text":"{text}"}},"delivery":"steer"}}"#
                ))
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new(format!("evt_{name}")).unwrap(),
            created: 1,
        })
        .await
        .unwrap();
}

fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

fn reference(id: &str) -> ycoding_schema::model::Ref {
    ycoding_schema::model::Ref::decode(
        &ObjectEncoder::new()
            .field("providerID", "fake")
            .field("id", id)
            .finish(),
    )
    .unwrap()
}

fn reference_of(value: &JsonValue) -> ycoding_schema::model::Ref {
    ycoding_schema::model::Ref::decode(value).unwrap()
}

fn requested(requests: &mut mpsc::UnboundedReceiver<JsonValue>) -> Vec<String> {
    std::iter::from_fn(|| requests.try_recv().ok())
        .map(|body| text(field(&body, "model")))
        .collect()
}

fn events(store: &Store) -> Vec<(String, JsonValue)> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<tables::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .map(|event| {
            let kind = event.record.type_.to_utf8().unwrap();
            let name = kind
                .rsplit_once('.')
                .map_or(kind.as_str(), |(name, _)| name);
            (name.to_string(), event.record.data)
        })
        .collect()
}

fn count(events: &[(String, JsonValue)], kind: &str) -> usize {
    events.iter().filter(|(name, _)| name == kind).count()
}

fn data(events: &[(String, JsonValue)], kind: &str) -> Vec<JsonValue> {
    events
        .iter()
        .filter(|(name, _)| name == kind)
        .map(|(_, data)| data.clone())
        .collect()
}

fn terminals(events: &[(String, JsonValue)]) -> Vec<&str> {
    events
        .iter()
        .map(|(name, _)| name.as_str())
        .filter(|name| matches!(*name, "session.step.ended" | "session.step.failed"))
        .collect()
}

fn started_models(events: &[(String, JsonValue)]) -> Vec<ycoding_schema::model::Ref> {
    data(events, "session.step.started")
        .iter()
        .map(|data| reference_of(field(data, "model")))
        .collect()
}

fn reroute_errors(events: &[(String, JsonValue)]) -> Vec<(String, String)> {
    data(events, "session.step.rerouted")
        .iter()
        .map(|data| {
            (
                text(field(field(data, "model"), "id")),
                text(field(field(data, "error"), "type")),
            )
        })
        .collect()
}

fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("expected an object with {key}")
    };
    object
        .get(&key.into())
        .unwrap_or_else(|| panic!("missing {key}"))
}

fn text(value: &JsonValue) -> String {
    let JsonValue::String(text) = value else {
        panic!("expected a string")
    };
    text.to_utf8().unwrap()
}

fn only_assistant(service: &Service) -> ycoding_schema::session_message::Assistant {
    let assistants = service
        .context(&id())
        .unwrap()
        .into_iter()
        .filter_map(|message| match message {
            session_message::Info::Assistant(assistant) => Some((*assistant).clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        assistants.len(),
        1,
        "one carried Step has one assistant message"
    );
    assistants.into_iter().next().unwrap()
}

fn provider_requests(store: &Store) -> Vec<Request> {
    ycoding_store::resources::requests(
        &store.snapshot().unwrap(),
        &"ses_one".into(),
        ycoding_store::IndexOrder::Ascending,
        None,
        50,
    )
    .unwrap()
    .into_iter()
    .map(|entry| entry.record)
    .collect()
}

fn total_tokens(row: &Request) -> f64 {
    let tokens = row.tokens.domain().unwrap();
    tokens.input.get()
        + tokens.output.get()
        + tokens.reasoning.get()
        + tokens.cache.read.get()
        + tokens.cache.write.get()
}

fn incidents(store: &Store) -> Vec<Incident> {
    let mut rows = store
        .snapshot()
        .unwrap()
        .scan::<IncidentTable>(Bound::Unbounded, Bound::Unbounded, 100)
        .unwrap();
    rows.sort_by_key(|row| row.time_created);
    rows
}
