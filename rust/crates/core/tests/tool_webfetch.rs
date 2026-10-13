include!("tool_fixture.rs");

use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::Arc,
    thread,
};
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::tools::{
    builtin::webfetch::{self, WebFetch},
    registry::{Options, Tool},
};
use ycoding_schema::{JsonValue, parse_json};

fn register_webfetch(
    fixture: &ToolFixture,
) -> (
    ycoding_core::tools::registry::Registry,
    ycoding_core::tools::registry::Registration,
) {
    let registry = fixture.registry();
    let registration = registry
        .register(
            vec![(
                "webfetch".into(),
                Arc::new(WebFetch {
                    policy: fixture.policy.clone(),
                }) as Arc<dyn Tool>,
            )],
            Options::direct(),
        )
        .unwrap();
    (registry, registration)
}

fn response_server(response: String) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/public", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 2048];
        loop {
            let count = socket.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        socket.write_all(response.as_bytes()).unwrap();
        String::from_utf8(bytes).unwrap()
    });
    (url, task)
}

#[tokio::test]
async fn fetches_an_http_url_with_permissions_and_format_headers() {
    let fixture = ToolFixture::new();
    let (url, server) = response_server(
        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello".into(),
    );
    let (registry, _registration) = register_webfetch(&fixture);
    let definition = &registry.materialize(&[]).definitions[0];
    assert_eq!(definition.name.to_utf8().unwrap(), "webfetch");
    assert_eq!(
        definition.description.to_utf8().unwrap(),
        "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Each HTTP redirect requires permission for its destination before it is followed, up to 10 redirects. Large text results may be replaced with a preview while the complete output is retained in managed storage."
    );
    assert_eq!(
        definition.input_schema,
        parse_json(r#"{"type":"object","properties":{"url":{"type":"string","description":"The HTTP or HTTPS URL to fetch content from"},"format":{"anyOf":[{"type":"string","enum":["text","markdown","html"]},{"type":"null"}],"description":"The format to return the content in. Defaults to markdown."},"timeout":{"anyOf":[{"type":"number","allOf":[{"exclusiveMinimum":0},{"maximum":120}]},{"type":"null"}],"description":"Optional timeout in seconds (maximum: 120)"}},"required":["url"],"additionalProperties":false}"#).unwrap()
    );
    let output = registry
        .materialize(&[])
        .invoke(
            "webfetch",
            parse_json(&format!(
                "{{\"url\":{},\"format\":\"text\"}}",
                ycoding_schema::stringify_json(&JsonValue::String(url.clone().into()))
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Text(JsonValue::String("hello".into()))
    );
    assert_eq!(
        output.output.unwrap().structured,
        parse_json(&format!(
            "{{\"url\":{},\"contentType\":\"text/plain; charset=utf-8\",\"format\":\"text\",\"output\":\"hello\"}}",
            ycoding_schema::stringify_json(&JsonValue::String(url.clone().into()))
        ))
        .unwrap()
    );
    let request = server.join().unwrap();
    assert!(request.starts_with("GET /public HTTP/1.1\r\n"));
    assert!(
        request
            .to_ascii_lowercase()
            .contains("accept: text/plain;q=1.0")
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("accept-language: en-us,en;q=0.9")
    );
    fixture.cleanup();
}

#[test]
fn html_conversions_drop_active_content_and_preserve_supported_markdown() {
    let html = "<meta name=description content=bad><link rel=stylesheet href=bad><h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad {}</style>";
    assert_eq!(webfetch::extract_text_from_html(html), "Helloworld wide");
    assert_eq!(
        webfetch::convert_html_to_markdown(html),
        "# Hello\n\nworld **wide**"
    );
}

#[tokio::test]
async fn authorizes_each_redirect_before_contacting_its_destination() {
    let fixture = ToolFixture::new();
    let destination_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let destination = format!("http://{}", destination_listener.local_addr().unwrap());
    let destination_server = tokio::spawn(async move {
        match tokio::time::timeout(
            std::time::Duration::from_secs(1),
            destination_listener.accept(),
        )
        .await
        {
            Ok(Ok((mut socket, _))) => {
                use tokio::io::AsyncWriteExt;
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nprivate",
                    )
                    .await
                    .unwrap();
                true
            }
            _ => false,
        }
    });
    let source_response = format!(
        "HTTP/1.1 302 Found\r\nLocation: {destination}/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let (source, source_task) = response_server(source_response);
    fixture.deny("webfetch", &format!("{destination}/private"));
    let (registry, _registration) = register_webfetch(&fixture);
    let result = registry
        .materialize(&[])
        .invoke(
            "webfetch",
            parse_json(&format!(
                "{{\"url\":{}}}",
                ycoding_schema::stringify_json(&JsonValue::String(source.into()))
            ))
            .unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let result_is_error = matches!(result.result, ToolResultValue::Error(_));
    assert!(
        source_task
            .join()
            .unwrap()
            .starts_with("GET /public HTTP/1.1\r\n")
    );
    let destination_contacted = destination_server.await.unwrap();
    fixture.cleanup();
    assert_eq!((result_is_error, destination_contacted), (true, false));
}
