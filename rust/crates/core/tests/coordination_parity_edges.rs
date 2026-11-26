use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::{
    coordination::{self, OwnerInput, Service as Coordination},
    event_feed::{Feed, Payload},
    job,
    session::{
        execution::{Execution, Locations, Runner},
        run_coordinator::{DrainRequest, Error, RunFuture},
        store::Service,
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, ObjectEncoder, coordination as c, model, parse_json, session,
    session_message,
};
use ycoding_store::{
    Client, KeyPart, Metadata, Options, Store, native,
    session::{self as tables, Document, PendingTable, SessionTable, TaskTable},
    tuple_key,
};

#[path = "session_support/record.rs"]
mod support;

fn id(text: &str) -> session::Id {
    session::Id::new(text).unwrap()
}

fn task(child: &str, parent: &str, state: &str) -> tables::Task {
    tables::Task {
        session_id: child.into(),
        parent_id: parent.into(),
        parent_assistant_message_id: "msg_parent".into(),
        tool_call_id: format!("call_{child}").into(),
        input_id: format!("msg_input_{child}").into(),
        description: "Synthetic work".into(),
        agent: "build".into(),
        model: Document::new(parse_json(r#"{"providerID":"test","id":"test"}"#).unwrap()).unwrap(),
        prompt_digest: "0".repeat(64).into(),
        background: 1,
        delivery: "steer".into(),
        state: state.into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        usage_anchor: None,
        attempt_started: 0,
        owner_pid: None,
        owner_started: None,
        revision: 1,
        time_created: 1,
        time_updated: 1,
    }
}

struct Controls;

impl coordination::runtime::Decisions for Controls {
    fn settings(&self) -> coordination::runtime::Future<'_, c::Settings> {
        Box::pin(async {
            Ok(c::Settings {
                enabled: false,
                categories: vec![],
                actions: None,
                resources: None,
                expires_at: None,
            })
        })
    }

    fn pending(
        &self,
        _: coordination::runtime::PendingInput,
    ) -> coordination::runtime::Future<'_, Vec<coordination::runtime::Pending>> {
        Box::pin(async { Ok(vec![]) })
    }

    fn evaluate(
        &self,
        _: coordination::runtime::EvaluateInput,
    ) -> coordination::runtime::Future<'_, coordination::runtime::DecisionResult> {
        Box::pin(async {
            Err(coordination::Error::refused(
                "No native decision is pending",
            ))
        })
    }

    fn escalate(
        &self,
        _: coordination::runtime::DecisionEscalateInput,
    ) -> coordination::runtime::Future<'_, coordination::runtime::DecisionEscalateResult> {
        Box::pin(async {
            Err(coordination::Error::refused(
                "No native decision is pending",
            ))
        })
    }
}

struct NoticeRunner(Service);

impl Runner for NoticeRunner {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let sessions = self.0.clone();
        Box::pin(async move {
            sessions.promote_steers(&request.session_id, 30).await?;
            Ok(())
        })
    }
}

struct Placement {
    runner: Arc<NoticeRunner>,
    calls: Arc<AtomicUsize>,
}

impl Locations for Placement {
    fn get(&self, _: &ycoding_schema::session::Info) -> Result<Arc<dyn Runner>, Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.runner.clone())
    }
}

fn record_failure(failures: &mut Vec<String>, condition: bool, message: &str) {
    if !condition {
        failures.push(message.to_owned());
    }
}

async fn succeeded(
    client: &Client,
    runtime: &coordination::runtime::Runtime,
    member: &session::Id,
    name: &str,
) {
    let request = tables::NewEvent {
        id: name.into(),
        aggregate_id: member.as_lossless().clone(),
        created: chrono::Utc::now().timestamp_millis(),
        type_: "session.execution.succeeded.1".into(),
        data: ObjectEncoder::new().field("sessionID", member).finish(),
    };
    let event = client
        .submit(move |tx| {
            let tables::Append::Appended(event) = tables::append(tx, &request, None)? else {
                return Err(ycoding_store::Error::Rejected(
                    "Expected a new success event",
                ));
            };
            Ok(event)
        })
        .unwrap()
        .await
        .unwrap();
    runtime
        .handle(&Payload::Durable(event.clone()))
        .await
        .unwrap();
    runtime.handle(&Payload::Durable(event)).await.unwrap();
}

fn notices(sessions: &Service, receiver: &session::Id, kind: &str) -> usize {
    sessions
        .log(receiver, None, 200)
        .unwrap()
        .events
        .into_iter()
        .filter(|entry| entry.event.0.event_type.as_str() == Some("session.input.admitted"))
        .filter(|event| {
            let data = &event.event.0.data.0;
            let Some(JsonValue::Object(input)) = data.get(&"input".into()) else {
                return false;
            };
            let Some(JsonValue::Object(data)) = input.get(&"data".into()) else {
                return false;
            };
            let Some(JsonValue::Object(metadata)) = data.get(&"metadata".into()) else {
                return false;
            };
            metadata.get(&"event".into()) == Some(&JsonValue::String(kind.into()))
        })
        .count()
}

fn completed_notices(sessions: &Service, receiver: &session::Id) -> usize {
    notices(sessions, receiver, "completed")
}

async fn capacity_refusal(
    runtime: &coordination::runtime::Runtime,
    sessions: &Service,
    master: &session::Id,
    beta: &session::Id,
    message: &str,
    failures: &mut Vec<String>,
) {
    let message_id = session_message::Id::new(message).unwrap();
    let result = runtime
        .send(
            master,
            coordination::runtime::SendInput {
                session_id: beta.clone(),
                text: "Second job".into(),
                delivery: None,
                message_id: Some(message_id.clone()),
                model: Some(
                    model::Ref::decode(
                        &parse_json(r#"{"providerID":"test","id":"test"}"#).unwrap(),
                    )
                    .unwrap(),
                ),
            },
        )
        .await;
    let refused = result.err().map(|error| error.to_string());
    record_failure(
        failures,
        refused.as_deref() == Some("Project concurrency limit 1 reached"),
        &format!("{message}: expected capacity refusal, got {refused:?}"),
    );
    record_failure(
        failures,
        sessions.pending(&message_id).unwrap().is_none()
            && sessions.message(&message_id).unwrap().is_none(),
        &format!("{message}: a refused send must not be admitted or promoted"),
    );
}

async fn group_fencing(
    client: &Client,
    coordination: &Coordination,
    runtime: &coordination::runtime::Runtime,
) {
    client
        .submit(|tx| {
            for name in [
                "ses_fence_master",
                "ses_fence_other",
                "ses_fence_root",
                "ses_fence_outsider",
            ] {
                SessionTable::insert(tx, &support::record(name))?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let master = id("ses_fence_master");
    let root = id("ses_fence_root");
    let group = coordination
        .create(c::CreateInput {
            name: "Fenced Project".into(),
            master_session_id: master.clone(),
            member_session_ids: vec![],
        })
        .await
        .unwrap();
    let other = coordination
        .create(c::CreateInput {
            name: "Other fenced Project".into(),
            master_session_id: id("ses_fence_other"),
            member_session_ids: vec![],
        })
        .await
        .unwrap();
    for caller in [&master, &id("ses_fence_outsider")] {
        let expected = format!(
            "Session {} is not the Master of Project {}",
            caller.as_lossless().as_str().unwrap(),
            other.id.as_lossless().as_str().unwrap()
        );
        let error = runtime
            .attach(
                caller,
                coordination::runtime::AttachInput {
                    session_id: root.clone(),
                    owner_session_id: None,
                },
                Box::new(|_| {
                    Box::pin(async { panic!("Refused attach must not authorize a Location") })
                }),
                Some(&other.id),
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), expected);
        let error = runtime
            .remove(
                caller,
                coordination::runtime::MemberInput {
                    session_id: root.clone(),
                },
                Some(&other.id),
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), expected);
    }
    assert_eq!(coordination.get(&group.id).unwrap(), group);
    assert_eq!(coordination.get(&other.id).unwrap(), other);
    let (entered, held) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let holder = tokio::spawn({
        let coordination = coordination.clone();
        let group_id = other.id.clone();
        async move {
            coordination
                .with_ownership(&group_id, async {
                    entered.send(()).unwrap();
                    released.await.unwrap();
                })
                .await;
        }
    });
    held.await.unwrap();
    let mut attach = Box::pin(runtime.attach(
        &master,
        coordination::runtime::AttachInput {
            session_id: root.clone(),
            owner_session_id: None,
        },
        Box::new(|_| {
            Box::pin(async { panic!("A foreign Project must refuse before authorization") })
        }),
        Some(&other.id),
    ));
    let mut remove = Box::pin(runtime.remove(
        &master,
        coordination::runtime::MemberInput {
            session_id: root.clone(),
        },
        Some(&other.id),
    ));
    std::future::poll_fn(|cx| {
        assert!(attach.as_mut().poll(cx).is_pending());
        assert!(remove.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    release.send(()).unwrap();
    holder.await.unwrap();
    let expected = format!(
        "Session ses_fence_master is not the Master of Project {}",
        other.id.as_lossless().as_str().unwrap()
    );
    assert_eq!(attach.await.unwrap_err().to_string(), expected);
    assert_eq!(remove.await.unwrap_err().to_string(), expected);
    let first = runtime
        .attach(
            &master,
            coordination::runtime::AttachInput {
                session_id: root.clone(),
                owner_session_id: None,
            },
            Box::new(|_| Box::pin(async { Ok(()) })),
            Some(&group.id),
        )
        .await
        .unwrap();
    assert_eq!(first.group_id, group.id);
    assert_eq!(first.owner_session_id, master);
    assert!(!first.reconciled);
    let revision = coordination.get(&group.id).unwrap().revision;
    let repeated = runtime
        .attach(
            &master,
            coordination::runtime::AttachInput {
                session_id: root.clone(),
                owner_session_id: Some(master.clone()),
            },
            Box::new(|_| {
                Box::pin(async { panic!("Reconciled attach must not authorize a Location") })
            }),
            Some(&group.id),
        )
        .await
        .unwrap();
    assert!(repeated.reconciled);
    assert_eq!(coordination.get(&group.id).unwrap().revision, revision);
    let removed = runtime
        .remove(
            &master,
            coordination::runtime::MemberInput {
                session_id: root.clone(),
            },
            Some(&group.id),
        )
        .await
        .unwrap();
    assert_eq!(removed.session_id, root);
    assert!(removed.removed);
    assert!(
        coordination
            .get(&group.id)
            .unwrap()
            .member_session_ids
            .is_empty()
    );
    let changed = coordination.clone();
    let group_id = group.id.clone();
    let error = runtime
        .attach(
            &master,
            coordination::runtime::AttachInput {
                session_id: root.clone(),
                owner_session_id: None,
            },
            Box::new(move |_| {
                Box::pin(async move {
                    let group = changed.get(&group_id)?;
                    changed
                        .update(
                            &group_id,
                            c::UpdateInput {
                                revision: group.revision,
                                name: None,
                                master_session_id: Some(id("ses_fence_outsider")),
                                member_session_ids: None,
                                settings: None,
                            },
                        )
                        .await?;
                    Ok(())
                })
            }),
            Some(&group.id),
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        format!(
            "Session ses_fence_master is not the Master of Project {}",
            group.id.as_lossless().as_str().unwrap()
        )
    );
    assert!(
        coordination
            .get(&group.id)
            .unwrap()
            .member_session_ids
            .is_empty()
    );
    coordination.delete(&group.id).await.unwrap();
    coordination.delete(&other.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_activity_capacity_and_completion_barriers() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([7; 16], 1),
    )
    .unwrap();
    let client = store.client();
    client
        .submit(|tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
                    id: "prj_one".into(),
                    worktree: "/project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            for (name, parent) in [
                ("ses_master", None),
                ("ses_alpha", None),
                ("ses_beta", None),
                ("ses_owner", Some("ses_master")),
                ("ses_worker", Some("ses_alpha")),
            ] {
                let mut row = support::record(name);
                row.parent_id = parent.map(Into::into);
                SessionTable::insert(tx, &row)?;
            }
            TaskTable::insert(tx, &task("ses_owner", "ses_master", "running"))?;
            TaskTable::insert(tx, &task("ses_worker", "ses_alpha", "running"))
        })
        .unwrap()
        .await
        .unwrap();
    let coordination = Coordination::new(client.clone(), Feed::attach(&client));
    let group = coordination
        .create(c::CreateInput {
            name: "Synthetic parity".into(),
            master_session_id: id("ses_master"),
            member_session_ids: vec![id("ses_alpha"), id("ses_beta")],
        })
        .await
        .unwrap();
    coordination
        .update(
            &group.id,
            c::UpdateInput {
                revision: group.revision,
                name: None,
                master_session_id: None,
                member_session_ids: None,
                settings: Some(
                    c::GroupSettings::decode(&parse_json(r#"{"concurrency":1}"#).unwrap()).unwrap(),
                ),
            },
        )
        .await
        .unwrap();
    coordination.activate(&group.id).unwrap();
    let sessions = Service::new(client.clone());
    let jobs = job::Jobs::new();
    let lookups = Arc::new(AtomicUsize::new(0));
    let validated = Arc::new(AtomicUsize::new(0));
    let execution = Execution::install(
        sessions.clone(),
        Arc::new(Placement {
            runner: Arc::new(NoticeRunner(sessions.clone())),
            calls: lookups.clone(),
        }),
        jobs.clone(),
        None,
    )
    .unwrap();
    let validations = validated.clone();
    let runtime = coordination::runtime::Runtime::new(coordination::runtime::Options {
        coordination: coordination.clone(),
        sessions: sessions.clone(),
        execution,
        decisions: Arc::new(Controls),
        jobs: jobs.clone(),
        validate_model: Arc::new(move |_, _| {
            validations.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Err(coordination::Error::refused(
                    "Capacity refusal must precede model validation",
                ))
            })
        }),
        model_services: Arc::new(|_| {
            Box::pin(async {
                Err(coordination::Error::refused(
                    "model switching is outside this capacity fixture",
                ))
            })
        }),
        creator: None,
    });
    group_fencing(&client, &coordination, &runtime).await;
    let master = id("ses_master");
    let alpha = id("ses_alpha");
    let beta = id("ses_beta");
    let owner = id("ses_owner");
    let mut failures = Vec::new();
    let info = runtime.get(&group.id).await.unwrap();
    let roster = runtime.roster(&master).await.unwrap();
    for (label, members) in [("get", info.members), ("roster", roster.members)] {
        record_failure(
            &mut failures,
            members
                .iter()
                .find(|member| member.session_id == alpha)
                .unwrap()
                .state
                == c::MemberState::Running,
            &format!("L2-A1: {label} must report a member with a Running child as Running"),
        );
    }
    capacity_refusal(
        &runtime,
        &sessions,
        &master,
        &beta,
        "msg_child_capacity",
        &mut failures,
    )
    .await;
    client
        .submit(|tx| {
            let key = tuple_key(&[KeyPart::String(&"ses_worker".into())]);
            let mut worker = tx.get::<TaskTable>(&key)?.unwrap();
            worker.state = "completed".into();
            TaskTable::put(tx, &worker)?;
            let key = tuple_key(&[KeyPart::String(&"ses_owner".into())]);
            let mut owner = tx.get::<TaskTable>(&key)?.unwrap();
            owner.state = "supervising".into();
            TaskTable::put(tx, &owner)
        })
        .unwrap()
        .await
        .unwrap();
    coordination
        .set_owner(
            &group.id,
            OwnerInput {
                session_id: alpha.clone(),
                owner_session_id: Some(owner.clone()),
                reason: None,
            },
        )
        .await
        .unwrap();
    let roster = runtime.roster(&master).await.unwrap();
    let settled = runtime.get(&group.id).await.unwrap();
    record_failure(
        &mut failures,
        roster
            .members
            .iter()
            .all(|member| member.state == c::MemberState::Idle)
            && settled.master.state == c::MemberState::Idle,
        "L2-A3: completed descendants and Supervising ownership must not make members Running",
    );
    let (release, held) = tokio::sync::oneshot::channel();
    let shell = jobs
        .start(job::StartInput {
            id: Some("job_parity_shell".into()),
            kind: "shell".into(),
            title: None,
            metadata: Some(serde_json::Map::from_iter([(
                "sessionID".into(),
                serde_json::Value::String("ses_alpha".into()),
            )])),
            run: Box::pin(async move { held.await.unwrap() }),
        })
        .unwrap();
    let roster = runtime.roster(&master).await.unwrap();
    record_failure(
        &mut failures,
        roster
            .members
            .iter()
            .find(|member| member.session_id == alpha)
            .unwrap()
            .state
            == c::MemberState::Running,
        "L2-A2: a held mock shell must make its member Running",
    );
    capacity_refusal(
        &runtime,
        &sessions,
        &master,
        &beta,
        "msg_shell_capacity",
        &mut failures,
    )
    .await;
    release.send(Ok("done".into())).unwrap();
    jobs.wait(&shell.id, None).await;
    jobs.notice_admitted(&shell.id);
    let roster = runtime.roster(&master).await.unwrap();
    record_failure(
        &mut failures,
        roster
            .members
            .iter()
            .find(|member| member.session_id == alpha)
            .unwrap()
            .state
            == c::MemberState::Idle,
        "L2-A2: the member must become Idle after its mock shell settles",
    );
    record_failure(
        &mut failures,
        lookups.load(Ordering::SeqCst) == 0,
        "L2-A: capacity refusals and activity reads must not wake a runner",
    );
    for (label, receiver) in [("master", master.clone()), ("delegated", owner.clone())] {
        coordination
            .set_owner(
                &group.id,
                OwnerInput {
                    session_id: alpha.clone(),
                    owner_session_id: Some(receiver.clone()),
                    reason: None,
                },
            )
            .await
            .unwrap();
        let barrier = format!("msg_barrier_{label}");
        let staged = barrier.clone();
        client
            .submit(move |tx| {
                PendingTable::insert(
                    tx,
                    &tables::Pending {
                        id: staged.into(),
                        session_id: "ses_alpha".into(),
                        type_: "compaction".into(),
                        data: JsonValue::Object(Default::default()),
                        delivery: None,
                        admitted_seq: 1,
                        time_created: 1,
                    },
                )
            })
            .unwrap()
            .await
            .unwrap();
        capacity_refusal(
            &runtime,
            &sessions,
            &master,
            &beta,
            &format!("msg_barrier_capacity_{label}"),
            &mut failures,
        )
        .await;
        let before = completed_notices(&sessions, &receiver);
        let other = if receiver == master { &owner } else { &master };
        let other_before = completed_notices(&sessions, other);
        succeeded(&client, &runtime, &alpha, &format!("evt_barrier_{label}")).await;
        execution.await_idle(&receiver).await;
        runtime.recover().await.unwrap();
        runtime.recover().await.unwrap();
        record_failure(
            &mut failures,
            completed_notices(&sessions, &receiver) == before
                && completed_notices(&sessions, other) == other_before,
            &format!("L2-B1: a compaction-only barrier must suppress {label} completion notices"),
        );
        record_failure(
            &mut failures,
            sessions.has_pending_compaction(&alpha).unwrap(),
            "L2-B1: notification handling must not consume the staged barrier",
        );
        client
            .submit(move |tx| {
                tx.delete::<PendingTable>(&tuple_key(&[KeyPart::String(&barrier.into())]))
            })
            .unwrap()
            .await
            .unwrap();
        let drained = completed_notices(&sessions, &receiver);
        succeeded(&client, &runtime, &alpha, &format!("evt_drained_{label}")).await;
        execution.await_idle(&receiver).await;
        runtime.recover().await.unwrap();
        runtime.recover().await.unwrap();
        record_failure(
            &mut failures,
            completed_notices(&sessions, &receiver) == drained + 1
                && completed_notices(&sessions, other) == other_before,
            &format!("L2-B2: after barrier drain, one completed notice must reach {label} only"),
        );
    }
    let unrelated = tables::NewEvent {
        id: "evt_unrelated_receipt".into(),
        aggregate_id: beta.as_lossless().clone(),
        created: chrono::Utc::now().timestamp_millis(),
        type_: "session.input.admitted.1".into(),
        data: parse_json(&format!(
            r#"{{"input":{{"data":{{"metadata":{{"source":"{}","groupID":"{}","memberSessionID":"ses_alpha","memberSequence":10000}}}}}}}}"#,
            coordination::runtime::NOTICE,
            group.id.as_lossless().as_str().unwrap()
        ))
        .unwrap(),
    };
    client
        .submit(move |tx| tables::append(tx, &unrelated, None).map(|_| ()))
        .unwrap()
        .await
        .unwrap();
    let before = completed_notices(&sessions, &owner);
    succeeded(&client, &runtime, &alpha, "evt_after_unrelated_receipt").await;
    execution.await_idle(&owner).await;
    runtime.recover().await.unwrap();
    runtime.recover().await.unwrap();
    record_failure(
        &mut failures,
        completed_notices(&sessions, &owner) == before + 1,
        "L2-B3: a receipt recorded in an unrelated Session must not suppress the owner's completed notice",
    );
    let master_before = completed_notices(&sessions, &master);
    coordination
        .set_owner(
            &group.id,
            OwnerInput {
                session_id: alpha.clone(),
                owner_session_id: Some(master.clone()),
                reason: None,
            },
        )
        .await
        .unwrap();
    runtime.recover().await.unwrap();
    runtime.recover().await.unwrap();
    execution.await_idle(&master).await;
    record_failure(
        &mut failures,
        completed_notices(&sessions, &master) == master_before,
        "L2-B4: receipts delivered to a prior owner must keep recovery from redelivering to the new owner",
    );
    let missed = tables::NewEvent {
        id: "evt_failure_before_completion_receipt".into(),
        aggregate_id: alpha.as_lossless().clone(),
        created: chrono::Utc::now().timestamp_millis(),
        type_: "session.execution.failed.1".into(),
        data: ObjectEncoder::new()
            .field("sessionID", &alpha)
            .field(
                "error",
                &ycoding_schema::session_error::Error {
                    r#type: "unknown".into(),
                    message: "The process stopped before notifying its owner".into(),
                },
            )
            .finish(),
    };
    client
        .submit(move |tx| tables::append(tx, &missed, None).map(|_| ()))
        .unwrap()
        .await
        .unwrap();
    succeeded(&client, &runtime, &alpha, "evt_later_completion").await;
    execution.await_idle(&master).await;
    let before = notices(&sessions, &master, "failed");
    runtime.recover().await.unwrap();
    runtime.recover().await.unwrap();
    assert_eq!(notices(&sessions, &master, "failed"), before + 1);
    record_failure(
        &mut failures,
        validated.load(Ordering::SeqCst) == 0,
        "L2-A/B: every capacity refusal must precede model validation",
    );
    execution.shutdown().await.unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
