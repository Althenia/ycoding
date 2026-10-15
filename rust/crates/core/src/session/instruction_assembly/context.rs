use crate::{
    instructions::{self, Error, Observation, Source},
    resources::{config, mcp, skill},
    tools::{policy, registry::Registry},
};
use std::sync::{Arc, Weak};
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, agent, instruction, permission};

#[derive(Clone)]
pub struct Context {
    pub configuration: Arc<config::Configuration>,
    pub registry: Arc<Registry>,
    pub skills: Arc<tokio::sync::Mutex<skill::Service>>,
    pub mcp: Weak<mcp::Service>,
}

impl Context {
    pub async fn sources(
        &self,
        mut sources: Vec<Source>,
        agent: &agent::Info,
        ceiling: &[permission::Rule],
    ) -> Result<Vec<Source>, Error> {
        let permissions = super::tool_permissions(agent, ceiling);
        let available = self.registry.available(&permissions);
        let mcp = self.mcp.upgrade().ok_or(Error::ReaderFailed)?;
        let mut skills = Vec::new();
        if available.contains("skill") {
            let mut service = self.skills.lock().await;
            let local = service.list().await.map_err(|_| Error::ReaderFailed)?;
            skills = skill::instructions::summaries_by(
                &local
                    .iter()
                    .filter(|info| permitted(&info.id, &permissions))
                    .collect::<Vec<_>>(),
                |a, b| a.cmp(b),
            );
            let entries = service.mcp(mcp.skill_catalog().await.map_err(|_| Error::ReaderFailed)?);
            skills.extend(entries.into_iter().filter_map(|entry| {
                let id = mcp::skills::id(&entry.server, &entry.uri).into();
                permitted(&id, &permissions).then_some(skill::instructions::Summary {
                    id,
                    name: entry.frontmatter.name,
                    description: entry.frontmatter.description,
                    server: Some(entry.server),
                })
            }));
            skills.sort_by(|a, b| a.id.cmp(&b.id));
        }
        sources.push(catalog_source(
            skill::instructions::KEY,
            (!skills.is_empty()).then(|| skill::instructions::render(&skills)),
            skill::instructions::REMOVED,
        ));
        let servers = mcp.instructions().await.map_err(|_| Error::ReaderFailed)?;
        let tools = mcp
            .tools()
            .await
            .map_err(|_| Error::ReaderFailed)?
            .into_iter()
            .filter_map(|tool| {
                tool.definition
                    .get("name")
                    .and_then(|name| name.as_str())
                    .map(|name| (tool.server.as_str().into(), name.into()))
            })
            .collect::<Vec<_>>();
        let servers = mcp::instructions::summaries_with_capabilities_by(
            &servers,
            &tools,
            Some(&permissions),
            &self.configuration.capabilities,
            |a, b| a.cmp(b),
        );
        sources.push(catalog_source(
            mcp::instructions::KEY,
            (!servers.is_empty()).then(|| mcp::instructions::render(&servers)),
            mcp::instructions::REMOVED,
        ));
        let sources = instructions::combine(vec![sources])?;
        Ok(super::select_sources(
            &sources,
            agent,
            ceiling,
            &self.configuration,
            &self.registry,
        ))
    }
}

fn permitted(id: &LosslessString, permissions: &[permission::Rule]) -> bool {
    policy::evaluate(&"skill".into(), id, permissions)
        .effect
        .0
        .as_str()
        != Some("deny")
}

fn catalog_source(key: &str, text: Option<LosslessString>, removed: &'static str) -> Source {
    Source {
        key: instruction::Key::decode(&JsonValue::String(key.into()))
            .expect("catalog instruction key"),
        read: Arc::new(move || {
            let text = text.clone();
            Box::pin(async move {
                Ok(text.map_or(Observation::Removed, |text| {
                    Observation::Value(JsonValue::String(text))
                }))
            })
        }),
        initial: Arc::new(|value| {
            if let JsonValue::String(text) = value {
                Some(text.clone())
            } else {
                None
            }
        }),
        changed: Arc::new(|_, value| {
            if let JsonValue::String(text) = value {
                Some(instructions::join(
                    &[
                        "This catalog supersedes its previously loaded instructions.".into(),
                        text.clone(),
                    ],
                    "\n",
                ))
            } else {
                None
            }
        }),
        removed: Some(Arc::new(move |_| Some(removed.into()))),
    }
}
