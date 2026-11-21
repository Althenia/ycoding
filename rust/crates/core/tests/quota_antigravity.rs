use ycoding_core::{
    resources::model::quota::normalize_antigravity,
    ycoding_schema::{DomainEncode, parse_json},
};

#[test]
fn grouped_quota_windows_keep_distinct_periods_and_duplicate_fallback_names() {
    let source = parse_json(r#"{"response":{"groups":[{"displayName":" Pro ","buckets":[{"bucketId":"weekly","remainingFraction":0.75},{"bucketId":"fiveHour","window":"18000s","remaining":{"remainingFraction":0.5}},{"bucketId":"extra","window":"weekly","remainingFraction":0.1},{"bucketId":"disabled","remainingFraction":0.1,"disabled":true}]},{"displayName":"Basic","buckets":[{"bucketId":"weekly","remainingFraction":1}]}]}}"#).unwrap();
    let snapshot = normalize_antigravity(&source, 100).unwrap();
    assert_eq!(
        snapshot
            .windows
            .iter()
            .map(|window| window.id.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Pro/weekly", "Pro/extra", "Pro/five-hour", "Basic/weekly"]
    );
    assert_eq!(snapshot.windows[0].used, Some(25.0));
    assert_eq!(
        snapshot.windows[0].group.as_ref().unwrap().as_str(),
        Some("Pro")
    );
    assert_eq!(snapshot.windows[1].period_seconds, None);
    assert_eq!(snapshot.windows[2].period_seconds.unwrap().get(), 18000);
    assert_eq!(snapshot.source.as_str(), Some("provider_internal_api"));
    assert!(snapshot.encode() != ycoding_core::ycoding_schema::JsonValue::Null);
}

#[test]
fn malformed_buckets_are_excluded_and_ambiguous_periods_are_not_invented() {
    let snapshot = normalize_antigravity(&parse_json(r#"{"buckets":[{"bucketId":"weekly","remainingFraction":2},{"bucketId":"weekly-five-hour","displayName":"Mixed","remainingFraction":0.5},{"remainingFraction":0.5},{"bucketId":"named","remainingFraction":0.5,"resetTime":"invalid"}]}"#).unwrap(),100).unwrap();
    assert_eq!(snapshot.windows.len(), 2);
    assert!(
        snapshot
            .windows
            .iter()
            .all(|window| window.period_seconds.is_none() && window.reset_at.is_none())
    );
    assert!(normalize_antigravity(&parse_json(r#"{"response":42}"#).unwrap(), 100).is_err());
}

#[tokio::test]
async fn oauth_quota_request_uses_project_metadata_and_the_canonical_client_identity() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use ycoding_core::resources::{
        credential,
        model::quota::{Endpoints, Service},
    };
    use ycoding_core::ycoding_schema::provider;
    use ycoding_store::{Metadata, Options, Store, resources};
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([19; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let secret = resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"oauth","refresh":"synthetic-refresh","access":"synthetic-access","expires":9007199254740991,"metadata":{"projectID":"synthetic-project"}}"#).unwrap()).unwrap();
    credentials
        .create(
            "synthetic-antigravity".into(),
            "antigravity".into(),
            Some("Synthetic".into()),
            secret,
            0,
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 1024];
            let length = socket.read(&mut chunk).await.unwrap();
            assert!(length > 0 && bytes.len() + length <= 8192);
            bytes.extend_from_slice(&chunk[..length]);
            let request = String::from_utf8(bytes.clone()).unwrap();
            if let Some((headers, body)) = request.split_once("\r\n\r\n") {
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap();
                if body.len() < content_length {
                    continue;
                }
                assert!(headers.starts_with("POST /v1internal:retrieveUserQuotaSummary HTTP/1.1"));
                let headers = headers.to_ascii_lowercase();
                assert!(headers.contains("authorization: bearer synthetic-access"));
                assert!(
                    headers.contains("user-agent: antigravity/hub/2.28.2 (aidev_client; os_type=")
                );
                assert_eq!(body, r#"{"project":"synthetic-project"}"#);
                break;
            }
        }
        let body = r#"{"buckets":[{"bucketId":"weekly","remainingFraction":0.75}]}"#;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let service = Service::new(
        credentials.clone(),
        Endpoints(std::collections::BTreeMap::from([(
            "antigravity".into(),
            endpoint,
        )])),
    )
    .unwrap();
    let snapshot = service
        .get(provider::Id("antigravity".into()), None, true, 100)
        .await;
    assert_eq!(snapshot.status.as_str(), Some("available"));
    assert_eq!(snapshot.windows[0].used, Some(25.0));
    worker.await.unwrap();
    service.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
}
