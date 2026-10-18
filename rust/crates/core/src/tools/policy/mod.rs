pub mod ceiling;
pub mod forms;
pub mod helper;
pub mod permissions;
pub mod questions;
pub(crate) mod state;
pub mod timeout;
pub use state::{Authority, Error, Event, Publisher, SessionAuthority, Wait};

use ycoding_schema::{LosslessString, permission};

pub(crate) async fn answer_options(
    evaluator: &dyn crate::process::guardrails::decision::Evaluator,
    session: &ycoding_schema::session::Id,
    evidence: ycoding_schema::JsonValue,
    questions: Vec<ycoding_schema::JsonValue>,
    cancellation: &crate::tools::code_mode::Cancellation,
) -> Result<ycoding_schema::JsonObject, ycoding_schema::session_review::Reason> {
    use ycoding_schema::{JsonObject, JsonValue, ObjectEncoder, session_review::Reason};
    if questions.is_empty() {
        return Err(Reason::FreeText);
    }
    if questions.len() > 32 {
        return Err(Reason::Error);
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
    // Validation rejects distinct original options that collapse to one redacted value.
    crate::resources::decision::judgment::Request::decode(&request).map_err(|_| Reason::Error)?;
    let input = ObjectEncoder::new()
        .field("provider", "agent")
        .field("request", &request)
        .finish();
    if ycoding_schema::stringify_json(&input).len()
        > crate::resources::decision::judgment::BYTE_LIMIT
    {
        return Err(Reason::Error);
    }
    let response = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(Reason::Error),
        result = tokio::time::timeout(std::time::Duration::from_secs(60), evaluator.evaluate(input, crate::resources::decision::Invocation {
            session_id: session,
            input_id: None,
            cancellation,
            attribution: crate::session::usage_attribution::Attribution::Unset,
        })) => result.map_err(|_| Reason::Timeout)?.map_err(|_| Reason::Error)?,
    };
    let JsonValue::Object(response) = response else {
        return Err(Reason::Error);
    };
    let Some(JsonValue::Object(response)) = response.get(&"response".into()) else {
        return Err(Reason::Error);
    };
    let Some(JsonValue::Array(answers)) = response.get(&"answers".into()) else {
        return Err(Reason::Error);
    };
    if answers.len() != questions.len() {
        return Err(Reason::Error);
    }
    let mut result = JsonObject::new();
    for (question, redacted_question) in questions.into_iter().zip(redacted_questions) {
        let (JsonValue::Object(question), JsonValue::Object(redacted_question)) =
            (question, redacted_question)
        else {
            return Err(Reason::Error);
        };
        let Some(JsonValue::String(name)) = question.get(&"name".into()) else {
            return Err(Reason::Error);
        };
        let Some(JsonValue::String(redacted_name)) = redacted_question.get(&"name".into()) else {
            return Err(Reason::Error);
        };
        let matching = answers
            .iter()
            .filter_map(|answer| match answer {
                JsonValue::Object(answer)
                    if answer.get(&"name".into())
                        == Some(&JsonValue::String(redacted_name.clone())) =>
                {
                    Some(answer)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        if matching.len() != 1 {
            return Err(Reason::Error);
        }
        let answer = matching[0];
        if answer.get(&"type".into()) == Some(&JsonValue::String("refusal".into())) {
            return Err(Reason::Refused);
        }
        if !matches!(answer.get(&"confidence".into()), Some(JsonValue::Number(value)) if value.is_finite() && *value >= 0.8 && *value <= 1.0)
        {
            return Err(Reason::LowConfidence);
        }
        let Some(choice) = answer.get(&"choice".into()) else {
            return Err(Reason::Error);
        };
        if answer.get(&"type".into()) != Some(&JsonValue::String("choice".into())) {
            return Err(Reason::Error);
        }
        let (Some(JsonValue::Array(choices)), Some(JsonValue::Array(redacted_choices))) = (
            question.get(&"choices".into()),
            redacted_question.get(&"choices".into()),
        ) else {
            return Err(Reason::Error);
        };
        let Some(index) = redacted_choices.iter().position(|entry| matches!(entry, JsonValue::Object(entry) if entry.get(&"value".into()) == Some(choice))) else { return Err(Reason::Error) };
        let Some(JsonValue::Object(original)) = choices.get(index) else {
            return Err(Reason::Error);
        };
        result.insert(
            name.clone(),
            original.get(&"value".into()).ok_or(Reason::Error)?.clone(),
        );
    }
    Ok(result)
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
            ycoding_schema::session_review::Origin::Request { request_id }
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
