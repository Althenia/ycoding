use super::{history, key, store::Service};
use std::ops::Bound;
use ycoding_ai::cache;
use ycoding_schema::{
    JsonPath, JsonValue, LosslessString, ObjectDecoder, model, money, schema::NonNegativeInt,
    session, session_cache_diagnostics as cache_diagnostics, session_message, token_usage,
};
use ycoding_store::{
    Error, IndexOrder, IndexQuery, KeyPart, Snapshot,
    session::{Message, MessageTable},
    tuple_key,
};

const TYPE_INDEX: &str = "session_message_session_type_seq_idx";

impl Service {
    pub(crate) fn generation_speed(
        &self,
        id: &session::Id,
        current: (model::Ref, Option<ycoding_schema::provider_request::Timing>),
    ) -> Result<Option<cache_diagnostics::GenerationSpeedHistory>, Error> {
        let snapshot = self.client.snapshot()?;
        let mut records =
            super::provider_request::recent_steps_in(&snapshot, id, Some(&current.0), None)?;
        records.push(current);
        Ok(generation_speed(&records))
    }
    pub fn diagnostics(
        &self,
        id: &session::Id,
        boundary: Option<&session_message::Id>,
    ) -> Result<Option<cache_diagnostics::Info>, Error> {
        read(&self.client.snapshot()?, id, boundary)
    }
}

pub(crate) fn read(
    snapshot: &Snapshot,
    id: &session::Id,
    boundary: Option<&session_message::Id>,
) -> Result<Option<cache_diagnostics::Info>, Error> {
    let Some(assistant) = measured_before(snapshot, id, boundary)? else {
        return Ok(None);
    };
    let data = &assistant.data;
    let path = JsonPath::default();
    let object = ObjectDecoder::new(data, &path).map_err(super::projector::record_error)?;
    let tokens: Option<token_usage::Info> = object
        .optional("tokens")
        .map_err(super::projector::record_error)?;
    let Some(tokens) = tokens else {
        return Ok(None);
    };
    let diagnostics: Option<session_message::Diagnostics> = object
        .optional("diagnostics")
        .map_err(super::projector::record_error)?;
    let mut diagnostics = calculate(Calculation {
        model: object
            .field("model")
            .map_err(super::projector::record_error)?,
        tokens,
        estimated_cost: object
            .optional("cost")
            .map_err(super::projector::record_error)?
            .unwrap_or_else(money::Usd::zero),
        context_limit: diagnostics.as_ref().and_then(|value| value.context_limit),
        context_breakdown: diagnostics
            .as_ref()
            .and_then(|value| value.context_breakdown.clone()),
        provider_cache: diagnostics.and_then(|value| value.provider_cache),
    })?;
    diagnostics.requests = Some(super::provider_request::summary_in(snapshot, id)?);
    diagnostics.generation_speed =
        recent_speed(snapshot, id, boundary, &assistant.id, &diagnostics.model)?;
    Ok(Some(diagnostics))
}

pub(crate) fn generation_speed_in(
    snapshot: &Snapshot,
    id: &session::Id,
    boundary: Option<&session_message::Id>,
) -> Result<Option<cache_diagnostics::GenerationSpeedHistory>, Error> {
    let Some(assistant) = measured_before(snapshot, id, boundary)? else {
        return Ok(None);
    };
    let path = JsonPath::default();
    let measured: model::Ref = ObjectDecoder::new(&assistant.data, &path)
        .map_err(super::projector::record_error)?
        .field("model")
        .map_err(super::projector::record_error)?;
    recent_speed(snapshot, id, boundary, &assistant.id, &measured)
}

fn measured_before(
    snapshot: &Snapshot,
    id: &session::Id,
    boundary: Option<&session_message::Id>,
) -> Result<Option<Message>, Error> {
    let legacy = history::latest_compaction(snapshot, id)?;
    let anchor = match boundary {
        None => None,
        Some(boundary) => {
            let Some(row) = snapshot
                .get::<MessageTable>(&key(boundary.as_lossless()))?
                .filter(|row| &row.session_id == id.as_lossless())
            else {
                return Ok(None);
            };
            Some(row.seq)
        }
    };
    let compaction = completed_compaction(snapshot, id, anchor)?;
    let floor = compaction
        .map(Bound::Excluded)
        .or(legacy.map(Bound::Included));
    latest_measured_assistant(snapshot, id, anchor, floor)
}

fn recent_speed(
    snapshot: &Snapshot,
    id: &session::Id,
    boundary: Option<&session_message::Id>,
    assistant: &LosslessString,
    measured: &model::Ref,
) -> Result<Option<cache_diagnostics::GenerationSpeedHistory>, Error> {
    let selected = match boundary {
        Some(_) => None,
        None => snapshot
            .get::<ycoding_store::session::SessionTable>(&key(id.as_lossless()))?
            .and_then(|row| row.model)
            .map(|model| model.domain())
            .transpose()?,
    }
    .unwrap_or_else(|| measured.clone());
    let before = boundary
        .map(|_| super::provider_request::newest_request_of(snapshot, id, assistant))
        .transpose()?
        .map(|request| request.map_or(1, |request| request + 1));
    let mut records =
        super::provider_request::recent_steps_in(snapshot, id, Some(&selected), before)?;
    records.push((selected, None));
    Ok(generation_speed(&records))
}

pub fn generation_speed(
    records: &[(model::Ref, Option<ycoding_schema::provider_request::Timing>)],
) -> Option<cache_diagnostics::GenerationSpeedHistory> {
    let newest = &records.last()?.0;
    let mut recent = records
        .iter()
        .filter(|(model, _)| model.provider_id == newest.provider_id && model.id == newest.id)
        .filter_map(|(model, timing)| generation_sample(model, timing.as_ref()))
        .rev()
        .take(8)
        .collect::<Vec<_>>();
    recent.reverse();
    let latest = recent
        .iter()
        .try_fold((0i64, 0i64), |(tokens, duration), sample| {
            Some((
                tokens.checked_add(sample.tokens.get())?,
                duration.checked_add(sample.duration_ns.get())?,
            ))
        })
        .and_then(|(tokens, duration)| {
            Some(cache_diagnostics::GenerationSpeed {
                model: newest.clone(),
                tokens: ycoding_schema::schema::PositiveInt::new(tokens).ok()?,
                duration_ns: ycoding_schema::schema::PositiveInt::new(duration).ok()?,
                tokens_per_second: tokens as f64 * 1e9 / duration as f64,
                estimated: recent
                    .iter()
                    .any(|sample| sample.estimated == Some(true))
                    .then_some(true),
            })
        });
    Some(cache_diagnostics::GenerationSpeedHistory {
        model: Some(newest.clone()),
        unreported_reason: None,
        latest,
        recent,
    })
}

pub(crate) fn generation_sample(
    model: &model::Ref,
    timing: Option<&ycoding_schema::provider_request::Timing>,
) -> Option<cache_diagnostics::GenerationSpeed> {
    let timing = timing?;
    [
        (
            timing.generated_tokens,
            timing.observed_generation_duration_ns.or_else(|| {
                timing
                    .generation_duration_ns
                    .and_then(|value| ycoding_schema::schema::PositiveInt::new(value.get()).ok())
            }),
            None,
        ),
        (
            timing.estimated_tokens,
            timing.estimated_generation_duration_ns,
            Some(true),
        ),
    ]
    .into_iter()
    .find_map(|(tokens, duration_ns, estimated)| {
        let (tokens, duration_ns) = (tokens?, duration_ns?);
        let rate = tokens.get() as f64 * 1e9 / duration_ns.get() as f64;
        (rate.is_finite() && rate > 0.0).then(|| cache_diagnostics::GenerationSpeed {
            model: model.clone(),
            tokens,
            duration_ns,
            tokens_per_second: rate,
            estimated,
        })
    })
}

pub(crate) fn has_measured_assistant(
    messages: &[session_message::Info],
    boundary: Option<&session_message::Id>,
) -> Result<bool, Error> {
    let end = match boundary {
        Some(boundary) => match messages
            .iter()
            .map(history::message_id)
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .position(|message| message == boundary)
        {
            Some(index) => index,
            None => return Ok(false),
        },
        None => messages.len(),
    };
    Ok(messages[..end].iter().rev().take_while(|message| !matches!(message, session_message::Info::Compaction(session_message::Compaction::Completed(_) | session_message::Compaction::CompletedV1(_))))
        .any(|message| matches!(message, session_message::Info::Assistant(assistant) if assistant.tokens.is_some())))
}

pub(crate) struct Calculation {
    pub model: model::Ref,
    pub tokens: token_usage::Info,
    pub estimated_cost: money::Usd,
    pub context_limit: Option<NonNegativeInt>,
    pub context_breakdown: Option<cache_diagnostics::ContextBreakdown>,
    pub provider_cache: Option<cache_diagnostics::ProviderCache>,
}

fn type_key(id: &session::Id, type_: &str, seq: i64) -> Vec<u8> {
    tuple_key(&[
        KeyPart::String(id.as_lossless()),
        KeyPart::String(&LosslessString::from(type_)),
        KeyPart::I64(seq),
    ])
}

fn scan(
    snapshot: &Snapshot,
    id: &session::Id,
    type_: &str,
    anchor: Option<i64>,
    floor: Option<Bound<i64>>,
    matches: impl Fn(&Message) -> bool,
) -> Result<Option<Message>, Error> {
    let prefix = tuple_key(&[
        KeyPart::String(id.as_lossless()),
        KeyPart::String(&LosslessString::from(type_)),
    ]);
    let ceiling = anchor.map(|seq| type_key(id, type_, seq));
    let floor = match floor {
        Some(Bound::Included(seq)) => Bound::Included(type_key(id, type_, seq)),
        Some(Bound::Excluded(seq)) => Bound::Excluded(type_key(id, type_, seq)),
        _ => Bound::Unbounded,
    };
    let mut after = None;
    loop {
        let rows = snapshot.index_range::<MessageTable>(
            TYPE_INDEX,
            IndexQuery {
                lower: floor.as_ref().map(Vec::as_slice),
                upper: ceiling.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: after.as_ref(),
                limit: 16,
            },
        )?;
        if let Some(row) = rows.iter().find(|row| matches(&row.record)) {
            return Ok(Some(row.record.clone()));
        }
        if rows.is_empty() {
            return Ok(None);
        }
        after = rows.last().map(|row| row.cursor.clone());
    }
}

fn completed_compaction(
    snapshot: &Snapshot,
    id: &session::Id,
    anchor: Option<i64>,
) -> Result<Option<i64>, Error> {
    scan(snapshot, id, "compaction", anchor, None, |row| {
        matches!(&row.data, JsonValue::Object(data) if data.get(&"status".into()) == Some(&JsonValue::String("completed".into())))
    })
    .map(|row| row.map(|row| row.seq))
}

fn latest_measured_assistant(
    snapshot: &Snapshot,
    id: &session::Id,
    anchor: Option<i64>,
    floor: Option<Bound<i64>>,
) -> Result<Option<Message>, Error> {
    scan(
        snapshot,
        id,
        "assistant",
        anchor,
        floor,
        |row| matches!(&row.data, JsonValue::Object(data) if matches!(data.get(&"tokens".into()), Some(JsonValue::Object(_)))),
    )
}

pub(crate) fn calculate(input: Calculation) -> Result<cache_diagnostics::Info, Error> {
    let uncached_input = input.tokens.input.get().max(0.0);
    let output = input.tokens.output.get().max(0.0);
    let reasoning = input.tokens.reasoning.get().max(0.0);
    let cache_read = input.tokens.cache.read.get().max(0.0);
    let cache_write = input.tokens.cache.write.get().max(0.0);
    let total = uncached_input + output + reasoning + cache_read + cache_write;
    let eligible = uncached_input + cache_read + cache_write;
    let limit = input
        .context_limit
        .map(NonNegativeInt::get)
        .filter(|limit| *limit > 0);
    let read_reported = input
        .provider_cache
        .as_ref()
        .map_or(cache_read > 0.0, |cache| cache.read_reported);
    let write_reported = input
        .provider_cache
        .as_ref()
        .map_or(cache_write > 0.0, |cache| cache.write_reported);
    let mechanism = input.provider_cache.map_or_else(
        || {
            cache_diagnostics::Mechanism(
                unknown_route_mechanism(&input.model, cache_read, cache_write).into(),
            )
        },
        |cache| cache.mechanism,
    );
    let minimum_tokens = input
        .model
        .id
        .as_str()
        .and_then(cache::profile)
        .map(|profile| i64::from(profile.minimum_tokens));
    let count =
        |value: f64| NonNegativeInt::new(value as i64).map_err(super::projector::record_error);
    Ok(cache_diagnostics::Info {
        model: input.model,
        context_breakdown: input.context_breakdown,
        context: cache_diagnostics::Context {
            total: count(total)?,
            limit: limit.map(|limit| count(limit as f64)).transpose()?,
            remaining: limit
                .map(|limit| count((limit as f64 - total).max(0.0)))
                .transpose()?,
            percent: limit.map(|limit| (total / limit as f64 * 100.0).round()),
        },
        tokens: cache_diagnostics::Tokens {
            uncached_input: count(uncached_input)?,
            output: count(output)?,
            reasoning: count(reasoning)?,
            cache_read: count(cache_read)?,
            cache_write: count(cache_write)?,
        },
        cache: cache_diagnostics::Cache {
            eligible: count(eligible)?,
            hit_ratio: (read_reported && eligible > 0.0).then(|| cache_read / eligible),
            mechanism,
            read_reported,
            write_reported,
            minimum_tokens: minimum_tokens.map(count_i64).transpose()?,
            below_minimum: minimum_tokens.map(|minimum| eligible < minimum as f64),
        },
        estimated_cost: Some(input.estimated_cost),
        requests: None,
        generation_speed: None,
    })
}

fn count_i64(value: i64) -> Result<NonNegativeInt, Error> {
    NonNegativeInt::new(value).map_err(super::projector::record_error)
}

fn unknown_route_mechanism(model: &model::Ref, cache_read: f64, cache_write: f64) -> &'static str {
    match model.provider_id.0.as_str() {
        Some("openai" | "azure" | "ycoding" | "meta") => "openai-prefix-cache",
        Some("openrouter") => "openrouter-cache-control",
        Some("anthropic") => "anthropic-cache-control",
        Some("amazon-bedrock") => "bedrock-cache-point",
        Some("google" | "google-vertex") => "gemini-prefix-cache",
        Some("cursor") => "provider-reported",
        _ if cache_read > 0.0 || cache_write > 0.0 => "provider-reported",
        _ => "none",
    }
}
