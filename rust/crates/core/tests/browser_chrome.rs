#![cfg(unix)]
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
use ycoding_core::platform::browser::chrome;
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new(stdout: &str, exit: u8) -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-chrome-version-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("version"), stdout).unwrap();
        std::fs::write(root.join("chrome"),format!("#!/bin/sh\nbase=$(dirname \"$0\")\nprintf '%s\\n' \"$1\" >> \"$base/calls\"\ncat \"$base/version\"\nexit {exit}\n")).unwrap();
        std::fs::set_permissions(root.join("chrome"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        Self { root }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
#[tokio::test]
async fn installed_version_probe_requires_152_and_recognized_google_chrome_stdout() {
    for (stdout, available, reason) in [
        (
            "Google Chrome 151.0.0.1",
            false,
            "major 151 is unsupported; Chrome 152 or newer is required",
        ),
        ("Google Chrome 152.0.0.1", true, ""),
        ("notice\nGoogle Chrome 153.0.0.1\n", true, ""),
        (
            "Google Chrome unavailable\nGoogle Chrome 152.0.0.1",
            true,
            "",
        ),
        ("Chromium 153.0.0.1", false, "unavailable"),
        ("Google Chrome 152x.0", false, "unavailable"),
        ("Google Chrome 18446744073709551616.0", false, "unavailable"),
    ] {
        let fixture = Fixture::new(stdout, 0);
        let result = chrome::availability(&fixture.root.join("chrome"), "darwin", "arm64").await;
        assert_eq!(result.available, available, "{stdout}");
        if available {
            assert_eq!(result.reason, None);
        }
        if !available {
            assert!(result.reason.unwrap().contains(reason));
        }
        assert_eq!(
            std::fs::read_to_string(fixture.root.join("calls")).unwrap(),
            "--version\n"
        );
    }
}
#[tokio::test]
async fn unsupported_platform_or_architecture_never_executes_the_program() {
    let fixture = Fixture::new("Google Chrome 152.0", 0);
    for (platform, arch) in [("linux", "arm64"), ("darwin", "x64"), ("win32", "arm64")] {
        let result = chrome::availability(&fixture.root.join("chrome"), platform, arch).await;
        assert!(!result.available);
        assert_eq!(
            result.reason.as_deref(),
            Some("Isolated browser requires macOS arm64")
        );
    }
    assert!(!fixture.root.join("calls").exists());
}
#[tokio::test]
async fn missing_program_failed_exit_and_probe_timeout_report_unavailable() {
    let fixture = Fixture::new("Google Chrome 152.0", 1);
    for program in [fixture.root.join("missing"), fixture.root.join("chrome")] {
        let result = chrome::availability(&program, "darwin", "arm64").await;
        assert!(!result.available);
        assert_eq!(
            result.reason.as_deref(),
            Some("Installed Google Chrome is unavailable")
        );
    }
    std::fs::write(fixture.root.join("chrome"),"#!/bin/sh\necho $$ > \"$(dirname \"$0\")/pid\"\ntrap 'echo \"Google Chrome 152.0\"; exit 0' TERM\nsleep 30\n").unwrap();
    let started = std::time::Instant::now();
    assert!(
        !chrome::availability(&fixture.root.join("chrome"), "darwin", "arm64")
            .await
            .available
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(6));
    let pid = std::fs::read_to_string(fixture.root.join("pid")).unwrap();
    assert!(
        !std::process::Command::new("/bin/kill")
            .arg("-0")
            .arg(pid.trim())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}
