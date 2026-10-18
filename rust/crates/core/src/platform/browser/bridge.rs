use super::{
    admission::{Admission, Mode},
    protocol::{ClientMessage, Kind},
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{oneshot, watch};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder,
    browser,
    schema::{NonNegativeInt, PositiveInt},
    session_id::SessionId,
    stringify_json,
};

pub trait Transport: Send + Sync {
    fn send(&self, message: JsonValue) -> bool;
    fn close(&self, code: u16, reason: &str);
}
pub type SessionCheck = Arc<dyn Fn(&SessionId) -> bool + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Fence(String),
    Ownership(String),
    Busy(String),
    Unavailable(String),
    InvalidFrame(String),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fence(s)
            | Self::Ownership(s)
            | Self::Busy(s)
            | Self::Unavailable(s)
            | Self::InvalidFrame(s) => f.write_str(s),
        }
    }
}
impl std::error::Error for Error {}
impl From<ycoding_schema::DecodeError> for Error {
    fn from(error: ycoding_schema::DecodeError) -> Self {
        Self::InvalidFrame(error.to_string())
    }
}

struct Tab {
    info: browser::Tab,
    elements: HashMap<LosslessString, browser::Element>,
    lease: Option<SessionId>,
    origins: HashSet<LosslessString>,
}
#[derive(Clone)]
enum Output {
    Observation(browser::Observation),
    Action(browser::ActionResult),
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum PendingKind {
    Observe,
    Action,
    Open,
    Close,
    Relinquish,
}
struct Pending {
    kind: PendingKind,
    call: browser::CallId,
    tab: browser::TabId,
    session: SessionId,
    mutation: bool,
    fingerprint: String,
    token: u64,
    sender: Option<oneshot::Sender<Result<Output, Error>>>,
    claimed: Vec<browser::TabId>,
    timed_out: bool,
    completion: Completion,
}
struct Completion(watch::Sender<bool>);
impl Default for Completion {
    fn default() -> Self {
        Self(watch::channel(false).0)
    }
}
impl Drop for Completion {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}
struct State {
    generation: browser::Generation,
    bootstrap: SessionId,
    connected: bool,
    paused: bool,
    granted: bool,
    tabs: HashMap<browser::TabId, Tab>,
    pending: Option<Pending>,
    settlements: VecDeque<(String, String, browser::ActionResult)>,
    opens: HashMap<String, (LosslessString, browser::TabId)>,
    closes: HashSet<String>,
    sequence: u64,
}
pub struct Bridge {
    state: Mutex<State>,
    transport: Arc<dyn Transport>,
    admission: Arc<Admission>,
    sessions: SessionCheck,
    timeout: Duration,
}

impl Bridge {
    pub fn new(
        generation: browser::Generation,
        bootstrap: SessionId,
        transport: Arc<dyn Transport>,
        admission: Arc<Admission>,
        sessions: SessionCheck,
        timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                generation,
                bootstrap,
                connected: true,
                paused: false,
                granted: false,
                tabs: HashMap::new(),
                pending: None,
                settlements: VecDeque::new(),
                opens: HashMap::new(),
                closes: HashSet::new(),
                sequence: 0,
            }),
            transport,
            admission,
            sessions,
            timeout,
        })
    }
    fn require_session(&self, session: &SessionId) -> Result<(), Error> {
        if !(self.sessions)(session) {
            return Err(Error::Ownership(
                "Session does not exist or is archived".into(),
            ));
        }
        Ok(())
    }
    fn require_connection(&self, state: &State, session: &SessionId) -> Result<(), Error> {
        self.require_session(session)?;
        if !state.connected {
            return Err(Error::Unavailable(
                "Chrome extension bridge is disconnected".into(),
            ));
        }
        let session = session
            .as_lossless()
            .to_utf8()
            .map_err(|_| Error::Ownership("Invalid Session identity".into()))?;
        if self.admission.current(&session) == Some(Mode::Isolated) {
            return Err(Error::Ownership(
                "This Session is using isolated browser mode".into(),
            ));
        }
        Ok(())
    }
    fn require_tab<'a>(
        &self,
        state: &'a State,
        session: &SessionId,
        id: &browser::TabId,
    ) -> Result<&'a Tab, Error> {
        self.require_connection(state, session)?;
        let tab = state
            .tabs
            .get(id)
            .filter(|tab| {
                tab.info.mode != Some(browser::Mode::Owned) || tab.info.session_id == *session
            })
            .ok_or_else(|| {
                Error::Ownership("Chrome tab is not available to this Session".into())
            })?;
        if tab.lease.as_ref().is_some_and(|owner| owner != session) {
            return Err(Error::Ownership(
                "Chrome tab is controlled by another Session; wait for it to release control"
                    .into(),
            ));
        }
        Ok(tab)
    }
    pub fn is_connected(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .connected
    }
    pub fn list(&self, session: &SessionId) -> Result<Vec<browser::Tab>, Error> {
        self.require_session(session)?;
        if self.admission.current(
            &session
                .as_lossless()
                .to_utf8()
                .map_err(|_| Error::Ownership("Invalid Session identity".into()))?,
        ) == Some(Mode::Isolated)
        {
            return Ok(Vec::new());
        }
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Ok(state
            .tabs
            .values()
            .filter(|tab| {
                tab.info.mode != Some(browser::Mode::Owned) || tab.info.session_id == *session
            })
            .map(|tab| public_tab(tab, session))
            .collect())
    }
    pub fn status(&self, session: &SessionId) -> Result<browser::Status, Error> {
        self.require_session(session)?;
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let isolated = self.admission.current(
            &session
                .as_lossless()
                .to_utf8()
                .map_err(|_| Error::Ownership("Invalid Session identity".into()))?,
        ) == Some(Mode::Isolated);
        Ok(browser::Status {
            state: if !state.connected || isolated {
                browser::BridgeState::Unavailable
            } else if state.paused || state.pending.as_ref().is_some_and(|p| p.timed_out) {
                browser::BridgeState::Paused
            } else {
                browser::BridgeState::Connected
            },
            paired: None,
            profile_granted: Some(state.granted),
            generation: Some(state.generation),
            pairing_expires_at: None,
            extension_id: None,
            pending_call_id: state.pending.as_ref().map(|p| p.call.clone()),
        })
    }
    pub async fn observe(
        self: &Arc<Self>,
        input: browser::ObserveInput,
    ) -> Result<browser::Observation, Error> {
        let (receiver, token) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let tab = self.require_tab(&state, &input.session_id, &input.tab_id)?;
            if state.paused || tab.info.status != browser::TabStatus::Shared {
                return Err(Error::Fence("Chrome tab control is paused".into()));
            }
            if tab.info.generation != input.generation {
                return Err(Error::Fence("Chrome bridge generation is stale".into()));
            }
            let message = ObjectEncoder::new()
                .field("type", &LosslessString::from("observe"))
                .field("callID", &input.call_id)
                .field("tabID", &input.tab_id)
                .field("generation", &input.generation)
                .finish();
            self.dispatch(
                &mut state,
                Pending {
                    kind: PendingKind::Observe,
                    call: input.call_id.clone(),
                    tab: input.tab_id.clone(),
                    session: input.session_id.clone(),
                    mutation: false,
                    fingerprint: String::new(),
                    token: 0,
                    sender: None,
                    claimed: Vec::new(),
                    timed_out: false,
                    completion: Completion::default(),
                },
                message,
                std::slice::from_ref(&input.tab_id),
            )?
        };
        match self.wait(receiver, token).await? {
            Output::Observation(observation) => Ok(observation),
            _ => Err(Error::InvalidFrame(
                "Extension returned an action result for observe".into(),
            )),
        }
    }
    pub fn click_destination(
        &self,
        input: &browser::ActionInput,
        reference: &LosslessString,
    ) -> Result<Option<browser::Page>, Error> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let tab = self.require_tab(&state, &input.session_id, &input.tab_id)?;
        check_fence(&state, tab, input)?;
        let element = tab
            .elements
            .get(reference)
            .filter(|e| e.disabled != Some(true))
            .ok_or_else(|| {
                Error::Fence("Semantic element reference is stale or disabled".into())
            })?;
        Ok(element.destination.clone())
    }
    pub async fn action(
        self: &Arc<Self>,
        input: browser::ActionInput,
    ) -> Result<browser::ActionResult, Error> {
        let (receiver, token) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let tab = self.require_tab(&state, &input.session_id, &input.tab_id)?;
            let fingerprint = stringify_json(&input.encode());
            let key = call_key(&input.session_id, &input.call_id);
            if let Some((_, previous, result)) = state
                .settlements
                .iter()
                .find(|(settled, _, _)| settled == &key)
            {
                if previous != &fingerprint {
                    return Err(Error::Fence(
                        "Browser call ID was already used for a different action".into(),
                    ));
                }
                return Ok(result.clone());
            }
            check_fence(&state, tab, &input)?;
            let reference = match &input.action {
                browser::Action::Click(action) => Some(&action.r#ref),
                browser::Action::Type(action) => Some(&action.r#ref),
                _ => None,
            };
            if let Some(reference) = reference {
                let element = tab
                    .elements
                    .get(reference)
                    .ok_or_else(|| Error::Fence("Semantic element reference is stale".into()))?;
                if element.disabled == Some(true) {
                    return Err(Error::Fence("Semantic element is disabled".into()));
                }
            }
            let members = match &input.action {
                browser::Action::Group(action) => action.tab_ids.clone(),
                browser::Action::Ungroup(action) => action.tab_ids.clone(),
                _ => vec![input.tab_id.clone()],
            };
            if matches!(
                input.action,
                browser::Action::Group(_) | browser::Action::Ungroup(_)
            ) {
                if !state.granted
                    || tab.info.mode != Some(browser::Mode::Profile)
                    || !members.contains(&input.tab_id)
                    || members.iter().collect::<HashSet<_>>().len() != members.len()
                    || members.iter().any(|id| {
                        state
                            .tabs
                            .get(id)
                            .is_none_or(|tab| tab.info.mode != Some(browser::Mode::Profile))
                    })
                {
                    return Err(Error::Ownership(
                        "Group actions require granted profile tabs".into(),
                    ));
                }
                if members.iter().any(|id| {
                    state
                        .tabs
                        .get(id)
                        .and_then(|tab| tab.lease.as_ref())
                        .is_some_and(|owner| owner != &input.session_id)
                }) {
                    return Err(Error::Ownership("Chrome tab is controlled by another Session; wait for it to release control".into()));
                }
            }
            let destination = match &input.action {
                browser::Action::Navigate(action) => Some(safe_page(&action.url)?),
                browser::Action::Click(action) => tab
                    .elements
                    .get(&action.r#ref)
                    .and_then(|element| element.destination.clone()),
                _ => None,
            };
            let mut origins = vec![tab.info.page.origin.clone()];
            if let Some(destination) = destination
                && !origins.contains(&destination.origin)
            {
                origins.push(destination.origin);
            }
            for id in &members {
                if let Some(member) = state.tabs.get(id)
                    && !origins.contains(&member.info.page.origin)
                {
                    origins.push(member.info.page.origin.clone());
                }
            }
            if let Some(tab) = state
                .tabs
                .get_mut(&input.tab_id)
                .filter(|tab| tab.info.mode == Some(browser::Mode::Owned))
            {
                tab.origins = origins.iter().cloned().collect();
            }
            let message = ObjectEncoder::new()
                .field("type", &LosslessString::from("action"))
                .field("callID", &input.call_id)
                .field("tabID", &input.tab_id)
                .field("generation", &input.generation)
                .field("documentGeneration", &input.document_generation)
                .field("observationRevision", &input.observation_revision)
                .field("allowedOrigins", &origins)
                .field("action", &input.action)
                .finish();
            self.dispatch(
                &mut state,
                Pending {
                    kind: PendingKind::Action,
                    call: input.call_id.clone(),
                    tab: input.tab_id.clone(),
                    session: input.session_id.clone(),
                    mutation: matches!(
                        input.action,
                        browser::Action::Navigate(_)
                            | browser::Action::Click(_)
                            | browser::Action::Type(_)
                            | browser::Action::Group(_)
                            | browser::Action::Ungroup(_)
                    ),
                    fingerprint,
                    token: 0,
                    sender: None,
                    claimed: Vec::new(),
                    timed_out: false,
                    completion: Completion::default(),
                },
                message,
                &members,
            )?
        };
        match self.wait(receiver, token).await? {
            Output::Action(result) => Ok(result),
            _ => Err(Error::InvalidFrame(
                "Extension returned an observation for action".into(),
            )),
        }
    }
    fn dispatch(
        &self,
        state: &mut State,
        mut pending: Pending,
        message: JsonValue,
        members: &[browser::TabId],
    ) -> Result<(oneshot::Receiver<Result<Output, Error>>, u64), Error> {
        if let Some(active) = &state.pending {
            return Err(Error::Busy(format!(
                "Browser command {} is still unsettled",
                stringify_json(&active.call.encode())
            )));
        }
        let mut claimed = Vec::new();
        for id in members {
            if let Some(tab) = state
                .tabs
                .get_mut(id)
                .filter(|tab| tab.info.mode == Some(browser::Mode::Profile) && tab.lease.is_none())
            {
                tab.lease = Some(pending.session.clone());
                claimed.push(id.clone());
            }
        }
        if !self.transport.send(message) {
            for id in claimed {
                if let Some(tab) = state.tabs.get_mut(&id) {
                    tab.lease = None;
                }
            }
            return Err(Error::Unavailable(
                "Chrome extension bridge output queue is full".into(),
            ));
        }
        let (sender, receiver) = oneshot::channel();
        state.sequence += 1;
        pending.token = state.sequence;
        pending.sender = Some(sender);
        pending.claimed = claimed;
        let token = pending.token;
        state.pending = Some(pending);
        Ok((receiver, token))
    }
    async fn wait(
        self: &Arc<Self>,
        receiver: oneshot::Receiver<Result<Output, Error>>,
        token: u64,
    ) -> Result<Output, Error> {
        let mut guard = WaitGuard {
            bridge: self.clone(),
            token,
            settled: false,
        };
        let result = match tokio::time::timeout(self.timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Error::Unavailable(
                "Chrome extension bridge disconnected".into(),
            )),
            Err(_) => self.timeout(token),
        };
        guard.settled = true;
        result
    }
    fn timeout(&self, token: u64) -> Result<Output, Error> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(pending) = state
            .pending
            .as_ref()
            .filter(|pending| pending.token == token)
        else {
            return Err(Error::Unavailable(
                "Chrome extension did not answer before the command deadline".into(),
            ));
        };
        if !pending.mutation {
            state.pending = None;
            return Err(Error::Unavailable(
                "Chrome extension did not answer before the command deadline".into(),
            ));
        }
        uncertain(&mut state,"The extension response was lost or late. The action will not be replayed; inspect or stop after reconciliation.").map(Output::Action)
    }
    pub fn control(&self, session: &SessionId, resume: bool) -> Result<browser::Status, Error> {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            self.require_connection(&state, session)?;
            if state.pending.is_some() {
                return Err(Error::Fence(
                    if resume {
                        "Cannot resume while an action has an uncertain or pending result"
                    } else {
                        "Cannot pause while a browser action is still settling"
                    }
                    .into(),
                ));
            }
            state.paused = !resume;
            if resume {
                for tab in state.tabs.values_mut() {
                    tab.info.observation_revision = NonNegativeInt::new(0)?;
                    tab.elements.clear();
                    if tab.info.pause_reason == Some(browser::PauseReason::Requested) {
                        tab.info.status = browser::TabStatus::Shared;
                        tab.info.pause_reason = None;
                    }
                }
            }
            self.transport.send(
                ObjectEncoder::new()
                    .field("type", &LosslessString::from("control"))
                    .field(
                        "action",
                        &LosslessString::from(if resume { "resume" } else { "pause" }),
                    )
                    .finish(),
            );
        }
        self.status(session)
    }
    pub async fn open(self: &Arc<Self>, input: browser::OpenInput) -> Result<browser::Tab, Error> {
        let page = safe_page(&input.url)?;
        let (receiver, token) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            self.require_connection(&state, &input.session_id)?;
            if state.generation != input.generation {
                return Err(Error::Fence("Chrome bridge generation is stale".into()));
            }
            if state.paused {
                return Err(Error::Fence("Chrome bridge is paused".into()));
            }
            let key = call_key(&input.session_id, &input.call_id);
            if state.opens.contains_key(&key) {
                return Err(Error::Fence(
                    "Browser open call ID was already used; list tabs before continuing".into(),
                ));
            }
            if state.opens.len() >= 64
                || state
                    .tabs
                    .values()
                    .filter(|tab| tab.info.mode != Some(browser::Mode::Profile))
                    .count()
                    >= 8
            {
                return Err(Error::Busy("Chrome tab or open call limit reached".into()));
            }
            let id = super::super::identifier("btab_")
                .map_err(|error| Error::Unavailable(error.to_string()))?;
            let id = browser::TabId::decode(&JsonValue::String(id.into()))?;
            state.opens.insert(key, (input.url.clone(), id.clone()));
            let message = ObjectEncoder::new()
                .field("type", &LosslessString::from("open"))
                .field("callID", &input.call_id)
                .field("tabID", &id)
                .field("generation", &input.generation)
                .field("url", &input.url)
                .finish();
            self.dispatch(
                &mut state,
                Pending {
                    kind: PendingKind::Open,
                    call: input.call_id,
                    tab: id,
                    session: input.session_id,
                    mutation: true,
                    fingerprint: input
                        .url
                        .to_utf8()
                        .map_err(|_| Error::Fence("Invalid navigation URL".into()))?,
                    token: 0,
                    sender: None,
                    claimed: Vec::new(),
                    timed_out: false,
                    completion: Completion::default(),
                },
                message,
                &[],
            )?
        };
        match self.wait(receiver, token).await? {
            Output::Action(result) if result.tab.page.origin == page.origin => Ok(result.tab),
            _ => Err(Error::InvalidFrame(
                "Chrome tab reached an unapproved site".into(),
            )),
        }
    }
    pub async fn close(self: &Arc<Self>, input: browser::CloseInput) -> Result<(), Error> {
        let (receiver, token) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let tab = self.require_tab(&state, &input.session_id, &input.tab_id)?;
            if tab.info.mode != Some(browser::Mode::Owned) {
                return Err(Error::Ownership(
                    "Only agent-created tabs can be closed".into(),
                ));
            }
            if tab.info.generation != input.generation {
                return Err(Error::Fence("Chrome bridge generation is stale".into()));
            }
            let key = call_key(&input.session_id, &input.call_id);
            if state.closes.contains(&key) {
                return Err(Error::Fence(
                    "Browser close call ID was already used; list tabs before continuing".into(),
                ));
            }
            if state.closes.len() >= 64 {
                return Err(Error::Busy(
                    "Chrome close call limit reached; reconnect before closing more tabs".into(),
                ));
            }
            if state.pending.is_some() {
                return Err(Error::Busy("Browser command is still unsettled".into()));
            }
            state.closes.insert(key.clone());
            let message = ObjectEncoder::new()
                .field("type", &LosslessString::from("close"))
                .field("callID", &input.call_id)
                .field("tabID", &input.tab_id)
                .field("generation", &input.generation)
                .finish();
            self.dispatch(
                &mut state,
                Pending {
                    kind: PendingKind::Close,
                    call: input.call_id,
                    tab: input.tab_id,
                    session: input.session_id,
                    mutation: true,
                    fingerprint: key,
                    token: 0,
                    sender: None,
                    claimed: Vec::new(),
                    timed_out: false,
                    completion: Completion::default(),
                },
                message,
                &[],
            )?
        };
        match self.wait(receiver, token).await? {
            Output::Action(result) if result.status == browser::ResultStatus::Completed => Ok(()),
            _ => Err(Error::InvalidFrame(
                "Chrome tab close did not settle".into(),
            )),
        }
    }
    pub async fn release(self: &Arc<Self>, input: browser::ReleaseInput) -> Result<(), Error> {
        {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let tab = self.require_tab(&state, &input.session_id, &input.tab_id)?;
            if tab.info.mode != Some(browser::Mode::Profile) {
                return Err(Error::Ownership(
                    "Only paired profile tab control can be released".into(),
                ));
            }
            if tab.info.generation != input.generation {
                return Err(Error::Fence("Chrome bridge generation is stale".into()));
            }
            if tab.lease.is_none() {
                return Ok(());
            }
        }
        self.relinquish_tab(input).await
    }
    async fn relinquish_tab(self: &Arc<Self>, input: browser::ReleaseInput) -> Result<(), Error> {
        let (receiver, token) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if !state.connected
                || state
                    .tabs
                    .get(&input.tab_id)
                    .is_none_or(|tab| tab.lease.as_ref() != Some(&input.session_id))
            {
                return Ok(());
            }
            let message = ObjectEncoder::new()
                .field("type", &LosslessString::from("relinquish"))
                .field("callID", &input.call_id)
                .field("tabID", &input.tab_id)
                .field("generation", &input.generation)
                .finish();
            self.dispatch(
                &mut state,
                Pending {
                    kind: PendingKind::Relinquish,
                    call: input.call_id.clone(),
                    tab: input.tab_id.clone(),
                    session: input.session_id.clone(),
                    mutation: false,
                    fingerprint: String::new(),
                    token: 0,
                    sender: None,
                    claimed: Vec::new(),
                    timed_out: false,
                    completion: Completion::default(),
                },
                message,
                &[],
            )?
        };
        if let Err(error) = self.wait(receiver, token).await {
            if self
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .tabs
                .contains_key(&input.tab_id)
            {
                return Err(error);
            }
            return Ok(());
        }
        if let Some(tab) = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tabs
            .get_mut(&input.tab_id)
            && tab.lease == Some(input.session_id)
        {
            tab.lease = None;
            tab.elements.clear();
            tab.info.observation_revision = NonNegativeInt::new(0)?;
        }
        Ok(())
    }
    pub async fn relinquish_session(self: &Arc<Self>, session: &SessionId) -> Result<(), Error> {
        let ids = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .tabs
            .iter()
            .filter(|(_, tab)| tab.lease.as_ref() == Some(session))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut failure = None;
        for id in ids {
            loop {
                let (generation, pending) = {
                    let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    if !state.connected
                        || state
                            .tabs
                            .get(&id)
                            .is_none_or(|tab| tab.lease.as_ref() != Some(session))
                    {
                        break;
                    }
                    (
                        state.generation,
                        state
                            .pending
                            .as_ref()
                            .map(|pending| pending.completion.0.subscribe()),
                    )
                };
                if let Some(mut pending) = pending {
                    pending.wait_for(|done| *done).await.map_err(|_| {
                        Error::Unavailable("Browser settlement completion was lost".into())
                    })?;
                    continue;
                }
                let call = super::super::identifier("relinquish-")
                    .map_err(|e| Error::Unavailable(e.to_string()))?;
                let input = browser::ReleaseInput {
                    session_id: session.clone(),
                    tab_id: id.clone(),
                    generation,
                    call_id: browser::CallId::decode(&JsonValue::String(call.into()))?,
                };
                match self.relinquish_tab(input).await {
                    Ok(()) => break,
                    Err(Error::Busy(_)) => continue,
                    Err(error) => {
                        if failure.is_none() {
                            failure = Some(error);
                        }
                        break;
                    }
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
    pub fn detach(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.connected = false;
        state.paused = true;
        fail_pending(&mut state, "Chrome extension bridge disconnected");
        for tab in state.tabs.values_mut() {
            tab.info.status = browser::TabStatus::Unavailable;
            tab.info.pause_reason = Some(browser::PauseReason::Disconnected);
            tab.info.observation_revision = NonNegativeInt::new(0).expect("zero revision");
            tab.elements.clear();
        }
    }
    pub fn stop(&self, session: &SessionId) -> Result<(), Error> {
        self.require_session(session)?;
        self.transport.send(
            ObjectEncoder::new()
                .field("type", &LosslessString::from("control"))
                .field("action", &LosslessString::from("stop"))
                .finish(),
        );
        self.transport.close(1000, "stopped");
        self.detach();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.tabs.clear();
        self.admission.release(
            &state
                .bootstrap
                .as_lossless()
                .to_utf8()
                .map_err(|_| Error::Ownership("Invalid Session identity".into()))?,
            Mode::Selected,
        );
        Ok(())
    }
    pub fn release_session(&self, session: &SessionId) -> Result<(), Error> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.session == *session)
        {
            fail_pending(&mut state, "Session computer ownership ended");
        }
        let generation = state.generation;
        state.tabs.retain(|id, tab| {
            if tab.info.mode == Some(browser::Mode::Owned) && tab.info.session_id == *session {
                self.transport.send(
                    ObjectEncoder::new()
                        .field("type", &LosslessString::from("release"))
                        .field("tabID", id)
                        .field("generation", &generation)
                        .finish(),
                );
                return false;
            }
            true
        });
        self.admission.release(
            &session
                .as_lossless()
                .to_utf8()
                .map_err(|_| Error::Ownership("Invalid Session identity".into()))?,
            Mode::Selected,
        );
        Ok(())
    }
    pub fn receive(&self, message: ClientMessage) -> Result<(), Error> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.connected {
            return Ok(());
        }
        let path = JsonPath::default();
        let object = ObjectDecoder::new(&message.value, &path)?;
        if message.kind == Kind::ProfileAccess {
            state.granted = object.field("enabled")?;
            if !state.granted {
                if state.pending.as_ref().is_some_and(|pending| {
                    state
                        .tabs
                        .get(&pending.tab)
                        .is_some_and(|tab| tab.info.mode == Some(browser::Mode::Profile))
                }) {
                    fail_pending(&mut state, "Chrome profile access was revoked");
                }
                state
                    .tabs
                    .retain(|_, tab| tab.info.mode != Some(browser::Mode::Profile));
            }
            return Ok(());
        }
        if message.kind == Kind::Pong {
            return Ok(());
        }
        if message.kind == Kind::Forget {
            self.transport.close(1000, "pairing forgotten");
            state.connected = false;
            fail_pending(&mut state, "Chrome extension forgot pairing");
            state.tabs.clear();
            return Ok(());
        }
        if matches!(message.kind, Kind::Pair | Kind::Authenticate) {
            return Err(Error::InvalidFrame(
                "Handshake is not a connected extension frame".into(),
            ));
        }
        let id: browser::TabId = object.field("tabID")?;
        if message.kind == Kind::Shared {
            if !state.granted {
                return Ok(());
            }
            let url: LosslessString = object.field("url")?;
            let page = match safe_page(&url) {
                Ok(page) => page,
                Err(_) => {
                    self.transport.send(
                        ObjectEncoder::new()
                            .field("type", &LosslessString::from("error"))
                            .field(
                                "message",
                                &LosslessString::from(
                                    "Only credential-free HTTP and HTTPS tabs can be shared",
                                ),
                            )
                            .finish(),
                    );
                    return Ok(());
                }
            };
            let info = browser::Tab {
                id: id.clone(),
                session_id: state.bootstrap.clone(),
                title: bounded(object.field("title")?, 512),
                page: page.clone(),
                status: if state.paused {
                    browser::TabStatus::Paused
                } else {
                    browser::TabStatus::Shared
                },
                generation: state.generation,
                document_generation: object.field("documentGeneration")?,
                observation_revision: NonNegativeInt::new(0)?,
                pause_reason: state.paused.then_some(browser::PauseReason::Requested),
                uncertain_call_id: None,
                mode: Some(browser::Mode::Profile),
                lease: None,
            };
            state.tabs.insert(
                id,
                Tab {
                    info,
                    elements: HashMap::new(),
                    lease: None,
                    origins: HashSet::from([page.origin]),
                },
            );
            return Ok(());
        }
        if message.kind == Kind::Revoked {
            match state.pending.as_ref() {
                Some(pending) if pending.tab == id && pending.kind == PendingKind::Open => finish(
                    &mut state,
                    Err(Error::InvalidFrame(
                        "Chrome tab access was revoked before opening completed".into(),
                    )),
                ),
                Some(pending) if pending.tab == id => {
                    fail_pending(&mut state, "Chrome tab was revoked")
                }
                _ => {}
            }
            state.tabs.remove(&id);
            return Ok(());
        }
        if message.kind == Kind::Takeover || message.kind == Kind::Updated {
            let paused = state.paused;
            let generation = state.generation;
            let Some(tab) = state.tabs.get_mut(&id) else {
                return Ok(());
            };
            if message.kind == Kind::Updated {
                let url: LosslessString = object.field("url")?;
                let Ok(page) = safe_page(&url) else {
                    return Ok(());
                };
                if tab.info.mode == Some(browser::Mode::Owned)
                    && !tab.origins.contains(&page.origin)
                {
                    state.tabs.remove(&id);
                    self.transport.send(
                        ObjectEncoder::new()
                            .field("type", &LosslessString::from("close"))
                            .field("callID", &LosslessString::from("unapproved-origin"))
                            .field("tabID", &id)
                            .field("generation", &generation)
                            .finish(),
                    );
                    return Ok(());
                }
                tab.info.page = page;
                tab.info.title = bounded(object.field("title")?, 512);
            }
            tab.info.document_generation = object.field("documentGeneration")?;
            tab.info.observation_revision = NonNegativeInt::new(0)?;
            tab.elements.clear();
            if message.kind == Kind::Takeover {
                tab.info.status = if paused {
                    browser::TabStatus::Paused
                } else {
                    browser::TabStatus::Shared
                };
                tab.info.pause_reason = paused.then_some(browser::PauseReason::Requested);
            }
            return Ok(());
        }
        let call: browser::CallId = object.field("callID")?;
        let generation: PositiveInt = object.field("generation")?;
        let Some(pending) = state
            .pending
            .as_ref()
            .filter(|p| p.tab == id && p.call == call && generation == state.generation)
        else {
            return Ok(());
        };
        let kind = pending.kind;
        let session = pending.session.clone();
        if message.kind == Kind::Opened && kind == PendingKind::Open {
            let page = safe_page(&object.field("url")?)?;
            let expected = state
                .opens
                .get(&call_key(&session, &call))
                .and_then(|(url, _)| safe_page(url).ok());
            if expected.is_none_or(|expected| expected.origin != page.origin) {
                finish(
                    &mut state,
                    Err(Error::InvalidFrame(
                        "Chrome tab reached an unapproved site".into(),
                    )),
                );
                self.transport.send(
                    ObjectEncoder::new()
                        .field("type", &LosslessString::from("close"))
                        .field("callID", &call)
                        .field("tabID", &id)
                        .field("generation", &generation)
                        .finish(),
                );
                return Ok(());
            }
            let info = browser::Tab {
                id: id.clone(),
                session_id: session.clone(),
                title: bounded(object.field("title")?, 512),
                page: page.clone(),
                status: if state.paused {
                    browser::TabStatus::Paused
                } else {
                    browser::TabStatus::Shared
                },
                generation,
                document_generation: object.field("documentGeneration")?,
                observation_revision: NonNegativeInt::new(0)?,
                pause_reason: state.paused.then_some(browser::PauseReason::Requested),
                uncertain_call_id: None,
                mode: Some(browser::Mode::Owned),
                lease: None,
            };
            state.tabs.insert(
                id.clone(),
                Tab {
                    info,
                    elements: HashMap::new(),
                    lease: None,
                    origins: HashSet::from([page.origin]),
                },
            );
            let tab = state
                .tabs
                .get(&id)
                .ok_or_else(|| Error::Ownership("Chrome tab was revoked".into()))?;
            let result = result(
                &call,
                public_tab(tab, &session),
                browser::ResultStatus::Completed,
                None,
            );
            finish(&mut state, Ok(Output::Action(result)));
            return Ok(());
        }
        if message.kind == Kind::Error {
            let dispatched: bool = object.field("dispatched")?;
            let mutation = pending.mutation;
            let text: LosslessString = object.field("message")?;
            if kind == PendingKind::Open {
                finish(
                    &mut state,
                    Err(Error::InvalidFrame(
                        "Chrome could not open a background tab".into(),
                    )),
                );
                return Ok(());
            }
            if mutation && dispatched {
                let result = uncertain(
                    &mut state,
                    &format!(
                        "The extension could not prove whether the mutation completed: {}",
                        text.to_utf8().unwrap_or_default()
                    ),
                )?;
                finish(&mut state, Ok(Output::Action(result)));
                return Ok(());
            }
            if kind == PendingKind::Action {
                let tab = state
                    .tabs
                    .get(&id)
                    .ok_or_else(|| Error::Ownership("Chrome tab was revoked".into()))?;
                let result = result(
                    &call,
                    public_tab(tab, &session),
                    browser::ResultStatus::Rejected,
                    Some(bounded(
                        format!(
                            "The extension rejected the action before dispatch: {}",
                            text.to_utf8().unwrap_or_default()
                        )
                        .into(),
                        1024,
                    )),
                );
                remember_pending(&mut state, &result);
                finish(&mut state, Ok(Output::Action(result)));
                return Ok(());
            }
            finish(
                &mut state,
                Err(Error::Unavailable(text.to_utf8().unwrap_or_default())),
            );
            return Ok(());
        }
        if message.kind == Kind::Closed && kind == PendingKind::Close {
            let tab = state
                .tabs
                .remove(&id)
                .ok_or_else(|| Error::Ownership("Chrome tab was revoked".into()))?;
            finish(
                &mut state,
                Ok(Output::Action(result(
                    &call,
                    public_tab(&tab, &session),
                    browser::ResultStatus::Completed,
                    None,
                ))),
            );
            return Ok(());
        }
        if message.kind == Kind::Relinquished && kind == PendingKind::Relinquish {
            let tab = state
                .tabs
                .get(&id)
                .ok_or_else(|| Error::Ownership("Chrome tab was revoked".into()))?;
            let result = result(
                &call,
                public_tab(tab, &session),
                browser::ResultStatus::Completed,
                None,
            );
            finish(&mut state, Ok(Output::Action(result)));
            return Ok(());
        }
        if message.kind == Kind::Observation && kind == PendingKind::Observe {
            let page = safe_page(&object.field("url")?)?;
            let raw: Vec<JsonValue> = object.field("elements")?;
            let elements = raw
                .iter()
                .take(200)
                .map(sanitize_element)
                .collect::<Result<Vec<_>, Error>>()?;
            let observation = browser::Observation {
                tab_id: id.clone(),
                generation,
                document_generation: object.field("documentGeneration")?,
                revision: object.field("revision")?,
                title: bounded(object.field("title")?, 512),
                page,
                elements,
                truncated: object.field::<bool>("truncated")? || raw.len() > 200,
            };
            let tab = state
                .tabs
                .get_mut(&id)
                .ok_or_else(|| Error::Ownership("Chrome tab was revoked".into()))?;
            tab.info.title = observation.title.clone();
            tab.info.page = observation.page.clone();
            tab.info.document_generation = observation.document_generation;
            tab.info.observation_revision = observation.revision;
            tab.elements = observation
                .elements
                .iter()
                .cloned()
                .map(|element| (element.r#ref.clone(), element))
                .collect();
            finish(&mut state, Ok(Output::Observation(observation)));
            return Ok(());
        }
        if message.kind == Kind::Result && kind == PendingKind::Action {
            let page = safe_page(&object.field("url")?)?;
            let status: browser::ResultStatus = object.field("status")?;
            let tab = state
                .tabs
                .get_mut(&id)
                .ok_or_else(|| Error::Ownership("Chrome tab was revoked".into()))?;
            tab.info.title = bounded(object.field("title")?, 512);
            tab.info.page = page;
            tab.info.document_generation = object.field("documentGeneration")?;
            tab.info.observation_revision = object.field("observationRevision")?;
            tab.elements.clear();
            tab.info.status = if status == browser::ResultStatus::Paused {
                browser::TabStatus::Paused
            } else {
                browser::TabStatus::Shared
            };
            tab.info.pause_reason = (status == browser::ResultStatus::Paused)
                .then_some(browser::PauseReason::UserActive);
            tab.info.uncertain_call_id = None;
            let mut result = result(
                &call,
                public_tab(tab, &session),
                status,
                object.optional("message")?,
            );
            result.capture = object.optional("capture")?;
            result.group_id = object.optional("groupID")?;
            remember_pending(&mut state, &result);
            finish(&mut state, Ok(Output::Action(result)));
        }
        Ok(())
    }
}

struct WaitGuard {
    bridge: Arc<Bridge>,
    token: u64,
    settled: bool,
}
impl Drop for WaitGuard {
    fn drop(&mut self) {
        if !self.settled {
            let _ = self.bridge.timeout(self.token);
        }
    }
}
fn public_tab(tab: &Tab, session: &SessionId) -> browser::Tab {
    let mut info = tab.info.clone();
    if info.mode == Some(browser::Mode::Profile) {
        info.session_id = session.clone();
        info.lease = tab.lease.as_ref().map(|owner| {
            if owner == session {
                browser::Lease::Self_
            } else {
                browser::Lease::Other
            }
        });
    }
    info
}
fn check_fence(state: &State, tab: &Tab, input: &browser::ActionInput) -> Result<(), Error> {
    if state.paused || tab.info.status != browser::TabStatus::Shared {
        return Err(Error::Fence("Chrome tab control is paused".into()));
    }
    if tab.info.generation != input.generation
        || tab.info.document_generation != input.document_generation
        || tab.info.observation_revision != input.observation_revision
    {
        return Err(Error::Fence(
            "Chrome tab observation is stale; observe again".into(),
        ));
    }
    Ok(())
}
fn call_key(session: &SessionId, call: &browser::CallId) -> String {
    format!(
        "{}\0{}",
        stringify_json(&session.encode()),
        stringify_json(&call.encode())
    )
}
fn result(
    call: &browser::CallId,
    tab: browser::Tab,
    status: browser::ResultStatus,
    message: Option<LosslessString>,
) -> browser::ActionResult {
    browser::ActionResult {
        call_id: call.clone(),
        tab,
        status,
        message,
        capture: None,
        group_id: None,
    }
}
fn remember_pending(state: &mut State, result: &browser::ActionResult) {
    if let Some(pending) = &state.pending {
        let key = call_key(&pending.session, &pending.call);
        state.settlements.retain(|(old, _, _)| old != &key);
        state
            .settlements
            .push_back((key, pending.fingerprint.clone(), result.clone()));
        while state.settlements.len() > 64 {
            state.settlements.pop_front();
        }
    }
}
fn uncertain(state: &mut State, message: &str) -> Result<browser::ActionResult, Error> {
    let pending = state
        .pending
        .as_mut()
        .ok_or_else(|| Error::Unavailable("No pending Chrome action".into()))?;
    pending.timed_out = true;
    let tab = state.tabs.get_mut(&pending.tab).ok_or_else(|| {
        Error::Ownership("Chrome tab was revoked while the action was pending".into())
    })?;
    tab.info.status = browser::TabStatus::Paused;
    tab.info.pause_reason = Some(browser::PauseReason::Uncertain);
    tab.info.uncertain_call_id = Some(pending.call.clone());
    let result = result(
        &pending.call,
        public_tab(tab, &pending.session),
        browser::ResultStatus::Uncertain,
        Some(bounded(message.into(), 1024)),
    );
    remember_pending(state, &result);
    Ok(result)
}
fn finish(state: &mut State, result: Result<Output, Error>) {
    if let Some(pending) = state.pending.take() {
        if result.is_err()
            || matches!(&result,Ok(Output::Action(result)) if result.status==browser::ResultStatus::Rejected)
        {
            for id in pending.claimed {
                if let Some(tab) = state.tabs.get_mut(&id)
                    && tab.lease == Some(pending.session.clone())
                {
                    tab.lease = None;
                }
            }
        }
        if let Some(sender) = pending.sender {
            let _ = sender.send(result);
        }
    }
}
fn fail_pending(state: &mut State, message: &str) {
    if state
        .pending
        .as_ref()
        .is_some_and(|pending| pending.mutation)
        && let Ok(result) = uncertain(state, message)
    {
        finish(state, Ok(Output::Action(result)));
        return;
    }
    finish(state, Err(Error::Unavailable(message.into())));
}
pub fn safe_page(input: &LosslessString) -> Result<browser::Page, Error> {
    let input = input.to_utf8().map_err(|_| {
        Error::Fence("Only credential-free HTTP and HTTPS pages can be shared".into())
    })?;
    let url = url::Url::parse(&input).map_err(|_| {
        Error::Fence("Only credential-free HTTP and HTTPS pages can be shared".into())
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.has_host()
    {
        return Err(Error::Fence(
            "Only credential-free HTTP and HTTPS pages can be shared".into(),
        ));
    }
    Ok(browser::Page {
        origin: url.origin().ascii_serialization().into(),
        path: if url.path().is_empty() {
            "/".into()
        } else {
            url.path().into()
        },
    })
}
fn bounded(value: LosslessString, limit: usize) -> LosslessString {
    if value.len() <= limit {
        return value;
    }
    LosslessString::from_utf16(value.code_units().take(limit).collect())
}
fn sanitize_element(value: &JsonValue) -> Result<browser::Element, Error> {
    let path = JsonPath::default();
    let o = ObjectDecoder::new(value, &path)?;
    let destination: Option<LosslessString> = o.optional("destination")?;
    let description: Option<LosslessString> = o.optional("description")?;
    Ok(browser::Element {
        r#ref: o.field("ref")?,
        role: bounded(o.field("role")?, 64),
        name: bounded(o.field("name")?, 1024),
        description: description
            .filter(|d| !d.is_empty())
            .map(|d| bounded(d, 1024)),
        disabled: o.optional("disabled")?,
        destination: destination.and_then(|d| safe_page(&d).ok()),
    })
}
