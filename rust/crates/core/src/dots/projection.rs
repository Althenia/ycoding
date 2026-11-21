use super::access::Error;
use crate::tools::policy::forms;
use std::{collections::BTreeMap, sync::Arc};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, ObjectEncoder,
    form as contract, question,
};

pub type Answers = BTreeMap<String, Vec<String>>;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptionItem {
    pub label: String,
    pub description: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub is_other: bool,
    pub is_secret: bool,
    pub options: Option<Vec<OptionItem>>,
}
type Reader = Arc<dyn Fn(&Answers) -> Result<Read, Error> + Send + Sync>;
#[derive(Clone)]
pub struct Stage {
    pub questions: Vec<InputQuestion>,
    read: Reader,
}
pub enum Read {
    Next(Stage),
    Answer(JsonValue),
    Cancel,
}
impl Stage {
    pub fn read(&self, answers: &Answers) -> Result<Read, Error> {
        (self.read)(answers)
    }
    fn make(
        questions: Vec<InputQuestion>,
        read: impl Fn(&Answers) -> Result<Read, Error> + Send + Sync + 'static,
    ) -> Self {
        Self {
            questions,
            read: Arc::new(read),
        }
    }
}

fn invalid() -> Error {
    Error::InvalidInput
}
fn text(value: &LosslessString) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| String::from_utf16_lossy(&value.code_units().collect::<Vec<_>>()))
}
fn option(label: &str) -> OptionItem {
    OptionItem {
        label: label.into(),
        description: label.into(),
    }
}
fn input(
    id: &str,
    header: &str,
    question: &str,
    options: Option<Vec<OptionItem>>,
) -> InputQuestion {
    InputQuestion {
        id: id.into(),
        header: header.into(),
        question: question.into(),
        is_other: options.is_none(),
        is_secret: false,
        options,
    }
}
fn control(actions: &[&str]) -> InputQuestion {
    input(
        "action",
        "Action",
        "Continue, skip an optional field, or cancel this request.",
        Some(
            actions
                .iter()
                .copied()
                .chain(["Cancel request"])
                .map(option)
                .collect(),
        ),
    )
}
fn values(
    answers: &Answers,
    questions: &[InputQuestion],
    partial: bool,
) -> Result<BTreeMap<String, String>, Error> {
    if answers
        .keys()
        .any(|key| !questions.iter().any(|question| &question.id == key))
    {
        return Err(invalid());
    }
    let mut result = BTreeMap::new();
    for question in questions {
        let Some(value) = answers.get(&question.id) else {
            if partial {
                continue;
            }
            return Err(invalid());
        };
        if value.len() != 1
            || question
                .options
                .as_ref()
                .is_some_and(|options| !options.iter().any(|option| option.label == value[0]))
        {
            return Err(invalid());
        }
        result.insert(question.id.clone(), value[0].clone());
    }
    Ok(result)
}
fn action(answers: &Answers, questions: &[InputQuestion]) -> Result<String, Error> {
    values(answers, questions, true)?
        .remove("action")
        .ok_or_else(invalid)
}
fn map(
    stage: Stage,
    convert: Arc<dyn Fn(JsonValue) -> Result<JsonValue, Error> + Send + Sync>,
) -> Stage {
    Stage::make(stage.questions.clone(), move |answers| {
        match stage.read(answers)? {
            Read::Next(stage) => Ok(Read::Next(map(stage, convert.clone()))),
            Read::Answer(value) => convert(value).map(Read::Answer),
            Read::Cancel => Ok(Read::Cancel),
        }
    })
}
type Finish = Arc<dyn Fn(JsonValue) -> Result<Read, Error> + Send + Sync>;
fn exact_text(header: &str, finish: Finish) -> Stage {
    let questions = vec![
        input(
            "value",
            header,
            "Encode whitespace as \\s (space), \\t, \\n, \\r, or \\uXXXX; encode a backslash as \\\\. Do not enter literal whitespace.",
            None,
        ),
        control(&["Continue"]),
    ];
    Stage::make(questions.clone(), move |answers| {
        if action(answers, &questions)? == "Cancel request" {
            return Ok(Read::Cancel);
        }
        let values = values(answers, &questions, false)?;
        let encoded = &values["value"];
        if encoded.chars().any(char::is_whitespace) {
            return Err(invalid());
        }
        let mut result = Vec::new();
        let mut units = encoded.encode_utf16();
        while let Some(unit) = units.next() {
            if unit != u16::from(b'\\') {
                result.push(unit);
                continue;
            }
            result.push(match units.next().ok_or_else(invalid)? {
                117 => {
                    let hex = units.by_ref().take(4).collect::<Vec<_>>();
                    if hex.len() != 4
                        || hex
                            .iter()
                            .any(|unit| !matches!(*unit, 48..=57 | 65..=70 | 97..=102))
                    {
                        return Err(invalid());
                    }
                    u16::from_str_radix(&String::from_utf16_lossy(&hex), 16)
                        .map_err(|_| invalid())?
                }
                115 => 32,
                116 => 9,
                110 => 10,
                114 => 13,
                92 => 92,
                _ => return Err(invalid()),
            });
        }
        finish(JsonValue::String(LosslessString::from_utf16(result)))
    })
}

pub fn form(title: &str, fields: contract::Fields) -> Result<Stage, Error> {
    forms::validate_fields(&fields.0).map_err(|_| invalid())?;
    let info = Arc::new(
        contract::Info::decode(
            &ObjectEncoder::new()
                .field("id", "frm_native_projection")
                .field("sessionID", "global")
                .field("title", title)
                .field("fields", &fields)
                .finish(),
        )
        .map_err(|_| invalid())?,
    );
    match advance(info, 0, contract::Answer(JsonObject::new()))? {
        Read::Next(stage) => Ok(stage),
        Read::Answer(value) => {
            let questions = vec![control(&["Continue"])];
            Ok(Stage::make(
                questions.clone(),
                move |answers| match action(answers, &questions)?.as_str() {
                    "Continue" => Ok(Read::Answer(value.clone())),
                    "Cancel request" => Ok(Read::Cancel),
                    _ => Err(invalid()),
                },
            ))
        }
        Read::Cancel => Err(invalid()),
    }
}
fn advance(
    info: Arc<contract::Info>,
    index: usize,
    answer: contract::Answer,
) -> Result<Read, Error> {
    for cursor in index..info.fields.0.len() {
        let field = &info.fields.0[cursor];
        if !forms::active(field, &answer) {
            continue;
        }
        let key = match field {
            contract::Field::External(value) => value.key.clone(),
            _ => base(field).ok_or_else(invalid)?.key.clone(),
        };
        let next_info = info.clone();
        let done = Arc::new(move |value: Option<JsonValue>| {
            let mut answer = answer.clone();
            if let Some(value) = value {
                answer.0.insert(key.clone(), value);
            }
            advance(next_info.clone(), cursor + 1, answer)
        });
        return Ok(Read::Next(field_stage(
            &text(&info.title),
            field.clone(),
            done,
        )));
    }
    forms::validate_answer(&info, &answer).map_err(|_| invalid())?;
    Ok(Read::Answer(answer.encode()))
}
fn base(field: &contract::Field) -> Option<&contract::Base> {
    match field {
        contract::Field::String(field) => Some(&field.base),
        contract::Field::Number(field) => Some(&field.base),
        contract::Field::Integer(field) => Some(&field.base),
        contract::Field::Boolean(field) => Some(&field.base),
        contract::Field::Multiselect(field) => Some(&field.base),
        contract::Field::External(_) => None,
    }
}
type Done = Arc<dyn Fn(Option<JsonValue>) -> Result<Read, Error> + Send + Sync>;
fn field_stage(title: &str, field: contract::Field, done: Done) -> Stage {
    let optional = base(&field).is_some_and(|base| base.required != Some(true));
    let custom = match &field {
        contract::Field::String(field) => field.options.is_some() && field.custom == Some(true),
        contract::Field::Multiselect(field) => field.custom == Some(true),
        _ => false,
    };
    let free = matches!(&field, contract::Field::String(field) if field.options.is_none() || field.custom == Some(true));
    let empty = matches!(&field, contract::Field::String(_))
        && forms::validate_field(&field, &JsonValue::String("".into())).is_ok();
    let mut actions = vec!["Continue"];
    if optional {
        actions.push("Skip field");
    }
    if custom {
        actions.push("Custom answer");
    }
    if free {
        actions.push("Exact text");
    }
    if empty {
        actions.push("Empty value");
    }
    let encoded = field.encode();
    let JsonValue::Object(encoded) = encoded else {
        unreachable!()
    };
    let header = encoded
        .get(&"title".into())
        .or_else(|| encoded.get(&"key".into()))
        .and_then(|value| {
            if let JsonValue::String(value) = value {
                Some(text(value))
            } else {
                None
            }
        })
        .unwrap_or_default();
    let description = [
        "description",
        "url",
        "type",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "format",
        "pattern",
    ]
    .iter()
    .filter_map(|key| {
        encoded.get(&(*key).into()).map(|value| {
            format!(
                "{key}: {}",
                match value {
                    JsonValue::String(value) => text(value),
                    _ => ycoding_schema::stringify_json(value),
                }
            )
        })
    })
    .collect::<Vec<_>>()
    .join("\n");
    let finish_field = field.clone();
    let skip = done.clone();
    let finish: Finish = Arc::new(move |value| {
        forms::validate_field(&finish_field, &value).map_err(|_| invalid())?;
        done(Some(value))
    });
    let labels = match &field {
        contract::Field::String(field) => field.options.as_ref().map(|options| {
            options
                .iter()
                .enumerate()
                .map(|(index, option)| format!("{}. {}", index + 1, text(&option.label).trim()))
                .collect::<Vec<_>>()
        }),
        _ => None,
    };
    let mut questions = match &field {
        contract::Field::Multiselect(field) => field
            .options
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                input(
                    &format!("option:{index}"),
                    &header,
                    &format!(
                        "{title}\n{}\n{}",
                        text(&entry.label),
                        entry.description.as_ref().map(text).unwrap_or_default()
                    ),
                    Some(vec![option("Select"), option("Do not select")]),
                )
            })
            .collect::<Vec<_>>(),
        _ => vec![input(
            "value",
            &header,
            &format!("{title}\n{description}"),
            match &field {
                contract::Field::Boolean(_) => Some(vec![option("True"), option("False")]),
                contract::Field::External(_) => Some(vec![option("Acknowledged")]),
                contract::Field::String(field) => field.options.as_ref().map(|options| {
                    options
                        .iter()
                        .enumerate()
                        .map(|(index, entry)| OptionItem {
                            label: labels.as_ref().expect("string option labels")[index].clone(),
                            description: text(entry.description.as_ref().unwrap_or(&entry.label)),
                        })
                        .collect()
                }),
                _ => None,
            },
        )],
    };
    questions.push(control(&actions));
    Stage::make(questions.clone(), move |answers| {
        let action = action(answers, &questions)?;
        if action == "Cancel request" {
            return Ok(Read::Cancel);
        }
        if action == "Skip field" && optional {
            return skip(None);
        }
        if action == "Exact text" && free {
            return Ok(Read::Next(exact_text(&header, finish.clone())));
        }
        if action == "Empty value" && empty {
            return finish(JsonValue::String("".into()));
        }
        if action == "Custom answer" && custom && matches!(field, contract::Field::String(_)) {
            return Ok(Read::Next(custom_stage(
                &header,
                &description,
                None,
                empty,
                finish.clone(),
            )));
        }
        let values = values(answers, &questions, false)?;
        if let contract::Field::Multiselect(field) = &field {
            let selected = field
                .options
                .iter()
                .enumerate()
                .filter(|(index, _)| values[&format!("option:{index}")] == "Select")
                .map(|(_, option)| JsonValue::String(option.value.clone()))
                .collect::<Vec<_>>();
            if action == "Custom answer" && custom {
                return Ok(Read::Next(custom_stage(
                    &header,
                    &description,
                    Some(selected),
                    true,
                    finish.clone(),
                )));
            }
            if action != "Continue" {
                return Err(invalid());
            }
            return finish(JsonValue::Array(selected));
        }
        if action != "Continue" {
            return Err(invalid());
        }
        let value = &values["value"];
        finish(match &field {
            contract::Field::External(_) => JsonValue::Bool(true),
            contract::Field::Boolean(_) => JsonValue::Bool(value == "True"),
            contract::Field::String(field) => JsonValue::String(match &field.options {
                Some(options) => options[labels
                    .as_ref()
                    .expect("string option labels")
                    .iter()
                    .position(|label| label == value)
                    .ok_or_else(invalid)?]
                .value
                .clone(),
                None => value.as_str().into(),
            }),
            _ => {
                if value.is_empty()
                    || value.chars().any(char::is_whitespace)
                    || !value.chars().all(|value| {
                        value.is_ascii_digit() || matches!(value, '+' | '-' | '.' | 'e' | 'E')
                    })
                {
                    return Err(invalid());
                }
                let value = value.parse::<f64>().map_err(|_| invalid())?;
                if !value.is_finite() {
                    return Err(invalid());
                }
                JsonValue::Number(value)
            }
        })
    })
}
fn custom_stage(
    header: &str,
    description: &str,
    selected: Option<Vec<JsonValue>>,
    empty: bool,
    finish: Finish,
) -> Stage {
    let mut actions = if selected.is_some() {
        vec!["Add value", "Finish"]
    } else {
        vec!["Continue"]
    };
    actions.push("Exact text");
    if empty {
        actions.push("Empty value");
    }
    let questions = vec![input("value", header, description, None), control(&actions)];
    let header = header.to_owned();
    let description = description.to_owned();
    Stage::make(questions.clone(), move |answers| {
        let action = action(answers, &questions)?;
        if action == "Cancel request" {
            return Ok(Read::Cancel);
        }
        if action == "Finish"
            && let Some(selected) = &selected
        {
            return finish(JsonValue::Array(selected.clone()));
        }
        let current = selected.clone();
        let next_finish = finish.clone();
        let next_header = header.clone();
        let next_description = description.clone();
        let add: Finish = Arc::new(move |value| match &current {
            Some(selected) => {
                if selected.contains(&value) {
                    return Err(invalid());
                }
                let mut selected = selected.clone();
                selected.push(value);
                Ok(Read::Next(custom_stage(
                    &next_header,
                    &next_description,
                    Some(selected),
                    true,
                    next_finish.clone(),
                )))
            }
            None => next_finish(value),
        });
        if action == "Exact text" {
            return Ok(Read::Next(exact_text(&header, add)));
        }
        if action == "Empty value" && empty {
            return add(JsonValue::String("".into()));
        }
        let values = values(answers, &questions, false)?;
        add(JsonValue::String(values["value"].as_str().into()))
    })
}

pub fn questions(items: &[question::Info]) -> Result<Stage, Error> {
    if items.is_empty() {
        let questions = vec![control(&["Continue"])];
        return Ok(Stage::make(
            questions.clone(),
            move |answers| match action(answers, &questions)?.as_str() {
                "Cancel request" => Ok(Read::Cancel),
                "Continue" => Ok(Read::Answer(JsonValue::Array(vec![]))),
                _ => Err(invalid()),
            },
        ));
    }
    let fields = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let options = item
                .options
                .iter()
                .map(|option| {
                    ObjectEncoder::new()
                        .field("label", &option.label)
                        .field("description", &option.description)
                        .field("value", &option.label)
                        .finish()
                })
                .collect::<Vec<_>>();
            let mut field = ObjectEncoder::new()
                .field("key", format!("question:{index}").as_str())
                .field("title", &item.header)
                .field("description", &item.question)
                .field("custom", &(item.custom != Some(false)))
                .field(
                    "type",
                    if item.multiple == Some(true) {
                        "multiselect"
                    } else {
                        "string"
                    },
                );
            if item.multiple == Some(true) || !item.options.is_empty() || item.custom == Some(false)
            {
                field = field.field("options", &options);
            }
            contract::Field::decode(&field.finish()).map_err(|_| invalid())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let count = items.len();
    Ok(map(
        form("Question", contract::Fields(fields))?,
        Arc::new(move |value| {
            let JsonValue::Object(answer) = value else {
                return Err(invalid());
            };
            Ok(JsonValue::Array(
                (0..count)
                    .map(
                        |index| match answer.get(&format!("question:{index}").into()) {
                            None => JsonValue::Array(vec![]),
                            Some(JsonValue::String(value)) => {
                                JsonValue::Array(vec![JsonValue::String(value.clone())])
                            }
                            Some(value) => value.clone(),
                        },
                    )
                    .collect(),
            ))
        }),
    ))
}
pub fn child(text: &str) -> Stage {
    let questions = vec![
        input("value", "Child question", text, None),
        control(&["Continue", "Exact text", "Skip field"]),
    ];
    Stage::make(questions.clone(), move |answers| {
        match action(answers, &questions)?.as_str() {
            "Cancel request" => Ok(Read::Cancel),
            "Skip field" => Ok(Read::Next(child_data(None))),
            "Exact text" => Ok(Read::Next(exact_text(
                "Child question",
                Arc::new(|value| match value {
                    JsonValue::String(value) => Ok(Read::Next(child_data(Some(value)))),
                    _ => Err(invalid()),
                }),
            ))),
            "Continue" => {
                let values = values(answers, &questions, false)?;
                if values["value"].trim().is_empty() {
                    return Err(invalid());
                }
                Ok(Read::Next(child_data(Some(
                    values["value"].as_str().into(),
                ))))
            }
            _ => Err(invalid()),
        }
    })
}
fn child_data(text: Option<LosslessString>) -> Stage {
    let questions = vec![
        input(
            "value",
            "Structured answer",
            "Enter the JSON-valued answer data.",
            None,
        ),
        control(&["Continue", "Skip field"]),
    ];
    Stage::make(questions.clone(), move |answers| {
        let action = action(answers, &questions)?;
        if action == "Cancel request" {
            return Ok(Read::Cancel);
        }
        let mut answer = ObjectEncoder::new().optional("text", &text);
        if action == "Skip field" {
            if text.is_none() {
                return Err(invalid());
            }
        } else {
            answer = answer.field(
                "data",
                &ycoding_schema::parse_json(&values(answers, &questions, false)?["value"])
                    .map_err(|_| invalid())?,
            );
        }
        Ok(Read::Answer(answer.finish()))
    })
}
pub fn approval(text: &str) -> Stage {
    let questions = vec![input(
        "answer",
        "Approval",
        text,
        Some(vec![
            OptionItem {
                label: "Allow once".into(),
                description: "Allow this exact pending operation once".into(),
            },
            OptionItem {
                label: "Reject".into(),
                description: "Reject this pending operation".into(),
            },
        ]),
    )];
    Stage::make(questions.clone(), move |answers| {
        let values = values(answers, &questions, false)?;
        let reply = match values["answer"].as_str() {
            "Allow once" => "once",
            "Reject" => "reject",
            _ => return Err(invalid()),
        };
        Ok(Read::Answer(
            ObjectEncoder::new().field("reply", reply).finish(),
        ))
    })
}
pub fn recovery() -> Stage {
    let questions = vec![input(
        "answer",
        "Recovery",
        "Continue or stop the interrupted operation?",
        Some(vec![option("Continue"), option("Stop")]),
    )];
    Stage::make(questions.clone(), move |answers| {
        let values = values(answers, &questions, false)?;
        Ok(Read::Answer(JsonValue::String(
            values["answer"].as_str().into(),
        )))
    })
}
