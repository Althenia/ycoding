use super::evaluator::Vm;
use super::values::{Fault, Value};
use std::collections::VecDeque;
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

pub(crate) type ValueFuture = Pin<Box<dyn Future<Output = Result<Value, Fault>> + Send>>;

pub(crate) struct Task {
    pub promise: usize,
    pub future: ValueFuture,
}

#[derive(Default)]
pub(crate) struct Jobs {
    pub tasks: Vec<Option<Task>>,
    pub ready: VecDeque<usize>,
    pub driver: Option<Waker>,
    pub preempted: bool,
}

struct TaskWake {
    id: usize,
    jobs: Arc<Mutex<Jobs>>,
}

impl Wake for TaskWake {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref()
    }
    fn wake_by_ref(self: &Arc<Self>) {
        let mut jobs = self.jobs.lock().expect("Code Mode reaction queue poisoned");
        if !jobs.ready.contains(&self.id) {
            jobs.ready.push_back(self.id);
        }
        if let Some(driver) = &jobs.driver {
            driver.wake_by_ref();
        }
    }
}

impl Vm {
    pub fn spawn(&self, future: ValueFuture) -> Value {
        let promise = {
            let mut state = self.state();
            let id = state.promises.len();
            state.promises.push(super::values::Promise::default());
            id
        };
        self.spawn_into(promise, future);
        Value::Promise(promise)
    }

    pub fn spawn_into(&self, promise: usize, future: ValueFuture) {
        let id = {
            let mut jobs = self.jobs.lock().expect("Code Mode reaction queue poisoned");
            let id = jobs.tasks.len();
            jobs.tasks.push(Some(Task { promise, future }));
            id
        };
        self.poll_task(id);
    }

    pub fn poll_task(&self, id: usize) {
        let task = self
            .jobs
            .lock()
            .expect("Code Mode reaction queue poisoned")
            .tasks
            .get_mut(id)
            .and_then(Option::take);
        let Some(mut task) = task else { return };
        let waker = Waker::from(Arc::new(TaskWake {
            id,
            jobs: self.jobs.clone(),
        }));
        let previous = self
            .current_task
            .swap(id, std::sync::atomic::Ordering::Relaxed);
        let result = task.future.as_mut().poll(&mut Context::from_waker(&waker));
        self.current_task
            .store(previous, std::sync::atomic::Ordering::Relaxed);
        match result {
            Poll::Ready(result) => self.settle(task.promise, result),
            Poll::Pending => {
                self.jobs
                    .lock()
                    .expect("Code Mode reaction queue poisoned")
                    .tasks[id] = Some(task)
            }
        }
    }

    pub fn settle(&self, id: usize, result: Result<Value, Fault>) {
        if let Ok(Value::Promise(other)) = &result {
            if id == *other {
                self.settle(
                    id,
                    Err(Fault::error(
                        "TypeError",
                        "Chaining cycle detected: a promise cannot resolve with itself.",
                        &self.origin,
                    )),
                );
                return;
            }
            let vm = self.clone();
            let value = Value::Promise(*other);
            self.spawn_into(id, Box::pin(async move { vm.await_value(value).await }));
            return;
        }
        let waiters = {
            let mut state = self.state();
            if state.promises[id].result.is_some() {
                return;
            }
            let order = state.settlement;
            state.settlement += 1;
            let promise = &mut state.promises[id];
            promise.result = Some(result);
            promise.settled_order = Some(order);
            std::mem::take(&mut promise.waiters)
        };
        for waker in waiters {
            waker.wake();
        }
    }

    pub fn resolve(&self, id: usize, result: Result<Value, Fault>) {
        {
            let mut state = self.state();
            if state.promises[id].resolved {
                return;
            }
            state.promises[id].resolved = true;
        }
        self.settle(id, result)
    }

    pub async fn await_value(&self, value: Value) -> Result<Value, Fault> {
        if let Value::Promise(id) = value {
            self.state().promises[id].observed = true;
            let mut deferred = false;
            return poll_fn(|cx| {
                if self.work_cancel.is_cancelled() {
                    return Poll::Ready(Err(self.interrupted(&self.origin)));
                }
                let mut state = self.state();
                let promise = &mut state.promises[id];
                if let Some(result) = &promise.result {
                    if !deferred {
                        deferred = true;
                        cx.waker().wake_by_ref();
                        return Poll::Pending;
                    }
                    return Poll::Ready(result.clone());
                }
                deferred = true;
                if !promise
                    .waiters
                    .iter()
                    .any(|waker| waker.will_wake(cx.waker()))
                {
                    promise.waiters.push(cx.waker().clone());
                }
                Poll::Pending
            })
            .await;
        }
        turn().await;
        Ok(value)
    }

    pub fn observe(&self, value: &Value) {
        if let Value::Promise(id) = value {
            self.state().promises[*id].observed = true;
        }
    }

    pub async fn drive(&self, id: usize) -> Result<Value, Fault> {
        poll_fn(|cx| {
            self.jobs
                .lock()
                .expect("Code Mode reaction queue poisoned")
                .driver = Some(cx.waker().clone());
            loop {
                {
                    let mut jobs = self.jobs.lock().expect("Code Mode reaction queue poisoned");
                    if jobs.preempted {
                        jobs.preempted = false;
                        cx.waker().wake_by_ref();
                        return Poll::Pending;
                    }
                }
                if let Some(result) = self.state().promises[id].result.clone() {
                    return Poll::Ready(result);
                }
                let task = self
                    .jobs
                    .lock()
                    .expect("Code Mode reaction queue poisoned")
                    .ready
                    .pop_front();
                match task {
                    Some(task) => self.poll_task(task),
                    None => return Poll::Pending,
                }
            }
        })
        .await
    }

    pub async fn cleanup(&self) {
        self.work_cancel.cancel();
        {
            let mut jobs = self.jobs.lock().expect("Code Mode reaction queue poisoned");
            let tasks = jobs
                .tasks
                .iter()
                .enumerate()
                .filter_map(|(id, task)| task.as_ref().map(|_| id))
                .collect::<Vec<_>>();
            for id in tasks {
                if !jobs.ready.contains(&id) {
                    jobs.ready.push_back(id);
                }
            }
        }
        poll_fn(|cx| {
            self.jobs
                .lock()
                .expect("Code Mode reaction queue poisoned")
                .driver = Some(cx.waker().clone());
            loop {
                let task = self
                    .jobs
                    .lock()
                    .expect("Code Mode reaction queue poisoned")
                    .ready
                    .pop_front();
                if let Some(task) = task {
                    self.poll_task(task);
                    continue;
                }
                if self
                    .jobs
                    .lock()
                    .expect("Code Mode reaction queue poisoned")
                    .tasks
                    .iter()
                    .all(Option::is_none)
                {
                    return Poll::Ready(());
                }
                return Poll::Pending;
            }
        })
        .await;
    }
}

pub(crate) async fn turn() {
    let mut deferred = false;
    poll_fn(|cx| {
        if deferred {
            Poll::Ready(())
        } else {
            deferred = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    })
    .await
}
