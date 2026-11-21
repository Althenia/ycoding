use ycoding_core::tools::code_mode::{DiagnosticKind, Program};

#[test]
fn typescript_frontend_rejects_imports_and_legacy_octal_escapes_as_parse_errors() {
    for source in [
        "import fs from 'fs';",
        "return ['\\377'.charCodeAt(0),'\\400']",
    ] {
        let errors = Program::parse(source).unwrap_err();
        assert_eq!(errors[0].kind, DiagnosticKind::ParseError, "{source}");
    }
}
