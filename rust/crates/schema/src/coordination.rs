use crate::{
    DecodeError, DecodeErrorKind, DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString,
    Nullable, ObjectDecoder, ObjectEncoder, agent,
    domain::{bounded_string, branded_string},
    location, model,
    schema::{NonNegativeInt, PositiveInt},
    session_id::SessionId,
    session_message,
};

pub const MAX_MEMBERS: usize = 64;
pub const MAX_PENDING: usize = 50;
pub const MAX_ESCALATION_REASONS: usize = 4;

crate::schema::record_type!(AttachInput {
    session_id: SessionId => "sessionID",
} { owner_session_id: SessionId => "ownerSessionID" });
crate::schema::record_type!(AttachResult {
    group_id: GroupId => "groupID",
    session_id: SessionId => "sessionID",
    location: location::Ref => "location",
    owner_session_id: SessionId => "ownerSessionID",
    reconciled: bool => "reconciled",
} {});

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct GroupId(LosslessString);

impl GroupId {
    pub fn new(value: impl Into<LosslessString>) -> Result<Self, DecodeError> {
        Self::decode(&JsonValue::String(value.into()))
    }

    pub fn as_lossless(&self) -> &LosslessString {
        &self.0
    }

    pub fn into_lossless(self) -> LosslessString {
        self.0
    }
}

impl DomainDecode for GroupId {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        bounded_string(value, 6, 96, path)?;
        branded_string(value, "cgrp_", path).map(Self)
    }
}

impl DomainEncode for GroupId {
    fn encode(&self) -> JsonValue {
        self.0.encode()
    }
}

crate::schema::integer_type!(Revision, 0);
crate::schema::literal_enum_type!(RequestKind, { Question => "question", Permission => "permission", Review => "review" });
crate::schema::literal_enum_type!(MemberState, { Idle => "idle", Running => "running", Waiting => "waiting", Failed => "failed" });
crate::schema::literal_enum_type!(PausedReason, { Interrupted => "interrupted", Restart => "restart" });
crate::schema::literal_enum_type!(ReleaseReason, { Completed => "completed", Released => "released" });

crate::schema::literal_enum_type!(BoardRole, { Master => "master", Supervisor => "supervisor", Member => "member", Subagent => "subagent" });
crate::schema::literal_enum_type!(BoardNodeState, { Idle => "idle", Starting => "starting", Running => "running", Waiting => "waiting", Supervising => "supervising", Cancelling => "cancelling", Cancelled => "cancelled", Completed => "completed", Failed => "failed", Lost => "lost" });
crate::schema::literal_enum_type!(TaskState, { Queued => "queued", Blocked => "blocked", Running => "running", Waiting => "waiting", Completed => "completed", Failed => "failed", Cancelled => "cancelled" });

crate::schema::record_type!(BoardNode {
    session_id: SessionId => "sessionID", role: BoardRole => "role",
    title: LosslessString => "title", state: BoardNodeState => "state",
} { parent_session_id: SessionId => "parentSessionID", agent_id: agent::Id => "agentID", model: model::Ref => "model" });
crate::schema::record_type!(TaskResult {} { message_id: session_message::Id => "messageID", summary: LosslessString => "summary" });
crate::schema::record_type!(BoardTask {
    task_id: session_message::Id => "taskID", title: LosslessString => "title", session_id: SessionId => "sessionID",
    owner_session_id: SessionId => "ownerSessionID", depends_on_task_ids: Vec<session_message::Id> => "dependsOnTaskIDs",
    state: TaskState => "state",
} { result: TaskResult => "result" });
crate::schema::record_type!(BoardHandoff {
    session_id: SessionId => "sessionID", time: NonNegativeInt => "time",
} { from_session_id: SessionId => "fromSessionID", to_session_id: SessionId => "toSessionID" });
crate::schema::record_type!(BoardReview { session_id: SessionId => "sessionID", request: PendingRequest => "request" } {});
crate::schema::record_type!(Board {
    group_id: GroupId => "groupID", nodes: Vec<BoardNode> => "nodes", tasks: Vec<BoardTask> => "tasks",
    handoffs: Vec<BoardHandoff> => "handoffs", reviews: Vec<BoardReview> => "reviews",
} {});

fn bounded_array<T>(
    values: Vec<T>,
    minimum: usize,
    maximum: usize,
    path: &JsonPath,
) -> Result<Vec<T>, DecodeError> {
    if !(minimum..=maximum).contains(&values.len()) {
        return Err(path.error(DecodeErrorKind::Length { minimum, maximum }));
    }
    Ok(values)
}

fn scopes(
    object: &ObjectDecoder<'_>,
    key: &str,
    path: &JsonPath,
) -> Result<Option<Vec<LosslessString>>, DecodeError> {
    object
        .optional::<Vec<LosslessString>>(key)?
        .map(|values| {
            let path = path.key(key);
            let values = bounded_array(values, 0, 32, &path)?;
            for (index, value) in values.iter().enumerate() {
                if !(1..=512).contains(&value.len()) {
                    return Err(path.index(index).error(DecodeErrorKind::Length {
                        minimum: 1,
                        maximum: 512,
                    }));
                }
            }
            Ok(values)
        })
        .transpose()
}

#[derive(Clone, Debug, PartialEq)]
pub struct DelegatedDecisions {
    pub categories: Vec<RequestKind>,
    pub actions: Option<Vec<LosslessString>>,
    pub resources: Option<Vec<LosslessString>>,
    pub expires_at: Option<NonNegativeInt>,
}

impl DomainDecode for DelegatedDecisions {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            categories: bounded_array(object.field("categories")?, 0, 3, &path.key("categories"))?,
            actions: scopes(&object, "actions", path)?,
            resources: scopes(&object, "resources", path)?,
            expires_at: object.optional("expiresAt")?,
        })
    }
}

impl DomainEncode for DelegatedDecisions {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("categories", &self.categories)
            .optional("actions", &self.actions)
            .optional("resources", &self.resources)
            .optional("expiresAt", &self.expires_at)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub enabled: bool,
    pub categories: Vec<RequestKind>,
    pub actions: Option<Vec<LosslessString>>,
    pub resources: Option<Vec<LosslessString>>,
    pub expires_at: Option<NonNegativeInt>,
}

impl DomainDecode for Settings {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let enabled = object.field("enabled")?;
        let decisions = DelegatedDecisions::decode_at(value, path)?;
        Ok(Self {
            enabled,
            categories: decisions.categories,
            actions: decisions.actions,
            resources: decisions.resources,
            expires_at: decisions.expires_at,
        })
    }
}

impl DomainEncode for Settings {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("enabled", &self.enabled)
            .field("categories", &self.categories)
            .optional("actions", &self.actions)
            .optional("resources", &self.resources)
            .optional("expiresAt", &self.expires_at)
            .finish()
    }
}

crate::schema::record_type!(GroupSettings { concurrency: Nullable<PositiveInt> => "concurrency" } { delegated_decisions: DelegatedDecisions => "delegatedDecisions" });

#[derive(Clone, Debug, PartialEq)]
pub struct CreateInput {
    pub name: LosslessString,
    pub master_session_id: SessionId,
    pub member_session_ids: Vec<SessionId>,
}

impl DomainDecode for CreateInput {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            name: bounded_string(&object.field("name")?, 1, 120, &path.key("name"))?,
            master_session_id: object.field("masterSessionID")?,
            member_session_ids: bounded_array(
                object.field("memberSessionIDs")?,
                0,
                MAX_MEMBERS,
                &path.key("memberSessionIDs"),
            )?,
        })
    }
}

impl DomainEncode for CreateInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("name", &self.name)
            .field("masterSessionID", &self.master_session_id)
            .field("memberSessionIDs", &self.member_session_ids)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct UpdateInput {
    pub revision: Revision,
    pub name: Option<LosslessString>,
    pub master_session_id: Option<SessionId>,
    pub member_session_ids: Option<Vec<SessionId>>,
    pub settings: Option<GroupSettings>,
}

impl DomainDecode for UpdateInput {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            revision: object.field("revision")?,
            name: object
                .optional::<JsonValue>("name")?
                .map(|value| bounded_string(&value, 1, 120, &path.key("name")))
                .transpose()?,
            master_session_id: object.optional("masterSessionID")?,
            member_session_ids: object
                .optional::<Vec<SessionId>>("memberSessionIDs")?
                .map(|values| bounded_array(values, 0, MAX_MEMBERS, &path.key("memberSessionIDs")))
                .transpose()?,
            settings: object.optional("settings")?,
        })
    }
}

impl DomainEncode for UpdateInput {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("revision", &self.revision)
            .optional("name", &self.name)
            .optional("masterSessionID", &self.master_session_id)
            .optional("memberSessionIDs", &self.member_session_ids)
            .optional("settings", &self.settings)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PendingRequest {
    pub kind: RequestKind,
    pub request_id: LosslessString,
    pub fingerprint: LosslessString,
    pub summary: LosslessString,
    pub request_session_id: Option<SessionId>,
}

impl DomainDecode for PendingRequest {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            kind: object.field("kind")?,
            request_id: bounded_string(
                &object.field("requestID")?,
                1,
                256,
                &path.key("requestID"),
            )?,
            fingerprint: bounded_string(
                &object.field("fingerprint")?,
                1,
                256,
                &path.key("fingerprint"),
            )?,
            summary: bounded_string(&object.field("summary")?, 0, 500, &path.key("summary"))?,
            request_session_id: object.optional("requestSessionID")?,
        })
    }
}

impl DomainEncode for PendingRequest {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("kind", &self.kind)
            .field("requestID", &self.request_id)
            .field("fingerprint", &self.fingerprint)
            .field("summary", &self.summary)
            .optional("requestSessionID", &self.request_session_id)
            .finish()
    }
}

crate::schema::record_type!(ParticipantSession { session_id: SessionId => "sessionID", title: LosslessString => "title" } {});

#[derive(Clone, Debug, PartialEq)]
pub struct Participant {
    pub session_id: SessionId,
    pub title: LosslessString,
    pub location: location::Ref,
    pub state: MemberState,
    pub last_activity: NonNegativeInt,
    pub pending: Vec<PendingRequest>,
    pub driven_by: Option<ParticipantSession>,
    pub owner: Option<ParticipantSession>,
}

impl DomainDecode for Participant {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            session_id: object.field("sessionID")?,
            title: object.field("title")?,
            location: object.field("location")?,
            state: object.field("state")?,
            last_activity: object.field("lastActivity")?,
            pending: bounded_array(
                object.field("pending")?,
                0,
                MAX_PENDING,
                &path.key("pending"),
            )?,
            driven_by: object.optional("drivenBy")?,
            owner: object.optional("owner")?,
        })
    }
}

impl DomainEncode for Participant {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("title", &self.title)
            .field("location", &self.location)
            .field("state", &self.state)
            .field("lastActivity", &self.last_activity)
            .field("pending", &self.pending)
            .optional("drivenBy", &self.driven_by)
            .optional("owner", &self.owner)
            .finish()
    }
}

crate::schema::record_type!(Time { created: NonNegativeInt => "created", updated: NonNegativeInt => "updated" } {});

#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: GroupId,
    pub name: LosslessString,
    pub revision: Revision,
    pub active: bool,
    pub paused_reason: Option<PausedReason>,
    pub master: Participant,
    pub members: Vec<Participant>,
    pub settings: GroupSettings,
    pub time: Time,
}

impl DomainDecode for Info {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            id: object.field("id")?,
            name: object.field("name")?,
            revision: object.field("revision")?,
            active: object.field("active")?,
            paused_reason: object.optional("pausedReason")?,
            master: object.field("master")?,
            members: object.field("members")?,
            settings: object.field("settings")?,
            time: object.field("time")?,
        })
    }
}

impl DomainEncode for Info {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("name", &self.name)
            .field("revision", &self.revision)
            .field("active", &self.active)
            .optional("pausedReason", &self.paused_reason)
            .field("master", &self.master)
            .field("members", &self.members)
            .field("settings", &self.settings)
            .field("time", &self.time)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GroupSummary {
    pub id: GroupId,
    pub name: LosslessString,
    pub revision: Revision,
    pub active: bool,
    pub paused_reason: Option<PausedReason>,
    pub master_session_id: SessionId,
    pub member_count: NonNegativeInt,
    pub settings: GroupSettings,
    pub time: Time,
}

impl DomainDecode for GroupSummary {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            id: object.field("id")?,
            name: object.field("name")?,
            revision: object.field("revision")?,
            active: object.field("active")?,
            paused_reason: object.optional("pausedReason")?,
            master_session_id: object.field("masterSessionID")?,
            member_count: object.field("memberCount")?,
            settings: object.field("settings")?,
            time: object.field("time")?,
        })
    }
}

impl DomainEncode for GroupSummary {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("id", &self.id)
            .field("name", &self.name)
            .field("revision", &self.revision)
            .field("active", &self.active)
            .optional("pausedReason", &self.paused_reason)
            .field("masterSessionID", &self.master_session_id)
            .field("memberCount", &self.member_count)
            .field("settings", &self.settings)
            .field("time", &self.time)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EscalationReason {
    pub session_id: SessionId,
    pub reason: LosslessString,
}

impl DomainDecode for EscalationReason {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        let reason = bounded_string(&object.field("reason")?, 1, 500, &path.key("reason"))?;
        if !reason.code_units().any(|unit| !matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)) {
            return Err(path.key("reason").error(DecodeErrorKind::Expected("non-whitespace reason")));
        }
        Ok(Self {
            session_id: object.field("sessionID")?,
            reason,
        })
    }
}

impl DomainEncode for EscalationReason {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .field("reason", &self.reason)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Escalation {
    pub reasons: Vec<EscalationReason>,
}

impl DomainDecode for Escalation {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            reasons: bounded_array(
                object.field("reasons")?,
                1,
                MAX_ESCALATION_REASONS,
                &path.key("reasons"),
            )?,
        })
    }
}

impl DomainEncode for Escalation {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("reasons", &self.reasons)
            .finish()
    }
}

crate::schema::record_type!(GroupRevision { group_id: GroupId => "groupID", revision: Revision => "revision" } {});
crate::schema::record_type!(UpdatedData { group_id: GroupId => "groupID", revision: Revision => "revision" } { session_id: SessionId => "sessionID" });
crate::schema::record_type!(OwnerChangedData { group_id: GroupId => "groupID", revision: Revision => "revision", session_id: SessionId => "sessionID" } { owner_session_id: SessionId => "ownerSessionID", reason: ReleaseReason => "reason" });

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub group_id: GroupId,
    pub revision: Revision,
    pub name: LosslessString,
    pub master_session_id: SessionId,
    pub member_session_ids: Vec<SessionId>,
    pub settings: GroupSettings,
}

impl DomainDecode for Snapshot {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            group_id: object.field("groupID")?,
            revision: object.field("revision")?,
            name: bounded_string(&object.field("name")?, 1, 120, &path.key("name"))?,
            master_session_id: object.field("masterSessionID")?,
            member_session_ids: bounded_array(
                object.field("memberSessionIDs")?,
                0,
                MAX_MEMBERS,
                &path.key("memberSessionIDs"),
            )?,
            settings: object.field("settings")?,
        })
    }
}

impl DomainEncode for Snapshot {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("groupID", &self.group_id)
            .field("revision", &self.revision)
            .field("name", &self.name)
            .field("masterSessionID", &self.master_session_id)
            .field("memberSessionIDs", &self.member_session_ids)
            .field("settings", &self.settings)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RequestEscalatedData {
    pub session_id: SessionId,
    pub root_session_id: Option<SessionId>,
    pub kind: RequestKind,
    pub request_id: LosslessString,
    pub coordination_escalation: Escalation,
}

impl DomainDecode for RequestEscalatedData {
    fn decode_at(value: &JsonValue, path: &JsonPath) -> Result<Self, DecodeError> {
        let object = ObjectDecoder::new(value, path)?;
        Ok(Self {
            session_id: object.field("sessionID")?,
            root_session_id: object.optional("rootSessionID")?,
            kind: object.field("kind")?,
            request_id: bounded_string(
                &object.field("requestID")?,
                1,
                256,
                &path.key("requestID"),
            )?,
            coordination_escalation: object.field("coordinationEscalation")?,
        })
    }
}

impl DomainEncode for RequestEscalatedData {
    fn encode(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("sessionID", &self.session_id)
            .optional("rootSessionID", &self.root_session_id)
            .field("kind", &self.kind)
            .field("requestID", &self.request_id)
            .field("coordinationEscalation", &self.coordination_escalation)
            .finish()
    }
}

pub mod event {
    use crate::event::{DurableEventType, EventType};

    pub struct Created;
    impl EventType for Created {
        const TYPE: &'static str = "coordination.group.created";
        type Data = super::Snapshot;
    }
    impl DurableEventType for Created {
        const VERSION: i64 = 2;
        const AGGREGATE: &'static str = "groupID";
    }

    pub struct Changed;
    impl EventType for Changed {
        const TYPE: &'static str = "coordination.group.changed";
        type Data = super::Snapshot;
    }
    impl DurableEventType for Changed {
        const VERSION: i64 = 1;
        const AGGREGATE: &'static str = "groupID";
    }

    pub struct Deleted;
    impl EventType for Deleted {
        const TYPE: &'static str = "coordination.group.deleted";
        type Data = super::GroupRevision;
    }
    impl DurableEventType for Deleted {
        const VERSION: i64 = 1;
        const AGGREGATE: &'static str = "groupID";
    }

    pub struct OwnerChanged;
    impl EventType for OwnerChanged {
        const TYPE: &'static str = "coordination.member.owner.changed";
        type Data = super::OwnerChangedData;
    }
    impl DurableEventType for OwnerChanged {
        const VERSION: i64 = 1;
        const AGGREGATE: &'static str = "groupID";
    }

    pub struct Updated;
    impl EventType for Updated {
        const TYPE: &'static str = "coordination.updated";
        type Data = super::UpdatedData;
    }

    pub struct RequestEscalated;
    impl EventType for RequestEscalated {
        const TYPE: &'static str = "coordination.request.escalated";
        type Data = super::RequestEscalatedData;
    }
}
