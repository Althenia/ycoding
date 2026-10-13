use prost::Message;
use ycoding_protocol::{WireError, decode_lossless, decode_strict, encode_lossless, v5};

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
fn typescript_prompt_presence_preserves_false_empty_collections_and_lone_keys() {
    let bytes = hex("12020a001a0022002a0c0a0a0a04120200d8120210003800");
    let value = v5::SessionPromptRequestPayload {
        text: encode_lossless(&[]),
        files: Some(v5::SessionPromptRequestPayloadFiles { items: vec![] }),
        agents: Some(v5::SessionPromptRequestPayloadAgents { items: vec![] }),
        resume: Some(false),
        metadata: Some(v5::SessionPromptRequestPayloadMetadata {
            entries: vec![v5::SessionPromptRequestPayloadMetadataEntry {
                key: encode_lossless(&[0xd800]),
                value: v5::Value {
                    kind: Some(v5::value::Kind::Boolean(false)),
                },
            }],
        }),
        ..Default::default()
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::SessionPromptRequestPayload>(&bytes).unwrap();
    assert!(decoded.id.is_none());
    assert_eq!(decoded.resume, Some(false));
    assert!(decoded.files.as_ref().unwrap().items.is_empty());
    assert!(decoded.agents.as_ref().unwrap().items.is_empty());
    assert_eq!(
        decode_lossless(&decoded.metadata.as_ref().unwrap().entries[0].key, 1).unwrap(),
        [0xd800]
    );
    assert_eq!(decoded.encode_to_vec(), bytes);
    assert_eq!(
        decode_strict::<v5::SessionPromptRequestPayload>(&bytes[4..]).unwrap_err(),
        WireError("required presence")
    );
}

#[test]
fn typescript_admission_records_preserve_safe_sequences_and_finite_timestamps() {
    let bytes = hex("08ffffffffffffff0f12020a001a020a0021000000000000e0bf280132040a020a003801");
    let mut value = v5::SessionPendingUser {
        admitted_seq: 9007199254740991,
        id: encode_lossless(&[]),
        session_id: encode_lossless(&[]),
        time_created: -0.5,
        r#type: 1,
        data: v5::SessionPendingUserData {
            text: encode_lossless(&[]),
            ..Default::default()
        },
        delivery: 1,
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::SessionPendingUser>(&bytes).unwrap();
    assert_eq!(decoded.admitted_seq, 9007199254740991);
    assert_eq!(decoded.time_created, -0.5);
    assert_eq!(decoded.encode_to_vec(), bytes);
    value.admitted_seq = 9007199254740992;
    assert_eq!(
        decode_strict::<v5::SessionPendingUser>(&value.encode_to_vec()).unwrap_err(),
        WireError("integer constraint")
    );
}

#[test]
fn typescript_goal_resume_text_and_clear_branches_remain_distinct() {
    for (bytes, kind) in [
        (
            hex("0a04120200d8"),
            v5::session_autonomy_set_value1_goal::Kind::Value1(encode_lossless(&[0xd800])),
        ),
        (
            hex("1001"),
            v5::session_autonomy_set_value1_goal::Kind::Value2(true),
        ),
        (
            hex("1a00"),
            v5::session_autonomy_set_value1_goal::Kind::Clear(v5::Empty {}),
        ),
    ] {
        let value = v5::SessionAutonomySetValue1Goal { kind: Some(kind) };
        assert_eq!(value.encode_to_vec(), bytes);
        assert_eq!(
            decode_strict::<v5::SessionAutonomySetValue1Goal>(&bytes)
                .unwrap()
                .encode_to_vec(),
            bytes
        );
    }
    let clear = hex("0a021200");
    let value = v5::SessionDaybreakSetRequestPayload {
        daybreak: v5::SessionDaybreakSetRequestPayloadDaybreak {
            kind: Some(
                v5::session_daybreak_set_request_payload_daybreak::Kind::Clear(v5::Empty {}),
            ),
        },
    };
    assert_eq!(value.encode_to_vec(), clear);
    assert_eq!(
        decode_strict::<v5::SessionDaybreakSetRequestPayload>(&[]).unwrap_err(),
        WireError("required presence")
    );
    assert_eq!(
        decode_strict::<v5::SessionAutonomySetValue1Goal>(&[16, 1, 26, 0]).unwrap_err(),
        WireError("duplicate oneof")
    );
}

#[test]
fn typescript_instruction_errors_preserve_signed_int64_and_empty_message_presence() {
    let bytes = hex("080110ffffffffffffffffff0118804022020a00");
    let mut value = v5::InstructionEntryValueTooLargeError {
        tag: 1,
        actual_bytes: -1,
        max_bytes: 8192,
        message: encode_lossless(&[]),
    };
    assert_eq!(value.encode_to_vec(), bytes);
    let decoded = decode_strict::<v5::InstructionEntryValueTooLargeError>(&bytes).unwrap();
    assert_eq!(decoded.actual_bytes, -1);
    assert_eq!(decoded.encode_to_vec(), bytes);
    value.actual_bytes = -9007199254740992;
    assert_eq!(
        decode_strict::<v5::InstructionEntryValueTooLargeError>(&value.encode_to_vec())
            .unwrap_err(),
        WireError("integer constraint")
    );
}

#[test]
fn typescript_nonempty_forms_and_relocated_file_diffs_preserve_bounds_and_bytes() {
    let field = hex("0a0922070a030a016b3001");
    let value = v5::FormFields {
        items: vec![v5::FormField {
            kind: Some(v5::form_field::Kind::Value4(v5::FormBooleanField {
                key: encode_lossless(&[107]),
                r#type: 1,
                ..Default::default()
            })),
        }],
    };
    assert_eq!(value.encode_to_vec(), field);
    assert_eq!(
        decode_strict::<v5::FormFields>(&field)
            .unwrap()
            .encode_to_vec(),
        field
    );
    assert_eq!(
        decode_strict::<v5::FormFields>(&[]).unwrap_err(),
        WireError("count constraint")
    );
    let bytes = hex("0a04120200d812020a00180020012801");
    let value = v5::FileDiffInfo {
        file: encode_lossless(&[0xd800]),
        patch: encode_lossless(&[]),
        additions: 0,
        deletions: 1,
        status: 1,
    };
    assert_eq!(value.encode_to_vec(), bytes);
    assert_eq!(
        decode_strict::<v5::FileDiffInfo>(&bytes)
            .unwrap()
            .encode_to_vec(),
        bytes
    );
}
