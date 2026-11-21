#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlFrame {
    Replay {
        generation: u64,
        start_offset: u64,
        end_offset: u64,
        gap: bool,
    },
    Chunk {
        generation: u64,
        start_offset: u64,
        end_offset: u64,
    },
    End {
        generation: u64,
        reason: String,
        exit_code: Option<u64>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerFrame {
    Control(ControlFrame),
    Data(Vec<u8>),
}
pub struct Chunk {
    pub start_offset: u64,
    pub end_offset: u64,
    pub data: Vec<u8>,
}
pub const REPLAY_CHUNK: usize = 64 * 1024;
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
pub fn control_frame(control: &ControlFrame) -> Vec<u8> {
    use ycoding_schema::{JsonValue, ObjectEncoder};
    let value = match control {
        ControlFrame::Replay {
            generation,
            start_offset,
            end_offset,
            gap,
        } => ObjectEncoder::new()
            .field("type", "replay")
            .field("generation", &JsonValue::Number(*generation as f64))
            .field("startOffset", &JsonValue::Number(*start_offset as f64))
            .field("endOffset", &JsonValue::Number(*end_offset as f64))
            .field("gap", gap)
            .finish(),
        ControlFrame::Chunk {
            generation,
            start_offset,
            end_offset,
        } => ObjectEncoder::new()
            .field("type", "chunk")
            .field("generation", &JsonValue::Number(*generation as f64))
            .field("startOffset", &JsonValue::Number(*start_offset as f64))
            .field("endOffset", &JsonValue::Number(*end_offset as f64))
            .finish(),
        ControlFrame::End {
            generation,
            reason,
            exit_code,
        } => ObjectEncoder::new()
            .field("type", "end")
            .field("generation", &JsonValue::Number(*generation as f64))
            .field("reason", reason.as_str())
            .optional(
                "exitCode",
                &exit_code.map(|code| JsonValue::Number(code as f64)),
            )
            .finish(),
    };
    let mut bytes = vec![0];
    bytes.extend(ycoding_schema::stringify_json(&value).as_bytes());
    bytes
}
pub fn data_frame(data: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(data.len() + 1);
    bytes.push(1);
    bytes.extend(data);
    bytes
}
pub fn decode_server_frame(data: &[u8]) -> Option<ServerFrame> {
    use ycoding_schema::{JsonValue, parse_json};
    if data.first() == Some(&1) {
        return Some(ServerFrame::Data(data[1..].to_vec()));
    }
    if data.first() != Some(&0) {
        return None;
    }
    let text = std::str::from_utf8(&data[1..]).ok()?;
    let JsonValue::Object(value) =
        parse_json(text.strip_prefix('\u{feff}').unwrap_or(text)).ok()?
    else {
        return None;
    };
    let generation = number(value.get(&"generation".into())?)?;
    if generation == 0 {
        return None;
    }
    let JsonValue::String(kind) = value.get(&"type".into())? else {
        return None;
    };
    let control = match kind.as_str()? {
        "chunk" | "replay" => {
            let start_offset = number(value.get(&"startOffset".into())?)?;
            let end_offset = number(value.get(&"endOffset".into())?)?;
            if end_offset < start_offset {
                return None;
            }
            if kind.as_str() == Some("chunk") {
                ControlFrame::Chunk {
                    generation,
                    start_offset,
                    end_offset,
                }
            } else {
                let JsonValue::Bool(gap) = value.get(&"gap".into())? else {
                    return None;
                };
                ControlFrame::Replay {
                    generation,
                    start_offset,
                    end_offset,
                    gap: *gap,
                }
            }
        }
        "end" => {
            let JsonValue::String(reason) = value.get(&"reason".into())? else {
                return None;
            };
            if !matches!(
                reason.as_str()?,
                "exit" | "timeout" | "terminated" | "service_shutdown" | "overflow"
            ) {
                return None;
            }
            let exit_code = match value.get(&"exitCode".into()) {
                Some(value) => Some(number(value)?),
                None => None,
            };
            ControlFrame::End {
                generation,
                reason: reason.to_utf8().ok()?,
                exit_code,
            }
        }
        _ => return None,
    };
    Some(ServerFrame::Control(control))
}
fn number(value: &ycoding_schema::JsonValue) -> Option<u64> {
    let ycoding_schema::JsonValue::Number(value) = value else {
        return None;
    };
    (value.is_finite() && value.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(value))
        .then_some(*value as u64)
}
pub fn decode_input(data: &[u8]) -> Option<String> {
    (data.len() <= MAX_INPUT_BYTES)
        .then(|| {
            std::str::from_utf8(data)
                .ok()
                .map(|text| text.strip_prefix('\u{feff}').unwrap_or(text).to_owned())
        })
        .flatten()
}
pub fn decode_text_input(text: &str) -> Option<String> {
    (text.len() <= MAX_INPUT_BYTES).then(|| text.to_owned())
}
pub fn chunks(data: &[u8], start: u64) -> Vec<Chunk> {
    data.chunks(REPLAY_CHUNK)
        .enumerate()
        .map(|(index, data)| Chunk {
            start_offset: start + (index * REPLAY_CHUNK) as u64,
            end_offset: start + (index * REPLAY_CHUNK + data.len()) as u64,
            data: data.to_vec(),
        })
        .collect()
}
