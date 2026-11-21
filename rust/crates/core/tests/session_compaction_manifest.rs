use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::session::{
    compaction::{self, Input, LiveState},
    compaction_execution,
    compaction_job::AdmitInput,
    compaction_policy::{Info, resolve},
    compaction_summary::{Generate, SUMMARY_TEMPLATE},
    context_manifest::{Manifest, ProtectedStateEntry, ProtectedStateSource},
    context_pressure::estimate,
    runner::Clock,
    store::Service,
    summary_toon::{self, Memory, ParseOptions},
};
use ycoding_schema::{
    JsonValue, parse_json, schema::NonNegativeInt, session, session_compaction, session_message,
};
use ycoding_store::session::{
    ContextState, ContextStateTable, Job, Message, MessageTable, Revision, RevisionTable,
};

#[path = "session_support/mod.rs"]
mod support;

struct StillClock;

impl Clock for StillClock {
    fn now(&self) -> i64 {
        10
    }
    fn sleep(&self, milliseconds: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(async move {
            if milliseconds >= 10_000 {
                std::future::pending::<()>().await;
            }
            tokio::task::yield_now().await;
        })
    }
}

fn prepared(texts: &[String]) -> (ycoding_store::Store, Service) {
    let store = support::store();
    let rows = texts.to_vec();
    store
        .submit(move |tx| {
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
            )?;
            for (index, text) in rows.iter().enumerate() {
                let seq = index as i64 + 1;
                let last = index + 1 == rows.len();
                let (kind, data) = if last {
                    (
                        "user",
                        format!(
                            r#"{{"text":{},"time":{{"created":{seq},"consumed":{seq}}}}}"#,
                            ycoding_schema::stringify_json(&JsonValue::String(text.as_str().into()))
                        ),
                    )
                } else {
                    (
                        "assistant",
                        format!(
                            r#"{{"agent":"build","model":{{"providerID":"test","id":"manifest-model"}},"content":[{{"type":"text","text":{}}}],"finish":"stop","time":{{"created":{seq},"completed":{seq}}}}}"#,
                            ycoding_schema::stringify_json(&JsonValue::String(text.as_str().into()))
                        ),
                    )
                };
                MessageTable::insert(
                    tx,
                    &Message {
                        id: format!("msg_{seq:02}").as_str().into(),
                        session_id: "ses_one".into(),
                        type_: kind.into(),
                        seq,
                        time_created: seq,
                        time_updated: seq,
                        data: parse_json(&data).unwrap(),
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    (store, service)
}

async fn admit(
    service: &Service,
    count: usize,
    trigger: session_compaction::Trigger,
    target: i64,
) -> Job {
    service
        .compaction_admit(
            AdmitInput {
                id: None,
                session: session::Id::new("ses_one").unwrap(),
                trigger,
                requested_through_message: session_message::Id::new(format!("msg_{count:02}"))
                    .unwrap(),
                requested_through_seq: count as i64,
                base_context_revision: 0,
                target_max_input_tokens: target,
                config_digest: "c".repeat(64),
                pressure: None,
            },
            5,
        )
        .await
        .unwrap()
}

fn policy(keep_recent: i64, passes: i64) -> ycoding_core::session::compaction_policy::Resolved {
    resolve(&[Info {
        keep_recent_messages: Some(keep_recent),
        max_internal_passes: Some(passes),
        ..Info::default()
    }])
}

struct Recorder {
    prompts: Mutex<Vec<String>>,
    calls: AtomicUsize,
}

fn recorder() -> Arc<Recorder> {
    Arc::new(Recorder {
        prompts: Mutex::new(Vec::new()),
        calls: AtomicUsize::new(0),
    })
}

fn through(prompt: &str) -> i64 {
    let marker = "up to and including ";
    let start = prompt.find(marker).unwrap() + marker.len();
    prompt[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap()
}

fn memory(through: i64) -> Memory {
    Memory {
        through_sequence: through,
        objective: "Model-authored checkpoint".into(),
        in_progress: vec![],
        pending: vec![],
        blocked: vec![],
        decision: vec![],
        skill: vec![],
        requirements: vec![],
        acceptance_criteria: vec![],
        current_state: "Model-authored state".into(),
        facts: vec![],
        preferences: vec![],
        constraints: vec![],
        completed: vec![],
        unresolved: vec![],
        important_identifiers: vec![],
        continuation: "Continue".into(),
    }
}

fn no_live_state(_: &session::Id) -> Result<LiveState, session_compaction::FailureCode> {
    Ok(LiveState::default())
}

async fn build(
    store: &Service,
    job: &Job,
    policy: &ycoding_core::session::compaction_policy::Resolved,
    recorder: &Arc<Recorder>,
    respond: Option<&(dyn Fn(usize, i64) -> Option<String> + Sync)>,
) -> Result<Manifest, session_compaction::FailureCode> {
    build_with(store, job, policy, recorder, respond, &no_live_state).await
}

async fn build_with(
    store: &Service,
    job: &Job,
    policy: &ycoding_core::session::compaction_policy::Resolved,
    recorder: &Arc<Recorder>,
    respond: Option<&(dyn Fn(usize, i64) -> Option<String> + Sync)>,
    live_state: compaction::LoadLiveState<'_>,
) -> Result<Manifest, session_compaction::FailureCode> {
    let record = recorder.clone();
    let generate =
        move |prompt: String| -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            let call = record.calls.fetch_add(1, Ordering::SeqCst) + 1;
            let through = through(&prompt);
            record.prompts.lock().unwrap().push(prompt);
            Box::pin(async move { respond.and_then(|respond| respond(call, through)) })
        };
    let generate: Generate<'_> = &generate;
    compaction::manifest(Input {
        store,
        job,
        policy,
        helper_context_window: respond.map(|_| 100_000),
        generate: respond.map(|_| generate),
        live_state,
    })
    .await
}

fn summary_text(manifest: &Manifest) -> String {
    manifest
        .summary
        .as_ref()
        .expect("a rolling summary")
        .text
        .to_utf8()
        .unwrap()
}

fn assert_strict_summary(manifest: &Manifest, through: i64) {
    let parsed = summary_toon::parse(
        &summary_text(manifest),
        &ParseOptions {
            through_sequence: through,
        },
    )
    .expect("canonical TOON checkpoint");
    assert_eq!(summary_toon::encode(&parsed), summary_text(manifest));
    assert!(manifest.retained_tokens < manifest.input_tokens);
}

fn long(label: &str, count: usize) -> Vec<String> {
    (0..count)
        .map(|index| format!("unique {label} material {index} ").repeat(120))
        .chain(["Compaction boundary".to_string()])
        .collect()
}

#[tokio::test]
async fn helper_requests_are_bounded_toon_batches_authored_by_the_template_system_prompt() {
    let texts = long("checkpoint", 6);
    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Consider,
        4_096,
    )
    .await;
    let recorder = recorder();
    let respond = |_: usize, through: i64| Some(summary_toon::encode(&memory(through)));
    let manifest = build(&service, &job, &policy(1, 8), &recorder, Some(&respond))
        .await
        .unwrap();
    let prompts = recorder.prompts.lock().unwrap().clone();
    assert!(prompts.len() > 1);
    assert_eq!(
        prompts
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        prompts.len()
    );
    assert!(prompts.iter().all(|prompt| {
        !prompt.contains("Output exactly one TOON document")
            && estimate(&format!("{SUMMARY_TEMPLATE}\n\n{prompt}")) <= 4_096
    }));
    assert_eq!(manifest.covered_through.seq.get(), texts.len() as i64);
    assert!(manifest.exclusions.is_empty());
    assert_strict_summary(&manifest, texts.len() as i64 - 1);
    assert!(summary_text(&manifest).contains("Model-authored checkpoint"));
}

#[tokio::test]
async fn malformed_helper_output_falls_back_to_one_request_and_a_local_canonical_checkpoint() {
    let texts = long("malformed fallback", 1);
    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Consider,
        100_000,
    )
    .await;
    let recorder = recorder();
    let respond = |_: usize, _: i64| Some(r#"{"schemaVersion":1}"#.to_string());
    let manifest = build(&service, &job, &policy(0, 2), &recorder, Some(&respond))
        .await
        .unwrap();
    assert_eq!(recorder.calls.load(Ordering::SeqCst), 1);
    assert_strict_summary(&manifest, 2);
}

#[tokio::test]
async fn a_helper_provider_failure_stops_later_batches_and_completes_from_the_local_checkpoint() {
    let texts = long("provider fallback", 6);
    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Consider,
        4_096,
    )
    .await;
    let recorder = recorder();
    let respond = |_: usize, _: i64| None;
    let manifest = build(&service, &job, &policy(1, 8), &recorder, Some(&respond))
        .await
        .unwrap();
    assert_eq!(recorder.calls.load(Ordering::SeqCst), 1);
    assert_strict_summary(&manifest, texts.len() as i64 - 1);
}

#[tokio::test]
async fn without_a_helper_model_no_provider_request_is_made_and_the_checkpoint_still_reduces() {
    let texts = long("local checkpoint", 2);
    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Consider,
        2_048,
    )
    .await;
    let recorder = recorder();
    let manifest = build(&service, &job, &policy(1, 8), &recorder, None)
        .await
        .unwrap();
    assert_eq!(recorder.calls.load(Ordering::SeqCst), 0);
    assert_strict_summary(&manifest, 2);
}

#[tokio::test]
async fn later_helper_batches_merge_without_erasing_earlier_memory() {
    let texts = (0..10)
        .map(|index| format!("ordinary batch material {index} {}", "detail ".repeat(400)))
        .chain(["Compaction boundary".to_string()])
        .collect::<Vec<_>>();
    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Mandatory,
        4_096,
    )
    .await;
    let recorder = recorder();
    let respond = |call: usize, through: i64| {
        Some(summary_toon::encode(&if call == 1 {
            Memory {
                objective: "Preserve BATCH-OBJECTIVE-1".into(),
                requirements: vec!["Keep BATCH-REQUIREMENT-1".into()],
                ..memory(through)
            }
        } else {
            Memory {
                objective: "Later helper output omitted the earlier memory".into(),
                ..memory(through)
            }
        }))
    };
    let manifest = build(&service, &job, &policy(0, 8), &recorder, Some(&respond))
        .await
        .unwrap();
    assert!(recorder.calls.load(Ordering::SeqCst) > 1);
    assert!(summary_text(&manifest).contains("BATCH-OBJECTIVE-1"));
    assert!(summary_text(&manifest).contains("BATCH-REQUIREMENT-1"));
}

#[tokio::test]
async fn an_exhausted_internal_pass_limit_keeps_the_accumulated_helper_memory() {
    let texts = (0..10)
        .map(|index| format!("pass exhaustion material {index} {}", "detail ".repeat(400)))
        .chain(["Compaction boundary".to_string()])
        .collect::<Vec<_>>();
    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Mandatory,
        4_096,
    )
    .await;
    let recorder = recorder();
    let respond = |_: usize, through: i64| {
        Some(summary_toon::encode(&Memory {
            objective: "Preserve PASS-OBJECTIVE-1".into(),
            pending: vec!["Continue PASS-PENDING-1 after local batches".into()],
            ..memory(through)
        }))
    };
    let manifest = build(&service, &job, &policy(0, 1), &recorder, Some(&respond))
        .await
        .unwrap();
    assert_eq!(recorder.calls.load(Ordering::SeqCst), 1);
    assert!(summary_text(&manifest).contains("PASS-OBJECTIVE-1"));
    assert!(summary_text(&manifest).contains("PASS-PENDING-1"));
}

#[tokio::test]
async fn a_target_too_small_for_any_batch_still_activates_a_reducing_checkpoint() {
    let texts = vec![
        format!("irreducible target source {}", "material ".repeat(600)),
        "Compaction boundary".to_string(),
    ];
    let (_store, service) = prepared(&texts);
    let job = admit(&service, 1, session_compaction::Trigger::Mandatory, 1).await;
    let recorder = recorder();
    let manifest = build(&service, &job, &policy(0, 8), &recorder, None)
        .await
        .unwrap();
    assert!(manifest.retained_tokens < manifest.input_tokens);
}

#[tokio::test]
async fn live_state_is_loaded_once_after_generation_and_retained_and_protected_in_the_manifest() {
    let texts = long("live state", 2);
    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Mandatory,
        100_000,
    )
    .await;
    let recorder = recorder();
    let respond = |_: usize, through: i64| Some(summary_toon::encode(&memory(through)));
    let loads = AtomicUsize::new(0);
    let entry = ProtectedStateEntry {
        source: ProtectedStateSource::Todos,
        revision: NonNegativeInt::new(3).unwrap(),
        digest: "a".repeat(64).as_str().into(),
    };
    let live = |_: &session::Id| {
        loads.fetch_add(1, Ordering::SeqCst);
        Ok(LiveState {
            required_texts: vec![
                "Authoritative current Session state (JSON): {\"todos\":[\"LIVE-TODO-1\"]}".into(),
            ],
            protected_state: vec![entry.clone()],
        })
    };
    let manifest = build_with(
        &service,
        &job,
        &policy(0, 8),
        &recorder,
        Some(&respond),
        &live,
    )
    .await
    .unwrap();
    assert_eq!(loads.load(Ordering::SeqCst), 1);
    assert_eq!(recorder.calls.load(Ordering::SeqCst), 1);
    assert!(summary_text(&manifest).contains("LIVE-TODO-1"));
    assert_eq!(manifest.protected_state, vec![entry]);
}

#[tokio::test]
async fn a_failed_live_state_load_fails_the_manifest_with_its_code() {
    let texts = long("live state failure", 2);
    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Mandatory,
        100_000,
    )
    .await;
    let recorder = recorder();
    let live = |_: &session::Id| Err(session_compaction::FailureCode::MigrationFailed);
    let failure = build_with(&service, &job, &policy(0, 8), &recorder, None, &live)
        .await
        .unwrap_err();
    assert_eq!(failure, session_compaction::FailureCode::MigrationFailed);
}

#[tokio::test]
async fn a_boundary_that_is_not_canonical_history_is_unresolved() {
    let texts = long("missing boundary", 2);
    let (_store, service) = prepared(&texts);
    let mut job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Consider,
        4_096,
    )
    .await;
    job.requested_through_message_id = "msg_missing".into();
    let recorder = recorder();
    assert_eq!(
        build(&service, &job, &policy(1, 8), &recorder, None)
            .await
            .unwrap_err(),
        session_compaction::FailureCode::ContextLimitUnresolved
    );
}

fn run_with<'a>(
    service: &'a Service,
    id: &'a session_compaction::Id,
    builder: compaction_execution::Builder<'a>,
) -> impl Future<Output = Result<Job, ycoding_core::session::compaction_job::CompactionError>> + 'a
{
    compaction_execution::run(service, &StillClock, id, builder)
}

fn job_id(job: &Job) -> session_compaction::Id {
    <session_compaction::Id as ycoding_schema::DomainDecode>::decode(&JsonValue::String(
        job.id.clone(),
    ))
    .unwrap()
}

#[tokio::test]
async fn running_a_job_stores_the_manifest_and_activates_the_checkpoint_in_one_settlement() {
    let texts = long("activation", 3);
    let (store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Mandatory,
        4_096,
    )
    .await;
    let id = job_id(&job);
    let recorder = recorder();
    let policy = policy(0, 8);
    let builder = |job: Job| -> compaction_execution::ManifestFuture<'_> {
        let service = &service;
        let policy = &policy;
        let recorder = &recorder;
        Box::pin(async move { build(service, &job, policy, recorder, None).await })
    };
    let ended = run_with(&service, &id, &builder).await.unwrap();
    assert_eq!(ended.status.as_str(), Some("ended"));
    let state = store
        .snapshot()
        .unwrap()
        .get::<ContextStateTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(state.revision, 1);
    assert_eq!(state.covered_through_seq, Some(texts.len() as i64));
    let history = service
        .model_history(&session::Id::new("ses_one").unwrap())
        .unwrap();
    let first = &history[0];
    let session_message::Info::Synthetic(checkpoint) = &first.message else {
        panic!("the active checkpoint replaces the covered history")
    };
    assert!(
        checkpoint
            .id
            .as_lossless()
            .to_utf8()
            .unwrap()
            .starts_with("msg_compaction_")
    );
    assert!(
        checkpoint
            .text
            .to_utf8()
            .unwrap()
            .contains("<conversation-checkpoint>")
    );
}

#[tokio::test]
async fn a_protected_state_change_is_retried_once_per_attempt_and_other_failures_fail_the_job() {
    let texts = long("retry", 3);
    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Mandatory,
        4_096,
    )
    .await;
    let id = job_id(&job);
    let recorder = recorder();
    let policy = policy(0, 8);
    let attempts = AtomicUsize::new(0);
    let builder = |job: Job| -> compaction_execution::ManifestFuture<'_> {
        let service = &service;
        let policy = &policy;
        let recorder = &recorder;
        let attempts = &attempts;
        Box::pin(async move {
            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(session_compaction::FailureCode::ProtectedStateChanged);
            }
            build(service, &job, policy, recorder, None).await
        })
    };
    let ended = run_with(&service, &id, &builder).await.unwrap();
    assert_eq!(ended.status.as_str(), Some("ended"));
    assert_eq!(attempts.load(Ordering::SeqCst), 2);

    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Mandatory,
        4_096,
    )
    .await;
    let id = job_id(&job);
    let always = AtomicUsize::new(0);
    let builder = |_: Job| -> compaction_execution::ManifestFuture<'_> {
        let always = &always;
        Box::pin(async move {
            always.fetch_add(1, Ordering::SeqCst);
            Err(session_compaction::FailureCode::ProtectedStateChanged)
        })
    };
    let failed = run_with(&service, &id, &builder).await.unwrap();
    assert_eq!(always.load(Ordering::SeqCst), 3);
    assert_eq!(failed.status.as_str(), Some("failed"));
    assert_eq!(
        failed.error_code.as_ref().and_then(|code| code.as_str()),
        Some("protected_state_changed")
    );

    let (_store, service) = prepared(&texts);
    let job = admit(
        &service,
        texts.len(),
        session_compaction::Trigger::Mandatory,
        4_096,
    )
    .await;
    let id = job_id(&job);
    let builder = |_: Job| -> compaction_execution::ManifestFuture<'_> {
        Box::pin(async { Err(session_compaction::FailureCode::ContextLimitUnresolved) })
    };
    let failed = run_with(&service, &id, &builder).await.unwrap();
    assert_eq!(
        failed.error_code.as_ref().and_then(|code| code.as_str()),
        Some("context_limit_unresolved")
    );
    assert_eq!(NonNegativeInt::new(0).unwrap().get(), 0);
}
