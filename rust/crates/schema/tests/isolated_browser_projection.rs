use serde_json::{Value, json};
use ycoding_schema::{
    DecodeError, DomainDecode, DomainEncode, JsonValue, browser, isolated_browser, parse_json,
};

fn same(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same(value, other)))
        }
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same(left, right))
        }
        _ => left == right,
    }
}

fn decode<T: DomainDecode>(value: &Value) -> Result<T, DecodeError> {
    T::decode(&parse_json(&value.to_string()).unwrap())
}

fn round_trip<T: DomainDecode + DomainEncode>(value: &Value) {
    let input = parse_json(&value.to_string()).unwrap();
    assert!(same(&T::decode(&input).unwrap().encode(), &input));
}

fn observation() -> Value {
    json!({
        "tabID": "btab_fixture", "generation": 1, "documentGeneration": 1, "revision": 0,
        "title": "Fixture", "page": { "origin": "https://example.test", "path": "/" },
        "elements": [], "truncated": false, "mode": "isolated", "instanceID": "ibrowser_fixture",
    })
}

fn result() -> Value {
    json!({
        "mode": "isolated", "instanceID": "ibrowser_fixture", "callID": "call_fixture",
        "tab": {
            "id": "btab_fixture", "sessionID": "ses_fixture", "title": "Fixture",
            "page": { "origin": "https://example.test", "path": "/" }, "status": "shared",
            "generation": 1, "documentGeneration": 1, "observationRevision": 0,
        },
        "status": "completed",
    })
}

#[test]
fn observations_preserve_optional_texts_frames_and_lossless_frame_content() {
    round_trip::<isolated_browser::Observation>(&observation());
    let mut empty = observation();
    empty["texts"] = json!([]);
    empty["frames"] = json!([]);
    round_trip::<isolated_browser::Observation>(&empty);

    let input = parse_json(r#"{"tabID":"btab_fixture","generation":1,"documentGeneration":1,"revision":0,"title":"Fixture","page":{"origin":"https://example.test","path":"/"},"elements":[],"texts":[{"role":"paragraph","name":"\ud800","frame":{"origin":"https://child.test","path":"/frame"}}],"frames":[{"page":{"origin":"https://child.test","path":"/frame"},"observed":false}],"truncated":false,"mode":"isolated","instanceID":"ibrowser_fixture"}"#).unwrap();
    assert!(same(
        &isolated_browser::Observation::decode(&input)
            .unwrap()
            .encode(),
        &input
    ));
    for key in ["texts", "frames"] {
        let mut invalid = observation();
        invalid[key] = Value::Null;
        assert!(
            decode::<isolated_browser::Observation>(&invalid).is_err(),
            "{key}"
        );
    }
}

#[test]
fn observations_enforce_inherited_collection_and_nested_bounds() {
    for (key, maximum, item) in [
        (
            "texts",
            browser::MAX_OBSERVATION_TEXTS,
            json!({"role":"paragraph","name":"Fixture"}),
        ),
        (
            "frames",
            browser::MAX_OBSERVATION_FRAMES,
            json!({"page":{"origin":"https://child.test","path":"/"},"observed":true}),
        ),
        (
            "elements",
            browser::MAX_OBSERVATION_ELEMENTS,
            json!({"ref":"b1","role":"button","name":"Fixture"}),
        ),
    ] {
        let mut value = observation();
        value[key] = json!(vec![item.clone(); maximum + 1]);
        assert!(
            decode::<isolated_browser::Observation>(&value).is_err(),
            "{key}"
        );
        value[key] = json!(vec![item; maximum]);
        round_trip::<isolated_browser::Observation>(&value);
    }
    let mut value = observation();
    value["title"] = json!("x".repeat(browser::MAX_TITLE_LENGTH + 1));
    assert!(decode::<isolated_browser::Observation>(&value).is_err());
    let mut value = observation();
    value["texts"] = json!([{"role":"paragraph","name":"x".repeat(browser::MAX_NAME_LENGTH + 1)}]);
    assert!(decode::<isolated_browser::Observation>(&value).is_err());
    let mut value = observation();
    value["frames"] = json!([{"page":{"origin":"https://child.test","path":"/"},"observed":null}]);
    assert!(decode::<isolated_browser::Observation>(&value).is_err());
}

#[test]
fn action_results_preserve_current_projection_and_strip_noncanonical_fields() {
    round_trip::<isolated_browser::ActionResult>(&result());
    let input = parse_json(r#"{"mode":"isolated","instanceID":"ibrowser_fixture","callID":"call_fixture","tab":{"id":"btab_fixture","sessionID":"ses_fixture","title":"Fixture","page":{"origin":"https://example.test","path":"/"},"status":"shared","generation":1,"documentGeneration":1,"observationRevision":0},"status":"completed","text":"\ud800","logs":[{"level":"info","text":"\udfff","frame":{"origin":"https://child.test","path":"/frame"}}],"savedFile":{"path":"fixture.mhtml","bytes":0},"webmcpTools":[{"name":"fixture.echo","description":""}]}"#).unwrap();
    assert!(same(
        &isolated_browser::ActionResult::decode(&input)
            .unwrap()
            .encode(),
        &input
    ));
    let mut empty = result();
    empty["text"] = json!("");
    empty["logs"] = json!([]);
    empty["webmcpTools"] = json!([]);
    round_trip::<isolated_browser::ActionResult>(&empty);
    for key in ["text", "logs", "savedFile", "webmcpTools"] {
        let mut value = result();
        value[key] = Value::Null;
        assert!(
            decode::<isolated_browser::ActionResult>(&value).is_err(),
            "{key}"
        );
    }
    let mut value = result();
    value["download"] = json!({"invalid":true});
    value["groupID"] = json!("invalid");
    assert!(same(
        &decode::<isolated_browser::ActionResult>(&value)
            .unwrap()
            .encode(),
        &parse_json(&result().to_string()).unwrap()
    ));
    value["status"] = json!("paused");
    assert!(decode::<isolated_browser::ActionResult>(&value).is_err());
}

#[test]
fn action_results_enforce_utf8_collection_and_paired_record_bounds() {
    let mut value = result();
    value["text"] = json!("é".repeat(browser::MAX_CLIPBOARD_BYTES / 2 + 1));
    assert!(decode::<isolated_browser::ActionResult>(&value).is_err());
    value["text"] = json!("é".repeat(browser::MAX_CLIPBOARD_BYTES / 2));
    round_trip::<isolated_browser::ActionResult>(&value);
    for (key, item) in [
        ("logs", json!({"level":"info","text":"Fixture"})),
        ("webmcpTools", json!({"name":"fixture.echo"})),
    ] {
        let mut value = result();
        value[key] = json!(vec![item.clone(); browser::MAX_LOG_ENTRIES + 1]);
        assert!(
            decode::<isolated_browser::ActionResult>(&value).is_err(),
            "{key}"
        );
        value[key] = json!(vec![item; browser::MAX_LOG_ENTRIES]);
        round_trip::<isolated_browser::ActionResult>(&value);
    }
    for (key, item) in [
        ("logs", json!([{"level":"x".repeat(17),"text":"Fixture"}])),
        ("webmcpTools", json!([{"name":"x".repeat(129)}])),
        ("savedFile", json!({"path":"fixture.mhtml","bytes":-1})),
    ] {
        let mut value = result();
        value[key] = item;
        assert!(
            decode::<isolated_browser::ActionResult>(&value).is_err(),
            "{key}"
        );
    }
}

#[test]
fn isolated_observations_actions_and_results_carry_the_browser_additions() {
    let mut value = observation();
    value["elements"] = json!([{
        "ref": "b1", "role": "checkbox", "name": "Agree", "checked": "mixed",
        "locator": "role=checkbox[name=\"Agree\"]",
    }]);
    value["delta"] = json!({ "baseRevision": 0, "removed": ["role=link[name=\"Old\"]"] });
    value["revision"] = json!(1);
    round_trip::<isolated_browser::Observation>(&value);

    let mut value = result();
    value["dialog"] = json!({ "kind": "prompt", "message": "Name?", "defaultPrompt": "Fixture" });
    value["control"] = json!({ "checked": true });
    value["frame"] = json!({ "origin": "https://child.example.test", "path": "/widget" });
    round_trip::<isolated_browser::ActionResult>(&value);
    value["control"] = json!({ "sensitive": false });
    assert!(decode::<isolated_browser::ActionResult>(&value).is_err());

    round_trip::<isolated_browser::ObserveInput>(&json!({
        "sessionID": "ses_fixture", "tabID": "btab_fixture", "generation": 1,
        "callID": "call_fixture", "instanceID": "ibrowser_fixture", "diff": true,
    }));
    round_trip::<isolated_browser::ActionInput>(&json!({
        "sessionID": "ses_fixture", "tabID": "btab_fixture", "generation": 1,
        "documentGeneration": 1, "observationRevision": 0, "callID": "call_fixture",
        "action": { "type": "fill", "locator": "role=textbox[name=\"Email\"]", "text": "a@b.test" },
        "instanceID": "ibrowser_fixture",
    }));
}
