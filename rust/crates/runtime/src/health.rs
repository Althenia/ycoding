use crate::dispatch::{Failure, Invocation};
use ycoding_protocol::v5;

pub async fn stop(
    _invocation: Invocation,
    _request: v5::HealthStopRequest,
) -> Result<v5::HealthStopResult, Failure> {
    Ok(v5::HealthStopResult {
        data: v5::ServiceStopResponse { accepted: false },
    })
}
