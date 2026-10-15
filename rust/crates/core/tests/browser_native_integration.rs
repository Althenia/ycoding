use axum::{Router, extract::State, response::Html, routing::get};
use serde_json::json;
use std::{
    collections::BTreeSet,
    path::PathBuf,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use ycoding_core::platform::browser::{
    admission::Admission,
    bridge::Error,
    isolated::{Options, Service},
};
use ycoding_schema::{DomainDecode, isolated_browser, parse_json, session_id::SessionId};

const CHROME: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE: &str = r#"<!doctype html><title>Native fixture</title>
<button onclick="this.textContent='Clicked '+(this.n=(this.n||0)+1)">Click once</button>
<input aria-label="Text input" oninput="document.querySelector('#typed').textContent='Typed '+this.value">
<button id="typed">Empty input</button>
<input type="file" aria-label="Protected file">
<input type="password" aria-label="Protected password">
<button onclick="window.open('/popup');window.open('/popup');window.open('/popup')">Open popups</button>
<a href="/popup" target="_blank">Popup link</a>
<button onclick="Promise.all([
 navigator.clipboard.readText().then(()=>'read-allowed',()=>'read-denied'),
 navigator.clipboard.writeText('native-integration-synthetic').then(()=>'write-allowed',()=>'write-denied')
]).then(v=>this.textContent=v.join(' '))">Try clipboard</button>
<button onclick="document.querySelector('input[type=file]').click()">Choose file</button>
<button onclick="const x=new XMLHttpRequest();x.open('GET','/effect',false);x.send();this.textContent='Effect sent'">Send effect</button>
"#;

#[derive(Default)]
struct Requests {
    popups: AtomicUsize,
    effects: AtomicUsize,
    effect_received: tokio::sync::Notify,
    effect_release: tokio::sync::Notify,
}

struct Harness {
    url: String,
    requests: Arc<Requests>,
    services: Mutex<Vec<Arc<Service>>>,
    baseline: BTreeSet<PathBuf>,
    owned: Mutex<BTreeSet<PathBuf>>,
    groups: Mutex<BTreeSet<u32>>,
}

fn decode<T: DomainDecode>(value: serde_json::Value) -> T {
    T::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
}

fn session() -> SessionId {
    SessionId::new("ses_native_integration").unwrap()
}

fn profiles() -> BTreeSet<PathBuf> {
    std::fs::read_dir(std::env::temp_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ycoding-isolated-browser-")
        })
        .collect()
}

fn processes() -> Vec<(u32, u32, String)> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,pgid=,command="])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| {
            let mut fields = line.split_whitespace();
            (
                fields.next().unwrap().parse().unwrap(),
                fields.next().unwrap().parse().unwrap(),
                fields.collect::<Vec<_>>().join(" "),
            )
        })
        .collect()
}

impl Harness {
    fn service(&self) -> Arc<Service> {
        #[cfg(unix)]
        let executor =
            Arc::new(ycoding_core::platform::browser::chrome_executor::IsolatedChrome::installed());
        #[cfg(not(unix))]
        compile_error!(
            "browser_native_integration requires macOS arm64 and installed Chrome >=152"
        );
        let service = Service::new(
            executor,
            Arc::new(Admission::default()),
            Arc::new(|id| id == &session()),
            Options {
                operation_timeout: Duration::from_secs(3),
                ..Default::default()
            },
        );
        self.services.lock().unwrap().push(service.clone());
        service
    }

    async fn start(&self, service: &Arc<Service>) -> isolated_browser::Status {
        let status = service
            .start(&session(), decode(json!({"url": self.url})))
            .await
            .expect("real Rust isolated Chrome startup must reach ready");
        assert_eq!(status.state, isolated_browser::State::Ready);
        let roots = profiles()
            .difference(&self.baseline)
            .cloned()
            .collect::<BTreeSet<_>>();
        assert_eq!(roots.len(), 1, "one owned temporary profile per instance");
        let root = roots.first().unwrap();
        assert!(root.join("profile").is_dir());
        assert_eq!(
            std::fs::read_dir(root.join("downloads")).unwrap().count(),
            0
        );
        let groups = processes()
            .into_iter()
            .filter(|(_, _, command)| command.contains(root.to_str().unwrap()))
            .map(|(_, group, _)| group)
            .collect::<BTreeSet<_>>();
        assert_eq!(groups.len(), 1, "Chrome must have an owned process group");
        assert!(!groups.contains(&std::process::id()));
        self.groups.lock().unwrap().extend(groups);
        self.owned.lock().unwrap().extend(roots);
        status
    }

    fn assert_clean(&self) {
        assert_eq!(
            profiles(),
            self.baseline,
            "temporary browser profile leaked"
        );
        let groups = self.groups.lock().unwrap();
        let roots = self.owned.lock().unwrap();
        assert!(
            processes().iter().all(|(_, group, command)| {
                !groups.contains(group)
                    && !roots
                        .iter()
                        .any(|root| command.contains(root.to_str().unwrap()))
            }),
            "owned Chrome process or descendant leaked"
        );
    }
}

async fn observe(
    service: &Service,
    status: &isolated_browser::Status,
) -> isolated_browser::Observation {
    service
        .observe(isolated_browser::ObserveInput {
            session_id: session(),
            instance_id: status.instance_id.clone().unwrap(),
            tab_id: status.tab.as_ref().unwrap().id.clone(),
            generation: status.tab.as_ref().unwrap().generation,
            call_id: decode(json!("observe")),
        })
        .await
        .unwrap()
}

fn action(
    observation: &isolated_browser::Observation,
    call: &str,
    action: serde_json::Value,
) -> isolated_browser::ActionInput {
    isolated_browser::ActionInput {
        session_id: session(),
        instance_id: observation.instance_id.clone(),
        tab_id: observation.tab_id.clone(),
        generation: observation.generation,
        document_generation: observation.document_generation,
        observation_revision: observation.revision,
        call_id: decode(json!(call)),
        action: decode(action),
    }
}

fn click(
    observation: &isolated_browser::Observation,
    call: &str,
    name: &str,
) -> isolated_browser::ActionInput {
    let element = observation
        .elements
        .iter()
        .find(|element| element.name.as_str() == Some(name))
        .unwrap_or_else(|| panic!("missing semantic element: {name}"));
    action(
        observation,
        call,
        json!({"type":"click","ref":element.r#ref.to_utf8().unwrap()}),
    )
}

async fn scenarios(harness: Arc<Harness>) {
    let service = harness.service();
    let status = harness.start(&service).await;
    let first = observe(&service, &status).await;
    let navigation = service
        .action(action(
            &first,
            "navigate",
            json!({"type":"navigate","url":format!("{}/next", harness.url)}),
        ))
        .await
        .unwrap();
    assert_eq!(navigation.status, isolated_browser::ActionStatus::Completed);
    assert_eq!(navigation.tab.page.path.as_str(), Some("/next"));
    let observation = observe(&service, &status).await;
    assert!(observation.elements.iter().all(|element| {
        !matches!(
            element.name.as_str(),
            Some("Protected file" | "Protected password")
        )
    }));
    let input = click(&observation, "click-once", "Click once");
    let result = service.action(input.clone()).await.unwrap();
    assert_eq!(result.status, isolated_browser::ActionStatus::Completed);
    assert_eq!(service.action(input.clone()).await.unwrap(), result);
    let mut stale = input;
    stale.call_id = decode(json!("stale"));
    assert!(matches!(service.action(stale).await, Err(Error::Fence(_))));
    let observation = observe(&service, &status).await;
    assert!(
        observation
            .elements
            .iter()
            .any(|element| element.name.as_str() == Some("Clicked 1"))
    );
    let text = observation
        .elements
        .iter()
        .find(|element| element.name.as_str() == Some("Text input"))
        .unwrap();
    assert_eq!(
        service
            .action(action(
                &observation,
                "type",
                json!({"type":"type","ref":text.r#ref.to_utf8().unwrap(),"text":"synthetic input"})
            ))
            .await
            .unwrap()
            .status,
        isolated_browser::ActionStatus::Completed
    );
    let typed = observe(&service, &status).await;
    assert!(
        typed
            .elements
            .iter()
            .any(|element| element.name.as_str() == Some("Typed synthetic input"))
    );
    service.stop(&session()).await.unwrap();
    harness.assert_clean();
    assert!(
        service
            .action(click(&observation, "stopped", "Clicked 1"))
            .await
            .is_err()
    );

    let restarted = harness.start(&service).await;
    assert_ne!(status.instance_id, restarted.instance_id);
    assert!(
        service
            .action(click(&observation, "old-instance", "Clicked 1"))
            .await
            .is_err()
    );
    service.release_session(&session()).await.unwrap();
    assert!(service.list(&session()).unwrap().is_empty());
    harness.assert_clean();
    harness.start(&service).await;
    service.shutdown().await.unwrap();
    assert!(service.status(&session()).await.is_err());
    harness.assert_clean();

    let service = harness.service();
    let status = harness.start(&service).await;
    for iteration in 0..2 {
        let observation = observe(&service, &status).await;
        let result = service
            .action(click(
                &observation,
                &format!("popups-{iteration}"),
                "Open popups",
            ))
            .await
            .unwrap();
        assert_eq!(result.status, isolated_browser::ActionStatus::Rejected);
        assert_eq!(
            result.message.as_ref().and_then(|message| message.as_str()),
            Some("A popup was safely blocked")
        );
        assert_eq!(
            harness.requests.popups.load(Ordering::SeqCst),
            0,
            "popup document reached the server"
        );
        assert_eq!(service.list(&session()).unwrap().len(), 1);
    }
    let observation = observe(&service, &status).await;
    let result = service
        .action(click(&observation, "popup-link", "Popup link"))
        .await
        .unwrap();
    assert_eq!(result.status, isolated_browser::ActionStatus::Rejected);
    let observation = observe(&service, &status).await;
    let result = service
        .action(click(&observation, "clipboard", "Try clipboard"))
        .await
        .unwrap();
    assert_eq!(result.status, isolated_browser::ActionStatus::Completed);
    let observation = observe(&service, &status).await;
    assert!(
        observation
            .elements
            .iter()
            .any(|element| element.name.as_str() == Some("read-denied write-denied"))
    );
    let result = service
        .action(click(&observation, "opener-responsive", "Click once"))
        .await
        .unwrap();
    assert_eq!(result.status, isolated_browser::ActionStatus::Completed);
    let observation = observe(&service, &status).await;
    assert!(
        observation
            .elements
            .iter()
            .any(|element| element.name.as_str() == Some("Clicked 1"))
    );
    let positive = service
        .action(action(
            &observation,
            "popup-positive-control",
            json!({"type":"navigate","url":format!("{}/popup", harness.url)}),
        ))
        .await
        .unwrap();
    assert_eq!(positive.status, isolated_browser::ActionStatus::Completed);
    assert_eq!(harness.requests.popups.load(Ordering::SeqCst), 1);
    service.stop(&session()).await.unwrap();
    harness.assert_clean();

    let status = harness.start(&service).await;
    let observation = observe(&service, &status).await;
    let input = click(&observation, "file-picker", "Choose file");
    let result = service.action(input.clone()).await.unwrap();
    assert_eq!(result.status, isolated_browser::ActionStatus::Uncertain);
    assert_eq!(
        result.message.as_ref().and_then(|message| message.as_str()),
        Some("File selection is unsupported")
    );
    assert_eq!(service.action(input).await.unwrap(), result);
    assert!(service.control(&session(), true).await.is_err());
    service.stop(&session()).await.unwrap();
    harness.assert_clean();

    let status = harness.start(&service).await;
    let observation = observe(&service, &status).await;
    let input = click(&observation, "uncertain", "Send effect");
    let pending = tokio::spawn({
        let service = service.clone();
        let input = input.clone();
        async move { service.action(input).await }
    });
    tokio::time::timeout(
        Duration::from_secs(2),
        harness.requests.effect_received.notified(),
    )
    .await
    .expect("the real website must acknowledge the dispatched mutation");
    let groups = harness.groups.lock().unwrap().clone();
    let browser = processes()
        .into_iter()
        .find(|(pid, group, command)| {
            pid == group && groups.contains(group) && command.contains("--headless=new")
        })
        .expect("the owned Chrome process must still be live");
    assert!(
        Command::new("/bin/kill")
            .args(["-STOP", "--", &browser.0.to_string()])
            .status()
            .unwrap()
            .success()
    );
    harness.requests.effect_release.notify_one();
    let result = pending.await.unwrap().unwrap();
    assert_eq!(
        harness.requests.effects.load(Ordering::SeqCst),
        1,
        "real website effect must precede uncertainty"
    );
    assert_eq!(result.status, isolated_browser::ActionStatus::Uncertain);
    assert_eq!(service.action(input).await.unwrap(), result);
    assert_eq!(
        harness.requests.effects.load(Ordering::SeqCst),
        1,
        "uncertain mutation was replayed"
    );
    service.stop(&session()).await.unwrap();
    harness.assert_clean();
}

#[tokio::test]
async fn real_chrome_lifetime_semantics_restrictions_and_uncertain_settlement() {
    let selected = std::env::var_os("YCODING_TEST_ISOLATED_BROWSER_CHROME")
        .expect("browser_native_integration requires YCODING_TEST_ISOLATED_BROWSER_CHROME set to the installed Google Chrome executable (>=152)");
    assert_eq!(
        std::fs::canonicalize(selected)
            .expect("YCODING_TEST_ISOLATED_BROWSER_CHROME is unavailable"),
        std::fs::canonicalize(CHROME).expect("installed Google Chrome is unavailable"),
        "Rust uses the installed Chrome path; the explicit test executable must match it"
    );
    let availability = ycoding_core::platform::browser::chrome::installed_availability().await;
    assert!(
        availability.available,
        "required Chrome unavailable: {:?}",
        availability.reason
    );
    let requests = Arc::new(Requests::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let harness = Arc::new(Harness {
        url: format!("http://{}", listener.local_addr().unwrap()),
        requests: requests.clone(),
        services: Mutex::new(Vec::new()),
        baseline: profiles(),
        owned: Mutex::new(BTreeSet::new()),
        groups: Mutex::new(BTreeSet::new()),
    });
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/", get(|| async { Html(PAGE) }))
                .route("/next", get(|| async { Html(PAGE) }))
                .route(
                    "/popup",
                    get(|State(state): State<Arc<Requests>>| async move {
                        state.popups.fetch_add(1, Ordering::SeqCst);
                        Html("<!doctype html><title>Popup positive control</title>")
                    }),
                )
                .route(
                    "/effect",
                    get(|State(state): State<Arc<Requests>>| async move {
                        state.effects.fetch_add(1, Ordering::SeqCst);
                        state.effect_received.notify_one();
                        state.effect_release.notified().await;
                        "acknowledged"
                    }),
                )
                .with_state(requests),
        )
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
    });
    let outcome = tokio::spawn(scenarios(harness.clone())).await;
    harness.requests.effect_release.notify_one();
    let services = harness.services.lock().unwrap().clone();
    for service in services {
        service.shutdown().await.unwrap();
    }
    stop.send(()).unwrap();
    server.await.unwrap();
    harness.assert_clean();
    if let Err(failure) = outcome {
        std::panic::resume_unwind(failure.into_panic());
    }
}
