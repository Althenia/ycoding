use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

pub struct Fixture {
    pub base: String,
    pub requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
}
impl Fixture {
    pub async fn new(responses: Vec<(u16, String)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let origin = base.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            for (status, body) in responses {
                let (mut socket, _) =
                    tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut bytes = vec![];
                loop {
                    let mut chunk = [0; 4096];
                    let count = socket.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let size = headers
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|v| v.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + size {
                            break;
                        }
                    }
                }
                captured
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(bytes).unwrap());
                let body = body.replace("{{base}}", &origin);
                let content_type = if body.starts_with("data:") || body.starts_with("event:") {
                    "text/event-stream"
                } else {
                    "application/json"
                };
                socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
                for chunk in body.as_bytes().chunks(13) {
                    socket.write_all(chunk).await.unwrap();
                }
            }
        });
        Self {
            base,
            requests,
            task,
        }
    }
    pub async fn finish(self) -> Vec<String> {
        tokio::time::timeout(std::time::Duration::from_secs(10), self.task)
            .await
            .unwrap()
            .unwrap();
        self.requests.lock().unwrap().clone()
    }
}
pub fn header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().find_map(|line| {
        line.split_once(": ")
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, v)| v)
    })
}

pub fn store() -> (
    ycoding_store::Store,
    ycoding_core::resources::credential::Service,
) {
    let store = ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
        ycoding_store::Metadata::new([7; 16], 1),
    )
    .unwrap();
    let credentials = ycoding_core::resources::credential::Service::new(store.client());
    (store, credentials)
}
pub fn secret(value: &str) -> ycoding_store::resources::Secret {
    ycoding_store::resources::Secret::new(ycoding_schema::parse_json(value).unwrap()).unwrap()
}
pub fn row(id: &str) -> serde_json::Value {
    serde_json::json!({"id":id,"metadata":{"muse-code":{"name":"Muse Wonder","family":"muse-wonder","release_date":"2026-09-02","is_hidden":false,"tool_call":true,"modalities":{"input":["text","image"],"output":["text"]},"limit":{"context":1007997,"output":128000},"options":{"reasoningEffort":"high","temperature":0.9,"top_p":0.9},"variants":{"minimal":{"reasoningEffort":"minimal"},"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"},"xhigh":{"reasoningEffort":"xhigh"},"max":{"reasoningEffort":"max"}}}}})
}
