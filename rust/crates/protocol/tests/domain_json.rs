use prost::{Message, Name};
use ycoding_protocol::{
    domain_json::{self, Domain},
    encode_lossless, limits, v5,
};

fn text(value: &str) -> Domain {
    Domain::Text(value.encode_utf16().collect())
}

fn key(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

fn object(entries: &[(&str, Domain)]) -> Domain {
    Domain::Object(
        entries
            .iter()
            .map(|(name, value)| (key(name), value.clone()))
            .collect(),
    )
}

fn lossless(value: &str) -> v5::LosslessString {
    encode_lossless(&value.encode_utf16().collect::<Vec<_>>())
}

fn encode(name: &str, value: &Domain) -> Result<Vec<u8>, domain_json::Error> {
    domain_json::encode(name, value, limits::BULK_MESSAGE_BYTES as usize)
}

#[test]
fn metadata_names_every_field_and_oneof_of_a_message() {
    let message = domain_json::message("ycoding.v5.session_create_Request_payload").unwrap();
    assert_eq!(message.name, "ycoding.v5.session_create_Request_payload");
    let fields = message
        .fields
        .iter()
        .map(|field| (field.name, field.tag, field.required, field.repeated))
        .collect::<Vec<_>>();
    assert_eq!(
        fields,
        [
            ("id", 1, false, false),
            ("parentID", 2, false, false),
            ("agent", 3, false, false),
            ("model", 4, false, false),
            ("location", 5, false, false),
        ]
    );
    assert_eq!(message.fields[0].target, "ycoding.v5.LosslessString");
    let union = domain_json::message("ycoding.v5.SessionAutonomySet").unwrap();
    assert_eq!(union.oneofs, ["kind"]);
    assert!(union.fields.iter().all(|field| field.oneof == Some(0)));
    assert!(domain_json::message("ycoding.v5.Missing").is_none());
}

#[test]
fn enumerations_carry_canonical_domain_labels() {
    let reply = domain_json::enumeration("ycoding.v5.Permission_Reply").unwrap();
    let values = reply
        .values
        .iter()
        .map(|value| (value.number, value.name, value.label))
        .collect::<Vec<_>>();
    assert_eq!(
        values,
        [
            (1, "PERMISSION_REPLY_ONCE", Some("once")),
            (2, "PERMISSION_REPLY_ALWAYS", Some("always")),
            (3, "PERMISSION_REPLY_REJECT", Some("reject")),
        ]
    );
    let goal = domain_json::message("ycoding.v5.SessionAutonomySetValue1_goal").unwrap();
    let literal = goal
        .fields
        .iter()
        .map(|field| (field.name, field.literal))
        .collect::<Vec<_>>();
    assert_eq!(
        literal,
        [
            ("value_1", None),
            ("value_2", Some("true")),
            ("clear", None)
        ]
    );
}

#[test]
fn records_encode_to_the_canonical_wire_and_decode_back() {
    let value = object(&[(
        "payload",
        object(&[("id", text("ses_alpha")), ("agent", text("build"))]),
    )]);
    let bytes = encode(&v5::SessionCreateRequest::full_name(), &value).unwrap();
    let expected = v5::SessionCreateRequest {
        payload: v5::SessionCreateRequestPayload {
            id: Some(lossless("ses_alpha")),
            agent: Some(lossless("build")),
            ..Default::default()
        },
    };
    assert_eq!(bytes, expected.encode_to_vec());
    assert_eq!(
        domain_json::decode(&v5::SessionCreateRequest::full_name(), &bytes).unwrap(),
        value
    );
}

#[test]
fn lossless_strings_preserve_lone_surrogates() {
    let lone = Domain::Text(vec![0x61, 0xd800]);
    let value = object(&[("payload", object(&[("agent", lone.clone())]))]);
    let bytes = encode(&v5::SessionCreateRequest::full_name(), &value).unwrap();
    let decoded = v5::SessionCreateRequest::decode(bytes.as_slice()).unwrap();
    assert_eq!(
        decoded.payload.agent,
        Some(encode_lossless(&[0x61, 0xd800]))
    );
    assert_eq!(
        domain_json::decode(&v5::SessionCreateRequest::full_name(), &bytes).unwrap(),
        value
    );
}

#[test]
fn enums_encode_from_and_decode_to_labels_only() {
    let name = v5::SessionPermissionReplyRequestPayload::full_name();
    let bytes = encode(&name, &object(&[("reply", text("always"))])).unwrap();
    assert_eq!(
        v5::SessionPermissionReplyRequestPayload::decode(bytes.as_slice())
            .unwrap()
            .reply,
        2
    );
    assert_eq!(
        domain_json::decode(&name, &bytes).unwrap(),
        object(&[("reply", text("always"))])
    );
    assert!(
        encode(
            &name,
            &object(&[("reply", text("PERMISSION_REPLY_ALWAYS"))])
        )
        .is_err()
    );
    assert!(encode(&name, &object(&[("reply", Domain::Number(2.0))])).is_err());
}

#[test]
fn unions_select_the_first_branch_that_encodes_and_validates() {
    let name = v5::SessionAutonomySet::full_name();
    let goal = object(&[
        ("goal", text("ship the release")),
        ("maxNoProgress", Domain::Number(3.0)),
    ]);
    let bytes = encode(&name, &goal).unwrap();
    let expected = v5::SessionAutonomySet {
        kind: Some(v5::session_autonomy_set::Kind::Value1(
            v5::SessionAutonomySetValue1 {
                yolo: None,
                goal: v5::SessionAutonomySetValue1Goal {
                    kind: Some(v5::session_autonomy_set_value1_goal::Kind::Value1(
                        lossless("ship the release"),
                    )),
                },
                max_no_progress: Some(3),
            },
        )),
    };
    assert_eq!(bytes, expected.encode_to_vec());
    assert_eq!(domain_json::decode(&name, &bytes).unwrap(), goal);

    let cleared = object(&[("goal", Domain::Null)]);
    let bytes = encode(&name, &cleared).unwrap();
    let Some(v5::session_autonomy_set::Kind::Value1(value)) =
        v5::SessionAutonomySet::decode(bytes.as_slice())
            .unwrap()
            .kind
    else {
        panic!("goal clear must use the goal branch")
    };
    assert_eq!(
        value.goal.kind,
        Some(v5::session_autonomy_set_value1_goal::Kind::Clear(
            v5::Empty {}
        ))
    );
    assert_eq!(domain_json::decode(&name, &bytes).unwrap(), cleared);

    let literal = object(&[("goal", Domain::Bool(true))]);
    let bytes = encode(&name, &literal).unwrap();
    let Some(v5::session_autonomy_set::Kind::Value1(value)) =
        v5::SessionAutonomySet::decode(bytes.as_slice())
            .unwrap()
            .kind
    else {
        panic!("goal literal must use the goal branch")
    };
    assert_eq!(
        value.goal.kind,
        Some(v5::session_autonomy_set_value1_goal::Kind::Value2(true))
    );
    assert!(encode(&name, &object(&[("goal", Domain::Bool(false))])).is_err());

    let sleep = object(&[("sleep", Domain::Bool(true))]);
    let bytes = encode(&name, &sleep).unwrap();
    assert!(matches!(
        v5::SessionAutonomySet::decode(bytes.as_slice())
            .unwrap()
            .kind,
        Some(v5::session_autonomy_set::Kind::Value3(_))
    ));
}

#[test]
fn encoding_applies_descriptor_constraints_before_returning_bytes() {
    let name = v5::SessionAutonomySet::full_name();
    let zero = object(&[("goal", text("x")), ("maxNoProgress", Domain::Number(0.0))]);
    assert!(encode(&name, &zero).is_err());
    let empty = object(&[("goal", text(""))]);
    assert!(encode(&name, &empty).is_err());
}

#[test]
fn records_reject_unknown_missing_and_mistyped_fields() {
    let name = v5::SessionCreateRequest::full_name();
    assert!(encode(&name, &object(&[])).is_err());
    assert!(
        encode(
            &name,
            &object(&[("payload", object(&[("unknown", text("x"))]))])
        )
        .is_err()
    );
    assert!(
        encode(
            &name,
            &object(&[("payload", object(&[("agent", Domain::Null)]))])
        )
        .is_err()
    );
    assert!(
        encode(
            &name,
            &object(&[("payload", object(&[("agent", Domain::Number(1.0))]))])
        )
        .is_err()
    );
    assert!(encode(&name, &text("payload")).is_err());
    assert!(encode("ycoding.v5.Missing", &object(&[])).is_err());
}

#[test]
fn integers_must_be_safe_and_in_range() {
    let name = v5::SessionAutonomySet::full_name();
    let number = |value: f64| {
        object(&[
            ("goal", text("x")),
            ("maxNoProgress", Domain::Number(value)),
        ])
    };
    assert!(encode(&name, &number(9_007_199_254_740_991.0)).is_ok());
    assert!(encode(&name, &number(9_007_199_254_740_992.0)).is_err());
    assert!(encode(&name, &number(1.5)).is_err());
    assert!(encode(&name, &number(-1.0)).is_err());
}

#[test]
fn open_values_round_trip_through_value_messages() {
    let value = object(&[
        ("text", text("x")),
        ("number", Domain::Number(1.25)),
        ("flag", Domain::Bool(false)),
        ("none", Domain::Null),
        ("items", Domain::List(vec![Domain::Number(1.0), text("y")])),
    ]);
    let bytes = encode("ycoding.v5.Value", &value).unwrap();
    assert_eq!(
        domain_json::decode("ycoding.v5.Value", &bytes).unwrap(),
        value
    );
}

#[test]
fn byte_depth_and_field_budgets_fail_closed() {
    let name = v5::SessionCreateRequest::full_name();
    let value = object(&[("payload", object(&[("agent", text(&"a".repeat(64)))]))]);
    assert_eq!(
        domain_json::encode(&name, &value, 16),
        Err(domain_json::Error("domain byte limit"))
    );
    let mut nested = Domain::Null;
    for _ in 0..300 {
        nested = Domain::List(vec![nested]);
    }
    assert_eq!(
        encode("ycoding.v5.Value", &nested),
        Err(domain_json::Error("domain depth limit"))
    );
    let wide = Domain::List(vec![Domain::Null; limits::TOTAL_FIELDS as usize + 1]);
    assert_eq!(
        encode("ycoding.v5.Value", &wide),
        Err(domain_json::Error("domain field limit"))
    );
}

#[test]
fn decoding_validates_the_wire_before_projection() {
    let name = v5::SessionCreateRequest::full_name();
    assert!(domain_json::decode(&name, &[0xff]).is_err());
    let foreign = v5::SessionAutonomySetValue3 { sleep: true }.encode_to_vec();
    assert!(domain_json::decode(&name, &foreign).is_err());
}
