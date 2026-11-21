use crate::platform::{filesystem, git, worktree};
use std::{fs, path::Path};
use ycoding_schema::LosslessString;

pub(super) fn contains(location: &LosslessString, target: &LosslessString) -> bool {
    let (Ok(location), Ok(target)) = (location.to_utf8(), target.to_utf8()) else {
        return false;
    };
    let Ok(location) = filesystem::Location::new(Path::new(&location)) else {
        return false;
    };
    let Ok((target, _, _)) = location.resolve_mutation_path(&target, true) else {
        return false;
    };
    let git = git::Service::new(16 * 1024 * 1024);
    let Ok(Some(repository)) = git.discover(location.directory()) else {
        return false;
    };
    let Ok(common) = fs::canonicalize(&repository.common_directory) else {
        return false;
    };
    worktree::list(&git, &repository).is_ok_and(|entries| {
        entries.iter().any(|entry| {
            let Ok(checkout) = fs::canonicalize(&entry.directory) else {
                return false;
            };
            filesystem::contains(&checkout, &target.canonical)
                && git.discover(&checkout).is_ok_and(|found| {
                    found.is_some_and(|found| {
                        fs::canonicalize(found.common_directory).is_ok_and(|value| value == common)
                    })
                })
        })
    })
}
