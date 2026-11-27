use std::{fs, path::Path};
use ycoding_core::resources::{
    config::Roots,
    recall::document::{Document, Scope},
    skill::{Service, document},
};
use ycoding_schema::skill::{DirectorySource, Info, Source};

fn base(name: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!(
        "ycoding-skill-metadata-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    fs::canonicalize(base).unwrap()
}

fn write(root: &Path, path: &str, content: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

async fn documents(service: &mut Service, base: &Path) -> (Vec<Info>, Vec<Document>) {
    let infos = service.list().await.unwrap();
    let roots = Roots::development(base).unwrap();
    let documents = service.documents(&infos, |info| {
        document::location_origin(info, Some(base), &roots)
    });
    (infos, documents)
}

#[tokio::test]
async fn descriptive_metadata_is_indexed_through_the_document_fields() {
    let base = base("fields");
    write(
        &base,
        "skills/deploy/SKILL.md",
        "---\nname: deploy\ndescription: Ships a release. Use when a tag is ready.\nmetadata:\n  purpose: \"Publish a verified release.\"\n  applicability: \"Release branches only.\"\n  triggers: \"cut a release, publish a tag, cut a release\"\n  capabilities: \"tag creation, artifact upload\"\n  prerequisites: \"git remote access\"\n  related: \"rollback, release-notes\"\n  keywords: \"release\"\n---\nRun the release steps.\n",
    );
    let mut service = Service::new(&base.join("cache"));
    service.source(Source::Directory(DirectorySource {
        path: ycoding_core::resources::discovery::absolute_path(&base.join("skills")).unwrap(),
    }));
    let (_, documents) = documents(&mut service, &base).await;
    assert_eq!(documents.len(), 1);
    let fields = &documents[0].fields;
    assert_eq!(
        fields.description,
        "Ships a release. Use when a tag is ready."
    );
    assert_eq!(
        fields.body,
        "Purpose: Publish a verified release.\n\nApplicability: Release branches only.\n\nPrerequisites: git remote access\n\nRun the release steps.\n"
    );
    assert_eq!(
        fields.keywords,
        ["release", "cut a release", "publish a tag"]
    );
    assert_eq!(
        fields.identifiers,
        ["deploy", "tag creation", "artifact upload"]
    );
    assert_eq!(
        fields.relationships,
        ["related:rollback", "related:release-notes"]
    );
    assert_eq!(documents[0].scope, Scope::Project);
    fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn invalid_descriptive_metadata_skips_the_skill_with_a_diagnostic() {
    let base = base("invalid");
    let manifest = |name: &str, line: &str| {
        format!(
            "---\nname: {name}\ndescription: Does a thing. Use when testing.\nmetadata:\n  {line}\n---\nBody\n"
        )
    };
    write(
        &base,
        "skills/good/SKILL.md",
        &manifest("good", "purpose: Fine"),
    );
    write(
        &base,
        "skills/blank/SKILL.md",
        &manifest("blank", "purpose: \"  \""),
    );
    write(
        &base,
        "skills/list/SKILL.md",
        &manifest("list", "triggers: [a, b]"),
    );
    write(
        &base,
        "skills/long/SKILL.md",
        &manifest("long", &format!("related: \"{}\"", "x".repeat(1025))),
    );
    let mut service = Service::new(&base.join("cache"));
    service.source(Source::Directory(DirectorySource {
        path: ycoding_core::resources::discovery::absolute_path(&base.join("skills")).unwrap(),
    }));
    let (infos, _) = documents(&mut service, &base).await;
    assert_eq!(
        infos
            .iter()
            .map(|info| info.id.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["good"]
    );
    assert_eq!(service.diagnostics().len(), 3);
    fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn built_in_skills_have_unprefixed_ids_and_carry_all_descriptive_metadata() {
    let base = base("builtin");
    let mut service = Service::from_entries(&[], &base, &base, &base.join("cache")).unwrap();
    let (infos, documents) = documents(&mut service, &base).await;
    let mut ids = infos
        .iter()
        .map(|info| info.id.to_utf8().unwrap())
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(
        ids,
        [
            "browser-use",
            "chatgpt-connectors",
            "computer-use",
            "report",
            "ycoding"
        ]
    );
    assert!(ids.iter().all(|id| !id.starts_with("ycoding-")));
    for document in &documents {
        let fields = &document.fields;
        assert!(fields.body.starts_with("Purpose: "), "{}", document.id);
        assert!(
            fields.body.contains("\n\nApplicability: "),
            "{}",
            document.id
        );
        assert!(
            fields.body.contains("\n\nPrerequisites: "),
            "{}",
            document.id
        );
        assert!(!fields.keywords.is_empty(), "{}", document.id);
        assert!(fields.identifiers.len() > 1, "{}", document.id);
        assert!(
            fields
                .relationships
                .iter()
                .any(|r| r.starts_with("related:")),
            "{}",
            document.id
        );
        assert_eq!(document.scope, Scope::Workspace);
    }
    fs::remove_dir_all(base).unwrap();
}
