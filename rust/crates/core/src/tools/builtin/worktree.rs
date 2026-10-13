use super::filesystem::{Paths, object, path_text, string, utf8};
use crate::{
    platform::{filesystem, worktree},
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

pub struct Worktree {
    pub paths: Arc<Paths>,
    pub policy: Arc<LeafPolicy>,
}

impl Tool for Worktree {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: "List worktrees for the current Git repository or create a managed worktree on a named branch. Creation does not switch the current Session's Location. A later Session can use the returned path.".into(),
            input_schema: parse_json(r#"{"oneOf":[{"type":"object","properties":{"action":{"type":"string","const":"list"}},"required":["action"],"additionalProperties":false},{"type":"object","properties":{"action":{"type":"string","const":"create"},"name":{"type":"string","pattern":"^[a-z0-9][a-z0-9-]{0,62}$"}},"required":["action","name"],"additionalProperties":false}],"discriminator":{"propertyName":"action"}}"#).unwrap(),
            output_schema: Some(parse_json(r#"{"oneOf":[{"type":"object","properties":{"action":{"type":"string","const":"list"},"worktrees":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"branch":{"type":"string"},"current":{"type":"boolean"}},"required":["path","current"],"additionalProperties":false}}},"required":["action","worktrees"],"additionalProperties":false},{"type":"object","properties":{"action":{"type":"string","const":"create"},"path":{"type":"string"},"branch":{"type":"string"}},"required":["action","path","branch"],"additionalProperties":false}],"discriminator":{"propertyName":"action"}}"#).unwrap()),
            cache: None,
            metadata: None,
            native: None,
        }
    }

    fn permission(&self) -> Option<&str> {
        Some("worktree")
    }

    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = object(&input)?;
            let action = utf8(input, "action")?;
            let repository = self
                .paths
                .git
                .discover(&self.paths.directory)
                .map_err(|_| Failure::message("Unable to inspect the current Git repository"))?
                .ok_or_else(|| {
                    Failure::message("The current Location is not inside a Git repository")
                })?;
            if action == "list" {
                self.policy
                    .assert(
                        &context,
                        "worktree",
                        vec![path_text(&repository.worktree).into()],
                        vec!["*".into()],
                        None,
                    )
                    .await
                    .map_err(|_| Failure::message("Unable to list worktrees: permission denied"))?;
                let entries = worktree::list(&self.paths.git, &repository)
                    .map_err(|_| Failure::message("Unable to list repository worktrees"))?;
                let current = std::fs::canonicalize(&self.paths.directory)
                    .map_err(|_| Failure::message("Unable to inspect the current Location"))?;
                let mut items = Vec::new();
                let mut display = Vec::new();
                for entry in entries {
                    let branch = self
                        .paths
                        .git
                        .checked(
                            "branch",
                            &entry.directory,
                            &["branch", "--show-current"],
                            None,
                            None,
                        )
                        .map_err(|_| Failure::message("Unable to list repository worktrees"))?
                        .text()
                        .trim()
                        .to_owned();
                    let branch = (!branch.is_empty()).then_some(branch);
                    let target = path_text(&entry.directory).replace('\\', "/");
                    let is_current = filesystem::contains(&entry.directory, &current);
                    display.push(format!(
                        "{}: {} ({})",
                        if is_current { "Current" } else { "Worktree" },
                        target,
                        branch.as_deref().unwrap_or("detached HEAD")
                    ));
                    let mut item = ObjectEncoder::new().field("path", target.as_str());
                    if let Some(branch) = &branch {
                        item = item.field("branch", branch.as_str());
                    }
                    items.push(item.field("current", &is_current).finish());
                }
                let summary = if display.is_empty() {
                    "No worktrees found".to_owned()
                } else {
                    display.join("\n")
                };
                return Ok(ToolOutput {
                    structured: ObjectEncoder::new()
                        .field("action", "list")
                        .field("worktrees", &items)
                        .finish(),
                    content: vec![ToolContent::Text(ToolTextContent {
                        text: summary.into(),
                    })],
                });
            }
            if action != "create" {
                return Err(Failure::message("Invalid tool input: Invalid action"));
            }
            let name = string(input, "name")?
                .to_utf8()
                .map_err(|_| Failure::message("Invalid tool input: name is not valid Unicode"))?;
            if !worktree::valid_name(&name) {
                return Err(Failure::message("Invalid tool input: Invalid name"));
            }
            let target = worktree::managed_destination(&self.paths.data, &repository, &name)
                .map_err(|_| Failure::message("Unable to create Git worktree"))?;
            let target_text = path_text(&target).replace('\\', "/");
            self.policy
                .assert(
                    &context,
                    "worktree",
                    vec![target_text.clone().into()],
                    vec!["*".into()],
                    None,
                )
                .await
                .map_err(|_| Failure::message("Unable to create worktree: permission denied"))?;
            if target.exists() {
                return Err(Failure::message(format!(
                    "A worktree named {name} already exists"
                )));
            }
            let metadata = match ObjectEncoder::new()
                .field("operation", "create_git_worktree")
                .finish()
            {
                JsonValue::Object(value) => value,
                _ => unreachable!(),
            };
            let reservation = self
                .policy
                .reserve(
                    &context,
                    "file_mutation",
                    vec![target_text.clone().into()],
                    Some(metadata),
                )
                .await
                .map_err(|_| Failure::message("Session guardrail rejected worktree creation"))?;
            let created =
                worktree::create_managed(&self.paths.git, &repository, &self.paths.data, &name);
            reservation.release();
            let created = created.map_err(|error| {
                let message = error.message.to_ascii_lowercase();
                if message.contains("branch") && message.contains("already exists") {
                    return Failure::message(format!("A branch named {name} already exists"));
                }
                if message.contains("already exists") {
                    return Failure::message(format!(
                        "A worktree named {name} already exists at {target_text}"
                    ));
                }
                Failure::message(format!("Unable to create Git worktree: {error}"))
            })?;
            let directory = path_text(&created.worktree).replace('\\', "/");
            Ok(ToolOutput {
                structured: ObjectEncoder::new()
                    .field("action", "create")
                    .field("path", directory.as_str())
                    .field("branch", name.as_str())
                    .finish(),
                content: vec![ToolContent::Text(ToolTextContent {
                    text: format!("Created worktree on branch {name} at {directory}").into(),
                })],
            })
        })
    }
}
