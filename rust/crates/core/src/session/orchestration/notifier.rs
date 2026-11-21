use super::{
    identity::{Launch, notification_name},
    service::{Error, Service, launch_ids, now, restart_lost_id, synthetic},
};
use crate::session::{key, review_fold};
use std::collections::BTreeSet;
use ycoding_schema::{
    JsonValue, LosslessString, ObjectEncoder, session, session_message,
    session_orchestration::{Change, NotificationType},
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart,
    session::{EventTable, Notification, NotificationTable, TaskTable},
    tuple_key,
};

const BATCH: usize = 100;

enum Delivery {
    Admitted,
    Retry,
    Quarantined,
}

pub struct Notice {
    pub id: session_message::Id,
    pub session_id: session::Id,
    pub text: String,
    pub description: String,
    pub metadata: JsonValue,
    pub resume: bool,
}

impl Service {
    pub async fn dispatch_notifications(&self) -> Result<usize, Error> {
        let _outbox = self.lock(&"outbox".into()).await;
        self.drain_outbox(None).await
    }

    pub async fn dispatch_restart_losses(&self, parent_id: &session::Id) -> Result<usize, Error> {
        let _outbox = self.lock(&"outbox".into()).await;
        self.drain_outbox(Some(parent_id)).await
    }

    pub fn lost_sessions(&self) -> Result<BTreeSet<LosslessString>, ycoding_store::Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let prefix = tuple_key(&[KeyPart::I64(0)]);
        let mut after = None;
        let mut lost = BTreeSet::new();
        loop {
            let page = snapshot.index_range::<NotificationTable>(
                "session_task_notification_delivery_idx",
                IndexQuery {
                    lower: std::ops::Bound::Unbounded,
                    upper: std::ops::Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: BATCH,
                },
            )?;
            let Some(last) = page.last() else {
                return Ok(lost);
            };
            after = Some(last.cursor.clone());
            for entry in page {
                let restart_lost =
                    restart_lost_id(&entry.record.task_session_id, entry.record.revision);
                if snapshot.get::<EventTable>(&key(&restart_lost))?.is_some() {
                    lost.insert(entry.record.parent_id);
                }
            }
        }
    }

    async fn drain_outbox(&self, restart_parent: Option<&session::Id>) -> Result<usize, Error> {
        let mut delivered = 0;
        loop {
            let rows = self.undelivered(restart_parent)?;
            let mut finalized = 0;
            for row in &rows {
                match self.deliver(row, restart_parent.is_none()).await? {
                    Delivery::Retry => continue,
                    Delivery::Admitted | Delivery::Quarantined => {
                        self.mark_delivered(&row.id).await?;
                        finalized += 1;
                    }
                }
            }
            delivered += finalized;
            if rows.len() < BATCH || finalized == 0 {
                return Ok(delivered);
            }
        }
    }

    fn undelivered(
        &self,
        restart_parent: Option<&session::Id>,
    ) -> Result<Vec<Notification>, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let prefix = tuple_key(&[KeyPart::I64(0)]);
        let mut after = None;
        let mut rows = Vec::new();
        loop {
            let page = snapshot.index_range::<NotificationTable>(
                "session_task_notification_delivery_idx",
                IndexQuery {
                    lower: std::ops::Bound::Unbounded,
                    upper: std::ops::Bound::Unbounded,
                    prefix: Some(&prefix),
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: BATCH,
                },
            )?;
            if page.is_empty() {
                return Ok(rows);
            }
            after = page.last().map(|entry| entry.cursor.clone());
            for entry in page {
                let lost = snapshot
                    .get::<EventTable>(&key(&restart_lost_id(
                        &entry.record.task_session_id,
                        entry.record.revision,
                    )))?
                    .is_some();
                let selected = match restart_parent {
                    None => !lost,
                    Some(parent) => lost && entry.record.parent_id == *parent.as_lossless(),
                };
                if selected {
                    rows.push(entry.record);
                }
                if rows.len() == BATCH {
                    return Ok(rows);
                }
            }
        }
    }

    async fn deliver(&self, row: &Notification, wake: bool) -> Result<Delivery, Error> {
        let snapshot = self.sessions.client.snapshot()?;
        let Some(task) = snapshot.get::<TaskTable>(&key(&row.task_session_id))? else {
            return Ok(Delivery::Retry);
        };
        let parent_id = super::service::session_id(&task.parent_id)?;
        if self.sessions.get(&parent_id)?.is_none() {
            return Ok(Delivery::Retry);
        }
        let kind = notification_type(row)?;
        let ids: Launch = launch_ids(&task)?;
        let data = ObjectEncoder::new()
            .field("source", "subagent_notification")
            .field("childID", &row.task_session_id)
            .field("type", notification_name(&kind))
            .field("revision", &(row.revision as f64))
            .optional("excerpt", &row.excerpt)
            .finish();
        let input = synthetic(
            format!(
                "Subagent notification:\n{}",
                ycoding_schema::stringify_json(&data)
            ),
            "Subagent notification",
            data,
            "steer",
        )?;
        let message_id = ids.notification(row.revision, &kind);
        let _guard = self.lock(parent_id.as_lossless()).await;
        let admitted = self.admit(&parent_id, &message_id, input, None).await;
        let held = match admitted {
            Ok(woken) => !woken,
            Err(Error::Conflict(_)) => return Ok(Delivery::Quarantined),
            Err(error) => return Err(error),
        };
        if wake && !held && kind != NotificationType::Handback {
            match self.resume_for_notice(&parent_id, &message_id).await {
                Ok(()) => {}
                Err(Error::Execution(crate::session::run_coordinator::Error::Closed)) => {
                    return Ok(Delivery::Retry);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(Delivery::Admitted)
    }

    pub async fn notice(&self, notice: Notice) -> Result<(), Error> {
        let input = synthetic(notice.text, &notice.description, notice.metadata, "steer")?;
        let _guard = self.lock(notice.session_id.as_lossless()).await;
        self.admit(&notice.session_id, &notice.id, input, None)
            .await?;
        if notice.resume {
            self.resume_for_notice(&notice.session_id, &notice.id)
                .await?;
        }
        Ok(())
    }

    async fn resume_for_notice(
        &self,
        parent_id: &session::Id,
        message_id: &ycoding_schema::session_message::Id,
    ) -> Result<(), Error> {
        let state = |snapshot: &ycoding_store::Snapshot| -> Result<Option<String>, Error> {
            Ok(snapshot
                .get::<TaskTable>(&key(parent_id.as_lossless()))?
                .map(|row| row.state.as_str().unwrap_or_default().to_owned()))
        };
        let initial = state(&self.sessions.client.snapshot()?)?;
        if initial
            .as_deref()
            .is_some_and(|state| !["running", "supervising", "completed"].contains(&state))
        {
            return Ok(());
        }
        if self.sessions.pending(message_id)?.is_none()
            || self
                .sessions
                .get(parent_id)?
                .is_some_and(|info| info.revert.is_some())
        {
            return Ok(());
        }
        let settled = |state: &Option<String>| {
            state
                .as_deref()
                .is_some_and(|state| ["completed", "supervising"].contains(&state))
        };
        if !settled(&initial) {
            self.execution.wake(parent_id).map_err(Error::Execution)?;
            if initial.is_none() {
                return Ok(());
            }
            if !settled(&state(&self.sessions.client.snapshot()?)?)
                || self.sessions.pending(message_id)?.is_none()
            {
                return Ok(());
            }
        }
        if review_fold::fold(
            &self.sessions.client.snapshot()?,
            &[parent_id.as_lossless().clone()],
        )?
        .iter()
        .any(|item| item.is_open())
        {
            return Ok(());
        }
        self.publish(parent_id, Change::Started, None).await?;
        self.execution.wake(parent_id).map_err(Error::Execution)?;
        Ok(())
    }

    async fn mark_delivered(&self, id: &LosslessString) -> Result<(), Error> {
        let id = id.clone();
        let time = now();
        self.sessions
            .client
            .submit(move |tx| {
                if let Some(mut row) = tx.get::<NotificationTable>(&key(&id))?
                    && row.delivered == 0
                {
                    row.delivered = 1;
                    row.time_delivered = Some(time);
                    NotificationTable::put(tx, &row)?;
                }
                Ok(())
            })?
            .await?;
        Ok(())
    }
}

fn notification_type(row: &Notification) -> Result<NotificationType, Error> {
    match row.type_.as_str() {
        Some("question") => Ok(NotificationType::Question),
        Some("completed") => Ok(NotificationType::Completed),
        Some("failed") => Ok(NotificationType::Failed),
        Some("cancelled") => Ok(NotificationType::Cancelled),
        Some("lost") => Ok(NotificationType::Lost),
        Some("resumed") => Ok(NotificationType::Resumed),
        Some("progress") => Ok(NotificationType::Progress),
        Some("handback") => Ok(NotificationType::Handback),
        _ => Err(Error::Store(ycoding_store::Error::Rejected(
            "Unknown task notification type",
        ))),
    }
}
