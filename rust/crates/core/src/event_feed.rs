use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, MutexGuard, PoisonError, Weak},
};
use ycoding_schema::{JsonValue, LosslessString, session};
use ycoding_store::{Client, session::Event};

pub const RETAINED_ITEMS: usize = 4_096;
pub const SUBSCRIBER_CAPACITY: usize = 4_096;

#[derive(Clone, Debug, PartialEq)]
pub enum Scope {
    Global,
    Session(session::Id),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ephemeral {
    pub id: LosslessString,
    pub created: i64,
    pub event_type: String,
    pub session: Option<session::Id>,
    pub data: JsonValue,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Payload {
    Durable(Event),
    Ephemeral(Ephemeral),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub position: u64,
    pub payload: Payload,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResumeError {
    Gap { oldest: u64 },
    Ahead { latest: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Overflow {
    pub capacity: usize,
}

#[derive(Clone)]
pub struct Feed(Arc<Shared>);

struct Shared {
    retained: usize,
    capacity: usize,
    state: Mutex<State>,
}

struct State {
    latest: u64,
    ring: VecDeque<Arc<Item>>,
    entries: Vec<Entry>,
    next_entry: u64,
}

struct Entry {
    id: u64,
    scope: Scope,
    queue: Arc<Queue>,
}

struct Queue {
    capacity: usize,
    state: Mutex<Backlog>,
    wake: Box<dyn Fn() + Send + Sync>,
}

struct Backlog {
    items: VecDeque<Arc<Item>>,
    overflowed: bool,
}

pub struct Subscriber {
    id: u64,
    queue: Arc<Queue>,
    feed: Weak<Shared>,
}

impl Feed {
    pub fn attach(client: &Client) -> Self {
        Self::attach_with(client, RETAINED_ITEMS, SUBSCRIBER_CAPACITY)
    }

    pub fn attach_with(client: &Client, retained: usize, capacity: usize) -> Self {
        let feed = Self(Arc::new(Shared {
            retained,
            capacity,
            state: Mutex::new(State {
                latest: 0,
                ring: VecDeque::new(),
                entries: Vec::new(),
                next_entry: 0,
            }),
        }));
        let shared = Arc::downgrade(&feed.0);
        client.observe_events(move |events| {
            let Some(shared) = shared.upgrade() else {
                return false;
            };
            Feed(shared).publish_all(events.iter().cloned().map(Payload::Durable));
            true
        });
        feed
    }

    pub fn watermark(&self) -> u64 {
        lock(&self.0.state).latest
    }

    pub fn subscribers(&self) -> usize {
        lock(&self.0.state).entries.len()
    }

    pub fn publish(&self, event: Ephemeral) {
        self.publish_all([Payload::Ephemeral(event)]);
    }

    pub fn subscribe(
        &self,
        scope: Scope,
        after: Option<u64>,
        wake: impl Fn() + Send + Sync + 'static,
    ) -> Result<Subscriber, ResumeError> {
        let mut state = lock(&self.0.state);
        let mut items = VecDeque::new();
        if let Some(after) = after {
            if after > state.latest {
                return Err(ResumeError::Ahead {
                    latest: state.latest,
                });
            }
            let oldest = state
                .ring
                .front()
                .map_or(state.latest + 1, |item| item.position);
            if after + 1 < oldest {
                return Err(ResumeError::Gap { oldest });
            }
            items = state
                .ring
                .iter()
                .filter(|item| item.position > after && matches(&scope, item))
                .cloned()
                .collect();
            if items.len() > self.0.capacity {
                return Err(ResumeError::Gap { oldest });
            }
        }
        let queue = Arc::new(Queue {
            capacity: self.0.capacity,
            state: Mutex::new(Backlog {
                items,
                overflowed: false,
            }),
            wake: Box::new(wake),
        });
        let id = state.next_entry;
        state.next_entry += 1;
        state.entries.push(Entry {
            id,
            scope,
            queue: queue.clone(),
        });
        Ok(Subscriber {
            id,
            queue,
            feed: Arc::downgrade(&self.0),
        })
    }

    fn publish_all(&self, payloads: impl IntoIterator<Item = Payload>) {
        let mut woken = Vec::new();
        {
            let mut state = lock(&self.0.state);
            for payload in payloads {
                state.latest += 1;
                let item = Arc::new(Item {
                    position: state.latest,
                    payload,
                });
                if state.ring.len() == self.0.retained {
                    state.ring.pop_front();
                }
                if self.0.retained > 0 {
                    state.ring.push_back(item.clone());
                }
                state.entries.retain(|entry| {
                    if !matches(&entry.scope, &item) {
                        return true;
                    }
                    let mut backlog = lock(&entry.queue.state);
                    if backlog.items.len() < self.0.capacity {
                        backlog.items.push_back(item.clone());
                        woken.push(entry.queue.clone());
                        return true;
                    }
                    backlog.items.clear();
                    backlog.overflowed = true;
                    woken.push(entry.queue.clone());
                    false
                });
            }
        }
        woken.iter().for_each(|queue| (queue.wake)());
    }
}

impl Subscriber {
    pub fn next(&self) -> Result<Option<Arc<Item>>, Overflow> {
        let mut backlog = lock(&self.queue.state);
        if backlog.overflowed {
            return Err(Overflow {
                capacity: self.queue.capacity,
            });
        }
        Ok(backlog.items.pop_front())
    }
}

impl Drop for Subscriber {
    fn drop(&mut self) {
        if let Some(feed) = self.feed.upgrade() {
            lock(&feed.state)
                .entries
                .retain(|entry| entry.id != self.id);
        }
    }
}

fn matches(scope: &Scope, item: &Item) -> bool {
    match (scope, &item.payload) {
        (Scope::Global, _) => true,
        (Scope::Session(id), Payload::Durable(event)) => id.as_lossless() == &event.aggregate_id,
        (Scope::Session(id), Payload::Ephemeral(event)) => event.session.as_ref() == Some(id),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
