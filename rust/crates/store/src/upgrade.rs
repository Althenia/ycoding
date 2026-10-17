use crate::{
    Catalog, Error, Metadata, Options, TableDeclaration, TableSpec, backup,
    catalog::definition,
    engine::index_storage_key,
    import::{self, DatabaseKind, digest::Digest},
    metadata::{commit_error, inspect},
    resources::{Request, RequestTable, UsageAnalyticsRequest, UsageAnalyticsRequestTable},
    session::{Document, Job, JobTable, Session, SessionTable, Task, TaskTable, codec::Field},
};
use redb::{
    Database, Durability, ReadOnlyDatabase, ReadTransaction, ReadableDatabase, ReadableTable,
    ReadableTableMetadata, WriteTransaction,
};
use std::{collections::BTreeSet, ops::Bound, path::Path, sync::OnceLock};
use ycoding_schema::{
    JsonValue, LosslessString, domain, model, permission, provider_request, session_event,
    session_revert, token_usage,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Predecessor {
    BeforeAnalytics,
    BeforeIncidents,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Current,
    Upgraded(Predecessor),
}

const BEFORE_ANALYTICS: &str = "843dd129682457a44d2a4ed4cb82f6e701a4d5a202cb2fb8073a6e1bd52dc097";
const BEFORE_INCIDENTS: &str = "1f4a70c9d374ab7c72c2c008b215b0a2ffa311998c8642852d21a561293e01a4";
const BATCH: usize = 256;
const MANIFEST: &[u8] = b"catalog_manifest";
const FACTS: &str = "usage_analytics_request";

type Convert = fn(&[u8]) -> Result<Vec<u8>, Error>;
type FreeBytes<'a> = &'a (dyn Fn(&Path) -> Result<u64, Error> + Sync);

pub fn core(
    path: &Path,
    options: Options,
    free_bytes: impl Fn(&Path) -> Result<u64, Error> + Sync,
) -> Result<Outcome, Error> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("ycoding-store-upgrade".to_owned())
            .spawn_scoped(scope, || upgrade(path, options, &free_bytes))?
            .join()
            .map_err(|_| Error::WriterPanicked)?
    })
}

fn upgrade(path: &Path, options: Options, free_bytes: FreeBytes<'_>) -> Result<Outcome, Error> {
    let target = import::catalog(DatabaseKind::Core);
    let database = ReadOnlyDatabase::open(path)?;
    let read = database.begin_read()?;
    let manifest = stored_manifest(&read)?;
    if manifest == target.manifest() {
        return Ok(Outcome::Current);
    }
    let predecessor = Predecessor::identify(&manifest)?;
    let metadata = inspect(&read, predecessor.catalog()?)?;
    let pruned = Pruned::inspect(path, &metadata)?;
    backup::preserve(&read, path, predecessor.catalog()?, &metadata, free_bytes)?;
    drop(read);
    drop(database);
    pruned.upgrade(path, options, &metadata, free_bytes)?;
    migrate(
        &Database::builder()
            .set_cache_size(options.cache_bytes)
            .open(path)?,
        predecessor,
    )?;
    Ok(Outcome::Upgraded(predecessor))
}

enum Pruned {
    Absent,
    Predecessor(Predecessor),
    Upgraded { sealed: bool },
}

impl Pruned {
    fn inspect(database: &Path, metadata: &Metadata) -> Result<Self, Error> {
        let backup = backup::path(database);
        if !backup.try_exists()? {
            return Ok(Self::Absent);
        }
        let sealed = backup::sealed(database, metadata)?;
        let file = backup::open_copy(&backup)?;
        let read = file.begin_read()?;
        let manifest = stored_manifest(&read)?;
        let copy = backup::upgrade_path(&backup);
        let target = import::catalog(DatabaseKind::Core);
        if manifest == target.manifest() {
            if inspect(&read, target)? != *metadata {
                return Err(Error::Rejected("pre-prune backup identity mismatch"));
            }
            if !copy.try_exists()? {
                return Err(Error::Rejected(
                    "upgraded pre-prune backup has no pre-upgrade copy",
                ));
            }
            let original = backup::open_copy(&copy)?;
            let original = original.begin_read()?;
            let predecessor = Predecessor::identify(&stored_manifest(&original)?)?;
            if inspect(&original, predecessor.catalog()?)? != *metadata {
                return Err(Error::Rejected("pre-upgrade copy identity mismatch"));
            }
            migrated_rows(&original, &read, predecessor)?;
            return Ok(Self::Upgraded {
                sealed: sealed == Some(true),
            });
        }
        let predecessor = Predecessor::identify(&manifest)?;
        if sealed == Some(false) {
            return Err(Error::Rejected(
                "pre-prune backup completion marker mismatch",
            ));
        }
        if inspect(&read, predecessor.catalog()?)? != *metadata {
            return Err(Error::Rejected("pre-prune backup identity mismatch"));
        }
        if copy.try_exists()? {
            backup::proven(&read, &copy, predecessor.catalog()?, metadata)?;
        }
        Ok(Self::Predecessor(predecessor))
    }

    fn upgrade(
        self,
        database: &Path,
        options: Options,
        metadata: &Metadata,
        free_bytes: FreeBytes<'_>,
    ) -> Result<(), Error> {
        let backup = backup::path(database);
        match self {
            Self::Absent | Self::Upgraded { sealed: true } => Ok(()),
            Self::Upgraded { sealed: false } => backup::reseal(database, metadata),
            Self::Predecessor(predecessor) => {
                {
                    let file = ReadOnlyDatabase::open(&backup)?;
                    backup::preserve(
                        &file.begin_read()?,
                        &backup,
                        predecessor.catalog()?,
                        metadata,
                        free_bytes,
                    )?;
                }
                migrate(
                    &Database::builder()
                        .set_cache_size(options.cache_bytes)
                        .open(&backup)?,
                    predecessor,
                )?;
                backup::reseal(database, metadata)
            }
        }
    }
}

impl Predecessor {
    fn identify(manifest: &[u8]) -> Result<Self, Error> {
        Self::pinned(manifest).ok_or(Error::Incompatible("unknown store catalog"))
    }

    fn pinned(manifest: &[u8]) -> Option<Self> {
        let mut digest = Digest::new();
        digest.update(manifest);
        match digest.finish().as_str() {
            BEFORE_ANALYTICS => Some(Self::BeforeAnalytics),
            BEFORE_INCIDENTS => Some(Self::BeforeIncidents),
            _ => None,
        }
    }

    fn catalog(self) -> Result<Catalog, Error> {
        static BEFORE_ANALYTICS_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_INCIDENTS_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        const INCIDENTS: &[&str] = &["model_incident", "model_guidance_clear"];
        const ANALYTICS: &[&str] = &[
            "model_incident",
            "model_guidance_clear",
            "usage_analytics_request",
        ];
        let (tables, removed) = match self {
            Self::BeforeAnalytics => (&BEFORE_ANALYTICS_TABLES, ANALYTICS),
            Self::BeforeIncidents => (&BEFORE_INCIDENTS_TABLES, INCIDENTS),
        };
        let catalog = Catalog::new(
            1,
            tables.get_or_init(|| {
                import::catalog(DatabaseKind::Core)
                    .tables()
                    .iter()
                    .copied()
                    .filter(|table| !removed.contains(&table.name))
                    .collect()
            }),
        );
        if Self::pinned(&catalog.manifest()) != Some(self) {
            return Err(Error::Incompatible(
                "predecessor catalog no longer matches its pinned manifest",
            ));
        }
        Ok(catalog)
    }

    fn converter(self, table: &str) -> Option<Convert> {
        if self != Self::BeforeAnalytics {
            return None;
        }
        match table {
            "session" => Some(session),
            "session_task" => Some(task),
            "session_compaction_job" => Some(job),
            "session_provider_request" => Some(request),
            _ => None,
        }
    }
}

fn migrate(database: &Database, predecessor: Predecessor) -> Result<(), Error> {
    let previous = predecessor.catalog()?.names();
    let target = import::catalog(DatabaseKind::Core);
    let mut write = database.begin_write()?;
    write.set_durability(Durability::Immediate)?;
    for name in target.names() {
        if !previous.contains(&name) {
            drop(write.open_table(definition(name))?);
        }
    }
    for name in &previous {
        if let Some(convert) = predecessor.converter(name) {
            rewrite(&write, name, convert)?;
        }
    }
    if !previous.contains(FACTS) {
        backfill(&write)?;
    }
    {
        let mut metadata = write.open_table(definition("storage_metadata"))?;
        metadata.insert(MANIFEST, target.manifest().as_slice())?;
    }
    write.commit().map_err(commit_error)
}

fn rewrite(write: &WriteTransaction, name: &'static str, convert: Convert) -> Result<(), Error> {
    let mut table = write.open_table(definition(name))?;
    let mut after: Option<Vec<u8>> = None;
    loop {
        let batch = table
            .range::<&[u8]>((
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
            ))?
            .take(BATCH)
            .map(|entry| {
                let (key, value) = entry?;
                Ok((key.value().to_vec(), value.value().to_vec()))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        for (key, value) in &batch {
            table.insert(key.as_slice(), convert(value)?.as_slice())?;
        }
        if batch.len() < BATCH {
            return Ok(());
        }
        after = batch.last().map(|(key, _)| key.clone());
    }
}

fn backfill(write: &WriteTransaction) -> Result<(), Error> {
    let requests = write.open_table(definition(RequestTable::NAME))?;
    let sessions = write.open_table(definition(SessionTable::NAME))?;
    let tasks = write.open_table(definition(TaskTable::NAME))?;
    let mut facts = write.open_table(definition(FACTS))?;
    let index = &UsageAnalyticsRequestTable::INDEXES[0];
    let mut entries = write.open_table(definition(index.name))?;
    let mut after: Option<Vec<u8>> = None;
    loop {
        let batch = requests
            .range::<&[u8]>((
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
            ))?
            .take(BATCH)
            .map(|entry| {
                let (key, value) = entry?;
                Ok((key.value().to_vec(), value.value().to_vec()))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        for (key, value) in &batch {
            let Some(fact) = derive(&RequestTable::decode(value)?, &sessions, &tasks, false)?
            else {
                continue;
            };
            let primary = UsageAnalyticsRequestTable::primary_key(&fact);
            if primary != *key {
                return Err(Error::Incompatible(
                    "usage fact identity differs from its request",
                ));
            }
            if facts.get(primary.as_slice())?.is_some() {
                continue;
            }
            let logical = UsageAnalyticsRequestTable::index_key(index, &fact)?
                .ok_or(Error::Incompatible("usage fact has no time index key"))?;
            facts.insert(
                primary.as_slice(),
                UsageAnalyticsRequestTable::encode(&fact)?.as_slice(),
            )?;
            entries.insert(
                index_storage_key(index, &logical, &primary).as_slice(),
                primary.as_slice(),
            )?;
        }
        if batch.len() < BATCH {
            return Ok(());
        }
        after = batch.last().map(|(key, _)| key.clone());
    }
}

fn derive(
    request: &Request,
    sessions: &impl ReadableTable<&'static [u8], &'static [u8]>,
    tasks: &impl ReadableTable<&'static [u8], &'static [u8]>,
    frozen: bool,
) -> Result<Option<UsageAnalyticsRequest>, Error> {
    let lookup = |id: &LosslessString| -> Result<Option<Session>, Error> {
        let Some(value) = sessions.get(key(id).as_slice())? else {
            return Ok(None);
        };
        let value = if frozen {
            session(value.value())?
        } else {
            value.value().to_vec()
        };
        SessionTable::decode(&value).map(Some)
    };
    let Some(owner) = lookup(&request.session_id)? else {
        return Ok(None);
    };
    let mut path = Vec::new();
    let mut seen = BTreeSet::new();
    let mut current = Some(request.session_id.clone());
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return Err(Error::Domain {
                kind: "usage_task_path",
                message: "Session ancestry contains a cycle",
            });
        }
        let Some(row) = lookup(&id)? else {
            break;
        };
        if tasks.get(key(&id).as_slice())?.is_some() {
            path.push(id);
        }
        current = row.parent_id;
    }
    Ok(Some(UsageAnalyticsRequest {
        id: request.id.clone(),
        session_id: request.session_id.clone(),
        project_id: owner.project_id,
        directory: owner.directory,
        workspace_id: owner.workspace_id,
        session_updated: owner.time_updated,
        agent: request.agent.clone(),
        source: request.source.clone(),
        model: request.model.clone(),
        usage_anchor: None,
        task_path: Document::from_domain(&path)?,
        request: request.request,
        attempts: request.attempts,
        continuation: request.continuation.clone(),
        invalidation: request.invalidation.clone(),
        prompt_cache_key: LosslessString::from_utf16(
            request.prompt_cache_key.code_units().take(8).collect(),
        ),
        cache_read_reported: request.cache_read_reported,
        tokens: request.tokens.clone(),
        cost: request.cost,
        timing: request.timing.clone(),
        time_created: request.time_created,
    }))
}

fn key(id: &LosslessString) -> Vec<u8> {
    crate::tuple_key(&[crate::KeyPart::String(id)])
}

fn backfilled_rows(original: &ReadTransaction, upgraded: &ReadTransaction) -> Result<(), Error> {
    let requests = original.open_table(definition(RequestTable::NAME))?;
    let sessions = original.open_table(definition(SessionTable::NAME))?;
    let tasks = original.open_table(definition(TaskTable::NAME))?;
    let facts = upgraded.open_table(definition(FACTS))?;
    let index = &UsageAnalyticsRequestTable::INDEXES[0];
    let entries = upgraded.open_table(definition(index.name))?;
    let mut stored = facts.iter()?;
    let mut count = 0u64;
    for entry in requests.iter()? {
        let (_, value) = entry?;
        let Some(fact) = derive(
            &RequestTable::decode(&request(value.value())?)?,
            &sessions,
            &tasks,
            true,
        )?
        else {
            continue;
        };
        let primary = UsageAnalyticsRequestTable::primary_key(&fact);
        let logical = UsageAnalyticsRequestTable::index_key(index, &fact)?
            .ok_or(Error::Incompatible("usage fact has no time index key"))?;
        let Some((stored_key, stored_value)) = stored.next().transpose()? else {
            return Err(mismatch());
        };
        if stored_key.value() != primary.as_slice()
            || stored_value.value() != UsageAnalyticsRequestTable::encode(&fact)?.as_slice()
            || entries
                .get(index_storage_key(index, &logical, &primary).as_slice())?
                .is_none_or(|value| value.value() != primary.as_slice())
        {
            return Err(mismatch());
        }
        count += 1;
    }
    if stored.next().is_some() || entries.len()? != count {
        return Err(mismatch());
    }
    Ok(())
}

fn migrated_rows(
    original: &ReadTransaction,
    upgraded: &ReadTransaction,
    predecessor: Predecessor,
) -> Result<(), Error> {
    let previous = predecessor.catalog()?.names();
    for name in import::catalog(DatabaseKind::Core).names() {
        if !previous.contains(FACTS)
            && [FACTS, UsageAnalyticsRequestTable::INDEXES[0].name].contains(&name)
        {
            continue;
        }
        let table = upgraded.open_table(definition(name))?;
        let mut rows = table.iter()?;
        if !previous.contains(&name) {
            if rows.next().is_some() {
                return Err(mismatch());
            }
            continue;
        }
        let source = original.open_table(definition(name))?;
        let mut source = source.iter()?;
        let convert = predecessor.converter(name);
        loop {
            match (source.next().transpose()?, rows.next().transpose()?) {
                (None, None) => break,
                (Some((key, value)), Some((upgraded_key, upgraded_value)))
                    if key.value() == upgraded_key.value() =>
                {
                    let expected = match convert {
                        Some(convert) => convert(value.value())?,
                        None => value.value().to_vec(),
                    };
                    let same = expected == upgraded_value.value()
                        || (name == "storage_metadata" && key.value() == MANIFEST);
                    if !same {
                        return Err(mismatch());
                    }
                }
                _ => return Err(mismatch()),
            }
        }
    }
    if !previous.contains(FACTS) {
        backfilled_rows(original, upgraded)?;
    }
    Ok(())
}

fn mismatch() -> Error {
    Error::Rejected("upgraded pre-prune backup differs from its pre-upgrade copy")
}

fn stored_manifest(read: &ReadTransaction) -> Result<Vec<u8>, Error> {
    read.open_table(definition("storage_metadata"))?
        .get(MANIFEST)?
        .map(|value| value.value().to_vec())
        .ok_or(Error::Incompatible("missing catalog manifest"))
}

macro_rules! frozen {
    ($convert:ident, $table:ident, $record:ident, $added:ident, { $($field:ident: $ty:ty),* $(,)? }) => {
        fn $convert(mut input: &[u8]) -> Result<Vec<u8>, Error> {
            if input.first() != Some(&1) {
                return Err(Error::Incompatible("domain record version"));
            }
            input = &input[1..];
            let record = $record {
                $($field: <$ty as Field>::decode(&mut input)?,)*
                $added: None,
            };
            if !input.is_empty() {
                return Err(Error::Incompatible("trailing domain record bytes"));
            }
            <$table as TableSpec>::encode(&record)
        }
    };
}

frozen!(session, SessionTable, Session, usage_pruned_through, {
    id: LosslessString, project_id: LosslessString, workspace_id: Option<LosslessString>, parent_id: Option<LosslessString>,
    fork_session_id: Option<LosslessString>, fork_message_id: Option<LosslessString>, fork_seq: Option<i64>, directory: LosslessString,
    path: Option<LosslessString>, title: LosslessString, cost: f64, tokens_input: i64, tokens_output: i64, tokens_reasoning: i64,
    tokens_cache_read: i64, tokens_cache_write: i64, revert: Option<Document<session_revert::Revert>>,
    permission: Option<Document<permission::Ruleset>>, autonomy: Option<JsonValue>, autonomy_revision: i64, orchestration_revision: i64,
    agent: Option<LosslessString>, model: Option<Document<model::Ref>>, profile_binding: Option<Document<session_event::ProfileBinding>>,
    daybreak: Option<LosslessString>, time_created: i64, time_updated: i64, time_archived: Option<i64>, time_active: Option<i64>,
    time_pinned: Option<i64>, time_suspended: Option<i64>
});

frozen!(task, TaskTable, Task, usage_anchor, {
    session_id: LosslessString, parent_id: LosslessString, parent_assistant_message_id: LosslessString, tool_call_id: LosslessString,
    input_id: LosslessString, description: LosslessString, agent: LosslessString, model: Document<model::Ref>, prompt_digest: LosslessString,
    background: i64, delivery: LosslessString, state: LosslessString, progress: Option<LosslessString>, progress_time: Option<i64>,
    question_id: Option<LosslessString>, question: Option<LosslessString>, question_data: Option<Document<domain::Json>>, question_time: Option<i64>,
    attempt_started: i64, owner_pid: Option<i64>, owner_started: Option<LosslessString>, revision: i64, time_created: i64, time_updated: i64
});

frozen!(job, JobTable, Job, usage_anchor, {
    id: LosslessString, session_id: LosslessString, legacy_input_id: Option<LosslessString>, trigger: LosslessString,
    requested_through_message_id: LosslessString, requested_through_seq: i64, base_context_revision: i64, target_max_input_tokens: Option<i64>,
    config_digest: Option<LosslessString>, status: LosslessString, lease_owner: Option<LosslessString>, lease_expires_at: Option<i64>, attempts: i64,
    manifest_digest: Option<LosslessString>, error_code: Option<LosslessString>, error_message: Option<LosslessString>, time_created: i64, time_started: Option<i64>, time_ended: Option<i64>
});

frozen!(request, RequestTable, Request, usage_anchor, {
    id: LosslessString, session_id: LosslessString, input_id: Option<LosslessString>, assistant_message_id: Option<LosslessString>,
    connection_identity_digest: Option<LosslessString>, source: LosslessString, agent: LosslessString, model: Document<model::Ref>,
    route_id: LosslessString, prompt_cache_key: LosslessString, system_digest: LosslessString, tool_digest: LosslessString,
    request: i64, attempts: i64, invalidation: LosslessString, continuation: LosslessString, cache_read_reported: Option<i64>,
    timing: Option<Document<provider_request::Timing>>, cost: Option<f64>, tokens: Document<token_usage::Info>, time_created: i64
});
