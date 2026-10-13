use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::instruction_discovery::{self, Observation, Options};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-instruction-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn write(&self, path: &str, text: &str) -> PathBuf {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }
    fn options(&self) -> Options {
        Options {
            directory: self.0.join("project/nested"),
            project_root: self.0.join("project"),
            global_config: self.0.join("global"),
            project: true,
            max_bytes: None,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn ambient_instructions_are_global_then_nearest_then_ancestors_with_empty_and_updates() {
    let f = Fixture::new();
    f.write("AGENTS.md", "outside");
    let global = f.write("global/AGENTS.md", "global");
    let project = f.write("project/AGENTS.md", "project");
    let nested = f.write("project/nested/AGENTS.md", "");
    let options = f.options();
    let previous = instruction_discovery::observe(&options);
    assert_eq!(
        previous.render(None, &options).unwrap(),
        format!(
            "Instructions from: {}\nglobal\n\nInstructions from: {}\n\n\nInstructions from: {}\nproject",
            global.display(),
            nested.display(),
            project.display()
        )
    );
    let Observation::Available(files) = &previous else {
        panic!("available")
    };
    assert_eq!(files.len(), 3);
    f.write("project/nested/AGENTS.md", "changed");
    let current = instruction_discovery::observe(&options);
    assert!(
        current.render(Some(files), &options).unwrap().starts_with(
            "These instructions replace all previously loaded ambient instructions.\n\n"
        )
    );
    assert!(
        current
            .render(Some(files), &options)
            .unwrap()
            .contains("changed")
    );
    fs::remove_file(nested).unwrap();
    fs::remove_file(global).unwrap();
    fs::remove_file(project).unwrap();
    assert_eq!(
        instruction_discovery::observe(&options),
        Observation::Removed
    );
    assert_eq!(
        Observation::Removed.render(Some(files), &options).unwrap(),
        "Previously loaded instructions no longer apply."
    );
}

#[test]
fn unavailable_sources_retain_previous_and_block_initial_read_and_read_races() {
    let f = Fixture::new();
    let file = f.write("project/nested/AGENTS.md", "admitted");
    let options = f.options();
    let Observation::Available(previous) = instruction_discovery::observe(&options) else {
        panic!()
    };
    let paths = instruction_discovery::discover(&options).unwrap();
    fs::remove_file(&file).unwrap();
    let unavailable = instruction_discovery::read(&paths);
    assert!(matches!(unavailable, Observation::Unavailable(_)));
    assert_eq!(
        unavailable.value(Some(&previous)),
        Some(previous.as_slice())
    );
    assert_eq!(unavailable.value(None), None);
    assert_eq!(unavailable.render(Some(&previous), &options), None);
    fs::create_dir(&file).unwrap();
    assert!(matches!(
        instruction_discovery::observe(&options),
        Observation::Unavailable(_)
    ));
    fs::remove_dir(&file).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.write("project/nested/AGENTS.md", "new");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();
        assert!(matches!(
            instruction_discovery::observe(&options),
            Observation::Unavailable(_)
        ));
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
fn instruction_limits_use_utf8_bytes_sha256_and_no_partial_text() {
    let rendered = instruction_discovery::render_content("/source", "é😀", Some(5), "read");
    assert_eq!(rendered.bytes, 6);
    assert!(rendered.omitted);
    assert_eq!(
        rendered.digest,
        "1184d1f608158eea09d297565575892231550c403aaa913008d867a97cfd5c76"
    );
    assert_eq!(
        rendered.content,
        format!(
            "[Instruction content omitted because 6 UTF-8 bytes exceeds the 5-byte inline limit.]\nSource: /source\nSHA-256: {}\nUse the read tool to load only the relevant sections on demand.",
            rendered.digest
        )
    );
    assert_eq!(
        instruction_discovery::render_content("/source", "é😀", Some(6), "webfetch").content,
        "é😀"
    );
    assert!(!instruction_discovery::render_content("/source", "", None, "read").omitted);
}

#[test]
fn instruction_boundaries_canonicalize_symlinks_dedupe_global_and_honor_optout() {
    let f = Fixture::new();
    f.write("project/nested/AGENTS.md", "nested");
    let global = f.write("global/AGENTS.md", "global");
    let mut options = f.options();
    options.project = false;
    assert_eq!(
        instruction_discovery::observe(&options)
            .value(None)
            .unwrap()
            .len(),
        1
    );
    options.project = true;
    options.project_root = f.0.join("other");
    assert_eq!(
        instruction_discovery::observe(&options)
            .value(None)
            .unwrap()
            .len(),
        1
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(f.0.join("project"), f.0.join("linked")).unwrap();
        options.directory = f.0.join("linked/nested");
        options.project_root = f.0.join("project");
        assert_eq!(
            instruction_discovery::observe(&options)
                .value(None)
                .unwrap()
                .len(),
            2
        );
        fs::remove_file(f.0.join("project/nested/AGENTS.md")).unwrap();
        std::os::unix::fs::symlink(&global, f.0.join("project/nested/AGENTS.md")).unwrap();
        assert_eq!(
            instruction_discovery::observe(&options)
                .value(None)
                .unwrap()
                .len(),
            1
        );
    }
}
