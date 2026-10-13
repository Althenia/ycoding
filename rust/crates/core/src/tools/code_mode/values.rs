use super::program::{Function, Position, blocked};
use super::{Diagnostic, DiagnosticKind};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::task::Waker;
use ycoding_schema::{JsonObject, JsonValue, LosslessString, stringify_json};

#[derive(Clone, Debug)]
pub(crate) enum Value {
    Undefined,
    Null,
    Boolean(bool),
    Number(f64),
    String(LosslessString),
    Object(usize),
    Array(usize),
    Function(usize),
    Promise(usize),
    Map(usize),
    Set(usize),
    Date(usize),
    Url(usize),
    Params(usize),
    RegExp(usize),
    Namespace(String),
    Tool(Vec<LosslessString>),
    Intrinsic(Box<Value>, String),
    Resolver(usize, bool),
    ShortCircuit,
}

#[derive(Clone, Debug)]
pub(crate) struct Fault {
    pub kind: DiagnosticKind,
    pub message: String,
    pub name: String,
    pub location: Position,
    pub thrown: Option<Value>,
    pub fatal: bool,
}

impl Fault {
    pub fn error(name: &str, message: impl Into<String>, location: &Position) -> Self {
        Self {
            kind: DiagnosticKind::ExecutionFailure,
            message: message.into(),
            name: name.into(),
            location: location.clone(),
            thrown: None,
            fatal: false,
        }
    }
    pub fn data(message: impl Into<String>) -> Self {
        Self {
            kind: DiagnosticKind::InvalidDataValue,
            message: message.into(),
            name: "Error".into(),
            location: Position {
                index: 0,
                line: 1,
                column: 0,
            },
            thrown: None,
            fatal: false,
        }
    }
    pub fn data_at(message: impl Into<String>, location: &Position) -> Self {
        Self {
            location: location.clone(),
            ..Self::data(message)
        }
    }
    pub fn diagnostic(&self) -> Diagnostic {
        Diagnostic {
            kind: self.kind.clone(),
            message: self.message.clone(),
            location: self.location.clone(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Closure {
    pub function: Arc<Function>,
    pub scopes: Vec<usize>,
}

#[derive(Clone)]
pub(crate) enum Heap {
    Object {
        fields: Vec<(LosslessString, Value)>,
        brand: Option<String>,
    },
    Array {
        length: u32,
        items: BTreeMap<u32, Value>,
        fields: Vec<(LosslessString, Value)>,
    },
    Function(Closure),
    Map(Vec<(Value, Value)>),
    Set {
        items: Vec<(usize, Value)>,
        next: usize,
    },
    Date(f64),
    Url {
        url: url::Url,
        params: usize,
    },
    Params {
        entries: Vec<(LosslessString, LosslessString)>,
        owner: Option<usize>,
    },
    RegExp {
        pattern: crate::regexp::RegExp,
        last_index: Value,
    },
}

#[derive(Clone)]
pub(crate) struct Binding {
    pub value: Value,
    pub initialized: bool,
    pub mutable: bool,
}

#[derive(Default)]
pub(crate) struct Promise {
    pub result: Option<Result<Value, Fault>>,
    pub waiters: Vec<Waker>,
    pub observed: bool,
    pub settled_order: Option<usize>,
    pub resolved: bool,
}

#[derive(Default)]
pub(crate) struct State {
    pub heap: Vec<Heap>,
    pub scopes: Vec<HashMap<String, Binding>>,
    pub promises: Vec<Promise>,
    pub settlement: usize,
    pub calls: Vec<LosslessString>,
    pub logs: Vec<LosslessString>,
    pub random: u64,
}

impl State {
    pub fn allocate(&mut self, heap: Heap) -> usize {
        let id = self.heap.len();
        self.heap.push(heap);
        id
    }
    pub fn array(&mut self, values: Vec<Value>) -> Value {
        let length = values.len() as u32;
        Value::Array(
            self.allocate(Heap::Array {
                length,
                items: values
                    .into_iter()
                    .enumerate()
                    .map(|(index, value)| (index as u32, value))
                    .collect(),
                fields: Vec::new(),
            }),
        )
    }
    pub fn object(&mut self, fields: Vec<(LosslessString, Value)>) -> Value {
        Value::Object(self.allocate(Heap::Object {
            fields,
            brand: None,
        }))
    }
    pub fn error(&mut self, name: &str, message: &str, errors: Option<Vec<Value>>) -> Value {
        let mut fields = vec![
            ("name".into(), Value::String(name.into())),
            ("message".into(), Value::String(message.into())),
        ];
        if let Some(errors) = errors {
            fields.push(("errors".into(), self.array(errors)));
        }
        Value::Object(self.allocate(Heap::Object {
            fields,
            brand: Some(name.into()),
        }))
    }
    pub fn caught(&mut self, fault: &Fault) -> Value {
        fault
            .thrown
            .clone()
            .unwrap_or_else(|| self.error(&fault.name, &fault.message, None))
    }
    pub fn decode_json(&mut self, value: JsonValue) -> Value {
        match value {
            JsonValue::Null => Value::Null,
            JsonValue::Bool(value) => Value::Boolean(value),
            JsonValue::Number(value) => Value::Number(value),
            JsonValue::String(value) => Value::String(value),
            JsonValue::Array(items) => {
                let items = items
                    .into_iter()
                    .map(|value| self.decode_json(value))
                    .collect();
                self.array(items)
            }
            JsonValue::Object(object) => {
                let fields = object
                    .iter()
                    .map(|(key, value)| (key.clone(), self.decode_json(value.clone())))
                    .collect();
                self.object(fields)
            }
        }
    }
    pub fn json(&self, value: &Value, json_mode: bool) -> Result<Option<JsonValue>, Fault> {
        self.copy_json(value, json_mode, 0, &mut Vec::new())
    }
    fn copy_json(
        &self,
        value: &Value,
        json_mode: bool,
        depth: usize,
        seen: &mut Vec<usize>,
    ) -> Result<Option<JsonValue>, Fault> {
        if depth > 32 {
            return Err(Fault::data(
                "Execution result exceeds the maximum value depth of 32.",
            ));
        }
        Ok(Some(match value {
            Value::Undefined | Value::ShortCircuit => {
                return Ok(if json_mode {
                    None
                } else {
                    Some(JsonValue::Null)
                });
            }
            Value::Null => JsonValue::Null,
            Value::Boolean(value) => JsonValue::Bool(*value),
            Value::Number(value) => {
                if value.is_finite() {
                    JsonValue::Number(*value)
                } else {
                    JsonValue::Null
                }
            }
            Value::String(value) => JsonValue::String(value.clone()),
            Value::Array(id) | Value::Object(id) => {
                if seen.contains(id) {
                    return Err(Fault::data("Execution result contains a circular value."));
                }
                seen.push(*id);
                let value = match &self.heap[*id] {
                    Heap::Array { length, items, .. } => JsonValue::Array(
                        (0..*length)
                            .map(|index| {
                                self.copy_json(
                                    items.get(&index).unwrap_or(&Value::Undefined),
                                    json_mode,
                                    depth + 1,
                                    seen,
                                )
                                .map(|value| value.unwrap_or(JsonValue::Null))
                            })
                            .collect::<Result<_, _>>()?,
                    ),
                    Heap::Object { fields, .. } => {
                        let mut object = JsonObject::new();
                        for (key, value) in fields {
                            if blocked(key) {
                                return Err(Fault::data(format!(
                                    "Property '{}' is not available in CodeMode.",
                                    key.as_str().unwrap_or_default()
                                )));
                            }
                            if let Some(value) =
                                self.copy_json(value, json_mode, depth + 1, seen)?
                            {
                                object.insert(key.clone(), value);
                            }
                        }
                        JsonValue::Object(object)
                    }
                    _ => return Err(Fault::data("Execution result must contain data only.")),
                };
                seen.pop();
                value
            }
            Value::Date(id) => {
                let Heap::Date(time) = self.heap[*id] else {
                    return Err(Fault::data("Invalid Date value."));
                };
                match super::stdlib::date::iso(time) {
                    Some(value) => JsonValue::String(value.into()),
                    None => JsonValue::Null,
                }
            }
            Value::Url(id) => {
                let Heap::Url { url, .. } = &self.heap[*id] else {
                    return Err(Fault::data("Invalid URL value."));
                };
                JsonValue::String(url.as_str().into())
            }
            Value::Map(_) | Value::Set(_) | Value::Params(_) | Value::RegExp(_) => {
                JsonValue::Object(JsonObject::new())
            }
            Value::Promise(_) => {
                return Err(Fault::data(
                    "Execution result contains an un-awaited Promise; await it first - e.g. `const result = await tools.ns.tool(...)`.",
                ));
            }
            Value::Function(_)
            | Value::Tool(_)
            | Value::Intrinsic(_, _)
            | Value::Namespace(_)
            | Value::Resolver(_, _) => {
                return Err(Fault::data("Execution result must contain data only."));
            }
        }))
    }
    pub fn text(&self, value: &Value) -> Result<LosslessString, Fault> {
        match value {
            Value::String(value) => Ok(value.clone()),
            Value::Undefined | Value::ShortCircuit => Ok("undefined".into()),
            Value::Null => Ok("null".into()),
            Value::Boolean(value) => Ok(value.to_string().into()),
            Value::Number(value) => Ok(number_string(*value).into()),
            Value::Array(id) => {
                let Heap::Array { length, items, .. } = &self.heap[*id] else {
                    return Err(Fault::data("Invalid array."));
                };
                let mut units = Vec::new();
                for index in 0..*length {
                    if index > 0 {
                        units.push(b',' as u16);
                    }
                    if let Some(value) = items.get(&index)
                        && !matches!(value, Value::Null | Value::Undefined)
                    {
                        units.extend(self.text(value)?.code_units());
                    }
                }
                Ok(LosslessString::from_utf16(units))
            }
            Value::Object(id) => {
                if let Heap::Object {
                    fields,
                    brand: Some(_),
                } = &self.heap[*id]
                {
                    let name =
                        field(fields, &"name".into()).unwrap_or(Value::String("Error".into()));
                    let message =
                        field(fields, &"message".into()).unwrap_or(Value::String("".into()));
                    let name = self.text(&name)?;
                    let message = self.text(&message)?;
                    if message.is_empty() {
                        return Ok(name);
                    }
                    if name.is_empty() {
                        return Ok(message);
                    }
                    return Ok(concat(&[name, ": ".into(), message]));
                }
                Ok("[object Object]".into())
            }
            Value::Date(id) => {
                let Heap::Date(time) = self.heap[*id] else {
                    return Err(Fault::data("Invalid Date."));
                };
                Ok(super::stdlib::date::iso(time)
                    .unwrap_or_else(|| "Invalid Date".into())
                    .into())
            }
            Value::Url(id) => {
                let Heap::Url { url, .. } = &self.heap[*id] else {
                    return Err(Fault::data("Invalid URL."));
                };
                Ok(url.as_str().into())
            }
            Value::Params(id) => {
                let Heap::Params { entries, .. } = &self.heap[*id] else {
                    return Err(Fault::data("Invalid URLSearchParams."));
                };
                Ok(super::stdlib::url::serialize_params(entries).into())
            }
            Value::Map(_) => Ok("[object Map]".into()),
            Value::Set(_) => Ok("[object Set]".into()),
            Value::Promise(_) => Ok("[object Promise]".into()),
            Value::RegExp(id) => {
                let Heap::RegExp { pattern, .. } = &self.heap[*id] else {
                    return Err(Fault::data("Invalid RegExp."));
                };
                Ok(LosslessString::from_utf16(pattern.literal()))
            }
            Value::Function(_)
            | Value::Namespace(_)
            | Value::Tool(_)
            | Value::Intrinsic(_, _)
            | Value::Resolver(_, _) => Err(Fault::data("Coercion input must be a data value.")),
        }
    }
    pub fn number(&self, value: &Value) -> Result<f64, Fault> {
        match value {
            Value::Undefined | Value::ShortCircuit => Ok(f64::NAN),
            Value::Null => Ok(0.0),
            Value::Boolean(value) => Ok(if *value { 1.0 } else { 0.0 }),
            Value::Number(value) => Ok(*value),
            Value::String(value) => Ok(parse_number(value)),
            Value::Array(_) => Ok(parse_number(&self.text(value)?)),
            Value::Date(id) => {
                let Heap::Date(time) = self.heap[*id] else {
                    return Err(Fault::data("Invalid Date."));
                };
                Ok(time)
            }
            Value::Object(_)
            | Value::Map(_)
            | Value::Set(_)
            | Value::Url(_)
            | Value::Params(_)
            | Value::RegExp(_) => Ok(f64::NAN),
            Value::Function(_)
            | Value::Namespace(_)
            | Value::Tool(_)
            | Value::Intrinsic(_, _)
            | Value::Resolver(_, _)
            | Value::Promise(_) => Err(Fault::data("Number input must be a data value.")),
        }
    }
    pub fn primitive(&self, value: &Value, string_hint: bool) -> Result<Value, Fault> {
        match value {
            Value::Object(_)
            | Value::Array(_)
            | Value::Map(_)
            | Value::Set(_)
            | Value::Url(_)
            | Value::Params(_)
            | Value::RegExp(_) => Ok(Value::String(self.text(value)?)),
            Value::Date(_) => {
                if string_hint {
                    Ok(Value::String(self.text(value)?))
                } else {
                    Ok(Value::Number(self.number(value)?))
                }
            }
            Value::Promise(_)
            | Value::Function(_)
            | Value::Namespace(_)
            | Value::Tool(_)
            | Value::Intrinsic(_, _)
            | Value::Resolver(_, _) => Err(Fault::data("Operator input must be a data value.")),
            _ => Ok(value.clone()),
        }
    }
}

pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Undefined | Value::Null | Value::ShortCircuit => false,
        Value::Boolean(value) => *value,
        Value::Number(value) => *value != 0.0 && !value.is_nan(),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

pub(crate) fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Undefined | Value::ShortCircuit => "undefined",
        Value::Boolean(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Tool(path) if path.is_empty() => "object",
        Value::Function(_) | Value::Tool(_) | Value::Intrinsic(_, _) | Value::Resolver(_, _) => {
            "function"
        }
        Value::Namespace(name) if !["Math", "JSON", "console"].contains(&name.as_str()) => {
            "function"
        }
        _ => "object",
    }
}

pub(crate) fn identical(a: &Value, b: &Value, same_zero: bool) -> bool {
    match (a, b) {
        (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
        (Value::Boolean(a), Value::Boolean(b)) => a == b,
        (Value::Number(a), Value::Number(b)) => a == b || (same_zero && a.is_nan() && b.is_nan()),
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Object(a), Value::Object(b))
        | (Value::Array(a), Value::Array(b))
        | (Value::Function(a), Value::Function(b))
        | (Value::Promise(a), Value::Promise(b))
        | (Value::Map(a), Value::Map(b))
        | (Value::Set(a), Value::Set(b))
        | (Value::Date(a), Value::Date(b))
        | (Value::Url(a), Value::Url(b))
        | (Value::Params(a), Value::Params(b)) => a == b,
        (Value::Namespace(a), Value::Namespace(b)) => a == b,
        (Value::Tool(a), Value::Tool(b)) => a == b,
        _ => false,
    }
}

pub(crate) fn index(key: &LosslessString) -> Option<u32> {
    let text = key.as_str()?;
    if text.is_empty()
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    text.parse::<u32>().ok().filter(|value| *value < u32::MAX)
}
pub(crate) fn field(fields: &[(LosslessString, Value)], key: &LosslessString) -> Option<Value> {
    fields
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.clone())
}
pub(crate) fn put(fields: &mut Vec<(LosslessString, Value)>, key: LosslessString, value: Value) {
    if let Some((_, entry)) = fields.iter_mut().find(|(name, _)| name == &key) {
        *entry = value;
        return;
    }
    let at = index(&key)
        .map(|key| fields.partition_point(|(name, _)| index(name).is_some_and(|name| name < key)));
    match at {
        Some(at) => fields.insert(at, (key, value)),
        None => fields.push((key, value)),
    }
}
pub(crate) fn concat(strings: &[LosslessString]) -> LosslessString {
    LosslessString::from_utf16(strings.iter().flat_map(|text| text.code_units()).collect())
}
pub(crate) fn number_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value == f64::INFINITY {
        return "Infinity".into();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    stringify_json(&JsonValue::Number(value))
}
pub(crate) fn parse_number(text: &LosslessString) -> f64 {
    let Some(text) = text.as_str() else {
        return f64::NAN;
    };
    let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if text.is_empty() {
        return 0.0;
    }
    if text == "Infinity" || text == "+Infinity" {
        return f64::INFINITY;
    }
    if text == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            return u128::from_str_radix(digits, radix).map_or(f64::NAN, |value| value as f64);
        }
    }
    text.parse().unwrap_or(f64::NAN)
}
pub(crate) fn int32(value: f64) -> i32 {
    uint32(value) as i32
}
pub(crate) fn uint32(value: f64) -> u32 {
    if !value.is_finite() || value == 0.0 {
        return 0;
    }
    (value.trunc().rem_euclid(4_294_967_296.0)) as u32
}
