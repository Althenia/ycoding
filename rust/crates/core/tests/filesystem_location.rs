pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::{fs, path::Path};
use ycoding_core::platform::filesystem::{Location, contains, overlaps, protected};
use ycoding_schema::filesystem::EntryType;

#[test]
fn reads_bytes_and_lists_only_direct_regular_children_directories_first() {
    let fixture = Fixture::new();
    fixture.write("text.txt", "hello");
    fixture.write("data.bin", [0, 1, 2]);
    fixture.write("src/main.rs", "nested");
    let location = Location::new(&fixture.0).unwrap();
    assert_eq!(location.read_bytes("text.txt").unwrap(), b"hello");
    assert_eq!(location.read_bytes("data.bin").unwrap(), [0, 1, 2]);
    let text = location.read("text.txt").unwrap();
    assert_eq!(text.content, b"hello");
    assert_eq!(text.mime, "text/plain");
    let entries = location.list(None).unwrap();
    assert_eq!(
        entries
            .iter()
            .map(|e| (e.path.as_lossless().to_utf8().unwrap(), e.r#type))
            .collect::<Vec<_>>(),
        vec![
            ("src/".into(), EntryType::Directory),
            ("data.bin".into(), EntryType::File),
            ("text.txt".into(), EntryType::File)
        ]
    );
    assert!(location.read_bytes("src").is_err());
    assert!(location.list(Some("text.txt")).is_err());
    assert_eq!(
        location.list(Some("src")).unwrap()[0]
            .path
            .as_lossless()
            .to_utf8()
            .unwrap(),
        "src/main.rs"
    );
}

#[test]
fn lexical_escapes_are_rejected_before_reading() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    let secret = outside.write("secret.txt", "outside");
    let location = Location::new(&fixture.0).unwrap();
    assert!(location.read_bytes(secret.to_str().unwrap()).is_err());
    assert!(location.read_bytes("../outside.txt").is_err());
    assert!(!contains(Path::new("/a/b"), Path::new("/a/bad")));
    assert!(contains(Path::new("/a/b"), Path::new("/a/b/c")));
    assert!(overlaps(Path::new("/a/b/c"), Path::new("/a/b")));
    assert!(!overlaps(Path::new("/a"), Path::new("/b")));
}

#[cfg(unix)]
#[test]
fn symlink_escapes_are_rejected_and_symlink_entries_are_not_listed() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    outside.write("secret", "outside");
    std::os::unix::fs::symlink(&outside.0, fixture.0.join("escape")).unwrap();
    fixture.write("inside", "safe");
    std::os::unix::fs::symlink(fixture.0.join("inside"), fixture.0.join("alias")).unwrap();
    let location = Location::new(&fixture.0).unwrap();
    assert!(location.read_bytes("escape/secret").is_err());
    assert!(location.list(Some("escape")).is_err());
    assert_eq!(location.read_bytes("alias").unwrap(), b"safe");
    assert_eq!(location.list(None).unwrap().len(), 1);
    assert!(fs::metadata(fixture.0.join("escape")).unwrap().is_dir());
}

#[test]
fn protected_paths_are_platform_specific_and_preserve_all_ts_entries() {
    let home = Path::new("/home/test");
    assert_eq!(protected::names("darwin").len(), 9);
    assert_eq!(protected::names("win32").len(), 8);
    assert!(protected::names("linux").is_empty());
    let mac = protected::paths("darwin", home);
    assert_eq!(mac.len(), 23);
    assert!(mac.contains(&home.join("Library/Application Support/com.apple.TCC")));
    assert!(mac.contains(&Path::new("/.fseventsd").to_path_buf()));
    assert_eq!(protected::paths("win32", home).len(), 8);
    assert!(protected::paths("linux", home).is_empty());
}

#[test]
fn prospective_mutation_targets_use_the_canonical_existing_ancestor_and_resource() {
    let fixture = Fixture::new();
    let location = Location::new(&fixture.0).unwrap();
    let target = location.resolve_mutation("src/nested/new.txt").unwrap();
    assert_eq!(target.canonical, fixture.0.join("src/nested/new.txt"));
    assert_eq!(target.resource, "src/nested/new.txt");
    fixture.write("not-directory", "file");
    assert!(location.resolve_mutation("not-directory/new.txt").is_err());
    assert!(location.resolve_mutation("../new.txt").is_err());
}

#[cfg(unix)]
#[test]
fn prospective_targets_cannot_traverse_a_symlink_outside_the_location() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    std::os::unix::fs::symlink(&outside.0, fixture.0.join("escape")).unwrap();
    fs::create_dir(fixture.0.join("inside")).unwrap();
    std::os::unix::fs::symlink(fixture.0.join("inside"), fixture.0.join("alias")).unwrap();
    let location = Location::new(&fixture.0).unwrap();
    assert!(location.resolve_mutation("escape/new.txt").is_err());
    let target = location.resolve_mutation("alias/new.txt").unwrap();
    assert_eq!(target.canonical, fixture.0.join("inside/new.txt"));
    assert_eq!(target.resource, "inside/new.txt");
}

#[cfg(unix)]
#[test]
fn dangling_external_symlinks_cannot_resolve_as_internal_mutation_targets() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    std::os::unix::fs::symlink(outside.0.join("missing"), fixture.0.join("escape")).unwrap();
    let location = Location::new(&fixture.0).unwrap();
    assert!(location.resolve_mutation("escape").is_err());
    assert!(!outside.0.join("missing").exists());
}
