use super::{Error, Extension, SessionServices, supervisor::ParentPreparation, v5, wire};
use prost::Message;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, watch},
    task::JoinHandle,
};

#[derive(Clone, Debug)]
pub struct ParentError(Arc<Vec<String>>);
impl ParentError {
    fn message(message: impl Into<String>) -> Self {
        Self(Arc::new(vec![message.into()]))
    }
}
impl fmt::Display for ParentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0.join("; "))
    }
}
impl std::error::Error for ParentError {}

pub struct ParentOwner {
    inner: Arc<Inner>,
}
#[derive(Clone)]
pub struct ParentHandle {
    inner: Arc<Inner>,
}
type ResultState = watch::Sender<Option<Result<(), ParentError>>>;
struct Inner {
    inherited: Mutex<Option<Inherited>>,
    outgoing: mpsc::Sender<v5::ParentFrame>,
    receiver: Mutex<Option<mpsc::Receiver<v5::ParentFrame>>>,
    manifest: Mutex<Vec<v5::ParentEntry>>,
    generations: Mutex<BTreeMap<String, Slot>>,
    owners: Mutex<Vec<Arc<Extension>>>,
    services: Mutex<Vec<(ycoding_schema::location::Ref, SessionServices)>>,
    tasks: tokio::sync::Mutex<Vec<JoinHandle<()>>>,
    started: AtomicBool,
    retired: AtomicBool,
    closing: AtomicBool,
    ready: ResultState,
    closed: ResultState,
    lease: ResultState,
    stop: watch::Sender<bool>,
    errors: Mutex<Vec<String>>,
}
struct Slot {
    sender: Option<mpsc::Sender<v5::ChildFrame>>,
    closed: ResultState,
}
pub(super) struct Channel {
    inner: Arc<Inner>,
    generation: String,
    incoming: mpsc::Receiver<v5::ChildFrame>,
    closed: watch::Receiver<Option<Result<(), ParentError>>>,
}
#[cfg(unix)]
struct Inherited {
    data: std::os::unix::net::UnixStream,
    cleanup: std::os::unix::net::UnixStream,
}
#[cfg(not(unix))]
struct Inherited;

impl ParentOwner {
    pub fn inherit(data: Option<u32>, cleanup: Option<u32>) -> Result<Option<Self>, ParentError> {
        let (data, cleanup) = match (data, cleanup) {
            (None, None) => return Ok(None),
            (Some(data), Some(cleanup)) if data >= 3 && cleanup >= 3 && data != cleanup => {
                (data, cleanup)
            }
            _ => {
                return Err(ParentError::message(
                    "Parent attachment requires distinct explicit data and cleanup descriptors",
                ));
            }
        };
        let inherited = inherit(data, cleanup)?;
        let (outgoing, receiver) = mpsc::channel(64);
        Ok(Some(Self {
            inner: Arc::new(Inner {
                inherited: Mutex::new(Some(inherited)),
                outgoing,
                receiver: Mutex::new(Some(receiver)),
                manifest: Default::default(),
                generations: Default::default(),
                owners: Default::default(),
                services: Default::default(),
                tasks: Default::default(),
                started: AtomicBool::new(false),
                retired: AtomicBool::new(false),
                closing: AtomicBool::new(false),
                ready: watch::channel(None).0,
                closed: watch::channel(None).0,
                lease: watch::channel(None).0,
                stop: watch::channel(false).0,
                errors: Default::default(),
            }),
        }))
    }

    pub async fn start(&self) -> Result<(), ParentError> {
        let mut tasks = self.inner.tasks.lock().await;
        if !self.inner.started.swap(true, Ordering::AcqRel)
            && let Err(error) = start(&self.inner, &mut tasks)
        {
            self.inner.failure(error.to_string());
            self.inner.ready.send_replace(Some(Err(error.clone())));
            self.inner.lease.send_replace(Some(Err(error)));
        }
        drop(tasks);
        wait(self.inner.ready.subscribe()).await
    }

    pub fn handle(&self) -> ParentHandle {
        ParentHandle {
            inner: self.inner.clone(),
        }
    }

    pub fn retire(&self) {
        self.inner.retire()
    }

    pub async fn close(&self) -> Result<(), ParentError> {
        let mut tasks = self.inner.tasks.lock().await;
        if !self.inner.closing.swap(true, Ordering::AcqRel) {
            let inner = self.inner.clone();
            tasks.push(tokio::spawn(async move {
                inner.retire();
                let owners = inner
                    .owners
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                for owner in owners {
                    owner.shutdown().await;
                }
                inner
                    .services
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clear();
                if inner.started.load(Ordering::Acquire) {
                    if let Err(error) = inner
                        .send(v5::parent_frame::Body::Shutdown(v5::ParentShutdown {}))
                        .await
                    {
                        inner.failure(error.to_string());
                    }
                    if let Err(error) = wait(inner.lease.subscribe()).await {
                        inner.failure(error.to_string());
                    }
                } else {
                    inner
                        .inherited
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .take();
                }
                inner.stop.send_replace(true);
                inner.closed.send_replace(Some(inner.result()));
            }));
        }
        drop(tasks);
        wait(self.inner.closed.subscribe()).await
    }

    pub async fn join(&self) -> Result<(), ParentError> {
        let _ = wait(self.inner.closed.subscribe()).await;
        let mut tasks = self.inner.tasks.lock().await;
        while let Some(task) = tasks.last_mut() {
            if let Err(error) = task.await {
                self.inner
                    .failure(format!("Parent owner task failed: {error}"));
            }
            tasks.pop();
        }
        self.inner.result()
    }
}

impl Inner {
    fn failure(&self, failure: String) {
        self.errors
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(failure);
    }
    fn result(&self) -> Result<(), ParentError> {
        let errors = self
            .errors
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if errors.is_empty() {
            Ok(())
        } else {
            Err(ParentError(Arc::new(errors.clone())))
        }
    }
    async fn send(&self, body: v5::parent_frame::Body) -> Result<(), ParentError> {
        self.outgoing
            .send(v5::ParentFrame { body: Some(body) })
            .await
            .map_err(|_| ParentError::message("Parent data writer ended"))
    }
    fn retire(&self) {
        if self.retired.swap(true, Ordering::AcqRel) {
            return;
        }
        if self.ready.borrow().is_none() {
            self.ready.send_replace(Some(Err(ParentError::message(
                "Parent attachment retired before readiness",
            ))));
        }
        for owner in self
            .owners
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
        {
            owner.retire();
        }
        if self.started.load(Ordering::Acquire)
            && self
                .outgoing
                .try_send(v5::ParentFrame {
                    body: Some(v5::parent_frame::Body::Retire(v5::ParentRetire {})),
                })
                .is_err()
        {
            self.failure("Parent retirement notification could not be queued".into());
        }
    }
    fn fail_channel(&self, failure: ParentError) {
        self.failure(failure.to_string());
        if self.ready.borrow().is_none() {
            self.ready.send_replace(Some(Err(failure.clone())));
        }
        for slot in self
            .generations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .values_mut()
        {
            slot.sender.take();
            if slot.closed.borrow().is_none() {
                slot.closed.send_replace(Some(Err(failure.clone())));
            }
        }
        self.retire();
    }
}

impl ParentHandle {
    pub(super) fn failure(&self, message: &str) {
        self.inner.fail_channel(ParentError::message(message));
    }
    pub(super) fn bind_services(&self, services: SessionServices) -> Result<(), Error> {
        if self.inner.retired.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        let location = services.runner.location().clone();
        let mut bindings = self
            .inner
            .services
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some((_, current)) = bindings
            .iter_mut()
            .find(|(candidate, _)| candidate == &location)
        {
            *current = services;
        } else {
            bindings.push((location, services));
        }
        Ok(())
    }
    pub(super) fn services(
        &self,
        location: &ycoding_schema::location::Ref,
    ) -> Option<SessionServices> {
        self.inner
            .services
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .find(|(candidate, _)| candidate == location)
            .map(|(_, services)| services.clone())
    }
    pub(super) fn entries(&self) -> Result<Vec<v5::ParentEntry>, Error> {
        if self.inner.retired.load(Ordering::Acquire)
            || !matches!(&*self.inner.ready.borrow(), Some(Ok(())))
        {
            return Err(Error::Stopped);
        }
        Ok(self
            .inner
            .manifest
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone())
    }
    pub(super) async fn prepare(
        &self,
        preparation: ParentPreparation,
    ) -> Result<Arc<Extension>, Error> {
        let mut tasks = self.inner.tasks.lock().await;
        if self.inner.retired.load(Ordering::Acquire) {
            return Err(Error::Stopped);
        }
        let inner = self.inner.clone();
        let result = watch::channel(None).0;
        let receive = result.subscribe();
        tasks.push(tokio::spawn(async move {
            let prepared = Extension::prepare_parent(
                ParentHandle {
                    inner: inner.clone(),
                },
                preparation,
            )
            .await;
            if let Ok(extension) = &prepared {
                inner
                    .owners
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push(extension.clone());
                if inner.retired.load(Ordering::Acquire) {
                    extension.shutdown().await;
                }
            }
            result.send_replace(Some(prepared));
        }));
        drop(tasks);
        let mut receive = receive;
        loop {
            if let Some(result) = receive.borrow_and_update().clone() {
                return result;
            }
            receive.changed().await.map_err(|_| Error::Stopped)?;
        }
    }
    pub(super) async fn channel(
        &self,
        entry: &v5::ParentEntry,
        generation: String,
    ) -> Result<Channel, Error> {
        let entries = self.entries()?;
        if !entries.contains(entry) {
            return Err(Error::Unauthorized);
        }
        let (sender, incoming) = mpsc::channel(64);
        let closed = watch::channel(None).0;
        let receive = closed.subscribe();
        {
            let mut generations = self
                .inner
                .generations
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.inner.retired.load(Ordering::Acquire) || generations.contains_key(&generation) {
                return Err(Error::Stopped);
            }
            generations.insert(
                generation.clone(),
                Slot {
                    sender: Some(sender),
                    closed,
                },
            );
        }
        self.inner
            .send(v5::parent_frame::Body::Open(v5::ParentOpen {
                generation: generation.clone(),
                id: entry.id.clone(),
                version: entry.version,
            }))
            .await
            .map_err(|_| Error::UnknownOutcome)?;
        Ok(Channel {
            inner: self.inner.clone(),
            generation,
            incoming,
            closed: receive,
        })
    }
}

impl Channel {
    pub(super) async fn send(&self, frame: v5::HostFrame) -> Result<(), Error> {
        self.inner
            .send(v5::parent_frame::Body::Data(v5::ParentData {
                generation: self.generation.clone(),
                payload: frame.encode_to_vec(),
            }))
            .await
            .map_err(|_| Error::UnknownOutcome)
    }
    pub(super) async fn next(&mut self) -> Result<v5::ChildFrame, Error> {
        self.incoming.recv().await.ok_or(Error::UnknownOutcome)
    }
    pub(super) async fn close(&mut self) -> bool {
        if self.closed.borrow().is_none() {
            let _ = self
                .send(v5::HostFrame {
                    generation: self.generation.clone(),
                    body: Some(v5::host_frame::Body::Shutdown(v5::Shutdown {})),
                })
                .await;
        }
        wait(self.closed.clone()).await.is_ok()
    }
}

async fn wait(
    mut receive: watch::Receiver<Option<Result<(), ParentError>>>,
) -> Result<(), ParentError> {
    loop {
        if let Some(result) = receive.borrow_and_update().clone() {
            return result;
        }
        receive
            .changed()
            .await
            .map_err(|_| ParentError::message("Parent owner completion signal ended"))?;
    }
}

#[cfg(unix)]
fn inherit(data: u32, cleanup: u32) -> Result<Inherited, ParentError> {
    use std::os::fd::{FromRawFd, OwnedFd};
    let descriptor = |value: u32| {
        i32::try_from(value).map_err(|_| ParentError::message("Parent descriptor is out of range"))
    };
    let (data, cleanup) = (descriptor(data)?, descriptor(cleanup)?);
    let inspect = |fd: i32| -> Result<libc::stat, ParentError> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        let mut kind = 0_i32;
        let mut length = std::mem::size_of::<i32>() as libc::socklen_t;
        let valid = unsafe {
            libc::fstat(fd, stat.as_mut_ptr()) == 0
                && libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_TYPE,
                    (&mut kind as *mut i32).cast(),
                    &mut length,
                ) == 0
                && kind == libc::SOCK_STREAM
        };
        if !valid {
            return Err(ParentError::message(
                "Parent descriptor is not an inherited stream socket",
            ));
        }
        Ok(unsafe { stat.assume_init() })
    };
    let first = inspect(data)?;
    let second = inspect(cleanup)?;
    if first.st_ino != 0 && first.st_dev == second.st_dev && first.st_ino == second.st_ino {
        return Err(ParentError::message(
            "Parent descriptors alias one resource",
        ));
    }
    let flags = unsafe { libc::fcntl(data, libc::F_GETFL) };
    let other = unsafe { libc::fcntl(cleanup, libc::F_GETFL) };
    if flags < 0
        || other < 0
        || unsafe { libc::fcntl(data, libc::F_SETFL, flags ^ libc::O_NONBLOCK) } < 0
    {
        return Err(ParentError::message(
            "Parent descriptor identity could not be validated",
        ));
    }
    let changed = unsafe { libc::fcntl(cleanup, libc::F_GETFL) };
    let restored = unsafe { libc::fcntl(data, libc::F_SETFL, flags) };
    if changed < 0 || restored < 0 {
        return Err(ParentError::message(
            "Parent descriptor identity validation failed",
        ));
    }
    if changed != other {
        return Err(ParentError::message(
            "Parent descriptors alias one open resource",
        ));
    }
    let first = unsafe { OwnedFd::from_raw_fd(data) };
    let second = unsafe { OwnedFd::from_raw_fd(cleanup) };
    for fd in [data, cleanup] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(ParentError::message(
                "Parent descriptor non-inheritance could not be established",
            ));
        }
    }
    let inherited = Inherited {
        data: first.into(),
        cleanup: second.into(),
    };
    inherited
        .data
        .set_nonblocking(true)
        .map_err(|error| ParentError::message(error.to_string()))?;
    inherited
        .cleanup
        .set_nonblocking(true)
        .map_err(|error| ParentError::message(error.to_string()))?;
    Ok(inherited)
}

#[cfg(not(unix))]
fn inherit(_data: u32, _cleanup: u32) -> Result<Inherited, ParentError> {
    Err(ParentError::message(
        "Parent descriptor adoption is unavailable on this platform",
    ))
}

#[cfg(unix)]
fn start(inner: &Arc<Inner>, tasks: &mut Vec<JoinHandle<()>>) -> Result<(), ParentError> {
    let inherited = inner
        .inherited
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
        .ok_or_else(|| ParentError::message("Parent descriptors were already adopted"))?;
    let data = tokio::net::UnixStream::from_std(inherited.data)
        .map_err(|error| ParentError::message(error.to_string()))?;
    let mut cleanup = tokio::net::UnixStream::from_std(inherited.cleanup)
        .map_err(|error| ParentError::message(error.to_string()))?;
    let (mut reader, mut writer) = data.into_split();
    let mut outgoing = inner
        .receiver
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
        .ok_or_else(|| ParentError::message("Parent data writer already started"))?;
    let writer_inner = inner.clone();
    let mut stop = inner.stop.subscribe();
    tasks.push(tokio::spawn(async move {
        let outcome: Result<(), ParentError> = async {
            loop {
                let frame = tokio::select! {
                    changed = stop.changed() => { let _ = changed; break; }
                    frame = outgoing.recv() => match frame { Some(frame) => frame, None => break },
                };
                let payload = frame.encode_to_vec();
                if payload.len() > wire::FRAME_BYTES {
                    return Err(ParentError::message(
                        "Parent output frame capacity exceeded",
                    ));
                }
                writer
                    .write_u32_le(payload.len() as u32)
                    .await
                    .map_err(|error| ParentError::message(error.to_string()))?;
                writer
                    .write_all(&payload)
                    .await
                    .map_err(|error| ParentError::message(error.to_string()))?;
            }
            writer
                .shutdown()
                .await
                .map_err(|error| ParentError::message(error.to_string()))
        }
        .await;
        if let Err(error) = outcome {
            writer_inner.fail_channel(error);
        }
    }));
    let reader_inner = inner.clone();
    let mut stop = inner.stop.subscribe();
    tasks.push(tokio::spawn(async move {
        let result: Result<(), ParentError> = async {
            loop {
                let frame = tokio::select! {
                    changed = stop.changed() => { let _ = changed; return Ok(()); }
                    frame = async {
                        let size = reader.read_u32_le().await.map_err(|error| ParentError::message(format!("Parent data read failed: {error}")))? as usize;
                        if size == 0 || size > wire::FRAME_BYTES { return Err(ParentError::message("Invalid parent frame size")); }
                        let mut bytes = vec![0; size];
                        reader.read_exact(&mut bytes).await.map_err(|error| ParentError::message(error.to_string()))?;
                        v5::ParentFrame::decode(bytes.as_slice()).map_err(|_| ParentError::message("Invalid parent frame"))
                    } => frame?,
                };
                dispatch(&reader_inner, frame)?;
            }
        }.await;
        if let Err(error) = result { reader_inner.fail_channel(error); }
    }));
    let lease_inner = inner.clone();
    tasks.push(tokio::spawn(async move {
        let mut byte = [0_u8; 1];
        let result = match cleanup.read(&mut byte).await {
            Ok(0) => Ok(()),
            Ok(_) => Err(ParentError::message(
                "Parent cleanup lease carried unexpected data",
            )),
            Err(error) => Err(ParentError::message(format!(
                "Parent cleanup lease failed: {error}"
            ))),
        };
        lease_inner.lease.send_replace(Some(result));
    }));
    Ok(())
}

#[cfg(not(unix))]
fn start(_inner: &Arc<Inner>, _tasks: &mut Vec<JoinHandle<()>>) -> Result<(), ParentError> {
    Err(ParentError::message(
        "Parent IO is unavailable on this platform",
    ))
}

fn dispatch(inner: &Arc<Inner>, frame: v5::ParentFrame) -> Result<(), ParentError> {
    match frame
        .body
        .ok_or_else(|| ParentError::message("Empty parent frame"))?
    {
        v5::parent_frame::Body::Manifest(manifest) => {
            if inner.ready.borrow().is_some()
                || manifest.pid != std::process::id()
                || manifest.plugins.len() > 256
            {
                return Err(ParentError::message(
                    "Parent manifest process binding rejected",
                ));
            }
            let mut ids = BTreeSet::new();
            if manifest.plugins.iter().any(|entry| {
                entry.id.is_empty()
                    || entry.id.len() > 256
                    || entry.id.chars().any(char::is_control)
                    || entry.version == 0
                    || !ids.insert(entry.id.clone())
            }) {
                return Err(ParentError::message("Parent manifest registry rejected"));
            }
            *inner
                .manifest
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = manifest.plugins;
            inner.ready.send_replace(Some(Ok(())));
        }
        v5::parent_frame::Body::Data(data) => {
            let frame = v5::ChildFrame::decode(data.payload.as_slice())
                .map_err(|_| ParentError::message("Invalid parent child frame"))?;
            if frame.generation != data.generation || frame.body.is_none() {
                return Err(ParentError::message("Parent generation binding rejected"));
            }
            let generations = inner
                .generations
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let sender = generations
                .get(&data.generation)
                .and_then(|slot| slot.sender.as_ref())
                .ok_or_else(|| ParentError::message("Unknown parent generation"))?;
            sender.try_send(frame).map_err(|_| {
                ParentError::message("Parent generation delivery capacity exhausted")
            })?;
        }
        v5::parent_frame::Body::Closed(closed) => {
            let mut generations = inner
                .generations
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let slot = generations
                .get_mut(&closed.generation)
                .ok_or_else(|| ParentError::message("Unknown closed parent generation"))?;
            if slot.closed.borrow().is_some() {
                return Err(ParentError::message("Repeated parent generation close"));
            }
            let result = closed
                .failure
                .map(|failure| {
                    wire::read_text(failure)
                        .map_err(|_| ParentError::message("Invalid parent cleanup failure"))
                })
                .transpose()?
                .map(|failure| {
                    ParentError::message(String::from_utf16_lossy(
                        &failure.code_units().collect::<Vec<_>>(),
                    ))
                });
            if let Some(error) = &result {
                inner.failure(error.to_string());
            }
            slot.sender.take();
            slot.closed.send_replace(Some(result.map_or(Ok(()), Err)));
        }
        v5::parent_frame::Body::Retire(_) => inner.retire(),
        _ => return Err(ParentError::message("Unexpected parent control frame")),
    }
    Ok(())
}
