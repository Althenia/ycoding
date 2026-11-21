use super::support::*;
use crate::dots::carrier::executor_rpc::{
    control::{Abort, locked},
    error::{CallError, HandlerError, RpcError},
    handler::{Boxed, CallOptions, EnvironmentInfoFn, InitializeContext},
    json::MAX_MESSAGE_BYTES,
    types::*,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use ycoding_core::ycoding_schema::{JsonValue, stringify_json};

const PID: &str = r#"{"processId":"p1"}"#;

async fn ready() -> Harness {
    let harness = Harness::new();
    harness.handshake().await;
    harness
}

async fn raw(harness: &Harness, bytes: Vec<u8>) -> Vec<JsonValue> {
    harness
        .session
        .receive(bytes)
        .await
        .iter()
        .map(|frame| parse(std::str::from_utf8(frame).expect("UTF-8 response")))
        .collect()
}

fn result_text(response: &JsonValue) -> String {
    assert!(
        !has(response, "error"),
        "unexpected error: {}",
        stringify_json(response)
    );
    stringify_json(at(response, "result"))
}

fn assert_error(response: &JsonValue, id: i64, code: i64, message: &str) {
    assert_eq!(num_of(at(response, "id")) as i64, id);
    assert_eq!(error_code(response), code);
    assert_eq!(error_message(response), message);
    assert!(!has(response, "result"));
}

fn bare_info_fn() -> EnvironmentInfoFn {
    Arc::new(|| {
        let mut info = canonical_info();
        info.capabilities = EnvironmentCapabilities::default();
        let future: Boxed<'static, Result<EnvironmentInfo, HandlerError>> =
            Box::pin(async move { Ok(info) });
        future
    })
}

#[tokio::test]
async fn initialize_returns_the_session_id_and_the_full_canonical_environment_info() {
    let harness = Harness::new();
    let response = harness
        .one(&request(1, "initialize", r#"{"clientName":"codex"}"#))
        .await;
    let result = at(&response, "result");
    assert_eq!(str_of(at(result, "sessionId")), SESSION_ID);
    let capabilities = at(at(result, "environmentInfo"), "capabilities");
    for name in [
        "networkProxyLaunch",
        "credentialMasking",
        "sandboxedFileStreaming",
        "shellSnapshotV2",
        "environmentConfigRead",
        "capabilityDiscoveryV2",
    ] {
        assert_eq!(at(capabilities, name), &JsonValue::Bool(true), "{name}");
    }
    assert_eq!(harness.backend.recorded(), ["initialize"]);
}

#[tokio::test]
async fn initialize_may_only_succeed_once() {
    let harness = Harness::new();
    harness
        .one(&request(1, "initialize", r#"{"clientName":"c"}"#))
        .await;
    let again = harness
        .one(&request(2, "initialize", r#"{"clientName":"c"}"#))
        .await;
    assert_error(
        &again,
        2,
        -32600,
        "initialize may only be sent once per connection",
    );
    assert_eq!(harness.backend.recorded(), ["initialize"]);
}

#[tokio::test]
async fn initialize_validates_its_params() {
    let harness = Harness::new();
    let missing = harness.one(r#"{"id":1,"method":"initialize"}"#).await;
    assert_error(&missing, 1, -32602, "Invalid params: object expected");
    let nameless = harness
        .one(&request(2, "initialize", r#"{"clientName":""}"#))
        .await;
    assert_error(
        &nameless,
        2,
        -32602,
        "Invalid params: clientName is required",
    );
    let resume = harness
        .one(&request(
            3,
            "initialize",
            r#"{"clientName":"c","resumeSessionId":7}"#,
        ))
        .await;
    assert_error(
        &resume,
        3,
        -32602,
        "Invalid params: invalid resumeSessionId",
    );
    assert!(harness.backend.recorded().is_empty());
}

#[tokio::test]
async fn a_failed_initialize_may_be_retried() {
    let harness = Harness::new();
    let resume = harness
        .one(&request(
            1,
            "initialize",
            r#"{"clientName":"c","resumeSessionId":"nope"}"#,
        ))
        .await;
    assert_error(&resume, 1, -32600, "unknown session id nope");
    let retry = harness
        .one(&request(2, "initialize", r#"{"clientName":"c"}"#))
        .await;
    assert_eq!(str_of(at(at(&retry, "result"), "sessionId")), SESSION_ID);
    assert_eq!(harness.backend.recorded(), ["resume", "initialize"]);
}

#[tokio::test]
async fn a_resumable_backend_resumes_the_requested_session() {
    let backend = Backend::new().configure(|backend| backend.resumable = true);
    let harness = Harness::with_backend(backend);
    let response = harness
        .one(&request(
            1,
            "initialize",
            r#"{"clientName":"c","resumeSessionId":"older"}"#,
        ))
        .await;
    assert_eq!(str_of(at(at(&response, "result"), "sessionId")), "older");
}

#[tokio::test]
async fn methods_are_gated_by_initialize_and_initialized() {
    let harness = Harness::new();
    for (method, family) in [
        ("process/start", "exec"),
        ("fs/readFile", "filesystem"),
        ("fs/open", "filesystem"),
        ("environment/info", "environment info"),
        ("environment/status", "environment status"),
        ("environmentConfig/read", "environment config"),
        ("capabilityRoots/discoverV1", "capability discovery"),
        ("capabilities/discoverV2", "capabilities"),
        ("http/request", "http"),
    ] {
        let response = harness.one(&request(4, method, "{}")).await;
        assert_error(
            &response,
            4,
            -32600,
            &format!("client must call initialize before using {family} methods"),
        );
    }
    assert!(harness.rpc(&notification("initialized")).await.is_empty());
    harness
        .one(&request(1, "initialize", r#"{"clientName":"c"}"#))
        .await;
    let early = harness.one(&request(5, "fs/readFile", "{}")).await;
    assert_error(
        &early,
        5,
        -32600,
        "client must send initialized before using filesystem methods",
    );
    assert!(harness.rpc(&notification("initialized")).await.is_empty());
    let allowed = harness
        .one(&request(
            6,
            "fs/readFile",
            &format!(r#"{{"path":"{FILE}"}}"#),
        ))
        .await;
    assert_eq!(result_text(&allowed), r#"{"dataBase64":"aGk="}"#);
}

#[tokio::test]
async fn malformed_frames_get_an_id_less_error() {
    let harness = Harness::new();
    let cases: [(Vec<u8>, &str); 5] = [
        (vec![0xff, 0xfe], "Invalid UTF-8 framing"),
        (b"{".to_vec(), "Invalid JSON framing"),
        (b"[]".to_vec(), "expected a JSON-RPC object"),
        (b"5".to_vec(), "expected a JSON-RPC object"),
        (b"\"s\"".to_vec(), "expected a JSON-RPC object"),
    ];
    for (bytes, message) in cases {
        let responses = raw(&harness, bytes).await;
        assert_eq!(responses.len(), 1);
        assert_error(&responses[0], -1, -32600, message);
    }
}

#[tokio::test]
async fn frames_larger_than_the_message_limit_are_refused() {
    let harness = Harness::new();
    let responses = raw(&harness, vec![b' '; MAX_MESSAGE_BYTES + 1]).await;
    assert_error(&responses[0], -1, -32600, "Message exceeds size limit");
}

#[tokio::test]
async fn a_utf8_byte_order_mark_is_skipped() {
    let harness = ready().await;
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend_from_slice(request(7, "environment/status", "{}").as_bytes());
    let responses = raw(&harness, bytes).await;
    assert_eq!(result_text(&responses[0]), r#"{"status":"ready"}"#);
}

#[tokio::test]
async fn request_ids_are_validated_and_echoed() {
    let harness = ready().await;
    let long = format!("\"{}\"", "x".repeat(257));
    for id in [
        "null",
        "true",
        "1.5",
        "9007199254740992",
        "[]",
        long.as_str(),
    ] {
        let response = harness
            .one(&format!(r#"{{"id":{id},"method":"environment/status"}}"#))
            .await;
        assert_error(&response, -1, -32600, "Invalid request ID");
    }
    let text = harness
        .one(r#"{"id":"abc","method":"environment/status"}"#)
        .await;
    assert_eq!(str_of(at(&text, "id")), "abc");
    let max = harness
        .one(r#"{"id":9007199254740991,"method":"environment/status"}"#)
        .await;
    assert_eq!(num_of(at(&max, "id")), 9_007_199_254_740_991.0);
}

#[tokio::test]
async fn requests_without_a_usable_method_fail_but_notifications_are_silent() {
    let harness = ready().await;
    let long = format!("\"{}\"", "m".repeat(257));
    for method in ["\"\"", "5", long.as_str()] {
        let response = harness
            .one(&format!(r#"{{"id":7,"method":{method}}}"#))
            .await;
        assert_error(&response, 7, -32600, "Invalid method name");
    }
    let absent = harness.one(r#"{"id":8}"#).await;
    assert_error(&absent, 8, -32600, "Invalid method name");
    assert!(harness.rpc(r#"{"method":5}"#).await.is_empty());
    assert!(harness.rpc("{}").await.is_empty());
    assert!(harness.rpc(&notification("not/a/method")).await.is_empty());
}

#[tokio::test]
async fn unsupported_requests_fail_with_a_truncated_method_name() {
    let harness = Harness::new();
    let unsupported = harness.one(&request(1, "bogus/method", "{}")).await;
    assert_error(
        &unsupported,
        1,
        -32601,
        "Method not supported: bogus/method",
    );
    let long = "a".repeat(100);
    let truncated = harness.one(&request(2, &long, "{}")).await;
    assert_error(
        &truncated,
        2,
        -32601,
        &format!("Method not supported: {}", "a".repeat(64)),
    );
    let initialized = harness.one(&request(3, "initialized", "{}")).await;
    assert_error(&initialized, 3, -32601, "Method not supported: initialized");
}

#[tokio::test]
async fn deeply_nested_or_huge_messages_exceed_the_complexity_limit() {
    let harness = ready().await;
    let deep = format!("{}{}", "[".repeat(130), "]".repeat(130));
    let nested = harness
        .one(&format!(
            r#"{{"id":3,"method":"environment/status","params":{deep}}}"#
        ))
        .await;
    assert_error(
        &nested,
        3,
        -32600,
        "JSON-RPC message exceeds complexity limit",
    );
    let wide = format!("[{}0]", "0,".repeat(262_144));
    let huge = harness
        .one(&format!(
            r#"{{"id":4,"method":"environment/status","params":{wide}}}"#
        ))
        .await;
    assert_error(
        &huge,
        4,
        -32600,
        "JSON-RPC message exceeds complexity limit",
    );
}

#[tokio::test]
async fn process_methods_round_trip() {
    let harness = ready().await;
    let start = harness
        .one(&request(
            10,
            "process/start",
            r#"{"processId":"p1","argv":["ls"],"cwd":"file:///w","env":{"A":"1"},"tty":true}"#,
        ))
        .await;
    assert_eq!(
        result_text(&start),
        r#"{"processId":"p1","sandboxType":"none"}"#
    );
    {
        let started = locked(&harness.backend.started);
        assert_eq!(started[0].argv, [Text::from("ls")]);
        assert!(started[0].tty && !started[0].pipe_stdin);
    }
    let read = harness
        .one(&request(11, "process/read", r#"{"processId":"p1"}"#))
        .await;
    assert_eq!(
        result_text(&read),
        r#"{"chunks":[{"seq":1,"stream":"stdout","chunk":"b3V0"}],"nextSeq":2,"exited":true,"exitCode":0,"closed":true,"failure":null,"sandboxDenied":false}"#
    );
    let write = harness
        .one(&request(
            12,
            "process/write",
            r#"{"processId":"p1","writeId":"w","chunk":"aGk="}"#,
        ))
        .await;
    assert_eq!(result_text(&write), r#"{"status":"accepted"}"#);
    let signal = harness
        .one(&request(
            13,
            "process/signal",
            r#"{"processId":"p1","signal":"interrupt"}"#,
        ))
        .await;
    assert_eq!(result_text(&signal), "{}");
    let terminate = harness.one(&request(14, "process/terminate", PID)).await;
    assert_eq!(result_text(&terminate), r#"{"running":false}"#);
}

#[tokio::test]
async fn filesystem_methods_round_trip() {
    let harness = ready().await;
    let path = format!(r#"{{"path":"{FILE}"}}"#);
    assert_eq!(
        result_text(&harness.one(&request(10, "fs/readFile", &path)).await),
        r#"{"dataBase64":"aGk="}"#
    );
    let write = format!(r#"{{"path":"{FILE}","dataBase64":"aGk="}}"#);
    assert_eq!(
        result_text(&harness.one(&request(11, "fs/writeFile", &write)).await),
        "{}"
    );
    assert_eq!(
        result_text(&harness.one(&request(12, "fs/getMetadata", &path)).await),
        r#"{"isDirectory":false,"isFile":true,"isSymlink":false,"size":2,"createdAtMs":10,"modifiedAtMs":20}"#
    );
    assert_eq!(
        result_text(&harness.one(&request(13, "fs/readDirectory", &path)).await),
        r#"{"entries":[{"fileName":"a.txt","isDirectory":false,"isFile":true}]}"#
    );
    assert_eq!(
        result_text(&harness.one(&request(14, "fs/canonicalize", &path)).await),
        format!(r#"{{"path":"{FILE}"}}"#)
    );
}

#[tokio::test]
async fn environment_and_discovery_methods_round_trip() {
    let harness = ready().await;
    let info = harness.one(&request(10, "environment/info", "{}")).await;
    assert_eq!(str_of(at(at(at(&info, "result"), "shell"), "name")), "zsh");
    assert_eq!(
        result_text(&harness.one(&request(11, "environment/status", "{}")).await),
        r#"{"status":"ready"}"#
    );
    let config = harness
        .one(&request(
            12,
            "environmentConfig/read",
            r#"{"cwd":"file:///w","configPaths":[["a"]],"requirementsPaths":[]}"#,
        ))
        .await;
    assert_eq!(
        str_of(at(
            at_first(at(at(&config, "result"), "config"), "layers"),
            "source"
        )),
        "user"
    );
    let roots = harness
        .one(&request(
            13,
            "capabilityRoots/discoverV1",
            r#"{"roots":[{"id":"r","path":"file:///r"}]}"#,
        ))
        .await;
    assert_eq!(
        str_of(at(at_first(at(&roots, "result"), "roots"), "id")),
        "r"
    );
}

fn at_first<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    match at(value, key) {
        JsonValue::Array(items) => &items[0],
        other => panic!("not an array: {}", stringify_json(other)),
    }
}

#[tokio::test]
async fn connection_methods_round_trip() {
    let harness = ready().await;
    let call = |id: i64, method: &'static str, params: String| {
        let harness = &harness;
        async move { result_text(&harness.one(&request(id, method, &params)).await) }
    };
    assert_eq!(
        call(10, "fs/createDirectory", format!(r#"{{"path":"{FILE}"}}"#)).await,
        "{}"
    );
    assert_eq!(
        call(
            11,
            "fs/open",
            format!(r#"{{"handleId":"h","path":"{FILE}"}}"#)
        )
        .await,
        r#"{"handleId":"h"}"#
    );
    assert_eq!(
        call(
            12,
            "fs/readBlock",
            r#"{"handleId":"h","offset":0,"len":2}"#.into()
        )
        .await,
        r#"{"chunk":"aGk=","eof":true}"#
    );
    assert_eq!(
        call(
            13,
            "fs/writeBlock",
            r#"{"handleId":"h","offset":0,"chunk":"aGk="}"#.into()
        )
        .await,
        "{}"
    );
    assert_eq!(
        call(14, "fs/close", r#"{"handleId":"h"}"#.into()).await,
        "{}"
    );
    assert_eq!(
        call(15, "fs/walk", format!(r#"{{"path":"{FILE}","options":{{"maxDepth":1,"maxDirectories":1,"maxEntries":1,"followDirectorySymlinks":false}}}}"#)).await,
        format!(r#"{{"entries":[{{"path":"{FILE}","kind":"file"}}],"errors":[],"truncated":false}}"#)
    );
    assert_eq!(
        call(16, "fs/copy", format!(r#"{{"sourcePath":"{FILE}","destinationPath":"file:///workspace/b.txt","recursive":false}}"#)).await,
        "{}"
    );
    assert_eq!(
        call(
            17,
            "capabilities/discoverV2",
            r#"{"cwd":"file:///w"}"#.into()
        )
        .await,
        r#"{"plugins":[],"skills":[],"warnings":["file:///w"]}"#
    );
    assert_eq!(
        call(
            18,
            "http/request",
            r#"{"method":"GET","url":"https://e.test/","requestId":"r"}"#.into()
        )
        .await,
        r#"{"status":200,"headers":[{"name":"content-type","value":"text/plain"}],"bodyBase64":"b2s="}"#
    );
}

#[tokio::test]
async fn invalid_params_never_reach_the_backend() {
    let harness = ready().await;
    let missing = harness.one(r#"{"id":3,"method":"process/start"}"#).await;
    assert_error(&missing, 3, -32602, "Invalid params: object expected");
    let bad_path = harness
        .one(&request(4, "fs/readFile", r#"{"path":"http://x"}"#))
        .await;
    assert_error(
        &bad_path,
        4,
        -32602,
        "Invalid params: path must be a valid file:// URI",
    );
    let bad_open = harness
        .one(&request(5, "fs/open", r#"{"path":"file:///a"}"#))
        .await;
    assert_error(&bad_open, 5, -32602, "missing field `handleId`");
    let bad_config = harness
        .one(&request(6, "environmentConfig/read", "{}"))
        .await;
    assert_error(&bad_config, 6, -32602, "missing field `cwd`");
    assert_eq!(harness.backend.recorded(), ["initialize"]);
}

#[tokio::test]
async fn absent_optional_methods_are_unsupported_before_params_are_decoded() {
    let harness = Harness::build(Backend::minimal(), bare_info_fn(), None);
    harness.handshake().await;
    for (id, method) in [
        (3, "environmentConfig/read"),
        (4, "capabilityRoots/discoverV1"),
        (5, "capabilities/discoverV2"),
        (6, "fs/open"),
        (7, "http/request"),
    ] {
        let response = harness.one(&request(id, method, "5")).await;
        assert_error(
            &response,
            id,
            -32601,
            &format!("Method not supported: {method}"),
        );
    }
}

#[tokio::test]
async fn backend_errors_are_relayed_without_fabricating_success() {
    let harness = ready().await;
    let start = r#"{"processId":"p1","argv":["ls"],"cwd":"file:///w","env":{}}"#;
    for (failure, code, message) in [
        (
            HandlerError::Executor {
                code: -32001,
                message: Text::default(),
            },
            -32001,
            "Permission denied",
        ),
        (
            HandlerError::Executor {
                code: -32602,
                message: "bad cwd".into(),
            },
            -32602,
            "bad cwd",
        ),
        (
            HandlerError::Executor {
                code: -5,
                message: "x".into(),
            },
            -32603,
            "Internal error",
        ),
        (
            HandlerError::Rpc(RpcError::new(-32099, "custom")),
            -32099,
            "custom",
        ),
        (HandlerError::Internal, -32603, "Internal error"),
    ] {
        *locked(&harness.backend.fail_start) = Some(failure);
        let response = harness.one(&request(9, "process/start", start)).await;
        assert_error(&response, 9, code, message);
    }
    let missing = harness
        .one(&request(
            10,
            "fs/readFile",
            r#"{"path":"file:///workspace/missing"}"#,
        ))
        .await;
    assert_error(
        &missing,
        10,
        -32004,
        "No such file or directory (os error 2)",
    );
    let remove = harness
        .one(&request(
            11,
            "fs/remove",
            &format!(r#"{{"path":"{FILE}"}}"#),
        ))
        .await;
    assert_error(&remove, 11, -32001, "Permission denied");
}

#[tokio::test]
async fn advertised_capabilities_without_a_backend_fail_closed() {
    let backend = Backend::new().configure(|backend| backend.features = BackendFeatures::default());
    let harness = Harness::with_backend(backend);
    let response = harness
        .one(&request(1, "initialize", r#"{"clientName":"c"}"#))
        .await;
    assert_error(&response, 1, -32603, "Internal error");

    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let info: EnvironmentInfoFn = Arc::new(move || {
        let first = counter.fetch_add(1, Ordering::SeqCst) == 0;
        let mut info = canonical_info();
        if first {
            info.capabilities = EnvironmentCapabilities::default();
        }
        let future: Boxed<'static, Result<EnvironmentInfo, HandlerError>> =
            Box::pin(async move { Ok(info) });
        future
    });
    let harness = Harness::build(
        Backend::new().configure(|b| b.features = BackendFeatures::default()),
        info,
        None,
    );
    harness.handshake().await;
    let response = harness.one(&request(2, "environment/info", "{}")).await;
    assert_error(&response, 2, -32603, "Internal error");
}

#[tokio::test]
async fn an_environment_info_failure_is_reported_after_a_successful_initialize() {
    let info: EnvironmentInfoFn = Arc::new(|| {
        let future: Boxed<'static, Result<EnvironmentInfo, HandlerError>> =
            Box::pin(async { Err(HandlerError::Rpc(RpcError::new(-32603, "info unavailable"))) });
        future
    });
    let harness = Harness::build(Backend::new(), info, None);
    let response = harness
        .one(&request(1, "initialize", r#"{"clientName":"c"}"#))
        .await;
    assert_error(&response, 1, -32603, "info unavailable");
    let again = harness
        .one(&request(2, "initialize", r#"{"clientName":"c"}"#))
        .await;
    assert_error(
        &again,
        2,
        -32600,
        "initialize may only be sent once per connection",
    );
}

#[tokio::test]
async fn control_requests_bypass_a_blocked_ordinary_request() {
    let harness = ready().await;
    harness.backend.gate_reads.store(true, Ordering::SeqCst);
    let blocked = tokio::spawn(
        harness
            .session
            .receive(request(10, "process/read", PID).into_bytes()),
    );
    eventually(|| harness.backend.reads_entered.load(Ordering::SeqCst) == 1).await;
    let signal = harness
        .one(&request(
            11,
            "process/signal",
            r#"{"processId":"p1","signal":"interrupt"}"#,
        ))
        .await;
    assert_eq!(result_text(&signal), "{}");
    let status = harness.one(&request(12, "environment/status", "{}")).await;
    assert_eq!(result_text(&status), r#"{"status":"ready"}"#);
    assert!(!blocked.is_finished());
    harness.backend.read_gate.add_permits(1);
    let frames = blocked.await.unwrap();
    assert_eq!(
        num_of(at(&parse(std::str::from_utf8(&frames[0]).unwrap()), "id")) as i64,
        10
    );
}

#[tokio::test]
async fn ordinary_requests_run_one_at_a_time_in_arrival_order() {
    let harness = ready().await;
    harness.backend.gate_reads.store(true, Ordering::SeqCst);
    let first = tokio::spawn(
        harness
            .session
            .receive(request(10, "process/read", PID).into_bytes()),
    );
    let second = tokio::spawn(
        harness
            .session
            .receive(request(11, "process/read", PID).into_bytes()),
    );
    eventually(|| harness.backend.reads_entered.load(Ordering::SeqCst) == 1).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(harness.backend.reads_entered.load(Ordering::SeqCst), 1);
    harness.backend.read_gate.add_permits(1);
    eventually(|| harness.backend.reads_entered.load(Ordering::SeqCst) == 2).await;
    assert!(first.await.is_ok());
    assert!(!second.is_finished());
    harness.backend.read_gate.add_permits(1);
    let frames = second.await.unwrap();
    assert_eq!(
        num_of(at(&parse(std::str::from_utf8(&frames[0]).unwrap()), "id")) as i64,
        11
    );
}

#[tokio::test]
async fn streamed_http_bodies_follow_the_response_as_notifications() {
    let harness = ready().await;
    let params =
        r#"{"method":"GET","url":"https://e.test/","requestId":"r1","streamResponse":true}"#;
    assert!(
        harness
            .rpc(&request(5, "http/request", params))
            .await
            .is_empty()
    );
    let sent = locked(&harness.sent).clone();
    assert_eq!(sent.len(), 1);
    let response = parse(std::str::from_utf8(&sent[0]).unwrap());
    assert_eq!(num_of(at(&response, "id")) as i64, 5);
    assert_eq!(str_of(at(at(&response, "result"), "bodyBase64")), "");
    eventually(|| harness.notes_named("http/request/bodyDelta").len() == 2).await;
    let deltas = harness.notes_named("http/request/bodyDelta");
    assert_eq!(
        stringify_json(&deltas[0]),
        r#"{"requestId":"r1","seq":1,"deltaBase64":"YWI=","done":false,"error":null}"#
    );
    assert_eq!(
        stringify_json(&deltas[1]),
        r#"{"requestId":"r1","seq":2,"deltaBase64":"","done":true,"error":null}"#
    );
    assert_eq!(harness.backend.http_started.load(Ordering::SeqCst), 1);
    assert_eq!(harness.backend.http_cancelled.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_unsent_http_response_cancels_the_stream_and_answers_nothing() {
    let harness = ready().await;
    harness.fail_sends.store(true, Ordering::SeqCst);
    let params =
        r#"{"method":"GET","url":"https://e.test/","requestId":"r1","streamResponse":true}"#;
    assert!(
        harness
            .rpc(&request(5, "http/request", params))
            .await
            .is_empty()
    );
    eventually(|| harness.backend.http_cancelled.load(Ordering::SeqCst) == 1).await;
    assert_eq!(harness.backend.http_started.load(Ordering::SeqCst), 0);
    assert!(harness.notes_named("http/request/bodyDelta").is_empty());
}

fn context(harness: &Harness) -> InitializeContext {
    locked(&harness.backend.init_context)
        .clone()
        .expect("initialize captured its context")
}

fn sent_frames(harness: &Harness) -> Vec<JsonValue> {
    locked(&harness.sent)
        .iter()
        .map(|bytes| parse(std::str::from_utf8(bytes).unwrap()))
        .collect()
}

#[tokio::test]
async fn calls_are_numbered_from_one_and_settled_by_matching_responses() {
    let harness = ready().await;
    let caller = context(&harness).caller;
    let first = tokio::spawn(caller.call(
        "network/policyRequest",
        parse(r#"{"a":1}"#),
        CallOptions::default(),
    ));
    eventually(|| sent_frames(&harness).len() == 1).await;
    let frame = sent_frames(&harness).remove(0);
    assert_eq!(
        stringify_json(&frame),
        r#"{"id":1,"method":"network/policyRequest","params":{"a":1}}"#
    );
    assert!(
        harness
            .rpc(r#"{"id":1,"result":{"ok":true}}"#)
            .await
            .is_empty()
    );
    assert_eq!(
        stringify_json(&first.await.unwrap().unwrap()),
        r#"{"ok":true}"#
    );
    assert!(harness.rpc(r#"{"id":1,"result":1}"#).await.is_empty());

    let second = tokio::spawn(caller.call("m", JsonValue::Null, CallOptions::default()));
    eventually(|| sent_frames(&harness).len() == 2).await;
    assert_eq!(num_of(at(&sent_frames(&harness)[1], "id")) as i64, 2);
    assert!(
        harness
            .rpc(r#"{"id":2,"error":{"code":-32001,"message":"nope"}}"#)
            .await
            .is_empty()
    );
    assert_eq!(
        second.await.unwrap(),
        Err(CallError::Remote(RpcError::new(-32001, "nope")))
    );

    let third = tokio::spawn(caller.call("m", JsonValue::Null, CallOptions::default()));
    eventually(|| sent_frames(&harness).len() == 3).await;
    assert!(harness.rpc(r#"{"id":3,"error":"x"}"#).await.is_empty());
    assert_eq!(
        third.await.unwrap(),
        Err(CallError::Remote(RpcError::new(-32603, "Internal error")))
    );
}

#[tokio::test]
async fn response_shaped_frames_before_any_call_are_ordinary_invalid_requests() {
    let harness = ready().await;
    let responses = harness.rpc(r#"{"id":5,"result":{}}"#).await;
    assert_error(&responses[0], 5, -32600, "Invalid method name");
}

#[tokio::test]
async fn calls_time_out_and_late_responses_are_ignored() {
    let harness = ready().await;
    let caller = context(&harness).caller;
    let options = CallOptions {
        timeout: Some(Duration::from_millis(20)),
        signal: None,
    };
    let outcome = caller
        .call("network/policyRequest", JsonValue::Null, options)
        .await;
    assert_eq!(
        outcome,
        Err(CallError::TimedOut {
            method: "network/policyRequest".into()
        })
    );
    assert_eq!(
        outcome.unwrap_err().to_string(),
        "executor request network/policyRequest timed out"
    );
    assert!(harness.rpc(r#"{"id":1,"result":{}}"#).await.is_empty());
}

#[tokio::test]
async fn calls_can_be_cancelled_before_and_after_they_are_sent() {
    let harness = ready().await;
    let caller = context(&harness).caller;
    let cancel = Abort::new();
    let options = CallOptions {
        timeout: None,
        signal: Some(cancel.signal()),
    };
    let pending = tokio::spawn(caller.call("m", JsonValue::Null, options));
    eventually(|| sent_frames(&harness).len() == 1).await;
    cancel.abort();
    let outcome = pending.await.unwrap();
    assert_eq!(outcome, Err(CallError::Cancelled { method: "m".into() }));
    assert_eq!(
        outcome.unwrap_err().to_string(),
        "executor request m was cancelled"
    );

    let aborted = Abort::new();
    aborted.abort();
    let options = CallOptions {
        timeout: None,
        signal: Some(aborted.signal()),
    };
    assert_eq!(
        caller.call("m", JsonValue::Null, options).await,
        Err(CallError::Cancelled { method: "m".into() })
    );
    assert_eq!(sent_frames(&harness).len(), 1);
}

#[tokio::test]
async fn a_failed_send_rejects_the_call_as_closed() {
    let harness = ready().await;
    harness.fail_sends.store(true, Ordering::SeqCst);
    let caller = context(&harness).caller;
    assert_eq!(
        caller
            .call("m", JsonValue::Null, CallOptions::default())
            .await,
        Err(CallError::Closed)
    );
    assert_eq!(CallError::Closed.to_string(), "Connection closed");
}

#[tokio::test]
async fn process_events_are_delivered_as_notifications() {
    let harness = ready().await;
    let notifier = context(&harness).notifier;
    notifier
        .process_event(&ProcessEvent::Output {
            process_id: "p1".into(),
            seq: 1,
            stream: ProcessStream::Stdout,
            chunk: b"hi".to_vec(),
        })
        .await
        .unwrap();
    notifier
        .process_event(&ProcessEvent::Exited {
            process_id: "p1".into(),
            seq: 2,
            exit_code: Some(0),
            sandbox_denied: false,
        })
        .await
        .unwrap();
    notifier
        .process_event(&ProcessEvent::Closed {
            process_id: "p1".into(),
            seq: 3,
        })
        .await
        .unwrap();
    let methods: Vec<String> = locked(&harness.notes)
        .iter()
        .map(|(method, _)| method.clone())
        .collect();
    assert_eq!(
        methods,
        ["process/output", "process/exited", "process/closed"]
    );
    assert_eq!(
        stringify_json(&harness.notes_named("process/output")[0]),
        r#"{"processId":"p1","seq":1,"stream":"stdout","chunk":"aGk="}"#
    );
}

#[tokio::test]
async fn closing_aborts_handlers_rejects_calls_and_refuses_new_frames() {
    let harness = ready().await;
    harness.backend.gate_reads.store(true, Ordering::SeqCst);
    let caller = context(&harness).caller;
    let call = tokio::spawn(caller.call("m", JsonValue::Null, CallOptions::default()));
    eventually(|| sent_frames(&harness).len() == 1).await;
    let read = tokio::spawn(
        harness
            .session
            .receive(request(10, "process/read", PID).into_bytes()),
    );
    eventually(|| harness.backend.reads_entered.load(Ordering::SeqCst) == 1).await;
    harness.session.close().await;
    assert_eq!(call.await.unwrap(), Err(CallError::Closed));
    let frames = read.await.unwrap();
    assert_error(
        &parse(std::str::from_utf8(&frames[0]).unwrap()),
        10,
        -32603,
        "Internal error",
    );
    assert!(harness.backend.connection_closed.load(Ordering::SeqCst));
    let after = harness.one(&request(11, "environment/status", "{}")).await;
    assert_error(&after, -1, -32603, "Connection closed");
    assert_eq!(
        caller
            .call("m", JsonValue::Null, CallOptions::default())
            .await,
        Err(CallError::Closed)
    );
}

#[tokio::test]
async fn an_external_abort_closes_the_session() {
    let external = Abort::new();
    let harness = Harness::build(Backend::new(), info_fn(), Some(external.signal()));
    harness.handshake().await;
    external.abort();
    for _ in 0..200 {
        let response = harness.one(&request(9, "environment/status", "{}")).await;
        if has(&response, "error") {
            assert_error(&response, -1, -32603, "Connection closed");
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("session stayed open after the external abort");
}

#[tokio::test]
async fn unpaired_surrogates_round_trip_through_the_backend_unchanged() {
    let harness = ready().await;
    let start = harness
        .one(&request(
            10,
            "process/start",
            r#"{"processId":"p\ud800","argv":["a"],"cwd":"file:///w\udc00","env":{"K\ud800":"V"}}"#,
        ))
        .await;
    assert_eq!(
        stringify_json(at(&start, "result")),
        r#"{"processId":"p\ud800","sandboxType":"none"}"#
    );
    {
        let started = locked(&harness.backend.started);
        assert_eq!(started[0].process_id, units("p", &[0xd800], ""));
        assert_eq!(started[0].cwd, units("file:///w", &[0xdc00], ""));
        assert_eq!(started[0].env[0].0, units("K", &[0xd800], ""));
    }
    harness
        .one(&request(11, "fs/readFile", r#"{"path":"file:///w\ud800"}"#))
        .await;
    assert_eq!(
        locked(&harness.backend.paths).last().cloned(),
        Some(units("file:///w", &[0xd800], ""))
    );
}

#[tokio::test]
async fn ids_and_messages_echo_unpaired_surrogates() {
    let harness = ready().await;
    let status = harness
        .one(r#"{"id":"i\ud800","method":"environment/status"}"#)
        .await;
    assert_eq!(stringify_json(at(&status, "id")), r#""i\ud800""#);
    let unsupported = harness.one(r#"{"id":1,"method":"m\ud800"}"#).await;
    assert_eq!(
        stringify_json(at(at(&unsupported, "error"), "message")),
        r#""Method not supported: m\ud800""#
    );
    let boundary = format!(r#"{{"id":2,"method":"{}\ud83d\ude00"}}"#, "a".repeat(63));
    let cut = harness.one(&boundary).await;
    assert_eq!(
        stringify_json(at(at(&cut, "error"), "message")),
        format!(r#""Method not supported: {}\ud83d""#, "a".repeat(63))
    );
}

#[tokio::test]
async fn an_unknown_resume_id_is_echoed_without_replacement() {
    let harness = Harness::new();
    let response = harness
        .one(&request(
            1,
            "initialize",
            r#"{"clientName":"c\udc00","resumeSessionId":"x\ud800"}"#,
        ))
        .await;
    assert_eq!(error_code(&response), -32600);
    assert_eq!(
        stringify_json(at(at(&response, "error"), "message")),
        r#""unknown session id x\ud800""#
    );
}

#[tokio::test]
async fn backend_error_text_is_relayed_with_every_unit() {
    let harness = ready().await;
    let start = r#"{"processId":"p1","argv":["ls"],"cwd":"file:///w","env":{}}"#;
    for failure in [
        HandlerError::Executor {
            code: -32602,
            message: units("bad ", &[0xd800], " cwd"),
        },
        HandlerError::Rpc(RpcError::new(-32099, units("custom ", &[0xdc00], ""))),
    ] {
        let (code, expected) = failure.wire();
        *locked(&harness.backend.fail_start) = Some(failure);
        let response = harness.one(&request(9, "process/start", start)).await;
        assert_eq!(error_code(&response), code);
        assert_eq!(
            stringify_json(at(at(&response, "error"), "message")),
            stringify_json(&JsonValue::String(expected))
        );
    }
}
