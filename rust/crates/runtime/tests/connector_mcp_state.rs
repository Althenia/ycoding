use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};
use ycoding_runtime::connector::{Control, State};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-mcp-state-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn file(&self) -> PathBuf {
        self.0.join("remote-mcp.json")
    }

    fn siblings(&self) -> Vec<String> {
        let mut names = std::fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.starts_with("remote-mcp"))
            .collect::<Vec<_>>();
        names.sort();
        names
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn historical_relay_mcp_state_stays_untouched_across_remote_start_and_stop() {
    for (name, setup) in [
        (
            "enabled",
            (|path: &Path| {
                std::fs::write(
                    path,
                    r#"{"enabled":true,"epoch":"mcp_a","pendingRevocation":false}"#,
                )
                .unwrap()
            }) as fn(&Path),
        ),
        ("pending revocation", |path: &Path| {
            std::fs::write(
                path,
                r#"{"enabled":false,"epoch":"mcp_a","pendingRevocation":true}"#,
            )
            .unwrap()
        }),
        ("invalid", |path: &Path| std::fs::write(path, "{").unwrap()),
        ("extra key", |path: &Path| {
            std::fs::write(
                path,
                r#"{"enabled":true,"epoch":"mcp_a","pendingRevocation":false,"url":"x"}"#,
            )
            .unwrap()
        }),
        ("bad epoch", |path: &Path| {
            std::fs::write(
                path,
                r#"{"enabled":true,"epoch":"has space","pendingRevocation":false}"#,
            )
            .unwrap()
        }),
        ("contradictory", |path: &Path| {
            std::fs::write(
                path,
                r#"{"enabled":true,"epoch":"mcp_a","pendingRevocation":true}"#,
            )
            .unwrap()
        }),
        ("oversize", |path: &Path| {
            std::fs::write(path, " ".repeat(2048)).unwrap()
        }),
        ("directory", |path: &Path| {
            std::fs::create_dir(path).unwrap()
        }),
        #[cfg(unix)]
        ("symlink", |path: &Path| {
            let target = path.with_file_name("elsewhere.json");
            std::fs::write(
                &target,
                r#"{"enabled":true,"epoch":"mcp_a","pendingRevocation":false}"#,
            )
            .unwrap();
            std::os::unix::fs::symlink(target, path).unwrap()
        }),
    ] {
        let scratch = Scratch::new();
        setup(&scratch.file());
        let kind = std::fs::symlink_metadata(scratch.file())
            .unwrap()
            .file_type();
        let contents = std::fs::read(scratch.file()).ok();
        let control = Control::open(&scratch.0).await.unwrap();
        assert_eq!(control.status().state, State::Off, "{name}");
        assert_eq!(
            control.set(true).await.unwrap().state,
            State::Connecting,
            "{name}"
        );
        assert_eq!(
            control.set(false).await.unwrap().state,
            State::Off,
            "{name}"
        );
        assert_eq!(
            control.set(true).await.unwrap().state,
            State::Connecting,
            "{name}"
        );
        assert_eq!(
            control.set(false).await.unwrap().state,
            State::Off,
            "{name}"
        );
        assert_eq!(
            std::fs::read_to_string(scratch.0.join("remote.json")).unwrap(),
            r#"{"enabled":false}"#,
            "{name}"
        );
        assert_eq!(
            std::fs::symlink_metadata(scratch.file())
                .unwrap()
                .file_type(),
            kind,
            "{name}"
        );
        assert_eq!(std::fs::read(scratch.file()).ok(), contents, "{name}");
        let reopened = Control::open(&scratch.0).await.unwrap();
        assert_eq!(reopened.status().state, State::Off, "{name}");
        assert_eq!(std::fs::read(scratch.file()).ok(), contents, "{name}");
    }
}

#[tokio::test]
async fn an_absent_relay_mcp_state_file_is_never_created() {
    let scratch = Scratch::new();
    let control = Control::open(&scratch.0).await.unwrap();
    assert_eq!(control.set(true).await.unwrap().state, State::Connecting);
    assert_eq!(control.set(false).await.unwrap().state, State::Off);
    assert_eq!(control.set(true).await.unwrap().state, State::Connecting);
    let reopened = Control::open(&scratch.0).await.unwrap();
    assert_eq!(reopened.status().state, State::Connecting);
    assert!(!scratch.file().exists());
    assert!(scratch.siblings().is_empty(), "{:?}", scratch.siblings());
}
