use ycoding_schema::{DomainDecode, DomainEncode, parse_json, shell};

#[test]
fn shell_status_accepts_only_process_lifecycle_states() {
    for status in ["running", "exited", "timeout", "memory-limit", "killed"] {
        assert!(shell::Status::decode(&parse_json(&format!("\"{status}\"")).unwrap()).is_ok());
    }
    assert!(shell::Status::decode(&parse_json("\"queued\"").unwrap()).is_err());
}

#[test]
fn shell_info_exposes_process_timing_and_discards_unknown_fields() {
    let input = parse_json(r#"{"id":"sh_x","status":"running","command":"true","cwd":"/tmp","shell":"/bin/sh","file":"capture","metadata":{},"queuePosition":1,"time":{"started":10,"queued":1}}"#).unwrap();
    let expected = parse_json(r#"{"id":"sh_x","status":"running","command":"true","cwd":"/tmp","shell":"/bin/sh","file":"capture","metadata":{},"time":{"started":10}}"#).unwrap();
    assert_eq!(shell::Info::decode(&input).unwrap().encode(), expected);
}
