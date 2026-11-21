use crate::{
    connector::mcp::json,
    convert,
    dispatch::{Failure, Invocation},
};
use prost::{Message, Name};
use ycoding_core::telemetry::Error;
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, telemetry,
};
use ycoding_protocol::{domain_json, limits, v5};

pub async fn consent_get(
    invocation: Invocation,
    _: v5::TelemetryConsentGetRequest,
) -> Result<v5::TelemetryConsentGetResult, Failure> {
    let state = invocation.core()?.telemetry.consent().map_err(failure)?;
    Ok(v5::TelemetryConsentGetResult {
        data: v5::TelemetryConsentState {
            notice_version: 1.0,
            consent: state.consent.map(consent_wire),
        },
    })
}
pub async fn consent_set(
    invocation: Invocation,
    request: v5::TelemetryConsentSetRequest,
) -> Result<v5::TelemetryConsentSetResult, Failure> {
    let input = telemetry::ConsentInput::decode(
        &ObjectEncoder::new()
            .field("enabled", &request.payload.enabled)
            .field(
                "noticeVersion",
                &JsonValue::Number(request.payload.notice_version),
            )
            .finish(),
    )
    .map_err(|_| Failure::Invalid("Invalid telemetry consent".into()))?;
    Ok(v5::TelemetryConsentSetResult {
        data: consent_wire(
            invocation
                .core()?
                .telemetry
                .set_consent(input)
                .await
                .map_err(failure)?,
        ),
    })
}
pub async fn append(
    invocation: Invocation,
    request: v5::TelemetryAppendRequest,
) -> Result<v5::TelemetryAppendResult, Failure> {
    let input = domain_json::decode(
        &v5::TelemetryBatch::full_name(),
        &request.payload.encode_to_vec(),
    )
    .map_err(|_| invalid_sample())?;
    let batch = telemetry::Batch::decode(&json::value(&input)).map_err(|_| invalid_sample())?;
    Ok(v5::TelemetryAppendResult {
        accepted: invocation
            .core()?
            .telemetry
            .append(batch.samples)
            .await
            .map_err(failure)? as i64,
    })
}
pub async fn list(
    invocation: Invocation,
    request: v5::TelemetryListRequest,
) -> Result<v5::TelemetryListResult, Failure> {
    let before = request
        .query
        .before
        .as_ref()
        .map(convert::domain)
        .transpose()?;
    let before = before
        .as_ref()
        .map(|value| {
            value
                .to_utf8()
                .map_err(|_| Failure::InvalidCursor("Invalid telemetry cursor".into()))
        })
        .transpose()?;
    let limit = request
        .query
        .limit
        .map(|limit| {
            usize::try_from(limit).map_err(|_| Failure::Invalid("Invalid telemetry limit".into()))
        })
        .transpose()?;
    let page = invocation
        .core()?
        .telemetry
        .list(limit, before.as_deref())
        .await
        .map_err(failure)?;
    let unavailable = |_| Failure::Unavailable("Telemetry page cannot be encoded".into());
    let bytes = domain_json::encode(
        &v5::TelemetryPage::full_name(),
        &convert::json_domain(&page.encode()),
        limits::INLINE_BODY_BYTES as usize,
    )
    .map_err(unavailable)?;
    let data = v5::TelemetryPage::decode(bytes.as_slice())
        .map_err(|_| Failure::Unavailable("Telemetry page cannot be decoded".into()))?;
    Ok(v5::TelemetryListResult { data })
}
fn consent_wire(consent: telemetry::Consent) -> v5::TelemetryConsent {
    v5::TelemetryConsent {
        enabled: consent.enabled,
        notice_version: 1.0,
        decided_at: consent.decided_at.get() as u64,
    }
}
fn failure(error: Error) -> Failure {
    match error {
        Error::Disabled => Failure::TelemetryDisabled,
        Error::InvalidSample => invalid_sample(),
        Error::InvalidConsent => Failure::Invalid("Invalid telemetry consent".into()),
        Error::InvalidCursor => Failure::InvalidCursor("Invalid telemetry cursor".into()),
        Error::InvalidLimit => Failure::Invalid("Invalid telemetry limit".into()),
        Error::Storage | Error::Derived => {
            Failure::Unavailable("Telemetry store unavailable".into())
        }
    }
}
fn invalid_sample() -> Failure {
    Failure::InvalidField {
        message: "Invalid telemetry sample".into(),
        field: "samples",
    }
}
