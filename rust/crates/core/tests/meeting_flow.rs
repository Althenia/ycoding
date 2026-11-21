#![cfg(unix)]

use serde_json::{Value, json};
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, Semaphore};
use ycoding_core::meeting::BoxFuture;
use ycoding_core::meeting::bridge::CaptureMessage;
use ycoding_core::meeting::config::{MeetingConfig, TranscriptionConfig};
use ycoding_core::meeting::intelligence::Generate;
use ycoding_core::meeting::pcm::AudioSource;
use ycoding_core::meeting::runtime::{HEARTBEAT_TIMEOUT, MeetingRuntime, RuntimeOptions};
use ycoding_core::meeting::store::MeetingDatabase;
use ycoding_core::meeting::transcription::{TranscribeContext, create_provider};

const MAX_REQUEST_BYTES: usize = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(120), work)
        .await
        .expect("meeting flow test exceeded 120 seconds")
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-meeting-flow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn write_worker(&self, name: &str, body: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, body.replace("__LOG__", self.log().to_str().unwrap())).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn log(&self) -> PathBuf {
        self.0.join("worker.log")
    }

    fn log_lines(&self) -> Vec<Value> {
        std::fs::read_to_string(self.log())
            .map(|text| {
                text.lines()
                    .map(|line| serde_json::from_str(line).unwrap())
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const RUNTIME_WORKER: &str = r#"#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    response = {"id": request["id"], "ok": True}
    if request["op"] == "initialize":
        response["metrics"] = {"device": "test-device"}
    elif request["op"] == "health":
        response["healthy"] = True
    elif request["op"] == "transcribe":
        chunk = request["chunk"]
        response["results"] = [{"startMs": chunk["startMs"], "endMs": chunk["startMs"] + 900, "text": "เราจะทดสอบ canary rollout"}]
        response["metrics"] = {"device": "test-device"}
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()
"#;

struct Analysis {
    prompts: Arc<Mutex<Vec<String>>>,
    hold: Arc<AtomicBool>,
    entered: Arc<Notify>,
    release: Arc<Semaphore>,
}

impl Analysis {
    fn new() -> Self {
        Self {
            prompts: Arc::new(Mutex::new(Vec::new())),
            hold: Arc::new(AtomicBool::new(false)),
            entered: Arc::new(Notify::new()),
            release: Arc::new(Semaphore::new(0)),
        }
    }

    fn generate(&self) -> Generate {
        let analysis = Analysis {
            prompts: self.prompts.clone(),
            hold: self.hold.clone(),
            entered: self.entered.clone(),
            release: self.release.clone(),
        };
        Arc::new(move |_, prompt| {
            let analysis = Analysis {
                prompts: analysis.prompts.clone(),
                hold: analysis.hold.clone(),
                entered: analysis.entered.clone(),
                release: analysis.release.clone(),
            };
            Box::pin(async move {
                analysis.prompts.lock().unwrap().push(prompt.clone());
                if analysis.hold.load(Ordering::SeqCst) && prompt.contains("Held analysis evidence")
                {
                    analysis.entered.notify_one();
                    analysis.release.acquire().await.unwrap().forget();
                }
                Ok(
                    json!({ "summary": "Flow summary", "findings": [], "proposals": [] })
                        .to_string(),
                )
            }) as BoxFuture<'static, Result<String, String>>
        })
    }

    fn calls_for(&self, text: &str) -> usize {
        self.prompts
            .lock()
            .unwrap()
            .iter()
            .filter(|prompt| prompt.contains(text))
            .count()
    }
}

async fn open_runtime(
    scratch: &Scratch,
    database_path: &Path,
    worker: &Path,
    generate: Option<Generate>,
) -> Arc<MeetingRuntime> {
    let database = MeetingDatabase::open(database_path).unwrap();
    MeetingRuntime::new(RuntimeOptions {
        directory: scratch.0.clone(),
        database,
        config: MeetingConfig::parse(&json!({
            "transcription": { "pythonExecutable": worker, "cacheDir": scratch.0.join("models"), "chunkSeconds": 1, "overlapSeconds": 0 },
            "streaming": { "vad": false },
            "analysis": { "incremental": false },
        }))
        .unwrap(),
        create_session: Arc::new(|_, _| Box::pin(async { Ok("analysis-session".to_owned()) })),
        provider_factory: None,
        heartbeat_timeout: HEARTBEAT_TIMEOUT,
        generate,
        mcp: None,
    })
    .await
    .unwrap()
}

fn audio(capture_id: &str, sequence: u64, start_ms: f64) -> CaptureMessage {
    CaptureMessage::Audio {
        capture_id: capture_id.into(),
        source: AudioSource::Remote,
        sequence,
        start_ms,
        sample_rate: 16000,
        samples: vec![0.2; 16000],
    }
}

async fn arm(runtime: &Arc<MeetingRuntime>, title: &str, capture_id: &str) -> String {
    let view = runtime
        .control(json!({ "action": "start", "title": title }))
        .await
        .unwrap();
    let id = view["meeting"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        runtime
            .capture(CaptureMessage::Start {
                capture_id: capture_id.into(),
                microphone: false
            })
            .await
            .unwrap(),
        json!({ "accepted": true })
    );
    id
}

async fn seed_meeting(database: &MeetingDatabase) {
    let at = "2026-01-01T00:00:00.000Z";
    database
        .create_meeting("seeded", "Seeded meeting history", "seed-session")
        .await
        .unwrap();
    database
        .put_segment(&json!({
            "id": "seeded-evidence", "meetingID": "seeded", "sequence": 1, "source": "remote",
            "speakerID": "remote-unknown", "startMs": 0, "endMs": 900,
            "rawText": "สวัสดี seeded", "text": "สวัสดี seeded", "state": "final",
            "model": "test-model", "createdAt": at,
        }))
        .await
        .unwrap();
    database
        .put_checkpoint(&json!({
            "id": "seeded-checkpoint", "meetingID": "seeded", "throughSequence": 1,
            "summary": "Seeded summary", "final": true, "createdAt": at, "latencyMs": 50,
        }))
        .await
        .unwrap();
    database
        .put_finding(&json!({
            "id": "seeded-decision", "meetingID": "seeded", "kind": "decision", "summary": "Ship it",
            "sourceSegmentIds": ["seeded-evidence"], "confidence": 1, "status": "confirmed", "createdAt": at,
        }))
        .await
        .unwrap();
    database
        .put_proposal(&json!({
            "id": "proposal", "meetingID": "seeded", "server": "wiki", "target": "page", "operation": "replace",
            "existingContent": "old", "suggestedContent": "new", "explanation": "why",
            "sourceSegmentIds": ["seeded-evidence"], "references": [], "expectedRevision": "1",
            "confidence": 0.5, "status": "pending", "createdAt": at,
        }))
        .await
        .unwrap();
    database
        .put_approval(&json!({
            "id": "seeded-rejection", "meetingID": "seeded", "targetID": "proposal",
            "decision": "reject", "detail": "Earlier review", "createdAt": at,
        }))
        .await
        .unwrap();
    database
        .put_plan(&json!({
            "meetingID": "seeded", "content": "Seeded plan", "findingIds": ["seeded-decision"],
            "sourceSegmentIds": ["seeded-evidence"], "status": "proposed", "createdAt": at,
        }))
        .await
        .unwrap();
}

#[tokio::test]
async fn meeting_capture_analysis_interrupt_restart_and_approval_readback_from_an_empty_store() {
    bounded(async {
        let scratch = Scratch::new();
        let candidate = scratch.0.join("meetings.redb");

        let database = MeetingDatabase::open(&candidate).unwrap();
        assert!(database.list_meetings("", 10).unwrap().is_empty());
        seed_meeting(&database).await;
        assert_eq!(
            database.get_meeting("seeded").unwrap().unwrap()["title"],
            "Seeded meeting history"
        );
        assert_eq!(database.segments("seeded", -1, 10).unwrap().len(), 1);
        assert_eq!(
            database.proposals("seeded").unwrap()[0]["status"],
            "pending"
        );
        database.close().await.unwrap();

        let worker = scratch.write_worker("runtime-worker", RUNTIME_WORKER);
        let analysis = Analysis::new();
        let runtime = open_runtime(&scratch, &candidate, &worker, Some(analysis.generate())).await;

        let first = arm(&runtime, "Composed flow", "flow-a").await;
        runtime.capture(audio("flow-a", 0, 0.0)).await.unwrap();
        runtime.capture(audio("flow-a", 1, 1000.0)).await.unwrap();
        runtime
            .control(json!({ "action": "stop", "meetingID": first }))
            .await
            .unwrap();
        runtime.settled().await;
        let database = runtime.database();
        let segments = database.segments(&first, -1, 10).unwrap();
        assert_eq!(segments.len(), 2);
        assert!(
            segments.iter().all(|segment| segment["state"] == "final"
                && segment["text"] == "เราจะทดสอบ canary rollout")
        );
        let checkpoint = database.checkpoints(&first).unwrap().pop().unwrap();
        assert_eq!(
            (checkpoint["final"].clone(), checkpoint["summary"].clone()),
            (json!(true), json!("Flow summary"))
        );
        assert_eq!(
            database
                .jobs(&first)
                .unwrap()
                .into_iter()
                .find(|job| job["kind"] == "analysis")
                .unwrap()["status"],
            "done"
        );

        let second = arm(&runtime, "Interrupted flow", "flow-b").await;
        runtime.capture(audio("flow-b", 0, 0.0)).await.unwrap();
        runtime.close().await.unwrap();

        let reopened = MeetingDatabase::open(&candidate).unwrap();
        let interrupted = reopened.get_meeting(&second).unwrap().unwrap();
        assert_eq!(interrupted["status"], "interrupted");
        assert!(
            interrupted["error"]
                .as_str()
                .unwrap()
                .contains("volatile audio is not recoverable"),
            "{interrupted}"
        );
        let retained_segments = reopened.segments(&second, -1, 10).unwrap().len();
        reopened.close().await.unwrap();

        let analysis = Analysis::new();
        let runtime = open_runtime(&scratch, &candidate, &worker, Some(analysis.generate())).await;
        assert_eq!(
            runtime.capture(audio("flow-b", 1, 1000.0)).await.unwrap(),
            json!({ "stop": true })
        );
        assert_eq!(
            runtime.database().segments(&second, -1, 10).unwrap().len(),
            retained_segments
        );

        runtime
            .database()
            .create_meeting("held", "Held analysis", "analysis-session")
            .await
            .unwrap();
        runtime.database().put_segment(&json!({
            "id": "held-evidence", "meetingID": "held", "sequence": 1, "source": "remote",
            "speakerID": "remote-unknown", "startMs": 0, "endMs": 900,
            "rawText": "Held analysis evidence", "text": "Held analysis evidence", "state": "final",
            "model": "test-model", "createdAt": "2026-10-12T00:00:00.000Z",
        })).await.unwrap();
        analysis.hold.store(true, Ordering::SeqCst);
        runtime
            .control(json!({ "action": "select", "meetingID": "held" }))
            .await
            .unwrap();
        runtime
            .control(json!({ "action": "summary", "meetingID": "held" }))
            .await
            .unwrap();
        analysis.entered.notified().await;
        let closing = tokio::spawn({
            let runtime = runtime.clone();
            async move { runtime.close().await }
        });
        analysis.release.add_permits(1);
        closing.await.unwrap().unwrap();
        assert_eq!(analysis.calls_for("Held analysis evidence"), 1);
        let reopened = MeetingDatabase::open(&candidate).unwrap();
        let checkpoints = reopened.checkpoints("held").unwrap();
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0]["summary"], "Flow summary");
        reopened.close().await.unwrap();

        let runtime = open_runtime(&scratch, &candidate, &worker, None).await;
        runtime
            .control(json!({ "action": "select", "meetingID": "seeded" }))
            .await
            .unwrap();
        let view = runtime
            .control(json!({ "action": "approve", "proposalID": "proposal" }))
            .await
            .unwrap();
        assert_eq!(view["proposals"][0]["status"], "manual");
        runtime.close().await.unwrap();

        let reopened = MeetingDatabase::open(&candidate).unwrap();
        assert_eq!(reopened.proposals("seeded").unwrap()[0]["status"], "manual");
        let decisions: Vec<(Value, Value)> = reopened
            .approvals("seeded")
            .unwrap()
            .iter()
            .map(|approval| (approval["decision"].clone(), approval["targetID"].clone()))
            .collect();
        assert!(
            decisions.contains(&(json!("approve"), json!("proposal"))),
            "{decisions:?}"
        );
        assert!(
            decisions.contains(&(json!("reject"), json!("proposal"))),
            "{decisions:?}"
        );
        assert_eq!(
            reopened.segments("seeded", -1, 10).unwrap()[0]["text"],
            "สวัสดี seeded"
        );
        assert_eq!(
            reopened.checkpoints("seeded").unwrap()[0]["summary"],
            "Seeded summary"
        );
        assert_eq!(
            reopened.plan("seeded").unwrap().unwrap()["content"],
            "Seeded plan"
        );
        assert_eq!(reopened.segments(&first, -1, 10).unwrap().len(), 2);
        reopened.close().await.unwrap();
    })
    .await;
}

const BOUND_WORKER: &str = r#"#!/usr/bin/env python3
import json, os, sys
LOG = "__LOG__"
TARGET = __TARGET__
def log(entry):
    with open(LOG, "a") as handle:
        handle.write(json.dumps(entry) + "\n")
log({"event": "start", "pid": os.getpid()})
for raw in sys.stdin.buffer:
    log({"event": "line", "bytes": len(raw)})
    request = json.loads(raw)
    response = {"id": request["id"], "ok": True}
    if request["op"] == "initialize":
        response["metrics"] = {"device": "cpu"}
    elif request["op"] == "health":
        response["healthy"] = True
    elif request["op"] == "transcribe":
        chunk = request["chunk"]
        response["results"] = [{"startMs": chunk["startMs"], "endMs": chunk["startMs"] + 900, "text": ""}]
        base = len(json.dumps(response).encode())
        response["results"][0]["text"] = "x" * (TARGET - base)
    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
"#;

fn worker_config(scratch: &Scratch, worker: &Path, chunk_seconds: u32) -> TranscriptionConfig {
    TranscriptionConfig::parse(&json!({
        "pythonExecutable": worker,
        "cacheDir": scratch.0.join("models"),
        "chunkSeconds": chunk_seconds,
        "overlapSeconds": 0,
        "requestTimeoutMs": 60000,
    }))
    .unwrap()
}

fn pid_of(scratch: &Scratch) -> i32 {
    scratch.log_lines()[0]["pid"].as_i64().unwrap() as i32
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

fn flow_chunk(
    id: &str,
    samples: usize,
    sample_rate: u32,
) -> ycoding_core::meeting::pcm::AudioChunk {
    ycoding_core::meeting::pcm::AudioChunk {
        id: id.into(),
        source: AudioSource::Microphone,
        start_ms: 0.0,
        sample_rate,
        samples: vec![0.1; samples],
    }
}

#[tokio::test]
async fn worker_response_bounds_accept_n_minus_1_and_n_and_reject_n_plus_1() {
    bounded(async {
        for (target, accepted) in [
            (MAX_RESPONSE_BYTES - 1, true),
            (MAX_RESPONSE_BYTES, true),
            (MAX_RESPONSE_BYTES + 1, false),
        ] {
            let scratch = Scratch::new();
            let worker = scratch.write_worker(
                "bound-worker",
                &BOUND_WORKER.replace("__TARGET__", &target.to_string()),
            );
            let config = worker_config(&scratch, &worker, 15);
            let provider = create_provider(&config).unwrap();
            provider.initialize(&config).await.unwrap();
            let result = provider
                .transcribe(
                    &flow_chunk("bound", 1600, 16000),
                    TranscribeContext::default(),
                )
                .await;
            let lines: Vec<usize> = scratch
                .log_lines()
                .iter()
                .filter(|entry| entry["event"] == "line")
                .map(|entry| entry["bytes"].as_u64().unwrap() as usize)
                .collect();
            assert_eq!(
                lines.len(),
                2,
                "initialize and transcribe lines for target {target}"
            );
            if accepted {
                let transcript = result.unwrap();
                assert_eq!(transcript.len(), 1);
                assert!(transcript[0].text.chars().all(|character| character == 'x'));
                assert!(provider.health_check().await.unwrap().healthy);
            } else {
                let error = result.unwrap_err();
                assert!(
                    error
                        .message
                        .contains("response exceeds the protocol limit"),
                    "{error}"
                );
                assert!(reaped(pid_of(&scratch)).await, "oversize worker survived");
            }
            provider.dispose().await;
        }
    })
    .await;
}

#[tokio::test]
async fn worker_request_bounds_accept_n_minus_1_and_n_and_reject_n_plus_1() {
    bounded(async {
        for target in [
            MAX_REQUEST_BYTES - 1,
            MAX_REQUEST_BYTES,
            MAX_REQUEST_BYTES + 1,
        ] {
            let scratch = Scratch::new();
            let worker =
                scratch.write_worker("bound-worker", &BOUND_WORKER.replace("__TARGET__", "0"));
            let config = worker_config(&scratch, &worker, 30);
            let provider = create_provider(&config).unwrap();
            provider.initialize(&config).await.unwrap();
            provider
                .transcribe(
                    &flow_chunk("bound", 1600, 192000),
                    TranscribeContext::default(),
                )
                .await
                .unwrap();
            let lines: Vec<usize> = scratch
                .log_lines()
                .iter()
                .filter(|entry| entry["event"] == "line")
                .map(|entry| entry["bytes"].as_u64().unwrap() as usize)
                .collect();
            assert_eq!(lines.len(), 2);
            let calibration_b64 = (1600usize * 4).div_ceil(3) * 4;
            let overhead = lines[1] - calibration_b64;
            let needed = target - overhead;
            let mut samples = needed * 3 / 16;
            while (samples * 4usize).div_ceil(3) * 4 <= needed {
                samples += 1;
            }
            while (samples * 4usize).div_ceil(3) * 4 > needed {
                samples -= 1;
            }
            let remainder = needed - (samples * 4usize).div_ceil(3) * 4;
            let id = "b".repeat(5 + remainder);
            let result = provider
                .transcribe(
                    &flow_chunk(&id, samples, 192000),
                    TranscribeContext::default(),
                )
                .await;
            let lines: Vec<usize> = scratch
                .log_lines()
                .iter()
                .filter(|entry| entry["event"] == "line")
                .map(|entry| entry["bytes"].as_u64().unwrap() as usize)
                .collect();
            if target <= MAX_REQUEST_BYTES {
                result.unwrap();
                assert_eq!(lines.len(), 3);
                assert_eq!(
                    lines[2], target,
                    "worker must receive the exact bounded request"
                );
                assert!(provider.health_check().await.unwrap().healthy);
            } else {
                let error = result.unwrap_err();
                assert!(
                    error.message.contains("request exceeds the protocol limit"),
                    "{error}"
                );
                assert_eq!(lines.len(), 2, "oversize request must not reach the worker");
            }
            provider.dispose().await;
        }
    })
    .await;
}

const UNICODE_WORKER: &str = r#"#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if request["op"] == "initialize":
        sys.stdout.write(json.dumps({"id": request["id"], "ok": True, "metrics": {"device": "cpu"}}) + "\n")
    elif request["op"] == "health":
        sys.stdout.write(json.dumps({"id": request["id"], "ok": True, "healthy": True}) + "\n")
    elif request["op"] == "transcribe":
        sys.stdout.write(json.dumps({"id": "wrong-999", "ok": True, "results": [{"startMs": 0, "endMs": 1, "text": "wrong"}]}) + "\n")
        sys.stdout.flush()
        text = request["hints"][0] + " สวัสดี😀"
        payload = json.dumps({"id": request["id"], "ok": True, "results": [{"startMs": 0, "endMs": 900, "text": text}]}, ensure_ascii=False).encode()
        split = payload.index("😀".encode()) + 2
        sys.stdout.buffer.write(payload[:split])
        sys.stdout.buffer.flush()
        sys.stdout.buffer.write(payload[split:] + b"\n")
        sys.stdout.buffer.flush()
    sys.stdout.flush()
"#;

#[tokio::test]
async fn worker_partial_unicode_and_wrong_id_are_reassembled_and_ignored() {
    bounded(async {
        let scratch = Scratch::new();
        let worker = scratch.write_worker("unicode-worker", UNICODE_WORKER);
        let config = worker_config(&scratch, &worker, 15);
        let provider = create_provider(&config).unwrap();
        provider.initialize(&config).await.unwrap();
        let transcript = provider
            .transcribe(
                &flow_chunk("unicode", 1600, 16000),
                TranscribeContext {
                    hints: vec!["สวัสดี😀".into()],
                    signal: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(transcript[0].text, "สวัสดี😀 สวัสดี😀");
        assert!(provider.health_check().await.unwrap().healthy);
        provider.dispose().await;
    })
    .await;
}

const STDERR_WORKER: &str = r#"#!/usr/bin/env python3
import json, os, sys
LOG = "__LOG__"
with open(LOG, "a") as handle:
    handle.write(json.dumps({"event": "start", "pid": os.getpid()}) + "\n")
for line in sys.stdin:
    request = json.loads(line)
    if request["op"] == "initialize":
        sys.stdout.write(json.dumps({"id": request["id"], "ok": True, "metrics": {"device": "cpu"}}) + "\n")
    elif request["op"] == "health":
        sys.stdout.write(json.dumps({"id": request["id"], "ok": True, "healthy": True}) + "\n")
    elif request["op"] == "transcribe":
        sys.stderr.write("EARLY-MARKER\n")
        sys.stderr.write("x" * 9000 + "\n")
        sys.stderr.write("TAIL-MARKER failure\n")
        sys.stderr.flush()
        os._exit(2)
    sys.stdout.flush()
"#;

#[tokio::test]
async fn worker_stderr_overflow_keeps_only_the_tail_and_marks_health_unavailable() {
    bounded(async {
        let scratch = Scratch::new();
        let worker = scratch.write_worker("stderr-worker", STDERR_WORKER);
        let config = worker_config(&scratch, &worker, 15);
        let provider = create_provider(&config).unwrap();
        provider.initialize(&config).await.unwrap();
        let error = provider
            .transcribe(
                &flow_chunk("stderr", 1600, 16000),
                TranscribeContext::default(),
            )
            .await
            .unwrap_err();
        assert!(error.message.contains("TAIL-MARKER"), "{error}");
        assert!(!error.message.contains("EARLY-MARKER"), "{error}");
        assert!(error.message.encode_utf16().count() <= 300, "{error}");
        assert!(!provider.health_check().await.unwrap().healthy);
        provider.dispose().await;
        assert!(reaped(pid_of(&scratch)).await, "crashed worker survived");
    })
    .await;
}

const HANG_WORKER: &str = r#"#!/usr/bin/env python3
import json, os, sys, time
LOG = "__LOG__"
with open(LOG, "a") as handle:
    handle.write(json.dumps({"event": "start", "pid": os.getpid()}) + "\n")
for line in sys.stdin:
    request = json.loads(line)
    if request["op"] == "initialize":
        sys.stdout.write(json.dumps({"id": request["id"], "ok": True, "metrics": {"device": "cpu"}}) + "\n")
        sys.stdout.flush()
    elif request["op"] == "transcribe":
        time.sleep(600)
"#;

#[tokio::test]
async fn worker_timeout_is_explicit_and_leaves_no_running_worker() {
    bounded(async {
        let scratch = Scratch::new();
        let worker = scratch.write_worker("hang-worker", HANG_WORKER);
        let config = TranscriptionConfig::parse(&json!({
            "pythonExecutable": worker,
            "cacheDir": scratch.0.join("models"),
            "chunkSeconds": 15,
            "overlapSeconds": 0,
            "requestTimeoutMs": 4000,
        }))
        .unwrap();
        let provider = create_provider(&config).unwrap();
        provider.initialize(&config).await.unwrap();
        let error = provider
            .transcribe(
                &flow_chunk("hang", 1600, 16000),
                TranscribeContext::default(),
            )
            .await
            .unwrap_err();
        assert!(error.message.contains("timed out"), "{error}");
        provider.dispose().await;
        assert!(reaped(pid_of(&scratch)).await, "timed-out worker survived");
    })
    .await;
}

#[test]
fn worker_config_bounds_reject_invalid_geometry_and_enums() {
    for (value, accepted) in [
        (json!({ "chunkSeconds": 1, "overlapSeconds": 0 }), true),
        (json!({ "chunkSeconds": 30, "overlapSeconds": 10 }), true),
        (json!({ "chunkSeconds": 0, "overlapSeconds": 0 }), false),
        (json!({ "chunkSeconds": 31, "overlapSeconds": 0 }), false),
        (json!({ "chunkSeconds": 15, "overlapSeconds": 15 }), false),
        (json!({ "chunkSeconds": 15, "overlapSeconds": 16 }), false),
        (json!({ "chunkSeconds": 15, "overlapSeconds": 11 }), false),
        (json!({ "device": "tpu" }), false),
        (json!({ "task": "translate" }), false),
        (json!({ "requestTimeoutMs": 0 }), false),
        (json!({ "requestTimeoutMs": 1200001 }), false),
        (json!({ "unknown": true }), false),
    ] {
        assert_eq!(
            TranscriptionConfig::parse(&value).is_ok(),
            accepted,
            "{value}"
        );
    }
    assert!(
        TranscriptionConfig::parse(&json!({ "chunkSeconds": 30, "overlapSeconds": 10 })).is_ok()
    );
}
