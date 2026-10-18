use super::{
    key,
    prompt_cache::{canonical_json, sha256},
    store::Service,
};
use ycoding_schema::{JsonValue, LosslessString, ObjectEncoder, session};
use ycoding_store::{
    Error, Write,
    resources::{
        Continuation, ContinuationGeneration, ContinuationTable, ensure_generation,
        remember_continuation,
    },
    session::ContextStateTable,
};

pub fn is_responses_route(route_id: &str) -> bool {
    matches!(route_id, "openai-responses" | "openai-responses-websocket")
}

#[derive(Clone, Debug)]
pub struct Fingerprint {
    pub session: LosslessString,
    pub context_revision: i64,
    pub continuation_generation: i64,
    pub provider: String,
    pub route_id: String,
    pub model_id: String,
    pub variant: Option<String>,
    pub connection_identity_digest: String,
    pub represented_through_message_id: Option<LosslessString>,
    pub represented_message_count: i64,
    pub prompt_cache_key: String,
    pub instructions_digest: String,
    pub tools_digest: String,
    pub options_digest: String,
    pub volatile_context_digest: String,
}

impl Fingerprint {
    pub fn digest(&self) -> String {
        sha256(&canonical_json(&self.value(true)))
    }

    fn digest_without_volatile(&self) -> String {
        sha256(&canonical_json(&self.value(false)))
    }

    fn value(&self, volatile: bool) -> JsonValue {
        let encoder = ObjectEncoder::new()
            .field("sessionID", &self.session)
            .field("contextRevision", &(self.context_revision as f64))
            .field(
                "continuationGeneration",
                &(self.continuation_generation as f64),
            )
            .field("provider", self.provider.as_str())
            .field("routeID", self.route_id.as_str())
            .field("modelID", self.model_id.as_str())
            .optional(
                "variant",
                &self.variant.as_deref().map(LosslessString::from),
            )
            .field(
                "connectionIdentityDigest",
                self.connection_identity_digest.as_str(),
            )
            .optional(
                "representedThroughMessageID",
                &self.represented_through_message_id,
            )
            .field(
                "representedMessageCount",
                &(self.represented_message_count as f64),
            )
            .field("promptCacheKey", self.prompt_cache_key.as_str())
            .field("instructionsDigest", self.instructions_digest.as_str())
            .field("toolsDigest", self.tools_digest.as_str())
            .field("optionsDigest", self.options_digest.as_str());
        if volatile {
            encoder
                .field(
                    "volatileContextDigest",
                    self.volatile_context_digest.as_str(),
                )
                .finish()
        } else {
            encoder.finish()
        }
    }
}

pub struct State {
    pub fingerprint: Fingerprint,
    pub response_id: LosslessString,
}

impl Service {
    pub async fn continuation_authority(
        &self,
        session: &session::Id,
    ) -> Result<ContinuationGeneration, Error> {
        let id = session.as_lossless().clone();
        self.client
            .submit(move |tx| {
                let revision = tx
                    .get::<ContextStateTable>(&key(&id))?
                    .map_or(0, |state| state.revision);
                ensure_generation(
                    tx,
                    &ContinuationGeneration {
                        session_id: id,
                        generation: 0,
                        context_revision: revision,
                        time_updated: 0,
                    },
                )
            })?
            .await
    }

    pub async fn clear_continuation(&self, session: &session::Id, now: i64) -> Result<(), Error> {
        let id = session.as_lossless().clone();
        self.client
            .submit(move |tx| {
                let revision = match tx
                    .get::<ycoding_store::resources::ContinuationGenerationTable>(&key(&id))?
                {
                    Some(authority) => authority.context_revision,
                    None => tx
                        .get::<ContextStateTable>(&key(&id))?
                        .map_or(0, |state| state.revision),
                };
                ycoding_store::resources::invalidate_continuation(tx, &id, revision, now)?;
                Ok(())
            })?
            .await
    }

    pub fn select_continuation(
        &self,
        fingerprint: &Fingerprint,
        complete_message_ids: &[LosslessString],
    ) -> Result<Option<State>, Error> {
        if !fingerprint.provider.eq("openai") || !is_responses_route(&fingerprint.route_id) {
            return Ok(None);
        }
        let Some(row) = self
            .client
            .snapshot()?
            .get::<ContinuationTable>(&key(&fingerprint.session))?
        else {
            return Ok(None);
        };
        let boundary = if row.represented_message_count == 0 {
            row.represented_through_message_id.is_none()
        } else {
            usize::try_from(row.represented_message_count - 1)
                .ok()
                .and_then(|index| complete_message_ids.get(index))
                == row.represented_through_message_id.as_ref()
        };
        if !boundary {
            return Ok(None);
        }
        let stored = Fingerprint {
            session: row.session_id.clone(),
            context_revision: row.context_revision,
            continuation_generation: row.continuation_generation,
            provider: text(&row.provider),
            route_id: text(&row.route_id),
            model_id: text(&row.model_id),
            variant: row.variant.as_ref().map(text),
            connection_identity_digest: text(&row.connection_identity_digest),
            represented_through_message_id: row.represented_through_message_id.clone(),
            represented_message_count: row.represented_message_count,
            prompt_cache_key: text(&row.prompt_cache_key),
            instructions_digest: text(&row.instructions_digest),
            tools_digest: text(&row.tools_digest),
            options_digest: text(&row.options_digest),
            volatile_context_digest: text(&row.volatile_context_digest),
        };
        let candidate = Fingerprint {
            represented_through_message_id: stored.represented_through_message_id.clone(),
            represented_message_count: stored.represented_message_count,
            ..fingerprint.clone()
        };
        let matches = row.continuation_fingerprint.as_str() == Some(candidate.digest().as_str())
            || stored.digest_without_volatile() == candidate.digest_without_volatile();
        Ok(matches.then_some(State {
            fingerprint: stored,
            response_id: row.response_id,
        }))
    }

    pub async fn remember_continuation(&self, state: State, now: i64) -> Result<bool, Error> {
        self.client
            .submit(move |tx| remember_in(tx, state, now))?
            .await
    }
}

pub(crate) fn remember_in(tx: &mut Write<'_>, state: State, now: i64) -> Result<bool, Error> {
    let fingerprint = state.fingerprint;
    if !fingerprint.provider.eq("openai") || !is_responses_route(&fingerprint.route_id) {
        return Ok(false);
    }
    let row = Continuation {
        continuation_fingerprint: fingerprint.digest().into(),
        session_id: fingerprint.session,
        response_id: state.response_id,
        represented_through_message_id: fingerprint.represented_through_message_id,
        represented_message_count: fingerprint.represented_message_count,
        context_revision: fingerprint.context_revision,
        continuation_generation: fingerprint.continuation_generation,
        provider: fingerprint.provider.into(),
        route_id: fingerprint.route_id.into(),
        model_id: fingerprint.model_id.into(),
        variant: fingerprint.variant.map(Into::into),
        connection_identity_digest: fingerprint.connection_identity_digest.into(),
        prompt_cache_key: fingerprint.prompt_cache_key.into(),
        instructions_digest: fingerprint.instructions_digest.into(),
        tools_digest: fingerprint.tools_digest.into(),
        options_digest: fingerprint.options_digest.into(),
        volatile_context_digest: fingerprint.volatile_context_digest.into(),
        time_updated: now,
    };
    remember_continuation(tx, &row)
}

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap_or_default()
}

pub fn instructions_digest(
    system: &[ycoding_ai::llm::TextPart],
    updates: &[&ycoding_ai::llm::Message],
) -> String {
    sha256(&canonical_json(
        &ObjectEncoder::new()
            .field(
                "system",
                &JsonValue::Array(
                    system
                        .iter()
                        .map(|part| JsonValue::String(part.text.clone()))
                        .collect(),
                ),
            )
            .field(
                "updates",
                &JsonValue::Array(
                    updates
                        .iter()
                        .map(|message| message_value(message))
                        .collect(),
                ),
            )
            .finish(),
    ))
}

pub fn volatile_digest(messages: &[ycoding_ai::llm::Message]) -> String {
    sha256(&canonical_json(&JsonValue::Array(
        messages.iter().map(message_value).collect(),
    )))
}

pub fn options_digest(request: &ycoding_ai::llm::Request) -> String {
    use crate::resources::catalog::merge_json;
    let options = [
        request.model.route.defaults.provider_options.as_ref(),
        request.model.defaults.provider_options.as_ref(),
        request.provider_options.as_ref(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .reduce(|base, next| merge_json(&base, &next));
    let generation = request
        .model
        .route
        .defaults
        .generation
        .overlay(&request.model.defaults.generation)
        .overlay(&request.generation);
    let http = request
        .model
        .route
        .defaults
        .http
        .overlay(&request.model.defaults.http)
        .overlay(&request.http);
    let semantic = options
        .as_ref()
        .and_then(|options| match options {
            JsonValue::Object(fields) => fields.get(&"openai".into()),
            _ => None,
        })
        .map(|openai| match openai {
            JsonValue::Object(fields) => {
                let mut semantic = ycoding_schema::JsonObject::new();
                for (name, value) in fields.iter().filter(|(name, _)| {
                    !matches!(
                        name.as_str(),
                        Some("previousResponseId" | "continuationInputStart" | "promptCacheKey")
                    )
                }) {
                    semantic.insert(name.clone(), value.clone());
                }
                JsonValue::Object(semantic)
            }
            other => other.clone(),
        });
    let mut query = ycoding_schema::JsonObject::new();
    for (name, value) in &http.query {
        query.insert(
            name.as_str().into(),
            JsonValue::String(value.as_str().into()),
        );
    }
    let query = JsonValue::Object(query);
    sha256(&canonical_json(
        &ObjectEncoder::new()
            .field(
                "generation",
                &ObjectEncoder::new()
                    .optional("maxTokens", &generation.max_tokens)
                    .optional("temperature", &generation.temperature)
                    .optional("topP", &generation.top_p)
                    .optional("topK", &generation.top_k)
                    .optional("frequencyPenalty", &generation.frequency_penalty)
                    .optional("presencePenalty", &generation.presence_penalty)
                    .optional("seed", &generation.seed)
                    .optional("stop", &generation.stop)
                    .finish(),
            )
            .optional("openai", &semantic)
            .optional(
                "toolChoice",
                &request
                    .tool_choice
                    .as_ref()
                    .map(|choice| LosslessString::from(format!("{choice:?}"))),
            )
            .optional(
                "responseFormat",
                &request
                    .response_format
                    .as_ref()
                    .map(|format| LosslessString::from(format!("{format:?}"))),
            )
            .field("cache", format!("{:?}", request.cache).as_str())
            .field(
                "http",
                &ObjectEncoder::new()
                    .optional("body", &http.body)
                    .field("query", &query)
                    .finish(),
            )
            .finish(),
    ))
}

fn message_value(message: &ycoding_ai::llm::Message) -> JsonValue {
    ObjectEncoder::new()
        .field("role", format!("{:?}", message.role).as_str())
        .field(
            "content",
            &JsonValue::Array(
                message
                    .content
                    .iter()
                    .map(|part| match part {
                        ycoding_ai::llm::Part::Text(text) => JsonValue::String(text.text.clone()),
                        other => JsonValue::String(format!("{other:?}").into()),
                    })
                    .collect(),
            ),
        )
        .finish()
}
