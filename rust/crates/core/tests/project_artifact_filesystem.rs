use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::project_artifact::filesystem::{self, Hooks, MutationRequest};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-artifact-fs-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn executes_real_mkdir_exclusive_write_rename_remove_and_rejects_overwrite() {
    let tmp = Temp::new();
    let directory = tmp.0.join("owned");
    filesystem::execute_mutation(
        MutationRequest::Mkdir {
            root: &tmp.0,
            path: &directory,
        },
        &Hooks::default(),
    )
    .unwrap();
    let source = directory.join("source");
    let destination = directory.join("destination");
    filesystem::execute_mutation(
        MutationRequest::Write {
            root: &tmp.0,
            path: &source,
            content: "owned",
            exclusive: true,
        },
        &Hooks::default(),
    )
    .unwrap();
    assert!(
        filesystem::execute_mutation(
            MutationRequest::Write {
                root: &tmp.0,
                path: &source,
                content: "unowned",
                exclusive: true
            },
            &Hooks::default()
        )
        .is_err()
    );
    filesystem::execute_mutation(
        MutationRequest::Rename {
            source_root: &tmp.0,
            destination_root: &tmp.0,
            source: &source,
            destination: &destination,
            replace: false,
        },
        &Hooks::default(),
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(&destination).unwrap(), "owned");
    std::fs::write(&source, "other").unwrap();
    assert!(
        filesystem::execute_mutation(
            MutationRequest::Rename {
                source_root: &tmp.0,
                destination_root: &tmp.0,
                source: &source,
                destination: &destination,
                replace: false
            },
            &Hooks::default()
        )
        .is_err()
    );
    filesystem::execute_mutation(
        MutationRequest::Remove {
            root: &tmp.0,
            path: &directory,
            recursive: true,
        },
        &Hooks::default(),
    )
    .unwrap();
    assert!(!directory.exists());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_roots_ancestors_leaves_and_lexical_escape_without_external_writes() {
    use std::os::unix::fs::symlink;
    let tmp = Temp::new();
    let root = tmp.0.join("scope");
    let outside = tmp.0.join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let linked = tmp.0.join("linked");
    symlink(&root, &linked).unwrap();
    symlink(&outside, root.join("ancestor")).unwrap();
    symlink(outside.join("leaf"), root.join("leaf")).unwrap();
    for (base, target) in [
        (&linked, linked.join("file")),
        (&root, root.join("ancestor/file")),
        (&root, root.join("leaf")),
        (&root, root.join("../outside/file")),
        (&root, root.join("..benign")),
    ] {
        assert!(matches!(
            filesystem::execute_mutation(
                MutationRequest::Write {
                    root: base,
                    path: &target,
                    content: "unsafe",
                    exclusive: false
                },
                &Hooks::default()
            ),
            Err(filesystem::Error::Unsafe(_))
        ));
    }
    assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
}

#[test]
fn fails_closed_when_component_identity_changes_before_mutation() {
    let tmp = Temp::new();
    let parent = tmp.0.join("owned");
    std::fs::create_dir(&parent).unwrap();
    let before = |_: &filesystem::Mutation<'_>| {
        std::fs::rename(&parent, tmp.0.join("prior"))?;
        std::fs::create_dir(&parent)
    };
    let result = filesystem::execute_mutation(
        MutationRequest::Write {
            root: &tmp.0,
            path: &parent.join("file"),
            content: "unsafe",
            exclusive: false,
        },
        &Hooks {
            before_mutation: Some(&before),
            ..Hooks::default()
        },
    );
    assert!(matches!(
        result,
        Err(filesystem::Error::Unsafe(
            "filesystem identity changed before mutation"
        ))
    ));
    assert!(!parent.join("file").exists());
}

#[test]
fn rejects_destination_that_appears_in_before_mutation_hook() {
    let tmp = Temp::new();
    let source = tmp.0.join("source");
    let destination = tmp.0.join("destination");
    std::fs::write(&source, "source").unwrap();
    let before = |_: &filesystem::Mutation<'_>| std::fs::write(&destination, "external");
    assert!(
        filesystem::execute_mutation(
            MutationRequest::Rename {
                source_root: &tmp.0,
                destination_root: &tmp.0,
                source: &source,
                destination: &destination,
                replace: false
            },
            &Hooks {
                before_mutation: Some(&before),
                ..Hooks::default()
            }
        )
        .is_err()
    );
    assert_eq!(std::fs::read_to_string(destination).unwrap(), "external");
    assert_eq!(std::fs::read_to_string(source).unwrap(), "source");
}

#[test]
fn supports_explicit_cross_root_rename_and_observes_real_mutation_metadata() {
    let tmp = Temp::new();
    let second = Temp::new();
    let source = tmp.0.join("source");
    let destination = second.0.join("destination");
    std::fs::write(&source, "bytes").unwrap();
    let after = |mutation: &filesystem::Mutation<'_>| {
        assert_eq!(mutation.operation, "rename");
        assert_eq!(mutation.source, Some(source.as_path()));
        assert_eq!(mutation.destination, Some(destination.as_path()));
        assert_eq!(std::fs::read_to_string(&destination)?, "bytes");
        Ok(())
    };
    filesystem::execute_mutation(
        MutationRequest::Rename {
            source_root: &tmp.0,
            destination_root: &second.0,
            source: &source,
            destination: &destination,
            replace: false,
        },
        &Hooks {
            after_mutation: Some(&after),
            ..Hooks::default()
        },
    )
    .unwrap();
    assert!(!source.exists());
    assert!(filesystem::assert_safe_path(&tmp.0, Path::new("/outside")).is_err());
}

#[test]
fn nonrecursive_remove_rejects_even_an_empty_directory_and_keeps_it() {
    let tmp = Temp::new();
    let directory = tmp.0.join("empty");
    std::fs::create_dir(&directory).unwrap();
    assert!(
        filesystem::execute_mutation(
            MutationRequest::Remove {
                root: &tmp.0,
                path: &directory,
                recursive: false
            },
            &Hooks::default()
        )
        .is_err()
    );
    assert!(directory.exists());
}
