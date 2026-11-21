use std::sync::{Mutex, MutexGuard};
use tokio::sync::{oneshot, watch};

pub fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Clone, Debug, Default)]
pub struct Signal(Option<watch::Receiver<bool>>);

impl Signal {
    #[cfg(test)]
    pub fn never() -> Self {
        Self(None)
    }

    pub fn from_closed(closed: watch::Receiver<bool>) -> Self {
        Self(Some(closed))
    }

    pub fn is_aborted(&self) -> bool {
        self.0.as_ref().is_some_and(|receiver| *receiver.borrow())
    }

    pub async fn aborted(&self) {
        let Some(receiver) = &self.0 else {
            return std::future::pending::<()>().await;
        };
        let mut receiver = receiver.clone();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return std::future::pending::<()>().await;
            }
        }
    }
}

pub struct Abort(watch::Sender<bool>);

impl Abort {
    pub fn new() -> Self {
        Self(watch::channel(false).0)
    }

    pub fn signal(&self) -> Signal {
        Signal(Some(self.0.subscribe()))
    }

    pub fn abort(&self) {
        self.0.send_replace(true);
    }
}

impl Default for Abort {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
pub struct Sequencer {
    tail: Mutex<Option<oneshot::Receiver<()>>>,
}

pub struct Turn {
    previous: Option<oneshot::Receiver<()>>,
    _release: oneshot::Sender<()>,
}

impl Sequencer {
    pub fn turn(&self) -> Turn {
        let (release, next) = oneshot::channel();
        let previous = locked(&self.tail).replace(next);
        Turn {
            previous,
            _release: release,
        }
    }

    pub async fn idle(&self) {
        let mut turn = self.turn();
        turn.begin().await;
    }
}

impl Turn {
    pub async fn begin(&mut self) {
        if let Some(previous) = self.previous.take() {
            let _ = previous.await;
        }
    }
}
