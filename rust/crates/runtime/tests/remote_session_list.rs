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
    session::review::{
        ChildAnswer, Delivery, DeliveryFuture, OpenInput, RecoveryResolution, Service as Reviews,
        WithdrawReason,
    },
    ycoding_schema::{
        DomainDecode, LosslessString, parse_json, permission, session,
        session_review::{Kind, Origin, Payload, Reason},
    },
    ycoding_store::{
        KeyPart,
        resources::{Shell, ShellTable},
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

struct Silent;

impl Delivery for Silent {
    fn wake(&self, _: &session::Id) {}
    fn answer_child<'a>(&'a self, _: ChildAnswer) -> DeliveryFuture<'a> {
        Box::pin(async { Ok(()) })
    }
    fn resolve_recovery<'a>(&'a self, _: RecoveryResolution) -> DeliveryFuture<'a> {
        Box::pin(async { Ok(()) })
    }
}

fn reviews() -> Reviews {
    Reviews::new(world().core.sessions.clone(), Arc::new(Silent))
}

fn session_id(id: &str) -> session::Id {
    session::Id::new(id).unwrap()
}

async fn defer(id: &str) {
    reviews()
        .open(OpenInput {
            session_id: session_id(id),
            kind: Kind::decode(&ycoding_core::ycoding_schema::JsonValue::String("question".into()))
                .unwrap(),
            reason: Reason::decode(&ycoding_core::ycoding_schema::JsonValue::String(
                "free_text".into(),
            ))
            .unwrap(),
            choice: None,
            confidence: None,
            grades: None,
            origin: Origin::Request {
                request_id: "frm_list".into(),
            },
            payload: Payload::decode(
                &parse_json(
                    r#"{"type":"form","title":"Plan","fields":[{"key":"plan","type":"string","required":true}]}"#,
                )
                .unwrap(),
            )
            .unwrap(),
            limit: 16,
            conversion: false,
            created: now(),
        })
        .await
        .unwrap();
}

async fn withdraw(id: &str) {
    reviews()
        .withdraw(&session_id(id), WithdrawReason::TaskClosed, now())
        .await
        .unwrap();
}

fn shell_key(id: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&format!("shl_list_{id}").as_str().into())])
}

async fn lose(id: &str) {
    let row = Shell {
        id: format!("shl_list_{id}").as_str().into(),
        session_id: Some(id.into()),
        pid: 1,
        process_started: None,
        owner_pid: 1,
        owner_started: "Mon Jan  1 00:00:00 2024".into(),
        notice_pending: 1,
        time_created: 1,
        time_lost: Some(2),
        start_seq: -1,
    };
    world()
        .store
        .submit(move |tx| ShellTable::insert(tx, &row))
        .unwrap()
        .await
        .unwrap();
}

async fn found(id: &str) {
    let key = shell_key(id);
    world()
        .store
        .submit(move |tx| tx.delete::<ShellTable>(&key))
        .unwrap()
        .await
        .unwrap();
}

struct Mixed {
    newer_waiting: String,
    running: String,
    idle: String,
    archived: String,
}

/// Active order is `[newer_waiting, root, running, other, idle, archived]`: `root` is waiting through an open review
/// on its child and running through that child, `newer_waiting` is waiting and loss-affected, `other` is loss-only.
async fn mixed(fixture: &Fixture) -> Mixed {
    let extra = |suffix: &str| format!("{}_{suffix}", fixture.root);
    let (newer_waiting, idle, running, archived) = (extra("t"), extra("u"), extra("w"), extra("x"));
    for id in [&newer_waiting, &idle, &running, &archived] {
        create(id, &fixture.project, &fixture.directory, None, "build").await;
    }
    for (id, active, archive) in [
        (&newer_waiting, 600, false),
        (&fixture.root, 500, false),
        (&fixture.other, 400, false),
        (&idle, 300, false),
        (&running, 100, false),
        (&archived, 50, true),
    ] {
        update(id, active, Some(active), "build", false, archive).await;
    }
    defer(&fixture.child).await;
    defer(&newer_waiting).await;
    lose(&newer_waiting).await;
    lose(&fixture.other).await;
    activate(&fixture.child).await;
    activate(&running).await;
    Mixed {
        newer_waiting,
        running,
        idle,
        archived,
    }
}

async fn settle(fixture: &Fixture, mixed: &Mixed) {
    stop(&fixture.child).await;
    stop(&mixed.running).await;
    found(&mixed.newer_waiting).await;
    found(&fixture.other).await;
    withdraw(&fixture.child).await;
    withdraw(&mixed.newer_waiting).await;
}

fn roots(workspace: v5::LosslessString) -> v5::SessionsQuery {
    v5::SessionsQuery {
        limit: Some(200),
        ..query(workspace)
    }
}

async fn with_status(
    fixture: &Fixture,
    query: &v5::SessionsQuery,
    status: v5::SessionsQueryStatus,
) -> v5::SessionListResult {
    list(
        fixture.environment(true),
        v5::SessionsQuery {
            status: Some(status as i32),
            ..query.clone()
        },
    )
    .await
}

async fn waiting(fixture: &Fixture, query: &v5::SessionsQuery) -> Vec<String> {
    ids(&with_status(
        fixture,
        query,
        v5::SessionsQueryStatus::SessionsqueryStatusWaiting,
    )
    .await)
}

fn strings(items: &[&String]) -> Vec<String> {
    items.iter().map(|item| (*item).clone()).collect()
}

fn lost(page: &v5::SessionListResult) -> Vec<String> {
    page.data
        .status
        .as_ref()
        .and_then(|status| status.lost.as_ref())
        .map(|lost| lost.items.clone())
        .unwrap_or_default()
}

fn assert_stale(page: &v5::SessionListResult) {
    assert!(page.data.data.items.is_empty());
    assert!(page.data.cursor.previous.is_none() && page.data.cursor.next.is_none());
    assert!(page.data.status.is_none());
    assert_eq!(page.data.stale, Some(true));
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::new();
    let mut accumulator = 0u32;
    let mut bits = 0;
    for byte in bytes {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            output.push(ALPHABET[((accumulator >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        output.push(ALPHABET[((accumulator << (6 - bits)) & 63) as usize] as char);
    }
    output
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_pages_classify_roots_by_request_attention_running_and_loss() {
    let fixture = Fixture::new().await;
    let mixed = mixed(&fixture).await;
    let query = roots(workspace(&fixture).await);
    let page = list(fixture.environment(true), query.clone()).await;
    assert_eq!(
        ids(&page),
        strings(&[
            &mixed.newer_waiting,
            &fixture.root,
            &mixed.running,
            &fixture.other,
            &mixed.idle,
            &mixed.archived
        ])
    );
    let status = page.data.status.clone().unwrap();
    assert_eq!(status.running, strings(&[&fixture.root, &mixed.running]));
    assert_eq!(
        status.attention,
        strings(&[&mixed.newer_waiting, &fixture.root, &fixture.other])
    );
    assert_eq!(lost(&page), strings(&[&fixture.other]));
    assert!(status.failed.is_none() && status.outstanding.is_none() && status.details.is_none());

    let waiting = with_status(
        &fixture,
        &query,
        v5::SessionsQueryStatus::SessionsqueryStatusWaiting,
    )
    .await;
    let running = with_status(
        &fixture,
        &query,
        v5::SessionsQueryStatus::SessionsqueryStatusRunning,
    )
    .await;
    let idle = with_status(
        &fixture,
        &query,
        v5::SessionsQueryStatus::SessionsqueryStatusIdle,
    )
    .await;
    assert_eq!(
        ids(&waiting),
        strings(&[&mixed.newer_waiting, &fixture.root])
    );
    assert_eq!(ids(&running), strings(&[&mixed.running]));
    assert_eq!(ids(&idle), strings(&[&fixture.other, &mixed.idle]));
    assert_eq!(
        waiting.data.status.clone().unwrap().attention,
        strings(&[&mixed.newer_waiting, &fixture.root])
    );
    assert_eq!(
        running.data.status.clone().unwrap().running,
        strings(&[&mixed.running])
    );
    assert_eq!(lost(&idle), strings(&[&fixture.other]));
    let mut partition = [ids(&waiting), ids(&running), ids(&idle)].concat();
    partition.sort();
    let mut live = ids(&page);
    live.retain(|id| *id != mixed.archived);
    live.sort();
    assert_eq!(partition, live);

    let children = |status: v5::SessionsQueryStatus| v5::SessionsQuery {
        parent_id: Some(v5::SessionsQueryParentId {
            kind: Some(v5::sessions_query_parent_id::Kind::Value1(text(
                &fixture.root,
            ))),
        }),
        limit: Some(200),
        order: Some(v5::SessionsQueryOrder::SessionsqueryOrderActive as i32),
        status: Some(status as i32),
        ..Default::default()
    };
    let waiting_children = list(
        fixture.environment(true),
        children(v5::SessionsQueryStatus::SessionsqueryStatusWaiting),
    )
    .await;
    assert!(ids(&waiting_children).is_empty());
    let running_children = list(
        fixture.environment(true),
        children(v5::SessionsQueryStatus::SessionsqueryStatusRunning),
    )
    .await;
    assert_eq!(ids(&running_children), strings(&[&fixture.child]));
    let status = running_children.data.status.unwrap();
    assert_eq!(status.running, strings(&[&fixture.child]));
    assert!(status.attention.is_empty());
    settle(&fixture, &mixed).await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_status_is_computed_only_for_active_order_or_a_status_filter() {
    let fixture = Fixture::new().await;
    let workspace = workspace(&fixture).await;
    let plain = v5::SessionsQuery {
        workspace: Some(workspace),
        limit: Some(50),
        order: Some(v5::SessionsQueryOrder::SessionsqueryOrderDesc as i32),
        parent_id: Some(v5::SessionsQueryParentId {
            kind: Some(v5::sessions_query_parent_id::Kind::Clear(v5::Empty {})),
        }),
        ..Default::default()
    };
    assert!(
        list(fixture.environment(true), plain.clone())
            .await
            .data
            .status
            .is_none()
    );
    for status in [
        v5::SessionsQueryStatus::SessionsqueryStatusWaiting,
        v5::SessionsQueryStatus::SessionsqueryStatusRunning,
        v5::SessionsQueryStatus::SessionsqueryStatusIdle,
    ] {
        let page = with_status(&fixture, &plain, status).await;
        assert!(page.data.status.is_some());
        assert_ne!(page.data.stale, Some(true));
    }
    let active = list(
        fixture.environment(true),
        v5::SessionsQuery {
            order: Some(v5::SessionsQueryOrder::SessionsqueryOrderActive as i32),
            ..plain
        },
    )
    .await;
    assert!(active.data.status.is_some());
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cursor_walks_cross_waiting_running_and_idle_without_skips_and_status_names_only_page_roots()
 {
    let fixture = Fixture::new().await;
    let mixed = mixed(&fixture).await;
    let query = v5::SessionsQuery {
        limit: Some(1),
        ..roots(workspace(&fixture).await)
    };
    let expected = strings(&[
        &mixed.newer_waiting,
        &fixture.root,
        &mixed.running,
        &fixture.other,
        &mixed.idle,
        &mixed.archived,
    ]);
    let mut page = list(fixture.environment(true), query.clone()).await;
    let mut seen = Vec::new();
    let mut statuses = Vec::new();
    loop {
        seen.extend(ids(&page));
        let status = page.data.status.clone().unwrap();
        statuses.push((
            status.running.clone(),
            status.attention.clone(),
            lost(&page),
        ));
        let Some(next) = page.data.cursor.next.clone() else {
            break;
        };
        page = list(
            fixture.environment(true),
            v5::SessionsQuery {
                cursor: Some(next),
                ..query.clone()
            },
        )
        .await;
    }
    assert_eq!(seen, expected);
    assert_eq!(
        statuses,
        [
            (vec![], strings(&[&mixed.newer_waiting]), vec![]),
            (strings(&[&fixture.root]), strings(&[&fixture.root]), vec![]),
            (strings(&[&mixed.running]), vec![], vec![]),
            (
                vec![],
                strings(&[&fixture.other]),
                strings(&[&fixture.other])
            ),
            (vec![], vec![], vec![]),
            (vec![], vec![], vec![]),
        ]
    );
    let mut backwards = Vec::new();
    loop {
        backwards.extend(ids(&page));
        let Some(previous) = page.data.cursor.previous.clone() else {
            break;
        };
        page = list(
            fixture.environment(true),
            v5::SessionsQuery {
                cursor: Some(previous),
                ..query.clone()
            },
        )
        .await;
    }
    backwards.reverse();
    assert_eq!(backwards, expected);
    settle(&fixture, &mixed).await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_cursors_go_stale_when_classification_or_filters_change() {
    let fixture = Fixture::new().await;
    let mixed = mixed(&fixture).await;
    let query = v5::SessionsQuery {
        limit: Some(2),
        ..roots(workspace(&fixture).await)
    };
    let first = list(fixture.environment(true), query.clone()).await;
    let cursor = first.data.cursor.next.clone().unwrap();
    let unchanged = list(
        fixture.environment(true),
        v5::SessionsQuery {
            cursor: Some(cursor.clone()),
            ..query.clone()
        },
    )
    .await;
    assert_eq!(ids(&unchanged), strings(&[&mixed.running, &fixture.other]));
    assert_ne!(unchanged.data.stale, Some(true));

    let filtered = list(
        fixture.environment(true),
        v5::SessionsQuery {
            status: Some(v5::SessionsQueryStatus::SessionsqueryStatusIdle as i32),
            cursor: Some(cursor.clone()),
            ..query.clone()
        },
    )
    .await;
    assert_stale(&filtered);

    defer(&mixed.idle).await;
    let reclassified = list(
        fixture.environment(true),
        v5::SessionsQuery {
            cursor: Some(cursor.clone()),
            ..query.clone()
        },
    )
    .await;
    assert_stale(&reclassified);
    let fresh = list(fixture.environment(true), query.clone()).await;
    assert_ne!(fresh.data.cursor.next, Some(cursor));
    assert_eq!(ids(&fresh), strings(&[&mixed.newer_waiting, &fixture.root]));
    withdraw(&mixed.idle).await;
    settle(&fixture, &mixed).await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn around_refreshes_a_window_of_the_active_list_and_keeps_bidirectional_cursors() {
    let fixture = Fixture::new().await;
    let mixed = mixed(&fixture).await;
    let query = roots(workspace(&fixture).await);
    let window = |around: &str, before: Option<u64>, limit: u64| v5::SessionsQuery {
        around: Some(text(around)),
        before,
        limit: Some(limit),
        ..query.clone()
    };
    let around_running = list(
        fixture.environment(true),
        window(&mixed.running, Some(1), 2),
    )
    .await;
    assert_eq!(
        ids(&around_running),
        strings(&[&fixture.root, &mixed.running])
    );
    assert!(around_running.data.cursor.previous.is_some());
    assert!(around_running.data.cursor.next.is_some());
    assert!(around_running.data.status.is_some());
    let after = list(
        fixture.environment(true),
        v5::SessionsQuery {
            cursor: around_running.data.cursor.next.clone(),
            limit: Some(2),
            ..query.clone()
        },
    )
    .await;
    assert_eq!(ids(&after), strings(&[&fixture.other, &mixed.idle]));
    let before = list(
        fixture.environment(true),
        v5::SessionsQuery {
            cursor: around_running.data.cursor.previous.clone(),
            limit: Some(2),
            ..query.clone()
        },
    )
    .await;
    assert_eq!(ids(&before), strings(&[&mixed.newer_waiting]));

    for (around, before, limit, expected, previous, next) in [
        (
            &mixed.running,
            Some(0),
            2,
            strings(&[&mixed.running, &fixture.other]),
            true,
            true,
        ),
        (
            &mixed.running,
            None,
            2,
            strings(&[&mixed.running, &fixture.other]),
            true,
            true,
        ),
        (
            &mixed.newer_waiting,
            Some(0),
            2,
            strings(&[&mixed.newer_waiting, &fixture.root]),
            false,
            true,
        ),
        (
            &mixed.archived,
            Some(1),
            3,
            strings(&[&mixed.idle, &mixed.archived]),
            true,
            false,
        ),
        (
            &"ses_not_in_the_list".to_owned(),
            Some(1),
            2,
            strings(&[&mixed.newer_waiting, &fixture.root]),
            false,
            true,
        ),
    ] {
        let page = list(fixture.environment(true), window(around, before, limit)).await;
        assert_eq!(ids(&page), expected, "{around} {before:?} {limit}");
        assert_eq!(page.data.cursor.previous.is_some(), previous, "{around}");
        assert_eq!(page.data.cursor.next.is_some(), next, "{around}");
    }
    settle(&fixture, &mixed).await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_status_window_and_active_cursor_combinations_are_rejected() {
    let fixture = Fixture::new().await;
    let query = roots(workspace(&fixture).await);
    let page = list(
        fixture.environment(true),
        v5::SessionsQuery {
            limit: Some(1),
            ..query.clone()
        },
    )
    .await;
    let cursor = page.data.cursor.next.clone().unwrap();
    let valid = v5::SessionsQuery {
        around: Some(text(&fixture.root)),
        ..query.clone()
    };
    let legacy = |fields: &str| {
        text(&base64url(
            format!(
                r#"{{"id":"{}","time":1,"direction":"next"{fields}}}"#,
                fixture.root
            )
            .as_bytes(),
        ))
    };
    for (label, invalid) in [
        (
            "around outside active order",
            v5::SessionsQuery {
                order: Some(v5::SessionsQueryOrder::SessionsqueryOrderDesc as i32),
                ..valid.clone()
            },
        ),
        (
            "around with a cursor",
            v5::SessionsQuery {
                cursor: Some(cursor.clone()),
                ..valid.clone()
            },
        ),
        (
            "before without around",
            v5::SessionsQuery {
                before: Some(0),
                ..query.clone()
            },
        ),
        (
            "before equal to the limit",
            v5::SessionsQuery {
                before: Some(2),
                limit: Some(2),
                ..valid.clone()
            },
        ),
        (
            "before beyond the default limit",
            v5::SessionsQuery {
                before: Some(50),
                limit: None,
                ..valid.clone()
            },
        ),
        (
            "malformed around",
            v5::SessionsQuery {
                around: Some(text("not-a-session")),
                ..valid.clone()
            },
        ),
        (
            "unknown status",
            v5::SessionsQuery {
                status: Some(4),
                ..query.clone()
            },
        ),
        (
            "cursor without waiting or epoch",
            v5::SessionsQuery {
                cursor: Some(legacy(r#","running":false"#)),
                ..query.clone()
            },
        ),
        (
            "cursor without epoch",
            v5::SessionsQuery {
                cursor: Some(legacy(r#","running":false,"waiting":false"#)),
                ..query.clone()
            },
        ),
        (
            "cursor with a malformed epoch",
            v5::SessionsQuery {
                cursor: Some(legacy(r#","running":false,"waiting":false,"epoch":"abc""#)),
                ..query.clone()
            },
        ),
    ] {
        let payload = request(
            fixture.environment(true),
            "session.list",
            v5::SessionListRequest { query: invalid }.encode_to_vec(),
        )
        .await;
        assert_ne!(
            payload.type_name,
            v5::SessionListResult::full_name(),
            "{label}"
        );
    }
    let accepted = list(
        fixture.environment(true),
        v5::SessionsQuery {
            before: Some(1),
            limit: Some(2),
            ..valid
        },
    )
    .await;
    assert!(!ids(&accepted).is_empty());
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_waiters_and_open_reviews_make_roots_wait_until_they_settle() {
    let fixture = Fixture::new().await;
    let query = roots(workspace(&fixture).await);
    assert!(waiting(&fixture, &query).await.is_empty());

    let (_, services) = world()
        .core
        .locations
        .session(&session_id(&fixture.other))
        .unwrap();
    let request = permission::Request::decode(
        &parse_json(&format!(
            r#"{{"id":"per_list_{0}","sessionID":"{0}","action":"fixture","resources":["resource"]}}"#,
            fixture.other
        ))
        .unwrap(),
    )
    .unwrap();
    let admission = services.permissions.ask(request.clone(), None).unwrap();
    assert_eq!(waiting(&fixture, &query).await, strings(&[&fixture.other]));
    services
        .permissions
        .reply(&request.id, permission::Reply("once".into()), None)
        .unwrap();
    admission.wait.unwrap().await.unwrap().unwrap();
    assert!(waiting(&fixture, &query).await.is_empty());

    defer(&fixture.child).await;
    assert_eq!(waiting(&fixture, &query).await, strings(&[&fixture.root]));
    withdraw(&fixture.child).await;
    assert!(waiting(&fixture, &query).await.is_empty());
    fixture.close().await;
}
