use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use prost::Message;
use std::{collections::BTreeMap, ops::Bound};
use ycoding_core::{
    session::review_fold,
    ycoding_schema::{
        DomainEncode, JsonObject, JsonValue, LosslessString, ObjectEncoder, form, question,
        session_review::Payload, stringify_json,
    },
    ycoding_store::{TableSpec, session::SessionTable},
};
use ycoding_protocol::{domain_json, v5};

const GLOBAL: &str = "global";
const REPLY_LABEL: &str = "Reply (replace answer values)";
const TEMPLATE_HINT: &str = "Replace each entire quoted placeholder, including its quotes, with a JSON value matching options. Replace <answer:fields> with the complete answer object, including only active fields.";

struct Owner {
    title: LosslessString,
    directory: LosslessString,
}

struct Answer {
    label: LosslessString,
    value: JsonValue,
    template: bool,
}

struct Draft {
    kind: &'static str,
    session: LosslessString,
    id: LosslessString,
    summary: LosslessString,
    options: Option<JsonValue>,
    decide: Vec<JsonValue>,
}

fn text(value: &(impl DomainEncode + ?Sized)) -> LosslessString {
    match value.encode() {
        JsonValue::String(text) => text,
        _ => unreachable!("identifiers encode as strings"),
    }
}

fn literal(value: &str) -> JsonValue {
    JsonValue::String(value.into())
}

fn concat(parts: &[&LosslessString]) -> LosslessString {
    LosslessString::from_utf16(parts.iter().flat_map(|part| part.code_units()).collect())
}

fn join(values: &[LosslessString], separator: &str) -> LosslessString {
    let separator = LosslessString::from(separator);
    let mut parts = Vec::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            parts.push(&separator);
        }
        parts.push(value);
    }
    concat(&parts)
}

fn prefixed(prefix: &str, value: &LosslessString) -> LosslessString {
    concat(&[&LosslessString::from(prefix), value])
}

fn action_summary(
    action: &LosslessString,
    resources: &[LosslessString],
    reason: Option<&LosslessString>,
) -> LosslessString {
    let colon = LosslessString::from(": ");
    let resources = join(resources, ", ");
    let mut parts = vec![action, &colon, &resources];
    let dash = LosslessString::from(" — ");
    if let Some(reason) = reason {
        parts.push(&dash);
        parts.push(reason);
    }
    concat(&parts)
}

fn replies(hard: bool) -> &'static [&'static str] {
    if hard {
        &["once", "reject"]
    } else {
        &["once", "always", "reject"]
    }
}

fn object(entries: Vec<(LosslessString, JsonValue)>) -> JsonValue {
    let mut object = JsonObject::new();
    for (key, value) in entries {
        object.insert(key, value);
    }
    JsonValue::Object(object)
}

fn command(
    label: LosslessString,
    operation: &str,
    session: &LosslessString,
    (key, id): (&str, &LosslessString),
    body: Option<JsonValue>,
    template: bool,
    directory: Option<&LosslessString>,
) -> JsonValue {
    let mut argv = vec![
        "ycoding".into(),
        "api".into(),
        operation.into(),
        "--param".into(),
        prefixed("sessionID=", session),
        "--param".into(),
        concat(&[&LosslessString::from(format!("{key}=")), id]),
    ];
    if let Some(directory) = directory {
        argv.push("--header".into());
        argv.push(prefixed("x-ycoding-directory:", directory));
    }
    if let Some(body) = body {
        argv.push("--data".into());
        argv.push(stringify_json(&body).into());
    }
    ObjectEncoder::new()
        .field("label", &label)
        .field("argv", &argv)
        .optional("template", &template.then_some(true))
        .optional(
            "hint",
            &template.then(|| LosslessString::from(TEMPLATE_HINT)),
        )
        .finish()
}

fn question_answers(questions: &[question::Info]) -> Vec<Answer> {
    let single = (questions.len() == 1).then(|| &questions[0]);
    let mut answers = single
        .map(|single| {
            single
                .options
                .iter()
                .map(|option| Answer {
                    label: option.label.clone(),
                    value: JsonValue::Array(vec![JsonValue::Array(vec![JsonValue::String(
                        option.label.clone(),
                    )])]),
                    template: false,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if single.is_some_and(|single| {
        !single.options.is_empty() && single.custom == Some(false) && single.multiple != Some(true)
    }) {
        return answers;
    }
    answers.push(Answer {
        label: REPLY_LABEL.into(),
        value: JsonValue::Array(
            (0..questions.len())
                .map(|index| JsonValue::Array(vec![literal(&format!("<answer:{index}>"))]))
                .collect(),
        ),
        template: true,
    });
    answers
}

fn base(field: &form::Field) -> Option<&form::Base> {
    match field {
        form::Field::String(field) => Some(&field.base),
        form::Field::Number(field) => Some(&field.base),
        form::Field::Integer(field) => Some(&field.base),
        form::Field::Boolean(field) => Some(&field.base),
        form::Field::Multiselect(field) => Some(&field.base),
        form::Field::External(_) => None,
    }
}

fn key(field: &form::Field) -> &LosslessString {
    match field {
        form::Field::External(field) => &field.key,
        field => &base(field).expect("non-external fields have a base").key,
    }
}

fn form_answers(fields: &[form::Field]) -> Vec<Answer> {
    if fields
        .iter()
        .any(|field| base(field).is_some_and(|base| base.when.is_some()))
    {
        return vec![Answer {
            label: REPLY_LABEL.into(),
            value: literal("<answer:fields>"),
            template: true,
        }];
    }
    let single = (fields.len() == 1).then(|| &fields[0]);
    let choices = |key: &LosslessString, options: &[form::Option], multiple: bool| {
        options
            .iter()
            .map(|option| Answer {
                label: option.label.clone(),
                value: object(vec![(
                    key.clone(),
                    if multiple {
                        JsonValue::Array(vec![JsonValue::String(option.value.clone())])
                    } else {
                        JsonValue::String(option.value.clone())
                    },
                )]),
                template: false,
            })
            .collect::<Vec<_>>()
    };
    let (mut answers, exclusive) = match single {
        Some(form::Field::String(field)) => (
            field
                .options
                .as_deref()
                .map(|options| choices(&field.base.key, options, false))
                .unwrap_or_default(),
            field.custom == Some(false),
        ),
        Some(form::Field::Multiselect(field)) if !matches!(field.min_items.as_ref().map(DomainEncode::encode), Some(JsonValue::Number(minimum)) if minimum > 1.0) => {
            (choices(&field.base.key, &field.options, true), false)
        }
        _ => (Vec::new(), false),
    };
    if exclusive && !answers.is_empty() {
        return answers;
    }
    answers.push(Answer {
        label: REPLY_LABEL.into(),
        value: object(
            fields
                .iter()
                .map(|field| {
                    let name = key(field);
                    (
                        name.clone(),
                        JsonValue::String(concat(&[
                            &LosslessString::from("<answer:"),
                            name,
                            &LosslessString::from(">"),
                        ])),
                    )
                })
                .collect(),
        ),
        template: true,
    });
    answers
}

fn reply_commands(
    operation: &str,
    session: &LosslessString,
    id: &LosslessString,
    hard: bool,
) -> Vec<JsonValue> {
    replies(hard)
        .iter()
        .map(|reply| {
            command(
                (*reply).into(),
                operation,
                session,
                ("requestID", id),
                Some(object(vec![("reply".into(), literal(reply))])),
                false,
                None,
            )
        })
        .collect()
}

fn review_summary(payload: &Payload) -> LosslessString {
    match payload {
        Payload::Permission(payload) => action_summary(&payload.action, &payload.resources, None),
        Payload::Guardrail(payload) => {
            action_summary(&payload.action, &payload.resources, Some(&payload.reason))
        }
        Payload::Question(payload) => join(
            &payload
                .questions
                .iter()
                .map(|question| question.question.clone())
                .collect::<Vec<_>>(),
            "; ",
        ),
        Payload::Form(payload) => payload.title.clone(),
        Payload::SubagentQuestion(payload) => payload.text.clone(),
        Payload::Recovery(payload) => prefixed(
            "Recovery: ",
            &join(
                &payload
                    .tools
                    .iter()
                    .map(|tool| tool.name.clone())
                    .collect::<Vec<_>>(),
                ", ",
            ),
        ),
    }
}

fn review_choices(payload: &Payload) -> Vec<Answer> {
    let simple = |label: &str, value: JsonValue, template: bool| Answer {
        label: label.into(),
        value,
        template,
    };
    let tagged = |kind: &str, entries: Vec<(&str, JsonValue)>| {
        let mut all = vec![("kind".into(), literal(kind))];
        all.extend(entries.into_iter().map(|(key, value)| (key.into(), value)));
        object(all)
    };
    let with_dismissal = |answers: Vec<Answer>| {
        let mut all = answers
            .into_iter()
            .map(|answer| Answer {
                value: tagged("question", vec![("answers", answer.value)]),
                ..answer
            })
            .collect::<Vec<_>>();
        all.push(simple(
            "Dismiss",
            tagged("question", vec![("dismissed", JsonValue::Bool(true))]),
            false,
        ));
        all
    };
    match payload {
        Payload::Permission(_) | Payload::Guardrail(_) => {
            let (kind, hard) = match payload {
                Payload::Guardrail(payload) => ("guardrail", payload.hard_review),
                _ => ("permission", false),
            };
            replies(hard)
                .iter()
                .map(|reply| simple(reply, tagged(kind, vec![("reply", literal(reply))]), false))
                .collect()
        }
        Payload::Recovery(_) => ["continue", "stop"]
            .iter()
            .map(|choice| {
                simple(
                    choice,
                    tagged("recovery", vec![("choice", literal(choice))]),
                    false,
                )
            })
            .collect(),
        Payload::SubagentQuestion(_) => vec![
            simple(
                REPLY_LABEL,
                tagged(
                    "subagent_question",
                    vec![("text", literal("<answer:text>"))],
                ),
                true,
            ),
            simple(
                "Dismiss",
                tagged(
                    "subagent_question",
                    vec![("dismissed", JsonValue::Bool(true))],
                ),
                false,
            ),
        ],
        Payload::Question(payload) => with_dismissal(question_answers(&payload.questions)),
        Payload::Form(payload) => with_dismissal(form_answers(&payload.fields)),
    }
}

fn wire(
    draft: Draft,
    owners: &BTreeMap<LosslessString, Owner>,
    directory: &LosslessString,
) -> Result<Option<v5::DecisionItem>, Failure> {
    let owner = owners.get(&draft.session);
    if owner.is_none() && draft.session != LosslessString::from(GLOBAL) {
        return Ok(None);
    }
    let title = owner.map_or_else(
        || LosslessString::from("Global"),
        |owner| owner.title.clone(),
    );
    let directory = owner.map_or(directory.clone(), |owner| owner.directory.clone());
    let json = ObjectEncoder::new()
        .field("kind", draft.kind)
        .field("sessionID", &draft.session)
        .field("sessionTitle", &title)
        .field("directory", &directory)
        .field("id", &draft.id)
        .field("summary", &draft.summary)
        .optional("options", &draft.options)
        .field("decide", &JsonValue::Array(draft.decide))
        .finish();
    let unrepresentable = || Failure::Unavailable("Decision item cannot be represented".into());
    let bytes = domain_json::encode(
        "ycoding.v5.Decision_Item",
        &convert::json_domain(&json),
        ycoding_protocol::limits::BULK_MESSAGE_BYTES as usize,
    )
    .map_err(|_| unrepresentable())?;
    v5::DecisionItem::decode(bytes.as_slice())
        .map(Some)
        .map_err(|_| unrepresentable())
}

fn owners(
    snapshot: &ycoding_core::ycoding_store::Snapshot,
) -> Result<BTreeMap<LosslessString, Owner>, Failure> {
    let unavailable = |_| Failure::Unavailable("Session store unavailable".into());
    let mut owners = BTreeMap::new();
    let mut after: Option<Vec<u8>> = None;
    loop {
        let rows = snapshot
            .scan::<SessionTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                128,
            )
            .map_err(unavailable)?;
        let Some(last) = rows.last() else {
            return Ok(owners);
        };
        after = Some(SessionTable::primary_key(last));
        for row in rows.into_iter().filter(|row| row.time_archived.is_none()) {
            owners.insert(
                row.id,
                Owner {
                    title: row.title,
                    directory: row.directory,
                },
            );
        }
    }
}

fn ordered<T>(mut items: Vec<(u64, T)>) -> impl Iterator<Item = T> {
    items.sort_by_key(|(order, _)| *order);
    items.into_iter().map(|(_, item)| item)
}

pub async fn list(
    invocation: Invocation,
    _: v5::DecisionListRequest,
) -> Result<v5::DecisionListResult, Failure> {
    let core = invocation.core()?;
    let snapshot = core
        .locations
        .client()
        .snapshot()
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?;
    let owners = owners(&snapshot)?;
    let mut items = Vec::new();
    for group in core.locations.loaded_groups() {
        let directory = group[0].info.directory.as_lossless().clone();
        let mut drafts = Vec::new();
        for request in ordered(
            group
                .iter()
                .flat_map(|set| set.permissions.list_ordered())
                .collect(),
        ) {
            let (session, id) = (text(&request.session_id), text(&request.id));
            drafts.push(Draft {
                kind: "permission",
                summary: action_summary(&request.action, &request.resources, None),
                options: None,
                decide: reply_commands("session.permission.reply", &session, &id, false),
                session,
                id,
            });
        }
        for request in ordered(
            group
                .iter()
                .flat_map(|set| set.guardrails.list_ordered())
                .collect(),
        ) {
            let (session, id) = (text(&request.session_id), text(&request.id));
            drafts.push(Draft {
                kind: "guardrail",
                summary: action_summary(&request.action, &request.resources, Some(&request.reason)),
                options: None,
                decide: reply_commands(
                    "session.guardrail.request.reply",
                    &session,
                    &id,
                    request.hard_review == Some(true),
                ),
                session,
                id,
            });
        }
        for request in ordered(
            group
                .iter()
                .flat_map(|set| set.questions.list_ordered())
                .collect(),
        ) {
            let (session, id) = (text(&request.session_id), text(&request.id));
            let mut decide = question_answers(&request.questions)
                .into_iter()
                .map(|answer| {
                    command(
                        answer.label,
                        "session.question.reply",
                        &session,
                        ("requestID", &id),
                        Some(object(vec![("answers".into(), answer.value)])),
                        answer.template,
                        None,
                    )
                })
                .collect::<Vec<_>>();
            decide.push(command(
                "Reject".into(),
                "session.question.reject",
                &session,
                ("requestID", &id),
                None,
                false,
                None,
            ));
            drafts.push(Draft {
                kind: "question",
                summary: join(
                    &request
                        .questions
                        .iter()
                        .map(|question| question.question.clone())
                        .collect::<Vec<_>>(),
                    "; ",
                ),
                options: Some(JsonValue::Array(
                    request.questions.iter().map(DomainEncode::encode).collect(),
                )),
                decide,
                session,
                id,
            });
        }
        for request in ordered(
            group
                .iter()
                .flat_map(|set| set.forms.list_ordered(None))
                .collect(),
        ) {
            let (session, id) = (request.session_id.clone(), text(&request.id));
            let header = (session == LosslessString::from(GLOBAL)).then_some(&directory);
            let mut decide = form_answers(&request.fields.0)
                .into_iter()
                .map(|answer| {
                    command(
                        answer.label,
                        "session.form.reply",
                        &session,
                        ("formID", &id),
                        Some(object(vec![("answer".into(), answer.value)])),
                        answer.template,
                        header,
                    )
                })
                .collect::<Vec<_>>();
            decide.push(command(
                "Cancel".into(),
                "session.form.cancel",
                &session,
                ("formID", &id),
                None,
                false,
                header,
            ));
            drafts.push(Draft {
                kind: "form",
                summary: request.title.clone(),
                options: Some(request.fields.encode()),
                decide,
                session,
                id,
            });
        }
        for draft in drafts {
            items.extend(wire(draft, &owners, &directory)?);
        }
    }
    let identifiers = owners.keys().cloned().collect::<Vec<_>>();
    let folded = review_fold::fold(&snapshot, &identifiers)
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?;
    for item in folded.iter().filter(|item| item.is_open()) {
        let (session, id) = (text(&item.session_id), text(&item.item_id));
        let payload = &item.deferral.payload;
        let directory = owners
            .get(&session)
            .map_or_else(LosslessString::default, |owner| owner.directory.clone());
        let decide = review_choices(payload)
            .into_iter()
            .map(|choice| {
                command(
                    choice.label,
                    "session.review.decide",
                    &session,
                    ("itemID", &id),
                    Some(object(vec![("decision".into(), choice.value)])),
                    choice.template,
                    None,
                )
            })
            .collect();
        items.extend(wire(
            Draft {
                kind: "review",
                summary: review_summary(payload),
                options: Some(payload.encode()),
                decide,
                session,
                id,
            },
            &owners,
            &directory,
        )?);
    }
    Ok(v5::DecisionListResult {
        data: v5::DecisionListResultData { items },
    })
}
