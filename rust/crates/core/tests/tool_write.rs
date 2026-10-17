include!("policy_fixture.rs");
use std::{fs, sync::Arc};
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::{
    platform::{filesystem::mutation, git},
    process::guardrails::{Guardrails, Limits, Paths, Settings},
    tools::{
        builtin::{filesystem, write::Write},
        context::{Context, policy::LeafPolicy},
        registry::{Options, Registry},
    },
};
use ycoding_schema::{JsonValue, parse_json, permission};

#[tokio::test]
async fn creates_overwrites_preserves_bom_and_permission_denial_has_no_effect() {
    let fixture = Fixture::default();
    fixture.session("ses_write", None, 2, false, None);
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "*".into(),
        resource: "*".into(),
        effect: permission::Effect("allow".into()),
    });
    let root = std::env::temp_dir().join(format!(
        "tool_write_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&root).unwrap();
    let policy = Arc::new(LeafPolicy {
        permissions: fixture.permissions(),
        guardrails: Guardrails::new(
            fixture.authority(),
            fixture.permissions(),
            Settings {
                paths: Paths {
                    workdir: root.to_string_lossy().as_ref().into(),
                    project: root.to_string_lossy().as_ref().into(),
                    home: root.to_string_lossy().as_ref().into(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom: Arc::new(Vec::new),
                enabled: true,
                limits: Limits::default(),
                decide_reviews: false,
                decide_hard_reviews: true,
            },
            fixture.publisher(),
        ),
    });
    let registry = Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &ycoding_core::resources::config::Roots::development(&root).unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    );
    let _scope = registry
        .register(
            vec![(
                "write".into(),
                Arc::new(Write {
                    paths: Arc::new(filesystem::Paths {
                        directory: fs::canonicalize(&root).unwrap(),
                        data: root.join("data"),
                        git: Arc::new(git::Service::new(1024 * 1024)),
                    }),
                    files: Arc::new(mutation::Service::default()),
                    policy,
                }),
            )],
            Options::direct(),
        )
        .unwrap();
    let context = Context::new("ses_write", "test", "msg_write", "call_write").unwrap();
    assert_eq!(registry.materialize(&[]).definitions[0].input_schema, parse_json(r#"{"type":"object","properties":{"path":{"type":"string","description":"File path to write. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval."},"content":{"type":"string","description":"Content to write to the file"}},"required":["path","content"],"additionalProperties":false}"#).unwrap());
    assert_eq!(registry.materialize(&[]).definitions[0].output_schema, Some(parse_json(r#"{"type":"object","properties":{"operation":{"type":"string","enum":["write"]},"target":{"type":"string"},"resource":{"type":"string"},"existed":{"type":"boolean"}},"required":["operation","target","resource","existed"],"additionalProperties":false}"#).unwrap()));
    let output = registry
        .materialize(&[])
        .invoke(
            "write",
            parse_json(r#"{"path":"src/new.txt","content":"created"}"#).unwrap(),
            context.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Text(JsonValue::String(
            "Created file successfully: src/new.txt".into()
        ))
    );
    assert_eq!(
        fs::read_to_string(root.join("src/new.txt")).unwrap(),
        "created"
    );
    fs::write(root.join("src/new.txt"), "\u{feff}before").unwrap();
    let output = registry
        .materialize(&[])
        .invoke(
            "write",
            parse_json(r#"{"path":"src/new.txt","content":"\ufeff\ufeffafter"}"#).unwrap(),
            context.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Text(JsonValue::String(
            "Wrote file successfully: src/new.txt".into()
        ))
    );
    assert_eq!(
        fs::read_to_string(root.join("src/new.txt")).unwrap(),
        "\u{feff}after"
    );
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "edit".into(),
        resource: "*".into(),
        effect: permission::Effect("deny".into()),
    });
    let output = registry
        .materialize(&[])
        .invoke(
            "write",
            parse_json(r#"{"path":"src/denied.txt","content":"forbidden"}"#).unwrap(),
            context,
        )
        .await
        .unwrap();
    assert_eq!(
        output.result,
        ToolResultValue::Error(JsonValue::String("Unable to write src/denied.txt".into()))
    );
    assert!(!root.join("src/denied.txt").exists());
    assert!(
        registry
            .materialize(&fixture.rules.lock().unwrap())
            .definitions
            .is_empty()
    );
    fs::remove_dir_all(root).unwrap();
}
