use super::{Fixture, fixture};
use std::{os::unix::fs::PermissionsExt, sync::Arc, time::Duration};
use ycoding_core::{
    extension::v5::TransformStage,
    tools::policy::Effect,
    ycoding_schema::{DomainEncode, provider, session, stringify_json},
};

const CONFIGURATION: &str = r#"{"default_agent":"architech","model":{"providerID":"openai","model":"gpt-runtime"},"permissions":[{"action":"read","resource":"*","effect":"deny"}],"providers":{"openai":{"name":"Configured"}}}"#;

const PLUGIN: &str = r#"let runs = 0
export default {
  id: "fixture.precedence",
  setup: async (context) => {
    await context.agent.transform((draft) => {
      runs += 1
      draft.default("god")
      draft.update("god", (agent) => {
        agent.permissions.push({ action: "read", resource: "*", effect: "allow" })
      })
      draft.update("plugin-agent", (agent) => {
        Object.assign(agent, {
          name: "plugin-agent",
          description: `run-${runs}`,
          request: { settings: {}, headers: {}, body: {} },
          mode: "all",
          hidden: false,
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        })
      })
    })
    await context.catalog.transform((draft) => {
      draft.provider.update("openai", (provider) => {
        provider.name = "Plugin"
      })
      draft.model.default.set("openai", "gpt-helper")
    })
  },
}
"#;

#[derive(Debug, PartialEq)]
struct Observed {
    default_agent: Option<String>,
    god_last_rule: Option<String>,
    plugin_last_rule: Option<String>,
    plugin_read: Option<Effect>,
    plugin_glob: Option<Effect>,
    provider_name: Option<String>,
    default_model: Option<String>,
}

fn expected() -> Observed {
    let deny = Some(r#"{"action":"read","resource":"*","effect":"deny"}"#.to_owned());
    Observed {
        default_agent: Some("architech".into()),
        god_last_rule: deny.clone(),
        plugin_last_rule: deny,
        plugin_read: Some(Effect::Deny),
        plugin_glob: Some(Effect::Allow),
        provider_name: Some("Configured".into()),
        default_model: Some("gpt-runtime".into()),
    }
}

fn plugin_fixture() -> Fixture {
    let mut f = fixture(CONFIGURATION, r#"{"plugins":["./precedence.mjs"]}"#);
    let frontend = f.roots.data.join("plugin-frontend");
    std::fs::write(
        &frontend,
        format!(
            "#!/bin/sh\nexec bun '{}'\n",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/cli/src/plugin-host/main.ts"
            )
        ),
    )
    .unwrap();
    std::fs::set_permissions(&frontend, std::fs::Permissions::from_mode(0o755)).unwrap();
    Arc::get_mut(&mut f.factory).unwrap().options.env.insert(
        crate::launch::FRONTEND_EXECUTABLE_KEY.into(),
        frontend.to_str().unwrap().into(),
    );
    std::fs::write(f.directory().join("precedence.mjs"), PLUGIN).unwrap();
    f
}

fn observe(services: &crate::LocationServices) -> (Observed, Option<String>) {
    let composed = services.production.as_ref().unwrap();
    let agents = composed.agents.snapshot();
    let last_rule = |id: &str| {
        agents
            .get(&id.into())
            .and_then(|agent| agent.permissions.last())
            .map(|rule| stringify_json(&rule.encode()))
    };
    let effect = |action: &str| {
        services
            .permissions
            .evaluate_effective(
                &session::Id::new("ses_one").unwrap(),
                Some(&"plugin-agent".into()),
                &action.into(),
                &"fixture-file".into(),
            )
            .ok()
    };
    let catalog = composed.models.catalog();
    let observed = Observed {
        default_agent: agents
            .default_id()
            .and_then(|id| id.as_str().map(str::to_owned)),
        god_last_rule: last_rule("god"),
        plugin_last_rule: last_rule("plugin-agent"),
        plugin_read: effect("read"),
        plugin_glob: effect("glob"),
        provider_name: catalog
            .provider(&provider::Id("openai".into()))
            .and_then(|provider| provider.name.as_str().map(str::to_owned)),
        default_model: catalog
            .configured_default()
            .and_then(|selection| selection.id.as_str().map(str::to_owned)),
    };
    let marker = agents
        .get(&"plugin-agent".into())
        .and_then(|agent| agent.description.as_ref())
        .and_then(|description| description.as_str().map(str::to_owned));
    (observed, marker)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_default_agent_and_provider_overrides_win_over_plugin_transforms() {
    let f = plugin_fixture();
    let locations = f.locations();
    let services = f.services(&locations);
    let composed = services.production.as_ref().unwrap();
    let diagnostics = format!("{:?}", composed.extension_diagnostics);
    let (observed, marker) = observe(&services);
    composed.activation.close().await;
    locations.close().unwrap();
    assert_eq!(diagnostics, "[]");
    assert_eq!(
        marker.as_deref(),
        Some("run-1"),
        "plugin transform must run"
    );
    assert_eq!(
        (
            observed.default_agent,
            observed.provider_name,
            observed.default_model
        ),
        (
            expected().default_agent,
            expected().provider_name,
            expected().default_model
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_added_agents_receive_global_configured_permissions() {
    let f = plugin_fixture();
    let locations = f.locations();
    let services = f.services(&locations);
    let composed = services.production.as_ref().unwrap();
    let (observed, marker) = observe(&services);
    composed.activation.close().await;
    locations.close().unwrap();
    assert_eq!(
        marker.as_deref(),
        Some("run-1"),
        "plugin transform must run"
    );
    assert_eq!(
        (
            observed.god_last_rule,
            observed.plugin_last_rule,
            observed.plugin_read,
            observed.plugin_glob
        ),
        (
            expected().god_last_rule,
            expected().plugin_last_rule,
            expected().plugin_read,
            expected().plugin_glob
        )
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configuration_precedence_survives_single_domain_reloads() {
    let f = plugin_fixture();
    let locations = f.locations();
    let services = f.services(&locations);
    let composed = services.production.as_ref().unwrap();
    let (_, initial) = observe(&services);
    let reloaded = tokio::time::timeout(Duration::from_secs(60), async {
        composed.reload.request(TransformStage::Agents).await?;
        composed.reload.request(TransformStage::Catalog).await
    })
    .await;
    let (observed, marker) = observe(&services);
    composed.activation.close().await;
    locations.close().unwrap();
    reloaded.unwrap().unwrap();
    assert_eq!(initial.as_deref(), Some("run-1"));
    assert_ne!(
        marker, initial,
        "agent reload must rerun the plugin transform"
    );
    assert_eq!(observed, expected());
}
