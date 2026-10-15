use super::{Factory, Prepared, unavailable};
use crate::dispatch::Failure;
use std::sync::{
    Arc, Mutex, PoisonError,
    atomic::{AtomicUsize, Ordering},
};
use ycoding_core::{
    resources::{auth, mcp},
    ycoding_schema::location,
};

pub(super) struct Owner {
    pub mcp: Arc<mcp::Service>,
    pub integrations: auth::integration::Registry,
    pub generations: AtomicUsize,
    registration: Mutex<auth::integration::Registration>,
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
        for (name, _) in &previous.servers {
            if !current.servers.iter().any(|(current, _)| current == name) {
                self.mcp
                    .remove(
                        name.as_str()
                            .ok_or_else(|| unavailable("MCP server name"))?,
                    )
                    .await
                    .map_err(|_| unavailable("MCP server removal"))?;
            }
        }
        for (name, configuration) in current.servers {
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
                    configuration,
                )
                .await
                .map_err(|_| unavailable("MCP server reload"))?;
        }
        Ok(())
    }

    pub fn configure(&self, factory: &Factory, prepared: &Prepared) -> Result<(), Failure> {
        let mut auth = factory.globals.auth.clone();
        auth.register_endpoints(&prepared.models.catalog());
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
    pub async fn retire(&self) -> Result<(), Failure> {
        if self.generations.fetch_sub(1, Ordering::AcqRel) != 1 {
            return Ok(());
        }
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
        mcp.and(integrations)
    }
}

impl Factory {
    pub(super) async fn start_mcp(
        &self,
        services: &crate::locations::ServiceSet,
        prepared: &Prepared,
        directory: &std::path::Path,
    ) -> Result<Arc<Owner>, Failure> {
        let integrations = auth::integration::Registry::prepared(
            self.credentials.clone(),
            self.options.env.clone(),
            self.globals.preparation.clone(),
            Some(self.globals.claude.clone()),
        );
        let reference = location::Ref {
            directory: services.info.directory.clone(),
            workspace_id: services.info.workspace_id.clone(),
        };
        integrations
            .bind_events(self.events.clone(), Some(reference.clone()))
            .map_err(|_| unavailable("integration events"))?;
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
        mcp.bind_events(self.events.clone(), Some(reference))
            .map_err(|_| unavailable("MCP events"))?;
        Ok(Arc::new(Owner {
            mcp,
            integrations,
            generations: AtomicUsize::new(0),
            registration: Mutex::new(registration),
        }))
    }
}
