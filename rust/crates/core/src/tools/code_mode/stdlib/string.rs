use super::super::evaluator::Vm;
use super::super::program::Position;
use super::super::values::{Fault, Value, uint32};
use ycoding_schema::LosslessString;

pub(crate) fn whitespace(character: char) -> bool {
    matches!(
        character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
fn text(vm: &Vm, args: &[Value], index: usize) -> Result<LosslessString, Fault> {
    vm.state()
        .text(args.get(index).unwrap_or(&Value::Undefined))
}
fn numeric(vm: &Vm, args: &[Value], index: usize, default: f64) -> Result<f64, Fault> {
    match args.get(index) {
        None | Some(Value::Undefined) => Ok(default),
        Some(value) => vm.state().number(value),
    }
}
fn integer(value: f64) -> f64 {
    if value.is_nan() { 0.0 } else { value.trunc() }
}
fn relative(value: f64, length: usize) -> usize {
    let value = integer(value);
    if value < 0.0 {
        (length as f64 + value).clamp(0.0, length as f64) as usize
    } else {
        value.min(length as f64) as usize
    }
}
fn position(value: f64, length: usize) -> usize {
    integer(value).clamp(0.0, length as f64) as usize
}
fn find(input: &[u16], needle: &[u16], start: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(start.min(input.len()));
    }
    if needle.len() > input.len().saturating_sub(start) {
        return None;
    }
    (start..=input.len() - needle.len()).find(|index| input[*index..].starts_with(needle))
}

pub(crate) fn static_method(
    _vm: &Vm,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let mut units = Vec::new();
    for value in args {
        let Value::Number(value) = value else {
            return Err(Fault::error(
                "Error",
                format!("String.{name} expects number arguments."),
                location,
            ));
        };
        match name {
            "fromCharCode" => units.push(uint32(value) as u16),
            "fromCodePoint" => {
                if !value.is_finite()
                    || value.fract() != 0.0
                    || !(0.0..=1_114_111.0).contains(&value)
                {
                    return Err(Fault::error("RangeError", "Invalid code point", location));
                }
                if value <= 65535.0 {
                    units.push(value as u16)
                } else {
                    let value = value as u32 - 65536;
                    units.push(0xd800 + (value >> 10) as u16);
                    units.push(0xdc00 + (value & 1023) as u16)
                }
            }
            _ => {
                return Err(Fault::error(
                    "TypeError",
                    "Unknown String static.",
                    location,
                ));
            }
        }
    }
    Ok(Value::String(LosslessString::from_utf16(units)))
}

fn scalar_transform(units: &[u16], transform: impl Fn(&str) -> String) -> LosslessString {
    let mut output = Vec::new();
    let mut start = 0;
    let mut at = 0;
    while at < units.len() {
        let unit = units[at];
        if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(at + 1)
                .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
        {
            at += 2;
            continue;
        }
        if (0xd800..=0xdfff).contains(&unit) {
            let text = String::from_utf16(&units[start..at])
                .expect("A scalar segment has paired surrogate code units");
            output.extend(transform(&text).encode_utf16());
            output.push(unit);
            at += 1;
            start = at;
            continue;
        }
        at += 1;
    }
    let text = String::from_utf16(&units[start..])
        .expect("A scalar segment has paired surrogate code units");
    output.extend(transform(&text).encode_utf16());
    LosslessString::from_utf16(output)
}

pub(crate) async fn method(
    vm: &Vm,
    value: LosslessString,
    name: &str,
    args: Vec<Value>,
    location: &Position,
) -> Result<Value, Fault> {
    let units = value.code_units().collect::<Vec<_>>();
    let length = units.len();
    match name {
        "toString" => Ok(Value::String(value)),
        "toLowerCase" => Ok(Value::String(scalar_transform(&units, str::to_lowercase))),
        "toUpperCase" => Ok(Value::String(scalar_transform(&units, str::to_uppercase))),
        "normalize" => {
            let form=match args.first(){None|Some(Value::Undefined)=>"NFC".into(),Some(value)=>vm.state().text(value)?.to_utf8().map_err(|_|Fault::error("RangeError","String.normalize expects the form \"NFC\", \"NFD\", \"NFKC\", or \"NFKD\".",location))?};
            if !["NFC", "NFD", "NFKC", "NFKD"].contains(&form.as_str()) {
                return Err(Fault::error(
                    "RangeError",
                    format!(
                        "String.normalize expects the form \"NFC\", \"NFD\", \"NFKC\", or \"NFKD\" (got {form:?})."
                    ),
                    location,
                ));
            }
            Ok(Value::String(scalar_transform(&units, |text| {
                match form.as_str() {
                    "NFC" => icu_normalizer::ComposingNormalizerBorrowed::new_nfc()
                        .normalize(text)
                        .into_owned(),
                    "NFD" => icu_normalizer::DecomposingNormalizerBorrowed::new_nfd()
                        .normalize(text)
                        .into_owned(),
                    "NFKC" => icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
                        .normalize(text)
                        .into_owned(),
                    _ => icu_normalizer::DecomposingNormalizerBorrowed::new_nfkd()
                        .normalize(text)
                        .into_owned(),
                }
            })))
        }
        "localeCompare" => {
            let other = text(vm, &args, 0)?.code_units().collect::<Vec<_>>();
            Ok(Value::Number(match (vm.collator)(&units, &other) {
                std::cmp::Ordering::Less => -1.0,
                std::cmp::Ordering::Equal => 0.0,
                std::cmp::Ordering::Greater => 1.0,
            }))
        }
        "trim" | "trimStart" | "trimEnd" => {
            let white = |unit: &u16| char::from_u32(*unit as u32).is_some_and(whitespace);
            let start = if name == "trimEnd" {
                0
            } else {
                units.iter().take_while(|unit| white(unit)).count()
            };
            let end = if name == "trimStart" {
                length
            } else {
                length - units.iter().rev().take_while(|unit| white(unit)).count()
            };
            Ok(Value::String(LosslessString::from_utf16(
                units[start..end.max(start)].to_vec(),
            )))
        }
        "slice" | "substring" => {
            let a = numeric(vm, &args, 0, 0.0)?;
            let b = numeric(vm, &args, 1, length as f64)?;
            let (start, end) = if name == "substring" {
                let a = position(a, length);
                let b = position(b, length);
                (a.min(b), a.max(b))
            } else {
                let a = relative(a, length);
                (a, relative(b, length).max(a))
            };
            Ok(Value::String(LosslessString::from_utf16(
                units[start..end].to_vec(),
            )))
        }
        "at" | "charAt" | "charCodeAt" | "codePointAt" => {
            let mut index = integer(numeric(vm, &args, 0, 0.0)?);
            if name == "at" && index < 0.0 {
                index += length as f64;
            }
            if index < 0.0 || index >= length as f64 {
                return Ok(match name {
                    "charAt" => Value::String("".into()),
                    "charCodeAt" => Value::Number(f64::NAN),
                    _ => Value::Undefined,
                });
            }
            let index = index as usize;
            let unit = units[index];
            Ok(match name {
                "charCodeAt" => Value::Number(unit as f64),
                "codePointAt" => {
                    let point = if (0xd800..=0xdbff).contains(&unit)
                        && units
                            .get(index + 1)
                            .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
                    {
                        0x10000
                            + ((unit as u32 - 0xd800) << 10)
                            + (units[index + 1] as u32 - 0xdc00)
                    } else {
                        unit as u32
                    };
                    Value::Number(point as f64)
                }
                _ => Value::String(LosslessString::from_utf16(vec![unit])),
            })
        }
        "includes" | "startsWith" | "endsWith" | "indexOf" | "lastIndexOf" => {
            if ["includes", "startsWith", "endsWith"].contains(&name)
                && matches!(args.first(), Some(Value::RegExp(_)))
            {
                return Err(Fault::error(
                    "TypeError",
                    format!(
                        "String.{name} cannot take a regular expression; use regex.test(string) or String.search instead."
                    ),
                    location,
                ));
            }
            let needle = text(vm, &args, 0)?.code_units().collect::<Vec<_>>();
            let from = numeric(
                vm,
                &args,
                1,
                if ["endsWith", "lastIndexOf"].contains(&name) {
                    length as f64
                } else {
                    0.0
                },
            )?;
            let at = position(
                if name == "lastIndexOf" && from.is_nan() {
                    length as f64
                } else {
                    from
                },
                length,
            );
            let found = if name == "lastIndexOf" {
                if needle.is_empty() {
                    Some(at)
                } else if needle.len() > length {
                    None
                } else {
                    (0..=at.min(length - needle.len()))
                        .rev()
                        .find(|index| units[*index..].starts_with(&needle))
                }
            } else {
                find(&units, &needle, at)
            };
            Ok(match name {
                "includes" => Value::Boolean(found.is_some()),
                "startsWith" => Value::Boolean(units[at..].starts_with(&needle)),
                "endsWith" => Value::Boolean(units[..at].ends_with(&needle)),
                _ => Value::Number(found.map_or(-1.0, |index| index as f64)),
            })
        }
        "concat" => {
            let mut output = units;
            for value in args {
                output.extend(vm.state().text(&value)?.code_units());
            }
            Ok(Value::String(LosslessString::from_utf16(output)))
        }
        "repeat" => {
            let count = numeric(vm, &args, 0, 0.0)?;
            if !count.is_finite() || count < 0.0 {
                return Err(Fault::error(
                    "RangeError",
                    "String.repeat expects a finite non-negative count.",
                    location,
                ));
            }
            let count = count.trunc() as usize;
            if length == 0 || count == 0 {
                return Ok(Value::String("".into()));
            }
            let total = length
                .checked_mul(count)
                .ok_or_else(|| Fault::error("RangeError", "Invalid string length", location))?;
            let mut output = Vec::new();
            output
                .try_reserve(total)
                .map_err(|_| Fault::error("RangeError", "Invalid string length", location))?;
            for _ in 0..count {
                vm.checkpoint(location)?;
                output.extend_from_slice(&units);
            }
            Ok(Value::String(LosslessString::from_utf16(output)))
        }
        "padStart" | "padEnd" => {
            let target =
                integer(numeric(vm, &args, 0, 0.0)?).clamp(0.0, 9_007_199_254_740_991.0) as usize;
            let filler = match args.get(1) {
                None | Some(Value::Undefined) => " ".into(),
                Some(value) => vm.state().text(value)?,
            };
            let filler = filler.code_units().collect::<Vec<_>>();
            if target <= length || filler.is_empty() {
                return Ok(Value::String(value));
            }
            let count = target - length;
            let mut output = Vec::new();
            output
                .try_reserve(target)
                .map_err(|_| Fault::error("RangeError", "Invalid string length", location))?;
            if name == "padEnd" {
                output.extend_from_slice(&units)
            }
            output.extend((0..count).map(|index| filler[index % filler.len()]));
            if name == "padStart" {
                output.extend_from_slice(&units)
            }
            Ok(Value::String(LosslessString::from_utf16(output)))
        }
        "split" => {
            let limit = match args.get(1) {
                None | Some(Value::Undefined) => u32::MAX,
                Some(value) => uint32(vm.state().number(value)?),
            } as usize;
            if limit == 0 {
                return Ok(vm.state().array(Vec::new()));
            }
            if matches!(args.first(), None | Some(Value::Undefined)) {
                return Ok(vm.state().array(vec![Value::String(value)]));
            }
            if matches!(args.first(), Some(Value::RegExp(_))) {
                return super::super::regexp::split(
                    vm,
                    value,
                    args[0].clone(),
                    limit as u32,
                    location,
                );
            }
            let separator = text(vm, &args, 0)?.code_units().collect::<Vec<_>>();
            let mut values = Vec::new();
            if separator.is_empty() {
                values.extend(
                    units
                        .iter()
                        .take(limit)
                        .map(|unit| Value::String(LosslessString::from_utf16(vec![*unit]))),
                );
            } else {
                let mut start = 0;
                while let Some(at) = find(&units, &separator, start) {
                    values.push(Value::String(LosslessString::from_utf16(
                        units[start..at].to_vec(),
                    )));
                    if values.len() == limit {
                        return Ok(vm.state().array(values));
                    }
                    start = at + separator.len();
                }
                values.push(Value::String(LosslessString::from_utf16(
                    units[start..].to_vec(),
                )));
                values.truncate(limit);
            }
            Ok(vm.state().array(values))
        }
        "replace" | "replaceAll" => {
            super::super::regexp::replace(vm, value, name, args, location).await
        }
        "match" | "matchAll" | "search" => {
            super::super::regexp::string(vm, value, name, args, location)
        }
        _ => Err(Fault::error(
            "TypeError",
            format!("String method '{name}' is not available in CodeMode."),
            location,
        )),
    }
}

pub(crate) fn uri(vm: &Vm, name: &str, value: Value, location: &Position) -> Result<Value, Fault> {
    let text = vm.state().text(&value)?;
    let text = text.to_utf8().map_err(|_| {
        Fault::error(
            "URIError",
            format!("{name} received malformed URI data"),
            location,
        )
    })?;
    let reserved = ";/?:@&=+$,#";
    if name.starts_with("encode") {
        let mut output = String::new();
        for byte in text.bytes() {
            if byte.is_ascii_alphanumeric()
                || b"-_.!~*'()".contains(&byte)
                || (name == "encodeURI" && reserved.as_bytes().contains(&byte))
            {
                output.push(byte as char)
            } else {
                output.push_str(&format!("%{byte:02X}"));
            }
        }
        return Ok(Value::String(output.into()));
    }
    let bytes = text.as_bytes();
    let mut output = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'%' {
            output.push(bytes[at]);
            at += 1;
            continue;
        }
        let first = at;
        let byte = percent(bytes, at).ok_or_else(|| {
            Fault::error(
                "URIError",
                format!("{name} received malformed URI data"),
                location,
            )
        })?;
        if name == "decodeURI" && reserved.as_bytes().contains(&byte) {
            output.extend_from_slice(&bytes[at..at + 3]);
            at += 3;
            continue;
        }
        let count = if byte < 128 {
            1
        } else if (0xc2..=0xdf).contains(&byte) {
            2
        } else if (0xe0..=0xef).contains(&byte) {
            3
        } else if (0xf0..=0xf4).contains(&byte) {
            4
        } else {
            return Err(Fault::error(
                "URIError",
                format!("{name} received malformed URI data"),
                location,
            ));
        };
        let mut sequence = vec![byte];
        at += 3;
        for _ in 1..count {
            sequence.push(percent(bytes, at).ok_or_else(|| {
                Fault::error(
                    "URIError",
                    format!("{name} received malformed URI data"),
                    location,
                )
            })?);
            at += 3;
        }
        if std::str::from_utf8(&sequence).is_err() {
            return Err(Fault::error(
                "URIError",
                format!("{name} received malformed URI data at {first}"),
                location,
            ));
        }
        output.extend(sequence);
    }
    let text = String::from_utf8(output).map_err(|_| {
        Fault::error(
            "URIError",
            format!("{name} received malformed URI data"),
            location,
        )
    })?;
    Ok(Value::String(text.into()))
}

fn percent(bytes: &[u8], at: usize) -> Option<u8> {
    if bytes.get(at) != Some(&b'%') {
        return None;
    }
    let a = (*bytes.get(at + 1)? as char).to_digit(16)?;
    let b = (*bytes.get(at + 2)? as char).to_digit(16)?;
    Some((a * 16 + b) as u8)
}
