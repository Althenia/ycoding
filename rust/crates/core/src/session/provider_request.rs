use super::{
    key,
    projector::record_error,
    store::Service,
    usage_activity,
    usage_attribution::{self, Attribution},
};
use std::{ops::Bound, sync::Arc};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectDecoder, ObjectEncoder, model,
    provider_request, session, stringify_json, token_usage, usage_anchor,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot, Write,
    resources::{
        Request, RequestTable, Usage, UsageAnalyticsRequest, UsageAnalyticsRequestTable, UsageTable,
    },
    session::{Document, JobTable, SessionTable, TaskTable},
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

pub(crate) fn summary_in(
    snapshot: &Snapshot,
    id: &session::Id,
) -> Result<provider_request::Summary, Error> {
    let prefix = key(id.as_lossless());
    let mut after = None;
    let mut rows = Vec::new();
    loop {
        let page = snapshot.scan::<UsageTable>(
            after
                .as_ref()
                .map_or(Bound::Included(prefix.as_slice()), |after: &Vec<u8>| {
                    Bound::Excluded(after.as_slice())
                }),
            Bound::Unbounded,
            128,
        )?;
        let Some(last) = page.last() else {
            break;
        };
        after = Some(tuple_key(&[
            KeyPart::String(&last.session_id),
            KeyPart::String(&last.model_key),
        ]));
        let finished = page.iter().any(|row| row.session_id != *id.as_lossless());
        rows.extend(
            page.into_iter()
                .filter(|row| row.session_id == *id.as_lossless()),
        );
        if finished {
            break;
        }
    }
    let mut models = rows
        .iter()
        .map(|row| Ok((row.model.domain()?, row)))
        .collect::<Result<Vec<_>, Error>>()?;
    let compare = |left: &LosslessString, right: &LosslessString| {
        crate::platform::filesystem::collation::compare(
            &left.code_units().collect::<Vec<_>>(),
            &right.code_units().collect::<Vec<_>>(),
        )
    };
    models.sort_by(|left, right| {
        right
            .1
            .cost
            .partial_cmp(&left.1.cost)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| compare(&left.0.provider_id.0, &right.0.provider_id.0))
            .then_with(|| compare(&left.0.id, &right.0.id))
            .then_with(|| {
                compare(
                    left.0
                        .variant
                        .as_ref()
                        .unwrap_or(&LosslessString::default()),
                    right
                        .0
                        .variant
                        .as_ref()
                        .unwrap_or(&LosslessString::default()),
                )
            })
            .then_with(|| {
                compare(
                    left.0
                        .profile
                        .as_ref()
                        .map(|profile| &profile.0)
                        .unwrap_or(&LosslessString::default()),
                    right
                        .0
                        .profile
                        .as_ref()
                        .map(|profile| &profile.0)
                        .unwrap_or(&LosslessString::default()),
                )
            })
    });
    let tokens = |input: i64, output: i64, reasoning: i64, read: i64, write: i64| {
        ObjectEncoder::new()
            .field("input", &(input as f64))
            .field("output", &(output as f64))
            .field("reasoning", &(reasoning as f64))
            .field(
                "cache",
                &ObjectEncoder::new()
                    .field("read", &(read as f64))
                    .field("write", &(write as f64))
                    .finish(),
            )
            .finish()
    };
    let sum = |value: fn(&Usage) -> i64| rows.iter().map(value).sum::<i64>() as f64;
    let last = ycoding_store::resources::requests(
        snapshot,
        id.as_lossless(),
        IndexOrder::Descending,
        None,
        1,
    )?
    .into_iter()
    .next()
    .map(|entry| entry.record);
    provider_request::Summary::decode(
        &ObjectEncoder::new()
            .field("logical", &sum(|row| row.logical))
            .field("physical", &sum(|row| row.physical))
            .field("helpers", &sum(|row| row.helpers))
            .field("continued", &sum(|row| row.continued))
            .field("fallback", &sum(|row| row.fallback))
            .optional(
                "cost",
                &rows
                    .iter()
                    .any(|row| row.cost.is_some())
                    .then(|| rows.iter().filter_map(|row| row.cost).sum::<f64>()),
            )
            .optional(
                "models",
                &(!models.is_empty()).then(|| {
                    JsonValue::Array(
                        models
                            .iter()
                            .map(|(model, row)| {
                                ObjectEncoder::new()
                                    .field("model", model)
                                    .field("requests", &(row.logical as f64))
                                    .field(
                                        "tokens",
                                        &tokens(
                                            row.input,
                                            row.output,
                                            row.reasoning,
                                            row.cache_read,
                                            row.cache_write,
                                        ),
                                    )
                                    .optional("cost", &row.cost)
                                    .optional(
                                        "costProvenance",
                                        &row.cost.map(|_| LosslessString::from("recorded")),
                                    )
                                    .finish()
                            })
                            .collect(),
                    )
                }),
            )
            .field(
                "tokens",
                &tokens(
                    rows.iter().map(|row| row.input).sum(),
                    rows.iter().map(|row| row.output).sum(),
                    rows.iter().map(|row| row.reasoning).sum(),
                    rows.iter().map(|row| row.cache_read).sum(),
                    rows.iter().map(|row| row.cache_write).sum(),
                ),
            )
            .optional(
                "latestInvalidation",
                &last.as_ref().map(|row| row.invalidation.clone()),
            )
            .optional(
                "latestNamespace",
                &last.as_ref().map(|row| {
                    LosslessString::from_utf16(row.prompt_cache_key.code_units().take(8).collect())
                }),
            )
            .optional(
                "latestTiming",
                &last
                    .as_ref()
                    .and_then(|row| row.timing.as_ref().map(|timing| timing.value().clone())),
            )
            .finish(),
    )
    .map_err(record_error)
}

pub(crate) fn recent_steps_in(
    snapshot: &Snapshot,
    id: &session::Id,
    selected: Option<&model::Ref>,
    before: Option<i64>,
) -> Result<Vec<(model::Ref, Option<provider_request::Timing>)>, Error> {
    let prefix = key(id.as_lossless());
    let ceiling =
        before.map(|before| tuple_key(&[KeyPart::String(id.as_lossless()), KeyPart::I64(before)]));
    let mut after = None;
    let mut records = Vec::new();
    let mut selected = selected.cloned();
    loop {
        let page = snapshot.index_range::<RequestTable>(
            "session_provider_request_session_request_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: ceiling.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        let Some(last) = page.last() else {
            break;
        };
        after = Some(last.cursor.clone());
        for row in page
            .into_iter()
            .map(|entry| entry.record)
            .filter(|row| row.source.as_str() == Some("step"))
        {
            let model = row.model.domain()?;
            let selected = selected.get_or_insert_with(|| model.clone());
            if selected.provider_id != model.provider_id || selected.id != model.id {
                continue;
            }
            let timing = row
                .timing
                .as_ref()
                .map(|timing| timing.domain())
                .transpose()?;
            if super::diagnostics::generation_sample(&model, timing.as_ref()).is_none() {
                continue;
            }
            records.push((model, timing));
            if records.len() == 8 {
                records.reverse();
                return Ok(records);
            }
        }
        std::thread::yield_now();
    }
    records.reverse();
    Ok(records)
}

pub(crate) fn newest_request_of(
    snapshot: &Snapshot,
    id: &session::Id,
    assistant: &LosslessString,
) -> Result<Option<i64>, Error> {
    let mut after = None;
    loop {
        let page = ycoding_store::resources::requests(
            snapshot,
            id.as_lossless(),
            IndexOrder::Descending,
            after.as_ref(),
            128,
        )?;
        let Some(last) = page.last() else {
            return Ok(None);
        };
        after = Some(last.cursor.clone());
        if let Some(entry) = page
            .iter()
            .find(|entry| entry.record.assistant_message_id.as_ref() == Some(assistant))
        {
            return Ok(Some(entry.record.request));
        }
        std::thread::yield_now();
    }
}

#[derive(Clone)]
pub struct Pending {
    pub id: provider_request::Id,
    pub request: i64,
    pub default_invalidation: &'static str,
    pub usage_anchor: Option<usage_anchor::Ref>,
    _activity: Arc<usage_activity::Contribution>,
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
    pub(crate) async fn begin_provider_request_attributed_with_id(
        &self,
        begin: &Begin,
        id: provider_request::Id,
        attribution: Attribution,
    ) -> Result<Pending, Error> {
        self.begin_provider_request_with_pending_id(begin, id, attribution)
            .await
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

    pub async fn begin_provider_request(&self, begin: &Begin) -> Result<Pending, Error> {
        self.begin_provider_request_with_pending_id(begin, new_id()?, Attribution::Unset)
            .await
    }

    pub async fn begin_provider_request_attributed(
        &self,
        begin: &Begin,
        attribution: Attribution,
    ) -> Result<Pending, Error> {
        self.begin_provider_request_with_pending_id(begin, new_id()?, attribution)
            .await
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
    async fn begin_provider_request_with_pending_id(
        &self,
        begin: &Begin,
        id: provider_request::Id,
        attribution: Attribution,
    ) -> Result<Pending, Error> {
        let session = begin.session.clone();
        let usage_anchor =
            usage_attribution::dispatch(&self.client, session.as_lossless(), &attribution).await?;
        let begin = begin.clone();
        let (id, request, default_invalidation) = self
            .client
            .submit(move |tx| {
                let prefix = key(begin.session.as_lossless());
                let previous = tx
                    .index_range::<RequestTable>(
                        "session_provider_request_session_request_idx",
                        IndexQuery {
                            lower: Bound::Unbounded,
                            upper: Bound::Unbounded,
                            prefix: Some(&prefix),
                            order: IndexOrder::Descending,
                            after: None,
                            limit: 1,
                        },
                    )?
                    .into_iter()
                    .next()
                    .map(|entry| entry.record);
                let request = ycoding_store::resources::reserve_request(
                    tx,
                    begin.session.as_lossless(),
                    previous.as_ref().map_or(0, |row| row.request),
                )?;
                let compacted_since_previous = previous
                    .as_ref()
                    .map(|previous| compaction_since_previous(tx, previous))
                    .transpose()?
                    .unwrap_or(false);
                Ok((
                    id,
                    request,
                    default_invalidation(previous.as_ref(), &begin, compacted_since_previous),
                ))
            })?
            .await?;
        Ok(Pending {
            _activity: Arc::new(usage_activity::request(
                &self.client,
                session,
                usage_anchor.clone(),
            )),
            id,
            request,
            usage_anchor,
            default_invalidation,
        })
    }
}

fn compaction_since_previous(tx: &mut Write<'_>, previous: &Request) -> Result<bool, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(&"ended".into()),
        KeyPart::Null,
        KeyPart::String(&previous.session_id),
    ]);
    let mut after = None;
    loop {
        let page = tx.index_range::<JobTable>(
            "session_compaction_job_recovery_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: after.as_ref(),
                limit: 128,
            },
        )?;
        if page.iter().any(|entry| {
            entry
                .record
                .time_ended
                .is_some_and(|time| time > previous.time_created)
        }) {
            return Ok(true);
        }
        let Some(last) = page.last() else {
            return Ok(false);
        };
        after = Some(last.cursor.clone());
    }
}

fn default_invalidation(
    previous: Option<&Request>,
    begin: &Begin,
    compacted_since_previous: bool,
) -> &'static str {
    let Some(previous) = previous else {
        return "first-request";
    };
    if previous.source.as_str() == Some("compaction") || compacted_since_previous {
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
        .optional("usageAnchor", &pending.usage_anchor)
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
    let agent: LosslessString = object.field("agent").map_err(record_error)?;
    let prompt_cache_key: LosslessString = object.field("promptCacheKey").map_err(record_error)?;
    let request = object
        .field::<ycoding_schema::schema::PositiveInt>("request")
        .map_err(record_error)?
        .get();
    let invalidation: LosslessString = object.field("invalidation").map_err(record_error)?;
    let usage_anchor: Option<Document<usage_anchor::Ref>> = object
        .optional::<usage_anchor::Ref>("usageAnchor")
        .map_err(record_error)?
        .as_ref()
        .map(Document::from_domain)
        .transpose()?;
    let model_document = Document::from_domain(&model)?;
    let tokens_document = Document::from_domain(&tokens)?;
    let timing_document = timing.as_ref().map(Document::from_domain).transpose()?;
    let cost_value = cost.as_ref().map(|cost| cost.get());
    RequestTable::insert(
        tx,
        &Request {
            id: id.clone(),
            session_id: session_id.clone(),
            input_id: object.optional("inputID").map_err(record_error)?,
            assistant_message_id: object
                .optional("assistantMessageID")
                .map_err(record_error)?,
            connection_identity_digest: object
                .optional("connectionIdentityDigest")
                .map_err(record_error)?,
            source: source.clone(),
            agent: agent.clone(),
            model: model_document.clone(),
            route_id: object.field("routeID").map_err(record_error)?,
            prompt_cache_key: prompt_cache_key.clone(),
            system_digest: object.field("systemDigest").map_err(record_error)?,
            tool_digest: object.field("toolDigest").map_err(record_error)?,
            request,
            attempts,
            invalidation: invalidation.clone(),
            continuation: continuation.clone(),
            cache_read_reported: reported.map(i64::from),
            timing: timing_document.clone(),
            cost: cost_value,
            tokens: tokens_document.clone(),
            time_created: time.epoch_millis(),
            usage_anchor: usage_anchor.clone(),
        },
    )?;
    if tx.get::<UsageAnalyticsRequestTable>(&key(&id))?.is_none() {
        let session = tx
            .get::<SessionTable>(&key(session_id))?
            .ok_or(Error::Domain {
                kind: "usage_analytics_session",
                message: "Usage analytics requires the request Session",
            })?;
        let task_path = Document::from_domain(&task_path(tx, session_id)?)?;
        UsageAnalyticsRequestTable::insert(
            tx,
            &UsageAnalyticsRequest {
                id,
                session_id: session_id.clone(),
                project_id: session.project_id,
                directory: session.directory,
                workspace_id: session.workspace_id,
                session_updated: session.time_updated,
                agent,
                source: source.clone(),
                model: model_document,
                usage_anchor,
                task_path,
                request,
                attempts,
                continuation: continuation.clone(),
                invalidation,
                prompt_cache_key: LosslessString::from_utf16(
                    prompt_cache_key.code_units().take(8).collect(),
                ),
                cache_read_reported: reported.map(i64::from),
                tokens: tokens_document,
                cost: cost_value,
                timing: timing_document,
                time_created: time.epoch_millis(),
            },
        )?;
    }
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

fn task_path(
    tx: &mut Write<'_>,
    session_id: &LosslessString,
) -> Result<Vec<LosslessString>, Error> {
    let mut path = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut current = Some(session_id.clone());
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return Err(Error::Domain {
                kind: "usage_task_path",
                message: "Session ancestry contains a cycle",
            });
        }
        let Some(row) = tx.get::<SessionTable>(&key(&id))? else {
            break;
        };
        if tx.get::<TaskTable>(&key(&id))?.is_some() {
            path.push(id);
        }
        current = row.parent_id;
    }
    Ok(path)
}
