use super::unavailable;
use crate::dispatch::{Boxed, Failure};
use std::sync::Arc;
use tokio::sync::{Notify, watch};
use ycoding_core::{
    event_feed, platform::browser::service::Lifecycle, ycoding_schema::session_id::SessionId,
};

pub(super) type Release =
    Arc<dyn Fn(SessionId, Lifecycle) -> Boxed<Result<(), Failure>> + Send + Sync>;

pub(super) struct Owner {
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<Result<(), Failure>>>,
}

impl Owner {
    pub fn start(feed: event_feed::Feed, release: Release) -> Result<Self, Failure> {
        let notify = Arc::new(Notify::new());
        let notified = notify.clone();
        let subscriber = feed
            .subscribe_types(
                event_feed::Scope::Global,
                &["session.moved.1", "session.deleted.2", "session.archived.2"],
                move || notified.notify_one(),
            )
            .map_err(|_| unavailable("control lifecycle subscription"))?;
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut failure = None;
            loop {
                tokio::select! {
                    _ = stopped.changed() => return failure.map_or(Ok(()), Err),
                    _ = notify.notified() => {},
                }
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
            }
        });
        Ok(Self {
            stop,
            task: Some(task),
        })
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
