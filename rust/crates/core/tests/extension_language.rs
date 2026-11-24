include!("tool_fixture.rs");
use std::sync::Arc;
use ycoding_core::extension::{Activation, Host, Launch, Options};

#[tokio::test]
async fn activation_closure_is_visible_through_a_retained_binding() {
    let fixture = ToolFixture::new();
    let activation = Arc::new(Activation::new(
        fixture.root.clone(),
        Options::default(),
        Arc::new(fixture.registry()),
        fixture.policy.clone(),
        Launch::default(),
        Host::default(),
    ));
    let retained = Arc::downgrade(&activation);
    assert!(!activation.is_closed().await);
    activation.close().await;
    let retained = retained.upgrade().unwrap();
    assert!(retained.extensions().await.is_empty());
    assert!(retained.is_closed().await);
    retained.close().await;
    assert!(retained.is_closed().await);
    fixture.cleanup();
}
