use std::sync::Arc;
use ycoding_core::tools::code_mode::{
    Cancellation, ExecutionLimits, Runtime, ToolDescription, ToolFailure, ToolFuture, ToolHost,
};
use ycoding_schema::{JsonValue, LosslessString, parse_json};
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
        Box::pin(async { Err(ToolFailure::Internal) })
    }
    fn decode_output(
        &self,
        _: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(output)
    }
}

async fn value(code: &str) -> JsonValue {
    Runtime::new(
        Arc::new(Host),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap()
    .execute(code, Cancellation::default())
    .await
    .value
    .unwrap()
}

#[tokio::test]
async fn values_operators_closures_and_control_flow() {
    for (source, expected) in [
        ("return 1 + 2 * 3", "7"),
        (
            "const r = {a: 1}; r.a += 2; return [r.a, 7 >>> 1, NaN, undefined]",
            "[3,3,null,null]",
        ),
        (
            "function fact(n) { return n < 2 ? 1 : n * fact(n - 1); } return fact(5)",
            "120",
        ),
        (
            "const f = []; for (let n = 0; n < 3; n++) {f.push(() => n)} return f.map(fn => fn())",
            "[0,1,2]",
        ),
        (
            "const {a: [first = 4, ...tail], ...rest} = {a: [undefined,2,3], b: 5}; return [first,tail,rest]",
            "[4,[2,3],{\"b\":5}]",
        ),
        (
            "const seen=[]; try {missing; let missing} catch(e) {seen.push(e.name)} finally {seen.push('done')} return seen",
            "[\"ReferenceError\",\"done\"]",
        ),
        (
            "let out=''; for(const key in {x: 1,y: 2}) out += key; switch(out) {case 'xy': out+='z'; default: out+='!'} return out",
            "\"xyz!\"",
        ),
        (
            "const data = null; return [data?.a.b, data?.a(), !data, typeof missing]",
            "[null,null,true,\"undefined\"]",
        ),
        (
            "return ['\\uD800','\\uFFFD','😀'.length,'😀'[0].charCodeAt(0)]",
            "[\"\\ud800\",\"�\",2,55357]",
        ),
        (
            "const {length} = [1,2]; let [a,b] = 'xy'; [a,b] = [b,a]; return [length,a,b]",
            "[2,\"y\",\"x\"]",
        ),
        (
            "let n=0; do { n++ } while(n<2); while(n<4) {n++; if(n===3) continue; break} return n",
            "4",
        ),
        (
            "const {['a']: x}={a: 4}; const f=(a=x,...rest)=>[a,rest]; return f(undefined,2,3)",
            "[4,[2,3]]",
        ),
        (
            "const a=[1,,3]; delete a[0]; return [a.length,0 in a,1 in a,[...a]]",
            "[3,false,false,[null,null,3]]",
        ),
    ] {
        assert_eq!(
            value(source).await,
            parse_json(expected).unwrap(),
            "{source}"
        );
    }
}

#[tokio::test]
async fn instance_member_reads_expose_only_supported_methods() {
    assert_eq!(value("return [new Date(0).unknown,new Map().unknown,new Map().add,new Set().unknown,new Set().get,new URL('https://example.test').unknown,new URLSearchParams().unknown]").await, parse_json("[null,null,null,null,null,null,null]").unwrap());
}

#[tokio::test]
async fn builtin_collections_string_number_and_json() {
    for (source, expected) in [
        (
            "return [1,2,3].flatMap(x=>[x,x]).filter(x=>x>1).reduce((a,b)=>a+b,0)",
            "10",
        ),
        (
            "const m=new Map([['a',1],['b',2]]); const s=new Set([1,2,2]); return [[...m],s.size,s.has(2),Object.fromEntries(m)]",
            "[[[\"a\",1],[\"b\",2]],2,true,{\"a\":1,\"b\":2}]",
        ),
        (
            "return ['  x  '.trim(), '😀'.codePointAt(0), '1'.padStart(3,'0'), Number('3'), parseInt('ff',16), Math.floor(3.8)]",
            "[\"x\",128512,\"001\",3,255,3]",
        ),
        (
            "return JSON.parse(JSON.stringify({a: undefined,b:[NaN,undefined]},null,2))",
            "{\"b\":[null,null]}",
        ),
        (
            "return ['\\u1E9B\\u0323'.normalize('NFKC'),'o\\u0308'.localeCompare('ö')]",
            "[\"ṩ\",0]",
        ),
        (
            "const url=new URL('../a b','https://example.com/base/'); url.searchParams.set('q','x y'); return [url.href,url.searchParams.get('q')]",
            "[\"https://example.com/a%20b?q=x+y\",\"x y\"]",
        ),
        (
            "const d=new Date(0); d.setUTCDate(2); return [d.getTime(),d.toISOString(),JSON.stringify(d)]",
            "[86400000,\"1970-01-02T00:00:00.000Z\",\"\\\"1970-01-02T00:00:00.000Z\\\"\"]",
        ),
    ] {
        assert_eq!(
            value(source).await,
            parse_json(expected).unwrap(),
            "{source}"
        );
    }
}

#[tokio::test]
async fn raw_source_preserves_lone_surrogates_in_literals_templates_and_regexp() {
    let runtime = Runtime::new(
        Arc::new(Host),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    let mut units = "const quoted='".encode_utf16().collect::<Vec<_>>();
    units.push(0xd800);
    units.extend("';const template=`pre".encode_utf16());
    units.push(0xdc00);
    units.extend("${1}post`;const pattern=/".encode_utf16());
    units.push(0xd800);
    units.extend("/;return [quoted.charCodeAt(0),template.charCodeAt(3),template.length,pattern.test(quoted),pattern.source.charCodeAt(0)]".encode_utf16());
    let result = runtime
        .execute(
            ycoding_schema::LosslessString::from_utf16(units),
            Cancellation::default(),
        )
        .await;
    assert_eq!(
        result.value,
        Ok(parse_json("[55296,56320,9,true,55296]").unwrap())
    );
}

#[tokio::test]
async fn source_literal_escapes_and_template_line_endings_keep_javascript_code_units() {
    let runtime = Runtime::new(
        Arc::new(Host),
        ExecutionLimits::default(),
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        regexp_fixture::collation(),
    )
    .unwrap();
    assert_eq!(runtime.execute(r"return ['\u{D800}'.charCodeAt(0),'\xFF'.charCodeAt(0),'\0'.charCodeAt(0),'\v'.charCodeAt(0),'\u{1F600}'.length]",Cancellation::default()).await.value,Ok(parse_json("[55296,255,0,11,2]").unwrap()));
    assert_eq!(
        runtime
            .execute("return [`a\r\nb\rc`, 'x\\\r\ny']", Cancellation::default())
            .await
            .value,
        Ok(parse_json("[\"a\\nb\\nc\",\"xy\"]").unwrap())
    );
}
