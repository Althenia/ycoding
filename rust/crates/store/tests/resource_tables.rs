use std::ops::Bound;
use ycoding_schema::{JsonValue, LosslessString, parse_json};
use ycoding_store::{
    Catalog, Error, KeyPart, Metadata, Options, Store, TableDeclaration, TableSpec, analytics,
    project, resources, session, tuple_key,
};

const ANALYTICS: Catalog = Catalog::new(
    1,
    &[
        TableDeclaration::of::<analytics::DeliveryTable>(),
        TableDeclaration::of::<analytics::IntentTable>(),
    ],
);

#[test]
fn delivery_uses_the_writer_canonical_metadata() {
    let store = Store::disposable(Options::core(), ANALYTICS, Metadata::new([3; 16], 7)).unwrap();
    store
        .submit(|tx| {
            analytics::record(
                tx,
                analytics::Change {
                    source: "test_source",
                    identity: vec![1],
                    delete: false,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let state = store
        .snapshot()
        .unwrap()
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert_eq!(state.identity, [3; 16]);
    assert_eq!(state.source_generation, 7);
}

fn catalog() -> Catalog {
    Catalog::new(
        1,
        Box::leak(
            project::TABLES
                .iter()
                .chain(session::TABLES)
                .chain(resources::TABLES)
                .chain(ycoding_store::artifacts::TABLES)
                .chain(ANALYTICS.tables())
                .copied()
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        ),
    )
}
fn root() -> project::Project {
    project::Project {
        id: "p".into(),
        worktree: "".into(),
        vcs: None,
        name: None,
        icon_url: None,
        icon_url_override: None,
        icon_color: None,
        time_created: 0,
        time_updated: 0,
        time_initialized: None,
        sandboxes: vec![],
        commands: None,
    }
}
fn owner(id: &str) -> session::Session {
    session::Session {
        id: id.into(),
        project_id: "p".into(),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "".into(),
        path: None,
        title: "".into(),
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
        time_created: 0,
        time_updated: 0,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
    }
}
fn revision(id: &str, n: i64) -> session::Revision {
    session::Revision {
        session_id: id.into(),
        revision: n,
        parent_revision: (n > 0).then_some(n - 1),
        manifest_digest: None,
        covered_through_message_id: None,
        covered_through_seq: None,
        activation_event_id: None,
        activation_sequence: None,
        time_created: 0,
    }
}
fn doc<T: ycoding_schema::DomainDecode + ycoding_schema::DomainEncode>(
    text: &str,
) -> session::Document<T> {
    session::Document::new(parse_json(text).unwrap()).unwrap()
}
fn request(id: &str, count: i64) -> resources::Request {
    resources::Request {
        id: id.into(),
        session_id: "s".into(),
        input_id: None,
        assistant_message_id: None,
        connection_identity_digest: None,
        source: "step".into(),
        agent: "a".into(),
        model: doc(r#"{"providerID":"p","id":"m"}"#),
        route_id: "r".into(),
        prompt_cache_key: "k".into(),
        system_digest: "".into(),
        tool_digest: "".into(),
        request: count,
        attempts: -1,
        invalidation: "odd".into(),
        continuation: "odd".into(),
        cache_read_reported: Some(7),
        timing: None,
        cost: None,
        tokens: doc(r#"{"input":-1,"output":2,"reasoning":3,"cache":{"read":0,"write":0}}"#),
        time_created: i64::MIN,
        usage_anchor: None,
    }
}
fn usage() -> resources::Usage {
    resources::Usage {
        session_id: "s".into(),
        model_key: "p:m".into(),
        model: request("r", 0).model,
        logical: -1,
        physical: 2,
        helpers: 3,
        continued: 4,
        fallback: 5,
        cost: None,
        input: 6,
        output: 7,
        reasoning: 8,
        cache_read: 9,
        cache_write: 10,
    }
}
fn hash() -> LosslessString {
    "a".repeat(64).into()
}
fn blob() -> resources::StateBlob {
    resources::StateBlob {
        digest: hash(),
        provider: "p".into(),
        model_id: "m".into(),
        item_type: "opaque".into(),
        content: doc(r#"{"opaque":"\ud800\u0000","extra":null}"#),
        time_created: 0,
    }
}
fn link() -> resources::StateLink {
    resources::StateLink {
        session_id: "s".into(),
        message_id: "message".into(),
        part_ordinal: 0,
        part_kind: "reasoning".into(),
        provider: "p".into(),
        model_id: "m".into(),
        blob_digest: hash(),
        context_revision: 0,
        time_created: 0,
    }
}
fn continuation() -> resources::Continuation {
    resources::Continuation {
        session_id: "s".into(),
        response_id: "response".into(),
        represented_through_message_id: None,
        represented_message_count: 0,
        context_revision: 0,
        continuation_generation: 0,
        provider: "p".into(),
        route_id: "r".into(),
        model_id: "m".into(),
        variant: None,
        connection_identity_digest: hash(),
        prompt_cache_key: "k".into(),
        instructions_digest: hash(),
        tools_digest: hash(),
        options_digest: hash(),
        volatile_context_digest: hash(),
        continuation_fingerprint: hash(),
        time_updated: 0,
    }
}
fn seed(store: &Store) {
    store
        .submit(|tx| {
            project::ProjectTable::put(tx, &root())?;
            for id in ["s", "other"] {
                session::SessionTable::put(tx, &owner(id))?;
                session::RevisionTable::put(tx, &revision(id, 0))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}
fn store() -> Store {
    let store = Store::disposable(Options::core(), catalog(), Metadata::new([3; 16], 7)).unwrap();
    seed(&store);
    store
}

#[test]
fn resource_revision_and_session_cascades_remove_all_foreign_children() {
    let store = store();
    store
        .submit(|tx| {
            resources::StateBlobTable::put(tx, &blob())?;
            resources::StateLinkTable::put(tx, &link())?;
            resources::ContinuationGenerationTable::put(
                tx,
                &resources::ContinuationGeneration {
                    session_id: "s".into(),
                    generation: 0,
                    context_revision: 0,
                    time_updated: 0,
                },
            )?;
            resources::ContinuationTable::put(tx, &continuation())?;
            resources::RequestTable::put(tx, &request("request", 0))?;
            resources::UsageTable::put(tx, &usage())?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store
        .submit(|tx| session::delete_revision(tx, &"s".into(), 0))
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<resources::StateLinkTable>(&resources::StateLinkTable::primary_key(&link()))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<resources::ContinuationTable>(&tuple_key(&[KeyPart::String(&"s".into())]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<resources::ContinuationGenerationTable>(&tuple_key(&[KeyPart::String(
                &"s".into()
            )]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .get::<resources::StateBlobTable>(&tuple_key(&[KeyPart::String(&hash())]))
            .unwrap()
            .is_some()
    );
    assert!(
        snapshot
            .get::<resources::RequestTable>(&resources::RequestTable::primary_key(&request(
                "request", 0
            )))
            .unwrap()
            .is_some()
    );
    drop(snapshot);
    store
        .submit(|tx| session::delete(tx, &"s".into()))
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .scan::<resources::RequestTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .scan::<resources::UsageTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .get::<session::SessionTable>(&tuple_key(&[KeyPart::String(&"other".into())]))
            .unwrap()
            .is_some()
    );
}

fn credential() -> resources::Credential {
    resources::Credential {
        id: odd(),
        integration_id: None,
        label: "synthetic".into(),
        value: resources::Secret::new(
            parse_json(r#"{"type":"key","key":"synthetic-secret","extra":{"\ud800":"retained"}}"#)
                .unwrap(),
        )
        .unwrap(),
        connector_id: Some(odd()),
        method_id: None,
        active: Some(-3),
        generation: 0,
        account_generation: i64::MAX,
        time_created: i64::MIN,
        time_updated: i64::MAX,
    }
}
fn odd() -> LosslessString {
    LosslessString::from_utf16(vec![0, 0xd800, 0x61, 0xdc00])
}
fn latency(id: i64) -> resources::Latency {
    resources::Latency {
        id,
        received_at: i64::MIN,
        sample: doc(r#"{"kind":"long-task","at":"2026-10-11T00:00:00.000Z","durationMs":50}"#),
    }
}
fn consent(enabled: i64) -> resources::Consent {
    resources::Consent {
        id: 1,
        enabled,
        notice_version: 1,
        decided_at: 0,
    }
}
fn enable_capture(store: &Store) {
    store
        .submit(|tx| {
            let old = tx.get::<analytics::DeliveryTable>(&[])?;
            tx.put::<analytics::DeliveryTable>(&analytics::Delivery {
                identity: tx.metadata().database_identity,
                source_generation: tx.metadata().generation,
                generation: 1,
                order: old.as_ref().map_or(0, |s| s.order),
                applied: 0,
                valid: true,
                rebuilding: false,
                intents: 0,
                bytes: 0,
                privacy: old.as_ref().map_or(0, |s| s.privacy),
                purges: vec![],
                purge_all: false,
            })
        })
        .unwrap()
        .wait()
        .unwrap();
}
fn path(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ycoding-resource-{tag}-{}-{}.redb",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
fn contract<T: TableSpec>(
    record: T::Record,
    expected: Vec<u8>,
    keys: Vec<(&'static str, Vec<u8>)>,
    insert: fn(&mut ycoding_store::Write<'_>, &T::Record) -> Result<(), Error>,
) where
    T::Record: Clone + PartialEq + std::fmt::Debug + Send + 'static,
{
    assert_eq!(T::primary_key(&record), expected);
    assert_eq!(T::decode(&T::encode(&record).unwrap()).unwrap(), record);
    assert!(T::decode(&T::encode(&record).unwrap()[..1]).is_err());
    let mut trailing = T::encode(&record).unwrap();
    trailing.push(0);
    assert!(T::decode(&trailing).is_err());
    assert_eq!(T::INDEXES.len(), keys.len());
    for (name, logical) in &keys {
        assert_eq!(
            T::index_key(
                T::INDEXES.iter().find(|i| i.name == *name).unwrap(),
                &record
            )
            .unwrap(),
            Some(logical.clone())
        );
    }
    for durable in [false, true] {
        let file = path(T::NAME);
        let catalog = catalog();
        let store = if durable {
            Store::initialize(&file, Options::core(), catalog, Metadata::new([3; 16], 7)).unwrap()
        } else {
            Store::disposable(Options::core(), catalog, Metadata::new([3; 16], 7)).unwrap()
        };
        seed(&store);
        store
            .submit(|tx| resources::StateBlobTable::put(tx, &blob()))
            .unwrap()
            .wait()
            .unwrap();
        let row = record.clone();
        store
            .submit(move |tx| insert(tx, &row))
            .unwrap()
            .wait()
            .unwrap();
        let row = record.clone();
        assert!(matches!(
            store.submit(move |tx| insert(tx, &row)).unwrap().wait(),
            Err(Error::Domain {
                kind: "primary_key",
                ..
            })
        ));
        let snapshot = store.snapshot().unwrap();
        assert_eq!(snapshot.get::<T>(&expected).unwrap().unwrap(), record);
        for (name, logical) in &keys {
            assert_eq!(
                snapshot.index::<T>(name, logical, None, 10).unwrap(),
                vec![record.clone()]
            );
            assert!(
                snapshot
                    .index::<T>(name, &[0xff], None, 10)
                    .unwrap()
                    .is_empty()
            );
            assert!(
                snapshot
                    .index::<T>(name, logical, Some(&expected), 10)
                    .unwrap()
                    .is_empty()
            );
            assert!(
                snapshot
                    .index::<T>(name, logical, None, 0)
                    .unwrap()
                    .is_empty()
            );
        }
        let deleted = expected.clone();
        store
            .submit(move |tx| tx.delete::<T>(&deleted))
            .unwrap()
            .wait()
            .unwrap();
        let current = store.snapshot().unwrap();
        assert!(current.get::<T>(&expected).unwrap().is_none());
        for (name, logical) in &keys {
            assert!(
                current
                    .index::<T>(name, logical, None, 10)
                    .unwrap()
                    .is_empty()
            );
        }
        assert!(snapshot.get::<T>(&expected).unwrap().is_some());
        drop(current);
        let restored = record.clone();
        store
            .submit(move |tx| tx.put::<T>(&restored))
            .unwrap()
            .wait()
            .unwrap();
        drop(snapshot);
        if durable {
            store.shutdown().unwrap();
            let reopened = Store::open(&file, Options::core(), catalog).unwrap();
            assert_eq!(
                reopened
                    .snapshot()
                    .unwrap()
                    .get::<T>(&expected)
                    .unwrap()
                    .unwrap(),
                record
            );
            reopened.shutdown().unwrap();
            std::fs::remove_file(file).unwrap();
        } else {
            store.shutdown().unwrap();
        }
    }
}

#[test]
fn every_resource_primary_codec_and_index_matches_baseline_in_memory_and_reopen() {
    let key = |value: &LosslessString| tuple_key(&[KeyPart::String(value)]);
    contract::<resources::CredentialTable>(
        credential(),
        key(&odd()),
        vec![],
        resources::CredentialTable::insert,
    );
    contract::<resources::KvTable>(
        resources::Kv {
            key: odd(),
            value: doc(r#"{"\ud800":[null,false,-0,"\u0000\udfff"]}"#),
            time_created: i64::MIN,
            time_updated: i64::MAX,
        },
        key(&odd()),
        vec![],
        resources::KvTable::insert,
    );
    contract::<resources::ShellTable>(
        resources::Shell {
            id: odd(),
            session_id: Some("unknown-session".into()),
            pid: -1,
            process_started: None,
            owner_pid: i64::MIN,
            owner_started: odd(),
            notice_pending: 8,
            time_created: i64::MIN,
            time_lost: None,
            start_seq: -1,
        },
        key(&odd()),
        vec![],
        resources::ShellTable::insert,
    );
    contract::<resources::ConsentTable>(
        resources::Consent {
            id: 1,
            enabled: 7,
            notice_version: -1,
            decided_at: i64::MIN,
        },
        tuple_key(&[KeyPart::I64(1)]),
        vec![],
        resources::ConsentTable::insert,
    );
    contract::<resources::MigrationTable>(
        resources::Migration {
            name: odd(),
            time_completed: i64::MIN,
        },
        key(&odd()),
        vec![],
        resources::MigrationTable::insert,
    );
    contract::<resources::SequenceTable>(
        resources::Sequence {
            name: odd(),
            high_water: i64::MAX,
        },
        key(&odd()),
        vec![],
        resources::SequenceTable::insert,
    );
    contract::<resources::ContinuationGenerationTable>(
        resources::ContinuationGeneration {
            session_id: "s".into(),
            generation: 0,
            context_revision: 0,
            time_updated: 0,
        },
        key(&"s".into()),
        vec![],
        resources::ContinuationGenerationTable::insert,
    );
    contract::<resources::ContinuationTable>(
        continuation(),
        key(&"s".into()),
        vec![],
        resources::ContinuationTable::insert,
    );
    let mut b = blob();
    b.digest = "b".repeat(64).into();
    contract::<resources::StateBlobTable>(
        b.clone(),
        key(&b.digest),
        vec![],
        resources::StateBlobTable::insert,
    );
    contract::<resources::StateLinkTable>(
        link(),
        tuple_key(&[
            KeyPart::String(&"s".into()),
            KeyPart::String(&"message".into()),
            KeyPart::I64(0),
            KeyPart::String(&"reasoning".into()),
        ]),
        vec![
            ("session_provider_state_link_blob_idx", key(&hash())),
            (
                "session_provider_state_link_revision_idx",
                tuple_key(&[KeyPart::String(&"s".into()), KeyPart::I64(0)]),
            ),
        ],
        resources::StateLinkTable::insert,
    );
    contract::<resources::RequestTable>(
        request("request", -6),
        key(&"request".into()),
        vec![
            (
                "session_provider_request_session_request_idx",
                tuple_key(&[KeyPart::String(&"s".into()), KeyPart::I64(-6)]),
            ),
            (
                "session_provider_request_session_source_idx",
                tuple_key(&[
                    KeyPart::String(&"s".into()),
                    KeyPart::String(&"step".into()),
                ]),
            ),
        ],
        resources::RequestTable::insert,
    );
    let mut u = usage();
    u.model_key = odd();
    contract::<resources::UsageTable>(
        u,
        tuple_key(&[KeyPart::String(&"s".into()), KeyPart::String(&odd())]),
        vec![],
        resources::UsageTable::insert,
    );
    contract::<resources::LatencyTable>(
        latency(i64::MIN),
        tuple_key(&[KeyPart::I64(i64::MIN)]),
        vec![(
            "web_latency_received_at_idx",
            tuple_key(&[KeyPart::I64(i64::MIN)]),
        )],
        resources::LatencyTable::insert,
    );
}

#[test]
fn kv_preserves_creation_and_distinguishes_absence_from_json_null() {
    let store = store();
    store
        .submit(|tx| resources::set_kv(tx, &odd(), &doc("false"), -4))
        .unwrap()
        .wait()
        .unwrap();
    store
        .submit(|tx| resources::set_kv(tx, &odd(), &doc("null"), i64::MAX))
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        resources::get_kv(&snapshot, &odd())
            .unwrap()
            .unwrap()
            .value(),
        &JsonValue::Null
    );
    let row = snapshot
        .get::<resources::KvTable>(&tuple_key(&[KeyPart::String(&odd())]))
        .unwrap()
        .unwrap();
    assert_eq!(row.time_created, -4);
    assert_eq!(row.time_updated, i64::MAX);
    assert!(
        resources::get_kv(&snapshot, &"missing".into())
            .unwrap()
            .is_none()
    );
    store
        .submit(|tx| resources::remove_kv(tx, &odd()))
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        resources::get_kv(&store.snapshot().unwrap(), &odd())
            .unwrap()
            .is_none()
    );
    assert!(resources::get_kv(&snapshot, &odd()).unwrap().is_some());
}

#[test]
fn provider_request_uniqueness_lookup_and_intents_commit_or_rollback_together() {
    let store = store();
    enable_capture(&store);
    store
        .submit(|tx| {
            resources::RequestTable::insert(tx, &request("one", -1))?;
            resources::UsageTable::put(tx, &usage())
        })
        .unwrap()
        .wait()
        .unwrap();
    let before = store.snapshot().unwrap();
    let state = before
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert_eq!(state.intents, 2);
    let intents = before
        .scan::<analytics::IntentTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(intents.len(), 2);
    assert!(intents.iter().all(|i| !i.delete && i.generation == 1));
    assert_eq!(
        resources::request_by_number(&before, &"s".into(), -1)
            .unwrap()
            .unwrap(),
        request("one", -1)
    );
    let failed = store
        .submit(|tx| {
            let mut u = usage();
            u.reasoning = 999;
            resources::UsageTable::put(tx, &u)?;
            let error = resources::RequestTable::insert(tx, &request("two", -1)).unwrap_err();
            assert!(matches!(
                error,
                Error::UniqueViolation {
                    index: "session_provider_request_session_request_idx"
                }
            ));
            Ok(())
        })
        .unwrap()
        .wait();
    assert!(matches!(failed, Err(Error::TransactionAborted)));
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .get::<analytics::DeliveryTable>(&[])
            .unwrap()
            .unwrap(),
        state
    );
    assert_eq!(
        snapshot
            .get::<resources::UsageTable>(&resources::UsageTable::primary_key(&usage()))
            .unwrap()
            .unwrap(),
        usage()
    );
    assert_eq!(
        snapshot
            .scan::<analytics::IntentTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap(),
        intents
    );
    assert!(
        snapshot
            .get::<resources::RequestTable>(&tuple_key(&[KeyPart::String(&"two".into())]))
            .unwrap()
            .is_none()
    );
    drop(snapshot);
    assert!(
        store
            .submit(|tx| {
                resources::RequestTable::put(tx, &request("three", 5))?;
                Err::<(), Error>(Error::Rejected("rollback"))
            })
            .unwrap()
            .wait()
            .is_err()
    );
    store
        .submit(|tx| {
            let mut foreign = request("foreign", -1);
            foreign.session_id = "other".into();
            resources::RequestTable::insert(tx, &foreign)?;
            resources::RequestTable::put(tx, &request("later", 3))
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let rows = resources::requests(
        &snapshot,
        &"s".into(),
        ycoding_store::IndexOrder::Descending,
        None,
        1,
    )
    .unwrap();
    assert_eq!(rows[0].record.id, LosslessString::from("later"));
    assert_eq!(
        resources::requests(
            &snapshot,
            &"s".into(),
            ycoding_store::IndexOrder::Descending,
            Some(&rows[0].cursor),
            1
        )
        .unwrap()[0]
            .record
            .id,
        LosslessString::from("one")
    );
    store
        .submit(|tx| {
            resources::RequestTable::delete(tx, &tuple_key(&[KeyPart::String(&"one".into())]))
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        resources::request_by_number(&snapshot, &"s".into(), -1)
            .unwrap()
            .is_none()
    );
    let delete = snapshot
        .get::<analytics::IntentTable>(&tuple_key(&[
            KeyPart::Bytes(b"session_provider_request"),
            KeyPart::Bytes(&tuple_key(&[KeyPart::String(&"one".into())])),
        ]))
        .unwrap()
        .unwrap();
    assert!(delete.delete);
    assert!(delete.order > state.order);
    assert!(
        resources::request_by_number(&before, &"s".into(), -1)
            .unwrap()
            .is_some()
    );
}

#[test]
fn provider_blob_restrict_capture_upsert_and_rebase_preserve_shared_content() {
    let store = store();
    store
        .submit(|tx| {
            resources::capture_state(tx, &blob(), &link())?;
            let mut duplicate = blob();
            duplicate.content = doc("null");
            resources::capture_state(tx, &duplicate, &link())?;
            let mut other = link();
            other.session_id = "other".into();
            resources::StateLinkTable::put(tx, &other)?;
            assert_eq!(resources::state_blob_references(tx, &hash())?, 2);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<resources::StateBlobTable>(&tuple_key(&[KeyPart::String(&hash())]))
            .unwrap()
            .unwrap()
            .content,
        blob().content
    );
    assert!(matches!(
        store
            .submit(|tx| {
                resources::set_kv(tx, &"rollback".into(), &doc("true"), 0)?;
                let _ = resources::delete_state_blob(tx, &hash());
                Ok(())
            })
            .unwrap()
            .wait(),
        Err(Error::Domain {
            kind: "foreign_restrict",
            ..
        })
    ));
    assert!(
        resources::get_kv(&store.snapshot().unwrap(), &"rollback".into())
            .unwrap()
            .is_none()
    );
    store
        .submit(|tx| {
            let mut new = blob();
            new.digest = "b".repeat(64).into();
            let mut updated = link();
            updated.blob_digest = new.digest.clone();
            resources::capture_state(tx, &new, &updated)?;
            assert_eq!(resources::state_blob_references(tx, &hash())?, 1);
            assert_eq!(resources::state_blob_references(tx, &new.digest)?, 1);
            session::MessageTable::put(
                tx,
                &session::Message {
                    id: "message".into(),
                    session_id: "s".into(),
                    type_: "assistant".into(),
                    seq: -5,
                    time_created: 0,
                    time_updated: 0,
                    data: JsonValue::Null,
                },
            )?;
            resources::rebase_state(tx, &"s".into(), -6)?;
            assert_eq!(resources::state_blob_references(tx, &new.digest)?, 1);
            resources::rebase_state(tx, &"s".into(), -5)?;
            assert_eq!(resources::state_blob_references(tx, &new.digest)?, 0);
            assert!(resources::delete_state_blob(tx, &new.digest)?);
            session::delete(tx, &"other".into())?;
            assert_eq!(resources::state_blob_references(tx, &hash())?, 0);
            assert!(resources::delete_state_blob(tx, &hash())?);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[test]
fn continuation_generation_and_revision_cascades_are_atomic() {
    let store = store();
    store
        .submit(|tx| {
            assert!(resources::remember_continuation(tx, &continuation())?);
            let current = resources::invalidate_continuation(tx, &"s".into(), 0, 1)?;
            assert_eq!(current.generation, 1);
            assert!(!resources::remember_continuation(tx, &continuation())?);
            let mut next = continuation();
            next.continuation_generation = 1;
            assert!(resources::remember_continuation(tx, &next)?);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .submit(|tx| {
                resources::invalidate_continuation(tx, &"s".into(), 99, 2)?;
                Ok(())
            })
            .unwrap()
            .wait()
            .is_err()
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .get::<resources::ContinuationGenerationTable>(&tuple_key(&[KeyPart::String(
                &"s".into()
            )]))
            .unwrap()
            .unwrap()
            .generation,
        1
    );
    store
        .submit(|tx| {
            resources::ContinuationGenerationTable::put(
                tx,
                &resources::ContinuationGeneration {
                    session_id: "s".into(),
                    generation: i64::MAX,
                    context_revision: 0,
                    time_updated: 0,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .submit(|tx| {
                let _ = resources::invalidate_continuation(tx, &"s".into(), 0, 2);
                Ok(())
            })
            .unwrap()
            .wait()
            .is_err()
    );
    assert!(
        store
            .snapshot()
            .unwrap()
            .get::<resources::ContinuationTable>(&tuple_key(&[KeyPart::String(&"s".into())]))
            .unwrap()
            .is_some()
    );
}

#[test]
fn consent_fences_retained_sources_and_purge_in_the_same_commit() {
    let file = path("privacy");
    let catalog = catalog();
    let store =
        Store::initialize(&file, Options::core(), catalog, Metadata::new([3; 16], 7)).unwrap();
    seed(&store);
    assert!(!resources::telemetry_allowed(&store.snapshot().unwrap(), &[]).unwrap());
    store
        .submit(|tx| resources::ConsentTable::put(tx, &consent(1)))
        .unwrap()
        .wait()
        .unwrap();
    enable_capture(&store);
    store
        .submit(|tx| {
            resources::LatencyTable::put(tx, &latency(1))?;
            let mut r = request("one", 0);
            r.timing = Some(doc("{}"));
            resources::RequestTable::put(tx, &r)
        })
        .unwrap()
        .wait()
        .unwrap();
    let old = store.snapshot().unwrap();
    resources::require_telemetry_report(&old).unwrap();
    let before = old.get::<analytics::DeliveryTable>(&[]).unwrap().unwrap();
    assert_eq!(before.intents, 2);
    assert!(
        store
            .submit(|tx| {
                resources::ConsentTable::put(tx, &consent(0))?;
                Err::<(), Error>(Error::Rejected("rollback"))
            })
            .unwrap()
            .wait()
            .is_err()
    );
    resources::require_telemetry_report(&store.snapshot().unwrap()).unwrap();
    store
        .submit(|tx| resources::ConsentTable::put(tx, &consent(0)))
        .unwrap()
        .wait()
        .unwrap();
    let current = store.snapshot().unwrap();
    assert!(resources::require_telemetry_report(&current).is_err());
    let state = current
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(!state.valid);
    assert!(state.privacy > before.privacy);
    assert!(
        current
            .get::<resources::LatencyTable>(&tuple_key(&[KeyPart::I64(1)]))
            .unwrap()
            .is_some()
    );
    assert!(
        resources::request_by_number(&current, &"s".into(), 0)
            .unwrap()
            .is_some()
    );
    drop(current);
    store
        .submit(|tx| {
            resources::ConsentTable::put(tx, &consent(1))?;
            resources::purge_telemetry(tx)
        })
        .unwrap()
        .wait()
        .unwrap();
    let current = store.snapshot().unwrap();
    assert!(resources::telemetry_allowed(&current, &[]).unwrap());
    assert!(resources::require_telemetry_report(&current).is_err());
    assert!(
        current
            .scan::<resources::LatencyTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        resources::request_by_number(&current, &"s".into(), 0)
            .unwrap()
            .unwrap()
            .timing
            .is_none()
    );
    let state = current
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert_eq!(state.purges, vec![Vec::<u8>::new()]);
    drop(current);
    drop(old);
    store.shutdown().unwrap();
    let reopened = Store::open(&file, Options::core(), catalog).unwrap();
    assert!(resources::require_telemetry_report(&reopened.snapshot().unwrap()).is_err());
    reopened.shutdown().unwrap();
    std::fs::remove_file(file).unwrap();
}

#[test]
fn project_and_session_reporting_metadata_changes_have_atomic_delivery_intents() {
    let store = store();
    enable_capture(&store);
    store
        .submit(|tx| {
            let mut p = root();
            p.name = Some(odd());
            project::ProjectTable::put(tx, &p)?;
            let mut s = owner("s");
            s.title = odd();
            session::SessionTable::put(tx, &s)
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let intents = snapshot
        .scan::<analytics::IntentTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(
        intents
            .iter()
            .map(|i| i.source.as_str())
            .collect::<Vec<_>>(),
        vec!["project", "session"]
    );
    assert!(intents.iter().all(|i| !i.delete));
    drop(snapshot);
    store
        .submit(|tx| project::delete(tx, &"p".into()))
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .get::<project::ProjectTable>(&tuple_key(&[KeyPart::String(&"p".into())]))
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .scan::<analytics::IntentTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .iter()
            .all(|i| i.delete)
    );
}

fn rejects_check<T: TableSpec>(row: T::Record, name: &'static str)
where
    T::Record: Send + 'static,
{
    let store = store();
    let result = store
        .submit(move |tx| {
            resources::set_kv(tx, &"rollback".into(), &doc("true"), 0)?;
            let error = tx.put::<T>(&row).unwrap_err();
            assert!(
                matches!(error,Error::Domain{kind:"check",message} if message==name),
                "{error:?}"
            );
            Ok(())
        })
        .unwrap()
        .wait();
    assert!(result.is_err());
    assert!(
        resources::get_kv(&store.snapshot().unwrap(), &"rollback".into())
            .unwrap()
            .is_none()
    );
}

#[test]
fn resource_checks_and_secret_nonexposure() {
    let mut c = credential();
    c.generation = -1;
    rejects_check::<resources::CredentialTable>(c, "credential_generation_check");
    let mut c = credential();
    c.account_generation = -1;
    rejects_check::<resources::CredentialTable>(c, "credential_account_generation_check");
    let mut c = consent(1);
    c.id = 2;
    rejects_check::<resources::ConsentTable>(c, "telemetry_consent_single_row");
    let g = resources::ContinuationGeneration {
        session_id: "s".into(),
        generation: 0,
        context_revision: 0,
        time_updated: 0,
    };
    for n in 0..3 {
        let mut row = g.clone();
        let check = match n {
            0 => {
                row.generation = -1;
                "session_provider_continuation_generation_counts_check"
            }
            1 => {
                row.context_revision = -1;
                "session_provider_continuation_generation_revision_check"
            }
            _ => {
                row.time_updated = -1;
                "session_provider_continuation_generation_time_check"
            }
        };
        rejects_check::<resources::ContinuationGenerationTable>(row, check);
    }
    let mut c = continuation();
    c.response_id = "\0ignored".into();
    rejects_check::<resources::ContinuationTable>(
        c,
        "session_provider_continuation_response_check",
    );
    let mut c = continuation();
    c.represented_through_message_id = Some("message".into());
    rejects_check::<resources::ContinuationTable>(
        c,
        "session_provider_continuation_boundary_check",
    );
    let mut c = continuation();
    c.represented_message_count = -1;
    rejects_check::<resources::ContinuationTable>(
        c,
        "session_provider_continuation_boundary_check",
    );
    for n in 0..2 {
        let mut c = continuation();
        if n == 0 {
            c.context_revision = -1;
        } else {
            c.continuation_generation = -1;
        }
        rejects_check::<resources::ContinuationTable>(
            c,
            "session_provider_continuation_counts_check",
        );
    }
    for n in 0..5 {
        let mut c = continuation();
        match n {
            0 => c.provider = "".into(),
            1 => c.route_id = "".into(),
            2 => c.model_id = "".into(),
            3 => c.variant = Some("".into()),
            _ => c.prompt_cache_key = "".into(),
        };
        rejects_check::<resources::ContinuationTable>(
            c,
            "session_provider_continuation_identity_check",
        );
    }
    for n in 0..6 {
        let mut c = continuation();
        let invalid = "A".repeat(64).into();
        match n {
            0 => c.connection_identity_digest = invalid,
            1 => c.instructions_digest = invalid,
            2 => c.tools_digest = invalid,
            3 => c.options_digest = invalid,
            4 => c.volatile_context_digest = invalid,
            _ => c.continuation_fingerprint = invalid,
        };
        rejects_check::<resources::ContinuationTable>(
            c,
            "session_provider_continuation_digest_check",
        );
    }
    let mut c = continuation();
    c.time_updated = -1;
    rejects_check::<resources::ContinuationTable>(c, "session_provider_continuation_time_check");
    let mut b = blob();
    b.digest = "a".repeat(63).into();
    rejects_check::<resources::StateBlobTable>(b, "session_provider_state_blob_digest_check");
    for n in 0..3 {
        let mut b = blob();
        match n {
            0 => b.provider = "".into(),
            1 => b.model_id = "".into(),
            _ => b.item_type = "".into(),
        };
        rejects_check::<resources::StateBlobTable>(b, "session_provider_state_blob_identity_check");
    }
    let mut b = blob();
    b.time_created = -1;
    rejects_check::<resources::StateBlobTable>(b, "session_provider_state_blob_time_check");
    assert!(
        session::Document::<ycoding_schema::domain::Json>::new(JsonValue::Number(f64::INFINITY))
            .is_err()
    );
    for n in 0..8 {
        let mut l = link();
        let name = match n {
            0 => {
                l.message_id = "".into();
                "session_provider_state_link_message_check"
            }
            1 => {
                l.part_ordinal = -1;
                "session_provider_state_link_ordinal_check"
            }
            2 => {
                l.part_kind = "".into();
                "session_provider_state_link_identity_check"
            }
            3 => {
                l.provider = "".into();
                "session_provider_state_link_identity_check"
            }
            4 => {
                l.model_id = "".into();
                "session_provider_state_link_identity_check"
            }
            5 => {
                l.blob_digest = "wrong".into();
                "session_provider_state_link_blob_check"
            }
            6 => {
                l.context_revision = -1;
                "session_provider_state_link_revision_check"
            }
            _ => {
                l.time_created = -1;
                "session_provider_state_link_time_check"
            }
        };
        rejects_check::<resources::StateLinkTable>(l, name);
    }
    let c = credential();
    assert!(!format!("{c:?}").contains("synthetic-secret"));
    assert!(!format!("{}", c.value).contains("synthetic-secret"));
    assert_eq!(
        resources::CredentialTable::decode(&resources::CredentialTable::encode(&c).unwrap())
            .unwrap()
            .value
            .value(),
        c.value.value()
    );
    let error = resources::Secret::new(
        parse_json(r#"{"type":"synthetic-secret","key":"synthetic-secret"}"#).unwrap(),
    )
    .unwrap_err();
    assert!(!format!("{error:?} {error}").contains("synthetic-secret"));
    let bytes = resources::CredentialTable::encode(&c).unwrap();
    for size in 1..bytes.len() {
        if let Err(error) = resources::CredentialTable::decode(&bytes[..size]) {
            assert!(!format!("{error:?} {error}").contains("synthetic-secret"));
        }
    }
}

#[test]
fn provider_check_null_truth_and_nul_length_match_the_baseline_sql() {
    let sqlite = rusqlite::Connection::open_in_memory().unwrap();
    let null_truth: Option<bool> = sqlite
        .query_row(
            "SELECT (?1 = 0 AND ?2 IS NULL) OR (?1 > 0 AND length(?2) > 0)",
            rusqlite::params![1, None::<String>],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(null_truth, None);
    let store = store();
    store
        .submit(|tx| {
            let mut c = continuation();
            c.represented_message_count = 1;
            resources::ContinuationTable::put(tx, &c)
        })
        .unwrap()
        .wait()
        .unwrap();
    let padded = format!("{}\0retained", "a".repeat(64));
    let digest_valid: bool = sqlite
        .query_row(
            "SELECT length(?1) = 64 AND ?1 NOT GLOB '*[^0-9a-f]*'",
            [&padded],
            |row| row.get(0),
        )
        .unwrap();
    assert!(digest_valid);
    let padded = resources::StateBlob {
        digest: padded.into(),
        ..blob()
    };
    let bytes = resources::StateBlobTable::encode(&padded).unwrap();
    assert_eq!(resources::StateBlobTable::decode(&bytes).unwrap(), padded);
    let zero_length: i64 = sqlite
        .query_row("SELECT length(?1)", ["\0retained"], |row| row.get(0))
        .unwrap();
    assert_eq!(zero_length, 0);
}

#[test]
fn every_provider_foreign_reference_is_checked_in_the_same_write_view() {
    let store = store();
    let missing = LosslessString::from("missing");
    for n in 0..9 {
        let missing = missing.clone();
        let result = store
            .submit(move |tx| {
                resources::set_kv(tx, &"rollback".into(), &doc("true"), 0)?;
                let result = match n {
                    0 | 1 => resources::ContinuationGenerationTable::put(
                        tx,
                        &resources::ContinuationGeneration {
                            session_id: if n == 0 { missing.clone() } else { "s".into() },
                            generation: 0,
                            context_revision: if n == 0 { 0 } else { 99 },
                            time_updated: 0,
                        },
                    ),
                    2 | 3 => {
                        let mut r = continuation();
                        if n == 2 {
                            r.session_id = missing.clone();
                        } else {
                            r.context_revision = 99;
                        }
                        resources::ContinuationTable::put(tx, &r)
                    }
                    4..=6 => {
                        let mut r = link();
                        match n {
                            4 => r.session_id = missing.clone(),
                            5 => r.context_revision = 99,
                            _ => r.blob_digest = "b".repeat(64).into(),
                        };
                        resources::StateLinkTable::put(tx, &r)
                    }
                    7 => {
                        let mut r = request("request", 0);
                        r.session_id = missing.clone();
                        resources::RequestTable::put(tx, &r)
                    }
                    _ => {
                        let mut r = usage();
                        r.session_id = missing.clone();
                        resources::UsageTable::put(tx, &r)
                    }
                };
                assert!(matches!(
                    result,
                    Err(Error::Domain {
                        kind: "foreign_reference",
                        ..
                    })
                ));
                Ok(())
            })
            .unwrap()
            .wait();
        assert!(result.is_err());
        assert!(
            resources::get_kv(&store.snapshot().unwrap(), &"rollback".into())
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn provider_link_counts_rebase_and_nonunique_indexes_cross_page_boundaries() {
    let store = store();
    store
        .submit(|tx| {
            resources::StateBlobTable::put(tx, &blob())?;
            for n in 0..130 {
                let mut l = link();
                l.message_id = format!("message-{n:03}").into();
                resources::StateLinkTable::put(tx, &l)?;
                session::MessageTable::put(
                    tx,
                    &session::Message {
                        id: l.message_id,
                        session_id: "s".into(),
                        type_: "assistant".into(),
                        seq: n,
                        time_created: 0,
                        time_updated: 0,
                        data: JsonValue::Null,
                    },
                )?;
            }
            assert_eq!(resources::state_blob_references(tx, &hash())?, 130);
            for id in [-2, -1, 0] {
                resources::LatencyTable::put(tx, &latency(id))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let first = snapshot
        .index::<resources::LatencyTable>(
            "web_latency_received_at_idx",
            &tuple_key(&[KeyPart::I64(i64::MIN)]),
            None,
            2,
        )
        .unwrap();
    assert_eq!(first.iter().map(|r| r.id).collect::<Vec<_>>(), vec![-2, -1]);
    assert_eq!(
        snapshot
            .index::<resources::LatencyTable>(
                "web_latency_received_at_idx",
                &tuple_key(&[KeyPart::I64(i64::MIN)]),
                Some(&resources::LatencyTable::primary_key(&first[1])),
                2
            )
            .unwrap()[0]
            .id,
        0
    );
    store
        .submit(|tx| {
            resources::rebase_state(tx, &"s".into(), 128)?;
            assert_eq!(resources::state_blob_references(tx, &hash())?, 1);
            session::delete(tx, &"s".into())?;
            assert_eq!(resources::state_blob_references(tx, &hash())?, 0);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        snapshot
            .index::<resources::StateLinkTable>(
                "session_provider_state_link_blob_idx",
                &tuple_key(&[KeyPart::String(&hash())]),
                None,
                131
            )
            .unwrap()
            .len(),
        130
    );
}

#[test]
fn caught_analytics_counter_failure_rolls_back_earlier_canonical_changes() {
    for privacy in [false, true] {
        let store = store();
        enable_capture(&store);
        store
            .submit(move |tx| {
                let mut state = tx.get::<analytics::DeliveryTable>(&[])?.unwrap();
                if privacy {
                    state.privacy = u64::MAX;
                } else {
                    state.order = u64::MAX;
                }
                tx.put::<analytics::DeliveryTable>(&state)
            })
            .unwrap()
            .wait()
            .unwrap();
        let result = store
            .submit(move |tx| {
                resources::set_kv(tx, &"rollback".into(), &doc("true"), 0)?;
                let failure = if privacy {
                    analytics::privacy_changed(tx, vec![], false)
                } else {
                    analytics::record(
                        tx,
                        analytics::Change {
                            source: "test_source",
                            identity: vec![1],
                            delete: false,
                        },
                    )
                };
                assert!(failure.is_err());
                Ok(())
            })
            .unwrap()
            .wait();
        assert!(result.is_err());
        assert!(
            resources::get_kv(&store.snapshot().unwrap(), &"rollback".into())
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn saved_permission_conflicts_preserve_first_record_and_parent_safety() {
    let store = store();
    store
        .submit(|tx| {
            let first = project::Permission {
                id: "first".into(),
                project_id: "p".into(),
                action: odd(),
                resource: odd(),
                time_created: -1,
                time_updated: i64::MAX,
            };
            assert!(resources::save_permission(tx, &first)?);
            assert!(!resources::save_permission(
                tx,
                &project::Permission {
                    id: "second".into(),
                    ..first.clone()
                }
            )?);
            assert!(!resources::save_permission(
                tx,
                &project::Permission {
                    action: "changed".into(),
                    ..first
                }
            )?);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .scan::<project::PermissionTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .submit(|tx| resources::save_permission(
                tx,
                &project::Permission {
                    id: "invalid".into(),
                    project_id: "missing".into(),
                    action: "a".into(),
                    resource: "r".into(),
                    time_created: 0,
                    time_updated: 0
                }
            ))
            .unwrap()
            .wait()
            .is_err()
    );
}

#[test]
fn remaining_resource_catalog_has_every_baseline_table() {
    let names: Vec<_> = ycoding_store::resources::TABLES
        .iter()
        .map(|table| table.name)
        .collect();
    for name in [
        "credential",
        "kv",
        "shell",
        "telemetry_consent",
        "data_migration",
        "session_provider_continuation_generation",
        "session_provider_continuation",
        "session_provider_state_blob",
        "session_provider_state_link",
        "session_provider_request",
        "session_usage",
        "web_latency",
        "resource_sequence",
    ] {
        assert!(names.contains(&name), "missing baseline table: {name}");
    }
}

#[test]
fn latency_explicit_ids_advance_the_persisted_high_water_mark() {
    let store = store();
    store
        .submit(|tx| resources::LatencyTable::insert(tx, &latency(14)))
        .unwrap()
        .wait()
        .unwrap();
    let counter = store
        .snapshot()
        .unwrap()
        .get::<resources::SequenceTable>(&tuple_key(&[KeyPart::String(&"web_latency".into())]))
        .unwrap();
    assert_eq!(counter.unwrap().high_water, 14);
}

#[test]
fn latency_autoincrement_never_reuses_deleted_ids_and_preserves_retention_order_on_reopen() {
    let file = path("allocation");
    let catalog = catalog();
    let store =
        Store::initialize(&file, Options::core(), catalog, Metadata::new([3; 16], 7)).unwrap();
    seed(&store);
    enable_capture(&store);
    store
        .submit(|tx| {
            let first = resources::append_latency(tx, 0, &latency(0).sample)?;
            assert_eq!(first.id, 1);
            resources::LatencyTable::delete(tx, &resources::LatencyTable::primary_key(&first))?;
            let second = resources::append_latency(tx, -1, &latency(0).sample)?;
            assert_eq!(second.id, 2);
            resources::LatencyTable::insert(tx, &latency(14))?;
            let third = resources::append_latency(tx, i64::MIN, &latency(0).sample)?;
            assert_eq!(third.id, 15);
            let retained = tx.scan::<resources::LatencyTable>(
                Bound::Unbounded,
                Bound::Excluded(&tuple_key(&[KeyPart::I64(15)])),
                128,
            )?;
            assert_eq!(
                retained.iter().map(|r| r.id).collect::<Vec<_>>(),
                vec![2, 14]
            );
            for row in retained {
                resources::LatencyTable::delete(tx, &resources::LatencyTable::primary_key(&row))?;
            }
            assert_eq!(resources::append_latency(tx, 1, &latency(0).sample)?.id, 16);
            assert_eq!(resources::seed_latency_sequence(tx, 100)?, 100);
            assert_eq!(resources::seed_latency_sequence(tx, 3)?, 100);
            tx.put::<resources::LatencyTable>(&latency(200))?;
            assert_eq!(
                resources::append_latency(tx, 1, &latency(0).sample)?.id,
                201
            );
            resources::purge_telemetry(tx)?;
            assert!(
                tx.scan::<resources::LatencyTable>(Bound::Unbounded, Bound::Unbounded, 1)?
                    .is_empty()
            );
            assert_eq!(
                tx.get::<resources::SequenceTable>(&tuple_key(&[KeyPart::String(
                    &"web_latency".into()
                )]))?
                .unwrap()
                .high_water,
                201
            );
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let reopened = Store::open(&file, Options::core(), catalog).unwrap();
    let next = reopened
        .submit(|tx| resources::append_latency(tx, 0, &latency(0).sample))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(next.id, 202);
    reopened.shutdown().unwrap();
    std::fs::remove_file(file).unwrap();
}

#[test]
fn latency_counter_sample_and_intent_rollback_together_and_overflow_latches() {
    let store = store();
    enable_capture(&store);
    let before = store
        .snapshot()
        .unwrap()
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(
        store
            .submit(|tx| {
                resources::append_latency(tx, 0, &latency(0).sample)?;
                Err::<(), Error>(Error::Rejected("rollback"))
            })
            .unwrap()
            .wait()
            .is_err()
    );
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .scan::<resources::LatencyTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    assert!(
        snapshot
            .get::<resources::SequenceTable>(&tuple_key(&[KeyPart::String(&"web_latency".into())]))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        snapshot
            .get::<analytics::DeliveryTable>(&[])
            .unwrap()
            .unwrap(),
        before
    );
    drop(snapshot);
    let first = store
        .submit(|tx| resources::append_latency(tx, 0, &latency(0).sample))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(first.id, 1);
    let snapshot = store.snapshot().unwrap();
    let intent = snapshot
        .get::<analytics::IntentTable>(&tuple_key(&[
            KeyPart::Bytes(b"web_latency"),
            KeyPart::Bytes(&resources::LatencyTable::primary_key(&first)),
        ]))
        .unwrap()
        .unwrap();
    assert!(!intent.delete);
    drop(snapshot);
    store
        .submit(|tx| {
            resources::seed_latency_sequence(tx, i64::MAX)?;
            resources::purge_telemetry(tx)
        })
        .unwrap()
        .wait()
        .unwrap();
    let before = store
        .snapshot()
        .unwrap()
        .get::<analytics::DeliveryTable>(&[])
        .unwrap()
        .unwrap();
    assert!(
        store
            .submit(|tx| {
                resources::set_kv(tx, &"rollback".into(), &doc("true"), 0)?;
                let failure = resources::append_latency(tx, 0, &latency(0).sample);
                assert!(matches!(
                    failure,
                    Err(Error::Rejected("latency sequence exhausted"))
                ));
                Ok(())
            })
            .unwrap()
            .wait()
            .is_err()
    );
    let snapshot = store.snapshot().unwrap();
    assert!(
        resources::get_kv(&snapshot, &"rollback".into())
            .unwrap()
            .is_none()
    );
    assert!(
        snapshot
            .scan::<resources::LatencyTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        snapshot
            .get::<analytics::DeliveryTable>(&[])
            .unwrap()
            .unwrap(),
        before
    );
    assert_eq!(
        snapshot
            .get::<resources::SequenceTable>(&tuple_key(&[KeyPart::String(&"web_latency".into())]))
            .unwrap()
            .unwrap()
            .high_water,
        i64::MAX
    );
}
