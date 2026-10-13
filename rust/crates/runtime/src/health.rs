use crate::dispatch::{Failure, Invocation};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Notify;
use ycoding_protocol::v5;

static CONTROL: Mutex<Option<Weak<Control>>> = Mutex::new(None);

pub(crate) struct Control {
    managed: bool,
    identity: String,
    stop: Arc<Notify>,
    pending: Mutex<BTreeSet<(String, String)>>,
}

impl Control {
    pub(crate) fn install(
        managed: bool,
        identity: &crate::Identity,
        stop: Arc<Notify>,
    ) -> std::io::Result<Arc<Self>> {
        let mut current = CONTROL
            .lock()
            .map_err(|_| std::io::Error::other("service control lock poisoned"))?;
        if current.as_ref().and_then(Weak::upgrade).is_some() {
            return Err(std::io::Error::other("service control already installed"));
        }
        let control = Arc::new(Self {
            managed,
            identity: identity.source_epoch.clone(),
            stop,
            pending: Mutex::new(BTreeSet::new()),
        });
        *current = Some(Arc::downgrade(&control));
        Ok(control)
    }
}

pub(crate) fn request_stop(identity: &str, target: &str) -> bool {
    let Some(control) = control(identity).filter(|control| control.managed && identity == target)
    else {
        return false;
    };
    control.stop.notify_one();
    true
}

fn control(identity: &str) -> Option<Arc<Control>> {
    CONTROL
        .lock()
        .ok()
        .and_then(|current| current.as_ref().and_then(Weak::upgrade))
        .filter(|control| control.identity == identity)
}

pub(crate) struct ConnectionStop {
    control: Option<Arc<Control>>,
    connection: String,
}

impl ConnectionStop {
    pub(crate) fn new(identity: &str, connection: &str) -> Self {
        Self {
            control: control(identity),
            connection: connection.into(),
        }
    }

    pub(crate) fn pending(&self) -> bool {
        self.control.as_ref().is_some_and(|control| {
            control
                .pending
                .lock()
                .is_ok_and(|pending| !pending.is_empty())
        })
    }

    pub(crate) fn sent(&self, request: &str) {
        if let Some(control) = &self.control {
            let accepted = control.pending.lock().is_ok_and(|mut pending| {
                pending.remove(&(self.connection.clone(), request.into()))
            });
            if accepted {
                control.stop.notify_one();
            }
        }
    }
}

impl Drop for ConnectionStop {
    fn drop(&mut self) {
        if let Some(control) = &self.control {
            let accepted = control.pending.lock().is_ok_and(|mut pending| {
                let before = pending.len();
                pending.retain(|(connection, _)| connection != &self.connection);
                before != pending.len()
            });
            if accepted {
                control.stop.notify_one();
            }
        }
    }
}

pub async fn stop(
    invocation: Invocation,
    request: v5::HealthStopRequest,
) -> Result<v5::HealthStopResult, Failure> {
    let identity = &invocation.environment.services.identity.source_epoch;
    let target = crate::convert::domain(&request.payload.instance_id)?;
    let accepted = control(identity)
        .filter(|control| control.managed && target.as_str() == Some(identity.as_str()))
        .is_some_and(|control| {
            control.pending.lock().is_ok_and(|mut pending| {
                pending.insert((
                    invocation.connection_id.clone(),
                    invocation.request_id.clone(),
                ));
                true
            })
        });
    Ok(v5::HealthStopResult {
        data: v5::ServiceStopResponse { accepted },
    })
}

#[cfg(test)]
mod tests {
    use super::{ConnectionStop, Control, request_stop};
    use futures_util::FutureExt;
    use std::sync::Arc;
    use tokio::sync::Notify;

    #[tokio::test]
    async fn exact_managed_identity_and_deferred_wire_settlement() {
        let identity = crate::Identity {
            version: "test".into(),
            pid: 1,
            source_epoch: "owner".into(),
        };
        let notify = Arc::new(Notify::new());
        let unmanaged = Control::install(false, &identity, notify.clone()).unwrap();
        assert!(!request_stop("owner", "owner"));
        drop(unmanaged);
        let managed = Control::install(true, &identity, notify.clone()).unwrap();
        assert!(!request_stop("owner", "stale"));
        assert!(!request_stop("foreign", "foreign"));
        assert!(notify.notified().now_or_never().is_none());
        let connection = ConnectionStop::new("owner", "connection");
        managed
            .pending
            .lock()
            .unwrap()
            .insert(("connection".into(), "request".into()));
        connection.sent("wrong");
        assert!(notify.notified().now_or_never().is_none());
        connection.sent("request");
        assert!(notify.notified().now_or_never().is_some());
        managed
            .pending
            .lock()
            .unwrap()
            .insert(("connection".into(), "disconnected".into()));
        drop(connection);
        assert!(notify.notified().now_or_never().is_some());
        assert!(request_stop("owner", "owner"));
        assert!(notify.notified().now_or_never().is_some());
    }
}
