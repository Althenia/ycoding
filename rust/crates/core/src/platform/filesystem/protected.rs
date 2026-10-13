use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

const DARWIN_HOME: &[&str] = &[
    "Music",
    "Pictures",
    "Movies",
    "Downloads",
    "Desktop",
    "Documents",
    "Public",
    "Applications",
    "Library",
];
const DARWIN_LIBRARY: &[&str] = &[
    "Application Support/AddressBook",
    "Calendars",
    "Mail",
    "Messages",
    "Safari",
    "Cookies",
    "Application Support/com.apple.TCC",
    "PersonalizationPortrait",
    "Metadata/CoreSpotlight",
    "Suggestions",
];
const DARWIN_ROOT: &[&str] = &[
    "/.DocumentRevisions-V100",
    "/.Spotlight-V100",
    "/.Trashes",
    "/.fseventsd",
];
const WIN32_HOME: &[&str] = &[
    "AppData",
    "Downloads",
    "Desktop",
    "Documents",
    "Pictures",
    "Music",
    "Videos",
    "OneDrive",
];

pub fn names(platform: &str) -> BTreeSet<&'static str> {
    match platform {
        "darwin" => DARWIN_HOME.iter().copied().collect(),
        "win32" => WIN32_HOME.iter().copied().collect(),
        _ => BTreeSet::new(),
    }
}

pub fn paths(platform: &str, home: &Path) -> Vec<PathBuf> {
    match platform {
        "darwin" => DARWIN_HOME
            .iter()
            .map(|name| home.join(name))
            .chain(
                DARWIN_LIBRARY
                    .iter()
                    .map(|name| home.join("Library").join(name)),
            )
            .chain(DARWIN_ROOT.iter().map(PathBuf::from))
            .collect(),
        "win32" => WIN32_HOME.iter().map(|name| home.join(name)).collect(),
        _ => Vec::new(),
    }
}
