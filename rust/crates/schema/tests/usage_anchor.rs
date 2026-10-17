use ycoding_schema::{
    DomainDecode, DomainEncode, parse_json, session_id::SessionId, session_message_id, usage_anchor,
};

fn anchor() -> usage_anchor::Ref {
    usage_anchor::Ref {
        session_id: SessionId::new("ses_one").unwrap(),
        input_id: session_message_id::Id::new("msg_one").unwrap(),
    }
}

#[test]
fn a_closed_session_and_input_object_round_trips_exactly() {
    let value = parse_json(r#"{"sessionID":"ses_one","inputID":"msg_one"}"#).unwrap();
    let decoded = usage_anchor::Ref::decode(&value).unwrap();
    assert_eq!(decoded, anchor());
    assert_eq!(decoded.encode(), value);
    assert_eq!(anchor().encode(), value);
}

#[test]
fn key_order_does_not_change_the_decoded_anchor() {
    let reordered = parse_json(r#"{"inputID":"msg_one","sessionID":"ses_one"}"#).unwrap();
    assert_eq!(usage_anchor::Ref::decode(&reordered).unwrap(), anchor());
}

#[test]
fn missing_extra_misspelled_and_null_fields_are_rejected() {
    for invalid in [
        r#"{}"#,
        r#"{"sessionID":"ses_one"}"#,
        r#"{"inputID":"msg_one"}"#,
        r#"{"sessionID":"ses_one","inputID":"msg_one","extra":true}"#,
        r#"{"sessionID":"ses_one","inputID":"msg_one","causedBy":null}"#,
        r#"{"sessionId":"ses_one","inputId":"msg_one"}"#,
        r#"{"session_id":"ses_one","input_id":"msg_one"}"#,
        r#"{"sessionID":null,"inputID":"msg_one"}"#,
        r#"{"sessionID":"ses_one","inputID":null}"#,
    ] {
        assert!(
            usage_anchor::Ref::decode(&parse_json(invalid).unwrap()).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn identifiers_with_the_wrong_prefix_or_type_are_rejected() {
    for invalid in [
        r#"{"sessionID":"msg_one","inputID":"msg_one"}"#,
        r#"{"sessionID":"ses_one","inputID":"ses_one"}"#,
        r#"{"sessionID":"prj_one","inputID":"msg_one"}"#,
        r#"{"sessionID":"one","inputID":"msg_one"}"#,
        r#"{"sessionID":"ses_one","inputID":"one"}"#,
        r#"{"sessionID":"","inputID":"msg_one"}"#,
        r#"{"sessionID":"ses_one","inputID":""}"#,
        r#"{"sessionID":1,"inputID":"msg_one"}"#,
        r#"{"sessionID":"ses_one","inputID":["msg_one"]}"#,
    ] {
        assert!(
            usage_anchor::Ref::decode(&parse_json(invalid).unwrap()).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn only_an_object_decodes() {
    for invalid in [
        "null",
        "true",
        "1",
        r#""ses_one""#,
        r#"["ses_one","msg_one"]"#,
    ] {
        assert!(
            usage_anchor::Ref::decode(&parse_json(invalid).unwrap()).is_err(),
            "{invalid}"
        );
    }
}
