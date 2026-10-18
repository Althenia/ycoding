use crate::{decode_lossless, encode_lossless, limits, validate_binary};
use prost::Message as _;

include!(concat!(env!("OUT_DIR"), "/domain_metadata.rs"));

#[derive(Clone, Debug, PartialEq)]
pub enum Domain {
    Null,
    Bool(bool),
    Number(f64),
    Text(Vec<u16>),
    Bytes(Vec<u8>),
    List(Vec<Domain>),
    Object(Vec<(Vec<u16>, Domain)>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);

pub struct Message {
    pub name: &'static str,
    pub oneofs: &'static [&'static str],
    pub fields: &'static [Field],
}

pub struct Field {
    pub name: &'static str,
    pub tag: u32,
    pub kind: u32,
    pub required: bool,
    pub repeated: bool,
    pub target: &'static str,
    pub oneof: Option<u32>,
    pub literal: Option<&'static str>,
}

pub struct Enumeration {
    pub name: &'static str,
    pub values: &'static [Value],
}

pub struct Value {
    pub number: u64,
    pub name: &'static str,
    pub label: Option<&'static str>,
}

const LOSSLESS: &str = "ycoding.v5.LosslessString";
const OPEN: &str = "ycoding.v5.Value";
const DEPTH: usize = 200;
const SAFE: f64 = 9_007_199_254_740_991.0;

pub fn message(name: &str) -> Option<&'static Message> {
    MESSAGES
        .binary_search_by(|message| message.name.cmp(name))
        .ok()
        .map(|index| &MESSAGES[index])
}

pub fn enumeration(name: &str) -> Option<&'static Enumeration> {
    ENUMERATIONS
        .binary_search_by(|item| item.name.cmp(name))
        .ok()
        .map(|index| &ENUMERATIONS[index])
}

impl Enumeration {
    pub fn text(&self, value: &Value) -> &'static str {
        value.label.unwrap_or(value.name)
    }

    fn labelled(&self) -> bool {
        self.values.iter().any(|value| value.label.is_some())
    }
}

pub fn encode(name: &str, value: &Domain, max_bytes: usize) -> Result<Vec<u8>, Error> {
    let mut budget = Budget {
        maximum: max_bytes,
        bytes: 0,
        fields: 0,
    };
    let bytes = encode_message(name, value, 0, &mut budget)?;
    if bytes.len() > max_bytes {
        return Err(Error("encoded domain byte limit"));
    }
    validate_binary(name, &bytes).map_err(|error| Error(error.0))?;
    Ok(bytes)
}

pub fn decode(name: &str, bytes: &[u8]) -> Result<Domain, Error> {
    validate_binary(name, bytes).map_err(|error| Error(error.0))?;
    decode_message(name, bytes, 0)?.ok_or(Error("empty domain union"))
}

#[derive(Clone, Copy)]
struct Budget {
    maximum: usize,
    bytes: usize,
    fields: usize,
}

impl Budget {
    fn charge(&mut self, bytes: usize) -> Result<(), Error> {
        if bytes > self.maximum - self.bytes.min(self.maximum) {
            return Err(Error("domain byte limit"));
        }
        self.bytes += bytes;
        Ok(())
    }

    fn field(&mut self) -> Result<(), Error> {
        self.fields += 1;
        if self.fields > limits::TOTAL_FIELDS as usize {
            return Err(Error("domain field limit"));
        }
        Ok(())
    }
}

fn encode_message(
    name: &str,
    value: &Domain,
    depth: usize,
    budget: &mut Budget,
) -> Result<Vec<u8>, Error> {
    if depth > DEPTH {
        return Err(Error("domain depth limit"));
    }
    if name == LOSSLESS {
        let Domain::Text(units) = value else {
            return Err(Error("expected domain string"));
        };
        budget.charge(units.len() * 2)?;
        budget.field()?;
        return Ok(encode_lossless(units).encode_to_vec());
    }
    let schema = message(name).ok_or(Error("unknown v5 message type"))?;
    if name == OPEN {
        let branch = match value {
            Domain::Null => "null",
            Domain::Bool(_) => "boolean",
            Domain::Number(_) => "number",
            Domain::Text(_) => "string",
            Domain::Bytes(_) => "bytes",
            Domain::List(_) => "list",
            Domain::Object(_) => "object",
        };
        let field = schema
            .fields
            .iter()
            .find(|field| field.name == branch)
            .ok_or(Error("unsupported open value"))?;
        let value = if branch == "null" {
            Domain::Object(vec![])
        } else {
            value.clone()
        };
        let mut output = Vec::new();
        encode_field(field, &value, depth + 1, budget, &mut output)?;
        return Ok(output);
    }
    if let [field] = schema.fields
        && field.repeated
    {
        let mut output = Vec::new();
        if field.name == "entries" && field.kind == 11 {
            let Domain::Object(entries) = value else {
                return Err(Error("expected domain object"));
            };
            for (key, value) in entries {
                let entry = Domain::Object(vec![
                    (units("key"), Domain::Text(key.clone())),
                    (units("value"), value.clone()),
                ]);
                encode_field(field, &entry, depth + 1, budget, &mut output)?;
            }
            return Ok(output);
        }
        let Domain::List(items) = value else {
            return Err(Error("expected domain list"));
        };
        for item in items {
            encode_field(field, item, depth + 1, budget, &mut output)?;
        }
        return Ok(output);
    }
    if schema.oneofs.len() == 1 && schema.fields.iter().all(|field| field.oneof.is_some()) {
        return encode_union(schema, value, depth, budget);
    }
    let Domain::Object(entries) = value else {
        return Err(Error("expected domain object"));
    };
    for (index, (key, _)) in entries.iter().enumerate() {
        if !schema.fields.iter().any(|field| units(field.name) == *key) {
            return Err(Error("unknown domain field"));
        }
        if entries[..index].iter().any(|(other, _)| other == key) {
            return Err(Error("duplicate domain field"));
        }
    }
    let mut output = Vec::new();
    for field in schema.fields {
        let name = units(field.name);
        let Some((_, value)) = entries.iter().find(|(key, _)| *key == name) else {
            if field.required {
                return Err(Error("missing required domain field"));
            }
            continue;
        };
        if field.repeated {
            let Domain::List(items) = value else {
                return Err(Error("expected domain list"));
            };
            for item in items {
                encode_field(field, item, depth + 1, budget, &mut output)?;
            }
            continue;
        }
        encode_field(field, value, depth + 1, budget, &mut output)?;
    }
    Ok(output)
}

fn encode_union(
    schema: &Message,
    value: &Domain,
    depth: usize,
    budget: &mut Budget,
) -> Result<Vec<u8>, Error> {
    for field in schema.fields {
        if field.name == "clear" {
            if *value == Domain::Null {
                let mut output = Vec::new();
                encode_field(
                    field,
                    &Domain::Object(vec![]),
                    depth + 1,
                    budget,
                    &mut output,
                )?;
                return Ok(output);
            }
            continue;
        }
        if let Some(literal) = field.literal
            && literal_value(literal).as_ref() != Some(value)
        {
            continue;
        }
        if field.kind == 11
            && field.target != LOSSLESS
            && field.target != OPEN
            && let (Some(target), Domain::Object(entries)) = (message(field.target), value)
            && target.oneofs.is_empty()
            && entries
                .iter()
                .any(|(key, _)| !target.fields.iter().any(|item| units(item.name) == *key))
        {
            continue;
        }
        let mut attempt = *budget;
        let mut output = Vec::new();
        if encode_field(field, value, depth + 1, &mut attempt, &mut output).is_err()
            || output.len() > budget.maximum
            || validate_binary(schema.name, &output).is_err()
        {
            continue;
        }
        *budget = attempt;
        return Ok(output);
    }
    Err(Error("domain union has no v5 branch"))
}

fn literal_value(literal: &str) -> Option<Domain> {
    match literal {
        "true" => Some(Domain::Bool(true)),
        "false" => Some(Domain::Bool(false)),
        "null" => Some(Domain::Null),
        _ if literal.starts_with('"') && literal.ends_with('"') && literal.len() >= 2 => {
            Some(Domain::Text(units(&literal[1..literal.len() - 1])))
        }
        _ => literal.parse::<f64>().ok().map(Domain::Number),
    }
}

fn encode_field(
    field: &Field,
    value: &Domain,
    depth: usize,
    budget: &mut Budget,
    output: &mut Vec<u8>,
) -> Result<(), Error> {
    budget.field()?;
    let wire = match field.kind {
        1 => 1,
        9 | 11 | 12 => 2,
        _ => 0,
    };
    key(output, field.tag, wire);
    match field.kind {
        11 => {
            let nested = encode_message(field.target, value, depth, budget)?;
            varint(output, nested.len() as u64);
            output.extend(nested);
        }
        14 => {
            let Domain::Text(text) = value else {
                return Err(Error("expected domain enum label"));
            };
            let item = enumeration(field.target).ok_or(Error("unknown v5 enum"))?;
            let labelled = item.labelled();
            let found = item
                .values
                .iter()
                .find(|value| {
                    units(if labelled {
                        value.label.unwrap_or("")
                    } else {
                        value.name
                    }) == *text
                })
                .ok_or(Error("unknown domain enum value"))?;
            varint(output, found.number);
        }
        9 => {
            let Domain::Text(text) = value else {
                return Err(Error("expected domain string"));
            };
            let text = String::from_utf16(text).map_err(|_| Error("expected well-formed text"))?;
            budget.charge(text.len())?;
            varint(output, text.len() as u64);
            output.extend(text.as_bytes());
        }
        12 => {
            let Domain::Bytes(bytes) = value else {
                return Err(Error("expected domain bytes"));
            };
            budget.charge(bytes.len())?;
            varint(output, bytes.len() as u64);
            output.extend(bytes);
        }
        8 => {
            let Domain::Bool(flag) = value else {
                return Err(Error("expected domain boolean"));
            };
            varint(output, u64::from(*flag));
        }
        1 => {
            let Domain::Number(number) = value else {
                return Err(Error("expected domain number"));
            };
            if !number.is_finite() {
                return Err(Error("expected finite number"));
            }
            output.extend(number.to_le_bytes());
        }
        3 | 4 | 5 | 13 => {
            let Domain::Number(number) = value else {
                return Err(Error("expected domain integer"));
            };
            if number.fract() != 0.0 || !(-SAFE..=SAFE).contains(number) {
                return Err(Error("unsafe domain integer"));
            }
            let integer = *number as i64;
            let (minimum, maximum) = match field.kind {
                4 => (0, i64::MAX),
                5 => (i64::from(i32::MIN), i64::from(i32::MAX)),
                13 => (0, i64::from(u32::MAX)),
                _ => (i64::MIN, i64::MAX),
            };
            if !(minimum..=maximum).contains(&integer) {
                return Err(Error("domain integer range"));
            }
            varint(output, integer as u64);
        }
        _ => return Err(Error("unsupported v5 field")),
    }
    Ok(())
}

fn key(output: &mut Vec<u8>, tag: u32, wire: u64) {
    varint(output, (u64::from(tag) << 3) | wire);
}

fn varint(output: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        output.push((value as u8) | 0x80);
        value >>= 7;
    }
    output.push(value as u8);
}

fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

struct Raw<'a> {
    tag: u32,
    integer: u64,
    bytes: &'a [u8],
}

fn raw(mut bytes: &[u8]) -> Result<Vec<Raw<'_>>, Error> {
    let mut fields = Vec::new();
    while !bytes.is_empty() {
        let key = read_varint(&mut bytes)?;
        let tag = u32::try_from(key >> 3).map_err(|_| Error("invalid tag"))?;
        match key & 7 {
            0 => fields.push(Raw {
                tag,
                integer: read_varint(&mut bytes)?,
                bytes: &[],
            }),
            1 => {
                let (value, rest) = bytes.split_at_checked(8).ok_or(Error("truncated double"))?;
                fields.push(Raw {
                    tag,
                    integer: 0,
                    bytes: value,
                });
                bytes = rest;
            }
            2 => {
                let length = read_varint(&mut bytes)? as usize;
                let (value, rest) = bytes
                    .split_at_checked(length)
                    .ok_or(Error("truncated length"))?;
                fields.push(Raw {
                    tag,
                    integer: 0,
                    bytes: value,
                });
                bytes = rest;
            }
            _ => return Err(Error("wire type")),
        }
    }
    Ok(fields)
}

fn read_varint(bytes: &mut &[u8]) -> Result<u64, Error> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let (&byte, rest) = bytes.split_first().ok_or(Error("truncated varint"))?;
        *bytes = rest;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(Error("overlong varint"))
}

fn decode_message(name: &str, bytes: &[u8], depth: usize) -> Result<Option<Domain>, Error> {
    if depth > DEPTH {
        return Err(Error("domain depth limit"));
    }
    if name == LOSSLESS {
        let value = crate::v5::LosslessString::decode(bytes).map_err(|_| Error("decode"))?;
        let units = decode_lossless(&value, usize::MAX).map_err(|error| Error(error.0))?;
        return Ok(Some(Domain::Text(units)));
    }
    let schema = message(name).ok_or(Error("unknown v5 message type"))?;
    let fields = raw(bytes)?;
    if name == OPEN {
        let Some(item) = fields.first() else {
            return Err(Error("missing open value branch"));
        };
        let field = schema
            .fields
            .iter()
            .find(|field| field.tag == item.tag)
            .ok_or(Error("unknown field"))?;
        if field.name == "null" {
            return Ok(Some(Domain::Null));
        }
        return decode_field(field, item, depth + 1).map(Some);
    }
    if let [field] = schema.fields
        && field.repeated
    {
        let items = fields
            .iter()
            .filter(|item| item.tag == field.tag)
            .map(|item| decode_field(field, item, depth + 1))
            .collect::<Result<Vec<_>, _>>()?;
        if field.name == "entries" && field.kind == 11 {
            let mut entries = Vec::new();
            for item in items {
                let Domain::Object(entry) = item else {
                    return Err(Error("expected domain entry"));
                };
                let key = entry
                    .iter()
                    .find(|(name, _)| *name == units("key"))
                    .and_then(|(_, value)| match value {
                        Domain::Text(key) => Some(key.clone()),
                        _ => None,
                    })
                    .ok_or(Error("expected domain entry key"))?;
                let value = entry
                    .into_iter()
                    .find(|(name, _)| *name == units("value"))
                    .map(|(_, value)| value)
                    .ok_or(Error("expected domain entry value"))?;
                if entries.iter().any(|(other, _)| *other == key) {
                    return Err(Error("duplicate domain object key"));
                }
                entries.push((key, value));
            }
            return Ok(Some(Domain::Object(entries)));
        }
        return Ok(Some(Domain::List(items)));
    }
    if schema.oneofs.len() == 1 && schema.fields.iter().all(|field| field.oneof.is_some()) {
        let Some(item) = fields.first() else {
            return Ok(None);
        };
        let field = schema
            .fields
            .iter()
            .find(|field| field.tag == item.tag)
            .ok_or(Error("unknown field"))?;
        if field.name == "clear" {
            return Ok(Some(Domain::Null));
        }
        return decode_field(field, item, depth + 1).map(Some);
    }
    let mut entries = Vec::new();
    for field in schema.fields {
        let present = fields
            .iter()
            .filter(|item| item.tag == field.tag)
            .collect::<Vec<_>>();
        if field.repeated {
            let items = present
                .into_iter()
                .map(|item| decode_field(field, item, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            entries.push((units(field.name), Domain::List(items)));
            continue;
        }
        let Some(item) = present.first() else {
            continue;
        };
        if field.kind == 11
            && let Some(nested) = decode_message(field.target, item.bytes, depth + 1)?
        {
            entries.push((units(field.name), nested));
            continue;
        }
        if field.kind != 11 {
            entries.push((units(field.name), decode_field(field, item, depth + 1)?));
        }
    }
    Ok(Some(Domain::Object(entries)))
}

fn decode_field(field: &Field, item: &Raw<'_>, depth: usize) -> Result<Domain, Error> {
    match field.kind {
        11 => decode_message(field.target, item.bytes, depth)?.ok_or(Error("empty domain union")),
        14 => {
            let enumeration = enumeration(field.target).ok_or(Error("unknown v5 enum"))?;
            let value = enumeration
                .values
                .iter()
                .find(|value| value.number == item.integer)
                .ok_or(Error("unknown v5 domain enum"))?;
            Ok(Domain::Text(units(enumeration.text(value))))
        }
        9 => Ok(Domain::Text(units(
            std::str::from_utf8(item.bytes).map_err(|_| Error("UTF-8"))?,
        ))),
        12 => Ok(Domain::Bytes(item.bytes.to_vec())),
        8 => Ok(Domain::Bool(item.integer != 0)),
        1 => Ok(Domain::Number(f64::from_le_bytes(
            item.bytes.try_into().map_err(|_| Error("double"))?,
        ))),
        3 | 4 | 5 | 13 => {
            let integer = match field.kind {
                4 | 13 => {
                    if item.integer > SAFE as u64 {
                        return Err(Error("unsafe v5 domain integer"));
                    }
                    item.integer as f64
                }
                5 => f64::from(item.integer as i32),
                _ => {
                    let signed = item.integer as i64;
                    if signed.unsigned_abs() > SAFE as u64 {
                        return Err(Error("unsafe v5 domain integer"));
                    }
                    signed as f64
                }
            };
            Ok(Domain::Number(integer))
        }
        _ => Err(Error("unsupported v5 field")),
    }
}
