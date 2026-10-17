use super::{
    family, key, pending, projector,
    prompt_cache::sha256,
    revert,
    review_fold::{self, CONSUMED, DECIDED, DEFERRED, Fence, Folded},
    store,
};
use crate::{
    model_incident::record::GuardrailInput,
    tools::policy::{forms, state::decode_id},
};
use std::{future::Future, ops::Bound, pin::Pin, sync::Arc};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, ObjectEncoder, domain, form,
    guardrail, model_incident, permission, session, session_delivery, session_message,
    session_orchestration::QuestionId,
    session_pending,
    session_review::{
        Answers, Decision, Deferral, Dismissable, Fingerprint, Id, Item, Kind, Origin, Payload,
        Reason, RecoveryChoice,
    },
    stringify_json,
};
use ycoding_store::{
    Error as StoreError, KeyPart, Snapshot, Write,
    project::{Permission, PermissionTable},
    session::{MessageTable, PendingTable, Session, SessionTable, TaskTable},
    tuple_key,
};

pub use super::review_fold::WithdrawReason;

const ATTEMPTS: usize = 16;

#[derive(Clone, Debug)]
pub struct OpenInput {
    pub session_id: session::Id,
    pub kind: Kind,
    pub reason: Reason,
    pub choice: Option<LosslessString>,
    pub confidence: Option<guardrail::Confidence>,
    pub grades: Option<Vec<guardrail::Grade>>,
    pub origin: Origin,
    pub payload: Payload,
    pub limit: usize,
    pub conversion: bool,
    pub created: i64,
}

#[derive(Clone, Debug)]
pub struct DecideInput {
    pub session_id: session::Id,
    pub item_id: Id,
    pub decision: Decision,
    pub now: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GrantKind {
    Guardrail,
    Permission,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Conflict {
    Decided,
    Withdrawn,
    Archived,
    Delivery(String),
}

#[derive(Debug)]
pub enum Error {
    SessionNotFound(session::Id),
    NotFound(Id),
    Full {
        session_id: session::Id,
        limit: usize,
    },
    Conflict {
        item_id: Id,
        reason: Conflict,
    },
    InvalidDecision {
        item_id: Id,
        message: String,
    },
    InvalidDeferral(String),
    Store(StoreError),
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SessionNotFound(_) => formatter.write_str("Session not found"),
            Self::NotFound(_) => formatter.write_str("Review item not found"),
            Self::Full { limit, .. } => {
                write!(formatter, "Review box is full ({limit} open items)")
            }
            Self::Conflict { reason, .. } => match reason {
                Conflict::Decided => formatter.write_str("Review item already decided"),
                Conflict::Withdrawn => formatter.write_str("Review item was withdrawn"),
                Conflict::Archived => {
                    formatter.write_str("Review item belongs to an archived Session")
                }
                Conflict::Delivery(message) => formatter.write_str(message),
            },
            Self::InvalidDecision { message, .. } => formatter.write_str(message),
            Self::InvalidDeferral(message) => formatter.write_str(message),
            Self::Store(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<StoreError> for Error {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

#[derive(Clone, Debug)]
pub struct FingerprintInput {
    pub action: LosslessString,
    pub resources: Vec<LosslessString>,
    pub workdir: LosslessString,
    pub rule_ids: Vec<LosslessString>,
    pub hard_review: bool,
    pub metadata: Option<JsonObject>,
}

pub fn fingerprint(input: &FingerprintInput) -> Fingerprint {
    let mut rule_ids = input.rule_ids.clone();
    rule_ids.sort_by(|left, right| left.code_units().cmp(right.code_units()));
    let value = ObjectEncoder::new()
        .field("action", &input.action)
        .field("resources", &input.resources)
        .field("workdir", &input.workdir)
        .field("ruleIDs", &rule_ids)
        .field("hardReview", &input.hard_review)
        .field(
            "metadata",
            &JsonValue::Object(input.metadata.clone().unwrap_or_default()),
        )
        .finish();
    Fingerprint::decode(&JsonValue::String(sha256(&canonical(&value)).into()))
        .expect("sha256 digest")
}

pub fn prompt_id(item_id: &Id) -> session_message::Id {
    let digest = sha256(&String::from_utf16_lossy(
        &item_id.as_lossless().code_units().collect::<Vec<_>>(),
    ));
    session_message::Id::new(format!("msg_review_{}", &digest[..24])).expect("review prompt ID")
}

fn canonical(value: &JsonValue) -> String {
    match value {
        JsonValue::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        JsonValue::Object(fields) => {
            let mut entries = fields.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.code_units().cmp(right.0.code_units()));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(name, value)| format!(
                        "{}:{}",
                        stringify_json(&JsonValue::String(name.clone())),
                        canonical(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => stringify_json(value),
    }
}

pub type DeliveryFuture<'a> = Pin<Box<dyn Future<Output = Result<(), DeliveryError>> + Send + 'a>>;

pub trait Delivery: Send + Sync {
    fn wake(&self, session_id: &session::Id);
    fn answer_child<'a>(&'a self, answer: ChildAnswer) -> DeliveryFuture<'a>;
    fn resolve_recovery<'a>(&'a self, resolution: RecoveryResolution) -> DeliveryFuture<'a>;
}

#[derive(Clone, Debug)]
pub struct ChildAnswer {
    pub parent_id: session::Id,
    pub child_id: session::Id,
    pub question_id: QuestionId,
    pub text: LosslessString,
    pub data: Option<domain::Json>,
    pub claim: Claim,
}

#[derive(Clone, Debug)]
pub struct RecoveryResolution {
    pub child_id: session::Id,
    pub choice: RecoveryChoice,
    pub claim: Claim,
}

#[derive(Debug)]
pub enum DeliveryError {
    Conflict(String),
    Store(StoreError),
}

#[derive(Clone, Debug)]
pub struct Claim {
    item_id: Id,
    session_id: session::Id,
    decision: Decision,
    fence: i64,
    recorded: bool,
}

impl Claim {
    pub fn item_id(&self) -> &Id {
        &self.item_id
    }

    pub fn session_id(&self) -> &session::Id {
        &self.session_id
    }

    pub fn decision(&self) -> &Decision {
        &self.decision
    }

    pub fn commit(&self, tx: &mut Write<'_>, now: i64) -> Result<bool, StoreError> {
        let session = self.session_id.as_lossless();
        if review_fold::latest_in(tx, session)? != self.fence
            || tx
                .get::<SessionTable>(&key(session))?
                .is_none_or(|row| row.time_archived.is_some())
        {
            return Err(review_fold::changed(tx));
        }
        if self.recorded {
            return Ok(false);
        }
        review_fold::append(
            tx,
            session,
            DECIDED,
            now,
            decided(&self.session_id, &self.item_id, &self.decision),
        )?;
        Ok(true)
    }
}

fn decided(session_id: &session::Id, item_id: &Id, decision: &Decision) -> JsonValue {
    ObjectEncoder::new()
        .field("sessionID", session_id)
        .field("itemID", item_id)
        .field("decision", decision)
        .finish()
}

#[derive(Clone)]
pub struct Service {
    sessions: store::Service,
    delivery: Arc<dyn Delivery>,
}

impl Service {
    pub fn new(sessions: store::Service, delivery: Arc<dyn Delivery>) -> Self {
        Self { sessions, delivery }
    }

    pub async fn open(&self, input: OpenInput) -> Result<Item, Error> {
        let deferral = deferral_of(&input)?;
        for _ in 0..ATTEMPTS {
            let step = self.open_step(&input, &deferral)?;
            if let Some(item) = self.sessions.client.submit(step)?.await? {
                return Ok(item);
            }
        }
        Err(contended())
    }

    pub fn open_now(&self, input: OpenInput) -> Result<Item, Error> {
        let deferral = deferral_of(&input)?;
        for _ in 0..ATTEMPTS {
            let step = self.open_step(&input, &deferral)?;
            if let Some(item) = self.sessions.client.submit(step)?.wait()? {
                return Ok(item);
            }
        }
        Err(contended())
    }

    fn open_step(
        &self,
        input: &OpenInput,
        deferral: &Deferral,
    ) -> Result<
        impl FnOnce(&mut Write<'_>) -> Result<Option<Item>, StoreError> + Send + 'static,
        Error,
    > {
        let (root, members, fence) = {
            let snapshot = self.sessions.client.snapshot()?;
            let view = view(&snapshot, &input.session_id)?
                .ok_or_else(|| Error::SessionNotFound(input.session_id.clone()))?;
            if !input.conversion
                && view.folded.iter().filter(|item| item.is_open()).count() >= input.limit
            {
                return Err(Error::Full {
                    session_id: input.session_id.clone(),
                    limit: input.limit,
                });
            }
            let fence = Fence::read(&snapshot, &view.members)?;
            (view.root, view.members, fence)
        };
        let session_id = input.session_id.clone();
        let deferral = deferral.clone();
        let created = input.created;
        let escalation = escalated(&deferral, &session_id, created);
        Ok(move |tx: &mut Write<'_>| {
            let mut read = family::Reader::Transaction(&mut *tx);
            if family::root(&mut read, session_id.as_lossless())?.as_ref() != Some(&root)
                || family::members(&mut read, &root)? != members
                || !fence.holds(tx)?
            {
                return Ok(None);
            }
            let event = review_fold::append(
                tx,
                session_id.as_lossless(),
                DEFERRED,
                created,
                deferral
                    .encode_into(ObjectEncoder::new().field("sessionID", &session_id))
                    .finish(),
            )?;
            if let Some(incident) = &escalation {
                crate::model_incident::record::escalation(tx, &incident.0, &incident.1)?;
            }
            let owner = key(session_id.as_lossless());
            let title = tx
                .get::<SessionTable>(&owner)?
                .map_or_else(|| "".into(), |row| row.title);
            let child = tx
                .get::<TaskTable>(&owner)?
                .map(|task| (task.agent, task.description));
            let folded = Folded {
                item_id: deferral.item_id.clone(),
                session_id,
                deferral,
                created: event.created,
                decision: None,
                withdrawn: None,
                consumed: false,
            };
            item_of(&folded, &root, title, child).map(Some)
        })
    }

    pub fn list(&self, session_id: &session::Id) -> Result<Vec<Item>, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let view = view(&snapshot, session_id)?
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?;
        let mut items = Vec::new();
        for folded in view.folded.iter().filter(|item| item.is_open()) {
            let owner = key(folded.session_id.as_lossless());
            let Some(row) = snapshot.get::<SessionTable>(&owner)? else {
                continue;
            };
            if row.time_archived.is_some() {
                continue;
            }
            let child = snapshot
                .get::<TaskTable>(&owner)?
                .map(|task| (task.agent, task.description));
            items.push(item_of(folded, &view.root, row.title, child)?);
        }
        Ok(items)
    }

    pub fn family(&self, session_id: &session::Id) -> Result<Vec<session::Id>, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let view = view(&snapshot, session_id)?
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?;
        view.members
            .into_iter()
            .map(|member| {
                session::Id::new(member)
                    .map_err(|error| Error::Store(StoreError::Record(Box::new(error))))
            })
            .collect()
    }

    pub async fn defer_child_question(
        &self,
        session_id: &session::Id,
        now: i64,
    ) -> Result<bool, Error> {
        let (question_id, text, data) = {
            let snapshot = self.sessions.client.snapshot()?;
            let Some(task) = snapshot.get::<TaskTable>(&key(session_id.as_lossless()))? else {
                return Ok(false);
            };
            let (Some(question_id), Some(text)) = (task.question_id, task.question) else {
                return Ok(false);
            };
            if task.state.as_str() != Some("waiting") {
                return Ok(false);
            }
            let question_id = QuestionId(question_id);
            if review_fold::owns_question(&snapshot, session_id, &question_id)? {
                return Ok(false);
            }
            let data = task
                .question_data
                .as_ref()
                .map(|data| data.domain())
                .transpose()?;
            (question_id, text, data)
        };
        self.open(OpenInput {
            session_id: session_id.clone(),
            kind: Kind::SubagentQuestion,
            reason: Reason::SleepEntry,
            choice: None,
            confidence: None,
            grades: None,
            origin: Origin::Question { question_id },
            payload: Payload::SubagentQuestion(
                ycoding_schema::session_review::SubagentQuestionPayload { text, data },
            ),
            limit: 0,
            conversion: true,
            created: now,
        })
        .await?;
        Ok(true)
    }

    pub fn has_open(&self, session_id: &session::Id) -> Result<bool, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        Ok(view(&snapshot, session_id)?
            .ok_or_else(|| Error::SessionNotFound(session_id.clone()))?
            .folded
            .iter()
            .any(Folded::is_open))
    }

    pub async fn decide(&self, input: DecideInput) -> Result<(), Error> {
        for _ in 0..ATTEMPTS {
            let delivered = match self.prepare(&input)? {
                Step::Revert(session) => {
                    revert::commit(&self.sessions, &session, input.now).await?;
                    continue;
                }
                Step::Prompt(target) => {
                    if self.settle(target, false, true, input.now).await? {
                        return Ok(());
                    }
                    continue;
                }
                Step::Child(answer) => self.delivery.answer_child(answer).await,
                Step::Recovery(resolution) => self.delivery.resolve_recovery(resolution).await,
            };
            match delivered {
                Ok(()) => return Ok(()),
                Err(DeliveryError::Conflict(message)) => {
                    return Err(Error::Conflict {
                        item_id: input.item_id.clone(),
                        reason: Conflict::Delivery(message),
                    });
                }
                Err(DeliveryError::Store(error)) if review_fold::is_changed(&error) => continue,
                Err(DeliveryError::Store(error)) => return Err(Error::Store(error)),
            }
        }
        Err(contended())
    }

    fn prepare(&self, input: &DecideInput) -> Result<Step, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let view = view(&snapshot, &input.session_id)?
            .ok_or_else(|| Error::SessionNotFound(input.session_id.clone()))?;
        let item = view
            .folded
            .iter()
            .find(|item| item.item_id == input.item_id)
            .ok_or_else(|| Error::NotFound(input.item_id.clone()))?;
        let conflict = |reason| Error::Conflict {
            item_id: item.item_id.clone(),
            reason,
        };
        let owner = snapshot
            .get::<SessionTable>(&key(item.session_id.as_lossless()))?
            .filter(|row| row.time_archived.is_none())
            .ok_or_else(|| conflict(Conflict::Archived))?;
        if item.withdrawn.is_some() {
            return Err(conflict(Conflict::Withdrawn));
        }
        if item
            .decision
            .as_ref()
            .is_some_and(|current| !continues_stopped(current, &input.decision))
        {
            return Err(conflict(Conflict::Decided));
        }
        if let Some(message) = validate(item, &input.decision) {
            return Err(Error::InvalidDecision {
                item_id: item.item_id.clone(),
                message,
            });
        }
        let claim = Claim {
            item_id: item.item_id.clone(),
            session_id: item.session_id.clone(),
            decision: input.decision.clone(),
            fence: review_fold::latest_at(&snapshot, item.session_id.as_lossless())?,
            recorded: false,
        };
        match item.deferral.kind {
            Kind::SubagentQuestion => {
                child_answer(item, &owner, &input.decision, claim).map(Step::Child)
            }
            Kind::Recovery => {
                let Decision::Recovery { choice } = &input.decision else {
                    return Err(Error::Store(StoreError::Rejected(
                        "recovery review requires a recovery choice",
                    )));
                };
                Ok(Step::Recovery(RecoveryResolution {
                    child_id: item.session_id.clone(),
                    choice: *choice,
                    claim,
                }))
            }
            _ if owner.revert.is_some() => self
                .sessions
                .get(&item.session_id)?
                .map(Step::Revert)
                .ok_or_else(|| Error::SessionNotFound(item.session_id.clone())),
            _ => Ok(Step::Prompt(Target {
                root: view.root.clone(),
                project: owner.project_id,
                item: item.clone(),
                decision: input.decision.clone(),
                fence: claim.fence,
            })),
        }
    }

    async fn settle(
        &self,
        target: Target,
        recorded: bool,
        wake: bool,
        now: i64,
    ) -> Result<bool, Error> {
        let request = pending::Request {
            id: prompt_id(&target.item.item_id),
            session_id: target.item.session_id.clone(),
            input: session_pending::Message::User(session_pending::UserMessage {
                data: session_pending::UserData {
                    text: prompt(&target.item, &target.decision)?.into(),
                    files: None,
                    agents: None,
                    metadata: Some(object(
                        ObjectEncoder::new()
                            .field(
                                "review",
                                &ObjectEncoder::new()
                                    .field("itemID", &target.item.item_id)
                                    .field("kind", &target.item.deferral.kind)
                                    .finish(),
                            )
                            .finish(),
                    )),
                },
                delivery: session_delivery::Delivery::Steer,
            }),
            event_id: projector::random_event_id()?,
            created: now,
        };
        let directories = approved_directories(&target.item, &target.decision);
        let saved = saved_resources(&target.item, &target.decision);
        let rejection = (!recorded)
            .then(|| rejected(&target.item, &target.decision, now))
            .flatten();
        let owner = target.item.session_id.clone();
        let woken = owner.clone();
        let settled = self
            .sessions
            .client
            .submit(move |tx| {
                let session = owner.as_lossless();
                if review_fold::latest_in(tx, session)? != target.fence
                    || tx
                        .get::<SessionTable>(&key(session))?
                        .is_none_or(|row| row.time_archived.is_some() || row.revert.is_some())
                {
                    return Ok(false);
                }
                if !recorded {
                    review_fold::append(
                        tx,
                        session,
                        DECIDED,
                        now,
                        decided(&owner, &target.item.item_id, &target.decision),
                    )?;
                }
                if let Some((id, input, decided_by)) = &rejection {
                    crate::model_incident::record::rejection(tx, id, input, decided_by)?;
                }
                if !directories.is_empty() {
                    review_fold::append(
                        tx,
                        &target.root,
                        "session.guardrail.approved.1",
                        now,
                        ObjectEncoder::new()
                            .field("sessionID", &target.root)
                            .field("directories", &directories)
                            .finish(),
                    )?;
                }
                if let Some((action, resources)) = saved {
                    save(tx, &target.project, &action, resources, now)?;
                }
                pending::admit_in(tx, &request, &None)?;
                Ok(true)
            })?
            .await?;
        if settled && wake {
            self.delivery.wake(&woken);
        }
        Ok(settled)
    }

    pub async fn withdraw(
        &self,
        session_id: &session::Id,
        reason: WithdrawReason,
        now: i64,
    ) -> Result<usize, Error> {
        for _ in 0..ATTEMPTS {
            let withdrawals = {
                let snapshot = self.sessions.client.snapshot()?;
                let items = review_fold::fold(&snapshot, &[session_id.as_lossless().clone()])?
                    .into_iter()
                    .filter(Folded::is_open)
                    .map(|item| item.item_id)
                    .collect();
                review_fold::Withdrawals::new(&snapshot, session_id, items, reason, now)?
            };
            if withdrawals.item_ids().is_empty() {
                return Ok(0);
            }
            match self.append(withdrawals).await {
                Err(error) if review_fold::is_changed(&error) => continue,
                result => return Ok(result?),
            }
        }
        Err(contended())
    }

    pub async fn withdraw_after(
        &self,
        session_id: &session::Id,
        message_id: &session_message::Id,
        now: i64,
    ) -> Result<usize, Error> {
        for _ in 0..ATTEMPTS {
            let withdrawals = {
                let snapshot = self.sessions.client.snapshot()?;
                let Some(boundary) = review_fold::message_seq(&snapshot, session_id, message_id)?
                else {
                    return Ok(0);
                };
                review_fold::withdrawals(&snapshot, session_id, boundary, false, now)?
            };
            if withdrawals.item_ids().is_empty() {
                return Ok(0);
            }
            match self.append(withdrawals).await {
                Err(error) if review_fold::is_changed(&error) => continue,
                result => return Ok(result?),
            }
        }
        Err(contended())
    }

    pub async fn consume(
        &self,
        session_id: &session::Id,
        kind: GrantKind,
        expected: &Fingerprint,
        now: i64,
    ) -> Result<bool, Error> {
        for _ in 0..ATTEMPTS {
            let Some((item_id, fence)) = self.grant(session_id, kind, expected)? else {
                return Ok(false);
            };
            if self
                .sessions
                .client
                .submit(consumption(session_id.clone(), item_id, fence, now))?
                .await?
            {
                return Ok(true);
            }
        }
        Err(contended())
    }

    pub fn consume_now(
        &self,
        session_id: &session::Id,
        kind: GrantKind,
        expected: &Fingerprint,
        now: i64,
    ) -> Result<bool, Error> {
        for _ in 0..ATTEMPTS {
            let Some((item_id, fence)) = self.grant(session_id, kind, expected)? else {
                return Ok(false);
            };
            if self
                .sessions
                .client
                .submit(consumption(session_id.clone(), item_id, fence, now))?
                .wait()?
            {
                return Ok(true);
            }
        }
        Err(contended())
    }

    fn grant(
        &self,
        session_id: &session::Id,
        kind: GrantKind,
        expected: &Fingerprint,
    ) -> Result<Option<(Id, i64)>, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let Some(grant) = review_fold::fold(&snapshot, &[session_id.as_lossless().clone()])?
            .into_iter()
            .find(|item| grants(item, kind, expected))
        else {
            return Ok(None);
        };
        Ok(Some((
            grant.item_id,
            review_fold::latest_at(&snapshot, session_id.as_lossless())?,
        )))
    }

    pub async fn reconcile(&self, now: i64) -> Result<usize, Error> {
        let mut delivered = 0;
        let mut after: Option<Vec<u8>> = None;
        loop {
            let sessions = {
                let snapshot = self.sessions.client.snapshot()?;
                let rows = snapshot.scan::<SessionTable>(
                    after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                    Bound::Unbounded,
                    128,
                )?;
                let Some(last) = rows.last() else {
                    return Ok(delivered);
                };
                after = Some(key(&last.id));
                let mut decided = Vec::new();
                for row in rows {
                    if review_fold::has_decided(&snapshot, &row.id)? {
                        decided.push(row.id);
                    }
                }
                decided
            };
            for session in sessions {
                delivered += self.reconcile_session(session, now).await?;
            }
        }
    }

    async fn reconcile_session(&self, session: LosslessString, now: i64) -> Result<usize, Error> {
        let mut delivered = 0;
        for step in self.undelivered(session)? {
            match step {
                Step::Prompt(target) => {
                    if self.settle(target, true, false, now).await? {
                        delivered += 1;
                    }
                }
                Step::Child(answer) => {
                    let item_id = answer.claim.item_id.clone();
                    match self.delivery.answer_child(answer).await {
                        Ok(()) => delivered += 1,
                        Err(DeliveryError::Conflict(message)) => {
                            return Err(Error::Conflict {
                                item_id,
                                reason: Conflict::Delivery(message),
                            });
                        }
                        Err(DeliveryError::Store(error)) => return Err(Error::Store(error)),
                    }
                }
                Step::Revert(_) | Step::Recovery(_) => {}
            }
        }
        Ok(delivered)
    }

    fn undelivered(&self, session: LosslessString) -> Result<Vec<Step>, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let session_id =
            session::Id::new(session).map_err(|error| StoreError::Record(Box::new(error)))?;
        let Some(view) = view(&snapshot, &session_id)? else {
            return Ok(Vec::new());
        };
        let Some(owner) = snapshot.get::<SessionTable>(&key(session_id.as_lossless()))? else {
            return Ok(Vec::new());
        };
        let fence = review_fold::latest_at(&snapshot, session_id.as_lossless())?;
        let mut steps = Vec::new();
        for item in &view.folded {
            let Some(decision) = &item.decision else {
                continue;
            };
            if item.session_id != session_id
                || item.withdrawn.is_some()
                || item.deferral.kind == Kind::Recovery
            {
                continue;
            }
            if item.deferral.kind == Kind::SubagentQuestion {
                let Origin::Question { question_id } = &item.deferral.origin else {
                    continue;
                };
                if review_fold::owns_question(&snapshot, &session_id, question_id)? {
                    let claim = Claim {
                        item_id: item.item_id.clone(),
                        session_id: session_id.clone(),
                        decision: decision.clone(),
                        fence,
                        recorded: true,
                    };
                    steps.push(Step::Child(child_answer(item, &owner, decision, claim)?));
                }
                continue;
            }
            let prompt = key(prompt_id(&item.item_id).as_lossless());
            if snapshot.get::<PendingTable>(&prompt)?.is_some()
                || snapshot.get::<MessageTable>(&prompt)?.is_some()
            {
                continue;
            }
            steps.push(Step::Prompt(Target {
                root: view.root.clone(),
                project: owner.project_id.clone(),
                item: item.clone(),
                decision: decision.clone(),
                fence,
            }));
        }
        Ok(steps)
    }

    async fn append(&self, withdrawals: review_fold::Withdrawals) -> Result<usize, StoreError> {
        self.sessions
            .client
            .submit(move |tx| withdrawals.append(tx))?
            .await
    }
}

fn grants(item: &Folded, kind: GrantKind, expected: &Fingerprint) -> bool {
    if item.withdrawn.is_some() || item.consumed {
        return false;
    }
    match (kind, &item.decision, &item.deferral.payload) {
        (
            GrantKind::Guardrail,
            Some(Decision::Guardrail { reply }),
            Payload::Guardrail(payload),
        ) => *reply != guardrail::Reply::Reject && &payload.fingerprint == expected,
        (
            GrantKind::Permission,
            Some(Decision::Permission { reply }),
            Payload::Permission(payload),
        ) => reply.0.as_str() != Some("reject") && &payload.fingerprint == expected,
        _ => false,
    }
}

enum Step {
    Revert(session::Info),
    Prompt(Target),
    Child(ChildAnswer),
    Recovery(RecoveryResolution),
}

struct Target {
    root: LosslessString,
    project: LosslessString,
    item: Folded,
    decision: Decision,
    fence: i64,
}

fn child_answer(
    item: &Folded,
    owner: &Session,
    decision: &Decision,
    claim: Claim,
) -> Result<ChildAnswer, Error> {
    let parent = owner
        .parent_id
        .clone()
        .filter(|parent| !parent.is_empty())
        .ok_or(StoreError::Rejected(
            "Subagent review item has no parent Session",
        ))?;
    let Origin::Question { question_id } = &item.deferral.origin else {
        return Err(Error::Store(StoreError::Rejected(
            "Subagent review item has no question",
        )));
    };
    let (text, data) = match decision {
        Decision::SubagentQuestion { text, data } => (text.clone(), data.clone()),
        _ => (dismissal(item).into(), None),
    };
    Ok(ChildAnswer {
        parent_id: session::Id::new(parent).map_err(|error| StoreError::Record(Box::new(error)))?,
        child_id: item.session_id.clone(),
        question_id: question_id.clone(),
        text,
        data,
        claim,
    })
}

fn continues_stopped(current: &Decision, next: &Decision) -> bool {
    matches!(
        (current, next),
        (
            Decision::Recovery {
                choice: RecoveryChoice::Stop
            },
            Decision::Recovery {
                choice: RecoveryChoice::Continue
            }
        )
    )
}

fn kind_of(decision: &Decision) -> Kind {
    match decision {
        Decision::Question { .. }
        | Decision::Dismissed {
            kind: Dismissable::Question,
        } => Kind::Question,
        Decision::SubagentQuestion { .. }
        | Decision::Dismissed {
            kind: Dismissable::SubagentQuestion,
        } => Kind::SubagentQuestion,
        Decision::Guardrail { .. } => Kind::Guardrail,
        Decision::Permission { .. } => Kind::Permission,
        Decision::Recovery { .. } => Kind::Recovery,
    }
}

fn validate(item: &Folded, decision: &Decision) -> Option<String> {
    if kind_of(decision) != item.deferral.kind {
        return Some("Decision kind does not match the review item".into());
    }
    match (decision, &item.deferral.payload) {
        (Decision::Question { answers }, Payload::Question(payload)) => match answers {
            Answers::Questions(list) if list.len() == payload.questions.len() => None,
            Answers::Questions(_) => Some("Question answers do not cover every question".into()),
            Answers::Form(_) => Some("Question answers must be one list per question".into()),
        },
        (Decision::Question { answers }, Payload::Form(payload)) => {
            let Answers::Form(answer) = answers else {
                return Some("Form answers must be keyed by field".into());
            };
            let Ok(info) = form::Info::decode(
                &ObjectEncoder::new()
                    .field("id", "frm_review")
                    .field("sessionID", &item.session_id)
                    .field("title", &payload.title)
                    .field("fields", &payload.fields)
                    .finish(),
            ) else {
                return Some("Form review payload is invalid".into());
            };
            forms::validate_answer(&info, answer)
                .err()
                .map(|message| text(&message))
        }
        (Decision::Question { .. }, _) => Some("Decision does not match the review item".into()),
        (
            Decision::Guardrail {
                reply: guardrail::Reply::Always,
            },
            Payload::Guardrail(payload),
        ) if payload.hard_review => Some("Hard guardrail reviews cannot be approved always".into()),
        _ => None,
    }
}

fn prompt(item: &Folded, decision: &Decision) -> Result<String, Error> {
    let id = text(item.item_id.as_lossless());
    let mismatch = || {
        Error::Store(StoreError::Rejected(
            "review decision does not match its item",
        ))
    };
    match (decision, &item.deferral.payload) {
        (Decision::Dismissed { .. }, _) => Ok(dismissal(item)),
        (
            Decision::Question {
                answers: Answers::Questions(answers),
            },
            Payload::Question(payload),
        ) => {
            let formatted = payload
                .questions
                .iter()
                .enumerate()
                .map(|(index, question)| {
                    format!(
                        "\"{}\"=\"{}\"",
                        text(&question.question),
                        answers
                            .get(index)
                            .map(|answer| answer.iter().map(text).collect::<Vec<_>>().join(", "))
                            .unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!(
                "Decision on deferred questions {id} (asked while the user slept): {formatted}. Continue with the work that depended on it."
            ))
        }
        (
            Decision::Question {
                answers: Answers::Form(answer),
            },
            Payload::Form(payload),
        ) if payload.question_tool => {
            let formatted = payload
                .fields
                .iter()
                .map(|field| {
                    let encoded = field.encode();
                    let label = ["description", "title", "key"]
                        .into_iter()
                        .find_map(|name| match member(&encoded, name) {
                            Some(JsonValue::String(value)) => Some(text(value)),
                            _ => None,
                        })
                        .unwrap_or_default();
                    let value = member(&encoded, "key")
                        .and_then(|name| match name {
                            JsonValue::String(name) => answer.0.get(name),
                            _ => None,
                        })
                        .map(display)
                        .unwrap_or_default();
                    format!("\"{label}\"=\"{value}\"")
                })
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!(
                "Decision on deferred questions {id} (asked while the user slept): {formatted}. Continue with the work that depended on it."
            ))
        }
        (
            Decision::Question {
                answers: Answers::Form(answer),
            },
            Payload::Form(payload),
        ) => Ok(format!(
            "The user answered deferred form {id} \"{}\": {}. Continue with the work that depended on it.",
            text(&payload.title),
            stringify_json(&JsonValue::Object(answer.0.clone()))
        )),
        (Decision::Guardrail { reply }, Payload::Guardrail(payload)) => {
            let action = text(&payload.action);
            if *reply == guardrail::Reply::Reject {
                return Ok(format!(
                    "The user rejected deferred guardrail item {id} ({action}). Do not retry it; choose another approach or report the blocker to the user."
                ));
            }
            let once = format!(
                "The user approved deferred guardrail item {id} once: {action} on {}. Re-issue exactly that action now if it is still needed; the approval covers one identical request from this Session.",
                joined(&payload.resources)
            );
            if *reply == guardrail::Reply::Always && !payload.directories.is_empty() {
                return Ok(format!(
                    "{once} Directories {} are approved for this Session family.",
                    joined(&payload.directories)
                ));
            }
            Ok(once)
        }
        (Decision::Permission { reply }, Payload::Permission(payload)) => {
            let action = text(&payload.action);
            match reply.0.as_str() {
                Some("reject") => Ok(format!(
                    "The user rejected deferred permission item {id} ({action}). Do not retry it; choose another approach or report the blocker to the user."
                )),
                choice => Ok(format!(
                    "The user approved deferred permission item {id} {}: {action} on {}. Re-issue exactly that action now if it is still needed; the approval covers one identical request from this Session.",
                    if choice == Some("always") {
                        "always"
                    } else {
                        "once"
                    },
                    joined(&payload.resources)
                )),
            }
        }
        _ => Err(mismatch()),
    }
}

fn dismissal(item: &Folded) -> String {
    format!(
        "The user dismissed deferred question {} without answering; proceed on your own judgment.",
        text(item.item_id.as_lossless())
    )
}

fn approved_directories(item: &Folded, decision: &Decision) -> Vec<LosslessString> {
    match (decision, &item.deferral.payload) {
        (
            Decision::Guardrail {
                reply: guardrail::Reply::Always,
            },
            Payload::Guardrail(payload),
        ) => payload.directories.clone(),
        _ => Vec::new(),
    }
}

fn saved_resources(
    item: &Folded,
    decision: &Decision,
) -> Option<(LosslessString, Vec<LosslessString>)> {
    let (Decision::Permission { reply }, Payload::Permission(payload)) =
        (decision, &item.deferral.payload)
    else {
        return None;
    };
    let save = payload.save.clone().filter(|save| !save.is_empty())?;
    (reply.0.as_str() == Some("always")).then(|| (payload.action.clone(), save))
}

fn save(
    tx: &mut Write<'_>,
    project: &LosslessString,
    action: &LosslessString,
    resources: Vec<LosslessString>,
    now: i64,
) -> Result<(), StoreError> {
    for resource in resources {
        let unique = tuple_key(&[
            KeyPart::String(project),
            KeyPart::String(action),
            KeyPart::String(&resource),
        ]);
        if !tx
            .index::<PermissionTable>("permission_project_action_resource_idx", &unique, None, 1)?
            .is_empty()
        {
            continue;
        }
        tx.put::<PermissionTable>(&Permission {
            id: decode_id::<permission::Id>("per_", 0).into_lossless(),
            project_id: project.clone(),
            action: action.clone(),
            resource,
            time_created: now,
            time_updated: now,
        })?;
    }
    Ok(())
}

fn display(value: &JsonValue) -> String {
    match value {
        JsonValue::String(value) => text(value),
        JsonValue::Array(items) => items.iter().map(display).collect::<Vec<_>>().join(", "),
        other => stringify_json(other),
    }
}

fn member<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}

fn object(value: JsonValue) -> JsonObject {
    match value {
        JsonValue::Object(object) => object,
        _ => unreachable!("object encoder"),
    }
}

fn joined(values: &[LosslessString]) -> String {
    values.iter().map(text).collect::<Vec<_>>().join(", ")
}

fn text(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}

struct View {
    root: LosslessString,
    members: Vec<LosslessString>,
    folded: Vec<Folded>,
}

fn view(snapshot: &Snapshot, session_id: &session::Id) -> Result<Option<View>, StoreError> {
    let mut read = family::Reader::Snapshot(snapshot);
    let Some(root) = family::root(&mut read, session_id.as_lossless())? else {
        return Ok(None);
    };
    let members = family::members(&mut read, &root)?;
    let folded = review_fold::fold(snapshot, &members)?;
    Ok(Some(View {
        root,
        members,
        folded,
    }))
}

fn item_of(
    folded: &Folded,
    root: &LosslessString,
    title: LosslessString,
    child: Option<(LosslessString, LosslessString)>,
) -> Result<Item, StoreError> {
    let child = child.map(|(agent, description)| {
        ObjectEncoder::new()
            .field("agent", &agent)
            .field("description", &description)
            .finish()
    });
    Item::decode(
        &folded
            .deferral
            .encode_into(ObjectEncoder::new())
            .field("sessionID", &folded.session_id)
            .field("rootSessionID", root)
            .field("sessionTitle", &title)
            .field("created", &(folded.created as f64))
            .optional("child", &child)
            .finish(),
    )
    .map_err(|error| StoreError::Record(Box::new(error)))
}

fn pairs(kind: Kind, payload: &Payload) -> bool {
    matches!(
        (kind, payload),
        (Kind::Question, Payload::Form(_) | Payload::Question(_))
            | (Kind::SubagentQuestion, Payload::SubagentQuestion(_))
            | (Kind::Guardrail, Payload::Guardrail(_))
            | (Kind::Permission, Payload::Permission(_))
            | (Kind::Recovery, Payload::Recovery(_))
    )
}

fn contended() -> Error {
    Error::Store(StoreError::Domain {
        kind: "review_changed",
        message: "review state kept changing during the operation",
    })
}

fn consumption(
    session_id: session::Id,
    item_id: Id,
    fence: i64,
    now: i64,
) -> impl FnOnce(&mut Write<'_>) -> Result<bool, StoreError> + Send + 'static {
    move |tx| {
        let session = session_id.as_lossless();
        if review_fold::latest_in(tx, session)? != fence {
            return Ok(false);
        }
        review_fold::append(
            tx,
            session,
            CONSUMED,
            now,
            ObjectEncoder::new()
                .field("sessionID", &session_id)
                .field("itemID", &item_id)
                .finish(),
        )?;
        Ok(true)
    }
}

fn escalated(
    deferral: &Deferral,
    session_id: &session::Id,
    created: i64,
) -> Option<(model_incident::Id, GuardrailInput)> {
    let Payload::Guardrail(payload) = &deferral.payload else {
        return None;
    };
    if matches!(deferral.reason, Reason::Disabled | Reason::SleepEntry) {
        return None;
    }
    Some((
        decode_id("inc_", 0),
        guardrail_incident(session_id, &deferral.origin, payload, created),
    ))
}

fn rejected(
    item: &Folded,
    decision: &Decision,
    now: i64,
) -> Option<(
    model_incident::Id,
    GuardrailInput,
    model_incident::DecidedBy,
)> {
    let (
        Decision::Guardrail {
            reply: guardrail::Reply::Reject,
        },
        Payload::Guardrail(payload),
    ) = (decision, &item.deferral.payload)
    else {
        return None;
    };
    Some((
        decode_id("inc_", 0),
        guardrail_incident(&item.session_id, &item.deferral.origin, payload, now),
        model_incident::DecidedBy::decode(&JsonValue::String("human".into()))
            .expect("human decider"),
    ))
}

fn guardrail_incident(
    session_id: &session::Id,
    origin: &Origin,
    payload: &ycoding_schema::session_review::GuardrailPayload,
    time: i64,
) -> GuardrailInput {
    GuardrailInput {
        session_id: session_id.clone(),
        request_id: payload.request_id.clone(),
        message_id: match origin {
            Origin::Tool { message_id, .. } => Some(message_id.clone()),
            _ => None,
        },
        rule_ids: payload.rule_ids.clone(),
        hard_review: payload.hard_review,
        time,
    }
}

fn deferral_of(input: &OpenInput) -> Result<Deferral, Error> {
    if !pairs(input.kind, &input.payload) {
        return Err(Error::InvalidDeferral(
            "Review payload does not match its kind".into(),
        ));
    }
    Ok(Deferral {
        item_id: decode_id("rvw_", 0),
        kind: input.kind,
        reason: input.reason,
        choice: input.choice.clone(),
        confidence: input.confidence,
        grades: input.grades.clone(),
        origin: input.origin.clone(),
        payload: input.payload.clone(),
    })
}
