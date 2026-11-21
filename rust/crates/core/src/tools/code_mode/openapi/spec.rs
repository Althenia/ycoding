use super::{
    Body, Field, Operation, Options, Plan, SecurityRequirement, Skipped, array, get, json_media,
    object, text,
};
use crate::tools::code_mode::ToolDescription;
use std::collections::BTreeSet;
use ycoding_schema::{JsonObject, JsonValue};

pub(super) fn plans(document: &JsonValue, options: &Options) -> (Vec<Plan>, Vec<Skipped>) {
    let mut plans = Vec::new();
    let mut skipped = Vec::new();
    let mut used = BTreeSet::new();
    let mut namespaces = BTreeSet::new();
    let Some(paths) = object(get(document, "paths")) else {
        return (plans, skipped);
    };
    let schemes = schemes(document);
    for (path, path_item) in paths.iter() {
        let Some(path) = path.as_str() else {
            continue;
        };
        let Some(methods) = object(Some(path_item)) else {
            continue;
        };
        for (method, value) in methods.iter() {
            let Some(method) = method.as_str() else {
                continue;
            };
            if ![
                "get", "put", "post", "delete", "options", "head", "patch", "trace",
            ]
            .contains(&method)
                || object(Some(value)).is_none()
            {
                continue;
            }
            let operation = Operation {
                operation_id: nonempty(get(value, "operationId")).map(str::to_owned),
                method: method.to_uppercase(),
                path: path.into(),
                summary: nonempty(get(value, "summary")).map(str::to_owned),
                description: nonempty(get(value, "description")).map(str::to_owned),
            };
            let build = || -> Result<Plan, String> {
                let output = output(document, value)?;
                let base = if let Some(base) = &options.base_url {
                    base_url(base)?
                } else if get(value, "servers").is_some() {
                    server(value)?
                } else if get(path_item, "servers").is_some() {
                    server(path_item)?
                } else {
                    server(document)?
                };
                let (fields, body) = fields(document, path_item, value)?;
                let security = security(
                    get(value, "security").or_else(|| get(document, "security")),
                    &schemes,
                )?;
                let name = operation_path(method, path, &operation, &used, &namespaces);
                let path = match &options.namespace {
                    Some(namespace) => format!(
                        "{}.{}",
                        namespace
                            .to_utf8()
                            .map_err(|_| "Invalid OpenAPI namespace.")?,
                        name
                    ),
                    None => name,
                };
                let mut properties = JsonObject::new();
                let mut required = Vec::new();
                for field in &fields {
                    properties.insert(field.input_name.as_str().into(), field.schema.clone());
                    if field.required {
                        required.push(JsonValue::String(field.input_name.as_str().into()));
                    }
                }
                let mut input = JsonObject::new();
                input.insert("type".into(), JsonValue::String("object".into()));
                input.insert("properties".into(), JsonValue::Object(properties));
                if !required.is_empty() {
                    input.insert("required".into(), JsonValue::Array(required));
                }
                let input = with_definitions(document, JsonValue::Object(input), "readOnly");
                let description = ToolDescription::from_schemas(
                    path.into(),
                    operation
                        .description
                        .clone()
                        .or_else(|| operation.summary.clone())
                        .unwrap_or_else(|| format!("{} {}", operation.method, operation.path)),
                    &input,
                    output.as_ref(),
                );
                Ok(Plan {
                    description,
                    operation: operation.clone(),
                    url: format!("{}{}", base.trim_end_matches('/'), operation.path),
                    fields,
                    body,
                    security,
                    schemes: schemes.clone(),
                })
            };
            match build() {
                Ok(plan) => {
                    let name = plan
                        .description
                        .path
                        .to_utf8()
                        .expect("generated OpenAPI path is UTF-8");
                    let name = match &options.namespace {
                        Some(namespace) => name
                            .strip_prefix(&format!(
                                "{}.",
                                namespace.to_utf8().expect("validated namespace")
                            ))
                            .expect("generated namespace prefix")
                            .to_owned(),
                        None => name,
                    };
                    used.insert(name.clone());
                    let segments = name.split('.').collect::<Vec<_>>();
                    for index in 1..segments.len() {
                        namespaces.insert(segments[..index].join("."));
                    }
                    plans.push(plan);
                }
                Err(reason) => skipped.push(Skipped {
                    method: operation.method,
                    path: operation.path,
                    reason,
                }),
            }
        }
    }
    (plans, skipped)
}

fn nonempty(value: Option<&JsonValue>) -> Option<&str> {
    text(value).filter(|value| !value.is_empty())
}
fn pointer<'a>(root: &'a JsonValue, reference: &str) -> Option<&'a JsonValue> {
    reference
        .strip_prefix("#/")?
        .split('/')
        .try_fold(root, |value, segment| {
            get(value, &segment.replace("~1", "/").replace("~0", "~"))
        })
}
fn resolve<'a>(document: &'a JsonValue, value: &'a JsonValue) -> &'a JsonValue {
    let mut value = value;
    let mut seen = BTreeSet::new();
    while let Some(reference) = nonempty(get(value, "$ref")) {
        if !seen.insert(reference) {
            break;
        }
        let Some(target) = pointer(document, reference) else {
            break;
        };
        value = target;
    }
    value
}
fn resource<'a>(
    document: &'a JsonValue,
    root: &'a JsonValue,
    value: &'a JsonValue,
) -> Option<(&'a JsonValue, &'a JsonValue)> {
    let reference = nonempty(get(value, "$ref"))?;
    let local = reference.starts_with("#/$defs/") || reference.starts_with("#/definitions/");
    let target = pointer(if local { root } else { document }, reference)?;
    Some((if local { root } else { target }, target))
}
fn hidden(
    document: &JsonValue,
    root: &JsonValue,
    value: &JsonValue,
    keyword: &str,
    seen: &mut BTreeSet<usize>,
) -> bool {
    if get(value, keyword) == Some(&JsonValue::Bool(true)) {
        return true;
    }
    if !seen.insert(value as *const JsonValue as usize) {
        return false;
    }
    if array(get(value, "allOf"))
        .iter()
        .any(|value| hidden(document, root, value, keyword, seen))
    {
        return true;
    }
    resource(document, root, value)
        .is_some_and(|(root, value)| hidden(document, root, value, keyword, seen))
}
fn hidden_names(
    document: &JsonValue,
    root: &JsonValue,
    value: &JsonValue,
    keyword: &str,
    seen: &mut BTreeSet<usize>,
    names: &mut BTreeSet<String>,
) {
    if !seen.insert(value as *const JsonValue as usize) {
        return;
    }
    if let Some(properties) = object(get(value, "properties")) {
        for (name, value) in properties.iter() {
            if hidden(document, root, value, keyword, &mut BTreeSet::new())
                && let Some(name) = name.as_str()
            {
                names.insert(name.into());
            }
        }
    }
    for value in array(get(value, "allOf")) {
        hidden_names(document, root, value, keyword, seen, names);
    }
    if let Some((root, value)) = resource(document, root, value) {
        hidden_names(document, root, value, keyword, seen, names);
    }
}
fn directional(
    document: &JsonValue,
    root: &JsonValue,
    value: &JsonValue,
    keyword: &str,
    excluded: &BTreeSet<String>,
) -> JsonValue {
    let Some(fields) = object(Some(value)) else {
        return value.clone();
    };
    let mut excluded = excluded.clone();
    hidden_names(
        document,
        root,
        value,
        keyword,
        &mut BTreeSet::new(),
        &mut excluded,
    );
    let mut result = JsonObject::new();
    for (key, value) in fields.iter() {
        let name = key.as_str().unwrap_or_default();
        let value = match name {
            "properties" if object(Some(value)).is_some() => {
                let mut properties = JsonObject::new();
                for (name, value) in object(Some(value)).unwrap().iter() {
                    if !name.as_str().is_some_and(|name| excluded.contains(name)) {
                        properties.insert(
                            name.clone(),
                            directional(document, root, value, keyword, &BTreeSet::new()),
                        );
                    }
                }
                JsonValue::Object(properties)
            }
            "required" if matches!(value, JsonValue::Array(_)) => JsonValue::Array(
                array(Some(value))
                    .iter()
                    .filter(|value| !text(Some(value)).is_some_and(|name| excluded.contains(name)))
                    .cloned()
                    .collect(),
            ),
            "allOf" => JsonValue::Array(
                array(Some(value))
                    .iter()
                    .map(|value| directional(document, root, value, keyword, &excluded))
                    .collect(),
            ),
            "items"
            | "additionalProperties"
            | "unevaluatedProperties"
            | "propertyNames"
            | "then"
            | "else" => directional(document, root, value, keyword, &BTreeSet::new()),
            "anyOf" | "oneOf" | "prefixItems" if matches!(value, JsonValue::Array(_)) => {
                JsonValue::Array(
                    array(Some(value))
                        .iter()
                        .map(|value| directional(document, root, value, keyword, &BTreeSet::new()))
                        .collect(),
                )
            }
            "patternProperties" | "dependentSchemas" | "$defs" | "definitions"
                if object(Some(value)).is_some() =>
            {
                let mut fields = JsonObject::new();
                for (name, value) in object(Some(value)).unwrap().iter() {
                    fields.insert(
                        name.clone(),
                        directional(document, root, value, keyword, &BTreeSet::new()),
                    );
                }
                JsonValue::Object(fields)
            }
            _ => value.clone(),
        };
        result.insert(key.clone(), value);
    }
    JsonValue::Object(result)
}
fn normalize(document: &JsonValue, value: &JsonValue) -> JsonValue {
    let Some(fields) = object(Some(value)) else {
        return JsonValue::Object(JsonObject::new());
    };
    let mut result = JsonObject::new();
    for (key, value) in fields.iter() {
        let name = key.as_str().unwrap_or_default();
        if name == "nullable"
            && nonempty(get(document, "openapi")).is_some_and(|version| version.starts_with("3.0"))
        {
            continue;
        }
        let value = if name == "$ref" {
            match text(Some(value)).and_then(|value| value.strip_prefix("#/components/schemas/")) {
                Some(reference) => JsonValue::String(format!("#/$defs/{reference}").into()),
                None => value.clone(),
            }
        } else if [
            "properties",
            "patternProperties",
            "$defs",
            "definitions",
            "dependentSchemas",
        ]
        .contains(&name)
        {
            match object(Some(value)) {
                Some(fields) => {
                    let mut result = JsonObject::new();
                    for (name, value) in fields.iter() {
                        result.insert(name.clone(), normalize(document, value));
                    }
                    JsonValue::Object(result)
                }
                None => value.clone(),
            }
        } else if ["allOf", "anyOf", "oneOf", "prefixItems"].contains(&name) {
            JsonValue::Array(
                array(Some(value))
                    .iter()
                    .map(|value| normalize(document, value))
                    .collect(),
            )
        } else if [
            "items",
            "additionalProperties",
            "unevaluatedProperties",
            "propertyNames",
            "then",
            "else",
            "not",
            "if",
            "contains",
        ]
        .contains(&name)
            && object(Some(value)).is_some()
        {
            normalize(document, value)
        } else {
            value.clone()
        };
        result.insert(key.clone(), value);
    }
    if get(value, "nullable") == Some(&JsonValue::Bool(true))
        && nonempty(get(document, "openapi")).is_some_and(|version| version.starts_with("3.0"))
        && let Some(value) = result.get(&"type".into()).cloned()
    {
        result.insert(
            "type".into(),
            JsonValue::Array(vec![value, JsonValue::String("null".into())]),
        );
    }
    JsonValue::Object(result)
}
fn projected(document: &JsonValue, value: &JsonValue, keyword: &str) -> JsonValue {
    normalize(
        document,
        &directional(document, value, value, keyword, &BTreeSet::new()),
    )
}
fn with_definitions(document: &JsonValue, schema: JsonValue, keyword: &str) -> JsonValue {
    let Some(components) =
        get(document, "components").and_then(|value| object(get(value, "schemas")))
    else {
        return schema;
    };
    if components.is_empty() {
        return schema;
    }
    let mut definitions = JsonObject::new();
    for (name, value) in components.iter() {
        definitions.insert(name.clone(), projected(document, value, keyword));
    }
    if let Some(local) = object(get(&schema, "$defs")) {
        for (name, value) in local.iter() {
            definitions.insert(name.clone(), value.clone());
        }
    }
    let JsonValue::Object(mut schema) = schema else {
        return schema;
    };
    schema.insert("$defs".into(), JsonValue::Object(definitions));
    JsonValue::Object(schema)
}

fn fields(
    document: &JsonValue,
    path: &JsonValue,
    operation: &JsonValue,
) -> Result<(Vec<Field>, Option<Body>), String> {
    let mut declared: Vec<(String, String, &JsonValue)> = Vec::new();
    for raw in array(get(path, "parameters"))
        .iter()
        .chain(array(get(operation, "parameters")))
    {
        let value = resolve(document, raw);
        if object(Some(value)).is_none() {
            return Err("parameter declaration is invalid or unresolved".into());
        }
        let name = nonempty(get(value, "name"))
            .ok_or("parameter declaration is missing name or location")?
            .to_owned();
        let location = nonempty(get(value, "in"))
            .ok_or("parameter declaration is missing name or location")?
            .to_owned();
        if let Some(previous) = declared
            .iter_mut()
            .find(|(key, place, _)| key == &name && place == &location)
        {
            previous.2 = value;
        } else {
            declared.push((name, location, value));
        }
    }
    let mut fields = Vec::new();
    for (name, location, value) in declared {
        if location == "cookie" {
            return Err(format!("cookie parameter '{name}' is not supported"));
        }
        let location = match location.as_str() {
            "path" => "path",
            "query" => "query",
            "header" => "header",
            _ => {
                return Err(format!(
                    "parameter '{name}' uses unsupported location '{location}'"
                ));
            }
        };
        if location == "header"
            && ["accept", "content-type", "authorization"].contains(&name.to_lowercase().as_str())
        {
            continue;
        }
        if get(value, "schema").is_none() && get(value, "content").is_none() {
            return Err(format!(
                "parameter '{name}' declares neither schema nor content"
            ));
        }
        if get(value, "content").is_some() {
            return Err(format!(
                "parameter '{name}' uses unsupported content encoding"
            ));
        }
        if get(value, "style").is_some() && nonempty(get(value, "style")).is_none() {
            return Err(format!("parameter '{name}' has an invalid style"));
        }
        for option in ["explode", "allowReserved"] {
            if get(value, option).is_some_and(|value| !matches!(value, JsonValue::Bool(_))) {
                return Err(format!("parameter '{name}' has an invalid {option} value"));
            }
        }
        if get(value, "allowReserved") == Some(&JsonValue::Bool(true)) {
            return Err(format!(
                "parameter '{name}' uses unsupported allowReserved encoding"
            ));
        }
        let style = nonempty(get(value, "style")).unwrap_or(if location == "query" {
            "form"
        } else {
            "simple"
        });
        if location == "query" && !["form", "deepObject"].contains(&style) {
            return Err(format!(
                "query parameter '{name}' uses unsupported style '{style}'"
            ));
        }
        if location != "query" && style != "simple" {
            return Err(format!(
                "{location} parameter '{name}' uses unsupported style '{style}'"
            ));
        }
        let explode = match get(value, "explode") {
            Some(JsonValue::Bool(value)) => *value,
            _ => style == "form",
        };
        if style == "deepObject" && !explode {
            return Err(format!(
                "query parameter '{name}' uses deepObject with explode=false"
            ));
        }
        let mut schema = projected(
            document,
            get(value, "schema").unwrap_or(&JsonValue::Null),
            "readOnly",
        );
        if let JsonValue::Object(schema) = &mut schema
            && schema.get(&"description".into()).is_none()
            && let Some(description) = nonempty(get(value, "description"))
        {
            schema.insert("description".into(), JsonValue::String(description.into()));
        }
        fields.push(Field {
            input_name: String::new(),
            name,
            location,
            required: location == "path" || get(value, "required") == Some(&JsonValue::Bool(true)),
            schema,
            style: style.into(),
            explode,
        });
    }
    fields.sort_by_key(|field| match field.location {
        "path" => 0,
        "query" => 1,
        _ => 2,
    });
    let body = if let Some(raw) = get(operation, "requestBody") {
        let value = resolve(document, raw);
        if object(Some(value)).is_none() {
            None
        } else {
            let content = object(get(value, "content"));
            let selected = content.and_then(|content| {
                content.iter().find(|(media, value)| {
                    media.as_str().is_some_and(json_media) && object(Some(value)).is_some()
                })
            });
            let Some((media, value_schema)) = selected else {
                return Err(format!(
                    "request body has no JSON content (declared: {})",
                    content
                        .map(|content| content
                            .iter()
                            .map(|(name, _)| name.to_utf8().unwrap_or_default())
                            .collect::<Vec<_>>()
                            .join(", "))
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| "none".into())
                ));
            };
            let raw_schema = get(value_schema, "schema").unwrap_or(&JsonValue::Null);
            let resolved = resolve(document, raw_schema);
            let schema = directional(document, resolved, resolved, "readOnly", &BTreeSet::new());
            let required = get(value, "required") == Some(&JsonValue::Bool(true));
            let flatten = required
                && text(get(&schema, "type")) == Some("object")
                && object(get(&schema, "properties")).is_some()
                && get(&schema, "additionalProperties") == Some(&JsonValue::Bool(false))
                && get(&schema, "nullable") != Some(&JsonValue::Bool(true))
                && ["allOf", "anyOf", "oneOf"]
                    .iter()
                    .all(|name| get(&schema, name).is_none());
            if flatten {
                for (name, value) in object(get(&schema, "properties")).unwrap().iter() {
                    let Some(name) = name.as_str() else {
                        return Err("body property name is not representable".into());
                    };
                    fields.push(Field {
                        input_name: String::new(),
                        name: name.into(),
                        location: "body",
                        required: array(get(&schema, "required"))
                            .iter()
                            .any(|value| text(Some(value)) == Some(name)),
                        schema: normalize(document, value),
                        style: String::new(),
                        explode: false,
                    });
                }
            } else {
                fields.push(Field {
                    input_name: String::new(),
                    name: "body".into(),
                    location: "body",
                    required,
                    schema: projected(document, raw_schema, "readOnly"),
                    style: String::new(),
                    explode: false,
                });
            }
            Some(Body {
                required,
                object: flatten,
                media_type: media.to_utf8().map_err(|_| "Invalid JSON media type.")?,
            })
        }
    } else {
        None
    };
    let conflicts = fields
        .iter()
        .filter(|field| {
            fields
                .iter()
                .any(|other| other.name == field.name && other.location != field.location)
        })
        .map(|field| field.name.clone())
        .collect::<BTreeSet<_>>();
    let mut used = BTreeSet::new();
    for field in &mut fields {
        let name = if blocked(&field.name) {
            format!("{}_2", field.name)
        } else {
            field.name.clone()
        };
        let base = if conflicts.contains(&field.name) {
            format!("{}_{name}", field.location)
        } else {
            name
        };
        let mut name = base.clone();
        let mut index = 2;
        while used.contains(&name) {
            name = format!("{base}_{index}");
            index += 1;
        }
        used.insert(name.clone());
        field.input_name = name;
    }
    Ok((fields, body))
}

fn output(document: &JsonValue, operation: &JsonValue) -> Result<Option<JsonValue>, String> {
    if get(operation, "x-websocket") == Some(&JsonValue::Bool(true)) {
        return Err("WebSocket operations are not supported".into());
    }
    let Some(responses) = object(get(operation, "responses")) else {
        return Ok(None);
    };
    let mut selected = responses
        .iter()
        .filter(|(status, _)| {
            status.as_str().is_some_and(|status| {
                status.len() == 3
                    && status.starts_with('2')
                    && status.bytes().all(|byte| byte.is_ascii_digit())
            })
        })
        .collect::<Vec<_>>();
    selected.sort_by(|(a, _), (b, _)| a.cmp(b));
    selected.extend(responses.iter().filter(|(status, _)| {
        status
            .as_str()
            .is_some_and(|status| status.eq_ignore_ascii_case("2XX"))
    }));
    let mut resolved = Vec::new();
    for (_, value) in selected {
        let value = resolve(document, value);
        if object(Some(value)).is_none() || nonempty(get(value, "$ref")).is_some() {
            return Err("successful response declaration is invalid or unresolved".into());
        }
        resolved.push(value);
    }
    if resolved.iter().any(|value| {
        object(get(value, "content")).is_some_and(|content| {
            content.iter().any(|(media, _)| {
                media.as_str().is_some_and(|media| {
                    media
                        .split(';')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .eq_ignore_ascii_case("text/event-stream")
                })
            })
        })
    }) {
        return Err("SSE operations are not supported".into());
    }
    if resolved.iter().any(|value| {
        object(get(value, "content")).is_some_and(|content| {
            content.iter().any(|(media, value)| {
                let media = media
                    .as_str()
                    .unwrap_or_default()
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_lowercase();
                !json_media(&media) && !media.starts_with("text/")
                    || get(value, "schema").is_some_and(|schema| {
                        text(get(resolve(document, schema), "format")) == Some("binary")
                    })
            })
        })
    }) {
        return Err("binary responses are not supported".into());
    }
    let mut outcomes = Vec::new();
    for value in resolved {
        if get(value, "content").is_some() && object(get(value, "content")).is_none() {
            return Ok(None);
        }
        let Some(content) = object(get(value, "content")).filter(|content| !content.is_empty())
        else {
            outcomes.push(schema_type("null"));
            continue;
        };
        for (media, value) in content.iter() {
            if !media.as_str().is_some_and(json_media) {
                outcomes.push(schema_type("string"));
                continue;
            }
            let Some(schema) = get(value, "schema") else {
                return Ok(None);
            };
            outcomes.push(projected(document, schema, "writeOnly"));
        }
    }
    let schema = match outcomes.len() {
        0 => return Ok(None),
        1 => outcomes.remove(0),
        _ => {
            let mut object = JsonObject::new();
            object.insert("anyOf".into(), JsonValue::Array(outcomes));
            JsonValue::Object(object)
        }
    };
    Ok(Some(with_definitions(document, schema, "writeOnly")))
}
fn schema_type(value: &str) -> JsonValue {
    let mut object = JsonObject::new();
    object.insert("type".into(), JsonValue::String(value.into()));
    JsonValue::Object(object)
}
fn blocked(value: &str) -> bool {
    ["__proto__", "prototype", "constructor"].contains(&value)
}
fn segment(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || "_$".contains(character) {
            output.push(character);
        } else if !output.ends_with('_') {
            output.push('_');
        }
    }
    let output = output.trim_matches('_');
    let output = if output.is_empty() {
        "operation".into()
    } else if output.starts_with(|character: char| character.is_ascii_digit()) {
        format!("_{output}")
    } else {
        output.into()
    };
    if blocked(&output) {
        format!("{output}_2")
    } else {
        output
    }
}
fn available(segments: &[String], used: &BTreeSet<String>, namespaces: &BTreeSet<String>) -> bool {
    let key = segments.join(".");
    !used.contains(&key)
        && !namespaces.contains(&key)
        && (1..segments.len()).all(|index| !used.contains(&segments[..index].join(".")))
}
fn operation_path(
    method: &str,
    path: &str,
    operation: &Operation,
    used: &BTreeSet<String>,
    namespaces: &BTreeSet<String>,
) -> String {
    let segments = match &operation.operation_id {
        Some(name) => name.split('.').map(segment).collect::<Vec<_>>(),
        None => {
            let words = std::iter::once(method.to_owned())
                .chain(
                    path.split('/')
                        .filter(|part| !part.is_empty())
                        .flat_map(|part| {
                            if part.starts_with('{') && part.ends_with('}') {
                                vec!["by".into(), part[1..part.len() - 1].into()]
                            } else {
                                vec![part.into()]
                            }
                        }),
                )
                .flat_map(|part| {
                    part.split(|character: char| !character.is_ascii_alphanumeric())
                        .filter(|word| !word.is_empty())
                        .map(str::to_lowercase)
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let name = words
                .into_iter()
                .enumerate()
                .map(|(index, word)| {
                    if index == 0 {
                        word
                    } else {
                        format!("{}{}", word[..1].to_uppercase(), &word[1..])
                    }
                })
                .collect::<String>();
            vec![segment(&name)]
        }
    };
    if available(&segments, used, namespaces) {
        return segments.join(".");
    }
    if let Some(index) =
        (1..segments.len()).find(|index| used.contains(&segments[..*index].join(".")))
    {
        let mut collapsed = segments.clone();
        let next = collapsed.remove(index);
        let first = next.chars().next().expect("sanitized segment is nonempty");
        collapsed[index - 1].push_str(&format!(
            "{}{}",
            first.to_uppercase(),
            &next[first.len_utf8()..]
        ));
        if available(&collapsed, used, namespaces) {
            return collapsed.join(".");
        }
    }
    let base = segments.join("_");
    let mut index = 2;
    loop {
        let name = format!("{base}_{index}");
        if available(std::slice::from_ref(&name), used, namespaces) {
            return name;
        }
        index += 1;
    }
}
fn server(value: &JsonValue) -> Result<String, String> {
    let value = array(get(value, "servers"))
        .iter()
        .find(|value| object(Some(value)).is_some())
        .and_then(|value| nonempty(get(value, "url")))
        .ok_or("spec declares no servers; pass baseUrl")?;
    if value.contains('{') && value.contains('}') {
        return Err(format!(
            "server URL '{value}' is not an absolute URL; pass baseUrl"
        ));
    }
    base_url(value)
}
fn base_url(value: &str) -> Result<String, String> {
    let valid_prefix = value
        .get(..7)
        .is_some_and(|value| value.eq_ignore_ascii_case("http://"))
        || value
            .get(..8)
            .is_some_and(|value| value.eq_ignore_ascii_case("https://"));
    let url = url::Url::parse(value)
        .ok()
        .filter(|url| valid_prefix && ["http", "https"].contains(&url.scheme()))
        .ok_or_else(|| format!("server URL '{value}' is not an absolute HTTP(S) URL"))?;
    if url.query().is_some_and(|value| !value.is_empty())
        || url.fragment().is_some_and(|value| !value.is_empty())
    {
        return Err(format!(
            "server URL '{value}' contains an unsupported query string or fragment"
        ));
    }
    Ok(value.into())
}
fn schemes(document: &JsonValue) -> JsonObject {
    let mut schemes = JsonObject::new();
    let Some(declared) =
        get(document, "components").and_then(|value| object(get(value, "securitySchemes")))
    else {
        return schemes;
    };
    for (name, value) in declared.iter() {
        let value = resolve(document, value);
        let valid = match nonempty(get(value, "type")) {
            Some("apiKey") => {
                nonempty(get(value, "name")).is_some()
                    && matches!(text(get(value, "in")), Some("header" | "query" | "cookie"))
            }
            Some("http") => nonempty(get(value, "scheme")).is_some(),
            Some("oauth2" | "openIdConnect") => true,
            _ => false,
        };
        if valid {
            schemes.insert(name.clone(), value.clone());
        }
    }
    schemes
}
fn security(
    value: Option<&JsonValue>,
    schemes: &JsonObject,
) -> Result<Vec<SecurityRequirement>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let JsonValue::Array(requirements) = value else {
        return Err("security declaration is not an array".into());
    };
    let mut parsed = Vec::new();
    let mut names = Vec::new();
    let mut cookie = None;
    for value in requirements {
        let Some(requirement) = object(Some(value)) else {
            return Err("security requirement is not an object".into());
        };
        let mut fields = Vec::new();
        let mut supported = true;
        for (name, value) in requirement.iter() {
            let Some(name) = name.as_str() else {
                return Err("security requirement name is not representable".into());
            };
            let JsonValue::Array(scopes) = value else {
                return Err("security requirement scopes are not string arrays".into());
            };
            let scopes = scopes
                .iter()
                .map(|value| {
                    text(Some(value)).map(str::to_owned).ok_or_else(|| {
                        "security requirement scopes are not string arrays".to_owned()
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            if !names.iter().any(|previous| previous == name) {
                names.push(name.to_owned());
            }
            match schemes.get(&name.into()) {
                Some(value)
                    if text(get(value, "type")) == Some("apiKey")
                        && text(get(value, "in")) == Some("cookie") =>
                {
                    if cookie.is_none() {
                        cookie = Some(name.to_owned());
                    }
                    supported = false;
                }
                None => supported = false,
                _ => {}
            }
            fields.push((name.to_owned(), scopes));
        }
        if supported {
            parsed.push(fields);
        }
    }
    if requirements.is_empty() || !parsed.is_empty() {
        return Ok(parsed);
    }
    Err(match cookie {
        Some(cookie) => format!("cookie authentication '{cookie}' is not supported"),
        None => format!(
            "security requirement references missing or malformed scheme: {}",
            names.join(", ")
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ycoding_schema::parse_json;

    fn diamond(depth: usize) -> JsonValue {
        let schemas = (0..depth)
            .map(|index| {
                let schema = if index == depth - 1 {
                    r#"{"type":"object","properties":{"id":{"type":"string","readOnly":true},"name":{"type":"string"}}}"#.to_owned()
                } else {
                    let next = format!(r##"{{"$ref":"#/components/schemas/C{}"}}"##, index + 1);
                    format!(r#"{{"allOf":[{next},{next}]}}"#)
                };
                format!(r#""C{index}":{schema}"#)
            })
            .collect::<Vec<_>>()
            .join(",");
        parse_json(&format!(
            r#"{{"openapi":"3.1.0","paths":{{}},"components":{{"schemas":{{{schemas}}}}}}}"#
        ))
        .unwrap()
    }

    #[test]
    fn diamond_shaped_reference_graphs_project_in_linear_time() {
        let depth = 30;
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let document = diamond(depth);
            let input = parse_json(
                r##"{"type":"object","properties":{"body":{"$ref":"#/components/schemas/C0"}}}"##,
            )
            .unwrap();
            let projected = with_definitions(&document, input, "readOnly");
            let leaf = get(
                get(&projected, "$defs").unwrap(),
                &format!("C{}", depth - 1),
            )
            .unwrap();
            let names = object(get(leaf, "properties"))
                .unwrap()
                .iter()
                .map(|(name, _)| name.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            sender.send(names).ok();
        });
        let names = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("projection must finish in linear time");
        assert_eq!(names, ["name"]);
    }
}
