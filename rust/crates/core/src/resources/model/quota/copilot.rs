use super::{Error, amount, empty, normalize_copilot, window};
use crate::resources::catalog::{
    field,
    models_dev::{date_millis, text},
};
use std::future::Future;
use ycoding_schema::{JsonValue, provider, provider_usage::Snapshot};

#[derive(Clone, Debug, PartialEq)]
pub struct BillingResult {
    pub snapshot: Snapshot,
    pub matched: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct CopilotResult {
    pub snapshot: Snapshot,
    pub matched_org: Option<String>,
}
pub fn normalize_copilot_billing(
    provider: provider::Id,
    label: &str,
    now: i64,
    response: &JsonValue,
) -> Result<BillingResult, Error> {
    let items = billing_items(response)?;
    let mut quantity = None;
    let mut spend = None;
    for item in items {
        if !field(item, "product")
            .and_then(text)
            .is_some_and(|s| s.eq_ignore_ascii_case("copilot"))
            || !field(item, "unitType").and_then(text).is_some_and(|s| {
                ["ai-units", "ai-credits"]
                    .iter()
                    .any(|unit| s.eq_ignore_ascii_case(unit))
            })
        {
            continue;
        }
        if let Some(value) = amount(field(item, "grossQuantity"))? {
            quantity = Some(quantity.unwrap_or(0.0) + value);
        }
        if let Some(value) = amount(field(item, "netAmount"))? {
            spend = Some(spend.unwrap_or(0.0) + value);
        }
    }
    let mut snapshot = empty(provider, label, now, "provider_api", "stable");
    for (id, label, unit, value) in [
        ("org-credits", "Org credits", "count", quantity),
        ("org-spend", "Org spend", "usd", spend),
    ] {
        if let Some(used) = value {
            let mut w = window(id, label, unit);
            w.used = Some(used);
            snapshot.windows.push(w);
        }
    }
    Ok(BillingResult {
        matched: !snapshot.windows.is_empty(),
        snapshot,
    })
}
pub async fn load_copilot<F, Fut>(
    provider: provider::Id,
    label: &str,
    now: i64,
    remembered: Option<&str>,
    mut request: F,
) -> Result<CopilotResult, Error>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<JsonValue, Error>>,
{
    let status = request("/copilot_internal/user".into()).await?;
    let mut personal = normalize_copilot(provider.clone(), label, now, &status)?;
    if field(&status, "token_based_billing") != Some(&JsonValue::Bool(true))
        || personal
            .windows
            .iter()
            .any(|w| w.id == "credits".into() && w.unit == "percent".into())
    {
        return Ok(CopilotResult {
            snapshot: personal,
            matched_org: None,
        });
    }
    if let Some(remembered) = remembered
        && let Some(organization) =
            organization(&provider, label, now, remembered, &mut request).await?
    {
        return Ok(combine(personal, organization));
    }
    let organizations = request("/user/orgs".into()).await;
    if let Ok(JsonValue::Array(organizations)) = organizations
        && organizations.iter().all(|organization| {
            field(organization, "login").is_some_and(|v| matches!(v, JsonValue::String(_)))
        })
    {
        for login in organizations
            .iter()
            .filter_map(|v| field(v, "login").and_then(text))
            .filter(|login| Some(*login) != remembered)
        {
            if let Some(organization) =
                organization(&provider, label, now, login, &mut request).await?
            {
                return Ok(combine(personal, organization));
            }
        }
    }
    if personal.windows.is_empty() {
        personal = empty(provider, label, now, "provider_api", "stable");
    }
    Ok(CopilotResult {
        snapshot: personal,
        matched_org: None,
    })
}
async fn organization<F, Fut>(
    provider: &provider::Id,
    label: &str,
    now: i64,
    login: &str,
    request: &mut F,
) -> Result<Option<CopilotResult>, Error>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<JsonValue, Error>>,
{
    let encoded = login
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    let Ok(response) = request(format!("/orgs/{encoded}/settings/billing/usage/summary")).await
    else {
        return Ok(None);
    };
    if billing_items(&response).is_err() {
        return Ok(None);
    }
    let result = normalize_copilot_billing(provider.clone(), label, now, &response)?;
    Ok(result.matched.then(|| CopilotResult {
        snapshot: result.snapshot,
        matched_org: Some(login.into()),
    }))
}
fn combine(mut personal: Snapshot, organization: CopilotResult) -> CopilotResult {
    if personal.windows.is_empty() {
        return organization;
    }
    personal.windows.extend(organization.snapshot.windows);
    CopilotResult {
        snapshot: personal,
        matched_org: organization.matched_org,
    }
}
fn billing_items(response: &JsonValue) -> Result<&[JsonValue], Error> {
    let Some(JsonValue::Array(items)) = field(response, "usageItems") else {
        return Err(Error::InvalidResponse);
    };
    if field(response, "organization").is_some_and(|v| !matches!(v, JsonValue::String(_))) {
        return Err(Error::InvalidResponse);
    }
    for item in items {
        if !matches!(item, JsonValue::Object(_)) {
            return Err(Error::InvalidResponse);
        }
        for key in ["product", "unitType"] {
            if field(item, key).is_some_and(|v| !matches!(v, JsonValue::String(_))) {
                return Err(Error::InvalidResponse);
            }
        }
        for key in ["grossQuantity", "netAmount"] {
            if field(item, key).is_some_and(|v| !matches!(v, JsonValue::Number(_))) {
                return Err(Error::InvalidResponse);
            }
        }
    }
    Ok(items)
}
pub(super) fn validate(response: &JsonValue) -> Result<(), Error> {
    if !matches!(response, JsonValue::Object(_)) {
        return Err(Error::InvalidResponse);
    }
    for key in [
        "copilot_plan",
        "quota_reset_date",
        "quota_reset_date_utc",
        "limited_user_reset_date",
    ] {
        if field(response, key).is_some_and(|v| !matches!(v, JsonValue::String(_))) {
            return Err(Error::InvalidResponse);
        }
    }
    if field(response, "token_based_billing").is_some_and(|v| !matches!(v, JsonValue::Bool(_))) {
        return Err(Error::InvalidResponse);
    }
    for key in ["limited_user_quotas", "monthly_quotas"] {
        if let Some(value) = field(response, key) {
            let JsonValue::Object(values) = value else {
                return Err(Error::InvalidResponse);
            };
            if values
                .iter()
                .any(|(_, v)| !matches!(v, JsonValue::Number(_)))
            {
                return Err(Error::InvalidResponse);
            }
        }
    }
    if let Some(quota) = field(response, "quota_snapshots") {
        let JsonValue::Object(quotas) = quota else {
            return Err(Error::InvalidResponse);
        };
        for (_, value) in quotas.iter() {
            if *value == JsonValue::Null {
                continue;
            }
            if !matches!(value, JsonValue::Object(_)) {
                return Err(Error::InvalidResponse);
            }
            for key in [
                "entitlement",
                "remaining",
                "quota_remaining",
                "percent_remaining",
                "overage_count",
                "credits_used",
            ] {
                if field(value, key).is_some_and(|v| !matches!(v, JsonValue::Number(_))) {
                    return Err(Error::InvalidResponse);
                }
            }
            for key in ["overage_permitted", "unlimited"] {
                if field(value, key).is_some_and(|v| !matches!(v, JsonValue::Bool(_))) {
                    return Err(Error::InvalidResponse);
                }
            }
        }
    }
    Ok(())
}
pub(super) fn reset(
    value: Option<&JsonValue>,
) -> Result<Option<ycoding_schema::schema::NonNegativeInt>, Error> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = text(value).ok_or(Error::InvalidResponse)?;
    if value.is_empty() {
        return Ok(None);
    }
    let millis = date_millis(value)
        .filter(|millis| *millis >= 0.0)
        .ok_or(Error::InvalidResponse)?;
    Ok(Some(
        ycoding_schema::schema::NonNegativeInt::new(millis as i64)
            .map_err(|_| Error::InvalidResponse)?,
    ))
}
