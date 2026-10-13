pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use ycoding_core::platform::filesystem::util::{ScanOptions, glob_up, scan};

#[test]
fn scans_relative_and_absolute_patterns_with_dot_and_directory_options() {
    let fixture = Fixture::new();
    fixture.write("a.ts", "a");
    fixture.write("b.ts", "b");
    fixture.write("c.json", "c");
    fixture.write(".hidden.ts", "hidden");
    fixture.write("sub/leaf.md", "leaf");
    fixture.write("root.md", "root");
    let options = ScanOptions {
        cwd: fixture.0.clone(),
        ..ScanOptions::default()
    };
    assert_eq!(scan("*.ts", &options).unwrap(), ["a.ts", "b.ts"]);
    let absolute = ScanOptions {
        absolute: true,
        ..options.clone()
    };
    assert_eq!(
        scan("*.json", &absolute).unwrap(),
        [fixture.0.join("c.json").to_str().unwrap()]
    );
    let dotted = ScanOptions {
        dot: true,
        ..options.clone()
    };
    assert_eq!(
        scan("*.ts", &dotted).unwrap(),
        [".hidden.ts", "a.ts", "b.ts"]
    );
    assert_eq!(scan(".hidden.ts", &options).unwrap(), [".hidden.ts"]);
    assert_eq!(
        scan(&format!("{}/*.json", fixture.0.display()), &options).unwrap(),
        [fixture.0.join("c.json").to_str().unwrap()]
    );
    assert_eq!(
        glob_up("*.md", &fixture.0.join("sub"), Some(&fixture.0)).unwrap(),
        [fixture.0.join("sub/leaf.md"), fixture.0.join("root.md")]
    );
}

#[cfg(unix)]
#[test]
fn recursive_scans_follow_only_explicitly_enabled_symlinks_and_terminate_cycles() {
    let fixture = Fixture::new();
    fixture.write("real/file.ts", "real");
    std::os::unix::fs::symlink(fixture.0.join("real"), fixture.0.join("alias")).unwrap();
    std::os::unix::fs::symlink(&fixture.0, fixture.0.join("real/cycle")).unwrap();
    let options = ScanOptions {
        cwd: fixture.0.clone(),
        ..ScanOptions::default()
    };
    assert_eq!(scan("**/*.ts", &options).unwrap(), ["real/file.ts"]);
    let followed = ScanOptions {
        symlink: true,
        ..options
    };
    assert_eq!(
        scan("**/*.ts", &followed).unwrap(),
        ["alias/file.ts", "real/file.ts"]
    );
}
