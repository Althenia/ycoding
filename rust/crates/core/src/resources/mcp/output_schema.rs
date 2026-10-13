use super::client::Error;
use serde_json::{Value, json};
use ycoding_schema::{DomainDecode, form, parse_json};

pub(crate) fn check(schema: &Value) -> Result<(), Error> {
    let Some(object) = schema.as_object() else {
        return Err(Error::UnsupportedSchema("boolean schema".into()));
    };
    for key in object.keys() {
        if ![
            "type",
            "properties",
            "required",
            "additionalProperties",
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
        .contains(&key.as_str())
        {
            return Err(Error::UnsupportedSchema(key.clone()));
        }
    }
    match schema["type"].as_str() {
        Some("object") => {
            if let Some(properties) = schema.get("properties") {
                let Some(properties) = properties.as_object() else {
                    return Err(Error::InvalidResult("outputSchema.properties"));
                };
                for property in properties.values() {
                    check(property)?;
                }
            }
            if let Some(required) = schema.get("required")
                && !required
                    .as_array()
                    .is_some_and(|required| required.iter().all(Value::is_string))
            {
                return Err(Error::InvalidResult("outputSchema.required"));
            }
            if schema
                .get("additionalProperties")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err(Error::UnsupportedSchema(
                    "additionalProperties schema".into(),
                ));
            }
            Ok(())
        }
        Some("string" | "number" | "integer" | "boolean") => primitive(schema).map(|_| ()),
        _ => Err(Error::UnsupportedSchema("type".into())),
    }
}

pub(crate) fn validate(schema: &Value, value: &Value) -> Result<(), Error> {
    if schema["type"] == "object" {
        let Some(object) = value.as_object() else {
            return Err(Error::OutputSchema);
        };
        if let Some(required) = schema["required"].as_array()
            && required
                .iter()
                .filter_map(Value::as_str)
                .any(|key| !object.contains_key(key))
        {
            return Err(Error::OutputSchema);
        }
        let properties = schema["properties"].as_object();
        for (key, value) in object {
            if let Some(schema) = properties.and_then(|properties| properties.get(key)) {
                validate(schema, value)?;
                continue;
            }
            if schema["additionalProperties"] == false {
                return Err(Error::OutputSchema);
            }
        }
        return Ok(());
    }
    let mut field = primitive(schema)?;
    if let form::Field::String(field) = &mut field
        && let Some(value) = value.as_str()
    {
        let length = value.chars().count();
        if field
            .min_length
            .is_some_and(|minimum| length < minimum.get() as usize)
            || field
                .max_length
                .is_some_and(|maximum| length > maximum.get() as usize)
        {
            return Err(Error::OutputSchema);
        }
        field.min_length = None;
        field.max_length = None;
    }
    crate::tools::policy::forms::validate_field(
        &field,
        &parse_json(&value.to_string()).map_err(|_| Error::OutputSchema)?,
    )
    .map_err(|_| Error::OutputSchema)
}

fn primitive(schema: &Value) -> Result<form::Field, Error> {
    let mut field = schema.clone();
    let object = field
        .as_object_mut()
        .ok_or(Error::InvalidResult("outputSchema"))?;
    object.insert("key".into(), json!("output"));
    object.remove("required");
    form::Field::decode(
        &parse_json(&field.to_string()).map_err(|_| Error::InvalidResult("outputSchema"))?,
    )
    .map_err(|_| Error::UnsupportedSchema("primitive constraints".into()))
}
