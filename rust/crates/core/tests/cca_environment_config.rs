use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_core::cca::{
    environment_config::{
        EnvironmentConfigLayer, EnvironmentConfigLayerStack, EnvironmentConfigOptions,
        EnvironmentConfigReadParams, EnvironmentConfigReadResult, read_environment_config,
        require_full_access,
    },
    error::ExecutorError,
    value::{LosslessString, Value, parse_json},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "cca-env-config-{}-{stamp}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&directory).unwrap();
        Self(fs::canonicalize(directory).unwrap())
    }
}

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn put(file: &Path, contents: &str) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, contents).unwrap();
}

fn uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

fn options(base: &Path) -> EnvironmentConfigOptions {
    EnvironmentConfigOptions {
        home_directory: base.join("home"),
        system_config_path: Some(base.join("etc").join("config.toml")),
        system_requirements_path: Some(base.join("etc").join("requirements.toml")),
        managed_config_path: Some(base.join("etc").join("managed_config.toml")),
        hostname: Some(Arc::new(|| "Synthetic-Host.".to_owned())),
        ..Default::default()
    }
}

fn lossless(paths: &[&[&str]]) -> Vec<Vec<LosslessString>> {
    paths
        .iter()
        .map(|path| {
            path.iter()
                .map(|segment| LosslessString::from(*segment))
                .collect()
        })
        .collect()
}

async fn read_with(
    cwd: &Path,
    config: &[&[&str]],
    requirements: &[&[&str]],
    options: &EnvironmentConfigOptions,
) -> Result<EnvironmentConfigReadResult, ExecutorError> {
    let params = EnvironmentConfigReadParams {
        cwd: uri(cwd),
        config_paths: lossless(config),
        requirements_paths: lossless(requirements),
    };
    read_environment_config(params, options).await
}

async fn read(
    base: &Path,
    cwd: &Path,
    config: &[&[&str]],
    requirements: &[&[&str]],
) -> Result<EnvironmentConfigReadResult, ExecutorError> {
    read_with(cwd, config, requirements, &options(base)).await
}

fn message(error: &ExecutorError) -> String {
    String::from_utf16_lossy(&error.message.code_units().collect::<Vec<_>>())
}

fn user_layer(codex_home: &Path, toml: &str) -> EnvironmentConfigLayer {
    EnvironmentConfigLayer {
        source: format!("user ({})", codex_home.join("config.toml").display()),
        base_dir: uri(codex_home),
        toml: toml.to_owned(),
    }
}

fn project_layer(dir: &Path, toml: &str) -> EnvironmentConfigLayer {
    EnvironmentConfigLayer {
        source: format!("project ({}/config.toml)", dir.join(".codex").display()),
        base_dir: uri(&dir.join(".codex")),
        toml: toml.to_owned(),
    }
}

fn stack(
    layers: Vec<EnvironmentConfigLayer>,
    cloud_insertion_index: usize,
) -> EnvironmentConfigLayerStack {
    EnvironmentConfigLayerStack {
        layers,
        cloud_insertion_index,
    }
}

fn trusted(dirs: &[&Path]) -> String {
    dirs.iter()
        .map(|dir| {
            format!(
                "[projects.\"{}\"]\ntrust_level = \"trusted\"\n",
                dir.display()
            )
        })
        .collect()
}

#[tokio::test]
async fn no_config_files_answer_empty_stacks_with_the_executor_homes_and_hostname() {
    let base = Scratch::new();
    let home = base.join("home");
    let result = read(&base, &home, &[&["sandbox_mode"]], &[&["mcp_servers"]])
        .await
        .unwrap();
    assert_eq!(
        result,
        EnvironmentConfigReadResult {
            user_home_dir: Some(uri(&home)),
            codex_home_dir: uri(&home.join(".codex")),
            hostname: Some("synthetic-host".to_owned()),
            config: stack(vec![], 0),
            requirements: stack(vec![], 0),
        }
    );
    let expected = format!(
        "{{\"userHomeDir\":\"{}\",\"codexHomeDir\":\"{}\",\"hostname\":\"synthetic-host\",\"config\":{{\"layers\":[],\"cloudInsertionIndex\":0}},\"requirements\":{{\"layers\":[],\"cloudInsertionIndex\":0}}}}",
        uri(&home),
        uri(&home.join(".codex"))
    );
    assert_eq!(result.to_json(), parse_json(&expected).unwrap());
}

#[tokio::test]
async fn result_json_carries_layers_in_the_wire_shape_and_key_order() {
    let base = Scratch::new();
    let codex_home = base.join("home").join(".codex");
    put(
        &codex_home.join("config.toml"),
        "sandbox_mode = \"read-only\"\n",
    );
    let result = read(&base, &base.join("home"), &[&["sandbox_mode"]], &[])
        .await
        .unwrap();
    let Value::Object(object) = result.to_json() else {
        panic!("result is a JSON object");
    };
    let keys: Vec<String> = object
        .iter()
        .map(|(key, _)| key.to_utf8().unwrap())
        .collect();
    assert_eq!(
        keys,
        [
            "userHomeDir",
            "codexHomeDir",
            "hostname",
            "config",
            "requirements"
        ]
    );
    let expected = format!(
        "{{\"source\":\"user ({})\",\"baseDir\":\"{}\",\"toml\":\"sandbox_mode = \\\"read-only\\\"\\n\"}}",
        codex_home.join("config.toml").display(),
        uri(&codex_home)
    );
    let Some(Value::Object(config)) = object.get(&LosslessString::from("config")) else {
        panic!("config is a JSON object");
    };
    assert_eq!(
        config.get(&LosslessString::from("layers")),
        Some(&Value::Array(vec![parse_json(&expected).unwrap()]))
    );
}

#[tokio::test]
async fn a_user_config_layer_keeps_only_the_requested_paths() {
    let base = Scratch::new();
    let codex_home = base.join("home").join(".codex");
    put(
        &codex_home.join("config.toml"),
        "[mcp_servers.synthetic]\ncommand = \"/synthetic/bin/server\"\nargs = []\n\n[shell_environment_policy]\ninherit = \"all\"\n",
    );
    let result = read(
        &base,
        &base.join("home"),
        &[&["mcp_servers"]],
        &[&["mcp_servers"]],
    )
    .await
    .unwrap();
    assert_eq!(
        result.config,
        stack(
            vec![user_layer(
                &codex_home,
                "[mcp_servers.synthetic]\ncommand = \"/synthetic/bin/server\"\nargs = []\n"
            )],
            0
        )
    );
    assert!(
        read(&base, &base.join("home"), &[&["absent"]], &[])
            .await
            .unwrap()
            .config
            .layers
            .is_empty()
    );
}

#[tokio::test]
async fn trusted_project_layers_load_from_the_project_root_to_cwd_sanitized_and_untrusted_projects_are_skipped()
 {
    let base = Scratch::new();
    let repo = base.join("repo");
    let other = base.join("other");
    let nomark = base.join("nomark");
    let codex_home = base.join("home").join(".codex");
    put(
        &codex_home.join("config.toml"),
        &format!(
            "sandbox_mode = \"workspace-write\"\n[projects.\"{}\"]\ntrust_level = \"trusted\"\n[projects.\"{}\"]\ntrust_level = \"untrusted\"\n[projects.\"{}\"]\ntrust_level = \"trusted\"\n",
            repo.display(),
            other.display(),
            nomark.display()
        ),
    );
    put(&repo.join(".git").join("HEAD"), "ref: refs/heads/main\n");
    put(
        &repo.join(".codex").join("config.toml"),
        "sandbox_mode = \"read-only\"\nmodel_provider = \"x\"\nopenai_base_url = \"y\"\n[features]\ncredential_masking = true\nkeep = 1\n",
    );
    put(
        &repo.join("pkg").join(".codex").join("config.toml"),
        "sandbox_mode = \"danger-full-access\"\n",
    );
    fs::create_dir_all(repo.join("pkg").join("deep")).unwrap();
    put(&other.join(".git").join("HEAD"), "ref: x\n");
    put(
        &other.join(".codex").join("config.toml"),
        "sandbox_mode = \"read-only\"\n",
    );
    put(
        &nomark.join(".codex").join("config.toml"),
        "sandbox_mode = \"read-only\"\n",
    );
    let user = user_layer(&codex_home, "sandbox_mode = \"workspace-write\"\n");

    let nested = read(
        &base,
        &repo.join("pkg").join("deep"),
        &[&["sandbox_mode"], &["model_provider"], &["features"]],
        &[&["sandbox_mode"]],
    )
    .await
    .unwrap();
    assert_eq!(
        nested.config,
        stack(
            vec![
                user.clone(),
                project_layer(
                    &repo,
                    "sandbox_mode = \"read-only\"\n\n[features]\nkeep = 1\n"
                ),
                project_layer(&repo.join("pkg"), "sandbox_mode = \"danger-full-access\"\n"),
            ],
            0
        )
    );
    assert_eq!(nested.requirements, stack(vec![], 0));
    assert_eq!(
        read(&base, &other, &[&["sandbox_mode"]], &[])
            .await
            .unwrap()
            .config
            .layers,
        vec![user.clone()]
    );
    assert_eq!(
        read(&base, &nomark, &[&["sandbox_mode"]], &[])
            .await
            .unwrap()
            .config
            .layers,
        vec![
            user.clone(),
            project_layer(&nomark, "sandbox_mode = \"read-only\"\n")
        ]
    );
    assert_eq!(
        read(
            &base,
            &base.join("missing").join("dir"),
            &[&["sandbox_mode"]],
            &[]
        )
        .await
        .unwrap()
        .config
        .layers,
        vec![user]
    );
}

#[tokio::test]
async fn system_config_and_requirements_layers_set_the_cloud_insertion_index() {
    let base = Scratch::new();
    put(
        &base.join("etc").join("config.toml"),
        "sandbox_mode = \"read-only\"\n",
    );
    put(
        &base.join("etc").join("requirements.toml"),
        "allowed_sandbox_modes = [\"read-only\"]\n",
    );
    put(
        &base.join("home").join(".codex").join("config.toml"),
        "sandbox_mode = \"workspace-write\"\n",
    );
    let result = read(
        &base,
        &base.join("home"),
        &[&["sandbox_mode"]],
        &[&["allowed_sandbox_modes"]],
    )
    .await
    .unwrap();
    assert_eq!(result.config.cloud_insertion_index, 1);
    let sources: Vec<String> = result
        .config
        .layers
        .iter()
        .map(|layer| layer.source.clone())
        .collect();
    assert_eq!(
        sources,
        [
            format!(
                "system ({})",
                base.join("etc").join("config.toml").display()
            ),
            format!(
                "user ({})",
                base.join("home")
                    .join(".codex")
                    .join("config.toml")
                    .display()
            )
        ]
    );
    assert_eq!(
        result.requirements,
        stack(
            vec![EnvironmentConfigLayer {
                source: base
                    .join("etc")
                    .join("requirements.toml")
                    .display()
                    .to_string(),
                base_dir: uri(&base.join("etc")),
                toml: "allowed_sandbox_modes = [\"read-only\"]\n".to_owned(),
            }],
            1
        )
    );
}

#[tokio::test]
async fn bad_paths_and_unreadable_configuration_answer_the_upstream_error_codes() {
    let base = Scratch::new();
    let home = base.join("home");
    let error = read(&base, &home, &[], &[]).await.unwrap_err();
    assert_eq!(
        (error.code, message(&error)),
        (
            -32602,
            "at least one config or requirements path is required".to_owned()
        )
    );
    let error = read(&base, &home, &[&[]], &[]).await.unwrap_err();
    assert_eq!(
        (error.code, message(&error)),
        (
            -32602,
            "TOML paths must contain at least one key segment".to_owned()
        )
    );
    let params = EnvironmentConfigReadParams {
        cwd: "relative".to_owned(),
        config_paths: lossless(&[&["a"]]),
        requirements_paths: vec![],
    };
    let error = read_environment_config(params, &options(&base))
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, message(&error)),
        (
            -32602,
            "path must be a file:// URI without query, fragment, or backslashes".to_owned()
        )
    );

    put(&home.join(".codex").join("config.toml"), "bad = = 1\n");
    let error = read(&base, &home, &[&["bad"]], &[]).await.unwrap_err();
    assert_eq!(error.code, -32603);
    assert_eq!(
        message(&error),
        format!(
            "failed to load executor-local config: {}:1:7: invalid value",
            home.join(".codex").join("config.toml").display()
        )
    );

    let missing = base.join("nope");
    let with_missing_home = EnvironmentConfigOptions {
        codex_home_env: Some(missing.display().to_string()),
        ..options(&base)
    };
    let error = read_with(&home, &[&["a"]], &[], &with_missing_home)
        .await
        .unwrap_err();
    assert_eq!(error.code, -32603);
    assert_eq!(
        message(&error),
        format!(
            "failed to find Codex home: CODEX_HOME points to {}, but that path does not exist",
            serde_json::Value::String(missing.display().to_string())
        )
    );
    put(&base.join("plain-file"), "x");
    let plain = base.join("plain-file");
    let with_file_home = EnvironmentConfigOptions {
        codex_home_env: Some(plain.display().to_string()),
        ..options(&base)
    };
    let error = read_with(&home, &[&["a"]], &[], &with_file_home)
        .await
        .unwrap_err();
    assert_eq!(
        message(&error),
        format!(
            "failed to find Codex home: CODEX_HOME points to {}, but that path is not a directory",
            serde_json::Value::String(plain.display().to_string())
        )
    );
}

#[tokio::test]
async fn codex_home_environment_directory_replaces_the_default_codex_home() {
    let base = Scratch::new();
    let custom = base.join("custom-codex");
    put(
        &custom.join("config.toml"),
        "sandbox_mode = \"read-only\"\n",
    );
    let with_home = EnvironmentConfigOptions {
        codex_home_env: Some(custom.display().to_string()),
        ..options(&base)
    };
    let result = read_with(&base.join("home"), &[&["sandbox_mode"]], &[], &with_home)
        .await
        .unwrap();
    assert_eq!(result.codex_home_dir, uri(&custom));
    assert_eq!(
        result.config,
        stack(
            vec![user_layer(&custom, "sandbox_mode = \"read-only\"\n")],
            0
        )
    );
}

#[tokio::test]
async fn syntax_errors_in_every_configuration_file_fail_with_path_line_and_column() {
    let base = Scratch::new();
    let home = base.join("home");
    for (file, label) in [
        (base.join("etc").join("config.toml"), "system"),
        (base.join("etc").join("managed_config.toml"), "managed"),
        (base.join("etc").join("requirements.toml"), "requirements"),
    ] {
        put(&file, "bad = = 1\n");
        let error = read(&base, &home, &[&["unselected"]], &[&["unselected"]])
            .await
            .unwrap_err();
        assert_eq!(error.code, -32603, "{label}");
        assert_eq!(
            message(&error),
            format!(
                "failed to load executor-local config: {}:1:7: invalid value",
                file.display()
            ),
            "{label}"
        );
        fs::remove_file(&file).unwrap();
    }
}

#[tokio::test]
async fn discovery_settings_reject_invalid_types() {
    let base = Scratch::new();
    let home = base.join("home");
    let user = home.join(".codex").join("config.toml");
    for (source, expected) in [
        (
            "project_root_markers = [1]\n",
            "project_root_markers must be an array of strings",
        ),
        (
            "project_root_markers = \"x\"\n",
            "project_root_markers must be an array of strings",
        ),
        ("projects = 1\n", "invalid type: projects, expected a map"),
        (
            "[projects]\nx = 1\n",
            "invalid type: projects.x, expected a map",
        ),
        (
            "[projects.x]\ntrust_level = \"maybe\"\n",
            "unknown variant for projects.x.trust_level, expected `trusted` or `untrusted`",
        ),
    ] {
        put(&user, source);
        let error = read(&base, &home, &[&["unselected"]], &[])
            .await
            .unwrap_err();
        assert_eq!(
            message(&error),
            format!("failed to load executor-local config: {expected}"),
            "{source}"
        );
    }
}

#[tokio::test]
async fn managed_config_becomes_a_legacy_requirements_layer_after_the_system_requirements() {
    let base = Scratch::new();
    let etc = base.join("etc");
    let home = base.join("home");
    put(
        &etc.join("requirements.toml"),
        "allowed_sandbox_modes = [\"read-only\"]\n",
    );
    put(
        &etc.join("managed_config.toml"),
        "approval_policy = \"on-failure\"\napprovals_reviewer = \"guardian_subagent\"\nsandbox_mode = \"workspace-write\"\nmodel = \"synthetic\"\n",
    );
    let requirements_paths: [&[&str]; 3] = [
        &["allowed_approval_policies"],
        &["allowed_approvals_reviewers"],
        &["allowed_sandbox_modes"],
    ];
    let result = read(&base, &home, &[&["sandbox_mode"]], &requirements_paths)
        .await
        .unwrap();
    assert_eq!(
        result.requirements,
        stack(
            vec![
                EnvironmentConfigLayer {
                    source: etc.join("requirements.toml").display().to_string(),
                    base_dir: uri(&etc),
                    toml: "allowed_sandbox_modes = [\"read-only\"]\n".to_owned(),
                },
                EnvironmentConfigLayer {
                    source: etc.join("managed_config.toml").display().to_string(),
                    base_dir: uri(&etc),
                    toml: "allowed_approval_policies = [\"on-request\"]\nallowed_approvals_reviewers = [\"auto_review\", \"user\"]\nallowed_sandbox_modes = [\"read-only\", \"workspace-write\"]\n".to_owned(),
                },
            ],
            1
        )
    );
    assert_eq!(
        result.config.layers,
        vec![EnvironmentConfigLayer {
            source: format!(
                "legacy managed_config.toml ({})",
                etc.join("managed_config.toml").display()
            ),
            base_dir: uri(&etc),
            toml: "sandbox_mode = \"workspace-write\"\n".to_owned(),
        }]
    );

    fs::remove_file(etc.join("requirements.toml")).unwrap();
    put(
        &etc.join("managed_config.toml"),
        "approval_policy = { granular = { sandbox_approval = true, rules = false, mcp_elicitations = true } }\nsandbox_mode = \"read-only\"\n",
    );
    assert_eq!(
        read(&base, &home, &[&["sandbox_mode"]], &requirements_paths).await.unwrap().requirements,
        stack(
            vec![EnvironmentConfigLayer {
                source: etc.join("managed_config.toml").display().to_string(),
                base_dir: uri(&etc),
                toml: "allowed_sandbox_modes = [\"read-only\"]\n\n[[allowed_approval_policies]]\n\n[allowed_approval_policies.granular]\nsandbox_approval = true\nrules = false\nskill_approval = false\nrequest_permissions = false\nmcp_elicitations = true\n".to_owned(),
            }],
            0
        )
    );

    put(
        &etc.join("managed_config.toml"),
        "approval_policy = \"sometimes\"\n",
    );
    let error = read(&base, &home, &[&["sandbox_mode"]], &requirements_paths)
        .await
        .unwrap_err();
    assert_eq!(error.code, -32603);
    assert_eq!(
        message(&error),
        "failed to load executor-local config: Failed to parse config requirements as TOML: unknown variant `sometimes` for `approval_policy`, expected one of `untrusted`, `on-request`, `on-failure`, `granular`, `never`"
    );

    put(
        &etc.join("managed_config.toml"),
        "approval_policy = { granular = { rules = false } }\n",
    );
    let error = read(&base, &home, &[&["sandbox_mode"]], &requirements_paths)
        .await
        .unwrap_err();
    assert_eq!(
        message(&error),
        "failed to load executor-local config: Failed to parse config requirements as TOML: missing field `sandbox_approval`"
    );

    put(&etc.join("managed_config.toml"), "sandbox_mode = 3\n");
    let error = read(&base, &home, &[&["sandbox_mode"]], &requirements_paths)
        .await
        .unwrap_err();
    assert_eq!(
        message(&error),
        "failed to load executor-local config: Failed to parse config requirements as TOML: invalid type integer for `sandbox_mode`, expected one of `read-only`, `workspace-write`, `danger-full-access`"
    );
}

#[tokio::test]
async fn full_access_admission_enforces_system_and_managed_sandbox_requirements() {
    let base = Scratch::new();
    let requirements = base.join("etc/requirements.toml");
    let managed = base.join("etc/managed_config.toml");
    let options = options(&base);
    assert!(require_full_access(&options).await.is_ok());
    for (contents, allowed) in [
        ("allowed_sandbox_modes = [\"danger-full-access\"]\n", true),
        (
            "allowed_sandbox_modes = [\"read-only\", \"danger-full-access\"]\n",
            true,
        ),
        ("allowed_sandbox_modes = [\"read-only\"]\n", false),
        ("allowed_sandbox_modes = []\n", false),
        ("allowed_sandbox_modes = \"danger-full-access\"\n", false),
        (
            "allowed_sandbox_modes = [\"danger-full-access\", \"unknown\"]\n",
            false,
        ),
        (
            "allowed_sandbox_modes = [\"danger-full-access\", 1]\n",
            false,
        ),
        ("bad = = 1\n", false),
    ] {
        put(&requirements, contents);
        assert_eq!(
            require_full_access(&options).await.is_ok(),
            allowed,
            "{contents}"
        );
    }
    put(
        &requirements,
        "allowed_sandbox_modes = [\"danger-full-access\"]\n",
    );
    for (contents, allowed) in [
        ("sandbox_mode = \"danger-full-access\"\n", true),
        ("sandbox_mode = \"workspace-write\"\n", false),
        ("sandbox_mode = \"read-only\"\n", false),
        ("sandbox_mode = \"unknown\"\n", false),
        ("sandbox_mode = 1\n", false),
        ("bad = = 1\n", false),
    ] {
        put(&managed, contents);
        assert_eq!(
            require_full_access(&options).await.is_ok(),
            allowed,
            "{contents}"
        );
    }
    put(&managed, "sandbox_mode = \"danger-full-access\"\n");
    put(&requirements, "allowed_sandbox_modes = [\"read-only\"]\n");
    assert!(require_full_access(&options).await.is_err());
    fs::remove_file(&requirements).unwrap();
    fs::create_dir(&requirements).unwrap();
    assert!(require_full_access(&options).await.is_err());
    fs::remove_dir(&requirements).unwrap();
    put(
        &managed,
        "sandbox_mode = \"synthetic-unrecognized-value\"\n",
    );
    let error = require_full_access(&options).await.unwrap_err();
    let message = error.message.as_str().unwrap();
    assert!(message.contains("managed_config.toml"));
    assert!(!message.contains("synthetic-unrecognized-value"));
}

const BROKER_ENABLED: &str = "[features.network_proxy]\ncredential_broker = true\nenabled = true\n[features.network_proxy.credentials.custom]\nenv = [\"CUSTOM_KEY\"]\nurl_prefix_from_env = \"CUSTOM_URL\"\n";
const PROJECT_SHELL: &str = "[shell_environment_policy]\nexperimental_use_profile = true\ninherit = \"all\"\n[shell_environment_policy.set]\nBASH_ENV = \"x\"\nzdotdir = \"y\"\nGH_TOKEN = \"z\"\nCUSTOM_KEY = \"w\"\nCUSTOM_URL = \"u\"\nOPENAI_BASE_URL = \"o\"\nKEEP = \"v\"\n[tui.keymap.chat]\nprevious_permission_mode = \"a\"\nnext_permission_mode = \"b\"\nother = \"c\"\n";

#[tokio::test]
async fn trusted_project_config_cannot_inject_a_shell_environment_while_the_credential_broker_is_enabled()
 {
    let base = Scratch::new();
    let repo = base.join("repo");
    put(
        &base.join("home").join(".codex").join("config.toml"),
        &format!("{BROKER_ENABLED}{}", trusted(&[&repo])),
    );
    put(&repo.join(".git").join("HEAD"), "ref: refs/heads/main\n");
    put(&repo.join(".codex").join("config.toml"), PROJECT_SHELL);
    let enabled = read(
        &base,
        &repo,
        &[&["shell_environment_policy"], &["tui"]],
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        enabled.config.layers,
        vec![project_layer(
            &repo,
            "[shell_environment_policy]\ninherit = \"all\"\n\n[shell_environment_policy.set]\nKEEP = \"v\"\n\n[tui.keymap.chat]\nother = \"c\"\n"
        )]
    );

    put(
        &base.join("home").join(".codex").join("config.toml"),
        &trusted(&[&repo]),
    );
    let unconfigured = read(
        &base,
        &repo,
        &[&["shell_environment_policy"], &["tui"]],
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        unconfigured.config.layers,
        vec![project_layer(
            &repo,
            "[shell_environment_policy]\nexperimental_use_profile = true\ninherit = \"all\"\n\n[shell_environment_policy.set]\nBASH_ENV = \"x\"\nzdotdir = \"y\"\nGH_TOKEN = \"z\"\nCUSTOM_KEY = \"w\"\nCUSTOM_URL = \"u\"\nOPENAI_BASE_URL = \"o\"\nKEEP = \"v\"\n\n[tui.keymap.chat]\nother = \"c\"\n"
        )]
    );
}

#[tokio::test]
async fn a_boolean_network_proxy_feature_merges_with_a_later_table_when_deciding_the_broker_state()
{
    let base = Scratch::new();
    let repo = base.join("repo");
    put(
        &base.join("etc").join("config.toml"),
        "[features]\nnetwork_proxy = true\n",
    );
    put(
        &base.join("home").join(".codex").join("config.toml"),
        &format!(
            "[features.network_proxy]\ncredential_broker = true\n{}",
            trusted(&[&repo])
        ),
    );
    put(&repo.join(".git").join("HEAD"), "ref: refs/heads/main\n");
    put(
        &repo.join(".codex").join("config.toml"),
        "[shell_environment_policy.set]\nBASH_ENV = \"x\"\nKEEP = \"v\"\n",
    );
    let result = read(&base, &repo, &[&["shell_environment_policy"]], &[])
        .await
        .unwrap();
    assert_eq!(
        result.config.layers,
        vec![project_layer(
            &repo,
            "[shell_environment_policy.set]\nKEEP = \"v\"\n"
        )]
    );
}

fn worktree_fixture(base: &Path) -> (PathBuf, PathBuf) {
    let main = base.join("main");
    let wt = base.join("wt");
    put(
        &base.join("home").join(".codex").join("config.toml"),
        &trusted(&[&main]),
    );
    put(&main.join(".git").join("HEAD"), "ref: refs/heads/main\n");
    put(
        &main.join(".git").join("worktrees").join("wt").join("HEAD"),
        "ref: refs/heads/wt\n",
    );
    put(
        &main
            .join(".git")
            .join("worktrees")
            .join("wt")
            .join("commondir"),
        "../..\n",
    );
    put(
        &main
            .join(".git")
            .join("worktrees")
            .join("wt")
            .join("gitdir"),
        &format!("{}/.git\n", wt.display()),
    );
    put(
        &wt.join(".git"),
        &format!("gitdir: {}/.git/worktrees/wt\n", main.display()),
    );
    put(
        &main.join(".codex").join("config.toml"),
        "sandbox_mode = \"read-only\"\n[hooks]\nmain = 1\n",
    );
    put(
        &main.join("sub").join(".codex").join("config.toml"),
        "[hooks]\nsub = 1\n",
    );
    put(
        &wt.join(".codex").join("config.toml"),
        "sandbox_mode = \"workspace-write\"\n[hooks]\nwt = 1\n",
    );
    fs::create_dir_all(wt.join("sub").join(".codex")).unwrap();
    fs::create_dir_all(wt.join("sub").join("deep")).unwrap();
    (main, wt)
}

#[tokio::test]
async fn linked_worktrees_take_hooks_from_the_matching_root_checkout_layer_and_forged_pointers_gain_no_trust()
 {
    let base = Scratch::new();
    let (main, wt) = worktree_fixture(&base);
    let result = read(
        &base,
        &wt.join("sub").join("deep"),
        &[&["sandbox_mode"], &["hooks"]],
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        result.config.layers,
        vec![
            project_layer(&wt, "sandbox_mode = \"workspace-write\"\n"),
            project_layer(&main, "[hooks]\nmain = 1\n"),
            project_layer(&main.join("sub"), "[hooks]\nsub = 1\n"),
        ]
    );

    let forged = base.join("forged");
    put(
        &forged.join(".git"),
        &format!("gitdir: {}/.git/worktrees/wt\n", main.display()),
    );
    put(
        &forged.join(".codex").join("config.toml"),
        "sandbox_mode = \"danger-full-access\"\n",
    );
    assert!(
        read(&base, &forged, &[&["sandbox_mode"], &["hooks"]], &[])
            .await
            .unwrap()
            .config
            .layers
            .is_empty()
    );
}

#[tokio::test]
async fn malformed_hooks_in_the_root_checkout_and_trusted_project_config_fail_with_labelled_errors()
{
    let base = Scratch::new();
    let (main, wt) = worktree_fixture(&base);
    let hooks_file = main.join(".codex").join("config.toml");
    put(&hooks_file, "bad = = 1\n");
    let error = read(&base, &wt, &[&["hooks"]], &[]).await.unwrap_err();
    assert_eq!(error.code, -32603);
    assert_eq!(
        message(&error),
        format!(
            "failed to load executor-local config: Error parsing project hooks config file {}: 1:7: invalid value",
            hooks_file.display()
        )
    );

    let project_file = wt.join(".codex").join("config.toml");
    put(&project_file, "bad = = 1\n");
    let error = read(&base, &wt, &[&["hooks"]], &[]).await.unwrap_err();
    assert_eq!(
        message(&error),
        format!(
            "failed to load executor-local config: Error parsing project config file {}: 1:7: invalid value",
            project_file.display()
        )
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_codex_folder_reached_through_a_symlink_loads_as_a_project_layer() {
    let base = Scratch::new();
    let linked = base.join("linked");
    put(
        &base.join("home").join(".codex").join("config.toml"),
        &trusted(&[&linked]),
    );
    put(&linked.join(".git").join("HEAD"), "ref: x\n");
    put(
        &base.join("real-codex").join("config.toml"),
        "sandbox_mode = \"read-only\"\n",
    );
    std::os::unix::fs::symlink(base.join("real-codex"), linked.join(".codex")).unwrap();
    assert_eq!(
        read(&base, &linked, &[&["sandbox_mode"]], &[])
            .await
            .unwrap()
            .config
            .layers,
        vec![project_layer(&linked, "sandbox_mode = \"read-only\"\n")]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn untrusted_project_config_is_still_read_so_read_errors_fail_and_parse_errors_are_ignored() {
    use std::os::unix::fs::PermissionsExt;
    let base = Scratch::new();
    let untrusted = base.join("untrusted");
    put(
        &base.join("home").join(".codex").join("config.toml"),
        &format!(
            "[projects.\"{}\"]\ntrust_level = \"untrusted\"\n",
            untrusted.display()
        ),
    );
    put(&untrusted.join(".git").join("HEAD"), "ref: x\n");
    let file = untrusted.join(".codex").join("config.toml");
    put(&file, "sandbox_mode = 'read-only'\n");
    if unsafe { libc::geteuid() } != 0 {
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        let outcome = read(&base, &untrusted, &[&["sandbox_mode"]], &[]).await;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        let error = outcome.unwrap_err();
        assert_eq!(error.code, -32603);
        assert_eq!(
            message(&error),
            format!(
                "failed to load executor-local config: Failed to read project config file {}: Permission denied (os error 13)",
                file.display()
            )
        );
    }
    put(&file, "bad = = 1\n");
    assert!(
        read(&base, &untrusted, &[&["sandbox_mode"], &["bad"]], &[])
            .await
            .unwrap()
            .config
            .layers
            .is_empty()
    );
}

async fn broker_setup(user: &str, requirements: Option<&str>) -> (Scratch, PathBuf) {
    let base = Scratch::new();
    let repo = base.join("repo");
    put(
        &base.join("home").join(".codex").join("config.toml"),
        &format!(
            "{user}[projects.\"{}\"]\ntrust_level = \"trusted\"\n",
            repo.display()
        ),
    );
    if let Some(requirements) = requirements {
        put(&base.join("etc").join("requirements.toml"), requirements);
    }
    put(&repo.join(".git").join("HEAD"), "ref: x\n");
    put(
        &repo.join(".codex").join("config.toml"),
        "[shell_environment_policy]\nexperimental_use_profile = true\n[shell_environment_policy.set]\nBASH_ENV = \"x\"\nKEEP = \"v\"\n[features]\nshell_snapshot = true\nnetwork_proxy = true\nkeep = 1\n",
    );
    (base, repo)
}

async fn project_tomls(setup: &(Scratch, PathBuf)) -> Vec<String> {
    let (base, repo) = setup;
    let result = read(
        base,
        repo,
        &[&["shell_environment_policy"], &["features"]],
        &[],
    )
    .await
    .unwrap();
    result
        .config
        .layers
        .into_iter()
        .filter(|layer| layer.source.starts_with("project "))
        .map(|layer| layer.toml)
        .collect()
}

const STRIPPED: &str = "[shell_environment_policy.set]\nKEEP = \"v\"\n\n[features]\nkeep = 1\n";
const UNTOUCHED: &str = "[shell_environment_policy]\nexperimental_use_profile = true\n\n[shell_environment_policy.set]\nBASH_ENV = \"x\"\nKEEP = \"v\"\n\n[features]\nshell_snapshot = true\nnetwork_proxy = true\nkeep = 1\n";
const DISABLED: &str = "[shell_environment_policy]\nexperimental_use_profile = true\n\n[shell_environment_policy.set]\nBASH_ENV = \"x\"\nKEEP = \"v\"\n\n[features]\nshell_snapshot = true\nkeep = 1\n";

#[tokio::test]
async fn trusted_credential_masking_turns_on_the_broker_sanitizer_without_a_configured_broker() {
    assert_eq!(
        project_tomls(&broker_setup("[features]\ncredential_masking = true\n", None).await).await,
        [STRIPPED]
    );
    assert_eq!(
        project_tomls(&broker_setup("[features]\ncredential_masking = false\n", None).await).await,
        [UNTOUCHED]
    );
}

#[tokio::test]
async fn requirements_that_enable_credential_masking_turn_on_the_broker_sanitizer() {
    assert_eq!(
        project_tomls(&broker_setup("", Some("[features]\ncredential_masking = true\n")).await)
            .await,
        [STRIPPED]
    );
    assert_eq!(
        project_tomls(
            &broker_setup(
                "",
                Some("[feature_requirements]\ncredential_masking = true\n")
            )
            .await
        )
        .await,
        [STRIPPED]
    );
    assert_eq!(
        project_tomls(
            &broker_setup(
                "[features]\ncredential_masking = true\n",
                Some("[features]\ncredential_masking = false\n")
            )
            .await
        )
        .await,
        [UNTOUCHED]
    );
}

#[tokio::test]
async fn requirements_can_disable_the_broker_with_network_proxy_false_or_experimental_network_disabled()
 {
    let broker = "[features.network_proxy]\ncredential_broker = true\nenabled = true\n";
    assert_eq!(
        project_tomls(&broker_setup(broker, None).await).await,
        [STRIPPED]
    );
    assert_eq!(
        project_tomls(&broker_setup(broker, Some("[features]\nnetwork_proxy = false\n")).await)
            .await,
        [DISABLED]
    );
    assert_eq!(
        project_tomls(&broker_setup("", Some("[features]\ncredential_masking = true\n[experimental_network]\nenabled = false\n")).await).await,
        [DISABLED]
    );
    assert_eq!(
        project_tomls(
            &broker_setup(
                "[features.network_proxy]\ncredential_broker = true\n",
                Some("[features]\nnetwork_proxy = true\n")
            )
            .await
        )
        .await,
        [STRIPPED]
    );
}

#[tokio::test]
async fn invalid_broker_requirements_fail_the_read() {
    for requirements in [
        "[features]\ncredential_masking = \"yes\"\n",
        "[features]\nnetwork_proxy = true\n[feature_requirements]\ncredential_masking = true\n",
        "[experimental_network]\nenabled = \"no\"\n",
    ] {
        let (base, repo) = broker_setup("", Some(requirements)).await;
        let error = read(&base, &repo, &[&["features"]], &[]).await.unwrap_err();
        assert_eq!(error.code, -32603);
        assert!(
            message(&error).starts_with(&format!(
                "failed to load executor-local config: failed to parse requirements layer {}: ",
                base.join("etc").join("requirements.toml").display()
            )),
            "{requirements}"
        );
    }
    let (base, repo) = broker_setup("", Some("[features]\ncredential_masking = \"yes\"\n")).await;
    let error = read(&base, &repo, &[&["features"]], &[]).await.unwrap_err();
    assert!(message(&error).ends_with(
        "invalid type: string, expected a boolean for key `features.credential_masking`"
    ));
}
