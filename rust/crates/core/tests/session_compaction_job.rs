use ycoding_core::session::{
    compaction_job::{AdmitInput, CompactionError, EndInput, FailInput, Lease, Target},
    store::Service,
};
use ycoding_schema::{
    DomainDecode, JsonValue, parse_json, schema::NonNegativeInt, session, session_compaction,
    session_message, session_message::Info,
};
use ycoding_store::{
    resources::{StateBlob, StateLink, StateLinkTable},
    session::{
        ContextState, ContextStateTable, Document, Manifest, ManifestTable, MessageTable, Revision,
        RevisionTable,
    },
};

#[path = "session_support/mod.rs"]
mod support;

fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

async fn prepared() -> (ycoding_store::Store, Service, session_message::Id, i64) {
    let store = support::store();
    store
        .submit(|tx| {
            RevisionTable::insert(
                tx,
                &Revision {
                    session_id: "ses_one".into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            ContextStateTable::insert(
                tx,
                &ContextState {
                    session_id: "ses_one".into(),
                    status: "active".into(),
                    revision: 0,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activated_event_id: None,
                    time_activated: None,
                    error_code: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new("msg_input").unwrap(),
            session_id: id(),
            input: ycoding_schema::session_pending::Message::decode(
                &parse_json(r#"{"type":"user","data":{"text":"History"},"delivery":"steer"}"#)
                    .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_input").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
    service.promote_steers(&id(), 2).await.unwrap();
    let seq = store
        .snapshot()
        .unwrap()
        .get::<MessageTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"msg_input".into()),
        ]))
        .unwrap()
        .unwrap()
        .seq;
    (
        store,
        service,
        session_message::Id::new("msg_input").unwrap(),
        seq,
    )
}

fn admission(
    message: &session_message::Id,
    seq: i64,
    trigger: session_compaction::Trigger,
) -> AdmitInput {
    AdmitInput {
        id: None,
        session: id(),
        trigger,
        requested_through_message: message.clone(),
        requested_through_seq: seq,
        base_context_revision: 0,
        target_max_input_tokens: 1000,
        config_digest: "c".repeat(64),
        pressure: Some(session_compaction::Pressure {
            estimated_input_tokens: NonNegativeInt::new(900).unwrap(),
            safe_input_tokens: NonNegativeInt::new(800).unwrap(),
        }),
    }
}

fn compactions(service: &Service) -> Vec<session_message::Compaction> {
    service
        .context(&id())
        .unwrap()
        .into_iter()
        .filter_map(|message| match message {
            Info::Compaction(compaction) => Some(compaction),
            _ => None,
        })
        .collect()
}

fn event_types(store: &ycoding_store::Store) -> Vec<String> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .map(|event| event.record.type_.as_str().unwrap().to_string())
        .filter(|kind| kind.starts_with("session.compaction"))
        .collect()
}

fn lease(owner: &str, now: i64, expires_at: i64) -> Lease {
    Lease {
        owner: owner.into(),
        now,
        expires_at,
    }
}

#[tokio::test]
async fn admission_projects_one_pending_message_and_is_idempotent_by_identity_and_trigger() {
    let (store, service, message, seq) = prepared().await;
    let job = service
        .compaction_admit(
            admission(&message, seq, session_compaction::Trigger::Mandatory),
            10,
        )
        .await
        .unwrap();
    assert_eq!(job.status.as_str(), Some("pending"));
    assert_eq!(job.trigger.as_str(), Some("mandatory"));
    let all = compactions(&service);
    let [session_message::Compaction::Pending(pending)] = all.as_slice() else {
        panic!()
    };
    assert_eq!(
        pending
            .pressure
            .as_ref()
            .unwrap()
            .estimated_input_tokens
            .get(),
        900
    );
    let advised = service
        .compaction_admit(
            admission(&message, seq, session_compaction::Trigger::Advised),
            11,
        )
        .await
        .unwrap();
    assert_eq!(advised.id, job.id);
    let reused = AdmitInput {
        id: Some(session_compaction::Id::decode(&JsonValue::String(job.id.clone())).unwrap()),
        target_max_input_tokens: 999,
        ..admission(&message, seq, session_compaction::Trigger::Mandatory)
    };
    assert!(matches!(
        service.compaction_admit(reused, 12).await,
        Err(CompactionError::Conflict { .. })
    ));
    let stale = AdmitInput {
        base_context_revision: 3,
        ..admission(&message, seq, session_compaction::Trigger::Manual)
    };
    assert!(matches!(
        service.compaction_admit(stale, 13).await,
        Err(CompactionError::Conflict { .. })
    ));
    assert_eq!(event_types(&store), vec!["session.compaction.admitted.2"]);
}

#[tokio::test]
async fn an_incompatible_admission_supersedes_the_pending_job_and_a_compatible_one_extends_it() {
    let (store, service, message, seq) = prepared().await;
    let first = service
        .compaction_admit(
            admission(&message, seq, session_compaction::Trigger::Mandatory),
            10,
        )
        .await
        .unwrap();
    let changed = AdmitInput {
        target_max_input_tokens: 500,
        ..admission(&message, seq, session_compaction::Trigger::Manual)
    };
    let second = service.compaction_admit(changed, 11).await.unwrap();
    assert_ne!(second.id, first.id);
    let old = service
        .compaction_job(
            &session_compaction::Id::decode(&JsonValue::String(first.id.clone())).unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(old.status.as_str(), Some("failed"));
    assert_eq!(
        old.error_code.as_ref().and_then(|code| code.as_str()),
        Some("superseded")
    );
    assert!(compactions(&service).iter().any(|message| matches!(
        message,
        session_message::Compaction::Failed(failed) if failed.code == session_compaction::FailureCode::Superseded
    )));
    assert_eq!(
        event_types(&store),
        vec![
            "session.compaction.admitted.2",
            "session.compaction.failed.2",
            "session.compaction.admitted.2"
        ]
    );
    let pending = service.compaction_pending(&id()).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, second.id);
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new("msg_later").unwrap(),
            session_id: id(),
            input: ycoding_schema::session_pending::Message::decode(
                &parse_json(r#"{"type":"user","data":{"text":"Later"},"delivery":"steer"}"#)
                    .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_later").unwrap(),
            created: 3,
        })
        .await
        .unwrap();
    service.promote_steers(&id(), 4).await.unwrap();
    let later_seq = store
        .snapshot()
        .unwrap()
        .get::<MessageTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"msg_later".into()),
        ]))
        .unwrap()
        .unwrap()
        .seq;
    let extended = service
        .compaction_admit(
            AdmitInput {
                target_max_input_tokens: 500,
                ..admission(
                    &session_message::Id::new("msg_later").unwrap(),
                    later_seq,
                    session_compaction::Trigger::Manual,
                )
            },
            14,
        )
        .await
        .unwrap();
    assert_eq!(extended.id, second.id);
    assert_eq!(extended.requested_through_seq, later_seq);
    assert_eq!(
        extended.requested_through_message_id.as_str(),
        Some("msg_later")
    );
}

#[tokio::test]
async fn a_claim_runs_the_job_once_and_only_an_expired_lease_is_reclaimed() {
    let (store, service, message, seq) = prepared().await;
    let job = service
        .compaction_admit(
            admission(&message, seq, session_compaction::Trigger::Mandatory),
            10,
        )
        .await
        .unwrap();
    let claimed = service
        .compaction_claim(Target::Session(id()), lease("owner-a", 20, 30))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.status.as_str(), Some("running"));
    assert_eq!(claimed.attempts, 1);
    assert!(matches!(
        compactions(&service).as_slice(),
        [session_message::Compaction::Running(_)]
    ));
    assert!(
        service
            .compaction_claim(Target::Session(id()), lease("owner-b", 25, 40))
            .await
            .unwrap()
            .is_none()
    );
    let job_id = session_compaction::Id::decode(&JsonValue::String(job.id.clone())).unwrap();
    assert!(matches!(
        service
            .compaction_heartbeat(job_id.clone(), "owner-b".into(), 50)
            .await,
        Err(CompactionError::Ownership { .. })
    ));
    let extended = service
        .compaction_heartbeat(job_id.clone(), "owner-a".into(), 60)
        .await
        .unwrap();
    assert_eq!(extended.lease_expires_at, Some(60));
    assert!(
        service
            .compaction_claim(Target::Job(job_id.clone()), lease("owner-b", 59, 70))
            .await
            .unwrap()
            .is_none()
    );
    let reclaimed = service
        .compaction_claim(Target::Job(job_id), lease("owner-b", 60, 70))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reclaimed.attempts, 2);
    assert_eq!(
        reclaimed
            .lease_owner
            .as_ref()
            .and_then(|owner| owner.as_str()),
        Some("owner-b")
    );
    assert!(matches!(
        service
            .compaction_claim(Target::Session(id()), lease("", 1, 2))
            .await,
        Err(CompactionError::Conflict { .. })
    ));
    assert_eq!(
        event_types(&store),
        vec![
            "session.compaction.admitted.2",
            "session.compaction.started.2"
        ]
    );
}

fn manifest(store: &ycoding_store::Store, digest: &str, message: &str, seq: i64) {
    let digest = digest.to_string();
    let content = format!(
        r#"{{"schemaVersion":1,"baseContextRevision":0,"coveredThrough":{{"messageID":"{message}","seq":{seq}}},"protectedState":[],"exclusions":[],"inputTokens":10,"retainedTokens":5}}"#
    );
    store
        .submit(move |tx| {
            ManifestTable::insert(
                tx,
                &Manifest {
                    digest: digest.as_str().into(),
                    schema_version: 1,
                    content: Document::new(parse_json(&content).unwrap())?,
                    input_tokens: 10,
                    retained_tokens: 5,
                    time_created: 3,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn settlement(
    job: &ycoding_store::session::Job,
    owner: &str,
    digest: &str,
    revision: i64,
) -> EndInput {
    EndInput {
        id: session_compaction::Id::decode(&JsonValue::String(job.id.clone())).unwrap(),
        owner: owner.into(),
        manifest_digest: digest.into(),
        revision,
        boundary: session_compaction::Boundary {
            message_id: session_message::Id::decode(&JsonValue::String(
                job.requested_through_message_id.clone(),
            ))
            .unwrap(),
            seq: NonNegativeInt::new(job.requested_through_seq).unwrap(),
        },
        metrics: session_compaction::Metrics {
            excluded_messages: NonNegativeInt::new(2).unwrap(),
            excluded_parts: NonNegativeInt::new(3).unwrap(),
            input_tokens: NonNegativeInt::new(10).unwrap(),
            retained_tokens: NonNegativeInt::new(5).unwrap(),
        },
        now: 40,
    }
}

#[tokio::test]
async fn settlement_requires_the_lease_revision_boundary_and_a_durable_manifest() {
    let (store, service, message, seq) = prepared().await;
    service
        .compaction_admit(
            admission(&message, seq, session_compaction::Trigger::Mandatory),
            10,
        )
        .await
        .unwrap();
    let running = service
        .compaction_claim(Target::Session(id()), lease("owner-a", 20, 30))
        .await
        .unwrap()
        .unwrap();
    let digest = "d".repeat(64);
    assert!(matches!(
        service
            .compaction_end(settlement(&running, "owner-a", &digest, 1))
            .await,
        Err(CompactionError::Conflict { .. })
    ));
    let bad = "b".repeat(64);
    let bad_content = bad.clone();
    store
        .submit(move |tx| {
            ManifestTable::insert(
                tx,
                &Manifest {
                    digest: bad_content.as_str().into(),
                    schema_version: 1,
                    content: Document::new(parse_json(r#"{"items":[]}"#).unwrap())?,
                    input_tokens: 10,
                    retained_tokens: 5,
                    time_created: 3,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(matches!(
        service
            .compaction_end(settlement(&running, "owner-a", &bad, 1))
            .await,
        Err(CompactionError::Conflict { .. })
    ));
    manifest(&store, &digest, "msg_input", seq);
    assert!(matches!(
        service
            .compaction_end(settlement(&running, "owner-b", &digest, 1))
            .await,
        Err(CompactionError::Ownership { .. })
    ));
    assert!(matches!(
        service
            .compaction_end(settlement(&running, "owner-a", &digest, 5))
            .await,
        Err(CompactionError::Conflict { .. })
    ));
    let ended = service
        .compaction_end(settlement(&running, "owner-a", &digest, 1))
        .await
        .unwrap();
    assert_eq!(ended.status.as_str(), Some("ended"));
    assert_eq!(
        ended
            .manifest_digest
            .as_ref()
            .and_then(|value| value.as_str()),
        Some(digest.as_str())
    );
    let all = compactions(&service);
    let [session_message::Compaction::Completed(completed)] = all.as_slice() else {
        panic!()
    };
    assert_eq!(completed.revision.get(), 1);
    assert_eq!(completed.metrics.excluded_parts.get(), 3);
    let state = store
        .snapshot()
        .unwrap()
        .get::<ContextStateTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(state.revision, 1);
    assert_eq!(
        state
            .manifest_digest
            .as_ref()
            .and_then(|value| value.as_str()),
        Some(digest.as_str())
    );
    assert_eq!(
        state
            .covered_through_message_id
            .as_ref()
            .and_then(|value| value.as_str()),
        Some("msg_input")
    );
    assert_eq!(state.covered_through_seq, Some(seq));
    let revision = store
        .snapshot()
        .unwrap()
        .get::<RevisionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
            ycoding_store::KeyPart::I64(1),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(revision.parent_revision, Some(0));
    assert_eq!(
        revision
            .manifest_digest
            .as_ref()
            .and_then(|value| value.as_str()),
        Some(digest.as_str())
    );
    assert_eq!(
        service
            .compaction_end(settlement(&running, "owner-a", &digest, 1))
            .await
            .unwrap()
            .id,
        ended.id
    );
    assert!(matches!(
        service
            .compaction_end(settlement(&running, "owner-a", &"e".repeat(64), 1))
            .await,
        Err(CompactionError::Conflict { .. })
    ));
    assert_eq!(
        event_types(&store),
        vec![
            "session.compaction.admitted.2",
            "session.compaction.started.2",
            "session.compaction.ended.2"
        ]
    );
}

fn state_link(store: &ycoding_store::Store, message: &str, digest: &str) {
    let message = message.to_string();
    let digest = digest.to_string();
    store
        .submit(move |tx| {
            ycoding_store::resources::capture_state(
                tx,
                &StateBlob {
                    digest: digest.as_str().into(),
                    provider: "openai".into(),
                    model_id: "gpt".into(),
                    item_type: "compaction".into(),
                    content: Document::new(parse_json(r#"{"type":"compaction"}"#).unwrap())?,
                    time_created: 1,
                },
                &StateLink {
                    session_id: "ses_one".into(),
                    message_id: message.as_str().into(),
                    part_ordinal: 0,
                    part_kind: "reasoning".into(),
                    provider: "openai".into(),
                    model_id: "gpt".into(),
                    blob_digest: digest.as_str().into(),
                    context_revision: 0,
                    time_created: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn has_state_link(store: &ycoding_store::Store, message: &str) -> bool {
    store
        .snapshot()
        .unwrap()
        .get::<StateLinkTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
            ycoding_store::KeyPart::String(&message.into()),
            ycoding_store::KeyPart::I64(0),
            ycoding_store::KeyPart::String(&"reasoning".into()),
        ]))
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn activation_rebases_provider_state_links_through_the_boundary_and_keeps_later_ones() {
    let (store, service, message, seq) = prepared().await;
    state_link(&store, "msg_input", &"a".repeat(64));
    state_link(&store, "msg_after", &"b".repeat(64));
    service
        .compaction_admit(
            admission(&message, seq, session_compaction::Trigger::Mandatory),
            10,
        )
        .await
        .unwrap();
    let running = service
        .compaction_claim(Target::Session(id()), lease("owner-a", 20, 30))
        .await
        .unwrap()
        .unwrap();
    let digest = "d".repeat(64);
    manifest(&store, &digest, "msg_input", seq);
    assert!(has_state_link(&store, "msg_input"));
    service
        .compaction_end(settlement(&running, "owner-a", &digest, 1))
        .await
        .unwrap();
    assert!(!has_state_link(&store, "msg_input"));
    assert!(has_state_link(&store, "msg_after"));
}

#[tokio::test]
async fn failures_follow_the_status_and_owner_rules_and_deterministic_ones_are_remembered() {
    let (_store, service, message, seq) = prepared().await;
    let job = service
        .compaction_admit(
            admission(&message, seq, session_compaction::Trigger::Mandatory),
            10,
        )
        .await
        .unwrap();
    let job_id = session_compaction::Id::decode(&JsonValue::String(job.id.clone())).unwrap();
    let fail = |owner: Option<&str>, code| FailInput {
        id: job_id.clone(),
        owner: owner.map(str::to_string),
        code,
        now: 50,
    };
    assert!(matches!(
        service
            .compaction_fail(fail(None, session_compaction::FailureCode::ProviderFailed))
            .await,
        Err(CompactionError::Conflict { .. })
    ));
    service
        .compaction_claim(Target::Session(id()), lease("owner-a", 20, 30))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        service
            .compaction_fail(fail(
                Some("owner-b"),
                session_compaction::FailureCode::ContextLimitUnresolved
            ))
            .await,
        Err(CompactionError::Ownership { .. })
    ));
    let failed = service
        .compaction_fail(fail(
            Some("owner-a"),
            session_compaction::FailureCode::ContextLimitUnresolved,
        ))
        .await
        .unwrap();
    assert_eq!(
        failed
            .error_message
            .as_ref()
            .and_then(|value| value.as_str()),
        Some("Compaction did not resolve the context limit")
    );
    assert!(matches!(
        service
            .compaction_fail(fail(
                Some("owner-a"),
                session_compaction::FailureCode::Cancelled
            ))
            .await,
        Err(CompactionError::Conflict { .. })
    ));
    let all = compactions(&service);
    let [session_message::Compaction::Failed(message_failed)] = all.as_slice() else {
        panic!()
    };
    assert_eq!(
        message_failed.error.r#type.as_str(),
        Some("compaction_context_limit_unresolved")
    );
    let unchanged = admission(&message, seq, session_compaction::Trigger::Mandatory);
    assert!(
        service
            .compaction_has_unchanged_deterministic_failure(AdmitInput { ..unchanged })
            .await
            .unwrap()
    );
    let changed = AdmitInput {
        target_max_input_tokens: 1,
        ..admission(&message, seq, session_compaction::Trigger::Mandatory)
    };
    assert!(
        !service
            .compaction_has_unchanged_deterministic_failure(changed)
            .await
            .unwrap()
    );
}
