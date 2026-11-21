use ycoding_schema::JsonValue;

pub(super) fn field<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a JsonValue> {
    path.iter().try_fold(value, |value, name| match value {
        JsonValue::Object(object) => object.get(&(*name).into()),
        _ => None,
    })
}

pub(super) fn text(value: &JsonValue) -> Option<&ycoding_schema::LosslessString> {
    match value {
        JsonValue::String(value) => Some(value),
        _ => None,
    }
}

pub(super) fn number(value: &JsonValue) -> Option<f64> {
    match value {
        JsonValue::Number(value) => Some(*value),
        _ => None,
    }
}
