use std::path::{Path, PathBuf};

pub const DIRECTORY: &str = "ycoding-chrome-extension";
pub const FILES: [&str; 10] = [
    "icons/ycoding-128.png",
    "icons/ycoding-16.png",
    "icons/ycoding-32.png",
    "icons/ycoding-48.png",
    "manifest.json",
    "popup.css",
    "popup.html",
    "popup.js",
    "protocol.js",
    "service-worker.js",
];

pub fn location(executable: &Path, checkout: &Path) -> PathBuf {
    if executable.file_stem().is_some_and(|name| name == "bun") {
        return checkout.join("extensions").join("chrome");
    }
    executable
        .parent()
        .unwrap_or(Path::new("."))
        .join(DIRECTORY)
}
