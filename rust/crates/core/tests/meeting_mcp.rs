use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};
use ycoding_core::meeting::config::KnowledgeBinding;
use ycoding_core::meeting::intelligence::{
    Generate, Intelligence, Mcp, McpServer, ServiceMcp, Settings,
};
use ycoding_core::meeting::store::MeetingDatabase;
use ycoding_core::resources::mcp::{Service, client::Hooks};
use ycoding_schema::{DomainDecode, mcp::ServerConfig, parse_json};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct Wiki {
    revision: u64,
    content: String,
    writes: Vec<Value>,
    deny_writes: bool,
}

struct Server {
    url: String,
    state: Arc<Mutex<Wiki>>,
    task: JoinHandle<()>,
}

impl Server {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(Wiki {
            revision: 1,
            content: "Canonical requirement".into(),
            ..Wiki::default()
        }));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    incoming = listener.accept() => {
                        let (mut stream, _) = incoming.unwrap();
                        let wiki = shared.clone();
                        connections.spawn(async move { serve(&mut stream, wiki).await });
                    },
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                }
            }
        });
        Self { url, state, task }
    }

    fn config(&self) -> ServerConfig {
        ServerConfig::decode(
            &parse_json(&json!({ "type": "remote", "url": self.url, "oauth": false }).to_string())
                .unwrap(),
        )
        .unwrap()
    }
}

async fn serve(stream: &mut tokio::net::TcpStream, wiki: Arc<Mutex<Wiki>>) {
    let mut request = Vec::new();
    let mut buffer = [0; 2048];
    let end = loop {
        let length = stream.read(&mut buffer).await.unwrap();
        if length == 0 {
            return;
        }
        request.extend_from_slice(&buffer[..length]);
        if let Some(offset) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break offset + 4;
        }
    };
    let headers = String::from_utf8(request[..end].to_vec()).unwrap();
    let length = headers
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while request.len() < end + length {
        let read = stream.read(&mut buffer).await.unwrap();
        if read == 0 {
            return;
        }
        request.extend_from_slice(&buffer[..read]);
    }
    let post = headers.starts_with("POST");
    let body: Value = if length == 0 {
        Value::Null
    } else {
        serde_json::from_slice(&request[end..end + length]).unwrap()
    };
    let (status, payload) = if !post {
        (405, String::new())
    } else if body.get("id").is_none() {
        (202, String::new())
    } else {
        (200, rpc(&body, &wiki).to_string())
    };
    let head = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(payload.as_bytes()).await.unwrap();
}

fn rpc(body: &Value, wiki: &Mutex<Wiki>) -> Value {
    let params = &body["params"];
    let mut wiki = wiki.lock().unwrap();
    let result = match body["method"].as_str().unwrap() {
        "initialize" => json!({
            "protocolVersion": "2025-11-25", "serverInfo": { "name": "wiki", "version": "1" },
            "capabilities": { "tools": { "listChanged": true } },
        }),
        "tools/list" => json!({ "tools": [
            { "name": "search", "inputSchema": { "type": "object" } },
            { "name": "read", "inputSchema": { "type": "object" } },
            { "name": "write", "inputSchema": {
                "type": "object", "properties": { "id": {}, "content": {}, "expectedRevision": {} },
                "required": ["id", "content", "expectedRevision"],
            } },
        ] }),
        "tools/call" => {
            let arguments = &params["arguments"];
            match params["name"].as_str().unwrap() {
                "search" => {
                    json!({ "content": [], "structuredContent": { "documents": [{ "id": "page" }] } })
                }
                "read" => json!({ "content": [], "structuredContent": {
                    "id": "page", "revision": format!("revision-{}", wiki.revision), "content": wiki.content,
                } }),
                _ if wiki.deny_writes => {
                    json!({ "isError": true, "content": [{ "type": "text", "text": "denied" }] })
                }
                _ => {
                    wiki.writes.push(arguments.clone());
                    wiki.content = arguments["content"].as_str().unwrap().to_owned();
                    wiki.revision += 1;
                    json!({ "content": [{ "type": "text", "text": "{\"ok\":true}" }] })
                }
            }
        }
        _ => {
            return json!({ "jsonrpc": "2.0", "id": body["id"], "error": { "code": -32601, "message": "Method not found" } });
        }
    };
    json!({ "jsonrpc": "2.0", "id": body["id"], "result": result })
}

fn proposing(evidence: &'static str) -> Generate {
    Arc::new(move |_, _| {
        Box::pin(async move {
            Ok(json!({
                "summary": "S", "findings": [],
                "proposals": [{
                    "server": "wiki", "target": "page", "suggestedContent": "New requirement",
                    "explanation": "why", "sourceSegmentIds": [evidence], "confidence": 0.9,
                }],
            })
            .to_string())
        })
    })
}

fn binding() -> KnowledgeBinding {
    KnowledgeBinding {
        server: "wiki".into(),
        search: "search".into(),
        read: "read".into(),
        write: Some("write".into()),
        enabled: true,
    }
}

#[tokio::test]
async fn the_core_mcp_service_drives_retrieval_review_and_revision_aware_writes_over_a_real_transport()
 {
    tokio::time::timeout(Duration::from_secs(25), async {
        let root = std::env::temp_dir().join(format!(
            "ycoding-meeting-mcp-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let server = Server::new().await;
        let service = Service::new(&[], root.clone(), "1".into(), BTreeMap::new(), Hooks::default()).unwrap();
        service.add("wiki", server.config()).await.unwrap();
        let mcp = Arc::new(ServiceMcp::new(service));

        let tools = mcp.tools().await.unwrap();
        assert_eq!(
            mcp.servers().await.unwrap(),
            vec![McpServer { name: "wiki".into(), status: Some("connected".into()) }]
        );
        let write = tools.iter().find(|tool| tool.name == "write").unwrap();
        assert_eq!(write.server, "wiki");
        assert_eq!(write.input_schema.as_ref().unwrap()["required"], json!(["id", "content", "expectedRevision"]));
        let read = mcp.call_tool("wiki", "read", json!({ "id": "page" })).await.unwrap();
        assert!(!read.is_error);
        assert_eq!(read.structured.unwrap()["revision"], "revision-1");
        assert!(mcp.call_tool("absent", "read", json!({})).await.is_err());

        let database = MeetingDatabase::open(&root.join("meetings.redb")).unwrap();
        database.create_meeting("meeting", "Meeting", "session").await.unwrap();
        database
            .put_segment(&json!({
                "id": "first", "meetingID": "meeting", "sequence": 1, "source": "remote",
                "speakerID": "remote-unknown", "startMs": 0, "endMs": 900, "rawText": "Replace it",
                "text": "Replace it", "state": "final", "model": "m", "createdAt": "2026-10-12T00:00:00.000Z",
            }))
            .await
            .unwrap();
        let intelligence = Intelligence::new(
            database.clone(),
            Some(proposing("first")),
            Some(mcp.clone()),
            Settings { bindings: vec![binding()], max_characters: 32_000, retrieval_ttl: Duration::from_secs(60) },
        );
        intelligence.analyze("meeting", false, false).wait().await.unwrap();
        let proposal = database.proposals("meeting").unwrap().remove(0);
        assert_eq!(proposal["existingContent"], "Canonical requirement");
        let id = proposal["id"].as_str().unwrap();

        server.state.lock().unwrap().deny_writes = true;
        intelligence.review("meeting", id, true).await.unwrap();
        assert_eq!(database.proposals("meeting").unwrap()[0]["status"], "uncertain");
        assert!(server.state.lock().unwrap().writes.is_empty());

        server.state.lock().unwrap().deny_writes = false;
        database.create_meeting("second", "Second", "session").await.unwrap();
        database
            .put_segment(&json!({
                "id": "second-evidence", "meetingID": "second", "sequence": 1, "source": "remote",
                "speakerID": "remote-unknown", "startMs": 0, "endMs": 900, "rawText": "Replace it",
                "text": "Replace it", "state": "final", "model": "m", "createdAt": "2026-10-12T00:00:00.000Z",
            }))
            .await
            .unwrap();
        let second = Intelligence::new(
            database.clone(),
            Some(proposing("second-evidence")),
            Some(mcp.clone()),
            Settings { bindings: vec![binding()], max_characters: 32_000, retrieval_ttl: Duration::from_secs(60) },
        );
        second.analyze("second", false, false).wait().await.unwrap();
        let id = database.proposals("second").unwrap()[0]["id"].as_str().unwrap().to_owned();
        second.review("second", &id, true).await.unwrap();
        assert_eq!(database.proposals("second").unwrap()[0]["status"], "applied");
        let writes = server.state.lock().unwrap().writes.clone();
        assert_eq!(writes, vec![json!({ "id": "page", "content": "New requirement", "expectedRevision": "revision-1" })]);
        assert_eq!(database.references("second").unwrap()[0]["revision"], "revision-2");

        database.close().await.unwrap();
        server.task.abort();
        let _ = std::fs::remove_dir_all(&root);
    })
    .await
    .expect("MCP test exceeded 25 seconds");
}
