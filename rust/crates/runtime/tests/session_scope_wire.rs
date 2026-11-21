mod support;
mod telemetry_support;

use prost::{Message, Name};
use std::time::Duration;
use support::{wire::*, *};
use telemetry_support::{batch, consent, query};
use ycoding_core::{
    ycoding_schema::LosslessString,
    ycoding_store::{KeyPart, session::SessionTable, tuple_key},
};
use ycoding_protocol::v5;

const BOUND: i32 = 1;
const STANDALONE: i32 = 2;

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

#[derive(Default)]
struct Create<'a> {
    id: Option<&'a str>,
    parent: Option<&'a str>,
    directory: Option<&'a str>,
    title: Option<&'a str>,
    scope: Option<i32>,
}

fn create(input: Create) -> v5::SessionCreateRequest {
    v5::SessionCreateRequest {
        payload: v5::SessionCreateRequestPayload {
            id: input.id.map(text),
            parent_id: input.parent.map(text),
            title: input.title.map(text),
            location: input.directory.map(|directory| v5::LocationRef {
                directory: text(directory),
                workspace_id: None,
            }),
            scope: input.scope,
            ..Default::default()
        },
    }
}

async fn get(client: &mut Client, id: &str) -> v5::SessionInfo {
    let result: v5::SessionGetResult = ask(
        client,
        "session.get",
        session_scope(id),
        v5::SessionGetRequest {
            params: v5::SessionGetRequestParams {
                session_id: text(id),
            },
        },
    )
    .await;
    result.data
}

async fn listed(client: &mut Client, title: &str) -> Vec<v5::SessionInfo> {
    let result: v5::SessionListResult = ask(
        client,
        "session.list",
        machine(),
        v5::SessionListRequest {
            query: v5::SessionsQuery {
                search: Some(text(title)),
                ..Default::default()
            },
        },
    )
    .await;
    result.data.data.items
}

async fn fork(client: &mut Client, id: &str) -> v5::SessionInfo {
    let result: v5::SessionForkResult = ask(
        client,
        "session.fork",
        session_scope(id),
        v5::SessionForkRequest {
            params: v5::SessionForkRequestParams {
                session_id: text(id),
            },
            payload: v5::SessionForkRequestPayload { message_id: None },
        },
    )
    .await;
    result.data
}

async fn make_standalone(id: &str) {
    let id = LosslessString::from(id);
    world()
        .store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&id)]))?
                .unwrap();
            row.scope = "standalone".into();
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
}

async fn created_event_scope(client: &mut Client, id: &str) -> i32 {
    client.batches.clear();
    let request = v5::SessionLogRequest {
        params: v5::SessionLogRequestParams {
            session_id: text(id),
        },
        query: v5::SessionLogRequestQuery {
            after: None,
            follow: None,
        },
    }
    .encode_to_vec();
    let request_id = client.send("session.log", session_scope(id), request).await;
    client.subscribe_log(&request_id, session_scope(id)).await;
    client.run_for(Duration::from_secs(2)).await;
    let created = client
        .batches
        .iter()
        .flat_map(|batch| batch.events.iter())
        .map(|record| {
            assert_eq!(record.event.type_name, v5::SessionLogItem::full_name());
            v5::SessionLogItem::decode(record.event.payload.as_slice()).unwrap()
        })
        .find_map(|item| match item.kind {
            Some(v5::session_log_item::Kind::Value1(created)) => Some(created),
            _ => None,
        })
        .expect("session.created replayed");
    assert_eq!(units(&created.data.session_id), id);
    created.data.scope
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_sessions_report_their_scope_on_create_get_list_fork_and_the_created_event() {
    bounded(async {
        insert_session("ses_scope_seed", directory(), None).await;
        let (server, mut client) = open().await;
        let implicit: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(directory()),
            create(Create {
                directory: Some(directory()),
                title: Some("Scope probe implicit"),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(implicit.data.scope, BOUND);
        let explicit: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(directory()),
            create(Create {
                directory: Some(directory()),
                title: Some("Scope probe explicit"),
                scope: Some(BOUND),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(explicit.data.scope, BOUND);

        let id = units(&implicit.data.id);
        assert_eq!(get(&mut client, &id).await, implicit.data);
        let items = listed(&mut client, "Scope probe implicit").await;
        assert_eq!(items, vec![implicit.data.clone()]);
        assert_eq!(fork(&mut client, &id).await.scope, BOUND);
        assert_eq!(created_event_scope(&mut client, &id).await, BOUND);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn standalone_and_conflicting_child_placements_are_rejected_without_creating_a_session() {
    bounded(async {
        insert_session("ses_scope_parent", directory(), None).await;
        let (server, mut client) = open().await;
        for (id, input) in [
            (
                "ses_scope_reject_standalone",
                Create {
                    directory: Some(directory()),
                    scope: Some(STANDALONE),
                    ..Create::default()
                },
            ),
            (
                "ses_scope_reject_child_scope",
                Create {
                    parent: Some("ses_scope_parent"),
                    scope: Some(BOUND),
                    ..Create::default()
                },
            ),
            (
                "ses_scope_reject_child_location",
                Create {
                    parent: Some("ses_scope_parent"),
                    directory: Some(directory()),
                    ..Create::default()
                },
            ),
        ] {
            let error: v5::InvalidRequestError = refuse(
                &mut client,
                "session.create",
                location_scope(directory()),
                create(Create {
                    id: Some(id),
                    ..input
                }),
            )
            .await;
            assert_eq!(units(error.field.as_ref().unwrap()), "scope", "{id}");
            let missing: v5::SessionNotFoundError = refuse(
                &mut client,
                "session.get",
                session_scope(id),
                v5::SessionGetRequest {
                    params: v5::SessionGetRequestParams {
                        session_id: text(id),
                    },
                },
            )
            .await;
            assert_eq!(units(&missing.session_id), id);
        }
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reused_session_id_is_returned_for_the_same_placement_and_conflicts_otherwise() {
    bounded(async {
        insert_session("ses_scope_reuse_parent", directory(), None).await;
        let (server, mut client) = open().await;
        let id = "ses_scope_reused";
        let first: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(directory()),
            create(Create {
                id: Some(id),
                directory: Some(directory()),
                ..Create::default()
            }),
        )
        .await;
        let same: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(directory()),
            create(Create {
                id: Some(id),
                directory: Some(directory()),
                scope: Some(BOUND),
                title: Some("Ignored title"),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(same.data, first.data);
        let elsewhere = format!("{}/elsewhere", directory());
        let elsewhere = elsewhere.as_str();
        for (scope, input) in [
            (
                location_scope(elsewhere),
                Create {
                    id: Some(id),
                    directory: Some(elsewhere),
                    ..Create::default()
                },
            ),
            (
                location_scope(directory()),
                Create {
                    id: Some(id),
                    parent: Some("ses_scope_reuse_parent"),
                    ..Create::default()
                },
            ),
        ] {
            let conflict: v5::ConflictError =
                refuse(&mut client, "session.create", scope, create(input)).await;
            assert_eq!(
                units(&conflict.message),
                "Session ID belongs to a different placement"
            );
            assert_eq!(conflict.resource.as_ref().map(units).as_deref(), Some(id));
        }
        assert_eq!(get(&mut client, id).await, first.data);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn standalone_sessions_report_their_scope_and_refuse_children_and_forks() {
    bounded(async {
        insert_session("ses_scope_seed_alone", directory(), None).await;
        let (server, mut client) = open().await;
        let created: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(directory()),
            create(Create {
                directory: Some(directory()),
                title: Some("Scope probe standalone"),
                ..Create::default()
            }),
        )
        .await;
        let id = units(&created.data.id);
        make_standalone(&id).await;
        let info = get(&mut client, &id).await;
        assert_eq!(info.scope, STANDALONE);
        assert_eq!(
            listed(&mut client, "Scope probe standalone")
                .await
                .iter()
                .map(|item| item.scope)
                .collect::<Vec<_>>(),
            vec![STANDALONE]
        );
        let child: v5::InvalidRequestError = refuse(
            &mut client,
            "session.create",
            location_scope(directory()),
            create(Create {
                id: Some("ses_scope_alone_child"),
                parent: Some(&id),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(
            units(&child.message),
            "Standalone Session creation is unavailable"
        );
        let forked: v5::InvalidRequestError = refuse(
            &mut client,
            "session.fork",
            session_scope(&id),
            v5::SessionForkRequest {
                params: v5::SessionForkRequestParams {
                    session_id: text(&id),
                },
                payload: v5::SessionForkRequestPayload { message_id: None },
            },
        )
        .await;
        assert_eq!(
            units(&forked.message),
            "Standalone Session operation is unavailable"
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_fork_request_samples_are_recorded_with_their_operation() {
    bounded(async {
        let (server, mut client) = open().await;
        let _: v5::TelemetryConsentSetResult = success(
            client
                .call("telemetry.consent.set", machine(), consent(true, 1.0))
                .await,
        );
        let sample = v5::TelemetrySample {
            kind: Some(v5::telemetry_sample::Kind::Value1(
                v5::TelemetryRequestSample {
                    kind: 1,
                    at: text("2026-11-14T12:00:00.000Z"),
                    operation: 112,
                    outcome: 1,
                    reason: None,
                    queue_ms: 3,
                    settlement_ms: Some(7),
                    total_ms: 10,
                },
            )),
        };
        let _: v5::TelemetryAppendResult = success(
            client
                .call("telemetry.append", machine(), batch(vec![sample.clone()]))
                .await,
        );
        let listed: v5::TelemetryListResult = success(
            client
                .call("telemetry.list", machine(), query(Some(200), None))
                .await,
        );
        let expected = sample;
        assert!(
            listed
                .data
                .data
                .items
                .iter()
                .any(|item| item.sample == expected)
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

const UNAVAILABLE: &str = "Session scope is unavailable";

fn scratch(name: &str) -> std::path::PathBuf {
    let path = std::path::Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("session-scope-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::canonicalize(path).unwrap()
}

fn path_text(path: &std::path::Path) -> &str {
    path.to_str().unwrap()
}

fn directory() -> &'static str {
    static DIRECTORY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DIRECTORY.get_or_init(|| path_text(&scratch("bound")).to_owned())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_placement_in_the_standalone_root_is_unavailable_and_unresolvable_paths_fail_closed()
{
    bounded(async {
        let state = world().core.state.clone();
        let reserved = state.join("standalone-sessions");
        let target = std::fs::canonicalize(&state)
            .unwrap()
            .join("standalone-sessions")
            .join("gate-target");
        std::fs::create_dir_all(&target).unwrap();
        let scratch = scratch("gate");
        let linked = scratch.join("linked");
        std::os::unix::fs::symlink(&target, &linked).unwrap();
        let dangling = scratch.join("dangling");
        std::os::unix::fs::symlink(scratch.join("missing"), &dangling).unwrap();
        let lexical = reserved.join("project");
        insert_session("ses_scope_gate_parent", path_text(&lexical), None).await;
        let (server, mut client) = open().await;
        for (id, directory, parent) in [
            ("ses_scope_gate_lexical", lexical.clone(), None),
            ("ses_scope_gate_symlink", linked.clone(), None),
            ("ses_scope_gate_dangling", dangling.join("child"), None),
            (
                "ses_scope_gate_child",
                scratch.clone(),
                Some("ses_scope_gate_parent"),
            ),
        ] {
            let error: v5::InvalidRequestError = refuse(
                &mut client,
                "session.create",
                location_scope(path_text(&directory)),
                create(Create {
                    id: Some(id),
                    parent,
                    directory: parent.is_none().then_some(path_text(&directory)),
                    ..Create::default()
                }),
            )
            .await;
            assert_eq!(units(&error.message), UNAVAILABLE, "{id}");
            assert_eq!(error.field, None, "{id}");
            let missing: v5::SessionNotFoundError = refuse(
                &mut client,
                "session.get",
                session_scope(id),
                v5::SessionGetRequest {
                    params: v5::SessionGetRequestParams {
                        session_id: text(id),
                    },
                },
            )
            .await;
            assert_eq!(units(&missing.session_id), id);
        }
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reused_session_id_matches_its_placement_by_physical_directory() {
    bounded(async {
        let real = scratch("reuse-real");
        let link = scratch("reuse-link").join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let (server, mut client) = open().await;
        let id = "ses_scope_reused_physical";
        let first: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(path_text(&real)),
            create(Create {
                id: Some(id),
                directory: Some(path_text(&real)),
                ..Create::default()
            }),
        )
        .await;
        let through_link: v5::SessionCreateResult = ask(
            &mut client,
            "session.create",
            location_scope(path_text(&link)),
            create(Create {
                id: Some(id),
                directory: Some(path_text(&link)),
                ..Create::default()
            }),
        )
        .await;
        assert_eq!(through_link.data, first.data);
        server.shutdown().await.unwrap();
    })
    .await;
}
