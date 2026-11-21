fn u6_ax(role: &str, name: &str, backend: i64, properties: Value, value: Option<&str>) -> Value {
    let mut node = json!({"role":{"value":role},"name":{"value":name},"backendDOMNodeId":backend,"properties":properties});
    if let Some(value) = value {
        node["value"] = json!({"value": value});
    }
    node
}

#[tokio::test]
async fn popup_ax_expands_deep_options_and_menu_items_with_stable_row_locators() {
    bounded(async {
        let mut behavior = page_behavior();
        behavior["ax"] = json!([
            {"nodeId":"root","role":{"value":"RootWebArea"},"childIds":["layer-0"]}
        ]);
        let mut branches = serde_json::Map::new();
        for index in 0..20 {
            branches.insert(
                if index == 0 {
                    "root".into()
                } else {
                    format!("layer-{}", index - 1)
                },
                json!([{"nodeId":format!("layer-{index}"),"role":{"value":"group"},"childIds":
                    if index == 19 { json!(["option","menu"]) } else { json!([format!("layer-{}", index + 1)]) }}]),
            );
        }
        branches.insert(
            "layer-19".into(),
            json!([
                {"nodeId":"option","role":{"value":"option"},"name":{"value":"ACC-9"},"backendDOMNodeId":41},
                {"nodeId":"menu","role":{"value":"menuitem"},"name":{"value":"Archive"},"backendDOMNodeId":42}
            ]),
        );
        behavior["axChildren"] = Value::Object(branches);
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        let first = owner.page().observe().await.unwrap();
        let second = owner.page().observe().await.unwrap();
        assert!(!first.truncated);
        assert_eq!(
            fixture.command("Accessibility.getFullAXTree")["params"]["depth"],
            32
        );
        assert_eq!(first.elements.len(), 2);
        assert_eq!(
            first.elements[0].locator.as_ref().map(text),
            Some("role=option[name=\"ACC-9\"]")
        );
        assert_eq!(
            first.elements[1].locator.as_ref().map(text),
            Some("role=menuitem[name=\"Archive\"]")
        );
        assert_eq!(
            first.elements.iter()
                .map(|element| (&element.r#ref, &element.locator))
                .collect::<Vec<_>>(),
            second.elements.iter()
                .map(|element| (&element.r#ref, &element.locator))
                .collect::<Vec<_>>()
        );
        run_action(
            &owner,
            json!({"type":"click","ref":text(&second.elements[0].r#ref)}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        assert!(fixture.commands().iter().any(|command| {
            command["method"] == "DOM.getContentQuads" && command["params"]["backendNodeId"] == 41
        }));
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

#[tokio::test]
async fn popup_ax_expansion_is_bounded_and_reports_truncation() {
    bounded(async {
        let mut behavior = page_behavior();
        let mut nodes = vec![
            ax("option", "Bulk", 41),
            ax("option", "Bulk", 42),
            ax("option", "Bulk", 43),
        ];
        for index in 0..300 {
            nodes.push(json!({"nodeId":format!("branch-{index}"),"role":{"value":"group"},"childIds":[format!("missing-{index}")]}));
        }
        behavior["ax"] = json!(nodes);
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        let observed = owner.page().observe().await.unwrap();
        assert!(observed.truncated);
        assert_eq!(observed.elements.len(), 3);
        assert_eq!(
            observed.elements[2].locator.as_ref().map(text),
            Some("role=option[name=\"Bulk\"]|nth=2")
        );
        assert_eq!(
            fixture.methods().iter()
                .filter(|method| method.as_str() == "Accessibility.getChildAXNodes")
                .count(),
            256
        );
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

fn popup_row_behavior() -> Value {
    let mut behavior = page_behavior();
    behavior["ax"] = json!([
        u6_ax("button", "Region", 10, json!([
            {"name":"expanded","value":{"value":true}},
            {"name":"controls","value":{"relatedNodes":[{"backendDOMNodeId":30}]}}
        ]), None)
    ]);
    behavior["popupRows"] = json!({"node-30":[31,32,33,34,35]});
    behavior["rowNames"] = json!({
        "node-31":"North region", "node-32":"South region",
        "node-33":"Token row", "node-34":"Shadow row", "node-35":"Incomplete row"
    });
    behavior["dom"]["31"] = json!({"nodeName":"DIV","backendNodeId":31,"attributes":[],"children":[{"nodeType":3,"nodeName":"#text","nodeValue":"North region"}]});
    behavior["dom"]["32"] = json!({"nodeName":"DIV","backendNodeId":32,"attributes":[]});
    behavior["dom"]["33"] = json!({"nodeName":"DIV","backendNodeId":33,"attributes":[],"children":[{"nodeType":1,"nodeName":"INPUT","attributes":["type","password"]}]});
    behavior["dom"]["34"] = json!({"nodeName":"DIV","backendNodeId":34,"attributes":[],"shadowRoots":[{"shadowRootType":"closed"}]});
    behavior["dom"]["35"] = json!({"nodeName":"DIV","backendNodeId":35,"attributes":[],"childNodeCount":1});
    behavior
}

#[tokio::test]
async fn popup_rows_bind_each_locator_to_its_row_and_recheck_hit_targets() {
    bounded(async {
        let mut behavior = popup_row_behavior();
        behavior["rowHit"] = json!({"node-32":false});
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        let observed = owner.page().observe().await.unwrap();
        let rows = observed.elements.iter()
            .filter(|element| text(&element.role) == "clickable")
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].locator.as_ref().map(text),
            Some("role=clickable[name=\"North region\"]")
        );
        assert_eq!(
            rows[1].locator.as_ref().map(text),
            Some("role=clickable[name=\"South region\"]")
        );
        run_action(
            &owner,
            json!({"type":"wait","locator":text(rows[0].locator.as_ref().unwrap()),"timeoutMs":0}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        let refreshed = owner.page().observe().await.unwrap();
        let north = refreshed.elements.iter()
            .find(|element| text(&element.name) == "North region")
            .unwrap();
        let south = refreshed.elements.iter()
            .find(|element| text(&element.name) == "South region")
            .unwrap();
        let before = fixture.commands().len();
        let failure = run_action(
            &owner,
            json!({"type":"click","ref":text(&south.r#ref)}),
            &["https://example.test"],
        )
        .await
        .unwrap_err();
        assert_eq!(failure.phase, super::super::isolated::Phase::Predispatch);
        assert_eq!(failure.message, "The inferred row is not visible at its click point");
        assert!(!fixture.commands()[before..].iter()
            .any(|command| command["method"] == "Input.dispatchMouseEvent"));
        assert!(fixture.commands()[before..].iter().any(|command| {
            command["method"] == "DOM.getContentQuads" && command["params"]["backendNodeId"] == 32
        }));
        run_action(
            &owner,
            json!({"type":"click","ref":text(&north.r#ref)}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        assert_eq!(
            fixture.commands().iter()
                .rfind(|command| command["method"] == "DOM.getContentQuads")
                .unwrap()["params"]["backendNodeId"],
            31
        );
        let scans = fixture.commands().into_iter()
            .filter(|command| {
                command["method"] == "Runtime.callFunctionOn"
                    && command["params"]["functionDeclaration"].as_str()
                        .is_some_and(|source| source.starts_with("function (limit, nodes, visits)"))
            })
            .collect::<Vec<_>>();
        assert!(!scans.is_empty());
        assert_eq!(
            scans[0]["params"]["arguments"],
            json!([{"value":200},{"value":64},{"value":2000}])
        );
        assert!(fixture.methods().iter().any(|method| method == "Runtime.releaseObjectGroup"));
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

#[tokio::test]
async fn popup_row_scans_keep_container_and_page_side_truncation_bounds() {
    bounded(async {
        let mut behavior = popup_row_behavior();
        behavior["ax"] = json!((0..17).map(|index| ax("listbox", "List", 30 + index)).collect::<Vec<_>>());
        behavior["popupTruncated"] = json!(true);
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        let observed = owner.page().observe().await.unwrap();
        assert!(observed.truncated);
        assert!(observed.elements.len() < ycoding_schema::browser::MAX_OBSERVATION_ELEMENTS);
        assert_eq!(
            fixture.commands().iter()
                .filter(|command| {
                    command["method"] == "Runtime.callFunctionOn"
                        && command["params"]["functionDeclaration"].as_str()
                            .is_some_and(|source| source.starts_with("function (limit, nodes, visits)"))
                })
                .count(),
            16
        );
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

fn listbox_behavior(combobox: bool, selected: bool, value: &str) -> Value {
    let mut behavior = page_behavior();
    let properties = json!([
        {"name":"expanded","value":{"value":true}},
        {"name":"controls","value":{"relatedNodes":[{"backendDOMNodeId":30}]}}
    ]);
    let control = u6_ax(
        if combobox { "combobox" } else { "listbox" },
        "Account Code",
        10,
        properties,
        Some("ACC-0"),
    );
    let list = ax("listbox", "Accounts", 30);
    let option = u6_ax(
        "option",
        "ACC-4",
        41,
        json!([{ "name":"selected","value":{"value":false}}]),
        None,
    );
    behavior["ax"] = if combobox {
        json!([control, list, option])
    } else {
        json!([control, option])
    };
    behavior["dom"]["10"] = json!({"nodeName":if combobox { "INPUT" } else { "DIV" },"attributes":[]});
    behavior["dom"]["41"] = json!({"nodeName":"DIV","attributes":["role","option"]});
    behavior["queryAX"] = json!([u6_ax("option", "ACC-4", 41, json!([{ "name":"selected","value":{"value":false}}]), None)]);
    behavior["afterClickAx"] = if combobox {
        json!([u6_ax("combobox", "Account Code", 10, json!([{ "name":"expanded","value":{"value":false}}]), Some(value))])
    } else {
        json!([ax("listbox", "Account Code", 10), u6_ax("option", "ACC-4", 41, json!([{ "name":"selected","value":{"value":selected}}]), None)])
    };
    behavior
}

#[tokio::test]
async fn popup_selection_requires_selected_state_or_closed_combobox_value_confirmation() {
    bounded(async {
        for (combobox, selected, value, confirmed) in [
            (false, true, "", true),
            (false, false, "", false),
            (true, false, "ACC-4", true),
            (true, false, "ACC-0", false),
        ] {
            let fixture = Fixture::with("normal", listbox_behavior(combobox, selected, value));
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let observed = owner.page().observe().await.unwrap();
            let control = observed.elements.iter()
                .find(|element| text(&element.name) == "Account Code")
                .unwrap();
            assert_eq!(control.sensitive, None);
            let action = if combobox {
                json!({"type":"select","ref":text(&control.r#ref),"labels":["  ACC-4  "]})
            } else {
                json!({"type":"select","ref":text(&control.r#ref),"indexes":[0]})
            };
            let result = run_action(&owner, action, &["https://example.test"])
                .await
                .unwrap();
            let options = result.control.unwrap().selected.unwrap();
            assert_eq!(options.len(), usize::from(confirmed));
            if confirmed {
                assert_eq!(text(&options[0].label), "ACC-4");
                assert_eq!(options[0].index.get(), 0);
                assert_eq!(result.message, None);
            } else {
                assert_eq!(
                    result.message.as_ref().map(text),
                    Some("The selection could not be confirmed")
                );
            }
            assert_eq!(
                fixture.commands().iter()
                    .filter(|command| command["method"] == "Input.dispatchMouseEvent"
                        && command["params"]["type"] == "mouseReleased")
                    .count(),
                1
            );
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        }
    })
    .await;
}

#[tokio::test]
async fn popup_selection_rejects_invalid_options_before_dispatch_and_keeps_selected_options_idle() {
    bounded(async {
        for (action, disabled, already_selected, collapsed) in [
            (json!({"type":"select","ref":"b1","values":["ACC-4"]}), false, false, false),
            (json!({"type":"select","ref":"b1","labels":["missing"]}), false, false, false),
            (json!({"type":"select","ref":"b1","labels":["ACC-4"]}), true, false, false),
            (json!({"type":"select","ref":"b1","labels":["ACC-4"]}), false, true, false),
            (json!({"type":"select","ref":"b1","labels":["ACC-4"]}), false, false, true),
        ] {
            let mut behavior = listbox_behavior(collapsed, false, "");
            behavior["queryAX"][0]["properties"] = json!([
                {"name":"selected","value":{"value":already_selected}},
                {"name":"disabled","value":{"value":disabled}}
            ]);
            if collapsed {
                behavior["ax"][0]["properties"][0]["value"]["value"] = json!(false);
            }
            let fixture = Fixture::with("normal", behavior);
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            let result = run_action(&owner, action, &["https://example.test"]).await;
            if already_selected {
                assert_eq!(result.unwrap().control.unwrap().selected.unwrap().len(), 1);
            } else {
                assert_eq!(
                    result.unwrap_err().phase,
                    super::super::isolated::Phase::Predispatch
                );
            }
            assert!(!fixture.methods().iter().any(|method| method == "Input.dispatchMouseEvent"));
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        }
    })
    .await;
}

#[tokio::test]
async fn applied_fill_and_select_responses_are_not_replayed_after_context_loss() {
    bounded(async {
        for kind in ["fill", "select"] {
            let expected = if kind == "fill" { "2026-11-17" } else { "B" };
            let mut behavior = page_behavior();
            behavior["ax"] = json!([ax("combobox", "Choice", 10)]);
            behavior["dom"]["10"] = json!({"nodeName":if kind == "fill" { "INPUT" } else { "SELECT" },"attributes":["type","date"]});
            behavior["functions"] = json!({
                "setTypes": {"result":{"value":{"kind":"set"}}},
                "Element is not a select": {"result":{"value":{"ok":true}}},
                "selectedOptions": {"result":{"value":{"value":expected}}}
            });
            behavior["lostControlResponse"] = json!(true);
            behavior["afterApplyAx"] = json!([u6_ax("combobox", "Choice", 10, json!([]), Some(expected))]);
            let fixture = Fixture::with("normal", behavior);
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            let action = if kind == "fill" {
                json!({"type":"fill","ref":"b1","text":"2026-11-17"})
            } else {
                json!({"type":"select","ref":"b1","values":["b"]})
            };
            let failure = run_action(&owner, action.clone(), &["https://example.test"])
                .await
                .unwrap_err();
            assert_eq!(failure.phase, super::super::isolated::Phase::Postdispatch);
            assert_eq!(failure.message, "Cannot find context with specified id");
            let applications = |commands: Vec<Value>| {
                commands.into_iter()
                    .filter(|command| command["method"] == "Runtime.callFunctionOn"
                        && command["params"]["arguments"][1]["value"] == true)
                    .count()
            };
            assert_eq!(applications(fixture.commands()), 1);
            let observed = owner.page().observe().await.unwrap();
            assert_eq!(observed.elements[0].value.as_ref().map(text), Some(expected));
            assert_eq!(applications(fixture.commands()), 1);
            run_action(&owner, action, &["https://example.test"])
                .await
                .unwrap();
            assert_eq!(applications(fixture.commands()), 2);
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        }
    })
    .await;
}

#[tokio::test]
async fn popup_secret_fields_refuse_fill_and_type_before_any_input_dispatch() {
    bounded(async {
        for (name, attributes) in [
            ("Client secret", json!(["type","text","name","client_secret"])),
            ("Shared secrets", json!(["type","text"])),
            ("Login code", json!(["type","text","autocomplete","one-time-code"])),
        ] {
            let mut behavior = page_behavior();
            behavior["ax"] = json!([ax("textbox", name, 10)]);
            behavior["dom"]["10"] = json!({"nodeName":"INPUT","attributes":attributes});
            let fixture = Fixture::with("normal", behavior);
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let observed = owner.page().observe().await.unwrap();
            assert_eq!(observed.elements[0].sensitive, Some(true));
            assert_eq!(observed.elements[0].value, None);
            for kind in ["fill", "type"] {
                let before = fixture.commands().len();
                let failure = run_action(
                    &owner,
                    json!({"type":kind,"ref":"b1","text":"synthetic"}),
                    &["https://example.test"],
                )
                .await
                .unwrap_err();
                assert_eq!(failure.phase, super::super::isolated::Phase::Predispatch);
                assert!(!fixture.commands()[before..].iter().any(|command| {
                    command["method"].as_str().is_some_and(|method| method.starts_with("Input."))
                }));
            }
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        }
    })
    .await;
}

#[tokio::test]
async fn chrome_for_testing_banner_keeps_the_minimum_major() {
    bounded(async {
        for (banner, available) in [
            ("Google Chrome for Testing 152.0.0", true),
            ("Google Chrome for Testing 151.0.0", false),
        ] {
            let fixture = Fixture::with("normal", json!({"versionBanner":banner}));
            let options = fixture.options();
            assert_eq!(
                super::super::chrome::availability(&options.executable, "darwin", "arm64")
                    .await
                    .available,
                available
            );
        }
    })
    .await;
}

#[tokio::test]
async fn u6_observation_reports_state_locators_and_sensitive_fields() {
    bounded(async {
        let mut behavior = page_behavior();
        behavior["ax"] = json!([
            u6_ax("checkbox", "Agree", 10, json!([{"name":"checked","value":{"value":"mixed"}}]), None),
            u6_ax("button", "Go", 11, json!([{"name":"pressed","value":{"value":true}},{"name":"expanded","value":{"value":false}}]), None),
            u6_ax("button", "Go", 12, json!([]), None),
            u6_ax("textbox", "Password", 13, json!([]), Some("hunter2")),
            u6_ax("textbox", "Name", 14, json!([]), Some("Ada")),
            u6_ax("textbox", "Card number", 15, json!([]), Some("4111")),
        ]);
        behavior["dom"] = json!({
            "10": {"nodeName": "INPUT", "attributes": ["type", "checkbox"]},
            "11": {"nodeName": "BUTTON", "attributes": []},
            "12": {"nodeName": "BUTTON", "attributes": []},
            "13": {"nodeName": "INPUT", "attributes": ["type", "password"]},
            "14": {"nodeName": "INPUT", "attributes": ["type", "text"]},
            "15": {"nodeName": "INPUT", "attributes": ["type", "text", "autocomplete", "cc-number"]},
        });
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        let observed = owner.page().observe().await.unwrap();
        let by_name = |name: &str| {
            observed
                .elements
                .iter()
                .find(|element| text(&element.name) == name)
                .unwrap()
        };
        assert_eq!(by_name("Agree").checked, Some(ycoding_schema::browser::Tristate::Mixed));
        let first_go = observed
            .elements
            .iter()
            .find(|element| text(&element.name) == "Go")
            .unwrap();
        assert_eq!(first_go.pressed, Some(ycoding_schema::browser::Tristate::Boolean(true)));
        assert_eq!(first_go.expanded, Some(false));
        assert_eq!(
            first_go.locator.as_ref().map(text),
            Some("role=button[name=\"Go\"]")
        );
        let second_go = observed
            .elements
            .iter()
            .filter(|element| text(&element.name) == "Go")
            .nth(1)
            .unwrap();
        assert_eq!(
            second_go.locator.as_ref().map(text),
            Some("role=button[name=\"Go\"]|nth=1")
        );
        let password = by_name("Password");
        assert_eq!(password.sensitive, Some(true));
        assert_eq!(password.value, None);
        let card = by_name("Card number");
        assert_eq!(card.sensitive, Some(true));
        assert_eq!(card.value, None);
        assert_eq!(by_name("Name").value.as_ref().map(text), Some("Ada"));
        let encoded = ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(&observed.elements));
        assert!(!encoded.contains("hunter2"));
        assert!(!encoded.contains("4111"));
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

#[tokio::test]
async fn u6_fill_select_check_and_hover_drive_the_page_and_report_control_state() {
    bounded(async {
        let mut behavior = page_behavior();
        behavior["ax"] = json!([
            u6_ax("textbox", "Email", 13, json!([]), None),
            u6_ax("combobox", "Country", 17, json!([]), None),
            u6_ax("checkbox", "Agree", 18, json!([{"name":"checked","value":{"value":false}}]), None),
            u6_ax("button", "Menu", 19, json!([]), None),
        ]);
        behavior["dom"]["17"] = json!({"nodeName": "SELECT", "attributes": []});
        behavior["dom"]["18"] = json!({"nodeName": "INPUT", "attributes": ["type", "checkbox"]});
        behavior["dom"]["19"] = json!({"nodeName": "BUTTON", "attributes": []});
        behavior["toggleNode"] = json!(18);
        behavior["functions"] = json!({
            "setTypes": {"result": {"value": {"kind": "insert"}}},
            "Element is not a select": {"result": {"value": {"ok": true}}},
            "selectedOptions": {"result": {"value": {"value": "filled@example.test", "checked": true, "selected": [{"value": "pt", "label": "Portugal", "index": 2}]}}},
        });
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        owner.page().observe().await.unwrap();
        let filled = run_action(
            &owner,
            json!({"type":"fill","ref":"b1","text":"filled@example.test"}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        assert_eq!(
            filled.control.as_ref().and_then(|control| control.value.as_ref()).map(text),
            Some("filled@example.test")
        );
        assert!(fixture.methods().iter().any(|method| method == "Input.insertText"));
        owner.page().observe().await.unwrap();
        let selected = run_action(
            &owner,
            json!({"type":"select","ref":"b2","labels":["Portugal"]}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        let options = selected.control.as_ref().and_then(|control| control.selected.as_ref()).unwrap();
        assert_eq!(options.len(), 1);
        assert_eq!(text(&options[0].label), "Portugal");
        assert_eq!(options[0].index.get(), 2);
        owner.page().observe().await.unwrap();
        let checked = run_action(
            &owner,
            json!({"type":"check","ref":"b3","checked":true}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        assert_eq!(
            checked.control.as_ref().and_then(|control| control.checked),
            Some(ycoding_schema::browser::Tristate::Boolean(true))
        );
        owner.page().observe().await.unwrap();
        let before = fixture.commands().len();
        run_action(
            &owner,
            json!({"type":"hover","ref":"b4"}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        assert!(fixture.commands()[before..].iter().any(|command| {
            command["method"] == "Input.dispatchMouseEvent" && command["params"]["type"] == "mouseMoved"
        }));
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

#[tokio::test]
async fn u6_sensitive_fields_refuse_fill_type_and_editing_keys_before_dispatch() {
    bounded(async {
        let mut behavior = page_behavior();
        behavior["domByObjectId"] =
            json!({"active-1": {"nodeName": "INPUT", "attributes": ["type", "password"]}});
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        let observed = owner.page().observe().await.unwrap();
        let secret = observed
            .elements
            .iter()
            .find(|element| text(&element.name) == "Secret")
            .unwrap();
        assert_eq!(secret.sensitive, Some(true));
        let secret_ref = text(&secret.r#ref).to_owned();
        for action in [
            json!({"type":"fill","ref":secret_ref,"text":"x"}),
            json!({"type":"type","ref":secret_ref,"text":"x"}),
        ] {
            let before = fixture.commands().len();
            let failure = run_action(&owner, action.clone(), &["https://example.test"])
                .await
                .unwrap_err();
            assert_eq!(
                failure.phase,
                super::super::isolated::Phase::Predispatch,
                "{action}"
            );
            assert!(
                !fixture.commands()[before..]
                    .iter()
                    .any(|command| command["method"]
                        .as_str()
                        .is_some_and(|method| method.starts_with("Input."))),
                "{action}"
            );
        }
        let before = fixture.commands().len();
        let failure = run_action(
            &owner,
            json!({"type":"key","key":"a"}),
            &["https://example.test"],
        )
        .await
        .unwrap_err();
        assert_eq!(failure.phase, super::super::isolated::Phase::Predispatch);
        assert!(
            !fixture.commands()[before..]
                .iter()
                .any(|command| command["method"] == "Input.dispatchKeyEvent")
        );
        run_action(
            &owner,
            json!({"type":"key","key":"Tab","modifiers":["Shift"]}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        assert!(
            fixture
                .commands()
                .iter()
                .any(|command| command["method"] == "Input.dispatchKeyEvent")
        );
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

fn focus_node(node_name: &str, backend: i64, attributes: Value) -> Value {
    json!({
        "nodeType": 1,
        "nodeName": node_name,
        "backendNodeId": backend,
        "attributes": attributes,
    })
}

fn focus_behavior(node: Value, focus: Value) -> Value {
    let mut behavior = page_behavior();
    behavior["domByObjectId"] = json!({ "active-main": node });
    behavior["focus"] = json!({ "session-main": focus });
    behavior
}

async fn focus_key(
    behavior: Value,
    origins: &[&str],
    attach_child: bool,
) -> (
    Result<super::super::isolated::ActionOutput, super::ExecutorError>,
    Vec<Value>,
) {
    let fixture = Fixture::with("normal", behavior);
    let owner = Owned::launch(fixture.options()).await.unwrap();
    if attach_child {
        emit(
            &owner,
            json!([{"method":"Target.attachedToTarget","sessionId":"session-main",
                "params":{"sessionId":"session-child","waitingForDebugger":true,"targetInfo":{
                    "type":"iframe","targetId":"target-child","url":"https://child.test/form"}}}]),
        )
        .await;
        eventually(|| {
            owner.page().document().frames.values().any(|frame| {
                frame.session == "session-child" && frame.target.as_deref() == Some("target-child")
            })
        })
        .await;
    }
    let result = run_action(&owner, json!({"type":"key","key":"a"}), origins).await;
    let commands = fixture.commands();
    owner.shutdown().await.unwrap();
    fixture.assert_cleanup();
    (result, commands)
}

fn key_dispatched(commands: &[Value]) -> bool {
    commands
        .iter()
        .any(|command| command["method"] == "Input.dispatchKeyEvent")
}

#[tokio::test]
async fn popup_keyboard_activation_uses_native_enter_and_space_after_verified_focus() {
    bounded(async {
        for (key, expected) in [("Enter", "\r"), ("Space", " "), (" ", " ")] {
            let behavior = focus_behavior(
                focus_node("BODY", 44, json!([])),
                json!({"objectId":"active-main","connected":true,"frameUnreachable":false,"refuseField":false,"accessibleName":null}),
            );
            let fixture = Fixture::with("normal", behavior);
            let owner = Owned::launch(fixture.options()).await.unwrap();
            run_action(
                &owner,
                json!({"type":"key","key":key}),
                &["https://example.test"],
            )
            .await
            .unwrap();
            let commands = fixture.commands();
            let keys = commands.iter()
                .filter(|command| command["method"] == "Input.dispatchKeyEvent")
                .collect::<Vec<_>>();
            assert_eq!(keys.len(), 2);
            assert_eq!(keys[0]["params"]["type"], "keyDown");
            assert_eq!(keys[0]["params"]["text"], expected);
            assert_eq!(keys[1]["params"]["type"], "keyUp");
            assert!(keys[1]["params"].get("text").is_none());
            let focused = commands.iter()
                .position(|command| command["method"] == "Accessibility.getPartialAXTree")
                .unwrap();
            let dispatched = commands.iter()
                .position(|command| command["method"] == "Input.dispatchKeyEvent")
                .unwrap();
            assert!(focused < dispatched);
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        }
    })
    .await;
}

#[tokio::test]
async fn popup_keyboard_keeps_account_code_ordinary_and_blocks_secret_or_unknown_editable_focus() {
    bounded(async {
        for (name, refused) in [
            (json!("Account Code"), false),
            (json!("Client secret"), true),
            (json!("Verification code"), true),
            (Value::Null, true),
        ] {
            for key in ["Enter", "Space"] {
                let behavior = focus_behavior(
                    focus_node("INPUT", 44, json!(["type","text"])),
                    json!({"objectId":"active-main","connected":true,"frameUnreachable":false,"refuseField":false,"accessibleName":name}),
                );
                let fixture = Fixture::with("normal", behavior);
                let owner = Owned::launch(fixture.options()).await.unwrap();
                let result = run_action(
                    &owner,
                    json!({"type":"key","key":key}),
                    &["https://example.test"],
                )
                .await;
                assert_eq!(result.is_err(), refused, "{name}: {key}");
                assert_eq!(key_dispatched(&fixture.commands()), !refused, "{name}: {key}");
                if refused {
                    assert_eq!(
                        result.unwrap_err().phase,
                        super::super::isolated::Phase::Predispatch
                    );
                }
                owner.shutdown().await.unwrap();
                fixture.assert_cleanup();
            }
        }
    })
    .await;
}

#[tokio::test]
async fn popup_keyboard_modifiers_do_not_emit_activation_text() {
    bounded(async {
        let behavior = focus_behavior(
            focus_node("BUTTON", 44, json!([])),
            json!({"objectId":"active-main","connected":true,"frameUnreachable":false,"refuseField":false,"accessibleName":null}),
        );
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        for key in ["Enter", "Space", "Insert"] {
            run_action(
                &owner,
                json!({"type":"key","key":key,"modifiers":["Shift"]}),
                &["https://example.test"],
            )
            .await
            .unwrap();
        }
        assert!(fixture.commands().iter()
            .filter(|command| command["method"] == "Input.dispatchKeyEvent")
            .all(|command| command["params"].get("text").is_none()));
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

#[test]
fn popup_inferred_rows_reject_interactive_shadow_and_incompletely_described_content() {
    let safe = json!({"nodeType":1,"nodeName":"DIV","attributes":[],"children":[{"nodeType":3,"nodeName":"#text"}]});
    let is_safe = |node| {
        super::super::chrome_semantics::row_content_safe(&super::super::chrome_semantics::domain(node))
    };
    assert!(is_safe(safe.clone()));
    for blocked in [
        json!({"nodeType":1,"nodeName":"INPUT","attributes":["type","password"]}),
        json!({"nodeType":1,"nodeName":"DIV","attributes":["contenteditable",""]}),
        json!({"nodeType":1,"nodeName":"DIV","attributes":["role","textbox"]}),
        json!({"nodeType":1,"nodeName":"DIV","attributes":[],"contentDocument":{}}),
        json!({"nodeType":1,"nodeName":"DIV","attributes":[],"shadowRoots":[{"shadowRootType":"open"}]}),
        json!({"nodeType":1,"nodeName":"DIV","attributes":[],"shadowRoots":[{"shadowRootType":"closed"}]}),
        json!({"nodeType":1,"nodeName":"DIV","attributes":[],"childNodeCount":1}),
    ] {
        let mut row = safe.clone();
        row["children"] = json!([blocked]);
        assert!(!is_safe(row));
    }
    let mut row = safe;
    row["children"] = json!(vec![json!({"nodeType":3,"nodeName":"#text"});64]);
    assert!(!is_safe(row));
}

#[tokio::test]
async fn u6_key_focus_closed_shadow_root_is_refused_before_dispatch() {
    bounded(async {
        let mut node = focus_node("INPUT", 41, json!(["type", "text", "name", "ordinary"]));
        node["shadowRoots"] = json!([{"shadowRootType": "closed"}]);
        let behavior = focus_behavior(
            node,
            json!({"objectId":"active-main","connected":true,"frameUnreachable":false,"refuseField":false,"accessibleName":"Ordinary"}),
        );
        let (result, commands) = focus_key(behavior, &["https://example.test"], false).await;
        let failure = result.unwrap_err();
        assert_eq!(failure.phase, super::super::isolated::Phase::Predispatch);
        assert!(!key_dispatched(&commands));
    })
    .await;
}

#[tokio::test]
async fn u6_key_focus_owned_frame_leaf_is_dispatched_after_child_inspection() {
    bounded(async {
        let mut behavior = page_behavior();
        let mut main = focus_node(
            "IFRAME",
            90,
            json!(["src", "https://child.test/form"]),
        );
        main["frameId"] = json!("frame-child");
        behavior["domByObjectId"] = json!({
            "active-main": main,
            "active-child": focus_node("INPUT", 21, json!(["type", "text", "name", "ordinary"])),
        });
        behavior["focus"] = json!({
            "session-main": {"objectId":"active-main","connected":true,"frameUnreachable":true,"refuseField":false,"accessibleName":"Child frame"},
            "session-child": {"objectId":"active-child","connected":true,"frameUnreachable":false,"refuseField":false,"accessibleName":"Ordinary"},
        });
        behavior["responsesBySession"] = json!({"session-child": {
            "Page.getFrameTree": {"frameTree": {"frame": {"id": "frame-child", "url": "https://child.test"}}}
        }});
        let (result, commands) = focus_key(
            behavior,
            &["https://example.test", "https://child.test"],
            true,
        )
        .await;
        assert!(result.is_ok());
        assert!(key_dispatched(&commands));
    })
    .await;
}

#[tokio::test]
async fn u6_key_focus_unowned_frame_leaf_is_refused_before_dispatch() {
    bounded(async {
        let mut node = focus_node(
            "IFRAME",
            90,
            json!(["src", "https://child.test/form"]),
        );
        node["frameId"] = json!("frame-child");
        let behavior = focus_behavior(
            node,
            json!({"objectId":"active-main","connected":true,"frameUnreachable":true,"refuseField":false,"accessibleName":"Child frame"}),
        );
        let (result, commands) = focus_key(
            behavior,
            &["https://example.test", "https://child.test"],
            false,
        )
        .await;
        let failure = result.unwrap_err();
        assert_eq!(failure.phase, super::super::isolated::Phase::Predispatch);
        assert!(!key_dispatched(&commands));
    })
    .await;
}

#[tokio::test]
async fn u6_key_focus_disconnected_leaf_is_refused_before_dispatch() {
    bounded(async {
        let behavior = focus_behavior(
            focus_node("INPUT", 42, json!(["type", "text", "name", "ordinary"])),
            json!({"objectId":"active-main","connected":false,"frameUnreachable":false,"refuseField":false,"accessibleName":"Ordinary"}),
        );
        let (result, commands) = focus_key(behavior, &["https://example.test"], false).await;
        let failure = result.unwrap_err();
        assert_eq!(failure.phase, super::super::isolated::Phase::Predispatch);
        assert!(!key_dispatched(&commands));
    })
    .await;
}

#[tokio::test]
async fn u6_key_focus_accessible_name_sensitive_leaf_is_refused_before_dispatch() {
    bounded(async {
        let behavior = focus_behavior(
            focus_node("INPUT", 43, json!(["type", "text", "name", "field"])),
            json!({"objectId":"active-main","connected":true,"frameUnreachable":false,"refuseField":false,"accessibleName":"Verification code"}),
        );
        let (result, commands) = focus_key(behavior, &["https://example.test"], false).await;
        let failure = result.unwrap_err();
        assert_eq!(failure.phase, super::super::isolated::Phase::Predispatch);
        assert!(!key_dispatched(&commands));
    })
    .await;
}

#[tokio::test]
async fn u6_key_focus_ordinary_leaf_is_dispatched() {
    bounded(async {
        let behavior = focus_behavior(
            focus_node("INPUT", 44, json!(["type", "text", "name", "ordinary"])),
            json!({"objectId":"active-main","connected":true,"frameUnreachable":false,"refuseField":false,"accessibleName":"Ordinary"}),
        );
        let (result, commands) = focus_key(behavior, &["https://example.test"], false).await;
        assert!(result.is_ok());
        assert!(key_dispatched(&commands));
    })
    .await;
}

#[tokio::test]
async fn u6_dialog_is_observed_and_answered_through_cdp() {
    bounded(async {
        let fixture = Fixture::with("normal", page_behavior());
        let owner = Owned::launch(fixture.options()).await.unwrap();
        owner.page().observe().await.unwrap();
        let missing = run_action(&owner, json!({"type":"dialog"}), &["https://example.test"])
            .await
            .unwrap_err();
        assert_eq!(missing.message, "No JavaScript dialog is open on this tab");
        emit(
            &owner,
            json!([{"method":"Page.javascriptDialogOpening","sessionId":"session-main",
            "params":{"type":"prompt","message":"Your name?","defaultPrompt":"Ada"}}]),
        )
        .await;
        eventually(|| owner.page().document().dialog.is_some()).await;
        let read = run_action(&owner, json!({"type":"dialog"}), &["https://example.test"])
            .await
            .unwrap();
        let dialog = read.dialog.unwrap();
        assert_eq!(dialog.kind, ycoding_schema::browser::DialogKind::Prompt);
        assert_eq!(text(&dialog.message), "Your name?");
        assert_eq!(dialog.default_prompt.as_ref().map(text), Some("Ada"));
        run_action(
            &owner,
            json!({"type":"dialog","accept":true,"text":"Grace"}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        let handled = fixture.command("Page.handleJavaScriptDialog");
        assert_eq!(handled["params"]["accept"], true);
        assert_eq!(handled["params"]["promptText"], "Grace");
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

#[tokio::test]
async fn u6_waits_cover_url_text_load_and_locator_state() {
    bounded(async {
        let mut behavior = page_behavior();
        behavior["functions"] = json!({
            "document.readyState": {"result": {"value": "complete"}},
            "needle": {"result": {"value": true}},
            "return this.isConnected": {"result": {"value": true}},
        });
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        owner.page().observe().await.unwrap();
        for action in [
            json!({"type":"wait","ref":"b1","state":"visible","timeoutMs":1000}),
            json!({"type":"wait","url":"https://example.test/*","timeoutMs":1000}),
            json!({"type":"wait","text":"Hello world","timeoutMs":1000}),
            json!({"type":"wait","load":"domcontentloaded","timeoutMs":1000}),
            json!({"type":"wait","timeoutMs":1000}),
            json!({"type":"wait","locator":"role=button[name=\"Go\"]","timeoutMs":1000}),
            json!({"type":"wait","locator":"role=button[name=\"Missing\"]","state":"detached","timeoutMs":1000}),
        ] {
            run_action(&owner, action.clone(), &["https://example.test"])
                .await
                .unwrap_or_else(|failure| panic!("{action}: {}", failure.message));
        }
        let timed = run_action(
            &owner,
            json!({"type":"wait","url":"https://other.test/*","timeoutMs":0}),
            &["https://example.test"],
        )
        .await
        .unwrap_err();
        assert_eq!(timed.message, "Timed out waiting for the page");
        let malformed = run_action(
            &owner,
            json!({"type":"wait","locator":"Go","timeoutMs":0}),
            &["https://example.test"],
        )
        .await
        .unwrap_err();
        assert_eq!(malformed.message, "Locator is malformed");
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

#[tokio::test]
async fn u6_capture_passes_clip_full_page_and_element_bounds() {
    bounded(async {
        let fixture = Fixture::with("normal", page_behavior());
        let owner = Owned::launch(fixture.options()).await.unwrap();
        owner.page().observe().await.unwrap();
        run_action(
            &owner,
            json!({"type":"capture","clip":{"x":1,"y":2,"width":30,"height":40}}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        let clipped = fixture.command("Page.captureScreenshot");
        assert_eq!(
            clipped["params"]["clip"],
            json!({"x":1,"y":2,"width":30,"height":40,"scale":1})
        );
        assert_eq!(clipped["params"]["captureBeyondViewport"], true);
        run_action(
            &owner,
            json!({"type":"capture","fullPage":true}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        owner.page().observe().await.unwrap();
        run_action(
            &owner,
            json!({"type":"capture","ref":"b1"}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        let commands = fixture.commands();
        let captures: Vec<&Value> = commands
            .iter()
            .filter(|command| command["method"] == "Page.captureScreenshot")
            .collect();
        assert_eq!(captures.len(), 3);
        assert_eq!(captures[1]["params"]["captureBeyondViewport"], true);
        assert!(captures[1]["params"].get("clip").is_none());
        assert_eq!(captures[2]["params"]["clip"]["width"], 10);
        assert_eq!(captures[2]["params"]["clip"]["height"], 10);
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

#[tokio::test]
async fn parity_type_preserves_every_utf16_code_unit_through_the_real_cdp_writer() {
    bounded(async {
        let fixture = Fixture::with("normal", page_behavior());
        let owner = Owned::launch(fixture.options()).await.unwrap();
        owner.page().observe().await.unwrap();
        let action = <ycoding_schema::browser::Action as ycoding_schema::DomainDecode>::decode(
            &ycoding_schema::parse_json(r#"{"type":"type","ref":"b4","text":"A\ud800B\udc00C"}"#)
                .unwrap(),
        )
        .unwrap();
        let (_cancel, signal) = tokio::sync::watch::channel(false);
        owner
            .page()
            .act(action, vec!["https://example.test".into()], signal)
            .await
            .unwrap();
        let commands = std::fs::read_to_string(fixture.root.join("commands.log")).unwrap();
        let insert = commands
            .lines()
            .find(|line| line.contains("Input.insertText"))
            .unwrap();
        let value = ycoding_schema::parse_json(insert).unwrap();
        let path = ycoding_schema::JsonPath::default();
        let params: ycoding_schema::JsonValue = ycoding_schema::ObjectDecoder::new(&value, &path)
            .unwrap()
            .field("params")
            .unwrap();
        let typed: ycoding_schema::LosslessString =
            ycoding_schema::ObjectDecoder::new(&params, &path)
                .unwrap()
                .field("text")
                .unwrap();
        assert_eq!(
            typed.code_units().collect::<Vec<_>>(),
            [65, 0xd800, 66, 0xdc00, 67]
        );
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    })
    .await;
}

#[tokio::test]
async fn parity_observation_preserves_lone_surrogates_and_noninteractive_text() {
    bounded(async {
        let fixture = Fixture::new("normal");
        std::fs::write(fixture.root.join("behavior"), r#"{
            "title":"\ud800","ax":[
                {"role":{"value":"heading"},"name":{"value":"\udc00"},"backendDOMNodeId":10},
                {"role":{"value":"StaticText"},"name":{"value":"Read-only paragraph"},"backendDOMNodeId":11},
                {"role":{"value":"textbox"},"name":{"value":"Password"},"backendDOMNodeId":12}
            ],"dom":{"12":{"nodeName":"INPUT","attributes":["type","password"]}}
        }"#).unwrap();
        let owner = Owned::launch(fixture.options()).await.unwrap();
        let observed = owner.page().observe().await.unwrap();
        assert_eq!(observed.title.code_units().collect::<Vec<_>>(), [0xd800]);
        let encoded = ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(observed.texts.as_ref().unwrap()));
        assert!(encoded.contains("\\udc00"));
        assert!(encoded.contains("Read-only paragraph"));
        assert!(!encoded.contains("Password"));
        assert_eq!(observed.elements.len(), 1);
        assert_eq!(observed.elements[0].sensitive, Some(true));
        assert_eq!(observed.elements[0].value, None);
        owner.shutdown().await.unwrap();
    }).await;
}

#[tokio::test]
async fn parity_added_isolated_actions_drive_cdp_without_a_live_chrome() {
    bounded(async {
        for (action, method, response) in [
            (json!({"type":"back"}), "Page.navigateToHistoryEntry", json!({})),
            (json!({"type":"forward"}), "Page.navigateToHistoryEntry", json!({})),
            (json!({"type":"reload"}), "Page.reload", json!({})),
            (json!({"type":"key","key":"Enter","modifiers":["Control"]}), "Input.dispatchKeyEvent", json!({})),
            (json!({"type":"export"}), "Page.captureSnapshot", json!({"data":"Synthetic MHTML"})),
            (json!({"type":"webmcp_list"}), "Runtime.evaluate", json!({"result":{"value":{"supported":true,"tools":[{"name":"fixture.echo"}]}}})),
            (json!({"type":"webmcp_invoke","name":"fixture.echo","arguments":{"text":"hello"}}),
                "Runtime.evaluate", json!({"result":{"value":{"supported":true,"tools":[{"name":"fixture.echo"}],"result":{"text":"hello"}}}})),
        ] {
            let mut behavior = page_behavior();
            behavior["responses"] = json!({
                "Runtime.enable":{}, "DOM.resolveNode":{"object":{"objectId":"node-1"}},
                "Page.getNavigationHistory":{"currentIndex":1,"entries":[
                    {"id":1,"url":"https://example.test/previous"},
                    {"id":2,"url":"https://example.test/"},
                    {"id":3,"url":"https://example.test/next"}]}
            });
            behavior["responses"][method] = response;
            let fixture = Fixture::with("normal", behavior);
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            let result = run_action(&owner, action.clone(), &["https://example.test"]).await.unwrap();
            assert!(result.rejected.is_none(), "{action}");
            assert!(fixture.methods().iter().any(|sent| sent == method), "{action}");
            if action["type"] == "key" {
                let pressed = fixture.command("Input.dispatchKeyEvent");
                assert_eq!(pressed["params"]["key"], "Enter");
                assert_eq!(pressed["params"]["modifiers"], 2);
            }
            if action["type"] == "export" {
                assert_eq!(result.data.as_ref().map(text), Some("Synthetic MHTML"));
            }
            if action["type"] == "webmcp_list" {
                assert_eq!(result.webmcp_tools.as_ref().unwrap().len(), 1);
            }
            if action["type"] == "webmcp_invoke" {
                assert_eq!(result.text.as_ref().map(text), Some("{\"text\":\"hello\"}"));
            }
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        }
    }).await;
}

#[tokio::test]
async fn parity_wait_uses_fresh_semantics_and_cancellation_without_mutating_input() {
    bounded(async {
        let fixture = Fixture::with("normal", page_behavior());
        let owner = Owned::launch(fixture.options()).await.unwrap();
        owner.page().observe().await.unwrap();
        let result = run_action(
            &owner,
            json!({"type":"wait","ref":"b1","timeoutMs":0}),
            &["https://example.test"],
        )
        .await
        .unwrap();
        assert!(result.rejected.is_none());
        assert!(
            !fixture
                .methods()
                .iter()
                .any(|method| method.starts_with("Input."))
        );
        let (_cancel, signal) = tokio::sync::watch::channel(true);
        let action = decode(json!({"type":"wait","timeoutMs":30000}));
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            owner
                .page()
                .act(action, vec!["https://example.test".into()], signal),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        assert!(
            !fixture
                .methods()
                .iter()
                .any(|method| method.starts_with("Input."))
        );
        owner.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn parity_isolated_mode_rejects_external_os_and_profile_only_actions_before_effect_dispatch()
{
    bounded(async {
        for action in [
            json!({"type":"clipboard_read"}),
            json!({"type":"clipboard_write","text":"fixture"}),
            json!({"type":"upload","ref":"b1","paths":["/synthetic/file.txt"]}),
            json!({"type":"download","timeoutMs":0}),
            json!({"type":"group","tabIDs":["btab_parity"],"title":"Fixture"}),
            json!({"type":"ungroup","tabIDs":["btab_parity"],"groupID":0}),
        ] {
            let fixture = Fixture::with("normal", page_behavior());
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            let before = fixture.commands().len();
            let failure = run_action(&owner, action.clone(), &["https://example.test"])
                .await
                .unwrap_err();
            assert_eq!(
                failure.phase,
                super::super::isolated::Phase::Predispatch,
                "{action}"
            );
            assert!(
                fixture.commands()[before..]
                    .iter()
                    .all(|command| command["method"] == "Browser.setPermission"),
                "{action}"
            );
            owner.shutdown().await.unwrap();
        }
    })
    .await;
}

#[tokio::test]
async fn parity_console_events_are_bounded_and_preserve_their_frame_page() {
    bounded(async {
        let mut behavior = page_behavior();
        behavior["responses"] = json!({"Runtime.enable":{}});
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        emit(&owner, json!([
            {"method":"Runtime.executionContextCreated","sessionId":"session-main",
                "params":{"context":{"id":10,"origin":"https://example.test",
                    "auxData":{"frameId":"frame-main","isDefault":true}}}},
            {"method":"Runtime.consoleAPICalled","sessionId":"session-main",
                "params":{"type":"log","executionContextId":10,"args":[{"type":"string","value":"first"}]}},
            {"method":"Runtime.consoleAPICalled","sessionId":"session-main",
                "params":{"type":"error","executionContextId":10,"args":[{"type":"string","value":"second"}]}}
        ])).await;
        let output = run_action(&owner, json!({"type":"logs","limit":1}), &["https://example.test"]).await.unwrap();
        let logs = output.logs.unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(text(&logs[0].text), "second");
        assert_eq!(logs[0].level, decode(json!("error")));
        owner.shutdown().await.unwrap();
    }).await;
}

#[tokio::test]
async fn parity_frame_authority_does_not_grant_top_document_navigation() {
    bounded(async {
        use super::super::{admission::Admission, chrome_executor::IsolatedChrome, isolated};
        use std::sync::Arc;
        let session = ycoding_schema::session_id::SessionId::new("ses_frame_authority").unwrap();
        for scenario in ["scripted-hop", "frame", "navigate"] {
            let mut behavior = page_behavior();
            behavior["responses"] = json!({"Page.getFrameTree":{"frameTree":{
                "frame":{"id":"frame-main","url":"https://example.test/"},
                "childFrames":[{"frame":{"id":"frame-child","url":"https://child.test/form"}}]
            }}});
            if scenario == "scripted-hop" {
                behavior["on_click"] = json!([{"method":"Fetch.requestPaused","sessionId":"session-main","params":{
                    "requestId":"scripted-child-hop","request":{"url":"https://child.test/top"},
                    "resourceType":"Document","frameId":"frame-main"
                }}]);
            }
            let fixture = Fixture::with("normal", behavior);
            let service = isolated::Service::new(Arc::new(IsolatedChrome::with(fixture.options())),
                Arc::new(Admission::default()), Arc::new(|_| true), isolated::Options::default());
            let started = service.start(&session, decode(json!({"url":"https://example.test/"}))).await.unwrap();
            let tab = started.tab.as_ref().unwrap();
            let instance = started.instance_id.as_ref().unwrap();
            let observe = |call:&str| ycoding_schema::isolated_browser::ObserveInput {
                session_id:session.clone(),instance_id:instance.clone(),tab_id:tab.id.clone(),
                generation:tab.generation,call_id:decode(json!(call)),diff:None,
            };
            let first = service.observe(observe("first")).await.unwrap();
            assert!(first.frames.as_ref().unwrap().iter().any(|frame| text(&frame.page.origin)=="https://child.test" && frame.observed));
            let second = service.observe(observe("second")).await.unwrap();
            let child = second.elements.iter().find(|element| element.frame.as_ref().is_some_and(|frame| text(&frame.origin)=="https://child.test")).unwrap();
            let main = second.elements.iter().find(|element| element.frame.is_none()).unwrap();
            let action = if scenario == "navigate" { json!({"type":"navigate","url":"https://child.test/form"}) }
                else if scenario == "scripted-hop" {json!({"type":"click","ref":text(&main.r#ref)})}
                else {json!({"type":"click","ref":text(&child.r#ref)})};
            let result = service.action(ycoding_schema::isolated_browser::ActionInput {
                session_id:session.clone(),instance_id:instance.clone(),tab_id:tab.id.clone(),generation:tab.generation,
                document_generation:second.document_generation,observation_revision:second.revision,
                call_id:decode(json!("frame-authority")),action:decode(action),
            }).await.unwrap();
            let commands = fixture.commands();
            service.shutdown().await.unwrap();
            fixture.assert_cleanup();
            let permissions = commands.iter().filter(|command| command["method"]=="Browser.setPermission").collect::<Vec<_>>();
            assert!(permissions.iter().all(|command| command["params"]["setting"]=="denied"));
            if scenario != "scripted-hop" {
                for name in ["clipboard-read","clipboard-write"] {
                    assert!(permissions.iter().any(|command| command["params"]["permission"]["name"]==name
                        && command["params"]["origin"]=="https://child.test"), "{scenario}: {name}");
                }
            }
            if scenario == "scripted-hop" {
                assert!(commands.iter().any(|command| command["method"]=="Fetch.failRequest"
                    && command["params"]["requestId"]=="scripted-child-hop"));
                assert!(!commands.iter().any(|command| command["method"]=="Fetch.continueRequest"
                    && command["params"]["requestId"]=="scripted-child-hop"));
                assert_eq!(result.status, ycoding_schema::isolated_browser::ActionStatus::Uncertain);
            } else {
                assert_eq!(result.status, ycoding_schema::isolated_browser::ActionStatus::Completed, "{scenario}");
                if scenario == "navigate" {
                    assert_eq!(text(&result.tab.page.origin), "https://child.test");
                    assert!(commands.iter().any(|command| command["method"]=="Page.navigate"
                        && command["params"]["url"]=="https://child.test/form"));
                } else {
                    assert!(commands.iter().any(|command| command["method"]=="Input.dispatchMouseEvent"));
                }
            }
        }
    }).await;
}

#[tokio::test]
async fn parity_oopif_discovery_observation_and_actions_keep_session_local_semantic_refs() {
    bounded(async {
        let mut behavior = page_behavior();
        behavior["responses"] = json!({"Runtime.enable":{},
            "DOM.getFrameOwner":{"backendNodeId":90}});
        behavior["responsesBySession"] = json!({"session-child":{
            "Page.getFrameTree":{"frameTree":{"frame":{"id":"frame-child","url":"https://child.test/form?record=private#fragment"}}},
            "Accessibility.getFullAXTree":{"nodes":[
                {"role":{"value":"button"},"name":{"value":"Child button"},"backendDOMNodeId":10},
                {"role":{"value":"heading"},"name":{"value":"Child heading"},"backendDOMNodeId":11}]},
            "DOM.describeNode":{"node":{"nodeName":"BUTTON","attributes":[]}},
            "Page.getLayoutMetrics":{"layoutViewport":{"clientWidth":10,"clientHeight":10}}
        }});
        let fixture = Fixture::with("normal", behavior);
        let owner = Owned::launch(fixture.options()).await.unwrap();
        emit(&owner, json!([{"method":"Target.attachedToTarget","sessionId":"session-main",
            "params":{"sessionId":"session-child","waitingForDebugger":true,"targetInfo":{
                "type":"iframe","targetId":"target-child","url":"https://child.test/form?record=private#fragment"}}}])).await;
        eventually(|| fixture.commands().iter().any(|command|
            command["method"] == "Runtime.runIfWaitingForDebugger" && command["sessionId"] == "session-child")).await;
        let first = owner.page().observe().await.unwrap();
        assert!(first.frames.as_ref().unwrap().iter().any(|frame|
            text(&frame.page.origin) == "https://child.test" && !frame.observed));
        assert!(!first.elements.iter().any(|element| text(&element.name) == "Child button"));
        let second = owner.page().observe().await.unwrap();
        let child = second.elements.iter().find(|element| text(&element.name) == "Child button").unwrap();
        assert_eq!(text(&child.frame.as_ref().unwrap().origin), "https://child.test");
        assert_eq!(text(&child.frame.as_ref().unwrap().path), "/form");
        let main = second.elements.iter().find(|element| text(&element.name) == "Go").unwrap();
        assert_ne!(main.r#ref, child.r#ref);
        assert!(second.texts.as_ref().unwrap().iter().any(|item|
            text(&item.name) == "Child heading" && item.frame.is_some()));
        let generation = second.document_generation;
        let output = run_action(&owner, json!({"type":"click","ref":text(&child.r#ref)}),
            &["https://example.test", "https://child.test"]).await.unwrap();
        assert!(output.rejected.is_none());
        let commands = fixture.commands();
        assert!(commands.iter().any(|command| command["method"] == "DOM.describeNode"
            && command["sessionId"] == "session-child" && command["params"]["backendNodeId"] == 10));
        assert!(commands.iter().any(|command| command["method"] == "Input.dispatchMouseEvent"
            && command["sessionId"] == "session-main"));
        let current = owner.page().observe().await.unwrap();
        let stale = current.elements.iter().find(|element| text(&element.name) == "Child button").unwrap().r#ref.clone();
        emit(&owner, json!([{"method":"Page.frameNavigated","sessionId":"session-child",
            "params":{"frame":{"id":"frame-child","url":"https://child.test/changed?record=other"}}}])).await;
        eventually(|| !owner.page().document().refs.contains_key(text(&stale))).await;
        let failure = run_action(&owner, json!({"type":"click","ref":text(&stale)}),
            &["https://example.test", "https://child.test"]).await.unwrap_err();
        assert_eq!(failure.phase, super::super::isolated::Phase::Predispatch);
        assert_eq!(owner.page().document().generation, u64::try_from(generation.get()).unwrap());
        emit(&owner, json!([{"method":"Target.detachedFromTarget","sessionId":"session-main",
            "params":{"sessionId":"session-child","targetId":"target-child"}}])).await;
        let detached = owner.page().observe().await.unwrap();
        assert!(!detached.elements.iter().any(|element| text(&element.name) == "Child button"));
        owner.shutdown().await.unwrap();
        fixture.assert_cleanup();
    }).await;
}
