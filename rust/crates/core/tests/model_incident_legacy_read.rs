use std::ops::Bound;
use ycoding_core::model_incident::{
    RecentInput, Service,
    record::{self, GuardrailInput},
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, guardrail, model_incident, provider, session,
    session_message_id,
};
use ycoding_store::{
    Metadata, Options, Store,
    model_incident::{Incident, IncidentTable},
    native::{self, DatabaseKind},
    project,
    session::{self as tables, Document},
};

fn s(value: &str) -> LosslessString {
    value.into()
}

fn session_row(id: &str) -> tables::Session {
    tables::Session {
        id: s(id),
        project_id: s("prj_one"),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: s("/project"),
        path: None,
        title: s(id),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
        origin: None,
        scope: "bound".into(),
    }
}

fn store() -> Store {
    let store = Store::disposable(
        Options::core(),
        native::catalog(DatabaseKind::Core),
        Metadata::new([4; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: s("prj_one"),
                    worktree: s("/project"),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 0,
                    time_updated: 0,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            tables::SessionTable::insert(tx, &session_row("ses_one"))?;
            tables::MessageTable::insert(
                tx,
                &tables::Message {
                    id: s("msg_assistant"),
                    session_id: s("ses_one"),
                    type_: s("assistant"),
                    seq: 1,
                    time_created: 1,
                    time_updated: 1,
                    data: ycoding_schema::parse_json(
                        r#"{"agent":"plan","model":{"providerID":"openai","id":"gpt"}}"#,
                    )
                    .unwrap(),
                },
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

fn incident(id: &str, time: i64, decided_by: &str) -> Incident {
    Incident {
        id: s(id),
        time_created: time,
        kind: s("guardrail-rejected"),
        provider_id: s("openai"),
        model_id: s("gpt"),
        variant: None,
        profile: None,
        agent: s("plan"),
        project_id: s("prj_one"),
        session_id: s("ses_one"),
        request_id: Some(s(&format!("request_{id}"))),
        category: s("ordinary"),
        rule_ids: Document::new(JsonValue::Array(vec![])).unwrap(),
        target: None,
        decided_by: Some(s(decided_by)),
    }
}

fn stored(store: &Store) -> Vec<Incident> {
    store
        .snapshot()
        .unwrap()
        .scan::<IncidentTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
}

#[tokio::test]
async fn a_stored_human_decision_is_read_as_client_and_the_row_stays_human() {
    let store = store();
    let rows = [
        incident("inc_a", 10, "human"),
        incident("inc_b", 20, "client"),
        incident("inc_c", 30, "decision-model"),
    ];
    store
        .submit({
            let rows = rows.to_vec();
            move |tx| {
                rows.iter()
                    .try_for_each(|row| IncidentTable::insert(tx, row))
            }
        })
        .unwrap()
        .wait()
        .unwrap();
    let recent = Service::new(store.client())
        .recent(RecentInput {
            provider: provider::Id(s("openai")),
            model: s("gpt"),
            agent: None,
            limit: None,
        })
        .await
        .unwrap();
    assert_eq!(
        recent
            .items
            .iter()
            .map(|item| (
                item.id.0.as_str().unwrap(),
                item.decided_by.as_ref().and_then(|value| value.0.as_str()),
            ))
            .collect::<Vec<_>>(),
        [
            ("inc_c", Some("decision-model")),
            ("inc_b", Some("client")),
            ("inc_a", Some("client")),
        ]
    );
    assert_eq!(stored(&store), rows);
}

#[test]
fn a_new_decision_cannot_name_human_or_an_unknown_decider() {
    for value in ["human", "robot"] {
        assert!(
            model_incident::DecidedBy::decode(&JsonValue::String(s(value))).is_err(),
            "{value}"
        );
    }
    for value in ["human", "robot"] {
        let store = store();
        let input = GuardrailInput {
            session_id: session::Id::new("ses_one").unwrap(),
            request_id: guardrail::RequestId::decode(&JsonValue::String(s("grq_one"))).unwrap(),
            message_id: Some(session_message_id::Id::new("msg_assistant").unwrap()),
            rule_ids: vec![],
            hard_review: false,
            time: 50,
        };
        let result = store
            .submit(move |tx| {
                record::rejection(
                    tx,
                    &model_incident::Id(s("inc_forged")),
                    &input,
                    &model_incident::DecidedBy(s(value)),
                )
            })
            .and_then(|receipt| receipt.wait());
        assert!(result.is_err(), "{value}");
        assert!(stored(&store).is_empty(), "{value}");
    }
}
