use oxc_allocator::Allocator;
use oxc_ast::{AstKind, ast};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use std::sync::Arc;
use ycoding_core::tools::code_mode::{
    Cancellation, ExecutionLimits, Runtime, ToolDescription, ToolFailure, ToolFuture, ToolHost,
};
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

#[path = "code_mode_regexp_fixture.rs"]
mod regexp_fixture;

struct Host;

impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        Vec::new()
    }
    fn decode_input(
        &self,
        _: &LosslessString,
        input: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(input)
    }
    fn invoke(&self, _: LosslessString, _: Option<JsonValue>, _: Cancellation) -> ToolFuture<'_> {
        Box::pin(async { panic!("A pure array corpus case invoked a host tool") })
    }
    fn decode_output(
        &self,
        _: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(output)
    }
}

fn runtime() -> Runtime {
    Runtime::new(
        Arc::new(Host),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap()
}

fn literals(source: &str) -> Vec<(String, String, JsonValue)> {
    let arena = Allocator::default();
    let parsed = Parser::new(&arena, source, SourceType::ts()).parse();
    assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
    let tables = parsed
        .program
        .body
        .iter()
        .filter_map(|statement| {
            let ast::Statement::ExpressionStatement(statement) = statement else {
                return None;
            };
            let ast::Expression::CallExpression(call) = &statement.expression else {
                return None;
            };
            if !matches!(&call.callee, ast::Expression::Identifier(name) if name.name == "run") {
                return None;
            }
            let ast::Expression::ArrayExpression(table) = call.arguments[1].to_expression() else {
                panic!("A run corpus must contain a declarative table");
            };
            Some(table)
        })
        .collect::<Vec<_>>();
    if !tables.is_empty() {
        return tables
            .iter()
            .flat_map(|table| table.elements.iter().map(vector))
            .collect();
    }
    let cases = parsed
        .program
        .body
        .iter()
        .filter_map(|statement| match statement {
            ast::Statement::VariableDeclaration(declaration) => Some(declaration),
            _ => None,
        })
        .flat_map(|declaration| declaration.declarations.iter())
        .find(|declaration| matches!(&declaration.id, ast::BindingPattern::BindingIdentifier(identifier) if identifier.name == "cases"))
        .expect("The TS corpus must declare its cases table");
    let expression = cases.init.as_ref().unwrap();
    let expression = match expression {
        ast::Expression::TSAsExpression(expression) => &expression.expression,
        expression => expression,
    };
    let ast::Expression::ArrayExpression(expression) = expression else {
        panic!("The TS cases must remain a declarative array")
    };
    expression.elements.iter().map(vector).collect()
}

fn vector(entry: &ast::ArrayExpressionElement<'_>) -> (String, String, JsonValue) {
    let ast::ArrayExpressionElement::ObjectExpression(entry) = entry else {
        panic!("A TS vector must remain a declarative object")
    };
    let property = |name: &str| {
        entry
                    .properties
                    .iter()
                    .filter_map(|property| property.as_property())
                    .find(|property| matches!(&property.key, ast::PropertyKey::StaticIdentifier(key) if key.name == name))
                    .unwrap_or_else(|| panic!("Missing vector field {name}"))
    };
    let path = fixture(&property("path").value);
    let JsonValue::String(path) = path else {
        panic!("A TS vector path must be a string")
    };
    let code = match &property("code").value {
        ast::Expression::StringLiteral(value) => value.value.as_str().to_owned(),
        ast::Expression::TemplateLiteral(value) => {
            assert!(
                value.expressions.is_empty(),
                "An interpolated TS fixture requires an explicit port"
            );
            assert_eq!(value.quasis.len(), 1);
            assert!(!value.quasis[0].lone_surrogates);
            value.quasis[0]
                .value
                .cooked
                .as_ref()
                .unwrap()
                .as_str()
                .to_owned()
        }
        _ => panic!("A TS code vector must remain a literal"),
    };
    (
        path.to_utf8().unwrap(),
        code,
        fixture(&property("expected").value),
    )
}

fn fixture(expression: &ast::Expression<'_>) -> JsonValue {
    match expression {
        ast::Expression::NullLiteral(_) => JsonValue::Null,
        ast::Expression::BooleanLiteral(value) => JsonValue::Bool(value.value),
        ast::Expression::NumericLiteral(value) => JsonValue::Number(value.value),
        ast::Expression::UnaryExpression(value) if value.operator.as_str() == "-" => {
            let JsonValue::Number(value) = fixture(&value.argument) else {
                panic!("A negative fixture must contain a numeric literal")
            };
            JsonValue::Number(-value)
        }
        ast::Expression::StringLiteral(value) => {
            assert!(
                !value.lone_surrogates,
                "An ill-formed string fixture requires an explicit lossless expected value"
            );
            JsonValue::String(LosslessString::from(value.value.as_str()))
        }
        ast::Expression::ArrayExpression(value) => JsonValue::Array(
            value
                .elements
                .iter()
                .map(|value| {
                    assert!(
                        value.is_expression(),
                        "An expected fixture cannot silently normalize holes or spreads"
                    );
                    fixture(value.to_expression())
                })
                .collect(),
        ),
        ast::Expression::ObjectExpression(value) => {
            let mut object = JsonObject::new();
            for property in &value.properties {
                let property = property
                    .as_property()
                    .expect("A fixture cannot contain object spread");
                let key = match &property.key {
                    ast::PropertyKey::StaticIdentifier(key) => key.name.as_str().into(),
                    ast::PropertyKey::StringLiteral(key) => key.value.as_str().into(),
                    ast::PropertyKey::NumericLiteral(key) => key.value.to_string().into(),
                    _ => panic!("A fixture requires a literal property key"),
                };
                object.insert(key, fixture(&property.value));
            }
            JsonValue::Object(object)
        }
        ast::Expression::StaticMemberExpression(value)
            if matches!(&value.object,ast::Expression::Identifier(name)if name.name=="Number")
                && value.property.name == "MAX_SAFE_INTEGER" =>
        {
            JsonValue::Number(9_007_199_254_740_991.0)
        }
        _ => panic!("An expected TS fixture requires an explicit port: {expression:?}"),
    }
}

async fn assertions(source: &str) {
    let arena = Allocator::default();
    let parsed = Parser::new(&arena, source, SourceType::ts()).parse();
    assert!(parsed.diagnostics.is_empty());
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    let expected_failures = semantic
        .nodes()
        .iter()
        .filter_map(|node| {
            let AstKind::CallExpression(call) = node.kind() else {
                return None;
            };
            let ast::Expression::StaticMemberExpression(member) = &call.callee else {
                return None;
            };
            (member.property.name == "failing"
                && matches!(&member.object,ast::Expression::Identifier(name)if name.name=="test"))
            .then_some(call.span)
        })
        .collect::<Vec<_>>();
    let cases=semantic.nodes().iter().filter_map(|node| {
        let AstKind::CallExpression(assertion)=node.kind() else{return None;};
        let ast::Expression::StaticMemberExpression(member)=&assertion.callee else{return None;};
        if member.property.name!="toEqual" && member.property.name!="toBe" {return None;}
        let ast::Expression::CallExpression(expectation)=&member.object else{panic!("A corpus assertion must use expect");};
        assert!(matches!(&expectation.callee,ast::Expression::Identifier(name)if name.name=="expect"));
        let observed=expectation.arguments[0].to_expression();
        let observed=if let ast::Expression::Identifier(identifier)=observed {
            let symbol=identifier.reference_id.get().and_then(|id|semantic.scoping().get_reference(id).symbol_id());
            let initializer=semantic.nodes().iter().find_map(|node|{
                let AstKind::VariableDeclarator(declaration)=node.kind() else{return None;};
                let ast::BindingPattern::BindingIdentifier(binding)=&declaration.id else{return None;};
                (symbol.is_some()&&binding.symbol_id.get()==symbol).then_some(declaration.init.as_ref()).flatten()
            });
            initializer?
        }else{observed};
        let ast::Expression::AwaitExpression(awaited)=observed else{return None;};
        let ast::Expression::CallExpression(actual)=&awaited.argument else{panic!("A corpus assertion must call value");};
        if !matches!(&actual.callee,ast::Expression::Identifier(name)if name.name=="value") {return None;}
        let code=match actual.arguments[0].to_expression() {
            ast::Expression::TemplateLiteral(code)if code.expressions.is_empty()=>code.quasis[0].value.cooked.as_ref().unwrap().as_str().to_owned(),
            ast::Expression::StringLiteral(code)=>code.value.as_str().to_owned(),
            _=>return None,
        };
        let expected_failure=expected_failures.iter().any(|span|span.start<=assertion.span.start&&span.end>=assertion.span.end);
        Some((code,fixture(assertion.arguments[0].to_expression()),expected_failure))
    }).collect::<Vec<_>>();
    assert!(!cases.is_empty());
    let runtime = Runtime::new(
        Arc::new(Host),
        ExecutionLimits {
            timeout_ms: Some(1_000),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    for (code, expected, expected_failure) in cases {
        let actual = runtime
            .execute(code.as_str(), Cancellation::default())
            .await
            .value;
        if expected_failure {
            assert_ne!(
                actual,
                Ok(expected),
                "A TS test.failing conformance case unexpectedly passed: {code}"
            );
            continue;
        }
        assert_eq!(
            actual.unwrap_or_else(|errors| panic!("{code}: {errors:?}")),
            expected,
            "{code}"
        );
    }
}

#[tokio::test]
async fn promise_test262_direct_assertions() {
    assertions(include_str!("code-mode-corpora/promise-test262.test.ts")).await;
}

#[tokio::test]
async fn callback_direct_assertions() {
    assertions(include_str!("code-mode-corpora/callbacks.test.ts")).await;
}

#[tokio::test]
async fn parity_direct_assertions() {
    assertions(include_str!("code-mode-corpora/parity.test.ts")).await;
}

#[tokio::test]
async fn string_core_complete_test262_vectors() {
    let JsonValue::Array(cases) =
        ycoding_schema::parse_json(include_str!("string-core-corpus.json")).unwrap()
    else {
        panic!("The String Core specification must be an array");
    };
    assert_eq!(cases.len(), 130);
    let runtime = Runtime::new(
        Arc::new(Host),
        ExecutionLimits {
            timeout_ms: Some(1_000),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    for case in cases {
        let JsonValue::Object(case) = case else {
            panic!("A String Core vector must be an object");
        };
        let JsonValue::String(path) = case.get(&"path".into()).unwrap() else {
            panic!("A vector path must be a string");
        };
        let JsonValue::String(code) = case.get(&"code".into()).unwrap() else {
            panic!("A vector program must be a string");
        };
        assert_eq!(
            runtime
                .execute(code.to_utf8().unwrap(), Cancellation::default())
                .await
                .value,
            Ok(case.get(&"expected".into()).unwrap().clone()),
            "{}",
            path.to_utf8().unwrap()
        );
    }
}

#[tokio::test]
async fn regexp_math_test262_assertions() {
    assertions(include_str!(
        "code-mode-corpora/regexp-math-test262.test.ts"
    ))
    .await;
}

#[tokio::test]
async fn lexical_test262_assertions() {
    assertions(include_str!("code-mode-corpora/lexical-test262.test.ts")).await;
}

#[tokio::test]
async fn groupby_test262_assertions() {
    assertions(include_str!("code-mode-corpora/groupby-test262.test.ts")).await;
}

#[tokio::test]
async fn date_test262_assertions() {
    assertions(include_str!("code-mode-corpora/date-test262.test.ts")).await;
}

#[tokio::test]
async fn set_methods_test262_assertions() {
    assertions(include_str!(
        "code-mode-corpora/set-methods-test262.test.ts"
    ))
    .await;
}

#[tokio::test]
async fn string_regexp_test262_vectors() {
    let runtime = Runtime::new(
        Arc::new(Host),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    let cases = literals(include_str!(
        "code-mode-corpora/string-regexp-test262.test.ts"
    ));
    assert!(!cases.is_empty());
    for (path, code, expected) in cases {
        assert_eq!(
            runtime
                .execute(code.as_str(), Cancellation::default())
                .await
                .value
                .unwrap(),
            expected,
            "{path}"
        );
    }
}

#[tokio::test]
async fn string_search_test262_vectors() {
    let runtime = Runtime::new(
        Arc::new(Host),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    let cases = literals(include_str!(
        "code-mode-corpora/string-search-test262.test.ts"
    ));
    assert!(!cases.is_empty());
    for (path, code, expected) in cases {
        assert_eq!(
            runtime
                .execute(code.as_str(), Cancellation::default())
                .await
                .value
                .unwrap(),
            expected,
            "{path}"
        );
    }
}

#[tokio::test]
async fn array_core_test262_vectors() {
    let cases = literals(include_str!("code-mode-corpora/array-core-test262.test.ts"));
    assert!(!cases.is_empty());
    let runtime = runtime();
    for (path, code, expected) in cases {
        let result = runtime
            .execute(code.as_str(), Cancellation::default())
            .await;
        assert_eq!(
            result
                .value
                .unwrap_or_else(|errors| panic!("{path}: {errors:?}")),
            expected,
            "{path}: {code}"
        );
        assert!(result.tool_calls.is_empty(), "{path}");
    }
}

#[tokio::test]
async fn array_callbacks_test262_vectors() {
    let cases = literals(include_str!(
        "code-mode-corpora/array-callbacks-test262.test.ts"
    ));
    assert!(!cases.is_empty());
    let runtime = runtime();
    for (path, code, expected) in cases {
        let result = runtime
            .execute(code.as_str(), Cancellation::default())
            .await;
        assert_eq!(
            result
                .value
                .unwrap_or_else(|errors| panic!("{path}: {errors:?}")),
            expected,
            "{path}: {code}"
        );
        assert!(result.tool_calls.is_empty(), "{path}");
    }
}

#[tokio::test]
async fn array_callbacks_test262_additional_cases() {
    let runtime = runtime();
    for (name, code, expected) in [
        (
            "reduce and reduceRight find the first present element",
            "const left = []; left[2] = 3; const right = []; right[0] = 4; right[3] = 1; right.pop(); return [left.reduce((a, b) => a + b), right.reduceRight((a, b) => a + b)]",
            JsonValue::Array(vec![JsonValue::Number(3.0), JsonValue::Number(4.0)]),
        ),
        (
            "reduce and reduceRight reject arrays containing only holes",
            "const values = []; values[2] = 1; values.pop(); let left; let right; try {values.reduce((a, b) => a + b)} catch (error) {left = error.name} try {values.reduceRight((a, b) => a + b)} catch (error) {right = error.name} return [left,right]",
            JsonValue::Array(vec![
                JsonValue::String("TypeError".into()),
                JsonValue::String("TypeError".into()),
            ]),
        ),
        (
            "findLast returns the value observed before predicate mutation",
            "const values = [1]; return values.findLast((item,index,array) => {array[index] = 2; return true})",
            JsonValue::Number(1.0),
        ),
    ] {
        assert_eq!(
            runtime
                .execute(code, Cancellation::default())
                .await
                .value
                .unwrap(),
            expected,
            "{name}"
        );
    }
}
