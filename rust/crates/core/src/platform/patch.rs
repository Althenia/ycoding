use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hunk {
    Add {
        path: String,
        contents: String,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_path: Option<String>,
        chunks: Vec<UpdateFileChunk>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateFileChunk {
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub change_context: Option<String>,
    pub end_of_file: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileUpdate {
    pub content: String,
    pub bom: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub fn parse(patch_text: &str) -> Result<Vec<Hunk>, Error> {
    let source = strip_heredoc(patch_text.trim());
    let lines = source.split('\n').collect::<Vec<_>>();
    let begin = lines
        .iter()
        .position(|line| line.trim() == "*** Begin Patch");
    let end = lines.iter().position(|line| line.trim() == "*** End Patch");
    let (Some(begin), Some(end)) = (begin, end) else {
        return Err(Error(
            "Invalid patch format: missing Begin/End markers".into(),
        ));
    };
    if begin >= end {
        return Err(Error(
            "Invalid patch format: missing Begin/End markers".into(),
        ));
    }
    let mut hunks = Vec::new();
    let mut index = begin + 1;
    while index < end {
        let line = lines[index];
        if let Some(path) = line.strip_prefix("*** Add File:") {
            let path = path.trim();
            if path.is_empty() {
                index += 1;
                continue;
            }
            let (contents, next) = parse_add(&lines, index + 1);
            hunks.push(Hunk::Add {
                path: path.into(),
                contents,
            });
            index = next;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Delete File:") {
            let path = path.trim();
            if path.is_empty() {
                index += 1;
                continue;
            }
            hunks.push(Hunk::Delete { path: path.into() });
            index += 1;
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Update File:") {
            let path = path.trim();
            if path.is_empty() {
                index += 1;
                continue;
            }
            let mut next = index + 1;
            let move_path = lines
                .get(next)
                .and_then(|line| line.strip_prefix("*** Move to:"))
                .map(|path| {
                    next += 1;
                    path.trim().to_owned()
                });
            let (chunks, next) = parse_update(&lines, next);
            hunks.push(Hunk::Update {
                path: path.into(),
                move_path,
                chunks,
            });
            index = next;
            continue;
        }
        index += 1;
    }
    Ok(hunks)
}

pub fn derive(path: &str, chunks: &[UpdateFileChunk], original: &str) -> Result<FileUpdate, Error> {
    let (source_bom, source) = split_bom(original);
    let mut lines = source.split('\n').map(str::to_owned).collect::<Vec<_>>();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let replacements = compute_replacements(&lines, path, chunks)?;
    for (start, remove, insert) in replacements.into_iter().rev() {
        lines.splice(start..start + remove, insert);
    }
    if !lines.last().is_some_and(String::is_empty) {
        lines.push(String::new());
    }
    let (next_bom, content) = split_bom(&lines.join("\n"));
    Ok(FileUpdate {
        content,
        bom: source_bom || next_bom,
    })
}

pub fn join_bom(text: &str, bom: bool) -> String {
    let (_, text) = split_bom(text);
    if bom { format!("\u{feff}{text}") } else { text }
}

fn parse_add(lines: &[&str], start: usize) -> (String, usize) {
    let mut content = Vec::new();
    let mut index = start;
    while index < lines.len() && !lines[index].starts_with("***") {
        if let Some(line) = lines[index].strip_prefix('+') {
            content.push(line);
        }
        index += 1;
    }
    (content.join("\n"), index)
}

fn parse_update(lines: &[&str], start: usize) -> (Vec<UpdateFileChunk>, usize) {
    let mut chunks = Vec::new();
    let mut index = start;
    while index < lines.len() && !lines[index].starts_with("***") {
        if !lines[index].starts_with("@@") {
            index += 1;
            continue;
        }
        let change_context = lines[index][2..].trim();
        let change_context = (!change_context.is_empty()).then(|| change_context.to_owned());
        let mut old_lines = Vec::new();
        let mut new_lines = Vec::new();
        index += 1;
        while index < lines.len()
            && !lines[index].starts_with("@@")
            && !lines[index].starts_with("***")
        {
            let line = lines[index];
            if let Some(line) = line.strip_prefix(' ') {
                old_lines.push(line.to_owned());
                new_lines.push(line.to_owned());
            } else if let Some(line) = line.strip_prefix('-') {
                old_lines.push(line.to_owned());
            } else if let Some(line) = line.strip_prefix('+') {
                new_lines.push(line.to_owned());
            }
            index += 1;
        }
        chunks.push(UpdateFileChunk {
            old_lines,
            new_lines,
            change_context,
            end_of_file: false,
        });
    }
    (chunks, index)
}

fn compute_replacements(
    lines: &[String],
    path: &str,
    chunks: &[UpdateFileChunk],
) -> Result<Vec<(usize, usize, Vec<String>)>, Error> {
    let mut replacements = Vec::new();
    let mut line_index = 0;
    for chunk in chunks {
        if let Some(context) = chunk
            .change_context
            .as_deref()
            .filter(|context| !context.is_empty())
        {
            let found = seek(lines, &[context.to_owned()], line_index, false);
            if found == -1 {
                return Err(Error(format!(
                    "Failed to find context '{context}' in {path}"
                )));
            }
            line_index = found as usize + 1;
        }
        if chunk.old_lines.is_empty() {
            replacements.push((lines.len(), 0, chunk.new_lines.clone()));
            continue;
        }
        let mut old_lines = chunk.old_lines.clone();
        let mut new_lines = chunk.new_lines.clone();
        let mut found = seek(lines, &old_lines, line_index, chunk.end_of_file);
        if found == -1 && old_lines.last().is_some_and(String::is_empty) {
            old_lines.pop();
            if new_lines.last().is_some_and(String::is_empty) {
                new_lines.pop();
            }
            found = seek(lines, &old_lines, line_index, chunk.end_of_file);
        }
        if found == -1 {
            return Err(Error(format!(
                "Failed to find expected lines in {path}:\n{}",
                chunk.old_lines.join("\n")
            )));
        }
        let found = found as usize;
        replacements.push((found, old_lines.len(), new_lines));
        line_index = found + old_lines.len();
    }
    replacements.sort_by_key(|(start, _, _)| *start);
    Ok(replacements)
}

fn seek(lines: &[String], pattern: &[String], start: usize, end_of_file: bool) -> isize {
    if pattern.is_empty() {
        return -1;
    }
    let comparators: [fn(&str, &str) -> bool; 4] = [exact, rstrip, trim, normalized];
    for compare in comparators {
        if end_of_file {
            let offset = lines.len() as isize - pattern.len() as isize;
            if offset >= start as isize && matches(lines, pattern, offset as usize, compare) {
                return offset;
            }
        }
        if lines.len() < pattern.len() {
            continue;
        }
        for offset in start..=lines.len() - pattern.len() {
            if matches(lines, pattern, offset, compare) {
                return offset as isize;
            }
        }
    }
    -1
}

fn matches(
    lines: &[String],
    pattern: &[String],
    offset: usize,
    compare: fn(&str, &str) -> bool,
) -> bool {
    pattern
        .iter()
        .enumerate()
        .all(|(index, line)| compare(&lines[offset + index], line))
}

fn exact(left: &str, right: &str) -> bool {
    left == right
}

fn rstrip(left: &str, right: &str) -> bool {
    left.trim_end() == right.trim_end()
}

fn trim(left: &str, right: &str) -> bool {
    left.trim() == right.trim()
}

fn normalized(left: &str, right: &str) -> bool {
    normalize(left.trim()) == normalize(right.trim())
}

fn normalize(value: &str) -> String {
    value
        .replace(['‘', '’', '‚', '‛'], "'")
        .replace(['“', '”', '„', '‟'], "\"")
        .replace(['‐', '‑', '‒', '–', '—', '―'], "-")
        .replace('…', "...")
        .replace('\u{00a0}', " ")
}

fn split_bom(text: &str) -> (bool, String) {
    text.strip_prefix('\u{feff}')
        .map_or_else(|| (false, text.to_owned()), |text| (true, text.to_owned()))
}

fn strip_heredoc(input: &str) -> &str {
    let input = input.trim();
    let input = input.strip_prefix("cat ").unwrap_or(input).trim_start();
    let Some(header) = input.strip_prefix("<<") else {
        return input;
    };
    let quote = header
        .chars()
        .next()
        .filter(|character| *character == '\'' || *character == '"');
    let header = if quote.is_some() {
        &header[1..]
    } else {
        header
    };
    let delimiter_end = header
        .find(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .unwrap_or(header.len());
    if delimiter_end == 0 {
        return input;
    }
    let delimiter = &header[..delimiter_end];
    let header = &header[delimiter_end..];
    let Some(header) = quote
        .and_then(|quote| header.strip_prefix(quote))
        .or_else(|| quote.is_none().then_some(header))
    else {
        return input;
    };
    let header = header.trim_start();
    let Some(body) = header.strip_prefix('\n') else {
        return input;
    };
    let suffix = format!("\n{delimiter}");
    body.rfind(&suffix)
        .filter(|end| body[*end + suffix.len()..].trim().is_empty())
        .map_or(input, |end| &body[..end])
}
