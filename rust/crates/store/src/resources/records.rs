use super::codec::{Document, Field, check, key, require, table};
use crate::{Error, IndexDefinition, KeyPart, TableSpec, tuple_key};
use ycoding_schema::{
    JsonValue, LosslessString, credential, domain, model, provider_request, telemetry, token_usage,
    usage_anchor,
};

#[derive(Clone, PartialEq)]
pub struct Secret(Document<credential::Value>);

impl Secret {
    pub fn new(value: JsonValue) -> Result<Self, Error> {
        Document::new(value)
            .map(Self)
            .map_err(|_| Error::Rejected("invalid credential value"))
    }
    pub fn value(&self) -> &JsonValue {
        self.0.value()
    }
    pub fn domain(&self) -> Result<credential::Value, Error> {
        self.0
            .domain()
            .map_err(|_| Error::Rejected("invalid credential value"))
    }
}
impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}
impl std::fmt::Display for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}
impl Field for Secret {
    fn encode(&self, bytes: &mut Vec<u8>) -> Result<(), Error> {
        self.0.encode(bytes)
    }
    fn decode(input: &mut &[u8]) -> Result<Self, Error> {
        Document::decode(input)
            .map(Self)
            .map_err(|_| Error::Rejected("invalid credential encoding"))
    }
}

table!(CredentialTable, Credential, "credential", {
    id: LosslessString, integration_id: Option<LosslessString>, label: LosslessString, value: Secret,
    connector_id: Option<LosslessString>, method_id: Option<LosslessString>, active: Option<i64>,
    generation: i64, account_generation: i64, time_created: i64, time_updated: i64
}, r, key(&r.id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check(r.generation >= 0, "credential_generation_check")?;
    check(r.account_generation >= 0, "credential_account_generation_check")
}, tx, { let _ = tx; });

table!(KvTable, Kv, "kv", {
    key: LosslessString, value: Document<domain::Json>, time_created: i64, time_updated: i64
}, r, key(&r.key), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });

table!(ShellTable, Shell, "shell", {
    id: LosslessString, session_id: Option<LosslessString>, pid: i64, process_started: Option<LosslessString>,
    owner_pid: i64, owner_started: LosslessString, notice_pending: i64, time_created: i64, time_lost: Option<i64>, start_seq: i64
}, r, key(&r.id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });

table!(ConsentTable, Consent, "telemetry_consent", {
    id: i64, enabled: i64, notice_version: i64, decided_at: i64
}, r, tuple_key(&[KeyPart::I64(r.id)]), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check(r.id == 1, "telemetry_consent_single_row")
}, tx, {
    super::source_changed(tx, "telemetry_consent", Self::primary_key(r), false)?;
    crate::analytics::privacy_changed(tx, Vec::new(), false)?;
});

table!(MigrationTable, Migration, "data_migration", {
    name: LosslessString, time_completed: i64
}, r, key(&r.name), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });

table!(SequenceTable, Sequence, "resource_sequence", {
    name: LosslessString, high_water: i64
}, r, key(&r.name), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { let _ = tx; });

fn visible_nonempty(value: &LosslessString) -> bool {
    value.code_units().next().is_some_and(|unit| unit != 0)
}
fn sql_digest(value: &LosslessString) -> bool {
    let units: Vec<_> = value.code_units().take_while(|unit| *unit != 0).collect();
    units.len() == 64
        && units.iter().all(|unit| {
            (u16::from(b'0')..=u16::from(b'9')).contains(unit)
                || (u16::from(b'a')..=u16::from(b'f')).contains(unit)
        })
}
fn revision_parent(
    tx: &mut crate::Write<'_>,
    session: &LosslessString,
    revision: i64,
) -> Result<(), Error> {
    require::<crate::session::SessionTable>(tx, &key(session))?;
    require::<crate::session::RevisionTable>(
        tx,
        &tuple_key(&[KeyPart::String(session), KeyPart::I64(revision)]),
    )
}

table!(ContinuationGenerationTable, ContinuationGeneration, "session_provider_continuation_generation", {
    session_id: LosslessString, generation: i64, context_revision: i64, time_updated: i64
}, r, key(&r.session_id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check(r.generation >= 0, "session_provider_continuation_generation_counts_check")?;
    check(r.context_revision >= 0, "session_provider_continuation_generation_revision_check")?;
    check(r.time_updated >= 0, "session_provider_continuation_generation_time_check")
}, tx, { revision_parent(tx, &r.session_id, r.context_revision)?; });

table!(ContinuationTable, Continuation, "session_provider_continuation", {
    session_id: LosslessString, response_id: LosslessString, represented_through_message_id: Option<LosslessString>,
    represented_message_count: i64, context_revision: i64, continuation_generation: i64, provider: LosslessString,
    route_id: LosslessString, model_id: LosslessString, variant: Option<LosslessString>, connection_identity_digest: LosslessString,
    prompt_cache_key: LosslessString, instructions_digest: LosslessString, tools_digest: LosslessString, options_digest: LosslessString,
    volatile_context_digest: LosslessString, continuation_fingerprint: LosslessString, time_updated: i64
}, r, key(&r.session_id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check(visible_nonempty(&r.response_id), "session_provider_continuation_response_check")?;
    check((r.represented_message_count == 0 && r.represented_through_message_id.is_none()) || (r.represented_message_count > 0 && r.represented_through_message_id.as_ref().is_none_or(visible_nonempty)), "session_provider_continuation_boundary_check")?;
    check(r.represented_message_count >= 0 && r.context_revision >= 0 && r.continuation_generation >= 0, "session_provider_continuation_counts_check")?;
    check([&r.provider, &r.route_id, &r.model_id, &r.prompt_cache_key].into_iter().all(visible_nonempty) && r.variant.as_ref().is_none_or(visible_nonempty), "session_provider_continuation_identity_check")?;
    check([&r.connection_identity_digest, &r.instructions_digest, &r.tools_digest, &r.options_digest, &r.volatile_context_digest, &r.continuation_fingerprint].into_iter().all(sql_digest), "session_provider_continuation_digest_check")?;
    check(r.time_updated >= 0, "session_provider_continuation_time_check")
}, tx, { revision_parent(tx, &r.session_id, r.context_revision)?; });

table!(StateBlobTable, StateBlob, "session_provider_state_blob", {
    digest: LosslessString, provider: LosslessString, model_id: LosslessString, item_type: LosslessString,
    content: Document<domain::Json>, time_created: i64
}, r, key(&r.digest), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check(sql_digest(&r.digest), "session_provider_state_blob_digest_check")?;
    check([&r.provider, &r.model_id, &r.item_type].into_iter().all(visible_nonempty), "session_provider_state_blob_identity_check")?;
    check(r.time_created >= 0, "session_provider_state_blob_time_check")
}, tx, { let _ = tx; });

table!(StateLinkTable, StateLink, "session_provider_state_link", {
    session_id: LosslessString, message_id: LosslessString, part_ordinal: i64, part_kind: LosslessString,
    provider: LosslessString, model_id: LosslessString, blob_digest: LosslessString, context_revision: i64, time_created: i64
}, r, tuple_key(&[KeyPart::String(&r.session_id), KeyPart::String(&r.message_id), KeyPart::I64(r.part_ordinal), KeyPart::String(&r.part_kind)]), &[
    IndexDefinition::secondary("session_provider_state_link_blob_idx"), IndexDefinition::secondary("session_provider_state_link_revision_idx")
], index, match index.name {
    "session_provider_state_link_blob_idx" => Ok(Some(key(&r.blob_digest))),
    "session_provider_state_link_revision_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.context_revision)]))),
    _ => Err(Error::UnregisteredIndex)
}, {
    check(visible_nonempty(&r.message_id), "session_provider_state_link_message_check")?;
    check(r.part_ordinal >= 0, "session_provider_state_link_ordinal_check")?;
    check([&r.part_kind, &r.provider, &r.model_id].into_iter().all(visible_nonempty), "session_provider_state_link_identity_check")?;
    check(sql_digest(&r.blob_digest), "session_provider_state_link_blob_check")?;
    check(r.context_revision >= 0, "session_provider_state_link_revision_check")?;
    check(r.time_created >= 0, "session_provider_state_link_time_check")
}, tx, {
    revision_parent(tx, &r.session_id, r.context_revision)?;
    require::<StateBlobTable>(tx, &key(&r.blob_digest))?;
});

table!(RequestTable, Request, "session_provider_request", {
    id: LosslessString, session_id: LosslessString, input_id: Option<LosslessString>, assistant_message_id: Option<LosslessString>,
    connection_identity_digest: Option<LosslessString>, source: LosslessString, agent: LosslessString, model: Document<model::Ref>,
    route_id: LosslessString, prompt_cache_key: LosslessString, system_digest: LosslessString, tool_digest: LosslessString,
    request: i64, attempts: i64, invalidation: LosslessString, continuation: LosslessString, cache_read_reported: Option<i64>,
    timing: Option<Document<provider_request::Timing>>, cost: Option<f64>, tokens: Document<token_usage::Info>, time_created: i64,
    usage_anchor: Option<Document<usage_anchor::Ref>>
}, r, key(&r.id), &[
    IndexDefinition::unique("session_provider_request_session_request_idx"), IndexDefinition::secondary("session_provider_request_session_source_idx")
], index, match index.name {
    "session_provider_request_session_request_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::I64(r.request)]))),
    "session_provider_request_session_source_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.session_id), KeyPart::String(&r.source)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, {
    require::<crate::session::SessionTable>(tx, &key(&r.session_id))?;
    super::source_changed(tx, "session_provider_request", Self::primary_key(r), false)?;
});

table!(UsageAnalyticsRequestTable, UsageAnalyticsRequest, "usage_analytics_request", {
    id: LosslessString, session_id: LosslessString, project_id: LosslessString, directory: LosslessString,
    workspace_id: Option<LosslessString>, session_updated: i64, agent: LosslessString, source: LosslessString,
    model: Document<model::Ref>, usage_anchor: Option<Document<usage_anchor::Ref>>, task_path: Document<Vec<LosslessString>>,
    request: i64, attempts: i64, continuation: LosslessString, invalidation: LosslessString, prompt_cache_key: LosslessString,
    cache_read_reported: Option<i64>, tokens: Document<token_usage::Info>, cost: Option<f64>,
    timing: Option<Document<provider_request::Timing>>, time_created: i64
}, r, key(&r.id), &[IndexDefinition::secondary("usage_analytics_request_time_created_id_idx")], index, match index.name {
    "usage_analytics_request_time_created_id_idx" => Ok(Some(tuple_key(&[KeyPart::I64(r.time_created), KeyPart::String(&r.id)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, {
    super::source_changed(tx, "usage_analytics_request", Self::primary_key(r), false)?;
});

table!(UsageTable, Usage, "session_usage", {
    session_id: LosslessString, model_key: LosslessString, model: Document<model::Ref>, logical: i64, physical: i64,
    helpers: i64, continued: i64, fallback: i64, cost: Option<f64>, input: i64, output: i64, reasoning: i64, cache_read: i64, cache_write: i64
}, r, tuple_key(&[KeyPart::String(&r.session_id), KeyPart::String(&r.model_key)]), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, {
    require::<crate::session::SessionTable>(tx, &key(&r.session_id))?;
    super::source_changed(tx, "session_usage", Self::primary_key(r), false)?;
});

table!(LatencyTable, Latency, "web_latency", {
    id: i64, received_at: i64, sample: Document<telemetry::Sample>
}, r, tuple_key(&[KeyPart::I64(r.id)]), &[IndexDefinition::secondary("web_latency_received_at_idx")], index, match index.name {
    "web_latency_received_at_idx" => Ok(Some(tuple_key(&[KeyPart::I64(r.received_at)]))),
    _ => Err(Error::UnregisteredIndex)
}, Ok::<_, Error>(()), tx, {
    super::seed_latency_sequence(tx, r.id)?;
    super::source_changed(tx, "web_latency", Self::primary_key(r), false)?;
});
