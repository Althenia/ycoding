use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonValue, parse_json, session_event,
    session_orchestration::Change,
};

const ANCHOR: &str = r#"{"sessionID":"ses_root","inputID":"msg_user"}"#;

const INVALID: [&str; 8] = [
    "null",
    r#"{"sessionID":"ses_root"}"#,
    r#"{"inputID":"msg_user"}"#,
    r#"{"sessionID":"msg_user","inputID":"msg_user"}"#,
    r#"{"sessionID":"ses_root","inputID":"ses_root"}"#,
    r#"{"sessionID":"ses_root","inputID":"msg_user","extra":true}"#,
    r#""ses_root""#,
    "[]",
];

struct Carrier {
    kind: &'static str,
    version: i64,
    build: fn(Option<&str>) -> String,
    read: fn(&JsonValue) -> Option<JsonValue>,
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

fn admitted(anchor: Option<&str>) -> String {
    format!(
        r#"{{"sessionID":"ses_child","inputID":"msg_child","input":{{"type":"user","data":{{"text":"work"}},"delivery":"steer"}}{}}}"#,
        anchor.map_or_else(String::new, |anchor| format!(r#","causedBy":{anchor}"#))
    )
}

fn compaction(anchor: Option<&str>) -> String {
    format!(
        r#"{{"sessionID":"ses_child","jobID":"cmp_job"{}}}"#,
        anchor.map_or_else(String::new, |anchor| format!(r#","usageAnchor":{anchor}"#))
    )
}

fn recorded(anchor: Option<&str>) -> String {
    format!(
        r#"{{"sessionID":"ses_child","id":"prq_anchor","source":"step","agent":"build","model":{{"providerID":"openai","id":"gpt"}},"routeID":"route","promptCacheKey":"cache","systemDigest":"system","toolDigest":"tools","request":1,"attempts":1,"invalidation":"first-request","continuation":"full","tokens":{{"input":1,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"time":1{}}}"#,
        anchor.map_or_else(String::new, |anchor| format!(r#","usageAnchor":{anchor}"#))
    )
}

fn launched_change(anchor: Option<&str>) -> String {
    format!(
        r#"{{"type":"launched","parentID":"ses_root","parentAssistantMessageID":"msg_assistant","toolCallID":"call_1","inputID":"msg_child","description":"task","agent":"build","model":{{"providerID":"openai","id":"m"}},"promptDigest":"digest","background":true,"delivery":"steer"{}}}"#,
        anchor.map_or_else(String::new, |anchor| format!(r#","usageAnchor":{anchor}"#))
    )
}

fn launched(anchor: Option<&str>) -> String {
    format!(
        r#"{{"sessionID":"ses_child","change":{}}}"#,
        launched_change(anchor)
    )
}

fn carriers() -> [Carrier; 4] {
    [
        Carrier {
            kind: "session.input.admitted",
            version: 1,
            build: admitted,
            read: |data| field(data, "causedBy").cloned(),
        },
        Carrier {
            kind: "session.compaction.admitted",
            version: 2,
            build: compaction,
            read: |data| field(data, "usageAnchor").cloned(),
        },
        Carrier {
            kind: "session.provider.request.recorded",
            version: 1,
            build: recorded,
            read: |data| field(data, "usageAnchor").cloned(),
        },
        Carrier {
            kind: "session.task.updated",
            version: 1,
            build: launched,
            read: |data| field(field(data, "change")?, "usageAnchor").cloned(),
        },
    ]
}

fn canonical(value: &JsonValue) -> String {
    match value {
        JsonValue::Object(object) => {
            let mut entries = object
                .iter()
                .map(|(key, value)| (format!("{key:?}"), canonical(value)))
                .collect::<Vec<_>>();
            entries.sort();
            format!(
                "{{{}}}",
                entries
                    .iter()
                    .map(|(key, value)| format!("{key}:{value}"))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        JsonValue::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        other => format!("{other:?}"),
    }
}

fn envelope(kind: &str, version: i64, data: &str) -> JsonValue {
    parse_json(&format!(
        r#"{{"id":"evt_anchor","created":1,"type":"{kind}","durable":{{"aggregateID":"ses_child","seq":0,"version":{version}}},"data":{data}}}"#
    ))
    .unwrap()
}

fn durable(carrier: &Carrier, anchor: Option<&str>) -> Result<JsonValue, DecodeError> {
    decode(carrier.kind, carrier.version, &(carrier.build)(anchor))
}

fn decode(kind: &str, version: i64, data: &str) -> Result<JsonValue, DecodeError> {
    session_event::DurableEvent::decode(&envelope(kind, version, data))
        .map(|event| JsonValue::Object(event.0.data.0))
}

#[test]
fn valid_anchors_survive_decoding_on_every_carrier() {
    let expected = parse_json(ANCHOR).unwrap();
    for carrier in carriers() {
        let data = durable(&carrier, Some(ANCHOR)).unwrap();
        assert_eq!(
            (carrier.read)(&data),
            Some(expected.clone()),
            "{}",
            carrier.kind
        );
    }
}

#[test]
fn old_payloads_without_an_anchor_decode_and_stay_without_one() {
    for carrier in carriers() {
        let data = durable(&carrier, None).unwrap();
        assert_eq!((carrier.read)(&data), None, "{}", carrier.kind);
    }
}

#[test]
fn invalid_null_or_malformed_anchors_are_rejected_on_every_carrier() {
    for carrier in carriers() {
        for invalid in INVALID {
            assert!(
                durable(&carrier, Some(invalid)).is_err(),
                "{} accepted {invalid}",
                carrier.kind
            );
        }
    }
}

#[test]
fn the_first_compaction_admission_shape_never_carries_an_anchor() {
    let data = decode(
        "session.compaction.admitted",
        1,
        &format!(r#"{{"sessionID":"ses_child","inputID":"msg_child","usageAnchor":{ANCHOR}}}"#),
    )
    .unwrap();
    assert_eq!(field(&data, "usageAnchor"), None);
    assert!(field(&data, "inputID").is_some());
}

#[test]
fn public_durable_decoding_keeps_the_admission_anchor() {
    let event = session_event::PublicDurableEvent::decode(&envelope(
        "session.input.admitted",
        1,
        &admitted(Some(ANCHOR)),
    ))
    .unwrap();
    assert_eq!(
        field(&JsonValue::Object(event.0.data.0), "causedBy").cloned(),
        Some(parse_json(ANCHOR).unwrap())
    );
}

#[test]
fn a_launch_change_round_trips_its_anchor_exactly_and_without_one_stays_unchanged() {
    for anchor in [Some(ANCHOR), None] {
        let value = parse_json(&launched_change(anchor)).unwrap();
        assert_eq!(
            canonical(&Change::decode(&value).unwrap().encode()),
            canonical(&value)
        );
    }
}

#[test]
fn a_launch_change_rejects_invalid_anchors() {
    for invalid in INVALID {
        assert!(
            Change::decode(&parse_json(&launched_change(Some(invalid))).unwrap()).is_err(),
            "accepted {invalid}"
        );
    }
}

#[test]
fn anchors_are_not_part_of_any_other_launch_field() {
    let with = Change::decode(&parse_json(&launched_change(Some(ANCHOR))).unwrap())
        .unwrap()
        .encode();
    let without = Change::decode(&parse_json(&launched_change(None)).unwrap())
        .unwrap()
        .encode();
    for key in ["promptDigest", "inputID", "toolCallID", "description"] {
        assert_eq!(field(&with, key), field(&without, key), "{key}");
    }
}
