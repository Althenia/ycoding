use crate::{
    instructions::{self, Error, Observation, Source},
    resources::{config, mcp, reference, skill},
    tools::{policy, registry::Registry},
};
use std::sync::{Arc, Weak};
use ycoding_schema::{
    DomainDecode, JsonPath, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, agent,
    instruction, permission,
};

#[derive(Clone)]
pub struct Context {
    pub configuration: Arc<config::Configuration>,
    pub registry: Arc<Registry>,
    pub skills: Arc<tokio::sync::Mutex<skill::Service>>,
    pub mcp: Weak<mcp::Service>,
    pub references: Arc<reference::Service>,
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
        let permissions = policy::expand_permissions(
            &permissions,
            &self
                .configuration
                .roots()
                .home
                .to_string_lossy()
                .as_ref()
                .into(),
        );
        let references = self
            .references
            .list()
            .iter()
            .filter(|reference| {
                reference.hidden != Some(true)
                    && ["read", "glob", "grep", "shell"]
                        .iter()
                        .any(|tool| available.contains(*tool))
                    && ["read", "external_directory"].iter().all(|action| {
                        policy::evaluate(
                            &(*action).into(),
                            reference.path.as_lossless(),
                            &permissions,
                        )
                        .effect
                        .0
                        .as_str()
                            != Some("deny")
                            && policy::evaluate(
                                &(*action).into(),
                                &instructions::join(
                                    &[reference.path.as_lossless().clone(), "/*".into()],
                                    "",
                                ),
                                &permissions,
                            )
                            .effect
                            .0
                            .as_str()
                                != Some("deny")
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        sources.push(reference_source(reference::instructions::summaries_by(
            &references,
            |a, b| a.cmp(b),
        )));
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

fn reference_source(references: Vec<reference::instructions::Summary>) -> Source {
    let value = (!references.is_empty()).then(|| {
        JsonValue::Array(
            references
                .iter()
                .map(|reference| {
                    ObjectEncoder::new()
                        .field("name", &reference.name)
                        .field("path", &reference.path)
                        .optional("description", &reference.description)
                        .finish()
                })
                .collect(),
        )
    });
    Source {
        key: instruction::Key::decode(&JsonValue::String(reference::instructions::KEY.into()))
            .expect("reference instruction key"),
        read: Arc::new(move || {
            let value = value.clone();
            Box::pin(async move { Ok(value.map_or(Observation::Removed, Observation::Value)) })
        }),
        initial: Arc::new(|value| {
            Some(reference::instructions::render(&reference_summaries(
                value,
            )?))
        }),
        changed: Arc::new(|previous, current| {
            Some(reference::instructions::changed(
                &reference_summaries(previous)?,
                &reference_summaries(current)?,
            ))
        }),
        removed: Some(Arc::new(|_| Some(reference::instructions::REMOVED.into()))),
    }
}

fn reference_summaries(value: &JsonValue) -> Option<Vec<reference::instructions::Summary>> {
    let JsonValue::Array(values) = value else {
        return None;
    };
    values
        .iter()
        .map(|value| {
            let path = JsonPath::default();
            let object = ObjectDecoder::new(value, &path).ok()?;
            Some(reference::instructions::Summary {
                name: object.field("name").ok()?,
                path: object.field("path").ok()?,
                description: object.optional("description").ok()?,
            })
        })
        .collect()
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
