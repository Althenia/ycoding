use super::glob;
use std::io;

pub const FOLDERS: &[&str] = &[
    "node_modules",
    "bower_components",
    ".pnpm-store",
    "vendor",
    ".npm",
    "dist",
    "build",
    "out",
    ".next",
    "target",
    "bin",
    "obj",
    ".git",
    ".svn",
    ".hg",
    ".vscode",
    ".idea",
    ".turbo",
    ".output",
    "desktop",
    ".sst",
    ".cache",
    ".webkit-cache",
    "__pycache__",
    ".pytest_cache",
    "mypy_cache",
    ".history",
    ".gradle",
];
pub const FILES: &[&str] = &[
    "**/*.swp",
    "**/*.swo",
    "**/*.pyc",
    "**/.DS_Store",
    "**/Thumbs.db",
    "**/logs/**",
    "**/tmp/**",
    "**/temp/**",
    "**/*.log",
    "**/coverage/**",
    "**/.nyc_output/**",
];

pub fn patterns() -> Vec<String> {
    FILES
        .iter()
        .chain(FOLDERS)
        .map(|value| value.to_string())
        .chain([format!("**/{{{}}}/**", FOLDERS.join(","))])
        .collect()
}

pub fn matches(path: &str, extra: &[String], whitelist: &[String]) -> io::Result<bool> {
    for pattern in whitelist {
        if glob::matches(pattern, path)? {
            return Ok(false);
        }
    }
    if path.split(['/', '\\']).any(|part| FOLDERS.contains(&part)) {
        return Ok(true);
    }
    for pattern in FILES
        .iter()
        .copied()
        .chain(extra.iter().map(String::as_str))
    {
        if glob::matches(pattern, path)? {
            return Ok(true);
        }
    }
    Ok(false)
}
