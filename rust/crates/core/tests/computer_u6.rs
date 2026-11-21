use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use ycoding_core::platform::computer::{
    self,
    boundary::{
        self, Context, Permission, PermissionFailure, Policy, Reservation, Resolved, Review,
    },
    history,
    policy::{Decision, evaluate, override_from_env},
    service::{Coordinator, Invoke, Service},
    types::*,
};

fn temp_directory(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "ycoding-u6-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    directory
}

#[test]
fn u6_policy_forbids_credential_apps_and_the_override_lifts_only_forbidden() {
    let forbidden = evaluate("com.apple.keychainaccess", &[]);
    assert_eq!(forbidden.decision, Decision::Forbidden);
    assert_eq!(forbidden.reason, "Keychain Access stores credentials");
    let lifted = evaluate(
        "com.apple.keychainaccess",
        &override_from_env(Some(" com.apple.keychainaccess , com.example.other ")),
    );
    assert_eq!(lifted.decision, Decision::Allowed);
    let terminal = evaluate(
        "com.apple.Terminal",
        &override_from_env(Some("com.apple.Terminal")),
    );
    assert_eq!(terminal.decision, Decision::Elevated);
    assert_eq!(terminal.reason, "terminals execute arbitrary commands");
    assert_eq!(
        evaluate("com.example.editor", &[]).decision,
        Decision::Allowed
    );
    assert!(override_from_env(None).is_empty());
    assert!(override_from_env(Some(" , ")).is_empty());
}

#[test]
fn u6_diff_elements_renders_added_changed_and_removed_lines() {
    let before = vec![
        json!({"path":[0,1],"role":"AXButton","label":"Save","enabled":true,"focused":false}),
        json!({"path":[0,2],"role":"AXStaticText","label":"Old","value":"a","enabled":true,"focused":false}),
        json!({"path":[1],"role":"AXGroup","label":"","enabled":false,"focused":false}),
    ];
    let after = vec![
        json!({"path":[0,1],"role":"AXButton","label":"Save","enabled":true,"focused":true}),
        json!({"path":[0,2],"role":"AXStaticText","label":"Old","value":"b","enabled":true,"focused":false}),
        json!({"path":[2],"role":"AXTextField","label":"Name","enabled":true,"focused":false}),
    ];
    assert_eq!(
        computer::macos::diff_elements(Some(&before), &after),
        "~ [0,1] AXButton \"Save\" (focused)\n~ [0,2] AXStaticText \"Old\" value=\"b\"\n+ [2] AXTextField \"Name\"\n- [1] AXGroup \"\" (disabled)"
    );
    assert_eq!(computer::macos::diff_elements(Some(&before), &before), "");
}

#[test]
fn u6_history_records_lists_reads_and_validates_stored_events() {
    let directory = temp_directory("history");
    let recorder = history::Recorder::new(directory.clone());
    recorder
        .record(history::Event {
            session_id: "ses_a".into(),
            action: "desktop.click".into(),
            bundle_id: "com.example.app".into(),
            pid: 42,
            window_id: 7,
            revision: "rev-1".into(),
            effect: Some("changed".into()),
            screenshot: history::screenshot_ref(Some("image-data"), Some(10.0), Some(20.0), None),
        })
        .unwrap();
    recorder
        .record(history::Event {
            session_id: "ses_a".into(),
            action: "desktop.inspect".into(),
            bundle_id: "com.example.app".into(),
            pid: 42,
            window_id: 7,
            revision: "rev-2".into(),
            effect: None,
            screenshot: None,
        })
        .unwrap();
    let entries = history::list(&directory).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].session_id, "ses_a");
    assert_eq!(entries[0].events, 2);
    let events = history::read(&directory, &entries[0].id, 500).unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].action, "desktop.click");
    assert_eq!(events[0].screenshot.as_ref().unwrap().sha256.len(), 64);
    assert!(history::read(&directory, "../escape", 500).is_err());
    let file = directory.join(format!("{}.jsonl", entries[0].id));
    let mut contents = std::fs::read_to_string(&file).unwrap();
    contents.push_str("{\"type\":\"event\",\"at\":\"x\",\"sessionID\":\"ses_a\"}\n");
    std::fs::write(&file, contents).unwrap();
    assert_eq!(
        history::read(&directory, &entries[0].id, 500).unwrap_err(),
        "Invalid computer history event"
    );
    std::fs::write(directory.join("broken.jsonl"), "null\n").unwrap();
    assert!(history::list(&directory).is_err());
    std::fs::remove_file(directory.join("broken.jsonl")).unwrap();
    assert_eq!(history::clear(&directory, Some("ses_other")).unwrap(), 0);
    assert_eq!(history::clear(&directory, Some("ses_a")).unwrap(), 1);
    assert!(history::list(&directory).unwrap().is_empty());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[derive(Default)]
struct Native {
    requests: Mutex<Vec<Value>>,
    elements: Mutex<Vec<Value>>,
}
impl Invoke for Native {
    fn invoke<'a>(
        &'a self,
        request: Request,
        _signal: tokio::sync::watch::Receiver<bool>,
    ) -> computer::Future<'a, Result<Success, NativeError>> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request.encode());
            let elements = self.elements.lock().unwrap().clone();
            Ok(Success {
                action: request.operation,
                revision: "rev-1".into(),
                detail: json!({"effect":"unchanged","accessible":true,"elements":elements,"image":"aW1hZ2U=","width":4,"height":3,"scale":1}),
            })
        })
    }
}

#[derive(Default)]
struct AllowPolicy {
    permissions: Mutex<Vec<Permission>>,
}
struct HeldReservation;
impl Reservation for HeldReservation {
    fn release(&self) {}
}
impl Policy for AllowPolicy {
    fn permission<'a>(
        &'a self,
        _context: &'a Context,
        request: Permission,
    ) -> computer::Future<'a, Result<(), PermissionFailure>> {
        Box::pin(async move {
            self.permissions.lock().unwrap().push(request);
            Ok(())
        })
    }
    fn review<'a>(
        &'a self,
        _context: &'a Context,
        _request: Review,
    ) -> computer::Future<'a, Result<Box<dyn Reservation>, String>> {
        Box::pin(async { Ok(Box::new(HeldReservation) as Box<dyn Reservation>) })
    }
    fn resolve<'a>(
        &'a self,
        _path: &'a str,
        _directory: bool,
    ) -> computer::Future<'a, Result<Resolved, String>> {
        Box::pin(async { Err("Unexpected filesystem resolution".into()) })
    }
}

fn context(call: &str) -> Context {
    Context {
        owner: Owner {
            session_id: "ses_a".into(),
            call_id: call.into(),
        },
        message_id: "ams_message".into(),
        agent: "god".into(),
    }
}

fn service_with_history(
    native: &Arc<Native>,
    directory: &std::path::Path,
) -> (Arc<Coordinator>, Service) {
    let coordinator = Coordinator::new(native.clone(), "darwin");
    coordinator.set_history_directory(directory.to_path_buf());
    let service = coordinator.service();
    (coordinator, service)
}

async fn execute(
    service: &Service,
    policy: &AllowPolicy,
    call: &str,
    input: Value,
) -> Result<Value, String> {
    let input = boundary::decode_input(&input)?;
    boundary::execute(service, policy, &context(call), input).await
}

#[tokio::test]
async fn u6_boundary_blocks_forbidden_apps_and_never_saves_elevated_approvals() {
    let directory = temp_directory("policy");
    let native = Arc::new(Native::default());
    let (_coordinator, service) = service_with_history(&native, &directory);
    let policy = AllowPolicy::default();
    let error = execute(
        &service,
        &policy,
        "inspect",
        json!({"action":"desktop.inspect","platform":"macos","bundle_id":"com.1password.1password","pid":9,"window_id":3}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error,
        "app_not_allowed: Computer Use is not allowed to use com.1password.1password (1Password stores credentials)"
    );
    assert!(policy.permissions.lock().unwrap().is_empty());
    assert!(native.requests.lock().unwrap().is_empty());
    execute(
        &service,
        &policy,
        "inspect-terminal",
        json!({"action":"desktop.inspect","platform":"macos","bundle_id":"com.apple.Terminal","pid":9,"window_id":3}),
    )
    .await
    .unwrap();
    assert_eq!(
        policy.permissions.lock().unwrap()[0].save,
        Vec::<String>::new()
    );
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn u6_observe_returns_the_ax_diff_and_history_records_only_claimed_desktop_calls() {
    let directory = temp_directory("observe");
    let native = Arc::new(Native::default());
    *native.elements.lock().unwrap() = vec![
        json!({"path":[0],"role":"AXButton","label":"Save","frame":[0,0,10,10],"actions":["press"],"enabled":true,"focused":false}),
    ];
    let (_coordinator, service) = service_with_history(&native, &directory);
    let policy = AllowPolicy::default();
    let target = json!({"platform":"macos","bundle_id":"com.example.app","pid":42,"window_id":7});
    let mut inspect = target.clone();
    inspect["action"] = json!("desktop.inspect");
    execute(&service, &policy, "inspect", inspect)
        .await
        .unwrap();
    *native.elements.lock().unwrap() = vec![
        json!({"path":[0],"role":"AXButton","label":"Save","frame":[0,0,10,10],"actions":["press"],"enabled":true,"focused":true}),
        json!({"path":[1],"role":"AXStaticText","label":"Done","frame":[0,20,10,10],"actions":[],"enabled":true,"focused":false}),
    ];
    let mut observe = target.clone();
    observe["action"] = json!("desktop.observe");
    let output = execute(&service, &policy, "observe", observe)
        .await
        .unwrap();
    assert_eq!(output["action"], "desktop.observe");
    assert_eq!(
        output["diff"],
        "~ [0] AXButton \"Save\" (focused)\n+ [1] AXStaticText \"Done\""
    );
    assert_eq!(
        native.requests.lock().unwrap()[1]["action"],
        "desktop.observe"
    );
    let listed = execute(
        &service,
        &policy,
        "history",
        json!({"action":"desktop.history","op":"list"}),
    )
    .await
    .unwrap();
    assert_eq!(listed["type"], "history");
    let entries = listed["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["events"], 2);
    let read = execute(
        &service,
        &policy,
        "history-read",
        json!({"action":"desktop.history","op":"read","id":entries[0]["id"],"limit":10}),
    )
    .await
    .unwrap();
    let events = read["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["action"], "desktop.inspect");
    assert_eq!(events[0]["bundleID"], "com.example.app");
    assert_eq!(events[0]["pid"], 42);
    assert!(events[0]["screenshot"]["sha256"].is_string());
    let missing = execute(
        &service,
        &policy,
        "history-missing",
        json!({"action":"desktop.history","op":"read","id":"missing"}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        missing,
        "invalid_request: Computer history entry is unavailable"
    );
    let cleared = execute(
        &service,
        &policy,
        "history-clear",
        json!({"action":"desktop.history","op":"clear"}),
    )
    .await
    .unwrap();
    assert_eq!(cleared["cleared"], 1);
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn u6_key_chords_and_paste_reach_the_native_request() {
    let directory = temp_directory("keys");
    let native = Arc::new(Native::default());
    let (_coordinator, service) = service_with_history(&native, &directory);
    let policy = AllowPolicy::default();
    let target = json!({"platform":"macos","bundle_id":"com.example.app","pid":42,"window_id":7});
    let mut inspect = target.clone();
    inspect["action"] = json!("desktop.inspect");
    execute(&service, &policy, "inspect", inspect)
        .await
        .unwrap();
    let mut key = target.clone();
    key["action"] = json!("desktop.key");
    key["expected_revision"] = json!("rev-1");
    key["key"] = json!("ctrl+shift+Return");
    execute(&service, &policy, "key", key).await.unwrap();
    let sent = native.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!(sent["key"], "enter");
    assert_eq!(sent["modifiers"], json!(["control", "shift"]));
    let mut bad = target.clone();
    bad["action"] = json!("desktop.key");
    bad["expected_revision"] = json!("rev-1");
    bad["key"] = json!("shift");
    assert_eq!(
        execute(&service, &policy, "bad-key", bad)
            .await
            .unwrap_err(),
        "invalid_request: unsupported key chord shift"
    );
    let mut paste = target;
    paste["action"] = json!("desktop.paste");
    paste["expected_revision"] = json!("rev-1");
    paste["text"] = json!("hello");
    paste["format"] = json!("md");
    let output = execute(&service, &policy, "paste", paste).await.unwrap();
    assert_eq!(output["action"], "desktop.paste");
    let sent = native.requests.lock().unwrap().last().cloned().unwrap();
    assert_eq!(sent["action"], "desktop.paste");
    assert_eq!(sent["text"], "hello");
    assert_eq!(sent["format"], "md");
    std::fs::remove_dir_all(&directory).unwrap();
}
