use super::filesystem::{Paths, object, path_text, string, utf8};
use crate::{
    platform::diff::{create_two_files_patch, diff_lines},
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

pub struct Edit {
    pub paths: Arc<Paths>,
    pub files: Arc<mutation::Service>,
    pub policy: Arc<LeafPolicy>,
}

impl Tool for Edit {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: "Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.".into(),
            input_schema: parse_json(r#"{"type":"object","properties":{"path":{"type":"string","description":"File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval."},"oldString":{"type":"string","description":"Exact text to replace"},"newString":{"type":"string","description":"Replacement text, which must differ from oldString"},"replaceAll":{"anyOf":[{"type":"boolean"},{"type":"null"}],"description":"Replace all exact occurrences of oldString (default false)"}},"required":["path","oldString","newString"],"additionalProperties":false}"#).unwrap(),
            output_schema: Some(parse_json(r#"{"type":"object","properties":{"files":{"type":"array","items":{"type":"object","properties":{"file":{"type":"string"},"patch":{"type":"string"},"additions":{"type":"integer","minimum":0},"deletions":{"type":"integer","minimum":0},"status":{"type":"string","enum":["added","deleted","modified"]}},"required":["file","patch","additions","deletions","status"],"additionalProperties":false}},"replacements":{"type":"number"}},"required":["files","replacements"],"additionalProperties":false}"#).unwrap()),
            cache: None,
            metadata: None,
            native: None,
        }
    }

    fn permission(&self) -> Option<&str> {
        Some("edit")
    }

    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = object(&input)?;
            let path = utf8(input, "path")?;
            let old_string = string(input, "oldString")?.to_utf8().map_err(|_| {
                Failure::message("Invalid tool input: oldString is not valid Unicode")
            })?;
            let new_string = string(input, "newString")?.to_utf8().map_err(|_| {
                Failure::message("Invalid tool input: newString is not valid Unicode")
            })?;
            let replace_all = match input.get(&"replaceAll".into()) {
                None | Some(JsonValue::Null) => false,
                Some(JsonValue::Bool(value)) => *value,
                _ => return Err(Failure::message("Invalid tool input: Invalid replaceAll")),
            };
            if old_string == new_string {
                return Err(Failure::message(
                    "No changes to apply: oldString and newString are identical.",
                ));
            }
            if old_string.is_empty() {
                return Err(Failure::message(
                    "oldString must not be empty. Use write to create or overwrite a file.",
                ));
            }
            let target = self
                .paths
                .resolve(&path, false)
                .map_err(|_| Failure::message(format!("Unable to edit {path}")))?;
            target
                .authorize_external(&self.policy, &context)
                .await
                .map_err(|error| unable_to_edit(error, &path))?;
            self.policy
                .assert(
                    &context,
                    "edit",
                    vec![target.mutation.resource.clone().into()],
                    vec!["*".into()],
                    None,
                )
                .await
                .map_err(|error| unable_to_edit(error, &path))?;
            let source = std::fs::read(&target.mutation.canonical)
                .map_err(|_| Failure::message(format!("Unable to edit {path}")))?;
            let bom = source.starts_with(&[0xef, 0xbb, 0xbf]);
            let body = if bom { &source[3..] } else { source.as_slice() };
            let source_text = String::from_utf8_lossy(body).into_owned();
            let line_ending = if source_text.contains("\r\n") {
                "\r\n"
            } else {
                "\n"
            };
            let old_string = convert_line_endings(&old_string, line_ending);
            let new_string = convert_line_endings(&new_string, line_ending);
            let replacements = source_text.match_indices(&old_string).count();
            if replacements == 0 {
                return Err(Failure::message(
                    "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
                ));
            }
            if replacements > 1 && !replace_all {
                return Err(Failure::message(
                    "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
                ));
            }
            let replaced = if replace_all {
                source_text.replace(&old_string, &new_string)
            } else {
                source_text.replacen(&old_string, &new_string, 1)
            };
            let changes = diff_lines(&source_text, &replaced);
            let additions = changes
                .iter()
                .filter(|change| change.added)
                .map(|change| change.count)
                .sum::<usize>();
            let deletions = changes
                .iter()
                .filter(|change| change.removed)
                .map(|change| change.count)
                .sum::<usize>();
            let patch = create_two_files_patch(
                &target.mutation.resource,
                &target.mutation.resource,
                &source_text,
                &replaced,
            );
            let mut bytes = if bom {
                vec![0xef, 0xbb, 0xbf]
            } else {
                Vec::new()
            };
            bytes.extend_from_slice(replaced.as_bytes());
            let metadata = match ObjectEncoder::new().field("operation", "edit").finish() {
                JsonValue::Object(value) => value,
                _ => unreachable!(),
            };
            let reservation = self
                .policy
                .reserve(
                    &context,
                    "file_mutation",
                    vec![path_text(&target.mutation.canonical).into()],
                    Some(metadata),
                )
                .await
                .map_err(|error| unable_to_edit(error, &path))?;
            let result = self
                .files
                .write_if_unchanged(&target.mutation, &source, &bytes);
            reservation.release();
            result.map_err(|error| match error {
                mutation::Error::StaleContent(_) => Failure::message(
                    "File changed after permission approval. Read it again before editing.",
                ),
                _ => Failure::message(format!("Unable to edit {path}")),
            })?;
            let preview = |value: &str, prefix: char| {
                let normalized = value.replace("\r\n", "\n");
                let mut lines = normalized
                    .split('\n')
                    .take(6)
                    .map(|line| {
                        let truncated = line.chars().count() > 240;
                        let line = line.chars().take(240).collect::<String>();
                        format!("{prefix}{line}{}", if truncated { "..." } else { "" })
                    })
                    .collect::<Vec<_>>();
                if normalized.split('\n').count() > 6 {
                    lines.push(format!("{prefix}..."));
                }
                lines
            };
            let files = vec![
                ObjectEncoder::new()
                    .field("file", target.mutation.resource.as_str())
                    .field("patch", patch.as_str())
                    .field("additions", &(additions as f64))
                    .field("deletions", &(deletions as f64))
                    .field("status", "modified")
                    .finish(),
            ];
            Ok(ToolOutput {
                structured: ObjectEncoder::new()
                    .field("files", &files)
                    .field("replacements", &(replacements as f64))
                    .finish(),
                content: vec![ToolContent::Text(ToolTextContent {
                    text: format!(
                        "Edited file successfully: {}\nReplacements: {replacements}\n```diff\n{}\n```",
                        target.mutation.resource,
                        preview(&old_string, '-')
                            .into_iter()
                            .chain(preview(&new_string, '+'))
                            .collect::<Vec<_>>()
                            .join("\n")
                    )
                    .into(),
                })],
            })
        })
    }
}

fn unable_to_edit(error: Failure, path: &str) -> Failure {
    match error {
        Failure::Cancelled | Failure::Defect(_) => error,
        _ => Failure::message(format!("Unable to edit {path}")),
    }
}

fn convert_line_endings(value: &str, line_ending: &str) -> String {
    value.replace("\r\n", "\n").replace('\n', line_ending)
}
