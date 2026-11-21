pub const DESKTOP_VERSION: &str = "26.1023.50603";
pub const ORIGINATOR: &str = "Codex Desktop";

fn platform_name(os: &str) -> &str {
    match os {
        "macos" => "Mac OS",
        "linux" => "X11; Linux",
        "windows" => "Windows NT 10.0",
        other => other,
    }
}

fn architecture_name(arch: &str) -> &str {
    match arch {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        other => other,
    }
}

pub fn desktop_user_agent(os: &str, arch: &str) -> String {
    format!(
        "{ORIGINATOR}/{DESKTOP_VERSION} ({}; {})",
        platform_name(os),
        architecture_name(arch)
    )
}

pub fn user_agent() -> String {
    desktop_user_agent(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn headers() -> [(&'static str, String); 2] {
    [
        ("originator", ORIGINATOR.into()),
        ("user-agent", user_agent()),
    ]
}
