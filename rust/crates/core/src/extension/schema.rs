use super::Error;
use ycoding_schema::{DomainDecode, JsonObject, JsonValue, form};

fn get<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}
fn kind(schema: &JsonValue) -> Option<&str> {
    match get(schema, "type") {
        Some(JsonValue::String(value)) => value.as_str(),
        _ => None,
    }
}
pub fn check(schema: &JsonValue) -> Result<(), Error> {
    let JsonValue::Object(object) = schema else {
        return Err(Error::Schema);
    };
    if object.iter().any(|(key, _)| {
        !key.as_str().is_some_and(|key| {
            [
                "type",
                "properties",
                "required",
                "additionalProperties",
                "items",
                "title",
                "description",
                "$schema",
                "minimum",
                "maximum",
                "minLength",
                "maxLength",
                "pattern",
                "format",
                "default",
            ]
            .contains(&key)
        })
    }) {
        return Err(Error::Schema);
    }
    match kind(schema) {
        Some("object") => {
            if let Some(properties) = get(schema, "properties") {
                let JsonValue::Object(properties) = properties else {
                    return Err(Error::Schema);
                };
                for (_, property) in properties.iter() {
                    check(property)?;
                }
            }
            if let Some(required) = get(schema, "required") {
                let JsonValue::Array(required) = required else {
                    return Err(Error::Schema);
                };
                if required
                    .iter()
                    .any(|item| !matches!(item, JsonValue::String(_)))
                {
                    return Err(Error::Schema);
                }
            }
            if get(schema, "additionalProperties")
                .is_some_and(|item| !matches!(item, JsonValue::Bool(_)))
            {
                return Err(Error::Schema);
            }
            Ok(())
        }
        Some("array") => check(get(schema, "items").ok_or(Error::Schema)?),
        Some("null") => Ok(()),
        Some("string" | "number" | "integer" | "boolean") => primitive(schema).map(|_| ()),
        _ => Err(Error::Schema),
    }
}
fn primitive(schema: &JsonValue) -> Result<form::Field, Error> {
    let JsonValue::Object(object) = schema else {
        return Err(Error::Schema);
    };
    let mut field = JsonObject::new();
    for (key, value) in object
        .iter()
        .filter(|(key, _)| key.as_str() != Some("required"))
    {
        field.insert(key.clone(), value.clone());
    }
    field.insert("key".into(), JsonValue::String("extension".into()));
    form::Field::decode(&JsonValue::Object(field)).map_err(|_| Error::Schema)
}
pub fn validate(schema: &JsonValue, value: &JsonValue) -> Result<(), Error> {
    match kind(schema) {
        Some("object") => {
            let JsonValue::Object(object) = value else {
                return Err(Error::Schema);
            };
            if let Some(JsonValue::Array(required)) = get(schema, "required") {
                for key in required {
                    let JsonValue::String(key) = key else {
                        return Err(Error::Schema);
                    };
                    if object.get(key).is_none() {
                        return Err(Error::Schema);
                    }
                }
            }
            for (key, value) in object.iter() {
                if let Some(JsonValue::Object(properties)) = get(schema, "properties")
                    && let Some(schema) = properties.get(key)
                {
                    validate(schema, value)?;
                    continue;
                }
                if get(schema, "additionalProperties") == Some(&JsonValue::Bool(false)) {
                    return Err(Error::Schema);
                }
            }
            Ok(())
        }
        Some("array") => {
            let JsonValue::Array(items) = value else {
                return Err(Error::Schema);
            };
            for item in items {
                validate(get(schema, "items").ok_or(Error::Schema)?, item)?;
            }
            Ok(())
        }
        Some("null") if value == &JsonValue::Null => Ok(()),
        Some("string" | "number" | "integer" | "boolean") => {
            crate::tools::policy::forms::validate_field(&primitive(schema)?, value)
                .map_err(|_| Error::Schema)
        }
        _ => Err(Error::Schema),
    }
}
