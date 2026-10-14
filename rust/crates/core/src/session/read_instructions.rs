use super::{projector, store::Service as SessionStore};
use crate::{
    resources::{config::Configuration, instruction_discovery},
    tools::{
        context::{
            Context,
            consumers::{ConsumerFuture, ReadInstructions},
        },
        registry::Failure,
    },
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_schema::{JsonValue, ObjectEncoder, session, session_message};
use ycoding_store::session::NewEvent;

pub struct Service {
    sessions: SessionStore,
    root: PathBuf,
    configuration: Arc<Configuration>,
    claimed: Mutex<HashMap<session::Id, HashSet<PathBuf>>>,
}

impl Service {
    pub fn new(sessions: SessionStore, root: PathBuf, configuration: Arc<Configuration>) -> Self {
        Self {
            sessions,
            root,
            configuration,
            claimed: Mutex::new(HashMap::new()),
        }
    }

    pub async fn load(
        &self,
        session_id: &session::Id,
        paths: Vec<PathBuf>,
    ) -> Result<(), ycoding_store::Error> {
        let paths = paths
            .into_iter()
            .filter(|path| {
                self.configuration.capabilities.allows_instruction(
                    &path.to_string_lossy().as_ref().into(),
                    crate::resources::config::capabilities::InstructionSource::Project,
                )
            })
            .collect::<Vec<_>>();
        let claimed = {
            let mut all = self
                .claimed
                .lock()
                .map_err(|_| ycoding_store::Error::Rejected("instruction claim lock poisoned"))?;
            let existing = all.entry(session_id.clone()).or_default();
            paths
                .into_iter()
                .filter(|path| existing.insert(path.clone()))
                .collect::<Vec<_>>()
        };
        if claimed.is_empty() {
            return Ok(());
        }
        let existing = self.sessions.context(session_id)?;
        let injected = existing
            .iter()
            .filter_map(|message| match message {
                session_message::Info::Synthetic(message) => Some(
                    message
                        .metadata
                        .as_ref()
                        .and_then(|metadata| metadata.get(&"instruction".into()))
                        .and_then(|value| match value {
                            JsonValue::Object(instruction) => instruction.get(&"paths".into()),
                            _ => None,
                        })
                        .and_then(|value| match value {
                            JsonValue::Array(paths) => Some(paths),
                            _ => None,
                        })
                        .into_iter()
                        .flatten()
                        .filter_map(|path| match path {
                            JsonValue::String(path) => path.as_str().map(PathBuf::from),
                            _ => None,
                        })
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .flatten()
            .collect::<HashSet<_>>();
        let max_bytes = self
            .configuration
            .latest("instruction_max_bytes")
            .and_then(|value| match value {
                JsonValue::Number(value) if value.is_finite() && *value > 0.0 => {
                    Some(*value as usize)
                }
                _ => None,
            });
        let files = claimed
            .into_iter()
            .filter(|path| !injected.contains(path))
            .filter_map(|path| {
                fs::read_to_string(&path).ok().map(|content| {
                    let source = path.to_string_lossy();
                    let rendered =
                        instruction_discovery::render_content(&source, &content, max_bytes, "read");
                    (path, rendered.content)
                })
            })
            .collect::<Vec<_>>();
        if files.is_empty() {
            return Ok(());
        }
        let paths = files
            .iter()
            .map(|(path, _)| {
                ycoding_schema::LosslessString::from(path.to_string_lossy().into_owned())
            })
            .collect::<Vec<_>>();
        let description = files
            .iter()
            .map(|(path, _)| describe_path(&self.root, path))
            .collect::<Vec<_>>();
        let text = files
            .iter()
            .map(|(path, content)| format!("Instructions from: {}\n{content}", path.display()))
            .collect::<Vec<_>>()
            .join("\n\n");
        let metadata = ObjectEncoder::new()
            .field(
                "instruction",
                &ObjectEncoder::new().field("paths", &paths).finish(),
            )
            .finish();
        self.sessions
            .publish(NewEvent {
                id: projector::random_event_id()?.as_lossless().clone(),
                aggregate_id: session_id.as_lossless().clone(),
                created: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| ycoding_store::Error::Rejected("system time unavailable"))?
                    .as_millis() as i64,
                type_: "session.synthetic.1".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", session_id.as_lossless())
                    .field("text", text.as_str())
                    .field(
                        "description",
                        format!("Loaded {}", description.join(", ")).as_str(),
                    )
                    .field("metadata", &metadata)
                    .finish(),
            })
            .await?;
        Ok(())
    }
}

impl ReadInstructions for Service {
    fn load(&self, context: Context, paths: Vec<PathBuf>) -> ConsumerFuture<'_, ()> {
        Box::pin(async move {
            Service::load(self, &context.session_id, paths)
                .await
                .map_err(|error| Failure::message(error.to_string()))
        })
    }
}

fn describe_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).map_or_else(
        |_| path.to_string_lossy().into_owned(),
        |path| path.to_string_lossy().into_owned(),
    )
}
