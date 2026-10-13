use ycoding_core::tools::code_mode::{ToolHost, openapi};
use ycoding_schema::{JsonObject, JsonValue, parse_json};

fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(value) = value else {
        return None;
    };
    value.get(&name.into())
}

#[test]
fn committed_openapi_generation_and_signatures() {
    let fixture = parse_json(include_str!("openapi-corpus.json")).unwrap();
    let Some(JsonValue::Array(cases)) = field(&fixture, "cases") else {
        panic!("OpenAPI corpus must declare cases")
    };
    assert!(!cases.is_empty());
    for case in cases {
        let options = openapi::Options {
            base_url: match field(case, "baseUrl") {
                Some(JsonValue::String(value)) => Some(value.to_utf8().unwrap()),
                _ => None,
            },
            namespace: None,
            headers: JsonObject::new(),
            auth: None,
            client: reqwest::Client::new(),
        };
        let generated = openapi::Host::from_spec(field(case, "spec").unwrap(), options);
        let Some(JsonValue::Array(expected)) = field(case, "tools") else {
            panic!("OpenAPI case must declare tools")
        };
        let catalog = generated.host.catalog();
        assert_eq!(catalog.len(), expected.len(), "{:?}", field(case, "test"));
        for (actual, expected) in catalog.iter().zip(expected) {
            assert_eq!(
                Some(&JsonValue::String(actual.path.clone())),
                field(expected, "path"),
                "{:?}",
                field(case, "test")
            );
            assert_eq!(
                Some(&JsonValue::String(actual.description.clone().into())),
                field(expected, "description"),
                "{:?}",
                field(case, "test")
            );
            assert_eq!(
                Some(&JsonValue::String(actual.signature.clone().into())),
                field(expected, "signature"),
                "{:?}: {}",
                field(case, "test"),
                actual.path.to_utf8().unwrap()
            );
        }
        let Some(JsonValue::Array(expected)) = field(case, "skipped") else {
            panic!("OpenAPI case must declare skipped operations")
        };
        assert_eq!(
            generated.skipped.len(),
            expected.len(),
            "{:?}",
            field(case, "test")
        );
        for (actual, expected) in generated.skipped.iter().zip(expected) {
            assert_eq!(
                Some(&JsonValue::String(actual.reason.clone().into())),
                field(expected, "reason")
            );
            assert_eq!(
                Some(&JsonValue::String(actual.path.clone().into())),
                field(expected, "path")
            );
            assert_eq!(
                Some(&JsonValue::String(actual.method.clone().into())),
                field(expected, "method")
            );
        }
    }
}
