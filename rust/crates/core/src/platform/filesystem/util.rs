use super::normalize;
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use ycoding_schema::{JsonValue, parse_json, stringify_json};

pub fn is_dir(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|info| info.is_dir())
}
pub fn is_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|info| info.is_file())
}
pub fn exists_safe(path: &Path) -> bool {
    path.try_exists().unwrap_or(false)
}

pub fn read_file_string_safe(path: &Path) -> io::Result<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(
            String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
                .into_owned(),
        )),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub fn read_json(path: &Path) -> io::Result<JsonValue> {
    let bytes = fs::read(path)?;
    parse_json(&String::from_utf8_lossy(
        bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes),
    ))
    .map_err(io::Error::other)
}

pub fn write_json(path: &Path, value: &JsonValue, mode: Option<u32>) -> io::Result<()> {
    let text = stringify_json(value);
    let chars: Vec<_> = text.chars().collect();
    let mut output = String::new();
    let mut depth = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (i, c) in chars.iter().copied().enumerate() {
        if quoted {
            output.push(c);
            if c == '"' && !escaped {
                quoted = false;
            }
            escaped = c == '\\' && !escaped;
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                output.push(c);
            }
            '{' | '[' => {
                output.push(c);
                depth += 1;
                if !matches!(chars.get(i + 1), Some('}' | ']')) {
                    output.push('\n');
                    output.push_str(&"  ".repeat(depth));
                }
            }
            '}' | ']' => {
                depth -= 1;
                if i > 0 && !matches!(chars[i - 1], '{' | '[') {
                    output.push('\n');
                    output.push_str(&"  ".repeat(depth));
                }
                output.push(c);
            }
            ',' => {
                output.push_str(",\n");
                output.push_str(&"  ".repeat(depth));
            }
            ':' => output.push_str(": "),
            c => output.push(c),
        }
    }
    fs::write(path, output)?;
    set_mode(path, mode)
}

pub fn ensure_dir(path: &Path) -> io::Result<()> {
    match fs::create_dir_all(path) {
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists && is_dir(path) => Ok(()),
        result => result,
    }
}

pub fn write_with_dirs(path: &Path, content: &[u8], mode: Option<u32>) -> io::Result<()> {
    match fs::write(path, content) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            ensure_dir(
                path.parent()
                    .ok_or_else(|| io::Error::other("File has no parent"))?,
            )?;
            fs::write(path, content)?;
        }
        result => result?,
    }
    set_mode(path, mode)
}

fn set_mode(path: &Path, mode: Option<u32>) -> io::Result<()> {
    if let Some(mode) = mode.filter(|mode| *mode != 0) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        {
            let mut permissions = fs::metadata(path)?.permissions();
            permissions.set_readonly(mode & 0o200 == 0);
            fs::set_permissions(path, permissions)?;
        }
    }
    Ok(())
}

pub fn resolve(path: &Path) -> io::Result<PathBuf> {
    let path = if cfg!(windows) {
        PathBuf::from(windows_path(&path.to_string_lossy(), "win32"))
    } else {
        path.to_path_buf()
    };
    let absolute = normalize(&std::path::absolute(path)?);
    match fs::canonicalize(&absolute) {
        Ok(path) => Ok(native_path(path)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(absolute),
        Err(error) => Err(error),
    }
}

pub fn windows_path(input: &str, platform: &str) -> String {
    if platform != "win32" {
        return input.into();
    }
    let (rest, colon) = if let Some(rest) = input.strip_prefix("/cygdrive/") {
        (rest, false)
    } else if let Some(rest) = input.strip_prefix("/mnt/") {
        (rest, false)
    } else if let Some(rest) = input.strip_prefix('/') {
        (rest, true)
    } else {
        return input.into();
    };
    let Some(drive) = rest
        .as_bytes()
        .first()
        .filter(|drive| drive.is_ascii_alphabetic())
    else {
        return input.into();
    };
    let tail = &rest[1..];
    let tail = if colon && tail.starts_with(':') {
        let tail = &tail[1..];
        if !tail.is_empty() && !tail.starts_with(['/', '\\']) {
            return input.into();
        }
        tail.get(1..).unwrap_or("")
    } else if tail.is_empty() || tail.starts_with('/') {
        tail.get(1..).unwrap_or("")
    } else {
        return input.into();
    };
    format!("{}:/{tail}", char::from(drive.to_ascii_uppercase()))
}

pub fn normalize_path(path: &Path) -> io::Result<PathBuf> {
    if !cfg!(windows) {
        return Ok(path.into());
    }
    let resolved = normalize(&std::path::absolute(windows_path(
        &path.to_string_lossy(),
        "win32",
    ))?);
    Ok(native_path(fs::canonicalize(&resolved).unwrap_or(resolved)))
}

pub fn normalize_path_pattern(pattern: &str) -> io::Result<String> {
    if !cfg!(windows) || pattern == "*" {
        return Ok(pattern.into());
    }
    if let Some(directory) = pattern
        .strip_suffix("/*")
        .or_else(|| pattern.strip_suffix("\\*"))
    {
        let directory = if directory.len() == 2
            && directory.as_bytes()[0].is_ascii_alphabetic()
            && directory.ends_with(':')
        {
            format!("{directory}\\")
        } else {
            directory.into()
        };
        return Ok(normalize_path(Path::new(&directory))?
            .join("*")
            .to_string_lossy()
            .into_owned());
    }
    Ok(normalize_path(Path::new(pattern))?
        .to_string_lossy()
        .into_owned())
}

fn native_path(path: PathBuf) -> PathBuf {
    if !cfg!(windows) {
        return path;
    }
    let text = path.to_string_lossy();
    if let Some(tail) = text.strip_prefix("\\\\?\\UNC\\") {
        return PathBuf::from(format!("\\\\{tail}"));
    }
    if let Some(tail) = text.strip_prefix("\\\\?\\") {
        return PathBuf::from(tail);
    }
    path
}

pub fn find_up(target: &str, start: &Path, stop: Option<&Path>) -> io::Result<Vec<PathBuf>> {
    up(&[target], start, stop)
}

pub fn up(targets: &[&str], start: &Path, stop: Option<&Path>) -> io::Result<Vec<PathBuf>> {
    let mut result = Vec::new();
    for current in start.ancestors() {
        for target in targets {
            let path = current.join(target);
            if path.try_exists()? {
                result.push(path);
            }
        }
        if Some(current) == stop {
            break;
        }
    }
    Ok(result)
}

#[derive(Clone, Debug)]
pub struct ScanOptions {
    pub cwd: PathBuf,
    pub absolute: bool,
    pub include_directories: bool,
    pub dot: bool,
    pub symlink: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            cwd: PathBuf::from("."),
            absolute: false,
            include_directories: false,
            dot: false,
            symlink: false,
        }
    }
}

pub fn scan(pattern: &str, options: &ScanOptions) -> io::Result<Vec<String>> {
    let absolute_pattern = Path::new(pattern).is_absolute();
    let pieces: Vec<_> = pattern.split('/').collect();
    let prefix_count = pieces
        .iter()
        .position(|part| part.chars().any(|c| "*?[]{}()".contains(c)))
        .unwrap_or(pieces.len().saturating_sub(1));
    let prefix = pieces[..prefix_count].join("/");
    let pattern = pieces[prefix_count..].join("/");
    let base = if absolute_pattern {
        PathBuf::from(if prefix.is_empty() { "/" } else { &prefix })
    } else {
        options.cwd.join(&prefix)
    };
    let base = normalize(&std::path::absolute(base)?);
    if !is_dir(&base) {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    visit(&base, &base, &pattern, options, &mut Vec::new(), &mut files)?;
    let cwd = normalize(&std::path::absolute(&options.cwd)?);
    let mut result: Vec<_> = files
        .iter()
        .map(|path| {
            if options.absolute || absolute_pattern {
                return path.to_string_lossy().into_owned();
            }
            match path.strip_prefix(&cwd) {
                Ok(relative) => relative.to_string_lossy().into_owned(),
                Err(_) => {
                    let a: Vec<_> = cwd.components().collect();
                    let b: Vec<_> = path.components().collect();
                    let common = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
                    let mut relative = PathBuf::new();
                    for _ in common..a.len() {
                        relative.push("..");
                    }
                    for component in &b[common..] {
                        relative.push(component.as_os_str());
                    }
                    relative.to_string_lossy().into_owned()
                }
            }
        })
        .collect();
    result.sort();
    Ok(result)
}

fn visit(
    base: &Path,
    directory: &Path,
    pattern: &str,
    options: &ScanOptions,
    ancestors: &mut Vec<PathBuf>,
    files: &mut Vec<PathBuf>,
) -> io::Result<()> {
    let canonical = fs::canonicalize(directory)?;
    if ancestors.contains(&canonical) {
        return Ok(());
    }
    ancestors.push(canonical);
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        let directory = kind.is_dir() || kind.is_symlink() && path.is_dir();
        let relative = path
            .strip_prefix(base)
            .map_err(io::Error::other)?
            .to_string_lossy()
            .replace('\\', "/");
        if (options.include_directories || !directory)
            && super::glob::matches_with_dot(pattern, &relative, options.dot)?
        {
            files.push(path.clone());
        }
        let depth = relative.split('/').count();
        let recursive =
            pattern.split('/').any(|part| part == "**") || depth < pattern.split('/').count();
        if directory && recursive && (!kind.is_symlink() || options.symlink) {
            visit(base, &path, pattern, options, ancestors, files)?;
        }
    }
    ancestors.pop();
    Ok(())
}

pub fn glob_up(pattern: &str, start: &Path, stop: Option<&Path>) -> io::Result<Vec<PathBuf>> {
    let mut matches = Vec::new();
    for directory in start.ancestors() {
        matches.extend(
            scan(
                pattern,
                &ScanOptions {
                    cwd: directory.into(),
                    absolute: true,
                    dot: true,
                    ..ScanOptions::default()
                },
            )
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from),
        );
        if Some(directory) == stop {
            break;
        }
    }
    Ok(matches)
}
