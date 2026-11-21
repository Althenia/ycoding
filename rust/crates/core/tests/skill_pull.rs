use std::{
    collections::BTreeMap,
    fs,
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
use ycoding_core::resources::skill::discovery;
use ycoding_schema::{JsonValue, parse_json, stringify_json};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct State {
    index: JsonValue,
    files: BTreeMap<String, String>,
    requests: Vec<String>,
    pause: Option<(String, oneshot::Sender<()>, oneshot::Receiver<()>)>,
}
struct Fixture {
    root: PathBuf,
    base: String,
    state: Arc<Mutex<State>>,
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new(index: &str, files: &[(&str, &str)]) -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-skill-pull-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/catalog/", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State {
            index: parse_json(index).unwrap(),
            files: files
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            requests: Vec::new(),
            pause: None,
        }));
        let server = state.clone();
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = tokio::select! { _ = &mut stopped => break, value = listener.accept() => value.unwrap() };
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let n = socket.read(&mut chunk).await.unwrap();
                    request.extend_from_slice(&chunk[..n]);
                    if n == 0 || request.windows(4).any(|p| p == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                let path = request.split_whitespace().nth(1).unwrap();
                let body = {
                    let mut state = server.lock().unwrap();
                    state.requests.push(path.into());
                    if path == "/catalog/index.json" {
                        Some(stringify_json(&state.index))
                    } else {
                        state.files.get(path).cloned()
                    }
                };
                let pause = {
                    let mut state = server.lock().unwrap();
                    if state
                        .pause
                        .as_ref()
                        .is_some_and(|(target, _, _)| target == path)
                    {
                        state.pause.take()
                    } else {
                        None
                    }
                };
                if let Some((_, entered, release)) = pause {
                    entered.send(()).unwrap();
                    release.await.unwrap();
                }
                let status = if body.is_some() { 200 } else { 404 };
                let body = body.unwrap_or_else(|| "Not found".into());
                let written=socket.write_all(format!("HTTP/1.1 {status} response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                if let Err(e) = written {
                    assert!(matches!(
                        e.kind(),
                        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                    ));
                }
            }
        });
        Self {
            root,
            base,
            state,
            stop,
            task,
        }
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
        fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn skill_pull_rejects_traversal_absolute_cross_origin_and_encoded_escapes_before_file_requests()
 {
    let f = Fixture::new(r#"{"skills":[{"name":"../outside","files":["SKILL.md"]},{"name":"file-escape","files":["SKILL.md","../outside.md"]},{"name":"absolute","files":["SKILL.md","/tmp/outside.md"]},{"name":"remote","files":["SKILL.md","https://evil.example.test/outside"]},{"name":"encoded","files":["SKILL.md","%2e%2e/outside.md"]},{"name":"slash","files":["SKILL.md","a%2fb"]},{"name":"bad-encoding","files":["SKILL.md","%ZZ"]}]}"#, &[]).await;
    let result = discovery::pull(&f.base, &f.root).await.unwrap();
    assert!(result.directories.is_empty());
    assert_eq!(f.state.lock().unwrap().requests, ["/catalog/index.json"]);
    assert!(fs::read_dir(&f.root).unwrap().next().is_none());
    f.finish().await;
}

#[tokio::test]
async fn skill_pull_downloads_nested_files_and_version_changes_publish_complete_snapshots() {
    let f = Fixture::new(r#"{"skills":[{"name":"deploy","version":"1","files":["SKILL.md","references/guide.md"]}]}"#, &[("/catalog/deploy/SKILL.md","Old"),("/catalog/deploy/references/guide.md","Guide")]).await;
    let result = discovery::pull(&f.base, &f.root).await.unwrap();
    assert_eq!(result.directories.len(), 1);
    let root = result.directories[0].clone();
    assert_eq!(fs::read_to_string(root.join("SKILL.md")).unwrap(), "Old");
    assert_eq!(
        fs::read_to_string(root.join("references/guide.md")).unwrap(),
        "Guide"
    );
    {
        let mut state = f.state.lock().unwrap();
        state.index = parse_json(
            r#"{"skills":[{"name":"deploy","version":"2","files":["SKILL.md","missing.md"]}]}"#,
        )
        .unwrap();
        state
            .files
            .insert("/catalog/deploy/SKILL.md".into(), "Partial".into());
        state.requests.clear();
    }
    let failed = discovery::pull(&f.base, &f.root).await.unwrap();
    assert!(!failed.diagnostics.is_empty());
    assert_eq!(fs::read_to_string(root.join("SKILL.md")).unwrap(), "Old");
    assert_eq!(
        fs::read_to_string(root.join("references/guide.md")).unwrap(),
        "Guide"
    );
    {
        let mut state = f.state.lock().unwrap();
        state.index =
            parse_json(r#"{"skills":[{"name":"deploy","version":"3","files":["SKILL.md"]}]}"#)
                .unwrap();
        state
            .files
            .insert("/catalog/deploy/SKILL.md".into(), "New".into());
        state.requests.clear();
    }
    discovery::pull(&f.base, &f.root).await.unwrap();
    assert_eq!(fs::read_to_string(root.join("SKILL.md")).unwrap(), "New");
    assert!(!root.join("references/guide.md").exists());
    f.state.lock().unwrap().requests.clear();
    discovery::pull(&f.base, &f.root).await.unwrap();
    assert_eq!(f.state.lock().unwrap().requests, ["/catalog/index.json"]);
    assert_eq!(
        fs::read_to_string(root.join(".ycoding-version")).unwrap(),
        "3"
    );
    assert!(
        fs::read_dir(root.parent().unwrap()).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp-"))
    );
    f.finish().await;
}

#[tokio::test]
async fn skill_service_memoizes_only_url_pull_and_rereads_downloaded_files() {
    let f = Fixture::new(
        r#"{"skills":[{"name":"deploy","files":["SKILL.md"]}]}"#,
        &[(
            "/catalog/deploy/SKILL.md",
            "---\ndescription: First\n---\nBody",
        )],
    )
    .await;
    let mut service = ycoding_core::resources::skill::Service::new(&f.root);
    service.source(ycoding_schema::skill::Source::Url(
        ycoding_schema::skill::UrlSource {
            url: f.base.as_str().into(),
        },
    ));
    let first = service.list().await.unwrap();
    assert_eq!(first[0].description, Some("First".into()));
    let file = first[0].location.as_lossless().as_str().unwrap();
    fs::write(file, "---\ndescription: Edited\n---\nNew").unwrap();
    assert_eq!(
        service.list().await.unwrap()[0].description,
        Some("Edited".into())
    );
    assert_eq!(f.state.lock().unwrap().requests.len(), 2);
    assert!(!service.changed(std::path::Path::new(file)));
    f.finish().await;
}

#[tokio::test]
async fn cancelling_version_refresh_retains_old_cache_and_leaves_no_staging_or_workers() {
    let f = Fixture::new(
        r#"{"skills":[{"name":"deploy","version":"1","files":["SKILL.md"]}]}"#,
        &[("/catalog/deploy/SKILL.md", "Old")],
    )
    .await;
    let root = discovery::pull(&f.base, &f.root).await.unwrap().directories[0].clone();
    let (entered, ready) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    {
        let mut state = f.state.lock().unwrap();
        state.index=parse_json(r#"{"skills":[{"name":"deploy","version":"2","files":["SKILL.md","r1","r2","r3","r4","r5","r6","r7","slow.md"]}]}"#).unwrap();
        state
            .files
            .insert("/catalog/deploy/SKILL.md".into(), "New".into());
        for file in ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "slow.md"] {
            state
                .files
                .insert(format!("/catalog/deploy/{file}"), "resource".into());
        }
        state.pause = Some(("/catalog/deploy/slow.md".into(), entered, wait));
    }
    let url = f.base.clone();
    let cache = f.root.clone();
    let pull = tokio::spawn(async move { discovery::pull(&url, &cache).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), ready)
        .await
        .unwrap()
        .unwrap();
    pull.abort();
    assert!(pull.await.is_err_and(|e| e.is_cancelled()));
    assert_eq!(fs::read_to_string(root.join("SKILL.md")).unwrap(), "Old");
    assert_eq!(fs::read_dir(root.parent().unwrap()).unwrap().count(), 1);
    release.send(()).unwrap();
    f.finish().await;
}
