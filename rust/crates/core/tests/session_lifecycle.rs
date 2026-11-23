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
async fn duplicate_pin_leaves_the_file_unchanged_and_pin_follows_a_queued_unpin() {
    use std::{future::Future, pin::pin, sync::mpsc, task::Context, task::Waker, time::Duration};
    use ycoding_store::{
        Metadata, Options, Store,
        native::{DatabaseKind, catalog},
        project::{Project, ProjectTable},
        session::SessionTable,
    };

    let path =
        std::env::temp_dir().join(format!("ycoding-session-pin-{}.redb", std::process::id()));
    let catalog = catalog(DatabaseKind::Core);
    let store =
        Store::initialize(&path, Options::core(), catalog, Metadata::new([7; 16], 1)).unwrap();
    store
        .submit(|tx| {
            let session = support::record("ses_one");
            ProjectTable::insert(
                tx,
                &Project {
                    id: session.project_id.clone(),
                    worktree: session.directory.clone(),
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
            SessionTable::insert(tx, &session)
        })
        .unwrap()
        .wait()
        .unwrap();
    let session = id("ses_one");
    let pinned = |sessions: &Service| sessions.get(&session).unwrap().unwrap().time.pinned;
    let mut sessions = Service::new(store.client());
    assert!(sessions.change(&session, Change::Pin).await.unwrap());
    let first_pin = pinned(&sessions).unwrap();
    let file_before = std::fs::read(&path).unwrap();
    assert!(sessions.change(&session, Change::Pin).await.unwrap());
    assert_eq!(pinned(&sessions), Some(first_pin));
    assert_eq!(events(&sessions, "ses_one"), 1);
    assert!(std::fs::read(&path).unwrap() == file_before);

    let (started, entered) = mpsc::channel();
    let (release, held) = mpsc::channel();
    let writer = store
        .submit(move |_| {
            started.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(())
        })
        .unwrap();
    entered.recv_timeout(Duration::from_secs(10)).unwrap();
    {
        let mut unpin = pin!(sessions.change(&session, Change::Unpin));
        let mut pin = pin!(sessions.change(&session, Change::Pin));
        let mut context = Context::from_waker(Waker::noop());
        assert!(unpin.as_mut().poll(&mut context).is_pending());
        assert!(pin.as_mut().poll(&mut context).is_pending());
        release.send(()).unwrap();
        writer.await.unwrap();
        assert!(unpin.await.unwrap());
        assert!(pin.await.unwrap());
    }
    let repinned = pinned(&sessions).unwrap();
    let history = sessions.log(&session, None, 100).unwrap();
    assert_eq!(history.events.len(), 3);
    store.shutdown().unwrap();

    let store = Store::open(&path, Options::core(), catalog).unwrap();
    sessions = Service::new(store.client());
    assert_eq!(pinned(&sessions), Some(repinned));
    assert_eq!(sessions.log(&session, None, 100).unwrap(), history);
    assert!(sessions.change(&session, Change::Unpin).await.unwrap());
    store.shutdown().unwrap();

    let store = Store::open(&path, Options::core(), catalog).unwrap();
    sessions = Service::new(store.client());
    assert!(pinned(&sessions).is_none());
    assert_eq!(events(&sessions, "ses_one"), 4);
    store.shutdown().unwrap();
    std::fs::remove_file(path).unwrap();
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
