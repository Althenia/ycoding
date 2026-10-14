use std::{
    collections::BTreeMap,
    fmt,
    path::{Path, PathBuf},
};
use ycoding_schema::{JsonValue, config::Diagnostic};

mod jsonc;
mod operations;
mod roots;
mod validation;
mod variable;
pub use operations::{
    Endpoint, EndpointApi, EndpointModel, Mutation, MutationPolicy, ProviderConfiguration, Scope,
    Target, WriteError, native_package_declaration,
};
pub use roots::Roots;

#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Document {
        path: Option<PathBuf>,
        info: JsonValue,
    },
    Directory(PathBuf),
    File(PathBuf),
    AgentsDirectory(PathBuf),
    ClaudeDirectory(PathBuf),
}

#[derive(Clone, Debug)]
pub struct LoadOptions {
    pub directory: PathBuf,
    pub roots: Roots,
    pub project: bool,
    pub file: Option<PathBuf>,
    pub content: Option<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct Configuration {
    pub event_source: crate::event_feed::EventSource,
    pub entries: Vec<Entry>,
    pub diagnostics: Vec<Diagnostic>,
    options: LoadOptions,
    mutation_policy: Option<MutationPolicy>,
}

impl Configuration {
    pub fn load(mut options: LoadOptions) -> Result<Self, Error> {
        options.directory = roots::absolute(&options.directory)?;
        if let Some(file) = &options.file {
            options.file = Some(roots::absolute(file)?);
        }
        let (entries, diagnostics) = discover(&options)?;
        Ok(Self {
            entries,
            event_source: Default::default(),
            diagnostics,
            options,
            mutation_policy: None,
        })
    }
    pub fn reload(&mut self) -> Result<(), Error> {
        let (entries, diagnostics) = discover(&self.options)?;
        self.entries = entries;
        self.diagnostics = diagnostics;
        if self
            .event_source
            .emit(crate::event_feed::Data::ConfigUpdated(Box::new(
                ycoding_schema::config::Empty,
            )))
            .is_err()
        {
            eprintln!("Config event publication failed");
        }
        Ok(())
    }
    pub fn values<'a>(&'a self, key: &'a str) -> impl DoubleEndedIterator<Item = &'a JsonValue> {
        self.entries.iter().filter_map(move |entry| match entry {
            Entry::Document {
                info: JsonValue::Object(info),
                ..
            } => info.get(&key.into()),
            _ => None,
        })
    }
    pub fn latest<'a>(&'a self, key: &'a str) -> Option<&'a JsonValue> {
        self.values(key).next_back()
    }
    pub fn roots(&self) -> &Roots {
        &self.options.roots
    }
}

#[derive(Clone, Copy)]
pub enum ParseSource<'a> {
    Path(&'a Path),
    Virtual {
        source: &'a str,
        directory: &'a Path,
    },
}

#[derive(Clone, Copy)]
pub enum MissingFile {
    Error,
    Empty,
}

#[derive(Debug)]
pub struct Error {
    path: Option<PathBuf>,
    virtual_source: Option<String>,
    message: String,
    cause: Option<std::io::Error>,
}
impl Error {
    pub fn source_path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
    pub fn source_name(&self) -> Option<&str> {
        self.virtual_source
            .as_deref()
            .or_else(|| self.path.as_deref().and_then(Path::to_str))
    }
}
impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause
            .as_ref()
            .map(|error| error as &dyn std::error::Error)
    }
}

pub fn substitute(
    text: &str,
    source: ParseSource<'_>,
    home: &Path,
    env: &BTreeMap<String, String>,
    missing: MissingFile,
) -> Result<String, Error> {
    variable::substitute(text, source, home, env, missing, None)
}

pub struct DecodedDocument {
    pub info: Option<JsonValue>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn decode_document(text: &str, target: &str) -> DecodedDocument {
    match jsonc::parse(text) {
        Ok(input) => validation::recover(input, target),
        Err(message) => DecodedDocument {
            info: None,
            diagnostics: vec![validation::diagnostic(
                target,
                None,
                "invalid-json",
                &message,
                false,
            )],
        },
    }
}

fn discover(options: &LoadOptions) -> Result<(Vec<Entry>, Vec<Diagnostic>), Error> {
    options.roots.validate()?;
    options.roots.check(&options.directory)?;
    if let Some(file) = &options.file {
        options.roots.check(file)?;
    }
    let mut discovered = Vec::new();
    if options.project && options.directory != roots::absolute(&options.roots.config)? {
        let mut current = options.directory.clone();
        loop {
            for target in [
                ".ycoding",
                ".claude",
                ".agents",
                "ycoding.jsonc",
                "ycoding.json",
            ] {
                let path = current.join(target);
                options.roots.check(&path)?;
                if path
                    .try_exists()
                    .map_err(|cause| roots::io_error(&path, cause))?
                {
                    discovered.push(path);
                }
            }
            if options.roots.discovery_boundary() == Some(current.as_path()) {
                break;
            }
            let Some(parent) = current.parent() else {
                break;
            };
            current = parent.into();
        }
    }
    let mut entries = Vec::new();
    let mut diagnostics = Vec::new();
    for (name, claude) in [(".claude", true), (".agents", false)] {
        let global = options.roots.home.join(name);
        options.roots.check(&global)?;
        if global.is_dir() {
            entries.push(if claude {
                Entry::ClaudeDirectory(global)
            } else {
                Entry::AgentsDirectory(global)
            });
        }
        entries.extend(
            discovered
                .iter()
                .filter(|path| path.file_name().is_some_and(|item| item == name))
                .cloned()
                .map(|path| {
                    if claude {
                        Entry::ClaudeDirectory(path)
                    } else {
                        Entry::AgentsDirectory(path)
                    }
                }),
        );
    }
    load_directory(
        &options.roots.config,
        options,
        &mut entries,
        &mut diagnostics,
    )?;
    let nested_global = options.roots.config.join(".ycoding");
    options.roots.check(&nested_global)?;
    if nested_global.is_dir() {
        load_directory(&nested_global, options, &mut entries, &mut diagnostics)?;
    }
    if let Some(file) = &options.file {
        load_file(file, options, &mut entries, &mut diagnostics)?;
        entries.push(Entry::File(file.clone()));
    }
    for file in discovered.iter().rev().filter(|path| {
        path.file_name()
            .is_some_and(|name| name == "ycoding.json" || name == "ycoding.jsonc")
    }) {
        load_file(file, options, &mut entries, &mut diagnostics)?;
        entries.push(Entry::File(file.clone()));
    }
    for directory in discovered
        .iter()
        .rev()
        .filter(|path| path.file_name().is_some_and(|name| name == ".ycoding"))
    {
        load_directory(directory, options, &mut entries, &mut diagnostics)?;
    }
    if let Some(content) = options
        .content
        .as_ref()
        .filter(|content| !content.is_empty())
    {
        let text = variable::substitute(
            content,
            ParseSource::Virtual {
                source: "YCODING_CONFIG_CONTENT",
                directory: &options.directory,
            },
            &options.roots.os_home,
            &options.env,
            MissingFile::Error,
            Some(&options.roots),
        )?;
        let decoded = decode_document(&text, "YCODING_CONFIG_CONTENT");
        diagnostics.extend(decoded.diagnostics);
        if let Some(info) = decoded.info {
            entries.push(Entry::Document { path: None, info });
        }
    }
    Ok((entries, diagnostics))
}

fn load_directory(
    directory: &Path,
    options: &LoadOptions,
    entries: &mut Vec<Entry>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(), Error> {
    for name in ["ycoding.json", "ycoding.jsonc"] {
        load_file(&directory.join(name), options, entries, diagnostics)?;
    }
    entries.push(Entry::Directory(directory.into()));
    Ok(())
}

fn load_file(
    path: &Path,
    options: &LoadOptions,
    entries: &mut Vec<Entry>,
    diagnostics: &mut Vec<Diagnostic>,
) -> Result<(), Error> {
    options.roots.check(path)?;
    let text = match read_text(path) {
        Ok(text) if text.is_empty() => return Ok(()),
        Ok(text) => text,
        Err(cause)
            if matches!(
                cause.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            return Ok(());
        }
        Err(cause) => return Err(roots::io_error(path, cause)),
    };
    let text = variable::substitute(
        &text,
        ParseSource::Path(path),
        &options.roots.os_home,
        &options.env,
        MissingFile::Error,
        Some(&options.roots),
    )?;
    let target = path.to_str().ok_or_else(|| Error {
        path: Some(path.into()),
        virtual_source: None,
        message: "Configuration source path is not valid Unicode".into(),
        cause: None,
    })?;
    let decoded = decode_document(&text, target);
    diagnostics.extend(decoded.diagnostics);
    if let Some(info) = decoded.info {
        entries.push(Entry::Document {
            path: Some(path.into()),
            info,
        });
    }
    Ok(())
}

fn read_text(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(
        String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
            .into_owned(),
    )
}
