use super::*;
use std::{
    collections::BTreeMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::atomic::{AtomicI64, AtomicU64, Ordering},
};
use tokio::sync::{mpsc, oneshot};
use ycoding_core::{
    process::guardrails::Input,
    resources::{memory::Scope, model::Error},
    session::{helper_generation::Generate, revert::Snapshots, usage_read::PricingRef},
    tools::{
        context::Context,
        policy::{Effect, helper::Role, questions::Admission},
    },
    ycoding_schema::{DomainEncode, form, parse_json, question, session},
    ycoding_store::{Metadata, Options, Store, project, resources::Secret, session::SessionTable},
};

#[path = "../../tests/support/catalog.rs"]
#[allow(dead_code)]
mod catalog_fixture;

const MODELS: &str = r#"{"openai":{"id":"openai","name":"OpenAI","api":"http://127.0.0.1:1","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai-compatible","models":{"gpt-runtime":{"id":"gpt-runtime","name":"Runtime","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"limit":{"context":128000,"output":8192},"cost":{"input":2,"output":3}},"gpt-helper":{"id":"gpt-helper","name":"Helper","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":false,"limit":{"context":64000,"output":4096},"cost":{"input":1,"output":2}}}}}"#;

static FIXTURE: AtomicU64 = AtomicU64::new(0);

#[test]
fn location_policy_events_publish_once_with_the_owned_location() {
    let f = fixture("{}", "{}");
    let (_, services) = f
        .locations()
        .session(&session::Id::new("ses_one").unwrap())
        .unwrap();
    let subscriber = f
        .feed
        .subscribe(ycoding_core::event_feed::Scope::Global, None, || {})
        .unwrap();
    services.forms.create(form::Info::decode(&parse_json(r#"{"id":"frm_location_once","sessionID":"global","title":"Choose","fields":[{"key":"name","type":"string","required":true}]}"#).unwrap()).unwrap()).unwrap();
    let items = std::iter::from_fn(|| subscriber.next().unwrap()).collect::<Vec<_>>();
    assert_eq!(items.len(), 1, "one policy event must publish exactly once");
    let ycoding_core::event_feed::Payload::Ephemeral(event) = &items[0].payload else {
        panic!("ephemeral form event expected")
    };
    assert!(matches!(
        event.data,
        ycoding_core::event_feed::Data::FormCreated(_)
    ));
    assert_eq!(
        event.location.as_ref().unwrap().directory,
        services.info.directory
    );
    assert!(event.session.is_none());
}

struct Fixture {
    store: Store,
    roots: config::Roots,
    factory: Arc<Factory>,
    feed: Feed,
}

fn fixture(global: &str, project_configuration: &str) -> Fixture {
    fixture_with(
        global,
        project_configuration,
        BTreeMap::from([("OPENAI_API_KEY".into(), "environment-key".into())]),
    )
}

fn fixture_with(
    global: &str,
    project_configuration: &str,
    env: BTreeMap<String, String>,
) -> Fixture {
    let root = std::env::temp_dir().join(format!(
        "composition-cases-{}-{}-{}",
        std::process::id(),
        FIXTURE.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let roots = config::Roots::development(&root).unwrap();
    roots.initialize().unwrap();
    let directory = root.join("project");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(roots.config.join("ycoding.json"), global).unwrap();
    std::fs::write(directory.join("ycoding.json"), project_configuration).unwrap();
    let store = Store::initialize(
        root.join("store.redb"),
        Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
        Metadata::new([3; 16], 1),
    )
    .unwrap();
    let placement = directory.to_str().unwrap().to_owned();
    store
        .submit(move |tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_one".into(),
                    worktree: placement.clone().into(),
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
                },
            )?;
            let mut row = catalog_fixture::record("ses_one");
            row.directory = placement.into();
            row.time_updated = crate::ids::now_millis();
            SessionTable::insert(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let client = store.client();
    let feed = Feed::attach(&client);
    let publisher = feed.clone();
    let options = config::LoadOptions {
        directory: directory.clone(),
        roots: roots.clone(),
        project: true,
        file: None,
        content: None,
        env: env.clone(),
    };
    let credentials = credential::Service::new(client.clone());
    let git = Arc::new(git::Service::new(16 * 1024 * 1024));
    let globals = globals::Globals::start(
        client.clone(),
        &Production {
            configuration: options,
            catalog: models_dev::Options {
                source: "https://models.dev".into(),
                cache: roots.cache.join("models.json"),
                file: None,
                bundled: Some(parse_json(MODELS).unwrap()),
                fetch: false,
                user_agent: "ycoding-test".into(),
            },
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
            meeting: false,
        },
        credentials.clone(),
        feed.clone(),
        git.clone(),
        false,
    )
    .unwrap();
    Fixture {
        factory: Arc::new(Factory {
            options: config::LoadOptions {
                directory,
                roots: roots.clone(),
                project: true,
                file: None,
                content: None,
                env,
            },
            snapshots: models_dev::normalize(&parse_json(MODELS).unwrap()).unwrap(),
            client: client.clone(),
            events: feed.clone(),
            credentials,
            executor: Arc::new(Executor::new(Executor::http_client().unwrap())),
            git,
            publisher: Arc::new(move |event| {
                publisher.publish(crate::services::ephemeral(&event)?);
                Ok(())
            }),
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
            globals,
            locations: Default::default(),
            orchestration: Default::default(),
            generations: Default::default(),
        }),
        store,
        roots,
        feed,
    }
}

impl Fixture {
    fn directory(&self) -> PathBuf {
        self.factory.options.directory.clone()
    }
    fn sessions(&self) -> Service {
        Service::new(self.store.client())
    }
    fn locations(&self) -> Locations {
        let mut global = self.factory.options.clone();
        global.directory = self.roots.config.clone();
        global.project = false;
        let configuration = config::Configuration::load(global).unwrap();
        Locations::new(
            self.store.client(),
            self.sessions(),
            self.factory.configuration(&configuration).unwrap(),
            self.feed.clone(),
            autonomy::Service::new(self.store.client()),
        )
        .with_factory(self.factory.clone())
    }
    fn services(&self, locations: &Locations) -> Arc<LocationServices> {
        locations
            .session(&session::Id::new("ses_one").unwrap())
            .unwrap()
            .1
    }
    fn model(&self, services: &LocationServices, value: &str) -> model::Resolved {
        let composed = services.production.as_ref().unwrap();
        composed
            .models
            .resolve(
                &ycoding_core::ycoding_schema::model::Ref::decode(&parse_json(value).unwrap())
                    .unwrap(),
                &composed.credentials.all().unwrap(),
                None,
            )
            .unwrap()
    }
}

#[test]
fn configuration_precedence_and_project_disable_feed_the_agent_catalog() {
    let mut f = fixture(
        r#"{"agents":{"god":{"description":"global-json"}}}"#,
        r#"{"agents":{"god":{"description":"project-json"}}}"#,
    );
    std::fs::write(
        f.roots.config.join("ycoding.jsonc"),
        r#"{// comment
"agents":{"god":{"description":"global-jsonc"}},}"#,
    )
    .unwrap();
    std::fs::write(
        f.directory().join("ycoding.jsonc"),
        r#"{"agents":{"god":{"description":"project-jsonc"}}}"#,
    )
    .unwrap();
    std::fs::create_dir_all(f.directory().join(".ycoding")).unwrap();
    std::fs::write(
        f.directory().join(".ycoding/ycoding.json"),
        r#"{"agents":{"god":{"description":"project-directory"}}}"#,
    )
    .unwrap();
    let explicit = f.roots.config.join("explicit.json");
    std::fs::write(
        &explicit,
        r#"{"agents":{"god":{"description":"explicit-file"}}}"#,
    )
    .unwrap();
    Arc::get_mut(&mut f.factory).unwrap().options.file = Some(explicit);
    let description = |f: &Fixture| {
        let prepared = f
            .factory
            .prepare(
                &f.directory().to_str().unwrap().into(),
                None,
                &"prj_one".into(),
                &f.directory().to_str().unwrap().into(),
            )
            .unwrap();
        prepared
            .configuration
            .agents
            .get(&"god".into())
            .unwrap()
            .description
            .clone()
            .unwrap()
    };
    assert_eq!(description(&f).as_str(), Some("project-directory"));
    Arc::get_mut(&mut f.factory).unwrap().options.content =
        Some(r#"{"agents":{"god":{"description":"inline-content"}}}"#.into());
    assert_eq!(description(&f).as_str(), Some("inline-content"));
    let options = &mut Arc::get_mut(&mut f.factory).unwrap().options;
    options.project = false;
    options.content = None;
    assert_eq!(description(&f).as_str(), Some("explicit-file"));
    Arc::get_mut(&mut f.factory).unwrap().options.file = None;
    assert_eq!(description(&f).as_str(), Some("global-jsonc"));
}

#[test]
fn markdown_agents_defaults_requests_models_and_permissions_are_loaded() {
    let f = fixture(
        r#"{"default_agent":"review","permissions":[{"action":"read","resource":"*","effect":"allow"}]}"#,
        r#"{"agents":{"review":{"model":{"providerID":"openai","model":"gpt-helper"},"request":{"headers":{"X-Agent":"review"},"body":{"top_p":0.7}},"permissions":[{"action":"edit","resource":"*","effect":"deny"}]}}}"#,
    );
    std::fs::create_dir_all(f.directory().join(".ycoding/agents")).unwrap();
    std::fs::write(
        f.directory().join(".ycoding/agents/review.md"),
        "---\ndescription: Markdown review\nmode: primary\n---\nReview the current evidence.",
    )
    .unwrap();
    let locations = f.locations();
    let services = f.services(&locations);
    let agent = services.agents.default().unwrap();
    assert_eq!(agent.id.as_str(), Some("review"));
    assert_eq!(
        agent.description.as_ref().unwrap().as_str(),
        Some("Markdown review")
    );
    assert!(
        agent
            .system
            .as_ref()
            .unwrap()
            .as_str()
            .unwrap()
            .contains("Review the current evidence")
    );
    assert_eq!(
        agent.model.as_ref().unwrap().id.as_str(),
        Some("gpt-helper")
    );
    assert!(agent.request.settings.0.is_empty());
    assert_eq!(
        agent.request.headers.get(&"X-Agent".into()),
        Some(&JsonValue::String("review".into()))
    );
    assert_eq!(
        agent.request.body.0.get(&"top_p".into()),
        Some(&JsonValue::Number(0.7))
    );
    assert_eq!(
        services
            .permissions
            .evaluate_effective(
                &session::Id::new("ses_one").unwrap(),
                Some(&agent.id),
                &"edit".into(),
                &"asset".into()
            )
            .unwrap(),
        Effect::Deny
    );
    for id in ["god", "prediction", "prompt"] {
        assert!(services.agents.get(&id.into()).is_some());
    }
    assert!(services.agents.get(&"prediction".into()).unwrap().hidden);
    assert!(services.agents.get(&"prompt".into()).unwrap().hidden);
}

#[test]
fn configured_catalog_variant_costs_and_explicit_key_override_environment() {
    let f = fixture(
        r#"{"model":{"providerID":"openai","model":"gpt-runtime"},"providers":{"openai":{"settings":{"apiKey":"explicit-key","baseURL":"http://127.0.0.1:1"},"headers":{"X-Provider":"base"},"models":{"gpt-runtime":{"cost":{"input":7,"output":9},"variants":[{"id":"careful","settings":{"temperature":0.1},"headers":{"X-Variant":"selected"},"body":{"top_p":0.6}}]}}}}}"#,
        "{}",
    );
    let locations = f.locations();
    let services = f.services(&locations);
    let resolved = f.model(
        &services,
        r#"{"providerID":"openai","id":"gpt-runtime","variant":"careful"}"#,
    );
    assert_eq!(resolved.info.cost[0].input.get(), 7.0);
    assert_eq!(resolved.info.cost[0].output.get(), 9.0);
    assert_eq!(
        resolved
            .info
            .settings
            .as_ref()
            .unwrap()
            .0
            .get(&"apiKey".into()),
        Some(&JsonValue::String("explicit-key".into()))
    );
    assert_eq!(
        resolved
            .info
            .settings
            .as_ref()
            .unwrap()
            .0
            .get(&"temperature".into()),
        Some(&JsonValue::Number(0.1))
    );
    assert_eq!(
        resolved
            .info
            .headers
            .as_ref()
            .unwrap()
            .get(&"X-Provider".into()),
        Some(&JsonValue::String("base".into()))
    );
    assert_eq!(
        resolved
            .info
            .headers
            .as_ref()
            .unwrap()
            .get(&"X-Variant".into()),
        Some(&JsonValue::String("selected".into()))
    );
    let route = model::from_catalog_model(&resolved.info, None).unwrap();
    assert_eq!(route.id.as_str(), Some("gpt-runtime"));
    assert_eq!(
        services
            .production
            .as_ref()
            .unwrap()
            .models
            .catalog()
            .configured_default()
            .unwrap()
            .id
            .as_str(),
        Some("gpt-runtime")
    );
}

#[tokio::test]
async fn credentials_are_shared_profiles_are_strict_and_pricing_stays_unreported_when_unknown() {
    let f = fixture("{}", "{}");
    let locations = f.locations();
    let services = f.services(&locations);
    let resolved = f.model(&services, r#"{"providerID":"openai","id":"gpt-runtime"}"#);
    assert_eq!(
        resolved
            .info
            .settings
            .as_ref()
            .unwrap()
            .0
            .get(&"apiKey".into()),
        Some(&JsonValue::String("environment-key".into()))
    );
    let credential = f
        .factory
        .credentials
        .create(
            "credential-work".into(),
            "openai".into(),
            Some("Work".into()),
            Secret::new(
                ycoding_core::ycoding_schema::credential::Value::Key(
                    ycoding_core::ycoding_schema::credential::Key {
                        key: "profile-key".into(),
                        metadata: None,
                    },
                )
                .encode(),
            )
            .unwrap(),
            crate::ids::now_millis(),
        )
        .await
        .unwrap();
    assert_eq!(
        services
            .production
            .as_ref()
            .unwrap()
            .credentials
            .get(credential.id())
            .unwrap()
            .unwrap()
            .label()
            .as_str(),
        Some("Work")
    );
    let reference = PricingRef {
        directory: f.directory().to_str().unwrap().into(),
        workspace_id: None,
        provider: "openai".into(),
        model: "gpt-runtime".into(),
        profile: Some("Work".into()),
    };
    assert_eq!(
        locations.pricing(&reference).unwrap().provider[0]
            .input
            .get(),
        2.0
    );
    for (provider, model, profile) in [
        ("missing", "gpt-runtime", None),
        ("openai", "missing", None),
        ("openai", "gpt-runtime", Some("Missing")),
    ] {
        assert!(
            locations
                .pricing(&PricingRef {
                    directory: reference.directory.clone(),
                    workspace_id: None,
                    provider: provider.into(),
                    model: model.into(),
                    profile: profile.map(Into::into)
                })
                .is_none()
        );
    }
    let composed = services.production.as_ref().unwrap();
    let missing = ycoding_core::ycoding_schema::model::Ref::decode(
        &parse_json(r#"{"providerID":"openai","id":"gpt-runtime","profile":"Missing"}"#).unwrap(),
    )
    .unwrap();
    assert_eq!(
        composed
            .models
            .resolve(&missing, &composed.credentials.all().unwrap(), None)
            .unwrap_err(),
        Error::ProfileUnavailable
    );
    assert!(
        locations
            .pricing(&PricingRef {
                directory: f.directory().join("unknown").to_str().unwrap().into(),
                ..reference
            })
            .is_none()
    );
}

#[test]
fn canonical_workspace_keys_and_concurrent_acquisition_share_only_their_own_sets() {
    let f = fixture("{}", "{}");
    let locations = f.locations();
    let directory: LosslessString = f.directory().to_str().unwrap().into();
    let first = f.services(&locations);
    let canonical = locations
        .location(
            &format!("{}/child/..", f.directory().display()).into(),
            None,
        )
        .unwrap();
    assert!(Arc::ptr_eq(
        &first.production.as_ref().unwrap().tools,
        &canonical.production.as_ref().unwrap().tools
    ));
    let workspace = locations
        .location(&directory, Some(&"wrk_alternate".into()))
        .unwrap();
    assert_eq!(
        workspace
            .info
            .workspace_id
            .as_ref()
            .unwrap()
            .as_lossless()
            .as_str(),
        Some("wrk_alternate")
    );
    assert!(!Arc::ptr_eq(
        &first.production.as_ref().unwrap().tools,
        &workspace.production.as_ref().unwrap().tools
    ));
    std::thread::scope(|scope| {
        let handles = (0..4)
            .map(|_| scope.spawn(|| locations.location(&directory, None).unwrap()))
            .collect::<Vec<_>>();
        for handle in handles {
            let acquired = handle.join().unwrap();
            assert!(Arc::ptr_eq(
                &first.production.as_ref().unwrap().tools,
                &acquired.production.as_ref().unwrap().tools
            ));
        }
    });
}

#[test]
fn eviction_pins_leases_resets_the_deadline_and_reloads_configuration() {
    let f = fixture("{}", r#"{"agents":{"god":{"description":"first"}}}"#);
    let locations = f.locations();
    let lease = f.services(&locations);
    let cloned = lease.clone();
    let tools = lease.production.as_ref().unwrap().tools.clone();
    drop(lease);
    assert_eq!(
        locations
            .evict_idle(Instant::now() + Duration::from_secs(7200))
            .unwrap(),
        0
    );
    drop(cloned);
    let released = Instant::now();
    assert_eq!(
        locations
            .evict_idle(released + Duration::from_secs(3599))
            .unwrap(),
        0
    );
    let reacquired = f.services(&locations);
    std::fs::write(
        f.directory().join("ycoding.json"),
        r#"{"agents":{"god":{"description":"reloaded"}}}"#,
    )
    .unwrap();
    assert_eq!(
        reacquired
            .agents
            .get(&"god".into())
            .unwrap()
            .description
            .as_ref()
            .unwrap()
            .as_str(),
        Some("first")
    );
    assert_eq!(
        locations
            .evict_idle(released + Duration::from_secs(7200))
            .unwrap(),
        0
    );
    drop(reacquired);
    assert_eq!(
        locations
            .evict_idle(Instant::now() + Duration::from_secs(3601))
            .unwrap(),
        1
    );
    let fresh = f.services(&locations);
    assert_eq!(
        fresh
            .agents
            .get(&"god".into())
            .unwrap()
            .description
            .as_ref()
            .unwrap()
            .as_str(),
        Some("reloaded")
    );
    assert!(!Arc::ptr_eq(
        &tools,
        &fresh.production.as_ref().unwrap().tools
    ));
}

#[test]
fn failed_builds_do_not_poison_cache_and_invalid_or_unknown_locations_fail_explicitly() {
    let mut f = fixture("{}", "{}");
    Arc::get_mut(&mut f.factory).unwrap().options.file = Some(f.roots.config.join("extra.json"));
    std::fs::write(f.roots.config.join("extra.json"), "{}").unwrap();
    let locations = f.locations();
    std::fs::rename(
        f.roots.config.join("extra.json"),
        f.roots.config.join("extra.saved"),
    )
    .unwrap();
    std::fs::create_dir(f.roots.config.join("extra.json")).unwrap();
    assert!(matches!(
        locations.session(&session::Id::new("ses_one").unwrap()),
        Err(Failure::Unavailable(_))
    ));
    std::fs::rename(
        f.roots.config.join("extra.json"),
        f.roots.config.join("extra.unreadable"),
    )
    .unwrap();
    std::fs::rename(
        f.roots.config.join("extra.saved"),
        f.roots.config.join("extra.json"),
    )
    .unwrap();
    assert!(f.services(&locations).production.is_some());
    assert!(matches!(
        locations.location(&"relative".into(), None),
        Err(Failure::Invalid(_))
    ));
    assert!(matches!(
        locations.location(&LosslessString::from_utf16(vec![0xd800]), None),
        Err(Failure::Invalid(_))
    ));
    assert!(matches!(
        locations.location(
            &f.directory().join("unknown").to_str().unwrap().into(),
            None
        ),
        Err(Failure::Unavailable(_))
    ));
    assert!(matches!(
        locations.session(&session::Id::new("ses_unknown").unwrap()),
        Err(Failure::SessionNotFound(_))
    ));
}

#[test]
fn malformed_and_executable_documents_surface_diagnostics_without_loading_agents() {
    for document in [
        "{not-json}",
        r#"{"providers":{"openai":{"package":"file:untrusted.ts"}},"agents":{"untrusted":{"description":"must not load"}}}"#,
        r#"{"agents":{"god":{"request":{"settings":{"temperature":0.2}}}}}"#,
    ] {
        let f = fixture(document, "{}");
        let services = f.services(&f.locations());
        assert!(
            !services
                .production
                .as_ref()
                .unwrap()
                .configuration
                .diagnostics
                .is_empty()
        );
        assert!(services.agents.get(&"untrusted".into()).is_none());
        assert!(services.agents.get(&"god".into()).is_some());
    }
}

#[tokio::test]
async fn native_memory_guardrail_limits_forms_questions_and_saved_permissions_are_composed() {
    let f = fixture(
        r#"{"guardrails":{"enabled":false,"max_concurrent_shells":2,"max_concurrent_subagents":3,"max_pending_reviews":4,"shell_wait_seconds":5},"memory":{"enabled":false,"max_concept_bytes":128,"max_bundle_bytes":1024,"max_concepts":8}}"#,
        "{}",
    );
    let prepared = f
        .factory
        .prepare(
            &f.directory().to_str().unwrap().into(),
            None,
            &"prj_one".into(),
            &f.directory().to_str().unwrap().into(),
        )
        .unwrap();
    assert!(!prepared.configuration.guardrails.enabled);
    assert_eq!(prepared.configuration.guardrails.limits.shells, 2);
    assert_eq!(prepared.configuration.guardrails.limits.subagents, 3);
    assert_eq!(prepared.configuration.guardrails.limits.reviews, 4);
    assert_eq!(
        prepared.configuration.guardrails.limits.shell_wait,
        Duration::from_secs(5)
    );
    assert_eq!(prepared.configuration.guardrails.global_roots.len(), 8);
    let services = f.services(&f.locations());
    let memory = services
        .production
        .as_ref()
        .unwrap()
        .memory
        .status(Scope::Knowledge)
        .unwrap();
    assert!(!memory.enabled);
    assert_eq!(memory.limits.max_concept_bytes, 128);
    assert_eq!(memory.limits.max_bundle_bytes, 1024);
    assert_eq!(memory.limits.max_concepts, 8);
    assert_eq!(
        services
            .production
            .as_ref()
            .unwrap()
            .memory
            .read(Scope::Knowledge, "missing")
            .unwrap_err(),
        memory::Error::Disabled
    );
    let form = form::Info::decode(&parse_json(r#"{"id":"frm_composed","sessionID":"ses_one","title":"Choose","fields":[{"key":"name","type":"string","required":true}]}"#).unwrap()).unwrap();
    let wait = services.forms.ask(form.clone()).unwrap();
    services
        .forms
        .reply(
            &form.id,
            form::Answer::decode(&parse_json(r#"{"name":"fixture"}"#).unwrap()).unwrap(),
        )
        .unwrap();
    assert!(matches!(wait.await.unwrap(), form::State::Answered(_)));
    let request = question::Request {
        id: question::Id::decode(&JsonValue::String("que_composed".into())).unwrap(),
        session_id: session::Id::new("ses_one").unwrap(),
        questions: vec![question::Info {
            question: "Which?".into(),
            header: "Pick".into(),
            options: vec![question::Option {
                label: "One".into(),
                description: "first".into(),
            }],
            multiple: None,
            custom: None,
        }],
        tool: None,
    };
    let Admission::Pending(wait) = services.questions.ask(request.clone()).unwrap() else {
        panic!("normal Session must wait for an answer")
    };
    services
        .questions
        .reply(&request.id, vec![vec!["One".into()]])
        .unwrap();
    assert_eq!(
        wait.await.unwrap().unwrap(),
        vec![vec![LosslessString::from("One")]]
    );
    services
        .saved
        .add(&services.info.project.id, &"read".into(), &["asset".into()])
        .unwrap();
    assert_eq!(
        services
            .saved
            .list(Some(&services.info.project.id))
            .unwrap()[0]
            .resource
            .as_str(),
        Some("asset")
    );
}

#[test]
fn custom_guardrails_deny_and_unreadable_rules_stay_fail_closed() {
    let f = fixture("{}", "{}");
    std::fs::create_dir_all(f.roots.config.join("guardrails")).unwrap();
    let rule = f.roots.config.join("guardrails/write.md");
    std::fs::write(&rule, "---\nid: configured-write\ndecision: deny\nactions: [write]\nresources: ['*']\nreason: fixture restriction\n---\nRestricted writes.").unwrap();
    let services = f.services(&f.locations());
    assert!(
        services
            .guardrails
            .assert(Input {
                session_id: session::Id::new("ses_one").unwrap(),
                action: "write".into(),
                resources: vec![f.directory().join("asset").to_str().unwrap().into()],
                metadata: None,
                skip_review: false,
                holder: None
            })
            .is_err()
    );
    std::fs::write(
        &rule,
        "---\nid: broken\ndecision: not-a-decision\n---\nInvalid.",
    )
    .unwrap();
    let prepared = f
        .factory
        .prepare(
            &f.directory().to_str().unwrap().into(),
            None,
            &"prj_one".into(),
            &f.directory().to_str().unwrap().into(),
        )
        .unwrap();
    let layers = (prepared.configuration.guardrails.custom)();
    assert!(layers.iter().any(|layer| !layer.invalid_files.is_empty()));
}

#[tokio::test]
async fn filesystem_tools_share_location_paths_policy_and_synthetic_instruction_history() {
    let f = fixture("{}", "{}");
    let locations = f.locations();
    let services = f.services(&locations);
    std::fs::create_dir_all(f.directory().join("nested")).unwrap();
    std::fs::write(
        f.directory().join("nested/AGENTS.md"),
        "Nested instructions.",
    )
    .unwrap();
    let tools = services
        .production
        .as_ref()
        .unwrap()
        .tools
        .materialize(&services.agents.default().unwrap().permissions);
    let evaluation = services
        .guardrails
        .evaluate(&Input {
            session_id: session::Id::new("ses_one").unwrap(),
            action: "file_mutation".into(),
            resources: vec![
                std::fs::canonicalize(f.directory())
                    .unwrap()
                    .join("nested/asset.txt")
                    .to_str()
                    .unwrap()
                    .into(),
            ],
            metadata: Some(match parse_json(r#"{"operation":"write"}"#).unwrap() {
                JsonValue::Object(metadata) => metadata,
                _ => unreachable!(),
            }),
            skip_review: false,
            holder: None,
        })
        .unwrap();
    assert_eq!(
        evaluation.effect,
        Effect::Allow,
        "contained filesystem mutations must not request outside-repository review"
    );
    let context = |call| Context::new("ses_one", "god", "msg_composed", call).unwrap();
    let written = tools
        .invoke(
            "write",
            parse_json(r#"{"path":"nested/asset.txt","content":"first value"}"#).unwrap(),
            context("call_write"),
        )
        .await
        .unwrap();
    assert!(written.error.is_none(), "{:?}", written.error);
    let edited = tools
        .invoke(
            "edit",
            parse_json(r#"{"path":"nested/asset.txt","oldString":"first","newString":"second"}"#)
                .unwrap(),
            context("call_edit"),
        )
        .await
        .unwrap();
    assert!(edited.error.is_none());
    let patched = tools.invoke("patch", parse_json(r#"{"patchText":"*** Begin Patch\n*** Update File: nested/asset.txt\n@@\n-second value\n+patched value\n*** End Patch"}"#).unwrap(), context("call_patch")).await.unwrap();
    assert!(patched.error.is_none());
    let read = tools
        .invoke(
            "read",
            parse_json(r#"{"path":"nested/asset.txt"}"#).unwrap(),
            context("call_read"),
        )
        .await
        .unwrap();
    assert!(read.error.is_none());
    assert_eq!(
        std::fs::read_to_string(f.directory().join("nested/asset.txt"))
            .unwrap()
            .trim(),
        "patched value"
    );
    let messages = f
        .sessions()
        .context(&session::Id::new("ses_one").unwrap())
        .unwrap();
    let [ycoding_core::ycoding_schema::session_message::Info::Synthetic(message)] =
        messages.as_slice()
    else {
        panic!("one durable synthetic instruction message expected")
    };
    assert_eq!(
        message
            .description
            .as_ref()
            .and_then(|description| description.as_str()),
        Some("Loaded nested/AGENTS.md")
    );
    assert!(
        message
            .text
            .as_str()
            .unwrap()
            .contains("Nested instructions.")
    );
    let glob = tools
        .invoke(
            "glob",
            parse_json(r#"{"pattern":"nested/*.txt"}"#).unwrap(),
            context("call_glob"),
        )
        .await
        .unwrap();
    assert!(glob.error.is_none());
    assert!(
        ycoding_core::ycoding_schema::stringify_json(&glob.output.unwrap().structured)
            .contains("nested/asset.txt")
    );
    let grep = tools
        .invoke(
            "grep",
            parse_json(r#"{"pattern":"patched","path":"nested","include":"*.txt"}"#).unwrap(),
            context("call_grep"),
        )
        .await
        .unwrap();
    assert!(grep.error.is_none());
    assert!(
        ycoding_core::ycoding_schema::stringify_json(&grep.output.unwrap().structured)
            .contains("patched value")
    );
    let memory = tools
        .invoke(
            "memory",
            parse_json(r#"{"action":"status","scope":"knowledge"}"#).unwrap(),
            context("call_memory"),
        )
        .await
        .unwrap();
    assert!(memory.error.is_none());
}

#[tokio::test]
async fn configured_tool_output_limits_use_managed_location_output_storage() {
    let f = fixture(r#"{"tool_output":{"max_bytes":128,"max_lines":10}}"#, "{}");
    std::fs::write(
        f.directory().join("large.txt"),
        "fixture text\n".repeat(200),
    )
    .unwrap();
    let services = f.services(&f.locations());
    let tools = services
        .production
        .as_ref()
        .unwrap()
        .tools
        .materialize(&services.agents.default().unwrap().permissions);
    let result = tools
        .invoke(
            "read",
            parse_json(r#"{"path":"large.txt"}"#).unwrap(),
            Context::new("ses_one", "god", "msg_large", "call_large").unwrap(),
        )
        .await
        .unwrap();
    assert!(result.error.is_none());
    assert_eq!(result.output_paths.len(), 1);
    assert!(result.output_paths[0].starts_with(f.roots.data.join("tool-output")));
    assert!(
        std::fs::read_to_string(&result.output_paths[0])
            .unwrap()
            .contains("fixture text")
    );
}

#[tokio::test]
async fn configured_tool_denials_prevent_filesystem_and_network_effects() {
    let f = fixture(
        "{}",
        r#"{"agents":{"god":{"permissions":[{"action":"edit","resource":"*","effect":"deny"},{"action":"webfetch","resource":"*","effect":"deny"},{"action":"websearch","resource":"*","effect":"deny"}]}}}"#,
    );
    let services = f.services(&f.locations());
    let tools = services
        .production
        .as_ref()
        .unwrap()
        .tools
        .materialize(&services.agents.default().unwrap().permissions);
    for (name, input) in [
        (
            "write",
            r#"{"path":"must-not-exist","content":"prohibited"}"#,
        ),
        ("webfetch", r#"{"url":"http://127.0.0.1:1"}"#),
        ("websearch", r#"{"query":"must not request"}"#),
    ] {
        let result = tools
            .invoke(
                name,
                parse_json(input).unwrap(),
                Context::new("ses_one", "god", "msg_denied", name).unwrap(),
            )
            .await
            .unwrap();
        assert!(
            result.error.is_some(),
            "{name} must be unavailable under deny"
        );
    }
    assert!(!f.directory().join("must-not-exist").exists());
}

#[tokio::test]
async fn snapshot_configuration_controls_real_git_capture() {
    let f = fixture("{}", r#"{"snapshots":false}"#);
    f.factory
        .git
        .create_repository(&f.directory(), &f.directory().join(".git"), None)
        .unwrap();
    std::fs::write(f.directory().join("asset.txt"), "snapshot content").unwrap();
    let locations = f.locations();
    let (info, services) = locations
        .session(&session::Id::new("ses_one").unwrap())
        .unwrap();
    assert!(services.snapshots(&info).capture().is_none());
    drop(services);
    locations
        .evict_idle(Instant::now() + Duration::from_secs(3601))
        .unwrap();
    std::fs::write(f.directory().join("ycoding.json"), r#"{"snapshots":true}"#).unwrap();
    let services = f.services(&locations);
    assert!(services.snapshots(&info).capture().is_some());
    let tools = services
        .production
        .as_ref()
        .unwrap()
        .tools
        .materialize(&services.agents.default().unwrap().permissions);
    let result = tools
        .invoke(
            "worktree",
            parse_json(r#"{"action":"list"}"#).unwrap(),
            Context::new("ses_one", "god", "msg_worktree", "call_worktree").unwrap(),
        )
        .await
        .unwrap();
    assert!(result.error.is_none());
    assert!(
        ycoding_core::ycoding_schema::stringify_json(&result.output.unwrap().structured)
            .contains(f.directory().to_str().unwrap())
    );
}

#[test]
fn helpers_resolve_configured_models_and_explicitly_reject_missing_agents_or_models() {
    let f = fixture(
        r#"{"efficiency":{"helper_models":{"prompt":{"providerID":"openai","model":"gpt-helper"}}}}"#,
        "{}",
    );
    let locations = f.locations();
    let (info, services) = locations
        .session(&session::Id::new("ses_one").unwrap())
        .unwrap();
    let composed = services.production.as_ref().unwrap();
    assert!(composed.runner.resolves(
        &info,
        Role::Prompt,
        services.agents.get(&"prompt".into()).unwrap()
    ));
    assert!(services.prediction.is_some() && services.prompts.is_some());
    assert!(composed.steer.is_none());
    let missing = fixture(
        r#"{"efficiency":{"helper_models":{"prompt":{"providerID":"openai","model":"missing"}}}}"#,
        r#"{"agents":{"prediction":{"disabled":true}}}"#,
    );
    let (_, services) = missing
        .locations()
        .session(&session::Id::new("ses_one").unwrap())
        .unwrap();
    assert!(services.agents.get(&"prediction".into()).is_none());
    let info = missing
        .sessions()
        .get(&session::Id::new("ses_one").unwrap())
        .unwrap()
        .unwrap();
    assert!(!services.production.as_ref().unwrap().runner.resolves(
        &info,
        Role::Prompt,
        services.agents.get(&"prompt".into()).unwrap()
    ));
}

#[test]
fn helper_model_priority_keeps_explicit_unavailable_selections_closed() {
    for (role, agent, selected, expected) in [
        (
            r#"{"providerID":"openai","model":"missing"}"#,
            r#"{"providerID":"openai","model":"gpt-runtime"}"#,
            None,
            true,
        ),
        (
            r#"{"providerID":"openai","model":"gpt-helper"}"#,
            "null",
            Some("missing"),
            true,
        ),
        (r#""session""#, "null", Some("missing"), false),
        (r#""session""#, "null", None, true),
    ] {
        let global = format!(
            r#"{{"model":{{"providerID":"openai","model":"gpt-runtime"}},"efficiency":{{"helper_models":{{"prompt":{role}}}}}}}"#
        );
        let project = if agent == "null" {
            "{}".into()
        } else {
            format!(r#"{{"agents":{{"prompt":{{"model":{agent}}}}}}}"#)
        };
        let f = fixture(&global, &project);
        let locations = f.locations();
        let (mut info, services) = locations
            .session(&session::Id::new("ses_one").unwrap())
            .unwrap();
        info.model = selected.map(|id| {
            ycoding_core::ycoding_schema::model::Ref::decode(
                &parse_json(&format!(r#"{{"providerID":"openai","id":"{id}"}}"#)).unwrap(),
            )
            .unwrap()
        });
        assert_eq!(
            services.production.as_ref().unwrap().runner.resolves(
                &info,
                Role::Prompt,
                services.agents.get(&"prompt".into()).unwrap()
            ),
            expected,
            "role={role}; agent={agent}; session={selected:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cursor_models_require_and_use_a_location_owned_host_context() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let discovery = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/aiserver.v1.AiService/AvailableModels",
                axum::routing::post(|| async {
                    (
                        [("content-type", "application/json")],
                        r#"{"models":[{"name":"cursor-model"}]}"#,
                    )
                }),
            ),
        )
        .await
        .unwrap();
    });
    let mut f = fixture_with(
        r#"{"model":{"providerID":"cursor","model":"cursor-model"}}"#,
        "{}",
        BTreeMap::from([
            ("OPENAI_API_KEY".into(), "environment-key".into()),
            ("CURSOR_API_KEY".into(), "cursor-key".into()),
        ]),
    );
    f.factory
        .globals
        .accounts
        .lock()
        .await
        .endpoints
        .insert("cursor".into(), endpoint);
    Arc::get_mut(&mut f.factory).unwrap().snapshots = models_dev::normalize(&parse_json(r#"{"cursor":{"id":"cursor","name":"Cursor","env":["CURSOR_API_KEY"],"npm":"cursor-opencode-provider","models":{"cursor-model":{"id":"cursor-model","name":"Cursor model","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"limit":{"context":128000,"output":8192}}}}}"#).unwrap()).unwrap();
    {
        let locations = f.locations();
        let (info, services) = locations
            .session(&session::Id::new("ses_one").unwrap())
            .unwrap();
        assert!(!services.production.as_ref().unwrap().runner.resolves(
            &info,
            Role::Prompt,
            services.agents.get(&"prompt".into()).unwrap()
        ));
    }
    Arc::get_mut(&mut f.factory).unwrap().cursor = Some(Cursor {
        identity: Identity {
            machine_id: "fixture-machine".into(),
            mac_machine_id: None,
            client_version: "test".into(),
        },
        runtime: Arc::new(
            Runtime::new(ycoding_core::ycoding_ai::cursor::transport::Options::default()).unwrap(),
        ),
    });
    let (info, services) = f
        .locations()
        .session(&session::Id::new("ses_one").unwrap())
        .unwrap();
    assert!(services.production.as_ref().unwrap().runner.resolves(
        &info,
        Role::Prompt,
        services.agents.get(&"prompt".into()).unwrap()
    ));
    discovery.abort();
}

#[tokio::test]
async fn bootstrap_rejects_invalid_roots_and_unavailable_catalog_without_installing_execution() {
    let f = fixture("{}", "{}");
    let production = |configuration: config::LoadOptions, bundled: Option<JsonValue>| Production {
        configuration,
        catalog: models_dev::Options {
            source: "invalid-source".into(),
            cache: f.roots.cache.join("catalog.json"),
            file: None,
            bundled,
            fetch: false,
            user_agent: "test".into(),
        },
        cursor: None,
        steer: None,
        ripgrep: "rg".into(),
        meeting: false,
    };
    let mut configuration = f.factory.options.clone();
    configuration.roots.data = PathBuf::from("/outside-development-root");
    assert!(matches!(
        Core::production(f.store.client(), production(configuration, None)).await,
        Err(Failure::Unavailable(_))
    ));
    assert!(matches!(
        Core::production(
            f.store.client(),
            production(f.factory.options.clone(), Some(JsonValue::Bool(false)))
        )
        .await,
        Err(Failure::Unavailable(_))
    ));
    let mut configuration = f.factory.options.clone();
    configuration.roots.home = f.roots.home.join("missing");
    for _ in 0..2 {
        let failed = Core::production(
            f.store.client(),
            Production {
                catalog: models_dev::Options {
                    source: "https://models.dev".into(),
                    cache: f.roots.cache.join("catalog.json"),
                    file: None,
                    bundled: Some(parse_json(MODELS).unwrap()),
                    fetch: false,
                    user_agent: "test".into(),
                },
                ..production(configuration.clone(), None)
            },
        )
        .await;
        assert!(
            matches!(&failed, Err(Failure::Unavailable(message)) if message == "Location guardrail directory is unavailable"),
            "a failure after the globals started must release the process-wide analytics owner and keep its own error: {:?}",
            failed.err()
        );
    }
    assert!(execution::Execution::global().is_none());
}

struct Sleep {
    milliseconds: u64,
    release: oneshot::Sender<()>,
}
struct Clock {
    now: AtomicI64,
    sleeps: mpsc::UnboundedSender<Sleep>,
}
impl runner::Clock for Clock {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn sleep(&self, milliseconds: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let (release, wait) = oneshot::channel();
        self.sleeps
            .send(Sleep {
                milliseconds,
                release,
            })
            .unwrap();
        Box::pin(async move {
            wait.await.unwrap();
        })
    }
}
async fn hourly(receiver: &mut mpsc::UnboundedReceiver<Sleep>, held: &mut Vec<Sleep>) -> Sleep {
    loop {
        let sleep = tokio::time::timeout(Duration::from_secs(10), receiver.recv())
            .await
            .unwrap()
            .unwrap();
        if sleep.milliseconds == 3_600_000 {
            return sleep;
        }
        assert_eq!(sleep.milliseconds, 60_000);
        held.push(sleep);
    }
}

#[tokio::test]
async fn retention_runs_at_boot_waits_an_hour_after_settlement_reloads_global_and_respects_active_families()
 {
    let f = fixture(
        r#"{"session_retention":{"days":2}}"#,
        r#"{"session_retention":{"days":999}}"#,
    );
    let now = crate::ids::now_millis();
    f.store
        .submit(move |tx| {
            for id in [
                "ses_idle",
                "ses_active",
                "ses_pinned",
                "ses_suspended",
                "ses_goal",
            ] {
                let mut row = catalog_fixture::record(id);
                row.directory = tx
                    .get::<project::ProjectTable>(&ycoding_core::ycoding_store::tuple_key(&[
                        ycoding_core::ycoding_store::KeyPart::String(&"prj_one".into()),
                    ]))?
                    .unwrap()
                    .worktree;
                row.time_updated = now - 3 * 86_400_000;
                if id == "ses_pinned" {
                    row.time_pinned = Some(now);
                }
                if id == "ses_suspended" {
                    row.time_suspended = Some(now);
                }
                if id == "ses_goal" {
                    row.autonomy = Some(
                        autonomy::State {
                            goal: Some(autonomy::Goal::new("fixture", None, None)),
                            ..Default::default()
                        }
                        .encode(),
                    );
                }
                SessionTable::insert(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let (sleeps, mut receiver) = mpsc::unbounded_channel();
    let clock = Arc::new(Clock {
        now: AtomicI64::new(now),
        sleeps,
    });
    let active = Arc::new(Mutex::new(vec![session::Id::new("ses_active").unwrap()]));
    let runtime_active = active.clone();
    let maintenance = Maintenance::new(&f.factory);
    maintenance.spawn(
        f.sessions(),
        f.locations(),
        f.factory.clone(),
        clock.clone(),
        Arc::new(move || runtime_active.lock().unwrap().clone()),
    );
    let mut held = Vec::new();
    let first = hourly(&mut receiver, &mut held).await;
    assert!(
        f.sessions()
            .get(&session::Id::new("ses_idle").unwrap())
            .unwrap()
            .is_none()
    );
    for id in ["ses_active", "ses_pinned", "ses_suspended", "ses_goal"] {
        assert!(
            f.sessions()
                .get(&session::Id::new(id).unwrap())
                .unwrap()
                .is_some()
        );
    }
    active.lock().unwrap().clear();
    std::fs::write(
        f.roots.config.join("ycoding.json"),
        r#"{"session_retention":{"days":1}}"#,
    )
    .unwrap();
    assert!(
        f.sessions()
            .get(&session::Id::new("ses_active").unwrap())
            .unwrap()
            .is_some(),
        "changing config or active status must not cause an early sweep"
    );
    clock.now.store(now + 3_600_000, Ordering::SeqCst);
    first.release.send(()).unwrap();
    let second = hourly(&mut receiver, &mut held).await;
    assert!(
        f.sessions()
            .get(&session::Id::new("ses_active").unwrap())
            .unwrap()
            .is_none()
    );
    assert_eq!(second.milliseconds, 3_600_000);
    assert!(held.iter().any(|sleep| sleep.milliseconds == 60_000));
    release(
        &maintenance.globals,
        &maintenance.credentials,
        None,
        None,
        Some(&maintenance),
    )
    .await
    .unwrap();
    assert!(maintenance.task.lock().unwrap().is_none());
}

#[tokio::test]
async fn retention_configuration_failure_preserves_data_and_recovers_on_the_next_hour() {
    let mut f = fixture(r#"{"session_retention":{"days":2}}"#, "{}");
    let source = f.roots.config.join("extra.json");
    std::fs::write(&source, "{}").unwrap();
    Arc::get_mut(&mut f.factory).unwrap().options.file = Some(source.clone());
    let locations = f.locations();
    let now = crate::ids::now_millis();
    f.store
        .submit(move |tx| {
            let mut row = catalog_fixture::record("ses_idle");
            row.time_updated = now - 3 * 86_400_000;
            SessionTable::insert(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
    std::fs::rename(&source, source.with_extension("saved")).unwrap();
    std::fs::create_dir(&source).unwrap();
    let (sleeps, mut receiver) = mpsc::unbounded_channel();
    let clock = Arc::new(Clock {
        now: AtomicI64::new(now),
        sleeps,
    });
    let maintenance = Maintenance::new(&f.factory);
    maintenance.spawn(
        f.sessions(),
        locations,
        f.factory.clone(),
        clock,
        Arc::new(Vec::new),
    );
    let mut held = Vec::new();
    let first = hourly(&mut receiver, &mut held).await;
    assert!(
        f.sessions()
            .get(&session::Id::new("ses_idle").unwrap())
            .unwrap()
            .is_some()
    );
    std::fs::rename(&source, source.with_extension("unreadable")).unwrap();
    std::fs::rename(source.with_extension("saved"), &source).unwrap();
    first.release.send(()).unwrap();
    let _second = hourly(&mut receiver, &mut held).await;
    assert!(
        f.sessions()
            .get(&session::Id::new("ses_idle").unwrap())
            .unwrap()
            .is_none()
    );
    release(
        &maintenance.globals,
        &maintenance.credentials,
        None,
        None,
        Some(&maintenance),
    )
    .await
    .unwrap();
}

fn extension_configuration(journal: &std::path::Path, permissions: &str) -> String {
    format!(
        r#"{{"permissions":{permissions},"extensions":[{{"identity":"trusted","executable":"/usr/bin/python3","args":["{child}","lifecycle","{journal}"],"grants":[{{"family":"tools","namespace":"trusted","tools":["echo"],"action":"extension.echo","resources":["demo"]}}]}}]}}"#,
        child = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../core/tests/extension_child.py"
        ),
        journal = journal.display()
    )
}

fn extension_journal() -> PathBuf {
    std::env::temp_dir().join(format!(
        "composition-extension-{}-{}",
        std::process::id(),
        FIXTURE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn started(journal: &std::path::Path) -> Vec<u32> {
    std::fs::read_to_string(journal)
        .unwrap_or_default()
        .lines()
        .map(|line| parse_json(line).unwrap())
        .filter_map(|entry| match entry {
            JsonValue::Object(entry)
                if entry.get(&"event".into()) == Some(&JsonValue::String("start".into())) =>
            {
                match entry.get(&"pid".into()) {
                    Some(JsonValue::Number(pid)) => Some(*pid as u32),
                    _ => None,
                }
            }
            _ => None,
        })
        .collect()
}

fn alive(pid: u32) -> bool {
    ycoding_core::platform::process::is_alive(pid).unwrap()
}

#[test]
fn configured_extensions_launch_by_trust_and_fail_closed_on_configured_deny_or_ask() {
    for (permissions, reason) in [
        ("[]", None),
        (
            r#"[{"action":"extension.launch","resource":"*","effect":"deny"}]"#,
            Some("authority rejected"),
        ),
        (
            r#"[{"action":"extension.*","resource":"*","effect":"ask"}]"#,
            Some("requires approval, which no Session can give"),
        ),
    ] {
        let journal = extension_journal();
        let f = fixture("{}", &extension_configuration(&journal, permissions));
        let locations = f.locations();
        let services = f.services(&locations);
        let composed = services.production.as_ref().unwrap();
        let launched = reason.is_none();
        assert_eq!(
            composed
                .plugins
                .iter()
                .any(|plugin| plugin.id.as_str() == Some("trusted")),
            launched,
            "{permissions}"
        );
        assert_eq!(
            composed
                .tools
                .materialize(&services.agents.default().unwrap().permissions)
                .definitions
                .iter()
                .any(|tool| tool.name.as_str() == Some("trusted_echo")),
            launched
        );
        match reason {
            Some(reason) => assert!(
                composed.extension_diagnostics.iter().any(|diagnostic| {
                    diagnostic.fail_closed == Some(true)
                        && diagnostic.message.to_utf8().unwrap().contains("trusted")
                        && diagnostic.message.to_utf8().unwrap().contains(reason)
                }),
                "{:?}",
                composed.extension_diagnostics
            ),
            None => assert!(composed.extension_diagnostics.is_empty()),
        }
        assert_eq!(started(&journal).len(), usize::from(launched));
        drop(services);
        locations.close().unwrap();
        assert!(started(&journal).into_iter().all(|pid| !alive(pid)));
        let _ = std::fs::remove_file(&journal);
    }
}

#[test]
fn location_reload_and_close_reap_extension_processes() {
    let journal = extension_journal();
    let f = fixture("{}", &extension_configuration(&journal, "[]"));
    let locations = f.locations();
    let services = f.services(&locations);
    let info = services.info.clone();
    let first = started(&journal);
    assert_eq!(first.len(), 1);
    assert!(alive(first[0]));
    drop(services);
    locations.reload(&info).unwrap();
    locations.evict_idle(Instant::now()).unwrap();
    let both = started(&journal);
    assert_eq!(both.len(), 2, "reload starts a fresh generation");
    assert!(
        !alive(both[0]),
        "the replaced generation's process must be reaped"
    );
    assert!(alive(both[1]));
    locations.close().unwrap();
    assert!(!alive(both[1]), "Location close must reap the process");
    let _ = std::fs::remove_file(&journal);
}

#[test]
fn configured_mcp_tools_register_through_the_location_watcher() {
    let state = extension_journal();
    std::fs::write(
        &state,
        format!(
            r#"{{"capabilities":{{"tools":{{"listChanged":true}}}},"responses":{{"tools/list":{{"":{{"tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{"type":"object","properties":{{}}}}}}]}}}}}},"calls":{{}},"log":"{}.log"}}"#,
            state.display()
        ),
    )
    .unwrap();
    let f = fixture(
        "{}",
        &format!(
            r#"{{"mcp":{{"servers":{{"table":{{"type":"local","codemode":false,"command":["python3","{}","{}"]}}}}}}}}"#,
            concat!(env!("CARGO_MANIFEST_DIR"), "/../core/tests/mcp_table.py"),
            state.display()
        ),
    );
    let locations = f.locations();
    let services = f.services(&locations);
    let composed = services.production.as_ref().unwrap();
    let permissions = &services.agents.default().unwrap().permissions;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !composed
        .tools
        .materialize(permissions)
        .definitions
        .iter()
        .any(|tool| tool.name.as_str() == Some("table_lookup"))
    {
        assert!(
            Instant::now() < deadline,
            "the MCP watcher never registered the tool"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(services);
    locations.close().unwrap();
    let _ = std::fs::remove_file(&state);
    let _ = std::fs::remove_file(state.with_extension("log"));
}

#[tokio::test]
async fn durable_session_deletion_releases_the_shared_browser_admission() {
    let f = fixture("{}", "{}");
    let id = ycoding_core::ycoding_schema::session_id::SessionId::new("ses_one").unwrap();
    f.factory.globals.browser.start(&id).await.unwrap();
    assert_eq!(
        f.factory.globals.admission.current("ses_one"),
        Some(ycoding_core::platform::browser::admission::Mode::Selected)
    );
    f.sessions()
        .remove(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while f.factory.globals.admission.current("ses_one").is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the process-global lifecycle owner must release deleted Session admission");
    f.factory.globals.close().await.unwrap();
}

#[tokio::test]
async fn control_lifecycle_keeps_processing_after_release_failure_and_reports_it_on_close() {
    let f = fixture("{}", "{}");
    let (send, mut received) = mpsc::unbounded_channel();
    let owner = controls::Owner::start(
        f.feed.clone(),
        Arc::new(move |session, lifecycle| {
            send.send((session, lifecycle)).unwrap();
            Box::pin(async move {
                if matches!(
                    lifecycle,
                    ycoding_core::platform::browser::service::Lifecycle::Moved
                ) {
                    return Err(unavailable("test control release"));
                }
                Ok(())
            })
        }),
    )
    .unwrap();
    let store = f.sessions();
    for (index, kind, data) in [
        (
            0,
            "session.moved.1",
            format!(
                r#"{{"sessionID":"ses_one","location":{{"directory":"{}"}}}}"#,
                f.directory().display()
            ),
        ),
        (1, "session.archived.2", r#"{"sessionID":"ses_one"}"#.into()),
    ] {
        store
            .publish(ycoding_core::ycoding_store::session::NewEvent {
                id: format!("evt_control_{index}").into(),
                aggregate_id: "ses_one".into(),
                created: crate::ids::now_millis(),
                type_: kind.into(),
                data: parse_json(&data).unwrap(),
            })
            .await
            .unwrap();
    }
    store
        .remove(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    for kind in ["Moved", "Archived", "Deleted"] {
        let (session, lifecycle) = tokio::time::timeout(Duration::from_secs(5), received.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.as_lossless().as_str(), Some("ses_one"));
        assert_eq!(format!("{lifecycle:?}"), kind);
    }
    assert!(
        matches!(owner.close().await, Err(Failure::Unavailable(message)) if message == "test control release unavailable")
    );
}

fn description(services: &LocationServices) -> Option<String> {
    services
        .agents
        .get(&"god".into())
        .and_then(|agent| agent.description.as_ref())
        .and_then(|description| description.to_utf8().ok())
}

fn next_generation(f: &Fixture, locations: &Locations, after: u64) -> Arc<LocationServices> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let current = f.services(locations);
        if current.production.as_ref().unwrap().generation != after {
            return current;
        }
        drop(current);
        assert!(
            Instant::now() < deadline,
            "configuration change was not reloaded"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn configuration_changes_replace_the_location_generation_and_failures_keep_the_current_one() {
    let f = fixture("{}", r#"{"agents":{"god":{"description":"first"}}}"#);
    let locations = f.locations();
    let _ = f.factory.locations.set(locations.downgrade());
    let held = f.services(&locations);
    let first = held.production.as_ref().unwrap().generation;
    assert_eq!(description(&held).as_deref(), Some("first"));
    std::fs::write(
        f.directory().join("ycoding.json"),
        r#"{"agents":{"god":{"description":"second"}}}"#,
    )
    .unwrap();
    let second = next_generation(&f, &locations, first);
    assert_eq!(description(&second).as_deref(), Some("second"));
    assert_eq!(
        description(&held).as_deref(),
        Some("first"),
        "a held lease keeps its generation's snapshot"
    );
    let generation = second.production.as_ref().unwrap().generation;
    drop(second);
    std::fs::remove_file(f.directory().join("ycoding.json")).unwrap();
    std::fs::create_dir(f.directory().join("ycoding.json")).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    let kept = f.services(&locations);
    assert_eq!(kept.production.as_ref().unwrap().generation, generation);
    assert_eq!(description(&kept).as_deref(), Some("second"));
    drop(kept);
    std::fs::remove_dir(f.directory().join("ycoding.json")).unwrap();
    std::fs::write(
        f.directory().join("ycoding.json"),
        r#"{"agents":{"god":{"description":"third"}}}"#,
    )
    .unwrap();
    let third = next_generation(&f, &locations, generation);
    assert_eq!(description(&third).as_deref(), Some("third"));
    drop((held, third));
    locations.close().unwrap();
}

#[test]
fn managed_project_artifacts_overlay_the_location_catalogs() {
    let f = fixture("{}", "{}");
    let definition = ycoding_core::ycoding_schema::project_artifact::Definition::decode(
        &parse_json(r#"{"kind":"agent","name":"Reviewer","description":"Reviews changes","system":"Review without modifying files.","mode":"subagent","permissions":[]}"#)
            .unwrap(),
    )
    .unwrap();
    f.factory
        .globals
        .artifacts
        .write_manual(
            ycoding_core::resources::project_artifact::store::ManualWriteInput {
                scope: ycoding_core::ycoding_schema::project_artifact::ScopeSelector::Project,
                project_id: Some(
                    ycoding_core::ycoding_schema::project::Id::new("prj_one").unwrap(),
                ),
                id: "review",
                definition: &definition,
                expected: None,
                now: crate::ids::now_millis(),
            },
        )
        .unwrap();
    let locations = f.locations();
    let services = f.services(&locations);
    assert_eq!(
        services
            .agents
            .get(&"review".into())
            .and_then(|agent| agent.description.as_ref())
            .and_then(|description| description.as_str()),
        Some("Reviews changes"),
        "the managed overlay must reach the Location agent catalog"
    );
    drop(services);
    locations.close().unwrap();
}
