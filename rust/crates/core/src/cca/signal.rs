use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

#[derive(Clone)]
pub struct HandlerContext {
    pub signal: Signal,
    pub session_id: String,
}

#[derive(Clone, Default)]
pub struct Signal(Arc<State>);

#[derive(Default)]
struct State {
    cancelled: AtomicBool,
    notification: Notify,
}

impl Signal {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        self.0.notification.notify_waiters();
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }
    pub async fn cancelled(&self) {
        loop {
            let notification = self.0.notification.notified();
            tokio::pin!(notification);
            notification.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notification.await;
        }
    }
    pub fn any(signals: &[Signal]) -> LinkedSignal {
        let combined = Signal::default();
        if signals.iter().any(Signal::is_cancelled) {
            combined.cancel();
        }
        let mut tasks = vec![];
        if !combined.is_cancelled() {
            for input in signals {
                let input = input.clone();
                let output = combined.clone();
                tasks.push(tokio::spawn(async move {
                    input.cancelled().await;
                    output.cancel();
                }));
            }
        }
        LinkedSignal {
            signal: combined,
            tasks,
        }
    }
}

pub struct LinkedSignal {
    signal: Signal,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl LinkedSignal {
    pub fn signal(&self) -> Signal {
        self.signal.clone()
    }
}
impl Drop for LinkedSignal {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}
