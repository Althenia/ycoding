use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};
use ycoding_core::resources::{
    auth::{Client, Preparation, Status, antigravity},
    credential::Service,
};
use ycoding_schema::{DomainEncode, credential, schema::NonNegativeInt};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

struct Fixture {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn new(responses: Vec<(u16, &'static str)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let worker = std::thread::spawn(move || {
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..count]);
                    let text = String::from_utf8_lossy(&request);
                    if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|s| s.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                }
                observed
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(request).unwrap());
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
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

fn embedded(endpoint: &str) -> Client {
    Client::new(endpoint, "fixture-version")
        .unwrap()
        .with_antigravity_client(antigravity::OAuthClient::new(
            "fixture-client-id",
            Some("fixture-client-secret"),
        ))
}
fn param(url: &str, name: &str) -> String {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}

#[test]
fn authorization_url_uses_google_pkce_with_the_antigravity_scopes() {
    let attempt = embedded("https://oauth2.googleapis.com")
        .start_code(
            "antigravity",
            "google",
            "http://localhost:51121/oauth-callback",
        )
        .unwrap();
    let url = attempt.url();
    assert!(
        url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"),
        "{url}"
    );
    assert_eq!(param(url, "client_id"), "fixture-client-id");
    assert_eq!(param(url, "response_type"), "code");
    assert_eq!(
        param(url, "redirect_uri"),
        "http://localhost:51121/oauth-callback"
    );
    assert_eq!(
        param(url, "scope"),
        "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs"
    );
    assert_eq!(param(url, "code_challenge_method"), "S256");
    assert!(!param(url, "code_challenge").is_empty());
    assert!(!param(url, "state").is_empty());
    assert_eq!(param(url, "access_type"), "offline");
    assert_eq!(param(url, "prompt"), "consent");
    assert!(!format!("{attempt:?}").contains("fixture-client-secret"));
}

#[test]
fn authorization_requires_embedded_credentials() {
    let client = Client::new("https://oauth2.googleapis.com", "fixture-version")
        .unwrap()
        .with_antigravity_client(None);
    assert!(
        client
            .start_code(
                "antigravity",
                "google",
                "http://localhost:51121/oauth-callback"
            )
            .is_err()
    );
    assert_eq!(
        antigravity::OAuthClient::new("", Some("fixture-client-secret")),
        None
    );
    assert_eq!(
        antigravity::OAuthClient::new("fixture-client-id", Some("")),
        None
    );
    assert_eq!(
        antigravity::OAuthClient::new("fixture-client-id", None),
        None
    );
}

#[tokio::test]
async fn code_exchange_sends_the_embedded_client_and_stores_google_tokens() {
    let mut fixture = Fixture::new(vec![(
        200,
        r#"{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600}"#,
    )]);
    let mut attempt = embedded(&fixture.endpoint)
        .start_code(
            "antigravity",
            "google",
            "http://localhost:51121/oauth-callback",
        )
        .unwrap();
    let state = param(attempt.url(), "state");
    let secret = attempt
        .complete(
            &format!("http://localhost:51121/oauth-callback?code=fixture-code&state={state}"),
            1_000,
        )
        .await
        .unwrap();
    assert_eq!(attempt.status(), Status::Complete);
    let credential::Value::OAuth(value) = secret.domain().unwrap() else {
        panic!("oauth credential expected")
    };
    assert_eq!(value.method_id.as_lossless().as_str(), Some("google"));
    assert_eq!(value.access.as_str(), Some("fixture-access"));
    assert_eq!(value.refresh.as_str(), Some("fixture-refresh"));
    assert_eq!(value.expires.get(), 1_000 + 3_600_000);
    fixture.finish();
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let request = requests[0].to_ascii_lowercase();
    assert!(request.starts_with("post /token http/1.1"), "{request}");
    assert!(
        request.contains("user-agent: antigravity/hub/2.28.2"),
        "{request}"
    );
    let body = &requests[0];
    assert!(body.contains("grant_type=authorization_code"));
    assert!(body.contains("code=fixture-code"));
    assert!(body.contains("client_id=fixture-client-id"));
    assert!(body.contains("client_secret=fixture-client-secret"));
    assert!(body.contains("redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback"));
    assert!(body.contains("code_verifier="));
}

#[tokio::test]
async fn expired_antigravity_tokens_refresh_before_model_requests() {
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([7; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let mut metadata = ycoding_schema::JsonObject::new();
    metadata.insert(
        "projectID".into(),
        ycoding_schema::JsonValue::String("project-9".into()),
    );
    let secret = resources::Secret::new(
        credential::Value::OAuth(credential::OAuth {
            method_id: ycoding_schema::integration_id::IntegrationMethodId::new("google").unwrap(),
            access: "stale-access".into(),
            refresh: "fixture-refresh".into(),
            expires: NonNegativeInt::new(100).unwrap(),
            metadata: Some(metadata),
        })
        .encode(),
    )
    .unwrap();
    let stored = service
        .create(
            "antigravity-id".into(),
            "antigravity".into(),
            None,
            secret,
            0,
        )
        .await
        .unwrap();
    let mut fixture = Fixture::new(vec![(
        200,
        r#"{"access_token":"fresh-access","expires_in":1800}"#,
    )]);
    let mut preparation = Preparation::default();
    preparation
        .clients
        .insert("antigravity".into(), embedded(&fixture.endpoint));
    let prepared = preparation
        .prepare_value(&service, stored, 1_000, None)
        .await
        .unwrap();
    let credential::Value::OAuth(value) = prepared.domain().unwrap() else {
        panic!("oauth credential expected")
    };
    assert_eq!(value.access.as_str(), Some("fresh-access"));
    assert_eq!(value.refresh.as_str(), Some("fixture-refresh"));
    assert_eq!(value.expires.get(), 1_000 + 1_800_000);
    assert_eq!(
        value
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"projectID".into())),
        Some(&ycoding_schema::JsonValue::String("project-9".into()))
    );
    fixture.finish();
    {
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("grant_type=refresh_token"));
        assert!(requests[0].contains("refresh_token=fixture-refresh"));
        assert!(requests[0].contains("client_secret=fixture-client-secret"));
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("user-agent: antigravity/hub/2.28.2")
        );
    }
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn project_discovery_loads_and_onboards_through_the_gateway() {
    let mut fixture = Fixture::new(vec![(
        200,
        r#"{"cloudaicompanionProject":"project-9","currentTier":{"id":"free-tier"}}"#,
    )]);
    let project = antigravity::discover_project(&fixture.endpoint, "google-access")
        .await
        .unwrap();
    assert_eq!(project.as_deref(), Some("project-9"));
    fixture.finish();
    {
        let requests = fixture.requests.lock().unwrap();
        assert!(requests[0].starts_with("POST /v1internal:loadCodeAssist HTTP/1.1"));
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("authorization: bearer google-access")
        );
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("user-agent: antigravity/hub/2.28.2")
        );
        assert!(requests[0].contains(r#"{"metadata":{"ideType":"ANTIGRAVITY"}}"#));
    }

    let mut fixture = Fixture::new(vec![
        (
            200,
            r#"{"allowedTiers":[{"id":"standard-tier","isDefault":true}]}"#,
        ),
        (
            200,
            r#"{"done":true,"response":{"cloudaicompanionProject":{"id":"project-7"}}}"#,
        ),
    ]);
    let project = antigravity::discover_project(&fixture.endpoint, "google-access")
        .await
        .unwrap();
    assert_eq!(project.as_deref(), Some("project-7"));
    fixture.finish();
    let requests = fixture.requests.lock().unwrap();
    assert!(requests[1].starts_with("POST /v1internal:onboardUser HTTP/1.1"));
    for fragment in [
        r#""tier_id":"standard-tier""#,
        r#""ide_type":"ANTIGRAVITY""#,
        r#""ide_version":"2.28.2""#,
        r#""ide_name":"antigravity""#,
    ] {
        assert!(requests[1].contains(fragment), "{fragment}");
    }
    let lower = requests[1].to_ascii_lowercase();
    assert!(lower.contains("google-api-nodejs-client/10.3.0"), "{lower}");
}

#[test]
fn builtin_registration_exposes_the_google_oauth_method() {
    let mut draft = ycoding_core::resources::auth::integration::Draft::default();
    Preparation::default()
        .register(&mut draft, &std::collections::BTreeMap::new(), None)
        .unwrap();
    assert_eq!(
        draft.get(&"antigravity".into()).map(|r| r.name.clone()),
        Some("Antigravity".into())
    );
    let methods = draft.methods(&"antigravity".into());
    assert!(methods.iter().any(|method| matches!(
        method,
        ycoding_schema::integration::Method::OAuth(method)
            if method.id.as_lossless().as_str() == Some("google")
                && method.label.as_str() == Some("Google account (Antigravity subscription)")
    )));
}
