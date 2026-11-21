use ycoding_schema::{JsonObject, JsonValue, LosslessString, stringify_json};

pub fn to_typescript(schema: &JsonValue, pretty: bool) -> String {
    render(schema, &[], pretty, 0, &[])
}

pub(crate) fn properties(schema: &JsonValue) -> Vec<(LosslessString, Option<String>)> {
    let definitions = definitions(schema, &[]);
    let schema = match reference(schema) {
        Some(name) => definitions
            .iter()
            .find(|(key, _)| key == &name)
            .map(|(_, value)| value)
            .unwrap_or(&JsonValue::Null),
        None => schema,
    };
    object(get(schema, "properties"))
        .map(|properties| {
            properties
                .iter()
                .map(|(name, value)| {
                    (
                        name.clone(),
                        text(get(value, "description")).map(str::to_owned),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn get<'a>(schema: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    object(Some(schema)).and_then(|value| value.get(&key.into()))
}
fn object(value: Option<&JsonValue>) -> Option<&JsonObject> {
    match value {
        Some(JsonValue::Object(value)) => Some(value),
        _ => None,
    }
}
fn text(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(value)) => value.as_str(),
        _ => None,
    }
}
fn array(value: Option<&JsonValue>) -> Option<&[JsonValue]> {
    match value {
        Some(JsonValue::Array(value)) => Some(value),
        _ => None,
    }
}
fn without(schema: &JsonValue, keys: &[&str]) -> JsonValue {
    let mut result = JsonObject::new();
    if let Some(schema) = object(Some(schema)) {
        for (key, value) in schema.iter() {
            if !key.as_str().is_some_and(|key| keys.contains(&key)) {
                result.insert(key.clone(), value.clone());
            }
        }
    }
    JsonValue::Object(result)
}
fn definitions(
    schema: &JsonValue,
    parent: &[(LosslessString, JsonValue)],
) -> Vec<(LosslessString, JsonValue)> {
    let mut definitions = parent.to_vec();
    for name in ["definitions", "$defs"] {
        if let Some(entries) = object(get(schema, name)) {
            for (key, value) in entries.iter() {
                if let Some((_, existing)) =
                    definitions.iter_mut().find(|(existing, _)| existing == key)
                {
                    *existing = value.clone();
                } else {
                    definitions.push((key.clone(), value.clone()));
                }
            }
        }
    }
    definitions
}
fn reference(schema: &JsonValue) -> Option<LosslessString> {
    let reference = text(get(schema, "$ref"))?;
    let name = reference
        .strip_prefix("#/$defs/")
        .or_else(|| reference.strip_prefix("#/definitions/"))?;
    (!name.is_empty() && !name.contains('/'))
        .then(|| name.replace("~1", "/").replace("~0", "~").into())
}
fn intersection(members: Vec<String>) -> String {
    let members = members
        .into_iter()
        .filter(|member| member != "unknown")
        .collect::<Vec<_>>();
    if members.is_empty() {
        return "unknown".into();
    }
    if members.len() == 1 {
        return members[0].clone();
    }
    members
        .into_iter()
        .map(|member| {
            if member.contains(" | ") {
                format!("({member})")
            } else {
                member
            }
        })
        .collect::<Vec<_>>()
        .join(" & ")
}
fn unresolved(schema: &JsonValue, definitions: &[(LosslessString, JsonValue)]) -> bool {
    let mut pending = vec![(schema, false)];
    let mut active = std::collections::BTreeSet::new();
    let mut settled = std::collections::BTreeSet::new();
    while let Some((schema, leaving)) = pending.pop() {
        let identity = schema as *const JsonValue as usize;
        if leaving {
            active.remove(&identity);
            settled.insert(identity);
            continue;
        }
        if settled.contains(&identity) {
            continue;
        }
        if !active.insert(identity) {
            return true;
        }
        pending.push((schema, true));
        if get(schema, "$ref").is_some() {
            let Some(name) = reference(schema) else {
                return true;
            };
            let Some((_, resolved)) = definitions.iter().find(|(key, _)| key == &name) else {
                return true;
            };
            pending.push((resolved, false));
        }
        for key in ["anyOf", "oneOf", "allOf"] {
            if let Some(items) = array(get(schema, key)) {
                pending.extend(items.iter().map(|item| (item, false)));
            }
        }
        if let Some(properties) = object(get(schema, "properties")) {
            pending.extend(properties.iter().map(|(_, value)| (value, false)));
        }
        for key in ["items", "additionalProperties"] {
            if let Some(value) =
                get(schema, key).filter(|value| matches!(value, JsonValue::Object(_)))
            {
                pending.push((value, false));
            }
        }
    }
    false
}
fn number_sentinel(schema: &JsonValue) -> bool {
    text(get(schema, "type")) == Some("string")
        && array(get(schema, "enum")).is_some_and(|values| {
            values.len() == 1
                && matches!(text(values.first()), Some("NaN" | "Infinity" | "-Infinity"))
        })
}
fn documentation(schema: &JsonValue, pad: &str) -> String {
    let mut lines = text(get(schema, "description"))
        .map(|value| value.split('\n').map(str::to_owned).collect::<Vec<_>>())
        .unwrap_or_default();
    if get(schema, "deprecated") == Some(&JsonValue::Bool(true)) {
        lines.push("@deprecated".into());
    }
    if let Some(default) = get(schema, "default") {
        lines.push(format!("@default {}", stringify_json(default)));
    }
    if let Some(format) = text(get(schema, "format")) {
        lines.push(format!("@format {format}"));
    }
    for name in ["minItems", "maxItems"] {
        if let Some(JsonValue::Number(value)) = get(schema, name) {
            lines.push(format!("@{name} {value}"));
        }
    }
    let lines = lines
        .into_iter()
        .map(|line| {
            line.replace("*/", "* /")
                .trim_end_matches(super::stdlib::string::whitespace)
                .to_owned()
        })
        .collect::<Vec<_>>();
    let start = lines
        .iter()
        .take_while(|line| line.trim().is_empty())
        .count();
    let end = lines.len()
        - lines
            .iter()
            .rev()
            .take_while(|line| line.trim().is_empty())
            .count();
    let lines = &lines[start..end.max(start)];
    if lines.is_empty() {
        return String::new();
    }
    if lines.len() == 1 {
        return format!("{pad}/** {} */\n", lines[0]);
    }
    format!(
        "{pad}/**\n{}\n{pad} */\n",
        lines
            .iter()
            .map(|line| if line.is_empty() {
                format!("{pad} *")
            } else {
                format!("{pad} * {line}")
            })
            .collect::<Vec<_>>()
            .join("\n")
    )
}
fn key(name: &LosslessString) -> String {
    let identifier = name.as_str().is_some_and(|name| {
        let mut chars = name.chars();
        chars
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || matches!(first, '_' | '$'))
            && chars.all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '$')
            })
    });
    if identifier {
        return name
            .as_str()
            .expect("An ASCII identifier is UTF-8")
            .to_owned();
    }
    stringify_json(&JsonValue::String(name.clone()))
}
fn render(
    schema: &JsonValue,
    parent: &[(LosslessString, JsonValue)],
    pretty: bool,
    depth: usize,
    seen: &[LosslessString],
) -> String {
    if depth > 8 {
        return "unknown".into();
    }
    let definitions = definitions(schema, parent);
    if text(get(schema, "$ref")).is_some_and(|reference| !reference.is_empty()) {
        let Some(name) = reference(schema) else {
            return "unknown".into();
        };
        let Some((_, resolved)) = definitions.iter().find(|(key, _)| key == &name) else {
            return "unknown".into();
        };
        if seen.contains(&name) {
            return "unknown".into();
        }
        let mut next = seen.to_vec();
        next.push(name);
        return intersection(vec![
            render(resolved, &definitions, pretty, depth, &next),
            render(
                &without(schema, &["$ref"]),
                &definitions,
                pretty,
                depth + 1,
                seen,
            ),
        ]);
    }
    if let Some(value) = get(schema, "const") {
        return stringify_json(value);
    }
    if let Some(values) = array(get(schema, "enum")) {
        return values
            .iter()
            .map(stringify_json)
            .collect::<Vec<_>>()
            .join(" | ");
    }
    if let Some(alternatives) = array(get(schema, "anyOf")).or_else(|| array(get(schema, "oneOf")))
    {
        if alternatives
            .iter()
            .any(|value| text(get(value, "type")) == Some("number"))
            && alternatives
                .iter()
                .all(|value| text(get(value, "type")) == Some("number") || number_sentinel(value))
        {
            return "number".into();
        }
        if alternatives.len() == 2
            && text(get(&alternatives[0], "type")) == Some("object")
            && get(&alternatives[0], "properties").is_none()
            && text(get(&alternatives[1], "type")) == Some("array")
            && get(&alternatives[1], "items").is_none()
        {
            return "{}".into();
        }
        let members = alternatives
            .iter()
            .map(|value| render(value, &definitions, pretty, depth + 1, seen))
            .collect::<Vec<_>>();
        if members.iter().any(|member| member == "unknown") {
            return "unknown".into();
        }
        return intersection(vec![
            members.join(" | "),
            render(
                &without(schema, &["anyOf", "oneOf"]),
                &definitions,
                pretty,
                depth + 1,
                seen,
            ),
        ]);
    }
    if let Some(members) = array(get(schema, "allOf")) {
        if members
            .iter()
            .any(|member| unresolved(member, &definitions))
        {
            return "unknown".into();
        }
        return intersection(
            std::iter::once(render(
                &without(schema, &["allOf"]),
                &definitions,
                pretty,
                depth + 1,
                seen,
            ))
            .chain(
                members
                    .iter()
                    .map(|value| render(value, &definitions, pretty, depth + 1, seen)),
            )
            .collect(),
        );
    }
    if let Some(types) = array(get(schema, "type")) {
        return types
            .iter()
            .map(|kind| {
                let mut schema = match without(schema, &["type"]) {
                    JsonValue::Object(schema) => schema,
                    _ => unreachable!(),
                };
                schema.insert("type".into(), kind.clone());
                render(
                    &JsonValue::Object(schema),
                    &definitions,
                    pretty,
                    depth + 1,
                    seen,
                )
            })
            .collect::<Vec<_>>()
            .join(" | ");
    }
    match text(get(schema, "type")) {
        Some("string") => return "string".into(),
        Some("number" | "integer") => return "number".into(),
        Some("boolean") => return "boolean".into(),
        Some("null") => return "null".into(),
        Some("array") => {
            return format!(
                "Array<{}>",
                render(
                    get(schema, "items").unwrap_or(&JsonValue::Null),
                    &definitions,
                    pretty,
                    depth + 1,
                    seen
                )
            );
        }
        _ => {}
    }
    if text(get(schema, "type")) != Some("object") && get(schema, "properties").is_none() {
        return "unknown".into();
    }
    let properties = object(get(schema, "properties"));
    let required = array(get(schema, "required")).unwrap_or_default();
    let index = get(schema, "additionalProperties")
        .filter(|value| matches!(value, JsonValue::Object(_)))
        .map(|value| render(value, &definitions, pretty, depth + 1, seen));
    let pad = "  ".repeat(depth + 1);
    let mut fields = properties
        .into_iter()
        .flat_map(JsonObject::iter)
        .map(|(name, value)| {
            let field = format!(
                "{}{}: {}",
                key(name),
                if required.contains(&JsonValue::String(name.clone())) {
                    ""
                } else {
                    "?"
                },
                render(value, &definitions, pretty, depth + 1, seen)
            );
            if pretty {
                format!("{}{pad}{field},", documentation(value, &pad))
            } else {
                field
            }
        })
        .collect::<Vec<_>>();
    if let Some(index) = index {
        fields.push(if pretty {
            format!("{pad}[key: string]: {index},")
        } else {
            format!("[key: string]: {index}")
        });
    }
    if fields.is_empty() {
        return "{}".into();
    }
    if !pretty {
        return format!("{{ {} }}", fields.join("; "));
    }
    format!("{{\n{}\n{}}}", fields.join("\n"), "  ".repeat(depth))
}
