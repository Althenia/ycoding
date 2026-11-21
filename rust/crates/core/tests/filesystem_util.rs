pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::fs;
use ycoding_core::platform::filesystem::{ignore, util};

#[test]
fn stat_safe_reads_directory_creation_and_json_use_real_files() {
    let fixture = Fixture::new();
    assert!(util::is_dir(&fixture.0));
    assert!(!util::is_file(&fixture.0));
    assert!(!util::exists_safe(&fixture.0.join("missing")));
    assert_eq!(
        util::read_file_string_safe(&fixture.0.join("missing")).unwrap(),
        None
    );
    let file = fixture.write("text", [0xef, 0xbb, 0xbf, b'a', 0xff]);
    assert!(util::is_file(&file));
    assert!(!util::is_dir(&file));
    assert_eq!(
        util::read_file_string_safe(&file).unwrap().as_deref(),
        Some("a\u{fffd}")
    );
    let deep = fixture.0.join("deep/nested/file.bin");
    util::write_with_dirs(&deep, &[0, 1, 2], None).unwrap();
    assert_eq!(fs::read(&deep).unwrap(), [0, 1, 2]);
    util::ensure_dir(deep.parent().unwrap()).unwrap();
    let json = fixture.0.join("data.json");
    let value =
        ycoding_schema::parse_json("{\"name\":\"test\",\"count\":42,\"nested\":{\"ok\":true}}")
            .unwrap();
    util::write_json(&json, &value, None).unwrap();
    assert_eq!(util::read_json(&json).unwrap(), value);
    fixture.write("broken.json", "{");
    assert!(util::read_json(&fixture.0.join("broken.json")).is_err());
}

#[test]
fn upward_discovery_preserves_nearest_first_target_order_and_inclusive_stop() {
    let fixture = Fixture::new();
    fixture.write("a.txt", "root");
    fixture.write("b.txt", "root");
    fixture.write("sub/a.txt", "child");
    let start = fixture.0.join("sub");
    assert_eq!(
        util::up(&["a.txt", "b.txt"], &start, Some(&fixture.0)).unwrap(),
        [
            start.join("a.txt"),
            fixture.0.join("a.txt"),
            fixture.0.join("b.txt")
        ]
    );
    assert_eq!(
        util::find_up("a.txt", &start, Some(&fixture.0)).unwrap(),
        [start.join("a.txt"), fixture.0.join("a.txt")]
    );
    assert!(
        util::find_up("missing", &start, Some(&fixture.0))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        util::resolve(&fixture.0.join("missing")).unwrap(),
        fixture.0.join("missing")
    );
}

#[test]
fn ignore_whitelist_precedes_folders_and_extra_patterns() {
    for path in [
        "node_modules",
        "node_modules/",
        "node_modules/bar",
        "nested/node_modules/package/index.js",
        "nested/.git/HEAD",
        "nested/dist/index.js",
        "nested/logs/app.log",
    ] {
        assert!(ignore::matches(path, &[], &[]).unwrap());
    }
    assert!(!ignore::matches("nested/src/index.ts", &[], &[]).unwrap());
    assert!(!ignore::matches("nested/node_modules/keep.ts", &[], &["**/keep.ts".into()]).unwrap());
    assert!(ignore::matches("src/generated.ts", &["**/generated.ts".into()], &[]).unwrap());
    assert!(
        !ignore::matches(
            "src/generated.ts",
            &["**/generated.ts".into()],
            &["src/*.ts".into()]
        )
        .unwrap()
    );
}

#[test]
fn windows_drive_spellings_follow_the_typescript_prefix_contract() {
    for (input, expected) in [
        ("/c/path", "C:/path"),
        ("/c", "C:/"),
        ("/c:/path", "C:/path"),
        ("/c:\\path", "C:/path"),
        ("/c:", "C:/"),
        ("/cygdrive/d/path", "D:/path"),
        ("/mnt/e/path", "E:/path"),
        ("/mnt/e", "E:/"),
        ("/mnt/ee/path", "/mnt/ee/path"),
        ("/c\\path", "/c\\path"),
        ("/cygdrive/c:/path", "/cygdrive/c:/path"),
        ("/mnt/1/path", "/mnt/1/path"),
        ("/home/path", "/home/path"),
        ("C:/path", "C:/path"),
    ] {
        assert_eq!(util::windows_path(input, "win32"), expected, "{input}");
        assert_eq!(util::windows_path(input, "darwin"), input);
    }
    if !cfg!(windows) {
        assert_eq!(
            util::normalize_path(std::path::Path::new("./relative")).unwrap(),
            std::path::Path::new("./relative")
        );
        assert_eq!(
            util::normalize_path_pattern("./relative/*").unwrap(),
            "./relative/*"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_native_normalization_keeps_drive_roots_and_directory_glob_suffixes() {
    assert_eq!(util::normalize_path_pattern("*").unwrap(), "*");
    assert_eq!(util::normalize_path_pattern("C:/*").unwrap(), "C:\\*");
    let fixture = Fixture::new();
    let pattern = format!("{}\\*", fixture.0.display());
    let normalized = util::normalize_path_pattern(&pattern).unwrap();
    assert_eq!(std::path::Path::new(&normalized).file_name().unwrap(), "*");
    assert!(!normalized.starts_with("\\\\?\\"));
    assert_eq!(
        fs::canonicalize(std::path::Path::new(&normalized).parent().unwrap()).unwrap(),
        fixture.0
    );
}
