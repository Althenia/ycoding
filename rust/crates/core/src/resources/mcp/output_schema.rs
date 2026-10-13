use super::client::Error;
use crate::regexp::{Budget, RegExp};
use jsonschema::{
    Draft, Keyword, ValidationError, Validator,
    error::{TypeKind, ValidationErrorKind},
};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct Cached {
    pub(crate) schema: Value,
    pub(crate) validator: Option<Arc<Validator>>,
}

pub(crate) fn cached(schema: &Value, previous: Option<&Cached>) -> Cached {
    if let Some(previous) = previous.filter(|previous| previous.schema == *schema) {
        return previous.clone();
    }
    Cached {
        schema: schema.clone(),
        validator: compile(schema).ok().map(Arc::new),
    }
}

pub(crate) fn compile(schema: &Value) -> Result<Validator, Error> {
    if !schema.is_object() {
        return Err(Error::UnsupportedSchema(
            "root schema must be an object".into(),
        ));
    }
    let draft = match schema["$schema"]
        .as_str()
        .map(|value| value.trim_end_matches('#'))
    {
        None
        | Some(
            "https://json-schema.org/draft/2020-12/schema"
            | "http://json-schema.org/draft/2020-12/schema",
        ) => Draft::Draft202012,
        Some(
            "https://json-schema.org/draft/2019-09/schema"
            | "http://json-schema.org/draft/2019-09/schema",
        ) => Draft::Draft201909,
        Some(
            "https://json-schema.org/draft-07/schema"
            | "http://json-schema.org/draft-07/schema"
            | "https://json-schema.org/draft-06/schema"
            | "http://json-schema.org/draft-06/schema",
        ) => Draft::Draft7,
        _ => return Err(Error::UnsupportedSchema("$schema dialect".into())),
    };
    let mut schema = schema.clone();
    prepare(&mut schema, draft)?;
    jsonschema::options()
        .with_draft(draft)
        .offline()
        .should_validate_formats(true)
        .should_ignore_unknown_formats(true)
        .with_keyword("pattern", |_, value, _| {
            let pattern = value.as_str().ok_or_else(|| ValidationError::custom("pattern must be a string"))?;
            Ok(Box::new(Pattern {
                regex: RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "u").map_err(|error| ValidationError::custom(error.to_string()))?,
                pattern: pattern.to_string(),
            }))
        })
        .with_format("email", |value| format_pattern(value, r"^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", "i"))
        .with_format("uuid", |value| format_pattern(value, r"^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$", "i"))
        .with_format("regex", |value| RegExp::new(&value.encode_utf16().collect::<Vec<_>>(), "").is_ok())
        .build(&schema)
        .map_err(|error| Error::UnsupportedSchema(error.to_string()))
}

fn prepare(schema: &mut Value, draft: Draft) -> Result<(), Error> {
    let Some(object) = schema.as_object_mut() else {
        return Ok(());
    };
    for key in [
        "title",
        "description",
        "default",
        "examples",
        "$comment",
        "readOnly",
        "writeOnly",
        "deprecated",
        "contentEncoding",
        "contentMediaType",
        "contentSchema",
        "$vocabulary",
    ] {
        object.remove(key);
    }
    object.remove("$schema");
    if let Some(nullable) = object.remove("nullable") {
        let nullable = nullable
            .as_bool()
            .ok_or_else(|| Error::UnsupportedSchema("nullable must be boolean".into()))?;
        let types = object
            .get_mut("type")
            .ok_or_else(|| Error::UnsupportedSchema("nullable requires type".into()))?;
        if nullable {
            match types {
                Value::String(kind) if kind != "null" => *types = json!([kind, "null"]),
                Value::Array(types) if !types.contains(&json!("null")) => types.push(json!("null")),
                _ => (),
            }
        }
    }
    for key in ["required", "enum", "type"] {
        if let Some(values) = object.get_mut(key).and_then(Value::as_array_mut) {
            let mut unique = Vec::new();
            values.retain(|value| {
                if unique.contains(value) {
                    return false;
                }
                unique.push(value.clone());
                true
            });
        }
    }
    if object
        .get("format")
        .and_then(Value::as_str)
        .is_some_and(|format| {
            ![
                "date",
                "time",
                "date-time",
                "iso-time",
                "iso-date-time",
                "duration",
                "uri",
                "uri-reference",
                "uri-template",
                "url",
                "email",
                "hostname",
                "ipv4",
                "ipv6",
                "regex",
                "uuid",
                "json-pointer",
                "json-pointer-uri-fragment",
                "relative-json-pointer",
                "byte",
                "int32",
                "int64",
                "float",
                "double",
                "password",
                "binary",
            ]
            .contains(&format)
        })
    {
        object.remove("format");
    }
    for key in [
        "properties",
        "patternProperties",
        "$defs",
        "definitions",
        "dependentSchemas",
    ] {
        if let Some(values) = object.get_mut(key).and_then(Value::as_object_mut) {
            for value in values.values_mut() {
                prepare(value, draft)?;
            }
        }
    }
    if let Some(values) = object
        .get_mut("dependencies")
        .and_then(Value::as_object_mut)
    {
        for value in values.values_mut().filter(|value| value.is_object()) {
            prepare(value, draft)?;
        }
    }
    for key in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        if let Some(values) = object.get_mut(key).and_then(Value::as_array_mut) {
            for value in values {
                prepare(value, draft)?;
            }
        }
    }
    for key in [
        "additionalProperties",
        "additionalItems",
        "unevaluatedProperties",
        "unevaluatedItems",
        "propertyNames",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "items",
    ] {
        if let Some(value) = object.get_mut(key) {
            if let Value::Array(values) = value {
                for value in values {
                    prepare(value, draft)?;
                }
                continue;
            }
            prepare(value, draft)?;
        }
    }
    if draft == Draft::Draft7
        && let Some(reference) = object.remove("$ref")
    {
        let reference = json!({"$ref":reference});
        if let Some(all) = object.get_mut("allOf").and_then(Value::as_array_mut) {
            all.insert(0, reference);
            return Ok(());
        }
        object.insert("allOf".into(), json!([reference]));
    }
    Ok(())
}

struct Pattern {
    regex: RegExp,
    pattern: String,
}
impl<'i> Keyword<'i> for Pattern {
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        if self.is_valid(instance) {
            return Ok(());
        }
        Err(ValidationError::custom(format!(
            "must match pattern \"{}\"",
            self.pattern
        )))
    }
    fn is_valid(&self, instance: &'i Value) -> bool {
        instance.as_str().is_none_or(|value| {
            self.regex
                .clone()
                .test(
                    &value.encode_utf16().collect::<Vec<_>>(),
                    &mut Budget::unlimited(),
                )
                .unwrap_or(false)
        })
    }
}

fn format_pattern(value: &str, pattern: &str, flags: &str) -> bool {
    RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), flags)
        .and_then(|mut regex| {
            regex.test(
                &value.encode_utf16().collect::<Vec<_>>(),
                &mut Budget::unlimited(),
            )
        })
        .unwrap_or(false)
}

pub(crate) fn validate(validator: &Validator, value: &Value) -> Result<(), Error> {
    let errors = validator
        .iter_errors(value)
        .flat_map(|error| messages(&error))
        .collect::<Vec<_>>();
    if errors.is_empty() {
        return Ok(());
    }
    Err(Error::Rpc {
        code: -32602,
        message: format!(
            "Structured content does not match the tool's output schema: {}",
            errors.join(", ")
        ),
    })
}

fn messages(error: &ValidationError<'_>) -> Vec<String> {
    let mut errors = Vec::new();
    let message = match error.kind() {
        ValidationErrorKind::AdditionalProperties { unexpected } => {
            return unexpected
                .iter()
                .map(|_| {
                    format!(
                        "data{} must NOT have additional properties",
                        error.instance_path()
                    )
                })
                .collect();
        }
        ValidationErrorKind::AnyOf { context } | ValidationErrorKind::OneOfNotValid { context } => {
            errors.extend(context.iter().flatten().flat_map(messages));
            if matches!(error.kind(), ValidationErrorKind::AnyOf { .. }) {
                "must match a schema in anyOf".into()
            } else {
                "must match exactly one schema in oneOf".into()
            }
        }
        ValidationErrorKind::OneOfMultipleValid { .. } => {
            "must match exactly one schema in oneOf".into()
        }
        ValidationErrorKind::Constant { .. } => "must be equal to constant".into(),
        ValidationErrorKind::Enum { .. } => "must be equal to one of the allowed values".into(),
        ValidationErrorKind::Required { property } => format!(
            "must have required property '{}'",
            property.as_str().unwrap_or_default()
        ),
        ValidationErrorKind::Type {
            kind: TypeKind::Single(kind),
        } => format!("must be {kind}"),
        ValidationErrorKind::Type {
            kind: TypeKind::Multiple(kinds),
        } => format!(
            "must be {}",
            kinds
                .iter()
                .map(|kind| kind.to_string())
                .collect::<Vec<_>>()
                .join(",")
        ),
        ValidationErrorKind::Minimum { limit } => format!("must be >= {limit}"),
        ValidationErrorKind::Maximum { limit } => format!("must be <= {limit}"),
        ValidationErrorKind::ExclusiveMinimum { limit } => format!("must be > {limit}"),
        ValidationErrorKind::ExclusiveMaximum { limit } => format!("must be < {limit}"),
        ValidationErrorKind::MultipleOf { multiple_of } => {
            format!("must be multiple of {multiple_of}")
        }
        ValidationErrorKind::MinLength { limit } => {
            format!("must NOT have fewer than {limit} characters")
        }
        ValidationErrorKind::MaxLength { limit } => {
            format!("must NOT have more than {limit} characters")
        }
        ValidationErrorKind::MinItems { limit } => {
            format!("must NOT have fewer than {limit} items")
        }
        ValidationErrorKind::MaxItems { limit } => format!("must NOT have more than {limit} items"),
        ValidationErrorKind::MinProperties { limit } => {
            format!("must NOT have fewer than {limit} properties")
        }
        ValidationErrorKind::MaxProperties { limit } => {
            format!("must NOT have more than {limit} properties")
        }
        ValidationErrorKind::Pattern { pattern } => format!("must match pattern \"{pattern}\""),
        ValidationErrorKind::Format { format } => format!("must match format \"{format}\""),
        ValidationErrorKind::Custom { message, .. } => message.clone(),
        ValidationErrorKind::FalseSchema => "boolean schema is false".into(),
        ValidationErrorKind::Not { .. } => "must NOT be valid".into(),
        ValidationErrorKind::Contains => "must contain at least 1 valid item(s)".into(),
        ValidationErrorKind::AdditionalItems { limit } => {
            format!("must NOT have more than {limit} items")
        }
        ValidationErrorKind::UnevaluatedProperties { unexpected } => {
            return unexpected
                .iter()
                .map(|_| {
                    format!(
                        "data{} must NOT have unevaluated properties",
                        error.instance_path()
                    )
                })
                .collect();
        }
        ValidationErrorKind::UnevaluatedItems { .. } => "must NOT have unevaluated items".into(),
        ValidationErrorKind::PropertyNames { error } => {
            errors.extend(messages(error));
            "property name must be valid".into()
        }
        ValidationErrorKind::UniqueItems => "must NOT have duplicate items".into(),
        _ => error.masked().to_string(),
    };
    errors.push(format!("data{} {message}", error.instance_path()));
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_reuses_compiled_validators_and_replaces_changed_schemas() {
        let schema =
            json!({"type":"object","properties":{"value":{"type":"array","items":{"enum":[1,2]}}}});
        let first = cached(&schema, None);
        let next = cached(&schema, Some(&first));
        assert!(Arc::ptr_eq(
            first.validator.as_ref().unwrap(),
            next.validator.as_ref().unwrap()
        ));
        let changed = cached(
            &json!({"type":"object","properties":{"value":{"type":"integer"}}}),
            Some(&next),
        );
        assert!(!Arc::ptr_eq(
            first.validator.as_ref().unwrap(),
            changed.validator.as_ref().unwrap()
        ));
        let broken = cached(&json!({"$ref":"#/$defs/missing"}), None);
        assert!(broken.validator.is_none());
        assert!(cached(&broken.schema, Some(&broken)).validator.is_none());
    }

    #[test]
    fn errors_include_ajv_instance_paths_and_all_failures_without_coercion() {
        let validator = compile(&json!({"type":"object","properties":{"a":{"type":"integer"},"b":{"type":"string"}},"required":["a","b"]})).unwrap();
        assert_eq!(validate(&validator, &json!({"a":"1","b":1})), Err(Error::Rpc { code:-32602, message:"Structured content does not match the tool's output schema: data/a must be integer, data/b must be string".into() }));
    }

    #[test]
    fn lossless_domain_strings_are_not_replaced_at_the_scalar_only_mcp_boundary() {
        let raw = r#"{"value":"\ud800"}"#;
        let value = ycoding_schema::parse_json(raw).unwrap();
        assert_eq!(ycoding_schema::stringify_json(&value), raw);
        assert!(serde_json::from_str::<Value>(raw).is_err());
        assert!(
            serde_json::from_str::<Value>(r#"{"properties":{"\ud800":{"const":"\udfff"}}}"#)
                .is_err()
        );
        let paired: Value = serde_json::from_str(r#"{"value":"\ud83d\udca1"}"#).unwrap();
        let validator =
            compile(&json!({"properties":{"value":{"type":"string","minLength":1,"maxLength":1}}}))
                .unwrap();
        assert!(validate(&validator, &paired).is_ok());
        assert!(validate(&validator, &json!({"value":"💡💡"})).is_err());
    }
}
