use ycoding_ai::framing::{AwsEventStream, Sse};
use ycoding_schema::parse_json;

#[test]
fn sse_every_byte_boundary() {
    let bytes = concat!(
        ": keepalive\r\nretry: 1000\r\n\r\ndata: \r\n\r\n",
        "event: message\r\ndata: {\"text\":\"ไทย\"}\r\n\r\n",
        "data: [DONE]\r\n\r\nretry: 2000\n\ndata: first\ndata: second\n\ndata: unfinished"
    )
    .as_bytes();
    for index in 0..=bytes.len() {
        let mut parser = Sse::default();
        let mut frames = parser.push(&bytes[..index]);
        frames.extend(parser.push(&bytes[index..]));
        frames.extend(parser.finish());
        assert_eq!(
            frames,
            ["{\"text\":\"ไทย\"}", "first\nsecond"],
            "split {index}"
        );
    }
    let mut parser = Sse::default();
    let frames: Vec<_> = bytes
        .iter()
        .flat_map(|byte| parser.push(&[*byte]))
        .collect();
    assert_eq!(frames, ["{\"text\":\"ไทย\"}", "first\nsecond"]);
}

fn crc(bytes: &[u8]) -> u32 {
    let mut value = !0u32;
    for byte in bytes {
        value ^= u32::from(*byte);
        for _ in 0..8 {
            value = (value >> 1) ^ (0xedb88320 & 0u32.wrapping_sub(value & 1));
        }
    }
    !value
}

fn frame() -> Vec<u8> {
    let mut headers = Vec::new();
    for (key, value) in [
        (":message-type", "event"),
        (":event-type", "contentBlockDelta"),
    ] {
        headers.push(key.len() as u8);
        headers.extend(key.bytes());
        headers.push(7);
        headers.extend((value.len() as u16).to_be_bytes());
        headers.extend(value.bytes());
    }
    let payload = "{\"delta\":{\"text\":\"ไทย\"},\"p\":\"pad\"}";
    let mut frame = Vec::new();
    frame.extend(((16 + headers.len() + payload.len()) as u32).to_be_bytes());
    frame.extend((headers.len() as u32).to_be_bytes());
    frame.extend(crc(&frame).to_be_bytes());
    frame.extend(headers);
    frame.extend(payload.bytes());
    frame.extend(crc(&frame).to_be_bytes());
    frame
}

#[test]
fn aws_every_byte_boundary_and_crc() {
    let bytes = frame();
    for index in 0..=bytes.len() {
        let mut parser = AwsEventStream::default();
        let mut frames = parser.push(&bytes[..index]).unwrap();
        frames.extend(parser.push(&bytes[index..]).unwrap());
        assert_eq!(
            frames,
            [parse_json("{\"contentBlockDelta\":{\"delta\":{\"text\":\"ไทย\"}}}").unwrap()]
        );
    }
    for index in [8, bytes.len() - 1] {
        let mut corrupt = bytes.clone();
        corrupt[index] ^= 1;
        assert!(AwsEventStream::default().push(&corrupt).is_err());
    }
    assert!(AwsEventStream::default().push(&0u32.to_be_bytes()).is_err());
}
