use serde_json::{Map, Value};
use std::{
    collections::{BTreeSet, HashMap},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};
use ycoding_schema::session;

pub type Run = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Running,
    Completed,
    Error,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackgroundReason {
    Request,
    Deadline,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Info {
    pub id: String,
    pub kind: String,
    pub title: Option<String>,
    pub status: Status,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub metadata: Option<Map<String, Value>>,
}

pub struct StartInput {
    pub id: Option<String>,
    pub kind: String,
    pub title: Option<String>,
    pub metadata: Option<Map<String, Value>>,
    pub run: Run,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WaitResult {
    pub info: Option<Info>,
    pub timed_out: bool,
}

#[derive(Clone, Debug)]
pub struct BlockInput {
    pub id: String,
    pub session_id: session::Id,
    pub background_after: Option<Duration>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BlockResult {
    Finished(Info),
    Backgrounded {
        info: Info,
        reason: BackgroundReason,
    },
}

#[derive(Clone, Debug)]
struct Signal {
    info: Info,
    reason: BackgroundReason,
}

struct Active {
    sequence: u64,
    token: u64,
    info: Info,
    done: watch::Sender<Option<Info>>,
    backgrounded: watch::Sender<Option<Signal>>,
    task: Option<JoinHandle<()>>,
    blocking: HashMap<session::Id, usize>,
    is_backgrounded: bool,
    notice_pending: bool,
    reason: Option<BackgroundReason>,
}

#[derive(Default)]
struct State {
    jobs: HashMap<String, Active>,
    counter: u64,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
}

#[derive(Clone, Default)]
pub struct Jobs(Arc<Inner>);

impl Jobs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn list(&self) -> Vec<Info> {
        let state = self.0.lock();
        let mut jobs = state.jobs.values().collect::<Vec<_>>();
        jobs.sort_by_key(|job| (job.info.started_at, job.sequence));
        jobs.into_iter().map(|job| job.info.clone()).collect()
    }

    pub fn get(&self, id: &str) -> Option<Info> {
        self.0.lock().jobs.get(id).map(|job| job.info.clone())
    }

    pub fn outstanding_sessions(&self) -> BTreeSet<session::Id> {
        self.0
            .lock()
            .jobs
            .values()
            .filter(|job| {
                job.info.kind == "shell"
                    && (job.info.status == Status::Running || job.notice_pending)
            })
            .filter_map(|job| {
                let id = job.info.metadata.as_ref()?.get("sessionID")?.as_str()?;
                session::Id::new(id).ok()
            })
            .collect()
    }

    pub fn notice_admitted(&self, id: &str) {
        if let Some(job) = self.0.lock().jobs.get_mut(id) {
            job.notice_pending = false;
        }
    }

    pub fn start(&self, input: StartInput) -> std::io::Result<Info> {
        let id = match input.id {
            Some(id) => id,
            None => crate::platform::identifier("job_")?,
        };
        let mut state = self.0.lock();
        if let Some(existing) = state.jobs.get(&id)
            && existing.info.status == Status::Running
        {
            return Ok(existing.info.clone());
        }
        state.counter += 1;
        let (sequence, token) = (state.counter, state.counter);
        let info = Info {
            id: id.clone(),
            kind: input.kind,
            title: input.title,
            status: Status::Running,
            started_at: crate::platform::now() as u64,
            completed_at: None,
            output: None,
            error: None,
            metadata: input.metadata,
        };
        let task = tokio::spawn({
            let finisher = Finisher {
                inner: Arc::downgrade(&self.0),
                id: id.clone(),
                token,
                armed: true,
            };
            let run = input.run;
            async move { finisher.finish(run.await) }
        });
        state.jobs.insert(
            id,
            Active {
                sequence,
                token,
                info: info.clone(),
                done: watch::channel(None).0,
                backgrounded: watch::channel(None).0,
                task: Some(task),
                blocking: HashMap::new(),
                is_backgrounded: false,
                notice_pending: false,
                reason: None,
            },
        );
        Ok(info)
    }

    pub async fn wait(&self, id: &str, timeout: Option<Duration>) -> WaitResult {
        let (snapshot, done) = {
            let state = self.0.lock();
            let Some(job) = state.jobs.get(id) else {
                return WaitResult {
                    info: None,
                    timed_out: false,
                };
            };
            if job.info.status != Status::Running {
                return WaitResult {
                    info: Some(job.info.clone()),
                    timed_out: false,
                };
            }
            (job.info.clone(), job.done.subscribe())
        };
        let timed_out = || WaitResult {
            info: Some(snapshot.clone()),
            timed_out: true,
        };
        let settled = |info: Option<Info>| WaitResult {
            info: Some(info.unwrap_or_else(|| snapshot.clone())),
            timed_out: false,
        };
        match timeout {
            None => settled(watched(done).await),
            Some(duration) if duration.is_zero() => timed_out(),
            Some(duration) => match tokio::time::timeout(duration, watched(done)).await {
                Ok(info) => settled(info),
                Err(_) => timed_out(),
            },
        }
    }

    pub async fn block(&self, input: BlockInput) -> Option<BlockResult> {
        let (done, backgrounded) = {
            let mut state = self.0.lock();
            let job = state.jobs.get_mut(&input.id)?;
            if job.info.status != Status::Running {
                return Some(BlockResult::Finished(job.info.clone()));
            }
            if job.is_backgrounded {
                return Some(BlockResult::Backgrounded {
                    info: job.info.clone(),
                    reason: job.reason.unwrap_or(BackgroundReason::Request),
                });
            }
            *job.blocking.entry(input.session_id.clone()).or_default() += 1;
            (job.done.subscribe(), job.backgrounded.subscribe())
        };
        let _release = Release {
            inner: self.0.clone(),
            id: input.id.clone(),
            session_id: input.session_id.clone(),
        };
        let finished = async {
            let Some(info) = watched(done).await else {
                return std::future::pending::<BlockResult>().await;
            };
            if !self
                .0
                .lock()
                .jobs
                .get(&input.id)
                .is_some_and(|job| job.is_backgrounded)
            {
                return BlockResult::Finished(info);
            }
            match watched(backgrounded.clone()).await {
                Some(signal) => signal.into(),
                None => std::future::pending::<BlockResult>().await,
            }
        };
        let signalled = async {
            match watched(backgrounded.clone()).await {
                Some(signal) => signal.into(),
                None => std::future::pending::<BlockResult>().await,
            }
        };
        let deadline = async {
            let Some(after) = input.background_after else {
                return std::future::pending::<BlockResult>().await;
            };
            tokio::time::sleep(after).await;
            self.0.background(&input.id, BackgroundReason::Deadline);
            std::future::pending::<BlockResult>().await
        };
        Some(tokio::select! {
            result = finished => result,
            result = signalled => result,
            result = deadline => result,
        })
    }

    pub fn background(&self, id: &str) -> Option<Info> {
        self.0.background(id, BackgroundReason::Request)
    }

    pub fn background_all(&self, session_id: &session::Id, kind: Option<&str>) -> Vec<Info> {
        let mut state = self.0.lock();
        let mut ids = state
            .jobs
            .iter()
            .filter(|(_, job)| {
                job.info.status == Status::Running
                    && !job.is_backgrounded
                    && kind.is_none_or(|kind| job.info.kind == kind)
                    && job.blocking.contains_key(session_id)
            })
            .map(|(id, job)| (job.sequence, id.clone()))
            .collect::<Vec<_>>();
        ids.sort();
        ids.into_iter()
            .filter_map(|(_, id)| {
                state
                    .jobs
                    .get_mut(&id)
                    .map(|job| job.background(BackgroundReason::Request))
            })
            .collect()
    }

    pub async fn cancel(&self, id: &str) -> Option<Info> {
        let (info, task) = {
            let mut state = self.0.lock();
            let job = state.jobs.get_mut(id)?;
            if job.info.status != Status::Running {
                return Some(job.info.clone());
            }
            job.blocking.clear();
            job.info.status = Status::Cancelled;
            job.info.completed_at = Some(crate::platform::now() as u64);
            job.done.send_replace(Some(job.info.clone()));
            (job.info.clone(), job.task.take())
        };
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        Some(info)
    }
    pub(crate) fn mark_cancelled(&self, id: &str) -> Option<Info> {
        let mut state = self.0.lock();
        let job = state.jobs.get_mut(id)?;
        if job.info.status == Status::Running {
            job.blocking.clear();
            job.info.status = Status::Cancelled;
            job.info.completed_at = Some(crate::platform::now() as u64);
            job.task = None;
            job.done.send_replace(Some(job.info.clone()));
        }
        Some(job.info.clone())
    }

    pub fn close(&self) {
        self.0.abort_all();
    }
    pub async fn shutdown(&self) -> std::io::Result<()> {
        let tasks = self.0.lock().jobs.values_mut().filter_map(|job| job.task.take()).collect::<Vec<_>>();
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            if task.await.is_err_and(|error| !error.is_cancelled()) {
                return Err(std::io::Error::other("Job shutdown failed"));
            }
        }
        Ok(())
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn background(&self, id: &str, reason: BackgroundReason) -> Option<Info> {
        let mut state = self.lock();
        let job = state.jobs.get_mut(id)?;
        if job.info.status != Status::Running {
            if job.info.kind != "shell" {
                return None;
            }
            job.notice_pending = true;
            return Some(job.info.clone());
        }
        if job.is_backgrounded {
            return Some(job.info.clone());
        }
        Some(job.background(reason))
    }

    fn abort_all(&self) {
        for job in self.lock().jobs.values_mut() {
            if let Some(task) = job.task.take() {
                task.abort();
            }
        }
    }

    fn settle(&self, id: &str, token: u64, result: Result<String, String>) {
        let mut state = self.lock();
        let Some(job) = state.jobs.get_mut(id) else {
            return;
        };
        if job.token != token || job.info.status != Status::Running {
            return;
        }
        job.blocking.clear();
        job.info.completed_at = Some(crate::platform::now() as u64);
        match result {
            Ok(output) => {
                job.info.status = Status::Completed;
                job.info.output = Some(output);
            }
            Err(error) => {
                job.info.status = Status::Error;
                job.info.error = Some(error);
            }
        }
        job.task = None;
        job.done.send_replace(Some(job.info.clone()));
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.abort_all();
    }
}

impl Active {
    fn background(&mut self, reason: BackgroundReason) -> Info {
        self.is_backgrounded = true;
        self.notice_pending = self.info.kind == "shell";
        self.reason = Some(reason);
        self.blocking.clear();
        self.backgrounded.send_replace(Some(Signal {
            info: self.info.clone(),
            reason,
        }));
        self.info.clone()
    }
}

impl From<Signal> for BlockResult {
    fn from(signal: Signal) -> Self {
        Self::Backgrounded {
            info: signal.info,
            reason: signal.reason,
        }
    }
}

struct Finisher {
    inner: Weak<Inner>,
    id: String,
    token: u64,
    armed: bool,
}

impl Finisher {
    fn finish(mut self, result: Result<String, String>) {
        self.armed = false;
        if let Some(inner) = self.inner.upgrade() {
            inner.settle(&self.id, self.token, result);
        }
    }
}

impl Drop for Finisher {
    fn drop(&mut self) {
        if self.armed
            && std::thread::panicking()
            && let Some(inner) = self.inner.upgrade()
        {
            inner.settle(&self.id, self.token, Err("Job panicked".into()));
        }
    }
}

struct Release {
    inner: Arc<Inner>,
    id: String,
    session_id: session::Id,
}

impl Drop for Release {
    fn drop(&mut self) {
        let mut state = self.inner.lock();
        let Some(job) = state.jobs.get_mut(&self.id) else {
            return;
        };
        if job.info.status != Status::Running || job.is_backgrounded {
            return;
        }
        match job.blocking.get_mut(&self.session_id) {
            Some(count) if *count > 1 => *count -= 1,
            Some(_) => {
                job.blocking.remove(&self.session_id);
            }
            None => {}
        }
    }
}

async fn watched<T: Clone>(mut receiver: watch::Receiver<Option<T>>) -> Option<T> {
    receiver
        .wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|value| (*value).clone())
}
