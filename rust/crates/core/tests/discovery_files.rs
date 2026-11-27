use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::{
    agent, command,
    config::{Configuration, LoadOptions, Roots},
    discovery, skill,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-resource-files-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn write(&self, path: &str, content: &str) -> PathBuf {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }
    fn options(&self) -> LoadOptions {
        let directory = self.0.join("project/nested");
        fs::create_dir_all(&directory).unwrap();
        LoadOptions {
            directory,
            roots: Roots::development(&self.0).unwrap(),
            project: true,
            file: None,
            content: None,
            env: BTreeMap::new(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn markdown_agents_and_commands_obey_recursive_precedence_strict_fields_and_directory_collisions() {
    let f = Fixture::new();
    f.write("config/ycoding/ycoding.json", r#"{"default_agent":"review","agents":{"review":{"description":"global","mode":"primary"}},"commands":{"review":{"template":"inline","description":"retained","subtask":true}}}"#);
    let global = f.write(
        "config/ycoding/agents/review.md",
        "---\ndescription: File: global\n---\nGlobal body",
    );
    let ancestor = f.write(
        "project/.ycoding/agents/review.md",
        "---\nrequest:\n  body: {b: 2}\n---\nAncestor",
    );
    let nearest = f.write(
        "project/nested/.ycoding/agents/review.md",
        "---\ndescription: nearest\n---\nNearest",
    );
    f.write("project/nested/.ycoding/agents/team/helper.md", "Help.");
    f.write(
        "project/nested/.ycoding/agents/gone.md",
        "---\ndisabled: true\n---\nGone",
    );
    f.write(
        "project/nested/.ycoding/agents/bad.md",
        "---\nhidden: nope\n---\nBad",
    );
    f.write("project/nested/.ycoding/agents/empty.md", "");
    let first = f.write(
        "project/.ycoding/command/review.md",
        "---\nagent: reviewer\n---\nFirst",
    );
    let last = f.write("project/.ycoding/commands/review.md", "Last");
    f.write("project/.ycoding/commands/empty.md", "");
    f.write("project/.ycoding/commands/nested/docs.md", "Write docs");
    f.write(
        "project/.ycoding/commands/bad.md",
        "---\nsubtask: nope\n---\nBad",
    );
    let options = f.options();
    let config = Configuration::load(options.clone()).unwrap();
    let mut diagnostics = Vec::new();
    let agents = agent::Service::from_entries(
        &config.entries,
        &options.roots.home,
        Vec::new(),
        &mut diagnostics,
    )
    .unwrap();
    let review = agents.get(&"review".into()).unwrap();
    assert_eq!(review.description, Some("nearest".into()));
    assert_eq!(review.system, Some("Nearest".into()));
    assert_eq!(review.mode, "primary".into());
    assert_eq!(
        review
            .locations
            .as_ref()
            .unwrap()
            .iter()
            .map(|p| p.as_lossless().to_utf8().unwrap())
            .collect::<Vec<_>>(),
        vec![
            f.0.join("config/ycoding/ycoding.json").to_str().unwrap(),
            global.to_str().unwrap(),
            ancestor.to_str().unwrap(),
            nearest.to_str().unwrap()
        ]
    );
    assert_eq!(agents.default().unwrap().id, "review".into());
    for missing in ["gone", "bad", "empty"] {
        assert!(agents.get(&missing.into()).is_none(), "{missing}");
    }
    assert!(agents.get(&"team/helper".into()).is_some());
    let commands = command::Service::from_entries(&config.entries, &mut diagnostics).unwrap();
    assert_eq!(
        commands
            .list()
            .iter()
            .map(|c| c.name.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["review", "empty", "nested/docs"]
    );
    let review = commands.get(&"review".into()).unwrap();
    assert_eq!(review.template, "Last".into());
    assert_eq!(review.description, Some("retained".into()));
    assert_eq!(review.agent, None);
    assert_eq!(review.locations.as_ref().unwrap().len(), 2);
    assert_eq!(
        review.locations.as_ref().unwrap()[1].as_lossless(),
        &last.to_str().unwrap().into()
    );
    assert!(
        !review
            .locations
            .as_ref()
            .unwrap()
            .iter()
            .any(|p| p.as_lossless() == &first.to_str().unwrap().into())
    );
    assert_eq!(commands.get(&"empty".into()).unwrap().template, "".into());
    assert!(diagnostics.iter().any(|d| d.path.ends_with("bad.md")));
}

#[tokio::test]
async fn skill_listing_rereads_files_with_ecosystem_ancestor_order_then_ycoding_and_configured_sources()
 {
    let f = Fixture::new();
    f.write(
        ".claude/skills/review/SKILL.md",
        "---\nname: review\ndescription: global claude\n---\nGlobal",
    );
    f.write(
        "project/nested/.claude/skills/review/SKILL.md",
        "---\nname: review\ndescription: nearest claude\n---\nNearest",
    );
    f.write(
        "project/.claude/skills/review/SKILL.md",
        "---\nname: review\ndescription: ancestor claude\n---\nAncestor",
    );
    let file = f.write(
        "config/ycoding/skills/review/SKILL.md",
        "---\nname: review\ndescription: YCoding\n---\nY",
    );
    let options = f.options();
    let config = Configuration::load(options.clone()).unwrap();
    let mut service = skill::Service::from_entries(
        &config.entries,
        &options.directory,
        &options.roots.home,
        &options.roots.cache,
    )
    .unwrap();
    assert_eq!(review(service.list().await.unwrap()), "YCoding".into());
    fs::remove_file(&file).unwrap();
    assert_eq!(
        review(service.list().await.unwrap()),
        "ancestor claude".into()
    );
    f.write(
        "project/.claude/skills/review/SKILL.md",
        "---\nname: review\ndescription: edited\n---\nnew",
    );
    assert_eq!(review(service.list().await.unwrap()), "edited".into());
    assert!(service.changed(&file));
    assert!(!service.changed(&f.0.join("config/ycoding/skills-other/review/SKILL.md")));
}

fn review(skills: Vec<ycoding_schema::skill::Info>) -> ycoding_schema::LosslessString {
    let ids = skills
        .iter()
        .map(|skill| skill.id.to_utf8().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            "ycoding",
            "chatgpt-connectors",
            "browser-use",
            "computer-use",
            "report",
            "review"
        ]
    );
    skills.into_iter().nth(5).unwrap().description.unwrap()
}

#[tokio::test]
async fn skill_listing_derives_path_ids_retains_body_validates_metadata_and_follows_symlinks() {
    let f = Fixture::new();
    let root = f.0.join("skills");
    f.write("skills/z/SKILL.md", "---\nname: z\ndescription: zed\nmetadata:\n  display-name: Display\n  slash: ' TRUE '\n  conflicts: ' other , other'\n  instruction-conflicts: core/instructions, core/instructions\n---\nBody\n");
    f.write(
        "skills/a/one/SKILL.md",
        "---\nname: one\ndescription: first\n---\nFirst",
    );
    f.write(
        "skills/b/one/SKILL.md",
        "---\nname: one\ndescription: last\n---\nLast",
    );
    f.write("skills/nested/ignored.md", "Ignored");
    f.write(
        "skills/flat.md",
        "---\nname: flat\ndescription: flat\n---\nFlat",
    );
    f.write(
        "skills/z/references/SKILL.md",
        "---\nname: references\ndescription: nested\n---\nNested",
    );
    f.write("skills/empty/SKILL.md", "");
    f.write(
        "skills/invalid/SKILL.md",
        "---\nname: invalid\ndescription: bad\nmetadata:\n  instruction-conflicts: Bad\n---\nBad",
    );
    f.write(
        "skills/mismatch/SKILL.md",
        "---\nname: other\ndescription: bad\n---\nBad",
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(f.0.join("skills/a"), root.join("linked")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
    }
    let mut service = skill::Service::new(&f.0.join("cache"));
    service.source(ycoding_schema::skill::Source::Directory(
        ycoding_schema::skill::DirectorySource {
            path: discovery::absolute_path(&root).unwrap(),
        },
    ));
    let list = service.list().await.unwrap();
    assert_eq!(
        list.iter()
            .map(|s| s.id.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["one", "z"]
    );
    let z = &list[1];
    assert_eq!(z.content, "Body\n".into());
    assert_eq!(z.name, "Display".into());
    assert_eq!(z.slash, Some(true));
    assert_eq!(z.autoinvoke, None);
    assert_eq!(z.conflicts.as_ref().unwrap().skills, vec!["other".into()]);
    #[cfg(unix)]
    assert_eq!(list[0].description, Some("first".into()));
    assert!(
        service
            .diagnostics()
            .iter()
            .any(|d| d.path.ends_with("invalid/SKILL.md"))
    );
    assert!(
        service
            .diagnostics()
            .iter()
            .any(|d| d.path.ends_with("mismatch/SKILL.md"))
    );
}

#[test]
fn markdown_agent_validation_rejects_nonfinite_json_and_preserves_negative_zero() {
    let f = Fixture::new();
    f.write(
        "project/.ycoding/agents/invalid-body.md",
        "---\nrequest:\n  body: {x: .nan}\n---\nInvalid body",
    );
    f.write(
        "project/.ycoding/agents/negative-zero.md",
        "---\nrequest:\n  body: {x: -0.0}\n---\nZero body",
    );
    let options = f.options();
    let config = Configuration::load(options.clone()).unwrap();
    let agents = agent::Service::from_entries(
        &config.entries,
        &options.roots.home,
        Vec::new(),
        &mut Vec::new(),
    )
    .unwrap();
    assert!(agents.get(&"invalid-body".into()).is_none());
    let value = agents
        .get(&"negative-zero".into())
        .unwrap()
        .request
        .body
        .0
        .get(&"x".into())
        .unwrap();
    let ycoding_schema::JsonValue::Number(value) = value else {
        panic!()
    };
    assert_eq!(*value, 0.0);
    assert!(value.is_sign_negative());
}
