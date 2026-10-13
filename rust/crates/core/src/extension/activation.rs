use super::{Configuration, Error, Extension, Host, Options, capabilities};
use crate::{
    event_feed::{Data, EventSource},
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::Registry,
    },
};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
use ycoding_schema::plugin;

pub struct Activation {
    pub event_source: EventSource,
    directory: PathBuf,
    options: Options,
    registry: Arc<Registry>,
    policy: Arc<LeafPolicy>,
    launch: Context,
    host: Host,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    active: Vec<(Configuration, Arc<Extension>)>,
    closed: bool,
}

impl Activation {
    pub fn new(
        directory: PathBuf,
        options: Options,
        registry: Arc<Registry>,
        policy: Arc<LeafPolicy>,
        launch: Context,
        host: Host,
    ) -> Self {
        Self {
            event_source: Default::default(),
            directory,
            options,
            registry,
            policy,
            launch,
            host,
            state: Default::default(),
        }
    }

    pub async fn activate(&self, configurations: Vec<Configuration>) -> Result<(), Error> {
        let mut ids = BTreeSet::new();
        if configurations.iter().any(|configuration| {
            !ids.insert(configuration.identity.as_str())
                || capabilities::PRE.contains(&configuration.identity.as_str())
                || capabilities::POST.contains(&configuration.identity.as_str())
        }) {
            return Err(Error::InvalidConfiguration);
        }
        let mut state = self.state.lock().await;
        if state.closed {
            return Err(Error::Stopped);
        }
        if state
            .active
            .iter()
            .map(|entry| &entry.0)
            .eq(configurations.iter())
        {
            return Ok(());
        }
        for configuration in &configurations {
            let previous = state
                .active
                .iter()
                .position(|entry| entry.0.identity == configuration.identity);
            if let Some(previous) = previous {
                state.active[previous].1.shutdown().await;
            }
            let previous = previous.map(|position| state.active.remove(position));
            if let Some(extension) = self.load(configuration.clone()).await {
                state.active.push((configuration.clone(), extension));
                continue;
            }
            if let Some((configuration, _)) = previous {
                if let Some(extension) = self.load(configuration.clone()).await {
                    state.active.push((configuration, extension));
                    continue;
                }
                eprintln!("Process extension restoration failed; deactivated");
            }
        }
        for position in (0..state.active.len()).rev() {
            if ids.contains(state.active[position].0.identity.as_str()) {
                continue;
            }
            state.active[position].1.shutdown().await;
            state.active.remove(position);
        }
        if self
            .event_source
            .emit(Data::PluginUpdated(Box::new(
                ycoding_schema::models_dev::Empty,
            )))
            .is_err()
        {
            eprintln!("Plugin updated event publication failed");
        }
        Ok(())
    }

    pub async fn reload(
        &self,
        configuration: &crate::resources::config::Configuration,
    ) -> Result<(), Error> {
        self.activate(Configuration::load(configuration, self.directory.clone())?)
            .await
    }

    pub async fn list(&self) -> Vec<String> {
        self.state
            .lock()
            .await
            .active
            .iter()
            .map(|entry| entry.0.identity.clone())
            .collect()
    }

    pub async fn extensions(&self) -> Vec<Arc<Extension>> {
        self.state
            .lock()
            .await
            .active
            .iter()
            .map(|entry| entry.1.clone())
            .collect()
    }

    pub async fn plugin_list(&self) -> Vec<plugin::Info> {
        capabilities::PRE
            .iter()
            .map(|id| plugin::Info { id: (*id).into() })
            .chain(
                self.list()
                    .await
                    .into_iter()
                    .map(|id| plugin::Info { id: id.into() }),
            )
            .chain(
                capabilities::POST
                    .iter()
                    .map(|id| plugin::Info { id: (*id).into() }),
            )
            .collect()
    }

    pub async fn close(&self) {
        let mut state = self.state.lock().await;
        state.closed = true;
        while let Some(entry) = state.active.last() {
            entry.1.shutdown().await;
            state.active.pop();
        }
    }

    async fn load(&self, configuration: Configuration) -> Option<Arc<Extension>> {
        let id = configuration.identity.clone();
        match Extension::start(
            configuration,
            self.options.clone(),
            &self.registry,
            self.policy.clone(),
            &self.launch,
            self.host.clone(),
        )
        .await
        {
            Ok(extension) => {
                if self
                    .event_source
                    .emit(Data::PluginAdded(Box::new(plugin::AddedData {
                        id: id.into(),
                    })))
                    .is_err()
                {
                    eprintln!("Plugin added event publication failed");
                }
                Some(Arc::new(extension))
            }
            Err(error) => {
                eprintln!("Process extension activation failed for {id}: {error}");
                None
            }
        }
    }
}
