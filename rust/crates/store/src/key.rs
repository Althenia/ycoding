use ycoding_schema::LosslessString;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum KeyPart<'a> {
    Null,
    U64(u64),
    I64(i64),
    Bytes(&'a [u8]),
    String(&'a LosslessString),
}

pub fn tuple_key(parts: &[KeyPart<'_>]) -> Vec<u8> {
    let mut output = Vec::new();
    for part in parts {
        match part {
            KeyPart::Null => output.push(0),
            KeyPart::U64(value) => {
                output.push(1);
                output.extend_from_slice(&value.to_be_bytes());
            }
            KeyPart::I64(value) => {
                output.push(2);
                output.extend_from_slice(&((*value as u64) ^ (1 << 63)).to_be_bytes());
            }
            KeyPart::Bytes(bytes) => {
                output.push(3);
                escape(bytes.iter().copied(), &mut output);
            }
            KeyPart::String(text) => {
                output.push(4);
                escape(text.code_units().flat_map(u16::to_be_bytes), &mut output);
            }
        }
    }
    output
}

fn escape(bytes: impl Iterator<Item = u8>, output: &mut Vec<u8>) {
    for byte in bytes {
        output.push(byte);
        if byte == 0 {
            output.push(255);
        }
    }
    output.extend_from_slice(&[0, 0]);
}
