use super::state::{DecisionChange, DecisionMode};
use ycoding_schema::{JsonObject, JsonValue};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Acceptance {
    pub permissions: Option<u64>,
    pub guardrails: Option<u64>,
    pub answers: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Defaults {
    pub permissions: DecisionMode,
    pub guardrails: DecisionMode,
    pub answers: DecisionMode,
    pub yolo_accepted_at: Acceptance,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DefaultsChange {
    pub permissions: Option<DecisionMode>,
    pub guardrails: Option<DecisionMode>,
    pub answers: Option<DecisionMode>,
    pub accept_yolo: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    NoCategory,
    RiskNotAccepted,
}

const CATEGORIES: [&str; 3] = ["permissions", "guardrails", "answers"];

impl Defaults {
    pub fn decode(value: Option<&JsonValue>) -> Self {
        let Some(JsonValue::Object(object)) = value else {
            return Self::default();
        };
        let accepted = match object.get(&"yolo_accepted_at".into()) {
            Some(JsonValue::Object(accepted)) => Some(accepted),
            _ => None,
        };
        let read = |category: &str| {
            let mode = match object.get(&category.into()) {
                Some(JsonValue::String(mode)) => mode.as_str().and_then(DecisionMode::parse),
                _ => None,
            }
            .unwrap_or_default();
            let at = accepted
                .and_then(|accepted| accepted.get(&category.into()))
                .and_then(timestamp);
            match (mode, at) {
                (DecisionMode::Yolo, None) => (DecisionMode::Manual, None),
                (DecisionMode::Yolo, at) => (DecisionMode::Yolo, at),
                (mode, _) => (mode, None),
            }
        };
        let (permissions, permissions_at) = read("permissions");
        let (guardrails, guardrails_at) = read("guardrails");
        let (answers, answers_at) = read("answers");
        Self {
            permissions,
            guardrails,
            answers,
            yolo_accepted_at: Acceptance {
                permissions: permissions_at,
                guardrails: guardrails_at,
                answers: answers_at,
            },
        }
    }

    pub fn encode(&self) -> JsonValue {
        let mut object = JsonObject::new();
        let modes = [self.permissions, self.guardrails, self.answers];
        let accepted = [
            self.yolo_accepted_at.permissions,
            self.yolo_accepted_at.guardrails,
            self.yolo_accepted_at.answers,
        ];
        let mut acceptance = JsonObject::new();
        for (index, category) in CATEGORIES.iter().enumerate() {
            object.insert(
                (*category).into(),
                JsonValue::String(modes[index].as_str().into()),
            );
            if let (DecisionMode::Yolo, Some(at)) = (modes[index], accepted[index]) {
                acceptance.insert((*category).into(), JsonValue::Number(at as f64));
            }
        }
        if !acceptance.is_empty() {
            object.insert("yolo_accepted_at".into(), JsonValue::Object(acceptance));
        }
        JsonValue::Object(object)
    }

    pub fn apply(&self, change: DefaultsChange, now: u64) -> Result<Self, Refusal> {
        if change.permissions.is_none() && change.guardrails.is_none() && change.answers.is_none() {
            return Err(Refusal::NoCategory);
        }
        let resolve = |current: DecisionMode,
                       accepted: Option<u64>,
                       requested: Option<DecisionMode>| {
            match requested {
                None => Ok((current, accepted)),
                Some(DecisionMode::Yolo) if current == DecisionMode::Yolo && accepted.is_some() => {
                    Ok((current, accepted))
                }
                Some(DecisionMode::Yolo) if change.accept_yolo => {
                    Ok((DecisionMode::Yolo, Some(now)))
                }
                Some(DecisionMode::Yolo) => Err(Refusal::RiskNotAccepted),
                Some(mode) => Ok((mode, None)),
            }
        };
        let (permissions, permissions_at) = resolve(
            self.permissions,
            self.yolo_accepted_at.permissions,
            change.permissions,
        )?;
        let (guardrails, guardrails_at) = resolve(
            self.guardrails,
            self.yolo_accepted_at.guardrails,
            change.guardrails,
        )?;
        let (answers, answers_at) =
            resolve(self.answers, self.yolo_accepted_at.answers, change.answers)?;
        Ok(Self {
            permissions,
            guardrails,
            answers,
            yolo_accepted_at: Acceptance {
                permissions: permissions_at,
                guardrails: guardrails_at,
                answers: answers_at,
            },
        })
    }

    pub fn initial_decisions(&self) -> Option<DecisionChange> {
        let mode = |mode: DecisionMode| (mode != DecisionMode::Manual).then_some(mode);
        DecisionChange::new(
            mode(self.permissions),
            mode(self.guardrails),
            mode(self.answers),
        )
    }
}

fn timestamp(value: &JsonValue) -> Option<u64> {
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
