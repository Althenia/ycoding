use super::{
    service::{Error, Service, TERMINAL, non_negative, now, session_id, state_of, synthetic},
    view::truncate_utf8,
};
use crate::{
    platform::shell::ledger,
    session::{
        history, key, pending,
        projector::{self, random_event_id},
        prompt_cache::sha256,
        review::{self, DeliveryError, RecoveryResolution},
        review_fold,
        usage_attribution::{self, Attribution},
    },
};
use std::ops::Bound;
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder, session,
    session_message::{Assistant, AssistantContent, AssistantTool, Info, ToolState},
    session_orchestration::{Answer, Change, Question, QuestionId},
    session_review::{Decision, Kind, Origin, Payload, RecoveryChoice},
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart, Snapshot,
    session::{Event, EventTable, NewEvent, SequenceTable, SessionTable, Task, TaskTable},
    tuple_key,
};

const IN_FLIGHT: &str =
    "The child process ended during an in-flight model attempt. The attempt was not replayed.";
const NO_PENDING: &str =
    "The child process ended without durable pending work. Provider execution was not replayed.";
const NOT_RESUMED: &str =
    "The service restarted while the child task was active. Provider execution was not resumed.";
const NOT_RESUMED_AGAIN: &str = "The service restarted again before the recovered child task completed a step. Provider execution was not resumed.";

impl Service {
    pub async fn recover_restart(&self) -> Result<usize, Error> {
        self.recover_restart_with_processes(ledger::processes).await
    }

    pub async fn recover_restart_with_processes<P, F>(&self, processes: P) -> Result<usize, Error>
    where
        P: FnOnce() -> F,
        F: std::future::Future<Output = std::io::Result<Vec<ledger::Process>>>,
    {
        let mut rows = self
            .sessions
            .client
            .snapshot()?
            .scan::<TaskTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
            .into_iter()
            .filter(|row| {
                matches!(
                    row.state.as_str(),
                    Some("starting" | "running" | "waiting" | "cancelling")
                )
            })
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        if rows.is_empty() {
            return Ok(0);
        }
        let processes = match processes().await {
            Ok(processes) => processes,
            Err(error) => {
                tracing::warn!(%error, "could not list processes; active child tasks were not recovered");
                return Ok(0);
            }
        };
        let mut recovered = 0;
        for row in rows {
            if ledger::alive(&processes, row.owner_pid, row.owner_started.as_ref()) {
                continue;
            }
            let child_id = session_id(&row.session_id)?;
            let guard = self.lock(&row.session_id).await;
            let Some(action) = self.restart_task(&row, &child_id).await? else {
                continue;
            };
            recovered += 1;
            drop(guard);
            match action {
                Restart::Settled => self.release_reservation(&child_id),
                Restart::Held => {}
                Restart::Wake => self.execution.wake(&child_id)?,
                Restart::Resume => {
                    if let Err(error) = self.execution.resume(&child_id).await {
                        tracing::warn!(%error, "recovered child execution was not admitted");
                    }
                }
            }
        }
        Ok(recovered)
    }

    async fn restart_task(
        &self,
        row: &Task,
        child_id: &session::Id,
    ) -> Result<Option<Restart>, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        if snapshot
            .get::<TaskTable>(&key(&row.session_id))?
            .is_none_or(|latest| !unchanged(row, &latest))
        {
            return Ok(None);
        }
        let state = state_of(row);
        if state == "waiting"
            && row.question_id.is_some()
            && row.question.is_some()
            && row.question_time.is_some()
        {
            return Ok(None);
        }
        let sequence = ycoding_store::session::latest_sequence(&snapshot, &row.session_id)?;
        let created = now();
        let pending = self.sessions.pending_list(child_id)?.iter().any(|pending| {
            matches!(
                pending.delivery.as_ref().and_then(LosslessString::as_str),
                Some("steer" | "queue")
            )
        });
        let lost = |excerpt: &str| {
            restart_event(
                row,
                Change::Lost {
                    excerpt: Some(excerpt.into()),
                },
                "lost",
                created,
            )
        };
        if state == "waiting" || state == "cancelling" || (state == "starting" && !pending) {
            return self
                .commit_restart(row, sequence, vec![lost(NOT_RESUMED)], Restart::Settled)
                .await;
        }
        if state == "starting" {
            return self
                .commit_restart(
                    row,
                    sequence,
                    vec![restart_event(row, Change::Started, "started", created)],
                    Restart::Wake,
                )
                .await;
        }
        let lifecycle = latest_event(
            &snapshot,
            &row.session_id,
            &[
                "session.execution.started.1",
                "session.execution.succeeded.1",
                "session.execution.failed.1",
                "session.execution.interrupted.1",
            ],
        )?;
        let interrupted = match lifecycle.as_ref().and_then(|event| event.type_.as_str()) {
            Some("session.execution.failed.1") => lifecycle
                .as_ref()
                .is_some_and(|event| field(&event.data, &["error", "type"]) == Some("interrupted")),
            Some("session.execution.interrupted.1") => {
                lifecycle
                    .as_ref()
                    .is_some_and(|event| field(&event.data, &["reason"]) == Some("shutdown"))
                    && snapshot
                        .get::<SessionTable>(&key(&row.session_id))?
                        .is_some_and(|session| session.time_suspended.is_some())
            }
            _ => false,
        };
        if !interrupted && !pending {
            return self
                .commit_restart(row, sequence, vec![lost(NOT_RESUMED)], Restart::Settled)
                .await;
        }
        let assistant = match history::latest(&snapshot, child_id, "assistant")? {
            Some(Info::Assistant(assistant)) => Some(assistant),
            _ => None,
        };
        let reviews = review_fold::fold(&snapshot, std::slice::from_ref(&row.session_id))?;
        let continued = reviews
            .iter()
            .flat_map(|item| match (&item.deferral.payload, &item.decision) {
                (
                    Payload::Recovery(payload),
                    Some(Decision::Recovery {
                        choice: RecoveryChoice::Continue,
                    }),
                ) => payload.tools.iter().collect::<Vec<_>>(),
                _ => Vec::new(),
            })
            .collect::<Vec<_>>();
        let uncertain = assistant.as_ref().into_iter().flat_map(|assistant| {
            assistant.content.iter().filter_map(|part| match part {
                AssistantContent::Tool(tool) if interrupted && tool.time.ran.is_some()
                    && (matches!(tool.state, ToolState::Running(_)) || matches!(&tool.state, ToolState::Error(error) if error.error.r#type.as_str() == Some("aborted")))
                    && !continued.iter().any(|known| known.message_id == assistant.id && known.call_id == tool.id) => Some(tool.as_ref()),
                _ => None,
            })
        }).collect::<Vec<_>>();
        let mut events = Vec::new();
        if let Some(assistant) = &assistant {
            for tool in &uncertain {
                if matches!(tool.state, ToolState::Running(_)) {
                    events.push(tool_failed(row, assistant, tool, "aborted", &format!("The service restarted while {} was running; its effect is unknown and it was not retried.", text(&tool.name)), tool.executed == Some(true), created)?);
                }
            }
            for part in &assistant.content {
                if let AssistantContent::Tool(tool) = part
                    && interrupted
                    && matches!(tool.state, ToolState::Streaming(_))
                {
                    events.push(tool_failed(row, assistant, tool, "tool.input-json", "Tool call arguments were incomplete when the service restarted and were not executed. Retry the call if it is still needed.", false, created)?);
                }
            }
            if !uncertain.is_empty() {
                let mut names = Vec::new();
                for tool in &uncertain {
                    if !names.contains(&tool.name) {
                        names.push(tool.name.clone());
                    }
                }
                let question = Question {
                    id: QuestionId(format!("qst_{}", &sha256(&format!("{}\0{}\0restart", text(&row.session_id), row.revision))[..24]).into()),
                    text: truncate_utf8(&format!("The service restarted while these tool calls were running: {}. Their effects are unknown and they were not retried. The user must choose Continue or Stop.", names.iter().map(text).collect::<Vec<_>>().join(", ")), 8 * 1024).into(),
                    data: None,
                    time: non_negative(created)?,
                    deferred: None,
                };
                events.push(restart_event(
                    row,
                    Change::QuestionAsked {
                        question: question.clone(),
                    },
                    "question",
                    created,
                ));
                events.push(NewEvent {
                    id: random_event_id()?.as_lossless().clone(),
                    aggregate_id: row.session_id.clone(),
                    created,
                    type_: "session.review.deferred.1".into(),
                    data: ObjectEncoder::new()
                        .field("sessionID", child_id)
                        .field(
                            "itemID",
                            format!(
                                "rvw_task_restart_{}_{}",
                                text(&row.session_id),
                                row.revision
                            )
                            .as_str(),
                        )
                        .field("kind", "recovery")
                        .field("reason", "restart")
                        .field(
                            "origin",
                            &Origin::Question {
                                question_id: question.id,
                            },
                        )
                        .field(
                            "payload",
                            &ObjectEncoder::new()
                                .field("type", "recovery")
                                .field(
                                    "tools",
                                    &uncertain
                                        .iter()
                                        .map(|tool| {
                                            ObjectEncoder::new()
                                                .field("messageID", &assistant.id)
                                                .field("callID", &tool.id)
                                                .field("name", &tool.name)
                                                .finish()
                                        })
                                        .collect::<Vec<_>>(),
                                )
                                .finish(),
                        )
                        .finish(),
                });
                return self
                    .commit_restart(row, sequence, events, Restart::Held)
                    .await;
            }
        }
        if recovered_without_progress(&snapshot, &row.session_id)? {
            return self
                .commit_restart(
                    row,
                    sequence,
                    vec![lost(NOT_RESUMED_AGAIN)],
                    Restart::Settled,
                )
                .await;
        }
        if let Some(assistant) = &assistant
            && interrupted
            && !pending
            && final_answer(assistant)
        {
            return self
                .commit_restart(
                    row,
                    sequence,
                    vec![restart_event(
                        row,
                        Change::Completed {
                            excerpt: Some(
                                truncate_utf8(&assistant_text(assistant), 16 * 1024).into(),
                            ),
                        },
                        "completed",
                        created,
                    )],
                    Restart::Settled,
                )
                .await;
        }
        events.push(restart_event(row, Change::Resumed, "resumed", created));
        self.commit_restart(row, sequence, events, Restart::Resume)
            .await
    }

    async fn commit_restart(
        &self,
        row: &Task,
        sequence: i64,
        events: Vec<NewEvent>,
        action: Restart,
    ) -> Result<Option<Restart>, Error> {
        let row = row.clone();
        let committed = self
            .sessions
            .client
            .submit(move |tx| {
                let key = key(&row.session_id);
                if tx
                    .get::<TaskTable>(&key)?
                    .is_none_or(|latest| !unchanged(&row, &latest))
                    || tx
                        .get::<SequenceTable>(&key)?
                        .map_or(-1, |latest| latest.seq)
                        != sequence
                    || tx
                        .get::<SessionTable>(&key)?
                        .is_none_or(|session| session.time_archived.is_some())
                {
                    return Ok(false);
                }
                for event in events {
                    projector::append(tx, &event)?;
                }
                Ok(true)
            })?
            .await?;
        Ok(committed.then_some(action))
    }

    pub async fn resolve_recovery(
        &self,
        resolution: RecoveryResolution,
    ) -> Result<(), DeliveryError> {
        if resolution.claim.session_id() != &resolution.child_id
            || resolution.claim.decision()
                != &(Decision::Recovery {
                    choice: resolution.choice,
                })
        {
            return Err(DeliveryError::Conflict(
                "Recovery claim does not match its resolution".into(),
            ));
        }
        let guard = self.lock(resolution.child_id.as_lossless()).await;
        let snapshot = self
            .sessions
            .client
            .snapshot()
            .map_err(DeliveryError::Store)?;
        let row = snapshot
            .get::<TaskTable>(&key(resolution.child_id.as_lossless()))
            .map_err(DeliveryError::Store)?
            .ok_or_else(|| DeliveryError::Conflict("Task not found".into()))?;
        let item = review_fold::fold(&snapshot, std::slice::from_ref(&row.session_id))
            .map_err(DeliveryError::Store)?
            .into_iter()
            .find(|item| &item.item_id == resolution.claim.item_id())
            .filter(|item| item.deferral.kind == Kind::Recovery && item.withdrawn.is_none())
            .ok_or_else(|| {
                DeliveryError::Conflict("Review item is not an open restart recovery".into())
            })?;
        let (Origin::Question { question_id }, Payload::Recovery(payload)) =
            (&item.deferral.origin, &item.deferral.payload)
        else {
            return Err(DeliveryError::Conflict(
                "Review item is not a restart recovery question".into(),
            ));
        };
        let stopped = item.is_stopped_recovery();
        let eligible = if stopped {
            resolution.choice == RecoveryChoice::Continue && row.state.as_str() == Some("lost")
        } else {
            item.decision.is_none()
                && row.state.as_str() == Some("waiting")
                && row.question_id.as_ref() == Some(&question_id.0)
        };
        if !eligible {
            return Err(DeliveryError::Conflict(
                "Restart recovery cannot be decided in the current task state".into(),
            ));
        }
        let created = now();
        let tools = payload
            .tools
            .iter()
            .map(|tool| text(&tool.name))
            .collect::<Vec<_>>()
            .join(", ");
        let continuing = resolution.choice == RecoveryChoice::Continue;
        let request = continuing.then(|| {
            Ok::<_, Error>(pending::Request {
                id: review::prompt_id(&item.item_id),
                session_id: resolution.child_id.clone(),
                input: synthetic(
                    format!("The user chose Continue after a service restart interrupted {tools}. Their effects are unknown and they were not retried; check their results before repeating any of them."),
                    "Restart recovery · continue",
                    ObjectEncoder::new().field("review", &ObjectEncoder::new().field("itemID", &item.item_id).field("kind", "recovery").finish()).finish(),
                    "steer",
                )?,
                event_id: random_event_id()?,
                created,
            })
        }).transpose().map_err(delivery_error)?;
        let change = if !continuing {
            Change::Lost { excerpt: Some(format!("The user stopped this subagent after a service restart interrupted {tools}; their effects are unknown. Only the user can continue it.").into()) }
        } else if stopped {
            Change::Started
        } else {
            Change::QuestionAnswered {
                answer: Answer {
                    question_id: question_id.clone(),
                    text: Some("Continue".into()),
                    data: None,
                },
            }
        };
        let event = NewEvent {
            id: random_event_id()
                .map_err(DeliveryError::Store)?
                .as_lossless()
                .clone(),
            aggregate_id: row.session_id.clone(),
            created,
            type_: "session.task.updated.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", &resolution.child_id)
                .field("change", &change)
                .finish(),
        };
        let caused_by = if continuing {
            usage_attribution::dispatch(&self.sessions.client, &row.parent_id, &Attribution::Unset)
                .await
                .map_err(DeliveryError::Store)?
        } else {
            None
        };
        let child_id = resolution.child_id.clone();
        let wake = self
            .sessions
            .client
            .submit(move |tx| {
                if tx
                    .get::<TaskTable>(&key(&row.session_id))?
                    .is_none_or(|latest| !unchanged(&row, &latest))
                {
                    return Err(review_fold::changed(tx));
                }
                resolution.claim.commit(tx, created)?;
                if let Some(request) = request {
                    let (_, fresh) = pending::admit_in(tx, &request, &caused_by)?;
                    if !fresh {
                        return Err(tx.reject(pending::conflict()));
                    }
                }
                projector::append(tx, &event)?;
                Ok(continuing
                    && tx
                        .get::<SessionTable>(&key(&row.session_id))?
                        .is_some_and(|session| session.revert.is_none()))
            })
            .map_err(DeliveryError::Store)?
            .await
            .map_err(DeliveryError::Store)?;
        if !continuing {
            self.release_reservation(&child_id);
        }
        if wake {
            self.execution
                .wake(&child_id)
                .map_err(|error| DeliveryError::Conflict(error.to_string()))?;
        }
        drop(guard);
        Ok(())
    }

    pub async fn recover(&self) -> Result<usize, Error> {
        let mut rows = self.sessions.client.snapshot()?.scan::<TaskTable>(
            Bound::Unbounded,
            Bound::Unbounded,
            usize::MAX,
        )?;
        rows.sort_by(|left, right| {
            (left.time_created, &left.session_id).cmp(&(right.time_created, &right.session_id))
        });
        let mut acted = 0;
        for row in rows {
            let child_id = session_id(&row.session_id)?;
            let _guard = self.lock(&row.session_id).await;
            let Some(latest) = self.task(&child_id)? else {
                continue;
            };
            if self
                .recover_task(&child_id, &state_of(&latest), latest.attempt_started != 0)
                .await?
            {
                acted += 1;
            }
        }
        Ok(acted)
    }

    async fn recover_task(
        &self,
        child_id: &session::Id,
        state: &str,
        attempt_started: bool,
    ) -> Result<bool, Error> {
        if state == "cancelling" {
            self.publish(child_id, Change::Cancelled, None).await?;
            return Ok(true);
        }
        if state == "running" && attempt_started {
            self.publish(
                child_id,
                Change::Lost {
                    excerpt: Some(IN_FLIGHT.into()),
                },
                None,
            )
            .await?;
            return Ok(true);
        }
        let terminal = TERMINAL.contains(&state);
        if !terminal && state != "starting" && state != "running" {
            return Ok(false);
        }
        let pending = !self.sessions.pending_list(child_id)?.is_empty();
        if terminal
            && (!pending
                || review_fold::stopped_recovery(&self.sessions.client.snapshot()?, child_id)?
                    .is_some())
        {
            return Ok(false);
        }
        if state == "starting" || terminal {
            self.publish(child_id, Change::Started, None).await?;
        }
        if !pending {
            self.publish(
                child_id,
                Change::Lost {
                    excerpt: Some(NO_PENDING.into()),
                },
                None,
            )
            .await?;
            return Ok(true);
        }
        self.execution.wake(child_id)?;
        Ok(true)
    }
}

enum Restart {
    Settled,
    Held,
    Wake,
    Resume,
}

fn unchanged(before: &Task, after: &Task) -> bool {
    before.revision == after.revision
        && before.state == after.state
        && before.owner_pid == after.owner_pid
        && before.owner_started == after.owner_started
}

fn restart_event(row: &Task, change: Change, label: &str, created: i64) -> NewEvent {
    NewEvent {
        id: format!(
            "evt_task_restart_{label}_{}_{}",
            text(&row.session_id),
            row.revision + 1
        )
        .into(),
        aggregate_id: row.session_id.clone(),
        created,
        type_: "session.task.updated.1".into(),
        data: ObjectEncoder::new()
            .field("sessionID", &row.session_id)
            .field("change", &change)
            .finish(),
    }
}

fn tool_failed(
    row: &Task,
    assistant: &Assistant,
    tool: &AssistantTool,
    type_: &str,
    message: &str,
    executed: bool,
    created: i64,
) -> Result<NewEvent, Error> {
    Ok(NewEvent {
        id: random_event_id()?.as_lossless().clone(),
        aggregate_id: row.session_id.clone(),
        created,
        type_: "session.tool.failed.1".into(),
        data: ObjectEncoder::new()
            .field("sessionID", &row.session_id)
            .field("assistantMessageID", &assistant.id)
            .field("callID", &tool.id)
            .field(
                "error",
                &ObjectEncoder::new()
                    .field("type", type_)
                    .field("message", message)
                    .finish(),
            )
            .field("executed", &executed)
            .finish(),
    })
}

fn latest_event(
    snapshot: &Snapshot,
    session_id: &LosslessString,
    types: &[&str],
) -> Result<Option<Event>, Error> {
    types
        .iter()
        .map(|type_| {
            let prefix = tuple_key(&[
                KeyPart::String(session_id),
                KeyPart::String(&(*type_).into()),
            ]);
            Ok(snapshot
                .index_range::<EventTable>(
                    "event_aggregate_type_seq_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Descending,
                        after: None,
                        limit: 1,
                    },
                )?
                .into_iter()
                .next()
                .map(|row| row.record))
        })
        .collect::<Result<Vec<_>, Error>>()
        .map(|events| events.into_iter().flatten().max_by_key(|event| event.seq))
}

fn recovered_without_progress(
    snapshot: &Snapshot,
    session_id: &LosslessString,
) -> Result<bool, Error> {
    let ended = latest_event(snapshot, session_id, &["session.step.ended.1"])?;
    let prefix = tuple_key(&[
        KeyPart::String(session_id),
        KeyPart::String(&"session.task.updated.1".into()),
    ]);
    let mut after = None;
    loop {
        let rows = snapshot.index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        for row in &rows {
            if ended
                .as_ref()
                .is_some_and(|ended| ended.seq > row.record.seq)
            {
                return Ok(false);
            }
            if field(&row.record.data, &["change", "type"]) == Some("resumed") {
                return Ok(true);
            }
        }
        let Some(last) = rows.last() else {
            return Ok(false);
        };
        after = Some(last.cursor.clone());
    }
}

fn field<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a str> {
    let value = path.iter().try_fold(value, |value, name| match value {
        JsonValue::Object(fields) => fields.get(&(*name).into()),
        _ => None,
    })?;
    match value {
        JsonValue::String(value) => value.as_str(),
        _ => None,
    }
}

fn assistant_text(assistant: &Assistant) -> String {
    assistant
        .content
        .iter()
        .filter_map(|part| match part {
            AssistantContent::Text(part) => Some(text(&part.text)),
            _ => None,
        })
        .collect()
}

fn final_answer(assistant: &Assistant) -> bool {
    assistant.time.completed.is_some()
        && assistant.error.is_none()
        && !assistant_text(assistant).trim().is_empty()
        && !assistant
            .content
            .iter()
            .any(|part| matches!(part, AssistantContent::Tool(tool) if tool.executed != Some(true)))
}

fn text(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

fn delivery_error(error: Error) -> DeliveryError {
    match error {
        Error::Store(error) => DeliveryError::Store(error),
        error => DeliveryError::Conflict(error.to_string()),
    }
}
