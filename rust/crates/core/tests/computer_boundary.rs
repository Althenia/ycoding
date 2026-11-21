use serde_json::json;
use std::sync::{Arc, Mutex};
use ycoding_core::platform::computer::{
    self,
    boundary::{
        self, Context, Permission, PermissionFailure, Policy, Reservation, Resolved, Review,
    },
    service::{Coordinator, Invoke},
    types::*,
};
struct Native(Arc<Mutex<Vec<String>>>);
impl Invoke for Native {
    fn invoke<'a>(
        &'a self,
        request: Request,
        _signal: tokio::sync::watch::Receiver<bool>,
    ) -> computer::Future<'a, Result<Success, NativeError>> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap()
                .push(format!("native:{}", request.operation.as_str()));
            Ok(Success {
                action: request.operation,
                revision: "rev-1".into(),
                detail: json!({"effect":"unchanged","tabIndex":2}),
            })
        })
    }
}
struct Host {
    calls: Arc<Mutex<Vec<String>>>,
    deny: bool,
}
struct Held(Arc<Mutex<Vec<String>>>);
impl Reservation for Held {
    fn release(&self) {
        self.0.lock().unwrap().push("release".into());
    }
}
impl Policy for Host {
    fn permission<'a>(
        &'a self,
        _context: &'a Context,
        request: Permission,
    ) -> computer::Future<'a, Result<(), PermissionFailure>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(format!(
                "permission:{}:{}",
                request.action,
                request.resources.join(",")
            ));
            Ok(())
        })
    }
    fn review<'a>(
        &'a self,
        _context: &'a Context,
        request: Review,
    ) -> computer::Future<'a, Result<Box<dyn Reservation>, String>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(format!(
                "guardrail:{}:{}:{}",
                request.action,
                request.resources.join(","),
                request.skip_review
            ));
            if self.deny {
                return Err("blocked".into());
            }
            Ok(Box::new(Held(self.calls.clone())) as Box<dyn Reservation>)
        })
    }
    fn resolve<'a>(
        &'a self,
        path: &'a str,
        _directory: bool,
    ) -> computer::Future<'a, Result<Resolved, String>> {
        Box::pin(async move {
            let canonical = if path.starts_with("/workspace/") {
                path.into()
            } else {
                format!("/workspace/{path}")
            };
            Ok(Resolved {
                resource: canonical.trim_start_matches("/workspace/").into(),
                canonical,
                external_directory: None,
            })
        })
    }
}
fn context() -> Context {
    Context {
        owner: Owner {
            session_id: "ses_owner".into(),
            call_id: "call".into(),
        },
        message_id: "ams_message".into(),
        agent: "god".into(),
    }
}

#[tokio::test]
async fn permission_then_deny_capable_skip_review_precedes_any_native_dispatch() {
    for deny in [false, true] {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let host = Host {
            calls: calls.clone(),
            deny,
        };
        let service = Coordinator::new(Arc::new(Native(calls.clone())), "darwin").service();
        let input = boundary::decode_input(
            &json!({"action":"webbrowser.tabs","platform":"macos","bundle_id":"com.apple.Safari"}),
        )
        .unwrap();
        let result = boundary::execute(&service, &host, &context(), input).await;
        if deny {
            assert!(result.is_err());
            assert_eq!(calls.lock().unwrap().len(), 2);
        } else {
            assert_eq!(result.unwrap()["tab_index"], 2);
            assert_eq!(
                *calls.lock().unwrap(),
                vec![
                    "permission:computer:macos.bundle_id/com.apple.Safari/webbrowser.tabs",
                    "guardrail:computer:macos.bundle_id/com.apple.Safari/webbrowser.tabs:true",
                    "native:webbrowser.tabs",
                    "release"
                ]
            );
        }
    }
}

#[tokio::test]
async fn finder_paths_are_resolved_before_permission_and_inspection() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let host = Host {
        calls: calls.clone(),
        deny: false,
    };
    let service = Coordinator::new(Arc::new(Native(calls.clone())), "darwin").service();
    let inspected = boundary::decode_input(
        &json!({"action":"finder.inspect","platform":"macos","path":"fixture/old.txt"}),
    )
    .unwrap();
    boundary::execute(&service, &host, &context(), inspected)
        .await
        .unwrap();
    calls.lock().unwrap().clear();
    let moved=boundary::decode_input(&json!({"action":"finder.move","platform":"macos","path":"fixture/old.txt","destination_directory":"moved","expected_revision":"rev-1"})).unwrap();
    boundary::execute(&service, &host, &context(), moved)
        .await
        .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            "permission:computer:fixture/old.txt,moved/old.txt",
            "guardrail:file_mutation:/workspace/fixture/old.txt,/workspace/moved/old.txt:true",
            "native:finder.move",
            "release"
        ]
    );
}

#[test]
fn integer_strings_browser_limits_and_keyboard_contract_match_ts() {
    let input=boundary::decode_input(&json!({"action":"desktop.click","platform":"macos","bundle_id":"com.example.fixture","pid":"451","window_id":"73","x":"12","y":"13","count":"2","expected_revision":"rev"})).unwrap();
    assert_eq!(input.operation(), Some(Operation::DesktopClick));
    for value in ["-1", "1.2", "invalid"] {
        assert!(boundary::decode_input(&json!({"action":"desktop.inspect","platform":"macos","bundle_id":"x","pid":value,"window_id":73})).is_err());
    }
    for value in ["javascript:alert(1)", "https:relative"] {
        assert!(boundary::decode_input(&json!({"action":"webbrowser.navigate","platform":"macos","bundle_id":"com.google.Chrome","window_id":"17","tab_index":1,"expected_revision":"rev","url":value})).is_err());
    }
    assert!(boundary::decode_input(&json!({"action":"webbrowser.eval","platform":"macos","bundle_id":"com.apple.Safari","window_id":"17","tab_index":1,"expected_revision":"rev","script":"x".repeat(65537)})).is_err());
    assert!(
        boundary::decode_input(
            &json!({"action":"webbrowser.tabs","platform":"macos","bundle_id":"com.apple.finder"})
        )
        .is_err()
    );
}

#[test]
fn capture_becomes_native_media_not_base64_text_and_value_limit_is_utf8() {
    let output = json!({"type":"result","action":"desktop.capture","revision":"rev","image":"base64","width":320,"height":240,"scale":1});
    let parts = boundary::model_output(&output);
    assert_eq!(parts.len(), 2);
    assert!(!parts[0].to_string().contains("base64"));
    assert_eq!(parts[1]["mime"], "image/jpeg");
    assert!(
        boundary::result_output(Success {
            action: Operation::BrowserEvaluate,
            revision: "rev".into(),
            detail: json!({"value":"é".repeat(8193)})
        })
        .is_err()
    );
}
