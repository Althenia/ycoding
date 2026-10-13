use super::{Location, fuzzy};
use fff_search::{
    FFFMode, FilePicker, FilePickerOptions, FuzzySearchOptions, GrepMode, GrepSearchOptions,
    MixedItemRef, PaginationArgs, QueryParser, SharedFilePicker, SharedFrecency,
};
use std::{
    collections::HashSet,
    io::{self, BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread::JoinHandle,
    time::Duration,
};
use ycoding_schema::{
    LosslessString,
    filesystem::{Entry, EntryType, FindInput, Match, Submatch},
    schema::{NonNegativeInt, PositiveInt, RelativePath},
};

pub enum Backend {
    Fff,
    Ripgrep { binary: PathBuf },
    Automatic { vcs: bool, binary: PathBuf },
}
pub struct GlobInput {
    pub pattern: String,
    pub path: Option<String>,
    pub limit: Option<usize>,
}
pub struct GrepInput {
    pub pattern: String,
    pub path: Option<String>,
    pub include: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Default)]
struct Index {
    files: Vec<String>,
    directories: Vec<String>,
    seen: HashSet<String>,
    finished: bool,
    failed: bool,
}
#[derive(Default)]
struct Running {
    child: Option<Child>,
    cancelled: bool,
}
enum State {
    Deferred {
        backend: Arc<dyn Fn() -> io::Result<Backend> + Send + Sync>,
        service: std::sync::OnceLock<Result<Box<Service>, String>>,
    },
    Unavailable,
    Fff(SharedFilePicker),
    Ripgrep {
        binary: PathBuf,
        index: Arc<(Mutex<Index>, Condvar)>,
        running: Arc<Mutex<Running>>,
        worker: Option<JoinHandle<()>>,
    },
}
pub struct Service {
    location: Location,
    state: State,
}

impl Service {
    pub fn deferred(directory: &std::path::Path, backend: Arc<dyn Fn() -> io::Result<Backend> + Send + Sync>) -> io::Result<Self> {
        Ok(Self {
            location: Location::new(directory)?,
            state: State::Deferred { backend, service: Default::default() },
        })
    }
    fn initialized(&self) -> io::Result<Option<&Self>> {
        let State::Deferred { backend, service } = &self.state else {
            return Ok(None);
        };
        service.get_or_init(|| backend().and_then(|backend| Self::new(self.directory(), backend)).map(Box::new).map_err(|error| error.to_string()))
            .as_ref().map(|service| Some(service.as_ref())).map_err(|error| io::Error::other(error.clone()))
    }
    pub fn directory(&self) -> &std::path::Path {
        self.location.directory()
    }
    pub fn new(directory: &std::path::Path, backend: Backend) -> io::Result<Self> {
        let location = Location::new(directory)?;
        let backend = match backend {
            Backend::Automatic { vcs, binary } => {
                if !cfg!(windows) && vcs {
                    Backend::Fff
                } else {
                    Backend::Ripgrep { binary }
                }
            }
            backend => backend,
        };
        let state = match backend {
            Backend::Fff => {
                let shared = SharedFilePicker::default();
                let initialized = FilePicker::new_with_shared_state(
                    shared.clone(),
                    SharedFrecency::default(),
                    FilePickerOptions {
                        base_path: directory
                            .to_str()
                            .ok_or_else(|| io::Error::other("Path is not UTF-8"))?
                            .into(),
                        mode: FFFMode::Ai,
                        enable_mmap_cache: false,
                        enable_content_indexing: false,
                        ..FilePickerOptions::default()
                    },
                );
                match initialized {
                    Ok(()) => State::Fff(shared),
                    Err(error) => {
                        eprintln!("Failed to initialize fff: {error}");
                        State::Unavailable
                    }
                }
            }
            Backend::Ripgrep { binary } => {
                let index = Arc::new((Mutex::new(Index::default()), Condvar::new()));
                let running = Arc::new(Mutex::new(Running::default()));
                let indexed = index.clone();
                let child = running.clone();
                let executable = binary.clone();
                let directory = directory.to_path_buf();
                let limit = if directory
                    .ancestors()
                    .any(|directory| directory.join(".git").exists())
                {
                    9_007_199_254_740_991
                } else {
                    100_000
                };
                let worker = std::thread::spawn(move || {
                    let result = rg(
                        &executable,
                        &directory,
                        &[
                            "--no-config".into(),
                            "--files".into(),
                            "--glob=!**/.git/**".into(),
                            ".".into(),
                        ],
                        limit,
                        None,
                        |line| {
                            let file = String::from_utf8_lossy(line)
                                .trim_end_matches(['\r', '\n'])
                                .trim_start_matches("./")
                                .replace('\\', "/");
                            let mut index = indexed
                                .0
                                .lock()
                                .map_err(|_| io::Error::other("Search index lock poisoned"))?;
                            if index.files.len() < limit {
                                let parts: Vec<_> = file.split('/').collect();
                                for i in 1..parts.len() {
                                    let directory = format!(
                                        "{}{}",
                                        parts[..i].join("/"),
                                        std::path::MAIN_SEPARATOR
                                    );
                                    if index.seen.insert(directory.clone()) {
                                        index.directories.push(directory);
                                    }
                                }
                                index.files.push(file);
                            }
                            Ok(Some(()))
                        },
                        Some(&child),
                    );
                    if let Ok(mut index) = indexed.0.lock() {
                        index.finished = true;
                        index.failed = result.is_err();
                    }
                    if let Err(error) = result {
                        eprintln!("Initial filesystem scan failed: {error}");
                    }
                    indexed.1.notify_all();
                });
                State::Ripgrep {
                    binary,
                    index,
                    running,
                    worker: Some(worker),
                }
            }
            Backend::Automatic { .. } => unreachable!(),
        };
        Ok(Self { location, state })
    }

    pub fn wait_for_scan(&self, timeout: Duration) -> bool {
        match self.initialized() {
            Ok(Some(service)) => return service.wait_for_scan(timeout),
            Err(_) => return false,
            Ok(None) => {}
        }
        match &self.state {
            State::Deferred { .. } => unreachable!("deferred service was initialized"),
            State::Unavailable => true,
            State::Fff(shared) => shared.wait_for_scan(timeout),
            State::Ripgrep { index, .. } => index
                .0
                .lock()
                .ok()
                .and_then(|state| {
                    index
                        .1
                        .wait_timeout_while(state, timeout, |state| !state.finished)
                        .ok()
                })
                .is_some_and(|(state, _)| state.finished && !state.failed),
        }
    }

    pub fn find(&self, input: &FindInput) -> io::Result<Vec<Entry>> {
        if let Some(service) = self.initialized()? {
            return service.find(input);
        }
        let query = input.query.to_utf8().map_err(io::Error::other)?;
        let limit = input.limit.map(|value| value.get() as usize).unwrap_or(50);
        match &self.state {
            State::Deferred { .. } => unreachable!("deferred service was initialized"),
            State::Unavailable => Ok(Vec::new()),
            State::Ripgrep { index, .. } => {
                let index = index
                    .0
                    .lock()
                    .map_err(|_| io::Error::other("Search index lock poisoned"))?;
                let items = match input.r#type {
                    Some(EntryType::File) => index.files.clone(),
                    Some(EntryType::Directory) => index.directories.clone(),
                    None => index
                        .files
                        .iter()
                        .chain(&index.directories)
                        .cloned()
                        .collect(),
                };
                drop(index);
                fuzzy::find(&query, &items, limit)
                    .iter()
                    .map(|file| {
                        entry(
                            file,
                            if file.ends_with(std::path::MAIN_SEPARATOR) {
                                EntryType::Directory
                            } else {
                                EntryType::File
                            },
                        )
                    })
                    .collect()
            }
            State::Fff(shared) => {
                let guard = shared.read().map_err(io::Error::other)?;
                let picker = guard
                    .as_ref()
                    .ok_or_else(|| io::Error::other("Search picker disposed"))?;
                let parser = QueryParser::default();
                let parsed = parser.parse(super::trim(&query));
                let options = options(picker, limit, false);
                let items = match input.r#type {
                    Some(EntryType::File) => {
                        let found = picker.fuzzy_search(&parsed, None, options);
                        found
                            .items
                            .iter()
                            .enumerate()
                            .map(|(i, item)| {
                                (
                                    item.relative_path(picker),
                                    EntryType::File,
                                    found.scores.get(i).map_or(0, |score| score.total),
                                )
                            })
                            .collect::<Vec<_>>()
                    }
                    Some(EntryType::Directory) => {
                        let found = picker.fuzzy_search_directories(&parsed, options);
                        found
                            .items
                            .iter()
                            .enumerate()
                            .map(|(i, item)| {
                                (
                                    item.relative_path(picker),
                                    EntryType::Directory,
                                    found.scores.get(i).map_or(0, |score| score.total),
                                )
                            })
                            .collect()
                    }
                    None => {
                        let found = picker.fuzzy_search_mixed(&parsed, None, options);
                        found
                            .items
                            .iter()
                            .enumerate()
                            .map(|(i, item)| {
                                let (path, kind) = match item {
                                    MixedItemRef::File(item) => {
                                        (item.relative_path(picker), EntryType::File)
                                    }
                                    MixedItemRef::Dir(item) => {
                                        (item.relative_path(picker), EntryType::Directory)
                                    }
                                };
                                (
                                    path,
                                    kind,
                                    found.scores.get(i).map_or(0, |score| score.total),
                                )
                            })
                            .collect()
                    }
                };
                let mut items = items;
                items.sort_by(|a, b| {
                    b.2.cmp(&a.2)
                        .then_with(|| a.0.encode_utf16().count().cmp(&b.0.encode_utf16().count()))
                });
                items
                    .iter()
                    .map(|(path, kind, _)| {
                        entry(
                            &format!(
                                "{}{}",
                                path.replace('\\', "/").trim_end_matches('/'),
                                if *kind == EntryType::Directory {
                                    std::path::MAIN_SEPARATOR_STR
                                } else {
                                    ""
                                }
                            ),
                            *kind,
                        )
                    })
                    .collect()
            }
        }
    }

    pub fn glob(&self, input: &GlobInput) -> io::Result<Vec<Entry>> {
        if let Some(service) = self.initialized()? {
            return service.glob(input);
        }
        let limit = checked_limit(input.limit)?;
        match &self.state {
            State::Deferred { .. } => unreachable!("deferred service was initialized"),
            State::Unavailable => Ok(Vec::new()),
            State::Fff(shared) => {
                if let Some(path) = &input.path {
                    self.location.resolve_mutation(path)?;
                }
                let guard = shared.read().map_err(io::Error::other)?;
                let picker = guard
                    .as_ref()
                    .ok_or_else(|| io::Error::other("Search picker disposed"))?;
                let prefix = input.path.as_deref().unwrap_or("").replace('\\', "/");
                let prefix = prefix.trim_end_matches('/');
                let pattern = if prefix.is_empty() {
                    input.pattern.clone()
                } else {
                    format!("{prefix}/{}", input.pattern)
                };
                picker
                    .glob(&pattern, options(picker, limit, true))
                    .items
                    .iter()
                    .map(|item| {
                        entry(
                            &item.relative_path(picker).replace('\\', "/"),
                            EntryType::File,
                        )
                    })
                    .collect()
            }
            State::Ripgrep { binary, .. } => {
                let (cwd, _) = self.scope(input.path.as_deref())?;
                rg_files(binary, &cwd, &input.pattern, limit, true)?
                    .iter()
                    .map(|path| self.scoped_entry(&cwd, path))
                    .collect()
            }
        }
    }

    pub fn grep(&self, input: &GrepInput) -> io::Result<Vec<Match>> {
        if let Some(service) = self.initialized()? {
            return service.grep(input);
        }
        let limit = checked_limit(input.limit)?;
        match &self.state {
            State::Deferred { .. } => unreachable!("deferred service was initialized"),
            State::Unavailable => Ok(Vec::new()),
            State::Fff(shared) => {
                if let Some(path) = &input.path {
                    self.location.resolve_mutation(path)?;
                }
                let guard = shared.read().map_err(io::Error::other)?;
                let picker = guard
                    .as_ref()
                    .ok_or_else(|| io::Error::other("Search picker disposed"))?;
                let prefix = input.path.as_deref().unwrap_or("").replace('\\', "/");
                let prefix = prefix.trim_end_matches('/');
                let scoped = (!prefix.is_empty()).then(|| format!("{prefix}/**"));
                let query = [
                    scoped.as_deref(),
                    input.include.as_deref(),
                    Some(input.pattern.as_str()),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
                let parser = QueryParser::default();
                let parsed = parser.parse(&query);
                let found = picker.grep(
                    &parsed,
                    &GrepSearchOptions {
                        mode: GrepMode::Regex,
                        page_limit: limit,
                        time_budget_ms: 1500,
                        max_matches_per_file: 0,
                        ..GrepSearchOptions::default()
                    },
                );
                found
                    .matches
                    .iter()
                    .map(|matched| {
                        let file = found
                            .files
                            .get(matched.file_index)
                            .ok_or_else(|| io::Error::other("Invalid grep file index"))?;
                        let bytes = matched.line_content.as_bytes();
                        Ok(Match {
                            entry: entry(
                                &file.relative_path(picker).replace('\\', "/"),
                                EntryType::File,
                            )?,
                            line: positive(matched.line_number)?,
                            offset: nonnegative(matched.byte_offset)?,
                            text: truncate(&matched.line_content),
                            submatches: matched
                                .match_byte_offsets
                                .iter()
                                .map(|(start, end)| {
                                    Ok(Submatch {
                                        text: String::from_utf8_lossy(
                                            bytes.get(*start as usize..*end as usize).ok_or_else(
                                                || io::Error::other("Invalid grep byte range"),
                                            )?,
                                        )
                                        .into_owned()
                                        .into(),
                                        start: nonnegative(*start as u64)?,
                                        end: nonnegative(*end as u64)?,
                                    })
                                })
                                .collect::<io::Result<_>>()?,
                        })
                    })
                    .collect()
            }
            State::Ripgrep { binary, .. } => {
                let (cwd, file) = self.scope(input.path.as_deref())?;
                let mut args = vec![
                    "--no-config".into(),
                    "--json".into(),
                    "--hidden".into(),
                    "--no-messages".into(),
                ];
                if let Some(include) = &input.include {
                    args.push(format!("--glob={include}"));
                }
                args.extend([
                    "--glob=!**/.git/**".into(),
                    "--".into(),
                    input.pattern.clone(),
                    file.unwrap_or_else(|| ".".into()),
                ]);
                rg(
                    binary,
                    &cwd,
                    &args,
                    limit,
                    Some(&input.pattern),
                    |line| {
                        let json: serde_json::Value =
                            serde_json::from_slice(line).map_err(io::Error::other)?;
                        if json["type"] != "match" {
                            return Ok(None);
                        }
                        let data = &json["data"];
                        Ok(Some(Match {
                            entry: self.scoped_entry(
                                &cwd,
                                string(&data["path"]["text"])?.trim_start_matches("./"),
                            )?,
                            line: positive(number(&data["line_number"])?)?,
                            offset: nonnegative(number(&data["absolute_offset"])?)?,
                            text: truncate(string(&data["lines"]["text"])?),
                            submatches: data["submatches"]
                                .as_array()
                                .ok_or_else(|| io::Error::other("Invalid grep submatches"))?
                                .iter()
                                .take(100)
                                .map(|sub| {
                                    Ok(Submatch {
                                        text: string(&sub["match"]["text"])?.into(),
                                        start: nonnegative(number(&sub["start"])?)?,
                                        end: nonnegative(number(&sub["end"])?)?,
                                    })
                                })
                                .collect::<io::Result<_>>()?,
                        }))
                    },
                    None,
                )
            }
        }
    }

    fn scope(&self, path: Option<&str>) -> io::Result<(PathBuf, Option<String>)> {
        let target = self.location.resolve(path.unwrap_or("."))?;
        if target.is_file() {
            return Ok((
                target
                    .parent()
                    .ok_or_else(|| io::Error::other("No file parent"))?
                    .into(),
                Some(
                    target
                        .file_name()
                        .ok_or_else(|| io::Error::other("No file name"))?
                        .to_string_lossy()
                        .into_owned(),
                ),
            ));
        }
        Ok((target, None))
    }
    fn scoped_entry(&self, cwd: &std::path::Path, path: &str) -> io::Result<Entry> {
        let absolute = cwd.join(path);
        let relative = absolute
            .strip_prefix(&self.location.root)
            .map_err(io::Error::other)?;
        entry(
            &relative.to_string_lossy().replace('\\', "/"),
            EntryType::File,
        )
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        if let State::Fff(shared) = &self.state
            && let Ok(mut guard) = shared.write()
        {
            let picker = guard.take();
            drop(guard);
            if let Some(mut picker) = picker {
                picker.stop_background_monitor();
                drop(picker);
            }
        }
        if let State::Ripgrep {
            running, worker, ..
        } = &mut self.state
        {
            if let Ok(mut running) = running.lock() {
                running.cancelled = true;
                if let Some(child) = running.child.as_mut() {
                    let _ = child.kill();
                }
            }
            if let Some(worker) = worker.take()
                && worker.join().is_err()
            {
                eprintln!("Filesystem index worker panicked");
            }
        }
    }
}

fn options(picker: &FilePicker, limit: usize, glob: bool) -> FuzzySearchOptions<'_> {
    FuzzySearchOptions {
        max_threads: 0,
        current_file: None,
        project_path: Some(picker.base_path()),
        combo_boost_score_multiplier: if glob { 0 } else { 100 },
        min_combo_count: if glob { 0 } else { 3 },
        pagination: PaginationArgs { offset: 0, limit },
    }
}
fn entry(path: &str, kind: EntryType) -> io::Result<Entry> {
    Ok(Entry {
        path: RelativePath::new(path).map_err(io::Error::other)?,
        r#type: kind,
    })
}
fn checked_limit(limit: Option<usize>) -> io::Result<usize> {
    match limit {
        Some(0) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Search limit must be positive",
        )),
        limit => Ok(limit.unwrap_or(100)),
    }
}
fn positive(value: u64) -> io::Result<PositiveInt> {
    PositiveInt::new(i64::try_from(value).map_err(io::Error::other)?).map_err(io::Error::other)
}
fn nonnegative(value: u64) -> io::Result<NonNegativeInt> {
    NonNegativeInt::new(i64::try_from(value).map_err(io::Error::other)?).map_err(io::Error::other)
}
fn truncate(text: &str) -> LosslessString {
    let units: Vec<_> = text.encode_utf16().collect();
    if units.len() <= 2000 {
        return text.into();
    }
    LosslessString::from_utf16(
        units[..2000]
            .iter()
            .copied()
            .chain("...".encode_utf16())
            .collect(),
    )
}
fn string(value: &serde_json::Value) -> io::Result<&str> {
    value
        .as_str()
        .ok_or_else(|| io::Error::other("Invalid grep string"))
}
fn number(value: &serde_json::Value) -> io::Result<u64> {
    value
        .as_u64()
        .ok_or_else(|| io::Error::other("Invalid grep number"))
}

fn rg_files(
    binary: &std::path::Path,
    cwd: &std::path::Path,
    pattern: &str,
    limit: usize,
    apply_pattern: bool,
) -> io::Result<Vec<String>> {
    let mut args = vec!["--no-config".into(), "--files".into()];
    if apply_pattern {
        args.push(format!("--glob={pattern}"));
    }
    args.extend(["--glob=!**/.git/**".into(), ".".into()]);
    rg(
        binary,
        cwd,
        &args,
        limit,
        None,
        |line| {
            Ok(Some(
                String::from_utf8_lossy(line)
                    .trim_end_matches(['\r', '\n'])
                    .trim_start_matches("./")
                    .replace('\\', "/"),
            ))
        },
        None,
    )
}

fn rg<T>(
    binary: &std::path::Path,
    cwd: &std::path::Path,
    args: &[String],
    limit: usize,
    pattern: Option<&str>,
    parse: impl Fn(&[u8]) -> io::Result<Option<T>>,
    running: Option<&Arc<Mutex<Running>>>,
) -> io::Result<Vec<T>> {
    let mut child = Command::new(binary)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Missing ripgrep stderr"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Missing ripgrep stdout"))?;
    let local = Arc::new(Mutex::new(Running::default()));
    let running = running.unwrap_or(&local);
    {
        let mut running = running
            .lock()
            .map_err(|_| io::Error::other("Ripgrep process lock poisoned"))?;
        if running.cancelled {
            let _ = child.kill();
        }
        running.child = Some(child);
    }
    let errors = std::thread::spawn(move || {
        let mut reader = stderr;
        let mut buffer = [0; 8192];
        let mut retained = Vec::new();
        loop {
            let size = reader.read(&mut buffer)?;
            if size == 0 {
                return Ok::<_, io::Error>(retained);
            }
            let take = size.min(8192_usize.saturating_sub(retained.len()));
            retained.extend_from_slice(&buffer[..take]);
        }
    });
    let result = (|| {
        let mut stdout = BufReader::new(stdout);
        let mut rows = Vec::new();
        let mut line = Vec::new();
        loop {
            let buffer = stdout.fill_buf()?;
            if buffer.is_empty() {
                break;
            }
            let end = buffer
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1);
            let size = end.unwrap_or(buffer.len());
            if line.len() + size > 65536 {
                return Err(io::Error::other("Ripgrep JSON record exceeded 65536 bytes"));
            }
            line.extend_from_slice(&buffer[..size]);
            stdout.consume(size);
            if end.is_none() {
                continue;
            }
            if let Some(row) = parse(&line)? {
                rows.push(row);
            }
            line.clear();
            if rows.len() > limit {
                rows.truncate(limit);
                return Ok((rows, true));
            }
        }
        if !line.is_empty()
            && let Some(row) = parse(&line)?
        {
            rows.push(row);
        }
        Ok((rows, false))
    })();
    let mut child = running
        .lock()
        .map_err(|_| io::Error::other("Ripgrep process lock poisoned"))?
        .child
        .take()
        .ok_or_else(|| io::Error::other("Ripgrep child unavailable"))?;
    if !matches!(result, Ok((_, false))) {
        let _ = child.kill();
    }
    let status = child.wait();
    let stderr = errors
        .join()
        .map_err(|_| io::Error::other("Ripgrep stderr reader panicked"))??;
    let (rows, truncated) = result?;
    let code = status?.code().unwrap_or(-1);
    if truncated {
        return Ok(rows);
    }
    let stderr = String::from_utf8_lossy(&stderr);
    if code == 2
        && pattern.is_some()
        && (stderr.contains("regex parse error") || stderr.contains("error parsing regex"))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            stderr.trim().to_string(),
        ));
    }
    match code {
        0 | 2 => Ok(rows),
        1 => Ok(Vec::new()),
        _ => Err(io::Error::other(stderr.trim().to_string())),
    }
}
