#[path = "../operation_generation.rs"]
mod operation_generation;

use std::{collections::HashSet, fs, process::Command};

#[test]
fn operation_generation_rejects_invalid_contracts() {
    let annotation = r#"option (ycoding.v5.operation) = {
      operation_id: 3000 diagnostic_name: "test.read" roles: LOCAL_CLIENT
      scope: MACHINE mutation: READ settlement: COMPLETED paging: UNPAGED
      streaming: INLINE sensitivity: PRIVATE
    };"#;
    for (name, methods, first, error) in [
        (
            "duplicate",
            format!(
                "rpc Read(Empty) returns (Empty) {{ {annotation} }} rpc Again(Empty) returns (Empty) {{ {annotation} }}"
            ),
            3000,
            "duplicate operation ID",
        ),
        (
            "missing",
            "rpc Read(Empty) returns (Empty);".into(),
            3000,
            "missing operation annotation",
        ),
        (
            "range",
            format!("rpc Read(Empty) returns (Empty) {{ {annotation} }}"),
            3001,
            "outside declared range",
        ),
        (
            "unknown",
            format!(
                "rpc Read(Empty) returns (Empty) {{ {} }}",
                annotation.replace(
                    "operation_id: 3000",
                    "operation_id: 3000 error_types: \"ycoding.v5.Missing\""
                )
            ),
            3000,
            "unknown operation type",
        ),
    ] {
        let dir =
            std::env::temp_dir().join(format!("ycoding-operation-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("fixture.proto"),
            format!(
                r#"syntax = "proto2"; package ycoding.v5;
import "ycoding/v5/foundation.proto"; import "ycoding/v5/operations.proto";
option (ycoding.v5.operation_range) = {{ first: {first} last: 3999 }};
service Fixture {{ {methods} }}"#
            ),
        )
        .unwrap();
        let result = Command::new(
            std::env::var("PROTOC").unwrap_or_else(|_| "/opt/homebrew/bin/protoc".into()),
        )
        .arg(format!(
            "--proto_path={}/../../../protocol",
            env!("CARGO_MANIFEST_DIR")
        ))
        .arg(format!("--proto_path={}", dir.display()))
        .arg("--include_imports")
        .arg(format!(
            "--descriptor_set_out={}/contract.bin",
            dir.display()
        ))
        .arg(dir.join("fixture.proto"))
        .output()
        .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let types = HashSet::from(["ycoding.v5.Empty".to_owned()]);
        assert!(
            operation_generation::read_public_events(&fs::read(dir.join("contract.bin")).unwrap())
                .unwrap()
                .is_empty()
        );
        operation_generation::validate_codec_names(&fs::read(dir.join("contract.bin")).unwrap())
            .unwrap();
        assert!(
            operation_generation::read_constraints(&fs::read(dir.join("contract.bin")).unwrap())
                .unwrap()
                .is_empty()
        );
        let result = operation_generation::read_operations(
            &fs::read(dir.join("contract.bin")).unwrap(),
            &types,
        );
        assert!(result.unwrap_err().contains(error));
        fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn canonical_descriptor_and_metadata_are_extracted() {
    use prost::Message;
    let dir =
        std::env::temp_dir().join(format!("ycoding-operation-positive-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    fs::write(dir.join("fixture.proto"), r#"syntax = "proto2"; package ycoding.v5;
import "ycoding/v5/foundation.proto"; import "ycoding/v5/operations.proto";
option (ycoding.v5.operation_range) = { first: 3000 last: 3999 };
message Checked { required int64 value = 1 [(ycoding.v5.constraints) = { integer_min: "-9007199254740991" integer_max: "9007199254740991" domain_obligations: "packages/schema/src/schema.ts#PositiveInt" }]; }
service Fixture { rpc Read(Checked) returns (Empty) { option (ycoding.v5.operation) = {
operation_id: 3000 diagnostic_name: "test.read" roles: LOCAL_CLIENT roles: LOCAL_CLIENT scope: MACHINE mutation: READ settlement: COMPLETED paging: UNPAGED streaming: INLINE sensitivity: PRIVATE
}; } }"#).unwrap();
    let result =
        Command::new(std::env::var("PROTOC").unwrap_or_else(|_| "/opt/homebrew/bin/protoc".into()))
            .arg(format!("--proto_path={}/protocol", root.display()))
            .arg(format!("--proto_path={}", dir.display()))
            .arg("--include_imports")
            .arg(format!(
                "--descriptor_set_out={}/contract.bin",
                dir.display()
            ))
            .arg(dir.join("fixture.proto"))
            .output()
            .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let bytes = fs::read(dir.join("contract.bin")).unwrap();
    let types = HashSet::from([
        "ycoding.v5.Checked".to_owned(),
        "ycoding.v5.Empty".to_owned(),
    ]);
    let operations = operation_generation::read_operations(&bytes, &types).unwrap();
    assert_eq!(operations.len(), 1);
    let roles = operation_generation::read_role_allowlists(&operations, &[1, 2, 3, 4, 5]).unwrap();
    assert_eq!(roles[&1], [3000]);
    for role in [2, 3, 4, 5] {
        assert!(roles[&role].is_empty());
    }
    assert!(
        operation_generation::read_role_allowlists(&operations, &[2])
            .unwrap_err()
            .contains("unknown operation role")
    );
    let descriptor =
        ycoding_protocol::v5::OperationDescriptor::decode(operations[0].1.as_slice()).unwrap();
    assert_eq!(descriptor.operation_id, 3000);
    assert_eq!(descriptor.request_type, "ycoding.v5.Checked");
    assert_eq!(descriptor.result_type, "ycoding.v5.Empty");
    ycoding_protocol::validate_binary("ycoding.v5.OperationDescriptor", &operations[0].1).unwrap();
    assert!(
        operation_generation::read_constraints(&bytes).unwrap()["ycoding.v5.Checked.1"]
            .rule
            .contains("integer_min: Some(-9007199254740991)")
    );
    assert_eq!(
        operation_generation::read_constraints(&bytes).unwrap()["ycoding.v5.Checked.1"].obligations,
        ["packages/schema/src/schema.ts#PositiveInt"]
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn codec_name_gate_rejects_rust_and_nested_typescript_collisions() {
    let dir = std::env::temp_dir().join(format!("ycoding-codec-names-{}", std::process::id()));
    fs::create_dir_all(dir.join("ycoding/v5")).unwrap();
    for (name, definitions, reasons, count) in [
        (
            "draft",
            "message browser_action_Result {} message Browser_ActionResult {} message isolatedBrowser_action_Result {} message IsolatedBrowser_ActionResult {}",
            vec![
                "Rust ycoding::v5::BrowserActionResult",
                "Rust ycoding::v5::IsolatedBrowserActionResult",
            ],
            2,
        ),
        (
            "nested",
            "message FooBar {} enum foo_bar { VALUE = 1; } message Parent { message Child {} } message Parent_Child {}",
            vec!["Rust ycoding::v5::FooBar", "TypeScript Parent_Child"],
            3,
        ),
    ] {
        let file = dir.join(format!("ycoding/v5/{name}.proto"));
        fs::write(
            &file,
            format!("syntax = \"proto2\"; package ycoding.v5; {definitions}"),
        )
        .unwrap();
        let result = Command::new(
            std::env::var("PROTOC").unwrap_or_else(|_| "/opt/homebrew/bin/protoc".into()),
        )
        .arg(format!("--proto_path={}", dir.display()))
        .arg(format!(
            "--descriptor_set_out={}/contract.bin",
            dir.display()
        ))
        .arg(file)
        .output()
        .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let error = operation_generation::validate_codec_names(
            &fs::read(dir.join("contract.bin")).unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.lines().count(), count);
        for reason in reasons {
            assert!(error.contains(reason), "{error}");
        }
    }
    fs::remove_dir_all(dir).unwrap();
}
