use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};
use ycoding_core::resources::{
    auth::{Client, Poll},
    credential::Service,
};
use ycoding_schema::{DomainEncode, credential, schema::NonNegativeInt};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

const ROTATED: &str =
    r#"{"accessToken":"e30.eyJleHAiOjE5NTAwMDAwMDB9.x","refreshToken":"rotated"}"#;

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
                    if let Some((headers, content)) = text.split_once("\r\n\r\n") {
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|s| s.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if content.len() >= length {
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

fn oauth_value(access: &str, refresh: &str, expires: i64) -> resources::Secret {
    resources::Secret::new(
        credential::Value::OAuth(credential::OAuth {
            method_id: ycoding_schema::integration_id::IntegrationMethodId::new("browser").unwrap(),
            access: access.into(),
            refresh: refresh.into(),
            expires: NonNegativeInt::new(expires).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

#[tokio::test]
async fn expiring_oauth_credential_refreshes_and_persists_the_rotated_refresh_token() {
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([51; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let stored = service
        .create(
            "id".into(),
            "cursor".into(),
            None,
            oauth_value("old-access", "old-refresh", 301_000),
            0,
        )
        .await
        .unwrap();
    let mut fixture = Fixture::new(vec![(200, ROTATED)]);
    let client = Client::new(&fixture.endpoint, "fixture").unwrap();
    assert!(client.prepare(&service, stored.clone(), 999).await.unwrap() == stored);
    let refreshed = client.prepare(&service, stored, 1000).await.unwrap();
    let credential::Value::OAuth(value) = refreshed.secret().domain().unwrap() else {
        panic!("not oauth")
    };
    assert_eq!(
        value.access.as_str(),
        Some("e30.eyJleHAiOjE5NTAwMDAwMDB9.x")
    );
    assert_eq!(value.refresh.as_str(), Some("rotated"));
    assert_eq!(value.expires.get(), 1_950_000_000_000);
    assert_eq!(value.method_id.as_lossless().as_str(), Some("browser"));
    fixture.finish();
    {
        let requests = fixture.requests.lock().unwrap();
        assert!(requests[0].starts_with("POST /auth/token"));
        assert!(requests[0].contains(r#"{"refreshToken":"old-refresh"}"#));
    }
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn opaque_access_token_is_stored_with_zero_expiry() {
    let mut fixture = Fixture::new(vec![(
        200,
        r#"{"accessToken":"opaque","refreshToken":"refresh"}"#,
    )]);
    let mut attempt = Client::new(&fixture.endpoint, "fixture")
        .unwrap()
        .start_cursor("https://example.invalid", 0)
        .unwrap();
    let Poll::Complete(secret) = attempt.poll(1000).await.unwrap() else {
        panic!("not complete")
    };
    let credential::Value::OAuth(value) = secret.domain().unwrap() else {
        panic!("not oauth")
    };
    assert_eq!(value.expires.get(), 0);
    assert_eq!(value.refresh.as_str(), Some("refresh"));
    fixture.finish();
}
