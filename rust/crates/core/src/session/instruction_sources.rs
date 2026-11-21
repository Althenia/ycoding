use crate::{
    instructions::{self, Observation, Source},
    resources::instruction_discovery,
};
use std::sync::Arc;
use ycoding_schema::{DomainDecode, JsonValue, LosslessString, ObjectEncoder, instruction};

pub fn ambient(options: instruction_discovery::Options) -> Source {
    ambient_with_capabilities(options, Default::default())
}
pub fn ambient_with_capabilities(
    options: instruction_discovery::Options,
    capabilities: crate::resources::config::capabilities::ConfigCapabilities,
) -> Source {
    let max_bytes = options.max_bytes;
    Source {
        key: instruction::Key::decode(&JsonValue::String(instruction_discovery::KEY.into()))
            .expect("ambient instruction key is valid"),
        read: Arc::new(move || {
            let options = options.clone();
            let capabilities = capabilities.clone();
            Box::pin(async move {
                Ok(
                    match instruction_discovery::observe_with_capabilities(&options, &capabilities)
                    {
                        instruction_discovery::Observation::Available(files) => {
                            Observation::Value(JsonValue::Array(
                                files
                                    .into_iter()
                                    .map(|file| {
                                        ObjectEncoder::new()
                                            .field("path", file.path.to_string_lossy().as_ref())
                                            .field("content", file.content.as_str())
                                            .finish()
                                    })
                                    .collect(),
                            ))
                        }
                        instruction_discovery::Observation::Removed => Observation::Removed,
                        instruction_discovery::Observation::Unavailable(_) => {
                            Observation::Unavailable
                        }
                    },
                )
            })
        }),
        initial: Arc::new(move |value| render(value, max_bytes)),
        changed: Arc::new(move |_, value| {
            render(value, max_bytes).map(|text| instructions::join(&["These instructions replace all previously loaded ambient instructions.\n\n".into(), text], ""))
        }),
        removed: Some(Arc::new(|_| {
            Some("Previously loaded instructions no longer apply.".into())
        })),
    }
}
fn render(value: &JsonValue, max_bytes: Option<usize>) -> Option<LosslessString> {
    let JsonValue::Array(files) = value else {
        return None;
    };
    let parts = files
        .iter()
        .map(|file| {
            let JsonValue::Object(file) = file else {
                return None;
            };
            let Some(JsonValue::String(path)) = file.get(&"path".into()) else {
                return None;
            };
            let Some(JsonValue::String(content)) = file.get(&"content".into()) else {
                return None;
            };
            let rendered = instruction_discovery::render_content(
                path.as_str()?,
                content.as_str()?,
                max_bytes,
                "read",
            );
            Some(instructions::join(
                &[
                    "Instructions from: ".into(),
                    path.clone(),
                    "\n".into(),
                    rendered.content.into(),
                ],
                "",
            ))
        })
        .collect::<Option<Vec<_>>>()?;
    Some(instructions::join(&parts, "\n\n"))
}
