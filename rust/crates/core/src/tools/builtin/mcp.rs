use crate::{
    job::{BlockInput, BlockResult, Jobs, StartInput, Status},
    process::guardrails::Reservation,
    resources::mcp::{
        self, Event, Service,
        client::{Content, Error as ClientError, ToolResult},
    },
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{
            DynamicTool, Failure, Options, Registration, RegistrationError, Registry, Tool,
        },
    },
};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio::{sync::broadcast::error::RecvError, task::JoinHandle};
use ycoding_ai::llm::ToolOutput;
use ycoding_schema::{
    JsonObject, JsonValue, LosslessString,
    llm::{ToolContent, ToolFileContent, ToolTextContent},
    parse_json, session,
};

const BACKGROUND_NOTE: &str = " Background mode (background=true) returns immediately, notifies you on completion, and must not be polled.";
const BACKGROUND_PROPERTY: &str = "Run in the background and return immediately. You will be notified when it completes. Do not poll its progress.";

#[derive(Clone, Debug, PartialEq)]
pub struct Notification {
    pub session_id: session::Id,
    pub description: String,
    pub state: &'static str,
    pub text: String,
}
pub type Notifier =
    Arc<dyn Fn(Notification) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct Background {
    pub jobs: Jobs,
    pub notifier: Notifier,
}

#[derive(Debug)]
pub enum Error {
    Service(ClientError),
    Registration(RegistrationError),
}

pub struct McpTools(JoinHandle<Result<(), Error>>);

impl McpTools {
    pub fn start(
        service: Arc<Service>,
        registry: Arc<Registry>,
        policy: Arc<LeafPolicy>,
        background: Option<Background>,
    ) -> Self {
        let mut events = service.subscribe();
        Self(tokio::spawn(async move {
            let mut current = None;
            reconcile(&service, &registry, &policy, &background, &mut current).await?;
            loop {
                match events.recv().await {
                    Ok(Event::ToolsChanged(_)) | Err(RecvError::Lagged(_)) => {
                        reconcile(&service, &registry, &policy, &background, &mut current).await?
                    }
                    Ok(_) => {}
                    Err(RecvError::Closed) => return Ok(()),
                }
            }
        }))
    }

    pub fn is_finished(&self) -> bool {
        self.0.is_finished()
    }

    pub async fn stop(mut self) -> Result<(), Error> {
        self.0.abort();
        match (&mut self.0).await {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => Ok(()),
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        }
    }
}

impl Drop for McpTools {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn reconcile(
    service: &Arc<Service>,
    registry: &Registry,
    policy: &Arc<LeafPolicy>,
    background: &Option<Background>,
    current: &mut Option<Registration>,
) -> Result<(), Error> {
    let mut groups = BTreeMap::<String, (Vec<(String, Arc<dyn Tool>)>, bool)>::new();
    for tool in service.tools().await.map_err(Error::Service)? {
        let Some(name) = tool.definition["name"].as_str() else {
            continue;
        };
        let call = Arc::new(Call {
            service: service.clone(),
            policy: policy.clone(),
            background: background.clone(),
            server: tool.server.clone(),
            tool: name.into(),
            action: action(&tool.server, name),
            backgroundable: mcp::backgroundable(name),
        });
        let group = groups
            .entry(tool.server.clone())
            .or_insert_with(|| (Vec::new(), tool.codemode != Some(false)));
        group.0.push((
            name.into(),
            Arc::new(DynamicTool::new(
                description(
                    &tool.definition,
                    call.backgroundable && background.is_some(),
                ),
                input_schema(
                    &tool.definition,
                    call.backgroundable && background.is_some(),
                ),
                tool.definition
                    .get("outputSchema")
                    .and_then(|schema| parse_json(&schema.to_string()).ok()),
                Some(call.action.clone()),
                move |input, context| {
                    let call = call.clone();
                    Box::pin(async move { call.run(input, context).await })
                },
            )),
        ));
    }
    let next = registry
        .register_batch(
            groups
                .into_iter()
                .map(|(server, (tools, codemode))| {
                    (
                        tools,
                        Options {
                            namespace: Some(crate::tools::registry::normalize_name(&server)),
                            codemode,
                        },
                    )
                })
                .collect(),
        )
        .map_err(Error::Registration)?;
    *current = Some(next);
    Ok(())
}

fn action(server: &str, tool: &str) -> String {
    mcp::tool_name(&server.into(), &tool.into())
        .to_utf8()
        .unwrap_or_default()
}

fn description(definition: &Value, background: bool) -> String {
    format!(
        "{}{}",
        definition["description"].as_str().unwrap_or_default(),
        if background { BACKGROUND_NOTE } else { "" }
    )
}

fn input_schema(definition: &Value, background: bool) -> JsonValue {
    let mut schema = definition["inputSchema"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if background {
        properties.insert(
            "background".into(),
            json!({"type":"boolean","description":BACKGROUND_PROPERTY}),
        );
    }
    schema.insert("type".into(), "object".into());
    schema.insert("properties".into(), Value::Object(properties));
    schema.insert("additionalProperties".into(), Value::Bool(false));
    parse_json(&Value::Object(schema).to_string()).unwrap_or(JsonValue::Null)
}

struct Call {
    service: Arc<Service>,
    policy: Arc<LeafPolicy>,
    background: Option<Background>,
    server: String,
    tool: String,
    action: String,
    backgroundable: bool,
}

impl Call {
    async fn run(&self, input: JsonValue, context: Context) -> Result<ToolOutput, Failure> {
        self.policy
            .assert(
                &context,
                &self.action,
                vec!["*".into()],
                vec!["*".into()],
                Some(JsonObject::new()),
            )
            .await
            .map_err(|error| self.unable(error))?;
        let (args, background) = arguments(&input)?;
        let reservation = if self.backgroundable {
            let keys = args
                .keys()
                .map(|key| JsonValue::String(key.as_str().into()))
                .collect();
            let mut metadata = JsonObject::new();
            metadata.insert("arguments".into(), JsonValue::Array(keys));
            Some(
                self.policy
                    .reserve(
                        &context,
                        "mcp_execute",
                        vec![format!("{}/{}", self.server, self.tool).into()],
                        Some(metadata),
                    )
                    .await
                    .map_err(|error| self.unable(error))?,
            )
        } else {
            None
        };
        if let Some(hosted) = &self.background {
            return self
                .hosted(hosted, args, background, reservation, &context)
                .await;
        }
        let release = || {
            if let Some(reservation) = &reservation {
                reservation.release();
            }
        };
        let result = tokio::select! {
            result = self.service.call_tool(&self.server, &self.tool, Value::Object(args), None) => result,
            () = context.cancellation.cancelled() => {
                release();
                return Err(Failure::Cancelled);
            }
        };
        release();
        match result {
            Ok(result) => output(result),
            Err(ClientError::Cancelled) => Err(Failure::Cancelled),
            Err(error) => Err(Failure::message(failure_text(&error))),
        }
    }

    async fn hosted(
        &self,
        hosted: &Background,
        args: Map<String, Value>,
        requested: bool,
        reservation: Option<Reservation>,
        context: &Context,
    ) -> Result<ToolOutput, Failure> {
        let id = context.call_id.to_utf8().unwrap_or_default();
        let slot = Arc::new(Mutex::new(None::<Result<ToolResult, ClientError>>));
        let title = if args.is_empty() {
            self.tool.clone()
        } else {
            format!(
                "{} ({})",
                self.tool,
                args.keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let mut metadata = Map::new();
        metadata.insert(
            "sessionID".into(),
            Value::String(
                context
                    .session_id
                    .as_lossless()
                    .to_utf8()
                    .unwrap_or_default(),
            ),
        );
        let run = {
            let (service, server, tool, slot) = (
                self.service.clone(),
                self.server.clone(),
                self.tool.clone(),
                slot.clone(),
            );
            Box::pin(async move {
                let _held = reservation;
                let result = service
                    .call_tool(&server, &tool, Value::Object(args), None)
                    .await;
                let outcome = match &result {
                    Ok(result) => Ok(texts(result)),
                    Err(error) => Err(failure_text(error)),
                };
                *slot
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(result);
                outcome
            })
        };
        hosted
            .jobs
            .start(StartInput {
                id: Some(id.clone()),
                kind: self.action.clone(),
                title: Some(title),
                metadata: Some(metadata),
                run,
            })
            .map_err(|_| Failure::message(format!("Unable to execute {}", self.action)))?;
        if requested {
            hosted.jobs.background(&id);
            return Ok(self.moved(hosted, context, id));
        }
        let blocked = tokio::select! {
            blocked = hosted.jobs.block(BlockInput {
                id: id.clone(),
                session_id: context.session_id.clone(),
                background_after: None,
            }) => blocked,
            () = context.cancellation.cancelled() => {
                hosted.jobs.cancel(&id).await;
                return Err(Failure::Cancelled);
            }
        };
        let taken = slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        match blocked {
            Some(BlockResult::Backgrounded { .. }) => Ok(self.moved(hosted, context, id)),
            Some(BlockResult::Finished(info)) => match (info.status, taken) {
                (Status::Error, Some(Err(ClientError::Cancelled))) => Err(Failure::Cancelled),
                (Status::Error, _) => Err(Failure::message(
                    info.error.unwrap_or_else(|| "MCP tool failed".into()),
                )),
                (Status::Cancelled, _) => Err(Failure::message("MCP tool cancelled")),
                (_, Some(Ok(result))) => output(result),
                _ => Err(Failure::message("MCP tool completed without a result")),
            },
            None => Err(Failure::message("MCP tool completed without a result")),
        }
    }

    fn moved(&self, hosted: &Background, context: &Context, id: String) -> ToolOutput {
        let (jobs, notifier) = (hosted.jobs.clone(), hosted.notifier.clone());
        let (session_id, description, action) = (
            context.session_id.clone(),
            self.tool.clone(),
            self.action.clone(),
        );
        tokio::spawn(async move {
            let Some(info) = jobs.wait(&id, None).await.info else {
                return;
            };
            let (state, text) = match info.status {
                Status::Completed => ("completed", info.output.unwrap_or_default()),
                Status::Error => (
                    "error",
                    info.error.unwrap_or_else(|| "MCP tool failed".into()),
                ),
                Status::Cancelled => ("cancelled", "MCP tool cancelled".into()),
                Status::Running => return,
            };
            notifier(Notification {
                session_id,
                description,
                state,
                text: format!(
                    "<mcp id=\"{id}\" state=\"{state}\" tool=\"{action}\">\n{text}\n</mcp>"
                ),
            })
            .await;
        });
        ToolOutput {
            structured: JsonValue::Null,
            content: vec![ToolContent::Text(ToolTextContent {
                text: "The MCP tool was moved to the background.".into(),
            })],
        }
    }

    fn unable(&self, error: Failure) -> Failure {
        match error {
            Failure::Tool { .. } => Failure::message(format!("Unable to execute {}", self.action)),
            other => other,
        }
    }
}

fn arguments(input: &JsonValue) -> Result<(Map<String, Value>, bool), Failure> {
    let invalid = || Failure::message("Invalid tool input: Expected object");
    let value = match input {
        JsonValue::Null => Value::Object(Map::new()),
        JsonValue::Object(_) => serde_json::from_str(&ycoding_schema::stringify_json(input))
            .map_err(|_| Failure::message("Invalid tool input"))?,
        _ => return Err(invalid()),
    };
    let Value::Object(mut args) = value else {
        return Err(invalid());
    };
    let background = args.remove("background") == Some(Value::Bool(true));
    Ok((args, background))
}

fn failure_text(error: &ClientError) -> String {
    match error {
        ClientError::NotFound(server) => format!("MCP server \"{server}\" is not available"),
        other => other.to_string(),
    }
}

fn texts(result: &ToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|part| match part {
            Content::Text(text) => Some(text.as_str()),
            Content::Media { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn output(result: ToolResult) -> Result<ToolOutput, Failure> {
    let text = texts(&result);
    if result.is_error {
        return Err(Failure::message(if text.trim().is_empty() {
            "MCP tool returned an error".into()
        } else {
            text.trim().to_owned()
        }));
    }
    let structured = match result.structured.filter(|value| !value.is_null()) {
        Some(value) => parse_json(&value.to_string())
            .map_err(|_| Failure::Defect("Invalid MCP structured content".into()))?,
        None if text.is_empty() => JsonValue::Null,
        None => JsonValue::String(LosslessString::from(text)),
    };
    Ok(ToolOutput {
        structured,
        content: result
            .content
            .into_iter()
            .map(|part| match part {
                Content::Text(text) => ToolContent::Text(ToolTextContent { text: text.into() }),
                Content::Media { data, mime_type } => ToolContent::File(ToolFileContent {
                    uri: format!("data:{mime_type};base64,{data}").into(),
                    mime: mime_type.into(),
                    name: None,
                }),
            })
            .collect(),
    })
}
