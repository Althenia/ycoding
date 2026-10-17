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
        let result = Command::new(std::env::var("PROTOC").unwrap_or_else(|_| "protoc".into()))
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
    let result = Command::new(std::env::var("PROTOC").unwrap_or_else(|_| "protoc".into()))
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
fn test_027_descriptor_membership_is_exhaustive_and_partitioned_by_role() {
    use std::collections::BTreeMap;
    let operations = &*ycoding_protocol::OPERATIONS;
    assert_eq!(operations.len(), 227);
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut patterns: BTreeMap<Vec<i32>, usize> = BTreeMap::new();
    for operation in operations {
        assert!(
            ids.insert(operation.operation_id),
            "duplicate id {}",
            operation.operation_id
        );
        assert!(
            names.insert(operation.diagnostic_name.clone()),
            "duplicate name {}",
            operation.diagnostic_name
        );
        assert!(
            !operation.roles.is_empty(),
            "{} has no role",
            operation.diagnostic_name
        );
        *patterns.entry(operation.roles.clone()).or_default() += 1;
        for ty in [&operation.request_type, &operation.result_type] {
            assert_ne!(
                ycoding_protocol::validate_binary(ty, &[])
                    .err()
                    .map(|error| error.0),
                Some("unknown type"),
                "{} type {ty}",
                operation.diagnostic_name
            );
        }
        for ty in &operation.error_types {
            assert_ne!(
                ycoding_protocol::validate_binary(ty, &[])
                    .err()
                    .map(|error| error.0),
                Some("unknown type"),
                "{} error type {ty}",
                operation.diagnostic_name
            );
        }
        let public_types: HashSet<&str> = ycoding_protocol::PUBLIC_EVENTS
            .iter()
            .map(|(_, _, _, ty)| *ty)
            .collect();
        for event in &operation.event_types {
            assert!(
                public_types.contains(event.as_str())
                    || event == "ycoding.v5.PublicEvent"
                    || event == "ycoding.v5.SessionLogItem",
                "{} event type {event} is not a declared public event",
                operation.diagnostic_name
            );
        }
    }
    assert_eq!(
        patterns,
        BTreeMap::from([
            (vec![1], 151),
            (vec![1, 2, 3], 58),
            (vec![2, 3], 14),
            (vec![2], 4),
        ]),
        "a new operation role pattern or count needs an explicit assertion mapping"
    );
    for (role, ids_for_role) in ycoding_protocol::OPERATION_IDS_BY_ROLE {
        let expected: Vec<u32> = operations
            .iter()
            .filter(|operation| operation.roles.contains(role))
            .map(|operation| operation.operation_id)
            .collect();
        assert_eq!(*ids_for_role, expected, "role {role} allowlist");
    }
    let mut event_names = HashSet::new();
    for (name, _, tag, _) in ycoding_protocol::PUBLIC_EVENTS {
        assert!(event_names.insert(*name), "duplicate public event {name}");
        assert!(*tag > 0, "public event {name} has no tag");
    }
}

#[test]
fn test_030_rust_generation_twice_in_scratch_is_byte_identical() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let protoc = std::env::var("PROTOC").unwrap_or_else(|_| "protoc".into());
    let types: HashSet<String> = ycoding_protocol::OPERATIONS
        .iter()
        .flat_map(|operation| {
            operation
                .error_types
                .iter()
                .cloned()
                .chain(operation.event_types.iter().cloned())
                .chain([
                    operation.request_type.clone(),
                    operation.result_type.clone(),
                ])
        })
        .collect();
    let mut outputs = Vec::new();
    for run in 0..2 {
        let dir =
            std::env::temp_dir().join(format!("ycoding-generation-{}-{run}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("ycoding/v5")).unwrap();
        let mut files = Vec::new();
        for entry in fs::read_dir(root.join("protocol/ycoding/v5")).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "proto") {
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                fs::copy(&path, dir.join("ycoding/v5").join(&name)).unwrap();
                files.push(format!("ycoding/v5/{name}"));
            }
        }
        files.sort();
        let result = Command::new(&protoc)
            .arg(format!("--proto_path={}", dir.display()))
            .arg("--include_imports")
            .arg(format!(
                "--descriptor_set_out={}/contract.bin",
                dir.display()
            ))
            .args(&files)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let bytes = fs::read(dir.join("contract.bin")).unwrap();
        let operations = operation_generation::read_operations(&bytes, &types).unwrap();
        let roles =
            operation_generation::read_role_allowlists(&operations, &[1, 2, 3, 4, 5]).unwrap();
        let mut constraints: Vec<_> = operation_generation::read_constraints(&bytes)
            .unwrap()
            .into_iter()
            .map(|(name, field)| (name, field.rule, field.obligations))
            .collect();
        constraints.sort();
        let events = operation_generation::read_public_events(&bytes).unwrap();
        outputs.push((bytes, operations, roles, constraints, events));
        fs::remove_dir_all(dir).unwrap();
    }
    assert_eq!(
        outputs[0], outputs[1],
        "descriptor and derived generation must be reproducible"
    );
    assert_eq!(outputs[0].1.len(), ycoding_protocol::OPERATIONS.len());
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
        let result = Command::new(std::env::var("PROTOC").unwrap_or_else(|_| "protoc".into()))
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
