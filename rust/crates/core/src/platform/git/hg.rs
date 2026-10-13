use super::super::{
    diff::{format_patch, structured_patch},
    filesystem,
};
use super::{
    Capture, Service,
    vcs::{Branch, FileStatus},
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use ycoding_schema::{
    file_diff::{Info, Status},
    schema::NonNegativeInt,
};
const MAX_PATCH: usize = 10_000_000;

pub fn root(directory: &Path) -> Option<PathBuf> {
    directory
        .ancestors()
        .find(|path| path.join(".hg").is_dir())
        .map(Path::to_path_buf)
}
fn run(service: &Service, root: &Path, args: &[&str]) -> Option<String> {
    service
        .run_program("hg", "vcs", root, args, None, None)
        .ok()
        .filter(|output| output.code == 0)
        .map(|output| output.text())
}
pub fn branch(service: &Service, root: &Path) -> Branch {
    Branch {
        current: run(service, root, &["branch"])
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty()),
        default: run(
            service,
            root,
            &["log", "-r", "max(branch(default))", "-T", "{branch}"],
        )
        .filter(|text| text.trim() == "default")
        .map(|_| "default".into()),
    }
}
fn kind(code: &str) -> Status {
    match code {
        "A" | "?" => Status::Added,
        "R" | "!" => Status::Deleted,
        _ => Status::Modified,
    }
}
fn names(
    service: &Service,
    root: &Path,
    scope: &str,
    revision: Option<&str>,
) -> Vec<(String, String)> {
    let mut args = vec!["status", "-0"];
    if let Some(revision) = revision {
        args.extend(["--rev", revision]);
    }
    args.extend(["--", scope]);
    let mut names = run(service, root, &args)
        .unwrap_or_default()
        .split('\0')
        .filter_map(|entry| {
            entry
                .get(2..)
                .filter(|file| !file.is_empty())
                .map(|file| (file.into(), entry[..1].into()))
        })
        .collect::<Vec<(String, String)>>();
    names.sort_by(|a, b| {
        filesystem::collation::compare(
            &a.0.encode_utf16().collect::<Vec<_>>(),
            &b.0.encode_utf16().collect::<Vec<_>>(),
        )
    });
    names
}
fn chunks(text: &str, truncated: bool) -> BTreeMap<String, String> {
    let mut chunks = BTreeMap::new();
    let mut current = String::new();
    let mut file = None;
    for line in super::vcs::split_patch(text, truncated)
        .into_iter()
        .flat_map(|chunk| chunk.split_inclusive('\n'))
    {
        if let Some(header) = line.strip_prefix("diff --git ") {
            if let Some(file) = file.take() {
                chunks.insert(file, std::mem::take(&mut current));
            }
            file = header
                .rsplit_once(" b/")
                .map(|(_, file)| file.trim_end_matches('\n').to_owned());
        }
        current.push_str(line);
    }
    if let Some(file) = file
        && current.len() <= MAX_PATCH
    {
        chunks.insert(file, current);
    }
    chunks
}
pub fn diff(
    service: &Service,
    directory: &Path,
    root: &Path,
    branch_mode: bool,
    context: Option<u64>,
) -> Vec<Info> {
    let revision = if branch_mode {
        let branch = branch(service, root).current;
        if branch.as_deref().is_none_or(|branch| branch == "default") {
            return Vec::new();
        }
        let Some(revision) = run(
            service,
            root,
            &["log", "-r", "ancestor(., default)", "-T", "{node}"],
        )
        .filter(|text| !text.trim().is_empty()) else {
            return Vec::new();
        };
        Some(revision)
    } else {
        None
    };
    let scope = directory
        .strip_prefix(root)
        .ok()
        .filter(|path| !path.as_os_str().is_empty())
        .and_then(Path::to_str)
        .unwrap_or(".");
    let context = context.unwrap_or(2_147_483_647).to_string();
    let mut args = vec!["diff", "--git", "--unified", &context];
    if let Some(revision) = revision.as_deref() {
        args.extend(["-r", revision]);
    }
    args.extend(["--", scope]);
    let batch = service
        .capture(
            Capture {
                program: "hg",
                limit: MAX_PATCH,
            },
            "vcs",
            root,
            &args,
            None,
            None,
        )
        .ok()
        .filter(|output| output.code == 0);
    let mut chunks = batch
        .map(|batch| chunks(&batch.text(), batch.truncated))
        .unwrap_or_default();
    names(service, root, scope, revision.as_deref())
        .into_iter()
        .map(|(file, code)| {
            let patch = chunks.remove(&file).unwrap_or_else(|| {
                let content = if code == "?" {
                    filesystem::Location::new(directory)
                        .ok()
                        .and_then(|location| location.resolve(root.join(&file).to_str()?).ok())
                        .and_then(|path| {
                            if std::fs::metadata(&path).ok()?.len() > MAX_PATCH as u64 {
                                return None;
                            }
                            std::fs::read(path).ok()
                        })
                        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                } else if code == "!" {
                    run(
                        service,
                        root,
                        &["cat", "-r", revision.as_deref().unwrap_or("."), "--", &file],
                    )
                    .filter(|text| text.len() <= MAX_PATCH)
                } else {
                    None
                };
                let content = content.unwrap_or_default();
                let (old, new) = if code == "!" {
                    (content.as_str(), "")
                } else if code == "?" {
                    ("", content.as_str())
                } else {
                    ("", "")
                };
                format_patch(&structured_patch(
                    &file,
                    &file,
                    old,
                    new,
                    Some(""),
                    Some(""),
                    0,
                ))
            });
            let adds = patch
                .lines()
                .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                .count();
            let dels = patch
                .lines()
                .filter(|line| line.starts_with('-') && !line.starts_with("---"))
                .count();
            Info {
                file: file.into(),
                patch: patch.into(),
                additions: NonNegativeInt::new(adds as i64).expect("bounded additions"),
                deletions: NonNegativeInt::new(dels as i64).expect("bounded deletions"),
                status: kind(&code),
            }
        })
        .collect()
}
pub fn status(service: &Service, directory: &Path, root: &Path) -> Vec<FileStatus> {
    diff(service, directory, root, false, Some(0))
        .into_iter()
        .map(|item| FileStatus {
            file: item.file.to_utf8().unwrap_or_default(),
            additions: item.additions.get() as u64,
            deletions: item.deletions.get() as u64,
            status: item.status,
        })
        .collect()
}
