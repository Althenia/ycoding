use ycoding_schema::{JsonObject, JsonValue, LosslessString, parse_json, stringify_json};

pub fn encode(value: &JsonValue) -> String {
    let mut lines = Vec::new();
    write(value, 0, None, &mut lines);
    lines.join("\n")
}
fn atom(value: &JsonValue) -> String {
    match value {
        JsonValue::String(text) => {
            let value = text.to_utf8().unwrap_or_default();
            if value.is_empty()
                || value.trim() != value
                || matches!(value.as_str(), "null" | "true" | "false")
                || value.parse::<f64>().is_ok()
                || value.chars().any(|c| {
                    c.is_control() || {
                        matches!(
                            c,
                            ':' | ',' | '"' | '\n' | '\r' | '\t' | '[' | ']' | '{' | '}'
                        )
                    }
                })
                || value.starts_with('-')
            {
                stringify_json(&JsonValue::String(text.clone()))
            } else {
                value
            }
        }
        _ => stringify_json(value),
    }
}
fn write(value: &JsonValue, depth: usize, key: Option<&LosslessString>, lines: &mut Vec<String>) {
    let indent = "  ".repeat(depth);
    let key = key.map(|key| atom(&JsonValue::String(key.clone())));
    match value {
        JsonValue::Object(object) => {
            let next = if let Some(key) = key {
                lines.push(format!("{indent}{key}:"));
                depth + 1
            } else {
                depth
            };
            for (key, value) in object.iter() {
                write(value, next, Some(key), lines);
            }
        }
        JsonValue::Array(items) => {
            let prefix = key.map_or_else(|| indent.clone(), |key| format!("{indent}{key}"));
            if items.is_empty() {
                lines.push(format!("{prefix}: []"));
                return;
            }
            if items
                .iter()
                .all(|item| !matches!(item, JsonValue::Object(_) | JsonValue::Array(_)))
            {
                lines.push(format!(
                    "{prefix}[{}]: {}",
                    items.len(),
                    items.iter().map(atom).collect::<Vec<_>>().join(",")
                ));
                return;
            }
            let columns = items.first().and_then(|item| {
                if let JsonValue::Object(object) = item {
                    Some(
                        object
                            .iter()
                            .map(|(key, _)| key.clone())
                            .collect::<Vec<_>>(),
                    )
                } else {
                    None
                }
            });
            if let Some(columns) = columns.filter(|columns| {
                !columns.is_empty()
                    && items.iter().all(|item| match item {
                        JsonValue::Object(object) => {
                            object.iter().map(|(key, _)| key).eq(columns.iter())
                                && object.iter().all(|(_, value)| {
                                    !matches!(value, JsonValue::Object(_) | JsonValue::Array(_))
                                })
                        }
                        _ => false,
                    })
            }) {
                lines.push(format!(
                    "{prefix}[{}]{{{}}}:",
                    items.len(),
                    columns
                        .iter()
                        .map(|column| atom(&JsonValue::String(column.clone())))
                        .collect::<Vec<_>>()
                        .join(",")
                ));
                for item in items {
                    let JsonValue::Object(object) = item else {
                        unreachable!()
                    };
                    lines.push(format!(
                        "{}{}",
                        "  ".repeat(depth + 1),
                        object
                            .iter()
                            .map(|(_, value)| atom(value))
                            .collect::<Vec<_>>()
                            .join(",")
                    ));
                }
                return;
            }
            lines.push(format!("{prefix}[{}]:", items.len()));
            for item in items {
                let start = lines.len();
                write(item, depth + 2, None, lines);
                if lines.len() == start {
                    lines.push(format!("{}-", "  ".repeat(depth + 1)));
                    continue;
                }
                let first = lines[start].trim_start().to_owned();
                lines[start] = format!("{}- {first}", "  ".repeat(depth + 1));
            }
        }
        _ => lines.push(match key {
            Some(key) => format!("{indent}{key}: {}", atom(value)),
            None => format!("{indent}{}", atom(value)),
        }),
    }
}

#[derive(Clone)]
struct Line {
    depth: usize,
    body: String,
}
pub fn decode(text: &str) -> Result<JsonValue, ()> {
    let lines = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let spaces = line.bytes().take_while(|byte| *byte == b' ').count();
            if spaces % 2 != 0 || line[spaces..].starts_with('\t') {
                return Err(());
            }
            Ok(Line {
                depth: spaces / 2,
                body: line[spaces..].trim_end().to_owned(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if lines.is_empty() {
        return Err(());
    }
    let mut index = 0;
    let result = mapping(&lines, &mut index, 0)?;
    if index != lines.len() {
        return Err(());
    }
    Ok(result)
}
fn split(value: &str, delimiter: char) -> Result<Vec<&str>, ()> {
    let mut quoted = false;
    let mut escaped = false;
    let mut start = 0;
    let mut parts = Vec::new();
    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quoted {
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
            continue;
        }
        if character == delimiter && !quoted {
            parts.push(value[start..index].trim());
            start = index + character.len_utf8();
        }
    }
    if quoted || escaped {
        return Err(());
    }
    parts.push(value[start..].trim());
    Ok(parts)
}
fn primitive(value: &str) -> Result<JsonValue, ()> {
    if value.starts_with('"') {
        return parse_json(value).map_err(|_| ()).and_then(|value| {
            matches!(value, JsonValue::String(_))
                .then_some(value)
                .ok_or(())
        });
    }
    if matches!(value, "null" | "true" | "false" | "[]" | "{}") {
        return parse_json(value).map_err(|_| ());
    }
    if let Ok(JsonValue::Number(number)) = parse_json(value) {
        return number
            .is_finite()
            .then_some(JsonValue::Number(number))
            .ok_or(());
    }
    if value.is_empty()
        || value.contains(':')
        || value.contains('"')
        || value.starts_with(['[', '{'])
    {
        return Err(());
    }
    Ok(JsonValue::String(value.into()))
}
fn mapping(lines: &[Line], index: &mut usize, depth: usize) -> Result<JsonValue, ()> {
    let mut object = JsonObject::new();
    while let Some(line) = lines.get(*index).filter(|line| line.depth >= depth) {
        if line.depth != depth {
            return Err(());
        }
        let parts = split(&line.body, ':')?;
        if parts.len() < 2 {
            return Err(());
        }
        let header = parts[0];
        let remainder = line.body[header.len() + 1..].trim();
        let (key, count, columns, delimiter) = header_parts(header)?;
        if object.get(&key).is_some() {
            return Err(());
        }
        *index += 1;
        let value = if let Some(count) = count {
            if let Some(columns) = columns {
                if !remainder.is_empty() {
                    return Err(());
                }
                let mut rows = Vec::new();
                for _ in 0..count {
                    let row = lines
                        .get(*index)
                        .filter(|line| line.depth == depth + 1)
                        .ok_or(())?;
                    let parts = split(&row.body, delimiter)?;
                    if parts.len() != columns.len() {
                        return Err(());
                    }
                    let mut object = JsonObject::new();
                    for (key, value) in columns.iter().zip(parts) {
                        object.insert(key.clone(), primitive(value)?);
                    }
                    rows.push(JsonValue::Object(object));
                    *index += 1;
                }
                JsonValue::Array(rows)
            } else if !remainder.is_empty() {
                let parts = split(remainder, delimiter)?;
                if parts.len() != count {
                    return Err(());
                }
                JsonValue::Array(parts.into_iter().map(primitive).collect::<Result<_, _>>()?)
            } else {
                let mut items = Vec::new();
                for _ in 0..count {
                    let line = lines
                        .get(*index)
                        .filter(|line| line.depth == depth + 1)
                        .ok_or(())?;
                    let body = line.body.strip_prefix("- ").ok_or(())?.to_owned();
                    if split(&body, ':')?.len() == 1 {
                        items.push(primitive(&body)?);
                        *index += 1;
                        continue;
                    }
                    let start = *index;
                    *index += 1;
                    while lines
                        .get(*index)
                        .is_some_and(|line| line.depth >= depth + 2)
                    {
                        *index += 1;
                    }
                    let mut children = vec![Line {
                        depth: depth + 2,
                        body,
                    }];
                    children.extend_from_slice(&lines[start + 1..*index]);
                    let mut child = 0;
                    items.push(mapping(&children, &mut child, depth + 2)?);
                    if child != children.len() {
                        return Err(());
                    }
                }
                JsonValue::Array(items)
            }
        } else if remainder.is_empty() {
            mapping(lines, index, depth + 1)?
        } else {
            primitive(remainder)?
        };
        object.insert(key, value);
    }
    Ok(JsonValue::Object(object))
}
fn header_parts(
    header: &str,
) -> Result<
    (
        LosslessString,
        Option<usize>,
        Option<Vec<LosslessString>>,
        char,
    ),
    (),
> {
    let parts = split(header, '[')?;
    if parts.len() == 1 {
        return string_key(header).map(|key| (key, None, None, ','));
    }
    if parts.len() != 2 {
        return Err(());
    }
    let (count, tail) = parts[1].split_once(']').ok_or(())?;
    let (count, delimiter) = match count.chars().last() {
        Some(delimiter @ (',' | '|' | '\t')) => (&count[..count.len() - 1], delimiter),
        _ => (count, ','),
    };
    let count = count.parse::<usize>().map_err(|_| ())?;
    if count > 1_048_576 {
        return Err(());
    }
    let columns = if tail.is_empty() {
        None
    } else {
        let columns = tail
            .strip_prefix('{')
            .and_then(|tail| tail.strip_suffix('}'))
            .ok_or(())?;
        let columns = split(columns, delimiter)?
            .into_iter()
            .map(string_key)
            .collect::<Result<Vec<_>, _>>()?;
        if columns
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != columns.len()
        {
            return Err(());
        }
        Some(columns)
    };
    Ok((string_key(parts[0])?, Some(count), columns, delimiter))
}
fn string_key(key: &str) -> Result<LosslessString, ()> {
    match primitive(key)? {
        JsonValue::String(key) => Ok(key),
        _ => Err(()),
    }
}
