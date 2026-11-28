use super::goal_state::{GoalFailure, GoalPhase, GoalRecovery, GoalRework, GoalWait};
use crate::session::prompt_cache::{canonical_json, sha256};
use ycoding_schema::{DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString};

pub const DEFAULT_MAX_NO_PROGRESS: u64 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoalStatus {
    Active,
    Completed,
    Stopped,
    Exhausted,
}

impl GoalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Completed => "completed",
            Self::Stopped => "stopped",
            Self::Exhausted => "exhausted",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "completed" => Some(Self::Completed),
            "stopped" => Some(Self::Stopped),
            "exhausted" => Some(Self::Exhausted),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Goal {
    pub text: LosslessString,
    pub raw_text: Option<LosslessString>,
    pub status: GoalStatus,
    pub iteration: u64,
    pub no_progress: u64,
    pub max_no_progress: u64,
    pub last_progress_digest: Option<LosslessString>,
    pub phase: Option<GoalPhase>,
    pub wait: Option<GoalWait>,
    pub rework: Option<u64>,
    pub rework_open: Option<Vec<GoalRework>>,
    pub stalls: Option<u64>,
    pub failure: Option<GoalFailure>,
    pub recovery: Option<GoalRecovery>,
}

impl Goal {
    pub fn new(text: &str, raw_text: Option<&str>, max_no_progress: Option<u64>) -> Self {
        Self {
            text: text.trim().into(),
            raw_text: Some(raw_text.unwrap_or(text).trim().into()),
            status: GoalStatus::Active,
            iteration: 0,
            no_progress: 0,
            max_no_progress: max_no_progress.unwrap_or(DEFAULT_MAX_NO_PROGRESS).max(1),
            last_progress_digest: None,
            phase: None,
            wait: None,
            rework: None,
            rework_open: None,
            stalls: None,
            failure: None,
            recovery: None,
        }
    }

    pub fn is_active(&self) -> bool {
        self.status == GoalStatus::Active
    }

    pub fn phase(&self) -> GoalPhase {
        if let Some(failure) = &self.failure {
            return if failure.recovering {
                GoalPhase::Rework
            } else {
                GoalPhase::Stalled
            };
        }
        if self.wait.is_some() {
            return GoalPhase::Waiting;
        }
        if self
            .rework_open
            .as_ref()
            .is_some_and(|open| !open.is_empty())
        {
            return GoalPhase::Rework;
        }
        GoalPhase::Active
    }

    pub(super) fn normalize_phase(&mut self) {
        self.phase = match self.phase() {
            GoalPhase::Active => None,
            phase => Some(phase),
        };
    }

    pub fn describe(&self) -> String {
        let wait = self
            .wait
            .map(|wait| format!(" (waiting on {})", wait.as_str()))
            .unwrap_or_default();
        let mut lines = vec![format!(
            "Goal phase: {}{wait}; rework {}; stalled units stopped {}; no progress {}/{}",
            self.phase().as_str(),
            self.rework.unwrap_or(0),
            self.stalls.unwrap_or(0),
            self.no_progress,
            self.max_no_progress
        )];
        for item in self.rework_open.iter().flatten() {
            lines.push(format!(
                "Open rework (unfinished): {} — {}",
                item.unit.to_utf8().unwrap_or_default(),
                item.reason.to_utf8().unwrap_or_default()
            ));
        }
        if let Some(failure) = &self.failure {
            lines.push(format!(
                "Unresolved failure {} ({} on {}, {} occurrence{}){}",
                failure.fingerprint.to_utf8().unwrap_or_default(),
                failure.class.to_utf8().unwrap_or_default(),
                failure.unit.to_utf8().unwrap_or_default(),
                failure.count,
                if failure.count == 1 { "" } else { "s" },
                if failure.recovering {
                    ""
                } else {
                    "; waiting for a changed condition"
                }
            ));
        }
        lines.join("\n")
    }

    fn with_status(&self, status: GoalStatus) -> Self {
        Self {
            status,
            ..self.clone()
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum GoalChange {
    Stop,
    Resume,
    Replace {
        text: String,
        raw_text: Option<String>,
        max_no_progress: Option<u64>,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum DecisionMode {
    #[default]
    Manual,
    Yolo,
    Auto,
}

impl DecisionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Yolo => "yolo",
            Self::Auto => "auto",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "manual" => Some(Self::Manual),
            "yolo" => Some(Self::Yolo),
            "auto" => Some(Self::Auto),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecisionChange {
    permissions: Option<DecisionMode>,
    guardrails: Option<DecisionMode>,
    answers: Option<DecisionMode>,
}

impl DecisionChange {
    pub fn new(
        permissions: Option<DecisionMode>,
        guardrails: Option<DecisionMode>,
        answers: Option<DecisionMode>,
    ) -> Option<Self> {
        (permissions.is_some() || guardrails.is_some() || answers.is_some()).then_some(Self {
            permissions,
            guardrails,
            answers,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub permissions: DecisionMode,
    pub guardrails: DecisionMode,
    pub answers: DecisionMode,
    pub goal: Option<Goal>,
    pub defer: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Effective {
    pub permissions: DecisionMode,
    pub guardrails: DecisionMode,
    pub answers: DecisionMode,
    pub goal_active: bool,
    pub deferred: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Inherited {
    pub permissions: Option<LosslessString>,
    pub guardrails: Option<LosslessString>,
    pub answers: Option<LosslessString>,
}

impl Effective {
    pub fn can_yolo_permission(self) -> bool {
        self.permissions == DecisionMode::Yolo
    }

    pub fn can_auto_permission(self) -> bool {
        self.permissions == DecisionMode::Auto
    }

    pub fn can_yolo_guardrail(self) -> bool {
        self.guardrails == DecisionMode::Yolo
    }

    pub fn can_auto_guardrail(self) -> bool {
        self.guardrails == DecisionMode::Auto && !self.deferred
    }

    pub fn can_yolo_answer(self) -> bool {
        self.answers == DecisionMode::Yolo
    }

    pub fn can_auto_answer(self) -> bool {
        self.answers == DecisionMode::Auto
    }
}

pub(crate) fn resolve(
    chain: &[&State],
    root: &State,
) -> (DecisionMode, DecisionMode, DecisionMode) {
    let permissions = if chain
        .iter()
        .any(|state| state.permissions == DecisionMode::Yolo)
    {
        DecisionMode::Yolo
    } else if chain
        .iter()
        .any(|state| state.permissions == DecisionMode::Auto)
    {
        DecisionMode::Auto
    } else {
        DecisionMode::Manual
    };
    let answers = if chain
        .iter()
        .any(|state| state.answers == DecisionMode::Yolo)
    {
        DecisionMode::Yolo
    } else if chain
        .first()
        .is_some_and(|state| state.answers == DecisionMode::Auto)
    {
        DecisionMode::Auto
    } else {
        DecisionMode::Manual
    };
    (permissions, root.guardrails, answers)
}

impl State {
    pub fn effective(&self) -> Effective {
        Effective {
            permissions: self.permissions,
            guardrails: self.guardrails,
            answers: self.answers,
            goal_active: self.goal.as_ref().is_some_and(Goal::is_active),
            deferred: self.defer,
        }
    }

    pub fn read(value: Option<&JsonValue>) -> Self {
        value.and_then(decode).unwrap_or_default()
    }

    pub fn encode(&self) -> JsonValue {
        let mut object = JsonObject::new();
        object.insert("mode".into(), JsonValue::String("normal".into()));
        object.insert(
            "permissions".into(),
            JsonValue::String(self.permissions.as_str().into()),
        );
        object.insert(
            "guardrails".into(),
            JsonValue::String(self.guardrails.as_str().into()),
        );
        object.insert(
            "answers".into(),
            JsonValue::String(self.answers.as_str().into()),
        );
        if let Some(goal) = &self.goal {
            object.insert("goal".into(), encode_goal(goal));
        }
        if self.defer {
            object.insert("defer".into(), JsonValue::Object(JsonObject::new()));
        }
        JsonValue::Object(object)
    }

    pub fn digest(&self) -> String {
        sha256(&canonical_json(&self.encode()))
    }

    pub fn is_deferred(&self) -> bool {
        self.defer
    }

    pub fn set_defer(&self, deferred: bool) -> Option<Self> {
        (self.defer != deferred).then(|| Self {
            defer: deferred,
            ..self.clone()
        })
    }

    pub fn set_decisions(&self, change: DecisionChange) -> Option<Self> {
        let next = Self {
            permissions: change.permissions.unwrap_or(self.permissions),
            guardrails: change.guardrails.unwrap_or(self.guardrails),
            answers: change.answers.unwrap_or(self.answers),
            ..self.clone()
        };
        (next != *self).then_some(next)
    }

    pub fn replace_goal(&self, goal: Goal) -> Self {
        Self {
            goal: Some(goal),
            ..self.clone()
        }
    }

    pub fn resume_goal(&self) -> Option<Self> {
        let goal = self.goal.as_ref()?;
        Some(Self {
            goal: Some(Goal {
                failure: None,
                wait: None,
                recovery: None,
                phase: None,
                ..goal.with_status(GoalStatus::Active)
            }),
            ..self.clone()
        })
    }

    pub fn stop_goal(&self) -> Self {
        match &self.goal {
            Some(goal) if goal.status != GoalStatus::Stopped => Self {
                goal: Some(goal.with_status(GoalStatus::Stopped)),
                ..self.clone()
            },
            _ => self.clone(),
        }
    }

    pub fn report(&self) -> Option<Self> {
        let goal = self.active_goal()?;
        let no_progress = goal.no_progress + 1;
        let status = if no_progress >= goal.max_no_progress {
            GoalStatus::Exhausted
        } else {
            GoalStatus::Active
        };
        Some(self.with_goal(Goal {
            status,
            no_progress,
            ..goal.clone()
        }))
    }

    pub fn complete(&self) -> Option<Self> {
        let goal = self.active_goal()?;
        Some(self.with_goal(goal.with_status(GoalStatus::Completed)))
    }

    pub fn advance(&self) -> Option<Self> {
        let goal = self.active_goal()?;
        Some(self.with_goal(Goal {
            iteration: goal.iteration + 1,
            failure: None,
            wait: None,
            ..goal.clone()
        }))
    }

    pub fn change(&self, goal: Option<&GoalChange>) -> Option<Self> {
        let mut next = self.clone();
        let mut changed = false;
        match goal {
            None => {}
            Some(GoalChange::Stop) => {
                changed = true;
                next = next.stop_goal();
            }
            Some(GoalChange::Resume) => {
                if next.goal.as_ref().is_some_and(|goal| !goal.is_active()) {
                    next = next.resume_goal()?;
                    changed = true;
                }
            }
            Some(GoalChange::Replace {
                text,
                raw_text,
                max_no_progress,
            }) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    return Some(next);
                }
                let same_active = next.goal.as_ref().is_some_and(|goal| {
                    goal.is_active()
                        && goal
                            .raw_text
                            .as_ref()
                            .unwrap_or(&goal.text)
                            .as_str()
                            .is_some_and(|current| current == trimmed)
                });
                if same_active {
                    return None;
                }
                next.goal = Some(Goal::new(trimmed, raw_text.as_deref(), *max_no_progress));
                changed = true;
            }
        }
        changed.then_some(next)
    }

    pub fn goal_reminder(&self) -> Option<String> {
        let goal = self.goal.as_ref()?;
        let text = goal.text.to_utf8().unwrap_or_default();
        if !goal.is_active() {
            return Some(format!(
                "Autonomous goal is {}: {text}",
                goal.status.as_str()
            ));
        }
        Some(
            [
                format!(
                    "Active autonomous goal (iteration {}, noProgress {}/{}): {text}",
                    goal.iteration, goal.no_progress, goal.max_no_progress
                ),
                goal.describe(),
                "Keep the full objective and use current files and command output to decide what remains. Run independent work in parallel and continue from edits through verification.".into(),
                "Record reopened work with goal rework, naming the unit and failing evidence. Resolve it only after rerunning its check successfully. Rework does not spend a no-progress attempt.".into(),
                "Complete the active goal and verify its outcome. Resolve routine implementation choices within the authorized scope rather than requesting repeated confirmation.".into(),
                "Do not repeat an automatic waiting answer as a new user instruction. Preserve actual user constraints.".into(),
                match self.answers {
                    DecisionMode::Auto => "Automatic answering is enabled for this Session. Automatic selections are not human replies or new user instructions. Resolve the choice toward the goal.",
                    DecisionMode::Yolo => "Answers YOLO uses the answer evaluator and validated fallbacks, including free text questions. Automatic answers are not human replies, new user instructions or external acknowledgements.",
                    DecisionMode::Manual => "Automatic answering is disabled for this Session. Resolve choices yourself from evidence; the active goal loop may answer pending questions with the Goal agent.",
                }
                .into(),
                "Continue independent work under each category's current mode. Permissions YOLO admits directly within deny rules and permission ceilings, except Project coordinator execution restrictions; guardrails YOLO bypasses classification and review while retaining action capacity. Neither uses an evaluator. Answers YOLO alone consults the answer evaluator and validated fallbacks. Manual and Auto retain their native gates. Defer persists until explicitly disabled and retains unresolved requests in the review box. Goals change no category authority.".into(),
                "Only call goal report after you encounter a blocker, try to resolve it yourself, and still cannot make progress.".into(),
                "Do not call goal report for ordinary progress; each report consumes one no-progress retry attempt.".into(),
                "Active background subagents or shells are unfinished work, not automatic no progress; continue useful independent work or finish the iteration and wait for automatic notification.".into(),
                "Call goal complete only after checking every requirement against authoritative evidence. Named checks must pass after the latest edit in this Session family; identical completion rejections without intervening work spend a no-progress attempt. Completion remains your explicit agent-owned decision.".into(),
            ]
            .join("\n"),
        )
    }

    fn active_goal(&self) -> Option<&Goal> {
        self.goal.as_ref().filter(|goal| goal.is_active())
    }

    fn with_goal(&self, goal: Goal) -> Self {
        Self {
            goal: Some(goal),
            ..self.clone()
        }
    }
}

fn encode_goal(goal: &Goal) -> JsonValue {
    let mut object = JsonObject::new();
    object.insert("text".into(), JsonValue::String(goal.text.clone()));
    if let Some(raw) = &goal.raw_text {
        object.insert("rawText".into(), JsonValue::String(raw.clone()));
    }
    object.insert(
        "status".into(),
        JsonValue::String(goal.status.as_str().into()),
    );
    object.insert("iteration".into(), JsonValue::Number(goal.iteration as f64));
    object.insert(
        "noProgress".into(),
        JsonValue::Number(goal.no_progress as f64),
    );
    object.insert(
        "maxNoProgress".into(),
        JsonValue::Number(goal.max_no_progress as f64),
    );
    if let Some(digest) = &goal.last_progress_digest {
        object.insert(
            "lastProgressDigest".into(),
            JsonValue::String(digest.clone()),
        );
    }
    if let Some(phase) = goal.phase {
        object.insert("phase".into(), JsonValue::String(phase.as_str().into()));
    }
    if let Some(wait) = goal.wait {
        object.insert("wait".into(), JsonValue::String(wait.as_str().into()));
    }
    if let Some(rework) = goal.rework {
        object.insert("rework".into(), JsonValue::Number(rework as f64));
    }
    if let Some(open) = &goal.rework_open {
        object.insert("reworkOpen".into(), open.encode());
    }
    if let Some(stalls) = goal.stalls {
        object.insert("stalls".into(), JsonValue::Number(stalls as f64));
    }
    if let Some(failure) = &goal.failure {
        object.insert("failure".into(), failure.encode());
    }
    if let Some(recovery) = &goal.recovery {
        object.insert("recovery".into(), recovery.encode());
    }
    JsonValue::Object(object)
}

const RETIRED_KEYS: [&str; 4] = ["yolo", "autoPermission", "autoGuardrail", "autoAnswer"];

fn decode(value: &JsonValue) -> Option<State> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    if object.get(&"mode".into()) != Some(&JsonValue::String("normal".into()))
        || RETIRED_KEYS
            .iter()
            .any(|key| object.get(&(*key).into()).is_some())
    {
        return None;
    }
    let decision = |key: &str| match object.get(&key.into()) {
        Some(JsonValue::String(value)) => DecisionMode::parse(value.as_str()?),
        _ => None,
    };
    let goal = match object.get(&"goal".into()) {
        None => None,
        Some(value) => Some(decode_goal(value)?),
    };
    let defer = match object
        .get(&"defer".into())
        .or_else(|| object.get(&"sleep".into()))
    {
        None => false,
        Some(JsonValue::Object(_)) => true,
        Some(_) => return None,
    };
    Some(State {
        permissions: decision("permissions")?,
        guardrails: decision("guardrails")?,
        answers: decision("answers")?,
        goal,
        defer,
    })
}

fn decode_goal(value: &JsonValue) -> Option<Goal> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    let string = |key: &str| match object.get(&key.into()) {
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => None,
    };
    let optional = |key: &str| match object.get(&key.into()) {
        None => Some(None),
        Some(JsonValue::String(value)) => Some(Some(value.clone())),
        Some(_) => None,
    };
    let status = string("status")?;
    Some(Goal {
        text: string("text")?,
        raw_text: optional("rawText")?,
        status: GoalStatus::parse(status.as_str()?)?,
        iteration: integer(object.get(&"iteration".into())?)?,
        no_progress: integer(object.get(&"noProgress".into())?)?,
        max_no_progress: integer(object.get(&"maxNoProgress".into())?).filter(|max| *max > 0)?,
        last_progress_digest: optional("lastProgressDigest")?,
        phase: match optional("phase")? {
            None => None,
            Some(phase) => Some(GoalPhase::parse(phase.as_str()?)?),
        },
        wait: match optional("wait")? {
            None => None,
            Some(wait) => Some(GoalWait::parse(wait.as_str()?)?),
        },
        rework: optional_integer(object, "rework")?,
        stalls: optional_integer(object, "stalls")?,
        rework_open: object
            .get(&"reworkOpen".into())
            .map(Vec::<GoalRework>::decode)
            .transpose()
            .ok()?,
        failure: object
            .get(&"failure".into())
            .map(GoalFailure::decode)
            .transpose()
            .ok()?,
        recovery: object
            .get(&"recovery".into())
            .map(GoalRecovery::decode)
            .transpose()
            .ok()?,
    })
}

fn optional_integer(object: &JsonObject, key: &str) -> Option<Option<u64>> {
    match object.get(&key.into()) {
        None => Some(None),
        Some(value) => integer(value).map(Some),
    }
}

fn integer(value: &JsonValue) -> Option<u64> {
    match value {
        JsonValue::Number(number)
            if number.is_finite()
                && number.fract() == 0.0
                && (0.0..=9007199254740991.0).contains(number) =>
        {
            Some(*number as u64)
        }
        _ => None,
    }
}
