use super::{
    native::definition,
    session_action::{decode, invalid, output, permit},
};
use crate::{
    session::autonomy::{self, GoalStatus, State},
    tools::{
        context::{Context, policy::LeafPolicy},
        registry::{Failure, Tool, ToolFuture},
    },
};
use std::sync::Arc;
use ycoding_ai::llm::ToolDefinition;
use ycoding_schema::{JsonValue, LosslessString, ObjectEncoder};

pub struct Goal {
    pub autonomy: autonomy::Service,
    pub sessions: crate::session::store::Service,
    pub policy: Arc<LeafPolicy>,
}
impl Tool for Goal {
    fn definition(&self, name: &str) -> ToolDefinition {
        definition(name, include_str!("goal.tool.json"))
    }
    fn permission(&self) -> Option<&str> {
        None
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = decode(&input)?;
            let action = input
                .tag(
                    "action",
                    &[
                        "get", "set", "update", "report", "rework", "complete", "stop", "clear",
                    ],
                )
                .map_err(invalid)?;
            let status: Option<LosslessString> = input.optional("status").map_err(invalid)?;
            let unit: Option<LosslessString> = input.optional("unit").map_err(invalid)?;
            let reason: Option<LosslessString> = input.optional("reason").map_err(invalid)?;
            let rework_state: Option<LosslessString> = input.optional("state").map_err(invalid)?;
            let evidence: Option<LosslessString> = input.optional("evidence").map_err(invalid)?;
            for (name, value, max) in [
                ("unit", &unit, 120),
                ("reason", &reason, 300),
                ("evidence", &evidence, 300),
            ] {
                if value.as_ref().is_some_and(|value| {
                    value.code_units().count() > max
                        || !value
                            .code_units()
                            .any(|unit| !crate::process::guardrails::is_whitespace(unit))
                }) {
                    return Err(Failure::message(format!("Invalid tool input: {name}")));
                }
            }
            if rework_state
                .as_ref()
                .is_some_and(|state| !matches!(state.as_str(), Some("opened" | "resolved")))
            {
                return Err(Failure::message("Invalid tool input: state"));
            }
            if status.as_ref().is_some_and(|status| {
                !matches!(status.as_str(), Some("active" | "completed" | "stopped"))
            }) {
                return Err(Failure::message("Invalid tool input: status"));
            }
            let action = action.as_str().unwrap_or_default();
            permit(
                &self.policy,
                &context,
                "goal",
                action,
                true,
                "Unable to manage goal",
            )
            .await?;
            if context.cancellation.is_cancelled() {
                return Err(Failure::Cancelled);
            }
            if action == "set" {
                return Err(Failure::message(
                    "The goal objective is owned by the user. The user must create or replace it through the /goal command or goal dialog; the assistant can manage status with get/update/report/complete/stop.",
                ));
            }
            let before = match self.autonomy.get(&context.session_id) {
                Ok(state) => state,
                Err(autonomy::Error::NotFound(_)) => State::default(),
                Err(error) => return Err(Failure::Defect(error.to_string())),
            };
            let existing = before.goal.as_ref();
            let (returned_action, state, message) = match action {
                "get" => {
                    let message = match existing {
                        None => "No active goal. Goal is off.".to_owned(),
                        Some(goal) if goal.is_active() => format!(
                            "Active goal (iteration {}, noProgress {}/{}): {}",
                            goal.iteration,
                            goal.no_progress,
                            goal.max_no_progress,
                            text(&goal.text)
                        ),
                        Some(goal) => {
                            format!("Goal is {}: {}", goal.status.as_str(), text(&goal.text))
                        }
                    };
                    (action, before, message)
                }
                "report" => {
                    if !existing.is_some_and(autonomy::Goal::is_active) {
                        return Err(Failure::message("No active goal to report"));
                    }
                    let open = self
                        .sessions
                        .client
                        .snapshot()
                        .and_then(|snapshot| {
                            crate::session::review_fold::family_open(
                                &snapshot,
                                context.session_id.as_lossless(),
                            )
                        })
                        .map_err(|error| Failure::Defect(error.to_string()))?
                        .0;
                    if open > 0 {
                        let message = format!(
                            "Not counted: {open} item(s) in this Session family await the user's review."
                        );
                        (action, before, message)
                    } else {
                        let state = self
                            .autonomy
                            .report(&context.session_id)
                            .await
                            .map_err(failure)?;
                        let goal = state
                            .goal
                            .as_ref()
                            .ok_or_else(|| Failure::Defect("Goal report lost goal".into()))?;
                        let message = format!(
                            "Goal no-progress attempt {}/{} reported; status {}.",
                            goal.no_progress,
                            goal.max_no_progress,
                            goal.status.as_str()
                        );
                        (action, state, message)
                    }
                }
                "rework" => {
                    let opened =
                        rework_state.as_ref().and_then(LosslessString::as_str) == Some("opened");
                    if unit.is_none() || rework_state.is_none() || (opened && reason.is_none()) {
                        return Err(Failure::message(
                            "Rework requires unit, state, and a reason when opened",
                        ));
                    }
                    if !opened && evidence.is_none() {
                        return Err(Failure::message(
                            "Resolved rework requires evidence naming the check that now passes",
                        ));
                    }
                    let owner = self
                        .autonomy
                        .goal_owner(&context.session_id)
                        .map_err(failure)?
                        .ok_or_else(|| Failure::message("No active goal to record rework"))?;
                    let unit = text(unit.as_ref().expect("validated unit"));
                    let state = self.autonomy.get(&owner).map_err(failure)?;
                    if !opened
                        && !state
                            .goal
                            .as_ref()
                            .and_then(|goal| goal.rework_open.as_ref())
                            .is_some_and(|open| {
                                open.iter()
                                    .any(|item| item.unit.as_str() == Some(unit.as_str()))
                            })
                    {
                        return Err(Failure::message(format!("No open rework for {unit}")));
                    }
                    let state = self
                        .autonomy
                        .rework(
                            &owner,
                            unit.clone(),
                            reason
                                .as_ref()
                                .or(evidence.as_ref())
                                .map(text)
                                .unwrap_or_default(),
                            opened,
                        )
                        .await
                        .map_err(failure)?;
                    let message = if opened {
                        format!(
                            "Rework opened for {unit}; rework count {}. Fix it, re-run the check, then resolve it with evidence.",
                            state
                                .goal
                                .as_ref()
                                .and_then(|goal| goal.rework)
                                .unwrap_or(0)
                        )
                    } else {
                        format!(
                            "Rework resolved for {unit}: {}",
                            evidence.as_ref().map(text).unwrap_or_default()
                        )
                    };
                    (action, state, message)
                }
                "complete" => {
                    if !existing.is_some_and(autonomy::Goal::is_active) {
                        return Err(Failure::message("No active goal to complete"));
                    }
                    self.require_completable(&context, existing.expect("active goal"))
                        .await?;
                    let state = self
                        .autonomy
                        .complete(&context.session_id)
                        .await
                        .map_err(failure)?;
                    let message = format!(
                        "Goal completed: {}. It will disappear from sidebar.",
                        text(
                            &state
                                .goal
                                .as_ref()
                                .ok_or_else(|| Failure::Defect("Goal completion lost goal".into()))?
                                .text
                        )
                    );
                    (action, state, message)
                }
                "update" => {
                    let goal = existing.ok_or_else(|| {
                        Failure::message(
                            "No existing goal to update. The user creates goals via /goal.",
                        )
                    })?;
                    match status.as_ref().and_then(LosslessString::as_str) {
                        Some("completed") => {
                            self.require_completable(&context, goal).await?;
                            let message = format!("Goal marked completed: {}", text(&goal.text));
                            (
                                action,
                                self.autonomy
                                    .complete(&context.session_id)
                                    .await
                                    .map_err(failure)?,
                                message,
                            )
                        }
                        Some("stopped") => (
                            action,
                            self.autonomy
                                .stop(&context.session_id)
                                .await
                                .map_err(failure)?,
                            "Goal stopped and removed from sidebar.".into(),
                        ),
                        Some("active") if goal.status != GoalStatus::Active => {
                            return Err(Failure::message(
                                "Goal can only be started by the user. Re-activating a stopped goal must be done by the user via /goal.",
                            ));
                        }
                        _ => {
                            let message = format!(
                                "Goal unchanged: {} (status {})",
                                text(&goal.text),
                                goal.status.as_str()
                            );
                            (action, before, message)
                        }
                    }
                }
                _ => (
                    "stop",
                    self.autonomy
                        .stop(&context.session_id)
                        .await
                        .map_err(failure)?,
                    "Goal stopped and removed from sidebar.".into(),
                ),
            };
            let encoded = state.encode();
            let goal = match &encoded {
                JsonValue::Object(object) => object.get(&"goal".into()).cloned(),
                _ => None,
            };
            Ok(output(
                ObjectEncoder::new()
                    .field("action", returned_action)
                    .optional("goal", &goal)
                    .field("message", message.as_str())
                    .finish(),
                message,
            ))
        })
    }
}

impl Goal {
    async fn require_completable(
        &self,
        context: &Context,
        goal: &autonomy::Goal,
    ) -> Result<(), Failure> {
        let rejection = match &goal.failure {
            Some(failure) => {
                let unit = text(&failure.unit);
                let clears = match unit.strip_prefix("tool/") {
                    Some(tool) => {
                        format!("a successful {tool} call in this Session or a clean iteration")
                    }
                    None => "a successful model step in this Session or a clean iteration".into(),
                };
                Some((
                    format!(
                        "Goal cannot complete: failure {} (class {}, unit {}) stopped this Session's own iteration and is unresolved.",
                        text(&failure.fingerprint),
                        text(&failure.class),
                        unit
                    ),
                    format!(
                        "{} occurrence{}. It clears after {clears}.",
                        failure.count,
                        if failure.count == 1 { "" } else { "s" }
                    ),
                ))
            }
            None => autonomy::verification::check_rejection(
                &self.sessions.client,
                &context.session_id,
                &text(goal.raw_text.as_ref().unwrap_or(&goal.text)),
            )
            .map_err(|error| Failure::Defect(error.to_string()))?,
        };
        let Some((reason, detail)) = rejection else {
            return Ok(());
        };
        let repeated = autonomy::verification::repeats_rejection(
            &self.sessions.client,
            &context.session_id,
            &reason,
        )
        .map_err(|error| Failure::Defect(error.to_string()))?;
        let open = crate::session::review_fold::family_open(
            &self
                .sessions
                .client
                .snapshot()
                .map_err(|error| Failure::Defect(error.to_string()))?,
            context.session_id.as_lossless(),
        )
        .map_err(|error| Failure::Defect(error.to_string()))?
        .0;
        let budget = if repeated && open == 0 {
            let state = self
                .autonomy
                .report(&context.session_id)
                .await
                .map_err(failure)?;
            let goal = state
                .goal
                .as_ref()
                .ok_or_else(|| Failure::Defect("Goal report lost goal".into()))?;
            format!(
                "No new work since the identical previous rejection: no-progress attempt {}/{} charged{}.",
                goal.no_progress,
                goal.max_no_progress,
                if goal.status == GoalStatus::Exhausted {
                    "; the goal is exhausted"
                } else {
                    ""
                }
            )
        } else {
            "Calling complete again with no new tool call, check run, edit or descendant work since this rejection uses one no-progress attempt.".into()
        };
        Err(Failure::message(format!("{reason}\n{detail}\n{budget}")))
    }
}
fn text(value: &LosslessString) -> String {
    String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>())
}
fn failure(error: autonomy::Error) -> Failure {
    match error {
        autonomy::Error::NotFound(_) => Failure::message("Session not found"),
        _ => Failure::Defect(error.to_string()),
    }
}
