use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_core::resources::catalog::models_dev::{Error, Options, Service};
use ycoding_schema::parse_json;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-catalog-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn options(&self) -> Options {
        Options {
            source: "http://127.0.0.1:1".into(),
            cache: self.0.join("models.json"),
            file: None,
            bundled: Some(
                parse_json(include_str!(
                    "../../../../packages/core/test/plugin/fixtures/models-dev.json"
                ))
                .unwrap(),
            ),
            fetch: false,
            user_agent: "ycoding/test/test/cli".into(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[tokio::test]
async fn disk_precedes_bundle_memory_cache_is_stable_and_offline_invalid_source_is_empty() {
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("models.json"), "{}").unwrap();
    let service = Service::new(fixture.options()).unwrap();
    assert!(service.get().await.unwrap().is_empty());
    std::fs::write(fixture.0.join("models.json"), "invalid").unwrap();
    assert!(service.get().await.unwrap().is_empty());
    let mut options = fixture.options();
    options.bundled = None;
    let service = Service::new(options).unwrap();
    assert!(service.get().await.unwrap().is_empty());
    assert!(!fixture.0.join("models.json").exists());
    let mut options = fixture.options();
    options.file = Some(fixture.0.join("explicit.json"));
    std::fs::write(options.file.as_ref().unwrap(), "{}").unwrap();
    assert!(
        Service::new(options)
            .unwrap()
            .get()
            .await
            .unwrap()
            .is_empty()
    );
    assert!(fixture.0.join("explicit.json").exists());
}

#[tokio::test]
async fn models_dev_retries_only_transient_responses_and_preserves_valid_cache_on_failure() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for (status, body) in [(503, "temporary"), (429, "limited"), (200, "{}")] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let read = socket.read(&mut bytes).await.unwrap();
            assert!(read > 0);
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let mut options = fixture.options();
    options.source = endpoint;
    assert!(Service::new(options).unwrap().refresh(true).await.unwrap());
    server.await.unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.0.join("models.json")).unwrap(),
        "{}"
    );
}

#[tokio::test]
async fn cache_cleanup_failure_does_not_delete_directories_or_block_bundled_loading() {
    let fixture = Fixture::new();
    let mut options = fixture.options();
    options.cache = fixture.0.clone();
    let service = Service::new(options).unwrap();
    assert!(!service.get().await.unwrap().is_empty());
    assert_eq!(service.cleanup_error(), Some(Error::Storage));
    assert!(fixture.0.is_dir());
}

#[tokio::test]
async fn refresh_invalidates_memory_but_preserves_explicit_file_priority() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let read = socket.read(&mut bytes).await.unwrap();
        assert!(read > 0);
        let body = include_str!("../../../../packages/core/test/plugin/fixtures/models-dev.json");
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let mut options = fixture.options();
    options.source = endpoint;
    options.file = Some(fixture.0.join("explicit.json"));
    std::fs::write(options.file.as_ref().unwrap(), "{}").unwrap();
    let service = Service::new(options).unwrap();
    assert!(service.get().await.unwrap().is_empty());
    assert!(service.refresh(true).await.unwrap());
    assert!(service.get().await.unwrap().is_empty());
    server.await.unwrap();
}

#[tokio::test]
async fn retry_exhaustion_and_permanent_status_leave_existing_cache_unchanged() {
    for statuses in [vec![503, 503, 503], vec![501]] {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("models.json"), "{}").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let expected = statuses.len();
        let (done, mut finished) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut count = 0;
            loop {
                tokio::select! { biased; _ = &mut finished => return count,accepted = listener.accept() => { let (mut socket,_) = accepted.unwrap(); let mut bytes = vec![0;4096]; assert!(socket.read(&mut bytes).await.unwrap() > 0); let status = statuses.get(count).copied().unwrap_or(200); count += 1; socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").as_bytes()).await.unwrap(); } }
            }
        });
        let mut options = fixture.options();
        options.source = endpoint;
        let service = Service::new(options).unwrap();
        assert!(service.get().await.unwrap().is_empty());
        assert_eq!(service.refresh(true).await.unwrap_err(), Error::Request);
        done.send(()).unwrap();
        assert_eq!(server.await.unwrap(), expected);
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("models.json")).unwrap(),
            "{}"
        );
        assert!(service.get().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn forced_refresh_writes_atomic_cache_invalidates_snapshot_and_rejects_invalid_payload() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for body in ["{}", "invalid"] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let read = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8(bytes[..read].to_vec()).unwrap();
            assert!(request.starts_with("GET /api.json HTTP/1.1"));
            assert!(
                request
                    .to_lowercase()
                    .contains("user-agent: ycoding/test/test/cli")
            );
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let mut options = fixture.options();
    options.source = format!("http://{address}");
    let service = Service::new(options).unwrap();
    assert!(!service.get().await.unwrap().is_empty());
    assert!(service.refresh(true).await.unwrap());
    assert!(service.get().await.unwrap().is_empty());
    assert!(!service.refresh(false).await.unwrap());
    assert_eq!(
        service.refresh(true).await.unwrap_err(),
        Error::InvalidSource
    );
    assert_eq!(
        std::fs::read_to_string(fixture.0.join("models.json")).unwrap(),
        "{}"
    );
    assert!(service.get().await.unwrap().is_empty());
    server.await.unwrap();
}

#[tokio::test]
async fn background_refresh_publishes_revision_and_has_owned_shutdown() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut options = fixture.options();
    options.fetch = true;
    options.source = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let size = socket.read(&mut bytes).await.unwrap();
        assert!(bytes[..size].starts_with(b"GET /api.json HTTP/1.1"));
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            .await
            .unwrap();
    });
    let service = std::sync::Arc::new(Service::new(options).unwrap());
    let mut revisions = service.refreshed();
    let worker = service.start().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), revisions.changed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*revisions.borrow(), 1);
    assert_eq!(worker.last_error(), None);
    assert!(service.get().await.unwrap().is_empty());
    worker.shutdown().await.unwrap();
    server.await.unwrap();
    let service = std::sync::Arc::new(Service::new(fixture.options()).unwrap());
    assert!(service.start().is_none());
    assert_eq!(
        ycoding_core::resources::catalog::models_dev::cache_path(
            std::path::Path::new("."),
            "https://models.dev"
        ),
        std::path::PathBuf::from("./models.json")
    );
}
