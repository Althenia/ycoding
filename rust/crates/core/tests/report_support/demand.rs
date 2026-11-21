use ycoding_core::{ycoding_schema, ycoding_store::Client};

pub fn prepare(
    client: &Client,
    scope: Option<&ycoding_schema::session::Id>,
    inputs: &[ycoding_schema::provider_request::ReportInput],
) -> Result<(), ycoding_core::ycoding_store::Error> {
    let sessions = ycoding_core::session::store::Service::new(client.clone());
    let summary = match scope {
        Some(scope) => sessions.usage(scope),
        None => sessions.usage_all(),
    }
    .map(|_| ());
    let reports = inputs.iter().map(|input| {
        match scope {
            Some(scope) => sessions.usage_report(scope, input),
            None => sessions.usage_report_all(input),
        }
        .map(|_| ())
    });
    for result in std::iter::once(summary).chain(reports) {
        match result {
            Ok(())
            | Err(ycoding_core::ycoding_store::Error::Domain {
                kind: "Usage.PreparedUnavailable",
                ..
            }) => {}
            Err(error) => return Err(error),
        }
    }
    client
        .analytics()
        .and_then(|handle| handle.prepare_presentations())
        .map_err(|error| ycoding_core::ycoding_store::Error::Record(Box::new(error)))
}
