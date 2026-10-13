use ycoding_core::session::{prompt_cache::sha256, store::Service};
use ycoding_schema::{DomainDecode, parse_json, session, session_todo};
use ycoding_store::{
    KeyPart,
    session::{TodoState, TodoStateTable},
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn todo(content: &str, status: &str, priority: &str) -> session_todo::Info {
    session_todo::Info::decode(
        &parse_json(&format!(
            r#"{{"content":{},"status":"{status}","priority":"{priority}"}}"#,
            ycoding_schema::stringify_json(&ycoding_schema::JsonValue::String(content.into()))
        ))
        .unwrap(),
    )
    .unwrap()
}

fn contents(sessions: &Service, session: &str) -> Vec<String> {
    sessions
        .todos(&id(session))
        .unwrap()
        .iter()
        .map(|todo| todo.content.to_utf8().unwrap())
        .collect()
}

fn state(store: &ycoding_store::Store, session: &str) -> Option<TodoState> {
    store
        .snapshot()
        .unwrap()
        .get::<TodoStateTable>(&tuple_key(&[KeyPart::String(id(session).as_lossless())]))
        .unwrap()
}

#[tokio::test]
async fn an_update_replaces_the_list_in_input_order_and_bumps_the_state_revision() {
    let store = support::store();
    let sessions = Service::new(store.client());

    sessions
        .update_todos(
            &id("ses_one"),
            &[
                todo("write tests", "in_progress", "high"),
                todo("ship", "pending", "low"),
            ],
        )
        .await
        .unwrap();
    assert_eq!(contents(&sessions, "ses_one"), ["write tests", "ship"]);
    let first = state(&store, "ses_one").unwrap();
    assert_eq!(first.revision, 1);

    sessions
        .update_todos(&id("ses_one"), &[todo("ship", "completed", "low")])
        .await
        .unwrap();

    let rows = sessions.todos(&id("ses_one")).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].content.as_str(), Some("ship"));
    assert_eq!(rows[0].status.as_str(), Some("completed"));
    assert_eq!(rows[0].priority.as_str(), Some("low"));
    assert_eq!(state(&store, "ses_one").unwrap().revision, 2);
}

#[tokio::test]
async fn the_state_digest_is_the_sha256_of_the_ordered_rows_as_javascript_serializes_them() {
    let store = support::store();
    let sessions = Service::new(store.client());

    sessions
        .update_todos(
            &id("ses_one"),
            &[
                todo("say \"hi\"\né", "pending", "high"),
                todo("b", "cancelled", "medium"),
            ],
        )
        .await
        .unwrap();

    assert_eq!(
        state(&store, "ses_one").unwrap().digest.to_utf8().unwrap(),
        sha256(
            r#"[{"content":"say \"hi\"\né","status":"pending","priority":"high","position":0},{"content":"b","status":"cancelled","priority":"medium","position":1}]"#
        )
    );
}

#[tokio::test]
async fn an_empty_update_clears_the_rows_and_still_records_a_new_revision() {
    let store = support::store();
    let sessions = Service::new(store.client());
    sessions
        .update_todos(&id("ses_one"), &[todo("a", "pending", "high")])
        .await
        .unwrap();

    sessions.update_todos(&id("ses_one"), &[]).await.unwrap();

    assert!(sessions.todos(&id("ses_one")).unwrap().is_empty());
    let cleared = state(&store, "ses_one").unwrap();
    assert_eq!(cleared.revision, 2);
    assert_eq!(cleared.digest.to_utf8().unwrap(), sha256("[]"));
}

#[tokio::test]
async fn an_update_leaves_other_sessions_untouched() {
    let store = support::store();
    let sessions = Service::new(store.client());
    sessions
        .update_todos(&id("ses_two"), &[todo("elsewhere", "pending", "low")])
        .await
        .unwrap();

    sessions
        .update_todos(&id("ses_one"), &[todo("mine", "pending", "high")])
        .await
        .unwrap();
    sessions.update_todos(&id("ses_one"), &[]).await.unwrap();

    assert_eq!(contents(&sessions, "ses_two"), ["elsewhere"]);
    assert_eq!(state(&store, "ses_two").unwrap().revision, 1);
}

#[tokio::test]
async fn an_update_for_an_unknown_session_fails_without_writing_anything() {
    let store = support::store();
    let sessions = Service::new(store.client());

    let error = sessions
        .update_todos(&id("ses_missing"), &[todo("a", "pending", "high")])
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        ycoding_store::Error::Domain {
            kind: "not_found",
            ..
        }
    ));
    assert!(sessions.todos(&id("ses_missing")).unwrap().is_empty());
    assert!(state(&store, "ses_missing").is_none());
}
