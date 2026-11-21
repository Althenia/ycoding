use serde_json::json;
use ycoding_core::platform::browser::capture;

#[test]
fn capture_inspection_traverses_frames_and_shadow_roots_before_dispatch() {
    for root in [
        json!({"nodeName":"#document","children":[{"nodeName":"IFRAME","contentDocument":{"nodeName":"#document","children":[{"nodeName":"INPUT","attributes":["type","password"]}]}}]}),
        json!({"nodeName":"#document","children":[{"nodeName":"DIV","shadowRoots":[{"nodeName":"#document-fragment","children":[{"nodeName":"INPUT","attributes":["TYPE","PASSWORD"]}]}]}]}),
    ] {
        assert_eq!(
            capture::assert_safe(&root).unwrap_err().message,
            "Capture is disabled while password fields are present"
        );
    }
}

#[test]
fn incomplete_and_unbounded_documents_fail_closed() {
    for root in [
        json!({"nodeName":"IFRAME"}),
        json!({"nodeName":"DIV","childNodeCount":2,"children":[{"nodeName":"SPAN"}]}),
        json!({"nodeName":"DIV","children":{}}),
        json!(null),
    ] {
        assert_eq!(
            capture::assert_safe(&root).unwrap_err().message,
            "Capture is disabled because the page could not be completely inspected"
        );
    }
    let mut deep = json!({"nodeName":"SPAN"});
    for _ in 0..33 {
        deep = json!({"nodeName":"DIV","children":[deep]});
    }
    assert!(capture::assert_safe(&deep).is_err());
    assert!(
        capture::assert_safe(
            &json!({"nodeName":"DIV","children":vec![json!({"nodeName":"SPAN"});10_000]})
        )
        .is_err()
    );
    assert!(capture::assert_safe(&json!({"nodeName":"#document","children":[{"nodeName":"INPUT","attributes":["type","text"]}]})).is_ok());
}
