mod connector_support;
mod remote_derived_support;
mod support;

use remote_derived_support::{Fixture, activate, create, message, stop, world};
use support::{Client, session_scope, text, units, wire::*};
use ycoding_core::ycoding_schema::{JsonValue, ObjectEncoder, parse_json, session, stringify_json};
use ycoding_core::ycoding_store::{KeyPart, session::SessionTable, tuple_key};
use ycoding_protocol::v5;
use ycoding_runtime::{Server, standard};

async fn open(fixture: &Fixture) -> (Server, Client) {
    let server = support::start(
        fixture.environment(true).services.clone(),
        standard().unwrap(),
    )
    .await;
    let client = Client::open(server.address(), &[]).await.unwrap();
    (server, client)
}

fn captured(cursor: Option<v5::LosslessString>) -> v5::SessionCapturedChangesListRequest {
    v5::SessionCapturedChangesListRequest {
        payload: v5::SessionCapturedChangesListRequestPayload { cursor },
    }
}

fn economics(ids: &[&str]) -> v5::SessionTeamEconomicsRequest {
    v5::SessionTeamEconomicsRequest {
        payload: v5::SessionTeamEconomicsRequestPayload {
            session_i_ds: v5::SessionTeamEconomicsRequestPayloadSessionIDs {
                items: ids.iter().map(|id| text(id)).collect(),
            },
        },
    }
}

fn activity(ids: &[&str]) -> v5::SessionFamilyActivityRequest {
    v5::SessionFamilyActivityRequest {
        payload: v5::SessionFamilyActivityRequestPayload {
            session_i_ds: v5::SessionFamilyActivityRequestPayloadSessionIDs {
                items: ids.iter().map(|id| text(id)).collect(),
            },
        },
    }
}

fn assistant(content: Vec<JsonValue>, completed: bool) -> String {
    stringify_json(
        &ObjectEncoder::new()
            .field("agent", "build")
            .field(
                "model",
                &parse_json(r#"{"providerID":"fixture","id":"code"}"#).unwrap(),
            )
            .field("content", &content)
            .field(
                "time",
                &if completed {
                    parse_json(r#"{"created":2,"completed":2}"#).unwrap()
                } else {
                    parse_json(r#"{"created":2}"#).unwrap()
                },
            )
            .finish(),
    )
}

fn patch(path: &str) -> JsonValue {
    parse_json(&format!(r#"{{"type":"tool","id":"patch_call","name":"patch","state":{{"status":"completed","input":{{}},"content":[],"structured":{{"files":[{{"file":"{path}","patch":"--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+new\n"}}]}}}},"time":{{"created":1,"completed":2}}}}"#)).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_captured_changes_read_retained_family_history_and_bind_cursors_to_the_projection() {
    let fixture = Fixture::new().await;
    message(
        &fixture.root,
        "input",
        "user",
        1,
        r#"{"text":"Task","time":{"created":1,"consumed":1}}"#,
    )
    .await;
    let launch = parse_json(&format!(r#"{{"type":"tool","id":"launch","name":"subagent","state":{{"status":"completed","input":{{}},"content":[],"structured":{{"sessionID":"{}"}}}},"time":{{"created":1,"completed":2}}}}"#, fixture.child)).unwrap();
    let mut content = (0..100)
        .map(|index| patch(&format!("file{index}.txt")))
        .collect::<Vec<_>>();
    content.push(launch);
    message(
        &fixture.root,
        "launch",
        "assistant",
        2,
        &assistant(content, true),
    )
    .await;
    message(
        &fixture.child,
        "input",
        "user",
        1,
        r#"{"text":"Child task","time":{"created":1,"consumed":1}}"#,
    )
    .await;
    message(
        &fixture.child,
        "patch",
        "assistant",
        2,
        &assistant(vec![patch("child.txt")], true),
    )
    .await;
    message(
        &fixture.other,
        "patch",
        "assistant",
        1,
        &assistant(vec![patch("foreign.txt")], true),
    )
    .await;
    let (server, mut client) = open(&fixture).await;
    let scope = session_scope(&fixture.root);
    let first: v5::SessionCapturedChangesListResult = ask(
        &mut client,
        "session.capturedChanges.list",
        scope.clone(),
        captured(None),
    )
    .await;
    assert_eq!(first.data.items.len(), 100);
    assert_eq!(units(&first.data.items[0].path), "file0.txt");
    assert!(first.data.items.iter().all(|group| group.additions == 1
        && group.deletions == 0
        && group.status == 1
        && units(&group.placement_message_id) == format!("msg_{}_launch", fixture.root)));
    let cursor = first.cursor.unwrap().next.unwrap();
    let next: v5::SessionCapturedChangesListResult = ask(
        &mut client,
        "session.capturedChanges.list",
        scope.clone(),
        captured(Some(cursor.clone())),
    )
    .await;
    assert_eq!(next.data.items.len(), 1);
    assert!(next.cursor.is_none());
    let child = &next.data.items[0];
    assert_eq!(units(&child.path), "child.txt");
    assert_eq!(
        units(&child.placement_message_id),
        format!("msg_{}_launch", fixture.root)
    );
    assert_eq!(
        units(&child.files.items[0].diff),
        "--- /dev/null\n+++ b/child.txt\n@@ -0,0 +1 @@\n+new\n"
    );
    let own: v5::SessionCapturedChangesListResult = ask(
        &mut client,
        "session.capturedChanges.list",
        session_scope(&fixture.child),
        captured(None),
    )
    .await;
    assert_eq!(own.data.items.len(), 1);
    assert_eq!(
        units(&own.data.items[0].placement_message_id),
        format!("msg_{}_patch", fixture.child)
    );
    let foreign: v5::ConnectorError = refuse(
        &mut client,
        "session.capturedChanges.list",
        session_scope(&fixture.other),
        captured(Some(cursor.clone())),
    )
    .await;
    assert_eq!(foreign.code, 1);
    message(
        &fixture.root,
        "changed",
        "assistant",
        3,
        &assistant(vec![patch("changed.txt")], true),
    )
    .await;
    let stale: v5::ConnectorError = refuse(
        &mut client,
        "session.capturedChanges.list",
        scope,
        captured(Some(cursor)),
    )
    .await;
    assert_eq!(stale.code, 1);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_economics_reads_selected_core_totals_and_preserves_unreported_diagnostics() {
    let fixture = Fixture::new().await;
    let root = fixture.root.clone();
    world()
        .store
        .submit(move |tx| {
            let mut row = tx
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&root.as_str().into())]))?
                .unwrap();
            row.cost = 1.25;
            row.tokens_input = 100;
            row.tokens_output = 10;
            row.tokens_reasoning = 2;
            row.tokens_cache_read = 50;
            row.tokens_cache_write = 5;
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
    message(&fixture.root, "measured", "assistant", 1, r#"{"agent":"build","model":{"providerID":"fixture","id":"code"},"content":[],"time":{"created":1,"completed":2},"tokens":{"input":10,"output":2,"reasoning":1,"cache":{"read":3,"write":4}},"diagnostics":{"contextLimit":100,"providerCache":{"mechanism":"provider-reported","readReported":false,"writeReported":true}}}"#).await;
    let (server, mut client) = open(&fixture).await;
    let result: v5::SessionTeamEconomicsResult = ask(
        &mut client,
        "session.team.economics",
        session_scope(&fixture.root),
        economics(&[&fixture.child, &fixture.root]),
    )
    .await;
    assert_eq!(result.data.items.len(), 2);
    let child = &result.data.items[0];
    assert_eq!(units(&child.session_id), fixture.child);
    assert_eq!(child.cost, 0.0);
    assert!(
        child.context_total.is_none()
            && child.context_limit.is_none()
            && child.cache_hit_ratio.is_none()
            && child.cache_read.is_none()
            && child.cache_write.is_none()
    );
    let root = &result.data.items[1];
    assert_eq!(units(&root.session_id), fixture.root);
    assert_eq!(root.cost, 1.25);
    assert_eq!(
        (root.tokens.input, root.tokens.output, root.tokens.reasoning),
        (100.0, 10.0, 2.0)
    );
    assert_eq!(
        (root.tokens.cache.read, root.tokens.cache.write),
        (50.0, 5.0)
    );
    assert_eq!(
        (root.context_total, root.context_limit),
        (Some(20.0), Some(100.0))
    );
    assert!(root.cache_read.is_none() && root.cache_hit_ratio.is_none());
    assert_eq!(root.cache_write, Some(4.0));
    let root_only: v5::SessionTeamEconomicsResult = ask(
        &mut client,
        "session.team.economics",
        session_scope(&fixture.root),
        economics(&[&fixture.root]),
    )
    .await;
    assert_eq!(root_only.data.items, vec![root.clone()]);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_activity_uses_each_members_execution_and_omits_idle_activity() {
    let fixture = Fixture::new().await;
    let (server, mut client) = open(&fixture).await;
    let root_only: v5::SessionFamilyActivityResult = ask(
        &mut client,
        "session.family.activity",
        session_scope(&fixture.root),
        activity(&[]),
    )
    .await;
    assert_eq!(root_only.data.items.len(), 1);
    assert_eq!(units(&root_only.data.items[0].session_id), fixture.root);
    assert!(!root_only.data.items[0].executing && root_only.data.items[0].activity.is_none());
    message(&fixture.child, "running", "assistant", 1, &assistant(vec![parse_json(r#"{"type":"tool","id":"read_call","name":"read","state":{"status":"running","input":{"path":"/private/synthetic/code.ts"},"structured":{},"content":[]},"time":{"created":1}}"#).unwrap()], false)).await;
    activate(&fixture.child).await;
    let running: v5::SessionFamilyActivityResult = ask(
        &mut client,
        "session.family.activity",
        session_scope(&fixture.root),
        activity(&[&fixture.child]),
    )
    .await;
    assert_eq!(running.data.items.len(), 2);
    assert!(!running.data.items[0].executing && running.data.items[0].activity.is_none());
    let child = &running.data.items[1];
    assert_eq!(units(&child.session_id), fixture.child);
    assert!(child.executing);
    let action = child.activity.as_ref().unwrap();
    assert_eq!((action.kind, action.room), (1, 1));
    assert_eq!(units(&action.text), "Reading code.ts");
    stop(&fixture.child).await;
    let idle: v5::SessionFamilyActivityResult = ask(
        &mut client,
        "session.family.activity",
        session_scope(&fixture.root),
        activity(&[&fixture.child]),
    )
    .await;
    assert!(
        idle.data
            .items
            .iter()
            .all(|member| !member.executing && member.activity.is_none())
    );
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_family_reads_reject_unknown_deleted_foreign_and_unavailable_placement() {
    let fixture = Fixture::new().await;
    let (server, mut client) = open(&fixture).await;
    for owner in ["ses_local_missing", &fixture.child] {
        if owner == fixture.child {
            world()
                .core
                .sessions
                .remove(&session::Id::new(owner).unwrap())
                .await
                .unwrap();
        }
        let changes: v5::ConnectorError = refuse(
            &mut client,
            "session.capturedChanges.list",
            session_scope(owner),
            captured(None),
        )
        .await;
        let costs: v5::ConnectorError = refuse(
            &mut client,
            "session.team.economics",
            session_scope(owner),
            economics(&[owner]),
        )
        .await;
        let actions: v5::ConnectorError = refuse(
            &mut client,
            "session.family.activity",
            session_scope(owner),
            activity(&[]),
        )
        .await;
        assert_eq!((changes.code, costs.code, actions.code), (5, 5, 5));
    }
    let direct = format!("{}_direct", fixture.root);
    let grandchild = format!("{}_nested", fixture.root);
    let btw = format!("{}_btw", fixture.root);
    create(
        &direct,
        &fixture.project,
        &fixture.child_directory,
        Some(&fixture.root),
        "build",
    )
    .await;
    create(
        &grandchild,
        &fixture.project,
        &fixture.child_directory,
        Some(&direct),
        "build",
    )
    .await;
    create(
        &btw,
        &fixture.project,
        &fixture.directory,
        Some(&fixture.root),
        "btw",
    )
    .await;
    for owner in [&fixture.other, &grandchild] {
        let costs: v5::ConnectorError = refuse(
            &mut client,
            "session.team.economics",
            session_scope(&fixture.root),
            economics(&[owner]),
        )
        .await;
        let actions: v5::ConnectorError = refuse(
            &mut client,
            "session.family.activity",
            session_scope(&fixture.root),
            activity(&[owner]),
        )
        .await;
        assert_eq!((costs.code, actions.code), (12, 5));
    }
    let side: v5::ConnectorError = refuse(
        &mut client,
        "session.team.economics",
        session_scope(&fixture.root),
        economics(&[&btw]),
    )
    .await;
    assert_eq!(side.code, 12);
    let side_activity: v5::SessionFamilyActivityResult = ask(
        &mut client,
        "session.family.activity",
        session_scope(&fixture.root),
        activity(&[&btw]),
    )
    .await;
    assert_eq!(units(&side_activity.data.items[1].session_id), btw);
    let root_cost: v5::ConnectorError = refuse(
        &mut client,
        "session.team.economics",
        session_scope(&direct),
        economics(&[&direct]),
    )
    .await;
    let root_activity: v5::ConnectorError = refuse(
        &mut client,
        "session.family.activity",
        session_scope(&direct),
        activity(&[]),
    )
    .await;
    assert_eq!((root_cost.code, root_activity.code), (12, 5));
    let repeated_cost: v5::ConnectorError = refuse(
        &mut client,
        "session.team.economics",
        session_scope(&fixture.root),
        economics(&[&direct, &direct]),
    )
    .await;
    let repeated_activity: v5::ConnectorError = refuse(
        &mut client,
        "session.family.activity",
        session_scope(&fixture.root),
        activity(&[&direct, &direct]),
    )
    .await;
    assert_eq!((repeated_cost.code, repeated_activity.code), (1, 1));
    let root_in_children: v5::ConnectorError = refuse(
        &mut client,
        "session.family.activity",
        session_scope(&fixture.root),
        activity(&[&fixture.root]),
    )
    .await;
    assert_eq!(root_in_children.code, 5);
    std::fs::rename(&fixture.path, fixture.path.with_extension("moved")).unwrap();
    let changes: v5::ConnectorError = refuse(
        &mut client,
        "session.capturedChanges.list",
        session_scope(&fixture.root),
        captured(None),
    )
    .await;
    let costs: v5::ConnectorError = refuse(
        &mut client,
        "session.team.economics",
        session_scope(&fixture.root),
        economics(&[&fixture.root]),
    )
    .await;
    let actions: v5::ConnectorError = refuse(
        &mut client,
        "session.family.activity",
        session_scope(&fixture.root),
        activity(&[]),
    )
    .await;
    assert_eq!((changes.code, costs.code, actions.code), (5, 5, 5));
    std::fs::rename(fixture.path.with_extension("moved"), &fixture.path).unwrap();
    std::fs::rename(fixture.path.join("child"), fixture.path.join("child-moved")).unwrap();
    let costs: v5::ConnectorError = refuse(
        &mut client,
        "session.team.economics",
        session_scope(&fixture.root),
        economics(&[&direct]),
    )
    .await;
    let actions: v5::ConnectorError = refuse(
        &mut client,
        "session.family.activity",
        session_scope(&fixture.root),
        activity(&[&direct]),
    )
    .await;
    assert_eq!((costs.code, actions.code), (5, 5));
    let root_only: v5::SessionTeamEconomicsResult = ask(
        &mut client,
        "session.team.economics",
        session_scope(&fixture.root),
        economics(&[&fixture.root]),
    )
    .await;
    assert_eq!(root_only.data.items.len(), 1);
    std::fs::rename(fixture.path.join("child-moved"), fixture.path.join("child")).unwrap();
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_family_selection_accepts_128_members_without_the_remote_15_member_limit() {
    let fixture = Fixture::new().await;
    let ids = (0..128)
        .map(|index| format!("{}_member{index}", fixture.root))
        .collect::<Vec<_>>();
    for id in &ids {
        create(
            id,
            &fixture.project,
            &fixture.child_directory,
            Some(&fixture.root),
            "build",
        )
        .await;
    }
    let selected = ids.iter().map(String::as_str).collect::<Vec<_>>();
    let (server, mut client) = open(&fixture).await;
    let costs: v5::SessionTeamEconomicsResult = ask(
        &mut client,
        "session.team.economics",
        session_scope(&fixture.root),
        economics(&selected),
    )
    .await;
    assert_eq!(
        costs
            .data
            .items
            .iter()
            .map(|row| units(&row.session_id))
            .collect::<Vec<_>>(),
        ids
    );
    let actions: v5::SessionFamilyActivityResult = ask(
        &mut client,
        "session.family.activity",
        session_scope(&fixture.root),
        activity(&selected),
    )
    .await;
    assert_eq!(actions.data.items.len(), 129);
    assert_eq!(units(&actions.data.items[0].session_id), fixture.root);
    assert_eq!(
        actions.data.items[1..]
            .iter()
            .map(|row| units(&row.session_id))
            .collect::<Vec<_>>(),
        ids
    );
    server.shutdown().await.unwrap();
    fixture.close().await;
}
