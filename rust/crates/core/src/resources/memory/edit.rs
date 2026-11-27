use super::okf;

struct Layout<'a> {
    bom: &'a str,
    lines: Vec<&'a str>,
    close: usize,
}
fn layout(content: &str) -> Option<Layout<'_>> {
    let (bom, text) = match content.strip_prefix('\u{feff}') {
        Some(rest) => (&content[..content.len() - rest.len()], rest),
        None => ("", content),
    };
    let lines = text.split_inclusive('\n').collect::<Vec<_>>();
    let delimiter = |line: &str| line.trim_end_matches(['\r', '\n']) == "---";
    if !lines.first().is_some_and(|line| delimiter(line)) {
        return None;
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, line)| delimiter(line).then_some(index))?;
    Some(Layout { bom, lines, close })
}
fn entry_key(line: &str) -> Option<String> {
    let first = line.chars().next()?;
    if first.is_whitespace()
        || first == '#'
        || first == '-' && (line.len() == 1 || line[1..].starts_with([' ', '\t', '\r', '\n']))
    {
        return None;
    }
    let (key, _) = line.split_once(':')?;
    Some(key.trim().trim_matches(['"', '\'']).to_owned())
}
fn span(layout: &Layout<'_>, key: &str) -> Option<(usize, usize)> {
    let start =
        (1..layout.close).find(|index| entry_key(layout.lines[*index]).as_deref() == Some(key))?;
    let mut end = (start + 1..layout.close)
        .find(|index| entry_key(layout.lines[*index]).is_some())
        .unwrap_or(layout.close);
    while end > start + 1 {
        let line = layout.lines[end - 1].trim();
        if line.is_empty() || line.starts_with('#') {
            end -= 1;
        } else {
            break;
        }
    }
    Some((start, end))
}
fn reassemble(layout: &Layout<'_>, lines: Vec<String>) -> String {
    let mut result = String::from(layout.bom);
    for line in lines {
        result.push_str(&line);
    }
    result
}
fn verified(edited: String, content: &str) -> Option<String> {
    let (before, after) = (okf::parse(content), okf::parse(&edited));
    match (before, after) {
        (okf::Parsed::Concept(_), okf::Parsed::Concept(_)) => Some(edited),
        _ => None,
    }
}
fn line_end(layout: &Layout<'_>) -> &'static str {
    if layout
        .lines
        .first()
        .is_some_and(|line| line.ends_with("\r\n"))
    {
        "\r\n"
    } else {
        "\n"
    }
}

pub fn key_text(content: &str, key: &str) -> Option<String> {
    let layout = layout(content)?;
    let (start, end) = span(&layout, key)?;
    Some(layout.lines[start..end].concat().trim_end().to_owned())
}
pub fn remove_key(content: &str, key: &str) -> Option<String> {
    let layout = layout(content)?;
    let Some((start, end)) = span(&layout, key) else {
        return Some(content.to_owned());
    };
    let lines = layout
        .lines
        .iter()
        .enumerate()
        .filter(|(index, _)| !(start..end).contains(index))
        .map(|(_, line)| (*line).to_owned())
        .collect();
    verified(reassemble(&layout, lines), content)
}
pub fn set_key(content: &str, key: &str, rendered: &str) -> Option<String> {
    let layout = layout(content)?;
    let eol = line_end(&layout);
    let entry = rendered
        .lines()
        .map(|line| format!("{line}{eol}"))
        .collect::<Vec<_>>();
    let mut lines = Vec::new();
    match span(&layout, key) {
        Some((start, end)) => {
            for (index, line) in layout.lines.iter().enumerate() {
                if index == start {
                    lines.extend(entry.iter().cloned());
                }
                if !(start..end).contains(&index) {
                    lines.push((*line).to_owned());
                }
            }
        }
        None => {
            for (index, line) in layout.lines.iter().enumerate() {
                if index == layout.close {
                    if let Some(previous) = lines.last_mut()
                        && !previous.ends_with('\n')
                    {
                        previous.push_str(eol);
                    }
                    lines.extend(entry.iter().cloned());
                }
                lines.push((*line).to_owned());
            }
        }
    }
    verified(reassemble(&layout, lines), content)
}
pub fn quote(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'))
        && !text.starts_with(['-', '.'])
        && !matches!(
            text.to_lowercase().as_str(),
            "null" | "true" | "false" | "yes" | "no" | "on" | "off"
        )
        && text.parse::<f64>().is_err();
    if plain {
        return text.into();
    }
    format!(
        "\"{}\"",
        text.chars()
            .flat_map(|c| match c {
                '"' => vec!['\\', '"'],
                '\\' => vec!['\\', '\\'],
                '\n' => vec!['\\', 'n'],
                '\r' => vec!['\\', 'r'],
                '\t' => vec!['\\', 't'],
                c if c.is_control() => format!("\\u{:04x}", c as u32).chars().collect(),
                c => vec![c],
            })
            .collect::<String>()
    )
}
pub fn timestamp(moment: chrono::DateTime<chrono::Utc>) -> String {
    format!("\"{}\"", moment.format("%Y-%m-%dT%H:%M:%SZ"))
}
