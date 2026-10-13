#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AudioSource {
    Remote,
    Microphone,
}

impl AudioSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Remote => "remote",
            Self::Microphone => "microphone",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AudioChunk {
    pub id: String,
    pub source: AudioSource,
    pub start_ms: f64,
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode_base64(bytes: &[u8]) -> String {
    bytes
        .chunks(3)
        .flat_map(|group| {
            let word = (u32::from(group[0]) << 16)
                | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
                | u32::from(*group.get(2).unwrap_or(&0));
            (0..4).map(move |index| {
                if index > group.len() {
                    '='
                } else {
                    ALPHABET[((word >> (18 - 6 * index)) & 63) as usize] as char
                }
            })
        })
        .collect()
}

pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let groups = bytes.len() / 4;
    let mut output = Vec::with_capacity(groups * 3);
    for (index, group) in bytes.chunks(4).enumerate() {
        let padding = group.iter().rev().take_while(|byte| **byte == b'=').count();
        if padding > 2 || (padding > 0 && index + 1 != groups) {
            return None;
        }
        let mut word = 0u32;
        for byte in &group[..4 - padding] {
            word = (word << 6) | ALPHABET.iter().position(|candidate| candidate == byte)? as u32;
        }
        word <<= 6 * padding as u32;
        output.extend_from_slice(&word.to_be_bytes()[1..4 - padding]);
    }
    Some(output)
}

pub fn samples_base64(samples: &[f32]) -> String {
    encode_base64(
        &samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>(),
    )
}
