use super::config::{Configuration, Roots};
use std::{
    collections::BTreeMap,
    io,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime},
};
static HELD: LazyLock<Mutex<BTreeMap<PathBuf, usize>>> = LazyLock::new(Mutex::default);

pub struct Hold(PathBuf);
impl Drop for Hold {
    fn drop(&mut self) {
        let mut held = HELD.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(count) = held.get_mut(&self.0) {
            *count -= 1;
            if *count == 0 {
                held.remove(&self.0);
            }
        }
    }
}
use ycoding_ai::llm::ToolOutput;
use ycoding_schema::{
    JsonValue,
    llm::{ToolContent, ToolTextContent},
};
pub struct BoundResult {
    pub output: ToolOutput,
    pub output_paths: Vec<PathBuf>,
}
pub struct Store {
    directory: PathBuf,
}
pub const MAX_LINES: usize = 2000;
pub const MAX_BYTES: usize = 50 * 1024;
pub const RETENTION: Duration = Duration::from_secs(7 * 86400);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_lines: usize,
    pub max_bytes: usize,
}
impl Store {
    pub fn new(roots: &Roots) -> Self {
        Self {
            directory: roots.data.join("tool-output"),
        }
    }
    pub fn hold(&self, path: PathBuf) -> Hold {
        *HELD
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(path.clone())
            .or_default() += 1;
        Hold(path)
    }
    pub fn limits(&self, config: Option<&Configuration>) -> Limits {
        let mut limits = Limits {
            max_lines: MAX_LINES,
            max_bytes: MAX_BYTES,
        };
        if let Some(config) = config {
            for value in config.values("tool_output") {
                let JsonValue::Object(value) = value else {
                    continue;
                };
                if let Some(JsonValue::Number(lines)) = value.get(&"max_lines".into()) {
                    limits.max_lines = *lines as usize;
                }
                if let Some(JsonValue::Number(bytes)) = value.get(&"max_bytes".into()) {
                    limits.max_bytes = *bytes as usize;
                }
            }
        }
        limits
    }
    pub async fn bound(
        &self,
        output: ToolOutput,
        config: Option<&Configuration>,
    ) -> io::Result<BoundResult> {
        use tokio::io::AsyncWriteExt;
        let limits = self.limits(config);
        let contextual = if output.content.is_empty() {
            pretty(&output.structured)
        } else {
            String::from_utf16_lossy(
                &output
                    .content
                    .iter()
                    .flat_map(|item| match item {
                        ToolContent::Text(text) => text.text.code_units().collect::<Vec<_>>(),
                        ToolContent::File(_) => Vec::new(),
                    })
                    .collect::<Vec<_>>(),
            )
        };
        if contextual.split('\n').count() <= limits.max_lines
            && contextual.len() <= limits.max_bytes
        {
            return Ok(BoundResult {
                output,
                output_paths: Vec::new(),
            });
        }
        tokio::fs::create_dir_all(&self.directory).await?;
        let path = self.directory.join(crate::platform::identifier("tool_")?);
        let _held = self.hold(path.clone());
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await?;
        file.write_all(contextual.as_bytes()).await?;
        file.flush().await?;
        let marker = format!(
            "... output truncated; full content saved to {} ...",
            path.display()
        );
        let mut content = vec![ToolContent::Text(ToolTextContent {
            text: bounded_preview(&contextual, &marker, limits).into(),
        })];
        content.extend(
            output
                .content
                .into_iter()
                .filter(|item| matches!(item, ToolContent::File(_))),
        );
        Ok(BoundResult {
            output: ToolOutput {
                structured: output.structured,
                content,
            },
            output_paths: vec![path],
        })
    }
    pub async fn cleanup(&self, now: SystemTime) -> io::Result<()> {
        let mut entries = match tokio::fs::read_dir(&self.directory).await {
            Ok(entries) => entries,
            Err(_) => return Ok(()),
        };
        let cutoff = now.checked_sub(RETENTION).unwrap_or(SystemTime::UNIX_EPOCH);
        while let Ok(Some(entry)) = entries.next_entry().await {
            if !entry.file_name().to_string_lossy().starts_with("tool_") {
                continue;
            }
            let path = entry.path();
            tokio::task::spawn_blocking(move || {
                let held = HELD.lock().unwrap_or_else(|error| error.into_inner());
                if held.contains_key(&path) {
                    return;
                }
                if std::fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .is_ok_and(|modified| modified < cutoff)
                {
                    let _ = std::fs::remove_file(&path);
                }
            })
            .await
            .map_err(io::Error::other)?;
        }
        Ok(())
    }
}

fn prefix(text: &str, bytes: usize) -> &str {
    let mut end = bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
fn suffix(text: &str, bytes: usize) -> &str {
    let mut start = text.len().saturating_sub(bytes);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}
fn bounded_preview(text: &str, marker: &str, limits: Limits) -> String {
    if limits.max_lines <= 4 || limits.max_bytes <= marker.len() + 4 {
        return prefix(marker, limits.max_bytes)
            .split('\n')
            .take(limits.max_lines)
            .collect::<Vec<_>>()
            .join("\n");
    }
    let max_lines = limits.max_lines - 4;
    let max_bytes = limits.max_bytes - marker.len() - 4;
    let lines: Vec<_> = text.split('\n').collect();
    let head_lines = max_lines.div_ceil(2);
    let tail_lines = max_lines / 2;
    let (head, tail) = if lines.len() <= max_lines {
        (text.to_owned(), String::new())
    } else {
        (
            lines[..head_lines].join("\n"),
            lines[lines.len() - tail_lines..].join("\n"),
        )
    };
    let sampled = if tail_lines > 0 && lines.len() > max_lines {
        format!("{head}\n{tail}")
    } else {
        head.clone()
    };
    let (head, tail) = if sampled.len() > max_bytes {
        (
            prefix(&sampled, max_bytes.div_ceil(2)).to_owned(),
            suffix(&sampled, max_bytes / 2).to_owned(),
        )
    } else {
        (head, tail)
    };
    if tail.is_empty() {
        return format!("{head}\n\n{marker}");
    }
    format!("{head}\n\n{marker}\n\n{tail}")
}

fn pretty(value: &JsonValue) -> String {
    let compact = ycoding_schema::stringify_json(value);
    let mut result = String::new();
    let mut string = false;
    let mut escape = false;
    let mut depth: usize = 0;
    let mut chars = compact.chars().peekable();
    while let Some(character) = chars.next() {
        if string {
            result.push(character);
            if escape {
                escape = false;
                continue;
            }
            if character == '\\' {
                escape = true;
                continue;
            }
            if character == '"' {
                string = false;
            }
            continue;
        }
        match character {
            '"' => {
                string = true;
                result.push(character);
            }
            '[' | '{' => {
                result.push(character);
                if chars
                    .peek()
                    .is_some_and(|next| *next == ']' || *next == '}')
                {
                    result.push(chars.next().expect("peeked closing delimiter"));
                    continue;
                }
                depth += 1;
                result.push('\n');
                result.push_str(&"  ".repeat(depth));
            }
            ']' | '}' => {
                depth -= 1;
                result.push('\n');
                result.push_str(&"  ".repeat(depth));
                result.push(character);
            }
            ',' => {
                result.push_str(",\n");
                result.push_str(&"  ".repeat(depth));
            }
            ':' => result.push_str(": "),
            character => result.push(character),
        }
    }
    result
}
