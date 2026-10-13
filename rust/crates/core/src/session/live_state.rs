use super::{
    autonomy,
    context_manifest::{ProtectedStateEntry, ProtectedStateSource},
    key,
    orchestration::{self, Rendered, TEAM_VIEW_BYTES},
    prompt_cache::{canonical_json, sha256},
};
use std::ops::Bound;
use ycoding_ai::llm::Message;
use ycoding_schema::{
    DomainEncode, JsonObject, JsonValue, LosslessString, permission::Ruleset,
    schema::NonNegativeInt, session,
};
use ycoding_store::{
    Client, Error, IndexEntry, IndexOrder, IndexQuery, KeyPart, Snapshot, TableSpec, Write,
    session::{
        EventTable, InstructionStateTable, PendingTable, SessionTable, Task, TaskTable, Todo,
        TodoStateTable, TodoTable,
    },
    tuple_key,
};

pub const AUTHORITATIVE_STATE_PREFIX: &str = "Authoritative current Session state (JSON):";

const INSTRUCTION_EVENTS: &[&str] = &[
    "session.instructions.updated.2",
    "session.compaction.ended.1",
    "session.compaction.ended.2",
    "session.moved.1",
    "session.revert.committed.1",
];
const PENDING_EVENTS: &[&str] = &[
    "session.input.admitted.1",
    "session.input.promoted.1",
    "session.compaction.admitted.1",
    "session.compaction.ended.1",
    "session.compaction.failed.1",
];
const PERMISSION_EVENTS: &[&str] = &["session.created.2", "session.forked.2"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub sequence: u64,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatabaseSources {
    pub instructions: Source,
    pub todos: Source,
    pub goal: Source,
    pub autonomy: Source,
    pub permissions: Source,
    pub pending_work: Source,
    pub orchestration: Source,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sources {
    pub instructions: Source,
    pub todos: Source,
    pub goal: Source,
    pub autonomy: Source,
    pub permissions: Source,
    pub guardrails: Source,
    pub pending_work: Source,
    pub orchestration: Source,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TodoItem {
    pub content: String,
    pub status: String,
    pub priority: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DatabaseCapture {
    pub autonomy: autonomy::State,
    pub permission_ceiling: Ruleset,
    pub todos: Vec<TodoItem>,
    pub sources: DatabaseSources,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LiveState {
    pub rendered: Message,
    pub text: String,
    pub team_view: Option<Rendered>,
    pub sources: Sources,
}

#[derive(Debug)]
pub enum LoadError<E> {
    Store(Error),
    Guardrail(E),
}

pub fn protected_state(sources: &Sources) -> Vec<ProtectedStateEntry> {
    [
        (ProtectedStateSource::Instructions, &sources.instructions),
        (ProtectedStateSource::Todos, &sources.todos),
        (ProtectedStateSource::Goal, &sources.goal),
        (ProtectedStateSource::Autonomy, &sources.autonomy),
        (ProtectedStateSource::Permissions, &sources.permissions),
        (ProtectedStateSource::Guardrails, &sources.guardrails),
        (ProtectedStateSource::PendingWork, &sources.pending_work),
        (ProtectedStateSource::Orchestration, &sources.orchestration),
    ]
    .into_iter()
    .map(|(source, value)| entry(source, value))
    .collect()
}

pub fn database_protected_state(sources: &DatabaseSources) -> Vec<ProtectedStateEntry> {
    [
        (ProtectedStateSource::Instructions, &sources.instructions),
        (ProtectedStateSource::Todos, &sources.todos),
        (ProtectedStateSource::Goal, &sources.goal),
        (ProtectedStateSource::Autonomy, &sources.autonomy),
        (ProtectedStateSource::Permissions, &sources.permissions),
        (ProtectedStateSource::PendingWork, &sources.pending_work),
        (ProtectedStateSource::Orchestration, &sources.orchestration),
    ]
    .into_iter()
    .map(|(source, value)| entry(source, value))
    .collect()
}

pub fn capture(snapshot: &Snapshot, id: &session::Id) -> Result<DatabaseCapture, Error> {
    read(&mut Reader::Snapshot(snapshot), id).map(|(capture, _)| capture)
}

pub fn capture_in(tx: &mut Write<'_>, id: &session::Id) -> Result<DatabaseCapture, Error> {
    read(&mut Reader::Transaction(tx), id).map(|(capture, _)| capture)
}

pub fn load<E>(
    client: &Client,
    id: &session::Id,
    mut guardrails: impl FnMut() -> Result<Source, E>,
) -> Result<LiveState, LoadError<E>> {
    loop {
        let before = guardrails().map_err(LoadError::Guardrail)?;
        let snapshot = client.snapshot().map_err(LoadError::Store)?;
        let (capture, tasks) =
            read(&mut Reader::Snapshot(&snapshot), id).map_err(LoadError::Store)?;
        let current = guardrails().map_err(LoadError::Guardrail)?;
        if before != current {
            continue;
        }
        return render(capture, &tasks, current).map_err(LoadError::Store);
    }
}

fn render(
    capture: DatabaseCapture,
    tasks: &[Task],
    guardrails: Source,
) -> Result<LiveState, Error> {
    let state = object([
        (
            "todos",
            JsonValue::Array(
                capture
                    .todos
                    .iter()
                    .map(|todo| {
                        object([
                            ("content", string(&todo.content)),
                            ("status", string(&todo.status)),
                            ("priority", string(&todo.priority)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("autonomy", capture.autonomy.encode()),
        ("permissionCeiling", capture.permission_ceiling.encode()),
    ]);
    let text = [
        Some(format!(
            "{AUTHORITATIVE_STATE_PREFIX}\n{}",
            canonical_json(&state)
        )),
        capture.autonomy.goal_reminder(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    let team_view = (!tasks.is_empty())
        .then(|| {
            tasks
                .iter()
                .map(orchestration::task_from_row)
                .collect::<Result<Vec<_>, Error>>()
                .map(|tasks| orchestration::render_team_observation(&tasks, TEAM_VIEW_BYTES))
        })
        .transpose()?;
    let mut rendered = Message::system(text.as_str());
    rendered.volatile = true;
    let sources = capture.sources;
    Ok(LiveState {
        rendered,
        text,
        team_view,
        sources: Sources {
            instructions: sources.instructions,
            todos: sources.todos,
            goal: sources.goal,
            autonomy: sources.autonomy,
            permissions: sources.permissions,
            guardrails,
            pending_work: sources.pending_work,
            orchestration: sources.orchestration,
        },
    })
}

fn read(
    reader: &mut Reader<'_, '_>,
    id: &session::Id,
) -> Result<(DatabaseCapture, Vec<Task>), Error> {
    let session = reader
        .get::<SessionTable>(&key(id.as_lossless()))?
        .ok_or(Error::Domain {
            kind: "not_found",
            message: "Session not found",
        })?;
    let prefix = key(id.as_lossless());
    let mut todos = reader.range::<TodoTable>(
        "session_todo_session_idx",
        &prefix,
        IndexOrder::Ascending,
        usize::MAX,
    )?;
    todos.sort_by_key(|row| row.position);
    let todo_state = reader.get::<TodoStateTable>(&prefix)?;
    let instruction_state = reader.get::<InstructionStateTable>(&prefix)?;
    let pending = reader.range::<PendingTable>(
        "session_pending_session_admitted_seq_idx",
        &prefix,
        IndexOrder::Ascending,
        usize::MAX,
    )?;
    let mut tasks = reader.range::<TaskTable>(
        "session_task_parent_state_updated_idx",
        &prefix,
        IndexOrder::Ascending,
        usize::MAX,
    )?;
    tasks.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    let instruction_sequence = latest_sequence(reader, id, INSTRUCTION_EVENTS)?;
    let pending_sequence = latest_sequence(reader, id, PENDING_EVENTS)?;
    let permission_sequence = latest_sequence(reader, id, PERMISSION_EVENTS)?;

    let autonomy = autonomy::State::read(session.autonomy.as_ref());
    let permission_ceiling = orchestration::inherit_permission_ceiling(
        None,
        session
            .permission
            .as_ref()
            .map(|document| document.domain())
            .transpose()?
            .as_ref(),
    );
    let revision = |value: i64| {
        u64::try_from(value).map_err(|_| Error::Rejected("negative live-state revision"))
    };
    let autonomy_revision = revision(session.autonomy_revision)?;
    let todo_digest = match &todo_state {
        Some(state) => state
            .digest
            .to_utf8()
            .map_err(|error| Error::Record(Box::new(error)))?,
        None => digest(&JsonValue::Array(
            todos
                .iter()
                .map(|todo| {
                    object([
                        ("content", JsonValue::String(todo.content.clone())),
                        ("status", JsonValue::String(todo.status.clone())),
                        ("priority", JsonValue::String(todo.priority.clone())),
                        ("position", JsonValue::Number(todo.position as f64)),
                    ])
                })
                .collect(),
        )),
    };
    let sources = DatabaseSources {
        instructions: Source {
            sequence: instruction_sequence,
            digest: digest(
                instruction_state
                    .as_ref()
                    .map_or(&JsonValue::Object(JsonObject::new()), |state| {
                        state.current_values.value()
                    }),
            ),
        },
        todos: Source {
            sequence: todo_state
                .as_ref()
                .map_or(Ok(0), |state| revision(state.revision))?,
            digest: todo_digest,
        },
        goal: Source {
            sequence: autonomy_revision,
            digest: digest(&goal_json(&autonomy)),
        },
        autonomy: Source {
            sequence: autonomy_revision,
            digest: digest(&autonomy.encode()),
        },
        permissions: Source {
            sequence: permission_sequence,
            digest: digest(&permission_ceiling.encode()),
        },
        pending_work: Source {
            sequence: pending_sequence,
            digest: digest(&JsonValue::Array(
                pending
                    .iter()
                    .map(|row| {
                        object([
                            ("id", JsonValue::String(row.id.clone())),
                            ("type", JsonValue::String(row.type_.clone())),
                            (
                                "delivery",
                                row.delivery
                                    .clone()
                                    .map_or(JsonValue::Null, JsonValue::String),
                            ),
                            ("admittedSeq", JsonValue::Number(row.admitted_seq as f64)),
                        ])
                    })
                    .collect(),
            )),
        },
        orchestration: Source {
            sequence: revision(session.orchestration_revision)?,
            digest: digest(&JsonValue::Array(
                tasks
                    .iter()
                    .map(|task| {
                        object([
                            ("sessionID", JsonValue::String(task.session_id.clone())),
                            ("revision", JsonValue::Number(task.revision as f64)),
                        ])
                    })
                    .collect(),
            )),
        },
    };
    Ok((
        DatabaseCapture {
            autonomy,
            permission_ceiling,
            todos: todos.iter().map(todo_item).collect::<Result<_, Error>>()?,
            sources,
        },
        tasks,
    ))
}

fn todo_item(todo: &Todo) -> Result<TodoItem, Error> {
    let text = |value: &LosslessString| {
        value
            .to_utf8()
            .map_err(|error| Error::Record(Box::new(error)))
    };
    Ok(TodoItem {
        content: text(&todo.content)?,
        status: text(&todo.status)?,
        priority: text(&todo.priority)?,
    })
}

fn latest_sequence(
    reader: &mut Reader<'_, '_>,
    id: &session::Id,
    types: &[&str],
) -> Result<u64, Error> {
    let mut latest = 0;
    for type_ in types {
        let prefix = tuple_key(&[
            KeyPart::String(id.as_lossless()),
            KeyPart::String(&(*type_).into()),
        ]);
        let newest = reader.range::<EventTable>(
            "event_aggregate_type_seq_idx",
            &prefix,
            IndexOrder::Descending,
            1,
        )?;
        if let Some(event) = newest.first() {
            latest = latest.max(
                u64::try_from(event.seq).map_err(|_| Error::Rejected("negative event sequence"))?,
            );
        }
    }
    Ok(latest)
}

fn goal_json(state: &autonomy::State) -> JsonValue {
    match state.encode() {
        JsonValue::Object(fields) => fields
            .get(&"goal".into())
            .cloned()
            .unwrap_or(JsonValue::Null),
        _ => JsonValue::Null,
    }
}

fn entry(source: ProtectedStateSource, value: &Source) -> ProtectedStateEntry {
    ProtectedStateEntry {
        source,
        revision: NonNegativeInt::new(i64::try_from(value.sequence).unwrap_or(i64::MAX))
            .expect("non-negative revision"),
        digest: value.digest.as_str().into(),
    }
}

fn digest(value: &JsonValue) -> String {
    sha256(&canonical_json(value))
}

fn string(value: &str) -> JsonValue {
    JsonValue::String(value.into())
}

fn object<const N: usize>(fields: [(&str, JsonValue); N]) -> JsonValue {
    let mut object = JsonObject::new();
    for (name, value) in fields {
        object.insert(name.into(), value);
    }
    JsonValue::Object(object)
}

enum Reader<'a, 'b> {
    Snapshot(&'a Snapshot),
    Transaction(&'a mut Write<'b>),
}

impl Reader<'_, '_> {
    fn get<T: TableSpec>(&mut self, key: &[u8]) -> Result<Option<T::Record>, Error> {
        match self {
            Self::Snapshot(snapshot) => snapshot.get::<T>(key),
            Self::Transaction(tx) => tx.get::<T>(key),
        }
    }

    fn range<T: TableSpec>(
        &mut self,
        index: &str,
        prefix: &[u8],
        order: IndexOrder,
        limit: usize,
    ) -> Result<Vec<T::Record>, Error> {
        let mut records = Vec::new();
        let mut after = None;
        while records.len() < limit {
            let query = IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(prefix),
                order,
                after: after.as_ref(),
                limit: (limit - records.len()).min(128),
            };
            let rows: Vec<IndexEntry<T::Record>> = match self {
                Self::Snapshot(snapshot) => snapshot.index_range::<T>(index, query)?,
                Self::Transaction(tx) => tx.index_range::<T>(index, query)?,
            };
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(|row| row.cursor.clone());
            records.extend(rows.into_iter().map(|row| row.record));
        }
        Ok(records)
    }
}
