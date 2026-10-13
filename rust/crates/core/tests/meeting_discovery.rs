#![cfg(unix)]

use serde_json::{Value, json};
use std::future::Future;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use ycoding_core::meeting::BoxFuture;
use ycoding_core::meeting::bridge::{Bridge, CallbackFailed, CaptureMessage, Handlers, Options};
use ycoding_core::meeting::discovery::{
    Control, Descriptor, DiscoveryError, RuntimeLock, directory, publish_descriptor,
    remove_descriptor,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-meeting-discovery-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn timed<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(20), future)
        .await
        .expect("test exceeded its hard timeout")
}

struct Reply(Value);

impl Handlers for Reply {
    fn control(&self, _input: Value) -> BoxFuture<'_, Result<Value, CallbackFailed>> {
        Box::pin(async { Ok(self.0.clone()) })
    }

    fn capture(&self, _input: CaptureMessage) -> BoxFuture<'_, Result<Value, CallbackFailed>> {
        Box::pin(async { Ok(Value::Null) })
    }
}

fn token(character: char) -> String {
    character.to_string().repeat(64)
}

fn descriptor(url: &str, token: &str) -> Descriptor {
    Descriptor::parse(&json!({ "url": url, "token": token, "pid": std::process::id() })).unwrap()
}

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn descriptor_refuses_public_hosts_malformed_credentials_and_non_loopback_shapes() {
    let valid = json!({ "url": "http://127.0.0.1:9000", "token": "a".repeat(64), "pid": 12 });
    assert_eq!(Descriptor::parse(&valid).unwrap().pid, 12);
    let mutate = |key: &str, value: Value| {
        let mut changed = valid.clone();
        changed[key] = value;
        changed
    };
    for rejected in [
        mutate("url", json!("http://example.org:9000")),
        mutate("url", json!("http://localhost:9000")),
        mutate("url", json!("https://127.0.0.1:9000")),
        mutate("url", json!("http://127.0.0.1")),
        mutate("url", json!("http://127.0.0.1:80")),
        mutate("url", json!("http://user:secret@127.0.0.1:9000")),
        mutate("url", json!("http://127.0.0.1:9000/path")),
        mutate("url", json!("http://127.0.0.1:9000/?q=1")),
        mutate("url", json!("http://127.0.0.1:9000/#fragment")),
        mutate("url", json!("not a url")),
        mutate("token", json!("short")),
        mutate("token", json!("A".repeat(64))),
        mutate("token", json!("a".repeat(65))),
        mutate("pid", json!(0)),
        mutate("pid", json!(-1)),
        mutate("pid", json!(1.5)),
        mutate("pid", json!("12")),
        json!({ "url": "http://127.0.0.1:9000", "token": "a".repeat(64) }),
        json!({ "url": "http://127.0.0.1:9000", "token": "a".repeat(64), "pid": 12, "extra": true }),
        json!("descriptor"),
    ] {
        assert!(Descriptor::parse(&rejected).is_err(), "accepted {rejected}");
    }
}

#[test]
fn location_directory_is_stable_private_to_the_location_and_under_the_data_home() {
    let scratch = Scratch::new();
    let (first, second) = (scratch.0.join("first"), scratch.0.join("second"));
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let data = scratch.0.join("data");
    let one = directory(&first, Some(&data), &scratch.0).unwrap();
    assert_eq!(one, directory(&first, Some(&data), &scratch.0).unwrap());
    assert_ne!(one, directory(&second, Some(&data), &scratch.0).unwrap());
    assert_eq!(one.parent().unwrap(), data.join("ycoding/meeting"));
    assert_eq!(one.file_name().unwrap().len(), 32);
    assert_eq!(
        directory(&first, None, &scratch.0)
            .unwrap()
            .parent()
            .unwrap(),
        scratch.0.join(".local/share/ycoding/meeting")
    );
}

#[test]
fn descriptor_is_published_privately_replaced_in_place_and_removed_on_unload() {
    let scratch = Scratch::new();
    let file = scratch.0.join("bridge.json");
    let first = descriptor("http://127.0.0.1:9000", &token('a'));
    publish_descriptor(&scratch.0, &first).unwrap();
    assert_eq!(mode(&file), 0o600);
    assert_eq!(Control::connect(&scratch.0).unwrap().descriptor(), &first);
    let second = descriptor("http://127.0.0.1:9001", &token('b'));
    publish_descriptor(&scratch.0, &second).unwrap();
    assert_eq!(mode(&file), 0o600);
    assert_eq!(Control::connect(&scratch.0).unwrap().descriptor(), &second);
    remove_descriptor(&scratch.0).unwrap();
    assert!(!file.exists());
    match Control::connect(&scratch.0) {
        Err(DiscoveryError::Io(error)) => assert_eq!(error.kind(), std::io::ErrorKind::NotFound),
        other => panic!("expected a missing descriptor, got {other:?}"),
    }
}

#[test]
fn controller_refuses_unsafe_or_malformed_descriptor_files() {
    let scratch = Scratch::new();
    let file = scratch.0.join("bridge.json");
    let valid = descriptor("http://127.0.0.1:9000", &token('a'))
        .to_value()
        .to_string();
    let public =
        json!({ "url": "http://example.org:9000", "token": token('a'), "pid": 1 }).to_string();
    for (name, contents, permissions) in [
        ("group readable", valid.clone(), 0o640),
        ("world readable", valid.clone(), 0o644),
        ("oversized", format!("{valid}{}", " ".repeat(4096)), 0o600),
        ("malformed JSON", "{".to_owned(), 0o600),
        ("public host", public, 0o600),
    ] {
        let _ = std::fs::remove_file(&file);
        std::fs::write(&file, contents).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(permissions)).unwrap();
        assert!(Control::connect(&scratch.0).is_err(), "accepted {name}");
    }
    let _ = std::fs::remove_file(&file);
    let target = scratch.0.join("elsewhere.json");
    std::fs::write(&target, &valid).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::os::unix::fs::symlink(&target, &file).unwrap();
    assert!(
        matches!(Control::connect(&scratch.0), Err(DiscoveryError::Invalid(message)) if message == "Unsafe meeting bridge descriptor")
    );
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    assert!(Control::connect(&scratch.0).is_err());
}

#[test]
fn runtime_lock_is_exclusive_private_and_replaces_only_a_stale_owner() {
    let scratch = Scratch::new();
    let directory = scratch.0.join("meeting");
    let lock = RuntimeLock::acquire(&directory).unwrap();
    assert_eq!(mode(&directory), 0o700);
    assert_eq!(mode(&directory.join("runtime.lock")), 0o600);
    let recorded: Value =
        serde_json::from_str(&std::fs::read_to_string(directory.join("runtime.lock")).unwrap())
            .unwrap();
    assert_eq!(recorded, json!({ "pid": std::process::id() }));
    match RuntimeLock::acquire(&directory) {
        Err(DiscoveryError::Invalid(message)) => assert_eq!(
            message,
            "Meeting runtime is already running for this Location"
        ),
        other => panic!("a live owner must keep the lock, got {:?}", other.err()),
    }
    lock.release().unwrap();
    assert!(!directory.join("runtime.lock").exists());

    let mut finished = std::process::Command::new("true").spawn().unwrap();
    let stale = finished.id();
    finished.wait().unwrap();
    std::fs::write(
        directory.join("runtime.lock"),
        json!({ "pid": stale }).to_string(),
    )
    .unwrap();
    let replaced = RuntimeLock::acquire(&directory).unwrap();
    let recorded: Value =
        serde_json::from_str(&std::fs::read_to_string(directory.join("runtime.lock")).unwrap())
            .unwrap();
    assert_eq!(recorded, json!({ "pid": std::process::id() }));
    replaced.release().unwrap();

    std::fs::write(directory.join("runtime.lock"), "not json").unwrap();
    assert!(RuntimeLock::acquire(&directory).is_err());
}

#[tokio::test]
async fn controller_reconnects_after_the_runtime_publishes_or_replaces_its_descriptor() {
    timed(async {
        let scratch = Scratch::new();
        let missing = Control::connect(&scratch.0);
        assert!(matches!(missing, Err(DiscoveryError::Io(ref error)) if error.kind() == std::io::ErrorKind::NotFound));
        let publish = async |response: Value, secret: char| {
            let bridge = Bridge::start(Options::new(token(secret)), Arc::new(Reply(response))).await.unwrap();
            publish_descriptor(&scratch.0, &descriptor(bridge.url(), &token(secret))).unwrap();
            bridge
        };
        let first = publish(json!({ "runtime": "first" }), 'a').await;
        assert_eq!(Control::connect(&scratch.0).unwrap().send(&json!({ "action": "status" })).await.unwrap(), json!({ "runtime": "first" }));
        first.close().await;
        let stopped = Control::connect(&scratch.0).unwrap().send(&json!({ "action": "status" })).await.unwrap_err();
        assert_eq!(stopped.0, "Bridge request failed or timed out; outcome unknown");
        let second = publish(json!({ "runtime": "restarted" }), 'b').await;
        assert_eq!(Control::connect(&scratch.0).unwrap().send(&json!({ "action": "status" })).await.unwrap(), json!({ "runtime": "restarted" }));
        second.close().await;
    })
    .await;
}
