use ycoding_schema::{DomainDecode, DomainEncode, ObjectEncoder, session};
use ycoding_store::{Error, session::Session};

pub fn from_row(row: &Session) -> Result<session::Info, Error> {
    let permissions = row
        .permission
        .as_ref()
        .map(|value| value.domain())
        .transpose()?;
    let mut seen = std::collections::BTreeSet::new();
    let permissions = permissions
        .unwrap_or_default()
        .into_iter()
        .filter(|rule| {
            rule.effect.0.as_str() == Some("deny")
                && seen.insert((rule.action.clone(), rule.resource.clone()))
        })
        .collect::<Vec<_>>();
    let value = ObjectEncoder::new()
        .field("id", &row.id)
        .field("projectID", &row.project_id)
        .field("title", &row.title)
        .optional(
            "parentID",
            &row.parent_id.clone().filter(|id| !id.is_empty()),
        )
        .optional(
            "fork",
            &row.fork_session_id
                .as_ref()
                .filter(|id| !id.is_empty())
                .map(|id| {
                    ObjectEncoder::new()
                        .field("sessionID", id)
                        .optional(
                            "messageID",
                            &row.fork_message_id.clone().filter(|id| !id.is_empty()),
                        )
                        .finish()
                }),
        )
        .optional("agent", &row.agent.clone().filter(|id| !id.is_empty()))
        .optional(
            "model",
            &row.model.as_ref().map(|value| value.value().clone()),
        )
        .optional("daybreak", &row.daybreak)
        .optional(
            "permissionCeiling",
            &(!permissions.is_empty()).then(|| permissions.encode()),
        )
        .field("cost", &row.cost)
        .field(
            "tokens",
            &ObjectEncoder::new()
                .field("input", &(row.tokens_input as f64))
                .field("output", &(row.tokens_output as f64))
                .field("reasoning", &(row.tokens_reasoning as f64))
                .field(
                    "cache",
                    &ObjectEncoder::new()
                        .field("read", &(row.tokens_cache_read as f64))
                        .field("write", &(row.tokens_cache_write as f64))
                        .finish(),
                )
                .finish(),
        )
        .field(
            "location",
            &ObjectEncoder::new()
                .field("directory", &row.directory)
                .optional(
                    "workspaceID",
                    &row.workspace_id.clone().filter(|id| !id.is_empty()),
                )
                .finish(),
        )
        .optional("subpath", &row.path.clone().filter(|path| !path.is_empty()))
        .optional(
            "revert",
            &row.revert.as_ref().map(|value| value.value().clone()),
        )
        .field(
            "time",
            &ObjectEncoder::new()
                .field("created", &(row.time_created as f64))
                .field("updated", &(row.time_updated as f64))
                .optional("active", &row.time_active.map(|value| value as f64))
                .optional("archived", &row.time_archived.map(|value| value as f64))
                .optional("pinned", &row.time_pinned.map(|value| value as f64))
                .finish(),
        )
        .finish();
    session::Info::decode(&value).map_err(|error| Error::Record(Box::new(error)))
}
