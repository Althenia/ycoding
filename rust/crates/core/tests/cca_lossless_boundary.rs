use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(unix)]
use ycoding_core::cca::network_proxy::{
    NetworkMode, NetworkProxyAuditMetadata, RemoteNetworkProxyConfig,
    RemoteNetworkProxyLaunchConfig,
};
use ycoding_core::cca::{
    discovery::{CapabilityRootRequest, decode_discover_v2_params},
    error::{
        Attribution, AuthorizationDenied, AuthorizationInput, Authorize, AuthorizeFn, BoxFuture,
        ExecutorError, Grant, ScopeContext,
    },
    executor::{
        AnswerContext, AnswerProcess, EnvironmentOverrides, ExecParams, Executor, ExecutorOptions,
        ExecutorScope, FsReadFileParams, InitializeContext, InitializeParams, ProcessAnswer,
        ReadParams, ScopeProvider, SignalParams, TerminateParams, WriteParams,
    },
    fs_extended::{CloseParams, FsExtended, OpenMode, OpenParams, ReadBlockParams},
    http::{Emit, HttpHandler, HttpHeader, HttpRequestContext, HttpRequestParams, RedirectPolicy},
    network_proxy::Platform,
    shell_snapshot::{PrepareInput, ShellInfo, ShellSnapshotCache, ShellSnapshotRequest},
    signal::{HandlerContext, Signal},
    transcript::{ProcessRecord, ProcessRecording, Recorder, WriteRecord},
    value::{LosslessString, Value, object_get, parse_json, stringify_json},
};

fn lone(prefix: &str) -> LosslessString {
    LosslessString::from_utf16(prefix.encode_utf16().chain([0xd800]).collect())
}
fn joined(parts: &[&LosslessString]) -> LosslessString {
    LosslessString::from_utf16(parts.iter().flat_map(|part| part.code_units()).collect())
}
fn workspace() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("cca-lossless-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::canonicalize(root).unwrap()
}
fn uri(path: &Path) -> String {
    url::Url::from_file_path(path).unwrap().into()
}
fn ctx() -> HandlerContext {
    HandlerContext {
        session_id: "synthetic".into(),
        signal: Signal::default(),
    }
}
fn allow() -> AuthorizeFn {
    Arc::new(|_| Box::pin(async { Ok(Grant::noop()) }))
}

#[tokio::test]
async fn file_handles_keep_independent_storage_and_exact_duplicate_errors() {
    let root = workspace();
    std::fs::write(root.join("a"), b"first").unwrap();
    std::fs::write(root.join("b"), b"second").unwrap();
    let fs = FsExtended::new(
        vec![root.to_str().unwrap().into()],
        allow(),
        Arc::new(Vec::new),
    )
    .unwrap();
    let ctx = ctx();
    let ids = [lone("a"), LosslessString::from("a\u{fffd}")];
    for (id, path) in ids.iter().zip(["a", "b"]) {
        let params = OpenParams {
            handle_id: id.clone(),
            path: uri(&root.join(path)),
            mode: OpenMode::Read,
            sandbox: None,
        };
        assert_eq!(fs.open(params.clone(), &ctx).await.unwrap(), *id);
        let error = fs.open(params, &ctx).await.unwrap_err();
        assert_eq!(error.code, -32600);
        assert_eq!(
            error.message,
            joined(&[&"file handle `".into(), id, &"` already exists".into()])
        );
    }
    assert_eq!(
        fs.read_block(
            ReadBlockParams {
                handle_id: ids[0].clone(),
                offset: 0,
                len: 8
            },
            &ctx
        )
        .await
        .unwrap()
        .chunk,
        b"first"
    );
    fs.close_handle(
        CloseParams {
            handle_id: ids[0].clone(),
        },
        &ctx,
    )
    .await
    .unwrap();
    assert_eq!(
        fs.read_block(
            ReadBlockParams {
                handle_id: ids[1].clone(),
                offset: 0,
                len: 8
            },
            &ctx
        )
        .await
        .unwrap()
        .chunk,
        b"second"
    );
    let error = fs
        .read_block(
            ReadBlockParams {
                handle_id: ids[0].clone(),
                offset: 0,
                len: 1,
            },
            &ctx,
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        joined(&[&"unknown file handle `".into(), &ids[0], &"`".into()])
    );
    let bounded = lone(&"a".repeat(29));
    assert_eq!(
        fs.open(
            OpenParams {
                handle_id: bounded.clone(),
                path: uri(&root.join("a")),
                mode: OpenMode::Read,
                sandbox: None
            },
            &ctx
        )
        .await
        .unwrap(),
        bounded
    );
    let error = fs
        .open(
            OpenParams {
                handle_id: lone(&"a".repeat(30)),
                path: uri(&root.join("a")),
                mode: OpenMode::Read,
                sandbox: None,
            },
            &ctx,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, -32600);
    assert_eq!(
        error.message.as_str(),
        Some("file handle ID must not exceed 32 bytes")
    );
    fs.shutdown().await.unwrap();
}

fn request() -> HttpRequestParams {
    HttpRequestParams {
        method: "GET".into(),
        url: "http://example.invalid/".into(),
        headers: vec![],
        body: None,
        timeout_ms: None,
        redirect_policy: RedirectPolicy::Stop,
        request_id: lone("request"),
        stream_response: false,
    }
}
fn http_ctx() -> HttpRequestContext {
    let emit: Emit = Arc::new(|_| Box::pin(async { Ok(()) }));
    HttpRequestContext {
        signal: Signal::default(),
        emit,
    }
}

#[tokio::test]
async fn http_uses_original_selectors_and_field_specific_validation() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let capture = seen.clone();
    let authorize: AuthorizeFn = Arc::new(move |input| {
        capture.lock().unwrap().push(input);
        Box::pin(async { Err(AuthorizationDenied::default()) })
    });
    let env = Arc::new(|key: &LosslessString| {
        (key.as_str() == Some("X\u{fffd}")).then(|| "wrong".into())
    });
    let http = HttpHandler::new(authorize, Some(env)).unwrap();
    let mut params = request();
    params.headers.push(HttpHeader {
        name: "X-Test".into(),
        value: "".into(),
        value_env_var: Some(lone("X")),
    });
    let error = http.request(params, http_ctx()).await.err().unwrap();
    assert_eq!(error.code, -32602);
    assert_eq!(
        error.message,
        joined(&[
            &"http/request header X-Test requires executor environment variable ".into(),
            &lone("X")
        ])
    );
    let mut params = request();
    params.method = lone("GET");
    assert_eq!(
        http.request(params, http_ctx())
            .await
            .err()
            .unwrap()
            .message,
        LosslessString::from("http/request method is invalid: invalid HTTP method")
    );
    let mut params = request();
    params.headers.push(HttpHeader {
        name: lone("X"),
        value: "".into(),
        value_env_var: None,
    });
    assert_eq!(
        http.request(params, http_ctx())
            .await
            .err()
            .unwrap()
            .message,
        LosslessString::from("http/request header name is invalid: invalid HTTP header name")
    );
    let mut params = request();
    params.headers.push(HttpHeader {
        name: "X-Test".into(),
        value: lone(""),
        value_env_var: None,
    });
    assert_eq!(
        http.request(params, http_ctx())
            .await
            .err()
            .unwrap()
            .message,
        LosslessString::from(
            "http/request header value is invalid for X-Test: failed to parse header value"
        )
    );
    assert!(seen.lock().unwrap().is_empty());
    let empty = HttpHandler::new(allow(), Some(Arc::new(|_| None))).unwrap();
    let mut missing = request();
    missing.headers.push(HttpHeader {
        name: "X-Test".into(),
        value: "".into(),
        value_env_var: Some(lone("X")),
    });
    assert_eq!(
        empty
            .request(missing, http_ctx())
            .await
            .err()
            .unwrap()
            .message,
        joined(&[
            &"http/request header X-Test requires executor environment variable ".into(),
            &lone("X")
        ])
    );
    empty.close().await.unwrap();
    let mut params = request();
    params.url = lone("http://example.invalid/");
    assert_eq!(
        http.request(params, http_ctx()).await.err().unwrap().code,
        -32001
    );
    assert_eq!(
        seen.lock().unwrap()[0].resources,
        vec![LosslessString::from("http://example.invalid/%EF%BF%BD")]
    );
    http.close().await.unwrap();
}

struct Policy(Arc<Mutex<Vec<AuthorizationInput>>>);
impl Authorize for Policy {
    fn authorize(
        &self,
        input: AuthorizationInput,
    ) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>> {
        self.0.lock().unwrap().push(input);
        Box::pin(async { Ok(Grant::noop()) })
    }
}
struct Scope {
    root: String,
    policy: Arc<Policy>,
}
impl ExecutorScope for Scope {
    fn session_id(&self) -> String {
        "synthetic".into()
    }
    fn roots(&self) -> Vec<String> {
        vec![self.root.clone()]
    }
    fn authorization(&self) -> Arc<dyn Authorize> {
        self.policy.clone()
    }
    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
}
struct Provider {
    root: String,
    seen: Arc<Mutex<Vec<Option<Attribution>>>>,
    policy: Arc<Policy>,
}
impl ScopeProvider for Provider {
    fn scope_for(
        &self,
        attribution: Option<Attribution>,
        _: ScopeContext,
    ) -> BoxFuture<'_, Result<Arc<dyn ExecutorScope>, ExecutorError>> {
        self.seen.lock().unwrap().push(attribution);
        let scope: Arc<dyn ExecutorScope> = Arc::new(Scope {
            root: self.root.clone(),
            policy: self.policy.clone(),
        });
        Box::pin(async move { Ok(scope) })
    }
}
struct Answer(Arc<Mutex<Vec<Option<Attribution>>>>);
impl AnswerProcess for Answer {
    fn answer(
        &self,
        _: &ExecParams,
        context: AnswerContext,
    ) -> BoxFuture<'static, Result<Option<ProcessAnswer>, ExecutorError>> {
        self.0.lock().unwrap().push(context.attribution);
        Box::pin(async {
            Ok(Some(ProcessAnswer {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
            }))
        })
    }
}
async fn executor(
    root: &Path,
    policy: Arc<Policy>,
    answer: Option<Arc<dyn AnswerProcess>>,
) -> (Executor, HandlerContext) {
    let executor = Executor::new(ExecutorOptions {
        scope_provider: Arc::new(Provider {
            root: root.to_str().unwrap().into(),
            seen: Arc::new(Mutex::new(vec![])),
            policy,
        }),
        answer_process: answer,
        base_env: BTreeMap::new(),
        session_id: None,
        process_timeout_ms: None,
        max_buffered_bytes_per_process: None,
        max_live_processes: None,
        network_proxy_ca_directory: None,
        network_proxy_upstream_trust: None,
        network_policy: None,
        environment: EnvironmentOverrides::default(),
        home_directory: root.into(),
        data_directory: root.join("data"),
        codex_home_env: None,
        system_config_path: None,
        system_requirements_path: None,
        managed_config_path: None,
    });
    let signal = Signal::default();
    let initialized = executor
        .initialize(
            InitializeParams {
                client_name: "synthetic".into(),
            },
            InitializeContext {
                signal: signal.clone(),
                notify: None,
                call: None,
            },
        )
        .await
        .unwrap();
    (
        executor,
        HandlerContext {
            session_id: initialized.session_id,
            signal,
        },
    )
}

#[tokio::test]
async fn process_authorization_and_attribution_keep_original_code_units() {
    let root = workspace();
    let inputs = Arc::new(Mutex::new(vec![]));
    let answers = Arc::new(Mutex::new(vec![]));
    let (executor, ctx) = executor(
        &root,
        Arc::new(Policy(inputs.clone())),
        Some(Arc::new(Answer(answers.clone()))),
    )
    .await;
    for (index, call) in [
        lone("call"),
        "😀".repeat(128).into(),
        "😀".repeat(129).into(),
        "\u{feff}".into(),
        "\u{85}".into(),
    ]
    .into_iter()
    .enumerate()
    {
        let mut metadata = ycoding_core::cca::value::JsonObject::new();
        metadata.insert("toolCallId".into(), Value::String(call.clone()));
        let command = lone("echo ");
        executor
            .start_process(
                ExecParams {
                    process_id: format!("p{index}").into(),
                    argv: vec!["/bin/sh".into(), "-c".into(), command.clone()],
                    cwd: uri(&root).into(),
                    metadata: Some(Value::Object(metadata)),
                    ..Default::default()
                },
                &ctx,
            )
            .await
            .unwrap();
        let attribution = answers.lock().unwrap().last().cloned().unwrap();
        let expected = if index == 2 || index == 3 {
            None
        } else {
            Some(Attribution {
                thread_id: None,
                tool_call_id: Some(call),
            })
        };
        assert_eq!(attribution, expected);
        let inputs = inputs.lock().unwrap();
        let shell = inputs
            .iter()
            .rev()
            .find(|input| input.action == "shell")
            .unwrap();
        assert_eq!(shell.resources, vec![command.clone()]);
        let metadata = shell.metadata.as_ref().unwrap();
        assert_eq!(
            metadata
                .iter()
                .map(|(key, _)| key.as_str().unwrap())
                .collect::<Vec<_>>(),
            ["cwd", "workdir", "argv"]
        );
        let Value::String(argv) = object_get(metadata, "argv").unwrap() else {
            panic!()
        };
        assert_eq!(
            parse_json(argv.as_str().unwrap()).unwrap(),
            Value::Array(vec![
                Value::String("/bin/sh".into()),
                Value::String("-c".into()),
                Value::String(command)
            ])
        );
    }
    for id in [lone("missing"), "missing\u{fffd}".into()] {
        let error = executor
            .read_process(
                ReadParams {
                    process_id: id.clone(),
                    after_seq: None,
                    max_bytes: None,
                    wait_ms: None,
                },
                &ctx,
            )
            .await
            .unwrap_err();
        assert_eq!(error.message, joined(&[&"unknown process id ".into(), &id]));
        executor
            .signal_process(
                SignalParams {
                    process_id: id.clone(),
                },
                &ctx,
            )
            .await
            .unwrap();
        executor
            .terminate_process(
                TerminateParams {
                    process_id: id.clone(),
                },
                &ctx,
            )
            .await
            .unwrap();
        executor
            .write_process(
                WriteParams {
                    process_id: id.clone(),
                    write_id: lone("write"),
                    chunk: b"text".to_vec(),
                },
                &ctx,
            )
            .await
            .unwrap();
        let inputs = inputs.lock().unwrap();
        assert_eq!(inputs.last().unwrap().resources[0], id);
        assert_eq!(
            object_get(inputs.last().unwrap().metadata.as_ref().unwrap(), "writeId"),
            Some(&Value::String(lone("write")))
        );
    }
    executor.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_scope_keys_and_authorization_process_ids_are_lossless() {
    let inputs = Arc::new(Mutex::new(vec![]));
    let seen = inputs.clone();
    let authorize: AuthorizeFn = Arc::new(move |input| {
        seen.lock().unwrap().push(input);
        Box::pin(async { Err(AuthorizationDenied::default()) })
    });
    let cache = ShellSnapshotCache::new(authorize, Platform::current(), None);
    for scope_id in [lone("scope"), "scope\u{fffd}".into(), lone("scope")] {
        assert!(
            cache
                .prepare(PrepareInput {
                    session_id: "synthetic".into(),
                    process_id: lone("process"),
                    request: ShellSnapshotRequest {
                        scope_id,
                        shell: ShellInfo {
                            name: "sh".into(),
                            path: "/bin/sh".into()
                        }
                    },
                    argv: vec!["/bin/sh".into(), "-lc".into(), "true".into()],
                    arg0: None,
                    cwd: "/".into(),
                    env: vec![],
                    request_env: vec![],
                    env_policy: None,
                    sandbox_key: None
                })
                .await
                .unwrap()
                .is_none()
        );
    }
    for (env_policy, sandbox_key) in [
        (
            Some(parse_json(r#"{"extra":{"\ud800":"\udfff"}}"#).unwrap()),
            None,
        ),
        (
            Some(parse_json(r#"{"extra":{"\ufffd":"\ufffd"}}"#).unwrap()),
            None,
        ),
        (
            None,
            Some(stringify_json(
                &parse_json(r#"{"opaque":"\ud800"}"#).unwrap(),
            )),
        ),
        (
            None,
            Some(stringify_json(
                &parse_json(r#"{"opaque":"\ufffd"}"#).unwrap(),
            )),
        ),
    ] {
        assert!(
            cache
                .prepare(PrepareInput {
                    session_id: "synthetic".into(),
                    process_id: lone("process"),
                    request: ShellSnapshotRequest {
                        scope_id: "opaque".into(),
                        shell: ShellInfo {
                            name: "sh".into(),
                            path: "/bin/sh".into()
                        }
                    },
                    argv: vec!["/bin/sh".into(), "-lc".into(), "true".into()],
                    arg0: None,
                    cwd: "/".into(),
                    env: vec![],
                    request_env: vec![],
                    env_policy,
                    sandbox_key
                })
                .await
                .unwrap()
                .is_none()
        );
    }
    {
        let inputs = inputs.lock().unwrap();
        assert_eq!(inputs.len(), 6);
        assert_eq!(
            object_get(inputs[0].metadata.as_ref().unwrap(), "processId"),
            Some(&Value::String(lone("process")))
        );
        assert_eq!(
            object_get(inputs[0].metadata.as_ref().unwrap(), "shellSnapshotScope"),
            Some(&Value::String(lone("scope")))
        );
        assert_eq!(
            object_get(inputs[1].metadata.as_ref().unwrap(), "shellSnapshotScope"),
            Some(&Value::String("scope\u{fffd}".into()))
        );
    }
    cache.close().await;
}

#[tokio::test]
async fn missing_discovery_roots_echo_two_distinct_original_ids() {
    let root = workspace();
    let (executor, ctx) =
        executor(&root, Arc::new(Policy(Arc::new(Mutex::new(vec![])))), None).await;
    let ids = [lone("root"), "root\u{fffd}".into()];
    let roots = ids
        .iter()
        .map(|id| CapabilityRootRequest {
            id: id.clone(),
            path: uri(&root.join("missing")),
            sandbox: None,
        })
        .collect();
    let found = executor
        .discover_capability_roots(roots, &ctx)
        .await
        .unwrap();
    assert_eq!(found.len(), 2);
    for (result, id) in found.iter().zip(ids) {
        assert_eq!(result.id, id);
        assert!(result.error.is_some());
        let Value::Object(value) = result.to_json() else {
            panic!()
        };
        assert_eq!(object_get(&value, "id"), Some(&Value::String(id)));
    }
    executor.close().await.unwrap();
}

#[test]
fn dynamic_executor_errors_preserve_utf16_and_long_source_messages() {
    let message = joined(&[&"x".repeat(1024).into(), &lone("")]);
    let error = ExecutorError::new(-32602, message.clone());
    assert_eq!(error.message, message);
    assert_eq!(
        stringify_json(&Value::String(error.message)),
        format!("\"{}\\ud800\"", "x".repeat(1024))
    );
}

#[tokio::test]
async fn discovery_ignores_unknown_utf16_tokens_and_preserves_inline_mcp() {
    let root = workspace();
    let plugin = root.join(".codex/plugins/cache/market/demo/local");
    std::fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
    let manifest = r#"{"name":"demo","interface":{"displayName":"D\ud800"},"unused":{"\ud800":"\udfff"},"mcpServers":{"demo":{"\ud800":"\udfff","\ufffd":"separate","n":18446744073709551615}},"apps":"./apps.json"}"#;
    std::fs::write(plugin.join(".codex-plugin/plugin.json"), manifest).unwrap();
    std::fs::write(plugin.join("apps.json"), "{}").unwrap();
    let (executor, ctx) =
        executor(&root, Arc::new(Policy(Arc::new(Mutex::new(vec![])))), None).await;
    let discovery = executor
        .discover_capability_roots(
            vec![CapabilityRootRequest {
                id: lone("root"),
                path: uri(&plugin),
                sandbox: None,
            }],
            &ctx,
        )
        .await
        .unwrap();
    let files = discovery[0].plugin.as_ref().unwrap();
    assert_eq!(files.manifest.contents, manifest);
    assert!(files.mcp_config.is_none());
    assert_eq!(files.apps_config.as_ref().unwrap().contents, "{}");
    let connection = executor.open_connection().unwrap();
    let params = parse_json(&format!(
        r#"{{"cwd":{}}}"#,
        stringify_json(&Value::String(uri(&root).into()))
    ))
    .unwrap();
    let Value::Object(result) = connection
        .discover_capabilities_v2(&params, &ctx)
        .await
        .unwrap()
    else {
        panic!()
    };
    let Some(Value::Array(plugins)) = object_get(&result, "plugins") else {
        panic!()
    };
    assert_eq!(plugins.len(), 1);
    let Value::Object(plugin) = &plugins[0] else {
        panic!()
    };
    assert_eq!(
        object_get(plugin, "displayName"),
        Some(&Value::String(lone("D")))
    );
    let Some(Value::Object(files)) = object_get(plugin, "files") else {
        panic!()
    };
    let Some(Value::Object(mcp)) = object_get(files, "mcpConfig") else {
        panic!()
    };
    let Some(Value::String(contents)) = object_get(mcp, "contents") else {
        panic!()
    };
    assert_eq!(
        contents.as_str(),
        Some(r#"{"demo":{"\ud800":"\udfff","�":"separate","n":18446744073709551615}}"#)
    );
    let parsed = parse_json(contents.as_str().unwrap()).unwrap();
    let Value::Object(servers) = parsed else {
        panic!()
    };
    let Some(Value::Object(server)) = object_get(&servers, "demo") else {
        panic!()
    };
    assert_eq!(
        server.get(&lone("")),
        Some(&Value::String(LosslessString::from_utf16(vec![0xdfff])))
    );
    assert_eq!(
        server.get(&"\u{fffd}".into()),
        Some(&Value::String("separate".into()))
    );
    std::fs::write(
        root.join(".codex/plugins/cache/market/demo/local/.codex-plugin/plugin.json"),
        r#"{"name":"first","name":"second","unused":"\ud800"}"#,
    )
    .unwrap();
    let Value::Object(result) = connection
        .discover_capabilities_v2(&params, &ctx)
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(object_get(&result, "plugins"), Some(&Value::Array(vec![])));
    assert!(
        matches!(object_get(&result, "warnings"), Some(Value::Array(warnings)) if !warnings.is_empty())
    );
    connection.close().await.unwrap();
    executor.close().await.unwrap();
}

#[tokio::test]
async fn http_stream_ids_have_independent_lifetimes_and_exact_error_text() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release, released) = tokio::sync::watch::channel(false);
    let server = tokio::spawn(async move {
        let mut connections = Vec::new();
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                assert_eq!(socket.read(&mut byte).await.unwrap(), 1);
                header.push(byte[0]);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            connections.push(socket);
        }
        let mut released = released;
        while !*released.borrow() {
            released.changed().await.unwrap();
        }
        connections[1].write_all(b"other").await.unwrap();
    });
    let handler = HttpHandler::new(allow(), None).unwrap();
    let events = Arc::new(Mutex::new(vec![]));
    let seen = events.clone();
    let emit: Emit = Arc::new(move |delta| {
        seen.lock().unwrap().push(delta);
        Box::pin(async { Ok(()) })
    });
    let ids = [lone("request"), "request\u{fffd}".into()];
    let mut streams = Vec::new();
    for id in &ids {
        let params = HttpRequestParams {
            url: format!("http://{address}/").into(),
            request_id: id.clone(),
            stream_response: true,
            ..request()
        };
        let outcome = handler
            .request(
                params.clone(),
                HttpRequestContext {
                    signal: Signal::default(),
                    emit: emit.clone(),
                },
            )
            .await
            .unwrap();
        streams.push(outcome.stream.unwrap());
        let duplicate = handler.request(params, http_ctx()).await.err().unwrap();
        assert_eq!(duplicate.code, -32602);
        assert_eq!(
            duplicate.message,
            joined(&[
                &"http/request streamResponse requestId `".into(),
                id,
                &"` is already active".into()
            ])
        );
    }
    streams[0].cancel().await;
    release.send(true).unwrap();
    streams[1].start().await;
    server.await.unwrap();
    {
        let events = events.lock().unwrap();
        assert!(events.iter().all(|event| event.request_id == ids[1]));
        assert_eq!(
            events
                .iter()
                .flat_map(|event| event.delta.clone())
                .collect::<Vec<_>>(),
            b"other"
        );
        assert!(events.last().unwrap().done);
    }
    handler.close().await.unwrap();
}

struct RoutedProvider {
    root: String,
    original: Arc<Policy>,
    replacement: Arc<Policy>,
}
impl ScopeProvider for RoutedProvider {
    fn scope_for(
        &self,
        attribution: Option<Attribution>,
        _: ScopeContext,
    ) -> BoxFuture<'_, Result<Arc<dyn ExecutorScope>, ExecutorError>> {
        let original = attribution
            .as_ref()
            .and_then(|value| value.thread_id.as_ref())
            .and_then(LosslessString::as_str)
            == Some("original");
        let scope: Arc<dyn ExecutorScope> = Arc::new(Scope {
            root: self.root.clone(),
            policy: if original {
                self.original.clone()
            } else {
                self.replacement.clone()
            },
        });
        Box::pin(async move { Ok(scope) })
    }
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_capture_selects_the_invoking_process_active_scope() {
    for with_alias in [false, true] {
        let root = workspace();
        let original = Arc::new(Mutex::new(vec![]));
        let replacement = Arc::new(Mutex::new(vec![]));
        let executor = Executor::new(ExecutorOptions {
            scope_provider: Arc::new(RoutedProvider {
                root: root.to_str().unwrap().into(),
                original: Arc::new(Policy(original.clone())),
                replacement: Arc::new(Policy(replacement.clone())),
            }),
            answer_process: None,
            base_env: BTreeMap::new(),
            session_id: None,
            process_timeout_ms: None,
            max_buffered_bytes_per_process: None,
            max_live_processes: None,
            network_proxy_ca_directory: None,
            network_proxy_upstream_trust: None,
            network_policy: None,
            environment: EnvironmentOverrides::default(),
            home_directory: root.clone(),
            data_directory: root.join("data"),
            codex_home_env: None,
            system_config_path: None,
            system_requirements_path: None,
            managed_config_path: None,
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let emitted = events.clone();
        let signal = Signal::default();
        let session = executor
            .initialize(
                InitializeParams {
                    client_name: "synthetic".into(),
                },
                InitializeContext {
                    signal: signal.clone(),
                    notify: Some(Arc::new(move |method, value| {
                        emitted.lock().unwrap().push((method, value));
                        Box::pin(async {})
                    })),
                    call: None,
                },
            )
            .await
            .unwrap();
        let ctx = HandlerContext {
            session_id: session.session_id,
            signal,
        };
        if with_alias {
            executor
                .start_process(
                    ExecParams {
                        process_id: "p\u{fffd}".into(),
                        argv: vec!["/bin/sh".into(), "-c".into(), "read hold".into()],
                        cwd: uri(&root).into(),
                        pipe_stdin: true,
                        metadata: Some(parse_json(r#"{"threadId":"replacement"}"#).unwrap()),
                        ..Default::default()
                    },
                    &ctx,
                )
                .await
                .unwrap();
        }
        let id = lone("p");
        let result = executor
            .start_process(
                ExecParams {
                    process_id: id.clone(),
                    argv: vec!["/bin/sh".into(), "-lc".into(), "printf original".into()],
                    cwd: uri(&root).into(),
                    metadata: Some(parse_json(r#"{"threadId":"original"}"#).unwrap()),
                    shell_snapshot: Some(ShellSnapshotRequest {
                        scope_id: lone("scope"),
                        shell: ShellInfo {
                            name: "sh".into(),
                            path: "/bin/sh".into(),
                        },
                    }),
                    ..Default::default()
                },
                &ctx,
            )
            .await
            .unwrap();
        assert_eq!(result.process_id, id);
        {
            let captured = original.lock().unwrap();
            let capture = captured
                .iter()
                .find(|input| {
                    input.metadata.as_ref().is_some_and(|metadata| {
                        object_get(metadata, "shellSnapshotScope").is_some()
                    })
                })
                .unwrap();
            assert_eq!(
                object_get(capture.metadata.as_ref().unwrap(), "processId"),
                Some(&Value::String(id.clone()))
            );
        }
        assert!(replacement.lock().unwrap().iter().all(|input| {
            input
                .metadata
                .as_ref()
                .is_none_or(|metadata| object_get(metadata, "shellSnapshotScope").is_none())
        }));
        let mut closed = false;
        let mut output = Vec::new();
        let mut after_seq = None;
        for _ in 0..20 {
            let read = executor
                .read_process(
                    ReadParams {
                        process_id: id.clone(),
                        after_seq,
                        max_bytes: None,
                        wait_ms: Some(250),
                    },
                    &ctx,
                )
                .await
                .unwrap();
            after_seq = read.chunks.last().map(|chunk| chunk.seq).or(after_seq);
            output.extend(read.chunks.into_iter().flat_map(|chunk| chunk.chunk));
            closed = read.closed;
            if closed {
                break;
            }
        }
        assert!(closed);
        assert_eq!(output, b"original");
        if with_alias {
            let read = executor
                .read_process(
                    ReadParams {
                        process_id: "p\u{fffd}".into(),
                        after_seq: None,
                        max_bytes: None,
                        wait_ms: None,
                    },
                    &ctx,
                )
                .await
                .unwrap();
            assert!(!read.exited);
        }
        executor.close().await.unwrap();
        tokio::task::yield_now().await;
        let events = events.lock().unwrap();
        assert!(events.iter().any(|(method, value)| method == "process/closed" && matches!(value, Value::Object(object) if object_get(object, "processId") == Some(&Value::String(id.clone())))));
    }
}

#[test]
fn deferred_refusal_diagnostics_retain_original_authorization_resources() {
    use ycoding_core::cca::error::{DecisionKind, PendingDecision, PendingState};
    let denied = AuthorizationDenied {
        trace: vec![],
        busy: false,
        pending: vec![PendingDecision {
            kind: DecisionKind::Permission,
            session_id: "synthetic".into(),
            item_id: Some("review".into()),
            action: "read".into(),
            resources: vec![lone("process")],
            hard_review: false,
            state: PendingState::Open,
            directories: vec![],
        }],
    };
    let refusal = denied.refusal_text().unwrap();
    let units = refusal.code_units().collect::<Vec<_>>();
    assert!(
        units
            .windows(lone("process").len())
            .any(|part| part == lone("process").code_units().collect::<Vec<_>>())
    );
    let error = ExecutorError::refusal(refusal.clone());
    assert_eq!(error.refusal, Some(refusal.clone()));
    assert_eq!(
        error.message,
        joined(&[&"Permission denied: ".into(), &refusal])
    );
}

#[derive(Default)]
struct RecordingInputs {
    processes: Mutex<Vec<ProcessRecord>>,
    http: Mutex<Vec<(LosslessString, LosslessString)>>,
    denied: Mutex<Vec<LosslessString>>,
}
struct RecordedProcess;
impl ProcessRecording for RecordedProcess {
    fn output(&self, _: &[u8]) {}
    fn ended(&self, _: Option<i64>, _: bool) {}
}
impl Recorder for RecordingInputs {
    fn process(&self, input: ProcessRecord) -> Arc<dyn ProcessRecording> {
        self.processes.lock().unwrap().push(input);
        Arc::new(RecordedProcess)
    }
    fn read(&self, _: &str, _: u64) {}
    fn write(&self, _: WriteRecord) {}
    fn http(&self, method: &LosslessString, url: &LosslessString, _: Option<u16>, _: u64) {
        self.http
            .lock()
            .unwrap()
            .push((method.clone(), url.clone()));
    }
    fn denied(
        &self,
        _: &str,
        subject: &LosslessString,
        _: &ycoding_core::cca::error::DecisionTrace,
    ) {
        self.denied.lock().unwrap().push(subject.clone());
    }
    fn flush(&self) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}
struct RecordingPolicy;
impl Authorize for RecordingPolicy {
    fn authorize(
        &self,
        input: AuthorizationInput,
    ) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>> {
        Box::pin(async move {
            if input.action == "read" {
                Err(AuthorizationDenied::default())
            } else {
                Ok(Grant::noop())
            }
        })
    }
}
struct RecordedScope {
    root: String,
    recorder: Arc<RecordingInputs>,
}
impl ExecutorScope for RecordedScope {
    fn session_id(&self) -> String {
        "synthetic".into()
    }
    fn roots(&self) -> Vec<String> {
        vec![self.root.clone()]
    }
    fn authorization(&self) -> Arc<dyn Authorize> {
        Arc::new(RecordingPolicy)
    }
    fn transcript(&self) -> Option<Arc<dyn Recorder>> {
        Some(self.recorder.clone())
    }
    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
}
struct RecordedProvider {
    root: String,
    recorder: Arc<RecordingInputs>,
}
impl ScopeProvider for RecordedProvider {
    fn scope_for(
        &self,
        _: Option<Attribution>,
        _: ScopeContext,
    ) -> BoxFuture<'_, Result<Arc<dyn ExecutorScope>, ExecutorError>> {
        let scope: Arc<dyn ExecutorScope> = Arc::new(RecordedScope {
            root: self.root.clone(),
            recorder: self.recorder.clone(),
        });
        Box::pin(async move { Ok(scope) })
    }
}

#[tokio::test]
async fn recorder_receives_original_process_attribution_http_and_denied_subjects() {
    let root = workspace();
    let records = Arc::new(RecordingInputs::default());
    let executor = Executor::new(ExecutorOptions {
        scope_provider: Arc::new(RecordedProvider {
            root: root.to_str().unwrap().into(),
            recorder: records.clone(),
        }),
        answer_process: Some(Arc::new(Answer(Arc::new(Mutex::new(vec![]))))),
        base_env: BTreeMap::new(),
        session_id: None,
        process_timeout_ms: None,
        max_buffered_bytes_per_process: None,
        max_live_processes: None,
        network_proxy_ca_directory: None,
        network_proxy_upstream_trust: None,
        network_policy: None,
        environment: EnvironmentOverrides::default(),
        home_directory: root.clone(),
        data_directory: root.join("data"),
        codex_home_env: None,
        system_config_path: None,
        system_requirements_path: None,
        managed_config_path: None,
    });
    let signal = Signal::default();
    let initialized = executor
        .initialize(
            InitializeParams {
                client_name: "synthetic".into(),
            },
            InitializeContext {
                signal: signal.clone(),
                notify: None,
                call: None,
            },
        )
        .await
        .unwrap();
    let ctx = HandlerContext {
        session_id: initialized.session_id,
        signal,
    };
    executor
        .start_process(
            ExecParams {
                process_id: lone("p"),
                argv: vec!["/bin/sh".into(), "-c".into(), lone("echo ")],
                cwd: uri(&root).into(),
                metadata: Some(
                    parse_json(r#"{"threadId":"thread\ud800","toolCallId":"call\udfff"}"#).unwrap(),
                ),
                ..Default::default()
            },
            &ctx,
        )
        .await
        .unwrap();
    {
        let inputs = records.processes.lock().unwrap();
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].process_id, lone("p"));
        assert_eq!(inputs[0].command, lone("echo "));
        assert_eq!(inputs[0].thread_id, Some(lone("thread")));
        assert_eq!(
            inputs[0].tool_call_id,
            Some(LosslessString::from_utf16(
                "call".encode_utf16().chain([0xdfff]).collect()
            ))
        );
    }
    assert_eq!(
        executor
            .read_process(
                ReadParams {
                    process_id: lone("missing"),
                    after_seq: None,
                    max_bytes: None,
                    wait_ms: None
                },
                &ctx
            )
            .await
            .unwrap_err()
            .code,
        -32001
    );
    assert_eq!(*records.denied.lock().unwrap(), vec![lone("missing")]);
    let connection = executor.open_connection().unwrap();
    let params = HttpRequestParams {
        method: lone("GET"),
        url: lone("http://example.invalid/"),
        ..request()
    };
    let emit: Emit = Arc::new(|_| Box::pin(async { Ok(()) }));
    assert_eq!(
        connection
            .http_request(params.clone(), &ctx, emit)
            .await
            .err()
            .unwrap()
            .code,
        -32602
    );
    assert_eq!(
        *records.http.lock().unwrap(),
        vec![(params.method, params.url)]
    );
    connection.close().await.unwrap();
    executor.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn sandbox_glob_does_not_alias_a_replacement_spelled_file() {
    let root = workspace();
    let path = root.join("item\u{fffd}");
    std::fs::write(&path, b"kept").unwrap();
    let (executor, ctx) =
        executor(&root, Arc::new(Policy(Arc::new(Mutex::new(vec![])))), None).await;
    for (suffix, permitted) in [(lone(""), true), ("\u{fffd}".into(), false)] {
        let pattern = joined(&[&root.to_str().unwrap().into(), &"/*".into(), &suffix]);
        let sandbox = parse_json(&r#"{"permissions":{"type":"managed","network":"enabled","file_system":{"type":"restricted","entries":[{"path":{"type":"path","path":ROOT},"access":"read"},{"path":{"type":"glob_pattern","pattern":PATTERN},"access":"deny"}]}}}"#.replace("ROOT", &stringify_json(&Value::String(uri(&root).into()))).replace("PATTERN", &stringify_json(&Value::String(pattern)))).unwrap();
        let result = executor
            .read_file(
                FsReadFileParams {
                    path: uri(&path),
                    follow_symlinks: None,
                    sandbox: Some(sandbox),
                },
                &ctx,
            )
            .await;
        if permitted {
            assert_eq!(result.unwrap(), b"kept");
        } else {
            assert_eq!(
                result.unwrap_err().message.as_str(),
                Some("Permission denied")
            );
        }
    }
    executor.close().await.unwrap();
}

#[test]
fn discovery_parameter_validation_preserves_opaque_sandbox_and_variant_errors() {
    let params = parse_json(r#"{"cwd":"file:///synthetic","sandbox":{"permissions":{"type":"disabled"},"cwd":"file:///synthetic","windowsSandboxLevel":"disabled","opaque":{"\ud800":"\udfff","\ufffd":"separate"}}}"#).unwrap();
    let Value::Object(object) = &params else {
        panic!()
    };
    assert_eq!(
        decode_discover_v2_params(&params).unwrap().as_ref(),
        object_get(object, "sandbox")
    );
    let params = parse_json(r#"{"cwd":"file:///synthetic","sandbox":{"permissions":{"type":"managed\ud800"},"cwd":"file:///synthetic","windowsSandboxLevel":"disabled"}}"#).unwrap();
    let error = decode_discover_v2_params(&params).unwrap_err();
    assert_eq!(error.code, -32602);
    assert_eq!(
        error.message,
        joined(&[
            &"unknown variant `".into(),
            &lone("managed"),
            &"`, expected one of `managed`, `disabled`, `external`".into()
        ])
    );
}

#[cfg(unix)]
fn proxy_launch(masking: bool) -> RemoteNetworkProxyLaunchConfig {
    RemoteNetworkProxyLaunchConfig {
        proxy: RemoteNetworkProxyConfig {
            enabled: true,
            credential_masking: masking,
            credential_providers: vec![],
            enable_socks5: false,
            enable_socks5_udp: false,
            allow_upstream_proxy: false,
            dangerously_allow_all_unix_sockets: false,
            mode: NetworkMode::Limited,
            domains: None,
            review_domains: vec![],
            unix_sockets: None,
            allow_local_binding: false,
        },
        audit_metadata: NetworkProxyAuditMetadata {
            conversation_id: Some(lone("conversation")),
            ..Default::default()
        },
        environment_id: Some(lone("environment")),
        execution_id: None,
        policy_decision_timeout_ms: None,
    }
}

#[tokio::test]
async fn initialize_accepts_original_client_name_without_new_validation() {
    let root = workspace();
    let (executor, _) = executor(&root, Arc::new(Policy(Arc::new(Mutex::new(vec![])))), None).await;
    let params = InitializeParams {
        client_name: lone("client"),
    };
    assert_eq!(params.client_name, lone("client"));
    let initialized = executor
        .initialize(
            params,
            InitializeContext {
                signal: Signal::default(),
                notify: None,
                call: None,
            },
        )
        .await
        .unwrap();
    assert!(!initialized.session_id.is_empty());
    executor.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn executor_masking_requires_explicit_upstream_trust_before_process_launch() {
    let root = workspace();
    let executor = Executor::new(ExecutorOptions {
        scope_provider: Arc::new(Provider {
            root: root.to_str().unwrap().into(),
            seen: Arc::new(Mutex::new(vec![])),
            policy: Arc::new(Policy(Arc::new(Mutex::new(vec![])))),
        }),
        answer_process: None,
        base_env: BTreeMap::new(),
        session_id: None,
        process_timeout_ms: None,
        max_buffered_bytes_per_process: None,
        max_live_processes: None,
        network_proxy_ca_directory: Some(root.join("ca")),
        network_proxy_upstream_trust: None,
        network_policy: None,
        environment: EnvironmentOverrides::default(),
        home_directory: root.clone(),
        data_directory: root.join("data"),
        codex_home_env: None,
        system_config_path: None,
        system_requirements_path: None,
        managed_config_path: None,
    });
    let signal = Signal::default();
    let initialized = executor
        .initialize(
            InitializeParams {
                client_name: "synthetic".into(),
            },
            InitializeContext {
                signal: signal.clone(),
                notify: None,
                call: None,
            },
        )
        .await
        .unwrap();
    let ctx = HandlerContext {
        session_id: initialized.session_id,
        signal,
    };
    let id = lone("masked");
    let error = executor
        .start_process(
            ExecParams {
                process_id: id.clone(),
                argv: vec!["/bin/bash".into(), "-c".into(), "true".into()],
                cwd: uri(&root).into(),
                network_proxy: Some(proxy_launch(true)),
                ..Default::default()
            },
            &ctx,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, -32603);
    assert_eq!(
        error.message.as_str(),
        Some(
            "credential masking requires an explicit broker cache, upstream roots and CA directory"
        )
    );
    assert_eq!(
        executor
            .read_process(
                ReadParams {
                    process_id: id,
                    after_seq: None,
                    max_bytes: None,
                    wait_ms: None
                },
                &ctx
            )
            .await
            .unwrap_err()
            .code,
        -32600
    );
    let id: LosslessString = "unmasked".into();
    executor
        .start_process(
            ExecParams {
                process_id: id.clone(),
                argv: vec!["/bin/bash".into(), "-c".into(), "true".into()],
                cwd: uri(&root).into(),
                network_proxy: Some(proxy_launch(false)),
                ..Default::default()
            },
            &ctx,
        )
        .await
        .unwrap();
    let mut closed = false;
    let mut after_seq = None;
    for _ in 0..20 {
        let read = executor
            .read_process(
                ReadParams {
                    process_id: id.clone(),
                    after_seq,
                    max_bytes: None,
                    wait_ms: Some(1000),
                },
                &ctx,
            )
            .await
            .unwrap();
        after_seq = read.chunks.last().map(|chunk| chunk.seq).or(after_seq);
        closed = read.closed;
        if closed {
            assert_eq!(read.exit_code, Some(0));
            break;
        }
    }
    assert!(closed);
    executor.close().await.unwrap();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn executor_reuses_broker_across_processes_and_protected_snapshot_replay() {
    use ycoding_core::cca::{
        mitm_ca::MitmAuthority, network_proxy::NetworkProxyUpstreamTrust,
        shell_snapshot::SNAPSHOT_MASKING_FALLBACK_WARNING,
    };
    let root = workspace();
    let upstream = MitmAuthority::issue().unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(
            upstream.certificate_der().to_vec(),
        ))
        .unwrap();
    let inputs = Arc::new(Mutex::new(vec![]));
    let executor = Executor::new(ExecutorOptions {
        scope_provider: Arc::new(Provider {
            root: root.to_str().unwrap().into(),
            seen: Arc::new(Mutex::new(vec![])),
            policy: Arc::new(Policy(inputs.clone())),
        }),
        answer_process: None,
        base_env: BTreeMap::from([("HOME".into(), root.to_str().unwrap().into())]),
        session_id: None,
        process_timeout_ms: None,
        max_buffered_bytes_per_process: None,
        max_live_processes: None,
        network_proxy_ca_directory: Some(root.join("ca")),
        network_proxy_upstream_trust: Some(NetworkProxyUpstreamTrust {
            authority: Arc::new(MitmAuthority::issue().unwrap()),
            roots,
            certificates_pem: vec![upstream.certificate_pem().into()],
            startup_values: vec![],
        }),
        network_policy: None,
        environment: EnvironmentOverrides::default(),
        home_directory: root.clone(),
        data_directory: root.join("data"),
        codex_home_env: None,
        system_config_path: None,
        system_requirements_path: None,
        managed_config_path: None,
    });
    let signal = Signal::default();
    let initialized = executor
        .initialize(
            InitializeParams {
                client_name: lone("client"),
            },
            InitializeContext {
                signal: signal.clone(),
                notify: None,
                call: None,
            },
        )
        .await
        .unwrap();
    let ctx = HandlerContext {
        session_id: initialized.session_id,
        signal,
    };
    let secret: LosslessString = "sk-syntheticOnlyForExecutorFixture1234567890".into();
    let mut placeholders = vec![];
    for (index, shell) in ["bash", "bash", "zsh", "zsh"].into_iter().enumerate() {
        let id: LosslessString = format!("masked-{index}").into();
        let path = format!("/bin/{shell}");
        let snapshot = (shell == "zsh").then(|| ShellSnapshotRequest {
            scope_id: lone("protected"),
            shell: ShellInfo {
                name: shell.into(),
                path: path.clone().into(),
            },
        });
        executor
            .start_process(
                ExecParams {
                    process_id: id.clone(),
                    argv: vec![
                        path.into(),
                        if shell == "zsh" {
                            "-lc".into()
                        } else {
                            "-c".into()
                        },
                        "printf '%s' \"$OPENAI_API_KEY\"".into(),
                    ],
                    cwd: uri(&root).into(),
                    env: vec![
                        ("OPENAI_API_KEY".into(), secret.clone()),
                        ("SYNTHETIC_UNITS".into(), lone("kept")),
                    ],
                    shell_snapshot: snapshot,
                    network_proxy: Some(proxy_launch(true)),
                    ..Default::default()
                },
                &ctx,
            )
            .await
            .unwrap();
        let mut after_seq = None;
        let mut output = Vec::new();
        let mut closed = false;
        for _ in 0..20 {
            let read = executor
                .read_process(
                    ReadParams {
                        process_id: id.clone(),
                        after_seq,
                        max_bytes: None,
                        wait_ms: Some(1000),
                    },
                    &ctx,
                )
                .await
                .unwrap();
            for chunk in read.chunks {
                after_seq = Some(chunk.seq);
                output.extend(chunk.chunk);
            }
            closed = read.closed;
            if closed {
                assert_eq!(read.exit_code, Some(0));
                break;
            }
        }
        assert!(closed);
        assert!(!output.is_empty());
        let secret = secret.as_str().unwrap().as_bytes();
        assert!(!output.windows(secret.len()).any(|window| window == secret));
        assert!(!String::from_utf8_lossy(&output).contains(SNAPSHOT_MASKING_FALLBACK_WARNING));
        placeholders.push(output);
    }
    assert!(placeholders.windows(2).all(|pair| pair[0] == pair[1]));
    assert_eq!(
        inputs
            .lock()
            .unwrap()
            .iter()
            .filter(
                |input| input.metadata.as_ref().is_some_and(|metadata| object_get(
                    metadata,
                    "shellSnapshotScope"
                )
                .is_some())
            )
            .count(),
        2
    );
    executor.close().await.unwrap();
}
