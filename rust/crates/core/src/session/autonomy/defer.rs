use super::{Error, Service, State};
use crate::{
    platform::keep_awake,
    session::{family, key, pending, projector, store},
};
use std::{
    collections::BTreeMap,
    future::Future,
    ops::Bound,
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::OwnedMutexGuard;
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder, session, stringify_json, usage_anchor,
};
use ycoding_store::{
    Client, Snapshot, TableSpec,
    session::{NewEvent, SessionTable},
};

const DEFERRED: &str = "Defer is on. Unresolved requests go to the review box without waiting for user input. Continue independent work under the current autonomy modes; do not guess outcomes or retry deferred actions. A keep-awake hold is requested for this Session family; on battery it drains the battery and a closed lid traps heat.";
const INTERACTIVE: &str = "Defer is off. Unresolved requests return to the decision surface under the current autonomy modes. Existing review items retain their current settlement paths.";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Origin {
    User,
    Subagent,
    Plugin,
    Review,
    Runtime,
}

type Locks = BTreeMap<(&'static str, LosslessString), Weak<tokio::sync::Mutex<()>>>;

struct Shared {
    locks: Mutex<Locks>,
    awake: Mutex<Option<keep_awake::Service>>,
}

impl Shared {
    async fn lock(&self, kind: &'static str, id: &LosslessString) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().unwrap_or_else(|error| error.into_inner());
            locks.retain(|_, lock| lock.strong_count() > 0);
            let key = (kind, id.clone());
            match locks.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(tokio::sync::Mutex::new(()));
                    locks.insert(key, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }

    fn awake(&self) -> Option<keep_awake::Service> {
        self.awake
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

fn shared(client: &Client) -> Arc<Shared> {
    static REGISTRY: OnceLock<Mutex<BTreeMap<usize, Weak<Shared>>>> = OnceLock::new();
    let mut registry = REGISTRY
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    registry.retain(|_, shared| shared.strong_count() > 0);
    let identity = std::ptr::from_ref(client.metadata()).addr();
    if let Some(shared) = registry.get(&identity).and_then(Weak::upgrade) {
        return shared;
    }
    let shared = Arc::new(Shared {
        locks: Mutex::default(),
        awake: Mutex::default(),
    });
    registry.insert(identity, Arc::downgrade(&shared));
    let retained = shared.clone();
    client.observe_events(move |_| {
        let _ = &retained;
        true
    });
    shared
}

pub(crate) async fn inbox(client: &Client, id: &session::Id) -> OwnedMutexGuard<()> {
    shared(client).lock("inbox", id.as_lossless()).await
}

pub(crate) async fn release_removed(client: &Client, removed: &[LosslessString]) {
    if let Some(awake) = shared(client).awake() {
        for id in removed {
            awake.release(&hold_key(id)).await;
        }
    }
}

async fn detached<T: Send + 'static>(
    future: impl Future<Output = Result<T, Error>> + Send + 'static,
) -> Result<T, Error> {
    tokio::spawn(future)
        .await
        .map_err(|_| ycoding_store::Error::Rejected("autonomy task failed"))?
}

impl Service {
    pub fn with_keep_awake(self, awake: keep_awake::Service) -> Self {
        *shared(&self.client)
            .awake
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(awake);
        self
    }

    pub fn root(&self, id: &session::Id) -> Result<session::Id, Error> {
        let snapshot = self.client.snapshot()?;
        let root = family::root(&mut family::Reader::Snapshot(&snapshot), id.as_lossless())?
            .ok_or_else(|| Error::NotFound(id.clone()))?;
        session::Id::new(root)
            .map_err(|error| Error::Store(ycoding_store::Error::Record(Box::new(error))))
    }

    pub async fn set_defer(&self, id: &session::Id, deferred: bool) -> Result<State, Error> {
        let service = self.clone();
        let id = id.clone();
        detached(async move {
            let root = service.root(&id)?;
            let _family = shared(&service.client)
                .lock("family", root.as_lossless())
                .await;
            service.transition(&root, deferred).await?;
            service.get(&id)
        })
        .await
    }

    pub async fn rehydrate(&self) -> Result<(), Error> {
        let Some(awake) = shared(&self.client).awake() else {
            return Ok(());
        };
        let snapshot = self.client.snapshot()?;
        let mut after = None;
        loop {
            let page = snapshot.scan::<SessionTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                128,
            )?;
            let Some(last) = page.last() else {
                return Ok(());
            };
            after = Some(SessionTable::primary_key(last));
            for row in page {
                if row.parent_id.as_ref().is_none_or(LosslessString::is_empty)
                    && State::read(row.autonomy.as_ref()).is_deferred()
                {
                    awake.hold(&hold_key(&row.id)).await;
                }
            }
        }
    }

    pub async fn admit(
        &self,
        sessions: &store::Service,
        request: pending::Request,
        caused_by: Option<usage_anchor::Ref>,
        origin: Origin,
    ) -> Result<pending::Admitted, Error> {
        self.admit_checked(sessions, request, caused_by, origin, None, None)
            .await
    }

    pub(crate) async fn admit_checked(
        &self,
        sessions: &store::Service,
        request: pending::Request,
        caused_by: Option<usage_anchor::Ref>,
        _origin: Origin,
        admission: Option<pending::CheckedAdmission>,
        command_cue: Option<super::super::runner::InputCue>,
    ) -> Result<pending::Admitted, Error> {
        let service = self.clone();
        let sessions = sessions.clone();
        detached(async move {
            let shared = shared(&service.client);
            let _inbox = shared.lock("inbox", request.session_id.as_lossless()).await;
            let session = request.session_id.clone();
            let admitted = sessions
                .admit_input_checked(request, caused_by, admission)
                .await?;
            if admitted.fresh
                && let Ok(message) =
                    ycoding_schema::session_message::Id::new(admitted.pending.id.clone())
            {
                let mut cues = super::super::runner::command_cues()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let key = (
                    session,
                    message,
                    admitted.pending.admitted_seq,
                    admitted.pending.time_created,
                );
                cues.remove(&key);
                if let Some(cue) = command_cue {
                    cues.insert(key, cue);
                }
            }
            Ok(admitted)
        })
        .await
    }

    pub(super) fn family_deferred(&self, id: &session::Id) -> Result<bool, Error> {
        deferred_in(&self.client.snapshot()?, id)
    }

    async fn transition(&self, root: &session::Id, deferred: bool) -> Result<(), Error> {
        let id = root.as_lossless().clone();
        let changed = self
            .client
            .submit(move |tx| {
                let Some(mut row) = tx.get::<SessionTable>(&key(&id))? else {
                    return Err(ycoding_store::Error::Domain {
                        kind: "not_found",
                        message: "Session not found",
                    });
                };
                let Some(after) = State::read(row.autonomy.as_ref()).set_defer(deferred) else {
                    return Ok(false);
                };
                let now = chrono::Utc::now().timestamp_millis();
                row.autonomy = Some(after.encode());
                let members = family::members(&mut family::Reader::Transaction(&mut *tx), &id)?;
                for member in members {
                    let mut changed = if member == id {
                        row.clone()
                    } else {
                        tx.get::<SessionTable>(&key(&member))?
                            .ok_or(ycoding_store::Error::Rejected("family member disappeared"))?
                    };
                    changed.autonomy_revision += 1;
                    changed.time_updated = now;
                    SessionTable::put(tx, &changed)?;
                    projector::append(
                        tx,
                        &NewEvent {
                            id: projector::random_event_id()?.as_lossless().clone(),
                            aggregate_id: member.clone(),
                            created: now,
                            type_: "session.context.observed.1".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &member)
                                .field("source", "session-state")
                                .field("text", if deferred { DEFERRED } else { INTERACTIVE })
                                .finish(),
                        },
                    )?;
                }
                Ok(true)
            })?
            .await?;
        if changed {
            self.notify_tree(root)?;
        }
        if changed && let Some(awake) = shared(&self.client).awake() {
            let key = hold_key(root.as_lossless());
            if deferred {
                awake.hold(&key).await;
            } else {
                awake.release(&key).await;
            }
        }
        Ok(())
    }
}

fn hold_key(id: &LosslessString) -> String {
    stringify_json(&JsonValue::String(id.clone()))
}

pub(super) fn deferred_in(snapshot: &Snapshot, id: &session::Id) -> Result<bool, Error> {
    let root = family::root(&mut family::Reader::Snapshot(snapshot), id.as_lossless())?
        .ok_or_else(|| Error::NotFound(id.clone()))?;
    Ok(snapshot
        .get::<SessionTable>(&key(&root))?
        .is_some_and(|row| State::read(row.autonomy.as_ref()).is_deferred()))
}
