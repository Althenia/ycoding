use super::filesystem::{object, optional_number, utf8};
use crate::{
    platform::filesystem::{self, search},
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    DomainEncode, JsonObject, JsonValue,
    filesystem::Entry,
    llm::{ToolContent, ToolTextContent},
    parse_json,
    schema::RelativePath,
};

#[derive(Clone, Copy)]
pub enum Kind {
    Glob,
    Grep,
}
pub struct Search {
    pub kind: Kind,
    pub directory: PathBuf,
    pub data: PathBuf,
    pub service: Arc<search::Service>,
    pub ripgrep: PathBuf,
    pub policy: Arc<LeafPolicy>,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Glob => "glob",
            Self::Grep => "grep",
        }
    }
}
impl Tool for Search {
    fn definition(&self, name: &str) -> ToolDefinition {
        let grep = matches!(self.kind, Kind::Grep);
        let input = if grep {
            r#"{"type":"object","properties":{"pattern":{"type":"string","description":"Regex pattern to search for in file contents"},"path":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Relative directory to search. Defaults to the active Location."},"include":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"File glob to include in the search (for example, \"*.js\" or \"*.{ts,tsx}\")"},"limit":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0}]},{"type":"null"}],"description":"Maximum matches to return (default: 100)"}},"required":["pattern"],"additionalProperties":false}"#
        } else {
            r#"{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern to match files against"},"path":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Relative directory to search. Defaults to the active Location."},"limit":{"anyOf":[{"type":"integer","allOf":[{"exclusiveMinimum":0}]},{"type":"null"}],"description":"Maximum results to return (default: 100)"}},"required":["pattern"],"additionalProperties":false}"#
        };
        let output = if grep {
            r##"{"type":"array","items":{"$ref":"#/$defs/FileSystem.Match"},"$defs":{"FileSystem.Entry":{"type":"object","properties":{"path":{"type":"string"},"type":{"type":"string","enum":["file","directory"]}},"required":["path","type"],"additionalProperties":false},"FileSystem.Submatch":{"type":"object","properties":{"text":{"type":"string"},"start":{"type":"integer","allOf":[{"minimum":0}]},"end":{"type":"integer","allOf":[{"minimum":0}]}},"required":["text","start","end"],"additionalProperties":false},"FileSystem.Match":{"type":"object","properties":{"entry":{"$ref":"#/$defs/FileSystem.Entry"},"line":{"type":"integer","allOf":[{"exclusiveMinimum":0}]},"offset":{"type":"integer","allOf":[{"minimum":0}]},"text":{"type":"string"},"submatches":{"type":"array","items":{"$ref":"#/$defs/FileSystem.Submatch"}}},"required":["entry","line","offset","text","submatches"],"additionalProperties":false}}}"##
        } else {
            r##"{"type":"array","items":{"$ref":"#/$defs/FileSystem.Entry"},"$defs":{"FileSystem.Entry":{"type":"object","properties":{"path":{"type":"string"},"type":{"type":"string","enum":["file","directory"]}},"required":["path","type"],"additionalProperties":false}}}"##
        };
        ToolDefinition { name: name.into(), description: if grep { "Search file contents by regular expression within the active Location or an absolute managed tool-output file. A matching file needs read permission before its text is returned. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews." } else { "Find files by glob pattern within the active Location. Returns concise relative file resources. Use a relative path to narrow the search and limit to bound the result count." }.into(), input_schema: parse_json(input).unwrap(), output_schema: Some(parse_json(output).unwrap()), cache: None, metadata: None, native: None }
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = object(&input)?;
            let pattern = utf8(input, "pattern")?;
            let path = if input.get(&"path".into()).is_some() {
                Some(utf8(input, "path")?)
            } else {
                None
            };
            let include = if input.get(&"include".into()).is_some() {
                Some(utf8(input, "include")?)
            } else {
                None
            };
            let limit = optional_number(input, "limit", 1.0, f64::MAX)?.map(|value| value as usize);
            let mut metadata = JsonObject::new();
            metadata.insert(
                "root".into(),
                JsonValue::String(
                    if matches!(self.kind, Kind::Glob) {
                        path.as_deref().unwrap_or(".")
                    } else {
                        "."
                    }
                    .into(),
                ),
            );
            for key in ["path", "limit", "include"] {
                if let Some(value) = input.get(&key.into()) {
                    metadata.insert(key.into(), value.clone());
                }
            }
            self.policy
                .assert(
                    &context,
                    self.kind.name(),
                    vec![pattern.clone().into()],
                    vec!["*".into()],
                    Some(metadata),
                )
                .await
                .map_err(|error| self.failure(&pattern, error))?;
            let target =
                filesystem::normalize(&self.directory.join(path.as_deref().unwrap_or(".")));
            let info = fs::metadata(&target).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Failure::message(format!(
                        "Search path does not exist: {}",
                        path.as_deref().unwrap_or(".")
                    ))
                } else {
                    self.failure(&pattern, Failure::message(error.to_string()))
                }
            })?;
            let root = fs::canonicalize(&self.directory)
                .map_err(|error| self.failure(&pattern, Failure::message(error.to_string())))?;
            let resolved = fs::canonicalize(&target)
                .map_err(|error| self.failure(&pattern, Failure::message(error.to_string())))?;
            let filename = resolved
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            let managed = matches!(self.kind, Kind::Grep)
                && path
                    .as_ref()
                    .is_some_and(|path| Path::new(path).is_absolute())
                && info.is_file()
                && fs::canonicalize(&self.data).is_ok_and(|data| {
                    resolved.parent() == Some(data.join("tool-output").as_path())
                })
                && managed_name(filename);
            if !filesystem::contains(&root, &resolved) && !managed {
                return Err(Failure::message("Search path escapes the active Location"));
            }
            if matches!(self.kind, Kind::Glob) {
                let entries = self
                    .service
                    .glob(&search::GlobInput {
                        pattern: pattern.clone(),
                        path,
                        limit: Some(limit.unwrap_or(100)),
                    })
                    .map_err(|error| self.failure(&pattern, Failure::message(error.to_string())))?;
                let text = if entries.is_empty() {
                    "No files found".into()
                } else {
                    entries
                        .iter()
                        .map(|entry| {
                            self.directory
                                .join(entry.path.as_lossless().as_str().unwrap())
                                .to_string_lossy()
                                .into_owned()
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                return Ok(ToolOutput {
                    structured: entries.encode(),
                    content: vec![ToolContent::Text(ToolTextContent { text: text.into() })],
                });
            }
            let mut authorized = HashSet::new();
            if info.is_file() {
                self.authorize(
                    &resolved,
                    &root,
                    managed,
                    &resolved,
                    &context,
                    &mut authorized,
                )
                .await
                .map_err(|error| self.failure(&pattern, error))?;
            }
            let external;
            let (service, search_path, source) = if managed {
                let parent = resolved.parent().unwrap();
                external = search::Service::new(
                    parent,
                    search::Backend::Ripgrep {
                        binary: self.ripgrep.clone(),
                    },
                )
                .map_err(|error| self.failure(&pattern, Failure::message(error.to_string())))?;
                (&external, Some(filename.into()), parent)
            } else {
                (self.service.as_ref(), path, root.as_path())
            };
            let mut matches = service
                .grep(&search::GrepInput {
                    pattern: pattern.clone(),
                    path: search_path,
                    include,
                    limit: Some(limit.unwrap_or(100)),
                })
                .map_err(|error| self.failure(&pattern, Failure::message(error.to_string())))?;
            for matched in &mut matches {
                let absolute = source.join(matched.entry.path.as_lossless().as_str().unwrap());
                self.authorize(
                    &absolute,
                    &root,
                    managed,
                    &resolved,
                    &context,
                    &mut authorized,
                )
                .await
                .map_err(|error| self.failure(&pattern, error))?;
                if managed {
                    matched.entry = Entry {
                        path: RelativePath::new(relative(&self.directory, &absolute))
                            .map_err(|error| Failure::Defect(error.to_string()))?,
                        r#type: matched.entry.r#type,
                    };
                }
            }
            let mut lines = vec![if matches.is_empty() {
                "No files found".into()
            } else {
                format!("Found {} matches", matches.len())
            }];
            let mut current = String::new();
            for matched in &matches {
                let path = filesystem::normalize(
                    &self
                        .directory
                        .join(matched.entry.path.as_lossless().as_str().unwrap()),
                )
                .to_string_lossy()
                .into_owned();
                if current != path {
                    if !current.is_empty() {
                        lines.push(String::new());
                    }
                    current = path;
                    lines.push(format!("{current}:"));
                }
                lines.push(format!(
                    "  Line {}: {}",
                    matched.line.get(),
                    String::from_utf16_lossy(&matched.text.code_units().collect::<Vec<_>>())
                ));
            }
            Ok(ToolOutput {
                structured: matches.encode(),
                content: vec![ToolContent::Text(ToolTextContent {
                    text: lines.join("\n").into(),
                })],
            })
        })
    }
}
impl Search {
    fn failure(&self, pattern: &str, error: Failure) -> Failure {
        match error {
            Failure::Cancelled | Failure::Defect(_) => error,
            _ => Failure::message(match self.kind {
                Kind::Glob => format!("Unable to find files matching {pattern}"),
                Kind::Grep => format!("Unable to grep for {pattern}"),
            }),
        }
    }
    async fn authorize(
        &self,
        file: &Path,
        root: &Path,
        managed: bool,
        resolved: &Path,
        context: &Context,
        authorized: &mut HashSet<PathBuf>,
    ) -> Result<(), Failure> {
        let canonical =
            fs::canonicalize(file).map_err(|error| Failure::message(error.to_string()))?;
        if !filesystem::contains(root, &canonical) && !(managed && canonical == resolved) {
            return Err(Failure::message(
                "Search result escapes the active Location",
            ));
        }
        let resource = if filesystem::contains(root, &canonical) {
            canonical
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        } else {
            canonical.to_string_lossy().replace('\\', "/")
        };
        if authorized.insert(canonical) {
            self.policy
                .assert(
                    context,
                    "read",
                    vec![resource.into()],
                    vec!["*".into()],
                    None,
                )
                .await?;
        }
        Ok(())
    }
}
fn managed_name(name: &str) -> bool {
    name.len() == 31
        && name.starts_with("tool_")
        && name.as_bytes()[5..17].iter().all(u8::is_ascii_hexdigit)
        && name.as_bytes()[17..].iter().all(u8::is_ascii_alphanumeric)
        && !name.as_bytes()[5..17].iter().any(u8::is_ascii_uppercase)
}
fn relative(from: &Path, to: &Path) -> String {
    let from = from.components().collect::<Vec<_>>();
    let to = to.components().collect::<Vec<_>>();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    std::iter::repeat_n("..".to_owned(), from.len() - common)
        .chain(
            to[common..]
                .iter()
                .map(|part| part.as_os_str().to_string_lossy().into_owned()),
        )
        .collect::<Vec<_>>()
        .join(std::path::MAIN_SEPARATOR_STR)
}
