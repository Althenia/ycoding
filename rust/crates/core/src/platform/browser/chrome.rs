use super::isolated::Availability;
use crate::platform::{computer::Future, process};
use std::{path::Path, time::Duration};

pub(super) const PLACEMENT_REASON: &str = "Isolated browser requires macOS arm64";

pub(super) fn supported_placement(platform: &str, architecture: &str) -> bool {
    platform == "darwin" && architecture == "arm64"
}

pub async fn availability(executable: &Path, platform: &str, architecture: &str) -> Availability {
    if !supported_placement(platform, architecture) {
        return Availability {
            available: false,
            reason: Some(PLACEMENT_REASON.into()),
        };
    }
    let major = version(executable, Duration::from_secs(3), None).await;
    Availability {
        available: major.is_some_and(|major| major >= 152),
        reason: match major {
            Some(major) if major >= 152 => None,
            Some(major) => Some(format!(
                "Installed Google Chrome major {major} is unsupported; Chrome 152 or newer is required"
            )),
            None => Some("Installed Google Chrome is unavailable".into()),
        },
    }
}

pub(super) const INSTALLED_CHROME: &str =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

pub(super) fn current_placement() -> (&'static str, &'static str) {
    (
        if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        },
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            std::env::consts::ARCH
        },
    )
}

pub fn installed_availability() -> Future<'static, Availability> {
    Box::pin(async {
        let (platform, architecture) = current_placement();
        availability(Path::new(INSTALLED_CHROME), platform, architecture).await
    })
}

pub(super) async fn version(
    executable: &Path,
    timeout: Duration,
    signal: Option<tokio::sync::watch::Receiver<bool>>,
) -> Option<u64> {
    let program = executable.to_str()?;
    let mut command = process::Command::new(program, ["--version"]);
    command.kill.force_kill_after = Some(Duration::from_millis(500));
    let result = process::run(
        command,
        process::RunOptions {
            timeout: Some(timeout),
            signal,
            max_output_bytes: Some(1024 * 1024),
            max_error_bytes: Some(1024 * 1024),
            ..Default::default()
        },
    )
    .await
    .ok()?;
    if result.exit.reason != process::Termination::Exit
        || result.exit.code != Some(0)
        || result.stdout_truncated
    {
        return None;
    }
    let stdout = String::from_utf8_lossy(&result.stdout);
    stdout.split("Google Chrome ").skip(1).find_map(|version| {
        let (major, _) = version.split_once('.')?;
        if major.is_empty() || !major.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        major.parse().ok()
    })
}
