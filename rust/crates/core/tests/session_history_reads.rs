use ycoding_core::session::{history::Source, history_pruning, store::Service};
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

#[path = "session_support/checkpoint.rs"]
mod checkpoint;

fn retained_rows(store: &Store, session: &str, through: i64) -> Vec<String> {
    ycoding_store::session::messages(
        &store.snapshot().unwrap(),
        &session.into(),
        std::ops::Bound::Excluded(through),
        std::ops::Bound::Unbounded,
        ycoding_store::IndexOrder::Ascending,
        None,
        1000,
    )
    .unwrap()
    .into_iter()
    .map(|row| row.record.id.to_utf8().unwrap())
    .collect()
}

fn checkpoint_head(
    message: &session_message::Info,
    checkpoint: &history_pruning::Checkpoint,
) -> bool {
    let session_message::Info::Synthetic(synthetic) = message else {
        return false;
    };
    let digest = checkpoint.manifest_digest.to_utf8().unwrap();
    let marker = synthetic
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(&"compactionCheckpoint".into()));
    synthetic.id.as_lossless().as_str() == Some(format!("msg_compaction_{digest}").as_str())
        && synthetic
            .description
            .as_ref()
            .and_then(|value| value.as_str())
            == Some("Compaction checkpoint")
        && synthetic
            .text
            .to_utf8()
            .unwrap()
            .contains(checkpoint::SUMMARY)
        && marker
            == Some(
                &parse_json(&format!(
                    r#"{{"manifestDigest":"{digest}","through":{}}}"#,
                    checkpoint.through
                ))
                .unwrap(),
            )
}

fn paged(service: &Service, session: &session::Id, limit: usize) -> Vec<session_message::Info> {
    let mut pages = Vec::new();
    let mut before = None;
    loop {
        let page = service.snapshot(session, limit, before.as_deref()).unwrap();
        pages.insert(0, page.messages);
        match page.before {
            Some(cursor) => before = Some(cursor),
            None => return pages.into_iter().flatten().collect(),
        }
    }
}

#[tokio::test]
async fn ended_local_checkpoint_defines_canonical_retained_floor() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());
    let scenario = checkpoint::scenario(&client, &service, "ses_main", 1_000).await;
    let session = &scenario.session;
    let found = history_pruning::checkpoint(&store.snapshot().unwrap(), session)
        .unwrap()
        .unwrap();
    assert_eq!(found.through, scenario.through);
    assert_eq!(found.job.to_utf8().unwrap(), scenario.job);
    assert_eq!(found.text.as_str(), Some(checkpoint::SUMMARY));
    assert_eq!(found.ended, 1_000);

    let latest = |type_: &str| {
        service
            .latest(session, type_)
            .unwrap()
            .map(|m| message_id(&m))
    };
    assert_eq!(latest("user"), Some(scenario.ids.tail_user.clone()));
    assert_eq!(latest("assistant"), Some(scenario.ids.failed_tail.clone()));
    let retained = retained_rows(&store, "ses_main", scenario.through);
    assert_eq!(ids(&service.recent(session, 100).unwrap()), retained);
    for covered in [
        &scenario.ids.first_user,
        &scenario.ids.fork_target,
        &scenario.ids.covered_user,
        &scenario.ids.boundary,
    ] {
        assert!(!retained.contains(covered));
    }
    assert!(service.unsettled_tool_messages(session).unwrap().is_empty());
    assert_eq!(
        message_id(&service.context(session).unwrap()[0]),
        scenario.ids.first_user
    );
}

#[tokio::test]
async fn failed_remote_unended_and_changed_checkpoints_keep_the_full_canonical_history() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());
    let full = |name: &str, first: &str| {
        let session = checkpoint::id(name);
        assert!(
            history_pruning::checkpoint(&store.snapshot().unwrap(), &session)
                .unwrap()
                .is_none(),
            "{name}"
        );
        let transcript = service.transcript(&session).unwrap();
        assert_eq!(message_id(&transcript[0]), first, "{name}");
        assert!(
            transcript
                .iter()
                .all(|message| !message_id(message).starts_with("msg_compaction_")),
            "{name}"
        );
        assert_eq!(
            ids(&service.recent(&session, 1000).unwrap()),
            ids(&service.context(&session).unwrap()),
            "{name}"
        );
    };

    for (name, kind) in [
        ("ses_failed", checkpoint::Compaction::Failed),
        ("ses_remote", checkpoint::Compaction::Remote),
    ] {
        checkpoint::session(&client, name);
        let first = checkpoint::user(&service, name, "Only request", 1).await;
        let answer = checkpoint::run(
            &service,
            name,
            "Only answer",
            checkpoint::Outcome::Succeeded,
            1,
        )
        .await;
        checkpoint::compaction(&client, &service, name, &answer, kind, 1).await;
        checkpoint::user(&service, name, "Later request", 1).await;
        full(name, &first);
    }

    let unended = checkpoint::scenario(&client, &service, "ses_unended", 1).await;
    let job = unended.job.clone();
    client
        .submit(move |tx| {
            let mut row = tx
                .get::<ycoding_store::session::JobTable>(&checkpoint::key(&job))?
                .unwrap();
            row.status = "failed".into();
            row.manifest_digest = None;
            row.error_code = Some("provider_failed".into());
            row.error_message = Some("Provider failed".into());
            ycoding_store::session::JobTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    full("ses_unended", &unended.ids.first_user);

    let changed = checkpoint::scenario(&client, &service, "ses_changed", 1).await;
    let boundary = changed.ids.boundary.clone();
    client
        .submit(move |tx| {
            let mut row = tx
                .get::<MessageTable>(&checkpoint::key(&boundary))?
                .unwrap();
            let JsonValue::Object(data) = &mut row.data else {
                panic!()
            };
            data.insert("finish".into(), JsonValue::String("length".into()));
            MessageTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    full("ses_changed", &changed.ids.first_user);
}

#[tokio::test]
async fn oldest_snapshot_and_transcript_start_with_checkpoint() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());
    let scenario = checkpoint::scenario(&client, &service, "ses_main", 1_000).await;
    let session = &scenario.session;
    let found = history_pruning::checkpoint(&store.snapshot().unwrap(), session)
        .unwrap()
        .unwrap();
    let retained = retained_rows(&store, "ses_main", scenario.through);

    let transcript = service.transcript(session).unwrap();
    assert!(checkpoint_head(&transcript[0], &found));
    assert_eq!(ids(&transcript[1..]), retained);
    for limit in [1, 2, 3, 200] {
        assert_eq!(paged(&service, session, limit), transcript, "limit {limit}");
    }
    let newest = service.snapshot(session, 2, None).unwrap();
    assert!(newest.before.is_some());
    assert!(
        newest
            .messages
            .iter()
            .all(|message| !checkpoint_head(message, &found))
    );
}

#[tokio::test]
async fn checkpoint_cursors_limits_and_instruction_notices_do_not_leak_covered_rows() {
    let store = support::store();
    let client = store.client();
    let service = Service::new(client.clone());
    checkpoint::session(&client, "ses_main");
    for hash in ["a", "b"] {
        checkpoint::publish(
            &service,
            "ses_main",
            "session.instructions.updated.2",
            1,
            &format!(r#","delta":{{"core/before":"{}"}}"#, hash.repeat(64)),
        )
        .await;
    }
    let scenario = checkpoint::scenario(&client, &service, "ses_main", 1).await;
    for hash in ["a", "b"] {
        checkpoint::publish(
            &service,
            "ses_main",
            "session.instructions.updated.2",
            2,
            &format!(r#","delta":{{"core/after":"{}"}}"#, hash.repeat(64)),
        )
        .await;
    }
    let session = &scenario.session;
    let found = history_pruning::checkpoint(&store.snapshot().unwrap(), session)
        .unwrap()
        .unwrap();
    let text = |message: &session_message::Info| match message {
        session_message::Info::System(system) => system.text.to_utf8().unwrap(),
        _ => String::new(),
    };
    let transcript = service.transcript(session).unwrap();
    let notices = transcript
        .iter()
        .map(text)
        .filter(|text| text.starts_with("Instructions updated"))
        .collect::<Vec<_>>();
    assert_eq!(notices, vec!["Instructions updated: core/after"; 2]);
    assert_eq!(
        text(transcript.last().unwrap()),
        "Instructions updated: core/after"
    );
    assert_eq!(paged(&service, session, 2), transcript);

    let at_floor = service
        .snapshot(
            session,
            2,
            Some(&ycoding_core::session::history::encode_cursor(
                session,
                scenario.through + 1,
            )),
        )
        .unwrap();
    assert_eq!(at_floor.messages.len(), 1);
    assert!(checkpoint_head(&at_floor.messages[0], &found));
    assert!(at_floor.before.is_none());
    let covered = service
        .snapshot(
            session,
            2,
            Some(&ycoding_core::session::history::encode_cursor(session, 1)),
        )
        .unwrap();
    assert!(covered.messages.is_empty());
    assert!(covered.before.is_none());
    for limit in [0, 201] {
        assert!(service.snapshot(session, limit, None).is_err());
    }
}
