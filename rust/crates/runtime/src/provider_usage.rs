use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
    services::ProviderUsageServices,
};
use ycoding_core::ycoding_schema::{
    location, provider, provider_usage, schema::NonNegativeInt, usage_forecast,
};
use ycoding_protocol::v5;

fn resolve(
    invocation: &Invocation,
    query: &v5::ProviderUsageQuery,
) -> Result<(location::Info, ProviderUsageServices), Failure> {
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
    Ok((location.info.clone(), usage))
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
        location: convert::location_info(&location),
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
        location: convert::location_info(&location),
        data: v5::ProviderUsageListResultData {
            items: snapshots.iter().map(wire).collect::<Result<_, _>>()?,
        },
    })
}

pub async fn forecast(
    invocation: Invocation,
    request: v5::ProviderUsageForecastRequest,
) -> Result<v5::ProviderUsageForecastResult, Failure> {
    if invocation.remote && request.query.location.is_some() {
        return Err(Failure::Forbidden(
            "Remote input cannot select a Location".into(),
        ));
    }
    if invocation.remote
        && !matches!(
            (&invocation.scope.target, request.query.local_scope),
            (Some(v5::scope::Target::Machine(_)), 1) | (Some(v5::scope::Target::Session(_)), 2)
        )
    {
        return Err(Failure::Invalid(
            "forecast scope and remote request scope disagree".into(),
        ));
    }
    let (location, usage) = resolve(
        &invocation,
        &v5::ProviderUsageQuery {
            location: request
                .query
                .location
                .map(|location| v5::ProviderUsageQueryLocation {
                    directory: location.directory,
                    workspace: location.workspace,
                }),
            refresh: None,
        },
    )?;
    let selected = match request.query.local_scope {
        1 => None,
        2 => Some(location::Ref {
            directory: location.directory.clone(),
            workspace_id: location.workspace_id.clone(),
        }),
        _ => return Err(Failure::Invalid("invalid forecast scope".into())),
    };
    let data = usage
        .quota
        .forecast(
            &usage.providers,
            selected.as_ref(),
            NonNegativeInt::new(ids::now_millis()).map_err(|_| unavailable())?,
        )
        .await;
    Ok(v5::ProviderUsageForecastResult {
        location: convert::location_info(&location),
        data: wire_forecast(&data)?,
    })
}

fn wire_forecast(data: &usage_forecast::Info) -> Result<v5::UsageForecastInfo, Failure> {
    let count = |value: NonNegativeInt| value.get() as u64;
    Ok(v5::UsageForecastInfo {
        as_of: count(data.as_of),
        local_scope: tag(&data.local_scope.0, &["backend", "location"])?,
        local_rates: data
            .local_rates
            .as_ref()
            .map(|rates| v5::UsageForecastInfoLocalRates {
                items: rates
                    .iter()
                    .map(|rate| v5::UsageForecastLocalRate {
                        provider_id: convert::wire(&rate.provider_id.0),
                        profile: rate.profile.as_ref().map(|value| convert::wire(&value.0)),
                        model_id: rate.model_id.as_ref().map(convert::wire),
                        observed_from: count(rate.observed_from),
                        observed_to: count(rate.observed_to),
                        tokens_per_minute: rate.tokens_per_minute,
                        tokens_per_minute5: rate.tokens_per_minute5,
                        tokens_per_minute60: rate.tokens_per_minute60,
                        estimated_usd_per_hour: rate
                            .estimated_usd_per_hour
                            .map(|value| value.get()),
                        coverage: crate::session_read_models::wire_coverage(&rate.coverage),
                    })
                    .collect(),
            }),
        quotas: data
            .quotas
            .as_ref()
            .map(|quotas| -> Result<_, Failure> {
                Ok(v5::UsageForecastInfoQuotas {
                    items: quotas
                        .iter()
                        .map(|quota| -> Result<_, Failure> {
                            Ok(v5::UsageForecastQuota {
                                provider_id: convert::wire(&quota.provider_id.0),
                                profile: quota
                                    .profile
                                    .as_ref()
                                    .map(|value| convert::wire(&value.0)),
                                window_id: convert::wire(&quota.window_id),
                                unit: tag(
                                    &quota.unit.0,
                                    &["percent", "usd", "requests", "tokens", "count"],
                                )?,
                                source: tag(
                                    &quota.source.0,
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
                                    &quota.stability.0,
                                    &["stable", "client_contract", "observed", "best_effort"],
                                )?,
                                updated_at: count(quota.updated_at),
                                state: tag(
                                    &quota.state.0,
                                    &["estimated", "insufficient", "exhausted", "unlimited"],
                                )?,
                                method: quota
                                    .method
                                    .as_ref()
                                    .map(|value| tag(&value.0, &["quota-delta-ema", "window-mean"]))
                                    .transpose()?,
                                evidence: tag(
                                    &quota.evidence.0,
                                    &["low", "medium", "insufficient"],
                                )?,
                                reason: quota.reason.as_ref().map(convert::wire),
                                observed_from: quota.observed_from.map(count),
                                observed_to: quota.observed_to.map(count),
                                rate_per_hour: quota.rate_per_hour,
                                exhaustion_at: quota.exhaustion_at.map(count),
                                projected_used_at_reset: quota.projected_used_at_reset,
                                pace: quota
                                    .pace
                                    .as_ref()
                                    .map(|pace| -> Result<_, Failure> {
                                        Ok(v5::UsageForecastPace {
                                            verdict: tag(
                                                &pace.verdict.0,
                                                &["ahead", "cutting-it-close", "will-run-out"],
                                            )?,
                                            projected_used_at_reset: pace.projected_used_at_reset,
                                            exhaustion_at: pace.exhaustion_at.map(count),
                                        })
                                    })
                                    .transpose()?,
                            })
                        })
                        .collect::<Result<_, _>>()?,
                })
            })
            .transpose()?,
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
