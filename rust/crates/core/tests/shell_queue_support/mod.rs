#![allow(dead_code)]
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{sync::Notify, task::JoinHandle};
use ycoding_core::platform::shell::queue::{
    Admission, Error, FamilyReservation, Full, Limits, Options, Queue, Request, Sample,
};

#[path = "../shell_temp/mod.rs"]
mod temp;
pub use temp::Temp;

pub struct Host {
    pub sample: Arc<Mutex<Option<Sample>>>,
    pub samples: Arc<AtomicUsize>,
    pub clock: Arc<AtomicI64>,
}
impl Host {
    pub fn new(available_mb: f64, load: f64) -> Self {
        Self {
            sample: Arc::new(Mutex::new(Some(Sample { available_mb, load }))),
            samples: Arc::new(AtomicUsize::new(0)),
            clock: Arc::new(AtomicI64::new(0)),
        }
    }
    pub fn set(&self, available_mb: f64, load: f64) {
        *self.sample.lock().unwrap() = Some(Sample { available_mb, load });
    }
    pub fn unavailable(&self) {
        *self.sample.lock().unwrap() = None;
    }
    pub fn options(&self, directory: &Path) -> Options {
        let sample = self.sample.clone();
        let samples = self.samples.clone();
        let clock = self.clock.clone();
        let mut options = Options::new(directory);
        options.sample = Arc::new(move || {
            samples.fetch_add(1, Ordering::SeqCst);
            *sample.lock().unwrap()
        });
        options.now = Arc::new(move || clock.load(Ordering::SeqCst));
        options.backstop = Duration::from_millis(100);
        options.heartbeat = Duration::from_millis(50);
        options.parallelism = 64;
        options
    }
}

impl Host {
    pub fn tick(&self) {
        self.clock.fetch_add(1, Ordering::SeqCst);
    }
    pub fn wall_options(&self, directory: &Path) -> Options {
        let mut options = self.options(directory);
        options.now = Arc::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
        });
        options
    }
}

pub struct Spec {
    pub limits: Limits,
    pub memory_limit_mb: Option<u64>,
    pub resident_mb: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
    pub command: Option<String>,
    pub cwd: PathBuf,
    pub admission: Option<Arc<dyn Admission>>,
}
impl Default for Spec {
    fn default() -> Self {
        Self {
            limits: Limits::default(),
            memory_limit_mb: None,
            resident_mb: None,
            command: None,
            cwd: PathBuf::from("/workspace"),
            admission: None,
        }
    }
}
impl Spec {
    pub fn running(max_running: usize) -> Self {
        Self {
            limits: Limits {
                max_running,
                ..Limits::default()
            },
            ..Self::default()
        }
    }
    pub fn limits(mut self, change: impl FnOnce(&mut Limits)) -> Self {
        change(&mut self.limits);
        self
    }
    pub fn memory(mut self, memory_limit_mb: u64) -> Self {
        self.memory_limit_mb = Some(memory_limit_mb);
        self
    }
    pub fn command(mut self, command: &str) -> Self {
        self.command = Some(command.into());
        self
    }
    pub fn cwd(mut self, cwd: &str) -> Self {
        self.cwd = cwd.into();
        self
    }
    pub fn resident(mut self, resident: Arc<dyn Fn() -> f64 + Send + Sync>) -> Self {
        self.resident_mb = Some(resident);
        self
    }
    pub fn admission(mut self, admission: Arc<dyn Admission>) -> Self {
        self.admission = Some(admission);
        self
    }
}

pub fn request(id: &str, session: &str, spec: Spec) -> Request {
    Request {
        id: id.into(),
        session_id: session.into(),
        command: spec.command.unwrap_or_else(|| id.into()),
        cwd: spec.cwd,
        admission: spec.admission,
        memory_limit_mb: spec.memory_limit_mb,
        resident_mb: spec.resident_mb,
        limits: spec.limits,
    }
}

pub struct Waiter {
    pub id: String,
    pub position: usize,
    pub positions: Arc<Mutex<Vec<usize>>>,
    admitted: Arc<AtomicBool>,
    lost: Arc<AtomicBool>,
    release: Arc<Notify>,
    task: Option<JoinHandle<()>>,
}
impl Waiter {
    pub fn is_admitted(&self) -> bool {
        self.admitted.load(Ordering::SeqCst)
    }
    pub fn is_lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }
    pub fn positions(&self) -> Vec<usize> {
        self.positions.lock().unwrap().clone()
    }
    pub async fn admitted(&self) {
        until(|| self.is_admitted(), "the entry was not admitted").await;
    }
    pub async fn release(&mut self) {
        self.release.notify_one();
        if let Some(task) = self.task.take() {
            task.await.unwrap();
        }
    }
}
impl Drop for Waiter {
    fn drop(&mut self) {
        self.release.notify_one();
    }
}

pub async fn enqueue(queue: &Queue, id: &str, session: &str, spec: Spec) -> Waiter {
    try_enqueue(queue, id, session, spec).await.unwrap()
}

pub async fn try_enqueue(
    queue: &Queue,
    id: &str,
    session: &str,
    spec: Spec,
) -> Result<Waiter, Full> {
    let mut ticket = match queue.enqueue(request(id, session, spec)).await {
        Ok(ticket) => ticket,
        Err(Error::Full(full)) => return Err(full),
        Err(Error::Io(error)) => panic!("the queue failed to enqueue {id}: {error}"),
    };
    let position = ticket.position();
    let positions = Arc::new(Mutex::new(Vec::new()));
    let admitted = Arc::new(AtomicBool::new(false));
    let lost = Arc::new(AtomicBool::new(false));
    let release = Arc::new(Notify::new());
    let task = tokio::spawn({
        let (positions, admitted, lost, release) = (
            positions.clone(),
            admitted.clone(),
            lost.clone(),
            release.clone(),
        );
        async move {
            let outcome = tokio::select! {
                () = release.notified() => None,
                result = ticket.admitted(|position| positions.lock().unwrap().push(position)) => Some(result),
            };
            match outcome {
                Some(Ok(())) => {
                    admitted.store(true, Ordering::SeqCst);
                    release.notified().await;
                }
                Some(Err(_)) => lost.store(true, Ordering::SeqCst),
                None => {}
            }
            drop(ticket);
        }
    });
    Ok(Waiter {
        id: id.into(),
        position,
        positions,
        admitted,
        lost,
        release,
        task: Some(task),
    })
}

pub async fn until(mut probe: impl FnMut() -> bool, message: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !probe() {
        assert!(Instant::now() < deadline, "{message}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub async fn settle() {
    tokio::time::sleep(Duration::from_millis(400)).await;
}

pub fn flags(waiters: &[&Waiter]) -> Vec<bool> {
    waiters.iter().map(|waiter| waiter.is_admitted()).collect()
}

pub struct Family {
    pub name: String,
    pub open: AtomicBool,
    pub acquired: AtomicUsize,
    pub committed: Arc<AtomicUsize>,
    pub released: Arc<AtomicUsize>,
    listeners: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
}
impl Family {
    pub fn new(name: &str, open: bool) -> Arc<Self> {
        Arc::new(Self {
            name: name.into(),
            open: AtomicBool::new(open),
            acquired: AtomicUsize::new(0),
            committed: Arc::new(AtomicUsize::new(0)),
            released: Arc::new(AtomicUsize::new(0)),
            listeners: Mutex::new(Vec::new()),
        })
    }
    pub fn open(&self) {
        self.open.store(true, Ordering::SeqCst);
        for wake in self.listeners.lock().unwrap().iter() {
            wake();
        }
    }
    pub fn subscribers(&self) -> usize {
        self.listeners.lock().unwrap().len()
    }
}
struct Reservation {
    committed: Arc<AtomicUsize>,
    released: Arc<AtomicUsize>,
}
impl FamilyReservation for Reservation {
    fn commit(&self) {
        self.committed.fetch_add(1, Ordering::SeqCst);
    }
    fn release(&self) {
        self.released.fetch_add(1, Ordering::SeqCst);
    }
}
impl Admission for Family {
    fn family(&self) -> &str {
        &self.name
    }
    fn acquire(&self) -> Option<Box<dyn FamilyReservation>> {
        if !self.open.load(Ordering::SeqCst) {
            return None;
        }
        self.acquired.fetch_add(1, Ordering::SeqCst);
        Some(Box::new(Reservation {
            committed: self.committed.clone(),
            released: self.released.clone(),
        }))
    }
    fn subscribe(&self, wake: Arc<dyn Fn() + Send + Sync>) -> Box<dyn FnOnce() + Send> {
        self.listeners.lock().unwrap().push(wake);
        Box::new(|| {})
    }
}

pub async fn open(options: Options) -> Queue {
    Queue::open(options).await.unwrap()
}
