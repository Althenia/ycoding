use reqwest::{Method, Response};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;
use ycoding_core::meeting::BoxFuture;
use ycoding_core::meeting::bridge::{
    Asset, Bridge, CallbackFailed, CaptureMessage, Handlers, Options, ViewAssets,
};
use ycoding_core::meeting::client::send_control;
use ycoding_core::meeting::config::{AnalysisModel, KnowledgeBinding};
use ycoding_core::meeting::owner::{Knowledge, Outcome, Update};
use ycoding_core::meeting::pcm::{AudioSource, samples_base64};

const CONTROL: &str = "controller-test-credential-with-32-bytes";
const POLICY: &str = "default-src 'none'; script-src 'self'; connect-src 'self'";

type CaptureHandler = Box<
    dyn Fn(usize, CaptureMessage) -> BoxFuture<'static, Result<Value, CallbackFailed>>
        + Send
        + Sync,
>;
type AskHandler = Box<dyn Fn(String) -> Result<Value, CallbackFailed> + Send + Sync>;
type OwnerUpdateHandler = Box<dyn Fn(&Update) -> Result<Outcome, CallbackFailed> + Send + Sync>;

struct Recorder {
    controls: Mutex<Vec<Value>>,
    captures: Mutex<Vec<CaptureMessage>>,
    disconnects: AtomicUsize,
    disconnected: Notify,
    on_capture: CaptureHandler,
    control_response: Value,
    view: Option<Value>,
    ask: Option<AskHandler>,
    owner_read: Option<Result<Value, CallbackFailed>>,
    owner_update: Option<OwnerUpdateHandler>,
    owner_updates: Mutex<Vec<Update>>,
}

impl Recorder {
    fn new() -> Self {
        Self {
            controls: Mutex::new(Vec::new()),
            captures: Mutex::new(Vec::new()),
            disconnects: AtomicUsize::new(0),
            disconnected: Notify::new(),
            on_capture: Box::new(|_, _| Box::pin(async { Ok(json!({ "ok": true })) })),
            control_response: json!({ "ok": true }),
            view: None,
            ask: None,
            owner_read: None,
            owner_update: None,
            owner_updates: Mutex::new(Vec::new()),
        }
    }

    fn received(&self) -> Vec<CaptureMessage> {
        self.captures.lock().unwrap().clone()
    }
}

impl Handlers for Recorder {
    fn control(&self, input: Value) -> BoxFuture<'_, Result<Value, CallbackFailed>> {
        self.controls.lock().unwrap().push(input);
        Box::pin(async { Ok(self.control_response.clone()) })
    }

    fn capture(&self, input: CaptureMessage) -> BoxFuture<'_, Result<Value, CallbackFailed>> {
        let index = {
            let mut captures = self.captures.lock().unwrap();
            captures.push(input.clone());
            captures.len()
        };
        (self.on_capture)(index, input)
    }

    fn disconnect(&self) {
        self.disconnects.fetch_add(1, Ordering::SeqCst);
        self.disconnected.notify_one();
    }

    fn view(&self) -> Option<BoxFuture<'_, Result<Value, CallbackFailed>>> {
        self.view
            .clone()
            .map(|view| Box::pin(async move { Ok(view) }) as BoxFuture<'_, _>)
    }

    fn ask(&self, question: String) -> Option<BoxFuture<'_, Result<Value, CallbackFailed>>> {
        self.ask.as_ref().map(|ask| {
            let answer = ask(question);
            Box::pin(async move { answer }) as BoxFuture<'_, _>
        })
    }

    fn owner_read(&self) -> Option<BoxFuture<'_, Result<Value, CallbackFailed>>> {
        self.owner_read
            .clone()
            .map(|read| Box::pin(async move { read }) as BoxFuture<'_, _>)
    }

    fn owner_update(
        &self,
        update: Update,
    ) -> Option<BoxFuture<'_, Result<Outcome, CallbackFailed>>> {
        let handler = self.owner_update.as_ref()?;
        let outcome = handler(&update);
        self.owner_updates.lock().unwrap().push(update);
        Some(Box::pin(async move { outcome }))
    }
}

async fn timed<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .expect("test exceeded its hard timeout")
}

fn assets() -> ViewAssets {
    let asset = |content_type: &str, body: &str| Asset {
        content_type: content_type.into(),
        body: body.into(),
    };
    ViewAssets {
        assets: HashMap::from([
            (
                "/view".to_owned(),
                asset(
                    "text/html; charset=utf-8",
                    "<!doctype html><script src=\"/view/app.js\"></script>",
                ),
            ),
            (
                "/view/app.js".to_owned(),
                asset(
                    "text/javascript; charset=utf-8",
                    "document.title = 'Meeting'",
                ),
            ),
            (
                "/view/mark.svg".to_owned(),
                asset(
                    "image/svg+xml",
                    "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
                ),
            ),
        ]),
        policy: POLICY.into(),
    }
}

struct Fixture {
    bridge: Bridge,
    recorder: Arc<Recorder>,
    http: reqwest::Client,
    key: String,
}

impl Fixture {
    async fn start(recorder: Recorder) -> Self {
        Self::configured(recorder, |_| ()).await
    }

    async fn configured(recorder: Recorder, configure: impl FnOnce(&mut Options)) -> Self {
        let recorder = Arc::new(recorder);
        let mut options = Options::new(CONTROL);
        options.assets = assets();
        configure(&mut options);
        let bridge = Bridge::start(options, recorder.clone()).await.unwrap();
        let view = send_control(bridge.url(), CONTROL, &json!({ "action": "view" }))
            .await
            .unwrap();
        let key = view["url"]
            .as_str()
            .unwrap()
            .split("#key=")
            .nth(1)
            .unwrap()
            .to_owned();
        Self {
            bridge,
            recorder,
            http: reqwest::Client::builder().no_proxy().build().unwrap(),
            key,
        }
    }

    fn url(&self) -> &str {
        self.bridge.url()
    }

    async fn send(
        &self,
        method: Method,
        route: &str,
        body: Option<String>,
        token: Option<&str>,
        origin: Option<&str>,
        extra: &[(&str, &str)],
    ) -> Response {
        let mut request = self.http.request(method, format!("{}{route}", self.url()));
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        for (name, value) in extra {
            request = request.header(*name, *value);
        }
        if let Some(body) = body {
            if !extra.iter().any(|(name, _)| *name == "content-type") {
                request = request.header("content-type", "application/json");
            }
            request = request.body(body);
        }
        request.send().await.unwrap()
    }

    async fn post(
        &self,
        route: &str,
        body: &Value,
        token: Option<&str>,
        origin: Option<&str>,
    ) -> Response {
        self.send(
            Method::POST,
            route,
            Some(body.to_string()),
            token,
            origin,
            &[],
        )
        .await
    }

    async fn view_post(&self, route: &str, body: &Value) -> Response {
        let own = self.url().to_owned();
        self.post(route, body, Some(&self.key), Some(&own)).await
    }
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.bytes().await.unwrap()).unwrap()
}

fn audio() -> Value {
    json!({ "type": "audio", "captureID": "c", "source": "remote", "sequence": 0, "startMs": 0, "sampleRate": 48000, "pcm": samples_base64(&[0.0, -1.0, 1.0, 0.5]) })
}

fn with(value: &Value, key: &str, replacement: Value) -> Value {
    let mut changed = value.clone();
    changed[key] = replacement;
    changed
}

fn heartbeat() -> Value {
    json!({ "type": "heartbeat", "captureID": "capture-1" })
}

fn start_message(capture: &str) -> Value {
    json!({ "type": "start", "captureID": capture, "microphone": false, "consent": true })
}

#[tokio::test]
async fn default_bridge_serves_the_embedded_live_page_without_host_asset_configuration() {
    timed(async {
        let f = Fixture::configured(Recorder::new(), |options| {
            options.assets = ViewAssets::default();
        })
        .await;
        let response = f.send(Method::GET, "/view", None, None, None, &[]).await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.text().await.unwrap(),
            include_str!("../../../../extensions/meeting/view/index.html")
        );
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn static_page_and_exact_assets_are_key_free_no_store_and_protected_by_loopback_host() {
    timed(async {
        let f = Fixture::start(Recorder::new()).await;
        assert_eq!(f.key.len(), 64);
        assert!(
            f.key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        assert_ne!(f.key, CONTROL);
        for (route, asset) in &assets().assets {
            let response = f.send(Method::GET, route, None, None, None, &[]).await;
            assert_eq!(response.status(), 200);
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .map(|value| value.to_str().unwrap().to_owned())
            };
            assert_eq!(
                header("content-type").as_deref(),
                Some(asset.content_type.as_str())
            );
            assert_eq!(header("cache-control").as_deref(), Some("no-store"));
            assert_eq!(header("referrer-policy").as_deref(), Some("no-referrer"));
            assert_eq!(header("x-content-type-options").as_deref(), Some("nosniff"));
            assert_eq!(header("content-security-policy").as_deref(), Some(POLICY));
            assert_eq!(header("access-control-allow-origin"), None);
            let text = response.text().await.unwrap();
            assert_eq!(text, asset.body);
            assert!(!text.contains(&f.key) && !text.contains(CONTROL));
            assert_eq!(
                f.send(
                    Method::GET,
                    route,
                    None,
                    None,
                    None,
                    &[("host", "localhost:1234")]
                )
                .await
                .status(),
                403
            );
            assert_eq!(
                f.send(
                    Method::GET,
                    route,
                    None,
                    None,
                    Some("https://example.com"),
                    &[]
                )
                .await
                .status(),
                403
            );
            assert_eq!(
                f.send(Method::POST, route, None, None, None, &[])
                    .await
                    .status(),
                405
            );
            assert_eq!(
                f.send(Method::HEAD, route, None, None, None, &[])
                    .await
                    .status(),
                405
            );
        }
        assert_eq!(
            f.send(Method::GET, "/view/unknown.js", None, None, None, &[])
                .await
                .status(),
            404
        );
        assert_eq!(
            f.send(
                Method::GET,
                &format!("/view?key={}", f.key),
                None,
                None,
                None,
                &[]
            )
            .await
            .status(),
            400
        );
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn page_capture_authenticates_the_view_key_and_separates_controller_authority() {
    timed(async {
        let f = Fixture::start(Recorder::new()).await;
        let own = f.url().to_owned();
        let analysis = json!({ "type": "analysis" });
        for route in ["/pair", "/capture"] {
            assert_eq!(
                f.post(
                    route,
                    &json!({}),
                    Some(&f.key),
                    Some("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
                )
                .await
                .status(),
                404
            );
        }
        assert_eq!(
            f.post("/control", &analysis, Some(&f.key), None)
                .await
                .status(),
            401
        );
        assert_eq!(
            f.post("/control", &analysis, Some(CONTROL), Some(&own))
                .await
                .status(),
            403
        );
        assert_eq!(
            f.post("/control", &json!({}), Some(CONTROL), Some("null"))
                .await
                .status(),
            403
        );
        assert_eq!(
            f.post("/control", &analysis, Some(CONTROL), None)
                .await
                .status(),
            200
        );
        assert_eq!(*f.recorder.controls.lock().unwrap(), vec![analysis]);
        for forbidden in [
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "https://meet.google.com",
            "null",
        ] {
            assert_eq!(
                f.post("/view/capture", &heartbeat(), Some(&f.key), Some(forbidden))
                    .await
                    .status(),
                403
            );
        }
        assert_eq!(
            f.post("/view/capture", &heartbeat(), Some(&f.key), None)
                .await
                .status(),
            200
        );
        assert_eq!(
            f.post("/view/capture", &heartbeat(), Some(CONTROL), Some(&own))
                .await
                .status(),
            401
        );
        assert_eq!(
            f.post("/view/capture", &heartbeat(), None, Some(&own))
                .await
                .status(),
            401
        );
        assert_eq!(
            f.post(
                "/view/capture",
                &heartbeat(),
                Some(&"k".repeat(257)),
                Some(&own)
            )
            .await
            .status(),
            401
        );
        let response = f
            .send(
                Method::POST,
                "/view/capture",
                Some(heartbeat().to_string()),
                None,
                None,
                &[("authorization", &format!("Basic {}", f.key))],
            )
            .await;
        assert_eq!(response.status(), 401);
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn close_disconnects_the_active_page_capture_exactly_once_and_is_idempotent() {
    timed(async {
        let f = Fixture::start(Recorder::new()).await;
        assert_eq!(
            f.view_post("/view/capture", &start_message("c"))
                .await
                .status(),
            200
        );
        f.bridge.close().await;
        f.bridge.close().await;
        assert_eq!(f.recorder.disconnects.load(Ordering::SeqCst), 1);
        assert!(
            f.http
                .get(format!("{}/view", f.url()))
                .send()
                .await
                .is_err()
        );
    })
    .await;
}

#[tokio::test]
async fn rejects_rebinding_hosts_queries_browser_control_bad_content_types_oversized_bodies_and_preflight()
 {
    timed(async {
        let f = Fixture::start(Recorder::new()).await;
        let own = f.url().to_owned();
        for host in ["evil.invalid", "localhost:1234", "127.1:1234"] {
            let response = f
                .send(
                    Method::POST,
                    "/view/capture",
                    Some(heartbeat().to_string()),
                    Some(&f.key),
                    Some(&own),
                    &[("host", host)],
                )
                .await;
            assert_eq!(response.status(), 403, "accepted Host {host}");
        }
        assert_eq!(
            f.post(
                &format!("/view/capture?token={}", f.key),
                &heartbeat(),
                Some(&f.key),
                Some(&own)
            )
            .await
            .status(),
            400
        );
        let invalid_url = f
            .post(
                &format!("/view/capture?token={}", f.key),
                &heartbeat(),
                Some(&f.key),
                Some(&own),
            )
            .await;
        assert_eq!(body(invalid_url).await, json!({ "error": "invalid_url" }));
        assert_eq!(
            f.send(
                Method::POST,
                "/view/capture",
                Some(heartbeat().to_string()),
                Some(&f.key),
                Some(&own),
                &[("content-type", "text/plain")]
            )
            .await
            .status(),
            415
        );
        let accepted = f
            .send(
                Method::POST,
                "/view/capture",
                Some(heartbeat().to_string()),
                Some(&f.key),
                Some(&own),
                &[("content-type", "Application/JSON; charset=UTF-8")],
            )
            .await;
        assert_eq!(accepted.status(), 200);
        let huge = json!({ "text": "x".repeat(1_048_576) });
        assert_eq!(
            f.post("/view/capture", &huge, Some(&f.key), Some(&own))
                .await
                .status(),
            413
        );
        assert_eq!(
            f.post("/control", &huge, Some(CONTROL), None)
                .await
                .status(),
            413
        );
        assert_eq!(
            f.send(
                Method::POST,
                "/view/capture",
                Some("{".into()),
                Some(&f.key),
                Some(&own),
                &[]
            )
            .await
            .status(),
            400
        );
        let preflight = f
            .send(
                Method::OPTIONS,
                "/view/capture",
                None,
                None,
                Some(&own),
                &[
                    ("access-control-request-method", "POST"),
                    (
                        "access-control-request-headers",
                        "authorization,content-type",
                    ),
                ],
            )
            .await;
        assert_eq!(preflight.status(), 405);
        assert!(
            preflight
                .headers()
                .get("access-control-allow-origin")
                .is_none()
        );
        assert!(
            preflight
                .headers()
                .get("access-control-allow-credentials")
                .is_none()
        );
        assert_eq!(
            f.send(Method::OPTIONS, "/view/state", None, None, Some(&own), &[])
                .await
                .status(),
            405
        );
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn validates_capture_pcm_and_every_union_field_before_delivery() {
    timed(async {
        let f = Fixture::start(Recorder::new()).await;
        let base = audio();
        let invalid = [
            json!({ "type": "start", "captureID": "c", "microphone": false, "consent": false }),
            json!({ "type": "start", "captureID": "c", "tabID": 1, "microphone": false, "consent": true }),
            json!({ "type": "start", "captureID": "c", "microphone": "false", "consent": true }),
            with(&base, "source", json!("both")),
            with(&base, "sequence", json!(-1)),
            with(&base, "sequence", json!(0.5)),
            with(&base, "startMs", json!(-1)),
            with(&base, "sampleRate", json!(192001)),
            with(&base, "sampleRate", json!(0)),
            with(&base, "pcm", json!("AA==")),
            with(&base, "pcm", json!(samples_base64(&[f32::NAN]))),
            with(&base, "pcm", json!(samples_base64(&[f32::INFINITY]))),
            with(&base, "pcm", json!(samples_base64(&[1.1]))),
            with(&base, "pcm", json!(samples_base64(&vec![0.0; 48001]))),
            with(&base, "pcm", json!("not base64")),
            with(&base, "pcm", json!("AAAA".repeat(256_001))),
            with(&base, "pcm", json!("")),
            json!({ "type": "stop", "captureID": "c", "reason": "" }),
            json!({ "type": "stop", "captureID": "c", "reason": "bad\nreason" }),
            json!({ "type": "stop", "captureID": "c", "reason": "x".repeat(257) }),
            json!({ "type": "heartbeat", "captureID": "" }),
            json!({ "type": "heartbeat", "captureID": "bad id" }),
            json!({ "type": "heartbeat", "captureID": "c", "token": "injected" }),
            json!({ "type": "analysis", "captureID": "c" }),
        ];
        for message in &invalid {
            let response = f.view_post("/view/capture", message).await;
            assert_eq!(response.status(), 400, "accepted {}", message.to_string().chars().take(120).collect::<String>());
        }
        assert!(f.recorder.received().is_empty());
        let loud = with(&with(&base, "sampleRate", json!(192_000)), "pcm", json!(samples_base64(&vec![0.0; 192_000])));
        for valid in [
            json!({ "type": "start", "captureID": "c", "microphone": true, "consent": true }),
            base,
            loud,
            json!({ "type": "heartbeat", "captureID": "c" }),
            json!({ "type": "stop", "captureID": "c", "reason": "user" }),
        ] {
            let response = f.view_post("/view/capture", &valid).await;
            assert_eq!(response.status(), 200);
            assert!(response.headers().get("access-control-allow-origin").is_none());
        }
        let received = f.recorder.received();
        assert_eq!(received.len(), 5);
        assert_eq!(received[0], CaptureMessage::Start { capture_id: "c".into(), microphone: true });
        assert_eq!(
            received[1],
            CaptureMessage::Audio { capture_id: "c".into(), source: AudioSource::Remote, sequence: 0, start_ms: 0.0, sample_rate: 48000, samples: vec![0.0, -1.0, 1.0, 0.5] }
        );
        assert!(matches!(&received[2], CaptureMessage::Audio { sample_rate: 192_000, samples, .. } if samples.len() == 192_000));
        assert_eq!(received[4], CaptureMessage::Stop { capture_id: "c".into(), reason: "user".into() });
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn pressure_and_duplicate_idempotency_stay_with_the_backend_and_failures_expose_no_details() {
    timed(async {
        let mut recorder = Recorder::new();
        recorder.on_capture = Box::new(|index, _| {
            Box::pin(async move {
                match index {
                    1 => Ok(json!({ "busy": true })),
                    4 => Err(CallbackFailed),
                    _ => Ok(json!({ "ok": true })),
                }
            })
        });
        let f = Fixture::start(recorder).await;
        let packet = with(
            &with(
                &with(&audio(), "source", json!("microphone")),
                "sequence",
                json!(10),
            ),
            "sampleRate",
            json!(16000),
        );
        let packet = with(
            &with(&packet, "startMs", json!(20)),
            "pcm",
            json!(samples_base64(&[0.0])),
        );
        let busy = f.view_post("/view/capture", &packet).await;
        assert_eq!(busy.status(), 429);
        assert_eq!(busy.headers().get("retry-after").unwrap(), "1");
        assert_eq!(f.view_post("/view/capture", &packet).await.status(), 200);
        assert_eq!(f.view_post("/view/capture", &packet).await.status(), 200);
        let received = f.recorder.received();
        assert_eq!(received.len(), 3);
        assert!(received.iter().all(|message| *message == received[0]));
        let failed = f.view_post("/view/capture", &packet).await;
        assert_eq!(failed.status(), 500);
        assert_eq!(failed.headers().get("cache-control").unwrap(), "no-store");
        assert_eq!(body(failed).await, json!({ "error": "callback_failed" }));
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn control_client_preserves_safe_parent_errors_and_heartbeat_is_independent_of_a_blocked_audio_ack()
 {
    timed(async {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let mut recorder = Recorder::new();
        recorder.control_response = json!({ "error": "Select an available model in the TUI" });
        recorder.on_capture = {
            let (entered, release) = (entered.clone(), release.clone());
            let first_audio = Arc::new(AtomicBool::new(true));
            Box::new(move |_, message| {
                let (entered, release) = (entered.clone(), release.clone());
                let blocks = matches!(message, CaptureMessage::Audio { .. })
                    && first_audio.swap(false, Ordering::SeqCst);
                Box::pin(async move {
                    if blocks {
                        entered.notify_one();
                        release.notified().await;
                    }
                    Ok(if matches!(message, CaptureMessage::Heartbeat { .. }) {
                        json!({ "stop": true })
                    } else {
                        json!({ "accepted": true })
                    })
                })
            })
        };
        let f = Fixture::start(recorder).await;
        assert_eq!(
            send_control(f.url(), CONTROL, &json!({ "type": "start" }))
                .await
                .unwrap(),
            json!({ "error": "Select an available model in the TUI" })
        );
        let blocked = tokio::spawn({
            let (http, url, key) = (f.http.clone(), f.url().to_owned(), f.key.clone());
            async move {
                let body = with(
                    &with(&audio(), "pcm", json!(samples_base64(&[0.0]))),
                    "sampleRate",
                    json!(48000),
                )
                .to_string();
                http.post(format!("{url}/view/capture"))
                    .header("origin", &url)
                    .header("authorization", format!("Bearer {key}"))
                    .header("content-type", "application/json")
                    .body(body)
                    .send()
                    .await
                    .unwrap()
                    .status()
            }
        });
        entered.notified().await;
        let heartbeat = f
            .view_post(
                "/view/capture",
                &json!({ "type": "heartbeat", "captureID": "c" }),
            )
            .await;
        assert_eq!(heartbeat.status(), 200);
        assert_eq!(body(heartbeat).await, json!({ "stop": true }));
        let overlapping = f
            .view_post("/view/capture", &with(&audio(), "sequence", json!(1)))
            .await;
        assert_eq!(overlapping.status(), 429);
        release.notify_one();
        assert_eq!(blocked.await.unwrap(), 200);
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn control_client_validates_the_endpoint_credential_and_reports_rejections() {
    timed(async {
        let f = Fixture::start(Recorder::new()).await;
        for url in [
            "http://localhost:9000",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "https://127.0.0.1:9000",
            "http://127.0.0.1:9000/x",
        ] {
            assert_eq!(
                send_control(url, CONTROL, &json!({})).await.unwrap_err().0,
                "Invalid bridge URL"
            );
        }
        assert_eq!(
            send_control(f.url(), "short", &json!({}))
                .await
                .unwrap_err()
                .0,
            "Invalid controller credential"
        );
        assert_eq!(
            send_control(
                f.url(),
                "contains space and is long enough to pass",
                &json!({})
            )
            .await
            .unwrap_err()
            .0,
            "Invalid controller credential"
        );
        assert_eq!(
            send_control(f.url(), &"y".repeat(40), &json!({}))
                .await
                .unwrap_err()
                .0,
            "Bridge control rejected (401)"
        );
        assert_eq!(
            send_control(f.url(), CONTROL, &json!({ "text": "x".repeat(1_048_576) }))
                .await
                .unwrap_err()
                .0,
            "Invalid control payload"
        );
        assert_eq!(
            send_control(
                &format!("{}/", f.url()),
                CONTROL,
                &json!({ "action": "status" })
            )
            .await
            .unwrap(),
            json!({ "ok": true })
        );
        f.bridge.close().await;
        assert_eq!(
            send_control(f.url(), CONTROL, &json!({}))
                .await
                .unwrap_err()
                .0,
            "Bridge request failed or timed out; outcome unknown"
        );
    })
    .await;
}

#[tokio::test]
async fn live_view_key_is_independent_native_only_to_obtain_and_exposes_only_allow_listed_state() {
    timed(async {
        let mut recorder = Recorder::new();
        recorder.control_response = json!({ "meeting": { "id": "m" } });
        recorder.view = Some(json!({
            "meeting": { "id": "m" }, "meetings": [], "segments": [], "findings": [], "health": {}, "audio": {}, "analysis": {}, "config": {},
            "ask": { "history": [], "busy": false }, "pairing": { "code": "must-not-be-visible" }, "controlToken": "must-not-be-visible",
        }));
        recorder.ask = Some(Box::new(|question| Ok(json!({ "question": question, "answer": "Supported by transcript", "status": "answered" }))));
        let f = Fixture::start(recorder).await;
        let own = f.url().to_owned();
        let get = async |token: &str, origin: Option<&str>, extra: &[(&str, &str)]| f.send(Method::GET, "/view/state", None, Some(token), origin, extra).await;
        assert_eq!(get(CONTROL, None, &[]).await.status(), 401);
        assert_eq!(get(&f.key, Some("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), &[]).await.status(), 403);
        assert_eq!(get(&f.key, Some("https://evil.invalid"), &[]).await.status(), 403);
        assert_eq!(get(&f.key, None, &[("host", "localhost")]).await.status(), 403);
        let state = get(&f.key, Some(&own), &[]).await;
        assert_eq!(state.status(), 200);
        assert!(state.headers().get("access-control-allow-origin").is_none());
        assert_eq!(state.headers().get("cache-control").unwrap(), "no-store");
        let text = state.text().await.unwrap();
        assert!(!text.contains("must-not-be-visible"));
        let state: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(state["ask"], json!({ "history": [], "busy": false }));
        assert!(state.get("pairing").is_none() && state.get("controlToken").is_none());
        assert_eq!(f.send(Method::GET, &format!("/view/state?key={}", f.key), None, Some(&f.key), None, &[]).await.status(), 400);
        for action in ["stop", "retry"] {
            assert_eq!(f.view_post("/view/control", &json!({ "action": action })).await.status(), 200);
        }
        for rejected in [json!({ "action": "start" }), json!({ "action": "pair" }), json!({ "action": "configure" }), json!({ "action": "approve" }), json!({ "action": "stop", "meetingID": "other" }), json!({ "action": ["stop"] })] {
            assert_eq!(f.view_post("/view/control", &rejected).await.status(), 400, "accepted {rejected}");
        }
        assert_eq!(*f.recorder.controls.lock().unwrap(), vec![json!({ "action": "stop" }), json!({ "action": "retry" })]);
        assert_eq!(f.post("/control", &json!({ "action": "stop" }), Some(&f.key), Some(&own)).await.status(), 403);
        let answered = f.view_post("/view/ask", &json!({ "question": "  What is the decision?  " })).await;
        assert_eq!(answered.status(), 200);
        assert_eq!(body(answered).await["question"], "What is the decision?");
        for rejected in [json!({ "question": "" }), json!({ "question": "   " }), json!({ "question": "x".repeat(2001) }), json!({ "question": "Hello", "meetingID": "other" })] {
            assert_eq!(f.view_post("/view/ask", &rejected).await.status(), 400, "accepted {rejected}");
        }
        assert_eq!(f.view_post("/view/control", &json!({ "action": "stop", "text": "x".repeat(20_000) })).await.status(), 413);
        let capture = f.view_post("/view/capture", &json!({ "type": "heartbeat", "captureID": "c" })).await;
        assert_eq!(body(capture).await, json!({ "ok": true }));
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn live_view_availability_busy_and_answer_errors_stay_visible_without_exception_details() {
    timed(async {
        let unavailable = Fixture::start(Recorder::new()).await;
        assert_eq!(
            unavailable
                .view_post("/view/ask", &json!({ "question": "Hello" }))
                .await
                .status(),
            503
        );
        let state = unavailable
            .send(
                Method::GET,
                "/view/state",
                None,
                Some(&unavailable.key),
                None,
                &[],
            )
            .await;
        assert_eq!(state.status(), 503);
        assert_eq!(body(state).await, json!({ "error": "view_unavailable" }));
        unavailable.bridge.close().await;

        let mut recorder = Recorder::new();
        recorder.view = Some(json!({ "meeting": { "id": "m" } }));
        recorder.ask = Some(Box::new(|question| match question.as_str() {
            "busy" => Ok(json!({ "busy": true })),
            "no evidence" => Ok(json!({ "status": "error", "error": "no_transcript" })),
            "failed answer" => Ok(json!({ "status": "error", "error": "answer_failed" })),
            _ => Err(CallbackFailed),
        }));
        let f = Fixture::start(recorder).await;
        assert_eq!(
            f.view_post("/view/ask", &json!({ "question": "busy" }))
                .await
                .status(),
            409
        );
        assert_eq!(
            f.view_post("/view/ask", &json!({ "question": "no evidence" }))
                .await
                .status(),
            422
        );
        assert_eq!(
            f.view_post("/view/ask", &json!({ "question": "failed answer" }))
                .await
                .status(),
            502
        );
        let failed = f
            .view_post("/view/ask", &json!({ "question": "failure" }))
            .await;
        assert_eq!(failed.status(), 502);
        assert_eq!(body(failed).await, json!({ "error": "answer_failed" }));
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn page_heartbeat_keeps_capture_alive_then_expiry_disconnects_once_when_the_page_disappears()
{
    timed(async {
        let f = Fixture::configured(Recorder::new(), |options| {
            options.capture_timeout = Duration::from_millis(600);
            options.expiry_interval = Duration::from_millis(50);
        })
        .await;
        assert_eq!(
            f.view_post("/view/capture", &start_message("capture-1"))
                .await
                .status(),
            200
        );
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert_eq!(
                f.view_post("/view/capture", &heartbeat()).await.status(),
                200
            );
        }
        assert_eq!(f.recorder.disconnects.load(Ordering::SeqCst), 0);
        f.recorder.disconnected.notified().await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        f.bridge.close().await;
        assert_eq!(f.recorder.disconnects.load(Ordering::SeqCst), 1);
    })
    .await;
}

#[tokio::test]
async fn a_stop_reply_from_the_backend_retires_the_capture_so_close_does_not_disconnect() {
    timed(async {
        let mut recorder = Recorder::new();
        recorder.on_capture = Box::new(|_, message| {
            Box::pin(async move {
                Ok(if matches!(message, CaptureMessage::Heartbeat { .. }) {
                    json!({ "stop": true })
                } else {
                    json!({ "accepted": true })
                })
            })
        });
        let f = Fixture::start(recorder).await;
        assert_eq!(
            f.view_post("/view/capture", &start_message("capture-1"))
                .await
                .status(),
            200
        );
        assert_eq!(
            body(f.view_post("/view/capture", &heartbeat()).await).await,
            json!({ "stop": true })
        );
        f.bridge.close().await;
        assert_eq!(f.recorder.disconnects.load(Ordering::SeqCst), 0);
    })
    .await;
}

async fn owner_link(f: &Fixture) -> (String, String) {
    let page = send_control(f.url(), CONTROL, &json!({ "action": "owner-view" }))
        .await
        .unwrap();
    let url = page["url"].as_str().unwrap().to_owned();
    let fragment = url
        .strip_prefix(&format!("{}/view#", f.url()))
        .unwrap()
        .to_owned();
    let fields: Vec<(&str, &str)> = fragment
        .split('&')
        .map(|field| field.split_once('=').unwrap())
        .collect();
    assert_eq!(fields.len(), 2, "{url}");
    assert_eq!(fields[0], ("key", f.key.as_str()));
    assert_eq!(fields[1].0, "owner");
    (url, fields[1].1.to_owned())
}

fn owner_recorder() -> Recorder {
    let mut recorder = Recorder::new();
    recorder.view = Some(json!({ "meeting": { "id": "m" } }));
    recorder.ask = Some(Box::new(|_| Ok(json!({ "status": "answered" }))));
    recorder.owner_read = Some(Ok(json!({ "askModel": "inherit", "models": [] })));
    recorder.owner_update = Some(Box::new(|_| Ok(Outcome::Saved(json!({ "saved": true })))));
    recorder
}

#[tokio::test]
async fn native_control_issues_a_separate_owner_link_that_no_page_credential_can_obtain() {
    timed(async {
        let f = Fixture::start(owner_recorder()).await;
        let own = f.url().to_owned();
        let ordinary = send_control(f.url(), CONTROL, &json!({ "action": "view" }))
            .await
            .unwrap();
        assert_eq!(
            ordinary,
            json!({ "url": format!("{own}/view#key={}", f.key) })
        );
        let (url, owner) = owner_link(&f).await;
        assert_eq!(url, format!("{own}/view#key={}&owner={owner}", f.key));
        assert_eq!(owner.len(), 64);
        assert!(
            owner
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        assert_ne!(owner, f.key);
        assert_ne!(owner, CONTROL);
        assert_eq!(owner_link(&f).await.1, owner);
        let request = json!({ "action": "owner-view" });
        for token in [Some(f.key.as_str()), Some(owner.as_str()), None] {
            let response = f.post("/control", &request, token, None).await;
            assert_eq!(response.status(), 401);
            assert_eq!(body(response).await, json!({ "error": "unauthorized" }));
        }
        assert_eq!(
            f.post("/control", &request, Some(CONTROL), Some(&own))
                .await
                .status(),
            403
        );
        let extra = f
            .post(
                "/control",
                &json!({ "action": "owner-view", "meetingID": "m" }),
                Some(CONTROL),
                None,
            )
            .await;
        assert_eq!(extra.status(), 400);
        assert_eq!(body(extra).await, json!({ "error": "invalid_action" }));
        assert!(f.recorder.controls.lock().unwrap().is_empty());
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn owner_settings_accept_only_the_owner_key_and_page_routes_reject_it() {
    timed(async {
        let f = Fixture::start(owner_recorder()).await;
        let own = f.url().to_owned();
        let (_, owner) = owner_link(&f).await;
        let random = "f".repeat(64);
        let read = async |token: Option<&str>, origin: Option<&str>, extra: &[(&str, &str)]| {
            f.send(
                Method::GET,
                "/view/owner/settings",
                None,
                token,
                origin,
                extra,
            )
            .await
        };
        for token in [
            None,
            Some(f.key.as_str()),
            Some(CONTROL),
            Some(random.as_str()),
        ] {
            let response = read(token, Some(&own), &[]).await;
            assert_eq!(response.status(), 401, "{token:?}");
            assert_eq!(body(response).await, json!({ "error": "unauthorized" }));
        }
        let granted = read(Some(&owner), Some(&own), &[]).await;
        assert_eq!(granted.status(), 200);
        assert_eq!(granted.headers().get("cache-control").unwrap(), "no-store");
        assert!(
            granted
                .headers()
                .get("access-control-allow-origin")
                .is_none()
        );
        assert_eq!(
            body(granted).await,
            json!({ "askModel": "inherit", "models": [] })
        );
        assert_eq!(read(Some(&owner), None, &[]).await.status(), 200);
        for origin in [
            "https://example.com",
            "null",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            let response = read(Some(&owner), Some(origin), &[]).await;
            assert_eq!(response.status(), 403);
            assert_eq!(body(response).await, json!({ "error": "invalid_origin" }));
        }
        assert_eq!(
            read(Some(&owner), None, &[("host", "localhost")])
                .await
                .status(),
            403
        );
        assert_eq!(
            f.send(
                Method::GET,
                &format!("/view/owner/settings?owner={owner}"),
                None,
                Some(&owner),
                None,
                &[]
            )
            .await
            .status(),
            400
        );
        for method in [Method::OPTIONS, Method::PUT, Method::DELETE, Method::PATCH] {
            let response = f
                .send(
                    method.clone(),
                    "/view/owner/settings",
                    None,
                    Some(&owner),
                    Some(&own),
                    &[],
                )
                .await;
            assert_eq!(response.status(), 405, "{method}");
            assert_eq!(
                body(response).await,
                json!({ "error": "method_not_allowed" })
            );
        }
        assert_eq!(
            f.send(
                Method::GET,
                "/view/owner",
                None,
                Some(&owner),
                Some(&own),
                &[]
            )
            .await
            .status(),
            404
        );
        assert_eq!(
            f.send(
                Method::GET,
                "/view/state",
                None,
                Some(&owner),
                Some(&own),
                &[]
            )
            .await
            .status(),
            401
        );
        for (route, request) in [
            ("/view/control", json!({ "action": "stop" })),
            ("/view/ask", json!({ "question": "Hello" })),
            ("/view/capture", heartbeat()),
        ] {
            assert_eq!(
                f.post(route, &request, Some(&owner), Some(&own))
                    .await
                    .status(),
                401,
                "{route}"
            );
        }
        assert!(f.recorder.controls.lock().unwrap().is_empty());
        assert!(f.recorder.received().is_empty());
        let state = f
            .send(
                Method::GET,
                "/view/state",
                None,
                Some(&f.key),
                Some(&own),
                &[],
            )
            .await;
        assert_eq!(state.status(), 200);
        let text = state.text().await.unwrap();
        assert!(!text.contains(&owner) && !text.contains(CONTROL));
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn owner_update_strictly_parses_bounded_settings_before_reaching_the_runtime() {
    timed(async {
        let f = Fixture::start(owner_recorder()).await;
        let own = f.url().to_owned();
        let (_, owner) = owner_link(&f).await;
        let post = async |request: &Value| {
            f.post("/view/owner/settings", request, Some(&owner), Some(&own))
                .await
        };
        let binding = json!({ "server": "docs", "search": "search", "read": "read" });
        let bound = |field: &str, value: Value| {
            let mut binding = binding.clone();
            binding[field] = value;
            json!({ "knowledge": { "mcpEnabled": true, "bindings": [binding] } })
        };
        let long = "x".repeat(201);
        for rejected in [
            json!({}),
            json!([]),
            json!(null),
            json!("inherit"),
            json!({ "action": "approve", "proposalID": "x" }),
            json!({ "askModel": "inherit", "tool": "search" }),
            json!({ "askModel": null }),
            json!({ "askModel": "p/m" }),
            json!({ "askModel": { "providerID": "p" } }),
            json!({ "askModel": { "id": "m" } }),
            json!({ "askModel": { "providerID": "p", "id": "m1", "account": "x" } }),
            json!({ "askModel": { "providerID": "", "id": "m1" } }),
            json!({ "askModel": { "providerID": "p", "id": "m1", "variant": "" } }),
            json!({ "askModel": { "providerID": "p", "id": "m1", "variant": 1 } }),
            json!({ "askModel": { "providerID": "p", "id": "m1", "profile": long } }),
            json!({ "askModel": { "providerID": long, "id": "m1" } }),
            json!({ "knowledge": { "mcpEnabled": true } }),
            json!({ "knowledge": { "bindings": [] } }),
            json!({ "knowledge": { "mcpEnabled": "true", "bindings": [] } }),
            json!({ "knowledge": { "mcpEnabled": true, "autoApply": true, "bindings": [] } }),
            json!({ "knowledge": { "mcpEnabled": true, "requireApproval": false, "bindings": [] } }),
            json!({ "knowledge": { "mcpEnabled": true, "retrievalTTL": 0, "bindings": [] } }),
            json!({ "knowledge": { "mcpEnabled": true, "bindings": {} } }),
            json!({ "knowledge": { "mcpEnabled": true, "bindings": vec![binding.clone(); 5] } }),
            bound("server", json!("")),
            bound("search", json!(long)),
            bound("read", json!(null)),
            bound("write", json!("")),
            bound("enabled", json!("yes")),
            bound("delete", json!("remove")),
            json!({ "knowledge": { "mcpEnabled": true, "bindings": [{ "server": "docs", "search": "search" }] } }),
            json!({ "transcription": { "model": "other" } }),
        ] {
            let response = post(&rejected).await;
            assert_eq!(response.status(), 400, "accepted {rejected}");
            assert_eq!(body(response).await, json!({ "error": "invalid_settings" }));
        }
        assert!(f.recorder.owner_updates.lock().unwrap().is_empty());
        let invalid = f
            .send(Method::POST, "/view/owner/settings", Some("{".into()), Some(&owner), Some(&own), &[])
            .await;
        assert_eq!(invalid.status(), 400);
        assert_eq!(body(invalid).await, json!({ "error": "invalid_json" }));
        assert_eq!(
            f.send(
                Method::POST,
                "/view/owner/settings",
                Some(json!({ "askModel": "inherit" }).to_string()),
                Some(&owner),
                Some(&own),
                &[("content-type", "text/plain")],
            )
            .await
            .status(),
            415
        );
        let oversized = post(&json!({ "askModel": "inherit", "padding": "x".repeat(16_384) })).await;
        assert_eq!(oversized.status(), 413);
        assert_eq!(body(oversized).await, json!({ "error": "payload_too_large" }));

        let thai = "ก".repeat(200);
        for accepted in [
            json!({ "askModel": "inherit" }),
            json!({ "askModel": { "providerID": "p", "id": "vendor/model-x", "variant": "deep", "profile": "acct" } }),
            json!({ "knowledge": { "mcpEnabled": false, "bindings": [
                { "server": thai, "search": "search", "read": "read", "write": "replace", "enabled": false },
                binding,
            ] } }),
            json!({ "askModel": { "providerID": "p", "id": "m1" }, "knowledge": { "mcpEnabled": true, "bindings": [] } }),
        ] {
            let response = post(&accepted).await;
            assert_eq!(response.status(), 200, "rejected {accepted}");
            assert_eq!(body(response).await, json!({ "saved": true }));
        }
        let explicit = |id: &str, variant: Option<&str>, profile: Option<&str>| AnalysisModel::Explicit {
            id: id.into(),
            provider_id: "p".into(),
            variant: variant.map(Into::into),
            profile: profile.map(Into::into),
        };
        let entry = |server: &str, write: Option<&str>, enabled: bool| KnowledgeBinding {
            server: server.into(),
            search: "search".into(),
            read: "read".into(),
            write: write.map(Into::into),
            enabled,
        };
        assert_eq!(
            *f.recorder.owner_updates.lock().unwrap(),
            vec![
                Update { ask_model: Some(AnalysisModel::Inherit), knowledge: None },
                Update {
                    ask_model: Some(explicit("vendor/model-x", Some("deep"), Some("acct"))),
                    knowledge: None,
                },
                Update {
                    ask_model: None,
                    knowledge: Some(Knowledge {
                        mcp_enabled: false,
                        bindings: vec![entry(&thai, Some("replace"), false), entry("docs", None, true)],
                    }),
                },
                Update {
                    ask_model: Some(explicit("m1", None, None)),
                    knowledge: Some(Knowledge { mcp_enabled: true, bindings: Vec::new() }),
                },
            ]
        );
        f.bridge.close().await;
    })
    .await;
}

#[tokio::test]
async fn owner_outcomes_map_to_explicit_statuses_without_details() {
    timed(async {
        let unavailable = Fixture::start(Recorder::new()).await;
        let (_, owner) = owner_link(&unavailable).await;
        let own = unavailable.url().to_owned();
        let read = unavailable
            .send(
                Method::GET,
                "/view/owner/settings",
                None,
                Some(&owner),
                Some(&own),
                &[],
            )
            .await;
        assert_eq!(read.status(), 503);
        assert_eq!(body(read).await, json!({ "error": "owner_unavailable" }));
        let update = unavailable
            .post(
                "/view/owner/settings",
                &json!({ "askModel": "inherit" }),
                Some(&owner),
                Some(&own),
            )
            .await;
        assert_eq!(update.status(), 503);
        assert_eq!(body(update).await, json!({ "error": "owner_unavailable" }));
        unavailable.bridge.close().await;

        let mut recorder = owner_recorder();
        recorder.owner_read = Some(Err(CallbackFailed));
        recorder.owner_update = Some(Box::new(|update| match &update.ask_model {
            Some(AnalysisModel::Inherit) => Err(CallbackFailed),
            _ => Ok(Outcome::SelectionUnavailable),
        }));
        let f = Fixture::start(recorder).await;
        let (_, owner) = owner_link(&f).await;
        let own = f.url().to_owned();
        let failed = f
            .send(
                Method::GET,
                "/view/owner/settings",
                None,
                Some(&owner),
                Some(&own),
                &[],
            )
            .await;
        assert_eq!(failed.status(), 500);
        assert_eq!(body(failed).await, json!({ "error": "owner_failed" }));
        let failed = f
            .post(
                "/view/owner/settings",
                &json!({ "askModel": "inherit" }),
                Some(&owner),
                Some(&own),
            )
            .await;
        assert_eq!(failed.status(), 500);
        assert_eq!(body(failed).await, json!({ "error": "owner_failed" }));
        let missing = f
            .post(
                "/view/owner/settings",
                &json!({ "askModel": { "providerID": "p", "id": "missing" } }),
                Some(&owner),
                Some(&own),
            )
            .await;
        assert_eq!(missing.status(), 422);
        assert_eq!(
            body(missing).await,
            json!({ "error": "selection_unavailable" })
        );
        f.bridge.close().await;
    })
    .await;
}
