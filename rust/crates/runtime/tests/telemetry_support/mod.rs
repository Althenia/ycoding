use prost::Message;
use ycoding_protocol::v5;

pub fn batch(samples: Vec<v5::TelemetrySample>) -> Vec<u8> {
    v5::TelemetryAppendRequest {
        payload: v5::TelemetryBatch {
            samples: v5::TelemetryBatchSamples { items: samples },
        },
    }
    .encode_to_vec()
}
pub fn query(limit: Option<u64>, before: Option<v5::LosslessString>) -> Vec<u8> {
    v5::TelemetryListRequest {
        query: v5::TelemetryListRequestQuery { limit, before },
    }
    .encode_to_vec()
}
pub fn consent(enabled: bool, notice_version: f64) -> Vec<u8> {
    v5::TelemetryConsentSetRequest {
        payload: v5::TelemetryConsentInput {
            enabled,
            notice_version,
        },
    }
    .encode_to_vec()
}
