mod candidate;
mod family;
mod pass;
mod receipt;
mod resume;
mod trigger;

#[cfg(test)]
#[path = "goal_decisions_shutdown_tests.rs"]
mod shutdown_tests;

use crate::{
    coordination::decisions::{Clock, Current, Settings},
    event_feed::{Feed, Payload, ResumeError, Scope},
    process::guardrails::Guardrails,
    session::{autonomy, orchestration, store},
    tools::policy::{forms::Forms, permissions::Permissions, questions::Questions},
};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, Weak},
};
use tokio::{
    sync::{Notify, OwnedMutexGuard, watch},
    task::{Id, JoinError, JoinHandle, JoinSet},
};
use ycoding_schema::{LosslessString, session};
use ycoding_store::Client;

pub const HANDLED_EVENTS: &[&str] = &[
    "permission.asked",
    "permission.replied",
    "permission.deferred",
    "guardrail.asked",
    "guardrail.replied",
    "guardrail.deferred",
    "session.guardrail.decided.1",
    "form.created",
    "form.replied",
    "form.cancelled",
    "form.timed_out",
    "form.deferred",
    "question.asked",
    "question.replied",
    "question.rejected",
    "question.timed_out",
    "question.deferred",
    "session.review.deferred.1",
    "session.review.decided.1",
    "session.review.withdrawn.1",
    "session.task.updated.1",
    "session.context.observed.1",
];

const MAX_ROUNDS: usize = 2;
const FAMILY_LIMIT: usize = 512;
const REQUEST_LIMIT: usize = 64;
const RECEIPT_SCAN_LIMIT: usize = 200;
const SCAN_PAGES: usize = 64;
const PAGE: usize = 128;
const TEXT_LIMIT: usize = 1000;
const RECEIPT_PREFIX: &str = "msg_goaldec_";

pub(crate) type Fallible<T> = Result<T, ycoding_store::Error>;
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
pub type Locate = Arc<dyn Fn(session::Id) -> BoxFuture<'static, Option<Located>> + Send + Sync>;

pub trait Execution: Send + Sync + 'static {
    fn active(&self) -> Vec<session::Id>;
    fn wake(&self, id: &session::Id) -> Result<(), String>;
}

pub type ProofFuture<'a> =
    BoxFuture<'a, Result<String, crate::coordination::decision_context::Error>>;

pub trait AuthorityProof: Send + Sync + 'static {
    fn authority_digest(&self, session: &session::Id) -> ProofFuture<'_>;
}

pub trait Synthesize: Send + Sync + 'static {
    fn synthesize(
        &self,
        owner: &session::Id,
        prompt: String,
    ) -> BoxFuture<'_, Result<String, String>>;
}

#[derive(Clone)]
pub struct Located {
    pub permissions: Option<Permissions>,
    pub guardrails: Option<Guardrails>,
    pub forms: Option<Forms>,
    pub questions: Option<Questions>,
    pub shell_active: Option<ShellActive>,
    pub lease: Arc<dyn Send + Sync>,
    pub is_current: Current,
}

pub type ShellActive = Arc<dyn Fn(&session::Id) -> bool + Send + Sync>;

pub struct Options {
    pub client: Client,
    pub autonomy: autonomy::Service,
    pub execution: Arc<dyn Execution>,
    pub orchestration: orchestration::Service,
    pub settings: Settings,
    pub locate: Locate,
    pub proof: Arc<dyn AuthorityProof>,
    pub synthesize: Arc<dyn Synthesize>,
    pub now: Option<Clock>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Permission,
    Guardrail,
    Form,
    Question,
    ChildQuestion,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Guardrail => "guardrail",
            Self::Form => "form",
            Self::Question => "question",
            Self::ChildQuestion => "child_question",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "permission" => Some(Self::Permission),
            "guardrail" => Some(Self::Guardrail),
            "form" => Some(Self::Form),
            "question" => Some(Self::Question),
            "child_question" => Some(Self::ChildQuestion),
            _ => None,
        }
    }

    pub(crate) fn answers_question(self) -> bool {
        matches!(self, Self::Form | Self::Question | Self::ChildQuestion)
    }

    fn category(self) -> &'static str {
        match self {
            Self::Permission => "permissions",
            Self::Guardrail => "guardrails",
            _ => "answers",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Settled,
    Waiting,
    Resumed,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Settled => "settled",
            Self::Waiting => "waiting",
            Self::Resumed => "resumed",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Requirement {
    pub goal_digest: String,
    pub iteration: u64,
    pub revision: i64,
}

struct Inner {
    client: Client,
    sessions: store::Service,
    autonomy: autonomy::Service,
    execution: Arc<dyn Execution>,
    orchestration: orchestration::Service,
    settings: Settings,
    locate: Locate,
    proof: Arc<dyn AuthorityProof>,
    synthesize: Arc<dyn Synthesize>,
    now: Option<Clock>,
    locks: Mutex<BTreeMap<session::Id, Weak<tokio::sync::Mutex<()>>>>,
    queued: Mutex<BTreeMap<session::Id, watch::Receiver<bool>>>,
    attempts: Mutex<BTreeMap<session::Id, BTreeMap<String, BTreeSet<String>>>>,
}

#[derive(Clone)]
pub struct GoalDecisions(Arc<Inner>);

pub struct Started {
    stop: watch::Sender<bool>,
    work: [Arc<Mutex<Work>>; 2],
    drain: tokio::sync::Mutex<Shutdown>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Worker {
    Events,
    Reconciliation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JoinFailure {
    Panic,
    Cancelled,
}

impl JoinFailure {
    fn from_join(error: &JoinError) -> Self {
        if error.is_cancelled() {
            Self::Cancelled
        } else {
            Self::Panic
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShutdownFailure {
    pub worker: Worker,
    pub task: Option<u64>,
    pub kind: JoinFailure,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShutdownFailed {
    failures: Vec<ShutdownFailure>,
}

impl ShutdownFailed {
    pub fn failures(&self) -> &[ShutdownFailure] {
        &self.failures
    }
}

impl std::fmt::Display for ShutdownFailed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Goal decision shutdown failed for {} tasks",
            self.failures.len()
        )
    }
}

impl std::error::Error for ShutdownFailed {}

#[derive(Default)]
struct Work {
    stopped: bool,
    tasks: JoinSet<()>,
    next: u64,
    admitted: BTreeMap<Id, u64>,
    failures: BTreeMap<u64, JoinFailure>,
}

fn locked_work(work: &Mutex<Work>) -> MutexGuard<'_, Work> {
    work.lock().unwrap_or_else(|error| error.into_inner())
}

impl Work {
    fn spawn(&mut self, future: impl Future<Output = ()> + Send + 'static) -> bool {
        if self.stopped {
            return false;
        }
        let task = self.tasks.spawn(future);
        self.admitted.insert(task.id(), self.next);
        self.next += 1;
        true
    }

    fn record(&mut self, result: Result<(Id, ()), JoinError>) {
        match result {
            Ok((id, ())) => {
                self.admitted.remove(&id);
            }
            Err(error) => {
                let task = self
                    .admitted
                    .remove(&error.id())
                    .expect("Goal decision task is owned");
                self.failures.insert(task, JoinFailure::from_join(&error));
            }
        }
    }

    fn reap(&mut self) {
        while let Some(result) = self.tasks.try_join_next_with_id() {
            self.record(result);
        }
    }
}

struct Shutdown {
    tasks: VecDeque<(Worker, JoinHandle<()>)>,
    failures: Vec<ShutdownFailure>,
    result: Option<Result<(), ShutdownFailed>>,
}

impl Started {
    fn new(
        stop: watch::Sender<bool>,
        work: [Arc<Mutex<Work>>; 2],
        tasks: Vec<(Worker, JoinHandle<()>)>,
    ) -> Self {
        Self {
            stop,
            work,
            drain: tokio::sync::Mutex::new(Shutdown {
                tasks: tasks.into(),
                failures: Vec::new(),
                result: None,
            }),
        }
    }

    pub async fn shutdown(&self) -> Result<(), ShutdownFailed> {
        for work in &self.work {
            locked_work(work).stopped = true;
        }
        self.stop.send_replace(true);
        let mut drain = self.drain.lock().await;
        if let Some(result) = &drain.result {
            return result.clone();
        }
        while let Some((worker, task)) = drain.tasks.front_mut() {
            let worker = *worker;
            let result = task.await;
            drain.tasks.pop_front();
            if let Err(error) = result {
                drain.failures.push(ShutdownFailure {
                    worker,
                    task: None,
                    kind: JoinFailure::from_join(&error),
                });
            }
        }
        for work in &self.work {
            loop {
                let result =
                    std::future::poll_fn(|cx| locked_work(work).tasks.poll_join_next_with_id(cx))
                        .await;
                let Some(result) = result else { break };
                locked_work(work).record(result);
            }
        }
        let mut failures = drain.failures.clone();
        for (worker, work) in [Worker::Events, Worker::Reconciliation]
            .into_iter()
            .zip(&self.work)
        {
            failures.extend(locked_work(work).failures.iter().map(|(&task, &kind)| {
                ShutdownFailure {
                    worker,
                    task: Some(task),
                    kind,
                }
            }));
        }
        let result = if failures.is_empty() {
            Ok(())
        } else {
            Err(ShutdownFailed { failures })
        };
        drain.result = Some(result.clone());
        result
    }
}

impl Drop for Started {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        for work in &self.work {
            let mut work = locked_work(work);
            work.stopped = true;
            work.tasks.abort_all();
        }
        for (_, task) in &self.drain.get_mut().tasks {
            task.abort();
        }
    }
}

struct Unqueue<'a> {
    inner: &'a Inner,
    owner: &'a session::Id,
    armed: bool,
}

impl Unqueue<'_> {
    fn release(&mut self) {
        if std::mem::take(&mut self.armed) {
            self.inner
                .queued
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(self.owner);
        }
    }
}

impl Drop for Unqueue<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

impl GoalDecisions {
    pub fn new(options: Options) -> Self {
        Self(Arc::new(Inner {
            sessions: store::Service::new(options.client.clone()),
            client: options.client,
            autonomy: options.autonomy,
            execution: options.execution,
            orchestration: options.orchestration,
            settings: options.settings,
            locate: options.locate,
            proof: options.proof,
            synthesize: options.synthesize,
            now: options.now,
            locks: Mutex::default(),
            queued: Mutex::default(),
            attempts: Mutex::default(),
        }))
    }

    pub fn start(&self, feed: &Feed, autonomy: autonomy::Service) -> Result<Started, ResumeError> {
        let notify = Arc::new(Notify::new());
        let wake = notify.clone();
        let subscriber =
            feed.subscribe_types_unbounded(Scope::Global, HANDLED_EVENTS, move || {
                wake.notify_one()
            })?;
        let mut changes = autonomy.changes();
        let work: [Arc<Mutex<Work>>; 2] =
            std::array::from_fn(|_| Arc::new(Mutex::new(Work::default())));
        let (stop, stopped) = watch::channel(false);
        let events = {
            let this = self.clone();
            let work = work[0].clone();
            let mut stopped = stopped.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        _ = stopped.wait_for(|stopped| *stopped) => return,
                        _ = notify.notified() => {},
                    }
                    loop {
                        if *stopped.borrow() {
                            return;
                        }
                        match subscriber.next() {
                            Ok(Some(item)) => {
                                let this = this.clone();
                                locked_work(&work)
                                    .spawn(async move { this.handle(&item.payload).await });
                            }
                            Ok(None) => break,
                            Err(_) => {
                                tracing::error!("Goal decision subscription failed");
                                return;
                            }
                        }
                    }
                    locked_work(&work).reap();
                }
            })
        };
        let reconciliation = {
            let this = self.clone();
            let work = work[1].clone();
            let mut stopped = stopped;
            tokio::spawn(async move {
                loop {
                    let id = tokio::select! {
                        biased;
                        _ = stopped.wait_for(|stopped| *stopped) => return,
                        id = changes.next() => id,
                    };
                    let Some(id) = id else { return };
                    let this = this.clone();
                    locked_work(&work).spawn(async move { this.reconcile(&id).await });
                    locked_work(&work).reap();
                }
            })
        };
        Ok(Started::new(
            stop,
            work,
            vec![
                (Worker::Events, events),
                (Worker::Reconciliation, reconciliation),
            ],
        ))
    }

    pub async fn handle(&self, payload: &Payload) {
        let Some(trigger) = self.trigger(payload) else {
            return;
        };
        let Some(owner) = self.owner_of(&trigger.session) else {
            return;
        };
        if let Some(answered) = &trigger.answered {
            let _guard = self.lock(&owner).await;
            self.resume(&owner, answered).await;
        }
        self.inspect(&owner).await;
    }

    pub async fn reconcile(&self, session: &session::Id) {
        let nearest = self.owner_of(session);
        let below = match self.subtree(session, false) {
            Ok(rows) => rows
                .into_iter()
                .filter(family::eligible)
                .map(|row| row.id)
                .collect::<Vec<_>>(),
            Err(error) => {
                tracing::warn!(error = %error, "Goal decision reconciliation failed");
                Vec::new()
            }
        };
        let owners = nearest.into_iter().chain(below).collect::<BTreeSet<_>>();
        for owner in owners {
            self.inspect(&owner).await;
        }
    }

    pub async fn inspect(&self, owner: &session::Id) {
        let joined = {
            let mut queued = self
                .0
                .queued
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            match queued.get(owner) {
                Some(done) => Err(done.clone()),
                None => {
                    let (sender, receiver) = watch::channel(false);
                    queued.insert(owner.clone(), receiver);
                    Ok(sender)
                }
            }
        };
        let done = match joined {
            Err(mut receiver) => {
                while !*receiver.borrow_and_update() {
                    if receiver.changed().await.is_err() {
                        return;
                    }
                }
                return;
            }
            Ok(done) => done,
        };
        let mut queued = Unqueue {
            inner: &self.0,
            owner,
            armed: true,
        };
        let guard = self.lock(owner).await;
        queued.release();
        for _ in 0..MAX_ROUNDS {
            if !self.pass(owner).await {
                break;
            }
        }
        drop(guard);
        done.send_replace(true);
    }

    async fn lock(&self, owner: &session::Id) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self
                .0
                .locks
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(owner).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(tokio::sync::Mutex::new(()));
                    locks.insert(owner.clone(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }

    fn now(&self) -> i64 {
        self.0
            .now
            .as_ref()
            .map_or_else(|| chrono::Utc::now().timestamp_millis(), |clock| clock())
    }
}

pub(crate) fn readable(text: &LosslessString) -> String {
    String::from_utf16_lossy(&text.code_units().collect::<Vec<_>>())
}
