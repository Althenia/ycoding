use ycoding_core::resources::auth::Client;

#[test]
fn managed_claude_refresh_endpoint_is_available_without_ai_changes() {
    assert!(Client::provider("anthropic", "fixture").is_ok());
}
