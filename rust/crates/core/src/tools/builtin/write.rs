use super::filesystem::{Paths, object, path_text, string, utf8};
use crate::{
    platform::filesystem::mutation,
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    JsonValue, ObjectEncoder,
    llm::{ToolContent, ToolTextContent},
    parse_json,
};

pub struct Write {
    pub paths: Arc<Paths>,
    pub files: Arc<mutation::Service>,
    pub policy: Arc<LeafPolicy>,
}
impl Tool for Write {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition { name: name.into(), description: "Write content to one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.".into(), input_schema: parse_json(r#"{"type":"object","properties":{"path":{"type":"string","description":"File path to write. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval."},"content":{"type":"string","description":"Content to write to the file"}},"required":["path","content"],"additionalProperties":false}"#).unwrap(), output_schema: Some(parse_json(r#"{"type":"object","properties":{"operation":{"type":"string","enum":["write"]},"target":{"type":"string"},"resource":{"type":"string"},"existed":{"type":"boolean"}},"required":["operation","target","resource","existed"],"additionalProperties":false}"#).unwrap()), cache: None, metadata: None, native: None }
    }
    fn permission(&self) -> Option<&str> {
        Some("edit")
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = object(&input)?;
            let path = utf8(input, "path")?;
            let content = string(input, "content")?;
            let result = async {
                let target = self
                    .paths
                    .resolve(&path, false)
                    .map_err(|error| Failure::message(error.to_string()))?;
                target.authorize_external(&self.policy, &context).await?;
                self.policy
                    .assert(
                        &context,
                        "edit",
                        vec![target.mutation.resource.clone().into()],
                        vec!["*".into()],
                        None,
                    )
                    .await?;
                let metadata = match ObjectEncoder::new().field("operation", "write").finish() {
                    JsonValue::Object(value) => value,
                    _ => unreachable!(),
                };
                let _reservation = self
                    .policy
                    .reserve(
                        &context,
                        "file_mutation",
                        vec![path_text(&target.mutation.canonical).into()],
                        Some(metadata),
                    )
                    .await?;
                self.files
                    .write_text_preserving_bom(
                        &target.mutation,
                        &String::from_utf16_lossy(&content.code_units().collect::<Vec<_>>()),
                    )
                    .map_err(|error| Failure::message(error.to_string()))
            }
            .await
            .map_err(|error| match error {
                Failure::Cancelled | Failure::Defect(_) => error,
                _ => Failure::message(format!("Unable to write {path}")),
            })?;
            let text = format!(
                "{} file successfully: {}",
                if result.existed { "Wrote" } else { "Created" },
                result.resource
            );
            Ok(ToolOutput {
                structured: ObjectEncoder::new()
                    .field("operation", "write")
                    .field("target", path_text(&result.target).as_str())
                    .field("resource", result.resource.as_str())
                    .field("existed", &result.existed)
                    .finish(),
                content: vec![ToolContent::Text(ToolTextContent { text: text.into() })],
            })
        })
    }
}
