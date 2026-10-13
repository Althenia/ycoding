use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};
use ycoding_core::resources::discovery::wellknown::{self, Service};
use ycoding_schema::{parse_json, stringify_json};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Server {
    origin: String,
    manifest: Arc<Mutex<String>>,
    requests: Arc<Mutex<Vec<String>>>,
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}
impl Server {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let manifest = Arc::new(Mutex::new(format!(
            r#"{{"auth":{{"command":["login"],"env":"TOKEN"}},"config":{{"model":"embedded/model"}},"remote_config":{{"url":"{origin}/config/{{env:TOKEN}}","headers":{{"authorization":"Bearer {{env:TOKEN}}"}}}}}}"#
        )));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (stop, mut stopped) = oneshot::channel();
        let state = manifest.clone();
        let recorded = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! { _ = &mut stopped => break, accepted = listener.accept() => accepted.unwrap() };
                let (mut socket, _) = accepted;
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let read = socket.read(&mut chunk).await.unwrap();
                    request.extend_from_slice(&chunk[..read]);
                    if read == 0 || request.windows(4).any(|p| p == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                recorded.lock().unwrap().push(request.clone());
                let (status, body) = if request.starts_with("GET /.well-known/ycoding ") {
                    (200, state.lock().unwrap().clone())
                } else if request.starts_with("GET /config/fixture-secret ")
                    && request
                        .to_lowercase()
                        .contains("authorization: bearer fixture-secret")
                {
                    (200, r#"{"config":{"model":"remote/model"}}"#.into())
                } else {
                    (404, "Not found".into())
                };
                socket.write_all(format!("HTTP/1.1 {status} response\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        Self {
            origin,
            manifest,
            requests,
            stop,
            task,
        }
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
    }
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-wellknown-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn store(&self) -> Store {
        Store::initialize(
            self.0.join("resources.redb"),
            Options::core(),
            Catalog::new(1, resources::TABLES),
            Metadata::new([17; 16], 1),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[tokio::test]
async fn wellknown_resolves_embedded_then_remote_configs_with_explicit_variables_before_environment()
 {
    let server = Server::new().await;
    let f = Fixture::new();
    let store = f.store();
    let service = Service::new(
        store.client(),
        BTreeMap::from([("TOKEN".into(), "wrong".into())]),
    )
    .unwrap();
    let entry = service
        .inspect(&format!("{}/", server.origin))
        .await
        .unwrap();
    assert_eq!(entry.integration_id, server.origin);
    assert_eq!(
        entry.manifest.auth.as_ref().unwrap().command,
        vec!["login".into()]
    );
    let configs = service
        .resolve(
            &entry,
            &BTreeMap::from([("TOKEN".into(), "fixture-secret".into())]),
        )
        .await
        .unwrap();
    assert_eq!(
        configs,
        [
            parse_json(r#"{"model":"embedded/model"}"#).unwrap(),
            parse_json(r#"{"model":"remote/model"}"#).unwrap()
        ]
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    assert!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.to_lowercase().contains("accept: application/json"))
    );
    store.shutdown().unwrap();
    server.finish().await;
}

#[tokio::test]
async fn wellknown_persists_sources_caches_entries_refreshes_atomically_and_signals_revisions() {
    let server = Server::new().await;
    let f = Fixture::new();
    let store = f.store();
    let mut service = Service::new(store.client(), BTreeMap::new()).unwrap();
    assert!(!service.refresh().await.unwrap());
    let entry = service
        .add(&format!("{}/", server.origin), 1)
        .await
        .unwrap();
    assert_eq!(service.revision(), 1);
    assert_eq!(service.entries().await.unwrap(), vec![entry]);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(
        stringify_json(
            resources::get_kv(
                &store.client().snapshot().unwrap(),
                &wellknown::SOURCES_KEY.into()
            )
            .unwrap()
            .unwrap()
            .value()
        ),
        format!("[\"{}\"]", server.origin)
    );
    assert!(!service.refresh().await.unwrap());
    assert_eq!(service.revision(), 1);
    *server.manifest.lock().unwrap() = format!(
        r#"{{"remote_config":{{"headers":{{"authorization":"Bearer {{env:TOKEN}}"}},"url":"{}/config/{{env:TOKEN}}"}},"config":{{"model":"embedded/model"}},"auth":{{"env":"TOKEN","command":["login"]}}}}"#,
        server.origin
    );
    assert!(!service.refresh().await.unwrap());
    assert_eq!(service.revision(), 1);
    *server.manifest.lock().unwrap() = r#"{"auth":{"command":["second"],"env":"TOKEN"}}"#.into();
    assert!(service.refresh().await.unwrap());
    assert_eq!(service.revision(), 2);
    assert_eq!(
        service.snapshot()[0]
            .manifest
            .auth
            .as_ref()
            .unwrap()
            .command,
        vec!["second".into()]
    );
    *server.manifest.lock().unwrap() = "invalid".into();
    assert!(service.refresh().await.is_err());
    assert_eq!(service.revision(), 2);
    assert_eq!(
        service.snapshot()[0]
            .manifest
            .auth
            .as_ref()
            .unwrap()
            .command,
        vec!["second".into()]
    );
    *server.manifest.lock().unwrap() = r#"{"config":{"model":"no-auth/model"}}"#.into();
    assert!(service.add(&server.origin, 2).await.is_err());
    assert_eq!(service.revision(), 2);
    let mut rehydrated = Service::new(store.client(), BTreeMap::new()).unwrap();
    assert_eq!(rehydrated.entries().await.unwrap()[0].origin, server.origin);
    service.remove(&server.origin, 3).await.unwrap();
    assert_eq!(service.revision(), 3);
    assert!(service.entries().await.unwrap().is_empty());
    assert!(service.snapshot().is_empty());
    store.shutdown().unwrap();
    server.finish().await;
}

#[tokio::test]
async fn wellknown_rejects_executable_configuration_with_the_config_diagnostic() {
    let server = Server::new().await;
    let f = Fixture::new();
    let store = f.store();
    let service = Service::new(store.client(), BTreeMap::new()).unwrap();
    *server.manifest.lock().unwrap() =
        r#"{"config":{"plugins":["file:///plugin.js"],"model":"other/model"}}"#.into();
    let entry = service.inspect(&server.origin).await.unwrap();
    let error = service.resolve(&entry, &BTreeMap::new()).await.unwrap_err();
    let expected = ycoding_core::resources::config::decode_document(
        r#"{"plugins":["file:///plugin.js"],"model":"other/model"}"#,
        &server.origin,
    );
    assert!(
        error
            .to_string()
            .contains(expected.diagnostics[0].message.as_str().unwrap())
    );
    store.shutdown().unwrap();
    server.finish().await;
}

#[tokio::test]
async fn wellknown_remote_headers_are_case_insensitive_last_write_wins_and_override_accept() {
    let server = Server::new().await;
    let f = Fixture::new();
    let store = f.store();
    let service = Service::new(store.client(), BTreeMap::new()).unwrap();
    *server.manifest.lock().unwrap() = format!(
        r#"{{"remote_config":{{"url":"{}/config/fixture-secret","headers":{{"authorization":"wrong","Authorization":"Bearer fixture-secret","Accept":"text/plain"}}}}}}"#,
        server.origin
    );
    let entry = service.inspect(&server.origin).await.unwrap();
    let result = service.resolve(&entry, &BTreeMap::new()).await.unwrap();
    assert_eq!(result, [parse_json(r#"{"model":"remote/model"}"#).unwrap()]);
    let request = server.requests.lock().unwrap()[1].to_lowercase();
    assert_eq!(request.matches("authorization:").count(), 1);
    assert!(request.contains("authorization: bearer fixture-secret\r\n"));
    assert_eq!(request.matches("accept:").count(), 1);
    assert!(request.contains("accept: text/plain\r\n"));
    store.shutdown().unwrap();
    server.finish().await;
}

#[tokio::test]
async fn wellknown_refresh_preserves_null_presence_and_json_semantic_equality() {
    let server = Server::new().await;
    let f = Fixture::new();
    let store = f.store();
    let mut service = Service::new(store.client(), BTreeMap::new()).unwrap();
    *server.manifest.lock().unwrap() =
        r#"{"auth":{"command":[],"env":""},"config":{"value":0,"nested":{"a":1,"b":2}}}"#.into();
    service.add(&server.origin, 1).await.unwrap();
    *server.manifest.lock().unwrap() =
        r#"{"config":{"nested":{"b":2,"a":1},"value":0},"auth":{"env":"","command":[]}}"#.into();
    assert!(!service.refresh().await.unwrap());
    *server.manifest.lock().unwrap() =
        r#"{"auth":{"command":[],"env":""},"config":{"value":-0,"nested":{"a":1,"b":2}}}"#.into();
    assert!(service.refresh().await.unwrap());
    *server.manifest.lock().unwrap() = r#"{"auth":{"command":[],"env":""}}"#.into();
    assert!(service.refresh().await.unwrap());
    *server.manifest.lock().unwrap() = r#"{"auth":{"command":[],"env":""},"config":null}"#.into();
    assert!(service.refresh().await.unwrap());
    assert!(
        service
            .resolve(&service.snapshot()[0], &BTreeMap::new())
            .await
            .unwrap()
            .is_empty()
    );
    store.shutdown().unwrap();
    server.finish().await;
}
