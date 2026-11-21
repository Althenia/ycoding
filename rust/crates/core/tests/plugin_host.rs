include!("tool_fixture.rs");
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use ycoding_core::event_feed::{Data, Feed, Payload, Scope, Subscriber};
use ycoding_core::extension::{
    Activation, Configuration, Error, Extension, Host, Launch, Options, PluginRuntime, Resources,
    ToolGrant, capabilities, plugin, v5,
};
use ycoding_core::resources::{agent, catalog, command, config, reference, skill};
use ycoding_schema::DomainDecode;

const HOST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/cli/src/plugin-host/main.ts"
);
const WATCHDOG: Duration = Duration::from_secs(60);

fn load(root: &Path, content: &str) -> config::Configuration {
    config::Configuration::load(config::LoadOptions {
        directory: root.to_path_buf(),
        roots: config::Roots::development(root).unwrap(),
        project: false,
        file: None,
        content: Some(content.into()),
        env: Default::default(),
    })
    .unwrap()
}

fn runtime(root: &Path) -> PluginRuntime {
    let bun = String::from_utf8(
        std::process::Command::new("sh")
            .args(["-c", "command -v bun"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    assert!(!bun.is_empty(), "the plugin host integration requires bun");
    let executable = root.join("frontend");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\necho launch >> '{}'\nexec '{bun}' '{HOST}' \"$@\"\n",
            root.join("launches").display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    PluginRuntime {
        executable,
        args: vec!["plugin-host".into()],
        cache: root.join("cache/ycoding/plugins"),
        setup: Duration::from_secs(30),
    }
}

fn isolated_runtime(root: &Path) -> PluginRuntime {
    let bun = String::from_utf8(
        std::process::Command::new("sh")
            .args(["-c", "command -v bun"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    assert!(!bun.is_empty(), "the plugin host integration requires bun");
    for directory in [
        "home",
        "tmp",
        "xdg/config",
        "xdg/cache",
        "xdg/data",
        "xdg/state",
    ] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    std::fs::write(root.join("empty.npmrc"), "").unwrap();
    let executable = root.join("frontend-isolated");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\necho launch >> '{launches}'\nexec /usr/bin/env -i PATH=/usr/bin:/bin HOME='{home}' TMPDIR='{tmp}' XDG_CONFIG_HOME='{config}' XDG_CACHE_HOME='{cache}' XDG_DATA_HOME='{data}' XDG_STATE_HOME='{state}' npm_config_userconfig='{npmrc}' npm_config_globalconfig='{npmrc}' '{bun}' '{HOST}' \"$@\"\n",
            launches = root.join("launches").display(),
            home = root.join("home").display(),
            tmp = root.join("tmp").display(),
            config = root.join("xdg/config").display(),
            cache = root.join("xdg/cache").display(),
            data = root.join("xdg/data").display(),
            state = root.join("xdg/state").display(),
            npmrc = root.join("empty.npmrc").display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    PluginRuntime {
        executable,
        args: vec!["plugin-host".into()],
        cache: root.join("cache/ycoding/plugins"),
        setup: Duration::from_secs(30),
    }
}

fn options() -> Options {
    Options {
        startup: Duration::from_secs(5),
        execution: Duration::from_secs(20),
        cleanup: Duration::from_secs(2),
        shutdown: Duration::from_secs(2),
        write: Duration::from_secs(5),
    }
}

fn decoded(value: &ycoding_schema::JsonValue) -> Value {
    serde_json::from_str(&ycoding_schema::stringify_json(value)).unwrap()
}

fn main_file_url_paths(fixture: &ToolFixture, targets: &[&str]) -> Value {
    let executable = std::process::Command::new("/bin/sh")
        .args(["-c", "command -v bun"])
        .output()
        .unwrap();
    assert!(executable.status.success());
    let executable = String::from_utf8(executable.stdout).unwrap();
    std::fs::write(fixture.root.join("package.json"), "{}").unwrap();
    let output = std::process::Command::new(executable.trim())
        .args([
            "--eval",
            r#"const { fileURLToPath } = require("node:url");
const targets = JSON.parse(process.argv.at(-1));
console.log(JSON.stringify(targets.map(target => {
  try { return { target, path: fileURLToPath(target) } }
  catch { return { target, error: true } }
})));"#,
            &serde_json::to_string(targets).unwrap(),
        ])
        .current_dir(&fixture.root)
        .env_clear()
        .env("HOME", &fixture.root)
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let reference: Value = serde_json::from_slice(&output.stdout).unwrap();
    println!("Main fileURLToPath API under Bun: {reference}");
    reference
}

#[test]
fn configured_file_urls_preserve_main_path_semantics() {
    let fixture = ToolFixture::new();
    let reference = main_file_url_paths(
        &fixture,
        &[
            "file:///fixture/probe.mjs",
            "file://localhost/fixture/probe.mjs",
            "file:///fixture/space%20name-%E2%9C%93-%23-%3F.mjs",
            "file:///fixture/probe.mjs?cache=one#part",
            "file:///fixture/literal%252F.mjs",
            "file:///fixture/encoded%2Fsegment.mjs",
            "file:///fixture/encoded%2fsegment.mjs",
            "file:///fixture/backslash%5Cname.mjs",
            "file:///fixture/bad%.mjs",
            "file:///fixture/bad%2.mjs",
            "file:///fixture/bad%GG.mjs",
        ],
    );
    for entry in reference.as_array().unwrap() {
        let target = entry["target"].as_str().unwrap();
        for declaration in [
            json!(target),
            json!({"package": target, "options": {"label": "fixture"}}),
        ] {
            let expected_options = declaration.get("options").cloned().unwrap_or(json!({}));
            let configuration = load(
                &fixture.root,
                &json!({"plugins": [declaration]}).to_string(),
            );
            let operations = plugin::operations(&configuration, &fixture.root);
            assert_eq!(operations.len(), 1, "{target}");
            let Some(expected) = entry["path"].as_str() else {
                assert!(
                    !matches!(&operations[0], plugin::Operation::Add { .. }),
                    "Main rejects {target}, which must not reach import/npm dispatch"
                );
                continue;
            };
            let plugin::Operation::Add {
                target: actual,
                options,
            } = &operations[0]
            else {
                panic!("Main accepts {target}")
            };
            assert_eq!(actual, expected, "{target}");
            assert_eq!(decoded(options), expected_options, "{target}");
            assert!(Path::new(actual).is_absolute(), "{target}");
        }
    }
    let configuration = load(
        &fixture.root,
        r#"{"plugins":["./local.mjs","fixture-plugin@1.0.0","-fixture.*"]}"#,
    );
    assert_eq!(
        plugin::operations(&configuration, &fixture.root),
        [
            plugin::Operation::Add {
                target: fixture.root.join("local.mjs").to_str().unwrap().to_owned(),
                options: ycoding_schema::parse_json("{}").unwrap(),
            },
            plugin::Operation::Add {
                target: "fixture-plugin@1.0.0".into(),
                options: ycoding_schema::parse_json("{}").unwrap(),
            },
            plugin::Operation::Remove("fixture.*".into()),
        ]
    );
    fixture.cleanup();
}

#[tokio::test]
async fn invalid_configured_file_urls_are_diagnostic_and_never_launch() {
    let fixture = ToolFixture::new();
    let registry = Arc::new(fixture.registry());
    let activation = Activation::new(
        fixture.root.clone(),
        options(),
        registry.clone(),
        fixture.policy.clone(),
        Launch::default(),
        Host::default(),
    );
    let reference = main_file_url_paths(
        &fixture,
        &[
            "file://other-host/fixture/probe.mjs",
            "file://127.0.0.1/fixture/probe.mjs",
            "file://localhost:80/fixture/probe.mjs",
            "file://user@localhost/fixture/probe.mjs",
            "file:///fixture/bad%.mjs",
            "file:///fixture/bad%2.mjs",
            "file:///fixture/bad%GG.mjs",
            "file:///fixture/bad%FF.mjs",
            "file:///fixture/bad%C3%28.mjs",
            "file:///fixture/encoded%2Fsegment.mjs",
        ],
    );
    let rejected = reference
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["error"] == true || entry["path"] == "")
        .collect::<Vec<_>>();
    assert!(
        !rejected.is_empty(),
        "the reference must include rejected URLs"
    );
    for entry in rejected {
        let target = entry["target"].as_str().unwrap();
        let configuration = load(&fixture.root, &json!({"plugins": [target]}).to_string());
        activation.reload(&configuration).await.unwrap();
        let failures = activation.failures().await;
        assert_eq!(
            failures.len(),
            1,
            "invalid declaration must not disappear: {target}"
        );
        assert_eq!(failures[0].1, Error::InvalidConfiguration, "{target}");
        assert_eq!(failures[0].0, "plugin.file-url");
        assert!(activation.extensions().await.is_empty());
        assert!(registry.available(&[]).is_empty());
    }
    activation.close().await;
    fixture.cleanup();
}

#[test]
fn plugin_operations_keep_source_order_options_selectors_and_discovery() {
    let fixture = ToolFixture::new();
    let discovered = fixture.root.join("config/ycoding/plugins");
    std::fs::create_dir_all(&discovered).unwrap();
    std::fs::write(discovered.join("b.ts"), "export default {}").unwrap();
    std::fs::write(discovered.join("a.js"), "export default {}").unwrap();
    std::fs::write(discovered.join("ignored.md"), "").unwrap();
    let configuration = load(
        &fixture.root,
        r#"{"plugins":["./local.ts","file:///fixture/url.mjs","@fixture/npm@1.0.0",{"package":"/fixture/abs.ts","options":{"label":"fixture"}},"-./removed.ts","-fixture.*",{"package":"-literal"},"ycoding.*","-"]}"#,
    );
    let add = |target: &str, options: Value| ("add", target.to_owned(), options);
    let remove = |selector: &str| ("remove", selector.to_owned(), Value::Null);
    assert_eq!(
        plugin::operations(&configuration, &fixture.root)
            .into_iter()
            .map(|operation| match operation {
                plugin::Operation::Add { target, options } => ("add", target, decoded(&options)),
                plugin::Operation::Remove(selector) => ("remove", selector, Value::Null),
                plugin::Operation::InvalidFileUrl { .. } => panic!("fixture URLs are valid"),
            })
            .collect::<Vec<_>>(),
        [
            add(discovered.join("a.js").to_str().unwrap(), json!({})),
            add(discovered.join("b.ts").to_str().unwrap(), json!({})),
            add(fixture.root.join("local.ts").to_str().unwrap(), json!({})),
            add("/fixture/url.mjs", json!({})),
            add("@fixture/npm@1.0.0", json!({})),
            add("/fixture/abs.ts", json!({"label": "fixture"})),
            remove("./removed.ts"),
            remove("fixture.*"),
            add("-literal", json!({})),
            add("ycoding.*", json!({})),
        ]
    );
    let runtime = PluginRuntime {
        executable: "/fixture/frontend".into(),
        args: vec!["plugin-host".into()],
        cache: fixture.root.join("cache"),
        setup: Duration::from_secs(30),
    };
    let launched = plugin::launch(
        "/fixture/abs.ts".into(),
        ycoding_schema::parse_json(r#"{"label":"fixture"}"#).unwrap(),
        fixture.root.clone(),
        &runtime,
    );
    assert_eq!(launched.target(), "/fixture/abs.ts");
    assert_eq!(decoded(launched.options()), json!({"label": "fixture"}));
    assert!(launched.identity().starts_with("plugin.abs.ts."));
    assert_eq!(launched.identity(), plugin::identity("/fixture/abs.ts"));
    assert_ne!(launched.identity(), plugin::identity("/other/abs.ts"));
    assert_eq!(
        launched.configuration().executable,
        PathBuf::from("/fixture/frontend")
    );
    assert_eq!(launched.configuration().args, ["plugin-host"]);
    assert!(
        launched.configuration().grants.is_empty() && launched.configuration().families.is_empty()
    );
    assert!(Configuration::reject_obsolete(&configuration).is_ok());
    for obsolete in [r#"{"plugin":["x"]}"#, r#"{"npm":{"x":"1"}}"#] {
        assert_eq!(
            Configuration::reject_obsolete(&load(&fixture.root, obsolete)),
            Err(Error::ObsoleteConfiguration)
        );
    }
    fixture.cleanup();
}

fn authored(root: &Path, source: &str) -> String {
    let path = root.join("authored-plugin.mjs");
    std::fs::write(&path, source).unwrap();
    path.to_str().unwrap().to_owned()
}

const ECHO: &str = r#"
export default {
  id: "fixture",
  setup: async (ctx) => {
    let session
    try {
      session = await ctx.session.get({ sessionID: "ses_missing" })
    } catch (error) {
      session = error.message
    }
    await ctx.tool.transform((draft) => {
      draft.add({
        name: "fixture_echo",
        description: "Echo authored input",
        options: { codemode: false },
        jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        execute: async (input) => {
          if (input.text === "fail") throw new Error("fixture failure")
          return { structured: { text: input.text, options: ctx.options, session }, content: [{ type: "text", text: input.text }] }
        },
      })
    })
  },
}
"#;

async fn start(
    fixture: &ToolFixture,
    registry: &ycoding_core::tools::registry::Registry,
    source: &str,
) -> Extension {
    let launched = plugin::launch(
        authored(&fixture.root, source),
        ycoding_schema::parse_json(r#"{"label":"fixture"}"#).unwrap(),
        fixture.root.clone(),
        &runtime(&fixture.root),
    );
    tokio::time::timeout(
        WATCHDOG,
        Extension::start_plugin(
            launched,
            options(),
            registry,
            fixture.policy.clone(),
            &Launch::default(),
            Host::default(),
        ),
    )
    .await
    .unwrap()
    .unwrap()
    .expect("an unrestricted plugin is admitted")
}

fn structured(settlement: &ycoding_core::tools::materialization::Settlement) -> Value {
    serde_json::from_str(&ycoding_schema::stringify_json(
        &settlement.output.as_ref().unwrap().structured,
    ))
    .unwrap()
}

#[tokio::test]
async fn trusted_plugin_tools_run_through_the_real_host_with_session_gates_and_out_of_call_sdk() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, &registry, ECHO).await;
    let input = ycoding_schema::parse_json(r#"{"text":"hello"}"#).unwrap();
    let settled = tokio::time::timeout(
        WATCHDOG,
        registry
            .materialize(&[])
            .invoke("fixture_echo", input, fixture.context()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(settled.error.is_none(), "{:?}", settled.error);
    let value = structured(&settled);
    assert_eq!(value["text"], "hello");
    assert_eq!(value["options"], json!({"label": "fixture"}));
    assert!(
        value["session"].as_str().unwrap().contains("rejected"),
        "{value}"
    );

    let failed = registry
        .materialize(&[])
        .invoke(
            "fixture_echo",
            ycoding_schema::parse_json(r#"{"text":"fail"}"#).unwrap(),
            ycoding_core::tools::context::Context::new("ses_tool", "test", "msg_tool", "call_two")
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        failed
            .error
            .as_ref()
            .unwrap()
            .message
            .as_str()
            .unwrap()
            .contains("fixture failure"),
        "{:?}",
        failed.error
    );

    fixture.deny("fixture_echo", "*");
    let denied = registry
        .materialize(&[])
        .invoke(
            "fixture_echo",
            ycoding_schema::parse_json(r#"{"text":"denied"}"#).unwrap(),
            ycoding_core::tools::context::Context::new(
                "ses_tool",
                "test",
                "msg_tool",
                "call_three",
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        denied.error.is_some(),
        "Session permission rules still gate plugin tools"
    );

    let pid = extension.pid();
    extension.shutdown().await;
    tokio::time::timeout(WATCHDOG, extension.closed())
        .await
        .unwrap();
    assert!(!ycoding_core::platform::process::is_alive(pid).unwrap());
    assert!(
        registry
            .materialize(&[])
            .definitions
            .iter()
            .all(|tool| tool.name.as_str() != Some("fixture_echo"))
    );
    fixture.cleanup();
}

#[tokio::test]
async fn real_arborist_installs_a_local_package_plugin_through_the_real_host() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let package = fixture.root.join("fixture-package");
    std::fs::create_dir_all(&package).unwrap();
    let marker = fixture.root.join("postinstall-ran");
    std::fs::write(
        package.join("package.json"),
        json!({
            "name": "fixture-installed",
            "version": "1.0.0",
            "type": "module",
            "exports": { ".": "./root.mjs", "./server": "./server.mjs" },
            "scripts": { "postinstall": format!("touch '{}'", marker.display()) }
        })
        .to_string(),
    )
    .unwrap();
    for (file, id, entry) in [
        ("server.mjs", "fixture.installed", "server"),
        ("root.mjs", "fixture.installed.root", "root"),
    ] {
        std::fs::write(
            package.join(file),
            format!(
                r#"
export default {{
  id: {id:?},
  setup: async (ctx) => {{
    await ctx.tool.transform((draft) => {{
      draft.add({{
        name: "installed_echo",
        description: "Echo the installed entry",
        options: {{ codemode: false }},
        jsonSchema: {{ type: "object", properties: {{ text: {{ type: "string" }} }}, required: ["text"], additionalProperties: false }},
        execute: async (input) => ({{ structured: {{ text: input.text, entry: {entry:?}, options: ctx.options }}, content: [{{ type: "text", text: input.text }}] }}),
      }})
    }})
  }},
}}
"#
            ),
        )
        .unwrap();
    }
    let launched = plugin::launch(
        format!("file:{}", package.display()),
        ycoding_schema::parse_json(r#"{"label":"fixture"}"#).unwrap(),
        fixture.root.clone(),
        &isolated_runtime(&fixture.root),
    );
    let extension = tokio::time::timeout(
        WATCHDOG,
        Extension::start_plugin(
            launched,
            options(),
            &registry,
            fixture.policy.clone(),
            &Launch::default(),
            Host::default(),
        ),
    )
    .await
    .unwrap()
    .unwrap()
    .expect("an unrestricted plugin is admitted");
    let declared = extension.declared_id().cloned();
    let invoked = tokio::time::timeout(
        WATCHDOG,
        registry.materialize(&[]).invoke(
            "installed_echo",
            ycoding_schema::parse_json(r#"{"text":"installed"}"#).unwrap(),
            fixture.context(),
        ),
    )
    .await;
    let pid = extension.pid();
    extension.shutdown().await;
    tokio::time::timeout(WATCHDOG, extension.closed())
        .await
        .unwrap();

    let settled = invoked.unwrap().unwrap();
    assert!(settled.error.is_none(), "{:?}", settled.error);
    let value = structured(&settled);
    assert_eq!(value["text"], "installed");
    assert_eq!(value["entry"], "server");
    assert_eq!(value["options"], json!({"label": "fixture"}));
    assert_eq!(
        declared.as_ref().and_then(|id| id.as_str()),
        Some("fixture.installed")
    );
    let manifests = std::fs::read_dir(fixture.root.join("cache/ycoding/plugins/packages"))
        .unwrap()
        .map(|entry| {
            entry
                .unwrap()
                .path()
                .join("node_modules/fixture-installed/package.json")
        })
        .filter(|path| path.exists())
        .collect::<Vec<_>>();
    assert_eq!(manifests.len(), 1, "{manifests:?}");
    let installed: Value =
        serde_json::from_str(&std::fs::read_to_string(&manifests[0]).unwrap()).unwrap();
    assert_eq!(installed["name"], "fixture-installed");
    assert!(!marker.exists(), "postinstall must not run");
    assert!(!ycoding_core::platform::process::is_alive(pid).unwrap());
    fixture.cleanup();
}

const DOMAINS: &str = r#"
export default {
  id: "fixture",
  setup: async (ctx) => {
    await ctx.agent.transform((draft) => {
      draft.update("custom", (agent) => {
        agent.description = "plugin"
      })
    })
    await ctx.command.transform((draft) => {
      draft.update("probe", (command) => {
        command.template = "Run probe"
      })
    })
  },
}
"#;

#[tokio::test]
async fn trusted_plugin_domain_transforms_apply_without_a_caller() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, &registry, DOMAINS).await;
    let base = Resources {
        agents: agent::Service::new(vec![agent::empty("custom".into())]),
        commands: command::Service::default(),
        references: reference::Service::from_infos(vec![]),
        skills: skill::Service::new(&fixture.root.join("cache")),
        catalog: catalog::Catalog::default(),
    };
    let projected = tokio::time::timeout(WATCHDOG, base.materialize(&[&extension], None))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        projected
            .agents
            .get(&"custom".into())
            .unwrap()
            .description
            .as_ref()
            .unwrap()
            .as_str(),
        Some("plugin")
    );
    assert_eq!(
        projected
            .commands
            .list()
            .iter()
            .map(|command| command.name.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["probe"]
    );
    extension.shutdown().await;
    fixture.cleanup();
}

#[tokio::test]
async fn unsupported_hooks_fail_plugin_startup_visibly() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let launched = plugin::launch(
        authored(
            &fixture.root,
            r#"export default { id: "fixture", setup: async (ctx) => { await ctx.aisdk.hook("unknown", () => {}) } }"#,
        ),
        ycoding_schema::JsonValue::Object(Default::default()),
        fixture.root.clone(),
        &runtime(&fixture.root),
    );
    let started = tokio::time::timeout(
        WATCHDOG,
        Extension::start_plugin(
            launched,
            options(),
            &registry,
            fixture.policy.clone(),
            &Launch::default(),
            Host::default(),
        ),
    )
    .await
    .unwrap();
    assert!(started.is_err());
    fixture.cleanup();
}

const UNTRUSTED: &str = r#"
import struct, sys
def varint(v):
    out = bytearray()
    while v > 127:
        out.append((v & 127) | 128); v >>= 7
    out.append(v); return bytes(out)
def field(tag, value):
    if isinstance(value, str): value = value.encode()
    return varint((tag << 3) | 2) + varint(len(value)) + value
def number(tag, value): return varint(tag << 3) + varint(value)
def send(payload):
    sys.stdout.buffer.write(struct.pack("<I", len(payload)) + payload); sys.stdout.buffer.flush()
def read():
    size = struct.unpack("<I", sys.stdin.buffer.read(4))[0]
    return sys.stdin.buffer.read(size)
def fields(data):
    offset, out = 0, {}
    def num(o):
        v = s = 0
        while True:
            b = data[o]; o += 1; v |= (b & 127) << s; s += 7
            if b < 128: return v, o
    while offset < len(data):
        key, offset = num(offset)
        if key & 7 == 0: value, offset = num(offset)
        else:
            n, offset = num(offset); value = data[offset:offset + n]; offset += n
        out.setdefault(key >> 3, []).append(value)
    return out
frame = fields(read())
generation = frame[1][0].decode()
hello = fields(frame[2][0])
identity = hello[2][0].decode()
send(field(1, generation) + field(2, number(1, 5) + field(2, identity) + field(3, generation)))
text = field(1, "Echo")
schema = field(6, field(1, field(1, field(1, "type")) + field(2, field(4, field(1, "object")))))
tool = field(1, "demo") + field(2, "echo") + field(3, text) + field(4, schema) + field(5, schema) + number(6, 1) + number(7, 0)
send(field(1, generation) + field(3, field(1, tool)))
send(field(1, generation) + field(16, number(1, 1) + field(2, b"")))
sys.stdin.buffer.read()
"#;

#[tokio::test]
async fn generic_children_cannot_claim_plugin_calls_and_are_closed() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let script = fixture.root.join("untrusted.py");
    std::fs::write(&script, UNTRUSTED).unwrap();
    let extension = Extension::start(
        Configuration {
            identity: "untrusted".into(),
            executable: "/usr/bin/python3".into(),
            args: vec![script.to_str().unwrap().into()],
            directory: fixture.root.clone(),
            grants: vec![ToolGrant {
                namespace: "demo".into(),
                tools: vec!["echo".into()],
                action: "extension.echo".into(),
                resources: vec!["demo".into()],
            }],
            families: vec![],
            registration_order: 0,
        },
        options(),
        &registry,
        fixture.policy.clone(),
        &Launch::default(),
        Host::default(),
    )
    .await
    .unwrap();
    tokio::time::timeout(WATCHDOG, extension.closed())
        .await
        .unwrap();
    assert!(
        extension
            .diagnostics()
            .contains(&v5::DiagnosticCode::ProtocolRejected)
    );
    fixture.cleanup();
}

fn module(root: &Path, file: &str, id: &str, tool: &str) -> String {
    let path = root.join(file);
    std::fs::write(
        &path,
        format!(
            r#"import {{ appendFileSync }} from "node:fs"
appendFileSync({log:?}, `import {id} ${{process.pid}}\n`)
export default {{
  id: {id:?},
  setup: async (ctx) => {{
    appendFileSync({log:?}, `setup {id} ${{JSON.stringify(ctx.options)}}\n`)
    await ctx.tool.transform((draft) => {{
      draft.add({{
        name: {tool:?},
        description: "Report the declared plugin",
        options: {{ codemode: false }},
        jsonSchema: {{ type: "object" }},
        execute: async () => ({{ structured: {{ id: {id:?} }}, content: [] }}),
      }})
    }})
  }},
}}
"#,
            log = root.join("plugins.log"),
        ),
    )
    .unwrap();
    path.to_str().unwrap().to_owned()
}

fn lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn activation(
    fixture: &ToolFixture,
    runtime: Option<PluginRuntime>,
) -> (
    Activation,
    Arc<ycoding_core::tools::registry::Registry>,
    Subscriber,
) {
    let registry = Arc::new(fixture.registry());
    let activation = Activation::new(
        fixture.root.clone(),
        options(),
        registry.clone(),
        fixture.policy.clone(),
        Launch::default(),
        Host::default(),
    );
    let activation = match runtime {
        Some(runtime) => activation.with_plugins(runtime),
        None => activation,
    };
    let feed = Feed::attach(&fixture.authority.store.client());
    let location = ycoding_schema::location::Ref::decode(
        &ycoding_schema::parse_json(&json!({"directory": fixture.root}).to_string()).unwrap(),
    )
    .unwrap();
    activation
        .event_source
        .bind(feed.clone(), Some(location))
        .unwrap();
    let events = feed.subscribe(Scope::Global, None, || {}).unwrap();
    (activation, registry, events)
}

fn added(events: &Subscriber) -> Vec<String> {
    std::iter::from_fn(|| events.next().unwrap())
        .filter_map(|item| match &item.payload {
            Payload::Ephemeral(event) => match &event.data {
                Data::PluginAdded(data) => Some(data.id.as_str().unwrap().to_owned()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

async fn listed(activation: &Activation) -> Vec<String> {
    activation
        .plugin_list()
        .await
        .into_iter()
        .map(|info| info.id.as_str().unwrap().to_owned())
        .collect()
}

fn tools(registry: &ycoding_core::tools::registry::Registry) -> Vec<String> {
    registry
        .materialize(&[])
        .definitions
        .iter()
        .filter_map(|tool| tool.name.as_str().map(str::to_owned))
        .collect()
}

#[tokio::test]
async fn disabled_plugin_capability_starts_no_configured_plugin_and_keeps_built_ins() {
    let fixture = ToolFixture::new();
    let target = module(
        &fixture.root,
        "configured.mjs",
        "fixture.configured",
        "configured_echo",
    );
    std::fs::create_dir_all(fixture.root.join("config/ycoding/plugins")).unwrap();
    module(
        &fixture.root,
        "config/ycoding/plugins/discovered.js",
        "fixture.discovered",
        "discovered_echo",
    );
    let configuration = load(
        &fixture.root,
        &json!({"plugins": [target], "capabilities": {"plugins": {"enabled": false}}}).to_string(),
    );
    let built_ins = capabilities::PRE
        .iter()
        .chain(capabilities::POST)
        .map(|id| (*id).to_owned())
        .collect::<Vec<_>>();
    for runtime in [Some(runtime(&fixture.root)), None] {
        let (activation, registry, events) = activation(&fixture, runtime);
        tokio::time::timeout(WATCHDOG, activation.reload(&configuration))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(activation.list().await, Vec::<String>::new());
        assert_eq!(activation.failures().await, []);
        assert_eq!(listed(&activation).await, built_ins);
        assert_eq!(added(&events), Vec::<String>::new());
        assert!(tools(&registry).iter().all(|name| !name.ends_with("_echo")));
        activation.close().await;
    }
    assert_eq!(lines(&fixture.root.join("launches")), Vec::<String>::new());
    assert_eq!(
        lines(&fixture.root.join("plugins.log")),
        Vec::<String>::new()
    );
    fixture.cleanup();
}

#[tokio::test]
async fn plugin_capability_patterns_match_declared_ids_after_import_and_before_setup() {
    for selection in [
        json!({"deny": ["*.dropped"]}),
        json!({"allow": ["fixture.k*"]}),
    ] {
        let fixture = ToolFixture::new();
        let dropped = module(
            &fixture.root,
            "first.mjs",
            "fixture.dropped",
            "dropped_echo",
        );
        let kept = module(&fixture.root, "second.mjs", "fixture.kept", "kept_echo");
        let configuration = load(
            &fixture.root,
            &json!({"plugins": [dropped, kept], "capabilities": {"plugins": selection}})
                .to_string(),
        );
        let (activation, registry, events) = activation(&fixture, Some(runtime(&fixture.root)));
        tokio::time::timeout(WATCHDOG, activation.reload(&configuration))
            .await
            .unwrap()
            .unwrap();
        let log = lines(&fixture.root.join("plugins.log"));
        let imported = log
            .iter()
            .find_map(|line| line.strip_prefix("import fixture.dropped "))
            .unwrap_or_else(|| panic!("{selection}: the module is imported first: {log:?}"))
            .parse::<u32>()
            .unwrap();
        assert!(
            !log.iter()
                .any(|line| line.starts_with("setup fixture.dropped ")),
            "{selection}: {log:?}"
        );
        assert!(
            log.iter().any(|line| line == "setup fixture.kept {}"),
            "{selection}: {log:?}"
        );
        assert_eq!(
            activation.list().await,
            [plugin::identity(&kept)],
            "{selection}"
        );
        assert_eq!(activation.failures().await, [], "{selection}");
        assert_eq!(added(&events), [plugin::identity(&kept)], "{selection}");
        assert_eq!(
            listed(&activation).await,
            capabilities::PRE
                .iter()
                .map(|id| (*id).to_owned())
                .chain([plugin::identity(&kept)])
                .chain(capabilities::POST.iter().map(|id| (*id).to_owned()))
                .collect::<Vec<_>>(),
            "{selection}"
        );
        let names = tools(&registry);
        assert!(
            names.iter().any(|name| name == "kept_echo")
                && !names.iter().any(|name| name == "dropped_echo"),
            "{selection}: {names:?}"
        );
        let settled = tokio::time::timeout(
            WATCHDOG,
            registry.materialize(&[]).invoke(
                "kept_echo",
                ycoding_schema::parse_json("{}").unwrap(),
                fixture.context(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(settled.error.is_none(), "{selection}: {:?}", settled.error);
        assert_eq!(structured(&settled), json!({"id": "fixture.kept"}));
        assert!(
            !ycoding_core::platform::process::is_alive(imported).unwrap(),
            "{selection}: the excluded host stops"
        );
        activation.close().await;
        fixture.cleanup();
    }
}

#[tokio::test]
async fn plugin_operations_apply_in_order_to_declared_plugin_ids() {
    let cases = [
        (
            "removal by declared id, including a discovered plugin",
            true,
            json!([
                "-other.second",
                "./first.mjs",
                "./second.mjs",
                "-fixture.first",
                "-fixture.auto"
            ]),
            vec!["second.mjs"],
            vec!["setup other.second {}"],
            3,
        ),
        (
            "a later add re-selects a removed id",
            false,
            json!(["./first.mjs", "-fixture.first", "fixture.first"]),
            vec!["first.mjs"],
            vec!["setup fixture.first {}"],
            1,
        ),
        (
            "removal of every id, then a prefix selection",
            false,
            json!(["./first.mjs", "./second.mjs", "-*", "other.*"]),
            vec!["second.mjs"],
            vec!["setup other.second {}"],
            2,
        ),
        (
            "prefix removal",
            false,
            json!(["./first.mjs", "./second.mjs", "./third.mjs", "-fixture.*"]),
            vec!["second.mjs"],
            vec!["setup other.second {}"],
            3,
        ),
        (
            "same-target replacement keeps its position and uses the later options",
            false,
            json!([
                {"package": "./first.mjs", "options": {"label": "one"}},
                "./second.mjs",
                "-fixture.first",
                {"package": "./first.mjs", "options": {"label": "two"}}
            ]),
            vec!["first.mjs", "second.mjs"],
            vec![
                r#"setup fixture.first {"label":"two"}"#,
                "setup other.second {}",
            ],
            3,
        ),
        (
            "an identical repeated add does not re-enable a removed id",
            false,
            json!(["./first.mjs", "-fixture.first", "./first.mjs"]),
            vec![],
            vec![],
            1,
        ),
    ];
    for (name, discovered, plugins, expected, setups, launches) in cases {
        let fixture = ToolFixture::new();
        let tools_by_file = [
            ("first.mjs", "fixture.first", "first_echo"),
            ("second.mjs", "other.second", "second_echo"),
            ("third.mjs", "fixture.third", "third_echo"),
            (
                "config/ycoding/plugins/auto.js",
                "fixture.auto",
                "auto_echo",
            ),
        ];
        std::fs::create_dir_all(fixture.root.join("config/ycoding/plugins")).unwrap();
        for (file, id, tool) in tools_by_file
            .iter()
            .filter(|(file, _, _)| discovered || !file.starts_with("config/"))
        {
            module(&fixture.root, file, id, tool);
        }
        let installed = fixture
            .root
            .join("cache/ycoding/plugins/packages/fixture.first/node_modules/fixture.first");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(
            installed.join("package.json"),
            r#"{"name":"fixture.first","version":"1.0.0","type":"module","exports":{".":"./index.mjs"}}"#,
        )
        .unwrap();
        module(
            &fixture.root,
            "cache/ycoding/plugins/packages/fixture.first/node_modules/fixture.first/index.mjs",
            "fixture.cached",
            "cached_echo",
        );
        let configuration = load(&fixture.root, &json!({ "plugins": plugins }).to_string());
        let (activation, registry, events) = activation(&fixture, Some(runtime(&fixture.root)));
        tokio::time::timeout(WATCHDOG, activation.reload(&configuration))
            .await
            .unwrap()
            .unwrap();
        let identities = expected
            .iter()
            .map(|file| plugin::identity(fixture.root.join(file).to_str().unwrap()))
            .collect::<Vec<_>>();
        let log = lines(&fixture.root.join("plugins.log"));
        assert_eq!(activation.list().await, identities, "{name}: {log:?}");
        assert_eq!(activation.failures().await, [], "{name}");
        assert_eq!(
            log.iter()
                .filter(|line| line.starts_with("setup "))
                .cloned()
                .collect::<Vec<_>>(),
            setups,
            "{name}"
        );
        assert!(
            !log.iter()
                .any(|line| line.starts_with("import fixture.cached ")),
            "{name}: a selecting add never loads a package: {log:?}"
        );
        assert_eq!(added(&events), identities, "{name}");
        let disabled = plugin::disabled_builtins(&configuration, &fixture.root);
        assert_eq!(
            listed(&activation).await,
            capabilities::PRE
                .iter()
                .filter(|id| !disabled.is_disabled(id))
                .map(|id| (*id).to_owned())
                .chain(identities.iter().cloned())
                .chain(
                    capabilities::POST
                        .iter()
                        .filter(|id| !disabled.is_disabled(id))
                        .map(|id| (*id).to_owned()),
                )
                .collect::<Vec<_>>(),
            "{name}"
        );
        let names = tools(&registry);
        for (file, _, tool) in &tools_by_file {
            assert_eq!(
                names.iter().any(|name| name == tool),
                expected.contains(file),
                "{name}: {tool} in {names:?}"
            );
        }
        let imports = log
            .iter()
            .filter_map(|line| line.strip_prefix("import "))
            .filter_map(|line| line.split_once(' '))
            .map(|(id, pid)| (id.to_owned(), pid.parse::<u32>().unwrap()))
            .collect::<Vec<_>>();
        let running = tools_by_file
            .iter()
            .filter(|(file, _, _)| expected.contains(file))
            .filter_map(|(_, id, _)| imports.iter().rev().find(|(imported, _)| imported == id))
            .map(|(_, pid)| *pid)
            .collect::<Vec<_>>();
        for (id, pid) in &imports {
            assert_eq!(
                ycoding_core::platform::process::is_alive(*pid).unwrap(),
                running.contains(pid),
                "{name}: host for {id}"
            );
        }
        assert_eq!(
            lines(&fixture.root.join("launches")).len(),
            launches,
            "{name}"
        );
        activation.close().await;
        fixture.cleanup();
    }
}

#[tokio::test]
async fn a_loaded_plugin_declaring_a_built_in_id_re_enables_that_built_in() {
    for (name, plugins, disabled, active) in [
        (
            "a later declaring add re-enables the removed built-in",
            json!(["-ycoding.tool.read", "./reader.mjs"]),
            vec![],
            true,
        ),
        (
            "a later removal disables the built-in and the declaring plugin",
            json!(["./reader.mjs", "-ycoding.tool.read"]),
            vec!["ycoding.tool.read"],
            false,
        ),
    ] {
        let fixture = ToolFixture::new();
        let target = module(
            &fixture.root,
            "reader.mjs",
            "ycoding.tool.read",
            "reader_echo",
        );
        let configuration = load(&fixture.root, &json!({ "plugins": plugins }).to_string());
        let (activation, registry, _events) = activation(&fixture, Some(runtime(&fixture.root)));
        let _read = registry
            .register(
                vec![("read".into(), built_in_tool())],
                ycoding_core::tools::registry::Options::direct(),
            )
            .unwrap();
        tokio::time::timeout(WATCHDOG, activation.reload(&configuration))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            tools(&registry).iter().any(|tool| tool == "read"),
            active,
            "{name}: the built-in tool follows the settled set"
        );
        assert_eq!(
            activation.disabled_builtins().await,
            disabled
                .iter()
                .map(|id| (*id).to_owned())
                .collect::<std::collections::BTreeSet<_>>(),
            "{name}"
        );
        assert!(activation.builtin_diagnostic().await.is_none(), "{name}");
        let listed = listed(&activation).await;
        assert_eq!(
            listed.iter().any(|id| id == "ycoding.tool.read"),
            active,
            "{name}: {listed:?}"
        );
        assert_eq!(
            listed.contains(&plugin::identity(&target)),
            active,
            "{name}: {listed:?}"
        );
        assert_eq!(
            tools(&registry).iter().any(|tool| tool == "reader_echo"),
            active,
            "{name}"
        );
        activation.close().await;
        fixture.cleanup();
    }
}

fn built_in_tool() -> Arc<dyn ycoding_core::tools::registry::Tool> {
    Arc::new(ycoding_core::tools::registry::DynamicTool::new(
        "Built-in fixture",
        ycoding_schema::JsonValue::Null,
        None,
        None,
        |_, _| {
            Box::pin(async {
                Ok(ycoding_ai::llm::ToolOutput {
                    structured: ycoding_schema::JsonValue::Null,
                    content: vec![],
                })
            })
        },
    ))
}

fn documents(configuration: &config::Configuration) -> Vec<ycoding_schema::JsonValue> {
    configuration
        .entries
        .iter()
        .filter_map(|entry| match entry {
            config::Entry::Document { info, .. } => Some(info.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn declared_built_in_ids_reach_command_skill_prompt_and_variant_consumers() {
    let providers = json!({
        "anthropic": {"models": {"claude-sonnet-4": {}}},
        "configured": {
            "package": "aisdk:@ai-sdk/openai-compatible",
            "models": {"glm-5.2": {}}
        }
    });
    let removals = json!([
        "-ycoding.command",
        "-ycoding.skill",
        "-ycoding.system-prompt.anthropic",
        "-ycoding.variant"
    ]);
    let declarations = json!([
        "./command.mjs",
        "./skill.mjs",
        "./prompt.mjs",
        "./variant.mjs"
    ]);
    let join = |first: &Value, second: &Value| {
        Value::Array(
            first
                .as_array()
                .unwrap()
                .iter()
                .chain(second.as_array().unwrap())
                .cloned()
                .collect(),
        )
    };
    for (name, plugins, built_from, active) in [
        (
            "removals followed by declaring plugins re-enable every consumer",
            join(&removals, &declarations),
            None,
            true,
        ),
        (
            "declaring plugins followed by removals disable every consumer",
            join(&declarations, &removals),
            Some(json!([])),
            false,
        ),
    ] {
        let fixture = ToolFixture::new();
        for (file, id) in [
            ("command.mjs", "ycoding.command"),
            ("skill.mjs", "ycoding.skill"),
            ("prompt.mjs", "ycoding.system-prompt.anthropic"),
            ("variant.mjs", "ycoding.variant"),
        ] {
            module(
                &fixture.root,
                file,
                id,
                &format!("{}_echo", file.trim_end_matches(".mjs")),
            );
        }
        let configuration = load(
            &fixture.root,
            &json!({ "plugins": plugins, "providers": providers }).to_string(),
        );
        let consumers = load(
            &fixture.root,
            &json!({ "plugins": built_from.clone().unwrap_or(plugins.clone()), "providers": providers })
                .to_string(),
        );
        let (activation, _registry, _events) = activation(&fixture, Some(runtime(&fixture.root)));
        tokio::time::timeout(WATCHDOG, activation.reload(&configuration))
            .await
            .unwrap()
            .unwrap();
        let builtins = activation.builtins().await;
        assert_eq!(builtins.disabled.is_empty(), active, "{name}");

        let mut commands = ycoding_core::resources::command::Service::from_project_entries(
            &consumers.entries,
            &fixture.root,
            &mut Vec::new(),
        )
        .unwrap();
        commands.settle_builtins(&builtins, &fixture.root).unwrap();
        assert_eq!(
            commands
                .list()
                .iter()
                .map(|command| command.name.as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            if active {
                vec!["init", "review"]
            } else {
                vec![]
            },
            "{name}"
        );

        let mut skills = ycoding_core::resources::skill::Service::from_entries(
            &consumers.entries,
            &fixture.root,
            &fixture.root,
            &fixture.root.join("cache"),
        )
        .unwrap();
        skills
            .settle_builtins(&builtins, &consumers.entries, &fixture.root)
            .unwrap();
        assert_eq!(
            skills
                .embedded()
                .iter()
                .map(|skill| skill.id.as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
            if active {
                vec![
                    "ycoding",
                    "chatgpt-connectors",
                    "browser-use",
                    "computer-use",
                    "report",
                ]
            } else {
                vec![]
            },
            "{name}"
        );

        let mut catalog = ycoding_core::resources::catalog::Catalog::default();
        catalog.configure(&documents(&consumers)).unwrap();
        catalog.settle_builtins(&builtins).unwrap();
        let glm = catalog
            .providers
            .iter()
            .find(|record| record.provider.id.0.as_str() == Some("configured"))
            .unwrap()
            .models[0]
            .variants
            .iter()
            .map(|variant| variant.id.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            glm,
            if active { vec!["high", "max"] } else { vec![] },
            "{name}"
        );
        let system = ycoding_core::session::generate::system(
            &ycoding_core::resources::agent::empty("build".into()),
            &catalog,
            &ycoding_schema::model::Ref::decode(
                &ycoding_schema::parse_json(r#"{"providerID":"anthropic","id":"claude-sonnet-4"}"#)
                    .unwrap(),
            )
            .unwrap(),
            &[],
            "".into(),
        );
        assert_eq!(
            system[0].text.as_str().unwrap(),
            if active {
                include_str!("../src/session/system_prompt/anthropic.txt")
            } else {
                include_str!("../../../../packages/core/src/session/runner/prompt/base.txt")
            },
            "{name}"
        );
        activation.close().await;
        fixture.cleanup();
    }
}

const EFFECT_ECHO: &str = r#"
import { Plugin } from "@ycoding-ai/plugin/effect"
import { Effect, Schema } from "effect"

export default Plugin.define({
  id: "fixture.effect",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.tool.transform((draft) => {
      draft.add(
        "effect_echo",
        {
          description: "Echo authored Effect input",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({
            text: Schema.String,
            options: Schema.Record(Schema.String, Schema.Unknown),
            sessionID: Schema.String,
            agent: Schema.String,
            messageID: Schema.String,
            callID: Schema.String,
          }),
          execute: (input, context) =>
            input.text === "fail"
              ? Effect.fail(new Error("effect fixture failure"))
              : Effect.succeed({
                  text: input.text,
                  options: ctx.options,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  messageID: context.messageID,
                  callID: context.callID,
                }),
        },
        { codemode: false },
      )
    })
  }),
})
"#;

#[tokio::test]
async fn authored_effect_plugin_tool_executes_through_the_real_host() {
    let fixture = ToolFixture::new();
    let root = fixture.root.clone();
    let registry = fixture.registry();
    let extension = start(&fixture, &registry, EFFECT_ECHO).await;
    let declared = extension.declared_id().cloned();
    let definition = registry
        .materialize(&[])
        .definitions
        .into_iter()
        .find(|tool| tool.name.as_str() == Some("effect_echo"));
    let settled = tokio::time::timeout(
        WATCHDOG,
        registry.materialize(&[]).invoke(
            "effect_echo",
            ycoding_schema::parse_json(r#"{"text":"hello"}"#).unwrap(),
            ycoding_core::tools::context::Context::new(
                "ses_tool",
                "test",
                "msg_tool",
                "call_effect",
            )
            .unwrap(),
        ),
    )
    .await;
    let failed = tokio::time::timeout(
        WATCHDOG,
        registry.materialize(&[]).invoke(
            "effect_echo",
            ycoding_schema::parse_json(r#"{"text":"fail"}"#).unwrap(),
            ycoding_core::tools::context::Context::new(
                "ses_tool",
                "test",
                "msg_tool",
                "call_effect_failure",
            )
            .unwrap(),
        ),
    )
    .await;
    let pid = extension.pid();
    extension.shutdown().await;
    let closed = tokio::time::timeout(WATCHDOG, extension.closed()).await;
    let alive = ycoding_core::platform::process::is_alive(pid);
    let remaining = tools(&registry);
    let retained = closed.is_err() || !matches!(alive, Ok(false));
    if !retained {
        fixture.cleanup();
    }
    let root_exists = root.exists();

    assert!(closed.is_ok(), "the plugin host closes within the watchdog");
    assert!(matches!(alive, Ok(false)), "{alive:?}");
    assert_eq!(root_exists, retained);
    assert!(
        !remaining.iter().any(|name| name == "effect_echo"),
        "{remaining:?}"
    );
    assert_eq!(
        declared.as_ref().and_then(|id| id.as_str()),
        Some("fixture.effect")
    );
    let definition = definition.expect("the Effect tool registers as a direct tool");
    assert_eq!(
        definition.description.as_str(),
        Some("Echo authored Effect input")
    );
    let input_schema = decoded(&definition.input_schema);
    assert_eq!(input_schema["type"], "object");
    assert_eq!(
        input_schema["properties"],
        json!({"text": {"type": "string"}})
    );
    assert_eq!(input_schema["required"], json!(["text"]));
    assert_eq!(input_schema["additionalProperties"], false);
    let output_schema = decoded(
        definition
            .output_schema
            .as_ref()
            .expect("the Effect tool declares an output schema"),
    );
    assert_eq!(
        output_schema["properties"]["text"],
        json!({"type": "string"})
    );
    assert_eq!(
        output_schema["properties"]["callID"],
        json!({"type": "string"})
    );
    let settled = settled.unwrap().unwrap();
    assert!(settled.error.is_none(), "{:?}", settled.error);
    let value = structured(&settled);
    assert_eq!(value["text"], "hello");
    assert_eq!(value["options"], json!({"label": "fixture"}));
    assert_eq!(value["sessionID"], "ses_tool");
    assert_eq!(value["agent"], "test");
    assert_eq!(value["messageID"], "msg_tool");
    assert_eq!(value["callID"], "call_effect");
    let failed = failed.unwrap().unwrap();
    assert!(
        failed
            .error
            .as_ref()
            .unwrap()
            .message
            .as_str()
            .unwrap()
            .contains("effect fixture failure"),
        "{:?}",
        failed.error
    );
}
