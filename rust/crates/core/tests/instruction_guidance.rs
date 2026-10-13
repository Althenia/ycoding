use std::path::Path;
use ycoding_core::resources::{agent, discovery, reference, skill};
use ycoding_schema::{DomainDecode, parse_json};

#[test]
fn skill_guidance_filters_denies_and_autoinvoke_and_escapes_xml_then_renders_deltas() {
    let a = skill::from_frontmatter(
        Path::new("/skills/a.md"),
        Path::new("/skills"),
        &parse_json(r#"{"name":"<A & 'quote'\">","description":"Description"}"#).unwrap(),
        "A",
    )
    .unwrap();
    let mut b = a.clone();
    b.id = "b".into();
    b.name = "B".into();
    b.description = Some("B description".into());
    let mut c = a.clone();
    c.id = "c".into();
    c.autoinvoke = Some(false);
    let mut selected = agent::empty("reviewer".into());
    selected.permissions.push(
        ycoding_schema::permission::Rule::decode(
            &parse_json(r#"{"action":"s?ill","resource":"b","effect":"deny"}"#).unwrap(),
        )
        .unwrap(),
    );
    let skills = vec![a.clone(), b.clone(), c];
    let allowed = skill::available(&skills, &selected);
    assert_eq!(
        allowed.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
        vec!["a".into(), "c".into()]
    );
    let before = skill::instructions::summaries_by(&allowed, |a, b| a.cmp(b));
    assert_eq!(before.len(), 1);
    let rendered = skill::instructions::render(&before).to_utf8().unwrap();
    assert!(rendered.contains("<name>&lt;A &amp; &apos;quote&apos;&quot;&gt;</name>"));
    let after = skill::instructions::summaries_by(&[&a, &b], |a, b| a.cmp(b));
    assert!(
        skill::instructions::changed(&before, &after)
            .to_utf8()
            .unwrap()
            .starts_with("New skills are available in addition to those previously listed:")
    );
    assert!(
        skill::instructions::changed(&after, &before)
            .to_utf8()
            .unwrap()
            .contains("The following skill IDs are no longer available and must not be used: b.")
    );
    let mut modified = after.clone();
    modified[0].description = "Changed".into();
    assert!(
        skill::instructions::changed(&after, &modified)
            .to_utf8()
            .unwrap()
            .starts_with("The available skills have changed. This list supersedes")
    );
    assert!(
        skill::instructions::render(&[])
            .to_utf8()
            .unwrap()
            .ends_with("No skills are currently available.")
    );
}

#[test]
fn reference_guidance_includes_described_even_hidden_sources_and_preserves_ts_markup_and_deltas() {
    let source = ycoding_schema::reference::Source::Local(ycoding_schema::reference::LocalSource {
        path: discovery::absolute_path(Path::new("/one")).unwrap(),
        description: Some("<raw>".into()),
        hidden: Some(true),
    });
    let first = ycoding_schema::reference::Info {
        name: "one".into(),
        path: discovery::absolute_path(Path::new("/one")).unwrap(),
        description: Some("<raw>".into()),
        hidden: Some(true),
        source,
    };
    let mut second = first.clone();
    second.name = "two".into();
    second.path = discovery::absolute_path(Path::new("/two")).unwrap();
    let before =
        reference::instructions::summaries_by(std::slice::from_ref(&first), |a, b| a.cmp(b));
    assert_eq!(before.len(), 1);
    assert!(
        reference::instructions::render(&before)
            .to_utf8()
            .unwrap()
            .contains("<description><raw></description>")
    );
    let after = reference::instructions::summaries_by(&[first, second], |a, b| b.cmp(a));
    assert_eq!(after[0].name, "two".into());
    assert!(
        reference::instructions::changed(&before, &after)
            .to_utf8()
            .unwrap()
            .starts_with(
                "New project references are available in addition to those previously listed:"
            )
    );
    assert!(reference::instructions::changed(&after,&before).to_utf8().unwrap().ends_with("The following project references are no longer available and must not be used: two."));
    let mut changed = before.clone();
    changed[0].path = "/new".into();
    assert!(
        reference::instructions::changed(&before, &changed)
            .to_utf8()
            .unwrap()
            .starts_with("The available project references have changed. This list supersedes")
    );
}
