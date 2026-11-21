use super::codec::{Document, key, require, table};
use crate::{Error, IndexDefinition, KeyPart, tuple_key};
use ycoding_schema::{JsonValue, LosslessString, project};

table!(ProjectTable, Project, "project", {
    id: LosslessString, worktree: LosslessString, vcs: Option<LosslessString>, name: Option<LosslessString>,
    icon_url: Option<LosslessString>, icon_url_override: Option<LosslessString>, icon_color: Option<LosslessString>,
    time_created: i64, time_updated: i64, time_initialized: Option<i64>, sandboxes: Vec<LosslessString>, commands: Option<Document<project::Commands>>
}, r, key(&r.id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, { crate::resources::source_changed(tx, "project", key(&r.id), false)?; });

table!(WorkspaceTable, Workspace, "workspace", {
    id: LosslessString, type_: LosslessString, name: LosslessString, branch: Option<LosslessString>, directory: Option<LosslessString>,
    extra: Option<JsonValue>, project_id: LosslessString, time_used: i64
}, r, key(&r.id), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, {
    require::<ProjectTable>(tx, &key(&r.project_id))?;
});

table!(DirectoryTable, Directory, "project_directory", {
    project_id: LosslessString, directory: LosslessString, type_: Option<LosslessString>, strategy: Option<LosslessString>, time_created: i64
}, r, tuple_key(&[KeyPart::String(&r.project_id), KeyPart::String(&r.directory)]), &[], index, { let _ = (index, r); Err(Error::UnregisteredIndex) }, Ok::<_, Error>(()), tx, {
    require::<ProjectTable>(tx, &key(&r.project_id))?;
});

table!(PermissionTable, Permission, "permission", {
    id: LosslessString, project_id: LosslessString, action: LosslessString, resource: LosslessString, time_created: i64, time_updated: i64
}, r, key(&r.id), &[IndexDefinition::unique("permission_project_action_resource_idx")], index, {
    match index.name {
        "permission_project_action_resource_idx" => Ok(Some(tuple_key(&[KeyPart::String(&r.project_id), KeyPart::String(&r.action), KeyPart::String(&r.resource)]))),
        _ => Err(Error::UnregisteredIndex)
    }
}, Ok::<_, Error>(()), tx, {
    require::<ProjectTable>(tx, &key(&r.project_id))?;
});
