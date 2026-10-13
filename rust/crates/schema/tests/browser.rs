use ycoding_schema::{DomainDecode, DomainEncode, browser, parse_json, stringify_json};

#[test]
fn action_results_strip_the_input_transport_without_changing_public_fields() {
    let result = browser::ActionResult::decode(&parse_json(r#"{"callID":"call_contract","tab":{"id":"btab_contract","sessionID":"ses_contract","title":"Fixture","page":{"origin":"https://example.test","path":"/"},"generation":1,"documentGeneration":2,"observationRevision":3,"status":"shared","mode":"profile"},"status":"completed","input":"scripted","groupID":0}"#).unwrap()).unwrap();
    assert_eq!(result.status, browser::ResultStatus::Completed);
    assert_eq!(result.group_id.unwrap().get(), 0);
    let output = stringify_json(&result.encode());
    assert!(!output.contains("\"input\""));
    assert!(output.contains("\"callID\":\"call_contract\""));
    assert!(output.contains("\"documentGeneration\":2"));
    assert_eq!(
        browser::ActionResult::decode(&result.encode()).unwrap(),
        result
    );
}
