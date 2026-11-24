mod types;
pub use types::{
    AnswerInput, AssignInput, AttachInput, AttachResult, AuthorizeLocation, CreateContext,
    CreateDirectory, CreateInput, CreatePrompt, CreateProvider, CreateResult, CreateTarget,
    CreateWorktree, CreatedWorktree, Decision, DecisionActor, DecisionEscalateInput,
    DecisionEscalateResult, DecisionOutcome, DecisionResult, Decisions, Delegation, Enrollment,
    EscalateInput, EscalateOutcome, EscalateResult, EscalationTarget, EvaluateInput, Future,
    InspectInput, InterruptInput, InterruptResult, MemberCreator, MemberInput, MemberResult,
    ModelInput, ModelServices, ModelServicesFactory, OpenDirectory, OwnershipResult, Pending,
    PendingInput, ReleaseInput, RemoveResult, RequestDetail, RequestField, Roster, RosterProject,
    SendInput, SendResult,
};

use super::{Admission, Error, Group, OwnerInput, Role, Scope, Service, authority::key, can_act};
use crate::{
    event_feed::{self, Payload},
    job,
    session::{
        autonomy, execution, family, orchestration, outstanding, pending,
        projector::random_event_id, prompt_cache, review_fold, step_boundary, store,
    },
};
use ring::digest;
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future as StdFuture,
    ops::Bound,
    sync::{Arc, Mutex, Weak},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue, LosslessString, Nullable,
    ObjectDecoder, ObjectEncoder, coordination as c, model,
    schema::{AbsolutePath, NonNegativeInt},
    session,
    session_delivery::Delivery,
    session_message,
    session_orchestration::Change,
    session_pending, stringify_json,
};
use ycoding_store::{
    IndexOrder, IndexQuery, Snapshot,
    coordination::MemberTable,
    project::ProjectTable,
    resources::{Kv, KvTable},
    session::{
        Document, Event, EventTable, MessageTable, NewEvent, NotificationTable, PendingTable,
        SessionTable, TaskTable,
    },
};

pub const NOTICE: &str = "project_notification";
pub const ESCALATION: &str = "project_escalation";
pub const INACTIVE_MESSAGE: &str =
    "Project is inactive; send a message in the master chat to resume";
pub const HANDLED_EVENTS: &[&str] = &[
    "session.input.admitted.1",
    "session.execution.started.1",
    "session.step.ended.1",
    "session.execution.interrupted.1",
    "session.execution.succeeded.1",
    "session.execution.failed.1",
    "form.created",
    "permission.asked",
    "guardrail.asked",
    "coordination.member.owner.changed.1",
    "coordination.group.changed.1",
    "coordination.group.deleted.1",
    "session.archived.2",
    "session.deleted.2",
    "session.task.updated.1",
];
pub type ValidateModel = Arc<dyn Fn(session::Id, model::Ref) -> Future<'static, ()> + Send + Sync>;

struct CreationPlacement {
    digest: LosslessString,
    directory: AbsolutePath,
    branch: Option<LosslessString>,
}
impl CreationPlacement {
    fn decode(value: &JsonValue) -> Result<Self, ycoding_schema::DecodeError> {
        let path = JsonPath::default();
        let object = ObjectDecoder::new(value, &path)?;
        Ok(Self {
            digest: object.field("digest")?,
            directory: object.field("directory")?,
            branch: object.optional("branch")?,
        })
    }
}
impl DomainEncode for CreationPlacement {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("digest", &self.digest)
            .field("directory", &self.directory)
            .optional("branch", &self.branch)
            .finish()
    }
}
pub struct Options {
    pub coordination: Service,
    pub sessions: store::Service,
    pub execution: &'static execution::Execution,
    pub decisions: Arc<dyn Decisions>,
    pub jobs: job::Jobs,
    pub validate_model: ValidateModel,
    pub model_services: ModelServicesFactory,
    pub creator: Option<Arc<dyn MemberCreator>>,
}
#[derive(Clone)]
pub struct Runtime(Arc<Inner>);
struct Inner {
    coordination: Service,
    sessions: store::Service,
    execution: &'static execution::Execution,
    decisions: Arc<dyn Decisions>,
    jobs: job::Jobs,
    validate_model: ValidateModel,
    model_services: ModelServicesFactory,
    creator: Option<Arc<dyn MemberCreator>>,
    senders: Mutex<BTreeMap<session::Id, session::Id>>,
    creation_locks: Mutex<BTreeMap<session::Id, Weak<tokio::sync::Mutex<()>>>>,
}

impl Runtime {
    pub fn new(options: Options) -> Self {
        Self(Arc::new(Inner {
            coordination: options.coordination,
            sessions: options.sessions,
            execution: options.execution,
            decisions: options.decisions,
            jobs: options.jobs,
            validate_model: options.validate_model,
            model_services: options.model_services,
            creator: options.creator,
            senders: Mutex::new(BTreeMap::new()),
            creation_locks: Mutex::new(BTreeMap::new()),
        }))
    }
    pub fn coordination(&self) -> &Service {
        &self.0.coordination
    }
    pub fn creator(&self) -> Option<Arc<dyn MemberCreator>> {
        self.0.creator.clone()
    }
    pub async fn settings(&self) -> Result<c::Settings, Error> {
        self.0.decisions.settings().await
    }
    pub async fn get(&self, id: &c::GroupId) -> Result<c::Info, Error> {
        let group = self.0.coordination.get(id)?;
        let scope = scope(&group);
        let running = self.running()?;
        let master = self
            .participant(&scope, &group.master_session_id, &running)
            .await?;
        let mut members = Vec::with_capacity(group.member_session_ids.len());
        for id in &group.member_session_ids {
            members.push(self.participant(&scope, id, &running).await?);
        }
        Ok(c::Info {
            id: group.id,
            name: group.name,
            revision: group.revision,
            active: group.active,
            paused_reason: group.paused_reason,
            master,
            members,
            settings: group.settings,
            time: group.time,
        })
    }
    pub async fn summaries(&self) -> Result<Vec<c::GroupSummary>, Error> {
        self.0
            .coordination
            .list()?
            .into_iter()
            .map(|group| {
                Ok(c::GroupSummary {
                    id: group.id,
                    name: group.name,
                    revision: group.revision,
                    active: group.active,
                    paused_reason: group.paused_reason,
                    master_session_id: group.master_session_id,
                    member_count: NonNegativeInt::new(group.member_session_ids.len() as i64)?,
                    settings: group.settings,
                    time: group.time,
                })
            })
            .collect()
    }
    pub async fn roster(&self, caller: &session::Id) -> Result<Roster, Error> {
        let scope = self.scope_for(caller)?;
        let group = self.0.coordination.get(&scope.group_id)?;
        let running = self.running()?;
        let mut members = Vec::with_capacity(scope.member_session_ids.len());
        for id in &scope.member_session_ids {
            members.push(self.participant(&scope, id, &running).await?);
        }
        Ok(Roster {
            project: RosterProject {
                id: scope.group_id,
                name: group.name,
                active: scope.active,
                paused_reason: group.paused_reason,
                concurrency: scope.settings.concurrency,
            },
            members,
        })
    }
    pub async fn send(&self, caller: &session::Id, input: SendInput) -> Result<SendResult, Error> {
        self.under_ownership(caller, self.send_inner(caller, input))
            .await
    }
    async fn send_inner(
        &self,
        caller: &session::Id,
        input: SendInput,
    ) -> Result<SendResult, Error> {
        if !(1..=32000).contains(&input.text.len()) {
            return Err(Error::refused(
                "Project message must contain 1 to 32000 code units",
            ));
        }
        let scope = self.member_scope(caller, &input.session_id)?;
        let message_id = match input.message_id {
            Some(id) => id,
            None => session_message::Id::from_event(&random_event_id()?),
        };
        match self.lookup(&input.session_id, &message_id)? {
            Lookup::Used {
                session_id,
                input: session_pending::Message::User(existing),
            } => {
                let provenance = existing
                    .data
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.get(&"coordination".into()));
                let group = provenance.and_then(|value| {
                    if let JsonValue::Object(fields) = value {
                        fields.get(&"groupID".into())
                    } else {
                        None
                    }
                });
                if session_id != *input.session_id.as_lossless()
                    || existing.data.text != input.text
                    || pending::input_origin(existing.data.metadata.as_ref())
                        != Some("coordination")
                    || group != Some(&scope.group_id.encode())
                {
                    return Err(Error::refused(
                        "Message identity is already used with different content",
                    ));
                }
                if self
                    .admitted_ready(&scope, caller, &input.session_id, Some(&message_id))
                    .await?
                {
                    self.0.execution.wake(&input.session_id)?;
                }
                return Ok(SendResult {
                    session_id: input.session_id.clone(),
                    message_id,
                    state: self.state_of(&scope, &input.session_id).await?,
                    reconciled: true,
                });
            }
            Lookup::Vacant => {}
            _ => return Err(Error::refused("Message identity is already used")),
        }
        let current = self.member_scope(caller, &input.session_id)?;
        if current.group_id != scope.group_id {
            return Err(Error::refused(
                "Session is no longer a member of this Project",
            ));
        }
        if !current.active {
            return Err(Error::refused(INACTIVE_MESSAGE));
        }
        let waiting = self.pending(&current, caller, &input.session_id).await?;
        if !waiting.is_empty() {
            return Err(Error::refused(waiting_message(&input.session_id, &waiting)));
        }
        let running = self.running()?;
        if let Nullable::Value(limit) = current.settings.concurrency {
            let mut busy = BTreeSet::new();
            for id in &current.member_session_ids {
                if running.contains(id.as_lossless()) || self.0.sessions.has_pending(id)? {
                    busy.insert(id);
                }
            }
            if !busy.contains(&input.session_id) && busy.len() >= limit.get() as usize {
                return Err(Error::refused(format!(
                    "Project concurrency limit {} reached",
                    limit.get()
                )));
            }
        }
        if let Some(model) = &input.model {
            (self.0.validate_model)(input.session_id.clone(), model.clone()).await?;
        }
        let event_id = random_event_id()?;
        let admission = Admission {
            group_id: current.group_id.clone(),
            master_session_id: current.master_session_id.clone(),
            sender_session_id: caller.clone(),
            message_id: message_id.clone(),
            model: input.model,
        };
        let request = pending::Request {
            id: message_id.clone(),
            session_id: input.session_id.clone(),
            input: session_pending::Message::User(session_pending::UserMessage {
                delivery: input.delivery.unwrap_or(Delivery::Queue),
                data: session_pending::UserData {
                    text: input.text,
                    files: None,
                    agents: None,
                    metadata: None,
                },
            }),
            event_id,
            created: chrono::Utc::now().timestamp_millis(),
        };
        self.0
            .execution
            .prompt_coordination(request, Some(false), admission)
            .await?;
        self.0
            .senders
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(input.session_id.clone(), caller.clone());
        self.0.execution.wake(&input.session_id)?;
        Ok(SendResult {
            session_id: input.session_id.clone(),
            message_id,
            state: self.state_of(&scope, &input.session_id).await?,
            reconciled: false,
        })
    }
    pub async fn answer(
        &self,
        caller: &session::Id,
        input: AnswerInput,
    ) -> Result<DecisionResult, Error> {
        self.under_ownership(caller, async {
            let scope = self.member_scope(caller, &input.session_id)?;
            self.0
                .decisions
                .evaluate(EvaluateInput {
                    group_id: scope.group_id,
                    coordinator_session_id: caller.clone(),
                    descendant_session_ids: self.descendants_of(&input.session_id)?,
                    target_session_id: input.session_id,
                    request_id: input.request_id,
                    kind: input.kind,
                    fingerprint: input.fingerprint,
                    rationale: input.rationale,
                    confidence: input.confidence,
                    answer: input.answer,
                    decision: input.decision,
                })
                .await
        })
        .await
    }
    pub async fn inspect(
        &self,
        caller: &session::Id,
        input: InspectInput,
    ) -> Result<RequestDetail, Error> {
        self.under_ownership(caller, async {
            let scope = self.member_scope(caller, &input.session_id)?;
            self.family_pending(&scope, caller, &input.session_id)
                .await?
                .into_iter()
                .find(|pending| pending.summary.request_id == input.request_id)
                .map(|pending| pending.detail)
                .ok_or_else(|| {
                    Error::refused(format!(
                        "Request {} is not pending for Session {}",
                        readable(&input.request_id),
                        readable(input.session_id.as_lossless())
                    ))
                })
        })
        .await
    }
    pub async fn interrupt(
        &self,
        caller: &session::Id,
        input: InterruptInput,
    ) -> Result<InterruptResult, Error> {
        self.under_ownership(caller, async {
            let scope = self.member_scope(caller, &input.session_id)?;
            self.0.execution.interrupt(&input.session_id).await?;
            Ok(InterruptResult {
                session_id: input.session_id.clone(),
                state: self.state_of(&scope, &input.session_id).await?,
            })
        })
        .await
    }
    pub async fn assign(
        &self,
        caller: &session::Id,
        input: AssignInput,
    ) -> Result<OwnershipResult, Error> {
        self.under_ownership(caller, async {
            let scope = self.scope_for(caller)?;
            if caller != &scope.master_session_id {
                return Err(Error::refused(
                    "Only the Project's Master assigns member ownership",
                ));
            }
            if !scope.member_session_ids.contains(&input.session_id) {
                return Err(Error::refused(format!(
                    "Session {} is not a member of this Project",
                    readable(input.session_id.as_lossless())
                )));
            }
            if let Some(problem) = self.owner_problem(&scope, &input.owner_session_id)? {
                return Err(Error::refused(problem));
            }
            self.0
                .coordination
                .set_owner(
                    &scope.group_id,
                    OwnerInput {
                        session_id: input.session_id.clone(),
                        owner_session_id: Some(input.owner_session_id.clone()),
                        reason: None,
                    },
                )
                .await?;
            self.supervise_attached(&input.owner_session_id).await?;
            Ok(OwnershipResult {
                owner: self.owner_of(&scope, &input.session_id)?,
                session_id: input.session_id,
            })
        })
        .await
    }
    pub async fn release(
        &self,
        caller: &session::Id,
        input: ReleaseInput,
    ) -> Result<OwnershipResult, Error> {
        self.under_ownership(caller,async{
        let scope=self.member_scope(caller,&input.session_id)?;
        if self.owner_of(&scope,&input.session_id)?.is_none(){return Err(Error::refused(format!("Session {} has no owner to release",readable(input.session_id.as_lossless()))));}
        if caller!=&scope.master_session_id{return Err(Error::refused("Only the Project's Master releases member ownership; supervisors stay attached until the Master releases or transfers it"));}
        self.0.coordination.set_owner(&scope.group_id,OwnerInput{session_id:input.session_id.clone(),owner_session_id:None,reason:Some(input.reason)}).await?;
        Ok(OwnershipResult{session_id:input.session_id,owner:None})
    }).await
    }
    pub async fn member(
        &self,
        caller: &session::Id,
        input: MemberInput,
    ) -> Result<MemberResult, Error> {
        self.under_ownership(caller, async {
            let scope = self.member_scope(caller, &input.session_id)?;
            let session = self.require_session(&input.session_id)?;
            Ok(MemberResult {
                session_id: session.id.clone(),
                location: session.location,
                model: session.model.map_or(Nullable::Null, Nullable::Value),
                state: self.state_of(&scope, &session.id).await?,
                owner: self.owner_of(&scope, &session.id)?,
            })
        })
        .await
    }
    pub async fn remove(
        &self,
        caller: &session::Id,
        input: MemberInput,
        group_id: Option<&c::GroupId>,
    ) -> Result<RemoveResult, Error> {
        self.fenced(caller, group_id, async {
            let scope = self.master_scope(
                caller,
                group_id,
                "Only the Project's Master removes member Sessions",
            )?;
            if !scope.member_session_ids.contains(&input.session_id) {
                return Err(Error::refused(format!(
                    "Session {} is not a member of this Project",
                    readable(input.session_id.as_lossless())
                )));
            }
            if self.0.execution.active().contains(&input.session_id)
                || self.work_remains(&input.session_id)?
                || !self
                    .family_pending(&scope, caller, &input.session_id)
                    .await?
                    .is_empty()
            {
                return Err(Error::refused(format!("Session {} has active work or pending requests; wait for it to settle or interrupt it before removing it from the Project", readable(input.session_id.as_lossless()))));
            }
            self.0
                .coordination
                .remove_member(&scope.group_id, &input.session_id)
                .await?;
            self.complete_unowned_supervisors().await?;
            Ok(RemoveResult {
                session_id: input.session_id,
                removed: true,
            })
        })
        .await
    }
    pub async fn attach(
        &self,
        caller: &session::Id,
        input: AttachInput,
        authorize: AuthorizeLocation,
        group_id: Option<&c::GroupId>,
    ) -> Result<AttachResult, Error> {
        let (planned, member) = self
            .fenced(caller, group_id, async {
                self.plan_attach(caller, &input, group_id)
            })
            .await?;
        if member {
            return Ok(AttachResult {
                reconciled: true,
                ..planned
            });
        }
        authorize(planned.location.clone()).await?;
        self.0
            .coordination
            .with_ownership(&planned.group_id, async {
                let (current, member) = self.plan_attach(caller, &input, group_id)?;
                if current.group_id != planned.group_id
                    || current.location.directory != planned.location.directory
                    || current.location.workspace_id != planned.location.workspace_id
                {
                    return Err(Error::refused(format!(
                        "Session {} or the caller's Project changed during authorization; read the Project again before retrying",
                        readable(input.session_id.as_lossless())
                    )));
                }
                if member {
                    return Ok(AttachResult {
                        reconciled: true,
                        ..current
                    });
                }
                self.0
                    .coordination
                    .add_member(
                        &current.group_id,
                        current.session_id.clone(),
                        Some(current.owner_session_id.clone()),
                        true,
                    )
                    .await
                    .map_err(|error| match error {
                        Error::Store(ycoding_store::Error::Domain { message, .. }) => {
                            Error::refused(message)
                        }
                        error => error,
                    })?;
                self.supervise_attached(&current.owner_session_id).await?;
                Ok(current)
            })
            .await
    }
    fn plan_attach(
        &self,
        caller: &session::Id,
        input: &AttachInput,
        group_id: Option<&c::GroupId>,
    ) -> Result<(AttachResult, bool), Error> {
        let scope = self.master_scope(
            caller,
            group_id,
            "Only the Project's Master attaches Sessions",
        )?;
        let owner = input
            .owner_session_id
            .clone()
            .unwrap_or_else(|| scope.master_session_id.clone());
        if let Some(problem) = self.owner_problem(&scope, &owner)? {
            return Err(Error::refused(problem));
        }
        if input.session_id == scope.master_session_id {
            return Err(Error::refused(
                "The Project's Master cannot attach itself as a member",
            ));
        }
        let session = self.require_session(&input.session_id)?;
        let id = readable(session.id.as_lossless());
        if session.parent_id.is_some() {
            return Err(Error::refused(format!(
                "Session {id} is a child Session, not a root"
            )));
        }
        if session.time.archived.is_some() {
            return Err(Error::refused(format!("Session {id} is archived")));
        }
        if session.scope == session::Scope::Standalone {
            return Err(Error::refused(format!(
                "Session {id} is a standalone Session and cannot join a Project"
            )));
        }
        let receipt = AttachResult {
            group_id: scope.group_id.clone(),
            session_id: session.id,
            location: session.location,
            owner_session_id: owner,
            reconciled: false,
        };
        if !scope.member_session_ids.contains(&receipt.session_id) {
            return Ok((receipt, false));
        }
        if self
            .owner_of(&scope, &receipt.session_id)?
            .map(|owner| owner.session_id)
            .as_ref()
            != Some(&receipt.owner_session_id)
        {
            return Err(Error::refused(format!(
                "Session {id} is already a member of this Project with a different owner; use assign to change its owner"
            )));
        }
        Ok((receipt, true))
    }
    pub async fn set_model(
        &self,
        caller: &session::Id,
        input: ModelInput,
    ) -> Result<MemberResult, Error> {
        let boundary = step_boundary::for_client(&self.0.sessions.client);
        let _selection = boundary.selection(&input.session_id);
        self.0.execution.with_transition(&input.session_id, async {
            self.switchable_member(caller, &input.session_id)?;
            let binding = self.0.sessions.profile_binding(&input.session_id)?;
            let services = (self.0.model_services)(input.session_id.clone()).await?;
            let _lease = services.lease.clone();
            if !(services.is_current)() {
                return Err(Error::refused("Member Location services are unavailable"));
            }
            let resolved = services
                .resolver
                .resolve(&input.model, None)
                .map_err(|error| Error::refused(error.to_string()))?;
            let _boundary = boundary.boundary_guard(&input.session_id).await;
            self.under_ownership(caller, async {
                let (scope, current) = self.switchable_member(caller, &input.session_id)?;
                let expected = match &input.expected_model {
                    Nullable::Null => None,
                    Nullable::Value(model) => Some(model),
                };
                let conflict = || Error::refused("The member or expected model changed before selection; read the member and retry");
                if current.model.as_ref() != expected || !(services.is_current)() {
                    return Err(conflict());
                }
                let committed = services
                    .resolver
                    .resolve(&input.model, resolved.binding.as_ref())
                    .map_err(|error| Error::refused(error.to_string()))?;
                if committed.digest != resolved.digest {
                    return Err(conflict());
                }
                if committed.budget <= 0 {
                    return Err(Error::refused("Target model has no positive input budget"));
                }
                let tokens = services
                    .resolver
                    .context_tokens(&current, &input.model)
                    .map_err(|error| Error::refused(error.to_string()))?;
                if let crate::session::model_switch::Outcome::Blocked(blocked) =
                    crate::session::model_switch::decide_tokens(
                        current.model.as_ref(), &input.model, tokens, committed.budget,
                    )
                {
                    return Err(Error::refused(format!(
                        "Target model is blocked: {}", readable(&blocked.reason)
                    )));
                }
                let same = current.model.as_ref() == Some(&input.model)
                    && input.model.profile.is_none()
                    && binding.is_none();
                let session_id = input.session_id.clone();
                let caller = caller.clone();
                let location = current.location;
                let expected_model = expected.cloned();
                let selected = input.model.clone();
                let target_binding = resolved.binding.clone();
                let expected_binding = binding.clone();
                let is_current = services.is_current.clone();
                let saved = self.0.sessions.client.submit(move |tx| {
                    if !is_current()
                        || super::authority::authorize_member_in(tx, &caller, &session_id, &scope.group_id).is_err()
                    {
                        return Ok(false);
                    }
                    let Some(source) = tx.get::<SessionTable>(&key(caller.as_lossless()))? else {
                        return Ok(false);
                    };
                    let Some(row) = tx.get::<SessionTable>(&key(session_id.as_lossless()))? else {
                        return Ok(false);
                    };
                    if source.time_archived.is_some()
                        || row.time_archived.is_some()
                        || tx.get::<TaskTable>(&key(session_id.as_lossless()))?.is_some()
                        || crate::session::coordination_model::current_in(tx, &session_id)?.is_some()
                    {
                        return Ok(false);
                    }
                    let model = row.model.as_ref().map(Document::domain).transpose()?;
                    let binding = row.profile_binding.as_ref().map(Document::domain).transpose()?;
                    if model != expected_model
                        || binding != expected_binding
                        || row.directory != *location.directory.as_lossless()
                        || row.workspace_id.as_ref() != location.workspace_id.as_ref().map(|id| id.as_lossless())
                    {
                        return Ok(false);
                    }
                    if same {
                        return Ok(true);
                    }
                    let now = chrono::Utc::now().timestamp_millis();
                    crate::session::projector::append(tx, &NewEvent {
                        id: random_event_id()?.into_lossless(),
                        aggregate_id: session_id.as_lossless().clone(),
                        created: now,
                        type_: "session.model.selected.1".into(),
                        data: ObjectEncoder::new()
                            .field("sessionID", &session_id)
                            .field("model", &selected)
                            .finish(),
                    })?;
                    if target_binding.is_some() || expected_binding.is_some() {
                        crate::session::projector::append(tx, &NewEvent {
                            id: random_event_id()?.into_lossless(),
                            aggregate_id: session_id.as_lossless().clone(),
                            created: now,
                            type_: "session.profile.bound.1".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &session_id)
                                .optional("binding", &target_binding)
                                .finish(),
                        })?;
                    }
                    Ok(true)
                })?.await?;
                if !saved {
                    return Err(conflict());
                }
                Ok(())
            }).await?;
            self.member(caller, MemberInput { session_id: input.session_id.clone() }).await
        }).await?
    }
    fn require_session(&self, id: &session::Id) -> Result<session::Info, Error> {
        self.0.sessions.get(id)?.ok_or_else(|| {
            Error::refused(format!(
                "Session {} does not exist",
                readable(id.as_lossless())
            ))
        })
    }
    fn switchable_member(
        &self,
        caller: &session::Id,
        id: &session::Id,
    ) -> Result<(Scope, session::Info), Error> {
        let scope = self.member_scope(caller, id)?;
        let source = self.require_session(caller)?;
        let session = self.require_session(id)?;
        if source.time.archived.is_some() || session.time.archived.is_some() {
            return Err(Error::refused(
                "Archived Sessions cannot change a member model",
            ));
        }
        if crate::session::coordination_model::current(&self.0.sessions, id)?.is_some() {
            return Err(Error::refused(
                "The member has an active coordination model override",
            ));
        }
        if self
            .0
            .sessions
            .client
            .snapshot()?
            .get::<TaskTable>(&key(id.as_lossless()))?
            .is_some()
        {
            return Err(Error::refused("A managed child cannot be a Project member"));
        }
        Ok((scope, session))
    }
    pub async fn create(
        &self,
        caller: &session::Id,
        input: CreateInput,
        provider: Option<CreateProvider>,
    ) -> Result<CreateResult, Error> {
        let lock = {
            let mut locks = self
                .0
                .creation_locks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(&input.id).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(tokio::sync::Mutex::new(()));
                    locks.insert(input.id.clone(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        let _creation = lock.lock().await;
        self.create_inner(caller, input, provider).await
    }
    async fn create_inner(
        &self,
        caller: &session::Id,
        input: CreateInput,
        provider: Option<CreateProvider>,
    ) -> Result<CreateResult, Error> {
        let scope = self
            .under_ownership(caller, async {
                let current = self.scope_for(caller)?;
                if caller != &current.master_session_id {
                    return Err(Error::refused(
                        "Only the Project's Master creates member Sessions",
                    ));
                }
                if let Some(owner) = &input.owner_session_id
                    && let Some(problem) = self.owner_problem(&current, owner)?
                {
                    return Err(Error::refused(problem));
                }
                Ok(current)
            })
            .await?;
        if let Some(model) = &input.model {
            (self.0.validate_model)(caller.clone(), model.clone()).await?;
        }
        if input.prompt.is_some() && !scope.active {
            return Err(Error::refused(INACTIVE_MESSAGE));
        }
        let master = self.0.sessions.get(caller)?.ok_or_else(|| {
            Error::refused(format!(
                "Session {} does not exist",
                readable(caller.as_lossless())
            ))
        })?;
        let recorded = self.0.sessions.get(&input.id)?;
        let receipt_key: LosslessString =
            format!("project.member.create:{}", readable(input.id.as_lossless())).into();
        let target = match &input.target {
            CreateTarget::Directory { directory } => {
                ObjectEncoder::new().field("directory", directory)
            }
            CreateTarget::Worktree { name, repository } => ObjectEncoder::new()
                .field("name", name)
                .optional("repository", repository),
            CreateTarget::Project { project_id } => {
                ObjectEncoder::new().field("projectID", project_id)
            }
        };
        let identity = target
            .field("id", &input.id)
            .field("agentPermissions", &input.agent_permissions)
            .optional("ownerSessionID", &input.owner_session_id)
            .optional("title", &input.title)
            .optional("prompt", &input.prompt)
            .optional("model", &input.model)
            .finish();
        let digest = prompt_cache::sha256(&prompt_cache::canonical_json(
            &ObjectEncoder::new()
                .field("caller", caller)
                .field("groupID", &scope.group_id)
                .field("input", &identity)
                .finish(),
        ));
        let snapshot = self.0.sessions.client.snapshot()?;
        let placement = snapshot
            .get::<KvTable>(&key(&receipt_key))?
            .map(|row| CreationPlacement::decode(row.value.value()))
            .transpose()
            .map_err(|_| {
                Error::refused(format!(
                    "Creation receipt for Session {} is invalid",
                    readable(input.id.as_lossless())
                ))
            })?;
        if placement
            .as_ref()
            .is_some_and(|saved| saved.digest.as_str() != Some(digest.as_str()))
        {
            return Err(Error::refused(format!(
                "Session {} creation identity was already used with different input",
                readable(input.id.as_lossless())
            )));
        }
        let selected = match &input.target {
            CreateTarget::Directory { .. } | CreateTarget::Worktree { .. } => None,
            CreateTarget::Project { project_id }
                if project_id.as_lossless().as_str() == Some("global") =>
            {
                return Err(Error::refused(
                    "The global Project has no repository directory; pass directory to choose the member's folder",
                ));
            }
            CreateTarget::Project { project_id } => Some(
                snapshot
                    .get::<ProjectTable>(&key(project_id.as_lossless()))?
                    .ok_or_else(|| {
                        Error::refused(format!(
                            "Project {} does not exist",
                            readable(project_id.as_lossless())
                        ))
                    })?,
            ),
        };
        let canonical = selected
            .as_ref()
            .map(|project| AbsolutePath::new(project.worktree.clone()))
            .transpose()?;
        drop(snapshot);
        let (chosen, provider) = match (&input.target, provider) {
            (CreateTarget::Directory { directory }, Some(CreateProvider::Directory(provider))) => {
                let chosen = chosen_directory(directory, &provider.home)?;
                if placement
                    .as_ref()
                    .is_some_and(|saved| saved.directory != chosen)
                {
                    return Err(Error::refused(format!(
                        "Session {} directory changed after creation was recorded",
                        readable(input.id.as_lossless())
                    )));
                }
                (Some((chosen, provider.open)), None)
            }
            (CreateTarget::Directory { .. }, _) => {
                return Err(Error::refused(
                    "Directory placement requires a directory provider",
                ));
            }
            (_, provider) => (None, provider),
        };
        if let (Some(directory), Some(project)) = (&canonical, &selected) {
            if placement
                .as_ref()
                .is_some_and(|saved| saved.directory != *directory)
            {
                return Err(Error::refused(format!(
                    "Project {} canonical Location changed after creation was recorded",
                    readable(&project.id)
                )));
            }
            let path = directory
                .as_lossless()
                .as_str()
                .ok_or_else(|| Error::refused("Project directory is not valid Unicode"))?;
            let metadata = std::fs::metadata(path)
                .map_err(|_| Error::refused(format!("Project directory {path} is unavailable")))?;
            if !metadata.is_dir() {
                return Err(Error::refused(format!(
                    "Project directory {path} is not a directory"
                )));
            }
        }
        let expected = chosen
            .as_ref()
            .map(|(directory, _)| directory)
            .or(canonical.as_ref())
            .or(placement.as_ref().map(|saved| &saved.directory));
        if let Some(recorded) = &recorded {
            if recorded.parent_id.is_some()
                || recorded.scope == session::Scope::Standalone
                || recorded.location.workspace_id.is_some()
                || expected.is_some_and(|directory| recorded.location.directory != *directory)
            {
                return Err(Error::refused(format!(
                    "Session {} already exists at a different Location",
                    readable(input.id.as_lossless())
                )));
            }
            if canonical.is_none() && placement.is_none() {
                return Err(Error::refused(format!(
                    "Session {} has no matching {} creation receipt",
                    readable(input.id.as_lossless()),
                    if chosen.is_some() {
                        "directory"
                    } else {
                        "worktree"
                    }
                )));
            }
        }
        let opened = match chosen {
            Some((directory, open)) => {
                let path = readable(directory.as_lossless());
                let not_directory =
                    || Error::refused(format!("Project path {path} is not a directory"));
                let missing = match std::fs::metadata(&path) {
                    Ok(metadata) if metadata.is_dir() => false,
                    Ok(_) => return Err(not_directory()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                    Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
                        return Err(not_directory());
                    }
                    Err(_) => {
                        return Err(Error::refused(format!(
                            "Project directory {path} could not be opened or created"
                        )));
                    }
                };
                let project = open(directory.clone(), missing).await?;
                Some((directory, project))
            }
            None => None,
        };
        let (directory, branch) = match (&opened, &canonical, &placement, &input.target) {
            (Some((directory, _)), _, _, _) | (None, Some(directory), _, _) => {
                (directory.clone(), None)
            }
            (None, None, Some(saved), _) => (saved.directory.clone(), saved.branch.clone()),
            (None, None, None, CreateTarget::Worktree { name, .. }) => {
                let Some(CreateProvider::Worktree(worktree)) = provider else {
                    return Err(Error::refused(
                        "Explicit worktree creation requires a worktree provider",
                    ));
                };
                let created = worktree(name.clone()).await?;
                (AbsolutePath::new(created.directory)?, Some(created.branch))
            }
            _ => return Err(Error::refused("Project directory is unavailable")),
        };
        if placement.is_none() {
            let receipt = CreationPlacement {
                digest: digest.into(),
                directory: directory.clone(),
                branch: branch.clone(),
            };
            let now = chrono::Utc::now().timestamp_millis();
            self.0
                .sessions
                .client
                .submit(move |tx| {
                    if let Some(existing) = tx.get::<KvTable>(&key(&receipt_key))? {
                        if existing.value.value() != &receipt.encode() {
                            return Err(ycoding_store::Error::Rejected("Creation receipt changed"));
                        }
                        return Ok(());
                    }
                    KvTable::insert(
                        tx,
                        &Kv {
                            key: receipt_key,
                            value: Document::new(receipt.encode())?,
                            time_created: now,
                            time_updated: now,
                        },
                    )
                })?
                .await?;
        }
        let partial = |message: String, session_id: Option<&session::Id>| {
            Error::refused(format!(
                "Created {}{}, but {message}; nothing was removed",
                branch.as_ref().map_or_else(
                    || format!("Session placement at {}", readable(directory.as_lossless())),
                    |branch| format!(
                        "worktree {} on branch {}",
                        readable(directory.as_lossless()),
                        readable(branch)
                    ),
                ),
                session_id.map_or(String::new(), |id| format!(
                    " and Session {}",
                    readable(id.as_lossless())
                ))
            ))
        };
        let member_id = input.id.clone();
        let ceiling = orchestration::inherit_permission_ceiling(
            master.permission_ceiling.as_ref(),
            Some(&input.agent_permissions),
        );
        let now = chrono::Utc::now().timestamp_millis();
        let title = input
            .title
            .clone()
            .or_else(|| match &input.target {
                CreateTarget::Directory { .. } => None,
                CreateTarget::Worktree { name, .. } => Some(name.clone()),
                CreateTarget::Project { .. } => {
                    selected.as_ref().and_then(|project| project.name.clone())
                }
            })
            .unwrap_or_else(|| {
                std::path::Path::new(&readable(directory.as_lossless()))
                    .file_name()
                    .map_or_else(
                        || directory.as_lossless().clone(),
                        |name| LosslessString::from(&*name.to_string_lossy()),
                    )
            });
        let project_id = match (&opened, &selected) {
            (Some((_, project)), _) => project.as_lossless().clone(),
            (None, Some(project)) => project.id.clone(),
            (None, None) => master.project_id.as_lossless().clone(),
        };
        let member = match recorded {
            Some(member) => member,
            None => match self
                .0
                .sessions
                .create(NewEvent {
                    id: random_event_id()?.into_lossless(),
                    aggregate_id: member_id.as_lossless().clone(),
                    created: now,
                    type_: "session.created.2".into(),
                    data: ObjectEncoder::new()
                        .field("sessionID", &member_id)
                        .field("projectID", &project_id)
                        .field(
                            "location",
                            &ObjectEncoder::new().field("directory", &directory).finish(),
                        )
                        .field("title", &title)
                        .optional("model", &input.model)
                        .optional(
                            "permissionCeiling",
                            &(!ceiling.is_empty()).then_some(ceiling),
                        )
                        .field("created", &(now as f64))
                        .finish(),
                })
                .await
            {
                Ok(member) => member,
                Err(error) => self
                    .0
                    .sessions
                    .get(&member_id)?
                    .filter(|session| {
                        session.parent_id.is_none()
                            && session.location.directory == directory
                            && session.location.workspace_id.is_none()
                    })
                    .ok_or_else(|| {
                        partial(
                            format!("creating its Session failed: {error}"),
                            Some(&member_id),
                        )
                    })?,
            },
        };
        if member.parent_id.is_some()
            || member.location.directory != directory
            || member.location.workspace_id.is_some()
        {
            return Err(partial(
                "its Session identity has conflicting placement".into(),
                Some(&member_id),
            ));
        }
        let member_id = member.id.clone();
        let enrollment = self
            .0
            .coordination
            .with_ownership(&scope.group_id, async {
                let access = self.0.coordination.access_of(caller)?;
                if !access.as_ref().is_some_and(|access| {
                    access.role == Role::Master && access.scope.group_id == scope.group_id
                }) {
                    return Err(partial(
                        format!(
                            "Session {} is no longer this Project's Master",
                            readable(caller.as_lossless())
                        ),
                        Some(&member_id),
                    ));
                }
                let access = access.unwrap();
                if let Some(owner) = &input.owner_session_id
                    && let Some(problem) = self.owner_problem(&access.scope, owner)?
                {
                    return Err(partial(problem, Some(&member_id)));
                }
                if !access.scope.member_session_ids.contains(&member_id) {
                    self.0
                        .coordination
                        .add_member(
                            &scope.group_id,
                            member_id.clone(),
                            input.owner_session_id.clone(),
                            false,
                        )
                        .await
                        .map_err(|error| {
                            partial(
                                format!("adding it to the Project failed: {error}"),
                                Some(&member_id),
                            )
                        })?;
                }
                if let Some(owner) = &input.owner_session_id {
                    self.supervise_attached(owner).await?;
                }
                Ok::<(), Error>(())
            })
            .await;
        let enrollment = match enrollment {
            Ok(()) => Enrollment {
                group_id: scope.group_id.clone(),
                member: true,
                error: None,
            },
            Err(error @ Error::Refused(_)) => Enrollment {
                group_id: scope.group_id.clone(),
                member: false,
                error: Some(error.to_string().into()),
            },
            Err(error) => return Err(error),
        };
        let prompt = match input.prompt.as_ref().filter(|_| enrollment.member) {
            None => None,
            Some(text) => Some(
                match self
                    .under_ownership(
                        caller,
                        self.send_inner(
                            caller,
                            SendInput {
                                session_id: member_id.clone(),
                                text: text.clone(),
                                delivery: None,
                                message_id: Some(session_message::Id::new(format!(
                                    "msg_project_create_{}",
                                    readable(input.id.as_lossless())
                                ))?),
                                model: None,
                            },
                        ),
                    )
                    .await
                {
                    Ok(sent) => CreatePrompt::Sent(sent),
                    Err(error @ Error::Refused(_)) => {
                        CreatePrompt::Refused(error.to_string().into())
                    }
                    Err(error) => return Err(error),
                },
            ),
        };
        let confirmed = self.0.sessions.get(&member_id)?.ok_or_else(|| {
            partial(
                "its Session could not be read back".into(),
                Some(&member_id),
            )
        })?;
        Ok(CreateResult {
            session_id: member_id.clone(),
            directory: confirmed.location.directory.as_lossless().clone(),
            location: confirmed.location,
            model: confirmed.model.map_or(Nullable::Null, Nullable::Value),
            enrollment,
            branch,
            owner: self.owner_of(&scope, &member_id)?,
            prompt,
        })
    }
    fn owner_problem(&self, scope: &Scope, owner: &session::Id) -> Result<Option<String>, Error> {
        if owner == &scope.master_session_id {
            return Ok(None);
        }
        let snapshot = self.0.coordination.client().snapshot()?;
        let task = snapshot
            .get::<TaskTable>(&key(owner.as_lossless()))?
            .filter(|task| task.parent_id == *scope.master_session_id.as_lossless());
        let session = snapshot.get::<SessionTable>(&key(owner.as_lossless()))?;
        let (Some(task), Some(session)) = (task, session) else {
            return Ok(Some(format!(
                "Session {} is not a subagent the Master launched",
                readable(owner.as_lossless())
            )));
        };
        if session.time_archived.is_some() {
            return Ok(Some(format!(
                "Subagent {} is archived and cannot own members",
                readable(owner.as_lossless())
            )));
        }
        let state = task.state.as_str().unwrap_or_default();
        if ["cancelling", "cancelled", "failed", "lost"].contains(&state) {
            return Ok(Some(format!(
                "Subagent {} is {state} and cannot own members",
                readable(owner.as_lossless())
            )));
        }
        Ok(None)
    }
    async fn supervise_attached(&self, id: &session::Id) -> Result<(), Error> {
        let snapshot = self.0.coordination.client().snapshot()?;
        let Some(task) = snapshot.get::<TaskTable>(&key(id.as_lossless()))? else {
            return Ok(());
        };
        if task.state.as_str() != Some("completed")
            || !has_owned_members(&snapshot, id.as_lossless())?
        {
            return Ok(());
        }
        self.publish_change(id, Change::Supervising, None).await
    }
    async fn complete_unowned_supervisors(&self) -> Result<(), Error> {
        let mut after: Option<LosslessString> = None;
        loop {
            let snapshot = self.0.coordination.client().snapshot()?;
            let mut rows = snapshot
                .scan::<TaskTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
                .into_iter()
                .filter(|row| {
                    row.state.as_str() == Some("supervising")
                        && after.as_ref().is_none_or(|after| row.session_id > *after)
                })
                .collect::<Vec<_>>();
            rows.sort_by(|left, right| left.session_id.cmp(&right.session_id));
            rows.truncate(100);
            if rows.is_empty() {
                return Ok(());
            }
            for row in &rows {
                if has_owned_members(&snapshot, &row.session_id)? {
                    continue;
                }
                let current = self
                    .0
                    .coordination
                    .client()
                    .snapshot()?
                    .get::<TaskTable>(&key(&row.session_id))?;
                if !current.is_some_and(|current| current.state.as_str() == Some("supervising")) {
                    continue;
                }
                let id = session::Id::new(row.session_id.clone())?;
                let event = format!(
                    "evt_task_ownership_completed_{}_{}",
                    readable(&row.session_id),
                    row.revision + 1
                );
                self.publish_change(&id, Change::Completed { excerpt: None }, Some(event.into()))
                    .await?;
            }
            after = rows.last().map(|row| row.session_id.clone());
        }
    }
    async fn publish_change(
        &self,
        id: &session::Id,
        change: Change,
        event_id: Option<LosslessString>,
    ) -> Result<(), Error> {
        self.0
            .sessions
            .publish(NewEvent {
                id: match event_id {
                    Some(id) => id,
                    None => random_event_id()?.into_lossless(),
                },
                aggregate_id: id.as_lossless().clone(),
                created: chrono::Utc::now().timestamp_millis(),
                type_: "session.task.updated.1".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", id)
                    .field("change", &change)
                    .finish(),
            })
            .await?;
        Ok(())
    }
    pub async fn escalate(
        &self,
        caller: &session::Id,
        input: EscalateInput,
    ) -> Result<EscalateResult, Error> {
        self.under_ownership(caller, async {
            let scope = self.member_scope(caller, &input.session_id)?;
            let decision = self
                .0
                .decisions
                .escalate(DecisionEscalateInput {
                    group_id: scope.group_id.clone(),
                    coordinator_session_id: caller.clone(),
                    target_session_id: input.session_id.clone(),
                    descendant_session_ids: self.descendants_of(&input.session_id)?,
                    request_id: input.request_id.clone(),
                    kind: input.kind,
                    fingerprint: input.fingerprint.clone(),
                    reason: input.reason.clone(),
                })
                .await?;
            let request_session_id = decision.request_session_id.clone();
            if decision.settled {
                return Err(ycoding_store::Error::Rejected(
                    "Project escalation cannot settle a native decision",
                )
                .into());
            }
            let message_id = if decision.to == Some(EscalationTarget::Master) {
                let identity = join(&[&input.request_id, caller.as_lossless()]);
                let detail = ObjectEncoder::new()
                    .field("requestID", &input.request_id)
                    .field("fingerprint", &input.fingerprint)
                    .field("kind", &input.kind)
                    .optional("requestSessionID", &request_session_id)
                    .field(
                        "escalatedBy",
                        &c::ParticipantSession {
                            session_id: caller.clone(),
                            title: self.title(caller)?,
                        },
                    )
                    .finish();
                Some(
                    self.deliver(
                        &scope,
                        &input.session_id,
                        (Notice::Escalated, &identity),
                        &scope.master_session_id,
                        true,
                        (detail, Some(input.reason.clone())),
                    )
                    .await?,
                )
            } else {
                None
            };
            Ok(EscalateResult {
                session_id: input.session_id,
                request_id: input.request_id,
                request_session_id,
                delivered: message_id.is_some(),
                message_id,
                decision,
            })
        })
        .await
    }
    fn scope_for(&self, caller: &session::Id) -> Result<Scope, Error> {
        self.0
            .coordination
            .access_of(caller)?
            .filter(|access| access.role != Role::Executor)
            .map(|access| access.scope)
            .ok_or_else(|| {
                Error::refused("The project tool requires Main or a recorded member owner")
            })
    }
    fn master_scope(
        &self,
        caller: &session::Id,
        group_id: Option<&c::GroupId>,
        refusal: &str,
    ) -> Result<Scope, Error> {
        let access = self.0.coordination.access_of(caller)?;
        if let Some(group_id) = group_id
            && !access.as_ref().is_some_and(|access| {
                access.role == Role::Master && &access.scope.group_id == group_id
            })
        {
            return Err(Error::refused(format!(
                "Session {} is not the Master of Project {}",
                readable(caller.as_lossless()),
                readable(group_id.as_lossless())
            )));
        }
        access
            .filter(|access| access.role == Role::Master)
            .map(|access| access.scope)
            .ok_or_else(|| Error::refused(refusal))
    }
    async fn fenced<T>(
        &self,
        caller: &session::Id,
        group_id: Option<&c::GroupId>,
        effect: impl StdFuture<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        match group_id {
            Some(group_id) => self.0.coordination.with_ownership(group_id, effect).await,
            None => self.under_ownership(caller, effect).await,
        }
    }
    fn member_scope(&self, caller: &session::Id, target: &session::Id) -> Result<Scope, Error> {
        let access =
            self.0.coordination.access_of(caller)?.ok_or_else(|| {
                Error::refused("The project tool requires a current Project scope")
            })?;
        if !can_act(&access, target) {
            return Err(Error::refused(
                "Only the current owner or Main acts on this Project member",
            ));
        }
        Ok(access.scope)
    }
    async fn under_ownership<T>(
        &self,
        caller: &session::Id,
        effect: impl StdFuture<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        match self.0.coordination.access_of(caller)? {
            Some(access) => {
                self.0
                    .coordination
                    .with_ownership(&access.scope.group_id, effect)
                    .await
            }
            None => effect.await,
        }
    }
    async fn pending(
        &self,
        scope: &Scope,
        caller: &session::Id,
        target: &session::Id,
    ) -> Result<Vec<Pending>, Error> {
        self.pending_of(scope, caller, target, vec![]).await
    }
    async fn family_pending(
        &self,
        scope: &Scope,
        caller: &session::Id,
        target: &session::Id,
    ) -> Result<Vec<Pending>, Error> {
        let descendants = self.descendants_of(target)?;
        self.pending_of(scope, caller, target, descendants).await
    }
    async fn pending_of(
        &self,
        scope: &Scope,
        caller: &session::Id,
        target: &session::Id,
        descendant_session_ids: Vec<session::Id>,
    ) -> Result<Vec<Pending>, Error> {
        self.0
            .decisions
            .pending(PendingInput {
                group_id: scope.group_id.clone(),
                coordinator_session_id: caller.clone(),
                target_session_id: target.clone(),
                descendant_session_ids,
                limit: Some(c::MAX_PENDING),
            })
            .await
    }
    fn descendants_of(&self, member: &session::Id) -> Result<Vec<session::Id>, Error> {
        let snapshot = self.0.coordination.client().snapshot()?;
        let mut seen = BTreeSet::from([member.as_lossless().clone()]);
        let mut queue = vec![member.as_lossless().clone()];
        let mut found = Vec::new();
        while let Some(parent) = queue.pop() {
            let prefix = key(&parent);
            let mut after = None;
            loop {
                let page = snapshot.index_range::<SessionTable>(
                    "session_parent_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 128,
                    },
                )?;
                let Some(last) = page.last() else {
                    break;
                };
                after = Some(last.cursor.clone());
                for entry in page {
                    if entry.record.time_archived.is_none() && seen.insert(entry.record.id.clone())
                    {
                        found.push(session::Id::new(entry.record.id.clone())?);
                        queue.push(entry.record.id);
                    }
                }
            }
        }
        Ok(found)
    }
    async fn participant(
        &self,
        scope: &Scope,
        id: &session::Id,
        running: &BTreeSet<LosslessString>,
    ) -> Result<c::Participant, Error> {
        let row = self.0.sessions.get(id)?;
        let own = self.pending(scope, &scope.master_session_id, id).await?;
        let descendants = if id == &scope.master_session_id {
            vec![]
        } else {
            self.descendants_of(id)?
        };
        let family = if descendants.is_empty() {
            own.clone()
        } else {
            self.pending_of(scope, &scope.master_session_id, id, descendants)
                .await?
        };
        let pending = family
            .into_iter()
            .take(c::MAX_PENDING)
            .map(|pending| pending.summary)
            .collect::<Vec<_>>();
        let state = if !own.is_empty() {
            c::MemberState::Waiting
        } else if running.contains(id.as_lossless()) {
            c::MemberState::Running
        } else if self.last_failed(id)? {
            c::MemberState::Failed
        } else {
            c::MemberState::Idle
        };
        let sender = self
            .0
            .senders
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .cloned();
        let driver = match sender {
            Some(sender)
                if sender != scope.master_session_id
                    && running.contains(sender.as_lossless())
                    && self
                        .0
                        .coordination
                        .scope_of(&sender)?
                        .is_some_and(|current| current.group_id == scope.group_id) =>
            {
                self.0
                    .sessions
                    .get(&sender)?
                    .map(|row| c::ParticipantSession {
                        session_id: sender,
                        title: row.title,
                    })
            }
            _ => None,
        };
        let (title, location, last_activity) = match row {
            Some(row) => (
                row.title,
                row.location,
                NonNegativeInt::new(row.time.updated.epoch_millis())?,
            ),
            None => (
                "".into(),
                ycoding_schema::location::Ref {
                    directory: ycoding_schema::schema::AbsolutePath::new("/")?,
                    workspace_id: None,
                },
                NonNegativeInt::new(0)?,
            ),
        };
        Ok(c::Participant {
            session_id: id.clone(),
            title,
            location,
            state,
            last_activity,
            pending,
            driven_by: driver,
            owner: self.owner_of(scope, id)?,
        })
    }
    async fn state_of(&self, scope: &Scope, id: &session::Id) -> Result<c::MemberState, Error> {
        Ok(self.participant(scope, id, &self.running()?).await?.state)
    }
    fn running(&self) -> Result<BTreeSet<LosslessString>, Error> {
        let orchestration = orchestration::Service::new(
            self.0.sessions.clone(),
            Arc::new(execution::ProcessExecution),
        );
        Ok(outstanding::read(
            &self.0.sessions,
            &orchestration,
            &self.0.jobs,
            &self.0.execution.active(),
            false,
        )?
        .running)
    }
    fn owner_of(
        &self,
        scope: &Scope,
        id: &session::Id,
    ) -> Result<Option<c::ParticipantSession>, Error> {
        let snapshot = self.0.coordination.client().snapshot()?;
        let primary = ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(scope.group_id.as_lossless()),
            ycoding_store::KeyPart::String(id.as_lossless()),
        ]);
        let Some(owner) = snapshot
            .get::<ycoding_store::coordination::MemberTable>(&primary)?
            .and_then(|member| member.owner_session_id)
        else {
            return Ok(None);
        };
        snapshot
            .get::<SessionTable>(&key(&owner))?
            .map(|row| {
                Ok(c::ParticipantSession {
                    session_id: session::Id::new(row.id)?,
                    title: row.title,
                })
            })
            .transpose()
    }
    fn title(&self, id: &session::Id) -> Result<LosslessString, Error> {
        Ok(self
            .0
            .sessions
            .get(id)?
            .map(|row| row.title)
            .unwrap_or_default())
    }
    fn last_failed(&self, id: &session::Id) -> Result<bool, Error> {
        let snapshot = self.0.coordination.client().snapshot()?;
        let mut after = None;
        loop {
            let page = events(
                &snapshot,
                id.as_lossless(),
                IndexOrder::Descending,
                after.as_ref(),
                128,
            )?;
            for event in &page {
                if matches!(
                    event.record.type_.as_str(),
                    Some(
                        "session.execution.started.1"
                            | "session.execution.succeeded.1"
                            | "session.execution.failed.1"
                            | "session.execution.interrupted.1"
                    )
                ) {
                    return Ok(event.record.type_.as_str() == Some("session.execution.failed.1"));
                }
            }
            let Some(last) = page.last() else {
                return Ok(false);
            };
            after = Some(last.cursor.clone());
        }
    }
    fn lookup(&self, target: &session::Id, id: &session_message::Id) -> Result<Lookup, Error> {
        let snapshot = self.0.coordination.client().snapshot()?;
        if let Some(pending) = snapshot.get::<PendingTable>(&key(id.as_lossless()))? {
            let input = match pending.type_.as_str() {
                Some("user") => session_pending::Message::User(session_pending::UserMessage {
                    data: session_pending::UserData::decode(&pending.data)?,
                    delivery: delivery(&pending)?,
                }),
                Some("synthetic") => {
                    session_pending::Message::Synthetic(session_pending::SyntheticMessage {
                        data: session_pending::SyntheticData::decode(&pending.data)?,
                        delivery: delivery(&pending)?,
                    })
                }
                _ => return Ok(Lookup::Conflict),
            };
            return Ok(Lookup::Used {
                session_id: pending.session_id,
                input,
            });
        }
        let message = snapshot.get::<MessageTable>(&key(id.as_lossless()))?;
        if message
            .as_ref()
            .is_some_and(|message| &message.session_id != target.as_lossless())
        {
            return Ok(Lookup::Conflict);
        }
        let prefix = ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(target.as_lossless()),
            ycoding_store::KeyPart::String(&"session.input.admitted.1".into()),
        ]);
        let mut after = None;
        loop {
            let page = snapshot.index_range::<EventTable>(
                "event_aggregate_type_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            for event in &page {
                let path = JsonPath::default();
                let object = ObjectDecoder::new(&event.record.data, &path)?;
                if object.field::<session_message::Id>("inputID")? == *id {
                    return Ok(Lookup::Used {
                        session_id: event.record.aggregate_id.clone(),
                        input: object.field("input")?,
                    });
                }
            }
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.cursor.clone());
        }
        Ok(if message.is_some() {
            Lookup::Conflict
        } else {
            Lookup::Vacant
        })
    }
    pub async fn handle(&self, payload: &Payload) -> Result<(), Error> {
        match payload {
            Payload::Durable(event) => {
                if !HANDLED_EVENTS.contains(&event.type_.as_str().unwrap_or("")) {
                    return Ok(());
                }
                let path = JsonPath::default();
                let object = ObjectDecoder::new(&event.data, &path)?;
                if matches!(
                    event.type_.as_str(),
                    Some("coordination.group.changed.1" | "coordination.group.deleted.1")
                ) {
                    let group: c::GroupId = object.field("groupID")?;
                    return self
                        .0
                        .coordination
                        .with_ownership(&group, self.complete_unowned_supervisors())
                        .await;
                }
                if event.type_.as_str() == Some("session.task.updated.1") {
                    let change: Change = object.field("change")?;
                    if !matches!(
                        change,
                        Change::Cancelled
                            | Change::Failed { .. }
                            | Change::Lost { .. }
                            | Change::QuestionAsked { .. }
                    ) {
                        return Ok(());
                    }
                }
                let id = if event.type_.as_str() == Some("coordination.member.owner.changed.1") {
                    c::OwnerChangedData::decode(&event.data)?.session_id
                } else {
                    object.field("sessionID")?
                };
                self.under_ownership(&id, self.handle_durable(event, &id))
                    .await
            }
            Payload::Ephemeral(event) => match &event.data {
                event_feed::Data::FormCreated(data) => {
                    let Ok(id) = session::Id::new(data.form.session_id.clone()) else {
                        return Ok(());
                    };
                    let request = string_value(&data.form.id)?;
                    self.request_event(&id, c::RequestKind::Question, request)
                        .await
                }
                event_feed::Data::PermissionAsked(data) => {
                    self.request_event(
                        &data.session_id,
                        c::RequestKind::Permission,
                        data.id.as_lossless().clone(),
                    )
                    .await
                }
                event_feed::Data::GuardrailAsked(data) => {
                    self.request_event(
                        &data.session_id,
                        c::RequestKind::Review,
                        string_value(&data.id)?,
                    )
                    .await
                }
                _ => Ok(()),
            },
        }
    }
    async fn handle_durable(&self, event: &Event, id: &session::Id) -> Result<(), Error> {
        let path = JsonPath::default();
        let object = ObjectDecoder::new(&event.data, &path)?;
        match event.type_.as_str() {
            Some("session.deleted.2") => self.complete_unowned_supervisors().await,
            Some("session.archived.2") => {
                if let Some(scope) = self.0.coordination.member_of(id)?
                    && self.owner_of(&scope, id)?.is_some()
                {
                    self.0
                        .coordination
                        .set_owner(
                            &scope.group_id,
                            OwnerInput {
                                session_id: id.clone(),
                                owner_session_id: None,
                                reason: Some(c::ReleaseReason::Released),
                            },
                        )
                        .await?;
                }
                if let Some(access) = self.0.coordination.access_of(id)? {
                    for member in access.owned_session_ids.clone() {
                        self.release_stale(&access.scope, &member, true).await?;
                    }
                }
                self.complete_unowned_supervisors().await
            }
            Some("session.task.updated.1") => {
                let change: Change = object.field("change")?;
                if matches!(change, Change::QuestionAsked { .. }) {
                    let root = self.root_of(id)?;
                    if let Some(scope) = self.0.coordination.member_of(&root)? {
                        let receiver = self.receiver_of(&scope, &root, true).await?;
                        self.handoff(&scope, &root, receiver.as_ref(), true, "unowned")
                            .await?;
                    }
                    return Ok(());
                }
                let Some(access) = self.0.coordination.access_of(id)? else {
                    return Ok(());
                };
                if self.owner_problem(&access.scope, id)?.is_none() {
                    return Ok(());
                }
                for member in access.owned_session_ids.clone() {
                    self.release_stale(&access.scope, &member, true).await?;
                }
                Ok(())
            }
            Some("coordination.member.owner.changed.1") => {
                self.complete_unowned_supervisors().await?;
                let change = c::OwnerChangedData::decode(&event.data)?;
                let Some(scope) = self.0.coordination.member_of(id)? else {
                    return Ok(());
                };
                if scope.group_id != change.group_id {
                    return Ok(());
                }
                let receiver = self.receiver_of(&scope, id, true).await?;
                if receiver != change.owner_session_id {
                    return Ok(());
                }
                if let Some(receiver) = &receiver {
                    self.supervise_attached(receiver).await?;
                    self.deliver_held(&scope, id, receiver, true).await?;
                }
                self.handoff(&scope, id, receiver.as_ref(), true, "unowned")
                    .await
            }
            Some("session.input.admitted.1") => {
                let input: session_pending::Message = object.field("input")?;
                if let session_pending::Message::User(input) = input
                    && pending::input_origin(input.data.metadata.as_ref()) == Some("direct")
                    && let Some(scope) = self
                        .0
                        .coordination
                        .scope_of(id)?
                        .filter(|scope| scope.master_session_id == *id)
                {
                    self.0.coordination.activate(&scope.group_id)?;
                }
                Ok(())
            }
            Some("session.execution.interrupted.1") => {
                let reason: LosslessString = object.field("reason")?;
                if reason.as_str() == Some("user") {
                    self.0.coordination.pause_master(id)?;
                }
                self.member_notice(
                    id,
                    Notice::Interrupted,
                    &event.id,
                    ObjectEncoder::new()
                        .field(
                            "excerpt",
                            format!("Interrupted ({})", readable(&reason)).as_str(),
                        )
                        .finish(),
                    true,
                )
                .await
            }
            Some("session.execution.started.1") => {
                self.member_notice(
                    id,
                    Notice::Started,
                    &event.id,
                    ObjectEncoder::new().finish(),
                    true,
                )
                .await
            }
            Some("session.step.ended.1") => {
                self.member_notice(
                    id,
                    Notice::Progress,
                    &event.id,
                    ObjectEncoder::new().finish(),
                    true,
                )
                .await
            }
            Some("session.execution.failed.1") => {
                let error: ycoding_schema::session_error::Error = object.field("error")?;
                self.member_notice(
                    id,
                    Notice::Failed,
                    &event.id,
                    ObjectEncoder::new()
                        .field("excerpt", &clip(&error.message))
                        .finish(),
                    true,
                )
                .await
            }
            Some("session.execution.succeeded.1") => {
                if self.work_remains(id)? {
                    return Ok(());
                }
                let excerpt = self.excerpt(id)?;
                self.member_notice(
                    id,
                    Notice::Completed,
                    &event.id,
                    ObjectEncoder::new().optional("excerpt", &excerpt).finish(),
                    true,
                )
                .await
            }
            _ => Ok(()),
        }
    }
    async fn request_event(
        &self,
        requesting: &session::Id,
        kind: c::RequestKind,
        request: LosslessString,
    ) -> Result<(), Error> {
        let member = self.root_of(requesting)?;
        self.under_ownership(&member, async {
            let Some(scope) = self.0.coordination.member_of(&member)? else {
                return Ok(());
            };
            if &member != requesting && !self.descendants_of(&member)?.contains(requesting) {
                return Ok(());
            }
            let receiver = self
                .owner_of(&scope, &member)?
                .map(|owner| owner.session_id)
                .unwrap_or_else(|| scope.master_session_id.clone());
            let excerpt = self
                .family_pending(&scope, &receiver, &member)
                .await?
                .into_iter()
                .find(|pending| {
                    pending.summary.kind == kind && pending.summary.request_id == request
                })
                .map(|pending| pending.summary.summary);
            let request_session_id = (&member != requesting).then(|| requesting.clone());
            self.notify(
                &scope,
                &member,
                Notice::request(kind),
                &request,
                ObjectEncoder::new()
                    .field("requestID", &request)
                    .optional("excerpt", &excerpt)
                    .optional("requestSessionID", &request_session_id)
                    .finish(),
                true,
            )
            .await
        })
        .await
    }
    async fn member_notice(
        &self,
        id: &session::Id,
        event: Notice,
        identity: &LosslessString,
        detail: JsonValue,
        wake: bool,
    ) -> Result<(), Error> {
        let Some(scope) = self.0.coordination.member_of(id)? else {
            return Ok(());
        };
        self.notify(&scope, id, event, identity, detail, wake).await
    }
    fn notice_id(
        &self,
        scope: &Scope,
        member: &session::Id,
        event: Notice,
        identity: &LosslessString,
    ) -> Result<session_message::Id, Error> {
        let identity = join(&[
            scope.group_id.as_lossless(),
            member.as_lossless(),
            &event.name().into(),
            identity,
        ]);
        let hash = digest::digest(&digest::SHA256, readable(&identity).as_bytes());
        let suffix = hash
            .as_ref()
            .iter()
            .take(12)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(session_message::Id::new(format!(
            "msg_project_notice_{suffix}"
        ))?)
    }
    fn notice_delivered(
        &self,
        receiver: &session::Id,
        id: &session_message::Id,
    ) -> Result<bool, Error> {
        Ok(!matches!(self.lookup(receiver, id)?, Lookup::Vacant))
    }
    fn handoff_identity(receiver: &session::Id, request: &c::PendingRequest) -> LosslessString {
        join(&[
            &"handoff".into(),
            receiver.as_lossless(),
            &request.request_id,
            &request.fingerprint,
        ])
    }
    async fn receiver_of(
        &self,
        scope: &Scope,
        member: &session::Id,
        wake: bool,
    ) -> Result<Option<session::Id>, Error> {
        let Some(owner) = self.owner_of(scope, member)?.map(|owner| owner.session_id) else {
            return Ok(None);
        };
        if self.owner_problem(scope, &owner)?.is_none() {
            return Ok(Some(owner));
        }
        self.release_stale(scope, member, wake).await?;
        Ok(None)
    }
    async fn release_stale(
        &self,
        scope: &Scope,
        member: &session::Id,
        wake: bool,
    ) -> Result<(), Error> {
        self.0
            .coordination
            .set_owner(
                &scope.group_id,
                OwnerInput {
                    session_id: member.clone(),
                    owner_session_id: None,
                    reason: Some(c::ReleaseReason::Released),
                },
            )
            .await?;
        self.handoff(scope, member, None, wake, "owner-failed")
            .await
    }
    async fn held_by_handoff(
        &self,
        scope: &Scope,
        member: &session::Id,
        receiver: &session::Id,
        request_id: &LosslessString,
    ) -> Result<bool, Error> {
        for pending in self.family_pending(scope, receiver, member).await? {
            let request = pending.summary;
            if &request.request_id == request_id
                && self.notice_delivered(
                    receiver,
                    &self.notice_id(
                        scope,
                        member,
                        Notice::request(request.kind),
                        &Self::handoff_identity(receiver, &request),
                    )?,
                )?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    async fn handoff(
        &self,
        scope: &Scope,
        member: &session::Id,
        receiver: Option<&session::Id>,
        wake: bool,
        reason: &str,
    ) -> Result<(), Error> {
        let target = receiver.unwrap_or(&scope.master_session_id);
        for pending in self.family_pending(scope, target, member).await? {
            let request = pending.summary;
            let identity = Self::handoff_identity(target, &request);
            let mut detail = ObjectEncoder::new()
                .field("requestID", &request.request_id)
                .field("fingerprint", &request.fingerprint)
                .optional("requestSessionID", &request.request_session_id);
            if receiver.is_some() {
                detail = detail.field("excerpt", &request.summary);
            }
            self.deliver(
                scope,
                member,
                (Notice::request(request.kind), &identity),
                target,
                wake,
                (detail.finish(), receiver.is_none().then(|| reason.into())),
            )
            .await?;
        }
        let snapshot = self.0.coordination.client().snapshot()?;
        let family = family::members(
            &mut family::Reader::Snapshot(&snapshot),
            member.as_lossless(),
        )?
        .into_iter()
        .collect::<BTreeSet<_>>();
        let mut children = snapshot
            .scan::<TaskTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)?
            .into_iter()
            .filter(|task| {
                family.contains(&task.session_id)
                    && task.state.as_str() == Some("waiting")
                    && task.question_id.is_some()
                    && task.question.is_some()
                    && task.question_time.is_some()
                    && snapshot
                        .get::<SessionTable>(&key(&task.session_id))
                        .is_ok_and(|row| row.is_some_and(|row| row.time_archived.is_none()))
            })
            .collect::<Vec<_>>();
        children.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        for task in children {
            let fingerprint: LosslessString = prompt_cache::sha256(&prompt_cache::canonical_json(
                &ObjectEncoder::new()
                    .field("sessionID", &task.session_id)
                    .field("questionID", &task.question_id.clone().unwrap_or_default())
                    .field("revision", &(task.revision as f64))
                    .finish(),
            ))
            .as_str()
            .into();
            let identity = join(&[&"child-question".into(), target.as_lossless(), &fingerprint]);
            let detail = ObjectEncoder::new()
                .field("kind", &c::RequestKind::Question)
                .field("requestID", &task.question_id.clone().unwrap_or_default())
                .field("requestSessionID", &task.session_id)
                .field("revision", &(task.revision as f64))
                .field("fingerprint", &fingerprint)
                .finish();
            self.deliver(
                scope,
                member,
                (Notice::Question, &identity),
                target,
                wake,
                (detail, receiver.is_none().then(|| reason.into())),
            )
            .await?;
        }
        Ok(())
    }
    fn delivered_sequence(
        &self,
        scope: &Scope,
        member: &session::Id,
        receiver: &session::Id,
    ) -> Result<i64, Error> {
        let snapshot = self.0.coordination.client().snapshot()?;
        let mut receivers = BTreeSet::from([receiver.as_lossless().clone()]);
        let mut after = None;
        loop {
            let page = events(
                &snapshot,
                scope.group_id.as_lossless(),
                IndexOrder::Ascending,
                after.as_ref(),
                100,
            )?;
            let Some(last) = page.last() else {
                break;
            };
            for event in &page {
                if event.record.type_.as_str() != Some("coordination.member.owner.changed.1") {
                    continue;
                }
                let change = c::OwnerChangedData::decode(&event.record.data)?;
                if &change.session_id == member
                    && let Some(owner) = change.owner_session_id
                {
                    receivers.insert(owner.as_lossless().clone());
                }
            }
            after = Some(last.cursor.clone());
        }
        let mut sequence = -1i64;
        for aggregate in &receivers {
            let mut after = None;
            loop {
                let page = events(
                    &snapshot,
                    aggregate,
                    IndexOrder::Ascending,
                    after.as_ref(),
                    100,
                )?;
                let Some(last) = page.last() else {
                    break;
                };
                for event in &page {
                    let row = &event.record;
                    if row.type_.as_str() != Some("session.input.admitted.1") {
                        continue;
                    }
                    let JsonValue::Object(data) = &row.data else {
                        continue;
                    };
                    let Some(JsonValue::Object(input)) = data.get(&"input".into()) else {
                        continue;
                    };
                    let Some(JsonValue::Object(input)) = input.get(&"data".into()) else {
                        continue;
                    };
                    let Some(JsonValue::Object(metadata)) = input.get(&"metadata".into()) else {
                        continue;
                    };
                    let text = |field: &str| match metadata.get(&field.into()) {
                        Some(JsonValue::String(value)) => value.as_str(),
                        _ => None,
                    };
                    if text("source") != Some(NOTICE)
                        || text("groupID") != scope.group_id.as_lossless().as_str()
                        || text("memberSessionID") != member.as_lossless().as_str()
                    {
                        continue;
                    }
                    if let Some(JsonValue::Number(value)) = metadata.get(&"memberSequence".into()) {
                        sequence = sequence.max(*value as i64);
                    }
                }
                after = Some(last.cursor.clone());
            }
        }
        Ok(sequence)
    }
    async fn deliver_held(
        &self,
        scope: &Scope,
        member: &session::Id,
        receiver: &session::Id,
        wake: bool,
    ) -> Result<(), Error> {
        let snapshot = self.0.coordination.client().snapshot()?;
        let mut joined: Option<i64> = None;
        let mut boundary = false;
        let mut after = None;
        while !boundary {
            let history = events(
                &snapshot,
                scope.group_id.as_lossless(),
                IndexOrder::Descending,
                after.as_ref(),
                100,
            )?;
            if history.is_empty() {
                break;
            }
            for event in &history {
                if !matches!(
                    event.record.type_.as_str(),
                    Some("coordination.group.created.2" | "coordination.group.changed.1")
                ) {
                    continue;
                }
                let current = c::Snapshot::decode(&event.record.data)?;
                if !current.member_session_ids.contains(member) {
                    boundary = true;
                    break;
                }
                joined = Some(event.record.created);
            }
            after = history.last().map(|entry| entry.cursor.clone());
        }
        let Some(joined) = joined else {
            return Ok(());
        };
        let delivered = self.delivered_sequence(scope, member, receiver)?;
        let types = [
            "session.execution.started.1",
            "session.step.ended.1",
            "session.execution.succeeded.1",
            "session.execution.interrupted.1",
        ];
        let mut held = Vec::new();
        let mut after = None;
        loop {
            let page = events(
                &snapshot,
                member.as_lossless(),
                IndexOrder::Ascending,
                after.as_ref(),
                100,
            )?;
            if page.is_empty() {
                break;
            }
            after = page.last().map(|entry| entry.cursor.clone());
            held.extend(page.into_iter().map(|entry| entry.record).filter(|event| {
                event.created >= joined
                    && event.seq > delivered
                    && types.contains(&event.type_.as_str().unwrap_or_default())
            }));
        }
        let Some(latest) = held.last() else {
            return Ok(());
        };
        let event = match latest.type_.as_str() {
            Some("session.execution.started.1") => Notice::Started,
            Some("session.step.ended.1") => Notice::Progress,
            Some("session.execution.succeeded.1") => Notice::Completed,
            _ => Notice::Interrupted,
        };
        if event == Notice::Completed && self.work_remains(member)? {
            return Ok(());
        }
        let identity = join(&[&"held".into(), receiver.as_lossless(), &latest.id]);
        let detail = ObjectEncoder::new()
            .field("memberSequence", &(latest.seq as f64))
            .field(
                "held",
                &ObjectEncoder::new()
                    .field("count", &(held.len() as f64))
                    .finish(),
            )
            .finish();
        self.deliver(
            scope,
            member,
            (event, &identity),
            receiver,
            wake && scope.active && !matches!(event, Notice::Started | Notice::Progress),
            (detail, None),
        )
        .await?;
        Ok(())
    }
    async fn notify(
        &self,
        scope: &Scope,
        member: &session::Id,
        event: Notice,
        identity: &LosslessString,
        detail: JsonValue,
        wake: bool,
    ) -> Result<(), Error> {
        let previous_owner = self.owner_of(scope, member)?;
        let receiver = self.receiver_of(scope, member, wake).await?;
        let request_id = detail_text(&detail, "requestID");
        if let Some(request) = &request_id
            && self
                .held_by_handoff(
                    scope,
                    member,
                    receiver.as_ref().unwrap_or(&scope.master_session_id),
                    request,
                )
                .await?
        {
            return Ok(());
        }
        let pending = match &request_id {
            None => None,
            Some(request) => self
                .family_pending(scope, &scope.master_session_id, member)
                .await?
                .into_iter()
                .map(|pending| pending.summary)
                .find(|summary| &summary.request_id == request),
        };
        let Some(receiver) = receiver else {
            if !event.urgent() {
                return Ok(());
            }
            let identity = match &pending {
                Some(pending) => Self::handoff_identity(&scope.master_session_id, pending),
                None => identity.clone(),
            };
            let mut encoder = ObjectEncoder::new();
            if let Some(request) = &request_id {
                encoder = encoder.field("requestID", request);
                if let Some(request_session) = detail_text(&detail, "requestSessionID") {
                    encoder = encoder.field("requestSessionID", &request_session);
                }
                if let Some(pending) = &pending {
                    encoder = encoder.field("fingerprint", &pending.fingerprint);
                }
            }
            let reason: LosslessString = if previous_owner.is_none() {
                "unowned".into()
            } else {
                "owner-failed".into()
            };
            self.deliver(
                scope,
                member,
                (event, &identity),
                &scope.master_session_id,
                wake,
                (encoder.finish(), Some(reason)),
            )
            .await?;
            return Ok(());
        };
        let retained = self
            .0
            .coordination
            .client()
            .snapshot()?
            .get::<EventTable>(&key(identity))?
            .map(|event| event.seq);
        if !event.urgent()
            && let Some(seq) = retained
            && seq <= self.delivered_sequence(scope, member, &receiver)?
        {
            return Ok(());
        }
        let routed = !matches!(event, Notice::Started | Notice::Progress)
            && (scope.active || event.urgent());
        let identity = match &pending {
            Some(pending) => Self::handoff_identity(&receiver, pending),
            None => identity.clone(),
        };
        let JsonValue::Object(mut fields) = detail else {
            return Err(Error::refused("Project notice detail must be an object"));
        };
        if let Some(pending) = &pending {
            fields.insert("fingerprint".into(), pending.fingerprint.clone().encode());
        }
        if let Some(seq) = retained {
            fields.insert("memberSequence".into(), JsonValue::Number(seq as f64));
        }
        self.deliver(
            scope,
            member,
            (event, &identity),
            &receiver,
            wake && routed,
            (JsonValue::Object(fields), None),
        )
        .await?;
        Ok(())
    }
    async fn deliver(
        &self,
        scope: &Scope,
        member: &session::Id,
        (event, identity): (Notice, &LosslessString),
        receiver: &session::Id,
        resume: bool,
        (detail, escalation_reason): (JsonValue, Option<LosslessString>),
    ) -> Result<session_message::Id, Error> {
        let id = self.notice_id(scope, member, event, identity)?;
        if self.notice_delivered(receiver, &id)? {
            return Ok(id);
        }
        if self.0.sessions.get(receiver)?.is_none() {
            return Ok(id);
        }
        let escalated = escalation_reason.is_some();
        let word = if escalated {
            "escalation"
        } else {
            "notification"
        };
        let mut encoder = ObjectEncoder::new()
            .field("source", if escalated { ESCALATION } else { NOTICE })
            .field("groupID", &scope.group_id)
            .field("memberSessionID", member);
        encoder = match &escalation_reason {
            Some(reason) => encoder.field("reason", reason),
            None => encoder.field("title", &self.title(member)?),
        };
        let mut metadata = JsonObject::decode(&encoder.field("event", event.name()).finish())?;
        for (key, value) in JsonObject::decode(&detail)?.iter() {
            metadata.insert(key.clone(), value.clone());
        }
        let text = format!("Project {word}:\n{}", stringify_json(&metadata.encode())).into();
        let event_id = random_event_id()?;
        let request = pending::Request {
            id: id.clone(),
            session_id: receiver.clone(),
            input: session_pending::Message::Synthetic(session_pending::SyntheticMessage {
                delivery: Delivery::Steer,
                data: session_pending::SyntheticData {
                    text,
                    description: Some(format!("Project {word}").into()),
                    metadata: Some(metadata),
                },
            }),
            event_id,
            created: chrono::Utc::now().timestamp_millis(),
        };
        self.0
            .execution
            .prompt_with_origin(request, Some(false), autonomy::Origin::Runtime)
            .await?;
        self.notice_resume(receiver, &id, resume).await?;
        Ok(id)
    }
    async fn notice_resume(
        &self,
        receiver: &session::Id,
        id: &session_message::Id,
        resume: bool,
    ) -> Result<(), Error> {
        if !resume {
            return Ok(());
        }
        let snapshot = self.0.coordination.client().snapshot()?;
        let row = snapshot.get::<TaskTable>(&key(receiver.as_lossless()))?;
        if let Some(row) = &row
            && !["running", "supervising", "completed"]
                .contains(&row.state.as_str().unwrap_or_default())
        {
            return Ok(());
        }
        if self.0.sessions.pending(id)?.is_none()
            || self
                .0
                .sessions
                .get(receiver)?
                .is_some_and(|info| info.revert.is_some())
        {
            return Ok(());
        }
        let settled = row.as_ref().is_some_and(|row| {
            ["completed", "supervising"].contains(&row.state.as_str().unwrap_or_default())
        });
        if !settled {
            self.0.execution.wake(receiver)?;
            if row.is_none() {
                return Ok(());
            }
            let current = self
                .0
                .coordination
                .client()
                .snapshot()?
                .get::<TaskTable>(&key(receiver.as_lossless()))?;
            if !current.is_some_and(|current| {
                ["completed", "supervising"].contains(&current.state.as_str().unwrap_or_default())
            }) || self.0.sessions.pending(id)?.is_none()
            {
                return Ok(());
            }
        }
        if review_fold::fold(&snapshot, &[receiver.as_lossless().clone()])?
            .iter()
            .any(|item| item.is_open())
        {
            return Ok(());
        }
        self.publish_change(receiver, Change::Started, None).await?;
        self.0.execution.wake(receiver)?;
        Ok(())
    }
    fn root_of(&self, id: &session::Id) -> Result<session::Id, Error> {
        let snapshot = self.0.coordination.client().snapshot()?;
        let mut root = id.as_lossless().clone();
        for _ in 0..64 {
            let Some(parent) = snapshot
                .get::<SessionTable>(&key(&root))?
                .and_then(|row| row.parent_id)
            else {
                break;
            };
            root = parent;
        }
        Ok(session::Id::new(root)?)
    }
    fn work_remains(&self, id: &session::Id) -> Result<bool, Error> {
        Ok(self.background_work(id)? || self.0.sessions.has_pending(id)?)
    }
    fn excerpt(&self, id: &session::Id) -> Result<Option<LosslessString>, Error> {
        let Some(session_message::Info::Assistant(assistant)) =
            self.0.sessions.latest(id, "assistant")?
        else {
            return Ok(None);
        };
        let errored = assistant.error.is_some();
        let text = crate::session::runner::unfinished_ending::excerpt_text(&assistant);
        Ok((errored || !text.is_empty()).then(|| clip(&text)))
    }
    fn background_work(&self, id: &session::Id) -> Result<bool, Error> {
        let snapshot = self.0.coordination.client().snapshot()?;
        let family = family::members(&mut family::Reader::Snapshot(&snapshot), id.as_lossless())?
            .into_iter()
            .collect::<BTreeSet<_>>();
        if self
            .0
            .execution
            .active()
            .iter()
            .any(|active| active != id && family.contains(active.as_lossless()))
        {
            return Ok(true);
        }
        for member in &family {
            for state in [
                "starting",
                "running",
                "waiting",
                "supervising",
                "cancelling",
            ] {
                let prefix = ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(member),
                    ycoding_store::KeyPart::String(&state.into()),
                ]);
                if !snapshot
                    .index_range::<TaskTable>(
                        "session_task_parent_state_updated_idx",
                        IndexQuery {
                            lower: Bound::Unbounded,
                            upper: Bound::Unbounded,
                            prefix: Some(&prefix),
                            order: IndexOrder::Ascending,
                            after: None,
                            limit: 1,
                        },
                    )?
                    .is_empty()
                {
                    return Ok(true);
                }
            }
        }
        let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::I64(0)]);
        let mut after = None;
        loop {
            let notices = snapshot.index_range::<NotificationTable>(
                "session_task_notification_delivery_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            if notices
                .iter()
                .any(|notice| family.contains(&notice.record.parent_id))
            {
                return Ok(true);
            }
            let Some(last) = notices.last() else {
                break;
            };
            after = Some(last.cursor.clone());
        }
        Ok(self
            .0
            .jobs
            .outstanding_sessions()
            .iter()
            .any(|job| family.contains(job.as_lossless()))
            || self.0.jobs.list().iter().any(|job| {
                job.status == job::Status::Running
                    && job
                        .metadata
                        .as_ref()
                        .and_then(|metadata| metadata.get("sessionID"))
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|id| family.contains(&id.into()))
            }))
    }
    pub async fn resume_admitted(&self) -> Result<(), Error> {
        for group in self.0.coordination.list()? {
            for member in &group.member_session_ids {
                self.0
                    .coordination
                    .with_ownership(&group.id, async {
                        let Some(scope) = self
                            .0
                            .coordination
                            .member_of(member)?
                            .filter(|scope| scope.group_id == group.id)
                        else {
                            return Ok::<(), Error>(());
                        };
                        if self
                            .admitted_ready(&scope, &scope.master_session_id, member, None)
                            .await?
                        {
                            self.0.execution.wake(member)?;
                        }
                        Ok(())
                    })
                    .await?;
            }
        }
        Ok(())
    }
    async fn admitted_ready(
        &self,
        scope: &Scope,
        caller: &session::Id,
        member: &session::Id,
        input: Option<&session_message::Id>,
    ) -> Result<bool, Error> {
        if !scope.active {
            return Ok(false);
        }
        let snapshot = self.0.coordination.client().snapshot()?;
        let Some(row) = snapshot.get::<SessionTable>(&key(member.as_lossless()))? else {
            return Ok(false);
        };
        if row.time_archived.is_some() || row.time_suspended.is_some() || row.revert.is_some() {
            return Ok(false);
        }
        let group = scope.group_id.encode();
        let mut admitted: Option<i64> = None;
        let mut inputs = BTreeSet::new();
        let prefix = key(member.as_lossless());
        let mut after = None;
        loop {
            let page = snapshot.index_range::<PendingTable>(
                "session_pending_session_admitted_seq_idx",
                IndexQuery {
                    lower: Bound::Unbounded,
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            for entry in &page {
                let pending = &entry.record;
                if pending.type_.as_str() != Some("user")
                    || !matches!(
                        pending.delivery.as_ref().and_then(LosslessString::as_str),
                        Some("steer" | "queue")
                    )
                {
                    return Ok(false);
                }
                let data = session_pending::UserData::decode(&pending.data)?;
                let metadata = data.metadata.as_ref();
                let provenance = metadata
                    .and_then(|metadata| metadata.get(&"coordination".into()))
                    .and_then(|value| match value {
                        JsonValue::Object(fields) => fields.get(&"groupID".into()),
                        _ => None,
                    });
                if pending::input_origin(metadata) != Some("coordination")
                    || provenance != Some(&group)
                    || snapshot.get::<MessageTable>(&key(&pending.id))?.is_some()
                {
                    return Ok(false);
                }
                admitted = Some(
                    admitted.map_or(pending.admitted_seq, |seq| seq.min(pending.admitted_seq)),
                );
                inputs.insert(pending.id.clone());
            }
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.cursor.clone());
        }
        let Some(admitted) = admitted else {
            return Ok(false);
        };
        if input.is_some_and(|input| !inputs.contains(input.as_lossless())) {
            return Ok(false);
        }
        let named =
            |value: &JsonValue| matches!(value, JsonValue::String(id) if inputs.contains(id));
        let lower = ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(member.as_lossless()),
            ycoding_store::KeyPart::I64(admitted),
        ]);
        let mut run: Option<bool> = None;
        let mut after = None;
        loop {
            let page = snapshot.index_range::<EventTable>(
                "event_aggregate_seq_idx",
                IndexQuery {
                    lower: Bound::Excluded(lower.as_slice()),
                    upper: Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: 128,
                },
            )?;
            for entry in &page {
                let event = &entry.record;
                let JsonValue::Object(data) = &event.data else {
                    return Ok(false);
                };
                match event.type_.as_str() {
                    Some("session.input.promoted.1")
                        if data.get(&"inputID".into()).is_some_and(named) =>
                    {
                        return Ok(false);
                    }
                    Some("session.input.consumed.1") if matches!(data.get(&"inputIDs".into()), Some(JsonValue::Array(ids)) if ids.iter().any(named)) =>
                    {
                        return Ok(false);
                    }
                    Some("session.execution.started.1") => {
                        if run.is_some() {
                            return Ok(false);
                        }
                        run = Some(false);
                    }
                    Some(
                        "session.step.started.1"
                        | "session.input.promoted.1"
                        | "session.input.consumed.1",
                    ) => {
                        if let Some(work) = run.as_mut() {
                            *work = true;
                        }
                    }
                    Some("session.execution.succeeded.1") => run = None,
                    Some("session.execution.failed.1") => {
                        let restarted = matches!(
                            data.get(&"error".into()),
                            Some(JsonValue::Object(error))
                                if error.get(&"type".into()) == Some(&JsonValue::String("interrupted".into()))
                        );
                        if run != Some(false) || !restarted {
                            return Ok(false);
                        }
                        run = None;
                    }
                    Some("session.execution.interrupted.1") => return Ok(false),
                    _ => {}
                }
            }
            let Some(last) = page.last() else {
                break;
            };
            after = Some(last.cursor.clone());
        }
        if run.is_some()
            || review_fold::fold(&snapshot, &[member.as_lossless().clone()])?
                .iter()
                .any(|item| item.is_open())
        {
            return Ok(false);
        }
        let aborted = |error: &ycoding_schema::session_error::Error| {
            matches!(error.r#type.as_str(), Some("interrupted" | "aborted"))
        };
        if let Some(session_message::Info::Assistant(assistant)) =
            self.0.sessions.latest(member, "assistant")?
            && (assistant.time.completed.is_none()
                || assistant.error.as_ref().is_some_and(aborted)
                || assistant.content.iter().any(|part| {
                    matches!(part, session_message::AssistantContent::Tool(tool) if match &tool.state {
                        session_message::ToolState::Streaming(_)
                        | session_message::ToolState::Running(_) => true,
                        session_message::ToolState::Error(failed) => aborted(&failed.error),
                        session_message::ToolState::Completed(_) => false,
                    })
                }))
        {
            return Ok(false);
        }
        Ok(self.pending(scope, caller, member).await?.is_empty())
    }
    pub async fn recover(&self) -> Result<(), Error> {
        self.complete_unowned_supervisors().await?;
        for group in self.0.coordination.list()? {
            let snapshot = self.0.coordination.client().snapshot()?;
            let mut joined = BTreeMap::new();
            let mut after = None;
            loop {
                let changes = events(
                    &snapshot,
                    group.id.as_lossless(),
                    IndexOrder::Ascending,
                    after.as_ref(),
                    100,
                )?;
                for change in &changes {
                    if !matches!(
                        change.record.type_.as_str(),
                        Some("coordination.group.created.2" | "coordination.group.changed.1")
                    ) {
                        continue;
                    }
                    let snapshot = c::Snapshot::decode(&change.record.data)?;
                    joined.retain(|member, _| snapshot.member_session_ids.contains(member));
                    for member in snapshot.member_session_ids {
                        joined.entry(member).or_insert(change.record.created);
                    }
                }
                let Some(last) = changes.last() else {
                    break;
                };
                after = Some(last.cursor.clone());
            }
            for member in group.member_session_ids {
                let Some(since) = joined.get(&member) else {
                    continue;
                };
                self.0
                    .coordination
                    .with_ownership(&group.id, async {
                        let Some(scope) = self.0.coordination.member_of(&member)? else {
                            return Ok::<(), Error>(());
                        };
                        if scope.group_id != group.id {
                            return Ok(());
                        }
                        if self
                            .0
                            .sessions
                            .get(&member)?
                            .is_some_and(|info| info.time.archived.is_some())
                        {
                            if self.owner_of(&scope, &member)?.is_some() {
                                self.0
                                    .coordination
                                    .set_owner(
                                        &scope.group_id,
                                        OwnerInput {
                                            session_id: member.clone(),
                                            owner_session_id: None,
                                            reason: Some(c::ReleaseReason::Released),
                                        },
                                    )
                                    .await?;
                            }
                            return Ok(());
                        }
                        let receiver = self.receiver_of(&scope, &member, false).await?;
                        if let Some(receiver) = &receiver {
                            self.deliver_held(&scope, &member, receiver, false).await?;
                        }
                        self.handoff(&scope, &member, receiver.as_ref(), false, "unowned")
                            .await
                    })
                    .await?;
                let mut after = None;
                loop {
                    let retained = events(
                        &snapshot,
                        member.as_lossless(),
                        IndexOrder::Ascending,
                        after.as_ref(),
                        100,
                    )?;
                    for event in &retained {
                        if event.record.created < *since {
                            continue;
                        }
                        let notice = match event.record.type_.as_str() {
                            Some("session.execution.started.1") => Notice::Started,
                            Some("session.step.ended.1") => Notice::Progress,
                            Some("session.execution.succeeded.1") => Notice::Completed,
                            Some("session.execution.failed.1") => Notice::Failed,
                            Some("session.execution.interrupted.1") => Notice::Interrupted,
                            _ => continue,
                        };
                        self.0
                            .coordination
                            .with_ownership(&group.id, async {
                                let Some(scope) = self.0.coordination.member_of(&member)? else {
                                    return Ok::<(), Error>(());
                                };
                                if scope.group_id != group.id {
                                    return Ok(());
                                }
                                if notice == Notice::Completed && self.work_remains(&member)? {
                                    return Ok(());
                                }
                                let path = JsonPath::default();
                                let object = ObjectDecoder::new(&event.record.data, &path)?;
                                let detail = match notice {
                                    Notice::Failed => ObjectEncoder::new()
                                        .field(
                                            "excerpt",
                                            &clip(
                                                &object
                                                    .field::<ycoding_schema::session_error::Error>(
                                                        "error",
                                                    )?
                                                    .message,
                                            ),
                                        )
                                        .finish(),
                                    Notice::Interrupted => ObjectEncoder::new()
                                        .field(
                                            "excerpt",
                                            format!(
                                                "Interrupted ({})",
                                                readable(&object.field("reason")?)
                                            )
                                            .as_str(),
                                        )
                                        .finish(),
                                    _ => ObjectEncoder::new().finish(),
                                };
                                self.notify(
                                    &scope,
                                    &member,
                                    notice,
                                    &event.record.id,
                                    detail,
                                    false,
                                )
                                .await
                            })
                            .await?;
                    }
                    let Some(last) = retained.last() else {
                        break;
                    };
                    after = Some(last.cursor.clone());
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Notice {
    Started,
    Progress,
    Completed,
    Failed,
    Interrupted,
    Question,
    Permission,
    Review,
    Escalated,
}
impl Notice {
    fn name(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::Progress => "progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Question => "question",
            Self::Permission => "permission",
            Self::Review => "review",
            Self::Escalated => "escalated",
        }
    }
    fn urgent(self) -> bool {
        matches!(
            self,
            Self::Failed | Self::Question | Self::Permission | Self::Review | Self::Escalated
        )
    }
    fn request(kind: c::RequestKind) -> Self {
        match kind {
            c::RequestKind::Question => Self::Question,
            c::RequestKind::Permission => Self::Permission,
            c::RequestKind::Review => Self::Review,
        }
    }
}
enum Lookup {
    Vacant,
    Conflict,
    Used {
        session_id: LosslessString,
        input: session_pending::Message,
    },
}
fn has_owned_members(
    snapshot: &Snapshot,
    session_id: &LosslessString,
) -> Result<bool, ycoding_store::Error> {
    for member in snapshot.index::<MemberTable>(
        "coordination_member_owner_idx",
        &ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(session_id)]),
        None,
        128,
    )? {
        if snapshot
            .get::<SessionTable>(&key(&member.session_id))?
            .is_some_and(|row| row.time_archived.is_none())
        {
            return Ok(true);
        }
    }
    Ok(false)
}
fn detail_text(detail: &JsonValue, field: &str) -> Option<LosslessString> {
    let JsonValue::Object(fields) = detail else {
        return None;
    };
    match fields.get(&field.into()) {
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}
fn scope(group: &Group) -> Scope {
    Scope {
        group_id: group.id.clone(),
        master_session_id: group.master_session_id.clone(),
        member_session_ids: group.member_session_ids.clone(),
        settings: group.settings.clone(),
        active: group.active,
        paused_reason: group.paused_reason,
    }
}
pub fn waiting_message(id: &session::Id, pending: &[Pending]) -> String {
    let requests = pending
        .iter()
        .map(|item| {
            let kind = match item.summary.kind {
                c::RequestKind::Permission => "permission",
                c::RequestKind::Review => "review",
                c::RequestKind::Question => "question",
            };
            format!("{kind} {}", readable(&item.summary.request_id))
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Session {} is waiting on {requests} and cannot receive input until each settles; settle it with answer, escalate it, or interrupt the member to withdraw it",
        readable(id.as_lossless())
    )
}
fn clip(text: &LosslessString) -> LosslessString {
    if text.len() <= 500 {
        return text.clone();
    }
    let mut units = text.code_units().take(499).collect::<Vec<_>>();
    units.push(0x2026);
    LosslessString::from_utf16(units)
}
fn readable(text: &LosslessString) -> String {
    String::from_utf16_lossy(&text.code_units().collect::<Vec<_>>())
}
fn chosen_directory(
    requested: &LosslessString,
    home: &std::path::Path,
) -> Result<AbsolutePath, Error> {
    let refused = || Error::refused("Choose an absolute directory path or a path starting with ~/");
    let text = requested.to_utf8().map_err(|_| refused())?;
    let expanded = match text.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(&rest[1..]),
        _ => std::path::PathBuf::from(&text),
    };
    if text.contains('\0') || !expanded.is_absolute() {
        return Err(refused());
    }
    let normalized = crate::platform::filesystem::normalize(&expanded);
    AbsolutePath::new(normalized.to_str().ok_or_else(refused)?).map_err(|_| refused())
}
fn join(parts: &[&LosslessString]) -> LosslessString {
    let mut units = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            units.push(0);
        }
        units.extend(part.code_units());
    }
    LosslessString::from_utf16(units)
}
fn string_value(value: &impl DomainEncode) -> Result<LosslessString, Error> {
    match value.encode() {
        JsonValue::String(value) => Ok(value),
        _ => Err(ycoding_store::Error::Rejected("native request ID must be a string").into()),
    }
}
fn delivery(row: &ycoding_store::session::Pending) -> Result<Delivery, Error> {
    Ok(Delivery::decode(
        &row.delivery
            .as_ref()
            .ok_or_else(|| Error::refused("Stored input has no delivery"))?
            .encode(),
    )?)
}
fn events(
    snapshot: &Snapshot,
    aggregate: &LosslessString,
    order: IndexOrder,
    after: Option<&ycoding_store::IndexCursor>,
    limit: usize,
) -> Result<Vec<ycoding_store::IndexEntry<Event>>, ycoding_store::Error> {
    let prefix = key(aggregate);
    snapshot.index_range::<EventTable>(
        "event_aggregate_seq_idx",
        IndexQuery {
            lower: Bound::Unbounded,
            upper: Bound::Unbounded,
            prefix: Some(&prefix),
            order,
            after,
            limit,
        },
    )
}
