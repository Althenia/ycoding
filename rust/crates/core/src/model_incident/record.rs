use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, agent, guardrail, model, model_incident, session,
    session_message_id,
};
use ycoding_store::{
    Error, KeyPart, Write,
    model_incident::{Incident, IncidentTable, REQUEST_INDEX},
    session::{Document, MessageTable, SessionTable},
    tuple_key,
};

#[derive(Clone, Debug, PartialEq)]
pub struct FallbackInput {
    pub session_id: session::Id,
    pub agent: agent::Id,
    pub from: model::Ref,
    pub to: model::Ref,
    pub category: LosslessString,
    pub time: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GuardrailInput {
    pub session_id: session::Id,
    pub request_id: guardrail::RequestId,
    pub message_id: Option<session_message_id::Id>,
    pub rule_ids: Vec<LosslessString>,
    pub hard_review: bool,
    pub time: i64,
}

struct Attribution {
    agent: LosslessString,
    provider_id: LosslessString,
    model_id: LosslessString,
    variant: Option<LosslessString>,
    profile: Option<LosslessString>,
    project_id: LosslessString,
}

const ESCALATED: &str = "guardrail-escalated";
const REJECTED: &str = "guardrail-rejected";

pub fn fallback(
    tx: &mut Write<'_>,
    id: &model_incident::Id,
    input: &FallbackInput,
) -> Result<bool, Error> {
    let Some(session) = tx.get::<SessionTable>(&key(input.session_id.as_lossless()))? else {
        return Ok(false);
    };
    IncidentTable::insert(
        tx,
        &Incident {
            id: id.0.clone(),
            time_created: input.time,
            kind: "fallback".into(),
            provider_id: input.from.provider_id.0.clone(),
            model_id: input.from.id.clone(),
            variant: nonempty(input.from.variant.clone()),
            profile: nonempty(input.from.profile.as_ref().map(|profile| profile.0.clone())),
            agent: input.agent.clone(),
            project_id: session.project_id,
            session_id: input.session_id.as_lossless().clone(),
            request_id: None,
            category: if bounded(&input.category, false) {
                input.category.clone()
            } else {
                "unknown".into()
            },
            rule_ids: Document::new(JsonValue::Array(vec![]))?,
            target: Some(Document::from_domain(&input.to)?),
            decided_by: None,
        },
    )?;
    Ok(true)
}

pub fn escalation(
    tx: &mut Write<'_>,
    id: &model_incident::Id,
    input: &GuardrailInput,
) -> Result<bool, Error> {
    let Some(message) = &input.message_id else {
        return Ok(false);
    };
    let Some(attribution) = assistant(tx, &input.session_id, message)? else {
        return Ok(false);
    };
    guardrail(tx, id, ESCALATED, input, attribution, None)
}

pub fn rejection(
    tx: &mut Write<'_>,
    id: &model_incident::Id,
    input: &GuardrailInput,
    decided_by: &model_incident::DecidedBy,
) -> Result<bool, Error> {
    let attribution = match &input.message_id {
        Some(message) => assistant(tx, &input.session_id, message)?,
        None => None,
    };
    let attribution = match attribution {
        Some(attribution) => Some(attribution),
        None => escalated(tx, input)?,
    };
    let Some(attribution) = attribution else {
        return Ok(false);
    };
    guardrail(
        tx,
        id,
        REJECTED,
        input,
        attribution,
        Some(decided_by.0.clone()),
    )
}

fn guardrail(
    tx: &mut Write<'_>,
    id: &model_incident::Id,
    kind: &str,
    input: &GuardrailInput,
    attribution: Attribution,
    decided_by: Option<LosslessString>,
) -> Result<bool, Error> {
    let request = text(&input.request_id)?;
    if !tx
        .index::<IncidentTable>(REQUEST_INDEX, &request_key(&request, input, kind), None, 1)?
        .is_empty()
    {
        return Ok(false);
    }
    let mut rules = Vec::<LosslessString>::new();
    for rule in &input.rule_ids {
        let rule = if bounded(rule, true) {
            rule.clone()
        } else {
            "custom".into()
        };
        if !rules.contains(&rule) {
            rules.push(rule);
        }
    }
    IncidentTable::insert(
        tx,
        &Incident {
            id: id.0.clone(),
            time_created: input.time,
            kind: kind.into(),
            provider_id: attribution.provider_id,
            model_id: attribution.model_id,
            variant: attribution.variant,
            profile: attribution.profile,
            agent: attribution.agent,
            project_id: attribution.project_id,
            session_id: input.session_id.as_lossless().clone(),
            request_id: Some(request),
            category: if input.hard_review {
                "hard"
            } else {
                "ordinary"
            }
            .into(),
            rule_ids: Document::from_domain(&rules)?,
            target: None,
            decided_by,
        },
    )?;
    Ok(true)
}

fn assistant(
    tx: &mut Write<'_>,
    session_id: &session::Id,
    message_id: &session_message_id::Id,
) -> Result<Option<Attribution>, Error> {
    let Some(message) = tx.get::<MessageTable>(&key(message_id.as_lossless()))? else {
        return Ok(None);
    };
    if &message.session_id != session_id.as_lossless()
        || message.type_.as_str() != Some("assistant")
    {
        return Ok(None);
    }
    let Some(session) = tx.get::<SessionTable>(&key(session_id.as_lossless()))? else {
        return Ok(None);
    };
    let field = |value: &JsonValue, name: &str| match value {
        JsonValue::Object(object) => match object.get(&name.into()) {
            Some(JsonValue::String(text)) if !text.is_empty() => Some(text.clone()),
            _ => None,
        },
        _ => None,
    };
    let model = match &message.data {
        JsonValue::Object(object) => object.get(&"model".into()).cloned(),
        _ => None,
    };
    let (Some(agent), Some(model)) = (field(&message.data, "agent"), model) else {
        return Ok(None);
    };
    let (Some(provider_id), Some(model_id)) = (field(&model, "providerID"), field(&model, "id"))
    else {
        return Ok(None);
    };
    Ok(Some(Attribution {
        agent,
        provider_id,
        model_id,
        variant: field(&model, "variant"),
        profile: field(&model, "profile"),
        project_id: session.project_id,
    }))
}

fn escalated(tx: &mut Write<'_>, input: &GuardrailInput) -> Result<Option<Attribution>, Error> {
    let request = text(&input.request_id)?;
    Ok(tx
        .index::<IncidentTable>(
            REQUEST_INDEX,
            &request_key(&request, input, ESCALATED),
            None,
            1,
        )?
        .pop()
        .map(|row| Attribution {
            agent: row.agent,
            provider_id: row.provider_id,
            model_id: row.model_id,
            variant: row.variant,
            profile: row.profile,
            project_id: row.project_id,
        }))
}

fn request_key(request: &LosslessString, input: &GuardrailInput, kind: &str) -> Vec<u8> {
    tuple_key(&[
        KeyPart::String(request),
        KeyPart::String(input.session_id.as_lossless()),
        KeyPart::String(&kind.into()),
    ])
}

fn text(value: &impl DomainEncode) -> Result<LosslessString, Error> {
    match value.encode() {
        JsonValue::String(text) => Ok(text),
        _ => Err(Error::Rejected("guardrail request ID must be a string")),
    }
}

fn key(value: &LosslessString) -> Vec<u8> {
    tuple_key(&[KeyPart::String(value)])
}

fn nonempty(value: Option<LosslessString>) -> Option<LosslessString> {
    value.filter(|value| !value.is_empty())
}

fn bounded(value: &LosslessString, rule: bool) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    (1..=64).contains(&text.chars().count())
        && text.chars().enumerate().all(|(index, unit)| {
            let letter = if rule {
                unit.is_ascii_lowercase()
            } else {
                unit.is_ascii_alphabetic()
            };
            letter || unit.is_ascii_digit() || (index > 0 && matches!(unit, '.' | '_' | '-'))
        })
}
