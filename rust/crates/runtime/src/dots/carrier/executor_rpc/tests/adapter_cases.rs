use super::support::*;
use crate::dots::carrier::executor_rpc::{
    control::Abort,
    core_adapter::{
        backend_features, core_close, core_environment_config, core_exec, core_http_request,
        core_initialize, core_open, core_read_block, core_root_requests, core_write_block,
        environment_info, failure, from_core_signal, lenient_base64, read_result, to_core_signal,
        url_text,
    },
    error::{CallError, HandlerError, RpcError},
    handler::CallOptions,
    policy_bridge::{RuntimeNetworkPolicy, audit_event, caller},
    types::*,
    wire_base, wire_env, wire_fs, wire_http,
    wire_process::encode_network_policy_decision,
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_core::cca::{
    error::{BoxFuture, ExecutorError},
    executor::{self as cx, NetworkPolicyFactory},
    fs_extended as core_fs, http as core_http, network_proxy as core_proxy,
    shell_snapshot::ShellInfo as CoreShellInfo,
    signal::Signal as CoreSignal,
    value::{JsonObject, LosslessString, Value, parse_json, stringify_json},
};

fn object(text: &str) -> JsonObject {
    match parse_json(text).expect("valid JSON") {
        Value::Object(object) => object,
        other => panic!("not an object: {}", stringify_json(&other)),
    }
}

#[test]
fn lenient_base64_matches_node_buffer_decoding() {
    assert_eq!(lenient_base64("aGk="), b"hi");
    assert_eq!(lenient_base64("aGk"), b"hi");
    assert_eq!(lenient_base64("aGl="), b"hi");
    assert_eq!(lenient_base64(""), Vec::<u8>::new());
    assert_eq!(lenient_base64("aG\nk="), b"hi");
}

#[test]
fn exec_parameters_reach_core_unchanged_and_in_order() {
    let exec = wire_base::decode_process_start(Some(&parse(
        r#"{"processId":"p\ud800","argv":["a\udc00"],"cwd":"file:///w","env":{"b":"1","a":"2\ud800","1":"x"},"arg0":"z","metadata":{"threadId":"0123456789abcdef0123456789abcdef","toolCallId":"t\udc00"},"envPolicy":{"inherit":"all","ignoreDefaultExcludes":true,"exclude":[],"includeOnly":[],"set":{},"future":[1]},"sandbox":{"k\ud800":1},"managedNetwork":{"m":null},"enforceManagedNetwork":true,"tty":true}"#,
    )))
    .unwrap();
    let core = core_exec(exec);
    assert_eq!(core.process_id, units("p", &[0xd800], ""));
    assert_eq!(core.argv, [units("a", &[0xdc00], "")]);
    assert_eq!(
        core.env,
        [
            (Text::from("1"), Text::from("x")),
            (Text::from("b"), Text::from("1")),
            (Text::from("a"), units("2", &[0xd800], "")),
        ]
    );
    assert_eq!(core.arg0, Some(Text::from("z")));
    assert!(core.tty && !core.pipe_stdin);
    assert_eq!(core.enforce_managed_network, Some(true));
    assert_eq!(
        stringify_json(core.metadata.as_ref().unwrap()),
        r#"{"threadId":"0123456789abcdef0123456789abcdef","toolCallId":"t\udc00"}"#
    );
    assert_eq!(
        core.env_policy,
        Some(Value::Object(object(
            r#"{"inherit":"all","ignoreDefaultExcludes":true,"exclude":[],"includeOnly":[],"set":{},"future":[1]}"#
        )))
    );
    assert_eq!(
        core.sandbox,
        Some(Value::Object(object(r#"{"k\ud800":1}"#)))
    );
    assert_eq!(
        core.managed_network,
        Some(Value::Object(object(r#"{"m":null}"#)))
    );
}

const PROXY_EXEC: &str = r#"{"processId":"p","argv":["a"],"cwd":"file:///w","env":{},"shellSnapshot":{"scopeId":"s\ud800","shell":{"name":"zsh\udc00","path":"/bin/zsh"}},"networkProxy":{"proxy":{"enabled":true,"credentialMasking":true,"credentialProviders":{"z":{"env":["T\ud800"],"auth":["bearer","header"],"header":"X\udc00"},"p\ud800":{"patterns":["q\udc00"],"url_prefixes":["u"],"url_prefix_from_env":"E\ud800","prefix":"P\udc00"}},"enableSocks5":true,"enableSocks5Udp":false,"allowUpstreamProxy":true,"dangerouslyAllowAllUnixSockets":false,"mode":"full","domains":{"b\udc00.test":"deny","a.test":"allow"},"reviewDomains":["r\ud800"],"unixSockets":{"/s\ud800":"allow"},"allowLocalBinding":true},"auditMetadata":{"model":"m\ud800","conversationId":"c\udc00","slug":"s"},"environmentId":"e\ud800","executionId":"x\udc00","policyDecisionTimeoutMs":1500}}"#;

#[test]
fn network_proxy_and_shell_snapshot_reach_core_with_every_unit_and_key_order_intact() {
    let exec = wire_base::decode_process_start(Some(&parse(PROXY_EXEC))).unwrap();
    let core = core_exec(exec);
    let snapshot = core.shell_snapshot.unwrap();
    assert_eq!(snapshot.scope_id, units("s", &[0xd800], ""));
    assert_eq!(snapshot.shell.name, units("zsh", &[0xdc00], ""));
    assert_eq!(snapshot.shell.path, Text::from("/bin/zsh"));
    let launch = core.network_proxy.unwrap();
    let proxy = &launch.proxy;
    assert!(
        proxy.enabled
            && proxy.credential_masking
            && proxy.enable_socks5
            && proxy.allow_upstream_proxy
            && proxy.allow_local_binding
    );
    assert_eq!(proxy.mode, core_proxy::NetworkMode::Full);
    let keys: Vec<LosslessString> = proxy
        .credential_providers
        .iter()
        .map(|(key, _)| key.clone())
        .collect();
    assert_eq!(keys, [Text::from("z"), units("p", &[0xd800], "")]);
    let z = &proxy.credential_providers[0].1;
    assert_eq!(z.env, [units("T", &[0xd800], "")]);
    assert_eq!(z.header, Some(units("X", &[0xdc00], "")));
    assert_eq!(
        z.auth,
        [
            core_proxy::CredentialAuthMethod::Bearer,
            core_proxy::CredentialAuthMethod::Header
        ]
    );
    let p = &proxy.credential_providers[1].1;
    assert_eq!(p.patterns, [units("q", &[0xdc00], "")]);
    assert_eq!(p.url_prefix_from_env, Some(units("E", &[0xd800], "")));
    assert_eq!(p.prefix, Some(units("P", &[0xdc00], "")));
    assert_eq!(
        proxy.domains,
        Some(vec![
            (
                units("b", &[0xdc00], ".test"),
                core_proxy::DomainPermission::Deny
            ),
            (Text::from("a.test"), core_proxy::DomainPermission::Allow),
        ])
    );
    assert_eq!(proxy.review_domains, [units("r", &[0xd800], "")]);
    assert_eq!(
        proxy.unix_sockets,
        Some(vec![(
            units("/s", &[0xd800], ""),
            core_proxy::UnixSocketPermission::Allow
        )])
    );
    assert_eq!(launch.audit_metadata.model, Some(units("m", &[0xd800], "")));
    assert_eq!(
        launch.audit_metadata.conversation_id,
        Some(units("c", &[0xdc00], ""))
    );
    assert_eq!(launch.audit_metadata.slug, Some(Text::from("s")));
    assert_eq!(launch.environment_id, Some(units("e", &[0xd800], "")));
    assert_eq!(launch.execution_id, Some(units("x", &[0xdc00], "")));
    assert_eq!(launch.policy_decision_timeout_ms, Some(1500));
}

#[test]
fn process_reads_map_streams_nulls_and_base64() {
    let result = read_result(cx::ReadResult {
        chunks: vec![cx::ProcessOutputChunk {
            seq: 3,
            stream: cx::OutputStream::Pty,
            chunk: b"hi".to_vec(),
        }],
        next_seq: 4,
        exited: false,
        exit_code: None,
        closed: false,
        failure: None,
        sandbox_denied: false,
    });
    assert_eq!(
        result,
        ReadResult {
            chunks: vec![ProcessOutputChunk {
                seq: 3,
                stream: ProcessStream::Pty,
                chunk: "aGk=".into()
            }],
            next_seq: 4,
            exited: false,
            exit_code: Presence::Null,
            closed: false,
            failure: Presence::Null,
            sandbox_denied: Some(false),
        }
    );
    let exited = read_result(cx::ReadResult {
        chunks: vec![],
        next_seq: 9,
        exited: true,
        exit_code: Some(-1),
        closed: true,
        failure: Some("boom".into()),
        sandbox_denied: true,
    });
    assert_eq!(
        (exited.exit_code, exited.failure, exited.sandbox_denied),
        (
            Presence::Value(-1),
            Presence::Value("boom".into()),
            Some(true)
        )
    );
}

#[test]
fn environment_info_converts_presence_and_capabilities() {
    let info = environment_info(cx::EnvironmentInfo {
        shell: CoreShellInfo {
            name: "zsh".into(),
            path: "/bin/zsh".into(),
        },
        executor_version: Some("1".into()),
        provider_id: None,
        cwd: Some("file:///home".into()),
        user_home_dir: None,
        platform_os: Some("linux".into()),
        prepend_path_dirs: vec![],
        temporary_directories: vec!["file:///tmp".into()],
        temp_dir: None,
        capabilities: cx::EnvironmentCapabilities {
            network_proxy_launch: Some(true),
            windows_mxc: Some(false),
            ..cx::EnvironmentCapabilities::default()
        },
    });
    assert_eq!(info.cwd, Presence::Value("file:///home".into()));
    assert_eq!(info.user_home_dir, Presence::Absent);
    assert_eq!(info.prepend_path_dirs, None);
    assert_eq!(
        info.temporary_directories,
        Some(vec!["file:///tmp".to_string()])
    );
    assert_eq!(info.capabilities.network_proxy_launch, Some(true));
    assert_eq!(info.capabilities.windows_mxc, Some(false));
    assert_eq!(info.capabilities.credential_masking, None);
}

#[test]
fn core_errors_keep_their_wire_code_and_message() {
    assert_eq!(
        failure(ExecutorError::permission_denied()),
        HandlerError::Executor {
            code: -32001,
            message: "Permission denied".into()
        }
    );
    assert_eq!(
        failure(ExecutorError::refusal("needs review".into())),
        HandlerError::Executor {
            code: -32600,
            message: "Permission denied: needs review".into()
        }
    );
    let message = units("bad ", &[0xd800], " input");
    assert_eq!(
        failure(ExecutorError::new(-32602, message.clone())),
        HandlerError::Executor {
            code: -32602,
            message: message.clone()
        }
    );
    assert_eq!(
        failure(ExecutorError::new(-32602, message.clone())).wire(),
        (-32602, message)
    );
    let refusal = ExecutorError::refusal(units("needs ", &[0xdc00], ""));
    assert_eq!(
        failure(refusal).wire(),
        (-32600, units("Permission denied: needs ", &[0xdc00], ""))
    );
}

#[test]
fn unfinished_core_slices_keep_the_capability_gate_closed() {
    let features = backend_features();
    assert!(
        features.credential_masking
            && features.credential_masking_custom_providers
            && features.environment_config_read
    );
    assert_eq!(
        wire_base::unbacked_capability(&canonical_info().capabilities, &features),
        None
    );
    assert_eq!(
        wire_base::unbacked_capability(
            &canonical_info().capabilities,
            &BackendFeatures {
                credential_masking: false,
                ..features
            }
        ),
        Some("credentialMasking")
    );
}

#[tokio::test]
async fn cancellation_forwarders_end_with_their_owner() {
    let abort = Abort::new();
    let (core, bridge) = to_core_signal(&abort.signal());
    assert!(!core.is_cancelled());
    abort.abort();
    tokio::time::timeout(Duration::from_secs(5), core.cancelled())
        .await
        .expect("cancelled in time");
    drop(bridge);

    let released = Abort::new();
    let (core, bridge) = to_core_signal(&released.signal());
    drop(bridge);
    released.abort();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!core.is_cancelled());

    let source = ycoding_core::cca::signal::Signal::default();
    let (mine, bridge) = from_core_signal(&source);
    source.cancel();
    tokio::time::timeout(Duration::from_secs(5), mine.aborted())
        .await
        .expect("aborted in time");
    drop(bridge);

    let aborted = Abort::new();
    aborted.abort();
    let (core, _) = to_core_signal(&aborted.signal());
    assert!(core.is_cancelled());
}

#[test]
fn handle_ids_reach_core_as_the_original_units() {
    let id = units("h", &[0xd800], "");
    let open = core_open(OpenParams {
        handle_id: id.clone(),
        path: "file:///a".into(),
        mode: OpenMode::Replace,
        sandbox: None,
    });
    assert_eq!(
        (open.handle_id, open.mode),
        (id.clone(), core_fs::OpenMode::Replace)
    );
    let read = core_read_block(ReadBlockParams {
        handle_id: id.clone(),
        offset: 7,
        len: u64::MAX,
    });
    assert_eq!(
        (read.handle_id, read.offset, read.len),
        (id.clone(), 7, usize::MAX)
    );
    let write = core_write_block(WriteBlockParams {
        handle_id: id.clone(),
        offset: 1,
        chunk: b"x".to_vec(),
    });
    assert_eq!((write.handle_id, write.chunk), (id.clone(), b"x".to_vec()));
    assert_eq!(
        core_close(CloseParams {
            handle_id: id.clone()
        })
        .handle_id,
        id
    );
}

#[test]
fn http_requests_reach_core_with_names_values_and_ids_unchanged() {
    let params = wire_http::decode_request(&parse(
        r#"{"method":"G\ud800","url":"https://e.test/\udc00","requestId":"r\ud800","headers":[{"name":"X-\udc00","value":"v\ud800","valueEnvVar":"E\udc00"}],"bodyBase64":"aGk=","timeoutMs":9,"redirectPolicy":"stop","streamResponse":true}"#,
    ))
    .unwrap();
    let core = core_http_request(params);
    assert_eq!(core.method, units("G", &[0xd800], ""));
    assert_eq!(core.url, units("https://e.test/", &[0xdc00], ""));
    assert_eq!(core.request_id, units("r", &[0xd800], ""));
    assert_eq!(
        core.headers,
        [core_http::HttpHeader {
            name: units("X-", &[0xdc00], ""),
            value: units("v", &[0xd800], ""),
            value_env_var: Some(units("E", &[0xdc00], "")),
        }]
    );
    assert_eq!(core.body, Some(b"hi".to_vec()));
    assert_eq!(
        (core.timeout_ms, core.redirect_policy, core.stream_response),
        (Some(9), core_http::RedirectPolicy::Stop, true)
    );
}

#[test]
fn discovery_ids_and_selectors_reach_core_without_conversion() {
    let roots = core_root_requests(
        wire_env::decode_capability_roots_discover(Some(&parse(
            r#"{"roots":[{"id":"i\ud800","path":"file:///r","sandbox":null}]}"#,
        )))
        .unwrap(),
    );
    assert_eq!(roots[0].id, units("i", &[0xd800], ""));
    assert_eq!(roots[0].path, "file:///r");
    let config = core_environment_config(
        wire_env::decode_environment_config_read(Some(&parse(
            r#"{"cwd":"file:///w","configPaths":[["a\ud800","b"],["\udc00"]],"requirementsPaths":[["c\udc00"]]}"#,
        )))
        .unwrap(),
    );
    assert_eq!(config.cwd, "file:///w");
    assert_eq!(
        config.config_paths,
        vec![
            vec![units("a", &[0xd800], ""), Text::from("b")],
            vec![units("", &[0xdc00], "")]
        ]
    );
    assert_eq!(
        config.requirements_paths,
        vec![vec![units("c", &[0xdc00], "")]]
    );
}

#[test]
fn the_url_boundary_is_the_only_place_text_becomes_scalar_values() {
    assert_eq!(
        url_text(&units("file:///a", &[0xd800], "")),
        "file:///a\u{fffd}"
    );
    assert_eq!(url_text(&Text::from("file:///日本")), "file:///日本");
    let opened = core_open(OpenParams {
        handle_id: Text::from("h"),
        path: url_text(&units("file:///p", &[0xdc00], "")),
        mode: OpenMode::Read,
        sandbox: None,
    });
    assert_eq!(opened.path, "file:///p\u{fffd}");
}

#[test]
fn walk_error_text_and_discovery_documents_are_lossless_on_the_wire() {
    let encoded = wire_fs::encode_walk_result(&WalkResult {
        entries: Vec::new(),
        errors: vec![WalkError {
            path: "file:///b".into(),
            message: units("denied ", &[0xd800], ""),
        }],
        truncated: false,
    });
    assert_eq!(
        stringify_json(&encoded),
        r#"{"entries":[],"errors":[{"path":"file:///b","message":"denied \ud800"}],"truncated":false}"#
    );
}

fn recording_call(calls: Arc<Mutex<Vec<(String, Value)>>>, reply: &'static str) -> cx::SessionCall {
    Arc::new(move |method, params, _options| {
        calls.lock().unwrap().push((method, params));
        let future: BoxFuture<'static, Result<Value, ExecutorError>> =
            Box::pin(async move { Ok(parse_json(reply).unwrap()) });
        future
    })
}

#[tokio::test]
async fn network_policy_questions_and_decisions_keep_process_ids_and_reasons_lossless() {
    let exec = wire_base::decode_process_start(Some(&parse(PROXY_EXEC))).unwrap();
    let launch = core_exec(exec).network_proxy.unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let notes: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = notes.clone();
    let hooks = RuntimeNetworkPolicy.hooks(cx::NetworkPolicyInput {
        process_id: units("p", &[0xd800], ""),
        launch,
        call: recording_call(
            calls.clone(),
            r#"{"decision":{"type":"deny","reason":"no \ud800"}}"#,
        ),
        notify: Arc::new(move |method, params| sink.lock().unwrap().push((method, params))),
        signal: CoreSignal::default(),
    });
    let decide = hooks
        .decider
        .expect("a callback timeout installs the decider");
    let decision = decide(core_proxy::NetworkPolicyRequest {
        protocol: core_proxy::NetworkProtocol::HttpsConnect,
        host: "a.test".into(),
        port: 443,
    })
    .await;
    assert_eq!(
        decision,
        Ok(core_proxy::NetworkDecision::Deny(units(
            "no ",
            &[0xd800],
            ""
        )))
    );
    let calls = calls.lock().unwrap();
    assert_eq!(calls[0].0, "network/policyRequest");
    assert_eq!(
        stringify_json(&calls[0].1),
        r#"{"processId":"p\ud800","request":{"protocol":"https_connect","host":"a.test","port":443}}"#
    );
    let listener = hooks
        .on_policy_decision
        .expect("decisions are always audited");
    listener(core_proxy::NetworkPolicyAuditEvent {
        timestamp: Text::from("t"),
        decision: "deny",
        source: core_proxy::DecisionSource::Decider,
        reason: units("r", &[0xdc00], ""),
        protocol: core_proxy::NetworkProtocol::Http,
        host: units("h", &[0xd800], ""),
        port: 80,
        method: Some(units("M", &[0xd800], "")),
        client: Some(units("c", &[0xdc00], "")),
        policy_override: true,
    });
    let notes = notes.lock().unwrap();
    assert_eq!(notes[0].0, "network/policyDecision");
    assert_eq!(
        stringify_json(&notes[0].1),
        r#"{"processId":"p\ud800","timestamp":"t","scope":"domain","decision":"deny","source":"decider","reason":"r\udc00","protocol":"http","host":"h\ud800","port":80,"method":"M\ud800","client":"c\udc00","policyOverride":true}"#
    );
}

#[test]
fn audit_events_convert_without_touching_text() {
    let event = audit_event(core_proxy::NetworkPolicyAuditEvent {
        timestamp: Text::from("t"),
        decision: "ask",
        source: core_proxy::DecisionSource::ModeGuard,
        reason: units("", &[0xd800], ""),
        protocol: core_proxy::NetworkProtocol::Socks5Udp,
        host: Text::from("h"),
        port: 1,
        method: None,
        client: None,
        policy_override: false,
    });
    assert_eq!(event.reason, units("", &[0xd800], ""));
    let encoded = encode_network_policy_decision(&Text::from("p"), &event);
    assert_eq!(
        stringify_json(&encoded),
        r#"{"processId":"p","timestamp":"t","scope":"domain","decision":"ask","source":"mode_guard","reason":"\ud800","protocol":"socks5_udp","host":"h","port":1,"policyOverride":false}"#
    );
}

#[tokio::test]
async fn controller_failures_keep_their_text_between_core_calls_and_the_runtime_caller() {
    let message = units("denied ", &[0xd800], "");
    let failing = message.clone();
    let call: cx::SessionCall = Arc::new(move |_, _, _| {
        let failing = failing.clone();
        let future: BoxFuture<'static, Result<Value, ExecutorError>> =
            Box::pin(async move { Err(ExecutorError::new(-32001, failing)) });
        future
    });
    assert_eq!(
        caller(call)
            .call("m", Value::Null, CallOptions::default())
            .await,
        Err(CallError::Remote(RpcError::new(-32001, message)))
    );
}

#[test]
fn the_client_name_reaches_core_as_the_original_units() {
    let name = units("client-", &[0xdc00], "");
    assert_eq!(
        core_initialize(InitializeParams {
            client_name: name.clone()
        })
        .client_name,
        name
    );
    assert_eq!(
        core_initialize(InitializeParams {
            client_name: Text::from("codex")
        })
        .client_name,
        Text::from("codex")
    );
}
