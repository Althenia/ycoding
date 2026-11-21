use ycoding_core::session::{lifecycle::Change, store::Service};
use ycoding_schema::session;
use ycoding_store::session::{Todo, TodoTable};

#[path = "autonomy_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn events(sessions: &Service, session: &str) -> usize {
    sessions.log(&id(session), None, 100).unwrap().events.len()
}

#[tokio::test]
async fn archive_and_unarchive_toggle_the_archived_time_and_ignore_repeats() {
    let store = support::store();
    let sessions = Service::new(store.client());
    let archived =
        |sessions: &Service| sessions.get(&id("ses_one")).unwrap().unwrap().time.archived;

    assert!(
        sessions
            .change(&id("ses_one"), Change::Archive)
            .await
            .unwrap()
    );
    assert!(archived(&sessions).is_some());
    assert!(
        sessions
            .change(&id("ses_one"), Change::Archive)
            .await
            .unwrap()
    );
    assert_eq!(events(&sessions, "ses_one"), 1);

    assert!(
        sessions
            .change(&id("ses_one"), Change::Unarchive)
            .await
            .unwrap()
    );
    assert!(archived(&sessions).is_none());
    assert!(
        sessions
            .change(&id("ses_one"), Change::Unarchive)
            .await
            .unwrap()
    );
    assert_eq!(events(&sessions, "ses_one"), 2);
    assert_eq!(events(&sessions, "ses_two"), 0);
}

#[tokio::test]
async fn pin_and_unpin_toggle_the_pinned_time_and_ignore_repeats() {
    let store = support::store();
    let sessions = Service::new(store.client());
    let pinned = |sessions: &Service| sessions.get(&id("ses_one")).unwrap().unwrap().time.pinned;

    assert!(sessions.change(&id("ses_one"), Change::Pin).await.unwrap());
    assert!(pinned(&sessions).is_some());
    assert!(sessions.change(&id("ses_one"), Change::Pin).await.unwrap());
    assert_eq!(events(&sessions, "ses_one"), 1);

    assert!(
        sessions
            .change(&id("ses_one"), Change::Unpin)
            .await
            .unwrap()
    );
    assert!(pinned(&sessions).is_none());
    assert!(
        sessions
            .change(&id("ses_one"), Change::Unpin)
            .await
            .unwrap()
    );
    assert_eq!(events(&sessions, "ses_one"), 2);
}

#[tokio::test]
async fn rename_replaces_the_title_and_always_records_an_event() {
    let store = support::store();
    let sessions = Service::new(store.client());
    let title = |sessions: &Service| sessions.get(&id("ses_one")).unwrap().unwrap().title;

    assert!(
        sessions
            .change(&id("ses_one"), Change::Rename("Renamed".into()))
            .await
            .unwrap()
    );
    assert_eq!(title(&sessions), "Renamed".into());
    assert!(
        sessions
            .change(&id("ses_one"), Change::Rename("Renamed".into()))
            .await
            .unwrap()
    );
    assert_eq!(events(&sessions, "ses_one"), 2);
    assert_eq!(
        sessions.get(&id("ses_two")).unwrap().unwrap().title,
        "Test".into()
    );
}

#[tokio::test]
async fn changes_to_an_unknown_session_report_it_missing_and_record_nothing() {
    let store = support::store();
    let sessions = Service::new(store.client());

    for change in [
        Change::Archive,
        Change::Unarchive,
        Change::Pin,
        Change::Unpin,
        Change::Rename("x".into()),
    ] {
        assert!(!sessions.change(&id("ses_missing"), change).await.unwrap());
    }
    assert!(sessions.get(&id("ses_missing")).unwrap().is_none());
}

#[tokio::test]
async fn todos_come_back_in_position_order_for_one_session_only() {
    let store = support::store();
    let sessions = Service::new(store.client());
    store
        .submit(|tx| {
            for (session, position, content) in [
                ("ses_one", 1, "second"),
                ("ses_one", 0, "first"),
                ("ses_two", 0, "elsewhere"),
            ] {
                TodoTable::insert(
                    tx,
                    &Todo {
                        session_id: session.into(),
                        content: content.into(),
                        status: "in_progress".into(),
                        priority: "high".into(),
                        position,
                        time_created: 1,
                        time_updated: 1,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();

    let todos = sessions.todos(&id("ses_one")).unwrap();

    assert_eq!(
        todos
            .iter()
            .map(|todo| todo.content.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert_eq!(todos[0].status.as_str(), Some("in_progress"));
    assert_eq!(todos[0].priority.as_str(), Some("high"));
    assert!(sessions.todos(&id("ses_missing")).unwrap().is_empty());
}
