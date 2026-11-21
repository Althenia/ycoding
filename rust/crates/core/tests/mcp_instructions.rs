use ycoding_core::resources::mcp::{backgroundable, instructions, namespace, tool_name};
use ycoding_schema::{DomainDecode, LosslessString, parse_json, permission};

fn rule(action: &str) -> permission::Rule {
    permission::Rule::decode(
        &parse_json(&format!(
            r#"{{"action":"{action}","resource":"*","effect":"deny"}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn mcp_guidance_requires_execute_and_an_allowed_server_tool() {
    use ycoding_core::resources::config::{Entry, capabilities::ConfigCapabilities};
    let servers = [instructions::Summary {
        server: "docs".into(),
        instructions: "Guide".into(),
    }];
    let tools = [
        ("docs".into(), "lookup".into()),
        ("docs".into(), "secret".into()),
    ];
    for (config, rules, visible) in [
        (r#"{}"#, vec![], true),
        (r#"{"tools":{"allow":["docs_lookup"]}}"#, vec![], true),
        (r#"{"tools":{"deny":["docs_secret"]}}"#, vec![], true),
        (r#"{"tools":{"deny":["execute"]}}"#, vec![], false),
        (r#"{"tools":{"enabled":false}}"#, vec![], false),
        (r#"{"tools":{"allow":[]}}"#, vec![], false),
        (r#"{"tools":{"deny":["docs_*"]}}"#, vec![], false),
        (
            r#"{"tools":{"allow":["docs_lookup"]}}"#,
            vec![rule("docs_lookup")],
            false,
        ),
        (r#"{}"#, vec![rule("execute")], false),
    ] {
        let policy = ConfigCapabilities::resolve(&[Entry::Document {
            path: None,
            info: parse_json(&format!(r#"{{"capabilities":{config}}}"#)).unwrap(),
        }]);
        let actual = instructions::summaries_with_capabilities_by(
            &servers,
            &tools,
            Some(&rules),
            &policy,
            |a, b| a.cmp(b),
        );
        assert_eq!(actual.len(), usize::from(visible), "{config}");
    }
}

#[test]
fn instructions_only_include_servers_with_an_accessible_tool() {
    let servers = [
        instructions::Summary {
            server: "beta".into(),
            instructions: "Beta instructions".into(),
        },
        instructions::Summary {
            server: "alpha".into(),
            instructions: "Alpha line one\nAlpha line two".into(),
        },
        instructions::Summary {
            server: "hidden".into(),
            instructions: "Denied".into(),
        },
        instructions::Summary {
            server: "unused".into(),
            instructions: "No tools".into(),
        },
    ];
    let tools = [
        ("alpha".into(), "search".into()),
        ("alpha".into(), "restricted".into()),
        ("beta".into(), "search".into()),
        ("hidden".into(), "search".into()),
    ];
    let visible = instructions::summaries_by(
        &servers,
        &tools,
        Some(&[rule("alpha_restricted"), rule("hidden_search")]),
        |a, b| a.cmp(b),
    );
    assert_eq!(
        instructions::render(&visible).to_utf8().unwrap(),
        "<mcp_instructions>\n  <server name=\"alpha\">\n    Use tools from this server through `execute` under `tools[\"alpha\"]`.\n    Alpha line one\n    Alpha line two\n  </server>\n  <server name=\"beta\">\n    Use tools from this server through `execute` under `tools[\"beta\"]`.\n    Beta instructions\n  </server>\n</mcp_instructions>"
    );
    assert!(
        instructions::summaries_by(&servers, &tools, Some(&[rule("execute")]), |a, b| a.cmp(b))
            .is_empty()
    );
    assert!(instructions::summaries_by(&servers, &tools, None, |a, b| a.cmp(b)).is_empty());
}

#[test]
fn normalization_is_utf8_bounded_without_splitting_characters_or_losing_surrogates() {
    assert_eq!(
        instructions::normalize(&"Alpha   \r\nSecond\t \r\n\u{feff}".into()),
        "Alpha\nSecond".into()
    );
    let normalized =
        instructions::normalize(&format!("{}\r\ntail text   \r\n", "é".repeat(1400)).into())
            .to_utf8()
            .unwrap();
    assert!(normalized.len() <= 2048);
    assert!(normalized.ends_with("\n[truncated to 2048 UTF-8 bytes]"));
    assert!(!normalized.contains("tail text"));
    let invalid = LosslessString::from_utf16(vec![0xd800, 32]);
    assert_eq!(
        instructions::normalize(&invalid),
        LosslessString::from_utf16(vec![0xd800])
    );
}

#[test]
fn updates_render_additions_removals_and_full_replacement() {
    let a = instructions::Summary {
        server: "alpha".into(),
        instructions: "Alpha instructions".into(),
    };
    let b = instructions::Summary {
        server: "beta".into(),
        instructions: "Beta instructions".into(),
    };
    let both = [a.clone(), b.clone()];
    assert!(instructions::changed(std::slice::from_ref(&a),&both).to_utf8().unwrap().starts_with("New MCP server instructions are available in addition to those previously listed:\n  <server name=\"beta\">"));
    assert_eq!(
        instructions::changed(&both, std::slice::from_ref(&b)),
        "Instructions for the following MCP servers are no longer available: alpha.".into()
    );
    let revised = [
        instructions::Summary {
            server: "alpha".into(),
            instructions: "Updated alpha".into(),
        },
        b,
    ];
    assert!(instructions::changed(&both,&revised).to_utf8().unwrap().starts_with("The available MCP server instructions have changed. This list supersedes the previous one.\n<mcp_instructions>"));
    assert_eq!(
        instructions::REMOVED,
        "MCP server instructions are no longer available."
    );
}

#[test]
fn naming_and_background_detection_match_utf16_and_segment_rules() {
    assert_eq!(namespace(&"context 7".into()), "context_7".into());
    assert_eq!(
        tool_name(&"context 7".into(), &"resolve.library/id".into()),
        "context_7_resolve_library_id".into()
    );
    assert_eq!(namespace(&"💡".into()), "__".into());
    for name in ["ctx_shell", "execute_code", "EXEC", "a-run-b", "spawn"] {
        assert!(backgroundable(name), "{name}");
    }
    for name in [
        "get_console_message",
        "shellfish",
        "execution",
        "rerun",
        "run.foo",
    ] {
        assert!(!backgroundable(name), "{name}");
    }
}
