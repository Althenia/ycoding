use super::filesystem::{self, object, utf8};
use crate::{
    platform::{
        diff::{create_two_files_patch, diff_lines},
        filesystem::mutation,
        patch::{self as engine, Hunk},
    },
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::{collections::HashSet, sync::Arc};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    JsonValue, ObjectEncoder,
    llm::{ToolContent, ToolTextContent},
    parse_json,
};

const DESCRIPTION: &str = include_str!("patch.txt");

pub struct Patch {
    pub paths: Arc<filesystem::Paths>,
    pub files: Arc<mutation::Service>,
    pub policy: Arc<LeafPolicy>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Add,
    Update,
    Delete,
}

struct Target {
    mutation: mutation::Target,
}

struct Prepared {
    kind: Kind,
    path: String,
    target: Target,
    move_target: Option<Target>,
    before: String,
    after: String,
    content: Vec<u8>,
    expected: Option<Vec<u8>>,
}

struct FileInfo {
    file: String,
    patch: String,
    additions: usize,
    deletions: usize,
    status: &'static str,
}

struct Applied {
    kind: Kind,
    resource: String,
    target: String,
}

impl Tool for Patch {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: DESCRIPTION.into(),
            input_schema: parse_json(r#"{"type":"object","properties":{"patchText":{"type":"string","description":"The full patch text describing add, update, and delete operations"}},"required":["patchText"],"additionalProperties":false}"#).unwrap(),
            output_schema: Some(parse_json(r#"{"type":"object","properties":{"applied":{"type":"array","items":{"type":"object","properties":{"type":{"type":"string","enum":["add","update","delete"]},"resource":{"type":"string"},"target":{"type":"string"}},"required":["type","resource","target"],"additionalProperties":false}},"files":{"type":"array","items":{"type":"object","properties":{"file":{"type":"string"},"patch":{"type":"string"},"additions":{"type":"integer","minimum":0},"deletions":{"type":"integer","minimum":0},"status":{"type":"string","enum":["added","deleted","modified"]}},"required":["file","patch","additions","deletions","status"],"additionalProperties":false}}},"required":["applied","files"],"additionalProperties":false}"#).unwrap()),
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
            let patch_text = utf8(input, "patchText")?;
            if patch_text.is_empty() {
                return Err(Failure::message("patchText is required"));
            }
            let hunks = engine::parse(&patch_text)
                .map_err(|error| Failure::message(format!("patch verification failed: {error}")))?;
            if hunks.is_empty() {
                let normalized = patch_text
                    .replace("\r\n", "\n")
                    .replace('\r', "\n")
                    .trim()
                    .to_owned();
                return Err(Failure::message(
                    if normalized == "*** Begin Patch\n*** End Patch" {
                        "patch rejected: empty patch"
                    } else {
                        "patch verification failed: no hunks found"
                    },
                ));
            }
            let mut prepared = Vec::new();
            let mut targets = Vec::new();
            for hunk in hunks {
                let path = hunk_path(&hunk).to_owned();
                match self.prepare(hunk, &context).await {
                    Ok((change, target)) => {
                        targets.push(target);
                        prepared.push(change);
                    }
                    Err(error) => return Err(failure(&[], &path, Some(error))),
                }
            }
            let files = prepared.iter().map(file_info).collect::<Vec<_>>();
            let file_values = files.iter().map(FileInfo::value).collect::<Vec<_>>();
            let mut resource_set = HashSet::new();
            let resources = targets
                .iter()
                .map(|target| target.resource.clone())
                .filter(|resource| resource_set.insert(resource.clone()));
            let resources = resources.collect::<Vec<_>>();
            let diff = files
                .iter()
                .map(|file| format!("{}\n", file.patch))
                .collect::<String>();
            let filepath = targets
                .iter()
                .map(|target| target.resource.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let metadata = match ObjectEncoder::new()
                .field("filepath", filepath.as_str())
                .field("diff", diff.as_str())
                .field("files", &file_values)
                .finish()
            {
                JsonValue::Object(value) => value,
                _ => unreachable!(),
            };
            self.policy
                .assert(
                    &context,
                    "edit",
                    resources
                        .iter()
                        .map(|resource| resource.as_str().into())
                        .collect(),
                    vec!["*".into()],
                    Some(metadata),
                )
                .await
                .map_err(|error| failure(&[], "patch", Some(error)))?;
            let mut canonical_set = HashSet::new();
            let canonical = targets
                .iter()
                .map(|target| target.canonical.to_string_lossy().into_owned())
                .filter(|path| canonical_set.insert(path.clone()))
                .collect::<Vec<_>>();
            let metadata = match ObjectEncoder::new().field("operation", "patch").finish() {
                JsonValue::Object(value) => value,
                _ => unreachable!(),
            };
            let reservation = self
                .policy
                .reserve(
                    &context,
                    "file_mutation",
                    canonical.iter().map(|path| path.as_str().into()).collect(),
                    Some(metadata),
                )
                .await
                .map_err(|error| failure(&[], "patch", Some(error)))?;
            let mut applied = Vec::new();
            for change in &prepared {
                if let Err(error) = self.apply(change).await {
                    reservation.release();
                    return Err(failure(&applied, &change.path, Some(error)));
                }
                let target = if change.kind == Kind::Update {
                    change.move_target.as_ref().unwrap_or(&change.target)
                } else {
                    &change.target
                };
                applied.push(Applied {
                    kind: change.kind,
                    resource: target.mutation.resource.clone(),
                    target: target.mutation.canonical.to_string_lossy().into_owned(),
                });
            }
            reservation.release();
            let applied_values = applied.iter().map(Applied::value).collect::<Vec<_>>();
            let text = applied
                .iter()
                .map(|item| {
                    format!(
                        "{} {}",
                        match item.kind {
                            Kind::Add => "A",
                            Kind::Update => "M",
                            Kind::Delete => "D",
                        },
                        item.resource
                    )
                })
                .collect::<Vec<_>>();
            Ok(ToolOutput {
                structured: ObjectEncoder::new()
                    .field("applied", &applied_values)
                    .field("files", &file_values)
                    .finish(),
                content: vec![ToolContent::Text(ToolTextContent {
                    text: format!("Success. Updated the following files:\n{}", text.join("\n"))
                        .into(),
                })],
            })
        })
    }
}

impl Patch {
    async fn prepare(
        &self,
        hunk: Hunk,
        context: &Context,
    ) -> Result<(Prepared, mutation::Target), Failure> {
        let path = hunk_path(&hunk).to_owned();
        let target = self.resolve(&path, context).await?;
        let permission_target = target.mutation.clone();
        let mut move_target = None;
        let (kind, before, after, content, expected) = match hunk {
            Hunk::Add { contents, .. } => {
                let contents = if contents.ends_with('\n') || contents.is_empty() {
                    contents
                } else {
                    format!("{contents}\n")
                };
                let contents = contents
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&contents)
                    .to_owned();
                (
                    Kind::Add,
                    String::new(),
                    contents.clone(),
                    contents.into_bytes(),
                    None,
                )
            }
            Hunk::Delete { .. } => {
                let raw = std::fs::read(&target.mutation.canonical).map_err(|error| {
                    Failure::message(format!("patch verification failed: {error}"))
                })?;
                let original = String::from_utf8_lossy(&raw);
                (
                    Kind::Delete,
                    original
                        .strip_prefix('\u{feff}')
                        .unwrap_or(&original)
                        .to_owned(),
                    String::new(),
                    Vec::new(),
                    None,
                )
            }
            Hunk::Update {
                move_path, chunks, ..
            } => {
                let raw = std::fs::read(&target.mutation.canonical).map_err(|_| {
                    Failure::message(format!(
                        "patch verification failed: Failed to read file to update: {}",
                        target.mutation.canonical.display()
                    ))
                })?;
                let original = String::from_utf8_lossy(&raw);
                let before = original
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&original)
                    .to_owned();
                let update = engine::derive(&path, &chunks, &original).map_err(|error| {
                    Failure::message(format!("patch verification failed: {error}"))
                })?;
                if let Some(move_path) = move_path {
                    move_target = Some(self.resolve(&move_path, context).await?);
                }
                let content = engine::join_bom(&update.content, update.bom).into_bytes();
                (Kind::Update, before, update.content, content, Some(raw))
            }
        };
        Ok((
            Prepared {
                kind,
                path,
                target,
                move_target,
                before,
                after,
                content,
                expected,
            },
            permission_target,
        ))
    }

    async fn resolve(&self, path: &str, context: &Context) -> Result<Target, Failure> {
        let lexical = crate::platform::filesystem::normalize(&self.paths.directory.join(path));
        if std::fs::symlink_metadata(&lexical)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
            && crate::platform::filesystem::contains(&self.paths.directory, &lexical)
        {
            let resource = lexical
                .strip_prefix(&self.paths.directory)
                .map_err(|error| Failure::message(format!("patch verification failed: {error}")))?
                .to_string_lossy()
                .replace('\\', "/");
            return Ok(Target {
                mutation: mutation::Target::new(lexical, resource),
            });
        }
        let target = self
            .paths
            .resolve(path, false)
            .map_err(|error| Failure::message(format!("patch verification failed: {error}")))?;
        if let Some((resource, save)) = &target.external {
            let metadata = match ObjectEncoder::new()
                .field(
                    "filepath",
                    target.mutation.canonical.to_string_lossy().as_ref(),
                )
                .field("parentDir", resource.trim_end_matches("/*"))
                .finish()
            {
                JsonValue::Object(value) => value,
                _ => unreachable!(),
            };
            self.policy
                .assert(
                    context,
                    "external_directory",
                    vec![resource.as_str().into()],
                    vec![save.as_str().into()],
                    Some(metadata),
                )
                .await?;
        }
        Ok(Target {
            mutation: target.mutation,
        })
    }

    async fn apply(&self, change: &Prepared) -> Result<(), Failure> {
        match change.kind {
            Kind::Add => self
                .files
                .write(&change.target.mutation, &change.content)
                .map(|_| ())
                .map_err(|error| Failure::message(error.to_string())),
            Kind::Delete => self
                .files
                .remove(&change.target.mutation)
                .map(|_| ())
                .map_err(|error| Failure::message(error.to_string())),
            Kind::Update => {
                if let Some(move_target) = &change.move_target {
                    self.files
                        .write(&move_target.mutation, &change.content)
                        .map_err(|error| Failure::message(error.to_string()))?;
                    self.files
                        .remove(&change.target.mutation)
                        .map_err(|error| Failure::message(error.to_string()))?;
                    return Ok(());
                }
                let Some(expected) = &change.expected else {
                    return Err(Failure::Defect(
                        "Update patch has no source snapshot".into(),
                    ));
                };
                self.files
                    .write_if_unchanged(&change.target.mutation, expected, &change.content)
                    .map(|_| ())
                    .map_err(|error| Failure::message(error.to_string()))
            }
        }
    }
}

impl FileInfo {
    fn value(&self) -> JsonValue {
        ObjectEncoder::new()
            .field("file", self.file.as_str())
            .field("patch", self.patch.as_str())
            .field("additions", &(self.additions as f64))
            .field("deletions", &(self.deletions as f64))
            .field("status", self.status)
            .finish()
    }
}

impl Applied {
    fn value(&self) -> JsonValue {
        ObjectEncoder::new()
            .field(
                "type",
                match self.kind {
                    Kind::Add => "add",
                    Kind::Update => "update",
                    Kind::Delete => "delete",
                },
            )
            .field("resource", self.resource.as_str())
            .field("target", self.target.as_str())
            .finish()
    }
}

fn hunk_path(hunk: &Hunk) -> &str {
    match hunk {
        Hunk::Add { path, .. } | Hunk::Delete { path } | Hunk::Update { path, .. } => path,
    }
}

fn file_info(change: &Prepared) -> FileInfo {
    let target = if change.kind == Kind::Update {
        change.move_target.as_ref().unwrap_or(&change.target)
    } else {
        &change.target
    };
    let path = change.target.mutation.canonical.to_string_lossy();
    let patch = trim_diff(&create_two_files_patch(
        &path,
        &path,
        &change.before,
        &change.after,
    ));
    let (additions, deletions) = if change.kind == Kind::Delete {
        (0, change.before.split('\n').count())
    } else {
        let changes = diff_lines(&change.before, &change.after);
        (
            changes
                .iter()
                .filter(|change| change.added)
                .map(|change| change.count)
                .sum(),
            changes
                .iter()
                .filter(|change| change.removed)
                .map(|change| change.count)
                .sum(),
        )
    };
    FileInfo {
        file: target.mutation.resource.clone(),
        patch,
        additions,
        deletions,
        status: match change.kind {
            Kind::Add => "added",
            Kind::Update => "modified",
            Kind::Delete => "deleted",
        },
    }
}

fn trim_diff(diff: &str) -> String {
    let lines = diff.split('\n').collect::<Vec<_>>();
    let content = lines
        .iter()
        .filter(|line| is_content_line(line))
        .collect::<Vec<_>>();
    if content.is_empty() {
        return diff.to_owned();
    }
    let indent = content
        .iter()
        .filter_map(|line| {
            let value = &line[1..];
            if value.trim().is_empty() {
                return None;
            }
            Some(
                value
                    .chars()
                    .take_while(|character| character.is_whitespace())
                    .count(),
            )
        })
        .min();
    let Some(indent) = indent.filter(|indent| *indent != 0) else {
        return diff.to_owned();
    };
    lines
        .iter()
        .map(|line| {
            if !is_content_line(line) {
                return (*line).to_owned();
            }
            let value = &line[1..];
            let byte_indent = value
                .char_indices()
                .take_while(|(_, character)| character.is_whitespace())
                .nth(indent - 1)
                .map_or(0, |(index, character)| index + character.len_utf8());
            format!("{}{}", &line[..1], &value[byte_indent..])
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_content_line(line: &str) -> bool {
    line.starts_with(['+', '-', ' ']) && !line.starts_with("---") && !line.starts_with("+++")
}

fn failure(applied: &[Applied], path: &str, error: Option<Failure>) -> Failure {
    if matches!(
        error.as_ref(),
        Some(Failure::Cancelled | Failure::Defect(_))
    ) {
        return error.unwrap();
    }
    let prefix = if applied.is_empty() {
        format!("Unable to apply patch at {path}")
    } else {
        format!(
            "Patch partially applied before failing at {path}. Applied: {}",
            applied
                .iter()
                .map(|item| item.resource.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    Failure::message(match error {
        Some(Failure::Tool { message, .. }) => format!("{prefix}: {message}"),
        Some(error) => format!("{prefix}: {error:?}"),
        None => prefix,
    })
}
