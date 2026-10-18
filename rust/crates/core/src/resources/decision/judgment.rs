use super::Error;
use ycoding_schema::{DomainDecode, JsonObject, JsonValue, LosslessString, ObjectEncoder, domain};

pub const BYTE_LIMIT: usize = 1_048_576;
#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Predicate,
    Choice(Vec<JsonValue>),
    Grade(Vec<JsonValue>),
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
                        declared(
                            question,
                            &["type", "name", "instructions", "grade", "choices"],
                        )?;
                        let graded = match question.get(&"grade".into()) {
                            None | Some(JsonValue::Bool(false)) => false,
                            Some(JsonValue::Bool(true)) => true,
                            Some(_) => return Err(Error::InvalidRequest),
                        };
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
                        if graded {
                            Kind::Grade(values)
                        } else {
                            Kind::Choice(values)
                        }
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
        ycoding_schema::stringify_json(
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
    pub fn response_schema(&self) -> JsonValue {
        object_schema([(
            "decisions",
            object_schema([
                (
                    "version",
                    enum_schema(Some("integer"), vec![JsonValue::Number(1.0)]),
                ),
                (
                    "answers",
                    ObjectEncoder::new()
                        .field("type", "array")
                        .field("minItems", &1.0)
                        .field(
                            "items",
                            &ObjectEncoder::new()
                                .field(
                                    "anyOf",
                                    &self
                                        .questions
                                        .iter()
                                        .flat_map(|question| {
                                            [question.schema(false), question.schema(true)]
                                        })
                                        .collect::<Vec<_>>(),
                                )
                                .finish(),
                        )
                        .finish(),
                ),
            ]),
        )])
    }
    pub fn parse(&self, document_text: &str) -> Result<Vec<JsonValue>, Error> {
        if document_text.len() > BYTE_LIMIT {
            return Err(Error::InvalidOutput);
        }
        let document =
            ycoding_schema::parse_json(document_text).map_err(|_| Error::InvalidOutput)?;
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
                &[
                    "name",
                    "type",
                    "answer",
                    "choice",
                    "score",
                    "confidence",
                    "grades",
                ],
            )
            .map_err(|_| Error::InvalidOutput)?;
            if object.iter().count() != 6 + usize::from(object.get(&"grades".into()).is_some())
                || ["name", "type", "answer", "choice", "score", "confidence"]
                    .iter()
                    .any(|key| object.get(&(*key).into()).is_none())
            {
                return Err(Error::InvalidOutput);
            }
            let name = text(field(object, "name").map_err(|_| Error::InvalidOutput)?, 64)
                .map_err(|_| Error::InvalidOutput)?;
            if named.insert(name, answer).is_some() {
                return Err(Error::InvalidOutput);
            }
        }
        self.questions
            .iter()
            .map(|question| {
                let value = named.get(&question.name).ok_or(Error::InvalidOutput)?;
                question.answer(value)
            })
            .collect()
    }
}
impl Question {
    fn schema(&self, refusal: bool) -> JsonValue {
        let kind = if refusal {
            "refusal"
        } else {
            match &self.kind {
                Kind::Predicate => "predicate",
                Kind::Choice(_) | Kind::Grade(_) => "choice",
                Kind::Score(_) => "score",
            }
        };
        let mut fields = vec![
            (
                "name",
                enum_schema(Some("string"), vec![JsonValue::String(self.name.clone())]),
            ),
            (
                "type",
                enum_schema(Some("string"), vec![JsonValue::String(kind.into())]),
            ),
            (
                "answer",
                type_schema(if !refusal && matches!(self.kind, Kind::Predicate) {
                    "boolean"
                } else {
                    "null"
                }),
            ),
            (
                "choice",
                match &self.kind {
                    Kind::Choice(choices) if !refusal => enum_schema(None, choices.clone()),
                    _ => type_schema("null"),
                },
            ),
            (
                "score",
                type_schema(if !refusal && matches!(self.kind, Kind::Score(_)) {
                    "integer"
                } else {
                    "null"
                }),
            ),
            (
                "confidence",
                if refusal || matches!(self.kind, Kind::Grade(_)) {
                    enum_schema(Some("number"), vec![JsonValue::Number(0.0)])
                } else {
                    type_schema("number")
                },
            ),
        ];
        if let Kind::Grade(choices) = &self.kind
            && !refusal
        {
            fields.push((
                "grades",
                ObjectEncoder::new()
                    .field("type", "array")
                    .field("minItems", &1.0)
                    .field(
                        "items",
                        &object_schema([
                            ("choice", enum_schema(None, choices.clone())),
                            ("confidence", type_schema("number")),
                            ("evidence", type_schema("string")),
                        ]),
                    )
                    .finish(),
            ));
        }
        object_schema(fields)
    }
    fn answer(&self, value: &JsonValue) -> Result<JsonValue, Error> {
        let JsonValue::Object(answer) = value else {
            return Err(Error::InvalidOutput);
        };
        let Some(JsonValue::Number(confidence)) = answer.get(&"confidence".into()) else {
            return Err(Error::InvalidOutput);
        };
        if !confidence.is_finite() || !(0.0..=1.0).contains(confidence) {
            return Err(Error::InvalidOutput);
        }
        let get = |key: &str| answer.get(&key.into()).ok_or(Error::InvalidOutput);
        let null = |key: &str| get(key).map(|value| value == &JsonValue::Null);
        let grades = answer.get(&"grades".into());
        let mut canonical = None;
        let valid = match get("type")? {
            JsonValue::String(kind) if kind.as_str() == Some("refusal") => {
                null("answer")?
                    && null("choice")?
                    && null("score")?
                    && *confidence == 0.0
                    && grades.is_none()
            }
            JsonValue::String(kind) => match &self.kind {
                Kind::Predicate => {
                    kind.as_str() == Some("predicate")
                        && matches!(get("answer")?, JsonValue::Bool(_))
                        && null("choice")?
                        && null("score")?
                        && grades.is_none()
                }
                Kind::Choice(choices) => {
                    kind.as_str() == Some("choice")
                        && null("answer")?
                        && null("score")?
                        && choices.contains(get("choice")?)
                        && grades.is_none()
                }
                Kind::Grade(choices) => {
                    canonical = grades.and_then(|grades| graded(grades, choices));
                    kind.as_str() == Some("choice")
                        && null("answer")?
                        && null("choice")?
                        && null("score")?
                        && *confidence == 0.0
                        && canonical.is_some()
                }
                Kind::Score(levels) => {
                    kind.as_str() == Some("score")
                        && null("answer")?
                        && null("choice")?
                        && matches!(get("score")?, JsonValue::Number(score) if score.is_finite() && *score >= 0.0 && score.fract() == 0.0 && *score < *levels as f64)
                        && grades.is_none()
                }
            },
            _ => false,
        };
        if !valid {
            return Err(Error::InvalidOutput);
        }
        Ok(ObjectEncoder::new()
            .field("name", get("name")?)
            .field("type", get("type")?)
            .field("answer", get("answer")?)
            .field("choice", get("choice")?)
            .field("score", get("score")?)
            .field("confidence", get("confidence")?)
            .optional("grades", &canonical.map(JsonValue::Array))
            .finish())
    }
}
fn type_schema(kind: &str) -> JsonValue {
    ObjectEncoder::new().field("type", kind).finish()
}
fn enum_schema(kind: Option<&str>, values: Vec<JsonValue>) -> JsonValue {
    let fields = ObjectEncoder::new();
    let fields = if let Some(kind) = kind {
        fields.field("type", kind)
    } else {
        fields
    };
    fields.field("enum", &values).finish()
}
fn object_schema(fields: impl IntoIterator<Item = (&'static str, JsonValue)>) -> JsonValue {
    let fields = fields.into_iter().collect::<Vec<_>>();
    ObjectEncoder::new()
        .field("type", "object")
        .field(
            "properties",
            &fields
                .iter()
                .fold(ObjectEncoder::new(), |object, (name, schema)| {
                    object.field(name, schema)
                })
                .finish(),
        )
        .field(
            "required",
            &fields
                .iter()
                .map(|(name, _)| LosslessString::from(*name))
                .collect::<Vec<_>>(),
        )
        .field("additionalProperties", &false)
        .finish()
}
fn graded(value: &JsonValue, choices: &[JsonValue]) -> Option<Vec<JsonValue>> {
    let JsonValue::Array(grades) = value else {
        return None;
    };
    if grades.len() != choices.len() {
        return None;
    }
    let mut seen = Vec::new();
    grades
        .iter()
        .map(|grade| {
            let grade = object(grade, &["choice", "confidence", "evidence"]).ok()?;
            let choice = grade.get(&"choice".into())?;
            let Some(JsonValue::Number(confidence)) = grade.get(&"confidence".into()) else {
                return None;
            };
            let Some(JsonValue::String(evidence)) = grade.get(&"evidence".into()) else {
                return None;
            };
            if !choices.contains(choice)
                || seen.contains(choice)
                || !confidence.is_finite()
                || !(0.0..=1.0).contains(confidence)
                || evidence.code_units().count() > 500
                || evidence
                    .code_units()
                    .all(crate::process::guardrails::is_whitespace)
            {
                return None;
            }
            seen.push(choice.clone());
            Some(
                ObjectEncoder::new()
                    .field("choice", choice)
                    .field("confidence", &JsonValue::Number(*confidence))
                    .field("evidence", evidence)
                    .finish(),
            )
        })
        .collect()
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
