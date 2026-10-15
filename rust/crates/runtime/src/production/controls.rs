use super::unavailable;
use crate::dispatch::{Boxed, Failure};
use std::sync::Arc;
use tokio::sync::{Notify, mpsc, oneshot, watch};
use ycoding_core::{
    event_feed, platform::browser::service::Lifecycle, ycoding_schema::session_id::SessionId,
};

pub(super) type Release =
    Arc<dyn Fn(SessionId, Lifecycle) -> Boxed<Result<(), Failure>> + Send + Sync>;

pub(super) struct Owner {
    stop: watch::Sender<bool>,
    requests: mpsc::Sender<Request>,
    task: Option<tokio::task::JoinHandle<Result<(), Failure>>>,
}

struct Request {
    release: Option<(SessionId, Lifecycle)>,
    reply: oneshot::Sender<Result<(), Failure>>,
}

impl Owner {
    pub fn start(feed: event_feed::Feed, release: Release) -> Result<Self, Failure> {
        let notify = Arc::new(Notify::new());
        let notified = notify.clone();
        let subscriber = feed
            .subscribe_types(
                event_feed::Scope::Global,
                &[
                    "session.moved.1",
                    "session.deleted.2",
                    "session.archived.2",
                    "session.agent.selected.1",
                ],
                move || notified.notify_one(),
            )
            .map_err(|_| unavailable("control lifecycle subscription"))?;
        let (stop, mut stopped) = watch::channel(false);
        let (requests, mut incoming) = mpsc::channel::<Request>(16);
        let task = tokio::spawn(async move {
            let mut failure = None;
            loop {
                let request = tokio::select! {
                    _ = stopped.changed() => None,
                    _ = notify.notified() => None,
                    request = incoming.recv() => request,
                };
                loop {
                    let item = match subscriber.next() {
                        Ok(Some(item)) => item,
                        Ok(None) => break,
                        Err(_) => {
                            tracing::error!("Control lifecycle subscription overflowed");
                            return Err(unavailable("control lifecycle subscription overflow"));
                        }
                    };
                    let event_feed::Payload::Durable(event) = &item.payload else {
                        continue;
                    };
                    let lifecycle = match event.type_.as_str() {
                        Some("session.moved.1") => Lifecycle::Moved,
                        Some("session.deleted.2") => Lifecycle::Deleted,
                        Some("session.archived.2") => Lifecycle::Archived,
                        Some("session.agent.selected.1") => Lifecycle::Moved,
                        _ => continue,
                    };
                    let Ok(session) = SessionId::new(event.aggregate_id.clone()) else {
                        tracing::error!("Control lifecycle Session identity is invalid");
                        continue;
                    };
                    if let Err(error) = release(session, lifecycle).await {
                        tracing::error!("Control lifecycle release failed");
                        failure.get_or_insert(error);
                    }
                }
                if let Some(request) = request {
                    let result = match request.release {
                        Some((session, lifecycle)) => release(session, lifecycle).await,
                        None if failure.is_some() => Err(unavailable("control lifecycle release")),
                        None => Ok(()),
                    };
                    if let Err(Err(error)) = request.reply.send(result) {
                        failure.get_or_insert(error);
                    }
                }
                if *stopped.borrow() {
                    while let Ok(request) = incoming.try_recv() {
                        let result = match request.release {
                            Some((session, lifecycle)) => release(session, lifecycle).await,
                            None if failure.is_some() => {
                                Err(unavailable("control lifecycle release"))
                            }
                            None => Ok(()),
                        };
                        if let Err(Err(error)) = request.reply.send(result) {
                            failure.get_or_insert(error);
                        }
                    }
                    return failure.map_or(Ok(()), Err);
                }
            }
        });
        Ok(Self {
            stop,
            requests,
            task: Some(task),
        })
    }

    pub async fn release(&self, session: SessionId, lifecycle: Lifecycle) -> Result<(), Failure> {
        self.request(Some((session, lifecycle))).await
    }

    pub async fn flush(&self) -> Result<(), Failure> {
        self.request(None).await
    }

    async fn request(&self, release: Option<(SessionId, Lifecycle)>) -> Result<(), Failure> {
        let (reply, received) = oneshot::channel();
        self.requests
            .send(Request { release, reply })
            .await
            .map_err(|_| unavailable("control lifecycle owner"))?;
        received
            .await
            .map_err(|_| unavailable("control lifecycle settlement"))?
    }

    pub async fn close(mut self) -> Result<(), Failure> {
        self.stop.send_replace(true);
        match self.task.take() {
            Some(task) => task
                .await
                .map_err(|_| unavailable("control lifecycle worker"))?,
            None => Ok(()),
        }
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}
