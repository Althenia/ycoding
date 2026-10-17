use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids, platform_services,
};
use ycoding_core::{
    model_incident::{Error, ModelKey, RecentInput, ReportInput},
    ycoding_schema::{DomainEncode, model_incident, provider},
};
use ycoding_protocol::v5;

pub async fn report(
    invocation: Invocation,
    request: v5::IncidentReportRequest,
) -> Result<v5::IncidentReportResult, Failure> {
    let data = invocation
        .core()?
        .incidents
        .report(ReportInput {
            group: model_incident::Group(
                match request.query.group {
                    1 => "model",
                    2 => "agent",
                    _ => return Err(Failure::Invalid("Invalid incident group".into())),
                }
                .into(),
            ),
            from: request.query.from.map(integer).transpose()?,
            to: request.query.to.map(integer).transpose()?,
            offset: request.query.offset.map(integer).transpose()?,
            limit: request.query.limit.map(integer).transpose()?,
        })
        .await
        .map_err(failure)?;
    Ok(v5::IncidentReportResult {
        data: v5::ModelIncidentReport {
            rows: v5::ModelIncidentReportRows {
                items: data
                    .rows
                    .iter()
                    .map(|row| v5::ModelIncidentReportRow {
                        provider_id: convert::wire(&row.provider_id.0),
                        model_id: convert::wire(&row.model_id),
                        agent: row.agent.as_ref().map(convert::wire),
                        fallbacks: row.fallbacks.get() as u64,
                        escalated: row.escalated.get() as u64,
                        rejected: row.rejected.get() as u64,
                        last: row.last.get() as u64,
                    })
                    .collect(),
            },
            groups: data.groups.get() as u64,
        },
    })
}

pub async fn recent(
    invocation: Invocation,
    request: v5::IncidentRecentRequest,
) -> Result<v5::IncidentRecentResult, Failure> {
    let data = invocation
        .core()?
        .incidents
        .recent(RecentInput {
            provider: provider::Id(convert::domain(&request.query.provider)?),
            model: convert::domain(&request.query.model)?,
            agent: request
                .query
                .agent
                .as_ref()
                .map(convert::domain)
                .transpose()?,
            limit: request.query.limit.map(integer).transpose()?,
        })
        .await
        .map_err(failure)?;
    Ok(v5::IncidentRecentResult {
        data: v5::ModelIncidentRecent {
            items: v5::ModelIncidentRecentItems {
                items: data.items.iter().map(wire_item).collect::<Result<_, _>>()?,
            },
        },
    })
}

pub async fn guidance_get(
    invocation: Invocation,
    request: v5::IncidentGuidanceGetRequest,
) -> Result<v5::IncidentGuidanceGetResult, Failure> {
    let (model, enabled) = resolve_guidance(&invocation, &request.query)?;
    let data = invocation
        .core()?
        .incidents
        .guidance(model, enabled, ids::now_millis())
        .await
        .map_err(failure)?;
    Ok(v5::IncidentGuidanceGetResult {
        data: wire_guidance(data),
    })
}

pub async fn guidance_clear(
    invocation: Invocation,
    request: v5::IncidentGuidanceClearRequest,
) -> Result<v5::IncidentGuidanceClearResult, Failure> {
    let (model, enabled) = resolve_guidance(&invocation, &request.query)?;
    let core = invocation.core()?;
    let now = ids::now_millis();
    core.incidents
        .clear(model.clone(), now)
        .await
        .map_err(failure)?;
    let data = core
        .incidents
        .guidance(model, enabled, now)
        .await
        .map_err(failure)?;
    Ok(v5::IncidentGuidanceClearResult {
        data: wire_guidance(data),
    })
}

fn resolve_guidance(
    invocation: &Invocation,
    query: &v5::ModelIncidentGuidanceQuery,
) -> Result<(ModelKey, bool), Failure> {
    if invocation.remote && query.location.is_some() {
        return Err(Failure::Forbidden(
            "Remote input cannot select a Location".into(),
        ));
    }
    let (_, platform) = platform_services::resolve(
        invocation,
        query
            .location
            .as_ref()
            .and_then(|location| location.directory.as_ref()),
        query
            .location
            .as_ref()
            .and_then(|location| location.workspace.as_ref()),
    )?;
    Ok((
        ModelKey {
            provider: provider::Id(convert::domain(&query.provider)?),
            model: convert::domain(&query.model)?,
        },
        platform
            .config
            .capabilities
            .builtin_instructions
            .allows(&"model-guidance".into()),
    ))
}

fn wire_guidance(data: model_incident::Guidance) -> v5::ModelIncidentGuidance {
    v5::ModelIncidentGuidance {
        text: data.text.as_ref().map(convert::wire),
        cleared_at: data.cleared_at.map(|time| time.get() as u64),
        enabled: data.enabled,
    }
}

fn wire_item(item: &model_incident::Item) -> Result<v5::ModelIncidentItem, Failure> {
    Ok(v5::ModelIncidentItem {
        id: convert::wire(&item.id.0),
        time: item.time.get() as u64,
        kind: match item.kind.0.as_str() {
            Some("fallback") => 1,
            Some("guardrail-escalated") => 2,
            Some("guardrail-rejected") => 3,
            _ => return Err(unrepresentable()),
        },
        category: convert::wire(&item.category),
        rule_i_ds: v5::ModelIncidentItemRuleIDs {
            items: item.rule_ids.iter().map(convert::wire).collect(),
        },
        agent: convert::wire(&item.agent),
        variant: item.variant.as_ref().map(convert::wire),
        profile: item
            .profile
            .as_ref()
            .map(|profile| convert::wire(&profile.0)),
        target: item
            .target
            .as_ref()
            .map(|target| convert::model_ref(&target.encode()).map_err(|_| unrepresentable()))
            .transpose()?,
        decided_by: item
            .decided_by
            .as_ref()
            .map(|decided_by| match decided_by.0.as_str() {
                Some("decision-model") => Ok(1),
                Some("human") => Ok(2),
                _ => Err(unrepresentable()),
            })
            .transpose()?,
    })
}

fn integer(value: u64) -> Result<i64, Failure> {
    i64::try_from(value).map_err(|_| Failure::Invalid("Invalid incident integer".into()))
}

fn failure(error: Error) -> Failure {
    match error {
        Error::InvalidInput(message) => Failure::Invalid(message.into()),
        Error::Store(_) | Error::Worker(_) => {
            Failure::Unavailable("Model incident store unavailable".into())
        }
    }
}

fn unrepresentable() -> Failure {
    Failure::Unavailable("Stored model incident is not representable on the wire".into())
}
