use ycoding_core::tools::code_mode::{DiagnosticKind, Program};

#[test]
fn confined_frontend_rejects_capabilities_before_execution() {
    for source in [
        "return eval('1');",
        "return Function('return process')();",
        "return globalThis.process;",
        "return ({x: 1}).constructor;",
        "class Host {}",
        "function* generator() { yield 1; }",
    ] {
        let diagnostics = Program::parse(source).expect_err(source);
        assert!(
            diagnostics
                .iter()
                .all(|item| item.kind == DiagnosticKind::UnsupportedSyntax),
            "{source}: {diagnostics:?}"
        );
    }
}

#[test]
fn frontend_accepts_erasable_typescript_and_implicit_async_return() {
    Program::parse("interface Row { id: number }; const row: Row = {id: 1}; return await Promise.resolve(row!.id as number);").unwrap();
}

#[test]
fn frontend_keeps_all_recovered_and_semantic_diagnostics() {
    let diagnostics = Program::parse("let item = 1; let item = 2; const bad;").unwrap_err();
    assert!(diagnostics.len() >= 2, "{diagnostics:?}");
    assert!(
        diagnostics
            .iter()
            .all(|item| item.kind == DiagnosticKind::ParseError)
    );
}

#[test]
fn diagnostic_indices_count_utf16_not_utf8() {
    let source = "const face = '😀'; class Host {}";
    let diagnostics = Program::parse(source).unwrap_err();
    let location = &diagnostics[0].location;
    assert_eq!(
        location.index,
        source[..source.find("class").unwrap()]
            .encode_utf16()
            .count()
    );
    assert_eq!(location.column, location.index);
    assert_eq!(location.line, 1);
}

#[test]
fn diagnostic_locations_follow_all_javascript_line_terminators() {
    for terminator in ["\r", "\r\n", "\n", "\u{2028}", "\u{2029}"] {
        let source = format!("const face='😀';{terminator}class Host {{}}");
        let errors = Program::parse(source.as_str()).unwrap_err();
        assert_eq!(errors[0].location.line, 2, "{terminator:?}: {errors:?}");
        assert_eq!(errors[0].location.column, 0, "{terminator:?}: {errors:?}");
        assert_eq!(
            errors[0].location.index,
            16 + terminator.encode_utf16().count()
        );
    }
}

#[test]
fn raw_utf16_source_is_retained_and_diagnostic_offsets_do_not_shift() {
    let mut units = "const value='".encode_utf16().collect::<Vec<_>>();
    units.extend([0xd800, 0xfffd]);
    units.extend("';\r\nclass Host {}".encode_utf16());
    let source = ycoding_schema::LosslessString::from_utf16(units.clone());
    let errors = Program::parse(source).unwrap_err();
    assert_eq!(errors[0].kind, DiagnosticKind::UnsupportedSyntax);
    assert_eq!(
        errors[0].location.index,
        units
            .iter()
            .position(|unit| *unit == u16::from(b';'))
            .unwrap()
            + 3
    );
    assert_eq!(errors[0].location.line, 2);
    assert_eq!(errors[0].location.column, 0);
    let retained = ycoding_schema::LosslessString::from_utf16(
        units[..units
            .iter()
            .position(|unit| *unit == u16::from(b';'))
            .unwrap()
            + 1]
            .to_vec(),
    );
    assert_eq!(
        Program::parse(retained.clone()).unwrap().source(),
        &retained
    );
}
