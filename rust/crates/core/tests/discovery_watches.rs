use std::path::Path;
use ycoding_core::resources::{config::Entry, discovery::WatchInputs};
#[test]
fn watch_inputs_dedupe_ycoding_directories_and_external_files_without_watching_ecosystem_roots() {
    let entries = vec![
        Entry::Directory("/global".into()),
        Entry::Directory("/repo/.ycoding".into()),
        Entry::Directory("/global".into()),
        Entry::File("/global/ycoding.json".into()),
        Entry::File("/repo/ycoding.json".into()),
        Entry::File("/repo/ycoding.json".into()),
        Entry::ClaudeDirectory("/home/test/.claude".into()),
        Entry::AgentsDirectory("/repo/.agents".into()),
    ];
    let mut watched = WatchInputs::new(&entries);
    assert_eq!(watched.targets().len(), 3);
    assert!(watched.changed(Path::new("/repo/.ycoding/agents/new.md")));
    assert!(watched.changed(Path::new("/repo/ycoding.json")));
    assert!(!watched.changed(Path::new("/home/test/.claude/skills/x.md")));
    assert!(!watched.changed(Path::new("/repo/.ycoding-other/x.md")));
    assert_eq!(watched.revision(), 2);
}
