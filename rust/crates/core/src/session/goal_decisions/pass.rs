use super::{
    GoalDecisions, Kind, Outcome, Requirement,
    candidate::{Answer, Candidate, Fence, Subject},
    readable,
    receipt::Record,
};
use crate::{
    coordination::{decisions::Source, runtime::DecisionOutcome},
    session::{
        autonomy::{DecisionMode, Effective},
        prompt_cache::sha256,
    },
    tools::policy::wildcard,
};
use std::{collections::BTreeSet, sync::Arc};
use ycoding_schema::{LosslessString, coordination as c, session};

const INPUTS_CHANGED: [&str; 2] = ["delegation-invalid", "stale-assessment"];

impl GoalDecisions {
    pub(super) async fn pass(&self, owner: &session::Id) -> bool {
        let Some(requirement) = self.capture(owner) else {
            self.attempts_mut(|attempts| {
                attempts.remove(owner);
            });
            return false;
        };
        let family = match self.subtree(owner, true) {
            Ok(family) => family,
            Err(error) => {
                tracing::warn!(error = %error, "Goal decision pass failed");
                return false;
            }
        };
        let candidates = self.collect(&family).await;
        let mut repeat = false;
        for candidate in &candidates {
            repeat |= self.handle_candidate(owner, &requirement, candidate).await;
        }
        let live = candidates.iter().map(attempt_id).collect::<BTreeSet<_>>();
        self.attempts_mut(|attempts| {
            if let Some(known) = attempts.get_mut(owner) {
                known.retain(|id, _| live.contains(id));
            }
        });
        repeat
    }

    fn attempts_mut<T>(
        &self,
        update: impl FnOnce(
            &mut std::collections::BTreeMap<
                session::Id,
                std::collections::BTreeMap<String, BTreeSet<String>>,
            >,
        ) -> T,
    ) -> T {
        update(
            &mut self
                .0
                .attempts
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }

    fn known(&self, owner: &session::Id, id: &str, key: &str, change: Change) -> (bool, usize) {
        self.attempts_mut(|attempts| {
            let known = attempts
                .entry(owner.clone())
                .or_default()
                .entry(id.to_owned())
                .or_default();
            let had = known.contains(key);
            let size = known.len();
            match change {
                Change::Read => {}
                Change::Insert => {
                    known.insert(key.to_owned());
                }
                Change::Remove => {
                    known.remove(key);
                }
            }
            (had, size)
        })
    }

    async fn delegation(
        &self,
        kind: c::RequestKind,
        action: &str,
        resources: &[LosslessString],
    ) -> Option<&'static str> {
        let Ok(settings) = (self.0.settings)().await else {
            return Some("delegation-unavailable");
        };
        if !settings.enabled {
            return Some("delegation-revoked");
        }
        if settings
            .expires_at
            .as_ref()
            .is_some_and(|at| at.get() <= self.now())
        {
            return Some("delegation-expired");
        }
        let action = LosslessString::from(action);
        let covered = settings.categories.contains(&kind)
            && settings
                .actions
                .as_ref()
                .is_none_or(|actions| actions.iter().any(|pattern| wildcard(&action, pattern)))
            && settings.resources.as_ref().is_none_or(|patterns| {
                resources
                    .iter()
                    .all(|resource| patterns.iter().any(|pattern| wildcard(resource, pattern)))
            });
        (!covered).then_some("delegation-out-of-scope")
    }

    pub(super) async fn blocker(&self, session: &session::Id, subject: &Subject) -> Option<String> {
        let (request_kind, action, resources) = match subject {
            Subject::Request {
                kind,
                action,
                resources,
                ..
            } => (*kind, action.as_str(), resources.as_slice()),
            Subject::Form { .. } => (c::RequestKind::Question, "question", &[][..]),
        };
        if self.0.autonomy.effective(session).is_err() {
            return Some("autonomy-unavailable".into());
        }
        self.delegation(request_kind, action, resources)
            .await
            .map(str::to_owned)
    }

    pub(super) fn fenced(&self, fence: &Fence) -> bool {
        if !self.owner_current(&fence.owner, &fence.requirement) {
            return false;
        }
        let Ok(Some(member)) = self.row(&fence.session) else {
            return false;
        };
        if member.archived || self.owner_of(&fence.session).as_ref() != Some(&fence.owner) {
            return false;
        }
        if self
            .0
            .autonomy
            .snapshot_inherited(&fence.session)
            .ok()
            .as_ref()
            != Some(&fence.authority)
        {
            return false;
        }
        self.0
            .autonomy
            .effective(&fence.session)
            .is_ok_and(|effective| fence.kind != Kind::Guardrail || !effective.deferred)
    }

    pub(super) async fn valid(
        &self,
        fence: &Fence,
        session: &LosslessString,
        subject: &Subject,
    ) -> bool {
        session == fence.session.as_lossless()
            && self.fenced(fence)
            && self.blocker(&fence.session, subject).await.is_none()
    }

    async fn waiting(
        &self,
        owner: &session::Id,
        requirement: &Requirement,
        candidate: &Candidate,
        discriminator: &str,
        reason: &str,
        rationale: &str,
    ) {
        self.record(Record {
            owner,
            requirement,
            reference: &candidate.reference,
            outcome: Outcome::Waiting,
            discriminator,
            rationale,
            via: None,
            reason: Some(reason),
        })
        .await;
    }

    async fn settle(
        &self,
        owner: &session::Id,
        requirement: &Requirement,
        candidate: &Candidate,
    ) -> bool {
        let reference = &candidate.reference;
        let rationale = if candidate.answers_question() {
            format!(
                "The Goal agent settled a {} request from bounded task context; an automatic answer is never a human reply.",
                reference.kind.as_str()
            )
        } else {
            format!(
                "The goal loop processes a {} request under the active goal with {} deny rules and permission ceilings.",
                reference.kind.as_str(),
                reference.kind.category()
            )
        };
        let Ok(authority) = self.0.autonomy.snapshot_inherited(&reference.session) else {
            return false;
        };
        let context = match self.0.proof.authority_digest(&reference.session).await {
            Ok(context) => context,
            Err(error) => {
                tracing::warn!(error = %error, "Goal decision authority proof unavailable");
                let discriminator = format!(
                    "authority-unavailable:{}:{}",
                    authority.sequence, authority.digest
                );
                self.waiting(
                    owner,
                    requirement,
                    candidate,
                    &discriminator,
                    "authority-unavailable",
                    &rationale,
                )
                .await;
                return false;
            }
        };
        let key = sha256(
            &[
                reference.kind.as_str().to_owned(),
                readable(&reference.request),
                readable(&reference.fingerprint),
                authority.sequence.to_string(),
                authority.digest.clone(),
                context,
            ]
            .join("\0"),
        );
        let id = attempt_id(candidate);
        if self.known(owner, &id, &key, Change::Read).0 {
            return false;
        }
        for outcome in [Outcome::Waiting, Outcome::Settled] {
            let Some(receipt) = self.receipt_id(owner, reference, outcome, &key) else {
                return false;
            };
            match self.receipt_exists(owner, &receipt) {
                Ok(false) => {}
                Ok(true) => {
                    self.known(owner, &id, &key, Change::Insert);
                    return false;
                }
                Err(error) => {
                    tracing::warn!(error = %error, "Goal decision receipt lookup failed");
                    return false;
                }
            }
        }
        let Ok(effective) = self.0.autonomy.effective(&reference.session) else {
            return false;
        };
        let mode = mode_of(&effective, reference.kind);
        let (_, attempted) = self.known(owner, &id, &key, Change::Insert);
        if candidate.assessed_by_yolo && mode == DecisionMode::Yolo && attempted == 0 {
            self.waiting(
                owner,
                requirement,
                candidate,
                &key,
                "yolo-assessed",
                "The native YOLO evaluator already assessed this request under the current authority; the goal loop did not run it again.",
            )
            .await;
            return false;
        }
        let fence = Arc::new(Fence {
            owner: owner.clone(),
            requirement: requirement.clone(),
            session: reference.session.clone(),
            kind: reference.kind,
            authority,
        });
        let source = Source {
            coordinator_session_id: owner.clone(),
            group_id: None,
            rationale: LosslessString::from(rationale.as_str()),
        };
        let answer = if !candidate.has_deterministic_answer() {
            match self.goal_answer(owner, candidate).await {
                Ok(answer) => Some(answer),
                Err(reason) => {
                    self.waiting(owner, requirement, candidate, &key, &reason, &rationale)
                        .await;
                    return INPUTS_CHANGED.contains(&reason.as_str())
                        && self.capture(owner).is_some();
                }
            }
        } else {
            None
        };
        let result = match self.reconsider(candidate, source, fence, answer).await {
            Ok(result) => result,
            Err(error) => {
                self.waiting(
                    owner,
                    requirement,
                    candidate,
                    &key,
                    "reconsider-failed",
                    &rationale,
                )
                .await;
                tracing::warn!(error = %error, "Goal decision reconsideration failed");
                return false;
            }
        };
        if matches!(result.outcome, DecisionOutcome::Stale) {
            return false;
        }
        if result.settled {
            let outcome = match result.outcome {
                DecisionOutcome::Allowed => "allowed",
                DecisionOutcome::Denied => "denied",
                DecisionOutcome::Escalated => "escalated",
                DecisionOutcome::Stale => "stale",
            };
            self.record(Record {
                owner,
                requirement,
                reference,
                outcome: Outcome::Settled,
                discriminator: &key,
                rationale: &rationale,
                via: result.via,
                reason: Some(outcome),
            })
            .await;
            return false;
        }
        let reason = result.reason.as_ref().map(readable);
        if reason.as_deref() == Some("native-assessment-in-progress") {
            self.known(owner, &id, &key, Change::Remove);
            return false;
        }
        if reason
            .as_deref()
            .is_some_and(|reason| INPUTS_CHANGED.contains(&reason))
        {
            if self.capture(owner).is_some() {
                self.waiting(
                    owner,
                    requirement,
                    candidate,
                    &key,
                    reason.as_deref().unwrap_or("escalated"),
                    &rationale,
                )
                .await;
            }
            return true;
        }
        self.waiting(
            owner,
            requirement,
            candidate,
            &key,
            reason.as_deref().unwrap_or("escalated"),
            &rationale,
        )
        .await;
        false
    }

    async fn goal_answer(
        &self,
        owner: &session::Id,
        candidate: &Candidate,
    ) -> Result<Answer, String> {
        let goal = self
            .0
            .autonomy
            .snapshot(owner)
            .ok()
            .and_then(|snapshot| snapshot.state.goal)
            .filter(|goal| goal.is_active())
            .ok_or_else(|| "refused".to_owned())?;
        let prompt = candidate.goal_prompt(&readable(&goal.text));
        let text = self.0.synthesize.synthesize(owner, prompt).await?;
        candidate
            .goal_answer(&text)
            .ok_or_else(|| "refused".to_owned())
    }

    async fn handle_candidate(
        &self,
        owner: &session::Id,
        requirement: &Requirement,
        candidate: &Candidate,
    ) -> bool {
        if let Some(reason) = self
            .blocker(&candidate.reference.session, &candidate.subject)
            .await
        {
            self.waiting(
                owner,
                requirement,
                candidate,
                &reason,
                &reason,
                "The goal delegation or autonomy state does not cover this request; the goal loop did not settle it.",
            )
            .await;
            return false;
        }
        self.settle(owner, requirement, candidate).await
    }
}

fn mode_of(effective: &Effective, kind: Kind) -> DecisionMode {
    match kind {
        Kind::Permission => effective.permissions,
        Kind::Guardrail => effective.guardrails,
        _ => effective.answers,
    }
}

enum Change {
    Read,
    Insert,
    Remove,
}

fn attempt_id(candidate: &Candidate) -> String {
    let reference = &candidate.reference;
    [
        reference.kind.as_str().to_owned(),
        readable(reference.session.as_lossless()),
        readable(&reference.request),
        readable(&reference.fingerprint),
    ]
    .join("\0")
}
