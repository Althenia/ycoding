use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
    services::ProviderUsageServices,
};
use ycoding_core::ycoding_schema::{provider, provider_usage};
use ycoding_protocol::v5;

fn resolve(
    invocation: &Invocation,
    query: &v5::ProviderUsageQuery,
) -> Result<(v5::LocationInfo, ProviderUsageServices), Failure> {
    let requested = query
        .location
        .as_ref()
        .map(|location| v5::LocationQueryLocation {
            directory: location.directory.clone(),
            workspace: location.workspace.clone(),
        });
    let location = invocation.location(requested.as_ref())?;
    let resolver = invocation
        .core()?
        .provider_usage
        .as_ref()
        .ok_or_else(unavailable)?;
    let usage = resolver(&location.info).map_err(|_| unavailable())?;
    Ok((convert::location_info(&location.info), usage))
}

fn unavailable() -> Failure {
    Failure::ServiceUnavailable {
        service: "provider-usage",
        message: "Location provider usage service is not available".into(),
    }
}

pub async fn get(
    invocation: Invocation,
    request: v5::ProviderUsageGetRequest,
) -> Result<v5::ProviderUsageGetResult, Failure> {
    let (location, usage) = resolve(&invocation, &request.query)?;
    let provider = provider::Id(convert::domain(&request.params.provider_id)?);
    let snapshot = usage
        .quota
        .get(
            provider,
            None,
            request.query.refresh.unwrap_or(false),
            ids::now_millis(),
        )
        .await;
    Ok(v5::ProviderUsageGetResult {
        location,
        data: wire(&snapshot)?,
    })
}

pub async fn list(
    invocation: Invocation,
    request: v5::ProviderUsageListRequest,
) -> Result<v5::ProviderUsageListResult, Failure> {
    let (location, usage) = resolve(&invocation, &request.query)?;
    let snapshots = usage
        .quota
        .list(
            &usage.providers,
            request.query.refresh.unwrap_or(false),
            ids::now_millis(),
        )
        .await;
    Ok(v5::ProviderUsageListResult {
        location,
        data: v5::ProviderUsageListResultData {
            items: snapshots.iter().map(wire).collect::<Result<_, _>>()?,
        },
    })
}

fn tag(
    value: &ycoding_core::ycoding_schema::LosslessString,
    names: &[&str],
) -> Result<i32, Failure> {
    names
        .iter()
        .position(|name| value.as_str() == Some(*name))
        .map(|index| index as i32 + 1)
        .ok_or_else(unavailable)
}

fn wire(snapshot: &provider_usage::Snapshot) -> Result<v5::ProviderUsageSnapshot, Failure> {
    Ok(v5::ProviderUsageSnapshot {
        provider_id: convert::wire(&snapshot.provider_id.0),
        label: convert::wire(&snapshot.label),
        profile: snapshot.profile.as_ref().map(convert::wire),
        status: tag(
            &snapshot.status,
            &["available", "stale", "unsupported", "unauthorized", "error"],
        )?,
        source: tag(
            &snapshot.source,
            &[
                "provider_api",
                "local_client_rpc",
                "response_headers",
                "provider_internal_api",
                "local_session",
                "response_stream",
            ],
        )?,
        stability: tag(
            &snapshot.stability,
            &["stable", "client_contract", "observed", "best_effort"],
        )?,
        updated_at: snapshot.updated_at.get() as u64,
        windows: v5::ProviderUsageSnapshotWindows {
            items: snapshot
                .windows
                .iter()
                .map(|window| {
                    Ok(v5::ProviderUsageWindow {
                        id: convert::wire(&window.id),
                        label: convert::wire(&window.label),
                        unit: tag(
                            &window.unit,
                            &["percent", "usd", "requests", "tokens", "count"],
                        )?,
                        used: window.used,
                        limit: window.limit,
                        remaining: window.remaining,
                        unlimited: window.unlimited,
                        reset_at: window.reset_at.map(|value| value.get() as u64),
                        period_seconds: window.period_seconds.map(|value| value.get() as u64),
                    })
                })
                .collect::<Result<_, Failure>>()?,
        },
        message: snapshot.message.as_ref().map(convert::wire),
    })
}
