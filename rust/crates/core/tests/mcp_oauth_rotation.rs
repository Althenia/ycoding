use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Barrier,
    task::{JoinHandle, JoinSet},
};
use ycoding_core::resources::{
    credential,
    mcp::{
        client::{Connection, Content, Error, Hooks},
        oauth,
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString, mcp::RemoteConfig, mcp::ServerConfig, parse_json,
    stringify_json,
};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

const NAME: &str = "oauth";
const CLIENT: &str = r#"{"client_id":"fixture-client"}"#;

type Hook = Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

struct State {
    rotate: bool,
    access: BTreeSet<String>,
    refresh: BTreeSet<String>,
    refresh_requests: Vec<String>,
    unauthorized: usize,
    issued: usize,
    discovery: Option<Arc<Barrier>>,
    hook: Option<Hook>,
}
struct Server {
    url: String,
    state: Arc<Mutex<State>>,
    task: JoinHandle<()>,
}
impl Server {
    async fn new(rotate: bool, access: &[&str], refresh: &[&str]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let base = url.clone();
        let state = Arc::new(Mutex::new(State {
            rotate,
            access: access.iter().map(|value| (*value).to_owned()).collect(),
            refresh: refresh.iter().map(|value| (*value).to_owned()).collect(),
            refresh_requests: Vec::new(),
            unauthorized: 0,
            issued: 0,
            discovery: None,
            hook: None,
        }));
        let observed = state.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    incoming = listener.accept() => {
                        let (stream, _) = incoming.unwrap();
                        connections.spawn(serve(stream, observed.clone(), base.clone()));
                    },
                    complete = connections.join_next(), if !connections.is_empty() => { complete.unwrap().unwrap(); },
                }
            }
        });
        Self { url, state, task }
    }
    fn config(&self) -> ServerConfig {
        ServerConfig::decode(
            &parse_json(&json!({"type":"remote","url":format!("{}/mcp",self.url)}).to_string())
                .unwrap(),
        )
        .unwrap()
    }
    fn remote(&self) -> RemoteConfig {
        let ServerConfig::Remote(config) = self.config() else {
            unreachable!()
        };
        config
    }
    fn integration(&self) -> LosslessString {
        oauth::integration_id(NAME, &self.remote().url).unwrap()
    }
    fn refresh_requests(&self) -> Vec<String> {
        self.state.lock().unwrap().refresh_requests.clone()
    }
    fn revoke_access(&self) {
        self.state.lock().unwrap().access.clear();
    }
    async fn close(self) {
        self.task.abort();
        assert!(self.task.await.unwrap_err().is_cancelled());
    }
}

async fn serve(mut stream: tokio::net::TcpStream, state: Arc<Mutex<State>>, base: String) {
    let mut request = Vec::new();
    let mut buffer = [0; 4096];
    let end = loop {
        let len = stream.read(&mut buffer).await.unwrap();
        if len == 0 {
            return;
        }
        request.extend_from_slice(&buffer[..len]);
        if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
    };
    let headers = String::from_utf8(request[..end].to_vec()).unwrap();
    let path = headers.split_whitespace().nth(1).unwrap().to_owned();
    let len = headers
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while request.len() < end + len {
        let len = stream.read(&mut buffer).await.unwrap();
        assert_ne!(len, 0);
        request.extend_from_slice(&buffer[..len]);
    }
    let raw = String::from_utf8(request[end..end + len].to_vec()).unwrap();
    let body = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
    let mut challenge = false;
    let (status, payload) = match path.as_str() {
        "/.well-known/oauth-protected-resource" | "/.well-known/oauth-protected-resource/mcp" => (
            200,
            json!({"resource":format!("{base}/mcp"),"authorization_servers":[base.clone()]}),
        ),
        "/.well-known/oauth-authorization-server" => {
            let barrier = state.lock().unwrap().discovery.clone();
            if let Some(barrier) = barrier {
                barrier.wait().await;
            }
            (
                200,
                json!({"issuer":base,"authorization_endpoint":format!("{base}/authorize"),"token_endpoint":format!("{base}/token"),"registration_endpoint":format!("{base}/register"),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"]}),
            )
        }
        "/register" => (
            201,
            json!({"client_id":"registered-client","token_endpoint_auth_method":"none","redirect_uris":body["redirect_uris"]}),
        ),
        "/token" => {
            let form = url::form_urlencoded::parse(raw.as_bytes())
                .into_owned()
                .collect::<BTreeMap<_, _>>();
            let presented = form.get("refresh_token").cloned().unwrap_or_default();
            let hook = {
                let mut state = state.lock().unwrap();
                state.refresh_requests.push(presented.clone());
                state.hook.clone()
            };
            if let Some(hook) = hook {
                hook(presented.clone()).await;
            }
            let mut state = state.lock().unwrap();
            if form.get("grant_type").map(String::as_str) != Some("refresh_token")
                || !state.refresh.contains(&presented)
            {
                (400, json!({"error":"invalid_grant"}))
            } else {
                state.issued += 1;
                let access = format!("access-{}", state.issued);
                state.access.insert(access.clone());
                if state.rotate {
                    state.refresh.remove(&presented);
                    let refresh = format!("refresh-{}", state.issued);
                    state.refresh.insert(refresh.clone());
                    (
                        200,
                        json!({"access_token":access,"token_type":"Bearer","expires_in":3600,"refresh_token":refresh}),
                    )
                } else {
                    (
                        200,
                        json!({"access_token":access,"token_type":"Bearer","expires_in":3600}),
                    )
                }
            }
        }
        "/mcp" => {
            let token = headers
                .lines()
                .find_map(|line| line.strip_prefix("authorization: Bearer "))
                .or_else(|| {
                    headers
                        .lines()
                        .find_map(|line| line.strip_prefix("Authorization: Bearer "))
                })
                .unwrap_or("")
                .to_owned();
            let authorized = {
                let mut state = state.lock().unwrap();
                let authorized = state.access.contains(&token);
                state.unauthorized += usize::from(!authorized);
                authorized
            };
            if !authorized {
                challenge = true;
                (401, json!({}))
            } else if body.get("id").is_none() {
                (202, json!({}))
            } else {
                let result = match body["method"].as_str().unwrap() {
                    "initialize" => {
                        json!({"protocolVersion":"2025-11-25","serverInfo":{"name":"oauth-fixture","version":"1"},"capabilities":{"tools":{}}})
                    }
                    "tools/list" => {
                        json!({"tools":[{"name":"echo","inputSchema":{"type":"object","properties":{}}}]})
                    }
                    "tools/call" => {
                        json!({"content":[{"type":"text","text":format!("served with {token}")}]})
                    }
                    _ => json!({}),
                };
                (
                    200,
                    json!({"jsonrpc":"2.0","id":body["id"],"result":result}),
                )
            }
        }
        _ => (404, json!({})),
    };
    let payload = if status == 202 {
        String::new()
    } else {
        payload.to_string()
    };
    let challenge = if challenge {
        format!(
            "WWW-Authenticate: Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource\"\r\n"
        )
    } else {
        String::new()
    };
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{challenge}Connection: close\r\n\r\n{payload}",
                payload.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

fn store() -> Store {
    Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([7; 16], 1),
    )
    .unwrap()
}

fn client() -> Value {
    serde_json::from_str(CLIENT).unwrap()
}

async fn credential(
    credentials: &credential::Service,
    server: &Server,
    id: &str,
    label: &str,
    access: &str,
    refresh: &str,
) -> credential::Info {
    let integration = server.integration();
    let value = oauth::to_credential(
        &integration,
        &server.remote().url,
        &json!({"access_token":access,"refresh_token":refresh,"token_type":"Bearer"}),
        Some(&client()),
        1,
    )
    .unwrap();
    credentials
        .create(id.into(), integration, Some(label.into()), value, 1)
        .await
        .unwrap()
}

struct Stored {
    access: String,
    refresh: String,
    client: Option<Value>,
}
fn stored(credentials: &credential::Service, id: &LosslessString) -> Option<Stored> {
    let info = credentials.get(id).unwrap()?;
    let ycoding_schema::credential::Value::OAuth(value) = info.secret().domain().unwrap() else {
        unreachable!()
    };
    let metadata = value
        .metadata
        .map(|metadata| serde_json::from_str::<Value>(&stringify_json(&metadata.encode())))
        .transpose()
        .unwrap();
    Some(Stored {
        access: value.access.as_str().unwrap().to_owned(),
        refresh: value.refresh.as_str().unwrap().to_owned(),
        client: metadata.and_then(|metadata| metadata.get("client").cloned()),
    })
}
fn assert_stored(
    credentials: &credential::Service,
    id: &LosslessString,
    access: &str,
    refresh: &str,
) {
    let stored = stored(credentials, id).expect("credential is stored");
    assert_eq!(stored.access, access);
    assert_eq!(stored.refresh, refresh);
    assert_eq!(stored.client, Some(client()));
}

async fn connect(server: &Server, credentials: &credential::Service) -> Result<Connection, Error> {
    Connection::connect(
        NAME,
        &server.config(),
        &std::env::temp_dir(),
        "1",
        &BTreeMap::new(),
        Hooks {
            credentials: Some(credentials.clone()),
            ..Hooks::default()
        },
    )
    .await
}

async fn echo(connection: &Connection) -> Vec<String> {
    connection
        .call_tool("echo", json!({}), None)
        .await
        .unwrap()
        .content
        .into_iter()
        .filter_map(|part| match part {
            Content::Text(text) => Some(text),
            Content::Media { .. } => None,
        })
        .collect()
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("MCP OAuth rotation scenario exceeded 30 seconds")
}

#[tokio::test]
async fn rejected_access_token_refreshes_and_keeps_refresh_token_a_non_rotating_server_did_not_return()
 {
    bounded(async {
        let server = Server::new(false, &[], &["refresh-0"]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let info = credential(
            &credentials,
            &server,
            "credential",
            "default",
            "expired",
            "refresh-0",
        )
        .await;
        let connection = connect(&server, &credentials).await.unwrap();
        assert_eq!(server.refresh_requests(), ["refresh-0"]);
        assert_stored(&credentials, info.id(), "access-1", "refresh-0");
        connection.close().await.unwrap();
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}

#[tokio::test]
async fn each_rotated_refresh_token_is_persisted_and_refreshed_again_mid_session() {
    bounded(async {
        let server = Server::new(true, &[], &["refresh-0"]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let info = credential(
            &credentials,
            &server,
            "credential",
            "default",
            "expired",
            "refresh-0",
        )
        .await;
        let connection = connect(&server, &credentials).await.unwrap();
        assert_stored(&credentials, info.id(), "access-1", "refresh-1");
        server.revoke_access();
        assert_eq!(echo(&connection).await, ["served with access-2"]);
        assert_eq!(server.refresh_requests(), ["refresh-0", "refresh-1"]);
        assert_stored(&credentials, info.id(), "access-2", "refresh-2");
        connection.close().await.unwrap();
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}

#[tokio::test]
async fn connection_holding_a_superseded_token_adopts_another_connections_rotation() {
    bounded(async {
        let server = Server::new(true, &["access-0"], &["refresh-0"]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let info = credential(
            &credentials,
            &server,
            "credential",
            "default",
            "access-0",
            "refresh-0",
        )
        .await;
        let first = connect(&server, &credentials).await.unwrap();
        let second = connect(&server, &credentials).await.unwrap();
        server.state.lock().unwrap().access.remove("access-0");
        assert_eq!(echo(&first).await, ["served with access-1"]);
        let rejected = server.state.lock().unwrap().unauthorized;
        assert_eq!(echo(&second).await, ["served with access-1"]);
        assert_eq!(server.state.lock().unwrap().unauthorized, rejected);
        assert_eq!(server.refresh_requests(), ["refresh-0"]);
        assert_stored(&credentials, info.id(), "access-1", "refresh-1");
        first.close().await.unwrap();
        second.close().await.unwrap();
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}

#[tokio::test]
async fn concurrent_requests_on_one_connection_rejected_together_share_one_exchange() {
    bounded(async {
        let server = Server::new(true, &["access-0"], &["refresh-0"]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let info = credential(
            &credentials,
            &server,
            "credential",
            "default",
            "access-0",
            "refresh-0",
        )
        .await;
        let connection = connect(&server, &credentials).await.unwrap();
        server.revoke_access();
        let (first, second) = tokio::join!(echo(&connection), echo(&connection));
        assert_eq!(first, ["served with access-1"]);
        assert_eq!(second, ["served with access-1"]);
        assert_eq!(server.refresh_requests(), ["refresh-0"]);
        assert_stored(&credentials, info.id(), "access-1", "refresh-1");
        connection.close().await.unwrap();
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}

#[tokio::test]
async fn concurrent_requests_on_different_connections_share_one_exchange_of_a_single_use_token() {
    bounded(async {
        let server = Server::new(true, &["access-0"], &["refresh-0"]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let info = credential(
            &credentials,
            &server,
            "credential",
            "default",
            "access-0",
            "refresh-0",
        )
        .await;
        let first = connect(&server, &credentials).await.unwrap();
        let second = connect(&server, &credentials).await.unwrap();
        server.revoke_access();
        server.state.lock().unwrap().discovery = Some(Arc::new(Barrier::new(2)));
        let (one, two) = tokio::join!(echo(&first), echo(&second));
        assert_eq!(one, ["served with access-1"]);
        assert_eq!(two, ["served with access-1"]);
        assert_eq!(server.refresh_requests(), ["refresh-0"]);
        assert_stored(&credentials, info.id(), "access-1", "refresh-1");
        first.close().await.unwrap();
        second.close().await.unwrap();
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}

#[tokio::test]
async fn refresh_with_a_token_this_process_already_exchanged_reuses_that_exchange() {
    bounded(async {
        let server = Server::new(true, &["access-0"], &["refresh-0"]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let stale = credential(
            &credentials,
            &server,
            "credential",
            "default",
            "access-0",
            "refresh-0",
        )
        .await;
        let config = server.remote();
        let first = oauth::refresh(&credentials, &stale, &config).await.unwrap();
        assert_stored(&credentials, first.id(), "access-1", "refresh-1");
        let second = oauth::refresh(&credentials, &stale, &config).await.unwrap();
        assert_eq!(server.refresh_requests(), ["refresh-0"]);
        assert_stored(&credentials, second.id(), "access-1", "refresh-1");
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}

#[tokio::test]
async fn presenting_the_rotated_token_ends_the_reuse_and_a_later_stale_refresh_adopts_the_stored_replacement()
 {
    bounded(async {
        let server = Server::new(true, &["access-0"], &["refresh-0"]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let stale = credential(
            &credentials,
            &server,
            "credential",
            "default",
            "access-0",
            "refresh-0",
        )
        .await;
        let config = server.remote();
        let first = oauth::refresh(&credentials, &stale, &config).await.unwrap();
        let second = oauth::refresh(&credentials, &first, &config).await.unwrap();
        assert_eq!(server.refresh_requests(), ["refresh-0", "refresh-1"]);
        assert_stored(&credentials, second.id(), "access-2", "refresh-2");
        let third = oauth::refresh(&credentials, &stale, &config).await.unwrap();
        assert_eq!(
            server.refresh_requests(),
            ["refresh-0", "refresh-1", "refresh-0", "refresh-2"]
        );
        assert_stored(&credentials, third.id(), "access-3", "refresh-3");
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}

#[tokio::test]
async fn refresh_rejected_because_another_process_rotated_first_retries_with_the_stored_rotation() {
    bounded(async {
        let server = Server::new(true, &[], &["refresh-0"]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let info = credential(&credentials, &server, "credential", "default", "expired", "refresh-0").await;
        let hook: Hook = {
            let state = server.state.clone();
            let credentials = credentials.clone();
            let id = info.id().clone();
            let integration = server.integration();
            let url = server.remote().url;
            Arc::new(move |presented| {
                let state = state.clone();
                let credentials = credentials.clone();
                let id = id.clone();
                let integration = integration.clone();
                let url = url.clone();
                Box::pin(async move {
                    if presented != "refresh-0" {
                        return;
                    }
                    {
                        let mut state = state.lock().unwrap();
                        state.refresh.remove("refresh-0");
                        state.refresh.insert("refresh-other".into());
                    }
                    let value = oauth::to_credential(
                        &integration,
                        &url,
                        &json!({"access_token":"expired-other","refresh_token":"refresh-other","token_type":"Bearer"}),
                        Some(&client()),
                        2,
                    )
                    .unwrap();
                    credentials.update(id, None, Some(value), 2).await.unwrap();
                })
            })
        };
        server.state.lock().unwrap().hook = Some(hook);
        let connection = connect(&server, &credentials).await.unwrap();
        assert_eq!(server.refresh_requests(), ["refresh-0", "refresh-other"]);
        assert_stored(&credentials, info.id(), "access-1", "refresh-1");
        connection.close().await.unwrap();
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}

#[tokio::test]
async fn rejected_refresh_of_the_latest_stored_token_removes_it_and_reports_needs_auth() {
    bounded(async {
        let server = Server::new(true, &[], &[]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let info = credential(
            &credentials,
            &server,
            "credential",
            "default",
            "expired",
            "revoked",
        )
        .await;
        let connection = connect(&server, &credentials).await;
        assert_eq!(connection.err(), Some(Error::NeedsAuth(NAME.into())));
        assert_eq!(server.refresh_requests(), ["revoked"]);
        assert!(credentials.get(info.id()).unwrap().is_none());
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}

#[tokio::test]
async fn connects_with_the_active_profile_when_the_integration_stores_several() {
    bounded(async {
        let server = Server::new(true, &["access-work"], &[]).await;
        let store = store();
        let credentials = credential::Service::new(store.client());
        let personal = credential(
            &credentials,
            &server,
            "personal",
            "personal",
            "revoked",
            "revoked",
        )
        .await;
        let work = credential(
            &credentials,
            &server,
            "work",
            "work",
            "access-work",
            "refresh-work",
        )
        .await;
        let connection = connect(&server, &credentials).await.unwrap();
        assert_eq!(echo(&connection).await, ["served with access-work"]);
        assert!(server.refresh_requests().is_empty());
        assert_eq!(
            stored(&credentials, personal.id()).unwrap().access,
            "revoked"
        );
        assert_eq!(
            stored(&credentials, work.id()).unwrap().access,
            "access-work"
        );
        connection.close().await.unwrap();
        credentials.shutdown().await.unwrap();
        server.close().await;
    })
    .await;
}
