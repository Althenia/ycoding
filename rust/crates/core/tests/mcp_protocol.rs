use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use ycoding_core::resources::mcp::client::{Connection, Content, Error, Hooks};
use ycoding_schema::{DomainDecode, mcp::ServerConfig, parse_json};

const MODERN: &str = "2026-07-28";
const LEGACY: &str = "2025-11-25";
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-mcp-protocol-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn fixture(&self, name: &str) -> PathBuf {
        let result = Command::new("bun")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("src/resources/mcp/extract-fixture.mjs"),
            )
            .arg(name)
            .arg(&self.0)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        PathBuf::from(String::from_utf8(result.stdout).unwrap())
    }
    fn log(&self) -> PathBuf {
        self.0.join("methods.log")
    }
    fn lines(&self) -> BTreeMap<String, usize> {
        fs::read_to_string(self.log())
            .unwrap()
            .lines()
            .fold(BTreeMap::new(), |mut counts, line| {
                *counts.entry(line.to_string()).or_default() += 1;
                counts
            })
    }
    fn stdio(&self, era: &str, startup: Option<u64>) -> ServerConfig {
        let mut value = json!({"type":"local","command":["bun",self.fixture("mcp-protocol")],"environment":{"MCP_PROTOCOL_ERA":era,"MCP_PROTOCOL_LOG":self.log()}});
        if let Some(startup) = startup {
            value["timeout"] = json!({ "startup": startup });
        }
        ServerConfig::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn counts(entries: &[(&str, usize)]) -> BTreeMap<String, usize> {
    entries
        .iter()
        .map(|(key, count)| (key.to_string(), *count))
        .collect()
}

async fn connect(
    config: &ServerConfig,
    directory: &Path,
    hooks: Hooks,
) -> Result<Connection, Error> {
    Connection::connect(
        "protocol",
        config,
        directory,
        "1.0.0",
        &BTreeMap::new(),
        hooks,
    )
    .await
}

async fn negotiated(connection: &Connection, args: Value) -> Result<Vec<String>, Error> {
    Ok(connection
        .call_tool("protocol", args, None)
        .await?
        .content
        .into_iter()
        .filter_map(|part| match part {
            Content::Text(text) => Some(text),
            Content::Media { .. } => None,
        })
        .collect())
}

async fn connect_stdio(directory: &Directory, era: &str) -> Result<Vec<String>, Error> {
    let connection = connect(&directory.stdio(era, None), &directory.0, Hooks::default()).await?;
    let result = negotiated(&connection, json!({})).await;
    connection.close().await.unwrap();
    result
}

#[tokio::test]
async fn modern_stdio_server_negotiates_2026_07_28_in_one_process() {
    let directory = Directory::new();
    let connection = connect(
        &directory.stdio("modern", None),
        &directory.0,
        Hooks::default(),
    )
    .await
    .unwrap();
    assert_eq!(connection.protocol_version(), MODERN);
    let tools = connection.tools().await.unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "protocol");
    assert_eq!(negotiated(&connection, json!({})).await.unwrap(), [MODERN]);
    connection.close().await.unwrap();
    assert_eq!(directory.lines(), counts(&[("spawn", 1)]));
}

#[tokio::test]
async fn legacy_stdio_server_initializes_in_the_probed_process() {
    let directory = Directory::new();
    assert_eq!(connect_stdio(&directory, "legacy").await.unwrap(), [LEGACY]);
    let lines = directory.lines();
    assert_eq!(lines["spawn"], 1);
    assert_eq!(lines["server/discover"], 1);
    assert_eq!(lines["initialize"], 1);
}

#[tokio::test]
async fn known_legacy_stdio_server_reconnects_without_a_probe() {
    let directory = Directory::new();
    assert_eq!(connect_stdio(&directory, "legacy").await.unwrap(), [LEGACY]);
    assert_eq!(connect_stdio(&directory, "legacy").await.unwrap(), [LEGACY]);
    let lines = directory.lines();
    assert_eq!(lines["spawn"], 2);
    assert_eq!(lines["server/discover"], 1);
    assert_eq!(lines["initialize"], 2);
}

#[tokio::test]
async fn exiting_probe_process_is_replaced_by_a_fresh_legacy_process() {
    let directory = Directory::new();
    assert_eq!(connect_stdio(&directory, "exits").await.unwrap(), [LEGACY]);
    let lines = directory.lines();
    assert_eq!(
        (
            lines["spawn"],
            lines["server/discover"],
            lines["initialize"]
        ),
        (2, 1, 1)
    );
    assert_eq!(connect_stdio(&directory, "exits").await.unwrap(), [LEGACY]);
    let lines = directory.lines();
    assert_eq!(
        (
            lines["spawn"],
            lines["server/discover"],
            lines["initialize"]
        ),
        (3, 1, 2)
    );
}

#[tokio::test]
async fn stdio_server_supporting_only_later_revisions_does_not_fall_back() {
    let directory = Directory::new();
    let error = connect_stdio(&directory, "unsupported").await.unwrap_err();
    assert!(
        error.to_string().contains("Unsupported protocol version"),
        "{error}"
    );
    assert_eq!(
        directory.lines(),
        counts(&[("spawn", 1), ("server/discover", 1)])
    );
}

#[tokio::test]
async fn silent_probe_is_bounded_and_a_fresh_legacy_process_starts() {
    let directory = Directory::new();
    let started = Instant::now();
    assert_eq!(connect_stdio(&directory, "silent").await.unwrap(), [LEGACY]);
    assert!(started.elapsed() < Duration::from_secs(15));
    let lines = directory.lines();
    assert_eq!(
        (
            lines["spawn"],
            lines["server/discover"],
            lines["initialize"]
        ),
        (2, 1, 1)
    );
}

#[tokio::test]
async fn startup_timeout_shorter_than_the_probe_bound_limits_the_silent_probe() {
    let directory = Directory::new();
    let started = Instant::now();
    let connection = connect(
        &directory.stdio("silent", Some(1500)),
        &directory.0,
        Hooks::default(),
    )
    .await
    .unwrap();
    assert!(started.elapsed() < Duration::from_millis(4500));
    assert_eq!(negotiated(&connection, json!({})).await.unwrap(), [LEGACY]);
    connection.close().await.unwrap();
}

struct Http {
    child: Child,
    url: String,
    _directory: Directory,
}
impl Http {
    fn new(era: &str) -> Self {
        let directory = Directory::new();
        let mut child = Command::new("bun")
            .arg(directory.fixture("mcp-protocol-http"))
            .env("MCP_HTTP_ERA", era)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut url = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut url)
            .unwrap();
        Self {
            child,
            url: url.trim().to_string(),
            _directory: directory,
        }
    }
    fn config(&self, execution: Option<u64>) -> ServerConfig {
        let mut value = json!({"type":"remote","url":self.url,"oauth":false});
        if let Some(execution) = execution {
            value["timeout"] = json!({ "execution": execution });
        }
        ServerConfig::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
    }
    fn control(&self, path: &str) -> String {
        self.url.replace("/mcp", path)
    }
    async fn received(&self) -> Vec<Value> {
        reqwest::get(self.control("/received"))
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    }
    async fn post(&self, path: &str, body: Value) {
        assert!(
            reqwest::Client::new()
                .post(self.control(path))
                .json(&body)
                .send()
                .await
                .unwrap()
                .status()
                .is_success()
        );
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test]
async fn modern_http_server_negotiates_2026_07_28_and_sends_it_on_every_request() {
    let server = Http::new("modern");
    let connection = connect(
        &server.config(None),
        &std::env::temp_dir(),
        Hooks::default(),
    )
    .await
    .unwrap();
    assert_eq!(connection.protocol_version(), MODERN);
    assert_eq!(negotiated(&connection, json!({})).await.unwrap(), [MODERN]);
    connection.close().await.unwrap();
    let received = server.received().await;
    let methods = received
        .iter()
        .map(|entry| entry["method"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(methods[0], "server/discover");
    assert!(methods.contains(&"tools/call"));
    assert!(!methods.contains(&"initialize"));
    for entry in &received {
        assert_eq!(
            (&entry["header"], &entry["envelope"]),
            (&json!(MODERN), &json!(MODERN)),
            "{entry}"
        );
        assert_eq!(entry["mcpMethod"], entry["method"]);
        assert_eq!(
            entry["params"]["_meta"]["io.modelcontextprotocol/clientInfo"],
            json!({"name":"ycoding","version":"1.0.0"})
        );
        assert_eq!(
            entry["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"]["roots"],
            json!({})
        );
    }
    let call = received
        .iter()
        .find(|entry| entry["method"] == "tools/call")
        .unwrap();
    assert_eq!(call["mcpName"], "protocol");
}

#[tokio::test]
async fn legacy_http_server_falls_back_to_the_2025_11_25_initialize_handshake() {
    let server = Http::new("legacy");
    let connection = connect(
        &server.config(None),
        &std::env::temp_dir(),
        Hooks::default(),
    )
    .await
    .unwrap();
    assert_eq!(connection.protocol_version(), LEGACY);
    assert_eq!(negotiated(&connection, json!({})).await.unwrap(), [LEGACY]);
    connection.close().await.unwrap();
    let received = server.received().await;
    assert_eq!(
        received[..3]
            .iter()
            .map(|entry| entry["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["server/discover", "initialize", "notifications/initialized"]
    );
    assert_eq!(received[1]["params"]["protocolVersion"], LEGACY);
    for entry in &received[2..] {
        assert_eq!(
            (&entry["header"], &entry["envelope"]),
            (&json!(LEGACY), &Value::Null),
            "{entry}"
        );
    }
}

#[tokio::test]
async fn expired_legacy_http_session_is_reinitialized_and_the_request_retried() {
    let server = Http::new("legacy");
    let connection = connect(
        &server.config(None),
        &std::env::temp_dir(),
        Hooks::default(),
    )
    .await
    .unwrap();
    assert_eq!(negotiated(&connection, json!({})).await.unwrap(), [LEGACY]);
    server.post("/expire", json!({})).await;
    assert_eq!(negotiated(&connection, json!({})).await.unwrap(), [LEGACY]);
    connection.close().await.unwrap();
    assert_eq!(
        server
            .received()
            .await
            .iter()
            .filter(|entry| entry["method"] == "initialize")
            .count(),
        2
    );
}

#[tokio::test]
async fn unsupported_modern_http_revision_fails_without_initialization() {
    let server = Http::new("unsupported");
    assert!(
        connect(
            &server.config(None),
            &std::env::temp_dir(),
            Hooks::default()
        )
        .await
        .is_err()
    );
    assert_eq!(
        server
            .received()
            .await
            .iter()
            .map(|entry| entry["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["server/discover"]
    );
}

#[tokio::test]
async fn known_legacy_http_reconnect_skips_discovery_until_a_connection_fails() {
    let server = Http::new("legacy");
    let config = server.config(None);
    for _ in 0..2 {
        let connection = connect(&config, &std::env::temp_dir(), Hooks::default())
            .await
            .unwrap();
        connection.close().await.unwrap();
    }
    assert_eq!(
        server
            .received()
            .await
            .iter()
            .filter(|entry| entry["method"] == "server/discover")
            .count(),
        1
    );
    server.post("/expire", json!({"refuse":true})).await;
    assert!(
        connect(&config, &std::env::temp_dir(), Hooks::default())
            .await
            .is_err()
    );
    server.post("/expire", json!({})).await;
    let connection = connect(&config, &std::env::temp_dir(), Hooks::default())
        .await
        .unwrap();
    connection.close().await.unwrap();
    assert_eq!(
        server
            .received()
            .await
            .iter()
            .filter(|entry| entry["method"] == "server/discover")
            .count(),
        2
    );
}

#[tokio::test]
async fn failed_legacy_http_session_renewal_closes_the_connection() {
    let server = Http::new("legacy");
    let connection = connect(
        &server.config(None),
        &std::env::temp_dir(),
        Hooks::default(),
    )
    .await
    .unwrap();
    let mut notifications = connection.subscribe();
    server.post("/expire", json!({"refuse":true})).await;
    assert_eq!(negotiated(&connection, json!({})).await, Err(Error::Closed));
    tokio::time::timeout(Duration::from_secs(5), async {
        while notifications.recv().await.unwrap().method != "connection/closed" {}
    })
    .await
    .unwrap();
    assert!(connection.is_closed());
}

#[tokio::test]
async fn request_abandoned_during_legacy_http_session_renewal_is_not_resent() {
    let server = Http::new("legacy");
    let connection = connect(
        &server.config(Some(200)),
        &std::env::temp_dir(),
        Hooks::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        negotiated(&connection, json!({"attempt":"warm"}))
            .await
            .unwrap(),
        [LEGACY]
    );
    server
        .post("/expire", json!({"holdUntilCancelled":true}))
        .await;
    assert_eq!(
        negotiated(&connection, json!({"attempt":"abandoned"})).await,
        Err(Error::Timeout)
    );
    assert_eq!(
        negotiated(&connection, json!({"attempt":"after"}))
            .await
            .unwrap(),
        [LEGACY]
    );
    connection.close().await.unwrap();
    let attempts = server
        .received()
        .await
        .into_iter()
        .filter(|entry| entry["method"] == "tools/call")
        .map(|entry| entry["params"]["arguments"]["attempt"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        attempts
            .iter()
            .filter(|attempt| **attempt == "abandoned")
            .count(),
        1
    );
    assert_eq!(attempts.last().unwrap(), "after");
}

#[tokio::test]
async fn resources_list_read_and_report_changes_in_both_eras() {
    for era in ["legacy", "modern"] {
        let server = Http::new(era);
        let connection = connect(
            &server.config(None),
            &std::env::temp_dir(),
            Hooks::default(),
        )
        .await
        .unwrap();
        let mut notifications = connection.subscribe();
        assert_eq!(
            connection.resources().await.unwrap(),
            [
                json!({"name":"Readme","uri":"docs://readme","description":"Project docs"}),
                json!({"name":"Logo","uri":"docs://logo","mimeType":"image/png"})
            ]
        );
        assert_eq!(
            connection.resource_templates().await.unwrap(),
            [
                json!({"name":"File","uriTemplate":"docs://{path}"}),
                json!({"name":"Issue","uriTemplate":"issue://{id}","description":"Issue"})
            ]
        );
        assert_eq!(
            connection
                .read_resource("docs://readme", None)
                .await
                .unwrap()
                .unwrap()["contents"],
            json!([{"uri":"docs://readme","text":"hello","type":"text","mimeType":"text/plain"},{"uri":"docs://logo","blob":"aGVsbG8=","type":"blob","mimeType":"image/png"}])
        );
        server.post("/notify", json!({})).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while notifications.recv().await.unwrap().method
                != "notifications/resources/list_changed"
            {}
        })
        .await
        .unwrap_or_else(|_| panic!("{era} resource change was not reported"));
        connection.close().await.unwrap();
        let listens = server
            .received()
            .await
            .iter()
            .filter(|entry| entry["method"] == "subscriptions/listen")
            .count();
        assert_eq!(listens, usize::from(era == "modern"), "{era}");
    }
}

fn recording(calls: Arc<Mutex<Vec<Value>>>) -> Hooks {
    Hooks {
        elicitation: Some(Arc::new(move |_, params, _| {
            let calls = calls.clone();
            Box::pin(async move {
                calls.lock().unwrap().push(params);
                Ok(json!({"action":"accept","content":{"internal":"host-only"}}))
            })
        })),
        ..Hooks::default()
    }
}

#[tokio::test]
async fn modern_input_required_elicitations_are_answered_and_retried() {
    let server = Http::new("modern");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let connection = connect(
        &server.config(None),
        &std::env::temp_dir(),
        recording(calls.clone()),
    )
    .await
    .unwrap();
    assert_eq!(
        connection
            .call_tool("empty-elicitation", json!({}), None)
            .await
            .unwrap()
            .structured,
        Some(json!({"action":"accept","content":{}}))
    );
    assert!(calls.lock().unwrap().is_empty());
    assert_eq!(
        connection
            .call_tool("url-elicitation", json!({}), None)
            .await
            .unwrap()
            .structured,
        Some(json!({"action":"accept"}))
    );
    let calls = calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        (&calls[0]["mode"], &calls[0]["url"]),
        (&json!("url"), &json!("https://example.com/authorize"))
    );
    connection.close().await.unwrap();
}

#[tokio::test]
async fn modern_input_required_preserves_state_and_allows_ten_fulfillment_rounds() {
    let server = Http::new("modern");
    let connection = connect(
        &server.config(None),
        &std::env::temp_dir(),
        recording(Arc::new(Mutex::new(Vec::new()))),
    )
    .await
    .unwrap();
    assert_eq!(
        negotiated(&connection, json!({"rounds":10})).await.unwrap(),
        [MODERN]
    );
    let calls = server
        .received()
        .await
        .into_iter()
        .filter(|entry| entry["method"] == "tools/call")
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 11);
    for (round, call) in calls.iter().enumerate().skip(1) {
        assert_eq!(call["params"]["requestState"], round.to_string());
        assert_eq!(
            call["params"]["inputResponses"]["elicitation"],
            json!({"action":"accept","content":{}})
        );
        assert_eq!(call["params"]["arguments"], json!({"rounds":10}));
    }
    assert_eq!(
        negotiated(&connection, json!({"rounds":11})).await,
        Err(Error::InvalidResult("input_required"))
    );
    connection.close().await.unwrap();
}

#[tokio::test]
async fn modern_input_required_is_fulfilled_for_prompts_and_resource_reads() {
    let server = Http::new("modern");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let connection = connect(
        &server.config(None),
        &std::env::temp_dir(),
        recording(calls.clone()),
    )
    .await
    .unwrap();
    let prompt = connection.prompt("ask", json!({}), None).await.unwrap();
    assert_eq!(
        prompt["messages"][0]["content"]["text"],
        "{\"action\":\"accept\"}"
    );
    assert_eq!(
        connection
            .read_resource("docs://ask", None)
            .await
            .unwrap()
            .unwrap()["contents"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(calls.lock().unwrap().len(), 1);
    let requests = server.received().await;
    let retried = requests
        .iter()
        .filter(|entry| entry["method"] == "prompts/get")
        .collect::<Vec<_>>();
    assert_eq!(retried.len(), 2);
    assert_eq!(retried[1]["params"]["requestState"], "prompt-state");
    connection.close().await.unwrap();
}

#[test]
fn mcp_tool_names_preserve_typescript_sanitization() {
    use ycoding_core::tools::registry::normalize_name;
    assert_eq!(normalize_name("context 7"), "context_7");
    assert_eq!(
        normalize_name("context 7_resolve.library/id"),
        "context_7_resolve_library_id"
    );
}

#[tokio::test]
async fn modern_state_only_retry_is_paced_without_calling_the_host() {
    let server = Http::new("modern");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let connection = connect(
        &server.config(None),
        &std::env::temp_dir(),
        recording(calls.clone()),
    )
    .await
    .unwrap();
    let started = Instant::now();
    assert_eq!(
        negotiated(&connection, json!({"rounds":1,"stateOnly":true}))
            .await
            .unwrap(),
        [MODERN]
    );
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert!(calls.lock().unwrap().is_empty());
    connection.close().await.unwrap();
}
