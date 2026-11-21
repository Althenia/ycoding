use crate::resources::{
    config::Entry,
    discovery::{self, Error},
};
use std::path::Path;
use ycoding_schema::{
    JsonValue, LosslessString,
    schema::AbsolutePath,
    skill::{EmbeddedSource, Info, Source},
};

pub fn sources(
    entries: &[Entry],
    directory: &Path,
    env: impl Fn(&str) -> Option<String>,
) -> Result<Vec<Source>, Error> {
    Ok(vec![
        embedded(
            "ycoding",
            "YCoding",
            "Use this skill for questions about YCoding behavior, configuration, troubleshooting, plugins, hooks, Clients, Server, API, agents, commands, skills, tools, permissions, MCP, providers, models, themes, keymaps, the CLI, the TUI, and contributing to this repository.",
            None,
            include_str!("ycoding.md").into(),
        )?,
        embedded(
            "chatgpt-connectors",
            "ChatGPT connectors",
            "Use when a YCoding Session needs ChatGPT account connector tools (tools.chatgpt.*): finding which connectors are available, calling them in Code Mode, handling their permissions and failures, or moving files through ChatGPT Library. Do not use for ChatGPT tasks that operate YCoding or for local YCoding operations.",
            None,
            include_str!("chatgpt-connectors.md").into(),
        )?,
        embedded(
            "browser-use",
            "Browser use",
            "Use when a task needs the interaction tool to operate a Chrome tab: clicking, typing, or navigating a live page the user authorized, or working in a new YCoding-owned tab. Do not use for fetching or searching web content, or for coding tasks.",
            None,
            include_str!("browser-use.md").into(),
        )?,
        embedded(
            "computer-use",
            "Computer use",
            "Use when a task needs the interaction tool to operate a macOS application window in the background: reading or clicking its controls on the user's Mac. Do not use for web pages in Chrome, shell work, or coding tasks.",
            None,
            include_str!("computer-use.md").into(),
        )?,
        embedded(
            "report",
            "Report",
            "Use when the user wants to report a YCoding issue or bug. Collect standard diagnostics, add reproduction context, and publish the issue with the GitHub CLI.",
            Some(true),
            report(entries, directory, env),
        )?,
    ])
}

fn embedded(
    id: &str,
    name: &str,
    description: &str,
    slash: Option<bool>,
    content: LosslessString,
) -> Result<Source, Error> {
    Ok(Source::Embedded(EmbeddedSource {
        skill: Info {
            id: id.into(),
            name: name.into(),
            description: Some(description.into()),
            slash,
            autoinvoke: None,
            conflicts: None,
            location: AbsolutePath::new(format!("/builtin/{id}.md"))?,
            content,
        },
    }))
}

fn report(
    entries: &[Entry],
    directory: &Path,
    env: impl Fn(&str) -> Option<String>,
) -> LosslessString {
    let plugins = plugins(entries, directory);
    let terminal = ["TERM_PROGRAM", "TERM", "COLORTERM"]
        .into_iter()
        .filter_map(|key| {
            env(key)
                .filter(|value| !value.is_empty())
                .map(|value| format!("{key}={value}"))
        })
        .collect::<Vec<_>>()
        .join(", ");
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        other => other,
    };
    let system = match system() {
        Some((name, release)) => format!("{name} {release} ({platform} {arch})"),
        None => {
            format!("Unavailable: operating system release is not reported ({platform} {arch})")
        }
    };
    discovery::join(
        &[
            include_str!("report.md").into(),
            "".into(),
            "## Runtime Diagnostics Snapshot".into(),
            "".into(),
            "These values were captured when the built-in report skill was registered. Verify them before publishing.".into(),
            "".into(),
            format!(
                "- ycoding version: {}",
                env("YCODING_VERSION")
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| env!("CARGO_PKG_VERSION").into())
            )
            .into(),
            format!(
                "- install/channel: {}",
                env("YCODING_CHANNEL")
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "local".into())
            )
            .into(),
            format!("- OS: {system}").into(),
            format!(
                "- Terminal: {}",
                if terminal.is_empty() {
                    "Unavailable: terminal environment variables are not set"
                } else {
                    terminal.as_str()
                }
            )
            .into(),
            format!(
                "- Shell: {}",
                env("SHELL")
                    .or_else(|| env("ComSpec"))
                    .or_else(|| env("COMSPEC"))
                    .unwrap_or_else(|| "Unavailable: shell environment variable is not set".into())
            )
            .into(),
            discovery::join(
                &[
                    "- Active plugins: ".into(),
                    if plugins.is_empty() {
                        "None found in config".into()
                    } else {
                        discovery::join(&plugins, ", ")
                    },
                ],
                "",
            ),
        ],
        "\n",
    )
}

fn plugins(entries: &[Entry], directory: &Path) -> Vec<LosslessString> {
    let mut plugins = entries
        .iter()
        .flat_map(|entry| match entry {
            Entry::Document {
                path,
                info: JsonValue::Object(info),
            } => {
                let base = path.as_deref().and_then(Path::parent).unwrap_or(directory);
                match info.get(&"plugins".into()) {
                    Some(JsonValue::Array(items)) => items
                        .iter()
                        .filter_map(|item| match item {
                            JsonValue::String(package) => Some(package),
                            JsonValue::Object(item) => match item.get(&"package".into()) {
                                Some(JsonValue::String(package)) => Some(package),
                                _ => None,
                            },
                            _ => None,
                        })
                        .map(|package| resolve(package, base))
                        .collect(),
                    _ => Vec::new(),
                }
            }
            Entry::Directory(path) => ["plugin", "plugins"]
                .into_iter()
                .flat_map(|name| {
                    std::fs::read_dir(path.join(name))
                        .into_iter()
                        .flatten()
                        .flatten()
                })
                .map(|file| file.path())
                .filter(|file| {
                    file.is_file()
                        && file
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.ends_with(".ts") || name.ends_with(".js"))
                })
                .map(|file| file.to_string_lossy().into_owned().into())
                .collect(),
            _ => Vec::new(),
        })
        .collect::<Vec<_>>();
    plugins.sort();
    plugins
}

fn resolve(package: &LosslessString, base: &Path) -> LosslessString {
    let resolved = package.as_str().and_then(|text| {
        if text.starts_with("file://") {
            return url::Url::parse(text).ok()?.to_file_path().ok();
        }
        if text.starts_with("./") || text.starts_with("../") {
            return discovery::absolute(&base.join(text)).ok();
        }
        None
    });
    resolved.map_or_else(
        || package.clone(),
        |path| path.to_string_lossy().into_owned().into(),
    )
}

#[cfg(unix)]
fn system() -> Option<(String, String)> {
    let mut name = unsafe { std::mem::zeroed::<libc::utsname>() };
    if unsafe { libc::uname(&mut name) } != 0 {
        return None;
    }
    let text = |field: &[libc::c_char]| {
        String::from_utf8_lossy(
            &field
                .iter()
                .take_while(|unit| **unit != 0)
                .flat_map(|unit| unit.to_ne_bytes())
                .collect::<Vec<_>>(),
        )
        .into_owned()
    };
    Some((text(&name.sysname), text(&name.release)))
}

#[cfg(not(unix))]
fn system() -> Option<(String, String)> {
    None
}
