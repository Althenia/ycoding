use ycoding_core::session::{
    lifecycle::Change,
    list::{Background, Query},
    store::Service,
};
use ycoding_schema::{DomainEncode, parse_json, schema::Finite, session, stringify_json};
use ycoding_store::{
    Store,
    session::{NewEvent, Session, SessionTable},
};

#[path = "session_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn row(name: &str, updated: i64, executor: bool) -> Session {
    let mut row = support::record(name);
    row.time_created = updated;
    row.time_updated = updated;
    row.origin = executor.then(|| "dots-executor".into());
    row
}

fn seeded() -> (Store, Service) {
    let store = support::store();
    store
        .submit(|tx| {
            for (name, updated, executor) in [
                ("ses_ord_a", 10, false),
                ("ses_bg_1", 20, true),
                ("ses_bg_2", 25, true),
                ("ses_ord_b", 30, false),
                ("ses_bg_3", 35, true),
                ("ses_bg_4", 40, true),
            ] {
                SessionTable::insert(tx, &row(name, updated, executor))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    (store, service)
}

fn ids(sessions: &[session::Info]) -> Vec<String> {
    sessions
        .iter()
        .map(|info| info.id.as_lossless().as_str().unwrap().to_owned())
        .collect()
}

fn exclude() -> Query {
    Query {
        background: Background::Exclude,
        ..Default::default()
    }
}

fn after(name: &str, updated: i64, direction: &str) -> session::ListAnchor {
    session::ListAnchor {
        id: id(name),
        time: Finite::new(updated as f64).unwrap(),
        direction: direction.into(),
    }
}

#[test]
fn background_defaults_to_include_and_exclude_hides_only_executor_sessions() {
    let (_store, service) = seeded();
    let everything = [
        "ses_bg_4",
        "ses_bg_3",
        "ses_ord_b",
        "ses_bg_2",
        "ses_bg_1",
        "ses_ord_a",
        "ses_two",
        "ses_one",
    ];
    assert_eq!(ids(&service.list(&Query::default()).unwrap()), everything);
    assert_eq!(
        ids(&service
            .list(&Query {
                background: Background::Include,
                ..Default::default()
            })
            .unwrap()),
        everything
    );
    assert_eq!(
        ids(&service.list(&exclude()).unwrap()),
        ["ses_ord_b", "ses_ord_a", "ses_two", "ses_one"]
    );
}

#[test]
fn exclusion_applies_before_the_anchor_and_limit_so_background_rows_never_starve_a_page() {
    let (_store, service) = seeded();
    let page = |anchor: Option<session::ListAnchor>| {
        ids(&service
            .list(&Query {
                limit: Some(1),
                anchor,
                ..exclude()
            })
            .unwrap())
    };
    assert_eq!(page(None), ["ses_ord_b"]);
    assert_eq!(page(Some(after("ses_ord_b", 30, "next"))), ["ses_ord_a"]);
    assert_eq!(page(Some(after("ses_ord_a", 10, "next"))), ["ses_two"]);
    assert_eq!(page(Some(after("ses_two", 1, "next"))), ["ses_one"]);
    assert!(page(Some(after("ses_one", 1, "next"))).is_empty());
    assert_eq!(
        page(Some(after("ses_ord_a", 10, "previous"))),
        ["ses_ord_b"]
    );
    assert!(page(Some(after("ses_ord_b", 30, "previous"))).is_empty());
}

#[test]
fn exclusion_composes_with_search_and_parent_filters() {
    let (_store, service) = seeded();
    let expected = ["ses_ord_b", "ses_ord_a", "ses_two", "ses_one"];
    assert_eq!(
        ids(&service
            .list(&Query {
                search: Some("Test".into()),
                ..exclude()
            })
            .unwrap()),
        expected
    );
    assert_eq!(
        ids(&service
            .list(&Query {
                parent: Some(ycoding_core::session::list::Parent::Root),
                ..exclude()
            })
            .unwrap()),
        expected
    );
}

#[test]
fn info_reports_the_origin_only_for_executor_sessions() {
    let (_store, service) = seeded();
    let background = service.get(&id("ses_bg_1")).unwrap().unwrap();
    let ordinary = service.get(&id("ses_ord_a")).unwrap().unwrap();
    assert_eq!(background.origin, Some(session::Origin::DotsExecutor));
    assert_eq!(ordinary.origin, None);
    assert!(stringify_json(&background.encode()).contains("dots-executor"));
    assert!(!stringify_json(&ordinary.encode()).contains("origin"));
}

#[tokio::test]
async fn renaming_never_changes_whether_a_session_is_background() {
    let (_store, service) = seeded();
    for (name, executor) in [("ses_bg_1", true), ("ses_ord_a", false)] {
        assert!(
            service
                .change(
                    &id(name),
                    Change::Rename("Dots · unattributed renamed".into())
                )
                .await
                .unwrap()
        );
        let info = service.get(&id(name)).unwrap().unwrap();
        assert_eq!(info.origin.is_some(), executor);
        assert_eq!(
            ids(&service.list(&exclude()).unwrap()).contains(&name.to_owned()),
            !executor
        );
    }
}

#[tokio::test]
async fn a_fork_of_an_executor_session_is_an_ordinary_session() {
    let (store, service) = seeded();
    let fork = service.fork(&id("ses_bg_1"), None).await.unwrap();
    assert_eq!(fork.origin, None);
    assert_eq!(
        service.get(&id("ses_bg_1")).unwrap().unwrap().origin,
        Some(session::Origin::DotsExecutor)
    );
    let stored = store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(fork.id.as_lossless()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(stored.origin, None);
    assert!(ids(&service.list(&exclude()).unwrap()).contains(&ids(std::slice::from_ref(&fork))[0]));
}

fn created(name: &str, origin: Option<&str>) -> NewEvent {
    let origin = origin
        .map(|origin| format!(r#","origin":"{origin}""#))
        .unwrap_or_default();
    NewEvent {
        id: format!("evt_{name}").into(),
        aggregate_id: name.into(),
        created: 10,
        type_: "session.created.2".into(),
        data: parse_json(&format!(
            r#"{{"sessionID":"{name}","projectID":"prj_one","location":{{"directory":"/project"}},"title":"Dots · unattributed"{origin},"created":5}}"#
        ))
        .unwrap(),
    }
}

#[tokio::test]
async fn creation_projects_the_executor_origin_and_keeps_the_first_origin_on_retry() {
    let (store, service) = seeded();
    let background = service
        .create(created("ses_exec", Some("dots-executor")))
        .await
        .unwrap();
    let ordinary = service.create(created("ses_plain", None)).await.unwrap();
    assert_eq!(background.origin, Some(session::Origin::DotsExecutor));
    assert_eq!(ordinary.origin, None);
    assert_eq!(
        service.get(&id("ses_exec")).unwrap().unwrap().origin,
        Some(session::Origin::DotsExecutor)
    );
    let mut retry = created("ses_exec", None);
    retry.id = "evt_retry_exec".into();
    assert_eq!(
        service.create(retry).await.unwrap().origin,
        Some(session::Origin::DotsExecutor)
    );
    let mut retry = created("ses_plain", Some("dots-executor"));
    retry.id = "evt_retry_plain".into();
    assert_eq!(service.create(retry).await.unwrap().origin, None);
    let stored = store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_exec".into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(
        stored.origin.as_ref().and_then(|origin| origin.as_str()),
        Some("dots-executor")
    );
    let listed = ids(&service.list(&exclude()).unwrap());
    assert!(listed.contains(&"ses_plain".to_owned()));
    assert!(!listed.contains(&"ses_exec".to_owned()));
}
