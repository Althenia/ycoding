use crate::Error;
use flate2::{Compression, GzBuilder, bufread::GzDecoder};
use std::io::{Read, Write};

pub const GZIP: u8 = 1;
pub const END_STREAM: u8 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    pub flags: u8,
    pub payload: Vec<u8>,
}
impl Frame {
    pub fn decode(&self) -> Result<Vec<u8>, Error> {
        if self.flags & GZIP == 0 {
            return Ok(self.payload.clone());
        }
        let mut decoded = Vec::new();
        let mut remaining = self.payload.as_slice();
        loop {
            let mut decoder = GzDecoder::new(remaining);
            decoder
                .read_to_end(&mut decoded)
                .map_err(|_| Error::output("Cursor returned corrupt gzip framing"))?;
            remaining = decoder.into_inner();
            if remaining.is_empty() || remaining[0] == 0 {
                break;
            }
        }
        Ok(decoded)
    }
}

pub fn encode(flags: u8, payload: &[u8]) -> Result<Vec<u8>, Error> {
    let compressed = if flags & GZIP != 0 {
        let operating_system = if cfg!(target_os = "macos") {
            19
        } else if cfg!(windows) {
            0
        } else {
            3
        };
        let mut encoder = GzBuilder::new()
            .operating_system(operating_system)
            .write(Vec::new(), Compression::default());
        encoder
            .write_all(payload)
            .map_err(|_| Error::invalid("Cursor gzip encoding failed"))?;
        Some(
            encoder
                .finish()
                .map_err(|_| Error::invalid("Cursor gzip encoding failed"))?,
        )
    } else {
        None
    };
    let payload = compressed.as_deref().unwrap_or(payload);
    let length = u32::try_from(payload.len())
        .map_err(|_| Error::invalid("Cursor frame exceeds the uint32 wire length"))?;
    let mut bytes = Vec::with_capacity(5 + payload.len());
    bytes.push(flags);
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
}
impl Decoder {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Frame> {
        self.pending.extend_from_slice(chunk);
        let mut offset = 0;
        let mut frames = Vec::new();
        while self.pending.len() - offset >= 5 {
            let header = &self.pending[offset..offset + 5];
            let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
            if length > self.pending.len() - offset - 5 {
                break;
            }
            frames.push(Frame {
                flags: header[0],
                payload: self.pending[offset + 5..offset + 5 + length].to_vec(),
            });
            offset += 5 + length;
        }
        self.pending.drain(..offset);
        frames
    }
    pub fn finish(&self) -> Result<(), Error> {
        if self.pending.is_empty() {
            return Ok(());
        }
        Err(Error::output(
            "Cursor stream ended with an incomplete Connect frame",
        ))
    }
}
