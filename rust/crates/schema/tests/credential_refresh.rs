use ycoding_schema::{
    DomainDecode, DomainEncode, connection, integration, parse_json, stringify_json,
};

fn normalized(value: &ycoding_schema::JsonValue) -> serde_json::Value {
    serde_json::from_str(&stringify_json(value)).unwrap()
}

#[test]
fn credential_info_round_trips_status_and_message() {
    for (status, expected) in [
        ("connected", connection::CredentialStatus::Connected),
        ("expired", connection::CredentialStatus::Expired),
        (
            "refresh_failed",
            connection::CredentialStatus::RefreshFailed,
        ),
    ] {
        let input = parse_json(&format!(
            r#"{{"type":"credential","id":"cred_1","label":"Work","active":true,"kind":"oauth","status":"{status}","message":"token endpoint said no"}}"#
        ))
        .unwrap();
        let decoded = connection::CredentialInfo::decode(&input).unwrap();
        assert_eq!(decoded.status, Some(expected));
        assert_eq!(decoded.message, Some("token endpoint said no".into()));
        assert_eq!(normalized(&decoded.encode()), normalized(&input));
    }
}

#[test]
fn credential_info_without_status_encodes_without_status_or_message() {
    let input =
        parse_json(r#"{"type":"credential","id":"cred_1","label":"Work","active":true}"#).unwrap();
    let decoded = connection::CredentialInfo::decode(&input).unwrap();
    assert_eq!((decoded.status, decoded.message.clone()), (None, None));
    assert_eq!(normalized(&decoded.encode()), normalized(&input));
}

#[test]
fn credential_info_rejects_an_unknown_status() {
    let input = parse_json(
        r#"{"type":"credential","id":"cred_1","label":"Work","active":true,"status":"revoked"}"#,
    )
    .unwrap();
    assert!(connection::CredentialInfo::decode(&input).is_err());
}

#[test]
fn refresh_result_round_trips_both_outcomes_and_rejects_other_statuses() {
    for input in [
        r#"{"status":"refreshed","expires":1234}"#,
        r#"{"status":"failed","message":"Authorization failed"}"#,
    ] {
        let value = parse_json(input).unwrap();
        let decoded = integration::RefreshResult::decode(&value).unwrap();
        assert_eq!(normalized(&decoded.encode()), normalized(&value));
    }
    for input in [
        r#"{"status":"pending"}"#,
        r#"{"status":"refreshed","expires":-1}"#,
        r#"{"status":"failed"}"#,
    ] {
        assert!(integration::RefreshResult::decode(&parse_json(input).unwrap()).is_err());
    }
}
