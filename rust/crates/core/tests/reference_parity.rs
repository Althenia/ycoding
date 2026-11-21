use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::{
    config::{Configuration, LoadOptions, Roots},
    reference,
};
static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn references_resolve_document_relative_paths_and_reject_branch_conflicts() {
    let root = std::env::temp_dir().join(format!(
        "ycoding-reference-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(root.join("config/ycoding")).unwrap();
    fs::create_dir_all(root.join("project/nested")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    fs::write(root.join("config/ycoding/ycoding.json"), r#"{"references":{"local":"./one","git":{"repository":"owner/repo","branch":"main"},"bad alias":"./x","second":{"repository":"https://github.com/owner/repo.git","branch":"other"},"invalid":{"repository":"not-a-repo"},"file":{"repository":"file:///tmp/repo"},"bad-branch":{"repository":"other/repo","branch":"-bad"}}}"#).unwrap();
    let roots = Roots::development(&root).unwrap();
    let directory = root.join("project/nested");
    let config = Configuration::load(LoadOptions {
        directory: directory.clone(),
        roots: roots.clone(),
        project: true,
        file: None,
        content: None,
        env: BTreeMap::new(),
    })
    .unwrap();
    let mut diagnostics = Vec::new();
    let refs =
        reference::Service::from_entries(&config.entries, &directory, &roots, &mut diagnostics)
            .unwrap();
    assert_eq!(refs.list().len(), 2);
    assert_eq!(
        refs.list()[0].path.as_lossless(),
        &root.join("config/ycoding/one").to_str().unwrap().into()
    );
    assert_eq!(
        refs.list()[1].path.as_lossless(),
        &roots
            .repos
            .join("github.com/owner/repo")
            .to_str()
            .unwrap()
            .into()
    );
    assert!(diagnostics.iter().any(|d| d.reason == "branch-conflict"));
    assert!(diagnostics.iter().any(|d| d.reason == "invalid-alias"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn references_replace_sources_in_place_and_preserve_false_and_empty_metadata() {
    use ycoding_core::resources::config::Entry;
    use ycoding_schema::parse_json;
    let roots = Roots::development(&PathBuf::from("/fixture")).unwrap();
    let entries = vec![Entry::Document { path: Some("/repo/ycoding.json".into()), info: parse_json(r#"{"references":{"first":{"path":"../shared","description":"old","hidden":true},"other":"~/lib"}}"#).unwrap() }, Entry::Document { path: None, info: parse_json(r#"{"references":{"first":{"path":"./new","description":"","hidden":false}}}"#).unwrap() }];
    let refs = reference::Service::from_entries(
        &entries,
        &PathBuf::from("/repo/nested"),
        &roots,
        &mut Vec::new(),
    )
    .unwrap();
    assert_eq!(refs.list()[0].name, "first".into());
    assert_eq!(refs.list()[0].description, Some("".into()));
    assert_eq!(refs.list()[0].hidden, Some(false));
    assert_eq!(
        refs.list()[0].path.as_lossless(),
        &"/repo/nested/new".into()
    );
    assert_eq!(refs.list()[1].path.as_lossless(), &"/fixture/lib".into());
}
