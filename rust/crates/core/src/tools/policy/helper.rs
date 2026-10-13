use crate::{
    regexp::{Budget, RegExp},
    resources::config::Configuration,
};
use std::collections::BTreeMap;
use ycoding_schema::{DecodeError, DomainDecode, JsonValue, LosslessString, ObjectEncoder, model};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Role {
    Title,
    Goal,
    Decision,
    Compaction,
    Prediction,
    Prompt,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum CompactionScope {
    Main,
    Subagent,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TitleMode {
    Local,
    Model,
    Off,
}
#[derive(Clone, Debug, PartialEq)]
pub enum ModelSelection {
    Session,
    Model(model::Ref),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub title_mode: TitleMode,
    pub models: BTreeMap<Role, ModelSelection>,
    pub compaction_scopes: BTreeMap<CompactionScope, ModelSelection>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            title_mode: TitleMode::Local,
            models: BTreeMap::new(),
            compaction_scopes: BTreeMap::new(),
        }
    }
}

impl Settings {
    pub fn from_configuration(config: &Configuration) -> Result<Self, DecodeError> {
        let Some(JsonValue::Object(efficiency)) = config.latest("efficiency") else {
            return Ok(Self::default());
        };
        let title_mode = match efficiency.get(&"title".into()) {
            Some(JsonValue::String(value)) if value.as_str() == Some("model") => TitleMode::Model,
            Some(JsonValue::String(value)) if value.as_str() == Some("off") => TitleMode::Off,
            _ => TitleMode::Local,
        };
        let Some(JsonValue::Object(helpers)) = efficiency.get(&"helper_models".into()) else {
            return Ok(Self {
                title_mode,
                ..Self::default()
            });
        };
        let models = [
            (Role::Title, "title"),
            (Role::Goal, "goal"),
            (Role::Decision, "decision"),
            (Role::Prediction, "prediction"),
            (Role::Prompt, "prompt"),
        ]
        .into_iter()
        .filter_map(|(role, key)| {
            helpers
                .get(&key.into())
                .map(|value| selection(value).map(|selection| (role, selection)))
        })
        .collect::<Result<_, _>>()?;
        let compaction_scopes =
            if let Some(JsonValue::Object(scopes)) = helpers.get(&"compaction".into()) {
                [
                    (CompactionScope::Main, "main"),
                    (CompactionScope::Subagent, "subagent"),
                ]
                .into_iter()
                .filter_map(|(scope, key)| {
                    scopes
                        .get(&key.into())
                        .map(|value| selection(value).map(|selection| (scope, selection)))
                })
                .collect::<Result<_, _>>()?
            } else {
                BTreeMap::new()
            };
        Ok(Self {
            title_mode,
            models,
            compaction_scopes,
        })
    }
    pub fn select<'a>(
        &'a self,
        role: Role,
        scope: CompactionScope,
        agent: Option<&'a model::Ref>,
        session: Option<&'a model::Ref>,
    ) -> Option<&'a model::Ref> {
        if role == Role::Compaction {
            if let Some(ModelSelection::Model(selected)) = self.compaction_scopes.get(&scope) {
                return Some(selected);
            }
            return agent.or(session);
        }
        select_helper_model(agent, self.models.get(&role), session)
    }
    pub fn resolve<T, E>(
        &self,
        role: Role,
        scope: CompactionScope,
        agent: Option<&model::Ref>,
        session: Option<&model::Ref>,
        resolve: impl FnOnce(Option<&model::Ref>) -> Result<T, E>,
    ) -> Option<T> {
        resolve(self.select(role, scope, agent, session)).ok()
    }
}

fn selection(value: &JsonValue) -> Result<ModelSelection, DecodeError> {
    if value == &JsonValue::String("session".into()) {
        return Ok(ModelSelection::Session);
    }
    let path = ycoding_schema::JsonPath::default();
    let object = ycoding_schema::ObjectDecoder::new(value, &path)?;
    let reference = ObjectEncoder::new()
        .field("providerID", &object.field::<LosslessString>("providerID")?)
        .field("id", &object.field::<LosslessString>("model")?)
        .optional("variant", &object.optional::<LosslessString>("variant")?)
        .optional("profile", &object.optional::<LosslessString>("profile")?)
        .finish();
    model::Ref::decode(&reference).map(ModelSelection::Model)
}

pub fn select_helper_model<'a>(
    agent: Option<&'a model::Ref>,
    role: Option<&'a ModelSelection>,
    session: Option<&'a model::Ref>,
) -> Option<&'a model::Ref> {
    agent
        .or(match role {
            Some(ModelSelection::Model(reference)) => Some(reference),
            _ => session,
        })
        .or(session)
}

pub fn local_title(input: &LosslessString) -> LosslessString {
    let mut units = input.code_units().collect::<Vec<_>>();
    for (pattern, replacement) in [
        (r"\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)", ""),
        (r"(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]", ""),
        (
            r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]",
            " ",
        ),
    ] {
        units = RegExp::new(&pattern.encode_utf16().collect::<Vec<_>>(), "g")
            .expect("static helper pattern")
            .replace(
                &units,
                &replacement.encode_utf16().collect::<Vec<_>>(),
                &mut Budget::unlimited(),
            )
            .expect("unlimited static helper pattern");
    }
    let collapse = |input: &[u16]| {
        let mut output = vec![];
        for unit in input {
            if crate::process::guardrails::is_whitespace(*unit) {
                if !output.is_empty() && output.last() != Some(&32) {
                    output.push(32);
                }
                continue;
            }
            output.push(*unit);
        }
        if output.last() == Some(&32) {
            output.pop();
        }
        output
    };
    let first = units
        .split(|unit| *unit == 10)
        .map(collapse)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    let normalized = RegExp::new(
        &r"^(?:(?:#{1,6}|>|[-*+])\s+|\d+[.)]\s+)"
            .encode_utf16()
            .collect::<Vec<_>>(),
        "",
    )
    .expect("static helper pattern")
    .replace(&first, &[], &mut Budget::unlimited())
    .expect("unlimited static helper pattern");
    let normalized = collapse(&normalized);
    if normalized.is_empty() {
        return "New session".into();
    }
    let mut characters = vec![];
    let mut index = 0;
    while index < normalized.len() {
        let length = if (0xd800..=0xdbff).contains(&normalized[index])
            && normalized
                .get(index + 1)
                .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
        {
            2
        } else {
            1
        };
        characters.push(&normalized[index..index + length]);
        index += length;
    }
    if characters.len() <= 50 {
        return LosslessString::from_utf16(normalized);
    }
    LosslessString::from_utf16(
        characters[..47]
            .iter()
            .flat_map(|part| part.iter().copied())
            .chain([46, 46, 46])
            .collect(),
    )
}

#[derive(Clone)]
pub struct Resolved {
    pub model: ycoding_ai::llm::Model,
    pub selection: model::Ref,
    pub info: model::Info,
    pub account_identity: Option<String>,
}

pub struct Models {
    pub models: std::sync::Arc<crate::resources::model::Resolver>,
    pub credentials: crate::resources::credential::Service,
    pub auth: crate::resources::auth::Preparation,
    pub cursor: Option<crate::resources::cursor::route::Host>,
    pub claude: Option<crate::resources::model::ClaudeHost>,
    pub store: crate::session::store::Service,
    pub settings: Settings,
}

impl Models {
    pub async fn role(
        &self,
        session: &ycoding_schema::session::Info,
        role: Role,
        agent: &ycoding_schema::agent::Info,
    ) -> Result<Resolved, String> {
        let saved = self.credentials.all().map_err(|error| error.to_string())?;
        let selected = self
            .settings
            .select(
                role,
                if session.parent_id.is_some() {
                    CompactionScope::Subagent
                } else {
                    CompactionScope::Main
                },
                agent.model.as_ref(),
                session.model.as_ref(),
            )
            .cloned()
            .or_else(|| self.models.catalog().default_selection(&saved))
            .ok_or_else(|| "No helper model is available".to_owned())?;
        self.resolve(session, &selected).await
    }
    pub async fn resolve(
        &self,
        session: &ycoding_schema::session::Info,
        selected: &model::Ref,
    ) -> Result<Resolved, String> {
        self.resolve_optional(Some(session), selected).await
    }
    pub async fn resolve_optional(
        &self,
        session: Option<&ycoding_schema::session::Info>,
        selected: &model::Ref,
    ) -> Result<Resolved, String> {
        let saved = self.credentials.all().map_err(|error| error.to_string())?;
        let catalog = self.models.catalog();
        let provider = catalog
            .provider(&selected.provider_id)
            .ok_or_else(|| "Selected provider is unavailable".to_owned())?;
        let integration = provider
            .integration_id
            .as_ref()
            .map(|id| id.as_lossless())
            .unwrap_or(&provider.id.0);
        let saved_binding = session
            .map(|session| self.store.profile_binding(&session.id))
            .transpose()
            .map_err(|error| error.to_string())?
            .flatten();
        let binding = selected
            .profile
            .as_ref()
            .map(|profile| {
                if let Some(binding) = saved_binding.as_ref().filter(|binding| {
                    binding.provider_id == selected.provider_id && binding.profile == *profile
                }) {
                    return Ok(crate::resources::credential::Binding::from_domain(
                        binding.clone(),
                    ));
                }
                self.credentials.bind(
                    selected.provider_id.0.clone(),
                    integration.clone(),
                    profile.0.clone(),
                )
            })
            .transpose()
            .map_err(|_| "Selected profile is unavailable; select the profile again".to_owned())?;
        let connection = match (&binding, &selected.profile) {
            (Some(binding), Some(profile)) => Some(
                self.credentials
                    .resolve_selection(&selected.provider_id.0, integration, &profile.0, binding)
                    .map_err(|_| {
                        "Selected profile is unavailable; select the profile again".to_owned()
                    })?,
            ),
            _ => self
                .credentials
                .active(integration)
                .map_err(|error| error.to_string())?,
        };
        let resolved = self
            .models
            .resolve(selected, &saved, connection.as_ref())
            .map_err(|error| error.to_string())?;
        let account_identity = if let Some(connection) = &connection {
            Some(
                crate::resources::model::account_identity(connection)
                    .to_utf8()
                    .unwrap_or_default(),
            )
        } else {
            resolved.info.settings.as_ref().and_then(|settings| {
                settings
                    .0
                    .get(&"apiKey".into())
                    .filter(|value| matches!(value, JsonValue::String(value) if !value.is_empty()))
                    .map(|key| {
                        crate::session::prompt_cache::sha256(&ycoding_schema::stringify_json(
                            &ObjectEncoder::new()
                                .field("namespace", "captured-auth/v1")
                                .field("providerID", &resolved.info.provider_id)
                                .field("integrationID", integration)
                                .field(
                                    "material",
                                    &ObjectEncoder::new()
                                        .field("type", "key")
                                        .field("value", key)
                                        .finish(),
                                )
                                .optional(
                                    "organization",
                                    &settings.0.get(&"organization".into()).cloned(),
                                )
                                .optional("project", &settings.0.get(&"project".into()).cloned())
                                .finish(),
                        ))
                    })
            })
        };
        let secret = match &connection {
            Some(connection) => Some(
                self.auth
                    .prepare_value(
                        &self.credentials,
                        connection.clone(),
                        chrono::Utc::now().timestamp_millis(),
                        self.claude.as_ref().map(|host| &host.accounts),
                    )
                    .await
                    .map_err(|error| format!("{error:?}"))?
                    .domain()
                    .map_err(|error| error.to_string())?,
            ),
            None => None,
        };
        let model = if resolved.info.provider_id.0.as_str() == Some("muse") {
            crate::resources::muse::from_catalog_model(
                &resolved.info,
                secret.as_ref(),
                connection.as_ref(),
                ycoding_ai::muse::Runtime::shared().map_err(|error| error.to_string())?,
            )
        } else {
            match (
                &self.cursor,
                resolved
                    .info
                    .package
                    .as_ref()
                    .and_then(|package| package.as_str()),
            ) {
                (Some(host), Some("aisdk:cursor-opencode-provider")) => {
                    crate::resources::cursor::route::model(&resolved.info, secret.as_ref(), host)
                }
                _ => crate::resources::model::from_catalog_model_with_claude(
                    &resolved.info,
                    secret.as_ref(),
                    connection.as_ref(),
                    self.claude.as_ref(),
                ),
            }
        }
        .map_err(|error| error.to_string())?;
        Ok(Resolved {
            model,
            info: resolved.info,
            selection: selected.clone(),
            account_identity,
        })
    }
}

pub fn request(
    session: &ycoding_schema::session::Info,
    resolved: &Resolved,
    permissions: &[ycoding_schema::permission::Rule],
    system: Vec<ycoding_ai::llm::TextPart>,
    messages: Vec<ycoding_ai::llm::Message>,
) -> ycoding_ai::llm::Request {
    let mut request = ycoding_ai::llm::Request::new(resolved.model.clone());
    request.system = system;
    request.messages = messages;
    let affinity = resolved.account_identity.as_ref().map_or_else(
        || session.id.as_lossless().to_utf8().unwrap_or_default(),
        |identity| {
            crate::session::prompt_cache::sha256(&ycoding_schema::stringify_json(
                &JsonValue::Array(vec![
                    ycoding_schema::DomainEncode::encode(&session.id),
                    JsonValue::String(identity.as_str().into()),
                ]),
            ))
        },
    );
    request.http.headers = std::collections::BTreeMap::from([
        ("x-session-affinity".into(), affinity.clone()),
        ("X-Session-Id".into(), affinity),
        (
            "x-ycoding-project".into(),
            session
                .project_id
                .as_lossless()
                .to_utf8()
                .unwrap_or_default(),
        ),
        (
            "x-ycoding-session".into(),
            session.id.as_lossless().to_utf8().unwrap_or_default(),
        ),
        ("x-ycoding-client".into(), "cli".into()),
    ]);
    let namespace =
        crate::session::prompt_cache::namespace(&crate::session::prompt_cache::Namespace {
            project_id: session.project_id.as_lossless().clone(),
            directory: session.location.directory.as_lossless().clone(),
            workspace_id: session
                .location
                .workspace_id
                .as_ref()
                .map(|id| id.as_lossless().clone()),
            provider_id: resolved.selection.provider_id.0.clone(),
            model_id: resolved.selection.id.clone(),
            variant: resolved.selection.variant.clone(),
            account_identity_digest: resolved.account_identity.as_deref(),
            permissions,
            system: &request.system,
            tools: &request.tools,
        });
    let cache = crate::session::prompt_cache::provider_options(
        &crate::session::prompt_cache::OptionsInput {
            route_id: &request.model.route.id,
            api_model_id: request.model.id.as_str().unwrap_or_default(),
            session_id: session.id.as_lossless(),
            project_id: session.project_id.as_lossless(),
            provider_id: &resolved.selection.provider_id.0,
            baseline_key: &namespace,
            interactive: false,
        },
    );
    request.provider_options = Some(cache.provider_options);
    if let Some(cache) = cache.cache {
        request.cache = cache;
    }
    request
}

pub struct StreamInput<'a> {
    pub session: &'a ycoding_schema::session::Info,
    pub resolved: &'a Resolved,
    pub agent: &'a ycoding_schema::agent::Info,
    pub source: &'a str,
    pub input_id: Option<&'a ycoding_schema::session_message::Id>,
    pub request: ycoding_ai::llm::Request,
    pub cancellation: &'a crate::tools::code_mode::Cancellation,
    pub byte_limit: Option<usize>,
    pub require_stop: bool,
}
pub struct Streamed {
    pub text: LosslessString,
    pub tokens: Option<JsonValue>,
    pub failed: bool,
    pub finished: bool,
    pub cancelled: bool,
    pub too_large: bool,
}
static HELPER_LEDGER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub async fn stream(
    store: &crate::session::store::Service,
    executor: &ycoding_ai::route::Executor,
    mut input: StreamInput<'_>,
) -> Result<Streamed, String> {
    use crate::session::{cache_diagnostics, prompt_cache, provider_request, usage};
    use ycoding_ai::llm;
    let request_id = provider_request::new_id().map_err(|error| error.to_string())?;
    input.request.id = Some(request_id.as_lossless().clone());
    let begin = provider_request::Begin {
        session: input.session.id.clone(),
        model: input.resolved.selection.clone(),
        route_id: input.request.model.route.id.clone(),
        connection_identity_digest: input.resolved.account_identity.clone(),
        prompt_cache_key: prompt_cache::namespace(&prompt_cache::Namespace {
            project_id: input.session.project_id.as_lossless().clone(),
            directory: input.session.location.directory.as_lossless().clone(),
            workspace_id: input
                .session
                .location
                .workspace_id
                .as_ref()
                .map(|id| id.as_lossless().clone()),
            provider_id: input.resolved.selection.provider_id.0.clone(),
            model_id: input.resolved.selection.id.clone(),
            variant: input.resolved.selection.variant.clone(),
            account_identity_digest: input.resolved.account_identity.as_deref(),
            permissions: &input.agent.permissions,
            system: &input.request.system,
            tools: &input.request.tools,
        }),
        system_digest: prompt_cache::system_digest(&input.request.system),
        tool_digest: prompt_cache::tool_digest(&input.request.tools),
    };
    let mut result = Streamed {
        text: "".into(),
        tokens: None,
        failed: false,
        finished: false,
        cancelled: false,
        too_large: false,
    };
    let mut units = Vec::new();
    let mut bytes = 0;
    let mut totals = [0.0; 5];
    let mut cost = None;
    let mut timing = None;
    let mut cache_read_reported = false;
    let opened = tokio::select! {biased; _ = input.cancellation.cancelled() => {result.cancelled = true; None}, opened = executor.stream(&input.request) => Some(opened)};
    match opened {
        None => {}
        Some(Err(_)) => result.failed = true,
        Some(Ok(mut response)) => loop {
            let next = tokio::select! {biased; _ = input.cancellation.cancelled() => {result.cancelled = true; break;}, next = response.next() => next};
            match next {
                Ok(Some(llm::Event::TextDelta(delta))) => {
                    bytes += delta.text.to_utf8().unwrap_or_default().len();
                    if input.byte_limit.is_some_and(|limit| bytes > limit) {
                        result.too_large = true;
                        break;
                    }
                    units.extend(delta.text.code_units());
                }
                Ok(Some(llm::Event::ProviderError { .. } | llm::Event::ToolCall(_))) => {
                    result.failed = true
                }
                Ok(Some(llm::Event::Finish(finish))) => {
                    result.finished = true;
                    if input.require_stop && finish.reason != llm::FinishReason::Stop {
                        result.failed = true;
                    }
                }
                Ok(Some(llm::Event::StepFinish { finish, .. })) => {
                    if finish.usage.is_some() || input.source == "title" {
                        let reported = finish.usage.as_ref();
                        let normalized = usage::tokens(reported);
                        let decoded = ycoding_schema::token_usage::Info::decode(&normalized)
                            .map_err(|error| error.to_string())?;
                        for (total, value) in totals.iter_mut().zip([
                            decoded.input.get(),
                            decoded.output.get(),
                            decoded.reasoning.get(),
                            decoded.cache.read.get(),
                            decoded.cache.write.get(),
                        ]) {
                            *total += value;
                        }
                        result.tokens = Some(
                            ObjectEncoder::new()
                                .field("input", &totals[0])
                                .field("output", &totals[1])
                                .field("reasoning", &totals[2])
                                .field(
                                    "cache",
                                    &ObjectEncoder::new()
                                        .field("read", &totals[3])
                                        .field("write", &totals[4])
                                        .finish(),
                                )
                                .finish(),
                        );
                        if let Some(priced) = usage::estimated_cost(
                            &input.resolved.info.cost,
                            &normalized,
                            usage::one_hour_cache_writes(reported),
                        )
                        .filter(|priced| input.source != "title" || *priced != 0.0)
                        {
                            cost = Some(cost.unwrap_or(0.0) + priced);
                        }
                        timing = usage::timing(reported);
                        cache_read_reported |= cache_diagnostics::reported(
                            &input.request.model.route.id,
                            input
                                .resolved
                                .selection
                                .provider_id
                                .0
                                .as_str()
                                .unwrap_or_default(),
                            reported,
                        )
                        .read;
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {
                    result.failed = true;
                    break;
                }
            }
        },
    }
    result.text = LosslessString::from_utf16(units);
    let _ledger = HELPER_LEDGER.lock().await;
    let pending = store
        .begin_provider_request_with_id(&begin, request_id)
        .map_err(|error| error.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    if let Some(tokens) = &result.tokens {
        publish(
            store,
            &input.session.id,
            "session.usage.recorded.1",
            ObjectEncoder::new()
                .field("sessionID", &input.session.id)
                .field("source", input.source)
                .field("cost", &cost.unwrap_or(0.0))
                .field("tokens", tokens)
                .finish(),
            now,
        )
        .await?;
    }
    let tokens = result.tokens.clone().unwrap_or_else(|| usage::tokens(None));
    let fields = provider_request::recorded_fields(
        &begin,
        &pending,
        &provider_request::Completion {
            source: input.source,
            agent: &input.agent.id,
            invalidation: if totals[3] > 0.0 {
                "stable-hit"
            } else {
                pending.default_invalidation
            },
            continuation: "full",
            attempts: 1,
            cache_read_reported: (input.source != "title").then_some(cache_read_reported),
            timing,
            cost,
            tokens: &tokens,
            time: now,
        },
    )
    .map_err(|error| error.to_string())?;
    let JsonValue::Object(mut fields) = fields else {
        unreachable!()
    };
    fields.insert(
        "sessionID".into(),
        ycoding_schema::DomainEncode::encode(&input.session.id),
    );
    if let Some(id) = input.input_id {
        fields.insert("inputID".into(), ycoding_schema::DomainEncode::encode(id));
    }
    publish(
        store,
        &input.session.id,
        "session.provider.request.recorded.1",
        JsonValue::Object(fields),
        now,
    )
    .await?;
    Ok(result)
}
pub async fn publish(
    store: &crate::session::store::Service,
    session: &ycoding_schema::session::Id,
    name: &str,
    data: JsonValue,
    now: i64,
) -> Result<(), String> {
    store
        .publish(ycoding_store::session::NewEvent {
            id: crate::session::projector::random_event_id()
                .map_err(|error| error.to_string())?
                .as_lossless()
                .clone(),
            aggregate_id: session.as_lossless().clone(),
            created: now,
            type_: name.into(),
            data,
        })
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}
