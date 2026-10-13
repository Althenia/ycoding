use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::project_artifact::source_registry::{
    Record, Registry, StandardSource,
};
use ycoding_core::resources::project_artifact::{adapter, filesystem::Hooks, package, source};
use ycoding_schema::{DomainDecode, JsonValue, project, project_artifact};

fn project_id(id: &str) -> project::Id {
    project::Id::decode(&JsonValue::String(id.into())).unwrap()
}

fn record(scope: &str, project: Option<&str>) -> Record {
    Record {
        source: StandardSource {
            scope: scope.into(),
            managed_scope_id: None,
            managed_version_id: None,
            managed_digest: None,
        },
        project_id: project.map(project_id),
        kind: project_artifact::Kind::decode(&JsonValue::String("skill".into())).unwrap(),
        id: project_artifact::Id::decode(&JsonValue::String("review".into())).unwrap(),
        path: None,
    }
}

#[test]
fn keeps_replacement_safe_snapshots_isolated_by_location_and_project() {
    let mut registry = Registry::default();
    let project = record("project", Some("project-one"));
    let mut global = record("global", None);
    global.source.managed_scope_id =
        Some(project_artifact::ScopeId::decode(&JsonValue::String("pas_global".into())).unwrap());
    global.source.managed_version_id =
        Some(project_artifact::VersionId::decode(&JsonValue::String("pav_global".into())).unwrap());
    global.source.managed_digest = Some(
        project_artifact::Digest::decode(&JsonValue::String(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        ))
        .unwrap(),
    );
    registry.replace("first".into(), vec![project.clone()]);
    registry.replace("second".into(), vec![global.clone()]);
    assert_eq!(registry.size(), 2);
    assert_eq!(
        registry.resolve(
            "project",
            Some(&project_id("project-one")),
            &project.kind,
            &project.id
        ),
        vec![project.source.clone()]
    );
    assert!(
        registry
            .resolve(
                "project",
                Some(&project_id("project-two")),
                &project.kind,
                &project.id
            )
            .is_empty()
    );
    assert_eq!(
        registry.resolve("global", None, &global.kind, &global.id),
        vec![global.source.clone()]
    );
    registry.replace("first".into(), vec![global.clone()]);
    assert!(
        registry
            .resolve(
                "project",
                Some(&project_id("project-one")),
                &project.kind,
                &project.id
            )
            .is_empty()
    );
    assert_eq!(
        registry.resolve("global", None, &global.kind, &global.id),
        vec![global.source]
    );
    registry.remove("first");
    assert_eq!(registry.size(), 1);
}

#[test]
fn validates_authoritative_managed_bytes_and_captures_only_exact_provenance() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let data = std::env::temp_dir().join(format!(
        "ycoding-artifact-source-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let details = project_artifact::ArtifactDetails::decode(&ycoding_schema::parse_json(r#"{"artifact":{"scope":{"type":"project","id":"pas_source","projectID":"source-project","storageID":"11111111-1111-4111-8111-111111111111"},"kind":"skill","id":"review","revision":1,"stage":"trial","currentVersionID":"pav_source","timeCreated":1,"timeUpdated":1},"definition":{"kind":"skill","name":"Review","description":"Reusable guidance","content":"First guidance"},"currentVersion":{"id":"pav_source","state":"trial","contentDigest":"0000000000000000000000000000000000000000000000000000000000000000","contentRelpath":"SKILL.md","provenance":{"source":"agent"},"timeCreated":1,"timeStateChanged":1},"versions":[],"diagnostics":[]}"#).unwrap()).unwrap();
    let project_artifact::Scope::Project(scope) = &details.artifact.scope else {
        panic!()
    };
    let root = data
        .join("project-artifacts")
        .join(scope.storage_id.as_lossless().as_str().unwrap());
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(package::scope_marker_path(&root), r#"{"schema":1,"scopeID":"pas_source","type":"project","storageID":"11111111-1111-4111-8111-111111111111"}"#).unwrap();
    let content = adapter::render(&details.definition);
    let marker = package::marker(package::MarkerInput {
        scope_id: scope.id.clone(),
        storage_id: scope.storage_id.clone(),
        kind: details.artifact.kind.clone(),
        id: details.artifact.id.clone(),
        version_id: details.current_version.id.clone(),
        content: content.clone(),
    });
    let mut details = details;
    details.current_version.content_digest = marker.content_digest.clone();
    package::commit(
        package::CommitInput {
            root: &root,
            marker: &marker,
            content: &content,
            expected_version_id: None,
            operation_id: None,
            standard: None,
            no_overwrite: false,
        },
        &Hooks::default(),
    )
    .unwrap();
    let candidate = source::validate(&details, &data).unwrap();
    assert_eq!(candidate.version.definition, details.definition);
    assert_eq!(candidate.version.scope_id, marker.scope_id);
    for stage in ["degraded", "disabled", "quarantine"] {
        let mut inactive = details.clone();
        inactive.artifact.stage =
            project_artifact::Stage::decode(&JsonValue::String(stage.into())).unwrap();
        assert!(source::validate(&inactive, &data).is_none());
    }
    let mut mismatched = details.clone();
    if let project_artifact::Definition::Skill(value) = &mut mismatched.definition {
        value.content =
            project_artifact::SkillContent::decode(&JsonValue::String("Unrelated guidance".into()))
                .unwrap();
    }
    assert!(source::validate(&mismatched, &data).is_none());
    std::fs::write(&candidate.version.content_path, "tampered").unwrap();
    assert!(source::validate(&details, &data).is_none());
    std::fs::remove_dir_all(data).unwrap();
}

#[test]
fn standard_source_marks_only_matching_kind_id_and_content_digest() {
    let data = std::env::temp_dir().join(format!(
        "ycoding-artifact-standard-source-{}",
        std::process::id()
    ));
    let content_path = data.join("review.md");
    let marker_path = data.join(".review.ycoding-project-artifact.json");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(&content_path, "Review.").unwrap();
    let kind = project_artifact::Kind::decode(&JsonValue::String("command".into())).unwrap();
    let id = project_artifact::Id::decode(&JsonValue::String("review".into())).unwrap();
    let marker = package::marker(package::MarkerInput {
        scope_id: project_artifact::ScopeId::decode(&JsonValue::String("pas_global".into()))
            .unwrap(),
        storage_id: project_artifact::StorageId::decode(&JsonValue::String(
            "11111111-1111-4111-8111-111111111111".into(),
        ))
        .unwrap(),
        kind: kind.clone(),
        id: id.clone(),
        version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_global".into()))
            .unwrap(),
        content: "Review.".into(),
    });
    std::fs::write(
        &marker_path,
        ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(&marker)),
    )
    .unwrap();
    let project = project_id("project-one");
    let source = source::read_standard_source(&kind, &id, Some(&content_path), &data, &project);
    assert_eq!(source.source.scope, "project".into());
    assert_eq!(source.project_id, Some(project.clone()));
    assert_eq!(source.source.managed_digest, Some(marker.content_digest));
    std::fs::write(&content_path, "tampered").unwrap();
    assert!(
        source::read_standard_source(&kind, &id, Some(&content_path), &data, &project)
            .source
            .managed_digest
            .is_none()
    );
    assert_eq!(
        source::read_standard_source(
            &kind,
            &id,
            Some(&content_path),
            &PathBuf::from("/different"),
            &project
        )
        .source
        .scope,
        "global".into()
    );
    assert_eq!(
        source::read_standard_source(&kind, &id, None, &data, &project).project_id,
        None
    );
    std::fs::remove_dir_all(data).unwrap();
}
