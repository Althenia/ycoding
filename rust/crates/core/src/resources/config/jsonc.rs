use ycoding_schema::{JsonValue, LosslessString, parse_json, stringify_json};

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    OpenObject,
    CloseObject,
    OpenArray,
    CloseArray,
    Colon,
    Comma,
    String,
    Number,
    Null,
    True,
    False,
    End,
}

struct Token {
    kind: Kind,
    offset: usize,
    text: String,
}

struct Scanner {
    units: Vec<u16>,
    position: usize,
}

impl Scanner {
    fn next(&mut self, errors: &mut Vec<String>) -> Token {
        loop {
            let offset = self.position.min(self.units.len());
            let Some(unit) = self.units.get(self.position).copied() else {
                return Token {
                    kind: Kind::End,
                    offset,
                    text: String::new(),
                };
            };
            if matches!(unit, 9 | 10 | 13 | 32) {
                self.position += 1;
                continue;
            }
            if unit == 47 && self.units.get(self.position + 1) == Some(&47) {
                self.position += 2;
                while self.position < self.units.len()
                    && !matches!(self.units[self.position], 10 | 13)
                {
                    self.position += 1;
                }
                continue;
            }
            if unit == 47 && self.units.get(self.position + 1) == Some(&42) {
                self.position += 2;
                let mut closed = false;
                while self.position + 1 < self.units.len() {
                    if self.units[self.position] == 42 && self.units[self.position + 1] == 47 {
                        self.position += 2;
                        closed = true;
                        break;
                    }
                    self.position += 1;
                }
                if !closed {
                    self.position += 1;
                    errors.push(format!("UnexpectedEndOfComment at offset {offset}"));
                }
                continue;
            }
            let punctuation = match unit {
                123 => Some(Kind::OpenObject),
                125 => Some(Kind::CloseObject),
                91 => Some(Kind::OpenArray),
                93 => Some(Kind::CloseArray),
                58 => Some(Kind::Colon),
                44 => Some(Kind::Comma),
                _ => None,
            };
            if let Some(kind) = punctuation {
                self.position += 1;
                return Token {
                    kind,
                    offset,
                    text: char::from(unit as u8).to_string(),
                };
            }
            if unit == 34 {
                self.position += 1;
                let mut value = Vec::new();
                let mut error = None;
                loop {
                    let Some(unit) = self.units.get(self.position).copied() else {
                        error = Some("UnexpectedEndOfString");
                        break;
                    };
                    if unit == 34 {
                        self.position += 1;
                        break;
                    }
                    if unit == 92 {
                        self.position += 1;
                        let Some(escaped) = self.units.get(self.position).copied() else {
                            error = Some("UnexpectedEndOfString");
                            break;
                        };
                        self.position += 1;
                        match escaped {
                            34 | 92 | 47 => value.push(escaped),
                            98 => value.push(8),
                            102 => value.push(12),
                            110 => value.push(10),
                            114 => value.push(13),
                            116 => value.push(9),
                            117 => {
                                let mut number = 0;
                                let mut count = 0;
                                while count < 4 {
                                    let digit =
                                        self.units.get(self.position).and_then(|unit| match unit {
                                            48..=57 => Some(unit - 48),
                                            65..=70 => Some(unit - 65 + 10),
                                            97..=102 => Some(unit - 97 + 10),
                                            _ => None,
                                        });
                                    let Some(digit) = digit else {
                                        break;
                                    };
                                    number = number * 16 + digit;
                                    self.position += 1;
                                    count += 1;
                                }
                                if count == 4 {
                                    value.push(number);
                                } else {
                                    error = Some("InvalidUnicode");
                                }
                            }
                            _ => error = Some("InvalidEscapeCharacter"),
                        }
                        continue;
                    }
                    if matches!(unit, 10 | 13) {
                        error = Some("UnexpectedEndOfString");
                        break;
                    }
                    if unit <= 31 {
                        error = Some("InvalidCharacter");
                    }
                    value.push(unit);
                    self.position += 1;
                }
                if let Some(error) = error {
                    errors.push(format!("{error} at offset {offset}"));
                }
                return Token {
                    kind: Kind::String,
                    offset,
                    text: stringify_json(&JsonValue::String(LosslessString::from_utf16(value))),
                };
            }
            if unit == 45 || matches!(unit, 48..=57) {
                if unit == 45 {
                    self.position += 1;
                    if !self
                        .units
                        .get(self.position)
                        .is_some_and(|unit| matches!(unit, 48..=57))
                    {
                        errors.push(format!("InvalidSymbol at offset {offset}"));
                        continue;
                    }
                }
                if self.units[self.position] == 48 {
                    self.position += 1;
                } else {
                    while self
                        .units
                        .get(self.position)
                        .is_some_and(|unit| matches!(unit, 48..=57))
                    {
                        self.position += 1;
                    }
                }
                let mut error = None;
                if self.units.get(self.position) == Some(&46) {
                    self.position += 1;
                    if !self
                        .units
                        .get(self.position)
                        .is_some_and(|unit| matches!(unit, 48..=57))
                    {
                        error = Some("UnexpectedEndOfNumber");
                    }
                    while self
                        .units
                        .get(self.position)
                        .is_some_and(|unit| matches!(unit, 48..=57))
                    {
                        self.position += 1;
                    }
                }
                if error.is_none()
                    && self
                        .units
                        .get(self.position)
                        .is_some_and(|unit| matches!(unit, 69 | 101))
                {
                    self.position += 1;
                    if self
                        .units
                        .get(self.position)
                        .is_some_and(|unit| matches!(unit, 43 | 45))
                    {
                        self.position += 1;
                    }
                    if !self
                        .units
                        .get(self.position)
                        .is_some_and(|unit| matches!(unit, 48..=57))
                    {
                        error = Some("UnexpectedEndOfNumber");
                    }
                    while self
                        .units
                        .get(self.position)
                        .is_some_and(|unit| matches!(unit, 48..=57))
                    {
                        self.position += 1;
                    }
                }
                if let Some(error) = error {
                    errors.push(format!("{error} at offset {offset}"));
                }
                return Token {
                    kind: Kind::Number,
                    offset,
                    text: self.units[offset..self.position]
                        .iter()
                        .map(|unit| char::from(*unit as u8))
                        .collect(),
                };
            }
            if unit == 47 {
                self.position += 1;
                errors.push(format!("InvalidSymbol at offset {offset}"));
                continue;
            }
            while self.units.get(self.position).is_some_and(|unit| {
                !matches!(
                    unit,
                    9 | 10 | 13 | 32 | 125 | 93 | 123 | 91 | 34 | 58 | 44 | 47
                )
            }) {
                self.position += 1;
            }
            let word = LosslessString::from_utf16(self.units[offset..self.position].to_vec());
            let kind = match word.as_str() {
                Some("null") => Some(Kind::Null),
                Some("true") => Some(Kind::True),
                Some("false") => Some(Kind::False),
                _ => None,
            };
            if let Some(kind) = kind {
                return Token {
                    kind,
                    offset,
                    text: word.as_str().unwrap_or_default().to_owned(),
                };
            }
            errors.push(format!("InvalidSymbol at offset {offset}"));
        }
    }
}

enum Task {
    Object(bool),
    Array(bool),
    End,
}

struct Parser {
    scanner: Scanner,
    token: Token,
    errors: Vec<String>,
    output: String,
    tasks: Vec<Task>,
}

impl Parser {
    fn advance(&mut self) {
        self.output.push_str(&self.token.text);
        self.token = self.scanner.next(&mut self.errors);
    }

    fn error(&mut self, error: &str) {
        self.errors
            .push(format!("{error} at offset {}", self.token.offset));
    }

    fn skip_until(&mut self, kinds: &[Kind]) {
        while self.token.kind != Kind::End && !kinds.contains(&self.token.kind) {
            self.advance();
        }
    }

    fn value(&mut self) -> bool {
        match self.token.kind {
            Kind::OpenObject => {
                self.advance();
                self.tasks.push(Task::Object(false));
                true
            }
            Kind::OpenArray => {
                self.advance();
                self.tasks.push(Task::Array(false));
                true
            }
            Kind::String | Kind::Number | Kind::Null | Kind::True | Kind::False => {
                self.advance();
                true
            }
            _ => false,
        }
    }

    fn container(&mut self, object: bool, needs_comma: bool) {
        let close = if object {
            Kind::CloseObject
        } else {
            Kind::CloseArray
        };
        if self.token.kind == close {
            self.advance();
            return;
        }
        if self.token.kind == Kind::End {
            self.error(if object {
                "CloseBraceExpected"
            } else {
                "CloseBracketExpected"
            });
            return;
        }
        if self.token.kind == Kind::Comma {
            if !needs_comma {
                self.error("ValueExpected");
            }
            self.advance();
            if self.token.kind == close {
                self.output.pop();
                self.advance();
                return;
            }
        } else if needs_comma {
            self.error("CommaExpected");
        }
        self.tasks.push(if object {
            Task::Object(true)
        } else {
            Task::Array(true)
        });
        if !object {
            if !self.value() {
                self.error("ValueExpected");
                self.skip_until(&[close, Kind::Comma]);
            }
            return;
        }
        if self.token.kind != Kind::String {
            self.error("PropertyNameExpected");
            self.skip_until(&[close, Kind::Comma]);
            self.error("ValueExpected");
            self.skip_until(&[close, Kind::Comma]);
            return;
        }
        self.advance();
        if self.token.kind != Kind::Colon {
            self.error("ColonExpected");
            self.skip_until(&[close, Kind::Comma]);
            return;
        }
        self.advance();
        if !self.value() {
            self.error("ValueExpected");
            self.skip_until(&[close, Kind::Comma]);
        }
    }
}

pub(super) fn parse(text: &str) -> Result<JsonValue, String> {
    let mut scanner = Scanner {
        units: text.encode_utf16().collect(),
        position: 0,
    };
    let mut errors = Vec::new();
    let token = scanner.next(&mut errors);
    let mut parser = Parser {
        scanner,
        token,
        errors,
        output: String::new(),
        tasks: vec![Task::End],
    };
    if !parser.value() {
        parser.error("ValueExpected");
        return Err(parser.errors.join("; "));
    }
    while let Some(task) = parser.tasks.pop() {
        match task {
            Task::Object(needs_comma) => parser.container(true, needs_comma),
            Task::Array(needs_comma) => parser.container(false, needs_comma),
            Task::End => {
                if parser.token.kind != Kind::End {
                    parser.error("EndOfFileExpected");
                }
            }
        }
    }
    if !parser.errors.is_empty() {
        return Err(parser.errors.join("; "));
    }
    parse_json(&parser.output).map_err(|error| error.to_string())
}
