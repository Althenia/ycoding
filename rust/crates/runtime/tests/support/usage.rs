use ycoding_core::ycoding_schema::{LosslessString, parse_json};
use ycoding_core::ycoding_store::{
    Error, KeyPart, Write,
    resources::{Request, RequestTable, UsageAnalyticsRequest, UsageAnalyticsRequestTable},
    session::{Document, SessionTable},
    tuple_key,
};

pub fn retained(tx: &mut Write<'_>, request: &Request) -> Result<(), Error> {
    let session = tx
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&request.session_id)]))?
        .ok_or(Error::Rejected(
            "retained usage requires the request Session",
        ))?;
    RequestTable::insert(tx, request)?;
    UsageAnalyticsRequestTable::insert(
        tx,
        &UsageAnalyticsRequest {
            id: request.id.clone(),
            session_id: request.session_id.clone(),
            project_id: session.project_id,
            directory: session.directory,
            workspace_id: session.workspace_id,
            session_updated: session.time_updated,
            agent: request.agent.clone(),
            source: request.source.clone(),
            model: request.model.clone(),
            usage_anchor: request.usage_anchor.clone(),
            task_path: Document::new(parse_json("[]").unwrap())?,
            request: request.request,
            attempts: request.attempts,
            continuation: request.continuation.clone(),
            invalidation: request.invalidation.clone(),
            prompt_cache_key: LosslessString::from_utf16(
                request.prompt_cache_key.code_units().take(8).collect(),
            ),
            cache_read_reported: request.cache_read_reported,
            tokens: request.tokens.clone(),
            cost: request.cost,
            timing: request.timing.clone(),
            time_created: request.time_created,
        },
    )
}
