use super::*;
use ycoding_schema::event::Id as EventId;
use ycoding_store::session as store;

const RECORDED: &str = "coordination.task.recorded.1";
const DISPATCHED: &str = "coordination.task.dispatched.1";
const SETTLED: &str = "coordination.task.settled.1";

#[derive(Clone, Debug)]
pub struct TaskOptions {
    pub title: LosslessString,
    pub dependencies: Vec<session_message::Id>,
}

struct Assignment {
    task: c::BoardTask,
    text: LosslessString,
    delivery: Option<Delivery>,
    model: Option<model::Ref>,
    dispatched: bool,
}

struct Journal {
    tasks: Vec<Assignment>,
    handoffs: Vec<c::BoardHandoff>,
}

impl Runtime {
    pub async fn board(&self, group_id: &c::GroupId) -> Result<c::Board, Error> {
        let group = self.0.coordination.get(group_id)?;
        let scope = scope(&group);
        let snapshot = self.0.coordination.client().snapshot()?;
        let journal = journal(&snapshot, group_id)?;
        let members = ycoding_store::coordination::members(&snapshot, group_id.as_lossless())?;
        let owners = members
            .iter()
            .filter_map(|row| row.owner_session_id.as_ref())
            .collect::<BTreeSet<_>>();
        let running = self.running()?;
        let mut nodes = Vec::new();
        let mut reviews = Vec::new();
        let mut waiting = BTreeSet::new();
        for id in std::iter::once(&group.master_session_id).chain(&group.member_session_ids) {
            let Some(session) = self.0.sessions.get(id)? else {
                continue;
            };
            let is_master = id == &group.master_session_id;
            let mut children = Vec::new();
            let mut parents = vec![id.clone()];
            let mut seen = BTreeSet::from([id.clone()]);
            while let Some(parent) = parents.pop() {
                let mut after = None;
                let prefix = key(parent.as_lossless());
                loop {
                    let page = snapshot.index_range::<TaskTable>(
                        "session_task_parent_state_updated_idx",
                        range(&prefix, after.as_ref()),
                    )?;
                    let Some(last) = page.last() else { break };
                    after = Some(last.cursor.clone());
                    for entry in page {
                        let task = entry.record;
                        let child_id = session::Id::new(task.session_id.clone())?;
                        if !seen.insert(child_id.clone()) {
                            continue;
                        }
                        let Some(child) = self.0.sessions.get(&child_id)? else {
                            continue;
                        };
                        if child.parent_id.as_ref() != Some(&parent)
                            || child.time.archived.is_some()
                        {
                            continue;
                        }
                        let supervisor = parent == group.master_session_id
                            && (owners.contains(&task.session_id)
                                || task.state.as_str() == Some("supervising")
                                || journal.handoffs.iter().any(|handoff| {
                                    handoff.to_session_id.as_ref() == Some(&child_id)
                                }));
                        children.push(c::BoardNode {
                            session_id: child_id.clone(),
                            parent_session_id: Some(parent.clone()),
                            role: if supervisor {
                                c::BoardRole::Supervisor
                            } else {
                                c::BoardRole::Subagent
                            },
                            title: child.title,
                            state: c::BoardNodeState::decode(&task.state.encode())?,
                            agent_id: Some(ycoding_schema::agent::Id::decode(
                                &task.agent.encode(),
                            )?),
                            model: Some(match child.model {
                                Some(model) => model,
                                None => task.model.domain()?,
                            }),
                        });
                        parents.push(child_id);
                    }
                }
            }
            let descendants = children
                .iter()
                .map(|child| child.session_id.clone())
                .collect::<Vec<_>>();
            for pending in self
                .pending_of(&scope, &scope.master_session_id, id, descendants)
                .await?
            {
                if pending
                    .summary
                    .request_session_id
                    .as_ref()
                    .is_some_and(|requester| {
                        !children.iter().any(|node| node.session_id == *requester)
                    })
                {
                    continue;
                }
                waiting.insert(
                    pending
                        .summary
                        .request_session_id
                        .as_ref()
                        .unwrap_or(id)
                        .clone(),
                );
                reviews.push(c::BoardReview {
                    session_id: id.clone(),
                    request: pending.summary,
                });
            }
            let owner = members
                .iter()
                .find(|row| row.session_id == *id.as_lossless())
                .and_then(|row| row.owner_session_id.as_ref())
                .map(|owner| session::Id::new(owner.clone()))
                .transpose()?;
            nodes.push(c::BoardNode {
                session_id: id.clone(),
                parent_session_id: (!is_master)
                    .then(|| owner.unwrap_or_else(|| group.master_session_id.clone())),
                role: if is_master {
                    c::BoardRole::Master
                } else {
                    c::BoardRole::Member
                },
                title: session.title,
                state: if running.contains(id.as_lossless()) {
                    c::BoardNodeState::Running
                } else if self.last_failed(id)? {
                    c::BoardNodeState::Failed
                } else {
                    c::BoardNodeState::Idle
                },
                agent_id: session.agent,
                model: session.model,
            });
            nodes.extend(children);
        }
        let visible: BTreeSet<_> = nodes.iter().map(|node| node.session_id.clone()).collect();
        for node in &mut nodes {
            if waiting.contains(&node.session_id) {
                node.state = c::BoardNodeState::Waiting;
            }
            if node.role == c::BoardRole::Member
                && node
                    .parent_session_id
                    .as_ref()
                    .is_some_and(|parent| !visible.contains(parent))
            {
                node.parent_session_id = Some(group.master_session_id.clone());
            }
        }
        let completed = completed(&journal.tasks);
        let mut tasks = Vec::with_capacity(journal.tasks.len());
        for Assignment {
            mut task,
            dispatched,
            ..
        } in journal.tasks
        {
            if !terminal(task.state) {
                task.state = if task
                    .depends_on_task_ids
                    .iter()
                    .any(|id| !completed.contains(id))
                {
                    c::TaskState::Blocked
                } else if reviews
                    .iter()
                    .any(|review| review.session_id == task.session_id)
                {
                    c::TaskState::Waiting
                } else if dispatched && self.0.sessions.message(&task.task_id)?.is_some() {
                    c::TaskState::Running
                } else {
                    c::TaskState::Queued
                };
            }
            tasks.push(task);
        }
        Ok(c::Board {
            group_id: group_id.clone(),
            nodes,
            tasks,
            handoffs: journal.handoffs,
            reviews,
        })
    }

    pub(super) fn registered_task(&self, id: &session_message::Id) -> Result<bool, Error> {
        Ok(self
            .0
            .coordination
            .client()
            .snapshot()?
            .get::<EventTable>(&key(receipt_id("recorded", id)?.as_lossless()))?
            .is_some())
    }

    pub async fn send_task(
        &self,
        caller: &session::Id,
        mut input: SendInput,
        options: TaskOptions,
    ) -> Result<SendResult, Error> {
        self.under_ownership(caller, async {
            if !(1..=32_000).contains(&input.text.len())
                || !(1..=120).contains(&options.title.len())
                || readable(&options.title).trim().is_empty()
                || options.dependencies.len() > c::MAX_MEMBERS
                || options.dependencies.iter().collect::<BTreeSet<_>>().len()
                    != options.dependencies.len()
            {
                return Err(Error::refused(
                    "Invalid Project task title, message or dependencies",
                ));
            }
            let scope = self.member_scope(caller, &input.session_id)?;
            let task_id = match input.message_id.take() {
                Some(id) => id,
                None => session_message::Id::from_event(&random_event_id()?),
            };
            let snapshot = self.0.coordination.client().snapshot()?;
            let journal = journal(&snapshot, &scope.group_id)?;
            let target = input.session_id.clone();
            let reconciled = if let Some(existing) = journal
                .tasks
                .iter()
                .find(|entry| entry.task.task_id == task_id)
            {
                if existing.task.session_id != target
                    || existing.task.owner_session_id != *caller
                    || existing.text != input.text
                    || existing.delivery.unwrap_or(Delivery::Queue)
                        != input.delivery.unwrap_or(Delivery::Queue)
                    || existing.model != input.model
                    || existing.task.title != options.title
                    || existing.task.depends_on_task_ids != options.dependencies
                {
                    return Err(Error::refused(
                        "Task identity is already used with different content",
                    ));
                }
                true
            } else {
                if !scope.active {
                    return Err(Error::refused(INACTIVE_MESSAGE));
                }
                if options
                    .dependencies
                    .iter()
                    .any(|id| !journal.tasks.iter().any(|entry| &entry.task.task_id == id))
                {
                    return Err(Error::refused(
                        "A dependency must name a previously recorded task in this Project",
                    ));
                }
                if !matches!(self.lookup(&target, &task_id)?, Lookup::Vacant) {
                    return Err(Error::refused("Message identity is already used"));
                }
                if let Some(model) = &input.model {
                    (self.0.validate_model)(target.clone(), model.clone()).await?;
                }
                let task = c::BoardTask {
                    task_id: task_id.clone(),
                    session_id: target.clone(),
                    owner_session_id: caller.clone(),
                    title: options.title,
                    depends_on_task_ids: options.dependencies,
                    state: c::TaskState::Queued,
                    result: None,
                };
                self.task_event(
                    &scope.group_id,
                    receipt_id("recorded", &task_id)?,
                    RECORDED,
                    ObjectEncoder::new()
                        .field("task", &task)
                        .field("text", &input.text)
                        .optional("delivery", &input.delivery)
                        .optional("model", &input.model)
                        .finish(),
                )
                .await?;
                false
            };
            self.advance_tasks(&scope.group_id).await?;
            self.0.coordination.invalidate(&scope.group_id)?;
            Ok(SendResult {
                session_id: target.clone(),
                message_id: task_id,
                state: self.state_of(&scope, &target).await?,
                reconciled,
            })
        })
        .await
    }

    async fn task_event(
        &self,
        group: &c::GroupId,
        id: EventId,
        kind: &'static str,
        data: JsonValue,
    ) -> Result<(), Error> {
        let event = NewEvent {
            id: id.into_lossless(),
            aggregate_id: group.as_lossless().clone(),
            created: chrono::Utc::now().timestamp_millis(),
            type_: kind.into(),
            data,
        };
        self.0
            .coordination
            .client()
            .submit(move |tx| match store::append(tx, &event, None)? {
                store::Append::Appended(_) => Ok(()),
                _ => Err(ycoding_store::Error::Rejected(
                    "duplicate Project task receipt",
                )),
            })?
            .await?;
        Ok(())
    }

    async fn settle_assignment(
        &self,
        group: &c::GroupId,
        task: &mut c::BoardTask,
        state: c::TaskState,
        result: Option<c::TaskResult>,
    ) -> Result<(), Error> {
        self.task_event(
            group,
            receipt_id("settled", &task.task_id)?,
            SETTLED,
            ObjectEncoder::new()
                .field("taskID", &task.task_id)
                .field("state", &state)
                .optional("result", &result)
                .finish(),
        )
        .await?;
        task.state = state;
        task.result = result;
        Ok(())
    }

    pub(super) async fn advance_tasks(&self, group_id: &c::GroupId) -> Result<(), Error> {
        let group = self.0.coordination.get(group_id)?;
        let snapshot = self.0.coordination.client().snapshot()?;
        let mut journal = journal(&snapshot, group_id)?;
        let mut busy = BTreeSet::new();
        for entry in journal
            .tasks
            .iter_mut()
            .filter(|entry| entry.dispatched && !terminal(entry.task.state))
        {
            if let Some((state, result)) = self.assignment_outcome(&snapshot, &entry.task)? {
                self.settle_assignment(group_id, &mut entry.task, state, result)
                    .await?;
            } else {
                busy.insert(entry.task.session_id.clone());
            }
        }
        let completed = completed(&journal.tasks);
        for Assignment {
            mut task,
            text,
            delivery,
            model,
            ..
        } in journal
            .tasks
            .into_iter()
            .filter(|entry| !entry.dispatched && !terminal(entry.task.state))
        {
            let owner = &task.owner_session_id;
            let target = &task.session_id;
            let current = match self.member_scope(owner, target) {
                Ok(current)
                    if current.group_id == *group_id
                        && current.master_session_id == group.master_session_id =>
                {
                    current
                }
                Ok(_) | Err(Error::Refused(_)) => {
                    self.settle_assignment(group_id, &mut task, c::TaskState::Cancelled, None)
                        .await?;
                    continue;
                }
                Err(error) => return Err(error),
            };
            let Some(row) = snapshot.get::<SessionTable>(&key(target.as_lossless()))? else {
                self.settle_assignment(group_id, &mut task, c::TaskState::Cancelled, None)
                    .await?;
                continue;
            };
            if row.time_archived.is_some() {
                self.settle_assignment(group_id, &mut task, c::TaskState::Cancelled, None)
                    .await?;
                continue;
            }
            if !current.active
                || row.time_suspended.is_some()
                || row.revert.is_some()
                || task
                    .depends_on_task_ids
                    .iter()
                    .any(|id| !completed.contains(id))
                || busy.contains(target)
                || self.0.execution.active().contains(target)
                || self.0.sessions.has_pending(target)?
                || self.send_gate(&current, owner, target).await?.is_some()
                || !self
                    .family_pending(&current, owner, target)
                    .await?
                    .is_empty()
            {
                continue;
            }
            if !matches!(self.lookup(target, &task.task_id)?, Lookup::Vacant) {
                self.settle_assignment(group_id, &mut task, c::TaskState::Cancelled, None)
                    .await?;
                continue;
            }
            if let Some(model) = &model
                && let Err(error) = (self.0.validate_model)(target.clone(), model.clone()).await
            {
                let result = c::TaskResult {
                    message_id: None,
                    summary: Some(clip(&error.to_string().into())),
                };
                self.settle_assignment(group_id, &mut task, c::TaskState::Failed, Some(result))
                    .await?;
                continue;
            }
            self.task_event(
                group_id,
                receipt_id("dispatched", &task.task_id)?,
                DISPATCHED,
                ObjectEncoder::new().field("taskID", &task.task_id).finish(),
            )
            .await?;
            let input = SendInput {
                session_id: target.clone(),
                text,
                delivery,
                message_id: Some(task.task_id.clone()),
                model,
            };
            if let Err(error) = self
                .admit_send(
                    &current,
                    owner,
                    input,
                    task.task_id.clone(),
                    receipt_id("admitted", &task.task_id)?,
                )
                .await
            {
                if self
                    .0
                    .coordination
                    .client()
                    .snapshot()?
                    .get::<EventTable>(&key(receipt_id("admitted", &task.task_id)?.as_lossless()))?
                    .is_none()
                {
                    let result = c::TaskResult {
                        message_id: None,
                        summary: Some(clip(&error.to_string().into())),
                    };
                    self.settle_assignment(group_id, &mut task, c::TaskState::Failed, Some(result))
                        .await?;
                } else {
                    return Err(error);
                }
            } else {
                busy.insert(target.clone());
            }
        }
        Ok(())
    }

    fn assignment_outcome(
        &self,
        snapshot: &Snapshot,
        task: &c::BoardTask,
    ) -> Result<Option<(c::TaskState, Option<c::TaskResult>)>, Error> {
        let Some(admission) =
            snapshot
                .get::<EventTable>(&key(receipt_id("admitted", &task.task_id)?.as_lossless()))?
        else {
            return Ok(Some((
                c::TaskState::Failed,
                Some(c::TaskResult {
                    message_id: None,
                    summary: Some("Dispatch could not be verified; task was not replayed".into()),
                }),
            )));
        };
        let prefix = key(task.session_id.as_lossless());
        let lower = ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(task.session_id.as_lossless()),
            ycoding_store::KeyPart::I64(admission.seq),
        ]);
        let mut promoted = false;
        let mut started = false;
        let mut assistant = None;
        let mut after = None;
        loop {
            let page = snapshot.index_range::<EventTable>(
                "event_aggregate_seq_idx",
                IndexQuery {
                    lower: Bound::Excluded(&lower),
                    ..range(&prefix, after.as_ref())
                },
            )?;
            let Some(last) = page.last() else { break };
            after = Some(last.cursor.clone());
            for entry in page {
                let event = entry.record;
                let path = JsonPath::default();
                match event.type_.as_str() {
                    Some("session.execution.started.1") => started = true,
                    Some("session.input.promoted.1") => {
                        let object = ObjectDecoder::new(&event.data, &path)?;
                        let id: session_message::Id = object.field("inputID")?;
                        if id == task.task_id {
                            promoted = true;
                        } else if promoted {
                            return Ok(Some((c::TaskState::Cancelled, None)));
                        }
                    }
                    Some("session.step.ended.1") if promoted => {
                        assistant = ObjectDecoder::new(&event.data, &path)?
                            .optional::<session_message::Id>("assistantMessageID")?
                    }
                    Some("session.execution.succeeded.1") if promoted => {
                        let result = if let Some(id) = assistant {
                            let summary = match self.0.sessions.message(&id)? {
                                Some((session, session_message::Info::Assistant(message)))
                                    if session == task.session_id =>
                                {
                                    let text =
                                        crate::session::runner::unfinished_ending::excerpt_text(
                                            &message,
                                        );
                                    (!text.is_empty()).then(|| clip(&text))
                                }
                                _ => None,
                            };
                            Some(c::TaskResult {
                                message_id: Some(id),
                                summary,
                            })
                        } else {
                            None
                        };
                        return Ok(Some((c::TaskState::Completed, result)));
                    }
                    Some("session.execution.failed.1") if promoted || started => {
                        let error: ycoding_schema::session_error::Error =
                            ObjectDecoder::new(&event.data, &path)?.field("error")?;
                        if promoted || error.r#type.as_str() != Some("interrupted") {
                            return Ok(Some((
                                c::TaskState::Failed,
                                Some(c::TaskResult {
                                    message_id: assistant,
                                    summary: Some(clip(&error.message)),
                                }),
                            )));
                        }
                        started = false;
                    }
                    Some("session.execution.interrupted.1") if started || promoted => {
                        return Ok(Some((c::TaskState::Cancelled, None)));
                    }
                    _ => {}
                }
            }
        }
        Ok(None)
    }

    pub(super) async fn board_changed(&self, id: &session::Id, advance: bool) -> Result<(), Error> {
        let root = self.root_of(id)?;
        let scope = match self.0.coordination.scope_of(&root)? {
            Some(scope) => Some(scope),
            None => self.0.coordination.member_of(&root)?,
        };
        let Some(scope) = scope else {
            return Ok(());
        };
        self.0.coordination.invalidate(&scope.group_id)?;
        if advance {
            self.0
                .coordination
                .with_ownership(&scope.group_id, self.advance_tasks(&scope.group_id))
                .await?;
            self.0.coordination.invalidate(&scope.group_id)?;
        }
        Ok(())
    }
}

fn journal(snapshot: &Snapshot, group: &c::GroupId) -> Result<Journal, Error> {
    let mut journal = Journal {
        tasks: Vec::new(),
        handoffs: Vec::new(),
    };
    let mut owners = BTreeMap::new();
    let mut positions = BTreeMap::new();
    let prefix = key(group.as_lossless());
    let mut after = None;
    loop {
        let page = snapshot
            .index_range::<EventTable>("event_aggregate_seq_idx", range(&prefix, after.as_ref()))?;
        let Some(last) = page.last() else { break };
        after = Some(last.cursor.clone());
        for entry in page {
            let event = entry.record;
            let path = JsonPath::default();
            match event.type_.as_str() {
                Some(RECORDED) => {
                    let object = ObjectDecoder::new(&event.data, &path)?;
                    let task: c::BoardTask = object.field("task")?;
                    positions.insert(task.task_id.clone(), journal.tasks.len());
                    journal.tasks.push(Assignment {
                        task,
                        text: object.field("text")?,
                        delivery: object.optional("delivery")?,
                        model: object.optional("model")?,
                        dispatched: false,
                    });
                }
                Some(DISPATCHED | SETTLED) => {
                    let object = ObjectDecoder::new(&event.data, &path)?;
                    let id: session_message::Id = object.field("taskID")?;
                    if let Some(position) = positions.get(&id) {
                        let entry = &mut journal.tasks[*position];
                        if event.type_.as_str() == Some(DISPATCHED) {
                            entry.dispatched = true;
                        } else {
                            entry.task.state = object.field("state")?;
                            entry.task.result = object.optional("result")?;
                        }
                    }
                }
                Some("coordination.member.owner.changed.1") => {
                    let change = c::OwnerChangedData::decode(&event.data)?;
                    let previous = owners
                        .insert(change.session_id.clone(), change.owner_session_id.clone())
                        .flatten();
                    journal.handoffs.push(c::BoardHandoff {
                        session_id: change.session_id,
                        from_session_id: previous,
                        to_session_id: change.owner_session_id,
                        time: NonNegativeInt::new(event.created)?,
                    });
                }
                Some("coordination.group.changed.1") => {
                    let current = c::Snapshot::decode(&event.data)?;
                    owners.retain(|id, _| current.member_session_ids.contains(id));
                }
                _ => {}
            }
        }
    }
    Ok(journal)
}

fn range<'a>(prefix: &'a [u8], after: Option<&'a ycoding_store::IndexCursor>) -> IndexQuery<'a> {
    IndexQuery {
        lower: Bound::Unbounded,
        upper: Bound::Unbounded,
        prefix: Some(prefix),
        order: IndexOrder::Ascending,
        after,
        limit: 128,
    }
}

fn receipt_id(kind: &str, id: &session_message::Id) -> Result<EventId, Error> {
    let units = id
        .as_lossless()
        .code_units()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let hash: String = digest::digest(&digest::SHA256, &units)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(EventId::new(format!("evt_project_task_{kind}_{hash}"))?)
}

fn completed(entries: &[Assignment]) -> BTreeSet<session_message::Id> {
    entries
        .iter()
        .filter(|entry| entry.task.state == c::TaskState::Completed)
        .map(|entry| entry.task.task_id.clone())
        .collect()
}

fn terminal(state: c::TaskState) -> bool {
    matches!(
        state,
        c::TaskState::Completed | c::TaskState::Failed | c::TaskState::Cancelled
    )
}
