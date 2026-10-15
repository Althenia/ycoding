use super::Factory;
use std::sync::Arc;
use ycoding_core::{
    session::{run_coordinator, runner},
    ycoding_schema::location,
};

impl Factory {
    pub(super) fn refresh(&self, info: location::Info) -> Option<runner::Refresh> {
        let locations = self.locations.get()?.clone();
        Some(Arc::new(move || {
            let locations = locations.clone();
            let info = info.clone();
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    let locations = locations.upgrade().ok_or(run_coordinator::Error::Closed)?;
                    let current = locations
                        .location(
                            info.directory.as_lossless(),
                            info.workspace_id.as_ref().map(|id| id.as_lossless()),
                        )
                        .map_err(|_| run_coordinator::Error::Closed)?;
                    let composed = current
                        .production
                        .as_ref()
                        .ok_or(run_coordinator::Error::Closed)?;
                    let configuration = composed.configuration.snapshot().map_err(|_| {
                        configuration_error("Location configuration could not be read")
                    })?;
                    if configuration.entries != composed.configuration.entries {
                        locations
                            .reload_generation(&info, composed.generation)
                            .map_err(|_| {
                                configuration_error("Location configuration could not be reloaded")
                            })?;
                    }
                    let current = locations
                        .location(
                            info.directory.as_lossless(),
                            info.workspace_id.as_ref().map(|id| id.as_lossless()),
                        )
                        .map_err(|_| run_coordinator::Error::Closed)?;
                    let composed = current
                        .production
                        .as_ref()
                        .ok_or(run_coordinator::Error::Closed)?;
                    Ok(runner::Refreshed {
                        runner: composed.runner.clone(),
                        generate: composed.session_generate.clone(),
                        owner: current,
                    })
                })
                .await
                .map_err(|_| run_coordinator::Error::Closed)?
            })
        }))
    }
}

fn configuration_error(message: &str) -> run_coordinator::Error {
    run_coordinator::Error::Runner(ycoding_core::ycoding_schema::session_error::Error {
        r#type: "configuration".into(),
        message: message.into(),
    })
}
