use crate::json::{self, get, s};
use ycoding_schema::{JsonValue, LosslessString};

fn fields(value: &JsonValue) -> impl Iterator<Item = (LosslessString, JsonValue)> + '_ {
    match value {
        JsonValue::Object(fields) => Some(fields.iter()),
        _ => None,
    }
    .into_iter()
    .flatten()
    .cloned()
}
fn combiner(value: &JsonValue) -> bool {
    ["anyOf", "oneOf", "allOf"]
        .iter()
        .any(|key| get(value, key).and_then(json::array).is_some())
}
fn sanitize(value: &JsonValue) -> JsonValue {
    if let JsonValue::Array(values) = value {
        return JsonValue::Array(values.iter().map(sanitize).collect());
    }
    if !matches!(value, JsonValue::Object(_)) {
        return value.clone();
    }
    let mut result = json::object(fields(value).map(|(key, value)| {
        let value = if key.as_str() == Some("enum") && json::array(&value).is_some() {
            JsonValue::Array(
                json::array(&value)
                    .unwrap_or(&[])
                    .iter()
                    .map(|value| s(json::js_string(value)))
                    .collect(),
            )
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
            .filter(|field| {
                json::string(field).is_some_and(|field| properties.get(field).is_some())
            })
            .cloned()
            .collect();
        json::set(&mut result, "required", JsonValue::Array(required));
    }
    if get(&result, "type").and_then(json::text) == Some("array") && !combiner(&result) {
        let mut items = get(&result, "items")
            .filter(|value| !matches!(value, JsonValue::Null))
            .cloned()
            .unwrap_or_else(json::empty);
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
fn truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null | JsonValue::Bool(false) => false,
        JsonValue::Number(value) => *value != 0.0 && !value.is_nan(),
        JsonValue::String(value) => !value.is_empty(),
        _ => true,
    }
}
fn project(schema: &JsonValue) -> Option<JsonValue> {
    if !matches!(schema, JsonValue::Object(_)) {
        return None;
    }
    if get(schema, "type").and_then(json::text) == Some("object")
        && get(schema, "properties")
            .is_none_or(|value| !matches!(value,JsonValue::Object(fields) if !fields.is_empty()))
        && get(schema, "additionalProperties").is_none_or(|value| !truthy(value))
    {
        return None;
    }
    let mut result = json::empty();
    for key in [
        "description",
        "required",
        "format",
        "type",
        "nullable",
        "enum",
        "properties",
        "items",
        "allOf",
        "anyOf",
        "oneOf",
        "minLength",
    ] {
        if key == "nullable" {
            if get(schema, "type")
                .and_then(json::array)
                .is_some_and(|types| types.contains(&s("null")))
            {
                json::set(&mut result, key, JsonValue::Bool(true));
            }
            continue;
        }
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
                let Some(value) = json::array(value)
                    .unwrap_or(&[])
                    .iter()
                    .find(|value| json::text(value) != Some("null"))
                else {
                    continue;
                };
                value.clone()
            }
            "properties" => {
                if !matches!(value, JsonValue::Object(_)) {
                    continue;
                }
                json::object(
                    fields(value)
                        .filter_map(|(key, value)| project(&value).map(|value| (key, value))),
                )
            }
            "items" => {
                if let Some(values) = json::array(value) {
                    JsonValue::Array(
                        values
                            .iter()
                            .map(|value| project(value).unwrap_or(JsonValue::Null))
                            .collect(),
                    )
                } else {
                    let Some(value) = project(value) else {
                        continue;
                    };
                    value
                }
            }
            "allOf" | "anyOf" | "oneOf" => {
                let Some(values) = json::array(value) else {
                    continue;
                };
                JsonValue::Array(
                    values
                        .iter()
                        .map(|value| project(value).unwrap_or(JsonValue::Null))
                        .collect(),
                )
            }
            _ => value.clone(),
        };
        json::set(&mut result, key, value);
    }
    Some(result)
}
pub(crate) fn convert(schema: &JsonValue) -> Option<JsonValue> {
    project(&sanitize(schema))
}
