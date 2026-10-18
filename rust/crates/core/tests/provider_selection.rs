#[path = "../../ai/tests/provider_contract_support/replay.rs"]
mod replay;
#[path = "../../ai/tests/provider_contract_support/structured.rs"]
mod structured;
#[path = "provider_selection_support/mod.rs"]
mod support;

use replay::{Replay, Reply};
use std::{collections::BTreeSet, sync::Arc};
use support::{ClockControl, Root, field};
use ycoding_ai::{
    llm::{Media, MediaData, Message, Part, Request, ToolDefinition},
    route::Executor,
};
use ycoding_core::{
    resources::{
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::{prompt_cache, run_coordinator::Coordinator, store::Service},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, model as model_schema, parse_json, provider_request,
    session,
};

const ENTRYPOINTS: &[(&str, &str)] = &[
    ("@ai-sdk/openai", "openai-responses"),
    ("@ycoding-ai/ai/providers/openai", "openai-responses"),
    (
        "@ycoding-ai/ai/providers/openai/responses",
        "openai-responses",
    ),
    ("@ai-sdk/anthropic", "anthropic-messages"),
    ("@ycoding-ai/ai/providers/anthropic", "anthropic-messages"),
    (
        "@ycoding-ai/ai/providers/anthropic-compatible",
        "anthropic-messages",
    ),
    ("@ai-sdk/openai-compatible", "openai-compatible-chat"),
    (
        "@ycoding-ai/ai/providers/openai-compatible",
        "openai-compatible-chat",
    ),
    (
        "@ycoding-ai/ai/providers/openai-compatible/responses",
        "openai-compatible-responses",
    ),
    ("@openrouter/ai-sdk-provider", "openrouter-responses"),
    (
        "@ycoding-ai/ai/providers/openrouter",
        "openrouter-responses",
    ),
];

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Member {
    provider: String,
    model: String,
    entrypoint: String,
    variant: Option<String>,
    profile: Option<String>,
    route: String,
}

struct Locations {
    runners: std::collections::BTreeMap<String, Arc<ycoding_core::session::runner::Local>>,
    observed: std::sync::Mutex<Vec<ycoding_schema::location::Ref>>,
}
impl ycoding_core::session::execution::Locations for Locations {
    fn get(
        &self,
        location: &ycoding_schema::location::Ref,
    ) -> Result<
        Arc<dyn ycoding_core::session::execution::Runner>,
        ycoding_core::session::run_coordinator::Error,
    > {
        self.observed.lock().unwrap().push(location.clone());
        self.runners
            .get(location.directory.as_lossless().as_str().unwrap())
            .cloned()
            .map(|runner| runner as Arc<dyn ycoding_core::session::execution::Runner>)
            .ok_or(ycoding_core::session::run_coordinator::Error::Closed)
    }
}

struct HostedTool(std::sync::atomic::AtomicUsize);
impl ycoding_core::tools::registry::Tool for HostedTool {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: "Provider-hosted web search".into(),
            input_schema: parse_json(
                r#"{"type":"object","properties":{},"additionalProperties":false}"#,
            )
            .unwrap(),
            output_schema: None,
            cache: None,
            metadata: None,
            native: Some(
                parse_json(r#"{"openai":{"type":"web_search","external_web_access":false}}"#)
                    .unwrap(),
            ),
        }
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(
        &self,
        input: JsonValue,
        _context: ycoding_core::tools::context::Context,
    ) -> ycoding_core::tools::registry::ToolFuture<'_> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            Ok(ycoding_ai::llm::ToolOutput {
                structured: input,
                content: Vec::new(),
            })
        })
    }
}

fn tool() -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(), description: "Lookup".into(),
        input_schema: parse_json(r#"{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":false}"#).unwrap(),
        output_schema: None, cache: None, metadata: None, native: None,
    }
}

#[tokio::test]
async fn test_039_derived_catalog_manifest_covers_entrypoints_variants_and_profiles() {
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/cli/script/models-dev.snapshot.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    let mut configurations = ycoding_schema::JsonObject::new();
    for record in &catalog.providers {
        configurations.insert(
            record.provider.id.0.clone(),
            parse_json(r#"{"settings":{"baseURL":"http://127.0.0.1:1/v1"}}"#).unwrap(),
        );
        for (serial, profile) in ["Work", "Personal"].iter().enumerate() {
            credentials
                .create(
                    format!(
                        "synthetic_{}_{serial}",
                        record.provider.id.0.as_str().unwrap()
                    )
                    .into(),
                    record.provider.id.0.clone(),
                    Some((*profile).into()),
                    support::key(&format!("synthetic-{profile}")),
                    serial as i64,
                )
                .await
                .unwrap();
        }
    }
    catalog
        .configure(&[ycoding_schema::ObjectEncoder::new()
            .field("providers", &JsonValue::Object(configurations))
            .finish()])
        .unwrap();
    let saved = credentials.all().unwrap();
    let mut manifest = BTreeSet::new();
    let mut asserted = BTreeSet::new();
    for record in &catalog.providers {
        let expected_route = match model::family(&record.provider.package).unwrap() {
            model::ProviderFamily::OpenAI | model::ProviderFamily::OpenRouter => {
                if record.provider.id.0 == "openrouter".into() {
                    "openrouter-responses"
                } else {
                    "openai-responses"
                }
            }
            model::ProviderFamily::Anthropic => "anthropic-messages",
            model::ProviderFamily::Compatible => "openai-compatible-chat",
            model::ProviderFamily::Cursor => "cursor-connect",
        };
        for info in &record.models {
            if !info.enabled {
                continue;
            }
            for variant in std::iter::once(None)
                .chain(info.variants.iter().map(|variant| Some(variant.id.clone())))
            {
                for profile in [None, Some("Work"), Some("Personal")] {
                    let selection = model_schema::Ref {
                        provider_id: record.provider.id.clone(),
                        id: info.id.clone(),
                        variant: variant.clone(),
                        profile: profile.map(|profile| model_schema::ProfileName(profile.into())),
                    };
                    let selected = profile.map(|profile| {
                        saved
                            .iter()
                            .find(|credential| {
                                credential.integration_id() == &record.provider.id.0
                                    && credential.label().as_str() == Some(profile)
                            })
                            .unwrap()
                    });
                    let resolved = model::Resolver::new(catalog.clone())
                        .resolve(&selection, &saved, selected)
                        .unwrap();
                    let native = model::from_catalog_model(
                        &resolved.info,
                        selected
                            .map(|credential| credential.secret().domain().unwrap())
                            .as_ref(),
                    )
                    .unwrap();
                    let member = Member {
                        provider: record.provider.id.0.to_utf8().unwrap(),
                        model: info.id.to_utf8().unwrap(),
                        entrypoint: record.provider.package.to_utf8().unwrap(),
                        variant: variant.as_ref().map(|variant| variant.to_utf8().unwrap()),
                        profile: profile.map(str::to_owned),
                        route: expected_route.into(),
                    };
                    assert!(manifest.insert(member));
                    assert_eq!(
                        native.route.id, expected_route,
                        "{selection:?}: route without oracle"
                    );
                    assert_eq!(
                        native.route.provider_metadata_key.as_deref(),
                        Some(if expected_route == "anthropic-messages" {
                            "anthropic"
                        } else {
                            "openai"
                        }),
                        "parser replay metadata key"
                    );
                    for capability in ["text", "media", "tool", "structured"] {
                        if capability == "media"
                            && !info
                                .capabilities
                                .input
                                .iter()
                                .any(|kind| kind.as_str() == Some("image"))
                        {
                            continue;
                        }
                        if capability == "tool" && !info.capabilities.tools {
                            continue;
                        }
                        let mut input = Request::new(native.clone());
                        input.system = vec!["Initial instructions".into()];
                        input.messages = vec![
                            Message::user("Request"),
                            Message::system("Chronological update"),
                            Message::user("Follow-up"),
                        ];
                        input.http.body =
                            Some(parse_json(r#"{"metadata":{"fixture":"manifest"}}"#).unwrap());
                        match capability {
                            "media" => input.messages[0].content.push(Part::Media(Media {
                                mime: "image/png".into(),
                                data: MediaData::Bytes(vec![1, 2, 3]),
                                filename: None,
                            })),
                            "tool" => input.tools.push(tool()),
                            "structured" => {
                                input.tools = vec![structured::definition()];
                                input.tool_choice = Some(ycoding_ai::llm::ToolChoice::Tool(
                                    "generate_object".into(),
                                ));
                            }
                            _ => {}
                        }
                        let prepared = native.route.prepare(&input).unwrap();
                        assert_eq!(prepared.url.host_str(), Some("127.0.0.1"));
                        assert_eq!(
                            prepared.url.path(),
                            match expected_route {
                                "anthropic-messages" => "/v1/messages",
                                "openai-compatible-chat" => "/v1/chat/completions",
                                _ => "/v1/responses",
                            }
                        );
                        assert_eq!(
                            field(&prepared.body, "model"),
                            Some(&resolved.info.model_id.encode())
                        );
                        assert!(prepared.encoded_body.contains("Chronological update"));
                        assert!(prepared.encoded_body.contains(r#""fixture":"manifest""#));
                        if let Some(profile) = profile {
                            let auth = if expected_route == "anthropic-messages" {
                                "x-api-key"
                            } else {
                                "authorization"
                            };
                            assert_eq!(
                                prepared.headers[auth].to_str().unwrap(),
                                if auth == "x-api-key" {
                                    format!("synthetic-{profile}")
                                } else {
                                    format!("Bearer synthetic-{profile}")
                                }
                            );
                        }
                        match capability {
                            "media" => assert!(prepared.encoded_body.contains("AQID")),
                            "tool" => assert!(prepared.encoded_body.contains("lookup")),
                            "structured" => {
                                assert!(prepared.encoded_body.contains("additionalProperties"))
                            }
                            _ => {}
                        }
                    }
                    asserted.insert(Member {
                        provider: record.provider.id.0.to_utf8().unwrap(),
                        model: info.id.to_utf8().unwrap(),
                        entrypoint: record.provider.package.to_utf8().unwrap(),
                        variant: variant.as_ref().map(|variant| variant.to_utf8().unwrap()),
                        profile: profile.map(str::to_owned),
                        route: expected_route.into(),
                    });
                }
            }
        }
    }
    assert_eq!(manifest, asserted);
    assert!(!manifest.is_empty());
    let scoped = include_str!("../src/resources/model/scope.rs")
        .split("pub(crate) fn dropped_package")
        .next()
        .unwrap()
        .split('"')
        .enumerate()
        .filter(|(index, _)| index % 2 == 1)
        .map(|(_, name)| name.to_owned())
        .collect::<BTreeSet<_>>();
    let members = manifest
        .iter()
        .map(|member| member.provider.clone())
        .chain(["cursor".into(), "muse".into()])
        .collect::<BTreeSet<_>>();
    assert_eq!(
        scoped, members,
        "new admitted provider needs composed route assertions"
    );
    let declared = include_str!("../src/resources/model/mod.rs")
        .split("pub fn family(")
        .nth(1)
        .unwrap()
        .split('"')
        .enumerate()
        .filter(|(index, _)| index % 2 == 1)
        .map(|(_, name)| name)
        .filter(|name| {
            name.starts_with('@') || *name == ycoding_core::resources::cursor::models::PACKAGE_NAME
        })
        .collect::<BTreeSet<_>>();
    let expected = ENTRYPOINTS
        .iter()
        .map(|(package, _)| *package)
        .chain([ycoding_core::resources::cursor::models::PACKAGE_NAME])
        .collect::<BTreeSet<_>>();
    assert_eq!(
        declared, expected,
        "new entrypoint requires request/stream/profile assertion membership"
    );
    for (package, route) in ENTRYPOINTS {
        for (serial, profile) in ["Work", "Personal"].into_iter().enumerate() {
            credentials
                .create(
                    format!("synthetic-local-{serial}").into(),
                    "local".into(),
                    Some(profile.into()),
                    support::key(&format!("synthetic-{profile}")),
                    serial as i64,
                )
                .await
                .unwrap();
        }
        let saved = credentials.list(&"local".into()).unwrap();
        for profile in [None, Some("Work"), Some("Personal")] {
            for variant in [None, Some("high")] {
                for transport in if *route == "openai-responses" {
                    &[None, Some("websocket")][..]
                } else {
                    &[None][..]
                } {
                    let prepared =
                        support::entrypoint(package, &saved, profile, variant, *transport);
                    assert_eq!(
                        prepared.route,
                        if transport.is_some() {
                            "openai-responses-websocket"
                        } else {
                            route
                        },
                        "{package}/{profile:?}/{variant:?}/{transport:?}"
                    );
                    assert_eq!(
                        prepared.encoded_body.contains(r#""variant":"high""#),
                        variant.is_some()
                    );
                    let expected = profile.unwrap_or("Personal");
                    let name = if *route == "anthropic-messages" {
                        "x-api-key"
                    } else {
                        "authorization"
                    };
                    assert_eq!(
                        prepared.headers[name].to_str().unwrap(),
                        if name == "x-api-key" {
                            format!("synthetic-{expected}")
                        } else {
                            format!("Bearer synthetic-{expected}")
                        }
                    );
                }
            }
        }
    }
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

fn assert_aisdk_route(route: &str) {
    for (package, _) in ENTRYPOINTS
        .iter()
        .filter(|(_, expected)| *expected == route)
    {
        let package = format!("aisdk:{package}");
        let prepared = support::entrypoint(&package, &[], None, Some("high"), None);
        assert_eq!(prepared.route, route, "{package}");
        assert!(prepared.encoded_body.contains(r#""variant":"high""#));
    }
}

#[test]
fn test_039_aisdk_openai_entrypoints() {
    assert_aisdk_route("openai-responses");
}

#[test]
fn test_039_aisdk_anthropic_entrypoints() {
    assert_aisdk_route("anthropic-messages");
}

#[test]
fn test_039_aisdk_compatible_chat_entrypoints() {
    assert_aisdk_route("openai-compatible-chat");
}

#[test]
fn test_039_aisdk_compatible_responses_entrypoint() {
    assert_aisdk_route("openai-compatible-responses");
}

#[test]
fn test_039_aisdk_openrouter_entrypoints() {
    assert_aisdk_route("openrouter-responses");
}

#[tokio::test]
async fn test_039_dynamic_cursor_and_muse_variant_profile_manifest() {
    use ycoding_core::resources::{cursor, muse};
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    for provider in ["cursor", "muse"] {
        for (serial, profile) in ["Work", "Personal"].into_iter().enumerate() {
            credentials
                .create(
                    format!("synthetic-{provider}-{profile}").into(),
                    provider.into(),
                    Some(profile.into()),
                    support::key(&format!("synthetic-{profile}-key")),
                    serial as i64,
                )
                .await
                .unwrap();
        }
    }
    let source = r#"{"data":[{"id":"muse-contract","metadata":{"muse-code":{"name":"Muse Contract","family":"muse","release_date":"2026-01-01","tool_call":true,"modalities":{"input":["text","image"],"output":["text"]},"limit":{"context":128000,"output":8192},"variants":{"low":{"reasoningEffort":"low"},"high":{"reasoningEffort":"high"}}}}}]}"#;
    let replay = Replay::start(
        vec![
            Reply::json("GET", "/muse-code/models", 200, source),
            Reply::json("GET", "/muse-code/models", 200, source),
        ]
        .into_iter()
        .chain((0..6).map(|_| Reply::stream("/v1/responses", structured::frames("responses"))))
        .collect(),
    )
    .await;
    let runtime = ycoding_ai::muse::Runtime::new(format!("{}/mint", replay.base)).unwrap();
    let mut muse = muse::Service::new(runtime.clone()).with_base_url(format!("{}/v1", replay.base));
    let mut catalog = Catalog::default();
    assert!(
        muse.refresh(&mut catalog, &credentials, &Default::default(), 100)
            .await
            .unwrap()
    );
    let cursor_models = ycoding_ai::cursor::models::available_models(&parse_json(r#"{"models":[{"name":"composer-contract","clientDisplayName":"Composer Contract","supportsAgent":true,"supportsImages":false,"supportsThinking":true,"variants":[{"parameterValues":[{"id":"effort","value":"low"}],"isDefaultNonMaxConfig":true},{"parameterValues":[{"id":"effort","value":"high"}]}]}]}"#).unwrap()).unwrap();
    cursor::catalog::sync(&mut catalog, cursor::models::from_cursor(&cursor_models));
    let context = model::ProviderContext::new(Default::default(), "contract").unwrap();
    let cursor_runtime =
        Arc::new(ycoding_ai::cursor::provider::Runtime::new(Default::default()).unwrap());
    let host = cursor::route::Host {
        identity: ycoding_ai::cursor::headers::Identity {
            machine_id: "synthetic-machine".into(),
            mac_machine_id: None,
            client_version: "contract".into(),
        },
        context: ycoding_ai::cursor::provider::RequestContext::new(vec![10, 0]).unwrap(),
        runtime: cursor_runtime.clone(),
        known_mcp_servers: Vec::new(),
        extensions: cursor::route::Extensions {
            models: cursor_models.clone(),
            agent: Some(
                ycoding_ai::cursor::transport::Endpoint::loopback("127.0.0.1:1".parse().unwrap())
                    .unwrap(),
            ),
            ..Default::default()
        },
    };
    let saved = credentials.all().unwrap();
    let mut members = BTreeSet::new();
    for provider in ["cursor", "muse"] {
        let provider_id = ycoding_schema::provider::Id(provider.into());
        for profile in ["Work", "Personal"] {
            let selected = saved
                .iter()
                .find(|credential| {
                    credential.integration_id().as_str() == Some(provider)
                        && credential.label().as_str() == Some(profile)
                })
                .unwrap();
            if provider == "cursor" {
                context
                    .cursor
                    .set_models(selected, cursor_models.clone())
                    .await
                    .unwrap();
            }
            for info in catalog
                .all(&saved)
                .into_iter()
                .filter(|info| info.provider_id == provider_id)
            {
                for variant in std::iter::once(None)
                    .chain(info.variants.iter().map(|variant| Some(variant.id.clone())))
                {
                    let selection = model_schema::Ref {
                        provider_id: provider_id.clone(),
                        id: info.id.clone(),
                        profile: Some(model_schema::ProfileName(profile.into())),
                        variant: variant.clone(),
                    };
                    let resolved = model::Resolver::new(catalog.clone())
                        .resolve(&selection, &saved, Some(selected))
                        .unwrap();
                    let value = selected.secret().domain().unwrap();
                    let native = if provider == "muse" {
                        ycoding_core::resources::muse::from_catalog_model(
                            &resolved.info,
                            Some(&value),
                            Some(selected),
                            runtime.clone(),
                        )
                        .unwrap()
                    } else {
                        context
                            .selected_model(
                                &resolved.info,
                                Some(&value),
                                Some(selected),
                                None,
                                Some(&host),
                                None,
                            )
                            .await
                            .unwrap()
                    };
                    let route = if provider == "muse" {
                        "muse-responses"
                    } else {
                        "cursor-connect"
                    };
                    assert_eq!(native.route.id, route);
                    members.insert(Member {
                        provider: provider.into(),
                        model: info.id.to_utf8().unwrap(),
                        entrypoint: resolved.info.package.as_ref().unwrap().to_utf8().unwrap(),
                        variant: variant.as_ref().map(|variant| variant.to_utf8().unwrap()),
                        profile: Some(profile.into()),
                        route: route.into(),
                    });
                    let mut input = Request::new(native.clone());
                    input.system.push("Initial".into());
                    input.messages = vec![
                        Message::user("Native request"),
                        Message::system("Chronological update"),
                    ];
                    input.tools.push(tool());
                    let prepared = native.route.prepare(&input).unwrap();
                    assert_eq!(
                        prepared.protocol,
                        if provider == "muse" {
                            "openai-responses"
                        } else {
                            "cursor-connect"
                        }
                    );
                    assert!(prepared.encoded_body.contains("Native request"));
                    if provider == "muse" {
                        assert!(prepared.encoded_body.contains("lookup"));
                        input.messages[0].content.push(Part::Media(Media {
                            mime: "image/png".into(),
                            data: MediaData::Bytes(vec![1, 2, 3]),
                            filename: None,
                        }));
                        input.tools = vec![structured::definition()];
                        input.tool_choice =
                            Some(ycoding_ai::llm::ToolChoice::Tool("generate_object".into()));
                        let body = native.route.prepare(&input).unwrap().encoded_body;
                        assert!(body.contains("AQID"));
                        assert!(body.contains("additionalProperties"));
                        let (object, _) = Executor::new(replay.client())
                            .generate_object(&input, structured::schema())
                            .await
                            .unwrap();
                        assert_eq!(object, parse_json(r#"{"value":"result"}"#).unwrap());
                    } else {
                        input.messages[0].content.push(Part::Media(Media {
                            mime: "image/png".into(),
                            data: MediaData::Bytes(vec![1, 2, 3]),
                            filename: None,
                        }));
                        assert!(
                            native.route.prepare(&input).is_err(),
                            "unsupported Cursor image must fail before IO"
                        );
                    }
                }
            }
        }
    }
    for provider in ["cursor", "muse"] {
        for profile in ["Work", "Personal"] {
            assert!(members.iter().any(|member| member.provider == provider
                && member.profile.as_deref() == Some(profile)
                && member.variant.is_some()));
        }
    }
    assert_eq!(replay.finish().await.len(), 8);
    context.shutdown().await;
    cursor_runtime.shutdown().await;
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn test_042_named_profiles_replacement_usage_report_and_privacy() {
    let root = Root::new("accounts");
    let store = support::store();
    let engine =
        ycoding_store::analytics::reports::start(store.client(), root.path().join("reports"))
            .unwrap();
    let service = Service::new(store.client());
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "synthetic-work-id".into(),
            "openai".into(),
            Some("Work".into()),
            support::key("synthetic-work-secret"),
            1,
        )
        .await
        .unwrap();
    credentials
        .create(
            "synthetic-personal-id".into(),
            "openai".into(),
            Some("Personal".into()),
            support::key("synthetic-personal-secret"),
            2,
        )
        .await
        .unwrap();
    let replay = Replay::start(vec![
        Reply::stream("/v1/chat/completions", support::chat("")),
        Reply::stream("/v1/chat/completions", support::chat(r#", "usage":{"prompt_tokens":7,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":2},"private_payload":"synthetic-raw"}"#)),
        Reply::stream("/v1/chat/completions", support::chat(r#", "usage":{"prompt_tokens":0,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}"#)),
    ]).await;
    let models = Arc::new(model::Resolver::new(support::catalog(
        &replay.base,
        "account-model",
    )));
    let coordinator = Coordinator::new(Arc::new(support::local(
        &store,
        models,
        "/project",
        &root,
        Arc::new(Executor::new(replay.client())),
        Arc::new(ClockControl::default()),
    )));
    let one = session::Id::new("ses_one").unwrap();
    let two = session::Id::new("ses_two").unwrap();
    support::select(&service, "ses_one", Some("Work"), None, 1).await;
    support::select(&service, "ses_two", Some("Personal"), None, 2).await;
    assert!(service.pending_list(&one).unwrap().is_empty());
    support::admit(&service, "ses_one", 1, "Work draft").await;
    coordinator.run(&one).await.unwrap();
    let absent = service.usage(&one, None).unwrap();
    assert_eq!(absent.cache_read_reported, Some(false));
    let absent_report = service
        .usage_report(
            &one,
            &provider_request::ReportInput::decode(&parse_json(r#"{"group":"model"}"#).unwrap())
                .unwrap(),
            None,
        )
        .unwrap();
    assert_eq!(absent_report.total.cache_read_reported, Some(false));
    support::admit(&service, "ses_two", 2, "Personal draft").await;
    coordinator.run(&two).await.unwrap();
    credentials
        .create(
            "synthetic-replacement-id".into(),
            "openai".into(),
            Some("Work".into()),
            support::key("synthetic-replacement-secret"),
            3,
        )
        .await
        .unwrap();
    support::admit(&service, "ses_one", 3, "Retained draft").await;
    let failure = coordinator.run(&one).await.unwrap_err();
    assert!(
        matches!(failure, ycoding_core::session::run_coordinator::Error::Runner(error) if error.r#type.as_str() == Some("model.profile"))
    );
    assert_eq!(support::requests(&store, "ses_one").len(), 1);
    assert_eq!(service.pending_list(&one).unwrap().len(), 1);
    support::select(&service, "ses_one", Some("Work"), None, 3).await;
    assert_eq!(
        service.pending_list(&one).unwrap().len(),
        1,
        "selection must not admit a prompt"
    );
    coordinator.run(&one).await.unwrap();
    let actual = replay.finish().await;
    assert_eq!(actual.len(), 3);
    for (request, key) in actual.iter().zip([
        "synthetic-work-secret",
        "synthetic-personal-secret",
        "synthetic-replacement-secret",
    ]) {
        assert!(
            request
                .headers
                .to_lowercase()
                .contains(&format!("authorization: bearer {key}"))
        );
    }
    let work = support::requests(&store, "ses_one");
    let personal = support::requests(&store, "ses_two");
    assert_ne!(
        work[0].connection_identity_digest,
        personal[0].connection_identity_digest
    );
    assert_ne!(
        work[0].connection_identity_digest,
        work[1].connection_identity_digest
    );
    assert_ne!(work[0].prompt_cache_key, personal[0].prompt_cache_key);
    assert_ne!(work[0].prompt_cache_key, work[1].prompt_cache_key);
    assert_eq!(work[0].cache_read_reported, Some(0));
    assert_eq!(work[1].cache_read_reported, Some(1));
    assert_eq!(personal[0].tokens.domain().unwrap().reasoning.get(), 2.0);
    let report = service
        .usage_report_all(
            &provider_request::ReportInput::decode(&parse_json(r#"{"group":"model"}"#).unwrap())
                .unwrap(),
            None,
        )
        .unwrap();
    assert_eq!(report.total.logical.get(), 3);
    assert_eq!(report.total.physical.get(), 3);
    assert_eq!(report.total.tokens.reasoning.get(), 2.0);
    assert_eq!(report.total.tokens.output.get(), 3.0);
    assert_eq!(report.total.cache_read_reported, Some(false));
    assert_eq!(
        service.usage(&two, None).unwrap().cache_read_reported,
        Some(true)
    );
    assert_eq!(
        service
            .usage_report(
                &two,
                &provider_request::ReportInput::decode(
                    &parse_json(r#"{"group":"model"}"#).unwrap()
                )
                .unwrap(),
                None
            )
            .unwrap()
            .total
            .cache_read_reported,
        Some(true)
    );
    let rendered = format!(
        "{}{}{}",
        ycoding_schema::stringify_json(&report.encode()),
        ycoding_schema::stringify_json(&service.usage_all(None).unwrap().encode()),
        ycoding_schema::stringify_json(&JsonValue::Array(
            service
                .context(&two)
                .unwrap()
                .iter()
                .map(DomainEncode::encode)
                .collect()
        ))
    );
    for prohibited in [
        "synthetic-work-id",
        "synthetic-personal-id",
        "synthetic-replacement-id",
        "synthetic-work-secret",
        "synthetic-personal-secret",
        "synthetic-replacement-secret",
        "synthetic-raw",
        "private_payload",
        "authorization",
        "@example.test",
    ] {
        assert!(!rendered.contains(prohibited), "privacy leak: {prohibited}");
    }
    assert!(
        rendered.contains("plan"),
        "reasoning lost in durable transcript"
    );
    coordinator.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    engine.shutdown().unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn test_040_runner_retry_agrees_with_physical_requests_and_terminal_consumers() {
    let root = Root::new("retry");
    let store = support::store();
    let service = Service::new(store.client());
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "synthetic-id".into(),
            "openai".into(),
            None,
            support::key("synthetic-key"),
            1,
        )
        .await
        .unwrap();
    let replay = Replay::start(vec![
        Reply {
            headers: "Retry-After: 0\r\n",
            ..Reply::json(
                "POST",
                "/v1/chat/completions",
                429,
                r#"{"error":{"type":"rate_limit_error","message":"retry"}}"#,
            )
        },
        Reply::stream(
            "/v1/chat/completions",
            support::chat(r#", "usage":{"prompt_tokens":3,"completion_tokens":2}"#),
        ),
    ])
    .await;
    let clock = Arc::new(ClockControl::default());
    let coordinator = Coordinator::new(Arc::new(support::local(
        &store,
        Arc::new(model::Resolver::new(support::catalog(
            &replay.base,
            "retry-model",
        ))),
        "/project",
        &root,
        Arc::new(Executor::new(replay.client())),
        clock.clone(),
    )));
    support::admit(&service, "ses_one", 1, "Retry draft").await;
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    assert_eq!(replay.finish().await.len(), 2);
    let requests = support::requests(&store, "ses_one");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].attempts, 2);
    let usage = service.usage(&id, None).unwrap();
    assert_eq!((usage.logical.get(), usage.physical.get()), (1, 2));
    let events = support::events(&store, "ses_one");
    assert_eq!(
        events
            .iter()
            .filter(|name| name.as_str() == "session.step.started.1")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|name| name.as_str() == "session.step.ended.1")
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|name| name.as_str() == "session.step.failed.1")
            .count(),
        0
    );
    assert_eq!(clock.delays.lock().unwrap().len(), 1);
    coordinator.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn test_059_catalog_startup_failure_then_explicit_sync_before_list() {
    let root = Root::new("catalog");
    let source = r#"{"openai":{"id":"openai","name":"OpenAI","env":[],"npm":"@ai-sdk/openai","models":{"catalog-model":{"id":"catalog-model","name":"Catalog","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"limit":{"context":128000,"output":8192}}}}}"#;
    let synced = source.replace("catalog-model", "synced-model");
    let replay = Replay::start(vec![
        Reply::json(
            "GET",
            "/catalog/api.json",
            400,
            r#"{"error":"synthetic-failure"}"#,
        ),
        Reply::json("GET", "/catalog/api.json", 200, &synced),
    ])
    .await;
    let source_service = models_dev::Service::new(models_dev::Options {
        source: format!("{}/catalog", replay.base),
        cache: root.path().join("models.json"),
        file: None,
        bundled: Some(parse_json(source).unwrap()),
        fetch: true,
        user_agent: "ycoding-contract".into(),
    })
    .unwrap();
    let initial = source_service.get().await.unwrap();
    let mut catalog = Catalog::new(initial);
    catalog.set_connected("openai".into(), true);
    let resolver = model::Resolver::new(catalog);
    assert!(
        resolver
            .catalog()
            .available(&[])
            .iter()
            .any(|info| info.id == "catalog-model".into())
    );
    assert!(source_service.refresh(true).await.is_err());
    assert_eq!(*source_service.refreshed().borrow(), 0);
    assert!(
        resolver
            .catalog()
            .available(&[])
            .iter()
            .any(|info| info.id == "catalog-model".into())
    );
    assert!(source_service.refresh(true).await.unwrap());
    assert_eq!(*source_service.refreshed().borrow(), 1);
    let mut updated = Catalog::new(source_service.get().await.unwrap());
    updated.set_connected("openai".into(), true);
    resolver.replace(updated).unwrap();
    assert_eq!(
        resolver
            .catalog()
            .available(&[])
            .iter()
            .map(|info| info.id.clone())
            .collect::<Vec<_>>(),
        vec![ycoding_schema::LosslessString::from("synced-model")]
    );
    assert_eq!(replay.finish().await.len(), 2);
    drop(source_service);
}

#[tokio::test]
async fn test_059_resumed_session_own_location_selection_no_admission_and_omitted_effort() {
    let root = Root::new("locations");
    let store = support::store();
    let service = Service::new(store.client());
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "synthetic-work-id".into(),
            "openai".into(),
            Some("Work".into()),
            support::key("synthetic-key"),
            1,
        )
        .await
        .unwrap();
    let replay = Replay::start(vec![Reply::stream(
        "/v1/chat/completions",
        support::chat(""),
    )])
    .await;
    let models = Arc::new(model::Resolver::new(support::catalog(
        &replay.base,
        "session-location-model",
    )));
    let mut home = support::catalog("http://127.0.0.1:1", "home-location-model");
    home.set_default(Some(model_schema::Ref {
        provider_id: ycoding_schema::provider::Id("openai".into()),
        id: "selected".into(),
        profile: Some(model_schema::ProfileName("Work".into())),
        variant: Some("high".into()),
    }));
    support::select(&service, "ses_one", Some("Work"), Some("high"), 1).await;
    support::select(&service, "ses_one", Some("Work"), None, 2).await;
    assert!(
        service
            .pending_list(&session::Id::new("ses_one").unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(support::requests(&store, "ses_one").is_empty());
    let selected = service
        .get(&session::Id::new("ses_one").unwrap())
        .unwrap()
        .unwrap()
        .model
        .unwrap();
    assert_eq!(
        selected.variant, None,
        "remembered effort must not replace omission"
    );
    assert!(
        service
            .get(&session::Id::new("ses_two").unwrap())
            .unwrap()
            .unwrap()
            .model
            .is_none(),
        "Session choice leaked to Home/new Session"
    );
    support::admit(&service, "ses_one", 1, "Session-owned draft").await;
    store
        .submit(|tx| {
            let key =
                ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_two".into())]);
            let mut row = tx
                .get::<ycoding_store::session::SessionTable>(&key)?
                .unwrap();
            row.directory = "/home-project".into();
            ycoding_store::session::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    support::admit(&service, "ses_two", 2, "Other Session draft").await;
    let draft = service
        .pending_list(&session::Id::new("ses_two").unwrap())
        .unwrap();
    let locations = Arc::new(Locations {
        runners: std::collections::BTreeMap::from([
            (
                "/project".into(),
                Arc::new(support::local(
                    &store,
                    models,
                    "/project",
                    &root,
                    Arc::new(Executor::new(replay.client())),
                    Arc::new(ClockControl::default()),
                )),
            ),
            (
                "/home-project".into(),
                Arc::new(support::local(
                    &store,
                    Arc::new(model::Resolver::new(home.clone())),
                    "/home-project",
                    &root,
                    Arc::new(Executor::new(replay.client())),
                    Arc::new(ClockControl::default()),
                )),
            ),
        ]),
        observed: Default::default(),
    });
    let execution = ycoding_core::session::execution::Execution::install(
        service.clone(),
        locations.clone(),
        ycoding_core::job::Jobs::new(),
        None,
    )
    .unwrap();
    execution
        .resume(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    assert_eq!(locations.observed.lock().unwrap().len(), 1);
    assert_eq!(
        locations.observed.lock().unwrap()[0]
            .directory
            .as_lossless()
            .as_str(),
        Some("/project")
    );
    let requests = replay.finish().await;
    assert_eq!(
        field(&parse_json(&requests[0].body).unwrap(), "model"),
        Some(&"session-location-model".encode())
    );
    assert!(!requests[0].body.contains("home-location-model"));
    assert!(!requests[0].body.contains("Other Session draft"));
    assert!(!requests[0].body.contains(r#""reasoning_effort":"high""#));
    assert_eq!(
        service
            .pending_list(&session::Id::new("ses_two").unwrap())
            .unwrap()
            .len(),
        draft.len()
    );
    assert_eq!(
        home.configured_default().unwrap().variant.as_ref().unwrap(),
        &ycoding_schema::LosslessString::from("high")
    );
    assert_eq!(
        support::requests(&store, "ses_one")[0]
            .model
            .domain()
            .unwrap()
            .variant,
        None
    );
    execution.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn test_042_unavailable_saved_selection_blocks_without_consuming_the_draft() {
    for selection in ["profile", "model", "agent"] {
        let root = Root::new("unavailable");
        let store = support::store();
        let service = Service::new(store.client());
        let credentials = credential::Service::new(store.client());
        credentials
            .create(
                "synthetic-available-id".into(),
                "openai".into(),
                Some("Work".into()),
                support::key("synthetic-key"),
                1,
            )
            .await
            .unwrap();
        let replay = Replay::start(Vec::new()).await;
        let coordinator = Coordinator::new(Arc::new(support::local(
            &store,
            Arc::new(model::Resolver::new(support::catalog(
                &replay.base,
                "model",
            ))),
            "/project",
            &root,
            Arc::new(Executor::new(replay.client())),
            Arc::new(ClockControl::default()),
        )));
        support::select(
            &service,
            "ses_one",
            Some(if selection == "profile" {
                "Unavailable"
            } else {
                "Work"
            }),
            None,
            1,
        )
        .await;
        if selection != "profile" {
            service.publish(ycoding_store::session::NewEvent {
            id: "evt_unavailable".into(), aggregate_id: "ses_one".into(), created: 12,
            type_: if selection == "model" { "session.model.selected.1" } else { "session.agent.selected.1" }.into(),
            data: if selection == "model" { parse_json(r#"{"sessionID":"ses_one","model":{"providerID":"openai","id":"missing","profile":"Work"}}"#).unwrap() } else { parse_json(r#"{"sessionID":"ses_one","agent":"missing"}"#).unwrap() },
        }).await.unwrap();
        }
        assert!(
            service
                .pending_list(&session::Id::new("ses_one").unwrap())
                .unwrap()
                .is_empty()
        );
        support::admit(&service, "ses_one", 1, "Retain this draft").await;
        assert!(
            coordinator
                .run(&session::Id::new("ses_one").unwrap())
                .await
                .is_err()
        );
        assert_eq!(
            service
                .pending_list(&session::Id::new("ses_one").unwrap())
                .unwrap()
                .len(),
            1
        );
        assert!(support::requests(&store, "ses_one").is_empty());
        assert!(replay.finish().await.is_empty());
        coordinator.shutdown().await.unwrap();
        credentials.shutdown().await.unwrap();
        store.shutdown().unwrap();
    }
}

#[test]
fn test_041_namespace_partition_round_trips_preserve_canonical_prefix_and_wire_key() {
    let permissions = ycoding_schema::permission::Ruleset::decode(
        &parse_json(r#"[{"action":"read","resource":"**","effect":"allow"}]"#).unwrap(),
    )
    .unwrap();
    let system = vec![ycoding_ai::llm::TextPart::from("Stable instructions")];
    let mut tools = vec![tool()];
    tools[0].input_schema = parse_json(r#"{"type":"object","properties":{"a\ud800":{"type":"string"},"2":{"const":2},"10":{"const":10},"pair":{"const":"\ud83d\ude80"}},"required":[]}"#).unwrap();
    prompt_cache::canonical_tools(&mut tools);
    assert_eq!(
        ycoding_schema::stringify_json(&tools[0].input_schema),
        r#"{"properties":{"2":{"const":2},"10":{"const":10},"a\ud800":{"type":"string"},"pair":{"const":"🚀"}},"required":[],"type":"object"}"#
    );
    let mut input = prompt_cache::Namespace {
        project_id: "fixture-project".into(),
        directory: "/fixture".into(),
        workspace_id: None,
        provider_id: "openai".into(),
        model_id: "gpt-5.6".into(),
        variant: None,
        account_identity_digest: Some("account-a"),
        permissions: &permissions,
        system: &system,
        tools: &tools,
    };
    let baseline = prompt_cache::namespace(&input);
    let canonical = r#"{"accountIdentityDigest":"account-a","directory":"/fixture","modelID":"gpt-5.6","namespace":"session-prompt-cache/v2","permissions":[{"action":"read","effect":"allow","resource":"**"}],"policyRevision":"provider-native/v8","projectID":"fixture-project","providerID":"openai","system":[{"text":"Stable instructions","type":"text"}],"tools":[{"description":"Lookup","inputSchema":{"properties":{"10":{"const":10},"2":{"const":2},"a\ud800":{"type":"string"},"pair":{"const":"🚀"}},"required":[],"type":"object"},"name":"lookup"}]}"#;
    assert_eq!(
        baseline,
        prompt_cache::sha256(canonical),
        "TS canonical namespace bytes/digest"
    );
    let mut distinct = BTreeSet::new();
    distinct.insert(baseline.clone());
    input.variant = Some("high".into());
    assert_eq!(
        prompt_cache::namespace(&input),
        baseline,
        "variant is not a namespace input"
    );
    input.variant = None;
    assert_eq!(prompt_cache::namespace(&input), baseline);
    input.account_identity_digest = Some("account-b");
    assert!(distinct.insert(prompt_cache::namespace(&input)));
    input.account_identity_digest = Some("account-a");
    assert_eq!(prompt_cache::namespace(&input), baseline);
    let denied = ycoding_schema::permission::Ruleset::decode(
        &parse_json(r#"[{"action":"read","resource":"**","effect":"deny"}]"#).unwrap(),
    )
    .unwrap();
    input.permissions = &denied;
    assert!(distinct.insert(prompt_cache::namespace(&input)));
    input.permissions = &permissions;
    assert_eq!(prompt_cache::namespace(&input), baseline);
    let changed = vec![ycoding_ai::llm::TextPart::from("Changed instructions")];
    input.system = &changed;
    assert!(distinct.insert(prompt_cache::namespace(&input)));
    input.system = &system;
    assert_eq!(prompt_cache::namespace(&input), baseline);
    input.tools = &[];
    assert!(distinct.insert(prompt_cache::namespace(&input)));
    input.tools = &tools;
    assert_eq!(prompt_cache::namespace(&input), baseline);
    let settings = prompt_cache::Settings {
        openai_mode: prompt_cache::OpenAIMode::Explicit,
        ..Default::default()
    };
    let options = prompt_cache::provider_options(&prompt_cache::OptionsInput {
        route_id: "openai-responses",
        api_model_id: "gpt-5.6",
        session_id: &"fixture-session".into(),
        project_id: &input.project_id,
        provider_id: &input.provider_id,
        baseline_key: &baseline,
        interactive: true,
        settings: &settings,
    });
    let mut native = ycoding_ai::route::Route::openai_responses().model("gpt-5.6");
    let mut request = Request::new(native.clone());
    request.system = system.clone();
    request.tools = tools.clone();
    request.provider_options = Some(options.provider_options.clone());
    request.messages = vec![Message::user("Suffix one")];
    let first = native.route.prepare(&request).unwrap().wire_body;
    request.messages = vec![Message::user("Suffix two")];
    let second = native.route.prepare(&request).unwrap().wire_body;
    assert_eq!(field(&first, "tools"), field(&second, "tools"));
    assert_eq!(
        field(&first, "prompt_cache_key"),
        Some(&options.wire_key.encode())
    );
    assert_eq!(
        field(&first, "prompt_cache_key"),
        field(&second, "prompt_cache_key")
    );
    request.system[0].text = "Temporary instructions".into();
    assert_ne!(native.route.prepare(&request).unwrap().wire_body, second);
    request.system = system.clone();
    assert_eq!(native.route.prepare(&request).unwrap().wire_body, second);
    native.id = "gpt-5.5".into();
    request.model = native.clone();
    assert!(
        !native
            .route
            .prepare(&request)
            .unwrap()
            .encoded_body
            .contains("prompt_cache_options")
    );
}

#[tokio::test]
async fn test_042_quota_endpoint_source_stability_absence_zero_and_privacy() {
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let account = credentials
        .create(
            "synthetic-account-id".into(),
            "openrouter".into(),
            Some("Work".into()),
            support::key("synthetic-quota-key"),
            1,
        )
        .await
        .unwrap();
    let replay = Replay::start(vec![
        Reply::json("GET", "/quota/key", 200, r#"{"data":{"usage_daily":0,"limit":null,"limit_remaining":null,"email":"synthetic@example.test","account_id":"synthetic-account-id","raw_payload":"synthetic-private"}}"#),
        Reply::json("GET", "/quota/credits", 503, r#"{"error":"synthetic-private"}"#),
        Reply::json("GET", "/quota/key", 503, r#"{"error":"synthetic-private"}"#),
    ]).await;
    let quota = ycoding_core::resources::model::quota::Service::new(
        credentials.clone(),
        ycoding_core::resources::model::quota::Endpoints(std::collections::BTreeMap::from([(
            "openrouter".into(),
            format!("{}/quota", replay.base),
        )])),
    )
    .unwrap();
    let first = quota
        .get(
            ycoding_schema::provider::Id("openrouter".into()),
            Some(account.id()),
            true,
            100,
        )
        .await;
    assert_eq!(first.status, "available".into());
    assert_eq!(
        (first.source.clone(), first.stability.clone()),
        ("provider_api".into(), "stable".into())
    );
    assert_eq!(
        (
            first.windows[0].used,
            first.windows[0].remaining,
            first.windows[0].limit
        ),
        (Some(0.0), None, None)
    );
    let before = credentials.get(account.id()).unwrap().unwrap();
    let stale = quota
        .get(
            ycoding_schema::provider::Id("openrouter".into()),
            Some(account.id()),
            true,
            100_000,
        )
        .await;
    assert_eq!(stale.status, "stale".into());
    assert_eq!(stale.windows[0].used, Some(0.0));
    assert_eq!(stale.source, first.source);
    assert_eq!(stale.stability, first.stability);
    let after = credentials.get(account.id()).unwrap().unwrap();
    assert_eq!(
        (before.generation(), before.account_generation()),
        (after.generation(), after.account_generation())
    );
    let exported = format!(
        "{}{}",
        ycoding_schema::stringify_json(&first.encode()),
        ycoding_schema::stringify_json(&stale.encode())
    );
    for prohibited in [
        "synthetic-account-id",
        "synthetic-quota-key",
        "synthetic@example.test",
        "synthetic-private",
        "account_id",
        "raw_payload",
        "authorization",
    ] {
        assert!(
            !exported.contains(prohibited),
            "quota privacy: {prohibited}"
        );
    }
    assert_eq!(replay.finish().await.len(), 3);
    quota.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn test_041_runner_instruction_tool_permission_profile_variant_away_back_and_compaction() {
    use ycoding_core::{
        session::{compaction, compaction_execution, compaction_job, compaction_policy},
        tools::registry::{DynamicTool, Options},
    };
    let root = Root::new("prefix");
    let store = support::store();
    let service = Service::new(store.client());
    let credentials = credential::Service::new(store.client());
    for (serial, profile) in ["Work", "Personal"].into_iter().enumerate() {
        credentials
            .create(
                format!("synthetic-{profile}-id").into(),
                "openai".into(),
                Some(profile.into()),
                support::key(&format!("synthetic-{profile}-key")),
                serial as i64,
            )
            .await
            .unwrap();
    }
    let replay = Replay::start(
        (0..13)
            .map(|_| Reply::stream("/v1/chat/completions", support::chat("")))
            .collect(),
    )
    .await;
    let clock = Arc::new(ClockControl::default());
    let services = support::services(
        &store,
        Arc::new(model::Resolver::new(support::catalog(
            &replay.base,
            "prefix-model",
        ))),
        "/project",
        &root,
        Arc::new(Executor::new(replay.client())),
        clock.clone(),
    );
    let registry = services.tools.clone();
    let register = || {
        registry
            .register(
                vec![(
                    "lookup".into(),
                    Arc::new(DynamicTool::new(
                        "Lookup",
                        tool().input_schema,
                        None,
                        Some("lookup".into()),
                        |input, _context| {
                            Box::pin(async move {
                                Ok(ycoding_ai::llm::ToolOutput {
                                    structured: input,
                                    content: Vec::new(),
                                })
                            })
                        },
                    )),
                )],
                Options::direct(),
            )
            .unwrap()
    };
    let mut registration = Some(register());
    let coordinator = Coordinator::new(Arc::new(ycoding_core::session::runner::Local::new(
        services,
    )));
    let id = session::Id::new("ses_one").unwrap();
    let entry = |text| {
        ycoding_schema::instruction_entry::Info::decode(
            &parse_json(&serde_json::json!({"key":"contract","value":text}).to_string()).unwrap(),
        )
        .unwrap()
    };
    service
        .put_instruction_entry(&id, entry("Stable entry"), 1)
        .await
        .unwrap();
    support::select(&service, "ses_one", Some("Work"), None, 1).await;
    for phase in 0..11 {
        match phase {
            1 => drop(registration.take()),
            2 => registration = Some(register()),
            3 => service
                .put_instruction_entry(&id, entry("Changed entry"), 3)
                .await
                .unwrap(),
            4 => service
                .put_instruction_entry(&id, entry("Stable entry"), 4)
                .await
                .unwrap(),
            5 | 6 => {
                let permission = if phase == 5 {
                    Some(
                        ycoding_store::session::Document::new(
                            parse_json(r#"[{"action":"lookup","resource":"**","effect":"deny"}]"#)
                                .unwrap(),
                        )
                        .unwrap(),
                    )
                } else {
                    None
                };
                store
                    .submit(move |tx| {
                        let key = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
                            &"ses_one".into(),
                        )]);
                        let mut row = tx
                            .get::<ycoding_store::session::SessionTable>(&key)?
                            .unwrap();
                        row.permission = permission;
                        ycoding_store::session::SessionTable::put(tx, &row)
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
            }
            7 => support::select(&service, "ses_one", Some("Personal"), None, 7).await,
            8 => support::select(&service, "ses_one", Some("Work"), None, 8).await,
            9 => support::select(&service, "ses_one", Some("Work"), Some("high"), 9).await,
            10 => support::select(&service, "ses_one", Some("Work"), None, 10).await,
            _ => {}
        }
        support::admit(
            &service,
            "ses_one",
            phase,
            &format!("Draft {phase}: {}", "synthetic context ".repeat(400)),
        )
        .await;
        coordinator.run(&id).await.unwrap();
    }
    let before = support::requests(&store, "ses_one");
    for restored in [2, 4, 6, 8, 9, 10] {
        assert_eq!(
            before[restored].prompt_cache_key, before[0].prompt_cache_key,
            "partition {restored}: gratuitous namespace rotation"
        );
    }
    assert_ne!(
        before[9].model, before[8].model,
        "variant selection is recorded without rotating the cache key"
    );
    for changed in [1, 5, 7] {
        assert_ne!(
            before[changed].prompt_cache_key, before[0].prompt_cache_key,
            "partition {changed}: namespace not isolated"
        );
    }
    let history = service.model_history(&id).unwrap();
    let boundary = history.last().unwrap();
    let policy = compaction_policy::Resolved {
        keep_recent_messages: 0,
        ..Default::default()
    };
    clock.advance(1000);
    let job = service
        .compaction_admit(
            compaction_job::AdmitInput {
                id: None,
                session: id.clone(),
                trigger: ycoding_schema::session_compaction::Trigger::Mandatory,
                requested_through_message: ycoding_schema::session_message::Id::decode(
                    field(&boundary.message.encode(), "id").unwrap(),
                )
                .unwrap(),
                requested_through_seq: boundary.seq,
                base_context_revision: service
                    .continuation_authority(&id)
                    .await
                    .unwrap()
                    .context_revision,
                target_max_input_tokens: 32_000,
                config_digest: compaction_policy::admission_digest(&policy),
                pressure: None,
            },
            ycoding_core::session::runner::Clock::now(clock.as_ref()),
        )
        .await
        .unwrap();
    let builder = |job: ycoding_store::session::Job| -> compaction_execution::ManifestFuture<'_> {
        let service = &service;
        let policy = &policy;
        Box::pin(async move {
            compaction::manifest(compaction::Input {
                store: service,
                job: &job,
                policy,
                helper_context_window: None,
                generate: None,
                live_state: &|_| Ok(compaction::LiveState::default()),
            })
            .await
        })
    };
    let settled = compaction_execution::run(
        &service,
        clock.as_ref(),
        &ycoding_schema::session_compaction::Id::decode(&job.id.encode()).unwrap(),
        &builder,
    )
    .await
    .unwrap();
    assert_eq!(settled.status.as_str(), Some("ended"));
    support::admit(&service, "ses_one", 11, "Post compaction").await;
    coordinator.run(&id).await.unwrap();
    support::admit(&service, "ses_one", 12, "After the reset").await;
    coordinator.run(&id).await.unwrap();
    let actual = replay.finish().await;
    let after = support::requests(&store, "ses_one");
    assert_eq!(after.len(), 13);
    let body = |index: usize| parse_json(&actual[index].body).unwrap();
    for restored in [2, 4, 6, 8, 9, 10] {
        assert_eq!(field(&body(restored), "tools"), field(&body(0), "tools"));
        assert_eq!(
            field(&body(restored), "prompt_cache_key"),
            field(&body(0), "prompt_cache_key")
        );
    }
    assert!(actual[3].body.contains("Changed entry"));
    assert!(actual[4].body.contains("Stable entry"));
    assert!(matches!(
        service
            .model_history(&id)
            .unwrap()
            .first()
            .map(|entry| &entry.message),
        Some(ycoding_schema::session_message::Info::Synthetic(_))
    ));
    let JsonValue::Array(previous_messages) = field(&body(10), "messages").unwrap().clone() else {
        panic!("missing Chat messages")
    };
    let JsonValue::Array(compacted_messages) = field(&body(11), "messages").unwrap().clone() else {
        panic!("missing Chat messages")
    };
    assert!(
        compacted_messages.len() < previous_messages.len(),
        "uncompacted conversation replayed"
    );
    assert!(
        !compacted_messages
            .iter()
            .any(|message| field(message, "content")
                == Some(&format!("Draft 0: {}", "synthetic context ".repeat(400)).encode())),
        "original message below checkpoint replayed"
    );
    assert!(actual[11].body.contains("Post compaction"));
    let previous = after.last().unwrap();
    let begin = ycoding_core::session::provider_request::Begin {
        session: id.clone(),
        model: previous.model.domain().unwrap(),
        route_id: previous.route_id.to_utf8().unwrap(),
        connection_identity_digest: previous
            .connection_identity_digest
            .as_ref()
            .map(|value| value.to_utf8().unwrap()),
        prompt_cache_key: previous.prompt_cache_key.to_utf8().unwrap(),
        system_digest: previous.system_digest.to_utf8().unwrap(),
        tool_digest: previous.tool_digest.to_utf8().unwrap(),
    };
    let ended = previous.time_created;
    let completed = settled.clone();
    store
        .submit(move |tx| {
            for index in 0..129 {
                ycoding_store::session::JobTable::insert(
                    tx,
                    &ycoding_store::session::Job {
                        id: format!("cmp_history_{index:03}").into(),
                        time_ended: Some(ended),
                        ..completed.clone()
                    },
                )?;
            }
            ycoding_store::session::JobTable::insert(
                tx,
                &ycoding_store::session::Job {
                    id: "cmp_other_session".into(),
                    session_id: "ses_two".into(),
                    time_ended: Some(ended + 1),
                    ..completed.clone()
                },
            )?;
            for status in ["pending", "running", "failed"] {
                ycoding_store::session::JobTable::insert(
                    tx,
                    &ycoding_store::session::Job {
                        id: format!("cmp_{status}").into(),
                        status: status.into(),
                        manifest_digest: None,
                        lease_owner: (status == "running").then(|| "fixture-owner".into()),
                        lease_expires_at: (status == "running").then_some(ended + 30_000),
                        time_started: (status != "pending").then_some(ended),
                        time_ended: (status == "failed").then_some(ended + 1),
                        error_code: (status == "failed").then(|| "cancelled".into()),
                        ..completed.clone()
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        service
            .begin_provider_request(&begin)
            .await
            .unwrap()
            .default_invalidation,
        "provider-not-reported"
    );
    let mut first = begin.clone();
    first.session = session::Id::new("ses_two").unwrap();
    assert_eq!(
        service
            .begin_provider_request(&first)
            .await
            .unwrap()
            .default_invalidation,
        "first-request"
    );
    let mut newest = settled;
    newest.id = "cmp_zz_newer".into();
    newest.time_ended = Some(ended + 1);
    store
        .submit(move |tx| ycoding_store::session::JobTable::insert(tx, &newest))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        service
            .begin_provider_request(&begin)
            .await
            .unwrap()
            .default_invalidation,
        "compaction-reset"
    );
    drop(registration);
    coordinator.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
    assert_eq!(after[11].invalidation.as_str(), Some("compaction-reset"));
    assert_eq!(
        after[12].invalidation.as_str(),
        Some("provider-not-reported")
    );
}

#[tokio::test]
async fn test_039_040_hosted_tool_runner_replays_natively_without_local_dispatch() {
    let root = Root::new("hosted");
    let store = support::store();
    let service = Service::new(store.client());
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "synthetic-hosted-id".into(),
            "openai".into(),
            Some("Work".into()),
            support::key("synthetic-key"),
            1,
        )
        .await
        .unwrap();
    let hosted = concat!(
        "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"web_search_call\",\"id\":\"hosted_call\",\"status\":\"in_progress\"}}\n\n",
        "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"web_search_call\",\"id\":\"hosted_call\",\"status\":\"completed\",\"action\":{\"type\":\"search\",\"query\":\"synthetic\"}}}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg\",\"delta\":\"answer\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"hosted_response\",\"status\":\"completed\",\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}}\n\n",
    );
    let replay = Replay::start(vec![Reply::stream("/v1/responses", hosted), Reply::stream("/v1/responses", "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg2\",\"delta\":\"next\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"hosted_next\",\"status\":\"completed\"}}\n\n")]).await;
    let mut catalog = support::catalog(&replay.base, "gpt-5.6");
    catalog
        .configure(&[parse_json(
            r#"{"providers":{"openai":{"package":"@ycoding-ai/ai/providers/openai/responses"}}}"#,
        )
        .unwrap()])
        .unwrap();
    let services = support::services(
        &store,
        Arc::new(model::Resolver::new(catalog)),
        "/project",
        &root,
        Arc::new(Executor::new(replay.client())),
        Arc::new(ClockControl::default()),
    );
    let tool = Arc::new(HostedTool(std::sync::atomic::AtomicUsize::new(0)));
    let registration = services
        .tools
        .register(
            vec![("web_search".into(), tool.clone())],
            ycoding_core::tools::registry::Options::direct(),
        )
        .unwrap();
    let coordinator = Coordinator::new(Arc::new(ycoding_core::session::runner::Local::new(
        services,
    )));
    let id = session::Id::new("ses_one").unwrap();
    support::select(&service, "ses_one", Some("Work"), None, 1).await;
    support::admit(&service, "ses_one", 1, "Use hosted search").await;
    coordinator.run(&id).await.unwrap();
    support::admit(&service, "ses_one", 2, "Continue").await;
    coordinator.run(&id).await.unwrap();
    let captured = replay.finish().await;
    assert_eq!(captured.len(), 2);
    assert!(captured[0].body.contains(r#""type":"web_search""#));
    assert!(!captured[0].body.contains(r#""type":"function""#));
    assert_eq!(
        field(
            &parse_json(&captured[1].body).unwrap(),
            "previous_response_id"
        ),
        Some(&"hosted_response".encode())
    );
    assert_eq!(
        tool.0.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "provider-executed call dispatched locally"
    );
    let transcript = ycoding_schema::stringify_json(&JsonValue::Array(
        service
            .context(&id)
            .unwrap()
            .iter()
            .map(DomainEncode::encode)
            .collect(),
    ));
    assert!(transcript.contains(r#""executed":true"#));
    assert!(transcript.contains("hosted_call"));
    let requests = support::requests(&store, "ses_one");
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|request| request.attempts == 1));
    assert_eq!(requests[1].continuation.as_str(), Some("continued"));
    drop(registration);
    coordinator.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}
