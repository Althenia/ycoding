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
pub(crate) fn active(field: &form::Field, answer: &form::Answer) -> bool {
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
        let invalid = match field {
            form::Field::Number(field)
                if field
                    .minimum
                    .zip(field.maximum)
                    .is_some_and(|(min, max)| min > max) =>
            {
                Some("Form field has no value within its bounds")
            }
            form::Field::Integer(field)
                if field
                    .minimum
                    .zip(field.maximum)
                    .is_some_and(|(min, max)| min.ceil() > max.floor()) =>
            {
                Some("Form field has no value within its bounds")
            }
            form::Field::String(field) => {
                let min = field
                    .min_length
                    .map_or(0, |min| min.get())
                    .max(if base.required == Some(true) { 1 } else { 0 });
                if field.max_length.is_some_and(|max| min > max.get()) {
                    Some("Form field has contradictory length bounds")
                } else if field.pattern.as_ref().is_some_and(|pattern| {
                    RegExp::new(&pattern.code_units().collect::<Vec<_>>(), "").is_err()
                }) {
                    Some("Form field has invalid pattern")
                } else {
                    None
                }
            }
            form::Field::Multiselect(field) => {
                let min = field
                    .min_items
                    .map_or(0, |min| min.get())
                    .max(if base.required == Some(true) { 1 } else { 0 });
                field
                    .max_items
                    .is_some_and(|max| min > max.get())
                    .then_some("Form field has contradictory selection bounds")
            }
            _ => None,
        };
        if let Some(invalid) = invalid {
            return Err(field_error(invalid, &base.key));
        }
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
                && field.options.as_ref().is_some_and(|options| {
                    !options.is_empty() && !options.iter().any(|option| &option.value == value)
                })
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
                && !field.options.is_empty()
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
    let question = question_form(form);
    let mut answer = form::Answer(JsonObject::new());
    for field in &form.fields.0 {
        if matches!(field, form::Field::External(_)) {
            answer.0.insert(key(field).clone(), JsonValue::Bool(true));
            continue;
        }
        if !active(field, &answer) {
            continue;
        }
        let Some(value) = automatic_value(field) else {
            if required(field) || question {
                return None;
            }
            continue;
        };
        answer.0.insert(key(field).clone(), value);
    }
    validate_answer(form, &answer).ok().map(|_| answer)
}

pub fn rule_values(form: &form::Info) -> BTreeMap<usize, JsonValue> {
    form.fields
        .0
        .iter()
        .enumerate()
        .filter_map(|(index, field)| automatic_value(field).map(|value| (index, value)))
        .collect()
}

pub(super) fn fallback_answer(form: &form::Info) -> Option<form::Answer> {
    let mut answer = form::Answer(JsonObject::new());
    for field in &form.fields.0 {
        if !active(field, &answer) {
            continue;
        }
        answer.0.insert(key(field).clone(), fallback_value(field)?);
    }
    validate_answer(form, &answer).ok().map(|_| answer)
}

pub(super) fn fallback_value(field: &form::Field) -> Option<JsonValue> {
    let valid = |value: &JsonValue| validate_field(field, value).is_ok();
    let options = match field {
        form::Field::String(field) => field.options.as_deref().unwrap_or_default(),
        form::Field::Multiselect(field) => &field.options,
        _ => &[],
    };
    let marked = options
        .iter()
        .filter(|option| crate::tools::policy::recommended(&option.label))
        .map(|option| option.value.clone())
        .collect::<Vec<_>>();
    let default = match field {
        form::Field::String(field) => field.default.as_ref().map(DomainEncode::encode),
        form::Field::Multiselect(field) => field.default.as_ref().map(DomainEncode::encode),
        form::Field::Boolean(field) => field.default.map(JsonValue::Bool),
        form::Field::Number(field) => field.default.map(JsonValue::Number),
        form::Field::Integer(field) => field.default.map(JsonValue::Number),
        form::Field::External(_) => return None,
    };
    if let form::Field::Multiselect(field) = field {
        let count = field.min_items.map_or(1, |min| (min.get() as usize).max(1));
        if marked.is_empty()
            && let Some(default) = &default
            && valid(default)
        {
            return Some(default.clone());
        }
        let mut choices = marked.clone();
        for option in options {
            if !choices.contains(&option.value) {
                choices.push(option.value.clone());
            }
        }
        if field.custom == Some(true) {
            if count > 8192 {
                return None;
            }
            while choices.len() < count {
                choices.push(if choices.is_empty() {
                    super::super::PROGRESSION.into()
                } else {
                    format!("Bounded step {}", choices.len() + 1).into()
                });
            }
        }
        choices.truncate(
            count
                .max(marked.len())
                .min(field.max_items.map_or(usize::MAX, |max| max.get() as usize)),
        );
        let value = choices.encode();
        return valid(&value)
            .then_some(value)
            .or_else(|| default.filter(valid));
    }
    if let Some(value) = marked.first().map(DomainEncode::encode).filter(valid) {
        return Some(value);
    }
    if let Some(value) = default.filter(valid) {
        return Some(value);
    }
    let number = match field {
        form::Field::Boolean(_) => return Some(JsonValue::Bool(true)),
        form::Field::Number(field) => Some(
            field
                .minimum
                .unwrap_or_else(|| field.maximum.unwrap_or(0.0).min(0.0)),
        ),
        form::Field::Integer(field) => Some(
            field
                .minimum
                .map_or_else(|| field.maximum.unwrap_or(0.0).floor().min(0.0), f64::ceil),
        ),
        _ => None,
    };
    if let Some(number) = number {
        let value = JsonValue::Number(number);
        return valid(&value).then_some(value);
    }
    if let Some(option) = options.iter().find(|option| valid(&option.value.encode())) {
        return Some(option.value.encode());
    }
    let form::Field::String(field) = field else {
        return None;
    };
    if field.min_length.is_some_and(|min| min.get() > 8192) {
        return None;
    }
    let format = field.format.map(|format| match format {
        form::StringFormat::Email => "progress@example.invalid",
        form::StringFormat::Uri => "https://example.invalid/next-step",
        form::StringFormat::Date => "2000-01-01",
        form::StringFormat::DateTime => "2000-01-01T00:00:00.000Z",
    });
    let pattern = field
        .pattern
        .as_ref()
        .and_then(|pattern| pattern.to_utf8().ok())
        .map(|pattern| pattern_text(&pattern));
    for candidate in [
        field.placeholder.clone(),
        format.map(Into::into),
        pattern.map(Into::into),
        Some(super::super::PROGRESSION.into()),
        Some("Continue".into()),
        Some("a".into()),
        Some("0".into()),
        Some("".into()),
    ]
    .into_iter()
    .flatten()
    {
        let mut units = candidate.code_units().collect::<Vec<_>>();
        units.resize(
            units
                .len()
                .max(field.min_length.map_or(0, |min| min.get() as usize)),
            b'a' as u16,
        );
        if let Some(max) = field.max_length {
            units.truncate(max.get() as usize);
        }
        let value = LosslessString::from_utf16(units).encode();
        if valid(&value) {
            return Some(value);
        }
    }
    None
}

fn pattern_text(pattern: &str) -> String {
    fn sequence(chars: &[char], offset: &mut usize, groups: &mut Vec<String>) -> String {
        let mut result = String::new();
        let mut alternative = None;
        while *offset < chars.len() && chars[*offset] != ')' {
            let token = chars[*offset];
            *offset += 1;
            if token == '|' {
                if alternative.is_none() {
                    alternative = Some(result.clone());
                }
                result.clear();
                continue;
            }
            if matches!(token, '^' | '$') {
                continue;
            }
            let atom = match token {
                '(' => {
                    let modifier = chars.get(*offset..*offset + 2);
                    let assertion = matches!(modifier, Some(['?', '='] | ['?', '!']));
                    let noncapturing = modifier == Some(&['?', ':']);
                    if assertion || noncapturing {
                        *offset += 2;
                    }
                    let nested = sequence(chars, offset, groups);
                    if chars.get(*offset) == Some(&')') {
                        *offset += 1;
                    }
                    if !assertion && !noncapturing {
                        groups.push(nested.clone());
                    }
                    if assertion { String::new() } else { nested }
                }
                '[' => {
                    let start = *offset - 1;
                    while *offset < chars.len() {
                        let token = chars[*offset];
                        *offset += 1;
                        if token == '\\' {
                            *offset = (*offset + 1).min(chars.len());
                        } else if token == ']' {
                            break;
                        }
                    }
                    let pattern = chars[start..*offset].iter().collect::<String>();
                    let mut expression =
                        RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "").ok();
                    let mut accepts = |candidate: char| {
                        expression.as_mut().is_some_and(|expression| {
                            expression
                                .test(
                                    &candidate.to_string().encode_utf16().collect::<Vec<_>>(),
                                    &mut Budget::unlimited(),
                                )
                                .unwrap_or(false)
                        })
                    };
                    "aA01_- .@/:"
                        .chars()
                        .find(|candidate| accepts(*candidate))
                        .or_else(|| {
                            (32..65536)
                                .filter_map(char::from_u32)
                                .find(|candidate| accepts(*candidate))
                        })
                        .map_or_else(String::new, |candidate| candidate.to_string())
                }
                '\\' => {
                    let escaped = chars.get(*offset).copied().unwrap_or_default();
                    *offset = (*offset + 1).min(chars.len());
                    match escaped {
                        'd' => "0".into(),
                        'w' | 'D' | 'S' => "a".into(),
                        's' => " ".into(),
                        'W' => "-".into(),
                        'b' | 'B' => String::new(),
                        'n' => "\n".into(),
                        't' => "\t".into(),
                        '1'..='9' => groups
                            .get(escaped as usize - '1' as usize)
                            .cloned()
                            .unwrap_or_default(),
                        other => other.to_string(),
                    }
                }
                '.' => "a".into(),
                other => other.to_string(),
            };
            let count = match chars.get(*offset).copied() {
                Some('*' | '?') => {
                    *offset += 1;
                    0
                }
                Some('+') => {
                    *offset += 1;
                    1
                }
                Some('{') => {
                    let start = *offset;
                    let mut end = start + 1;
                    while chars.get(end).is_some_and(char::is_ascii_digit) {
                        end += 1;
                    }
                    let minimum = chars[start + 1..end]
                        .iter()
                        .collect::<String>()
                        .parse::<usize>()
                        .ok();
                    if chars.get(end) == Some(&',') {
                        end += 1;
                        while chars.get(end).is_some_and(char::is_ascii_digit) {
                            end += 1;
                        }
                    }
                    if let Some(minimum) = minimum
                        && chars.get(end) == Some(&'}')
                    {
                        *offset = end + 1;
                        minimum.min(8192)
                    } else {
                        1
                    }
                }
                _ => 1,
            };
            if chars.get(*offset) == Some(&'?') {
                *offset += 1;
            }
            let width = atom.encode_utf16().count();
            let remaining = 8192usize.saturating_sub(result.encode_utf16().count());
            result.push_str(
                &atom.repeat(
                    remaining
                        .checked_div(width)
                        .map_or(0, |limit| count.min(limit)),
                ),
            );
        }
        alternative.unwrap_or(result)
    }
    sequence(
        &pattern.chars().collect::<Vec<_>>(),
        &mut 0,
        &mut Vec::new(),
    )
}

pub fn field_key(field: &form::Field) -> &LosslessString {
    key(field)
}

pub fn question_form(form: &form::Info) -> bool {
    form.metadata.as_ref().is_some_and(|metadata| {
        metadata.get(&"kind".into()) == Some(&JsonValue::String("question".into()))
    })
}

pub fn must_answer(form: &form::Info, field: &form::Field) -> bool {
    required(field) || question_form(form)
}

fn automatic_value(field: &form::Field) -> Option<JsonValue> {
    let marked = |options: &[form::Option]| {
        options
            .iter()
            .filter(|option| crate::tools::policy::recommended(&option.label))
            .map(|option| option.value.encode())
            .collect::<Vec<_>>()
    };
    let candidate = match field {
        form::Field::Boolean(field) => JsonValue::Bool(field.default?),
        form::Field::Number(field) => JsonValue::Number(field.default?),
        form::Field::Integer(field) => JsonValue::Number(field.default?),
        form::Field::Multiselect(field) => match &field.default {
            Some(default) => default.encode(),
            None => {
                let marked = marked(&field.options);
                if marked.len() != 1 {
                    return None;
                }
                JsonValue::Array(marked)
            }
        },
        form::Field::String(field) => match &field.default {
            Some(default) => default.encode(),
            None => match marked(field.options.as_deref().unwrap_or_default()).as_slice() {
                [only] => only.clone(),
                _ => return None,
            },
        },
        form::Field::External(_) => return Some(JsonValue::Bool(true)),
    };
    validate_field(field, &candidate).ok().map(|_| candidate)
}
