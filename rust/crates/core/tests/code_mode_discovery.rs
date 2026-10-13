mod code_mode_regexp_fixture;
use std::sync::Arc;
use ycoding_core::tools::code_mode::{
    Cancellation, DiagnosticKind, ExecutionLimits, Runtime, ToolDescription, ToolFailure,
    ToolFuture, ToolHost,
};
use ycoding_schema::{JsonValue, LosslessString, parse_json};

struct Host(Vec<ToolDescription>);
impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        self.0.clone()
    }
    fn decode_input(
        &self,
        _: &LosslessString,
        input: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(input)
    }
    fn invoke(
        &self,
        path: LosslessString,
        _: Option<JsonValue>,
        _: Cancellation,
    ) -> ToolFuture<'_> {
        Box::pin(async move {
            Ok(Some(JsonValue::String(
                self.0
                    .iter()
                    .rev()
                    .find(|tool| tool.path == path)
                    .unwrap()
                    .description
                    .clone()
                    .into(),
            )))
        })
    }
    fn decode_output(
        &self,
        _: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(output)
    }
}
fn tool(path: &str, description: &str) -> ToolDescription {
    ToolDescription {
        path: path.into(),
        description: description.into(),
        signature: format!("tools.{path}(input: {{}}): Promise<string>"),
        input_properties: Vec::new(),
    }
}
fn runtime(tools: Vec<ToolDescription>) -> Runtime {
    Runtime::new(
        Arc::new(Host(tools)),
        ExecutionLimits {
            timeout_ms: Some(1_000),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap()
}

#[tokio::test]
async fn dotted_paths_callable_namespaces_and_collisions_keep_execution_and_discovery_consistent() {
    let runtime = runtime(vec![
        tool("issues.list", "first"),
        tool("issues", "all"),
        tool("issues.list", "second"),
        tool("issues.get", "got"),
        tool("issues.close", "closed"),
    ]);
    assert_eq!(
        runtime
            .catalog()
            .iter()
            .map(|tool| tool.path.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["issues", "issues.list", "issues.get", "issues.close"]
    );
    assert_eq!(runtime.catalog()[1].description, "second");
    for (code, expected) in [
        ("return await tools.issues({})", "\"all\""),
        ("return await tools.issues.list({})", "\"second\""),
        ("return await tools['issues.list']({})", "\"second\""),
        (
            "return [Object.keys(tools),Object.keys(tools.issues),Object.keys(tools['issues.list'])]",
            "[[\"issues\"],[\"list\",\"get\",\"close\"],[]]",
        ),
        (
            "return (await search({query:'tools.issues.list'})).items.map(x=>x.path)",
            "[\"tools.issues.list\"]",
        ),
        ("return await tools.issues.get({})", "\"got\""),
        ("return await tools.issues.close({})", "\"closed\""),
    ] {
        assert_eq!(
            runtime.execute(code, Cancellation::default()).await.value,
            Ok(parse_json(expected).unwrap()),
            "{code}"
        );
    }
    let nested = runtime_for_namespace();
    for (code, message) in [
        ("return tools.issues({})", "Tool 'issues' is not callable."),
        (
            "return tools.issues.missing({})",
            "Unknown tool 'issues.missing'.",
        ),
    ] {
        let errors = nested
            .execute(code, Cancellation::default())
            .await
            .value
            .unwrap_err();
        assert_eq!(errors[0].kind, DiagnosticKind::UnknownTool);
        assert_eq!(errors[0].message, message);
    }
}
fn runtime_for_namespace() -> Runtime {
    runtime(vec![tool("issues.list", "listed")])
}

#[tokio::test]
async fn blocked_tool_segments_are_callable_but_data_properties_remain_confined() {
    let runtime = runtime(vec![
        tool("prototype", "proto"),
        tool("issues.constructor", "ctor"),
        tool("nested.__proto__", "dunder"),
    ]);
    for (code, expected) in [
        ("return await tools.prototype({})", "proto"),
        ("return await tools.issues.constructor({})", "ctor"),
        ("return await tools['issues.constructor']({})", "ctor"),
        ("return await tools.nested.__proto__({})", "dunder"),
    ] {
        assert_eq!(
            runtime.execute(code, Cancellation::default()).await.value,
            Ok(JsonValue::String(expected.into()))
        );
    }
    assert_eq!(
        runtime
            .execute("return Object.keys(tools.issues)", Cancellation::default())
            .await
            .value,
        Ok(parse_json("[\"constructor\"]").unwrap())
    );
    assert!(
        runtime
            .execute("const x={};return x.constructor", Cancellation::default())
            .await
            .value
            .unwrap_err()[0]
            .message
            .contains("constructor")
    );
}

#[test]
fn empty_path_segments_are_rejected_before_runtime_construction() {
    for path in ["", "a..b", "trail.", ".lead"] {
        let result = Runtime::new(
            Arc::new(Host(vec![tool(path, "bad")])),
            ExecutionLimits::default(),
            Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
            code_mode_regexp_fixture::collation(),
        );
        assert!(
            result
                .err()
                .expect("An empty segment must reject construction")
                .contains("empty segment")
        );
    }
}

#[tokio::test]
async fn unknown_namespaces_and_opaque_value_enumeration_have_actionable_diagnostics() {
    let runtime = runtime_for_namespace();
    let errors = runtime
        .execute(
            "return Object.keys(tools.nonexistent)",
            Cancellation::default(),
        )
        .await
        .value
        .unwrap_err();
    assert_eq!(errors[0].kind, DiagnosticKind::UnknownTool);
    assert_eq!(errors[0].message, "Unknown tool namespace 'nonexistent'.");
    for method in ["values", "entries"] {
        let errors = runtime
            .execute(
                format!("return Object.{method}(tools)"),
                Cancellation::default(),
            )
            .await
            .value
            .unwrap_err();
        assert_eq!(errors[0].kind, DiagnosticKind::InvalidDataValue);
        assert_eq!(
            errors[0].message,
            format!(
                "Object.{method}(...) cannot read tool references: they are not plain data. Use Object.keys(tools) for names, or search({{ query }}) for signatures."
            )
        );
    }
}

#[tokio::test]
async fn enumeration_corpus_covers_tool_names_plain_keys_and_for_in_control_flow() {
    let runtime = runtime(vec![
        tool("github.list_issues", "list"),
        tool("github.get_issue", "get"),
        tool("memory.search", "search"),
        tool("playwright.navigate", "navigate"),
    ]);
    for (code, expected) in [
        (
            "const namespaces=Object.keys(tools);return {namespaces,count:namespaces.length}",
            "{\"namespaces\":[\"github\",\"memory\",\"playwright\"],\"count\":3}",
        ),
        (
            "return Object.keys(tools.github)",
            "[\"list_issues\",\"get_issue\"]",
        ),
        ("return Object.keys(tools.github.list_issues)", "[]"),
        ("return typeof search", "\"function\""),
        (
            "return [Object.keys(['a','b','c']),Object.keys([]),Object.keys({a:1,b:2})]",
            "[[\"0\",\"1\",\"2\"],[],[\"a\",\"b\"]]",
        ),
        (
            "const seen=[];for(const key in {a:1,b:2,c:3,d:4}){if(key==='b')continue;if(key==='d')break;seen.push(key)}return seen",
            "[\"a\",\"c\"]",
        ),
        (
            "const indexes=[];for(const i in ['x','y','z']){if(i==='2')break;indexes.push(i)}return indexes",
            "[\"0\",\"1\"]",
        ),
        (
            "let last='';for(let key in {a:1,b:2})last=key;return last",
            "\"b\"",
        ),
        (
            "let key='before';for(key in {only:1}){}return key",
            "\"only\"",
        ),
        (
            "const names=[];for(const ns in tools){for(const name in tools[ns])names.push(ns+'.'+name)}return names",
            "[\"github.list_issues\",\"github.get_issue\",\"memory.search\",\"playwright.navigate\"]",
        ),
    ] {
        assert_eq!(
            runtime.execute(code, Cancellation::default()).await.value,
            Ok(parse_json(expected).unwrap()),
            "{code}"
        );
    }
    assert!(
        runtime
            .execute("return Object.keys('nope')", Cancellation::default())
            .await
            .value
            .unwrap_err()[0]
            .message
            .contains("Object.keys expects a data object or array")
    );
    for expression in ["'text'", "new Map([[1,2]])", "new Set([1])", "42", "null"] {
        let errors = runtime
            .execute(
                format!("for(const key in {expression}){{}};return 'no'"),
                Cancellation::default(),
            )
            .await
            .value
            .unwrap_err();
        assert!(
            errors[0]
                .message
                .contains("for...in requires a plain object, array, or tools reference")
        );
        assert!(
            errors[0]
                .message
                .contains("Use for...of for arrays/strings/Maps/Sets, or Object.keys(value)")
        );
    }
}

#[tokio::test]
async fn search_paging_scoping_ranked_parameters_and_invalid_limits() {
    let mut document = tool("docs.lookupDocument", "Find documents");
    document
        .input_properties
        .push(("attachmentId".into(), Some("Attachment identifier".into())));
    let runtime = runtime(vec![
        tool("zeta.last", "Last"),
        tool("alpha.beta", "Middle"),
        tool("alpha.aardvark", "First"),
        document,
    ]);
    for (code, expected) in [
        (
            "return (await search({})).items.map(x=>x.path)",
            "[\"tools.alpha.aardvark\",\"tools.alpha.beta\",\"tools.docs.lookupDocument\",\"tools.zeta.last\"]",
        ),
        (
            "const page=await search({limit:1,offset:1});return [page.items.map(x=>x.path),page.remaining,page.next]",
            "[[\"tools.alpha.beta\"],2,{\"offset\":2}]",
        ),
        (
            "return search({limit:1,offset:4})",
            "{\"items\":[],\"remaining\":0,\"next\":null}",
        ),
        (
            "return (await search({query:'',namespace:'alpha'})).items.map(x=>x.path)",
            "[\"tools.alpha.aardvark\",\"tools.alpha.beta\"]",
        ),
        (
            "return (await search({query:'attachment'})).items.map(x=>x.path)",
            "[\"tools.docs.lookupDocument\"]",
        ),
        (
            "return (await search({query:'documents'})).items.map(x=>x.path)",
            "[\"tools.docs.lookupDocument\"]",
        ),
    ] {
        assert_eq!(
            runtime.execute(code, Cancellation::default()).await.value,
            Ok(parse_json(expected).unwrap()),
            "{code}"
        );
    }
    for arguments in [
        "{limit:0.5}",
        "{namespace:7}",
        "{offset:-1}",
        "{offset:0.5}",
        "{offset:9007199254740992}",
        "{offset:'1'}",
    ] {
        let errors = runtime
            .execute(
                format!("return search({arguments})"),
                Cancellation::default(),
            )
            .await
            .value
            .unwrap_err();
        assert_eq!(
            errors[0].kind,
            DiagnosticKind::InvalidToolInput,
            "{arguments}"
        );
    }
}

#[test]
fn discovery_instructions_round_robin_complete_empty_and_jsdoc_budgets() {
    let mut cheap = tool("alpha.cheap", "Cheap");
    cheap.signature = "tools.alpha.cheap(input: {\n  q: string,\n}): Promise<string>".into();
    let mut beta = cheap.clone();
    beta.path = "beta.cheap".into();
    beta.signature = cheap.signature.replace("alpha", "beta");
    let mut expensive = tool(
        "alpha.expensive",
        "An expensive tool whose description alone consumes far more than the remaining inline catalog byte budget for this runtime",
    );
    expensive.signature="tools.alpha.expensive(input: {\n  someRatherLongParameterName: string,\n  anotherEvenLongerParameterName: number,\n}): Promise<string>".into();
    let runtime = runtime(vec![cheap, expensive, beta]);
    let partial = runtime.instructions(Some(40)).unwrap();
    for expected in [
        "Available tools (PARTIAL - 2 of 3 shown; find the rest with search(...))",
        "- alpha (2 tools, 1 shown)",
        "- beta (1 tool)",
        "  - tools.alpha.cheap(input: {\n  q: string,\n}): Promise<string> // Cheap",
        "Search returns complete callable signatures:\n- search(input: {",
    ] {
        assert!(partial.contains(expected), "{expected}");
    }
    assert!(!partial.contains("tools.alpha.expensive("));
    assert!(
        runtime
            .instructions(None)
            .unwrap()
            .contains("COMPLETE list")
    );
    assert!(
        runtime_for_namespace()
            .instructions(Some(0))
            .unwrap()
            .contains("PARTIAL - 0 of 1 shown")
    );
    assert!(
        self::runtime(Vec::new())
            .instructions(None)
            .unwrap()
            .contains("No tools are currently available.")
    );
    let mut documented = tool("records.lookup", "Look up a record");
    documented.signature = format!(
        "tools.records.lookup(input: {{\n  /** {} */\n  id: string,\n}}): Promise<unknown>",
        "A detailed identifier description. ".repeat(20)
    );
    assert!(
        self::runtime(vec![documented])
            .instructions(Some(40))
            .unwrap()
            .contains("PARTIAL - 0 of 1 shown")
    );
    assert!(runtime.instructions(Some(usize::MAX)).is_err());
}
