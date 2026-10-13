use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};
use ycoding_core::resources::{
    credential,
    mcp::client::{Connection, Hooks},
};
use ycoding_schema::{DomainDecode, mcp::ServerConfig, parse_json};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

struct Server {
    url: String,
    state: Arc<Mutex<State>>,
    task: JoinHandle<()>,
}
#[derive(Default)]
struct State {
    requests: Vec<(String, String, String, Value)>,
    verifier: Option<String>,
    rejected_refresh: bool,
    unsafe_endpoint: bool,
    registered_tools: bool,
    challenge_override: bool,
    reject_next: bool,
    always_reject: bool,
    same_token: bool,
    opaque_issuer: bool,
    malformed_metadata: bool,
    malformed_registration: bool,
    resource_fault: Option<&'static str>,
    issuer_dialect_path: bool,
    scope_challenges: Vec<String>,
    response_scope: Option<String>,
    iss_supported: bool,
}
impl Server {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let base = url.clone();
        let state = Arc::new(Mutex::new(State::default()));
        let observed = state.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    incoming = listener.accept() => {
                        let (mut stream, _) = incoming.unwrap();
                        let state = observed.clone(); let base = base.clone();
                        connections.spawn(async move {
                            let mut request = Vec::new(); let mut buffer = [0; 4096];
                            let end = loop { let len = stream.read(&mut buffer).await.unwrap(); if len == 0 { return; } request.extend_from_slice(&buffer[..len]); if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") { break end + 4; } };
                            let headers = String::from_utf8(request[..end].to_vec()).unwrap();
                            let mut parts = headers.split_whitespace(); let method = parts.next().unwrap(); let path = parts.next().unwrap();
                            let len = headers.lines().find_map(|line| line.split_once(':').filter(|(key, _)| key.eq_ignore_ascii_case("content-length")).map(|(_, value)| value.trim().parse::<usize>().unwrap())).unwrap_or(0);
                            while request.len() < end + len { let len = stream.read(&mut buffer).await.unwrap(); assert_ne!(len, 0); request.extend_from_slice(&buffer[..len]); }
                            let raw = String::from_utf8(request[end..end+len].to_vec()).unwrap();
                            let body = serde_json::from_str(&raw).unwrap_or(Value::Null);
                            let (status, body) = {
                                let mut state = state.lock().unwrap(); state.requests.push((method.into(), path.into(), headers.clone(), if body.is_null() { json!(raw) } else { body.clone() }));
                                match path {
                                    "/.well-known/oauth-protected-resource/mcp" | "/challenge-meta" if state.resource_fault==Some("server") => (503,json!({})),
                                    "/.well-known/oauth-protected-resource/mcp" | "/challenge-meta" if state.resource_fault==Some("malformed") => (200,json!({"resource":1})),
                                    "/.well-known/oauth-protected-resource/mcp" | "/challenge-meta" => (200, json!({"resource":format!("{base}/mcp"),"authorization_servers":[format!("{base}/issuer{}",if state.issuer_dialect_path {"/openid-configuration"} else {""})],"scopes_supported":["tools"]})),
                                    "/.well-known/oauth-authorization-server/issuer" | "/.well-known/oauth-authorization-server/issuer/openid-configuration" | "/.well-known/oauth-authorization-server" => (200, json!({"issuer":if state.opaque_issuer {"opaque-issuer".to_owned()} else {format!("{base}/issuer")},"authorization_endpoint":if state.unsafe_endpoint { "javascript:alert(1)".to_owned() } else { format!("{base}/authorize") },"token_endpoint":format!("{base}/token"),"registration_endpoint":format!("{base}/register"),"response_types_supported":if state.malformed_metadata {json!(["code",1])} else {json!(["code"])},"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none","client_secret_post","client_secret_basic"],"scopes_supported":["tools","offline_access"],"authorization_response_iss_parameter_supported":state.iss_supported})),
                                    "/register" => (201, json!({"client_id":"fixture-client","client_secret":"fixture-client-secret","token_endpoint_auth_method":"client_secret_post","redirect_uris":if state.malformed_registration {json!("invalid")} else {body["redirect_uris"].clone()},"unknown_registration_field":"must-be-discarded"})),
                                    "/token" => {
                                        let form: BTreeMap<_,_> = url::form_urlencoded::parse(raw.as_bytes()).into_owned().collect();
                                        if form.get("grant_type").map(String::as_str) == Some("refresh_token") {
                                            if state.rejected_refresh { (400, json!({"error":"invalid_grant","error_description":"fixture rejected"})) } else { (200, json!({"access_token":if state.same_token {"fixture-access"} else {"fixture-fresh"},"token_type":"Bearer","expires_in":3600})) }
                                        } else if form.get("code_verifier").map(|verifier| ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()).as_ref().to_vec()) != state.verifier.as_ref().map(|value| decode_url_base64(value)) {
                                            (400, json!({"error":"invalid_grant"}))
                                        } else { (200, json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"Bearer","expires_in":3600,"scope":"tools offline_access"})) }
                                    },
                                    "/mcp" if body["method"]=="prompts/get" && !state.scope_challenges.is_empty() => {state.response_scope=Some(state.scope_challenges.remove(0));(403,json!({}))},
                                    "/mcp" if state.always_reject || state.reject_next || !headers.lines().any(|line| line.eq_ignore_ascii_case("authorization: Bearer fixture-fresh") || line.eq_ignore_ascii_case("authorization: Bearer fixture-access")) => { state.reject_next=false; (401, json!({})) },
                                    "/mcp" if body.get("id").is_none() => (202, json!({})),
                                    "/mcp" => (200, json!({"jsonrpc":"2.0","id":body["id"],"result": match body["method"].as_str().unwrap() {"initialize"=>json!({"protocolVersion":"2025-11-25","serverInfo":{"name":"auth-fixture","version":"1"},"capabilities":if state.registered_tools {json!({"tools":{},"prompts":{}})} else {json!({})}}), "tools/list"=>json!({"tools":[]}), "prompts/list"=>json!({"prompts":[]}), "prompts/get"=>json!({"messages":[{"role":"user","content":{"type":"text","text":"ok"}}]}), _=>json!({})}})),
                                    _ => (404, json!({})),
                                }
                            };
                            let raw = if status == 202 { String::new() } else { body.to_string() };
                            if matches!(path,"/.well-known/oauth-protected-resource/mcp" | "/challenge-meta") && state.lock().unwrap().resource_fault==Some("network") {return;}
                            let challenge={let mut state=state.lock().unwrap();if let Some(scope)=state.response_scope.take() {format!("Bearer error=\"insufficient_scope\", resource_metadata=\"{base}/challenge-meta\", scope=\"{scope}\"")} else if state.challenge_override {format!("Bearer resource_metadata=\"{base}/challenge-meta\", scope=\"challenge\"")} else {format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\"")}};
                            stream.write_all(format!("HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nWWW-Authenticate: {challenge}\r\nConnection: close\r\n\r\n{raw}", raw.len()).as_bytes()).await.unwrap();
                        });
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
    async fn close(self) {
        self.task.abort();
        assert!(self.task.await.unwrap_err().is_cancelled());
    }
}
fn store() -> Store {
    Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([7; 16], 1),
    )
    .unwrap()
}
fn decode_url_base64(value: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bits = 0u32;
    let mut count = 0;
    let mut bytes = Vec::new();
    for byte in value.bytes() {
        bits = (bits << 6)
            | alphabet
                .iter()
                .position(|candidate| *candidate == byte)
                .unwrap() as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
        }
    }
    bytes
}

#[tokio::test]
async fn dynamic_registration_pkce_callback_and_credential_persistence() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let attempt = oauth::authorize("oauth-server", &config).await.unwrap();
    let url = url::Url::parse(attempt.url()).unwrap();
    let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["client_id"], "fixture-client");
    assert_eq!(params["response_type"], "code");
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["resource"], format!("{}/mcp", server.url));
    assert_eq!(params["scope"], "tools offline_access");
    assert_eq!(params["prompt"], "consent");
    let verifier = params["code_challenge"].clone();
    server.state.lock().unwrap().verifier = Some(verifier);
    let registration = server
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .find(|(_, path, _, _)| path == "/register")
        .unwrap()
        .3
        .clone();
    assert_eq!(
        registration,
        json!({"client_name":"ycoding","redirect_uris":[params["redirect_uri"]],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":"native","scope":"tools offline_access"})
    );
    let mut callback = url::Url::parse(&params["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("state", &params["state"])
        .append_pair("code", "fixture-code");
    let (result, response) = tokio::join!(
        attempt.finish(),
        reqwest::Client::new().get(callback).send()
    );
    assert!(response.unwrap().status().is_success());
    let value = result.unwrap();
    let domain = value.domain().unwrap();
    let ycoding_schema::credential::Value::OAuth(domain) = domain else {
        unreachable!()
    };
    assert_eq!(domain.access.as_str(), Some("fixture-access"));
    assert_eq!(domain.refresh.as_str(), Some("fixture-refresh"));
    let tokens = oauth::to_tokens(&domain, oauth::now()).unwrap();
    let ycoding_schema::JsonValue::Object(client) = domain
        .metadata
        .as_ref()
        .unwrap()
        .get(&"client".into())
        .unwrap()
    else {
        unreachable!()
    };
    assert!(client.get(&"unknown_registration_field".into()).is_none());
    assert_eq!(tokens["token_type"], "Bearer");
    assert!(tokens["expires_in"].as_u64().unwrap() <= 3600);
    let store = store();
    let credentials = credential::Service::new(store.client());
    let info = credentials
        .create(
            "fixture-login".into(),
            oauth::integration_id("oauth-server", &config.url).unwrap(),
            None,
            value,
            oauth::now(),
        )
        .await
        .unwrap();
    assert_eq!(
        credentials.get(info.id()).unwrap().unwrap().secret(),
        info.secret()
    );
    let token_request = server
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .find(|(_, path, _, _)| path == "/token")
        .unwrap()
        .3
        .as_str()
        .unwrap()
        .to_owned();
    let form: BTreeMap<_, _> = url::form_urlencoded::parse(token_request.as_bytes())
        .into_owned()
        .collect();
    assert_eq!(form["client_secret"], "fixture-client-secret");
    assert_eq!(form["code"], "fixture-code");
    assert_eq!(form["resource"], format!("{}/mcp", server.url));
    assert_eq!(form["code_verifier"].len(), 43);
    assert_ne!(form["code_verifier"], params["code_challenge"]);
    credentials.shutdown().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn callback_state_mismatch_never_exchanges_or_persists_tokens() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let attempt = oauth::authorize("oauth-server", &config).await.unwrap();
    let url = url::Url::parse(attempt.url()).unwrap();
    let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let mut callback = url::Url::parse(&params["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("state", "wrong-state")
        .append_pair("code", "fixture-code");
    let (result, response) = tokio::join!(
        attempt.finish(),
        reqwest::Client::new().get(callback).send()
    );
    assert_eq!(response.unwrap().status(), 400);
    assert!(matches!(result, Err(oauth::Error::StateMismatch)));
    assert!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(_, path, _, _)| path != "/token")
    );
    server.close().await;
}

#[tokio::test]
async fn refresh_rotates_same_credential_preserves_refresh_and_invalidates_rejection() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let store = store();
    let credentials = credential::Service::new(store.client());
    let id = oauth::integration_id("oauth-server", &config.url).unwrap();
    let value = oauth::to_credential(&id, &config.url, &json!({"access_token":"fixture-expired","refresh_token":"fixture-refresh","token_type":"Bearer","expires_in":1}), Some(&json!({"client_id":"fixture-client","client_secret":"fixture-client-secret","token_endpoint_auth_method":"client_secret_post"})), 1).unwrap();
    let info = credentials
        .create("fixture-refresh-id".into(), id, None, value, 1)
        .await
        .unwrap();
    let refreshed = oauth::refresh(&credentials, &info, &config).await.unwrap();
    assert_eq!(refreshed.id(), info.id());
    let ycoding_schema::credential::Value::OAuth(value) = refreshed.secret().domain().unwrap()
    else {
        unreachable!()
    };
    assert_eq!(value.access.as_str(), Some("fixture-fresh"));
    assert_eq!(value.refresh.as_str(), Some("fixture-refresh"));
    assert_eq!(
        oauth::to_tokens(&value, oauth::now()).unwrap()["issuer"],
        format!("{}/issuer", server.url)
    );
    assert!(value.metadata.unwrap().get(&"client".into()).is_some());
    server.state.lock().unwrap().rejected_refresh = true;
    assert!(matches!(
        oauth::refresh(&credentials, &refreshed, &config).await,
        Err(oauth::Error::NeedsAuth)
    ));
    assert!(credentials.get(info.id()).unwrap().is_none());
    credentials.shutdown().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn malformed_stored_client_information_is_rejected_without_exchange_or_credential_changes() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let store = store();
    let credentials = credential::Service::new(store.client());
    let id = oauth::integration_id("oauth-server", &config.url).unwrap();
    for (index, client) in [
        json!("malformed-client"),
        json!([{"client_id":"fixture-client"}]),
    ]
    .into_iter()
    .enumerate()
    {
        let value = oauth::to_credential(
            &id,
            &config.url,
            &json!({"access_token":"fixture-expired","refresh_token":"fixture-refresh","token_type":"Bearer"}),
            Some(&client),
            1,
        ).unwrap();
        let info = credentials
            .create(
                format!("fixture-client-shape-{index}").into(),
                id.clone(),
                None,
                value,
                1,
            )
            .await
            .unwrap();
        assert!(matches!(
            oauth::refresh(&credentials, &info, &config).await,
            Err(oauth::Error::InvalidConfiguration)
        ));
        assert_eq!(
            credentials.get(info.id()).unwrap().unwrap().generation(),
            info.generation()
        );
    }
    assert!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(_, path, _, _)| !["/register", "/token"].contains(&path.as_str()))
    );
    credentials.shutdown().await.unwrap();
    server.close().await;
}

#[test]
fn unknown_expiry_and_metadata_match_typescript_credential_conversion() {
    use ycoding_core::resources::mcp::oauth;
    let value = oauth::to_credential(
        &"fixture".into(),
        &"https://example.test/mcp".into(),
        &json!({"access_token":"fixture-access","token_type":"Custom"}),
        None,
        1234,
    )
    .unwrap();
    let ycoding_schema::credential::Value::OAuth(value) = value.domain().unwrap() else {
        unreachable!()
    };
    assert_eq!(value.expires.get(), 0);
    assert!(value.refresh.is_empty());
    assert_eq!(
        oauth::to_tokens(&value, 12345).unwrap(),
        json!({"access_token":"fixture-access","token_type":"Custom"})
    );
}

#[test]
fn sdk_expiry_coercion_preserves_fractional_seconds_and_numeric_strings() {
    use ycoding_core::resources::mcp::oauth;
    for (expires, expected) in [
        (json!(1.5), 2734),
        (json!("3600"), 3_601_234),
        (json!(0), 0),
        (json!(true), 2234),
        (json!(null), 0),
        (json!("0x10"), 17_234),
        (json!("-1"), 234),
        (json!([]), 0),
        (json!([["1.5"]]), 2734),
    ] {
        let value = oauth::to_credential(
            &"fixture".into(),
            &"https://example.test/mcp".into(),
            &json!({"access_token":"fixture-access","token_type":"Bearer","expires_in":expires}),
            None,
            1234,
        )
        .unwrap();
        let ycoding_schema::credential::Value::OAuth(value) = value.domain().unwrap() else {
            unreachable!()
        };
        assert_eq!(value.expires.get(), expected);
    }
    for expires in [json!([true]), json!([1, 2]), json!({}), json!("NaN")] {
        assert!(oauth::to_credential(&"fixture".into(), &"https://example.test/mcp".into(), &json!({"access_token":"fixture-access","token_type":"Bearer","expires_in":expires}), None,1234).is_err());
    }
}

#[tokio::test]
async fn unsafe_authorization_url_is_rejected_before_registration_or_redirect() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    server.state.lock().unwrap().unsafe_endpoint = true;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    assert!(matches!(
        oauth::authorize("oauth-server", &config).await,
        Err(oauth::Error::Discovery)
    ));
    assert!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(_, path, _, _)| path != "/register")
    );
    server.close().await;
}

#[tokio::test]
async fn initialization_challenge_refreshes_and_reconnects_once() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let store = store();
    let credentials = credential::Service::new(store.client());
    let id = oauth::integration_id("oauth-server", &config.url).unwrap();
    let value = oauth::to_credential(&id, &config.url, &json!({"access_token":"fixture-expired","refresh_token":"fixture-refresh","token_type":"Bearer","expires_in":1}), Some(&json!({"client_id":"fixture-client","client_secret":"fixture-client-secret","token_endpoint_auth_method":"client_secret_post"})), 1).unwrap();
    let info = credentials
        .create("fixture-expired-id".into(), id, None, value, 1)
        .await
        .unwrap();
    let connection = Connection::connect(
        "oauth-server",
        &ServerConfig::Remote(config),
        &std::env::temp_dir(),
        "1",
        &BTreeMap::new(),
        Hooks {
            credentials: Some(credentials.clone()),
            ..Hooks::default()
        },
    )
    .await
    .unwrap();
    let requests = server.state.lock().unwrap().requests.clone();
    assert_eq!(
        requests
            .iter()
            .filter(|(_, path, _, _)| path == "/token")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(_, path, _, body)| path == "/mcp" && body["method"] == "initialize")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(_, path, _, body)| path == "/mcp" && body["method"] == "server/discover")
            .count(),
        2
    );
    let ycoding_schema::credential::Value::OAuth(value) = credentials
        .get(info.id())
        .unwrap()
        .unwrap()
        .secret()
        .domain()
        .unwrap()
    else {
        unreachable!()
    };
    assert_eq!(value.access.as_str(), Some("fixture-fresh"));
    connection.close().await.unwrap();
    credentials.shutdown().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn static_client_skips_registration_and_uses_basic_authentication() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    let ServerConfig::Remote(mut config) = server.config() else {
        unreachable!()
    };
    config.oauth = Some(ycoding_schema::mcp::OAuth::Config(
        ycoding_schema::mcp::OAuthConfig {
            client_id: Some("static-client".into()),
            client_secret: Some("fixture-static-secret".into()),
            scope: Some("configured".into()),
            callback_port: None,
            redirect_uri: None,
        },
    ));
    let attempt = oauth::authorize("oauth-server", &config).await.unwrap();
    assert_eq!(format!("{attempt:?}"), "McpOAuthAttempt([redacted])");
    let params: BTreeMap<_, _> = url::Url::parse(attempt.url())
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    assert_eq!(params["scope"], "configured offline_access");
    assert_eq!(params["client_id"], "static-client");
    server.state.lock().unwrap().verifier = Some(params["code_challenge"].clone());
    let mut callback = url::Url::parse(&params["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("state", &params["state"])
        .append_pair("code", "fixture-code");
    let (result, response) = tokio::join!(
        attempt.finish(),
        reqwest::Client::new().get(callback).send()
    );
    assert!(response.unwrap().status().is_success());
    let ycoding_schema::credential::Value::OAuth(value) = result.unwrap().domain().unwrap() else {
        unreachable!()
    };
    assert!(value.metadata.unwrap().get(&"client".into()).is_none());
    let requests = server.state.lock().unwrap().requests.clone();
    assert!(requests.iter().all(|(_, path, _, _)| path != "/register"));
    let token = requests
        .iter()
        .find(|(_, path, _, _)| path == "/token")
        .unwrap();
    assert!(token.2.lines().any(|line| line.eq_ignore_ascii_case(
        "authorization: Basic c3RhdGljLWNsaWVudDpmaXh0dXJlLXN0YXRpYy1zZWNyZXQ="
    )));
    let form: BTreeMap<_, _> = url::form_urlencoded::parse(token.3.as_str().unwrap().as_bytes())
        .into_owned()
        .collect();
    assert!(!form.contains_key("client_secret"));
    server.close().await;
}

#[tokio::test]
async fn unauthenticated_connection_reports_needs_auth_without_browser_or_token_exchange() {
    use ycoding_core::resources::mcp::{client::Error, oauth};
    let server = Server::new().await;
    server.state.lock().unwrap().challenge_override = true;
    let store = store();
    let credentials = credential::Service::new(store.client());
    let connection = Connection::connect(
        "oauth-server",
        &server.config(),
        &std::env::temp_dir(),
        "1",
        &BTreeMap::new(),
        Hooks {
            credentials: Some(credentials.clone()),
            ..Hooks::default()
        },
    )
    .await;
    assert_eq!(
        connection.err(),
        Some(Error::NeedsAuth("oauth-server".into()))
    );
    let requests = server.state.lock().unwrap().requests.clone();
    assert!(
        requests
            .iter()
            .all(|(_, path, _, _)| path != "/token" && path != "/authorize")
    );
    let registrations = requests
        .iter()
        .filter(|(_, path, _, _)| path == "/register")
        .collect::<Vec<_>>();
    assert_eq!(registrations.len(), 1);
    assert_eq!(
        registrations[0].3["redirect_uris"],
        json!(["http://127.0.0.1/callback"])
    );
    assert_eq!(registrations[0].3["scope"], "challenge offline_access");
    let ServerConfig::Remote(mut config) = server.config() else {
        unreachable!()
    };
    config.oauth = Some(ycoding_schema::mcp::OAuth::Disabled);
    assert!(matches!(
        oauth::authorize("oauth-server", &config).await,
        Err(oauth::Error::Disabled)
    ));
    credentials.shutdown().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn connect_presents_persisted_oauth_without_opening_a_browser() {
    let server = Server::new().await;
    let store = store();
    let credentials = credential::Service::new(store.client());
    let name = "oauth-server";
    let id = format!(
        "mcp_{}",
        ring::digest::digest(
            &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
            format!("{name}\0{}/mcp", server.url).as_bytes()
        )
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()[..16]
            .to_owned()
    );
    credentials.create("fixture-credential".into(), id.clone().into(), None, resources::Secret::new(parse_json(&json!({"type":"oauth","methodID":id,"access":"fixture-access","refresh":"fixture-refresh","expires":0,"metadata":{"serverUrl":format!("{}/mcp",server.url),"tokenType":"Bearer","client":{"client_id":"fixture-client"}}}).to_string()).unwrap()).unwrap(),1).await.unwrap();
    let connection = Connection::connect(
        name,
        &server.config(),
        &std::env::temp_dir(),
        "1",
        &BTreeMap::new(),
        Hooks {
            credentials: Some(credentials.clone()),
            ..Hooks::default()
        },
    )
    .await;
    assert!(
        connection.is_ok(),
        "stored credential was not presented: {:?}",
        connection.as_ref().err()
    );
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, path, _, _)| path.contains("well-known") || path == "/token")
            .count(),
        0
    );
    connection.unwrap().close().await.unwrap();
    credentials.shutdown().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn integration_registration_owns_methods_and_reconnects_on_credential_changes() {
    use ycoding_core::resources::{
        auth::integration::Registry,
        mcp::{Event, Service, oauth},
    };
    use ycoding_schema::{DomainEncode, mcp::Status};
    let server = Server::new().await;
    server.state.lock().unwrap().registered_tools = true;
    let store = store();
    let credentials = credential::Service::new(store.client());
    let registry = Registry::new(credentials.clone(), BTreeMap::new());
    let config = server.config();
    let entries = [ycoding_core::resources::config::Entry::Document { path: None, info: parse_json(&json!({"mcp":{"servers":{"first":serde_json::from_str::<Value>(&ycoding_schema::stringify_json(&config.encode())).unwrap()}}}).to_string()).unwrap() }];
    let service = Service::new(
        &entries,
        std::env::temp_dir(),
        "1".into(),
        BTreeMap::new(),
        Hooks {
            credentials: Some(credentials.clone()),
            integrations: Some(registry.clone()),
            ..Hooks::default()
        },
    )
    .unwrap();
    service.tools().await.unwrap();
    let ServerConfig::Remote(remote) = &config else {
        unreachable!()
    };
    let id = oauth::integration_id("first", &remote.url).unwrap();
    let integration = registry.get(&id).unwrap();
    assert!(
        integration.is_some(),
        "MCP did not register its OAuth integration"
    );
    let integration = integration.unwrap();
    assert_eq!(integration.name.as_str(), Some("first"));
    assert_eq!(integration.methods.len(), 1);
    assert!(
        matches!(&integration.methods[0], ycoding_schema::integration::Method::OAuth(method) if method.id.as_lossless() == &id && method.label.as_str() == Some("first"))
    );
    assert!(matches!(
        service.servers().unwrap()[0].status,
        Status::NeedsAuth
    ));
    assert_eq!(
        service.servers().unwrap()[0].integration_id.as_ref(),
        Some(&id)
    );
    assert!(service.servers().unwrap()[0].connection.is_none());
    let value = oauth::to_credential(&id,&remote.url,&json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"Bearer"}),Some(&json!({"client_id":"fixture-client"})),1).unwrap();
    let info = credentials
        .create("reconnect-fixture".into(), id.clone(), None, value, 1)
        .await
        .unwrap();
    let mut events = service.subscribe();
    registry.activate(info.id().clone(), 2).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if matches!(events.recv().await.unwrap(),Event::StatusChanged(name) if name == "first")
                && service.servers().unwrap()[0].status == Status::Connected
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, path, _, body)| path == "/mcp" && body["method"] == "initialize")
            .count(),
        1
    );
    assert!(matches!(
        service.servers().unwrap()[0].connection,
        Some(ycoding_schema::connection::Info::Credential(_))
    ));
    service.disconnect("first").await.unwrap();
    registry
        .update(info.id().clone(), Some("Renamed".into()), 3)
        .await
        .unwrap();
    assert!(
        matches!(&service.servers().unwrap()[0].connection,Some(ycoding_schema::connection::Info::Credential(value)) if value.label.as_str()==Some("Renamed")),
        "server snapshots must read current Integration metadata while disabled"
    );
    registry.activate(info.id().clone(), 3).await.unwrap();
    let mut registry_events = registry.subscribe();
    service.add("barrier", config.clone()).await.unwrap();
    let mut updates = 0;
    while let Ok(event) = registry_events.try_recv() {
        if event == ycoding_core::resources::auth::integration::Event::Updated {
            updates += 1;
        }
    }
    assert_eq!(
        updates, 1,
        "a new MCP registration must materialize exactly once"
    );
    assert_eq!(
        service
            .servers()
            .unwrap()
            .iter()
            .find(|info| info.name == "first")
            .unwrap()
            .status,
        Status::Disabled
    );
    service.remove("first").await.unwrap();
    assert!(registry.get(&id).unwrap().is_none());
    let replacement_id = oauth::integration_id("barrier", &remote.url).unwrap();
    assert!(registry.get(&replacement_id).unwrap().is_some());
    service.shutdown().await.unwrap();
    assert!(registry.get(&replacement_id).unwrap().is_none());
    registry.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn post_initialization_challenges_refresh_each_request_and_replay_equal_tokens() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let store = store();
    let credentials = credential::Service::new(store.client());
    let id = oauth::integration_id("oauth-server", &config.url).unwrap();
    let value=oauth::to_credential(&id,&config.url,&json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"Bearer"}),Some(&json!({"client_id":"fixture-client","client_secret":"fixture-client-secret","token_endpoint_auth_method":"client_secret_post"})),1).unwrap();
    credentials
        .create("per-request-fixture".into(), id, None, value, 1)
        .await
        .unwrap();
    let connection = Connection::connect(
        "oauth-server",
        &ServerConfig::Remote(config),
        &std::env::temp_dir(),
        "1",
        &BTreeMap::new(),
        Hooks {
            credentials: Some(credentials.clone()),
            ..Hooks::default()
        },
    )
    .await
    .unwrap();
    for _ in 0..2 {
        {
            let mut state = server.state.lock().unwrap();
            state.challenge_override = true;
            state.reject_next = true;
            state.same_token = true;
        }
        let result = connection.prompt("hello", json!({}), None).await;
        assert!(
            result.is_ok(),
            "post-initialization OAuth challenge was not recovered: {:?}",
            result.err()
        );
    }
    let requests = server.state.lock().unwrap().requests.clone();
    assert_eq!(
        requests
            .iter()
            .filter(|(_, path, _, _)| path == "/token")
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(_, path, _, _)| path == "/challenge-meta")
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(_, path, _, body)| path == "/mcp" && body["method"] == "prompts/get")
            .count(),
        4
    );
    server.state.lock().unwrap().always_reject = true;
    assert!(connection.prompt("hello", json!({}), None).await.is_err());
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, path, _, _)| path == "/token")
            .count(),
        3
    );
    server.state.lock().unwrap().always_reject = false;
    connection.close().await.unwrap();
    credentials.shutdown().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn callback_server_serves_html_before_finish_and_keeps_ownership_until_settlement() {
    use ycoding_core::resources::{auth::page, mcp::oauth};
    let server = Server::new().await;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let attempt = oauth::authorize("oauth-server", &config).await.unwrap();
    let params: BTreeMap<_, _> = url::Url::parse(attempt.url())
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    server.state.lock().unwrap().verifier = Some(params["code_challenge"].clone());
    let mut callback = url::Url::parse(&params["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("state", &params["state"])
        .append_pair("code", "fixture-code");
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        reqwest::Client::new().get(callback.clone()).send(),
    )
    .await;
    assert!(
        response.is_ok(),
        "callback server did not run independently of finish"
    );
    let response = response.unwrap().unwrap();
    assert_eq!(response.headers()["content-type"], "text/html");
    assert_eq!(
        response.text().await.unwrap(),
        page::success(Some("oauth-server"), true)
    );
    let mut wrong_path = callback.clone();
    wrong_path.set_path("/not-the-callback");
    assert_eq!(
        reqwest::Client::new()
            .get(wrong_path)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(_, path, _, _)| path != "/token")
    );
    assert!(attempt.finish().await.is_ok());
    let address = format!("127.0.0.1:{}", callback.port().unwrap());
    let released = TcpListener::bind(address).await.unwrap();
    drop(released);
    server.close().await;
}

#[tokio::test]
async fn sdk_metadata_and_registration_validation_accept_opaque_issuer_and_reject_wrong_fields() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    server.state.lock().unwrap().opaque_issuer = true;
    let attempt = oauth::authorize("oauth-server", &config).await;
    assert!(
        attempt.is_ok(),
        "SDK issuer strings do not require URL syntax"
    );
    attempt.unwrap().cancel().await.unwrap();
    server.state.lock().unwrap().malformed_metadata = true;
    assert!(matches!(
        oauth::authorize("oauth-server", &config).await,
        Err(oauth::Error::Discovery)
    ));
    {
        let mut state = server.state.lock().unwrap();
        state.malformed_metadata = false;
        state.malformed_registration = true;
    }
    assert!(matches!(
        oauth::authorize("oauth-server", &config).await,
        Err(oauth::Error::Registration)
    ));
    server.close().await;
}

#[tokio::test]
async fn protected_discovery_failures_use_the_sdk_authorization_server_fallback() {
    use ycoding_core::resources::mcp::oauth;
    for fault in ["server", "malformed", "network"] {
        let server = Server::new().await;
        server.state.lock().unwrap().resource_fault = Some(fault);
        let ServerConfig::Remote(config) = server.config() else {
            unreachable!()
        };
        let attempt = oauth::authorize("oauth-server", &config).await;
        assert!(
            attempt.is_ok(),
            "protected discovery failure must still discover the server's authorization endpoints"
        );
        assert!(
            server
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .any(|(_, path, _, _)| path == "/.well-known/oauth-authorization-server")
        );
        attempt.unwrap().cancel().await.unwrap();
        server.close().await;
    }
}

#[tokio::test]
async fn oauth_discovery_dialect_is_not_inferred_from_the_issuer_path() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    server.state.lock().unwrap().issuer_dialect_path = true;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let attempt = oauth::authorize("oauth-server", &config).await;
    assert!(
        attempt.is_ok(),
        "OAuth metadata was incorrectly validated as OIDC metadata"
    );
    attempt.unwrap().cancel().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn rejected_refresh_reauthorizes_and_different_scope_challenges_each_replay() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    let store = store();
    let credentials = credential::Service::new(store.client());
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let id = oauth::integration_id("oauth-server", &config.url).unwrap();
    let value=oauth::to_credential(&id,&config.url,&json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","token_type":"Bearer"}),Some(&json!({"client_id":"fixture-client","client_secret":"fixture-client-secret","token_endpoint_auth_method":"client_secret_post"})),1).unwrap();
    let info = credentials
        .create("scope-fixture".into(), id, None, value, 1)
        .await
        .unwrap();
    let connection = Connection::connect(
        "oauth-server",
        &ServerConfig::Remote(config),
        &std::env::temp_dir(),
        "1",
        &BTreeMap::new(),
        Hooks {
            credentials: Some(credentials.clone()),
            ..Hooks::default()
        },
    )
    .await
    .unwrap();
    server.state.lock().unwrap().scope_challenges = vec!["alpha".into(), "beta".into()];
    assert!(
        connection.prompt("hello", json!({}), None).await.is_ok(),
        "a different scope challenge must permit another upscoping attempt"
    );
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, path, _, _)| path == "/token")
            .count(),
        2
    );
    server.state.lock().unwrap().scope_challenges = vec!["same".into(), "same".into()];
    assert!(connection.prompt("hello", json!({}), None).await.is_err());
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, path, _, _)| path == "/token")
            .count(),
        3
    );
    {
        let mut state = server.state.lock().unwrap();
        state.rejected_refresh = true;
        state.reject_next = true;
    }
    assert!(connection.prompt("hello", json!({}), None).await.is_err());
    assert!(credentials.get(info.id()).unwrap().is_none());
    assert_eq!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, path, _, _)| path == "/register")
            .count(),
        1,
        "rejected refresh must repeat the SDK authorization handshake"
    );
    connection.close().await.unwrap();
    credentials.shutdown().await.unwrap();
    server.close().await;
}

#[tokio::test]
async fn refresh_token_recorded_for_a_different_authorization_server_is_not_presented() {
    use ycoding_core::resources::mcp::{client::Error, oauth};
    let server = Server::new().await;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let store = store();
    let credentials = credential::Service::new(store.client());
    let id = oauth::integration_id("oauth-server", &config.url).unwrap();
    let value = oauth::to_credential(&id, &config.url, &json!({"access_token":"fixture-expired","refresh_token":"fixture-refresh","token_type":"Bearer","issuer":"https://other.example"}), Some(&json!({"client_id":"fixture-client","client_secret":"fixture-client-secret","token_endpoint_auth_method":"client_secret_post"})), 1).unwrap();
    let info = credentials
        .create("fixture-other-issuer".into(), id, None, value, 1)
        .await
        .unwrap();
    let connection = Connection::connect(
        "oauth-server",
        &ServerConfig::Remote(config.clone()),
        &std::env::temp_dir(),
        "1",
        &BTreeMap::new(),
        Hooks {
            credentials: Some(credentials.clone()),
            ..Hooks::default()
        },
    )
    .await;
    assert_eq!(
        connection.err(),
        Some(Error::NeedsAuth("oauth-server".into()))
    );
    assert!(matches!(
        oauth::refresh(&credentials, &info, &config).await,
        Err(oauth::Error::NeedsAuth)
    ));
    assert!(
        server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(_, path, _, _)| path != "/token")
    );
    let ycoding_schema::credential::Value::OAuth(stored) = credentials
        .get(info.id())
        .unwrap()
        .unwrap()
        .secret()
        .domain()
        .unwrap()
    else {
        unreachable!()
    };
    assert_eq!(stored.refresh.as_str(), Some("fixture-refresh"));
    credentials.shutdown().await.unwrap();
    server.close().await;
}

async fn callback(
    server: &Server,
    query: impl Fn(&BTreeMap<String, String>) -> Vec<(String, String)>,
) -> (
    Result<resources::Secret, ycoding_core::resources::mcp::oauth::Error>,
    String,
) {
    use ycoding_core::resources::mcp::oauth;
    let ServerConfig::Remote(config) = server.config() else {
        unreachable!()
    };
    let attempt = oauth::authorize("oauth-server", &config).await.unwrap();
    let params: BTreeMap<String, String> = url::Url::parse(attempt.url())
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    server.state.lock().unwrap().verifier = Some(params["code_challenge"].clone());
    let mut target = url::Url::parse(&params["redirect_uri"]).unwrap();
    target.query_pairs_mut().extend_pairs(query(&params));
    let (result, response) = tokio::join!(attempt.finish(), reqwest::get(target));
    (result, response.unwrap().text().await.unwrap())
}

fn token_requests(server: &Server) -> usize {
    server
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|(_, path, _, _)| path == "/token")
        .count()
}

#[tokio::test]
async fn authorization_code_is_redeemed_only_when_the_callback_issuer_matches() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    server.state.lock().unwrap().iss_supported = true;
    let issuer = format!("{}/issuer", server.url);
    let answer = |iss: Option<&str>| {
        let iss = iss.map(str::to_owned);
        move |params: &BTreeMap<String, String>| {
            let mut query = vec![
                ("state".to_owned(), params["state"].clone()),
                ("code".to_owned(), "fixture-code".to_owned()),
            ];
            query.extend(iss.clone().map(|iss| ("iss".to_owned(), iss)));
            query
        }
    };
    let (result, _) = callback(&server, answer(Some(&issuer))).await;
    let ycoding_schema::credential::Value::OAuth(value) = result.unwrap().domain().unwrap() else {
        unreachable!()
    };
    let metadata: Value = serde_json::from_str(&ycoding_schema::stringify_json(
        &ycoding_schema::DomainEncode::encode(value.metadata.as_ref().unwrap()),
    ))
    .unwrap();
    assert_eq!(metadata["issuer"], issuer);
    assert_eq!(metadata["client"]["client_id"], "fixture-client");
    assert_eq!(metadata["client"]["issuer"], issuer);
    assert_eq!(token_requests(&server), 1);
    for iss in [None, Some("https://attacker.example")] {
        let (result, _) = callback(&server, answer(iss)).await;
        assert!(
            matches!(result, Err(oauth::Error::IssuerMismatch)),
            "{iss:?}"
        );
    }
    assert_eq!(token_requests(&server), 1);
    server.close().await;
}

#[tokio::test]
async fn callback_error_is_shown_only_after_state_and_issuer_verification() {
    use ycoding_core::resources::mcp::oauth;
    let server = Server::new().await;
    server.state.lock().unwrap().iss_supported = true;
    let issuer = format!("{}/issuer", server.url);
    let deny = |state: Option<&str>, iss: Option<&str>| {
        let state = state.map(str::to_owned);
        let iss = iss.map(str::to_owned);
        move |params: &BTreeMap<String, String>| {
            let mut query = vec![
                (
                    "state".to_owned(),
                    state.clone().unwrap_or_else(|| params["state"].clone()),
                ),
                ("error".to_owned(), "access_denied".to_owned()),
                (
                    "error_description".to_owned(),
                    "Denied by the account owner".to_owned(),
                ),
            ];
            query.extend(iss.clone().map(|iss| ("iss".to_owned(), iss)));
            query
        }
    };
    for (query, expected) in [
        (
            deny(Some("forged"), Some(&issuer)),
            oauth::Error::StateMismatch,
        ),
        (
            deny(None, Some("https://attacker.example")),
            oauth::Error::IssuerMismatch,
        ),
        (deny(None, None), oauth::Error::IssuerMismatch),
    ] {
        let (result, page) = callback(&server, query).await;
        assert_eq!(result.err(), Some(expected));
        assert!(
            !page.contains("Denied by the account owner"),
            "{expected:?}"
        );
    }
    let (result, page) = callback(&server, deny(None, Some(&issuer))).await;
    assert_eq!(result.err(), Some(oauth::Error::Rejected));
    assert!(page.contains("Denied by the account owner"));
    assert_eq!(token_requests(&server), 0);
    server.close().await;
}
