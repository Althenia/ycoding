use crate::{
    json,
    llm::{Request, ResponseFormat},
};
use ycoding_schema::JsonValue;

pub(crate) fn request_schema(request: &Request) -> Option<JsonValue> {
    let Some(ResponseFormat::Json(schema)) = &request.response_format else {
        return None;
    };
    Some(if matches!(schema, JsonValue::Object(_)) {
        project(schema)
    } else {
        json::empty()
    })
}

fn project(schema: &JsonValue) -> JsonValue {
    match schema {
        JsonValue::Array(values) => JsonValue::Array(values.iter().map(project).collect()),
        JsonValue::Object(fields) => json::object(fields.iter().filter_map(|(key, value)| {
            let value = match (key.as_str(), value) {
                (
                    Some(
                        "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum"
                        | "multipleOf" | "minLength" | "maxLength" | "maxItems" | "uniqueItems"
                        | "minContains" | "maxContains" | "minProperties" | "maxProperties",
                    ),
                    _,
                ) => return None,
                (Some("minItems"), JsonValue::Number(value)) if *value > 1.0 => {
                    return None;
                }
                (Some("minItems" | "enum" | "const" | "default" | "examples" | "required"), _) => {
                    value.clone()
                }
                (
                    Some(
                        "properties" | "patternProperties" | "$defs" | "definitions"
                        | "dependentSchemas",
                    ),
                    JsonValue::Object(children),
                ) => json::object(
                    children
                        .iter()
                        .map(|(name, child)| (name.clone(), project(child))),
                ),
                _ => project(value),
            };
            Some((key.clone(), value))
        })),
        _ => schema.clone(),
    }
}
