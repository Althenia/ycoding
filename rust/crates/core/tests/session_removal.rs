use ycoding_core::session::store::Service;
use ycoding_schema::{parse_json, session};
use ycoding_store::session::NewEvent;

#[path = "autonomy_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

async fn child(sessions: &Service, id: &str, parent: &str) {
    sessions
        .create(NewEvent {
            id: format!("evt_create_{id}").as_str().into(),
            aggregate_id: id.into(),
            created: 5,
            type_: "session.created.2".into(),
            data: parse_json(&format!(
                r#"{{"sessionID":"{id}","projectID":"prj_one","location":{{"directory":"/project"}},"title":"Kid","created":5,"parentID":"{parent}"}}"#
            ))
            .unwrap(),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn remove_deletes_the_session_with_every_descendant_and_nothing_else() {
    let store = support::store();
    let sessions = Service::new(store.client());
    child(&sessions, "ses_kid", "ses_one").await;
    child(&sessions, "ses_grandkid", "ses_kid").await;
    child(&sessions, "ses_other_kid", "ses_two").await;

    let removed = sessions.remove(&id("ses_one")).await.unwrap();

    assert_eq!(
        removed,
        vec![id("ses_grandkid"), id("ses_kid"), id("ses_one")]
    );
    for gone in ["ses_one", "ses_kid", "ses_grandkid"] {
        assert!(sessions.get(&id(gone)).unwrap().is_none(), "{gone}");
    }
    for kept in ["ses_two", "ses_other_kid"] {
        assert!(sessions.get(&id(kept)).unwrap().is_some(), "{kept}");
    }
}

#[tokio::test]
async fn remove_of_an_unknown_session_changes_nothing() {
    let store = support::store();
    let sessions = Service::new(store.client());

    assert!(
        sessions
            .remove(&id("ses_missing"))
            .await
            .unwrap()
            .is_empty()
    );
    assert!(sessions.get(&id("ses_one")).unwrap().is_some());
    assert!(sessions.get(&id("ses_two")).unwrap().is_some());
}

#[tokio::test]
async fn remove_of_a_leaf_keeps_its_parent() {
    let store = support::store();
    let sessions = Service::new(store.client());
    child(&sessions, "ses_leaf", "ses_one").await;

    assert_eq!(
        sessions.remove(&id("ses_leaf")).await.unwrap(),
        vec![id("ses_leaf")]
    );
    assert!(sessions.get(&id("ses_leaf")).unwrap().is_none());
    assert!(sessions.get(&id("ses_one")).unwrap().is_some());
}
