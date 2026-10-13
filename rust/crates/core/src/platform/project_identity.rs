use super::{filesystem, git};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VcsKind {
    Git,
    Hg,
}

impl VcsKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Git => "git",
            Self::Hg => "hg",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Vcs {
    pub kind: VcsKind,
    pub store: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub previous: Option<String>,
    pub id: String,
    pub directory: PathBuf,
    pub vcs: Option<Vcs>,
}

pub const GLOBAL: &str = "global";

pub fn resolve(git: &git::Service, input: &Path) -> Result<Resolved, git::Error> {
    if let Some(repository) = git.discover(input)? {
        let previous = cached(&repository.common_directory);
        let id = match remote(git, &repository)? {
            Some(id) => Some(id),
            None => match &previous {
                Some(previous) => Some(previous.clone()),
                None => git.root_commits(&repository)?.into_iter().next(),
            },
        };
        return Ok(Resolved {
            previous,
            id: id.unwrap_or_else(|| GLOBAL.into()),
            directory: repository.worktree,
            vcs: Some(Vcs {
                kind: VcsKind::Git,
                store: repository.common_directory,
            }),
        });
    }
    let input = filesystem::normalize(&std::path::absolute(input).map_err(|cause| git::Error {
        operation: "discover",
        directory: input.into(),
        message: cause.to_string(),
        force_required: false,
        unknown_outcome: false,
    })?);
    if let Some(store) = input
        .ancestors()
        .map(|directory| directory.join(".hg"))
        .find(|store| store.exists())
    {
        let worktree = store.parent().unwrap_or(&input).to_path_buf();
        let previous = cached(&store);
        let id = previous.clone().or_else(|| hg_root(git, &worktree));
        return Ok(Resolved {
            previous,
            id: id.unwrap_or_else(|| GLOBAL.into()),
            directory: worktree,
            vcs: Some(Vcs {
                kind: VcsKind::Hg,
                store,
            }),
        });
    }
    Ok(Resolved {
        previous: None,
        id: GLOBAL.into(),
        directory: input
            .components()
            .take_while(|component| matches!(component, Component::Prefix(_) | Component::RootDir))
            .collect(),
        vcs: None,
    })
}

pub fn remote_id(origin: &str) -> Option<String> {
    let normalized = normalize_remote(origin)?;
    Some(
        ring::digest::digest(
            &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
            format!("git-remote:{normalized}").as_bytes(),
        )
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect(),
    )
}

pub fn normalize_remote(input: &str) -> Option<String> {
    let value = filesystem::trim(input);
    if value.is_empty() {
        return None;
    }
    if let Ok(parsed) = url::Url::parse(value) {
        if parsed.scheme() == "file" {
            return None;
        }
        return parts(parsed.host_str().unwrap_or(""), parsed.path());
    }
    // Mirrors /^([^@/:]+@)?([^/:]+):(.+)$/: the first colon ends the host, and the optional
    // user prefix is the text before the first `@` only when a nonempty host follows it.
    let (prefix, name) = value.split_once(':')?;
    if prefix.is_empty()
        || prefix.contains('/')
        || name.is_empty()
        || name.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
    {
        return None;
    }
    let host = match prefix.split_once('@') {
        Some((user, host)) if !user.is_empty() && !host.is_empty() => host,
        _ => prefix,
    };
    parts(host, name)
}

fn parts(host: &str, name: &str) -> Option<String> {
    let name = name.trim_start_matches('/');
    let name = name
        .strip_suffix(".git/")
        .or_else(|| name.strip_suffix(".git"))
        .unwrap_or(name)
        .trim_end_matches('/');
    (!host.is_empty() && !name.is_empty()).then(|| format!("{}/{name}", host.to_lowercase()))
}

fn remote(git: &git::Service, repository: &git::Repository) -> Result<Option<String>, git::Error> {
    Ok(git
        .remote(repository, "origin")?
        .and_then(|origin| remote_id(&origin)))
}

fn cached(store: &Path) -> Option<String> {
    let bytes = std::fs::read(store.join("ycoding")).ok()?;
    let value = filesystem::trim(&String::from_utf8_lossy(&bytes)).to_owned();
    (!value.is_empty()).then_some(value)
}

fn hg_root(git: &git::Service, worktree: &Path) -> Option<String> {
    let output = git
        .run_program(
            "hg",
            "project",
            worktree,
            &["log", "-r", "roots(all())", "-T", "{node}\n"],
            None,
            None,
        )
        .ok()
        .filter(|output| output.code == 0)?;
    let mut nodes = output
        .text()
        .split('\n')
        .map(filesystem::trim)
        .filter(|node| !node.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    nodes.sort();
    nodes.into_iter().next()
}
