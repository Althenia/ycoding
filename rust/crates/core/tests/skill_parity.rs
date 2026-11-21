use std::{fs, path::Path};
use ycoding_core::resources::{
    config::Entry,
    skill::{self, Service},
};
use ycoding_schema::{
    DomainDecode, parse_json,
    schema::AbsolutePath,
    skill::{Info, Source},
};

const YCODING: &str = include_str!("../../../../packages/core/src/plugin/skill/ycoding.md");
const REPORT: &str = include_str!("../../../../packages/core/src/plugin/skill/report.md");
const CHATGPT_CONNECTORS: &str =
    include_str!("../../../../packages/core/src/plugin/skill/chatgpt-connectors.md");
const BROWSER_USE: &str = include_str!("../../../../packages/core/src/plugin/skill/browser-use.md");
const COMPUTER_USE: &str =
    include_str!("../../../../packages/core/src/plugin/skill/computer-use.md");
const BUNDLED_IDS: [&str; 5] = [
    "ycoding",
    "chatgpt-connectors",
    "browser-use",
    "computer-use",
    "report",
];
const PLUGIN: &str = include_str!("../../../../packages/core/src/plugin/skill.ts");
const SNAPSHOT: &str = "\n\n## Runtime Diagnostics Snapshot\n\nThese values were captured when the built-in report skill was registered. Verify them before publishing.\n\n";

#[test]
fn skill_sources_keep_bundled_then_ecosystem_then_ycoding_then_configured_order_and_dedupe() {
    let entries = vec![Entry::ClaudeDirectory("/home/test/.claude".into()), Entry::ClaudeDirectory("/repo/nested/.claude".into()), Entry::ClaudeDirectory("/repo/.claude".into()), Entry::AgentsDirectory("/home/test/.agents".into()), Entry::Directory("/global".into()), Entry::Directory("/repo/.ycoding".into()), Entry::Document { path: Some("/repo/ycoding.json".into()), info: parse_json(r#"{"skills":["./skills","~/shared","/global/skills","https://example.test/catalog","./skills"]}"#).unwrap() }];
    let mut service = Service::from_entries(
        &entries,
        Path::new("/repo/nested"),
        Path::new("/home/test"),
        Path::new("/fixture/cache"),
    )
    .unwrap();
    assert_eq!(
        service
            .sources()
            .iter()
            .map(|s| s.key().to_utf8().unwrap())
            .collect::<Vec<_>>(),
        [
            "embedded:ycoding",
            "embedded:chatgpt-connectors",
            "embedded:browser-use",
            "embedded:computer-use",
            "embedded:report",
            "directory:/home/test/.claude/skills",
            "directory:/repo/nested/.claude/skills",
            "directory:/repo/.claude/skills",
            "directory:/home/test/.agents/skills",
            "directory:/global/skill",
            "directory:/global/skills",
            "directory:/repo/.ycoding/skill",
            "directory:/repo/.ycoding/skills",
            "directory:/repo/nested/skills",
            "directory:/home/test/shared",
            "url:https://example.test/catalog"
        ]
    );
    assert!(service.changed(Path::new("/repo/nested/skills/x/SKILL.md")));
    assert!(!service.changed(Path::new("/repo/nested/skills-other/x.md")));
    assert_eq!(service.revision(), 1);
}

#[test]
fn skill_decoded_frontmatter_normalizes_metadata_conflicts_and_retains_content() {
    let data = parse_json(r#"{"name":"display","description":"desc","slash":false,"metadata":{"ycoding/slash":" TRUE ","ycoding/autoinvoke":false,"ycoding/conflicts":{"skills":[" other ","other"],"instructions":[" core/instructions ","core/instructions"]}}}"#).unwrap();
    let info = skill::from_frontmatter(
        Path::new("/skills/z.md"),
        Path::new("/skills"),
        &data,
        "Body\n",
    )
    .unwrap();
    assert_eq!(info.id, "z".into());
    assert_eq!(info.name, "display".into());
    assert_eq!(info.slash, Some(true));
    assert_eq!(info.autoinvoke, Some(false));
    assert_eq!(info.content, "Body\n".into());
    assert_eq!(
        info.conflicts.as_ref().unwrap().skills,
        vec!["other".into()]
    );
    assert_eq!(info.conflicts.as_ref().unwrap().instructions.len(), 1);
    let plain = skill::from_frontmatter(
        Path::new("/skills/team/SKILL.md"),
        Path::new("/skills"),
        &parse_json("{}").unwrap(),
        "",
    )
    .unwrap();
    assert_eq!(plain.id, "team".into());
    assert_eq!(plain.name, "team".into());
    assert_eq!(plain.description, None);
    assert_eq!(plain.conflicts, None);
    assert_eq!(
        skill::from_frontmatter(
            Path::new("/skills/SKILL.md"),
            Path::new("/skills"),
            &parse_json("{}").unwrap(),
            ""
        )
        .unwrap()
        .id,
        "SKILL".into()
    );
}

#[test]
fn skill_decoded_frontmatter_rejects_malformed_required_conflict_shapes_and_invalid_flags() {
    for input in [
        r#"{"slash":"true"}"#,
        r#"{"name":null}"#,
        r#"{"metadata":{"ycoding/conflicts":[]}}"#,
        r#"{"metadata":{"ycoding/conflicts":{"skills":[" "]}}}"#,
        r#"{"metadata":{"ycoding/conflicts":{"instructions":["Bad"]}}}"#,
        r#"{"metadata":{"ycoding/conflicts":{"skills":[1]}}}"#,
    ] {
        assert!(
            skill::from_frontmatter(
                Path::new("/skills/x.md"),
                Path::new("/skills"),
                &parse_json(input).unwrap(),
                "Body"
            )
            .is_err(),
            "{input}"
        );
    }
    let data =
        parse_json(r#"{"metadata":{"ycoding/slash":"maybe","ycoding/conflicts":{"extra":1}}}"#)
            .unwrap();
    let info = skill::from_frontmatter(
        Path::new("/skills/x.md"),
        Path::new("/skills"),
        &data,
        "Body",
    )
    .unwrap();
    assert_eq!(info.slash, None);
    assert_eq!(info.conflicts.as_ref().unwrap().skills.len(), 0);
    let source = ycoding_schema::skill::Source::decode(&parse_json(r#"{"type":"embedded","skill":{"id":"one","name":"One","location":"/builtin/one.md","content":"body"}}"#).unwrap()).unwrap();
    let mut service = Service::new(Path::new("/fixture/cache"));
    service.source(source.clone());
    service.source(source);
    assert_eq!(service.sources().len(), 1);
    assert_eq!(service.embedded().len(), 1);
    assert_eq!(service.embedded()[0].content, "body".into());
    assert!(!service.changed(Path::new("/builtin/one.md")));
    assert_eq!(service.revision(), 0);
}

#[test]
fn skill_conflict_ids_preserve_utf16_and_trim_ecmascript_whitespace() {
    let data = parse_json(
        r#"{"metadata":{"ycoding/conflicts":{"skills":["\ufeff\ud800\ufeff","\ud800"]}}}"#,
    )
    .unwrap();
    let info = skill::from_frontmatter(
        Path::new("/skills/x.md"),
        Path::new("/skills"),
        &data,
        "Body",
    )
    .unwrap();
    assert_eq!(
        info.conflicts.unwrap().skills,
        vec![ycoding_schema::LosslessString::from_utf16(vec![0xd800])]
    );
}

#[tokio::test]
async fn bundled_skills_lead_the_catalog_with_reference_metadata_and_content() {
    let block = |id: &str| {
        PLUGIN
            .split_once(&format!("Skill.ID.make(\"{id}\")"))
            .unwrap()
            .1
            .split_once("content:")
            .unwrap()
            .0
    };
    for literal in [
        "Skill.Name.make(\"YCoding\")",
        "description: YCodingDescription",
        "AbsolutePath.make(\"/builtin/ycoding.md\")",
    ] {
        assert!(block("ycoding").contains(literal), "{literal}");
    }
    assert!(!block("ycoding").contains("slash"));
    for literal in [
        "Skill.Name.make(\"Report\")",
        "description: REPORT_DESCRIPTION",
        "slash: true",
        "AbsolutePath.make(\"/builtin/report.md\")",
    ] {
        assert!(block("report").contains(literal), "{literal}");
    }
    for literal in [
        "Skill.Name.make(\"ChatGPT connectors\")",
        "description: CHATGPT_CONNECTORS_DESCRIPTION",
        "AbsolutePath.make(\"/builtin/chatgpt-connectors.md\")",
    ] {
        assert!(block("chatgpt-connectors").contains(literal), "{literal}");
    }
    assert!(!block("chatgpt-connectors").contains("slash"));
    let interaction = [
        (
            "browser-use",
            "Browser use",
            "BROWSER_USE_DESCRIPTION",
            "/builtin/browser-use.md",
            BROWSER_USE,
        ),
        (
            "computer-use",
            "Computer use",
            "COMPUTER_USE_DESCRIPTION",
            "/builtin/computer-use.md",
            COMPUTER_USE,
        ),
    ];
    for (id, name, description, path, _) in interaction {
        let definition = block(id);
        assert!(definition.contains(&format!("Skill.Name.make(\"{name}\")")));
        assert!(definition.contains(&format!("description: {description}")));
        assert!(definition.contains(&format!("AbsolutePath.make(\"{path}\")")));
        assert!(!definition.contains("slash"));
    }
    assert_eq!(
        PLUGIN
            .split("id: Skill.ID.make(\"")
            .skip(1)
            .map(|source| source.split_once('"').unwrap().0)
            .collect::<Vec<_>>(),
        BUNDLED_IDS
    );
    let mut service = Service::from_entries(
        &[],
        Path::new("/fixture/repo"),
        Path::new("/fixture/home"),
        Path::new("/fixture/cache"),
    )
    .unwrap();
    let skills = service.list().await.unwrap();
    assert_eq!(ids(&skills), BUNDLED_IDS);
    assert_eq!(
        skills[0],
        Info {
            id: "ycoding".into(),
            name: "YCoding".into(),
            description: Some(reference_constant("YCodingDescription").into()),
            slash: None,
            autoinvoke: None,
            conflicts: None,
            location: AbsolutePath::new("/builtin/ycoding.md").unwrap(),
            content: YCODING.into(),
        }
    );
    assert_eq!(
        Info {
            content: "".into(),
            ..skills[4].clone()
        },
        Info {
            id: "report".into(),
            name: "Report".into(),
            description: Some(reference_constant("REPORT_DESCRIPTION").into()),
            slash: Some(true),
            autoinvoke: None,
            conflicts: None,
            location: AbsolutePath::new("/builtin/report.md").unwrap(),
            content: "".into(),
        }
    );
    let content = skills[4].content.to_utf8().unwrap();
    let diagnostics = content
        .strip_prefix(REPORT)
        .unwrap()
        .strip_prefix(SNAPSHOT)
        .unwrap();
    assert_eq!(
        diagnostics
            .lines()
            .map(|line| line.split_once(": ").unwrap().0)
            .collect::<Vec<_>>(),
        [
            "- ycoding version",
            "- install/channel",
            "- OS",
            "- Terminal",
            "- Shell",
            "- Active plugins"
        ]
    );
    assert!(diagnostics.ends_with("\n- Active plugins: None found in config"));
    assert_eq!(
        skills[1],
        Info {
            id: "chatgpt-connectors".into(),
            name: "ChatGPT connectors".into(),
            description: Some(reference_constant("CHATGPT_CONNECTORS_DESCRIPTION").into()),
            slash: None,
            autoinvoke: None,
            conflicts: None,
            location: AbsolutePath::new("/builtin/chatgpt-connectors.md").unwrap(),
            content: CHATGPT_CONNECTORS.into(),
        }
    );
    let connectors = skills[1].content.to_utf8().unwrap();
    for literal in [
        "search({ query:",
        "tools.chatgpt.<connector>.<operation>",
        "`chatgpt_*`",
        "tools.chatgpt.library.prepare",
        "tools.chatgpt.library.upload",
        "tools.chatgpt.library.list",
        "tools.chatgpt.library.download",
        "tools.chatgpt.library.materialize",
        "account_connectors.chatgpt.enabled",
        "returns text without structured data, Code Mode returns that text",
        "## Hosted file references",
        "`file_uri` with `file_id` and `download_url`",
        "`source_file` with those fields plus `file_name` and `mime_type`",
        "Neither a local path nor a Library `attachmentURI` or `fileID`",
        "If no authorized flow supplies the required reference, stop.",
        "Do not route the file through another tool to work around a denial.",
    ] {
        assert!(connectors.contains(literal), "{literal}");
    }
    for (actual, (id, name, description, path, content)) in skills[2..4].iter().zip(interaction) {
        assert_eq!(
            *actual,
            Info {
                id: id.into(),
                name: name.into(),
                description: Some(reference_constant(description).into()),
                slash: None,
                autoinvoke: None,
                conflicts: None,
                location: AbsolutePath::new(path).unwrap(),
                content: content.into(),
            }
        );
    }
    assert_eq!(
        service.embedded().into_iter().cloned().collect::<Vec<_>>(),
        skills
    );
}

#[tokio::test]
async fn configured_skills_replace_bundled_skills_in_their_catalog_position() {
    let root = std::env::temp_dir().join(format!("ycoding-bundled-skills-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("skills/ycoding")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let guide = root.join("skills/ycoding/SKILL.md");
    fs::write(&guide, "---\nname: Project YCoding\n---\nProject guide").unwrap();
    fs::write(
        root.join("skills/report.md"),
        "---\ndescription: Local report\n---\nLocal report body",
    )
    .unwrap();
    let mut service = Service::from_entries(
        &[Entry::Directory(root.clone())],
        &root,
        &root,
        &root.join("cache"),
    )
    .unwrap();
    let skills = service.list().await.unwrap();
    assert_eq!(ids(&skills), BUNDLED_IDS);
    assert_eq!(skills[0].name, "Project YCoding".into());
    assert_eq!(skills[0].content, "Project guide".into());
    assert_eq!(
        skills[0].location,
        AbsolutePath::new(guide.to_str().unwrap()).unwrap()
    );
    assert_eq!(skills[4].name, "report".into());
    assert_eq!(skills[4].description, Some("Local report".into()));
    assert_eq!(skills[4].slash, None);
    assert_eq!(skills[4].content, "Local report body".into());
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn skill_capability_selection_filters_bundled_skills() {
    for (capabilities, expected) in [
        (
            r#"{"skills":{"deny":["ycoding","chatgpt-connectors","browser-use","computer-use","report"]}}"#,
            &[][..],
        ),
        (r#"{"skills":{"allow":["rep*"]}}"#, &["report"][..]),
        (r#"{"skills":{"enabled":false}}"#, &[][..]),
    ] {
        let entries = [Entry::Document {
            path: None,
            info: parse_json(&format!(r#"{{"capabilities":{capabilities}}}"#)).unwrap(),
        }];
        let mut service = Service::from_entries(
            &entries,
            Path::new("/fixture/repo"),
            Path::new("/fixture/home"),
            Path::new("/fixture/cache"),
        )
        .unwrap();
        assert_eq!(
            ids(&service.list().await.unwrap()),
            expected,
            "{capabilities}"
        );
        assert_eq!(
            service
                .embedded()
                .iter()
                .map(|skill| skill.id.to_utf8().unwrap())
                .collect::<Vec<_>>(),
            expected,
            "{capabilities}"
        );
    }
}

#[cfg(unix)]
#[test]
fn report_diagnostics_follow_the_reference_snapshot() {
    for literal in [
        "\"## Runtime Diagnostics Snapshot\"",
        "\"These values were captured when the built-in report skill was registered. Verify them before publishing.\"",
        "`- ycoding version: ${InstallationVersion}`",
        "`- install/channel: ${InstallationChannel}`",
        "`- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`",
        "`- Terminal: ${terminal()}`",
        "`- Shell: ${shell()}`",
        "`- Active plugins: ${plugins.length === 0 ? \"None found in config\" : plugins.join(\", \")}`",
        "\"Unavailable: terminal environment variables are not set\"",
        "\"Unavailable: shell environment variable is not set\"",
    ] {
        assert!(PLUGIN.contains(literal), "{literal}");
    }
    let root =
        std::env::temp_dir().join(format!("ycoding-report-diagnostics-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("dot/plugins/folder.ts")).unwrap();
    fs::create_dir_all(root.join("dot/plugins/nested")).unwrap();
    fs::create_dir_all(root.join("dot/plugin")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    for file in [
        "dot/plugins/b.ts",
        "dot/plugin/a.js",
        "dot/plugins/.hidden.js",
        "dot/plugins/notes.md",
        "dot/plugins/nested/c.ts",
    ] {
        fs::write(root.join(file), "").unwrap();
    }
    let location = root.join("work");
    let entries = [
        Entry::Document {
            path: Some(root.join("config/ycoding.json")),
            info: parse_json(r#"{"plugins":["zeta-package",{"package":"./local/plugin.ts","options":{"level":1}},"../shared/tool.js","file:///opt/plugins/a%20b.ts","-ycoding.command"]}"#).unwrap(),
        },
        Entry::Document {
            path: None,
            info: parse_json(r#"{"plugins":["./inline.ts"]}"#).unwrap(),
        },
        Entry::Directory(root.join("dot")),
        Entry::AgentsDirectory(root.join(".agents")),
    ];
    let mut plugins = [
        "zeta-package".to_owned(),
        root.join("config/local/plugin.ts").display().to_string(),
        root.join("shared/tool.js").display().to_string(),
        "/opt/plugins/a b.ts".to_owned(),
        "-ycoding.command".to_owned(),
        location.join("inline.ts").display().to_string(),
        root.join("dot/plugin/a.js").display().to_string(),
        root.join("dot/plugins/.hidden.js").display().to_string(),
        root.join("dot/plugins/b.ts").display().to_string(),
    ];
    plugins.sort();
    let uname = |flag: &str| {
        String::from_utf8(
            std::process::Command::new("uname")
                .arg(flag)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_owned()
    };
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let system = format!("{} {} ({platform} {arch})", uname("-s"), uname("-r"));
    assert_eq!(
        diagnostics(
            &entries,
            &location,
            &[
                ("YCODING_VERSION", "1.2.3"),
                ("YCODING_CHANNEL", "beta"),
                ("TERM_PROGRAM", "Fixture"),
                ("TERM", ""),
                ("COLORTERM", "truecolor"),
                ("ComSpec", "C:\\Windows\\cmd.exe"),
                ("COMSPEC", "unused"),
            ]
        ),
        format!(
            "- ycoding version: 1.2.3\n- install/channel: beta\n- OS: {system}\n- Terminal: TERM_PROGRAM=Fixture, COLORTERM=truecolor\n- Shell: C:\\Windows\\cmd.exe\n- Active plugins: {}",
            plugins.join(", ")
        )
    );
    assert_eq!(
        diagnostics(
            &[],
            &location,
            &[
                ("YCODING_VERSION", ""),
                ("SHELL", ""),
                ("ComSpec", "unused")
            ]
        ),
        format!(
            "- ycoding version: {}\n- install/channel: local\n- OS: {system}\n- Terminal: Unavailable: terminal environment variables are not set\n- Shell: \n- Active plugins: None found in config",
            env!("CARGO_PKG_VERSION")
        )
    );
    assert!(
        diagnostics(&[], &location, &[])
            .contains("\n- Shell: Unavailable: shell environment variable is not set\n")
    );
    fs::remove_dir_all(root).unwrap();
}

fn diagnostics(entries: &[Entry], location: &Path, variables: &[(&str, &str)]) -> String {
    let sources = skill::builtin::sources(entries, location, |key| {
        variables
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| (*value).to_owned())
    })
    .unwrap();
    let [
        Source::Embedded(ycoding),
        Source::Embedded(_),
        Source::Embedded(_),
        Source::Embedded(_),
        Source::Embedded(report),
    ] = sources.as_slice()
    else {
        panic!("bundled skill sources");
    };
    assert_eq!(ycoding.skill.id, "ycoding".into());
    assert_eq!(report.skill.id, "report".into());
    report
        .skill
        .content
        .to_utf8()
        .unwrap()
        .strip_prefix(REPORT)
        .unwrap()
        .strip_prefix(SNAPSHOT)
        .unwrap()
        .to_owned()
}

fn ids(skills: &[Info]) -> Vec<String> {
    skills
        .iter()
        .map(|skill| skill.id.to_utf8().unwrap())
        .collect()
}

fn reference_constant(name: &str) -> &'static str {
    PLUGIN
        .split_once(&format!("{name} =\n  \""))
        .unwrap()
        .1
        .split_once('"')
        .unwrap()
        .0
}
