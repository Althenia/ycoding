use crate::{
    convert,
    dispatch::{Failure, Invocation},
    ids,
};
use ycoding_core::tools::policy::{Effect, Error as AuthorityError, permissions::Error};
use ycoding_core::ycoding_schema::{
    DomainDecode, JsonValue, permission, permission_saved, project_id::ProjectId,
    session_id::SessionId,
};
use ycoding_protocol::v5;

pub async fn create(
    invocation: Invocation,
    request: v5::SessionPermissionCreateRequest,
) -> Result<v5::SessionPermissionCreateResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    let payload = request.payload;
    let id = match &payload.id {
        Some(id) => convert::identifier::<permission::Id>(id)?,
        None => ids::prefixed("per_")
            .and_then(permission::Id::new)
            .map_err(|_| Failure::Unavailable("permission ID generation failed".into()))?,
    };
    let admission = services
        .permissions
        .ask(
            permission::Request {
                id,
                session_id: session,
                action: convert::domain(&payload.action)?,
                resources: payload
                    .resources
                    .items
                    .iter()
                    .map(convert::domain)
                    .collect::<Result<_, _>>()?,
                save: payload
                    .save
                    .map(|save| save.items.iter().map(convert::domain).collect())
                    .transpose()?,
                metadata: payload
                    .metadata
                    .map(|metadata| {
                        convert::object_domain(
                            metadata
                                .entries
                                .iter()
                                .map(|entry| (&entry.key, &entry.value)),
                        )
                    })
                    .transpose()?,
                source: payload
                    .source
                    .map(|source| {
                        Ok::<_, Failure>(permission::Source {
                            message_id: convert::domain(&source.message_id)?,
                            call_id: convert::domain(&source.call_id)?,
                        })
                    })
                    .transpose()?,
            },
            payload.agent.as_ref().map(convert::domain).transpose()?,
        )
        .map_err(failure)?;
    Ok(v5::SessionPermissionCreateResult {
        data: v5::SessionPermissionCreateResultData {
            id: convert::identity(&admission.id)?,
            effect: match admission.effect {
                Effect::Allow => v5::PermissionEffect::Allow,
                Effect::Deny => v5::PermissionEffect::Deny,
                Effect::Ask => v5::PermissionEffect::Ask,
            } as i32,
        },
    })
}

pub async fn list(
    invocation: Invocation,
    request: v5::SessionPermissionListRequest,
) -> Result<v5::SessionPermissionListResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    Ok(v5::SessionPermissionListResult {
        data: v5::SessionPermissionListResultData {
            items: services
                .permissions
                .for_session(&session)
                .iter()
                .map(wire)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn get(
    invocation: Invocation,
    request: v5::SessionPermissionGetRequest,
) -> Result<v5::SessionPermissionGetResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    let id = convert::identifier::<permission::Id>(&request.params.request_id)?;
    let owned = services
        .permissions
        .get(&id)
        .filter(|found| found.session_id == session)
        .ok_or_else(|| missing(&request.params.request_id))?;
    Ok(v5::SessionPermissionGetResult {
        data: wire(&owned)?,
    })
}

pub async fn reply(
    invocation: Invocation,
    request: v5::SessionPermissionReplyRequest,
) -> Result<v5::SessionPermissionReplyResult, Failure> {
    let session = invocation.session(&request.params.session_id)?;
    let (_, services) = invocation.core()?.locations.session(&session)?;
    let id = convert::identifier::<permission::Id>(&request.params.request_id)?;
    services
        .permissions
        .get(&id)
        .filter(|found| found.session_id == session)
        .ok_or_else(|| missing(&request.params.request_id))?;
    let reply = match v5::PermissionReply::try_from(request.payload.reply) {
        Ok(v5::PermissionReply::Once) => "once",
        Ok(v5::PermissionReply::Always) => "always",
        Ok(v5::PermissionReply::Reject) => "reject",
        Err(_) => return Err(Failure::Invalid("invalid permission reply".into())),
    };
    services
        .permissions
        .reply(
            &id,
            permission::Reply::decode(&JsonValue::String(reply.into()))
                .map_err(|_| Failure::Invalid("invalid permission reply".into()))?,
            request
                .payload
                .message
                .as_ref()
                .map(convert::domain)
                .transpose()?,
        )
        .map_err(|error| match error {
            Error::NotFound => missing(&request.params.request_id),
            other => failure(other),
        })?;
    Ok(v5::SessionPermissionReplyResult { data: v5::Empty {} })
}

pub async fn request_list(
    invocation: Invocation,
    request: v5::PermissionRequestListRequest,
) -> Result<v5::PermissionRequestListResult, Failure> {
    let services = invocation.location(request.query.location.as_ref())?;
    Ok(v5::PermissionRequestListResult {
        location: convert::location_info(&services.info),
        data: v5::PermissionRequestListResultData {
            items: services
                .permissions
                .list()
                .iter()
                .map(wire)
                .collect::<Result<_, _>>()?,
        },
    })
}

pub async fn saved_list(
    invocation: Invocation,
    request: v5::PermissionSavedListRequest,
) -> Result<v5::PermissionSavedListResult, Failure> {
    let services = invocation.location(None)?;
    let project = match &request.query.project_id {
        Some(project) => convert::identifier::<ProjectId>(project)?,
        None => services.info.project.id.clone(),
    };
    Ok(v5::PermissionSavedListResult {
        data: v5::PermissionSavedListResultData {
            items: services
                .saved
                .list(Some(&project))
                .map_err(failure)?
                .iter()
                .map(|saved| {
                    Ok(v5::PermissionSavedInfo {
                        id: convert::wire(&saved.id.0),
                        project_id: convert::wire(saved.project_id.as_lossless()),
                        action: convert::wire(&saved.action),
                        resource: convert::wire(&saved.resource),
                    })
                })
                .collect::<Result<_, Failure>>()?,
        },
    })
}

pub async fn saved_remove(
    invocation: Invocation,
    request: v5::PermissionSavedRemoveRequest,
) -> Result<v5::PermissionSavedRemoveResult, Failure> {
    let services = invocation.location(None)?;
    services
        .saved
        .remove(&permission_saved::Id(convert::domain(&request.params.id)?))
        .map_err(failure)?;
    Ok(v5::PermissionSavedRemoveResult { data: v5::Empty {} })
}

pub(crate) fn wire(request: &permission::Request) -> Result<v5::PermissionRequest, Failure> {
    Ok(v5::PermissionRequest {
        id: convert::identity(&request.id)?,
        session_id: convert::wire(request.session_id.as_lossless()),
        action: convert::wire(&request.action),
        resources: v5::PermissionRequestResources {
            items: request.resources.iter().map(convert::wire).collect(),
        },
        save: request.save.as_ref().map(|save| v5::PermissionRequestSave {
            items: save.iter().map(convert::wire).collect(),
        }),
        metadata: request
            .metadata
            .as_ref()
            .map(|metadata| v5::PermissionRequestMetadata {
                entries: metadata
                    .iter()
                    .map(|(key, value)| v5::PermissionRequestMetadataEntry {
                        key: convert::wire(key),
                        value: convert::json_to_value(value),
                    })
                    .collect(),
            }),
        source: request.source.as_ref().map(|source| v5::PermissionSource {
            r#type: v5::PermissionSourceType::Tool as i32,
            message_id: convert::wire(&source.message_id),
            call_id: convert::wire(&source.call_id),
        }),
    })
}

fn missing(id: &v5::LosslessString) -> Failure {
    Failure::PermissionNotFound(
        convert::domain(id)
            .map(|id| convert::readable(&id))
            .unwrap_or_default(),
    )
}

fn failure(error: Error) -> Failure {
    match error {
        Error::Authority(AuthorityError::NotFound(id)) => {
            Failure::SessionNotFound(session_name(&id))
        }
        Error::Duplicate => Failure::Conflict("Permission request already exists".into()),
        _ => Failure::Unavailable("Permission service unavailable".into()),
    }
}

fn session_name(id: &SessionId) -> String {
    convert::readable(id.as_lossless())
}
