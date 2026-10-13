use ycoding_core::session::{pending, store::Service};
use ycoding_core::ycoding_schema::{
    DomainDecode, event, session, session_delivery, session_message, session_pending,
};
use ycoding_core::ycoding_store::{
    Catalog, Metadata, Options, Store, TableDeclaration, analytics, project, session as tables,
};

const CATALOG: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<project::ProjectTable>(),
        TableDeclaration::of::<project::WorkspaceTable>(),
        TableDeclaration::of::<tables::SessionTable>(),
        TableDeclaration::of::<tables::SequenceTable>(),
        TableDeclaration::of::<tables::EventTable>(),
        TableDeclaration::of::<tables::MessageTable>(),
        TableDeclaration::of::<tables::PendingTable>(),
        TableDeclaration::of::<tables::RevisionTable>(),
        TableDeclaration::of::<tables::ContextStateTable>(),
        TableDeclaration::of::<tables::InstructionEntryTable>(),
        TableDeclaration::of::<tables::InstructionBlobTable>(),
        TableDeclaration::of::<tables::InstructionStateTable>(),
        TableDeclaration::of::<ycoding_core::ycoding_store::resources::CredentialTable>(),
        TableDeclaration::of::<ycoding_core::ycoding_store::resources::RequestTable>(),
        TableDeclaration::of::<ycoding_core::ycoding_store::resources::UsageTable>(),
        TableDeclaration::of::<ycoding_core::ycoding_store::resources::ContinuationGenerationTable>(
        ),
        TableDeclaration::of::<ycoding_core::ycoding_store::resources::ContinuationTable>(),
        TableDeclaration::of::<ycoding_core::ycoding_store::resources::StateBlobTable>(),
        TableDeclaration::of::<ycoding_core::ycoding_store::resources::StateLinkTable>(),
        TableDeclaration::of::<tables::ManifestTable>(),
        TableDeclaration::of::<tables::ExclusionTable>(),
        TableDeclaration::of::<analytics::DeliveryTable>(),
        TableDeclaration::of::<analytics::IntentTable>(),
    ],
);

fn store() -> ycoding_core::ycoding_store::Client {
    let path = std::env::temp_dir().join(format!(
        "ycoding-session-log-{}-{}.redb",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store =
        Store::initialize(&path, Options::core(), CATALOG, Metadata::new([7; 16], 1)).unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_log".into(),
                    worktree: "/log".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            tables::SessionTable::insert(
                tx,
                &tables::Session {
                    id: "ses_log".into(),
                    project_id: "prj_log".into(),
                    workspace_id: None,
                    parent_id: None,
                    fork_session_id: None,
                    fork_message_id: None,
                    fork_seq: None,
                    directory: "/log".into(),
                    path: None,
                    title: "log".into(),
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
                },
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let client = store.client();
    std::mem::forget(store);
    client
}

fn user_input(id: &str, session: &str, delivery: &str) -> pending::Request {
    pending::Request {
        id: session_message::Id::new(id).unwrap(),
        session_id: session::Id::new(session).unwrap(),
        input: session_pending::Message::User(session_pending::UserMessage {
            data: session_pending::UserData {
                text: format!("text of {id}").into(),
                files: None,
                agents: None,
                metadata: None,
            },
            delivery: session_delivery::Delivery::decode(
                &ycoding_core::ycoding_schema::JsonValue::String(delivery.into()),
            )
            .unwrap(),
        }),
        event_id: event::Id::new(format!("evt_{id}")).unwrap(),
        created: 7,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn log_replays_admissions_after_a_cursor_with_a_watermark() {
    let service = Service::new(store());
    let id = session::Id::new("ses_log").unwrap();
    let empty = service.log(&id, None, 64).unwrap();
    assert!(empty.events.is_empty());
    assert_eq!(empty.watermark, None);

    service
        .admit(user_input("msg_log_1", "ses_log", "queue"))
        .await
        .unwrap();
    service
        .admit(user_input("msg_log_2", "ses_log", "steer"))
        .await
        .unwrap();

    let page = service.log(&id, None, 64).unwrap();
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.watermark, Some(1));
    assert_eq!(page.events[0].seq, 0);
    assert_eq!(page.events[1].seq, 1);
    for entry in &page.events {
        assert_eq!(
            entry.event.0.event_type.as_str(),
            Some("session.input.admitted")
        );
    }

    let tail = service.log(&id, Some(0), 64).unwrap();
    assert_eq!(tail.events.len(), 1);
    assert_eq!(tail.events[0].seq, 1);
    assert_eq!(tail.watermark, Some(1));

    let drained = service.log(&id, Some(1), 64).unwrap();
    assert!(drained.events.is_empty());
    assert_eq!(drained.watermark, Some(1));

    let one = service.log(&id, None, 1).unwrap();
    assert_eq!(one.events.len(), 1);
    assert_eq!(one.events[0].seq, 0);
}

#[test]
fn log_rejects_unknown_sessions_and_bad_windows() {
    let service = Service::new(store());
    let missing = service
        .log(&session::Id::new("ses_absent").unwrap(), None, 64)
        .unwrap_err();
    assert!(matches!(
        missing,
        ycoding_core::ycoding_store::Error::Domain {
            kind: "not_found",
            ..
        }
    ));
    let id = session::Id::new("ses_log").unwrap();
    assert!(service.log(&id, None, 0).is_err());
    assert!(service.log(&id, None, 513).is_err());
    assert!(service.log(&id, Some(-1), 64).is_err());
}
