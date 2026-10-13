use ycoding_core::session::store::Service;
use ycoding_schema::{parse_json, session};
use ycoding_store::{
    KeyPart, Store,
    project::{Project, ProjectTable, Workspace, WorkspaceTable},
    session::{
        Document, InstructionState, InstructionStateTable, NewEvent, SessionTable, latest_sequence,
    },
    tuple_key,
};

#[path = "session_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn moved(session: &str, now: i64, data: &str) -> NewEvent {
    NewEvent {
        id: format!("evt_moved_{now}").into(),
        aggregate_id: session.into(),
        created: now,
        type_: "session.moved.1".into(),
        data: parse_json(data).unwrap(),
    }
}

fn seed_instruction_state(store: &Store, session: &str) {
    store
        .submit({
            let session = session.to_string();
            move |tx| {
                InstructionStateTable::insert(
                    tx,
                    &InstructionState {
                        session_id: session.into(),
                        epoch_start: 0,
                        through_seq: 0,
                        initial_values: Document::new(parse_json("{}").unwrap())?,
                        current_values: Document::new(parse_json("{}").unwrap())?,
                    },
                )
            }
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn has_instruction_state(store: &Store, session: &str) -> bool {
    store
        .snapshot()
        .unwrap()
        .get::<InstructionStateTable>(&tuple_key(&[KeyPart::String(&session.into())]))
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn move_projects_the_new_location_project_and_subpath_and_resets_the_instruction_epoch() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_instruction_state(&store, "ses_one");
    seed_instruction_state(&store, "ses_two");
    store
        .submit(|tx| {
            ProjectTable::insert(
                tx,
                &Project {
                    id: "prj_two".into(),
                    worktree: "/moved".into(),
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
            WorkspaceTable::insert(
                tx,
                &Workspace {
                    id: "wrk_new".into(),
                    type_: "local".into(),
                    name: "new".into(),
                    branch: None,
                    directory: None,
                    extra: None,
                    project_id: "prj_two".into(),
                    time_used: 0,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();

    service
        .publish(moved(
            "ses_one",
            50,
            r#"{"sessionID":"ses_one","location":{"directory":"/moved","workspaceID":"wrk_new"},"projectID":"prj_two","subpath":"packages/app"}"#,
        ))
        .await
        .unwrap();

    let info = service.get(&id("ses_one")).unwrap().unwrap();
    assert_eq!(
        info.location.directory.as_lossless().to_utf8().unwrap(),
        "/moved"
    );
    assert_eq!(
        info.location
            .workspace_id
            .unwrap()
            .as_lossless()
            .to_utf8()
            .unwrap(),
        "wrk_new"
    );
    assert_eq!(info.project_id.as_lossless().to_utf8().unwrap(), "prj_two");
    assert_eq!(
        info.subpath.unwrap().as_lossless().to_utf8().unwrap(),
        "packages/app"
    );
    assert_eq!(info.time.updated.epoch_millis(), 50);
    assert!(!has_instruction_state(&store, "ses_one"));
    assert!(has_instruction_state(&store, "ses_two"));
}

#[tokio::test]
async fn move_without_project_or_subpath_keeps_them_and_clears_the_workspace() {
    let store = support::store();
    let service = Service::new(store.client());
    store
        .submit(|tx| {
            let key = tuple_key(&[KeyPart::String(&"ses_one".into())]);
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.workspace_id = Some("wrk_old".into());
            row.path = Some("old/sub".into());
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();

    service
        .publish(moved(
            "ses_one",
            60,
            r#"{"sessionID":"ses_one","location":{"directory":"/elsewhere"}}"#,
        ))
        .await
        .unwrap();

    let info = service.get(&id("ses_one")).unwrap().unwrap();
    assert_eq!(
        info.location.directory.as_lossless().to_utf8().unwrap(),
        "/elsewhere"
    );
    assert!(info.location.workspace_id.is_none());
    assert_eq!(info.project_id.as_lossless().to_utf8().unwrap(), "prj_one");
    assert_eq!(
        info.subpath.unwrap().as_lossless().to_utf8().unwrap(),
        "old/sub"
    );
}

#[tokio::test]
async fn move_rejects_a_missing_session_without_publishing() {
    let store = support::store();
    let service = Service::new(store.client());
    let before = latest_sequence(&store.snapshot().unwrap(), &"ses_missing".into()).unwrap();

    let result = service
        .publish(moved(
            "ses_missing",
            70,
            r#"{"sessionID":"ses_missing","location":{"directory":"/moved"}}"#,
        ))
        .await;

    assert!(result.is_err());
    assert_eq!(
        latest_sequence(&store.snapshot().unwrap(), &"ses_missing".into()).unwrap(),
        before
    );
}
