use serde_json::{Value, json};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, Semaphore};
use ycoding_core::meeting::BoxFuture;
use ycoding_core::meeting::config::{MeetingConfig, TranscriptionConfig};
use ycoding_core::meeting::discovery::Control;
use ycoding_core::meeting::intelligence::Generate;
use ycoding_core::meeting::pcm::AudioChunk;
use ycoding_core::meeting::runtime::ProviderFactory;
use ycoding_core::meeting::service::{MeetingService, ServiceOptions};
use ycoding_core::meeting::transcription::{
    Health, TranscribeContext, Transcript, TranscriptionError, TranscriptionProvider,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(25), work)
        .await
        .expect("ask test exceeded 25 seconds")
}

struct Silent;

impl TranscriptionProvider for Silent {
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
        _: &'a AudioChunk,
        _: TranscribeContext,
    ) -> BoxFuture<'a, Result<Vec<Transcript>, TranscriptionError>> {
        Box::pin(async { Ok(Vec::new()) })
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
            "ycoding-meeting-ask-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Sessions(Arc<AtomicUsize>);

fn options(directory: &Directory, generate: Option<Generate>) -> (ServiceOptions, Sessions) {
    let created = Arc::new(AtomicUsize::new(0));
    let counter = created.clone();
    let factory: ProviderFactory =
        Arc::new(|_| Ok(Arc::new(Silent) as Arc<dyn TranscriptionProvider>));
    let mut options = ServiceOptions::new(
        directory.0.clone(),
        MeetingConfig::parse(&json!({})).unwrap(),
        Arc::new(move |_| {
            let number = counter.fetch_add(1, Ordering::SeqCst) + 1;
            Box::pin(async move { Ok(format!("session-{number}")) })
        }),
    );
    options.provider_factory = Some(factory);
    options.generate = generate;
    (options, Sessions(created))
}

async fn send(base: &str, key: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let client = reqwest::Client::new();
    let request = match body {
        Some(body) => client
            .post(format!("{base}{path}"))
            .header("origin", base)
            .header("content-type", "application/json")
            .body(body.to_string()),
        None => client.get(format!("{base}{path}")),
    };
    let response = request
        .header("authorization", format!("Bearer {key}"))
        .send()
        .await
        .unwrap();
    (response.status().as_u16(), response.json().await.unwrap())
}

async fn view_key(directory: &Path) -> String {
    let page = Control::connect(directory)
        .unwrap()
        .send(&json!({ "action": "view" }))
        .await
        .unwrap();
    page["url"]
        .as_str()
        .unwrap()
        .split("#key=")
        .nth(1)
        .unwrap()
        .to_owned()
}

async fn armed(service: &MeetingService, directory: &Directory) -> String {
    let view = Control::connect(&directory.0)
        .unwrap()
        .send(&json!({ "action": "start", "title": "Ask" }))
        .await
        .unwrap();
    let id = view["meeting"]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        service.runtime().status(None).unwrap()["meeting"]["id"],
        id.as_str()
    );
    id
}

async fn seed(service: &MeetingService, meeting: &str) {
    for (id, sequence, state, text) in [
        ("one", 1, "final", "Ship on Friday"),
        ("two", 2, "temporary", "Maybe Monday"),
    ] {
        service
            .runtime()
            .database()
            .put_segment(&json!({
                "id": id, "meetingID": meeting, "sequence": sequence, "source": "remote",
                "speakerID": "remote-unknown", "startMs": 0, "endMs": 900, "rawText": text, "text": text,
                "state": state, "model": "test-model", "createdAt": "2026-10-12T00:00:00.000Z",
            }))
            .await
            .unwrap();
    }
}

type Seen = Arc<Mutex<Vec<(String, String)>>>;

fn answering(seen: &Seen, reply: &'static str) -> Generate {
    let seen = seen.clone();
    Arc::new(move |session, prompt| {
        let seen = seen.clone();
        Box::pin(async move {
            seen.lock().unwrap().push((session, prompt));
            Ok(reply.to_owned())
        })
    })
}

#[tokio::test]
async fn ask_answers_from_the_selected_transcript_in_a_fresh_session_and_keeps_history() {
    bounded(async {
        let directory = Directory::new();
        let seen = Seen::default();
        let (options, sessions) = options(&directory, Some(answering(&seen, "Friday, citing one")));
        let service = MeetingService::start(options).await.unwrap();
        let key = view_key(&directory.0).await;
        let base = service.url().to_owned();
        let meeting = armed(&service, &directory).await;
        seed(&service, &meeting).await;
        let (status, state) = send(&base, &key, "/view/state", None).await;
        assert_eq!(status, 200);
        assert_eq!(state["ask"], json!({ "history": [], "busy": false }));

        let (status, entry) = send(
            &base,
            &key,
            "/view/ask",
            Some(json!({ "question": "  What was decided?  " })),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(entry["status"], "answered");
        assert_eq!(entry["answer"], "Friday, citing one");
        assert_eq!(entry["question"], "What was decided?");
        let (session, prompt) = seen.lock().unwrap()[0].clone();
        assert_eq!(session, "session-2");
        assert_eq!(sessions.0.load(Ordering::SeqCst), 2);
        assert!(prompt.contains("What was decided?") && prompt.contains("Ship on Friday"));
        assert!(prompt.contains("\"state\":\"temporary\"") && prompt.contains("\"id\":\"two\""));
        assert!(prompt.contains("untrusted user data"));

        let (_, state) = send(&base, &key, "/view/state", None).await;
        assert_eq!(state["ask"]["busy"], false);
        assert_eq!(state["ask"]["history"][0]["id"], entry["id"]);
        service.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn ask_reports_missing_meeting_missing_transcript_and_failed_generation_distinctly() {
    bounded(async {
        let directory = Directory::new();
        let behavior = Arc::new(Mutex::new(Ok("An answer".to_owned())));
        let generate: Generate = {
            let behavior = behavior.clone();
            Arc::new(move |_, _| {
                let outcome: Result<String, String> = behavior.lock().unwrap().clone();
                Box::pin(async move { outcome })
            })
        };
        let (options, _) = options(&directory, Some(generate));
        let service = MeetingService::start(options).await.unwrap();
        let key = view_key(&directory.0).await;
        let base = service.url().to_owned();
        let question = json!({ "question": "Anything?" });

        let (status, body) = send(&base, &key, "/view/ask", Some(question.clone())).await;
        assert_eq!(
            (status, body["error"].clone()),
            (422, json!("select_meeting"))
        );
        let meeting = armed(&service, &directory).await;
        let (status, body) = send(&base, &key, "/view/ask", Some(question.clone())).await;
        assert_eq!(
            (status, body["error"].clone()),
            (422, json!("no_transcript"))
        );
        seed(&service, &meeting).await;

        *behavior.lock().unwrap() = Err("provider down".into());
        let (status, body) = send(&base, &key, "/view/ask", Some(question.clone())).await;
        assert_eq!(
            (status, body["error"].clone(), body["status"].clone()),
            (502, json!("answer_failed"), json!("error"))
        );
        *behavior.lock().unwrap() = Ok("   ".into());
        let (status, body) = send(&base, &key, "/view/ask", Some(question.clone())).await;
        assert_eq!(
            (status, body["error"].clone()),
            (502, json!("answer_failed"))
        );
        *behavior.lock().unwrap() = Ok("x".repeat(16_001));
        assert_eq!(
            send(&base, &key, "/view/ask", Some(question.clone()))
                .await
                .0,
            502
        );
        *behavior.lock().unwrap() = Ok("Recovered".into());
        let (status, body) = send(&base, &key, "/view/ask", Some(question)).await;
        assert_eq!((status, body["answer"].clone()), (200, json!("Recovered")));
        let (_, state) = send(&base, &key, "/view/state", None).await;
        assert_eq!(state["ask"]["history"].as_array().unwrap().len(), 5);
        service.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn a_second_question_is_rejected_busy_while_the_first_is_generating() {
    bounded(async {
        let directory = Directory::new();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let generate: Generate = {
            let (entered, release) = (entered.clone(), release.clone());
            Arc::new(move |_, _| {
                let (entered, release) = (entered.clone(), release.clone());
                Box::pin(async move {
                    entered.notify_one();
                    release.acquire().await.unwrap().forget();
                    Ok("Done".to_owned())
                })
            })
        };
        let (options, _) = options(&directory, Some(generate));
        let service = MeetingService::start(options).await.unwrap();
        let key = view_key(&directory.0).await;
        let base = service.url().to_owned();
        let meeting = armed(&service, &directory).await;
        seed(&service, &meeting).await;
        let first = tokio::spawn({
            let (base, key) = (base.clone(), key.clone());
            async move {
                send(
                    &base,
                    &key,
                    "/view/ask",
                    Some(json!({ "question": "First?" })),
                )
                .await
            }
        });
        entered.notified().await;
        let (_, state) = send(&base, &key, "/view/state", None).await;
        assert_eq!(state["ask"]["busy"], true);
        assert_eq!(state["ask"]["history"][0]["status"], "pending");
        let (status, body) = send(
            &base,
            &key,
            "/view/ask",
            Some(json!({ "question": "Second?" })),
        )
        .await;
        assert_eq!((status, body["error"].clone()), (409, json!("busy")));
        release.add_permits(8);
        let (status, body) = first.await.unwrap();
        assert_eq!((status, body["answer"].clone()), (200, json!("Done")));
        service.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn ask_is_unavailable_without_a_generation_seam_and_the_view_has_no_ask_field() {
    bounded(async {
        let directory = Directory::new();
        let (options, _) = options(&directory, None);
        let service = MeetingService::start(options).await.unwrap();
        let key = view_key(&directory.0).await;
        let base = service.url().to_owned();
        let (status, body) = send(
            &base,
            &key,
            "/view/ask",
            Some(json!({ "question": "Anything?" })),
        )
        .await;
        assert_eq!((status, body), (503, json!({ "error": "ask_unavailable" })));
        let (_, state) = send(&base, &key, "/view/state", None).await;
        assert!(state.get("ask").is_none());
        service.shutdown().await.unwrap();
    })
    .await;
}
