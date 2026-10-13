use super::{
    admission::{Admission, Mode},
    bridge::{Bridge, Error, SessionCheck, Transport},
    protocol::{ClientMessage, Kind, VERSION, extension_id_from_origin},
};
use crate::resources::credential;
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use std::{
    sync::{Arc, Mutex, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::task::JoinHandle;
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder,
    browser, session_id::SessionId,
};
use ycoding_store::resources::Secret;

pub struct Options {
    pub pairing_ttl: Duration,
    pub command_timeout: Duration,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifecycle {
    ExecutionSucceeded,
    ExecutionFailed,
    ExecutionInterrupted,
    Moved,
    Deleted,
    Archived,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            pairing_ttl: Duration::from_secs(120),
            command_timeout: Duration::from_secs(30),
        }
    }
}
struct Pairing {
    session: SessionId,
    digest: Vec<u8>,
    expires: u64,
    attempts: u8,
    server: LosslessString,
    timer: Option<JoinHandle<()>>,
}
impl Drop for Pairing {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}
struct Trust {
    id: LosslessString,
    digest: Vec<u8>,
    extension: LosslessString,
    server: LosslessString,
    session: SessionId,
}
struct Connection {
    bridge: Arc<Bridge>,
    transport: Arc<dyn Transport>,
    session: SessionId,
    extension: LosslessString,
}
struct State {
    pairing: Option<Pairing>,
    connection: Option<Connection>,
    generation: u64,
    closed: bool,
}
pub struct Service {
    credentials: credential::Service,
    admission: Arc<Admission>,
    sessions: SessionCheck,
    options: Options,
    state: Mutex<State>,
    mutation: tokio::sync::Mutex<()>,
}
pub struct Attachment {
    service: Weak<Service>,
    bridge: Arc<Bridge>,
}
impl Service {
    pub fn new(
        credentials: credential::Service,
        admission: Arc<Admission>,
        sessions: SessionCheck,
        options: Options,
    ) -> Arc<Self> {
        Arc::new(Self {
            credentials,
            admission,
            sessions,
            options,
            state: Mutex::new(State {
                pairing: None,
                connection: None,
                generation: 1,
                closed: false,
            }),
            mutation: tokio::sync::Mutex::new(()),
        })
    }
    fn require_session(&self, session: &SessionId) -> Result<(), Error> {
        if !(self.sessions)(session) {
            return Err(Error::Ownership(
                "Session does not exist or is archived".into(),
            ));
        }
        if self.state.lock().unwrap_or_else(|e| e.into_inner()).closed {
            return Err(Error::Unavailable("Browser service is closed".into()));
        }
        Ok(())
    }
    fn load_trust(&self) -> Result<Option<Trust>, Error> {
        let rows = self
            .credentials
            .list(&"ycoding.browser".into())
            .map_err(storage)?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let value = row.secret().domain().map_err(storage)?;
        let ycoding_schema::credential::Value::Key(key) = value else {
            return Ok(None);
        };
        let Some(metadata) = key.metadata else {
            return Ok(None);
        };
        let value = JsonValue::Object(metadata);
        let path = JsonPath::default();
        let object = ObjectDecoder::new(&value, &path)?;
        if object
            .field::<LosslessString>("type")
            .ok()
            .as_ref()
            .and_then(LosslessString::as_str)
            != Some("browser-extension-trust")
        {
            return Ok(None);
        }
        let Some(digest) = key
            .key
            .as_str()
            .and_then(unhex)
            .filter(|bytes| bytes.len() == 32)
        else {
            return Ok(None);
        };
        let (Ok(extension), Ok(server), Ok(session)) = (
            object.field::<LosslessString>("extensionID"),
            object.field::<LosslessString>("serverID"),
            object.field::<LosslessString>("sessionID"),
        ) else {
            return Ok(None);
        };
        Ok(Some(Trust {
            id: row.id().clone(),
            digest,
            extension,
            server,
            session: SessionId::decode(&session.encode())?,
        }))
    }
    async fn remove_trust(&self) -> Result<(), Error> {
        if let Some(trust) = self.load_trust()? {
            self.credentials
                .remove(trust.id, now() as i64)
                .await
                .map_err(storage)?;
        }
        Ok(())
    }
    fn expire(&self, state: &mut State) {
        if state
            .pairing
            .as_ref()
            .is_some_and(|pairing| pairing.expires <= now())
            && let Some(pairing) = state.pairing.take()
        {
            self.admission.release(
                &pairing.session.as_lossless().to_utf8().unwrap_or_default(),
                Mode::Selected,
            );
        }
    }
    pub fn status(&self, session: &SessionId) -> Result<browser::Status, Error> {
        self.require_session(session)?;
        let mut status = browser::Status {
            state: browser::BridgeState::Unavailable,
            paired: None,
            profile_granted: None,
            generation: None,
            pairing_expires_at: None,
            extension_id: None,
            pending_call_id: None,
        };
        if self.admission.current(
            &session
                .as_lossless()
                .to_utf8()
                .map_err(|_| Error::Ownership("Invalid Session identity".into()))?,
        ) == Some(Mode::Isolated)
        {
            return Ok(status);
        }
        let paired = self.load_trust()?.is_some();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.expire(&mut state);
        if let Some(connection) = &state.connection {
            status = connection.bridge.status(session)?;
            status.extension_id = Some(connection.extension.clone());
        } else if let Some(pairing) = &state.pairing
            && pairing.session == *session
        {
            status.state = browser::BridgeState::Pairing;
            status.pairing_expires_at = Some(DomainDecode::decode(&JsonValue::Number(
                pairing.expires as f64,
            ))?);
            return Ok(status);
        }
        status.paired = Some(paired);
        Ok(status)
    }
    pub fn bridge(&self) -> Result<Arc<Bridge>, Error> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .connection
            .as_ref()
            .map(|connection| connection.bridge.clone())
            .ok_or_else(|| Error::Unavailable("Chrome extension bridge is unavailable".into()))
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
        match &state.connection {
            Some(connection) => connection.bridge.list(session),
            None => Ok(Vec::new()),
        }
    }
    pub async fn start(self: &Arc<Self>, session: &SessionId) -> Result<browser::Pairing, Error> {
        let _mutation = self.mutation.lock().await;
        self.require_session(session)?;
        let name = session
            .as_lossless()
            .to_utf8()
            .map_err(|_| Error::Ownership("Invalid Session identity".into()))?;
        if !self.admission.claim(&name, Mode::Selected) {
            return Err(Error::Busy(
                "Stop the isolated browser before starting Chrome pairing".into(),
            ));
        }
        let trust = self.load_trust()?;
        self.remove_trust().await?;
        let secret = random(32)?;
        let server = match trust {
            Some(trust) => trust.server,
            None => random(24)?.into(),
        };
        let expires = now()
            + u64::try_from(self.options.pairing_ttl.as_millis())
                .map_err(|_| Error::InvalidFrame("Invalid pairing TTL".into()))?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            self.admission.release(&name, Mode::Selected);
            return Err(Error::Unavailable("Browser service is closed".into()));
        }
        if let Some(previous) = state.pairing.take()
            && previous.session != *session
        {
            self.admission.release(
                &previous.session.as_lossless().to_utf8().unwrap_or_default(),
                Mode::Selected,
            );
        }
        self.disconnect(
            &mut state,
            "forget",
            1000,
            "pairing switched",
            Some(session),
        );
        let weak = Arc::downgrade(self);
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(expires.saturating_sub(now()))).await;
            if let Some(service) = weak.upgrade() {
                let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
                if state
                    .pairing
                    .as_ref()
                    .is_some_and(|pairing| pairing.expires == expires)
                {
                    service.expire(&mut state);
                }
            }
        });
        state.pairing = Some(Pairing {
            session: session.clone(),
            digest: hash(&secret),
            expires,
            attempts: 0,
            server,
            timer: Some(timer),
        });
        Ok(browser::Pairing {
            secret: secret.into(),
            expires_at: DomainDecode::decode(&JsonValue::Number(expires as f64))?,
        })
    }
    pub async fn attach(
        self: &Arc<Self>,
        origin: &str,
        handshake: ClientMessage,
        transport: Arc<dyn Transport>,
    ) -> Result<Attachment, Error> {
        let _mutation = self.mutation.lock().await;
        let path = JsonPath::default();
        let object = ObjectDecoder::new(&handshake.value, &path)?;
        let extension: LosslessString = object.field("extensionID")?;
        let origin = extension_id_from_origin(origin)
            .ok_or_else(|| Error::InvalidFrame("Invalid Chrome extension identity".into()))?;
        if extension.as_str() != Some(origin.as_str()) {
            return Err(Error::InvalidFrame(
                "Invalid Chrome extension identity".into(),
            ));
        }
        if super::protocol::decode_client(
            super::protocol::encode_server(&handshake.value).as_bytes(),
        )
        .is_none()
        {
            return Err(Error::InvalidFrame("Invalid Chrome handshake".into()));
        }
        let (session, server, credential) = match handshake.kind {
            Kind::Pair => {
                let secret: LosslessString = object.field("secret")?;
                let expected = {
                    let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    let Some(expected) = state.pairing.as_mut() else {
                        return Err(Error::InvalidFrame(
                            "Invalid or expired Chrome pairing".into(),
                        ));
                    };
                    if expected.expires <= now()
                        || expected.attempts >= 5
                        || !equal(
                            &expected.digest,
                            &hash(secret.as_str().ok_or_else(|| {
                                Error::InvalidFrame("Invalid pairing secret".into())
                            })?),
                        )
                    {
                        expected.attempts = expected.attempts.saturating_add(1);
                        return Err(Error::InvalidFrame(
                            "Invalid or expired Chrome pairing".into(),
                        ));
                    }
                    (expected.session.clone(), expected.server.clone())
                };
                self.require_session(&expected.0)?;
                self.state.lock().unwrap_or_else(|e| e.into_inner()).pairing = None;
                let credential = random(32)?;
                let metadata = ObjectEncoder::new()
                    .field("type", "browser-extension-trust")
                    .field("extensionID", &extension)
                    .field("serverID", &expected.1)
                    .field("sessionID", &expected.0)
                    .finish();
                let JsonValue::Object(metadata) = metadata else {
                    unreachable!()
                };
                let value =
                    ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
                        key: hex(&hash(&credential)).into(),
                        metadata: Some(metadata),
                    })
                    .encode();
                self.credentials
                    .create(
                        format!("browser-{}", random(16)?).into(),
                        "ycoding.browser".into(),
                        Some(extension.clone()),
                        Secret::new(value).map_err(storage)?,
                        now() as i64,
                    )
                    .await
                    .map_err(storage)?;
                (
                    expected.0,
                    expected.1,
                    Some(LosslessString::from(credential)),
                )
            }
            Kind::Authenticate => {
                let credential: LosslessString = object.field("credential")?;
                let server: LosslessString = object.field("serverID")?;
                let trust = self.load_trust()?.ok_or_else(|| {
                    Error::InvalidFrame("Unknown or revoked Chrome pairing".into())
                })?;
                if trust.extension != extension
                    || trust.server != server
                    || !equal(
                        &trust.digest,
                        &hash(
                            credential
                                .as_str()
                                .ok_or_else(|| Error::InvalidFrame("Invalid credential".into()))?,
                        ),
                    )
                {
                    return Err(Error::InvalidFrame(
                        "Unknown or revoked Chrome pairing".into(),
                    ));
                }
                (trust.session, trust.server, None)
            }
            _ => return Err(Error::InvalidFrame("Expected Chrome handshake".into())),
        };
        let name = session
            .as_lossless()
            .to_utf8()
            .map_err(|_| Error::Ownership("Invalid Session identity".into()))?;
        if !self.admission.claim(&name, Mode::Selected) {
            return Err(Error::Busy(
                "Stop the isolated browser before attaching Chrome control".into(),
            ));
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err(Error::Unavailable("Browser service is closed".into()));
        }
        if state
            .connection
            .as_ref()
            .is_some_and(|connection| connection.bridge.is_connected())
        {
            return Err(Error::Busy(
                "A Chrome extension bridge is already connected".into(),
            ));
        }
        let generation = browser::Generation::decode(&JsonValue::Number(state.generation as f64))?;
        state.generation += 1;
        let bridge = Bridge::new(
            generation,
            session.clone(),
            transport.clone(),
            self.admission.clone(),
            self.sessions.clone(),
            self.options.command_timeout,
        );
        if !transport.send(
            ObjectEncoder::new()
                .field("type", "paired")
                .field("version", &f64::from(VERSION))
                .field("generation", &generation)
                .field("serverID", &server)
                .optional("credential", &credential)
                .finish(),
        ) {
            state.connection = None;
            self.admission.release(&name, Mode::Selected);
            return Err(Error::Busy(
                "Chrome extension bridge output queue is full".into(),
            ));
        }
        state.connection = Some(Connection {
            bridge: bridge.clone(),
            transport,
            session,
            extension,
        });
        Ok(Attachment {
            service: Arc::downgrade(self),
            bridge,
        })
    }
    fn disconnect(
        &self,
        state: &mut State,
        action: &str,
        code: u16,
        reason: &str,
        retain: Option<&SessionId>,
    ) {
        if let Some(connection) = state.connection.take() {
            connection.transport.send(
                ObjectEncoder::new()
                    .field("type", "control")
                    .field("action", action)
                    .finish(),
            );
            connection.transport.close(code, reason);
            connection.bridge.detach();
            if retain != Some(&connection.session) {
                self.admission.release(
                    &connection
                        .session
                        .as_lossless()
                        .to_utf8()
                        .unwrap_or_default(),
                    Mode::Selected,
                );
            }
        }
    }
    pub fn stop(&self, session: &SessionId) -> Result<(), Error> {
        self.require_session(session)?;
        let name = session
            .as_lossless()
            .to_utf8()
            .map_err(|_| Error::Ownership("Invalid Session identity".into()))?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .pairing
            .as_ref()
            .is_some_and(|pairing| pairing.session == *session)
        {
            state.pairing = None;
        }
        if state.connection.is_some() && self.admission.current(&name) == Some(Mode::Isolated) {
            return Err(Error::Ownership(
                "Stop the isolated browser before using paired Chrome tabs".into(),
            ));
        }
        self.disconnect(&mut state, "stop", 1000, "stopped", None);
        self.admission.release(&name, Mode::Selected);
        Ok(())
    }
    pub async fn forget(&self, session: &SessionId) -> Result<(), Error> {
        let _mutation = self.mutation.lock().await;
        self.require_session(session)?;
        self.remove_trust().await?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pairing) = state.pairing.take() {
            self.admission.release(
                &pairing.session.as_lossless().to_utf8().unwrap_or_default(),
                Mode::Selected,
            );
        }
        self.disconnect(&mut state, "forget", 1000, "pairing forgotten", None);
        Ok(())
    }
    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        if let Some(pairing) = state.pairing.take() {
            self.admission.release(
                &pairing.session.as_lossless().to_utf8().unwrap_or_default(),
                Mode::Selected,
            );
        }
        if let Some(connection) = state.connection.take() {
            connection.transport.close(1012, "service shutdown");
            connection.bridge.detach();
            self.admission.release(
                &connection
                    .session
                    .as_lossless()
                    .to_utf8()
                    .unwrap_or_default(),
                Mode::Selected,
            );
        }
    }
    pub async fn lifecycle(&self, session: &SessionId, event: Lifecycle) -> Result<(), Error> {
        let ownership_ended = matches!(
            event,
            Lifecycle::Moved | Lifecycle::Deleted | Lifecycle::Archived
        );
        let bridge = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if ownership_ended
                && state
                    .pairing
                    .as_ref()
                    .is_some_and(|pairing| pairing.session == *session)
            {
                state.pairing = None;
            }
            state
                .connection
                .as_ref()
                .map(|connection| connection.bridge.clone())
        };
        if ownership_ended {
            if let Some(bridge) = &bridge {
                bridge.release_session(session)?;
            }
            self.admission.release(
                &session
                    .as_lossless()
                    .to_utf8()
                    .map_err(|_| Error::Ownership("Invalid Session identity".into()))?,
                Mode::Selected,
            );
        }
        if let Some(bridge) = bridge {
            bridge.relinquish_session(session).await?;
        }
        Ok(())
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown();
    }
}
impl Attachment {
    pub async fn receive(&self, message: ClientMessage) -> Result<(), Error> {
        let Some(service) = self.service.upgrade() else {
            return Ok(());
        };
        let _mutation = service.mutation.lock().await;
        let current = service
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .connection
            .as_ref()
            .is_some_and(|connection| {
                connection.bridge.is_connected() && Arc::ptr_eq(&connection.bridge, &self.bridge)
            });
        if !current {
            return Ok(());
        }
        if message.kind == Kind::Forget {
            service.remove_trust().await?;
            let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
            service.disconnect(&mut state, "forget", 1000, "pairing forgotten", None);
            return Ok(());
        }
        self.bridge.receive(message)
    }
    pub fn detach(&self) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        let mut state = service.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(connection) = state.connection.as_mut()
            && connection.bridge.is_connected()
            && Arc::ptr_eq(&connection.bridge, &self.bridge)
        {
            self.bridge.detach();
        }
    }
}
fn storage(_: impl std::fmt::Display) -> Error {
    Error::Unavailable("Browser credential storage failed".into())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn hash(input: &str) -> Vec<u8> {
    digest::digest(&digest::SHA256, input.as_bytes())
        .as_ref()
        .to_vec()
}
#[expect(
    deprecated,
    reason = "ring's constant-time equality preserves the SHA-256 trust format without another dependency"
)]
fn equal(left: &[u8], right: &[u8]) -> bool {
    ring::constant_time::verify_slices_are_equal(left, right).is_ok()
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn unhex(text: &str) -> Option<Vec<u8>> {
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let high = char::from(pair[0]).to_digit(16)?;
            let low = char::from(pair[1]).to_digit(16)?;
            Some((high * 16 + low) as u8)
        })
        .collect()
}
fn random(size: usize) -> Result<String, Error> {
    let mut bytes = vec![0; size];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Error::Unavailable("Browser secure randomness is unavailable".into()))?;
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let word = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..chunk.len() + 1 {
            output.push(char::from(
                alphabet[((word >> (18 - index * 6)) & 63) as usize],
            ));
        }
    }
    Ok(output)
}
