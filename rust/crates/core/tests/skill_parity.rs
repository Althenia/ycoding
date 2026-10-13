use std::path::Path;
use ycoding_core::resources::{
    config::Entry,
    skill::{self, Service},
};
use ycoding_schema::{DomainDecode, parse_json};

#[test]
fn skill_sources_keep_ecosystem_then_ycoding_then_configured_order_and_dedupe() {
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
