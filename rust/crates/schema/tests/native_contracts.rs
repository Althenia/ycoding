use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, dots, durable_event_manifest, event, event_manifest,
    form, guardrail, keep_awake, parse_json, permission, provider_request, stringify_json,
    tool_invocation, usage_dashboard,
};

fn round_trip<T: DomainDecode + DomainEncode>(json: &str) {
    let value = parse_json(json).unwrap();
    let encoded: serde_json::Value =
        serde_json::from_str(&stringify_json(&T::decode(&value).unwrap().encode())).unwrap();
    let expected: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(encoded, expected);
}

#[test]
fn current_provider_windows_preserve_optional_nonempty_groups() {
    round_trip::<ycoding_schema::provider_usage::Window>(
        r#"{"id":"fixture","label":"Fixture","group":"account","unit":"percent"}"#,
    );
    round_trip::<ycoding_schema::provider_usage::Window>(
        r#"{"id":"fixture","label":"Fixture","unit":"percent"}"#,
    );
    assert!(
        ycoding_schema::provider_usage::Window::decode(
            &parse_json(r#"{"id":"fixture","label":"Fixture","group":"","unit":"percent"}"#)
                .unwrap()
        )
        .is_err()
    );
}

#[test]
fn current_incident_decisions_use_client_provenance() {
    round_trip::<ycoding_schema::model_incident::DecidedBy>(r#""client""#);
    round_trip::<ycoding_schema::model_incident::DecidedBy>(r#""decision-model""#);
    assert!(
        ycoding_schema::model_incident::DecidedBy::decode(&parse_json(r#""human""#).unwrap())
            .is_err()
    );
}

#[test]
fn incident_reads_accept_only_the_current_decision_provenance() {
    for decided_by in ["decision-model", "client"] {
        round_trip::<ycoding_schema::model_incident::Recent>(&format!(
            r#"{{"items":[{{"id":"inc_fixture","time":0,"kind":"fallback","category":"fixture","ruleIDs":[],"agent":"fixture","decidedBy":"{decided_by}"}}]}}"#
        ));
    }
    round_trip::<ycoding_schema::model_incident::Recent>(
        r#"{"items":[{"id":"inc_fixture","time":0,"kind":"fallback","category":"fixture","ruleIDs":[],"agent":"fixture"}]}"#,
    );
    for decided_by in ["human", "robot"] {
        assert!(ycoding_schema::model_incident::Recent::decode(&parse_json(&format!(r#"{{"items":[{{"id":"inc_fixture","time":0,"kind":"fallback","category":"fixture","ruleIDs":[],"agent":"fixture","decidedBy":"{decided_by}"}}]}}"#)).unwrap()).is_err());
    }
}

#[test]
fn native_access_is_revision_fenced_and_status_does_not_serialize_credentials() {
    round_trip::<dots::AccessSet>(r#"{"enabled":true,"expectedRevision":0}"#);
    for json in [
        r#"{"enabled":true,"expectedRevision":-1}"#,
        r#"{"enabled":true,"expectedRevision":0,"unexpected":true}"#,
    ] {
        assert!(dots::AccessSet::decode(&parse_json(json).unwrap()).is_err());
    }
    let value = parse_json(r#"{"access":{"enabled":true,"revision":1},"configuration":{"ready":true,"profile":"fixture","credential":"not-a-secret"},"connection":{"state":"connected","hostname":"example.test"}}"#).unwrap();
    let encoded = stringify_json(&dots::NativeStatus::decode(&value).unwrap().encode());
    assert!(!encoded.contains("credential"));
    assert!(
        dots::NativeStatus::decode(&parse_json(&encoded.replace("fixture", "fixture\\n")).unwrap())
            .is_err()
    );
}

#[test]
fn native_reply_source_preserves_each_authority_fence() {
    round_trip::<form::NativeReplySource>(
        r#"{"kind":"dots-native","profile":"fixture","credentialID":"credential-fixture","accountID":"account-fixture","accountGeneration":0,"environmentID":"environment-fixture","connectionID":"connection-fixture","clientID":"client-fixture","streamID":"stream-fixture","rootSessionID":"ses_fixture","accessRevision":0,"requestID":"request-fixture"}"#,
    );
}

#[test]
fn nested_invocations_preserve_null_unknown_values_and_closed_status() {
    round_trip::<tool_invocation::Settled>(
        r#"{"id":"invocation","index":0,"name":"fixture.echo","tool":"echo","status":"completed","input":null,"structured":{"ok":true}}"#,
    );
    assert!(tool_invocation::Settled::decode(&parse_json(r#"{"id":"invocation","index":0,"name":"fixture.echo","tool":"echo","status":"unknown"}"#).unwrap()).is_err());
}

#[test]
fn dashboard_states_and_live_rates_have_closed_discriminants_and_bounds() {
    round_trip::<usage_dashboard::Info>(r#"{"status":"preparing"}"#);
    round_trip::<usage_dashboard::Info>(r#"{"status":"error","message":"fixture unavailable"}"#);
    round_trip::<usage_dashboard::Live>(
        r#"{"asOf":0,"active":0,"streaming":0,"models":[],"history":[]}"#,
    );
    round_trip::<usage_dashboard::LiveModel>(
        r#"{"model":{"providerID":"fixture","id":"fixture"},"active":0,"streaming":0,"outputTokensPerSecond":1}"#,
    );
    for json in [
        r#"{"model":{"providerID":"fixture","id":"fixture"},"active":0,"streaming":0,"outputTokensPerSecond":-1}"#,
        r#"{"model":{"providerID":"fixture","id":"fixture"},"active":0,"streaming":0,"outputTokensPerSecond":null}"#,
    ] {
        assert!(usage_dashboard::LiveModel::decode(&parse_json(json).unwrap()).is_err());
    }
    let value =
        parse_json(r#"{"asOf":0,"active":0,"streaming":0,"models":[],"history":[]}"#).unwrap();
    let JsonValue::Object(mut object) = value else {
        unreachable!()
    };
    object.insert(
        "history".into(),
        JsonValue::Array(vec![parse_json(r#"{"at":0,"active":0}"#).unwrap(); 121]),
    );
    assert!(usage_dashboard::Live::decode(&JsonValue::Object(object)).is_err());
}

#[test]
fn keep_awake_system_state_survives_the_native_boundary() {
    round_trip::<keep_awake::Status>(
        r#"{"state":"on","display":"on","activity":"off","system":"setup","lid":"held","manual":false,"deferHold":true}"#,
    );
    assert!(
        keep_awake::Status::decode(&parse_json(r#"{"state":"on","system":"unknown"}"#).unwrap())
            .is_err()
    );
}

fn exact<T: DomainDecode + DomainEncode>(json: &str) {
    let decoded = T::decode(&parse_json(json).unwrap()).unwrap();
    assert_eq!(stringify_json(&decoded.encode()), json);
}

const COORDINATION: &str =
    r#"{"reasons":[{"sessionID":"ses_member","reason":"Owner unavailable"}]}"#;
const ASSESSMENT: &str = r#"{"mode":"auto","sourceSessionID":"ses_helper","fields":[{"key":"choice","status":"assessed","reason":"Scoped option","grades":[{"choice":"a","confidence":0.9,"evidence":"Matches scope"}],"recommendation":["a"],"confidence":0.9},{"key":"note","status":"pending","reason":"Awaiting helper"}]}"#;

#[test]
fn provider_request_records_carry_the_usage_anchor_after_the_input() {
    let base = r#""id":"prq_1","sessionID":"ses_1","inputID":"msg_1""#;
    let rest = r#""assistantMessageID":"msg_2","source":"step","agent":"agent","model":{"id":"model","providerID":"openai"},"routeID":"route","promptCacheKey":"key","systemDigest":"system","toolDigest":"tools","request":1,"attempts":1,"invalidation":"first-request","continuation":"full","tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":0"#;
    exact::<provider_request::Record>(&format!(
        r#"{{{base},"usageAnchor":{{"sessionID":"ses_1","inputID":"msg_1"}},{rest}}}"#
    ));
    exact::<provider_request::Record>(&format!("{{{base},{rest}}}"));
    let anchored = provider_request::Record::decode(
        &parse_json(&format!(
            r#"{{{base},"usageAnchor":{{"sessionID":"ses_2","inputID":"msg_3"}},{rest}}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        anchored.usage_anchor.unwrap().input_id,
        ycoding_schema::session_message_id::Id::new("msg_3").unwrap()
    );
    assert!(
        provider_request::Record::decode(
            &parse_json(&format!(
                r#"{{{base},"usageAnchor":{{"sessionID":"ses_1"}},{rest}}}"#
            ))
            .unwrap()
        )
        .is_err()
    );
}

#[test]
fn permission_requests_carry_coordination_escalation_after_escalation() {
    let head = r#""id":"per_1","sessionID":"ses_1","action":"read","resources":["x"],"save":["x"],"metadata":{"k":1},"source":{"type":"tool","messageID":"msg_1","callID":"call"},"escalation":{"reason":"escalated"}"#;
    exact::<permission::Request>(&format!(
        r#"{{{head},"coordinationEscalation":{COORDINATION}}}"#
    ));
    exact::<permission::Request>(&format!("{{{head}}}"));
    exact::<permission::Request>(&format!(
        r#"{{"id":"per_1","sessionID":"ses_1","action":"read","resources":[],"coordinationEscalation":{COORDINATION}}}"#
    ));
    assert!(
        permission::Request::decode(
            &parse_json(
                r#"{"id":"per_1","sessionID":"ses_1","action":"read","resources":[],"coordinationEscalation":{}}"#
            )
            .unwrap()
        )
        .is_err()
    );
}

#[test]
fn form_info_orders_fields_then_coordination_escalation_then_assessment() {
    let head = r#""id":"frm_x","sessionID":"global","title":"t","metadata":{"k":1},"fields":[{"key":"choice","type":"string"}]"#;
    exact::<form::Info>(&format!(
        r#"{{{head},"coordinationEscalation":{COORDINATION},"assessment":{ASSESSMENT}}}"#
    ));
    exact::<form::Info>(&format!(r#"{{{head},"assessment":{ASSESSMENT}}}"#));
    exact::<form::Info>(&format!(
        r#"{{{head},"coordinationEscalation":{COORDINATION}}}"#
    ));
    exact::<form::Info>(&format!("{{{head}}}"));
}

#[test]
fn form_assessment_bounds_confidence_and_requires_nonblank_bounded_text() {
    exact::<form::Assessment>(ASSESSMENT);
    for invalid in [
        r#"{"mode":"manual","sourceSessionID":"s","fields":[{"key":"k","status":"unknown","reason":"r"}]}"#,
        r#"{"mode":"other","sourceSessionID":"s","fields":[]}"#,
        r#"{"mode":"manual","sourceSessionID":"s","fields":[{"key":"k","status":"pending","reason":"  "}]}"#,
        r#"{"mode":"manual","sourceSessionID":"s","fields":[{"key":"k","status":"assessed","reason":"r","confidence":1.5}]}"#,
        r#"{"mode":"manual","sourceSessionID":"s","fields":[{"key":"k","status":"assessed","reason":"r","grades":[{"choice":"a","confidence":0.5,"evidence":" "}]}]}"#,
    ] {
        assert!(
            form::Assessment::decode(&parse_json(invalid).unwrap()).is_err(),
            "{invalid}"
        );
    }
    let long = "x".repeat(501);
    assert!(
        form::Assessment::decode(
            &parse_json(&format!(
                r#"{{"mode":"manual","sourceSessionID":"s","fields":[{{"key":"k","status":"pending","reason":"{long}"}}]}}"#
            ))
            .unwrap()
        )
        .is_err()
    );
}

#[test]
fn form_assessed_is_a_live_event_in_the_server_manifest() {
    exact::<event::EphemeralPayload<form::Assessed>>(&format!(
        r#"{{"id":"evt_x","created":0,"type":"form.assessed","data":{{"id":"frm_x","sessionID":"global","assessment":{ASSESSMENT}}}}}"#
    ));
    assert_eq!(<form::Assessed as event::EventType>::TYPE, "form.assessed");
    assert!(event_manifest::ALL.contains(&"form.assessed"));
    assert!(event_manifest::SERVER.contains(&"form.assessed"));
    assert!(
        !durable_event_manifest::DURABLE
            .iter()
            .any(|name| name.starts_with("form.assessed"))
    );
}

#[test]
fn guardrail_requests_order_coordination_escalation_before_metadata_and_source_last() {
    let head = r#""id":"grq_x","rootSessionID":"ses_1","sessionID":"ses_1","action":"shell","resources":["x"],"ruleIDs":["r"],"reason":"why","standard":false,"hardReview":true,"risk":{"level":1,"label":"low","score":0.2,"metric":"confidence"},"escalation":{"reason":"low_confidence"}"#;
    let source = r#""source":{"messageID":"msg_1","callID":"call"}"#;
    exact::<guardrail::Request>(&format!(
        r#"{{{head},"coordinationEscalation":{COORDINATION},"metadata":{{"k":1}},{source}}}"#
    ));
    exact::<guardrail::Request>(&format!("{{{head},{source}}}"));
    exact::<guardrail::Request>(&format!(
        r#"{{{head},"coordinationEscalation":{COORDINATION}}}"#
    ));
    exact::<guardrail::Request>(&format!("{{{head}}}"));
    assert!(
        guardrail::Request::decode(
            &parse_json(&format!(r#"{{{head},"source":{{"messageID":"msg_1"}}}}"#)).unwrap()
        )
        .is_err()
    );
}

#[test]
fn native_status_carries_an_optional_computer_with_closed_state_and_bounded_message() {
    round_trip::<dots::NativeStatus>(
        r#"{"access":{"enabled":true,"revision":1},"configuration":{"ready":true},"connection":{"state":"connected"},"computer":{"state":"attached"}}"#,
    );
    round_trip::<dots::NativeStatus>(
        r#"{"access":{"enabled":true,"revision":1},"configuration":{"ready":true},"connection":{"state":"connected"},"computer":{"state":"detached","message":"ChatGPT refused the attach request."}}"#,
    );
    round_trip::<dots::NativeStatus>(
        r#"{"access":{"enabled":false,"revision":0},"configuration":{"ready":false},"connection":{"state":"unavailable"}}"#,
    );
    let status = |computer: &str| {
        format!(
            r#"{{"access":{{"enabled":true,"revision":1}},"configuration":{{"ready":true}},"connection":{{"state":"connected"}},"computer":{computer}}}"#
        )
    };
    for computer in [
        r#"{"state":"gone"}"#,
        r#"{}"#,
        r#"{"state":"attached","message":""}"#,
        r#"{"state":"attached","message":"line\nbreak"}"#,
        r#"{"state":"attached","message":1}"#,
        r#"null"#,
    ] {
        assert!(
            dots::NativeStatus::decode(&parse_json(&status(computer)).unwrap()).is_err(),
            "{computer}"
        );
    }
    let long = format!(r#"{{"state":"attached","message":"{}"}}"#, "m".repeat(501));
    assert!(dots::NativeStatus::decode(&parse_json(&status(&long)).unwrap()).is_err());
}

#[test]
fn computer_attach_accepts_any_boolean_without_excess_properties() {
    round_trip::<dots::ComputerAttach>(r#"{"replaceOthers":true}"#);
    round_trip::<dots::ComputerAttach>(r#"{"replaceOthers":false}"#);
    for json in [
        r#"{}"#,
        r#"{"replaceOthers":"true"}"#,
        r#"{"replaceOthers":1}"#,
        r#"{"replaceOthers":null}"#,
        r#"{"replaceOthers":true,"environmentID":"env_other"}"#,
        r#"true"#,
        r#"[]"#,
    ] {
        assert!(
            dots::ComputerAttach::decode(&parse_json(json).unwrap()).is_err(),
            "{json}"
        );
    }
}

const VALID_REVISION: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const COMPUTER_TARGET: &str = r#"{"dotID":"dot","threadID":"thread","environmentID":"environment","revision":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#;

#[test]
fn computer_attach_carries_an_optional_strict_expected_target() {
    round_trip::<dots::ComputerAttach>(&format!(
        r#"{{"replaceOthers":true,"expectedTarget":{COMPUTER_TARGET}}}"#
    ));
    round_trip::<dots::ComputerAttach>(&format!(
        r#"{{"replaceOthers":false,"expectedTarget":{COMPUTER_TARGET}}}"#
    ));
    let max = "x".repeat(256);
    round_trip::<dots::ComputerAttach>(&format!(
        r#"{{"replaceOthers":true,"expectedTarget":{{"dotID":"{max}","threadID":"{max}","environmentID":"{max}","revision":"{}"}}}}"#,
        "f".repeat(64)
    ));
    let long = "x".repeat(257);
    for target in [
        r#"{"dotID":"","threadID":"thread","environmentID":"environment","revision":"REVISION"}"#.to_owned(),
        r#"{"dotID":"dot","threadID":"","environmentID":"environment","revision":"REVISION"}"#.to_owned(),
        r#"{"dotID":"dot","threadID":"thread","environmentID":"","revision":"REVISION"}"#.to_owned(),
        format!(r#"{{"dotID":"{long}","threadID":"thread","environmentID":"environment","revision":"REVISION"}}"#),
        format!(r#"{{"dotID":"dot","threadID":"{long}","environmentID":"environment","revision":"REVISION"}}"#),
        format!(r#"{{"dotID":"dot","threadID":"thread","environmentID":"{long}","revision":"REVISION"}}"#),
        r#"{"dotID":"dot","threadID":"thread","environmentID":"environment"}"#.to_owned(),
        r#"{"dotID":"dot","threadID":"thread","revision":"REVISION"}"#.to_owned(),
        r#"{"dotID":"dot","threadID":"thread","environmentID":"environment","revision":"REVISION","profile":"p"}"#.to_owned(),
        r#"{"dotID":1,"threadID":"thread","environmentID":"environment","revision":"REVISION"}"#.to_owned(),
        "null".to_owned(),
    ] {
        let json = format!(
            r#"{{"replaceOthers":true,"expectedTarget":{}}}"#,
            target.replace("REVISION", VALID_REVISION)
        );
        assert!(
            dots::ComputerAttach::decode(&parse_json(&json).unwrap()).is_err(),
            "{json}"
        );
    }
    for revision in [
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeF",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg",
        "",
    ] {
        let json = format!(
            r#"{{"replaceOthers":true,"expectedTarget":{{"dotID":"dot","threadID":"thread","environmentID":"environment","revision":"{revision}"}}}}"#
        );
        assert!(
            dots::ComputerAttach::decode(&parse_json(&json).unwrap()).is_err(),
            "{json}"
        );
    }
    for json in [
        r#"{"replaceOthers":true,"expectedTarget":null}"#.to_owned(),
        format!(r#"{{"expectedTarget":{COMPUTER_TARGET}}}"#),
    ] {
        assert!(
            dots::ComputerAttach::decode(&parse_json(&json).unwrap()).is_err(),
            "{json}"
        );
    }
}

#[test]
fn native_status_carries_validated_connection_and_computer_names_and_computer_target() {
    let status = |connection: &str, computer: &str| {
        format!(
            r#"{{"access":{{"enabled":true,"revision":1}},"configuration":{{"ready":true}},"connection":{connection},"computer":{computer}}}"#
        )
    };
    for (connection, computer) in [
        (
            r#"{"state":"connected","name":"Synthetic Name"}"#.to_owned(),
            r#"{"state":"attached"}"#.to_owned(),
        ),
        (
            r#"{"state":"connected","hostname":"Synthetic.local","name":"Synthetic Name","message":"Fixture message"}"#.to_owned(),
            format!(r#"{{"state":"detached","name":"Synthetic Computer","target":{COMPUTER_TARGET},"message":"Fixture message"}}"#),
        ),
        (
            r#"{"state":"connected"}"#.to_owned(),
            r#"{"state":"detached","name":"Synthetic Computer"}"#.to_owned(),
        ),
        (
            r#"{"state":"connected"}"#.to_owned(),
            format!(r#"{{"state":"unavailable","target":{COMPUTER_TARGET}}}"#),
        ),
    ] {
        round_trip::<dots::NativeStatus>(&status(&connection, &computer));
    }
    let long = "n".repeat(257);
    let max = "n".repeat(256);
    round_trip::<dots::NativeStatus>(&status(
        &format!(r#"{{"state":"connected","name":"{max}"}}"#),
        &format!(r#"{{"state":"attached","name":"{max}"}}"#),
    ));
    for (connection, computer) in [
        (r#"{"state":"connected","name":""}"#.to_owned(), r#"{"state":"attached"}"#.to_owned()),
        (r#"{"state":"connected","name":"line\nbreak"}"#.to_owned(), r#"{"state":"attached"}"#.to_owned()),
        (r#"{"state":"connected","name":"\u0085"}"#.to_owned(), r#"{"state":"attached"}"#.to_owned()),
        (format!(r#"{{"state":"connected","name":"{long}"}}"#), r#"{"state":"attached"}"#.to_owned()),
        (r#"{"state":"connected","name":1}"#.to_owned(), r#"{"state":"attached"}"#.to_owned()),
        (r#"{"state":"connected"}"#.to_owned(), r#"{"state":"attached","name":""}"#.to_owned()),
        (r#"{"state":"connected"}"#.to_owned(), r#"{"state":"attached","name":"tab\there"}"#.to_owned()),
        (r#"{"state":"connected"}"#.to_owned(), format!(r#"{{"state":"attached","name":"{long}"}}"#)),
        (r#"{"state":"connected"}"#.to_owned(), r#"{"state":"attached","target":null}"#.to_owned()),
        (
            r#"{"state":"connected"}"#.to_owned(),
            r#"{"state":"attached","target":{"dotID":"dot","threadID":"thread","environmentID":"environment","revision":"ABCDEF"}}"#.to_owned(),
        ),
    ] {
        assert!(
            dots::NativeStatus::decode(&parse_json(&status(&connection, &computer)).unwrap())
                .is_err(),
            "{connection} {computer}"
        );
    }
}
