use super::{Local, compaction::Helper, publish};
use crate::{
    session::{
        cache_diagnostics,
        helper_generation::{Generate, Generation, Request, units},
        prompt_cache, provider_request, usage,
    },
    tools::{code_mode::Cancellation, policy::helper::CompactionScope},
};
use std::collections::BTreeMap;
use ycoding_ai::llm;
use ycoding_schema::{DomainEncode, JsonValue, permission, session};

static LEDGER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(super) struct StreamInput<'a> {
    pub helper: &'a Helper,
    pub session: &'a session::Id,
    pub source: &'static str,
    pub agent: &'a ycoding_schema::agent::Id,
    pub permissions: &'a [permission::Rule],
    pub system: &'a str,
    pub prompt: String,
    pub cancellation: Option<&'a Cancellation>,
    pub character_limit: Option<usize>,
    pub require_stop: bool,
}

pub(super) struct Streamed {
    pub text: String,
    pub failed: bool,
    pub settled: bool,
    pub cancelled: bool,
}

impl Local {
    pub(super) async fn stream_helper(&self, input: StreamInput<'_>) -> Option<Streamed> {
        let services = &self.0.services;
        let helper = input.helper;
        let session = input.session;
        let info = services.store.get(session).ok()??;
        let mut request = llm::Request::new(helper.model.clone());
        let request_id = provider_request::new_id().ok()?;
        request.id = Some(request_id.as_lossless().clone());
        request.http.headers = cursor_session_headers(
            session,
            &info.project_id,
            info.parent_id.as_ref(),
            helper.account_identity.as_deref(),
        );
        request.system = vec![input.system.into()];
        request.messages = vec![llm::Message::user(input.prompt)];
        request.generation.max_tokens = request.model.defaults.output_limit;
        let provider = request.model.provider.0.clone();
        let begin = provider_request::Begin {
            session: session.clone(),
            model: helper.selection.clone(),
            route_id: request.model.route.id.clone(),
            connection_identity_digest: helper.account_identity.clone(),
            prompt_cache_key: prompt_cache::namespace(&prompt_cache::Namespace {
                project_id: info.project_id.as_lossless().clone(),
                directory: info.location.directory.as_lossless().clone(),
                workspace_id: info
                    .location
                    .workspace_id
                    .as_ref()
                    .map(|id| id.as_lossless().clone()),
                provider_id: provider.clone(),
                model_id: helper.selection.id.clone(),
                variant: helper.selection.variant.clone(),
                account_identity_digest: helper.account_identity.as_deref(),
                permissions: input.permissions,
                system: &request.system,
                tools: &request.tools,
            }),
            system_digest: prompt_cache::system_digest(&request.system),
            tool_digest: prompt_cache::tool_digest(&request.tools),
        };
        let cache = prompt_cache::provider_options(&prompt_cache::OptionsInput {
            route_id: &request.model.route.id,
            api_model_id: request.model.id.as_str().unwrap_or_default(),
            session_id: session.as_lossless(),
            project_id: info.project_id.as_lossless(),
            provider_id: &provider,
            baseline_key: &begin.prompt_cache_key,
            interactive: false,
        });
        request.provider_options = Some(cache.provider_options);
        if let Some(policy) = cache.cache {
            request.cache = policy;
        }
        let mut streamed = Streamed {
            text: String::new(),
            failed: false,
            settled: false,
            cancelled: false,
        };
        let mut length = 0;
        let mut finish = None;
        let opened = match input.cancellation {
            Some(cancellation) => tokio::select! {
                biased;
                _ = cancellation.cancelled() => None,
                opened = services.executor.stream(&request) => Some(opened),
            },
            None => Some(services.executor.stream(&request).await),
        };
        match opened {
            None => streamed.cancelled = true,
            Some(Err(_)) => streamed.failed = true,
            Some(Ok(mut stream)) => loop {
                let next = match input.cancellation {
                    Some(cancellation) => tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => {
                            streamed.cancelled = true;
                            break;
                        }
                        next = stream.next() => next,
                    },
                    None => stream.next().await,
                };
                match next {
                    Ok(Some(llm::Event::TextDelta(delta))) => {
                        let text = delta.text.to_utf8().unwrap_or_default();
                        length += units(&text).len();
                        if input.character_limit.is_some_and(|limit| length > limit) {
                            streamed.failed = true;
                        }
                        if !streamed.failed {
                            streamed.text.push_str(&text);
                        }
                    }
                    Ok(Some(llm::Event::ProviderError { .. })) => streamed.failed = true,
                    Ok(Some(llm::Event::StepFinish {
                        finish: settled, ..
                    })) => finish = Some(settled),
                    Ok(Some(llm::Event::Finish(settled))) => {
                        streamed.settled = true;
                        if input.require_stop && settled.reason != llm::FinishReason::Stop {
                            streamed.failed = true;
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(_) => {
                        streamed.failed = true;
                        break;
                    }
                }
            },
        }
        let _ordinal = LEDGER.lock().await;
        let pending = services
            .store
            .begin_provider_request_with_id(&begin, request_id)
            .ok()?;
        let settled_usage = finish.as_ref().and_then(|settled| settled.usage.as_ref());
        let tokens = usage::tokens(settled_usage);
        let reported = cache_diagnostics::reported(
            &request.model.route.id,
            provider.as_str().unwrap_or_default(),
            settled_usage,
        );
        let cache_read = settled_usage
            .and_then(|usage| usage.cache_read_input_tokens)
            .unwrap_or(0.0);
        let invalidation = if finish.is_none() {
            "provider-not-reported"
        } else if cache_read > 0.0 {
            "stable-hit"
        } else {
            pending.default_invalidation
        };
        let fields = provider_request::recorded_fields(
            &begin,
            &pending,
            &provider_request::Completion {
                source: input.source,
                agent: input.agent,
                invalidation,
                continuation: "full",
                attempts: 1,
                cache_read_reported: finish.as_ref().map(|_| reported.read),
                timing: usage::timing(settled_usage),
                cost: finish.as_ref().and_then(|_| {
                    usage::estimated_cost(
                        &helper.costs,
                        &tokens,
                        usage::one_hour_cache_writes(settled_usage),
                    )
                }),
                tokens: &tokens,
                time: services.clock.now(),
            },
        )
        .ok()?;
        publish(
            &services.store,
            session,
            None,
            "session.provider.request.recorded",
            fields,
            services.clock.now(),
        )
        .await
        .ok()?;
        Some(streamed)
    }

    fn role_selection(
        &self,
        session: &session::Info,
        role: crate::tools::policy::helper::Role,
        agent: &ycoding_schema::agent::Info,
    ) -> Option<(
        ycoding_schema::model::Ref,
        Vec<crate::resources::credential::Info>,
        Option<ycoding_schema::session_event::ProfileBinding>,
    )> {
        let services = &self.0.services;
        let saved = services.credentials.all().ok()?;
        let selected = services
            .helpers
            .select(
                role,
                CompactionScope::Main,
                agent.model.as_ref(),
                session.model.as_ref(),
            )
            .cloned()
            .or_else(|| services.models.catalog().default_selection(&saved))?;
        let binding = services.store.profile_binding(&session.id).ok()?;
        let resolved = self
            .select_model(&selected, &saved, binding.as_ref())
            .ok()?;
        if let Some(connection) = &resolved.connection {
            let value = connection.secret().domain().ok()?;
            if matches!(&value, ycoding_schema::credential::Value::OAuth(value) if value.method_id.as_lossless().as_str() == Some("claude-code"))
                && services.claude.is_none()
            {
                return None;
            }
            if connection.integration_id().as_str() == Some("cursor")
                && services
                    .auth
                    .as_ref()
                    .and_then(|auth| auth.cursor.as_ref())
                    .is_none()
            {
                return None;
            }
        }
        Some((selected, saved, binding))
    }

    async fn role_helper(
        &self,
        session: &session::Info,
        role: crate::tools::policy::helper::Role,
        agent: &ycoding_schema::agent::Info,
    ) -> Option<Helper> {
        let (selected, saved, binding) = self.role_selection(session, role, agent)?;
        let resolution = self
            .resolve_model(&selected, &saved, binding.as_ref())
            .await
            .ok()?;
        Some(Helper {
            model: resolution.model,
            selection: selected,
            costs: resolution.resolved.info.cost.clone(),
            account_identity: resolution.account_identity,
            context_window: resolution.resolved.info.limit.context.get(),
            binding: resolution.binding,
        })
    }
}

impl Generate for Local {
    fn resolves(
        &self,
        session: &session::Info,
        role: crate::tools::policy::helper::Role,
        agent: &ycoding_schema::agent::Info,
    ) -> bool {
        self.role_selection(session, role, agent).is_some()
    }

    fn generate<'a>(&'a self, request: Request<'a>) -> Generation<'a> {
        Box::pin(async move {
            let helper = self
                .role_helper(request.session, request.role, request.agent)
                .await?;
            if request.cancellation.is_cancelled() {
                return None;
            }
            let streamed = self
                .stream_helper(StreamInput {
                    helper: &helper,
                    session: &request.session.id,
                    source: request.source,
                    agent: &request.agent.id,
                    permissions: &request.agent.permissions,
                    system: &request
                        .agent
                        .system
                        .as_ref()
                        .map(|system| system.to_utf8().unwrap_or_default())
                        .unwrap_or_default(),
                    prompt: request.user,
                    cancellation: Some(request.cancellation),
                    character_limit: Some(request.character_limit),
                    require_stop: request.role != crate::tools::policy::helper::Role::Goal,
                })
                .await?;
            (!streamed.failed
                && streamed.settled
                && !streamed.cancelled
                && !request.cancellation.is_cancelled())
            .then_some(streamed.text)
        })
    }
}

pub(super) fn cursor_session_headers(
    session: &session::Id,
    project: &ycoding_schema::project::Id,
    parent: Option<&session::Id>,
    account_identity: Option<&str>,
) -> BTreeMap<String, String> {
    let affinity = account_identity.map_or_else(
        || session.as_lossless().to_utf8().unwrap_or_default(),
        |account| {
            prompt_cache::sha256(&prompt_cache::canonical_json(&JsonValue::Array(vec![
                session.encode(),
                JsonValue::String(account.into()),
            ])))
        },
    );
    let mut headers = BTreeMap::from([
        ("x-session-affinity".into(), affinity.clone()),
        ("x-session-id".into(), affinity),
        ("x-ycoding-client".into(), "cli".into()),
        (
            "x-ycoding-project".into(),
            project.as_lossless().to_utf8().unwrap_or_default(),
        ),
        (
            "x-ycoding-session".into(),
            session.as_lossless().to_utf8().unwrap_or_default(),
        ),
    ]);
    if let Some(parent) = parent {
        headers.insert(
            "x-parent-session-id".into(),
            parent.as_lossless().to_utf8().unwrap_or_default(),
        );
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::cursor_session_headers;
    use crate::session::prompt_cache;

    #[test]
    fn helper_cursor_session_headers_match_the_typescript_helper_contract() {
        let session = ycoding_schema::session::Id::new("ses_helper").unwrap();
        let parent = ycoding_schema::session::Id::new("ses_parent").unwrap();
        let project = ycoding_schema::project::Id::new("prj_project").unwrap();
        let affinity = prompt_cache::sha256("[\"ses_helper\",\"account-digest\"]");

        assert_eq!(
            cursor_session_headers(&session, &project, None, Some("account-digest")),
            std::collections::BTreeMap::from([
                ("x-session-affinity".into(), affinity.clone()),
                ("x-session-id".into(), affinity),
                ("x-ycoding-client".into(), "cli".into()),
                (
                    "x-ycoding-project".into(),
                    project.as_lossless().to_utf8().unwrap()
                ),
                (
                    "x-ycoding-session".into(),
                    session.as_lossless().to_utf8().unwrap()
                ),
            ])
        );
        assert_eq!(
            cursor_session_headers(&session, &project, Some(&parent), None)["x-session-affinity"],
            "ses_helper"
        );
        assert_eq!(
            cursor_session_headers(&session, &project, Some(&parent), None)["x-parent-session-id"],
            "ses_parent"
        );
    }
}
