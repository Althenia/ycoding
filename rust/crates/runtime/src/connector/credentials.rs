use super::Error;
use crate::dispatch::Boxed;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone)]
pub struct Enrolled {
    pub(crate) origin: String,
    owner: String,
    device: String,
}

impl Enrolled {
    pub fn new(origin: &str, owner: String, device: String) -> Result<Self, Error> {
        if owner.is_empty() || device.is_empty() {
            return Err(Error::Setup);
        }
        Ok(Self {
            origin: normalize(origin)?,
            owner,
            device,
        })
    }

    pub fn bind(&self, requested: &str) -> Result<String, Error> {
        let origin = normalize(requested)?;
        if origin != self.origin {
            return Err(Error::Forbidden);
        }
        let scheme = if origin.starts_with("https:") {
            "wss:"
        } else {
            "ws:"
        };
        Ok(format!(
            "{}{}{}",
            scheme,
            origin.split_once(':').ok_or(Error::Setup)?.1,
            "/ws/v5/agent"
        ))
    }
}

fn normalize(origin: &str) -> Result<String, Error> {
    let uri = url::Url::parse(origin).map_err(|_| Error::Setup)?;
    if !uri.username().is_empty()
        || uri.password().is_some()
        || uri.query().is_some()
        || uri.fragment().is_some()
        || uri.path() != "/"
        || uri.scheme() != "https"
            && !(uri.scheme() == "http"
                && matches!(uri.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return Err(Error::Setup);
    }
    Ok(uri.origin().ascii_serialization())
}

pub struct Credential {
    pub(crate) token: String,
    pub(crate) expires_at: i64,
    owner: String,
    device: String,
}

impl Credential {
    pub fn new(token: String, expires_at: i64, owner: String, device: String) -> Self {
        Self {
            token,
            expires_at,
            owner,
            device,
        }
    }

    pub(crate) fn authenticate(&self, enrolled: &Enrolled, now: i64) -> Result<Peer, Error> {
        if self.owner != enrolled.owner || self.device != enrolled.device {
            return Err(Error::Forbidden);
        }
        if self.token.is_empty() || self.expires_at <= now {
            return Err(Error::Unauthorized);
        }
        Ok(Peer {
            live: Arc::new(AtomicBool::new(true)),
            expires_at: self.expires_at,
        })
    }
}

pub trait Credentials: Send + Sync {
    fn access(&self) -> Boxed<Result<Credential, Error>>;
}

#[derive(Clone)]
pub struct Peer {
    live: Arc<AtomicBool>,
    expires_at: i64,
}

impl Peer {
    pub fn authenticate(
        enrolled: &Enrolled,
        credential: &Credential,
        now: i64,
    ) -> Result<Self, Error> {
        credential.authenticate(enrolled, now)
    }

    pub fn authorized(&self) -> bool {
        self.live.load(Ordering::Acquire) && self.expires_at > crate::ids::now_millis()
    }

    pub(crate) fn revoke(&self) {
        self.live.store(false, Ordering::Release);
    }
}
