use crate::session::prompt_cache::{canonical_json, sha256};
use ycoding_schema::{JsonObject, JsonValue, LosslessString};

pub const AUTOMATIC_ANSWER: &str = "Continue with the safest reasonable default.";
pub const DEFAULT_MAX_NO_PROGRESS: u64 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub struct YoloLevel(u8);

impl YoloLevel {
    pub const OFF: Self = Self(0);
    pub const APPROVALS: Self = Self(1);
    pub const GUARDRAILS: Self = Self(2);

    pub fn new(level: u8) -> Option<Self> {
        (level <= 2).then_some(Self(level))
    }

    pub fn get(self) -> u8 {
        self.0
    }
}

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
        }
    }

    pub fn is_active(&self) -> bool {
        self.status == GoalStatus::Active
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

#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub yolo: YoloLevel,
    pub goal: Option<Goal>,
    pub sleep: bool,
    pub auto_answer: Option<bool>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            yolo: YoloLevel::OFF,
            goal: None,
            sleep: false,
            auto_answer: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewKind {
    Ordinary,
    Hard,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Effective {
    pub yolo: YoloLevel,
    pub goal_active: bool,
    pub asleep: bool,
    pub auto_answer: bool,
}

impl Effective {
    pub fn can_auto_answer(self) -> bool {
        self.auto_answer
    }

    pub fn can_auto_permission(self) -> bool {
        self.yolo >= YoloLevel::APPROVALS
    }

    pub fn can_auto_guardrail(self) -> bool {
        self.yolo >= YoloLevel::GUARDRAILS && !self.asleep
    }

    pub fn can_auto_review(self, kind: ReviewKind) -> bool {
        kind == ReviewKind::Ordinary && self.can_auto_guardrail()
    }

    pub fn is_autonomous(self) -> bool {
        self.yolo > YoloLevel::OFF || self.goal_active
    }

    pub fn inherit(self, ancestor: Self) -> Self {
        Self {
            yolo: self.yolo.max(ancestor.yolo),
            goal_active: self.goal_active || ancestor.goal_active,
            asleep: self.asleep || ancestor.asleep,
            auto_answer: self.auto_answer,
        }
    }
}

impl State {
    pub fn effective(&self) -> Effective {
        Effective {
            yolo: self.yolo,
            goal_active: self.goal.as_ref().is_some_and(Goal::is_active),
            asleep: self.sleep,
            auto_answer: self.auto_answer == Some(true),
        }
    }

    pub fn read(value: Option<&JsonValue>) -> Self {
        value.and_then(decode).unwrap_or_default()
    }

    pub fn encode(&self) -> JsonValue {
        let mut object = JsonObject::new();
        object.insert("mode".into(), JsonValue::String("normal".into()));
        object.insert("yolo".into(), JsonValue::Number(f64::from(self.yolo.get())));
        if let Some(goal) = &self.goal {
            object.insert("goal".into(), encode_goal(goal));
        }
        if self.sleep {
            object.insert("sleep".into(), JsonValue::Object(JsonObject::new()));
        }
        if let Some(enabled) = self.auto_answer {
            object.insert("autoAnswer".into(), JsonValue::Bool(enabled));
        }
        JsonValue::Object(object)
    }

    pub fn digest(&self) -> String {
        sha256(&canonical_json(&self.encode()))
    }

    pub fn is_asleep(&self) -> bool {
        self.sleep
    }

    pub fn set_sleep(&self, asleep: bool) -> Option<Self> {
        (self.sleep != asleep).then(|| Self {
            sleep: asleep,
            ..self.clone()
        })
    }

    pub fn set_auto_answer(&self, enabled: bool) -> Option<Self> {
        (self.auto_answer != Some(enabled)).then(|| Self {
            auto_answer: Some(enabled),
            ..self.clone()
        })
    }

    pub fn set_yolo(&self, level: YoloLevel) -> Option<Self> {
        (self.yolo != level).then(|| Self {
            yolo: level,
            ..self.clone()
        })
    }

    pub fn replace_goal(&self, goal: Goal) -> Self {
        Self {
            goal: Some(goal),
            ..self.clone()
        }
    }

    pub fn resume_goal(&self, yolo: Option<YoloLevel>) -> Option<Self> {
        let goal = self.goal.as_ref()?;
        Some(Self {
            yolo: yolo.unwrap_or(self.yolo),
            goal: Some(goal.with_status(GoalStatus::Active)),
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
            ..goal.clone()
        }))
    }

    pub fn change(&self, yolo: Option<YoloLevel>, goal: Option<&GoalChange>) -> Option<Self> {
        let mut next = self.clone();
        let mut changed = false;
        if let Some(level) = yolo
            && next.yolo != level
        {
            next.yolo = level;
            changed = true;
        }
        match goal {
            None => {}
            Some(GoalChange::Stop) => {
                changed = true;
                next = next.stop_goal();
            }
            Some(GoalChange::Resume) => {
                if next.goal.as_ref().is_some_and(|goal| !goal.is_active()) {
                    next = next.resume_goal(None)?;
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
                if same_active && yolo.is_none() {
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
                "Complete the active goal and verify its outcome. Resolve routine implementation choices within the authorized scope rather than requesting repeated confirmation.".into(),
                "Do not repeat an automatic waiting answer as a new user instruction. Preserve actual user constraints and required human approval.".into(),
                if self.auto_answer == Some(true) {
                    "Automatic answering is enabled for this Session. Automatic selections are not human replies or new user instructions. Resolve the routine choice toward the goal or identify the actual required human approval through its native request path."
                } else {
                    "Automatic answering is disabled for this Session. Resolve choices that need no user input yourself; required answers and required human approval remain manual."
                }.into(),
                "Choose safe implementation options and continue independent work. Required answers remain manual unless the answering Session's auto-answer toggle is on. Model guardrail judgments require guardrails.decide_reviews; hard-review grading also respects guardrails.decide_hard_reviews. Both automatic answers and model guardrail judgments default off. While awake, ask the user when required; a child Session's questions go to its parent Session. Defer unresolved requests to the review box while asleep. Goals do not override these gates.".into(),
                "Only call goal report after you encounter a blocker, try to resolve it yourself, and still cannot make progress.".into(),
                "Do not call goal report for ordinary progress; each report consumes one no-progress retry attempt.".into(),
                "Active background subagents or shells are unfinished work, not automatic no progress; continue useful independent work or finish the iteration and wait for automatic notification.".into(),
                "Call goal complete only after the goal is achieved and verified. Completion remains your explicit agent-owned decision.".into(),
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
    JsonValue::Object(object)
}

fn decode(value: &JsonValue) -> Option<State> {
    let JsonValue::Object(object) = value else {
        return None;
    };
    if object.get(&"mode".into()) != Some(&JsonValue::String("normal".into())) {
        return None;
    }
    let yolo = stored_level(object.get(&"yolo".into()));
    let goal = match object.get(&"goal".into()) {
        None => None,
        Some(value) => Some(decode_goal(value)?),
    };
    let sleep = matches!(object.get(&"sleep".into()), Some(JsonValue::Object(_)));
    let auto_answer = match object.get(&"autoAnswer".into()) {
        Some(JsonValue::Bool(enabled)) => Some(*enabled),
        _ => None,
    };
    Some(State {
        yolo,
        goal,
        sleep,
        auto_answer,
    })
}

fn stored_level(value: Option<&JsonValue>) -> YoloLevel {
    match value {
        Some(JsonValue::Bool(true)) => YoloLevel::GUARDRAILS,
        Some(JsonValue::Number(number)) if number.is_finite() => {
            let level = number.trunc();
            if (0.0..=2.0).contains(&level) {
                YoloLevel(level as u8)
            } else {
                YoloLevel::OFF
            }
        }
        _ => YoloLevel::OFF,
    }
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
    })
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
