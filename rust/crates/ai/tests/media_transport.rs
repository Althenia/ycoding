use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
};
use ycoding_ai::{
    auth::{Auth, Credential},
    image::{self, Data, Input, Kind},
    llm::{self, Event, Message},
    provider_error::{AuthenticationKind, Reason},
    providers,
    route::Executor,
    runpod::{self, Worker},
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
            let headers = String::from_utf8_lossy(&bytes[..end]);
            let length = headers
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
async fn server(responses: Vec<(u16, String)>) -> (String, JoinHandle<Vec<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_request(&mut socket).await);
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nRetry-After: 2\r\n\r\n",body.len()).as_bytes()).await.unwrap();
            for chunk in body.as_bytes().chunks(4093) {
                socket.write_all(chunk).await.unwrap();
            }
        }
        requests
    });
    (url, task)
}
fn executor() -> Executor {
    Executor::new(Executor::http_client().unwrap())
}
fn image_request(kind: Kind, url: String) -> image::Request {
    let mut config = image::Config::new(if kind == Kind::Google {
        Auth::header("x-goog-api-key", Credential::value("fixture-private-token"))
    } else {
        Auth::bearer(Credential::value("fixture-private-token"))
    });
    config.base_url = Some(url);
    image::Request::new(
        image::Model::new("fixture-model", kind, config),
        "Draw a circle",
    )
}
fn runpod_request(worker: Worker, url: String) -> llm::Request {
    let mut config =
        providers::Config::new(Auth::bearer(Credential::value("fixture-private-token")));
    config.base_url = Some(url);
    let mut request = llm::Request::new(runpod::model("catalog-label", worker, config).unwrap());
    request.messages = vec![Message::user("Hello")];
    request
}
fn body(bytes: &[u8]) -> &[u8] {
    let end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    &bytes[end + 4..]
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
fn options(value: &JsonValue, excluded: &[&str]) -> JsonValue {
    let JsonValue::Object(fields) = value else {
        panic!()
    };
    let mut object = JsonObject::new();
    for (key, value) in fields.iter() {
        if !excluded.contains(&key.as_str().unwrap()) {
            object.insert(key.clone(), value.clone());
        }
    }
    JsonValue::Object(object)
}

#[tokio::test]
async fn recorded_images_round_trip_through_actual_http() {
    let fixtures = [
        (
            Kind::OpenAI,
            include_str!(
                "../../../../packages/ai/test/fixtures/recordings/openai-images/generates-an-image.json"
            ),
            "f0d8927489a53ef536f918aad96c502952fee35e988d26f544e5883315f46026",
        ),
        (
            Kind::Google,
            include_str!(
                "../../../../packages/ai/test/fixtures/recordings/google-images/generates-an-image.json"
            ),
            "787d3315ea30522c40ba69e4051eb6e29d466d3da6b959786cc028b73f80761f",
        ),
        (
            Kind::Google,
            include_str!(
                "../../../../packages/ai/test/fixtures/recordings/google-images/edits-an-image.json"
            ),
            "4dbcdf141deab916adee58029ef0a61e3a991e56c7000eb786f74d0e41d6d588",
        ),
        (
            Kind::Xai,
            include_str!(
                "../../../../packages/ai/test/fixtures/recordings/xai-images/generates-an-image.json"
            ),
            "5ad58410d6487992bf1512d5bac647d2058771b81bd66b63588451676046ca06",
        ),
        (
            Kind::Xai,
            include_str!(
                "../../../../packages/ai/test/fixtures/recordings/xai-images/edits-an-image.json"
            ),
            "0930e73e1d6fc0a3d1170f177e9b182c773e1711c9a1aac84a457b0694dbecb1",
        ),
        (
            Kind::Zai,
            include_str!(
                "../../../../packages/ai/test/fixtures/recordings/zai-images/generates-an-image.json"
            ),
            "",
        ),
    ];
    for (kind, fixture, digest) in fixtures {
        let fixture: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let interaction = &fixture["interactions"][0];
        let expected = interaction["request"]["body"].as_str().unwrap();
        let recorded = parse_json(expected).unwrap();
        let response = interaction["response"]["body"].as_str().unwrap().to_owned();
        let (url, task) = server(vec![(200, response)]).await;
        let mut request = image_request(kind, url);
        if kind == Kind::Google {
            request.model.id = "gemini-3.1-flash-image".into();
            let JsonValue::Array(contents) = field(&recorded, "contents") else {
                panic!()
            };
            let JsonValue::Array(parts) = field(&contents[0], "parts") else {
                panic!()
            };
            request.prompt = string(field(&parts[0], "text")).into();
            request.options = options(
                field(&recorded, "generationConfig"),
                &["responseModalities"],
            );
            if parts.len() > 1 {
                request.images = vec![Input::Bytes {
                    data: include_bytes!(
                        "../../../../packages/ai/test/fixtures/images/edit-source.jpg"
                    )
                    .to_vec(),
                    media_type: "image/jpeg".into(),
                }];
            }
        } else {
            request.model.id = string(field(&recorded, "model")).into();
            request.prompt = string(field(&recorded, "prompt")).into();
            request.options = options(&recorded, &["model", "prompt", "image"]);
            if kind == Kind::Xai
                && interaction["request"]["url"]
                    .as_str()
                    .unwrap()
                    .ends_with("/edits")
            {
                request.images = vec![Input::Bytes {
                    data: include_bytes!(
                        "../../../../packages/ai/test/fixtures/images/edit-source.jpg"
                    )
                    .to_vec(),
                    media_type: "image/jpeg".into(),
                }];
            }
        }
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
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(body(&requests[0]), expected.as_bytes());
        let headers = String::from_utf8_lossy(&requests[0]);
        assert!(headers.contains("connection: close\r\n"));
        assert!(headers.contains(if kind == Kind::Google {
            "x-goog-api-key: fixture-private-token\r\n"
        } else {
            "authorization: Bearer fixture-private-token\r\n"
        }));
    }
}

#[tokio::test]
async fn recorded_openai_multipart_has_matching_fields_and_lossless_upload() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/ai/test/fixtures/recordings/openai-images/edits-an-image.json"
    ))
    .unwrap();
    let interaction = &fixture["interactions"][0];
    let (url, task) = server(vec![(
        200,
        interaction["response"]["body"].as_str().unwrap().to_owned(),
    )])
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
    let requests = task.await.unwrap();
    let actual = String::from_utf8_lossy(&requests[0]);
    let boundary = actual
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
        String::from_utf8_lossy(body(&requests[0])).replace(boundary, recorded_boundary),
        interaction["request"]["body"].as_str().unwrap()
    );
    assert!(
        body(&requests[0])
            .windows(bytes.len())
            .any(|window| window == bytes)
    );
}
fn sha256(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tokio::test]
async fn runpod_poll_http_failures_keep_get_context_and_retry_metadata() {
    let (url, task) = server(vec![
        (200, r#"{"status":"IN_QUEUE","id":"job_1"}"#.into()),
        (
            429,
            r#"{"error":{"message":"fixture-private-token"}}"#.into(),
        ),
    ])
    .await;
    let error = executor()
        .generate(&runpod_request(Worker::Vllm, url))
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::RateLimit);
    assert_eq!(error.retry_after_ms, Some(2000.0));
    assert_eq!(error.http.as_ref().unwrap().method, "GET");
    assert!(!format!("{error:?}").contains("fixture-private-token"));
    assert_eq!(task.await.unwrap().len(), 2);
}

#[tokio::test]
async fn runpod_initial_http_attempt_observation_does_not_count_polling_as_retry() {
    let (url,task)=server(vec![(200,r#"{"status":"IN_QUEUE","id":"job_1"}"#.into()),(200,r#"{"status":"COMPLETED","output":{"message":{"role":"assistant","content":"Hi"},"done":true}}"#.into())]).await;
    let attempts = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut executor = executor();
    let observed = attempts.clone();
    executor.observer = Some(std::sync::Arc::new(move |attempt| {
        observed.lock().unwrap().push(attempt);
        Ok(())
    }));
    executor
        .generate(&runpod_request(Worker::Ollama, url))
        .await
        .unwrap();
    task.await.unwrap();
    let attempts = attempts.lock().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0].phase, ycoding_ai::route::AttemptPhase::Started);
    assert_eq!(
        attempts[1].phase,
        ycoding_ai::route::AttemptPhase::Succeeded
    );
    assert!(
        attempts
            .iter()
            .all(|attempt| attempt.attempt == 1 && attempt.transport == "http-json")
    );
}

#[tokio::test]
async fn malformed_image_response_json_is_invalid_output() {
    let (url, task) = server(vec![(200, "not JSON".into())]).await;
    let error = executor()
        .generate_image(&image_request(Kind::Google, url))
        .await
        .unwrap_err();
    assert_eq!(error.reason, Reason::InvalidProviderOutput);
    assert_eq!(error.message, "Failed to read the Google Images response");
    task.await.unwrap();
}

#[tokio::test]
async fn image_http_errors_use_shared_classification_and_redact_credentials() {
    for (status, reason) in [
        (401, Reason::Authentication),
        (429, Reason::RateLimit),
        (500, Reason::ProviderInternal),
    ] {
        let (url, task) = server(vec![(
            status,
            r#"{"error":{"message":"fixture-private-token"}}"#.into(),
        )])
        .await;
        let error = executor()
            .generate_image(&image_request(Kind::Xai, url))
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

#[tokio::test]
async fn runpod_polls_one_job_using_encoded_id_same_auth_and_no_query() {
    let responses=vec![(200,r#"{"status":"IN_QUEUE","id":"job /?雪"}"#.into()),(200,r#"{"status":"IN_PROGRESS","id":"job /?雪"}"#.into()),(200,r#"{"status":"COMPLETED","id":"job /?雪","output":[{"message":{"role":"assistant","content":"Eventually"},"done":true}]}"#.into())];
    let (url, task) = server(responses).await;
    let mut request = runpod_request(Worker::Ollama, url);
    request.http.query.insert("trace".into(), "initial".into());
    let response = tokio::time::timeout(Duration::from_secs(8), executor().generate(&request))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.text().as_str(), Some("Eventually"));
    let requests = task.await.unwrap();
    assert_eq!(requests.len(), 3);
    let initial = String::from_utf8_lossy(&requests[0]);
    assert!(initial.starts_with("POST /v1/runsync?trace=initial HTTP/1.1\r\n"));
    for bytes in &requests[1..] {
        let text = String::from_utf8_lossy(bytes);
        assert!(text.starts_with("GET /v1/status/job%20%2F%3F%E9%9B%AA HTTP/1.1\r\n"));
        assert!(text.contains("authorization: Bearer fixture-private-token\r\n"));
        assert!(text.contains("connection: close\r\n"));
        assert!(body(bytes).is_empty());
    }
    assert_eq!(
        response
            .events
            .iter()
            .filter(|event| matches!(event, Event::Finish(_)))
            .count(),
        1
    );
}

#[tokio::test]
async fn runpod_poll_failures_do_not_resubmit_or_succeed() {
    for payload in [
        r#"{"status":"FAILED","id":"job_1","error":"Worker failed"}"#,
        r#"{"status":"COMPLETED","id":"wrong","output":{}}"#,
        r#"{"status":7}"#,
    ] {
        let (url, task) = server(vec![
            (200, r#"{"status":"IN_PROGRESS","id":"job_1"}"#.into()),
            (200, payload.into()),
        ])
        .await;
        let result = executor()
            .generate(&runpod_request(Worker::Vllm, url))
            .await;
        if payload.contains("Worker failed") {
            let response = result.unwrap();
            assert_eq!(response.finish_reason, llm::FinishReason::Error);
            assert!(
                matches!(response.events.as_slice(), [Event::ProviderError {message, ..}] if message.as_str()==Some("Worker failed"))
            );
        } else {
            assert_eq!(result.unwrap_err().reason, Reason::InvalidProviderOutput);
        }
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(String::from_utf8_lossy(&requests[1]).starts_with("GET "));
    }
}

#[tokio::test]
async fn runpod_missing_job_id_and_invalid_json_do_not_resubmit() {
    for (payload, message) in [
        (r#"{"status":"IN_QUEUE"}"#, "Unfinished job has no id"),
        ("not JSON", "Invalid job response"),
    ] {
        let (url, task) = server(vec![(200, payload.into())]).await;
        let error = executor()
            .generate(&runpod_request(Worker::Ollama, url))
            .await
            .unwrap_err();
        assert_eq!(error.reason, Reason::InvalidProviderOutput);
        assert_eq!(error.message, message);
        assert_eq!(task.await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn cancelling_an_inflight_poll_drops_the_owned_transport() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let (poll_tx, poll_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        read_request(&mut socket).await;
        let body = r#"{"status":"IN_PROGRESS","id":"job_1"}"#;
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
        drop(socket);
        let (mut socket, _) = listener.accept().await.unwrap();
        let poll = read_request(&mut socket).await;
        poll_tx.send(poll).unwrap();
        let mut byte = [0];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    });
    let client = tokio::spawn(async move {
        executor()
            .generate(&runpod_request(Worker::Vllm, url))
            .await
    });
    let poll = tokio::time::timeout(Duration::from_secs(4), poll_rx)
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&poll).starts_with("GET "));
    client.abort();
    assert!(client.await.unwrap_err().is_cancelled());
    server.await.unwrap();
}
