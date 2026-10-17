use super::{CustomLayer, Evaluation, Paths, decision};
use crate::{
    model_incident::record::{self as incidents, GuardrailInput},
    platform::shell::queue::{Admission as ShellAdmission, FamilyReservation, Wake},
    session::review::{self, FingerprintInput, GrantKind, OpenInput},
    tools::code_mode::Cancellation,
    tools::policy::{Authority, Effect, Publisher, Reviews, Wait, permissions::Permissions, state},
};
use std::{
    collections::{BTreeMap, VecDeque},
    ops::Bound,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonPath, JsonValue, LosslessString, ObjectDecoder,
    ObjectEncoder, guardrail, model_incident, schema::NonNegativeInt, session_id::SessionId,
    session_review, stringify_json,
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart,
    session::{EventTable, NewEvent},
    tuple_key,
};

const APPROVED: &str = "session.guardrail.approved.1";

#[derive(Clone, Debug)]
pub struct Input {
    pub session_id: SessionId,
    pub action: String,
    pub resources: Vec<LosslessString>,
    pub metadata: Option<JsonObject>,
    pub skip_review: bool,
    pub holder: Option<LosslessString>,
    pub defer_shell: bool,
    pub source: Option<guardrail::Source>,
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub shells: u64,
    pub subagents: u64,
    pub reviews: u64,
    pub shell_wait: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            shells: 8,
            subagents: 8,
            reviews: 16,
            shell_wait: Duration::from_secs(60),
        }
    }
}
pub type CustomLayers = Arc<dyn Fn() -> Vec<CustomLayer> + Send + Sync>;

#[derive(Clone)]
pub struct Settings {
    pub paths: Paths,
    pub global_roots: Vec<LosslessString>,
    pub custom: CustomLayers,
    pub enabled: bool,
    pub limits: Limits,
    pub decide_reviews: bool,
    pub decide_hard_reviews: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReviewPolicy {
    pub enabled: bool,
    pub decide_reviews: bool,
    pub decide_hard_reviews: bool,
}

#[derive(Debug)]
pub enum Error {
    Authority(state::Error),
    Permission(crate::tools::policy::permissions::Error),
    Store(ycoding_store::Error),
    Publish(String),
    Blocked(Evaluation),
    Declined,
    NotFound,
    Deferred {
        request_id: guardrail::RequestId,
        item_id: session_review::Id,
        rule_ids: Vec<LosslessString>,
    },
    ReviewFull {
        limit: usize,
    },
    Review(review::Error),
    CapExceeded {
        root_session_id: SessionId,
        counter: &'static str,
        current: u64,
        limit: u64,
        holders: Vec<LosslessString>,
        waited_ms: u64,
    },
}
impl From<state::Error> for Error {
    fn from(value: state::Error) -> Self {
        Self::Authority(value)
    }
}
impl Error {
    pub fn capacity_message(&self) -> Option<String> {
        let Self::CapExceeded {
            counter,
            current,
            limit,
            holders,
            waited_ms,
            ..
        } = self
        else {
            return None;
        };
        let (subject, state, item, setting) = match *counter {
            "shells" => ("Shell", "running", "shell", "max_concurrent_shells"),
            "subagents" => (
                "Subagent",
                "running",
                "subagent",
                "max_concurrent_subagents",
            ),
            _ => ("Pending review", "pending", "review", "max_pending_reviews"),
        };
        let holders = if holders.is_empty() {
            String::new()
        } else {
            format!(
                " ({})",
                holders
                    .iter()
                    .map(|holder| String::from_utf16_lossy(
                        &holder.code_units().collect::<Vec<_>>()
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let waited = if *waited_ms == 0 {
            String::new()
        } else {
            format!("; waited {}s", (*waited_ms as f64 / 1000.0).round() as u64)
        };
        Some(format!(
            "{subject} limit reached: {current}/{limit} {counter} {state} in this session family{holders}{waited}. Wait for or stop a {state} {item}, or raise guardrails.{setting}."
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
enum Kind {
    Shell,
    Subagent,
    Review,
}
impl Kind {
    fn label(self) -> &'static str {
        match self {
            Self::Shell => "shells",
            Self::Subagent => "subagents",
            Self::Review => "reviews",
        }
    }
    fn limit(self, limits: Limits) -> u64 {
        match self {
            Self::Shell => limits.shells,
            Self::Subagent => limits.subagents,
            Self::Review => limits.reviews,
        }
    }
}

type Sender = oneshot::Sender<Result<Reservation, Error>>;

struct Pending {
    request: guardrail::Request,
    sender: Sender,
    review: Reservation,
    directories: Vec<LosslessString>,
    holder: Option<LosslessString>,
    defer_shell: bool,
    source: Option<guardrail::Source>,
    fingerprint: session_review::Fingerprint,
}
struct Waiter {
    id: u64,
    holder: Option<LosslessString>,
    request: Option<guardrail::RequestId>,
    sender: Sender,
}
#[derive(Default)]
struct Pool {
    slots: Vec<(u64, Option<LosslessString>)>,
    waiters: VecDeque<Waiter>,
}
#[derive(Default)]
struct State {
    pending: BTreeMap<guardrail::RequestId, Pending>,
    deciding: BTreeMap<guardrail::RequestId, (SessionId, Cancellation)>,
    approvals: BTreeMap<SessionId, u64>,
    blocked: BTreeMap<SessionId, u64>,
    sequences: BTreeMap<SessionId, u64>,
    pools: BTreeMap<(SessionId, Kind), Pool>,
    next_slot: u64,
    listeners: BTreeMap<SessionId, BTreeMap<u64, Wake>>,
}
struct Inner {
    authority: Authority,
    permissions: Permissions,
    settings: Settings,
    publish: Publisher,
    state: Mutex<State>,
    reviews: OnceLock<Reviews>,
    decision: OnceLock<decision::Adapter>,
}
#[derive(Clone)]
pub struct Guardrails(Arc<Inner>);
pub struct Admission {
    pub effect: Effect,
    pub request: Option<guardrail::Request>,
    pub reservation: Option<Reservation>,
    pub wait: Option<Wait<Result<Reservation, Error>>>,
}

struct Reserved {
    service: Weak<Inner>,
    root: SessionId,
    kind: Option<Kind>,
    slot: u64,
    released: AtomicBool,
    queue: Option<Arc<ShellQueue>>,
}
#[derive(Clone)]
pub struct Reservation(Arc<Reserved>);
impl Reservation {
    pub fn release(&self) {
        self.0.release();
    }
    pub fn shell_admission(&self) -> Option<Arc<dyn ShellAdmission>> {
        self.0
            .queue
            .clone()
            .map(|queue| queue as Arc<dyn ShellAdmission>)
    }
    fn release_unlocked(&self, state: &mut State) -> Option<SessionId> {
        if self.0.released.swap(true, Ordering::AcqRel) {
            return None;
        }
        let kind = self.0.kind?;
        release_slot(state, &self.0.service, &self.0.root, kind, self.0.slot)
            .then(|| self.0.root.clone())
    }
}
impl Reserved {
    fn release(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(queue) = &self.queue {
            queue.close();
            return;
        }
        let (Some(service), Some(kind)) = (self.service.upgrade(), self.kind) else {
            return;
        };
        let wakes = {
            let mut state = service
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if release_slot(&mut state, &self.service, &self.root, kind, self.slot) {
                listeners(&state, &self.root)
            } else {
                Vec::new()
            }
        };
        wakes.iter().for_each(|wake| wake());
    }
}
impl Drop for Reserved {
    fn drop(&mut self) {
        self.release();
    }
}

struct ShellQueue {
    service: Weak<Inner>,
    root: SessionId,
    family: String,
    holder: Option<LosslessString>,
    closed: AtomicBool,
    claims: Mutex<Vec<Arc<Claim>>>,
}

impl ShellQueue {
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let claims = std::mem::take(
            &mut *self
                .claims
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        claims.iter().for_each(|claim| claim.release());
    }
}

impl ShellAdmission for ShellQueue {
    fn family(&self) -> &str {
        &self.family
    }

    fn acquire(&self) -> Option<Box<dyn FamilyReservation>> {
        if self.closed.load(Ordering::Acquire) {
            return None;
        }
        let service = self.service.upgrade()?;
        let mut state = service
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let key = (self.root.clone(), Kind::Shell);
        let pool = state.pools.get(&key);
        if pool.is_some_and(|pool| {
            !pool.waiters.is_empty() || pool.slots.len() as u64 >= service.settings.limits.shells
        }) {
            return None;
        }
        let slot = state.next_slot;
        state.next_slot += 1;
        state
            .pools
            .entry(key)
            .or_default()
            .slots
            .push((slot, self.holder.clone()));
        advance(&mut state, &self.root);
        drop(state);
        let claim = Arc::new(Claim {
            service: self.service.clone(),
            root: self.root.clone(),
            slot,
            state: AtomicU8::new(CLAIMED),
        });
        let mut claims = self
            .claims
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        claims.retain(|held| held.state.load(Ordering::Acquire) != RELEASED);
        claims.push(claim.clone());
        drop(claims);
        if self.closed.load(Ordering::Acquire) {
            claim.release();
            return None;
        }
        Some(Box::new(Token(claim)))
    }

    fn subscribe(&self, wake: Wake) -> Box<dyn FnOnce() + Send> {
        let Some(service) = self.service.upgrade() else {
            return Box::new(|| {});
        };
        let id = {
            let mut state = service
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let id = state.next_slot;
            state.next_slot += 1;
            state
                .listeners
                .entry(self.root.clone())
                .or_default()
                .insert(id, wake);
            id
        };
        let (service, root) = (self.service.clone(), self.root.clone());
        Box::new(move || {
            let Some(service) = service.upgrade() else {
                return;
            };
            let mut state = service
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(listeners) = state.listeners.get_mut(&root) {
                listeners.remove(&id);
                if listeners.is_empty() {
                    state.listeners.remove(&root);
                }
            }
        })
    }
}

const CLAIMED: u8 = 0;
const COMMITTED: u8 = 1;
const RELEASED: u8 = 2;

struct Claim {
    service: Weak<Inner>,
    root: SessionId,
    slot: u64,
    state: AtomicU8,
}

impl Claim {
    fn commit(&self) {
        let _ =
            self.state
                .compare_exchange(CLAIMED, COMMITTED, Ordering::AcqRel, Ordering::Acquire);
    }

    fn release(&self) {
        let previous = self.state.swap(RELEASED, Ordering::AcqRel);
        if previous == RELEASED {
            return;
        }
        let Some(service) = self.service.upgrade() else {
            return;
        };
        let wakes = {
            let mut state = service
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            release_slot(
                &mut state,
                &self.service,
                &self.root,
                Kind::Shell,
                self.slot,
            );
            if previous == COMMITTED {
                listeners(&state, &self.root)
            } else {
                Vec::new()
            }
        };
        wakes.iter().for_each(|wake| wake());
    }
}

struct Token(Arc<Claim>);

impl FamilyReservation for Token {
    fn commit(&self) {
        self.0.commit();
    }
    fn release(&self) {
        self.0.release();
    }
}

fn listeners(state: &State, root: &SessionId) -> Vec<Wake> {
    state
        .listeners
        .get(root)
        .map(|listeners| listeners.values().cloned().collect())
        .unwrap_or_default()
}

fn advance(state: &mut State, root: &SessionId) {
    *state.sequences.entry(root.clone()).or_default() += 1;
}
fn release_slot(
    state: &mut State,
    service: &Weak<Inner>,
    root: &SessionId,
    kind: Kind,
    slot: u64,
) -> bool {
    let key = (root.clone(), kind);
    if let Some(pool) = state.pools.get_mut(&key) {
        pool.slots.retain(|(id, _)| *id != slot);
        while let Some(waiter) = pool.waiters.pop_front() {
            pool.slots.push((waiter.id, waiter.holder));
            let granted = Reservation(Arc::new(Reserved {
                service: service.clone(),
                root: root.clone(),
                kind: Some(kind),
                slot: waiter.id,
                released: AtomicBool::new(false),
                queue: None,
            }));
            let Err(returned) = waiter.sender.send(Ok(granted)) else {
                break;
            };
            if let Ok(abandoned) = returned {
                abandoned.0.released.store(true, Ordering::Release);
            }
            pool.slots.retain(|(id, _)| *id != waiter.id);
        }
        if pool.slots.is_empty() && pool.waiters.is_empty() {
            state.pools.remove(&key);
        }
    }
    advance(state, root);
    kind == Kind::Shell
}
fn exceeded(state: &State, root: &SessionId, kind: Kind, limit: u64, waited_ms: u64) -> Error {
    let slots = state
        .pools
        .get(&(root.clone(), kind))
        .map_or(&[][..], |pool| pool.slots.as_slice());
    Error::CapExceeded {
        root_session_id: root.clone(),
        counter: kind.label(),
        current: slots.len() as u64,
        limit,
        holders: slots
            .iter()
            .filter_map(|(_, holder)| holder.clone())
            .collect(),
        waited_ms,
    }
}

impl Guardrails {
    pub fn new(
        authority: Authority,
        permissions: Permissions,
        settings: Settings,
        publish: Publisher,
    ) -> Self {
        Self(Arc::new(Inner {
            authority,
            permissions,
            settings,
            publish,
            state: Mutex::new(State::default()),
            reviews: OnceLock::new(),
            decision: OnceLock::new(),
        }))
    }

    pub fn with_reviews(self, reviews: Reviews) -> Self {
        let _ = self.0.reviews.set(reviews);
        self
    }

    pub fn with_decision(self, evaluator: Arc<dyn decision::Evaluator>) -> Self {
        let _ = self.0.decision.set(decision::Adapter {
            evaluator,
            redact: Arc::new(redact_value),
            policy: decision::ReviewPolicy {
                decide_reviews: self.0.settings.decide_reviews,
                decide_hard_reviews: self.0.settings.decide_hard_reviews,
            },
            limits: decision::Limits::default(),
        });
        self
    }

    pub fn review_policy(&self) -> ReviewPolicy {
        ReviewPolicy {
            enabled: self.0.settings.enabled,
            decide_reviews: self.0.settings.decide_reviews,
            decide_hard_reviews: self.0.settings.decide_hard_reviews,
        }
    }

    fn paths(&self, input: &Input) -> Paths {
        let workdir = input
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"workdir".into()))
            .and_then(|value| match value {
                JsonValue::String(value) => Some(value.clone()),
                _ => None,
            })
            .unwrap_or_else(|| self.0.settings.paths.workdir.clone());
        Paths {
            workdir,
            ..self.0.settings.paths.clone()
        }
    }

    pub fn evaluate(&self, input: &Input) -> Result<Evaluation, Error> {
        Ok(self.classify(input)?.0)
    }

    fn classify(&self, input: &Input) -> Result<(Evaluation, Vec<LosslessString>), Error> {
        self.classify_remaining(input, &[])
    }

    fn classify_remaining(
        &self,
        input: &Input,
        dismissed: &[LosslessString],
    ) -> Result<(Evaluation, Vec<LosslessString>), Error> {
        let root = self
            .0
            .authority
            .session(&input.session_id, None)?
            .root_session_id;
        let mut paths = self.paths(input);
        let custom = (self.0.settings.custom)();
        if !self.0.settings.enabled {
            let custom = custom
                .iter()
                .map(|layer| CustomLayer {
                    rules: layer
                        .rules
                        .iter()
                        .filter(|rule| rule.decision == guardrail::RuleDecision::HardReview)
                        .cloned()
                        .collect(),
                    invalid_files: vec![],
                })
                .collect::<Vec<_>>();
            let result =
                super::matched(&input.action, &input.resources, &paths, &custom, dismissed).0;
            return Ok((
                if result.effect == Effect::Deny || result.hard_review {
                    result
                } else {
                    Evaluation::allow()
                },
                vec![],
            ));
        }
        let result = super::matched(&input.action, &input.resources, &paths, &custom, dismissed).0;
        if !result.standard
            || result.rule_ids.first().and_then(LosslessString::as_str)
                != Some("standard.review.outside-repo")
            || input.skip_review
        {
            return Ok((result, vec![]));
        }
        let mut targets: Vec<super::OutsideTarget> = vec![];
        for target in input
            .resources
            .iter()
            .flat_map(|resource| super::outside_targets(&input.action, resource, &paths))
        {
            match targets
                .iter_mut()
                .find(|existing| existing.path == target.path)
            {
                Some(existing) => existing.directory |= target.directory,
                None => targets.push(target),
            }
        }
        let boundary = |target: &super::OutsideTarget| {
            if target.directory {
                target.path.clone()
            } else {
                super::dirname(&target.path)
            }
        };
        let approved = self.approved_directories(&root)?;
        let mut trusted = vec![];
        for target in &targets {
            if approved
                .iter()
                .any(|directory| super::within(&target.path, directory))
                || super::repository::contains(&self.0.settings.paths.workdir, &target.path)
                || self
                    .0
                    .settings
                    .global_roots
                    .iter()
                    .any(|root| super::within(&target.path, root))
            {
                trusted.push(target.path.clone());
                continue;
            }
            let mut resource = boundary(target).code_units().collect::<Vec<_>>();
            if resource.last() != Some(&47) {
                resource.push(47);
            }
            resource.push(42);
            let effect = self
                .0
                .permissions
                .evaluate_effective(
                    &input.session_id,
                    None,
                    &"external_directory".into(),
                    &LosslessString::from_utf16(resource),
                )
                .map_err(Error::Permission)?;
            if effect == Effect::Allow {
                trusted.push(target.path.clone());
            }
        }
        let mut directories = vec![];
        for target in targets
            .iter()
            .filter(|target| !trusted.contains(&target.path))
        {
            let directory = boundary(target);
            if !directories.contains(&directory) {
                directories.push(directory);
            }
        }
        paths.trusted_paths.extend(trusted);
        let resources = super::semantic_resources(&input.action, &input.resources, &paths);
        if resources
            .iter()
            .all(|resource| super::outside_targets(&input.action, resource, &paths).is_empty())
        {
            return Ok((Evaluation::allow(), vec![]));
        }
        Ok((result, directories))
    }

    fn approved_directories(&self, root: &SessionId) -> Result<Vec<LosslessString>, Error> {
        let snapshot = self.0.authority.store.snapshot().map_err(Error::Store)?;
        let prefix = tuple_key(&[
            KeyPart::String(root.as_lossless()),
            KeyPart::String(&APPROVED.into()),
        ]);
        let mut after = None;
        let mut directories = vec![];
        loop {
            let rows = snapshot
                .index_range::<EventTable>(
                    "event_aggregate_type_seq_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 128,
                    },
                )
                .map_err(Error::Store)?;
            if rows.is_empty() {
                return Ok(directories);
            }
            after = rows.last().map(|row| row.cursor.clone());
            for row in rows {
                let path = JsonPath::default();
                if let Ok(approved) = ObjectDecoder::new(&row.record.data, &path)
                    .and_then(|object| object.field::<Vec<LosslessString>>("directories"))
                {
                    directories.extend(approved);
                }
            }
        }
    }

    fn approve(&self, root: &SessionId, directories: &[LosslessString]) -> Result<(), Error> {
        let event = NewEvent {
            id: crate::session::projector::random_event_id()
                .map_err(Error::Store)?
                .as_lossless()
                .clone(),
            aggregate_id: root.as_lossless().clone(),
            created: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_millis() as i64,
            type_: APPROVED.into(),
            data: ObjectEncoder::new()
                .field("sessionID", root)
                .field("directories", &directories.to_vec())
                .finish(),
        };
        self.0
            .authority
            .store
            .submit(move |tx| crate::session::projector::append(tx, &event).map(|_| ()))
            .and_then(|receipt| receipt.wait())
            .map_err(Error::Store)
    }

    fn reserve(
        &self,
        state: &mut State,
        root: &SessionId,
        kind: Option<Kind>,
        holder: Option<LosslessString>,
    ) -> Result<Reservation, Error> {
        let slot = state.next_slot;
        if let Some(kind) = kind {
            let limit = kind.limit(self.0.settings.limits);
            if self.full(state, root, kind) {
                return Err(exceeded(state, root, kind, limit, 0));
            }
            state.next_slot += 1;
            state
                .pools
                .entry((root.clone(), kind))
                .or_default()
                .slots
                .push((slot, holder));
            advance(state, root);
        }
        Ok(Reservation(Arc::new(Reserved {
            service: Arc::downgrade(&self.0),
            root: root.clone(),
            kind,
            slot,
            released: AtomicBool::new(false),
            queue: None,
        })))
    }

    fn deferred_shell(&self, root: &SessionId, holder: Option<LosslessString>) -> Reservation {
        Reservation(Arc::new(Reserved {
            service: Arc::downgrade(&self.0),
            root: root.clone(),
            kind: None,
            slot: 0,
            released: AtomicBool::new(false),
            queue: Some(Arc::new(ShellQueue {
                service: Arc::downgrade(&self.0),
                root: root.clone(),
                family: root.as_lossless().to_utf8().unwrap_or_default(),
                holder,
                closed: AtomicBool::new(false),
                claims: Mutex::default(),
            })),
        }))
    }

    fn full(&self, state: &State, root: &SessionId, kind: Kind) -> bool {
        state
            .pools
            .get(&(root.clone(), kind))
            .map_or(0, |pool| pool.slots.len() as u64)
            >= kind.limit(self.0.settings.limits)
    }

    fn queue_shell(
        &self,
        state: &mut State,
        root: &SessionId,
        holder: Option<LosslessString>,
        request: Option<guardrail::RequestId>,
        sender: Sender,
    ) -> u64 {
        let id = state.next_slot;
        state.next_slot += 1;
        state
            .pools
            .entry((root.clone(), Kind::Shell))
            .or_default()
            .waiters
            .push_back(Waiter {
                id,
                holder,
                request,
                sender,
            });
        let service = Arc::downgrade(&self.0);
        let root = root.clone();
        let wait = self.0.settings.limits.shell_wait;
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            let Some(service) = service.upgrade() else {
                return;
            };
            let mut state = service
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let Some(waiter) = take_waiter(&mut state, &root, |waiter| waiter.id == id) else {
                return;
            };
            let error = exceeded(
                &state,
                &root,
                Kind::Shell,
                service.settings.limits.shells,
                wait.as_millis() as u64,
            );
            let _ = waiter.sender.send(Err(error));
        });
        id
    }

    fn abandon(&self, root: &SessionId, id: u64) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        take_waiter(&mut state, root, |waiter| waiter.id == id);
    }

    pub fn assert(&self, input: Input) -> Result<Admission, Error> {
        let (result, directories) = self.classify(&input)?;
        let authority = self.0.authority.session(&input.session_id, None)?;
        let granted = result.effect == Effect::Ask
            && !input.skip_review
            && (result.hard_review || !authority.root_autonomy.can_auto_guardrail())
            && self.consume(&input, &self.fingerprint(&input, &result))?;
        if result.effect == Effect::Ask
            && !granted
            && !input.skip_review
            && (result.hard_review || !authority.root_autonomy.can_auto_guardrail())
            && self.0.settings.decide_reviews
            && self.0.decision.get().is_some()
        {
            let cancellation = Cancellation::default();
            let id: guardrail::RequestId = state::decode_id("grq_", 0);
            let review = {
                let mut state = self
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let review = self.reserve(
                    &mut state,
                    &authority.root_session_id,
                    Some(Kind::Review),
                    None,
                )?;
                state
                    .deciding
                    .insert(id.clone(), (input.session_id.clone(), cancellation.clone()));
                review
            };
            let (sender, receiver) = oneshot::channel();
            let service = self.clone();
            let cancel = cancellation.clone();
            let cancel_id = id.clone();
            let task = tokio::spawn(async move {
                let outcome = service
                    .decide(&input, result, directories, &cancellation)
                    .await;
                service
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .deciding
                    .remove(&id);
                review.release();
                let outcome = match outcome {
                    Ok((result, directories, grading)) if !cancellation.is_cancelled() => {
                        match service.admit(input, result, directories, Some(grading), false) {
                            Ok(admission) => match admission.wait {
                                Some(wait) => tokio::select! {
                                    biased;
                                    _ = cancellation.cancelled() => Err(Error::Declined),
                                    settled = wait => settled.unwrap_or(Err(Error::Declined)),
                                },
                                None => admission.reservation.ok_or(Error::Declined),
                            },
                            Err(error) => Err(error),
                        }
                    }
                    Ok(_) => Err(Error::Declined),
                    Err(error) => Err(error),
                };
                let _ = sender.send(outcome);
            });
            let service = self.clone();
            let task = state::Task::new(task, move || {
                cancel.cancel();
                service
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .deciding
                    .remove(&cancel_id);
            });
            return Ok(Admission {
                effect: Effect::Ask,
                request: None,
                reservation: None,
                wait: Some(Wait::new(receiver, move || drop(task))),
            });
        }
        let grading = (result.effect == Effect::Ask
            && !granted
            && !input.skip_review
            && (result.hard_review || !authority.root_autonomy.can_auto_guardrail())
            && self.0.settings.decide_reviews)
            .then(|| {
                if result.hard_review && !self.0.settings.decide_hard_reviews {
                    decision::Grading::Skipped(decision::Skip::Disabled)
                } else {
                    decision::Grading::Escalated {
                        reason: session_review::Reason::Error,
                        provenance: guardrail::Escalation {
                            choice: None,
                            confidence: None,
                            grades: None,
                        },
                    }
                }
            });
        self.admit(input, result, directories, grading, granted)
    }

    async fn decide(
        &self,
        input: &Input,
        mut result: Evaluation,
        mut directories: Vec<LosslessString>,
        cancellation: &Cancellation,
    ) -> Result<(Evaluation, Vec<LosslessString>, decision::Grading), Error> {
        let adapter = self.0.decision.get().expect("installed decision adapter");
        let mut dismissed = vec![];
        loop {
            let authority = self.0.authority.session(&input.session_id, None)?;
            let paths = self.paths(input);
            let evidence = super::matched(
                &input.action,
                &input.resources,
                &paths,
                &(self.0.settings.custom)(),
                &dismissed,
            )
            .1
            .map(|evidence| decision::MatchEvidence {
                matched_segment: evidence.matched_segment,
                resolved_targets: evidence.resolved_targets,
                workdir: paths.workdir.clone(),
                project: paths.project.clone(),
            });
            let invocation = || crate::resources::decision::Invocation {
                session_id: &input.session_id,
                input_id: input.source.as_ref().map(|source| &source.message_id),
                cancellation,
                attribution: crate::session::usage_attribution::Attribution::Unset,
            };
            match adapter
                .verify(
                    &decision::Match {
                        action: &input.action,
                        resources: &input.resources,
                        evaluation: &result,
                        skip_review: input.skip_review,
                        ordinary_auto: authority.root_autonomy.can_auto_guardrail(),
                        evidence: evidence.as_ref(),
                    },
                    invocation(),
                )
                .await
            {
                decision::Verification::Cancelled => return Err(Error::Declined),
                decision::Verification::Dismissed {
                    rule_id,
                    confidence,
                } => {
                    self.provenance(
                        &authority.root_session_id,
                        "session.guardrail.dismissed.1",
                        ObjectEncoder::new()
                            .field("sessionID", &authority.root_session_id)
                            .field("reviewSessionID", &input.session_id)
                            .field("ruleID", &rule_id)
                            .field("confidence", &confidence)
                            .optional("source", &input.source)
                            .finish(),
                    )?;
                    dismissed.push(rule_id);
                    (result, directories) = self.classify_remaining(input, &dismissed)?;
                }
                _ => break,
            }
        }
        let authority = self.0.authority.session(&input.session_id, None)?;
        let grading = adapter
            .grade(
                &decision::Review {
                    action: &input.action,
                    resources: &input.resources,
                    evaluation: &result,
                    root_session_id: &authority.root_session_id,
                    workdir: &self.paths(input).workdir,
                    allow_always: !directories.is_empty(),
                    skip_review: input.skip_review,
                    ordinary_auto: authority.root_autonomy.can_auto_guardrail(),
                },
                crate::resources::decision::Invocation {
                    session_id: &input.session_id,
                    input_id: input.source.as_ref().map(|source| &source.message_id),
                    cancellation,
                    attribution: crate::session::usage_attribution::Attribution::Unset,
                },
            )
            .await;
        if matches!(grading, decision::Grading::Cancelled) {
            return Err(Error::Declined);
        }
        Ok((result, directories, grading))
    }

    fn provenance(&self, session: &SessionId, type_: &str, data: JsonValue) -> Result<(), Error> {
        let event = NewEvent {
            id: crate::session::projector::random_event_id()
                .map_err(Error::Store)?
                .as_lossless()
                .clone(),
            aggregate_id: session.as_lossless().clone(),
            created: now(),
            type_: type_.into(),
            data,
        };
        self.0
            .authority
            .store
            .submit(move |tx| crate::session::projector::append(tx, &event).map(|_| ()))
            .and_then(|receipt| receipt.wait())
            .map_err(Error::Store)
    }

    fn admit(
        &self,
        input: Input,
        result: Evaluation,
        directories: Vec<LosslessString>,
        grading: Option<decision::Grading>,
        granted: bool,
    ) -> Result<Admission, Error> {
        let authority = self.0.authority.session(&input.session_id, None)?;
        let root = authority.root_session_id;
        let action_kind = match input.action.as_str() {
            "shell" => Some(Kind::Shell),
            "subagent" => Some(Kind::Subagent),
            _ => None,
        };
        let automatic = result.effect == Effect::Allow
            || input.skip_review
            || (result.effect == Effect::Ask
                && !result.hard_review
                && authority.root_autonomy.can_auto_guardrail());
        let fingerprint = self.fingerprint(&input, &result);
        let granted = granted
            || (result.effect == Effect::Ask
                && !automatic
                && self.consume(&input, &fingerprint)?);
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if result.effect == Effect::Deny {
            *state.blocked.entry(root.clone()).or_default() += 1;
            advance(&mut state, &root);
            state::emit::<guardrail::Decided>(
                &self.0.publish,
                &guardrail::DecidedData {
                    root_session_id: root,
                    session_id: input.session_id,
                    action: input.action.into(),
                    rule_ids: result.rule_ids.clone(),
                    decision: guardrail::Decision::Deny,
                },
            )
            .map_err(Error::Publish)?;
            return Err(Error::Blocked(result));
        }
        if automatic || granted {
            let decided = guardrail::DecidedData {
                root_session_id: root.clone(),
                session_id: input.session_id,
                action: input.action.into(),
                rule_ids: result.rule_ids,
                decision: guardrail::Decision::Allow,
            };
            if action_kind == Some(Kind::Shell) && input.defer_shell {
                state::emit::<guardrail::Decided>(&self.0.publish, &decided)
                    .map_err(Error::Publish)?;
                return Ok(Admission {
                    effect: Effect::Allow,
                    request: None,
                    reservation: Some(self.deferred_shell(&root, input.holder)),
                    wait: None,
                });
            }
            if action_kind == Some(Kind::Shell) && self.full(&state, &root, Kind::Shell) {
                state::emit::<guardrail::Decided>(&self.0.publish, &decided)
                    .map_err(Error::Publish)?;
                let (sender, receiver) = oneshot::channel();
                let id = self.queue_shell(&mut state, &root, input.holder, None, sender);
                let service = self.clone();
                return Ok(Admission {
                    effect: Effect::Allow,
                    request: None,
                    reservation: None,
                    wait: Some(Wait::new(receiver, move || service.abandon(&root, id))),
                });
            }
            let reservation = self.reserve(&mut state, &root, action_kind, input.holder)?;
            if let Err(error) = state::emit::<guardrail::Decided>(&self.0.publish, &decided) {
                let wakes = reservation
                    .release_unlocked(&mut state)
                    .map_or_else(Vec::new, |root| listeners(&state, &root));
                drop(state);
                wakes.iter().for_each(|wake| wake());
                return Err(Error::Publish(error));
            }
            return Ok(Admission {
                effect: Effect::Allow,
                request: None,
                reservation: Some(reservation),
                wait: None,
            });
        }
        let mut request = guardrail::Request {
            id: state::decode_id("grq_", 0),
            root_session_id: root.clone(),
            session_id: input.session_id,
            action: input.action.into(),
            resources: input.resources,
            rule_ids: result.rule_ids,
            reason: result
                .reason
                .unwrap_or_else(|| "Session guardrail review required".into()),
            standard: result.standard,
            hard_review: result.hard_review.then_some(true),
            risk: None,
            escalation: None,
            metadata: input.metadata,
        };
        if let Some(decision::Grading::Settled { reply, provenance }) = &grading {
            drop(state);
            self.provenance(
                &root,
                "session.guardrail.decided.1",
                ObjectEncoder::new()
                    .field("sessionID", &root)
                    .field("reviewSessionID", &request.session_id)
                    .field("requestID", &request.id)
                    .field("reply", reply)
                    .optional("choice", &provenance.choice)
                    .optional("confidence", &provenance.confidence)
                    .optional("grades", &provenance.grades)
                    .field("ruleIDs", &request.rule_ids)
                    .optional("source", &input.source)
                    .finish(),
            )?;
            state::emit::<guardrail::Replied>(
                &self.0.publish,
                &guardrail::RepliedData {
                    root_session_id: root.clone(),
                    session_id: request.session_id.clone(),
                    request_id: request.id.clone(),
                    reply: *reply,
                    decided_by: Some(guardrail::DecidedBy::DecisionModel),
                    choice: provenance.choice,
                    confidence: provenance.confidence,
                    grades: provenance.grades.clone(),
                },
            )
            .map_err(Error::Publish)?;
            if *reply == guardrail::Reply::Reject {
                self.incident(&request, input.source.as_ref(), Some("decision-model"))?;
                return Err(Error::Declined);
            }
            if *reply == guardrail::Reply::Always {
                self.approve(&root, &directories)?;
            }
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            *state.approvals.entry(root.clone()).or_default() += 1;
            advance(&mut state, &root);
            if input.defer_shell && action_kind == Some(Kind::Shell) {
                return Ok(Admission {
                    effect: Effect::Allow,
                    request: None,
                    reservation: Some(self.deferred_shell(&root, input.holder)),
                    wait: None,
                });
            }
            if action_kind == Some(Kind::Shell) && self.full(&state, &root, Kind::Shell) {
                let (sender, receiver) = oneshot::channel();
                let id = self.queue_shell(&mut state, &root, input.holder, None, sender);
                let service = self.clone();
                return Ok(Admission {
                    effect: Effect::Allow,
                    request: None,
                    reservation: None,
                    wait: Some(Wait::new(receiver, move || service.abandon(&root, id))),
                });
            }
            return Ok(Admission {
                effect: Effect::Allow,
                request: None,
                reservation: Some(self.reserve(&mut state, &root, action_kind, input.holder)?),
                wait: None,
            });
        }
        if let Some(decision::Grading::Escalated { provenance, .. }) = &grading {
            request.escalation = Some(provenance.clone());
        }
        if (authority.root_autonomy.asleep || authority.autonomy.asleep)
            && let Some(reviews) = self.0.reviews.get().cloned()
        {
            drop(state);
            let (sender, receiver) = oneshot::channel();
            let inner = self.0.clone();
            let deferred = request.clone();
            let reason = match &grading {
                Some(decision::Grading::Escalated { reason, .. }) => *reason,
                Some(decision::Grading::Skipped(decision::Skip::Disabled)) => {
                    session_review::Reason::Disabled
                }
                _ if self.0.settings.decide_reviews => session_review::Reason::Error,
                _ => session_review::Reason::Disabled,
            };
            tokio::spawn(async move {
                let outcome = open_review(
                    &inner,
                    &reviews,
                    Deferring {
                        request: &deferred,
                        source: input.source.as_ref(),
                        directories: &directories,
                        fingerprint,
                        reason,
                        conversion: false,
                    },
                )
                .await;
                let _ = sender.send(outcome);
            });
            return Ok(Admission {
                effect: Effect::Ask,
                request: Some(request),
                reservation: None,
                wait: Some(Wait::new(receiver, || {})),
            });
        }
        let review = self.reserve(&mut state, &root, Some(Kind::Review), None)?;
        if let Some(provenance) = &request.escalation {
            let recorded = self
                .provenance(
                    &request.session_id,
                    "session.guardrail.escalated.1",
                    ObjectEncoder::new()
                        .field("sessionID", &request.session_id)
                        .field("requestID", &request.id)
                        .optional("choice", &provenance.choice)
                        .optional("confidence", &provenance.confidence)
                        .optional("grades", &provenance.grades)
                        .field("ruleIDs", &request.rule_ids)
                        .optional("source", &input.source)
                        .finish(),
                )
                .and_then(|_| self.incident(&request, input.source.as_ref(), None));
            if let Err(error) = recorded {
                review.release_unlocked(&mut state);
                return Err(error);
            }
        }
        let (sender, receiver) = oneshot::channel();
        let id = request.id.clone();
        state.pending.insert(
            id.clone(),
            Pending {
                request: request.clone(),
                sender,
                review,
                directories,
                holder: input.holder,
                defer_shell: input.defer_shell && action_kind == Some(Kind::Shell),
                source: input.source,
                fingerprint,
            },
        );
        advance(&mut state, &root);
        if let Err(error) = state::emit::<guardrail::Asked>(&self.0.publish, &request) {
            remove_pending(&mut state, &id);
            return Err(Error::Publish(error));
        }
        let service = self.clone();
        Ok(Admission {
            effect: Effect::Ask,
            request: Some(request),
            reservation: None,
            wait: Some(Wait::new(receiver, move || {
                service.cancel(&id);
            })),
        })
    }

    pub async fn defer_pending(&self, session: &SessionId) -> Result<usize, Error> {
        let Some(reviews) = self.0.reviews.get().cloned() else {
            return Ok(0);
        };
        let items = {
            let mut state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let ids = state
                .pending
                .iter()
                .filter(|(_, item)| &item.request.session_id == session)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.iter()
                .filter_map(|id| remove_pending(&mut state, id))
                .collect::<Vec<_>>()
        };
        let mut deferred = 0;
        for item in items {
            let outcome = open_review(
                &self.0,
                &reviews,
                Deferring {
                    request: &item.request,
                    source: item.source.as_ref(),
                    directories: &item.directories,
                    fingerprint: item.fingerprint.clone(),
                    reason: session_review::Reason::SleepEntry,
                    conversion: true,
                },
            )
            .await;
            if matches!(outcome, Err(Error::Deferred { .. })) {
                deferred += 1;
            }
            let _ = item.sender.send(outcome);
        }
        Ok(deferred)
    }

    fn fingerprint(&self, input: &Input, result: &Evaluation) -> session_review::Fingerprint {
        review::fingerprint(&FingerprintInput {
            action: input.action.as_str().into(),
            resources: input.resources.clone(),
            workdir: self.paths(input).workdir,
            rule_ids: result.rule_ids.clone(),
            hard_review: result.hard_review,
            metadata: input.metadata.clone(),
        })
    }

    fn consume(
        &self,
        input: &Input,
        fingerprint: &session_review::Fingerprint,
    ) -> Result<bool, Error> {
        let Some(reviews) = self.0.reviews.get() else {
            return Ok(false);
        };
        reviews
            .service
            .consume_now(&input.session_id, GrantKind::Guardrail, fingerprint, now())
            .map_err(Error::Review)
    }

    fn reject_incident(&self, item: &Pending) -> Result<(), Error> {
        self.incident(&item.request, item.source.as_ref(), Some("human"))
    }

    fn incident(
        &self,
        request: &guardrail::Request,
        source: Option<&guardrail::Source>,
        decided_by: Option<&str>,
    ) -> Result<(), Error> {
        let input = GuardrailInput {
            session_id: request.session_id.clone(),
            request_id: request.id.clone(),
            message_id: source.map(|source| source.message_id.clone()),
            rule_ids: request.rule_ids.clone(),
            hard_review: request.hard_review == Some(true),
            time: now(),
        };
        let id: model_incident::Id = state::decode_id("inc_", 0);
        let decided_by = decided_by.map(|value| {
            model_incident::DecidedBy::decode(&JsonValue::String(value.into()))
                .expect("guardrail decider")
        });
        self.0
            .authority
            .store
            .submit(move |tx| match decided_by {
                Some(decided_by) => incidents::rejection(tx, &id, &input, &decided_by).map(|_| ()),
                None => incidents::escalation(tx, &id, &input).map(|_| ()),
            })
            .and_then(|receipt| receipt.wait())
            .map_err(Error::Store)
    }

    pub fn reply(
        &self,
        session: &SessionId,
        id: &guardrail::RequestId,
        reply: guardrail::Reply,
    ) -> Result<(), Error> {
        let root = self.0.authority.session(session, None)?.root_session_id;
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let item = state.pending.get(id).ok_or(Error::NotFound)?;
        if item.request.root_session_id != root {
            return Err(Error::NotFound);
        }
        let item = remove_pending(&mut state, id).expect("pending request held by lock");
        let reply = if item.request.hard_review == Some(true) && reply == guardrail::Reply::Always {
            guardrail::Reply::Reject
        } else {
            reply
        };
        if let Err(error) = state::emit::<guardrail::Replied>(
            &self.0.publish,
            &guardrail::RepliedData {
                root_session_id: root.clone(),
                session_id: item.request.session_id.clone(),
                request_id: id.clone(),
                reply,
                decided_by: None,
                choice: None,
                confidence: None,
                grades: None,
            },
        ) {
            let _ = item.sender.send(Err(Error::Declined));
            return Err(Error::Publish(error));
        }
        if reply == guardrail::Reply::Reject {
            let recorded = self.reject_incident(&item);
            let _ = item.sender.send(Err(Error::Declined));
            return recorded;
        }
        if reply == guardrail::Reply::Always && !item.directories.is_empty() {
            if let Err(error) = self.approve(&root, &item.directories) {
                let _ = item.sender.send(Err(Error::Declined));
                return Err(error);
            }
            advance(&mut state, &root);
        }
        *state.approvals.entry(root.clone()).or_default() += 1;
        advance(&mut state, &root);
        if item.defer_shell {
            let _ = item
                .sender
                .send(Ok(self.deferred_shell(&root, item.holder)));
            return Ok(());
        }
        let kind = match item.request.action.as_str() {
            Some("shell") => Some(Kind::Shell),
            Some("subagent") => Some(Kind::Subagent),
            _ => None,
        };
        if kind == Some(Kind::Shell) && self.full(&state, &root, Kind::Shell) {
            self.queue_shell(
                &mut state,
                &root,
                item.holder,
                Some(id.clone()),
                item.sender,
            );
            return Ok(());
        }
        let reservation = self.reserve(&mut state, &root, kind, item.holder);
        let freed = match item.sender.send(reservation) {
            Err(Ok(reservation)) => reservation.release_unlocked(&mut state),
            _ => None,
        };
        let wakes = freed.map_or_else(Vec::new, |root| listeners(&state, &root));
        drop(state);
        wakes.iter().for_each(|wake| wake());
        Ok(())
    }

    pub fn cancel(&self, id: &guardrail::RequestId) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((_, cancellation)) = state.deciding.get(id) {
            cancellation.cancel();
        }
        if let Some(item) = remove_pending(&mut state, id) {
            let _ = item.sender.send(Err(Error::Declined));
            return;
        }
        let queued = state.pools.iter().find_map(|((root, _), pool)| {
            pool.waiters
                .iter()
                .any(|waiter| waiter.request.as_ref() == Some(id))
                .then(|| root.clone())
        });
        if let Some(root) = queued {
            take_waiter(&mut state, &root, |waiter| {
                waiter.request.as_ref() == Some(id)
            });
        }
    }
    pub fn for_session(&self, session: &SessionId) -> Result<Vec<guardrail::Request>, Error> {
        let root = self.0.authority.session(session, None)?.root_session_id;
        Ok(self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pending
            .values()
            .filter(|item| item.request.root_session_id == root)
            .map(|item| item.request.clone())
            .collect())
    }
    pub fn cancel_session(&self, session: &SessionId) {
        let ids = {
            let state = self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for (id, cancellation) in state.deciding.values() {
                if id == session {
                    cancellation.cancel();
                }
            }
            state
                .pending
                .iter()
                .filter(|(_, item)| &item.request.session_id == session)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>()
        };
        for id in ids {
            self.cancel(&id);
        }
    }
    pub fn status(&self, session: &SessionId) -> Result<guardrail::Status, Error> {
        let root = self.0.authority.session(session, None)?.root_session_id;
        let mut status = self.status_unlocked(
            &self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
            &root,
        );
        self.history_status(&mut status)?;
        Ok(status)
    }

    fn history_status(&self, status: &mut guardrail::Status) -> Result<(), Error> {
        let snapshot = self.0.authority.store.snapshot().map_err(Error::Store)?;
        let members = crate::session::family::members(
            &mut crate::session::family::Reader::Snapshot(&snapshot),
            status.root_session_id.as_lossless(),
        )
        .map_err(Error::Store)?;
        let mut dismissals = vec![];
        let mut decisions = vec![];
        for member in members {
            for type_ in [
                "session.guardrail.dismissed.1",
                "session.guardrail.decided.1",
            ] {
                let prefix = tuple_key(&[KeyPart::String(&member), KeyPart::String(&type_.into())]);
                let mut after = None;
                loop {
                    let rows = snapshot
                        .index_range::<EventTable>(
                            "event_aggregate_type_seq_idx",
                            IndexQuery {
                                lower: Bound::Unbounded,
                                upper: Bound::Unbounded,
                                prefix: Some(&prefix),
                                order: IndexOrder::Ascending,
                                after: after.as_ref(),
                                limit: 128,
                            },
                        )
                        .map_err(Error::Store)?;
                    if rows.is_empty() {
                        break;
                    }
                    after = rows.last().map(|row| row.cursor.clone());
                    for row in rows {
                        let path = JsonPath::default();
                        let parsed = (|| {
                            let object = ObjectDecoder::new(&row.record.data, &path)?;
                            let session_id = object
                                .optional("reviewSessionID")?
                                .unwrap_or(SessionId::decode(&JsonValue::String(member.clone()))?);
                            let created = NonNegativeInt::decode(&JsonValue::Number(
                                row.record.created as f64,
                            ))?;
                            if type_ == "session.guardrail.dismissed.1" {
                                let confidence: guardrail::Confidence =
                                    object.field("confidence")?;
                                dismissals.push(guardrail::Dismissal {
                                    session_id,
                                    created,
                                    event_id: row.record.id.clone(),
                                    rule_id: object.field("ruleID")?,
                                    confidence: confidence.get(),
                                    source: object.optional("source")?,
                                });
                            } else {
                                decisions.push(guardrail::StatusDecision {
                                    session_id,
                                    created,
                                    request_id: object.field("requestID")?,
                                    reply: object.field("reply")?,
                                    choice: object.optional("choice")?,
                                    confidence: object.optional("confidence")?,
                                    grades: object.optional("grades")?,
                                    rule_ids: object.optional("ruleIDs")?,
                                    source: object.optional("source")?,
                                });
                            }
                            Ok::<_, ycoding_schema::DecodeError>(())
                        })();
                        parsed.map_err(|error| {
                            Error::Store(ycoding_store::Error::Record(Box::new(error)))
                        })?;
                    }
                }
            }
        }
        dismissals.sort_by(|left, right| {
            (left.created.get(), &left.event_id).cmp(&(right.created.get(), &right.event_id))
        });
        decisions.sort_by(|left, right| {
            (left.created.get(), &left.request_id).cmp(&(right.created.get(), &right.request_id))
        });
        status.dismissals = (!dismissals.is_empty()).then_some(dismissals);
        status.decisions = (!decisions.is_empty()).then_some(decisions);
        Ok(())
    }
    fn status_unlocked(&self, state: &State, root: &SessionId) -> guardrail::Status {
        let custom = (self.0.settings.custom)();
        let number =
            |value: u64| NonNegativeInt::new(value as i64).expect("bounded guardrail count");
        guardrail::Status {
            root_session_id: root.clone(),
            profile: if self.0.settings.enabled {
                "standard"
            } else {
                "disabled"
            }
            .into(),
            custom_rules: number(custom.iter().map(|layer| layer.rules.len() as u64).sum()),
            approvals: number(state.approvals.get(root).copied().unwrap_or_default()),
            blocked: number(state.blocked.get(root).copied().unwrap_or_default()),
            counters: [Kind::Shell, Kind::Subagent, Kind::Review]
                .iter()
                .map(|kind| guardrail::Counter {
                    id: kind.label().into(),
                    current: number(
                        state
                            .pools
                            .get(&(root.clone(), *kind))
                            .map_or(0, |pool| pool.slots.len() as u64),
                    ),
                    limit: number(kind.limit(self.0.settings.limits)),
                    scope: guardrail::CounterScope::Family,
                })
                .collect(),
            invalid_files: custom
                .iter()
                .flat_map(|layer| layer.invalid_files.clone())
                .collect(),
            dismissals: None,
            decisions: None,
        }
    }
    pub fn snapshot(&self, session: &SessionId) -> Result<Snapshot, Error> {
        self.with_snapshot(session, |snapshot| snapshot)
    }
    pub fn with_snapshot<T>(
        &self,
        session: &SessionId,
        use_snapshot: impl FnOnce(Snapshot) -> T,
    ) -> Result<T, Error> {
        let root = self.0.authority.session(session, None)?.root_session_id;
        let mut approved = self.approved_directories(&root)?;
        approved.sort();
        approved.dedup();
        let state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut status = self.status_unlocked(&state, &root);
        self.history_status(&mut status)?;
        status
            .counters
            .sort_by(|left, right| left.id.cmp(&right.id));
        status.invalid_files.sort();
        let pending = state
            .pending
            .values()
            .filter(|item| item.request.root_session_id == root)
            .map(|item| {
                ObjectEncoder::new()
                    .field("id", &item.request.id)
                    .field("rootSessionID", &item.request.root_session_id)
                    .field("sessionID", &item.request.session_id)
                    .field("action", &item.request.action)
                    .field("resources", &item.request.resources)
                    .field("ruleIDs", &item.request.rule_ids)
                    .field("reason", &item.request.reason)
                    .field("standard", &item.request.standard)
                    .field("hardReview", &item.request.hard_review.unwrap_or(false))
                    .optional("escalation", &item.request.escalation)
                    .field(
                        "risk",
                        &item
                            .request
                            .risk
                            .as_ref()
                            .map_or(JsonValue::Null, DomainEncode::encode),
                    )
                    .field(
                        "metadata",
                        &item
                            .request
                            .metadata
                            .as_ref()
                            .map_or(JsonValue::Null, DomainEncode::encode),
                    )
                    .finish()
            })
            .collect::<Vec<_>>();
        let content = ObjectEncoder::new()
            .field("status", &status)
            .field("pending", &pending)
            .field("approvedDirectories", &approved)
            .finish();
        let digest = ring::digest::digest(&ring::digest::SHA256, canonical(&content).as_bytes())
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(use_snapshot(Snapshot {
            sequence: state.sequences.get(&root).copied().unwrap_or_default(),
            digest,
        }))
    }
    pub fn shutdown(&self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for (_, cancellation) in state.deciding.values() {
            cancellation.cancel();
        }
        let ids = state.pending.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            if let Some(item) = remove_pending(&mut state, &id) {
                let _ = item.sender.send(Err(Error::Declined));
            }
        }
        for waiter in state
            .pools
            .values_mut()
            .flat_map(|pool| std::mem::take(&mut pool.waiters))
            .collect::<Vec<_>>()
        {
            let _ = waiter.sender.send(Err(Error::Declined));
        }
        state.pools.retain(|_, pool| !pool.slots.is_empty());
    }
}

fn take_waiter(
    state: &mut State,
    root: &SessionId,
    matches: impl Fn(&Waiter) -> bool,
) -> Option<Waiter> {
    let key = (root.clone(), Kind::Shell);
    let pool = state.pools.get_mut(&key)?;
    let waiter = pool.waiters.remove(pool.waiters.iter().position(matches)?);
    if pool.slots.is_empty() && pool.waiters.is_empty() {
        state.pools.remove(&key);
    }
    waiter
}

fn remove_pending(state: &mut State, id: &guardrail::RequestId) -> Option<Pending> {
    let item = state.pending.remove(id)?;
    advance(state, &item.request.root_session_id);
    item.review.release_unlocked(state);
    Some(item)
}
fn canonical(value: &JsonValue) -> String {
    match value {
        JsonValue::Object(object) => {
            let mut keys = object.iter().map(|(key, _)| key).collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        stringify_json(&key.encode()),
                        canonical(object.get(key).expect("collected key"))
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        JsonValue::Array(array) => format!(
            "[{}]",
            array.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => stringify_json(value),
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub sequence: u64,
    pub digest: String,
}

struct Deferring<'a> {
    request: &'a guardrail::Request,
    source: Option<&'a guardrail::Source>,
    directories: &'a [LosslessString],
    fingerprint: session_review::Fingerprint,
    reason: session_review::Reason,
    conversion: bool,
}

async fn open_review(
    inner: &Inner,
    reviews: &Reviews,
    deferring: Deferring<'_>,
) -> Result<Reservation, Error> {
    let request = deferring.request;
    let origin = match deferring.source {
        Some(source) => session_review::Origin::Tool {
            message_id: source.message_id.clone(),
            call_id: source.call_id.clone(),
        },
        None => session_review::Origin::Request {
            request_id: match request.id.encode() {
                JsonValue::String(id) => id,
                _ => {
                    return Err(Error::Store(ycoding_store::Error::Rejected(
                        "guardrail request ID",
                    )));
                }
            },
        },
    };
    let opened = reviews
        .service
        .open(OpenInput {
            session_id: request.session_id.clone(),
            kind: session_review::Kind::Guardrail,
            reason: deferring.reason,
            choice: request
                .escalation
                .as_ref()
                .and_then(|value| value.choice)
                .map(|choice| match choice.encode() {
                    JsonValue::String(value) => value,
                    _ => unreachable!("choice is text"),
                }),
            confidence: request
                .escalation
                .as_ref()
                .and_then(|value| value.confidence),
            grades: request
                .escalation
                .as_ref()
                .and_then(|value| value.grades.clone()),
            origin,
            payload: session_review::Payload::Guardrail(session_review::GuardrailPayload {
                action: redact(&request.action),
                resources: request.resources.iter().map(redact).collect(),
                rule_ids: request.rule_ids.clone(),
                reason: request.reason.clone(),
                hard_review: request.hard_review == Some(true),
                directories: deferring.directories.to_vec(),
                fingerprint: deferring.fingerprint,
                request_id: request.id.clone(),
            }),
            limit: reviews.limit,
            conversion: deferring.conversion,
            created: now(),
        })
        .await;
    let item = match opened {
        Ok(item) => item,
        Err(review::Error::Full { limit, .. }) => return Err(Error::ReviewFull { limit }),
        Err(error) => return Err(Error::Review(error)),
    };
    state::emit::<guardrail::Deferred>(
        &inner.publish,
        &guardrail::DeferredData {
            root_session_id: request.root_session_id.clone(),
            session_id: request.session_id.clone(),
            request_id: request.id.clone(),
            item_id: item.deferral.item_id.clone(),
        },
    )
    .map_err(Error::Publish)?;
    Err(Error::Deferred {
        request_id: request.id.clone(),
        item_id: item.deferral.item_id,
        rule_ids: request.rule_ids.clone(),
    })
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_millis() as i64
}

const REDACTED: &str = "[redacted]";

fn redact_value(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::String(value) => JsonValue::String(redact(value)),
        JsonValue::Array(values) => JsonValue::Array(values.iter().map(redact_value).collect()),
        JsonValue::Object(values) => JsonValue::Object(values.iter().fold(
            JsonObject::new(),
            |mut object, (key, value)| {
                object.insert(
                    key.clone(),
                    if sensitive(
                        &String::from_utf16_lossy(&key.code_units().collect::<Vec<_>>()),
                        &SENSITIVE,
                    ) {
                        JsonValue::String(REDACTED.into())
                    } else {
                        redact_value(value)
                    },
                );
                object
            },
        )),
        value => value.clone(),
    }
}
const SENSITIVE: [&str; 7] = [
    "password",
    "secret",
    "token",
    "credential",
    "authorization",
    "apikey",
    "privatekey",
];
const ASSIGNED: [&str; 6] = [
    "password",
    "secret",
    "token",
    "apikey",
    "authorization",
    "credential",
];

fn redact(value: &LosslessString) -> LosslessString {
    let mut text = String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>());
    for (_, secret) in std::env::vars()
        .filter(|(key, secret)| secret.chars().count() >= 4 && sensitive(key, &SENSITIVE))
    {
        text = text.replace(&secret, REDACTED);
    }
    text = redact_private_keys(&text);
    text = redact_assignments(&text);
    text = redact_bearer(&text);
    redact_url_credentials(&text).into()
}

fn sensitive(name: &str, words: &[&str]) -> bool {
    let folded = name
        .chars()
        .filter(|character| !matches!(character, '-' | '_'))
        .collect::<String>()
        .to_ascii_lowercase();
    words.iter().any(|word| folded.contains(word))
}

fn redact_private_keys(text: &str) -> String {
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("-----BEGIN ") {
        let Some(header) = rest[start..].find("PRIVATE KEY-----") else {
            break;
        };
        let after_header = start + header + "PRIVATE KEY-----".len();
        let Some(end) = rest[after_header..].find("-----END ") else {
            break;
        };
        let footer_start = after_header + end;
        let Some(footer) = rest[footer_start..].find("PRIVATE KEY-----") else {
            break;
        };
        output.push_str(&rest[..start]);
        output.push_str(REDACTED);
        rest = &rest[footer_start + footer + "PRIVATE KEY-----".len()..];
    }
    output.push_str(rest);
    output
}

fn word(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
}

fn redact_assignments(text: &str) -> String {
    let characters = text.char_indices().collect::<Vec<_>>();
    let mut output = String::new();
    let mut copied = 0;
    let mut index = 0;
    while index < characters.len() {
        let (start, character) = characters[index];
        if !word(character) || (index > 0 && word(characters[index - 1].1)) {
            index += 1;
            continue;
        }
        let mut end = index;
        while end < characters.len() && word(characters[end].1) {
            end += 1;
        }
        let name = &text[start..characters.get(end).map_or(text.len(), |entry| entry.0)];
        if !sensitive(name, &ASSIGNED) {
            index = end;
            continue;
        }
        let mut cursor = end;
        if cursor < characters.len() && matches!(characters[cursor].1, '"' | '\'') {
            cursor += 1;
        }
        let spaced =
            |position: usize| position < characters.len() && characters[position].1.is_whitespace();
        let before = cursor;
        while spaced(cursor) {
            cursor += 1;
        }
        if cursor < characters.len() && matches!(characters[cursor].1, '=' | ':') {
            cursor += 1;
        } else if cursor == before {
            index = end;
            continue;
        }
        while spaced(cursor) {
            cursor += 1;
        }
        if cursor >= characters.len() {
            index = end;
            continue;
        }
        let value_start = characters[cursor].0;
        let quote = characters[cursor].1;
        let value_end = if matches!(quote, '"' | '\'') {
            let mut closing = cursor + 1;
            while closing < characters.len()
                && characters[closing].1 != quote
                && characters[closing].1 != '\n'
            {
                closing += 1;
            }
            if closing < characters.len() && characters[closing].1 == quote {
                closing + 1
            } else {
                index = end;
                continue;
            }
        } else {
            let mut closing = cursor;
            while closing < characters.len()
                && !characters[closing].1.is_whitespace()
                && characters[closing].1 != ';'
            {
                closing += 1;
            }
            closing
        };
        if value_end == cursor {
            index = end;
            continue;
        }
        output.push_str(&text[copied..value_start]);
        output.push_str(REDACTED);
        copied = characters
            .get(value_end)
            .map_or(text.len(), |entry| entry.0);
        index = value_end;
    }
    output.push_str(&text[copied..]);
    output
}

fn redact_bearer(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut output = String::new();
    let mut copied = 0;
    let mut search = 0;
    while let Some(found) = lower[search..].find("bearer") {
        let start = search + found;
        let boundary = start == 0 || !word(text[..start].chars().next_back().unwrap_or(' '));
        let after = start + "bearer".len();
        let spaces = text[after..]
            .chars()
            .take_while(|character| character.is_whitespace())
            .map(char::len_utf8)
            .sum::<usize>();
        let token = text[after + spaces..]
            .chars()
            .take_while(|character| !character.is_whitespace() && !matches!(character, '"' | '\''))
            .map(char::len_utf8)
            .sum::<usize>();
        if !boundary || spaces == 0 || token == 0 {
            search = after;
            continue;
        }
        output.push_str(&text[copied..after]);
        output.push(' ');
        output.push_str(REDACTED);
        copied = after + spaces + token;
        search = copied;
    }
    output.push_str(&text[copied..]);
    output
}

fn redact_url_credentials(text: &str) -> String {
    let mut output = String::new();
    let mut rest = text;
    while let Some(scheme) = ["http://", "https://"]
        .iter()
        .filter_map(|scheme| {
            rest.to_ascii_lowercase()
                .find(scheme)
                .map(|index| (index, scheme.len()))
        })
        .min()
    {
        let authority = scheme.0 + scheme.1;
        let span = rest[authority..]
            .find(|character: char| character.is_whitespace() || character == '/')
            .unwrap_or(rest.len() - authority);
        let host = &rest[authority..authority + span];
        output.push_str(&rest[..authority]);
        match host.rfind('@') {
            Some(at) if at > 0 => {
                output.push_str(REDACTED);
                output.push_str(&host[at..]);
            }
            _ => output.push_str(host),
        }
        rest = &rest[authority + span..];
    }
    output.push_str(rest);
    output
}
