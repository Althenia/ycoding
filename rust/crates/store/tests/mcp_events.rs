use std::ops::Bound;
use ycoding_schema::LosslessString;
use ycoding_store::{
    IndexDefinition, IndexOrder, IndexQuery, KeyPart, Metadata, Options, Store, TableSpec,
    import::{self, DatabaseKind},
    mcp_events::{Outbox, OutboxTable, Subscription, SubscriptionTable, next_sequence},
    tuple_key,
};

fn s(value: &str) -> LosslessString {
    value.into()
}

fn store() -> Store {
    Store::disposable(
        Options::core(),
        import::catalog(DatabaseKind::Core),
        Metadata::new([83; 16], 1),
    )
    .unwrap()
}

fn subscription(id: &str) -> Subscription {
    Subscription {
        id: s(id),
        identity_hash: s(&format!(
            "{:064x}",
            id.bytes().fold(0u64, |value, byte| value
                .wrapping_mul(31)
                .wrapping_add(u64::from(byte)))
        )),
        owner_id: s("owner-synthetic"),
        device_id: s("device-synthetic"),
        client_id: s("client-synthetic"),
        grant_id: s("grant-synthetic"),
        epoch: s("epoch-synthetic"),
        name: s("session.progress"),
        session_id: s("ses_synthetic"),
        include_descendants: 0,
        callback_url: s("https://callback.invalid/events"),
        secret_ciphertext: s("opaque-synthetic-ciphertext"),
        secret_fingerprint: s(&"a".repeat(64)),
        previous_secret_ciphertext: None,
        previous_secret_until: None,
        expires_at: 100_000,
        disabled: 0,
        pruned_through: 0,
        time_created: 10,
        time_updated: 20,
    }
}

fn outbox(seq: i64, subscription_id: &str) -> Outbox {
    Outbox {
        seq,
        id: s(&format!("evt_{seq}")),
        subscription_id: s(subscription_id),
        dedupe_key: s(&format!(
            "{subscription_id}:session.progress:source-{seq}:running"
        )),
        name: s("session.progress"),
        session_id: s("ses_synthetic_child"),
        root_session_id: s("ses_synthetic"),
        state: s("running"),
        request_id: None,
        item_id: None,
        task_id: None,
        category: None,
        reason: None,
        time_created: 100,
        attempts: 0,
        next_attempt_at: 100,
        delivered_at: None,
        dead: 0,
    }
}

fn query(prefix: &[u8], limit: usize) -> IndexQuery<'_> {
    IndexQuery {
        lower: Bound::Unbounded,
        upper: Bound::Unbounded,
        prefix: Some(prefix),
        order: IndexOrder::Ascending,
        after: None,
        limit,
    }
}

#[test]
fn exact_released_table_and_index_declarations_join_only_the_core_catalog() {
    assert_eq!(SubscriptionTable::NAME, "mcp_event_subscription");
    assert_eq!(OutboxTable::NAME, "mcp_event_outbox");
    assert_eq!(
        SubscriptionTable::INDEXES,
        &[
            IndexDefinition::unique("mcp_event_subscription_identity_idx"),
            IndexDefinition::secondary("mcp_event_subscription_session_idx"),
            IndexDefinition::secondary("mcp_event_subscription_expiry_idx"),
        ]
    );
    assert_eq!(
        OutboxTable::INDEXES,
        &[
            IndexDefinition::unique("mcp_event_outbox_id_idx"),
            IndexDefinition::unique("mcp_event_outbox_dedupe_idx"),
            IndexDefinition::secondary("mcp_event_outbox_dispatch_idx"),
            IndexDefinition::secondary("mcp_event_outbox_subscription_seq_idx"),
        ]
    );
    for kind in [
        DatabaseKind::Core,
        DatabaseKind::Bootstrap,
        DatabaseKind::Meeting,
    ] {
        for name in [SubscriptionTable::NAME, OutboxTable::NAME] {
            assert_eq!(
                import::catalog(kind)
                    .tables()
                    .iter()
                    .any(|table| table.name == name),
                kind == DatabaseKind::Core,
            );
        }
    }
}

#[test]
fn every_released_field_round_trips_with_opaque_rotation_material_and_replay_watermark() {
    let store = store();
    let sub = Subscription {
        previous_secret_ciphertext: Some(s("opaque-old-synthetic-ciphertext")),
        previous_secret_until: Some(90_000),
        pruned_through: 8,
        include_descendants: 1,
        disabled: 1,
        ..subscription("sub_synthetic")
    };
    let event = Outbox {
        request_id: Some(s("req_synthetic")),
        item_id: Some(s("review_synthetic")),
        task_id: Some(s("ses_task")),
        category: Some(s("ordinary")),
        reason: Some(s("cancelled")),
        attempts: 4,
        next_attempt_at: 5_000,
        delivered_at: Some(4_000),
        dead: 1,
        ..outbox(9, "sub_synthetic")
    };
    let saved_sub = sub.clone();
    let saved_event = event.clone();
    store
        .submit(move |tx| {
            SubscriptionTable::insert(tx, &saved_sub)?;
            OutboxTable::insert(tx, &saved_event)
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .get::<SubscriptionTable>(&SubscriptionTable::primary_key(&sub))
            .unwrap(),
        Some(sub)
    );
    assert_eq!(
        snapshot
            .get::<OutboxTable>(&tuple_key(&[KeyPart::I64(9)]))
            .unwrap(),
        Some(event)
    );
    assert_eq!(
        SubscriptionTable::decode(&SubscriptionTable::encode(&subscription("sub_plain")).unwrap())
            .unwrap(),
        subscription("sub_plain")
    );
    assert_eq!(
        OutboxTable::decode(&OutboxTable::encode(&outbox(10, "sub_plain")).unwrap()).unwrap(),
        outbox(10, "sub_plain")
    );
}

#[test]
fn independent_identity_dimensions_are_preserved_and_only_the_exact_hash_is_unique() {
    let store = store();
    let original = subscription("sub_0");
    let mut rows = vec![original.clone()];
    for dimension in 0..9 {
        let mut row = subscription(&format!("sub_{}", dimension + 1));
        match dimension {
            0 => row.owner_id = s("owner-other"),
            1 => row.device_id = s("device-other"),
            2 => row.client_id = s("client-other"),
            3 => row.grant_id = s("grant-other"),
            4 => row.epoch = s("epoch-other"),
            5 => row.callback_url = s("https://other.invalid/events"),
            6 => row.name = s("session.completed"),
            7 => row.session_id = s("ses_other"),
            8 => row.include_descendants = 1,
            _ => unreachable!(),
        }
        rows.push(row);
    }
    let saved = rows.clone();
    store
        .submit(move |tx| {
            saved
                .iter()
                .try_for_each(|row| SubscriptionTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<SubscriptionTable>(Bound::Unbounded, Bound::Unbounded, 20)
            .unwrap(),
        rows
    );
    let duplicate = Subscription {
        id: s("sub_duplicate"),
        ..original.clone()
    };
    assert!(
        store
            .submit(move |tx| SubscriptionTable::insert(tx, &duplicate))
            .unwrap()
            .wait()
            .is_err()
    );
    let matches = store
        .snapshot()
        .unwrap()
        .index::<SubscriptionTable>(
            "mcp_event_subscription_identity_idx",
            &tuple_key(&[KeyPart::String(&original.identity_hash)]),
            None,
            2,
        )
        .unwrap();
    assert_eq!(matches, [original]);
}

#[test]
fn session_and_expiry_indexes_retain_filter_scope_and_numeric_expiry_order() {
    let store = store();
    let rows = [
        Subscription {
            expires_at: 256,
            ..subscription("sub_a")
        },
        Subscription {
            expires_at: 2,
            ..subscription("sub_b")
        },
        Subscription {
            expires_at: 10,
            session_id: s("ses_other"),
            ..subscription("sub_c")
        },
    ];
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| SubscriptionTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let by_session = snapshot
        .index_range::<SubscriptionTable>(
            "mcp_event_subscription_session_idx",
            query(
                &tuple_key(&[
                    KeyPart::String(&s("ses_synthetic")),
                    KeyPart::String(&s("session.progress")),
                ]),
                10,
            ),
        )
        .unwrap();
    assert_eq!(
        by_session
            .iter()
            .map(|entry| entry.record.id.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["sub_a", "sub_b"]
    );
    let expiry = snapshot
        .index_range::<SubscriptionTable>("mcp_event_subscription_expiry_idx", query(&[], 2))
        .unwrap();
    assert_eq!(
        expiry
            .iter()
            .map(|entry| entry.record.expires_at)
            .collect::<Vec<_>>(),
        [2, 10]
    );
}

#[test]
fn outbox_unique_event_and_dedupe_keys_reject_collisions_without_partial_rows() {
    let store = store();
    store
        .submit(|tx| {
            SubscriptionTable::insert(tx, &subscription("sub_a"))?;
            OutboxTable::insert(tx, &outbox(1, "sub_a"))
        })
        .unwrap()
        .wait()
        .unwrap();
    for row in [
        Outbox {
            id: s("evt_1"),
            ..outbox(2, "sub_a")
        },
        Outbox {
            dedupe_key: outbox(1, "sub_a").dedupe_key,
            ..outbox(3, "sub_a")
        },
        Outbox {
            id: s("evt_other"),
            dedupe_key: s("other-dedupe"),
            ..outbox(1, "sub_a")
        },
    ] {
        assert!(
            store
                .submit(move |tx| OutboxTable::insert(tx, &row))
                .unwrap()
                .wait()
                .is_err()
        );
    }
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<OutboxTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap(),
        [outbox(1, "sub_a")]
    );
}

#[test]
fn ordered_subscription_pages_fence_other_subscriptions_and_resume_after_the_last_key() {
    let store = store();
    store
        .submit(|tx| {
            SubscriptionTable::insert(tx, &subscription("sub_a"))?;
            SubscriptionTable::insert(tx, &subscription("sub_b"))?;
            [256, 10, 2]
                .into_iter()
                .try_for_each(|seq| OutboxTable::insert(tx, &outbox(seq, "sub_a")))?;
            OutboxTable::insert(tx, &outbox(3, "sub_b"))
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let prefix = tuple_key(&[KeyPart::String(&s("sub_a"))]);
    let first = snapshot
        .index_range::<OutboxTable>("mcp_event_outbox_subscription_seq_idx", query(&prefix, 2))
        .unwrap();
    assert_eq!(
        first
            .iter()
            .map(|entry| entry.record.seq)
            .collect::<Vec<_>>(),
        [2, 10]
    );
    let mut next = query(&prefix, 2);
    next.after = Some(&first.last().unwrap().cursor);
    let second = snapshot
        .index_range::<OutboxTable>("mcp_event_outbox_subscription_seq_idx", next)
        .unwrap();
    assert_eq!(
        second
            .iter()
            .map(|entry| entry.record.seq)
            .collect::<Vec<_>>(),
        [256]
    );
}

#[test]
fn dispatch_keys_order_null_delivery_dead_flag_due_time_then_numeric_sequence() {
    let rows = [
        Outbox {
            next_attempt_at: 10,
            ..outbox(256, "sub_a")
        },
        Outbox {
            next_attempt_at: 10,
            ..outbox(2, "sub_a")
        },
        Outbox {
            next_attempt_at: 2,
            ..outbox(10, "sub_a")
        },
        Outbox {
            dead: 1,
            next_attempt_at: 1,
            ..outbox(11, "sub_a")
        },
        Outbox {
            delivered_at: Some(1),
            next_attempt_at: 1,
            ..outbox(12, "sub_a")
        },
    ];
    let store = store();
    store
        .submit(move |tx| {
            SubscriptionTable::insert(tx, &subscription("sub_a"))?;
            rows.iter().try_for_each(|row| OutboxTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    let rows = snapshot
        .index_range::<OutboxTable>("mcp_event_outbox_dispatch_idx", query(&[], 10))
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|entry| entry.record.seq)
            .collect::<Vec<_>>(),
        [10, 2, 256, 11, 12]
    );
    let due = tuple_key(&[KeyPart::Null, KeyPart::I64(0)]);
    let rows = snapshot
        .index_range::<OutboxTable>(
            "mcp_event_outbox_dispatch_idx",
            IndexQuery {
                upper: Bound::Excluded(&tuple_key(&[
                    KeyPart::Null,
                    KeyPart::I64(0),
                    KeyPart::I64(10),
                ])),
                ..query(&due, 10)
            },
        )
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|entry| entry.record.seq)
            .collect::<Vec<_>>(),
        [10]
    );
}

#[test]
fn bounded_retention_deletes_selected_history_and_updates_the_same_subscription_watermark_atomically()
 {
    let store = store();
    store
        .submit(|tx| {
            SubscriptionTable::insert(tx, &subscription("sub_a"))?;
            SubscriptionTable::insert(tx, &subscription("sub_b"))?;
            for seq in 1..=4 {
                OutboxTable::insert(
                    tx,
                    &Outbox {
                        delivered_at: Some(200),
                        ..outbox(seq, "sub_a")
                    },
                )?;
            }
            OutboxTable::insert(tx, &outbox(5, "sub_b"))
        })
        .unwrap()
        .wait()
        .unwrap();
    store
        .submit(|tx| {
            let prefix = tuple_key(&[KeyPart::String(&s("sub_a"))]);
            let rows = tx.index_range::<OutboxTable>(
                "mcp_event_outbox_subscription_seq_idx",
                query(&prefix, 2),
            )?;
            assert_eq!(rows.len(), 2);
            for entry in &rows {
                tx.delete::<OutboxTable>(&OutboxTable::primary_key(&entry.record))?;
            }
            let mut sub = tx
                .get::<SubscriptionTable>(&tuple_key(&[KeyPart::String(&s("sub_a"))]))?
                .unwrap();
            sub.pruned_through = rows.last().unwrap().record.seq;
            SubscriptionTable::put(tx, &sub)
        })
        .unwrap()
        .wait()
        .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .scan::<OutboxTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .iter()
            .map(|row| row.seq)
            .collect::<Vec<_>>(),
        [3, 4, 5]
    );
    assert_eq!(
        snapshot
            .get::<SubscriptionTable>(&tuple_key(&[KeyPart::String(&s("sub_a"))]))
            .unwrap()
            .unwrap()
            .pruned_through,
        2
    );
    assert_eq!(
        snapshot
            .get::<SubscriptionTable>(&tuple_key(&[KeyPart::String(&s("sub_b"))]))
            .unwrap()
            .unwrap()
            .pruned_through,
        0
    );
    for index in [
        "mcp_event_outbox_id_idx",
        "mcp_event_outbox_dedupe_idx",
        "mcp_event_outbox_dispatch_idx",
        "mcp_event_outbox_subscription_seq_idx",
    ] {
        assert_eq!(
            snapshot
                .index_range::<OutboxTable>(index, query(&[], 10))
                .unwrap()
                .len(),
            3
        );
    }
}

#[test]
fn codecs_refuse_truncation_wrong_versions_and_trailing_bytes() {
    let sub = SubscriptionTable::encode(&subscription("sub_synthetic")).unwrap();
    let event = OutboxTable::encode(&outbox(1, "sub_synthetic")).unwrap();
    for cut in 0..sub.len() {
        assert!(SubscriptionTable::decode(&sub[..cut]).is_err());
    }
    for cut in 0..event.len() {
        assert!(OutboxTable::decode(&event[..cut]).is_err());
    }
    let mut wrong_sub = sub.clone();
    wrong_sub[0] = 255;
    let mut wrong_event = event.clone();
    wrong_event[0] = 255;
    assert!(SubscriptionTable::decode(&wrong_sub).is_err());
    assert!(OutboxTable::decode(&wrong_event).is_err());
    assert!(SubscriptionTable::decode(&[sub.as_slice(), &[0]].concat()).is_err());
    assert!(OutboxTable::decode(&[event.as_slice(), &[0]].concat()).is_err());
}

#[test]
fn global_sequence_reservations_survive_empty_outbox_and_share_the_write_transaction() {
    let store = store();
    store
        .submit(|tx| {
            SubscriptionTable::insert(tx, &subscription("sub_a"))?;
            SubscriptionTable::insert(tx, &subscription("sub_b"))?;
            assert_eq!(next_sequence(tx)?, 1);
            OutboxTable::insert(tx, &outbox(1, "sub_a"))?;
            assert_eq!(next_sequence(tx)?, 2);
            OutboxTable::insert(tx, &outbox(2, "sub_b"))?;
            tx.delete::<OutboxTable>(&tuple_key(&[KeyPart::I64(1)]))?;
            tx.delete::<OutboxTable>(&tuple_key(&[KeyPart::I64(2)]))?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let failed = store
        .submit(|tx| {
            assert_eq!(next_sequence(tx)?, 3);
            Err::<(), _>(ycoding_store::Error::Rejected("synthetic abort"))
        })
        .unwrap()
        .wait();
    assert!(failed.is_err());
    store
        .submit(|tx| {
            assert_eq!(next_sequence(tx)?, 3);
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(
        store
            .snapshot()
            .unwrap()
            .scan::<OutboxTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn explicit_outbox_keys_advance_the_same_sequence_and_exhaustion_never_wraps() {
    let store = store();
    store
        .submit(|tx| {
            SubscriptionTable::insert(tx, &subscription("sub_a"))?;
            OutboxTable::insert(tx, &outbox(256, "sub_a"))?;
            assert_eq!(next_sequence(tx)?, 257);
            OutboxTable::insert(tx, &outbox(i64::MAX, "sub_a"))
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(store.submit(next_sequence).unwrap().wait().is_err());
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<OutboxTable>(Bound::Unbounded, Bound::Unbounded, 10)
            .unwrap()
            .iter()
            .map(|row| row.seq)
            .collect::<Vec<_>>(),
        [256, i64::MAX]
    );
}

#[test]
fn empty_outbox_sequence_and_opaque_subscription_survive_a_durable_reopen() {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Directory(PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let path = std::env::temp_dir().join(format!(
        "ycoding-mcp-events-reopen-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed),
    ));
    std::fs::create_dir(&path).unwrap();
    let directory = Directory(path);
    let path = directory.0.join("synthetic.redb");
    let catalog = import::catalog(DatabaseKind::Core);
    let store =
        Store::initialize(&path, Options::core(), catalog, Metadata::new([86; 16], 1)).unwrap();
    store
        .submit(|tx| {
            SubscriptionTable::insert(tx, &subscription("sub_durable"))?;
            OutboxTable::insert(tx, &outbox(256, "sub_durable"))?;
            tx.delete::<OutboxTable>(&tuple_key(&[KeyPart::I64(256)]))?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    let store = Store::open(&path, Options::core(), catalog).unwrap();
    assert_eq!(store.submit(next_sequence).unwrap().wait().unwrap(), 257);
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot
            .get::<SubscriptionTable>(&tuple_key(&[KeyPart::String(&s("sub_durable"))]))
            .unwrap(),
        Some(subscription("sub_durable"))
    );
    assert!(
        snapshot
            .scan::<OutboxTable>(Bound::Unbounded, Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    drop(snapshot);
    store.shutdown().unwrap();
}
