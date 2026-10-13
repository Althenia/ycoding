use crate::regexp::{Budget, RegExp};
use std::io;

pub fn matches(pattern: &str, path: &str) -> io::Result<bool> {
    matches_with_dot(pattern, path, true)
}

pub fn matches_with_dot(pattern: &str, path: &str, dot: bool) -> io::Result<bool> {
    if pattern.encode_utf16().count() > 65536 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pattern is too long",
        ));
    }
    if pattern.starts_with('#') {
        return Ok(false);
    }
    if pattern.is_empty() {
        return Ok(path.is_empty());
    }
    let count = pattern.bytes().take_while(|c| *c == b'!').count();
    let pattern = &pattern[count..];
    let mut file: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    if path.ends_with('/') {
        file.push("");
    }
    for expanded in expand(pattern)? {
        let mut parts = Vec::new();
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
        let found = (expanded == "**" && path.is_empty() || path_match(&parts, &file, dot)?)
            && (expanded.starts_with('/') == path.starts_with('/')
                || !expanded.starts_with('/') && parts.first() == Some(&"**"))
            && (!expanded.ends_with('/') || path.ends_with('/'));
        if found {
            return Ok(count % 2 == 0);
        }
    }
    Ok(count % 2 != 0)
}

fn path_match(pattern: &[&str], file: &[&str], dot: bool) -> io::Result<bool> {
    if pattern.is_empty() {
        return Ok(file.is_empty() || file == [""]);
    }
    if pattern[0] == "**" {
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
            if path_match(&pattern[1..], &file[index..], dot)? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    if file.is_empty() {
        return Ok(false);
    }
    if !dot && file[0].starts_with('.') && !pattern[0].starts_with('.') {
        return Ok(false);
    }
    if !component(pattern[0], file[0])? {
        return Ok(false);
    }
    path_match(&pattern[1..], &file[1..], dot)
}

fn component(pattern: &str, file: &str) -> io::Result<bool> {
    let translated = translate(pattern)?;
    let magic = pattern.chars().any(|c| "*?[".contains(c))
        || pattern.contains("@(")
        || pattern.contains("+(")
        || pattern.contains("!(");
    let prefix = if magic && translated != "\\." && translated != "\\.\\." {
        "(?!(?:\\.\\.?$))"
    } else {
        ""
    };
    let expression = format!("^{prefix}(?:{translated})$");
    RegExp::new(
        &expression.encode_utf16().collect::<Vec<_>>(),
        if translated.contains("\\p{") { "u" } else { "" },
    )
    .map_err(io::Error::other)?
    .test(
        &file.encode_utf16().collect::<Vec<_>>(),
        &mut Budget::unlimited(),
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
