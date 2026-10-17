use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use ycoding_core::telemetry::Error;
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, schema::Int, telemetry,
};
use ycoding_protocol::v5;

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
    let samples = request
        .payload
        .samples
        .items
        .iter()
        .map(sample_domain)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(v5::TelemetryAppendResult {
        accepted: invocation
            .core()?
            .telemetry
            .append(samples)
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
    Ok(v5::TelemetryListResult {
        data: v5::TelemetryPage {
            data: v5::TelemetryPageData {
                items: page
                    .data
                    .into_iter()
                    .map(|row| {
                        Ok(v5::TelemetryPageDataItem {
                            received_at: row.received_at.get() as u64,
                            sample: sample_wire(row.sample)?,
                        })
                    })
                    .collect::<Result<_, Failure>>()?,
            },
            cursor: v5::TelemetryPageCursor {
                next: page.cursor.next.as_ref().map(convert::wire),
            },
        },
    })
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
fn integer(value: u64) -> Result<Int, Failure> {
    Int::new(i64::try_from(value).map_err(|_| invalid_sample())?).map_err(|_| invalid_sample())
}
const OPERATIONS: [telemetry::Operation; 77] = [
    telemetry::Operation::V0,
    telemetry::Operation::V1,
    telemetry::Operation::V2,
    telemetry::Operation::V3,
    telemetry::Operation::V4,
    telemetry::Operation::V5,
    telemetry::Operation::V6,
    telemetry::Operation::V7,
    telemetry::Operation::V8,
    telemetry::Operation::V9,
    telemetry::Operation::V10,
    telemetry::Operation::V11,
    telemetry::Operation::V12,
    telemetry::Operation::V13,
    telemetry::Operation::V14,
    telemetry::Operation::V15,
    telemetry::Operation::V16,
    telemetry::Operation::V17,
    telemetry::Operation::V18,
    telemetry::Operation::V19,
    telemetry::Operation::V20,
    telemetry::Operation::V21,
    telemetry::Operation::V22,
    telemetry::Operation::V23,
    telemetry::Operation::V24,
    telemetry::Operation::V25,
    telemetry::Operation::V26,
    telemetry::Operation::V27,
    telemetry::Operation::V28,
    telemetry::Operation::V29,
    telemetry::Operation::V30,
    telemetry::Operation::V31,
    telemetry::Operation::V32,
    telemetry::Operation::V33,
    telemetry::Operation::V34,
    telemetry::Operation::V35,
    telemetry::Operation::V36,
    telemetry::Operation::V37,
    telemetry::Operation::V38,
    telemetry::Operation::V39,
    telemetry::Operation::V40,
    telemetry::Operation::V41,
    telemetry::Operation::V42,
    telemetry::Operation::V43,
    telemetry::Operation::V44,
    telemetry::Operation::V45,
    telemetry::Operation::V46,
    telemetry::Operation::V47,
    telemetry::Operation::V48,
    telemetry::Operation::V49,
    telemetry::Operation::V50,
    telemetry::Operation::V51,
    telemetry::Operation::V52,
    telemetry::Operation::V53,
    telemetry::Operation::V54,
    telemetry::Operation::V55,
    telemetry::Operation::V56,
    telemetry::Operation::V57,
    telemetry::Operation::V58,
    telemetry::Operation::V59,
    telemetry::Operation::V60,
    telemetry::Operation::V61,
    telemetry::Operation::V62,
    telemetry::Operation::V63,
    telemetry::Operation::V64,
    telemetry::Operation::V65,
    telemetry::Operation::V66,
    telemetry::Operation::V67,
    telemetry::Operation::V68,
    telemetry::Operation::V69,
    telemetry::Operation::V70,
    telemetry::Operation::V71,
    telemetry::Operation::V72,
    telemetry::Operation::V73,
    telemetry::Operation::V74,
    telemetry::Operation::V75,
    telemetry::Operation::V76,
];
fn sample_domain(sample: &v5::TelemetrySample) -> Result<telemetry::Sample, Failure> {
    use v5::telemetry_sample::Kind;
    let sample = match sample.kind.as_ref().ok_or_else(invalid_sample)? {
        Kind::Value1(row) => telemetry::Sample::Request(telemetry::RequestSample {
            at: convert::domain(&row.at)?,
            operation: *OPERATIONS
                .get(usize::try_from(row.operation - 1).map_err(|_| invalid_sample())?)
                .ok_or_else(invalid_sample)?,
            outcome: match row.outcome {
                1 => telemetry::Outcome::Ok,
                2 => telemetry::Outcome::Failed,
                3 => telemetry::Outcome::Unknown,
                4 => telemetry::Outcome::Unavailable,
                _ => return Err(invalid_sample()),
            },
            reason: row
                .reason
                .map(|reason| match reason {
                    1 => Ok(telemetry::Reason::NotConnected),
                    2 => Ok(telemetry::Reason::InFlightLimit),
                    3 => Ok(telemetry::Reason::RequestLimit),
                    4 => Ok(telemetry::Reason::Cancelled),
                    _ => Err(invalid_sample()),
                })
                .transpose()?,
            queue_ms: integer(row.queue_ms)?,
            settlement_ms: row.settlement_ms.map(integer).transpose()?,
            total_ms: integer(row.total_ms)?,
        }),
        Kind::Value2(row) => telemetry::Sample::LongTask(telemetry::LongTaskSample {
            at: convert::domain(&row.at)?,
            duration_ms: integer(row.duration_ms)?,
        }),
        Kind::Value3(row) => telemetry::Sample::Client(telemetry::ClientSample {
            at: convert::domain(&row.at)?,
            surface: match row.surface {
                1 => telemetry::Surface::Tui,
                2 => telemetry::Surface::Web,
                _ => return Err(invalid_sample()),
            },
            metric: match row.metric {
                1 => telemetry::Metric::PromptAdmit,
                2 => telemetry::Metric::StreamDelay,
                3 => telemetry::Metric::TranscriptLoad,
                _ => return Err(invalid_sample()),
            },
            duration_ms: integer(row.duration_ms)?,
        }),
    };
    telemetry::Sample::decode(&sample.encode()).map_err(|_| invalid_sample())
}
fn sample_wire(sample: telemetry::Sample) -> Result<v5::TelemetrySample, Failure> {
    use v5::telemetry_sample::Kind;
    Ok(v5::TelemetrySample {
        kind: Some(match sample {
            telemetry::Sample::Request(row) => Kind::Value1(v5::TelemetryRequestSample {
                kind: 1,
                at: convert::wire(&row.at),
                operation: OPERATIONS
                    .iter()
                    .position(|operation| *operation == row.operation)
                    .ok_or_else(|| {
                        Failure::Unavailable(
                            "Stored telemetry operation is not representable".into(),
                        )
                    })? as i32
                    + 1,
                outcome: match row.outcome {
                    telemetry::Outcome::Ok => 1,
                    telemetry::Outcome::Failed => 2,
                    telemetry::Outcome::Unknown => 3,
                    telemetry::Outcome::Unavailable => 4,
                },
                reason: row.reason.map(|reason| match reason {
                    telemetry::Reason::NotConnected => 1,
                    telemetry::Reason::InFlightLimit => 2,
                    telemetry::Reason::RequestLimit => 3,
                    telemetry::Reason::Cancelled => 4,
                }),
                queue_ms: row.queue_ms.get() as u64,
                settlement_ms: row.settlement_ms.map(|ms| ms.get() as u64),
                total_ms: row.total_ms.get() as u64,
            }),
            telemetry::Sample::LongTask(row) => Kind::Value2(v5::TelemetryLongTaskSample {
                kind: 1,
                at: convert::wire(&row.at),
                duration_ms: row.duration_ms.get() as u64,
            }),
            telemetry::Sample::Client(row) => Kind::Value3(v5::TelemetryClientSample {
                kind: 1,
                at: convert::wire(&row.at),
                surface: match row.surface {
                    telemetry::Surface::Tui => 1,
                    telemetry::Surface::Web => 2,
                },
                metric: match row.metric {
                    telemetry::Metric::PromptAdmit => 1,
                    telemetry::Metric::StreamDelay => 2,
                    telemetry::Metric::TranscriptLoad => 3,
                },
                duration_ms: row.duration_ms.get() as u64,
            }),
        }),
    })
}
