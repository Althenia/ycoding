use ycoding_core::session::prompt_cache::{self, Namespace};
use ycoding_schema::{DomainDecode, JsonValue, parse_json};

#[test]
fn canonical_keys_compare_code_points_without_losing_unmatched_utf16_units() {
    let expected = r#"{"10":"ten","2":"two","a":"prefix","a\ud800":"suffix","\ud800":1,"\ud801":2,"\udfff":3,"":"bmp","𐀀":"astral"}"#;
    for input in [
        r#"{"\udfff":3,"\ud801":2,"\ud800":1,"𐀀":"astral","":"bmp","2":"two","10":"ten","a\ud800":"suffix","a":"prefix"}"#,
        expected,
        r#"{"a":"prefix","a\ud800":"suffix","10":"ten","2":"two","\ud800":1,"":"bmp","𐀀":"astral","\udfff":3,"\ud801":2}"#,
    ] {
        assert_eq!(
            prompt_cache::canonical_json(&parse_json(input).unwrap()),
            expected
        );
    }
    assert_eq!(
        prompt_cache::canonical_json(
            &parse_json(r#"{"\ud800\udc00":1,"\ud800a":2,"\udc00":3}"#).unwrap()
        ),
        r#"{"\ud800a":2,"\udc00":3,"𐀀":1}"#
    );
}

#[test]
fn canonical_tool_definitions_preserve_lossless_schemas_and_native_ownership() {
    let definition = |name: &str, schema: &str| ycoding_ai::llm::ToolDefinition {
        name: name.into(),
        description: "Tool".into(),
        input_schema: parse_json(schema).unwrap(),
        output_schema: Some(parse_json(r#"{"z":1,"a":2}"#).unwrap()),
        cache: None,
        metadata: Some(parse_json(r#"{"owner":"registered"}"#).unwrap()),
        native: Some(parse_json(r#"{"z":1,"a":2}"#).unwrap()),
    };
    let mut first = vec![
        definition("zeta", r#"{"type":"object"}"#),
        definition(
            "alpha",
            r#"{"type":"object","properties":{"\ud801":2,"\ud800":1}}"#,
        ),
    ];
    let mut second = vec![
        definition(
            "alpha",
            r#"{"properties":{"\ud800":1,"\ud801":2},"type":"object"}"#,
        ),
        definition("zeta", r#"{"type":"object"}"#),
    ];
    prompt_cache::canonical_tools(&mut first);
    prompt_cache::canonical_tools(&mut second);
    assert_eq!(first, second);
    assert_eq!(
        prompt_cache::tool_digest(&first),
        prompt_cache::tool_digest(&second)
    );
    assert_eq!(
        ycoding_schema::stringify_json(&first[0].input_schema),
        r#"{"properties":{"\ud800":1,"\ud801":2},"type":"object"}"#
    );
    assert_eq!(
        first[0].metadata.as_ref().unwrap(),
        &parse_json(r#"{"owner":"registered"}"#).unwrap()
    );
    assert_eq!(
        ycoding_schema::stringify_json(first[0].native.as_ref().unwrap()),
        r#"{"a":2,"z":1}"#
    );
}

#[test]
fn namespace_matches_typescript_goldens_and_isolates_all_sharing_dimensions() {
    let permissions = ycoding_schema::permission::Ruleset::decode(
        &parse_json(r#"[{"action":"read","resource":"**","effect":"allow"}]"#).unwrap(),
    )
    .unwrap();
    let system = vec!["System after hook".into()];
    let mut tool = ycoding_ai::llm::ToolDefinition {
        name: "search".into(),
        description: "Search".into(),
        input_schema: parse_json(
            r#"{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}"#,
        )
        .unwrap(),
        output_schema: None,
        cache: None,
        metadata: None,
        native: None,
    };
    let tools = vec![tool.clone()];
    let mut input = Namespace {
        project_id: "project".into(),
        directory: "/repo".into(),
        workspace_id: Some("workspace".into()),
        provider_id: "openai".into(),
        model_id: "gpt-5.6".into(),
        variant: None,
        account_identity_digest: None,
        permissions: &permissions,
        system: &system,
        tools: &tools,
    };
    let baseline = prompt_cache::namespace(&input);
    assert_eq!(
        baseline,
        "87f7196969720e74e3d2ad02a0926e06bff1037aeb1d47dc516638a7fed3a6e0"
    );
    tool.input_schema = parse_json(r#"{"10":"ten","2":"two","𐀀":"astral","":"bmp"}"#).unwrap();
    let changed = vec![tool];
    input.tools = &changed;
    assert_eq!(
        prompt_cache::namespace(&input),
        "d86ed155497d942455d1f71c087324e0cabd58b5f5ea387713a01e5270818b31"
    );
    input.tools = &tools;
    for dimension in [
        "project",
        "directory",
        "workspace",
        "provider",
        "model",
        "variant",
        "account",
        "permissions",
        "system",
        "tools",
    ] {
        let alternative_system = vec!["Different system".into()];
        let mut alternative = Namespace {
            project_id: input.project_id.clone(),
            directory: input.directory.clone(),
            workspace_id: input.workspace_id.clone(),
            provider_id: input.provider_id.clone(),
            model_id: input.model_id.clone(),
            variant: None,
            account_identity_digest: None,
            permissions: &permissions,
            system: &system,
            tools: &tools,
        };
        match dimension {
            "project" => alternative.project_id = "other".into(),
            "directory" => alternative.directory = "/other".into(),
            "workspace" => alternative.workspace_id = None,
            "provider" => alternative.provider_id = "other".into(),
            "model" => alternative.model_id = "other".into(),
            "variant" => alternative.variant = Some("default".into()),
            "account" => alternative.account_identity_digest = Some("other"),
            "permissions" => alternative.permissions = &[],
            "system" => alternative.system = &alternative_system,
            "tools" => alternative.tools = &[],
            _ => unreachable!(),
        }
        assert_ne!(
            prompt_cache::namespace(&alternative),
            baseline,
            "{dimension}"
        );
    }
    assert_eq!(
        prompt_cache::canonical_json(&JsonValue::Array(vec![
            JsonValue::Null,
            JsonValue::String("tail".into())
        ])),
        r#"[null,"tail"]"#
    );
}
