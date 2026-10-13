use crate::{
    resources::config::Configuration,
    tools::{code_mode::Cancellation, policy::helper::Models},
};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
};
use ycoding_ai::{llm, route::Executor};
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, ObjectEncoder, model, session};

pub const IMAGE_ANALYSIS_SCHEMA_VERSION: &str = "1";
pub fn standard_prompt() -> LosslessString {
    let JsonValue::Object(value) =
        ycoding_schema::parse_json(include_str!("../tools/builtin/image-analyzer.json"))
            .expect("embedded image contract")
    else {
        unreachable!()
    };
    let Some(JsonValue::String(prompt)) = value.get(&"prompt".into()) else {
        unreachable!()
    };
    prompt.clone()
}
pub fn is_multimodal(capabilities: Option<&model::Capabilities>) -> bool {
    capabilities.is_some_and(|capabilities| {
        capabilities.input.iter().any(|input| {
            input
                .as_str()
                .is_some_and(|input| input.contains("image") || input == "vision")
        })
    })
}
pub fn normalize_analysis(raw: &str) -> String {
    let trimmed = crate::session::helper_generation::trim(raw);
    if !trimmed.starts_with("```") {
        return trimmed;
    }
    match (trimmed.find('\n'), trimmed.rfind("```")) {
        (Some(first), Some(last)) if last > first => {
            crate::session::helper_generation::trim(&trimmed[first + 1..last])
        }
        _ => trimmed,
    }
}
#[derive(Clone, Debug)]
pub struct Image {
    pub mime: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub digest: String,
    pub bytes: usize,
}
#[derive(Clone)]
pub struct Input {
    pub file: Image,
    pub bytes: Vec<u8>,
}
pub struct Collected {
    pub inputs: Vec<Input>,
    pub tool_uris: BTreeMap<String, String>,
}
#[derive(Default)]
pub struct Descriptions {
    pub attachments: BTreeMap<String, String>,
    pub tools: BTreeMap<String, String>,
}
pub fn collect(
    messages: &[ycoding_schema::session_message::Info],
    attachments: &crate::resources::attachment_store::Store,
) -> Collected {
    use ycoding_schema::{
        llm::ToolContent,
        session_message::{AssistantContent, Info, ToolState},
    };
    let mut inputs = messages
        .iter()
        .flat_map(|message| match message {
            Info::User(user) => user.files.as_deref().unwrap_or_default(),
            _ => &[],
        })
        .filter(|file| crate::session::generate::provider_image(&file.mime))
        .filter_map(|file| {
            let bytes = attachments.read(&file.content).ok()?;
            Some(Input {
                file: Image {
                    mime: file.mime.to_utf8().ok()?,
                    name: file
                        .name
                        .as_ref()
                        .map(|name| name.to_utf8().unwrap_or_default()),
                    description: file
                        .description
                        .as_ref()
                        .map(|description| description.to_utf8().unwrap_or_default()),
                    digest: file.content.digest.0.to_utf8().ok()?,
                    bytes: bytes.len(),
                },
                bytes,
            })
        })
        .collect::<Vec<_>>();
    let mut images = Vec::<(String, Input)>::new();
    for content in messages
        .iter()
        .flat_map(|message| match message {
            Info::Assistant(assistant) => assistant.content.as_slice(),
            _ => &[],
        })
        .filter_map(|part| match part {
            AssistantContent::Tool(tool) if tool.executed != Some(true) => match &tool.state {
                ToolState::Completed(state) => Some(state.content.as_slice()),
                _ => None,
            },
            _ => None,
        })
        .flatten()
    {
        let ToolContent::File(file) = content else {
            continue;
        };
        if !crate::session::generate::provider_image(&file.mime) {
            continue;
        }
        let Some(uri) = file.uri.as_str().filter(|uri| uri.starts_with("data:")) else {
            continue;
        };
        let Some(marker) = uri.find(";base64,") else {
            continue;
        };
        let bytes = crate::resources::image::decode_base64(&uri[marker + 8..]);
        let digest = ring::digest::digest(&ring::digest::SHA256, &bytes)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let input = Input {
            file: Image {
                mime: file.mime.to_utf8().unwrap_or_default(),
                name: file
                    .name
                    .as_ref()
                    .map(|name| name.to_utf8().unwrap_or_default()),
                description: None,
                digest,
                bytes: bytes.len(),
            },
            bytes,
        };
        match images.iter_mut().find(|(existing, _)| existing == uri) {
            Some((_, existing)) => *existing = input,
            None => images.push((uri.to_owned(), input)),
        }
    }
    let tool_uris = images
        .iter()
        .map(|(uri, input)| (uri.clone(), input.file.digest.clone()))
        .collect();
    inputs.extend(images.into_iter().map(|(_, input)| input));
    Collected { inputs, tool_uris }
}
pub fn format_fallback_block(file: &Image, analysis: &str, model_label: Option<&str>) -> String {
    let name = file
        .name
        .clone()
        .unwrap_or_else(|| file.digest.chars().take(12).collect());
    let label = model_label
        .map(|label| format!(" via {label}"))
        .unwrap_or_default();
    let mut lines = vec![
        format!("[Image Analysis: {name} ({}){label}]", file.mime),
        String::new(),
        "```toon".into(),
        normalize_analysis(analysis),
        "```".into(),
    ];
    if let Some(description) = file
        .description
        .as_ref()
        .filter(|description| !description.is_empty())
    {
        lines.push(format!("Original description: {description}"));
    }
    lines.extend([
        format!("SHA-256: {}", file.digest),
        format!("Bytes: {}", file.bytes),
    ]);
    lines.join("\n")
}
pub fn failure_block(file: &Image, error: &str) -> String {
    let name = file
        .name
        .clone()
        .unwrap_or_else(|| file.digest.chars().take(12).collect());
    let mut lines = vec![
        format!("[Image Analysis: {name} ({}) — FAILED]", file.mime),
        format!("Automated vision analysis failed: {error}"),
        "Fallback: image could not be analyzed, but metadata is preserved below.".into(),
        format!("SHA-256: {}", file.digest),
        format!("Bytes: {}", file.bytes),
    ];
    if let Some(description) = file
        .description
        .as_ref()
        .filter(|description| !description.is_empty())
    {
        lines.push(format!("Description: {description}"));
    }
    lines.join("\n")
}
#[derive(Clone, Debug)]
pub struct Settings {
    pub model: model::Ref,
    pub prompt: LosslessString,
    pub max_images: Option<usize>,
    pub max_bytes: Option<usize>,
}
impl Settings {
    pub fn read(config: &Configuration) -> Option<Self> {
        let JsonValue::Object(info) = config.latest("image_analyzer")? else {
            return None;
        };
        if info.get(&"enabled".into()) == Some(&JsonValue::Bool(false)) {
            return None;
        }
        let Some(JsonValue::String(selected)) = info.get(&"model".into()) else {
            return None;
        };
        let selected = selected.as_str()?;
        let selector = if selected.contains('/') {
            selected.to_owned()
        } else {
            let Some(JsonValue::String(provider)) = info.get(&"provider".into()) else {
                return None;
            };
            format!(
                "{}/{selected}{}",
                provider.as_str()?,
                if selected.contains('#') {
                    String::new()
                } else {
                    info.get(&"variant".into())
                        .and_then(|value| {
                            if let JsonValue::String(value) = value {
                                value.as_str()
                            } else {
                                None
                            }
                        })
                        .map(|variant| format!("#{variant}"))
                        .unwrap_or_default()
                }
            )
        };
        let (provider, model) = selector.split_once('/')?;
        let (profile, provider) = provider
            .split_once('#')
            .map_or((None, provider), |(profile, provider)| {
                (Some(profile), provider)
            });
        if provider.is_empty() || provider.contains('#') || model.is_empty() {
            return None;
        }
        let (model, variant) = model
            .split_once('#')
            .map_or((model, None), |(model, variant)| (model, Some(variant)));
        if model.is_empty()
            || variant.is_some_and(|variant| variant.is_empty() || variant.contains('#'))
            || profile.is_some_and(str::is_empty)
        {
            return None;
        }
        let model = model::Ref::decode(
            &ObjectEncoder::new()
                .field("providerID", provider)
                .field("id", model)
                .optional("variant", &variant.map(LosslessString::from))
                .optional("profile", &profile.map(LosslessString::from))
                .finish(),
        )
        .ok()?;
        let prompt = info
            .get(&"prompt".into())
            .or_else(|| info.get(&"template".into()))
            .and_then(|value| {
                if let JsonValue::String(prompt) = value {
                    Some(prompt.clone())
                } else {
                    None
                }
            })
            .unwrap_or_else(standard_prompt);
        let positive = |name: &str| {
            info.get(&name.into()).and_then(|value| {
                if let JsonValue::Number(count) = value {
                    (*count > 0.0 && count.fract() == 0.0).then_some(*count as usize)
                } else {
                    None
                }
            })
        };
        Some(Self {
            model,
            prompt,
            max_images: positive("max_images"),
            max_bytes: positive("max_bytes"),
        })
    }
}
#[derive(Default)]
struct Memo {
    values: BTreeMap<String, String>,
    order: VecDeque<String>,
}
struct Inner {
    config: Arc<Configuration>,
    models: Arc<Models>,
    executor: Arc<Executor>,
    memo: Mutex<Memo>,
}
#[derive(Clone)]
pub struct Service(Arc<Inner>);
impl Service {
    pub fn new(config: Arc<Configuration>, models: Arc<Models>, executor: Arc<Executor>) -> Self {
        Self(Arc::new(Inner {
            config,
            models,
            executor,
            memo: Mutex::default(),
        }))
    }
    pub async fn analyze(
        &self,
        inputs: &[Input],
        session: Option<&session::Info>,
        custom_prompt: Option<&LosslessString>,
        cancellation: &Cancellation,
    ) -> Result<BTreeMap<String, String>, String> {
        if inputs.is_empty() {
            return Ok(BTreeMap::new());
        }
        let settings = Settings::read(&self.0.config);
        let resolved = match settings.as_ref() {
            Some(settings) => {
                tokio::select! {biased; _ = cancellation.cancelled() => return Err("Image analysis cancelled".into()), resolved = self.0.models.resolve_optional(session, &settings.model) => resolved.ok()}
            }
            None => None,
        };
        let Some((settings, resolved)) = settings.zip(resolved) else {
            return Ok(inputs
                .iter()
                .map(|input| {
                    (
                        input.file.digest.clone(),
                        failure_block(&input.file, "vision model not configured or unavailable"),
                    )
                })
                .collect());
        };
        if cancellation.is_cancelled() {
            return Err("Image analysis cancelled".into());
        }
        let prompt = custom_prompt.cloned().unwrap_or(settings.prompt);
        let label = format!(
            "{}/{}{}",
            resolved
                .selection
                .provider_id
                .0
                .to_utf8()
                .unwrap_or_default(),
            resolved.selection.id.to_utf8().unwrap_or_default(),
            resolved
                .selection
                .variant
                .as_ref()
                .map(|variant| format!("#{}", variant.to_utf8().unwrap_or_default()))
                .unwrap_or_default()
        );
        let mut ready = VecDeque::new();
        let mut results = BTreeMap::new();
        for (index, input) in inputs.iter().enumerate() {
            if settings.max_images.is_some_and(|limit| index >= limit) {
                results.insert(
                    index,
                    (
                        input.file.digest.clone(),
                        failure_block(
                            &input.file,
                            &format!(
                                "exceeds max_images {}",
                                settings.max_images.unwrap_or_default()
                            ),
                        ),
                    ),
                );
                continue;
            }
            if settings
                .max_bytes
                .is_some_and(|limit| input.bytes.len() > limit)
            {
                results.insert(
                    index,
                    (
                        input.file.digest.clone(),
                        failure_block(
                            &input.file,
                            &format!(
                                "image exceeds max_bytes {}",
                                settings.max_bytes.unwrap_or_default()
                            ),
                        ),
                    ),
                );
                continue;
            }
            ready.push_back((index, input.clone()));
        }
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            while tasks.len() < 3 {
                let Some((index, input)) = ready.pop_front() else {
                    break;
                };
                let service = self.clone();
                let label = label.clone();
                let prompt = prompt.clone();
                let model = resolved.model.clone();
                let identity = resolved.account_identity.clone();
                tasks.spawn(async move {
                    let key = ycoding_schema::stringify_json(&JsonValue::Array(vec![JsonValue::String(ycoding_schema::stringify_json(&JsonValue::Array(vec![JsonValue::String(label.as_str().into()), identity.map_or(JsonValue::Null, |identity| JsonValue::String(identity.into()))])).into()), JsonValue::String(prompt.clone()), JsonValue::String(input.file.digest.as_str().into())]));
                    let cached = service.0.memo.lock().unwrap_or_else(std::sync::PoisonError::into_inner).values.get(&key).cloned();
                    let analysis = match cached {Some(analysis) => analysis, None => {
                        let mut request = llm::Request::new(model);
                        request.system = vec![prompt.into()];
                        request.messages = vec![llm::Message::new(llm::Role::User, vec![llm::Part::Media(llm::Media {mime: input.file.mime.as_str().into(), data: llm::MediaData::Bytes(input.bytes), filename: input.file.name.as_deref().map(Into::into)}), llm::Part::Text("Describe this image per the system instructions. Output ONLY TOON.".into())])];
                        let raw = match service.0.executor.generate(&request).await {Ok(response) => response.events.iter().filter_map(|event| if let llm::Event::TextDelta(delta) = event {Some(delta.text.to_utf8().unwrap_or_default())} else {None}).collect::<String>(), Err(_) => "[analysis failed]".into()};
                        let raw = crate::session::helper_generation::trim(&raw);
                        let analysis = normalize_analysis(if raw.is_empty() {"[no description returned]"} else {&raw});
                        if analysis.is_empty() || matches!(analysis.as_str(), "[analysis failed]" | "[no description returned]") {analysis} else {
                            let mut memo = service.0.memo.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                            if let Some(existing) = memo.values.get(&key) {existing.clone()} else {memo.values.insert(key.clone(), analysis.clone()); memo.order.push_back(key); if memo.values.len() > 512 && let Some(stale) = memo.order.pop_front() {memo.values.remove(&stale);} analysis}
                        }
                    }};
                    (index, (input.file.digest.clone(), format_fallback_block(&input.file, &analysis, Some(&label))))
                });
            }
            if tasks.is_empty() {
                break;
            }
            let next = tokio::select! {biased; _ = cancellation.cancelled() => return Err("Image analysis cancelled".into()), next = tasks.join_next() => next};
            if let Some(next) = next {
                let (index, result) = next.map_err(|error| error.to_string())?;
                results.insert(index, result);
            }
        }
        Ok(results.into_values().collect())
    }
    pub async fn fallback_for_text_model(
        &self,
        inputs: &[Input],
        session: &session::Info,
        capabilities: Option<&model::Capabilities>,
        cancellation: &Cancellation,
    ) -> Result<Option<BTreeMap<String, String>>, String> {
        if cancellation.is_cancelled() {
            return Err("Image analysis cancelled".into());
        }
        if inputs.is_empty() || is_multimodal(capabilities) {
            return Ok(None);
        }
        if Settings::read(&self.0.config).is_none() {
            let reason = if self.0.config.latest("image_analyzer").is_none() {
                "image analyzer not configured"
            } else {
                "vision analyzer unavailable"
            };
            return Ok(Some(
                inputs
                    .iter()
                    .map(|input| {
                        (
                            input.file.digest.clone(),
                            failure_block(&input.file, reason),
                        )
                    })
                    .collect(),
            ));
        }
        let analyzed = self
            .analyze(inputs, Some(session), None, cancellation)
            .await;
        if cancellation.is_cancelled() {
            return Err("Image analysis cancelled".into());
        }
        Ok(Some(analyzed.unwrap_or_else(|_| {
            inputs
                .iter()
                .map(|input| {
                    (
                        input.file.digest.clone(),
                        failure_block(&input.file, "vision analysis error"),
                    )
                })
                .collect()
        })))
    }
    pub async fn descriptions_for_history(
        &self,
        messages: &[ycoding_schema::session_message::Info],
        attachments: &crate::resources::attachment_store::Store,
        session: &session::Info,
        capabilities: Option<&model::Capabilities>,
        cancellation: &Cancellation,
    ) -> Result<Option<Descriptions>, String> {
        let images = collect(messages, attachments);
        let Some(descriptions) = self
            .fallback_for_text_model(&images.inputs, session, capabilities, cancellation)
            .await?
        else {
            return Ok(None);
        };
        let tools = images
            .tool_uris
            .into_iter()
            .filter_map(|(uri, digest)| {
                descriptions
                    .get(&digest)
                    .map(|description| (uri, description.clone()))
            })
            .collect();
        Ok(Some(Descriptions {
            attachments: descriptions,
            tools,
        }))
    }
}
