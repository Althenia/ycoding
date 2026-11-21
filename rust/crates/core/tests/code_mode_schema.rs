use ycoding_core::tools::code_mode::{ToolDescription, schema};
use ycoding_schema::{JsonObject, JsonValue, LosslessString, parse_json};

#[test]
fn signatures_quote_keys_intersect_siblings_resolve_refs_and_bound_recursion() {
    for (input, expected) in [
        (
            r#"{"type":"object","properties":{"ordinary":{"type":"string"},"odd-name":{"type":"integer"}},"required":["odd-name"]}"#,
            r#"{ ordinary?: string; "odd-name": number }"#,
        ),
        (
            r##"{"$ref":"#/$defs/X","type":"array","items":{"type":"boolean"},"$defs":{"X":{"type":"string"}}}"##,
            "string & Array<boolean>",
        ),
        (
            r#"{"anyOf":[{"type":"string"},{"type":"number"}],"type":"array","items":{"type":"null"}}"#,
            "(string | number) & Array<null>",
        ),
        (
            r##"{"allOf":[{"type":"object","properties":{"a":{"type":"string"}}},{"$ref":"#/$defs/Missing"}]}"##,
            "unknown",
        ),
        (
            r##"{"$ref":"#/$defs/Loop","$defs":{"Loop":{"$ref":"#/$defs/Loop"}}}"##,
            "unknown",
        ),
        (
            r#"{"anyOf":[{"type":"number"},{"type":"string","enum":["NaN"]},{"type":"string","enum":["Infinity"]}]}"#,
            "number",
        ),
        (r#"{"anyOf":[{"type":"object"},{"type":"array"}]}"#, "{}"),
        (r#"{"type":["string","null"]}"#, "string | null"),
        (r#"{"const":null}"#, "null"),
        (
            r##"{"$ref":"#/$defs/","$defs":{"":{"type":"string"}}}"##,
            "unknown",
        ),
        (r#"{"$ref":"","type":"string"}"#, "string"),
    ] {
        assert_eq!(
            schema::to_typescript(&parse_json(input).unwrap(), false),
            expected,
            "{input}"
        );
    }
}

#[test]
fn pretty_signatures_include_owned_jsdoc_and_catalog_parameter_metadata() {
    let input=parse_json(r#"{"type":"object","properties":{"id":{"type":"string","description":"Close */ safely","deprecated":true,"default":"x","format":"uuid"},"items":{"type":"array","items":{"type":"integer"},"minItems":1,"maxItems":3}},"required":["id"]}"#).unwrap();
    assert_eq!(
        schema::to_typescript(&input, true),
        "{\n  /**\n   * Close * / safely\n   * @deprecated\n   * @default \"x\"\n   * @format uuid\n   */\n  id: string,\n  /**\n   * @minItems 1\n   * @maxItems 3\n   */\n  items?: Array<number>,\n}"
    );
    let tool =
        ToolDescription::from_schemas("odd-name.call".into(), "Look up".into(), &input, None);
    assert!(
        tool.signature
            .starts_with("tools[\"odd-name\"].call(input: {")
    );
    assert!(tool.signature.ends_with("): Promise<unknown>"));
    assert_eq!(
        tool.input_properties[0],
        ("id".into(), Some("Close */ safely".into()))
    );
}

#[test]
fn deeply_nested_signatures_stop_at_the_documented_depth_without_panicking() {
    let mut document = parse_json("{\"type\":\"string\"}").unwrap();
    for _ in 0..128 {
        let mut object = JsonObject::new();
        object.insert("type".into(), JsonValue::String("array".into()));
        object.insert("items".into(), document);
        document = JsonValue::Object(object);
    }
    assert_eq!(
        schema::to_typescript(&document, false),
        format!("{}unknown{}", "Array<".repeat(9), ">".repeat(9))
    );
}

#[test]
fn schema_parameter_names_retain_raw_utf16_identity() {
    let input =
        parse_json(r#"{"type":"object","properties":{"\ud800":{"type":"string"}}}"#).unwrap();
    let tool = ToolDescription::from_schemas("host.call".into(), "Call".into(), &input, None);
    assert_eq!(
        JsonValue::String(tool.input_properties[0].0.clone()),
        JsonValue::String(LosslessString::from_utf16(vec![0xd800]))
    );
}
