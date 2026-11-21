use super::{
    Configuration, Error, Extension, Host, Launch, Options, Plugin, PluginRuntime, capabilities,
    supervisor::{Declaration, ParentPreparation},
};
use crate::{
    event_feed::{Data, EventSource},
    resources::config::capabilities::ConfigCapabilities,
    tools::{context::policy::LeafPolicy, registry::Registry},
};
use std::{
    collections::{BTreeMap, BTreeSet},
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
    plugins: Option<PluginRuntime>,
    parent: Option<super::ParentHandle>,
    parents: SyncMutex<Vec<(super::v5::ParentEntry, Arc<Extension>)>>,
    parent_prepare: Mutex<bool>,
    initial_setup: Mutex<bool>,
    state: Mutex<State>,
}

#[derive(Clone, Debug, PartialEq)]
enum Spec {
    Process(Configuration),
    Plugin(Plugin),
}
impl Spec {
    fn identity(&self) -> &str {
        match self {
            Self::Process(configuration) => &configuration.identity,
            Self::Plugin(plugin) => plugin.identity(),
        }
    }
}

#[derive(Default)]
struct State {
    active: Vec<(Spec, Arc<Extension>)>,
    packages: BTreeMap<String, Arc<Extension>>,
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
            plugins: None,
            parent: None,
            parents: Default::default(),
            parent_prepare: Mutex::new(false),
            initial_setup: Mutex::new(false),
            state: Default::default(),
        }
    }

    pub fn with_plugins(mut self, runtime: PluginRuntime) -> Self {
        self.plugins = Some(runtime);
        self
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
        let (mut plugins, mut pending, failures, builtins, enabled) = self
            .resolve(configuration, processes.len() as u32, &parent_ids)
            .await;
        if let Some(parent) = &self.parent {
            for (order, entry) in entries
                .into_iter()
                .filter(|entry| enabled.contains(&LosslessString::from(entry.id.as_str())))
                .enumerate()
            {
                let extension = match parent
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
                    .await
                {
                    Ok(extension) => extension,
                    Err(error) => {
                        for declaration in pending.into_values() {
                            declaration.discard().await;
                        }
                        return Err(error);
                    }
                };
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
        for plugin in &mut plugins {
            plugin.configuration.registration_order += offset;
        }
        let mut active = Vec::new();
        let mut failures = failures;
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
                Ok(extension) => active.push((Spec::Process(process), extension)),
                Err(error) => failures.push((process.identity, error)),
            }
        }
        for plugin in plugins {
            if let Some(declaration) = pending.remove(plugin.identity()) {
                match declaration
                    .prepare(
                        self.registry.clone(),
                        plugin.configuration.registration_order,
                    )
                    .await
                {
                    Ok(extension) => active.push((Spec::Plugin(plugin), extension)),
                    Err(error) => failures.push((plugin.identity().to_owned(), error)),
                }
            }
        }
        for declaration in pending.into_values() {
            declaration.discard().await;
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
        for (_, extension) in &self.state.lock().await.active {
            if extension.trusted() {
                extension.parent_services(services.clone())?;
            }
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
        self.apply(
            configurations.into_iter().map(Spec::Process).collect(),
            Vec::new(),
            Default::default(),
            &mut BTreeMap::new(),
        )
        .await
    }

    async fn apply(
        &self,
        configurations: Vec<Spec>,
        failures: Vec<(String, Error)>,
        builtins: super::plugin::Builtins,
        pending: &mut BTreeMap<String, Declaration>,
    ) -> Result<(), Error> {
        let mut ids = BTreeSet::new();
        if configurations.iter().any(|configuration| {
            !ids.insert(configuration.identity())
                || capabilities::PRE.contains(&configuration.identity())
                || capabilities::POST.contains(&configuration.identity())
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
            if !failures.is_empty() {
                state.failures = failures;
            }
            return Ok(());
        }
        state.builtins = builtins;
        state.failures = failures;
        for extension in std::mem::take(&mut state.packages).into_values() {
            extension.shutdown().await;
        }
        for configuration in &configurations {
            let previous = state
                .active
                .iter()
                .position(|entry| entry.0.identity() == configuration.identity());
            if let Some(previous) = previous {
                state.active[previous].1.shutdown().await;
            }
            let previous = previous.map(|position| state.active.remove(position));
            let failure = match self.load(configuration.clone(), pending).await {
                Ok(Some(extension)) => {
                    state.active.push((configuration.clone(), extension));
                    continue;
                }
                Ok(None) => continue,
                Err(error) => error,
            };
            state
                .failures
                .push((configuration.identity().to_owned(), failure));
            if let Some((configuration, _)) = previous {
                match self.load(configuration.clone(), pending).await {
                    Ok(Some(extension)) => state.active.push((configuration, extension)),
                    Ok(None) => {}
                    Err(_) => tracing::error!(
                        identity = configuration.identity(),
                        "process extension restoration failed; deactivated"
                    ),
                }
            }
        }
        for position in (0..state.active.len()).rev() {
            if ids.contains(state.active[position].0.identity()) {
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
                        state.failures.push((spec.identity().to_owned(), error));
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
        let parent_ids = self
            .parent
            .as_ref()
            .map(super::ParentHandle::entries)
            .transpose()?
            .unwrap_or_default()
            .into_iter()
            .map(|entry| LosslessString::from(entry.id))
            .collect::<Vec<_>>();
        let (plugins, mut pending, failures, builtins, _) = self
            .resolve(
                configuration,
                (parents.len() + processes.len()) as u32,
                &parent_ids,
            )
            .await;
        let applied = self
            .apply(
                processes
                    .into_iter()
                    .map(Spec::Process)
                    .chain(plugins.into_iter().map(Spec::Plugin))
                    .collect(),
                failures,
                builtins,
                &mut pending,
            )
            .await;
        for declaration in pending.into_values() {
            declaration.discard().await;
        }
        applied
    }

    async fn resolve(
        &self,
        configuration: &crate::resources::config::Configuration,
        offset: u32,
        parent_ids: &[LosslessString],
    ) -> (
        Vec<Plugin>,
        BTreeMap<String, Declaration>,
        Vec<(String, Error)>,
        super::plugin::Builtins,
        BTreeSet<LosslessString>,
    ) {
        let selection = ConfigCapabilities::resolve(&configuration.entries).plugins;
        let builtins = capabilities::PRE
            .iter()
            .chain(capabilities::POST)
            .map(|id| LosslessString::from(*id))
            .collect::<Vec<_>>();
        let mut enabled = builtins
            .iter()
            .chain(parent_ids)
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut packages: Vec<Declaration> = Vec::new();
        let mut seen = Vec::new();
        let mut failures: Vec<(String, Error)> = Vec::new();
        for operation in super::plugin::operations(configuration, &self.directory) {
            if seen.contains(&operation) {
                continue;
            }
            seen.push(operation.clone());
            let ids = builtins
                .iter()
                .chain(parent_ids)
                .chain(packages.iter().map(|declaration| &declaration.id));
            let (target, options) = match operation {
                super::plugin::Operation::InvalidFileUrl { .. } => {
                    failures.push(("plugin.file-url".to_owned(), Error::InvalidConfiguration));
                    continue;
                }
                super::plugin::Operation::Remove(selector) => {
                    let matched = ids
                        .filter(|id| super::plugin::matches(&selector, id))
                        .cloned()
                        .collect::<Vec<_>>();
                    for id in &matched {
                        enabled.remove(id);
                    }
                    continue;
                }
                super::plugin::Operation::Add { target, options } => (target, options),
            };
            let matched = ids
                .filter(|id| super::plugin::matches(&target, id))
                .cloned()
                .collect::<Vec<_>>();
            if !matched.is_empty() || super::plugin::selects(&target) {
                enabled.extend(matched);
                continue;
            }
            if selection.enabled == Some(false) {
                continue;
            }
            let Some(runtime) = &self.plugins else {
                let identity = super::plugin::identity(&target);
                if !failures.iter().any(|(existing, _)| *existing == identity) {
                    failures.push((identity, Error::Spawn));
                }
                continue;
            };
            let mut candidate =
                super::plugin::launch(target, options, self.directory.clone(), runtime);
            candidate.selection = selection.clone();
            let identity = candidate.identity().to_owned();
            let declaration = match Extension::declare(
                candidate,
                self.options.clone(),
                self.policy.clone(),
                &self.launch,
                self.host.clone(),
            )
            .await
            {
                Ok(declaration) => declaration,
                Err(error) => {
                    tracing::error!(identity, %error, "process extension activation failed");
                    failures.push((identity, error));
                    continue;
                }
            };
            if !selection.allows(&declaration.id) {
                declaration.discard().await;
                continue;
            }
            let id = declaration.id.clone();
            match packages
                .iter()
                .position(|existing| existing.plugin.target == declaration.plugin.target)
            {
                Some(position) => {
                    let previous = std::mem::replace(&mut packages[position], declaration);
                    enabled.remove(&previous.id);
                    previous.discard().await;
                }
                None => packages.push(declaration),
            }
            enabled.insert(id);
        }
        let mut plugins = Vec::new();
        let mut pending = BTreeMap::new();
        for declaration in packages {
            if !enabled.contains(&declaration.id) {
                declaration.discard().await;
                continue;
            }
            let mut plugin = declaration.plugin.clone();
            plugin.configuration.registration_order = offset + plugins.len() as u32;
            pending.insert(plugin.identity().to_owned(), declaration);
            plugins.push(plugin);
        }
        let settled = super::plugin::builtins_from_enabled(&builtins, &enabled);
        (plugins, pending, failures, settled, enabled)
    }

    pub async fn list(&self) -> Vec<String> {
        self.state
            .lock()
            .await
            .active
            .iter()
            .map(|entry| entry.0.identity().to_owned())
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

    pub async fn package_language(
        &self,
        package: &str,
        model: &ycoding_schema::JsonValue,
        options: &ycoding_schema::JsonValue,
    ) -> Result<Arc<dyn ycoding_ai::route::LanguageAttempt>, ycoding_ai::Error> {
        let failure = |error: Error| super::supervisor::language_error(error.into());
        let runtime = self.plugins.as_ref().ok_or_else(|| failure(Error::Spawn))?;
        let mut state = self.state.lock().await;
        if state.closed {
            return Err(failure(Error::Stopped));
        }
        if state.builtins.is_disabled("ycoding.provider.dynamic") {
            return Err(failure(Error::Rejected));
        }
        let extension = match state.packages.get(package) {
            Some(extension) => extension.clone(),
            None => {
                let extension = Arc::new(
                    Extension::start_plugin(
                        Plugin {
                            configuration: Configuration {
                                identity: format!("model.{}", super::plugin::identity(package)),
                                executable: runtime.executable.clone(),
                                args: runtime.args.clone(),
                                directory: self.directory.clone(),
                                grants: vec![],
                                families: vec![],
                                registration_order: 0,
                            },
                            target: package.into(),
                            options: ycoding_schema::JsonValue::Object(Default::default()),
                            cache: runtime.cache.clone(),
                            setup: runtime.setup,
                            model_package: true,
                            selection: Default::default(),
                        },
                        self.options.clone(),
                        &self.registry,
                        self.policy.clone(),
                        &self.launch,
                        self.host.clone(),
                    )
                    .await
                    .map_err(failure)?
                    .ok_or_else(|| failure(Error::Negotiation))?,
                );
                state.packages.insert(package.into(), extension.clone());
                extension
            }
        };
        super::language::claim(&[extension], package, model, options)
            .await?
            .ok_or_else(|| failure(Error::Rejected))
    }

    pub async fn declared_plugins(&self) -> Vec<plugin::Info> {
        self.parent_extensions()
            .into_iter()
            .filter_map(|extension| extension.declared_id().cloned())
            .chain(
                self.state
                    .lock()
                    .await
                    .active
                    .iter()
                    .filter(|entry| matches!(entry.0, Spec::Plugin(_)))
                    .filter_map(|entry| entry.1.declared_id().cloned())
                    .collect::<Vec<_>>(),
            )
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
        for extension in std::mem::take(&mut state.packages).into_values() {
            extension.shutdown().await;
        }
        while let Some(entry) = state.active.last() {
            entry.1.shutdown().await;
            state.active.pop();
        }
        drop(state);
        for extension in self.parent_extensions().into_iter().rev() {
            extension.shutdown().await;
        }
    }

    async fn load(
        &self,
        configuration: Spec,
        pending: &mut BTreeMap<String, Declaration>,
    ) -> Result<Option<Arc<Extension>>, Error> {
        let id = configuration.identity().to_owned();
        let started = match configuration {
            Spec::Process(configuration) => Extension::start(
                configuration,
                self.options.clone(),
                &self.registry,
                self.policy.clone(),
                &self.launch,
                self.host.clone(),
            )
            .await
            .map(Some),
            Spec::Plugin(plugin) => match pending.remove(plugin.identity()) {
                Some(declaration) => declaration
                    .setup(
                        plugin.configuration.registration_order,
                        &self.registry,
                        &self.launch,
                    )
                    .await
                    .map(Some),
                None => {
                    Extension::start_plugin(
                        plugin,
                        self.options.clone(),
                        &self.registry,
                        self.policy.clone(),
                        &self.launch,
                        self.host.clone(),
                    )
                    .await
                }
            },
        };
        match started {
            Ok(Some(extension)) => {
                if self
                    .event_source
                    .emit(Data::PluginAdded(Box::new(plugin::AddedData {
                        id: id.into(),
                    })))
                    .is_err()
                {
                    eprintln!("Plugin added event publication failed");
                }
                Ok(Some(Arc::new(extension)))
            }
            Ok(None) => Ok(None),
            Err(error) => {
                tracing::error!(identity = id, %error, "process extension activation failed");
                Err(error)
            }
        }
    }
}
