use std::{collections::BTreeMap, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_ai::{
    auth::{Auth, Credential},
    cursor::{headers, unary},
    provider_error::Reason,
    route::Executor,
};

fn identity() -> headers::Identity {
    headers::Identity {
        machine_id: "machine".into(),
        mac_machine_id: None,
        client_version: "cli-fixture".into(),
    }
}

#[tokio::test]
async fn cursor_available_models_requests_parameterized_variants_on_the_api_origin() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                request.extend(byte);
            }
            let request = String::from_utf8(request).unwrap().to_lowercase();
            assert!(request.starts_with("post /aiserver.v1.aiservice/availablemodels http/1.1\r\n"));
            assert!(request.contains("authorization: bearer fixture-token\r\n"));
            assert!(request.contains("x-fixture: retained\r\n"));
            assert!(request.contains("x-cursor-client-version: cli-fixture\r\n"));
            assert!(!request.contains("x-request-id: stale"));
            let expected = br#"{"includeLongContextModels":true,"useModelParameters":true,"useCloudAgentEffortModes":true}"#;
            let mut body = vec![0; expected.len()];
            socket.read_exact(&mut body).await.unwrap();
            assert_eq!(body, expected);
            let result = r#"{"models":[{"id":"composer-fixture","name":"Composer"}]}"#;
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{result}", result.len()).as_bytes()).await.unwrap();
        });
        let result = unary::available_models(&Executor::new(Executor::http_client().unwrap()), &Auth::bearer(Credential::value("fixture-token")), &identity(), &unary::Options {
            base_url: format!("http://{address}/ignored?query=ignored"),
            headers: BTreeMap::from([("x-fixture".into(), "retained".into()), ("X-Request-Id".into(), "stale".into())]),
            ..Default::default()
        }).await.unwrap();
        assert_eq!(ycoding_schema::stringify_json(&result), r#"{"models":[{"id":"composer-fixture","name":"Composer"}]}"#);
        server.await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn cursor_unary_invalid_timeouts_fail_locally_with_protocol_diagnostics() {
    let executor = Executor::new(Executor::http_client().unwrap());
    for timeout_ms in [0, 2_147_483_648, u64::MAX] {
        let error = unary::available_models(
            &executor,
            &Auth::bearer(Credential::value("fixture-token")),
            &identity(),
            &unary::Options {
                timeout_ms,
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.reason, Reason::InvalidProviderOutput);
        assert_eq!(error.code.as_deref(), Some("CURSOR_INVALID_TIMEOUT"));
        let metadata = ycoding_schema::stringify_json(error.provider_metadata.as_ref().unwrap());
        assert!(metadata.contains("\"origin\":\"protocol\""));
        assert!(metadata.contains("\"transient\":false"));
        assert!(metadata.contains("\"replaySafe\":false"));
    }
}
