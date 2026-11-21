use super::filesystem::{contains, normalize};
mod hg;
pub mod vcs;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_schema::{
    file_diff::{Info, Status},
    schema::NonNegativeInt,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Repository {
    pub worktree: PathBuf,
    pub git_directory: PathBuf,
    pub common_directory: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    pub operation: &'static str,
    pub directory: PathBuf,
    pub message: String,
    pub force_required: bool,
    pub unknown_outcome: bool,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Git {} failed: {}", self.operation, self.message)
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug)]
pub enum IndexPolicy {
    Preserve,
    Reset,
}
#[derive(Clone, Copy, Debug)]
pub enum UntrackedPolicy {
    Preserve,
    Remove,
}

pub struct Service {
    output_limit: usize,
    locks: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
}

pub(crate) struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub truncated: bool,
}

pub(crate) struct Capture<'a> {
    pub program: &'a str,
    pub limit: usize,
}
impl Output {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn message(&self) -> String {
        let stderr = String::from_utf8_lossy(&self.stderr);
        if !stderr.trim().is_empty() {
            return stderr.trim().into();
        }
        self.text().trim().into()
    }
}

impl Service {
    pub fn new(output_limit: usize) -> Self {
        Self {
            output_limit,
            locks: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn run(
        &self,
        operation: &'static str,
        cwd: &Path,
        args: &[&str],
        stdin: Option<&[u8]>,
        index: Option<&Path>,
    ) -> Result<Output, Error> {
        self.run_program("git", operation, cwd, args, stdin, index)
    }

    pub(crate) fn run_program(
        &self,
        program: &str,
        operation: &'static str,
        cwd: &Path,
        args: &[&str],
        stdin: Option<&[u8]>,
        index: Option<&Path>,
    ) -> Result<Output, Error> {
        let output = self.capture(
            Capture {
                program,
                limit: self.output_limit,
            },
            operation,
            cwd,
            args,
            stdin,
            index,
        )?;
        if output.truncated {
            return Err(Error {
                unknown_outcome: true,
                ..error(operation, cwd, "Git output limit exceeded")
            });
        }
        Ok(output)
    }

    pub(crate) fn capture(
        &self,
        capture: Capture<'_>,
        operation: &'static str,
        cwd: &Path,
        args: &[&str],
        stdin: Option<&[u8]>,
        index: Option<&Path>,
    ) -> Result<Output, Error> {
        let mut command = Command::new(capture.program);
        if capture.program == "hg" {
            command.env("HGPLAIN", "1");
        }
        command
            .args(args)
            .current_dir(cwd)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(index) = index {
            command.env("GIT_INDEX_FILE", index);
        }
        let mut child = command
            .spawn()
            .map_err(|e| error(operation, cwd, e.to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| error(operation, cwd, "Missing stdout pipe"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| error(operation, cwd, "Missing stderr pipe"))?;
        let out = std::thread::spawn(move || bounded(stdout, capture.limit));
        let err = std::thread::spawn(move || bounded(stderr, capture.limit));
        let input = match stdin {
            Some(input) => child
                .stdin
                .take()
                .ok_or_else(|| io::Error::other("Missing stdin pipe"))
                .and_then(|mut pipe| pipe.write_all(input)),
            None => Ok(()),
        };
        let status = child.wait();
        let stdout = out
            .join()
            .map_err(|_| io::Error::other("stdout reader panicked"))
            .and_then(|value| value);
        let stderr = err
            .join()
            .map_err(|_| io::Error::other("stderr reader panicked"))
            .and_then(|value| value);
        let (stdout, stderr, status) = match (input, stdout, stderr, status) {
            (Ok(()), Ok(stdout), Ok(stderr), Ok(status)) => (stdout, stderr, status),
            (input, stdout, stderr, status) => {
                let message = input
                    .err()
                    .or_else(|| stdout.err())
                    .or_else(|| stderr.err())
                    .or_else(|| status.err())
                    .map(|e| e.to_string())
                    .unwrap_or_default();
                return Err(Error {
                    unknown_outcome: true,
                    ..error(operation, cwd, message)
                });
            }
        };
        Ok(Output {
            code: status.code().unwrap_or(-1),
            stdout: stdout.0,
            stderr: stderr.0,
            truncated: stdout.1 || stderr.1,
        })
    }

    pub(crate) fn checked(
        &self,
        operation: &'static str,
        cwd: &Path,
        args: &[&str],
        stdin: Option<&[u8]>,
        index: Option<&Path>,
    ) -> Result<Output, Error> {
        let output = self.run(operation, cwd, args, stdin, index)?;
        if output.code == 0 {
            return Ok(output);
        }
        Err(error(operation, cwd, output.message()))
    }

    fn repository(
        &self,
        operation: &'static str,
        repository: &Repository,
        args: &[&str],
        stdin: Option<&[u8]>,
        index: Option<&Path>,
    ) -> Result<Output, Error> {
        let git_dir = path_text(&repository.git_directory, operation)?;
        let worktree = path_text(&repository.worktree, operation)?;
        self.checked(
            operation,
            &repository.worktree,
            &[&["--git-dir", git_dir, "--work-tree", worktree], args].concat(),
            stdin,
            index,
        )
    }

    fn locked<T>(
        &self,
        repository: &Repository,
        operation: impl FnOnce() -> Result<T, Error>,
    ) -> Result<T, Error> {
        let lock = {
            let mut locks = self
                .locks
                .lock()
                .map_err(|_| error("lock", &repository.worktree, "Git lock poisoned"))?;
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(&repository.git_directory).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    locks.insert(repository.git_directory.clone(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        let _guard = lock
            .lock()
            .map_err(|_| error("lock", &repository.worktree, "Git lock poisoned"))?;
        operation()
    }

    pub fn discover(&self, directory: &Path) -> Result<Option<Repository>, Error> {
        let directory = normalize(
            &std::path::absolute(directory)
                .map_err(|e| error("discover", directory, e.to_string()))?,
        );
        let Some(cwd) = directory
            .ancestors()
            .find(|parent| parent.join(".git").exists())
        else {
            return Ok(None);
        };
        let output = match self.run(
            "discover",
            cwd,
            &[
                "rev-parse",
                "--git-dir",
                "--git-common-dir",
                "--show-toplevel",
            ],
            None,
            None,
        ) {
            Ok(output) => output,
            Err(error) if !error.unknown_outcome => return Ok(None),
            Err(error) => return Err(error),
        };
        let text = output.text();
        let mut lines = text.lines();
        let Some(git_directory) = lines.next().filter(|line| !line.is_empty()) else {
            return Ok(None);
        };
        let Some(common_directory) = lines.next().filter(|line| !line.is_empty()) else {
            return Ok(None);
        };
        let top = lines.next().unwrap_or("");
        Ok(Some(Repository {
            worktree: normalize(&cwd.join(top)),
            git_directory: normalize(&cwd.join(git_directory)),
            common_directory: normalize(&cwd.join(common_directory)),
        }))
    }

    fn optional(&self, repository: &Repository, args: &[&str]) -> Result<Option<String>, Error> {
        let output = match self.run("history", &repository.worktree, args, None, None) {
            Ok(output) => output,
            Err(error) if !error.unknown_outcome => return Ok(None),
            Err(error) => return Err(error),
        };
        let text = output.text();
        Ok((output.code == 0 && !text.trim().is_empty()).then(|| text.trim().into()))
    }

    pub fn remote(&self, repository: &Repository, name: &str) -> Result<Option<String>, Error> {
        self.optional(repository, &["remote", "get-url", name])
    }
    pub fn head(&self, repository: &Repository) -> Result<Option<String>, Error> {
        self.optional(repository, &["rev-parse", "HEAD"])
    }
    pub fn branch(&self, repository: &Repository) -> Result<Option<String>, Error> {
        self.optional(repository, &["symbolic-ref", "--quiet", "--short", "HEAD"])
    }
    pub fn default_remote_branch(
        &self,
        repository: &Repository,
        remote: &str,
    ) -> Result<Option<String>, Error> {
        Ok(self
            .optional(
                repository,
                &["symbolic-ref", &format!("refs/remotes/{remote}/HEAD")],
            )?
            .map(|branch| {
                branch
                    .strip_prefix(&format!("refs/remotes/{remote}/"))
                    .unwrap_or(&branch)
                    .into()
            }))
    }
    pub fn root_commits(&self, repository: &Repository) -> Result<Vec<String>, Error> {
        let mut roots: Vec<_> = self
            .optional(repository, &["rev-list", "--max-parents=0", "HEAD"])?
            .into_iter()
            .flat_map(|value| {
                value
                    .lines()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .collect();
        roots.sort();
        Ok(roots)
    }

    pub fn clone_repository(
        &self,
        remote: &str,
        directory: &Path,
        branch: Option<&str>,
        depth: Option<u32>,
    ) -> Result<Repository, Error> {
        let depth = depth.unwrap_or(100).to_string();
        let mut args = vec!["clone", "--depth", depth.as_str()];
        if let Some(branch) = branch {
            args.extend(["--branch", branch]);
        }
        args.extend(["--", remote, path_text(directory, "clone")?]);
        self.checked(
            "clone",
            directory.parent().unwrap_or(directory),
            &args,
            None,
            None,
        )?;
        self.discover(directory)?
            .ok_or_else(|| error("clone", directory, "Cloned repository could not be opened"))
    }

    pub fn fetch_remotes(&self, repository: &Repository, prune: bool) -> Result<(), Error> {
        self.checked(
            "fetch",
            &repository.worktree,
            if prune {
                &["fetch", "--all", "--prune"]
            } else {
                &["fetch", "--all"]
            },
            None,
            None,
        )?;
        Ok(())
    }
    pub fn fetch_branch(
        &self,
        repository: &Repository,
        remote: &str,
        branch: &str,
        force: bool,
    ) -> Result<(), Error> {
        let spec = format!(
            "{}refs/heads/{branch}:refs/remotes/{remote}/{branch}",
            if force { "+" } else { "" }
        );
        self.checked(
            "fetch",
            &repository.worktree,
            &["fetch", remote, &spec],
            None,
            None,
        )?;
        Ok(())
    }
    pub fn checkout_remote_branch(
        &self,
        repository: &Repository,
        remote: &str,
        branch: &str,
        reset: bool,
    ) -> Result<(), Error> {
        let target = format!("{remote}/{branch}");
        let args = if reset {
            vec!["checkout", "-B", branch, &target]
        } else {
            vec!["checkout", branch]
        };
        self.checked("checkout", &repository.worktree, &args, None, None)?;
        Ok(())
    }
    pub fn reset_hard(&self, repository: &Repository, revision: &str) -> Result<(), Error> {
        self.checked(
            "reset",
            &repository.worktree,
            &["reset", "--hard", revision],
            None,
            None,
        )?;
        Ok(())
    }

    pub fn create_repository(
        &self,
        worktree: &Path,
        git_directory: &Path,
        seed: Option<&Repository>,
    ) -> Result<Repository, Error> {
        fs::create_dir_all(git_directory)
            .map_err(|e| error("create", git_directory, e.to_string()))?;
        let repository = Repository {
            worktree: worktree.into(),
            git_directory: git_directory.into(),
            common_directory: git_directory.into(),
        };
        self.repository("create", &repository, &["init"], None, None)?;
        for (key, value) in [
            ("core.autocrlf", "false"),
            ("core.longpaths", "true"),
            ("core.symlinks", "true"),
            ("core.fsmonitor", "false"),
            ("feature.manyFiles", "true"),
            ("index.version", "4"),
            ("index.threads", "true"),
            ("core.untrackedCache", "true"),
        ] {
            self.repository("create", &repository, &["config", key, value], None, None)?;
        }
        if let Some(seed) = seed {
            fs::create_dir_all(git_directory.join("objects/info"))
                .map_err(|e| error("create", git_directory, e.to_string()))?;
            fs::write(
                git_directory.join("objects/info/alternates"),
                format!(
                    "{}\n",
                    path_text(&seed.common_directory.join("objects"), "create")?
                ),
            )
            .map_err(|e| error("create", git_directory, e.to_string()))?;
            let _ = fs::copy(
                seed.git_directory.join("index"),
                git_directory.join("index"),
            );
        }
        Ok(repository)
    }

    pub fn refresh_index(
        &self,
        repository: &Repository,
        scope: &str,
        ignores: Option<&Repository>,
        maximum: Option<u64>,
    ) -> Result<Vec<String>, Error> {
        validate_relative(scope, "refresh", &repository.worktree)?;
        let tracked = split_nul(
            &self
                .repository(
                    "refresh",
                    repository,
                    &["diff-files", "--name-only", "-z", "--", scope],
                    None,
                    None,
                )?
                .text(),
        );
        let untracked = split_nul(
            &self
                .repository(
                    "refresh",
                    repository,
                    &[
                        "ls-files",
                        "--others",
                        "--exclude-standard",
                        "-z",
                        "--",
                        scope,
                    ],
                    None,
                    None,
                )?
                .text(),
        );
        let mut seen = HashSet::new();
        let candidates: Vec<_> = tracked
            .into_iter()
            .chain(untracked.iter().cloned())
            .filter(|file| seen.insert(file.clone()))
            .collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let ignored = if let Some(ignores) = ignores {
            self.ignored(
                ignores,
                &candidates.iter().map(String::as_str).collect::<Vec<_>>(),
            )
            .unwrap_or_default()
        } else {
            Vec::new()
        };
        let allowed: Vec<_> = candidates
            .iter()
            .filter(|file| !ignored.contains(file))
            .cloned()
            .collect();
        let skipped: Vec<_> = untracked
            .into_iter()
            .filter(|file| allowed.contains(file))
            .filter(|file| {
                maximum.is_some_and(|maximum| {
                    maximum != 0
                        && fs::metadata(repository.worktree.join(file))
                            .is_ok_and(|info| info.is_file() && info.len() > maximum)
                })
            })
            .collect();
        let remove: Vec<_> = ignored
            .iter()
            .chain(skipped.iter())
            .map(String::as_str)
            .collect();
        if !remove.is_empty() {
            self.repository(
                "refresh",
                repository,
                &[
                    "rm",
                    "--cached",
                    "-f",
                    "--ignore-unmatch",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                Some(&nul_bytes(&remove)),
                None,
            )?;
        }
        let stage: Vec<_> = allowed
            .iter()
            .filter(|file| !skipped.contains(file))
            .map(String::as_str)
            .collect();
        if !stage.is_empty() {
            self.repository(
                "refresh",
                repository,
                &[
                    "add",
                    "--all",
                    "--sparse",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                Some(&nul_bytes(&stage)),
                None,
            )?;
        }
        Ok(skipped)
    }

    pub fn ignored(&self, repository: &Repository, paths: &[&str]) -> Result<Vec<String>, Error> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        for path in paths {
            validate_relative(path, "list_files", &repository.worktree)?;
        }
        let args = [
            "--git-dir",
            path_text(&repository.git_directory, "list_files")?,
            "--work-tree",
            path_text(&repository.worktree, "list_files")?,
            "check-ignore",
            "--no-index",
            "--stdin",
            "-z",
        ];
        let output = self.run(
            "list_files",
            &repository.worktree,
            &args,
            Some(&nul_bytes(paths)),
            None,
        )?;
        if output.code != 0 && output.code != 1 {
            return Err(error("list_files", &repository.worktree, output.message()));
        }
        Ok(split_nul(&output.text()))
    }

    pub fn write_tree(&self, repository: &Repository) -> Result<String, Error> {
        Ok(self
            .repository("write_tree", repository, &["write-tree"], None, None)?
            .text()
            .trim()
            .into())
    }
    pub fn capture_tree(
        &self,
        repository: &Repository,
        scopes: &[&str],
        ignores: Option<&Repository>,
        maximum: Option<u64>,
    ) -> Result<String, Error> {
        self.locked(repository, || {
            for scope in scopes {
                self.refresh_index(repository, scope, ignores, maximum)?;
            }
            self.write_tree(repository)
        })
    }
    pub fn tree_files(
        &self,
        repository: &Repository,
        from: &str,
        to: &str,
    ) -> Result<Vec<String>, Error> {
        Ok(split_nul(
            &self
                .repository(
                    "list_files",
                    repository,
                    &["diff", "--name-only", "-z", from, to],
                    None,
                    None,
                )?
                .text(),
        ))
    }

    pub fn tree_diff(
        &self,
        repository: &Repository,
        from: &str,
        to: &str,
        context: usize,
        paths: Option<&[String]>,
    ) -> Result<Vec<Info>, Error> {
        let paths = match paths {
            Some(paths) => paths.to_vec(),
            None => self.tree_files(repository, from, to)?,
        };
        paths
            .iter()
            .map(|file| {
                validate_relative(file, "diff", &repository.worktree)?;
                let status = self
                    .repository(
                        "diff",
                        repository,
                        &[
                            "diff",
                            "--name-status",
                            "--no-renames",
                            from,
                            to,
                            "--",
                            file,
                        ],
                        None,
                        None,
                    )?
                    .text();
                let status = if status.starts_with('A') {
                    Status::Added
                } else if status.starts_with('D') {
                    Status::Deleted
                } else {
                    Status::Modified
                };
                let stats = self
                    .repository(
                        "diff",
                        repository,
                        &["diff", "--numstat", "--no-renames", from, to, "--", file],
                        None,
                        None,
                    )?
                    .text();
                let mut stats = stats.split('\t');
                let additions = stats.next().unwrap_or("0");
                let deletions = stats.next().unwrap_or("0");
                let binary = additions == "-" || deletions == "-";
                let count = |value: &str| {
                    NonNegativeInt::new(match value.trim() {
                        _ if binary => 0,
                        "" => 0,
                        text => text
                            .parse::<i64>()
                            .map_err(|e| error("diff", &repository.worktree, e.to_string()))?,
                    })
                    .map_err(|e| error("diff", &repository.worktree, e.to_string()))
                };
                let patch = if binary {
                    String::new()
                } else {
                    self.repository(
                        "diff",
                        repository,
                        &[
                            "diff",
                            &format!("--unified={context}"),
                            "--no-renames",
                            from,
                            to,
                            "--",
                            file,
                        ],
                        None,
                        None,
                    )?
                    .text()
                };
                Ok(Info {
                    file: file.as_str().into(),
                    status,
                    additions: count(additions)?,
                    deletions: count(deletions)?,
                    patch: patch.into(),
                })
            })
            .collect()
    }

    fn entry(
        &self,
        repository: &Repository,
        tree: &str,
        file: &str,
    ) -> Result<Option<(String, String)>, Error> {
        validate_relative(file, "restore", &repository.worktree)?;
        let text = self
            .repository(
                "restore",
                repository,
                &["ls-tree", "-z", tree, "--", file],
                None,
                None,
            )?
            .text();
        if text.is_empty() {
            return Ok(None);
        }
        let header = text.split('\t').next().unwrap_or("");
        let mut parts = header.split_whitespace();
        let mode = parts.next();
        let kind = parts.next();
        let object = parts.next();
        match (mode, kind, object) {
            (Some(mode), Some(_), Some(object))
                if mode.bytes().all(|c| c.is_ascii_digit())
                    && object.bytes().all(|c| c.is_ascii_hexdigit()) =>
            {
                Ok(Some((mode.into(), object.into())))
            }
            _ => Err(error(
                "restore",
                &repository.worktree,
                format!("Invalid tree entry for {file}"),
            )),
        }
    }
    pub fn read_tree(
        &self,
        repository: &Repository,
        tree: &str,
        file: &str,
    ) -> Result<Option<Vec<u8>>, Error> {
        let Some((_, object)) = self.entry(repository, tree, file)? else {
            return Ok(None);
        };
        Ok(Some(
            self.repository(
                "read_tree",
                repository,
                &["cat-file", "blob", &object],
                None,
                None,
            )?
            .stdout,
        ))
    }

    pub fn preview(
        &self,
        repository: &Repository,
        current: &str,
        files: &[(String, String)],
        context: usize,
    ) -> Result<Vec<Info>, Error> {
        self.locked(repository, || {
            let index = repository.git_directory.join(format!(
                "preview-{}-{}.index",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let result = (|| {
                self.repository(
                    "diff",
                    repository,
                    &["read-tree", current],
                    None,
                    Some(&index),
                )?;
                for (file, tree) in files {
                    match self.entry(repository, tree, file)? {
                        None => {
                            self.repository(
                                "diff",
                                repository,
                                &["update-index", "--force-remove", "--", file],
                                None,
                                Some(&index),
                            )?;
                        }
                        Some((mode, object)) => {
                            self.repository(
                                "diff",
                                repository,
                                &["update-index", "--add", "--cacheinfo", &mode, &object, file],
                                None,
                                Some(&index),
                            )?;
                        }
                    }
                }
                let target = self
                    .repository("diff", repository, &["write-tree"], None, Some(&index))?
                    .text();
                self.tree_diff(
                    repository,
                    current,
                    target.trim(),
                    context,
                    Some(
                        &files
                            .iter()
                            .map(|(file, _)| file.clone())
                            .collect::<Vec<_>>(),
                    ),
                )
            })();
            let cleanup = fs::remove_file(&index);
            match cleanup {
                Err(cause) if cause.kind() != io::ErrorKind::NotFound => {
                    Err(error("diff", &repository.worktree, cause.to_string()))
                }
                _ => result,
            }
        })
    }

    pub fn restore(
        &self,
        repository: &Repository,
        files: &[(String, String)],
    ) -> Result<(), Error> {
        self.locked(repository, || {
            for (file, tree) in files {
                if self.entry(repository, tree, file)?.is_some() {
                    self.repository(
                        "restore",
                        repository,
                        &["checkout", tree, "--", file],
                        None,
                        None,
                    )?;
                    continue;
                }
                let path = repository.worktree.join(file);
                let removal = fs::symlink_metadata(&path).and_then(|info| {
                    if info.is_dir() {
                        fs::remove_dir_all(&path)
                    } else {
                        fs::remove_file(&path)
                    }
                });
                if let Err(cause) = removal
                    && cause.kind() != io::ErrorKind::NotFound
                {
                    return Err(error("restore", &repository.worktree, cause.to_string()));
                }
            }
            Ok(())
        })
    }
    pub fn checkout_tree(&self, repository: &Repository, tree: &str) -> Result<(), Error> {
        self.locked(repository, || {
            self.repository("restore", repository, &["read-tree", tree], None, None)?;
            self.repository(
                "restore",
                repository,
                &["checkout-index", "--all", "--force"],
                None,
                None,
            )?;
            Ok(())
        })
    }

    pub fn capture_changes(&self, repository: &Repository, path: &Path) -> Result<String, Error> {
        let scope = relative_scope(repository, path, "capture")?;
        let tracked = self
            .checked(
                "capture",
                &repository.worktree,
                &["diff", "--binary", "HEAD", "--", &scope],
                None,
                None,
            )?
            .text();
        let untracked = self
            .checked(
                "capture",
                &repository.worktree,
                &[
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    &scope,
                ],
                None,
                None,
            )?
            .text();
        let mut changes = vec![tracked];
        for file in split_nul(&untracked) {
            let output = self.run(
                "capture",
                &repository.worktree,
                &["diff", "--binary", "--no-index", "--", "/dev/null", &file],
                None,
                None,
            )?;
            if output.code != 0 && output.code != 1 {
                return Err(error("capture", path, output.message()));
            }
            changes.push(output.text());
        }
        Ok(changes
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n"))
    }
    pub fn apply_changes(
        &self,
        _repository: &Repository,
        path: &Path,
        changes: &str,
    ) -> Result<(), Error> {
        self.checked(
            "apply",
            path,
            &["apply", "-"],
            Some(changes.as_bytes()),
            None,
        )?;
        Ok(())
    }
    pub fn discard(
        &self,
        repository: &Repository,
        path: &Path,
        index: IndexPolicy,
        untracked: UntrackedPolicy,
    ) -> Result<(), Error> {
        let scope = relative_scope(repository, path, "reset")?;
        let args = match index {
            IndexPolicy::Preserve => vec!["checkout", "--", &scope],
            IndexPolicy::Reset => vec!["checkout", "HEAD", "--", &scope],
        };
        self.checked("reset", &repository.worktree, &args, None, None)?;
        if matches!(untracked, UntrackedPolicy::Remove) {
            self.checked(
                "reset",
                &repository.worktree,
                &["clean", "-fd", "--", &scope],
                None,
                None,
            )?;
        }
        Ok(())
    }
}

fn bounded(mut input: impl Read, limit: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::new();
    let mut truncated = false;
    let mut buffer = [0; 8192];
    loop {
        let size = input.read(&mut buffer)?;
        if size == 0 {
            return Ok((output, truncated));
        }
        let take = size.min(limit.saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..take]);
        truncated |= take < size;
    }
}
pub(crate) fn error(
    operation: &'static str,
    directory: &Path,
    message: impl Into<String>,
) -> Error {
    Error {
        operation,
        directory: directory.into(),
        message: message.into(),
        force_required: false,
        unknown_outcome: false,
    }
}
pub(crate) fn path_text<'a>(path: &'a Path, operation: &'static str) -> Result<&'a str, Error> {
    path.to_str()
        .ok_or_else(|| error(operation, path, "Path is not UTF-8"))
}
fn split_nul(text: &str) -> Vec<String> {
    text.split('\0')
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}
fn nul_bytes(paths: &[&str]) -> Vec<u8> {
    format!("{}\0", paths.join("\0")).into_bytes()
}
fn validate_relative(path: &str, operation: &'static str, worktree: &Path) -> Result<(), Error> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || !contains(worktree, &worktree.join(path))
        || path.contains('\0')
    {
        return Err(error(operation, worktree, "Path escapes the repository"));
    }
    Ok(())
}
fn relative_scope(
    repository: &Repository,
    path: &Path,
    operation: &'static str,
) -> Result<String, Error> {
    let path = normalize(path);
    let relative = path
        .strip_prefix(&repository.worktree)
        .map_err(|_| error(operation, path.as_path(), "Path escapes the repository"))?;
    Ok(if relative.as_os_str().is_empty() {
        ".".into()
    } else {
        path_text(relative, operation)?.replace('\\', "/")
    })
}
