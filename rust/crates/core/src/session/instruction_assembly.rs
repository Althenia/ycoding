use super::{history::Entry, instruction_state, key, projector, store::Service};
mod context;
use crate::instructions::{self, Error, Observed, Source};
pub use context::Context;
use std::collections::BTreeMap;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, domain, instruction, session, session_message,
};
use ycoding_store::{
    Snapshot,
    session::{
        Document, InstructionBlob, InstructionBlobTable, InstructionState, InstructionStateTable,
        NewEvent,
    },
};

pub struct Observation {
    pub session_id: session::Id,
    pub initial: bool,
    pub delta: instruction::Delta,
    pub blobs: BTreeMap<LosslessString, JsonValue>,
    pub current: instruction::Values,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Assembly {
    pub initial: LosslessString,
    pub updates: Vec<Entry>,
    pub current: JsonObject,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Preview {
    pub initial: LosslessString,
    pub updates: Vec<Entry>,
    pub update: LosslessString,
}

pub fn tool_permissions(
    agent: &ycoding_schema::agent::Info,
    ceiling: &[ycoding_schema::permission::Rule],
) -> ycoding_schema::permission::Ruleset {
    let mut permissions = agent.permissions.clone();
    permissions.extend_from_slice(ceiling);
    if agent.mode.as_str() == Some("subagent") {
        permissions.extend(["subagent", "subagent_control"].map(|name| {
            ycoding_schema::permission::Rule {
                action: name.into(),
                resource: "*".into(),
                effect: ycoding_schema::permission::Effect("deny".into()),
            }
        }));
    }
    permissions
}

pub fn select_sources(
    sources: &[Source],
    agent: &ycoding_schema::agent::Info,
    ceiling: &[ycoding_schema::permission::Rule],
    configuration: &crate::resources::config::Configuration,
    registry: &crate::tools::registry::Registry,
) -> Vec<Source> {
    let tools = registry.available(&tool_permissions(agent, ceiling));
    let memory_enabled =
        crate::resources::memory::Limits::from_configuration(configuration).enabled;
    sources
        .iter()
        .flat_map(|source| {
            let key = instructions::key(&source.key);
            let name = match key.as_str() {
                Some(crate::resources::memory::instructions::KEY) => Some("memory"),
                Some(crate::resources::project_artifact::instructions::KEY) => {
                    Some("project-artifact-authoring")
                }
                Some(key) => key.strip_prefix("core/").filter(|name| {
                    crate::resources::config::capabilities::BUILTIN_INSTRUCTIONS.contains(name)
                }),
                None => None,
            };
            let enabled = name.is_none_or(|name| {
                (name != "memory" || memory_enabled)
                    && instructions::builtins::enabled(name, &configuration.capabilities, &tools)
            });
            instructions::when(enabled, vec![source.clone()])
        })
        .collect()
}

impl Service {
    pub async fn observe_instructions(
        &self,
        id: &session::Id,
        sources: &[Source],
    ) -> Result<Observation, Error> {
        let observed = instructions::read(sources).await?;
        let (state, cached) = {
            let snapshot = self.client.snapshot()?;
            (
                instruction_state::read(&snapshot, id)?,
                snapshot.get::<InstructionStateTable>(&key(id.as_lossless()))?,
            )
        };
        if state != cached {
            self.rebuild_instruction_state(id).await?;
        }
        observation(id, observed, state.as_ref())
    }

    pub async fn commit_instructions(
        &self,
        observation: Observation,
        now: i64,
    ) -> Result<(), Error> {
        if !observation.initial && observation.delta.0.is_empty() {
            return Ok(());
        }
        let event_id = projector::random_event_id()?;
        self.client
            .submit(move |tx| {
                for (hash, value) in observation.blobs {
                    if instructions::hash(&value).encode() != JsonValue::String(hash.clone()) {
                        return Err(ycoding_store::Error::Rejected(
                            "instruction blob hash mismatch",
                        ));
                    }
                    if tx.get::<InstructionBlobTable>(&key(&hash))?.is_none() {
                        InstructionBlobTable::insert(
                            tx,
                            &InstructionBlob {
                                hash,
                                value: Some(Document::from_domain(
                                    &domain::Json::decode(&value)
                                        .map_err(projector::record_error)?,
                                )?),
                            },
                        )?;
                    }
                }
                projector::append(
                    tx,
                    &NewEvent {
                        id: event_id.as_lossless().clone(),
                        aggregate_id: observation.session_id.as_lossless().clone(),
                        created: now,
                        type_: "session.instructions.updated.2".into(),
                        data: ObjectEncoder::new()
                            .field("sessionID", &observation.session_id)
                            .field("delta", &observation.delta)
                            .finish(),
                    },
                )?;
                Ok(())
            })?
            .await?;
        Ok(())
    }

    pub async fn prepare_instructions(
        &self,
        id: &session::Id,
        sources: &[Source],
        now: i64,
    ) -> Result<(), Error> {
        self.commit_instructions(self.observe_instructions(id, sources).await?, now)
            .await
    }

    pub fn assemble_instructions(
        &self,
        id: &session::Id,
        sources: &[Source],
    ) -> Result<Assembly, Error> {
        assemble(&self.client.snapshot()?, id, sources)
    }

    pub async fn preview_instructions(
        &self,
        id: &session::Id,
        sources: &[Source],
    ) -> Result<Preview, Error> {
        let observed = instructions::read(sources).await?;
        preview(&self.client.snapshot()?, id, sources, observed)
    }
}

fn observation(
    id: &session::Id,
    observed: Vec<Observed>,
    state: Option<&InstructionState>,
) -> Result<Observation, Error> {
    let previous = state
        .map(|state| state.current_values.domain())
        .transpose()?;
    let admission = instructions::diff(&observed, previous.as_ref())?;
    Ok(Observation {
        session_id: id.clone(),
        initial: state.is_none(),
        current: instructions::apply_hash_delta(
            &previous.unwrap_or_else(|| instruction::Values(JsonObject::new())),
            &admission.delta,
        ),
        delta: admission.delta,
        blobs: admission.blobs,
    })
}

pub fn assemble(
    snapshot: &Snapshot,
    id: &session::Id,
    sources: &[Source],
) -> Result<Assembly, Error> {
    let state = instruction_state::read(snapshot, id)?.ok_or(ycoding_store::Error::Rejected(
        "Instruction state not found during assembly",
    ))?;
    assemble_state(snapshot, id, sources, &state)
}

fn assemble_state(
    snapshot: &Snapshot,
    id: &session::Id,
    sources: &[Source],
    state: &InstructionState,
) -> Result<Assembly, Error> {
    let initial = dereference(snapshot, &state.initial_values.domain()?)?;
    let mut current = initial.clone();
    let mut updates = Vec::new();
    for event in instruction_state::updates(snapshot, id, state.epoch_start)? {
        let path = JsonPath::default();
        let delta: instruction::Delta = ObjectDecoder::new(&event.data, &path)
            .map_err(projector::record_error)?
            .field("delta")
            .map_err(projector::record_error)?;
        let delta = dereference_delta(snapshot, &delta, &BTreeMap::new())?;
        let text = instructions::render_update(sources, &current, &delta)?;
        if !text.is_empty() {
            updates.push(Entry {
                seq: event.seq,
                message: session_message::Info::System(session_message::System {
                    id: session_message::Id::from_event(
                        &ycoding_schema::event::Id::new(event.id)
                            .map_err(projector::record_error)?,
                    ),
                    metadata: None,
                    text,
                    time: session_message::BaseTime {
                        created: ycoding_schema::schema::DateTimeUtcFromMillis::new(
                            event.created as f64,
                        )
                        .map_err(projector::record_error)?,
                    },
                }),
            });
        }
        current = instructions::apply_delta(&current, &delta);
    }
    Ok(Assembly {
        initial: instructions::render_initial(sources, &initial)?,
        updates,
        current,
    })
}

pub fn preview(
    snapshot: &Snapshot,
    id: &session::Id,
    sources: &[Source],
    observed: Vec<Observed>,
) -> Result<Preview, Error> {
    let state = instruction_state::read(snapshot, id)?;
    let observation = observation(id, observed, state.as_ref())?;
    let delta = dereference_delta(snapshot, &observation.delta, &observation.blobs)?;
    let Some(state) = state else {
        let values = instructions::apply_delta(&JsonObject::new(), &delta);
        return Ok(Preview {
            initial: instructions::render_initial(sources, &values)?,
            updates: Vec::new(),
            update: "".into(),
        });
    };
    let assembled = assemble_state(snapshot, id, sources, &state)?;
    Ok(Preview {
        initial: assembled.initial,
        update: instructions::render_update(sources, &assembled.current, &delta)?,
        updates: assembled.updates,
    })
}

fn dereference(snapshot: &Snapshot, values: &instruction::Values) -> Result<JsonObject, Error> {
    let mut result = JsonObject::new();
    for (key, hash) in values.0.iter() {
        let JsonValue::String(hash) = hash else {
            return Err(ycoding_store::Error::Rejected("invalid instruction hash").into());
        };
        result.insert(key.clone(), blob(snapshot, hash)?);
    }
    Ok(result)
}

fn dereference_delta(
    snapshot: &Snapshot,
    delta: &instruction::Delta,
    fresh: &BTreeMap<LosslessString, JsonValue>,
) -> Result<BTreeMap<LosslessString, Option<JsonValue>>, Error> {
    delta
        .0
        .iter()
        .map(|(key, hash)| {
            let JsonValue::String(hash) = hash else {
                return Err(ycoding_store::Error::Rejected("invalid instruction hash").into());
            };
            let value = if hash.as_str() == Some("removed") {
                None
            } else {
                Some(match fresh.get(hash) {
                    Some(value) => value.clone(),
                    None => blob(snapshot, hash)?,
                })
            };
            Ok((key.clone(), value))
        })
        .collect()
}

fn blob(snapshot: &Snapshot, hash: &LosslessString) -> Result<JsonValue, Error> {
    let row = snapshot
        .get::<InstructionBlobTable>(&key(hash))?
        .ok_or(ycoding_store::Error::Rejected("Instruction blob not found"))?;
    Ok(row
        .value
        .as_ref()
        .map_or(JsonValue::Null, |value| value.value().clone()))
}
