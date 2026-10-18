use super::numeric;
use super::{
    BATCH_SIZE, Cancellation, ColumnType, Command, Delivery, DeliveryTable, Error, Intent,
    IntentTable, Maintenance, Operation, Query, REBUILD_SLICE_PAGES, REPORT_BYTES, REPORT_ROWS,
    ROW_BYTES, ReportRows, Request, Source, SourceRow, identifier, state,
};
use crate::engine::SnapshotView;
use crate::{Snapshot, TableSpec};
use duckdb::types::Value;
use duckdb::{Connection, appender_params_from_iter, params_from_iter};
use std::collections::BTreeSet;
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::Instant;

pub(super) fn validate_sources(sources: &[Source]) -> Result<(), Error> {
    let mut names = BTreeSet::new();
    if sources.is_empty() || sources.len() > 64 {
        return Err(Error::Configuration);
    }
    for source in sources {
        if !identifier(source.name)
            || source.name == "analytics_checkpoint"
            || !names.insert(source.name)
            || source.version == 0
            || source.columns.is_empty()
            || source.columns.len() > 64
        {
            return Err(Error::Configuration);
        }
        let mut columns = BTreeSet::from(["source_id", "scope", "source_version"]);
        for column in source.columns {
            if !identifier(column.name) || !columns.insert(column.name) {
                return Err(Error::Configuration);
            }
        }
    }
    Ok(())
}

pub(super) fn run(
    store: crate::Client,
    root: PathBuf,
    sources: &'static [Source],
    receiver: mpsc::Receiver<Command>,
) {
    let mut worker = Worker {
        schema: schema(sources),
        store,
        root,
        sources,
        connection: None,
        generation: None,
        progress: None,
        staged: None,
        rebuilt: false,
        #[cfg(test)]
        before_release: None,
    };
    while let Ok(command) = receiver.recv() {
        let cancellation = &command.cancellation;
        let deadline = command.deadline;
        match command.request {
            Request::Operation(operation, reply) => {
                let result = serve(&mut worker, cancellation, deadline, |worker| {
                    worker.execute(operation, cancellation, deadline)
                });
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                }
            }
            Request::Maintain(reply) => {
                let result = serve(&mut worker, cancellation, deadline, |worker| {
                    worker.maintain(cancellation, deadline)
                });
                let _ = reply.send(result);
            }
        }
    }
}

fn serve<T>(
    worker: &mut Worker,
    cancellation: &Cancellation,
    deadline: Instant,
    work: impl FnOnce(&mut Worker) -> Result<T, Error>,
) -> Result<T, Error> {
    let result = DeadlineGuard::start(cancellation.clone(), deadline).and_then(|guard| {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(worker)))
            .unwrap_or(Err(Error::Unavailable));
        drop(guard);
        cancellation.check(deadline).and(result)
    });
    if let Err(error) = &result {
        worker.connection.take();
        worker.staged.take();
        worker.generation = None;
        if !matches!(error, Error::Cancelled | Error::Deadline) {
            worker.progress = None;
        }
    }
    cancellation.finish();
    result
}

struct Progress {
    captured: Delivery,
    snapshot: Snapshot,
    connection: numeric::Native,
    source: usize,
    after: Option<Vec<u8>>,
}
impl Progress {
    fn resumable(&self, current: &Delivery, metadata: &crate::Metadata) -> bool {
        current.valid
            && current.rebuilding
            && current.generation == self.captured.generation
            && current.identity == self.captured.identity
            && current.source_generation == self.captured.source_generation
            && current.matches(metadata)
    }
}

struct StagedReport {
    view: SnapshotView,
    reads: BTreeSet<&'static str>,
    names: Vec<&'static str>,
    schema: Vec<u8>,
    identity: [u8; 16],
    source_generation: u64,
    privacy: u64,
    order: u64,
    connection: numeric::Native,
}
impl StagedReport {
    fn matches(
        &self,
        view: &SnapshotView,
        names: &[&'static str],
        schema: &[u8],
        captured: &Delivery,
    ) -> bool {
        self.view.same_reads(view, &self.reads)
            && self.names == names
            && self.schema == schema
            && self.identity == captured.identity
            && self.source_generation == captured.source_generation
            && self.privacy == captured.privacy
            && self.order == captured.order
    }
}

struct Worker {
    store: crate::Client,
    root: PathBuf,
    sources: &'static [Source],
    schema: Vec<u8>,
    connection: Option<numeric::Native>,
    generation: Option<u64>,
    progress: Option<Progress>,
    staged: Option<StagedReport>,
    rebuilt: bool,
    #[cfg(test)]
    before_release: Option<Box<dyn FnOnce() + Send>>,
}
impl Worker {
    fn execute(
        &mut self,
        operation: Operation,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<ReportRows, Error> {
        cancellation.check(deadline)?;
        match operation {
            Operation::SnapshotReport(captured, snapshot, names, queries) => {
                self.snapshot_report(captured, *snapshot, names, queries, cancellation, deadline)
            }
            Operation::Wake => {
                self.synchronize(cancellation, deadline)?;
                if self.read_state()?.pending_purge() {
                    self.finish_purge(cancellation, deadline)?;
                }
                Ok(Vec::new())
            }
            Operation::Rebuild => {
                self.rebuild(cancellation, deadline)?;
                Ok(Vec::new())
            }
            Operation::Purge => {
                self.rebuild(cancellation, deadline)?;
                self.finish_purge(cancellation, deadline)?;
                Ok(Vec::new())
            }
            Operation::Report(captured, queries) => {
                let active = self.synchronize(cancellation, deadline)?;
                if active.applied < captured.order {
                    return Err(Error::Invalid);
                }
                if active.pending_purge() || active.privacy != captured.privacy {
                    return Err(Error::Privacy);
                }
                let connection = self.connection.as_mut().ok_or(Error::Unavailable)?;
                cancellation.attach(connection);
                cancellation.querying();
                cancellation.check(deadline)?;
                let transaction = connection.transaction()?;
                let result = read_queries(&transaction, queries, cancellation, deadline)?;
                transaction.commit()?;
                cancellation.check(deadline)?;
                #[cfg(test)]
                if let Some(before_release) = self.before_release.take() {
                    before_release();
                }
                let current = self.read_state()?;
                if current.privacy != captured.privacy || current.pending_purge() {
                    return Err(Error::Privacy);
                }
                if !current.valid
                    || current.rebuilding
                    || current.generation != active.generation
                    || !current.matches(self.store.metadata())
                {
                    return Err(Error::Invalid);
                }
                Ok(result)
            }
        }
    }

    fn snapshot_report(
        &mut self,
        captured: Delivery,
        snapshot: Snapshot,
        names: &'static [&'static str],
        queries: Vec<Query>,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<ReportRows, Error> {
        let result =
            self.snapshot_report_staged(captured, snapshot, names, queries, cancellation, deadline);
        if result.is_err() {
            self.staged.take();
        }
        result
    }

    fn snapshot_report_staged(
        &mut self,
        captured: Delivery,
        snapshot: Snapshot,
        names: &'static [&'static str],
        queries: Vec<Query>,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<ReportRows, Error> {
        let current = self.read_state()?;
        if current.pending_purge() || current.privacy != captured.privacy {
            return Err(Error::Privacy);
        }
        let mut seen = BTreeSet::new();
        let mut selected = Vec::with_capacity(names.len());
        for name in names {
            if !seen.insert(name) {
                return Err(Error::Configuration);
            }
            selected.push(
                self.sources
                    .iter()
                    .find(|source| source.name == *name)
                    .ok_or(Error::Configuration)?,
            );
        }
        let selected_schema = schema_of(&selected);
        let view = snapshot.view().cloned();
        private_root(&self.root)?;
        if let Some(view) = &view
            && self
                .staged
                .as_ref()
                .is_some_and(|staged| staged.matches(view, names, &selected_schema, &captured))
        {
            drop(snapshot);
            let result = {
                let staged = self.staged.as_mut().ok_or(Error::Unavailable)?;
                cancellation.attach(&staged.connection);
                cancellation.querying();
                cancellation.check(deadline)?;
                let transaction = staged.connection.transaction()?;
                let result = read_queries(&transaction, queries, cancellation, deadline)?;
                transaction.commit()?;
                result
            };
            cancellation.check(deadline)?;
            return self.finish_snapshot_report(&captured, result);
        }
        self.staged.take();
        let mut connection = numeric::open(Path::new(":memory:"), &self.root.join("spill"))?;
        cancellation.attach(&connection);
        cancellation.querying();
        snapshot.reset_reads();
        {
            let transaction = connection.transaction()?;
            for (name, source) in names.iter().zip(&selected) {
                let table = format!("report_{name}");
                create_source(&transaction, source, &table, true)?;
                let mut appender = transaction.appender(&table)?;
                let mut after = None::<Vec<u8>>;
                loop {
                    cancellation.check(deadline)?;
                    let rows = (source.page)(&snapshot, after.as_deref(), BATCH_SIZE)?;
                    if rows.len() > BATCH_SIZE {
                        return Err(Error::Limit);
                    }
                    if rows.is_empty() {
                        break;
                    }
                    for row in rows {
                        if after.as_ref().is_some_and(|after| row.identity <= *after) {
                            return Err(Error::Configuration);
                        }
                        validate_row(source, &row)?;
                        after = Some(row.identity.clone());
                        if !(source.allowed)(&snapshot, &row.scope)? {
                            continue;
                        }
                        let values = values(row, captured.order);
                        appender.append_row(appender_params_from_iter(values.iter()))?;
                    }
                    std::thread::yield_now();
                }
                appender.flush()?;
                drop(appender);
            }
            cancellation.check(deadline)?;
            transaction.commit()?;
        }
        let reads = snapshot.reads();
        drop(snapshot);
        let result = {
            let transaction = connection.transaction()?;
            let result = read_queries(&transaction, queries, cancellation, deadline)?;
            transaction.commit()?;
            result
        };
        cancellation.check(deadline)?;
        let result = self.finish_snapshot_report(&captured, result)?;
        if let Some(view) = view {
            self.staged = Some(StagedReport {
                view,
                reads,
                names: names.to_vec(),
                schema: selected_schema,
                identity: captured.identity,
                source_generation: captured.source_generation,
                privacy: captured.privacy,
                order: captured.order,
                connection,
            });
        }
        Ok(result)
    }

    fn finish_snapshot_report(
        &self,
        captured: &Delivery,
        result: ReportRows,
    ) -> Result<ReportRows, Error> {
        let current = self.read_state()?;
        if current.pending_purge() || current.privacy != captured.privacy {
            return Err(Error::Privacy);
        }
        if !current.matches(self.store.metadata()) {
            return Err(Error::Invalid);
        }
        Ok(result)
    }

    fn read_state(&self) -> Result<Delivery, Error> {
        Ok(self
            .store
            .snapshot()?
            .get::<DeliveryTable>(&[])?
            .unwrap_or_else(|| Delivery::initial(self.store.metadata())))
    }

    fn synchronize(
        &mut self,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<Delivery, Error> {
        private_root(&self.root)?;
        let snapshot = self.store.snapshot()?;
        let captured = snapshot
            .get::<DeliveryTable>(&[])?
            .unwrap_or_else(|| Delivery::initial(self.store.metadata()));
        if !captured.valid || captured.rebuilding || !captured.matches(self.store.metadata()) {
            drop(snapshot);
            return self.rebuild(cancellation, deadline);
        }
        if self.generation != Some(captured.generation) {
            self.connection.take();
            self.connection = open(&self.root, &captured).ok();
            self.generation = self.connection.as_ref().map(|_| captured.generation);
        }
        let checkpoint = self
            .connection
            .as_ref()
            .and_then(|connection| checkpoint(connection).ok());
        let compatible = checkpoint.as_ref().is_some_and(|checkpoint| {
            checkpoint.matches(&captured, &self.schema)
                && checkpoint.order >= captured.applied
                && checkpoint.order <= captured.order
        });
        if !compatible {
            drop(snapshot);
            return self.rebuild(cancellation, deadline);
        }
        let checkpoint = checkpoint.ok_or(Error::Invalid)?;
        let intents = snapshot.scan::<IntentTable>(
            Bound::Unbounded,
            Bound::Unbounded,
            super::INTENT_LIMIT + 1,
        )?;
        if !complete_boundary(&captured, &intents)?
            || (checkpoint.order < captured.order && intents.is_empty())
        {
            drop(snapshot);
            return self.rebuild(cancellation, deadline);
        }
        let connection = self.connection.as_mut().ok_or(Error::Unavailable)?;
        cancellation.attach(connection);
        if checkpoint.order < captured.order {
            apply(
                connection,
                &snapshot,
                &captured,
                &intents,
                self.sources,
                &self.schema,
                (cancellation, deadline),
            )?;
        }
        drop(snapshot);
        cancellation.check(deadline)?;
        if captured.applied != captured.order || !intents.is_empty() {
            acknowledge(&self.store, &captured, intents, false)?;
        }
        self.read_state()
    }

    fn maintain(
        &mut self,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<Maintenance, Error> {
        cancellation.check(deadline)?;
        let current = self.read_state()?;
        let settled = self.rebuilt
            && self.progress.is_none()
            && current.valid
            && !current.rebuilding
            && current.matches(self.store.metadata())
            && !current.pending_purge();
        if !settled && self.rebuild_slice(cancellation, deadline)?.is_none() {
            return Ok(Maintenance::Pending);
        }
        if self.read_state()?.pending_purge() {
            self.finish_purge(cancellation, deadline)?;
        }
        Ok(Maintenance::Complete)
    }

    fn rebuild(
        &mut self,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<Delivery, Error> {
        loop {
            if let Some(active) = self.rebuild_slice(cancellation, deadline)? {
                return Ok(active);
            }
        }
    }

    fn rebuild_slice(
        &mut self,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<Option<Delivery>, Error> {
        cancellation.check(deadline)?;
        private_root(&self.root)?;
        let current = self.read_state()?;
        let metadata = self.store.metadata();
        if !self
            .progress
            .as_ref()
            .is_some_and(|progress| progress.resumable(&current, metadata))
        {
            self.start_rebuild(cancellation, deadline)?;
        }
        if !self.copy_slice(cancellation, deadline)? {
            return Ok(None);
        }
        self.activate(cancellation, deadline).map(Some)
    }

    fn start_rebuild(
        &mut self,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<(), Error> {
        self.progress = None;
        self.connection.take();
        self.staged.take();
        self.generation = None;
        let old = self.read_state()?;
        self.store
            .submit(move |tx| {
                let mut current = state::current(tx)?;
                current.valid = false;
                current.rebuilding = false;
                tx.put::<DeliveryTable>(&current)
            })?
            .wait()?;
        loop {
            cancellation.check(deadline)?;
            let removed = self
                .store
                .submit(|tx| {
                    let intents =
                        tx.scan::<IntentTable>(Bound::Unbounded, Bound::Unbounded, BATCH_SIZE)?;
                    for intent in &intents {
                        tx.delete::<IntentTable>(&IntentTable::primary_key(intent))?;
                    }
                    let mut current = tx
                        .get::<DeliveryTable>(&[])?
                        .ok_or(crate::Error::Incompatible("missing analytics delivery"))?;
                    current.intents = current
                        .intents
                        .checked_sub(intents.len())
                        .ok_or(crate::Error::Incompatible("analytics intent accounting"))?;
                    let bytes = intents
                        .iter()
                        .map(Intent::entry_bytes)
                        .collect::<Result<Vec<_>, _>>()?
                        .iter()
                        .sum::<usize>();
                    current.bytes = current
                        .bytes
                        .checked_sub(bytes)
                        .ok_or(crate::Error::Incompatible("analytics intent accounting"))?;
                    tx.put::<DeliveryTable>(&current)?;
                    Ok(intents.len())
                })?
                .wait()?;
            if removed == 0 {
                break;
            }
        }
        cleanup(&self.root, Some(&filename(&old)))?;
        let spill = self.root.join("spill");
        if spill.exists() {
            std::fs::remove_dir_all(spill)?;
        }
        let (captured, snapshot) = self
            .store
            .submit_with_snapshot(move |tx| {
                let mut current = state::current(tx)?;
                current.generation = state::increment(current.generation)?;
                current.applied = 0;
                current.valid = true;
                current.rebuilding = true;
                current.intents = 0;
                current.bytes = 0;
                tx.put::<DeliveryTable>(&current)?;
                Ok(current)
            })?
            .wait()?;
        cancellation.check(deadline)?;
        let connection = open(&self.root, &captured)?;
        cancellation.attach(&connection);
        create(&connection, self.sources)?;
        self.progress = Some(Progress {
            captured,
            snapshot,
            connection,
            source: 0,
            after: None,
        });
        Ok(())
    }

    fn copy_slice(
        &mut self,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<bool, Error> {
        let progress = self.progress.as_mut().ok_or(Error::Unavailable)?;
        cancellation.attach(&progress.connection);
        let mut source = progress.source;
        let mut after = progress.after.clone();
        let transaction = progress.connection.transaction()?;
        let mut pages = 0;
        while source < self.sources.len() && pages < REBUILD_SLICE_PAGES {
            cancellation.check(deadline)?;
            let definition = &self.sources[source];
            let rows = (definition.page)(&progress.snapshot, after.as_deref(), BATCH_SIZE)?;
            if rows.len() > BATCH_SIZE {
                return Err(Error::Limit);
            }
            if rows.is_empty() {
                source += 1;
                after = None;
                continue;
            }
            pages += 1;
            let mut appender = transaction.appender(definition.name)?;
            for row in rows {
                if after.as_ref().is_some_and(|after| row.identity <= *after) {
                    return Err(Error::Configuration);
                }
                validate_row(definition, &row)?;
                after = Some(row.identity.clone());
                if !(definition.allowed)(&progress.snapshot, &row.scope)? {
                    continue;
                }
                let values = values(row, progress.captured.order);
                appender.append_row(appender_params_from_iter(values.iter()))?;
            }
            appender.flush()?;
        }
        let complete = source == self.sources.len();
        if complete {
            write_checkpoint(&transaction, &progress.captured, &self.schema)?;
        }
        cancellation.check(deadline)?;
        transaction.commit()?;
        progress.source = source;
        progress.after = after;
        Ok(complete)
    }

    fn activate(
        &mut self,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<Delivery, Error> {
        let generation = self
            .progress
            .as_ref()
            .ok_or(Error::Unavailable)?
            .captured
            .generation;
        loop {
            cancellation.check(deadline)?;
            let snapshot = self.store.snapshot()?;
            let current = snapshot.get::<DeliveryTable>(&[])?.ok_or(Error::Invalid)?;
            if !current.valid
                || current.generation != generation
                || !current.matches(self.store.metadata())
            {
                return Err(Error::Invalid);
            }
            let intents = snapshot.scan::<IntentTable>(
                Bound::Unbounded,
                Bound::Unbounded,
                super::INTENT_LIMIT + 1,
            )?;
            if !complete_boundary(&current, &intents)? {
                return Err(Error::Invalid);
            }
            let progress = self.progress.as_mut().ok_or(Error::Unavailable)?;
            if checkpoint(&progress.connection)?.order < current.order {
                if intents.is_empty() {
                    return Err(Error::Invalid);
                }
                apply(
                    &mut progress.connection,
                    &snapshot,
                    &current,
                    &intents,
                    self.sources,
                    &self.schema,
                    (cancellation, deadline),
                )?;
            }
            drop(snapshot);
            if acknowledge(&self.store, &current, intents, true)? {
                let progress = self.progress.take().ok_or(Error::Unavailable)?;
                self.connection = Some(progress.connection);
                self.generation = Some(generation);
                self.rebuilt = true;
                cleanup(&self.root, Some(&filename(&current)))?;
                return self.read_state();
            }
        }
    }

    fn finish_purge(
        &mut self,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<(), Error> {
        cancellation.check(deadline)?;
        self.staged.take();
        let active = self.read_state()?;
        if !active.valid || active.rebuilding || active.applied != active.order {
            return Err(Error::Invalid);
        }
        cleanup(&self.root, Some(&filename(&active)))?;
        cancellation.check(deadline)?;
        let generation = active.generation;
        let privacy = active.privacy;
        let cleared = self
            .store
            .submit(move |tx| {
                let mut current = tx
                    .get::<DeliveryTable>(&[])?
                    .ok_or(crate::Error::Incompatible("missing analytics delivery"))?;
                if !current.valid
                    || current.rebuilding
                    || current.generation != generation
                    || current.privacy != privacy
                    || current.applied != current.order
                {
                    return Ok(false);
                }
                current.purges.clear();
                current.purge_all = false;
                tx.put::<DeliveryTable>(&current)?;
                Ok(true)
            })?
            .wait()?;
        if !cleared {
            return Err(Error::Invalid);
        }
        Ok(())
    }
}

fn complete_boundary(state: &Delivery, intents: &[Intent]) -> Result<bool, Error> {
    let bytes = intents
        .iter()
        .map(Intent::entry_bytes)
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .sum::<usize>();
    Ok(intents.len() == state.intents
        && bytes == state.bytes
        && intents.iter().all(|intent| {
            intent.generation == state.generation
                && intent.order <= state.order
                && intent.order > state.applied
        }))
}

fn acknowledge(
    store: &crate::Client,
    captured: &Delivery,
    intents: Vec<Intent>,
    activate: bool,
) -> Result<bool, Error> {
    let captured = captured.clone();
    let result = store
        .submit(move |tx| {
            let mut current = tx
                .get::<DeliveryTable>(&[])?
                .ok_or(crate::Error::Incompatible("missing analytics delivery"))?;
            if !current.valid
                || current.generation != captured.generation
                || current.identity != captured.identity
                || current.source_generation != captured.source_generation
            {
                return Ok(None);
            }
            for intent in intents {
                let key = IntentTable::primary_key(&intent);
                if tx.get::<IntentTable>(&key)?.as_ref() != Some(&intent) {
                    continue;
                }
                tx.delete::<IntentTable>(&key)?;
                current.intents = current
                    .intents
                    .checked_sub(1)
                    .ok_or(crate::Error::Incompatible("analytics intent accounting"))?;
                current.bytes = current
                    .bytes
                    .checked_sub(intent.entry_bytes()?)
                    .ok_or(crate::Error::Incompatible("analytics intent accounting"))?;
            }
            current.applied = current.applied.max(captured.order);
            let activated = activate && current.order == captured.order;
            if activated {
                current.rebuilding = false;
            }
            tx.put::<DeliveryTable>(&current)?;
            Ok(Some(activated))
        })?
        .wait()?;
    result.ok_or(Error::Invalid)
}

fn apply(
    connection: &mut Connection,
    snapshot: &Snapshot,
    captured: &Delivery,
    intents: &[Intent],
    sources: &[Source],
    schema: &[u8],
    control: (&Cancellation, Instant),
) -> Result<(), Error> {
    let (cancellation, deadline) = control;
    let transaction = connection.transaction()?;
    for batch in intents.chunks(BATCH_SIZE) {
        for intent in batch {
            cancellation.check(deadline)?;
            let source = sources
                .iter()
                .find(|source| source.name == intent.source)
                .ok_or(Error::Configuration)?;
            let row = (source.load)(snapshot, &intent.identity)?;
            let row = row.filter(|_| !intent.delete);
            let allowed = row
                .as_ref()
                .map(|row| (source.allowed)(snapshot, &row.scope))
                .transpose()?
                .unwrap_or(false);
            if !allowed {
                transaction.execute(
                    &format!("DELETE FROM {} WHERE source_id = ?", source.name),
                    [&intent.identity],
                )?;
                continue;
            }
            let row = row.ok_or(Error::Configuration)?;
            validate_row(source, &row)?;
            if row.identity != intent.identity {
                return Err(Error::Configuration);
            }
            let placeholders = vec!["?"; source.columns.len() + 3].join(",");
            let mut statement = transaction.prepare(&format!(
                "INSERT OR REPLACE INTO {} VALUES ({placeholders})",
                source.name
            ))?;
            statement.execute(params_from_iter(values(row, intent.order)))?;
        }
    }
    write_checkpoint(&transaction, captured, schema)?;
    cancellation.check(deadline)?;
    transaction.commit()?;
    Ok(())
}

fn values(row: SourceRow, version: u64) -> Vec<Value> {
    [
        vec![
            Value::Blob(row.identity),
            Value::Blob(row.scope),
            Value::UBigInt(version),
        ],
        row.values,
    ]
    .concat()
}
fn validate_row(source: &Source, row: &SourceRow) -> Result<(), Error> {
    if row.values.len() != source.columns.len()
        || row.identity.len() + row.scope.len() + row.values.iter().map(value_bytes).sum::<usize>()
            > ROW_BYTES
    {
        return Err(Error::Limit);
    }
    for (column, value) in source.columns.iter().zip(&row.values) {
        let accepted = matches!(
            (column.kind, value),
            (_, Value::Null)
                | (ColumnType::Boolean, Value::Boolean(_))
                | (ColumnType::Integer, Value::BigInt(_))
                | (ColumnType::Unsigned, Value::UBigInt(_))
                | (ColumnType::Double, Value::Double(_))
                | (ColumnType::Text, Value::Text(_))
        );
        if !accepted {
            return Err(Error::Configuration);
        }
    }
    Ok(())
}
fn value_bytes(value: &Value) -> usize {
    match value {
        Value::Text(value) | Value::Enum(value) => value.len(),
        Value::Blob(value) | Value::Geometry(value) => value.len(),
        Value::List(values) | Value::Array(values) => values.iter().map(value_bytes).sum(),
        _ => 32,
    }
}
pub(super) fn scalar_bytes(value: &Value) -> Result<usize, Error> {
    match value {
        Value::List(_) | Value::Array(_) | Value::Struct(_) | Value::Map(_) | Value::Union(_) => {
            Err(Error::Configuration)
        }
        _ => Ok(value_bytes(value)),
    }
}

fn read_queries(
    connection: &Connection,
    queries: Vec<Query>,
    cancellation: &Cancellation,
    deadline: Instant,
) -> Result<ReportRows, Error> {
    let mut count = 0;
    let mut bytes = 0;
    queries
        .into_iter()
        .map(|query| {
            cancellation.check(deadline)?;
            let sql = format!(
                "SELECT * FROM ({}) AS analytics_report LIMIT {}",
                query.sql,
                query.max_rows + 1
            );
            let mut statement = connection.prepare(&sql)?;
            let mut rows = statement.query(params_from_iter(query.parameters))?;
            let columns = rows.as_ref().ok_or(Error::Configuration)?.column_count();
            if columns > 64 {
                return Err(Error::Limit);
            }
            let mut result = Vec::new();
            while let Some(row) = rows.next()? {
                cancellation.check(deadline)?;
                let values = (0..columns)
                    .map(|column| row.get::<_, Value>(column))
                    .collect::<Result<Vec<_>, _>>()?;
                count += 1;
                bytes += values
                    .iter()
                    .map(scalar_bytes)
                    .collect::<Result<Vec<_>, _>>()?
                    .iter()
                    .sum::<usize>();
                if result.len() == query.max_rows || count > REPORT_ROWS || bytes > REPORT_BYTES {
                    return Err(Error::Limit);
                }
                result.push(values);
            }
            Ok(result)
        })
        .collect()
}

fn create(connection: &Connection, sources: &[Source]) -> Result<(), Error> {
    connection.execute_batch("CREATE TABLE analytics_checkpoint(singleton BOOLEAN PRIMARY KEY, identity BLOB NOT NULL, source_generation UBIGINT NOT NULL, generation UBIGINT NOT NULL, source_order UBIGINT NOT NULL, schema BLOB NOT NULL)")?;
    for source in sources {
        create_source(connection, source, source.name, false)?;
    }
    Ok(())
}

fn create_source(
    connection: &Connection,
    source: &Source,
    name: &str,
    temporary: bool,
) -> Result<(), Error> {
    let columns = source
        .columns
        .iter()
        .map(|column| {
            format!(
                "{} {}",
                column.name,
                match column.kind {
                    ColumnType::Boolean => "BOOLEAN",
                    ColumnType::Integer => "BIGINT",
                    ColumnType::Unsigned => "UBIGINT",
                    ColumnType::Double => "DOUBLE",
                    ColumnType::Text => "VARCHAR",
                }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    connection.execute_batch(&format!("CREATE {} TABLE {name}(source_id BLOB PRIMARY KEY, scope BLOB NOT NULL, source_version UBIGINT NOT NULL,{columns})", if temporary { "TEMP" } else { "" }))?;
    Ok(())
}
fn schema(sources: &[Source]) -> Vec<u8> {
    schema_of(&sources.iter().collect::<Vec<_>>())
}
fn schema_of(sources: &[&Source]) -> Vec<u8> {
    sources
        .iter()
        .flat_map(|source| {
            let mut bytes = source.name.as_bytes().to_vec();
            bytes.push(0);
            bytes.extend(source.version.to_be_bytes());
            for column in source.columns {
                bytes.extend(column.name.as_bytes());
                bytes.push(0);
                bytes.push(column.kind as u8);
            }
            bytes
        })
        .collect()
}
struct Checkpoint {
    identity: Vec<u8>,
    source_generation: u64,
    generation: u64,
    order: u64,
    schema: Vec<u8>,
}
impl Checkpoint {
    fn matches(&self, state: &Delivery, schema: &[u8]) -> bool {
        self.identity == state.identity
            && self.source_generation == state.source_generation
            && self.generation == state.generation
            && self.schema == schema
    }
}
fn checkpoint(connection: &Connection) -> Result<Checkpoint, Error> {
    Ok(connection.query_row("SELECT identity, source_generation, generation, source_order, schema FROM analytics_checkpoint WHERE singleton", [], |row| Ok(Checkpoint { identity: row.get(0)?, source_generation: row.get(1)?, generation: row.get(2)?, order: row.get(3)?, schema: row.get(4)? }))?)
}
fn write_checkpoint(connection: &Connection, state: &Delivery, schema: &[u8]) -> Result<(), Error> {
    connection.execute(
        "INSERT OR REPLACE INTO analytics_checkpoint VALUES (true,?,?,?,?,?)",
        params_from_iter([
            Value::Blob(state.identity.to_vec()),
            Value::UBigInt(state.source_generation),
            Value::UBigInt(state.generation),
            Value::UBigInt(state.order),
            Value::Blob(schema.to_vec()),
        ]),
    )?;
    Ok(())
}

fn filename(state: &Delivery) -> String {
    let identity = state
        .identity
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "generation-{identity}-{}-{}.duckdb",
        state.source_generation, state.generation
    )
}
fn private_root(root: &Path) -> Result<(), Error> {
    match std::fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(Error::Configuration),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(root)?,
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))?;
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| Error::Configuration)?;
        let kind = entry.file_type()?;
        if kind.is_symlink()
            || (name != "spill" && (!kind.is_file() || !owned_file(&name)))
            || (name == "spill" && !kind.is_dir())
        {
            return Err(Error::Configuration);
        }
    }
    Ok(())
}
fn owned_file(name: &str) -> bool {
    name.starts_with("generation-")
        && (name.ends_with(".duckdb") || name.ends_with(".duckdb.wal"))
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'.')
}
fn cleanup(root: &Path, keep: Option<&str>) -> Result<(), Error> {
    private_root(root)?;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| Error::Configuration)?;
        if !owned_file(&name)
            || keep.is_some_and(|keep| name == keep || name == format!("{keep}.wal"))
        {
            continue;
        }
        std::fs::remove_file(entry.path())?;
    }
    Ok(())
}
fn open(root: &Path, state: &Delivery) -> Result<numeric::Native, Error> {
    let spill = root.join("spill");
    if !spill.exists() {
        std::fs::create_dir(&spill)?;
    }
    numeric::open(&root.join(filename(state)), &spill)
}

struct DeadlineGuard {
    done: Option<mpsc::SyncSender<()>>,
    worker: Option<JoinHandle<()>>,
}
impl DeadlineGuard {
    fn start(cancellation: Cancellation, deadline: Instant) -> Result<Self, Error> {
        let (done, receipt) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("ycoding-analytics-deadline".to_owned())
            .spawn(move || {
                if receipt
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .is_err()
                {
                    let interrupt = {
                        let mut state = cancellation
                            .0
                            .state
                            .lock()
                            .unwrap_or_else(|error| error.into_inner());
                        state.expired = true;
                        state.interrupt.clone()
                    };
                    if let Some(interrupt) = interrupt {
                        interrupt.interrupt();
                    }
                }
            })?;
        Ok(Self {
            done: Some(done),
            worker: Some(worker),
        })
    }
}
impl Drop for DeadlineGuard {
    fn drop(&mut self) {
        if let Some(done) = self.done.take() {
            let _ = done.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
