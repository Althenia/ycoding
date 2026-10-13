use serde_json::{Value, json};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use ycoding_core::meeting::BoxFuture;
use ycoding_core::meeting::config::{MeetingConfig, TranscriptionConfig};
use ycoding_core::meeting::discovery::Control;
use ycoding_core::meeting::pcm::{AudioChunk, samples_base64};
use ycoding_core::meeting::runtime::ProviderFactory;
use ycoding_core::meeting::service::{MeetingService, ServiceOptions};
use ycoding_core::meeting::store::MeetingDatabase;
use ycoding_core::meeting::transcription::{
    Health, TranscribeContext, Transcript, TranscriptionError, TranscriptionProvider,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(25), work)
        .await
        .expect("service test exceeded 25 seconds")
}

struct Echo;

impl TranscriptionProvider for Echo {
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
        let start_ms = chunk.start_ms;
        Box::pin(async move {
            Ok(vec![Transcript {
                start_ms,
                end_ms: start_ms + 900.0,
                text: "Service speech".into(),
            }])
        })
    }

    fn health_check(&self) -> BoxFuture<'_, Result<Health, TranscriptionError>> {
        Box::pin(async {
            Ok(Health {
                healthy: true,
                initialized: true,
                metrics: None,
            })
        })
    }

    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "ycoding-meeting-service-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }

    fn options(&self) -> ServiceOptions {
        let factory: ProviderFactory =
            Arc::new(|_| Ok(Arc::new(Echo) as Arc<dyn TranscriptionProvider>));
        let mut options = ServiceOptions::new(
            self.0.clone(),
            MeetingConfig::parse(
                &json!({ "transcription": { "chunkSeconds": 1, "overlapSeconds": 0 } }),
            )
            .unwrap(),
            Arc::new(|_| Box::pin(async { Ok("analysis-session".to_owned()) })),
        );
        options.provider_factory = Some(factory);
        options
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn post(base: &str, key: &str, path: &str, body: Value) -> Value {
    let response = reqwest::Client::new()
        .post(format!("{base}{path}"))
        .header("origin", base)
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "{path}");
    response.json().await.unwrap()
}

async fn view_key(directory: &Path) -> String {
    let control = Control::connect(directory).unwrap();
    let page = control.send(&json!({ "action": "view" })).await.unwrap();
    page["url"]
        .as_str()
        .unwrap()
        .split("#key=")
        .nth(1)
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn startup_publishes_a_private_descriptor_holds_the_runtime_lock_and_shutdown_releases_both()
{
    bounded(async {
        let directory = Directory::new();
        let service = MeetingService::start(directory.options()).await.unwrap();
        let descriptor = directory.0.join("bridge.json");
        let lock = directory.0.join("runtime.lock");
        let control = Control::connect(&directory.0).unwrap();
        assert_eq!(control.descriptor().url, service.url());
        assert_eq!(control.descriptor().pid, u64::from(std::process::id()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode =
                |path: &PathBuf| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&descriptor), 0o600);
            assert_eq!(mode(&lock), 0o600);
            assert_eq!(mode(&directory.0), 0o700);
            assert_eq!(mode(&directory.0.join("meetings.redb")), 0o600);
        }
        let error = MeetingService::start(directory.options())
            .await
            .err()
            .unwrap();
        assert_eq!(
            error.0,
            "Meeting runtime is already running for this Location"
        );
        assert!(descriptor.exists() && lock.exists());

        let status = control.send(&json!({ "action": "status" })).await.unwrap();
        assert_eq!(status["health"]["status"], "unloaded");
        let invalid = control.send(&json!({ "action": "bogus" })).await.unwrap();
        assert_eq!(
            invalid,
            json!({ "error": "Invalid meeting command or configuration" })
        );
        let refused = control.send(&json!({ "action": "summary" })).await.unwrap();
        assert_eq!(refused["error"], "Select or start a meeting first");

        service.shutdown().await.unwrap();
        assert!(!descriptor.exists());
        assert!(!lock.exists());
        let reopened = MeetingDatabase::open(&directory.0.join("meetings.redb")).unwrap();
        reopened.close().await.unwrap();
        let restarted = MeetingService::start(directory.options()).await.unwrap();
        restarted.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn invalid_saved_settings_fail_startup_without_leaving_a_lock_or_descriptor() {
    bounded(async {
        let directory = Directory::new();
        std::fs::create_dir_all(&directory.0).unwrap();
        std::fs::write(directory.0.join("settings.json"), "{ not json").unwrap();
        let error = MeetingService::start(directory.options())
            .await
            .err()
            .unwrap();
        assert_eq!(error.0, "Meeting settings are not valid JSON");
        assert!(!directory.0.join("runtime.lock").exists());
        assert!(!directory.0.join("bridge.json").exists());
        std::fs::write(
            directory.0.join("settings.json"),
            r#"{"streaming":{"enabled":"yes"}}"#,
        )
        .unwrap();
        assert!(MeetingService::start(directory.options()).await.is_err());
        assert!(!directory.0.join("runtime.lock").exists());
        std::fs::remove_file(directory.0.join("settings.json")).unwrap();
        MeetingService::start(directory.options())
            .await
            .unwrap()
            .shutdown()
            .await
            .unwrap();
    })
    .await;
}

#[tokio::test]
async fn saved_settings_take_precedence_over_options_on_the_next_start() {
    bounded(async {
        let directory = Directory::new();
        let service = MeetingService::start(directory.options()).await.unwrap();
        let control = Control::connect(&directory.0).unwrap();
        let configured = control
            .send(&json!({ "action": "configure", "config": { "transcription": { "chunkSeconds": 3, "overlapSeconds": 1 } } }))
            .await
            .unwrap();
        assert_eq!(configured["config"]["transcription"]["chunkSeconds"], 3);
        service.shutdown().await.unwrap();
        let restarted = MeetingService::start(directory.options()).await.unwrap();
        assert_eq!(restarted.runtime().config().transcription.chunk_seconds, 3);
        restarted.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn live_page_capture_round_trips_through_the_bridge_into_durable_final_segments() {
    bounded(async {
        let directory = Directory::new();
        let service = MeetingService::start(directory.options()).await.unwrap();
        let control = Control::connect(&directory.0).unwrap();
        let armed = control
            .send(&json!({ "action": "start", "title": "Live" }))
            .await
            .unwrap();
        let id = armed["meeting"]["id"].as_str().unwrap().to_owned();
        let base = service.url().to_owned();
        let key = view_key(&directory.0).await;
        let started = post(
            &base,
            &key,
            "/view/capture",
            json!({
                "type": "start", "captureID": "capture", "microphone": false, "consent": true,
            }),
        )
        .await;
        assert_eq!(started, json!({ "accepted": true }));
        let audio = post(
            &base,
            &key,
            "/view/capture",
            json!({
                "type": "audio", "captureID": "capture", "source": "remote", "sequence": 0,
                "startMs": 0, "sampleRate": 16000, "pcm": samples_base64(&vec![0.2f32; 16000]),
            }),
        )
        .await;
        assert_eq!(audio, json!({ "accepted": true, "duplicate": false }));
        assert_eq!(
            post(
                &base,
                &key,
                "/view/capture",
                json!({ "type": "heartbeat", "captureID": "capture" })
            )
            .await,
            json!({ "accepted": true })
        );
        let stopped = post(
            &base,
            &key,
            "/view/capture",
            json!({
                "type": "stop", "captureID": "capture", "reason": "user",
            }),
        )
        .await;
        assert_eq!(stopped, json!({ "stop": true }));
        let state = reqwest::Client::new()
            .get(format!("{base}/view/state"))
            .header("authorization", format!("Bearer {key}"))
            .send()
            .await
            .unwrap();
        assert_eq!(state.status(), 200);
        let state: Value = state.json().await.unwrap();
        assert_eq!(state["meeting"]["status"], "stopped");
        assert_eq!(state["segments"][0]["text"], "Service speech");
        assert_eq!(state["segments"][0]["state"], "final");
        assert!(state.get("ask").is_none());
        service.shutdown().await.unwrap();

        let reopened = MeetingDatabase::open(&directory.0.join("meetings.redb")).unwrap();
        let segments = reopened.segments(&id, -1, 10).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0]["state"], "final");
        reopened.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn the_expiry_timer_interrupts_a_capture_whose_source_stopped_sending_heartbeats() {
    bounded(async {
        let directory = Directory::new();
        let mut options = directory.options();
        options.heartbeat_timeout = Duration::from_millis(100);
        options.expiry_interval = Duration::from_millis(20);
        let service = MeetingService::start(options).await.unwrap();
        let control = Control::connect(&directory.0).unwrap();
        let armed = control.send(&json!({ "action": "start" })).await.unwrap();
        let id = armed["meeting"]["id"].as_str().unwrap().to_owned();
        let base = service.url().to_owned();
        let key = view_key(&directory.0).await;
        post(
            &base,
            &key,
            "/view/capture",
            json!({
                "type": "start", "captureID": "capture", "microphone": false, "consent": true,
            }),
        )
        .await;
        loop {
            let meeting = service
                .runtime()
                .database()
                .get_meeting(&id)
                .unwrap()
                .unwrap();
            if meeting["status"] == "interrupted" {
                assert!(
                    meeting["error"]
                        .as_str()
                        .unwrap()
                        .starts_with("Capture source disconnected.")
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        service.shutdown().await.unwrap();
    })
    .await;
}
