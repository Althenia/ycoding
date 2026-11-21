use super::super::Error;
use std::{future::Future as StdFuture, pin::Pin, sync::Arc};
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, Nullable, ObjectEncoder, agent, coordination as c,
    form, location, model, permission, project, schema::AbsolutePath, session,
    session_delivery::Delivery, session_message,
};

pub type Future<'a, T> = Pin<Box<dyn StdFuture<Output = Result<T, Error>> + Send + 'a>>;
pub trait Decisions: Send + Sync {
    fn settings(&self) -> Future<'_, c::Settings>;
    fn pending(&self, input: PendingInput) -> Future<'_, Vec<Pending>>;
    fn evaluate(&self, input: EvaluateInput) -> Future<'_, DecisionResult>;
    fn escalate(&self, input: DecisionEscalateInput) -> Future<'_, DecisionEscalateResult>;
}
#[derive(Clone, Debug)]
pub struct PendingInput {
    pub group_id: c::GroupId,
    pub coordinator_session_id: session::Id,
    pub target_session_id: session::Id,
    pub descendant_session_ids: Vec<session::Id>,
    pub limit: Option<usize>,
}
#[derive(Clone, Debug)]
pub struct Pending {
    pub summary: c::PendingRequest,
    pub detail: RequestDetail,
}
#[derive(Clone, Debug)]
pub struct EvaluateInput {
    pub group_id: c::GroupId,
    pub coordinator_session_id: session::Id,
    pub target_session_id: session::Id,
    pub descendant_session_ids: Vec<session::Id>,
    pub request_id: LosslessString,
    pub kind: c::RequestKind,
    pub fingerprint: LosslessString,
    pub rationale: LosslessString,
    pub confidence: Option<f64>,
    pub answer: Option<form::Answer>,
    pub decision: Option<Decision>,
}
#[derive(Clone, Debug)]
pub struct DecisionEscalateInput {
    pub group_id: c::GroupId,
    pub coordinator_session_id: session::Id,
    pub target_session_id: session::Id,
    pub descendant_session_ids: Vec<session::Id>,
    pub request_id: LosslessString,
    pub kind: c::RequestKind,
    pub fingerprint: LosslessString,
    pub reason: LosslessString,
}

macro_rules! strings{
    ($name:ident{$($variant:ident=>$text:literal),+$(,)?})=>{
        #[derive(Clone,Copy,Debug,Eq,PartialEq)]pub enum $name{$($variant),+}
        impl DomainEncode for $name{fn encode(&self)->JsonValue{match self{$(Self::$variant=>$text.encode()),+}}}
    }
}
strings!(Decision{Approve=>"approve",Decline=>"decline"});
strings!(DecisionOutcome{Allowed=>"allowed",Denied=>"denied",Escalated=>"escalated",Stale=>"stale"});
strings!(DecisionActor{Coordinator=>"coordinator"});
strings!(EscalateOutcome{Escalated=>"escalated",Stale=>"stale"});
strings!(EscalationTarget{Master=>"master",Client=>"client"});

#[derive(Clone, Debug)]
pub struct DecisionResult {
    pub outcome: DecisionOutcome,
    pub kind: c::RequestKind,
    pub request_id: LosslessString,
    pub fingerprint: LosslessString,
    pub actor: DecisionActor,
    pub settled: bool,
    pub via: Option<LosslessString>,
    pub confidence: Option<f64>,
    pub source: Option<form::ReplySource>,
    pub rationale: Option<LosslessString>,
    pub reason: Option<LosslessString>,
}
impl DomainEncode for DecisionResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("outcome", &self.outcome)
            .field("kind", &self.kind)
            .field("requestID", &self.request_id)
            .field("fingerprint", &self.fingerprint)
            .field("actor", &self.actor)
            .field("settled", &self.settled)
            .optional("via", &self.via)
            .optional("confidence", &self.confidence)
            .optional("source", &self.source)
            .optional("rationale", &self.rationale)
            .optional("reason", &self.reason)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct DecisionEscalateResult {
    pub outcome: EscalateOutcome,
    pub kind: c::RequestKind,
    pub request_id: LosslessString,
    pub fingerprint: LosslessString,
    pub actor: DecisionActor,
    pub settled: bool,
    pub to: Option<EscalationTarget>,
    pub coordination_escalation: Option<c::Escalation>,
    pub reason: Option<LosslessString>,
    pub review_item_id: Option<LosslessString>,
    pub request_session_id: Option<session::Id>,
}
impl DomainEncode for DecisionEscalateResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("outcome", &self.outcome)
            .field("kind", &self.kind)
            .field("requestID", &self.request_id)
            .field("fingerprint", &self.fingerprint)
            .field("actor", &self.actor)
            .field("settled", &self.settled)
            .optional("to", &self.to)
            .optional("coordinationEscalation", &self.coordination_escalation)
            .optional("reason", &self.reason)
            .optional("reviewItemID", &self.review_item_id)
            .optional("requestSessionID", &self.request_session_id)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Delegation {
    Routine,
    DeclineOnly,
    ExplicitDecision(LosslessString),
}
impl DomainEncode for Delegation {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Routine => "routine".encode(),
            Self::DeclineOnly => "decline-only".encode(),
            Self::ExplicitDecision(reason) => {
                let mut units = "explicit-decision:".encode_utf16().collect::<Vec<_>>();
                units.extend(reason.code_units());
                LosslessString::from_utf16(units).encode()
            }
        }
    }
}
#[derive(Clone, Debug)]
pub struct RequestField {
    pub key: LosslessString,
    pub type_: LosslessString,
    pub title: Option<LosslessString>,
    pub required: Option<bool>,
    pub options: Option<Vec<LosslessString>>,
}
impl DomainEncode for RequestField {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("key", &self.key)
            .field("type", &self.type_)
            .optional("title", &self.title)
            .optional("required", &self.required)
            .optional("options", &self.options)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub enum RequestDetail {
    Permission {
        request_id: LosslessString,
        fingerprint: LosslessString,
        action: LosslessString,
        resources: Vec<LosslessString>,
        delegation: Delegation,
        coordination_escalation: Option<c::Escalation>,
        request_session_id: Option<session::Id>,
    },
    Review {
        request_id: LosslessString,
        fingerprint: LosslessString,
        action: LosslessString,
        resources: Vec<LosslessString>,
        rule_ids: Vec<LosslessString>,
        reason: LosslessString,
        hard_review: bool,
        standard: bool,
        delegation: Delegation,
        coordination_escalation: Option<c::Escalation>,
        request_session_id: Option<session::Id>,
    },
    Question {
        request_id: LosslessString,
        fingerprint: LosslessString,
        title: LosslessString,
        fields: Vec<RequestField>,
        delegation: Delegation,
        coordination_escalation: Option<c::Escalation>,
        request_session_id: Option<session::Id>,
    },
}
impl DomainEncode for RequestDetail {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Permission {
                request_id,
                fingerprint,
                action,
                resources,
                delegation,
                coordination_escalation,
                request_session_id,
            } => ObjectEncoder::new()
                .field("kind", "permission")
                .field("requestID", request_id)
                .field("fingerprint", fingerprint)
                .field("action", action)
                .field("resources", resources)
                .field("delegation", delegation)
                .optional("coordinationEscalation", coordination_escalation)
                .optional("requestSessionID", request_session_id)
                .finish(),
            Self::Review {
                request_id,
                fingerprint,
                action,
                resources,
                rule_ids,
                reason,
                hard_review,
                standard,
                delegation,
                coordination_escalation,
                request_session_id,
            } => ObjectEncoder::new()
                .field("kind", "review")
                .field("requestID", request_id)
                .field("fingerprint", fingerprint)
                .field("action", action)
                .field("resources", resources)
                .field("ruleIDs", rule_ids)
                .field("reason", reason)
                .field("hardReview", hard_review)
                .field("standard", standard)
                .field("delegation", delegation)
                .optional("coordinationEscalation", coordination_escalation)
                .optional("requestSessionID", request_session_id)
                .finish(),
            Self::Question {
                request_id,
                fingerprint,
                title,
                fields,
                delegation,
                coordination_escalation,
                request_session_id,
            } => ObjectEncoder::new()
                .field("kind", "question")
                .field("requestID", request_id)
                .field("fingerprint", fingerprint)
                .field("title", title)
                .field("fields", fields)
                .field("delegation", delegation)
                .optional("coordinationEscalation", coordination_escalation)
                .optional("requestSessionID", request_session_id)
                .finish(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SendInput {
    pub session_id: session::Id,
    pub text: LosslessString,
    pub delivery: Option<Delivery>,
    pub message_id: Option<session_message::Id>,
    pub model: Option<model::Ref>,
}
#[derive(Clone, Debug)]
pub struct SendResult {
    pub session_id: session::Id,
    pub message_id: session_message::Id,
    pub state: c::MemberState,
    pub reconciled: bool,
}
impl DomainEncode for SendResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("messageID", &self.message_id)
            .field("state", &self.state)
            .field("reconciled", &self.reconciled)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct AnswerInput {
    pub session_id: session::Id,
    pub request_id: LosslessString,
    pub kind: c::RequestKind,
    pub fingerprint: LosslessString,
    pub rationale: LosslessString,
    pub confidence: Option<f64>,
    pub answer: Option<form::Answer>,
    pub decision: Option<Decision>,
}
#[derive(Clone, Debug)]
pub struct EscalateInput {
    pub session_id: session::Id,
    pub request_id: LosslessString,
    pub kind: c::RequestKind,
    pub fingerprint: LosslessString,
    pub reason: LosslessString,
}
#[derive(Clone, Debug)]
pub struct EscalateResult {
    pub session_id: session::Id,
    pub request_id: LosslessString,
    pub request_session_id: Option<session::Id>,
    pub message_id: Option<session_message::Id>,
    pub delivered: bool,
    pub decision: DecisionEscalateResult,
}
impl DomainEncode for EscalateResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("requestID", &self.request_id)
            .optional("requestSessionID", &self.request_session_id)
            .optional("messageID", &self.message_id)
            .field("delivered", &self.delivered)
            .field("decision", &self.decision)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct InspectInput {
    pub session_id: session::Id,
    pub request_id: LosslessString,
}
#[derive(Clone, Debug)]
pub struct MemberInput {
    pub session_id: session::Id,
}
#[derive(Clone, Debug)]
pub struct MemberResult {
    pub session_id: session::Id,
    pub location: location::Ref,
    pub model: Nullable<model::Ref>,
    pub state: c::MemberState,
    pub owner: Option<c::ParticipantSession>,
}
impl DomainEncode for MemberResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("location", &self.location)
            .field("model", &self.model)
            .field("state", &self.state)
            .optional("owner", &self.owner)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct ModelInput {
    pub session_id: session::Id,
    pub expected_model: Nullable<model::Ref>,
    pub model: model::Ref,
}
pub struct ModelServices {
    pub resolver: crate::session::orchestration::ModelSwitch,
    pub lease: Arc<dyn Send + Sync>,
    pub is_current: Arc<dyn Fn() -> bool + Send + Sync>,
}
pub type ModelServicesFactory =
    Arc<dyn Fn(session::Id) -> Future<'static, ModelServices> + Send + Sync>;
#[derive(Clone, Debug)]
pub struct RemoveResult {
    pub session_id: session::Id,
    pub removed: bool,
}
impl DomainEncode for RemoveResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("removed", &self.removed)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct AttachInput {
    pub session_id: session::Id,
    pub owner_session_id: Option<session::Id>,
}
#[derive(Clone, Debug)]
pub struct AttachResult {
    pub group_id: c::GroupId,
    pub session_id: session::Id,
    pub location: location::Ref,
    pub owner_session_id: session::Id,
    pub reconciled: bool,
}
impl DomainEncode for AttachResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("groupID", &self.group_id)
            .field("sessionID", &self.session_id)
            .field("location", &self.location)
            .field("ownerSessionID", &self.owner_session_id)
            .field("reconciled", &self.reconciled)
            .finish()
    }
}
pub type AuthorizeLocation = Box<dyn FnOnce(location::Ref) -> Future<'static, ()> + Send>;
#[derive(Clone, Debug)]
pub struct InterruptInput {
    pub session_id: session::Id,
}
#[derive(Clone, Debug)]
pub struct InterruptResult {
    pub session_id: session::Id,
    pub state: c::MemberState,
}
impl DomainEncode for InterruptResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("state", &self.state)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct AssignInput {
    pub session_id: session::Id,
    pub owner_session_id: session::Id,
}
#[derive(Clone, Debug)]
pub struct ReleaseInput {
    pub session_id: session::Id,
    pub reason: c::ReleaseReason,
}
#[derive(Clone, Debug)]
pub struct OwnershipResult {
    pub session_id: session::Id,
    pub owner: Option<c::ParticipantSession>,
}
impl DomainEncode for OwnershipResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .optional("owner", &self.owner)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct RosterProject {
    pub id: c::GroupId,
    pub name: LosslessString,
    pub active: bool,
    pub paused_reason: Option<c::PausedReason>,
    pub concurrency: ycoding_schema::Nullable<ycoding_schema::schema::PositiveInt>,
}
impl DomainEncode for RosterProject {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("name", &self.name)
            .field("active", &self.active)
            .optional("pausedReason", &self.paused_reason)
            .field("concurrency", &self.concurrency)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct Roster {
    pub project: RosterProject,
    pub members: Vec<c::Participant>,
}
impl DomainEncode for Roster {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("project", &self.project)
            .field("members", &self.members)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub enum CreateTarget {
    Directory {
        directory: LosslessString,
    },
    Worktree {
        name: LosslessString,
        repository: Option<LosslessString>,
    },
    Project {
        project_id: project::Id,
    },
}
#[derive(Clone, Debug)]
pub struct CreateInput {
    pub id: session::Id,
    pub agent_permissions: permission::Ruleset,
    pub target: CreateTarget,
    pub owner_session_id: Option<session::Id>,
    pub title: Option<LosslessString>,
    pub prompt: Option<LosslessString>,
    pub model: Option<model::Ref>,
}
#[derive(Clone, Debug)]
pub struct CreatedWorktree {
    pub directory: LosslessString,
    pub branch: LosslessString,
}
pub type CreateWorktree =
    Box<dyn FnOnce(LosslessString) -> Future<'static, CreatedWorktree> + Send>;
pub type OpenDirectory = Box<dyn FnOnce(AbsolutePath, bool) -> Future<'static, project::Id> + Send>;
pub struct CreateDirectory {
    pub home: std::path::PathBuf,
    pub open: OpenDirectory,
}
pub enum CreateProvider {
    Worktree(CreateWorktree),
    Directory(CreateDirectory),
}
#[derive(Clone, Debug)]
pub enum CreatePrompt {
    Sent(SendResult),
    Refused(LosslessString),
}
impl DomainEncode for CreatePrompt {
    fn encode(&self) -> JsonValue {
        match self {
            Self::Sent(result) => result.encode(),
            Self::Refused(message) => ObjectEncoder::new().field("refused", message).finish(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct Enrollment {
    pub group_id: c::GroupId,
    pub member: bool,
    pub error: Option<LosslessString>,
}
impl DomainEncode for Enrollment {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("groupID", &self.group_id)
            .field("member", &self.member)
            .optional("error", &self.error)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct CreateResult {
    pub session_id: session::Id,
    pub directory: LosslessString,
    pub location: location::Ref,
    pub model: Nullable<model::Ref>,
    pub enrollment: Enrollment,
    pub branch: Option<LosslessString>,
    pub owner: Option<c::ParticipantSession>,
    pub prompt: Option<CreatePrompt>,
}
impl DomainEncode for CreateResult {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("directory", &self.directory)
            .field("location", &self.location)
            .field("model", &self.model)
            .field("enrollment", &self.enrollment)
            .optional("branch", &self.branch)
            .optional("owner", &self.owner)
            .optional("prompt", &self.prompt)
            .finish()
    }
}
#[derive(Clone, Debug)]
pub struct CreateContext {
    pub session_id: session::Id,
    pub agent: agent::Id,
    pub message_id: session_message::Id,
    pub call_id: LosslessString,
}
pub trait MemberCreator: Send + Sync {
    fn agent_permissions(
        &self,
        caller: session::Id,
        agent: agent::Id,
    ) -> Future<'_, Option<permission::Ruleset>>;
    fn worktree_allowed(&self, caller: session::Id) -> Future<'_, bool>;
    fn create_worktree(
        &self,
        context: CreateContext,
        name: LosslessString,
        repository: Option<LosslessString>,
    ) -> Future<'_, CreatedWorktree>;
    fn directory(&self, context: CreateContext) -> Future<'_, CreateDirectory>;
    fn attach_location(
        &self,
        context: CreateContext,
        session_id: session::Id,
    ) -> Future<'_, AuthorizeLocation>;
}
