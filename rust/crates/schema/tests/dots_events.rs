use ycoding_schema::{
    DecodeError, DomainDecode, JsonValue, LosslessString, durable_event_manifest, event,
    event_manifest, parse_json, session_event, stringify_json,
};

const PRINCIPAL: &str = r#"{"ownerID":"owner","deviceID":"device","clientID":"client"}"#;
const TARGET: &str =
    r#"{"profile":"work","dotID":"dot","threadID":"thread","generation":"g1","label":"Dot"}"#;
const SOURCE: &str = r#"{"requestID":"req","principal":{"ownerID":"owner","deviceID":"device","clientID":"client"},"epoch":"epoch"}"#;
const TASK_ENVELOPE: &str = r#"{"coordinator":{"ownerID":"owner","deviceID":"device","clientID":"client"},"scope":{"epoch":"epoch","grantID":"grant"},"exchangeID":"ex","messageID":"msg_task","kind":"task","origin":"plugin","targetSessionID":"ses_target"}"#;

fn report_envelope(kind: &str, origin: &str) -> String {
    format!(
        r#"{{"coordinator":{PRINCIPAL},"scope":{{"epoch":"epoch","grantID":"grant"}},"exchangeID":"ex","messageID":"msg_report","kind":"{kind}","origin":"{origin}","sourceSessionID":"ses_target","replyToMessageID":"msg_task"}}"#
    )
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn envelope(kind: &str, version: i64, data: &str) -> JsonValue {
    json(&format!(
        r#"{{"id":"evt_dots","created":1,"type":"{kind}","durable":{{"aggregateID":"ses_anchor","seq":0,"version":{version}}},"data":{data}}}"#
    ))
}

fn durable(kind: &str, data: &str) -> Result<JsonValue, DecodeError> {
    session_event::DurableEvent::decode(&envelope(kind, 1, data))
        .map(|event| JsonValue::Object(event.0.data.0))
}

fn public(kind: &str, data: &str) -> Result<JsonValue, DecodeError> {
    session_event::PublicDurableEvent::decode(&envelope(kind, 1, data))
        .map(|event| JsonValue::Object(event.0.data.0))
}

fn canon(value: &JsonValue) -> String {
    match value {
        JsonValue::Object(object) => {
            let mut items = object
                .iter()
                .map(|(key, value)| (key.to_utf8().unwrap(), canon(value)))
                .collect::<Vec<_>>();
            items.sort();
            let items = items
                .iter()
                .map(|(key, value)| format!("{key:?}:{value}"))
                .collect::<Vec<_>>();
            format!("{{{}}}", items.join(","))
        }
        JsonValue::Array(items) => {
            let items = items.iter().map(canon).collect::<Vec<_>>();
            format!("[{}]", items.join(","))
        }
        other => stringify_json(other),
    }
}

fn assert_same(actual: &JsonValue, expected: &JsonValue) {
    assert_eq!(canon(actual), canon(expected));
}

fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

fn has(list: &[LosslessString], value: &str) -> bool {
    list.iter().any(|item| item.as_str() == Some(value))
}

fn exchange_created(patch: impl Fn(&mut Vec<String>)) -> String {
    let mut fields = vec![
        r#""exchangeID":"ex""#.to_owned(),
        r#""sessionID":"ses_anchor""#.to_owned(),
        r#""targetSessionID":"ses_target""#.to_owned(),
        r#""inputID":"msg_task""#.to_owned(),
        format!(r#""expectedAttachment":{TARGET}"#),
        r#""accountDigest":"digest""#.to_owned(),
        r#""fingerprint":"fingerprint""#.to_owned(),
        format!(r#""source":{SOURCE}"#),
        r#""grantID":"grant""#.to_owned(),
        r#""scope":{"rootSessionID":"ses_target"}"#.to_owned(),
    ];
    patch(&mut fields);
    format!("{{{}}}", fields.join(","))
}

fn replace(fields: &mut [String], key: &str, value: &str) {
    let prefix = format!("\"{key}\":");
    *fields
        .iter_mut()
        .find(|field| field.starts_with(&prefix))
        .unwrap_or_else(|| panic!("missing {key}")) = format!("{prefix}{value}");
}

fn remove(fields: &mut Vec<String>, key: &str) {
    let prefix = format!("\"{key}\":");
    fields.retain(|field| !field.starts_with(&prefix));
}

const DOTS_EVENTS: [&str; 9] = [
    "session.dots.access.changed",
    "session.dots.exchange.created",
    "session.dots.binding.bound",
    "session.dots.binding.unbound",
    "session.dots.device-delegation.created",
    "session.dots.device-delegation.revoked",
    "session.dots.decision.settled",
    "session.dots.instruction.rejected",
    "session.dots.report.recorded",
];

#[test]
fn all_nine_dots_events_are_public_durable_manifest_entries() {
    let all = event_manifest::definitions();
    let server = event_manifest::server_definitions();
    let durable_types = durable_event_manifest::definitions();
    let versioned = durable_event_manifest::versioned_types();
    for name in DOTS_EVENTS {
        assert!(has(&all, name), "{name}");
        assert!(has(&server, name), "{name}");
        assert!(has(&durable_types, &format!("{name}.1")), "{name}");
        assert!(has(&versioned, &format!("{name}.1")), "{name}");
    }
}

#[test]
fn all_nine_dots_payloads_decode_through_public_and_durable_event_boundaries() {
    let principal = r#"{"ownerID":"owner","deviceID":"device","clientID":"client","grantID":"grant","epoch":"epoch"}"#;
    let source = r#"{"kind":"dots-native","profile":"fixture","credentialID":"credential","accountID":"account","accountGeneration":0,"environmentID":"environment","connectionID":"connection","clientID":"client","streamID":"stream","rootSessionID":"ses_anchor","accessRevision":0,"requestID":"request"}"#;
    let fingerprint = "a".repeat(64);
    let payloads = [
        ("session.dots.access.changed", r#"{"sessionID":"ses_anchor","enabled":false,"revision":0}"#.to_owned()),
        ("session.dots.exchange.created", exchange_created(|_| {})),
        ("session.dots.binding.bound", format!(r#"{{"sessionID":"ses_anchor","binding":{{"id":"binding","target":{TARGET},"accountDigest":"digest"}}}}"#)),
        ("session.dots.binding.unbound", r#"{"sessionID":"ses_anchor","bindingID":"binding"}"#.to_owned()),
        ("session.dots.device-delegation.created", format!(r#"{{"sessionID":"ses_anchor","exchangeID":"exchange","fingerprint":"{fingerprint}","grant":{{"id":"delegation","revision":1,"basis":"device","anchorSessionID":"ses_anchor","bindingID":"binding","principal":{principal},"scope":{{"target":"device","operations":["task","decision"]}},"expiresAt":1,"active":true}}}}"#)),
        ("session.dots.device-delegation.revoked", format!(r#"{{"sessionID":"ses_anchor","exchangeID":"exchange","fingerprint":"{fingerprint}","delegationID":"delegation","revision":1,"principal":{principal}}}"#)),
        ("session.dots.decision.settled", format!(r#"{{"sessionID":"ses_anchor","source":{source},"target":{{"kind":"permission","requestID":"per_fixture","fingerprint":"{fingerprint}"}},"reply":"once"}}"#)),
        ("session.dots.instruction.rejected", r#"{"sessionID":"ses_anchor","inputID":"msg_task","anchorSessionID":"ses_anchor","exchangeID":"exchange","delegationID":"delegation","reason":"delegation_invalid"}"#.to_owned()),
        ("session.dots.report.recorded", format!(r#"{{"sessionID":"ses_anchor","deliveryID":"delivery","messageID":"msg_report","text":"fixture result","envelope":{},"callID":"call"}}"#, report_envelope("completion", "agent"))),
    ];
    for (name, payload) in payloads {
        assert_same(
            &durable(name, &payload).unwrap_or_else(|error| panic!("{name}: {error:?}")),
            &json(&payload),
        );
        assert_same(
            &public(name, &payload).unwrap_or_else(|error| panic!("{name}: {error:?}")),
            &json(&payload),
        );
        assert!(
            session_event::DurableEvent::decode(&envelope(name, 2, &payload)).is_err(),
            "{name}"
        );
    }
}

#[test]
fn all_nine_dots_events_are_version_one_durable_definitions_aggregated_by_session() {
    for definitions in [
        session_event::definitions(),
        session_event::durable_definitions(),
        session_event::public_durable_definitions(),
    ] {
        for name in DOTS_EVENTS {
            let found = definitions
                .iter()
                .filter(|definition| definition.event_type.as_str() == Some(name))
                .collect::<Vec<_>>();
            assert_eq!(found.len(), 1, "{name}");
            let event::Durability::Durable { version, aggregate } = &found[0].durability else {
                panic!("{name} must be durable")
            };
            assert_eq!(version.get(), 1, "{name}");
            assert_eq!(aggregate.as_str(), Some("sessionID"), "{name}");
        }
    }
    assert!(has(&session_event::all_event_types(), DOTS_EVENTS[0]));
    for name in DOTS_EVENTS {
        let wrong_version = envelope(name, 2, "{}");
        assert!(session_event::DurableEvent::decode(&wrong_version).is_err());
    }
}

#[test]
fn an_exchange_record_event_keeps_the_complete_record_and_optional_routine_and_scope_owners() {
    let decoded = public("session.dots.exchange.created", &exchange_created(|_| {})).unwrap();
    for key in [
        "exchangeID",
        "sessionID",
        "targetSessionID",
        "inputID",
        "expectedAttachment",
        "accountDigest",
        "fingerprint",
        "source",
        "grantID",
        "scope",
    ] {
        assert!(field(&decoded, key).is_some(), "{key}");
    }
    assert!(field(&decoded, "routine").is_none());
    assert_eq!(
        field(field(&decoded, "scope").unwrap(), "groupID"),
        None,
        "an absent coordination group stays absent"
    );

    let routine = r#"{"delegation":{"id":"del","revision":2},"taskInputID":"msg_task","instruction":{"operation":"presentation","preferences":{"format":"bullets"}}}"#;
    let scope = r#"{"rootSessionID":"ses_target","groupID":"grp","ownerSessionID":"ses_owner"}"#;
    let full = durable(
        "session.dots.exchange.created",
        &exchange_created(|fields| {
            fields.push(format!(r#""routine":{routine}"#));
            replace(fields, "scope", scope);
        }),
    )
    .unwrap();
    assert_same(field(&full, "routine").unwrap(), &json(routine));
    assert_same(field(&full, "scope").unwrap(), &json(scope));
}

#[test]
fn an_exchange_record_event_strips_unknown_fields_and_canonicalizes_nested_values() {
    let decoded = public(
        "session.dots.exchange.created",
        &exchange_created(|fields| {
            fields.push(r#""unknown":true"#.to_owned());
            replace(
                fields,
                "expectedAttachment",
                r#"{"profile":"work","dotID":"dot","threadID":"thread","generation":"g1","label":"","extra":1}"#,
            );
        }),
    )
    .unwrap();
    assert!(field(&decoded, "unknown").is_none());
    assert_same(
        field(&decoded, "expectedAttachment").unwrap(),
        &json(
            r#"{"profile":"work","dotID":"dot","threadID":"thread","generation":"g1","label":""}"#,
        ),
    );
}

#[test]
fn an_exchange_record_event_rejects_each_invalid_identity_and_nested_value() {
    let long = "x".repeat(257);
    let accepted = "x".repeat(256);
    assert!(
        public(
            "session.dots.exchange.created",
            &exchange_created(|fields| replace(fields, "exchangeID", &format!(r#""{accepted}""#)))
        )
        .is_ok()
    );
    type InvalidExchange = (&'static str, Box<dyn Fn(&mut Vec<String>)>);
    let cases: Vec<InvalidExchange> = vec![
        ("missing exchangeID", Box::new(|f| remove(f, "exchangeID"))),
        (
            "empty exchangeID",
            Box::new(|f| replace(f, "exchangeID", r#""""#)),
        ),
        (
            "oversized exchangeID",
            Box::new(move |f| replace(f, "exchangeID", &format!(r#""{long}""#))),
        ),
        (
            "unprefixed session",
            Box::new(|f| replace(f, "sessionID", r#""anchor""#)),
        ),
        (
            "unprefixed target session",
            Box::new(|f| replace(f, "targetSessionID", r#""target""#)),
        ),
        (
            "unprefixed input",
            Box::new(|f| replace(f, "inputID", r#""task""#)),
        ),
        (
            "empty profile",
            Box::new(|f| {
                replace(
                    f,
                    "expectedAttachment",
                    r#"{"profile":"","dotID":"dot","threadID":"thread","generation":"g1","label":"Dot"}"#,
                )
            }),
        ),
        (
            "missing attachment label",
            Box::new(|f| {
                replace(
                    f,
                    "expectedAttachment",
                    r#"{"profile":"work","dotID":"dot","threadID":"thread","generation":"g1"}"#,
                )
            }),
        ),
        (
            "empty digest",
            Box::new(|f| replace(f, "accountDigest", r#""""#)),
        ),
        (
            "empty fingerprint",
            Box::new(|f| replace(f, "fingerprint", r#""""#)),
        ),
        ("empty grant", Box::new(|f| replace(f, "grantID", r#""""#))),
        (
            "source without principal",
            Box::new(|f| replace(f, "source", r#"{"requestID":"req","epoch":"epoch"}"#)),
        ),
        (
            "scope without root",
            Box::new(|f| replace(f, "scope", r#"{"groupID":"grp"}"#)),
        ),
        (
            "scope with empty group",
            Box::new(|f| replace(f, "scope", r#"{"rootSessionID":"ses_target","groupID":""}"#)),
        ),
        (
            "routine revision zero",
            Box::new(|f| {
                f.push(
                    r#""routine":{"delegation":{"id":"del","revision":0},"taskInputID":"msg_task","instruction":{"operation":"continue"}}"#.to_owned(),
                )
            }),
        ),
        (
            "routine with unknown operation",
            Box::new(|f| {
                f.push(
                    r#""routine":{"delegation":{"id":"del","revision":1},"taskInputID":"msg_task","instruction":{"operation":"stop"}}"#.to_owned(),
                )
            }),
        ),
        (
            "null routine",
            Box::new(|f| f.push(r#""routine":null"#.to_owned())),
        ),
    ];
    for (label, patch) in cases {
        for decode in [durable, public] {
            assert!(
                decode("session.dots.exchange.created", &exchange_created(&patch)).is_err(),
                "{label}"
            );
        }
    }
}

#[test]
fn a_rejected_instruction_names_the_input_anchor_exchange_and_delegation() {
    let valid = r#"{"sessionID":"ses_target","inputID":"msg_task","anchorSessionID":"ses_anchor","exchangeID":"ex","delegationID":"del","reason":"delegation_invalid"}"#;
    let decoded = public("session.dots.instruction.rejected", valid).unwrap();
    assert_same(&decoded, &json(valid));
    let stripped = durable(
        "session.dots.instruction.rejected",
        &valid.replace(r#""reason""#, r#""unknown":true,"reason""#),
    )
    .unwrap();
    assert_same(&stripped, &json(valid));
    for invalid in [
        valid.replace("delegation_invalid", "expired"),
        valid.replace(r#""sessionID":"ses_target","#, ""),
        valid.replace(r#""anchorSessionID":"ses_anchor","#, ""),
        valid.replace(
            r#""anchorSessionID":"ses_anchor""#,
            r#""anchorSessionID":"anchor""#,
        ),
        valid.replace(r#""inputID":"msg_task""#, r#""inputID":"task""#),
        valid.replace(r#""exchangeID":"ex""#, r#""exchangeID":"""#),
        valid.replace(r#""delegationID":"del""#, r#""delegationID":"""#),
        valid.replace(r#""reason":"delegation_invalid""#, r#""reason":null"#),
    ] {
        assert!(durable("session.dots.instruction.rejected", &invalid).is_err());
        assert!(public("session.dots.instruction.rejected", &invalid).is_err());
    }
    assert!(durable("session.dots.instruction.rejected", "{}").is_err());
}

#[test]
fn a_recorded_report_carries_one_agent_envelope_text_and_call_identity() {
    for kind in ["progress", "blocker", "decision_request", "completion"] {
        let valid = format!(
            r#"{{"sessionID":"ses_target","deliveryID":"delivery","messageID":"msg_report","text":"","envelope":{},"callID":"call"}}"#,
            report_envelope(kind, "agent")
        );
        let decoded = public("session.dots.report.recorded", &valid).unwrap();
        assert_same(&decoded, &json(&valid));
    }
    let valid = format!(
        r#"{{"sessionID":"ses_target","deliveryID":"delivery","messageID":"msg_report","text":"Done","envelope":{},"callID":"call"}}"#,
        report_envelope("progress", "agent")
    );
    for invalid in [
        valid.replace(r#""callID":"call""#, r#""unused":0"#),
        valid.replace(r#""deliveryID":"delivery","#, ""),
        valid.replace(r#""deliveryID":"delivery""#, r#""deliveryID":"""#),
        valid.replace(
            r#""messageID":"msg_report","text""#,
            r#""messageID":"report","text""#,
        ),
        valid.replace(r#""origin":"agent""#, r#""origin":"plugin""#),
        valid.replace(r#""kind":"progress""#, r#""kind":"task""#),
        valid.replace(r#""kind":"progress""#, r#""kind":"result""#),
        valid.replace(r#""sourceSessionID":"ses_target","#, ""),
        valid.replace(
            r#""replyToMessageID":"msg_task""#,
            r#""replyToMessageID":"task""#,
        ),
        valid.replace(
            r#""scope":{"epoch":"epoch","grantID":"grant"}"#,
            r#""scope":{"epoch":"epoch"}"#,
        ),
        valid.replace(
            r#""sessionID":"ses_target","deliveryID""#,
            r#""sessionID":"target","deliveryID""#,
        ),
    ] {
        assert!(
            durable("session.dots.report.recorded", &invalid).is_err(),
            "{invalid}"
        );
        assert!(
            public("session.dots.report.recorded", &invalid).is_err(),
            "{invalid}"
        );
    }
}

#[test]
fn context_observation_accepts_the_dots_source_with_an_optional_typed_coordination_context() {
    let plain = r#"{"sessionID":"ses_target","source":"dots","text":"Dots coordination"}"#;
    assert_same(
        &public("session.context.observed", plain).unwrap(),
        &json(plain),
    );
    let enabled = format!(
        r#"{{"sessionID":"ses_target","source":"dots","text":"on","dots":{{"state":"enabled","generation":3,"tool":"dots_report","envelope":{TASK_ENVELOPE},"routine":{{"delegation":{{"id":"del","revision":1}},"taskInputID":"msg_task","instruction":{{"operation":"continue"}}}}}}}}"#
    );
    assert_same(
        &durable("session.context.observed", &enabled).unwrap(),
        &json(&enabled),
    );
    for reason in [
        "capability_disabled",
        "no_task",
        "task_settled",
        "unavailable",
        "tool_unavailable",
    ] {
        let disabled = format!(
            r#"{{"sessionID":"ses_target","source":"dots","text":"off","dots":{{"state":"disabled","generation":1,"reason":"{reason}"}}}}"#
        );
        assert_same(
            &durable("session.context.observed", &disabled).unwrap(),
            &json(&disabled),
        );
    }
    for source in ["session-state", "team-view", "step-limit"] {
        let existing = format!(r#"{{"sessionID":"ses_target","source":"{source}","text":"a"}}"#);
        assert!(
            public("session.context.observed", &existing).is_ok(),
            "{source}"
        );
    }
    for invalid in [
        r#"{"sessionID":"ses_target","source":"dot","text":"a"}"#.to_owned(),
        r#"{"sessionID":"ses_target","source":"dots","text":"a","dots":null}"#.to_owned(),
        r#"{"sessionID":"ses_target","source":"dots","text":"a","dots":{"state":"paused","generation":1}}"#.to_owned(),
        r#"{"sessionID":"ses_target","source":"dots","text":"a","dots":{"state":"disabled","generation":0,"reason":"no_task"}}"#.to_owned(),
        r#"{"sessionID":"ses_target","source":"dots","text":"a","dots":{"state":"disabled","generation":1,"reason":"other"}}"#.to_owned(),
        r#"{"sessionID":"ses_target","source":"dots","text":"a","dots":{"state":"disabled","generation":1}}"#.to_owned(),
        enabled.replace(r#""tool":"dots_report""#, r#""tool":"dots_send""#),
        enabled.replace(r#""origin":"plugin""#, r#""origin":"agent""#),
        enabled.replace(r#""generation":3"#, r#""generation":1.5"#),
    ] {
        assert!(durable("session.context.observed", &invalid).is_err(), "{invalid}");
        assert!(public("session.context.observed", &invalid).is_err(), "{invalid}");
    }
}
