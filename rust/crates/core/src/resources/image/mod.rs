use crate::resources::config::Configuration;
use photon_rs::{
    native,
    transform::{self, SamplingFilter},
};
use std::fmt;
use ycoding_schema::JsonValue;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Content {
    pub uri: String,
    pub name: Option<String>,
    pub content: String,
    pub mime: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub auto_resize: bool,
    pub max_width: u64,
    pub max_height: u64,
    pub max_base64_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            auto_resize: true,
            max_width: 2_000,
            max_height: 2_000,
            max_base64_bytes: 5 * 1024 * 1024,
        }
    }
}
impl Limits {
    pub fn from_configuration(configuration: &Configuration) -> Self {
        let mut limits = Self::default();
        for attachments in configuration.values("attachments") {
            let JsonValue::Object(attachments) = attachments else {
                continue;
            };
            let Some(JsonValue::Object(image)) = attachments.get(&"image".into()) else {
                continue;
            };
            if let Some(JsonValue::Bool(value)) = image.get(&"auto_resize".into()) {
                limits.auto_resize = *value;
            }
            if let Some(JsonValue::Number(value)) = image.get(&"max_width".into()) {
                limits.max_width = *value as u64;
            }
            if let Some(JsonValue::Number(value)) = image.get(&"max_height".into()) {
                limits.max_height = *value as u64;
            }
            if let Some(JsonValue::Number(value)) = image.get(&"max_base64_bytes".into()) {
                limits.max_base64_bytes = *value as usize;
            }
        }
        limits
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Decode {
        resource: String,
    },
    Size {
        resource: String,
        width: u32,
        height: u32,
        bytes: usize,
        max_width: u64,
        max_height: u64,
        max_bytes: usize,
    },
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode { resource } => write!(f, "Image could not be decoded: {resource}"),
            Self::Size {
                resource,
                width,
                height,
                bytes,
                max_width,
                max_height,
                max_bytes,
            } => write!(
                f,
                "Image {resource} is {width}x{height} with base64 size {bytes}, exceeding configured limits {max_width}x{max_height}/{max_bytes} bytes"
            ),
        }
    }
}
impl std::error::Error for Error {}

pub fn normalize(resource: &str, content: &Content, limits: Limits) -> Result<Content, Error> {
    let decoded =
        native::open_image_from_bytes(&decode_base64(&content.content)).map_err(|_| {
            Error::Decode {
                resource: resource.into(),
            }
        })?;
    let width = decoded.get_width();
    let height = decoded.get_height();
    let bytes = content.content.len();
    if u64::from(width) <= limits.max_width
        && u64::from(height) <= limits.max_height
        && bytes <= limits.max_base64_bytes
    {
        return Ok(content.clone());
    }
    let size_error = || Error::Size {
        resource: resource.into(),
        width,
        height,
        bytes,
        max_width: limits.max_width,
        max_height: limits.max_height,
        max_bytes: limits.max_base64_bytes,
    };
    if !limits.auto_resize {
        return Err(size_error());
    }
    let scale = 1.0_f64
        .min(limits.max_width as f64 / f64::from(width))
        .min(limits.max_height as f64 / f64::from(height));
    let mut sizes = Vec::new();
    for _ in 0..32 {
        let (width, height) = sizes
            .last()
            .copied()
            .map(|(width, height)| {
                (
                    if width == 1 {
                        1
                    } else {
                        (f64::from(width) * 0.75).floor().max(1.0) as u32
                    },
                    if height == 1 {
                        1
                    } else {
                        (f64::from(height) * 0.75).floor().max(1.0) as u32
                    },
                )
            })
            .unwrap_or((
                (f64::from(width) * scale).round().max(1.0) as u32,
                (f64::from(height) * scale).round().max(1.0) as u32,
            ));
        if sizes.contains(&(width, height)) {
            continue;
        }
        sizes.push((width, height));
    }
    for (width, height) in sizes {
        let resized = transform::resize(&decoded, width, height, SamplingFilter::Lanczos3);
        let png = base64(&resized.get_bytes());
        if png.len() <= limits.max_base64_bytes {
            return Ok(Content {
                content: png,
                mime: "image/png".into(),
                ..content.clone()
            });
        }
        for quality in [80, 85, 70, 55, 40] {
            let jpeg = base64(&resized.get_bytes_jpeg(quality));
            if jpeg.len() <= limits.max_base64_bytes {
                return Ok(Content {
                    content: jpeg,
                    mime: "image/jpeg".into(),
                    ..content.clone()
                });
            }
        }
    }
    Err(size_error())
}
pub(crate) fn decode_base64(text: &str) -> Vec<u8> {
    let mut output = Vec::new();
    let mut buffer = 0_u32;
    let mut bits = 0;
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        buffer = buffer.wrapping_shl(6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
    }
    output
}
fn base64(bytes: &[u8]) -> String {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(alphabet[(value >> 18) as usize] as char);
        output.push(alphabet[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            alphabet[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            alphabet[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}
