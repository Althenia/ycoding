mod code_mode_regexp_fixture;
use std::sync::Arc;
use ycoding_core::regexp::{Budget, Error, RegExp};
use ycoding_core::tools::code_mode::regexp::{NativeRegExpEngine, RegExpEngine};
use ycoding_core::tools::code_mode::{
    Cancellation, ExecutionLimits, Runtime, ToolDescription, ToolFailure, ToolFuture, ToolHost,
};
use ycoding_schema::{JsonValue, LosslessString, parse_json};

struct Host;
impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        vec![ToolDescription {
            path: "host.decorate".into(),
            description: "Decorate a string".into(),
            signature: "tools.host.decorate(input: string): Promise<string>".into(),
            input_properties: Vec::new(),
        }]
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
        input: Option<JsonValue>,
        _: Cancellation,
    ) -> ToolFuture<'_> {
        Box::pin(async move {
            assert_eq!(path, "host.decorate".into());
            let Some(JsonValue::String(input)) = input else {
                return Err(ToolFailure::InvalidInput("Expected string".into()));
            };
            Ok(Some(JsonValue::String(
                format!("[{}]", input.to_utf8().unwrap()).into(),
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

fn runtime() -> Runtime {
    Runtime::new(
        Arc::new(Host),
        ExecutionLimits::default(),
        Arc::new(NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap()
}
async fn value(code: &str) -> JsonValue {
    runtime()
        .execute(code, Cancellation::default())
        .await
        .value
        .unwrap()
}

#[tokio::test]
async fn regexp_literals_constructor_cursor_and_brand() {
    for (code, expected) in [
        (
            "return [/a/ instanceof RegExp, RegExp('a','gi').flags, /a/.source]",
            "[true,\"gi\",\"a\"]",
        ),
        (
            "const r=/a/g; const a=r.exec('ba'); const first=r.lastIndex; r.lastIndex='1'; const b=r.test('ba'); return [a[0],a.index,first,b,r.lastIndex]",
            "[\"a\",1,2,true,2]",
        ),
        (
            "const r=/a/; r.lastIndex=12; const out=r.test('a'); return [out,r.lastIndex,delete r.lastIndex]",
            "[true,12,false]",
        ),
    ] {
        assert_eq!(value(code).await, parse_json(expected).unwrap(), "{code}");
    }
}

#[tokio::test]
async fn regexp_operations_that_ignore_last_index_do_not_coerce_it() {
    assert_eq!(value("const r=/a/;r.lastIndex=()=>1;const a=r.exec('a');const g=/a/g;g.lastIndex=()=>1;const search='a'.search(g);const split='a'.split(g);const all='a'.match(g);return [a[0],typeof r.lastIndex,search,typeof g.lastIndex,split,all,g.lastIndex]").await,parse_json("[\"a\",\"function\",0,\"number\",[\"\",\"\"],[\"a\"],0]").unwrap());
}

#[tokio::test]
async fn console_logs_preserve_raw_lone_surrogates() {
    let result = runtime()
        .execute(
            "console.log('\\ud800', /\\udfff/);return true",
            Cancellation::default(),
        )
        .await;
    assert_eq!(result.value.unwrap(), JsonValue::Bool(true));
    assert_eq!(result.logs.len(), 1);
    assert_eq!(
        result.logs[0].code_units().collect::<Vec<_>>(),
        vec![0xd800, 32, 47, 92, 117, 100, 102, 102, 102, 47]
    );
}

#[tokio::test]
async fn regexp_interpreter_only_baseline_groups() {
    let runtime = runtime();
    let flags = runtime
        .execute(
            "try {RegExp('a',0)} catch(e) {throw Error(e.name)}",
            Cancellation::default(),
        )
        .await
        .value
        .unwrap_err();
    assert!(flags[0].message.contains("SyntaxError"));
    assert_eq!(value("return [typeof Math.sum,RegExp.quote===undefined,Number.range===undefined,String.raw===undefined,isFinite.something===undefined,console.group===undefined,Date.moment===undefined,JSON.rawJSON===undefined,URL.createObjectURL===undefined,Math.sum?.([1])??'fallback']").await,parse_json("[\"undefined\",true,true,true,true,true,true,true,true,\"fallback\"]").unwrap());
    let argument = runtime
        .execute("return 'abc'.match(42)", Cancellation::default())
        .await
        .value
        .unwrap_err();
    assert!(
        argument[0].message.contains("expects a regular expression"),
        "{argument:?}"
    );
    assert!(argument[0].message.contains("not number"));
    assert_eq!(value("const rejects=(input)=>{try {RegExp.escape(input);return false} catch(error){return error.name==='TypeError'}}; return [rejects(123),rejects({}),rejects([]),rejects(null),rejects(undefined)]").await,parse_json("[true,true,true,true,true]").unwrap());
}

#[tokio::test]
async fn remaining_eight_committed_regexp_baseline_groups() {
    let result = runtime().execute("console.log({m:new Map([['a',1]]),when:new Date(0),r:/ab/g,s:new Set([1,2])}); console.log([new Date(0)]); return null", Cancellation::default()).await;
    assert_eq!(result.value, Ok(JsonValue::Null));
    assert_eq!(result.logs, ["{\"m\":Map(1) [[\"a\",1]],\"when\":1970-01-01T00:00:00.000Z,\"r\":/ab/g,\"s\":Set(2) [1,2]}", "[1970-01-01T00:00:00.000Z]"].map(LosslessString::from));
    assert_eq!(value("return 'abc'.match(/\\d/)").await, JsonValue::Null);
    for (code, expected) in [
        (
            "return 'a1b22'.replace(/\\d+/g,async(match)=>await tools.host.decorate(match))",
            "a[object Promise]b[object Promise]",
        ),
        (
            "return 'a1'.replace(/\\d/,(match)=>tools.host.decorate(match))",
            "a[object Promise]",
        ),
    ] {
        assert_eq!(value(code).await, JsonValue::String(expected.into()));
    }
    for (code, hints) in [
        (
            "try {RegExp('a',0)} catch(e) {throw Error(e.name)}",
            vec!["SyntaxError"],
        ),
        (
            "return 'abc'.replace(/b/,tools.host.echo)",
            vec!["wrap it in an arrow function"],
        ),
        (
            "return 'abc'.match('(')",
            vec![
                "String.match received the string \"(\"",
                "escape them with a backslash",
            ],
        ),
        (
            "return new RegExp('(')",
            vec![
                "new RegExp(...) received \"(\"",
                "escape them with a backslash",
            ],
        ),
        (
            "return new RegExp('a','xz')",
            vec!["invalid flags \"xz\"", "Valid flags are"],
        ),
        (
            "return 'aa'.replaceAll(/a/,'b')",
            vec!["write /a/g, or use String.replace"],
        ),
        (
            "return 'aa'.matchAll(/a/)",
            vec!["write /a/g, or use String.match"],
        ),
        (
            "return 'abc'.match(42)",
            vec!["expects a regular expression", "not number"],
        ),
    ] {
        let error = runtime()
            .execute(code, Cancellation::default())
            .await
            .value
            .unwrap_err()
            .remove(0);
        for hint in hints {
            assert!(error.message.contains(hint), "{code}: {error:?}");
        }
        if code.contains("tools.host.echo") {
            assert!(!error.message.contains("argument 2"));
        }
    }
}

#[tokio::test]
async fn invalid_regexp_patterns_name_the_call_and_input() {
    for (code, message) in [
        (
            "return 'abc'.match('(')",
            "String.match received the string \"(\"",
        ),
        ("return new RegExp('(')", "new RegExp(...) received \"(\""),
    ] {
        let errors = runtime()
            .execute(code, Cancellation::default())
            .await
            .value
            .unwrap_err();
        assert!(errors[0].message.contains(message), "{errors:?}");
        assert!(errors[0].message.contains("escape them with a backslash"));
    }
}

#[tokio::test]
async fn regexp_match_metadata_string_helpers_and_callbacks() {
    for (code, expected) in [
        (
            "const m=/(?<safe>a)(?<constructor>b)?/d.exec('a'); return [m.index,m.groups.safe,Object.keys(m.groups),m.indices[0],m.indices.groups.safe,m[2]]",
            "[0,\"a\",[\"safe\"],[0,1],[0,1],null]",
        ),
        (
            "const r=/a/g;r.lastIndex={};const all=[...'baaa'.matchAll(r)];return [all.map(m=>m.index),typeof r.lastIndex,'aa'.search(r),typeof r.lastIndex,'a:a'.split(/(:)/),r.lastIndex]",
            "[[1,2,3],\"object\",0,\"object\",[\"a\",\":\",\"a\"],{}]",
        ),
        ("return '😀'.match(/(?:)/gu)", "[\"\",\"\"]"),
        (
            "const r=/a/g;r.lastIndex=5;const c=RegExp(r);return [c.source,c.flags,c.lastIndex,r.lastIndex]",
            "[\"a\",\"g\",0,5]",
        ),
        (
            "return 'ab'.replace(/(?<safe>a)(?<constructor>b)/,(_,a,b,offset,text,groups)=>`${a}:${b}:${offset}:${text}:${Object.keys(groups).join(',')}`)",
            "\"a:b:0:ab:safe\"",
        ),
        (
            "return 'aa'.replaceAll(/a/g,async()=>1)",
            "\"[object Promise][object Promise]\"",
        ),
        (
            "return ['ab'.replace(/(a)(b)/,'$2$1-$$-$&'), 'ab'.replaceAll('', '-'), 'ab'.replace('a','$1-$&') ]",
            "[\"ba-$-ab\",\"-a-b-\",\"$1-ab\"]",
        ),
        (
            "return [/a/.exec('a').input===undefined,typeof /a/.exec('a').indices]",
            "[true,\"undefined\"]",
        ),
    ] {
        assert_eq!(value(code).await, parse_json(expected).unwrap(), "{code}");
    }
}

#[tokio::test]
async fn native_regexp_work_obeys_the_selected_deadline_outside_js_catch() {
    let runtime = Runtime::new(
        Arc::new(Host),
        ExecutionLimits {
            timeout_ms: Some(20),
            ..ExecutionLimits::default()
        },
        Arc::new(NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap();
    let errors=runtime.execute("const r=/^(a+)+$/;const input='a'.repeat(32)+'!';try {return r.test(input)} catch(error){return 'caught'}",Cancellation::default()).await.value.unwrap_err();
    assert_eq!(
        errors[0].kind,
        ycoding_core::tools::code_mode::DiagnosticKind::TimeoutExceeded
    );
}

struct WorkLimited;
impl RegExpEngine for WorkLimited {
    fn compile(
        &self,
        pattern: &LosslessString,
        flags: &str,
        budget: &mut Budget<'_>,
    ) -> Result<RegExp, Error> {
        budget.remaining = Some(0);
        NativeRegExpEngine.compile(pattern, flags, budget)
    }
}

#[tokio::test]
async fn native_regexp_work_limit_is_not_a_catchable_syntax_error() {
    let runtime = Runtime::new(
        Arc::new(Host),
        ExecutionLimits::default(),
        Arc::new(WorkLimited),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap();
    let errors = runtime
        .execute(
            "try {return /a/.test('a')} catch(error){return 'caught'}",
            Cancellation::default(),
        )
        .await
        .value
        .unwrap_err();
    assert_eq!(
        errors[0].kind,
        ycoding_core::tools::code_mode::DiagnosticKind::ExecutionFailure
    );
    assert_eq!(errors[0].message, "RegExp work limit exceeded");
}
