use std::path::PathBuf;
use ycoding_runtime::launch::{LaunchError, Parsed, parse_launch};

fn home() -> PathBuf {
    std::env::temp_dir().join("ycoding-frontend-assets")
}

fn environment(key: &str) -> Option<String> {
    (key == "HOME").then(|| home().to_string_lossy().into_owned())
}

#[test]
fn runtime_accepts_the_frontend_asset_path_but_rejects_the_plugin_host_prefix() {
    let executable = home().join("ycoding").to_string_lossy().into_owned();
    let mut args = vec!["--frontend-executable".into(), executable.clone()];
    let Parsed::Run(config) = parse_launch(&args, environment).unwrap() else {
        panic!("expected launch configuration")
    };
    assert_eq!(
        config.environment.get("YCODING_FRONTEND_EXECUTABLE"),
        Some(&executable)
    );
    args.extend([
        "--frontend-arguments".into(),
        r#"["/test/entry.ts"]"#.into(),
    ]);
    assert!(matches!(
        parse_launch(&args, environment),
        Err(LaunchError::Usage(_))
    ));
}

#[test]
fn retired_frontend_prefix_is_rejected_without_echoing_its_value() {
    let executable = home().join("ycoding").to_string_lossy().into_owned();
    for prefix in [
        vec!["--frontend-arguments".into()],
        vec![
            "--frontend-arguments".into(),
            "untrusted-source-entry".into(),
        ],
        vec!["--frontend-arguments=untrusted-source-entry".into()],
    ] {
        let mut args = vec!["--frontend-executable".into(), executable.clone()];
        args.extend(prefix);
        let Err(LaunchError::Usage(message)) = parse_launch(&args, environment) else {
            panic!("expected usage error");
        };
        assert!(!message.contains("untrusted-source-entry"));
    }
}

#[test]
fn inherited_frontend_values_do_not_supply_asset_metadata() {
    let Parsed::Run(config) = parse_launch(&[], |key| match key {
        "YCODING_FRONTEND_EXECUTABLE" => Some("/ignored/frontend".into()),
        "YCODING_FRONTEND_ARGUMENTS" => Some(r#"["/ignored/entry.ts"]"#.into()),
        _ => environment(key),
    })
    .unwrap() else {
        panic!("expected launch configuration");
    };
    assert!(
        !config
            .environment
            .contains_key("YCODING_FRONTEND_EXECUTABLE")
    );
    assert!(
        !config
            .environment
            .contains_key("YCODING_FRONTEND_ARGUMENTS")
    );
}
