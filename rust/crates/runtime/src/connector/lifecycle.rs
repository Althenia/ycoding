use super::{
    Error,
    mcp_state::{Mcp, McpFile, McpPreference, McpStatus, read_private, write_private},
};
use crate::dispatch::Boxed;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::watch;
use ycoding_core::{
    remote::Device,
    ycoding_schema::{JsonValue, parse_json},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Off,
    Connecting,
    On,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub state: State,
    pub message: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Intent {
    pub enabled: bool,
    pub generation: u64,
}

pub trait Preference: Send + Sync {
    fn load(&self) -> Boxed<Result<bool, Error>>;
    fn save(&self, enabled: bool) -> Boxed<Result<(), Error>>;
}

pub struct PreferenceFile(pub PathBuf);

impl Preference for PreferenceFile {
    fn load(&self) -> Boxed<Result<bool, Error>> {
        let path = self.0.clone();
        Box::pin(async move {
            let Some(text) = read_private(&path).await? else {
                return Ok(false);
            };
            let parsed = parse_json(&text).map_err(|_| Error::Preference)?;
            Ok(
                matches!(parsed, JsonValue::Object(object) if object.get(&"enabled".into()) == Some(&JsonValue::Bool(true))),
            )
        })
    }

    fn save(&self, enabled: bool) -> Boxed<Result<(), Error>> {
        Box::pin(write_private(
            self.0.clone(),
            format!("{{\"enabled\":{enabled}}}"),
            "remote-preference-",
        ))
    }
}

struct Inner {
    preference: Arc<dyn Preference>,
    device: Device,
    intent: watch::Sender<Intent>,
    status: watch::Sender<(Intent, Status)>,
    transition: tokio::sync::Mutex<()>,
    mcp: Mcp,
}

#[derive(Clone)]
pub struct Control(Arc<Inner>);

impl Control {
    pub async fn open(state: &Path) -> Result<Self, Error> {
        Ok(Self::load(
            Arc::new(PreferenceFile(state.join("remote.json"))),
            Device::new(state).map_err(|_| Error::Setup)?,
        )
        .await)
    }

    pub async fn open_with_home(state: &Path, home: &Path) -> Result<Self, Error> {
        Ok(Self::load_with_mcp(
            Arc::new(PreferenceFile(state.join("remote.json"))),
            Arc::new(McpFile(state.join("remote-mcp.json"))),
            Device::new(state).map_err(|_| Error::Setup)?,
            home.to_path_buf(),
        )
        .await)
    }

    pub async fn load(preference: Arc<dyn Preference>, device: Device) -> Self {
        Self::build(preference, device, Mcp::unsupported()).await
    }

    pub async fn load_with_mcp(
        preference: Arc<dyn Preference>,
        mcp: Arc<dyn McpPreference>,
        device: Device,
        home: PathBuf,
    ) -> Self {
        Self::build(preference, device, Mcp::load(mcp, home).await).await
    }

    async fn build(preference: Arc<dyn Preference>, device: Device, mcp: Mcp) -> Self {
        let loaded = preference.load().await;
        let enabled = loaded.as_ref().copied().unwrap_or(false);
        let (intent, _) = watch::channel(Intent {
            enabled,
            generation: 1,
        });
        let (status, _) = watch::channel((
            Intent {
                enabled,
                generation: 1,
            },
            Status {
                state: if loaded.is_err() {
                    State::Error
                } else if enabled {
                    State::Connecting
                } else {
                    State::Off
                },
                message: loaded
                    .is_err()
                    .then_some("Could not read remote preference"),
            },
        ));
        Self(Arc::new(Inner {
            preference,
            device,
            intent,
            status,
            transition: tokio::sync::Mutex::new(()),
            mcp,
        }))
    }

    pub fn device(&self) -> &Device {
        &self.0.device
    }

    pub fn status(&self) -> Status {
        self.0.status.borrow().1.clone()
    }

    pub fn observe(&self) -> watch::Receiver<(Intent, Status)> {
        self.0.status.subscribe()
    }

    pub fn mcp_status(&self) -> McpStatus {
        self.0.mcp.status()
    }

    pub fn mcp_observe(&self) -> watch::Receiver<McpStatus> {
        self.0.mcp.observe()
    }

    pub async fn set_mcp(&self, enabled: bool) -> Result<McpStatus, Error> {
        let _transition = self.0.transition.lock().await;
        let remote = self.0.status.borrow().0.enabled;
        self.0.mcp.set(enabled, remote).await
    }

    pub(crate) fn mcp(&self) -> &Mcp {
        &self.0.mcp
    }

    pub async fn set(&self, enabled: bool) -> Result<Status, Error> {
        let _transition = self.0.transition.lock().await;
        if !enabled {
            self.0.mcp.force_off().await;
        }
        self.0.preference.save(enabled).await?;
        let previous = self.0.status.borrow().clone();
        if previous.0.enabled == enabled && (!enabled || previous.1.state != State::Error) {
            return Ok(previous.1);
        }
        let next = {
            let next = Intent {
                enabled,
                generation: self
                    .0
                    .status
                    .borrow()
                    .0
                    .generation
                    .checked_add(1)
                    .ok_or(Error::Setup)?,
            };
            self.0.status.send_replace((
                next,
                Status {
                    state: if enabled {
                        State::Connecting
                    } else {
                        State::Off
                    },
                    message: None,
                },
            ));
            next
        };
        self.0.intent.send_replace(next);
        Ok(self.status())
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<Intent> {
        self.0.intent.subscribe()
    }

    pub(crate) fn current(&self, generation: u64) -> bool {
        let status = self.0.status.borrow();
        status.0.enabled && status.0.generation == generation
    }

    pub(crate) fn stop(&self) {
        self.0.mcp.close();
        let next = Intent {
            enabled: false,
            generation: self.0.status.borrow().0.generation.saturating_add(1),
        };
        self.0.status.send_replace((
            next,
            Status {
                state: State::Off,
                message: None,
            },
        ));
        self.0.intent.send_replace(next);
    }

    pub(crate) fn publish(&self, generation: u64, state: State, message: Option<&'static str>) {
        self.0.status.send_if_modified(|status| {
            if status.0.generation != generation || !status.0.enabled {
                return false;
            }
            let next = Status { state, message };
            if status.1 == next {
                return false;
            }
            status.1 = next;
            true
        });
    }
}
