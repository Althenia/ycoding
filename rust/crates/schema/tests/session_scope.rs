use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, parse_json, session, session_event, stringify_json,
    telemetry,
};

const INFO: &str = r#"{"id":"ses_scope","projectID":"global","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1,"updated":2},"title":"Synthetic","location":{"directory":"/synthetic"}}"#;
const CREATED: &str = r#"{"sessionID":"ses_scope","projectID":"global","location":{"directory":"/synthetic"},"title":"Synthetic","created":1}"#;

fn with_scope(json: &str, scope: JsonValue) -> JsonValue {
    let mut value = parse_json(json).unwrap();
    let JsonValue::Object(object) = &mut value else {
        panic!("object fixture expected");
    };
    object.insert("scope".into(), scope);
    value
}

#[test]
fn legacy_info_and_created_payloads_default_to_the_bound_scope_and_encode_it() {
    let info = session::Info::decode(&parse_json(INFO).unwrap()).unwrap();
    assert_eq!(info.scope, session::Scope::Bound);
    assert!(
        stringify_json(&info.encode())
            .starts_with(r#"{"id":"ses_scope","projectID":"global","scope":"bound","#)
    );
    let created = session_event::Created::decode(&parse_json(CREATED).unwrap()).unwrap();
    assert_eq!(
        stringify_json(&created.encode()),
        r#"{"sessionID":"ses_scope","projectID":"global","scope":"bound","location":{"directory":"/synthetic"},"title":"Synthetic","created":1}"#
    );
}

#[test]
fn each_scope_survives_info_and_created_encode_and_decode() {
    for (label, scope) in [
        ("bound", session::Scope::Bound),
        ("standalone", session::Scope::Standalone),
    ] {
        let info =
            session::Info::decode(&with_scope(INFO, JsonValue::String(label.into()))).unwrap();
        assert_eq!(info.scope, scope);
        assert_eq!(session::Info::decode(&info.encode()).unwrap(), info);
        let created =
            session_event::Created::decode(&with_scope(CREATED, JsonValue::String(label.into())))
                .unwrap();
        let encoded = created.encode();
        let JsonValue::Object(object) = &encoded else {
            panic!("object expected");
        };
        assert_eq!(
            object.get(&"scope".into()),
            Some(&JsonValue::String(label.into()))
        );
        assert_eq!(session_event::Created::decode(&encoded).unwrap(), created);
    }
}

#[test]
fn unknown_or_malformed_scopes_are_rejected() {
    for scope in [
        JsonValue::String("other".into()),
        JsonValue::String("Bound".into()),
        JsonValue::String("".into()),
        JsonValue::Null,
        JsonValue::Number(1.0),
    ] {
        assert!(session::Info::decode(&with_scope(INFO, scope.clone())).is_err());
        assert!(session_event::Created::decode(&with_scope(CREATED, scope)).is_err());
    }
}

#[test]
fn session_fork_is_a_canonical_telemetry_operation() {
    let label = JsonValue::String("session.fork".into());
    assert_eq!(
        telemetry::Operation::decode(&label).unwrap().as_str(),
        "session.fork"
    );
    assert_eq!(
        telemetry::Operation::decode(&label).unwrap().encode(),
        label
    );
}
