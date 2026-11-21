use super::{Capture, Service};
use std::{collections::BTreeMap, path::Path};
use ycoding_schema::{
    file_diff::{Info, Status},
    schema::NonNegativeInt,
};

pub struct Branch {
    pub current: Option<String>,
    pub default: Option<String>,
}
pub struct FileStatus {
    pub file: String,
    pub additions: u64,
    pub deletions: u64,
    pub status: Status,
}
const MAX_PATCH: usize = 10_000_000;
const CFG: &[&str] = &[
    "--no-optional-locks",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.longpaths=true",
    "-c",
    "core.symlinks=true",
    "-c",
    "core.quotepath=false",
];

fn run(service: &Service, directory: &Path, args: &[&str]) -> String {
    let args = CFG
        .iter()
        .copied()
        .chain(args.iter().copied())
        .collect::<Vec<_>>();
    service
        .run("vcs", directory, &args, None, None)
        .map(|result| result.text())
        .unwrap_or_default()
}

fn patch(service: &Service, directory: &Path, args: &[&str]) -> (String, bool) {
    let args = CFG
        .iter()
        .copied()
        .chain(args.iter().copied())
        .collect::<Vec<_>>();
    service
        .capture(
            Capture {
                program: "git",
                limit: MAX_PATCH,
            },
            "vcs",
            directory,
            &args,
            None,
            None,
        )
        .map(|result| (result.text(), result.truncated))
        .unwrap_or_default()
}

fn empty(file: &str) -> String {
    super::super::diff::format_patch(&super::super::diff::structured_patch(
        file,
        file,
        "",
        "",
        Some(""),
        Some(""),
        0,
    ))
}

pub(super) fn split_patch(text: &str, truncated: bool) -> Vec<&str> {
    let starts = text
        .match_indices("diff --git ")
        .filter(|(index, _)| *index == 0 || text.as_bytes()[index - 1] == b'\n')
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    starts
        .iter()
        .enumerate()
        .filter_map(|(index, start)| {
            if truncated && index + 1 == starts.len() {
                return None;
            }
            Some(&text[*start..starts.get(index + 1).copied().unwrap_or(text.len())])
        })
        .collect()
}

fn success(service: &Service, directory: &Path, args: &[&str]) -> Option<String> {
    let args = CFG
        .iter()
        .copied()
        .chain(args.iter().copied())
        .collect::<Vec<_>>();
    service
        .run("vcs", directory, &args, None, None)
        .ok()
        .filter(|result| result.code == 0)
        .map(|result| result.text().trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn default(service: &Service, directory: &Path) -> Option<(String, String)> {
    let remotes = run(service, directory, &["remote"]);
    let remotes = remotes.lines().collect::<Vec<_>>();
    let remote = remotes
        .iter()
        .find(|remote| **remote == "origin")
        .copied()
        .or_else(|| (remotes.len() == 1).then(|| remotes[0]))
        .or_else(|| {
            remotes
                .iter()
                .find(|remote| **remote == "upstream")
                .copied()
        })
        .or_else(|| remotes.first().copied());
    if let Some(remote) = remote
        && let Some(reference) = success(
            service,
            directory,
            &["symbolic-ref", &format!("refs/remotes/{remote}/HEAD")],
        )
        && let Some(name) = reference.strip_prefix(&format!("refs/remotes/{remote}/"))
    {
        return Some((
            name.into(),
            reference.trim_start_matches("refs/remotes/").into(),
        ));
    }
    let branches = run(
        service,
        directory,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    );
    let configured = success(service, directory, &["config", "init.defaultBranch"]);
    configured
        .into_iter()
        .chain(["main".into(), "master".into()])
        .find(|name| branches.lines().any(|line| line == name))
        .map(|name| (name.clone(), name))
}

pub fn branch(service: &Service, directory: &Path) -> Branch {
    if !service
        .discover(directory)
        .is_ok_and(|repository| repository.is_some())
    {
        if let Some(root) = super::hg::root(directory) {
            return super::hg::branch(service, &root);
        }
        return Branch {
            current: None,
            default: None,
        };
    }
    Branch {
        current: success(
            service,
            directory,
            &["symbolic-ref", "--quiet", "--short", "HEAD"],
        ),
        default: default(service, directory).map(|(name, _)| name),
    }
}

fn kind(code: &str) -> Status {
    if code == "??" {
        return Status::Added;
    }
    if code.contains('U') {
        return Status::Modified;
    }
    if code.contains('A') && !code.contains('D') {
        return Status::Added;
    }
    if code.contains('D') && !code.contains('A') {
        return Status::Deleted;
    }
    Status::Modified
}

fn names(service: &Service, directory: &Path) -> BTreeMap<String, String> {
    run(
        service,
        directory,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--no-renames",
            "-z",
            "--",
            ".",
        ],
    )
    .split('\0')
    .filter_map(|item| {
        item.get(3..)
            .filter(|name| !name.is_empty())
            .map(|name| (name.into(), item[..2].into()))
    })
    .collect()
}

fn stats(service: &Service, directory: &Path, reference: &str) -> BTreeMap<String, (u64, u64)> {
    run(
        service,
        directory,
        &[
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--numstat",
            "-z",
            reference,
            "--",
            ".",
        ],
    )
    .split('\0')
    .filter_map(|item| {
        let mut parts = item.splitn(3, '\t');
        let adds = parts.next()?.parse().unwrap_or(0);
        let dels = parts.next()?.parse().unwrap_or(0);
        Some((parts.next()?.into(), (adds, dels)))
    })
    .collect()
}

fn untracked_stats(service: &Service, root: &Path, file: &str) -> (u64, u64) {
    let text = run(
        service,
        root,
        &["diff", "--no-index", "--numstat", "--", "/dev/null", file],
    );
    let mut parts = text.split('\t');
    (
        parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
        parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
    )
}

pub fn status(service: &Service, directory: &Path) -> Vec<FileStatus> {
    let Ok(Some(repository)) = service.discover(directory) else {
        return super::hg::root(directory)
            .map(|root| super::hg::status(service, directory, &root))
            .unwrap_or_default();
    };
    let stats = if success(service, directory, &["rev-parse", "--verify", "HEAD"]).is_some() {
        stats(service, directory, "HEAD")
    } else {
        BTreeMap::new()
    };
    let mut files = names(service, directory)
        .into_iter()
        .map(|(file, code)| {
            let status = kind(&code);
            let (additions, deletions) = stats.get(&file).copied().unwrap_or_else(|| {
                if status == Status::Added {
                    untracked_stats(service, &repository.worktree, &file)
                } else {
                    (0, 0)
                }
            });
            FileStatus {
                file,
                additions,
                deletions,
                status,
            }
        })
        .collect::<Vec<_>>();
    files.sort_by(|a, b| {
        super::super::filesystem::collation::compare(
            &a.file.encode_utf16().collect::<Vec<_>>(),
            &b.file.encode_utf16().collect::<Vec<_>>(),
        )
    });
    files
}

pub fn diff(
    service: &Service,
    directory: &Path,
    branch_mode: bool,
    context: Option<u64>,
) -> Vec<Info> {
    let Ok(Some(repository)) = service.discover(directory) else {
        return super::hg::root(directory)
            .map(|root| super::hg::diff(service, directory, &root, branch_mode, context))
            .unwrap_or_default();
    };
    let reference = if branch_mode {
        let Some((name, reference)) = default(service, directory) else {
            return Vec::new();
        };
        if branch(service, directory).current.as_deref() == Some(&name) {
            return Vec::new();
        }
        let Some(base) = success(service, directory, &["merge-base", &reference, "HEAD"]) else {
            return Vec::new();
        };
        Some(base)
    } else {
        success(service, directory, &["rev-parse", "--verify", "HEAD"]).map(|_| "HEAD".into())
    };
    let working = names(service, directory);
    let mut tracked = Vec::new();
    let mut names = if let Some(reference) = &reference {
        let text = run(
            service,
            directory,
            &[
                "diff",
                "--no-ext-diff",
                "--no-renames",
                "--name-status",
                "-z",
                reference,
                "--",
                ".",
            ],
        );
        tracked = text
            .split('\0')
            .collect::<Vec<_>>()
            .chunks(2)
            .filter(|pair| pair.len() == 2 && !pair[1].is_empty())
            .map(|pair| (pair[1].to_owned(), pair[0].to_owned()))
            .collect();
        tracked
            .iter()
            .cloned()
            .collect::<BTreeMap<String, String>>()
    } else {
        working.clone()
    };
    for (file, code) in working {
        if code == "??" {
            names.entry(file).or_insert(code);
        }
    }
    let stats = reference
        .as_ref()
        .map(|reference| stats(service, directory, reference))
        .unwrap_or_default();
    let unified = format!("--unified={}", context.unwrap_or(2_147_483_647));
    let batch = reference
        .as_ref()
        .filter(|_| !tracked.is_empty())
        .map(|reference| {
            patch(
                service,
                directory,
                &[
                    "diff",
                    "--patch",
                    "--no-ext-diff",
                    "--no-renames",
                    &unified,
                    reference,
                    "--",
                    ".",
                ],
            )
        })
        .unwrap_or_default();
    let batch_patches = split_patch(&batch.0, batch.1)
        .iter()
        .zip(&tracked)
        .map(|(patch, (file, _))| (file.clone(), (*patch).to_owned()))
        .collect::<BTreeMap<_, _>>();
    let mut total = 0;
    let mut capped = false;
    let mut files = names.into_iter().collect::<Vec<_>>();
    files.sort_by(|a, b| {
        super::super::filesystem::collation::compare(
            &a.0.encode_utf16().collect::<Vec<_>>(),
            &b.0.encode_utf16().collect::<Vec<_>>(),
        )
    });
    files
        .into_iter()
        .map(|(file, code)| {
            let status = kind(&code);
            let (additions, deletions) = stats.get(&file).copied().unwrap_or_else(|| {
                if status == Status::Added {
                    untracked_stats(service, &repository.worktree, &file)
                } else {
                    (0, 0)
                }
            });
            let patch = if capped {
                empty(&file)
            } else if let Some(batched) = batch_patches.get(&file) {
                batched.clone()
            } else if code != "??" && batch.1 {
                empty(&file)
            } else {
                let result = if code == "??" || reference.is_none() {
                    patch(
                        service,
                        &repository.worktree,
                        &[
                            "diff",
                            "--no-index",
                            "--patch",
                            "--no-ext-diff",
                            "--no-renames",
                            &unified,
                            "--",
                            "/dev/null",
                            &file,
                        ],
                    )
                } else {
                    patch(
                        service,
                        &repository.worktree,
                        &[
                            "diff",
                            "--patch",
                            "--no-ext-diff",
                            "--no-renames",
                            &unified,
                            reference.as_deref().unwrap_or("HEAD"),
                            "--",
                            &file,
                        ],
                    )
                };
                if result.1 || result.0.is_empty() {
                    empty(&file)
                } else {
                    result.0
                }
            };
            let patch = if total + patch.len() > MAX_PATCH {
                capped = true;
                empty(&file)
            } else {
                if !capped {
                    total += patch.len();
                    capped = total >= MAX_PATCH;
                }
                patch
            };
            Info {
                file: file.into(),
                patch: patch.into(),
                additions: NonNegativeInt::new(additions as i64).expect("bounded diff additions"),
                deletions: NonNegativeInt::new(deletions as i64).expect("bounded diff deletions"),
                status,
            }
        })
        .collect()
}
