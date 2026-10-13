use crate::{
    convert,
    dispatch::{Failure, Invocation},
    session_read_models,
};
use ycoding_core::ycoding_store::Error;
use ycoding_protocol::v5;

pub async fn get(
    invocation: Invocation,
    _request: v5::UsageGetRequest,
) -> Result<v5::UsageGetResult, Failure> {
    let core = invocation.core()?;
    let summary = core
        .sessions
        .usage_all(core.usage_pricer.as_deref().map(|pricer| pricer as &_))
        .map_err(failure)?;
    Ok(v5::UsageGetResult {
        data: convert::provider_summary(&summary).map_err(|_| {
            Failure::Unavailable("stored Session state is not representable on the wire".into())
        })?,
    })
}

pub async fn report(
    invocation: Invocation,
    request: v5::UsageReportRequest,
) -> Result<v5::UsageReportResult, Failure> {
    let core = invocation.core()?;
    let query = request.query;
    let input = session_read_models::report_input(&v5::SessionUsageReportRequestQuery {
        group: query.group,
        time_zone: query.time_zone,
        from: query.from,
        to: query.to,
        offset: query.offset,
        limit: query.limit,
        sort: query.sort,
        order: query.order,
    })?;
    let report = core
        .sessions
        .usage_report_all(
            &input,
            core.usage_pricer.as_deref().map(|pricer| pricer as &_),
        )
        .map_err(failure)?;
    Ok(v5::UsageReportResult {
        data: session_read_models::wire_report(&report)?,
    })
}

fn failure(error: Error) -> Failure {
    match error {
        Error::Rejected(message) => Failure::InvalidField {
            message: message.into(),
            field: "timeZone",
        },
        _ => Failure::Unavailable("Usage store unavailable".into()),
    }
}
