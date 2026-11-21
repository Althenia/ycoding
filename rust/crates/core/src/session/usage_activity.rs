use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use ycoding_schema::{session_id::SessionId, usage_anchor};
use ycoding_store::{Client, WeakClient};

type Entry = (SessionId, Option<usage_anchor::Ref>);

#[derive(Clone, Copy)]
enum Kind {
    Request,
    Contributor,
}

#[derive(Default)]
struct Active {
    requests: Vec<Entry>,
    contributors: Vec<Entry>,
}

type State = Mutex<Active>;

struct Backend {
    client: WeakClient,
    state: Weak<State>,
}

static BACKENDS: Mutex<Vec<Backend>> = Mutex::new(Vec::new());

pub struct Contribution {
    state: Arc<State>,
    kind: Kind,
    entry: Entry,
}

#[derive(Debug, Default)]
pub(crate) struct Snapshot {
    pub requests: Vec<Entry>,
    pub contributors: Vec<Entry>,
}

pub fn contribute(
    client: &Client,
    session: SessionId,
    anchor: Option<usage_anchor::Ref>,
) -> Contribution {
    register(client, Kind::Contributor, (session, anchor))
}

pub(crate) fn request(
    client: &Client,
    session: SessionId,
    anchor: Option<usage_anchor::Ref>,
) -> Contribution {
    register(client, Kind::Request, (session, anchor))
}

pub(crate) fn snapshot(client: &Client) -> Snapshot {
    let state = locked(&BACKENDS)
        .iter()
        .find(|backend| backend.client.refers_to(client))
        .and_then(|backend| backend.state.upgrade());
    state.map_or_else(Snapshot::default, |state| {
        let active = locked(&state);
        Snapshot {
            requests: active.requests.clone(),
            contributors: active.contributors.clone(),
        }
    })
}

fn register(client: &Client, kind: Kind, entry: Entry) -> Contribution {
    let state = state_for(client);
    let mut active = locked(&state);
    match kind {
        Kind::Request => active.requests.push(entry.clone()),
        Kind::Contributor => active.contributors.push(entry.clone()),
    }
    drop(active);
    Contribution { state, kind, entry }
}

fn state_for(client: &Client) -> Arc<State> {
    let mut backends = locked(&BACKENDS);
    backends.retain(|backend| backend.state.strong_count() > 0);
    if let Some(state) = backends
        .iter()
        .find(|backend| backend.client.refers_to(client))
        .and_then(|backend| backend.state.upgrade())
    {
        return state;
    }
    backends.retain(|backend| !backend.client.refers_to(client));
    let state = Arc::new(State::default());
    backends.push(Backend {
        client: client.downgrade(),
        state: Arc::downgrade(&state),
    });
    state
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Drop for Contribution {
    fn drop(&mut self) {
        let mut active = locked(&self.state);
        let entries = match self.kind {
            Kind::Request => &mut active.requests,
            Kind::Contributor => &mut active.contributors,
        };
        if let Some(index) = entries.iter().position(|entry| *entry == self.entry) {
            entries.remove(index);
        }
    }
}
