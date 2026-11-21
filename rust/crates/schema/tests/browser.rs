use ycoding_schema::{DomainDecode, DomainEncode, browser, parse_json, stringify_json};

fn assert_same(actual: ycoding_schema::JsonValue, expected: ycoding_schema::JsonValue) {
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&stringify_json(&actual)).unwrap(),
        serde_json::from_str::<serde_json::Value>(&stringify_json(&expected)).unwrap()
    );
}

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

#[test]
fn profile_groups_keep_zero_and_bound_control_membership() {
    let mut value: serde_json::Value = serde_json::json!({
        "id":"btab_group", "sessionID":"ses_group", "title":"Fixture",
        "page":{"origin":"https://example.test","path":"/"}, "status":"shared",
        "generation":1, "documentGeneration":1, "observationRevision":0, "groupID":0
    });
    let tab = browser::Tab::decode(&parse_json(&value.to_string()).unwrap()).unwrap();
    assert_eq!(tab.group_id.unwrap().get(), 0);
    assert_same(tab.encode(), parse_json(&value.to_string()).unwrap());
    for invalid in [
        serde_json::json!(-1),
        serde_json::json!(0.5),
        serde_json::json!("0"),
        serde_json::Value::Null,
    ] {
        value["groupID"] = invalid;
        assert!(browser::Tab::decode(&parse_json(&value.to_string()).unwrap()).is_err());
    }
    value.as_object_mut().unwrap().remove("groupID");
    let tab = browser::Tab::decode(&parse_json(&value.to_string()).unwrap()).unwrap();
    assert_eq!(tab.group_id, None);
    assert_same(tab.encode(), parse_json(&value.to_string()).unwrap());
    for count in [0, 1, 8, 9] {
        let value = serde_json::json!({"type":"group_control", "tabIDs":vec!["btab_group"; count]});
        let decoded = browser::Action::decode(&parse_json(&value.to_string()).unwrap());
        assert_eq!(decoded.is_ok(), (1..=8).contains(&count), "{count}");
        if let Ok(action) = decoded {
            assert_same(action.encode(), parse_json(&value.to_string()).unwrap());
        }
    }
}

#[test]
fn cross_origin_observations_keep_frame_ownership_and_bounded_texts() {
    let value = parse_json(r#"{"tabID":"btab_contract","generation":1,"documentGeneration":1,"revision":0,"title":"Fixture","page":{"origin":"https://example.test","path":"/"},"elements":[{"ref":"b1","role":"button","name":"Continue","frame":{"origin":"https://frame.test","path":"/widget"}}],"texts":[{"role":"paragraph","name":"Child text","frame":{"origin":"https://frame.test","path":"/widget"}}],"frames":[{"page":{"origin":"https://frame.test","path":"/widget"},"observed":true}],"truncated":false}"#).unwrap();
    let encoded = browser::Observation::decode(&value).unwrap().encode();
    assert_eq!(encoded, value);
    let invalid = stringify_json(&value).replace("\"observed\":true", "\"observed\":null");
    assert!(browser::Observation::decode(&parse_json(&invalid).unwrap()).is_err());
}

#[test]
fn current_browser_actions_keep_their_closed_payloads() {
    for payload in [
        r#"{"type":"back"}"#,
        r#"{"type":"forward"}"#,
        r#"{"type":"reload"}"#,
        r#"{"type":"key","key":"Enter","modifiers":["Control","Shift"]}"#,
        r#"{"type":"wait","ref":"b1","timeoutMs":30000}"#,
        r#"{"type":"clipboard_read"}"#,
        r#"{"type":"clipboard_write","text":"fixture"}"#,
        r#"{"type":"upload","ref":"b1","paths":["fixture.txt"]}"#,
        r#"{"type":"download","timeoutMs":0}"#,
        r#"{"type":"logs","limit":100}"#,
        r#"{"type":"export"}"#,
        r#"{"type":"webmcp_list"}"#,
        r#"{"type":"webmcp_invoke","name":"fixture.echo","arguments":{"value":null}}"#,
    ] {
        let value = parse_json(payload).unwrap();
        assert_same(browser::Action::decode(&value).unwrap().encode(), value);
    }
    for payload in [
        r#"{"type":"key","key":""}"#,
        r#"{"type":"key","key":"Enter","modifiers":["Unknown"]}"#,
        r#"{"type":"wait","ref":"b0"}"#,
        r#"{"type":"wait","timeoutMs":30001}"#,
        r#"{"type":"upload","ref":"b1","paths":[]}"#,
        r#"{"type":"logs","limit":0}"#,
        r#"{"type":"download","timeoutMs":null}"#,
        r#"{"type":"webmcp_invoke","name":""}"#,
    ] {
        assert!(
            browser::Action::decode(&parse_json(payload).unwrap()).is_err(),
            "{payload}"
        );
    }
}

#[test]
fn current_browser_result_payloads_preserve_frame_logs_and_saved_output() {
    let value = parse_json(r#"{"callID":"call_contract","tab":{"id":"btab_contract","sessionID":"ses_contract","title":"Fixture","page":{"origin":"https://example.test","path":"/"},"generation":1,"documentGeneration":2,"observationRevision":3,"status":"shared","mode":"profile"},"status":"completed","text":"clipboard fixture","download":{"filename":"fixture.txt","state":"complete","bytesReceived":1,"totalBytes":1,"mime":"text/plain"},"logs":[{"level":"info","text":"child frame fixture","frame":{"origin":"https://frame.test","path":"/"}}],"savedFile":{"path":"fixture.mhtml","bytes":1},"webmcpTools":[{"name":"fixture.echo","description":"Echo fixture"}]}"#).unwrap();
    assert_same(
        browser::ActionResult::decode(&value).unwrap().encode(),
        value,
    );
}

fn action(payload: &str) -> Result<ycoding_schema::JsonValue, ycoding_schema::DecodeError> {
    assert_same(
        browser::Action::decode(&parse_json(payload).unwrap())?.encode(),
        parse_json(payload).unwrap(),
    );
    Ok(parse_json(payload).unwrap())
}

#[test]
fn dialog_locator_and_capture_variant_actions_round_trip_within_bounds() {
    for payload in [
        r#"{"type":"dialog"}"#,
        r#"{"type":"dialog","accept":true}"#,
        r#"{"type":"dialog","accept":false,"text":"synthetic"}"#,
        r#"{"type":"click","locator":"role=button[name=\"Save\"]"}"#,
        r#"{"type":"click","ref":"b1"}"#,
        r#"{"type":"type","locator":"role=textbox[name=\"Email\"]","text":"a@b.test"}"#,
        r#"{"type":"upload","locator":"role=button[name=\"Attach\"]","paths":["/tmp/fixture.txt"]}"#,
        r#"{"type":"capture","fullPage":true}"#,
        r#"{"type":"capture","clip":{"x":0,"y":10,"width":100,"height":50}}"#,
        r#"{"type":"capture","ref":"b2"}"#,
    ] {
        action(payload).unwrap_or_else(|_| panic!("{payload}"));
    }
    let dialog_text = format!(r#"{{"type":"dialog","text":"{}"}}"#, "x".repeat(4097));
    for payload in [
        dialog_text.as_str(),
        r#"{"type":"click","locator":""}"#,
        r#"{"type":"capture","clip":{"x":-1,"y":0,"width":10,"height":10}}"#,
        r#"{"type":"capture","clip":{"x":0,"y":0,"width":0,"height":10}}"#,
    ] {
        assert!(
            browser::Action::decode(&parse_json(payload).unwrap()).is_err(),
            "{payload}"
        );
    }
}

#[test]
fn fill_select_check_and_hover_actions_round_trip_and_reject_ambiguous_forms() {
    for payload in [
        r#"{"type":"fill","ref":"b1","text":"synthetic"}"#,
        r#"{"type":"fill","locator":"role=textbox[name=\"Email\"]","text":""}"#,
        r#"{"type":"select","ref":"b1","values":["a"]}"#,
        r#"{"type":"select","ref":"b1","labels":["First","Second"]}"#,
        r#"{"type":"select","locator":"role=combobox[name=\"Size\"]","indexes":[0]}"#,
        r#"{"type":"check","ref":"b1","checked":true}"#,
        r#"{"type":"check","locator":"role=checkbox[name=\"Agree\"]","checked":false}"#,
        r#"{"type":"hover","ref":"b1"}"#,
        r#"{"type":"hover","locator":"role=menuitem[name=\"File\"]"}"#,
    ] {
        action(payload).unwrap_or_else(|_| panic!("{payload}"));
    }
    let full = format!(
        r#"{{"type":"fill","ref":"b1","text":"{}"}}"#,
        "x".repeat(browser::MAX_TYPE_BYTES)
    );
    action(&full).unwrap();
    let options = format!(
        r#"{{"type":"select","ref":"b1","values":[{}]}}"#,
        vec!["\"v\""; browser::MAX_SELECT_OPTIONS].join(",")
    );
    action(&options).unwrap();
    let over_text = format!(
        r#"{{"type":"fill","ref":"b1","text":"{}"}}"#,
        "x".repeat(browser::MAX_TYPE_BYTES + 1)
    );
    let over_bytes = format!(
        r#"{{"type":"fill","ref":"b1","text":"{}"}}"#,
        "é".repeat(browser::MAX_TYPE_BYTES / 2 + 1)
    );
    let over_options = format!(
        r#"{{"type":"select","ref":"b1","values":[{}]}}"#,
        vec!["\"v\""; browser::MAX_SELECT_OPTIONS + 1].join(",")
    );
    let long_label = format!(
        r#"{{"type":"select","ref":"b1","labels":["{}"]}}"#,
        "x".repeat(browser::MAX_NAME_LENGTH + 1)
    );
    for payload in [
        over_text.as_str(),
        over_bytes.as_str(),
        over_options.as_str(),
        long_label.as_str(),
        r#"{"type":"fill","ref":"b1"}"#,
        r#"{"type":"select","ref":"b1"}"#,
        r#"{"type":"select","ref":"b1","values":["a"],"labels":["A"]}"#,
        r#"{"type":"select","ref":"b1","values":["a"],"indexes":[0]}"#,
        r#"{"type":"select","ref":"b1","values":[]}"#,
        r#"{"type":"select","ref":"b1","indexes":[-1]}"#,
        r#"{"type":"select","ref":"b1","indexes":[1.5]}"#,
        r#"{"type":"check","ref":"b1"}"#,
        r#"{"type":"check","ref":"b1","checked":"mixed"}"#,
        r#"{"type":"hover","ref":"x1"}"#,
        r#"{"type":"hover","locator":""}"#,
    ] {
        assert!(
            browser::Action::decode(&parse_json(payload).unwrap()).is_err(),
            "{payload}"
        );
    }
}

#[test]
fn wait_accepts_one_condition_and_rejects_combined_conditions_or_a_state_without_a_target() {
    for payload in [
        r#"{"type":"wait"}"#,
        r#"{"type":"wait","ref":"b1","state":"detached"}"#,
        r#"{"type":"wait","locator":"role=heading[name=\"Done\"]"}"#,
        r#"{"type":"wait","locator":"role=dialog[name=\"Saved\"]","state":"hidden","timeoutMs":0}"#,
        r#"{"type":"wait","url":"https://example.test/orders/*"}"#,
        r#"{"type":"wait","load":"domcontentloaded"}"#,
        r#"{"type":"wait","load":"load"}"#,
        r#"{"type":"wait","load":"networkidle","timeoutMs":30000}"#,
        r#"{"type":"wait","text":"Order saved"}"#,
    ] {
        action(payload).unwrap_or_else(|_| panic!("{payload}"));
    }
    let full_url = format!(
        r#"{{"type":"wait","url":"{}"}}"#,
        "x".repeat(browser::MAX_URL_PATTERN_BYTES)
    );
    let full_text = format!(
        r#"{{"type":"wait","text":"{}"}}"#,
        "x".repeat(browser::MAX_WAIT_TEXT_BYTES)
    );
    action(&full_url).unwrap();
    action(&full_text).unwrap();
    let over_url = format!(
        r#"{{"type":"wait","url":"{}"}}"#,
        "x".repeat(browser::MAX_URL_PATTERN_BYTES + 1)
    );
    let over_text = format!(
        r#"{{"type":"wait","text":"{}"}}"#,
        "x".repeat(browser::MAX_WAIT_TEXT_BYTES + 1)
    );
    for payload in [
        over_url.as_str(),
        over_text.as_str(),
        r#"{"type":"wait","ref":"b1","url":"https://example.test/*"}"#,
        r#"{"type":"wait","locator":"role=button[name=\"Go\"]","text":"Go"}"#,
        r#"{"type":"wait","url":"https://example.test/*","load":"load"}"#,
        r#"{"type":"wait","load":"load","text":"Ready"}"#,
        r#"{"type":"wait","state":"visible"}"#,
        r#"{"type":"wait","state":"visible","url":"https://example.test/*"}"#,
        r#"{"type":"wait","ref":"b1","state":"enabled"}"#,
        r#"{"type":"wait","load":"commit"}"#,
        r#"{"type":"wait","url":""}"#,
        r#"{"type":"wait","text":""}"#,
        r#"{"type":"wait","text":"Ready","timeoutMs":30001}"#,
    ] {
        assert!(
            browser::Action::decode(&parse_json(payload).unwrap()).is_err(),
            "{payload}"
        );
    }
}

const TAB: &str = r#"{"id":"btab_contract","sessionID":"ses_contract","title":"Fixture","page":{"origin":"https://example.test","path":"/form"},"status":"shared","generation":1,"documentGeneration":2,"observationRevision":3}"#;

#[test]
fn deliverable_tabs_dialog_results_and_diff_observations_round_trip() {
    let result = format!(
        r#"{{"callID":"c1","tab":{},"status":"completed","dialog":{{"kind":"confirm","message":"Proceed?"}}}}"#,
        TAB.replace(
            r#""observationRevision":3}"#,
            r#""observationRevision":3,"deliverable":true}"#
        )
    );
    let value = parse_json(&result).unwrap();
    assert_same(
        browser::ActionResult::decode(&value).unwrap().encode(),
        value,
    );
    let observation = r#"{"tabID":"btab_contract","generation":1,"documentGeneration":2,"revision":4,"title":"Fixture","page":{"origin":"https://example.test","path":"/form"},"elements":[{"ref":"b1","role":"button","name":"Save","locator":"role=button[name=\"Save\"]"}],"delta":{"baseRevision":3,"removed":["role=link[name=\"Old\"]"]},"truncated":false}"#;
    let value = parse_json(observation).unwrap();
    assert_same(
        browser::Observation::decode(&value).unwrap().encode(),
        value,
    );
    let observe =
        parse_json(r#"{"sessionID":"ses_contract","tabID":"btab_contract","generation":1,"callID":"o1","diff":true}"#)
            .unwrap();
    assert_same(
        browser::ObserveInput::decode(&observe).unwrap().encode(),
        observe,
    );
}

#[test]
fn element_state_control_state_and_match_frame_fields_are_bounded() {
    let observation = |elements: &str| {
        format!(
            r#"{{"tabID":"btab_contract","generation":1,"documentGeneration":2,"revision":3,"title":"Fixture","page":{{"origin":"https://example.test","path":"/form"}},"elements":[{elements}],"truncated":false}}"#
        )
    };
    let value = parse_json(&observation(
        r#"{"ref":"b1","role":"checkbox","name":"Agree","checked":"mixed"},{"ref":"b2","role":"button","name":"Bold","pressed":true},{"ref":"b3","role":"combobox","name":"Size","expanded":false,"value":"Large"},{"ref":"b4","role":"option","name":"Small","selected":true},{"ref":"b5","role":"textbox","name":"Password","sensitive":true}"#,
    ))
    .unwrap();
    assert_same(
        browser::Observation::decode(&value).unwrap().encode(),
        value,
    );
    let full_value = format!(
        r#"{{"ref":"b6","role":"textbox","name":"Notes","value":"{}"}}"#,
        "x".repeat(browser::MAX_NAME_LENGTH)
    );
    assert!(browser::Observation::decode(&parse_json(&observation(&full_value)).unwrap()).is_ok());
    let over_value = format!(
        r#"{{"ref":"b1","role":"textbox","name":"Notes","value":"{}"}}"#,
        "x".repeat(browser::MAX_NAME_LENGTH + 1)
    );
    for element in [
        over_value.as_str(),
        r#"{"ref":"b1","role":"textbox","name":"Password","sensitive":false}"#,
        r#"{"ref":"b1","role":"checkbox","name":"Agree","checked":"true"}"#,
        r#"{"ref":"b1","role":"button","name":"Bold","pressed":"partial"}"#,
        r#"{"ref":"b1","role":"combobox","name":"Size","expanded":"mixed"}"#,
        r#"{"ref":"b1","role":"option","name":"Small","selected":"mixed"}"#,
    ] {
        assert!(
            browser::Observation::decode(&parse_json(&observation(element)).unwrap()).is_err(),
            "{element}"
        );
    }
    let result =
        |extra: &str| format!(r#"{{"callID":"c1","tab":{TAB},"status":"completed"{extra}}}"#);
    let value = parse_json(&result(
        r#","control":{"checked":false,"value":"synthetic","selected":[{"value":"s","label":"Small","index":0},{"label":"Listbox","index":2}]},"frame":{"origin":"https://child.example.test","path":"/widget"}"#,
    ))
    .unwrap();
    assert_same(
        browser::ActionResult::decode(&value).unwrap().encode(),
        value,
    );
    let sensitive = parse_json(&result(r#","control":{"sensitive":true}"#)).unwrap();
    assert_same(
        browser::ActionResult::decode(&sensitive).unwrap().encode(),
        sensitive,
    );
    let over_value = format!(
        r#","control":{{"value":"{}"}}"#,
        "x".repeat(browser::MAX_NAME_LENGTH + 1)
    );
    let over_selected = format!(
        r#","control":{{"selected":[{}]}}"#,
        vec![r#"{"label":"x","index":0}"#; browser::MAX_SELECT_OPTIONS + 1].join(",")
    );
    for extra in [
        over_value.as_str(),
        over_selected.as_str(),
        r#","control":{"sensitive":false}"#,
        r#","control":{"checked":"on"}"#,
        r#","control":{"selected":[{"label":"x","index":-1}]}"#,
        r#","control":{"selected":[{"value":"x","index":0}]}"#,
        r#","frame":{"origin":"https://child.example.test","path":"/w?token=x"}"#,
    ] {
        assert!(
            browser::ActionResult::decode(&parse_json(&result(extra)).unwrap()).is_err(),
            "{extra}"
        );
    }
}

#[test]
fn downloads_preserve_unknown_metadata_and_known_zero_without_inventing_values() {
    for text in [
        r#"{"filename":"fixture","state":"in_progress"}"#,
        r#"{"filename":"fixture","state":"in_progress","bytesReceived":0}"#,
        r#"{"filename":"fixture","state":"complete","totalBytes":0,"mime":""}"#,
    ] {
        let value = parse_json(text).unwrap();
        assert_same(
            browser::DownloadInfo::decode(&value).unwrap().encode(),
            value,
        );
    }
    for text in [
        r#"{"filename":"fixture","state":"in_progress","bytesReceived":null}"#,
        r#"{"filename":"fixture","state":"in_progress","totalBytes":-1}"#,
    ] {
        assert!(browser::DownloadInfo::decode(&parse_json(text).unwrap()).is_err());
    }
}
