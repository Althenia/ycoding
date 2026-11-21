use crate::regexp::{Budget, RegExp};
use std::io;

pub fn matches(pattern: &str, path: &str) -> io::Result<bool> {
    matches_with_dot(pattern, path, true)
}

pub fn matches_with_dot(pattern: &str, path: &str, dot: bool) -> io::Result<bool> {
    Pattern::compile_with_dot(pattern, dot)?.matches(path)
}

enum Part {
    Globstar,
    Literal(String),
    Wildcard {
        chars: Vec<char>,
        all_stars: bool,
    },
    Magic {
        source: String,
        expression: Option<RegExp>,
    },
}

impl Part {
    fn new(part: &str) -> Self {
        if part == "**" {
            return Self::Globstar;
        }
        if !is_magic(part) && !part.contains('\\') {
            return Self::Literal(part.to_string());
        }
        if part.contains('*')
            && !part.contains(['?', '[', '\\'])
            && !["@(", "+(", "!(", "?(", "*("]
                .iter()
                .any(|extglob| part.contains(extglob))
        {
            return Self::Wildcard {
                all_stars: part.chars().all(|c| c == '*'),
                chars: part.chars().collect(),
            };
        }
        Self::Magic {
            source: part.to_string(),
            expression: None,
        }
    }

    fn starts_with_dot(&self) -> bool {
        match self {
            Self::Globstar => false,
            Self::Literal(part) => part.starts_with('.'),
            Self::Wildcard { chars, .. } => chars.first() == Some(&'.'),
            Self::Magic { source, .. } => source.starts_with('.'),
        }
    }

    fn matches(&mut self, file: &str) -> io::Result<bool> {
        match self {
            Self::Globstar => Ok(false),
            Self::Literal(part) => Ok(part == file),
            Self::Wildcard { chars, all_stars } => {
                if matches!(file, "." | "..") || *all_stars && file.is_empty() {
                    return Ok(false);
                }
                Ok(wildcard(chars, &file.chars().collect::<Vec<_>>()))
            }
            Self::Magic { source, expression } => {
                if expression.is_none() {
                    *expression = Some(compile_component(source)?);
                }
                expression
                    .as_mut()
                    .expect("component expression exists")
                    .test(
                        &file.encode_utf16().collect::<Vec<_>>(),
                        &mut Budget::unlimited(),
                    )
                    .map_err(io::Error::other)
            }
        }
    }
}

struct Alternative {
    parts: Vec<Part>,
    globstar_only: bool,
    leading_slash: bool,
    trailing_slash: bool,
}

enum PatternKind {
    Never,
    EmptyOnly,
    Alternatives {
        negated: bool,
        alternatives: Vec<Alternative>,
    },
}

pub struct Pattern {
    dot: bool,
    kind: PatternKind,
}

impl Pattern {
    pub fn compile(pattern: &str) -> io::Result<Self> {
        Self::compile_with_dot(pattern, true)
    }

    pub fn compile_with_dot(pattern: &str, dot: bool) -> io::Result<Self> {
        if pattern.encode_utf16().count() > 65536 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "pattern is too long",
            ));
        }
        if pattern.starts_with('#') {
            return Ok(Self {
                dot,
                kind: PatternKind::Never,
            });
        }
        if pattern.is_empty() {
            return Ok(Self {
                dot,
                kind: PatternKind::EmptyOnly,
            });
        }
        let count = pattern.bytes().take_while(|c| *c == b'!').count();
        let alternatives = expand(&pattern[count..])?
            .into_iter()
            .map(|expanded| {
                let mut parts: Vec<&str> = Vec::new();
                for part in expanded.split('/').filter(|part| !part.is_empty()) {
                    if part == "**" && parts.last() == Some(&"**") {
                        continue;
                    }
                    if part == ".."
                        && parts
                            .last()
                            .is_some_and(|part| !matches!(*part, ".." | "." | "**"))
                    {
                        parts.pop();
                        continue;
                    }
                    parts.push(part);
                }
                Alternative {
                    globstar_only: expanded == "**",
                    leading_slash: expanded.starts_with('/'),
                    trailing_slash: expanded.ends_with('/'),
                    parts: parts.into_iter().map(Part::new).collect(),
                }
            })
            .collect();
        Ok(Self {
            dot,
            kind: PatternKind::Alternatives {
                negated: count % 2 != 0,
                alternatives,
            },
        })
    }

    pub fn matches(&mut self, path: &str) -> io::Result<bool> {
        let PatternKind::Alternatives {
            negated,
            alternatives,
        } = &mut self.kind
        else {
            return Ok(matches!(self.kind, PatternKind::EmptyOnly) && path.is_empty());
        };
        let mut file: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
        if path.ends_with('/') {
            file.push("");
        }
        for alternative in alternatives.iter_mut() {
            let found = (alternative.globstar_only && path.is_empty()
                || path_match(&mut alternative.parts, &file, self.dot)?)
                && (alternative.leading_slash == path.starts_with('/')
                    || !alternative.leading_slash
                        && matches!(alternative.parts.first(), Some(Part::Globstar)))
                && (!alternative.trailing_slash || path.ends_with('/'));
            if found {
                return Ok(!*negated);
            }
        }
        Ok(*negated)
    }
}

fn is_magic(pattern: &str) -> bool {
    pattern.chars().any(|c| "*?[".contains(c))
        || pattern.contains("@(")
        || pattern.contains("+(")
        || pattern.contains("!(")
}

fn wildcard(pattern: &[char], file: &[char]) -> bool {
    let mut pattern_at = 0;
    let mut file_at = 0;
    let mut star: Option<(usize, usize)> = None;
    while file_at < file.len() {
        if pattern.get(pattern_at) == Some(&'*') {
            star = Some((pattern_at, file_at));
            pattern_at += 1;
        } else if pattern.get(pattern_at) == Some(&file[file_at]) {
            pattern_at += 1;
            file_at += 1;
        } else if let Some((star_at, star_file_at)) = star {
            pattern_at = star_at + 1;
            file_at = star_file_at + 1;
            star = Some((star_at, file_at));
        } else {
            return false;
        }
    }
    pattern[pattern_at..].iter().all(|c| *c == '*')
}

fn path_match(pattern: &mut [Part], file: &[&str], dot: bool) -> io::Result<bool> {
    if pattern.is_empty() {
        return Ok(file.is_empty() || file == [""]);
    }
    if pattern.len() != file.len()
        && !(pattern.len() + 1 == file.len() && file.last() == Some(&""))
        && pattern.iter().all(|part| !matches!(part, Part::Globstar))
    {
        return Ok(false);
    }
    if matches!(pattern[0], Part::Globstar) {
        if pattern.len() == 1 && file.is_empty() {
            return Ok(false);
        }
        for index in 0..=file.len() {
            if index > 0
                && (matches!(file[index - 1], "." | "..")
                    || !dot && file[index - 1].starts_with('.'))
            {
                break;
            }
            if path_match(&mut pattern[1..], &file[index..], dot)? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    if file.is_empty() {
        return Ok(false);
    }
    if !dot && file[0].starts_with('.') && !pattern[0].starts_with_dot() {
        return Ok(false);
    }
    if !pattern[0].matches(file[0])? {
        return Ok(false);
    }
    path_match(&mut pattern[1..], &file[1..], dot)
}

fn compile_component(pattern: &str) -> io::Result<RegExp> {
    let translated = translate(pattern)?;
    let prefix = if is_magic(pattern) && translated != "\\." && translated != "\\.\\." {
        "(?!(?:\\.\\.?$))"
    } else {
        ""
    };
    let expression = format!("^{prefix}(?:{translated})$");
    RegExp::new(
        &expression.encode_utf16().collect::<Vec<_>>(),
        if translated.contains("\\p{") { "u" } else { "" },
    )
    .map_err(io::Error::other)
}

fn translate(pattern: &str) -> io::Result<String> {
    translate_with_tail(pattern, "")
}

fn translate_with_tail(pattern: &str, tail: &str) -> io::Result<String> {
    let chars: Vec<_> = pattern.chars().collect();
    let mut output = String::new();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if "!?+*@".contains(c) && chars.get(index + 1) == Some(&'(') {
            let mut depth = 1;
            let mut end = index + 2;
            while end < chars.len() && depth != 0 {
                if chars[end] == '(' {
                    depth += 1;
                }
                if chars[end] == ')' {
                    depth -= 1;
                }
                end += 1;
            }
            if depth == 0 {
                let body: String = chars[index + 2..end - 1].iter().collect();
                let suffix: String = chars[end..].iter().collect();
                let next_tail = format!("{suffix}{tail}");
                let alternatives = split_top(&body, '|')
                    .iter()
                    .map(|part| translate_with_tail(part, &next_tail))
                    .collect::<io::Result<Vec<_>>>()?
                    .join("|");
                match c {
                    '!' => {
                        output.push_str(&format!(
                            "(?!(?:{alternatives}){}$)[^/]*?",
                            translate(&next_tail)?
                        ));
                    }
                    '@' => output.push_str(&format!("(?:{alternatives})")),
                    c => output.push_str(&format!("(?:{alternatives}){c}")),
                }
                index = end;
                continue;
            }
        }
        match c {
            '\\' => {
                index += 1;
                if let Some(c) = chars.get(index) {
                    output.push_str(&escape(*c));
                } else {
                    output.push_str("\\\\");
                }
            }
            '*' => {
                while chars.get(index + 1) == Some(&'*') {
                    index += 1;
                }
                output.push_str(if pattern.chars().all(|c| c == '*') {
                    "[^/]+?"
                } else {
                    "[^/]*?"
                });
            }
            '?' => output.push_str("[^/]"),
            '[' => {
                if let Some((class, end)) = character_class(&chars, index) {
                    output.push_str(&class);
                    index = end;
                } else {
                    output.push_str("\\[");
                }
            }
            c => output.push_str(&escape(c)),
        }
        index += 1;
    }
    Ok(output)
}

fn escape(c: char) -> String {
    if "\\^$.*+?()[]{}|".contains(c) {
        format!("\\{c}")
    } else {
        c.to_string()
    }
}

fn character_class(chars: &[char], start: usize) -> Option<(String, usize)> {
    let mut index = start + 1;
    let negative = chars.get(index).is_some_and(|c| *c == '!' || *c == '^');
    if negative {
        index += 1;
    }
    let mut ranges: Vec<String> = Vec::new();
    let mut negs: Vec<String> = Vec::new();
    let mut saw_start = false;
    while index < chars.len() {
        if chars[index] == ']' && saw_start {
            if ranges.is_empty() && negs.is_empty() {
                return Some(("(?!)".into(), index));
            }
            if !negative && negs.is_empty() && ranges.len() == 1 && ranges[0].chars().count() == 1 {
                return Some((escape(ranges[0].chars().next()?), index));
            }
            let positive = (!ranges.is_empty())
                .then(|| format!("[{}{}]", if negative { "^" } else { "" }, ranges.join("")));
            let neg = (!negs.is_empty())
                .then(|| format!("[{}{}]", if negative { "" } else { "^" }, negs.join("")));
            return Some((
                match (positive, neg) {
                    (Some(a), Some(b)) => format!("(?:{a}|{b})"),
                    (Some(a), None) | (None, Some(a)) => a,
                    _ => "(?!)".into(),
                },
                index,
            ));
        }
        saw_start = true;
        if chars[index] == '[' && chars.get(index + 1) == Some(&':') {
            let tail: String = chars[index..].iter().collect();
            let classes = [
                ("digit", "\\p{Nd}", false),
                ("alpha", "\\p{L}\\p{Nl}", false),
                ("alnum", "\\p{L}\\p{Nl}\\p{Nd}", false),
                ("lower", "\\p{Ll}", false),
                ("upper", "\\p{Lu}", false),
                ("space", "\\p{Z}\\t\\r\\n\\v\\f", false),
                ("word", "\\p{L}\\p{Nl}\\p{Nd}\\p{Pc}", false),
                ("ascii", "\\x00-\\x7f", false),
                ("xdigit", "A-Fa-f0-9", false),
                ("blank", "\\p{Zs}\\t", false),
                ("cntrl", "\\p{Cc}", false),
                ("punct", "\\p{P}", false),
                ("graph", "\\p{Z}\\p{C}", true),
                ("print", "\\p{C}", false),
            ];
            if let Some((name, replacement, negated)) = classes
                .iter()
                .find(|(name, _, _)| tail.starts_with(&format!("[:{name}:]")))
            {
                if *negated {
                    negs.push(replacement.to_string());
                } else {
                    ranges.push(replacement.to_string());
                }
                index += name.len() + 4;
                continue;
            }
        }
        let mut c = chars[index];
        if c == '\\' && index + 1 < chars.len() {
            index += 1;
            c = chars[index];
        }
        let escaped = |c: char| {
            if "[]\\-".contains(c) {
                format!("\\{c}")
            } else {
                c.to_string()
            }
        };
        if chars.get(index + 1) == Some(&'-') && chars.get(index + 2).is_some_and(|c| *c != ']') {
            let end = chars[index + 2];
            if end > c {
                ranges.push(format!("{}-{}", escaped(c), escaped(end)));
            }
            if end == c {
                ranges.push(escaped(c));
            }
            index += 3;
            continue;
        }
        ranges.push(escaped(c));
        index += 1;
    }
    None
}

fn split_top(input: &str, separator: char) -> Vec<String> {
    let mut result = vec![String::new()];
    let mut depth = 0_i32;
    let mut escaped = false;
    for c in input.chars() {
        if !escaped {
            if c == '(' || c == '{' {
                depth += 1;
            }
            if c == ')' || c == '}' {
                depth -= 1;
            }
        }
        if c == separator && depth == 0 && !escaped {
            result.push(String::new());
        } else {
            result.last_mut().expect("Initial part exists").push(c);
        }
        escaped = !escaped && c == '\\';
    }
    result
}

fn expand(input: &str) -> io::Result<Vec<String>> {
    let mut depth = 0;
    let mut start = None;
    let mut escaped = false;
    for (index, c) in input.char_indices() {
        if !escaped && c == '{' {
            if depth == 0 {
                start = Some(index);
            }
            depth += 1;
        }
        if !escaped && c == '}' && depth > 0 {
            depth -= 1;
            if depth == 0 {
                let start = start.expect("Opening brace exists");
                let body = &input[start + 1..index];
                let parts = split_top(body, ',');
                let parts = if parts.len() > 1 {
                    parts
                } else if let Some(range) = range(body)? {
                    range
                } else {
                    continue;
                };
                let mut expanded = Vec::new();
                for part in parts {
                    expanded.extend(expand(&format!(
                        "{}{part}{}",
                        &input[..start],
                        &input[index + 1..]
                    ))?);
                    if expanded.len() > 100_000 {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "Brace expansion exceeds 100000 patterns",
                        ));
                    }
                }
                return Ok(expanded);
            }
        }
        escaped = !escaped && c == '\\';
    }
    Ok(vec![input.into()])
}

fn range(body: &str) -> io::Result<Option<Vec<String>>> {
    let parts: Vec<_> = body.split("..").collect();
    if !(2..=3).contains(&parts.len()) {
        return Ok(None);
    }
    let numeric = parts[0].parse::<i64>().is_ok() && parts[1].parse::<i64>().is_ok();
    let values = if numeric {
        (
            parts[0].parse::<i64>().unwrap(),
            parts[1].parse::<i64>().unwrap(),
        )
    } else if parts[0].len() == 1
        && parts[1].len() == 1
        && parts[0].as_bytes()[0].is_ascii_alphabetic()
        && parts[1].as_bytes()[0].is_ascii_alphabetic()
    {
        (parts[0].as_bytes()[0] as i64, parts[1].as_bytes()[0] as i64)
    } else {
        return Ok(None);
    };
    let step = if parts.len() == 3 {
        match parts[2].parse::<i64>() {
            Ok(step) => step.unsigned_abs().max(1),
            Err(_) => return Ok(None),
        }
    } else {
        1
    };
    let count = values.0.abs_diff(values.1) / step + 1;
    if count > 100_000 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Brace expansion exceeds 100000 patterns",
        ));
    }
    let pad = numeric
        && (parts[0].trim_start_matches('-').starts_with('0') && parts[0].len() > 1
            || parts[1].trim_start_matches('-').starts_with('0') && parts[1].len() > 1);
    let width = parts[0].len().max(parts[1].len());
    Ok(Some(
        (0..count)
            .map(|i| {
                let value = values.0 as i128
                    + if values.0 <= values.1 {
                        i as i128 * step as i128
                    } else {
                        -(i as i128 * step as i128)
                    };
                if !numeric {
                    return char::from_u32(value as u32).unwrap_or('\0').to_string();
                }
                if pad {
                    format!("{value:0width$}")
                } else {
                    value.to_string()
                }
            })
            .collect(),
    ))
}
