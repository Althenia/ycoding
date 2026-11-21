use ycoding_core::resources::config::decode_document;

#[test]
fn parser_diagnostic_codes_order_and_utf16_offsets_match_jsonc_parser_3_3_1() {
    for (text, expected) in [
        (
            "{ invalid",
            "InvalidSymbol at offset 2; CloseBraceExpected at offset 9",
        ),
        ("{\"shell\":}", "ValueExpected at offset 9"),
        (
            "{/* unfinished",
            "UnexpectedEndOfComment at offset 1; CloseBraceExpected at offset 14",
        ),
        (
            "{\"shell\":\"bad\\q\"}",
            "InvalidEscapeCharacter at offset 9",
        ),
        ("{} false", "EndOfFileExpected at offset 3"),
        ("[1,,]", "ValueExpected at offset 3"),
        ("[,]", "ValueExpected at offset 1"),
        ("{,}", "ValueExpected at offset 1"),
        ("{\"a\" 1}", "ColonExpected at offset 5"),
        ("{\"a\":1 \"b\":2}", "CommaExpected at offset 7"),
        ("[1 2]", "CommaExpected at offset 3"),
        ("", "ValueExpected at offset 0"),
        ("// comment", "ValueExpected at offset 10"),
        ("\"unclosed", "UnexpectedEndOfString at offset 0"),
        ("\"a\n", "UnexpectedEndOfString at offset 0"),
        ("\"\\u12\"", "InvalidUnicode at offset 0"),
        ("1.", "UnexpectedEndOfNumber at offset 0"),
        ("1e+", "UnexpectedEndOfNumber at offset 0"),
        ("00", "EndOfFileExpected at offset 1"),
        ("-", "InvalidSymbol at offset 0; ValueExpected at offset 1"),
        ("\u{feff}{}", "InvalidSymbol at offset 0"),
        (
            "{\"username\":\"😀\"} false",
            "EndOfFileExpected at offset 18",
        ),
    ] {
        let decoded = decode_document(text, "fixture.jsonc");
        assert!(decoded.info.is_none(), "{text}");
        assert_eq!(decoded.diagnostics.len(), 1, "{text}");
        assert_eq!(
            decoded.diagnostics[0].message.as_str(),
            Some(expected),
            "{text}"
        );
    }
}
