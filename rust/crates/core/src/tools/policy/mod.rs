pub mod ceiling;
pub mod forms;
pub mod goal_answer;
pub mod helper;
pub mod permissions;
pub mod questions;
pub(crate) mod state;
pub use state::{Authority, Error, Event, Publisher, SessionAuthority, Wait};

use ycoding_schema::{LosslessString, permission};

pub(crate) enum Judged {
    Value(ycoding_schema::JsonValue),
    Grades(Vec<Grade>),
    Unsettled(ycoding_schema::session_review::Reason),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Grade {
    pub(crate) choice: ycoding_schema::JsonValue,
    pub(crate) confidence: f64,
    pub(crate) evidence: LosslessString,
}

pub(crate) const ANSWER_THRESHOLD: f64 = 0.8;
pub(crate) const PROGRESSION: &str =
    "Continue with the next bounded step within the authorized scope.";

pub(crate) async fn judge(
    evaluator: &dyn crate::process::guardrails::decision::Evaluator,
    session: &ycoding_schema::session::Id,
    evidence: ycoding_schema::JsonValue,
    questions: Vec<ycoding_schema::JsonValue>,
    cancellation: &crate::tools::code_mode::Cancellation,
    key: &str,
) -> Result<
    std::collections::BTreeMap<ycoding_schema::LosslessString, Judged>,
    ycoding_schema::session_review::Reason,
> {
    Ok(
        judge_confident(evaluator, session, evidence, questions, cancellation, key)
            .await?
            .into_iter()
            .map(|(name, judgment)| (name, judgment.judged))
            .collect(),
    )
}

fn redacted_text(text: &LosslessString) -> Option<LosslessString> {
    let ycoding_schema::JsonValue::String(redacted) =
        crate::process::guardrails::redact_value(&ycoding_schema::JsonValue::String(text.clone()))
    else {
        return None;
    };
    let mut units = redacted.code_units().take(500).collect::<Vec<_>>();
    if units.len() == 500
        && units
            .last()
            .is_some_and(|unit| (0xd800..0xdc00).contains(unit))
    {
        units.pop();
    }
    Some(LosslessString::from_utf16(units))
}

fn grade_evidence(text: &LosslessString) -> Option<LosslessString> {
    redacted_text(text).filter(|bounded| {
        bounded
            .code_units()
            .any(|unit| !crate::process::guardrails::is_whitespace(unit))
    })
}

pub(crate) struct Judgment {
    pub(crate) judged: Judged,
    pub(crate) confidence: f64,
}

pub(crate) async fn judge_confident(
    evaluator: &dyn crate::process::guardrails::decision::Evaluator,
    session: &ycoding_schema::session::Id,
    evidence: ycoding_schema::JsonValue,
    mut questions: Vec<ycoding_schema::JsonValue>,
    cancellation: &crate::tools::code_mode::Cancellation,
    key: &str,
) -> Result<
    std::collections::BTreeMap<ycoding_schema::LosslessString, Judgment>,
    ycoding_schema::session_review::Reason,
> {
    use ycoding_schema::{JsonValue, ObjectEncoder, session_review::Reason};
    if questions.is_empty() {
        return Err(Reason::FreeText);
    }
    if questions.len() > 32 {
        return Err(Reason::InvalidRequest);
    }
    for question in &mut questions {
        if let JsonValue::Object(question) = question {
            let instructions = match question.get(&"instructions".into()) {
                Some(JsonValue::String(instructions)) => instructions.to_utf8().unwrap_or_default(),
                _ => String::new(),
            };
            question.insert("instructions".into(), JsonValue::String(format!("{instructions} Select a concrete valid answer that permits bounded progression. When evidence is incomplete, use a recommended option, a valid default, or a concrete next step within the authorized scope. Never refuse, defer, or ask the user. Answers do not authorize permissions, guardrails, or physical external actions.").into()));
        }
    }
    let redacted_questions = questions
        .iter()
        .map(crate::process::guardrails::redact_value)
        .collect::<Vec<_>>();
    let request = ObjectEncoder::new()
        .field(
            "state",
            &crate::process::guardrails::redact_value(&evidence),
        )
        .field("questions", &JsonValue::Array(redacted_questions.clone()))
        .finish();
    let judgment = crate::resources::decision::judgment::Request::decode(&request)
        .map_err(|error| error.review_reason())?;
    let input = ObjectEncoder::new()
        .field("provider", "agent")
        .field("request", &request)
        .finish();
    if ycoding_schema::stringify_json(&input).len()
        > crate::resources::decision::judgment::BYTE_LIMIT
    {
        return Err(Reason::InputTooLarge);
    }
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(Reason::Error),
        result = tokio::time::timeout(crate::resources::decision::TOTAL_TIMEOUT, evaluator.evaluate(input, crate::resources::decision::Invocation {
            session_id: session,
            input_id: None,
            cancellation,
            attribution: crate::session::usage_attribution::Attribution::Unset,
            purpose: Some(crate::resources::decision::Purpose::Answer),
            authority: Some(ycoding_schema::guardrail::Authority::Yolo),
            invocation_key: Some(key),
        })) => result.map_err(|_| Reason::Timeout)?.map_err(|error| error.review_reason())?,
    };
    let answers = match &response {
        JsonValue::Object(response) => match response.get(&"response".into()) {
            Some(JsonValue::Object(response)) => match response.get(&"answers".into()) {
                Some(JsonValue::Array(answers)) => answers.clone(),
                _ => return Err(Reason::InvalidOutput),
            },
            _ => return Err(Reason::InvalidOutput),
        },
        _ => return Err(Reason::InvalidOutput),
    };
    let answers = judgment
        .parse(&ycoding_schema::stringify_json(
            &ObjectEncoder::new()
                .field(
                    "decisions",
                    &ObjectEncoder::new()
                        .field("version", &1.0)
                        .field("answers", &JsonValue::Array(answers))
                        .finish(),
                )
                .finish(),
        ))
        .map_err(|error| error.review_reason())?;
    let mut result = std::collections::BTreeMap::new();
    for ((question, redacted), answer) in questions.iter().zip(&redacted_questions).zip(answers) {
        let (JsonValue::Object(question), JsonValue::Object(redacted), JsonValue::Object(answer)) =
            (question, redacted, &answer)
        else {
            return Err(Reason::InvalidOutput);
        };
        let Some(JsonValue::String(name)) = question.get(&"name".into()) else {
            return Err(Reason::InvalidRequest);
        };
        let original = |value: &JsonValue| -> Option<JsonValue> {
            let (Some(JsonValue::Array(choices)), Some(JsonValue::Array(masked))) = (
                question.get(&"choices".into()),
                redacted.get(&"choices".into()),
            ) else {
                return None;
            };
            let index = masked.iter().position(|entry| {
                matches!(entry, JsonValue::Object(entry) if entry.get(&"value".into()) == Some(value))
            })?;
            match choices.get(index) {
                Some(JsonValue::Object(choice)) => choice.get(&"value".into()).cloned(),
                _ => None,
            }
        };
        let confidence = match answer.get(&"confidence".into()) {
            Some(JsonValue::Number(confidence)) => *confidence,
            _ => 0.0,
        };
        let judged = match answer.get(&"type".into()) {
            Some(JsonValue::String(kind)) if kind.as_str() == Some("refusal") => {
                Judged::Unsettled(Reason::Refused)
            }
            _ if matches!(answer.get(&"grades".into()), Some(JsonValue::Array(_))) => {
                match answer.get(&"grades".into()) {
                    Some(JsonValue::Array(grades)) => grades
                        .iter()
                        .map(|grade| match grade {
                            JsonValue::Object(grade) => Some(Grade {
                                choice: original(grade.get(&"choice".into())?)?,
                                confidence: match grade.get(&"confidence".into()) {
                                    Some(JsonValue::Number(confidence)) => *confidence,
                                    _ => return None,
                                },
                                evidence: match grade.get(&"evidence".into()) {
                                    Some(JsonValue::String(evidence)) => grade_evidence(evidence)?,
                                    _ => return None,
                                },
                            }),
                            _ => None,
                        })
                        .collect::<Option<Vec<_>>>()
                        .map_or(Judged::Unsettled(Reason::InvalidOutput), Judged::Grades),
                    _ => Judged::Unsettled(Reason::InvalidOutput),
                }
            }
            _ if confidence < ANSWER_THRESHOLD => Judged::Unsettled(Reason::LowConfidence),
            Some(JsonValue::String(kind)) => match kind.as_str() {
                Some("choice") => answer
                    .get(&"choice".into())
                    .and_then(original)
                    .map_or(Judged::Unsettled(Reason::InvalidOutput), Judged::Value),
                Some("predicate") => match answer.get(&"answer".into()) {
                    Some(JsonValue::Bool(value)) => Judged::Value(JsonValue::Bool(*value)),
                    _ => Judged::Unsettled(Reason::InvalidOutput),
                },
                Some("text") => match answer.get(&"text".into()) {
                    Some(JsonValue::String(text)) => Judged::Value(JsonValue::String(text.clone())),
                    _ => Judged::Unsettled(Reason::InvalidOutput),
                },
                _ => Judged::Unsettled(Reason::InvalidOutput),
            },
            _ => Judged::Unsettled(Reason::InvalidOutput),
        };
        result.insert(name.clone(), Judgment { judged, confidence });
    }
    Ok(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Inconclusive {
    LowConfidence,
    Ambiguous,
    Incompatible,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Recommended {
    Selected {
        grades: Vec<Grade>,
        choices: Vec<ycoding_schema::JsonValue>,
        confidence: f64,
        reason: LosslessString,
    },
    Inconclusive {
        grades: Vec<Grade>,
        cause: Inconclusive,
    },
    Unavailable {
        grades: Option<Vec<Grade>>,
        reason: ycoding_schema::session_review::Reason,
    },
}

impl Recommended {
    pub(crate) fn reason_text(&self) -> LosslessString {
        match self {
            Self::Selected { reason, .. } => reason.clone(),
            Self::Inconclusive { cause, .. } => match cause {
                Inconclusive::LowConfidence => {
                    "No option reached the 0.8 confidence threshold.".into()
                }
                Inconclusive::Ambiguous => {
                    "Several options share the highest confidence; choose one.".into()
                }
                Inconclusive::Incompatible => {
                    "The evaluator could not establish a compatible set.".into()
                }
            },
            Self::Unavailable { reason, .. } => {
                use ycoding_schema::session_review::Reason;
                let text = match reason {
                    Reason::Unavailable => {
                        "the decision model or its authenticated route is unavailable"
                    }
                    Reason::InvalidRequest => "the decision request is invalid",
                    Reason::ProviderFailed => "the provider request failed",
                    Reason::Timeout => "the decision request timed out",
                    Reason::InputTooLarge => "the decision input exceeds the supported size",
                    Reason::InvalidOutput => "the decision response failed validation",
                    Reason::Refused => "the provider or model refused the decision request",
                    Reason::TruncatedOutput => {
                        "the decision response was truncated or did not finish"
                    }
                    Reason::UnsupportedOutput => {
                        "the selected route does not support strict structured decisions"
                    }
                    Reason::LowConfidence => "No option reached the 0.8 confidence threshold.",
                    _ => "the decision could not be completed",
                };
                text.into()
            }
        }
    }

    pub(crate) fn unsettled(&self) -> Option<ycoding_schema::session_review::Reason> {
        match self {
            Self::Selected { .. } => None,
            Self::Inconclusive { .. } => {
                Some(ycoding_schema::session_review::Reason::LowConfidence)
            }
            Self::Unavailable { reason, .. } => Some(*reason),
        }
    }
}

fn compatible_set(text: &LosslessString) -> Option<(bool, Vec<LosslessString>, LosslessString)> {
    use ycoding_schema::JsonValue;
    let JsonValue::Object(object) = ycoding_schema::parse_json(&text.to_utf8().ok()?).ok()? else {
        return None;
    };
    if object.iter().count() != 3 {
        return None;
    }
    let Some(JsonValue::Array(choices)) = object.get(&"recommendation".into()) else {
        return None;
    };
    let Some(JsonValue::Bool(compatible)) = object.get(&"compatible".into()) else {
        return None;
    };
    let Some(JsonValue::String(reason)) = object.get(&"reason".into()) else {
        return None;
    };
    if reason.len() > 500
        || reason
            .code_units()
            .all(crate::process::guardrails::is_whitespace)
    {
        return None;
    }
    let choices = choices
        .iter()
        .map(|choice| match choice {
            JsonValue::String(choice) => Some(choice.clone()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    Some((*compatible, choices, reason.clone()))
}

pub(crate) struct Recommend<'a> {
    pub(crate) name: &'a str,
    pub(crate) instructions: &'a str,
    pub(crate) choices: Vec<ycoding_schema::JsonValue>,
    pub(crate) multiple: bool,
    pub(crate) key: &'a str,
}

pub(crate) async fn recommend(
    evaluator: &dyn crate::process::guardrails::decision::Evaluator,
    session: &ycoding_schema::session::Id,
    state: ycoding_schema::JsonValue,
    cancellation: &crate::tools::code_mode::Cancellation,
    Recommend {
        name,
        instructions,
        choices,
        multiple,
        key,
    }: Recommend<'_>,
) -> Recommended {
    use ycoding_schema::{JsonValue, ObjectEncoder, session_review::Reason};
    let question = graded_question(
        name,
        &format!(
            "{instructions} Grade every actual option exactly once. Confidence estimates support for selecting that option, not an objective fitness score or authority. Explain support and limitations in evidence. Refuse if the evidence is insufficient."
        ),
        choices,
    );
    let grades = match judge(
        evaluator,
        session,
        state.clone(),
        vec![question],
        cancellation,
        key,
    )
    .await
    {
        Err(reason) => {
            return Recommended::Unavailable {
                grades: None,
                reason,
            };
        }
        Ok(mut judged) => match judged.remove(&LosslessString::from(name)) {
            Some(Judged::Grades(grades)) => grades,
            Some(Judged::Unsettled(reason)) => {
                return Recommended::Unavailable {
                    grades: None,
                    reason,
                };
            }
            _ => {
                return Recommended::Unavailable {
                    grades: None,
                    reason: Reason::InvalidOutput,
                };
            }
        },
    };
    let qualifying = grades
        .iter()
        .filter(|grade| {
            grade.confidence >= ANSWER_THRESHOLD && matches!(grade.choice, JsonValue::String(_))
        })
        .cloned()
        .collect::<Vec<_>>();
    if qualifying.is_empty() {
        return Recommended::Inconclusive {
            grades,
            cause: Inconclusive::LowConfidence,
        };
    }
    if !multiple {
        let best = qualifying
            .iter()
            .map(|grade| grade.confidence)
            .fold(f64::MIN, f64::max);
        let winners = qualifying
            .iter()
            .filter(|grade| grade.confidence == best)
            .collect::<Vec<_>>();
        return match winners.as_slice() {
            [winner] => Recommended::Selected {
                choices: vec![winner.choice.clone()],
                confidence: best,
                reason: "Unique best-supported option.".into(),
                grades,
            },
            _ => Recommended::Inconclusive {
                grades,
                cause: Inconclusive::Ambiguous,
            },
        };
    }
    let evidence = ObjectEncoder::new()
        .field("evidence", &state)
        .field(
            "grades",
            &JsonValue::Array(
                grades
                    .iter()
                    .map(|grade| {
                        ObjectEncoder::new()
                            .field("choice", &grade.choice)
                            .field("confidence", &grade.confidence)
                            .field("evidence", &grade.evidence)
                            .finish()
                    })
                    .collect(),
            ),
        )
        .finish();
    let analysis = judge_confident(
        evaluator,
        session,
        evidence,
        vec![text_question(
            "compatible_set",
            &format!("{instructions} Recommend one coherent compatible set of the actual option IDs. Individually high confidence does not imply that options work together. Evaluate conflicts, alternatives and dependencies across the whole set. Return only JSON with exactly recommendation (array of unique actual IDs), compatible (boolean), and reason (nonempty, at most 500 characters). Use compatible false when the evidence cannot establish a coherent set. Never treat this recommendation as approval or user authorization."),
            8192,
        )],
        cancellation,
        &format!("{key}:compatible-set"),
    )
    .await;
    let (text, selection_confidence) = match analysis {
        Err(reason) => {
            return Recommended::Unavailable {
                grades: Some(grades),
                reason,
            };
        }
        Ok(mut judged) => match judged.remove(&LosslessString::from("compatible_set")) {
            Some(Judgment {
                judged: Judged::Value(JsonValue::String(text)),
                confidence,
            }) => (text, confidence),
            Some(Judgment {
                judged: Judged::Unsettled(reason),
                ..
            }) => {
                return Recommended::Unavailable {
                    grades: Some(grades),
                    reason,
                };
            }
            _ => {
                return Recommended::Unavailable {
                    grades: Some(grades),
                    reason: Reason::InvalidOutput,
                };
            }
        },
    };
    let Some((compatible, recommendation, reason)) = compatible_set(&text) else {
        return Recommended::Unavailable {
            grades: Some(grades),
            reason: Reason::InvalidOutput,
        };
    };
    if !compatible {
        return Recommended::Inconclusive {
            grades,
            cause: Inconclusive::Incompatible,
        };
    }
    let chosen = recommendation
        .iter()
        .map(|choice| {
            qualifying
                .iter()
                .find(|grade| grade.choice == JsonValue::String(choice.clone()))
        })
        .collect::<Option<Vec<_>>>();
    let unique = recommendation
        .iter()
        .enumerate()
        .all(|(index, choice)| !recommendation[..index].contains(choice));
    let Some(chosen) = chosen.filter(|chosen| unique && !chosen.is_empty()) else {
        return Recommended::Unavailable {
            grades: Some(grades),
            reason: Reason::InvalidOutput,
        };
    };
    let confidence = chosen
        .iter()
        .map(|grade| grade.confidence)
        .fold(selection_confidence, f64::min);
    let Some(reason) = redacted_text(&reason) else {
        return Recommended::Unavailable {
            grades: Some(grades),
            reason: Reason::InvalidOutput,
        };
    };
    Recommended::Selected {
        choices: recommendation.into_iter().map(JsonValue::String).collect(),
        confidence,
        reason,
        grades,
    }
}

pub(crate) fn text_question(
    name: &str,
    instructions: &str,
    max_length: usize,
) -> ycoding_schema::JsonValue {
    ycoding_schema::ObjectEncoder::new()
        .field("type", "text")
        .field("name", name)
        .field("instructions", instructions)
        .field("maxLength", &(max_length.clamp(1, 8192) as f64))
        .finish()
}

pub(crate) fn graded_question(
    name: &str,
    instructions: &str,
    choices: Vec<ycoding_schema::JsonValue>,
) -> ycoding_schema::JsonValue {
    ycoding_schema::ObjectEncoder::new()
        .field("type", "choice")
        .field("name", name)
        .field("instructions", instructions)
        .field("grade", &true)
        .field("choices", &ycoding_schema::JsonValue::Array(choices))
        .finish()
}

pub(crate) fn predicate_question(name: &str, instructions: &str) -> ycoding_schema::JsonValue {
    ycoding_schema::ObjectEncoder::new()
        .field("type", "predicate")
        .field("name", name)
        .field("instructions", instructions)
        .finish()
}

pub(crate) fn recommended(label: &LosslessString) -> bool {
    let suffix = " (Recommended)".encode_utf16().collect::<Vec<_>>();
    label.code_units().collect::<Vec<_>>().ends_with(&suffix)
}

pub(crate) fn option_question(
    name: &str,
    instructions: &str,
    choices: Vec<ycoding_schema::JsonValue>,
) -> ycoding_schema::JsonValue {
    ycoding_schema::ObjectEncoder::new()
        .field("type", "choice")
        .field("name", name)
        .field("instructions", instructions)
        .field("choices", &ycoding_schema::JsonValue::Array(choices))
        .finish()
}

#[derive(Clone)]
pub struct Reviews {
    pub service: crate::session::review::Service,
    pub limit: usize,
}

impl Reviews {
    pub(crate) async fn defer(
        &self,
        session_id: &ycoding_schema::session_id::SessionId,
        kind: ycoding_schema::session_review::Kind,
        reason: ycoding_schema::session_review::Reason,
        origin: ycoding_schema::session_review::Origin,
        payload: ycoding_schema::session_review::Payload,
        conversion: bool,
    ) -> Result<ycoding_schema::session_review::Id, crate::session::review::Error> {
        self.service
            .open(crate::session::review::OpenInput {
                session_id: session_id.clone(),
                kind,
                reason,
                choice: None,
                confidence: None,
                grades: None,
                origin,
                payload,
                limit: self.limit,
                conversion,
                created: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock after epoch")
                    .as_millis() as i64,
            })
            .await
            .map(|item| item.deferral.item_id)
    }
}

pub(crate) fn request_origin(
    id: &impl ycoding_schema::DomainEncode,
) -> ycoding_schema::session_review::Origin {
    match id.encode() {
        ycoding_schema::JsonValue::String(request_id) => {
            ycoding_schema::session_review::Origin::Request {
                request_id,
                executor: false,
            }
        }
        _ => unreachable!("request identifiers encode as strings"),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Effect {
    Allow,
    Ask,
    Deny,
}

impl Effect {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
}

pub fn wildcard(input: &LosslessString, pattern: &LosslessString) -> bool {
    let normalize = |value: &LosslessString| {
        value
            .code_units()
            .map(|unit| if unit == 92 { 47 } else { unit })
            .collect::<Vec<_>>()
    };
    let pattern = normalize(pattern);
    let optional = pattern.ends_with(&[32, 42]);
    let pattern = if optional {
        &pattern[..pattern.len() - 2]
    } else {
        &pattern
    };
    let mut source = vec![94];
    for unit in pattern {
        match unit {
            42 => source.extend([46, 42]),
            63 => source.push(46),
            46 | 43 | 94 | 36 | 123 | 125 | 40 | 41 | 124 | 91 | 93 | 92 => {
                source.extend([92, *unit])
            }
            _ => source.push(*unit),
        }
    }
    if optional {
        source.extend("( .*)?".encode_utf16());
    }
    source.push(36);
    crate::regexp::RegExp::new(&source, if cfg!(windows) { "si" } else { "s" })
        .expect("escaped wildcard pattern")
        .test(&normalize(input), &mut crate::regexp::Budget::unlimited())
        .expect("unlimited escaped wildcard pattern")
}

pub fn evaluate(
    action: &LosslessString,
    resource: &LosslessString,
    rules: &[permission::Rule],
) -> permission::Rule {
    rules
        .iter()
        .rev()
        .find(|rule| wildcard(action, &rule.action) && wildcard(resource, &rule.resource))
        .cloned()
        .unwrap_or_else(|| permission::Rule {
            action: action.clone(),
            resource: "*".into(),
            effect: permission::Effect("ask".into()),
        })
}

pub fn decision(
    action: &LosslessString,
    resources: &[LosslessString],
    configured: &[permission::Rule],
    remembered: &[permission::Rule],
) -> Effect {
    if resources
        .iter()
        .any(|resource| evaluate(action, resource, configured).effect.0.as_str() == Some("deny"))
    {
        return Effect::Deny;
    }
    let rules = [configured, remembered].concat();
    let effects = resources
        .iter()
        .map(|resource| evaluate(action, resource, &rules).effect.0)
        .collect::<Vec<_>>();
    if effects.iter().any(|effect| effect.as_str() == Some("deny")) {
        return Effect::Deny;
    }
    if effects.iter().any(|effect| effect.as_str() == Some("ask")) {
        return Effect::Ask;
    }
    Effect::Allow
}

pub fn expand_permissions(
    rules: &[permission::Rule],
    home: &LosslessString,
) -> permission::Ruleset {
    rules
        .iter()
        .map(|rule| {
            let path_action = matches!(
                rule.action.as_str(),
                Some("read" | "edit" | "external_directory")
            );
            let units = rule.resource.code_units().collect::<Vec<_>>();
            let tail = if units == [126] || units == "$HOME".encode_utf16().collect::<Vec<_>>() {
                Some(&[][..])
            } else if units.starts_with(&[126, 47]) {
                Some(&units[1..])
            } else if units.starts_with(&"$HOME/".encode_utf16().collect::<Vec<_>>())
                || units.starts_with(&"$HOME\\".encode_utf16().collect::<Vec<_>>())
            {
                Some(&units[5..])
            } else {
                None
            };
            permission::Rule {
                resource: if path_action {
                    tail.map_or_else(
                        || rule.resource.clone(),
                        |tail| {
                            LosslessString::from_utf16(
                                home.code_units().chain(tail.iter().copied()).collect(),
                            )
                        },
                    )
                } else {
                    rule.resource.clone()
                },
                ..rule.clone()
            }
        })
        .collect()
}

#[derive(Clone, Debug, Default)]
pub struct Policy {
    statements: Vec<Statement>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyEffect {
    Allow,
    Deny,
}

#[derive(Clone, Debug)]
pub struct Statement {
    pub action: LosslessString,
    pub resource: LosslessString,
    pub effect: PolicyEffect,
}

impl Policy {
    pub fn load(&mut self, statements: Vec<Statement>) {
        self.statements = statements;
    }
    pub fn has_statements(&self) -> bool {
        !self.statements.is_empty()
    }
    pub fn evaluate(
        &self,
        action: &LosslessString,
        resource: &LosslessString,
        fallback: PolicyEffect,
    ) -> PolicyEffect {
        self.statements
            .iter()
            .rev()
            .find(|rule| wildcard(action, &rule.action) && wildcard(resource, &rule.resource))
            .map_or(fallback, |rule| rule.effect)
    }
}
