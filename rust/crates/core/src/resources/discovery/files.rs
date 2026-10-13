use super::{Diagnostic, Error, absolute, io, markdown, read_text, trim};
use crate::resources::config::{self, Entry};
use std::path::{Path, PathBuf};
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Agent,
    Command,
    Skill,
}
pub fn scan(directory: &Path, kind: Kind) -> Result<Vec<PathBuf>, Error> {
    let directory = absolute(directory)?;
    let mut files = Vec::new();
    match kind {
        Kind::Agent | Kind::Command => {
            let names = if kind == Kind::Agent {
                ["agent", "agents"]
            } else {
                ["command", "commands"]
            };
            for name in names {
                walk(
                    &directory.join(name),
                    &directory,
                    kind,
                    &mut Vec::new(),
                    &mut files,
                )?;
            }
        }
        Kind::Skill => walk(&directory, &directory, kind, &mut Vec::new(), &mut files)?,
    }
    files.sort_by(|a, b| {
        a.as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .cmp(b.as_os_str().to_string_lossy().encode_utf16())
    });
    Ok(files)
}
fn walk(
    directory: &Path,
    root: &Path,
    kind: Kind,
    ancestors: &mut Vec<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> Result<(), Error> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io(directory, e)),
    };
    let canonical = std::fs::canonicalize(directory).map_err(|e| io(directory, e))?;
    if ancestors.contains(&canonical) {
        return Ok(());
    }
    ancestors.push(canonical);
    for entry in entries {
        let entry = entry.map_err(|e| io(directory, e))?;
        let path = entry.path();
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io(&path, e)),
        };
        if metadata.is_dir() {
            walk(&path, root, kind, ancestors, files)?;
            continue;
        }
        let matched = path.extension().is_some_and(|e| e == "md")
            && (kind != Kind::Skill
                || path.parent() == Some(root)
                || path.file_name().is_some_and(|s| s == "SKILL.md"));
        if metadata.is_file() && matched {
            files.push(path);
        }
    }
    ancestors.pop();
    Ok(())
}
pub(crate) fn documents(
    entries: &[Entry],
    kind: Kind,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<Entry> {
    let mut documents = Vec::new();
    for entry in entries {
        let directory = match entry {
            Entry::Document { .. } => {
                documents.push(entry.clone());
                continue;
            }
            Entry::Directory(path) => path,
            _ => continue,
        };
        let files = match scan(directory, kind) {
            Ok(files) => files,
            Err(e) => {
                diagnostics.push(Diagnostic {
                    path: directory.display().to_string(),
                    reason: "unavailable".into(),
                    message: e.to_string(),
                });
                continue;
            }
        };
        let mut loaded: Vec<(LosslessString, Entry)> = Vec::new();
        for filepath in files {
            let read = || -> Result<Option<(LosslessString, Entry)>, String> {
                let Some(content) = read_text(&filepath).map_err(|e| e.to_string())? else {
                    return Ok(None);
                };
                if kind == Kind::Agent && content.is_empty() {
                    return Ok(None);
                }
                let parsed = markdown::parse(&content).map_err(|e| e.to_string())?;
                let fields = if kind == Kind::Agent {
                    &[
                        "model",
                        "request",
                        "description",
                        "mode",
                        "hidden",
                        "color",
                        "steps",
                        "disabled",
                        "permissions",
                    ][..]
                } else {
                    &["description", "agent", "model", "subtask"][..]
                };
                let mut info = parsed.data.fields(fields).map_err(|e| e.to_string())?;
                info.insert(
                    if kind == Kind::Agent {
                        "system".into()
                    } else {
                        "template".into()
                    },
                    JsonValue::String(trim(&parsed.content).into()),
                );
                let relative = filepath
                    .strip_prefix(directory)
                    .map_err(|e| e.to_string())?;
                let mut parts = relative.components();
                parts.next();
                let name = parts
                    .as_path()
                    .to_str()
                    .ok_or("Resource filename is not valid Unicode")?
                    .replace('\\', "/");
                let name = LosslessString::from(name.strip_suffix(".md").unwrap_or(&name));
                let mut named = JsonObject::new();
                named.insert(name.clone(), JsonValue::Object(info));
                let mut doc = JsonObject::new();
                doc.insert(
                    if kind == Kind::Agent {
                        "agents".into()
                    } else {
                        "commands".into()
                    },
                    JsonValue::Object(named),
                );
                let decoded = config::decode_document(
                    &config_text(&JsonValue::Object(doc)),
                    filepath
                        .to_str()
                        .ok_or("Resource filename is not valid Unicode")?,
                );
                if decoded
                    .diagnostics
                    .iter()
                    .any(|d| d.reason.0 != "removed-keys".into() || d.fail_closed == Some(true))
                {
                    return Err("Invalid frontmatter fields; resource was not loaded".into());
                }
                let Some(info) = decoded.info else {
                    return Err("Invalid frontmatter fields; resource was not loaded".into());
                };
                Ok(Some((
                    name,
                    Entry::Document {
                        path: Some(filepath.clone()),
                        info,
                    },
                )))
            };
            match read() {
                Ok(Some((name, document))) => {
                    if kind == Kind::Command
                        && let Some((_, current)) = loaded.iter_mut().find(|(key, _)| key == &name)
                    {
                        *current = document;
                        continue;
                    }
                    loaded.push((name, document));
                }
                Ok(None) => {}
                Err(message) => diagnostics.push(Diagnostic {
                    path: filepath.display().to_string(),
                    reason: "invalid-frontmatter".into(),
                    message,
                }),
            }
        }
        documents.extend(loaded.into_iter().map(|(_, e)| e));
    }
    documents
}

fn config_text(value: &JsonValue) -> String {
    match value {
        JsonValue::Number(value) if *value == 0.0 && value.is_sign_negative() => "-0".into(),
        JsonValue::Array(values) => format!(
            "[{}]",
            values.iter().map(config_text).collect::<Vec<_>>().join(",")
        ),
        JsonValue::Object(object) => format!(
            "{{{}}}",
            object
                .iter()
                .map(|(key, value)| format!(
                    "{}:{}",
                    ycoding_schema::stringify_json(&JsonValue::String(key.clone())),
                    config_text(value)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        value => ycoding_schema::stringify_json(value),
    }
}
