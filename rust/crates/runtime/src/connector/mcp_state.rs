use super::{Error, Peer, State};
use crate::{Dispatcher, dispatch::Boxed, ids};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, PoisonError},
};
use tokio::sync::watch;
use ycoding_core::ycoding_schema::{JsonValue, parse_json};

const SAVED_BYTES: u64 = 1024;
const QUARANTINED_LANES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpSaved {
    pub enabled: bool,
    pub epoch: String,
    pub pending_revocation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpStatus {
    pub state: State,
    pub message: Option<&'static str>,
    pub url: Option<String>,
}

pub trait McpPreference: Send + Sync {
    fn load(&self) -> Boxed<Result<Option<McpSaved>, Error>>;
    fn save(&self, saved: &McpSaved) -> Boxed<Result<(), Error>>;
}

pub struct McpFile(pub PathBuf);

impl McpPreference for McpFile {
    fn load(&self) -> Boxed<Result<Option<McpSaved>, Error>> {
        let path = self.0.clone();
        Box::pin(async move {
            let Some(text) = read_private(&path).await? else {
                return Ok(None);
            };
            let JsonValue::Object(object) = parse_json(&text).map_err(|_| Error::Preference)?
            else {
                return Err(Error::Preference);
            };
            if object.len() != 3 {
                return Err(Error::Preference);
            }
            let flag = |key: &str| match object.get(&key.into()) {
                Some(JsonValue::Bool(value)) => Ok(*value),
                _ => Err(Error::Preference),
            };
            let epoch = match object.get(&"epoch".into()) {
                Some(JsonValue::String(value)) => value.to_utf8().map_err(|_| Error::Preference)?,
                _ => return Err(Error::Preference),
            };
            if !stable_id(&epoch) {
                return Err(Error::Preference);
            }
            let saved = McpSaved {
                enabled: flag("enabled")?,
                epoch,
                pending_revocation: flag("pendingRevocation")?,
            };
            if saved.enabled && saved.pending_revocation {
                return Err(Error::Preference);
            }
            Ok(Some(saved))
        })
    }

    fn save(&self, saved: &McpSaved) -> Boxed<Result<(), Error>> {
        let path = self.0.clone();
        let contents = format!(
            "{{\"enabled\":{},\"epoch\":\"{}\",\"pendingRevocation\":{}}}",
            saved.enabled, saved.epoch, saved.pending_revocation
        );
        let valid = stable_id(&saved.epoch);
        Box::pin(async move {
            if !valid {
                return Err(Error::Preference);
            }
            write_private(path, contents, "remote-mcp-").await
        })
    }
}

pub(super) async fn read_private(path: &Path) -> Result<Option<String>, Error> {
    let metadata = match tokio::fs::symlink_metadata(path).await {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::Preference),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > SAVED_BYTES {
        return Err(Error::Preference);
    }
    tokio::fs::read_to_string(path)
        .await
        .map(Some)
        .map_err(|_| Error::Preference)
}

pub(super) async fn write_private(
    path: PathBuf,
    contents: String,
    prefix: &'static str,
) -> Result<(), Error> {
    tokio::task::spawn_blocking(move || {
        if std::fs::symlink_metadata(&path).is_ok_and(|info| {
            info.file_type().is_symlink() || !info.is_file() || info.len() > SAVED_BYTES
        }) {
            return Err(Error::Preference);
        }
        let parent = path.parent().ok_or(Error::Preference)?;
        std::fs::create_dir_all(parent).map_err(|_| Error::Preference)?;
        let temp = parent.join(
            ids::prefixed(prefix)
                .map_err(|_| Error::Preference)?
                .to_utf8()
                .map_err(|_| Error::Preference)?,
        );
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| Error::Preference)?;
        let result = (|| {
            use std::io::Write;
            file.write_all(contents.as_bytes())
                .map_err(|_| Error::Preference)?;
            file.sync_all().map_err(|_| Error::Preference)?;
            std::fs::rename(&temp, &path).map_err(|_| Error::Preference)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    })
    .await
    .map_err(|_| Error::Preference)?
}

pub(crate) fn stable_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn fresh(prefix: &str) -> Result<String, Error> {
    let value = ids::prefixed(prefix)
        .map_err(|_| Error::Setup)?
        .to_utf8()
        .map_err(|_| Error::Setup)?;
    if !stable_id(&value) {
        return Err(Error::Setup);
    }
    Ok(value)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Advertisement {
    pub id: String,
    pub enabled: bool,
    pub epoch: String,
}

#[derive(Clone)]
pub(crate) struct Binding {
    pub connection_id: String,
    pub peer: Peer,
    pub epoch: String,
    pub dispatcher: Arc<Dispatcher>,
    pub lease: super::mcp::Lease,
}

struct Quarantine {
    epoch: String,
    lanes: BTreeSet<String>,
    saturated: bool,
}

struct Inner {
    saved: Result<Option<McpSaved>, Error>,
    binding: Option<Binding>,
    quarantine: Quarantine,
}

pub(crate) struct Mcp {
    server: Arc<super::mcp::Server>,
    storage: Option<Arc<dyn McpPreference>>,
    home: PathBuf,
    inner: Arc<Mutex<Inner>>,
    status: watch::Sender<McpStatus>,
    changes: watch::Sender<u64>,
    transition: tokio::sync::Mutex<()>,
    unsaved: OnceLock<String>,
}

impl Drop for Mcp {
    fn drop(&mut self) {
        self.server.close();
    }
}

impl Mcp {
    pub(crate) fn unsupported() -> Self {
        Self::build(None, PathBuf::new(), Ok(None))
    }

    pub(crate) async fn load(storage: Arc<dyn McpPreference>, home: PathBuf) -> Self {
        let saved = storage.load().await;
        Self::build(Some(storage), home, saved)
    }

    fn build(
        storage: Option<Arc<dyn McpPreference>>,
        home: PathBuf,
        saved: Result<Option<McpSaved>, Error>,
    ) -> Self {
        let inner = Inner {
            saved,
            binding: None,
            quarantine: Quarantine {
                epoch: String::new(),
                lanes: BTreeSet::new(),
                saturated: false,
            },
        };
        let (status, _) = watch::channel(derive(storage.is_some(), &inner));
        let (changes, _) = watch::channel(0);
        Self {
            server: Arc::new(super::mcp::Server::default()),
            storage,
            home,
            inner: Arc::new(Mutex::new(inner)),
            status,
            changes,
            transition: tokio::sync::Mutex::new(()),
            unsaved: OnceLock::new(),
        }
    }

    pub(crate) fn home(&self) -> &Path {
        &self.home
    }

    pub(crate) fn server(&self) -> Arc<super::mcp::Server> {
        self.server.clone()
    }

    pub(crate) fn close(&self) {
        self.server.close();
        self.update(|inner| {
            if let Some(binding) = inner.binding.take() {
                binding.lease.revoke();
            }
        });
    }

    pub(crate) fn status(&self) -> McpStatus {
        self.status.borrow().clone()
    }

    pub(crate) fn observe(&self) -> watch::Receiver<McpStatus> {
        self.status.subscribe()
    }

    pub(crate) fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub(crate) async fn set(&self, enabled: bool, remote: bool) -> Result<McpStatus, Error> {
        let _transition = self.transition.lock().await;
        if !enabled {
            self.update(|inner| {
                if let Some(binding) = inner.binding.take() {
                    binding.lease.revoke();
                }
            });
        }
        let storage = self.storage.clone().ok_or(Error::Preference)?;
        if enabled && !remote {
            return Err(Error::Conflict);
        }
        let current = self.lock().saved.clone()?;
        if current
            .as_ref()
            .map_or(!enabled, |saved| saved.enabled == enabled)
        {
            return Ok(self.status());
        }
        let next = McpSaved {
            enabled,
            epoch: fresh("mcp_")?,
            pending_revocation: !enabled,
        };
        storage.save(&next).await?;
        self.update(|inner| {
            inner.saved = Ok(Some(next));
            if let Some(binding) = &inner.binding {
                binding.lease.revoke();
            }
            inner.binding = None;
        });
        self.changes
            .send_modify(|value| *value = value.wrapping_add(1));
        Ok(self.status())
    }

    pub(crate) async fn force_off(&self) {
        let readable = self.storage.is_some() && self.lock().saved.is_ok();
        if readable && self.set(false, false).await.is_err() {
            tracing::error!("relay MCP could not be disabled with Remote; failing closed");
            self.update(|inner| {
                inner.saved = Err(Error::Preference);
                if let Some(binding) = &inner.binding {
                    binding.lease.revoke();
                }
                inner.binding = None;
            });
        }
    }

    pub(crate) fn advertisement(&self) -> Result<Option<Advertisement>, Error> {
        let saved = self.lock().saved.clone();
        let (enabled, epoch) = match saved {
            Ok(Some(saved)) => (saved.enabled, saved.epoch),
            Ok(None) if self.storage.is_some() => (false, self.unsaved_epoch()?),
            _ => return Ok(None),
        };
        Ok(Some(Advertisement {
            id: fresh("mcpstate_")?,
            enabled,
            epoch,
        }))
    }

    fn unsaved_epoch(&self) -> Result<String, Error> {
        if let Some(epoch) = self.unsaved.get() {
            return Ok(epoch.clone());
        }
        let epoch = fresh("mcp_")?;
        Ok(self.unsaved.get_or_init(|| epoch).clone())
    }

    pub(crate) async fn acknowledged(
        &self,
        advertisement: &Advertisement,
        connection_id: &str,
        peer: &Peer,
        dispatcher: Arc<Dispatcher>,
    ) -> Result<(), Error> {
        let _transition = self.transition.lock().await;
        let saved = match &self.lock().saved {
            Ok(Some(saved)) if saved.epoch == advertisement.epoch => saved.clone(),
            _ => return Ok(()),
        };
        if saved.enabled != advertisement.enabled {
            return Ok(());
        }
        if saved.enabled {
            let lease = super::mcp::Lease::new(
                peer.clone(),
                connection_id.to_owned(),
                saved.epoch.clone(),
            )?;
            if let Some(facade) = self.server.create_local_apps().map_err(|_| Error::Setup)? {
                lease.install_local_apps(facade).map_err(|_| Error::Setup)?;
            }
            self.update(|inner| {
                if let Some(binding) = &inner.binding {
                    binding.lease.revoke();
                }
                inner.binding = Some(Binding {
                    connection_id: connection_id.to_owned(),
                    peer: peer.clone(),
                    epoch: saved.epoch.clone(),
                    dispatcher,
                    lease,
                });
            });
            return Ok(());
        }
        if !saved.pending_revocation {
            return Ok(());
        }
        let next = McpSaved {
            pending_revocation: false,
            ..saved
        };
        self.storage
            .as_ref()
            .ok_or(Error::Preference)?
            .save(&next)
            .await?;
        self.update(|inner| inner.saved = Ok(Some(next)));
        Ok(())
    }

    pub(crate) fn release(&self, connection_id: &str) {
        self.update(|inner| {
            if inner
                .binding
                .as_ref()
                .is_some_and(|binding| binding.connection_id == connection_id)
            {
                if let Some(binding) = &inner.binding {
                    binding.lease.revoke();
                }
                inner.binding = None;
            }
        });
    }

    pub(crate) fn binding(&self, connection_id: &str) -> Option<Binding> {
        let inner = self.lock();
        let binding = inner.binding.as_ref()?;
        let saved = inner.saved.as_ref().ok()?.as_ref()?;
        (binding.connection_id == connection_id
            && saved.enabled
            && saved.epoch == binding.epoch
            && binding.peer.authorized())
        .then(|| binding.clone())
        .filter(|binding| binding.lease.current(connection_id, &saved.epoch))
    }

    pub(crate) fn events_lease(&self, epoch: Option<&str>) -> Option<super::mcp::Lease> {
        lease_for_events(&self.lock(), epoch)
    }

    pub(crate) fn events_authority(&self) -> super::mcp_events_authorization::LeaseAuthority {
        let weak = Arc::downgrade(&self.inner);
        Arc::new(move |epoch| {
            let inner = weak.upgrade()?;
            let inner = inner.lock().unwrap_or_else(PoisonError::into_inner);
            lease_for_events(&inner, epoch)
        })
    }

    pub(crate) fn quarantined(&self, epoch: &str, lane: &str) -> bool {
        let inner = self.lock();
        inner.quarantine.epoch == epoch
            && (inner.quarantine.saturated || inner.quarantine.lanes.contains(lane))
    }

    pub(crate) fn quarantine(&self, epoch: &str, lane: &str) {
        self.update(|inner| {
            let quarantine = &mut inner.quarantine;
            if quarantine.epoch != epoch {
                quarantine.epoch = epoch.to_owned();
                quarantine.lanes.clear();
                quarantine.saturated = false;
            }
            if quarantine.lanes.len() >= QUARANTINED_LANES && !quarantine.lanes.contains(lane) {
                quarantine.saturated = true;
                return;
            }
            quarantine.lanes.insert(lane.to_owned());
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn update(&self, change: impl FnOnce(&mut Inner)) {
        let next = {
            let mut inner = self.lock();
            change(&mut inner);
            derive(self.storage.is_some(), &inner)
        };
        self.status.send_if_modified(|status| {
            if *status == next {
                return false;
            }
            *status = next;
            true
        });
    }
}

fn lease_for_events(inner: &Inner, epoch: Option<&str>) -> Option<super::mcp::Lease> {
    let binding = inner.binding.as_ref()?;
    let saved = inner.saved.as_ref().ok()?.as_ref()?;
    (saved.enabled
        && saved.epoch == binding.epoch
        && epoch.is_none_or(|epoch| epoch == saved.epoch)
        && binding.lease.current(&binding.connection_id, &saved.epoch))
    .then(|| binding.lease.clone())
}

fn derive(supported: bool, inner: &Inner) -> McpStatus {
    let off = |message| McpStatus {
        state: State::Off,
        message,
        url: None,
    };
    if !supported {
        return off(Some("Relay MCP is unavailable"));
    }
    let saved = match &inner.saved {
        Err(_) => {
            return McpStatus {
                state: State::Error,
                message: Some("Could not read relay MCP preference"),
                url: None,
            };
        }
        Ok(None) => return off(None),
        Ok(Some(saved)) => saved,
    };
    if !saved.enabled {
        return off(None);
    }
    match &inner.binding {
        Some(binding) if binding.epoch == saved.epoch => McpStatus {
            state: State::On,
            message: None,
            url: Some(binding.peer.mcp_resource()),
        },
        _ => McpStatus {
            state: State::Connecting,
            message: None,
            url: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{Mcp, QUARANTINED_LANES};

    struct Preference(std::sync::atomic::AtomicBool);
    impl super::McpPreference for Preference {
        fn load(&self) -> crate::Boxed<Result<Option<super::McpSaved>, super::Error>> {
            Box::pin(async { Ok(None) })
        }
        fn save(&self, _: &super::McpSaved) -> crate::Boxed<Result<(), super::Error>> {
            let fail = self.0.load(std::sync::atomic::Ordering::Acquire);
            Box::pin(async move {
                if fail {
                    Err(super::Error::Preference)
                } else {
                    Ok(())
                }
            })
        }
    }

    fn peer() -> super::Peer {
        super::Peer::authenticate(
            &crate::connector::Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
            &crate::connector::Credential::new(
                "lease-fixture".into(),
                crate::ids::now_millis() + 60_000,
                "https://relay.invalid".into(),
                "device-a".into(),
            ),
            crate::ids::now_millis(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn every_binding_invalidation_revokes_retained_resource_access() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        for action in ["replacement", "disable", "force_off", "disconnect", "close"] {
            let preference = Arc::new(Preference(AtomicBool::new(false)));
            let mcp = Mcp::build(
                Some(preference.clone()),
                std::path::PathBuf::new(),
                Ok(Some(super::McpSaved {
                    enabled: true,
                    epoch: "epoch-a".into(),
                    pending_revocation: false,
                })),
            );
            let advertisement = mcp.advertisement().unwrap().unwrap();
            let dispatcher = Arc::new(crate::standard().unwrap());
            mcp.acknowledged(&advertisement, "connection-a", &peer(), dispatcher.clone())
                .await
                .unwrap();
            let access = crate::connector::mcp::Access::new(
                mcp.server(),
                mcp.binding("connection-a").unwrap().lease,
                Arc::new(AtomicBool::new(false)),
            );
            access.export().unwrap();
            match action {
                "replacement" => mcp
                    .acknowledged(&advertisement, "connection-b", &peer(), dispatcher)
                    .await
                    .unwrap(),
                "disable" => {
                    mcp.set(false, true).await.unwrap();
                }
                "force_off" => {
                    preference.0.store(true, Ordering::Release);
                    mcp.force_off().await;
                }
                "disconnect" => mcp.release("connection-a"),
                "close" => mcp.close(),
                _ => unreachable!(),
            }
            assert!(!access.active(), "{action}");
            assert!(access.export().is_err(), "{action}");
        }
    }

    #[tokio::test]
    async fn disable_reenable_and_reconnect_preserve_the_initialized_demo() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, AtomicI64, Ordering},
        };
        let clock = Arc::new(AtomicI64::new(1_000));
        let mut mcp = Mcp::build(
            Some(Arc::new(Preference(AtomicBool::new(false)))),
            std::path::PathBuf::new(),
            Ok(Some(super::McpSaved {
                enabled: true,
                epoch: "epoch-a".into(),
                pending_revocation: false,
            })),
        );
        mcp.server = Arc::new(crate::connector::mcp::Server::new({
            let clock = clock.clone();
            Arc::new(move || clock.load(Ordering::Acquire))
        }));
        let dispatcher = Arc::new(crate::standard().unwrap());
        mcp.acknowledged(
            &mcp.advertisement().unwrap().unwrap(),
            "connection-a",
            &peer(),
            dispatcher.clone(),
        )
        .await
        .unwrap();
        let access = crate::connector::mcp::Access::new(
            mcp.server(),
            mcp.binding("connection-a").unwrap().lease,
            Arc::new(AtomicBool::new(false)),
        );
        let original = access.export().unwrap();
        mcp.set(false, true).await.unwrap();
        mcp.set(true, true).await.unwrap();
        clock.store(900_999, Ordering::Release);
        mcp.acknowledged(
            &mcp.advertisement().unwrap().unwrap(),
            "connection-b",
            &peer(),
            dispatcher.clone(),
        )
        .await
        .unwrap();
        let access = crate::connector::mcp::Access::new(
            mcp.server(),
            mcp.binding("connection-b").unwrap().lease,
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(access.export().unwrap(), original);
        mcp.release("connection-b");
        clock.store(901_000, Ordering::Release);
        mcp.acknowledged(
            &mcp.advertisement().unwrap().unwrap(),
            "connection-c",
            &peer(),
            dispatcher,
        )
        .await
        .unwrap();
        let access = crate::connector::mcp::Access::new(
            mcp.server(),
            mcp.binding("connection-c").unwrap().lease,
            Arc::new(AtomicBool::new(false)),
        );
        assert!(access.export().is_err());
    }

    #[test]
    fn a_full_quarantine_fails_closed_without_clearing_lanes_until_the_epoch_changes() {
        let mcp = Mcp::unsupported();
        for lane in 0..QUARANTINED_LANES {
            mcp.quarantine("mcp_a", &format!("ses_{lane}"));
        }
        assert!(mcp.quarantined("mcp_a", "ses_0"));
        assert!(!mcp.quarantined("mcp_a", "ses_unrelated"));
        mcp.quarantine("mcp_a", "ses_overflow");
        assert!(mcp.quarantined("mcp_a", "ses_0"));
        assert!(mcp.quarantined("mcp_a", &format!("ses_{}", QUARANTINED_LANES - 1)));
        assert!(mcp.quarantined("mcp_a", "ses_overflow"));
        assert!(mcp.quarantined("mcp_a", "ses_unrelated"));
        assert!(mcp.quarantined("mcp_a", ""));
        assert!(!mcp.quarantined("mcp_b", "ses_0"));
        mcp.quarantine("mcp_b", "ses_1");
        assert!(mcp.quarantined("mcp_b", "ses_1"));
        assert!(!mcp.quarantined("mcp_b", "ses_0"));
        assert!(!mcp.quarantined("mcp_a", "ses_0"));
    }
}
