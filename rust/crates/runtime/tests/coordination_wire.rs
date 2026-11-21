mod support;

use prost::{Message, Name};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use support::{machine, operation, record, services, session_scope, text, world};
use ycoding_core::ycoding_store::{IndexOrder, IndexQuery, KeyPart, session, tuple_key};
use ycoding_protocol::{
    domain_json::{self, Domain},
    v5,
};
use ycoding_runtime::{Environment, LocalAuth, Settled, Staging, Subscriptions, standard};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static REQUEST: AtomicU64 = AtomicU64::new(0);

fn object<const N: usize>(fields: [(&str, Domain); N]) -> Domain {
    Domain::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.encode_utf16().collect(), value))
            .collect(),
    )
}

fn string(value: &str) -> Domain {
    Domain::Text(value.encode_utf16().collect())
}

fn field<'a>(value: &'a Domain, name: &str) -> &'a Domain {
    let Domain::Object(fields) = value else {
        panic!("expected an object for {name}, got {value:?}");
    };
    let key: Vec<_> = name.encode_utf16().collect();
    &fields
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .unwrap_or_else(|| panic!("missing {name} in {value:?}"))
        .1
}

fn seed(rows: &[(&str, Option<&str>, Option<i64>)]) {
    let rows: Vec<_> = rows
        .iter()
        .map(|(id, parent, archived)| {
            let mut row = record(id);
            row.parent_id = parent.map(Into::into);
            row.time_archived = *archived;
            row
        })
        .collect();
    world()
        .store
        .submit(move |tx| {
            for row in rows {
                session::SessionTable::insert(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

async fn settle(name: &str, payload: Vec<u8>, scope: v5::Scope) -> v5::Result {
    let descriptor = operation(name);
    ycoding_protocol::validate_binary(&descriptor.request_type, &payload).unwrap();
    let request_id = format!(
        "{name}-boundary-{}",
        REQUEST.fetch_add(1, Ordering::Relaxed)
    );
    let environment = Arc::new(Environment {
        services: services(LocalAuth::disabled(), true),
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Staging::default(),
    });
    let settled = tokio::time::timeout(
        Duration::from_secs(30),
        standard().unwrap().invoke(
            environment,
            "coordination-boundary".into(),
            v5::Request {
                request_id: request_id.clone(),
                operation_id: descriptor.operation_id,
                scope,
                payload,
            },
        ),
    )
    .await
    .expect("public dispatcher exceeded its time bound")
    .expect("current operation must dispatch for a local client");
    let Settled::Result(result) = settled else {
        panic!("small coordination result must use inline settlement");
    };
    assert_eq!(result.request_id, request_id);
    assert_eq!(result.operation_id, descriptor.operation_id);
    assert_eq!(result.settlement, descriptor.settlement);
    result
}

fn success(name: &str, result: v5::Result) -> v5::TypedPayload {
    let payload = match result.outcome {
        Some(v5::result::Outcome::Success(payload)) => payload,
        other => panic!("{name} must succeed, got {other:?}"),
    };
    assert_eq!(payload.type_name, operation(name).result_type);
    payload
}

async fn call(name: &str, request: Domain) -> Domain {
    let descriptor = operation(name);
    let bytes = domain_json::encode(&descriptor.request_type, &request, 65_536).unwrap();
    let payload = success(name, settle(name, bytes, machine()).await);
    domain_json::decode(&payload.type_name, &payload.payload).unwrap()
}

async fn refused(name: &str, request: Domain, reason: &str) {
    rejection(name, request, reason).await;
}

async fn rejection(name: &str, request: Domain, reason: &str) -> v5::CoordinationError {
    let descriptor = operation(name);
    let bytes = domain_json::encode(&descriptor.request_type, &request, 65_536).unwrap();
    let result = settle(name, bytes, machine()).await;
    let payload = match result.outcome {
        Some(v5::result::Outcome::Error(payload)) => payload,
        other => panic!("{name} must reject, got {other:?}"),
    };
    assert!(descriptor.error_types.contains(&payload.type_name));
    assert_eq!(payload.type_name, v5::CoordinationError::full_name());
    let error = v5::CoordinationError::decode(payload.payload.as_slice()).unwrap();
    assert_eq!(error.reason, text(reason));
    error
}

fn create_request(name: &str, master: &str, members: &[&str]) -> Domain {
    object([(
        "payload",
        object([
            ("name", string(name)),
            ("masterSessionID", string(master)),
            (
                "memberSessionIDs",
                Domain::List(members.iter().map(|id| string(id)).collect()),
            ),
        ]),
    )])
}

fn group_request(id: &Domain) -> Domain {
    object([("params", object([("groupID", id.clone())]))])
}

fn attach_request(id: &Domain, session: &str, owner: Option<&str>) -> Domain {
    let mut payload = vec![("sessionID".encode_utf16().collect(), string(session))];
    if let Some(owner) = owner {
        payload.push(("ownerSessionID".encode_utf16().collect(), string(owner)));
    }
    object([
        ("params", object([("groupID", id.clone())])),
        ("payload", Domain::Object(payload)),
    ])
}

fn detach_request(id: &Domain, session: &str) -> Domain {
    object([(
        "params",
        object([("groupID", id.clone()), ("sessionID", string(session))]),
    )])
}

fn update_request(id: &Domain, revision: u32, name: &str) -> Domain {
    object([
        ("params", object([("groupID", id.clone())])),
        (
            "payload",
            object([
                ("revision", Domain::Number(f64::from(revision))),
                ("name", string(name)),
            ]),
        ),
    ])
}

fn events(id: &Domain) -> Vec<session::Event> {
    let Domain::Text(units) = id else {
        panic!("group identity must be a string");
    };
    let id = ycoding_core::ycoding_schema::LosslessString::from_utf16(units.clone());
    world()
        .store
        .snapshot()
        .unwrap()
        .index_range::<session::EventTable>(
            "event_aggregate_seq_idx",
            IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&tuple_key(&[KeyPart::String(&id)])),
                order: IndexOrder::Ascending,
                after: None,
                limit: 16,
            },
        )
        .unwrap()
        .into_iter()
        .map(|entry| entry.record)
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_attach_and_detach_preserve_member_contracts() {
    let _serial = SERIAL.lock().await;
    let master = "ses_coord_attach_master";
    let root = "ses_coord_attach_root";
    seed(&[
        (master, None, None),
        (root, None, None),
        ("ses_coord_attach_child", Some(master), None),
        ("ses_coord_attach_archived", None, Some(3)),
        ("ses_coord_attach_standalone", None, None),
        ("ses_coord_attach_unowned", None, None),
    ]);
    world()
        .store
        .submit(move |tx| {
            let mut standalone = record("ses_coord_attach_standalone");
            standalone.scope = "standalone".into();
            session::SessionTable::put(tx, &standalone)?;
            let mut away = record(root);
            away.directory = "/independent/recorded-root".into();
            away.autonomy = Some(ycoding_core::ycoding_schema::parse_json(
            r#"{"mode":"normal","permissions":"auto","guardrails":"manual","answers":"manual"}"#,
        ).unwrap());
            session::SessionTable::put(tx, &away)
        })
        .unwrap()
        .wait()
        .unwrap();
    let before = world()
        .core
        .sessions
        .get(&ycoding_core::ycoding_schema::session::Id::new(root).unwrap())
        .unwrap()
        .unwrap();
    let created = call(
        "coordination.create",
        create_request("Attach boundary", master, &["ses_coord_attach_unowned"]),
    )
    .await;
    let id = field(field(&created, "data"), "id").clone();
    for (session, message) in [
        (master, "The Project's Master cannot attach itself as a member".to_owned()),
        ("ses_coord_attach_child", "Session ses_coord_attach_child is a child Session, not a root".to_owned()),
        ("ses_coord_attach_archived", "Session ses_coord_attach_archived is archived".to_owned()),
        ("ses_coord_attach_standalone", "Session ses_coord_attach_standalone is a standalone Session and cannot join a Project".to_owned()),
        ("ses_coord_attach_missing", "Session ses_coord_attach_missing does not exist".to_owned()),
        ("ses_coord_attach_unowned", "Session ses_coord_attach_unowned is already a member of this Project with a different owner; use assign to change its owner".to_owned()),
    ] {
        let history = events(&id);
        let error = rejection("coordination.attach", attach_request(&id, session, None), "CoordinationRuntime.RefusedError").await;
        assert_eq!(error.message, text(&message));
        assert_eq!(events(&id), history);
    }
    let expected = object([(
        "data",
        object([
            ("groupID", id.clone()),
            ("sessionID", string(root)),
            (
                "location",
                object([("directory", string("/independent/recorded-root"))]),
            ),
            ("ownerSessionID", string(master)),
            ("reconciled", Domain::Bool(false)),
        ]),
    )]);
    assert_eq!(
        call("coordination.attach", attach_request(&id, root, None)).await,
        expected
    );
    let history = events(&id);
    let repeated = call(
        "coordination.attach",
        attach_request(&id, root, Some(master)),
    )
    .await;
    assert_eq!(
        field(field(&repeated, "data"), "reconciled"),
        &Domain::Bool(true)
    );
    assert_eq!(events(&id), history);
    assert_eq!(
        world().core.sessions.get(&before.id).unwrap().unwrap(),
        before
    );
    let fetched = call("coordination.get", group_request(&id)).await;
    let Domain::List(members) = field(field(&fetched, "data"), "members") else {
        panic!("members must be a list")
    };
    assert!(
        members
            .iter()
            .any(|member| field(member, "sessionID") == &string(root)
                && field(field(member, "owner"), "sessionID") == &string(master))
    );

    world()
        .store
        .submit(move |tx| {
            session::PendingTable::insert(
                tx,
                &session::Pending {
                    id: "msg_coord_attach_pending".into(),
                    session_id: root.into(),
                    type_: "compaction".into(),
                    data: ycoding_core::ycoding_schema::JsonValue::Object(Default::default()),
                    delivery: None,
                    admitted_seq: 1,
                    time_created: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let history = events(&id);
    let busy = rejection(
        "coordination.detach",
        detach_request(&id, root),
        "CoordinationRuntime.RefusedError",
    )
    .await;
    assert_eq!(
        busy.message,
        text(&format!(
            "Session {root} has active work or pending requests; wait for it to settle or interrupt it before removing it from the Project"
        ))
    );
    assert_eq!(events(&id), history);
    world()
        .store
        .submit(|tx| {
            tx.delete::<session::PendingTable>(&tuple_key(&[KeyPart::String(
                &"msg_coord_attach_pending".into(),
            )]))
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        call("coordination.detach", detach_request(&id, root)).await,
        object([(
            "data",
            object([("sessionID", string(root)), ("removed", Domain::Bool(true))])
        )])
    );
    assert_eq!(
        world().core.sessions.get(&before.id).unwrap().unwrap(),
        before
    );
    let missing = rejection(
        "coordination.detach",
        detach_request(&id, root),
        "CoordinationRuntime.RefusedError",
    )
    .await;
    assert_eq!(
        missing.message,
        text(&format!("Session {root} is not a member of this Project"))
    );
    let fetched = call("coordination.get", group_request(&id)).await;
    let Domain::List(members) = field(field(&fetched, "data"), "members") else {
        panic!("members must be a list")
    };
    assert_eq!(members.len(), 1);
    assert_eq!(
        field(&members[0], "sessionID"),
        &string("ses_coord_attach_unowned")
    );
    call("coordination.delete", group_request(&id)).await;
    let unknown = string("cgrp_coord_attach_unknown");
    let get_error = rejection(
        "coordination.get",
        group_request(&unknown),
        "Coordination.NotFoundError",
    )
    .await;
    for (operation, request) in [
        ("coordination.attach", attach_request(&unknown, root, None)),
        ("coordination.detach", detach_request(&unknown, root)),
    ] {
        assert_eq!(
            rejection(operation, request, "Coordination.NotFoundError").await,
            get_error
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_list_dispatches_current_empty_request() {
    let _serial = SERIAL.lock().await;
    let bytes = v5::CoordinationListRequest {}.encode_to_vec();
    assert!(bytes.is_empty());
    let payload = success(
        "coordination.list",
        settle("coordination.list", bytes, machine()).await,
    );
    let result = v5::CoordinationListResult::decode(payload.payload.as_slice()).unwrap();
    assert!(result.data.items.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_settings_dispatches_current_empty_request() {
    let _serial = SERIAL.lock().await;
    let bytes = v5::CoordinationSettingsRequest {}.encode_to_vec();
    assert!(bytes.is_empty());
    let payload = success(
        "coordination.settings",
        settle("coordination.settings", bytes, machine()).await,
    );
    let result = v5::CoordinationSettingsResult::decode(payload.payload.as_slice()).unwrap();
    assert!(result.data.enabled);
    assert_eq!(result.data.categories.items, vec![1, 2, 3]);
    assert!(result.data.actions.is_none());
    assert!(result.data.resources.is_none());
    assert!(result.data.expires_at.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_crud_preserves_defaults_settings_replacement_and_event_order() {
    let _serial = SERIAL.lock().await;
    seed(&[
        ("ses_coord_crud_master", None, None),
        ("ses_coord_crud_member", None, None),
    ]);
    let created = call(
        "coordination.create",
        create_request(
            "Boundary",
            "ses_coord_crud_master",
            &["ses_coord_crud_member"],
        ),
    )
    .await;
    let group = field(&created, "data");
    let id = field(group, "id").clone();
    assert_eq!(field(group, "revision"), &Domain::Number(0.0));
    assert_eq!(field(group, "active"), &Domain::Bool(false));
    assert_eq!(
        field(field(group, "master"), "sessionID"),
        &string("ses_coord_crud_master")
    );
    assert_eq!(
        field(field(group, "settings"), "concurrency"),
        &Domain::Null
    );
    let Domain::List(members) = field(group, "members") else {
        panic!("members must be a list")
    };
    assert_eq!(members.len(), 1);
    assert_eq!(
        field(&members[0], "sessionID"),
        &string("ses_coord_crud_member")
    );

    let changed = call(
        "coordination.update",
        object([
            ("params", object([("groupID", id.clone())])),
            (
                "payload",
                object([
                    ("revision", Domain::Number(0.0)),
                    (
                        "settings",
                        object([
                            ("concurrency", Domain::Number(2.0)),
                            (
                                "delegatedDecisions",
                                object([("categories", Domain::List(vec![string("question")]))]),
                            ),
                        ]),
                    ),
                ]),
            ),
        ]),
    )
    .await;
    assert_eq!(
        field(field(&changed, "data"), "revision"),
        &Domain::Number(1.0)
    );
    let replacement = object([("concurrency", Domain::Null)]);
    let changed = call(
        "coordination.update",
        object([
            ("params", object([("groupID", id.clone())])),
            (
                "payload",
                object([
                    ("revision", Domain::Number(1.0)),
                    ("settings", replacement.clone()),
                ]),
            ),
        ]),
    )
    .await;
    assert_eq!(field(field(&changed, "data"), "settings"), &replacement);
    let before = events(&id);
    refused(
        "coordination.update",
        update_request(&id, 1, "Stale"),
        "Coordination.ConflictError",
    )
    .await;
    assert_eq!(events(&id), before);
    let fetched = call("coordination.get", group_request(&id)).await;
    assert_eq!(field(&fetched, "data"), field(&changed, "data"));
    let listed = call("coordination.list", object([])).await;
    let Domain::List(groups) = field(&listed, "data") else {
        panic!("summary data must be a list")
    };
    let summary = groups
        .iter()
        .find(|group| field(group, "id") == &id)
        .unwrap();
    assert_eq!(field(summary, "memberCount"), &Domain::Number(1.0));
    assert_eq!(field(summary, "revision"), &Domain::Number(2.0));
    call("coordination.delete", group_request(&id)).await;
    refused(
        "coordination.get",
        group_request(&id),
        "Coordination.NotFoundError",
    )
    .await;
    let history = events(&id);
    let types: Vec<_> = history
        .iter()
        .map(|event| event.type_.to_utf8().unwrap())
        .collect();
    assert_eq!(
        types,
        [
            "coordination.group.created.2",
            "coordination.group.changed.1",
            "coordination.group.changed.1",
            "coordination.group.deleted.1"
        ]
    );
    assert_eq!(
        history.iter().map(|event| event.seq).collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
    for id in ["ses_coord_crud_master", "ses_coord_crud_member"] {
        assert!(
            world()
                .core
                .sessions
                .get(&ycoding_core::ycoding_schema::session::Id::new(id).unwrap())
                .unwrap()
                .is_some()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_concurrent_revision_updates_have_one_winner_and_one_event() {
    let _serial = SERIAL.lock().await;
    seed(&[("ses_coord_cas_master", None, None)]);
    let created = call(
        "coordination.create",
        create_request("Concurrent", "ses_coord_cas_master", &[]),
    )
    .await;
    let id = field(field(&created, "data"), "id").clone();
    let descriptor = operation("coordination.update");
    let first = domain_json::encode(
        &descriptor.request_type,
        &update_request(&id, 0, "First"),
        65_536,
    )
    .unwrap();
    let second = domain_json::encode(
        &descriptor.request_type,
        &update_request(&id, 0, "Second"),
        65_536,
    )
    .unwrap();
    let start = tokio::sync::Barrier::new(2);
    let (first, second) = tokio::join!(
        async {
            start.wait().await;
            settle("coordination.update", first, machine()).await
        },
        async {
            start.wait().await;
            settle("coordination.update", second, machine()).await
        },
    );
    let mut winners = 0;
    let mut conflicts = 0;
    for result in [first, second] {
        match result.outcome {
            Some(v5::result::Outcome::Success(payload)) => {
                winners += 1;
                assert_eq!(payload.type_name, descriptor.result_type);
                let changed = domain_json::decode(&payload.type_name, &payload.payload).unwrap();
                assert_eq!(
                    field(field(&changed, "data"), "revision"),
                    &Domain::Number(1.0)
                );
            }
            Some(v5::result::Outcome::Error(payload)) => {
                conflicts += 1;
                assert_eq!(payload.type_name, v5::CoordinationError::full_name());
                let error = v5::CoordinationError::decode(payload.payload.as_slice()).unwrap();
                assert_eq!(error.reason, text("Coordination.ConflictError"));
            }
            other => panic!("unexpected update outcome {other:?}"),
        }
    }
    assert_eq!((winners, conflicts), (1, 1));
    let history = events(&id);
    assert_eq!(history.len(), 2);
    assert_eq!(history[1].seq, 1);
    assert_eq!(
        history[1].type_.to_utf8().unwrap(),
        "coordination.group.changed.1"
    );
    call("coordination.delete", group_request(&id)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_rejects_ineligible_roots_and_cross_group_participation() {
    let _serial = SERIAL.lock().await;
    seed(&[
        ("ses_coord_validation_master", None, None),
        ("ses_coord_validation_member", None, None),
        ("ses_coord_validation_other", None, None),
        (
            "ses_coord_validation_child",
            Some("ses_coord_validation_master"),
            None,
        ),
        ("ses_coord_validation_archived", None, Some(3)),
    ]);
    for (master, members) in [
        ("ses_coord_validation_unknown", vec![]),
        ("ses_coord_validation_child", vec![]),
        ("ses_coord_validation_archived", vec![]),
        (
            "ses_coord_validation_master",
            vec!["ses_coord_validation_unknown"],
        ),
        (
            "ses_coord_validation_master",
            vec!["ses_coord_validation_child"],
        ),
        (
            "ses_coord_validation_master",
            vec!["ses_coord_validation_archived"],
        ),
        (
            "ses_coord_validation_master",
            vec!["ses_coord_validation_member", "ses_coord_validation_member"],
        ),
        (
            "ses_coord_validation_master",
            vec!["ses_coord_validation_master"],
        ),
    ] {
        refused(
            "coordination.create",
            create_request("Invalid", master, &members),
            "Coordination.IneligibleSessionError",
        )
        .await;
    }
    let created = call(
        "coordination.create",
        create_request(
            "Existing",
            "ses_coord_validation_master",
            &["ses_coord_validation_member"],
        ),
    )
    .await;
    let id = field(field(&created, "data"), "id").clone();
    let history = events(&id);
    for members in [
        ["ses_coord_validation_member"],
        ["ses_coord_validation_master"],
    ] {
        refused(
            "coordination.create",
            create_request("Foreign", "ses_coord_validation_other", &members),
            "Coordination.IneligibleSessionError",
        )
        .await;
    }
    assert_eq!(events(&id), history);
    let fetched = call("coordination.get", group_request(&id)).await;
    assert_eq!(field(&fetched, "data"), field(&created, "data"));
    call("coordination.delete", group_request(&id)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_master_family_removal_preserves_unrelated_group_and_history() {
    let _serial = SERIAL.lock().await;
    seed(&[
        ("ses_coord_remove_master", None, None),
        (
            "ses_coord_remove_child",
            Some("ses_coord_remove_master"),
            None,
        ),
        (
            "ses_coord_remove_grandchild",
            Some("ses_coord_remove_child"),
            None,
        ),
        ("ses_coord_remove_member", None, None),
        ("ses_coord_remove_other", None, None),
    ]);
    let doomed = call(
        "coordination.create",
        create_request(
            "Removed",
            "ses_coord_remove_master",
            &["ses_coord_remove_member"],
        ),
    )
    .await;
    let doomed_id = field(field(&doomed, "data"), "id").clone();
    let unrelated = call(
        "coordination.create",
        create_request("Unrelated", "ses_coord_remove_other", &[]),
    )
    .await;
    let unrelated_id = field(field(&unrelated, "data"), "id").clone();
    let before = events(&doomed_id);
    let request = v5::SessionRemoveRequest {
        params: v5::SessionRemoveRequestParams {
            session_id: text("ses_coord_remove_master"),
        },
    };
    success(
        "session.remove",
        settle(
            "session.remove",
            request.encode_to_vec(),
            session_scope("ses_coord_remove_master"),
        )
        .await,
    );
    for id in [
        "ses_coord_remove_master",
        "ses_coord_remove_child",
        "ses_coord_remove_grandchild",
    ] {
        assert!(
            world()
                .core
                .sessions
                .get(&ycoding_core::ycoding_schema::session::Id::new(id).unwrap())
                .unwrap()
                .is_none()
        );
    }
    assert!(
        world()
            .core
            .sessions
            .get(
                &ycoding_core::ycoding_schema::session::Id::new("ses_coord_remove_member").unwrap()
            )
            .unwrap()
            .is_some()
    );
    refused(
        "coordination.get",
        group_request(&doomed_id),
        "Coordination.NotFoundError",
    )
    .await;
    assert_eq!(events(&doomed_id), before);
    let fetched = call("coordination.get", group_request(&unrelated_id)).await;
    assert_eq!(field(&fetched, "data"), field(&unrelated, "data"));
    call("coordination.delete", group_request(&unrelated_id)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_retains_archived_rows_but_revalidates_update_admission() {
    let _serial = SERIAL.lock().await;
    seed(&[
        ("ses_coord_archive_master", None, None),
        ("ses_coord_archive_member", None, None),
    ]);
    let created = call(
        "coordination.create",
        create_request(
            "Retained",
            "ses_coord_archive_master",
            &["ses_coord_archive_member"],
        ),
    )
    .await;
    let id = field(field(&created, "data"), "id").clone();
    world()
        .store
        .submit(|tx| {
            let mut row = record("ses_coord_archive_member");
            row.time_archived = Some(5);
            session::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let fetched = call("coordination.get", group_request(&id)).await;
    let Domain::List(members) = field(field(&fetched, "data"), "members") else {
        panic!("members must be a list")
    };
    assert_eq!(members.len(), 1);
    assert_eq!(
        field(&members[0], "sessionID"),
        &string("ses_coord_archive_member")
    );
    let before = events(&id);
    refused(
        "coordination.update",
        update_request(&id, 0, "Cannot readmit"),
        "Coordination.IneligibleSessionError",
    )
    .await;
    assert_eq!(events(&id), before);
    call("coordination.delete", group_request(&id)).await;
}
