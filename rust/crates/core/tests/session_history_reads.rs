use ycoding_core::session::{history::Source, store::Service};
use ycoding_schema::{
    DomainEncode, JsonValue, parse_json, session, session_message, session_skill_status::State,
};
use ycoding_store::{
    KeyPart, Store,
    session::{EventTable, Message, MessageTable, NewEvent},
    tuple_key,
};

#[path = "session_support/mod.rs"]
mod support;

fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

fn row(id: &str, type_: &str, seq: i64, data: &str) -> Message {
    Message {
        id: id.into(),
        session_id: "ses_one".into(),
        type_: type_.into(),
        seq,
        time_created: seq,
        time_updated: seq,
        data: parse_json(data).unwrap(),
    }
}

fn insert(store: &Store, rows: Vec<Message>) {
    store
        .submit(move |tx| {
            for row in &rows {
                MessageTable::insert(tx, row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn message_id(message: &session_message::Info) -> String {
    let JsonValue::Object(fields) = message.encode() else {
        panic!()
    };
    let Some(JsonValue::String(id)) = fields.get(&"id".into()) else {
        panic!()
    };
    id.as_str().unwrap().into()
}

fn ids(messages: &[session_message::Info]) -> Vec<String> {
    messages.iter().map(message_id).collect()
}

fn event(kind: &str, id: &str, now: i64, fields: &str) -> NewEvent {
    NewEvent {
        id: id.into(),
        aggregate_id: "ses_one".into(),
        created: now,
        type_: format!("{kind}.1").into(),
        data: parse_json(&format!(r#"{{"sessionID":"ses_one"{fields}}}"#)).unwrap(),
    }
}

async fn observe(service: &Service, id: &str, now: i64, source: &str, text: &str) {
    service
        .publish(event(
            "session.context.observed",
            id,
            now,
            &format!(r#","source":"{source}","text":"{text}""#),
        ))
        .await
        .unwrap();
}

fn tool(id: &str, status: &str) -> String {
    let state = match status {
        "streaming" => r#"{"status":"streaming","input":"{"}"#.to_string(),
        other => format!(r#"{{"status":"{other}","input":{{}},"structured":{{}},"content":[]}}"#),
    };
    format!(r#"{{"type":"tool","id":"{id}","name":"echo","state":{state},"time":{{"created":1}}}}"#)
}

fn assistant(content: &[String]) -> String {
    format!(
        r#"{{"agent":"build","model":{{"providerID":"test","id":"model"}},"content":[{}],"time":{{"created":1}}}}"#,
        content.join(",")
    )
}

#[test]
fn latest_recent_and_unsettled_tool_messages_read_only_rows_after_the_completed_v1_floor() {
    let store = support::store();
    let service = Service::new(store.client());
    let rows = [
        ("assistant", assistant(&[tool("call_before_floor", "running")])),
        (
            "skill",
            r#"{"skill":"review","name":"Review","text":"before floor","time":{"created":1}}"#.into(),
        ),
        ("user", r#"{"text":"before floor","time":{"created":1}}"#.into()),
        (
            "compaction",
            r#"{"reason":"auto","status":"completed","summary":"V1 summary","recent":"","time":{"created":1}}"#.into(),
        ),
        ("user", r#"{"text":"after floor","time":{"created":1}}"#.into()),
        ("assistant", r#"{"bogus":true}"#.into()),
        (
            "assistant",
            assistant(&[
                r#"{"type":"text","text":"Done"}"#.into(),
                tool("call_streaming", "streaming"),
            ]),
        ),
        ("synthetic", r#"{"bogus":true}"#.into()),
        ("assistant", assistant(&[tool("call_completed", "completed")])),
        ("assistant", assistant(&[tool("call_running", "running")])),
        (
            "compaction",
            r#"{"jobID":"cmp_current","trigger":"manual","status":"completed","revision":1,"boundary":{"messageID":"msg_bounded_4","seq":4},"metrics":{"excludedMessages":1,"excludedParts":0,"inputTokens":10,"retainedTokens":5},"time":{"created":1}}"#.into(),
        ),
        ("synthetic", r#"{"text":"newest","time":{"created":1}}"#.into()),
    ];
    insert(
        &store,
        rows.iter()
            .enumerate()
            .map(|(index, (type_, data))| {
                row(&format!("msg_bounded_{index}"), type_, index as i64, data)
            })
            .collect(),
    );
    let named = |indexes: &[usize]| {
        indexes
            .iter()
            .map(|index| format!("msg_bounded_{index}"))
            .collect::<Vec<_>>()
    };

    let latest = |type_: &str| {
        service
            .latest(&id(), type_)
            .unwrap()
            .map(|message| message_id(&message))
    };
    assert_eq!(latest("assistant"), Some("msg_bounded_9".into()));
    assert_eq!(latest("user"), Some("msg_bounded_4".into()));
    assert_eq!(latest("skill"), None);
    assert_eq!(
        ids(&service.recent(&id(), 4).unwrap()),
        named(&[8, 9, 10, 11])
    );
    assert_eq!(
        ids(&service.unsettled_tool_messages(&id()).unwrap()),
        named(&[6, 9])
    );
    assert!(service.context(&id()).is_err());

    store
        .submit(|tx| {
            for id in ["msg_bounded_5", "msg_bounded_7"] {
                tx.delete::<MessageTable>(&tuple_key(&[KeyPart::String(&id.into())]))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let recent = ids(&service.recent(&id(), 100).unwrap());
    assert_eq!(recent, ids(&service.context(&id()).unwrap()));
    assert_eq!(recent, named(&[3, 4, 6, 8, 9, 10, 11]));
}

#[tokio::test]
async fn observation_state_skips_unrelated_corrupt_payloads_and_ignores_untrusted_observations() {
    let store = support::store();
    let service = Service::new(store.client());
    insert(
        &store,
        vec![
            row("msg_corrupt", "assistant", 0, "null"),
            row(
                "msg_untrusted",
                "system",
                1,
                r#"{"text":"Current state","metadata":{"contextSource":"session-state"},"time":{"created":1}}"#,
            ),
        ],
    );
    let observed = service.observation_state(&id()).unwrap();
    assert_eq!(observed.present, vec![Source::SessionState]);
    assert!(observed.latest.is_empty());
    assert!(service.model_history(&id()).is_err());
}

#[tokio::test]
async fn observation_state_selects_the_newest_trusted_text_per_source_in_chronological_discovery() {
    let store = support::store();
    let service = Service::new(store.client());
    observe(&service, "evt_step", 1, "step-limit", "Limit").await;
    observe(&service, "evt_old", 2, "session-state", "Old state").await;
    observe(&service, "evt_team", 3, "team-view", "Team").await;
    observe(&service, "evt_new", 4, "session-state", "New state").await;
    service
        .publish(event(
            "session.synthetic",
            "evt_forged",
            5,
            r#","text":"Forged state","metadata":{"contextSource":"session-state"}"#,
        ))
        .await
        .unwrap();
    let observed = service.observation_state(&id()).unwrap();
    let texts = observed
        .latest
        .iter()
        .map(|(source, text)| (*source, text.to_utf8().unwrap()))
        .collect::<Vec<_>>();
    assert_eq!(
        texts,
        vec![
            (Source::SessionState, "New state".to_string()),
            (Source::TeamView, "Team".to_string()),
            (Source::StepLimit, "Limit".to_string()),
        ]
    );
    assert_eq!(
        observed.present,
        vec![Source::SessionState, Source::TeamView, Source::StepLimit]
    );
}

#[tokio::test]
async fn observation_state_rejects_corruption_in_selected_observations_and_omits_project_artifact_boundary_notices()
 {
    let store = support::store();
    let service = Service::new(store.client());
    store
        .submit(|tx| {
            ycoding_store::session::reserve_sequence(tx, &"ses_one".into(), 5)?;
            EventTable::insert(
                tx,
                &ycoding_store::session::Event {
                    id: "evt_boundary".into(),
                    aggregate_id: "ses_one".into(),
                    seq: 5,
                    created: 1,
                    type_: "session.project-artifacts-ended.1".into(),
                    data: parse_json(
                        r#"{"sessionID":"ses_one","oldProjectID":"prj_a","newProjectID":"prj_b"}"#,
                    )
                    .unwrap(),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    insert(
        &store,
        vec![row(
            "msg_corrupt_observation",
            "system",
            10,
            r#"{"text":1,"metadata":{"contextSource":"session-state"},"time":{"created":1}}"#,
        )],
    );
    assert!(service.observation_state(&id()).is_err());
    store
        .submit(|tx| {
            MessageTable::put(
                tx,
                &row(
                    "msg_corrupt_observation",
                    "synthetic",
                    10,
                    r#"{"text":"Project boundary","description":"TeamView update","metadata":{"contextSource":"team-view","projectArtifactsEnded":{}},"time":{"created":1}}"#,
                ),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(service.observation_state(&id()).unwrap().present.is_empty());
    assert!(
        !ids(&service
            .model_history(&id())
            .unwrap()
            .into_iter()
            .map(|entry| entry.message)
            .collect::<Vec<_>>())
        .contains(&"msg_corrupt_observation".to_string())
    );
}

#[tokio::test]
async fn observation_state_pages_past_untrusted_rows_to_find_older_trusted_observations() {
    let store = support::store();
    let service = Service::new(store.client());
    observe(&service, "evt_deep", 1, "team-view", "Deep team").await;
    insert(
        &store,
        (0..250)
            .map(|index| {
                row(
                    &format!("msg_untrusted_{index}"),
                    "system",
                    1_000 + index,
                    r#"{"text":"Untrusted","metadata":{"contextSource":"session-state"},"time":{"created":1}}"#,
                )
            })
            .collect(),
    );
    let observed = service.observation_state(&id()).unwrap();
    assert_eq!(
        observed.present,
        vec![Source::SessionState, Source::TeamView]
    );
    assert_eq!(
        observed.latest,
        vec![(Source::TeamView, "Deep team".into())]
    );
}

fn skill_row(index: usize) -> Message {
    row(
        &format!("msg_skill_{index}"),
        "skill",
        index as i64,
        &format!(
            r#"{{"skill":"skill-{index}","name":"Skill {index}","text":"guidance","time":{{"created":1}}}}"#
        ),
    )
}

#[test]
fn skill_statuses_retain_chronology_without_decoding_unrelated_assistant_payloads() {
    let store = support::store();
    let service = Service::new(store.client());
    insert(
        &store,
        vec![
            skill_row(0),
            row("msg_irrelevant", "assistant", 1, r#"{"bogus":true}"#),
            row(
                "msg_switch",
                "agent-switched",
                2,
                r#"{"agent":"build","time":{"created":1}}"#,
            ),
        ],
    );
    let statuses = service.skills(&id(), &[]).unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].content.as_str(), Some("guidance"));
    assert_eq!(
        statuses[0].state,
        State::Inactive {
            inactive_reason: "agent_switched".into()
        }
    );
}

#[test]
fn skill_projection_folds_paged_activations_tool_snapshots_duplicates_and_explicit_deactivations() {
    let store = support::store();
    let service = Service::new(store.client());
    let tool = |already_active: bool, output: &str| {
        format!(
            r#"{{"type":"tool","id":"call_skill","name":"skill","state":{{"status":"completed","input":{{"id":"tool-skill"}},"content":[],"structured":{{"name":"Tool skill","directory":"/skills","output":"{output}","alreadyActive":{already_active}}}}},"time":{{"created":1}}}}"#
        )
    };
    let mut rows = (0..201).map(skill_row).collect::<Vec<_>>();
    rows.push(row(
        "msg_tool_skill",
        "assistant",
        201,
        &assistant(&[tool(false, "tool guidance")]),
    ));
    let mut duplicate = assistant(&[tool(true, "duplicate")]);
    duplicate.insert_str(
        duplicate.len() - 1,
        r#","skillDeactivations":[{"skill":"skill-0","reason":"conflict_resolved"}]"#,
    );
    rows.push(row("msg_duplicate", "assistant", 202, &duplicate));
    insert(&store, rows);
    let statuses = service.skills(&id(), &[]).unwrap();
    assert_eq!(statuses.len(), 202);
    let find = |skill: &str| {
        statuses
            .iter()
            .find(|status| status.id.as_str() == Some(skill))
            .unwrap()
    };
    assert_eq!(
        find("skill-0").state,
        State::Inactive {
            inactive_reason: "conflict_resolved".into()
        }
    );
    let tool_skill = find("tool-skill");
    assert_eq!(tool_skill.content.as_str(), Some("tool guidance"));
    assert_eq!(
        tool_skill.activation_message_id.as_lossless().as_str(),
        Some("msg_tool_skill")
    );
    assert_eq!(tool_skill.state, State::Active);
}
