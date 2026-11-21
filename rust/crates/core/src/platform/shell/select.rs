use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub fn name(file: &str) -> String {
    #[cfg(windows)]
    {
        return windows_name(file);
    }
    #[cfg(unix)]
    Path::new(file)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
}
pub fn login(file: &str) -> bool {
    matches!(
        name(file).as_str(),
        "bash" | "dash" | "fish" | "ksh" | "sh" | "zsh"
    )
}
pub fn posix(file: &str) -> bool {
    matches!(name(file).as_str(), "bash" | "dash" | "ksh" | "sh" | "zsh")
}
pub fn is_acceptable(file: &str) -> bool {
    !matches!(name(file).as_str(), "fish" | "nu")
}
pub fn args(file: &str, command: &str) -> Vec<String> {
    match name(file).as_str() {
        "cmd" => vec!["/c".into(), command.into()],
        "powershell" | "pwsh" => vec!["-NoProfile".into(), "-Command".into(), command.into()],
        _ => vec!["-c".into(), command.into()],
    }
}
#[derive(Clone, Debug, Default)]
pub struct Options {
    pub gitbash: Option<String>,
}
pub fn preferred(
    configured: Option<&str>,
    env: &BTreeMap<String, String>,
    options: &Options,
) -> PathBuf {
    #[cfg(windows)]
    {
        return PathBuf::from(windows_preferred(
            configured,
            env,
            options.gitbash.as_deref(),
            |file| resolve(file, env).map(|path| path.to_string_lossy().into_owned()),
            |file| Path::new(file).is_file(),
        ));
    }
    #[cfg(unix)]
    let _ = options;
    #[cfg(unix)]
    if let Some(shell) = configured
        .filter(|shell| !shell.is_empty())
        .or_else(|| env.get("SHELL").map(String::as_str))
        && let Some(shell) = resolve(shell, env)
    {
        return shell;
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/bin/zsh")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        resolve("bash", env).unwrap_or_else(|| PathBuf::from("/bin/sh"))
    }
}
pub fn resolve(file: &str, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    if Path::new(file).is_absolute() {
        return Path::new(file).is_file().then(|| PathBuf::from(file));
    }
    let paths = env.get("PATH")?;
    std::env::split_paths(paths).find_map(|directory| {
        let path = directory.join(file);
        if path.is_file() {
            return Some(path);
        }
        #[cfg(windows)]
        {
            for extension in env
                .get("PATHEXT")
                .map(String::as_str)
                .unwrap_or(".COM;.EXE;.BAT;.CMD")
                .split(';')
            {
                let path = directory.join(format!("{file}{extension}"));
                if path.is_file() {
                    return Some(path);
                }
            }
        }
        None
    })
}
pub fn windows_name(file: &str) -> String {
    let base = file.rsplit(['/', '\\']).next().unwrap_or_default();
    base.rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map_or(base, |(stem, _)| stem)
        .to_lowercase()
}
pub fn windows_path(file: &str) -> String {
    let rest = file
        .strip_prefix("/cygdrive/")
        .or_else(|| file.strip_prefix("/mnt/"))
        .or_else(|| file.strip_prefix('/'));
    if let Some(rest) = rest {
        let bytes = rest.as_bytes();
        if bytes.first().is_some_and(u8::is_ascii_alphabetic) {
            let tail = if bytes.get(1) == Some(&b':') {
                &rest[2..]
            } else {
                &rest[1..]
            };
            if tail.is_empty() || tail.starts_with('/') || tail.starts_with('\\') {
                return format!(
                    "{}:/{}",
                    (bytes[0] as char).to_ascii_uppercase(),
                    tail.strip_prefix(['/', '\\']).unwrap_or(tail)
                );
            }
        }
    }
    file.to_owned()
}
pub fn windows_preferred(
    configured: Option<&str>,
    env: &BTreeMap<String, String>,
    override_gitbash: Option<&str>,
    find: impl Fn(&str) -> Option<String>,
    is_file: impl Fn(&str) -> bool,
) -> String {
    windows_select(configured, env, override_gitbash, false, find, is_file)
}
pub fn windows_acceptable(
    configured: Option<&str>,
    env: &BTreeMap<String, String>,
    override_gitbash: Option<&str>,
    find: impl Fn(&str) -> Option<String>,
    is_file: impl Fn(&str) -> bool,
) -> String {
    windows_select(configured, env, override_gitbash, true, find, is_file)
}
fn windows_select(
    configured: Option<&str>,
    env: &BTreeMap<String, String>,
    override_gitbash: Option<&str>,
    acceptable: bool,
    find: impl Fn(&str) -> Option<String>,
    is_file: impl Fn(&str) -> bool,
) -> String {
    let gitbash = override_gitbash
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let git = find("git")?.replace('\\', "/");
            let directory = git.rsplit_once('/')?.0.rsplit_once('/')?.0;
            let bash = format!("{directory}/bin/bash.exe");
            is_file(&bash).then_some(bash)
        });
    let full = |file: &str| {
        let path = windows_path(file);
        if windows_name(&path) == "bash" && (path.starts_with('/') || !path.contains(['/', '\\'])) {
            return gitbash.clone().or_else(|| find(&path)).unwrap_or(path);
        }
        if path.contains(['/', '\\']) {
            return path;
        }
        find(&path).unwrap_or(path)
    };
    if let Some(file) = configured
        .filter(|file| !file.is_empty())
        .or_else(|| env.get("SHELL").map(String::as_str))
        .filter(|file| !acceptable || !matches!(windows_name(file).as_str(), "fish" | "nu"))
    {
        let path = full(file);
        if is_file(&path) {
            return path;
        }
        if !path.contains(['/', '\\'])
            && let Some(path) = find(&path)
        {
            return path;
        }
    }
    find("pwsh")
        .or_else(|| find("powershell"))
        .or_else(|| gitbash.clone())
        .map(|path| full(&path))
        .unwrap_or_else(|| {
            full(
                env.get("COMSPEC")
                    .filter(|path| !path.is_empty())
                    .map_or("cmd.exe", String::as_str),
            )
        })
}
pub fn acceptable(
    configured: Option<&str>,
    env: &BTreeMap<String, String>,
    options: &Options,
) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(windows_acceptable(
            configured,
            env,
            options.gitbash.as_deref(),
            |file| resolve(file, env).map(|path| path.to_string_lossy().into_owned()),
            |file| Path::new(file).is_file(),
        ))
    }
    #[cfg(unix)]
    {
        let selected = configured
            .filter(|shell| !shell.is_empty())
            .or_else(|| env.get("SHELL").map(String::as_str));
        if selected.is_some_and(|shell| !is_acceptable(shell)) {
            let mut env = env.clone();
            env.remove("SHELL");
            return preferred(None, &env, options);
        }
        preferred(configured, env, options)
    }
}
