use super::service::{Error, Service, TERMINAL, session_id, state_of};
use std::ops::Bound;
use ycoding_schema::{session, session_orchestration::Change};
use ycoding_store::session::TaskTable;

const IN_FLIGHT: &str =
    "The child process ended during an in-flight model attempt. The attempt was not replayed.";
const NO_PENDING: &str =
    "The child process ended without durable pending work. Provider execution was not replayed.";

impl Service {
    pub async fn recover(&self) -> Result<usize, Error> {
        let mut rows = self.sessions.client.snapshot()?.scan::<TaskTable>(
            Bound::Unbounded,
            Bound::Unbounded,
            usize::MAX,
        )?;
        rows.sort_by(|left, right| {
            (left.time_created, &left.session_id).cmp(&(right.time_created, &right.session_id))
        });
        let mut acted = 0;
        for row in rows {
            let child_id = session_id(&row.session_id)?;
            let _guard = self.lock(&row.session_id).await;
            let Some(latest) = self.task(&child_id)? else {
                continue;
            };
            if self
                .recover_task(&child_id, &state_of(&latest), latest.attempt_started != 0)
                .await?
            {
                acted += 1;
            }
        }
        Ok(acted)
    }

    async fn recover_task(
        &self,
        child_id: &session::Id,
        state: &str,
        attempt_started: bool,
    ) -> Result<bool, Error> {
        if state == "cancelling" {
            self.publish(child_id, Change::Cancelled, None).await?;
            return Ok(true);
        }
        if state == "running" && attempt_started {
            self.publish(
                child_id,
                Change::Lost {
                    excerpt: Some(IN_FLIGHT.into()),
                },
                None,
            )
            .await?;
            return Ok(true);
        }
        let terminal = TERMINAL.contains(&state);
        if !terminal && state != "starting" && state != "running" {
            return Ok(false);
        }
        let pending = !self.sessions.pending_list(child_id)?.is_empty();
        if terminal && !pending {
            return Ok(false);
        }
        if state == "starting" || terminal {
            self.publish(child_id, Change::Started, None).await?;
        }
        if !pending {
            self.publish(
                child_id,
                Change::Lost {
                    excerpt: Some(NO_PENDING.into()),
                },
                None,
            )
            .await?;
            return Ok(true);
        }
        self.execution.wake(child_id)?;
        Ok(true)
    }
}
