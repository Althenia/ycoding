use std::{fs, path::Path};
use ycoding_core::resources::project_artifact::{
    adapter,
    package::{self, MarkerInput},
    reset::{self, Kind, Roots},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, parse_json, project_artifact, stringify_json,
};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-artifact-reset-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn roots(&self) -> Roots {
        Roots {
            data: self.0.join("data"),
            config: self.0.join("config"),
            cache: self.0.join("cache"),
            standard: vec![
                self.0.join("global/skills"),
                self.0.join("project/.agents/skills"),
            ],
        }
    }
    fn write(&self, path: &str, content: &str) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn id(value: &str) -> project_artifact::Id {
    project_artifact::Id::decode(&JsonValue::String(value.into())).unwrap()
}

fn managed(fixture: &Fixture, kind: &str, name: &str, directory: &str) -> String {
    let definition = project_artifact::Definition::decode(&match kind {
        "skill" => parse_json(r#"{"kind":"skill","name":"Managed","description":"Managed skill.","content":"Body."}"#).unwrap(),
        "command" => parse_json(r#"{"kind":"command","name":"Managed","description":"Managed command.","template":"Body.","subtask":false}"#).unwrap(),
        _ => unreachable!(),
    })
    .unwrap();
    let content = adapter::render(&id(name), &definition);
    let marker = package::marker(MarkerInput {
        scope_id: project_artifact::ScopeId::decode(&JsonValue::String("pas_fixture".into()))
            .unwrap(),
        storage_id: project_artifact::StorageId::decode(&JsonValue::String(
            "11111111-1111-4111-8111-111111111111".into(),
        ))
        .unwrap(),
        kind: project_artifact::Kind::decode(&JsonValue::String(kind.into())).unwrap(),
        id: id(name),
        version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_fixture".into()))
            .unwrap(),
        content: content.clone(),
    });
    let marker = stringify_json(&marker.encode());
    let text = content.to_utf8().unwrap();
    if kind == "skill" {
        fixture.write(&format!("{directory}/{name}/SKILL.md"), &text);
        fixture.write(
            &format!("{directory}/{name}/.ycoding-project-artifact.json"),
            &marker,
        );
    } else {
        fixture.write(&format!("{directory}/{name}.md"), &text);
        fixture.write(
            &format!("{directory}/.{name}.ycoding-project-artifact.json"),
            &marker,
        );
    }
    text
}

fn generated(fixture: &Fixture, name: &str, artifact: &str) {
    let location = "location";
    let suffix = package::sha256(&format!("{location}\0{artifact}").as_str().into())
        .as_lossless()
        .to_utf8()
        .unwrap()[..12]
        .to_owned();
    let directory = format!("config/generated/{name}-{suffix}");
    fixture.write(
        &format!("{directory}/.ycoding-generated.json"),
        &format!(r#"{{"generated":true,"locationID":"{location}","artifactID":"{artifact}","versionID":"v1"}}"#),
    );
    fixture.write(&format!("{directory}/SKILL.md"), "legacy");
}

fn exists(fixture: &Fixture, path: &str) -> bool {
    Path::exists(&fixture.0.join(path))
}

#[test]
fn reset_purges_every_obsolete_artifact_surface_and_preserves_everything_else() {
    let f = Fixture::new();
    f.write("data/project-artifacts/scope-a/.ycoding-scope.json", "{}");
    f.write(
        "data/project-artifacts/scope-a/versions/skill/x/pav_1/SKILL.md",
        "old",
    );
    f.write(
        "data/project-artifacts/scope-a/trash/pad_1/.ycoding-trash.json",
        "{}",
    );
    f.write("data/project-artifacts/unowned/file.txt", "keep");
    f.write("data/sessions.db", "keep");
    generated(&f, "legacy-skill", "artifact-one");
    f.write("config/generated/not-owned/SKILL.md", "keep");
    f.write("config/.ycoding-cleanup-generated-leftover-1-2/x", "stale");
    f.write("config/ycoding.json", "{}");
    f.write("cache/skills/abc/review/SKILL.md", "cached");
    f.write("cache/other/keep.txt", "keep");
    managed(&f, "skill", "review", "global/skills");
    managed(&f, "skill", "project-skill", "project/.agents/skills");
    managed(&f, "command", "ship", "global/skills");
    f.write(
        "global/skills/canonical/SKILL.md",
        "---\nname: canonical\ndescription: Hand written.\n---\nBody\n",
    );
    f.write("global/skills/canonical/scripts/run.sh", "echo keep");

    let roots = f.roots();
    let planned = reset::plan(&roots);
    let kinds = |kind: Kind| planned.iter().filter(|item| item.kind == kind).count();
    assert_eq!(kinds(Kind::ScopeStore), 1);
    assert_eq!(kinds(Kind::GeneratedSkill), 1);
    assert_eq!(kinds(Kind::Quarantine), 1);
    assert_eq!(kinds(Kind::ManagedSkill), 2);
    assert_eq!(kinds(Kind::ManagedFile), 1);
    assert_eq!(kinds(Kind::DiscoveryCache), 1);
    assert!(
        exists(&f, "global/skills/review/SKILL.md"),
        "planning removes nothing"
    );

    let report = reset::apply(&planned);
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(report.removed.len(), planned.len());
    for gone in [
        "data/project-artifacts/scope-a",
        "config/generated/legacy-skill-",
        "config/.ycoding-cleanup-generated-leftover-1-2",
        "global/skills/review",
        "global/skills/ship.md",
        "global/skills/.ship.ycoding-project-artifact.json",
        "project/.agents/skills/project-skill",
        "cache/skills",
    ] {
        let found = if gone.ends_with('-') {
            fs::read_dir(f.0.join("config/generated"))
                .unwrap()
                .any(|entry| {
                    entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with("legacy-skill-")
                })
        } else {
            exists(&f, gone)
        };
        assert!(!found, "{gone} should be gone");
    }
    for kept in [
        "data/project-artifacts/unowned/file.txt",
        "data/sessions.db",
        "config/generated/not-owned/SKILL.md",
        "config/ycoding.json",
        "cache/other/keep.txt",
        "global/skills/canonical/SKILL.md",
        "global/skills/canonical/scripts/run.sh",
    ] {
        assert!(exists(&f, kept), "{kept} should be kept");
    }
    assert_eq!(reset::plan(&roots), vec![]);
    assert_eq!(reset::apply(&reset::plan(&roots)), reset::Report::default());
}

#[test]
fn reset_keeps_edited_or_mismatched_managed_directories() {
    let f = Fixture::new();
    managed(&f, "skill", "edited", "global/skills");
    f.write(
        "global/skills/edited/SKILL.md",
        "---\nname: edited\ndescription: User edit.\n---\nChanged\n",
    );
    managed(&f, "skill", "renamed", "global/skills");
    fs::rename(
        f.0.join("global/skills/renamed"),
        f.0.join("global/skills/other-name"),
    )
    .unwrap();
    managed(&f, "skill", "extra", "global/skills");
    f.write("global/skills/extra/references/notes.md", "user notes");
    let planned = reset::plan(&f.roots());
    assert_eq!(
        planned
            .iter()
            .map(|item| item.path.file_name().unwrap().to_str().unwrap())
            .collect::<Vec<_>>(),
        ["extra"]
    );
    assert!(reset::apply(&planned).failed.is_empty());
    assert!(!exists(&f, "global/skills/extra/SKILL.md"));
    assert!(!exists(
        &f,
        "global/skills/extra/.ycoding-project-artifact.json"
    ));
    assert!(exists(&f, "global/skills/extra/references/notes.md"));
    assert!(exists(&f, "global/skills/edited/SKILL.md"));
    assert!(exists(&f, "global/skills/other-name/SKILL.md"));
}

#[cfg(unix)]
#[test]
fn reset_never_follows_symlinks() {
    let f = Fixture::new();
    f.write("outside/.ycoding-scope.json", "{}");
    fs::create_dir_all(f.0.join("data/project-artifacts")).unwrap();
    std::os::unix::fs::symlink(f.0.join("outside"), f.0.join("data/project-artifacts/link"))
        .unwrap();
    f.write("cache-target/x", "keep");
    fs::create_dir_all(&f.0.join("cache")).unwrap();
    std::os::unix::fs::symlink(f.0.join("cache-target"), f.0.join("cache/skills")).unwrap();
    assert_eq!(reset::plan(&f.roots()), vec![]);
    assert!(exists(&f, "outside/.ycoding-scope.json"));
    assert!(exists(&f, "cache-target/x"));
}
