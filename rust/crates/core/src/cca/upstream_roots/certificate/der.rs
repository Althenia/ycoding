use super::super::RootError;

#[derive(Clone, Copy)]
pub(super) struct Field<'a> {
    pub(super) tag: u8,
    pub(super) contents: &'a [u8],
    pub(super) encoded: &'a [u8],
}

pub(super) fn invalid(message: &str) -> RootError {
    RootError::InvalidCertificate(message.into())
}

pub(super) fn take<'a>(input: &mut &'a [u8]) -> Result<Field<'a>, RootError> {
    let bytes = *input;
    let tag = *bytes.first().ok_or_else(|| invalid("missing ASN.1 tag"))?;
    if tag == 0 {
        return Err(invalid("unexpected end-of-contents tag"));
    }
    let mut offset = 1usize;
    if tag & 0x1f == 0x1f {
        let first = *bytes
            .get(offset)
            .ok_or_else(|| invalid("missing high-tag number"))?;
        if first & 0x7f == 0 {
            return Err(invalid("invalid high-tag number"));
        }
        loop {
            let byte = *bytes
                .get(offset)
                .ok_or_else(|| invalid("truncated high-tag number"))?;
            offset += 1;
            if byte & 0x80 == 0 {
                break;
            }
        }
    }
    let first = *bytes
        .get(offset)
        .ok_or_else(|| invalid("missing ASN.1 length"))?;
    offset += 1;
    let length = if first < 0x80 {
        first as usize
    } else {
        let width = (first & 0x7f) as usize;
        if width == 0 {
            return Err(RootError::NativeCertificate(
                "indefinite BER length requires the OpenSSL decoder".into(),
            ));
        }
        if width > std::mem::size_of::<usize>() {
            return Err(invalid("ASN.1 length overflow"));
        }
        let end = offset
            .checked_add(width)
            .ok_or_else(|| invalid("ASN.1 length overflow"))?;
        let encoded = bytes
            .get(offset..end)
            .ok_or_else(|| invalid("truncated ASN.1 length"))?;
        let mut length = 0usize;
        for byte in encoded {
            length = length
                .checked_mul(256)
                .and_then(|value| value.checked_add(*byte as usize))
                .ok_or_else(|| invalid("ASN.1 length overflow"))?;
        }
        if encoded[0] == 0 || length < 128 {
            return Err(RootError::NativeCertificate(
                "noncanonical BER length requires the OpenSSL decoder".into(),
            ));
        }
        offset = end;
        length
    };
    let end = offset
        .checked_add(length)
        .ok_or_else(|| invalid("ASN.1 field overflow"))?;
    let encoded = bytes
        .get(..end)
        .ok_or_else(|| invalid("truncated ASN.1 field"))?;
    *input = &bytes[end..];
    Ok(Field {
        tag,
        contents: &bytes[offset..end],
        encoded,
    })
}

pub(super) fn expect<'a>(input: &mut &'a [u8], tag: u8) -> Result<Field<'a>, RootError> {
    let field = take(input)?;
    if field.tag != tag {
        return Err(invalid("unexpected ASN.1 tag"));
    }
    Ok(field)
}

pub(super) fn single(input: &[u8], tag: u8) -> Result<Field<'_>, RootError> {
    let mut input = input;
    let field = expect(&mut input, tag)?;
    finished(input)?;
    Ok(field)
}

pub(super) fn finished(input: &[u8]) -> Result<(), RootError> {
    if input.is_empty() {
        Ok(())
    } else {
        Err(invalid("unexpected ASN.1 fields"))
    }
}

pub(super) fn wrap(tag: u8, contents: &[u8]) -> Vec<u8> {
    let mut encoded = vec![tag];
    if contents.len() < 128 {
        encoded.push(contents.len() as u8);
    } else {
        let bytes = contents.len().to_be_bytes();
        let first = bytes
            .iter()
            .position(|byte| *byte != 0)
            .unwrap_or(bytes.len() - 1);
        encoded.push(0x80 | (bytes.len() - first) as u8);
        encoded.extend_from_slice(&bytes[first..]);
    }
    encoded.extend_from_slice(contents);
    encoded
}
