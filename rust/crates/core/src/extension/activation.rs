use super::{
    Configuration, Error, Extension, Host, Launch, Options, capabilities,
    supervisor::ParentPreparation,
};
use crate::{
    event_feed::{Data, EventSource},
    tools::{context::policy::LeafPolicy, registry::Registry},
};
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, Mutex as SyncMutex},
};
use tokio::sync::Mutex;
use ycoding_schema::{LosslessString, plugin};

pub struct Activation {
    pub event_source: EventSource,
    directory: PathBuf,
    options: Options,
    registry: Arc<Registry>,
    policy: Arc<LeafPolicy>,
    launch: Launch,
    host: Host,
    parent: Option<super::ParentHandle>,
    parents: SyncMutex<Vec<(super::v5::ParentEntry, Arc<Extension>)>>,
    parent_prepare: Mutex<bool>,
    initial_setup: Mutex<bool>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    active: Vec<(Configuration, Arc<Extension>)>,
    failures: Vec<(String, Error)>,
    builtins: super::plugin::Builtins,
    closed: bool,
}

impl Activation {
    pub fn new(
        directory: PathBuf,
        options: Options,
        registry: Arc<Registry>,
        policy: Arc<LeafPolicy>,
        launch: Launch,
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
            parent: None,
            parents: Default::default(),
            parent_prepare: Mutex::new(false),
            initial_setup: Mutex::new(false),
            state: Default::default(),
        }
    }

    pub fn with_parent_plugins(mut self, parent: super::ParentHandle) -> Self {
        self.parent = Some(parent);
        self
    }

    pub async fn prepare_plugins(
        &self,
        configuration: &crate::resources::config::Configuration,
    ) -> Result<(), Error> {
        let mut prepared = self.parent_prepare.lock().await;
        if *prepared {
            return Ok(());
        }
        let entries = self
            .parent
            .as_ref()
            .map(super::ParentHandle::entries)
            .transpose()?
            .unwrap_or_default();
        let parent_ids = entries
            .iter()
            .map(|entry| LosslessString::from(entry.id.as_str()))
            .collect::<Vec<_>>();
        let mut processes = Configuration::load(configuration, self.directory.clone())?;
        let (builtins, enabled) = super::plugin::resolve(
            &super::plugin::operations(&configuration.entries),
            &parent_ids,
        );
        if let Some(parent) = &self.parent {
            for (order, entry) in entries
                .into_iter()
                .filter(|entry| {
                    let id = LosslessString::from(entry.id.as_str());
                    enabled.contains(&id) && configuration.capabilities.plugins.allows(&id)
                })
                .enumerate()
            {
                let extension = parent
                    .prepare(ParentPreparation {
                        entry: entry.clone(),
                        directory: self.directory.clone(),
                        order: order as u32,
                        options: self.options.clone(),
                        registry: self.registry.clone(),
                        policy: self.policy.clone(),
                        launch: self.launch.clone(),
                        host: self.host.clone(),
                    })
                    .await?;
                self.parents
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push((entry, extension));
            }
        }
        let offset = self.parent_extensions().len() as u32;
        for process in &mut processes {
            process.registration_order += offset;
        }
        let mut active = Vec::new();
        let mut failures = Vec::new();
        for process in processes {
            match Extension::prepare_process(
                process.clone(),
                self.options.clone(),
                self.registry.clone(),
                self.policy.clone(),
                &self.launch,
                self.host.clone(),
            )
            .await
            {
                Ok(extension) => active.push((process, extension)),
                Err(error) => failures.push((process.identity, error)),
            }
        }
        self.registry.settle_builtins(&builtins);
        let mut state = self.state.lock().await;
        if state.closed {
            return Err(Error::Stopped);
        }
        state.active = active;
        state.failures = failures;
        state.builtins = builtins;
        *prepared = true;
        Ok(())
    }

    pub async fn plugin_services(&self, services: super::SessionServices) -> Result<(), Error> {
        if let Some(parent) = &self.parent {
            parent.bind_services(services.clone())?;
        }
        for (_, extension) in self
            .parents
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
        {
            extension.parent_services(services.clone())?;
        }
        Ok(())
    }

    fn parent_extensions(&self) -> Vec<Arc<Extension>> {
        self.parents
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(_, extension)| extension.clone())
            .collect()
    }

    pub async fn activate(&self, configurations: Vec<Configuration>) -> Result<(), Error> {
        self.apply(configurations, Default::default()).await
    }

    async fn apply(
        &self,
        configurations: Vec<Configuration>,
        builtins: super::plugin::Builtins,
    ) -> Result<(), Error> {
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
        self.registry.settle_builtins(&builtins);
        if state
            .active
            .iter()
            .map(|entry| &entry.0)
            .eq(configurations.iter())
        {
            state.builtins = builtins;
            return Ok(());
        }
        state.builtins = builtins;
        state.failures.clear();
        for configuration in &configurations {
            let previous = state
                .active
                .iter()
                .position(|entry| entry.0.identity == configuration.identity);
            if let Some(previous) = previous {
                state.active[previous].1.shutdown().await;
            }
            let previous = previous.map(|position| state.active.remove(position));
            let failure = match self.load(configuration.clone()).await {
                Ok(extension) => {
                    state.active.push((configuration.clone(), extension));
                    continue;
                }
                Err(error) => error,
            };
            state
                .failures
                .push((configuration.identity.clone(), failure));
            if let Some((configuration, _)) = previous {
                match self.load(configuration.clone()).await {
                    Ok(extension) => state.active.push((configuration, extension)),
                    Err(_) => tracing::error!(
                        identity = configuration.identity,
                        "process extension restoration failed; deactivated"
                    ),
                }
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
        if self.parent.is_some() && !*self.parent_prepare.lock().await {
            self.prepare_plugins(configuration).await?;
        }
        if *self.parent_prepare.lock().await {
            let mut initial = self.initial_setup.lock().await;
            if !*initial {
                for extension in self.parent_extensions() {
                    extension.setup_plugin().await?;
                    extension.reload_integrations().await?;
                }
                let configured = self.state.lock().await.active.clone();
                for (spec, extension) in configured {
                    if let Err(error) = extension.setup_plugin().await {
                        extension.shutdown().await;
                        let mut state = self.state.lock().await;
                        state
                            .active
                            .retain(|(_, active)| !Arc::ptr_eq(active, &extension));
                        state.failures.push((spec.identity, error));
                    }
                }
                *initial = true;
                return Ok(());
            }
        }
        let parents = self.parent_extensions();
        let mut processes = Configuration::load(configuration, self.directory.clone())?;
        for process in &mut processes {
            process.registration_order += parents.len() as u32;
        }
        let builtins =
            super::plugin::disabled_from_entries(&configuration.entries, &self.directory);
        self.apply(processes, builtins).await
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

    pub async fn failures(&self) -> Vec<(String, Error)> {
        self.state.lock().await.failures.clone()
    }

    pub async fn builtins(&self) -> super::plugin::Builtins {
        self.state.lock().await.builtins.clone()
    }

    pub async fn disabled_builtins(&self) -> BTreeSet<String> {
        self.state.lock().await.builtins.disabled.clone()
    }

    pub async fn builtin_disabled(&self, id: &str) -> bool {
        self.state.lock().await.builtins.is_disabled(id)
    }

    pub async fn builtin_diagnostic(&self) -> Option<ycoding_schema::config::Diagnostic> {
        self.state.lock().await.builtins.diagnostic()
    }

    pub async fn extensions(&self) -> Vec<Arc<Extension>> {
        self.parent_extensions()
            .into_iter()
            .chain(
                self.state
                    .lock()
                    .await
                    .active
                    .iter()
                    .map(|entry| entry.1.clone())
                    .collect::<Vec<_>>(),
            )
            .collect()
    }
    pub(crate) async fn reload_integrations(&self) -> Result<(), Error> {
        for extension in self.parent_extensions() {
            extension.reload_integrations().await?;
        }
        Ok(())
    }

    pub async fn is_closed(&self) -> bool {
        self.state.lock().await.closed
    }

    pub async fn declared_plugins(&self) -> Vec<plugin::Info> {
        self.parent_extensions()
            .into_iter()
            .filter_map(|extension| extension.declared_id().cloned())
            .map(|id| plugin::Info { id })
            .collect()
    }

    pub async fn plugin_list(&self) -> Vec<plugin::Info> {
        let disabled = self.disabled_builtins().await;
        capabilities::PRE
            .iter()
            .filter(|id| !disabled.contains(**id))
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
                    .filter(|id| !disabled.contains(**id))
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
        drop(state);
        for extension in self.parent_extensions().into_iter().rev() {
            extension.shutdown().await;
        }
    }

    async fn load(&self, configuration: Configuration) -> Result<Arc<Extension>, Error> {
        let id = configuration.identity.clone();
        let started = Extension::start(
            configuration,
            self.options.clone(),
            &self.registry,
            self.policy.clone(),
            &self.launch,
            self.host.clone(),
        )
        .await;
        match started {
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
                Ok(Arc::new(extension))
            }
            Err(error) => {
                tracing::error!(identity = id, %error, "process extension activation failed");
                Err(error)
            }
        }
    }
}
