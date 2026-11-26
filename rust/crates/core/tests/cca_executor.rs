use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use ycoding_core::cca::{
    environment_config::{
        EnvironmentConfigLayer, EnvironmentConfigLayerStack, EnvironmentConfigReadParams,
        EnvironmentConfigReadResult,
    },
    error::{
        Attribution, AuthorizationDenied, AuthorizationInput, Authorize, BoxFuture, ExecutorError,
        Grant, ScopeContext,
    },
    executor::{
        CreateDirectoryResult, EnvironmentOverrides, ExecParams, Executor, ExecutorOptions,
        ExecutorScope, FsPathParams, FsReadFileParams, FsWriteFileParams, InitializeContext,
        InitializeParams, Notifier, OutputStream, ReadParams, ScopeProvider, TerminateParams,
    },
    signal::{HandlerContext, Signal},
    value::{LosslessString, Value, parse_json, stringify_json},
};

struct Policy {
    allow: fn(&str) -> bool,
    seen: Mutex<Vec<String>>,
}

#[tokio::test]
async fn grant_release_failure_is_canonical_once_and_preserves_the_action_error() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use ycoding_core::cca::error::run_with_grant;

    let releases = Arc::new(AtomicUsize::new(0));
    let observed = releases.clone();
    let grant = Grant::new(vec![], move || {
        Box::pin(async move {
            observed.fetch_add(1, Ordering::SeqCst);
            Err(())
        })
    });
    assert_eq!(
        grant.release().await.unwrap_err(),
        ExecutorError::internal()
    );
    grant.release().await.unwrap();
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    for succeeds in [true, false] {
        let observed = releases.clone();
        let grant = Grant::new(vec![], move || {
            Box::pin(async move {
                observed.fetch_add(1, Ordering::SeqCst);
                Err(())
            })
        });
        let action_error = ExecutorError::new(-32602, "synthetic action failure");
        let expected = if succeeds {
            ExecutorError::internal()
        } else {
            action_error.clone()
        };
        let result = run_with_grant(grant, async move {
            if succeeds { Ok(()) } else { Err(action_error) }
        })
        .await;
        assert_eq!(result.unwrap_err(), expected);
    }
    assert_eq!(releases.load(Ordering::SeqCst), 3);
}
impl Authorize for Policy {
    fn authorize(
        &self,
        input: AuthorizationInput,
    ) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>> {
        let resources = input
            .resources
            .iter()
            .map(|r| r.as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join(" ");
        self.seen
            .lock()
            .unwrap()
            .push(format!("{} {}", input.action, resources));
        let allow = (self.allow)(&input.action);
        Box::pin(async move {
            if allow {
                Ok(Grant::noop())
            } else {
                Err(AuthorizationDenied::default())
            }
        })
    }
}
struct Scope {
    root: String,
    policy: Arc<Policy>,
}
impl ExecutorScope for Scope {
    fn session_id(&self) -> String {
        "ses_synthetic".to_owned()
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
    policy: Arc<Policy>,
}
impl ScopeProvider for Provider {
    fn scope_for(
        &self,
        _attribution: Option<Attribution>,
        _context: ScopeContext,
    ) -> BoxFuture<'_, Result<Arc<dyn ExecutorScope>, ExecutorError>> {
        let scope: Arc<dyn ExecutorScope> = Arc::new(Scope {
            root: self.root.clone(),
            policy: self.policy.clone(),
        });
        Box::pin(async move { Ok(scope) })
    }
}

fn workspace() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("cca-executor-test-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::canonicalize(directory).unwrap()
}
fn uri(path: &std::path::Path) -> String {
    format!("file://{}", path.display())
}
async fn executor(
    allow: fn(&str) -> bool,
    root: &std::path::Path,
) -> (
    Executor,
    HandlerContext,
    Arc<Policy>,
    Arc<Mutex<Vec<(String, Value)>>>,
) {
    let policy = Arc::new(Policy {
        allow,
        seen: Mutex::new(vec![]),
    });
    let executor = Executor::new(ExecutorOptions {
        scope_provider: Arc::new(Provider {
            root: root.to_string_lossy().into_owned(),
            policy: policy.clone(),
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
        home_directory: root.to_path_buf(),
        data_directory: root.join("data"),
        codex_home_env: None,
        system_config_path: None,
        system_requirements_path: None,
        managed_config_path: None,
    });
    let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(vec![]));
    let sink = events.clone();
    let notify: Notifier = Arc::new(move |method, params| {
        sink.lock().unwrap().push((method, params));
        Box::pin(async {})
    });
    let signal = Signal::default();
    let session = executor
        .initialize(
            InitializeParams {
                client_name: "synthetic".into(),
            },
            InitializeContext {
                signal: signal.clone(),
                notify: Some(notify),
                call: None,
            },
        )
        .await
        .unwrap();
    (
        executor,
        HandlerContext {
            signal,
            session_id: session.session_id,
        },
        policy,
        events,
    )
}

#[tokio::test]
async fn environment_config_uses_explicit_requirements_and_managed_paths() {
    let root = workspace();
    let requirements = root.join("requirements.toml");
    let managed = root.join("managed_config.toml");
    let executor = Executor::new(ExecutorOptions {
        scope_provider: Arc::new(Provider {
            root: root.to_string_lossy().into_owned(),
            policy: Arc::new(Policy {
                allow: |_| true,
                seen: Mutex::new(vec![]),
            }),
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
        system_config_path: Some(root.join("system-config.toml")),
        system_requirements_path: Some(requirements.clone()),
        managed_config_path: Some(managed.clone()),
    });
    let ctx = HandlerContext {
        signal: Signal::default(),
        session_id: "synthetic".to_owned(),
    };
    let params = EnvironmentConfigReadParams {
        cwd: uri(&root),
        config_paths: vec![vec!["sandbox_mode".into()]],
        requirements_paths: vec![
            vec!["allowed_approval_policies".into()],
            vec!["allowed_approvals_reviewers".into()],
            vec!["allowed_sandbox_modes".into()],
        ],
    };
    let empty = EnvironmentConfigLayerStack {
        layers: vec![],
        cloud_insertion_index: 0,
    };
    let expected = |config, requirements| {
        EnvironmentConfigReadResult {
            user_home_dir: Some(uri(&root)),
            codex_home_dir: uri(&root.join(".codex")),
            hostname: None,
            config,
            requirements,
        }
        .to_json()
    };
    let assert_stacks = |actual: Value, expected: Value| {
        let (Value::Object(actual), Value::Object(expected)) = (actual, expected) else {
            panic!("config result is an object")
        };
        for key in ["userHomeDir", "codexHomeDir", "config", "requirements"] {
            assert_eq!(
                actual.get(&LosslessString::from(key)),
                expected.get(&LosslessString::from(key))
            );
        }
    };
    assert_stacks(
        executor
            .read_environment_config(params.clone(), &ctx)
            .await
            .unwrap(),
        expected(empty.clone(), empty),
    );

    std::fs::write(&requirements, "allowed_sandbox_modes = [\"read-only\"]\n").unwrap();
    std::fs::write(&managed, "approval_policy = \"on-failure\"\napprovals_reviewer = \"guardian_subagent\"\nsandbox_mode = \"workspace-write\"\nmodel = \"synthetic\"\n").unwrap();
    let layer = |source: String, toml: &str| EnvironmentConfigLayer {
        source,
        base_dir: uri(&root),
        toml: toml.to_owned(),
    };
    let config = EnvironmentConfigLayerStack {
        layers: vec![layer(
            format!("legacy managed_config.toml ({})", managed.display()),
            "sandbox_mode = \"workspace-write\"\n",
        )],
        cloud_insertion_index: 0,
    };
    let requirements_stack = EnvironmentConfigLayerStack {
        layers: vec![
            layer(
                requirements.display().to_string(),
                "allowed_sandbox_modes = [\"read-only\"]\n",
            ),
            layer(
                managed.display().to_string(),
                "allowed_approval_policies = [\"on-request\"]\nallowed_approvals_reviewers = [\"auto_review\", \"user\"]\nallowed_sandbox_modes = [\"read-only\", \"workspace-write\"]\n",
            ),
        ],
        cloud_insertion_index: 1,
    };
    assert_stacks(
        executor
            .read_environment_config(params, &ctx)
            .await
            .unwrap(),
        expected(config, requirements_stack),
    );
}

#[tokio::test]
async fn file_round_trip_stays_inside_roots_and_authorizes_each_use() {
    let root = workspace();
    let (executor, ctx, policy, _) = executor(|_| true, &root).await;
    let file = root.join("note.txt");
    executor
        .write_file(
            FsWriteFileParams {
                path: uri(&file),
                data: b"hello".to_vec(),
                follow_symlinks: None,
                sandbox: None,
            },
            &ctx,
        )
        .await
        .unwrap();
    let read = executor
        .read_file(
            FsReadFileParams {
                path: uri(&file),
                follow_symlinks: None,
                sandbox: None,
            },
            &ctx,
        )
        .await
        .unwrap();
    assert_eq!(read, b"hello");
    assert!(
        policy
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| entry.starts_with("edit ") || entry.starts_with("read "))
            .count()
            >= 2
    );
    let outside = std::env::temp_dir().join("cca-outside-synthetic.txt");
    let error = executor
        .read_file(
            FsReadFileParams {
                path: uri(&outside),
                follow_symlinks: None,
                sandbox: None,
            },
            &ctx,
        )
        .await
        .unwrap_err();
    assert!(error.code == -32600 || error.code == -32004 || error.code == -32001);
    executor.close().await.unwrap();
}

#[tokio::test]
async fn denied_authorization_blocks_filesystem_access() {
    let root = workspace();
    let (executor, ctx, _, _) = executor(|_| false, &root).await;
    std::fs::write(root.join("secret.txt"), b"x").unwrap();
    let error = executor
        .read_file(
            FsReadFileParams {
                path: uri(&root.join("secret.txt")),
                follow_symlinks: None,
                sandbox: None,
            },
            &ctx,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, -32001);
    let error = executor
        .get_metadata(
            FsPathParams {
                path: uri(&root.join("secret.txt")),
                follow_symlinks: None,
                sandbox: None,
            },
            &ctx,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, -32001);
}

#[cfg(unix)]
#[tokio::test]
async fn sandboxed_start_reports_the_refusing_check_without_running_the_command() {
    let root = workspace();
    let outside = workspace();
    let allowed = root.join("allowed");
    std::fs::create_dir(&allowed).unwrap();
    let mut diagnostics = Vec::new();
    for (id, cwd, profile_root, expected_actions) in [
        ("profile", &root, &allowed, vec![]),
        ("roots", &outside, &allowed, vec![]),
        ("external", &outside, &outside, vec!["external_directory"]),
        ("shell", &root, &root, vec!["shell"]),
    ] {
        let (executor, ctx, policy, _) = executor(|action| action == "read", &root).await;
        let sandbox = parse_json(
            &serde_json::json!({
                "cwd": uri(profile_root),
                "permissions": {"type": "managed", "network": "restricted", "file_system": {
                    "type": "restricted", "entries": []
                }}
            })
            .to_string(),
        )
        .unwrap();
        executor
            .start_process(
                ExecParams {
                    process_id: id.into(),
                    argv: vec!["/bin/echo".into()],
                    cwd: uri(cwd).into(),
                    sandbox: Some(sandbox),
                    ..Default::default()
                },
                &ctx,
            )
            .await
            .unwrap();
        assert_eq!(
            policy
                .seen
                .lock()
                .unwrap()
                .iter()
                .map(|call| call.split_once(' ').unwrap().0)
                .collect::<Vec<_>>(),
            expected_actions,
            "{id}"
        );
        let read = executor
            .read_process(
                ReadParams {
                    process_id: id.into(),
                    after_seq: None,
                    max_bytes: None,
                    wait_ms: None,
                },
                &ctx,
            )
            .await
            .unwrap();
        assert!(read.sandbox_denied && read.closed);
        assert_eq!(read.exit_code, Some(1));
        assert_eq!(read.chunks.len(), 1);
        assert_eq!(read.chunks[0].stream, OutputStream::Stderr);
        diagnostics.push(String::from_utf8(read.chunks.into_iter().next().unwrap().chunk).unwrap());
        executor.close().await.unwrap();
    }
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir(outside).unwrap();
    assert_eq!(
        diagnostics,
        [
            "sandbox denied: the requested sandbox profile does not permit reading the working directory\n",
            "sandbox denied: the working directory is outside the permitted roots\n",
            "sandbox denied: Permission denied: external directory access was not granted\n",
            "sandbox denied: Permission denied: shell access was not granted\n",
        ]
    );
}

#[tokio::test]
async fn create_directory_reports_created_then_existing() {
    let root = workspace();
    let (executor, ctx, _, _) = executor(|_| true, &root).await;
    let target = uri(&root.join("made"));
    assert!(matches!(
        executor.create_directory(&target, &ctx).await.unwrap(),
        CreateDirectoryResult::Created { .. }
    ));
    assert_eq!(
        executor.create_directory(&target, &ctx).await.unwrap(),
        CreateDirectoryResult::Existing
    );
}

#[cfg(unix)]
#[tokio::test]
async fn process_output_exit_code_and_environment_order_are_preserved() {
    let root = workspace();
    let (executor, ctx, _, events) = executor(|_| true, &root).await;
    let id = LosslessString::from("proc-1");
    let script = "printf '%s,%s' \"$B_ONE\" \"$A_TWO\"; exit 7";
    let env = vec![
        (LosslessString::from("B_ONE"), LosslessString::from("1")),
        (LosslessString::from("A_TWO"), LosslessString::from("2")),
    ];
    let result = executor
        .start_process(
            ExecParams {
                process_id: id.clone(),
                argv: ["/bin/sh", "-c", script]
                    .into_iter()
                    .map(LosslessString::from)
                    .collect(),
                cwd: LosslessString::from(uri(&root).as_str()),
                env,
                ..Default::default()
            },
            &ctx,
        )
        .await
        .unwrap();
    assert_eq!(result.process_id, id);
    let mut output = vec![];
    let mut exit_code = None;
    let mut after_seq = None;
    for _ in 0..50 {
        let read = executor
            .read_process(
                ReadParams {
                    process_id: id.clone(),
                    after_seq,
                    max_bytes: None,
                    wait_ms: Some(200),
                },
                &ctx,
            )
            .await
            .unwrap();
        after_seq = read.chunks.last().map(|chunk| chunk.seq).or(after_seq);
        let stdout: Vec<u8> = read
            .chunks
            .iter()
            .filter(|chunk| chunk.stream == OutputStream::Stdout)
            .flat_map(|chunk| chunk.chunk.clone())
            .collect();
        output.extend(stdout);
        if read.closed {
            exit_code = read.exit_code;
            break;
        }
    }
    assert_eq!(String::from_utf8(output).unwrap(), "1,2");
    assert_eq!(exit_code, Some(7));
    let methods = events
        .lock()
        .unwrap()
        .iter()
        .map(|(method, _)| method.clone())
        .collect::<Vec<_>>();
    assert!(
        methods.contains(&"process/exited".to_owned())
            && methods.contains(&"process/closed".to_owned())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn terminate_stops_a_running_process_and_close_releases_everything() {
    let root = workspace();
    let (executor, ctx, _, _) = executor(|_| true, &root).await;
    let id = LosslessString::from("proc-sleep");
    executor
        .start_process(
            ExecParams {
                process_id: id.clone(),
                argv: vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                cwd: LosslessString::from(uri(&root).as_str()),
                ..Default::default()
            },
            &ctx,
        )
        .await
        .unwrap();
    assert!(
        executor
            .terminate_process(
                TerminateParams {
                    process_id: id.clone()
                },
                &ctx
            )
            .await
            .unwrap()
            .running
    );
    let mut closed = false;
    let mut after_seq = None;
    for _ in 0..40 {
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
        closed = read.closed;
        if closed {
            break;
        }
    }
    assert!(closed);
    executor.close().await.unwrap();
    let error = executor
        .read_file(
            FsReadFileParams {
                path: uri(&root),
                follow_symlinks: None,
                sandbox: None,
            },
            &ctx,
        )
        .await
        .unwrap_err();
    assert_eq!(error.message, "Executor session closed".into());
}

#[tokio::test]
async fn environment_info_advertises_the_fixed_capability_set_as_lossless_json() {
    let root = workspace();
    let (executor, _, _, _) = executor(|_| true, &root).await;
    let info = executor.environment_info();
    let reparsed = parse_json(&stringify_json(&info.to_json())).unwrap();
    assert_eq!(reparsed, info.to_json());
    assert_eq!(info.capabilities.capability_discovery_v2, Some(true));
    assert_eq!(info.capabilities.environment_config_read, Some(true));
    assert_eq!(
        info.capabilities.shell_snapshot_v2,
        Some(cfg!(not(windows)))
    );
}

#[test]
fn opaque_values_keep_unpaired_surrogates_and_key_order() {
    let source = "{\"b\":\"\\ud800\",\"a\":1}";
    let parsed = parse_json(source).unwrap();
    assert_eq!(stringify_json(&parsed), source);
}

#[tokio::test]
async fn signal_cancellation_wakes_waiters_and_linked_signals_release_their_forwarders() {
    let first = Signal::default();
    let second = Signal::default();
    let linked = Signal::any(&[first.clone(), second.clone()]);
    let waiting = tokio::spawn({
        let signal = linked.signal();
        async move { signal.cancelled().await }
    });
    first.cancel();
    tokio::time::timeout(Duration::from_secs(1), waiting)
        .await
        .unwrap()
        .unwrap();
    assert!(linked.signal().is_cancelled() && !second.is_cancelled());
    drop(linked);
}

use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;
use ycoding_core::cca::executor::ReadResult;
use ycoding_core::cca::value::object_get;

struct CountingProvider {
    inner: Provider,
    opened: Arc<AtomicUsize>,
}
impl ScopeProvider for CountingProvider {
    fn scope_for(
        &self,
        attribution: Option<Attribution>,
        context: ScopeContext,
    ) -> BoxFuture<'_, Result<Arc<dyn ExecutorScope>, ExecutorError>> {
        self.opened.fetch_add(1, Ordering::SeqCst);
        self.inner.scope_for(attribution, context)
    }
}

struct Observed {
    executor: Executor,
    ctx: HandlerContext,
    policy: Arc<Policy>,
    events: Arc<Mutex<Vec<(String, Value)>>>,
    arrived: Arc<Notify>,
    opened: Arc<AtomicUsize>,
}

async fn observed_executor(root: &std::path::Path) -> Observed {
    let policy = Arc::new(Policy {
        allow: |_| true,
        seen: Mutex::new(vec![]),
    });
    let opened = Arc::new(AtomicUsize::new(0));
    let executor = Executor::new(ExecutorOptions {
        scope_provider: Arc::new(CountingProvider {
            inner: Provider {
                root: root.to_string_lossy().into_owned(),
                policy: policy.clone(),
            },
            opened: opened.clone(),
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
        home_directory: root.to_path_buf(),
        data_directory: root.join("data"),
        codex_home_env: None,
        system_config_path: None,
        system_requirements_path: None,
        managed_config_path: None,
    });
    let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(vec![]));
    let arrived = Arc::new(Notify::new());
    let sink = events.clone();
    let wake = arrived.clone();
    let notify: Notifier = Arc::new(move |method, params| {
        sink.lock().unwrap().push((method, params));
        wake.notify_one();
        Box::pin(async {})
    });
    let signal = Signal::default();
    let session = executor
        .initialize(
            InitializeParams {
                client_name: "synthetic".into(),
            },
            InitializeContext {
                signal: signal.clone(),
                notify: Some(notify),
                call: None,
            },
        )
        .await
        .unwrap();
    Observed {
        executor,
        ctx: HandlerContext {
            signal,
            session_id: session.session_id,
        },
        policy,
        events,
        arrived,
        opened,
    }
}

fn names_process(params: &Value, id: &LosslessString) -> bool {
    let Value::Object(object) = params else {
        return false;
    };
    object_get(object, "processId") == Some(&Value::String(id.clone()))
}

fn process_events(
    events: &Mutex<Vec<(String, Value)>>,
    id: &LosslessString,
) -> Vec<(String, Value)> {
    let mut matched = vec![];
    for (method, params) in events.lock().unwrap().iter() {
        if method.starts_with("process/") && names_process(params, id) {
            matched.push((method.clone(), params.clone()));
        }
    }
    matched
}

async fn closed_event_arrived(observed: &Observed, id: &LosslessString) {
    loop {
        let events = process_events(&observed.events, id);
        if events.iter().any(|(method, _)| method == "process/closed") {
            return;
        }
        tokio::time::timeout(Duration::from_secs(10), observed.arrived.notified())
            .await
            .expect("process/closed was not published within the bound");
    }
}

async fn read_all(observed: &Observed, id: &LosslessString) -> ReadResult {
    let params = ReadParams {
        process_id: id.clone(),
        after_seq: None,
        max_bytes: None,
        wait_ms: None,
    };
    observed
        .executor
        .read_process(params, &observed.ctx)
        .await
        .unwrap()
}

fn number_field(params: &Value, key: &str) -> f64 {
    let Value::Object(object) = params else {
        panic!("event params are an object")
    };
    let Some(Value::Number(number)) = object_get(object, key) else {
        panic!("event field {key} is a number")
    };
    *number
}

fn position_of(methods: &[&str], wanted: &str) -> usize {
    methods.iter().position(|m| *m == wanted).unwrap()
}

fn count_of(methods: &[&str], wanted: &str) -> usize {
    methods.iter().filter(|m| **m == wanted).count()
}

fn only_output(methods: &[&str]) -> bool {
    methods.iter().all(|m| *m == "process/output")
}

fn shell_params(id: &LosslessString, root: &std::path::Path, script: &str) -> ExecParams {
    ExecParams {
        process_id: id.clone(),
        argv: ["/bin/sh", "-c", script]
            .into_iter()
            .map(LosslessString::from)
            .collect(),
        cwd: LosslessString::from(uri(root).as_str()),
        ..Default::default()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn dots_request_metadata_cannot_bypass_working_directory_scope() {
    let root = workspace();
    let scope = root.join("scope");
    let outside = root.join("outside");
    std::fs::create_dir(&scope).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let (executor, ctx, _, _) = executor(|_| true, &scope).await;
    let mut params = shell_params(&"spoof".into(), &outside, "printf launched > marker");
    params.metadata = Some(parse_json(r#"{"scope":"outside"}"#).unwrap());
    params.env = vec![("CODEX_SANDBOX_MODE".into(), "danger-full-access".into())];
    let error = executor.start_process(params, &ctx).await.unwrap_err();
    assert_eq!(
        error.message.as_str(),
        Some("Operation not permitted (os error 1)")
    );
    assert!(!outside.join("marker").exists());
    executor.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn stdout_and_stderr_drain_completely_before_exited_and_closed_publish() {
    let root = workspace();
    let observed = observed_executor(&root).await;
    let id = LosslessString::from("proc-both-pipes");
    let script = [
        "printf out-a",
        "printf err-a >&2",
        "head -c 70000 /dev/zero | tr '\\0' x",
        "head -c 70000 /dev/zero | tr '\\0' y >&2",
        "printf out-z",
        "printf err-z >&2",
        "exit 3",
    ]
    .join("; ");
    let params = shell_params(&id, &root, &script);
    observed
        .executor
        .start_process(params, &observed.ctx)
        .await
        .unwrap();
    closed_event_arrived(&observed, &id).await;

    let outcome = read_all(&observed, &id).await;
    assert!(outcome.exited && outcome.closed);
    assert_eq!(outcome.exit_code, Some(3));
    let stream_bytes = |wanted: OutputStream| {
        outcome
            .chunks
            .iter()
            .filter(|chunk| chunk.stream == wanted)
            .flat_map(|chunk| chunk.chunk.clone())
            .collect::<Vec<u8>>()
    };
    let stdout = stream_bytes(OutputStream::Stdout);
    let stderr = stream_bytes(OutputStream::Stderr);
    let total: usize = outcome.chunks.iter().map(|c| c.chunk.len()).sum();
    let expected_stdout = format!("out-a{}out-z", "x".repeat(70000));
    let expected_stderr = format!("err-a{}err-z", "y".repeat(70000));
    assert!(stdout == expected_stdout.as_bytes());
    assert!(stderr == expected_stderr.as_bytes());
    assert_eq!(stdout.len() + stderr.len(), total);

    let events = process_events(&observed.events, &id);
    let names = events.iter().map(|(method, _)| method.as_str());
    let methods = names.collect::<Vec<_>>();
    let exited_at = position_of(&methods, "process/exited");
    let closed_at = position_of(&methods, "process/closed");
    assert_eq!(count_of(&methods, "process/exited"), 1);
    assert_eq!(count_of(&methods, "process/closed"), 1);
    assert_eq!(closed_at, methods.len() - 1);
    assert_eq!(exited_at, closed_at - 1);
    assert!(only_output(&methods[..exited_at]));
    assert_eq!(exited_at, outcome.chunks.len());
    let exited = &events[exited_at].1;
    let last_chunk = outcome.chunks.last().unwrap();
    let exited_seq = number_field(exited, "seq");
    let closed_seq = number_field(&events[closed_at].1, "seq");
    assert_eq!(number_field(exited, "exitCode"), 3.0);
    assert!(exited_seq > last_chunk.seq as f64);
    assert_eq!(closed_seq, exited_seq + 1.0);
}

#[cfg(unix)]
#[tokio::test]
async fn tty_is_rejected_before_scope_authorization_spawn_or_notifications() {
    let root = workspace();
    let observed = observed_executor(&root).await;
    let id = LosslessString::from("proc-tty");
    let mut params = shell_params(&id, &root, "printf unreachable");
    params.tty = true;
    let error = observed
        .executor
        .start_process(params, &observed.ctx)
        .await
        .unwrap_err();
    assert_eq!(error.code, -32602);
    assert_eq!(error.message, "tty is unsupported".into());
    assert_eq!(observed.opened.load(Ordering::SeqCst), 0);
    assert!(observed.policy.seen.lock().unwrap().is_empty());
    assert!(process_events(&observed.events, &id).is_empty());

    let params = shell_params(&id, &root, "printf ok; exit 5");
    observed
        .executor
        .start_process(params, &observed.ctx)
        .await
        .unwrap();
    closed_event_arrived(&observed, &id).await;
    let outcome = read_all(&observed, &id).await;
    assert!(outcome.closed);
    assert_eq!(outcome.exit_code, Some(5));
    let bytes: Vec<u8> = outcome
        .chunks
        .iter()
        .flat_map(|chunk| chunk.chunk.clone())
        .collect();
    assert_eq!(bytes, b"ok".to_vec());
    assert_eq!(observed.opened.load(Ordering::SeqCst), 1);
}
