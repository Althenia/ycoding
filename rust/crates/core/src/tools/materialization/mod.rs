use super::{
    context::Context,
    registry::{Entry, Failure},
};
use crate::resources::{config::Configuration, image, tool_output_store::Store};
use std::{
    collections::BTreeMap,
    io,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use ycoding_ai::llm::{ToolDefinition, ToolOutput, ToolResultValue};
use ycoding_schema::{
    JsonValue,
    llm::{ToolContent, ToolTextContent},
    session_error,
};

pub struct BeforeEvent {
    pub tool: String,
    pub context: Context,
    pub input: JsonValue,
}
pub struct AfterEvent {
    pub tool: String,
    pub context: Context,
    pub input: JsonValue,
    pub result: ToolResultValue,
    pub output: Option<ToolOutput>,
    pub output_paths: Vec<PathBuf>,
}
pub type BeforeHook = Arc<dyn Fn(BeforeEvent) -> BeforeFuture + Send + Sync>;
pub type AfterHook = Arc<dyn Fn(AfterEvent) -> AfterFuture + Send + Sync>;
pub type BeforeFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<BeforeEvent, Failure>> + Send>>;
pub type AfterFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<AfterEvent, Failure>> + Send>>;
type HookState = (u64, Vec<(u64, u32, BeforeHook)>, Vec<(u64, u32, AfterHook)>);

#[derive(Default)]
pub struct Hooks {
    state: Arc<Mutex<HookState>>,
}
impl Hooks {
    pub fn before(&self, hook: BeforeHook) -> HookRegistration {
        self.before_ordered(0, hook)
    }
    pub fn before_ordered(&self, order: u32, hook: BeforeHook) -> HookRegistration {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.0 += 1;
        let token = state.0;
        state.1.push((token, order, hook));
        state.1.sort_by_key(|(token, order, _)| (*order, *token));
        HookRegistration {
            state: Arc::downgrade(&self.state),
            token,
        }
    }
    pub fn after(&self, hook: AfterHook) -> HookRegistration {
        self.after_ordered(0, hook)
    }
    pub fn after_ordered(&self, order: u32, hook: AfterHook) -> HookRegistration {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.0 += 1;
        let token = state.0;
        state.2.push((token, order, hook));
        state.2.sort_by_key(|(token, order, _)| (*order, *token));
        HookRegistration {
            state: Arc::downgrade(&self.state),
            token,
        }
    }
    pub async fn run_before(&self, mut event: BeforeEvent) -> Result<BeforeEvent, Failure> {
        let hooks = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .1
            .clone();
        for (_, _, hook) in hooks {
            event = hook(event).await?;
        }
        Ok(event)
    }
    pub async fn run_after(&self, mut event: AfterEvent) -> Result<AfterEvent, Failure> {
        let hooks = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .2
            .clone();
        for (_, _, hook) in hooks {
            event = hook(event).await?;
        }
        Ok(event)
    }
}
pub struct HookRegistration {
    state: Weak<Mutex<HookState>>,
    token: u64,
}
impl Drop for HookRegistration {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
            let before = state
                .1
                .iter()
                .find(|(token, _, _)| *token == self.token)
                .map(|(_, _, callback)| callback.clone());
            let after = state
                .2
                .iter()
                .find(|(token, _, _)| *token == self.token)
                .map(|(_, _, callback)| callback.clone());
            state.1.retain(|(_, _, callback)| {
                before
                    .as_ref()
                    .is_none_or(|held| !Arc::ptr_eq(callback, held))
            });
            state.2.retain(|(_, _, callback)| {
                after
                    .as_ref()
                    .is_none_or(|held| !Arc::ptr_eq(callback, held))
            });
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Storage(io::Error),
    Execution(Failure),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Settlement {
    pub result: ToolResultValue,
    pub output: Option<ToolOutput>,
    pub output_paths: Vec<PathBuf>,
    pub error: Option<session_error::Error>,
}
pub struct Materialization {
    pub definitions: Vec<ToolDefinition>,
    pub(crate) direct: BTreeMap<String, Entry>,
    pub(crate) hooks: Arc<Hooks>,
    pub(crate) resources: Arc<Store>,
    pub(crate) configuration: Option<Arc<Configuration>>,
    pub(crate) image_limits: image::Limits,
}
impl Materialization {
    pub async fn invoke(
        &self,
        name: &str,
        input: JsonValue,
        mut context: Context,
    ) -> Result<Settlement, Error> {
        let Some(entry) = self.direct.get(name) else {
            let message = format!("Unknown tool: {name}");
            return Ok(Settlement {
                result: ToolResultValue::Error(JsonValue::String(message.clone().into())),
                output: None,
                output_paths: vec![],
                error: Some(session_error::Error {
                    r#type: "tool.unknown".into(),
                    message: message.into(),
                }),
            });
        };
        let before = self
            .hooks
            .run_before(BeforeEvent {
                tool: name.into(),
                context: context.clone(),
                input,
            })
            .await
            .map_err(Error::Execution)?;
        if let Some(progress) = context.progress.take() {
            let limits = self.image_limits;
            context.progress = Some(Arc::new(move |mut update| {
                let progress = progress.clone();
                update.content = normalize_images(update.content, limits);
                Box::pin(async move { progress(update).await })
            }));
        }
        let pending = entry
            .tool
            .settle(before.input.clone(), context.clone())
            .await;
        let settlement = match pending {
            Ok(mut output) => {
                output.content = normalize_images(output.content, self.image_limits);
                let bounded = self
                    .resources
                    .bound(output, self.configuration.as_deref())
                    .await
                    .map_err(Error::Storage)?;
                Settlement {
                    result: bounded.output.result(),
                    output: Some(bounded.output),
                    output_paths: bounded.output_paths,
                    error: None,
                }
            }
            Err(error) => failed(error)?,
        };
        let original_output = settlement.output.clone();
        let original_result = settlement.result.clone();
        let mut after = self
            .hooks
            .run_after(AfterEvent {
                tool: name.into(),
                context,
                input: before.input,
                result: settlement.result,
                output: settlement.output,
                output_paths: settlement.output_paths,
            })
            .await
            .map_err(Error::Execution)?;
        if settlement.error.is_some() && !matches!(after.result, ToolResultValue::Error(_)) {
            return failed(Failure::message(
                "A tool failure cannot be transformed into success",
            ));
        }
        if let Some(output) = &after.output
            && let Err(error) = entry.tool.validate_output(output)
        {
            return failed(error);
        }
        if after.output != original_output
            && let Some(mut output) = after.output.clone()
        {
            output.content = normalize_images(output.content, self.image_limits);
            let result = output.result();
            let bounded = self
                .resources
                .bound(output, self.configuration.as_deref())
                .await
                .map_err(Error::Storage)?;
            if after.result == result {
                after.result = bounded.output.result();
            }
            after.output = Some(bounded.output);
            after.output_paths.extend(bounded.output_paths);
        }
        if after.result != original_result
            && let Some(mut output) = ToolOutput::from_result(&after.result)
        {
            output.content = normalize_images(output.content, self.image_limits);
            let bounded = self
                .resources
                .bound(output, self.configuration.as_deref())
                .await
                .map_err(Error::Storage)?;
            after.result = bounded.output.result();
            after.output_paths.extend(bounded.output_paths);
        }
        Ok(Settlement {
            result: after.result,
            output: after.output,
            output_paths: after.output_paths,
            error: settlement.error,
        })
    }
}

fn failed(error: Failure) -> Result<Settlement, Error> {
    let Failure::Tool { message, error } = error else {
        return Err(Error::Execution(error));
    };
    Ok(Settlement {
        result: ToolResultValue::Error(JsonValue::String(message.clone().into())),
        output: None,
        output_paths: vec![],
        error: Some(error.unwrap_or(session_error::Error {
            r#type: "tool.execution".into(),
            message: message.into(),
        })),
    })
}

pub fn normalize_images(content: Vec<ToolContent>, limits: image::Limits) -> Vec<ToolContent> {
    let mut decoded = 0;
    let mut oversized = 0;
    let mut normalized = content
        .into_iter()
        .filter_map(|item| {
            let ToolContent::File(mut file) = item else {
                return Some(item);
            };
            let Some(uri) = file.uri.as_str() else {
                return Some(ToolContent::File(file));
            };
            let Some((header, data)) = uri.split_once(',') else {
                return Some(ToolContent::File(file));
            };
            if !file
                .mime
                .as_str()
                .is_some_and(|mime| mime.starts_with("image/"))
                || !header.starts_with("data:")
                || !header.ends_with(";base64")
            {
                return Some(ToolContent::File(file));
            }
            let mime = String::from_utf16_lossy(&file.mime.code_units().collect::<Vec<_>>());
            let resource = file
                .name
                .as_ref()
                .map(|name| String::from_utf16_lossy(&name.code_units().collect::<Vec<_>>()))
                .unwrap_or_else(|| format!("{mime} tool output"));
            match image::normalize(
                &resource,
                &image::Content {
                    uri: resource.clone(),
                    name: None,
                    content: data.into(),
                    mime,
                },
                limits,
            ) {
                Ok(result) => {
                    file.uri = format!("data:{};base64,{}", result.mime, result.content).into();
                    file.mime = result.mime.into();
                    Some(ToolContent::File(file))
                }
                Err(image::Error::Decode { .. }) => {
                    decoded += 1;
                    None
                }
                Err(image::Error::Size { .. }) => {
                    oversized += 1;
                    None
                }
            }
        })
        .collect::<Vec<_>>();
    for (count, reason) in [
        (decoded, "could not be decoded."),
        (
            oversized,
            "could not be resized below the image size limit.",
        ),
    ] {
        if count > 0 {
            normalized.push(ToolContent::Text(ToolTextContent {
                text: format!(
                    "[{count} image{} omitted: {reason}]",
                    if count == 1 { "" } else { "s" }
                )
                .into(),
            }));
        }
    }
    normalized
}
