mod support;

use std::ops::Bound;
use support::{
    wire::{ask, location_scope, open, query, refuse},
    *,
};
use ycoding_core::ycoding_store::{project, session};
use ycoding_protocol::v5;

fn project_row(id: &str, worktree: &str, name: &str, updated: i64) -> project::Project {
    project::Project {
        id: id.into(),
        worktree: worktree.into(),
        vcs: Some("git".into()),
        name: Some(name.into()),
        icon_url: None,
        icon_url_override: None,
        icon_color: None,
        time_created: 1,
        time_updated: updated,
        time_initialized: None,
        sandboxes: vec![],
        commands: None,
    }
}

fn seed_project(row: project::Project, directories: Vec<project::Directory>) {
    world()
        .store
        .submit(move |tx| {
            project::ProjectTable::insert(tx, &row)?;
            for directory in directories {
                project::DirectoryTable::insert(tx, &directory)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn directory(
    project_id: &str,
    directory: &str,
    strategy: Option<&str>,
    created: i64,
) -> project::Directory {
    project::Directory {
        project_id: project_id.into(),
        directory: directory.into(),
        type_: None,
        strategy: strategy.map(Into::into),
        time_created: created,
    }
}

fn session_row(id: &str, project_id: &str, directory: &str, updated: i64) -> session::Session {
    session::Session {
        id: id.into(),
        project_id: project_id.into(),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: directory.into(),
        path: None,
        title: "Inventory session".into(),
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
        time_updated: updated,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn health_stop_matches_the_declared_non_accepting_contract() {
    let (_server, mut client) = open().await;
    let result: v5::HealthStopResult = ask(
        &mut client,
        "health.stop",
        machine(),
        v5::HealthStopRequest {
            payload: v5::ServiceStopRequest {
                instance_id: text("test"),
            },
        },
    )
    .await;
    assert!(!result.data.accepted);
}

#[tokio::test(flavor = "multi_thread")]
async fn project_current_uses_the_scoped_location() {
    let (_server, mut client) = open().await;
    let result: v5::ProjectCurrentResult = ask(
        &mut client,
        "project.current",
        location_scope("/project"),
        v5::ProjectCurrentRequest {
            query: query("/project", None),
        },
    )
    .await;
    assert_eq!(units(&result.data.id), "prj_one");
    assert_eq!(units(&result.data.directory), "/project");

    let error: v5::InvalidRequestError = refuse(
        &mut client,
        "project.current",
        location_scope("/project"),
        v5::ProjectCurrentRequest {
            query: query("/different", None),
        },
    )
    .await;
    assert!(!units(&error.message).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn project_list_and_directories_return_project_records_in_contract_order() {
    seed_project(
        project_row("prj_wire_list", "/wire-list", "Wire List", 20),
        vec![
            directory("prj_wire_list", "/wire-list/new", Some("new"), 30),
            directory("prj_wire_list", "/wire-list/old", Some("old"), 10),
        ],
    );
    seed_project(
        project_row("prj_wire_list_old", "/wire-list-old", "Wire List Older", 10),
        vec![],
    );
    let (_server, mut client) = open().await;
    let listed: v5::ProjectListResult = ask(
        &mut client,
        "project.list",
        machine(),
        v5::ProjectListRequest {},
    )
    .await;
    let current = listed
        .items
        .iter()
        .find(|item| units(&item.id) == "prj_wire_list")
        .unwrap();
    assert!(
        listed
            .items
            .iter()
            .position(|item| units(&item.id) == "prj_wire_list")
            < listed
                .items
                .iter()
                .position(|item| units(&item.id) == "prj_wire_list_old")
    );
    assert_eq!(units(&current.worktree), "/wire-list");
    assert_eq!(units(current.name.as_ref().unwrap()), "Wire List");
    assert_eq!(current.vcs, Some(v5::ProjectVcs::Git as i32));

    let directories: v5::ProjectDirectoriesResult = ask(
        &mut client,
        "project.directories",
        location_scope("/project"),
        v5::ProjectDirectoriesRequest {
            params: v5::ProjectDirectoriesRequestParams {
                project_id: text("prj_wire_list"),
            },
            query: query("/project", None),
        },
    )
    .await;
    assert_eq!(
        directories
            .data
            .items
            .iter()
            .map(|item| units(&item.directory))
            .collect::<Vec<_>>(),
        ["/wire-list/new", "/wire-list/old"]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn project_inventory_searches_aggregates_and_pages_with_opaque_cursors() {
    seed_project(
        project_row(
            "prj_wire_inventory",
            "/wire-inventory",
            "Inventory Marker",
            20,
        ),
        vec![
            directory(
                "prj_wire_inventory",
                "/wire-inventory-marker/a",
                Some("strategy-a"),
                30,
            ),
            directory("prj_wire_inventory", "/wire-inventory-marker/b", None, 40),
        ],
    );
    let row = session_row(
        "ses_wire_inventory",
        "prj_wire_inventory",
        "/wire-inventory-marker/b",
        60,
    );
    world()
        .store
        .submit(move |tx| session::SessionTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();

    let (_server, mut client) = open().await;
    let first: v5::ProjectInventoryResult = ask(
        &mut client,
        "project.inventory",
        machine(),
        v5::ProjectInventoryRequest {
            query: v5::ProjectInventoryQuery {
                limit: Some(1),
                search: Some(text("WIRE-INVENTORY-MARKER")),
                cursor: None,
            },
        },
    )
    .await;
    let first_item = &first.data.data.items[0];
    assert_eq!(units(&first_item.directory), "/wire-inventory-marker/a");
    assert_eq!(units(first_item.strategy.as_ref().unwrap()), "strategy-a");
    assert!(!first_item.available);
    let cursor = first.data.cursor.next.as_ref().unwrap();

    let second: v5::ProjectInventoryResult = ask(
        &mut client,
        "project.inventory",
        machine(),
        v5::ProjectInventoryRequest {
            query: v5::ProjectInventoryQuery {
                limit: Some(1),
                search: Some(text("ignored-when-cursor-is-set")),
                cursor: Some(cursor.clone()),
            },
        },
    )
    .await;
    let second_item = &second.data.data.items[0];
    assert_eq!(units(&second_item.directory), "/wire-inventory-marker/b");
    assert_eq!(second_item.sessions, 1);
    assert_eq!(second_item.time_active, 60);

    let invalid_cursor: v5::InvalidCursorError = refuse(
        &mut client,
        "project.inventory",
        machine(),
        v5::ProjectInventoryRequest {
            query: v5::ProjectInventoryQuery {
                limit: None,
                search: None,
                cursor: Some(text("bad-cursor")),
            },
        },
    )
    .await;
    assert_eq!(units(&invalid_cursor.message), "Invalid cursor");
}

#[tokio::test(flavor = "multi_thread")]
async fn project_forget_removes_the_recorded_directory() {
    seed_project(
        project_row("prj_wire_forget", "/wire-forget", "Forget", 20),
        vec![directory("prj_wire_forget", "/wire-forget/child", None, 30)],
    );
    let row = session_row(
        "ses_wire_forget",
        "prj_wire_forget",
        "/wire-forget/child",
        40,
    );
    world()
        .store
        .submit(move |tx| session::SessionTable::insert(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
    let (_server, mut client) = open().await;
    let _: v5::ProjectForgetResult = ask(
        &mut client,
        "project.forget",
        machine(),
        v5::ProjectForgetRequest {
            params: v5::ProjectForgetRequestParams {
                project_id: text("prj_wire_forget"),
            },
            payload: v5::ProjectForgetRequestPayload {
                directory: text("/wire-forget/child"),
            },
        },
    )
    .await;
    let events = world()
        .store
        .snapshot()
        .unwrap()
        .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap();
    let deleted_events = events
        .iter()
        .filter(|event| {
            event.aggregate_id.as_str() == Some("ses_wire_forget")
                && event.type_.as_str() == Some("session.deleted.2")
        })
        .count();
    assert_eq!(deleted_events, 1);
    let directories: v5::ProjectDirectoriesResult = ask(
        &mut client,
        "project.directories",
        location_scope("/project"),
        v5::ProjectDirectoriesRequest {
            params: v5::ProjectDirectoriesRequestParams {
                project_id: text("prj_wire_forget"),
            },
            query: query("/project", None),
        },
    )
    .await;
    assert!(directories.data.items.is_empty());

    let _: v5::ProjectForgetResult = ask(
        &mut client,
        "project.forget",
        machine(),
        v5::ProjectForgetRequest {
            params: v5::ProjectForgetRequestParams {
                project_id: text("prj_wire_forget"),
            },
            payload: v5::ProjectForgetRequestPayload {
                directory: text("/wire-forget/child"),
            },
        },
    )
    .await;
    let events = world()
        .store
        .snapshot()
        .unwrap()
        .scan::<session::EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.aggregate_id.as_str() == Some("ses_wire_forget")
                    && event.type_.as_str() == Some("session.deleted.2")
            })
            .count(),
        deleted_events
    );
}
