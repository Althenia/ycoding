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
    BeforeMcpEvents,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Current,
    Upgraded(Predecessor),
}

const BEFORE_ANALYTICS: &str = "843dd129682457a44d2a4ed4cb82f6e701a4d5a202cb2fb8073a6e1bd52dc097";
const BEFORE_INCIDENTS: &str = "1f4a70c9d374ab7c72c2c008b215b0a2ffa311998c8642852d21a561293e01a4";
const BEFORE_MCP_EVENTS: &str = "eae73fc56ca9922bb834c6dc96fc72fafce5b2daf9c948f087edacdb727ae15b";
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
        inspect(&read, target)?;
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
            BEFORE_MCP_EVENTS => Some(Self::BeforeMcpEvents),
            _ => None,
        }
    }

    fn catalog(self) -> Result<Catalog, Error> {
        static BEFORE_ANALYTICS_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_INCIDENTS_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_MCP_EVENTS_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        const MCP_EVENTS: &[&str] = &["mcp_event_subscription", "mcp_event_outbox"];
        const INCIDENTS: &[&str] = &[
            "model_incident",
            "model_guidance_clear",
            "mcp_event_subscription",
            "mcp_event_outbox",
        ];
        const ANALYTICS: &[&str] = &[
            "model_incident",
            "model_guidance_clear",
            "usage_analytics_request",
            "mcp_event_subscription",
            "mcp_event_outbox",
        ];
        let (tables, removed) = match self {
            Self::BeforeAnalytics => (&BEFORE_ANALYTICS_TABLES, ANALYTICS),
            Self::BeforeIncidents => (&BEFORE_INCIDENTS_TABLES, INCIDENTS),
            Self::BeforeMcpEvents => (&BEFORE_MCP_EVENTS_TABLES, MCP_EVENTS),
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

#[cfg(test)]
mod mcp_events_tests {
    use super::{MANIFEST, Outcome, Predecessor, core, derive};
    use crate::{
        Catalog, Error, KeyPart, Metadata, Options, Store, TableDeclaration, TableSpec, backup,
        catalog::definition,
        engine::index_storage_key,
        import::{self, DatabaseKind},
        resources::{Request, RequestTable, UsageAnalyticsRequestTable},
        session::{Document, Session, SessionTable, TaskTable},
        tuple_key,
    };
    use redb::{
        Database, ReadOnlyDatabase, ReadableDatabase, ReadableTable, TableHandle, WriteTransaction,
    };
    use std::collections::BTreeMap;
    use std::ops::Bound;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicU64, Ordering};
    use ycoding_schema::LosslessString;

    const ADDED: [&str; 9] = [
        "mcp_event_subscription",
        "mcp_event_subscription_identity_idx",
        "mcp_event_subscription_session_idx",
        "mcp_event_subscription_expiry_idx",
        "mcp_event_outbox",
        "mcp_event_outbox_id_idx",
        "mcp_event_outbox_dedupe_idx",
        "mcp_event_outbox_dispatch_idx",
        "mcp_event_outbox_subscription_seq_idx",
    ];
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "ycoding-mcp-events-upgrade-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            std::fs::create_dir(&directory).unwrap();
            Self(directory)
        }

        fn path(&self) -> PathBuf {
            self.0.join("synthetic.redb")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn target() -> Catalog {
        import::catalog(DatabaseKind::Core)
    }

    fn previous() -> Catalog {
        static TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        Catalog::new(
            1,
            TABLES.get_or_init(|| {
                target()
                    .tables()
                    .iter()
                    .copied()
                    .filter(|table| !ADDED.contains(&table.name))
                    .collect()
            }),
        )
    }

    fn identity() -> Metadata {
        Metadata::new([84; 16], 7)
    }

    fn s(value: &str) -> LosslessString {
        value.into()
    }

    fn seed(path: &Path) {
        Store::initialize(path, Options::core(), previous(), identity())
            .unwrap()
            .shutdown()
            .unwrap();
        let database = Database::open(path).unwrap();
        let write = database.begin_write().unwrap();
        let owner = Session {
            id: s("ses_synthetic"),
            project_id: s("prj_synthetic"),
            workspace_id: Some(s("wrk_synthetic")),
            parent_id: None,
            fork_session_id: None,
            fork_message_id: None,
            fork_seq: None,
            directory: s("/synthetic-project"),
            path: None,
            title: s("synthetic"),
            cost: 1.5,
            tokens_input: 3,
            tokens_output: 4,
            tokens_reasoning: 5,
            tokens_cache_read: 6,
            tokens_cache_write: 7,
            revert: None,
            permission: None,
            autonomy: None,
            autonomy_revision: 0,
            orchestration_revision: 0,
            agent: Some(s("build")),
            model: None,
            profile_binding: None,
            daybreak: None,
            time_created: 10,
            time_updated: 20,
            time_archived: None,
            time_active: None,
            time_pinned: None,
            time_suspended: None,
            usage_pruned_through: Some(2),
        };
        let request = Request {
            id: s("prq_synthetic"),
            session_id: owner.id.clone(),
            input_id: None,
            assistant_message_id: None,
            connection_identity_digest: None,
            source: s("step"),
            agent: s("build"),
            model: Document::new(
                ycoding_schema::parse_json(r#"{"providerID":"synthetic","id":"model"}"#).unwrap(),
            )
            .unwrap(),
            usage_anchor: None,
            route_id: s("synthetic-route"),
            prompt_cache_key: s("synthetic-cache"),
            system_digest: s("synthetic-system"),
            tool_digest: s("synthetic-tools"),
            request: 3,
            attempts: 2,
            invalidation: s("first-request"),
            continuation: s("full"),
            cache_read_reported: Some(1),
            timing: None,
            cost: Some(0.25),
            tokens: Document::new(
                ycoding_schema::parse_json(
                    r#"{"input":3,"output":4,"reasoning":5,"cache":{"read":6,"write":7}}"#,
                )
                .unwrap(),
            )
            .unwrap(),
            time_created: 30,
        };
        put::<SessionTable>(&write, &owner);
        put::<RequestTable>(&write, &request);
        let mut fact = derive(
            &request,
            &write.open_table(definition(SessionTable::NAME)).unwrap(),
            &write.open_table(definition(TaskTable::NAME)).unwrap(),
            false,
        )
        .unwrap()
        .unwrap();
        fact.directory = s("/synthetic-captured-project");
        fact.session_updated = 11;
        put::<UsageAnalyticsRequestTable>(&write, &fact);
        write.commit().unwrap();
    }

    fn put<T: TableSpec>(write: &WriteTransaction, record: &T::Record) {
        let primary = T::primary_key(record);
        write
            .open_table(definition(T::NAME))
            .unwrap()
            .insert(primary.as_slice(), T::encode(record).unwrap().as_slice())
            .unwrap();
        for index in T::INDEXES {
            if let Some(logical) = T::index_key(index, record).unwrap() {
                write
                    .open_table(definition(index.name))
                    .unwrap()
                    .insert(
                        index_storage_key(index, &logical, &primary).as_slice(),
                        primary.as_slice(),
                    )
                    .unwrap();
            }
        }
    }

    type Rows = BTreeMap<String, Vec<(Vec<u8>, Vec<u8>)>>;

    fn rows(path: &Path) -> Rows {
        let database = ReadOnlyDatabase::open(path).unwrap();
        let read = database.begin_read().unwrap();
        read.list_tables()
            .unwrap()
            .map(|table| {
                let name = table.name().to_owned();
                let values = read
                    .open_table(redb::TableDefinition::<&[u8], &[u8]>::new(&name))
                    .unwrap()
                    .iter()
                    .unwrap()
                    .map(|entry| {
                        let (key, value) = entry.unwrap();
                        (key.value().to_vec(), value.value().to_vec())
                    })
                    .collect();
                (name, values)
            })
            .collect()
    }

    fn run(path: &Path) -> Result<Outcome, Error> {
        core(path, Options::core(), |_| Ok(u64::MAX))
    }

    fn bytes(path: &Path) -> Vec<Option<Vec<u8>>> {
        [
            path.to_path_buf(),
            backup::path(path),
            backup::marker(path),
            backup::upgrade_path(path),
            backup::upgrade_path(&backup::path(path)),
        ]
        .iter()
        .map(|path| std::fs::read(path).ok())
        .collect()
    }

    #[test]
    fn previous_current_manifest_requires_an_explicit_backed_up_upgrade() {
        let fixture = Fixture::new();
        let path = fixture.path();
        seed(&path);
        assert_eq!(previous().tables().len(), 56);
        assert_ne!(
            previous().manifest(),
            target().manifest(),
            "Events must extend the current native catalog"
        );
        assert!(Store::open(&path, Options::core(), target()).is_err());
        let before = rows(&path);
        assert_eq!(
            run(&path).unwrap(),
            Outcome::Upgraded(Predecessor::BeforeMcpEvents)
        );
        assert_eq!(rows(&backup::upgrade_path(&path)), before);
        let after = rows(&path);
        for (name, records) in &before {
            if name == "storage_metadata" {
                assert_eq!(
                    records
                        .iter()
                        .filter(|(key, _)| key != MANIFEST)
                        .collect::<Vec<_>>(),
                    after[name]
                        .iter()
                        .filter(|(key, _)| key != MANIFEST)
                        .collect::<Vec<_>>()
                );
                continue;
            }
            assert_eq!(&after[name], records, "{name}");
        }
        assert_eq!(after.len(), before.len() + ADDED.len());
        for name in ADDED {
            assert!(after[name].is_empty(), "{name}");
        }
        let store = Store::open(&path, Options::core(), target()).unwrap();
        assert_eq!(store.metadata(), &identity());
        let snapshot = store.snapshot().unwrap();
        let owner = snapshot
            .get::<SessionTable>(&tuple_key(&[KeyPart::String(&s("ses_synthetic"))]))
            .unwrap()
            .unwrap();
        assert_eq!(owner.usage_pruned_through, Some(2));
        assert_eq!(
            snapshot
                .scan::<RequestTable>(Bound::Unbounded, Bound::Unbounded, 2)
                .unwrap()[0]
                .attempts,
            2
        );
        let facts = snapshot
            .scan::<UsageAnalyticsRequestTable>(Bound::Unbounded, Bound::Unbounded, 2)
            .unwrap();
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].directory, s("/synthetic-captured-project"));
        assert_eq!(facts[0].session_updated, 11);
        drop(snapshot);
        store.shutdown().unwrap();
        let before_reopen = bytes(&path);
        assert_eq!(run(&path).unwrap(), Outcome::Current);
        assert_eq!(run(&path).unwrap(), Outcome::Current);
        assert_eq!(bytes(&path), before_reopen);
    }

    #[test]
    fn low_space_and_free_space_failure_preserve_the_previous_current_store_byte_for_byte() {
        for unavailable in [false, true] {
            let fixture = Fixture::new();
            let path = fixture.path();
            seed(&path);
            let before = bytes(&path);
            let result = core(&path, Options::core(), |_| {
                if unavailable {
                    return Err(Error::Rejected("synthetic free-space failure"));
                }
                Ok(0)
            });
            if unavailable {
                assert!(matches!(
                    result,
                    Err(Error::Rejected("synthetic free-space failure"))
                ));
            } else {
                assert!(matches!(
                    result,
                    Err(Error::Domain {
                        kind: "backup_space",
                        ..
                    })
                ));
            }
            assert_eq!(bytes(&path), before);
        }
    }

    #[test]
    fn corrupt_or_non_file_backup_is_never_replaced_and_blocks_the_upgrade() {
        for directory in [false, true] {
            let fixture = Fixture::new();
            let path = fixture.path();
            seed(&path);
            let copy = backup::upgrade_path(&path);
            if directory {
                std::fs::create_dir(&copy).unwrap();
            }
            if !directory {
                std::fs::write(&copy, b"synthetic corrupt backup").unwrap();
            }
            let before = bytes(&path);
            assert!(run(&path).is_err());
            assert_eq!(bytes(&path), before);
            assert_eq!(copy.is_dir(), directory);
        }
    }

    #[test]
    fn unknown_manifest_and_corrupt_source_are_refused_without_a_backup_or_write() {
        for corrupt in [false, true] {
            let fixture = Fixture::new();
            let path = fixture.path();
            if corrupt {
                std::fs::write(&path, b"synthetic corrupt database").unwrap();
            }
            if !corrupt {
                seed(&path);
                let database = Database::open(&path).unwrap();
                let write = database.begin_write().unwrap();
                write
                    .open_table(definition("storage_metadata"))
                    .unwrap()
                    .insert(MANIFEST, b"synthetic unknown catalog".as_slice())
                    .unwrap();
                write.commit().unwrap();
            }
            let before = bytes(&path);
            assert!(run(&path).is_err());
            assert_eq!(bytes(&path), before);
        }
    }

    #[test]
    fn a_recognized_manifest_with_a_missing_table_or_wrong_metadata_is_refused_without_writes() {
        for missing in [false, true] {
            let fixture = Fixture::new();
            let path = fixture.path();
            seed(&path);
            let database = Database::open(&path).unwrap();
            let write = database.begin_write().unwrap();
            if missing {
                assert!(write.delete_table(definition("session_usage")).unwrap());
            }
            if !missing {
                write
                    .open_table(definition("storage_metadata"))
                    .unwrap()
                    .insert(
                        b"record_codec_version".as_slice(),
                        999u64.to_be_bytes().as_slice(),
                    )
                    .unwrap();
            }
            write.commit().unwrap();
            drop(database);
            let before = bytes(&path);
            assert!(run(&path).is_err());
            assert_eq!(bytes(&path), before);
        }
    }

    #[test]
    fn a_different_synthetic_database_is_not_accepted_as_the_pre_upgrade_backup() {
        let fixture = Fixture::new();
        let path = fixture.path();
        seed(&path);
        Store::initialize(
            backup::upgrade_path(&path),
            Options::core(),
            previous(),
            Metadata::new([85; 16], 7),
        )
        .unwrap()
        .shutdown()
        .unwrap();
        let before = bytes(&path);
        assert!(run(&path).is_err());
        assert_eq!(bytes(&path), before);
    }

    #[test]
    fn previous_current_pre_prune_snapshot_keeps_its_own_copy_and_is_resealed() {
        let fixture = Fixture::new();
        let path = fixture.path();
        seed(&path);
        let store = Store::open(&path, Options::core(), previous()).unwrap();
        assert_eq!(
            store.prepare_pruning(1_000, |_| Ok(u64::MAX)).unwrap(),
            backup::Status::Ready
        );
        store.shutdown().unwrap();
        let original_backup = rows(&backup::path(&path));
        assert_eq!(
            run(&path).unwrap(),
            Outcome::Upgraded(Predecessor::BeforeMcpEvents)
        );
        assert_eq!(
            rows(&backup::upgrade_path(&backup::path(&path))),
            original_backup
        );
        let store = Store::open(&path, Options::core(), target()).unwrap();
        assert_eq!(
            store.prepare_pruning(1_001, |_| Ok(u64::MAX)).unwrap(),
            backup::Status::Ready
        );
        store.shutdown().unwrap();
        let restored = fixture.0.join("synthetic-restored.redb");
        std::fs::copy(backup::path(&path), &restored).unwrap();
        Store::open(&restored, Options::core(), target())
            .unwrap()
            .shutdown()
            .unwrap();
        let before = bytes(&path);
        assert_eq!(run(&path).unwrap(), Outcome::Current);
        assert_eq!(bytes(&path), before);
    }

    #[test]
    fn failed_preservation_of_the_pre_prune_copy_keeps_the_original_backup_and_marker() {
        let fixture = Fixture::new();
        let path = fixture.path();
        seed(&path);
        let store = Store::open(&path, Options::core(), previous()).unwrap();
        assert_eq!(
            store.prepare_pruning(1_000, |_| Ok(u64::MAX)).unwrap(),
            backup::Status::Ready
        );
        store.shutdown().unwrap();
        std::fs::create_dir(backup::upgrade_path(&backup::path(&path))).unwrap();
        let before = bytes(&path);
        assert!(run(&path).is_err());
        let after = bytes(&path);
        assert_eq!(after[..3], before[..3]);
        assert_eq!(after[4], before[4]);
    }
}
