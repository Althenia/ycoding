use serde_json::{Value, json};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, Semaphore};
use ycoding_core::meeting::BoxFuture;
use ycoding_core::meeting::bridge::CaptureMessage;
use ycoding_core::meeting::config::{MeetingConfig, TranscriptionConfig};
use ycoding_core::meeting::intelligence::Generate;
use ycoding_core::meeting::pcm::{AudioChunk, AudioSource};
use ycoding_core::meeting::runtime::{
    HEARTBEAT_TIMEOUT, MeetingRuntime, ProviderFactory, RuntimeOptions,
};
use ycoding_core::meeting::store::{Change, MeetingDatabase, now};
use ycoding_core::meeting::transcription::{
    ErrorKind, Health, TranscribeContext, Transcript, TranscriptionError, TranscriptionProvider,
};

const DEFAULT_MODEL: &str = "biodatlab/whisper-th-large-v3-combined";
const ALTERNATE_MODEL: &str = "openai/whisper-large-v3";
static NEXT: AtomicU64 = AtomicU64::new(0);

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(25), work)
        .await
        .expect("runtime test exceeded 25 seconds")
}

struct Call {
    chunk: AudioChunk,
    model: String,
    healthy: Arc<AtomicBool>,
}

type Outcome = Result<Vec<Transcript>, String>;

#[derive(Clone)]
struct Script(Arc<dyn Fn(Call) -> BoxFuture<'static, Outcome> + Send + Sync>);

fn script<F, Fut>(run: F) -> Script
where
    F: Fn(Call) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Outcome> + Send + 'static,
{
    Script(Arc::new(move |call| Box::pin(run(call))))
}

fn said(start_ms: f64, end_ms: f64, text: &str) -> Vec<Transcript> {
    vec![Transcript {
        start_ms,
        end_ms,
        text: text.into(),
    }]
}

struct Fake {
    model: String,
    healthy: Arc<AtomicBool>,
    script: Script,
}

impl TranscriptionProvider for Fake {
    fn id(&self) -> &str {
        "huggingface"
    }

    fn initialize<'a>(
        &'a self,
        _: &'a TranscriptionConfig,
    ) -> BoxFuture<'a, Result<(), TranscriptionError>> {
        Box::pin(async { Ok(()) })
    }

    fn transcribe<'a>(
        &'a self,
        chunk: &'a AudioChunk,
        _: TranscribeContext,
    ) -> BoxFuture<'a, Result<Vec<Transcript>, TranscriptionError>> {
        let run = (self.script.0)(Call {
            chunk: chunk.clone(),
            model: self.model.clone(),
            healthy: self.healthy.clone(),
        });
        let healthy = self.healthy.load(Ordering::SeqCst);
        Box::pin(async move {
            let failure = |message: String| TranscriptionError {
                kind: ErrorKind::Failure,
                message,
            };
            if !healthy {
                return Err(failure("Provider process is gone".into()));
            }
            run.await.map_err(failure)
        })
    }

    fn health_check(&self) -> BoxFuture<'_, Result<Health, TranscriptionError>> {
        Box::pin(async move {
            let healthy = self.healthy.load(Ordering::SeqCst);
            Ok(Health {
                healthy,
                initialized: healthy,
                metrics: None,
            })
        })
    }

    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move { self.healthy.store(false, Ordering::SeqCst) })
    }
}

struct Fixture {
    directory: PathBuf,
    database: MeetingDatabase,
    runtime: Arc<MeetingRuntime>,
    initializations: Arc<AtomicUsize>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn directory() -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "ycoding-meeting-runtime-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

fn base() -> Value {
    json!({ "transcription": { "chunkSeconds": 1, "overlapSeconds": 0 } })
}

async fn fixture(run: Script) -> Fixture {
    fixture_with(run, base()).await
}

async fn fixture_with(run: Script, config: Value) -> Fixture {
    open(directory(), run, config).await
}

async fn open(directory: PathBuf, run: Script, config: Value) -> Fixture {
    open_with(directory, run, config, None).await
}

async fn open_with(
    directory: PathBuf,
    run: Script,
    config: Value,
    generate: Option<Generate>,
) -> Fixture {
    let initializations = Arc::new(AtomicUsize::new(0));
    let counter = initializations.clone();
    let factory: ProviderFactory = Arc::new(move |config: &TranscriptionConfig| {
        counter.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(Fake {
            model: config.model.clone(),
            healthy: Arc::new(AtomicBool::new(true)),
            script: run.clone(),
        }) as Arc<dyn TranscriptionProvider>)
    });
    let database = MeetingDatabase::open(&directory.join("meetings.redb")).unwrap();
    let runtime = MeetingRuntime::new(RuntimeOptions {
        directory: directory.clone(),
        database: database.clone(),
        config: MeetingConfig::parse(&config).unwrap(),
        create_session: Arc::new(|_, _| Box::pin(async { Ok("analysis-session".to_owned()) })),
        provider_factory: Some(factory),
        heartbeat_timeout: HEARTBEAT_TIMEOUT,
        generate,
        mcp: None,
    })
    .await
    .unwrap();
    Fixture {
        directory,
        database,
        runtime,
        initializations,
    }
}

fn silent() -> Script {
    script(|_| async { Ok(Vec::new()) })
}

#[tokio::test]
async fn model_switch_drains_healthy_audio_before_disposal_and_preserves_model_attribution() {
    bounded(async {
        let models = Arc::new(Mutex::new(Vec::new()));
        let recorded = models.clone();
        let fixture = fixture(script(move |call| {
            let recorded = recorded.clone();
            async move {
                assert!(call.healthy.load(Ordering::SeqCst));
                recorded.lock().unwrap().push(call.model);
                Ok(said(
                    call.chunk.start_ms,
                    call.chunk.start_ms + 400.0,
                    "Speech",
                ))
            }
        }))
        .await;
        let old = arm(&fixture.runtime).await;
        fixture
            .runtime
            .capture(CaptureMessage::Audio {
                capture_id: "capture".into(),
                source: AudioSource::Remote,
                sequence: 0,
                start_ms: 0.0,
                sample_rate: 16000,
                samples: vec![0.2; 8000],
            })
            .await
            .unwrap();
        assert!(models.lock().unwrap().is_empty());
        let view = fixture
            .runtime
            .control(json!({ "action": "model-select", "model": ALTERNATE_MODEL }))
            .await
            .unwrap();
        assert_eq!(models.lock().unwrap().as_slice(), &[DEFAULT_MODEL]);
        assert_eq!(segments(&fixture, &old)[0]["model"], DEFAULT_MODEL);
        assert_eq!(view["health"]["model"], ALTERNATE_MODEL);
        fixture.runtime.close().await.unwrap();
    })
    .await;
}

fn audio(sequence: u64, start_ms: f64) -> CaptureMessage {
    CaptureMessage::Audio {
        capture_id: "capture".into(),
        source: AudioSource::Remote,
        sequence,
        start_ms,
        sample_rate: 16000,
        samples: vec![0.2; 16000],
    }
}

fn start() -> CaptureMessage {
    CaptureMessage::Start {
        capture_id: "capture".into(),
        microphone: false,
    }
}

fn heartbeat() -> CaptureMessage {
    CaptureMessage::Heartbeat {
        capture_id: "capture".into(),
    }
}

async fn arm(runtime: &Arc<MeetingRuntime>) -> String {
    let view = runtime.control(json!({ "action": "start" })).await.unwrap();
    let id = view["meeting"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        runtime.capture(start()).await.unwrap(),
        json!({ "accepted": true })
    );
    id
}

fn segments(fixture: &Fixture, id: &str) -> Vec<Value> {
    fixture.database.segments(id, -1, 100).unwrap()
}

fn meeting(fixture: &Fixture, id: &str) -> Value {
    fixture.database.get_meeting(id).unwrap().unwrap()
}

fn backlog(fixture: &Fixture, id: &str) -> u64 {
    fixture.runtime.status(Some(id)).unwrap()["audio"]["backlog"]
        .as_u64()
        .unwrap()
}

struct Gate {
    entered: Arc<Notify>,
    permits: Arc<Semaphore>,
}

impl Gate {
    fn new() -> Self {
        Self {
            entered: Arc::new(Notify::new()),
            permits: Arc::new(Semaphore::new(0)),
        }
    }

    fn script(&self, outcome: fn(&AudioChunk) -> Outcome) -> Script {
        let entered = self.entered.clone();
        let permits = self.permits.clone();
        script(move |call| {
            let entered = entered.clone();
            let permits = permits.clone();
            async move {
                entered.notify_one();
                permits.acquire().await.unwrap().forget();
                outcome(&call.chunk)
            }
        })
    }

    fn open(&self) {
        self.permits.add_permits(64);
    }
}

#[tokio::test]
async fn live_page_admission_preserves_duplicates_bounded_backlog_stop_finalization_and_expiry() {
    bounded(async {
        let gate = Gate::new();
        let fixture = fixture(gate.script(|chunk| {
            Ok(said(
                chunk.start_ms,
                chunk.start_ms + 900.0,
                "Retained speech",
            ))
        }))
        .await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        assert_eq!(
            runtime.capture(start()).await.unwrap(),
            json!({ "accepted": true, "duplicate": true })
        );
        assert_eq!(
            runtime.capture(audio(0, 0.0)).await.unwrap(),
            json!({ "accepted": true, "duplicate": false })
        );
        gate.entered.notified().await;
        assert_eq!(
            runtime.capture(audio(0, 0.0)).await.unwrap(),
            json!({ "accepted": true, "duplicate": true })
        );
        assert_eq!(
            runtime.capture(audio(1, 1000.0)).await.unwrap(),
            json!({ "accepted": true, "duplicate": false })
        );
        assert_eq!(backlog(&fixture, &id), 2);
        assert_eq!(
            runtime.capture(heartbeat()).await.unwrap(),
            json!({ "accepted": true })
        );
        gate.open();
        assert_eq!(
            runtime
                .capture(CaptureMessage::Stop {
                    capture_id: "capture".into(),
                    reason: "user".into()
                })
                .await
                .unwrap(),
            json!({ "stop": true })
        );
        assert_eq!(meeting(&fixture, &id)["status"], "stopped");
        let stored = segments(&fixture, &id);
        assert_eq!(stored.len(), 2);
        assert!(stored.iter().all(|segment| segment["state"] == "final"));
        assert_eq!(backlog(&fixture, &id), 0);
        assert_eq!(
            runtime.capture(heartbeat()).await.unwrap(),
            json!({ "stop": true })
        );

        let second = arm(runtime).await;
        runtime
            .expire_capture(Instant::now() + Duration::from_secs(20))
            .await
            .unwrap();
        assert_eq!(meeting(&fixture, &second)["status"], "interrupted");
        assert_eq!(
            runtime.capture(heartbeat()).await.unwrap(),
            json!({ "stop": true })
        );
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn failed_inference_stops_capture_once_keeps_diagnostics_and_permits_retry_after_terminal_stop()
 {
    bounded(async {
        let failing = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let fixture = fixture(script({
            let failing = failing.clone();
            let calls = calls.clone();
            move |call| {
                let failing = failing.clone();
                let calls = calls.clone();
                async move {
                    calls.lock().unwrap().push(call.chunk.start_ms);
                    if call.chunk.start_ms > 0.0 && failing.load(Ordering::SeqCst) {
                        return Err("ValueError: microphone\n\u{0}sample range invalid".into());
                    }
                    Ok(said(
                        call.chunk.start_ms,
                        call.chunk.start_ms + 900.0,
                        "Speech that succeeded",
                    ))
                }
            }
        }))
        .await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        runtime.capture(audio(0, 0.0)).await.unwrap();
        runtime.settled().await;
        runtime.capture(audio(1, 1000.0)).await.unwrap();
        runtime.settled().await;
        for sequence in [2, 3] {
            assert_eq!(
                runtime
                    .capture(audio(sequence, sequence as f64 * 1000.0))
                    .await
                    .unwrap(),
                json!({ "stop": true, "reason": "inference_failed" })
            );
        }
        assert_eq!(*calls.lock().unwrap(), vec![0.0, 1000.0]);
        let jobs = fixture.database.jobs(&id).unwrap();
        let failed = jobs.iter().find(|job| job["status"] == "failed").unwrap();
        assert_eq!(failed["attempts"], 1);
        assert_eq!(
            failed["error"],
            "ValueError: microphone sample range invalid"
        );
        let health = &runtime.status(Some(&id)).unwrap()["health"];
        assert_eq!(health["status"], "error");
        assert_eq!(health["error"], failed["error"]);
        assert!(
            meeting(&fixture, &id)["error"]
                .as_str()
                .unwrap()
                .contains("ValueError: microphone sample range invalid")
        );
        let stopped = runtime
            .control(json!({ "action": "stop", "meetingID": id }))
            .await
            .unwrap();
        assert_eq!(stopped["meeting"]["status"], "stopped");
        assert!(
            stopped["meeting"]["error"]
                .as_str()
                .unwrap()
                .contains("retained failed audio")
        );
        let stored = segments(&fixture, &id);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["state"], "final");
        assert_eq!(stored[0]["text"], "Speech that succeeded");
        assert_eq!(*calls.lock().unwrap(), vec![0.0, 1000.0]);
        assert_eq!(
            runtime.capture(heartbeat()).await.unwrap(),
            json!({ "stop": true, "reason": "inference_failed" })
        );

        failing.store(false, Ordering::SeqCst);
        runtime
            .control(json!({ "action": "retry", "meetingID": id }))
            .await
            .unwrap();
        let retried = fixture.database.jobs(&id).unwrap();
        let job = retried
            .iter()
            .find(|job| job["id"] == failed["id"])
            .unwrap();
        assert_eq!(
            (job["status"].clone(), job["attempts"].clone()),
            (json!("done"), json!(2))
        );
        assert_eq!(meeting(&fixture, &id)["status"], "stopped");
        assert!(meeting(&fixture, &id).get("error").is_none());
        let view = runtime.status(Some(&id)).unwrap();
        assert_eq!(view["audio"]["sources"]["remote"], "inactive");
        assert_eq!(view["health"]["status"], "ready");
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn packets_queued_during_a_failing_inference_never_retry_automatically() {
    bounded(async {
        let gate = Gate::new();
        let attempts = Arc::new(AtomicUsize::new(0));
        let fixture = fixture(script({
            let entered = gate.entered.clone();
            let permits = gate.permits.clone();
            let attempts = attempts.clone();
            move |_| {
                let entered = entered.clone();
                let permits = permits.clone();
                let attempts = attempts.clone();
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    entered.notify_one();
                    permits.acquire().await.unwrap().forget();
                    Err("RuntimeError: MPS execution failed".into())
                }
            }
        }))
        .await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        runtime.capture(audio(0, 0.0)).await.unwrap();
        gate.entered.notified().await;
        runtime.capture(audio(1, 1000.0)).await.unwrap();
        gate.open();
        runtime.settled().await;
        assert_eq!(
            runtime.capture(heartbeat()).await.unwrap(),
            json!({ "stop": true, "reason": "inference_failed" })
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(backlog(&fixture, &id), 2);
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn an_explicitly_selected_replacement_model_recovers_retained_failed_audio() {
    bounded(async {
        let fixture = fixture(script(|call| async move {
            if call.model == DEFAULT_MODEL {
                return Err("Permanent selected-model failure".into());
            }
            Ok(said(0.0, 1000.0, "Recovered retained speech"))
        }))
        .await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        runtime.capture(audio(0, 0.0)).await.unwrap();
        runtime.settled().await;
        let jobs = fixture.database.jobs(&id).unwrap();
        assert_eq!(jobs[0]["status"], "failed");
        runtime
            .control(json!({ "action": "model-select", "model": ALTERNATE_MODEL }))
            .await
            .unwrap();
        let stored = segments(&fixture, &id);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["rawText"], "Recovered retained speech");
        assert_eq!(stored[0]["model"], ALTERNATE_MODEL);
        assert_eq!(stored[0]["state"], "final");
        assert_eq!(backlog(&fixture, &id), 0);
        let saved: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.directory.join("settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["transcription"]["model"], ALTERNATE_MODEL);
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn explicit_retry_replaces_a_crashed_provider_before_processing_its_retained_window() {
    bounded(async {
        let crashed = Arc::new(AtomicBool::new(false));
        let fixture = fixture(script(move |call| {
            let crashed = crashed.clone();
            async move {
                if !crashed.swap(true, Ordering::SeqCst) {
                    call.healthy.store(false, Ordering::SeqCst);
                    return Err("Provider process crashed".into());
                }
                Ok(said(0.0, 1000.0, "Recovered speech"))
            }
        }))
        .await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        runtime.capture(audio(0, 0.0)).await.unwrap();
        runtime.settled().await;
        assert_eq!(fixture.database.jobs(&id).unwrap()[0]["status"], "failed");
        runtime
            .control(json!({ "action": "retry", "meetingID": id }))
            .await
            .unwrap();
        assert_eq!(fixture.initializations.load(Ordering::SeqCst), 2);
        let stored = segments(&fixture, &id);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["rawText"], "Recovered speech");
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn a_retry_that_joins_a_failing_inference_shares_its_failure_and_duplicates_never_re_infer() {
    bounded(async {
        let gate = Gate::new();
        let attempts = Arc::new(AtomicUsize::new(0));
        let fixture = fixture(script({
            let entered = gate.entered.clone();
            let permits = gate.permits.clone();
            let attempts = attempts.clone();
            move |_| {
                let entered = entered.clone();
                let permits = permits.clone();
                let attempts = attempts.clone();
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    entered.notify_one();
                    permits.acquire().await.unwrap().forget();
                    Err("Controlled inference failure".into())
                }
            }
        }))
        .await;
        let runtime = fixture.runtime.clone();
        let id = arm(&runtime).await;
        assert_eq!(
            runtime.capture(audio(0, 0.0)).await.unwrap(),
            json!({ "accepted": true, "duplicate": false })
        );
        gate.entered.notified().await;
        let joined = runtime.control(json!({ "action": "retry", "meetingID": id }));
        tokio::pin!(joined);
        tokio::select! {
            biased;
            _ = &mut joined => panic!("retry settled before the running inference was released"),
            _ = std::future::ready(()) => {}
        }
        runtime
            .control(json!({ "action": "status", "meetingID": id }))
            .await
            .unwrap();
        gate.open();
        let error = joined.await.unwrap_err();
        assert_eq!(error.0, "Controlled inference failure");
        let jobs = fixture.database.jobs(&id).unwrap();
        assert_eq!(
            (jobs[0]["status"].clone(), jobs[0]["attempts"].clone()),
            (json!("failed"), json!(1))
        );
        runtime.settled().await;
        assert_eq!(
            runtime.capture(audio(0, 0.0)).await.unwrap(),
            json!({ "stop": true, "reason": "inference_failed" })
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn overlapping_windows_are_reconciled_into_one_continuous_transcript() {
    bounded(async {
        let fixture = fixture_with(
            script(|call| async move {
                Ok(if call.chunk.start_ms == 0.0 {
                    said(0.0, 2000.0, "hello world")
                } else {
                    said(
                        call.chunk.start_ms,
                        call.chunk.start_ms + 2000.0,
                        "world again",
                    )
                })
            }),
            json!({ "transcription": { "chunkSeconds": 2, "overlapSeconds": 1 } }),
        )
        .await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        let message = CaptureMessage::Audio {
            capture_id: "capture".into(),
            source: AudioSource::Remote,
            sequence: 0,
            start_ms: 0.0,
            sample_rate: 16000,
            samples: vec![0.2; 48000],
        };
        runtime.capture(message).await.unwrap();
        runtime.settled().await;
        runtime
            .control(json!({ "action": "stop", "meetingID": id }))
            .await
            .unwrap();
        let stored = segments(&fixture, &id);
        let texts = stored
            .iter()
            .map(|segment| segment["text"].clone())
            .collect::<Vec<_>>();
        assert_eq!(texts, vec![json!("hello world"), json!("again")]);
        assert_eq!(stored[1]["rawText"], "world again");
        assert_eq!(stored[1]["sequence"], 2);
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn an_explicitly_configured_fallback_model_takes_over_and_is_reported() {
    bounded(async {
        let fixture = fixture_with(
            script(|call| async move {
                if call.model == DEFAULT_MODEL {
                    return Err("Selected model failed".into());
                }
                Ok(said(0.0, 900.0, "Fallback speech"))
            }),
            json!({
                "transcription": { "chunkSeconds": 1, "overlapSeconds": 0 },
                "fallback": { "enabled": true, "provider": "huggingface", "model": ALTERNATE_MODEL },
            }),
        )
        .await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        runtime.capture(audio(0, 0.0)).await.unwrap();
        runtime.settled().await;
        runtime
            .control(json!({ "action": "stop", "meetingID": id }))
            .await
            .unwrap();
        let stored = segments(&fixture, &id);
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0]["model"], ALTERNATE_MODEL);
        let health = &runtime.status(Some(&id)).unwrap()["health"];
        assert_eq!(health["status"], "fallback");
        assert!(health["warning"].as_str().unwrap().contains(ALTERNATE_MODEL));
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn pressure_replies_busy_without_admitting_input_and_recovers_after_inference() {
    bounded(async {
        let gate = Gate::new();
        let fixture = fixture_with(
            gate.script(|_| Ok(Vec::new())),
            json!({
                "transcription": { "chunkSeconds": 1, "overlapSeconds": 0 },
                "streaming": { "maxBufferedSeconds": 30 },
            }),
        )
        .await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        runtime.capture(audio(0, 0.0)).await.unwrap();
        gate.entered.notified().await;
        for sequence in 1..30 {
            assert_eq!(
                runtime
                    .capture(audio(sequence, sequence as f64 * 1000.0))
                    .await
                    .unwrap(),
                json!({ "accepted": true, "duplicate": false })
            );
        }
        assert_eq!(backlog(&fixture, &id), 30);
        assert_eq!(
            runtime.capture(audio(30, 30000.0)).await.unwrap(),
            json!({ "busy": true })
        );
        assert_eq!(backlog(&fixture, &id), 30);
        gate.open();
        runtime.settled().await;
        assert_eq!(backlog(&fixture, &id), 0);
        assert_eq!(
            runtime.capture(audio(30, 30000.0)).await.unwrap(),
            json!({ "accepted": true, "duplicate": false })
        );
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn capture_admission_requires_an_armed_ready_meeting_enabled_streaming_and_microphone_consent()
 {
    bounded(async {
        let fixture = fixture(silent()).await;
        let runtime = &fixture.runtime;
        let error = runtime.capture(start()).await.unwrap_err();
        assert_eq!(error.0, "Arm a ready meeting in YCoding before capture");
        arm(runtime).await;
        let error = runtime
            .capture(CaptureMessage::Start {
                capture_id: "other".into(),
                microphone: false,
            })
            .await
            .unwrap_err();
        assert_eq!(error.0, "Another capture is already active");
        let microphone = CaptureMessage::Audio {
            capture_id: "capture".into(),
            source: AudioSource::Microphone,
            sequence: 0,
            start_ms: 0.0,
            sample_rate: 16000,
            samples: vec![0.2; 1600],
        };
        let error = runtime.capture(microphone).await.unwrap_err();
        assert_eq!(error.0, "Microphone capture was not enabled");
        assert_eq!(
            runtime
                .capture(CaptureMessage::Audio {
                    capture_id: "unknown".into(),
                    source: AudioSource::Remote,
                    sequence: 0,
                    start_ms: 0.0,
                    sample_rate: 16000,
                    samples: vec![0.2; 1600],
                })
                .await
                .unwrap(),
            json!({ "stop": true })
        );
        let error = runtime
            .control(json!({ "action": "start" }))
            .await
            .unwrap_err();
        assert_eq!(error.0, "Stop the current recording before arming another");
        runtime.close().await.unwrap();

        let disabled = fixture_with(silent(), json!({ "streaming": { "enabled": false } })).await;
        disabled
            .runtime
            .control(json!({ "action": "start" }))
            .await
            .unwrap();
        let error = disabled.runtime.capture(start()).await.unwrap_err();
        assert_eq!(error.0, "Enable incremental chunking before live capture");
        disabled.runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn restart_interrupts_lost_captures_never_resumes_volatile_audio_and_closing_records_the_limitation()
 {
    bounded(async {
        let directory = directory();
        let fixture = open(directory.clone(), silent(), base()).await;
        fixture.database.create_meeting("lost", "Lost", "analysis-session").await.unwrap();
        fixture
            .database
            .update_meeting("lost", Some("recording"), Change::Set("lost-capture".into()), Change::Keep)
            .await
            .unwrap();
        fixture
            .database
            .put_segment(&json!({
                "id": "evidence", "meetingID": "lost", "sequence": 1, "source": "remote",
                "speakerID": "remote-unknown", "startMs": 0, "endMs": 900,
                "rawText": "Approve release", "text": "Approve release", "state": "temporary",
                "model": "test-model", "createdAt": "2026-10-12T00:00:00.000Z",
            }))
            .await
            .unwrap();
        fixture.runtime.close().await.unwrap();
        let directory = {
            let mut fixture = fixture;
            std::mem::take(&mut fixture.directory)
        };
        std::fs::create_dir_all(&directory).unwrap();

        let restarted = open(directory.clone(), silent(), base()).await;
        let recovered = meeting(&restarted, "lost");
        assert_eq!(recovered["status"], "interrupted");
        assert_eq!(
            recovered["error"],
            "Capture interrupted; volatile raw audio is unavailable after restart"
        );
        let view = restarted.runtime.status(Some("lost")).unwrap();
        assert_eq!(view["audio"]["sources"]["remote"], "inactive");
        assert_eq!(view["meeting"]["id"], "lost");
        let lost_audio = CaptureMessage::Audio {
            capture_id: "lost-capture".into(),
            source: AudioSource::Remote,
            sequence: 0,
            start_ms: 0.0,
            sample_rate: 16000,
            samples: vec![0.2; 16000],
        };
        assert_eq!(
            restarted.runtime.capture(lost_audio).await.unwrap(),
            json!({ "stop": true })
        );
        assert_eq!(segments(&restarted, "lost")[0]["state"], "temporary");
        restarted
            .runtime
            .control(json!({ "action": "stop", "meetingID": "lost" }))
            .await
            .unwrap();
        assert_eq!(segments(&restarted, "lost")[0]["state"], "final");
        assert_eq!(restarted.runtime.status(Some("lost")).unwrap()["audio"]["backlog"], 0);

        let id = arm(&restarted.runtime).await;
        restarted.runtime.capture(audio(0, 0.0)).await.unwrap();
        restarted.runtime.close().await.unwrap();
        assert_eq!(
            restarted.runtime.control(json!({ "action": "stop" })).await.unwrap_err().0,
            "Meeting runtime is closing"
        );
        assert_eq!(
            restarted.runtime.capture(heartbeat()).await.unwrap(),
            json!({ "stop": true })
        );
        restarted.runtime.close().await.unwrap();
        let reopened = MeetingDatabase::open(&directory.join("meetings.redb")).unwrap();
        let interrupted = reopened.get_meeting(&id).unwrap().unwrap();
        assert_eq!(interrupted["status"], "interrupted");
        assert_eq!(
            interrupted["error"],
            "Recording service stopped. Untranscribed volatile audio is not recoverable after restart."
        );
        reopened.close().await.unwrap();
        let mut restarted = restarted;
        restarted.directory = directory;
    })
    .await;
}

#[tokio::test]
async fn correcting_evidence_unconfirms_findings_stales_proposals_rejects_plans_and_persists_vocabulary()
 {
    bounded(async {
        let fixture = fixture(silent()).await;
        let runtime = &fixture.runtime;
        let database = &fixture.database;
        database.create_meeting("m", "Meeting", "analysis-session").await.unwrap();
        database
            .put_segment(&json!({
                "id": "evidence", "meetingID": "m", "sequence": 1, "source": "remote",
                "speakerID": "remote-unknown", "startMs": 0, "endMs": 900,
                "rawText": "Approve release", "text": "Approve release", "state": "final",
                "model": "test-model", "createdAt": now(),
            }))
            .await
            .unwrap();
        database
            .put_finding(&json!({
                "id": "decision", "meetingID": "m", "kind": "decision", "summary": "Approve release",
                "sourceSegmentIds": ["evidence"], "confidence": 1, "status": "confirmed", "createdAt": now(),
            }))
            .await
            .unwrap();
        database
            .put_proposal(&json!({
                "id": "proposal", "meetingID": "m", "server": "wiki", "target": "page", "operation": "replace",
                "existingContent": "old", "suggestedContent": "new", "explanation": "why",
                "sourceSegmentIds": ["evidence"], "references": [], "expectedRevision": "1",
                "confidence": 0.5, "status": "approved", "createdAt": now(),
            }))
            .await
            .unwrap();
        database
            .put_plan(&json!({
                "meetingID": "m", "content": "Ship", "findingIds": ["decision"],
                "sourceSegmentIds": ["evidence"], "status": "proposed", "createdAt": now(),
            }))
            .await
            .unwrap();
        runtime.control(json!({ "action": "select", "meetingID": "m" })).await.unwrap();
        for (text, segment, message) in [
            ("  ", "evidence", "A finalized segment and nonempty correction are required"),
            ("Reject", "missing", "A finalized segment and nonempty correction are required"),
        ] {
            let error = runtime
                .control(json!({ "action": "correct", "meetingID": "m", "segmentID": segment, "text": text }))
                .await
                .unwrap_err();
            assert_eq!(error.0, message);
        }
        runtime
            .control(json!({
                "action": "correct", "meetingID": "m", "segmentID": "evidence",
                "text": "Reject release via Kubernetes-v2",
            }))
            .await
            .unwrap();
        assert_eq!(database.findings("m").unwrap()[0]["status"], "unconfirmed");
        let proposal = &database.proposals("m").unwrap()[0];
        assert_eq!(proposal["status"], "stale");
        assert_eq!(proposal["error"], "Supporting transcript was corrected; reconcile and review again");
        assert_eq!(database.plan("m").unwrap().unwrap()["status"], "rejected");
        let approvals = database.approvals("m").unwrap();
        assert_eq!((approvals[0]["decision"].clone(), approvals[0]["targetID"].clone()), (json!("correct"), json!("evidence")));
        let stored = segments(&fixture, "m");
        assert_eq!(stored[0]["text"], "Reject release via Kubernetes-v2");
        assert_eq!(stored[0]["rawText"], "Approve release");
        let hints = runtime.config().vocabulary.hints;
        for term in ["Reject", "release", "via", "Kubernetes-v2"] {
            assert!(hints.iter().any(|hint| hint == term), "{term} in {hints:?}");
        }
        let saved: Value = serde_json::from_str(
            &std::fs::read_to_string(fixture.directory.join("settings.json")).unwrap(),
        )
        .unwrap();
        assert!(saved["vocabulary"]["hints"].as_array().unwrap().contains(&json!("Kubernetes-v2")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(fixture.directory.join("settings.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        arm(runtime).await;
        let error = runtime
            .control(json!({ "action": "correct", "meetingID": "m", "segmentID": "evidence", "text": "x" }))
            .await;
        assert!(error.is_ok(), "an inactive meeting stays correctable while another records");
        let active = runtime.status(None).unwrap()["meeting"]["id"].as_str().unwrap().to_owned();
        let error = runtime
            .control(json!({ "action": "correct", "meetingID": active, "segmentID": "evidence", "text": "x" }))
            .await
            .unwrap_err();
        assert_eq!(error.0, "Stop capture and finish knowledge writes before correcting evidence");
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn control_validates_commands_gates_intelligence_and_reviews_findings() {
    bounded(async {
        let fixture = fixture(silent()).await;
        let runtime = &fixture.runtime;
        let invalid = "Invalid meeting command or configuration";
        for command in [
            json!({ "action": "bogus" }),
            json!({ "action": "status", "extra": 1 }),
            json!({ "action": "stop", "meetingID": 5 }),
            json!({ "action": "delete", "confirmed": false }),
            json!({ "action": "model-install", "authorized": "yes" }),
            json!({ "action": "start", "title": "t".repeat(201) }),
            json!("status"),
        ] {
            assert_eq!(runtime.control(command).await.unwrap_err().0, invalid);
        }
        let view = runtime.control(json!({ "action": "status" })).await.unwrap();
        assert!(view.get("meeting").is_none());
        assert_eq!(view["health"]["status"], "unloaded");
        assert_eq!(view["analysis"], json!({ "status": "idle" }));
        assert_eq!(
            runtime.control(json!({ "action": "stop" })).await.unwrap_err().0,
            "Select or start a meeting first"
        );
        assert_eq!(
            runtime
                .control(json!({ "action": "select", "meetingID": "missing" }))
                .await
                .unwrap_err()
                .0,
            "Meeting not found"
        );
        assert_eq!(
            runtime.control(json!({ "action": "model-install", "model": ALTERNATE_MODEL })).await.unwrap_err().0,
            "Explicit model download authorization is required"
        );

        let view = runtime
            .control(json!({ "action": "start", "title": "Planning", "sessionID": "parent" }))
            .await
            .unwrap();
        let id = view["meeting"]["id"].as_str().unwrap().to_owned();
        assert_eq!(view["meeting"]["title"], "Planning");
        assert_eq!(view["meeting"]["status"], "ready");
        assert_eq!(view["health"]["status"], "ready");
        for action in ["summary", "plan", "reconcile"] {
            let error = runtime
                .control(json!({ "action": action, "meetingID": id }))
                .await
                .unwrap_err();
            assert_eq!(error.0, "Meeting intelligence is not available in this runtime");
        }
        for (action, proposal, message) in [
            ("approve", Some("p"), "Proposal is not awaiting review"),
            ("reject", Some("p"), "Proposal is not awaiting review"),
            ("approve", None, "Proposal ID is required"),
        ] {
            let mut command = json!({ "action": action, "meetingID": id });
            if let Some(proposal) = proposal {
                command["proposalID"] = json!(proposal);
            }
            assert_eq!(runtime.control(command).await.unwrap_err().0, message);
        }

        let finding = |name: &str| json!({
            "id": name, "meetingID": id, "kind": "decision", "summary": "Ship",
            "sourceSegmentIds": [], "confidence": 1, "status": "unconfirmed", "createdAt": now(),
        });
        fixture.database.put_finding(&finding("a")).await.unwrap();
        fixture.database.put_finding(&finding("b")).await.unwrap();
        runtime.control(json!({ "action": "confirm", "meetingID": id, "findingID": "a" })).await.unwrap();
        runtime.control(json!({ "action": "reject-finding", "meetingID": id, "findingID": "b" })).await.unwrap();
        let statuses = fixture
            .database
            .findings(&id)
            .unwrap()
            .iter()
            .map(|finding| finding["status"].clone())
            .collect::<Vec<_>>();
        assert_eq!(statuses, vec![json!("confirmed"), json!("rejected")]);
        let decisions = fixture
            .database
            .approvals(&id)
            .unwrap()
            .iter()
            .map(|approval| (approval["decision"].clone(), approval["targetID"].clone()))
            .collect::<Vec<_>>();
        assert_eq!(decisions, vec![(json!("approve"), json!("a")), (json!("reject"), json!("b"))]);
        assert_eq!(
            runtime
                .control(json!({ "action": "confirm", "meetingID": id, "findingID": "missing" }))
                .await
                .unwrap_err()
                .0,
            "Finding not found"
        );

        assert_eq!(
            runtime.control(json!({ "action": "delete", "meetingID": id })).await.unwrap_err().0,
            "Deletion needs confirmation and an idle meeting runtime"
        );
        runtime.capture(start()).await.unwrap();
        assert_eq!(
            runtime
                .control(json!({ "action": "delete", "meetingID": id, "confirmed": true }))
                .await
                .unwrap_err()
                .0,
            "Deletion needs confirmation and an idle meeting runtime"
        );
        let streaming = runtime
            .control(json!({ "action": "configure", "config": { "streaming": { "vad": false } } }))
            .await
            .unwrap_err();
        assert_eq!(streaming.0, "Stop capture before changing streaming configuration");
        runtime.control(json!({ "action": "stop", "meetingID": id })).await.unwrap();
        let configured = runtime
            .control(json!({ "action": "configure", "config": { "streaming": { "vad": false }, "transcription": { "chunkSeconds": 2, "overlapSeconds": 0 } } }))
            .await
            .unwrap();
        assert_eq!(configured["config"]["streaming"]["vad"], false);
        assert!(runtime.control(json!({ "action": "configure", "config": { "streaming": { "enabled": "yes" } } })).await.is_err());
        assert_eq!(runtime.config().transcription.chunk_seconds, 2);
        let deleted = runtime
            .control(json!({ "action": "delete", "meetingID": id, "confirmed": true }))
            .await
            .unwrap();
        assert!(deleted.get("meeting").is_none());
        assert!(fixture.database.get_meeting(&id).unwrap().is_none());
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn arming_is_refused_while_failed_audio_is_retained_and_unsupported_models_surface_diagnostics()
 {
    bounded(async {
        let fixture = fixture(script(|_| async { Err("Controlled failure".to_owned()) })).await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        runtime.capture(audio(0, 0.0)).await.unwrap();
        runtime.settled().await;
        runtime
            .control(json!({ "action": "stop", "meetingID": id }))
            .await
            .unwrap();
        assert_eq!(
            runtime
                .control(json!({ "action": "start" }))
                .await
                .unwrap_err()
                .0,
            "Explicitly retry retained failed audio before arming another meeting"
        );
        runtime.close().await.unwrap();
    })
    .await;
}

fn summarizing(prompts: &Arc<Mutex<Vec<String>>>, summary: &'static str) -> Generate {
    let prompts = prompts.clone();
    Arc::new(move |_, prompt| {
        let prompts = prompts.clone();
        Box::pin(async move {
            prompts.lock().unwrap().push(prompt);
            Ok(json!({ "summary": summary, "findings": [], "proposals": [] }).to_string())
        })
    })
}

fn final_segment(meeting: &str, id: &str, sequence: u64, text: &str, state: &str) -> Value {
    json!({
        "id": id, "meetingID": meeting, "sequence": sequence, "source": "remote",
        "speakerID": "remote-unknown", "startMs": 0, "endMs": 900, "rawText": text, "text": text,
        "state": state, "model": "test-model", "createdAt": "2026-10-12T00:00:00.000Z",
    })
}

#[tokio::test]
async fn stopping_a_capture_runs_incremental_then_final_analysis_into_durable_checkpoints() {
    bounded(async {
        let prompts = Arc::new(Mutex::new(Vec::new()));
        let fixture = open_with(
            directory(),
            script(|call| async move {
                Ok(said(
                    call.chunk.start_ms,
                    call.chunk.start_ms + 900.0,
                    "Retained speech",
                ))
            }),
            base(),
            Some(summarizing(&prompts, "Meeting summary")),
        )
        .await;
        let runtime = &fixture.runtime;
        let id = arm(runtime).await;
        runtime.capture(audio(0, 0.0)).await.unwrap();
        runtime.capture(audio(1, 1000.0)).await.unwrap();
        runtime.settled().await;
        runtime
            .control(json!({ "action": "stop", "meetingID": id }))
            .await
            .unwrap();
        runtime.settled().await;
        assert!(
            prompts
                .lock()
                .unwrap()
                .iter()
                .any(|prompt| prompt.contains("Retained speech"))
        );
        let checkpoint = fixture.database.checkpoints(&id).unwrap().pop().unwrap();
        assert_eq!(
            (
                checkpoint["throughSequence"].clone(),
                checkpoint["final"].clone(),
                checkpoint["summary"].clone()
            ),
            (json!(2), json!(true), json!("Meeting summary"))
        );
        let view = runtime.status(Some(&id)).unwrap();
        assert_eq!(view["summary"]["summary"], "Meeting summary");
        assert_eq!(view["analysis"]["status"], "idle");
        let job = fixture
            .database
            .jobs(&id)
            .unwrap()
            .into_iter()
            .find(|job| job["kind"] == "analysis")
            .unwrap();
        assert_eq!(job["status"], "done");
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn explicit_stop_and_reconciliation_finalize_durable_temporary_evidence_after_restart() {
    bounded(async {
        let first = open(directory(), silent(), base()).await;
        first
            .database
            .create_meeting("meeting", "Meeting", "analysis-session")
            .await
            .unwrap();
        first
            .database
            .update_meeting(
                "meeting",
                Some("recording"),
                Change::Set("lost-capture".into()),
                Change::Keep,
            )
            .await
            .unwrap();
        first
            .database
            .put_segment(&final_segment(
                "meeting",
                "evidence",
                1,
                "Approve release",
                "temporary",
            ))
            .await
            .unwrap();
        first.runtime.close().await.unwrap();
        let directory = {
            let mut first = first;
            std::mem::take(&mut first.directory)
        };

        let prompts = Arc::new(Mutex::new(Vec::new()));
        let restarted = open_with(
            directory,
            silent(),
            base(),
            Some(summarizing(&prompts, "Release was discussed")),
        )
        .await;
        let runtime = &restarted.runtime;
        assert_eq!(meeting(&restarted, "meeting")["status"], "interrupted");
        assert_eq!(
            runtime.status(Some("meeting")).unwrap()["audio"]["sources"]["remote"],
            "inactive"
        );
        runtime
            .control(json!({ "action": "stop", "meetingID": "meeting" }))
            .await
            .unwrap();
        runtime
            .control(json!({ "action": "reconcile", "meetingID": "meeting" }))
            .await
            .unwrap();
        runtime.settled().await;
        assert!(
            prompts
                .lock()
                .unwrap()
                .iter()
                .any(|prompt| prompt.contains("Approve release"))
        );
        let stored = segments(&restarted, "meeting");
        assert_eq!(
            (stored[0]["state"].clone(), stored[0]["rawText"].clone()),
            (json!("final"), json!("Approve release"))
        );
        let checkpoint = restarted
            .database
            .checkpoints("meeting")
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(
            (
                checkpoint["throughSequence"].clone(),
                checkpoint["final"].clone(),
                checkpoint["summary"].clone()
            ),
            (json!(1), json!(true), json!("Release was discussed"))
        );
        assert_eq!(
            runtime.status(Some("meeting")).unwrap()["audio"]["sources"]["remote"],
            "inactive"
        );
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn summary_failures_surface_as_state_and_a_running_analysis_blocks_deletion() {
    bounded(async {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let generate: Generate = {
            let (entered, release) = (entered.clone(), release.clone());
            Arc::new(move |_, _| {
                let (entered, release) = (entered.clone(), release.clone());
                Box::pin(async move {
                    entered.notify_one();
                    release.acquire().await.unwrap().forget();
                    Err("provider down".to_owned())
                })
            })
        };
        let fixture = open_with(directory(), silent(), base(), Some(generate)).await;
        let runtime = &fixture.runtime;
        fixture
            .database
            .create_meeting("m", "Meeting", "analysis-session")
            .await
            .unwrap();
        fixture
            .database
            .update_meeting("m", Some("stopped"), Change::Keep, Change::Keep)
            .await
            .unwrap();
        fixture
            .database
            .put_segment(&final_segment(
                "m",
                "evidence",
                1,
                "Approve release",
                "final",
            ))
            .await
            .unwrap();
        runtime
            .control(json!({ "action": "select", "meetingID": "m" }))
            .await
            .unwrap();
        runtime
            .control(json!({ "action": "summary", "meetingID": "m" }))
            .await
            .unwrap();
        entered.notified().await;
        assert_eq!(
            runtime.status(Some("m")).unwrap()["analysis"]["status"],
            "analyzing"
        );
        let error = runtime
            .control(json!({ "action": "delete", "meetingID": "m", "confirmed": true }))
            .await
            .unwrap_err();
        assert_eq!(
            error.0,
            "Deletion needs confirmation and an idle meeting runtime"
        );
        release.add_permits(8);
        runtime.settled().await;
        let analysis = &runtime.status(Some("m")).unwrap()["analysis"];
        assert_eq!(analysis["status"], "error");
        assert_eq!(
            analysis["error"],
            "Meeting processing failed; retained evidence is available. Retry explicitly."
        );
        let job = fixture
            .database
            .jobs("m")
            .unwrap()
            .into_iter()
            .find(|job| job["kind"] == "analysis")
            .unwrap();
        assert_eq!(job["status"], "failed");
        assert_eq!(segments(&fixture, "m").len(), 1);
        let deleted = runtime
            .control(json!({ "action": "delete", "meetingID": "m", "confirmed": true }))
            .await
            .unwrap();
        assert!(deleted.get("meeting").is_none());
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn a_plan_generated_from_corrected_evidence_never_becomes_the_current_plan() {
    bounded(async {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let generate: Generate = {
            let (entered, release) = (entered.clone(), release.clone());
            Arc::new(move |_, prompt| {
                let (entered, release) = (entered.clone(), release.clone());
                Box::pin(async move {
                    if prompt.starts_with("Create a proposed engineering plan") {
                        entered.notify_one();
                        release.acquire().await.unwrap().forget();
                        return Ok("Implement the approved release".to_owned());
                    }
                    Ok(json!({ "summary": "Release rejected", "findings": [], "proposals": [] }).to_string())
                })
            })
        };
        let fixture = open_with(directory(), silent(), base(), Some(generate)).await;
        let runtime = &fixture.runtime;
        let database = &fixture.database;
        database.create_meeting("meeting", "Meeting", "analysis-session").await.unwrap();
        database.update_meeting("meeting", Some("stopped"), Change::Keep, Change::Keep).await.unwrap();
        database.put_segment(&final_segment("meeting", "evidence", 1, "Approve release", "final")).await.unwrap();
        database
            .put_finding(&json!({
                "id": "decision", "meetingID": "meeting", "kind": "decision", "summary": "Approve release",
                "sourceSegmentIds": ["evidence"], "confidence": 1, "status": "confirmed", "createdAt": now(),
            }))
            .await
            .unwrap();
        runtime.control(json!({ "action": "select", "meetingID": "meeting" })).await.unwrap();
        runtime.control(json!({ "action": "plan", "meetingID": "meeting" })).await.unwrap();
        entered.notified().await;
        runtime
            .control(json!({ "action": "correct", "meetingID": "meeting", "segmentID": "evidence", "text": "Reject release" }))
            .await
            .unwrap();
        release.add_permits(8);
        runtime.settled().await;
        assert_eq!(database.findings("meeting").unwrap()[0]["status"], "unconfirmed");
        assert!(database.plan("meeting").unwrap().is_none());
        let approvals = database.approvals("meeting").unwrap();
        assert_eq!((approvals[0]["decision"].clone(), approvals[0]["targetID"].clone()), (json!("correct"), json!("evidence")));
        assert_eq!(runtime.status(Some("meeting")).unwrap()["analysis"]["status"], "idle");

        database.put_finding(&json!({
            "id": "decision", "meetingID": "meeting", "kind": "decision", "summary": "Approve release",
            "sourceSegmentIds": ["evidence"], "confidence": 1, "status": "confirmed", "createdAt": now(),
        })).await.unwrap();
        runtime.control(json!({ "action": "plan", "meetingID": "meeting" })).await.unwrap();
        runtime.settled().await;
        assert_eq!(database.plan("meeting").unwrap().unwrap()["status"], "proposed");
        assert_eq!(runtime.status(Some("meeting")).unwrap()["plan"]["content"], "Implement the approved release");
        runtime.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn closing_joins_owned_analysis_before_the_database_closes() {
    bounded(async {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let generate: Generate = {
            let (entered, release) = (entered.clone(), release.clone());
            Arc::new(move |_, _| {
                let (entered, release) = (entered.clone(), release.clone());
                Box::pin(async move {
                    entered.notify_one();
                    release.acquire().await.unwrap().forget();
                    Ok(json!({ "summary": "Retained analysis result", "findings": [], "proposals": [] }).to_string())
                })
            })
        };
        let fixture = open_with(directory(), silent(), base(), Some(generate)).await;
        let runtime = fixture.runtime.clone();
        fixture.database.create_meeting("m", "Meeting", "analysis-session").await.unwrap();
        fixture.database.put_segment(&final_segment("m", "evidence", 1, "Approve release", "final")).await.unwrap();
        runtime.control(json!({ "action": "select", "meetingID": "m" })).await.unwrap();
        runtime.control(json!({ "action": "summary", "meetingID": "m" })).await.unwrap();
        entered.notified().await;
        let closing = tokio::spawn({
            let runtime = runtime.clone();
            async move { runtime.close().await }
        });
        release.add_permits(8);
        closing.await.unwrap().unwrap();
        let reopened = MeetingDatabase::open(&fixture.directory.join("meetings.redb")).unwrap();
        assert_eq!(reopened.checkpoints("m").unwrap().pop().unwrap()["summary"], "Retained analysis result");
        reopened.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn approve_and_reject_controls_review_proposals_without_a_knowledge_writer() {
    bounded(async {
        let fixture = fixture(silent()).await;
        let runtime = &fixture.runtime;
        let database = &fixture.database;
        database.create_meeting("m", "Meeting", "analysis-session").await.unwrap();
        for id in ["accept", "decline"] {
            database
                .put_proposal(&json!({
                    "id": id, "meetingID": "m", "server": "wiki", "target": "page", "operation": "replace",
                    "existingContent": "old", "suggestedContent": "new", "explanation": "why",
                    "sourceSegmentIds": [], "references": [], "expectedRevision": "1",
                    "confidence": 0.5, "status": "pending", "createdAt": now(),
                }))
                .await
                .unwrap();
        }
        runtime.control(json!({ "action": "select", "meetingID": "m" })).await.unwrap();
        let view = runtime.control(json!({ "action": "approve", "proposalID": "accept" })).await.unwrap();
        let statuses = |view: &Value| view["proposals"].as_array().unwrap().iter().map(|item| item["status"].clone()).collect::<Vec<_>>();
        assert_eq!(statuses(&view), vec![json!("manual"), json!("pending")]);
        let view = runtime.control(json!({ "action": "reject", "proposalID": "decline" })).await.unwrap();
        assert_eq!(statuses(&view), vec![json!("manual"), json!("rejected")]);
        let decisions = database
            .approvals("m")
            .unwrap()
            .iter()
            .map(|approval| (approval["decision"].clone(), approval["targetID"].clone()))
            .collect::<Vec<_>>();
        assert_eq!(decisions, vec![(json!("approve"), json!("accept")), (json!("reject"), json!("decline"))]);
        runtime.close().await.unwrap();
    })
    .await;
}
