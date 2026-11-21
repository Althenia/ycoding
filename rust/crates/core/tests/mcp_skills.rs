use ycoding_core::resources::mcp::skills;
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString,
    mcp_skill::{Entry, Reason},
    parse_json,
};

fn raw(uri: &str, name: &str, resources: JsonValue) -> JsonValue {
    let mut value = parse_json(&format!(
        r#"{{"uri":"{uri}","frontmatter":{{"name":"{name}","description":"d"}}}}"#
    ))
    .unwrap();
    let JsonValue::Object(object) = &mut value else {
        panic!()
    };
    object.insert("resources".into(), resources);
    value
}

fn static_entry() -> Entry {
    skills::entry(&"skills".into(),&raw("skill://a/SKILL.md","a",parse_json(&format!(r#"[{{"uri":"skill://a/SKILL.md","digest":"{}","size":8}},{{"uri":"skill://a/references/GUIDE.md","digest":"{}","size":8}}]"#,skills::digest(b"# Guide\n"),skills::digest(b"# Guide\n"))).unwrap())).unwrap()
}

#[test]
fn capabilities_require_resources_and_decode_directory_read() {
    assert_eq!(
        skills::capability(
            &parse_json(
                r#"{"extensions":{"io.modelcontextprotocol/skills":{"directoryRead":true}}}"#
            )
            .unwrap()
        ),
        None
    );
    assert_eq!(
        skills::capability(
            &parse_json(r#"{"resources":{},"extensions":{"io.modelcontextprotocol/skills":{}}}"#)
                .unwrap()
        )
        .unwrap()
        .directory_read,
        None
    );
    assert_eq!(skills::capability(&parse_json(r#"{"resources":{},"extensions":{"io.modelcontextprotocol/skills":{"directoryRead":true}}}"#).unwrap()).unwrap().directory_read,Some(true));
    assert!(skills::capability(&parse_json(r#"{"resources":{},"extensions":{"io.modelcontextprotocol/skills":{"directoryRead":"true"}}}"#).unwrap()).is_none());
}

#[test]
fn manifests_stamp_origin_and_reject_invalid_names_uris_and_resources() {
    let entry = static_entry();
    assert_eq!(entry.server, "skills".into());
    assert_eq!(
        skills::entry(&"host".into(), &entry.encode())
            .unwrap()
            .server,
        "host".into()
    );
    for uri in [
        "not a uri",
        "",
        "skill://a",
        "skill://a/other.md",
        "http://[/a/SKILL.md",
        "skill://a/SKILL.md?q",
        "skill://a/SKILL.md#x",
    ] {
        assert_eq!(
            skills::entry(
                &"skills".into(),
                &raw(uri, "a", JsonValue::String("dynamic".into()))
            ),
            Err(Reason::MalformedUri),
            "{uri}"
        );
    }
    assert_eq!(
        skills::entry(
            &"skills".into(),
            &raw(
                "skill://b/SKILL.md",
                "a",
                JsonValue::String("dynamic".into())
            )
        ),
        Err(Reason::NameMismatch)
    );
    for (uri, reason) in [
        ("skill://a/../b/SKILL.md", Reason::ResourceOutsideSkill),
        ("skill://a/%2e%2e/file", Reason::ResourceOutsideSkill),
        (
            "skill://a/references/%2fsecret",
            Reason::ResourceOutsideSkill,
        ),
        ("skill://a/other.md", Reason::MissingSkillMd),
    ] {
        let manifest = parse_json(&format!(
            r#"[{{"uri":"{uri}","digest":"sha256:{}","size":1}}]"#,
            "a".repeat(64)
        ))
        .unwrap();
        assert_eq!(
            skills::entry(&"skills".into(), &raw("skill://a/SKILL.md", "a", manifest)),
            Err(reason)
        );
    }
    let resource = parse_json(&format!(
        r#"{{"uri":"skill://a/SKILL.md","digest":"sha256:{}","size":1}}"#,
        "a".repeat(64)
    ))
    .unwrap();
    assert_eq!(
        skills::entry(
            &"skills".into(),
            &raw(
                "skill://a/SKILL.md",
                "a",
                JsonValue::Array(vec![resource.clone(), resource.clone()])
            )
        ),
        Err(Reason::DuplicateResource)
    );
    assert_eq!(
        skills::entry(
            &"skills".into(),
            &raw(
                "skill://a/SKILL.md",
                "a",
                JsonValue::Array(vec![resource; 513])
            )
        ),
        Err(Reason::LimitResources)
    );
    let resource = parse_json(&format!(
        r#"[{{"uri":"skill://a/SKILL.md","digest":"sha256:{}","size":16777217}}]"#,
        "a".repeat(64)
    ))
    .unwrap();
    assert_eq!(
        skills::entry(&"skills".into(), &raw("skill://a/SKILL.md", "a", resource)),
        Err(Reason::LimitBytes)
    );
}

#[test]
fn files_fail_closed_on_origin_dynamic_unlisted_size_and_digest() {
    let entry = static_entry();
    let uri = LosslessString::from("skill://a/references/GUIDE.md");
    let content = LosslessString::from("# Guide\n");
    assert!(skills::authorize_read(&"skills".into(), &entry, &uri).is_ok());
    assert_eq!(
        skills::authorize_read(&"other".into(), &entry, &uri),
        Err(Reason::OriginMismatch)
    );
    assert_eq!(
        skills::authorize_read(&"skills".into(), &entry, &"skill://a/missing".into()),
        Err(Reason::UnlistedResource)
    );
    let mut input = skills::FileInput {
        entry: &entry,
        uri: &uri,
        size: 8,
        digest: skills::digest(b"# Guide\n"),
        mime_type: None,
        text: Some(&content),
        blob: None,
    };
    assert!(skills::file(&input).is_ok());
    input.size = 9;
    assert_eq!(skills::file(&input), Err(Reason::SizeMismatch));
    input.size = 8;
    input.digest = skills::digest(b"# Other\n");
    assert_eq!(skills::file(&input), Err(Reason::DigestMismatch));
    input.digest = skills::digest(b"# Guide\n");
    input.blob = Some(&content);
    assert_eq!(skills::file(&input), Err(Reason::DecodeError));
    let dynamic = skills::entry(
        &"skills".into(),
        &raw(
            "skill://a/SKILL.md",
            "a",
            JsonValue::String("dynamic".into()),
        ),
    )
    .unwrap();
    assert_eq!(
        skills::authorize_read(&"skills".into(), &dynamic, &dynamic.uri),
        Err(Reason::Dynamic)
    );
}

#[test]
fn frontmatter_comparison_is_order_independent_but_preserves_every_field() {
    let entry = skills::entry(&"skills".into(),&parse_json(r#"{"uri":"skill://a/SKILL.md","frontmatter":{"name":"a","description":"d","metadata":{"version":"2.1","tags":["x"],"license":"MIT"}},"resources":"dynamic"}"#).unwrap()).unwrap();
    assert!(skills::frontmatter(&entry,&parse_json(r#"{"description":"d","name":"a","metadata":{"license":"MIT","tags":["x"],"version":"2.1"}}"#).unwrap()).is_ok());
    assert_eq!(
        skills::frontmatter(
            &entry,
            &parse_json(r#"{"name":"a","description":"d"}"#).unwrap()
        ),
        Err(Reason::FrontmatterMismatch)
    );
    assert_eq!(
        skills::frontmatter(&entry, &JsonValue::Null),
        Err(Reason::FrontmatterMissing)
    );
}

#[test]
fn identities_bind_content_and_server_and_ids_are_canonical() {
    let entry = static_entry();
    let first = skills::identity_by(&entry, |a, b| a.cmp(b));
    let mut revised = entry.clone();
    revised.server = "other".into();
    assert_ne!(first, skills::identity_by(&revised, |a, b| a.cmp(b)));
    let ycoding_schema::mcp_skill::Resources::Entries(resources) = &mut revised.resources else {
        panic!()
    };
    resources.reverse();
    assert_eq!(
        skills::identity_by(&revised, |a, b| a.cmp(b)),
        skills::identity_by(
            &{
                let mut e = entry.clone();
                e.server = "other".into();
                e
            },
            |a, b| a.cmp(b)
        )
    );
    let id = skills::id(&"skills".into(), &entry.uri);
    assert_eq!(
        skills::origin(&id),
        Some(("skills".into(), entry.uri.clone()))
    );
    assert_eq!(skills::origin(&(id + "=")), None);
    assert_eq!(skills::origin("mcp:AA"), None);
}

#[test]
fn relative_references_accept_native_schemes_without_root_escape() {
    let entry = skills::entry(
        &"skills".into(),
        &raw(
            "github://owner/repo/skills/refunds/SKILL.md",
            "refunds",
            JsonValue::String("dynamic".into()),
        ),
    )
    .unwrap();
    assert_eq!(
        skills::resolve(&entry, "references/GUIDE.md"),
        Some("github://owner/repo/skills/refunds/references/GUIDE.md".into())
    );
    for reference in [
        "../../../etc/passwd",
        "/etc/passwd",
        "https://example.com/x",
        "a?b",
        "a\\b",
        "..",
        "",
        "file:///etc/passwd",
        "references/%2e%2e/%2e%2e/secret",
        "//evil/path",
    ] {
        assert_eq!(skills::resolve(&entry, reference), None, "{reference}");
    }
}

#[test]
fn ids_namespace_by_origin_pair_without_colliding_with_local_names_or_delimiters() {
    let uri = LosslessString::from("skill://refunds/SKILL.md");
    let first = skills::id(&"alpha".into(), &uri);
    let second = skills::id(&"beta".into(), &uri);
    assert_ne!(first, second);
    assert_ne!(first, "refunds");
    assert_eq!(skills::origin(&first), Some(("alpha".into(), uri.clone())));
    assert_eq!(skills::origin(&second), Some(("beta".into(), uri)));
    assert_eq!(skills::origin("refunds"), None);

    let delimiter_in_uri = skills::id(&"a".into(), &"skill://b~c/SKILL.md".into());
    let delimiter_in_server = skills::id(&"a~skill://b".into(), &"c/SKILL.md".into());
    assert_ne!(delimiter_in_uri, delimiter_in_server);
    assert_eq!(
        skills::origin(&delimiter_in_uri),
        Some(("a".into(), "skill://b~c/SKILL.md".into()))
    );
    assert_eq!(
        skills::origin(&delimiter_in_server),
        Some(("a~skill://b".into(), "c/SKILL.md".into()))
    );
}

#[test]
fn permission_identity_is_an_opaque_digest_without_server_text() {
    let identity = skills::identity_by(&static_entry(), |a, b| a.cmp(b));
    let digest = identity.strip_prefix("mcp-skill:sha256:").expect("prefix");
    assert_eq!(digest.len(), 64);
    assert!(
        digest
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    );
    assert!(!identity.contains("skills") && !identity.contains("skill://"));
}
