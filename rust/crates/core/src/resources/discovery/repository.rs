use std::{
    fmt,
    path::{Path, PathBuf},
};
use url::Url;
#[derive(Clone, Debug, PartialEq)]
pub struct Reference {
    pub host: String,
    pub path: String,
    pub segments: Vec<String>,
    pub owner: Option<String>,
    pub repo: String,
    pub remote: String,
    pub label: String,
    pub protocol: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    InvalidReference,
    UnsupportedLocalRepository,
    InvalidBranch,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self { Self::InvalidReference => "Repository must be a git URL, host/path reference, or GitHub owner/repo shorthand", Self::UnsupportedLocalRepository => "Local file repositories are not supported", Self::InvalidBranch => "Branch must contain only alphanumeric characters, /, _, ., and -, and cannot start with - or contain .." })
    }
}
impl std::error::Error for Error {}

pub fn parse(input: &str, github_base: Option<&str>) -> Option<Reference> {
    let input = super::trim(input);
    let input = input
        .strip_prefix("git+")
        .unwrap_or(input)
        .split('#')
        .next()?
        .trim_end_matches('/');
    if input.is_empty() {
        return None;
    }
    if let Some(rest) = input.strip_prefix("github:") {
        let segments = rest.split('/').collect::<Vec<_>>();
        if segments.len() == 2
            && segments
                .iter()
                .all(|s| !s.is_empty() && !s.chars().any(super::whitespace))
        {
            return build_remote(
                "github.com",
                segments.into_iter().map(String::from).collect(),
                None,
                None,
                github_base,
            );
        }
    }
    if !input.contains("://") {
        if let Some((host, name)) = input.split_once(':') {
            let host = match host.split_once('@') {
                Some((user, host))
                    if !user.is_empty()
                        && !user.chars().any(|c| c == '/' || super::whitespace(c)) =>
                {
                    host
                }
                Some(_) => "",
                None => host,
            };
            if !host.is_empty()
                && !host.chars().any(|c| c == '/' || super::whitespace(c))
                && !name.is_empty()
            {
                return build_remote(host, parts(name), Some(input), None, github_base);
            }
        }
        let segments = parts(input);
        if segments.len() >= 2
            && (segments[0].contains('.')
                || segments[0].contains(':')
                || segments[0] == "localhost")
        {
            return build_remote(
                &segments[0],
                segments[1..].to_vec(),
                None,
                None,
                github_base,
            );
        }
        if segments.len() == 2 {
            return build_remote("github.com", segments, None, None, github_base);
        }
    }
    let url = Url::parse(input).ok()?;
    if url.scheme() == "file" {
        let path = super::absolute(&url.to_file_path().ok()?).ok()?;
        let text = path.to_str()?;
        let segments = text
            .split(['/', '\\'])
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        let repo = trim_git(segments.last()?);
        return Some(Reference {
            host: "file".into(),
            path: text.into(),
            segments: segments
                .iter()
                .map(|s| s.trim_end_matches(':').to_string())
                .collect(),
            owner: None,
            repo: repo.into(),
            remote: input.into(),
            label: text.into(),
            protocol: Some("file:".into()),
        });
    }
    let host = &url[url::Position::BeforeHost..url::Position::AfterPort];
    let segments = parts(url.path());
    let remote = if host == "github.com" {
        github_remote(&segments.join("/"), github_base)?
    } else {
        input.into()
    };
    build_remote(
        host,
        segments,
        Some(&remote),
        Some(&format!("{}:", url.scheme())),
        github_base,
    )
}

pub fn parse_remote(input: &str, github_base: Option<&str>) -> Result<Reference, Error> {
    let reference = parse(input, github_base).ok_or(Error::InvalidReference)?;
    if reference.is_file() {
        return Err(Error::UnsupportedLocalRepository);
    }
    Ok(reference)
}
pub fn validate_branch(branch: &str) -> Result<(), Error> {
    if !branch.is_empty()
        && branch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
        && !branch.starts_with('-')
        && !branch.contains("..")
    {
        return Ok(());
    }
    Err(Error::InvalidBranch)
}
pub fn root(start: &Path) -> Result<Option<PathBuf>, super::Error> {
    let mut current = super::absolute(start)?;
    loop {
        for name in [".git", ".hg"] {
            let path = current.join(name);
            if path.try_exists().map_err(|e| super::io(&path, e))? {
                return Ok(Some(current));
            }
        }
        let Some(parent) = current.parent() else {
            return Ok(None);
        };
        current = parent.into();
    }
}
impl Reference {
    pub fn is_file(&self) -> bool {
        self.protocol.as_deref() == Some("file:")
    }
    pub fn cache_path(&self, root: &Path) -> PathBuf {
        self.host
            .split(':')
            .chain(self.segments.iter().map(String::as_str))
            .fold(root.to_path_buf(), |path, item| path.join(item))
    }
    pub fn cache_identity(&self) -> String {
        format!("{}/{}", self.host, self.path)
    }
    pub fn same(&self, other: &Self) -> bool {
        self.cache_identity() == other.cache_identity()
    }
}

fn trim_git(input: &str) -> &str {
    input.strip_suffix(".git").unwrap_or(input)
}
fn parts(input: &str) -> Vec<String> {
    input
        .split('/')
        .map(|s| trim_git(super::trim(s)))
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}
fn github_remote(path: &str, base: Option<&str>) -> Option<String> {
    let Some(base) = base.filter(|s| !s.is_empty()) else {
        return Some(format!("https://github.com/{path}.git"));
    };
    let base = if base.ends_with('/') {
        base.to_string()
    } else {
        format!("{base}/")
    };
    Some(
        Url::parse(&base)
            .ok()?
            .join(&format!("{path}.git"))
            .ok()?
            .to_string(),
    )
}
fn build_remote(
    host: &str,
    segments: Vec<String>,
    remote: Option<&str>,
    protocol: Option<&str>,
    github_base: Option<&str>,
) -> Option<Reference> {
    let segments = segments
        .iter()
        .map(|s| trim_git(s))
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect::<Vec<_>>();
    if host.is_empty()
        || host.starts_with('-')
        || host
            .chars()
            .any(|c| super::whitespace(c) || matches!(c, '/' | '\\'))
        || segments.is_empty()
        || segments.iter().any(|s| {
            s == "."
                || s == ".."
                || s.chars()
                    .any(|c| super::whitespace(c) || matches!(c, ':' | '/' | '\\'))
        })
    {
        return None;
    }
    let path = segments.join("/");
    let host = host.to_lowercase();
    let label = if host == "github.com" && segments.len() == 2 {
        path.clone()
    } else {
        format!("{host}/{path}")
    };
    Some(Reference {
        remote: match remote {
            Some(remote) => remote.into(),
            None if host == "github.com" => github_remote(&path, github_base)?,
            None => format!("https://{host}/{path}.git"),
        },
        owner: (segments.len() == 2).then(|| segments[0].clone()),
        repo: segments.last()?.clone(),
        host,
        path,
        segments,
        label,
        protocol: protocol.map(String::from),
    })
}
