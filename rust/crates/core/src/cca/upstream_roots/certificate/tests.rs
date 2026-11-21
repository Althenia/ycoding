use super::*;

fn attribute(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut attribute = vec![0x06, 0x03, 0x55, 0x04, 0x03];
    attribute.extend(der::wrap(tag, value));
    der::wrap(0x30, &attribute)
}

fn name(tag: u8, value: &[u8]) -> Vec<u8> {
    der::wrap(0x30, &der::wrap(0x31, &attribute(tag, value)))
}

#[test]
fn name_comparison_normalizes_ascii_space_case_and_all_openssl_string_types() {
    let expected = canonical_name(&name(0x0c, b"example root")).unwrap();
    for tag in [0x0c, 0x13, 0x14, 0x16, 0x1a] {
        assert_eq!(
            canonical_name(&name(tag, b" EXAMPLE\t ROOT ")).unwrap(),
            expected
        );
    }
    let bmp: Vec<u8> = " EXAMPLE  ROOT "
        .encode_utf16()
        .flat_map(u16::to_be_bytes)
        .collect();
    assert_eq!(canonical_name(&name(0x1e, &bmp)).unwrap(), expected);
    let universal: Vec<u8> = " EXAMPLE  ROOT "
        .chars()
        .flat_map(|character| (character as u32).to_be_bytes())
        .collect();
    assert_eq!(canonical_name(&name(0x1c, &universal)).unwrap(), expected);
    assert_eq!(canonical_string("ÉCOLE".as_bytes()), "École".as_bytes());
    assert_eq!(canonical_string(b" \tROOT\r\n CA\x0b\x0c "), b"root ca");
    assert_ne!(
        canonical_name(&name(0x12, b"ROOT")).unwrap(),
        canonical_name(&name(0x0c, b"root")).unwrap()
    );
}

#[test]
fn multivalued_rdn_order_is_canonical_but_rdn_sequence_order_is_preserved() {
    let first = attribute(0x13, b"ROOT");
    let second = attribute(0x0c, b"org");
    let original = der::wrap(
        0x30,
        &der::wrap(0x31, &[first.clone(), second.clone()].concat()),
    );
    let reordered = der::wrap(
        0x30,
        &der::wrap(
            0x31,
            &[attribute(0x13, b"ORG"), attribute(0x0c, b"root")].concat(),
        ),
    );
    assert_eq!(
        canonical_name(&original).unwrap(),
        canonical_name(&reordered).unwrap()
    );
    let original = der::wrap(
        0x30,
        &[der::wrap(0x31, &first), der::wrap(0x31, &second)].concat(),
    );
    let reordered = der::wrap(
        0x30,
        &[der::wrap(0x31, &second), der::wrap(0x31, &first)].concat(),
    );
    assert_ne!(
        canonical_name(&original).unwrap(),
        canonical_name(&reordered).unwrap()
    );
}

#[test]
fn universal_and_bmp_names_reject_invalid_codepoints_without_structural_equality() {
    assert!(canonical_name(&name(0x1c, &[0, 0x11, 0, 0])).is_err());
    assert!(canonical_name(&name(0x1c, &[0, 0, 0xd8, 0])).is_err());
    assert!(canonical_name(&name(0x1e, &[0xd8, 0])).is_err());
    assert!(canonical_name(&name(0x0c, &[0xff])).is_err());
}

#[test]
fn utc_and_generalized_dates_cover_1950_to_9999_and_openssl_error_semantics() {
    assert_eq!(time_value(0x17, b"500101000000Z"), Some(-631_152_000));
    assert_eq!(time_value(0x17, b"691231235959Z"), Some(-1));
    assert_eq!(time_value(0x17, b"700101000000Z"), Some(0));
    assert_eq!(time_value(0x18, b"19691231235959Z"), Some(-1));
    assert!(time_value(0x17, b"491231235959Z").unwrap() > 0);
    assert!(time_value(0x18, b"99991231235959Z").unwrap() > 0);
    for invalid in [
        b"20230229000000Z".as_slice(),
        b"20240101000060Z",
        b"20240101000000+0000",
        b"20240101000000.0Z",
    ] {
        assert_eq!(time_value(0x18, invalid), None);
    }
}

#[test]
fn expiry_uses_whole_seconds_includes_boundary_and_does_not_expire_invalid_time() {
    let mut certificate = MacCertificate {
        pem: String::new(),
        identity: Vec::new(),
        self_issued: false,
        not_after: Some(100),
    };
    assert!(!certificate.expired_at(std::time::Duration::from_millis(99_999)));
    assert!(certificate.expired_at(std::time::Duration::from_secs(100)));
    assert!(certificate.expired_at(std::time::Duration::from_secs(101)));
    certificate.not_after = Some(-1);
    assert!(certificate.expired_at(std::time::Duration::ZERO));
    certificate.not_after = None;
    assert!(!certificate.expired_at(std::time::Duration::from_secs(100)));
}

#[test]
fn der_reader_accepts_universal_string_and_rejects_truncation_and_indefinite_length() {
    let mut input = b"\x1c\x04\x00\x00\x00A".as_slice();
    assert_eq!(der::take(&mut input).unwrap().contents, b"\x00\x00\x00A");
    assert!(input.is_empty());
    for invalid in [
        b"\x30\x80\x00\x00".as_slice(),
        b"\x30\x82\x01",
        b"\x30\x04\x00",
    ] {
        assert!(der::take(&mut &invalid[..]).is_err());
    }
}

#[test]
fn malformed_native_certificate_is_distinct_from_unsupported_openssl_ber() {
    assert!(decode_system_der(b"\x30\x00").unwrap().is_none());
    assert!(matches!(
        decode_system_der(b"\x30\x80\x00\x00"),
        Err(RootError::NativeCertificate(_))
    ));
}

#[test]
fn v2_unique_id_tbs_retains_subject_spki_without_typed_dates() {
    let algorithm = der::wrap(0x30, b"\x06\x02\x2a\x03");
    let subject = name(0x1c, &[0, 0, 0, b'A']);
    let mut validity = der::wrap(0x17, b"650101000000Z");
    validity.extend(der::wrap(0x18, b"99991231235959Z"));
    let mut spki = algorithm.clone();
    spki.extend(der::wrap(0x03, &[0, 1]));
    let mut tbs = der::wrap(0xa0, b"\x02\x01\x01");
    tbs.extend_from_slice(b"\x02\x01\x01");
    tbs.extend(algorithm);
    tbs.extend_from_slice(&subject);
    tbs.extend(der::wrap(0x30, &validity));
    tbs.extend_from_slice(&subject);
    tbs.extend(der::wrap(0x30, &spki));
    tbs.extend_from_slice(b"\x81\x02\x00\x01\x82\x02\x00\x02");
    let encoded = der::wrap(0x30, &tbs);
    let fields = tbs_fields(&encoded).unwrap();
    assert_eq!(fields.subject, subject.as_slice());
    assert_eq!(fields.spki, spki);
    assert_eq!(fields.not_after, Some(253_402_300_799));
    assert!(fields.name_constraints.is_none());
}

#[test]
fn constraints_extension_retains_its_sequence_contents_and_rejects_duplicates() {
    let constraint_value = b"\x30\x0a\xa0\x08\x30\x06\x82\x04test";
    let mut extension = vec![0x06, 0x03, 0x55, 0x1d, 0x1e, 0x01, 0x01, 0xff];
    extension.extend(der::wrap(0x04, constraint_value));
    let extension = der::wrap(0x30, &extension);
    let encoded = der::wrap(0xa3, &der::wrap(0x30, &extension));
    assert_eq!(
        constraints(&encoded).unwrap().unwrap(),
        &constraint_value[2..]
    );
    let duplicate = der::wrap(
        0xa3,
        &der::wrap(0x30, &[extension.clone(), extension].concat()),
    );
    assert!(constraints(&duplicate).is_err());
}

#[test]
fn bundled_anchor_components_match_existing_rustls_extraction_without_default_roots() {
    for pem in super::super::bundled::NODE_26_4_ROOTS {
        let (_, bytes) = super::super::decode_pem_detect(pem.as_bytes()).unwrap();
        let actual = trust_anchor(&bytes).unwrap();
        let mut expected = rustls::RootCertStore::empty();
        expected
            .add(rustls::pki_types::CertificateDer::from(bytes))
            .unwrap();
        assert_eq!(actual.subject, expected.roots[0].subject);
        assert_eq!(
            actual.subject_public_key_info,
            expected.roots[0].subject_public_key_info
        );
        assert_eq!(actual.name_constraints, expected.roots[0].name_constraints);
    }
}
