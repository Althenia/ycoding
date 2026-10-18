use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use ycoding_core::{
    remote::Device,
    ycoding_schema::{JsonValue, parse_json},
};
use ycoding_runtime::connector::{
    Control, Error, McpFile, McpPreference, McpSaved, McpStatus, Preference, State,
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Saved(Arc<AtomicBool>);

impl Preference for Saved {
    fn load(&self) -> ycoding_runtime::Boxed<Result<bool, Error>> {
        let value = self.0.load(Ordering::Acquire);
        Box::pin(async move { Ok(value) })
    }
    fn save(&self, value: bool) -> ycoding_runtime::Boxed<Result<(), Error>> {
        self.0.store(value, Ordering::Release);
        Box::pin(async { Ok(()) })
    }
}

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

    async fn control(&self, remote: bool) -> (Control, Arc<AtomicBool>) {
        let saved = Arc::new(AtomicBool::new(remote));
        let control = Control::load_with_mcp(
            Arc::new(Saved(saved.clone())),
            Arc::new(McpFile(self.file())),
            Device::new(&self.0.join("device")).unwrap(),
            self.0.clone(),
        )
        .await;
        (control, saved)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn read(path: &Path) -> McpSaved {
    let JsonValue::Object(object) = parse_json(&std::fs::read_to_string(path).unwrap()).unwrap()
    else {
        panic!("saved relay MCP state is an object");
    };
    let flag = |key: &str| match object.get(&key.into()) {
        Some(JsonValue::Bool(value)) => *value,
        other => panic!("{key}: {other:?}"),
    };
    let Some(JsonValue::String(epoch)) = object.get(&"epoch".into()) else {
        panic!("saved epoch");
    };
    assert_eq!(object.len(), 3);
    McpSaved {
        enabled: flag("enabled"),
        epoch: epoch.to_utf8().unwrap(),
        pending_revocation: flag("pendingRevocation"),
    }
}

fn off() -> McpStatus {
    McpStatus {
        state: State::Off,
        message: None,
        url: None,
    }
}

#[tokio::test]
async fn relay_mcp_defaults_off_and_persists_only_explicit_transitions() {
    let scratch = Scratch::new();
    let (control, _) = scratch.control(true).await;
    assert_eq!(control.mcp_status(), off());
    assert!(!scratch.file().exists(), "a status read never persists");
    let enabled = control.set_mcp(true).await.unwrap();
    assert_eq!(enabled.state, State::Connecting);
    assert_eq!(enabled.url, None);
    let first = read(&scratch.file());
    assert!(first.enabled && !first.pending_revocation);
    assert!(
        first.epoch.len() <= 64
            && first
                .epoch
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(scratch.file())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(
        control.set_mcp(true).await.unwrap().state,
        State::Connecting
    );
    assert_eq!(
        read(&scratch.file()),
        first,
        "repeated enable keeps the epoch"
    );
    let (restarted, _) = scratch.control(true).await;
    assert_eq!(restarted.mcp_status().state, State::Connecting);
    assert_eq!(read(&scratch.file()), first, "restart keeps the epoch");
    assert_eq!(restarted.set_mcp(false).await.unwrap(), off());
    let disabled = read(&scratch.file());
    assert!(!disabled.enabled && disabled.pending_revocation);
    assert_ne!(
        disabled.epoch, first.epoch,
        "explicit disable rotates the epoch"
    );
    assert_eq!(restarted.set_mcp(false).await.unwrap(), off());
    assert_eq!(
        read(&scratch.file()),
        disabled,
        "repeated disable is idempotent"
    );
    assert_eq!(
        restarted.set_mcp(true).await.unwrap().state,
        State::Connecting
    );
    let again = read(&scratch.file());
    assert!(again.enabled && !again.pending_revocation);
    assert!(again.epoch != first.epoch && again.epoch != disabled.epoch);
}

#[tokio::test]
async fn enabling_requires_remote_and_remote_off_forces_mcp_off() {
    let scratch = Scratch::new();
    let (control, saved) = scratch.control(false).await;
    assert_eq!(control.set_mcp(true).await, Err(Error::Conflict));
    assert!(!scratch.file().exists());
    control.set(true).await.unwrap();
    assert_eq!(
        control.mcp_status(),
        off(),
        "starting Remote never enables MCP"
    );
    control.set_mcp(true).await.unwrap();
    let enabled = read(&scratch.file());
    control.set(false).await.unwrap();
    assert!(!saved.load(Ordering::Acquire));
    assert_eq!(control.mcp_status(), off());
    let forced = read(&scratch.file());
    assert!(!forced.enabled && forced.pending_revocation);
    assert_ne!(forced.epoch, enabled.epoch);
    control.set(true).await.unwrap();
    assert_eq!(control.mcp_status(), off());
    assert_eq!(read(&scratch.file()), forced);
    let (restarted, _) = scratch.control(true).await;
    assert_eq!(restarted.mcp_status(), off());
}

#[tokio::test]
async fn unreadable_or_unsafe_saved_state_fails_closed_without_overwrite() {
    for (name, setup) in [
        (
            "invalid",
            (|path: &Path| std::fs::write(path, "{").unwrap()) as fn(&Path),
        ),
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
        let before = std::fs::symlink_metadata(scratch.file()).unwrap();
        let contents = std::fs::read(scratch.file()).ok();
        let (control, _) = scratch.control(true).await;
        assert_eq!(control.mcp_status().state, State::Error, "{name}");
        assert_eq!(
            control.set_mcp(true).await,
            Err(Error::Preference),
            "{name}"
        );
        assert_eq!(
            control.set_mcp(false).await,
            Err(Error::Preference),
            "{name}"
        );
        assert_eq!(control.mcp_status().state, State::Error, "{name}");
        let after = std::fs::symlink_metadata(scratch.file()).unwrap();
        assert_eq!(before.file_type(), after.file_type(), "{name}");
        assert_eq!(std::fs::read(scratch.file()).ok(), contents, "{name}");
    }
}

#[tokio::test]
async fn unreadable_relay_mcp_state_never_blocks_turning_remote_off() {
    let scratch = Scratch::new();
    std::fs::write(scratch.file(), "{").unwrap();
    let (control, saved) = scratch.control(true).await;
    assert_eq!(control.mcp_status().state, State::Error);
    assert_eq!(control.set(false).await.unwrap().state, State::Off);
    assert!(!saved.load(Ordering::Acquire));
    assert_eq!(std::fs::read_to_string(scratch.file()).unwrap(), "{");
    assert_eq!(control.mcp_status().state, State::Error);
    assert_eq!(control.set_mcp(true).await, Err(Error::Conflict));
}

#[tokio::test]
async fn controls_without_relay_mcp_storage_report_unavailable() {
    let scratch = Scratch::new();
    let control = Control::load(
        Arc::new(Saved(Arc::new(AtomicBool::new(true)))),
        Device::new(&scratch.0.join("device")).unwrap(),
    )
    .await;
    assert_eq!(
        control.mcp_status(),
        McpStatus {
            state: State::Off,
            message: Some("Relay MCP is unavailable"),
            url: None,
        }
    );
    assert_eq!(control.set_mcp(true).await, Err(Error::Preference));
    assert!(!scratch.file().exists());
}

#[tokio::test]
async fn production_controls_compose_the_relay_mcp_file_beside_the_remote_preference() {
    let scratch = Scratch::new();
    let control = Control::open_with_home(&scratch.0, &scratch.0)
        .await
        .unwrap();
    assert_eq!(control.mcp_status(), off());
    assert_eq!(control.set_mcp(true).await, Err(Error::Conflict));
    control.set(true).await.unwrap();
    control.set_mcp(true).await.unwrap();
    assert!(read(&scratch.file()).enabled);
    let reopened = Control::open_with_home(&scratch.0, &scratch.0)
        .await
        .unwrap();
    assert_eq!(reopened.mcp_status().state, State::Connecting);
    let saved: Arc<dyn McpPreference> = Arc::new(McpFile(scratch.file()));
    assert!(saved.load().await.unwrap().unwrap().enabled);
}
