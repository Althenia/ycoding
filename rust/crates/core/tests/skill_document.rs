use std::{fs, path::Path};
use ycoding_core::resources::{
    config::Roots,
    project_artifact::{adapter, package, source::Provenance},
    recall::document::{Activation, Document, Kind, Scope, Status, Trust},
    skill::{Service, document},
};
use ycoding_schema::{
    DomainDecode, JsonValue, parse_json,
    skill::{DirectorySource, EmbeddedSource, Info, Source},
};

fn write(root: &Path, path: &str, content: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn base(name: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!(
        "ycoding-skill-document-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    fs::canonicalize(base).unwrap()
}

async fn list(service: &mut Service, root: &Path) -> Vec<Info> {
    service.source(Source::Directory(DirectorySource {
        path: ycoding_core::resources::discovery::absolute_path(root).unwrap(),
    }));
    service.list().await.unwrap()
}

fn by_id<'a>(documents: &'a [Document], id: &str) -> &'a Document {
    documents.iter().find(|d| d.id == id).unwrap()
}

#[tokio::test]
async fn directory_skills_become_documents_with_fields_hash_and_activation_signal() {
    let base = base("fields");
    let skills = base.join("skills");
    let auto = "---\nname: audit\ndescription: Audits specs. Use when reviewing a draft.\nmetadata:\n  display-name: Spec Audit\n  tags: \"spec, review, spec\"\n  activation: auto\n  keywords: \"audit, contract\"\n  conflicts: other\n  instruction-conflicts: core/instructions\n---\nCheck every rule.\n";
    write(&skills, "audit/SKILL.md", auto);
    write(
        &skills,
        "careful/SKILL.md",
        "---\nname: careful\ndescription: Needs a person.\nmetadata:\n  activation: manual\n---\nBody\n",
    );
    write(
        &skills,
        "plain/SKILL.md",
        "---\nname: plain\ndescription: No activation.\n---\nBody\n",
    );
    let mut service = Service::new(&base.join("cache"));
    let infos = list(&mut service, &skills).await;
    let roots = Roots::development(&base).unwrap();
    let documents = service.documents(&infos, |info| {
        document::location_origin(info, Some(&base), &roots)
    });
    assert_eq!(documents.len(), 3);

    let audit = by_id(&documents, "audit");
    assert_eq!(audit.kind, Kind::Skill);
    assert_eq!(audit.scope, Scope::Project);
    assert_eq!(audit.key(), (Scope::Project, Kind::Skill, "audit"));
    assert!(audit.source.path.ends_with("skills/audit/SKILL.md"));
    let expected = package::sha256(&auto.into())
        .as_lossless()
        .to_utf8()
        .unwrap();
    assert_eq!(audit.source.content_hash, expected);
    assert_eq!(audit.source.revision, expected);
    assert_eq!(audit.fields.doc_type, "skill");
    assert_eq!(audit.fields.title, "Spec Audit");
    assert_eq!(
        audit.fields.description,
        "Audits specs. Use when reviewing a draft."
    );
    assert_eq!(audit.fields.body, "Check every rule.\n");
    assert_eq!(audit.fields.tags, ["spec", "review"]);
    assert_eq!(audit.fields.keywords, ["audit", "contract"]);
    assert_eq!(audit.fields.identifiers, ["audit"]);
    assert_eq!(
        audit.fields.relationships,
        ["skill:other", "instruction:core/instructions"]
    );
    assert_eq!(audit.lifecycle.status, Status::Active);
    assert_eq!(audit.lifecycle.trust, Trust::Unverified);
    assert_eq!(audit.lifecycle.activation, Some(Activation::Auto));
    assert!(audit.lifecycle.eligible(0));

    assert_eq!(
        by_id(&documents, "careful").lifecycle.activation,
        Some(Activation::Manual)
    );
    assert_eq!(by_id(&documents, "plain").lifecycle.activation, None);
    assert!(by_id(&documents, "plain").fields.tags.is_empty());
    fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn scope_follows_location_and_unscoped_sources_are_workspace() {
    let base = base("scope");
    let project = base.join("repo");
    let roots = Roots::development(&base).unwrap();
    let manifest =
        |name: &str| format!("---\nname: {name}\ndescription: Scoped {name}.\n---\nBody\n");
    write(
        &project,
        ".agents/skills/inside/SKILL.md",
        &manifest("inside"),
    );
    write(
        &roots.home,
        ".agents/skills/shared/SKILL.md",
        &manifest("shared"),
    );
    write(&base, "elsewhere/outside/SKILL.md", &manifest("outside"));
    let mut service = Service::new(&base.join("cache"));
    list(&mut service, &project.join(".agents/skills")).await;
    list(&mut service, &roots.home.join(".agents/skills")).await;
    let infos = list(&mut service, &base.join("elsewhere")).await;
    let documents = service.documents(&infos, |info| {
        document::location_origin(info, Some(&project), &roots)
    });
    let scope = |id: &str| by_id(&documents, id).scope;
    assert_eq!(scope("inside"), Scope::Project);
    assert_eq!(scope("shared"), Scope::Knowledge);
    assert_eq!(scope("outside"), Scope::Workspace);
    fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn embedded_skills_hash_their_content_and_carry_no_cue_fields() {
    let base = base("embedded");
    let mut service = Service::new(&base.join("cache"));
    let embedded = Info::decode(
        &parse_json(r#"{"id":"built-in","name":"Built In","description":"Ships in the binary.","location":"/builtin/built-in/SKILL.md","content":"Embedded body."}"#)
            .unwrap(),
    )
    .unwrap();
    service.source(Source::Embedded(EmbeddedSource { skill: embedded }));
    let infos = service.list().await.unwrap();
    let roots = Roots::development(&base).unwrap();
    let documents = service.documents(&infos, |info| document::location_origin(info, None, &roots));
    let built = by_id(&documents, "built-in");
    let expected = package::sha256(&"Embedded body.".into())
        .as_lossless()
        .to_utf8()
        .unwrap();
    assert_eq!(built.source.content_hash, expected);
    assert_eq!(built.source.revision, expected);
    assert_eq!(built.scope, Scope::Workspace);
    assert_eq!(built.fields.title, "Built In");
    assert!(built.fields.tags.is_empty() && built.fields.keywords.is_empty());
    assert_eq!(built.lifecycle.activation, None);
    fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn artifact_backed_skills_take_version_and_digest_from_provenance() {
    let base = base("artifact");
    let id = ycoding_schema::project_artifact::Id::decode(&JsonValue::String("reviewer".into()))
        .unwrap();
    let definition = ycoding_schema::project_artifact::Definition::decode(
        &parse_json(r#"{"kind":"skill","name":"Reviewer","description":"Reviews a change. Use when a diff needs review.","content":"Review the diff.","tags":["review","diff"]}"#).unwrap(),
    )
    .unwrap();
    let rendered = adapter::render(&id, &definition);
    write(
        &base,
        "managed/reviewer/SKILL.md",
        rendered.to_utf8().unwrap().as_str(),
    );
    let mut service = Service::new(&base.join("cache"));
    let infos = list(&mut service, &base.join("managed")).await;
    let digest = package::sha256(&rendered);
    let provenance = |scope: &'static str| Provenance {
        scope,
        scope_id: ycoding_schema::project_artifact::ScopeId::decode(&JsonValue::String(
            "pas_fixture".into(),
        ))
        .unwrap(),
        version_id: ycoding_schema::project_artifact::VersionId::decode(&JsonValue::String(
            "pav_fixture".into(),
        ))
        .unwrap(),
        kind: ycoding_schema::project_artifact::Kind::decode(&JsonValue::String("skill".into()))
            .unwrap(),
        id: id.clone(),
        expected_revision: ycoding_schema::project_artifact::Revision::new(0).unwrap(),
        expected_digest: digest.clone(),
    };
    let project = service.documents(&infos, |_| {
        document::artifact_origin(&provenance("project"))
    });
    let global = service.documents(&infos, |_| document::artifact_origin(&provenance("global")));
    let doc = &project[0];
    assert_eq!(doc.scope, Scope::Project);
    assert_eq!(global[0].scope, Scope::Knowledge);
    assert_eq!(doc.source.revision, "pav_fixture");
    assert_eq!(
        doc.source.content_hash,
        digest.as_lossless().to_utf8().unwrap()
    );
    assert_eq!(doc.lifecycle.trust, Trust::Verified);
    assert_eq!(doc.fields.title, "Reviewer");
    assert_eq!(doc.fields.tags, ["review", "diff"]);
    assert_eq!(doc.fields.body.trim(), "Review the diff.");
    fs::remove_dir_all(base).unwrap();
}
