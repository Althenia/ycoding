use super::{
    context::Context,
    materialization::{Hooks, Materialization},
};
use crate::resources::{config::Configuration, image, tool_output_store::Store};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{JsonValue, LosslessString, permission, session_error};

pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<ToolOutput, Failure>> + Send + 'a>>;
pub type Handler = dyn Fn(JsonValue, Context) -> ToolFuture<'static> + Send + Sync;
pub type Conversion = dyn Fn(JsonValue) -> Result<JsonValue, String> + Send + Sync;
pub type Projection = dyn Fn(&JsonValue, &JsonValue) -> Result<ToolOutput, String> + Send + Sync;

#[derive(Clone, Debug, PartialEq)]
pub enum Failure {
    Tool {
        message: String,
        error: Option<session_error::Error>,
    },
    Cancelled,
    Defect(String),
}

impl Failure {
    pub fn message(message: impl Into<String>) -> Self {
        Self::Tool {
            message: message.into(),
            error: None,
        }
    }
}

pub trait Tool: Send + Sync {
    fn definition(&self, name: &str) -> ToolDefinition;
    fn permission(&self) -> Option<&str>;
    fn validate_output(&self, _output: &ToolOutput) -> Result<(), Failure> {
        Ok(())
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_>;
}

pub struct DynamicTool {
    description: String,
    input_schema: JsonValue,
    output_schema: Option<JsonValue>,
    permission: Option<String>,
    handler: Arc<Handler>,
}

impl DynamicTool {
    pub fn new(
        description: impl Into<String>,
        input_schema: JsonValue,
        output_schema: Option<JsonValue>,
        permission: Option<String>,
        handler: impl Fn(JsonValue, Context) -> ToolFuture<'static> + Send + Sync + 'static,
    ) -> Self {
        Self {
            description: description.into(),
            input_schema,
            output_schema,
            permission,
            handler: Arc::new(handler),
        }
    }
}

impl Tool for DynamicTool {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: self.description.clone().into(),
            input_schema: self.input_schema.clone(),
            output_schema: self.output_schema.clone(),
            cache: None,
            metadata: None,
            native: None,
        }
    }
    fn permission(&self) -> Option<&str> {
        self.permission.as_deref()
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        (self.handler)(input, context)
    }
}

pub struct Codec {
    pub schema: JsonValue,
    pub decode: Arc<Conversion>,
    pub encode: Arc<Conversion>,
}

pub struct TypedTool {
    pub description: String,
    pub input: Codec,
    pub output: Codec,
    pub structured: Option<Codec>,
    pub permission: Option<String>,
    pub handler: Arc<dyn Fn(JsonValue, Context) -> ValueFuture + Send + Sync>,
    pub projection: Option<Arc<Projection>>,
}

pub type ValueFuture = Pin<Box<dyn Future<Output = Result<JsonValue, Failure>> + Send>>;

impl Tool for TypedTool {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: self.description.clone().into(),
            input_schema: self.input.schema.clone(),
            output_schema: Some(
                self.structured
                    .as_ref()
                    .map(|codec| &codec.schema)
                    .unwrap_or(&self.output.schema)
                    .clone(),
            ),
            cache: None,
            metadata: None,
            native: None,
        }
    }
    fn permission(&self) -> Option<&str> {
        self.permission.as_deref()
    }
    fn validate_output(&self, output: &ToolOutput) -> Result<(), Failure> {
        let codec = self.structured.as_ref().unwrap_or(&self.output);
        let decoded = (codec.decode)(output.structured.clone()).map_err(|error| {
            Failure::message(format!(
                "Tool returned an invalid value for its output schema: {error}"
            ))
        })?;
        (codec.encode)(decoded).map_err(|error| {
            Failure::message(format!(
                "Tool returned an invalid value for its output schema: {error}"
            ))
        })?;
        Ok(())
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = (self.input.decode)(input)
                .map_err(|error| Failure::message(format!("Invalid tool input: {error}")))?;
            let output = (self.handler)(input.clone(), context).await?;
            let output = (self.output.encode)(output).map_err(|error| {
                Failure::message(format!(
                    "Tool returned an invalid value for its output schema: {error}"
                ))
            })?;
            if let Some(projection) = &self.projection {
                let mut projected = projection(&input, &output).map_err(|error| {
                    Failure::message(format!(
                        "Tool returned an invalid value for its output schema: {error}"
                    ))
                })?;
                if let Some(structured) = &self.structured {
                    projected.structured =
                        (structured.encode)(projected.structured).map_err(|error| {
                            Failure::message(format!(
                                "Tool returned an invalid value for its output schema: {error}"
                            ))
                        })?;
                }
                return Ok(projected);
            }
            let content = match &output {
                JsonValue::String(text) => vec![ycoding_schema::llm::ToolContent::Text(
                    ycoding_schema::llm::ToolTextContent { text: text.clone() },
                )],
                _ => vec![],
            };
            Ok(ToolOutput {
                structured: output,
                content,
            })
        })
    }
}

#[derive(Clone, Debug)]
pub struct Options {
    pub namespace: Option<String>,
    pub codemode: bool,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            namespace: None,
            codemode: true,
        }
    }
}
impl Options {
    pub fn direct() -> Self {
        Self {
            namespace: None,
            codemode: false,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct RegistrationError {
    pub name: String,
    pub message: String,
}

#[derive(Clone)]
pub struct Entry {
    pub tool: Arc<dyn Tool>,
    pub name: String,
    pub namespace: Option<String>,
    pub codemode: bool,
    pub direct: bool,
}
pub struct ProcessRegistration {
    pub name: String,
    pub tool: Arc<dyn Tool>,
    pub namespace: String,
    pub direct: bool,
    pub code_mode: bool,
}
type ToolEntries = Vec<(String, Arc<dyn Tool>)>;
type Registrations = Vec<(ToolEntries, Options)>;
type Entries = BTreeMap<String, Vec<(u64, Entry)>>;

pub struct Registry {
    local: Arc<Mutex<(u64, Entries)>>,
    pub hooks: Arc<Hooks>,
    resources: Arc<Store>,
    configuration: Option<Arc<Configuration>>,
    image_limits: image::Limits,
    collator: Arc<super::code_mode::Collation>,
}

impl Registry {
    pub fn new(
        resources: Arc<Store>,
        configuration: Option<Arc<Configuration>>,
        image_limits: image::Limits,
        collator: Arc<super::code_mode::Collation>,
    ) -> Self {
        Self {
            local: Arc::new(Mutex::new((0, BTreeMap::new()))),
            hooks: Arc::new(Hooks::default()),
            resources,
            configuration,
            image_limits,
            collator,
        }
    }
    pub fn register(
        &self,
        tools: Vec<(String, Arc<dyn Tool>)>,
        options: Options,
    ) -> Result<Registration, RegistrationError> {
        self.register_batch(vec![(tools, options)])
    }
    pub fn register_batch(
        &self,
        registrations: Registrations,
    ) -> Result<Registration, RegistrationError> {
        self.install(
            registrations
                .into_iter()
                .map(|(tools, options)| {
                    let direct = !options.codemode;
                    (tools, options, direct)
                })
                .collect(),
        )
    }
    pub fn register_process_batch(
        &self,
        registrations: Vec<ProcessRegistration>,
    ) -> Result<Registration, RegistrationError> {
        self.install(
            registrations
                .into_iter()
                .map(|registration| {
                    (
                        vec![(registration.name, registration.tool)],
                        Options {
                            namespace: Some(registration.namespace),
                            codemode: registration.code_mode,
                        },
                        registration.direct,
                    )
                })
                .collect(),
        )
    }
    fn install(
        &self,
        registrations: Vec<(ToolEntries, Options, bool)>,
    ) -> Result<Registration, RegistrationError> {
        let mut planned = Vec::new();
        for (tools, options, direct) in registrations {
            if let Some(namespace) = &options.namespace {
                validate_namespace(namespace)?;
            }
            for (name, tool) in tools {
                let name = normalize_name(&name);
                let key = options.namespace.as_ref().map_or_else(
                    || name.clone(),
                    |namespace| format!("{}_{}", namespace.replace('.', "_"), name),
                );
                if direct && key == "execute" {
                    return Err(RegistrationError {
                        name: key,
                        message: "Tool name \"execute\" is reserved for CodeMode".into(),
                    });
                }
                planned.push((
                    key,
                    Entry {
                        tool,
                        name,
                        namespace: options.namespace.clone(),
                        codemode: options.codemode,
                        direct,
                    },
                ));
            }
        }
        let mut local = self.local.lock().unwrap_or_else(|error| error.into_inner());
        local.0 += 1;
        let token = local.0;
        for (key, entry) in planned {
            local.1.entry(key).or_default().push((token, entry));
        }
        Ok(Registration {
            local: Arc::downgrade(&self.local),
            token,
        })
    }
    pub fn materialize(&self, permissions: &[permission::Rule]) -> Materialization {
        let local = self.local.lock().unwrap_or_else(|error| error.into_inner());
        let mut direct = BTreeMap::new();
        let mut codemode = BTreeMap::new();
        for (name, entries) in &local.1 {
            let Some((_, entry)) = entries.last() else {
                continue;
            };
            if wholly_disabled(entry.tool.permission().unwrap_or(name), permissions) {
                continue;
            }
            if entry.codemode {
                codemode.insert(name.clone(), entry.clone());
            }
            if entry.direct {
                direct.insert(name.clone(), entry.clone());
            }
        }
        if !codemode.is_empty() && !wholly_disabled("execute", permissions) {
            direct.insert(
                "execute".into(),
                Entry {
                    tool: Arc::new(super::builtin::execute::Execute::new(
                        codemode,
                        self.collator.clone(),
                    )),
                    name: "execute".into(),
                    namespace: None,
                    codemode: false,
                    direct: true,
                },
            );
        }
        let mut definitions = direct
            .iter()
            .filter(|(name, _)| name.as_str() != "execute")
            .map(|(name, entry)| entry.tool.definition(name))
            .collect::<Vec<_>>();
        if let Some(entry) = direct.get("execute") {
            definitions.push(entry.tool.definition("execute"));
        }
        Materialization {
            definitions,
            direct,
            hooks: self.hooks.clone(),
            resources: self.resources.clone(),
            configuration: self.configuration.clone(),
            image_limits: self.image_limits,
        }
    }
}

pub struct Registration {
    local: Weak<Mutex<(u64, Entries)>>,
    token: u64,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(local) = self.local.upgrade() {
            local
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .1
                .retain(|_, entries| {
                    entries.retain(|(token, _)| *token != self.token);
                    !entries.is_empty()
                });
        }
    }
}

pub fn normalize_name(name: &str) -> String {
    name.encode_utf16()
        .map(|unit| match unit {
            45 | 95 | 48..=57 | 65..=90 | 97..=122 => char::from_u32(u32::from(unit)).unwrap(),
            _ => '_',
        })
        .collect()
}
pub fn validate_namespace(namespace: &str) -> Result<(), RegistrationError> {
    if namespace.split('.').all(|segment| {
        !segment.is_empty()
            && segment.len() <= 64
            && segment.as_bytes()[0].is_ascii_alphabetic()
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    }) {
        return Ok(());
    }
    Err(RegistrationError {
        name: namespace.into(),
        message: format!(
            "Invalid tool namespace: {}",
            ycoding_schema::stringify_json(&JsonValue::String(namespace.into()))
        ),
    })
}
pub fn wholly_disabled(action: &str, rules: &[permission::Rule]) -> bool {
    rules
        .iter()
        .rev()
        .find(|rule| super::policy::wildcard(&LosslessString::from(action), &rule.action))
        .is_some_and(|rule| {
            rule.resource.as_str() == Some("*") && rule.effect.0.as_str() == Some("deny")
        })
}
