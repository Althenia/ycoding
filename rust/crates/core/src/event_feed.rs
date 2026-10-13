use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak},
};
use ycoding_schema::{JsonObject, LosslessString, location, session};
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
    pub session: Option<session::Id>,
    pub location: Option<location::Ref>,
    pub metadata: Option<JsonObject>,
    pub data: Data,
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

#[derive(Clone, Default)]
pub struct EventSource(Arc<OnceLock<(Feed, Option<location::Ref>)>>);

impl std::fmt::Debug for EventSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EventSource")
            .field("bound", &self.0.get().is_some())
            .finish()
    }
}

impl EventSource {
    pub fn bind(&self, feed: Feed, location: Option<location::Ref>) -> Result<(), String> {
        if let Some((current, current_location)) = self.0.get() {
            if Arc::ptr_eq(&current.0, &feed.0) && *current_location == location {
                return Ok(());
            }
            return Err("Event source already belongs to another feed or Location".into());
        }
        if self.0.set((feed.clone(), location.clone())).is_err() {
            return self.bind(feed, location);
        }
        Ok(())
    }

    pub fn emit(&self, data: Data) -> Result<(), String> {
        let Some((feed, location)) = self.0.get() else {
            return Ok(());
        };
        feed.emit(data, location.clone())
    }
}

struct Shared {
    client: Client,
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
            client: client.clone(),
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
            let feed = Feed(shared);
            feed.publish_all(events.iter().cloned().map(Payload::Durable));
            for event in events.iter().filter(|event| {
                matches!(
                    event.type_.as_str(),
                    Some(
                        "session.step.ended.1"
                            | "session.step.failed.1"
                            | "session.usage.recorded.1"
                    )
                )
            }) {
                if event.type_.as_str() == Some("session.step.failed.1") {
                    let ycoding_schema::JsonValue::Object(data) = &event.data else {
                        continue;
                    };
                    if data.get(&"cost".into()).is_none() || data.get(&"tokens".into()).is_none() {
                        continue;
                    }
                }
                let id = match session::Id::new(event.aggregate_id.clone()) {
                    Ok(id) => id,
                    Err(_) => continue,
                };
                let service = crate::session::store::Service::new(feed.0.client.clone());
                match service.get(&id) {
                    Ok(Some(session)) => {
                        if feed
                            .emit(
                                Data::SessionUsageUpdated(Box::new(ephemeral::Usage {
                                    session_id: id,
                                    cost: session.cost,
                                    tokens: session.tokens,
                                })),
                                Some(session.location),
                            )
                            .is_err()
                        {
                            eprintln!("Session usage publication failed");
                        }
                    }
                    Ok(None) => {}
                    Err(_) => eprintln!("Session usage projection unavailable"),
                }
            }
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

    pub fn emit(&self, data: Data, location: Option<location::Ref>) -> Result<(), String> {
        let session = data.session()?;
        self.publish(Ephemeral {
            id: crate::session::projector::random_event_id()
                .map_err(|error| error.to_string())?
                .as_lossless()
                .clone(),
            created: chrono::Utc::now().timestamp_millis(),
            session,
            location,
            metadata: None,
            data,
        });
        Ok(())
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
pub mod ephemeral;
pub use ephemeral::Data;
