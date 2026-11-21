use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_core::resources::catalog::{Catalog, models_dev};
use ycoding_schema::{parse_json, provider};
use ycoding_store::{Metadata, Options, Store, resources};

#[tokio::test]
async fn configured_openai_model_discovery_inherits_catalog_capabilities_and_keeps_overrides() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let worker = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = vec![0; 4096];
        let n = socket.read(&mut bytes).await.unwrap();
        let request = String::from_utf8(bytes[..n].to_vec()).unwrap();
        assert!(request.starts_with("GET /v1/models HTTP/1.1"));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer fixture-key")
        );
        let body = r#"{"object":"list","data":[{"id":"gpt-reasoning","name":"Local deployment","limit":{"output":9000},"variants":[{"id":"custom","settings":{"effort":"high"}},{"id":9}]},{"id":"local-only"}]}"#;
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
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([11; 16], 1),
    )
    .unwrap();
    let credentials = ycoding_core::resources::credential::Service::new(store.client());
    let documents = vec![parse_json(&r#"{"providers":{"local":{"catalog":{"source":"openai-models"},"settings":{"baseURL":"ENDPOINT","apiKey":"fixture-key"},"models":{"gpt-reasoning":{"limit":{"output":10000}}}}}}"#.replace("ENDPOINT",&endpoint)).unwrap()];
    let snapshots = models_dev::normalize(
        &parse_json(include_str!(
            "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let result = Catalog::compose(snapshots, &documents, &credentials)
        .await
        .unwrap();
    assert!(result.diagnostics.is_empty());
    let discovered = result
        .catalog
        .get(
            &provider::Id("local".into()),
            &"gpt-reasoning".into(),
            None,
            &[],
        )
        .unwrap();
    assert_eq!(discovered.name, "Local deployment".into());
    assert_eq!(discovered.limit.context.get(), 128000);
    assert_eq!(discovered.limit.output.get(), 10000);
    assert!(discovered.capabilities.tools);
    assert_eq!(discovered.variants.len(), 1);
    let local = result
        .catalog
        .get(
            &provider::Id("local".into()),
            &"local-only".into(),
            None,
            &[],
        )
        .unwrap();
    assert_eq!(local.capabilities.input, vec!["text".into()]);
    assert!(!local.capabilities.tools);
    worker.await.unwrap();
    credentials.shutdown().await.unwrap();
}
