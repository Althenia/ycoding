use crate::{
    json::{self, get, s},
    llm::ToolSchemaCompatibility,
};
use ycoding_schema::{JsonValue, LosslessString, stringify_json};

fn fields(value: &JsonValue) -> impl Iterator<Item = (LosslessString, JsonValue)> + '_ {
    match value {
        JsonValue::Object(object) => Some(object.iter()),
        _ => None,
    }
    .into_iter()
    .flatten()
    .cloned()
}
fn remove_null(value: &JsonValue) -> JsonValue {
    if let JsonValue::Array(values) = value {
        return JsonValue::Array(values.iter().map(remove_null).collect());
    }
    if !matches!(value, JsonValue::Object(_)) {
        return value.clone();
    }
    let mut result = json::object(
        fields(value)
            .filter(|(key, _)| key.as_str() != Some("anyOf"))
            .map(|(key, value)| (key, remove_null(&value))),
    );
    if let Some(variants) = get(value, "anyOf").and_then(json::array) {
        let variants: Vec<_> = variants
            .iter()
            .filter(|value| get(value, "type").and_then(json::text) != Some("null"))
            .map(remove_null)
            .collect();
        if variants.len() == 1 && matches!(variants[0], JsonValue::Object(_)) {
            result = json::merge(&result, &variants[0]);
        } else {
            json::set(&mut result, "anyOf", JsonValue::Array(variants));
        }
    }
    result
}
pub(crate) fn openai(schema: &JsonValue) -> JsonValue {
    let variants: Vec<_> = get(schema, "anyOf")
        .and_then(json::array)
        .unwrap_or(&[])
        .iter()
        .filter(|value| matches!(value, JsonValue::Object(_)))
        .collect();
    if variants.is_empty() {
        let mut result = schema.clone();
        json::set(&mut result, "type", s("object"));
        return remove_null(&result);
    }
    let required: Vec<_> = get(variants[0], "required")
        .and_then(json::array)
        .unwrap_or(&[])
        .iter()
        .filter(|name| {
            variants.iter().all(|variant| {
                get(variant, "required")
                    .and_then(json::array)
                    .is_some_and(|required| required.contains(name))
            })
        })
        .cloned()
        .collect();
    let mut properties: Vec<(LosslessString, Vec<JsonValue>)> = Vec::new();
    for variant in &variants {
        if let Some(value) = get(variant, "properties") {
            for (key, value) in fields(value) {
                if let Some((_, values)) = properties.iter_mut().find(|(name, _)| *name == key) {
                    if !values
                        .iter()
                        .any(|prior| stringify_json(prior) == stringify_json(&value))
                    {
                        values.push(value);
                    }
                } else {
                    properties.push((key, vec![value]));
                }
            }
        }
    }
    let mut result = json::remove(schema, &["anyOf"]);
    json::set(&mut result, "type", s("object"));
    json::set(
        &mut result,
        "properties",
        json::object(properties.into_iter().map(|(key, mut values)| {
            (
                key,
                if values.len() == 1 {
                    values.remove(0)
                } else {
                    json::object([("anyOf", JsonValue::Array(values))])
                },
            )
        })),
    );
    if !required.is_empty() {
        json::set(&mut result, "required", JsonValue::Array(required));
    }
    json::set(&mut result, "additionalProperties", JsonValue::Bool(false));
    remove_null(&result)
}
fn declared_types(
    schema: &JsonValue,
    definitions: &JsonValue,
    visited: &[LosslessString],
) -> Vec<Option<LosslessString>> {
    if !matches!(schema, JsonValue::Object(_)) {
        return vec![None];
    }
    if get(schema, "not")
        .is_some_and(|value| matches!(value,JsonValue::Object(object) if object.is_empty()))
    {
        return Vec::new();
    }
    if let Some(value) = get(schema, "type") {
        match value {
            JsonValue::String(value) => return vec![Some(value.clone())],
            JsonValue::Array(values) => {
                return values
                    .iter()
                    .map(|value| json::string(value).cloned())
                    .collect();
            }
            _ => {}
        }
    }
    if let Some(name) = get(schema, "$ref").and_then(json::text) {
        let name: LosslessString = name.replacen("#/$defs/", "", 1).into();
        if visited.contains(&name) {
            return Vec::new();
        }
        let mut visited = visited.to_vec();
        visited.push(name.clone());
        return match definitions {
            JsonValue::Object(definitions) => definitions
                .get(&name)
                .map(|value| {
                    declared_types(value, &JsonValue::Object(definitions.clone()), &visited)
                })
                .unwrap_or_else(|| vec![None]),
            _ => vec![None],
        };
    }
    if let Some(values) = get(schema, "anyOf").and_then(json::array) {
        return values
            .iter()
            .flat_map(|value| declared_types(value, definitions, visited))
            .collect();
    }
    vec![None]
}
pub fn anthropic(schema: &JsonValue) -> JsonValue {
    let mut schema = schema.clone();
    if get(&schema, "type").is_none() {
        json::set(&mut schema, "type", s("object"));
    }
    if !["anyOf", "oneOf", "allOf"]
        .iter()
        .any(|key| get(&schema, key).and_then(json::array).is_some())
    {
        return schema;
    }
    let definitions = get(&schema, "$defs")
        .filter(|value| matches!(value, JsonValue::Object(_)))
        .cloned()
        .unwrap_or_else(json::empty);
    let root = json::remove(&schema, &["$defs"]);
    let mut name = "__ycoding_root".to_string();
    let mut suffix = 0;
    while get(&definitions, &name).is_some() {
        suffix += 1;
        name = format!("__ycoding_root_{suffix}");
    }
    let flattened = if get(&schema, "anyOf").and_then(json::array).is_some() {
        openai(&json::remove(&root, &["properties", "required"]))
    } else {
        json::empty()
    };
    let properties = json::merge(
        get(&flattened, "properties").unwrap_or(&json::empty()),
        get(&root, "properties").unwrap_or(&json::empty()),
    );
    let mut required = Vec::new();
    for value in [get(&root, "required"), get(&flattened, "required")]
        .into_iter()
        .flatten()
        .filter_map(json::array)
        .flatten()
    {
        if !required.contains(value) {
            required.push(value.clone());
        }
    }
    let mut root = root;
    if fields(&properties).next().is_some() {
        json::set(
            &mut root,
            "properties",
            json::object(fields(&properties).map(|(key, mut value)| {
                let mut types = declared_types(&value, &definitions, &[]);
                types.sort();
                types.dedup();
                if matches!(value, JsonValue::Object(_))
                    && get(&value, "type").is_none()
                    && types.len() == 1
                    && let Some(kind) = &types[0]
                {
                    let prefix = json::object([("type", s(kind.clone()))]);
                    value = json::merge(&prefix, &value);
                }
                (key, value)
            })),
        );
        if !required.is_empty() {
            json::set(&mut root, "required", JsonValue::Array(required));
        }
    }
    let mut definitions = definitions;
    json::set(&mut definitions, name.clone(), root);
    json::object([
        ("type", s("object")),
        ("$ref", s(format!("#/$defs/{name}"))),
        ("$defs", definitions),
    ])
}
fn moonshot(value: &JsonValue) -> JsonValue {
    if let JsonValue::Array(values) = value {
        return JsonValue::Array(values.iter().map(moonshot).collect());
    }
    if !matches!(value, JsonValue::Object(_)) {
        return value.clone();
    }
    if let Some(reference) = get(value, "$ref").and_then(json::string) {
        return json::object([("$ref", s(reference.clone()))]);
    }
    fn tuple(values: &[JsonValue]) -> JsonValue {
        let values: Vec<_> = values.iter().map(moonshot).collect();
        match values.as_slice() {
            [] => json::empty(),
            [value] => value.clone(),
            _ => json::object([("anyOf", JsonValue::Array(values))]),
        }
    }
    json::object(fields(value).filter_map(|(key, field)| match key.as_str() {
        Some("unevaluatedItems") => None,
        Some("prefixItems") => {
            if get(value, "items").is_some() {
                None
            } else {
                Some(("items".into(), tuple(json::array(&field).unwrap_or(&[]))))
            }
        }
        Some("items") if json::array(&field).is_some() => {
            Some((key, tuple(json::array(&field).unwrap_or(&[]))))
        }
        _ => Some((key, moonshot(&field))),
    }))
}
fn combiner(schema: &JsonValue) -> bool {
    ["anyOf", "oneOf", "allOf"]
        .iter()
        .any(|key| get(schema, key).and_then(json::array).is_some())
}
fn sanitize(value: &JsonValue) -> JsonValue {
    if let JsonValue::Array(values) = value {
        return JsonValue::Array(values.iter().map(sanitize).collect());
    }
    if !matches!(value, JsonValue::Object(_)) {
        return value.clone();
    }
    let mut result = json::object(fields(value).map(|(key, value)| {
        let value = if key.as_str() == Some("enum") {
            if let Some(values) = json::array(&value) {
                JsonValue::Array(
                    values
                        .iter()
                        .map(|value| {
                            s(json::string(value)
                                .cloned()
                                .unwrap_or_else(|| stringify_json(value).into()))
                        })
                        .collect(),
                )
            } else {
                sanitize(&value)
            }
        } else {
            sanitize(&value)
        };
        (key, value)
    }));
    if get(&result, "enum").and_then(json::array).is_some()
        && matches!(
            get(&result, "type").and_then(json::text),
            Some("integer" | "number")
        )
    {
        json::set(&mut result, "type", s("string"));
    }
    if get(&result, "type").and_then(json::text) == Some("object")
        && let (Some(JsonValue::Object(properties)), Some(required)) = (
            get(&result, "properties"),
            get(&result, "required").and_then(json::array),
        )
    {
        let required = required
            .iter()
            .filter(|value| json::string(value).is_some_and(|name| properties.get(name).is_some()))
            .cloned()
            .collect();
        json::set(&mut result, "required", JsonValue::Array(required));
    }
    if get(&result, "type").and_then(json::text) == Some("array") && !combiner(&result) {
        let mut items = get(&result, "items").cloned().unwrap_or_else(json::empty);
        if matches!(items, JsonValue::Object(_))
            && !combiner(&items)
            && ![
                "type",
                "properties",
                "items",
                "prefixItems",
                "enum",
                "const",
                "$ref",
                "additionalProperties",
                "patternProperties",
                "required",
                "not",
                "if",
                "then",
                "else",
            ]
            .iter()
            .any(|key| get(&items, key).is_some())
        {
            json::set(&mut items, "type", s("string"));
        }
        json::set(&mut result, "items", items);
    }
    if get(&result, "type")
        .and_then(json::text)
        .is_some_and(|kind| kind != "object")
        && !combiner(&result)
    {
        result = json::remove(&result, &["properties", "required"]);
    }
    result
}
fn gemini(schema: &JsonValue) -> Option<JsonValue> {
    if !matches!(schema, JsonValue::Object(_)) {
        return None;
    }
    if get(schema, "type").and_then(json::text) == Some("object")
        && get(schema, "properties")
            .is_none_or(|value| !matches!(value,JsonValue::Object(object) if !object.is_empty()))
        && get(schema, "additionalProperties")
            .is_none_or(|value| matches!(value, JsonValue::Bool(false) | JsonValue::Null))
    {
        return None;
    }
    let mut result = json::empty();
    for key in [
        "description",
        "required",
        "format",
        "type",
        "enum",
        "properties",
        "items",
        "allOf",
        "anyOf",
        "oneOf",
        "minLength",
    ] {
        if key == "enum"
            && let Some(value) = get(schema, "const")
        {
            json::set(&mut result, key, JsonValue::Array(vec![value.clone()]));
            continue;
        }
        let Some(value) = get(schema, key) else {
            continue;
        };
        let value = match key {
            "type" if json::array(value).is_some() => {
                let values = json::array(value).unwrap_or(&[]);
                if values.contains(&s("null")) {
                    json::set(&mut result, "nullable", JsonValue::Bool(true));
                }
                let Some(kind) = values
                    .iter()
                    .find(|value| json::text(value) != Some("null"))
                else {
                    continue;
                };
                kind.clone()
            }
            "properties" => json::object(
                fields(value).filter_map(|(key, value)| gemini(&value).map(|value| (key, value))),
            ),
            "items" | "allOf" | "anyOf" | "oneOf" => {
                if let Some(values) = json::array(value) {
                    JsonValue::Array(
                        values
                            .iter()
                            .map(|value| gemini(value).unwrap_or(JsonValue::Null))
                            .collect(),
                    )
                } else {
                    let Some(value) = gemini(value) else {
                        continue;
                    };
                    value
                }
            }
            _ => value.clone(),
        };
        json::set(&mut result, key, value);
    }
    Some(result)
}
pub fn model_compatibility(
    schema: &JsonValue,
    compatibility: Option<ToolSchemaCompatibility>,
) -> JsonValue {
    match compatibility {
        None => schema.clone(),
        Some(ToolSchemaCompatibility::Moonshot) => moonshot(schema),
        Some(ToolSchemaCompatibility::Gemini) => {
            gemini(&sanitize(schema)).unwrap_or_else(json::empty)
        }
    }
}
