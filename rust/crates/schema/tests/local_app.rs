use serde_json::{Value, json};
use ycoding_schema::{
    DomainDecode, DomainEncode,
    local_app::{Failure, Register, Registration, Scope},
    parse_json, stringify_json,
};

fn decode<T: DomainDecode>(value: Value) -> Result<T, ycoding_schema::DecodeError> {
    T::decode(&parse_json(&value.to_string()).unwrap())
}

fn registration() -> Value {
    json!({"sessionID":"ses_synthetic","host":"127.0.0.1","port":43210,"entryPath":"/app/index.html","routes":[{"path":"/app","match":"prefix","methods":["GET","HEAD","POST"]}]})
}

#[test]
fn literal_hosts_ports_methods_and_optional_ttl_have_closed_shapes() {
    for host in ["127.0.0.1", "[::1]"] {
        for port in [1, 65535] {
            let mut input = registration();
            input["host"] = json!(host);
            input["port"] = json!(port);
            input["routes"][0]["methods"] =
                json!(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
            assert!(decode::<Register>(input).is_ok());
        }
    }
    for ttl in [1, 900_000, 3_600_000] {
        let mut input = registration();
        input["ttlMs"] = json!(ttl);
        assert!(decode::<Register>(input).is_ok());
    }
    for host in [
        "localhost",
        "::1",
        "[::ffff:127.0.0.1]",
        "0.0.0.0",
        "127.1",
        "2130706433",
        "10.0.0.1",
        "169.254.169.254",
        "https://127.0.0.1",
    ] {
        let mut input = registration();
        input["host"] = json!(host);
        assert!(decode::<Register>(input).is_err(), "{host}");
    }
    for (key, values) in [
        (
            "port",
            vec![json!(0), json!(65536), json!(1.5), json!("80"), Value::Null],
        ),
        (
            "ttlMs",
            vec![
                json!(0),
                json!(-1),
                json!(3_600_001),
                json!(0.5),
                Value::Null,
            ],
        ),
    ] {
        for value in values {
            let mut input = registration();
            input[key] = value;
            assert!(decode::<Register>(input).is_err());
        }
    }
    for method in ["CONNECT", "TRACE", "get", "*"] {
        let mut input = registration();
        input["routes"][0]["methods"] = json!([method]);
        assert!(decode::<Register>(input).is_err());
    }
}

#[test]
fn registration_rejects_extra_nested_fields_and_route_count_edges() {
    for (target, key) in [("outer", "url"), ("route", "origin")] {
        let mut input = registration();
        if target == "outer" {
            input[key] = json!("http://elsewhere.invalid");
        }
        if target == "route" {
            input["routes"][0][key] = json!("http://elsewhere.invalid");
        }
        assert!(decode::<Register>(input).is_err());
    }
    for count in [0, 64, 65] {
        let mut input = registration();
        input["routes"] = Value::Array(
            (0..count)
                .map(|_| json!({"path":"/app","match":"prefix","methods":["GET"]}))
                .collect(),
        );
        assert_eq!(decode::<Register>(input).is_ok(), count == 64);
    }
    for methods in [
        json!([]),
        json!(["GET", "GET", "GET", "GET", "GET", "GET", "GET", "GET"]),
    ] {
        let mut input = registration();
        input["routes"][0]["methods"] = methods;
        assert!(decode::<Register>(input).is_err());
    }
    let input = decode::<Register>(registration()).unwrap();
    assert!(input.ttl_ms.is_none());
    assert!(!stringify_json(&input.encode()).contains("ttlMs"));
}

#[test]
fn scope_retains_every_identity_dimension_including_url_shaped_client_identifiers() {
    let value = json!({"ownerID":"owner_synthetic","deviceID":"device_synthetic","sessionID":"ses_synthetic","clientID":"https://client.example/metadata?client=x","grantID":"grant_synthetic","epoch":"epoch_synthetic"});
    let scope = decode::<Scope>(value.clone()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&stringify_json(&scope.encode())).unwrap(),
        value
    );
    for key in [
        "ownerID",
        "deviceID",
        "sessionID",
        "clientID",
        "grantID",
        "epoch",
    ] {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(decode::<Scope>(missing).is_err(), "{key}");
        let mut empty = value.clone();
        empty[key] = json!("");
        assert!(decode::<Scope>(empty).is_err(), "{key}");
    }
    for client in [
        "c".repeat(2049),
        "client\r\nforged".into(),
        "client\0forged".into(),
    ] {
        let mut invalid = value.clone();
        invalid["clientID"] = json!(client);
        assert!(decode::<Scope>(invalid).is_err());
    }
    let mut longest = value.clone();
    longest["clientID"] = json!("c".repeat(2048));
    assert!(decode::<Scope>(longest).is_ok());
    let mut forged = value;
    forged["directory"] = json!("/synthetic");
    assert!(decode::<Scope>(forged).is_err());
}

#[test]
fn safe_registration_metadata_is_closed_and_round_trips_without_authority_or_destination() {
    let value = json!({"id":format!("app_{}","a".repeat(32)),"generation":format!("generation_{}","b".repeat(32)),"sessionID":"ses_synthetic","expiresAt":1_800_000_900_000_i64,"entryPath":"/app/index.html","allowedMethods":["GET"],"routes":[{"path":"/app","match":"prefix","methods":["GET"]}]});
    let metadata = decode::<Registration>(value.clone()).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&stringify_json(&metadata.encode())).unwrap(),
        value
    );
    for key in [
        "host", "port", "origin", "ownerID", "clientID", "grantID", "epoch",
    ] {
        let mut changed = value.clone();
        changed[key] = json!("private");
        assert!(decode::<Registration>(changed).is_err(), "{key}");
    }
    for (key, invalid) in [
        ("id", "app_not_hex"),
        ("generation", "generation_ascending"),
    ] {
        let mut changed = value.clone();
        changed[key] = json!(invalid);
        assert!(decode::<Registration>(changed).is_err());
    }
}

#[test]
fn failures_have_only_the_closed_sanitized_category() {
    for category in [
        "invalid_registration",
        "forbidden",
        "not_found",
        "expired",
        "busy",
        "unsupported_stream",
        "upstream_unavailable",
        "too_large",
        "redirect_rejected",
    ] {
        let error =
            decode::<Failure>(json!({"_tag":"LocalApp.Failure","category":category})).unwrap();
        assert_eq!(error.to_string(), category);
        assert_eq!(
            serde_json::from_str::<Value>(&stringify_json(&error.encode())).unwrap(),
            json!({"_tag":"LocalApp.Failure","category":category})
        );
    }
    assert!(
        decode::<Failure>(
            json!({"_tag":"LocalApp.Failure","category":"forbidden","url":"http://private.invalid"})
        )
        .is_err()
    );
}
