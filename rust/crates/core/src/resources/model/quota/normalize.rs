use super::{Error, amount, empty, window};
use crate::resources::catalog::{
    field,
    models_dev::{date_millis, text},
};
use ycoding_schema::{
    JsonValue, provider,
    provider_usage::{Snapshot, Window},
    schema::NonNegativeInt,
};

pub fn normalize_claude(
    provider: provider::Id,
    label: &str,
    now: i64,
    response: &JsonValue,
) -> Result<Snapshot, Error> {
    let JsonValue::Object(root) = response else {
        return Err(Error::InvalidResponse);
    };
    let mut snapshot = empty(provider, label, now, "provider_internal_api", "best_effort");
    for (key, value) in root.iter() {
        let Some(key) = key.as_str() else {
            continue;
        };
        if key == "extra_usage" {
            if field(value, "is_enabled") != Some(&JsonValue::Bool(true)) {
                continue;
            }
            let used = amount(field(value, "used_credits"))?.map(|n| round(n / 100.0));
            let limit = amount(field(value, "monthly_limit"))?.map(|n| round(n / 100.0));
            if used.is_none() && limit.is_none() {
                continue;
            }
            let mut w = window("extra-usage", "Extra usage", "usd");
            w.used = used;
            w.limit = limit;
            w.remaining = used
                .zip(limit)
                .map(|(used, limit)| round((limit - used).max(0.0)));
            snapshot.windows.push(w);
            continue;
        }
        if key != "five_hour" && key != "seven_day" && !key.starts_with("seven_day_") {
            continue;
        }
        if *value == JsonValue::Null {
            continue;
        }
        if !matches!(value, JsonValue::Object(_)) {
            return Err(Error::InvalidResponse);
        }
        let Some(used) = numeric(field(value, "utilization"), 100.0)? else {
            continue;
        };
        let label = if key == "five_hour" {
            "Session".into()
        } else if key == "seven_day" {
            "All models".into()
        } else {
            format!("{} weekly", capitalize(&key[10..].replace('_', " ")))
        };
        let mut w = window(&key.replace('_', "-"), &label, "percent");
        w.used = Some(round(used));
        w.reset_at = reset(field(value, "resets_at"))?;
        snapshot.windows.push(w);
    }
    if let Some(JsonValue::Array(limits)) = field(response, "limits") {
        for entry in limits {
            if field(entry, "kind").and_then(text) != Some("weekly_scoped") {
                continue;
            }
            let Some(model) = field(entry, "scope")
                .and_then(|v| field(v, "model"))
                .and_then(|v| field(v, "display_name"))
                .and_then(text)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let Some(used) = numeric(field(entry, "percent"), 100.0)? else {
                continue;
            };
            let id = format!("seven-day-{}", model.to_lowercase().replace(' ', "-"));
            if snapshot.windows.iter().any(|w| w.id == id.as_str().into()) {
                continue;
            }
            let mut w = window(&id, &format!("{model} weekly"), "percent");
            w.used = Some(round(used));
            w.reset_at = reset(field(entry, "resets_at"))?;
            snapshot.windows.push(w);
        }
    }
    Ok(snapshot)
}
pub fn normalize_zai(
    provider: provider::Id,
    label: &str,
    now: i64,
    quota: &JsonValue,
    subscription: Option<&JsonValue>,
) -> Result<Snapshot, Error> {
    let data = field(quota, "data").unwrap_or(quota);
    let Some(JsonValue::Array(limits)) = field(data, "limits") else {
        return Err(Error::InvalidResponse);
    };
    let mut snapshot = empty(provider, label, now, "provider_internal_api", "best_effort");
    for entry in limits {
        if !matches!(entry, JsonValue::Object(_)) {
            return Err(Error::InvalidResponse);
        }
        let kind = field(entry, "type")
            .or_else(|| field(entry, "name"))
            .and_then(text);
        let mut w = match kind {
            Some("CREDIT_LIMIT" | "TOKENS_LIMIT") => {
                let unit = required(entry, "unit")?;
                let count = required(entry, "number")?;
                if count <= 0.0 {
                    return Err(Error::InvalidResponse);
                }
                let seconds = match unit {
                    3.0 => 3600.0 * count,
                    4.0 => 86400.0 * count,
                    6.0 => 604800.0 * count,
                    _ => continue,
                };
                let mut w = window(
                    if seconds < 86400.0 {
                        "session"
                    } else {
                        "weekly"
                    },
                    if seconds < 86400.0 {
                        "Session"
                    } else {
                        "Weekly"
                    },
                    "percent",
                );
                w.used = Some(required(entry, "percentage")?.min(100.0));
                w.period_seconds = Some(integer(seconds)?);
                w
            }
            Some("TIME_LIMIT") => {
                let mut w = window("web-searches", "Web Searches", "count");
                w.used = Some(required(entry, "currentValue")?);
                w.limit = Some(required(entry, "usage")?);
                w
            }
            _ => continue,
        };
        w.reset_at = amount(field(entry, "nextResetTime"))?
            .map(integer)
            .transpose()?;
        snapshot.windows.push(w);
    }
    let plan = subscription
        .and_then(|v| field(v, "data"))
        .and_then(|v| match v {
            JsonValue::Array(a) => a.first(),
            _ => None,
        })
        .and_then(|v| field(v, "productName"))
        .and_then(text)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(plan) = plan {
        snapshot.label = format!("{label} {plan}").into();
    }
    Ok(snapshot)
}
pub fn normalize_grok(
    provider: provider::Id,
    label: &str,
    now: i64,
    response: &JsonValue,
) -> Result<Snapshot, Error> {
    let config = field(response, "config").ok_or(Error::InvalidResponse)?;
    let period = field(config, "currentPeriod").ok_or(Error::InvalidResponse)?;
    let start = field(period, "start")
        .and_then(text)
        .and_then(date_millis)
        .ok_or(Error::InvalidResponse)?;
    let end = field(period, "end")
        .and_then(text)
        .and_then(date_millis)
        .ok_or(Error::InvalidResponse)?;
    if end <= start || field(period, "type").and_then(text).is_none() {
        return Err(Error::InvalidResponse);
    }
    let used = amount(field(config, "creditUsagePercent"))?.unwrap_or(0.0);
    let cap = match field(config, "onDemandCap") {
        Some(v @ JsonValue::Object(_)) => amount(field(v, "val"))?.unwrap_or(0.0),
        None => 0.0,
        _ => return Err(Error::InvalidResponse),
    };
    let mut snapshot = empty(provider, label, now, "provider_internal_api", "best_effort");
    if field(period, "type").and_then(text) == Some("USAGE_PERIOD_TYPE_WEEKLY") {
        let mut w = window("weekly", "Weekly", "percent");
        w.used = Some(used.min(100.0));
        w.reset_at = Some(integer(end)?);
        w.period_seconds = Some(integer(((end - start) / 1000.0).floor())?);
        snapshot.windows.push(w);
    }
    let mut w = window("extra-usage", "Extra usage", "count");
    w.limit = Some(cap);
    snapshot.windows.push(w);
    Ok(snapshot)
}

pub fn normalize_organization(
    provider: provider::Id,
    label: &str,
    now: i64,
    starts: (f64, f64),
    usage: &[JsonValue],
    costs: &[JsonValue],
    meta: bool,
) -> Result<Snapshot, Error> {
    let (week, month) = starts;
    let mut snapshot = empty(provider, label, now, "provider_api", "stable");
    let usage = usage
        .iter()
        .map(|value| {
            let start = required(value, "start_time")?.trunc();
            required(value, "end_time")?;
            let Some(JsonValue::Array(results)) = field(value, "results") else {
                return Err(Error::InvalidResponse);
            };
            let mut requests = 0.0;
            let mut tokens = 0.0;
            for result in results {
                if !matches!(result, JsonValue::Object(_)) {
                    return Err(Error::InvalidResponse);
                }
                for (key, alias) in [
                    ("num_model_requests", "num_requests"),
                    ("input_tokens", "prompt_tokens"),
                    ("output_tokens", "completion_tokens"),
                ] {
                    let value = if meta {
                        amount(field(result, key).or_else(|| field(result, alias)))?.unwrap_or(0.0)
                    } else {
                        required(result, key)?
                    };
                    if key == "num_model_requests" {
                        requests += value;
                    } else {
                        tokens += value;
                    }
                }
            }
            Ok((start, requests, tokens))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let costs = costs
        .iter()
        .map(|value| {
            let start = required(value, "start_time")?.trunc();
            required(value, "end_time")?;
            let Some(JsonValue::Array(results)) = field(value, "results") else {
                return Err(Error::InvalidResponse);
            };
            let mut total = 0.0;
            for result in results {
                let amount = field(result, "amount").ok_or(Error::InvalidResponse)?;
                if field(amount, "currency").and_then(text) != Some("usd") {
                    return Err(Error::InvalidResponse);
                }
                total += required(amount, "value")?;
            }
            Ok((
                start,
                if meta && results.is_empty() {
                    None
                } else {
                    Some(total)
                },
            ))
        })
        .collect::<Result<Vec<_>, Error>>()?;
    if meta {
        let mut w = window("current-bill", "Current bill", "usd");
        w.used = costs
            .iter()
            .filter(|(start, _)| *start >= month)
            .filter_map(|(_, value)| *value)
            .reduce(|a, b| a + b);
        if costs.iter().any(|(start, _)| *start >= month)
            && month.is_finite()
            && month >= 0.0
            && month.fract() == 0.0
            && month % 86400.0 == 0.0
        {
            let (year, calendar_month, day) =
                crate::resources::catalog::models_dev::utc_calendar((month * 1000.0) as i64);
            if day == 1 {
                let (year, next_month) = if calendar_month == 12 {
                    (year + 1, 1)
                } else {
                    (year, calendar_month + 1)
                };
                w.reset_at = date_millis(&format!("{year:04}-{next_month:02}-01"))
                    .map(integer)
                    .transpose()?;
            }
        }
        snapshot.windows.push(w);
    } else {
        for (id, label, start) in [
            ("week-cost", "This week", week),
            ("month-cost", "This month", month),
        ] {
            let mut w = window(id, label, "usd");
            w.used = Some(
                costs
                    .iter()
                    .filter(|(s, _)| *s >= start)
                    .filter_map(|(_, v)| *v)
                    .sum(),
            );
            snapshot.windows.push(w);
        }
    }
    for (id, label, unit, start, tokens) in [
        ("week-requests", "Weekly requests", "requests", week, false),
        (
            "month-requests",
            "Monthly requests",
            "requests",
            month,
            false,
        ),
        ("week-tokens", "Weekly tokens", "tokens", week, true),
        ("month-tokens", "Monthly tokens", "tokens", month, true),
    ] {
        let mut w = window(id, label, unit);
        w.used = Some(
            usage
                .iter()
                .filter(|(s, _, _)| *s >= start)
                .map(|(_, r, t)| if tokens { *t } else { *r })
                .sum(),
        );
        snapshot.windows.push(w);
    }
    Ok(snapshot)
}
pub fn normalize_codex(
    provider: provider::Id,
    label: &str,
    now: i64,
    response: &JsonValue,
    source: &str,
    stability: &str,
) -> Result<Snapshot, Error> {
    if !matches!(response, JsonValue::Object(_)) {
        return Err(Error::InvalidResponse);
    }
    let root = field(response, "result")
        .filter(|v| matches!(v, JsonValue::Object(_)))
        .unwrap_or(response);
    let global = first(
        root,
        &["rateLimits", "rate_limits", "rateLimit", "rate_limit"],
    )
    .unwrap_or(root);
    if !matches!(global, JsonValue::Object(_)) {
        return Err(Error::InvalidResponse);
    }
    let mut snapshot = empty(provider, label, now, source, stability);
    let plan = first(global, &["planType", "plan_type"])
        .or_else(|| first(root, &["planType", "plan_type"]))
        .and_then(text)
        .map(str::to_lowercase);
    if let Some(plan @ ("pro" | "plus")) = plan.as_deref()
        && !label.to_lowercase().contains(plan)
    {
        snapshot.label = format!("{label} {}", capitalize(plan)).into();
    }
    codex_windows(
        &mut snapshot.windows,
        global,
        first(global, &["limitId", "limit_id"])
            .and_then(text)
            .unwrap_or("codex"),
        false,
    )?;
    if let Some(JsonValue::Object(by_id)) =
        first(root, &["rateLimitsByLimitId", "rate_limits_by_limit_id"])
    {
        for (id, value) in by_id.iter() {
            codex_windows(
                &mut snapshot.windows,
                value,
                id.as_str().ok_or(Error::InvalidResponse)?,
                true,
            )?;
        }
    }
    if let Some(JsonValue::Array(additional)) =
        first(root, &["additionalRateLimits", "additional_rate_limits"])
    {
        for (index, value) in additional.iter().enumerate() {
            if !matches!(value, JsonValue::Object(_)) {
                continue;
            }
            let limits = first(value, &["rateLimit", "rate_limit"]).unwrap_or(value);
            let id = first(
                value,
                &[
                    "limitId",
                    "limit_id",
                    "limitName",
                    "limit_name",
                    "meteredFeature",
                    "metered_feature",
                ],
            )
            .and_then(text)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("additional-{}", index + 1));
            codex_windows(&mut snapshot.windows, limits, &id, true)?;
        }
    }
    if let Some(credits) = first(root, &["rateLimitResetCredits", "rate_limit_reset_credits"])
        && let Some(available) = numeric(
            first(credits, &["availableCount", "available_count"]),
            9007199254740991.0,
        )?
    {
        let mut w = window("reset-credits", "Reset credits", "count");
        w.remaining = Some(available);
        snapshot.windows.push(w);
    }
    let reached = first(global, &["rateLimitReachedType", "rate_limit_reached_type"])
        .or_else(|| first(root, &["rateLimitReachedType", "rate_limit_reached_type"]))
        .and_then(text)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let spend = first(global, &["spendControlReached", "spend_control_reached"])
        .or_else(|| first(root, &["spendControlReached", "spend_control_reached"]))
        == Some(&JsonValue::Bool(true));
    let messages = [
        reached.map(|s| format!("Reached: {s}")),
        spend.then(|| "Spend control reached".into()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if !messages.is_empty() {
        snapshot.message = Some(messages.join(" · ").into());
    }
    Ok(snapshot)
}
fn codex_windows(
    windows: &mut Vec<Window>,
    value: &JsonValue,
    id: &str,
    named: bool,
) -> Result<(), Error> {
    if !matches!(value, JsonValue::Object(_)) {
        return Err(Error::InvalidResponse);
    }
    let label = limit_label(id);
    for (keys, kind, fallback) in [
        (
            ["primary", "primaryWindow", "primary_window"],
            "primary",
            "5-hour",
        ),
        (
            ["secondary", "secondaryWindow", "secondary_window"],
            "secondary",
            "Weekly",
        ),
    ] {
        let Some(value) = first(value, &keys).filter(|v| **v != JsonValue::Null) else {
            continue;
        };
        if !matches!(value, JsonValue::Object(_)) {
            return Err(Error::InvalidResponse);
        }
        let Some(used) = numeric(first(value, &["usedPercent", "used_percent"]), 100.0)? else {
            continue;
        };
        let minutes = numeric(
            first(value, &["windowDurationMins", "window_duration_mins"]),
            9007199254740991.0,
        )?
        .or(numeric(
            first(value, &["limitWindowSeconds", "limit_window_seconds"]),
            9007199254740991.0,
        )?
        .map(|s| s / 60.0));
        let label = if minutes == Some(300.0) {
            if named {
                format!("{label} 5-hour")
            } else {
                "5-hour".into()
            }
        } else if minutes == Some(10080.0) {
            if named {
                format!("{label} weekly")
            } else {
                "Weekly".into()
            }
        } else if named {
            format!("{label} {kind}")
        } else {
            fallback.into()
        };
        let mut w = window(&safe_id(&format!("{id}-{kind}")), &label, "percent");
        w.used = Some(used);
        w.reset_at = reset(first(
            value,
            &["resetsAt", "resets_at", "resetAt", "reset_at"],
        ))?;
        w.period_seconds = minutes.map(|n| integer((n * 60.0).trunc())).transpose()?;
        windows.push(w);
    }
    if let Some(credits @ JsonValue::Object(_)) = field(value, "credits")
        && first(credits, &["hasCredits", "has_credits"]) != Some(&JsonValue::Bool(false))
    {
        let unlimited = field(credits, "unlimited") == Some(&JsonValue::Bool(true));
        let balance = money(field(credits, "balance"))?;
        if unlimited || balance.is_some() {
            let mut w = window(
                &safe_id(&format!("{id}-credits")),
                &if named {
                    format!("{label} credits")
                } else {
                    "Credits".into()
                },
                "usd",
            );
            w.unlimited = unlimited.then_some(true);
            w.remaining = balance;
            windows.push(w);
        }
    }
    if let Some(value @ JsonValue::Object(_)) =
        first(value, &["individualLimit", "individual_limit"])
    {
        let limit = money(first(
            value,
            &["limit", "total", "monthlyLimit", "monthly_limit"],
        ))?;
        let used = money(first(value, &["used", "spent", "current"]))?;
        if limit.is_some() || used.is_some() {
            let mut w = window(
                &safe_id(&format!("{id}-monthly-credits")),
                &if named {
                    format!("{label} monthly credits")
                } else {
                    "Monthly credits".into()
                },
                "usd",
            );
            w.limit = limit;
            w.used = used;
            w.remaining = used
                .zip(limit)
                .map(|(used, limit)| round((limit - used).max(0.0)));
            windows.push(w);
        }
    }
    Ok(())
}
pub(crate) fn first<'a>(value: &'a JsonValue, keys: &[&str]) -> Option<&'a JsonValue> {
    keys.iter()
        .find_map(|key| field(value, key).filter(|v| **v != JsonValue::Null))
}
fn required(value: &JsonValue, key: &str) -> Result<f64, Error> {
    amount(field(value, key))?.ok_or(Error::InvalidResponse)
}
fn numeric(value: Option<&JsonValue>, maximum: f64) -> Result<Option<f64>, Error> {
    let parsed = match value {
        Some(JsonValue::String(s)) => Some(JsonValue::Number(
            s.as_str()
                .ok_or(Error::InvalidResponse)?
                .trim()
                .parse::<f64>()
                .map_err(|_| Error::InvalidResponse)?,
        )),
        _ => None,
    };
    let number = amount(parsed.as_ref().or(value))?;
    if number.is_some_and(|n| n > maximum) {
        return Err(Error::InvalidResponse);
    }
    Ok(number)
}
fn money(value: Option<&JsonValue>) -> Result<Option<f64>, Error> {
    if value.and_then(text) == Some("") {
        return Ok(None);
    }
    Ok(numeric(value, f64::MAX)?.map(round))
}
pub(crate) fn reset(value: Option<&JsonValue>) -> Result<Option<NonNegativeInt>, Error> {
    if matches!(value, None | Some(JsonValue::Null)) || value.and_then(text) == Some("") {
        return Ok(None);
    }
    if let Ok(Some(number)) = numeric(value, 9007199254740991.0) {
        return Ok(Some(integer(
            (if number < 10000000000.0 {
                number * 1000.0
            } else {
                number
            })
            .trunc(),
        )?));
    }
    Ok(Some(integer(
        value
            .and_then(text)
            .and_then(date_millis)
            .ok_or(Error::InvalidResponse)?,
    )?))
}
fn integer(number: f64) -> Result<NonNegativeInt, Error> {
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 || number > 9007199254740991.0 {
        return Err(Error::InvalidResponse);
    }
    NonNegativeInt::new(number as i64).map_err(|_| Error::InvalidResponse)
}
fn round(number: f64) -> f64 {
    (number * 100.0).round() / 100.0
}
fn capitalize(value: &str) -> String {
    let mut c = value.chars();
    c.next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_default()
        + c.as_str()
}
fn limit_label(value: &str) -> String {
    if value.to_ascii_lowercase().contains("spark") {
        return "Spark".into();
    }
    let value = if value
        .get(..5)
        .is_some_and(|value| value.eq_ignore_ascii_case("codex"))
    {
        value[5..].trim_start_matches(['-', '_'])
    } else {
        value
    };
    let label = value
        .split(['-', '_'])
        .filter(|s| !s.is_empty())
        .map(capitalize)
        .collect::<Vec<_>>()
        .join(" ");
    if label.is_empty() {
        "Codex".into()
    } else {
        label
    }
}
fn safe_id(value: &str) -> String {
    let mut result = String::new();
    for c in value.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || "._-".contains(c) {
            result.push(c);
        } else if !result.ends_with('-') {
            result.push('-');
        }
    }
    result.trim_matches('-').into()
}
