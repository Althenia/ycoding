use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_core::resources::{
    auth::{Client, claude, cursor, google},
    credential::Error,
};

struct Fixture {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn new(responses: Vec<Option<String>>) -> Self {
        Self::responses(
            responses
                .into_iter()
                .map(|response| response.map(|body| (200, body)))
                .collect(),
        )
    }
    fn responses(responses: Vec<Option<(u16, String)>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let worker = std::thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).unwrap();
                    bytes.extend_from_slice(&buffer[..count]);
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|value| value.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                    if count == 0 {
                        break;
                    }
                }
                observed
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(bytes).unwrap());
                if let Some((status, body)) = response {
                    write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nMetadata-Flavor: Google\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
            }
        });
        Self {
            endpoint,
            requests,
            worker: Some(worker),
        }
    }
    fn finish(&mut self) {
        self.worker.take().unwrap().join().unwrap();
    }
}
static NEXT: AtomicU64 = AtomicU64::new(0);

fn root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "ycoding-auth2-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}
const SOURCE: &str = "11111111-1111-4111-8111-111111111111";
fn credentials(expires: i64) -> claude::Credentials {
    claude::Credentials {
        access_token: "fixture-access".into(),
        refresh_token: "fixture-refresh".into(),
        expires_at: expires,
        subscription_type: Some("max".into()),
    }
}
fn profile(root: &std::path::Path, expires: i64) -> PathBuf {
    let directory = claude::profile_directory(root, SOURCE).unwrap();
    std::fs::create_dir_all(&directory).unwrap();
    let file = directory.join(".credentials.json");
    std::fs::write(&file, serde_json::json!({"claudeAiOauth":{"accessToken":"fixture-access","refreshToken":"fixture-refresh","expiresAt":expires,"subscriptionType":"max"},"other":{"keep":true}}).to_string()).unwrap();
    file
}

#[test]
fn managed_paths_nfc_identity_and_redacted_parser() {
    assert_eq!(
        claude::keychain_service(&PathBuf::from("/fixture/Cafe\u{301}/profile")).unwrap(),
        claude::keychain_service(&PathBuf::from("/fixture/Café/profile")).unwrap()
    );
    for value in [
        "../other",
        "file",
        "00000000-0000-0000-0000-000000000000",
        "11111111-1111-0111-8111-111111111111",
    ] {
        assert!(claude::profile_directory(&PathBuf::from("/fixture"), value).is_err());
    }
    assert!(claude::profile_directory(&PathBuf::from("relative"), SOURCE).is_err());
    let value = claude::Credentials::parse(
        r#"{"claudeAiOauth":{"accessToken":"fixture-access","refreshToken":"","expiresAt":12.9}}"#,
    )
    .unwrap();
    assert_eq!(value.expires_at, 12);
    for raw in [
        r#"{"mcpOAuth":{}}"#,
        r#"{"accessToken":" ","refreshToken":"r","expiresAt":1}"#,
        "[]",
    ] {
        assert!(claude::Credentials::parse(raw).is_none());
    }
    assert!(!format!("{value:?}").contains("fixture"));
    let update = claude::keychain_update("service\\\"", "account\"", "fixture-access");
    assert!(!update.contains("fixture-access"));
    assert!(update.contains("-U -X 666978747572652d616363657373\n"));
}

#[tokio::test]
async fn managed_file_writes_preserve_metadata_permissions_and_reject_symlinks() {
    let root = root();
    let file = profile(&root, 100);
    let source = claude::Source::new(root.clone(), None).unwrap();
    let accounts = source.list().await.unwrap();
    assert_eq!(accounts[0].label, "Claude Max");
    assert_eq!(accounts[0].source, SOURCE);
    let mut next = credentials(200);
    next.access_token = "rotated".into();
    assert!(source.write(SOURCE, &next).await.unwrap());
    let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(raw["other"]["keep"], true);
    assert_eq!(raw["claudeAiOauth"]["accessToken"], "rotated");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::rename(&file, root.join("saved")).unwrap();
        symlink(root.join("saved"), &file).unwrap();
        assert!(source.read(SOURCE).await.unwrap().is_none());
        assert!(!source.write(SOURCE, &next).await.unwrap());
    }
    std::fs::remove_dir_all(root).unwrap();
}

struct KeychainFixture {
    value: Option<String>,
    reads: Mutex<Vec<String>>,
    writes: Mutex<Vec<String>>,
}
impl claude::Keychain for KeychainFixture {
    fn read<'a>(
        &'a self,
        service: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<String>, Error>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.reads.lock().unwrap().push(service.into());
            Ok(self.value.clone())
        })
    }
    fn write<'a>(
        &'a self,
        _: &'a str,
        raw: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, Error>> + Send + 'a>> {
        Box::pin(async move {
            self.writes.lock().unwrap().push(raw.into());
            Ok(true)
        })
    }
}
#[tokio::test]
async fn exact_keychain_service_missing_only_file_fallback() {
    let root = root();
    let file = profile(&root, 100);
    let keychain = Arc::new(KeychainFixture {
        value: None,
        reads: Mutex::new(Vec::new()),
        writes: Mutex::new(Vec::new()),
    });
    let source = claude::Source::new(root.clone(), Some(keychain.clone())).unwrap();
    assert!(source.read(SOURCE).await.unwrap().is_some());
    assert_eq!(
        keychain.reads.lock().unwrap().as_slice(),
        &[claude::keychain_service(file.parent().unwrap()).unwrap()]
    );
    let keychain = Arc::new(KeychainFixture {
        value: Some("invalid".into()),
        reads: Mutex::new(Vec::new()),
        writes: Mutex::new(Vec::new()),
    });
    assert!(
        claude::Source::new(root.clone(), Some(keychain))
            .unwrap()
            .read(SOURCE)
            .await
            .unwrap()
            .is_none()
    );
    let keychain = Arc::new(KeychainFixture {
        value: Some(std::fs::read_to_string(&file).unwrap()),
        reads: Mutex::new(Vec::new()),
        writes: Mutex::new(Vec::new()),
    });
    assert!(
        claude::Source::new(root.clone(), Some(keychain.clone()))
            .unwrap()
            .write(SOURCE, &credentials(300))
            .await
            .unwrap()
    );
    assert_eq!(keychain.writes.lock().unwrap().len(), 1);
    assert_eq!(
        claude::Credentials::parse(&std::fs::read_to_string(file).unwrap())
            .unwrap()
            .expires_at,
        100
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn managed_cli_isolates_environment_submits_once_and_reads_fresh_profile() {
    let root = root();
    let script = r#"import os,json,time,sys
assert not any(k.startswith(('ANTHROPIC_','CLAUDE_CODE_','AWS_','GOOGLE_','AZURE_','CLAUDE_PROFILE','CLAUDE_AUTH','CLAUDE_BEDROCK','CLAUDE_VERTEX','CLAUDE_FOUNDRY')) or k=='CLAUDE_SECURESTORAGE_CONFIG_DIR' for k in os.environ)
print("If the browser didn't open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?state=fixture\x07label\x1b]8;;\x07",flush=True)
assert sys.stdin.readline() == 'code#state\n'
with open(os.path.join(os.environ['CLAUDE_CONFIG_DIR'],'.credentials.json'),'w') as f:
 json.dump({'claudeAiOauth':{'accessToken':'fixture-token','refreshToken':'fixture-refresh','expiresAt':int(time.time()*1000)+3600000}},f)
"#;
    let source = claude::Source::new(root.clone(), None).unwrap();
    let mut attempt = claude::Enrollment::start(
        source,
        &["/usr/bin/python3".into(), "-c".into(), script.into()],
        &BTreeMap::from([
            ("AWS_PROFILE".into(), "poison".into()),
            ("ANTHROPIC_API_KEY".into(), "poison".into()),
            ("CLAUDE_SECURESTORAGE_CONFIG_DIR".into(), "poison".into()),
        ]),
    )
    .await
    .unwrap();
    assert_eq!(
        attempt.url,
        "https://claude.com/cai/oauth/authorize?state=fixture"
    );
    assert!(attempt.submit_code("bad\ncode").await.is_err());
    attempt.submit_code("code#state").await.unwrap();
    assert!(attempt.submit_code("second").await.is_err());
    assert_eq!(attempt.wait().await.unwrap().access_token, "fixture-token");
    assert_eq!(
        attempt.status(),
        ycoding_core::resources::auth::Status::Complete
    );
    assert!(claude::managed_secret(&attempt.source).is_ok());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn managed_cli_rejects_foreign_url_empty_store_and_nonzero_exit() {
    let root = root();
    for (url, exit) in [
        ("https://foreign.invalid/callback", 0),
        ("https://claude.com/callback", 0),
        ("https://claude.com/callback", 1),
    ] {
        let script = format!(
            "import sys\nprint(\"If the browser didn't open, visit: {url} \",flush=True)\nsys.exit({exit})"
        );
        let result = claude::Enrollment::start(
            claude::Source::new(root.clone(), None).unwrap(),
            &["/usr/bin/python3".into(), "-c".into(), script],
            &BTreeMap::new(),
        )
        .await;
        if let Ok(mut attempt) = result {
            assert!(attempt.wait().await.is_err());
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn registry_managed_cli_enrollment_persists_only_source_and_emits_after_storage() {
    use ycoding_core::resources::{
        auth::integration::{Event, Registry},
        credential::Service,
    };
    use ycoding_store::{Catalog, Metadata, Options, Store, resources};
    let root = root();
    let source = claude::Source::new(root.clone(), None).unwrap();
    let client = Client::new("http://127.0.0.1:1", "fixture").unwrap();
    let managed = claude::Store::new(source.clone(), client.clone());
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([3; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let registry = Registry::new(service.clone(), BTreeMap::new());
    let script = r#"import os,json,time
print("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=fixture ",flush=True)
with open(os.path.join(os.environ['CLAUDE_CONFIG_DIR'],'.credentials.json'),'w') as f:
 json.dump({'accessToken':'fixture-access','refreshToken':'fixture-refresh','expiresAt':int(time.time()*1000)+3600000},f)
"#;
    let implementation = managed.implementation(
        vec!["/usr/bin/python3".into(), "-c".into(), script.into()],
        BTreeMap::new(),
    );
    let registration = registry
        .transform(move |draft| draft.oauth(implementation.clone()))
        .unwrap();
    let mut events = registry.subscribe();
    let attempt = registry
        .connect(
            "anthropic".into(),
            "claude-code".into(),
            ycoding_schema::integration::Inputs(ycoding_schema::JsonObject::new()),
            Some("Work".into()),
            0,
        )
        .await
        .unwrap();
    assert_eq!(attempt.manual_code, Some(true));
    assert_eq!(
        events.recv().await.unwrap(),
        Event::ConnectionUpdated("anthropic".into())
    );
    let selected = service.list(&"anthropic".into()).unwrap().pop().unwrap();
    let value = selected.secret().domain().unwrap();
    assert!(
        matches!(value,ycoding_schema::credential::Value::OAuth(value) if value.access.as_str() == Some(source.list().await.unwrap()[0].source.as_str()) && value.expires.get() == 9_007_199_254_740_991)
    );
    let resolved = client
        .prepare_value(&service, selected, 0, Some(&managed), None)
        .await
        .unwrap();
    assert!(
        matches!(resolved.domain().unwrap(),ycoding_schema::credential::Value::OAuth(value) if value.access.as_str() == Some("fixture-access"))
    );
    registration.dispose().unwrap();
    registry.shutdown().await.unwrap();
    managed.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn managed_refresh_coalesces_and_updates_selected_file() {
    let root = root();
    let file = profile(&root, 0);
    let mut fixture = Fixture::new(vec![Some(
        r#"{"access_token":"rotated","refresh_token":"rotated-refresh","expires_in":3600}"#.into(),
    )]);
    let store = claude::Store::new(
        claude::Source::new(root.clone(), None).unwrap(),
        Client::new(&fixture.endpoint, "fixture").unwrap(),
    );
    let (first, second) = tokio::join!(
        store.resolve(SOURCE, 100, false),
        store.resolve(SOURCE, 100, false)
    );
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(
        store
            .resolve(SOURCE, 200, false)
            .await
            .unwrap()
            .unwrap()
            .access_token,
        "rotated"
    );
    assert_eq!(
        claude::Credentials::parse(&std::fs::read_to_string(file).unwrap())
            .unwrap()
            .refresh_token,
        "rotated-refresh"
    );
    fixture.finish();
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    let request = fixture.requests.lock().unwrap()[0].clone();
    assert!(request.starts_with("POST /v1/oauth/token"));
    assert!(request.contains("grant_type=refresh_token"));
    store.shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn managed_refresh_adopts_a_same_source_rotation_instead_of_overwriting_or_replaying() {
    let root = root();
    let file = profile(&root, 0);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).unwrap() > 0);
        std::fs::write(file,serde_json::json!({"accessToken":"other-process","refreshToken":"other-refresh","expiresAt":9_000_000}).to_string()).unwrap();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        )
        .unwrap();
    });
    let source = claude::Source::new(root.clone(), None).unwrap();
    let store = claude::Store::new(source.clone(), Client::new(&endpoint, "fixture").unwrap());
    let resolved = store.resolve(SOURCE, 100, false).await.unwrap().unwrap();
    assert_eq!(resolved.access_token, "other-process");
    assert_eq!(source.read(SOURCE).await.unwrap().unwrap(), resolved);
    worker.join().unwrap();
    store.shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

fn jwt(expires: i64) -> String {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bytes = format!("{{\"exp\":{expires}}}").into_bytes();
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let bits = chunk
            .iter()
            .fold(0u32, |bits, byte| bits << 8 | u32::from(*byte))
            << (8 * (3 - chunk.len()));
        for shift in (0..chunk.len() + 1).map(|index| 18 - 6 * index) {
            output.push(alphabet[((bits >> shift) & 63) as usize] as char);
        }
    }
    format!("header.{output}.signature")
}

#[tokio::test]
async fn cursor_api_key_cache_coalesces_refreshes_and_passes_through_bearer() {
    let access = jwt(1000);
    let next = jwt(5000);
    let mut fixture = Fixture::new(vec![
        Some(serde_json::json!({"accessToken":access,"refreshToken":"r"}).to_string()),
        Some(serde_json::json!({"accessToken":next,"refreshToken":"r2"}).to_string()),
    ]);
    let store = cursor::Store::new(Client::new(&fixture.endpoint, "fixture").unwrap());
    assert_eq!(
        store
            .resolve(Some("explicit"), Some("crsr_fixture"), 0)
            .await
            .unwrap(),
        "explicit"
    );
    assert_eq!(
        store.resolve(None, Some("issued-jwt"), 0).await.unwrap(),
        "issued-jwt"
    );
    let (first, second) = tokio::join!(
        store.resolve(None, Some("crsr_fixture"), 0),
        store.resolve(None, Some("crsr_fixture"), 0)
    );
    assert_eq!(first.unwrap(), access);
    assert_eq!(second.unwrap(), access);
    assert_eq!(
        store
            .resolve(None, Some("crsr_fixture"), 699_999)
            .await
            .unwrap(),
        access
    );
    assert_eq!(
        store
            .resolve(None, Some("crsr_fixture"), 700_001)
            .await
            .unwrap(),
        next
    );
    fixture.finish();
    let requests = fixture.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("POST /auth/exchange_user_api_key"));
    assert!(
        requests[0]
            .to_ascii_lowercase()
            .contains("authorization: bearer crsr_fixture")
    );
    assert!(requests[1].starts_with("POST /auth/token"));
    assert!(requests[1].contains(r#"{"refreshToken":"r"}"#));
    drop(requests);
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn cursor_unknown_exchange_is_fenced_without_replay() {
    let mut fixture = Fixture::new(vec![None]);
    let store = cursor::Store::new(Client::new(&fixture.endpoint, "fixture").unwrap());
    for _ in 0..2 {
        assert_eq!(
            store
                .resolve(None, Some("crsr_fixture"), 0)
                .await
                .unwrap_err(),
            Error::UnknownOutcome
        );
    }
    fixture.finish();
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn cursor_known_refresh_rejection_can_exchange_again_without_changing_stored_key() {
    let mut fixture = Fixture::responses(vec![
        Some((
            200,
            serde_json::json!({"accessToken":jwt(100),"refreshToken":"r"}).to_string(),
        )),
        Some((401, "{}".into())),
        Some((
            200,
            serde_json::json!({"accessToken":jwt(5000),"refreshToken":"r2"}).to_string(),
        )),
    ]);
    let store = cursor::Store::new(Client::new(&fixture.endpoint, "fixture").unwrap());
    assert_eq!(
        store.resolve(None, Some("crsr_fixture"), 0).await.unwrap(),
        jwt(100)
    );
    assert_eq!(
        store.resolve(None, Some("crsr_fixture"), 1).await.unwrap(),
        jwt(5000)
    );
    fixture.finish();
    assert_eq!(fixture.requests.lock().unwrap().len(), 3);
    store.shutdown().await.unwrap();
}

#[tokio::test]
async fn prepare_managed_profile_resolves_selected_source_before_synchronous_ai_auth() {
    use ycoding_core::resources::credential::Service;
    use ycoding_store::{Catalog, Metadata, Options, Store, resources};
    let root = root();
    profile(&root, 9_000_000);
    let client = Client::new("http://127.0.0.1:1", "fixture").unwrap();
    let managed = claude::Store::new(
        claude::Source::new(root.clone(), None).unwrap(),
        client.clone(),
    );
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([4; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let selected = service
        .create(
            "c".into(),
            "anthropic".into(),
            Some("Work".into()),
            claude::managed_secret(SOURCE).unwrap(),
            0,
        )
        .await
        .unwrap();
    let value = client
        .prepare_value(&service, selected.clone(), 100, Some(&managed), None)
        .await
        .unwrap();
    let ycoding_schema::credential::Value::OAuth(value) = value.domain().unwrap() else {
        panic!()
    };
    assert_eq!(value.access, "fixture-access".into());
    assert_eq!(value.expires.get(), 9_000_000);
    assert_eq!(
        service.get(selected.id()).unwrap().unwrap().secret(),
        selected.secret()
    );
    managed.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn request_preparation_rejects_account_replacement_during_cursor_exchange() {
    use ycoding_core::resources::credential::Service;
    use ycoding_schema::{DomainEncode, credential};
    use ycoding_store::{Catalog, Metadata, Options, Store, resources};
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([6; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let key = resources::Secret::new(
        credential::Value::Key(credential::Key {
            key: "crsr_fixture".into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    let selected = service
        .create(
            "c".into(),
            "cursor".into(),
            Some("Work".into()),
            key.clone(),
            0,
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        assert!(stream.read(&mut request).unwrap() > 0);
        started.send(()).unwrap();
        blocked
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let body =
            serde_json::json!({"accessToken":jwt(1000),"refreshToken":"refresh"}).to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });
    let client = Client::new(&endpoint, "fixture").unwrap();
    let cursor = cursor::Store::new(client.clone());
    let auth = client.clone();
    let credentials = service.clone();
    let resolving = cursor.clone();
    let task = tokio::spawn(async move {
        auth.prepare_value(&credentials, selected, 0, None, Some(&resolving))
            .await
    });
    ready.await.unwrap();
    service
        .create(
            "unused".into(),
            "cursor".into(),
            Some("Work".into()),
            key,
            1,
        )
        .await
        .unwrap();
    release.send(()).unwrap();
    let result = task.await.unwrap();
    worker.join().unwrap();
    assert_eq!(result.unwrap_err(), Error::ProfileUnavailable);
    cursor.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn google_adc_explicit_file_precedes_well_known_and_bad_explicit_is_terminal() {
    let root = root();
    let well_known = root.join(".config/gcloud/application_default_credentials.json");
    std::fs::create_dir_all(well_known.parent().unwrap()).unwrap();
    std::fs::write(&well_known, r#"{"type":"authorized_user","client_id":"well-known","client_secret":"s","refresh_token":"r"}"#).unwrap();
    let explicit = root.join("explicit.json");
    std::fs::write(&explicit, r#"{"type":"authorized_user","client_id":"explicit","client_secret":"s","refresh_token":"r"}"#).unwrap();
    let env = BTreeMap::from([(
        "GOOGLE_APPLICATION_CREDENTIALS".into(),
        explicit.to_str().unwrap().into(),
    )]);
    let discovered = google::discover(&root, &env, false).await.unwrap();
    assert!(!format!("{discovered:?}").contains("explicit"));
    let mut fixture = Fixture::new(vec![Some(
        r#"{"access_token":"google-token","expires_in":3600}"#.into(),
    )]);
    let store = google::Store::new(
        discovered,
        Client::new(&fixture.endpoint, "fixture").unwrap(),
        &fixture.endpoint,
    )
    .unwrap();
    let (first, second) = tokio::join!(store.token(0), store.token(0));
    assert_eq!(first.unwrap(), "google-token");
    assert_eq!(second.unwrap(), "google-token");
    fixture.finish();
    let requests = fixture.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("client_id=explicit"));
    assert!(requests[0].contains("grant_type=refresh_token"));
    drop(requests);
    store.shutdown().await.unwrap();
    std::fs::write(explicit, "invalid").unwrap();
    assert!(google::discover(&root, &env, false).await.is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn google_metadata_uses_flavor_and_expires_refresh_without_file_writes() {
    let mut fixture = Fixture::new(vec![
        Some(r#"{"access_token":"metadata-one","expires_in":3600}"#.into()),
        Some(r#"{"access_token":"metadata-two","expires_in":3600}"#.into()),
    ]);
    let store = google::Store::new(
        google::Credentials::Metadata,
        Client::new(&fixture.endpoint, "fixture").unwrap(),
        &fixture.endpoint,
    )
    .unwrap();
    assert_eq!(store.token(0).await.unwrap(), "metadata-one");
    assert_eq!(store.token(3_000_000).await.unwrap(), "metadata-one");
    assert_eq!(store.token(3_300_000).await.unwrap(), "metadata-two");
    fixture.finish();
    assert!(fixture.requests.lock().unwrap().iter().all(|request| {
        request.starts_with("GET /computeMetadata/v1/instance/service-accounts/default/token")
            && request
                .to_ascii_lowercase()
                .contains("metadata-flavor: google")
    }));
    store.shutdown().await.unwrap();
}

fn unbase64(value: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = 0u32;
    let mut count = 0;
    let mut output = Vec::new();
    for byte in value.bytes().take_while(|byte| *byte != b'=') {
        let value = match byte {
            b'-' => 62,
            b'_' => 63,
            byte => alphabet.iter().position(|value| *value == byte).unwrap() as u32,
        };
        bits = bits << 6 | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            output.push((bits >> count) as u8);
        }
    }
    output
}

#[tokio::test]
async fn service_account_jwt_has_rs256_signature_scope_and_one_hour_claims() {
    use ring::signature::KeyPair;
    let mut fixture = Fixture::new(vec![Some(
        r#"{"access_token":"service-token","expires_in":3600}"#.into(),
    )]);
    let credentials = google::Credentials::parse(&serde_json::json!({"type":"service_account","client_email":"fixture@example.invalid","private_key":SYNTHETIC_RSA_KEY,"private_key_id":"fixture-id"}).to_string()).unwrap();
    assert!(!format!("{credentials:?}").contains("fixture@example"));
    let store = google::Store::new(
        credentials,
        Client::new(&fixture.endpoint, "fixture").unwrap(),
        &fixture.endpoint,
    )
    .unwrap();
    let auth = store.prepare(1_000_000).await.unwrap();
    let headers = auth
        .apply(ycoding_ai::auth::Input {
            method: "POST",
            url: "https://example.invalid",
            body: "{}",
            headers: reqwest::header::HeaderMap::new(),
        })
        .unwrap();
    assert_eq!(
        headers.get("authorization").unwrap(),
        "Bearer service-token"
    );
    assert!(headers.get("authorization").unwrap().is_sensitive());
    fixture.finish();
    let requests = fixture.requests.lock().unwrap().clone();
    let body = requests[0].split_once("\r\n\r\n").unwrap().1;
    let params = url::form_urlencoded::parse(body.as_bytes()).collect::<BTreeMap<_, _>>();
    assert_eq!(
        params["grant_type"],
        "urn:ietf:params:oauth:grant-type:jwt-bearer"
    );
    let token = &params["assertion"];
    let parts = token.split('.').collect::<Vec<_>>();
    let header: serde_json::Value = serde_json::from_slice(&unbase64(parts[0])).unwrap();
    let claims: serde_json::Value = serde_json::from_slice(&unbase64(parts[1])).unwrap();
    assert_eq!(header["alg"], "RS256");
    assert_eq!(header["kid"], "fixture-id");
    assert_eq!(
        claims["scope"],
        "https://www.googleapis.com/auth/cloud-platform"
    );
    assert_eq!(claims["aud"], "https://oauth2.googleapis.com/token");
    assert_eq!(claims["iat"], 1000);
    assert_eq!(claims["exp"], 4600);
    let der = unbase64(
        &SYNTHETIC_RSA_KEY
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>(),
    );
    let key = ring::signature::RsaKeyPair::from_pkcs8(&der).unwrap();
    ring::signature::UnparsedPublicKey::new(
        &ring::signature::RSA_PKCS1_2048_8192_SHA256,
        key.public_key().as_ref(),
    )
    .verify(
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
        &unbase64(parts[2]),
    )
    .unwrap();
    assert!(google::assertion("fixture@example.invalid", "invalid", None, 0).is_err());
    drop(requests);
    store.shutdown().await.unwrap();
}

const SYNTHETIC_RSA_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDSk2n0wfzkoQRX
wBYozo+uzVa9XixIUtOo9qCOiYzL+aS7zzQS2PL6typB8kWOlU3DzVLtztoMr9Hz
QKJuqCvtALo5VHFUxW/K3Gz3hhE1CaQ6q/5EnjhrwaeQ4mdtbJEkU6NW0bI1fugP
D/Dyvjo8SpPOqkhkHIh3HGasPfIJwMUqkIDbkYh/4rYNUnaenuljPpHN1CV+5iKu
nfyuU1b0HQs1MYxL6Ajc1eER58NsKIdOOhJR0hYH4CTSPmqV9zSXZLRWzLm4Wmtj
absrETh2xo3jki1D1fMgippPSatUJ58wwd9nDpimZdFJO+lehjAJQ+qF20YhyDTw
fTiy6qHFAgMBAAECggEBAKqH+1zd5MH6rBusUcXGUpILdN1y8IW5nfPNlwUX29As
Yf4+tTs2OsBTqYMygqYPv6R8GVbBF9ECahKHG4Rl6PzMhAN9oTI3mms8y3pBNpov
LrLdKtPDFoodkGhDEeOJ8pjqqvLaa2nrVl8sV8MdzueYtc6+FFYOzW04sOV4XRUL
chAp9USZwAS/sYCFuQOig+877zSiYlbm6i4HmP3tZlj3rbnsUyoI2LHejLVLKlPK
4trap0f+F16sKsnRi9/cMbja9uByOO2cUN8e96BGSxGV6X/bjO55ki7cW472G94C
h+hsaz3VlZaKKelzVWZb00bOTf8scyvP7iCp+0FY7pkCgYEA6Z05+1Wq9psgAF6L
6Te+0zBbD30z0axC5+RJtqPmMCHdtbWMcnJZD0+35xsiXFQMNpiWz5efLFkVw2SM
hiay5+0mIJRVHw0QF4RBPwK4FDRrLzcy2iAQSlAM6vBd8MfySg9c3Z6ioGThH9Ik
POIxoNoUVpq4AzcWaSG07J9qcfMCgYEA5sEJII5J30dX/pBmtmn5aXPrTTcy8jMU
05BaM5am5Y7kfs8ACYGZElSoSn9BlFzM5hfYe2PhoYyVuIBmDMB+UWf+7Z0g3Ljn
4Ov/u5vmNiehV9+VLf1HTRH7MHWXuCyJu9YjMA7SJw/nzao7//sr7aTQB+zS5C7Q
z6xcmXeHU2cCgYEAsbFG3hauYL9jmwRPVYhyXH7mdKSeGrj1dx8ctpB6UVghJMq/
1nmFpnDTiDUKcMH5PDnaVHKWvwvP0vyTKqMa5/BpVNSe3mx4NfsCCeSOkcfBU3uf
8Wv8GBpFiRplyfS8JXsD/wpf1rKEzkhwCeNfLmNSnwE2QDPRlwvtayJiu+MCgYEA
jNXeOzd80MCbbSw29DiD2B++yjbZakdQ+7sLwpa9MDhhLyAp1qN5iF2RBT7cCLAH
ApwlLVINwOqr6pq7LidCMW82gVG4X96e74E6aQfCnuTbLWWxiAsgvGIwHCh5PBg6
zCDrAwbYrqyffr/atOZYrkc8DMo3ALuuCEIbljMErhsCgYBAkxQLamgZLWH/xp7D
68ylYR5bnbNvr6045DuRJRsQ3M+MU0Dtsy1ilgQlQRuD8QiNrPDfF/NNPomENlUS
ybemrOueGNMewzT4Q67URg3+r66VaQd8/AKeybkDhn6OKlGvHl6n18UOftJV4/R7
dZ/n6xyUjPCs064vUKakSBtrwQ==
-----END PRIVATE KEY-----";
