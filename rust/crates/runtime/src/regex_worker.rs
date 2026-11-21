use std::io::{self, BufRead, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use ycoding_core::regexp::{Budget, Error, Match, RegExp};
use ycoding_core::resources::memory::format::sha256;
use ycoding_core::ycoding_schema::{
    JsonObject, JsonValue, LosslessString, parse_json, stringify_json,
};

include!(concat!(env!("OUT_DIR"), "/regex_worker_metadata.rs"));

const MARKER: &str = "--ycoding-internal-regex";
const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;
const MAX_STRING_LENGTH: usize = 16_777_216;
const MAX_ARRAY_LENGTH: usize = 10_000_000;

pub fn run(args: &[String]) -> Option<Result<u8, String>> {
    if args.first().is_none_or(|arg| arg != "-e") && !args.iter().any(|arg| arg == MARKER) {
        return None;
    }
    Some(run_owned(args))
}

fn run_owned(args: &[String]) -> Result<u8, String> {
    if args.len() != 4
        || args[0] != "-e"
        || args[2] != "--"
        || args[3] != MARKER
        || args[1].len() != REGEX_RECIPE_BYTES
        || sha256(args[1].as_bytes()) != REGEX_RECIPE_SHA256
    {
        return Err("Invalid private regex worker invocation".into());
    }
    let mut owner = Owner::connect()?;
    let result = serve(&mut io::stdin().lock(), &mut io::stdout().lock());
    let cleanup = owner.close();
    match (result, cleanup) {
        (Ok(code), Ok(())) => Ok(code),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    }
}

struct Owner {
    socket: TcpStream,
    stopped: Arc<AtomicBool>,
    monitor: Option<JoinHandle<()>>,
}

impl Owner {
    fn connect() -> Result<Self, String> {
        let invalid = || "Invalid private regex owner lease".to_owned();
        let address = std::env::var("YCODING_REGEX_OWNER")
            .ok()
            .and_then(|value| value.parse::<SocketAddr>().ok())
            .filter(|address| address.ip().is_loopback() && address.port() != 0)
            .ok_or_else(invalid)?;
        let token = std::env::var("YCODING_REGEX_TOKEN").map_err(|_| invalid())?;
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        let timeout = Duration::from_secs(3);
        let mut socket = TcpStream::connect_timeout(&address, timeout).map_err(|_| invalid())?;
        socket
            .set_read_timeout(Some(timeout))
            .map_err(|_| invalid())?;
        socket
            .set_write_timeout(Some(timeout))
            .map_err(|_| invalid())?;
        socket.write_all(token.as_bytes()).map_err(|_| invalid())?;
        socket.write_all(b"\n").map_err(|_| invalid())?;
        let mut reply = [0; 3];
        socket.read_exact(&mut reply).map_err(|_| invalid())?;
        if &reply != b"ok\n" {
            return Err(invalid());
        }
        socket.set_read_timeout(None).map_err(|_| invalid())?;
        socket.set_write_timeout(None).map_err(|_| invalid())?;
        let mut observer = socket.try_clone().map_err(|_| invalid())?;
        let stopped = Arc::new(AtomicBool::new(false));
        let finished = stopped.clone();
        let monitor = thread::Builder::new()
            .name("ycoding-regex-owner".into())
            .spawn(move || {
                let mut byte = [0];
                loop {
                    if let Err(error) = observer.read(&mut byte)
                        && error.kind() == io::ErrorKind::Interrupted
                    {
                        continue;
                    }
                    if !finished.load(Ordering::Acquire) {
                        std::process::exit(1);
                    }
                    break;
                }
            })
            .map_err(|_| "Failed to monitor the private regex owner".to_owned())?;
        Ok(Self {
            socket,
            stopped,
            monitor: Some(monitor),
        })
    }

    fn close(&mut self) -> Result<(), String> {
        self.stopped.store(true, Ordering::Release);
        let shutdown = self.socket.shutdown(Shutdown::Both);
        let joined = self.monitor.take().map(JoinHandle::join);
        if shutdown.is_err() || joined.is_some_and(|result| result.is_err()) {
            return Err("Failed to join the private regex owner monitor".into());
        }
        Ok(())
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        if self.monitor.is_some() {
            let _ = self.close();
        }
    }
}

enum Frame {
    End,
    Oversized,
    Request(Vec<u8>),
}

fn next_frame(input: &mut impl BufRead, maximum: usize) -> io::Result<Frame> {
    let mut frame = Vec::new();
    loop {
        let chunk = input.fill_buf()?;
        if chunk.is_empty() {
            return Ok(Frame::End);
        }
        let end = chunk.iter().position(|byte| *byte == b'\n');
        let count = end.unwrap_or(chunk.len());
        if frame.len().saturating_add(count) > maximum {
            return Ok(Frame::Oversized);
        }
        frame.extend_from_slice(&chunk[..count]);
        input.consume(count + usize::from(end.is_some()));
        if end.is_some() {
            return Ok(Frame::Request(frame));
        }
    }
}

fn send(output: &mut impl Write, value: &JsonValue) -> Result<(), String> {
    let frame = stringify_json(value);
    if frame.len() > MAX_FRAME_BYTES {
        return Err("Regex response exceeds the IPC frame limit".into());
    }
    output
        .write_all(frame.as_bytes())
        .map_err(|_| "Regex worker output failed")?;
    output
        .write_all(b"\n")
        .map_err(|_| "Regex worker output failed")?;
    output
        .flush()
        .map_err(|_| "Regex worker output failed".to_owned())
}

fn serve(input: &mut impl BufRead, output: &mut impl Write) -> Result<u8, String> {
    send(output, &object([("ready", JsonValue::Bool(true))]))?;
    loop {
        let frame =
            match next_frame(input, MAX_FRAME_BYTES).map_err(|_| "Regex worker input failed")? {
                Frame::End => return Ok(0),
                Frame::Oversized => {
                    send(
                        output,
                        &Fault::range("Regex request exceeds the IPC frame limit.").wire(),
                    )?;
                    return Ok(0);
                }
                Frame::Request(frame) => frame,
            };
        let Ok(request) = parse_json(&String::from_utf8_lossy(&frame)) else {
            return Ok(1);
        };
        let mut reply = operation(&request).unwrap_or_else(|error| error.wire());
        if stringify_json(&reply).len() > MAX_FRAME_BYTES {
            reply = Fault::range("Regex response exceeds the IPC frame limit.").wire();
        }
        send(output, &reply)?;
    }
}

struct Fault {
    name: &'static str,
    message: String,
}

impl Fault {
    fn range(message: &str) -> Self {
        Self {
            name: "RangeError",
            message: message.into(),
        }
    }

    fn wire(self) -> JsonValue {
        object([(
            "error",
            object([
                ("name", JsonValue::String(self.name.into())),
                ("message", JsonValue::String(self.message.into())),
            ]),
        )])
    }
}

impl From<Error> for Fault {
    fn from(error: Error) -> Self {
        Self {
            name: match error {
                Error::Syntax(_) | Error::UnsupportedStringProperty(_) => "SyntaxError",
                Error::RequiresGlobal => "TypeError",
                Error::StepLimit => "RangeError",
                Error::Cancelled => "Error",
            },
            message: error.to_string(),
        }
    }
}

fn object<const N: usize>(entries: [(&str, JsonValue); N]) -> JsonValue {
    let mut result = JsonObject::new();
    for (key, value) in entries {
        result.insert(key.into(), value);
    }
    JsonValue::Object(result)
}

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(value) = value else {
        return None;
    };
    value.get(&name.into())
}

fn string<'a>(value: &'a JsonValue, name: &str) -> Result<&'a LosslessString, Fault> {
    match field(value, name) {
        Some(JsonValue::String(value)) => Ok(value),
        _ => Err(Fault {
            name: "TypeError",
            message: "Invalid regex request.".into(),
        }),
    }
}

fn string_length(length: usize) -> Result<(), Fault> {
    if length > MAX_STRING_LENGTH {
        return Err(Fault::range("String length exceeds 16777216."));
    }
    Ok(())
}

fn primitive_text(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => String::new(),
        JsonValue::String(value) => value.to_utf8().unwrap_or_else(|_| "NaN".into()),
        JsonValue::Array(values) => values
            .iter()
            .map(primitive_text)
            .collect::<Vec<_>>()
            .join(","),
        JsonValue::Object(_) => "[object Object]".into(),
        _ => stringify_json(value),
    }
}

fn number(value: Option<&JsonValue>) -> f64 {
    let text = match value {
        None => return f64::NAN,
        Some(JsonValue::Null) => return 0.0,
        Some(JsonValue::Bool(value)) => return f64::from(u8::from(*value)),
        Some(JsonValue::Number(value)) => return *value,
        Some(value) => primitive_text(value),
    };
    let text = text.trim_matches(|character: char| {
        matches!(character,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
        '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    });
    if text.is_empty() {
        return 0.0;
    }
    if matches!(text, "Infinity" | "+Infinity") {
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
            if digits.is_empty() {
                return f64::NAN;
            }
            return digits
                .chars()
                .try_fold(0.0, |value, digit| {
                    digit
                        .to_digit(radix)
                        .map(|digit| value * f64::from(radix) + f64::from(digit))
                })
                .unwrap_or(f64::NAN);
        }
    }
    if text
        .bytes()
        .all(|byte| byte.is_ascii_digit() || b"+-.eE".contains(&byte))
    {
        text.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

fn last_index(value: Option<&JsonValue>) -> u64 {
    let value = number(value);
    if value.is_nan() || value <= 0.0 {
        0
    } else {
        value.min(9_007_199_254_740_991.0).trunc() as u64
    }
}

fn advance(input: &[u16], offset: usize, unicode: bool) -> usize {
    offset.saturating_add(
        if unicode
            && input
                .get(offset)
                .is_some_and(|unit| (0xd800..=0xdbff).contains(unit))
            && input
                .get(offset + 1)
                .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
        {
            2
        } else {
            1
        },
    )
}

fn each_match(
    re: &mut RegExp,
    input: &[u16],
    repeated: bool,
    budget: &mut Budget<'_>,
    mut consume: impl FnMut(Match) -> Result<(), Fault>,
) -> Result<(), Fault> {
    while let Some(matched) = re.exec(input, budget)? {
        if repeated && matched.captures[0].as_ref().is_some_and(Vec::is_empty) {
            re.last_index = advance(
                input,
                re.last_index as usize,
                re.unicode() || re.unicode_sets(),
            ) as u64;
        }
        consume(matched)?;
        if !repeated {
            break;
        }
    }
    Ok(())
}

#[derive(Default)]
struct Pack {
    bytes: usize,
}

impl Pack {
    fn account(&mut self, bytes: usize) -> Result<(), Fault> {
        self.bytes = self.bytes.saturating_add(bytes);
        if self.bytes > MAX_FRAME_BYTES - 128 {
            return Err(Fault::range("Regex response exceeds the IPC frame limit."));
        }
        Ok(())
    }

    fn scalar(&mut self, value: JsonValue) -> Result<JsonValue, Fault> {
        if let JsonValue::String(value) = &value {
            string_length(value.len())?
        }
        self.account(stringify_json(&value).len() + 1)?;
        Ok(value)
    }

    fn undefined(&mut self) -> Result<JsonValue, Fault> {
        self.account(7)?;
        Ok(object([("u", JsonValue::Number(1.0))]))
    }

    fn capture(&mut self, value: Option<&Vec<u16>>) -> Result<JsonValue, Fault> {
        match value {
            Some(value) => {
                self.scalar(JsonValue::String(LosslessString::from_utf16(value.clone())))
            }
            None => self.undefined(),
        }
    }

    fn begin_array(&mut self, length: usize) -> Result<(), Fault> {
        if length > MAX_ARRAY_LENGTH {
            return Err(Fault::range("Array length exceeds 10000000."));
        }
        self.account(32 + length)
    }

    fn append(&mut self, items: &mut Vec<JsonValue>, value: JsonValue) -> Result<(), Fault> {
        if items.len() >= MAX_ARRAY_LENGTH {
            return Err(Fault::range("Array length exceeds 10000000."));
        }
        self.account(1)?;
        items.push(value);
        Ok(())
    }

    fn array(items: Vec<JsonValue>, properties: Vec<JsonValue>) -> JsonValue {
        object([
            ("a", JsonValue::Array(items)),
            ("p", JsonValue::Array(properties)),
        ])
    }

    fn property(&mut self, name: &str, value: JsonValue) -> Result<JsonValue, Fault> {
        self.account(16)?;
        Ok(JsonValue::Array(vec![
            JsonValue::String(name.into()),
            value,
        ]))
    }

    fn pair(&mut self, pair: Option<(usize, usize)>) -> Result<JsonValue, Fault> {
        let Some((start, end)) = pair else {
            return self.undefined();
        };
        self.begin_array(2)?;
        let start = self.scalar(JsonValue::Number(start as f64))?;
        let end = self.scalar(JsonValue::Number(end as f64))?;
        Ok(Self::array(vec![start, end], Vec::new()))
    }

    fn groups<T>(
        &mut self,
        groups: Option<&Vec<(Vec<u16>, Option<T>)>>,
        mut pack: impl FnMut(&mut Self, Option<&T>) -> Result<JsonValue, Fault>,
    ) -> Result<JsonValue, Fault> {
        let Some(groups) = groups else {
            return self.undefined();
        };
        self.account(8)?;
        let mut entries = Vec::with_capacity(groups.len());
        for (name, value) in groups {
            let name = JsonValue::String(LosslessString::from_utf16(name.clone()));
            self.account(stringify_json(&name).len() + 4)?;
            entries.push(JsonValue::Array(vec![name, pack(self, value.as_ref())?]));
        }
        Ok(object([("o", JsonValue::Array(entries))]))
    }

    fn matched(&mut self, matched: &Match) -> Result<JsonValue, Fault> {
        self.begin_array(matched.captures.len())?;
        let items = matched
            .captures
            .iter()
            .map(|value| self.capture(value.as_ref()))
            .collect::<Result<Vec<_>, _>>()?;
        let index = self.scalar(JsonValue::Number(matched.index as f64))?;
        let index = self.property("index", index)?;
        let groups = self.groups(matched.groups.as_ref(), Self::capture)?;
        let groups = self.property("groups", groups)?;
        let mut properties = vec![index, groups];
        if let Some(indices) = &matched.indices {
            self.begin_array(indices.len())?;
            let indices = indices
                .iter()
                .map(|pair| self.pair(*pair))
                .collect::<Result<Vec<_>, _>>()?;
            let groups = self.groups(matched.index_groups.as_ref(), |pack, pair| {
                pack.pair(pair.copied())
            })?;
            let groups = self.property("groups", groups)?;
            let indices = Self::array(indices, vec![groups]);
            properties.push(self.property("indices", indices)?);
        }
        Ok(Self::array(items, properties))
    }

    fn collected(&mut self, matched: &Match) -> Result<JsonValue, Fault> {
        self.begin_array(matched.captures.len() + 1 + usize::from(matched.groups.is_some()))?;
        let mut items = matched
            .captures
            .iter()
            .map(|value| self.capture(value.as_ref()))
            .collect::<Result<Vec<_>, _>>()?;
        items.push(self.scalar(JsonValue::Number(matched.index as f64))?);
        if let Some(groups) = &matched.groups {
            items.push(self.groups(Some(groups), Self::capture)?)
        }
        Ok(Self::array(items, Vec::new()))
    }
}

fn append(output: &mut Vec<u16>, part: &[u16]) -> Result<(), Fault> {
    string_length(output.len().saturating_add(part.len()))?;
    output.extend_from_slice(part);
    Ok(())
}

fn substitute(input: &[u16], matched: &Match, replacement: &[u16]) -> Result<Vec<u16>, Fault> {
    let mut output = Vec::new();
    let mut index = 0;
    while index < replacement.len() {
        let mut part = &replacement[index..index + 1];
        if replacement[index] == 36
            && let Some(next) = replacement.get(index + 1).copied()
        {
            match next {
                36 | 38 | 96 | 39 => {
                    part = match next {
                        36 => &[36],
                        38 => matched.captures[0].as_deref().unwrap_or_default(),
                        96 => &input[..matched.index],
                        _ => {
                            &input
                                [matched.index + matched.captures[0].as_ref().map_or(0, Vec::len)..]
                        }
                    };
                    index += 1;
                }
                60 if matched.groups.is_some() => {
                    if let Some(end) = replacement[index + 2..].iter().position(|unit| *unit == 62)
                    {
                        let end = index + 2 + end;
                        let name = &replacement[index + 2..end];
                        part = matched
                            .groups
                            .as_ref()
                            .and_then(|groups| {
                                groups.iter().find(|(key, _)| key.as_slice() == name)
                            })
                            .and_then(|(_, value)| value.as_deref())
                            .unwrap_or_default();
                        index = end;
                    }
                }
                48..=57 => {
                    let first = usize::from(next - 48);
                    let two = replacement
                        .get(index + 2)
                        .filter(|unit| (48..=57).contains(*unit))
                        .map_or(0, |unit| first * 10 + usize::from(*unit - 48));
                    let number = if two > 0 && two < matched.captures.len() {
                        two
                    } else {
                        first
                    };
                    if number > 0 && number < matched.captures.len() {
                        part = matched.captures[number].as_deref().unwrap_or_default();
                        index += if number == two { 2 } else { 1 };
                    }
                }
                _ => {}
            }
        }
        append(&mut output, part)?;
        index += 1;
    }
    Ok(output)
}

fn operation(request: &JsonValue) -> Result<JsonValue, Fault> {
    let pattern = string(request, "pattern")?;
    let input = string(request, "input")?;
    let flags = string(request, "flags")?;
    let method = string(request, "method")?;
    string_length(pattern.len())?;
    string_length(input.len())?;
    let replacement = match field(request, "replacement") {
        Some(JsonValue::String(value)) => {
            string_length(value.len())?;
            value.code_units().collect::<Vec<_>>()
        }
        None => Vec::new(),
        _ => {
            return Err(Fault {
                name: "TypeError",
                message: "Invalid regex replacement.".into(),
            });
        }
    };
    let mut budget = Budget::unlimited();
    let flags = flags.as_str().ok_or_else(|| Fault {
        name: "SyntaxError",
        message: "Invalid RegExp flags".into(),
    })?;
    let mut re = RegExp::new_with_budget(
        &pattern.code_units().collect::<Vec<_>>(),
        flags,
        &mut budget,
    )?;
    let input = input.code_units().collect::<Vec<_>>();
    let raw_index = field(request, "lastIndex");
    re.last_index = last_index(raw_index);
    let mut pack = Pack::default();
    let method = method.as_str().unwrap_or_default();
    let changes_index = matches!(
        method,
        "exec" | "test" | "match" | "replace" | "replaceAll" | "collect"
    ) && (re.global() || re.sticky());
    let result = match method {
        "exec" => match re.exec(&input, &mut budget)? {
            Some(matched) => pack.matched(&matched)?,
            None => pack.scalar(JsonValue::Null)?,
        },
        "test" => pack.scalar(JsonValue::Bool(re.test(&input, &mut budget)?))?,
        "match" if !re.global() => match re.exec(&input, &mut budget)? {
            Some(matched) => pack.matched(&matched)?,
            None => pack.scalar(JsonValue::Null)?,
        },
        "match" | "matchAll" => {
            if !re.global() {
                return Err(Error::RequiresGlobal.into());
            }
            let mut matcher = re.clone();
            if method == "match" {
                matcher.last_index = 0
            }
            pack.begin_array(0)?;
            let mut items = Vec::new();
            each_match(&mut matcher, &input, true, &mut budget, |matched| {
                let item = if method == "match" {
                    pack.capture(matched.captures[0].as_ref())?
                } else {
                    pack.matched(&matched)?
                };
                pack.append(&mut items, item)
            })?;
            if method == "match" {
                re.last_index = matcher.last_index
            }
            if method == "match" && items.is_empty() {
                pack.scalar(JsonValue::Null)?
            } else {
                Pack::array(items, Vec::new())
            }
        }
        "search" => pack.scalar(JsonValue::Number(
            re.search(&input, &mut budget)?
                .map_or(-1.0, |index| index as f64),
        ))?,
        "split" => {
            let limit = field(request, "limit")
                .map_or(u32::MAX, |value| {
                    let value = number(Some(value));
                    if !value.is_finite() || value == 0.0 {
                        0
                    } else {
                        value.trunc().rem_euclid(4_294_967_296.0) as u32
                    }
                })
                .min((MAX_ARRAY_LENGTH + 1) as u32);
            let parts = re.split(&input, limit, &mut budget)?;
            pack.begin_array(parts.len())?;
            let items = parts
                .iter()
                .map(|part| pack.capture(part.as_ref()))
                .collect::<Result<Vec<_>, _>>()?;
            Pack::array(items, Vec::new())
        }
        "replace" | "replaceAll" | "collect" => {
            if method == "replaceAll" && !re.global() {
                return Err(Fault {
                    name: "TypeError",
                    message: "String.replaceAll requires a global regular expression.".into(),
                });
            }
            let repeated = re.global();
            if repeated {
                re.last_index = 0
            }
            let mut end = 0;
            let mut output = Vec::new();
            let mut items = Vec::new();
            if method == "collect" {
                pack.begin_array(0)?
            }
            each_match(&mut re, &input, repeated, &mut budget, |matched| {
                if method == "collect" {
                    let item = pack.collected(&matched)?;
                    return pack.append(&mut items, item);
                }
                let replacement = substitute(&input, &matched, &replacement)?;
                append(&mut output, &input[end..matched.index])?;
                append(&mut output, &replacement)?;
                end = matched.index + matched.captures[0].as_ref().map_or(0, Vec::len);
                Ok(())
            })?;
            if method == "collect" {
                Pack::array(items, Vec::new())
            } else {
                append(&mut output, &input[end..])?;
                pack.scalar(JsonValue::String(LosslessString::from_utf16(output)))?
            }
        }
        _ => pack.undefined()?,
    };
    let mut reply = JsonObject::new();
    reply.insert("result".into(), result);
    if changes_index {
        reply.insert("lastIndex".into(), JsonValue::Number(re.last_index as f64));
    } else if let Some(index) = raw_index {
        reply.insert("lastIndex".into(), index.clone());
    }
    Ok(JsonValue::Object(reply))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn request(text: &str) -> JsonValue {
        parse_json(text).unwrap()
    }

    fn reply(text: &str) -> JsonValue {
        operation(&request(text)).unwrap_or_else(|error| error.wire())
    }

    #[test]
    fn malformed_json_has_only_real_readiness_and_failure_exit() {
        let mut output = Vec::new();
        assert_eq!(serve(&mut Cursor::new(b"{invalid\n"), &mut output), Ok(1));
        assert_eq!(output, b"{\"ready\":true}\n");
        output.clear();
        assert_eq!(serve(&mut Cursor::new(b"{invalid"), &mut output), Ok(0));
        assert_eq!(output, b"{\"ready\":true}\n");
    }

    #[test]
    fn framing_bounds_allow_exact_line_and_reject_before_unbounded_growth() {
        assert!(
            matches!(next_frame(&mut Cursor::new(b"1234\n"), 4).unwrap(), Frame::Request(bytes) if bytes == b"1234")
        );
        assert!(matches!(
            next_frame(&mut Cursor::new(b"12345\n"), 4).unwrap(),
            Frame::Oversized
        ));
        assert!(matches!(
            next_frame(&mut Cursor::new(b"1234"), 4).unwrap(),
            Frame::End
        ));
    }

    #[test]
    fn state_coercion_preserves_unmodified_raw_values_and_global_numeric_state() {
        assert_eq!(
            reply(r#"{"method":"search","pattern":"a","flags":"g","input":"ba","lastIndex":"7"}"#),
            request(r#"{"result":1,"lastIndex":"7"}"#)
        );
        assert_eq!(
            reply(r#"{"method":"test","pattern":"a","flags":"g","input":"aba","lastIndex":"0x2"}"#),
            request(r#"{"result":true,"lastIndex":3}"#)
        );
        assert_eq!(last_index(Some(&request("[2]"))), 2);
        assert_eq!(last_index(Some(&request("{}"))), 0);
        assert_eq!(last_index(Some(&request("true"))), 1);
        assert_eq!(last_index(Some(&request("-1"))), 0);
        assert_eq!(last_index(Some(&request(r#""inf""#))), 0);
        assert_eq!(
            last_index(Some(&request(r#""Infinity""#))),
            9_007_199_254_740_991
        );
    }

    #[test]
    fn exec_keeps_utf16_captures_named_groups_and_optional_indices() {
        let value = reply(
            r#"{"method":"exec","pattern":"(?<x>a)(b)?","flags":"dg","input":"xa","lastIndex":0}"#,
        );
        assert_eq!(
            value,
            request(
                r#"{"result":{"a":["a","a",{"u":1}],"p":[["index",1],["groups",{"o":[["x","a"]]}],["indices",{"a":[{"a":[1,2],"p":[]},{"a":[1,2],"p":[]},{"u":1}],"p":[["groups",{"o":[["x",{"a":[1,2],"p":[]}]]}]]}]]},"lastIndex":2}"#
            )
        );
        let value =
            reply(r#"{"method":"exec","pattern":".","flags":"","input":"\ud800","lastIndex":0}"#);
        assert!(stringify_json(&value).contains("\\ud800"));
    }

    #[test]
    fn replacement_tokens_and_empty_unicode_matches_use_native_utf16_offsets() {
        assert_eq!(
            reply(
                r#"{"method":"replace","pattern":"(?<x>a)","flags":"","input":"ba","lastIndex":0,"replacement":"$<x>-$`-$'-$&-$$"}"#
            ),
            request(r#"{"result":"ba-b--a-$","lastIndex":0}"#)
        );
        assert_eq!(
            reply(
                r#"{"method":"replace","pattern":"(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)","flags":"","input":"abcdefghijkl","lastIndex":0,"replacement":"$12:$01"}"#
            ),
            request(r#"{"result":"l:a","lastIndex":0}"#)
        );
        assert_eq!(
            reply(
                r#"{"method":"replace","pattern":"(a)","flags":"","input":"a","lastIndex":0,"replacement":"$10|$01|$0|$00|$09|$99"}"#
            ),
            request(r#"{"result":"a0|a|$0|$00|$09|$99","lastIndex":0}"#)
        );
        assert_eq!(
            reply(
                r#"{"method":"replace","pattern":"(a)","flags":"","input":"a","lastIndex":0,"replacement":"$1９|$1٩|$１|$١"}"#
            ),
            request(r#"{"result":"a９|a٩|$１|$١","lastIndex":0}"#)
        );
        assert_eq!(
            reply(r#"{"method":"match","pattern":"(?:)","flags":"gu","input":"😀","lastIndex":7}"#),
            request(r#"{"result":{"a":["",""],"p":[]},"lastIndex":0}"#)
        );
    }

    #[test]
    fn operation_faults_are_framed_without_a_success_result() {
        let syntax =
            reply(r#"{"method":"test","pattern":"(","flags":"","input":"a","lastIndex":0}"#);
        assert_eq!(
            field(field(&syntax, "error").unwrap(), "name"),
            Some(&JsonValue::String("SyntaxError".into()))
        );
        assert!(field(&syntax, "result").is_none());
        let global = reply(
            r#"{"method":"replaceAll","pattern":"a","flags":"","input":"a","lastIndex":0,"replacement":"x"}"#,
        );
        assert_eq!(
            field(field(&global, "error").unwrap(), "name"),
            Some(&JsonValue::String("TypeError".into()))
        );
        assert_eq!(
            reply(r#"{"method":"unknown","pattern":"a","flags":"","input":"a","lastIndex":0}"#),
            request(r#"{"result":{"u":1},"lastIndex":0}"#)
        );
    }

    #[test]
    fn response_string_array_and_byte_limits_fail_without_large_allocations() {
        assert!(string_length(MAX_STRING_LENGTH).is_ok());
        assert!(string_length(MAX_STRING_LENGTH + 1).is_err());
        assert!(Pack::default().begin_array(MAX_ARRAY_LENGTH + 1).is_err());
        let mut pack = Pack {
            bytes: MAX_FRAME_BYTES - 128,
        };
        assert!(pack.account(1).is_err());
    }

    #[test]
    fn unrelated_server_arguments_never_enter_the_private_worker() {
        assert!(run(&["serve".into(), "--stdio".into()]).is_none());
        assert!(matches!(run(&["-e".into()]), Some(Err(_))));
        assert!(matches!(run(&[MARKER.into()]), Some(Err(_))));
    }
}
