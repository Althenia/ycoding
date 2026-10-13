use prost::Message;
use ycoding_protocol::{decode_lossless, decode_strict, encode_lossless, v5};

fn hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn typescript_model_reference_corpus_preserves_optional_empty_and_lone_units() {
    let bytes = hex("0a020a001204120200d81a020a00");
    let value = v5::ModelRef {
        id: encode_lossless(&[]),
        provider_id: encode_lossless(&[0xd800]),
        variant: Some(encode_lossless(&[])),
        profile: None,
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::ModelRef>(&bytes).unwrap();
    assert_eq!(
        decode_lossless(&decoded.provider_id, 1).unwrap(),
        vec![0xd800]
    );
    assert_eq!(
        decode_lossless(decoded.variant.as_ref().unwrap(), 0).unwrap(),
        Vec::<u16>::new()
    );
    assert!(decoded.profile.is_none());
    assert_eq!(decoded.encode_to_vec(), bytes);
}

#[test]
fn typescript_provider_request_corpus_preserves_required_empty_maps() {
    let bytes = hex("0a0012001a00");
    let value = v5::ProviderRequest {
        settings: v5::ProviderSettings { entries: vec![] },
        headers: v5::ProviderRequestHeaders { entries: vec![] },
        body: v5::ProviderRequestBody { entries: vec![] },
    };
    assert_eq!(value.encode_to_vec(), bytes);
    assert_eq!(
        decode_strict::<v5::ProviderRequest>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
    assert!(decode_strict::<v5::ProviderRequest>(&bytes[..4]).is_err());
}

#[test]
fn typescript_permission_and_typed_error_corpus_preserves_closed_enums() {
    let permission = hex("0a030a012a12020a001801");
    let value = v5::PermissionRule {
        action: encode_lossless(&[42]),
        resource: encode_lossless(&[]),
        effect: 1,
    };
    assert_eq!(value.encode_to_vec(), permission);
    assert_eq!(
        decode_strict::<v5::PermissionRule>(&permission)
            .unwrap()
            .encode_to_vec(),
        permission
    );
    let error = hex("08011001");
    assert_eq!(
        decode_strict::<v5::ArtifactBadRequest>(&error)
            .unwrap()
            .encode_to_vec(),
        error
    );
    assert!(decode_strict::<v5::ArtifactBadRequest>(&[8, 1, 16, 99]).is_err());
}

#[test]
fn typescript_attempt_time_corpus_preserves_signed_fractional_milliseconds() {
    let bytes = hex("09000000000000e0bf11000000000000e03f");
    let value = v5::IntegrationAttemptTime {
        created: -0.5,
        expires: 0.5,
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::IntegrationAttemptTime>(&bytes).unwrap();
    assert_eq!(decoded.created, -0.5);
    assert_eq!(decoded.expires, 0.5);
    assert_eq!(decoded.encode_to_vec(), bytes);
}

#[test]
fn typescript_undefined_result_corpus_requires_an_explicit_none_branch() {
    let bytes = vec![18, 0];
    let value = v5::ModelDefaultResultData {
        kind: Some(v5::model_default_result_data::Kind::None(v5::Empty {})),
    };
    assert_eq!(value.encode_to_vec(), bytes);
    assert_eq!(
        decode_strict::<v5::ModelDefaultResultData>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
    assert!(decode_strict::<v5::ModelDefaultResultData>(&[]).is_err());
}

#[test]
fn typescript_artifact_revision_corpus_preserves_safe_uint64_integers() {
    let bytes = hex(&format!(
        "08ffffffffffffff0f12070a057061765f781a420a40{}",
        "61".repeat(64)
    ));
    let value = v5::ProjectArtifactApiExpectation {
        expected_revision: 9_007_199_254_740_991,
        expected_version_id: encode_lossless(&"pav_x".encode_utf16().collect::<Vec<_>>()),
        expected_digest: encode_lossless(&[97; 64]),
    };
    assert_eq!(value.encode_to_vec(), bytes);
    assert_eq!(
        decode_strict::<v5::ProjectArtifactApiExpectation>(&bytes)
            .unwrap()
            .expected_revision,
        9_007_199_254_740_991
    );
    let unsafe_value = v5::ProjectArtifactApiExpectation {
        expected_revision: 9_007_199_254_740_992,
        ..value
    };
    assert!(
        decode_strict::<v5::ProjectArtifactApiExpectation>(&unsafe_value.encode_to_vec()).is_err()
    );
}
