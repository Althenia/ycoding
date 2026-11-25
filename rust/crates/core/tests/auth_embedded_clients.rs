use ycoding_core::resources::auth::{Client, DeviceFlow, install_embedded_clients};

const REDIRECT: &str = "http://localhost:51121/oauth-callback";

#[tokio::test]
async fn embedded_clients_install_once_and_are_read_by_new_clients() {
    let before = Client::new("https://oauth2.googleapis.com", "fixture").unwrap();
    assert!(
        before
            .start_code("antigravity", "google", REDIRECT)
            .is_err()
    );
    assert!(before.start_device(DeviceFlow::Muse, 0).await.is_err());

    assert!(install_embedded_clients(
        Some(("fixture-antigravity-id", Some("fixture-antigravity-secret"))),
        Some(("fixture-muse-id", None)),
    ));
    assert!(!install_embedded_clients(None, None));

    let after = Client::new("https://oauth2.googleapis.com", "fixture").unwrap();
    let url = after
        .start_code("antigravity", "google", REDIRECT)
        .unwrap()
        .url()
        .to_owned();
    assert!(url.contains("client_id=fixture-antigravity-id"));
    assert!(
        before
            .start_code("antigravity", "google", REDIRECT)
            .is_err()
    );
}
