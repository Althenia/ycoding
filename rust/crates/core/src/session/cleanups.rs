use super::{
    execution::Execution,
    history_pruning::free_bytes,
    retention::Settings,
    runner::{Clock, WallClock},
};
use crate::resources::{config::Roots, tool_output_store};
use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};
use ycoding_schema::session;
use ycoding_store::{
    Client, analytics,
    backup::Status,
    model_incident,
    session::{
        CLEANUP_BATCH, CLEANUP_ROWS, CleanupCursor, Projection, cleanup_batch, cleanup_sessions,
        delete_expired_facts, has_cleanup_rows, has_expired_facts,
    },
};

const DAY_MS: i64 = 86_400_000;
pub const INTERVAL_MS: u64 = 3_600_000;
static OWNER: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub enum Error {
    Store(ycoding_store::Error),
    Analytics(analytics::Error),
    Io(io::Error),
    Worker(tokio::task::JoinError),
    AlreadyStarted,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Session cleanup: {self:?}")
    }
}
impl std::error::Error for Error {}
impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        Self::Store(error)
    }
}

#[derive(Clone)]
pub struct Cleanups {
    client: Client,
    outputs: Arc<tool_output_store::Store>,
    clock: Arc<dyn Clock>,
    active: Arc<dyn Fn() -> Vec<session::Id> + Send + Sync>,
    settings: Arc<dyn Fn() -> Settings + Send + Sync>,
}
impl Cleanups {
    pub fn new(
        client: Client,
        outputs: Arc<tool_output_store::Store>,
        clock: Arc<dyn Clock>,
        active: Arc<dyn Fn() -> Vec<session::Id> + Send + Sync>,
        settings: Arc<dyn Fn() -> Settings + Send + Sync>,
    ) -> Self {
        Self {
            client,
            outputs,
            clock,
            active,
            settings,
        }
    }
    pub fn process(
        client: Client,
        roots: &Roots,
        settings: Arc<dyn Fn() -> Settings + Send + Sync>,
    ) -> Self {
        Self::new(
            client,
            Arc::new(tool_output_store::Store::new(roots)),
            Arc::new(WallClock),
            Arc::new(|| Execution::global().map_or_else(Vec::new, Execution::active)),
            settings,
        )
    }
    pub async fn context_exclusions(&self) -> Result<usize, Error> {
        self.projections(Projection::Exclusions).await
    }
    pub async fn file_changes(&self) -> Result<usize, Error> {
        self.projections(Projection::Files).await
    }
    pub async fn usage(&self) -> Result<usize, Error> {
        let deleted = self.projections(Projection::Usage).await?;
        self.purge_pending().await?;
        Ok(deleted)
    }
    pub async fn usage_facts(&self) -> Result<usize, Error> {
        let cutoff = self.cutoff((self.settings)().usage_days);
        let mut deleted = 0;
        if has_expired_facts(&self.client.snapshot()?, cutoff)? && self.backup_ready().await? {
            loop {
                let removed = self
                    .client
                    .submit(move |tx| delete_expired_facts(tx, cutoff))?
                    .await?;
                deleted += removed;
                if removed < CLEANUP_ROWS {
                    break;
                }
                tokio::task::yield_now().await;
            }
        }
        if deleted > 0 {
            self.purge_pending().await?;
        }
        Ok(deleted)
    }
    pub async fn incidents(&self) -> Result<usize, Error> {
        let cutoff = self.cutoff((self.settings)().incident_days);
        let mut deleted = 0;
        if model_incident::has_expired(&self.client.snapshot()?, cutoff)?
            && self.backup_ready().await?
        {
            loop {
                let removed = self
                    .client
                    .submit(move |tx| model_incident::delete_expired(tx, cutoff))?
                    .await?;
                deleted += removed;
                if removed < model_incident::CLEANUP_ROWS {
                    break;
                }
                tokio::task::yield_now().await;
            }
        }
        Ok(deleted)
    }
    async fn purge_pending(&self) -> Result<(), Error> {
        let client = self.client.clone();
        tokio::task::spawn_blocking(move || {
            let pending = client
                .snapshot()?
                .get::<analytics::DeliveryTable>(&[])?
                .is_some_and(|state| state.purge_all || !state.purges.is_empty());
            if pending {
                client
                    .analytics()
                    .map_err(Error::Analytics)?
                    .purge()
                    .map_err(Error::Analytics)?;
            }
            Ok::<_, Error>(())
        })
        .await
        .map_err(Error::Worker)?
    }
    pub async fn tool_outputs(&self) -> Result<(), Error> {
        let now = self.clock.now();
        let now = if now >= 0 {
            SystemTime::UNIX_EPOCH + Duration::from_millis(now as u64)
        } else {
            SystemTime::UNIX_EPOCH - Duration::from_millis(now.unsigned_abs())
        };
        self.outputs.cleanup(now).await.map_err(Error::Io)
    }
    fn cutoff(&self, days: i64) -> i64 {
        self.clock.now().saturating_sub(days.saturating_mul(DAY_MS))
    }
    async fn backup_ready(&self) -> Result<bool, Error> {
        let client = self.client.clone();
        let now = self.clock.now();
        let status = tokio::task::spawn_blocking(move || client.prepare_pruning(now, free_bytes))
            .await
            .map_err(Error::Worker)??;
        match status {
            Status::Ready => Ok(true),
            Status::Blocked { notice } => {
                if let Some(reason) = notice {
                    tracing::warn!(%reason, "Session usage cleanup paused: verified backup unavailable");
                }
                Ok(false)
            }
        }
    }
    async fn projections(&self, projection: Projection) -> Result<usize, Error> {
        let cutoff = self.cutoff((self.settings)().records_days);
        let snapshot = Arc::new(self.client.snapshot()?);
        let initial: Vec<_> = (self.active)()
            .into_iter()
            .map(|id| id.as_lossless().clone())
            .collect();
        let mut backup = false;
        let mut after = None;
        let mut deleted = 0;
        loop {
            let sessions = cleanup_sessions(&snapshot, cutoff, after.as_ref())?;
            for session in &sessions {
                if !has_cleanup_rows(&snapshot, session, projection)? {
                    continue;
                }
                if !backup {
                    if !self.backup_ready().await? {
                        return Ok(deleted);
                    }
                    backup = true;
                }
                let mut cursor = CleanupCursor::default();
                loop {
                    let snapshot = snapshot.clone();
                    let initial = initial.clone();
                    let active = self.active.clone();
                    let target = session.clone();
                    let (batch, next) = self
                        .client
                        .submit(move |tx| {
                            let mut exempt = initial;
                            exempt.extend(active().into_iter().map(|id| id.as_lossless().clone()));
                            let batch = cleanup_batch(
                                tx,
                                &snapshot,
                                &target,
                                cutoff,
                                &exempt,
                                projection,
                                &mut cursor,
                            )?;
                            Ok((batch, cursor))
                        })?
                        .await?;
                    deleted += match projection {
                        Projection::Exclusions => batch.deleted.exclusions,
                        Projection::Files => batch.deleted.files,
                        Projection::Usage => batch.deleted.requests,
                    };
                    if batch.finished {
                        break;
                    }
                    cursor = next;
                    tokio::task::yield_now().await;
                }
                tokio::task::yield_now().await;
            }
            if sessions.len() < CLEANUP_BATCH {
                return Ok(deleted);
            }
            after = sessions.last().cloned();
        }
    }
    pub async fn sweep(&self) -> Sweep {
        let mut sweep = Sweep::default();
        for (kind, result) in [
            (Kind::ContextExclusions, self.context_exclusions().await),
            (Kind::FileChanges, self.file_changes().await),
            (Kind::Usage, self.usage().await),
            (Kind::UsageFacts, self.usage_facts().await),
            (Kind::Incidents, self.incidents().await),
            (Kind::ToolOutputs, self.tool_outputs().await.map(|()| 0)),
        ] {
            match result {
                Ok(count) => match kind {
                    Kind::ContextExclusions => sweep.context_exclusions = count,
                    Kind::FileChanges => sweep.file_changes = count,
                    Kind::Usage => sweep.requests = count,
                    Kind::UsageFacts => sweep.facts = count,
                    Kind::Incidents => sweep.incidents = count,
                    Kind::ToolOutputs => {}
                },
                Err(error) => {
                    eprintln!("Session maintenance {kind:?} failed: {error}");
                    sweep.failures.push((kind, error));
                }
            }
        }
        sweep
    }
    async fn run(&self, kind: Kind) -> Result<usize, Error> {
        match kind {
            Kind::ContextExclusions => self.context_exclusions().await,
            Kind::FileChanges => self.file_changes().await,
            Kind::Usage => self.usage().await,
            Kind::UsageFacts => self.usage_facts().await,
            Kind::Incidents => self.incidents().await,
            Kind::ToolOutputs => self.tool_outputs().await.map(|()| 0),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum Kind {
    ContextExclusions,
    FileChanges,
    Usage,
    UsageFacts,
    Incidents,
    ToolOutputs,
}
#[derive(Debug, Default)]
pub struct Sweep {
    pub context_exclusions: usize,
    pub file_changes: usize,
    pub requests: usize,
    pub facts: usize,
    pub incidents: usize,
    pub failures: Vec<(Kind, Error)>,
}

pub struct Maintenance {
    startup: Sweep,
    stop: tokio::sync::watch::Sender<bool>,
    worker: Option<tokio::task::JoinHandle<Result<(), Error>>>,
}
struct Lease;
impl Drop for Lease {
    fn drop(&mut self) {
        OWNER.store(false, Ordering::Release);
    }
}
impl Maintenance {
    pub async fn start(cleanups: Cleanups) -> Result<Self, Error> {
        OWNER
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| Error::AlreadyStarted)?;
        let lease = Lease;
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let (ready, startup) = tokio::sync::oneshot::channel();
        let worker = tokio::spawn(async move {
            let _lease = lease;
            let sweep = cleanups.sweep().await;
            if ready.send(sweep).is_err() {
                return Ok(());
            }
            let mut tasks = tokio::task::JoinSet::new();
            for kind in [
                Kind::ContextExclusions,
                Kind::FileChanges,
                Kind::Usage,
                Kind::UsageFacts,
                Kind::Incidents,
                Kind::ToolOutputs,
            ] {
                let cleanups = cleanups.clone();
                let mut stopped = stopped.clone();
                tasks.spawn(async move {
                    loop {
                        if *stopped.borrow() || stopped.has_changed().is_err() {
                            return;
                        }
                        tokio::select! {
                            biased;
                            _ = stopped.changed() => return,
                            () = cleanups.clock.sleep(INTERVAL_MS) => {}
                        }
                        if *stopped.borrow() {
                            return;
                        }
                        if let Err(error) = cleanups.run(kind).await {
                            eprintln!("Session maintenance {kind:?} failed: {error}");
                        }
                    }
                });
            }
            let mut failure = None;
            while let Some(result) = tasks.join_next().await {
                if let Err(error) = result {
                    eprintln!("Session maintenance worker failed: {error}");
                    failure.get_or_insert(Error::Worker(error));
                }
            }
            failure.map_or(Ok(()), Err)
        });
        let startup = match startup.await {
            Ok(startup) => startup,
            Err(_) => {
                return match worker.await {
                    Err(error) => Err(Error::Worker(error)),
                    Ok(Err(error)) => Err(error),
                    Ok(Ok(())) => Err(Error::AlreadyStarted),
                };
            }
        };
        Ok(Self {
            startup,
            stop,
            worker: Some(worker),
        })
    }
    pub fn startup(&self) -> &Sweep {
        &self.startup
    }
    pub async fn close(&mut self) -> Result<(), Error> {
        self.stop.send_replace(true);
        if let Some(worker) = self.worker.as_mut() {
            let result = worker.await.map_err(Error::Worker);
            self.worker.take();
            result??;
        }
        Ok(())
    }
}
impl Drop for Maintenance {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}
