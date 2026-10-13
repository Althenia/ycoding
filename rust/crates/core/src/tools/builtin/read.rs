use super::{
    filesystem::{Paths, Target, object, optional_number, utf8},
    read_filesystem::{self, Page, ReadError},
};
use crate::{
    platform::filesystem,
    tools::{
        code_mode::Collation,
        context::{Context, consumers::ReadInstructions, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::{fs, sync::Arc};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    JsonValue,
    llm::{ToolContent, ToolFileContent, ToolTextContent},
    parse_json,
};

pub struct Read {
    pub paths: Arc<Paths>,
    pub policy: Arc<LeafPolicy>,
    pub instructions: Arc<dyn ReadInstructions>,
    pub collator: Arc<Collation>,
}
impl Read {
    pub async fn authorize(
        &self,
        path: &str,
        context: &Context,
    ) -> Result<(Target, bool), Failure> {
        let target = self
            .paths
            .resolve(path, true)
            .map_err(|error| Failure::message(error.to_string()))?;
        target.authorize_external(&self.policy, context).await?;
        let info = fs::metadata(&target.mutation.canonical)
            .map_err(|error| Failure::message(error.to_string()))?;
        if !info.is_file() && !info.is_dir() {
            return Err(Failure::message(format!(
                "Path is not a file or directory: {path}"
            )));
        }
        self.policy
            .assert(
                context,
                "read",
                vec![target.mutation.resource.clone().into()],
                vec!["*".into()],
                None,
            )
            .await?;
        Ok((target, info.is_dir()))
    }
}
impl Tool for Read {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition { name: name.into(), description: "Read a text file or supported image, page through a large UTF-8 text file by line offset, or list a directory page. Relative paths resolve from the current location; absolute paths inside it are accepted, while external absolute paths require external_directory approval.".into(), input_schema: parse_json(r#"{"type":"object","properties":{"path":{"type":"string"},"offset":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0}]},{"type":"null"}],"description":"The 1-based directory entry or text line offset to start reading from"},"limit":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0},{"maximum":2000}]},{"type":"null"}],"description":"The maximum number of directory entries or text lines to read"}},"required":["path"],"additionalProperties":false}"#).unwrap(), output_schema: Some(parse_json(r##"{"anyOf":[{"$ref":"#/$defs/FileSystem.Content"},{"type":"object","properties":{"type":{"type":"string","enum":["text-page"]},"content":{"type":"string"},"mime":{"type":"string"},"offset":{"type":"integer","allOf":[{"exclusiveMinimum":0}]},"truncated":{"type":"boolean"},"next":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0}]},{"type":"null"}]}},"required":["type","content","mime","offset","truncated"],"additionalProperties":false},{"type":"object","properties":{"entries":{"type":"array","items":{"$ref":"#/$defs/FileSystem.Entry"}},"truncated":{"type":"boolean"},"next":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0}]},{"type":"null"}]}},"required":["entries","truncated"],"additionalProperties":false}],"$defs":{"FileSystem.Content":{"type":"object","properties":{"uri":{"type":"string"},"name":{"anyOf":[{"type":"string"},{"type":"null"}]},"content":{"type":"string"},"encoding":{"type":"string","enum":["utf8","base64"]},"mime":{"type":"string"}},"required":["uri","content","encoding","mime"],"additionalProperties":false},"FileSystem.Entry":{"type":"object","properties":{"path":{"type":"string"},"type":{"type":"string","enum":["file","directory"]}},"required":["path","type"],"additionalProperties":false}}}"##).unwrap()), cache: None, metadata: None, native: None }
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = object(&input)?;
            let path = utf8(input, "path")?;
            let page = Page {
                offset: optional_number(input, "offset", 1.0, f64::MAX)?
                    .map(|value| value as usize),
                limit: optional_number(input, "limit", 1.0, 2000.0)?.map(|value| value as usize),
            };
            let (target, directory) =
                self.authorize(&path, &context)
                    .await
                    .map_err(|error| match error {
                        Failure::Cancelled | Failure::Defect(_) => error,
                        _ => Failure::message(format!("Unable to read {path}")),
                    })?;
            let output = if directory {
                read_filesystem::list(&target.mutation.canonical, page, self.collator.as_ref())
            } else {
                read_filesystem::read(&target.mutation.canonical, &target.mutation.resource, page)
            }
            .map_err(|error| match error {
                ReadError::Binary(_) | ReadError::MediaLimit(_) => {
                    Failure::message(error.to_string())
                }
                _ => Failure::message(format!("Unable to read {path}")),
            })?;
            if target.external.is_none() {
                let start = if directory {
                    target.mutation.canonical.as_path()
                } else {
                    target.mutation.canonical.parent().unwrap()
                };
                if let Ok(paths) =
                    filesystem::util::up(&["AGENTS.md"], start, Some(&self.paths.directory))
                {
                    let paths = paths
                        .into_iter()
                        .map(fs::canonicalize)
                        .collect::<Result<Vec<_>, _>>();
                    let paths = paths
                        .ok()
                        .map(|paths| {
                            paths
                                .into_iter()
                                .filter(|path| {
                                    path.parent() != Some(self.paths.directory.as_path())
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    if !paths.is_empty() {
                        let _ = self.instructions.load(context.clone(), paths).await;
                    }
                }
            }
            let mut content = vec![];
            let mut structured = output;
            if let JsonValue::Object(output) = &mut structured
                && output.get(&"encoding".into()) == Some(&JsonValue::String("base64".into()))
            {
                let Some(JsonValue::String(mime)) = output.get(&"mime".into()).cloned() else {
                    return Err(Failure::Defect("Media has no MIME".into()));
                };
                let Some(JsonValue::String(data)) = output.get(&"content".into()).cloned() else {
                    return Err(Failure::Defect("Media has no content".into()));
                };
                content = vec![
                    ToolContent::Text(ToolTextContent {
                        text: "Image read successfully".into(),
                    }),
                    ToolContent::File(ToolFileContent {
                        uri: format!(
                            "data:{};base64,{}",
                            mime.as_str().unwrap(),
                            data.as_str().unwrap()
                        )
                        .into(),
                        mime,
                        name: Some(path.into()),
                    }),
                ];
                output.insert("content".into(), JsonValue::String("".into()));
            }
            Ok(ToolOutput {
                structured,
                content,
            })
        })
    }
}
