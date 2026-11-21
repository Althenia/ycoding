use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::{OwnedMutexGuard, watch};
use ycoding_schema::{LosslessString, session};

struct Entry {
    lock: Arc<tokio::sync::Mutex<()>>,
    selections: watch::Sender<usize>,
}

#[derive(Default)]
pub struct Boundary {
    entries: Mutex<BTreeMap<LosslessString, Arc<Entry>>>,
}

pub struct Selection {
    entry: Arc<Entry>,
}

impl Drop for Selection {
    fn drop(&mut self) {
        self.entry
            .selections
            .send_modify(|users| *users = users.saturating_sub(1));
    }
}

impl Boundary {
    fn entry(&self, id: &session::Id) -> Arc<Entry> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(id.as_lossless().clone())
            .or_insert_with(|| {
                Arc::new(Entry {
                    lock: Arc::new(tokio::sync::Mutex::new(())),
                    selections: watch::channel(0).0,
                })
            })
            .clone()
    }

    pub async fn step_guard(&self, id: &session::Id) -> OwnedMutexGuard<()> {
        let entry = self.entry(id);
        let mut selections = entry.selections.subscribe();
        loop {
            while *selections.borrow_and_update() > 0 {
                if selections.changed().await.is_err() {
                    break;
                }
            }
            let guard = entry.lock.clone().lock_owned().await;
            if *entry.selections.borrow() == 0 {
                return guard;
            }
            drop(guard);
        }
    }

    pub fn selection(&self, id: &session::Id) -> Selection {
        let entry = self.entry(id);
        entry.selections.send_modify(|users| *users += 1);
        Selection { entry }
    }

    pub async fn boundary_guard(&self, id: &session::Id) -> OwnedMutexGuard<()> {
        self.entry(id).lock.clone().lock_owned().await
    }
}

type Boundaries = BTreeMap<usize, Weak<Boundary>>;

pub fn for_client(client: &ycoding_store::Client) -> Arc<Boundary> {
    static STATES: OnceLock<Mutex<Boundaries>> = OnceLock::new();
    let mut states = STATES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    states.retain(|_, state| state.strong_count() > 0);
    let key = std::ptr::from_ref(client.metadata()).addr();
    if let Some(state) = states.get(&key).and_then(Weak::upgrade) {
        return state;
    }
    let state = Arc::new(Boundary::default());
    states.insert(key, Arc::downgrade(&state));
    let retained = state.clone();
    client.observe_events(move |_| {
        let _ = &retained;
        true
    });
    state
}
