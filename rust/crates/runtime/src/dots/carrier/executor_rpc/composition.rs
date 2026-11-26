use super::{
    core_adapter::{environment_info, failure, session_backend},
    error::HandlerError,
    policy_bridge::RuntimeNetworkPolicy,
    scope_services::RuntimeScopeServices,
    service::{SessionFactory, serve},
    types::EnvironmentInfo,
};
use crate::{dots::carrier::supervisor::Serve, locations::Locations};
use std::{path::PathBuf, sync::Arc, time::Duration};
use ycoding_core::{
    cca::{
        error::ExecutorError,
        executor::{AnswerProcess, Executor, ExecutorOptions, PreparedExecutor, ScopeProvider},
    },
    dots::native::{
        Host,
        executor_authorization::ReviewDirectories,
        executor_scope::{LibraryProvider, executor_scopes},
    },
    platform::git,
    session::store::Service as SessionStore,
};

#[cfg(test)]
mod tests;

pub struct Composition {
    pub host: Host,
    pub locations: Locations,
    pub sessions: SessionStore,
    pub git: Arc<git::Service>,
    pub environment_id: String,
    pub home: PathBuf,
    pub data: PathBuf,
    pub prepared: Arc<PreparedExecutor>,
    pub network_proxy_ca_directory: Option<PathBuf>,
    pub answer_process: Option<Arc<dyn AnswerProcess>>,
    pub library: Option<Arc<dyn LibraryProvider>>,
    pub review_directories: Option<ReviewDirectories>,
    pub authorization_timeout: Option<Duration>,
    pub codex_home_env: Option<String>,
    pub system_config_path: Option<PathBuf>,
}

pub struct Serving {
    pub serve: Serve,
    #[cfg(test)]
    advertised: EnvironmentInfo,
}

impl Composition {
    pub fn into_serving(self) -> Result<Serving, ExecutorError> {
        let (_advertised, factory) = self.into_session_factory()?;
        Ok(Serving {
            serve: serve(factory),
            #[cfg(test)]
            advertised: _advertised,
        })
    }

    fn into_session_factory(self) -> Result<(EnvironmentInfo, SessionFactory), ExecutorError> {
        let home = self
            .home
            .to_str()
            .ok_or_else(|| ExecutorError::new(-32602, "invalid executor scope configuration"))?
            .to_owned();
        let services = Arc::new(RuntimeScopeServices::new(
            self.locations,
            self.sessions,
            self.git,
            self.review_directories,
            self.authorization_timeout,
        ));
        let scope_provider: Arc<dyn ScopeProvider> = executor_scopes(
            self.host,
            services,
            self.library,
            self.environment_id,
            home,
            self.data.clone(),
        )?;
        let (home_directory, data_directory) = (self.home, self.data);
        let prepared = self.prepared;
        let environment = prepared.environment_overrides();
        let answer_process = self.answer_process;
        let (ca_directory, codex_home_env) = (self.network_proxy_ca_directory, self.codex_home_env);
        let system_config_path = self.system_config_path;
        let options = move || ExecutorOptions {
            scope_provider: scope_provider.clone(),
            answer_process: answer_process.clone(),
            base_env: Default::default(),
            session_id: None,
            process_timeout_ms: None,
            max_buffered_bytes_per_process: None,
            max_live_processes: None,
            network_proxy_ca_directory: ca_directory.clone(),
            network_proxy_upstream_trust: None,
            network_policy: Some(Arc::new(RuntimeNetworkPolicy)),
            environment: environment.clone(),
            home_directory: home_directory.clone(),
            data_directory: data_directory.clone(),
            codex_home_env: codex_home_env.clone(),
            system_config_path: system_config_path.clone(),
            system_requirements_path: None,
            managed_config_path: None,
        };
        let advertised = environment_info(prepared.environment_info());
        let options = Arc::new(options);
        let factory: SessionFactory = Arc::new(move || -> Result<_, HandlerError> {
            Ok(session_backend(
                Executor::new_prepared(options(), &prepared).map_err(failure)?,
            ))
        });
        Ok((advertised, factory))
    }
}
