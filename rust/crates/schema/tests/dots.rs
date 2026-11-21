use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue,
    dots::{
        Control, CoordinationContext, DelegationCreate, DelegationInfo, DelegationRef,
        DelegationReview, DelegationRevoke, DelegationScope, DelegationStatus,
        DelegationStatusInput, Delivery, DeliveryStatus, Envelope, ErrorCode, Exchange,
        ExchangeCreate, ExchangeMetadata, ExchangeOutput, ExchangeRead, ExchangeRecord,
        ExchangeState, Peer, PresentationPreferences, ReportEnvelope, ReportKind,
        RoutineInstruction, RoutineReceipt, RuntimeState, Send, State, Status, Target,
        TaskEnvelope,
    },
    parse_json,
};

const TARGET: &str =
    r#"{"profile":"work","dotID":"dot","threadID":"thread","generation":"g1","label":"Dot"}"#;
const CONTEXT_PRINCIPAL: &str = r#"{"ownerID":"owner","deviceID":"device","clientID":"client"}"#;
const PRINCIPAL: &str = r#"{"ownerID":"owner","deviceID":"device","clientID":"client","grantID":"grant","epoch":"epoch"}"#;
const SOURCE: &str = r#"{"requestID":"req","principal":{"ownerID":"owner","deviceID":"device","clientID":"client"},"epoch":"epoch"}"#;
const TASK: &str = r#"{"coordinator":{"ownerID":"owner","deviceID":"device","clientID":"client"},"scope":{"epoch":"epoch","grantID":"grant"},"exchangeID":"ex","messageID":"msg_task","kind":"task","origin":"plugin","targetSessionID":"ses_target"}"#;
const REPORT: &str = r#"{"coordinator":{"ownerID":"owner","deviceID":"device","clientID":"client"},"scope":{"epoch":"epoch","grantID":"grant"},"exchangeID":"ex","messageID":"msg_report","kind":"progress","origin":"agent","sourceSessionID":"ses_target","replyToMessageID":"msg_task"}"#;
const OUTPUT: &str = r#"{"deliveryID":"delivery","messageID":"msg_report","text":"Done","envelope":{"coordinator":{"ownerID":"owner","deviceID":"device","clientID":"client"},"scope":{"epoch":"epoch","grantID":"grant"},"exchangeID":"ex","messageID":"msg_report","kind":"progress","origin":"agent","sourceSessionID":"ses_target","replyToMessageID":"msg_task"}}"#;
const ROUTINE: &str = r#"{"delegation":{"id":"del","revision":2},"taskInputID":"msg_task","instruction":{"operation":"continue"}}"#;
const SCOPE: &str = r#"{"operations":["continue"]}"#;

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
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
        other => ycoding_schema::stringify_json(other),
    }
}

fn keeps<T: DomainDecode + DomainEncode>(input: &str) {
    stripped::<T>(input, input);
}

fn stripped<T: DomainDecode + DomainEncode>(input: &str, expected: &str) {
    let decoded = T::decode(&json(input)).unwrap_or_else(|error| panic!("{input}: {error:?}"));
    assert_eq!(canon(&decoded.encode()), canon(&json(expected)), "{input}");
}

fn rejects<T: DomainDecode>(input: &str) {
    assert!(T::decode(&json(input)).is_err(), "{input}");
}

fn literals<T: DomainDecode + DomainEncode>(accepted: &[&str], rejected: &[&str]) {
    for value in accepted {
        let text = format!(r#""{value}""#);
        let decoded = T::decode(&json(&text)).unwrap_or_else(|error| panic!("{text}: {error:?}"));
        assert_eq!(decoded.encode(), json(&text));
    }
    for value in rejected {
        rejects::<T>(&format!(r#""{value}""#));
    }
    for value in ["1", "true", "null", "[]", "{}"] {
        rejects::<T>(value);
    }
}

#[test]
fn closed_literal_sets_accept_exactly_their_documented_values() {
    literals::<State>(
        &["disconnected", "connecting", "connected", "failed"],
        &["", "Connected", "unknown", "paused"],
    );
    literals::<RuntimeState>(
        &["paused", "unpaused", "unknown"],
        &["", "running", "Paused"],
    );
    literals::<DeliveryStatus>(&["accepted", "unknown"], &["", "failed", "sent"]);
    literals::<ExchangeState>(
        &["pending", "running", "completed", "failed", "unknown"],
        &["", "done", "Pending"],
    );
    literals::<ReportKind>(
        &["progress", "blocker", "decision_request", "completion"],
        &["", "task", "result"],
    );
    literals::<ErrorCode>(
        &[
            "feature_disabled",
            "invalid_input",
            "session_not_found",
            "profile_unavailable",
            "profile_changed",
            "authentication_failed",
            "target_unavailable",
            "target_in_use",
            "target_changed",
            "not_bound",
            "connection_unavailable",
            "attachment_invalid",
            "send_failed",
            "runtime_unknown",
            "control_failed",
            "exchange_conflict",
            "exchange_not_found",
            "target_forbidden",
            "authorization_failed",
            "exchange_outcome_unknown",
        ],
        &["", "Target_Changed", "internal_error", "outcome_unknown"],
    );
    for code in [
        "target_changed",
        "exchange_outcome_unknown",
        "feature_disabled",
    ] {
        let decoded = ErrorCode::decode(&json(&format!(r#""{code}""#))).unwrap();
        assert_eq!(decoded.as_str(), code);
    }
}

#[test]
fn a_target_needs_four_nonempty_identities_and_keeps_any_label() {
    keeps::<Target>(TARGET);
    keeps::<Target>(r#"{"profile":"p","dotID":"d","threadID":"t","generation":"g","label":""}"#);
    stripped::<Target>(
        r#"{"profile":"p","dotID":"d","threadID":"t","generation":"g","label":"x","extra":1}"#,
        r#"{"profile":"p","dotID":"d","threadID":"t","generation":"g","label":"x"}"#,
    );
    for missing in ["profile", "dotID", "threadID", "generation", "label"] {
        let JsonValue::Object(object) = json(TARGET) else {
            unreachable!()
        };
        let rebuilt = object
            .iter()
            .filter(|(key, _)| key.as_str() != Some(missing))
            .map(|(key, value)| format!("{:?}:{}", key.to_utf8().unwrap(), canon(value)))
            .collect::<Vec<_>>();
        rejects::<Target>(&format!("{{{}}}", rebuilt.join(",")));
    }
    rejects::<Target>(r#"{"profile":"","dotID":"d","threadID":"t","generation":"g","label":"x"}"#);
    rejects::<Target>(r#"{"profile":"p","dotID":"","threadID":"t","generation":"g","label":"x"}"#);
    rejects::<Target>(r#"{"profile":"p","dotID":"d","threadID":"","generation":"g","label":"x"}"#);
    rejects::<Target>(r#"{"profile":"p","dotID":"d","threadID":"t","generation":"","label":"x"}"#);
    rejects::<Target>(r#"{"profile":"p","dotID":"d","threadID":"t","generation":1,"label":"x"}"#);
    rejects::<Target>("null");
    rejects::<Target>("[]");
}

#[test]
fn status_requires_an_enabled_flag_and_a_state_and_keeps_only_present_optionals() {
    keeps::<Status>(r#"{"enabled":false,"state":"disconnected"}"#);
    keeps::<Status>(&format!(
        r#"{{"enabled":true,"target":{TARGET},"state":"connected","error":"","runtimeState":"unknown"}}"#
    ));
    for invalid in [
        r#"{"state":"connected"}"#,
        r#"{"enabled":true}"#,
        r#"{"enabled":"yes","state":"connected"}"#,
        r#"{"enabled":true,"state":"open"}"#,
        r#"{"enabled":true,"state":"connected","runtimeState":"running"}"#,
        r#"{"enabled":true,"state":"connected","error":null}"#,
        r#"{"enabled":true,"state":"connected","target":{}}"#,
    ] {
        rejects::<Status>(invalid);
    }
    keeps::<Control>(&format!(r#"{{"expectedTarget":{TARGET}}}"#));
    rejects::<Control>("{}");
    rejects::<Control>(r#"{"expectedTarget":{"profile":"p"}}"#);
}

#[test]
fn a_send_carries_an_identity_text_files_and_the_confirmed_target() {
    keeps::<Send>(&format!(
        r#"{{"id":"send","text":"","expectedTarget":{TARGET}}}"#
    ));
    keeps::<Send>(&format!(
        r#"{{"id":"send","text":"hello","files":[{{"uri":"file:///work/a.txt"}}],"causalMessageID":"cause","expectedTarget":{TARGET}}}"#
    ));
    keeps::<Send>(&format!(
        r#"{{"id":"send","text":"hello","files":[],"expectedTarget":{TARGET}}}"#
    ));
    for invalid in [
        format!(r#"{{"text":"hello","expectedTarget":{TARGET}}}"#),
        format!(r#"{{"id":"","text":"hello","expectedTarget":{TARGET}}}"#),
        format!(r#"{{"id":"send","expectedTarget":{TARGET}}}"#),
        r#"{"id":"send","text":"hello"}"#.to_owned(),
        format!(r#"{{"id":"send","text":1,"expectedTarget":{TARGET}}}"#),
        format!(r#"{{"id":"send","text":"x","files":[{{}}],"expectedTarget":{TARGET}}}"#),
        format!(r#"{{"id":"send","text":"x","files":"a","expectedTarget":{TARGET}}}"#),
        format!(r#"{{"id":"send","text":"x","causalMessageID":"","expectedTarget":{TARGET}}}"#),
    ] {
        rejects::<Send>(&invalid);
    }
    keeps::<Delivery>(r#"{"messageID":"m","status":"accepted"}"#);
    keeps::<Delivery>(r#"{"messageID":"m","status":"unknown","turnID":"t"}"#);
    for invalid in [
        r#"{"status":"accepted"}"#,
        r#"{"messageID":"","status":"accepted"}"#,
        r#"{"messageID":"m","status":"failed"}"#,
        r#"{"messageID":"m"}"#,
        r#"{"messageID":"m","status":"accepted","turnID":""}"#,
    ] {
        rejects::<Delivery>(invalid);
    }
}

#[test]
fn presentation_preferences_need_one_value_and_routine_instructions_are_closed() {
    keeps::<PresentationPreferences>(r#"{"format":"prose"}"#);
    keeps::<PresentationPreferences>(r#"{"detail":"detailed"}"#);
    keeps::<PresentationPreferences>(r#"{"format":"bullets","detail":"concise"}"#);
    stripped::<PresentationPreferences>(
        r#"{"format":"prose","extra":true}"#,
        r#"{"format":"prose"}"#,
    );
    for invalid in [
        "{}",
        r#"{"format":"table"}"#,
        r#"{"detail":"verbose"}"#,
        r#"{"format":null}"#,
        r#"{"extra":true}"#,
    ] {
        rejects::<PresentationPreferences>(invalid);
    }
    keeps::<RoutineInstruction>(r#"{"operation":"continue"}"#);
    keeps::<RoutineInstruction>(
        r#"{"operation":"presentation","preferences":{"format":"bullets"}}"#,
    );
    for invalid in [
        r#"{"operation":"continue","preferences":{"format":"prose"}}"#,
        r#"{"operation":"continue","extra":1}"#,
        r#"{"operation":"presentation"}"#,
        r#"{"operation":"presentation","preferences":{}}"#,
        r#"{"operation":"presentation","preferences":{"format":"prose"},"extra":1}"#,
        r#"{"operation":"stop"}"#,
        r#"{}"#,
    ] {
        rejects::<RoutineInstruction>(invalid);
    }
}

#[test]
fn delegation_references_and_receipts_need_a_positive_integer_revision_and_a_message_input() {
    keeps::<DelegationRef>(r#"{"id":"del","revision":1}"#);
    keeps::<RoutineReceipt>(ROUTINE);
    stripped::<RoutineReceipt>(
        &ROUTINE.replace(r#""taskInputID""#, r#""extra":1,"taskInputID""#),
        ROUTINE,
    );
    for invalid in [
        r#"{"id":"del","revision":0}"#,
        r#"{"id":"del","revision":-1}"#,
        r#"{"id":"del","revision":1.5}"#,
        r#"{"id":"del","revision":"1"}"#,
        r#"{"id":"","revision":1}"#,
        r#"{"revision":1}"#,
    ] {
        rejects::<DelegationRef>(invalid);
    }
    for invalid in [
        ROUTINE.replace("msg_task", "task"),
        ROUTINE.replace(r#""revision":2"#, r#""revision":0"#),
        ROUTINE.replace(
            r#""instruction":{"operation":"continue"}"#,
            r#""instruction":{"operation":"stop"}"#,
        ),
        ROUTINE.replace(r#""taskInputID":"msg_task","#, ""),
    ] {
        rejects::<RoutineReceipt>(&invalid);
    }
}

#[test]
fn a_delegation_scope_ties_presentation_values_to_the_presentation_operation() {
    for valid in [
        r#"{"operations":["continue"]}"#,
        r#"{"operations":["presentation"],"format":["prose"]}"#,
        r#"{"operations":["presentation"],"detail":["concise","standard"]}"#,
        r#"{"operations":["continue","presentation"],"format":["prose","bullets"],"detail":["detailed"]}"#,
    ] {
        keeps::<DelegationScope>(valid);
    }
    for invalid in [
        r#"{"operations":[]}"#,
        r#"{"operations":["continue","continue"]}"#,
        r#"{"operations":["continue"],"format":["prose"]}"#,
        r#"{"operations":["continue"],"detail":["concise"]}"#,
        r#"{"operations":["presentation"]}"#,
        r#"{"operations":["presentation"],"format":[]}"#,
        r#"{"operations":["presentation"],"format":["table"]}"#,
        r#"{"operations":["other"]}"#,
        r#"{"format":["prose"]}"#,
    ] {
        rejects::<DelegationScope>(invalid);
    }
}

#[test]
fn exchange_creation_is_a_lenient_text_task_or_a_strict_routine_receipt() {
    let text = format!(
        r#"{{"exchangeID":"ex","expectedAttachment":{TARGET},"targetSessionID":"ses_target","channel":"task","delivery":"steer","text":"Do the work"}}"#
    );
    keeps::<ExchangeCreate>(&text);
    keeps::<ExchangeCreate>(&text.replace("steer", "queue"));
    stripped::<ExchangeCreate>(
        &text.replace(r#""channel""#, r#""extra":1,"channel""#),
        &text,
    );
    let routine = format!(
        r#"{{"exchangeID":"ex","expectedAttachment":{TARGET},"targetSessionID":"ses_target","channel":"task","delivery":"queue","delegation":{{"id":"del","revision":1}},"taskInputID":"msg_task","instruction":{{"operation":"presentation","preferences":{{"detail":"concise"}}}}}}"#
    );
    keeps::<ExchangeCreate>(&routine);
    let longest = "x".repeat(256);
    let too_long = "x".repeat(257);
    keeps::<ExchangeCreate>(&text.replace(
        r#""exchangeID":"ex""#,
        &format!(r#""exchangeID":"{longest}""#),
    ));
    keeps::<ExchangeCreate>(&text.replace("Do the work", &"x".repeat(32768)));
    for invalid in [
        text.replace(r#""exchangeID":"ex""#, r#""exchangeID":"""#),
        text.replace(
            r#""exchangeID":"ex""#,
            &format!(r#""exchangeID":"{too_long}""#),
        ),
        text.replace("Do the work", ""),
        text.replace("Do the work", &"x".repeat(32769)),
        text.replace(r#""channel":"task""#, r#""channel":"chat""#),
        text.replace(r#""delivery":"steer""#, r#""delivery":"now""#),
        text.replace(
            r#""targetSessionID":"ses_target""#,
            r#""targetSessionID":"target""#,
        ),
        text.replace(r#","text":"Do the work""#, ""),
        text.replace(r#""expectedAttachment":"#, r#""unused":"#),
        text.replace(
            r#""channel""#,
            r#""delegation":{"id":"d","revision":1},"channel""#,
        ),
        text.replace(
            r#""channel""#,
            r#""instruction":{"operation":"continue"},"channel""#,
        ),
        text.replace(r#""channel""#, r#""taskInputID":"msg_task","channel""#),
        routine.replace(r#""channel""#, r#""extra":1,"channel""#),
        routine.replace(r#""channel""#, r#""text":"Do it","channel""#),
        routine.replace(r#","taskInputID":"msg_task""#, ""),
        routine.replace(r#","delegation":{"id":"del","revision":1}"#, ""),
        routine.replace(r#""operation":"presentation""#, r#""operation":"stop""#),
        routine.replace(r#""revision":1"#, r#""revision":0"#),
    ] {
        rejects::<ExchangeCreate>(&invalid);
    }
}

#[test]
fn delegation_inputs_are_closed_objects_with_bounded_proposal_and_positive_expiry() {
    let status = format!(r#"{{"expectedAttachment":{TARGET},"targetSessionID":"ses_target"}}"#);
    keeps::<DelegationStatusInput>(&status);
    rejects::<DelegationStatusInput>(
        &status.replace(r#""targetSessionID""#, r#""extra":1,"targetSessionID""#),
    );
    rejects::<DelegationStatusInput>(&status.replace("ses_target", "target"));
    let create = format!(
        r#"{{"expectedAttachment":{TARGET},"targetSessionID":"ses_target","proposalID":"proposal","sourceExchangeID":"ex","taskInputID":"msg_task","scope":{SCOPE},"expiresAt":1000}}"#
    );
    keeps::<DelegationCreate>(&create);
    let too_long = "x".repeat(257);
    for invalid in [
        create.replace(r#""proposalID":"proposal""#, r#""proposalID":"""#),
        create.replace(
            r#""proposalID":"proposal""#,
            &format!(r#""proposalID":"{too_long}""#),
        ),
        create.replace(
            r#""sourceExchangeID":"ex""#,
            &format!(r#""sourceExchangeID":"{too_long}""#),
        ),
        create.replace(r#""expiresAt":1000"#, r#""expiresAt":0"#),
        create.replace(r#""expiresAt":1000"#, r#""expiresAt":1.5"#),
        create.replace(r#""taskInputID":"msg_task""#, r#""taskInputID":"task""#),
        create.replace(SCOPE, r#"{"operations":[]}"#),
        create.replace(r#""proposalID""#, r#""extra":1,"proposalID""#),
        create.replace(r#""scope":{"operations":["continue"]},"#, ""),
    ] {
        rejects::<DelegationCreate>(&invalid);
    }
    let revoke = format!(r#"{{"id":"del","revision":3,"expectedAttachment":{TARGET}}}"#);
    keeps::<DelegationRevoke>(&revoke);
    rejects::<DelegationRevoke>(&revoke.replace(r#""id""#, r#""extra":1,"id""#));
    rejects::<DelegationRevoke>(&revoke.replace(r#""revision":3"#, r#""revision":0"#));
    rejects::<DelegationRevoke>(&revoke.replace(r#""id":"del","#, ""));
    keeps::<ExchangeRead>(r#"{"exchangeID":"ex"}"#);
    stripped::<ExchangeRead>(r#"{"exchangeID":"ex","extra":1}"#, r#"{"exchangeID":"ex"}"#);
    rejects::<ExchangeRead>(r#"{"exchangeID":""}"#);
    rejects::<ExchangeRead>(&format!(r#"{{"exchangeID":"{too_long}"}}"#));
    rejects::<ExchangeRead>("{}");
}

#[test]
fn delegation_info_review_and_status_carry_a_full_principal_and_message_inputs() {
    let info = format!(
        r#"{{"id":"del","revision":1,"sourceExchangeID":"ex","targetSessionID":"ses_target","taskInputID":"msg_task","principal":{PRINCIPAL},"scope":{SCOPE},"expiresAt":1000,"active":true}}"#
    );
    keeps::<DelegationInfo>(&info);
    for invalid in [
        info.replace(r#""active":true"#, r#""active":"yes""#),
        info.replace(r#""active":true"#, r#""unused":true"#),
        info.replace(r#","grantID":"grant""#, ""),
        info.replace(r#""expiresAt":1000"#, r#""expiresAt":0"#),
        info.replace(r#""taskInputID":"msg_task""#, r#""taskInputID":"task""#),
        info.replace(r#""revision":1"#, r#""revision":0"#),
    ] {
        rejects::<DelegationInfo>(&invalid);
    }
    let review = format!(
        r#"{{"kind":"dots-task-delegation","proposalID":"proposal","sourceExchangeID":"ex","principal":{PRINCIPAL},"targetSessionID":"ses_target","taskInputID":"msg_task","task":"Ship it","expectedAttachment":{TARGET},"scope":{SCOPE},"expiresAt":1000,"lifetime":"binding","fingerprint":"print"}}"#
    );
    keeps::<DelegationReview>(&review);
    for invalid in [
        review.replace("dots-task-delegation", "delegation"),
        review.replace(r#""lifetime":"binding""#, r#""lifetime":"session""#),
        review.replace(r#""fingerprint":"print""#, r#""fingerprint":"""#),
        review.replace(r#""task":"Ship it","#, ""),
    ] {
        rejects::<DelegationReview>(&invalid);
    }
    keeps::<DelegationStatus>(r#"{"sources":[],"tasks":[],"grants":[]}"#);
    keeps::<DelegationStatus>(&format!(
        r#"{{"sources":[{{"sourceExchangeID":"ex","principal":{PRINCIPAL}}}],"tasks":[{{"taskInputID":"msg_task","text":""}}],"grants":[{info}]}}"#
    ));
    for invalid in [
        r#"{"sources":[],"tasks":[]}"#.to_owned(),
        r#"{"sources":[{"sourceExchangeID":"ex"}],"tasks":[],"grants":[]}"#.to_owned(),
        r#"{"sources":[],"tasks":[{"taskInputID":"task","text":"x"}],"grants":[]}"#.to_owned(),
        r#"{"sources":[],"tasks":[],"grants":[{}]}"#.to_owned(),
    ] {
        rejects::<DelegationStatus>(&invalid);
    }
}

#[test]
fn task_and_report_envelopes_are_distinguished_by_kind_and_origin() {
    keeps::<TaskEnvelope>(TASK);
    for kind in ["progress", "blocker", "decision_request", "completion"] {
        keeps::<ReportEnvelope>(&REPORT.replace("progress", kind));
    }
    keeps::<Envelope>(TASK);
    keeps::<Envelope>(REPORT);
    for invalid in [
        TASK.replace(r#""origin":"plugin""#, r#""origin":"agent""#),
        TASK.replace(r#""kind":"task""#, r#""kind":"progress""#),
        TASK.replace(r#","grantID":"grant""#, ""),
        TASK.replace("ses_target", "target"),
        TASK.replace("msg_task", "task"),
        TASK.replace(r#""exchangeID":"ex""#, r#""exchangeID":"""#),
        TASK.replace(
            CONTEXT_PRINCIPAL,
            r#"{"ownerID":"owner","deviceID":"device"}"#,
        ),
    ] {
        rejects::<TaskEnvelope>(&invalid);
        rejects::<Envelope>(&invalid);
    }
    for invalid in [
        REPORT.replace(r#""origin":"agent""#, r#""origin":"plugin""#),
        REPORT.replace(r#""kind":"progress""#, r#""kind":"task""#),
        REPORT.replace(r#","replyToMessageID":"msg_task""#, ""),
        REPORT.replace(r#""sourceSessionID":"ses_target","#, ""),
        REPORT.replace("msg_task", "task"),
    ] {
        rejects::<ReportEnvelope>(&invalid);
        rejects::<Envelope>(&invalid);
    }
}

#[test]
fn coordination_context_is_enabled_with_one_task_or_disabled_with_a_reason() {
    let enabled = format!(
        r#"{{"state":"enabled","generation":4,"tool":"dots_report","envelope":{TASK},"routine":{ROUTINE}}}"#
    );
    keeps::<CoordinationContext>(&enabled);
    keeps::<CoordinationContext>(&format!(
        r#"{{"state":"enabled","generation":1,"tool":"dots_report","envelope":{TASK}}}"#
    ));
    for reason in [
        "capability_disabled",
        "no_task",
        "task_settled",
        "unavailable",
        "tool_unavailable",
    ] {
        keeps::<CoordinationContext>(&format!(
            r#"{{"state":"disabled","generation":2,"reason":"{reason}"}}"#
        ));
        keeps::<CoordinationContext>(&format!(
            r#"{{"state":"disabled","generation":2,"reason":"{reason}","routine":{ROUTINE}}}"#
        ));
    }
    for invalid in [
        enabled.replace(r#""generation":4"#, r#""generation":0"#),
        enabled.replace("dots_report", "dots_send"),
        enabled.replace(r#""state":"enabled""#, r#""state":"paused""#),
        enabled.replace(&format!(r#","envelope":{TASK}"#), ""),
        enabled.replace(r#""origin":"plugin""#, r#""origin":"agent""#),
        r#"{"state":"disabled","generation":1}"#.to_owned(),
        r#"{"state":"disabled","generation":1,"reason":"other"}"#.to_owned(),
        r#"{"state":"disabled","reason":"no_task"}"#.to_owned(),
        r#"{"generation":1,"reason":"no_task"}"#.to_owned(),
    ] {
        rejects::<CoordinationContext>(&invalid);
    }
}

#[test]
fn exchange_metadata_needs_a_visible_attachment_label_under_javascript_whitespace() {
    let base = format!(
        r#"{{"sessionID":"ses_anchor","targetSessionID":"ses_target","exchangeID":"ex","attachment":{TARGET}}}"#
    );
    keeps::<ExchangeMetadata>(&base);
    keeps::<ExchangeMetadata>(&format!(
        r#"{{"sessionID":"ses_anchor","targetSessionID":"ses_target","exchangeID":"ex","attachment":{TARGET},"envelope":{TASK},"routine":{ROUTINE}}}"#
    ));
    for visible in ["a", " a ", "\\u200b", "\\u0085", "\\u180e", "-"] {
        keeps::<ExchangeMetadata>(
            &base.replace(r#""label":"Dot""#, &format!(r#""label":"{visible}""#)),
        );
    }
    for blank in [
        "", " ", "\\t\\n", "\\u00a0", "\\u2003", "\\u2028", "\\u2029", "\\u3000", "\\ufeff",
        "\\u202f",
    ] {
        rejects::<ExchangeMetadata>(
            &base.replace(r#""label":"Dot""#, &format!(r#""label":"{blank}""#)),
        );
    }
    rejects::<ExchangeMetadata>(&base.replace(r#""sessionID":"ses_anchor","#, ""));
    rejects::<ExchangeMetadata>(&base.replace(r#""exchangeID":"ex","#, ""));
    rejects::<ExchangeMetadata>(&base.replace(TARGET, r#"{"profile":"p"}"#));
}

#[test]
fn exchange_output_reads_and_records_keep_their_envelopes_and_scope_owners() {
    keeps::<ExchangeOutput>(OUTPUT);
    keeps::<ExchangeOutput>(&OUTPUT.replace(r#""text":"Done""#, r#""text":"""#));
    for invalid in [
        OUTPUT.replace(r#""deliveryID":"delivery","#, ""),
        OUTPUT.replace(r#""deliveryID":"delivery""#, r#""deliveryID":"""#),
        OUTPUT.replace(
            r#""messageID":"msg_report","text""#,
            r#""messageID":"report","text""#,
        ),
        OUTPUT.replace(r#""origin":"agent""#, r#""origin":"plugin""#),
    ] {
        rejects::<ExchangeOutput>(&invalid);
    }
    let exchange = format!(
        r#"{{"envelope":{TASK},"exchangeID":"ex","sessionID":"ses_anchor","targetSessionID":"ses_target","inputID":"msg_task","channel":"task","state":"running","progress":[{OUTPUT}],"result":{OUTPUT}}}"#
    );
    keeps::<Exchange>(&exchange);
    keeps::<Exchange>(&format!(
        r#"{{"envelope":{TASK},"exchangeID":"ex","sessionID":"ses_anchor","targetSessionID":"ses_target","inputID":"msg_task","channel":"task","state":"pending","progress":[]}}"#
    ));
    for invalid in [
        exchange.replace(r#""state":"running""#, r#""state":"done""#),
        exchange.replace(r#""channel":"task""#, r#""channel":"chat""#),
        exchange.replace(&format!(r#","progress":[{OUTPUT}]"#), ""),
        exchange.replace(r#""inputID":"msg_task""#, r#""inputID":"task""#),
        exchange.replace(r#""sessionID":"ses_anchor""#, r#""sessionID":"anchor""#),
        exchange.replace(&format!(r#""result":{OUTPUT}"#), r#""result":null"#),
    ] {
        rejects::<Exchange>(&invalid);
    }
    let record = format!(
        r#"{{"exchangeID":"ex","sessionID":"ses_anchor","targetSessionID":"ses_target","inputID":"msg_task","expectedAttachment":{TARGET},"accountDigest":"digest","fingerprint":"print","source":{SOURCE},"grantID":"grant","scope":{{"rootSessionID":"ses_target"}}}}"#
    );
    keeps::<ExchangeRecord>(&record);
    keeps::<ExchangeRecord>(&record.replace(
        r#""scope":{"rootSessionID":"ses_target"}"#,
        r#""scope":{"rootSessionID":"ses_target","groupID":"group","ownerSessionID":"ses_owner"}"#,
    ));
    keeps::<ExchangeRecord>(
        &record.replace(r#""scope""#, &format!(r#""routine":{ROUTINE},"scope""#)),
    );
    for invalid in [
        record.replace(r#""scope":{"rootSessionID":"ses_target"}"#, r#""scope":{}"#),
        record.replace(
            r#""rootSessionID":"ses_target""#,
            r#""rootSessionID":"target""#,
        ),
        record.replace(r#""accountDigest":"digest","#, ""),
        record.replace(r#""grantID":"grant""#, r#""grantID":"""#),
        record.replace(SOURCE, r#"{"requestID":"req","epoch":"epoch"}"#),
    ] {
        rejects::<ExchangeRecord>(&invalid);
    }
}

#[test]
fn peer_attribution_and_routine_metadata_helpers_read_only_valid_values() {
    let peer = r#"{"origin":"dots-peer","profile":"work","dotID":"dot","threadID":"thread","itemID":"item"}"#;
    keeps::<Peer>(peer);
    keeps::<Peer>(&peer.replace(
        r#""itemID""#,
        r#""turnID":"turn","causalMessageID":"cause","itemID""#,
    ));
    for invalid in [
        peer.replace("dots-peer", "plugin"),
        peer.replace(r#""itemID":"item""#, r#""itemID":"""#),
        peer.replace(r#""profile":"work","#, ""),
    ] {
        rejects::<Peer>(&invalid);
    }
    let metadata = |text: &str| match json(text) {
        JsonValue::Object(object) => object,
        _ => unreachable!(),
    };
    let decoded = ycoding_schema::dots::peer(&metadata(&format!(r#"{{"dots":{peer}}}"#))).unwrap();
    assert_eq!(canon(&decoded.encode()), canon(&json(peer)));
    assert!(ycoding_schema::dots::peer(&metadata(r#"{"dots":{"origin":"dots-peer"}}"#)).is_none());
    assert!(ycoding_schema::dots::peer(&metadata("{}")).is_none());
    assert!(ycoding_schema::dots::peer(&metadata(r#"{"dots":"peer"}"#)).is_none());

    let routine = |routine: &str| {
        ycoding_schema::dots::routine(&metadata(&format!(
            r#"{{"dotsExchange":{{"routine":{routine}}}}}"#
        )))
    };
    assert_eq!(
        canon(&routine(ROUTINE).unwrap().encode()),
        canon(&json(ROUTINE))
    );
    assert!(routine(&ROUTINE.replace(r#""taskInputID""#, r#""extra":1,"taskInputID""#)).is_none());
    assert!(routine(&ROUTINE.replace("msg_task", "task")).is_none());
    assert!(routine("null").is_none());
    assert!(ycoding_schema::dots::routine(&metadata("{}")).is_none());
    assert!(ycoding_schema::dots::routine(&metadata(r#"{"dotsExchange":"x"}"#)).is_none());
    assert!(ycoding_schema::dots::routine(&metadata(r#"{"dotsExchange":{}}"#)).is_none());
}

#[test]
fn computer_attach_round_trips_replace_others_false_and_true() {
    for payload in [
        r#"{"replaceOthers":false}"#,
        r#"{"replaceOthers":true}"#,
        r#"{"replaceOthers":false,"expectedTarget":{"dotID":"dot","threadID":"thread","environmentID":"environment","revision":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}"#,
    ] {
        let value = json(payload);
        assert_eq!(
            canon(
                &ycoding_schema::dots::ComputerAttach::decode(&value)
                    .unwrap()
                    .encode()
            ),
            canon(&value),
            "{payload}"
        );
    }
    assert!(
        !ycoding_schema::dots::ComputerAttach::decode(&json(r#"{"replaceOthers":false}"#))
            .unwrap()
            .replace_others
    );
    for payload in [
        r#"{}"#,
        r#"{"replaceOthers":"true"}"#,
        r#"{"replaceOthers":1}"#,
        r#"{"replaceOthers":null}"#,
    ] {
        assert!(
            ycoding_schema::dots::ComputerAttach::decode(&json(payload)).is_err(),
            "{payload}"
        );
    }
}
