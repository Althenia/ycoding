use std::fs;
use ycoding_core::resources::skill::Service;
use ycoding_schema::{
    JsonValue,
    schema::AbsolutePath,
    skill::{DirectorySource, Info, Source},
};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-skill-spec-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn write(&self, path: &str, content: &str) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    async fn list(&self) -> (Vec<Info>, Service, Vec<String>) {
        let mut service = Service::new(&self.0.join("cache"));
        service.source(Source::Directory(DirectorySource {
            path: AbsolutePath::new(self.0.join("skills").to_str().unwrap()).unwrap(),
        }));
        let skills = service.list().await.unwrap();
        let diagnostics = service
            .diagnostics()
            .iter()
            .map(|d| format!("{}: {}", d.path, d.message))
            .collect();
        (skills, service, diagnostics)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn manifest(name: &str, extra: &str) -> String {
    format!("---\nname: {name}\ndescription: Does a thing. Use when testing.\n{extra}---\nBody\n")
}

fn ids(skills: &[Info]) -> Vec<String> {
    skills.iter().map(|s| s.id.to_utf8().unwrap()).collect()
}

#[tokio::test]
async fn only_skill_directories_with_a_manifest_are_skills() {
    let f = Fixture::new();
    f.write("skills/flat.md", &manifest("flat", ""));
    f.write("skills/real/SKILL.md", &manifest("real", ""));
    f.write(
        "skills/real/references/inner/SKILL.md",
        &manifest("inner", ""),
    );
    f.write("skills/real/scripts/run.md", "# not a skill");
    f.write("skills/group/child/SKILL.md", &manifest("child", ""));
    let (skills, _, _) = f.list().await;
    assert_eq!(ids(&skills), ["child", "real"]);
}

#[tokio::test]
async fn name_must_follow_the_specification_and_match_the_directory() {
    let f = Fixture::new();
    let long = "a".repeat(65);
    f.write("skills/good-name/SKILL.md", &manifest("good-name", ""));
    f.write("skills/café/SKILL.md", &manifest("café", ""));
    f.write("skills/mismatch/SKILL.md", &manifest("other", ""));
    f.write("skills/Upper/SKILL.md", &manifest("Upper", ""));
    f.write("skills/-lead/SKILL.md", &manifest("-lead", ""));
    f.write("skills/trail-/SKILL.md", &manifest("trail-", ""));
    f.write("skills/dou--ble/SKILL.md", &manifest("dou--ble", ""));
    f.write("skills/snake_case/SKILL.md", &manifest("snake_case", ""));
    f.write(&format!("skills/{long}/SKILL.md"), &manifest(&long, ""));
    f.write(
        "skills/anonymous/SKILL.md",
        "---\ndescription: No name. Use never.\n---\nBody\n",
    );
    let (skills, _, diagnostics) = f.list().await;
    assert_eq!(ids(&skills), ["café", "good-name"]);
    assert_eq!(diagnostics.len(), 8, "{diagnostics:?}");
}

#[tokio::test]
async fn description_is_required_nonempty_and_at_most_1024_characters() {
    let f = Fixture::new();
    let edge = "d".repeat(1024);
    let over = "d".repeat(1025);
    f.write(
        "skills/edge/SKILL.md",
        &format!("---\nname: edge\ndescription: {edge}\n---\nBody\n"),
    );
    f.write(
        "skills/over/SKILL.md",
        &format!("---\nname: over\ndescription: {over}\n---\nBody\n"),
    );
    f.write(
        "skills/blank/SKILL.md",
        "---\nname: blank\ndescription: \"  \"\n---\nBody\n",
    );
    f.write("skills/missing/SKILL.md", "---\nname: missing\n---\nBody\n");
    let (skills, _, diagnostics) = f.list().await;
    assert_eq!(ids(&skills), ["edge"]);
    assert_eq!(diagnostics.len(), 3, "{diagnostics:?}");
}

#[tokio::test]
async fn optional_fields_are_validated_and_unknown_top_level_fields_are_tolerated() {
    let f = Fixture::new();
    let long = "c".repeat(501);
    f.write(
        "skills/fine/SKILL.md",
        &manifest(
            "fine",
            "license: Apache-2.0\ncompatibility: Requires git\nallowed-tools: Bash(git:*) Read\nargument-hint: anything\n",
        ),
    );
    f.write(
        "skills/compat/SKILL.md",
        &manifest("compat", &format!("compatibility: {long}\n")),
    );
    f.write(
        "skills/empty-compat/SKILL.md",
        &manifest("empty-compat", "compatibility: \"\"\n"),
    );
    f.write(
        "skills/license/SKILL.md",
        &manifest("license", "license: [a, b]\n"),
    );
    f.write(
        "skills/tools/SKILL.md",
        &manifest("tools", "allowed-tools: [Read]\n"),
    );
    f.write("skills/map/SKILL.md", &manifest("map", "metadata: plain\n"));
    let (skills, _, diagnostics) = f.list().await;
    assert_eq!(ids(&skills), ["fine"]);
    assert_eq!(diagnostics.len(), 5, "{diagnostics:?}");
}

#[tokio::test]
async fn extension_metadata_uses_unprefixed_string_keys_only() {
    let f = Fixture::new();
    f.write(
        "skills/shown/SKILL.md",
        &manifest(
            "shown",
            "metadata:\n  display-name: \"Shown Skill\"\n  slash: \"true\"\n  conflicts: \"alpha, beta, alpha\"\n  instruction-conflicts: \"core/instructions\"\n",
        ),
    );
    f.write(
        "skills/legacy/SKILL.md",
        &manifest(
            "legacy",
            "slash: true\nmetadata:\n  ycoding/slash: \"true\"\n  ycoding/autoinvoke: \"false\"\n  ycoding/conflicts:\n    skills: [alpha]\n",
        ),
    );
    f.write(
        "skills/broken/SKILL.md",
        &manifest("broken", "metadata:\n  conflicts: \"alpha,,beta\"\n"),
    );
    let (skills, _, diagnostics) = f.list().await;
    assert_eq!(ids(&skills), ["legacy", "shown"]);
    assert_eq!(diagnostics.len(), 1, "{diagnostics:?}");
    let legacy = &skills[0];
    assert_eq!(legacy.slash, None);
    assert_eq!(legacy.autoinvoke, None);
    assert_eq!(legacy.conflicts, None);
    assert_eq!(legacy.name, "legacy".into());
    let shown = &skills[1];
    assert_eq!(shown.name, "Shown Skill".into());
    assert_eq!(shown.slash, Some(true));
    let conflicts = shown.conflicts.as_ref().unwrap();
    assert_eq!(conflicts.skills, vec!["alpha".into(), "beta".into()]);
    assert_eq!(conflicts.instructions.len(), 1);
}

#[tokio::test]
async fn canonical_activation_layout_selects_only_valid_auto_skills() {
    let f = Fixture::new();
    f.write(
        "skills/okf-knowledge-bundle/SKILL.md",
        &manifest(
            "okf-knowledge-bundle",
            "metadata:\n  version: \"1.1.0\"\n  activation: \"auto\"\n  keywords: \"open knowledge format, okf v0.3\"\n  events: \"okf.bundle.maintain, okf.graph.export\"\n",
        ),
    );
    f.write(
        "skills/manual-only/SKILL.md",
        &manifest(
            "manual-only",
            "metadata:\n  activation: manual\n  keywords: cargo\n",
        ),
    );
    f.write(
        "skills/malformed/SKILL.md",
        &manifest(
            "malformed",
            "metadata:\n  activation: auto\n  keywords: [cargo]\n",
        ),
    );
    f.write("skills/plain/SKILL.md", &manifest("plain", ""));
    f.write(
        "skills/top-level/SKILL.md",
        &manifest("top-level", "activation: auto\nkeywords: cargo\n"),
    );
    let (skills, service, _) = f.list().await;
    let by = |id: &str| skills.iter().find(|s| s.id == id.into()).unwrap();
    assert_eq!(by("okf-knowledge-bundle").autoinvoke, Some(true));
    assert_eq!(by("manual-only").autoinvoke, Some(false));
    assert_eq!(by("malformed").autoinvoke, Some(false));
    assert_eq!(by("plain").autoinvoke, None);
    assert_eq!(by("top-level").autoinvoke, None);
    let metadata = service
        .activation_metadata(by("okf-knowledge-bundle"))
        .unwrap();
    assert_eq!(
        metadata.get(&"events".into()),
        Some(&JsonValue::String(
            "okf.bundle.maintain, okf.graph.export".into()
        ))
    );
    assert_eq!(metadata.len(), 4);
    assert!(service.activation_metadata(by("plain")).is_none());
}

#[tokio::test]
async fn a_manifest_at_the_source_root_takes_its_directory_name() {
    let f = Fixture::new();
    f.write("skills/SKILL.md", &manifest("skills", ""));
    let (skills, _, diagnostics) = f.list().await;
    assert_eq!(ids(&skills), ["skills"], "{diagnostics:?}");
}

#[test]
fn name_rules_match_the_reference_validator() {
    use ycoding_core::resources::skill::spec::name_violation;
    for (name, directory, valid) in [
        ("pdf-processing", "pdf-processing", true),
        ("data-analysis", "data-analysis", true),
        ("a", "a", true),
        ("PDF-Processing", "PDF-Processing", false),
        ("-pdf", "-pdf", false),
        ("pdf-", "pdf-", false),
        ("pdf--processing", "pdf--processing", false),
        ("pdf processing", "pdf processing", false),
        ("pdf", "other", false),
        ("", "", false),
        ("  ", "x", false),
    ] {
        assert_eq!(
            name_violation(name, directory).is_none(),
            valid,
            "{name:?} in {directory:?}"
        );
    }
    assert!(name_violation(&"a".repeat(64), &"a".repeat(64)).is_none());
    assert!(name_violation(&"a".repeat(65), &"a".repeat(65)).is_some());
}
