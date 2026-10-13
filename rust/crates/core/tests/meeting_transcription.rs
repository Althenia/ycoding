#![cfg(unix)]

use serde_json::{Value, json};
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::watch;
use ycoding_core::meeting::config::TranscriptionConfig;
use ycoding_core::meeting::pcm::{AudioChunk, AudioSource};
use ycoding_core::meeting::transcription::{
    ErrorKind, MODELS, TranscribeContext, TranscriptionProvider, create_provider, install_model,
    list_models, model_compatibility, sanitize_error,
};

const WORKER: &str = r#"#!/usr/bin/env python3
import base64, json, os, signal, sys
MODE = "__MODE__"
LOG = "__LOG__"
if MODE == "stubborn":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
def log(entry):
    with open(LOG, "a") as handle:
        handle.write(json.dumps(entry) + "\n")
log({"event": "start", "pid": os.getpid(), "arguments": sys.argv[1:], "cache": os.environ.get("HF_HUB_CACHE")})
def send(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()
def reply(request, **values):
    send({"id": request["id"], "ok": True, **values})
def fail(request, message):
    send({"id": request["id"], "ok": False, "error": message})
for line in sys.stdin:
    request = json.loads(line)
    operation = request["op"]
    log({"event": "request", "op": operation, "authorized": request.get("authorized"), "model": request.get("model")})
    if MODE == "silent":
        continue
    if MODE == "garbage":
        sys.stdout.write("not json\n")
        sys.stdout.flush()
        continue
    if MODE == "oversize":
        sys.stdout.write("x" * (3 * 1024 * 1024) + "\n")
        sys.stdout.flush()
        continue
    if operation == "initialize":
        if MODE == "missing-model":
            fail(request, "FileNotFoundError: Model is not present in the local Hugging Face cache")
        else:
            reply(request, metrics={"device": "cpu", "warning": "CPU inference selected"})
    elif operation == "health":
        reply(request, healthy=True)
    elif operation == "inventory":
        reply(request, inventory=[{"id": "openai/whisper-large-v3", "installed": True, "reason": "cached"}])
    elif operation == "install":
        reply(request, installation={})
    elif operation == "transcribe":
        chunk = request["chunk"]
        log({"event": "chunk", "id": chunk["id"], "bytes": len(base64.b64decode(chunk["samples"])), "hints": request["hints"]})
        if MODE == "crash":
            for index in range(100):
                sys.stderr.write("discarded-diagnostic-%d\n" % index)
            sys.stderr.write("RuntimeError: recent MPS execution failure\n")
            sys.stderr.flush()
            os._exit(2)
        if MODE == "diagnostic-failure":
            sys.stderr.write("RuntimeError: recent stderr line\n")
            sys.stderr.flush()
            fail(request, "ValueError: sample\n\x00range failure " + "x" * 1000)
        elif MODE == "hang":
            continue
        else:
            reply(request, results=[{"startMs": chunk["startMs"], "endMs": chunk["startMs"] + 900, "text": "สวัสดี"}], metrics={"device": "cpu"})
    else:
        fail(request, "Unsupported worker operation")
if MODE == "stubborn":
    import time
    while True:
        time.sleep(0.1)
"#;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-meeting-worker-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn worker(&self, mode: &str) -> PathBuf {
        let script = self.0.join(format!("worker-{mode}"));
        std::fs::write(
            &script,
            WORKER
                .replace("__MODE__", mode)
                .replace("__LOG__", self.log().to_str().unwrap()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        script
    }

    fn log(&self) -> PathBuf {
        self.0.join("worker.log")
    }

    fn events(&self) -> Vec<Value> {
        std::fs::read_to_string(self.log())
            .map(|text| {
                text.lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn operations(&self) -> Vec<String> {
        self.events()
            .iter()
            .filter(|event| event["event"] == "request")
            .map(|event| event["op"].as_str().unwrap().to_owned())
            .collect()
    }

    fn pid(&self) -> i32 {
        self.events()[0]["pid"].as_i64().unwrap() as i32
    }

    fn config(&self, mode: &str, timeout_ms: u64) -> TranscriptionConfig {
        TranscriptionConfig::parse(&json!({
            "pythonExecutable": self.worker(mode),
            "cacheDir": self.0.join("models"),
            "requestTimeoutMs": timeout_ms,
        }))
        .unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn timed<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("test exceeded its hard timeout")
}

fn gone(pid: i32) -> bool {
    unsafe {
        libc::kill(pid, 0) == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

async fn reaped(pid: i32) -> bool {
    for _ in 0..40 {
        if gone(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn chunk(id: &str, samples: usize) -> AudioChunk {
    AudioChunk {
        id: id.into(),
        source: AudioSource::Microphone,
        start_ms: 0.0,
        sample_rate: 16000,
        samples: vec![0.1; samples],
    }
}

fn context() -> TranscribeContext {
    TranscribeContext::default()
}

async fn ready(
    scratch: &Scratch,
    mode: &str,
    timeout_ms: u64,
) -> (
    std::sync::Arc<dyn TranscriptionProvider>,
    TranscriptionConfig,
) {
    let config = scratch.config(mode, timeout_ms);
    let provider = create_provider(&config).unwrap();
    provider.initialize(&config).await.unwrap();
    (provider, config)
}

#[tokio::test]
async fn starts_python_with_the_exact_embedded_worker_source_and_an_isolated_model_cache() {
    timed(async {
        let scratch = Scratch::new();
        let (provider, config) = ready(&scratch, "ok", 10_000).await;
        let embedded = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../extensions/meeting/python/worker.py"
        ))
        .unwrap();
        let start = scratch.events().remove(0);
        assert_eq!(start["arguments"], json!(["-c", embedded]));
        assert_eq!(start["cache"], json!(config.cache_dir));
        provider.dispose().await;
    })
    .await;
}

#[tokio::test]
async fn initialize_transcribe_health_and_dispose_follow_the_worker_protocol() {
    timed(async {
        let scratch = Scratch::new();
        let (provider, config) = ready(&scratch, "ok", 10_000).await;
        assert_eq!(provider.id(), "huggingface");
        provider.initialize(&config).await.unwrap();
        assert_eq!(scratch.operations(), ["initialize"]);
        let health = provider.health_check().await.unwrap();
        assert!(health.healthy && health.initialized);
        assert_eq!(health.metrics.unwrap().device.as_deref(), Some("cpu"));
        let hinted = TranscribeContext {
            hints: vec!["Kubernetes".into()],
            signal: None,
        };
        let transcript = provider
            .transcribe(&chunk("chunk-1", 1600), hinted)
            .await
            .unwrap();
        assert_eq!(transcript.len(), 1);
        assert_eq!(
            (
                transcript[0].start_ms,
                transcript[0].end_ms,
                transcript[0].text.as_str()
            ),
            (0.0, 900.0, "สวัสดี")
        );
        let logged = scratch
            .events()
            .into_iter()
            .find(|event| event["event"] == "chunk")
            .unwrap();
        assert_eq!(
            (
                logged["id"].as_str(),
                logged["bytes"].as_u64(),
                logged["hints"].clone()
            ),
            (Some("chunk-1"), Some(6400), json!(["Kubernetes"]))
        );
        assert!(
            provider
                .transcribe(&chunk("empty", 0), context())
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(scratch.operations(), ["initialize", "health", "transcribe"]);
        provider.dispose().await;
        provider.dispose().await;
        let after = provider.health_check().await.unwrap();
        assert!(!after.healthy && !after.initialized);
        assert!(reaped(scratch.pid()).await);
        assert_eq!(
            provider.initialize(&config).await.unwrap_err().message,
            "Transcription provider is disposed"
        );
        assert_eq!(
            provider
                .transcribe(&chunk("late", 1600), context())
                .await
                .unwrap_err()
                .message,
            "Transcription provider is not initialized"
        );
    })
    .await;
}

#[tokio::test]
async fn provider_configuration_changes_require_a_new_provider() {
    timed(async {
        let scratch = Scratch::new();
        let config = scratch.config("ok", 10_000);
        let provider = create_provider(&config).unwrap();
        let drifted = config.with_model("openai/whisper-large-v3");
        assert_eq!(
            provider.initialize(&drifted).await.unwrap_err().message,
            "Provider configuration changes require creating a provider"
        );
        assert!(scratch.operations().is_empty());
        provider.dispose().await;
    })
    .await;
}

#[tokio::test]
async fn a_missing_local_model_is_reported_and_never_downloaded_implicitly() {
    timed(async {
        let scratch = Scratch::new();
        let config = scratch.config("missing-model", 10_000);
        let provider = create_provider(&config).unwrap();
        let error = provider.initialize(&config).await.unwrap_err();
        assert!(
            error
                .message
                .contains("not present in the local Hugging Face cache"),
            "{error}"
        );
        let health = provider.health_check().await.unwrap();
        assert!(!health.healthy && !health.initialized);
        assert_eq!(scratch.operations(), ["initialize"]);
        provider.dispose().await;
        assert!(reaped(scratch.pid()).await);
    })
    .await;
}

#[tokio::test]
async fn model_installation_requires_explicit_authorization_before_any_worker_starts() {
    timed(async {
        let scratch = Scratch::new();
        let config = scratch.config("ok", 10_000);
        let model = "biodatlab/whisper-th-large-v3-combined";
        let denied = install_model(model, false, &config).await.unwrap_err();
        assert_eq!(
            denied.message,
            "Model installation requires explicit authorization"
        );
        assert_eq!(
            install_model("example/unregistered", true, &config)
                .await
                .unwrap_err()
                .message,
            "Unsupported model"
        );
        assert!(
            !scratch.log().exists(),
            "no worker may start without authorization"
        );
        install_model(model, true, &config).await.unwrap();
        let requests: Vec<_> = scratch
            .events()
            .into_iter()
            .filter(|event| event["event"] == "request")
            .collect();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            (
                requests[0]["op"].clone(),
                requests[0]["authorized"].clone(),
                requests[0]["model"].clone()
            ),
            (json!("install"), json!(true), json!(model))
        );
        assert!(reaped(scratch.pid()).await);
    })
    .await;
}

#[tokio::test]
async fn model_inventory_reports_local_availability_for_every_registered_model_and_reaps_the_worker()
 {
    timed(async {
        let scratch = Scratch::new();
        let models = list_models(&scratch.config("ok", 10_000)).await.unwrap();
        assert_eq!(models.len(), MODELS.len());
        let find = |id: &str| models.iter().find(|model| model["id"] == id).unwrap();
        assert_eq!(
            find("biodatlab/whisper-th-large-v3-combined")["installed"],
            false
        );
        assert_eq!(find("openai/whisper-large-v3")["installed"], true);
        assert_eq!(find("openai/whisper-large-v3")["reason"], "cached");
        assert_eq!(
            find("openai/whisper-large-v3")["architecture"],
            "WhisperForConditionalGeneration"
        );
        assert!(reaped(scratch.pid()).await);
    })
    .await;
}

#[tokio::test]
async fn correlated_worker_failures_are_sanitized_and_bounded() {
    timed(async {
        let scratch = Scratch::new();
        let (provider, _) = ready(&scratch, "diagnostic-failure", 10_000).await;
        let error = provider
            .transcribe(&chunk("failure", 1600), context())
            .await
            .unwrap_err();
        assert!(
            error
                .message
                .starts_with("ValueError: sample range failure"),
            "{error}"
        );
        assert!(error.message.encode_utf16().count() <= 300);
        assert!(!error.message.chars().any(char::is_control));
        assert!(
            provider.health_check().await.unwrap().healthy,
            "a correlated failure leaves the worker usable"
        );
        provider.dispose().await;
    })
    .await;
}

#[tokio::test]
async fn a_crash_adds_only_recent_stderr_and_marks_health_unavailable() {
    timed(async {
        let scratch = Scratch::new();
        let (provider, _) = ready(&scratch, "crash", 10_000).await;
        let error = provider
            .transcribe(&chunk("crash", 1600), context())
            .await
            .unwrap_err();
        assert!(
            error.message.starts_with("Transcription worker exited (2)"),
            "{error}"
        );
        assert!(
            error.message.contains("recent MPS execution failure"),
            "{error}"
        );
        assert!(!error.message.contains("discarded-diagnostic-0"), "{error}");
        assert!(error.message.encode_utf16().count() <= 300);
        let health = provider.health_check().await.unwrap();
        assert!(!health.healthy && !health.initialized);
        assert_eq!(
            provider
                .transcribe(&chunk("again", 1600), context())
                .await
                .unwrap_err()
                .message,
            "Transcription provider is not initialized"
        );
        provider.dispose().await;
        assert!(reaped(scratch.pid()).await);
    })
    .await;
}

#[tokio::test]
async fn an_unresponsive_worker_times_out_within_its_bound_and_is_reaped() {
    timed(async {
        let scratch = Scratch::new();
        let config = scratch.config("silent", 5000);
        let provider = create_provider(&config).unwrap();
        let started = std::time::Instant::now();
        let error = provider.initialize(&config).await.unwrap_err();
        assert!(error.message.contains("timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(10));
        provider.dispose().await;
        assert!(reaped(scratch.pid()).await);
        assert!(!provider.health_check().await.unwrap().healthy);
    })
    .await;
}

#[tokio::test]
async fn a_missing_worker_executable_is_a_visible_start_failure_without_child_state() {
    timed(async {
        let config = TranscriptionConfig::parse(
            &json!({ "pythonExecutable": "/missing/transcription-python" }),
        )
        .unwrap();
        let provider = create_provider(&config).unwrap();
        let error = provider.initialize(&config).await.unwrap_err();
        assert_eq!(error.message, "Transcription worker failed to start");
        let health = provider.health_check().await.unwrap();
        assert!(!health.healthy && !health.initialized);
        provider.dispose().await;
    })
    .await;
}

#[tokio::test]
async fn oversized_audio_and_hints_are_rejected_instead_of_dropped() {
    timed(async {
        let scratch = Scratch::new();
        let (provider, _) = ready(&scratch, "ok", 10_000).await;
        let long = provider
            .transcribe(&chunk("too-long", 16 * 16000), context())
            .await
            .unwrap_err();
        assert_eq!(
            (long.kind, long.message.as_str()),
            (
                ErrorKind::ChunkLimit,
                "Audio chunk exceeds the configured duration limit"
            )
        );
        assert!(
            provider
                .transcribe(&chunk("boundary", 15 * 16000), context())
                .await
                .is_ok()
        );
        for hints in [
            vec!["hint".to_owned(); 65],
            vec!["x".repeat(513)],
            vec!["é".repeat(200); 25],
        ] {
            let error = provider
                .transcribe(
                    &chunk("hints", 1600),
                    TranscribeContext {
                        hints,
                        signal: None,
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(
                error.message,
                "Transcription hints exceed the count or size limit"
            );
        }
        assert!(
            provider
                .transcribe(
                    &chunk("hints-ok", 1600),
                    TranscribeContext {
                        hints: vec!["x".repeat(512); 16],
                        signal: None
                    }
                )
                .await
                .is_ok()
        );
        let mut nan = chunk("nan", 1600);
        nan.samples[3] = f32::NAN;
        assert_eq!(
            provider
                .transcribe(&nan, context())
                .await
                .unwrap_err()
                .message,
            "Audio samples must be finite"
        );
        let mut early = chunk("early", 1600);
        early.start_ms = -1.0;
        assert_eq!(
            provider
                .transcribe(&early, context())
                .await
                .unwrap_err()
                .message,
            "Invalid audio chunk metadata"
        );
        assert_eq!(
            provider
                .transcribe(&chunk(&"i".repeat(129), 1600), context())
                .await
                .unwrap_err()
                .message,
            "Invalid audio chunk metadata"
        );
        let mut slow = chunk("rate", 1600);
        slow.sample_rate = 7999;
        assert_eq!(
            provider
                .transcribe(&slow, context())
                .await
                .unwrap_err()
                .message,
            "Audio sample rate must be between 8000 and 192000 Hz"
        );
        let delivered = scratch
            .events()
            .iter()
            .filter(|event| event["event"] == "chunk")
            .count();
        assert_eq!(
            delivered, 2,
            "only the two in-bound chunks may reach the worker"
        );
        provider.dispose().await;
    })
    .await;
}

#[tokio::test]
async fn cancelling_an_active_request_stops_the_worker_and_reports_cancellation() {
    timed(async {
        let scratch = Scratch::new();
        let (provider, _) = ready(&scratch, "hang", 20_000).await;
        let (cancel, signal) = watch::channel(false);
        let active = chunk("cancel", 1600);
        let pending = provider.transcribe(
            &active,
            TranscribeContext {
                hints: Vec::new(),
                signal: Some(signal),
            },
        );
        let cancelled = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.send(true).unwrap();
        };
        let (result, ()) = tokio::join!(pending, cancelled);
        assert_eq!(result.unwrap_err().kind, ErrorKind::Cancelled);
        let health = provider.health_check().await.unwrap();
        assert!(!health.healthy && !health.initialized);
        let (_, aborted) = watch::channel(true);
        assert_eq!(
            provider
                .transcribe(
                    &chunk("late", 1600),
                    TranscribeContext {
                        hints: Vec::new(),
                        signal: Some(aborted)
                    }
                )
                .await
                .unwrap_err()
                .kind,
            ErrorKind::Failure
        );
        provider.dispose().await;
        assert!(reaped(scratch.pid()).await);
    })
    .await;
}

#[tokio::test]
async fn invalid_or_oversized_worker_output_fails_visibly_and_kills_the_worker() {
    timed(async {
        for (mode, expected) in [
            ("garbage", "Transcription worker returned invalid JSON"),
            (
                "oversize",
                "Transcription worker response exceeds the protocol limit",
            ),
        ] {
            let scratch = Scratch::new();
            let config = scratch.config(mode, 10_000);
            let provider = create_provider(&config).unwrap();
            let error = provider.initialize(&config).await.unwrap_err();
            assert_eq!(error.message, expected);
            assert!(reaped(scratch.pid()).await, "{mode} worker survived");
            provider.dispose().await;
        }
    })
    .await;
}

#[tokio::test]
async fn disposal_escalates_to_kill_for_a_worker_that_ignores_termination() {
    timed(async {
        let scratch = Scratch::new();
        let (provider, _) = ready(&scratch, "stubborn", 10_000).await;
        let started = std::time::Instant::now();
        provider.dispose().await;
        assert!(started.elapsed() < Duration::from_secs(15));
        assert!(reaped(scratch.pid()).await);
    })
    .await;
}

#[test]
fn models_are_gated_by_registration_and_provider() {
    let config = TranscriptionConfig::parse(&json!({})).unwrap();
    assert!(model_compatibility(&config).supported);
    assert!(model_compatibility(&config.with_model("openai/whisper-large-v3")).supported);
    assert_eq!(
        model_compatibility(&config.with_model("example/unknown")).reason,
        Some("Unsupported model")
    );
    let other = TranscriptionConfig::parse(&json!({ "provider": "replacement" })).unwrap();
    assert_eq!(
        model_compatibility(&other).reason,
        Some("Unsupported provider")
    );
    assert_eq!(
        create_provider(&other).err().unwrap().message,
        "Unsupported provider"
    );
}

#[test]
fn error_text_is_single_line_control_free_and_bounded() {
    assert_eq!(
        sanitize_error("ValueError: microphone\n\u{0}sample range invalid"),
        "ValueError: microphone sample range invalid"
    );
    assert_eq!(sanitize_error("  a \t b\u{85}c  "), "a b c");
    assert_eq!(sanitize_error(&"x".repeat(500)).len(), 300);
    assert_eq!(
        sanitize_error(&"😀".repeat(200)).encode_utf16().count(),
        300
    );
    assert_eq!(sanitize_error(" \n\u{7f} "), "Transcription failed");
    assert_eq!(sanitize_error(""), "Transcription failed");
}
