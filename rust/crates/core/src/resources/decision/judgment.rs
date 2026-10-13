use super::{Error, toon};
use ycoding_schema::{DomainDecode, JsonObject, JsonValue, LosslessString, ObjectEncoder, domain};

pub const BYTE_LIMIT: usize = 1_048_576;
#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Predicate,
    Choice(Vec<JsonValue>),
    Score(usize),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Question {
    pub name: LosslessString,
    pub kind: Kind,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub value: JsonValue,
    pub questions: Vec<Question>,
}
impl Request {
    pub fn decode(value: &JsonValue) -> Result<Self, Error> {
        let input = object(value, &["state", "questions"])?;
        domain::Json::decode(field(input, "state")?).map_err(|_| Error::InvalidRequest)?;
        let JsonValue::Array(questions) = field(input, "questions")? else {
            return Err(Error::InvalidRequest);
        };
        if !(1..=32).contains(&questions.len()) {
            return Err(Error::InvalidRequest);
        }
        let mut names = std::collections::BTreeSet::new();
        let questions = questions
            .iter()
            .map(|question| {
                let JsonValue::Object(question) = question else {
                    return Err(Error::InvalidRequest);
                };
                let name = text(field(question, "name")?, 64)?;
                text(field(question, "instructions")?, 8192)?;
                if !names.insert(name.clone()) {
                    return Err(Error::InvalidRequest);
                }
                let kind = match field(question, "type")? {
                    JsonValue::String(kind) if kind.as_str() == Some("predicate") => {
                        declared(question, &["type", "name", "instructions"])?;
                        Kind::Predicate
                    }
                    JsonValue::String(kind) if kind.as_str() == Some("choice") => {
                        declared(question, &["type", "name", "instructions", "choices"])?;
                        let JsonValue::Array(choices) = field(question, "choices")? else {
                            return Err(Error::InvalidRequest);
                        };
                        if !(1..=255).contains(&choices.len()) {
                            return Err(Error::InvalidRequest);
                        }
                        let values = choices
                            .iter()
                            .map(|choice| {
                                let choice = object(choice, &["value", "description"])?;
                                let value = field(choice, "value")?;
                                if !matches!(value, JsonValue::String(_) | JsonValue::Bool(_)) {
                                    return Err(Error::InvalidRequest);
                                }
                                if let Some(description) = choice.get(&"description".into()) {
                                    text(description, 8192)?;
                                }
                                Ok(value.clone())
                            })
                            .collect::<Result<Vec<_>, _>>()?;
                        if values
                            .iter()
                            .enumerate()
                            .any(|(index, value)| values[..index].contains(value))
                        {
                            return Err(Error::InvalidRequest);
                        }
                        Kind::Choice(values)
                    }
                    JsonValue::String(kind) if kind.as_str() == Some("score") => {
                        declared(question, &["type", "name", "instructions", "levels"])?;
                        let JsonValue::Array(levels) = field(question, "levels")? else {
                            return Err(Error::InvalidRequest);
                        };
                        if !(2..=10).contains(&levels.len()) {
                            return Err(Error::InvalidRequest);
                        }
                        for level in levels {
                            let level = object(level, &["label", "description"])?;
                            text(field(level, "label")?, 8192)?;
                            if let Some(description) = level.get(&"description".into()) {
                                text(description, 8192)?;
                            }
                        }
                        Kind::Score(levels.len())
                    }
                    _ => return Err(Error::InvalidRequest),
                };
                Ok(Question { name, kind })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            value: value.clone(),
            questions,
        })
    }
    pub fn template(&self) -> String {
        toon::encode(
            &ObjectEncoder::new()
                .field(
                    "decisions",
                    &ObjectEncoder::new()
                        .field("version", &1.0)
                        .field(
                            "answers",
                            &self
                                .questions
                                .iter()
                                .map(|question| {
                                    ObjectEncoder::new()
                                        .field("name", &question.name)
                                        .field("type", "refusal")
                                        .field("answer", &JsonValue::Null)
                                        .field("choice", &JsonValue::Null)
                                        .field("score", &JsonValue::Null)
                                        .field("confidence", &0.0)
                                        .finish()
                                })
                                .collect::<Vec<_>>(),
                        )
                        .finish(),
                )
                .finish(),
        )
    }
    pub fn parse(&self, document_text: &str) -> Result<Vec<JsonValue>, Error> {
        if document_text.len() > BYTE_LIMIT {
            return Err(Error::InvalidOutput);
        }
        let document = toon::decode(document_text).map_err(|_| Error::InvalidOutput)?;
        let root = object(&document, &["decisions"]).map_err(|_| Error::InvalidOutput)?;
        let decisions = object(
            field(root, "decisions").map_err(|_| Error::InvalidOutput)?,
            &["version", "answers"],
        )
        .map_err(|_| Error::InvalidOutput)?;
        if decisions.get(&"version".into()) != Some(&JsonValue::Number(1.0)) {
            return Err(Error::InvalidOutput);
        }
        let Some(JsonValue::Array(answers)) = decisions.get(&"answers".into()) else {
            return Err(Error::InvalidOutput);
        };
        if answers.len() != self.questions.len() {
            return Err(Error::InvalidOutput);
        }
        let mut named = std::collections::BTreeMap::new();
        for answer in answers {
            let object = object(
                answer,
                &["name", "type", "answer", "choice", "score", "confidence"],
            )
            .map_err(|_| Error::InvalidOutput)?;
            if object.iter().count() != 6 {
                return Err(Error::InvalidOutput);
            }
            let name = text(field(object, "name").map_err(|_| Error::InvalidOutput)?, 64)
                .map_err(|_| Error::InvalidOutput)?;
            if named.insert(name, answer).is_some() {
                return Err(Error::InvalidOutput);
            }
        }
        self.questions.iter().map(|question| {
            let value = named.get(&question.name).ok_or(Error::InvalidOutput)?;
            let JsonValue::Object(answer) = value else {return Err(Error::InvalidOutput);};
            let Some(JsonValue::Number(confidence)) = answer.get(&"confidence".into()) else {return Err(Error::InvalidOutput);};
            if !confidence.is_finite() || !(0.0..=1.0).contains(confidence) {return Err(Error::InvalidOutput);}
            let get = |key: &str| answer.get(&key.into()).ok_or(Error::InvalidOutput);
            let valid = match get("type")? {
                JsonValue::String(kind) if kind.as_str() == Some("refusal") => get("answer")? == &JsonValue::Null && get("choice")? == &JsonValue::Null && get("score")? == &JsonValue::Null && *confidence == 0.0,
                JsonValue::String(kind) => match &question.kind {
                    Kind::Predicate => kind.as_str() == Some("predicate") && matches!(get("answer")?, JsonValue::Bool(_)) && get("choice")? == &JsonValue::Null && get("score")? == &JsonValue::Null,
                    Kind::Choice(choices) => kind.as_str() == Some("choice") && get("answer")? == &JsonValue::Null && get("score")? == &JsonValue::Null && choices.contains(get("choice")?),
                    Kind::Score(levels) => kind.as_str() == Some("score") && get("answer")? == &JsonValue::Null && get("choice")? == &JsonValue::Null && matches!(get("score")?, JsonValue::Number(score) if score.is_finite() && *score >= 0.0 && score.fract() == 0.0 && *score < *levels as f64),
                },
                _ => false,
            };
            if !valid {return Err(Error::InvalidOutput);}
            Ok(ObjectEncoder::new().field("name", get("name")?).field("type", get("type")?).field("answer", get("answer")?).field("choice", get("choice")?).field("score", get("score")?).field("confidence", get("confidence")?).finish())
        }).collect()
    }
}
fn object<'a>(value: &'a JsonValue, fields: &[&str]) -> Result<&'a JsonObject, Error> {
    let JsonValue::Object(value) = value else {
        return Err(Error::InvalidRequest);
    };
    declared(value, fields)?;
    Ok(value)
}
fn declared(value: &JsonObject, fields: &[&str]) -> Result<(), Error> {
    if value
        .iter()
        .any(|(key, _)| !key.as_str().is_some_and(|key| fields.contains(&key)))
    {
        Err(Error::InvalidRequest)
    } else {
        Ok(())
    }
}
fn field<'a>(object: &'a JsonObject, key: &str) -> Result<&'a JsonValue, Error> {
    object.get(&key.into()).ok_or(Error::InvalidRequest)
}
fn text(value: &JsonValue, limit: usize) -> Result<LosslessString, Error> {
    let JsonValue::String(text) = value else {
        return Err(Error::InvalidRequest);
    };
    (1..=limit)
        .contains(&text.code_units().count())
        .then(|| text.clone())
        .ok_or(Error::InvalidRequest)
}
