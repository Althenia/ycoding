use super::{model, request};
use bytes::Bytes;
use futures_util::FutureExt;
use std::{
    future::poll_fn,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufStream},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
    time::timeout,
};
use ycoding_ai::{
    llm::{Event, FinishReason, Request},
    provider_error::Reason,
    route::{Attempt, AttemptPhase, AttemptStage, Executor},
};

const WAIT: Duration = Duration::from_secs(3);
const TIMEOUT: Duration = Duration::from_millis(200);
const TEXT: &str =
    "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"delta\":\"partial\"}\n\n";

async fn exchange(
    path: &'static str,
    head: String,
    chunks: Vec<&'static str>,
    hold_open: bool,
) -> (String, oneshot::Sender<()>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (release, finish) = oneshot::channel();
    let server = tokio::spawn(async move {
        timeout(WAIT, async {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = BufStream::new(socket);
            let mut line = String::new();
            socket.read_line(&mut line).await.unwrap();
            assert_eq!(line, format!("POST {path} HTTP/1.1\r\n"));
            let mut length = 0;
            loop {
                line.clear();
                assert_ne!(socket.read_line(&mut line).await.unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            assert!(length > 0);
            socket.read_exact(&mut vec![0; length]).await.unwrap();
            let chunked = head.contains("Transfer-Encoding: chunked");
            socket.write_all(head.as_bytes()).await.unwrap();
            for chunk in chunks {
                if chunked {
                    socket
                        .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                        .await
                        .unwrap();
                }
                socket.write_all(chunk.as_bytes()).await.unwrap();
                if chunked {
                    socket.write_all(b"\r\n").await.unwrap();
                }
                socket.flush().await.unwrap();
            }
            socket.flush().await.unwrap();
            if hold_open {
                let _ = finish.await;
            }
            socket.shutdown().await.unwrap();
        })
        .await
        .unwrap();
        assert!(
            listener.accept().now_or_never().is_none(),
            "the request was replayed"
        );
    });
    (base, release, server)
}

fn responses(base: &str) -> Request {
    request(model("openai-responses", base, "gpt-6.2-sol"))
}

fn headers(status: &str, length: usize) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nX-Request-ID: fixture-request\r\nX-Echo: synthetic-key\r\nX-Access-Token: other-secret\r\nSet-Cookie: session=fixture-cookie\r\n\r\n"
    )
}

fn observed(client: reqwest::Client) -> (Executor, Arc<Mutex<Vec<Attempt>>>) {
    let attempts = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&attempts);
    let mut executor = Executor::new(client);
    executor.observer = Some(Arc::new(move |attempt| {
        sink.lock().unwrap().push(attempt);
        Ok(())
    }));
    (executor, attempts)
}

#[tokio::test]
async fn openai_http_abrupt_body_close_keeps_partial_output_and_safe_context() {
    let (base, _, server) = exchange(
        "/v1/responses?key=private-query",
        headers("200 OK", TEXT.len() + 100),
        vec![TEXT],
        false,
    )
    .await;
    let (executor, attempts) = observed(Executor::http_client().unwrap());
    let mut request = responses(&base);
    request
        .http
        .query
        .insert("key".into(), "private-query".into());
    let mut stream = executor.stream(&request).await.unwrap();
    let mut text = String::new();
    let error = loop {
        match stream.next().await {
            Ok(Some(Event::TextDelta(delta))) => text.push_str(delta.text.as_str().unwrap()),
            Ok(Some(_)) => {}
            Ok(None) => panic!("truncated stream succeeded"),
            Err(error) => break error,
        }
    };
    server.await.unwrap();
    assert_eq!(text, "partial");
    assert_eq!(error.reason, Reason::Transport, "{error}");
    assert_eq!(error.transport_kind, Some("ConnectionClosed"));
    assert!(error.message.contains("closed"), "{error}");
    let http = error.http.as_ref().unwrap();
    assert_eq!(http.status, Some(200));
    assert_eq!(http.request_id.as_deref(), Some("fixture-request"));
    for secret in [
        "synthetic-key",
        "other-secret",
        "private-query",
        "fixture-cookie",
    ] {
        assert!(!format!("{error:?}").contains(secret));
    }
    assert!(stream.next().await.unwrap().is_none());
    let attempts = attempts.lock().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(
        (attempts[1].phase, attempts[1].stage),
        (AttemptPhase::Failed, Some(AttemptStage::Stream))
    );
}

#[tokio::test]
async fn openai_http_request_deadline_and_idle_read_have_distinct_stages() {
    for after_headers in [false, true] {
        let head = if after_headers {
            headers("200 OK", 100)
        } else {
            String::new()
        };
        let (base, release, server) = exchange("/v1/responses", head, vec![], true).await;
        let client = reqwest::Client::builder().no_proxy();
        let client = if after_headers {
            client.read_timeout(TIMEOUT)
        } else {
            client.timeout(TIMEOUT)
        };
        let error = Executor::new(client.build().unwrap())
            .generate(&responses(&base))
            .await
            .unwrap_err();
        release.send(()).unwrap();
        server.await.unwrap();
        assert_eq!(error.reason, Reason::Transport, "{error}");
        assert!(error.message.contains("timed out"), "{error}");
        assert!(
            error.message.contains(if after_headers {
                "response body"
            } else {
                "response headers"
            }),
            "{error}"
        );
        assert_eq!(error.http.unwrap().status, after_headers.then_some(200));
    }
}

#[tokio::test]
async fn openai_http_abrupt_error_body_preserves_status_and_retry_hint() {
    let head = "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nContent-Length: 100\r\nX-Request-ID: fixture-limit\r\nRetry-After: 2\r\nX-RateLimit-Remaining-Tokens: 1234\r\n\r\n";
    let (base, _, server) = exchange(
        "/v1/responses",
        head.into(),
        vec!["{\"token\":\"other-secret"],
        false,
    )
    .await;
    let error = Executor::new(Executor::http_client().unwrap())
        .generate(&responses(&base))
        .await
        .unwrap_err();
    server.await.unwrap();
    assert_eq!(error.reason, Reason::RateLimit);
    assert_eq!(error.status, Some(429));
    assert_eq!(error.retry_after_ms, Some(2000.0));
    assert_eq!(
        error.rate_limit.as_ref().unwrap().remaining["tokens"],
        "1234"
    );
    assert!(
        error.message.contains("response body") && error.message.contains("closed"),
        "{error}"
    );
    assert_eq!(
        error.http.as_ref().unwrap().request_id.as_deref(),
        Some("fixture-limit")
    );
    assert!(!format!("{error:?}").contains("other-secret"));
}

#[tokio::test]
async fn openai_http_clean_eof_without_terminal_reports_request_context() {
    let (base, _, server) = exchange(
        "/v1/responses",
        headers("200 OK", TEXT.len()),
        vec![TEXT],
        false,
    )
    .await;
    let error = Executor::new(Executor::http_client().unwrap())
        .generate(&responses(&base))
        .await
        .unwrap_err();
    server.await.unwrap();
    assert_eq!(error.reason, Reason::Transport, "{error}");
    assert!(error.message.contains("terminal"), "{error}");
    assert_eq!(
        error.http.unwrap().request_id.as_deref(),
        Some("fixture-request")
    );
}

#[tokio::test]
async fn openai_http_malformed_frame_does_not_discard_earlier_output() {
    const BODY: &str = concat!(
        "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"delta\":\"partial\"}\n\n",
        "data: not-json\n\n",
    );
    let (base, _, server) = exchange(
        "/v1/responses",
        headers("200 OK", BODY.len()),
        vec![BODY],
        false,
    )
    .await;
    let executor = Executor::new(Executor::http_client().unwrap());
    let mut stream = executor.stream(&responses(&base)).await.unwrap();
    let mut text = String::new();
    let error = loop {
        match stream.next().await {
            Ok(Some(Event::TextDelta(delta))) => text.push_str(delta.text.as_str().unwrap()),
            Ok(Some(_)) => {}
            Ok(None) => panic!("malformed stream succeeded"),
            Err(error) => break error,
        }
    };
    server.await.unwrap();
    assert_eq!(text, "partial");
    assert_eq!(error.reason, Reason::InvalidProviderOutput);
    assert_eq!(
        error.http.unwrap().request_id.as_deref(),
        Some("fixture-request")
    );
}

#[tokio::test]
async fn openai_http2_reset_after_output_is_a_transport_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (reset, text_read) = oneshot::channel();
    let (release, finished) = oneshot::channel();
    let server = tokio::spawn(async move {
        timeout(WAIT, async {
            let (socket, _) = listener.accept().await.unwrap();
            let mut connection = h2::server::handshake(socket).await.unwrap();
            let (request, mut respond) = connection.accept().await.unwrap().unwrap();
            assert_eq!(request.uri().path(), "/v1/responses");
            assert!(!request.headers().contains_key(http::header::CONNECTION));
            let mut body = respond.send_response(
                http::Response::builder()
                    .header("content-type", "text/event-stream")
                    .header("x-request-id", "fixture-h2-reset")
                    .body(())
                    .unwrap(),
                false,
            ).unwrap();
            body.send_data(Bytes::from_static(TEXT.as_bytes()), false).unwrap();
            tokio::select! {
                result = text_read => result.unwrap(),
                _ = poll_fn(|cx| connection.poll_closed(cx)) => panic!("connection closed before reading text"),
            }
            body.send_reset(h2::Reason::CANCEL);
            tokio::select! {
                _ = finished => {},
                _ = poll_fn(|cx| connection.poll_closed(cx)) => {},
            }
        }).await.unwrap();
    });
    let client = reqwest::Client::builder()
        .http2_prior_knowledge()
        .no_proxy()
        .build()
        .unwrap();
    let executor = Executor::new(client);
    let mut stream = executor.stream(&responses(&base)).await.unwrap();
    loop {
        if let Event::TextDelta(delta) = stream.next().await.unwrap().unwrap() {
            assert_eq!(delta.text.as_str(), Some("partial"));
            break;
        }
    }
    reset.send(()).unwrap();
    let error = stream.next().await.unwrap_err();
    let _ = release.send(());
    server.await.unwrap();
    assert_eq!(error.reason, Reason::Transport, "{error}");
    assert_eq!(error.transport_kind, Some("Http2StreamClosed"));
    assert_eq!(
        error.http.unwrap().request_id.as_deref(),
        Some("fixture-h2-reset")
    );
}

#[tokio::test]
async fn openai_http_chat_done_finishes_before_socket_close_and_keeps_late_usage() {
    let chunks = vec![
        ": keepalive\r",
        "\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"}}]}\r\n\r",
        "\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\r\n\r\n",
        "data: [DONE]\r",
        "\n\r\n",
    ];
    let (base, release, server) = exchange(
        "/v1/chat/completions",
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
            .into(),
        chunks,
        true,
    )
    .await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .read_timeout(TIMEOUT)
        .build()
        .unwrap();
    let result = Executor::new(client)
        .generate(&request(model("openai-compatible-chat", &base, "gpt-4o")))
        .await;
    release.send(()).unwrap();
    server.await.unwrap();
    let response = result.unwrap();
    assert_eq!(response.finish_reason, FinishReason::Stop);
    assert_eq!(response.text().as_str(), Some("answer"));
    assert_eq!(response.usage.unwrap().input_tokens, Some(7.0));
}
