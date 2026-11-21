use super::{Factory, Prepared, unavailable};
use crate::dispatch::Failure;
use std::sync::{Arc, Mutex, PoisonError, atomic::AtomicUsize};
use ycoding_core::resources::{auth, mcp};

pub(super) struct Owner {
    pub mcp: Arc<mcp::Service>,
    pub integrations: auth::integration::Registry,
    pub generations: AtomicUsize,
    registration: Mutex<auth::integration::Registration>,
    observer: tokio::sync::Mutex<Option<super::observer::Owner>>,
}

impl Owner {
    pub async fn reload(
        &self,
        previous: &ycoding_core::resources::config::Configuration,
        current: &ycoding_core::resources::config::Configuration,
    ) -> Result<(), Failure> {
        let definitions = |configuration: &ycoding_core::resources::config::Configuration| {
            mcp::configuration::from_entries(
                &configuration
                    .values("mcp")
                    .map(|value| ycoding_core::resources::config::Entry::Document {
                        path: None,
                        info: ycoding_core::ycoding_schema::ObjectEncoder::new()
                            .field("mcp", value)
                            .finish(),
                    })
                    .collect::<Vec<_>>(),
            )
            .map_err(|_| unavailable("MCP configuration"))
        };
        if previous.values("mcp").eq(current.values("mcp")) {
            return Ok(());
        }
        let previous = definitions(previous)?;
        let current = definitions(current)?;
        if let Err(error) = self.apply(&previous, &current, true).await {
            if self.apply(&current, &previous, false).await.is_err() {
                tracing::error!("MCP replacement rollback failed");
            }
            return Err(error);
        }
        Ok(())
    }

    async fn apply(
        &self,
        previous: &mcp::configuration::Definitions,
        current: &mcp::configuration::Definitions,
        check: bool,
    ) -> Result<(), Failure> {
        let mut changed = Vec::new();
        for (name, configuration) in &current.servers {
            if previous
                .servers
                .iter()
                .any(|previous| previous == &(name.clone(), configuration.clone()))
            {
                continue;
            }
            self.mcp
                .add(
                    name.as_str()
                        .ok_or_else(|| unavailable("MCP server name"))?,
                    configuration.clone(),
                )
                .await
                .map_err(|_| unavailable("MCP server reload"))?;
            changed.push(name);
        }
        self.mcp
            .tools()
            .await
            .map_err(|_| unavailable("MCP replacement readiness"))?;
        if check
            && self
                .mcp
                .servers()
                .map_err(|_| unavailable("MCP replacement status"))?
                .iter()
                .any(|server| {
                    changed
                        .iter()
                        .any(|name| name.as_str() == Some(server.name.as_str()))
                        && matches!(
                            server.status,
                            ycoding_core::ycoding_schema::mcp::Status::Failed(_)
                        )
                })
        {
            return Err(unavailable("MCP replacement startup"));
        }
        let existing = self
            .mcp
            .servers()
            .map_err(|_| unavailable("MCP server inventory"))?;
        for (name, _) in &previous.servers {
            if !current.servers.iter().any(|(current, _)| current == name)
                && existing
                    .iter()
                    .any(|server| name.as_str() == Some(server.name.as_str()))
            {
                self.mcp
                    .remove(
                        name.as_str()
                            .ok_or_else(|| unavailable("MCP server name"))?,
                    )
                    .await
                    .map_err(|_| unavailable("MCP server removal"))?;
            }
        }
        Ok(())
    }

    pub fn configure(
        &self,
        factory: &Factory,
        models: &ycoding_core::resources::model::Resolver,
    ) -> Result<(), Failure> {
        let mut auth = factory.globals.auth.clone();
        auth.register_endpoints(&models.catalog());
        let registration = self
            .integrations
            .transform(move |draft| draft.extend(&auth))
            .map_err(|_| unavailable("native integrations"))?;
        *self
            .registration
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = registration;
        Ok(())
    }
    pub async fn close(&self) -> Result<(), Failure> {
        let observer = self.stop_observer().await;
        let mcp = self
            .mcp
            .shutdown()
            .await
            .map_err(|_| unavailable("MCP shutdown"));
        let integrations = self
            .integrations
            .shutdown()
            .await
            .map_err(|_| unavailable("integration shutdown"));
        observer.and(mcp).and(integrations)
    }

    pub async fn stop_observer(&self) -> Result<(), Failure> {
        match self.observer.lock().await.take() {
            Some(observer) => observer.close().await,
            None => Ok(()),
        }
    }

    pub async fn observe(
        &self,
        factory: &Factory,
        services: &crate::locations::ServiceSet,
        configuration: &ycoding_core::resources::config::Configuration,
        directory: &std::path::Path,
    ) -> Result<(), Failure> {
        let mut observer = self.observer.lock().await;
        if observer.is_none() {
            *observer = super::observer::Owner::start(factory, services, configuration, directory)?;
        }
        Ok(())
    }
}

impl Factory {
    pub(super) async fn start_mcp(
        &self,
        prepared: &Prepared,
        directory: &std::path::Path,
    ) -> Result<Arc<Owner>, Failure> {
        let integrations = auth::integration::Registry::prepared(
            self.credentials.clone(),
            self.options.env.clone(),
            self.globals.preparation.clone(),
            Some(self.globals.claude.clone()),
        );
        let mut auth = self.globals.auth.clone();
        auth.register_endpoints(&prepared.models.catalog());
        let registration = integrations
            .transform(move |draft| draft.extend(&auth))
            .map_err(|_| unavailable("native integrations"))?;
        self.globals
            .wellknown
            .attach(&integrations)
            .await
            .map_err(|_| unavailable("wellknown integrations"))?;
        let mcp = Arc::new(
            mcp::Service::new(
                &prepared.disk.entries,
                directory.into(),
                env!("CARGO_PKG_VERSION").into(),
                self.options.env.clone(),
                mcp::client::Hooks {
                    credentials: Some(self.credentials.clone()),
                    integrations: Some(integrations.clone()),
                    ..Default::default()
                },
            )
            .map_err(|_| unavailable("MCP service"))?,
        );
        Ok(Arc::new(Owner {
            mcp,
            integrations,
            generations: AtomicUsize::new(0),
            registration: Mutex::new(registration),
            observer: tokio::sync::Mutex::new(None),
        }))
    }
}
