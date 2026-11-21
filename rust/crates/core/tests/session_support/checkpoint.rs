#![allow(dead_code)]

use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_core::{
    session::{
        compaction_job::{AdmitInput, EndInput, FailInput, Lease, Target},
        pending::Request,
        prompt_cache::sha256,
        store::Service,
    },
    ycoding_schema::{
        self, DomainDecode, DomainEncode, JsonValue, ObjectEncoder, event, parse_json,
        schema::NonNegativeInt, session, session_compaction, session_message, session_pending,
    },
    ycoding_store::{
        self, Client, KeyPart,
        session::{
            ContextState, ContextStateTable, Document, Manifest, ManifestTable, MessageTable,
            NewEvent, Revision, RevisionTable,
        },
        tuple_key,
    },
};

pub const SUMMARY: &str = "Checkpoint summary of the covered conversation.";

static NEXT: AtomicU64 = AtomicU64::new(1);

fn next(prefix: &str) -> String {
    format!("{prefix}{:06}", NEXT.fetch_add(1, Ordering::Relaxed))
}

pub fn key(value: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&value.into())])
}

pub fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

pub fn message_id(value: &str) -> session_message::Id {
    session_message::Id::new(value).unwrap()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Succeeded,
    Failed,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Compaction {
    Ended,
    Failed,
    Remote,
}

#[derive(Clone, Debug)]
pub struct Ids {
    pub first_user: String,
    pub first_answer: String,
    pub fork_target: String,
    pub failed_answer: String,
    pub covered_user: String,
    pub boundary: String,
    pub tail_user: String,
    pub tail_answer: String,
    pub failed_tail: String,
}

#[derive(Clone, Debug)]
pub struct Scenario {
    pub session: session::Id,
    pub fork: session::Id,
    pub job: String,
    pub failed_job: String,
    pub ids: Ids,
    pub through: i64,
}

pub fn session(client: &Client, name: &str) {
    let name = name.to_string();
    client
        .submit(move |tx| {
            let id: ycoding_schema::LosslessString = name.as_str().into();
            if tx
                .get::<ycoding_store::session::SessionTable>(&key(&name))?
                .is_none()
            {
                ycoding_store::session::SessionTable::insert(tx, &super::support::record(&name))?;
            }
            if tx.get::<ContextStateTable>(&key(&name))?.is_some() {
                return Ok(());
            }
            RevisionTable::insert(
                tx,
                &Revision {
                    session_id: id.clone(),
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
                    session_id: id,
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
}

pub fn event(session: &str, kind: &str, now: i64, fields: &str) -> NewEvent {
    NewEvent {
        id: next("evt_e").as_str().into(),
        aggregate_id: session.into(),
        created: now,
        type_: kind.into(),
        data: parse_json(&format!(r#"{{"sessionID":"{session}"{fields}}}"#)).unwrap(),
    }
}

pub async fn publish(service: &Service, session: &str, kind: &str, now: i64, fields: &str) {
    service
        .publish(event(session, kind, now, fields))
        .await
        .unwrap();
}

pub async fn admit(service: &Service, session: &str, input: &str, text: &str, now: i64) {
    service
        .admit(Request {
            id: message_id(input),
            session_id: id(session),
            input: session_pending::Message::decode(
                &parse_json(&format!(
                    r#"{{"type":"user","data":{{"text":"{text}"}},"delivery":"steer"}}"#
                ))
                .unwrap(),
            )
            .unwrap(),
            event_id: event::Id::new(next("evt_a")).unwrap(),
            created: now,
        })
        .await
        .unwrap();
}

pub async fn user(service: &Service, session: &str, text: &str, now: i64) -> String {
    let input = next("msg_u");
    admit(service, session, &input, text, now).await;
    service
        .promote_input(&id(session), &input.as_str().into(), now)
        .await
        .unwrap();
    publish(
        service,
        session,
        "session.input.consumed.1",
        now,
        &format!(r#","inputIDs":["{input}"]"#),
    )
    .await;
    input
}

pub async fn assistant(
    service: &Service,
    session: &str,
    text: &str,
    outcome: Outcome,
    now: i64,
) -> String {
    let assistant = next("msg_s");
    let at = format!(r#","assistantMessageID":"{assistant}""#);
    publish(
        service,
        session,
        "session.step.started.1",
        now,
        &format!(r#"{at},"agent":"build","model":{{"providerID":"test","id":"summary-model"}}"#),
    )
    .await;
    publish(
        service,
        session,
        "session.text.started.1",
        now,
        &format!(r#"{at},"ordinal":0"#),
    )
    .await;
    publish(
        service,
        session,
        "session.text.ended.1",
        now,
        &format!(r#"{at},"ordinal":0,"text":"{text}""#),
    )
    .await;
    publish(
        service,
        session,
        "session.tool.input.started.1",
        now,
        &format!(r#"{at},"callID":"call","name":"read""#),
    )
    .await;
    publish(
        service,
        session,
        "session.tool.called.1",
        now,
        &format!(r#"{at},"callID":"call","input":{{"path":"README.md"}},"executed":true"#),
    )
    .await;
    if outcome == Outcome::Failed {
        publish(
            service,
            session,
            "session.tool.failed.1",
            now,
            &format!(
                r#"{at},"callID":"call","error":{{"type":"aborted","message":"Tool failed"}},"executed":true"#
            ),
        )
        .await;
        publish(
            service,
            session,
            "session.step.failed.1",
            now,
            &format!(r#"{at},"error":{{"type":"provider.failed","message":"Step failed"}}"#),
        )
        .await;
        return assistant;
    }
    publish(
        service,
        session,
        "session.tool.success.1",
        now,
        &format!(
            r#"{at},"callID":"call","structured":{{}},"content":[{{"type":"text","text":"file contents"}}],"executed":true"#
        ),
    )
    .await;
    publish(
        service,
        session,
        "session.step.ended.1",
        now,
        &format!(
            r#"{at},"finish":"stop","cost":0.5,"tokens":{{"input":1,"output":1,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#
        ),
    )
    .await;
    assistant
}

pub async fn run(
    service: &Service,
    session: &str,
    text: &str,
    outcome: Outcome,
    now: i64,
) -> String {
    publish(service, session, "session.execution.started.1", now, "").await;
    let assistant = assistant(service, session, text, outcome, now).await;
    match outcome {
        Outcome::Failed => {
            publish(
                service,
                session,
                "session.execution.failed.1",
                now,
                r#","error":{"type":"provider.failed","message":"Execution failed"}"#,
            )
            .await
        }
        Outcome::Succeeded => {
            publish(service, session, "session.execution.succeeded.1", now, "").await
        }
    }
    assistant
}

pub async fn observe(service: &Service, session: &str, source: &str, text: &str, now: i64) {
    publish(
        service,
        session,
        "session.context.observed.1",
        now,
        &format!(r#","source":"{source}","text":"{text}""#),
    )
    .await;
}

pub fn seq(client: &Client, message: &str) -> i64 {
    client
        .snapshot()
        .unwrap()
        .get::<MessageTable>(&key(message))
        .unwrap()
        .unwrap()
        .seq
}

pub async fn compaction(
    client: &Client,
    service: &Service,
    session: &str,
    boundary: &str,
    kind: Compaction,
    now: i64,
) -> String {
    let snapshot = client.snapshot().unwrap();
    let revision = snapshot
        .get::<ContextStateTable>(&key(session))
        .unwrap()
        .unwrap()
        .revision;
    let row = snapshot
        .get::<MessageTable>(&key(boundary))
        .unwrap()
        .unwrap();
    let job = service
        .compaction_admit(
            AdmitInput {
                id: None,
                session: id(session),
                trigger: session_compaction::Trigger::Manual,
                requested_through_message: message_id(boundary),
                requested_through_seq: row.seq,
                base_context_revision: revision,
                target_max_input_tokens: 1000,
                config_digest: "c".repeat(64),
                pressure: None,
            },
            now,
        )
        .await
        .unwrap();
    let job_id = session_compaction::Id::decode(&JsonValue::String(job.id.clone())).unwrap();
    service
        .compaction_claim(
            Target::Job(job_id.clone()),
            Lease {
                owner: "owner".into(),
                now,
                expires_at: now + 60_000,
            },
        )
        .await
        .unwrap()
        .unwrap();
    if kind == Compaction::Failed {
        service
            .compaction_fail(FailInput {
                id: job_id,
                owner: Some("owner".into()),
                code: session_compaction::FailureCode::ProviderFailed,
                now,
            })
            .await
            .unwrap();
        return job.id.to_utf8().unwrap();
    }
    let covered = ObjectEncoder::new()
        .field("messageID", boundary)
        .field("seq", &(row.seq as f64))
        .finish();
    let manifest = ObjectEncoder::new()
        .field("schemaVersion", &1.0)
        .field("baseContextRevision", &(revision as f64))
        .field("coveredThrough", &covered)
        .field("protectedState", &JsonValue::Array(vec![]))
        .field("exclusions", &JsonValue::Array(vec![]))
        .field("inputTokens", &1000.0)
        .field("retainedTokens", &100.0);
    let manifest = match kind {
        Compaction::Remote => manifest.field(
            "remote",
            &parse_json(&format!(
                r#"{{"provider":"openai","modelID":"gpt-5.6","digest":"{}","itemID":"item_remote","retained":[]}}"#,
                "a".repeat(64)
            ))
            .unwrap(),
        ),
        _ => manifest.field(
            "summary",
            &ObjectEncoder::new()
                .field("text", SUMMARY)
                .field("coveredThrough", &covered)
                .field("digest", &ycoding_core::instructions::hash(&row.data).encode())
                .finish(),
        ),
    }
    .finish();
    let digest = sha256(&format!(
        "{session}:{}:{}",
        job.id.to_utf8().unwrap(),
        row.seq
    ));
    let stored = digest.clone();
    client
        .submit(move |tx| {
            ManifestTable::insert(
                tx,
                &Manifest {
                    digest: stored.as_str().into(),
                    schema_version: 1,
                    content: Document::new(manifest)?,
                    input_tokens: 1000,
                    retained_tokens: 100,
                    time_created: now,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    service
        .compaction_end(EndInput {
            id: job_id,
            owner: "owner".into(),
            manifest_digest: digest,
            revision: revision + 1,
            boundary: session_compaction::Boundary {
                message_id: message_id(boundary),
                seq: NonNegativeInt::new(row.seq).unwrap(),
            },
            metrics: session_compaction::Metrics {
                excluded_messages: NonNegativeInt::new(3).unwrap(),
                excluded_parts: NonNegativeInt::new(0).unwrap(),
                input_tokens: NonNegativeInt::new(1000).unwrap(),
                retained_tokens: NonNegativeInt::new(100).unwrap(),
            },
            now,
        })
        .await
        .unwrap();
    job.id.to_utf8().unwrap()
}

/// The TS `scenario`: covered history with a failed compaction and a fork below an ended local checkpoint, then a tail.
pub async fn scenario(client: &Client, service: &Service, name: &str, now: i64) -> Scenario {
    session(client, name);
    let first_user = user(service, name, "First request", now).await;
    let first_answer = run(service, name, "First answer", Outcome::Succeeded, now).await;
    observe(service, name, "session-state", "state before", now).await;
    observe(service, name, "team-view", "team before", now).await;
    publish(
        service,
        name,
        "session.synthetic.1",
        now,
        r#","text":"Covered synthetic note""#,
    )
    .await;
    let failed_job = compaction(
        client,
        service,
        name,
        &first_answer,
        Compaction::Failed,
        now,
    )
    .await;
    let fork_target = user(service, name, "Second request", now).await;
    let failed_answer = run(service, name, "Failed answer", Outcome::Failed, now).await;
    let fork = service
        .fork(&id(name), Some(message_id(&fork_target)))
        .await
        .unwrap()
        .id;
    let covered_user = user(service, name, "Third request", now).await;
    let boundary = run(service, name, "Boundary answer", Outcome::Succeeded, now).await;
    let job = compaction(client, service, name, &boundary, Compaction::Ended, now).await;
    observe(service, name, "session-state", "state after", now).await;
    let tail_user = user(service, name, "Fourth request", now).await;
    let tail_answer = run(service, name, "Fourth answer", Outcome::Succeeded, now).await;
    let failed_tail = run(service, name, "Failed tail", Outcome::Failed, now).await;
    compaction(client, service, name, &tail_answer, Compaction::Failed, now).await;
    Scenario {
        session: id(name),
        fork,
        job,
        failed_job,
        through: seq(client, &boundary),
        ids: Ids {
            first_user,
            first_answer,
            fork_target,
            failed_answer,
            covered_user,
            boundary,
            tail_user,
            tail_answer,
            failed_tail,
        },
    }
}
