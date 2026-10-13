use super::{
    adapter, package,
    source_registry::{Record, StandardSource},
};
use crate::resources::discovery;
use std::{
    fs,
    path::{Path, PathBuf},
};
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, project, project_artifact};

pub struct Candidate<'a> {
    pub kind: project_artifact::Kind,
    pub id: project_artifact::Id,
    pub details: &'a project_artifact::ArtifactDetails,
    pub version: adapter::VersionIndex,
}
pub fn validate<'a>(
    details: &'a project_artifact::ArtifactDetails,
    data_root: &Path,
) -> Option<Candidate<'a>> {
    let project_artifact::Scope::Project(scope) = &details.artifact.scope else {
        return None;
    };
    if !matches!(details.artifact.stage.encode(), JsonValue::String(stage) if matches!(stage.as_str(), Some("trial" | "active")))
        || details.artifact.kind.as_lossless().as_str() == Some("plugin")
    {
        return None;
    }
    let root = data_root
        .join("project-artifacts")
        .join(scope.storage_id.as_lossless().as_str()?);
    let content_path =
        package::active_content_path(&root, &details.artifact.kind, &details.artifact.id);
    let marker = package::Marker::decode(
        &ycoding_schema::parse_json(&read(&package::active_marker_path(
            &root,
            &details.artifact.kind,
            &details.artifact.id,
        ))?)
        .ok()?,
    )
    .ok()?;
    let content = read(&content_path)?;
    if marker.scope_id != scope.id
        || marker.version_id != details.current_version.id
        || marker.kind != details.artifact.kind
        || marker.id != details.artifact.id
        || marker.content_digest != details.current_version.content_digest
        || package::sha256(&content.as_str().into()) != marker.content_digest
    {
        return None;
    }
    let definition = adapter::parse(&details.artifact.kind, &content).ok()?;
    if definition != details.definition {
        return None;
    }
    Some(Candidate {
        kind: details.artifact.kind.clone(),
        id: details.artifact.id.clone(),
        details,
        version: adapter::VersionIndex {
            scope_id: scope.id.clone(),
            version_id: details.current_version.id.clone(),
            id: details.artifact.id.clone(),
            content_path,
            definition,
        },
    })
}
pub fn read_standard_source(
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
    path: Option<&Path>,
    project_directory: &Path,
    project_id: &project::Id,
) -> Record {
    let scope = source_scope(project_directory, path);
    let mut source = StandardSource {
        scope: scope.into(),
        managed_scope_id: None,
        managed_version_id: None,
        managed_digest: None,
    };
    let Some(path) = path else {
        return Record {
            source,
            project_id: None,
            kind: kind.clone(),
            id: id.clone(),
            path: None,
        };
    };
    let marker = read(&standard_marker_path(path, kind, id))
        .and_then(|text| ycoding_schema::parse_json(&text).ok())
        .and_then(|value| package::Marker::decode(&value).ok());
    if let Some(marker) = marker.filter(|marker| {
        &marker.kind == kind
            && &marker.id == id
            && read(path).is_some_and(|content| {
                package::sha256(&content.as_str().into()) == marker.content_digest
            })
    }) {
        source.managed_scope_id = Some(marker.scope_id);
        source.managed_version_id = Some(marker.version_id);
        source.managed_digest = Some(marker.content_digest);
    }
    Record {
        source,
        project_id: (scope == "project").then(|| project_id.clone()),
        kind: kind.clone(),
        id: id.clone(),
        path: Some(path.into()),
    }
}
fn source_scope(project_directory: &Path, path: Option<&Path>) -> &'static str {
    let Some(path) = path else {
        return "global";
    };
    let Ok(root) = discovery::absolute(project_directory) else {
        return "global";
    };
    let Ok(path) = discovery::absolute(path) else {
        return "global";
    };
    if path
        .strip_prefix(root)
        .is_ok_and(|relative| !relative.as_os_str().to_string_lossy().starts_with(".."))
    {
        return "project";
    }
    "global"
}
fn standard_marker_path(
    content: &Path,
    kind: &project_artifact::Kind,
    id: &project_artifact::Id,
) -> PathBuf {
    let parent = content.parent().unwrap_or_else(|| Path::new("."));
    parent.join(if kind.as_lossless().as_str() == Some("skill") {
        ".ycoding-project-artifact.json".into()
    } else {
        format!(
            ".{}.ycoding-project-artifact.json",
            id.as_lossless().as_str().expect("validated ID")
        )
    })
}
fn read(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}
