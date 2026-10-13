use prost::Message;
use ycoding_core::extension::{Error, v5, wire};
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

#[test]
fn independent_golden_canonical_framing_and_strict_decode() {
    let frame = v5::ChildFrame {
        generation: "g".into(),
        body: Some(v5::child_frame::Body::Stopped(v5::Stopped {})),
    };
    assert_eq!(
        wire::encode(&frame).unwrap(),
        [5, 0, 0, 0, 10, 1, 103, 58, 0]
    );
    let mut decoder = wire::Decoder::default();
    assert!(decoder.push(&[5, 0], wire::FRAME_BYTES).unwrap().is_empty());
    assert_eq!(
        decoder
            .push(&[0, 0, 10, 1, 103, 58, 0], wire::FRAME_BYTES)
            .unwrap()
            .as_slice(),
        std::slice::from_ref(&frame)
    );
    for bytes in [
        vec![10, 1, 103, 58, 0, 58, 0],
        vec![10, 1, 103, 10, 1, 103, 58, 0],
        vec![10, 1, 103, 58, 0, 120, 1],
        vec![10, 1, 103, 58, 128],
        vec![58, 0],
    ] {
        assert_eq!(
            wire::decode::<v5::ChildFrame>(&bytes, ".ycoding.extension.v5.ChildFrame"),
            Err(Error::Protocol)
        );
    }
    assert_eq!(
        wire::decode::<v5::ChildFrame>(&frame.encode_to_vec(), ".ycoding.extension.v5.ChildFrame")
            .unwrap(),
        frame
    );
    assert!(decoder.is_empty());
    assert_eq!(
        decoder.push(&0u32.to_le_bytes(), wire::FRAME_BYTES),
        Err(Error::Protocol)
    );
    let mut decoder = wire::Decoder::default();
    assert_eq!(
        decoder.push(
            &((wire::FRAME_BYTES + 1) as u32).to_le_bytes(),
            wire::FRAME_BYTES
        ),
        Err(Error::Protocol)
    );
}

#[test]
fn values_preserve_lone_units_and_reject_duplicate_keys_nonfinite_or_deep_values() {
    let mut object = JsonObject::new();
    object.insert(
        LosslessString::from_utf16(vec![0xd800]),
        JsonValue::String(LosslessString::from_utf16(vec![0xdc00])),
    );
    let value = JsonValue::Object(object);
    assert_eq!(wire::read_value(wire::value(&value)).unwrap(), value);
    assert!(
        wire::read_text(v5::Text {
            encoding: Some(v5::text::Encoding::Utf16Le(vec![0]))
        })
        .is_err()
    );
    assert!(
        wire::read_text(v5::Text {
            encoding: Some(v5::text::Encoding::Utf16Le(vec![65, 0]))
        })
        .is_err()
    );
    assert!(
        wire::read_value(v5::Value {
            kind: Some(v5::value::Kind::Number(f64::NAN))
        })
        .is_err()
    );
    let entry = v5::Entry {
        key: wire::text(&"same".into()),
        value: wire::value(&JsonValue::Null),
    };
    assert!(
        wire::read_value(v5::Value {
            kind: Some(v5::value::Kind::Object(v5::Object {
                entries: vec![entry.clone(), entry]
            }))
        })
        .is_err()
    );
    let mut deep = JsonValue::Null;
    for _ in 0..70 {
        deep = JsonValue::Array(vec![deep]);
    }
    assert_eq!(wire::check_value(&deep), Err(Error::Protocol));
    let frame = v5::ChildFrame {
        generation: "g".into(),
        body: Some(v5::child_frame::Body::RegisterTools(v5::RegisterTools {
            transforms: vec![],
            domains: vec![],
            subscriptions: vec![],
            oauth: vec![],
            tools: vec![v5::Tool {
                namespace: "n".into(),
                name: "t".into(),
                description: wire::text(&"description".into()),
                input_schema: wire::value(&deep),
                output_schema: wire::value(&JsonValue::Null),
                direct: true,
                code_mode: true,
            }],
        })),
    };
    assert_eq!(
        wire::decode::<v5::ChildFrame>(&frame.encode_to_vec(), ".ycoding.extension.v5.ChildFrame"),
        Err(Error::Protocol)
    );
}
