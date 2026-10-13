use crate::{
    convert, cursor,
    dispatch::{Failure, Invocation},
};
use ycoding_core::session::list::{Order, Parent, Query, Scope};
use ycoding_core::ycoding_schema::{
    project_id::ProjectId,
    schema::{AbsolutePath, Finite},
    session,
    workspace_id::WorkspaceId,
};
use ycoding_protocol::{limits, v5};

const DEFAULT_LIMIT: usize = 50;

pub async fn list(
    invocation: Invocation,
    request: v5::SessionListRequest,
) -> Result<v5::SessionListResult, Failure> {
    let core = invocation.core()?;
    let limit = request
        .query
        .limit
        .map_or(DEFAULT_LIMIT, |limit| limit as usize);
    let query = match &request.query.cursor {
        Some(cursor) => cursor::decode_list(
            &convert::domain(cursor)?
                .to_utf8()
                .map_err(|_| Failure::InvalidCursor("Invalid cursor".into()))?,
            limits::INLINE_BODY_BYTES as usize,
        )?,
        None => query(&request.query)?,
    };
    let sessions = core
        .sessions
        .list(&Query {
            limit: Some(limit),
            ..query.clone()
        })
        .map_err(|_| Failure::Unavailable("Session store unavailable".into()))?;
    let link = |info: &session::Info, direction: &str| -> Result<v5::LosslessString, Failure> {
        let anchor = session::ListAnchor {
            id: info.id.clone(),
            time: Finite::new(info.time.updated.epoch_millis() as f64)
                .map_err(|_| unrepresentable())?,
            direction: direction.into(),
        };
        Ok(convert::text(&cursor::encode_list(&query, &anchor)))
    };
    Ok(v5::SessionListResult {
        data: v5::SessionsResponse {
            cursor: v5::SessionsResponseCursor {
                previous: sessions
                    .first()
                    .map(|info| link(info, "previous"))
                    .transpose()?,
                next: sessions.last().map(|info| link(info, "next")).transpose()?,
            },
            data: v5::SessionsResponseData {
                items: sessions
                    .iter()
                    .map(convert::session_info)
                    .collect::<Result<_, _>>()
                    .map_err(|_| unrepresentable())?,
            },
        },
    })
}

fn query(query: &v5::SessionsQuery) -> Result<Query, Failure> {
    let directory = query
        .directory
        .as_ref()
        .map(convert::identifier::<AbsolutePath>)
        .transpose()?;
    let project = query
        .project
        .as_ref()
        .map(convert::identifier::<ProjectId>)
        .transpose()?;
    let scope = match (directory, project) {
        (Some(directory), _) => Scope::Directory(directory.as_lossless().clone()),
        (None, Some(project)) => Scope::Project(project.as_lossless().clone()),
        (None, None) => Scope::All,
    };
    let parent = match query
        .parent_id
        .as_ref()
        .and_then(|parent| parent.kind.as_ref())
    {
        Some(v5::sessions_query_parent_id::Kind::Value1(id)) => {
            Some(Parent::Child(convert::identifier::<session::Id>(id)?))
        }
        Some(v5::sessions_query_parent_id::Kind::Clear(_)) => Some(Parent::Root),
        None => None,
    };
    let order = match query.order.map(v5::SessionsQueryOrder::try_from) {
        Some(Ok(v5::SessionsQueryOrder::SessionsqueryOrderAsc)) => Order::Ascending,
        Some(Ok(v5::SessionsQueryOrder::SessionsqueryOrderDesc)) | None => Order::Descending,
        Some(_) => return Err(Failure::Invalid("invalid order".into())),
    };
    Ok(Query {
        scope,
        workspace: query
            .workspace
            .as_ref()
            .map(convert::identifier::<WorkspaceId>)
            .transpose()?
            .map(|workspace| workspace.as_lossless().clone()),
        search: query.search.as_ref().map(convert::domain).transpose()?,
        parent,
        order,
        limit: None,
        anchor: None,
    })
}

fn unrepresentable() -> Failure {
    Failure::Unavailable("stored Session is not representable on the wire".into())
}
