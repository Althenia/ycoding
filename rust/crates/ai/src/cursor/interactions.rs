use super::protobuf::{self, Field};
use crate::{
    Error, json,
    llm::{ToolResult, ToolResultValue},
};
use ycoding_schema::{JsonValue, LosslessString};

pub(crate) enum Action {
    Reply(Vec<u8>),
    Question(Question),
}
pub(crate) struct Question {
    pub id: u32,
    pub asynchronous: bool,
    raw_args: Vec<u8>,
    call_id: String,
    title: String,
    questions: Vec<Item>,
}
struct Item {
    id: String,
    prompt: String,
    options: Vec<(String, String)>,
    multiple: bool,
}
pub(crate) fn query(
    bytes: &[u8],
    can_question: bool,
    can_save_image: bool,
) -> Result<Action, Error> {
    let fields = protobuf::fields(bytes)?;
    let id = fields
        .iter()
        .rev()
        .find(|field| field.number == 1)
        .map(|field| field.uint32())
        .transpose()?
        .unwrap_or(0);
    let variants = fields
        .iter()
        .filter(|field| field.number != 1)
        .collect::<Vec<_>>();
    if variants.len() != 1 {
        return Err(Error::output(
            "Cursor interaction requires exactly one known query variant",
        ));
    }
    let variant = variants[0];
    let body = variant.bytes()?;
    if variant.number == 12 {
        let description = protobuf::fields(body)
            .and_then(|body| {
                body.iter()
                    .rev()
                    .find(|field| field.number == 1)
                    .map(|field| field.bytes())
                    .transpose()?
                    .map(protobuf::fields)
                    .transpose()?
                    .map(|args| text(&args, 1))
                    .transpose()
                    .map(|value| value.unwrap_or_default())
            })
            .unwrap_or_default();
        let result = if description.is_empty() {
            rejected(2, "Missing generate image arguments")?
        } else if !can_save_image {
            rejected(
                2,
                "This OpenCode agent cannot save a generated image, so generating one would produce nothing. Describe the image in your reply instead.",
            )?
        } else {
            let mut approved = Vec::new();
            protobuf::write_string(&mut approved, 1, &description.into())?;
            wrap(1, &approved)?
        };
        return Ok(Action::Reply(response(id, 12, &result)?));
    }
    if variant.number == 3 {
        let body = protobuf::fields(body)?;
        let Some(args) = body.iter().rev().find(|field| field.number == 1) else {
            return Ok(Action::Reply(question_rejection(
                id,
                "Missing ask-question arguments",
            )?));
        };
        let raw_args = args.bytes()?.to_vec();
        let args = protobuf::fields(&raw_args)?;
        let mut questions = Vec::new();
        for question in args.iter().filter(|field| field.number == 2) {
            let fields = protobuf::fields(question.bytes()?)?;
            let prompt = text(&fields, 2)?;
            if prompt.is_empty() {
                continue;
            }
            let mut options = Vec::new();
            for option in fields.iter().filter(|field| field.number == 3) {
                let option = protobuf::fields(option.bytes()?)?;
                let label = text(&option, 2)?;
                if !label.is_empty() {
                    options.push((text(&option, 1)?, label));
                }
            }
            if options.last().is_some_and(|option| catch_all(&option.1)) {
                options.pop();
            }
            questions.push(Item {
                id: text(&fields, 1)?,
                prompt,
                options,
                multiple: boolean(&fields, 4)?,
            });
        }
        if questions.is_empty() {
            return Ok(Action::Reply(question_rejection(
                id,
                "Missing ask-question arguments",
            )?));
        }
        if !can_question {
            return Ok(Action::Reply(question_rejection(
                id,
                "The OpenCode `question` tool is not available to the current agent, so questions cannot be shown to the user this turn. State the question in your reply instead.",
            )?));
        }
        return Ok(Action::Question(Question {
            id,
            asynchronous: boolean(&args, 5)?,
            title: text(&args, 1)?,
            questions,
            raw_args,
            call_id: text(&body, 2)?,
        }));
    }
    let reason = "This Cursor interaction requires UI approval and is not available through the OpenCode provider.";
    let result = match variant.number {
        2 | 9 | 11 | 14 => rejected(2, reason)?,
        10 => rejected(3, reason)?,
        8 => wrap(1, &[])?,
        13 => {
            let mut failure = Vec::new();
            protobuf::write_string(
                &mut failure,
                1,
                &"Environment replacement is not supported by the OpenCode provider.".into(),
            )?;
            protobuf::write_string(&mut failure, 2, &"".into())?;
            wrap(2, &failure)?
        }
        _ => {
            return Err(Error::output(
                "Cursor interaction query has no supported host bridge",
            ));
        }
    };
    Ok(Action::Reply(response(id, variant.number, &result)?))
}
impl Question {
    pub fn input(&self) -> JsonValue {
        let title = self.title.trim();
        let header = if title.is_empty() {
            "Question".into()
        } else if title.encode_utf16().count() > 30 {
            let mut units = title.encode_utf16().take(29).collect::<Vec<_>>();
            while units.last().is_some_and(|unit| {
                char::from_u32(u32::from(*unit)).is_some_and(char::is_whitespace)
            }) {
                units.pop();
            }
            units.push(0x2026);
            LosslessString::from_utf16(units)
        } else {
            title.into()
        };
        json::object([(
            "questions",
            JsonValue::Array(
                self.questions
                    .iter()
                    .map(|question| {
                        let mut input = json::object([
                            ("question", json::s(question.prompt.as_str())),
                            ("header", json::s(header.clone())),
                            (
                                "options",
                                JsonValue::Array(
                                    question
                                        .options
                                        .iter()
                                        .map(|option| {
                                            json::object([
                                                ("label", json::s(option.1.as_str())),
                                                ("description", json::s("")),
                                            ])
                                        })
                                        .collect(),
                                ),
                            ),
                        ]);
                        if question.multiple {
                            json::set(&mut input, "multiple", JsonValue::Bool(true));
                        }
                        input
                    })
                    .collect(),
            ),
        )])
    }
    pub fn acknowledgement(&self) -> Result<Vec<u8>, Error> {
        response(self.id, 3, &wrap(1, &wrap(4, &[])?)?)
    }
    pub fn answer(&self, result: &ToolResult) -> Result<Vec<u8>, Error> {
        let output = result
            .result
            .to_text()
            .to_utf8()
            .map_err(|_| Error::output("Cursor question result is not Unicode text"))?;
        let result =
            if matches!(result.result, ToolResultValue::Error(_)) {
                rejected(
                    3,
                    if output.trim().is_empty() {
                        "Ask-question prompt dismissed"
                    } else {
                        output.trim()
                    },
                )?
            } else {
                let mut success = Vec::new();
                let mut cursor = 0;
                for question in &self.questions {
                    let mut answer = Vec::new();
                    protobuf::write_string(&mut answer, 1, &question.id.clone().into())?;
                    let anchor = format!("\"{}\"=\"", question.prompt);
                    let segment = output[cursor..].find(&anchor).and_then(|start| {
                        let start = cursor + start + anchor.len();
                        let end = self
                            .questions
                            .iter()
                            .filter_map(|question| {
                                output[start..]
                                    .find(&format!("\"{}\"=\"", question.prompt))
                                    .filter(|index| *index > 0)
                                    .map(|index| start + index)
                            })
                            .min()
                            .unwrap_or(output.len());
                        let end = output[..end].rfind('"').filter(|end| *end >= start)?;
                        cursor = end;
                        Some(&output[start..end])
                    });
                    if let Some(segment) = segment.filter(|segment| {
                        !segment.trim().is_empty() && segment.trim() != "Unanswered"
                    }) {
                        let mut selected = false;
                        let mut custom = Vec::new();
                        for piece in segment
                            .split(", ")
                            .map(str::trim)
                            .filter(|piece| !piece.is_empty())
                        {
                            if let Some(option) = question.options.iter().rev().find(|option| {
                                option.1.trim().to_lowercase() == piece.to_lowercase()
                            }) {
                                protobuf::write_string(&mut answer, 2, &option.0.clone().into())?;
                                selected = true;
                                continue;
                            }
                            custom.push(piece);
                        }
                        if !custom.is_empty() || !selected {
                            protobuf::write_string(
                                &mut answer,
                                3,
                                &if custom.is_empty() {
                                    "Other".into()
                                } else {
                                    custom.join(", ").into()
                                },
                            )?;
                        }
                    }
                    protobuf::write_bytes(&mut success, 1, &answer)?;
                }
                wrap(1, &success)?
            };
        if self.asynchronous {
            let mut completion = Vec::new();
            protobuf::write_string(&mut completion, 1, &self.call_id.clone().into())?;
            protobuf::write_bytes(&mut completion, 2, &self.raw_args)?;
            protobuf::write_bytes(&mut completion, 3, &result)?;
            return wrap(4, &wrap(8, &completion)?);
        }
        response(self.id, 3, &wrap(1, &result)?)
    }
}
fn question_rejection(id: u32, reason: &str) -> Result<Vec<u8>, Error> {
    response(id, 3, &wrap(1, &rejected(3, reason)?)?)
}
fn response(id: u32, variant: u32, result: &[u8]) -> Result<Vec<u8>, Error> {
    let mut response = Vec::new();
    protobuf::write_varint(&mut response, 1, u64::from(id))?;
    protobuf::write_bytes(&mut response, variant, result)?;
    wrap(6, &response)
}
fn wrap(number: u32, payload: &[u8]) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    protobuf::write_bytes(&mut out, number, payload)?;
    Ok(out)
}
fn rejected(variant: u32, reason: &str) -> Result<Vec<u8>, Error> {
    let mut rejection = Vec::new();
    protobuf::write_string(&mut rejection, 1, &reason.into())?;
    wrap(variant, &rejection)
}
fn text(fields: &[Field<'_>], number: u32) -> Result<String, Error> {
    fields
        .iter()
        .rev()
        .find(|field| field.number == number)
        .map(|field| field.text())
        .transpose()
        .map(|value| value.unwrap_or_default())
}
fn boolean(fields: &[Field<'_>], number: u32) -> Result<bool, Error> {
    fields
        .iter()
        .rev()
        .find(|field| field.number == number)
        .map(|field| field.varint())
        .transpose()
        .map(|value| value.is_some_and(|value| value != 0))
}
fn catch_all(label: &str) -> bool {
    let label = label.trim().to_lowercase();
    ["other", "something else"].iter().any(|prefix| {
        label == *prefix
            || [":", " -", " ("]
                .iter()
                .any(|suffix| label.starts_with(&format!("{prefix}{suffix}")))
    })
}
