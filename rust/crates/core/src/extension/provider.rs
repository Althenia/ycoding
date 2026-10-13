use super::{Error, families, supervisor::Shared, v5, wire};
use std::{
    collections::BTreeMap,
    sync::{Arc, RwLock},
};
use ycoding_ai::{
    Error as AiError,
    route::{AttemptFuture, ProcessAttempt, ProcessInput},
};

pub struct ProcessProvider {
    shared: Arc<Shared>,
    package: String,
}

struct Entry {
    generation: String,
    provider: Arc<ProcessProvider>,
}

static REGISTRY: std::sync::LazyLock<RwLock<BTreeMap<String, Entry>>> =
    std::sync::LazyLock::new(|| RwLock::new(BTreeMap::new()));

pub(super) fn register_generation(shared: &Arc<Shared>, generation: &str) {
    let mut registry = REGISTRY.write().unwrap_or_else(|error| error.into_inner());
    for grant in &shared.families {
        if grant.family != v5::CapabilityFamily::Providers {
            continue;
        }
        for scope in &grant.scopes {
            registry.insert(
                scope.clone(),
                Entry {
                    generation: generation.into(),
                    provider: Arc::new(ProcessProvider {
                        shared: shared.clone(),
                        package: scope.clone(),
                    }),
                },
            );
        }
    }
}

pub(super) fn unregister_generation(generation: &str) {
    REGISTRY
        .write()
        .unwrap_or_else(|error| error.into_inner())
        .retain(|_, entry| entry.generation != generation);
}

pub fn find(package: &str) -> Option<Arc<ProcessProvider>> {
    REGISTRY
        .read()
        .unwrap_or_else(|error| error.into_inner())
        .get(package)
        .map(|entry| entry.provider.clone())
}

struct Cancel {
    shared: Arc<Shared>,
    request: u64,
    armed: bool,
}

impl Drop for Cancel {
    fn drop(&mut self) {
        if self.armed {
            self.shared.provider_cancel(self.request);
        }
    }
}

impl ProcessAttempt for ProcessProvider {
    fn attempt(&self, input: ProcessInput) -> AttemptFuture<'_> {
        Box::pin(async move {
            let grant =
                families::grant(&self.shared, v5::CapabilityFamily::Providers, &self.package)
                    .map_err(|_| AiError::invalid("Process provider package is not granted"))?;
            let resources = grant
                .resources
                .iter()
                .map(|resource| resource.as_str().into())
                .collect::<Vec<_>>();
            let caller = input.caller.as_ref().ok_or_else(|| {
                AiError::invalid("Process provider attempts require the calling Session")
            })?;
            let context = crate::tools::context::Context::new(
                caller.session_id.as_str().unwrap_or_default(),
                caller.agent.as_str().unwrap_or_default(),
                caller.message_id.as_str().unwrap_or_default(),
                &format!("provider:{}", self.package),
            )
            .map_err(|_| AiError::invalid("Process provider caller identity is invalid"))?;
            self.shared
                .policy
                .assert(&context, &grant.action, resources.clone(), vec![], None)
                .await
                .map_err(|_| AiError::invalid("Process provider authority rejected"))?;
            let _reservation = self
                .shared
                .policy
                .reserve(&context, &grant.action, resources, None)
                .await
                .map_err(|_| AiError::invalid("Process provider authority rejected"))?;
            let attempt = v5::ProviderAttempt {
                package: self.package.clone(),
                model: input
                    .model
                    .to_utf8()
                    .map_err(|_| AiError::invalid("Process provider model is not UTF-8"))?,
                options: input.options.as_ref().map(wire::value),
                body: wire::value(&input.body),
            };
            if prost::Message::encoded_len(&attempt) >= wire::FRAME_BYTES - 1024 {
                return Err(AiError::invalid(
                    "Process provider request does not fit one frame",
                ));
            }
            let (request, receive) = self
                .shared
                .provider_attempt(attempt)
                .await
                .map_err(provider_error)?;
            let mut cancel = Cancel {
                shared: self.shared.clone(),
                request,
                armed: true,
            };
            let frames = receive.await.map_err(|_| {
                AiError::transport("Process provider attempt ended without a reply", "read")
            })?;
            cancel.armed = false;
            frames.map_err(provider_error)
        })
    }
}

fn provider_error(error: Error) -> AiError {
    match error {
        Error::Unauthorized | Error::Permission | Error::Rejected => {
            AiError::invalid("Process provider attempt rejected")
        }
        Error::Timeout => AiError::transport("Process provider attempt timed out", "Timeout"),
        Error::Capacity => AiError::transport("Process provider capacity exhausted", "Capacity"),
        Error::Stopped | Error::Cancelled => AiError::interrupted(),
        Error::UnknownOutcome => AiError::transport(
            "Process provider outcome unknown; replay prohibited",
            "read",
        ),
        _ => AiError::output("Process provider attempt failed"),
    }
}
