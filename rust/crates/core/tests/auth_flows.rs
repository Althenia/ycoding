use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
};
use ycoding_core::resources::auth::{Client, DeviceFlow, Poll, Status};
use ycoding_core::resources::credential::{Error, Service};
use ycoding_schema::{DomainEncode, credential, schema::NonNegativeInt};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

struct Fixture {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn new(responses: Vec<Option<(u16, &'static str)>>) -> Self {
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
                if let Some((status, body)) = response {
                    write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
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

fn client(endpoint: &str) -> Client {
    Client::new(endpoint, "fixture-version").unwrap()
}

#[tokio::test]
async fn muse_device_denied_expired_and_slow_down_are_distinct_and_redacted() {
    for (error, expected) in [
        ("access_denied", Status::Denied),
        ("expired_token", Status::Expired),
    ] {
        let body = if error == "access_denied" {
            r#"{"error":"access_denied","error_description":"fixture-secret fixture@example.invalid"}"#
        } else {
            r#"{"error":"expired_token"}"#
        };
        let mut fixture = Fixture::new(vec![
            Some((
                200,
                r#"{"verification_uri":"https://example.invalid/device","user_code":"CODE","device_code":"secret","interval":2,"expires_in":20}"#,
            )),
            Some((400, r#"{"error":"slow_down"}"#)),
            Some((400, body)),
        ]);
        let mut attempt = client(&fixture.endpoint)
            .start_device(DeviceFlow::Muse, 0)
            .await
            .unwrap();
        assert_eq!(attempt.poll(0).await.unwrap(), Poll::WaitUntil(7000));
        let error = attempt.poll(7000).await.unwrap_err();
        assert_eq!(attempt.status(), expected);
        assert!(!format!("{error:?} {error}").contains("fixture"));
        fixture.finish();
    }
}

#[tokio::test]
async fn openai_device_exchanges_code_once_and_preserves_account_metadata() {
    let mut fixture = Fixture::new(vec![
        Some((
            200,
            r#"{"device_auth_id":"device","user_code":"CODE","interval":"2"}"#,
        )),
        Some((403, "{}")),
        Some((
            200,
            r#"{"authorization_code":"fixture-code","code_verifier":"fixture-verifier"}"#,
        )),
        Some((
            200,
            r#"{"access_token":"access","refresh_token":"refresh","id_token":"e30.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2NvdW50In0.x","expires_in":100}"#,
        )),
    ]);
    let mut attempt = client(&fixture.endpoint)
        .start_device(DeviceFlow::Openai, 0)
        .await
        .unwrap();
    assert_eq!(attempt.poll(0).await.unwrap(), Poll::WaitUntil(5000));
    let Poll::Complete(secret) = attempt.poll(5000).await.unwrap() else {
        panic!("not complete")
    };
    let credential::Value::OAuth(value) = secret.domain().unwrap() else {
        panic!("not oauth")
    };
    assert_eq!(value.expires.get(), 105000);
    assert_eq!(
        value.metadata.unwrap().get(&"accountID".into()),
        Some(&ycoding_schema::JsonValue::String("account".into()))
    );
    fixture.finish();
    let requests = fixture.requests.lock().unwrap();
    assert!(requests[3].contains("grant_type=authorization_code"));
    assert!(requests[3].contains("code_verifier=fixture-verifier"));
}

#[tokio::test]
async fn manual_exchange_validates_state_and_unknown_outcome_is_not_replayed() {
    let mut fixture = Fixture::new(vec![None]);
    let mut attempt = client(&fixture.endpoint)
        .start_code("openai", "chatgpt-browser", "http://127.0.0.1/callback")
        .unwrap();
    let state = url::Url::parse(attempt.url())
        .unwrap()
        .query_pairs()
        .find(|(name, _)| name == "state")
        .unwrap()
        .1
        .into_owned();
    let error = attempt
        .complete(
            &format!("http://127.0.0.1/callback?code=fixture-code&state={state}"),
            0,
        )
        .await
        .unwrap_err();
    assert_eq!(error, Error::UnknownOutcome);
    assert_eq!(attempt.status(), Status::UnknownOutcome);
    assert_eq!(
        attempt
            .complete(
                &format!("http://127.0.0.1/callback?code=fixture-code&state={state}"),
                1
            )
            .await
            .unwrap_err(),
        Error::UnknownOutcome
    );
    fixture.finish();
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    let mut invalid = client(&fixture.endpoint)
        .start_code("openai", "chatgpt-browser", "http://127.0.0.1/callback")
        .unwrap();
    assert_eq!(
        invalid
            .complete("http://127.0.0.1/callback?code=fixture-code&state=wrong", 0)
            .await
            .unwrap_err(),
        Error::Rejected
    );
    assert_eq!(invalid.status(), Status::Failed);
}

#[tokio::test]
async fn refresh_precedes_request_preparation_at_five_minute_boundary() {
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([8; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let secret = resources::Secret::new(
        credential::Value::OAuth(credential::OAuth {
            method_id: ycoding_schema::integration_id::IntegrationMethodId::new("chatgpt-browser")
                .unwrap(),
            access: "old".into(),
            refresh: "fixture-refresh".into(),
            expires: NonNegativeInt::new(301_000).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    let stored = service
        .create("id".into(), "openai".into(), None, secret, 0)
        .await
        .unwrap();
    let mut fixture = Fixture::new(vec![Some((
        200,
        r#"{"access_token":"new","refresh_token":"rotated","id_token":"invalid","expires_in":3600}"#,
    ))]);
    let client = client(&fixture.endpoint);
    let unchanged = client.prepare(&service, stored.clone(), 999).await.unwrap();
    assert_eq!(unchanged, stored);
    let refreshed = client.prepare(&service, stored, 1000).await.unwrap();
    let credential::Value::OAuth(value) = refreshed.secret().domain().unwrap() else {
        panic!("not oauth")
    };
    assert_eq!(value.access.as_str(), Some("new"));
    assert_eq!(
        (refreshed.generation(), refreshed.account_generation()),
        (1, 0)
    );
    fixture.finish();
    assert!(fixture.requests.lock().unwrap()[0].contains("grant_type=refresh_token"));
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn api_key_login_and_automatic_device_enrollment_persist_selected_profile() {
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([9; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let mut fixture = Fixture::new(vec![
        Some((
            200,
            r#"{"user_code":"CODE","device_auth_id":"device","interval":"1"}"#,
        )),
        Some((
            200,
            r#"{"authorization_code":"code","code_verifier":"verifier"}"#,
        )),
        Some((
            200,
            r#"{"access_token":"auto-access","refresh_token":"refresh","expires_in":3600}"#,
        )),
    ]);
    let client = client(&fixture.endpoint);
    let key = client
        .login_key(
            &service,
            "openai".into(),
            Some("Work".into()),
            "fixture-api-key".into(),
        )
        .await
        .unwrap();
    let mut enrollment = client
        .enroll_device(service.clone(), DeviceFlow::Openai, Some("Team".into()))
        .await
        .unwrap();
    assert_eq!(
        enrollment.wait().await.unwrap().integration_id().as_str(),
        Some("openai")
    );
    assert_eq!(enrollment.status(), Status::Complete);
    assert_eq!(service.list(&"openai".into()).unwrap().len(), 2);
    assert_eq!(
        service.get(key.id()).unwrap().unwrap().secret(),
        key.secret()
    );
    assert!(!format!("{enrollment:?}").contains("auto-access"));
    fixture.finish();
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn browser_callback_listener_validates_state_exchanges_and_closes() {
    let mut fixture = Fixture::new(vec![Some((
        200,
        r#"{"access_token":"browser-access","refresh_token":"refresh","id_token":"invalid"}"#,
    ))]);
    let client = client(&fixture.endpoint);
    let mut browser = client
        .start_browser("openai", "chatgpt-browser", Some(0))
        .await
        .unwrap();
    let url = url::Url::parse(browser.url()).unwrap();
    let state = url
        .query_pairs()
        .find(|(name, _)| name == "state")
        .unwrap()
        .1
        .into_owned();
    let redirect = url
        .query_pairs()
        .find(|(name, _)| name == "redirect_uri")
        .unwrap()
        .1
        .into_owned();
    let callback = reqwest::Client::new()
        .get(format!("{redirect}?code=code&state={state}"))
        .send();
    let (secret, response) = tokio::join!(browser.wait(), callback);
    let response = response.unwrap();
    assert!(response.status().is_success());
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "text/html; charset=utf-8"
    );
    let html = response.text().await.unwrap();
    assert!(html.contains("YCoding is now connected to ChatGPT."));
    assert!(html.contains("aria-live=\"polite\""));
    assert!(!html.contains("browser-access"));
    let credential::Value::OAuth(value) = secret.unwrap().domain().unwrap() else {
        panic!("not oauth")
    };
    assert_eq!(value.access.as_str(), Some("browser-access"));
    assert_eq!(browser.status(), Status::Complete);
    assert!(
        tokio::net::TcpStream::connect(
            url::Url::parse(&redirect)
                .unwrap()
                .socket_addrs(|| None)
                .unwrap()[0]
        )
        .await
        .is_err()
    );
    fixture.finish();
}

#[tokio::test]
async fn device_local_expiry_cancel_and_transport_unknown_outcome_never_send_again() {
    let response = Some((
        200,
        r#"{"verification_uri":"https://example.invalid/device","user_code":"CODE","device_code":"secret","expires_in":1,"interval":1}"#,
    ));
    let mut fixture = Fixture::new(vec![response, response, response, None]);
    let client = client(&fixture.endpoint);
    let mut expired = client.start_device(DeviceFlow::Muse, 0).await.unwrap();
    assert_eq!(expired.poll(1000).await.unwrap_err(), Error::Rejected);
    assert_eq!(expired.status(), Status::Expired);
    let mut cancelled = client.start_device(DeviceFlow::Muse, 0).await.unwrap();
    cancelled.cancel();
    assert_eq!(cancelled.poll(0).await.unwrap_err(), Error::Rejected);
    assert_eq!(cancelled.status(), Status::Cancelled);
    let mut unknown = client.start_device(DeviceFlow::Muse, 0).await.unwrap();
    assert_eq!(unknown.poll(0).await.unwrap_err(), Error::UnknownOutcome);
    assert_eq!(unknown.poll(0).await.unwrap_err(), Error::UnknownOutcome);
    fixture.finish();
    assert_eq!(fixture.requests.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn request_preparation_rejects_replaced_or_deleted_account_even_with_unexpired_token() {
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([10; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let secret = resources::Secret::new(
        credential::Value::OAuth(credential::OAuth {
            method_id: ycoding_schema::integration_id::IntegrationMethodId::new("chatgpt-browser")
                .unwrap(),
            access: "old".into(),
            refresh: "refresh".into(),
            expires: NonNegativeInt::new(600_000).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    let stored = service
        .create("id".into(), "openai".into(), None, secret.clone(), 0)
        .await
        .unwrap();
    let client = client("http://127.0.0.1:1");
    service
        .create("unused".into(), "openai".into(), None, secret, 1)
        .await
        .unwrap();
    assert_eq!(
        client
            .prepare(&service, stored.clone(), 0)
            .await
            .unwrap_err(),
        Error::ProfileUnavailable
    );
    service.remove(stored.id().clone(), 2).await.unwrap();
    assert_eq!(
        client.prepare(&service, stored, 0).await.unwrap_err(),
        Error::ProfileUnavailable
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn manual_oauth_requires_code_persists_once_and_checks_integration_owner() {
    use ycoding_core::resources::auth::ManualAttempt;
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([11; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let callback = |code: String| async move {
        assert_eq!(code, "fixture-code");
        resources::Secret::new(
            credential::Value::OAuth(credential::OAuth {
                method_id: ycoding_schema::integration_id::IntegrationMethodId::new(
                    "fixture-manual",
                )
                .unwrap(),
                access: "access".into(),
                refresh: "refresh".into(),
                expires: NonNegativeInt::new(1).unwrap(),
                metadata: None,
            })
            .encode(),
        )
        .map_err(|_| Error::InvalidCredential)
    };
    let mut attempt = ManualAttempt::new(
        service.clone(),
        "fixture-integration".into(),
        Some("Manual".into()),
        "https://example.invalid/login".into(),
        "Paste code".into(),
        callback,
    );
    assert_eq!(
        attempt
            .complete(&"fixture-integration".into(), None)
            .await
            .unwrap_err(),
        Error::CodeRequired
    );
    assert_eq!(attempt.status(), Status::Pending);
    assert_eq!(
        attempt
            .complete(&"other".into(), Some("fixture-code".into()))
            .await
            .unwrap_err(),
        Error::Rejected
    );
    assert!(service.all().unwrap().is_empty());
    attempt
        .complete(&"fixture-integration".into(), Some("fixture-code".into()))
        .await
        .unwrap();
    assert_eq!(attempt.status(), Status::Complete);
    assert_eq!(service.all().unwrap().len(), 1);
    attempt
        .complete(&"fixture-integration".into(), Some("second".into()))
        .await
        .unwrap();
    assert_eq!(service.all().unwrap()[0].account_generation(), 0);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn manual_unknown_outcome_and_cancellation_never_reinvoke_callback_or_store() {
    use ycoding_core::resources::auth::ManualAttempt;
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([12; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let mut attempt = ManualAttempt::new(
        service.clone(),
        "fixture-integration".into(),
        None,
        "https://example.invalid/login".into(),
        "Paste code".into(),
        |_code| async { Err(Error::UnknownOutcome) },
    );
    assert_eq!(
        attempt
            .complete(&"fixture-integration".into(), Some("first".into()))
            .await
            .unwrap_err(),
        Error::UnknownOutcome
    );
    assert_eq!(
        attempt
            .complete(&"fixture-integration".into(), Some("second".into()))
            .await
            .unwrap_err(),
        Error::UnknownOutcome
    );
    assert_eq!(attempt.status(), Status::UnknownOutcome);
    assert!(service.all().unwrap().is_empty());
    let mut cancelled = ManualAttempt::new(
        service.clone(),
        "fixture-integration".into(),
        None,
        "https://example.invalid/login".into(),
        "Paste code".into(),
        |_code| async { panic!("cancelled callback invoked") },
    );
    cancelled.cancel(&"other".into());
    assert_eq!(cancelled.status(), Status::Pending);
    cancelled.cancel(&"fixture-integration".into());
    assert_eq!(
        cancelled
            .complete(&"fixture-integration".into(), Some("first".into()))
            .await
            .unwrap_err(),
        Error::Rejected
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn cursor_browser_poll_uses_pkce_delays_and_jwt_expiry() {
    let mut fixture = Fixture::new(vec![
        Some((404, "{}")),
        Some((
            200,
            r#"{"accessToken":"e30.eyJleHAiOjYwMH0.x","refreshToken":"cursor-refresh"}"#,
        )),
    ]);
    let mut attempt = client(&fixture.endpoint)
        .start_cursor("https://example.invalid", 0)
        .unwrap();
    let url = url::Url::parse(attempt.url()).unwrap();
    assert_eq!(url.path(), "/loginDeepControl");
    assert!(url.query_pairs().any(|(key, _)| key == "challenge"));
    assert_eq!(attempt.poll(0).await.unwrap(), Poll::WaitUntil(1000));
    assert_eq!(attempt.poll(1000).await.unwrap(), Poll::WaitUntil(2200));
    let Poll::Complete(secret) = attempt.poll(2200).await.unwrap() else {
        panic!("not complete")
    };
    let credential::Value::OAuth(value) = secret.domain().unwrap() else {
        panic!("not oauth")
    };
    assert_eq!(value.expires.get(), 600_000);
    assert_eq!(value.method_id.as_lossless().as_str(), Some("browser"));
    assert_eq!(attempt.status(), Status::Complete);
    fixture.finish();
    let requests = fixture.requests.lock().unwrap();
    assert!(requests[0].starts_with("GET /auth/poll?uuid="));
    assert!(requests[0].contains("&verifier="));
    assert!(!format!("{attempt:?}").contains("cursor-refresh"));
}

#[tokio::test]
async fn malformed_successful_refresh_fences_consumed_token_without_replay() {
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([14; 16], 1),
    )
    .unwrap();
    let service = Service::new(store.client());
    let secret = resources::Secret::new(
        credential::Value::OAuth(credential::OAuth {
            method_id: ycoding_schema::integration_id::IntegrationMethodId::new("chatgpt-browser")
                .unwrap(),
            access: "old".into(),
            refresh: "fixture-refresh".into(),
            expires: NonNegativeInt::new(0).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    let stored = service
        .create("id".into(), "openai".into(), None, secret, 0)
        .await
        .unwrap();
    let mut fixture = Fixture::new(vec![Some((
        200,
        r#"{"access_token":"new","error_description":"fixture-secret"}"#,
    ))]);
    let client = client(&fixture.endpoint);
    assert_eq!(
        client
            .prepare(&service, stored.clone(), 0)
            .await
            .unwrap_err(),
        Error::UnknownOutcome
    );
    assert_eq!(
        client
            .prepare(&service, stored.clone(), 0)
            .await
            .unwrap_err(),
        Error::UnknownOutcome
    );
    assert_eq!(service.get(stored.id()).unwrap().unwrap(), stored);
    fixture.finish();
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn token_exchange_does_not_round_invalid_fractional_expiry_or_default_malformed_fields() {
    for body in [
        r#"{"access_token":"new","refresh_token":"rotated","id_token":"invalid","expires_in":0.0001}"#,
        r#"{"access_token":"new","refresh_token":"rotated","id_token":"invalid","expires_in":"malformed"}"#,
    ] {
        let mut fixture = Fixture::new(vec![Some((200, body))]);
        let mut attempt = client(&fixture.endpoint)
            .start_code("openai", "chatgpt-browser", "http://127.0.0.1/callback")
            .unwrap();
        let state = url::Url::parse(attempt.url())
            .unwrap()
            .query_pairs()
            .find(|(name, _)| name == "state")
            .unwrap()
            .1
            .into_owned();
        assert_eq!(
            attempt
                .complete(
                    &format!("http://127.0.0.1/callback?code=code&state={state}"),
                    0
                )
                .await
                .unwrap_err(),
            Error::UnknownOutcome
        );
        assert_eq!(attempt.status(), Status::UnknownOutcome);
        fixture.finish();
    }
}

#[tokio::test]
async fn account_claim_decoder_rejects_malformed_declared_fields_before_account_binding() {
    for body in [
        r#"{"access_token":"access","refresh_token":"refresh","id_token":"e30.eyJjaGF0Z3B0X2FjY291bnRfaWQiOjQyLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoid3JvbmcifX0.x"}"#,
        r#"{"access_token":"access","refresh_token":"refresh","id_token":"e30.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJ3cm9uZyIsIm9yZ2FuaXphdGlvbnMiOjQyfQ.x"}"#,
        r#"{"access_token":"access","refresh_token":"refresh","id_token":"e30.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiIifQ.x"}"#,
    ] {
        let mut fixture = Fixture::new(vec![Some((200, body))]);
        let mut attempt = client(&fixture.endpoint)
            .start_code("openai", "chatgpt-browser", "http://127.0.0.1/callback")
            .unwrap();
        let state = url::Url::parse(attempt.url())
            .unwrap()
            .query_pairs()
            .find(|(name, _)| name == "state")
            .unwrap()
            .1
            .into_owned();
        let secret = attempt
            .complete(
                &format!("http://127.0.0.1/callback?code=code&state={state}"),
                0,
            )
            .await
            .unwrap();
        let credential::Value::OAuth(value) = secret.domain().unwrap() else {
            panic!("not oauth")
        };
        assert!(value.metadata.is_none());
        fixture.finish();
    }
}
