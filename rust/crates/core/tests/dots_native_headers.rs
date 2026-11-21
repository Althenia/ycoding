use ycoding_core::dots::enrollment::cca_headers::{
    DESKTOP_VERSION, ORIGINATOR, desktop_user_agent, headers, user_agent,
};

#[test]
fn the_desktop_constants_match_the_pinned_registration_contract() {
    assert_eq!(DESKTOP_VERSION, "26.1023.50603");
    assert_eq!(ORIGINATOR, "Codex Desktop");
}

#[test]
fn user_agents_match_the_pinned_platform_and_architecture_table() {
    for (os, arch, expected) in [
        (
            "macos",
            "aarch64",
            "Codex Desktop/26.1023.50603 (Mac OS; arm64)",
        ),
        (
            "linux",
            "x86_64",
            "Codex Desktop/26.1023.50603 (X11; Linux; x64)",
        ),
        (
            "windows",
            "x86_64",
            "Codex Desktop/26.1023.50603 (Windows NT 10.0; x64)",
        ),
        (
            "windows",
            "aarch64",
            "Codex Desktop/26.1023.50603 (Windows NT 10.0; arm64)",
        ),
        (
            "windows",
            "x86",
            "Codex Desktop/26.1023.50603 (Windows NT 10.0; ia32)",
        ),
        (
            "freebsd",
            "aarch64",
            "Codex Desktop/26.1023.50603 (freebsd; arm64)",
        ),
    ] {
        assert_eq!(desktop_user_agent(os, arch), expected, "{os} {arch}");
    }
}

#[test]
fn architectures_without_a_pinned_rename_keep_their_runtime_name() {
    assert_eq!(
        desktop_user_agent("linux", "riscv64"),
        "Codex Desktop/26.1023.50603 (X11; Linux; riscv64)"
    );
    assert_eq!(
        desktop_user_agent("linux", "s390x"),
        "Codex Desktop/26.1023.50603 (X11; Linux; s390x)"
    );
}

#[test]
fn headers_carry_only_the_originator_and_the_runtime_user_agent() {
    let [(first_name, first), (second_name, second)] = headers();
    assert_eq!(
        (first_name, first.as_str()),
        ("originator", "Codex Desktop")
    );
    assert_eq!(second_name, "user-agent");
    assert_eq!(second, user_agent());
    assert_eq!(
        second,
        desktop_user_agent(std::env::consts::OS, std::env::consts::ARCH)
    );
}
