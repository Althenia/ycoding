use serde_json::{Value, json};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, coordination, durable_event_manifest, event,
    event_manifest, parse_json, session_event, session_message, session_orchestration,
    stringify_json,
};

fn round_trip<T: DomainDecode + DomainEncode>(input: Value) -> T {
    let decoded = T::decode(&parse_json(&input.to_string()).unwrap()).unwrap();
    let encoded: Value = serde_json::from_str(&stringify_json(&decoded.encode())).unwrap();
    assert_eq!(encoded, input);
    decoded
}

fn reject<T: DomainDecode>(input: Value) {
    assert!(
        T::decode(&parse_json(&input.to_string()).unwrap()).is_err(),
        "{input}"
    );
}

fn participant() -> Value {
    json!({
        "sessionID": "ses_member",
        "title": "Member",
        "location": { "directory": "/fixture" },
        "state": "idle",
        "lastActivity": 0,
        "pending": [],
    })
}

fn snapshot() -> Value {
    json!({
        "groupID": "cgrp_fixture",
        "revision": 0,
        "name": "Fixture",
        "masterSessionID": "ses_master",
        "memberSessionIDs": ["ses_member"],
        "settings": { "concurrency": null },
    })
}

#[test]
fn delegated_decisions_preserve_optional_scopes_known_zero_and_duplicate_categories() {
    round_trip::<coordination::DelegatedDecisions>(json!({ "categories": [] }));
    let decisions = round_trip::<coordination::DelegatedDecisions>(json!({
        "categories": ["question", "permission", "review"],
        "actions": [],
        "resources": [],
        "expiresAt": 0,
    }));
    assert_eq!(
        decisions.categories,
        [
            coordination::RequestKind::Question,
            coordination::RequestKind::Permission,
            coordination::RequestKind::Review,
        ],
    );
    assert!(decisions.actions.is_some());
    assert!(decisions.resources.is_some());
    assert!(decisions.expires_at.is_some());
    round_trip::<coordination::DelegatedDecisions>(json!({
        "categories": ["question", "question", "question"],
        "expiresAt": 9007199254740991_u64,
    }));
    let input = parse_json(r#"{"categories":[],"unknown":true}"#).unwrap();
    let encoded = coordination::DelegatedDecisions::decode(&input)
        .unwrap()
        .encode();
    assert_eq!(stringify_json(&encoded), r#"{"categories":[]}"#);
}

#[test]
fn delegated_decisions_reject_unknown_kinds_missing_fields_and_invalid_expiry() {
    for input in [
        json!({}),
        json!({ "categories": null }),
        json!({ "categories": "question" }),
        json!({ "categories": ["tool"] }),
        json!({ "categories": ["question", "permission", "review", "question"] }),
        json!({ "categories": [], "actions": null }),
        json!({ "categories": [], "resources": null }),
        json!({ "categories": [], "expiresAt": null }),
        json!({ "categories": [], "expiresAt": -1 }),
        json!({ "categories": [], "expiresAt": 0.5 }),
        json!({ "categories": [], "expiresAt": 9007199254740992_u64 }),
    ] {
        reject::<coordination::DelegatedDecisions>(input);
    }
}

#[test]
fn delegated_scopes_keep_utf16_text_and_array_boundaries() {
    for field in ["actions", "resources"] {
        let mut input = json!({ "categories": [] });
        for scopes in [
            json!([]),
            json!(["x"]),
            json!(vec!["x"; 32]),
            json!(["😀".repeat(256)]),
        ] {
            input[field] = scopes;
            round_trip::<coordination::DelegatedDecisions>(input.clone());
        }
        for scopes in [
            json!(vec!["x"; 33]),
            json!([""]),
            json!([format!("{}x", "😀".repeat(256))]),
            json!([null]),
            json!([1]),
            json!("x"),
        ] {
            input[field] = scopes;
            reject::<coordination::DelegatedDecisions>(input.clone());
        }
    }
}

#[test]
fn delegated_scopes_preserve_lone_utf16_units_and_negative_zero() {
    let input = parse_json(r#"{"categories":[],"actions":["\ud800"],"expiresAt":-0}"#).unwrap();
    let encoded = coordination::DelegatedDecisions::decode(&input)
        .unwrap()
        .encode();
    let JsonValue::Object(object) = &encoded else {
        panic!("delegated decisions must encode an object");
    };
    assert!(
        matches!(object.get(&"expiresAt".into()), Some(JsonValue::Number(value)) if *value == 0.0 && value.is_sign_negative())
    );
    assert_eq!(
        stringify_json(&encoded),
        r#"{"categories":[],"actions":["\ud800"],"expiresAt":0}"#,
    );
}

#[test]
fn group_identity_and_revision_enforce_source_bounds() {
    for id in [
        "cgrp_x".to_owned(),
        format!("cgrp_{}", "x".repeat(91)),
        format!("cgrp_{}x", "😀".repeat(45)),
    ] {
        round_trip::<coordination::GroupId>(json!(id));
    }
    for id in [
        "cgrp_".to_owned(),
        "group_x".to_owned(),
        format!("cgrp_{}", "x".repeat(92)),
        format!("cgrp_{}", "😀".repeat(46)),
    ] {
        reject::<coordination::GroupId>(json!(id));
    }
    for revision in [json!(0), json!(9007199254740991_u64)] {
        round_trip::<coordination::Revision>(revision);
    }
    for revision in [
        json!(-1),
        json!(0.5),
        json!(9007199254740992_u64),
        json!(null),
    ] {
        reject::<coordination::Revision>(revision);
    }
}

#[test]
fn group_settings_keep_required_null_concurrency_distinct_from_absence() {
    for concurrency in [json!(null), json!(1), json!(9007199254740991_u64)] {
        round_trip::<coordination::GroupSettings>(json!({ "concurrency": concurrency }));
    }
    round_trip::<coordination::GroupSettings>(json!({
        "concurrency": 2,
        "delegatedDecisions": { "categories": ["review"], "actions": ["read"], "resources": [] },
    }));
    for input in [
        json!({}),
        json!({ "concurrency": 0 }),
        json!({ "concurrency": -1 }),
        json!({ "concurrency": 1.5 }),
        json!({ "concurrency": 9007199254740992_u64 }),
        json!({ "concurrency": null, "delegatedDecisions": null }),
    ] {
        reject::<coordination::GroupSettings>(input);
    }
}

#[test]
fn settings_round_trip_the_flat_current_shape() {
    round_trip::<coordination::Settings>(json!({ "enabled": false, "categories": [] }));
    round_trip::<coordination::Settings>(json!({
        "enabled": true,
        "categories": ["permission"],
        "actions": ["read"],
        "resources": ["fixture"],
        "expiresAt": 0,
    }));
    for input in [
        json!({ "categories": [] }),
        json!({ "enabled": null, "categories": [] }),
        json!({ "enabled": true }),
        json!({ "enabled": true, "categories": ["invalid"] }),
    ] {
        reject::<coordination::Settings>(input);
    }
}

#[test]
fn create_and_update_use_distinct_required_fields_and_bounded_members() {
    let mut create =
        json!({ "name": "x", "masterSessionID": "ses_master", "memberSessionIDs": [] });
    round_trip::<coordination::CreateInput>(create.clone());
    create["name"] = json!("😀".repeat(60));
    create["memberSessionIDs"] = json!(vec!["ses_member"; 64]);
    round_trip::<coordination::CreateInput>(create.clone());
    create["memberSessionIDs"] = json!(vec!["ses_member"; 65]);
    reject::<coordination::CreateInput>(create);
    for name in ["".to_owned(), format!("{}x", "😀".repeat(60))] {
        reject::<coordination::CreateInput>(json!({
            "name": name, "masterSessionID": "ses_master", "memberSessionIDs": [],
        }));
    }
    reject::<coordination::CreateInput>(json!({ "name": "x", "masterSessionID": "ses_master" }));
    round_trip::<coordination::UpdateInput>(json!({ "revision": 0 }));
    round_trip::<coordination::UpdateInput>(json!({
        "revision": 1,
        "name": "x",
        "masterSessionID": "ses_master",
        "memberSessionIDs": [],
        "settings": { "concurrency": null },
    }));
    for input in [
        json!({}),
        json!({ "revision": -1 }),
        json!({ "revision": 0, "name": "" }),
        json!({ "revision": 0, "masterSessionID": null }),
        json!({ "revision": 0, "memberSessionIDs": vec!["ses_member"; 65] }),
        json!({ "revision": 0, "settings": null }),
    ] {
        reject::<coordination::UpdateInput>(input);
    }
}

#[test]
fn participants_keep_owner_and_driver_identities_and_bounded_pending_requests() {
    round_trip::<coordination::Participant>(participant());
    let mut input = participant();
    input["drivenBy"] = json!({ "sessionID": "ses_driver", "title": "Driver" });
    input["owner"] = json!({ "sessionID": "ses_owner", "title": "Owner" });
    let pending =
        json!({ "kind": "review", "requestID": "req", "fingerprint": "fp", "summary": "" });
    input["pending"] = json!(vec![pending; 50]);
    for state in ["idle", "running", "waiting", "failed"] {
        input["state"] = json!(state);
        let decoded = round_trip::<coordination::Participant>(input.clone());
        assert!(decoded.owner.is_some());
        assert!(decoded.driven_by.is_some());
    }
    let mut invalid = input.clone();
    invalid["pending"].as_array_mut().unwrap().push(json!({
        "kind": "question", "requestID": "req", "fingerprint": "fp", "summary": "x",
    }));
    reject::<coordination::Participant>(invalid);
    for (field, value) in [
        ("owner", json!(null)),
        ("drivenBy", json!(null)),
        ("state", json!("paused")),
        ("lastActivity", json!(-1)),
    ] {
        let mut invalid = input.clone();
        invalid[field] = value;
        reject::<coordination::Participant>(invalid);
    }
    let pending = json!({ "kind": "permission", "requestID": "x".repeat(256), "fingerprint": "f".repeat(256), "summary": "s".repeat(500) });
    round_trip::<coordination::PendingRequest>(pending.clone());
    let mut routed = pending.clone();
    routed["requestSessionID"] = json!("ses_nested");
    round_trip::<coordination::PendingRequest>(routed.clone());
    for value in [json!(null), json!(""), json!("nested"), json!(7)] {
        let mut invalid = routed.clone();
        invalid["requestSessionID"] = value;
        reject::<coordination::PendingRequest>(invalid);
    }
    for (field, value) in [
        ("kind", json!("tool")),
        ("requestID", json!("")),
        ("requestID", json!("x".repeat(257))),
        ("fingerprint", json!("")),
        ("fingerprint", json!("f".repeat(257))),
        ("summary", json!("s".repeat(501))),
    ] {
        let mut invalid = pending.clone();
        invalid[field] = value;
        reject::<coordination::PendingRequest>(invalid);
    }
}

#[test]
fn group_reads_preserve_paused_state_unbounded_participants_and_timestamps() {
    let mut info = json!({
        "id": "cgrp_fixture", "name": "", "revision": 0, "active": false,
        "master": participant(), "members": vec![participant(); 65],
        "settings": { "concurrency": null }, "time": { "created": 0, "updated": 1 },
    });
    round_trip::<coordination::Info>(info.clone());
    for reason in ["interrupted", "restart"] {
        info["pausedReason"] = json!(reason);
        round_trip::<coordination::Info>(info.clone());
    }
    info["pausedReason"] = json!("cancelled");
    reject::<coordination::Info>(info);
    let summary = json!({
        "id": "cgrp_fixture", "name": "", "revision": 1, "active": true,
        "masterSessionID": "ses_master", "memberCount": 65,
        "settings": { "concurrency": 1 }, "time": { "created": 0, "updated": 1 },
    });
    round_trip::<coordination::GroupSummary>(summary.clone());
    for (field, value) in [
        ("memberCount", json!(-1)),
        ("time", json!({ "created": -1, "updated": 0 })),
        ("time", json!({ "created": 0 })),
    ] {
        let mut invalid = summary.clone();
        invalid[field] = value;
        reject::<coordination::GroupSummary>(invalid);
    }
}

#[test]
fn escalation_reasons_enforce_count_text_and_javascript_whitespace_bounds() {
    for reasons in [
        vec![json!({ "sessionID": "ses_member", "reason": "x" })],
        vec![json!({ "sessionID": "ses_member", "reason": "x" }); 4],
    ] {
        round_trip::<coordination::Escalation>(json!({ "reasons": reasons }));
    }
    for reasons in [
        vec![],
        vec![json!({ "sessionID": "ses_member", "reason": "x" }); 5],
    ] {
        reject::<coordination::Escalation>(json!({ "reasons": reasons }));
    }
    for reason in ["x".repeat(500), "\u{0085}".to_owned()] {
        round_trip::<coordination::EscalationReason>(
            json!({ "sessionID": "ses_member", "reason": reason }),
        );
    }
    for reason in [
        "".to_owned(),
        " \t\n".to_owned(),
        "\u{00a0}".to_owned(),
        "x".repeat(501),
    ] {
        reject::<coordination::EscalationReason>(
            json!({ "sessionID": "ses_member", "reason": reason }),
        );
    }
}

fn durable_event<E: event::DurableEventType>(kind: &str, version: i64, data: Value) {
    durable_event_on::<E>(kind, version, "groupID", "cgrp_fixture", data);
}

fn durable_event_on<E: event::DurableEventType>(
    kind: &str,
    version: i64,
    aggregate: &str,
    aggregate_id: &str,
    data: Value,
) {
    assert_eq!(E::TYPE, kind);
    assert_eq!(E::VERSION, version);
    assert_eq!(E::AGGREGATE, aggregate);
    let mut input = json!({
        "id": "evt_fixture", "created": 0, "type": kind,
        "durable": { "aggregateID": aggregate_id, "seq": 0, "version": version },
        "data": data,
    });
    round_trip::<event::DurablePayload<E>>(input.clone());
    input["durable"]["version"] = json!(if version == 1 { 2 } else { 1 });
    reject::<event::DurablePayload<E>>(input);
}

#[test]
fn group_event_payloads_preserve_current_versions_and_owner_transitions() {
    durable_event::<coordination::event::Created>("coordination.group.created", 2, snapshot());
    durable_event::<coordination::event::Changed>("coordination.group.changed", 1, snapshot());
    durable_event::<coordination::event::Deleted>(
        "coordination.group.deleted",
        1,
        json!({ "groupID": "cgrp_fixture", "revision": 1 }),
    );
    for data in [
        json!({ "groupID": "cgrp_fixture", "revision": 1, "sessionID": "ses_member" }),
        json!({ "groupID": "cgrp_fixture", "revision": 1, "sessionID": "ses_member", "ownerSessionID": "ses_owner" }),
        json!({ "groupID": "cgrp_fixture", "revision": 1, "sessionID": "ses_member", "reason": "completed" }),
        json!({ "groupID": "cgrp_fixture", "revision": 1, "sessionID": "ses_member", "reason": "released" }),
    ] {
        durable_event::<coordination::event::OwnerChanged>(
            "coordination.member.owner.changed",
            1,
            data,
        );
    }
    round_trip::<event::EphemeralPayload<coordination::event::Updated>>(json!({
        "id": "evt_fixture", "created": 0, "type": "coordination.updated",
        "data": { "groupID": "cgrp_fixture", "revision": 1 },
    }));
    for root in [None, Some("ses_root")] {
        let mut input = json!({
            "id": "evt_fixture", "created": 0, "type": "coordination.request.escalated",
            "data": { "sessionID": "ses_member", "kind": "review", "requestID": "req", "coordinationEscalation": { "reasons": [{ "sessionID": "ses_member", "reason": "Owner unavailable" }] } },
        });
        if let Some(root) = root {
            input["data"]["rootSessionID"] = json!(root);
        }
        round_trip::<event::EphemeralPayload<coordination::event::RequestEscalated>>(input);
    }
    reject::<coordination::ReleaseReason>(json!("cancelled"));
}

#[test]
fn blocked_subagent_request_is_a_durable_parent_session_fact() {
    let data = |reason: &str| {
        json!({
            "sessionID": "ses_parent", "agent": "occam", "reason": reason,
            "message": "Subagent limit reached: 3/3 subagents running.",
        })
    };
    for reason in [
        "concurrency-ceiling",
        "agent-missing",
        "permission-denied",
        "project-paused",
        "route-unavailable",
    ] {
        durable_event_on::<coordination::event::SubagentRequestBlocked>(
            "coordination.subagent.request.blocked",
            1,
            "sessionID",
            "ses_parent",
            data(reason),
        );
    }
    for patch in [
        json!({ "reason": "busy" }),
        json!({ "agent": "" }),
        json!({ "agent": "x".repeat(257) }),
        json!({ "message": "" }),
        json!({ "message": "x".repeat(4097) }),
        json!({ "sessionID": "msg_parent" }),
    ] {
        let mut value = data("concurrency-ceiling");
        value
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        reject::<coordination::SubagentRequestBlockedData>(value);
    }
    let mut missing = data("agent-missing");
    missing.as_object_mut().unwrap().remove("message");
    reject::<coordination::SubagentRequestBlockedData>(missing);
}

#[test]
fn current_coordination_events_are_public_and_group_versions_are_durable() {
    for (kind, version) in [
        ("coordination.group.created", Some(2)),
        ("coordination.group.changed", Some(1)),
        ("coordination.group.deleted", Some(1)),
        ("coordination.member.owner.changed", Some(1)),
        ("coordination.subagent.request.blocked", Some(1)),
        ("coordination.updated", None),
        ("coordination.request.escalated", None),
    ] {
        assert!(event_manifest::ALL.contains(&kind), "{kind}");
        assert!(event_manifest::SERVER.contains(&kind), "{kind}");
        if let Some(version) = version {
            assert!(
                durable_event_manifest::DURABLE.contains(&format!("{kind}.{version}").as_str())
            );
        } else {
            assert!(
                !durable_event_manifest::DURABLE
                    .iter()
                    .any(|value| value.starts_with(kind))
            );
        }
    }
    assert!(!durable_event_manifest::DURABLE.contains(&"coordination.group.created.1"));
    let ordered = [
        "coordination.group.created",
        "coordination.group.changed",
        "coordination.group.deleted",
        "coordination.member.owner.changed",
        "coordination.subagent.request.blocked",
        "coordination.updated",
        "coordination.request.escalated",
    ];
    assert!(
        event_manifest::ALL
            .windows(ordered.len())
            .any(|values| values == ordered)
    );
    assert!(
        event_manifest::SERVER
            .windows(ordered.len())
            .any(|values| values == ordered)
    );
}

#[test]
fn orchestration_supervising_state_and_change_round_trip() {
    let state = round_trip::<session_orchestration::State>(json!("supervising"));
    assert_eq!(state, session_orchestration::State::Supervising);
    let change = round_trip::<session_orchestration::Change>(json!({ "type": "supervising" }));
    assert_eq!(change, session_orchestration::Change::Supervising);
    reject::<session_orchestration::State>(json!("supervise"));
    reject::<session_orchestration::TerminalState>(json!("supervising"));
}

#[test]
fn orchestration_progress_and_handback_notifications_round_trip() {
    for kind in ["progress", "handback"] {
        let notification = round_trip::<session_orchestration::Notification>(json!({
            "id": "ntf_fixture",
            "parentID": "ses_parent",
            "childID": "ses_child",
            "type": kind,
            "revision": 1,
        }));
        assert_eq!(
            notification.r#type.encode(),
            parse_json(&format!("\"{kind}\"")).unwrap()
        );
    }
    assert_eq!(
        round_trip::<session_orchestration::NotificationType>(json!("progress")),
        session_orchestration::NotificationType::Progress
    );
    assert_eq!(
        round_trip::<session_orchestration::NotificationType>(json!("handback")),
        session_orchestration::NotificationType::Handback
    );
}

#[test]
fn skill_activation_preserves_the_recorded_directory_and_stays_optional() {
    let with = json!({
        "id": "msg_skill",
        "time": { "created": 1 },
        "type": "skill",
        "skill": "skill_fixture",
        "name": "Fixture",
        "text": "Loaded",
        "directory": "/fixture/skills/fixture",
    });
    let decoded = round_trip::<session_message::Skill>(with);
    assert_eq!(
        decoded.directory.as_ref().and_then(|value| value.as_str()),
        Some("/fixture/skills/fixture")
    );
    let mut without = json!({
        "id": "msg_skill",
        "time": { "created": 1 },
        "type": "skill",
        "skill": "skill_fixture",
        "name": "Fixture",
        "text": "Loaded",
    });
    let decoded = round_trip::<session_message::Skill>(without.clone());
    assert_eq!(decoded.directory, None);
    without["directory"] = json!(1);
    reject::<session_message::Skill>(without);

    let envelope = |data: &str| {
        parse_json(&format!(
            r#"{{"id":"evt_skill","created":1,"type":"session.skill.activated","durable":{{"aggregateID":"ses_child","seq":0,"version":1}},"data":{data}}}"#
        ))
        .unwrap()
    };
    let data = r#"{"sessionID":"ses_child","id":"skill_fixture","name":"Fixture","text":"Loaded","directory":"/fixture/skills/fixture"}"#;
    let event = session_event::DurableEvent::decode(&envelope(data)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&stringify_json(&JsonValue::Object(event.0.data.0))).unwrap()
            ["directory"],
        json!("/fixture/skills/fixture")
    );
    assert!(
        session_event::DurableEvent::decode(&envelope(
            r#"{"sessionID":"ses_child","id":"skill_fixture","name":"Fixture","text":"Loaded"}"#
        ))
        .is_ok()
    );
    assert!(session_event::DurableEvent::decode(&envelope(
        r#"{"sessionID":"ses_child","id":"skill_fixture","name":"Fixture","text":"Loaded","directory":1}"#
    ))
    .is_err());
}
