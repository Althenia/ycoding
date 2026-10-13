use ycoding_core::session::{skill_status, store::Service};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, instruction, parse_json, session, session_message,
    session_skill_status::{Info, State},
};
use ycoding_store::session::{Message, NewEvent};

#[path = "autonomy_support/mod.rs"]
mod support;

fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

async fn publish(service: &Service, kind: &str, event: &str, now: i64, fields: &str) {
    service
        .publish(NewEvent {
            id: event.into(),
            aggregate_id: "ses_one".into(),
            created: now,
            type_: format!("{kind}.1").into(),
            data: parse_json(&format!(r#"{{"sessionID":"ses_one"{fields}}}"#)).unwrap(),
        })
        .await
        .unwrap();
}

async fn activate(service: &Service, event: &str, now: i64, skill: &str, conflicts: &str) {
    publish(
        service,
        "session.skill.activated",
        event,
        now,
        &format!(r#","id":"{skill}","name":"{skill} name","text":"{skill} body"{conflicts}"#),
    )
    .await;
}

async fn skill_tool(service: &Service, assistant: &str, now: i64, skill: &str, output: &str) {
    publish(
        service,
        "session.step.started",
        &format!("evt_{assistant}_step"),
        now,
        &format!(
            r#","assistantMessageID":"msg_{assistant}","agent":"build","model":{{"providerID":"local","id":"test"}}"#
        ),
    )
    .await;
    for (kind, suffix, fields) in [
        (
            "session.tool.input.started",
            "input",
            r#","name":"skill""#.to_string(),
        ),
        (
            "session.tool.input.ended",
            "ended",
            r#","text":"{}""#.to_string(),
        ),
        (
            "session.tool.called",
            "called",
            format!(r#","input":{{"id":"{skill}"}},"executed":false"#),
        ),
        (
            "session.tool.success",
            "success",
            format!(r#","structured":{output},"content":[],"executed":false"#),
        ),
    ] {
        publish(
            service,
            kind,
            &format!("evt_{assistant}_{suffix}"),
            now + 1,
            &format!(
                r#","assistantMessageID":"msg_{assistant}","callID":"call_{assistant}"{fields}"#
            ),
        )
        .await;
    }
}

fn statuses(service: &Service, keys: &[&str]) -> Vec<Info> {
    let keys = keys
        .iter()
        .map(|key| instruction::Key::decode(&JsonValue::String((*key).into())).unwrap())
        .collect::<Vec<_>>();
    skill_status::list(&service.transcript(&id()).unwrap(), &keys)
}

fn find<'a>(statuses: &'a [Info], skill: &str) -> &'a Info {
    statuses
        .iter()
        .find(|status| status.id.as_str() == Some(skill))
        .unwrap()
}

fn reason(status: &Info) -> Option<&str> {
    match &status.state {
        State::Active => None,
        State::Inactive { inactive_reason } => inactive_reason.as_str(),
    }
}

fn names(status: &Info) -> Vec<(String, String)> {
    status
        .conflicts
        .iter()
        .map(|conflict| {
            (
                conflict.r#type.as_str().unwrap().into(),
                conflict.id.as_str().unwrap().into(),
            )
        })
        .collect()
}

#[tokio::test]
async fn reference_activation_derives_active_status_with_inbound_outbound_and_instruction_conflicts()
 {
    let store = support::store();
    let service = Service::new(store.client());
    activate(
        &service,
        "evt_a",
        1,
        "alpha",
        r#","conflicts":{"skills":["beta","alpha"],"instructions":["core/human-input"]}"#,
    )
    .await;
    activate(&service, "evt_b", 2, "beta", "").await;
    activate(
        &service,
        "evt_c",
        3,
        "gamma",
        r#","conflicts":{"skills":["missing"],"instructions":[]}"#,
    )
    .await;

    let all = statuses(&service, &["core/human-input"]);
    assert_eq!(all.len(), 3);
    let alpha = find(&all, "alpha");
    assert_eq!(alpha.activated_by.as_str(), Some("reference"));
    assert_eq!(
        alpha.activation_message_id.as_lossless().as_str(),
        Some("msg_a")
    );
    assert_eq!(alpha.content.as_str(), Some("alpha body"));
    assert_eq!(
        names(alpha),
        [
            ("skill".into(), "beta".into()),
            ("instruction".into(), "core/human-input".into())
        ]
    );
    assert_eq!(
        names(find(&all, "beta")),
        [("skill".into(), "alpha".into())]
    );
    assert!(names(find(&all, "gamma")).is_empty());
    assert!(
        names(find(&statuses(&service, &[]), "alpha"))
            .iter()
            .all(|(kind, _)| kind == "skill")
    );
}

#[tokio::test]
async fn explicit_deactivation_marks_the_skill_and_assistant_activation_holders_inactive() {
    let store = support::store();
    let service = Service::new(store.client());
    activate(&service, "evt_a", 1, "alpha", "").await;
    skill_tool(
        &service,
        "tool",
        5,
        "beta",
        r#"{"name":"beta name","directory":"/skills/beta","output":"beta body","conflicts":{"skills":["alpha"],"instructions":[]}}"#,
    )
    .await;
    let both = statuses(&service, &[]);
    assert_eq!(
        names(find(&both, "alpha")),
        [("skill".into(), "beta".into())]
    );
    assert_eq!(find(&both, "beta").activated_by.as_str(), Some("tool"));

    publish(
        &service,
        "session.skill.deactivated",
        "evt_off_a",
        10,
        r#","id":"alpha","activationMessageID":"msg_a","reason":"conflict_resolved""#,
    )
    .await;
    publish(
        &service,
        "session.skill.deactivated",
        "evt_off_b",
        11,
        r#","id":"beta","activationMessageID":"msg_tool","reason":"conflict_resolved""#,
    )
    .await;
    let after = statuses(&service, &[]);
    assert_eq!(reason(find(&after, "alpha")), Some("conflict_resolved"));
    assert_eq!(reason(find(&after, "beta")), Some("conflict_resolved"));
    assert!(after.iter().all(|status| status.conflicts.is_empty()));
}

#[tokio::test]
async fn deactivation_naming_a_missing_or_foreign_activation_changes_nothing() {
    let store = support::store();
    let service = Service::new(store.client());
    activate(&service, "evt_a", 1, "alpha", "").await;
    publish(
        &service,
        "session.skill.deactivated",
        "evt_off",
        2,
        r#","id":"alpha","activationMessageID":"msg_missing","reason":"conflict_resolved""#,
    )
    .await;
    assert_eq!(reason(find(&statuses(&service, &[]), "alpha")), None);
}

#[tokio::test]
async fn already_active_tool_loads_never_register_as_a_new_activation() {
    let store = support::store();
    let service = Service::new(store.client());
    skill_tool(
        &service,
        "first",
        1,
        "alpha",
        r#"{"name":"alpha name","directory":"/skills/alpha","output":"first body"}"#,
    )
    .await;
    skill_tool(
        &service,
        "second",
        10,
        "alpha",
        r#"{"name":"alpha name","directory":"/skills/alpha","output":"second body","alreadyActive":true}"#,
    )
    .await;
    skill_tool(
        &service,
        "malformed",
        20,
        "beta",
        r#"{"name":"beta name","output":"missing directory"}"#,
    )
    .await;
    let all = statuses(&service, &[]);
    assert_eq!(all.len(), 1);
    let alpha = find(&all, "alpha");
    assert_eq!(
        alpha.activation_message_id.as_lossless().as_str(),
        Some("msg_first")
    );
    assert_eq!(alpha.content.as_str(), Some("first body"));
}

#[tokio::test]
async fn agent_switch_and_completed_compaction_deactivate_with_distinct_reasons_and_reactivation_wins()
 {
    let store = support::store();
    let service = Service::new(store.client());
    activate(&service, "evt_a", 1, "alpha", "").await;
    activate(&service, "evt_b", 2, "beta", "").await;
    publish(
        &service,
        "session.agent.selected",
        "evt_switch",
        3,
        r#","agent":"plan""#,
    )
    .await;
    let switched = statuses(&service, &[]);
    assert_eq!(reason(find(&switched, "alpha")), Some("agent_switched"));
    assert_eq!(reason(find(&switched, "beta")), Some("agent_switched"));

    activate(&service, "evt_a2", 4, "alpha", "").await;
    assert_eq!(reason(find(&statuses(&service, &[]), "alpha")), None);
    assert_eq!(
        reason(find(&statuses(&service, &[]), "beta")),
        Some("agent_switched")
    );

    let compaction = |status: &str, seq: i64| {
        Message {
            id: format!("msg_compaction_{seq}").into(),
            session_id: "ses_one".into(),
            type_: "compaction".into(),
            seq,
            time_created: seq,
            time_updated: seq,
            data: parse_json(&format!(
                r#"{{"time":{{"created":{seq}}},"reason":"manual","status":"{status}","summary":"s","recent":"r"}}"#
            ))
            .unwrap(),
        }
        .info()
        .unwrap()
    };
    let mut messages = service.transcript(&id()).unwrap();
    messages.push(compaction("running", 100));
    assert_eq!(
        reason(find(&skill_status::list(&messages, &[]), "alpha")),
        None
    );
    messages.push(compaction("completed", 101));
    let compacted = skill_status::list(&messages, &[]);
    assert_eq!(reason(find(&compacted, "alpha")), Some("compacted"));
    assert_eq!(reason(find(&compacted, "beta")), Some("compacted"));
    assert!(compacted.iter().all(|status| status.conflicts.is_empty()));
}

#[tokio::test]
async fn mcp_activation_returns_the_held_entry_only_for_an_active_tool_activation() {
    let store = support::store();
    let service = Service::new(store.client());
    let entry = r#"{"server":"docs","uri":"skill://docs/SKILL.md","frontmatter":{"name":"docs","description":"Docs"},"resources":[]}"#;
    skill_tool(
        &service,
        "mcp",
        1,
        "docs",
        &format!(r#"{{"name":"docs","directory":"/mcp/docs","output":"body","entry":{entry}}}"#),
    )
    .await;
    activate(&service, "evt_ref", 10, "local", "").await;
    let messages: Vec<session_message::Info> = service.transcript(&id()).unwrap();
    let docs = LosslessString::from("docs");
    let held = skill_status::mcp_activation(&messages, &docs).unwrap();
    assert_eq!(held.entry.uri.as_str(), Some("skill://docs/SKILL.md"));
    assert_eq!(
        held.status.activation_message_id.as_lossless().as_str(),
        Some("msg_mcp")
    );
    assert!(skill_status::mcp_activation(&messages, &"local".into()).is_none());
    assert!(skill_status::mcp_activation(&messages, &"absent".into()).is_none());

    publish(
        &service,
        "session.agent.selected",
        "evt_switch",
        20,
        r#","agent":"plan""#,
    )
    .await;
    assert!(skill_status::mcp_activation(&service.transcript(&id()).unwrap(), &docs).is_none());
}
