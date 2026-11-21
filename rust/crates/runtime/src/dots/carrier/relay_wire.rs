use std::collections::BTreeMap;
use ycoding_core::dots::access;

pub const FRAME_VERSION: u32 = 1;
pub const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 256 * 1024;
pub const MAX_JSONRPC_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub const RECORD_PLAINTEXT_BYTES: usize = 60 * 1024;
pub const MAX_CIPHERTEXT_BYTES: usize = 65535;
pub const MAX_REORDER_DISTANCE: u32 = 64;
pub const MAX_PENDING_BYTES: usize = 1024 * 1024;
pub const RESET_REASON: &str = "noise_relay_protocol_error";

#[derive(Debug, Eq, PartialEq)]
pub struct Invalid;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Body {
    Data {
        seq: u32,
        segment_index: u32,
        segment_count: u32,
        payload: Vec<u8>,
    },
    Ack,
    Resume {
        next_seq: u32,
    },
    Reset {
        reason: String,
    },
    Heartbeat,
    Handshake {
        payload: Vec<u8>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    pub version: u32,
    pub stream_id: String,
    pub ack: Option<u32>,
    pub ack_bits: Option<u32>,
    pub body: Body,
    pub traceparent: Option<String>,
    pub tracestate: Option<String>,
}

impl Frame {
    pub fn new(stream_id: &str, body: Body) -> Self {
        Self {
            version: FRAME_VERSION,
            stream_id: stream_id.to_owned(),
            ack: None,
            ack_bits: None,
            body,
            traceparent: None,
            tracestate: None,
        }
    }
}

fn varint(output: &mut Vec<u8>, value: u32) {
    let mut value = value;
    while value > 0x7f {
        output.push((value & 0x7f) as u8 | 0x80);
        value >>= 7;
    }
    output.push((value & 0x7f) as u8);
}

fn field(output: &mut Vec<u8>, number: u32, wire: u32) {
    varint(output, (number << 3) | wire);
}

fn length_delimited(output: &mut Vec<u8>, number: u32, data: &[u8]) {
    field(output, number, 2);
    varint(output, data.len() as u32);
    output.extend_from_slice(data);
}

pub fn encode(frame: &Frame) -> Vec<u8> {
    let mut output = Vec::new();
    field(&mut output, 1, 0);
    varint(&mut output, frame.version);
    if !frame.stream_id.is_empty() {
        length_delimited(&mut output, 2, frame.stream_id.as_bytes());
    }
    for (number, value) in [(3, frame.ack), (4, frame.ack_bits)] {
        if let Some(value) = value.filter(|value| *value > 0) {
            field(&mut output, number, 0);
            varint(&mut output, value);
        }
    }
    match &frame.body {
        Body::Data {
            seq,
            segment_index,
            segment_count,
            payload,
        } => {
            let mut data = Vec::new();
            for (number, value) in [(1, *seq), (2, *segment_index), (3, *segment_count)] {
                if value != 0 {
                    field(&mut data, number, 0);
                    varint(&mut data, value);
                }
            }
            length_delimited(&mut data, 4, payload);
            length_delimited(&mut output, 5, &data);
        }
        Body::Ack => length_delimited(&mut output, 6, &[]),
        Body::Resume { next_seq } => {
            let mut resume = Vec::new();
            field(&mut resume, 1, 0);
            varint(&mut resume, *next_seq);
            length_delimited(&mut output, 7, &resume);
        }
        Body::Reset { reason } => {
            let mut reset = Vec::new();
            if !reason.is_empty() {
                length_delimited(&mut reset, 1, reason.as_bytes());
            }
            length_delimited(&mut output, 8, &reset);
        }
        Body::Heartbeat => length_delimited(&mut output, 9, &[]),
        Body::Handshake { payload } => {
            let mut handshake = Vec::new();
            length_delimited(&mut handshake, 1, payload);
            length_delimited(&mut output, 10, &handshake);
        }
    }
    for (number, value) in [(11, &frame.traceparent), (12, &frame.tracestate)] {
        if let Some(value) = value.as_ref().filter(|value| !value.is_empty()) {
            length_delimited(&mut output, number, value.as_bytes());
        }
    }
    output
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl Reader<'_> {
    fn varint(&mut self) -> Result<u32, Invalid> {
        let mut result = 0u32;
        let mut shift = 0u32;
        while self.position < self.bytes.len() {
            let byte = self.bytes[self.position];
            self.position += 1;
            result |= u32::from(byte & 0x7f) << (shift & 31);
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift > 35 {
                return Err(Invalid);
            }
        }
        Err(Invalid)
    }

    fn skip(&mut self, wire: u32) -> Result<(), Invalid> {
        match wire {
            0 => {
                let mut count = 0;
                while self.position < self.bytes.len() {
                    let byte = self.bytes[self.position];
                    self.position += 1;
                    count += 1;
                    if byte & 0x80 == 0 {
                        return Ok(());
                    }
                    if count >= 10 {
                        return Err(Invalid);
                    }
                }
                Err(Invalid)
            }
            1 => self.advance_exact(8),
            2 => {
                let length = self.varint()? as usize;
                self.advance_exact(length)
            }
            5 => self.advance_exact(4),
            _ => Err(Invalid),
        }
    }

    fn advance_exact(&mut self, count: usize) -> Result<(), Invalid> {
        if self.position + count > self.bytes.len() {
            return Err(Invalid);
        }
        self.position += count;
        Ok(())
    }

    fn bounded(&mut self, end: usize) -> Result<&[u8], Invalid> {
        let length = self.varint()? as usize;
        if self.position + length > end {
            return Err(Invalid);
        }
        let slice = &self.bytes[self.position..self.position + length];
        self.position += length;
        Ok(slice)
    }

    fn lossy(&mut self, length: usize) -> String {
        let start = self.position.min(self.bytes.len());
        let end = (self.position.saturating_add(length)).min(self.bytes.len());
        self.position = self.position.saturating_add(length);
        String::from_utf8_lossy(&self.bytes[start..end]).into_owned()
    }
}

pub fn decode(bytes: &[u8]) -> Result<Frame, Invalid> {
    if bytes.len() > MAX_WEBSOCKET_MESSAGE_BYTES {
        return Err(Invalid);
    }
    let mut version = None;
    let mut stream_id = None::<String>;
    let (mut ack, mut ack_bits) = (None, None);
    let mut body = None;
    let (mut traceparent, mut tracestate) = (None, None);
    let mut reader = Reader { bytes, position: 0 };
    while reader.position < bytes.len() {
        let key = reader.varint()?;
        let (number, wire) = (key >> 3, key & 7);
        let expect = |expected: u32| {
            if wire == expected {
                Ok(())
            } else {
                Err(Invalid)
            }
        };
        match number {
            1 => {
                expect(0)?;
                version = Some(reader.varint()?);
            }
            2 => {
                expect(2)?;
                let length = reader.varint()? as usize;
                if reader.position + length > bytes.len() {
                    return Err(Invalid);
                }
                stream_id = Some(reader.lossy(length));
            }
            3 => {
                expect(0)?;
                ack = Some(reader.varint()?);
            }
            4 => {
                expect(0)?;
                ack_bits = Some(reader.varint()?);
            }
            5 => {
                expect(2)?;
                let length = reader.varint()? as usize;
                let end = reader.position + length;
                if end > bytes.len() {
                    return Err(Invalid);
                }
                let (mut seq, mut segment_index, mut segment_count) = (0, 0, 0);
                let mut payload = None;
                let mut inner = Reader {
                    bytes,
                    position: reader.position,
                };
                while inner.position < end {
                    let key = inner.varint()?;
                    match key >> 3 {
                        1 => seq = inner.varint()?,
                        2 => segment_index = inner.varint()?,
                        3 => segment_count = inner.varint()?,
                        4 => payload = Some(inner.bounded(end)?.to_vec()),
                        _ => inner.skip(key & 7)?,
                    }
                }
                reader.position = end;
                body = Some(Body::Data {
                    seq,
                    segment_index,
                    segment_count,
                    payload: payload.unwrap_or_default(),
                });
            }
            6 | 9 => {
                expect(2)?;
                let length = reader.varint()? as usize;
                reader.position = reader.position.saturating_add(length);
                body = Some(if number == 6 {
                    Body::Ack
                } else {
                    Body::Heartbeat
                });
            }
            7 => {
                expect(2)?;
                let length = reader.varint()? as usize;
                let end = reader.position + length;
                let mut next_seq = 0;
                let mut inner = Reader {
                    bytes,
                    position: reader.position,
                };
                while inner.position < end {
                    let key = inner.varint()?;
                    if key >> 3 == 1 && key & 7 == 0 {
                        next_seq = inner.varint()?;
                    } else {
                        inner.skip(key & 7)?;
                    }
                }
                reader.position = end;
                body = Some(Body::Resume { next_seq });
            }
            8 | 10 => {
                expect(2)?;
                let length = reader.varint()? as usize;
                let end = reader.position + length;
                let mut value = None::<Vec<u8>>;
                let mut inner = Reader {
                    bytes,
                    position: reader.position,
                };
                while inner.position < end {
                    let key = inner.varint()?;
                    if key >> 3 == 1 && key & 7 == 2 {
                        value = Some(inner.bounded(end)?.to_vec());
                    } else {
                        inner.skip(key & 7)?;
                    }
                }
                reader.position = end;
                body = Some(if number == 8 {
                    Body::Reset {
                        reason: String::from_utf8_lossy(&value.unwrap_or_default()).into_owned(),
                    }
                } else {
                    Body::Handshake {
                        payload: value.unwrap_or_default(),
                    }
                });
            }
            11 | 12 => {
                expect(2)?;
                let length = reader.varint()? as usize;
                let text = reader.lossy(length);
                if number == 11 {
                    traceparent = Some(text);
                } else {
                    tracestate = Some(text);
                }
            }
            _ => reader.skip(wire)?,
        }
    }
    if version != Some(FRAME_VERSION) {
        return Err(Invalid);
    }
    let stream_id = stream_id.ok_or(Invalid)?;
    let units = stream_id.encode_utf16().collect::<Vec<_>>();
    if access::trim_units(&units).is_empty() {
        return Err(Invalid);
    }
    let body = body.ok_or(Invalid)?;
    match &body {
        Body::Data {
            segment_index,
            segment_count,
            payload,
            ..
        } => {
            if *segment_index != 0 || *segment_count != 1 || payload.is_empty() {
                return Err(Invalid);
            }
        }
        Body::Reset { reason } if reason.is_empty() => return Err(Invalid),
        Body::Handshake { payload } if payload.is_empty() => return Err(Invalid),
        _ => {}
    }
    Ok(Frame {
        version: FRAME_VERSION,
        stream_id,
        ack,
        ack_bits,
        body,
        traceparent,
        tracestate,
    })
}

pub fn frame_message(message: &[u8]) -> Result<Vec<u8>, Invalid> {
    if message.is_empty() || message.len() > MAX_JSONRPC_MESSAGE_BYTES {
        return Err(Invalid);
    }
    let mut framed = Vec::with_capacity(4 + message.len());
    framed.extend_from_slice(&(message.len() as u32).to_be_bytes());
    framed.extend_from_slice(message);
    Ok(framed)
}

#[derive(Default)]
pub struct MessageDecoder {
    buffered: Vec<u8>,
}

impl MessageDecoder {
    pub fn buffered_bytes(&self) -> usize {
        self.buffered.len()
    }

    pub fn push(&mut self, record: &[u8]) -> Result<Vec<Vec<u8>>, Invalid> {
        if record.len() > RECORD_PLAINTEXT_BYTES {
            return Err(Invalid);
        }
        self.buffered.extend_from_slice(record);
        let mut messages = Vec::new();
        while self.buffered.len() >= 4 {
            let length = u32::from_be_bytes([
                self.buffered[0],
                self.buffered[1],
                self.buffered[2],
                self.buffered[3],
            ]) as usize;
            if length == 0 || length > MAX_JSONRPC_MESSAGE_BYTES {
                return Err(Invalid);
            }
            if self.buffered.len() < 4 + length {
                break;
            }
            messages.push(self.buffered[4..4 + length].to_vec());
            self.buffered.drain(..4 + length);
        }
        if self.buffered.len() > 4 + MAX_JSONRPC_MESSAGE_BYTES {
            return Err(Invalid);
        }
        Ok(messages)
    }
}

#[derive(Default)]
pub struct OrderedCiphertexts {
    next: u64,
    pending: BTreeMap<u64, Vec<u8>>,
    pending_bytes: usize,
}

impl OrderedCiphertexts {
    pub fn pending_bytes(&self) -> usize {
        self.pending_bytes
    }

    fn advance(&mut self) -> Result<(), Invalid> {
        if self.next >= u64::from(u32::MAX) {
            return Err(Invalid);
        }
        self.next += 1;
        Ok(())
    }

    pub fn push(&mut self, seq: u32, payload: Vec<u8>) -> Result<Vec<Vec<u8>>, Invalid> {
        let seq = u64::from(seq);
        if seq < self.next || self.pending.contains_key(&seq) {
            return Ok(Vec::new());
        }
        if seq > self.next {
            if seq - self.next > u64::from(MAX_REORDER_DISTANCE) {
                return Err(Invalid);
            }
            let pending_bytes = self.pending_bytes + payload.len();
            if pending_bytes > MAX_PENDING_BYTES {
                return Err(Invalid);
            }
            self.pending.insert(seq, payload);
            self.pending_bytes = pending_bytes;
            return Ok(Vec::new());
        }
        let mut ready = vec![payload];
        self.advance()?;
        while let Some(buffered) = self.pending.remove(&self.next) {
            self.pending_bytes -= buffered.len();
            ready.push(buffered);
            self.advance()?;
        }
        Ok(ready)
    }
}
