use super::{
    Fallible, GoalDecisions, Outcome,
    receipt::{Record, Reference},
    trigger::Answered,
};
use crate::session::{key, review_fold};
use std::{collections::BTreeMap, ops::Bound};
use ycoding_schema::{LosslessString, session};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart, session::SessionTable, session::TaskTable, tuple_key,
};

const ACTIVE_TASKS: [&str; 5] = [
    "starting",
    "running",
    "waiting",
    "supervising",
    "cancelling",
];

impl GoalDecisions {
    pub(super) async fn resume(&self, owner: &session::Id, answered: &Answered) {
        let Some(requirement) = self.capture(owner) else {
            return;
        };
        let waiting = match self.waiting_for(owner, answered, &requirement.goal_digest) {
            Ok(waiting) => waiting
                .into_iter()
                .map(|reference| (reference.fingerprint.clone(), reference))
                .collect::<BTreeMap<LosslessString, Reference>>(),
            Err(error) => {
                tracing::warn!(error = %error, "Goal decision resume lookup failed");
                return;
            }
        };
        let mut fresh = false;
        for reference in waiting.values() {
            fresh |= self
                .record(Record {
                    owner,
                    requirement: &requirement,
                    reference,
                    outcome: Outcome::Resumed,
                    discriminator: "",
                    rationale: "A native settlement or answer resolved the request this receipt was waiting on.",
                    via: None,
                    reason: None,
                })
                .await;
        }
        if !fresh {
            return;
        }
        match self.resumable(owner).await {
            Ok(true) => {
                if let Err(error) = self.0.execution.wake(owner) {
                    tracing::warn!(error = %error, "Goal decision resume wake failed");
                }
            }
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(error = %error, "Goal decision resume check failed");
            }
        }
    }

    async fn resumable(&self, owner: &session::Id) -> Fallible<bool> {
        if self.0.execution.active().contains(owner) {
            return Ok(false);
        }
        if !self.structurally_idle(owner)? {
            return Ok(false);
        }
        let Some(located) = (self.0.locate)(owner.clone()).await else {
            return Ok(true);
        };
        Ok(located
            .shell_active
            .as_ref()
            .is_none_or(|active| !active(owner)))
    }

    fn structurally_idle(&self, owner: &session::Id) -> Fallible<bool> {
        let snapshot = self.0.client.snapshot()?;
        if snapshot
            .get::<TaskTable>(&key(owner.as_lossless()))?
            .is_some_and(|task| task.state.as_str() != Some("running"))
        {
            return Ok(false);
        }
        for state in ACTIVE_TASKS {
            let state = LosslessString::from(state);
            let prefix = tuple_key(&[
                KeyPart::String(owner.as_lossless()),
                KeyPart::String(&state),
            ]);
            if !snapshot
                .index_range::<TaskTable>(
                    "session_task_parent_state_updated_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: None,
                        limit: 1,
                    },
                )?
                .is_empty()
            {
                return Ok(false);
            }
        }
        if review_fold::fold(&snapshot, &[owner.as_lossless().clone()])?
            .iter()
            .any(review_fold::Folded::is_open)
        {
            return Ok(false);
        }
        Ok(snapshot
            .get::<SessionTable>(&key(owner.as_lossless()))?
            .is_some_and(|session| session.revert.is_none()))
    }
}
