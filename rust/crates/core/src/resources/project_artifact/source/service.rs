use super::{read_standard_source, validate};
use crate::{
    event_feed::{Feed, Payload, Scope},
    resources::{
        agent, command, discovery,
        project_artifact::{accounting, adapter, package, source_registry::Registry, store},
        skill,
    },
    session::{autonomy, history, projector},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Bound,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, location, project,
    project_artifact, session, session_message,
};
use ycoding_store::{
    Client, Error, IndexOrder, IndexQuery, KeyPart, Write,
    session::{Event, EventTable, NewEvent},
    tuple_key,
};

#[derive(Clone, Debug, PartialEq)]
pub struct Provenance {
    pub scope: &'static str,
    pub scope_id: project_artifact::ScopeId,
    pub version_id: project_artifact::VersionId,
    pub kind: project_artifact::Kind,
    pub id: project_artifact::Id,
    pub expected_revision: project_artifact::Revision,
    pub expected_digest: project_artifact::Digest,
}
impl Provenance {
    pub fn message(&self) -> session_message::ArtifactProvenance {
        session_message::ArtifactProvenance {
            scope_id: self.scope_id.as_lossless().clone(),
            version_id: self.version_id.as_lossless().clone(),
            kind: self.kind.as_lossless().clone(),
            id: self.id.as_lossless().clone(),
            source_scope: self.scope.into(),
        }
    }
}
#[derive(Clone)]
pub struct Catalogs {
    pub agents: agent::Service,
    pub commands: command::Service,
    pub skills: skill::Service,
}
pub struct Options {
    pub client: Client,
    pub store: store::Service,
    pub accounting: accounting::Service,
    pub registry: Arc<Mutex<Registry>>,
    pub location: location::Ref,
    pub project_id: project::Id,
    pub project_directory: PathBuf,
    pub data_root: PathBuf,
}
pub enum ActivationSource {
    AgentSelected {
        boundary_seq: project_artifact::Revision,
        activated_at: project_artifact::TimestampMillis,
    },
    Command {
        message_id: LosslessString,
        call_id: Option<LosslessString>,
    },
    SkillTool {
        message_id: LosslessString,
        call_id: Option<LosslessString>,
    },
    SubagentLaunch {
        message_id: LosslessString,
        call_id: Option<LosslessString>,
    },
}
pub struct ActivationInput {
    pub kind: project_artifact::Kind,
    pub id: LosslessString,
    pub session_id: session::Id,
    pub agent_id: Option<ycoding_schema::agent::Id>,
    pub source: ActivationSource,
}
struct CatalogState {
    standard: Catalogs,
    current: Catalogs,
    pending_standard: bool,
}
#[derive(Default)]
struct State {
    active: BTreeMap<String, Provenance>,
    executions: BTreeMap<session::Id, (bool, i64)>,
    terminals: BTreeSet<String>,
    managed: BTreeMap<session::Id, BTreeMap<LosslessString, project_artifact::Activation>>,
    diagnostics: BTreeSet<&'static str>,
    running: bool,
}
struct Inner {
    options: Options,
    key: String,
    catalogs: tokio::sync::Mutex<CatalogState>,
    state: Mutex<State>,
}
#[derive(Clone)]
pub struct Service(Arc<Inner>);
struct Invocation {
    source: &'static str,
    message: Option<LosslessString>,
    call: Option<LosslessString>,
    seq: i64,
    created: i64,
}
impl Service {
    pub fn new(options: Options, standard: Catalogs) -> Self {
        let key = ycoding_schema::stringify_json(&options.location.encode());
        Self(Arc::new(Inner {
            options,
            key,
            catalogs: tokio::sync::Mutex::new(CatalogState {
                current: standard.clone(),
                standard,
                pending_standard: true,
            }),
            state: Mutex::new(State::default()),
        }))
    }
    pub async fn catalogs(&self) -> Catalogs {
        self.0.catalogs.lock().await.current.clone()
    }
    pub async fn replace_standard(&self, catalogs: Catalogs) {
        let mut state = self.0.catalogs.lock().await;
        state.standard = catalogs;
        state.pending_standard = true;
        self.refresh_locked(&mut state).await;
    }
    pub async fn refresh(&self) {
        let mut catalogs = self.0.catalogs.lock().await;
        self.refresh_locked(&mut catalogs).await;
    }
    async fn refresh_locked(&self, catalogs: &mut CatalogState) {
        if self.refresh_unsafe(catalogs).await.is_err() {
            lock(&self.0.state).diagnostics.insert("refresh-failed");
        }
    }
    async fn refresh_unsafe(&self, catalogs: &mut CatalogState) -> Result<(), Error> {
        let options = &self.0.options;
        let observed_catalogs = if catalogs.pending_standard {
            &mut catalogs.standard
        } else {
            &mut catalogs.current
        };
        let mut observed = Vec::new();
        for info in observed_catalogs
            .skills
            .list()
            .await
            .map_err(|_| failure("Skill source read failed"))?
        {
            if let Ok(id) = project_artifact::Id::decode(&JsonValue::String(info.id.clone())) {
                observed.push(read_standard_source(
                    &kind("skill"),
                    &id,
                    info.location
                        .as_lossless()
                        .as_str()
                        .map(std::path::Path::new),
                    &options.project_directory,
                    &options.project_id,
                ));
            }
        }
        for (kind, id, locations) in observed_catalogs
            .commands
            .list()
            .iter()
            .map(|info| (kind("command"), &info.name, &info.locations))
            .chain(
                observed_catalogs
                    .agents
                    .list()
                    .into_iter()
                    .map(|info| (kind("agent"), &info.id, &info.locations)),
            )
        {
            let Ok(id) = project_artifact::Id::decode(&JsonValue::String(id.clone())) else {
                continue;
            };
            let paths = locations
                .as_ref()
                .filter(|paths| !paths.is_empty())
                .map(|paths| paths.iter().map(Some).collect::<Vec<_>>())
                .unwrap_or_else(|| vec![None]);
            for path in paths {
                observed.push(read_standard_source(
                    &kind,
                    &id,
                    path.and_then(|path| path.as_lossless().as_str())
                        .map(std::path::Path::new),
                    &options.project_directory,
                    &options.project_id,
                ));
            }
        }
        let mut details = Vec::new();
        if options.project_id.as_lossless().as_str() != Some("global") {
            let scope = options
                .store
                .resolve_project_scope(&options.project_id)
                .map_err(|_| failure("Project scope read failed"))?;
            for stage in ["trial", "active"] {
                let stage = project_artifact::Stage::decode(&JsonValue::String(stage.into()))
                    .expect("fixed stage");
                for summary in options
                    .store
                    .list(&scope.id, None, Some(&stage))
                    .map_err(|_| failure("Artifact list failed"))?
                {
                    details.push(
                        options
                            .store
                            .get(&scope.id, &summary.kind, &summary.id)
                            .map_err(|_| failure("Artifact read failed"))?,
                    );
                }
            }
        }
        let candidates = details
            .iter()
            .filter_map(|details| validate(details, &options.data_root))
            .collect::<Vec<_>>();
        let standard = observed
            .into_iter()
            .filter(|source| {
                !candidates.iter().any(|candidate| {
                    source.kind == candidate.kind
                        && source.id == candidate.id
                        && (source.path.as_ref() == Some(&candidate.version.content_path)
                            || source.source.managed_scope_id.as_ref()
                                == Some(&candidate.version.scope_id))
                })
            })
            .collect::<Vec<_>>();
        let allowed = candidates
            .iter()
            .filter(|candidate| {
                let existing = standard
                    .iter()
                    .filter(|source| source.kind == candidate.kind && source.id == candidate.id)
                    .collect::<Vec<_>>();
                let allowed = existing.is_empty()
                    || candidate.details.artifact.shadowed_scope_id.is_some()
                        && existing.iter().all(|source| {
                            source.source.scope.as_str() == Some("global")
                                && source.source.managed_scope_id
                                    == candidate.details.artifact.shadowed_scope_id
                                && source.source.managed_version_id
                                    == candidate
                                        .details
                                        .current_version
                                        .provenance
                                        .origin_version_id
                                && source.source.managed_digest
                                    == candidate
                                        .details
                                        .current_version
                                        .provenance
                                        .origin_evidence_digest
                        });
                if !allowed {
                    lock(&self.0.state).diagnostics.insert("collision");
                }
                allowed
            })
            .collect::<Vec<_>>();
        let mut active = BTreeMap::new();
        for candidate in &allowed {
            active.insert(
                candidate_key(&candidate.kind, candidate.id.as_lossless()),
                provenance(candidate.details, "project"),
            );
        }
        let global = options
            .store
            .resolve_global_scope()
            .map_err(|_| failure("Global scope read failed"))?;
        for source in &standard {
            let (Some(scope), Some(version), Some(digest)) = (
                &source.source.managed_scope_id,
                &source.source.managed_version_id,
                &source.source.managed_digest,
            ) else {
                continue;
            };
            if source.source.scope.as_str() != Some("global") || scope != &global.id {
                continue;
            }
            let Ok(details) = options.store.get(scope, &source.kind, &source.id) else {
                continue;
            };
            if details.current_version.id == *version
                && details.current_version.content_digest == *digest
            {
                active.insert(
                    candidate_key(&source.kind, source.id.as_lossless()),
                    provenance(&details, "global"),
                );
            }
        }
        let mut current = catalogs.standard.clone();
        for candidate in &allowed {
            adapter::activate(
                &candidate.version,
                adapter::RuntimeDraft {
                    skill: Some(&mut current.skills),
                    command: Some(&mut current.commands),
                    agent: Some(&mut current.agents),
                },
            )
            .map_err(|_| failure("Artifact registration failed"))?;
        }
        lock(&options.registry).replace(self.0.key.clone(), standard);
        lock(&self.0.state).active = active;
        catalogs.current = current;
        catalogs.pending_standard = false;
        Ok(())
    }
    pub fn provenance(&self, kind: &project_artifact::Kind, id: &str) -> Option<Provenance> {
        lock(&self.0.state)
            .active
            .get(&candidate_key(kind, &id.into()))
            .cloned()
    }
    pub fn diagnostics(&self) -> Vec<&'static str> {
        lock(&self.0.state).diagnostics.iter().copied().collect()
    }
    pub fn record_activation_failure(&self) {
        lock(&self.0.state).diagnostics.insert("activation-failed");
    }
    pub fn activate(&self, input: ActivationInput) -> Result<(), Error> {
        let Some(provenance) = lock(&self.0.state)
            .active
            .get(&candidate_key(&input.kind, &input.id))
            .cloned()
        else {
            return Ok(());
        };
        let (source, message, call, boundary) = match input.source {
            ActivationSource::AgentSelected {
                boundary_seq,
                activated_at,
            } => (
                "agent-selected",
                None,
                None,
                Some((boundary_seq.get(), activated_at.get())),
            ),
            ActivationSource::Command {
                message_id,
                call_id,
            } => ("command", Some(message_id), call_id, None),
            ActivationSource::SkillTool {
                message_id,
                call_id,
            } => ("skill-tool", Some(message_id), call_id, None),
            ActivationSource::SubagentLaunch {
                message_id,
                call_id,
            } => ("subagent-launch", Some(message_id), call_id, None),
        };
        let (seq, created) = if let Some(boundary) = boundary {
            boundary
        } else {
            let snapshot = self.0.options.client.snapshot()?;
            let prefix = tuple_key(&[KeyPart::String(input.session_id.as_lossless())]);
            let mut after = None;
            let invocation = loop {
                let page = snapshot.index_range::<EventTable>(
                    "event_aggregate_seq_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 128,
                    },
                )?;
                if let Some(event) = page.iter().find(|row| {
                    let expected = if source == "command" {
                        "session.input.admitted.1"
                    } else {
                        "session.tool.called.1"
                    };
                    row.record.type_.as_str() == Some(expected)
                        && field(
                            &row.record.data,
                            if source == "command" {
                                "inputID"
                            } else {
                                "assistantMessageID"
                            },
                        ) == message
                            .as_ref()
                            .map(|message| JsonValue::String(message.clone()))
                            .as_ref()
                        && (source == "command"
                            || field(&row.record.data, "callID")
                                == call
                                    .as_ref()
                                    .map(|call| JsonValue::String(call.clone()))
                                    .as_ref())
                }) {
                    break Some((event.record.seq, event.record.created));
                }
                if page.is_empty() {
                    break None;
                }
                after = page.last().map(|row| row.cursor.clone());
            };
            invocation.ok_or_else(|| failure("Managed activation requires a durable invocation"))?
        };
        let activation = self.activation(
            &provenance,
            &input.session_id,
            input.agent_id,
            Invocation {
                source,
                message,
                call,
                seq,
                created,
            },
        )?;
        self.0.options.accounting.activate(&activation)?;
        self.capture(&input.session_id, activation);
        Ok(())
    }
    pub fn activation_at(
        &self,
        provenance: &Provenance,
        session: &session::Id,
        agent: Option<ycoding_schema::agent::Id>,
        source: &'static str,
        seq: i64,
        created: i64,
    ) -> Result<project_artifact::Activation, Error> {
        self.activation(
            provenance,
            session,
            agent,
            Invocation {
                source,
                message: None,
                call: None,
                seq,
                created,
            },
        )
    }
    fn activation(
        &self,
        provenance: &Provenance,
        session: &session::Id,
        agent: Option<ycoding_schema::agent::Id>,
        invocation: Invocation,
    ) -> Result<project_artifact::Activation, Error> {
        let digest = package::sha256(&discovery::join(
            &[
                session.as_lossless().clone(),
                provenance.version_id.as_lossless().clone(),
                invocation.source.into(),
                invocation.seq.to_string().into(),
                invocation.message.clone().unwrap_or_default(),
                invocation.call.clone().unwrap_or_default(),
            ],
            "\0",
        ));
        let id = if invocation.source == "session-skill" {
            format!(
                "paa_{}",
                package::uuid().map_err(|_| failure("Activation entropy unavailable"))?
            )
        } else {
            format!(
                "paa_{}",
                &digest.as_lossless().as_str().expect("digest")[..32]
            )
        };
        project_artifact::Activation::decode(
            &ObjectEncoder::new()
                .field("id", &LosslessString::from(id))
                .field(
                    "artifact",
                    &ObjectEncoder::new()
                        .field("scopeID", &provenance.scope_id)
                        .field("versionID", &provenance.version_id)
                        .field("kind", &provenance.kind)
                        .field("id", &provenance.id)
                        .finish(),
                )
                .field("projectID", &self.0.options.project_id)
                .field("sessionID", session)
                .optional("agentID", &agent)
                .field("source", invocation.source)
                .optional("messageID", &invocation.message)
                .optional("callID", &invocation.call)
                .field("boundarySeq", &(invocation.seq as f64))
                .field("activatedAt", &(invocation.created as f64))
                .finish(),
        )
        .map_err(|error| Error::Record(Box::new(error)))
    }
    fn capture(&self, session: &session::Id, activation: project_artifact::Activation) {
        lock(&self.0.state)
            .managed
            .entry(session.clone())
            .or_default()
            .insert(activation.id.as_lossless().clone(), activation);
    }
    pub fn activate_in_transaction(
        &self,
        tx: &mut Write<'_>,
        activation: &project_artifact::Activation,
    ) -> Result<(), Error> {
        accounting::Service::activate_in_transaction(tx, activation).map(|_| ())
    }
    pub async fn publish_activation(&self, mut event: NewEvent) -> Result<Event, Error> {
        let (kind, source, id) = match event.type_.as_str() {
            Some("session.agent.selected.1") => {
                (kind("agent"), "agent-selected", field(&event.data, "agent"))
            }
            Some("session.skill.activated.1") => {
                (kind("skill"), "session-skill", field(&event.data, "id"))
            }
            _ => {
                return Err(failure(
                    "Activation publication requires agent-selected or session-skill",
                ));
            }
        };
        let id = id
            .and_then(|id| {
                if let JsonValue::String(id) = id {
                    id.as_str()
                } else {
                    None
                }
            })
            .ok_or_else(|| failure("Activation publication requires an ID"))?;
        let provenance = self.provenance(&kind, id);
        if let Some(provenance) = &provenance {
            let JsonValue::Object(data) = &mut event.data else {
                return Err(failure("Activation event data must be an object"));
            };
            data.insert("artifact".into(), provenance.message().encode());
        }
        let session_id = session::Id::new(event.aggregate_id.clone())
            .map_err(|error| Error::Record(Box::new(error)))?;
        let service = self.clone();
        let id = session_id.clone();
        let (event, activation) = self
            .0
            .options
            .client
            .submit(move |tx| {
                let event = projector::append(tx, &event)?;
                let activation = provenance
                    .as_ref()
                    .map(|provenance| {
                        let agent = tx
                            .get::<ycoding_store::session::SessionTable>(&tuple_key(&[
                                KeyPart::String(id.as_lossless()),
                            ]))?
                            .and_then(|session| session.agent);
                        let activation = service.activation_at(
                            provenance,
                            &id,
                            agent,
                            source,
                            event.seq,
                            event.created,
                        )?;
                        service.activate_in_transaction(tx, &activation)?;
                        Ok::<_, Error>(activation)
                    })
                    .transpose()
                    .map_err(|error| tx.reject(error))?;
                Ok((event, activation))
            })?
            .await?;
        if let Some(activation) = activation {
            self.capture(&session_id, activation);
        }
        Ok(event)
    }
    pub fn start(&self, feed: &Feed) -> Result<Governor, Error> {
        let mut state = lock(&self.0.state);
        if state.running {
            return Err(failure("Artifact governor already started"));
        }
        let notify = Arc::new(tokio::sync::Notify::new());
        let wake = notify.clone();
        let subscriber = feed
            .subscribe_types(
                Scope::Global,
                &[
                    "session.execution.started.1",
                    "session.execution.succeeded.1",
                    "session.execution.failed.1",
                    "session.execution.interrupted.1",
                ],
                move || wake.notify_one(),
            )
            .map_err(|_| failure("Artifact feed subscription failed"))?;
        state.running = true;
        let (control, mut commands) = tokio::sync::mpsc::channel::<Barrier>(1);
        let service = self.clone();
        let observed_feed = feed.clone();
        let task = tokio::spawn(async move {
            let mut barrier: Option<Barrier> = None;
            loop {
                if barrier.is_none() {
                    match commands.try_recv() {
                        Ok(command) => barrier = Some(command),
                        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                            barrier = Some(Barrier {
                                position: observed_feed.watermark(),
                                close: true,
                                reply: None,
                            })
                        }
                        Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
                    }
                }
                if let Some(item) = subscriber
                    .next()
                    .map_err(|_| failure("Artifact feed overflow"))?
                {
                    if barrier
                        .as_ref()
                        .is_some_and(|barrier| item.position > barrier.position)
                    {
                        let command = barrier.take().expect("barrier was checked");
                        if let Some(reply) = command.reply {
                            let _ = reply.send(());
                        }
                        if command.close {
                            return Ok(());
                        }
                    }
                    let Payload::Durable(event) = &item.payload else {
                        continue;
                    };
                    if !matches!(
                        event.type_.as_str(),
                        Some(
                            "session.execution.started.1"
                                | "session.execution.succeeded.1"
                                | "session.execution.failed.1"
                                | "session.execution.interrupted.1"
                        )
                    ) {
                        continue;
                    }
                    let service = service.clone();
                    let event = event.clone();
                    tokio::task::spawn_blocking(move || {
                        if service.observe_event(&event).is_err() {
                            lock(&service.0.state)
                                .diagnostics
                                .insert("terminal-observation-failed");
                        }
                    })
                    .await
                    .map_err(|_| failure("Artifact governor task failed"))?;
                    continue;
                }
                if let Some(command) = barrier.take() {
                    if let Some(reply) = command.reply {
                        let _ = reply.send(());
                    }
                    if command.close {
                        return Ok(());
                    }
                }
                tokio::select! {
                    _ = notify.notified() => {},
                    command = commands.recv() => barrier = Some(command.unwrap_or_else(|| Barrier { position: observed_feed.watermark(), close: true, reply: None })),
                }
            }
        });
        Ok(Governor {
            service: self.clone(),
            feed: feed.clone(),
            control,
            task,
        })
    }
    fn observe_event(&self, event: &Event) -> Result<(), Error> {
        let id = session::Id::new(event.aggregate_id.clone())
            .map_err(|error| Error::Record(Box::new(error)))?;
        let sessions = crate::session::store::Service::new(self.0.options.client.clone());
        let Some(session) = sessions
            .get(&id)?
            .filter(|session| session.location == self.0.options.location)
        else {
            return Ok(());
        };
        let autonomy = autonomy::Service::new(self.0.options.client.clone());
        let goal = autonomy
            .get(&id)
            .map_err(|_| failure("Autonomy read failed"))?;
        if event.type_.as_str() == Some("session.execution.started.1") {
            lock(&self.0.state).executions.insert(
                id,
                (
                    goal.goal.as_ref().is_some_and(|goal| goal.is_active()),
                    event.created,
                ),
            );
            return Ok(());
        }
        let assistant = sessions.latest(&id, "assistant")?;
        let assistant = assistant.as_ref().and_then(|message| {
            if let session_message::Info::Assistant(assistant) = message {
                Some(assistant.as_ref())
            } else {
                None
            }
        });
        let terminal = format!(
            "{}:{}",
            id.as_lossless().as_str().expect("session ID"),
            assistant
                .map(|assistant| assistant
                    .id
                    .as_lossless()
                    .as_str()
                    .expect("message ID")
                    .to_string())
                .unwrap_or_else(|| format!("boundary:{}", event.seq))
        );
        let (execution, activations) = {
            let state = lock(&self.0.state);
            if state.terminals.contains(&terminal) {
                return Ok(());
            }
            (
                state.executions.get(&id).copied(),
                state
                    .managed
                    .get(&id)
                    .map(|activations| activations.values().cloned().collect::<Vec<_>>())
                    .unwrap_or_default(),
            )
        };
        let snapshot = self.0.options.client.snapshot()?;
        let compaction = history::latest_compaction(&snapshot, &id)?;
        let mut after = None;
        let mut managed = BTreeSet::new();
        let mut standard_count = 0;
        loop {
            let rows = ycoding_store::session::messages(
                &snapshot,
                id.as_lossless(),
                compaction.map_or(Bound::Unbounded, Bound::Included),
                Bound::Unbounded,
                IndexOrder::Ascending,
                after.as_ref(),
                128,
            )?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(|row| row.cursor.clone());
            for row in rows.iter().filter(|row| {
                matches!(
                    row.record.type_.as_str(),
                    Some("skill" | "agent-switched" | "user")
                )
            }) {
                let artifact = if row.record.type_.as_str() == Some("user") {
                    field(&row.record.data, "metadata")
                        .and_then(|metadata| field(metadata, "projectArtifact"))
                } else {
                    field(&row.record.data, "artifact")
                };
                let kind = artifact
                    .and_then(|artifact| field(artifact, "kind"))
                    .and_then(|kind| {
                        if let JsonValue::String(kind) = kind {
                            Some(kind.clone())
                        } else {
                            None
                        }
                    });
                if let Some(kind) = kind {
                    managed.insert(kind);
                } else if row.record.type_.as_str() == Some("skill") {
                    standard_count += 1;
                }
            }
        }
        for activation in &activations {
            managed.insert(activation.artifact.identity.kind.as_lossless().clone());
        }
        let tools = assistant
            .map(|assistant| {
                assistant
                    .content
                    .iter()
                    .filter_map(|content| {
                        if let session_message::AssistantContent::Tool(tool) = content {
                            Some(tool.as_ref())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        standard_count += tools
            .iter()
            .filter(|tool| {
                matches!(tool.state, session_message::ToolState::Completed(_))
                    && matches!(tool.name.as_str(), Some("skill" | "subagent"))
                    && !activations
                        .iter()
                        .any(|activation| managed_tool(activation, assistant, tool))
            })
            .count();
        let goal_mode = execution.is_some_and(|execution| execution.0);
        let outcome = match event.type_.as_str() {
            Some("session.execution.succeeded.1") => "succeeded",
            Some("session.execution.failed.1") => "failed",
            _ => "interrupted",
        };
        let goal_status = if goal_mode {
            goal.goal
                .as_ref()
                .map(|goal| goal.status.as_str())
                .filter(|status| matches!(*status, "completed" | "stopped" | "exhausted"))
                .unwrap_or("none")
        } else {
            "none"
        };
        let tokens = assistant.and_then(|assistant| assistant.tokens.as_ref());
        let input = accounting::ObserveInput {
            project_id: session.project_id,
            session_id: id.clone(),
            terminal_message_id: assistant.map(|assistant| {
                project_artifact::NonEmptyText::decode(&JsonValue::String(
                    assistant.id.as_lossless().clone(),
                ))
                .expect("message ID")
            }),
            boundary_seq: number(event.seq),
            kind: project_artifact::Kind::decode(&JsonValue::String(
                managed.first().cloned().unwrap_or_else(|| "skill".into()),
            ))
            .expect("artifact kind"),
            agent_id: session.agent.clone(),
            model_id: session
                .model
                .as_ref()
                .map(|model| discovery::join(&[model.provider_id.0.clone(), model.id.clone()], "/"))
                .unwrap_or_else(|| "unknown".into()),
            goal_mode,
            standard_invocation_count: number(standard_count as i64),
            external_confounded: managed.len() > 1,
            terminal_outcome: project_artifact::TerminalOutcome::decode(&JsonValue::String(
                outcome.into(),
            ))
            .expect("terminal outcome"),
            goal_status: project_artifact::GoalStatus::decode(&JsonValue::String(
                goal_status.into(),
            ))
            .expect("goal status"),
            repeat_fix: false,
            latency_ms: execution.map(|execution| number((event.created - execution.1).max(0))),
            input_tokens: Some(number(
                tokens
                    .map_or(0.0, |tokens| tokens.input.get())
                    .floor()
                    .max(0.0) as i64,
            )),
            output_tokens: Some(number(
                tokens
                    .map_or(0.0, |tokens| tokens.output.get())
                    .floor()
                    .max(0.0) as i64,
            )),
            cache_read_tokens: Some(number(
                tokens
                    .map_or(0.0, |tokens| tokens.cache.read.get())
                    .floor()
                    .max(0.0) as i64,
            )),
            completed_tool_count: Some(number(
                tools
                    .iter()
                    .filter(|tool| matches!(tool.state, session_message::ToolState::Completed(_)))
                    .count() as i64,
            )),
            failed_tool_count: Some(number(
                tools
                    .iter()
                    .filter(|tool| matches!(tool.state, session_message::ToolState::Error(_)))
                    .count() as i64,
            )),
            observed_at: number(event.created),
        };
        let observations = self.0.options.accounting.observe(&input)?;
        {
            let mut state = lock(&self.0.state);
            state.terminals.insert(terminal);
            state.executions.remove(&id);
        }
        let mut evaluated = BTreeSet::new();
        for observation in observations {
            if !evaluated.insert(observation.artifact.version_id.as_lossless().clone()) {
                continue;
            }
            let identity = &observation.artifact.identity;
            let provenance = lock(&self.0.state)
                .active
                .get(&candidate_key(&identity.kind, identity.id.as_lossless()))
                .cloned();
            let Some(provenance) = provenance.filter(|provenance| {
                provenance.scope_id == identity.scope_id
                    && provenance.version_id == observation.artifact.version_id
            }) else {
                lock(&self.0.state).diagnostics.insert("stale-provenance");
                continue;
            };
            let expected = project_artifact::MutationExpectation {
                expected_revision: provenance.expected_revision,
                expected_version_id: provenance.version_id,
                expected_digest: provenance.expected_digest,
            };
            if self
                .0
                .options
                .store
                .evaluate_governor(store::GovernorInput {
                    artifact: store::LifecycleInput {
                        scope_id: &provenance.scope_id,
                        kind: &provenance.kind,
                        id: &provenance.id,
                        expected: &expected,
                        now: event.created,
                    },
                    agent_id: session.agent.clone(),
                    model_id: input.model_id.clone(),
                    goal_mode,
                })
                .is_err()
            {
                lock(&self.0.state)
                    .diagnostics
                    .insert("governor-evaluation-failed");
            }
        }
        Ok(())
    }
}
pub struct Governor {
    service: Service,
    feed: Feed,
    control: tokio::sync::mpsc::Sender<Barrier>,
    task: tokio::task::JoinHandle<Result<(), Error>>,
}
struct Barrier {
    position: u64,
    close: bool,
    reply: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Governor {
    pub async fn flush(&self) -> Result<(), Error> {
        let (reply, completed) = tokio::sync::oneshot::channel();
        self.control
            .send(Barrier {
                position: self.feed.watermark(),
                close: false,
                reply: Some(reply),
            })
            .await
            .map_err(|_| failure("Artifact governor closed"))?;
        completed
            .await
            .map_err(|_| failure("Artifact governor task failed"))
    }
    pub async fn close(self) -> Result<(), Error> {
        let _ = self
            .control
            .send(Barrier {
                position: self.feed.watermark(),
                close: true,
                reply: None,
            })
            .await;
        let result = self
            .task
            .await
            .map_err(|_| failure("Artifact governor task failed"))
            .and_then(|result| result);
        lock(&self.service.0.state).running = false;
        lock(&self.service.0.options.registry).remove(&self.service.0.key);
        result
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        lock(&self.options.registry).remove(&self.key);
    }
}
fn candidate_key(kind: &project_artifact::Kind, id: &LosslessString) -> String {
    format!(
        "{}:{}",
        kind.as_lossless().as_str().expect("kind"),
        id.to_utf8().unwrap_or_default()
    )
}
fn provenance(details: &project_artifact::ArtifactDetails, scope: &'static str) -> Provenance {
    Provenance {
        scope,
        scope_id: match &details.artifact.scope {
            project_artifact::Scope::Project(scope) => scope.id.clone(),
            project_artifact::Scope::Global(scope) => scope.id.clone(),
        },
        version_id: details.current_version.id.clone(),
        kind: details.artifact.kind.clone(),
        id: details.artifact.id.clone(),
        expected_revision: details.artifact.revision,
        expected_digest: details.current_version.content_digest.clone(),
    }
}
fn kind(value: &str) -> project_artifact::Kind {
    project_artifact::Kind::decode(&JsonValue::String(value.into())).expect("fixed artifact kind")
}
fn number(value: i64) -> project_artifact::Revision {
    project_artifact::Revision::new(value).expect("nonnegative artifact fact")
}
fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    if let JsonValue::Object(value) = value {
        value.get(&key.into())
    } else {
        None
    }
}
fn failure(message: &'static str) -> Error {
    Error::Domain {
        kind: "artifact_source",
        message,
    }
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
fn managed_tool(
    activation: &project_artifact::Activation,
    assistant: Option<&session_message::Assistant>,
    tool: &session_message::AssistantTool,
) -> bool {
    activation
        .message_id
        .as_ref()
        .map(|message| message.as_lossless())
        == assistant.map(|assistant| assistant.id.as_lossless())
        && activation.call_id.as_ref().map(|call| call.as_lossless()) == Some(&tool.id)
        && match tool.name.as_str() {
            Some("skill") => activation.source.encode() == JsonValue::String("skill-tool".into()),
            Some("subagent") => {
                activation.source.encode() == JsonValue::String("subagent-launch".into())
            }
            _ => false,
        }
}
