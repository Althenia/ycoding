use super::support::*;
use crate::dots::carrier::executor_rpc::core_adapter::CoreHandler;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::{
    cca::{
        error::{
            Attribution, AuthorizationDenied, AuthorizationInput, Authorize, BoxFuture,
            ExecutorError, Grant, ScopeContext,
        },
        executor::{
            EnvironmentOverrides, Executor, ExecutorAccess, ExecutorOptions, ExecutorScope,
            ScopeProvider,
        },
    },
    ycoding_schema::{JsonValue, stringify_json},
};

struct Authorizer(bool);
impl Authorize for Authorizer {
    fn authorize(
        &self,
        input: AuthorizationInput,
    ) -> BoxFuture<'static, Result<Grant, AuthorizationDenied>> {
        let allowed = self.0
            || !matches!(
                input.action.as_str(),
                "shell" | "read" | "edit" | "external_directory"
            );
        Box::pin(async move {
            if allowed {
                Ok(Grant::noop())
            } else {
                Err(AuthorizationDenied::default())
            }
        })
    }
}

struct Scope(String, bool);
impl ExecutorScope for Scope {
    fn session_id(&self) -> String {
        "ses_synthetic".to_owned()
    }
    fn roots(&self) -> Vec<String> {
        vec![self.0.clone()]
    }
    fn authorization(&self) -> Arc<dyn Authorize> {
        Arc::new(Authorizer(self.1))
    }
    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
}

struct Provider(String, bool);
impl ScopeProvider for Provider {
    fn scope_for(
        &self,
        _attribution: Option<Attribution>,
        _context: ScopeContext,
    ) -> BoxFuture<'_, Result<Arc<dyn ExecutorScope>, ExecutorError>> {
        let scope: Arc<dyn ExecutorScope> = Arc::new(Scope(self.0.clone(), self.1));
        Box::pin(async move { Ok(scope) })
    }
}

fn workspace() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    loop {
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let directory =
            std::env::temp_dir().join(format!("cca-rpc-core-{}-{sequence}", std::process::id()));
        match std::fs::create_dir(&directory) {
            Ok(()) => return std::fs::canonicalize(directory).unwrap(),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("failed to create fixture directory: {error}"),
        }
    }
}

fn uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

async fn served(root: &Path) -> Harness {
    let handler = Arc::new(CoreHandler::new(executor(
        root,
        true,
        ExecutorAccess::Ordinary,
    )));
    let harness = Harness::over(handler, Backend::new(), unadvertised_info_fn(), None);
    let response = harness
        .one(&request(1, "initialize", r#"{"clientName":"synthetic"}"#))
        .await;
    assert!(!has(&response, "error"), "{}", stringify_json(&response));
    assert!(harness.rpc(&notification("initialized")).await.is_empty());
    harness
}

fn executor(root: &Path, allow_shell: bool, access: ExecutorAccess) -> Executor {
    Executor::new_with_access(
        ExecutorOptions {
            scope_provider: Arc::new(Provider(root.to_string_lossy().into_owned(), allow_shell)),
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
            system_config_path: Some(root.join("etc/config.toml")),
            system_requirements_path: Some(root.join("etc/requirements.toml")),
            managed_config_path: Some(root.join("etc/managed_config.toml")),
        },
        access,
    )
}

fn result(response: &JsonValue) -> &JsonValue {
    assert!(!has(response, "error"), "{}", stringify_json(response));
    at(response, "result")
}

#[cfg(unix)]
mod admission {
    use super::*;
    use crate::dots::carrier::{
        executor_rpc::{core_adapter::session_backend, service},
        relay_tests::Harness as Relay,
        supervisor::{Diagnostics, Opened, Serve, ServeFailed, Sessions, Summary},
        test_support,
    };
    use std::sync::atomic::{AtomicU32, Ordering};

    const ENVIRONMENT: &str = "environment-fixture";
    const STREAM: &str = "authenticated-process-stream";

    struct Fixture(PathBuf);

    struct Connected {
        relay: Relay,
        serving: tokio::task::JoinHandle<Result<(), ServeFailed>>,
        sequence: AtomicU32,
    }

    impl Connected {
        async fn rpc(&self, id: u32, method: &str, params: &str) -> JsonValue {
            self.relay.message(
                STREAM,
                self.sequence.fetch_add(1, Ordering::Relaxed),
                request(i64::from(id), method, params).as_bytes(),
            );
            self.relay.response(STREAM, id).await
        }

        async fn close(self) {
            self.relay.close().await;
            self.serving.await.unwrap().unwrap();
        }
    }

    impl Fixture {
        fn new() -> Self {
            let root = workspace();
            std::fs::create_dir(root.join("work")).unwrap();
            std::fs::create_dir(root.join("work/etc")).unwrap();
            Self(root)
        }

        fn requirements(&self, modes: &str) {
            std::fs::write(self.0.join("work/etc/requirements.toml"), modes).unwrap();
        }

        fn serving(&self, allow_shell: bool) -> (Serve, Arc<Sessions>, Diagnostics) {
            let work = self.0.join("work");
            let diagnostics = Diagnostics::new(Arc::new(|_| {}));
            let (clock, _armed) = test_support::clock();
            let sessions = Sessions::new(Arc::new(clock), 5_000, diagnostics.clone());
            let serve = service::serve(Arc::new(move || {
                Ok(session_backend(executor(
                    &work,
                    allow_shell,
                    ExecutorAccess::UnrestrictedHost,
                )))
            }));
            (serve, sessions, diagnostics)
        }

        async fn connect(
            serve: &Serve,
            sessions: &Arc<Sessions>,
            diagnostics: &Diagnostics,
        ) -> Connected {
            let mut relay = Relay::standard();
            let channel = relay.open(STREAM).await;
            let serving = tokio::spawn(serve(Opened {
                channel,
                sessions: sessions.clone(),
                environment_id: ENVIRONMENT.into(),
                summary: Summary::default(),
                diagnostics: diagnostics.clone(),
            }));
            let params = r#"{"clientName":"synthetic"}"#;
            relay.message(STREAM, 0, request(1, "initialize", params).as_bytes());
            let response = relay.response(STREAM, 1).await;
            let initialized = result(&response);
            let capabilities = at(at(initialized, "environmentInfo"), "capabilities");
            for capability in [
                "networkProxyLaunch",
                "networkProxyReviewDomains",
                "credentialMasking",
                "credentialMaskingCustomProviders",
            ] {
                assert!(!has(capabilities, capability));
            }
            assert_eq!(
                at(capabilities, "environmentConfigRead"),
                &JsonValue::Bool(true)
            );
            relay.message(STREAM, 1, notification("initialized").as_bytes());
            let connected = Connected {
                relay,
                serving,
                sequence: AtomicU32::new(2),
            };
            let status = connected.rpc(90, "environment/status", "{}").await;
            assert_eq!(str_of(at(result(&status), "status")), "ready");
            connected
        }

        async fn start(
            &self,
            connected: &Connected,
            intent: &str,
        ) -> (JsonValue, Option<JsonValue>) {
            let params = format!(
                r#"{{"processId":"admission","argv":["/bin/sh","-c","test \"$YCODING_SESSION_ID\" = synthetic-session && test \"$CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE\" = synthetic-value && /usr/bin/id -u > host-user && printf launched > marker"],"cwd":"{}","env":{{"YCODING_SESSION_ID":"synthetic-session","CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE":"synthetic-value"}}{intent}}}"#,
                uri(&self.0),
            );
            let response = connected.rpc(2, "process/start", &params).await;
            let mut closed = None;
            if has(&response, "result") {
                for id in 3..13 {
                    let read = connected
                        .rpc(
                            id,
                            "process/read",
                            r#"{"processId":"admission","waitMs":500}"#,
                        )
                        .await;
                    if at(result(&read), "closed") == &JsonValue::Bool(true) {
                        closed = Some(read);
                        break;
                    }
                }
                assert!(closed.is_some(), "process did not finish");
            }
            (response, closed)
        }

        async fn assert_unrestricted(&self, intent: &str, fs_intent: &str, allow: bool) {
            let (serve, sessions, diagnostics) = self.serving(allow);
            let connected = Self::connect(&serve, &sessions, &diagnostics).await;
            let (response, closed) = self.start(&connected, intent).await;
            assert_eq!(str_of(at(result(&response), "sandboxType")), "none");
            assert_eq!(num_of(at(result(&closed.unwrap()), "exitCode")), 0.0);
            assert_eq!(
                std::fs::read_to_string(self.0.join("marker")).unwrap(),
                "launched"
            );
            let current_user = std::process::Command::new("/usr/bin/id")
                .arg("-u")
                .output()
                .unwrap();
            assert!(current_user.status.success());
            assert_eq!(
                std::fs::read(self.0.join("host-user")).unwrap(),
                current_user.stdout
            );
            let params = format!(r#"{{"path":"{}"{fs_intent}}}"#, uri(&self.0.join("marker")));
            let read = connected.rpc(13, "fs/readFile", &params).await;
            assert_eq!(str_of(at(result(&read), "dataBase64")), "bGF1bmNoZWQ=");
            let params = format!(
                r#"{{"handleId":"outside","path":"{}"{fs_intent}}}"#,
                uri(&self.0.join("marker"))
            );
            result(&connected.rpc(14, "fs/open", &params).await);
            let read = connected
                .rpc(
                    15,
                    "fs/readBlock",
                    r#"{"handleId":"outside","offset":0,"len":16}"#,
                )
                .await;
            assert_eq!(str_of(at(result(&read), "chunk")), "bGF1bmNoZWQ=");
            result(
                &connected
                    .rpc(16, "fs/close", r#"{"handleId":"outside"}"#)
                    .await,
            );
            connected.close().await;
            sessions.shutdown().await.unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[tokio::test]
    async fn authenticated_start_and_read_run_unrestricted_by_default() {
        Fixture::new().assert_unrestricted("", "", true).await;
    }

    #[tokio::test]
    async fn authenticated_start_and_read_ignore_sandbox_network_and_proxy_intent() {
        let sandbox = r#", "sandbox":{"permissions":{"type":"managed","network":"restricted","file_system":{"type":"restricted","entries":[]}}}"#;
        let process = format!(
            r#"{sandbox}, "enforceManagedNetwork":true, "managedNetwork":{{"loopbackPorts":[],"allowLocalBinding":false}}, "networkProxy":{{"proxy":{{"enabled":true,"mode":"limited","enableSocks5":false,"enableSocks5Udp":false,"allowUpstreamProxy":false,"dangerouslyAllowAllUnixSockets":false,"allowLocalBinding":false}},"auditMetadata":{{}}}}"#
        );
        Fixture::new()
            .assert_unrestricted(&process, sandbox, true)
            .await;
    }

    #[tokio::test]
    async fn authenticated_start_and_read_ignore_host_deployment_requirements() {
        let fixture = Fixture::new();
        fixture.requirements(r#"allowed_sandbox_modes = ["read-only"]"#);
        std::fs::write(
            fixture.0.join("work/etc/managed_config.toml"),
            r#"sandbox_mode = "read-only""#,
        )
        .unwrap();
        fixture.assert_unrestricted("", "", true).await;
    }

    #[tokio::test]
    async fn authenticated_start_and_read_skip_scope_authorization() {
        Fixture::new().assert_unrestricted("", "", false).await;
    }

    #[tokio::test]
    async fn authenticated_filesystem_writes_and_copies_outside_location_without_approval() {
        let fixture = Fixture::new();
        let (serve, sessions, diagnostics) = fixture.serving(false);
        let connected = Fixture::connect(&serve, &sessions, &diagnostics).await;
        let source = uri(&fixture.0.join("source"));
        let destination = uri(&fixture.0.join("destination"));
        for (id, method, params) in [
            (
                2,
                "fs/writeFile",
                format!(r#"{{"path":"{source}","dataBase64":"aGk="}}"#),
            ),
            (
                3,
                "fs/copy",
                format!(
                    r#"{{"sourcePath":"{source}","destinationPath":"{destination}","recursive":false}}"#
                ),
            ),
            (4, "fs/remove", format!(r#"{{"path":"{source}"}}"#)),
        ] {
            result(&connected.rpc(id, method, &params).await);
        }
        assert!(!fixture.0.join("source").exists());
        assert_eq!(std::fs::read(fixture.0.join("destination")).unwrap(), b"hi");
        connected.close().await;
        sessions.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn authenticated_process_input_signal_and_termination_skip_scope_authorization() {
        let fixture = Fixture::new();
        let (serve, sessions, diagnostics) = fixture.serving(false);
        let connected = Fixture::connect(&serve, &sessions, &diagnostics).await;
        let start = format!(
            r#"{{"processId":"controlled","argv":["/bin/sh","-c","IFS= read -r value; printf '%s' \"$value\" > control; IFS= read -r stop"],"cwd":"{}","env":{{}},"pipeStdin":true}}"#,
            uri(&fixture.0),
        );
        result(&connected.rpc(2, "process/start", &start).await);
        result(
            &connected
                .rpc(
                    3,
                    "process/write",
                    r#"{"processId":"controlled","writeId":"one","chunk":"aGVsbG8K"}"#,
                )
                .await,
        );
        result(
            &connected
                .rpc(
                    4,
                    "process/signal",
                    r#"{"processId":"controlled","signal":"interrupt"}"#,
                )
                .await,
        );
        result(
            &connected
                .rpc(5, "process/terminate", r#"{"processId":"controlled"}"#)
                .await,
        );
        connected.close().await;
        sessions.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn authenticated_start_still_requires_an_existing_working_directory() {
        let fixture = Fixture::new();
        let (serve, sessions, diagnostics) = fixture.serving(false);
        let connected = Fixture::connect(&serve, &sessions, &diagnostics).await;
        let file = fixture.0.join("regular-file");
        std::fs::write(&file, "not a directory").unwrap();
        for (id, path) in [(2, fixture.0.join("missing")), (3, file)] {
            let start = format!(
                r#"{{"processId":"invalid","argv":["/bin/sh","-c","exit 0"],"cwd":"{}","env":{{}}}}"#,
                uri(&path)
            );
            assert_eq!(
                error_code(&connected.rpc(id, "process/start", &start).await),
                -32603
            );
        }
        connected.close().await;
        sessions.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn environment_config_returns_projected_system_user_and_requirements_layers() {
    let root = workspace();
    let etc = root.join("etc");
    let codex_home = root.join(".codex");
    std::fs::create_dir_all(&etc).unwrap();
    std::fs::create_dir_all(&codex_home).unwrap();
    std::fs::write(etc.join("config.toml"), "sandbox_mode = \"read-only\"\n").unwrap();
    std::fs::write(
        etc.join("requirements.toml"),
        "allowed_sandbox_modes = [\"read-only\"]\n",
    )
    .unwrap();
    std::fs::write(
        codex_home.join("config.toml"),
        "sandbox_mode = \"workspace-write\"\nother = 1\n",
    )
    .unwrap();
    let harness = served(&root).await;
    let params = format!(
        r#"{{"cwd":"{}","configPaths":[["sandbox_mode"]],"requirementsPaths":[["allowed_sandbox_modes"]]}}"#,
        uri(&root)
    );
    let response = harness
        .one(&request(2, "environmentConfig/read", &params))
        .await;
    let document = result(&response);
    assert_eq!(str_of(at(document, "userHomeDir")), uri(&root));
    assert_eq!(str_of(at(document, "codexHomeDir")), uri(&codex_home));
    assert!(matches!(
        at(document, "hostname"),
        JsonValue::Null | JsonValue::String(_)
    ));
    let config = at(document, "config");
    assert_eq!(num_of(at(config, "cloudInsertionIndex")), 1.0);
    let JsonValue::Array(layers) = at(config, "layers") else {
        panic!("config layers missing")
    };
    assert_eq!(layers.len(), 2);
    assert_eq!(
        str_of(at(&layers[0], "source")),
        format!("system ({})", etc.join("config.toml").display())
    );
    assert_eq!(str_of(at(&layers[0], "baseDir")), uri(&etc));
    assert_eq!(
        str_of(at(&layers[0], "toml")),
        "sandbox_mode = \"read-only\"\n"
    );
    assert_eq!(
        str_of(at(&layers[1], "source")),
        format!("user ({})", codex_home.join("config.toml").display())
    );
    assert_eq!(str_of(at(&layers[1], "baseDir")), uri(&codex_home));
    assert_eq!(
        str_of(at(&layers[1], "toml")),
        "sandbox_mode = \"workspace-write\"\n"
    );
    let requirements = at(document, "requirements");
    assert_eq!(num_of(at(requirements, "cloudInsertionIndex")), 1.0);
    let JsonValue::Array(layers) = at(requirements, "layers") else {
        panic!("requirements layers missing")
    };
    assert_eq!(layers.len(), 1);
    assert_eq!(
        str_of(at(&layers[0], "source")),
        etc.join("requirements.toml").to_string_lossy()
    );
    assert_eq!(str_of(at(&layers[0], "baseDir")), uri(&etc));
    assert_eq!(
        str_of(at(&layers[0], "toml")),
        "allowed_sandbox_modes = [\"read-only\"]\n"
    );

    let invalid = format!(
        r#"{{"cwd":"{}","configPaths":[],"requirementsPaths":[]}}"#,
        uri(&root)
    );
    let response = harness
        .one(&request(26, "environmentConfig/read", &invalid))
        .await;
    assert_eq!(error_code(&response), -32602);
    assert!(!has(&response, "result"));
}

#[tokio::test]
async fn capability_roots_are_wrapped_and_manifest_text_is_returned_verbatim() {
    let root = workspace();
    let plugin = root.join("plugin");
    std::fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
    let manifest = "{\n  \"name\": \"demo\",\n  \"description\": \"Résumé — 日本語\",\n  \"futureField\": {\"nested\": [1, 2, {\"x\": null}]}\n}\n";
    std::fs::write(plugin.join(".codex-plugin/plugin.json"), manifest).unwrap();
    let harness = served(&root).await;
    let params = format!(
        r#"{{"roots":[{{"id":"root-1","path":"{}"}}]}}"#,
        uri(&plugin)
    );
    let response = harness
        .one(&request(3, "capabilityRoots/discoverV1", &params))
        .await;
    let roots = match at(result(&response), "roots") {
        JsonValue::Array(roots) => roots,
        other => panic!("roots is not an array: {}", stringify_json(other)),
    };
    assert_eq!(roots.len(), 1);
    assert_eq!(str_of(at(&roots[0], "id")), "root-1");
    assert_eq!(str_of(at(&roots[0], "path")), uri(&plugin));
    assert_eq!(at(&roots[0], "error"), &JsonValue::Null);
    let manifest_file = at(at(&roots[0], "plugin"), "manifest");
    assert_eq!(str_of(at(manifest_file, "contents")), manifest);
    assert!(str_of(at(manifest_file, "path")).ends_with("/.codex-plugin/plugin.json"));
    for field in ["skills", "namespaceManifests", "warnings"] {
        assert!(
            matches!(at(&roots[0], field), JsonValue::Array(_)),
            "{field}"
        );
    }
}

#[tokio::test]
async fn capability_discovery_v2_returns_the_skill_document_with_text_preserved() {
    let root = workspace();
    let skill = root.join(".agents/skills/demo");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: demo\ndescription: \"Résumé — 日本語 \\\"quoted\\\"\"\n---\nBody text.\n",
    )
    .unwrap();
    let harness = served(&root).await;
    let params = format!(r#"{{"cwd":"{}"}}"#, uri(&root));
    let response = harness
        .one(&request(4, "capabilities/discoverV2", &params))
        .await;
    let document = result(&response);
    for field in ["plugins", "skills", "warnings"] {
        assert!(
            matches!(at(document, field), JsonValue::Array(_)),
            "{field}"
        );
    }
    let JsonValue::Array(skills) = at(document, "skills") else {
        unreachable!()
    };
    let demo = skills
        .iter()
        .find(|skill| str_of(at(skill, "name")).ends_with("demo"))
        .unwrap_or_else(|| panic!("demo skill missing in {}", stringify_json(document)));
    assert_eq!(
        str_of(at(demo, "description")),
        "Résumé — 日本語 \"quoted\""
    );
    assert!(str_of(at(demo, "path")).ends_with("/SKILL.md"));
    for nullable in ["shortDescription", "dependencies", "policy"] {
        assert_eq!(at(demo, nullable), &JsonValue::Null, "{nullable}");
    }
}

#[tokio::test]
async fn filesystem_results_come_from_the_executor() {
    let root = workspace();
    let harness = served(&root).await;
    let file = root.join("note.txt");
    let path = uri(&file);
    let write = harness
        .one(&request(
            5,
            "fs/writeFile",
            &format!(r#"{{"path":"{path}","dataBase64":"aGk="}}"#),
        ))
        .await;
    assert_eq!(stringify_json(result(&write)), "{}");
    let read = harness
        .one(&request(
            6,
            "fs/readFile",
            &format!(r#"{{"path":"{path}"}}"#),
        ))
        .await;
    assert_eq!(stringify_json(result(&read)), r#"{"dataBase64":"aGk="}"#);
    let metadata = harness
        .one(&request(
            7,
            "fs/getMetadata",
            &format!(r#"{{"path":"{path}"}}"#),
        ))
        .await;
    let metadata = result(&metadata);
    assert_eq!(at(metadata, "isFile"), &JsonValue::Bool(true));
    assert_eq!(num_of(at(metadata, "size")), 2.0);
    let listing = harness
        .one(&request(
            8,
            "fs/readDirectory",
            &format!(r#"{{"path":"{}"}}"#, uri(&root)),
        ))
        .await;
    let JsonValue::Array(entries) = at(result(&listing), "entries") else {
        panic!("entries missing")
    };
    assert!(
        entries
            .iter()
            .any(|entry| str_of(at(entry, "fileName")) == "note.txt")
    );
    let missing = harness
        .one(&request(
            9,
            "fs/readFile",
            &format!(r#"{{"path":"{}"}}"#, uri(&root.join("absent.txt"))),
        ))
        .await;
    assert_eq!(error_code(&missing), -32004);
    assert!(!has(&missing, "result"));
}

#[tokio::test]
async fn connection_file_streaming_results_come_from_the_executor() {
    let root = workspace();
    std::fs::write(root.join("blob.bin"), b"hi").unwrap();
    let harness = served(&root).await;
    let path = uri(&root.join("blob.bin"));
    let opened = harness
        .one(&request(
            10,
            "fs/open",
            &format!(r#"{{"handleId":"h1","path":"{path}"}}"#),
        ))
        .await;
    assert_eq!(stringify_json(result(&opened)), r#"{"handleId":"h1"}"#);
    let block = harness
        .one(&request(
            11,
            "fs/readBlock",
            r#"{"handleId":"h1","offset":0,"len":16}"#,
        ))
        .await;
    assert_eq!(str_of(at(result(&block), "chunk")), "aGk=");
    assert_eq!(at(result(&block), "eof"), &JsonValue::Bool(true));
    let closed = harness
        .one(&request(12, "fs/close", r#"{"handleId":"h1"}"#))
        .await;
    assert_eq!(stringify_json(result(&closed)), "{}");
}

#[cfg(unix)]
#[tokio::test]
async fn process_ids_and_output_keep_their_text_through_the_executor() {
    let root = workspace();
    let harness = served(&root).await;
    let start = format!(
        r#"{{"processId":"p\ud800","argv":["/bin/sh","-c","printf '%s,%s' \"$B_ONE\" \"$A_TWO\"; exit 7"],"cwd":"{}","env":{{"B_ONE":"1","A_TWO":"2"}}}}"#,
        uri(&root)
    );
    let started = harness.one(&request(13, "process/start", &start)).await;
    assert!(stringify_json(result(&started)).contains(r#""processId":"p\ud800""#));
    let mut chunks = Vec::new();
    let mut after_seq = 0;
    let mut exited = false;
    let mut closed = false;
    let mut exit_code = None;
    for _ in 0..20 {
        let read = harness
            .one(&request(
                14,
                "process/read",
                &format!(r#"{{"processId":"p\ud800","afterSeq":{after_seq},"waitMs":5000}}"#),
            ))
            .await;
        let read = result(&read).clone();
        let JsonValue::Array(batch) = at(&read, "chunks") else {
            panic!("chunks missing")
        };
        after_seq = batch
            .last()
            .map(|chunk| num_of(at(chunk, "seq")) as u64)
            .unwrap_or(after_seq);
        chunks.extend(batch.iter().cloned());
        exited = at(&read, "exited") == &JsonValue::Bool(true);
        if matches!(at(&read, "exitCode"), JsonValue::Number(_)) {
            exit_code = Some(num_of(at(&read, "exitCode")));
        }
        closed = at(&read, "closed") == &JsonValue::Bool(true);
        if closed {
            break;
        }
    }
    assert!(closed);
    assert!(exited);
    assert_eq!(exit_code, Some(7.0));
    let stdout = chunks
        .iter()
        .filter(|chunk| str_of(at(chunk, "stream")) == "stdout")
        .map(|chunk| str_of(at(chunk, "chunk")))
        .collect::<Vec<_>>();
    assert_eq!(stdout, ["MSwy"]);
}

#[tokio::test]
async fn capability_root_ids_keep_unpaired_surrogates_end_to_end() {
    let root = workspace();
    let harness = served(&root).await;
    let params = format!(
        r#"{{"roots":[{{"id":"root\ud800","path":"{}"}}]}}"#,
        uri(&root)
    );
    let response = harness
        .one(&request(20, "capabilityRoots/discoverV1", &params))
        .await;
    let JsonValue::Array(roots) = at(result(&response), "roots") else {
        panic!("roots missing")
    };
    assert_eq!(stringify_json(at(&roots[0], "id")), r#""root\ud800""#);
}

#[tokio::test]
async fn connection_handle_ids_keep_unpaired_surrogates_end_to_end() {
    let root = workspace();
    std::fs::write(root.join("blob.bin"), b"hi").unwrap();
    let harness = served(&root).await;
    let path = uri(&root.join("blob.bin"));
    let opened = harness
        .one(&request(
            21,
            "fs/open",
            &format!(r#"{{"handleId":"h\ud800","path":"{path}"}}"#),
        ))
        .await;
    assert_eq!(stringify_json(result(&opened)), r#"{"handleId":"h\ud800"}"#);
    let block = harness
        .one(&request(
            22,
            "fs/readBlock",
            r#"{"handleId":"h\ud800","offset":0,"len":8}"#,
        ))
        .await;
    assert_eq!(str_of(at(result(&block), "chunk")), "aGk=");
    let other = harness
        .one(&request(
            23,
            "fs/readBlock",
            r#"{"handleId":"h\ufffd","offset":0,"len":8}"#,
        ))
        .await;
    assert!(
        has(&other, "error"),
        "a different handle id must not alias the lone surrogate id"
    );
    let closed = harness
        .one(&request(24, "fs/close", r#"{"handleId":"h\ud800"}"#))
        .await;
    assert_eq!(stringify_json(result(&closed)), "{}");
}

#[tokio::test]
async fn environment_config_reads_user_toml_through_the_real_executor() {
    let root = workspace();
    std::fs::create_dir_all(root.join(".codex")).unwrap();
    std::fs::write(
        root.join(".codex/config.toml"),
        "model = \"gpt\"\nother = 1\n",
    )
    .unwrap();
    let harness = served(&root).await;
    let params = format!(
        r#"{{"cwd":"{}","configPaths":[["model"]],"requirementsPaths":[["rule"]]}}"#,
        uri(&root)
    );
    let response = harness
        .one(&request(25, "environmentConfig/read", &params))
        .await;
    let document = result(&response);
    for field in [
        "userHomeDir",
        "codexHomeDir",
        "hostname",
        "config",
        "requirements",
    ] {
        assert!(has(document, field), "{field}");
    }
    assert_eq!(str_of(at(document, "userHomeDir")), uri(&root));
    assert_eq!(
        str_of(at(document, "codexHomeDir")),
        format!("{}/.codex", uri(&root))
    );
    let JsonValue::Array(layers) = at(at(document, "config"), "layers") else {
        panic!("layers missing")
    };
    let user = layers
        .iter()
        .find(|layer| str_of(at(layer, "source")).starts_with("user ("))
        .unwrap_or_else(|| panic!("user layer missing in {}", stringify_json(document)));
    assert!(str_of(at(user, "toml")).contains("model = \"gpt\""));
    assert!(!str_of(at(user, "toml")).contains("other"));
    assert!(matches!(
        at(at(document, "requirements"), "layers"),
        JsonValue::Array(_)
    ));
}
