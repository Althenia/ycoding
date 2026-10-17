use super::codec::{Document, check, key, table};
use crate::{Error, IndexDefinition, KeyPart, tuple_key};
use std::collections::BTreeSet;
use ycoding_schema::{LosslessString, model};

table!(IncidentTable, Incident, "model_incident", {
    id: LosslessString, time_created: i64, kind: LosslessString, provider_id: LosslessString, model_id: LosslessString,
    variant: Option<LosslessString>, profile: Option<LosslessString>, agent: LosslessString, project_id: LosslessString,
    session_id: LosslessString, request_id: Option<LosslessString>, category: LosslessString,
    rule_ids: Document<Vec<LosslessString>>, target: Option<Document<model::Ref>>, decided_by: Option<LosslessString>
}, r, key(&r.id), &[
    IndexDefinition::secondary("model_incident_time_created_id_idx"),
    IndexDefinition::secondary("model_incident_model_time_idx"),
    IndexDefinition::secondary("model_incident_model_agent_time_idx"),
    IndexDefinition::secondary("model_incident_guidance_idx"),
    IndexDefinition::secondary("model_incident_request_idx")
], index, match index.name {
    "model_incident_time_created_id_idx" => Ok(Some(tuple_key(&[KeyPart::I64(r.time_created), KeyPart::String(&r.id)]))),
    "model_incident_model_time_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.provider_id), KeyPart::String(&r.model_id), KeyPart::I64(r.time_created), KeyPart::String(&r.id)]))),
    "model_incident_model_agent_time_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.provider_id), KeyPart::String(&r.model_id), KeyPart::String(&r.agent), KeyPart::I64(r.time_created), KeyPart::String(&r.id)]))),
    "model_incident_guidance_idx" => Ok((r.kind.as_str() != Some("fallback")).then(|| tuple_key(&[KeyPart::String(&r.provider_id), KeyPart::String(&r.model_id), KeyPart::I64(r.time_created), KeyPart::String(&r.id)]))),
    "model_incident_request_idx" => Ok(r.request_id.as_ref().map(|request| tuple_key(&[KeyPart::String(request), KeyPart::String(&r.session_id), KeyPart::String(&r.kind)]))),
    _ => Err(Error::UnregisteredIndex)
}, validate_incident(r), tx, { let _ = tx; });

table!(GuidanceClearTable, GuidanceClear, "model_guidance_clear", {
    provider_id: LosslessString, model_id: LosslessString, cleared_at: i64
}, r, tuple_key(&[KeyPart::String(&r.provider_id), KeyPart::String(&r.model_id)]), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, {
    check(!r.provider_id.is_empty() && !r.model_id.is_empty(), "model_guidance_clear_identity_check")?;
    check(r.cleared_at >= 0, "model_guidance_clear_time_check")
}, tx, { let _ = tx; });

fn validate_incident(r: &Incident) -> Result<(), Error> {
    let kind = r.kind.as_str();
    let fallback = kind == Some("fallback");
    check(
        r.id.code_units().take(4).eq("inc_".encode_utf16()) && r.id.len() > 4,
        "model_incident_id_check",
    )?;
    check(r.time_created >= 0, "model_incident_time_check")?;
    check(
        matches!(
            kind,
            Some("fallback" | "guardrail-escalated" | "guardrail-rejected")
        ),
        "model_incident_kind_check",
    )?;
    check(
        [
            &r.provider_id,
            &r.model_id,
            &r.agent,
            &r.project_id,
            &r.session_id,
        ]
        .into_iter()
        .all(|value| !value.is_empty())
            && [&r.variant, &r.profile]
                .into_iter()
                .all(|value| value.as_ref().is_none_or(|value| !value.is_empty())),
        "model_incident_identity_check",
    )?;
    check(
        if fallback {
            bounded(&r.category, |unit, first| {
                unit.is_ascii_alphanumeric() || (!first && matches!(unit, '.' | '_' | '-'))
            })
        } else {
            matches!(r.category.as_str(), Some("ordinary" | "hard"))
        },
        "model_incident_category_check",
    )?;
    let rules = r
        .rule_ids
        .domain()
        .map_err(|_| Error::Incompatible("model incident rule IDs"))?;
    check(
        (!fallback || rules.is_empty())
            && rules.iter().all(|rule| {
                bounded(rule, |unit, first| {
                    unit.is_ascii_lowercase()
                        || unit.is_ascii_digit()
                        || (!first && matches!(unit, '.' | '_' | '-'))
                })
            })
            && rules.iter().collect::<BTreeSet<_>>().len() == rules.len(),
        "model_incident_rule_check",
    )?;
    check(
        if fallback {
            r.request_id.is_none() && r.target.is_some()
        } else {
            r.request_id
                .as_ref()
                .is_some_and(|request| !request.is_empty())
                && r.target.is_none()
        },
        "model_incident_shape_check",
    )?;
    check(
        match kind {
            Some("guardrail-rejected") => matches!(
                r.decided_by.as_ref().and_then(LosslessString::as_str),
                Some("decision-model" | "human")
            ),
            _ => r.decided_by.is_none(),
        },
        "model_incident_decided_by_check",
    )
}

fn bounded(value: &LosslessString, allowed: impl Fn(char, bool) -> bool) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    (1..=64).contains(&text.chars().count())
        && text
            .chars()
            .enumerate()
            .all(|(index, unit)| allowed(unit, index == 0))
}
