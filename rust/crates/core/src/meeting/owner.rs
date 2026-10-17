use super::BoxFuture;
use super::config::{AnalysisModel, KnowledgeBinding};
use super::intelligence::{Mcp, McpTool};
use super::runtime::MeetingRuntime;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::sync::Arc;

const MAX_REPLY: usize = 1_048_576;
const MAX_NAME: usize = 200;
const MAX_BINDINGS: usize = 4;
const REVISION_FIELDS: [&str; 3] = ["id", "content", "expectedRevision"];

#[derive(Clone, Debug, PartialEq)]
pub struct CatalogModel {
    pub provider_id: String,
    pub id: String,
    pub name: String,
    pub enabled: Option<bool>,
    pub status: Option<String>,
    pub variants: Vec<String>,
    pub profiles: Vec<String>,
}

pub type Catalog =
    Arc<dyn Fn() -> BoxFuture<'static, Result<Vec<CatalogModel>, String>> + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
pub struct Knowledge {
    pub mcp_enabled: bool,
    pub bindings: Vec<KnowledgeBinding>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Update {
    pub ask_model: Option<AnalysisModel>,
    pub knowledge: Option<Knowledge>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Saved(Value),
    SelectionUnavailable,
}

pub struct OwnerSettings {
    runtime: Arc<MeetingRuntime>,
    catalog: Catalog,
    mcp: Option<Arc<dyn Mcp>>,
}

struct Server {
    name: String,
    status: Option<String>,
    tools: Vec<String>,
}

struct Inventory {
    models: Vec<CatalogModel>,
    servers: Vec<Server>,
    tools: Vec<McpTool>,
}

impl OwnerSettings {
    pub fn new(runtime: Arc<MeetingRuntime>, catalog: Catalog, mcp: Option<Arc<dyn Mcp>>) -> Self {
        Self {
            runtime,
            catalog,
            mcp,
        }
    }

    pub async fn read(&self) -> Result<Value, String> {
        let inventory = self.inventory().await?;
        let config = self.runtime.config();
        let payload = json!({
            "askModel": config.analysis.ask_model.to_value(),
            "analysisModel": config.analysis.model.to_value(),
            "models": inventory.models.iter().map(model_value).collect::<Vec<_>>(),
            "servers": inventory.servers.iter().map(|server| {
                let mut value = json!({ "name": server.name, "tools": server.tools });
                if let Some(status) = &server.status {
                    value["status"] = json!(status);
                }
                value
            }).collect::<Vec<_>>(),
            "knowledge": {
                "mcpEnabled": config.knowledge.mcp_enabled,
                "autoApply": false,
                "requireApproval": true,
                "bindings": config.knowledge.bindings.iter().map(|binding| {
                    let mut value = binding.to_value();
                    if let Some(write) = &binding.write {
                        value["writeCapability"] =
                            json!(write_capability(&inventory.tools, &binding.server, write));
                    }
                    value
                }).collect::<Vec<_>>(),
            },
        });
        if payload.to_string().len() > MAX_REPLY {
            return Err("Owner settings inventory exceeds the 1 MiB reply bound".into());
        }
        Ok(payload)
    }

    pub async fn update(&self, update: Update) -> Result<Outcome, String> {
        let inventory = self.inventory().await?;
        if !available(&inventory, &update) {
            return Ok(Outcome::SelectionUnavailable);
        }
        self.runtime
            .update_owner_settings(&update)
            .await
            .map_err(|error| error.0)?;
        self.read().await.map(Outcome::Saved)
    }

    async fn inventory(&self) -> Result<Inventory, String> {
        let models = (self.catalog)().await?;
        let (reported, tools) = match &self.mcp {
            Some(mcp) => {
                let tools = mcp.tools().await?;
                (mcp.servers().await?, tools)
            }
            None => (Vec::new(), Vec::new()),
        };
        let mut names: Vec<String> = Vec::new();
        for name in reported
            .iter()
            .map(|server| &server.name)
            .chain(tools.iter().map(|tool| &tool.server))
        {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
        let servers = names
            .into_iter()
            .map(|name| {
                let mut server_tools: Vec<String> = Vec::new();
                for tool in tools.iter().filter(|tool| tool.server == name) {
                    if !server_tools.contains(&tool.name) {
                        server_tools.push(tool.name.clone());
                    }
                }
                Server {
                    status: reported
                        .iter()
                        .find(|server| server.name == name)
                        .and_then(|server| server.status.clone()),
                    name,
                    tools: server_tools,
                }
            })
            .collect();
        Ok(Inventory {
            models,
            servers,
            tools,
        })
    }
}

pub fn parse_update(value: &Value) -> Option<Update> {
    let map = value.as_object()?;
    if map.is_empty() || !keys_within(map, &["askModel", "knowledge"]) {
        return None;
    }
    let ask_model = match map.get("askModel") {
        None => None,
        Some(Value::String(literal)) if literal == "inherit" => Some(AnalysisModel::Inherit),
        Some(Value::Object(model))
            if keys_within(model, &["providerID", "id", "variant", "profile"]) =>
        {
            Some(AnalysisModel::Explicit {
                provider_id: name(model.get("providerID")?)?,
                id: name(model.get("id")?)?,
                variant: optional_name(model, "variant")?,
                profile: optional_name(model, "profile")?,
            })
        }
        Some(_) => return None,
    };
    let knowledge = match map.get("knowledge") {
        None => None,
        Some(Value::Object(knowledge))
            if knowledge.len() == 2 && keys_within(knowledge, &["mcpEnabled", "bindings"]) =>
        {
            let bindings = knowledge
                .get("bindings")?
                .as_array()
                .filter(|bindings| bindings.len() <= MAX_BINDINGS)?;
            Some(Knowledge {
                mcp_enabled: knowledge.get("mcpEnabled")?.as_bool()?,
                bindings: bindings.iter().map(binding).collect::<Option<Vec<_>>>()?,
            })
        }
        Some(_) => return None,
    };
    Some(Update {
        ask_model,
        knowledge,
    })
}

fn binding(value: &Value) -> Option<KnowledgeBinding> {
    let map = value.as_object()?;
    if !keys_within(map, &["server", "search", "read", "write", "enabled"]) {
        return None;
    }
    Some(KnowledgeBinding {
        server: name(map.get("server")?)?,
        search: name(map.get("search")?)?,
        read: name(map.get("read")?)?,
        write: optional_name(map, "write")?,
        enabled: match map.get("enabled") {
            None => true,
            Some(enabled) => enabled.as_bool()?,
        },
    })
}

fn name(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.is_empty() && text.encode_utf16().count() <= MAX_NAME)
        .map(str::to_owned)
}

fn optional_name(map: &Map<String, Value>, key: &str) -> Option<Option<String>> {
    match map.get(key) {
        None => Some(None),
        Some(value) => name(value).map(Some),
    }
}

fn keys_within(map: &Map<String, Value>, allowed: &[&str]) -> bool {
    map.keys().all(|key| allowed.contains(&key.as_str()))
}

fn model_value(model: &CatalogModel) -> Value {
    let mut value = json!({
        "providerID": model.provider_id,
        "id": model.id,
        "name": model.name,
        "variants": model.variants,
    });
    if let Some(enabled) = model.enabled {
        value["enabled"] = json!(enabled);
    }
    if let Some(status) = &model.status {
        value["status"] = json!(status);
    }
    if !model.profiles.is_empty() {
        value["profiles"] = json!(model.profiles);
    }
    value
}

fn available(inventory: &Inventory, update: &Update) -> bool {
    if let Some(AnalysisModel::Explicit {
        id,
        provider_id,
        variant,
        profile,
    }) = &update.ask_model
    {
        let Some(model) = inventory
            .models
            .iter()
            .find(|model| model.provider_id == *provider_id && model.id == *id)
        else {
            return false;
        };
        if model.enabled == Some(false)
            || model.status.as_deref() == Some("deprecated")
            || variant
                .as_ref()
                .is_some_and(|variant| !model.variants.contains(variant))
            || profile.as_ref().is_some_and(|profile| {
                !model.profiles.is_empty() && !model.profiles.contains(profile)
            })
        {
            return false;
        }
    }
    let Some(knowledge) = &update.knowledge else {
        return true;
    };
    let mut seen = HashSet::new();
    knowledge.bindings.iter().all(|binding| {
        if !seen.insert(binding.server.as_str()) {
            return false;
        }
        if !knowledge.mcp_enabled || !binding.enabled {
            return true;
        }
        let present = |name: &str| {
            inventory
                .tools
                .iter()
                .any(|tool| tool.server == binding.server && tool.name == name)
        };
        present(&binding.search)
            && present(&binding.read)
            && binding.write.as_deref().is_none_or(present)
    })
}

fn write_capability(tools: &[McpTool], server: &str, write: &str) -> &'static str {
    let Some(tool) = tools
        .iter()
        .find(|tool| tool.server == server && tool.name == write)
    else {
        return "unavailable";
    };
    let schema = tool.input_schema.as_ref().and_then(Value::as_object);
    let required = schema
        .and_then(|schema| schema.get("required"))
        .and_then(Value::as_array);
    let properties = schema
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object);
    let revision_aware = REVISION_FIELDS.iter().all(|field| {
        required.is_some_and(|required| required.iter().any(|item| item == field))
            && properties.is_some_and(|properties| properties.contains_key(*field))
    });
    if revision_aware {
        return "revision-aware";
    }
    "manual-only"
}
