use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use ycoding_core::{
    platform::browser::{
        admission::{Admission, Mode},
        bridge::Transport,
        protocol,
        service::{Options, Service},
    },
    resources::credential,
};
use ycoding_schema::{DomainEncode, JsonValue, browser, session_id::SessionId, stringify_json};
use ycoding_store::{Catalog, Metadata, Store, resources};

const ID: &str = "abcdefghijklmnopabcdefghijklmnop";
static NEXT: AtomicU64 = AtomicU64::new(0);
#[derive(Default)]
struct Extension {
    frames: Mutex<Vec<Value>>,
    closes: Mutex<Vec<(u16, String)>>,
    full: AtomicBool,
}
impl Transport for Extension {
    fn send(&self, value: JsonValue) -> bool {
        self.frames
            .lock()
            .unwrap()
            .push(serde_json::from_str(&stringify_json(&value)).unwrap());
        !self.full.load(Ordering::Relaxed)
    }
    fn close(&self, code: u16, reason: &str) {
        self.closes.lock().unwrap().push((code, reason.into()));
    }
}
fn frame(value: Value) -> protocol::ClientMessage {
    protocol::decode_client(value.to_string().as_bytes()).unwrap()
}
fn session() -> SessionId {
    SessionId::new("ses_bootstrap").unwrap()
}
fn options() -> Options {
    Options {
        pairing_ttl: Duration::from_secs(120),
        command_timeout: Duration::from_secs(1),
    }
}
fn store() -> (Store, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "ycoding-browser-auth-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::initialize(
        root.join("store.redb"),
        ycoding_store::Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([13; 16], 1),
    )
    .unwrap();
    (store, root)
}
fn pair(secret: &str) -> protocol::ClientMessage {
    frame(json!({"type":"pair","version":4,"extensionID":ID,"secret":secret}))
}
fn auth(response: &Value) -> protocol::ClientMessage {
    frame(
        json!({"type":"authenticate","version":4,"extensionID":ID,"serverID":response["serverID"],"credential":response["credential"]}),
    )
}

#[tokio::test]
async fn same_session_repair_retains_admission_and_bridge_stop_allows_trusted_reattach() {
    let (store, root) = store();
    let credentials = credential::Service::new(store.client());
    let admission = Arc::new(Admission::default());
    let service = Service::new(
        credentials.clone(),
        admission.clone(),
        Arc::new(|_| true),
        options(),
    );
    let extension = Arc::new(Extension::default());
    let pairing = service.start(&session()).await.unwrap();
    let attached = service
        .attach(
            &format!("chrome-extension://{ID}"),
            pair(pairing.secret.as_str().unwrap()),
            extension.clone(),
        )
        .await
        .unwrap();
    let response = extension.frames.lock().unwrap()[0].clone();
    service
        .bridge()
        .unwrap()
        .stop(&SessionId::new("ses_other").unwrap())
        .unwrap();
    assert_eq!(admission.current("ses_bootstrap"), None);
    let reattached = service
        .attach(
            &format!("chrome-extension://{ID}"),
            auth(&response),
            extension.clone(),
        )
        .await
        .unwrap();
    service.start(&session()).await.unwrap();
    assert_eq!(admission.current("ses_bootstrap"), Some(Mode::Selected));
    assert_eq!(
        service.status(&session()).unwrap().state,
        browser::BridgeState::Pairing
    );
    attached.detach();
    reattached.detach();
    service.shutdown();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn one_time_pairing_is_origin_bound_and_persists_only_digest_for_restart() {
    let (store, root) = store();
    let credentials = credential::Service::new(store.client());
    let admission = Arc::new(Admission::default());
    let service = Service::new(
        credentials.clone(),
        admission.clone(),
        Arc::new(|_| true),
        options(),
    );
    let pairing = service.start(&session()).await.unwrap();
    let extension = Arc::new(Extension::default());
    assert!(
        service
            .attach(
                "https://example.test",
                pair(pairing.secret.as_str().unwrap()),
                extension.clone()
            )
            .await
            .is_err()
    );
    let attachment = service
        .attach(
            &format!("chrome-extension://{ID}"),
            pair(pairing.secret.as_str().unwrap()),
            extension.clone(),
        )
        .await
        .unwrap();
    let response = extension.frames.lock().unwrap()[0].clone();
    assert_eq!(response["version"], 4);
    assert_eq!(response["generation"], 1);
    assert!(
        service
            .attach(
                &format!("chrome-extension://{ID}"),
                pair(pairing.secret.as_str().unwrap()),
                extension.clone()
            )
            .await
            .is_err()
    );
    attachment
        .receive(frame(json!({"type":"profile_access","enabled":true})))
        .await
        .unwrap();
    attachment.receive(frame(json!({"type":"shared","mode":"profile","tabID":"btab_test","title":"Page","url":"https://example.test/form","documentGeneration":1,"active":false}))).await.unwrap();
    assert_eq!(service.bridge().unwrap().list(&session()).unwrap().len(), 1);
    let persisted = credentials.list(&"ycoding.browser".into()).unwrap();
    assert_eq!(persisted.len(), 1);
    let value = persisted[0].secret().domain().unwrap();
    let ycoding_schema::credential::Value::Key(key) = value else {
        panic!()
    };
    assert_eq!(key.key.len(), 64);
    assert!(
        !stringify_json(&persisted[0].secret().domain().unwrap().encode())
            .contains(response["credential"].as_str().unwrap())
    );
    attachment.detach();
    service.shutdown();
    credentials.shutdown().await.unwrap();
    drop(service);
    drop(attachment);
    drop(credentials);
    store.shutdown().unwrap();
    let store = Store::open(
        root.join("store.redb"),
        ycoding_store::Options::core(),
        Catalog::new(1, resources::TABLES),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let service = Service::new(
        credentials.clone(),
        Arc::new(Admission::default()),
        Arc::new(|_| false),
        options(),
    );
    let extension = Arc::new(Extension::default());
    let attachment = service
        .attach(
            &format!("chrome-extension://{ID}"),
            auth(&response),
            extension.clone(),
        )
        .await
        .unwrap();
    assert!(
        extension.frames.lock().unwrap()[0]
            .get("credential")
            .is_none()
    );
    assert!(service.bridge().unwrap().list(&session()).is_err());
    attachment.detach();
    service.shutdown();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn trust_survives_stop_and_isolated_rejection_but_forget_revokes_it() {
    let (store, root) = store();
    let credentials = credential::Service::new(store.client());
    let admission = Arc::new(Admission::default());
    let service = Service::new(
        credentials.clone(),
        admission.clone(),
        Arc::new(|_| true),
        options(),
    );
    let pairing = service.start(&session()).await.unwrap();
    let extension = Arc::new(Extension::default());
    let attachment = service
        .attach(
            &format!("chrome-extension://{ID}"),
            pair(pairing.secret.as_str().unwrap()),
            extension.clone(),
        )
        .await
        .unwrap();
    let response = extension.frames.lock().unwrap()[0].clone();
    service.stop(&session()).unwrap();
    assert_eq!(service.status(&session()).unwrap().paired, Some(true));
    assert!(admission.claim("ses_bootstrap", Mode::Isolated));
    assert!(service.start(&session()).await.is_err());
    assert!(
        service
            .attach(
                &format!("chrome-extension://{ID}"),
                auth(&response),
                extension.clone()
            )
            .await
            .is_err()
    );
    assert_eq!(
        credentials.list(&"ycoding.browser".into()).unwrap().len(),
        1
    );
    admission.release("ses_bootstrap", Mode::Isolated);
    let next = service
        .attach(
            &format!("chrome-extension://{ID}"),
            auth(&response),
            extension.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        extension.frames.lock().unwrap().last().unwrap()["generation"],
        2
    );
    attachment
        .receive(frame(json!({"type":"forget"})))
        .await
        .unwrap();
    assert_eq!(
        credentials.list(&"ycoding.browser".into()).unwrap().len(),
        1
    );
    next.receive(frame(json!({"type":"forget"}))).await.unwrap();
    assert!(
        credentials
            .list(&"ycoding.browser".into())
            .unwrap()
            .is_empty()
    );
    assert!(
        service
            .attach(
                &format!("chrome-extension://{ID}"),
                auth(&response),
                extension
            )
            .await
            .is_err()
    );
    service.shutdown();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn pairing_attempt_limit_expiry_and_session_switch_disarm_prior_grant() {
    let (store, root) = store();
    let credentials = credential::Service::new(store.client());
    let admission = Arc::new(Admission::default());
    let service = Service::new(
        credentials.clone(),
        admission.clone(),
        Arc::new(|_| true),
        options(),
    );
    let extension = Arc::new(Extension::default());
    let pairing = service.start(&session()).await.unwrap();
    for _ in 0..5 {
        assert!(
            service
                .attach(
                    &format!("chrome-extension://{ID}"),
                    pair(&"x".repeat(43)),
                    extension.clone()
                )
                .await
                .is_err()
        );
    }
    assert!(
        service
            .attach(
                &format!("chrome-extension://{ID}"),
                pair(pairing.secret.as_str().unwrap()),
                extension.clone()
            )
            .await
            .is_err()
    );
    let pairing = service.start(&session()).await.unwrap();
    let attachment = service
        .attach(
            &format!("chrome-extension://{ID}"),
            pair(pairing.secret.as_str().unwrap()),
            extension.clone(),
        )
        .await
        .unwrap();
    let response = extension.frames.lock().unwrap()[0].clone();
    let other = SessionId::new("ses_other").unwrap();
    service.start(&other).await.unwrap();
    assert_eq!(
        extension.closes.lock().unwrap().last().unwrap(),
        &(1000, "pairing switched".into())
    );
    assert!(
        service
            .attach(
                &format!("chrome-extension://{ID}"),
                auth(&response),
                extension.clone()
            )
            .await
            .is_err()
    );
    assert_eq!(admission.current("ses_bootstrap"), None);
    attachment.detach();
    service.shutdown();
    let service = Service::new(
        credentials.clone(),
        admission.clone(),
        Arc::new(|_| true),
        Options {
            pairing_ttl: Duration::ZERO,
            ..options()
        },
    );
    service.start(&session()).await.unwrap();
    assert_eq!(
        service.status(&session()).unwrap().state,
        browser::BridgeState::Unavailable
    );
    assert_eq!(admission.current("ses_bootstrap"), None);
    service.shutdown();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
