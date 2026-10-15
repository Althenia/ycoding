use super::{Factory, unavailable};
use crate::{dispatch::Failure, locations::ServiceSet};
use std::{path::Path, sync::Arc};
use tokio::sync::watch;
use ycoding_core::{
    event_feed::Data,
    platform::{filesystem::watcher::LocationWatcher, git},
    ycoding_schema::{JsonValue, location, vcs_event},
};

pub(super) struct Owner {
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<(), Failure>>,
}

impl Owner {
    pub fn start(
        factory: &Factory,
        services: &ServiceSet,
        configuration: &ycoding_core::resources::config::Configuration,
        directory: &Path,
    ) -> Result<Option<Self>, Failure> {
        if directory == factory.options.roots.home.as_path()
            && factory
                .git
                .discover(directory)
                .map_err(|_| unavailable("Location repository observation"))?
                .is_none()
        {
            return Ok(None);
        }
        let ignored = configuration
            .latest("watcher")
            .and_then(|value| match value {
                JsonValue::Object(value) => value.get(&"ignore".into()),
                _ => None,
            })
            .and_then(|value| match value {
                JsonValue::Array(values) => Some(
                    values
                        .iter()
                        .filter_map(|value| match value {
                            JsonValue::String(value) => value.as_str().map(str::to_owned),
                            _ => None,
                        })
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            })
            .unwrap_or_default();
        let mut watcher = LocationWatcher::start(
            &factory.globals.watcher,
            &factory.git,
            directory,
            &factory.options.roots.home,
            std::env::consts::OS,
            true,
            &ignored,
        )
        .map_err(|_| unavailable("Location filesystem observer"))?;
        let reference = location::Ref {
            directory: services.info.directory.clone(),
            workspace_id: services.info.workspace_id.clone(),
        };
        watcher
            .event_source
            .bind(factory.events.clone(), Some(reference.clone()))
            .map_err(|_| unavailable("Location observer events"))?;
        let feed = factory.events.clone();
        let git = factory.git.clone();
        let directory = directory.to_path_buf();
        let mut branch = git::vcs::branch(&git, &directory).current;
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stopped.changed() => return Ok(()),
                    update = watcher.recv() => {
                        let update = update.map_err(|_| unavailable("Location filesystem observation"))?;
                        if Path::new(update.file.as_str().unwrap_or("")).file_name().is_none_or(|name| name != "HEAD") { continue; }
                        let git = Arc::clone(&git);
                        let directory = directory.clone();
                        let current = tokio::task::spawn_blocking(move || git::vcs::branch(&git, &directory).current).await.map_err(|_| unavailable("Location HEAD observation"))?;
                        if current == branch { continue; }
                        branch = current;
                        feed.emit(Data::VcsBranchUpdated(Box::new(vcs_event::BranchUpdatedData { branch: branch.as_deref().map(Into::into) })), Some(reference.clone())).map_err(|_| unavailable("Location branch publication"))?;
                    }
                }
            }
        });
        Ok(Some(Self { stop, task }))
    }

    pub async fn close(self) -> Result<(), Failure> {
        self.stop.send_replace(true);
        self.task
            .await
            .map_err(|_| unavailable("Location observer worker"))?
    }
}
