use crate::{Error, json};
use ycoding_schema::{JsonValue, parse_json};

#[derive(Default)]
pub struct Sse {
    line: Vec<u8>,
    data: Vec<String>,
    after_cr: bool,
    first_line: bool,
    stop_at_done: bool,
    done: bool,
}
impl Sse {
    pub(crate) fn new(stop_at_done: bool) -> Self {
        Self {
            stop_at_done,
            ..Self::default()
        }
    }
    pub(crate) fn done(&self) -> bool {
        self.done
    }
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut frames = Vec::new();
        for byte in bytes {
            if self.done {
                break;
            }
            if self.after_cr {
                self.after_cr = false;
                if *byte == b'\n' {
                    continue;
                }
            }
            if matches!(byte, b'\r' | b'\n') {
                self.complete_line(&mut frames);
                self.after_cr = *byte == b'\r';
            } else {
                self.line.push(*byte);
            }
        }
        frames
    }
    fn complete_line(&mut self, frames: &mut Vec<String>) {
        let line = String::from_utf8_lossy(&self.line);
        let line = if !self.first_line {
            self.first_line = true;
            line.trim_start_matches('\u{feff}')
        } else {
            &line
        };
        if line.is_empty() {
            let data = self.data.join("\n");
            self.data.clear();
            if data == "[DONE]" {
                self.done = self.stop_at_done;
            } else if !data.is_empty() {
                frames.push(data);
            }
        } else if let Some(data) = line.strip_prefix("data:") {
            self.data
                .push(data.strip_prefix(' ').unwrap_or(data).into());
        } else if line == "data" {
            self.data.push(String::new());
        }
        self.line.clear();
    }
    pub fn finish(&self) -> Result<(), Error> {
        if self.line.is_empty() && self.data.is_empty() {
            Ok(())
        } else {
            Err(Error::missing_terminal())
        }
    }
}
#[derive(Default)]
pub struct AwsEventStream {
    buffer: Vec<u8>,
}
impl AwsEventStream {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<JsonValue>, Error> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();
        let mut offset = 0;
        while self.buffer.len() - offset >= 4 {
            let frame = &self.buffer[offset..];
            let total = be32(&frame[..4]) as usize;
            if total < 16 {
                return Err(Error::output("Invalid AWS event-stream frame length"));
            }
            if frame.len() < 12 {
                break;
            }
            let headers = be32(&frame[4..8]) as usize;
            if headers > total - 16 || crc32(&frame[..8]) != be32(&frame[8..12]) {
                return Err(Error::output(
                    "Invalid AWS event-stream frame CRC or headers length",
                ));
            }
            if frame.len() < total {
                break;
            }
            let frame = &frame[..total];
            if crc32(&frame[..total - 4]) != be32(&frame[total - 4..]) {
                return Err(Error::output(
                    "Invalid AWS event-stream frame CRC or headers length",
                ));
            }
            let mut cursor = 12;
            let mut message_type = None;
            let mut event_type = None;
            while cursor < 12 + headers {
                let size = frame[cursor] as usize;
                cursor += 1;
                if cursor + size + 1 > 12 + headers {
                    return Err(Error::output("Invalid AWS event-stream header"));
                }
                let name = &frame[cursor..cursor + size];
                cursor += size;
                let kind = frame[cursor];
                cursor += 1;
                let size = match kind {
                    0 | 1 => 0,
                    2 => 1,
                    3 => 2,
                    4 => 4,
                    5 | 8 => 8,
                    9 => 16,
                    6 | 7 => {
                        if cursor + 2 > 12 + headers {
                            return Err(Error::output("Invalid AWS event-stream header value"));
                        }
                        let size = u16::from_be_bytes([frame[cursor], frame[cursor + 1]]) as usize;
                        cursor += 2;
                        size
                    }
                    _ => return Err(Error::output("Unknown AWS event-stream header type")),
                };
                if cursor + size > 12 + headers {
                    return Err(Error::output("Truncated AWS event-stream header value"));
                }
                if kind == 7 {
                    let value = String::from_utf8_lossy(&frame[cursor..cursor + size]).into_owned();
                    if name == b":message-type" {
                        message_type = Some(value);
                    } else if name == b":event-type" {
                        event_type = Some(value);
                    }
                }
                cursor += size;
            }
            let payload = &frame[12 + headers..total - 4];
            if message_type.as_deref() == Some("event")
                && !payload.is_empty()
                && let Some(event_type) = event_type
            {
                let payload = String::from_utf8_lossy(payload);
                let value = parse_json(&payload).map_err(|_| {
                    Error::output("Failed to parse Bedrock Converse event-stream payload")
                })?;
                frames.push(json::object([(event_type, json::remove(&value, &["p"]))]));
            }
            offset += total;
        }
        self.buffer.drain(..offset);
        Ok(frames)
    }
    pub fn finish(&self) -> Result<(), Error> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(Error::missing_terminal())
        }
    }
}
fn be32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}
fn crc32(bytes: &[u8]) -> u32 {
    !bytes.iter().fold(!0u32, |crc, byte| {
        (0..8).fold(crc ^ u32::from(*byte), |crc, _| {
            (crc >> 1) ^ (0xedb88320 & 0u32.wrapping_sub(crc & 1))
        })
    })
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Framing {
    Sse,
    AwsEventStream,
}

#[cfg(test)]
mod tests {
    use super::Sse;
    use crate::Error;

    #[test]
    fn sse_done_requires_a_complete_delimiter() {
        let mut parser = Sse::new(true);
        assert!(parser.push(b"data: [DONE]\r\n").is_empty());
        assert!(!parser.done());
        assert_eq!(parser.finish(), Err(Error::missing_terminal()));

        assert!(parser.push(b"\r\ndata: {\"ignored\":").is_empty());
        assert!(parser.done());
        assert_eq!(parser.finish(), Ok(()));
    }
}
