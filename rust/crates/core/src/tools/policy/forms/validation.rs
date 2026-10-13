mod formats;
use crate::regexp::{Budget, RegExp};
use std::collections::{BTreeMap, BTreeSet};
use ycoding_schema::{DomainEncode, JsonObject, JsonValue, LosslessString, form};

fn base(field: &form::Field) -> Option<&form::Base> {
    match field {
        form::Field::String(field) => Some(&field.base),
        form::Field::Number(field) => Some(&field.base),
        form::Field::Integer(field) => Some(&field.base),
        form::Field::Boolean(field) => Some(&field.base),
        form::Field::Multiselect(field) => Some(&field.base),
        form::Field::External(_) => None,
    }
}
fn key(field: &form::Field) -> &LosslessString {
    match field {
        form::Field::External(field) => &field.key,
        _ => &base(field).expect("input field").key,
    }
}
fn field_error(message: &str, key: &LosslessString) -> LosslessString {
    LosslessString::from_utf16(
        message
            .encode_utf16()
            .chain(": ".encode_utf16())
            .chain(key.code_units())
            .collect(),
    )
}
fn condition_error(message: &str, key: &LosslessString, target: &LosslessString) -> LosslessString {
    LosslessString::from_utf16(
        field_error(message, key)
            .code_units()
            .chain(" -> ".encode_utf16())
            .chain(target.code_units())
            .collect(),
    )
}
fn required(field: &form::Field) -> bool {
    base(field).is_some_and(|base| base.required == Some(true))
}
fn active(field: &form::Field, answer: &form::Answer) -> bool {
    base(field)
        .and_then(|base| base.when.as_ref())
        .is_none_or(|conditions| {
            conditions.iter().all(|condition| {
                let Some(value) = answer.0.get(&condition.key) else {
                    return false;
                };
                let expected = condition.value.encode();
                let hit = if let JsonValue::Array(values) = value {
                    values.iter().any(|value| value == &expected)
                } else {
                    value == &expected
                };
                if condition.op == form::WhenOp::Eq {
                    hit
                } else {
                    !hit
                }
            })
        })
}

pub fn validate_fields(fields: &[form::Field]) -> Result<(), LosslessString> {
    if fields.is_empty() {
        return Err("Form must have at least one field".into());
    }
    let mut keys = BTreeSet::new();
    let mut earlier: BTreeMap<LosslessString, &form::Field> = BTreeMap::new();
    for field in fields {
        if !keys.insert(key(field)) {
            return Err(field_error("Duplicate form field key", key(field)));
        }
        let Some(base) = base(field) else {
            continue;
        };
        for condition in base.when.as_ref().into_iter().flatten() {
            let Some(target) = earlier.get(&condition.key) else {
                return Err(condition_error(
                    "Form field condition must reference an earlier field",
                    &base.key,
                    &condition.key,
                ));
            };
            let error = match (target, &condition.value) {
                (form::Field::Boolean(_), form::WhenValue::Boolean(_))
                | (form::Field::Number(_) | form::Field::Integer(_), form::WhenValue::Number(_)) => {
                    None
                }
                (form::Field::Boolean(_), _) => {
                    Some("Form field condition value must be a boolean")
                }
                (form::Field::Number(_) | form::Field::Integer(_), _) => {
                    Some("Form field condition value must be a number")
                }
                (form::Field::String(field), form::WhenValue::String(value)) => {
                    if field.custom != Some(true)
                        && field.options.as_ref().is_some_and(|options| {
                            !options.iter().any(|option| &option.value == value)
                        })
                    {
                        Some("Form field condition value must be one of the field's options")
                    } else {
                        None
                    }
                }
                (form::Field::Multiselect(field), form::WhenValue::String(value)) => {
                    if field.custom != Some(true)
                        && !field.options.iter().any(|option| &option.value == value)
                    {
                        Some("Form field condition value must be one of the field's options")
                    } else {
                        None
                    }
                }
                _ => Some("Form field condition value must be a string"),
            };
            if let Some(error) = error {
                return Err(condition_error(error, &base.key, &condition.key));
            }
        }
        earlier.insert(base.key.clone(), field);
    }
    Ok(())
}

pub fn validate_answer(form: &form::Info, answer: &form::Answer) -> Result<(), LosslessString> {
    for (key, _) in answer.0.iter() {
        if !form.fields.0.iter().any(|field| self::key(field) == key) {
            return Err(field_error("Unknown form field", key));
        }
    }
    for field in &form.fields.0 {
        let value = answer.0.get(key(field));
        if matches!(field, form::Field::External(_)) {
            if value != Some(&JsonValue::Bool(true)) {
                return Err(field_error(
                    "External form field must be acknowledged",
                    key(field),
                ));
            }
            continue;
        }
        let active = active(field, answer);
        let Some(value) = value else {
            if active && required(field) {
                return Err(field_error("Missing required form field", key(field)));
            }
            continue;
        };
        if !active {
            return Err(field_error("Form field is not active", key(field)));
        }
        validate_field(field, value)?;
    }
    Ok(())
}

pub fn validate_field(field: &form::Field, value: &JsonValue) -> Result<(), LosslessString> {
    let invalid = |message: &str| Err(field_error(message, key(field)));
    match field {
        form::Field::String(field) => {
            let JsonValue::String(value) = value else {
                return invalid("Expected string for form field");
            };
            if field.base.required == Some(true) && value.is_empty() {
                return invalid("Missing required form field");
            }
            if field
                .min_length
                .is_some_and(|min| value.len() < (min.get() as usize))
            {
                return invalid("Form field is too short");
            }
            if field
                .max_length
                .is_some_and(|max| value.len() > (max.get() as usize))
            {
                return invalid("Form field is too long");
            }
            if let Some(pattern) = &field.pattern {
                let matched = RegExp::new(&pattern.code_units().collect::<Vec<_>>(), "").and_then(
                    |mut pattern| {
                        pattern.test(
                            &value.code_units().collect::<Vec<_>>(),
                            &mut Budget::unlimited(),
                        )
                    },
                );
                match matched {
                    Ok(true) => {}
                    Ok(false) => return invalid("Form field does not match pattern"),
                    Err(_) => return invalid("Form field has invalid pattern"),
                }
            }
            if let Some(format) = field.format {
                let (valid, message) = match format {
                    form::StringFormat::Email => (
                        RegExp::new(
                            &r"^[^\s@]+@[^\s@]+\.[^\s@]+$"
                                .encode_utf16()
                                .collect::<Vec<_>>(),
                            "",
                        )
                        .expect("static email pattern")
                        .test(
                            &value.code_units().collect::<Vec<_>>(),
                            &mut Budget::unlimited(),
                        )
                        .expect("unlimited email pattern"),
                        "Expected email for form field",
                    ),
                    form::StringFormat::Uri => (formats::uri(value), "Expected URI for form field"),
                    form::StringFormat::Date => {
                        (formats::date(value), "Expected date for form field")
                    }
                    form::StringFormat::DateTime => (
                        formats::date_time(value),
                        "Expected date-time for form field",
                    ),
                };
                if !valid {
                    return invalid(message);
                }
            }
            if field.custom != Some(true)
                && field
                    .options
                    .as_ref()
                    .is_some_and(|options| !options.iter().any(|option| &option.value == value))
            {
                return invalid("Invalid option for form field");
            }
        }
        form::Field::Number(field) => number(field.minimum, field.maximum, false, value)
            .map_err(|message| field_error(message, &field.base.key))?,
        form::Field::Integer(field) => number(field.minimum, field.maximum, true, value)
            .map_err(|message| field_error(message, &field.base.key))?,
        form::Field::Boolean(_) => {
            if !matches!(value, JsonValue::Bool(_)) {
                return invalid("Expected boolean for form field");
            }
        }
        form::Field::Multiselect(field) => {
            let JsonValue::Array(values) = value else {
                return invalid("Expected string array for form field");
            };
            if !values
                .iter()
                .all(|value| matches!(value, JsonValue::String(_)))
            {
                return invalid("Expected string array for form field");
            }
            if field.base.required == Some(true) && values.is_empty() {
                return invalid("Missing required form field");
            }
            if field
                .min_items
                .is_some_and(|min| values.len() < (min.get() as usize))
            {
                return invalid("Too few selections for form field");
            }
            if field
                .max_items
                .is_some_and(|max| values.len() > (max.get() as usize))
            {
                return invalid("Too many selections for form field");
            }
            if field.custom != Some(true)
                && values.iter().any(|value| {
                    !field
                        .options
                        .iter()
                        .any(|option| value == &JsonValue::String(option.value.clone()))
                })
            {
                return invalid("Invalid option for form field");
            }
        }
        form::Field::External(_) => {}
    }
    Ok(())
}

fn number(
    minimum: Option<f64>,
    maximum: Option<f64>,
    integer: bool,
    value: &JsonValue,
) -> Result<(), &'static str> {
    let JsonValue::Number(value) = value else {
        return Err("Expected number for form field");
    };
    if !value.is_finite() {
        return Err("Expected number for form field");
    }
    if integer && value.fract() != 0.0 {
        return Err("Expected integer for form field");
    }
    if minimum.is_some_and(|minimum| *value < minimum) {
        return Err("Form field is too small");
    }
    if maximum.is_some_and(|maximum| *value > maximum) {
        return Err("Form field is too large");
    }
    Ok(())
}

pub fn automatic_answer(form: &form::Info) -> Option<form::Answer> {
    let mut answer = form::Answer(JsonObject::new());
    for field in &form.fields.0 {
        if matches!(field, form::Field::External(_)) {
            answer.0.insert(key(field).clone(), JsonValue::Bool(true));
            continue;
        }
        if !active(field, &answer) {
            continue;
        }
        let value = automatic_value(field);
        let Some(value) = value else {
            if required(field) {
                return None;
            }
            continue;
        };
        answer.0.insert(key(field).clone(), value);
    }
    validate_answer(form, &answer).ok().map(|_| answer)
}

fn automatic_value(field: &form::Field) -> Option<JsonValue> {
    let candidate = match field {
        form::Field::Boolean(field) => JsonValue::Bool(field.default.unwrap_or(false)),
        form::Field::Number(field) => JsonValue::Number(field.default.unwrap_or_else(|| {
            field
                .minimum
                .unwrap_or_else(|| field.maximum.filter(|max| *max < 0.0).unwrap_or(0.0))
        })),
        form::Field::Integer(field) => JsonValue::Number(field.default.unwrap_or_else(|| {
            field
                .minimum
                .unwrap_or_else(|| field.maximum.filter(|max| *max < 0.0).unwrap_or(0.0))
                .ceil()
        })),
        form::Field::Multiselect(field) => {
            if let Some(default) = &field.default {
                return validate_field(&form::Field::Multiselect(field.clone()), &default.encode())
                    .ok()
                    .map(|_| default.encode());
            }
            if field.base.required != Some(true) && field.min_items.map_or(0, |min| min.get()) == 0
            {
                return None;
            }
            JsonValue::Array(
                field
                    .options
                    .iter()
                    .take(field.min_items.map_or(1, |min| min.get()).max(1) as usize)
                    .map(|option| option.value.encode())
                    .collect(),
            )
        }
        form::Field::String(field) => {
            if let Some(default) = &field.default {
                return validate_field(&form::Field::String(field.clone()), &default.encode())
                    .ok()
                    .map(|_| default.encode());
            }
            if let Some(option) = field.options.as_ref().and_then(|options| options.first()) {
                return validate_field(&form::Field::String(field.clone()), &option.value.encode())
                    .ok()
                    .map(|_| option.value.encode());
            }
            if field.base.required != Some(true) {
                return None;
            }
            let fallback = match field.format {
                Some(form::StringFormat::Email) => "user@example.com",
                Some(form::StringFormat::Uri) => "https://example.com",
                Some(form::StringFormat::Date) => "1970-01-01",
                Some(form::StringFormat::DateTime) => "1970-01-01T00:00:00.000Z",
                _ => "Continue",
            };
            for candidate in field.placeholder.iter().cloned().chain([fallback.into()]) {
                let mut units = candidate.code_units().collect::<Vec<_>>();
                units.resize(
                    units
                        .len()
                        .max(field.min_length.map_or(0, |min| min.get() as usize)),
                    120,
                );
                units.truncate(
                    field
                        .max_length
                        .map_or(usize::MAX, |max| max.get() as usize),
                );
                let value = JsonValue::String(LosslessString::from_utf16(units));
                if validate_field(&form::Field::String(field.clone()), &value).is_ok() {
                    return Some(value);
                }
            }
            return None;
        }
        form::Field::External(_) => return Some(JsonValue::Bool(true)),
    };
    validate_field(field, &candidate).ok().map(|_| candidate)
}
