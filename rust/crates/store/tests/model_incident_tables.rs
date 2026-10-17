use std::ops::Bound;
use ycoding_schema::{LosslessString, parse_json};
use ycoding_store::{
    IndexDefinition, IndexOrder, IndexQuery, KeyPart, Metadata, Options, Store, TableSpec,
    import::{self, DatabaseKind},
    model_incident::{
        self, CLEANUP_ROWS, GUIDANCE_INDEX, GuidanceClear, GuidanceClearTable, Incident,
        IncidentTable, MODEL_AGENT_INDEX, MODEL_INDEX, REQUEST_INDEX, TIME_INDEX,
    },
    session::Document,
    tuple_key,
};

fn store() -> Store {
    Store::disposable(
        Options::core(),
        import::catalog(DatabaseKind::Core),
        Metadata::new([3; 16], 1),
    )
    .unwrap()
}

fn s(value: &str) -> LosslessString {
    value.into()
}

fn incident(id: &str, kind: &str, time: i64) -> Incident {
    let guardrail = kind != "fallback";
    Incident {
        id: s(id),
        time_created: time,
        kind: s(kind),
        provider_id: s("openai"),
        model_id: s("gpt"),
        variant: None,
        profile: None,
        agent: s("build"),
        project_id: s("prj_one"),
        session_id: s("ses_one"),
        request_id: guardrail.then(|| s(&format!("grq_{id}"))),
        category: s(if guardrail { "ordinary" } else { "rate_limit" }),
        rule_ids: Document::new(
            parse_json(if guardrail {
                r#"["standard.review.force-push"]"#
            } else {
                "[]"
            })
            .unwrap(),
        )
        .unwrap(),
        target: (!guardrail).then(|| {
            Document::new(parse_json(r#"{"id":"mini","providerID":"openai"}"#).unwrap()).unwrap()
        }),
        decided_by: (kind == "guardrail-rejected").then(|| s("human")),
    }
}

fn put(store: &Store, rows: Vec<Incident>) -> Result<(), ycoding_store::Error> {
    store
        .submit(move |tx| {
            rows.iter()
                .try_for_each(|row| IncidentTable::insert(tx, row))
        })?
        .wait()
}

fn all(store: &Store) -> Vec<Incident> {
    store
        .snapshot()
        .unwrap()
        .scan::<IncidentTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
}

fn ids(rows: Vec<ycoding_store::IndexEntry<Incident>>) -> Vec<String> {
    rows.into_iter()
        .map(|row| row.record.id.as_str().unwrap().to_owned())
        .collect()
}

fn query(store: &Store, index: &str, prefix: &[u8], order: IndexOrder) -> Vec<String> {
    ids(store
        .snapshot()
        .unwrap()
        .index_range::<IncidentTable>(
            index,
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(prefix),
                order,
                after: None,
                limit: usize::MAX,
            },
        )
        .unwrap())
}

#[test]
fn the_incident_tables_declare_their_exact_indexes_and_join_the_core_catalog() {
    assert_eq!(IncidentTable::NAME, "model_incident");
    assert_eq!(GuidanceClearTable::NAME, "model_guidance_clear");
    assert_eq!(
        IncidentTable::INDEXES,
        &[
            IndexDefinition::secondary("model_incident_time_created_id_idx"),
            IndexDefinition::secondary("model_incident_model_time_idx"),
            IndexDefinition::secondary("model_incident_model_agent_time_idx"),
            IndexDefinition::secondary("model_incident_guidance_idx"),
            IndexDefinition::secondary("model_incident_request_idx"),
        ]
    );
    assert_eq!(
        IncidentTable::INDEXES
            .iter()
            .map(|index| index.name)
            .collect::<Vec<_>>(),
        [
            TIME_INDEX,
            MODEL_INDEX,
            MODEL_AGENT_INDEX,
            GUIDANCE_INDEX,
            REQUEST_INDEX
        ]
    );
    assert!(GuidanceClearTable::INDEXES.is_empty());
    assert_eq!(
        model_incident::TABLES
            .iter()
            .map(|table| table.name)
            .collect::<Vec<_>>(),
        ["model_incident", "model_guidance_clear"]
    );
    let core = import::catalog(DatabaseKind::Core);
    for table in model_incident::TABLES {
        assert!(core.tables().contains(table), "{}", table.name);
    }
}

#[test]
fn every_kind_round_trips_without_a_session_reference() {
    let store = store();
    let rows = vec![
        Incident {
            variant: Some(s("high")),
            profile: Some(s("work")),
            ..incident("inc_fallback", "fallback", 1)
        },
        incident("inc_escalated", "guardrail-escalated", 2),
        Incident {
            category: s("hard"),
            rule_ids: Document::new(
                parse_json(r#"["standard.review.git-destructive","custom"]"#).unwrap(),
            )
            .unwrap(),
            decided_by: Some(s("decision-model")),
            ..incident("inc_rejected", "guardrail-rejected", 3)
        },
    ];
    put(&store, rows.clone()).unwrap();
    assert_eq!(all(&store).len(), rows.len());
    let snapshot = store.snapshot().unwrap();
    for row in rows {
        assert_eq!(
            snapshot
                .get::<IncidentTable>(&tuple_key(&[KeyPart::String(&row.id)]))
                .unwrap(),
            Some(row),
        );
    }
}

#[test]
fn rows_outside_the_identifier_only_contract_are_rejected() {
    let fallback = || incident("inc_f", "fallback", 1);
    let escalated = || incident("inc_e", "guardrail-escalated", 1);
    let rejected = || incident("inc_r", "guardrail-rejected", 1);
    let rules = |text: &str| Document::new(parse_json(text).unwrap()).unwrap();
    for (name, row) in [
        (
            "id prefix",
            Incident {
                id: s("prq_f"),
                ..fallback()
            },
        ),
        (
            "bare prefix",
            Incident {
                id: s("inc_"),
                ..fallback()
            },
        ),
        (
            "negative time",
            Incident {
                time_created: -1,
                ..fallback()
            },
        ),
        (
            "unknown kind",
            Incident {
                kind: s("guardrail"),
                ..escalated()
            },
        ),
        (
            "empty provider",
            Incident {
                provider_id: s(""),
                ..fallback()
            },
        ),
        (
            "empty model",
            Incident {
                model_id: s(""),
                ..fallback()
            },
        ),
        (
            "empty agent",
            Incident {
                agent: s(""),
                ..fallback()
            },
        ),
        (
            "empty project",
            Incident {
                project_id: s(""),
                ..fallback()
            },
        ),
        (
            "empty session",
            Incident {
                session_id: s(""),
                ..fallback()
            },
        ),
        (
            "empty variant",
            Incident {
                variant: Some(s("")),
                ..fallback()
            },
        ),
        (
            "empty profile",
            Incident {
                profile: Some(s("")),
                ..fallback()
            },
        ),
        (
            "free-text fallback category",
            Incident {
                category: s("rate limit: /home/me"),
                ..fallback()
            },
        ),
        (
            "overlong fallback category",
            Incident {
                category: s(&"a".repeat(65)),
                ..fallback()
            },
        ),
        (
            "guardrail category",
            Incident {
                category: s("medium"),
                ..escalated()
            },
        ),
        (
            "fallback with rules",
            Incident {
                rule_ids: rules(r#"["custom"]"#),
                ..fallback()
            },
        ),
        (
            "unbounded rule",
            Incident {
                rule_ids: rules(r#"["rm -rf /"]"#),
                ..escalated()
            },
        ),
        (
            "uppercase rule",
            Incident {
                rule_ids: rules(r#"["Standard.review"]"#),
                ..escalated()
            },
        ),
        (
            "duplicate rule",
            Incident {
                rule_ids: rules(r#"["custom","custom"]"#),
                ..escalated()
            },
        ),
        (
            "fallback with request",
            Incident {
                request_id: Some(s("grq_x")),
                ..fallback()
            },
        ),
        (
            "guardrail without request",
            Incident {
                request_id: None,
                ..escalated()
            },
        ),
        (
            "empty request",
            Incident {
                request_id: Some(s("")),
                ..escalated()
            },
        ),
        (
            "fallback without target",
            Incident {
                target: None,
                ..fallback()
            },
        ),
        (
            "guardrail with target",
            Incident {
                target: fallback().target,
                ..escalated()
            },
        ),
        (
            "escalation decided",
            Incident {
                decided_by: Some(s("human")),
                ..escalated()
            },
        ),
        (
            "fallback decided",
            Incident {
                decided_by: Some(s("human")),
                ..fallback()
            },
        ),
        (
            "rejection undecided",
            Incident {
                decided_by: None,
                ..rejected()
            },
        ),
        (
            "unknown decider",
            Incident {
                decided_by: Some(s("model")),
                ..rejected()
            },
        ),
    ] {
        let store = store();
        assert!(put(&store, vec![row]).is_err(), "{name}");
        assert!(all(&store).is_empty(), "{name}");
    }
}

#[test]
fn indexes_order_by_time_model_and_agent_and_partially_cover_guardrail_rows() {
    let store = store();
    put(
        &store,
        vec![
            incident("inc_a", "fallback", 30),
            incident("inc_b", "guardrail-escalated", 10),
            Incident {
                agent: s("plan"),
                ..incident("inc_c", "guardrail-rejected", 20)
            },
            Incident {
                model_id: s("other"),
                ..incident("inc_d", "guardrail-escalated", 5)
            },
            incident("inc_e", "guardrail-escalated", 10),
        ],
    )
    .unwrap();
    assert_eq!(
        query(&store, TIME_INDEX, &[], IndexOrder::Ascending),
        ["inc_d", "inc_b", "inc_e", "inc_c", "inc_a"]
    );
    let model = tuple_key(&[KeyPart::String(&s("openai")), KeyPart::String(&s("gpt"))]);
    assert_eq!(
        query(&store, MODEL_INDEX, &model, IndexOrder::Descending),
        ["inc_a", "inc_c", "inc_e", "inc_b"]
    );
    let agent = tuple_key(&[
        KeyPart::String(&s("openai")),
        KeyPart::String(&s("gpt")),
        KeyPart::String(&s("build")),
    ]);
    assert_eq!(
        query(&store, MODEL_AGENT_INDEX, &agent, IndexOrder::Descending),
        ["inc_a", "inc_e", "inc_b"]
    );
    assert_eq!(
        query(&store, GUIDANCE_INDEX, &model, IndexOrder::Descending),
        ["inc_c", "inc_e", "inc_b"]
    );
    let request = tuple_key(&[
        KeyPart::String(&s("grq_inc_c")),
        KeyPart::String(&s("ses_one")),
        KeyPart::String(&s("guardrail-rejected")),
    ]);
    assert_eq!(
        query(&store, REQUEST_INDEX, &request, IndexOrder::Ascending),
        ["inc_c"]
    );
    assert_eq!(
        query(&store, REQUEST_INDEX, &[], IndexOrder::Ascending).len(),
        4
    );
}

#[test]
fn expiry_deletes_bounded_batches_strictly_before_the_cutoff_with_their_index_entries() {
    let store = store();
    let rows = (0..2_401)
        .map(|time| {
            incident(
                &format!("inc_{time:05}"),
                if time % 2 == 0 {
                    "fallback"
                } else {
                    "guardrail-escalated"
                },
                time,
            )
        })
        .collect::<Vec<_>>();
    for chunk in rows.chunks(500) {
        put(&store, chunk.to_vec()).unwrap();
    }
    let cutoff = 2_400;
    assert!(model_incident::has_expired(&store.snapshot().unwrap(), cutoff).unwrap());
    let mut deleted = Vec::new();
    loop {
        let removed = store
            .submit(move |tx| model_incident::delete_expired(tx, cutoff))
            .unwrap()
            .wait()
            .unwrap();
        deleted.push(removed);
        if removed < CLEANUP_ROWS {
            break;
        }
    }
    assert_eq!(CLEANUP_ROWS, 1_000);
    assert_eq!(deleted, [1_000, 1_000, 400]);
    assert!(!model_incident::has_expired(&store.snapshot().unwrap(), cutoff).unwrap());
    assert_eq!(
        all(&store)
            .iter()
            .map(|row| row.time_created)
            .collect::<Vec<_>>(),
        [2_400]
    );
    for index in [TIME_INDEX, REQUEST_INDEX, GUIDANCE_INDEX] {
        assert!(
            query(&store, index, &[], IndexOrder::Ascending).len() <= 1,
            "{index}"
        );
    }
    assert_eq!(
        query(&store, TIME_INDEX, &[], IndexOrder::Ascending),
        ["inc_02400"]
    );
}

#[test]
fn guidance_watermarks_are_keyed_by_provider_and_model_and_reject_negative_times() {
    let store = store();
    let watermark = |provider: &str, model: &str, at: i64| GuidanceClear {
        provider_id: s(provider),
        model_id: s(model),
        cleared_at: at,
    };
    store
        .submit(move |tx| {
            GuidanceClearTable::put(tx, &watermark("openai", "gpt", 5))?;
            GuidanceClearTable::put(tx, &watermark("openai", "mini", 6))?;
            GuidanceClearTable::put(tx, &watermark("openai", "gpt", 9))
        })
        .unwrap()
        .wait()
        .unwrap();
    let rows = store
        .snapshot()
        .unwrap()
        .scan::<GuidanceClearTable>(Bound::Unbounded, Bound::Unbounded, 10)
        .unwrap();
    assert_eq!(
        rows,
        [
            watermark("openai", "gpt", 9),
            watermark("openai", "mini", 6)
        ]
    );
    for bad in [
        watermark("openai", "gpt", -1),
        watermark("", "gpt", 1),
        watermark("openai", "", 1),
    ] {
        assert!(
            store
                .submit(move |tx| GuidanceClearTable::put(tx, &bad))
                .unwrap()
                .wait()
                .is_err()
        );
    }
}
