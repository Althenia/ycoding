use super::{key, projector::record_error, store::Service};
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, model, provider_request,
    session, stringify_json, token_usage,
};
use ycoding_store::{
    Error, IndexOrder, KeyPart, Write,
    resources::{Request, RequestTable, Usage, UsageTable},
    session::Document,
    tuple_key,
};

#[derive(Clone)]
pub struct Begin {
    pub session: session::Id,
    pub model: model::Ref,
    pub route_id: String,
    pub connection_identity_digest: Option<String>,
    pub prompt_cache_key: String,
    pub system_digest: String,
    pub tool_digest: String,
}

#[derive(Clone)]
pub struct Pending {
    pub id: provider_request::Id,
    pub request: i64,
    pub default_invalidation: &'static str,
}

pub struct Completion<'a> {
    pub source: &'a str,
    pub agent: &'a ycoding_schema::agent::Id,
    pub invalidation: &'static str,
    pub continuation: &'static str,
    pub attempts: u32,
    pub cache_read_reported: Option<bool>,
    pub timing: Option<JsonValue>,
    pub cost: Option<f64>,
    pub tokens: &'a JsonValue,
    pub time: i64,
}

impl Service {
    pub(crate) fn begin_provider_request_with_id(
        &self,
        begin: &Begin,
        id: provider_request::Id,
    ) -> Result<Pending, Error> {
        self.begin_provider_request_with_pending_id(begin, id)
    }

    pub fn telemetry_enabled(&self) -> Result<bool, Error> {
        Ok(self
            .client
            .snapshot()?
            .get::<ycoding_store::resources::ConsentTable>(&tuple_key(&[KeyPart::I64(1)]))?
            .is_some_and(|row| row.enabled == 1))
    }

    pub fn provider_accounts(
        &self,
        session: &session::Id,
        digest: &str,
    ) -> Result<std::collections::BTreeSet<LosslessString>, Error> {
        let snapshot = self.client.snapshot()?;
        let mut accounts = std::collections::BTreeSet::new();
        let mut after = None;
        loop {
            let page = ycoding_store::resources::requests(
                &snapshot,
                session.as_lossless(),
                IndexOrder::Ascending,
                after.as_ref(),
                128,
            )?;
            let Some(last) = page.last() else {
                return Ok(accounts);
            };
            after = Some(last.cursor.clone());
            accounts.extend(page.into_iter().filter_map(|entry| {
                (entry
                    .record
                    .connection_identity_digest
                    .as_ref()
                    .and_then(|value| value.as_str())
                    == Some(digest))
                .then_some(entry.record.assistant_message_id)
                .flatten()
            }));
        }
    }

    pub fn begin_provider_request(&self, begin: &Begin) -> Result<Pending, Error> {
        self.begin_provider_request_with_pending_id(begin, new_id()?)
    }
}

pub(crate) fn new_id() -> Result<provider_request::Id, Error> {
    let entropy = super::projector::random_event_id()?;
    provider_request::Id::new(format!(
        "prq_{}",
        entropy
            .as_lossless()
            .to_utf8()
            .unwrap_or_default()
            .trim_start_matches("evt_")
    ))
    .map_err(record_error)
}

impl Service {
    fn begin_provider_request_with_pending_id(
        &self,
        begin: &Begin,
        id: provider_request::Id,
    ) -> Result<Pending, Error> {
        let snapshot = self.client.snapshot()?;
        let previous = ycoding_store::resources::requests(
            &snapshot,
            begin.session.as_lossless(),
            IndexOrder::Descending,
            None,
            1,
        )?
        .into_iter()
        .next()
        .map(|entry| entry.record);
        Ok(Pending {
            id,
            request: previous.as_ref().map_or(0, |row| row.request) + 1,
            default_invalidation: default_invalidation(previous.as_ref(), begin),
        })
    }
}

fn default_invalidation(previous: Option<&Request>, begin: &Begin) -> &'static str {
    let Some(previous) = previous else {
        return "first-request";
    };
    if previous.source.as_str() == Some("compaction") {
        return "compaction-reset";
    }
    if let Ok(model) = previous.model.domain() {
        if model.provider_id != begin.model.provider_id || model.id != begin.model.id {
            return "model-switched";
        }
        if model.variant != begin.model.variant {
            return "model-variant-switched";
        }
        if model.profile != begin.model.profile {
            return "model-switched";
        }
    }
    if previous.prompt_cache_key.as_str() == Some(begin.prompt_cache_key.as_str()) {
        return "provider-not-reported";
    }
    if previous.system_digest.as_str() != Some(begin.system_digest.as_str()) {
        return "system-prefix-changed";
    }
    if previous.tool_digest.as_str() != Some(begin.tool_digest.as_str()) {
        return "tool-prefix-changed";
    }
    "prefix-changed"
}

pub fn recorded_fields(
    begin: &Begin,
    pending: &Pending,
    completion: &Completion,
) -> Result<JsonValue, Error> {
    Ok(ObjectEncoder::new()
        .field("id", &pending.id)
        .optional(
            "connectionIdentityDigest",
            &begin
                .connection_identity_digest
                .as_deref()
                .map(LosslessString::from),
        )
        .field("source", completion.source)
        .field("agent", completion.agent)
        .field("model", &begin.model)
        .field("routeID", begin.route_id.as_str())
        .field("promptCacheKey", begin.prompt_cache_key.as_str())
        .field("systemDigest", begin.system_digest.as_str())
        .field("toolDigest", begin.tool_digest.as_str())
        .field("request", &(pending.request as f64))
        .field("attempts", &(completion.attempts.max(1) as f64))
        .field("invalidation", completion.invalidation)
        .field("continuation", completion.continuation)
        .optional("cacheReadReported", &completion.cache_read_reported)
        .optional("timing", &completion.timing)
        .optional("cost", &completion.cost)
        .field("tokens", completion.tokens)
        .field("time", &(completion.time as f64))
        .finish())
}

pub(crate) fn apply(
    tx: &mut Write<'_>,
    object: &ObjectDecoder<'_>,
    session_id: &LosslessString,
) -> Result<(), Error> {
    let id: LosslessString = object.field("id").map_err(record_error)?;
    if tx.get::<RequestTable>(&key(&id))?.is_some() {
        return Ok(());
    }
    let model: model::Ref = object.field("model").map_err(record_error)?;
    let tokens: token_usage::Info = object.field("tokens").map_err(record_error)?;
    let cost: Option<ycoding_schema::money::Usd> = object.optional("cost").map_err(record_error)?;
    let timing: Option<provider_request::Timing> =
        object.optional("timing").map_err(record_error)?;
    let continuation: LosslessString = object.field("continuation").map_err(record_error)?;
    let source: LosslessString = object.field("source").map_err(record_error)?;
    let attempts: i64 = object
        .field::<ycoding_schema::schema::PositiveInt>("attempts")
        .map_err(record_error)?
        .get();
    let reported: Option<bool> = object.optional("cacheReadReported").map_err(record_error)?;
    let time: ycoding_schema::schema::DateTimeUtcFromMillis =
        object.field("time").map_err(record_error)?;
    RequestTable::insert(
        tx,
        &Request {
            id,
            session_id: session_id.clone(),
            input_id: object.optional("inputID").map_err(record_error)?,
            assistant_message_id: object
                .optional("assistantMessageID")
                .map_err(record_error)?,
            connection_identity_digest: object
                .optional("connectionIdentityDigest")
                .map_err(record_error)?,
            source: source.clone(),
            agent: object.field("agent").map_err(record_error)?,
            model: Document::from_domain(&model)?,
            route_id: object.field("routeID").map_err(record_error)?,
            prompt_cache_key: object.field("promptCacheKey").map_err(record_error)?,
            system_digest: object.field("systemDigest").map_err(record_error)?,
            tool_digest: object.field("toolDigest").map_err(record_error)?,
            request: object
                .field::<ycoding_schema::schema::PositiveInt>("request")
                .map_err(record_error)?
                .get(),
            attempts,
            invalidation: object.field("invalidation").map_err(record_error)?,
            continuation: continuation.clone(),
            cache_read_reported: reported.map(i64::from),
            timing: timing.as_ref().map(Document::from_domain).transpose()?,
            cost: cost.as_ref().map(|cost| cost.get()),
            tokens: Document::from_domain(&tokens)?,
            time_created: time.epoch_millis(),
        },
    )?;
    let model_key = stringify_json(&JsonValue::Array(vec![
        model.provider_id.encode(),
        model.id.encode(),
        model
            .variant
            .as_ref()
            .map_or(JsonValue::Null, |variant| variant.encode()),
        model
            .profile
            .as_ref()
            .map_or(JsonValue::Null, |profile| profile.encode()),
    ]));
    let identity = tuple_key(&[
        KeyPart::String(session_id),
        KeyPart::String(&model_key.clone().into()),
    ]);
    let step = source.as_str() == Some("step");
    let mut usage = tx.get::<UsageTable>(&identity)?.unwrap_or(Usage {
        session_id: session_id.clone(),
        model_key: model_key.into(),
        model: Document::from_domain(&model)?,
        logical: 0,
        physical: 0,
        helpers: 0,
        continued: 0,
        fallback: 0,
        cost: None,
        input: 0,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
    });
    usage.logical += 1;
    usage.physical += attempts;
    usage.helpers += i64::from(!step);
    usage.continued += i64::from(continuation.as_str() == Some("continued"));
    usage.fallback += i64::from(continuation.as_str() == Some("fallback"));
    usage.cost = match (usage.cost, cost.as_ref()) {
        (current, None) => current,
        (current, Some(cost)) => Some(current.unwrap_or(0.0) + cost.get()),
    };
    usage.input += tokens.input.get() as i64;
    usage.output += tokens.output.get() as i64;
    usage.reasoning += tokens.reasoning.get() as i64;
    usage.cache_read += tokens.cache.read.get() as i64;
    usage.cache_write += tokens.cache.write.get() as i64;
    UsageTable::put(tx, &usage)
}
