use super::{
    Error, Role, Scope, Service, can_act,
    runtime::{
        Decision, DecisionActor, DecisionEscalateInput, DecisionEscalateResult, DecisionOutcome,
        DecisionResult, Decisions, Delegation, EscalateOutcome, EscalationTarget, EvaluateInput,
        Future, Pending, PendingInput, RequestDetail, RequestField,
    },
};
use crate::{
    process::guardrails::{Guardrails, redact_value},
    tools::policy::{forms::Forms, permissions::Permissions, wildcard},
};
use std::{
    collections::{BTreeSet, VecDeque},
    future::Future as StdFuture,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, coordination as c, form,
    guardrail, permission, session, session_review,
};

const READ_ACTIONS: [&str; 6] = [
    "read",
    "glob",
    "grep",
    "webfetch",
    "websearch",
    "browser_read",
];
const LOCAL_WRITE_ACTIONS: [&str; 4] = ["edit", "write", "patch", "file_mutation"];
const READ_SHELL: [&str; 12] = [
    "cat", "ls", "pwd", "grep", "rg", "find", "stat", "head", "tail", "wc", "test", "git",
];
const MAX_PENDING_LIMIT: usize = 50;
const DEFAULT_PENDING_LIMIT: usize = 20;
const MAX_RATIONALE: usize = 500;
const MIN_ANSWER_CONFIDENCE: f64 = 0.8;

pub type Settings = Arc<dyn Fn() -> Future<'static, c::Settings> + Send + Sync>;
pub type Locate = Arc<dyn Fn(session::Id) -> Future<'static, Option<Services>> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Current = Arc<dyn Fn() -> bool + Send + Sync>;
pub type Check<T> = Arc<dyn Fn(T) -> Pin<Box<dyn StdFuture<Output = bool> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct Services {
    pub permissions: Permissions,
    pub forms: Forms,
    pub guardrails: Guardrails,
    pub lease: Arc<dyn Send + Sync>,
    pub is_current: Current,
}

pub struct Options {
    pub coordination: Service,
    pub settings: Settings,
    pub services: Locate,
    pub now: Option<Clock>,
}

#[derive(Clone, Debug)]
pub struct Source {
    pub coordinator_session_id: session::Id,
    pub group_id: Option<LosslessString>,
    pub rationale: LosslessString,
}

impl Source {
    pub fn reply_source(
        &self,
        via: &str,
        confidence: Option<f64>,
    ) -> Result<form::ReplySource, Error> {
        Ok(form::ReplySource::decode(
            &ObjectEncoder::new()
                .field("kind", "coordinator")
                .field("coordinatorSessionID", &self.coordinator_session_id)
                .optional("groupID", &self.group_id)
                .field("via", via)
                .optional("confidence", &confidence)
                .field("rationale", &self.rationale)
                .finish(),
        )?)
    }
}

#[derive(Clone)]
pub struct Gate<T> {
    pub validate: Check<T>,
    pub current: Current,
}

#[derive(Clone)]
pub struct Reconsider<T> {
    pub fingerprint: LosslessString,
    pub source: Source,
    pub decision: Option<Decision>,
    pub answer: Option<form::Answer>,
    pub confidence: Option<f64>,
    pub gate: Gate<T>,
}

#[derive(Clone, Debug)]
pub struct Reconsidered {
    pub outcome: DecisionOutcome,
    pub fingerprint: LosslessString,
    pub settled: bool,
    pub via: Option<&'static str>,
    pub confidence: Option<f64>,
    pub source: Option<form::ReplySource>,
    pub reason: Option<LosslessString>,
}

impl Reconsidered {
    pub fn stale(fingerprint: &LosslessString) -> Self {
        Self {
            outcome: DecisionOutcome::Stale,
            fingerprint: fingerprint.clone(),
            settled: false,
            via: None,
            confidence: None,
            source: None,
            reason: None,
        }
    }
    pub fn escalated(fingerprint: &LosslessString, reason: impl Into<LosslessString>) -> Self {
        Self {
            outcome: DecisionOutcome::Escalated,
            reason: Some(reason.into()),
            ..Self::stale(fingerprint)
        }
    }
    pub fn settled(
        fingerprint: &LosslessString,
        outcome: DecisionOutcome,
        via: &'static str,
    ) -> Self {
        Self {
            outcome,
            settled: true,
            via: Some(via),
            ..Self::stale(fingerprint)
        }
    }
    pub fn via(mut self, via: &'static str) -> Self {
        self.via = Some(via);
        self
    }
    fn into_decision(
        self,
        kind: c::RequestKind,
        request_id: &LosslessString,
        rationale: &LosslessString,
    ) -> DecisionResult {
        DecisionResult {
            outcome: self.outcome,
            kind,
            request_id: request_id.clone(),
            fingerprint: self.fingerprint,
            actor: DecisionActor::Coordinator,
            settled: self.settled,
            via: self.via.map(LosslessString::from),
            confidence: self.confidence,
            source: self.source,
            rationale: Some(rationale.clone()),
            reason: self.reason,
        }
    }
}

#[derive(Clone)]
pub struct EscalateRequest {
    pub session_id: session::Id,
    pub fingerprint: LosslessString,
    pub source: Source,
    pub handoff: bool,
    pub current: Current,
}

#[derive(Clone, Debug, Default)]
pub struct Escalated {
    pub stale: bool,
    pub coordination_escalation: Option<c::Escalation>,
    pub reason: Option<&'static str>,
    pub review_item_id: Option<LosslessString>,
}

impl Escalated {
    pub fn stale() -> Self {
        Self {
            stale: true,
            ..Self::default()
        }
    }
    pub fn appended(appended: Appended) -> Self {
        match appended {
            Appended::Added(value) | Appended::Unchanged(value) => Self {
                coordination_escalation: Some(value),
                ..Self::default()
            },
            Appended::Full(value) => Self {
                coordination_escalation: Some(value),
                reason: Some("escalation-chain-full"),
                ..Self::default()
            },
        }
    }
    pub fn deferred(item_id: &session_review::Id, escalation: Option<c::Escalation>) -> Self {
        Self {
            coordination_escalation: escalation,
            reason: Some("deferred-to-review-box"),
            review_item_id: Some(id_text(item_id)),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug)]
pub enum Appended {
    Added(c::Escalation),
    Unchanged(c::Escalation),
    Full(c::Escalation),
}

pub fn append(current: Option<&c::Escalation>, source: &Source) -> Appended {
    let reasons = current.map_or(&[][..], |current| current.reasons.as_slice());
    if let Some(current) = current
        && reasons.iter().any(|item| {
            item.session_id == source.coordinator_session_id && item.reason == source.rationale
        })
    {
        return Appended::Unchanged(current.clone());
    }
    if let Some(current) = current
        && reasons.len() >= c::MAX_ESCALATION_REASONS
    {
        return Appended::Full(current.clone());
    }
    let mut reasons = reasons.to_vec();
    reasons.push(c::EscalationReason {
        session_id: source.coordinator_session_id.clone(),
        reason: source.rationale.clone(),
    });
    Appended::Added(c::Escalation { reasons })
}

pub fn deferred_review(
    reviews: &crate::tools::policy::Reviews,
    session: &session::Id,
    matches: impl Fn(&session_review::Payload) -> Option<Option<c::Escalation>>,
) -> Option<Escalated> {
    reviews
        .service
        .list(session)
        .ok()?
        .into_iter()
        .filter(|item| &item.session_id == session)
        .find_map(|item| {
            matches(&item.deferral.payload)
                .map(|escalation| Escalated::deferred(&item.deferral.item_id, escalation))
        })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PriorSource {
    Explicit,
    Review,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PriorStatus {
    Pending,
    Rejected,
    Approved,
    ApprovedUsed,
    Withdrawn,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Prior {
    pub source: PriorSource,
    pub status: PriorStatus,
}

impl Prior {
    pub fn explicit_rejection() -> Self {
        Self {
            source: PriorSource::Explicit,
            status: PriorStatus::Rejected,
        }
    }
    fn encode(self) -> JsonValue {
        ObjectEncoder::new()
            .field(
                "source",
                match self.source {
                    PriorSource::Explicit => "explicit",
                    PriorSource::Review => "review",
                },
            )
            .field(
                "status",
                match self.status {
                    PriorStatus::Pending => "pending",
                    PriorStatus::Rejected => "rejected",
                    PriorStatus::Approved => "approved",
                    PriorStatus::ApprovedUsed => "approved-used",
                    PriorStatus::Withdrawn => "withdrawn",
                },
            )
            .finish()
    }
}

pub fn explicit_rejected(prior: &[Prior]) -> bool {
    prior
        .iter()
        .any(|item| item.source == PriorSource::Explicit && item.status == PriorStatus::Rejected)
        || prior
            .iter()
            .rev()
            .find(|item| {
                matches!(
                    item.status,
                    PriorStatus::Rejected | PriorStatus::Approved | PriorStatus::ApprovedUsed
                )
            })
            .is_some_and(|item| item.status == PriorStatus::Rejected)
}

fn review_status(item: &crate::session::review_fold::Folded) -> PriorStatus {
    if item.withdrawn.is_some() {
        return PriorStatus::Withdrawn;
    }
    let Some(decision) = &item.decision else {
        return PriorStatus::Pending;
    };
    let rejected = match decision {
        session_review::Decision::Guardrail { reply } => *reply == guardrail::Reply::Reject,
        session_review::Decision::Permission { reply } => reply.0.as_str() == Some("reject"),
        _ => false,
    };
    if rejected {
        PriorStatus::Rejected
    } else if item.consumed {
        PriorStatus::ApprovedUsed
    } else {
        PriorStatus::Approved
    }
}

pub fn permission_matches(payload: &session_review::Payload, expected: &LosslessString) -> bool {
    matches!(payload, session_review::Payload::Permission(payload)
        if payload.fingerprint.as_lossless() == expected)
}

pub fn guardrail_matches(payload: &session_review::Payload, expected: &LosslessString) -> bool {
    matches!(payload, session_review::Payload::Guardrail(payload)
        if payload.fingerprint.as_lossless() == expected)
}

pub fn reviewed(
    snapshot: &ycoding_store::Snapshot,
    session: &session::Id,
    kind: session_review::Kind,
    matches: impl Fn(&session_review::Payload) -> bool,
) -> Result<Vec<Prior>, Error> {
    let mut items = crate::session::review_fold::fold(snapshot, &[session.as_lossless().clone()])?
        .into_iter()
        .filter(|item| item.deferral.kind == kind && matches(&item.deferral.payload))
        .collect::<Vec<_>>();
    items.sort_by_key(|item| item.created);
    Ok(items[items.len().saturating_sub(5)..]
        .iter()
        .map(|item| Prior {
            source: PriorSource::Review,
            status: review_status(item),
        })
        .collect())
}

#[derive(Clone, Debug)]
pub struct Applicability {
    value: JsonValue,
    prior: Vec<Prior>,
}

impl Applicability {
    pub fn new(gate: &str, fields: Vec<(&str, JsonValue)>, prior: Vec<Prior>) -> Self {
        let mut value = ycoding_schema::JsonObject::new();
        value.insert("gate".into(), JsonValue::String(gate.into()));
        for (name, field) in fields {
            value.insert(name.into(), field);
        }
        value.insert(
            "prior".into(),
            JsonValue::Array(prior.iter().map(|item| item.encode()).collect()),
        );
        Self {
            value: JsonValue::Object(value),
            prior,
        }
    }
    pub fn value(&self) -> &JsonValue {
        &self.value
    }
    pub fn digest(&self) -> String {
        crate::session::prompt_cache::sha256(&crate::session::prompt_cache::canonical_json(
            &self.value,
        ))
    }
    pub fn rejected(&self) -> bool {
        explicit_rejected(&self.prior)
    }
}

const MAX_REJECTIONS: usize = 512;

#[derive(Default)]
pub struct Rejections(Mutex<VecDeque<String>>);

impl Rejections {
    pub fn key(session: &session::Id, fingerprint: &LosslessString) -> String {
        format!(
            "{}\0{}",
            readable(session.as_lossless()),
            readable(fingerprint)
        )
    }
    pub fn record(&self, key: String, rejected: bool) {
        let mut keys = self.0.lock().unwrap_or_else(|error| error.into_inner());
        keys.retain(|item| item != &key);
        if rejected {
            keys.push_back(key);
            if keys.len() > MAX_REJECTIONS {
                keys.pop_front();
            }
        }
    }
    pub fn contains(&self, key: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .any(|item| item == key)
    }
    pub fn prior(&self, key: &str) -> Option<Prior> {
        self.contains(key).then(Prior::explicit_rejection)
    }
}

pub struct Claim<K: Ord + Clone> {
    set: Arc<Mutex<BTreeSet<K>>>,
    key: K,
}

impl<K: Ord + Clone> Claim<K> {
    pub fn acquire(set: &Arc<Mutex<BTreeSet<K>>>, key: K) -> Option<Self> {
        set.lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key.clone())
            .then(|| Self {
                set: set.clone(),
                key,
            })
    }
}

impl<K: Ord + Clone> Drop for Claim<K> {
    fn drop(&mut self) {
        self.set
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.key);
    }
}

#[derive(Clone, Debug)]
pub struct Snapshot<T> {
    pub order: u64,
    pub request: T,
    pub fingerprint: LosslessString,
}

pub fn id_text(value: &impl DomainEncode) -> LosslessString {
    match value.encode() {
        JsonValue::String(text) => text,
        _ => LosslessString::default(),
    }
}

pub fn coordination_decline_feedback(
    guardrail: bool,
    rationale: &LosslessString,
) -> LosslessString {
    format!(
        "Project coordination, not a human decision, declined this {}. Reason: {}. Do not retry it unchanged. Choose an alternative within your assignment, or report the blocker.",
        if guardrail { "action" } else { "request" },
        ycoding_schema::stringify_json(&rationale.encode())
    )
    .into()
}

pub fn denied_feedback(guardrail: bool, escalation: &guardrail::Escalation) -> LosslessString {
    let gate = if guardrail { "guardrail" } else { "permission" };
    let evidence = escalation
        .grades
        .iter()
        .flatten()
        .find(|grade| grade.choice.encode() == JsonValue::String("deny".into()))
        .map(|grade| {
            format!(
                "Assessment evidence: {}. ",
                ycoding_schema::stringify_json(&grade.evidence.encode())
            )
        })
        .unwrap_or_default();
    format!(
        "Automated {gate} assessment, not a human decision, denied this {}. {evidence}Do not retry it unchanged. Choose an alternative the user's instructions and current rules permit, such as a narrower target, or ask the user.",
        if guardrail { "action" } else { "request" }
    )
    .into()
}

fn readable(text: &LosslessString) -> String {
    String::from_utf16_lossy(&text.code_units().collect::<Vec<_>>())
}

fn simple_read_only_shell(command: &str) -> bool {
    let value = command.trim();
    if value.is_empty()
        || value.contains(|character| {
            matches!(
                character,
                ';' | '|' | '&' | '<' | '>' | '`' | '$' | '\\' | '\n' | '\r'
            )
        })
    {
        return false;
    }
    let tokens = value.split_whitespace().collect::<Vec<_>>();
    let Some(first) = tokens
        .first()
        .map(|token| token.rsplit('/').next().unwrap_or(token))
    else {
        return false;
    };
    if !READ_SHELL.contains(&first) {
        return false;
    }
    if tokens.iter().any(|token| {
        matches!(
            *token,
            "-delete" | "-exec" | "-execdir" | "--pre" | "--output" | "-o"
        )
    }) {
        return false;
    }
    if first == "git" {
        return matches!(
            tokens.get(1).copied(),
            Some("status" | "diff" | "log" | "show" | "rev-parse" | "ls-files")
        );
    }
    if first == "find" {
        return !tokens
            .iter()
            .any(|token| token.starts_with("-delete") || token.starts_with("-exec"));
    }
    true
}

pub fn routine_eligible(kind: c::RequestKind, action: &str, resources: &[LosslessString]) -> bool {
    if kind == c::RequestKind::Question {
        return true;
    }
    if READ_ACTIONS.contains(&action) || LOCAL_WRITE_ACTIONS.contains(&action) {
        return true;
    }
    action == "shell"
        && !resources.is_empty()
        && resources
            .iter()
            .all(|resource| simple_read_only_shell(&readable(resource)))
}

pub fn coordinator_routine(
    kind: c::RequestKind,
    action: &str,
    resources: &[LosslessString],
) -> bool {
    action == "shell" || routine_eligible(kind, action, resources)
}

fn trimmed(text: &LosslessString) -> LosslessString {
    let space = |unit: &u16| {
        matches!(
            *unit,
            9..=13
                | 32
                | 160
                | 5760
                | 8192..=8202
                | 8232
                | 8233
                | 8239
                | 8287
                | 12288
                | 65279
        )
    };
    let units = text.code_units().collect::<Vec<_>>();
    let start = units
        .iter()
        .position(|unit| !space(unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !space(unit))
        .map_or(start, |end| end + 1);
    LosslessString::from_utf16(units[start..end].to_vec())
}

fn bounded(text: &LosslessString, limit: usize) -> LosslessString {
    match redact_value(&JsonValue::String(text.clone())) {
        JsonValue::String(redacted) => {
            LosslessString::from_utf16(redacted.code_units().take(limit).collect())
        }
        _ => LosslessString::default(),
    }
}

fn bounded_resources(resources: &[LosslessString]) -> Vec<LosslessString> {
    resources
        .iter()
        .take(20)
        .map(|resource| bounded(resource, 500))
        .collect()
}

fn session_matches(left: &LosslessString, right: &session::Id) -> bool {
    left == right.as_lossless()
}

fn family_of(target: &session::Id, descendants: &[session::Id]) -> Vec<session::Id> {
    std::iter::once(target.clone())
        .chain(descendants.iter().cloned())
        .collect()
}

fn origin(target: &session::Id, requesting: &LosslessString) -> Option<session::Id> {
    (!session_matches(requesting, target))
        .then(|| session::Id::new(requesting.clone()).ok())
        .flatten()
}

struct Context {
    group_id: c::GroupId,
    coordinator: session::Id,
    target: session::Id,
    kind: c::RequestKind,
}

struct Inner {
    coordination: Service,
    settings: Settings,
    services: Locate,
    clock: Option<Clock>,
}

#[derive(Clone)]
pub struct CoordinationDecisions(Arc<Inner>);

impl CoordinationDecisions {
    pub fn new(options: Options) -> Self {
        Self(Arc::new(Inner {
            coordination: options.coordination,
            settings: options.settings,
            services: options.services,
            clock: options.now,
        }))
    }
}

impl Decisions for CoordinationDecisions {
    fn settings(&self) -> Future<'_, c::Settings> {
        (self.0.settings)()
    }
    fn pending(&self, input: PendingInput) -> Future<'_, Vec<Pending>> {
        Box::pin(self.0.pending(input))
    }
    fn evaluate(&self, input: EvaluateInput) -> Future<'_, DecisionResult> {
        Box::pin(self.0.evaluate(input))
    }
    fn escalate(&self, input: DecisionEscalateInput) -> Future<'_, DecisionEscalateResult> {
        Box::pin(self.0.escalate(input))
    }
}

struct Authorization<'a> {
    group_id: &'a c::GroupId,
    coordinator: &'a session::Id,
    target: &'a session::Id,
}

fn unmet(reason: &'static str) -> Result<Scope, &'static str> {
    Err(reason)
}

impl Inner {
    fn now(&self) -> i64 {
        self.clock.as_ref().map_or_else(
            || {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock after epoch")
                    .as_millis() as i64
            },
            |clock| clock(),
        )
    }

    fn authorize(
        &self,
        input: &Authorization<'_>,
        inspect_master: bool,
    ) -> Result<Result<Scope, &'static str>, Error> {
        let Some(access) = self.coordination.access_of(input.coordinator)? else {
            return Ok(unmet("delegation-unavailable"));
        };
        if access.role == Role::Executor || &access.scope.group_id != input.group_id {
            return Ok(unmet("delegation-unavailable"));
        }
        let master_read = inspect_master
            && access.role == Role::Master
            && input.target == &access.scope.master_session_id;
        if !master_read
            && (!access.scope.member_session_ids.contains(input.target)
                || input.coordinator == input.target
                || !can_act(&access, input.target))
        {
            return Ok(unmet("delegation-out-of-scope"));
        }
        Ok(Ok(access.scope))
    }

    async fn permits(
        &self,
        context: &Context,
        action: &str,
        resources: &[LosslessString],
    ) -> Result<Option<&'static str>, Error> {
        let scope = match self.authorize(
            &Authorization {
                group_id: &context.group_id,
                coordinator: &context.coordinator,
                target: &context.target,
            },
            false,
        )? {
            Ok(scope) => scope,
            Err(reason) => return Ok(Some(reason)),
        };
        let settings = (self.settings)().await?;
        if !settings.enabled {
            return Ok(Some("delegation-revoked"));
        }
        let now = self.now();
        let group = scope.settings.delegated_decisions.as_ref();
        let expired = |at: Option<&ycoding_schema::schema::NonNegativeInt>| {
            at.is_some_and(|at| at.get() <= now)
        };
        if expired(settings.expires_at.as_ref())
            || expired(group.and_then(|group| group.expires_at.as_ref()))
        {
            return Ok(Some("delegation-expired"));
        }
        let action_text = LosslessString::from(action);
        let covers = |categories: &[c::RequestKind],
                      actions: Option<&Vec<LosslessString>>,
                      patterns: Option<&Vec<LosslessString>>| {
            categories.contains(&context.kind)
                && actions.is_none_or(|actions| {
                    actions
                        .iter()
                        .any(|pattern| wildcard(&action_text, pattern))
                })
                && patterns.is_none_or(|patterns| {
                    resources
                        .iter()
                        .all(|resource| patterns.iter().any(|pattern| wildcard(resource, pattern)))
                })
        };
        let permitted = covers(
            &settings.categories,
            settings.actions.as_ref(),
            settings.resources.as_ref(),
        ) && group.is_none_or(|group| {
            covers(
                &group.categories,
                group.actions.as_ref(),
                group.resources.as_ref(),
            )
        });
        Ok((!permitted).then_some("delegation-out-of-scope"))
    }

    async fn pending(self: &Arc<Self>, input: PendingInput) -> Result<Vec<Pending>, Error> {
        if self
            .authorize(
                &Authorization {
                    group_id: &input.group_id,
                    coordinator: &input.coordinator_session_id,
                    target: &input.target_session_id,
                },
                true,
            )?
            .is_err()
        {
            return Ok(vec![]);
        }
        let limit = input
            .limit
            .unwrap_or(DEFAULT_PENDING_LIMIT)
            .clamp(1, MAX_PENDING_LIMIT);
        let Some(services) = (self.services)(input.target_session_id.clone()).await? else {
            return Ok(vec![]);
        };
        let _lease = services.lease.clone();
        if !(services.is_current)() {
            return Err(Error::refused(
                "Project decisions are unavailable for this Location",
            ));
        }
        let target = &input.target_session_id;
        let family = family_of(target, &input.descendant_session_ids);
        let mut items = services
            .permissions
            .snapshots_in(&family, limit)
            .iter()
            .map(|snapshot| permission_pending(snapshot, target))
            .collect::<Vec<_>>();
        for snapshot in services
            .guardrails
            .request_snapshots_in(target, &family, limit)?
        {
            items.push(review_pending(&snapshot, target)?);
        }
        for snapshot in services.forms.snapshots_in(&family, limit) {
            items.push(question_pending(&snapshot, target));
        }
        items.truncate(limit);
        Ok(items)
    }

    async fn evaluate(self: &Arc<Self>, input: EvaluateInput) -> Result<DecisionResult, Error> {
        let result = |outcome: DecisionOutcome, reason: Option<&str>| DecisionResult {
            outcome,
            kind: input.kind,
            request_id: input.request_id.clone(),
            fingerprint: input.fingerprint.clone(),
            actor: DecisionActor::Coordinator,
            settled: false,
            via: None,
            confidence: None,
            source: None,
            rationale: Some(input.rationale.clone()),
            reason: reason.map(LosslessString::from),
        };
        let escalated = |reason: &str| Ok(result(DecisionOutcome::Escalated, Some(reason)));
        let stale = || Ok(result(DecisionOutcome::Stale, None));
        let authorization = Authorization {
            group_id: &input.group_id,
            coordinator: &input.coordinator_session_id,
            target: &input.target_session_id,
        };
        if let Err(reason) = self.authorize(&authorization, false)? {
            return escalated(reason);
        }
        let rationale = trimmed(&input.rationale);
        if rationale.is_empty() || rationale.len() > MAX_RATIONALE {
            return escalated("rationale-required");
        }
        if input.answer.is_some() && input.kind != c::RequestKind::Question {
            return escalated("invalid-answer");
        }
        if input.decision.is_some() && input.kind == c::RequestKind::Question {
            return escalated("invalid-decision");
        }
        if input.kind == c::RequestKind::Question
            && input.answer.is_some()
            && input.confidence.is_some_and(|confidence| {
                !confidence.is_finite() || confidence < MIN_ANSWER_CONFIDENCE
            })
        {
            return escalated("low-confidence");
        }
        let Some(services) = (self.services)(input.target_session_id.clone()).await? else {
            return stale();
        };
        let _lease = services.lease.clone();
        if !(services.is_current)() {
            return escalated("delegation-unavailable");
        }
        let context = Arc::new(Context {
            group_id: input.group_id.clone(),
            coordinator: input.coordinator_session_id.clone(),
            target: input.target_session_id.clone(),
            kind: input.kind,
        });
        let source = Source {
            coordinator_session_id: input.coordinator_session_id.clone(),
            group_id: Some(input.group_id.as_lossless().clone()),
            rationale,
        };
        fn reconsider<T>(input: &EvaluateInput, source: &Source, gate: Gate<T>) -> Reconsider<T> {
            Reconsider {
                fingerprint: input.fingerprint.clone(),
                source: source.clone(),
                decision: (input.kind != c::RequestKind::Question)
                    .then(|| input.decision.unwrap_or(Decision::Approve)),
                answer: input.answer.clone(),
                confidence: input.confidence,
                gate,
            }
        }
        fn settles<T: Send + 'static>(
            inner: &Arc<Inner>,
            context: &Arc<Context>,
            current: &Current,
            subject: fn(&T) -> (String, Vec<LosslessString>),
        ) -> Gate<T> {
            let inner = inner.clone();
            let context = context.clone();
            Gate {
                validate: Arc::new(
                    move |request: T| -> Pin<Box<dyn StdFuture<Output = bool> + Send>> {
                        let inner = inner.clone();
                        let context = context.clone();
                        let (action, resources) = subject(&request);
                        Box::pin(async move {
                            matches!(inner.permits(&context, &action, &resources).await, Ok(None))
                        })
                    },
                ),
                current: current.clone(),
            }
        }
        let target = &input.target_session_id;
        let family = family_of(target, &input.descendant_session_ids);
        let id = JsonValue::String(input.request_id.clone());

        if input.kind == c::RequestKind::Permission {
            let Ok(id) = permission::Id::decode(&id) else {
                return stale();
            };
            let Some(snapshot) = services.permissions.snapshot(&id) else {
                return stale();
            };
            let request = &snapshot.request;
            if !family.contains(&request.session_id) || snapshot.fingerprint != input.fingerprint {
                return stale();
            }
            let action = readable(&request.action);
            if let Some(reason) = self.permits(&context, &action, &request.resources).await? {
                return escalated(reason);
            }
            let gate = settles(
                self,
                &context,
                &services.is_current,
                |request: &permission::Request| {
                    (readable(&request.action), request.resources.clone())
                },
            );
            let settled = services
                .permissions
                .reconsider(&id, reconsider(&input, &source, gate))
                .await?;
            return Ok(settled.into_decision(input.kind, &input.request_id, &input.rationale));
        }

        if input.kind == c::RequestKind::Review {
            let Ok(id) = guardrail::RequestId::decode(&id) else {
                return stale();
            };
            let Some(snapshot) = services
                .guardrails
                .request_snapshot_in(target, &id, &family)?
            else {
                return stale();
            };
            if snapshot.fingerprint != input.fingerprint {
                return stale();
            }
            let request = &snapshot.request;
            let action = readable(&request.action);
            if let Some(reason) = self.permits(&context, &action, &request.resources).await? {
                return escalated(reason);
            }
            let gate = settles(
                self,
                &context,
                &services.is_current,
                |request: &guardrail::Request| {
                    (readable(&request.action), request.resources.clone())
                },
            );
            let settled = services
                .guardrails
                .reconsider(&request.session_id, &id, reconsider(&input, &source, gate))
                .await?;
            return Ok(settled.into_decision(input.kind, &input.request_id, &input.rationale));
        }

        let Ok(id) = form::Id::decode(&id) else {
            return stale();
        };
        let Some(snapshot) = services.forms.snapshot(&id) else {
            return stale();
        };
        if !family
            .iter()
            .any(|member| session_matches(&snapshot.request.session_id, member))
            || snapshot.fingerprint != input.fingerprint
        {
            return stale();
        }
        if let Some(reason) = self.permits(&context, "question", &[]).await? {
            return escalated(reason);
        }
        let gate = settles(self, &context, &services.is_current, |_: &form::Info| {
            ("question".to_owned(), vec![])
        });
        let settled = services
            .forms
            .reconsider(&id, reconsider(&input, &source, gate))
            .await?;
        Ok(settled.into_decision(input.kind, &input.request_id, &input.rationale))
    }

    async fn escalate(
        self: &Arc<Self>,
        input: DecisionEscalateInput,
    ) -> Result<DecisionEscalateResult, Error> {
        let base = |outcome: EscalateOutcome, reason: Option<&str>| DecisionEscalateResult {
            outcome,
            kind: input.kind,
            request_id: input.request_id.clone(),
            fingerprint: input.fingerprint.clone(),
            actor: DecisionActor::Coordinator,
            settled: false,
            to: None,
            coordination_escalation: None,
            reason: reason.map(LosslessString::from),
            review_item_id: None,
            request_session_id: None,
        };
        let reason = trimmed(&input.reason);
        if reason.is_empty() || reason.len() > MAX_RATIONALE {
            return Ok(base(EscalateOutcome::Escalated, Some("rationale-required")));
        }
        let scope = match self.authorize(
            &Authorization {
                group_id: &input.group_id,
                coordinator: &input.coordinator_session_id,
                target: &input.target_session_id,
            },
            false,
        )? {
            Ok(scope) => scope,
            Err(reason) => return Ok(base(EscalateOutcome::Escalated, Some(reason))),
        };
        let Some(services) = (self.services)(input.target_session_id.clone()).await? else {
            return Ok(base(EscalateOutcome::Stale, None));
        };
        let _lease = services.lease.clone();
        if !(services.is_current)() {
            return Ok(base(EscalateOutcome::Stale, None));
        }
        let handoff = input.coordinator_session_id == scope.master_session_id;
        let target = &input.target_session_id;
        let family = family_of(target, &input.descendant_session_ids);
        let id = JsonValue::String(input.request_id.clone());
        let requesting = match input.kind {
            c::RequestKind::Permission => match permission::Id::decode(&id)
                .ok()
                .and_then(|id| services.permissions.snapshot(&id))
            {
                Some(snapshot) if !family.contains(&snapshot.request.session_id) => {
                    return Ok(base(EscalateOutcome::Stale, None));
                }
                Some(snapshot) => snapshot.request.session_id,
                None => target.clone(),
            },
            c::RequestKind::Review => match guardrail::RequestId::decode(&id)
                .ok()
                .map(|id| {
                    services
                        .guardrails
                        .request_snapshot_in(target, &id, &family)
                })
                .transpose()?
                .flatten()
            {
                Some(snapshot) => snapshot.request.session_id,
                None => target.clone(),
            },
            c::RequestKind::Question => match form::Id::decode(&id)
                .ok()
                .and_then(|id| services.forms.snapshot(&id))
                .and_then(|snapshot| {
                    family
                        .iter()
                        .find(|member| session_matches(&snapshot.request.session_id, member))
                        .cloned()
                }) {
                Some(session) => session,
                None => return Ok(base(EscalateOutcome::Stale, None)),
            },
        };
        let request = EscalateRequest {
            session_id: requesting.clone(),
            fingerprint: input.fingerprint.clone(),
            source: Source {
                coordinator_session_id: input.coordinator_session_id.clone(),
                group_id: Some(input.group_id.as_lossless().clone()),
                rationale: reason,
            },
            handoff,
            current: services.is_current.clone(),
        };
        let native = match input.kind {
            c::RequestKind::Permission => match permission::Id::decode(&id) {
                Ok(id) => services.permissions.escalate(&id, request)?,
                Err(_) => Escalated::stale(),
            },
            c::RequestKind::Review => match guardrail::RequestId::decode(&id) {
                Ok(id) => services.guardrails.escalate(&id, request)?,
                Err(_) => Escalated::stale(),
            },
            c::RequestKind::Question => match form::Id::decode(&id) {
                Ok(id) => services.forms.escalate(&id, request)?,
                Err(_) => Escalated::stale(),
            },
        };
        if native.stale {
            return Ok(base(EscalateOutcome::Stale, None));
        }
        let mut result = base(EscalateOutcome::Escalated, native.reason);
        if native.reason.is_none() {
            result.to = Some(if handoff {
                EscalationTarget::Client
            } else {
                EscalationTarget::Master
            });
        }
        result.coordination_escalation = native.coordination_escalation;
        result.review_item_id = native.review_item_id;
        result.request_session_id = (&requesting != target).then_some(requesting);
        Ok(result)
    }
}

fn permission_pending(snapshot: &Snapshot<permission::Request>, target: &session::Id) -> Pending {
    let request = &snapshot.request;
    let request_session_id = origin(target, request.session_id.as_lossless());
    let action = readable(&request.action);
    let routine = coordinator_routine(c::RequestKind::Permission, &action, &request.resources);
    let request_id = id_text(&request.id);
    let summary = std::iter::once(action.clone())
        .chain(request.resources.iter().map(readable))
        .collect::<Vec<_>>()
        .join(" ");
    Pending {
        summary: c::PendingRequest {
            kind: c::RequestKind::Permission,
            request_id: request_id.clone(),
            fingerprint: snapshot.fingerprint.clone(),
            summary: bounded(&summary.into(), 500),
            request_session_id: request_session_id.clone(),
        },
        detail: RequestDetail::Permission {
            request_id,
            fingerprint: snapshot.fingerprint.clone(),
            action: request.action.clone(),
            resources: bounded_resources(&request.resources),
            delegation: if routine {
                Delegation::Routine
            } else {
                Delegation::DeclineOnly
            },
            coordination_escalation: crate::process::guardrails::redacted_escalation(
                request.coordination_escalation.as_ref(),
            ),
            request_session_id,
        },
    }
}

fn review_pending(
    snapshot: &Snapshot<guardrail::Request>,
    target: &session::Id,
) -> Result<Pending, Error> {
    let request = &snapshot.request;
    let request_session_id = origin(target, request.session_id.as_lossless());
    let action = readable(&request.action);
    let routine = coordinator_routine(c::RequestKind::Review, &action, &request.resources);
    let request_id = id_text(&request.id);
    let summary = format!(
        "{action} {}: {}",
        request
            .resources
            .iter()
            .map(readable)
            .collect::<Vec<_>>()
            .join(" "),
        readable(&request.reason)
    );
    Ok(Pending {
        summary: c::PendingRequest {
            kind: c::RequestKind::Review,
            request_id: request_id.clone(),
            fingerprint: snapshot.fingerprint.clone(),
            summary: bounded(&summary.into(), 500),
            request_session_id: request_session_id.clone(),
        },
        detail: RequestDetail::Review {
            request_id,
            fingerprint: snapshot.fingerprint.clone(),
            action: request.action.clone(),
            resources: bounded_resources(&request.resources),
            rule_ids: request.rule_ids.iter().take(20).cloned().collect(),
            reason: bounded(&request.reason, 500),
            hard_review: request.hard_review == Some(true),
            standard: request.standard,
            delegation: if routine {
                Delegation::Routine
            } else {
                Delegation::DeclineOnly
            },
            coordination_escalation: crate::process::guardrails::redacted_escalation(
                request.coordination_escalation.as_ref(),
            ),
            request_session_id,
        },
    })
}

fn question_pending(snapshot: &Snapshot<form::Info>, target: &session::Id) -> Pending {
    let form = &snapshot.request;
    let request_session_id = origin(target, &form.session_id);
    let request_id = id_text(&form.id);
    let fields = match form.fields.encode() {
        JsonValue::Array(fields) => fields,
        _ => vec![],
    };
    let text_of = |value: Option<&JsonValue>| match value {
        Some(JsonValue::String(text)) => Some(text.clone()),
        _ => None,
    };
    let fields = fields
        .iter()
        .take(20)
        .filter_map(|field| {
            let JsonValue::Object(field) = field else {
                return None;
            };
            Some(RequestField {
                key: text_of(field.get(&"key".into()))?,
                type_: text_of(field.get(&"type".into()))?,
                title: text_of(field.get(&"title".into())).map(|title| bounded(&title, 200)),
                required: match field.get(&"required".into()) {
                    Some(JsonValue::Bool(required)) => Some(*required),
                    _ => None,
                },
                options: match field.get(&"options".into()) {
                    Some(JsonValue::Array(options)) => Some(
                        options
                            .iter()
                            .take(20)
                            .filter_map(|option| match option {
                                JsonValue::String(value) => Some(bounded(value, 200)),
                                JsonValue::Object(option) => text_of(option.get(&"value".into()))
                                    .map(|value| bounded(&value, 200)),
                                _ => None,
                            })
                            .collect(),
                    ),
                    _ => None,
                },
            })
        })
        .collect();
    Pending {
        summary: c::PendingRequest {
            kind: c::RequestKind::Question,
            request_id: request_id.clone(),
            fingerprint: snapshot.fingerprint.clone(),
            summary: bounded(&form.title, 500),
            request_session_id: request_session_id.clone(),
        },
        detail: RequestDetail::Question {
            request_id,
            fingerprint: snapshot.fingerprint.clone(),
            title: bounded(&form.title, 500),
            fields,
            delegation: Delegation::Routine,
            coordination_escalation: crate::process::guardrails::redacted_escalation(
                form.coordination_escalation.as_ref(),
            ),
            request_session_id,
        },
    }
}
