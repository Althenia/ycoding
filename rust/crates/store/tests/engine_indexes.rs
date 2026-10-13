use std::ops::Bound;
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_schema::LosslessString;
use ycoding_store::{
    Catalog, Error, IndexCursor, IndexDefinition, IndexEntry, IndexOrder, IndexQuery, KeyPart,
    Metadata, Options, Snapshot, Store, TableDeclaration, TableSpec, tuple_key,
};

struct Messages;
#[derive(Clone, Debug, PartialEq, Eq)]
struct Message {
    id: u64,
    scope: LosslessString,
    seq: i64,
    included: bool,
}
impl TableSpec for Messages {
    type Record = Message;
    const NAME: &'static str = "messages";
    const INDEXES: &'static [IndexDefinition] = &[
        IndexDefinition::secondary("session_seq"),
        IndexDefinition::unique("session_seq_id"),
        IndexDefinition::secondary("included_session_seq"),
        IndexDefinition::unique("included_session_seq_id"),
    ];
    fn primary_key(record: &Message) -> Vec<u8> {
        tuple_key(&[KeyPart::U64(record.id)])
    }
    fn encode(record: &Message) -> Result<Vec<u8>, Error> {
        Ok([
            record.id.to_be_bytes().to_vec(),
            record.seq.to_be_bytes().to_vec(),
            vec![u8::from(record.included)],
            record
                .scope
                .code_units()
                .flat_map(u16::to_be_bytes)
                .collect(),
        ]
        .concat())
    }
    fn decode(bytes: &[u8]) -> Result<Message, Error> {
        if bytes.len() < 17 || !(bytes.len() - 17).is_multiple_of(2) || bytes[16] > 1 {
            return Err(Error::Rejected("invalid message fixture"));
        }
        Ok(Message {
            id: u64::from_be_bytes(bytes[..8].try_into().unwrap()),
            seq: i64::from_be_bytes(bytes[8..16].try_into().unwrap()),
            included: bytes[16] == 1,
            scope: LosslessString::from_utf16(
                bytes[17..]
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .copied()
                    .map(u16::from_be_bytes)
                    .collect(),
            ),
        })
    }
    fn index_key(index: &IndexDefinition, record: &Message) -> Result<Option<Vec<u8>>, Error> {
        if index.name.starts_with("included_") && !record.included {
            return Ok(None);
        }
        let mut parts = vec![KeyPart::String(&record.scope), KeyPart::I64(record.seq)];
        if index.unique {
            parts.push(KeyPart::U64(record.id));
        }
        Ok(Some(tuple_key(&parts)))
    }
}
const CATALOG: Catalog = Catalog::new(1, &[TableDeclaration::of::<Messages>()]);
fn message(id: u64, scope: LosslessString, seq: i64) -> Message {
    Message {
        id,
        scope,
        seq,
        included: id != 3,
    }
}
fn fixtures() -> Vec<Message> {
    vec![
        message(1, "s".into(), i64::MIN),
        message(2, "s".into(), -2),
        message(3, "s".into(), -2),
        message(4, "s".into(), 0),
        message(5, "s".into(), 2),
        message(6, "s".into(), i64::MAX),
        message(7, "s\0".into(), -2),
        message(8, "st".into(), -2),
        message(9, LosslessString::from_utf16(vec![0xd800]), -1),
        message(10, LosslessString::from_utf16(vec![0xd800, 0]), -1),
    ]
}
fn query(prefix: Option<&[u8]>, order: IndexOrder, limit: usize) -> IndexQuery<'_> {
    IndexQuery {
        lower: Bound::Unbounded,
        upper: Bound::Unbounded,
        prefix,
        order,
        after: None,
        limit,
    }
}
fn ids(entries: &[IndexEntry<Message>]) -> Vec<u64> {
    entries.iter().map(|entry| entry.record.id).collect()
}
fn pages(snapshot: &Snapshot, index: &str, query: IndexQuery<'_>) -> Vec<u64> {
    let mut result = Vec::new();
    let mut cursor: Option<IndexCursor> = None;
    for _ in 0..20 {
        let entries = snapshot
            .index_range::<Messages>(
                index,
                IndexQuery {
                    after: cursor.as_ref(),
                    ..query
                },
            )
            .unwrap();
        if entries.is_empty() {
            return result;
        }
        assert!(entries.len() <= query.limit);
        result.extend(ids(&entries));
        cursor = entries.last().map(|entry| entry.cursor.clone());
    }
    panic!("cursor did not exhaust bounded fixture");
}
fn with_stores(check: impl Fn(&Store)) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for file_backed in [false, true] {
        let path = std::env::temp_dir().join(format!(
            "ycoding-engine-indexes-{}-{}.redb",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let options = Options {
            cache_bytes: 1024 * 1024,
            queue_capacity: 2,
            max_snapshots: 2,
        };
        let store = if file_backed {
            Store::initialize(&path, options, CATALOG, Metadata::new([8; 16], 1)).unwrap()
        } else {
            Store::disposable(options, CATALOG, Metadata::new([8; 16], 1)).unwrap()
        };
        store
            .submit(|tx| {
                for row in fixtures() {
                    tx.put::<Messages>(&row)?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        check(&store);
        store.shutdown().unwrap();
        if file_backed {
            let reopened = Store::open(&path, options, CATALOG).unwrap();
            check(&reopened);
            reopened.shutdown().unwrap();
            std::fs::remove_file(path).unwrap();
        }
    }
}

#[test]
fn ordered_prefix_pages_preserve_signed_order_ties_unique_partial_and_utf16() {
    with_stores(|store| {
        let snapshot = store.snapshot().unwrap();
        let scope = tuple_key(&[KeyPart::String(&"s".into())]);
        for (index, expected) in [
            ("session_seq", vec![1, 2, 3, 4, 5, 6]),
            ("session_seq_id", vec![1, 2, 3, 4, 5, 6]),
            ("included_session_seq", vec![1, 2, 4, 5, 6]),
            ("included_session_seq_id", vec![1, 2, 4, 5, 6]),
        ] {
            assert_eq!(
                pages(
                    &snapshot,
                    index,
                    query(Some(&scope), IndexOrder::Ascending, 2)
                ),
                expected
            );
            assert_eq!(
                pages(
                    &snapshot,
                    index,
                    query(Some(&scope), IndexOrder::Descending, 1)
                ),
                expected.into_iter().rev().collect::<Vec<_>>()
            );
        }
        assert_eq!(
            pages(
                &snapshot,
                "session_seq",
                query(None, IndexOrder::Ascending, 3)
            ),
            (1..=10).collect::<Vec<_>>()
        );
        assert_eq!(
            pages(
                &snapshot,
                "session_seq_id",
                query(None, IndexOrder::Descending, 3)
            ),
            (1..=10).rev().collect::<Vec<_>>()
        );
        let lone = LosslessString::from_utf16(vec![0xd800]);
        assert_eq!(
            pages(
                &snapshot,
                "session_seq",
                query(
                    Some(&tuple_key(&[KeyPart::String(&lone)])),
                    IndexOrder::Ascending,
                    2
                )
            ),
            vec![9]
        );
        for entry in snapshot
            .index_range::<Messages>(
                "session_seq",
                query(Some(&scope), IndexOrder::Ascending, 10),
            )
            .unwrap()
        {
            assert_eq!(
                entry.cursor.logical_key,
                tuple_key(&[
                    KeyPart::String(&entry.record.scope),
                    KeyPart::I64(entry.record.seq)
                ])
            );
            assert_eq!(
                entry.cursor.primary_key,
                Messages::primary_key(&entry.record)
            );
        }
    });
}

#[test]
fn logical_range_bounds_intersect_prefix_and_resume_in_both_directions() {
    with_stores(|store| {
        let snapshot = store.snapshot().unwrap();
        let scope: LosslessString = "s".into();
        let prefix = tuple_key(&[KeyPart::String(&scope)]);
        let lower = tuple_key(&[KeyPart::String(&scope), KeyPart::I64(-2)]);
        let upper = tuple_key(&[KeyPart::String(&scope), KeyPart::I64(2)]);
        for order in [IndexOrder::Ascending, IndexOrder::Descending] {
            let unique_lower =
                tuple_key(&[KeyPart::String(&scope), KeyPart::I64(-2), KeyPart::U64(2)]);
            let unique_upper =
                tuple_key(&[KeyPart::String(&scope), KeyPart::I64(2), KeyPart::U64(5)]);
            let expected = if order == IndexOrder::Ascending {
                vec![2, 3, 4, 5]
            } else {
                vec![5, 4, 3, 2]
            };
            assert_eq!(
                pages(
                    &snapshot,
                    "session_seq_id",
                    IndexQuery {
                        lower: Bound::Included(&unique_lower),
                        upper: Bound::Included(&unique_upper),
                        ..query(Some(&prefix), order, 2)
                    }
                ),
                expected
            );
            let expected = if order == IndexOrder::Ascending {
                vec![3, 4]
            } else {
                vec![4, 3]
            };
            assert_eq!(
                pages(
                    &snapshot,
                    "session_seq_id",
                    IndexQuery {
                        lower: Bound::Excluded(&unique_lower),
                        upper: Bound::Excluded(&unique_upper),
                        ..query(Some(&prefix), order, 2)
                    }
                ),
                expected
            );
            for (lo, hi, expected) in [
                (
                    Bound::Included(lower.as_slice()),
                    Bound::Included(upper.as_slice()),
                    vec![2, 3, 4, 5],
                ),
                (
                    Bound::Excluded(lower.as_slice()),
                    Bound::Excluded(upper.as_slice()),
                    vec![4],
                ),
                (
                    Bound::Included(lower.as_slice()),
                    Bound::Excluded(upper.as_slice()),
                    vec![2, 3, 4],
                ),
                (
                    Bound::Excluded(lower.as_slice()),
                    Bound::Included(upper.as_slice()),
                    vec![4, 5],
                ),
                (
                    Bound::Included(lower.as_slice()),
                    Bound::Included(lower.as_slice()),
                    vec![2, 3],
                ),
            ] {
                let expected = if order == IndexOrder::Ascending {
                    expected
                } else {
                    expected.into_iter().rev().collect()
                };
                assert_eq!(
                    pages(
                        &snapshot,
                        "session_seq",
                        IndexQuery {
                            lower: lo,
                            upper: hi,
                            ..query(Some(&prefix), order, 1)
                        }
                    ),
                    expected
                );
            }
            assert!(
                snapshot
                    .index_range::<Messages>(
                        "session_seq",
                        IndexQuery {
                            lower: Bound::Excluded(&lower),
                            upper: Bound::Included(&lower),
                            ..query(None, order, 2)
                        }
                    )
                    .unwrap()
                    .is_empty()
            );
            assert!(
                snapshot
                    .index_range::<Messages>(
                        "session_seq",
                        IndexQuery {
                            lower: Bound::Included(&upper),
                            upper: Bound::Included(&lower),
                            ..query(None, order, 2)
                        }
                    )
                    .unwrap()
                    .is_empty()
            );
            assert!(
                snapshot
                    .index_range::<Messages>("session_seq", query(Some(&prefix), order, 0))
                    .unwrap()
                    .is_empty()
            );
            assert!(
                snapshot
                    .index_range::<Messages>(
                        "session_seq",
                        query(
                            Some(&tuple_key(&[KeyPart::String(&"missing".into())])),
                            order,
                            2
                        )
                    )
                    .unwrap()
                    .is_empty()
            );
            let outside = tuple_key(&[KeyPart::String(&"z".into())]);
            assert!(
                snapshot
                    .index_range::<Messages>(
                        "session_seq",
                        IndexQuery {
                            lower: Bound::Included(&outside),
                            ..query(Some(&prefix), order, 2)
                        }
                    )
                    .unwrap()
                    .is_empty()
            );
            let cursor = IndexCursor {
                logical_key: outside,
                primary_key: tuple_key(&[KeyPart::U64(99)]),
            };
            let result = snapshot
                .index_range::<Messages>(
                    "session_seq",
                    IndexQuery {
                        after: Some(&cursor),
                        ..query(Some(&prefix), order, 10)
                    },
                )
                .unwrap();
            assert_eq!(
                ids(&result),
                if order == IndexOrder::Ascending {
                    vec![]
                } else {
                    vec![6, 5, 4, 3, 2, 1]
                }
            );
            assert_eq!(
                pages(&snapshot, "session_seq", query(Some(&[]), order, 3)),
                if order == IndexOrder::Ascending {
                    (1..=10).collect::<Vec<_>>()
                } else {
                    (1..=10).rev().collect::<Vec<_>>()
                }
            );
            assert!(
                snapshot
                    .index_range::<Messages>("session_seq", query(Some(&[255]), order, 2))
                    .unwrap()
                    .is_empty()
            );
        }
    });
}

#[test]
fn index_read_failures_latch_even_when_caught_and_zero_limits_validate_names() {
    with_stores(|store| {
        for ranged in [false, true] {
            let result = store
                .submit(move |tx| {
                    tx.put::<Messages>(&message(11, "s".into(), 1))?;
                    let result = if ranged {
                        tx.index_range::<Messages>("missing", query(None, IndexOrder::Ascending, 0))
                            .map(|_| ())
                    } else {
                        tx.index::<Messages>("missing", &[], None, 0).map(|_| ())
                    };
                    assert!(matches!(result, Err(Error::UnregisteredIndex)));
                    Ok(())
                })
                .unwrap()
                .wait();
            assert!(matches!(result, Err(Error::TransactionAborted)));
            assert_eq!(
                store
                    .snapshot()
                    .unwrap()
                    .get::<Messages>(&tuple_key(&[KeyPart::U64(11)]))
                    .unwrap(),
                None
            );
        }
        assert!(matches!(
            store
                .snapshot()
                .unwrap()
                .index_range::<Messages>("missing", query(None, IndexOrder::Ascending, 0)),
            Err(Error::UnregisteredIndex)
        ));
    });
}

#[test]
fn corrupt_index_memberships_fail_closed_on_snapshot_and_write_and_roll_back() {
    for (case, index_name) in [
        ("dangling", "session_seq"),
        ("stale", "session_seq_id"),
        ("tiebreak", "session_seq"),
        ("partial", "included_session_seq"),
    ] {
        let path = std::env::temp_dir().join(format!(
            "ycoding-engine-corrupt-{}-{case}.redb",
            std::process::id()
        ));
        let options = Options {
            cache_bytes: 1024 * 1024,
            queue_capacity: 2,
            max_snapshots: 2,
        };
        let store = Store::initialize(&path, options, CATALOG, Metadata::new([8; 16], 1)).unwrap();
        store
            .submit(|tx| {
                for row in fixtures() {
                    tx.put::<Messages>(&row)?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        store.shutdown().unwrap();
        let db = redb::Database::open(&path).unwrap();
        let tx = db.begin_write().unwrap();
        let index = Messages::INDEXES
            .iter()
            .find(|index| index.name == index_name)
            .unwrap();
        let row = &fixtures()[match case {
            "partial" => 2,
            "tiebreak" => 1,
            _ => 0,
        }];
        let logical = tuple_key(&[KeyPart::String(&row.scope), KeyPart::I64(row.seq)]);
        let logical = if index.unique {
            [logical, tuple_key(&[KeyPart::U64(row.id)])].concat()
        } else {
            logical
        };
        let primary = Messages::primary_key(row);
        let storage = if index.unique {
            logical
        } else {
            tuple_key(&[KeyPart::Bytes(&logical), KeyPart::Bytes(&primary)])
        };
        let target = tuple_key(&[KeyPart::U64(if case == "dangling" { 99 } else { 3 })]);
        tx.open_table(redb::TableDefinition::<&[u8], &[u8]>::new(index_name))
            .unwrap()
            .insert(storage.as_slice(), target.as_slice())
            .unwrap();
        tx.commit().unwrap();
        drop(db);
        let store = Store::open(&path, options, CATALOG).unwrap();
        assert!(matches!(
            store
                .snapshot()
                .unwrap()
                .index_range::<Messages>(index_name, query(None, IndexOrder::Ascending, 10)),
            Err(Error::Incompatible(_))
        ));
        let result = store
            .submit(move |tx| {
                tx.put::<Messages>(&message(11, "s".into(), 1))?;
                assert!(matches!(
                    tx.index_range::<Messages>(index_name, query(None, IndexOrder::Ascending, 10)),
                    Err(Error::Incompatible(_))
                ));
                Ok(())
            })
            .unwrap()
            .wait();
        assert!(matches!(result, Err(Error::TransactionAborted)));
        assert_eq!(
            store
                .snapshot()
                .unwrap()
                .get::<Messages>(&tuple_key(&[KeyPart::U64(11)]))
                .unwrap(),
            None
        );
        store.shutdown().unwrap();
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn write_range_reads_own_changes_and_rejection_rolls_back() {
    with_stores(|store| {
        let snapshot = store.snapshot().unwrap();
        let result = store
            .submit(|tx| {
                let prefix = tuple_key(&[KeyPart::String(&"s".into())]);
                tx.put::<Messages>(&message(11, "s".into(), -3))?;
                tx.delete::<Messages>(&tuple_key(&[KeyPart::U64(1)]))?;
                tx.put::<Messages>(&message(2, "other".into(), -2))?;
                let first = tx.index_range::<Messages>(
                    "session_seq",
                    query(Some(&prefix), IndexOrder::Descending, 2),
                )?;
                assert_eq!(ids(&first), vec![6, 5]);
                let second = tx.index_range::<Messages>(
                    "session_seq",
                    IndexQuery {
                        after: Some(&first[1].cursor),
                        ..query(Some(&prefix), IndexOrder::Descending, 10)
                    },
                )?;
                assert_eq!(ids(&second), vec![4, 3, 11]);
                assert_eq!(
                    ids(&tx.index_range::<Messages>(
                        "included_session_seq",
                        query(Some(&prefix), IndexOrder::Ascending, 10)
                    )?),
                    vec![11, 4, 5, 6]
                );
                assert_eq!(
                    ids(&tx.index_range::<Messages>(
                        "session_seq_id",
                        query(Some(&prefix), IndexOrder::Ascending, 10)
                    )?),
                    vec![11, 3, 4, 5, 6]
                );
                Err::<(), _>(tx.reject(Error::Domain {
                    kind: "fixture_rollback",
                    message: "keep original records",
                }))
            })
            .unwrap()
            .wait();
        assert!(
            matches!(
                result,
                Err(Error::Domain {
                    kind: "fixture_rollback",
                    message: "keep original records"
                })
            ),
            "{result:?}"
        );
        let prefix = tuple_key(&[KeyPart::String(&"s".into())]);
        assert_eq!(
            pages(
                &snapshot,
                "session_seq",
                query(Some(&prefix), IndexOrder::Ascending, 10)
            ),
            vec![1, 2, 3, 4, 5, 6]
        );
        assert_eq!(
            pages(
                &store.snapshot().unwrap(),
                "session_seq",
                query(Some(&prefix), IndexOrder::Ascending, 10)
            ),
            vec![1, 2, 3, 4, 5, 6]
        );
    });
}
