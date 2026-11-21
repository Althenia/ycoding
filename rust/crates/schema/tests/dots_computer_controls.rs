use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, dots, parse_json};

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn target() -> String {
    format!(
        r#"{{"dotID":"dot-a","threadID":"thread-a","environmentID":"env-a","revision":"{}"}}"#,
        "a".repeat(64)
    )
}

fn round_trip<T: DomainDecode + DomainEncode>(text: &str) {
    let value = json(text);
    assert_eq!(T::decode(&value).unwrap().encode(), value, "{text}");
}

#[test]
fn detach_and_removal_accept_an_optional_exact_target_receipt_and_nothing_else() {
    round_trip::<dots::ComputerDetach>("{}");
    round_trip::<dots::ComputerRemove>("{}");
    round_trip::<dots::ComputerDetach>(&format!(r#"{{"expectedTarget":{}}}"#, target()));
    round_trip::<dots::ComputerRemove>(&format!(r#"{{"expectedTarget":{}}}"#, target()));
    let short = target().replace(&"a".repeat(64), "short");
    let empty = target().replace(r#""environmentID":"env-a""#, r#""environmentID":"""#);
    for invalid in [
        r#"{"replaceOthers":false}"#.to_owned(),
        format!(r#"{{"expectedTarget":{short}}}"#),
        format!(r#"{{"expectedTarget":{empty}}}"#),
        format!(r#"{{"expectedTarget":{},"extra":true}}"#, target()),
    ] {
        assert!(
            dots::ComputerDetach::decode(&json(&invalid)).is_err(),
            "{invalid}"
        );
        assert!(
            dots::ComputerRemove::decode(&json(&invalid)).is_err(),
            "{invalid}"
        );
    }
}

fn status(computer: &str) -> String {
    format!(
        r#"{{"access":{{"enabled":true,"revision":1}},"configuration":{{"ready":true}},"connection":{{"state":"connected"}},"computer":{computer}}}"#
    )
}

#[test]
fn computer_status_carries_readiness_task_usability_the_dot_environment_and_the_removed_state() {
    round_trip::<dots::NativeStatus>(&status(&format!(
        r#"{{"state":"attached","target":{},"readiness":"connected","usableForTasks":true,"dotEnvironment":{{"status":"offline","capabilities":[{{"type":"remote_desktop","status":"starting"}}]}}}}"#,
        target()
    )));
    round_trip::<dots::NativeStatus>(&status(r#"{"state":"removed"}"#));
    for readiness in ["connected", "offline", "unknown"] {
        round_trip::<dots::NativeStatus>(&status(&format!(
            r#"{{"state":"detached","readiness":"{readiness}"}}"#
        )));
    }
}

#[test]
fn computer_status_refuses_unknown_readiness_and_malformed_environments() {
    let capabilities = (0..17)
        .map(|_| r#"{"type":"a","status":"b"}"#)
        .collect::<Vec<_>>()
        .join(",");
    for invalid in [
        r#"{"readiness":"ready"}"#.to_owned(),
        r#"{"usableForTasks":"yes"}"#.to_owned(),
        r#"{"dotEnvironment":{"status":"offline"}}"#.to_owned(),
        r#"{"dotEnvironment":{"status":"OFFLINE","capabilities":[]}}"#.to_owned(),
        r#"{"dotEnvironment":{"status":"offline","capabilities":[{"type":"remote_desktop"}]}}"#
            .to_owned(),
        format!(r#"{{"dotEnvironment":{{"status":"offline","capabilities":[{capabilities}]}}}}"#),
    ] {
        let computer = format!(r#"{{"state":"attached",{}"#, &invalid[1..]);
        assert!(
            dots::NativeStatus::decode(&json(&status(&computer))).is_err(),
            "{invalid}"
        );
    }
}
