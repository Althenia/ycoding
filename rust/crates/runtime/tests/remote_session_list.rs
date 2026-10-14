mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use prost::{Message, Name};
use remote_derived_support::{Fixture, activate, create, now, stop, world};
use std::sync::Arc;
use support::{machine, operation, text, units};
use ycoding_core::{
    ycoding_schema::{LosslessString, parse_json},
    ycoding_store::{
        KeyPart,
        session::{Document, SessionTable},
        tuple_key,
    },
};
use ycoding_protocol::{decode_strict, v5};
use ycoding_runtime::{
    Environment, Settled,
    connector::{Credential, Enrolled, Peer},
    standard,
};

async fn request(environment: Arc<Environment>, name: &str, payload: Vec<u8>) -> v5::TypedPayload {
    let peer = Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "list-test".into(),
            now() + 60_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap();
    let Some(Settled::Result(result)) = standard()
        .unwrap()
        .invoke_remote(
            environment,
            "list-connection".into(),
            &peer,
            v5::Request {
                request_id: "list-request".into(),
                operation_id: operation(name).operation_id,
                scope: machine(),
                payload,
            },
        )
        .await
    else {
        panic!("missing typed settlement")
    };
    match result.outcome.unwrap() {
        v5::result::Outcome::Success(payload) | v5::result::Outcome::Error(payload) => payload,
        _ => panic!("unexpected list asset"),
    }
}

async fn list(environment: Arc<Environment>, query: v5::SessionsQuery) -> v5::SessionListResult {
    let payload = request(
        environment,
        "session.list",
        v5::SessionListRequest { query }.encode_to_vec(),
    )
    .await;
    assert_eq!(
        payload.type_name,
        v5::SessionListResult::full_name(),
        "{}",
        String::from_utf8_lossy(&payload.payload)
    );
    decode_strict(&payload.payload).unwrap()
}

async fn workspace(fixture: &Fixture) -> v5::LosslessString {
    let payload = request(
        fixture.environment(true),
        "workspace.list",
        v5::WorkspaceListRequest {
            payload: v5::WorkspaceListRequestPayload {
                sessions_only: None,
            },
        }
        .encode_to_vec(),
    )
    .await;
    let page = decode_strict::<v5::WorkspaceListResult>(&payload.payload).unwrap();
    page.data
        .items
        .into_iter()
        .find(|item| units(&item.directory) == fixture.directory)
        .unwrap()
        .id
}

fn query(workspace: v5::LosslessString) -> v5::SessionsQuery {
    v5::SessionsQuery {
        workspace: Some(workspace),
        limit: Some(2),
        order: Some(v5::SessionsQueryOrder::SessionsqueryOrderActive as i32),
        parent_id: Some(v5::SessionsQueryParentId {
            kind: Some(v5::sessions_query_parent_id::Kind::Clear(v5::Empty {})),
        }),
        search_fields: Some(v5::SessionsQuerySearchFields::SessionsquerySearchfieldsSummary as i32),
        ..Default::default()
    }
}

fn ids(page: &v5::SessionListResult) -> Vec<String> {
    page.data
        .data
        .items
        .iter()
        .map(|session| units(&session.id))
        .collect()
}

async fn update(
    id: &str,
    updated: i64,
    active: Option<i64>,
    agent: &str,
    model: bool,
    archived: bool,
) {
    let id = LosslessString::from(id);
    let agent = LosslessString::from(agent);
    world().store.submit(move |tx| {
        let mut row = tx.get::<SessionTable>(&tuple_key(&[KeyPart::String(&id)]))?.unwrap();
        row.time_updated = updated;
        row.time_active = active;
        row.time_archived = archived.then_some(1);
        row.agent = Some(agent);
        row.model = model.then(|| Document::new(parse_json(r##"{"providerID":"NeedleProvider","id":"NeedleModel","variant":"NeedleVariant","profile":"NeedleProfile"}"##).unwrap())).transpose()?;
        SessionTable::put(tx, &row)
    }).unwrap().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_active_list_resolves_workspace_roots_limit_and_bidirectional_cursors() {
    let fixture = Fixture::new().await;
    let third = format!("{}_third", fixture.root);
    let same_directory_child = format!("{}_same_child", fixture.root);
    create(&third, &fixture.project, &fixture.directory, None, "build").await;
    create(
        &same_directory_child,
        &fixture.project,
        &fixture.directory,
        Some(&fixture.root),
        "build",
    )
    .await;
    update(&fixture.root, 900, Some(100), "build", false, false).await;
    update(&fixture.other, 200, Some(200), "build", false, false).await;
    update(&third, 300, None, "build", false, false).await;
    activate(&fixture.child).await;
    let query = query(workspace(&fixture).await);
    let first = list(fixture.environment(true), query.clone()).await;
    assert_eq!(ids(&first), [fixture.root.clone(), third.clone()]);
    assert!(first.data.cursor.previous.is_none());
    let second = list(
        fixture.environment(true),
        v5::SessionsQuery {
            cursor: first.data.cursor.next.clone(),
            ..query.clone()
        },
    )
    .await;
    assert_eq!(ids(&second), std::slice::from_ref(&fixture.other));
    assert!(second.data.cursor.next.is_none());
    let previous = list(
        fixture.environment(true),
        v5::SessionsQuery {
            cursor: second.data.cursor.previous,
            ..query.clone()
        },
    )
    .await;
    assert_eq!(ids(&previous), ids(&first));
    let roots = list(
        fixture.environment(true),
        v5::SessionsQuery {
            limit: Some(200),
            ..query.clone()
        },
    )
    .await;
    assert_eq!(
        ids(&roots),
        [fixture.root.clone(), third, fixture.other.clone()]
    );
    let running = list(
        fixture.environment(true),
        v5::SessionsQuery {
            status: Some(v5::SessionsQueryStatus::SessionsqueryStatusRunning as i32),
            ..query.clone()
        },
    )
    .await;
    assert_eq!(ids(&running), std::slice::from_ref(&fixture.root));
    let idle = list(
        fixture.environment(true),
        v5::SessionsQuery {
            status: Some(v5::SessionsQueryStatus::SessionsqueryStatusIdle as i32),
            ..query
        },
    )
    .await;
    assert_eq!(
        ids(&idle),
        [format!("{}_third", fixture.root), fixture.other.clone()]
    );
    stop(&fixture.child).await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_pinned_list_orders_pinned_first_then_newest() {
    let fixture = Fixture::new().await;
    update(&fixture.root, 100, None, "build", false, false).await;
    update(&fixture.other, 900, None, "build", false, false).await;
    let id = LosslessString::from(fixture.root.as_str());
    world()
        .store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&id)]))?
                .unwrap();
            row.time_pinned = Some(50);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
    let workspace = workspace(&fixture).await;
    let page = list(
        fixture.environment(true),
        v5::SessionsQuery {
            workspace: Some(workspace),
            limit: Some(50),
            order: Some(v5::SessionsQueryOrder::SessionsqueryOrderPinned as i32),
            parent_id: Some(v5::SessionsQueryParentId {
                kind: Some(v5::sessions_query_parent_id::Kind::Clear(v5::Empty {})),
            }),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(ids(&page), [fixture.root.clone(), fixture.other.clone()]);
    fixture.close().await;
}

#[tokio::test]
async fn identical_local_and_remote_queries_keep_their_distinct_cursor_boundaries() {
    let fixture = Fixture::new().await;
    let query = v5::SessionsQuery {
        search: Some(text(&fixture.root)),
        limit: Some(50),
        ..Default::default()
    };
    let remote = list(fixture.environment(true), query.clone()).await;
    assert_eq!(ids(&remote), std::slice::from_ref(&fixture.root));
    assert!(remote.data.cursor.previous.is_none());
    assert!(remote.data.cursor.next.is_none());
    let Some(Settled::Result(local)) = standard()
        .unwrap()
        .invoke(
            fixture.environment(true),
            "local-list-connection".into(),
            v5::Request {
                request_id: "local-list-request".into(),
                operation_id: operation("session.list").operation_id,
                scope: machine(),
                payload: v5::SessionListRequest { query }.encode_to_vec(),
            },
        )
        .await
    else {
        panic!("missing local result")
    };
    let Some(v5::result::Outcome::Success(payload)) = local.outcome else {
        panic!("local list failed")
    };
    let local = decode_strict::<v5::SessionListResult>(&payload.payload).unwrap();
    assert_eq!(ids(&local), ids(&remote));
    assert!(local.data.cursor.previous.is_some());
    assert!(local.data.cursor.next.is_some());
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_summary_search_matches_agent_and_model_fields_without_changing_title_search() {
    let fixture = Fixture::new().await;
    update(&fixture.root, 100, None, "NeedleAgent", false, false).await;
    update(&fixture.other, 200, None, "build", true, true).await;
    let query = query(workspace(&fixture).await);
    for (search, expected) in [
        ("needleagent", &fixture.root),
        ("needleprovider/needlemodel", &fixture.other),
        ("#needlevariant", &fixture.other),
        ("profile needleprofile", &fixture.other),
    ] {
        let page = list(
            fixture.environment(true),
            v5::SessionsQuery {
                search: Some(text(search)),
                ..query.clone()
            },
        )
        .await;
        assert_eq!(ids(&page), std::slice::from_ref(expected), "{search}");
    }
    let title_only = list(
        fixture.environment(true),
        v5::SessionsQuery {
            search: Some(text("NeedleAgent")),
            search_fields: None,
            ..query.clone()
        },
    )
    .await;
    assert!(ids(&title_only).is_empty());
    let idle = list(
        fixture.environment(true),
        v5::SessionsQuery {
            status: Some(v5::SessionsQueryStatus::SessionsqueryStatusIdle as i32),
            ..query.clone()
        },
    )
    .await;
    assert_eq!(ids(&idle), std::slice::from_ref(&fixture.root));
    for limit in [0, 201] {
        let payload = request(
            fixture.environment(true),
            "session.list",
            v5::SessionListRequest {
                query: v5::SessionsQuery {
                    limit: Some(limit),
                    ..query.clone()
                },
            }
            .encode_to_vec(),
        )
        .await;
        assert_ne!(payload.type_name, v5::SessionListResult::full_name());
    }
    let missing_workspace = list(
        fixture.environment(true),
        v5::SessionsQuery {
            workspace: Some(text("wsp_missing")),
            ..query.clone()
        },
    )
    .await;
    assert!(ids(&missing_workspace).is_empty());
    let invalid = request(
        fixture.environment(true),
        "session.list",
        v5::SessionListRequest {
            query: v5::SessionsQuery {
                cursor: Some(text("invalid cursor")),
                ..query
            },
        }
        .encode_to_vec(),
    )
    .await;
    assert_ne!(invalid.type_name, v5::SessionListResult::full_name());
    fixture.close().await;
}
