use ycoding_schema::{
    JsonErrorKind, JsonObject, JsonValue, LosslessString, parse_json, stringify_json,
};

#[test]
fn bun_golden_vectors() {
    let inputs: Vec<String> =
        serde_json::from_str(include_str!("fixtures/domain-json-inputs.json")).unwrap();
    let expected: Vec<String> =
        serde_json::from_str(include_str!("fixtures/domain-json-expected.json")).unwrap();
    assert_eq!(inputs.len(), expected.len());
    assert!(inputs.len() > 60_000);
    for (index, (input, expected)) in inputs.iter().zip(&expected).enumerate() {
        let value = parse_json(input).unwrap();
        let output = stringify_json(&value);
        assert_eq!(&output, expected, "vector {index}: {input}");
        assert_eq!(stringify_json(&parse_json(&output).unwrap()), output);
    }
}

#[test]
fn canonical_strings_and_code_unit_order() {
    for units in [
        vec![],
        vec![65],
        vec![0xd800],
        vec![0xdc00],
        vec![0xd83d, 0xde00],
        vec![65, 0xd800, 98, 0xdc00],
        vec![0xfeff, 0xfffe, 0xd800],
    ] {
        let text = LosslessString::from_utf16(units.clone());
        assert_eq!(text.code_units().collect::<Vec<_>>(), units);
        assert_eq!(text.len(), units.len());
        assert_eq!(text.is_empty(), units.is_empty());
        assert_eq!(text.as_str().is_some(), String::from_utf16(&units).is_ok());
        assert_eq!(
            text.as_utf16_units().is_some(),
            String::from_utf16(&units).is_err()
        );
        assert_eq!(text.to_utf8().is_err(), String::from_utf16(&units).is_err());
        assert_eq!(text.to_utf8().ok(), String::from_utf16(&units).ok());
        assert_eq!(
            String::try_from(text.clone()).ok(),
            String::from_utf16(&units).ok()
        );
        assert_eq!(
            LosslessString::from_utf16(text.code_units().collect()),
            text
        );
    }
    assert_eq!(
        LosslessString::from("😀"),
        LosslessString::from_utf16(vec![0xd83d, 0xde00])
    );
    assert!(LosslessString::from("😀") < LosslessString::from("\u{e000}"));
    assert_ne!(
        LosslessString::from("\\ud800"),
        LosslessString::from_utf16(vec![0xd800])
    );
    assert_ne!(
        LosslessString::from("�"),
        LosslessString::from_utf16(vec![0xd800])
    );
}

#[test]
fn object_order_and_duplicate_keys() {
    let input = r#"{"b":1,"10":2,"2":3,"01":4,"4294967294":5,"4294967295":6,"0":7,"-0":8,"a":9,"b":10,"\u0061":11}"#;
    assert_eq!(
        stringify_json(&parse_json(input).unwrap()),
        r#"{"0":7,"2":3,"10":2,"4294967294":5,"b":10,"01":4,"4294967295":6,"-0":8,"a":11}"#
    );
    let mut object = JsonObject::new();
    object.insert("z".into(), JsonValue::Bool(false));
    object.insert("2".into(), JsonValue::Null);
    object.insert("1".into(), JsonValue::Number(0.0));
    object.insert("z".into(), JsonValue::Bool(true));
    assert_eq!(object.get(&"z".into()), Some(&JsonValue::Bool(true)));
    assert_eq!(
        object
            .iter()
            .map(|(key, _)| key.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["1", "2", "z"]
    );
    assert_eq!(
        stringify_json(&JsonValue::Object(object)),
        r#"{"1":0,"2":null,"z":true}"#
    );
}

#[test]
fn malformed_inputs_have_typed_errors() {
    for input in [
        "",
        " ",
        "undefined",
        "NaN",
        "Infinity",
        "+1",
        "01",
        "-",
        "1.",
        "1e",
        "1e+",
        ".1",
        "[1,]",
        "[,1]",
        "{\"a\":}",
        "{\"a\" 1}",
        "{\"a\":1,}",
        "{a:1}",
        "{}x",
        "true false",
        "\u{feff}null",
        "\"\n\"",
        "\"\\x20\"",
        "\"\\u12\"",
        "\"\\uGGGG\"",
        "\"unterminated",
        "[",
        "{",
    ] {
        let error = parse_json(input).expect_err(input);
        assert!(error.offset <= input.len());
    }
    assert_eq!(
        parse_json("[1,]").unwrap_err().kind,
        JsonErrorKind::UnexpectedToken
    );
    assert_eq!(
        parse_json("\"\\uGGGG\"").unwrap_err().kind,
        JsonErrorKind::InvalidEscape
    );
    assert_eq!(
        parse_json("1.").unwrap_err().kind,
        JsonErrorKind::InvalidNumber
    );
    assert_eq!(
        parse_json("true false").unwrap_err().kind,
        JsonErrorKind::TrailingInput
    );
}

struct Random(u64);
impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn text(&mut self) -> LosslessString {
        let length = self.next() % 20;
        LosslessString::from_utf16((0..length).map(|_| self.next() as u16).collect())
    }
    fn value(&mut self, depth: usize) -> JsonValue {
        match self.next() % if depth == 0 { 4 } else { 6 } {
            0 => JsonValue::Null,
            1 => JsonValue::Bool(self.next().is_multiple_of(2)),
            2 => {
                let number = f64::from_bits(self.next());
                JsonValue::Number(if number.is_finite() { number } else { 0.0 })
            }
            3 => JsonValue::String(self.text()),
            4 => {
                let length = self.next() % 8;
                JsonValue::Array((0..length).map(|_| self.value(depth - 1)).collect())
            }
            _ => {
                let mut object = JsonObject::new();
                for _ in 0..self.next() % 8 {
                    let key = self.text();
                    object.insert(key, self.value(depth - 1));
                }
                JsonValue::Object(object)
            }
        }
    }
}

#[test]
fn seeded_lossless_round_trips() {
    let mut random = Random(0xc0decafe12345678);
    for _ in 0..10_000 {
        let value = random.value(4);
        let json = stringify_json(&value);
        assert_eq!(parse_json(&json).unwrap(), value, "{json}");
    }
}

#[test]
fn stringify_nonfinite_and_negative_zero() {
    for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(stringify_json(&JsonValue::Number(number)), "null");
    }
    assert_eq!(stringify_json(&JsonValue::Number(-0.0)), "0");
    let JsonValue::Number(number) = parse_json("-0").unwrap() else {
        panic!()
    };
    assert!(number.is_sign_negative());
}

#[test]
fn numeric_boundaries_and_shortest_halfway_ties() {
    for (input, expected) in [
        ("9007199254740991", "9007199254740991"),
        ("9007199254740992", "9007199254740992"),
        ("9007199254740993", "9007199254740992"),
        ("1e21", "1e+21"),
        ("1e20", "100000000000000000000"),
        ("1e-6", "0.000001"),
        ("1e-7", "1e-7"),
        ("5e-324", "5e-324"),
        ("2.2250738585072014e-308", "2.2250738585072014e-308"),
        ("1.7976931348623157e308", "1.7976931348623157e+308"),
        ("-0", "0"),
        ("-1e-400", "0"),
        ("1.96780532656221325000e+15", "1967805326562213.2"),
        ("-1.96780532656221325000e+15", "-1967805326562213.2"),
    ] {
        assert_eq!(stringify_json(&parse_json(input).unwrap()), expected);
    }
    for (input, expected) in [("1e400", f64::INFINITY), ("-1e400", f64::NEG_INFINITY)] {
        assert_eq!(parse_json(input).unwrap(), JsonValue::Number(expected));
    }
}

#[test]
fn exact_units_in_values_and_dynamic_keys() {
    for units in [
        vec![0xd800],
        vec![0xdc00],
        vec![0xd83d, 0xde00],
        vec![65, 0xd800, 98, 0xdc00],
        vec![0xd800, 0xd83d, 0xde00, 0xdc00],
    ] {
        let text = LosslessString::from_utf16(units.clone());
        let mut object = JsonObject::new();
        object.insert(text.clone(), JsonValue::String(text.clone()));
        let json = stringify_json(&JsonValue::Object(object));
        let JsonValue::Object(parsed) = parse_json(&json).unwrap() else {
            panic!()
        };
        let (key, JsonValue::String(value)) = parsed.iter().next().unwrap() else {
            panic!()
        };
        assert_eq!(key.code_units().collect::<Vec<_>>(), units);
        assert_eq!(value.code_units().collect::<Vec<_>>(), units);
        assert_eq!(parsed.get(&text), Some(&JsonValue::String(text)));
    }
    assert_eq!(
        stringify_json(&parse_json(r#""\uD800\uDC00\uD800\uDC01\uDC00""#).unwrap()),
        "\"𐀀𐀁\\udc00\""
    );
    assert_eq!(
        parse_json(r#""\u0061""#).unwrap(),
        parse_json("\"a\"").unwrap()
    );
    assert_eq!(
        parse_json(r#""\ud83d\ude00""#).unwrap(),
        parse_json("\"😀\"").unwrap()
    );
}

#[test]
fn absence_null_and_empty_remain_distinct() {
    let JsonValue::Object(object) =
        parse_json(r#"{"null":null,"false":false,"zero":0,"empty":"","array":[],"object":{}}"#)
            .unwrap()
    else {
        panic!()
    };
    assert_eq!(object.get(&"absent".into()), None);
    assert_eq!(object.get(&"null".into()), Some(&JsonValue::Null));
    assert_eq!(object.get(&"false".into()), Some(&JsonValue::Bool(false)));
    assert_eq!(object.get(&"zero".into()), Some(&JsonValue::Number(0.0)));
    assert_eq!(
        object.get(&"empty".into()),
        Some(&JsonValue::String("".into()))
    );
    assert_eq!(object.get(&"array".into()), Some(&JsonValue::Array(vec![])));
    assert_eq!(
        object.get(&"object".into()),
        Some(&JsonValue::Object(JsonObject::new()))
    );
}
