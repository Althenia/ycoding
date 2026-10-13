use crate::LosslessString;
use std::fmt::Write;

#[derive(Clone, Debug, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    String(LosslessString),
    Array(Vec<JsonValue>),
    Object(JsonObject),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct JsonObject(Vec<(LosslessString, JsonValue)>);

impl JsonObject {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, key: LosslessString, value: JsonValue) -> Option<JsonValue> {
        if let Some((_, existing)) = self.0.iter_mut().find(|(existing, _)| existing == &key) {
            return Some(std::mem::replace(existing, value));
        }
        let position = array_index(&key).map(|index| {
            self.0
                .partition_point(|(key, _)| array_index(key).is_some_and(|other| other < index))
        });
        match position {
            Some(position) => self.0.insert(position, (key, value)),
            None => self.0.push((key, value)),
        }
        None
    }

    pub fn get(&self, key: &LosslessString) -> Option<&JsonValue> {
        self.0
            .iter()
            .find(|(existing, _)| existing == key)
            .map(|(_, value)| value)
    }

    pub fn iter(
        &self,
    ) -> impl DoubleEndedIterator<Item = &(LosslessString, JsonValue)> + ExactSizeIterator {
        self.0.iter()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

fn array_index(key: &LosslessString) -> Option<u32> {
    let key = key.as_str()?;
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JsonErrorKind {
    UnexpectedEnd,
    UnexpectedToken,
    InvalidEscape,
    InvalidNumber,
    UnescapedControl,
    TrailingInput,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{kind:?} at JSON byte offset {offset}")]
pub struct JsonError {
    pub kind: JsonErrorKind,
    pub offset: usize,
}

enum Frame {
    Array(Vec<JsonValue>, ArrayPhase),
    Object(JsonObject, Option<LosslessString>, ObjectPhase),
}

enum ArrayPhase {
    First,
    Value,
    Delimiter,
}

enum ObjectPhase {
    First,
    Key,
    Colon,
    Value,
    Delimiter,
}

pub fn parse_json(input: &str) -> Result<JsonValue, JsonError> {
    let mut parser = Parser { input, offset: 0 };
    let mut stack = Vec::new();
    let mut value = None;
    loop {
        parser.whitespace();
        if let Some(value) = value.take() {
            match stack.last_mut() {
                Some(Frame::Array(values, phase)) => {
                    values.push(value);
                    *phase = ArrayPhase::Delimiter;
                }
                Some(Frame::Object(object, key, phase)) => {
                    object.insert(key.take().expect("object value has a parsed key"), value);
                    *phase = ObjectPhase::Delimiter;
                }
                None => {
                    if parser.offset != input.len() {
                        return Err(parser.error(JsonErrorKind::TrailingInput));
                    }
                    return Ok(value);
                }
            }
        }
        let close = match stack.last_mut() {
            Some(Frame::Array(_, ArrayPhase::First)) if parser.peek() == Some(b']') => true,
            Some(Frame::Object(_, _, ObjectPhase::First)) if parser.peek() == Some(b'}') => true,
            Some(Frame::Array(_, phase @ ArrayPhase::Delimiter)) => match parser.peek() {
                Some(b']') => true,
                Some(b',') => {
                    parser.offset += 1;
                    *phase = ArrayPhase::Value;
                    continue;
                }
                _ => return Err(parser.expected_token()),
            },
            Some(Frame::Object(_, _, phase @ ObjectPhase::Delimiter)) => match parser.peek() {
                Some(b'}') => true,
                Some(b',') => {
                    parser.offset += 1;
                    *phase = ObjectPhase::Key;
                    continue;
                }
                _ => return Err(parser.expected_token()),
            },
            Some(Frame::Object(_, key, phase @ (ObjectPhase::First | ObjectPhase::Key))) => {
                if parser.peek() != Some(b'"') {
                    return Err(parser.expected_token());
                }
                *key = Some(parser.string()?);
                *phase = ObjectPhase::Colon;
                continue;
            }
            Some(Frame::Object(_, _, phase @ ObjectPhase::Colon)) => {
                if parser.peek() != Some(b':') {
                    return Err(parser.expected_token());
                }
                parser.offset += 1;
                *phase = ObjectPhase::Value;
                continue;
            }
            _ => false,
        };
        if close {
            parser.offset += 1;
            value = Some(match stack.pop().expect("closing delimiter has a frame") {
                Frame::Array(values, _) => JsonValue::Array(values),
                Frame::Object(object, _, _) => JsonValue::Object(object),
            });
            continue;
        }
        match parser.peek() {
            Some(b'[') => {
                parser.offset += 1;
                stack.push(Frame::Array(Vec::new(), ArrayPhase::First));
            }
            Some(b'{') => {
                parser.offset += 1;
                stack.push(Frame::Object(JsonObject::new(), None, ObjectPhase::First));
            }
            Some(b'"') => value = Some(JsonValue::String(parser.string()?)),
            Some(b'n') => {
                parser.literal("null")?;
                value = Some(JsonValue::Null);
            }
            Some(b't') => {
                parser.literal("true")?;
                value = Some(JsonValue::Bool(true));
            }
            Some(b'f') => {
                parser.literal("false")?;
                value = Some(JsonValue::Bool(false));
            }
            Some(b'-' | b'0'..=b'9') => value = Some(JsonValue::Number(parser.number()?)),
            _ => return Err(parser.expected_token()),
        }
    }
}

struct Parser<'a> {
    input: &'a str,
    offset: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.input.as_bytes().get(self.offset).copied()
    }

    fn error(&self, kind: JsonErrorKind) -> JsonError {
        JsonError {
            kind,
            offset: self.offset,
        }
    }

    fn expected_token(&self) -> JsonError {
        self.error(if self.peek().is_none() {
            JsonErrorKind::UnexpectedEnd
        } else {
            JsonErrorKind::UnexpectedToken
        })
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.offset += 1;
        }
    }

    fn literal(&mut self, text: &str) -> Result<(), JsonError> {
        if !self.input[self.offset..].starts_with(text) {
            return Err(self.expected_token());
        }
        self.offset += text.len();
        Ok(())
    }

    fn string(&mut self) -> Result<LosslessString, JsonError> {
        self.offset += 1;
        let mut units = Vec::new();
        loop {
            let start = self.offset;
            while self
                .peek()
                .is_some_and(|byte| byte >= 0x20 && byte != b'"' && byte != b'\\')
            {
                self.offset += 1;
            }
            units.extend(self.input[start..self.offset].encode_utf16());
            match self.peek() {
                Some(b'"') => {
                    self.offset += 1;
                    return Ok(LosslessString::from_utf16(units));
                }
                Some(b'\\') => {
                    self.offset += 1;
                    let unit = match self.peek() {
                        Some(b'"') => 0x22,
                        Some(b'\\') => 0x5c,
                        Some(b'/') => 0x2f,
                        Some(b'b') => 0x08,
                        Some(b'f') => 0x0c,
                        Some(b'n') => 0x0a,
                        Some(b'r') => 0x0d,
                        Some(b't') => 0x09,
                        Some(b'u') => {
                            self.offset += 1;
                            let mut unit = 0u16;
                            for _ in 0..4 {
                                let digit = self
                                    .peek()
                                    .and_then(|byte| (byte as char).to_digit(16))
                                    .ok_or_else(|| self.error(JsonErrorKind::InvalidEscape))?;
                                unit = (unit << 4) | digit as u16;
                                self.offset += 1;
                            }
                            units.push(unit);
                            continue;
                        }
                        _ => return Err(self.error(JsonErrorKind::InvalidEscape)),
                    };
                    units.push(unit);
                    self.offset += 1;
                }
                Some(_) => return Err(self.error(JsonErrorKind::UnescapedControl)),
                None => return Err(self.error(JsonErrorKind::UnexpectedEnd)),
            }
        }
    }

    fn number(&mut self) -> Result<f64, JsonError> {
        let start = self.offset;
        if self.peek() == Some(b'-') {
            self.offset += 1;
        }
        match self.peek() {
            Some(b'0') => self.offset += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(self.error(JsonErrorKind::InvalidNumber)),
        }
        if self.peek() == Some(b'.') {
            self.offset += 1;
            self.require_digits()?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.offset += 1;
            if matches!(self.peek(), Some(b'-' | b'+')) {
                self.offset += 1;
            }
            self.require_digits()?;
        }
        self.input[start..self.offset]
            .parse()
            .map_err(|_| self.error(JsonErrorKind::InvalidNumber))
    }

    fn require_digits(&mut self) -> Result<(), JsonError> {
        if !self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            return Err(self.error(JsonErrorKind::InvalidNumber));
        }
        self.digits();
        Ok(())
    }

    fn digits(&mut self) {
        while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
            self.offset += 1;
        }
    }
}

enum WriteTask<'a> {
    Value(&'a JsonValue),
    String(&'a LosslessString),
    Character(char),
}

pub fn stringify_json(value: &JsonValue) -> String {
    let mut output = String::new();
    let mut stack = vec![WriteTask::Value(value)];
    while let Some(task) = stack.pop() {
        match task {
            WriteTask::String(text) => write_string(text, &mut output),
            WriteTask::Character(character) => output.push(character),
            WriteTask::Value(value) => match value {
                JsonValue::Null => output.push_str("null"),
                JsonValue::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
                JsonValue::Number(value) => write_number(*value, &mut output),
                JsonValue::String(text) => write_string(text, &mut output),
                JsonValue::Array(values) => {
                    output.push('[');
                    stack.push(WriteTask::Character(']'));
                    for (index, value) in values.iter().enumerate().rev() {
                        stack.push(WriteTask::Value(value));
                        if index != 0 {
                            stack.push(WriteTask::Character(','));
                        }
                    }
                }
                JsonValue::Object(object) => {
                    output.push('{');
                    stack.push(WriteTask::Character('}'));
                    for (index, (key, value)) in object.iter().enumerate().rev() {
                        stack.push(WriteTask::Value(value));
                        stack.push(WriteTask::Character(':'));
                        stack.push(WriteTask::String(key));
                        if index != 0 {
                            stack.push(WriteTask::Character(','));
                        }
                    }
                }
            },
        }
    }
    output
}

fn write_string(text: &LosslessString, output: &mut String) {
    output.push('"');
    for character in char::decode_utf16(text.code_units()) {
        match character {
            Ok('"') => output.push_str("\\\""),
            Ok('\\') => output.push_str("\\\\"),
            Ok('\u{08}') => output.push_str("\\b"),
            Ok('\u{0c}') => output.push_str("\\f"),
            Ok('\n') => output.push_str("\\n"),
            Ok('\r') => output.push_str("\\r"),
            Ok('\t') => output.push_str("\\t"),
            Ok(character) if character <= '\u{1f}' => {
                write!(output, "\\u{:04x}", character as u16)
                    .expect("writing to String cannot fail");
            }
            Ok(character) => output.push(character),
            Err(error) => {
                write!(output, "\\u{:04x}", error.unpaired_surrogate())
                    .expect("writing to String cannot fail");
            }
        }
    }
    output.push('"');
}

fn write_number(number: f64, output: &mut String) {
    if !number.is_finite() {
        output.push_str("null");
        return;
    }
    if number == 0.0 {
        output.push('0');
        return;
    }
    if number.is_sign_negative() {
        output.push('-');
    }
    let decimal =
        serde_json::to_string(&number.abs()).expect("finite f64 serialization cannot fail");
    let (decimal, exponent) = match decimal.split_once('e') {
        Some((mantissa, exponent)) => (
            mantissa,
            exponent
                .parse::<i32>()
                .expect("formatter produces a decimal exponent"),
        ),
        None => (decimal.as_str(), 0),
    };
    let point = decimal.find('.').unwrap_or(decimal.len());
    let digits = decimal
        .bytes()
        .filter(|byte| *byte != b'.')
        .collect::<Vec<_>>();
    let first = digits
        .iter()
        .position(|byte| *byte != b'0')
        .expect("nonzero number has a nonzero digit");
    let last = digits
        .iter()
        .rposition(|byte| *byte != b'0')
        .expect("nonzero number has a nonzero digit");
    let digits = &digits[first..=last];
    let position = point as i32 - first as i32 + exponent;
    if position > 0 && position <= 21 {
        for index in 0..(position as usize).max(digits.len()) {
            if index == position as usize {
                output.push('.');
            }
            output.push(digits.get(index).copied().unwrap_or(b'0') as char);
        }
        return;
    }
    if position <= 0 && position > -6 {
        output.push_str("0.");
        for _ in 0..-position {
            output.push('0');
        }
        digits.iter().for_each(|digit| output.push(*digit as char));
        return;
    }
    output.push(digits[0] as char);
    if digits.len() > 1 {
        output.push('.');
        digits[1..]
            .iter()
            .for_each(|digit| output.push(*digit as char));
    }
    let exponent = position - 1;
    output.push('e');
    if exponent >= 0 {
        output.push('+');
    }
    write!(output, "{exponent}").expect("writing to String cannot fail");
}
