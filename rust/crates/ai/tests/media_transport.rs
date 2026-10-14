use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use ycoding_ai::{
    auth::{Auth, Credential},
    image::{self, Data, Input, Kind},
    provider_error::{AuthenticationKind, Reason},
    route::Executor,
};
use ycoding_schema::{JsonObject, JsonValue, parse_json};

async fn read_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 2048];
    loop {
        let count = socket.read(&mut chunk).await.unwrap();
        assert_ne!(count, 0);
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let length = String::from_utf8_lossy(&bytes[..end])
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|value| value.parse::<usize>().ok())
                })
                .unwrap_or(0);
            if bytes.len() >= end + 4 + length {
                return bytes;
            }
        }
    }
}
async fn server(status: u16, body: String) -> (String, JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nRetry-After: 2\r\n\r\n",body.len()).as_bytes()).await.unwrap();
        for chunk in body.as_bytes().chunks(4093) {
            socket.write_all(chunk).await.unwrap();
        }
        request
    });
    (url, task)
}
fn executor() -> Executor {
    Executor::new(Executor::http_client().unwrap())
}
fn image_request(kind: Kind, url: String) -> image::Request {
    let mut config = image::Config::new(Auth::bearer(Credential::value("fixture-private-token")));
    config.base_url = Some(url);
    image::Request::new(
        image::Model::new("fixture-model", kind, config),
        "Draw a circle",
    )
}
fn body(bytes: &[u8]) -> &[u8] {
    &bytes[bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap()
        + 4..]
}
fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    let JsonValue::Object(fields) = value else {
        panic!("object expected")
    };
    fields.get(&key.into()).unwrap()
}
fn string(value: &JsonValue) -> &str {
    let JsonValue::String(text) = value else {
        panic!("string expected")
    };
    text.as_str().unwrap()
}
fn sha256(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tokio::test]
async fn recorded_kept_images_round_trip_through_actual_http() {
    for (kind, fixture, digest) in [
        (
            Kind::OpenAI,
            include_str!(
                "../../../../packages/ai/test/fixtures/recordings/openai-images/generates-an-image.json"
            ),
            "f0d8927489a53ef536f918aad96c502952fee35e988d26f544e5883315f46026",
        ),
        (
            Kind::Zai,
            include_str!(
                "../../../../packages/ai/test/fixtures/recordings/zai-images/generates-an-image.json"
            ),
            "",
        ),
    ] {
        let fixture: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let interaction = &fixture["interactions"][0];
        let expected = interaction["request"]["body"].as_str().unwrap();
        let recorded = parse_json(expected).unwrap();
        let (url, task) = server(
            200,
            interaction["response"]["body"].as_str().unwrap().to_owned(),
        )
        .await;
        let mut request = image_request(kind, url);
        request.model.id = string(field(&recorded, "model")).into();
        request.prompt = string(field(&recorded, "prompt")).into();
        let JsonValue::Object(fields) = recorded else {
            panic!()
        };
        let mut options = JsonObject::new();
        for (key, value) in fields
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), Some("model" | "prompt")))
        {
            options.insert(key.clone(), value.clone());
        }
        request.options = JsonValue::Object(options);
        let generated = executor().generate_image(&request).await.unwrap();
        assert_eq!(generated.images.len(), 1);
        if kind == Kind::Zai {
            assert!(
                matches!(&generated.images[0].data,Data::Url(url) if url.as_str().unwrap().starts_with("https://"))
            );
            assert!(generated.usage.is_none());
        } else {
            let Data::Bytes(bytes) = &generated.images[0].data else {
                panic!("expected decoded bytes")
            };
            assert_eq!(sha256(bytes), digest);
        }
        let actual = task.await.unwrap();
        assert_eq!(body(&actual), expected.as_bytes());
        let headers = String::from_utf8_lossy(&actual);
        assert!(headers.contains("connection: close\r\n"));
        assert!(headers.contains("authorization: Bearer fixture-private-token\r\n"));
    }
}

#[tokio::test]
async fn recorded_openai_multipart_has_matching_fields_and_lossless_upload() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/ai/test/fixtures/recordings/openai-images/edits-an-image.json"
    ))
    .unwrap();
    let interaction = &fixture["interactions"][0];
    let (url, task) = server(
        200,
        interaction["response"]["body"].as_str().unwrap().to_owned(),
    )
    .await;
    let mut request = image_request(Kind::OpenAI, url);
    request.model.id = "gpt-image-1-mini".into();
    request.prompt = "Keep the simple shape and change it from black to bright green.".into();
    let bytes = include_bytes!("../../../../packages/ai/test/fixtures/images/edit-source.jpg");
    request.images = vec![Input::Bytes {
        data: bytes.to_vec(),
        media_type: "image/jpeg".into(),
    }];
    request.options = parse_json(
        r#"{"outputFormat":"jpeg","outputCompression":10,"quality":"low","size":"1024x1024"}"#,
    )
    .unwrap();
    let generated = executor().generate_image(&request).await.unwrap();
    assert_eq!(generated.images[0].media_type, "image/jpeg".into());
    let Data::Bytes(image) = &generated.images[0].data else {
        panic!("expected decoded bytes")
    };
    assert_eq!(
        sha256(image),
        "f32b7edadf96a6bd56f7b8f5ef2170d2c409f6298a9ef45bf0e15e94e2adcfe5"
    );
    let actual = task.await.unwrap();
    let text = String::from_utf8_lossy(&actual);
    let boundary = text
        .lines()
        .find_map(|line| line.strip_prefix("content-type: multipart/form-data; boundary="))
        .unwrap();
    let recorded_boundary = interaction["request"]["headers"]["content-type"]
        .as_str()
        .unwrap()
        .split_once("boundary=")
        .unwrap()
        .1;
    assert_eq!(
        String::from_utf8_lossy(body(&actual)).replace(boundary, recorded_boundary),
        interaction["request"]["body"].as_str().unwrap()
    );
    assert!(
        body(&actual)
            .windows(bytes.len())
            .any(|window| window == bytes)
    );
}

#[tokio::test]
async fn malformed_image_response_json_is_invalid_output() {
    let (url, task) = server(200, "not JSON".into()).await;
    let error = executor()
        .generate_image(&image_request(Kind::OpenAI, url))
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::InvalidProviderOutput);
    assert_eq!(error.message, "Failed to read the OpenAI Images response");
    task.await.unwrap();
}

#[tokio::test]
async fn image_http_errors_use_shared_classification_and_redact_credentials() {
    for (status, reason) in [
        (401, Reason::Authentication),
        (429, Reason::RateLimit),
        (500, Reason::ProviderInternal),
    ] {
        let (url, task) = server(
            status,
            r#"{"error":{"message":"fixture-private-token"}}"#.into(),
        )
        .await;
        let error = executor()
            .generate_image(&image_request(Kind::OpenAI, url))
            .await
            .unwrap_err();
        assert_eq!(error.reason, reason);
        assert_eq!(error.status, Some(status));
        assert!(!format!("{error:?}").contains("fixture-private-token"));
        if status == 401 {
            assert_eq!(error.authentication_kind, Some(AuthenticationKind::Invalid));
        }
        if status == 429 {
            assert_eq!(error.retry_after_ms, Some(2000.0));
        }
        task.await.unwrap();
    }
}
