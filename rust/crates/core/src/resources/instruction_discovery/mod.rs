use super::discovery::{self, Diagnostic, Error};
use std::path::PathBuf;
pub const KEY: &str = "core/instructions";
pub const DEFAULT_MAX_BYTES: usize = 50 * 1024;
pub const MAX_MAX_BYTES: usize = 1024 * 1024;
#[derive(Clone, Debug)]
pub struct Options {
    pub directory: PathBuf,
    pub project_root: PathBuf,
    pub global_config: PathBuf,
    pub project: bool,
    pub max_bytes: Option<usize>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct File {
    pub path: PathBuf,
    pub content: String,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Observation {
    Available(Vec<File>),
    Removed,
    Unavailable(Diagnostic),
}
pub struct Paths {
    pub global: PathBuf,
    pub project: Vec<PathBuf>,
}
pub struct RenderedContent {
    pub content: String,
    pub bytes: usize,
    pub digest: String,
    pub omitted: bool,
}
pub fn observe(options: &Options) -> Observation {
    match discover(options) {
        Ok(paths) => read(&paths),
        Err(e) => unavailable(&options.directory, e),
    }
}
pub fn discover(options: &Options) -> Result<Paths, Error> {
    let start = discovery::resolve(&options.directory)?;
    let stop = discovery::resolve(&options.project_root)?;
    let mut paths = Paths {
        global: discovery::resolve(&options.global_config.join("AGENTS.md"))?,
        project: Vec::new(),
    };
    if !options.project || !start.starts_with(&stop) {
        return Ok(paths);
    }
    let mut current = start;
    loop {
        let path = current.join("AGENTS.md");
        if path.try_exists().map_err(|e| discovery::io(&path, e))? {
            let path = discovery::resolve(&path)?;
            if !paths.project.contains(&path) {
                paths.project.push(path);
            }
        }
        if current == stop {
            break;
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent.into();
    }
    Ok(paths)
}
pub fn read(paths: &Paths) -> Observation {
    let mut files = Vec::new();
    let mut seen = Vec::new();
    for path in std::iter::once(&paths.global).chain(paths.project.iter()) {
        if seen.contains(&path) {
            continue;
        }
        seen.push(path);
        match discovery::read_text(path) {
            Ok(Some(content)) => files.push(File { path: path.clone(), content }),
            Ok(None) if !paths.project.contains(path) => {},
            Ok(None) => return Observation::Unavailable(Diagnostic { path: path.display().to_string(), reason: "unavailable".into(), message: "A discovered instruction file could not be read; retain the previous instruction value".into() }),
            Err(e) => return unavailable(path, e),
        }
    }
    if files.is_empty() {
        return Observation::Removed;
    }
    Observation::Available(files)
}
pub fn render_content(
    source: &str,
    content: &str,
    max_bytes: Option<usize>,
    retrieval: &str,
) -> RenderedContent {
    let bytes = content.len();
    let digest = ring::digest::digest(&ring::digest::SHA256, content.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let max_bytes = max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let omitted = bytes > max_bytes;
    RenderedContent {
        content: if omitted {
            format!(
                "[Instruction content omitted because {bytes} UTF-8 bytes exceeds the {max_bytes}-byte inline limit.]\nSource: {source}\nSHA-256: {digest}\nUse the {retrieval} tool to load only the relevant sections on demand."
            )
        } else {
            content.into()
        },
        bytes,
        digest,
        omitted,
    }
}
impl Observation {
    pub fn value<'a>(&'a self, previous: Option<&'a [File]>) -> Option<&'a [File]> {
        match self {
            Self::Available(files) => Some(files),
            Self::Removed => Some(&[]),
            Self::Unavailable(_) => previous,
        }
    }
    pub fn render(&self, previous: Option<&[File]>, options: &Options) -> Option<String> {
        match self {
            Self::Unavailable(_) => None,
            Self::Removed => {
                previous.map(|_| "Previously loaded instructions no longer apply.".into())
            }
            Self::Available(files) => {
                if previous == Some(files.as_slice()) {
                    return None;
                }
                let text = files
                    .iter()
                    .map(|file| {
                        let path = file.path.display().to_string();
                        format!(
                            "Instructions from: {path}\n{}",
                            render_content(&path, &file.content, options.max_bytes, "read").content
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n");
                Some(if previous.is_some() {
                    format!(
                        "These instructions replace all previously loaded ambient instructions.\n\n{text}"
                    )
                } else {
                    text
                })
            }
        }
    }
}

fn unavailable(path: &std::path::Path, error: Error) -> Observation {
    Observation::Unavailable(Diagnostic {
        path: path.display().to_string(),
        reason: "unavailable".into(),
        message: error.to_string(),
    })
}
