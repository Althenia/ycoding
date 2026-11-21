use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};
use ycoding_core::resources::{
    auth::{Client, Poll, Status, opencode::Console},
    credential::Error,
};
use ycoding_schema::{JsonValue, credential};

#[tokio::test]
async fn registry_authorization_honors_its_server_input_instead_of_constructor_endpoint() {
    use ycoding_core::resources::{auth::integration::Registry, credential::Service};
    use ycoding_store::{Catalog, Metadata, Options, Store, resources};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/console", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 4096];
        let count = stream.read(&mut request).unwrap();
        assert!(
            String::from_utf8_lossy(&request[..count])
                .starts_with("POST /console/auth/device/code")
        );
        let body = r#"{"device_code":"device","user_code":"CODE","verification_uri_complete":"/verify","expires_in":10,"interval":3600}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    });
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([5; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let registry = Registry::new(service.clone(), std::collections::BTreeMap::new());
    let implementation =
        Console::new(Client::new("http://127.0.0.1:1", "fixture").unwrap()).implementation();
    let registration = registry
        .transform(move |draft| draft.oauth(implementation.clone()))
        .unwrap();
    let mut inputs = ycoding_schema::JsonObject::new();
    inputs.insert(
        "server".into(),
        JsonValue::String(format!("{endpoint}///?ignored=true#ignored").into()),
    );
    let attempt = registry
        .connect(
            "opencode".into(),
            "device".into(),
            ycoding_schema::integration::Inputs(inputs),
            None,
            0,
        )
        .await
        .unwrap();
    assert_eq!(attempt.url, format!("{endpoint}/verify").into());
    registry
        .cancel(&"opencode".into(), &attempt.attempt_id)
        .await
        .unwrap();
    worker.join().unwrap();
    registration.dispose().unwrap();
    registry.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn console_enriches_account_selects_org_by_locale_and_preserves_refresh_metadata() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/console", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let observed = requests.clone();
    let worker = std::thread::spawn(move || {
        for _ in 0..7 {
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
            }
            let request = String::from_utf8(bytes).unwrap();
            let body = if request.starts_with("GET /console/api/user") {
                r#"{"id":"account","email":"fixture@example.invalid"}"#
            } else if request.starts_with("GET /console/api/orgs") {
                r#"[{"id":"last","name":"Zeta"},{"id":"second","name":"Ångström"},{"id":"first","name":"Ångström"}]"#
            } else if request.starts_with("POST /console/auth/device/code") {
                r#"{"device_code":"device","user_code":"CODE","verification_uri_complete":"/verify","expires_in":10,"interval":1}"#
            } else if request.contains("refresh_token") {
                r#"{"access_token":"rotated","refresh_token":"r2","expires_in":3600}"#
            } else if observed
                .lock()
                .unwrap()
                .iter()
                .filter(|request: &&String| request.starts_with("POST /console/auth/device/token"))
                .count()
                == 0
            {
                r#"{"error":"authorization_pending"}"#
            } else if observed
                .lock()
                .unwrap()
                .iter()
                .filter(|request: &&String| request.starts_with("POST /console/auth/device/token"))
                .count()
                == 1
            {
                r#"{"error":"slow_down"}"#
            } else {
                r#"{"access_token":"access","refresh_token":"refresh","expires_in":3600}"#
            };
            observed.lock().unwrap().push(request);
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    let console = Console::new(
        Client::new(&format!("{endpoint}///?ignored=true#ignored"), "fixture").unwrap(),
    );
    let mut attempt = console.start(0).await.unwrap();
    assert_eq!(attempt.url(), format!("{endpoint}/verify"));
    assert_eq!(attempt.poll(0).await.unwrap(), Poll::WaitUntil(1000));
    assert_eq!(attempt.poll(1000).await.unwrap(), Poll::WaitUntil(2000));
    assert_eq!(attempt.poll(2000).await.unwrap(), Poll::WaitUntil(8000));
    let Poll::Complete(secret) = attempt.poll(8000).await.unwrap() else {
        panic!()
    };
    let credential::Value::OAuth(value) = secret.domain().unwrap() else {
        panic!()
    };
    assert_eq!(
        value.metadata.as_ref().unwrap().get(&"orgID".into()),
        Some(&JsonValue::String("first".into()))
    );
    assert_eq!(
        value.metadata.as_ref().unwrap().get(&"accountID".into()),
        Some(&JsonValue::String("account".into()))
    );
    assert_eq!(attempt.status(), Status::Complete);
    assert_eq!(attempt.poll(9000).await.unwrap_err(), Error::Rejected);
    let refreshed = console.refresh(value.clone(), 9000).await.unwrap();
    let credential::Value::OAuth(refreshed) = refreshed.domain().unwrap() else {
        panic!()
    };
    assert_eq!(refreshed.metadata, value.metadata);
    assert_eq!(refreshed.access, "rotated".into());
    worker.join().unwrap();
    assert!(!format!("{secret:?} {attempt:?}").contains("fixture@example"));
    assert_eq!(requests.lock().unwrap().len(), 7);
}
