use ycoding_core::session::{
    list::{Order, Parent, Query, Scope},
    store::Service,
};
use ycoding_schema::{LosslessString, schema::Finite, session};
use ycoding_store::{
    Store,
    project::{Project, ProjectTable},
    session::SessionTable,
};

#[path = "autonomy_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn text(value: &str) -> LosslessString {
    value.into()
}

fn fixture() -> Store {
    let store = support::store();
    store
        .submit(|tx| {
            ProjectTable::insert(
                tx,
                &Project {
                    id: "prj_two".into(),
                    worktree: "/other".into(),
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
            for (name, title, updated) in [
                ("ses_a", "Alpha Build", 5),
                ("ses_b", "beta_x", 3),
                ("ses_c", "Gamma", 5),
            ] {
                let mut row = support::record(name);
                row.title = title.into();
                row.time_updated = updated;
                match name {
                    "ses_b" => {
                        row.project_id = "prj_two".into();
                        row.directory = "/other".into();
                        row.workspace_id = Some("wrk_one".into());
                    }
                    "ses_c" => row.parent_id = Some("ses_a".into()),
                    _ => {}
                }
                SessionTable::insert(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

fn ids(sessions: &Service, query: &Query) -> Vec<String> {
    sessions
        .list(query)
        .unwrap()
        .iter()
        .map(|info| info.id.as_lossless().to_utf8().unwrap())
        .collect()
}

fn anchor(session: &str, time: f64, direction: &str) -> session::ListAnchor {
    session::ListAnchor {
        id: id(session),
        time: Finite::new(time).unwrap(),
        direction: text(direction),
    }
}

#[test]
fn lists_newest_updated_first_with_descending_id_as_the_tie_break() {
    let store = fixture();
    let sessions = Service::new(store.client());

    assert_eq!(
        ids(&sessions, &Query::default()),
        ["ses_c", "ses_a", "ses_b", "ses_two", "ses_one"]
    );
}

#[test]
fn lists_oldest_updated_first_when_ascending() {
    let store = fixture();
    let sessions = Service::new(store.client());

    assert_eq!(
        ids(
            &sessions,
            &Query {
                order: Order::Ascending,
                ..Query::default()
            }
        ),
        ["ses_one", "ses_two", "ses_b", "ses_a", "ses_c"]
    );
}

#[test]
fn filters_by_directory_project_workspace_and_parent() {
    let store = fixture();
    let sessions = Service::new(store.client());
    let only = |query: Query| ids(&sessions, &query);

    assert_eq!(
        only(Query {
            scope: Scope::Directory(text("/other")),
            ..Query::default()
        }),
        ["ses_b"]
    );
    assert_eq!(
        only(Query {
            scope: Scope::Project(text("prj_one")),
            ..Query::default()
        }),
        ["ses_c", "ses_a", "ses_two", "ses_one"]
    );
    assert_eq!(
        only(Query {
            workspace: Some(text("wrk_one")),
            ..Query::default()
        }),
        ["ses_b"]
    );
    assert_eq!(
        only(Query {
            parent: Some(Parent::Root),
            ..Query::default()
        }),
        ["ses_a", "ses_b", "ses_two", "ses_one"]
    );
    assert_eq!(
        only(Query {
            parent: Some(Parent::Child(id("ses_a"))),
            ..Query::default()
        }),
        ["ses_c"]
    );
    assert!(
        only(Query {
            scope: Scope::Directory(text("/missing")),
            ..Query::default()
        })
        .is_empty()
    );
}

#[test]
fn search_is_an_ascii_case_insensitive_like_over_the_title() {
    let store = fixture();
    let sessions = Service::new(store.client());
    let found = |search: &str| {
        ids(
            &sessions,
            &Query {
                search: Some(text(search)),
                ..Query::default()
            },
        )
    };

    assert_eq!(found("ALPHA"), ["ses_a"]);
    assert_eq!(found("l_h"), ["ses_a"]);
    assert_eq!(found("b%x"), ["ses_b"]);
    assert_eq!(found("beta_x"), ["ses_b"]);
    assert_eq!(found("zzz"), Vec::<String>::new());
    assert_eq!(found("").len(), 5);
}

#[test]
fn pages_forward_and_back_through_one_stable_order() {
    let store = fixture();
    let sessions = Service::new(store.client());
    let page = |anchor: Option<session::ListAnchor>, order: Order| {
        ids(
            &sessions,
            &Query {
                limit: Some(2),
                anchor,
                order,
                ..Query::default()
            },
        )
    };

    assert_eq!(page(None, Order::Descending), ["ses_c", "ses_a"]);
    assert_eq!(
        page(Some(anchor("ses_a", 5.0, "next")), Order::Descending),
        ["ses_b", "ses_two"]
    );
    assert_eq!(
        page(Some(anchor("ses_b", 3.0, "previous")), Order::Descending),
        ["ses_c", "ses_a"]
    );
    assert_eq!(
        page(Some(anchor("ses_two", 1.0, "previous")), Order::Descending),
        ["ses_a", "ses_b"]
    );
    assert_eq!(
        page(Some(anchor("ses_a", 5.0, "next")), Order::Ascending),
        ["ses_c"]
    );
}
