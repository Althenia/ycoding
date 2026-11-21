use super::support::*;
use crate::dots::carrier::executor_rpc::{
    control::{Abort, Signal, locked},
    error::{CallError, RpcError},
    handler::{Boxed, CallOptions, Caller},
    types::*,
    wire_base, wire_env, wire_fs, wire_http,
    wire_process::{
        self, NetworkDecision, NetworkPolicyDecider, NetworkPolicyRequest, NetworkProtocol,
    },
};
use std::sync::{Arc, Mutex};
use ycoding_core::ycoding_schema::{JsonValue, stringify_json};

fn failure<T: std::fmt::Debug>(result: Result<T, RpcError>) -> RpcError {
    result.expect_err("decoding must fail")
}

fn invalid(message: &str) -> RpcError {
    RpcError::new(-32602, message)
}

const START: &str =
    r#"{"processId":"p1","argv":["ls","-l"],"cwd":"file:///w","env":{"A":"1","B":"2"}}"#;

fn start_with(extra: &str) -> JsonValue {
    parse(&format!(
        r#"{{"processId":"p1","argv":["ls"],"cwd":"file:///w","env":{{}},{extra}}}"#
    ))
}

const PROXY: &str = r#""networkProxy":{"proxy":{"enabled":true,"credentialMasking":true,"credentialProviders":{"p":{"env":["T"],"auth":["bearer"]}},"enableSocks5":false,"enableSocks5Udp":false,"allowUpstreamProxy":false,"dangerouslyAllowAllUnixSockets":false,"mode":"limited","domains":{"a.test":"allow"},"reviewDomains":["b.test"],"allowLocalBinding":false},"auditMetadata":{"conversationId":"c"},"environmentId":"e","policyDecisionTimeoutMs":1500}"#;

#[test]
fn fs_open_defaults_the_mode_to_read_and_keeps_the_normalised_path() {
    let params = wire_fs::decode_open(&parse(r#"{"handleId":"h","path":"file:///a"}"#)).unwrap();
    assert_eq!(params.mode, OpenMode::Read);
    assert_eq!(params.path, "file:///a");
    assert_eq!(params.sandbox, None);
}

#[test]
fn fs_open_rejects_an_unknown_mode_with_the_serde_message() {
    let error = failure(wire_fs::decode_open(&parse(
        r#"{"handleId":"h","path":"file:///a","mode":"append"}"#,
    )));
    assert_eq!(
        error,
        invalid("unknown variant `append`, expected `read` or `replace`")
    );
}

#[test]
fn fs_required_fields_are_reported_in_declaration_order() {
    assert_eq!(
        failure(wire_fs::decode_read_block(&parse("{}"))),
        invalid("missing field `handleId`")
    );
    assert_eq!(
        failure(wire_fs::decode_read_block(&parse(r#"{"handleId":"h"}"#))),
        invalid("missing field `offset`")
    );
    assert_eq!(
        failure(wire_fs::decode_walk(&parse(
            r#"{"path":"file:///a","options":{"maxDepth":1,"maxDirectories":1,"maxEntries":1}}"#
        ))),
        invalid("missing field `followDirectorySymlinks`")
    );
}

#[test]
fn fs_numbers_follow_the_u64_rules() {
    assert_eq!(
        failure(wire_fs::decode_read_block(&parse(
            r#"{"handleId":"h","offset":-1,"len":1}"#
        ))),
        invalid("invalid value: integer `-1`, expected u64")
    );
    assert_eq!(
        failure(wire_fs::decode_read_block(&parse(
            r#"{"handleId":"h","offset":0,"len":1.5}"#
        ))),
        invalid("invalid type: floating point `1.5`, expected usize")
    );
    let ok = wire_fs::decode_read_block(&parse(r#"{"handleId":"h","offset":7,"len":9}"#)).unwrap();
    assert_eq!((ok.offset, ok.len), (7, 9));
}

#[test]
fn fs_type_errors_describe_the_offending_value() {
    assert_eq!(
        failure(wire_fs::decode_close(&parse(r#"{"handleId":5}"#))),
        invalid("invalid type: integer `5`, expected a string")
    );
    assert_eq!(
        failure(wire_fs::decode_close(&JsonValue::Null)),
        invalid("invalid type: null, expected struct FsCloseParams")
    );
    assert_eq!(
        failure(wire_fs::decode_close(&parse("[]"))),
        invalid("invalid type: sequence, expected struct FsCloseParams")
    );
    assert_eq!(
        failure(wire_fs::decode_create_directory(&parse(
            r#"{"path":"file:///a","sandbox":[]}"#
        ))),
        invalid("invalid type: sequence, expected struct WireFileSystemSandboxContext")
    );
}

#[test]
fn fs_nullable_members_and_unknown_members_are_ignored() {
    let params = wire_fs::decode_remove(&parse(
        r#"{"path":"file:///a","recursive":null,"force":true,"extra":[1],"sandbox":null}"#,
    ))
    .unwrap();
    assert_eq!(params.recursive, None);
    assert_eq!(params.force, Some(true));
    assert_eq!(params.sandbox, None);
}

#[test]
fn fs_paths_must_be_file_uris_without_query_or_fragment() {
    let path =
        |value: &str| wire_fs::decode_create_directory(&parse(&format!(r#"{{"path":"{value}"}}"#)));
    assert_eq!(
        failure(path("a/b")),
        invalid("invalid URI: relative URL without a base")
    );
    assert_eq!(
        failure(path("http://x/")),
        invalid("unsupported path URI scheme `http`")
    );
    assert_eq!(
        failure(path("file:///a?x=1")),
        invalid("query parameters are not allowed in path URIs")
    );
    assert_eq!(
        failure(path("file:///a#f")),
        invalid("fragments are not allowed in path URIs")
    );
    assert_eq!(path("file:///c:/Users").unwrap().path, "file:///C:/Users");
}

#[test]
fn fs_paths_reject_nul_bytes_except_the_documented_fixture_shape() {
    let error = failure(wire_fs::decode_create_directory(&parse(
        r#"{"path":"file:///a%00b"}"#,
    )));
    let message = error.message.to_utf8().unwrap();
    assert!(
        message.starts_with("'file:///a%00b' is invalid on '"),
        "{message}"
    );
    let allowed =
        wire_fs::decode_create_directory(&parse(r#"{"path":"file:///%00/bad/path/abc_1"}"#))
            .unwrap();
    assert_eq!(allowed.path, "file:///%00/bad/path/abc_1");
}

#[test]
fn fs_chunks_use_strict_standard_base64() {
    let chunk = |value: &str| {
        wire_fs::decode_write_block(&parse(&format!(
            r#"{{"handleId":"h","offset":0,"chunk":"{value}"}}"#
        )))
    };
    assert_eq!(chunk("aGk=").unwrap().chunk, b"hi");
    assert_eq!(chunk("").unwrap().chunk, Vec::<u8>::new());
    assert_eq!(failure(chunk("aGk")), invalid("Invalid padding"));
    assert_eq!(
        failure(chunk("a$k=")),
        invalid("Invalid symbol 36, offset 1.")
    );
    assert_eq!(
        failure(chunk("aGl=")),
        invalid("Invalid last symbol 108, offset 2.")
    );
    assert_eq!(
        failure(chunk("====")),
        invalid("Invalid symbol 61, offset 0.")
    );
    assert_eq!(failure(chunk("a")), invalid("Invalid input length: 1"));
}

#[test]
fn fs_walk_options_decode_with_optional_pruning() {
    let params = wire_fs::decode_walk(&parse(
        r#"{"path":"file:///a","options":{"maxDepth":2,"maxDirectories":3,"maxEntries":4,"followDirectorySymlinks":false,"pruneHiddenDirectories":true}}"#,
    ))
    .unwrap();
    assert_eq!(
        (
            params.options.max_depth,
            params.options.max_directories,
            params.options.max_entries
        ),
        (2, 3, 4)
    );
    assert_eq!(params.options.prune_hidden_directories, Some(true));
    assert_eq!(
        failure(wire_fs::decode_walk(&parse(
            r#"{"path":"file:///a","options":null}"#
        ))),
        invalid("invalid type: null, expected struct WalkOptions")
    );
}

#[test]
fn fs_results_encode_to_the_canonical_shapes() {
    let chunk = wire_fs::encode_read_block_result(&ReadBlockResult {
        chunk: b"hi".to_vec(),
        eof: true,
    });
    assert_eq!(stringify_json(&chunk), r#"{"chunk":"aGk=","eof":true}"#);
    assert_eq!(stringify_json(&wire_fs::encode_empty()), "{}");
    let walk = wire_fs::encode_walk_result(&WalkResult {
        entries: vec![WalkEntry {
            path: "file:///a".into(),
            kind: WalkEntryKind::Directory,
        }],
        errors: vec![WalkError {
            path: "file:///b".into(),
            message: Text::from("denied"),
        }],
        truncated: true,
    });
    assert_eq!(
        stringify_json(&walk),
        r#"{"entries":[{"path":"file:///a","kind":"directory"}],"errors":[{"path":"file:///b","message":"denied"}],"truncated":true}"#
    );
}

#[test]
fn http_requests_default_headers_redirects_and_streaming() {
    let params = wire_http::decode_request(&parse(
        r#"{"method":"GET","url":"https://e.test/","requestId":"r1"}"#,
    ))
    .unwrap();
    assert!(params.headers.is_empty());
    assert_eq!(params.redirect_policy, HttpRedirectPolicy::Follow);
    assert!(!params.stream_response);
    assert_eq!((params.body, params.timeout_ms), (None, None));
}

#[test]
fn http_requests_report_missing_and_mistyped_members() {
    let decode = |text: &str| wire_http::decode_request(&parse(text));
    assert_eq!(
        failure(decode(r#"{"method":"GET","url":"u"}"#)),
        invalid("missing field `requestId`")
    );
    assert_eq!(
        failure(decode(
            r#"{"method":"GET","url":"u","requestId":"r","headers":null}"#
        )),
        invalid("invalid type: null, expected a sequence")
    );
    assert_eq!(
        failure(decode(
            r#"{"method":"GET","url":"u","requestId":"r","headers":[{"name":"a"}]}"#
        )),
        invalid("missing field `value`")
    );
    assert_eq!(
        failure(decode(
            r#"{"method":"GET","url":"u","requestId":"r","redirectPolicy":"maybe"}"#
        )),
        invalid("unknown variant `maybe`, expected `follow` or `stop`")
    );
    assert_eq!(
        failure(decode(
            r#"{"method":"GET","url":"u","requestId":"r","timeoutMs":-5}"#
        )),
        invalid("invalid value: integer `-5`, expected u64")
    );
    assert_eq!(
        failure(decode(
            r#"{"method":"GET","url":"u","requestId":"r","timeoutMs":1.5}"#
        )),
        invalid("invalid type: floating point `1.5`, expected u64")
    );
    assert_eq!(
        failure(decode(
            r#"{"method":"GET","url":"u","requestId":"r","streamResponse":"yes"}"#
        )),
        invalid(r#"invalid type: string "yes", expected a boolean"#)
    );
}

#[test]
fn http_bodies_are_base64_and_headers_keep_env_var_names() {
    let params = wire_http::decode_request(&parse(
        r#"{"method":"POST","url":"u","requestId":"r","bodyBase64":"aGk=","headers":[{"name":"x","value":"","valueEnvVar":"TOKEN"}],"timeoutMs":9,"redirectPolicy":"stop","streamResponse":true}"#,
    ))
    .unwrap();
    assert_eq!(params.body, Some(b"hi".to_vec()));
    assert_eq!(params.headers[0].value_env_var, Some(Text::from("TOKEN")));
    assert_eq!(
        (
            params.timeout_ms,
            params.redirect_policy,
            params.stream_response
        ),
        (Some(9), HttpRedirectPolicy::Stop, true)
    );
    assert_eq!(
        failure(wire_http::decode_request(&parse(
            r#"{"method":"POST","url":"u","requestId":"r","bodyBase64":"a$k="}"#
        ))),
        invalid("Invalid symbol 36, offset 1.")
    );
}

#[test]
fn http_responses_and_body_deltas_encode_to_the_canonical_shapes() {
    let response = wire_http::encode_response(&HttpResponse {
        status: 201,
        headers: vec![
            HttpHeader {
                name: "a".into(),
                value: "b".into(),
                value_env_var: None,
            },
            HttpHeader {
                name: "c".into(),
                value: "".into(),
                value_env_var: Some("E".into()),
            },
        ],
        body: b"ok".to_vec(),
    });
    assert_eq!(
        stringify_json(&response),
        r#"{"status":201,"headers":[{"name":"a","value":"b"},{"name":"c","value":"","valueEnvVar":"E"}],"bodyBase64":"b2s="}"#
    );
    let delta = wire_http::encode_body_delta(&HttpBodyDelta {
        request_id: "r".into(),
        seq: 3,
        delta: b"hi".to_vec(),
        done: false,
        error: None,
    });
    assert_eq!(
        stringify_json(&delta),
        r#"{"requestId":"r","seq":3,"deltaBase64":"aGk=","done":false,"error":null}"#
    );
}

#[test]
fn process_start_decodes_defaults() {
    let exec = wire_base::decode_process_start(Some(&parse(START))).unwrap();
    assert_eq!(exec.process_id, Text::from("p1"));
    assert_eq!(exec.argv, [Text::from("ls"), Text::from("-l")]);
    assert_eq!(
        exec.env,
        [
            (Text::from("A"), Text::from("1")),
            (Text::from("B"), Text::from("2"))
        ]
    );
    assert!(!exec.tty && !exec.pipe_stdin);
    assert_eq!(
        (
            exec.arg0,
            exec.metadata,
            exec.env_policy,
            exec.network_proxy
        ),
        (None, None, None, None)
    );
}

#[test]
fn process_start_rejections_use_the_canonical_messages() {
    let reject = |extra: &str| failure(wire_base::decode_process_start(Some(&start_with(extra))));
    let invalid_params = |message: &str| invalid(&format!("Invalid params: {message}"));
    assert_eq!(
        failure(wire_base::decode_process_start(None)),
        invalid_params("object expected")
    );
    assert_eq!(
        reject(r#""arg0":1"#),
        invalid_params("arg0 must be a string")
    );
    assert_eq!(
        reject(r#""tty":null"#),
        invalid_params("tty must be a boolean")
    );
    assert_eq!(
        reject(r#""pipeStdin":1"#),
        invalid_params("pipeStdin must be a boolean")
    );
    assert_eq!(
        reject(r#""enforceManagedNetwork":"x""#),
        invalid_params("enforceManagedNetwork must be a boolean")
    );
    assert_eq!(
        reject(r#""sandbox":[]"#),
        invalid_params("sandbox must be an object")
    );
    assert_eq!(
        reject(r#""managedNetwork":1"#),
        invalid_params("managedNetwork must be an object")
    );
    assert_eq!(
        reject(r#""metadata":{"threadId":"nope"}"#),
        invalid_params("invalid metadata.threadId")
    );
    assert_eq!(
        reject(r#""metadata":{"toolCallId":1}"#),
        invalid_params("metadata.toolCallId must be a string")
    );
    assert_eq!(
        reject(r#""envPolicy":{"inherit":"core"}"#),
        invalid_params("invalid envPolicy")
    );
    let bad = |body: &str| failure(wire_base::decode_process_start(Some(&parse(body))));
    assert_eq!(
        bad(r#"{"processId":"","argv":["a"],"cwd":"file:///w","env":{}}"#),
        invalid_params("invalid processId")
    );
    assert_eq!(
        bad(r#"{"processId":"p","argv":[],"cwd":"file:///w","env":{}}"#),
        invalid_params("argv must be non-empty string array")
    );
    assert_eq!(
        bad(r#"{"processId":"p","argv":["a",1],"cwd":"file:///w","env":{}}"#),
        invalid_params("argv must be non-empty string array")
    );
    assert_eq!(
        bad(r#"{"processId":"p","argv":["a"],"cwd":"http://w","env":{}}"#),
        invalid_params("cwd must be a valid file:// URI")
    );
    assert_eq!(
        bad(r#"{"processId":"p","argv":["a"],"cwd":"file:///w","env":[]}"#),
        invalid_params("env must be an object")
    );
    assert_eq!(
        bad(r#"{"processId":"p","argv":["a"],"cwd":"file:///w","env":{"A":1}}"#),
        invalid_params("invalid env key/value")
    );
    let long = "x".repeat(257);
    assert_eq!(
        bad(&format!(
            r#"{{"processId":"{long}","argv":["a"],"cwd":"file:///w","env":{{}}}}"#
        )),
        invalid_params("invalid processId")
    );
}

#[test]
fn process_start_accepts_every_thread_id_form() {
    for id in [
        "0123456789abcdef0123456789ABCDEF",
        "01234567-89ab-cdef-0123-456789abcdef",
        "{01234567-89ab-cdef-0123-456789abcdef}",
        "urn:uuid:01234567-89ab-cdef-0123-456789abcdef",
    ] {
        let exec = wire_base::decode_process_start(Some(&start_with(&format!(
            r#""metadata":{{"threadId":"{id}","toolCallId":"t"}}"#
        ))))
        .unwrap();
        let metadata = exec.metadata.unwrap();
        assert_eq!(metadata.thread_id.as_deref(), Some(id));
        assert_eq!(metadata.tool_call_id, Some(Text::from("t")));
    }
}

#[test]
fn process_start_decodes_network_proxy_and_shell_snapshot_extensions() {
    let exec = wire_base::decode_process_start(Some(&start_with(&format!(
        r#"{PROXY},"shellSnapshot":{{"scopeId":"s","shell":{{"name":"zsh","path":"/bin/zsh"}}}}"#
    ))))
    .unwrap();
    let launch = exec.network_proxy.unwrap();
    assert!(launch.proxy.enabled && launch.proxy.credential_masking);
    assert_eq!(launch.proxy.mode, NetworkMode::Limited);
    assert_eq!(launch.proxy.credential_providers.len(), 1);
    assert_eq!(
        launch.proxy.credential_providers[0].1.auth,
        [CredentialAuthMethod::Bearer]
    );
    assert_eq!(
        launch.proxy.domains,
        Some(vec![(Text::from("a.test"), DomainPermission::Allow)])
    );
    assert_eq!(launch.proxy.review_domains, [Text::from("b.test")]);
    assert_eq!(launch.audit_metadata.conversation_id, Some(Text::from("c")));
    assert_eq!(launch.environment_id, Some(Text::from("e")));
    assert_eq!(launch.policy_decision_timeout_ms, Some(1500));
    let snapshot = exec.shell_snapshot.unwrap();
    assert_eq!(
        (snapshot.scope_id, snapshot.shell.path),
        (Text::from("s"), Text::from("/bin/zsh"))
    );
}

#[test]
fn credential_providers_are_dropped_when_masking_is_off() {
    let masked_off = PROXY.replace(
        r#""credentialMasking":true"#,
        r#""credentialMasking":false"#,
    );
    let exec = wire_base::decode_process_start(Some(&start_with(&masked_off))).unwrap();
    assert!(
        exec.network_proxy
            .unwrap()
            .proxy
            .credential_providers
            .is_empty()
    );
}

#[test]
fn network_proxy_rejections_use_the_canonical_messages() {
    let reject = |extra: &str| failure(wire_base::decode_process_start(Some(&start_with(extra))));
    let message = |text: String| invalid(&format!("Invalid params: {text}"));
    assert_eq!(
        reject(&PROXY.replace(r#""mode":"limited""#, r#""mode":"wide""#)),
        message("networkProxy.proxy.mode must be one of limited, full".into())
    );
    assert_eq!(
        reject(&PROXY.replace(
            r#""policyDecisionTimeoutMs":1500"#,
            r#""policyDecisionTimeoutMs":0"#
        )),
        message("network policy decision callback timeout must be nonzero".into())
    );
    assert_eq!(
        reject(&PROXY.replace(
            r#""policyDecisionTimeoutMs":1500"#,
            r#""policyDecisionTimeoutMs":-1"#
        )),
        message("networkProxy.policyDecisionTimeoutMs must be a non-negative integer".into())
    );
    assert_eq!(
        reject(&PROXY.replace(r#""auth":["bearer"]"#, r#""auth":["bearer"],"bogus":1"#)),
        message("networkProxy.proxy.credentialProviders.p has unknown field bogus".into())
    );
    assert_eq!(
        reject(&PROXY.replace(r#""enabled":true,"#, "")),
        message("networkProxy.proxy.enabled must be a boolean".into())
    );
    assert_eq!(
        reject(&PROXY.replace(
            r#""domains":{"a.test":"allow"}"#,
            r#""domains":{"a.test":"maybe"}"#
        )),
        message("networkProxy.proxy.domains.a.test must be one of none, allow, deny".into())
    );
    assert_eq!(
        reject(r#""shellSnapshot":{"shell":{"name":"zsh","path":"/bin/zsh"}}"#),
        message("shellSnapshot.scopeId must be a string".into())
    );
}

#[test]
fn process_requests_are_bounded() {
    let read = |body: &str| wire_base::decode_process_read(Some(&parse(body)));
    let message = |text: &str| invalid(&format!("Invalid params: {text}"));
    let ok =
        read(r#"{"processId":"p","afterSeq":3,"maxBytes":104857600,"waitMs":120000}"#).unwrap();
    assert_eq!(
        (ok.after_seq, ok.max_bytes, ok.wait_ms),
        (Some(3), Some(104_857_600), Some(120_000))
    );
    assert_eq!(
        failure(read(r#"{"processId":"p","afterSeq":-1}"#)),
        message("invalid afterSeq")
    );
    assert_eq!(
        failure(read(r#"{"processId":"p","maxBytes":104857601}"#)),
        message("invalid maxBytes")
    );
    assert_eq!(
        failure(read(r#"{"processId":"p","waitMs":120001}"#)),
        message("invalid waitMs")
    );
    assert_eq!(
        failure(read(r#"{"processId":"p","waitMs":1.5}"#)),
        message("invalid waitMs")
    );
    let write = |body: &str| wire_base::decode_process_write(Some(&parse(body)));
    assert_eq!(
        write(r#"{"processId":"p","writeId":"w","chunk":""}"#)
            .unwrap()
            .chunk,
        ""
    );
    assert_eq!(
        failure(write(r#"{"processId":"p","writeId":"w","chunk":"abc"}"#)),
        message("chunk must be valid standard base64")
    );
    assert_eq!(
        failure(write(r#"{"processId":"p","writeId":"","chunk":""}"#)),
        message("writeId must be non-empty")
    );
    let signal = |body: &str| wire_base::decode_process_signal(Some(&parse(body)));
    assert!(signal(r#"{"processId":"p","signal":"interrupt"}"#).is_ok());
    assert_eq!(
        failure(signal(r#"{"processId":"p","signal":"kill"}"#)),
        message("signal must be 'interrupt'")
    );
}

#[test]
fn base_fs_requests_validate_uri_flags_and_payloads() {
    let message = |text: &str| invalid(&format!("Invalid params: {text}"));
    let read = |body: &str| wire_base::decode_read_file(Some(&parse(body)));
    assert_eq!(
        failure(read(r#"{"path":"http://x"}"#)),
        message("path must be a valid file:// URI")
    );
    assert_eq!(
        failure(read(r#"{"path":"file:///a","followSymlinks":1}"#)),
        message("followSymlinks must be a boolean")
    );
    assert_eq!(
        failure(read(r#"{"path":"file:///a","sandbox":[]}"#)),
        message("sandbox must be an object")
    );
    assert_eq!(
        read(r#"{"path":"file:///a","followSymlinks":null}"#)
            .unwrap()
            .follow_symlinks,
        None
    );
    let write = |body: &str| wire_base::decode_write_file(Some(&parse(body)));
    assert_eq!(
        failure(write(r#"{"path":"file:///a","dataBase64":"abc"}"#)),
        message("dataBase64 must be valid standard base64")
    );
    assert_eq!(
        write(r#"{"path":"file:///a","dataBase64":"aGk="}"#)
            .unwrap()
            .data_base64,
        "aGk="
    );
}

#[test]
fn initialize_params_split_the_client_name_and_resume_id() {
    let decode = |body: &str| wire_base::decode_initialize(Some(&parse(body)));
    assert_eq!(
        decode(r#"{"clientName":"c"}"#).unwrap(),
        (Text::from("c"), None)
    );
    assert_eq!(
        decode(r#"{"clientName":"c","resumeSessionId":null}"#)
            .unwrap()
            .1,
        None
    );
    assert_eq!(
        decode(r#"{"clientName":"c","resumeSessionId":"s"}"#)
            .unwrap()
            .1,
        Some(Text::from("s"))
    );
    assert_eq!(
        failure(decode(r#"{"clientName":""}"#)),
        invalid("Invalid params: clientName is required")
    );
    assert_eq!(
        failure(decode(r#"{"clientName":"c","resumeSessionId":3}"#)),
        invalid("Invalid params: invalid resumeSessionId")
    );
    assert_eq!(
        failure(wire_base::decode_initialize(None)),
        invalid("Invalid params: object expected")
    );
}

#[test]
fn environment_info_encodes_every_canonical_capability() {
    let encoded = wire_base::encode_environment_info(&canonical_info());
    let capabilities = at(&encoded, "capabilities");
    for name in [
        "networkProxyLaunch",
        "networkProxyReviewDomains",
        "credentialMasking",
        "credentialMaskingCustomProviders",
        "capabilityDiscoverySandbox",
        "capabilityDiscoveryV2",
        "environmentConfigRead",
        "httpHeaderEnvVars",
        "sandboxedFileStreaming",
        "fileWriteStreaming",
        "shellSnapshotV2",
    ] {
        assert_eq!(at(capabilities, name), &JsonValue::Bool(true), "{name}");
    }
    assert_eq!(at(capabilities, "windowsMxc"), &JsonValue::Bool(false));
    assert!(!has(capabilities, "fsWatchMissing"));
    assert_eq!(at(&encoded, "tempDir"), &JsonValue::Null);
    assert!(!has(&encoded, "prependPathDirs"));
    assert_eq!(str_of(at(at(&encoded, "shell"), "path")), "/bin/zsh");
}

#[test]
fn an_advertised_capability_without_a_backend_is_reported() {
    let info = canonical_info();
    assert_eq!(
        wire_base::unbacked_capability(&info.capabilities, &full_features()),
        None
    );
    assert_eq!(
        wire_base::unbacked_capability(&info.capabilities, &BackendFeatures::default()),
        Some("networkProxyLaunch")
    );
    let mut features = full_features();
    features.file_streaming = false;
    assert_eq!(
        wire_base::unbacked_capability(&info.capabilities, &features),
        Some("sandboxedFileStreaming")
    );
    features = full_features();
    features.capability_discovery_v2 = false;
    assert_eq!(
        wire_base::unbacked_capability(&info.capabilities, &features),
        Some("capabilityDiscoveryV2")
    );
    features = full_features();
    features.environment_config_read = false;
    assert_eq!(
        wire_base::unbacked_capability(&info.capabilities, &features),
        Some("environmentConfigRead")
    );
}

#[test]
fn process_results_encode_optional_members_only_when_present() {
    let exec = wire_base::encode_exec_result(&ExecResult {
        process_id: "p".into(),
        sandbox_type: Presence::Absent,
    });
    assert_eq!(stringify_json(&exec), r#"{"processId":"p"}"#);
    let exec = wire_base::encode_exec_result(&ExecResult {
        process_id: "p".into(),
        sandbox_type: Presence::Value(SandboxType::MacosSeatbelt),
    });
    assert_eq!(
        stringify_json(&exec),
        r#"{"processId":"p","sandboxType":"macosSeatbelt"}"#
    );
    let read = wire_base::encode_read_result(&ReadResult {
        chunks: vec![ProcessOutputChunk {
            seq: 1,
            stream: ProcessStream::Pty,
            chunk: "aGk=".into(),
        }],
        next_seq: 2,
        exited: true,
        exit_code: Presence::Null,
        closed: false,
        failure: Presence::Absent,
        sandbox_denied: None,
    });
    assert_eq!(
        stringify_json(&read),
        r#"{"chunks":[{"seq":1,"stream":"pty","chunk":"aGk="}],"nextSeq":2,"exited":true,"exitCode":null,"closed":false}"#
    );
    let write = wire_base::encode_write_result(&WriteResult {
        status: WriteStatus::UnknownProcess,
    });
    assert_eq!(stringify_json(&write), r#"{"status":"unknownProcess"}"#);
}

#[test]
fn environment_config_params_decode_and_report_serde_errors() {
    let decode = |body: Option<&str>| {
        let value = body.map(parse);
        wire_env::decode_environment_config_read(value.as_ref())
    };
    let ok = decode(Some(
        r#"{"cwd":"file:///w","configPaths":[["a","b"]],"requirementsPaths":[]}"#,
    ))
    .unwrap();
    assert_eq!(
        ok.config_paths,
        vec![vec![Text::from("a"), Text::from("b")]]
    );
    assert!(ok.requirements_paths.is_empty());
    assert_eq!(
        failure(decode(Some(r#"{"cwd":"file:///w","configPaths":[]}"#))),
        invalid("missing field `requirementsPaths`")
    );
    assert_eq!(
        failure(decode(Some(
            r#"{"cwd":"http://w","configPaths":[],"requirementsPaths":[]}"#
        ))),
        invalid("unsupported path URI scheme `http`")
    );
    assert_eq!(
        failure(decode(Some(
            r#"{"cwd":"rel","configPaths":[],"requirementsPaths":[]}"#
        ))),
        invalid("invalid URI: relative URL without a base")
    );
    assert_eq!(
        failure(decode(Some("[]"))),
        invalid("invalid type: sequence, expected struct EnvironmentConfigReadParams")
    );
    assert_eq!(
        failure(decode(None)),
        invalid("invalid type: null, expected struct EnvironmentConfigReadParams")
    );
    assert_eq!(
        failure(decode(Some(
            r#"{"cwd":"file:///w","configPaths":[[1]],"requirementsPaths":[]}"#
        ))),
        invalid("invalid type: number, expected a string")
    );
    assert_eq!(
        failure(decode(Some(
            r#"{"cwd":"file:///w","configPaths":"x","requirementsPaths":[]}"#
        ))),
        invalid(r#"invalid type: string "x", expected a sequence"#)
    );
}

#[test]
fn capability_root_params_decode_and_report_serde_errors() {
    let decode = |body: &str| {
        let value = parse(body);
        wire_env::decode_capability_roots_discover(Some(&value))
    };
    let ok = decode(r#"{"roots":[{"id":"r","path":"file:///r","sandbox":null}]}"#).unwrap();
    assert_eq!(
        (
            ok.roots[0].id.clone(),
            ok.roots[0].path.clone(),
            ok.roots[0].sandbox.is_none()
        ),
        (Text::from("r"), Text::from("file:///r"), true)
    );
    assert_eq!(failure(decode("{}")), invalid("missing field `roots`"));
    assert_eq!(
        failure(decode(r#"{"roots":5}"#)),
        invalid("invalid type: number, expected a sequence")
    );
    assert_eq!(
        failure(decode(r#"{"roots":[{"path":"file:///r"}]}"#)),
        invalid("missing field `id`")
    );
    assert_eq!(
        failure(decode(
            r#"{"roots":[{"id":"r","path":"file:///r","sandbox":5}]}"#
        )),
        invalid("invalid type: number, expected struct WireFileSystemSandboxContext")
    );
    assert_eq!(
        failure(decode(r#"{"roots":[5]}"#)),
        invalid("invalid type: number, expected struct WireCapabilityRootDiscoverRequest")
    );
}

#[test]
fn discover_v2_params_accept_object_and_tuple_forms() {
    let sandbox = r#"{"permissions":{"type":"managed"},"cwd":"file:///w","windowsSandboxLevel":"disabled","workspaceRoots":["file:///w"],"userHomeDir":null}"#;
    let decode = |body: &str| {
        let value = parse(body);
        wire_env::decode_discover_v2(Some(&value))
    };
    assert_eq!(
        decode(r#"{"cwd":"file:///w"}"#).unwrap().cwd,
        Text::from("file:///w")
    );
    assert_eq!(decode(r#"["file:///w"]"#).unwrap().sandbox, None);
    assert!(
        decode(&format!(r#"["file:///w",{sandbox}]"#))
            .unwrap()
            .sandbox
            .is_some()
    );
    assert!(
        decode(&format!(r#"{{"cwd":"file:///w","sandbox":{sandbox}}}"#))
            .unwrap()
            .sandbox
            .is_some()
    );
    assert_eq!(
        decode(r#"{"cwd":"file:///w","sandbox":null}"#)
            .unwrap()
            .sandbox,
        None
    );
}

#[test]
fn discover_v2_params_report_serde_errors() {
    let decode = |body: &str| {
        let value = parse(body);
        wire_env::decode_discover_v2(Some(&value))
    };
    let with_sandbox =
        |sandbox: &str| decode(&format!(r#"{{"cwd":"file:///w","sandbox":{sandbox}}}"#));
    assert_eq!(
        failure(decode("[]")),
        invalid("invalid length 0, expected struct DiscoverV2CapabilitiesRequest with 2 elements")
    );
    assert_eq!(
        failure(decode(r#"["file:///w",null,1]"#)),
        invalid("invalid length 3, expected fewer elements in array")
    );
    assert_eq!(failure(decode("{}")), invalid("missing field `cwd`"));
    assert_eq!(
        failure(decode("5")),
        invalid("invalid type: number, expected struct DiscoverV2CapabilitiesRequest")
    );
    assert_eq!(
        failure(decode(r#"{"cwd":"file:///w?x"}"#)),
        invalid("query parameters are not allowed in path URIs")
    );
    assert_eq!(
        failure(decode(r##"{"cwd":"file:///w#x"}"##)),
        invalid("fragments are not allowed in path URIs")
    );
    assert_eq!(
        failure(decode(r#"{"cwd":"http://w"}"#)),
        invalid("unsupported path URI scheme `http`")
    );
    assert_eq!(
        failure(decode(r#"{"cwd":"w"}"#)),
        invalid("invalid URI: relative URL without a base")
    );
    assert_eq!(
        failure(with_sandbox(
            r#"{"permissions":{"type":"bogus"},"cwd":"file:///w","windowsSandboxLevel":"disabled"}"#
        )),
        invalid("unknown variant `bogus`, expected one of `managed`, `disabled`, `external`")
    );
    assert_eq!(
        failure(with_sandbox(
            r#"{"permissions":[],"cwd":"file:///w","windowsSandboxLevel":"disabled"}"#
        )),
        invalid("missing field `type`")
    );
    assert_eq!(
        failure(with_sandbox(
            r#"{"permissions":{"type":"managed"},"cwd":"file:///w"}"#
        )),
        invalid("missing field `windowsSandboxLevel`")
    );
    assert_eq!(
        failure(with_sandbox(
            r#"{"permissions":{"type":"managed"},"cwd":"file:///w","windowsSandboxLevel":"bogus"}"#
        )),
        invalid(
            "unknown variant `bogus`, expected one of `disabled`, `restricted-token`, `elevated`, `mxc`"
        )
    );
    assert_eq!(
        failure(with_sandbox(
            r#"{"permissions":{"type":"managed"},"cwd":"file:///w","windowsSandboxLevel":"mxc","useLegacyLandlock":"yes"}"#
        )),
        invalid(r#"invalid type: string "yes", expected a boolean"#)
    );
    assert_eq!(
        failure(with_sandbox("[]")),
        invalid("invalid length 0, expected struct FileSystemSandboxContext with 9 elements")
    );
    assert_eq!(
        failure(with_sandbox("[1]")),
        invalid("invalid type: sequence, expected struct FileSystemSandboxContext")
    );
    assert_eq!(
        failure(with_sandbox("7")),
        invalid("invalid type: number, expected struct FileSystemSandboxContext")
    );
}

#[test]
fn process_events_encode_the_notification_shapes() {
    let output = wire_process::encode_process_event(&ProcessEvent::Output {
        process_id: "p".into(),
        seq: 4,
        stream: ProcessStream::Stderr,
        chunk: b"hi".to_vec(),
    });
    assert_eq!(output.0, "process/output");
    assert_eq!(
        stringify_json(&output.1),
        r#"{"processId":"p","seq":4,"stream":"stderr","chunk":"aGk="}"#
    );
    let exited = wire_process::encode_process_event(&ProcessEvent::Exited {
        process_id: "p".into(),
        seq: 5,
        exit_code: None,
        sandbox_denied: true,
    });
    assert_eq!(exited.0, "process/exited");
    assert_eq!(
        stringify_json(&exited.1),
        r#"{"processId":"p","seq":5,"exitCode":null,"sandboxDenied":true}"#
    );
    let closed = wire_process::encode_process_event(&ProcessEvent::Closed {
        process_id: "p".into(),
        seq: 6,
    });
    assert_eq!(
        (closed.0, stringify_json(&closed.1).as_str()),
        ("process/closed", r#"{"processId":"p","seq":6}"#)
    );
}

fn scripted_caller(
    calls: Arc<Mutex<Vec<(String, JsonValue, Signal)>>>,
    reply: Option<Result<JsonValue, CallError>>,
) -> Caller {
    Caller::new(Arc::new(move |method, params, options: CallOptions| {
        locked(&calls).push((
            method,
            params,
            options.signal.clone().unwrap_or_else(Signal::never),
        ));
        let reply = reply.clone();
        let future: Boxed<'static, Result<JsonValue, CallError>> = Box::pin(async move {
            match reply {
                Some(reply) => reply,
                None => std::future::pending().await,
            }
        });
        future
    }))
}

fn policy_request(host: &str) -> NetworkPolicyRequest {
    NetworkPolicyRequest {
        protocol: NetworkProtocol::HttpsConnect,
        host: host.into(),
        port: 443,
    }
}

#[tokio::test]
async fn network_policy_decider_relays_the_controller_decision() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let allow = scripted_caller(
        calls.clone(),
        Some(Ok(parse(r#"{"decision":{"type":"allow"}}"#))),
    );
    let decider = NetworkPolicyDecider::new("p1", 1_000, allow, None, None);
    assert_eq!(
        decider.decide(&policy_request("a.test")).await,
        NetworkDecision::Allow
    );
    {
        let calls = locked(&calls);
        assert_eq!(calls[0].0, "network/policyRequest");
        assert_eq!(
            stringify_json(&calls[0].1),
            r#"{"processId":"p1","request":{"protocol":"https_connect","host":"a.test","port":443}}"#
        );
    }
    let ask = scripted_caller(
        calls.clone(),
        Some(Ok(parse(
            r#"{"decision":{"type":"ask","reason":"review"}}"#,
        ))),
    );
    let decider = NetworkPolicyDecider::new("p1", 1_000, ask, None, None);
    assert_eq!(
        decider.decide(&policy_request("a.test")).await,
        NetworkDecision::Ask {
            reason: "review".into()
        }
    );
}

#[tokio::test]
async fn network_policy_decider_denies_on_every_failure() {
    let denied = NetworkDecision::Deny {
        reason: "not_allowed".into(),
    };
    let calls = Arc::new(Mutex::new(Vec::new()));
    for reply in [
        Err(CallError::Closed),
        Ok(parse(r#"{"decision":{"type":"maybe"}}"#)),
        Ok(parse(r#"{"decision":{"type":"deny"}}"#)),
        Ok(parse(r#"{"decision":{"type":"deny","reason":"a\u0007b"}}"#)),
        Ok(parse("5")),
    ] {
        let decider = NetworkPolicyDecider::new(
            "p1",
            1_000,
            scripted_caller(calls.clone(), Some(reply)),
            None,
            None,
        );
        assert_eq!(decider.decide(&policy_request("a.test")).await, denied);
    }
    let long = format!(
        r#"{{"decision":{{"type":"deny","reason":"{}"}}}}"#,
        "x".repeat(1025)
    );
    let decider = NetworkPolicyDecider::new(
        "p1",
        1_000,
        scripted_caller(calls.clone(), Some(Ok(parse(&long)))),
        None,
        None,
    );
    assert_eq!(decider.decide(&policy_request("a.test")).await, denied);
}

#[tokio::test]
async fn network_policy_decider_rejects_hosts_without_asking() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let decider = NetworkPolicyDecider::new(
        "p1",
        1_000,
        scripted_caller(
            calls.clone(),
            Some(Ok(parse(r#"{"decision":{"type":"allow"}}"#))),
        ),
        None,
        None,
    );
    let denied = NetworkDecision::Deny {
        reason: "not_allowed".into(),
    };
    let long = "h".repeat(254);
    for host in ["", "bad host", "a\u{7}b", "tab\there", long.as_str()] {
        assert_eq!(
            decider.decide(&policy_request(host)).await,
            denied,
            "{host:?}"
        );
    }
    assert!(locked(&calls).is_empty());
}

#[tokio::test]
async fn network_policy_decider_times_out_and_cancels_the_call() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let decider = NetworkPolicyDecider::new(
        "p1",
        20,
        scripted_caller(calls.clone(), None),
        None,
        Some(20),
    );
    let denied = NetworkDecision::Deny {
        reason: "not_allowed".into(),
    };
    assert_eq!(decider.decide(&policy_request("a.test")).await, denied);
    assert!(locked(&calls)[0].2.is_aborted());
}

#[tokio::test]
async fn network_policy_decider_denies_after_shutdown() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let shutdown = Abort::new();
    let decider = NetworkPolicyDecider::new(
        "p1",
        60_000,
        scripted_caller(calls.clone(), None),
        Some(shutdown.signal()),
        None,
    );
    let waiting = tokio::spawn(async move { decider.decide(&policy_request("a.test")).await });
    eventually(|| !locked(&calls).is_empty()).await;
    shutdown.abort();
    assert_eq!(
        waiting.await.unwrap(),
        NetworkDecision::Deny {
            reason: "not_allowed".into()
        }
    );
    assert!(locked(&calls)[0].2.is_aborted());
}

const HIGH: u16 = 0xd800;
const LOW: u16 = 0xdc00;

fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn joined(parts: &[&[u16]]) -> Text {
    Text::from_utf16(parts.concat())
}

fn object_of(text: &str) -> ycoding_core::ycoding_schema::JsonObject {
    match parse(text) {
        JsonValue::Object(object) => object,
        other => panic!("not an object: {}", stringify_json(&other)),
    }
}

#[test]
fn process_start_keeps_unpaired_surrogates_in_every_client_string_key_and_nested_value() {
    let exec = wire_base::decode_process_start(Some(&parse(
        r#"{"processId":"p\ud800","argv":["a\udc00","\ud83d","\ud83d\ude00"],"cwd":"file:///w\ud800","env":{"K\ud800":"V\udc00","plain":"x"},"arg0":"z\udbff","metadata":{"toolCallId":"t\udc00"},"sandbox":{"outer":{"k\ud800":["\udc00"]}},"managedNetwork":{"m\udc00":"\ud800"},"shellSnapshot":{"scopeId":"s\ud800","shell":{"name":"n\udc00","path":"/p\ud800"}}}"#,
    )))
    .unwrap();
    assert_eq!(exec.process_id, units("p", &[HIGH], ""));
    assert_eq!(
        exec.argv,
        [
            units("a", &[LOW], ""),
            units("", &[0xd83d], ""),
            Text::from("\u{1f600}")
        ]
    );
    assert_eq!(exec.cwd, units("file:///w", &[HIGH], ""));
    assert_eq!(
        exec.env,
        [
            (units("K", &[HIGH], ""), units("V", &[LOW], "")),
            (Text::from("plain"), Text::from("x"))
        ]
    );
    assert_eq!(exec.arg0, Some(units("z", &[0xdbff], "")));
    assert_eq!(
        exec.metadata.unwrap().tool_call_id,
        Some(units("t", &[LOW], ""))
    );
    assert_eq!(
        exec.sandbox,
        Some(object_of(r#"{"outer":{"k\ud800":["\udc00"]}}"#))
    );
    assert_eq!(
        exec.managed_network,
        Some(object_of(r#"{"m\udc00":"\ud800"}"#))
    );
    let snapshot = exec.shell_snapshot.unwrap();
    assert_eq!(snapshot.scope_id, units("s", &[HIGH], ""));
    assert_eq!(snapshot.shell.name, units("n", &[LOW], ""));
    assert_eq!(snapshot.shell.path, units("/p", &[HIGH], ""));
}

#[test]
fn network_proxy_keeps_unpaired_surrogates_in_values_and_map_keys() {
    let proxy = PROXY
        .replace(r#""p":{"env":["T"]"#, r#""p\udc00":{"env":["T\ud800"]"#)
        .replace(r#""a.test":"allow""#, r#""a\ud800.test":"allow""#)
        .replace(
            r#""reviewDomains":["b.test"]"#,
            r#""reviewDomains":["b\udc00"]"#,
        )
        .replace(r#""conversationId":"c""#, r#""conversationId":"c\ud800""#)
        .replace(r#""environmentId":"e""#, r#""environmentId":"e\udc00""#);
    let launch = wire_base::decode_process_start(Some(&start_with(&proxy)))
        .unwrap()
        .network_proxy
        .unwrap();
    assert_eq!(
        launch.proxy.credential_providers[0].0,
        units("p", &[LOW], "")
    );
    assert_eq!(
        launch.proxy.credential_providers[0].1.env,
        [units("T", &[HIGH], "")]
    );
    assert_eq!(
        launch.proxy.domains,
        Some(vec![(
            units("a", &[HIGH], ".test"),
            DomainPermission::Allow
        )])
    );
    assert_eq!(launch.proxy.review_domains, [units("b", &[LOW], "")]);
    assert_eq!(
        launch.audit_metadata.conversation_id,
        Some(units("c", &[HIGH], ""))
    );
    assert_eq!(launch.environment_id, Some(units("e", &[LOW], "")));
}

#[test]
fn environment_values_keep_json_object_order_and_collapse_duplicate_keys() {
    let env = |body: &str| {
        wire_base::decode_process_start(Some(&parse(&format!(
            r#"{{"processId":"p","argv":["a"],"cwd":"file:///w","env":{body}}}"#
        ))))
        .unwrap()
        .env
    };
    assert_eq!(
        env(r#"{"b":"1","a":"2","10":"y","1":"x"}"#),
        [
            (Text::from("1"), Text::from("x")),
            (Text::from("10"), Text::from("y")),
            (Text::from("b"), Text::from("1")),
            (Text::from("a"), Text::from("2")),
        ]
    );
    assert_eq!(
        env(r#"{"A":"1","B":"3","A":"2"}"#),
        [
            (Text::from("A"), Text::from("2")),
            (Text::from("B"), Text::from("3"))
        ]
    );
}

#[test]
fn env_policy_is_passed_through_with_unknown_fields_intact() {
    let policy = r#"{"inherit":"core","ignoreDefaultExcludes":false,"exclude":["x"],"includeOnly":["\ud800"],"set":{"K":"V","k\udc00":"\ud800"},"future":{"x":[1,2,{"y":null}]},"z\ud800":true}"#;
    let exec =
        wire_base::decode_process_start(Some(&start_with(&format!(r#""envPolicy":{policy}"#))))
            .unwrap();
    assert_eq!(exec.env_policy, Some(object_of(policy)));
    let reject = |policy: &str| {
        failure(wire_base::decode_process_start(Some(&start_with(
            &format!(r#""envPolicy":{policy}"#),
        ))))
    };
    let expected = invalid("Invalid params: invalid envPolicy");
    for bad in [
        r#"{"inherit":"bogus","ignoreDefaultExcludes":false,"exclude":[],"includeOnly":[],"set":{}}"#,
        r#"{"inherit":"all","ignoreDefaultExcludes":"no","exclude":[],"includeOnly":[],"set":{}}"#,
        r#"{"inherit":"all","ignoreDefaultExcludes":false,"exclude":[1],"includeOnly":[],"set":{}}"#,
        r#"{"inherit":"all","ignoreDefaultExcludes":false,"exclude":[],"includeOnly":"x","set":{}}"#,
        r#"{"inherit":"all","ignoreDefaultExcludes":false,"exclude":[],"includeOnly":[],"set":null}"#,
        r#"{"inherit":"all","ignoreDefaultExcludes":false,"exclude":[],"includeOnly":[],"set":[]}"#,
        r#"{"inherit":"all","ignoreDefaultExcludes":false,"exclude":[],"includeOnly":[],"set":{"K":1}}"#,
    ] {
        assert_eq!(reject(bad), expected, "{bad}");
    }
}

#[test]
fn connection_and_http_text_keeps_unpaired_surrogates() {
    let open =
        wire_fs::decode_open(&parse(r#"{"handleId":"h\ud800","path":"file:///a"}"#)).unwrap();
    assert_eq!(open.handle_id, units("h", &[HIGH], ""));
    assert_eq!(
        stringify_json(&wire_fs::encode_open_result(&OpenResult {
            handle_id: open.handle_id
        })),
        r#"{"handleId":"h\ud800"}"#
    );
    assert_eq!(
        wire_fs::decode_read_block(&parse(r#"{"handleId":"\udc00","offset":0,"len":1}"#))
            .unwrap()
            .handle_id,
        units("", &[LOW], "")
    );
    assert_eq!(
        wire_fs::decode_close(&parse(r#"{"handleId":"\ud800x"}"#))
            .unwrap()
            .handle_id,
        units("", &[HIGH], "x")
    );

    let http = wire_http::decode_request(&parse(
        r#"{"method":"G\ud800","url":"u\udc00","requestId":"r\ud800","headers":[{"name":"n\udc00","value":"v\ud800","valueEnvVar":"E\udc00"}]}"#,
    ))
    .unwrap();
    assert_eq!(http.method, units("G", &[HIGH], ""));
    assert_eq!(http.url, units("u", &[LOW], ""));
    assert_eq!(http.request_id, units("r", &[HIGH], ""));
    assert_eq!(http.headers[0].name, units("n", &[LOW], ""));
    assert_eq!(http.headers[0].value, units("v", &[HIGH], ""));
    assert_eq!(http.headers[0].value_env_var, Some(units("E", &[LOW], "")));
    let response = wire_http::encode_response(&HttpResponse {
        status: 200,
        headers: http.headers.clone(),
        body: Vec::new(),
    });
    assert_eq!(
        stringify_json(&response),
        r#"{"status":200,"headers":[{"name":"n\udc00","value":"v\ud800","valueEnvVar":"E\udc00"}],"bodyBase64":""}"#
    );
    let delta = wire_http::encode_body_delta(&HttpBodyDelta {
        request_id: http.request_id,
        seq: 1,
        delta: Vec::new(),
        done: true,
        error: None,
    });
    assert_eq!(
        stringify_json(&delta),
        r#"{"requestId":"r\ud800","seq":1,"deltaBase64":"","done":true,"error":null}"#
    );
}

#[test]
fn environment_config_and_discovery_text_keeps_unpaired_surrogates() {
    let config = wire_env::decode_environment_config_read(Some(&parse(
        r#"{"cwd":"file:///w\ud800","configPaths":[["a\udc00","b"]],"requirementsPaths":[["\ud800"]]}"#,
    )))
    .unwrap();
    assert_eq!(config.cwd, units("file:///w", &[HIGH], ""));
    assert_eq!(
        config.config_paths,
        vec![vec![units("a", &[LOW], ""), Text::from("b")]]
    );
    assert_eq!(
        config.requirements_paths,
        vec![vec![units("", &[HIGH], "")]]
    );

    let roots = wire_env::decode_capability_roots_discover(Some(&parse(
        r#"{"roots":[{"id":"i\ud800","path":"file:///r\udc00"}]}"#,
    )))
    .unwrap();
    assert_eq!(roots.roots[0].id, units("i", &[HIGH], ""));
    assert_eq!(roots.roots[0].path, units("file:///r", &[LOW], ""));
    let v2 = wire_env::decode_discover_v2(Some(&parse(r#"{"cwd":"file:///w\ud800"}"#))).unwrap();
    assert_eq!(v2.cwd, units("file:///w", &[HIGH], ""));
}

#[test]
fn error_messages_echo_unpaired_surrogates_without_replacement() {
    let mode = failure(wire_fs::decode_open(&parse(
        r#"{"handleId":"h","path":"file:///a","mode":"\ud800"}"#,
    )));
    assert_eq!(
        mode.message,
        units(
            "unknown variant `",
            &[HIGH],
            "`, expected `read` or `replace`"
        )
    );
    let redirect = failure(wire_http::decode_request(&parse(
        r#"{"method":"GET","url":"u","requestId":"r","redirectPolicy":"\udc00"}"#,
    )));
    assert_eq!(
        redirect.message,
        units(
            "unknown variant `",
            &[LOW],
            "`, expected `follow` or `stop`"
        )
    );

    let provider = PROXY.replace(
        r#""p":{"env":["T"],"auth":["bearer"]}"#,
        r#""p\ud800":{"env":["T"],"auth":["bearer"],"bogus\udc00":1}"#,
    );
    let error = failure(wire_base::decode_process_start(Some(&start_with(
        &provider,
    ))));
    assert_eq!(
        error.message,
        joined(&[
            &u("Invalid params: networkProxy.proxy.credentialProviders.p"),
            &[HIGH],
            &u(" has unknown field bogus"),
            &[LOW],
        ])
    );
    let domain = PROXY.replace(r#""a.test":"allow""#, r#""a\ud800":"maybe""#);
    let error = failure(wire_base::decode_process_start(Some(&start_with(&domain))));
    assert_eq!(
        error.message,
        joined(&[
            &u("Invalid params: networkProxy.proxy.domains.a"),
            &[HIGH],
            &u(" must be one of none, allow, deny"),
        ])
    );
    let sandbox = failure(wire_env::decode_discover_v2(Some(&parse(
        r#"{"cwd":"file:///w","sandbox":{"permissions":{"type":"x\ud800"},"cwd":"file:///w","windowsSandboxLevel":"disabled"}}"#,
    ))));
    assert_eq!(
        sandbox.message,
        joined(&[
            &u("unknown variant `x"),
            &[HIGH],
            &u("`, expected one of `managed`, `disabled`, `external`"),
        ])
    );
}

#[test]
fn unsigned_fields_cover_the_full_u64_range() {
    let read = |offset: &str| {
        wire_fs::decode_read_block(&parse(&format!(
            r#"{{"handleId":"h","offset":{offset},"len":1}}"#
        )))
    };
    assert_eq!(read("18446744073709551616").unwrap().offset, u64::MAX);
    assert_eq!(
        read("9007199254740993").unwrap().offset,
        9_007_199_254_740_992
    );
    assert_eq!(read("-0").unwrap().offset, 0);
    assert_eq!(
        failure(read("1e21")),
        invalid("invalid type: floating point `1e+21`, expected u64")
    );
    assert_eq!(
        failure(read("-0.5")),
        invalid("invalid type: floating point `-0.5`, expected u64")
    );
    let timeout = |value: &str| {
        wire_http::decode_request(&parse(&format!(
            r#"{{"method":"GET","url":"u","requestId":"r","timeoutMs":{value}}}"#
        )))
        .map(|params| params.timeout_ms)
    };
    assert_eq!(timeout("18446744073709551615").unwrap(), Some(u64::MAX));
    assert_eq!(timeout("0").unwrap(), Some(0));
    assert_eq!(timeout("null").unwrap(), None);
}

#[test]
fn process_read_bounds_sit_on_the_documented_edges() {
    let read = |fields: &str| {
        wire_base::decode_process_read(Some(&parse(&format!(r#"{{"processId":"p",{fields}}}"#))))
    };
    let message = |text: &str| invalid(&format!("Invalid params: {text}"));
    assert_eq!(
        read(r#""afterSeq":9007199254740991"#).unwrap().after_seq,
        Some(9_007_199_254_740_991)
    );
    assert_eq!(read(r#""afterSeq":1.0"#).unwrap().after_seq, Some(1));
    assert_eq!(
        failure(read(r#""afterSeq":9007199254740992"#)),
        message("invalid afterSeq")
    );
    assert_eq!(read(r#""maxBytes":0,"waitMs":0"#).unwrap().wait_ms, Some(0));
    assert_eq!(
        failure(read(r#""maxBytes":-1"#)),
        message("invalid maxBytes")
    );
    assert_eq!(failure(read(r#""waitMs":-1"#)), message("invalid waitMs"));
    assert_eq!(
        read(r#""afterSeq":null,"maxBytes":null,"waitMs":null"#)
            .unwrap()
            .max_bytes,
        None
    );
}

#[test]
fn results_encode_streams_sandbox_types_and_signed_values() {
    for (kind, name) in [
        (SandboxType::None, "none"),
        (SandboxType::MacosSeatbelt, "macosSeatbelt"),
        (SandboxType::LinuxSeccomp, "linuxSeccomp"),
        (
            SandboxType::WindowsRestrictedToken,
            "windowsRestrictedToken",
        ),
        (SandboxType::WindowsMxc, "windowsMxc"),
    ] {
        let encoded = wire_base::encode_exec_result(&ExecResult {
            process_id: Text::from("p"),
            sandbox_type: Presence::Value(kind),
        });
        assert_eq!(
            stringify_json(&encoded),
            format!(r#"{{"processId":"p","sandboxType":"{name}"}}"#)
        );
    }
    let null = wire_base::encode_exec_result(&ExecResult {
        process_id: units("p", &[HIGH], ""),
        sandbox_type: Presence::Null,
    });
    assert_eq!(
        stringify_json(&null),
        r#"{"processId":"p\ud800","sandboxType":null}"#
    );
    for (stream, name) in [
        (ProcessStream::Stdout, "stdout"),
        (ProcessStream::Stderr, "stderr"),
        (ProcessStream::Pty, "pty"),
    ] {
        let read = wire_base::encode_read_result(&ReadResult {
            chunks: vec![ProcessOutputChunk {
                seq: 0,
                stream,
                chunk: String::new(),
            }],
            next_seq: 1,
            exited: true,
            exit_code: Presence::Value(-1),
            closed: true,
            failure: Presence::Value("boom".into()),
            sandbox_denied: Some(true),
        });
        assert_eq!(
            stringify_json(&read),
            format!(
                r#"{{"chunks":[{{"seq":0,"stream":"{name}","chunk":""}}],"nextSeq":1,"exited":true,"exitCode":-1,"closed":true,"failure":"boom","sandboxDenied":true}}"#
            )
        );
    }
    let metadata = wire_base::encode_metadata_result(&FsGetMetadataResult {
        is_directory: true,
        is_file: false,
        is_symlink: true,
        size: 0,
        created_at_ms: -5,
        modified_at_ms: 9_007_199_254_740_991,
    });
    assert_eq!(
        stringify_json(&metadata),
        r#"{"isDirectory":true,"isFile":false,"isSymlink":true,"size":0,"createdAtMs":-5,"modifiedAtMs":9007199254740991}"#
    );
}

#[test]
fn process_events_and_policy_requests_keep_unpaired_surrogate_process_ids() {
    let (_, closed) = wire_process::encode_process_event(&ProcessEvent::Output {
        process_id: units("p", &[HIGH], ""),
        seq: 1,
        stream: ProcessStream::Stdout,
        chunk: Vec::new(),
    });
    assert_eq!(
        stringify_json(&closed),
        r#"{"processId":"p\ud800","seq":1,"stream":"stdout","chunk":""}"#
    );
    let request = wire_process::encode_network_policy_request(
        &units("p", &[LOW], ""),
        &policy_request("a.test"),
    );
    assert_eq!(
        stringify_json(&request),
        r#"{"processId":"p\udc00","request":{"protocol":"https_connect","host":"a.test","port":443}}"#
    );
}

#[test]
fn environment_info_shell_text_is_lossless() {
    let mut info = canonical_info();
    info.shell = ShellInfo {
        name: units("z", &[HIGH], "sh"),
        path: units("/bin/z", &[LOW], ""),
    };
    let encoded = wire_base::encode_environment_info(&info);
    assert_eq!(
        stringify_json(at(&encoded, "shell")),
        r#"{"name":"z\ud800sh","path":"/bin/z\udc00"}"#
    );
}

#[test]
fn network_decision_reasons_are_validated_by_their_encoded_length_but_kept_as_sent() {
    let decide = |reason: &str| {
        wire_process::decode_network_policy_response(&parse(&format!(
            r#"{{"decision":{{"type":"ask","reason":"{reason}"}}}}"#
        )))
    };
    assert_eq!(
        decide(r"half \ud800"),
        NetworkDecision::Ask {
            reason: units("half ", &[HIGH], "")
        }
    );
    let long = "x".repeat(1024);
    assert_eq!(
        decide(&long),
        NetworkDecision::Ask {
            reason: Text::from(long.as_str())
        }
    );
    let denied = NetworkDecision::Deny {
        reason: Text::from("not_allowed"),
    };
    assert_eq!(decide(&"x".repeat(1025)), denied);
    assert_eq!(decide(&r"\ud800".repeat(342)), denied);
}
