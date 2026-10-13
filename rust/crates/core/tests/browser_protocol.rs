use serde_json::json;
use ycoding_core::platform::browser::{
    admission::{Admission, Mode},
    extension, protocol,
};

#[test]
fn protocol_requires_profile_grant_version_and_exact_extension_origin() {
    let shared = json!({"type":"shared","tabID":"btab_profile_wire","title":"Synthetic","url":"https://example.test/","documentGeneration":1,"active":true});
    assert!(protocol::decode_client(shared.to_string().as_bytes()).is_none());
    let mut granted = shared;
    granted["mode"] = json!("profile");
    assert!(protocol::decode_client(granted.to_string().as_bytes()).is_some());
    for version in [2, 3, 5] {
        assert!(protocol::decode_client(json!({"type":"pair","version":version,"extensionID":"b".repeat(32),"secret":"s".repeat(32)}).to_string().as_bytes()).is_none());
    }
    assert!(
        protocol::decode_client(
            json!({"type":"pair","version":4,"extensionID":"b".repeat(32),"secret":"s".repeat(32)})
                .to_string()
                .as_bytes()
        )
        .is_some()
    );
    assert_eq!(
        protocol::extension_id_from_origin(&format!("chrome-extension://{}", "a".repeat(32))),
        Some("a".repeat(32))
    );
    for origin in [
        format!("chrome-extension://{}/", "a".repeat(32)),
        format!("chrome-extension://{}", "q".repeat(32)),
        "https://example.test".into(),
    ] {
        assert_eq!(protocol::extension_id_from_origin(&origin), None);
    }
    assert!(protocol::decode_client(&[255]).is_none());
    assert!(protocol::decode_client(&vec![b' '; protocol::MAX_FRAME_BYTES + 1]).is_none());
}

#[test]
fn protocol_validates_correlated_results_and_does_not_accept_numeric_strings() {
    let mut result = json!({"type":"result","callID":"call","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":0,"status":"completed","title":"Title","url":"https://example.test/"});
    assert!(protocol::decode_client(result.to_string().as_bytes()).is_some());
    result["generation"] = json!("1");
    assert!(protocol::decode_client(result.to_string().as_bytes()).is_none());
    result["generation"] = json!(1);
    result["status"] = json!("uncertain");
    assert!(protocol::decode_client(result.to_string().as_bytes()).is_none());
}

#[test]
fn admission_is_per_session_and_release_cannot_remove_another_mode() {
    let admission = Admission::default();
    assert!(admission.claim("ses_a", Mode::Selected));
    assert!(admission.claim("ses_a", Mode::Selected));
    assert!(!admission.claim("ses_a", Mode::Isolated));
    assert!(admission.claim("ses_b", Mode::Isolated));
    admission.release("ses_a", Mode::Isolated);
    assert_eq!(admission.current("ses_a"), Some(Mode::Selected));
    admission.release("ses_a", Mode::Selected);
    assert!(admission.claim("ses_a", Mode::Isolated));
}

#[test]
fn extension_installation_paths_and_archive_entries_are_explicit() {
    assert_eq!(
        extension::location(
            std::path::Path::new("/opt/homebrew/bin/bun"),
            std::path::Path::new("/source")
        ),
        std::path::PathBuf::from("/source")
            .join("extensions")
            .join("chrome")
    );
    assert_eq!(
        extension::location(
            std::path::Path::new("/opt/ycoding/bin/ycoding"),
            std::path::Path::new("/source")
        ),
        std::path::PathBuf::from("/opt/ycoding/bin/ycoding-chrome-extension")
    );
    assert_eq!(extension::FILES.len(), 10);
    assert!(extension::FILES.contains(&"service-worker.js"));
    assert!(!extension::FILES.contains(&"indicator.js"));
}
