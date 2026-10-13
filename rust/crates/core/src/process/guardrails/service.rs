use super::{CustomLayer, Evaluation, Paths, classify};
use crate::tools::policy::{Authority, Effect, Publisher, Wait, permissions::Permissions, state};
use std::{
    collections::{BTreeMap, VecDeque},
    ops::Bound,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;
use ycoding_schema::{
    DomainEncode, JsonObject, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder,
    guardrail, schema::NonNegativeInt, session_id::SessionId, stringify_json,
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
    approvals: BTreeMap<SessionId, u64>,
    blocked: BTreeMap<SessionId, u64>,
    sequences: BTreeMap<SessionId, u64>,
    pools: BTreeMap<(SessionId, Kind), Pool>,
    next_slot: u64,
}
struct Inner {
    authority: Authority,
    permissions: Permissions,
    settings: Settings,
    publish: Publisher,
    state: Mutex<State>,
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
}
#[derive(Clone)]
pub struct Reservation(Arc<Reserved>);
impl Reservation {
    pub fn release(&self) {
        if self.0.released.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(service) = self.0.service.upgrade()
            && let Some(kind) = self.0.kind
        {
            let mut state = service
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            release_slot(&mut state, &self.0.service, &self.0.root, kind, self.0.slot);
        }
    }
    fn release_unlocked(&self, state: &mut State) {
        if !self.0.released.swap(true, Ordering::AcqRel)
            && let Some(kind) = self.0.kind
        {
            release_slot(state, &self.0.service, &self.0.root, kind, self.0.slot);
        }
    }
}
impl Drop for Reserved {
    fn drop(&mut self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(service) = self.service.upgrade()
            && let Some(kind) = self.kind
        {
            release_slot(
                &mut service
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()),
                &self.service,
                &self.root,
                kind,
                self.slot,
            );
        }
    }
}

fn advance(state: &mut State, root: &SessionId) {
    *state.sequences.entry(root.clone()).or_default() += 1;
}
fn release_slot(state: &mut State, service: &Weak<Inner>, root: &SessionId, kind: Kind, slot: u64) {
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
        }))
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
            let result = classify(&input.action, &input.resources, &paths, &custom);
            return Ok((
                if result.effect == Effect::Deny || result.hard_review {
                    result
                } else {
                    Evaluation::allow()
                },
                vec![],
            ));
        }
        let result = classify(&input.action, &input.resources, &paths, &custom);
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
        })))
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
        let root = authority.root_session_id;
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
        let action_kind = match input.action.as_str() {
            "shell" => Some(Kind::Shell),
            "subagent" => Some(Kind::Subagent),
            _ => None,
        };
        if result.effect == Effect::Allow
            || input.skip_review
            || (result.effect == Effect::Ask
                && !result.hard_review
                && authority.root_autonomy.can_auto_guardrail())
        {
            let decided = guardrail::DecidedData {
                root_session_id: root.clone(),
                session_id: input.session_id,
                action: input.action.into(),
                rule_ids: result.rule_ids,
                decision: guardrail::Decision::Allow,
            };
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
                reservation.release_unlocked(&mut state);
                return Err(Error::Publish(error));
            }
            return Ok(Admission {
                effect: Effect::Allow,
                request: None,
                reservation: Some(reservation),
                wait: None,
            });
        }
        let review = self.reserve(&mut state, &root, Some(Kind::Review), None)?;
        let request = guardrail::Request {
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
            metadata: input.metadata,
        };
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
            },
        ) {
            let _ = item.sender.send(Err(Error::Declined));
            return Err(Error::Publish(error));
        }
        if reply == guardrail::Reply::Reject {
            let _ = item.sender.send(Err(Error::Declined));
            return Ok(());
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
        if let Err(Ok(reservation)) = item.sender.send(reservation) {
            reservation.release_unlocked(&mut state);
        }
        Ok(())
    }

    pub fn cancel(&self, id: &guardrail::RequestId) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
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
    pub fn status(&self, session: &SessionId) -> Result<guardrail::Status, Error> {
        let root = self.0.authority.session(session, None)?.root_session_id;
        Ok(self.status_unlocked(
            &self
                .0
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
            &root,
        ))
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
