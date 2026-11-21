use super::Error;
use crate::{dispatch::Boxed, ids};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use ycoding_core::remote::{self, Device};

#[derive(Clone)]
pub struct Enrolled {
    origin: String,
    device: String,
}

impl Enrolled {
    pub fn new(origin: &str, device: String) -> Result<Self, Error> {
        if device.is_empty() {
            return Err(Error::Setup);
        }
        Ok(Self {
            origin: remote::normalize_origin(origin).ok_or(Error::Setup)?,
            device,
        })
    }

    pub fn url(&self) -> String {
        let (scheme, rest) = self
            .origin
            .split_once(':')
            .expect("normalized origins carry a scheme");
        format!(
            "{}:{rest}/ws/v5/agent",
            if scheme == "https" { "wss" } else { "ws" }
        )
    }
}

pub struct Credential {
    pub(crate) token: String,
    pub(crate) expires_at: i64,
    origin: String,
    device: String,
}

impl Credential {
    pub fn new(token: String, expires_at: i64, origin: String, device: String) -> Self {
        Self {
            token,
            expires_at,
            origin,
            device,
        }
    }

    pub(crate) fn authenticate(&self, enrolled: &Enrolled, now: i64) -> Result<Peer, Error> {
        if remote::normalize_origin(&self.origin).as_deref() != Some(enrolled.origin.as_str())
            || self.device != enrolled.device
        {
            return Err(Error::Forbidden);
        }
        if self.token.is_empty() || self.expires_at <= now {
            return Err(Error::Unauthorized);
        }
        Ok(Peer {
            live: Arc::new(AtomicBool::new(true)),
            expires_at: self.expires_at,
            origin: enrolled.origin.clone(),
            device: enrolled.device.clone(),
        })
    }
}

pub trait Credentials: Send + Sync {
    fn enrolled(&self) -> Boxed<Result<Enrolled, Error>>;
    fn access(&self) -> Boxed<Result<Credential, Error>>;
}

impl Credentials for Device {
    fn enrolled(&self) -> Boxed<Result<Enrolled, Error>> {
        let device = self.clone();
        Box::pin(async move {
            let (origin, id) = device.enrolled().await.map_err(failure)?;
            Enrolled::new(&origin, id)
        })
    }

    fn access(&self) -> Boxed<Result<Credential, Error>> {
        let device = self.clone();
        Box::pin(async move {
            let access = device
                .access(ids::now_millis().max(0) as u64)
                .await
                .map_err(failure)?;
            Ok(Credential::new(
                access.token,
                i64::try_from(access.expires_at).map_err(|_| Error::Unauthorized)?,
                access.relay_origin,
                access.device_id,
            ))
        })
    }
}

fn failure(error: remote::Error) -> Error {
    match error {
        remote::Error::Store | remote::Error::NotEnrolled => Error::Setup,
        remote::Error::Revoked => Error::Unauthorized,
        remote::Error::Relay => Error::Transport,
    }
}

#[derive(Clone)]
pub struct Peer {
    live: Arc<AtomicBool>,
    expires_at: i64,
    origin: String,
    device: String,
}

impl Peer {
    pub fn authenticate(
        enrolled: &Enrolled,
        credential: &Credential,
        now: i64,
    ) -> Result<Self, Error> {
        credential.authenticate(enrolled, now)
    }

    pub(crate) fn device(&self) -> &str {
        &self.device
    }

    pub(crate) fn mcp_resource(&self) -> String {
        format!("{}/api/mcp/devices/{}", self.origin, self.device)
    }

    pub fn authorized(&self) -> bool {
        self.live.load(Ordering::Acquire) && self.expires_at > crate::ids::now_millis()
    }

    pub(crate) fn revoke(&self) {
        self.live.store(false, Ordering::Release);
    }
}
