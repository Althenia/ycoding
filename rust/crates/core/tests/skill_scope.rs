use std::{collections::BTreeMap, fs, path::Path};
use ycoding_core::resources::{
    config::{Entry, Roots},
    project_artifact::adapter,
    skill::{self, Scope},
};
use ycoding_schema::{
    DomainDecode, JsonValue, parse_json, project_artifact,
    skill::{EmbeddedSource, Info, Source},
};

fn write_skill(directory: &Path, id: &str) {
    fs::create_dir_all(directory.join(id)).unwrap();
    fs::write(
        directory.join(id).join("SKILL.md"),
        format!("---\nname: {id}\ndescription: fixture\n---\nBody of {id}."),
    )
    .unwrap();
}

fn activate_artifact(skills: &mut skill::Service, root: &Path, id: &str) {
    let definition = project_artifact::Definition::decode(
        &parse_json(&format!(
            r#"{{"kind":"skill","name":"{id}","description":"Artifact skill","content":"Artifact body."}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    let path = adapter::project_path(&adapter::kind(&definition), root, id);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, adapter::render(&definition).to_utf8().unwrap()).unwrap();
    adapter::activate(
        &adapter::VersionIndex {
            scope_id: project_artifact::ScopeId::decode(&JsonValue::String("pas_scope".into()))
                .unwrap(),
            version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_scope".into()))
                .unwrap(),
            id: project_artifact::Id::decode(&JsonValue::String(id.into())).unwrap(),
            content_path: path,
            definition,
        },
        adapter::RuntimeDraft {
            skill: Some(skills),
            command: None,
            agent: None,
        },
    )
    .unwrap();
}

#[tokio::test]
async fn skill_scope_follows_project_then_global_root_containment_of_the_skill_location() {
    let base = std::env::temp_dir().join(format!("ycoding-skill-scope-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    let base = fs::canonicalize(base).unwrap();
    let roots = Roots::development(&base).unwrap();
    let work = base.join("work");
    let project = work.join("repo");
    let location = project.join("nested");
    fs::create_dir_all(&location).unwrap();
    write_skill(&project.join(".claude/skills"), "project-claude");
    write_skill(&location.join(".agents/skills"), "nested-agents");
    write_skill(&work.join(".claude/skills"), "ancestor-claude");
    write_skill(&work.join(".ycoding/skills"), "ancestor-ycoding");
    write_skill(&roots.home.join(".agents/skills"), "global-agents");
    write_skill(&roots.home.join(".claude/skills"), "global-claude");
    write_skill(&roots.config.join("skills"), "global-config");
    write_skill(&roots.config.join("skill"), "config-singular");
    let entries = [
        Entry::ClaudeDirectory(roots.home.join(".claude")),
        Entry::ClaudeDirectory(project.join(".claude")),
        Entry::ClaudeDirectory(work.join(".claude")),
        Entry::AgentsDirectory(roots.home.join(".agents")),
        Entry::AgentsDirectory(location.join(".agents")),
        Entry::Directory(roots.config.clone()),
        Entry::Directory(work.join(".ycoding")),
    ];
    let mut service =
        skill::Service::from_entries(&entries, &location, &roots.home, &roots.cache).unwrap();
    service.source(Source::Embedded(EmbeddedSource {
        skill: Info::decode(
            &parse_json(r#"{"id":"embedded","name":"embedded","location":"/builtin/embedded/SKILL.md","content":"Embedded body."}"#)
                .unwrap(),
        )
        .unwrap(),
    }));
    service.source(Source::Embedded(EmbeddedSource {
        skill: Info::decode(
            &parse_json(&format!(
                r#"{{"id":"embedded-in-project","name":"embedded-in-project","location":"{}","content":"Embedded body."}}"#,
                project.join("tools/SKILL.md").display()
            ))
            .unwrap(),
        )
        .unwrap(),
    }));
    activate_artifact(
        &mut service,
        &project.join(".artifacts"),
        "artifact-in-project",
    );
    activate_artifact(
        &mut service,
        &roots.data.join("artifacts"),
        "artifact-outside",
    );
    let scopes = service
        .list()
        .await
        .unwrap()
        .iter()
        .map(|info| {
            (
                info.id.to_utf8().unwrap(),
                skill::scope(info, Some(&project), &roots),
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        scopes,
        BTreeMap::from([
            ("project-claude".into(), Some(Scope::Project)),
            ("nested-agents".into(), Some(Scope::Project)),
            ("ancestor-claude".into(), None),
            ("ancestor-ycoding".into(), None),
            ("global-agents".into(), Some(Scope::Global)),
            ("global-claude".into(), Some(Scope::Global)),
            ("global-config".into(), Some(Scope::Global)),
            ("config-singular".into(), None),
            ("embedded".into(), None),
            ("embedded-in-project".into(), Some(Scope::Project)),
            ("artifact-in-project".into(), Some(Scope::Project)),
            ("artifact-outside".into(), None),
        ])
    );
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn skill_scope_containment_is_component_wise_and_prefers_the_project() {
    let roots = Roots::development(Path::new("/fixture")).unwrap();
    let info = |location: &str| {
        Info::decode(
            &parse_json(&format!(
                r#"{{"id":"x","name":"x","location":"{location}","content":"x"}}"#
            ))
            .unwrap(),
        )
        .unwrap()
    };
    let project = Path::new("/fixture/repo");
    for (location, expected) in [
        ("/fixture/repo/SKILL.md", Some(Scope::Project)),
        ("/fixture/repo-other/SKILL.md", None),
        ("/fixture/.agents/skills-other/x/SKILL.md", None),
        (
            "/fixture/.agents/skills/x/../y/SKILL.md",
            Some(Scope::Global),
        ),
        ("/fixture/.agents/skills/../x/SKILL.md", None),
        (
            "/fixture/config/ycoding/skills/x/SKILL.md",
            Some(Scope::Global),
        ),
    ] {
        assert_eq!(
            skill::scope(&info(location), Some(project), &roots),
            expected,
            "{location}"
        );
    }
    assert_eq!(
        skill::scope(
            &info("/fixture/.claude/skills/x/SKILL.md"),
            Some(Path::new("/fixture")),
            &roots
        ),
        Some(Scope::Project)
    );
}

#[cfg(unix)]
#[test]
fn skill_scope_treats_a_project_directory_without_utf8_as_a_plain_path() {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    let roots = Roots::development(Path::new("/fixture")).unwrap();
    let info = |location: &str| {
        Info::decode(
            &parse_json(&format!(
                r#"{{"id":"x","name":"x","location":"{location}","content":"x"}}"#
            ))
            .unwrap(),
        )
        .unwrap()
    };
    let project = Path::new(OsStr::from_bytes(b"/fixture/repo-\xff"));
    for project in [Some(project), None] {
        assert_eq!(
            skill::scope(&info("/fixture/repo-\u{ff}/SKILL.md"), project, &roots),
            None
        );
        assert_eq!(
            skill::scope(&info("/fixture/.claude/skills/x/SKILL.md"), project, &roots),
            Some(Scope::Global)
        );
    }
    assert_eq!(
        skill::scope(
            &info("/fixture/repo/SKILL.md"),
            Some(Path::new(OsStr::from_bytes(b"/fixture"))),
            &roots
        ),
        Some(Scope::Project)
    );
}
