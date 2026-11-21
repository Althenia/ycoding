use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;
use ycoding_core::platform::process::{self, Command, Input, RunOptions};
use ycoding_core::ycoding_schema::{JsonValue, parse_json, stringify_json};
use ycoding_runtime::launch::{LaunchError, Parsed, parse_launch, plugin_arguments};

fn home() -> PathBuf {
    std::env::temp_dir().join("ycoding-frontend-arguments")
}

fn environment(key: &str) -> Option<String> {
    (key == "HOME").then(|| home().to_string_lossy().into_owned())
}

fn encode(arguments: &[String]) -> String {
    stringify_json(&JsonValue::Array(
        arguments
            .iter()
            .map(|value| JsonValue::String(value.as_str().into()))
            .collect(),
    ))
}

fn decode(bytes: &[u8]) -> Vec<String> {
    let JsonValue::Array(values) = parse_json(std::str::from_utf8(bytes).unwrap().trim()).unwrap()
    else {
        panic!("expected argument array")
    };
    values
        .into_iter()
        .map(|value| match value {
            JsonValue::String(value) => value.to_utf8().unwrap(),
            _ => panic!("expected string argument"),
        })
        .collect()
}

#[test]
fn explicit_frontend_prefix_preserves_arguments_and_compiled_fallback() {
    assert_eq!(plugin_arguments(&BTreeMap::new()).unwrap(), ["plugin-host"]);
    let executable = home().join("node").to_string_lossy().into_owned();
    let source = home()
        .join("source entry; literal.mjs")
        .to_string_lossy()
        .into_owned();
    let full = std::iter::repeat_n("--conditions=browser".into(), 31)
        .chain([source.clone()])
        .collect::<Vec<String>>();
    for prefix in [
        Vec::new(),
        vec!["--conditions=browser".into(), source],
        full,
    ] {
        let encoded = encode(&prefix);
        let Parsed::Run(config) = parse_launch(
            &[
                "--frontend-executable".into(),
                executable.clone(),
                "--frontend-arguments".into(),
                encoded.clone(),
            ],
            environment,
        )
        .unwrap() else {
            panic!("expected launch configuration")
        };
        assert_eq!(
            config.environment.get("YCODING_FRONTEND_ARGUMENTS"),
            Some(&encoded)
        );
        assert_eq!(
            plugin_arguments(&config.environment).unwrap(),
            prefix
                .into_iter()
                .chain(["plugin-host".into()])
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn malformed_or_orphan_frontend_arguments_are_rejected_without_echoing_them() {
    let executable = home().join("bun").to_string_lossy().into_owned();
    let source = home().join("entry.ts").to_string_lossy().into_owned();
    for value in [
        "not-json".to_string(),
        "{}".into(),
        "null".into(),
        "[1]".into(),
        "[\"\"]".into(),
        "[\"relative.ts\"]".into(),
        "[\"/source/entry\\u0000.ts\"]".into(),
        "[\"/source/entry\\ud800.ts\"]".into(),
        encode(&vec![source.clone(); 33]),
        encode(&[home()
            .join(format!("{}entry.ts", "x".repeat(8192)))
            .to_string_lossy()
            .into_owned()]),
    ] {
        let args = [
            "--frontend-executable".into(),
            executable.clone(),
            "--frontend-arguments".into(),
            value.clone(),
        ];
        let failure = parse_launch(&args, environment).unwrap_err();
        assert!(matches!(failure, LaunchError::Usage(_)));
        assert!(!failure.to_string().contains(&value));
        assert!(
            plugin_arguments(&BTreeMap::from([(
                "YCODING_FRONTEND_ARGUMENTS".into(),
                value
            )]))
            .is_err()
        );
    }
    assert!(parse_launch(&["--frontend-arguments".into(), "[]".into()], environment).is_err());
    assert!(parse_launch(&["--frontend-arguments".into()], environment).is_err());
}

#[test]
fn frontend_arguments_from_the_process_environment_cannot_supply_a_prefix() {
    let env = |key: &str| match key {
        "YCODING_FRONTEND_ARGUMENTS" => Some("[\"/untrusted/source.ts\"]".into()),
        _ => environment(key),
    };
    for args in [
        Vec::new(),
        vec![
            "--frontend-executable".into(),
            home().join("ycoding").to_string_lossy().into_owned(),
        ],
    ] {
        let Parsed::Run(config) = parse_launch(&args, env).unwrap() else {
            panic!("expected launch configuration")
        };
        assert!(
            !config
                .environment
                .contains_key("YCODING_FRONTEND_ARGUMENTS")
        );
        assert_eq!(
            plugin_arguments(&config.environment).unwrap(),
            ["plugin-host"]
        );
    }
}

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn a_source_frontend_relaunches_after_the_native_argument_handoff() {
    let directory = home().with_file_name(format!("ycoding-source-handoff-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let directory = Directory(directory);
    let source = directory.0.join("source entry; literal.mjs");
    let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/cli/src/frontend-launch.ts");
    std::fs::write(&source, format!(
        "import {{ frontendLaunchArguments }} from {};\nif (process.argv[2] === 'plugin-host') console.log(JSON.stringify(process.argv.slice(2)));\nelse console.log(JSON.stringify(frontendLaunchArguments()));\n",
        stringify_json(&JsonValue::String(helper.to_string_lossy().as_ref().into())),
    )).unwrap();
    let base = &directory.0;
    let run = |mut command: Command| async move {
        command.stdin = Input::Ignore;
        command.timeout = Duration::from_secs(10);
        command.extend_env = false;
        command
            .env
            .insert("HOME".into(), base.to_string_lossy().into_owned());
        if let Ok(path) = std::env::var("PATH") {
            command.env.insert("PATH".into(), path);
        }
        process::run(
            command,
            RunOptions {
                max_output_bytes: Some(8192),
                max_error_bytes: Some(8192),
                ..Default::default()
            },
        )
        .await
        .unwrap()
    };
    let first = run(Command::new("bun", [source.to_string_lossy().into_owned()])).await;
    assert_eq!(
        first.exit.code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let args = decode(&first.stdout);
    let Parsed::Run(config) = parse_launch(&args, environment).unwrap() else {
        panic!("expected launch configuration")
    };
    let second = run(Command::new(
        config.environment["YCODING_FRONTEND_EXECUTABLE"].clone(),
        plugin_arguments(&config.environment).unwrap(),
    ))
    .await;
    assert_eq!(
        second.exit.code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(decode(&second.stdout), ["plugin-host"]);
}
