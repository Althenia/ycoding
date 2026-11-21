use ycoding_schema::{DomainDecode, DomainEncode, connection, parse_json, stringify_json};

fn round_trip(input: &str) -> connection::CredentialInfo {
    let value = parse_json(input).unwrap();
    let decoded = connection::CredentialInfo::decode(&value).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stringify_json(&decoded.encode())).unwrap(),
        serde_json::from_str::<serde_json::Value>(&stringify_json(&value)).unwrap()
    );
    decoded
}

#[test]
fn credential_info_round_trips_oauth_and_key_kinds() {
    let oauth = round_trip(
        r#"{"type":"credential","id":"cred_oauth","label":"Work","active":true,"kind":"oauth"}"#,
    );
    assert_eq!(oauth.kind, Some(connection::CredentialKind::Oauth));
    let key = round_trip(
        r#"{"type":"credential","id":"cred_key","label":"Personal","active":false,"kind":"key"}"#,
    );
    assert_eq!(key.kind, Some(connection::CredentialKind::Key));
}

#[test]
fn credential_info_decodes_without_kind_from_an_older_server() {
    let legacy = round_trip(r#"{"type":"credential","id":"cred_1","label":"Work","active":true}"#);
    assert_eq!(legacy.kind, None);
}

#[test]
fn credential_info_rejects_an_unknown_kind() {
    assert!(
        connection::CredentialInfo::decode(
            &parse_json(
                r#"{"type":"credential","id":"cred_1","label":"Work","active":true,"kind":"command"}"#
            )
            .unwrap()
        )
        .is_err()
    );
}

#[test]
fn env_connections_stay_type_and_name() {
    let value = parse_json(r#"{"type":"env","name":"ACME_KEY"}"#).unwrap();
    assert_eq!(connection::Info::decode(&value).unwrap().encode(), value);
}
