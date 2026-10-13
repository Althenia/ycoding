use super::Error;
use crate::{dispatch::Boxed, ids};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::watch;
use ycoding_core::ycoding_schema::{JsonValue, parse_json};

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
            let metadata = match tokio::fs::symlink_metadata(&path).await {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                Err(_) => return Err(Error::Preference),
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 {
                return Err(Error::Preference);
            }
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(|_| Error::Preference)?;
            let parsed = parse_json(&text).map_err(|_| Error::Preference)?;
            Ok(
                matches!(parsed, JsonValue::Object(object) if object.get(&"enabled".into()) == Some(&JsonValue::Bool(true))),
            )
        })
    }

    fn save(&self, enabled: bool) -> Boxed<Result<(), Error>> {
        let path = self.0.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                if std::fs::symlink_metadata(&path)
                    .is_ok_and(|info| info.file_type().is_symlink() || !info.is_file())
                {
                    return Err(Error::Preference);
                }
                let parent = path.parent().ok_or(Error::Preference)?;
                std::fs::create_dir_all(parent).map_err(|_| Error::Preference)?;
                let temp = parent.join(convert_id()?);
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
                    write!(file, "{{\"enabled\":{enabled}}}").map_err(|_| Error::Preference)?;
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
        })
    }
}

fn convert_id() -> Result<String, Error> {
    ids::prefixed("remote-preference-")
        .map_err(|_| Error::Preference)?
        .to_utf8()
        .map_err(|_| Error::Preference)
}

struct Inner {
    preference: Arc<dyn Preference>,
    intent: watch::Sender<Intent>,
    status: watch::Sender<(Intent, Status)>,
    transition: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct Control(Arc<Inner>);

impl Control {
    pub async fn load(preference: Arc<dyn Preference>) -> Self {
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
            intent,
            status,
            transition: tokio::sync::Mutex::new(()),
        }))
    }

    pub fn status(&self) -> Status {
        self.0.status.borrow().1.clone()
    }

    pub fn observe(&self) -> watch::Receiver<(Intent, Status)> {
        self.0.status.subscribe()
    }

    pub async fn set(&self, enabled: bool) -> Result<Status, Error> {
        let _transition = self.0.transition.lock().await;
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
