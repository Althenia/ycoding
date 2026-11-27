use super::BATCH;
use crate::{
    Catalog, Error, IndexDefinition, TableDeclaration, TableSpec,
    catalog::definition,
    engine::index_storage_key,
    session::{Event, EventTable, Message, MessageTable, Pending, PendingTable},
};
use redb::{ReadTransaction, ReadableTable, TableHandle, WriteTransaction};
use std::{collections::BTreeSet, ops::Bound};
use ycoding_schema::{JsonObject, JsonValue};

pub(crate) const TABLES: &[TableDeclaration] = &[
    TableDeclaration {
        name: "project_artifact_scope",
        indexes: &[
            IndexDefinition::unique("project_artifact_scope_id_type_unique"),
            IndexDefinition::unique("project_artifact_scope_storage_id_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_project_scope",
        indexes: &[IndexDefinition::unique(
            "project_artifact_project_scope_project_id_idx",
        )],
    },
    TableDeclaration {
        name: "project_artifact_global_scope",
        indexes: &[IndexDefinition::unique(
            "project_artifact_global_scope_singleton_idx",
        )],
    },
    TableDeclaration {
        name: "project_artifact",
        indexes: &[IndexDefinition::secondary(
            "project_artifact_scope_stage_kind_updated_idx",
        )],
    },
    TableDeclaration {
        name: "project_artifact_version",
        indexes: &[
            IndexDefinition::unique("project_artifact_version_owner_unique"),
            IndexDefinition::unique("project_artifact_version_digest_owner_unique"),
            IndexDefinition::unique("project_artifact_version_write_unique"),
            IndexDefinition::unique("project_artifact_version_scope_kind_id_digest_idx"),
            IndexDefinition::secondary("project_artifact_version_scope_kind_id_created_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_trash",
        indexes: &[
            IndexDefinition::unique("project_artifact_trash_scope_kind_id_idx"),
            IndexDefinition::secondary("project_artifact_trash_purge_after_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_operation",
        indexes: &[
            IndexDefinition::unique("project_artifact_operation_request_idx"),
            IndexDefinition::unique("project_artifact_operation_automatic_retry_idx"),
            IndexDefinition::unique("project_artifact_operation_active_artifact_idx"),
            IndexDefinition::secondary("project_artifact_operation_recovery_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_activation",
        indexes: &[
            IndexDefinition::unique("project_artifact_activation_identity_idx"),
            IndexDefinition::unique("project_artifact_activation_sessionless_identity_idx"),
            IndexDefinition::secondary("project_artifact_activation_session_open_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_observation",
        indexes: &[
            IndexDefinition::unique("project_artifact_observation_version_terminal_idx"),
            IndexDefinition::unique("project_artifact_observation_version_session_absent_idx"),
            IndexDefinition::unique("project_artifact_observation_sessionless_absent_idx"),
            IndexDefinition::secondary(
                "project_artifact_observation_version_eligible_observed_idx",
            ),
        ],
    },
    TableDeclaration {
        name: "project_artifact_terminal",
        indexes: &[
            IndexDefinition::unique("project_artifact_terminal_message_identity_idx"),
            IndexDefinition::unique("project_artifact_terminal_boundary_identity_idx"),
            IndexDefinition::secondary("project_artifact_terminal_cohort_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_feedback",
        indexes: &[IndexDefinition::secondary(
            "project_artifact_feedback_version_created_idx",
        )],
    },
    TableDeclaration {
        name: "project_artifact_write",
        indexes: &[
            IndexDefinition::secondary("project_artifact_write_scope_created_idx"),
            IndexDefinition::secondary("project_artifact_write_session_created_idx"),
        ],
    },
    TableDeclaration {
        name: "project_artifact_legacy_cleanup",
        indexes: &[],
    },
];

const ENDED_EVENT: &str = "session.project-artifacts-ended.1";
const ENDED_METADATA: &str = "projectArtifactsEnded";
const USER_METADATA: &str = "projectArtifact";
const ARTIFACT_FIELD: &str = "artifact";

pub(super) enum Change<T> {
    Remove,
    Replace(T),
}

pub(super) fn present(catalog: Catalog) -> bool {
    catalog.names().contains(TABLES[0].name)
}

fn replaced(object: &JsonObject, name: &str, value: Option<JsonValue>) -> JsonObject {
    object
        .iter()
        .fold(JsonObject::new(), |mut kept, (key, current)| {
            if key.as_str() != Some(name) {
                kept.insert(key.clone(), current.clone());
            } else if let Some(value) = &value {
                kept.insert(key.clone(), value.clone());
            }
            kept
        })
}

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}

fn strip(value: &JsonValue, name: &str) -> Option<JsonValue> {
    match value {
        JsonValue::Object(object) if object.get(&name.into()).is_some() => {
            Some(JsonValue::Object(replaced(object, name, None)))
        }
        _ => None,
    }
}

fn strip_metadata(data: &JsonValue, name: &str) -> Option<JsonValue> {
    let JsonValue::Object(object) = data else {
        return None;
    };
    let metadata = match strip(field(data, "metadata")?, name)? {
        JsonValue::Object(metadata) if metadata.is_empty() => None,
        metadata => Some(metadata),
    };
    Some(JsonValue::Object(replaced(object, "metadata", metadata)))
}

fn strip_admitted_input(data: &JsonValue) -> Option<JsonValue> {
    let (JsonValue::Object(data), input @ JsonValue::Object(input_object)) =
        (data, field(data, "input")?)
    else {
        return None;
    };
    if !matches!(field(input, "type")?, JsonValue::String(kind) if kind.as_str() == Some("user")) {
        return None;
    }
    let input_data = strip_metadata(field(input, "data")?, USER_METADATA)?;
    let input = JsonValue::Object(replaced(input_object, "data", Some(input_data)));
    Some(JsonValue::Object(replaced(data, "input", Some(input))))
}

pub(super) fn event(row: &Event) -> Option<Change<Event>> {
    let data = match row.type_.as_str()? {
        ENDED_EVENT => return Some(Change::Remove),
        "session.agent.selected.1" | "session.skill.activated.1" => {
            strip(&row.data, ARTIFACT_FIELD)?
        }
        "session.input.admitted.1" => strip_admitted_input(&row.data)?,
        _ => return None,
    };
    Some(Change::Replace(Event {
        data,
        ..row.clone()
    }))
}

pub(super) fn message(row: &Message) -> Option<Change<Message>> {
    let data = match row.type_.as_str()? {
        "synthetic" => {
            return field(&row.data, "metadata")
                .and_then(|metadata| field(metadata, ENDED_METADATA))
                .map(|_| Change::Remove);
        }
        "agent-switched" | "skill" => strip(&row.data, ARTIFACT_FIELD)?,
        "user" => strip_metadata(&row.data, USER_METADATA)?,
        _ => return None,
    };
    Some(Change::Replace(Message {
        data,
        ..row.clone()
    }))
}

pub(super) fn pending(row: &Pending) -> Option<Change<Pending>> {
    if row.type_.as_str()? != "user" {
        return None;
    }
    Some(Change::Replace(Pending {
        data: strip_metadata(&row.data, USER_METADATA)?,
        ..row.clone()
    }))
}

fn rewrite<T: TableSpec>(
    write: &WriteTransaction,
    change: impl Fn(&T::Record) -> Option<Change<T::Record>>,
) -> Result<(), Error> {
    let mut table = write.open_table(definition(T::NAME))?;
    let mut indexes = T::INDEXES
        .iter()
        .map(|index| Ok((index, write.open_table(definition(index.name))?)))
        .collect::<Result<Vec<_>, Error>>()?;
    let mut after: Option<Vec<u8>> = None;
    loop {
        let batch = table
            .range::<&[u8]>((
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
            ))?
            .take(BATCH)
            .map(|entry| {
                let (key, value) = entry?;
                Ok((key.value().to_vec(), value.value().to_vec()))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        for (key, value) in &batch {
            let record = T::decode(value)?;
            match change(&record) {
                None => {}
                Some(Change::Replace(updated)) => {
                    table.insert(key.as_slice(), T::encode(&updated)?.as_slice())?;
                }
                Some(Change::Remove) => {
                    table.remove(key.as_slice())?;
                    for (index, entries) in &mut indexes {
                        if let Some(logical) = T::index_key(index, &record)? {
                            entries.remove(index_storage_key(index, &logical, key).as_slice())?;
                        }
                    }
                }
            }
        }
        if batch.len() < BATCH {
            return Ok(());
        }
        after = batch.last().map(|(key, _)| key.clone());
    }
}

pub(super) fn apply(write: &WriteTransaction, previous: Catalog) -> Result<(), Error> {
    let target = crate::native::catalog(crate::native::DatabaseKind::Core).names();
    for name in previous.names() {
        if !target.contains(name) {
            write.delete_table(definition(name))?;
        }
    }
    if !present(previous) {
        return Ok(());
    }
    rewrite::<EventTable>(write, event)?;
    rewrite::<MessageTable>(write, message)?;
    rewrite::<PendingTable>(write, pending)
}

pub(super) struct Expected {
    events: BTreeSet<Vec<u8>>,
    messages: BTreeSet<Vec<u8>>,
}

fn removed<T: TableSpec>(
    read: &ReadTransaction,
    change: impl Fn(&T::Record) -> Option<Change<T::Record>>,
) -> Result<BTreeSet<Vec<u8>>, Error> {
    let mut keys = BTreeSet::new();
    for entry in read.open_table(definition(T::NAME))?.iter()? {
        let (key, value) = entry?;
        if matches!(change(&T::decode(value.value())?), Some(Change::Remove)) {
            keys.insert(key.value().to_vec());
        }
    }
    Ok(keys)
}

impl Expected {
    pub(super) fn new(original: &ReadTransaction, previous: Catalog) -> Result<Self, Error> {
        if !present(previous) {
            return Ok(Self {
                events: BTreeSet::new(),
                messages: BTreeSet::new(),
            });
        }
        Ok(Self {
            events: removed::<EventTable>(original, event)?,
            messages: removed::<MessageTable>(original, message)?,
        })
    }

    pub(super) fn removed(
        &self,
        upgraded: &ReadTransaction,
        previous: Catalog,
    ) -> Result<(), Error> {
        let target = crate::native::catalog(crate::native::DatabaseKind::Core).names();
        let listed = upgraded
            .list_tables()?
            .map(|table| table.name().to_owned())
            .collect::<BTreeSet<_>>();
        if previous
            .names()
            .into_iter()
            .any(|name| !target.contains(name) && listed.contains(name))
        {
            return Err(super::mismatch());
        }
        Ok(())
    }

    pub(super) fn row(&self, name: &str, value: &[u8]) -> Result<Option<Vec<u8>>, Error> {
        let indexed = |indexes: &[IndexDefinition]| indexes.iter().any(|index| index.name == name);
        if name == EventTable::NAME {
            return translate::<EventTable>(value, event);
        }
        if name == MessageTable::NAME {
            return translate::<MessageTable>(value, message);
        }
        if name == PendingTable::NAME {
            return translate::<PendingTable>(value, pending);
        }
        let removed = if indexed(EventTable::INDEXES) {
            &self.events
        } else if indexed(MessageTable::INDEXES) {
            &self.messages
        } else {
            return Ok(Some(value.to_vec()));
        };
        Ok((!removed.contains(value)).then(|| value.to_vec()))
    }
}

fn translate<T: TableSpec>(
    value: &[u8],
    change: impl Fn(&T::Record) -> Option<Change<T::Record>>,
) -> Result<Option<Vec<u8>>, Error> {
    Ok(match change(&T::decode(value)?) {
        None => Some(value.to_vec()),
        Some(Change::Remove) => None,
        Some(Change::Replace(row)) => Some(T::encode(&row)?),
    })
}
