/*
 * Copyright 1995-2024 The OpenSSL Project Authors. All Rights Reserved.
 * Copyright 1995-2021 The OpenSSL Project Authors. All Rights Reserved.
 * Copyright 1995-2025 The OpenSSL Project Authors. All Rights Reserved.
 * Copyright 1999-2025 The OpenSSL Project Authors. All Rights Reserved.
 * Copyright 1999-2026 The OpenSSL Project Authors. All Rights Reserved.
 * Licensed under the Apache License 2.0; see LICENSE-OPENSSL.
 * Modified: Rust source translation of X509 fields, name canonicalization and time comparison.
 */

use super::RootError;
use rustls::pki_types::TrustAnchor;

mod der;

#[cfg(test)]
mod tests;

pub(super) fn encode_pem(der: &[u8]) -> Result<String, RootError> {
    pem_rfc7468::encode_string("CERTIFICATE", pem_rfc7468::LineEnding::LF, der)
        .map_err(|error| RootError::NativeCertificate(error.to_string()))
}

pub(super) struct MacCertificate {
    pub(super) pem: String,
    pub(super) identity: Vec<u8>,
    pub(super) self_issued: bool,
    not_after: Option<i64>,
}

impl MacCertificate {
    pub(super) fn expired_at(&self, now: std::time::Duration) -> bool {
        self.not_after
            .is_some_and(|expiry| i128::from(expiry) <= i128::from(now.as_secs()))
    }
}

struct CertificateFields<'a> {
    tbs: &'a [u8],
    issuer: &'a [u8],
    subject: &'a [u8],
    spki: &'a [u8],
    name_constraints: Option<&'a [u8]>,
    not_after: Option<i64>,
}

fn certificate_fields(input: &[u8]) -> Result<(der::Field<'_>, CertificateFields<'_>), RootError> {
    let mut input = input;
    let certificate = der::expect(&mut input, 0x30)?;
    let mut contents = certificate.contents;
    let tbs = der::expect(&mut contents, 0x30)?;
    algorithm(der::expect(&mut contents, 0x30)?.encoded)?;
    bit_string(der::expect(&mut contents, 0x03)?.contents)?;
    der::finished(contents)?;
    Ok((certificate, tbs_fields(tbs.encoded)?))
}

fn tbs_fields(input: &[u8]) -> Result<CertificateFields<'_>, RootError> {
    let tbs = der::single(input, 0x30)?;
    let mut fields = tbs.contents;
    if fields.first() == Some(&0xa0) {
        let version = der::expect(&mut fields, 0xa0)?;
        integer(der::single(version.contents, 0x02)?.contents)?;
    }
    integer(der::expect(&mut fields, 0x02)?.contents)?;
    algorithm(der::expect(&mut fields, 0x30)?.encoded)?;
    let issuer = der::expect(&mut fields, 0x30)?.encoded;
    canonical_name(issuer)?;
    let validity = der::expect(&mut fields, 0x30)?;
    let mut times = validity.contents;
    time_field(&mut times)?;
    let not_after = time_field(&mut times)?;
    der::finished(times)?;
    let subject = der::expect(&mut fields, 0x30)?.encoded;
    canonical_name(subject)?;
    let spki = der::expect(&mut fields, 0x30)?;
    let mut key = spki.contents;
    algorithm(der::expect(&mut key, 0x30)?.encoded)?;
    bit_string(der::expect(&mut key, 0x03)?.contents)?;
    der::finished(key)?;
    for tag in [0x81, 0x82] {
        if fields.first() == Some(&tag) {
            bit_string(der::expect(&mut fields, tag)?.contents)?;
        }
    }
    let name_constraints = if fields.first() == Some(&0xa3) {
        constraints(der::expect(&mut fields, 0xa3)?.encoded)?
    } else {
        None
    };
    der::finished(fields)?;
    Ok(CertificateFields {
        tbs: tbs.encoded,
        issuer,
        subject,
        spki: spki.contents,
        name_constraints,
        not_after,
    })
}

fn integer(contents: &[u8]) -> Result<(), RootError> {
    if contents.is_empty() {
        Err(der::invalid("empty ASN.1 integer"))
    } else {
        Ok(())
    }
}

fn bit_string(contents: &[u8]) -> Result<(), RootError> {
    let unused = *contents
        .first()
        .ok_or_else(|| der::invalid("missing bit-string unused-bit count"))?;
    if unused > 7 || (contents.len() == 1 && unused != 0) {
        return Err(der::invalid("invalid bit-string unused-bit count"));
    }
    if unused != 0
        && contents
            .last()
            .is_some_and(|byte| byte & ((1 << unused) - 1) != 0)
    {
        return Err(RootError::NativeCertificate(
            "noncanonical bit-string padding requires the OpenSSL decoder".into(),
        ));
    }
    Ok(())
}

fn object_identifier(contents: &[u8]) -> Result<(), RootError> {
    if contents.is_empty() || contents.last().is_none_or(|byte| byte & 0x80 != 0) {
        return Err(der::invalid("invalid object identifier"));
    }
    let mut first = true;
    for byte in contents {
        if first && *byte == 0x80 {
            return Err(der::invalid("nonminimal object identifier component"));
        }
        first = byte & 0x80 == 0;
    }
    Ok(())
}

fn algorithm(encoded: &[u8]) -> Result<(), RootError> {
    let sequence = der::single(encoded, 0x30)?;
    let mut fields = sequence.contents;
    object_identifier(der::expect(&mut fields, 0x06)?.contents)?;
    if !fields.is_empty() {
        der::take(&mut fields)?;
    }
    der::finished(fields)
}

fn time_field(input: &mut &[u8]) -> Result<Option<i64>, RootError> {
    let field = der::take(input)?;
    let minimum = match field.tag {
        0x17 => 13,
        0x18 => 15,
        _ => return Err(der::invalid("invalid X509 time tag")),
    };
    if field.contents.len() < minimum {
        return Err(der::invalid(
            "X509 time shorter than the OpenSSL primitive minimum",
        ));
    }
    Ok(time_value(field.tag, field.contents))
}

fn time_value(tag: u8, bytes: &[u8]) -> Option<i64> {
    let digits = match tag {
        0x17 => 12,
        0x18 => 14,
        _ => return None,
    };
    if bytes.len() != digits + 1
        || bytes[digits] != b'Z'
        || !bytes[..digits].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let number = |start: usize, width: usize| {
        std::str::from_utf8(&bytes[start..start + width])
            .ok()?
            .parse::<u32>()
            .ok()
    };
    let (year, offset) = if tag == 0x17 {
        let year = number(0, 2)?;
        ((if year < 50 { 2000 } else { 1900 }) + year, 2)
    } else {
        (number(0, 4)?, 4)
    };
    chrono::NaiveDate::from_ymd_opt(year as i32, number(offset, 2)?, number(offset + 2, 2)?)?
        .and_hms_opt(
            number(offset + 4, 2)?,
            number(offset + 6, 2)?,
            number(offset + 8, 2)?,
        )
        .map(|time| time.and_utc().timestamp())
}

fn constraints(encoded: &[u8]) -> Result<Option<&[u8]>, RootError> {
    let tagged = der::single(encoded, 0xa3)?;
    let sequence = der::single(tagged.contents, 0x30)?;
    let mut extensions = sequence.contents;
    let mut constraint = None;
    while !extensions.is_empty() {
        let extension = der::expect(&mut extensions, 0x30)?;
        let mut fields = extension.contents;
        let oid = der::expect(&mut fields, 0x06)?.contents;
        object_identifier(oid)?;
        if fields.first() == Some(&0x01) {
            let boolean = der::expect(&mut fields, 0x01)?;
            if boolean.contents.len() != 1 {
                return Err(der::invalid("invalid extension boolean"));
            }
        }
        let value = der::expect(&mut fields, 0x04)?;
        der::finished(fields)?;
        if oid == [0x55, 0x1d, 0x1e] {
            if constraint.is_some() {
                return Err(RootError::NativeCertificate(
                    "duplicate name-constraints extension requires OpenSSL policy resolution"
                        .into(),
                ));
            }
            constraint = Some(der::single(value.contents, 0x30).map_err(|error| {
                RootError::NativeCertificate(format!("name-constraints representation requires OpenSSL policy resolution: {error}"))
            })?.contents);
        }
    }
    Ok(constraint)
}

pub(super) fn trust_anchor(input: &[u8]) -> Result<TrustAnchor<'static>, RootError> {
    let (_, fields) = certificate_fields(input)?;
    Ok(TrustAnchor {
        subject: der::single(fields.subject, 0x30)?.contents.to_vec().into(),
        subject_public_key_info: fields.spki.to_vec().into(),
        name_constraints: fields.name_constraints.map(|value| value.to_vec().into()),
    })
}

pub(super) fn decode_system_der(input: &[u8]) -> Result<Option<String>, RootError> {
    match certificate_fields(input) {
        Ok((certificate, _)) => encode_pem(certificate.encoded).map(Some),
        Err(RootError::InvalidCertificate(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn decode_mac(input: &[u8]) -> Result<Option<MacCertificate>, RootError> {
    let (certificate, fields) = match certificate_fields(input) {
        Ok(parsed) => parsed,
        Err(RootError::InvalidCertificate(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    let self_issued = canonical_name(fields.subject)? == canonical_name(fields.issuer)?;
    let mut identity =
        ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, certificate.encoded)
            .as_ref()
            .to_vec();
    identity.extend_from_slice(fields.tbs);
    Ok(Some(MacCertificate {
        pem: encode_pem(certificate.encoded)?,
        identity,
        self_issued,
        not_after: fields.not_after,
    }))
}

fn canonical_name(encoded: &[u8]) -> Result<Vec<u8>, RootError> {
    let sequence = der::single(encoded, 0x30)?;
    let mut rdns = sequence.contents;
    let mut canonical = Vec::new();
    while !rdns.is_empty() {
        let set = der::expect(&mut rdns, 0x31)?;
        let mut entries = set.contents;
        let mut attributes = Vec::new();
        while !entries.is_empty() {
            let entry = der::expect(&mut entries, 0x30)?;
            let mut fields = entry.contents;
            let oid = der::expect(&mut fields, 0x06)?;
            object_identifier(oid.contents)?;
            let value = der::take(&mut fields)?;
            der::finished(fields)?;
            let utf8 = string_to_utf8(value)?;
            let value = utf8
                .map(|value| der::wrap(0x0c, &canonical_string(&value)))
                .unwrap_or_else(|| value.encoded.to_vec());
            let mut attribute = oid.encoded.to_vec();
            attribute.extend(value);
            attributes.push(der::wrap(0x30, &attribute));
        }
        if !attributes.is_empty() {
            attributes.sort();
            canonical.extend(der::wrap(0x31, &attributes.concat()));
        }
    }
    Ok(canonical)
}

fn string_to_utf8(value: der::Field<'_>) -> Result<Option<Vec<u8>>, RootError> {
    let mut utf8 = String::new();
    match value.tag {
        0x0c => {
            std::str::from_utf8(value.contents)
                .map_err(|_| der::invalid("invalid UTF8 name string"))?;
            return Ok(Some(value.contents.to_vec()));
        }
        0x13 | 0x14 | 0x16 | 0x1a => {
            utf8.extend(value.contents.iter().map(|byte| char::from(*byte)));
        }
        0x1c | 0x1e => {
            let width = if value.tag == 0x1c { 4 } else { 2 };
            if !value.contents.len().is_multiple_of(width) {
                return Err(der::invalid("invalid multibyte name string length"));
            }
            for bytes in value.contents.chunks_exact(width) {
                let code = bytes
                    .iter()
                    .fold(0u32, |code, byte| (code << 8) | u32::from(*byte));
                utf8.push(
                    char::from_u32(code)
                        .ok_or_else(|| der::invalid("invalid name Unicode code point"))?,
                );
            }
        }
        _ if value.tag & 0x20 != 0 => {
            return Err(RootError::NativeCertificate(
                "constructed name string requires the OpenSSL BER decoder".into(),
            ));
        }
        _ => return Ok(None),
    }
    Ok(Some(utf8.into_bytes()))
}

fn canonical_string(bytes: &[u8]) -> Vec<u8> {
    fn space(byte: u8) -> bool {
        matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
    }
    let start = bytes
        .iter()
        .position(|byte| !space(*byte))
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|byte| !space(*byte))
        .map_or(start, |index| index + 1);
    let mut canonical = Vec::new();
    let mut was_space = false;
    for byte in &bytes[start..end] {
        if space(*byte) {
            if !was_space {
                canonical.push(b' ')
            }
            was_space = true;
        } else {
            canonical.push(byte.to_ascii_lowercase());
            was_space = false;
        }
    }
    canonical
}
