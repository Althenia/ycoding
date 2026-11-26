mod decimal;

use crate::{
    Catalog, Error, Metadata, Options, TableDeclaration, TableSpec, backup,
    catalog::definition,
    digest::Digest,
    engine::index_storage_key,
    metadata::{commit_error, inspect},
    native::{self, DatabaseKind},
    resources::{
        KvTable, Request, RequestTable, UsageAnalyticsRequest, UsageAnalyticsRequestTable,
    },
    session::{Document, Job, JobTable, Session, SessionTable, Task, TaskTable, codec::Field},
};
use redb::{
    Database, DatabaseError, Durability, ReadOnlyDatabase, ReadTransaction, ReadableDatabase,
    ReadableTable, ReadableTableMetadata, WriteTransaction,
};
use std::{collections::BTreeSet, io::ErrorKind, ops::Bound, path::Path, sync::OnceLock};
use ycoding_schema::{
    JsonValue, LosslessString, domain, model, permission, provider_request, session_event,
    session_origin, session_revert, session_scope, token_usage,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Predecessor {
    BeforeAnalytics,
    BeforeIncidents,
    BeforeMcpEvents,
    BeforeUsage,
    BeforeSessionOrigin,
    BeforeSessionScope,
    BeforeUsageDecimal,
    BeforeNonnegativeUsageCost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Current,
    Upgraded(Predecessor),
}

const BEFORE_ANALYTICS: &str = "843dd129682457a44d2a4ed4cb82f6e701a4d5a202cb2fb8073a6e1bd52dc097";
const BEFORE_INCIDENTS: &str = "1f4a70c9d374ab7c72c2c008b215b0a2ffa311998c8642852d21a561293e01a4";
const BEFORE_MCP_EVENTS: &str = "eae73fc56ca9922bb834c6dc96fc72fafce5b2daf9c948f087edacdb727ae15b";
const BEFORE_USAGE: &str = "926944e936a761b1887f81c0974ca375837f6c702b13983f1948e1d4a5c4dd11";
const BEFORE_SESSION_ORIGIN: &str =
    "be6bbcc6f97dd0ee73b8f23456deb4bd24c1efff8f2f83d6f25d6b2970656f19";
const BEFORE_SESSION_SCOPE: &str =
    "74e3d3f1afae2aaf16095f15ba056fd9b0d28974d161f5734911318c34457045";
const BATCH: usize = 256;
const MANIFEST: &[u8] = b"catalog_manifest";
const FACTS: &str = "usage_analytics_request";
const ADDED_SINCE_USAGE: &[&str] = &[
    "usage_cell",
    "usage_cell_leaf",
    "usage_cell_sample",
    "usage_cell_unpriced",
    "usage_cell_backfill",
    "coordination_group",
    "coordination_member",
];

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
    let mut builder = Database::builder();
    builder.set_cache_size(options.cache_bytes);
    match builder.open_read_only(path) {
        Ok(database) => upgrade_open(path, path, database, options, free_bytes),
        Err(DatabaseError::RepairAborted) => backup::recover(path, |staged| {
            drop(builder.open(staged)?);
            upgrade_open(
                path,
                staged,
                builder.open_read_only(staged)?,
                options,
                free_bytes,
            )
        }),
        Err(error) => Err(error.into()),
    }
}

fn upgrade_open(
    path: &Path,
    source: &Path,
    database: ReadOnlyDatabase,
    options: Options,
    free_bytes: FreeBytes<'_>,
) -> Result<Outcome, Error> {
    let target = native::catalog(DatabaseKind::Core);
    let read = database.begin_read()?;
    let manifest = stored_manifest(&read)?;
    let predecessor = Predecessor::identify(&manifest)?;
    let metadata = inspect(&read, predecessor.catalog()?)?;
    #[cfg(target_os = "macos")]
    if manifest == target.manifest() {
        warm_validation_source(source, options.cache_bytes);
    }
    let mut budget = decimal::Budget::default();
    let decimals = decimal::prepare(&read, predecessor.catalog()?, &mut budget)?;
    let current = manifest == target.manifest() && decimals.is_none();
    let pruned = Pruned::inspect(path, &metadata, &mut budget)?;
    if current && matches!(&pruned, Pruned::Absent | Pruned::Upgraded { sealed: true }) {
        return Ok(Outcome::Current);
    }
    if !current {
        backup::preserve(&read, path, predecessor.catalog()?, &metadata, free_bytes)?;
    }
    drop(read);
    drop(database);
    pruned.upgrade(path, options, &metadata, free_bytes)?;
    if !current {
        migrate(
            &Database::builder()
                .set_cache_size(options.cache_bytes)
                .open(source)?,
            predecessor,
            decimals,
        )?;
    }
    Ok(Outcome::Upgraded(predecessor))
}

#[cfg(target_os = "macos")]
fn warm_validation_source(source: &Path, cache_bytes: usize) {
    use std::{
        fs::OpenOptions,
        io::Read,
        os::unix::fs::OpenOptionsExt,
        time::{Duration, Instant},
    };

    const O_NONBLOCK: i32 = 0x0004;
    const O_NOFOLLOW: i32 = 0x0100;
    const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

    let Ok(file) = OpenOptions::new()
        .read(true)
        .custom_flags(O_NONBLOCK | O_NOFOLLOW)
        .open(source)
    else {
        return;
    };
    let Ok(metadata) = file.metadata() else {
        return;
    };
    let bytes = metadata.len();
    if !metadata.is_file() || bytes <= cache_bytes as u64 || bytes > MAX_BYTES {
        return;
    }
    let mut input = file.take(bytes);
    let mut buffer = vec![0; 1024 * 1024];
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(500)
        && matches!(input.read(&mut buffer), Ok(count) if count != 0)
    {}
}

enum Pruned {
    Absent,
    Predecessor {
        predecessor: Predecessor,
        decimals: Option<decimal::Plan>,
    },
    Upgraded {
        sealed: bool,
    },
}

impl Pruned {
    fn inspect(
        database: &Path,
        metadata: &Metadata,
        budget: &mut decimal::Budget,
    ) -> Result<Self, Error> {
        let backup = backup::path(database);
        if !backup.try_exists()? {
            return Ok(Self::Absent);
        }
        let sealed = backup::sealed(database, metadata)?;
        let file = backup::open_copy(&backup)?;
        let read = file.begin_read()?;
        let manifest = stored_manifest(&read)?;
        let copy = backup::upgrade_path(&backup);
        let target = native::catalog(DatabaseKind::Core);
        let decimals = if manifest == target.manifest() {
            decimal::prepare(&read, target, budget)?
        } else {
            None
        };
        if manifest == target.manifest() && decimals.is_none() {
            if inspect(&read, target)? != *metadata {
                return Err(Error::Rejected("pre-prune backup identity mismatch"));
            }
            let original = match backup::open_copy(&copy) {
                Err(Error::Io(error)) if error.kind() == ErrorKind::NotFound => {
                    if sealed == Some(true) {
                        return Ok(Self::Upgraded { sealed: true });
                    }
                    return Err(Error::Rejected(
                        "upgraded pre-prune backup has no pre-upgrade copy",
                    ));
                }
                result => result?,
            };
            let original = original.begin_read()?;
            let predecessor = Predecessor::identify(&stored_manifest(&original)?)?;
            if inspect(&original, predecessor.catalog()?)? != *metadata {
                return Err(Error::Rejected("pre-upgrade copy identity mismatch"));
            }
            migrated_rows(&original, &read, predecessor, budget)?;
            return Ok(Self::Upgraded {
                sealed: sealed == Some(true),
            });
        }
        let predecessor = Predecessor::identify(&manifest)?;
        let decimals = match decimals {
            Some(plan) => Some(plan),
            None => decimal::prepare(&read, predecessor.catalog()?, budget)?,
        };
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
        Ok(Self::Predecessor {
            predecessor,
            decimals,
        })
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
            Self::Upgraded { sealed: false } => {
                backup::reseal(database, native::catalog(DatabaseKind::Core), metadata)
            }
            Self::Predecessor {
                predecessor,
                decimals,
            } => {
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
                    decimals,
                )?;
                backup::reseal(database, native::catalog(DatabaseKind::Core), metadata)
            }
        }
    }
}

impl Predecessor {
    fn identify(manifest: &[u8]) -> Result<Self, Error> {
        Self::pinned(manifest).ok_or(Error::Incompatible("unknown store catalog"))
    }

    fn pinned(manifest: &[u8]) -> Option<Self> {
        if manifest == native::catalog(DatabaseKind::Core).manifest() {
            return Some(Self::BeforeNonnegativeUsageCost);
        }
        if manifest == Catalog::new(4, native::catalog(DatabaseKind::Core).tables()).manifest() {
            return Some(Self::BeforeUsageDecimal);
        }
        let mut digest = Digest::new();
        digest.update(manifest);
        match digest.finish().as_str() {
            BEFORE_ANALYTICS => Some(Self::BeforeAnalytics),
            BEFORE_INCIDENTS => Some(Self::BeforeIncidents),
            BEFORE_MCP_EVENTS => Some(Self::BeforeMcpEvents),
            BEFORE_USAGE => Some(Self::BeforeUsage),
            BEFORE_SESSION_ORIGIN => Some(Self::BeforeSessionOrigin),
            BEFORE_SESSION_SCOPE => Some(Self::BeforeSessionScope),
            _ => None,
        }
    }

    fn catalog(self) -> Result<Catalog, Error> {
        static BEFORE_ANALYTICS_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_INCIDENTS_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_MCP_EVENTS_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_USAGE_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_SESSION_ORIGIN_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_SESSION_SCOPE_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_USAGE_DECIMAL_TABLES: OnceLock<Vec<TableDeclaration>> = OnceLock::new();
        static BEFORE_NONNEGATIVE_USAGE_COST_TABLES: OnceLock<Vec<TableDeclaration>> =
            OnceLock::new();
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
        let (tables, removed, version) = match self {
            Self::BeforeAnalytics => (&BEFORE_ANALYTICS_TABLES, ANALYTICS, 1),
            Self::BeforeIncidents => (&BEFORE_INCIDENTS_TABLES, INCIDENTS, 1),
            Self::BeforeMcpEvents => (&BEFORE_MCP_EVENTS_TABLES, MCP_EVENTS, 1),
            Self::BeforeUsage => (&BEFORE_USAGE_TABLES, &[] as &[&str], 1),
            Self::BeforeSessionOrigin => (&BEFORE_SESSION_ORIGIN_TABLES, &[] as &[&str], 2),
            Self::BeforeSessionScope => (&BEFORE_SESSION_SCOPE_TABLES, &[] as &[&str], 3),
            Self::BeforeUsageDecimal => (&BEFORE_USAGE_DECIMAL_TABLES, &[] as &[&str], 4),
            Self::BeforeNonnegativeUsageCost => {
                (&BEFORE_NONNEGATIVE_USAGE_COST_TABLES, &[] as &[&str], 5)
            }
        };
        let catalog = Catalog::new(
            version,
            tables.get_or_init(|| {
                native::catalog(DatabaseKind::Core)
                    .tables()
                    .iter()
                    .copied()
                    .filter(|table| {
                        !removed.contains(&table.name)
                            && (version >= 2 || !ADDED_SINCE_USAGE.contains(&table.name))
                    })
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
        match (self, table) {
            (Self::BeforeUsageDecimal | Self::BeforeNonnegativeUsageCost, _) => None,
            (Self::BeforeAnalytics, "session") => Some(session),
            (Self::BeforeAnalytics, "session_task") => Some(task),
            (Self::BeforeAnalytics, "session_compaction_job") => Some(job),
            (Self::BeforeAnalytics, "session_provider_request") => Some(request),
            (Self::BeforeSessionScope, "session") => Some(session_without_scope),
            (_, "session") => Some(session_without_origin),
            _ => None,
        }
    }

    fn backfills_origins(self) -> bool {
        !matches!(
            self,
            Self::BeforeSessionScope | Self::BeforeUsageDecimal | Self::BeforeNonnegativeUsageCost
        )
    }
}

fn migrate(
    database: &Database,
    predecessor: Predecessor,
    decimals: Option<decimal::Plan>,
) -> Result<(), Error> {
    let previous = predecessor.catalog()?.names();
    let target = native::catalog(DatabaseKind::Core);
    let mut write = database.begin_write()?;
    write.set_durability(Durability::Immediate)?;
    write.set_quick_repair(true);
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
    if predecessor.backfills_origins() {
        backfill_origins(&write)?;
    }
    if !previous.contains(FACTS) {
        backfill(&write)?;
    }
    if let Some(decimals) = decimals {
        decimals.apply(&write)?;
    }
    {
        let mut metadata = write.open_table(definition("storage_metadata"))?;
        metadata.insert(MANIFEST, target.manifest().as_slice())?;
        metadata.insert(
            b"catalog_version".as_slice(),
            target.version.to_be_bytes().as_slice(),
        )?;
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

fn backfill_origins(write: &WriteTransaction) -> Result<(), Error> {
    let mapped = executors(&write.open_table(definition(KvTable::NAME))?)?;
    let mut sessions = write.open_table(definition(SessionTable::NAME))?;
    for id in &mapped {
        let key = key(id);
        let Some(value) = sessions
            .get(key.as_slice())?
            .map(|value| value.value().to_vec())
        else {
            continue;
        };
        let updated = tagged(&value, &mapped)?;
        if updated != value {
            sessions.insert(key.as_slice(), updated.as_slice())?;
        }
    }
    Ok(())
}

fn executors(
    kv: &impl ReadableTable<&'static [u8], &'static [u8]>,
) -> Result<BTreeSet<LosslessString>, Error> {
    let mut mapped = BTreeSet::new();
    for entry in kv.iter()? {
        let (_, value) = entry?;
        let row = KvTable::decode(value.value())?;
        if !mapped_key(&row.key) {
            continue;
        }
        if let JsonValue::Object(object) = row.value.value()
            && let Some(JsonValue::String(id)) = object.get(&"sessionID".into())
        {
            mapped.insert(id.clone());
        }
    }
    Ok(mapped)
}

fn mapped_key(key: &LosslessString) -> bool {
    let units = key.code_units().collect::<Vec<_>>();
    let tail = |prefix: &str| {
        let prefix = prefix.encode_utf16().collect::<Vec<_>>();
        units.strip_prefix(prefix.as_slice())
    };
    let dot = u16::from(b'.');
    if let Some(rest) = tail("dots.cca.thread.") {
        return rest.first() != Some(&dot) && rest.contains(&dot) && units.last() != Some(&dot);
    }
    tail("dots.cca.unattributed.").is_some_and(|rest| !rest.is_empty())
}

fn tagged(value: &[u8], mapped: &BTreeSet<LosslessString>) -> Result<Vec<u8>, Error> {
    let mut row = SessionTable::decode(value)?;
    if row.origin.is_none() && mapped.contains(&row.id) {
        row.origin = Some(session_origin::Origin::DotsExecutor.as_str().into());
        return SessionTable::encode(&row);
    }
    Ok(value.to_vec())
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
        outcome: request.outcome.clone(),
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
    budget: &mut decimal::Budget,
) -> Result<(), Error> {
    let previous = predecessor.catalog()?.names();
    let mapped = executors(&original.open_table(definition(KvTable::NAME))?)?;
    for name in native::catalog(DatabaseKind::Core).names() {
        if decimal::changed(name) && previous.contains(&name) {
            continue;
        }
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
                    let mut expected = match convert {
                        Some(convert) => convert(value.value())?,
                        None => value.value().to_vec(),
                    };
                    if name == SessionTable::NAME && predecessor.backfills_origins() {
                        expected = tagged(&expected, &mapped)?;
                    }
                    let same = expected == upgraded_value.value()
                        || (name == "storage_metadata"
                            && [MANIFEST, b"catalog_version"].contains(&key.value()));
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
    decimal::verify(original, upgraded, predecessor.catalog()?, budget)?;
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
    ($convert:ident, $table:ident, $record:ident, { $($added:ident: $value:expr),* $(,)? }, { $($field:ident: $ty:ty),* $(,)? }) => {
        fn $convert(mut input: &[u8]) -> Result<Vec<u8>, Error> {
            if input.first() != Some(&1) {
                return Err(Error::Incompatible("domain record version"));
            }
            input = &input[1..];
            let record = $record {
                $($field: <$ty as Field>::decode(&mut input)?,)*
                $($added: $value,)*
            };
            if !input.is_empty() {
                return Err(Error::Incompatible("trailing domain record bytes"));
            }
            <$table as TableSpec>::encode(&record)
        }
    };
}

frozen!(session, SessionTable, Session, { usage_pruned_through: None, origin: None, scope: bound() }, {
    id: LosslessString, project_id: LosslessString, workspace_id: Option<LosslessString>, parent_id: Option<LosslessString>,
    fork_session_id: Option<LosslessString>, fork_message_id: Option<LosslessString>, fork_seq: Option<i64>, directory: LosslessString,
    path: Option<LosslessString>, title: LosslessString, cost: f64, tokens_input: i64, tokens_output: i64, tokens_reasoning: i64,
    tokens_cache_read: i64, tokens_cache_write: i64, revert: Option<Document<session_revert::Revert>>,
    permission: Option<Document<permission::Ruleset>>, autonomy: Option<JsonValue>, autonomy_revision: i64, orchestration_revision: i64,
    agent: Option<LosslessString>, model: Option<Document<model::Ref>>, profile_binding: Option<Document<session_event::ProfileBinding>>,
    daybreak: Option<LosslessString>, time_created: i64, time_updated: i64, time_archived: Option<i64>, time_active: Option<i64>,
    time_pinned: Option<i64>, time_suspended: Option<i64>
});

frozen!(session_without_origin, SessionTable, Session, { origin: None, scope: bound() }, {
    id: LosslessString, project_id: LosslessString, workspace_id: Option<LosslessString>, parent_id: Option<LosslessString>,
    fork_session_id: Option<LosslessString>, fork_message_id: Option<LosslessString>, fork_seq: Option<i64>, directory: LosslessString,
    path: Option<LosslessString>, title: LosslessString, cost: f64, tokens_input: i64, tokens_output: i64, tokens_reasoning: i64,
    tokens_cache_read: i64, tokens_cache_write: i64, revert: Option<Document<session_revert::Revert>>,
    permission: Option<Document<permission::Ruleset>>, autonomy: Option<JsonValue>, autonomy_revision: i64, orchestration_revision: i64,
    agent: Option<LosslessString>, model: Option<Document<model::Ref>>, profile_binding: Option<Document<session_event::ProfileBinding>>,
    daybreak: Option<LosslessString>, time_created: i64, time_updated: i64, time_archived: Option<i64>, time_active: Option<i64>,
    time_pinned: Option<i64>, time_suspended: Option<i64>, usage_pruned_through: Option<i64>
});

frozen!(session_without_scope, SessionTable, Session, { scope: bound() }, {
    id: LosslessString, project_id: LosslessString, workspace_id: Option<LosslessString>, parent_id: Option<LosslessString>,
    fork_session_id: Option<LosslessString>, fork_message_id: Option<LosslessString>, fork_seq: Option<i64>, directory: LosslessString,
    path: Option<LosslessString>, title: LosslessString, cost: f64, tokens_input: i64, tokens_output: i64, tokens_reasoning: i64,
    tokens_cache_read: i64, tokens_cache_write: i64, revert: Option<Document<session_revert::Revert>>,
    permission: Option<Document<permission::Ruleset>>, autonomy: Option<JsonValue>, autonomy_revision: i64, orchestration_revision: i64,
    agent: Option<LosslessString>, model: Option<Document<model::Ref>>, profile_binding: Option<Document<session_event::ProfileBinding>>,
    daybreak: Option<LosslessString>, time_created: i64, time_updated: i64, time_archived: Option<i64>, time_active: Option<i64>,
    time_pinned: Option<i64>, time_suspended: Option<i64>, usage_pruned_through: Option<i64>, origin: Option<LosslessString>
});

fn bound() -> LosslessString {
    session_scope::Scope::Bound.as_str().into()
}

frozen!(task, TaskTable, Task, { usage_anchor: None }, {
    session_id: LosslessString, parent_id: LosslessString, parent_assistant_message_id: LosslessString, tool_call_id: LosslessString,
    input_id: LosslessString, description: LosslessString, agent: LosslessString, model: Document<model::Ref>, prompt_digest: LosslessString,
    background: i64, delivery: LosslessString, state: LosslessString, progress: Option<LosslessString>, progress_time: Option<i64>,
    question_id: Option<LosslessString>, question: Option<LosslessString>, question_data: Option<Document<domain::Json>>, question_time: Option<i64>,
    attempt_started: i64, owner_pid: Option<i64>, owner_started: Option<LosslessString>, revision: i64, time_created: i64, time_updated: i64
});

frozen!(job, JobTable, Job, { usage_anchor: None }, {
    id: LosslessString, session_id: LosslessString, legacy_input_id: Option<LosslessString>, trigger: LosslessString,
    requested_through_message_id: LosslessString, requested_through_seq: i64, base_context_revision: i64, target_max_input_tokens: Option<i64>,
    config_digest: Option<LosslessString>, status: LosslessString, lease_owner: Option<LosslessString>, lease_expires_at: Option<i64>, attempts: i64,
    manifest_digest: Option<LosslessString>, error_code: Option<LosslessString>, error_message: Option<LosslessString>, time_created: i64, time_started: Option<i64>, time_ended: Option<i64>
});

frozen!(request, RequestTable, Request, { usage_anchor: None, outcome: None }, {
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
        native::{self, DatabaseKind},
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
    const BOUND: &[u8] = &[
        0, 0, 0, 0, 0, 0, 0, 5, 0, b'b', 0, b'o', 0, b'u', 0, b'n', 0, b'd',
    ];

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
        native::catalog(DatabaseKind::Core)
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
                    .filter(|table| {
                        !ADDED.contains(&table.name)
                            && !super::ADDED_SINCE_USAGE.contains(&table.name)
                    })
                    .collect()
            }),
        )
    }

    fn added_since_usage() -> Vec<&'static str> {
        target()
            .tables()
            .iter()
            .filter(|table| super::ADDED_SINCE_USAGE.contains(&table.name))
            .flat_map(|table| {
                std::iter::once(table.name).chain(table.indexes.iter().map(|index| index.name))
            })
            .collect()
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
            origin: None,
            scope: "bound".into(),
        };
        let request = Request {
            outcome: None,
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
        {
            let mut table = write.open_table(definition(SessionTable::NAME)).unwrap();
            let mut legacy = SessionTable::encode(&owner).unwrap();
            assert!(legacy.ends_with(BOUND));
            legacy.truncate(legacy.len() - BOUND.len());
            assert_eq!(legacy.pop(), Some(0));
            table
                .insert(
                    SessionTable::primary_key(&owner).as_slice(),
                    legacy.as_slice(),
                )
                .unwrap();
        }
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
                        .filter(|(key, _)| key != MANIFEST && key != b"catalog_version")
                        .collect::<Vec<_>>(),
                    after[name]
                        .iter()
                        .filter(|(key, _)| key != MANIFEST && key != b"catalog_version")
                        .collect::<Vec<_>>()
                );
                assert_eq!(
                    after[name]
                        .iter()
                        .find(|(key, _)| key == b"catalog_version")
                        .map(|(_, value)| value.clone()),
                    Some(target().version.to_be_bytes().to_vec())
                );
                continue;
            }
            if name == SessionTable::NAME {
                let current = records
                    .iter()
                    .map(|(key, value)| (key.clone(), [value.as_slice(), &[0], BOUND].concat()))
                    .collect::<Vec<_>>();
                assert_eq!(&after[name], &current, "{name}");
                continue;
            }
            assert_eq!(&after[name], records, "{name}");
        }
        let added = ADDED
            .iter()
            .copied()
            .chain(added_since_usage())
            .collect::<Vec<_>>();
        assert_eq!(after.len(), before.len() + added.len());
        for name in added {
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
