use ycoding_core::resources::config::decode_document;
use ycoding_core::resources::config::{
    Entry,
    capabilities::{ConfigCapabilities, InstructionSource},
};
use ycoding_schema::{JsonValue, parse_json, stringify_json};

fn recover(input: &str, expected: &str, paths: &[&str]) {
    let decoded = decode_document(input, "fixture.jsonc");
    assert_eq!(decoded.info, Some(parse_json(expected).unwrap()));
    let mut actual = decoded
        .diagnostics
        .iter()
        .map(|item| item.json_path.as_ref().unwrap().as_str().unwrap())
        .collect::<Vec<_>>();
    actual.sort();
    let mut expected = paths.to_vec();
    expected.sort();
    assert_eq!(actual, expected);
    assert!(
        decoded
            .diagnostics
            .iter()
            .all(|item| item.path.as_str() == Some("fixture.jsonc"))
    );
}

#[test]
fn shell_queue_is_an_unknown_key_without_discarding_other_valid_configuration() {
    recover(
        r#"{"shell":"/bin/sh","shell_memory_limit_mb":64,"shell_queue":{"max_running":1}}"#,
        r#"{"shell":"/bin/sh","shell_memory_limit_mb":64}"#,
        &["$.shell_queue"],
    );
}

#[test]
fn fallback_maps_normalize_selectors_and_allow_empty_chains() {
    recover(
        r#"{"model_fallbacks":{"p/primary":[],"p/team/model":["other/backup", "work#p/team/model#high",{"providerID":"p","model":"team/model","profile":"second"}]}}"#,
        r#"{"model_fallbacks":{"p/primary":[],"p/team/model":[{"providerID":"other","model":"backup"},{"providerID":"p","model":"team/model","variant":"high","profile":"work"},{"providerID":"p","model":"team/model","profile":"second"}]}}"#,
        &[],
    );
}

#[test]
fn fallback_maps_reject_invalid_keys_self_references_and_duplicate_or_long_chains() {
    for map in [
        r#"{"missing-slash":[]}"#,
        r#"{"/model":[]}"#,
        r#"{"p/":[]}"#,
        r#"{"p/model#high":[]}"#,
        r#"{"work#p/model":[]}"#,
        r#"{"p/model":["p/model"]}"#,
        r#"{"p/model":["q/backup",{"providerID":"q","model":"backup"}]}"#,
        r#"{"p/model":["q/one","q/two","q/three","q/four"]}"#,
        r#"{"p/model":["not-a-selector"]}"#,
        r#"{"p/model":false}"#,
    ] {
        recover(
            &format!(r#"{{"shell":"kept","model_fallbacks":{map}}}"#),
            r#"{"shell":"kept"}"#,
            &["$.model_fallbacks"],
        );
    }
}

#[test]
fn capability_schema_accepts_every_selector_and_retired_plugin_selection() {
    let input = r#"{"capabilities":{"instructions":{"global":false,"project":true,"exclude":["*/AGENTS.md",""]},"builtin_instructions":{"enabled":true,"allow":["environment","date","subagent-reuse","shell-memory","project-artifact-authoring","git-worktree","git-attribution","human-input","decision-use","task-completion","memory"],"deny":[]},"skills":{"enabled":false,"allow":[],"deny":["secret-*"]},"tools":{"enabled":true,"allow":["read"],"deny":["shell"]},"mcp":{"allow":["docs"],"deny":["private"]},"plugins":{"enabled":false,"allow":["plugin.*"],"deny":[]},"project_artifacts":false,"home_roots":false,"websearch_provider":"parallel"},"extensions":[]}"#;
    recover(input, input, &[]);
    recover(
        r#"{"capabilities":{"websearch_provider":"exa"}}"#,
        r#"{"capabilities":{"websearch_provider":"exa"}}"#,
        &[],
    );
    let obsolete = decode_document(
        r#"{"capabilities":{"plugins":{"enabled":false}},"plugins":["file:///plugin.ts"]}"#,
        "fixture.jsonc",
    );
    assert!(obsolete.info.is_none());
    assert_eq!(obsolete.diagnostics.len(), 1);
    assert_eq!(obsolete.diagnostics[0].fail_closed, Some(true));
    assert_eq!(
        obsolete.diagnostics[0].json_path.as_ref().unwrap().as_str(),
        Some("$.plugins")
    );
}

#[test]
fn capability_schema_recovers_invalid_leaves_with_precise_diagnostics() {
    recover(
        r#"{"shell":"kept","capabilities":{"instructions":{"global":0,"project":false,"exclude":["kept",42]},"builtin_instructions":{"allow":["date","unknown","*"]},"skills":{"enabled":"off","deny":["kept",null]},"tools":{"allow":false},"mcp":false,"plugins":{"deny":[42]},"project_artifacts":"off","home_roots":0,"websearch_provider":"other","typo":true}}"#,
        r#"{"shell":"kept","capabilities":{"instructions":{"project":false,"exclude":["kept"]},"builtin_instructions":{"allow":["date"]},"skills":{"deny":["kept"]},"tools":{},"plugins":{"deny":[]}}}"#,
        &[
            "$.capabilities.instructions.global",
            "$.capabilities.instructions.exclude[1]",
            "$.capabilities.builtin_instructions.allow[1]",
            "$.capabilities.builtin_instructions.allow[2]",
            "$.capabilities.skills.enabled",
            "$.capabilities.skills.deny[1]",
            "$.capabilities.tools.allow",
            "$.capabilities.mcp",
            "$.capabilities.plugins.deny[0]",
            "$.capabilities.project_artifacts",
            "$.capabilities.home_roots",
            "$.capabilities.websearch_provider",
            "$.capabilities.typo",
        ],
    );
    recover(
        r#"{"capabilities":false,"shell":"kept"}"#,
        r#"{"shell":"kept"}"#,
        &["$.capabilities"],
    );
    for key in ["builtin_instructions", "skills", "tools", "mcp", "plugins"] {
        recover(
            &format!(r#"{{"capabilities":{{"{key}":{{"typo":true,"enabled":false}}}}}}"#),
            &format!(r#"{{"capabilities":{{"{key}":{{"enabled":false}}}}}}"#),
            &[&format!("$.capabilities.{key}.typo")],
        );
    }
}

#[test]
fn capability_selection_deny_empty_allow_and_closed_builtins() {
    for (selection, name, expected) in [
        ("{}", "read", true),
        (r#"{"enabled":true}"#, "read", true),
        (r#"{"enabled":false,"allow":["*"]}"#, "read", false),
        (r#"{"allow":[]}"#, "read", false),
        (r#"{"allow":["read"],"deny":["read"]}"#, "read", false),
        (r#"{"deny":["shell"]}"#, "read", true),
        (r#"{"allow":["mcp_?ocs_*"]}"#, "mcp_docs_lookup", true),
        (r#"{"allow":["mcp_?ocs_*"]}"#, "mcp_docs", false),
        (r#"{"deny":["mcp_*"]}"#, "mcp_docs_lookup", false),
        (r#"{"allow":["read.*"]}"#, "read.file", true),
        (r#"{"allow":["read.*"]}"#, "readXfile", false),
        (r#"{"allow":["dir/*"]}"#, "dir\\file", true),
        (r#"{"allow":["line?*"]}"#, "line\nrest", true),
        (r#"{"allow":["shell *"]}"#, "shell", true),
        (r#"{"allow":["shell *"]}"#, "shell command", true),
        (r#"{"allow":["Read"]}"#, "read", cfg!(windows)),
    ] {
        for key in ["skills", "tools", "mcp", "plugins"] {
            let decoded = decode_document(
                &format!(r#"{{"capabilities":{{"{key}":{selection}}}}}"#),
                "fixture.jsonc",
            );
            assert!(decoded.diagnostics.is_empty());
            let policy = ConfigCapabilities::resolve(&[Entry::Document {
                path: None,
                info: decoded.info.unwrap(),
            }]);
            let selected = match key {
                "skills" => policy.skills,
                "tools" => policy.tools,
                "mcp" => policy.mcp,
                "plugins" => policy.plugins,
                _ => unreachable!(),
            };
            assert_eq!(
                selected.allows(&name.into()),
                expected,
                "{key}/{selection}/{name}"
            );
        }
    }
    for name in [
        "environment",
        "date",
        "subagent-reuse",
        "shell-memory",
        "project-artifact-authoring",
        "git-worktree",
        "git-attribution",
        "human-input",
        "decision-use",
        "task-completion",
        "memory",
    ] {
        let decoded = decode_document(
            &format!(
                r#"{{"capabilities":{{"builtin_instructions":{{"allow":["{name}"],"deny":["date"]}}}}}}"#
            ),
            "fixture.jsonc",
        );
        assert!(decoded.diagnostics.is_empty(), "{name}");
        let policy = ConfigCapabilities::resolve(&[Entry::Document {
            path: None,
            info: decoded.info.unwrap(),
        }]);
        assert_eq!(
            policy.builtin_instructions.allows(&name.into()),
            name != "date"
        );
        assert!(!policy.builtin_instructions.allows(&"unknown".into()));
    }
    let decoded = decode_document(
        r#"{"capabilities":{"skills":{"allow":["\ud800?"]}}}"#,
        "fixture.jsonc",
    );
    assert!(decoded.diagnostics.is_empty());
    let policy = ConfigCapabilities::resolve(&[Entry::Document {
        path: None,
        info: decoded.info.unwrap(),
    }]);
    assert!(
        policy
            .skills
            .allows(&ycoding_schema::LosslessString::from_utf16(vec![
                0xd800, 0x61
            ]))
    );
    assert!(!policy.skills.allows(&"\u{fffd}a".into()));
}

#[test]
fn instruction_selection_preserves_source_switches_and_absolute_path_exclusions() {
    let decoded = decode_document(
        r#"{"capabilities":{"instructions":{"global":false,"exclude":["*/secret?/AGENTS.md"]}}}"#,
        "fixture.jsonc",
    );
    let policy = ConfigCapabilities::resolve(&[Entry::Document {
        path: None,
        info: decoded.info.unwrap(),
    }]);
    assert!(!policy.allows_instruction(&"/global/AGENTS.md".into(), InstructionSource::Global));
    assert!(policy.allows_instruction(&"/project/AGENTS.md".into(), InstructionSource::Project));
    assert!(!policy.allows_instruction(
        &"/project/secret1/AGENTS.md".into(),
        InstructionSource::Project
    ));
    assert!(policy.allows_instruction(
        &"/project/secret/AGENTS.md".into(),
        InstructionSource::Project
    ));
}

#[test]
fn recovers_each_rejected_unit_without_discarding_valid_siblings() {
    for (input, expected, paths) in [
        (
            r#"{"shell":"/bin/zsh","unknown_setting":true}"#,
            r#"{"shell":"/bin/zsh"}"#,
            vec!["$.unknown_setting"],
        ),
        (
            r#"{"mcp":{"servers":{"bad":{"type":"local","command":42},"good":{"type":"local","command":["server"]}}}}"#,
            r#"{"mcp":{"servers":{"good":{"type":"local","command":["server"]}}}}"#,
            vec!["$.mcp.servers.bad"],
        ),
        (
            r#"{"agents":{"god":{"description":"Kept","request":{"headers":{"bad":42,"good":"yes"}}},"helper":{"system":"Kept too"}}}"#,
            r#"{"agents":{"god":{"description":"Kept","request":{"headers":{"good":"yes"}}},"helper":{"system":"Kept too"}}}"#,
            vec!["$.agents.god.request.headers.bad"],
        ),
        (
            r#"{"providers":{"bad":{"package":42},"good":{"name":"native"}},"commands":{"bad":{"description":"No template"},"good":{"template":"Run"}},"references":{"bad":{"path":42},"good":"/tmp"}}"#,
            r#"{"providers":{"good":{"name":"native"}},"commands":{"good":{"template":"Run"}},"references":{"good":"/tmp"}}"#,
            vec!["$.providers.bad", "$.commands.bad", "$.references.bad"],
        ),
        (
            r#"{"snapshot":false,"skills":["kept",42,"also-kept"],"shell":"/bin/zsh"}"#,
            r#"{"skills":["kept","also-kept"],"shell":"/bin/zsh"}"#,
            vec!["$.snapshot", "$.skills[1]"],
        ),
        (
            r#"{"mcp":{"servers":{"good":{"type":"local","command":["server"],"old_option":true}}}}"#,
            r#"{"mcp":{"servers":{"good":{"type":"local","command":["server"]}}}}"#,
            vec!["$.mcp.servers.good.old_option"],
        ),
        (
            r#"{"references":{"good":{"path":"/tmp","typo":true}}}"#,
            r#"{"references":{"good":{"path":"/tmp"}}}"#,
            vec!["$.references.good.typo"],
        ),
        (
            r#"{"instructions":[42,"kept",false,"also-kept"]}"#,
            r#"{"instructions":["kept","also-kept"]}"#,
            vec!["$.instructions[0]", "$.instructions[2]"],
        ),
        (
            r#"{"mcp":{"servers":{"bad.server":{"type":"remote","url":42},"good":{"type":"remote","url":"https://example.com/mcp"}}}}"#,
            r#"{"mcp":{"servers":{"good":{"type":"remote","url":"https://example.com/mcp"}}}}"#,
            vec!["$.mcp.servers[\"bad.server\"]"],
        ),
        (
            r#"{"shell":"/bin/zsh","guardrails":{"enabled":false},"permissions":[{"action":"read","resource":"*","effect":"allow"}],"agents":{"god":{"steps":4}}}"#,
            r#"{"shell":"/bin/zsh","guardrails":{"enabled":false},"permissions":[{"action":"read","resource":"*","effect":"allow"}],"agents":{"god":{"steps":4}}}"#,
            vec![],
        ),
    ] {
        recover(input, expected, &paths);
    }
}

#[test]
fn permission_recovery_fails_closed_in_both_scopes() {
    for (rules, action, path) in [
        (
            r#"[{"action":"shell","resource":42,"effect":"allow"},{"action":"*","resource":"*","effect":"allow"}]"#,
            "shell",
            "[0]",
        ),
        (
            r#"[{"action":42,"resource":"*","effect":"deny"},{"action":"*","resource":"*","effect":"allow"}]"#,
            "*",
            "[0]",
        ),
        (r#"{"action":"shell","effect":"deny"}"#, "*", ""),
        (
            r#"[{"action":"shell","resource":"*","effect":"allow","typo":true}]"#,
            "shell",
            "[0]",
        ),
    ] {
        let decoded = decode_document(
            &format!(
                r#"{{"permissions":{rules},"agents":{{"god":{{"description":"Kept","steps":-1,"permissions":{rules}}}}}}}"#
            ),
            "fixture.json",
        );
        let JsonValue::Object(info) = decoded.info.unwrap() else {
            panic!()
        };
        let expected = parse_json(&format!(
            r#"{{"action":"{action}","resource":"*","effect":"deny"}}"#
        ))
        .unwrap();
        let JsonValue::Array(global) = info.get(&"permissions".into()).unwrap() else {
            panic!()
        };
        assert_eq!(global.last(), Some(&expected));
        let JsonValue::Object(agents) = info.get(&"agents".into()).unwrap() else {
            panic!()
        };
        let JsonValue::Object(agent) = agents.get(&"god".into()).unwrap() else {
            panic!()
        };
        let JsonValue::Array(agent_rules) = agent.get(&"permissions".into()).unwrap() else {
            panic!()
        };
        assert_eq!(agent_rules.last(), Some(&expected));
        assert_eq!(
            agent.get(&"description".into()),
            Some(&JsonValue::String("Kept".into()))
        );
        for scope in ["$.permissions", "$.agents.god.permissions"] {
            assert!(decoded.diagnostics.iter().any(
                |item| item.json_path.as_ref().unwrap().as_str() == Some(&format!("{scope}{path}"))
                    && item.fail_closed == Some(true)
                    && item.message.as_str().unwrap().contains("fails closed")
            ));
        }
    }
}

#[test]
fn malformed_guardrails_cannot_disable_reviews() {
    for guardrails in [
        "false",
        r#"{"enabled":false,"max_concurrent_shells":0}"#,
        r#"{"enabled":false,"shell_wait_seconds":0}"#,
        r#"{"enabled":"off"}"#,
        r#"{"enabled":false,"typo":true}"#,
    ] {
        let decoded = decode_document(
            &format!(r#"{{"shell":"/bin/zsh","guardrails":{guardrails}}}"#),
            "fixture.json",
        );
        assert_eq!(
            decoded.info,
            Some(parse_json(r#"{"shell":"/bin/zsh","guardrails":{"enabled":true}}"#).unwrap())
        );
        assert_eq!(decoded.diagnostics.len(), 1);
        assert_eq!(
            decoded.diagnostics[0].json_path.as_ref().unwrap().as_str(),
            Some("$.guardrails")
        );
        assert_eq!(decoded.diagnostics[0].fail_closed, Some(true));
        assert!(
            decoded.diagnostics[0]
                .message
                .as_str()
                .unwrap()
                .contains("fails closed")
        );
    }
}

#[test]
fn metadata_removed_keys_and_invalid_values_have_contract_diagnostics() {
    recover(
        r#"{"permission":{"bash":"deny"},"permissions":[]}"#,
        r#"{"permissions":[]}"#,
        &["$.permission"],
    );
    let decoded = decode_document(r#"{"permission":true,"shell":false}"#, "fixture.json");
    assert_eq!(
        decoded.diagnostics[0].reason.0.as_str(),
        Some("removed-keys")
    );
    assert_eq!(
        decoded.diagnostics[0].message.as_str(),
        Some("Removed or unknown configuration key")
    );
    assert_eq!(
        decoded.diagnostics[1].reason.0.as_str(),
        Some("invalid-values")
    );
    assert_eq!(
        decoded.diagnostics[1].message.as_str(),
        Some("Value does not match the configuration schema")
    );
    recover("null", "{}", &["$"]);
    recover("[]", "{}", &["$"]);
}

#[test]
fn jsonc_accepts_comments_trailing_commas_and_lossless_strings() {
    recover(
        "{ // comment\n \"username\": \"\\ud800\", /* block */ \"skills\": [\"one\",], }",
        r#"{"username":"\ud800","skills":["one"]}"#,
        &[],
    );
    let decoded = decode_document(r#"{"username":"/* not a comment */,}"}"#, "fixture.json");
    assert!(decoded.diagnostics.is_empty());
    assert!(stringify_json(&decoded.info.unwrap()).contains("/* not a comment */,}"));
    for invalid in [
        "{ invalid",
        "{\"shell\":}",
        "{/* unfinished",
        "{\"shell\":\"bad\\q\"}",
        "{} false",
        "[1,,]",
    ] {
        let decoded = decode_document(invalid, "fixture.jsonc");
        assert!(decoded.info.is_none(), "{invalid}");
        assert_eq!(decoded.diagnostics.len(), 1);
        assert_eq!(
            decoded.diagnostics[0].reason.0.as_str(),
            Some("invalid-json")
        );
        assert!(
            decoded.diagnostics[0]
                .message
                .as_str()
                .unwrap()
                .contains("offset")
        );
        assert!(decoded.diagnostics[0].json_path.is_none());
    }
}

#[test]
fn normalizes_model_selection_and_rejects_reserved_fragments() {
    for (input, expected) in [
        (
            r#""openrouter/openai/gpt-5#high""#,
            r#"{"providerID":"openrouter","model":"openai/gpt-5","variant":"high"}"#,
        ),
        (
            r#""Work#openai/gpt-6.1-sol#high""#,
            r#"{"providerID":"openai","model":"gpt-6.1-sol","variant":"high","profile":"Work"}"#,
        ),
        (
            r#"{"providerID":"anthropic","model":"claude-sonnet","variant":"high"}"#,
            r#"{"providerID":"anthropic","model":"claude-sonnet","variant":"high"}"#,
        ),
    ] {
        recover(
            &format!(r#"{{"model":{input}}}"#),
            &format!(r#"{{"model":{expected}}}"#),
            &[],
        );
    }
    for input in [
        r#""gpt-5""#,
        r#""openai/gpt-5#""#,
        r##""#openai/gpt-5""##,
        r#"{"providerID":"openai","model":"gpt-5#high"}"#,
        r#"{"providerID":"openai","model":"gpt-5","profile":""}"#,
    ] {
        recover(&format!(r#"{{"model":{input}}}"#), "{}", &["$.model"]);
    }
}

#[test]
fn numeric_and_enum_boundaries_match_configuration_schema() {
    for (key, valid, invalid) in [
        (
            "instruction_max_bytes",
            vec!["1", "1048576"],
            vec!["0", "1048577"],
        ),
        (
            "shell_memory_limit_mb",
            vec!["0", "1048576"],
            vec!["-1", "1.5", "1048577"],
        ),
        (
            "shell_sandbox",
            vec![r#""disabled""#, r#""optional""#, r#""required""#],
            vec![r#""pretend""#],
        ),
    ] {
        for value in valid {
            let input = format!(r#"{{"{key}":{value}}}"#);
            recover(&input, &input, &[]);
        }
        for value in invalid {
            recover(
                &format!(r#"{{"{key}":{value}}}"#),
                "{}",
                &[&format!("$.{key}")],
            );
        }
    }
}

#[test]
fn obsolete_executable_configuration_is_rejected_not_partially_loaded() {
    for plugins in [
        r#"["ycoding-helicone-session"]"#,
        r#"[{"package":"@example/audit-plugin","options":{"enabled":true}}]"#,
    ] {
        let decoded = decode_document(
            &format!(r#"{{"shell":"/bin/zsh","plugins":{plugins}}}"#),
            "fixture.json",
        );
        assert!(decoded.info.is_none());
        assert_eq!(decoded.diagnostics.len(), 1);
        assert_eq!(
            decoded.diagnostics[0].json_path.as_ref().unwrap().as_str(),
            Some("$.plugins")
        );
        assert!(
            decoded.diagnostics[0]
                .message
                .as_str()
                .unwrap()
                .contains("executable")
        );
        assert!(
            decoded.diagnostics[0]
                .message
                .as_str()
                .unwrap()
                .contains("Remove")
        );
    }
    let decoded = decode_document(
        r#"{"providers":{"custom":{"package":"@example/provider","models":{"x":{}}}}}"#,
        "fixture.json",
    );
    assert!(decoded.info.is_none());
    assert_eq!(
        decoded.diagnostics[0].json_path.as_ref().unwrap().as_str(),
        Some("$.providers.custom.package")
    );
    let decoded = decode_document(
        r#"{"providers":{"custom":{"models":{"x":{"package":"file:provider.ts"}}}}}"#,
        "fixture.json",
    );
    assert!(decoded.info.is_none());
    assert_eq!(
        decoded.diagnostics[0].json_path.as_ref().unwrap().as_str(),
        Some("$.providers.custom.models.x.package")
    );
}

#[test]
fn accepts_all_supported_configuration_sections_and_preserves_absence() {
    let input = r##"{
        "$schema":"example", "shell":"/bin/sh", "shell_sandbox":"required", "shell_memory_limit_mb":0,
        "model":{"providerID":"native","model":"model"}, "default_agent":"reviewer", "autoupdate":"notify",
        "share":"disabled", "enterprise":{"url":"https://example.com"}, "username":"example",
        "permissions":[{"action":"read","resource":"*","effect":"allow"}],
        "agents":{"reviewer":{"model":{"providerID":"native","model":"model"},"request":{"headers":{"x-example":"value"},"body":{"nested":{"values":[1,true,null]}}},"system":"Review","description":"Example","mode":"subagent","hidden":false,"color":"#abcdef","steps":12,"disabled":false}},
        "snapshots":false,"watcher":{"ignore":["build/**"]},
        "formatter":{"custom":{"disabled":false,"command":["formatter"],"environment":{"EXAMPLE":"value"},"extensions":[".foo"]}},
        "lsp":{"off":{"disabled":true},"custom":{"command":["server"],"extensions":[".foo"],"disabled":false,"env":{"EXAMPLE":"value"},"initialization":{"anything":[1,true]}}},
        "attachments":{"image":{"auto_resize":false,"max_width":1200,"max_height":900,"max_base64_bytes":1048576}},
        "tool_output":{"max_lines":1000,"max_bytes":32768},
        "mcp":{"timeout":{"startup":5000,"catalog":60000,"execution":43200000},"servers":{"local":{"type":"local","command":["server"],"cwd":"./server","environment":{"EXAMPLE":"value"},"disabled":false,"codemode":false,"timeout":{"catalog":10000}},"remote":{"type":"remote","url":"https://example.com/mcp","headers":{"x-example":"value"},"oauth":false,"disabled":true,"codemode":false,"timeout":{"startup":15000}}}},
        "compaction":{"keep_recent_messages":20,"reserved_output_tokens":2000,"context_safety_margin_tokens":4096,"timeout_seconds":30,"max_output_tokens":4000,"max_manifest_bytes":65536,"max_internal_passes":8,"advisory":{"consider_percent":70,"strongly_advised_percent":90}},
        "memory":{"enabled":false,"path":"./knowledge","max_concept_bytes":65536,"max_bundle_bytes":8388608,"max_concepts":1000},
        "prediction":{"enabled":true,"memory":false}, "guardrails":{"enabled":false,"max_concurrent_shells":1,"shell_wait_seconds":60,"max_concurrent_subagents":2,"max_pending_reviews":3},
        "skills":["./skills"],"commands":{"review":{"template":"Review","description":"Example","agent":"reviewer","model":{"providerID":"native","model":"model"},"subtask":true}},
        "instructions":["AGENTS.md"],"instruction_max_bytes":51200,"references":{"local":{"path":"../library","description":"Example","hidden":false},"git":{"repository":"https://example.com/example.git","branch":"main","description":"Example","hidden":true},"short":"../context"},
        "providers":{"native":{"name":"Native","env":["EXAMPLE"],"settings":{"value":1},"headers":{"x-example":"value"},"body":{"value":true},"catalog":{"source":"openai-models"},"models":{"custom":{"modelID":"custom","family":"example","name":"Custom","settings":{"value":1},"headers":{"x-example":"value"},"body":{"value":true},"capabilities":{"tools":true,"input":["text"],"output":["text"]},"variants":[{"id":"high","settings":{"value":1},"headers":{},"body":{}}],"cost":{"tier":{"type":"context","size":1000},"input":1,"output":2,"cache":{"read":0.1,"write":0.2}},"disabled":false,"api":"responses","limit":{"context":10000,"input":1000,"output":2000}}}}},
        "provider_usage":{"codex_app_server":{"command":"codex","args":["app-server","--stdio"],"cwd":"./project","timeout_ms":5000}},
        "efficiency":{"title":"local","helper_models":{"title":"session","prediction":"session","prompt":"session","goal":"session","decision":"session","compaction":{"main":"session","subagent":"session"}},"prompt_cache":{"anthropic_ttl":"adaptive","openai_mode":"explicit","openai_extended_retention":true},"openai_responses_continuation":"auto","openai_responses_state":"stateless"},
        "image_analyzer":{"enabled":true,"model":"vision","provider":"native","variant":"high","prompt":"Analyze","template":"Analyze","max_images":4,"max_bytes":10000},
        "experimental":{"subagent_depth":2,"policies":[{"action":"provider.use","resource":"*","effect":"deny"}]}
    }"##;
    recover(input, input, &[]);
    recover("{}", "{}", &[]);
    recover(
        r#"{"formatter":false,"lsp":true,"autoupdate":false}"#,
        r#"{"formatter":false,"lsp":true,"autoupdate":false}"#,
        &[],
    );
}

#[test]
fn rejects_distinct_nested_constraints_without_inventing_defaults() {
    for (input, expected, paths) in [
        (
            r#"{"memory":{"path":" ","max_concepts":0,"enabled":false}}"#,
            r#"{"memory":{"enabled":false}}"#,
            vec!["$.memory.path", "$.memory.max_concepts"],
        ),
        (
            r#"{"provider_usage":{"codex_app_server":{"command":"","timeout_ms":30001}}}"#,
            r#"{"provider_usage":{}}"#,
            vec![
                "$.provider_usage.codex_app_server.command",
                "$.provider_usage.codex_app_server.timeout_ms",
                "$.provider_usage.codex_app_server",
            ],
        ),
        (
            r#"{"agents":{"example":{"description":"Kept","color":"invalid","steps":-1}}}"#,
            r#"{"agents":{"example":{"description":"Kept"}}}"#,
            vec!["$.agents.example.color", "$.agents.example.steps"],
        ),
        (
            r#"{"efficiency":{"prompt_cache":{"anthropic_ttl":"forever"},"helper_models":{"goal":"native/model"}}}"#,
            r#"{"efficiency":{"prompt_cache":{},"helper_models":{"goal":{"providerID":"native","model":"model"}}}}"#,
            vec!["$.efficiency.prompt_cache.anthropic_ttl"],
        ),
        (
            r#"{"experimental":{"self_improvement":{"automatic":true},"subagent_depth":1},"decisions":{},"ntfy":{}}"#,
            r#"{"experimental":{"subagent_depth":1}}"#,
            vec!["$.experimental.self_improvement", "$.decisions", "$.ntfy"],
        ),
        (
            r#"{"compaction":{"advisory":{"consider_percent":80,"strongly_advised_percent":80},"max_manifest_bytes":1}}"#,
            r#"{"compaction":{"max_manifest_bytes":1}}"#,
            vec!["$.compaction.advisory"],
        ),
        (
            r#"{"mcp":{"servers":{"bad":{"type":"remote","url":"https://example.com","oauth":{"callback_port":65536}},"good":{"type":"remote","url":"https://example.com","oauth":false}}}}"#,
            r#"{"mcp":{"servers":{"good":{"type":"remote","url":"https://example.com","oauth":false}}}}"#,
            vec!["$.mcp.servers.bad"],
        ),
    ] {
        recover(input, expected, &paths);
    }
}

#[test]
fn security_diagnostics_precede_general_recovery_in_ts_scope_order() {
    let decoded = decode_document(
        r#"{"permissions":false,"agents":{"first":{"permissions":false},"second":{"permissions":false}},"guardrails":false,"unknown":true}"#,
        "fixture.json",
    );
    assert_eq!(
        decoded
            .diagnostics
            .iter()
            .map(|item| item.json_path.as_ref().unwrap().as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "$.permissions",
            "$.agents.first.permissions",
            "$.agents.second.permissions",
            "$.guardrails",
            "$.unknown"
        ]
    );
}

#[test]
fn lossless_unknown_names_cannot_supply_inherited_configuration() {
    recover(
        r#"{"__proto__":{"shell":"inherited"},"constructor":false,"\ud800":true,"shell":"explicit"}"#,
        r#"{"shell":"explicit"}"#,
        &["$.__proto__", "$.constructor", r#"$["\ud800"]"#],
    );
}

#[test]
fn retention_settings_accept_only_positive_integers_at_their_exact_paths() {
    for (section, key) in [
        ("session_retention", "records_days"),
        ("analytics_retention", "usage_days"),
        ("analytics_retention", "latency_days"),
    ] {
        for valid in ["1", "7", "30", "9007199254740991"] {
            let input = format!(r#"{{"{section}":{{"{key}":{valid}}}}}"#);
            recover(&input, &input, &[]);
        }
        for invalid in ["0", "-1", "1.5", "9007199254740992", r#""7""#, "true"] {
            recover(
                &format!(r#"{{"{section}":{{"{key}":{invalid}}}}}"#),
                &format!(r#"{{"{section}":{{}}}}"#),
                &[&format!("$.{section}.{key}")],
            );
        }
    }
}

#[test]
fn retention_settings_keep_valid_siblings_and_reject_unknown_keys() {
    recover(
        r#"{"session_retention":{"days":3,"records_days":0},"analytics_retention":{"usage_days":5,"latency_days":2.5,"other":1}}"#,
        r#"{"session_retention":{"days":3},"analytics_retention":{"usage_days":5}}"#,
        &[
            "$.session_retention.records_days",
            "$.analytics_retention.latency_days",
            "$.analytics_retention.other",
        ],
    );
    let all = r#"{"session_retention":{"days":3,"records_days":7},"analytics_retention":{"usage_days":30,"latency_days":30}}"#;
    recover(all, all, &[]);
    recover(
        r#"{"analytics_retention":false,"session_retention":[]}"#,
        "{}",
        &["$.analytics_retention", "$.session_retention"],
    );
}

#[test]
fn review_switches_accept_booleans_at_their_exact_paths() {
    for document in [
        r#"{"guardrails":{"enabled":true,"decide_reviews":true,"decide_hard_reviews":false}}"#,
        r#"{"guardrails":{"decide_reviews":false,"decide_hard_reviews":true}}"#,
        r#"{"guardrails":{"decide_hard_reviews":false}}"#,
    ] {
        recover(document, document, &[]);
    }
}

#[test]
fn a_leftover_auto_answer_key_is_removed_like_any_unknown_key() {
    for value in ["true", "false", r#""true""#, "null"] {
        let document = format!(r#"{{"shell":"/bin/zsh","auto_answer":{value}}}"#);
        recover(&document, r#"{"shell":"/bin/zsh"}"#, &["$.auto_answer"]);
        let decoded = decode_document(&document, "fixture.json");
        assert_eq!(decoded.diagnostics.len(), 1, "{value}");
        assert_eq!(
            decoded.diagnostics[0].reason.0.as_str(),
            Some("removed-keys"),
            "{value}"
        );
    }
}

#[test]
fn malformed_review_switches_fail_closed_without_enabling_model_reviews() {
    for guardrails in [
        r#"{"decide_reviews":"yes"}"#,
        r#"{"decide_reviews":1,"enabled":false}"#,
        r#"{"decide_hard_reviews":null}"#,
        r#"{"decide_reviews":true,"decide_hard_review":false}"#,
    ] {
        let decoded = decode_document(
            &format!(r#"{{"shell":"/bin/zsh","guardrails":{guardrails}}}"#),
            "fixture.json",
        );
        assert_eq!(
            decoded.info,
            Some(parse_json(r#"{"shell":"/bin/zsh","guardrails":{"enabled":true}}"#).unwrap()),
            "{guardrails}"
        );
        assert_eq!(decoded.diagnostics.len(), 1, "{guardrails}");
        assert_eq!(
            decoded.diagnostics[0].json_path.as_ref().unwrap().as_str(),
            Some("$.guardrails")
        );
        assert_eq!(decoded.diagnostics[0].fail_closed, Some(true));
    }
}

#[test]
fn question_timeouts_and_family_cache_scope_have_bounded_explicit_configuration() {
    for seconds in [0, 1, 300, 86_400] {
        let input = format!(
            r#"{{"question_timeout_seconds":{seconds},"efficiency":{{"prompt_cache":{{"family_scope":"family-experiment"}}}}}}"#
        );
        recover(&input, &input, &[]);
    }
    recover(
        r#"{"efficiency":{"prompt_cache":{"family_scope":"session"}}}"#,
        r#"{"efficiency":{"prompt_cache":{"family_scope":"session"}}}"#,
        &[],
    );
    recover(
        r#"{"efficiency":{"prompt_cache":{"family_scope":true}}}"#,
        r#"{"efficiency":{"prompt_cache":{}}}"#,
        &["$.efficiency.prompt_cache.family_scope"],
    );
    for seconds in ["-1", "0.5", "86401", "true", "\"300\""] {
        recover(
            &format!(r#"{{"question_timeout_seconds":{seconds},"shell":"kept"}}"#),
            r#"{"shell":"kept"}"#,
            &["$.question_timeout_seconds"],
        );
    }
}
