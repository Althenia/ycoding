#![cfg(unix)]

#[path = "support/production_owner.rs"]
mod production_owner;

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use ycoding_core::{
    resources::{catalog::models_dev, config, credential},
    ycoding_schema::{DomainEncode, JsonValue},
    ycoding_store::{Metadata, Options, Store},
};
use ycoding_runtime::{Core, Production};

#[path = "support/catalog.rs"]
#[allow(dead_code)]
mod catalog_fixture;

const CHILD: &str = "YCODING_PLUGIN_CONTEXT_CHILD";

fn isolated(test: &str) -> bool {
    if std::env::var_os(CHILD).is_some() {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture", "--test-threads", "1"])
        .env(CHILD, "1")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("test result: ok. 1 passed"),
        "isolated {test} ended with {:?}\n{stdout}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

struct Fixture {
    root: PathBuf,
    directory: PathBuf,
    other: PathBuf,
    core: Core,
    store: ycoding_core::ycoding_store::Client,
}

impl Fixture {
    async fn close(self) {
        self.core.shutdown().await.unwrap();
        drop(self.core);
        drop(self.store);
    }
}

async fn start(host: &production_owner::Host, plugin: &str) -> Fixture {
    start_with(host, plugin, &[]).await
}

async fn start_with(
    host: &production_owner::Host,
    plugin: &str,
    environment: &[(&str, &str)],
) -> Fixture {
    start_with_config(host, plugin, environment, "").await
}

async fn start_with_config(
    host: &production_owner::Host,
    plugin: &str,
    environment: &[(&str, &str)],
    config: &str,
) -> Fixture {
    let root = std::env::temp_dir().join(format!(
        "runtime-plugin-context-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let roots = config::Roots::development(&root).unwrap();
    roots.initialize().unwrap();
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
    let frontend = root.join("frontend");
    fs::write(
        &frontend,
        format!(
            "#!/bin/sh\nexec '{bun}' '{}' \"$@\"\n",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/cli/src/plugin-host/main.ts"
            )
        ),
    )
    .unwrap();
    fs::set_permissions(
        &frontend,
        <fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755),
    )
    .unwrap();
    let directory = root.join("project");
    fs::create_dir_all(&directory).unwrap();
    let other = root.join("other");
    fs::create_dir_all(&other).unwrap();
    fs::write(
        other.join("ycoding.jsonc"),
        "{\"agents\":{\"neighbor\":{\"description\":\"other location agent\"}}}\n",
    )
    .unwrap();
    let plugin = plugin.replace(
        "__OTHER__",
        fs::canonicalize(&other).unwrap().to_str().unwrap(),
    );
    fs::write(directory.join("probe.mjs"), plugin).unwrap();
    fs::write(
        directory.join("ycoding.jsonc"),
        format!("{{\"plugins\": [\"./probe.mjs\"]{config}}}\n"),
    )
    .unwrap();
    let store = host.retain(
        Store::initialize(
            root.join("core.redb"),
            Options::core(),
            ycoding_core::ycoding_store::native::catalog(
                ycoding_core::ycoding_store::native::DatabaseKind::Core,
            ),
            Metadata::new([32; 16], 1),
        )
        .unwrap(),
        Some(&root),
    );
    let core = Core::production(
        &host.owner,
        store.clone(),
        Production {
            analytics: roots.data.join("analytics"),
            configuration: config::LoadOptions {
                directory: root.clone(),
                roots: roots.clone(),
                project: true,
                file: None,
                content: None,
                env: [(
                    "YCODING_FRONTEND_EXECUTABLE".to_owned(),
                    frontend.to_str().unwrap().to_owned(),
                )]
                .into_iter()
                .chain(
                    environment
                        .iter()
                        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
                )
                .collect(),
            },
            catalog: models_dev::Options {
                source: "https://example.invalid".into(),
                cache: roots.cache.join("catalog.json"),
                file: None,
                bundled: Some(ycoding_core::ycoding_schema::parse_json("{}").unwrap()),
                fetch: false,
                user_agent: "fixture".into(),
            },
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
            meeting: false,
        },
    )
    .await
    .unwrap();
    let services = core
        .locations
        .location(&directory.to_str().unwrap().into(), None)
        .unwrap();
    let composed = services.production.as_ref().unwrap();
    assert!(
        composed.plugins.iter().any(|plugin| {
            plugin
                .id
                .as_str()
                .is_some_and(|id| id.starts_with("plugin.probe.mjs."))
        }),
        "probe plugin must load: plugins={:?} extension={:?} plugin={:?}",
        composed
            .plugins
            .iter()
            .filter_map(|plugin| plugin.id.as_str().map(str::to_owned))
            .collect::<Vec<_>>(),
        composed.extension_diagnostics,
        composed.plugin_diagnostics
    );
    Fixture {
        root,
        directory,
        other,
        core,
        store,
    }
}

fn eventually(path: &Path) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(content) = fs::read_to_string(path)
            && !content.is_empty()
        {
            return Some(content);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn production_plugin_receives_events_reads_domains_and_reloads() {
    if isolated("production_plugin_receives_events_reads_domains_and_reloads") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(180), async {
        let fixture = start(host,
            r#"
import { existsSync, writeFileSync } from "node:fs"
const here = (name) => new URL(`./${name}`, import.meta.url)
export default {
  id: "context-probe",
  setup: async (context) => {
    if (existsSync(here("first"))) {
      writeFileSync(here("second"), "second")
      return
    }
    const iterator = context.event.subscribe()[Symbol.asyncIterator]()
    void (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        if (next.value.type !== "agent.updated") continue
        writeFileSync(here("event.json"), JSON.stringify(next.value))
        const summary = {
          agents: (await context.agent.list()).data.map((agent) => agent.id),
          agent: (await context.agent.get("god"))?.id,
          missing: String(await context.agent.get("missing-agent")),
          commands: (await context.command.list()).data.map((command) => command.name),
          references: Array.isArray((await context.reference.list()).data),
          skills: (await context.skill.list()).data.map((skill) => skill.id),
          providers: Array.isArray((await context.catalog.provider.list()).data),
          models: Array.isArray((await context.catalog.model.list()).data),
          model: String(await context.catalog.model.get("p1", "m1")),
          fallback: (await context.catalog.model.default()).data,
          plugins: (await context.plugin.list()).data.map((plugin) => plugin.id),
          otherAgents: (await context.agent.list({ location: { directory: "__OTHER__" } })).data.map((agent) => agent.id),
          otherDirectory: (await context.agent.list({ location: { directory: "__OTHER__" } })).location.directory,
          directory: (await context.agent.list()).location.directory,
        }
        writeFileSync(here("reads.json"), JSON.stringify(summary))
        writeFileSync(here("first"), "first")
        await context.agent.reload()
        writeFileSync(here("reloaded-pid"), String(process.pid))
        return
      }
    })()
    writeFileSync(here("ready"), "ready")
  },
}
"#,
        )
        .await;
        assert_eq!(
            eventually(&fixture.directory.join("ready")).as_deref(),
            Some("ready"),
            "plugin setup must finish"
        );
        let location = ycoding_core::ycoding_schema::location::Ref {
            directory: ycoding_core::ycoding_schema::schema::AbsolutePath::new(
                fixture.directory.to_str().unwrap(),
            )
            .unwrap(),
            workspace_id: None,
        };
        fixture
            .core
            .events
            .emit(
                ycoding_core::event_feed::Data::AgentUpdated(Box::new(
                    ycoding_core::ycoding_schema::agent::Empty,
                )),
                Some(location),
            )
            .unwrap();
        let event = eventually(&fixture.directory.join("event.json"))
            .expect("plugin must receive the emitted server event");
        let event = ycoding_core::ycoding_schema::parse_json(&event).unwrap();
        let ycoding_core::ycoding_schema::JsonValue::Object(event) = event else {
            panic!("event envelope is an object")
        };
        assert_eq!(
            event
                .get(&"type".into())
                .and_then(|value| match value {
                    ycoding_core::ycoding_schema::JsonValue::String(text) =>
                        text.as_str().map(str::to_owned),
                    _ => None,
                })
                .as_deref(),
            Some("agent.updated")
        );
        assert!(
            event.get(&"id".into()).is_some()
                && event.get(&"created".into()).is_some()
                && event.get(&"data".into()).is_some()
        );
        let reads = eventually(&fixture.directory.join("reads.json"))
            .expect("plugin must finish its domain reads");
        let reads = ycoding_core::ycoding_schema::parse_json(&reads).unwrap();
        let field = |name: &str| match &reads {
            ycoding_core::ycoding_schema::JsonValue::Object(object) => {
                object.get(&name.into()).cloned()
            }
            _ => None,
        };
        let texts = |name: &str| match field(name) {
            Some(ycoding_core::ycoding_schema::JsonValue::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    ycoding_core::ycoding_schema::JsonValue::String(text) => {
                        text.as_str().map(str::to_owned)
                    }
                    _ => None,
                })
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        assert!(texts("agents").iter().any(|id| id == "god"), "{reads:?}");
        assert_eq!(
            field("agent"),
            Some(ycoding_core::ycoding_schema::JsonValue::String(
                "god".into()
            )),
            "{reads:?}"
        );
        assert_eq!(
            field("missing"),
            Some(ycoding_core::ycoding_schema::JsonValue::String(
                "undefined".into()
            )),
            "{reads:?}"
        );
        assert!(
            texts("commands").iter().any(|name| name == "init"),
            "{reads:?}"
        );
        assert_eq!(
            field("references"),
            Some(ycoding_core::ycoding_schema::JsonValue::Bool(true)),
            "{reads:?}"
        );
        assert!(
            texts("skills").iter().any(|id| id == "ycoding"),
            "{reads:?}"
        );
        assert_eq!(
            field("providers"),
            Some(ycoding_core::ycoding_schema::JsonValue::Bool(true)),
            "{reads:?}"
        );
        assert_eq!(
            field("models"),
            Some(ycoding_core::ycoding_schema::JsonValue::Bool(true)),
            "{reads:?}"
        );
        assert_eq!(
            field("model"),
            Some(ycoding_core::ycoding_schema::JsonValue::String(
                "undefined".into()
            )),
            "{reads:?}"
        );
        assert_eq!(
            field("fallback"),
            Some(ycoding_core::ycoding_schema::JsonValue::Null),
            "{reads:?}"
        );
        assert_eq!(texts("plugins"), ["context-probe"], "{reads:?}");
        assert!(
            texts("otherAgents")
                .iter()
                .any(|id| id == "neighbor"),
            "{reads:?}"
        );
        assert!(
            !texts("agents").iter().any(|id| id == "neighbor"),
            "{reads:?}"
        );
        assert_eq!(
            field("otherDirectory"),
            Some(ycoding_core::ycoding_schema::JsonValue::String(
                fs::canonicalize(&fixture.other)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .into()
            )),
            "{reads:?}"
        );
        assert_eq!(
            field("directory"),
            Some(ycoding_core::ycoding_schema::JsonValue::String(
                fs::canonicalize(&fixture.directory)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .into()
            )),
            "{reads:?}"
        );
        let reloaded = eventually(&fixture.directory.join("reloaded-pid"));
        let restarted = fixture.directory.join("second").exists();
        fixture.close().await;
        assert!(reloaded.is_some(), "agent.reload settles in the existing plugin");
        assert!(!restarted, "agent.reload preserves the plugin setup");
    })
    .await
    .unwrap();
        })
    });
}

#[test]
fn production_applies_configured_plugin_domain_transforms_at_composition() {
    if isolated("production_applies_configured_plugin_domain_transforms_at_composition") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(180), async {
        let fixture = start(host,
            r#"
import { writeFileSync } from "node:fs"
const here = (name) => new URL(`./${name}`, import.meta.url)
export default {
  id: "transform-probe",
  setup: async (context) => {
    await context.tool.transform((draft) => {
      draft.add({
        name: "subagent",
        description: "plugin-subagent",
        options: { codemode: false },
        jsonSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ structured: null, content: [] }),
      })
    })
    await context.agent.transform((draft) => {
      draft.update("god", (agent) => {
        agent.description = "plugin-transformed"
      })
    })
    await context.command.transform((draft) => {
      draft.update("plugin-command", (command) => {
        command.template = "Run plugin command"
      })
    })
    const iterator = context.event.subscribe()[Symbol.asyncIterator]()
    void (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        if (next.value.type !== "agent.updated") continue
        const reads = {
          description: (await context.agent.get("god"))?.description ?? null,
          commands: (await context.command.list()).data.map((command) => command.name),
        }
        writeFileSync(here("reads.json"), JSON.stringify(reads))
        return
      }
    })()
    writeFileSync(here("ready"), "ready")
  },
}
"#,
        )
        .await;
        assert_eq!(
            eventually(&fixture.directory.join("ready")).as_deref(),
            Some("ready"),
            "plugin setup must finish"
        );
        let services = fixture
            .core
            .locations
            .location(&fixture.directory.to_str().unwrap().into(), None)
            .unwrap();
        assert_eq!(
            services
                .agents
                .snapshot()
                .get(&"god".into())
                .and_then(|agent| agent.description.as_ref())
                .and_then(|description| description.as_str()),
            Some("plugin-transformed"),
            "the Location agent list carries the plugin agent transform"
        );
        assert!(
            services
                .production
                .as_ref()
                .unwrap()
                .commands
                .snapshot()
                .get(&"plugin-command".into())
                .is_some(),
            "the Location command list carries the plugin command transform"
        );
        assert!(
            services
                .production
                .as_ref()
                .unwrap()
                .tools
                .materialize(&[])
                .definitions
                .iter()
                .any(|definition| definition.name.as_str() == Some("subagent")
                    && definition.description.as_str() == Some("plugin-subagent")),
            "a plugin registered later than Session tools retains its precedence"
        );
        drop(services);
        fixture
            .core
            .events
            .emit(
                ycoding_core::event_feed::Data::AgentUpdated(Box::new(
                    ycoding_core::ycoding_schema::agent::Empty,
                )),
                Some(ycoding_core::ycoding_schema::location::Ref {
                    directory: ycoding_core::ycoding_schema::schema::AbsolutePath::new(
                        fixture.directory.to_str().unwrap(),
                    )
                    .unwrap(),
                    workspace_id: None,
                }),
            )
            .unwrap();
        let reads = eventually(&fixture.directory.join("reads.json"))
            .expect("plugin must finish its domain reads");
        let reads = ycoding_core::ycoding_schema::parse_json(&reads).unwrap();
        let ycoding_core::ycoding_schema::JsonValue::Object(reads) = reads else {
            panic!("reads are an object")
        };
        assert_eq!(
            reads.get(&"description".into()),
            Some(&ycoding_core::ycoding_schema::JsonValue::String(
                "plugin-transformed".into()
            )),
            "the plugin's own agent.get sees its transform"
        );
        assert!(
            matches!(
                reads.get(&"commands".into()),
                Some(ycoding_core::ycoding_schema::JsonValue::Array(items))
                    if items.contains(&ycoding_core::ycoding_schema::JsonValue::String("plugin-command".into()))
            ),
            "the plugin's own command.list sees its transform: {reads:?}"
        );
        fixture.close().await;
    })
    .await
    .unwrap();
        })
    });
}

#[test]
fn production_rejects_failed_domain_transforms_and_reaps_plugins() {
    if isolated("production_rejects_failed_domain_transforms_and_reaps_plugins") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(180), async {
                let fixture = start(
                    host,
                    r#"export default { id: "valid-probe", setup: async () => {} }"#,
                )
                .await;
                let directory = fixture.root.join("rejected");
                fs::create_dir(&directory).unwrap();
                fs::write(
                    directory.join("ycoding.jsonc"),
                    r#"{"plugins":["./rejected.mjs"]}"#,
                )
                .unwrap();
                fs::write(
                    directory.join("rejected.mjs"),
                    r#"
import { writeFileSync } from "node:fs"
export default {
  id: "rejected-probe",
  setup: async (context) => {
    await context.agent.transform(() => {
      writeFileSync(new URL("./transform-pid", import.meta.url), String(process.pid))
      throw new Error("synthetic transform rejection")
    })
  },
}
"#,
                )
                .unwrap();
                assert!(
                    fixture
                        .core
                        .locations
                        .location(&directory.to_str().unwrap().into(), None)
                        .is_err(),
                    "a failing domain transform must reject Location composition"
                );
                let pid = fs::read_to_string(directory.join("transform-pid"))
                    .expect("the configured transform ran")
                    .parse()
                    .unwrap();
                assert!(
                    !ycoding_core::platform::process::is_alive(pid).unwrap(),
                    "rejected composition must await plugin shutdown"
                );
                assert!(
                    fixture
                        .core
                        .locations
                        .location(&fixture.directory.to_str().unwrap().into(), None)
                        .unwrap()
                        .agents
                        .snapshot()
                        .get(&"god".into())
                        .is_some(),
                    "a rejected Location must leave the existing Location usable"
                );
                fixture.close().await;
            })
            .await
            .unwrap();
        })
    });
}

#[test]
fn production_plugin_reload_awaits_failed_replacement() {
    if isolated("production_plugin_reload_awaits_failed_replacement") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(180), async {
                let fixture = start(
                    host,
                    r#"
import { existsSync, writeFileSync } from "node:fs"
const here = (name) => new URL(`./${name}`, import.meta.url)
export default {
  id: "reload-result-probe",
  setup: async (context) => {
    await context.agent.transform(() => {
      if (existsSync(here("reject-reload"))) throw new Error("synthetic replacement rejection")
    })
    const iterator = context.event.subscribe()[Symbol.asyncIterator]()
    void (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        if (next.value.type !== "agent.updated") continue
        try {
          await context.agent.reload()
          writeFileSync(here("reload-outcome"), "resolved")
        } catch {
          writeFileSync(here("reload-outcome"), "rejected")
        }
        return
      }
    })()
  },
}
"#,
                )
                .await;
                fs::write(fixture.directory.join("reject-reload"), "reject").unwrap();
                fixture
                    .core
                    .events
                    .emit(
                        ycoding_core::event_feed::Data::AgentUpdated(Box::new(
                            ycoding_core::ycoding_schema::agent::Empty,
                        )),
                        Some(ycoding_core::ycoding_schema::location::Ref {
                            directory: ycoding_core::ycoding_schema::schema::AbsolutePath::new(
                                fixture.directory.to_str().unwrap(),
                            )
                            .unwrap(),
                            workspace_id: None,
                        }),
                    )
                    .unwrap();
                assert_eq!(
                    eventually(&fixture.directory.join("reload-outcome")).as_deref(),
                    Some("rejected"),
                    "reload must settle with the replacement failure instead of reporting success"
                );
                assert!(
                    fixture
                        .core
                        .locations
                        .location(&fixture.directory.to_str().unwrap().into(), None)
                        .unwrap()
                        .agents
                        .snapshot()
                        .get(&"god".into())
                        .is_some(),
                    "failed replacement must preserve the previous Location"
                );
                fixture.close().await;
            })
            .await
            .unwrap();
        })
    });
}

#[test]
fn production_effect_plugin_applies_agent_transform_and_runs_finalizer() {
    if isolated("production_effect_plugin_applies_agent_transform_and_runs_finalizer") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(180), async {
                let fixture = start(
                    host,
                    r#"
import { Plugin } from "@ycoding-ai/plugin/effect"
import { Effect } from "effect"
import { appendFileSync, writeFileSync } from "node:fs"
const here = (name) => new URL(`./${name}`, import.meta.url)
export default Plugin.define({
  id: "effect-lifecycle-probe",
  effect: (context) => Effect.gen(function* () {
    yield* context.agent.transform((draft) => {
      draft.update("god", (agent) => {
        agent.description = "effect-plugin-agent"
      })
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      appendFileSync(here("effect-closed"), "closed\n")
    }))
    yield* Effect.sync(() => writeFileSync(here("effect-pid"), String(process.pid)))
  }),
})
"#,
                )
                .await;
                let services = fixture
                    .core
                    .locations
                    .location(&fixture.directory.to_str().unwrap().into(), None)
                    .unwrap();
                assert_eq!(
                    services
                        .agents
                        .snapshot()
                        .get(&"god".into())
                        .and_then(|agent| agent.description.as_ref())
                        .and_then(|description| description.as_str()),
                    Some("effect-plugin-agent"),
                    "the Effect registration remains active after plugin setup completes"
                );
                assert!(
                    !fixture.directory.join("effect-closed").exists(),
                    "setup must retain the plugin Scope until shutdown"
                );
                let pid = fs::read_to_string(fixture.directory.join("effect-pid"))
                    .unwrap()
                    .parse()
                    .unwrap();
                drop(services);
                fixture.core.shutdown().await.unwrap();
                assert_eq!(
                    fs::read_to_string(fixture.directory.join("effect-closed")).unwrap(),
                    "closed\n",
                    "shutdown must await exactly one Effect finalizer"
                );
                assert!(
                    !ycoding_core::platform::process::is_alive(pid).unwrap(),
                    "shutdown must reap the Effect plugin host"
                );
                drop(fixture.core);
                drop(fixture.store);
            })
            .await
            .unwrap();
        })
    });
}

async fn seed_credentials(
    store: &ycoding_core::ycoding_store::Client,
) -> Result<(), credential::Error> {
    let credentials = credential::Service::new(store.clone());
    for (index, (id, label)) in [("cred_a", "Alpha"), ("cred_b", "Beta"), ("cred_c", "Gamma")]
        .into_iter()
        .enumerate()
    {
        let secret = ycoding_core::ycoding_store::resources::Secret::new(
            ycoding_core::ycoding_schema::credential::Value::Key(
                ycoding_core::ycoding_schema::credential::Key {
                    key: format!("synthetic-credential-secret-{label}").into(),
                    metadata: None,
                },
            )
            .encode(),
        )
        .unwrap();
        credentials
            .create(
                id.into(),
                "muse".into(),
                Some(label.into()),
                secret,
                index as i64 + 1,
            )
            .await?;
    }
    credentials.activate("cred_b".into(), 10).await?;
    credentials.shutdown().await
}

fn member<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}

fn path<'a>(value: &'a JsonValue, keys: &[&str]) -> Option<&'a JsonValue> {
    keys.iter().try_fold(value, |value, key| member(value, key))
}

fn text(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(text)) => text.as_str().map(str::to_owned),
        _ => None,
    }
}

fn items(value: Option<&JsonValue>) -> &[JsonValue] {
    match value {
        Some(JsonValue::Array(items)) => items,
        _ => &[],
    }
}

fn describe(connection: Option<&JsonValue>) -> String {
    let Some(connection) = connection else {
        return "absent".into();
    };
    let field = |key: &str| text(member(connection, key)).unwrap_or_default();
    match field("type").as_str() {
        "credential" => format!(
            "credential:{}:{}:{}",
            field("id"),
            field("label"),
            matches!(member(connection, "active"), Some(JsonValue::Bool(true)))
        ),
        "env" => format!("env:{}", field("name")),
        other => format!("unknown:{other}"),
    }
}

#[test]
fn production_plugin_reads_integration_metadata_from_its_own_location() {
    if isolated("production_plugin_reads_integration_metadata_from_its_own_location") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(180), async {
                let fixture = start_with(
                    host,
                    r#"
import { writeFileSync } from "node:fs"
const here = (name) => new URL(`./${name}`, import.meta.url)
export default {
  id: "integration-probe",
  setup: async (context) => {
    const iterator = context.event.subscribe()[Symbol.asyncIterator]()
    void (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        if (next.value.type !== "agent.updated") continue
        try {
          const other = { location: { directory: "__OTHER__" } }
          const summary = {
            list: await context.integration.list(),
            otherList: await context.integration.list(other),
            muse: await context.integration.get({ integrationID: "muse" }),
            otherMuse: await context.integration.get({ integrationID: "muse", ...other }),
            missing: await context.integration.get({ integrationID: "missing-integration" }),
            active: await context.integration.connection.active("muse"),
            envOnly: await context.integration.connection.active("opencode"),
            unset: String(await context.integration.connection.active("xai")),
            unknown: String(await context.integration.connection.active("missing-integration")),
          }
          writeFileSync(here("integration.json"), JSON.stringify(summary))
        } catch (error) {
          writeFileSync(here("integration.json"), JSON.stringify({ error: String(error.message) }))
        }
        return
      }
    })()
    writeFileSync(here("ready"), "ready")
  },
}
"#,
                    &[
                        ("META_API_KEY", "synthetic-meta-env-value"),
                        ("OPENCODE_API_KEY", "synthetic-provider-env-value"),
                    ],
                )
                .await;
                let directory = fs::canonicalize(&fixture.directory)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned();
                let other = fs::canonicalize(&fixture.other)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned();
                let ready = eventually(&fixture.directory.join("ready"));
                let seeded = seed_credentials(&fixture.store).await;
                let emitted = (ready.is_some() && seeded.is_ok()).then(|| {
                    fixture.core.events.emit(
                        ycoding_core::event_feed::Data::AgentUpdated(Box::new(
                            ycoding_core::ycoding_schema::agent::Empty,
                        )),
                        Some(ycoding_core::ycoding_schema::location::Ref {
                            directory: ycoding_core::ycoding_schema::schema::AbsolutePath::new(
                                fixture.directory.to_str().unwrap(),
                            )
                            .unwrap(),
                            workspace_id: None,
                        }),
                    )
                });
                let raw = emitted
                    .as_ref()
                    .filter(|emitted| emitted.is_ok())
                    .and_then(|_| eventually(&fixture.directory.join("integration.json")));
                fixture.close().await;
                assert_eq!(ready.as_deref(), Some("ready"), "plugin setup must finish");
                seeded.unwrap();
                emitted.unwrap().unwrap();
                let raw = raw.expect("plugin must finish its integration reads");
                let reads = ycoding_core::ycoding_schema::parse_json(&raw).unwrap();
                assert_eq!(text(member(&reads, "error")), None, "{raw}");
                for secret in [
                    "synthetic-meta-env-value",
                    "synthetic-provider-env-value",
                    "synthetic-credential-secret",
                ] {
                    assert!(!raw.contains(secret), "{secret} reached the plugin");
                }
                for wrapper in ["list", "otherList", "muse", "otherMuse", "missing"] {
                    assert_eq!(
                        text(path(&reads, &[wrapper, "location", "directory"])).as_deref(),
                        Some(directory.as_str()),
                        "{wrapper} resolves in the plugin's own Location, not {other}"
                    );
                }
                assert_eq!(
                    path(&reads, &["otherList", "data"]),
                    path(&reads, &["list", "data"])
                );
                assert_eq!(
                    path(&reads, &["otherMuse", "data"]),
                    path(&reads, &["muse", "data"])
                );
                let listed = items(path(&reads, &["list", "data"]));
                let names = listed
                    .iter()
                    .filter_map(|item| text(member(item, "name")))
                    .collect::<Vec<_>>();
                assert!(
                    names
                        .windows(2)
                        .all(|pair| pair[0].to_ascii_lowercase() <= pair[1].to_ascii_lowercase()),
                    "{names:?}"
                );
                assert_eq!(
                    listed
                        .iter()
                        .find(|item| text(member(item, "id")).as_deref() == Some("muse")),
                    path(&reads, &["muse", "data"]),
                    "list and get agree on the integration"
                );
                let connections = items(path(&reads, &["muse", "data", "connections"]));
                assert_eq!(
                    connections
                        .iter()
                        .map(|connection| describe(Some(connection)))
                        .collect::<Vec<_>>(),
                    [
                        "credential:cred_b:Beta:true",
                        "credential:cred_c:Gamma:false",
                        "credential:cred_a:Alpha:false",
                        "env:META_API_KEY",
                    ],
                    "{raw}"
                );
                assert_eq!(member(&reads, "active"), connections.first(), "{raw}");
                assert!(
                    items(path(&reads, &["muse", "data", "methods"]))
                        .iter()
                        .any(|method| {
                            text(member(method, "type")).as_deref() == Some("env")
                                && items(member(method, "names"))
                                    == [JsonValue::String("META_API_KEY".into())]
                        }),
                    "{raw}"
                );
                assert_eq!(
                    describe(member(&reads, "envOnly")),
                    "env:OPENCODE_API_KEY",
                    "{raw}"
                );
                assert_eq!(path(&reads, &["missing", "data"]), Some(&JsonValue::Null));
                assert_eq!(
                    member(&reads, "unset"),
                    Some(&JsonValue::String("undefined".into()))
                );
                assert_eq!(
                    member(&reads, "unknown"),
                    Some(&JsonValue::String("undefined".into()))
                );
            })
            .await
            .unwrap();
        })
    });
}
const RELOAD_PROBE: &str = r#"
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
const here = (name) => new URL(`./${name}`, import.meta.url)
const state = () => existsSync(here(".reload-state"))
  ? JSON.parse(readFileSync(here(".reload-state"), "utf8"))
  : { version: "v1" }
const count = (domain) => appendFileSync(here(`.reload-${domain}-count`), "rebuilt\n")
export default {
  id: "domain-reload-probe",
  setup: async (context) => {
    appendFileSync(here(".reload-setups"), `${process.pid}\n`)
    await context.tool.transform((draft) => draft.add({
      name: "reload_probe",
      description: "Retained reload fixture tool",
      jsonSchema: { type: "object" },
      execute: async () => ({ structured: { pid: process.pid }, content: [] }),
    }))
    await context.agent.transform(async (draft) => {
      count("agent")
      const current = state()
      if (current.reject) throw new Error("synthetic domain rebuild rejection")
      if (current.block) {
        writeFileSync(here(".reload-entered"), "entered")
        await new Promise(() => {})
      }
      draft.update("god", (agent) => { agent.description = current.version })
    })
    for (const domain of ["command", "reference", "skill", "catalog"])
      await context[domain].transform(() => count(domain))
    const iterator = context.event.subscribe()[Symbol.asyncIterator]()
    void (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        if (next.value.type !== "agent.updated") continue
        appendFileSync(here(".reload-events"), `${(await context.agent.get("god"))?.description}\n`)
        if (!existsSync(here(".reload-request"))) continue
        const request = JSON.parse(readFileSync(here(".reload-request"), "utf8"))
        unlinkSync(here(".reload-request"))
        void (async () => {
          try {
            await Promise.all(Array.from({ length: request.count }, () => context[request.domain].reload()))
            writeFileSync(here(".reload-outcome"), JSON.stringify({
              status: "resolved", pid: process.pid, settled: request.count,
              description: (await context.agent.get("god"))?.description,
            }))
          } catch {
            writeFileSync(here(".reload-outcome"), JSON.stringify({ status: "rejected", pid: process.pid }))
          }
        })()
      }
    })()
    writeFileSync(here(".reload-ready"), String(process.pid))
  },
}
"#;

fn request_reload(fixture: &Fixture, domain: &str, count: usize) {
    let outcome = fixture.directory.join(".reload-outcome");
    if outcome.exists() {
        fs::remove_file(outcome).unwrap();
    }
    fs::write(
        fixture.directory.join(".reload-request"),
        format!(r#"{{"domain":"{domain}","count":{count}}}"#),
    )
    .unwrap();
    fixture
        .core
        .events
        .emit(
            ycoding_core::event_feed::Data::AgentUpdated(Box::new(
                ycoding_core::ycoding_schema::agent::Empty,
            )),
            Some(ycoding_core::ycoding_schema::location::Ref {
                directory: ycoding_core::ycoding_schema::schema::AbsolutePath::new(
                    fixture.directory.to_str().unwrap(),
                )
                .unwrap(),
                workspace_id: None,
            }),
        )
        .unwrap();
}

fn rebuild_counts(fixture: &Fixture) -> Vec<usize> {
    ["agent", "command", "reference", "skill", "catalog"]
        .iter()
        .map(|domain| {
            fs::read_to_string(fixture.directory.join(format!(".reload-{domain}-count")))
                .unwrap()
                .lines()
                .count()
        })
        .collect()
}

#[test]
fn production_plugin_reload_rebuilds_only_its_domain_and_keeps_the_plugin() {
    if isolated("production_plugin_reload_rebuilds_only_its_domain_and_keeps_the_plugin") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = start(host, RELOAD_PROBE).await;
            let ready = eventually(&fixture.directory.join(".reload-ready"));
            let services = fixture
                .core
                .locations
                .location(&fixture.directory.to_str().unwrap().into(), None)
                .unwrap();
            let composed = services.production.as_ref().unwrap();
            let activation = composed.activation.clone();
            let tools = composed.tools.clone();
            let before = services
                .agents
                .snapshot()
                .get(&"god".into())
                .unwrap()
                .clone();
            let publication_reads = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let updates = fixture
                .core
                .events
                .subscribe(ycoding_core::event_feed::Scope::Global, None, {
                    let agents = services.agents.clone();
                    let publication_reads = publication_reads.clone();
                    move || {
                        let description = agents
                            .snapshot()
                            .get(&"god".into())
                            .and_then(|agent| agent.description.as_ref())
                            .and_then(|text| text.as_str())
                            .map(str::to_owned);
                        publication_reads.lock().unwrap().push(description);
                    }
                })
                .unwrap();
            fs::write(
                fixture.directory.join(".reload-state"),
                r#"{"version":"v2"}"#,
            )
            .unwrap();
            let mut observed = Vec::new();
            for domain in ["agent", "command", "reference", "skill", "catalog"] {
                request_reload(&fixture, domain, 1);
                let outcome = eventually(&fixture.directory.join(".reload-outcome"));
                let counts = rebuild_counts(&fixture);
                observed.push((domain, outcome.clone(), counts));
                if outcome.is_none() {
                    break;
                }
            }
            let current = fixture
                .core
                .locations
                .location(&fixture.directory.to_str().unwrap().into(), None)
                .unwrap();
            let current_composed = current.production.as_ref().unwrap();
            let same_generation = std::sync::Arc::ptr_eq(&activation, &current_composed.activation);
            let same_registry = std::sync::Arc::ptr_eq(&tools, &current_composed.tools);
            let next_agent = current
                .agents
                .snapshot()
                .get(&"god".into())
                .unwrap()
                .clone();
            let helper_agent = composed
                .session_generate
                .agents
                .snapshot()
                .get(&"god".into())
                .unwrap()
                .clone();
            let listed = tools.available(&[]).contains("reload_probe");
            let setups = fs::read_to_string(fixture.directory.join(".reload-setups")).unwrap();
            let delivered = fs::read_to_string(fixture.directory.join(".reload-events")).unwrap();
            let read_after_emission = publication_reads.lock().unwrap().clone();
            let events = std::iter::from_fn(|| updates.next().unwrap())
                .filter_map(|item| match &item.payload {
                    ycoding_core::event_feed::Payload::Ephemeral(event) => {
                        Some(event.data.name().to_owned())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            let pid = ready.as_ref().and_then(|text| text.parse::<u32>().ok());
            drop(current);
            drop(services);
            fixture.close().await;
            assert_eq!(
                before.description.as_ref().and_then(|value| value.as_str()),
                Some("v1")
            );
            assert_eq!(
                next_agent
                    .description
                    .as_ref()
                    .and_then(|value| value.as_str()),
                Some("v2")
            );
            assert_eq!(
                helper_agent
                    .description
                    .as_ref()
                    .and_then(|value| value.as_str()),
                Some("v2")
            );
            assert!(
                same_generation,
                "domain reload preserves the plugin activation"
            );
            assert!(same_registry, "domain reload preserves the tool registry");
            assert!(listed, "the Code Mode plugin tool remains available");
            assert_eq!(setups, format!("{}\n", ready.unwrap()));
            assert_eq!(observed.len(), 5);
            for (index, (domain, outcome, counts)) in observed.into_iter().enumerate() {
                let outcome = ycoding_core::ycoding_schema::parse_json(&outcome.unwrap()).unwrap();
                assert_eq!(
                    text(member(&outcome, "status")).as_deref(),
                    Some("resolved"),
                    "{domain}: {outcome:?}"
                );
                assert_eq!(text(member(&outcome, "description")).as_deref(), Some("v2"));
                assert_eq!(
                    member(&outcome, "pid"),
                    Some(&JsonValue::Number(f64::from(pid.unwrap())))
                );
                assert_eq!(
                    counts,
                    (0..5)
                        .map(|domain| if domain <= index { 2 } else { 1 })
                        .collect::<Vec<_>>()
                );
            }
            assert!(
                delivered.lines().any(|line| line == "v2"),
                "the original subscription receives post-reload events"
            );
            assert!(
                read_after_emission
                    .iter()
                    .any(|value| value.as_deref() == Some("v2")),
                "event notification observes the published snapshot"
            );
            for event in [
                "agent.updated",
                "command.updated",
                "reference.updated",
                "skill.updated",
                "catalog.updated",
            ] {
                assert!(
                    events.iter().any(|name| name == event),
                    "{event}: {events:?}"
                );
            }
            assert!(!ycoding_core::platform::process::is_alive(pid.unwrap()).unwrap());
        })
    });
}

#[test]
fn production_plugin_reloads_inside_debounce_coalesce() {
    if isolated("production_plugin_reloads_inside_debounce_coalesce") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = start(host, RELOAD_PROBE).await;
            let ready = eventually(&fixture.directory.join(".reload-ready"));
            fs::write(
                fixture.directory.join(".reload-state"),
                r#"{"version":"coalesced"}"#,
            )
            .unwrap();
            request_reload(&fixture, "agent", 3);
            let outcome = eventually(&fixture.directory.join(".reload-outcome"));
            let counts = rebuild_counts(&fixture);
            let setups = fs::read_to_string(fixture.directory.join(".reload-setups")).unwrap();
            fixture.close().await;
            let outcome = ycoding_core::ycoding_schema::parse_json(&outcome.unwrap()).unwrap();
            assert_eq!(
                text(member(&outcome, "status")).as_deref(),
                Some("resolved")
            );
            assert_eq!(member(&outcome, "settled"), Some(&JsonValue::Number(3.)));
            assert_eq!(
                text(member(&outcome, "description")).as_deref(),
                Some("coalesced")
            );
            assert_eq!(counts, [2, 1, 1, 1, 1]);
            assert_eq!(setups, format!("{}\n", ready.unwrap()));
        })
    });
}

#[test]
fn production_plugin_failed_domain_reload_preserves_the_snapshot_and_host() {
    if isolated("production_plugin_failed_domain_reload_preserves_the_snapshot_and_host") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = start(host, RELOAD_PROBE).await;
            let ready = eventually(&fixture.directory.join(".reload-ready"));
            let services = fixture
                .core
                .locations
                .location(&fixture.directory.to_str().unwrap().into(), None)
                .unwrap();
            let tools = services.production.as_ref().unwrap().tools.clone();
            let activation = services.production.as_ref().unwrap().activation.clone();
            let updates = fixture
                .core
                .events
                .subscribe(ycoding_core::event_feed::Scope::Global, None, || {})
                .unwrap();
            fs::write(
                fixture.directory.join(".reload-state"),
                r#"{"version":"rejected","reject":true}"#,
            )
            .unwrap();
            request_reload(&fixture, "agent", 3);
            let outcome = eventually(&fixture.directory.join(".reload-outcome"));
            let before_retry = services
                .agents
                .snapshot()
                .get(&"god".into())
                .unwrap()
                .clone();
            let counts = rebuild_counts(&fixture);
            let publications = std::iter::from_fn(|| updates.next().unwrap()).filter(|item| {
        matches!(&item.payload, ycoding_core::event_feed::Payload::Ephemeral(event) if event.data.name() == "agent.updated")
    }).count();
            fs::write(
                fixture.directory.join(".reload-state"),
                r#"{"version":"recovered"}"#,
            )
            .unwrap();
            request_reload(&fixture, "agent", 1);
            let recovered = eventually(&fixture.directory.join(".reload-outcome"));
            let after = fixture
                .core
                .locations
                .location(&fixture.directory.to_str().unwrap().into(), None)
                .unwrap();
            let same_generation =
                std::sync::Arc::ptr_eq(&activation, &after.production.as_ref().unwrap().activation);
            let same_registry =
                std::sync::Arc::ptr_eq(&tools, &after.production.as_ref().unwrap().tools);
            let next = after.agents.snapshot().get(&"god".into()).unwrap().clone();
            let setups = fs::read_to_string(fixture.directory.join(".reload-setups")).unwrap();
            drop(after);
            drop(services);
            fixture.close().await;
            let outcome = ycoding_core::ycoding_schema::parse_json(&outcome.unwrap()).unwrap();
            assert_eq!(
                text(member(&outcome, "status")).as_deref(),
                Some("rejected")
            );
            assert_eq!(
                before_retry
                    .description
                    .as_ref()
                    .and_then(|value| value.as_str()),
                Some("v1")
            );
            assert_eq!(counts, [2, 1, 1, 1, 1]);
            assert_eq!(
                publications, 1,
                "only the externally emitted request event is visible after failure"
            );
            let recovered = ycoding_core::ycoding_schema::parse_json(&recovered.unwrap()).unwrap();
            assert_eq!(
                text(member(&recovered, "status")).as_deref(),
                Some("resolved")
            );
            assert_eq!(
                next.description.as_ref().and_then(|value| value.as_str()),
                Some("recovered")
            );
            assert!(same_generation && same_registry);
            assert_eq!(setups, format!("{}\n", ready.unwrap()));
        })
    });
}

#[test]
fn production_location_close_cancels_an_in_flight_domain_reload() {
    if isolated("production_location_close_cancels_an_in_flight_domain_reload") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = start(host, RELOAD_PROBE).await;
            let ready = eventually(&fixture.directory.join(".reload-ready"));
            fs::write(
                fixture.directory.join(".reload-state"),
                r#"{"version":"blocked","block":true}"#,
            )
            .unwrap();
            request_reload(&fixture, "agent", 1);
            let entered = eventually(&fixture.directory.join(".reload-entered"));
            let updates = fixture
                .core
                .events
                .subscribe(ycoding_core::event_feed::Scope::Global, None, || {})
                .unwrap();
            let closing =
                tokio::time::timeout(Duration::from_secs(10), fixture.core.shutdown()).await;
            let pid = ready.as_ref().and_then(|value| value.parse::<u32>().ok());
            let alive = pid.map(ycoding_core::platform::process::is_alive);
            let late_publications = std::iter::from_fn(|| updates.next().unwrap()).filter(|item| {
        matches!(&item.payload, ycoding_core::event_feed::Payload::Ephemeral(event) if event.data.name() == "agent.updated")
    }).count();
            if matches!(&closing, Ok(Ok(()))) && matches!(&alive, Some(Ok(false))) {
                drop(fixture.core);
                drop(fixture.store);
            }
            assert_eq!(entered.as_deref(), Some("entered"));
            assert!(
                matches!(closing, Ok(Ok(()))),
                "close joins the coordinator without waiting for the materialization deadline"
            );
            assert!(matches!(alive, Some(Ok(false))));
            assert_eq!(late_publications, 0);
        })
    });
}

#[test]
fn plugin_event_forwarding_skips_durable_events_of_other_locations() {
    if isolated("plugin_event_forwarding_skips_durable_events_of_other_locations") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            use ycoding_core::ycoding_store::session::{NewEvent, SessionTable};
            tokio::time::timeout(Duration::from_secs(180), async {
                let fixture = start(
                    host,
                    r#"
import { appendFileSync, writeFileSync } from "node:fs"
const here = (name) => new URL(`./${name}`, import.meta.url)
export default {
  id: "location-probe",
  setup: async (context) => {
    const iterator = context.event.subscribe()[Symbol.asyncIterator]()
    void (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        if (String(next.value.type).startsWith("session.model.selected"))
          appendFileSync(here("seen.log"), `${next.value.data.sessionID}\n`)
        if (next.value.type === "agent.updated") {
          writeFileSync(here("done"), "done")
          return
        }
      }
    })()
    writeFileSync(here("ready"), "ready")
  },
}
"#,
                )
                .await;
                assert_eq!(
                    eventually(&fixture.directory.join("ready")).as_deref(),
                    Some("ready")
                );
                let rows = [
                    ("ses_location_mine", &fixture.directory),
                    ("ses_location_theirs", &fixture.other),
                ]
                .map(|(id, directory)| {
                    let directory = fs::canonicalize(directory)
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_owned();
                    let project = ycoding_core::ycoding_store::project::Project {
                        id: format!("prj_{id}").into(),
                        worktree: directory.as_str().into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    };
                    let mut row = catalog_fixture::record(id);
                    row.project_id = project.id.clone();
                    row.directory = directory.as_str().into();
                    (project, row)
                });
                fixture
                    .store
                    .submit(move |tx| {
                        rows.iter().try_for_each(|(project, row)| {
                            ycoding_core::ycoding_store::project::ProjectTable::insert(
                                tx, project,
                            )?;
                            SessionTable::insert(tx, row)
                        })
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
                let sessions = ycoding_core::session::store::Service::new(fixture.store.clone());
                for (index, id) in ["ses_location_theirs", "ses_location_mine"]
                    .into_iter()
                    .enumerate()
                {
                    sessions
                        .publish(NewEvent {
                            id: format!("evt_location_probe_{index}").into(),
                            aggregate_id: id.into(),
                            created: 2,
                            type_: "session.model.selected.1".into(),
                            data: ycoding_core::ycoding_schema::ObjectEncoder::new()
                                .field("sessionID", id)
                                .field(
                                    "model",
                                    &ycoding_core::ycoding_schema::parse_json(
                                        r#"{"providerID":"fixture","id":"model"}"#,
                                    )
                                    .unwrap(),
                                )
                                .finish(),
                        })
                        .await
                        .unwrap();
                }
                fixture
                    .core
                    .events
                    .emit(
                        ycoding_core::event_feed::Data::AgentUpdated(Box::new(
                            ycoding_core::ycoding_schema::agent::Empty,
                        )),
                        Some(ycoding_core::ycoding_schema::location::Ref {
                            directory: ycoding_core::ycoding_schema::schema::AbsolutePath::new(
                                fixture.directory.to_str().unwrap(),
                            )
                            .unwrap(),
                            workspace_id: None,
                        }),
                    )
                    .unwrap();
                let done = eventually(&fixture.directory.join("done"));
                let seen =
                    fs::read_to_string(fixture.directory.join("seen.log")).unwrap_or_default();
                fixture.close().await;
                assert_eq!(done.as_deref(), Some("done"));
                assert_eq!(seen.lines().collect::<Vec<_>>(), ["ses_location_mine"]);
            })
            .await
            .unwrap();
        })
    });
}

#[test]
fn catalog_provider_get_rejects_unknown_and_policy_denied_providers_by_id() {
    if isolated("catalog_provider_get_rejects_unknown_and_policy_denied_providers_by_id") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(180), async {
        let provider = r#"{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{"apiKey":"fixture","baseURL":"http://127.0.0.1:1"},"models":{"m":{}}}"#;
        let fixture = start_with_config(host,
            r#"
import { writeFileSync } from "node:fs"
const here = (name) => new URL(`./${name}`, import.meta.url)
const outcome = (promise) => promise.then((value) => ({ id: value?.data?.id ?? value?.id }), (error) => ({ error: String(error.message) }))
export default {
  id: "provider-probe",
  setup: async (context) => {
    const iterator = context.event.subscribe()[Symbol.asyncIterator]()
    void (async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        if (next.value.type !== "agent.updated") continue
        writeFileSync(here("providers.json"), JSON.stringify({
          allowed: await outcome(context.catalog.provider.get("allowed-provider")),
          denied: await outcome(context.catalog.provider.get("denied-provider")),
          unknown: await outcome(context.catalog.provider.get("missing-provider")),
        }))
        return
      }
    })()
    writeFileSync(here("ready"), "ready")
  },
}
"#,
            &[],
            &format!(
                r#","experimental":{{"policies":[{{"action":"provider.use","resource":"denied-provider","effect":"deny"}}]}},"providers":{{"allowed-provider":{provider},"denied-provider":{provider}}}"#
            ),
        )
        .await;
        assert_eq!(
            eventually(&fixture.directory.join("ready")).as_deref(),
            Some("ready")
        );
        fixture
            .core
            .events
            .emit(
                ycoding_core::event_feed::Data::AgentUpdated(Box::new(
                    ycoding_core::ycoding_schema::agent::Empty,
                )),
                Some(ycoding_core::ycoding_schema::location::Ref {
                    directory: ycoding_core::ycoding_schema::schema::AbsolutePath::new(
                        fixture.directory.to_str().unwrap(),
                    )
                    .unwrap(),
                    workspace_id: None,
                }),
            )
            .unwrap();
        let raw = eventually(&fixture.directory.join("providers.json"));
        fixture.close().await;
        let value = ycoding_core::ycoding_schema::parse_json(&raw.unwrap()).unwrap();
        assert_eq!(
            text(path(&value, &["allowed", "id"])).as_deref(),
            Some("allowed-provider")
        );
        assert_eq!(
            text(path(&value, &["denied", "error"])).as_deref(),
            Some("Provider not found: denied-provider")
        );
        assert_eq!(
            text(path(&value, &["unknown", "error"])).as_deref(),
            Some("Provider not found: missing-provider")
        );
    })
    .await
    .unwrap();
        })
    });
}
