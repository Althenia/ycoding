use crate::field_constraints::{Constraints, validate_constraints};
use crate::{CONTRACT_DIGEST, v5};
use prost::Message;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError(pub &'static str);
impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for WireError {}
struct FieldRule {
    tag: i32,
    kind: i32,
    required: bool,
    repeated: bool,
    target: &'static str,
    group: Option<i32>,
    max_count: Option<usize>,
    max_codepoints: Option<usize>,
    text_policy: usize,
    constraints: Option<Constraints>,
}
struct MessageRule {
    name: &'static str,
    oneofs: usize,
    fields: &'static [FieldRule],
}
include!(concat!(env!("OUT_DIR"), "/rules.rs"));

#[derive(Default)]
struct Field<'a> {
    integer: u64,
    bytes: &'a [u8],
    message: Option<Box<Node<'a>>>,
}
struct Node<'a> {
    name: &'static str,
    fields: BTreeMap<i32, Vec<Field<'a>>>,
}
impl<'a> Node<'a> {
    fn field(&self, tag: i32) -> Result<&Field<'a>, WireError> {
        self.fields
            .get(&tag)
            .and_then(|fields| fields.first())
            .ok_or(WireError("required presence"))
    }
    fn child(&self, tag: i32) -> Result<&Node<'a>, WireError> {
        self.field(tag)?
            .message
            .as_deref()
            .ok_or(WireError("message field"))
    }
    fn integer(&self, tag: i32) -> Result<u64, WireError> {
        Ok(self.field(tag)?.integer)
    }
    fn raw(&self, tag: i32) -> Result<&'a [u8], WireError> {
        Ok(self.field(tag)?.bytes)
    }
    fn text(&self, tag: i32) -> Result<&'a str, WireError> {
        std::str::from_utf8(self.raw(tag)?).map_err(|_| WireError("UTF-8"))
    }
}

fn varint(bytes: &[u8], offset: &mut usize) -> Result<u64, WireError> {
    let mut value = 0;
    for index in 0..10 {
        let byte = *bytes.get(*offset).ok_or(WireError("truncated varint"))?;
        *offset += 1;
        if index == 9 && byte > 1 {
            return Err(WireError("varint overflow"));
        }
        value |= u64::from(byte & 127) << (index * 7);
        if byte & 128 == 0 {
            return Ok(value);
        }
    }
    Err(WireError("varint overflow"))
}

pub fn validate_binary(name: &str, bytes: &[u8]) -> Result<(), WireError> {
    scan_root(name, bytes).map(|_| ())
}

fn scan_root<'a>(name: &str, bytes: &'a [u8]) -> Result<Node<'a>, WireError> {
    if bytes.len() > limits::BULK_MESSAGE_BYTES as usize {
        return Err(WireError("byte limit"));
    }
    scan(
        name,
        bytes,
        &mut 0,
        0,
        0,
        if name == "ycoding.v5.Frame" {
            bytes.len()
        } else {
            0
        },
        None,
    )
}

fn scan<'a>(
    name: &str,
    bytes: &'a [u8],
    work: &mut usize,
    depth: usize,
    value_depth: usize,
    frame_bytes: usize,
    collection_limit: Option<usize>,
) -> Result<Node<'a>, WireError> {
    let rule = MESSAGES
        .iter()
        .find(|rule| rule.name == name)
        .ok_or(WireError("unknown message type"))?;
    let values = value_depth + usize::from(name == "ycoding.v5.Value");
    if values > limits::VALUE_DEPTH as usize || depth > limits::VALUE_DEPTH as usize * 3 + 8 {
        return Err(WireError("depth limit"));
    }
    let mut node = Node {
        name: rule.name,
        fields: BTreeMap::new(),
    };
    let mut groups = BTreeSet::new();
    let mut offset = 0;
    while offset < bytes.len() {
        *work += 1;
        if *work > limits::TOTAL_FIELDS as usize {
            return Err(WireError("field count limit"));
        }
        let key = varint(bytes, &mut offset)?;
        if !(8..=u64::from(u32::MAX)).contains(&key) {
            return Err(WireError("invalid tag"));
        }
        let tag = (key >> 3) as i32;
        if name == "ycoding.v5.Frame"
            && [10, 11].contains(&tag)
            && bytes.len() > limits::HANDSHAKE_BYTES as usize
        {
            return Err(WireError("handshake byte limit"));
        }
        if name == "ycoding.v5.Frame"
            && tag == 14
            && bytes.len() > limits::EVENT_BATCH_BYTES as usize
        {
            return Err(WireError("event batch bounds"));
        }
        if name == "ycoding.v5.Control"
            && tag <= 4
            && frame_bytes > limits::TINY_FRAME_BYTES as usize
        {
            return Err(WireError("tiny byte limit"));
        }
        let field = rule
            .fields
            .iter()
            .find(|field| field.tag == tag)
            .ok_or(WireError("unknown field"))?;
        let max_count = field
            .constraints
            .as_ref()
            .and_then(|rule| rule.count_max)
            .map(|value| value as usize)
            .or(field.max_count)
            .or(if field.repeated && field.tag == 1 {
                collection_limit
            } else {
                None
            });
        if field.repeated
            && max_count.is_some_and(|limit| node.fields.get(&tag).map_or(0, Vec::len) >= limit)
        {
            return Err(WireError("collection limit"));
        }
        if !field.repeated && node.fields.contains_key(&tag) {
            return Err(WireError("duplicate singular"));
        }
        if field.group.is_some_and(|group| !groups.insert(group)) {
            return Err(WireError("duplicate oneof"));
        }
        let wire = key & 7;
        let expected = match field.kind {
            1 => 1,
            9 | 11 | 12 => 2,
            _ => 0,
        };
        if wire != expected {
            return Err(WireError("wire type"));
        }
        let mut value = Field::default();
        if wire == 0 {
            value.integer = varint(bytes, &mut offset)?;
            if field.kind == 8 && value.integer > 1 {
                return Err(WireError("boolean"));
            }
            if field.kind == 13 && value.integer > u64::from(u32::MAX) {
                return Err(WireError("uint32 overflow"));
            }
            if field.kind == 14
                && !ENUMS
                    .iter()
                    .any(|(name, values)| *name == field.target && values.contains(&value.integer))
            {
                return Err(WireError("enum"));
            }
            if let Some(rule) = &field.constraints {
                let integer = match field.kind {
                    3 => value.integer as i64 as i128,
                    5 => value.integer as i32 as i128,
                    _ => value.integer as i128,
                };
                validate_constraints(rule, Some(integer), None, None).map_err(WireError)?;
            }
        }
        if wire == 1 {
            let bytes = bytes
                .get(offset..offset + 8)
                .ok_or(WireError("truncated double"))?;
            if !f64::from_le_bytes(bytes.try_into().map_err(|_| WireError("double"))?).is_finite() {
                return Err(WireError("nonfinite"));
            }
            offset += 8;
        }
        if wire == 2 {
            let length = varint(bytes, &mut offset)?;
            if length > (bytes.len() - offset) as u64 {
                return Err(WireError("truncated length"));
            }
            value.bytes = &bytes[offset..offset + length as usize];
            offset += length as usize;
            if field.kind == 9 {
                std::str::from_utf8(value.bytes).map_err(|_| WireError("UTF-8"))?;
            }
            if field.kind == 11 {
                value.message = Some(Box::new(scan(
                    field.target,
                    value.bytes,
                    work,
                    depth + 1,
                    values,
                    frame_bytes,
                    if field.repeated {
                        None
                    } else {
                        field.max_count
                    },
                )?));
            }
            if let (Some(title), Some(limit)) = (value.message.as_deref(), field.max_codepoints) {
                validate_title(&units(title)?, limit, field.text_policy)?;
            }
            if let Some(rule) = &field.constraints {
                let text = if field.kind == 9 {
                    Some(
                        std::str::from_utf8(value.bytes)
                            .map_err(|_| WireError("UTF-8"))?
                            .encode_utf16()
                            .collect::<Vec<_>>(),
                    )
                } else if field.target == "ycoding.v5.LosslessString" {
                    Some(units(
                        value.message.as_deref().ok_or(WireError("message field"))?,
                    )?)
                } else {
                    None
                };
                validate_constraints(
                    rule,
                    None,
                    text.as_deref(),
                    (field.kind == 12).then_some(value.bytes.len()),
                )
                .map_err(WireError)?;
            }
        }
        node.fields.entry(tag).or_default().push(value);
    }
    if groups.len() != rule.oneofs
        || rule
            .fields
            .iter()
            .any(|field| field.required && !node.fields.contains_key(&field.tag))
    {
        return Err(WireError("required presence"));
    }
    for field in rule.fields {
        if field.repeated
            && let Some(rule) = &field.constraints
        {
            validate_constraints(
                rule,
                None,
                None,
                Some(node.fields.get(&field.tag).map_or(0, Vec::len)),
            )
            .map_err(WireError)?;
        }
    }
    if name == "ycoding.v5.Credit"
        && (node.integer(1)? == v5::LedgerClass::Tiny as u64 || node.integer(2)? == 0)
    {
        return Err(WireError("credit grant"));
    }
    if name == "ycoding.v5.LosslessString" {
        units(&node)?;
    }
    if name == "ycoding.v5.ValueObject" {
        let mut keys = BTreeSet::new();
        for entry in node.fields.get(&1).into_iter().flatten() {
            let key = units(
                entry
                    .message
                    .as_deref()
                    .ok_or(WireError("entry"))?
                    .child(1)?,
            )?;
            if !keys.insert(key) {
                return Err(WireError("duplicate object key"));
            }
        }
    }
    Ok(node)
}

fn has_lone(units: &[u16]) -> bool {
    char::decode_utf16(units.iter().copied()).any(|value| value.is_err())
}

fn validate_title(units: &[u16], limit: usize, policy: usize) -> Result<(), WireError> {
    let whitespace = |unit: u16| matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff);
    if char::decode_utf16(units.iter().copied()).count() > limit || policy & v5::TextPredicate::Nonempty as usize != 0 && units.is_empty() || policy & v5::TextPredicate::TrimStable as usize != 0 && (units.first().is_some_and(|unit| whitespace(*unit)) || units.last().is_some_and(|unit| whitespace(*unit))) || policy & v5::TextPredicate::NoControlsOrBidi as usize != 0 && units.iter().any(|unit| matches!(*unit, 0x0000..=0x001f | 0x007f..=0x009f | 0x202a..=0x202e | 0x2066..=0x2069)) { return Err(WireError("title constraint")); }
    Ok(())
}
fn units(node: &Node<'_>) -> Result<Vec<u16>, WireError> {
    if node.fields.contains_key(&1) {
        return Ok(node.text(1)?.encode_utf16().collect());
    }
    let bytes = node.raw(2)?;
    if !bytes.len().is_multiple_of(2) {
        return Err(WireError("odd UTF-16"));
    }
    let units: Vec<_> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|bytes| u16::from_le_bytes(*bytes))
        .collect();
    if !has_lone(&units) {
        return Err(WireError("noncanonical UTF-16"));
    }
    Ok(units)
}

pub fn encode_lossless(units: &[u16]) -> v5::LosslessString {
    let encoding = match String::from_utf16(units) {
        Ok(value) => v5::lossless_string::Encoding::Utf8(value),
        Err(_) => v5::lossless_string::Encoding::Utf16LeUnits(
            units.iter().flat_map(|unit| unit.to_le_bytes()).collect(),
        ),
    };
    v5::LosslessString {
        encoding: Some(encoding),
    }
}

pub fn decode_lossless(
    value: &v5::LosslessString,
    max_units: usize,
) -> Result<Vec<u16>, WireError> {
    let bytes = value.encode_to_vec();
    let node = scan_root("ycoding.v5.LosslessString", &bytes)?;
    let units = units(&node)?;
    if units.len() > max_units {
        return Err(WireError("string unit limit"));
    }
    Ok(units)
}

pub fn decode_strict<T: Message + Default + prost::Name>(bytes: &[u8]) -> Result<T, WireError> {
    validate_binary(&T::full_name(), bytes)?;
    T::decode(bytes).map_err(|_| WireError("decode"))
}

fn direction(node: &Node<'_>, sender: v5::PeerRole) -> Result<(), WireError> {
    let mut name = String::new();
    for (index, letter) in node
        .name
        .trim_start_matches("ycoding.v5.")
        .chars()
        .enumerate()
    {
        if index > 0 && letter.is_uppercase() {
            name.push('_');
        }
        name.push(letter.to_ascii_uppercase());
    }
    name.push_str("_SENDERS");
    let mask = SENDER_MASKS
        .iter()
        .find(|(key, _)| *key == name)
        .ok_or(WireError("direction"))?
        .1;
    if mask & (1 << (sender as i32 - 1)) == 0 {
        return Err(WireError("direction"));
    }
    Ok(())
}

fn frame_rules<'a, 'b>(
    node: &'b Node<'a>,
    size: usize,
    sender: v5::PeerRole,
) -> Result<(i32, &'b Node<'a>), WireError> {
    if node.integer(1)? != limits::REVISION {
        return Err(WireError("revision"));
    }
    let tag = *node
        .fields
        .keys()
        .find(|tag| **tag >= 10)
        .ok_or(WireError("body"))?;
    let body = node.child(tag)?;
    direction(
        if tag == 15 {
            body.child(*body.fields.keys().next().ok_or(WireError("control"))?)?
        } else {
            body
        },
        sender,
    )?;
    if tag == 10 || tag == 11 {
        if size > limits::HANDSHAKE_BYTES as usize {
            return Err(WireError("handshake byte limit"));
        }
        if [3, 4, 5].iter().any(|tag| node.fields.contains_key(tag)) {
            return Err(WireError("handshake ledger"));
        }
        let digest = body
            .raw(2)?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if body.integer(1)? != limits::REVISION
            || digest != CONTRACT_DIGEST
            || body.integer(3)? != sender as u64
        {
            return Err(WireError("handshake identity"));
        }
        let windows = body.child(4)?;
        for (tag, limit) in [
            (1, limits::NORMAL_WINDOW_BYTES),
            (2, limits::EVENT_WINDOW_BYTES),
            (3, limits::BULK_WINDOW_BYTES),
        ] {
            if !(1..=limit).contains(&windows.integer(tag)?) {
                return Err(WireError("window limit"));
            }
        }
        if tag == 10 && node.fields.contains_key(&2) {
            return Err(WireError("Hello epoch"));
        }
        if tag == 11
            && (body.text(5)?.is_empty()
                || body.text(6)?.is_empty()
                || node.text(2)? != body.text(6)?)
        {
            return Err(WireError("Ready epoch"));
        }
        return Ok((tag, body));
    }
    let tiny = tag == 15 && body.fields.keys().next().is_some_and(|tag| *tag <= 4);
    let ledger = if tiny {
        v5::LedgerClass::Tiny
    } else if tag == 14 || tag == 19 {
        v5::LedgerClass::Event
    } else if tag == 17 {
        v5::LedgerClass::Bulk
    } else {
        v5::LedgerClass::Normal
    };
    if node.integer(3)? != ledger as u64 || node.integer(4)? < 1 {
        return Err(WireError("ledger header"));
    }
    if tiny && size > limits::TINY_FRAME_BYTES as usize {
        return Err(WireError("tiny byte limit"));
    }
    if tag == 12
        && (body.text(1)?.is_empty()
            || body.integer(2)? == 0
            || body.raw(4)?.len() > limits::INLINE_BODY_BYTES as usize)
    {
        return Err(WireError("request bounds"));
    }
    if tag == 13 {
        let payload = body.child(if body.fields.contains_key(&4) { 4 } else { 5 })?;
        if body.text(1)?.is_empty()
            || body.integer(2)? == 0
            || payload.text(1)?.is_empty()
            || payload.raw(2)?.len() > limits::INLINE_BODY_BYTES as usize
        {
            return Err(WireError("result bounds"));
        }
    }
    if tag == 14
        && (size > limits::EVENT_BATCH_BYTES as usize
            || body.fields.get(&4).map_or(0, Vec::len) > limits::EVENT_BATCH_COUNT as usize
            || !body
                .child(2)?
                .fields
                .keys()
                .next()
                .is_some_and(|tag| *tag == 3 || *tag == 6))
    {
        return Err(WireError("event batch bounds"));
    }
    if tag == 16
        && (body.integer(6)? > limits::BULK_MESSAGE_BYTES
            || !(1..=limits::BULK_PIECES).contains(&body.integer(7)?))
    {
        return Err(WireError("bulk announcement bounds"));
    }
    if tag == 17
        && (body.raw(4)?.len() > limits::BULK_PIECE_BYTES as usize
            || body.integer(2)? >= limits::BULK_PIECES
            || body
                .integer(3)?
                .checked_add(body.raw(4)?.len() as u64)
                .is_none_or(|end| end > limits::BULK_MESSAGE_BYTES))
    {
        return Err(WireError("bulk piece bounds"));
    }
    if tag == 18 && body.integer(2)? > limits::BULK_MESSAGE_BYTES {
        return Err(WireError("bulk end bounds"));
    }
    if tag == 19 && body.text(1)?.is_empty() {
        return Err(WireError("stream end subscription"));
    }
    Ok((tag, body))
}

#[derive(Default)]
enum Phase {
    #[default]
    Hello,
    Ready,
    Confirm,
    Established,
}
pub struct WireConnection {
    phase: Phase,
    epoch: String,
    initiator: Option<v5::PeerRole>,
    deadline: Option<u64>,
    client_role: v5::PeerRole,
    server_role: v5::PeerRole,
}
impl Default for WireConnection {
    fn default() -> Self {
        Self {
            phase: Phase::Hello,
            epoch: String::new(),
            initiator: None,
            deadline: None,
            client_role: v5::PeerRole::LocalClient,
            server_role: v5::PeerRole::Server,
        }
    }
}
impl WireConnection {
    pub fn new(client_role: v5::PeerRole, server_role: v5::PeerRole) -> Result<Self, WireError> {
        if !(client_role == v5::PeerRole::LocalClient && server_role == v5::PeerRole::Server
            || matches!(
                client_role,
                v5::PeerRole::RemoteClient | v5::PeerRole::Agent
            ) && server_role == v5::PeerRole::Relay)
        {
            return Err(WireError("peer roles"));
        }
        Ok(Self {
            client_role,
            server_role,
            ..Self::default()
        })
    }
    pub fn observe(
        &mut self,
        bytes: &[u8],
        sender: v5::PeerRole,
        now_ms: u64,
    ) -> Result<v5::Frame, WireError> {
        if self.deadline.is_some_and(|deadline| now_ms >= deadline) {
            return Err(WireError("handshake timeout"));
        }
        if sender != self.client_role && sender != self.server_role {
            return Err(WireError("authenticated peer role"));
        }
        let receiver = if sender == self.client_role {
            self.server_role
        } else {
            self.client_role
        };
        let cap = if sender == v5::PeerRole::Agent
            || matches!(
                receiver,
                v5::PeerRole::LocalClient | v5::PeerRole::RemoteClient
            ) {
            limits::SERVER_FRAME_BYTES
        } else {
            limits::CLIENT_FRAME_BYTES
        };
        if bytes.len() > cap as usize {
            return Err(WireError("frame byte limit"));
        }
        if matches!(self.phase, Phase::Hello | Phase::Ready)
            && bytes.len() > limits::HANDSHAKE_BYTES as usize
        {
            return Err(WireError("handshake byte limit"));
        }
        let node = scan_root("ycoding.v5.Frame", bytes)?;
        let (tag, body) = frame_rules(&node, bytes.len(), sender)?;
        if matches!(self.phase, Phase::Hello) && tag != 10
            || matches!(self.phase, Phase::Ready) && tag != 11
            || matches!(self.phase, Phase::Confirm | Phase::Established) && tag < 12
        {
            return Err(WireError("handshake order"));
        }
        if matches!(self.phase, Phase::Confirm)
            && (self.initiator != Some(sender)
                || !(tag == 12 || tag == 15 && body.fields.contains_key(&1)))
        {
            return Err(WireError("Ready confirmation"));
        }
        if tag >= 12 && node.text(2)? != self.epoch {
            return Err(WireError("connection epoch"));
        }
        let frame = v5::Frame::decode(bytes).map_err(|_| WireError("decode"))?;
        if tag == 10 {
            self.phase = Phase::Ready;
            self.initiator = Some(sender);
            self.deadline = Some(now_ms.saturating_add(limits::HANDSHAKE_TIMEOUT_MS));
        }
        if tag == 11 {
            self.phase = Phase::Confirm;
            self.epoch = body.text(6)?.to_owned();
            self.deadline = Some(now_ms.saturating_add(limits::HANDSHAKE_TIMEOUT_MS));
        }
        if tag >= 12 {
            self.phase = Phase::Established;
            self.deadline = None;
        }
        Ok(frame)
    }
}
