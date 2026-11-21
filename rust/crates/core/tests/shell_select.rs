use std::collections::BTreeMap;
use ycoding_core::platform::shell::select;

#[test]
fn windows_env_msys_paths_and_explicit_gitbash_override() {
    let known = [
        "C:/Program Files/Git/bin/bash.exe",
        "D:/custom/bash.exe",
        "C:/PowerShell/pwsh.exe",
    ];
    let find = |file: &str| match file {
        "pwsh" | "pwsh.exe" => Some("C:/PowerShell/pwsh.exe".into()),
        "bash" => Some("C:/other/bash.exe".into()),
        "git" => Some("C:/Program Files/Git/cmd/git.exe".into()),
        _ => None,
    };
    let is_file = |file: &str| known.contains(&file);
    for env in [
        "/cygdrive/c/Program Files/Git/bin/bash.exe",
        "/mnt/c/Program Files/Git/bin/bash.exe",
        "/c/Program Files/Git/bin/bash.exe",
        "/c:/Program Files/Git/bin/bash.exe",
    ] {
        assert_eq!(
            select::windows_preferred(
                None,
                &BTreeMap::from([("SHELL".into(), env.into())]),
                None,
                find,
                is_file
            ),
            "C:/Program Files/Git/bin/bash.exe"
        );
    }
    assert_eq!(
        select::windows_preferred(
            None,
            &BTreeMap::from([("SHELL".into(), "/usr/bin/bash".into())]),
            Some("D:/custom/bash.exe"),
            find,
            is_file
        ),
        "D:/custom/bash.exe"
    );
    assert_eq!(
        select::windows_preferred(Some("bash"), &BTreeMap::new(), None, find, is_file),
        "C:/Program Files/Git/bin/bash.exe"
    );
    assert_eq!(
        select::windows_preferred(
            Some("missing"),
            &BTreeMap::from([("SHELL".into(), "bash".into())]),
            None,
            find,
            is_file
        ),
        "C:/PowerShell/pwsh.exe"
    );
    assert_eq!(
        select::windows_preferred(
            None,
            &BTreeMap::from([("COMSPEC".into(), "D:/cmd.exe".into())]),
            None,
            |_| None,
            |_| false
        ),
        "D:/cmd.exe"
    );
    assert_eq!(select::windows_name("C:\\tools\\NU.EXE"), "nu");
    assert_eq!(
        select::windows_acceptable(Some("NU.EXE"), &BTreeMap::new(), None, find, |_| true),
        "C:/PowerShell/pwsh.exe"
    );
}
