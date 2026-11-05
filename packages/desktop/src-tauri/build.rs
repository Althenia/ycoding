fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_preferences",
            "desktop_state",
            "desktop_connect",
            "desktop_disconnect",
            "desktop_sessions",
            "desktop_workspaces",
            "desktop_messages",
            "desktop_create_session",
            "desktop_prompt",
            "desktop_interrupt",
            "desktop_requests",
            "desktop_reply",
            "desktop_models",
            "desktop_switch_model",
            "desktop_pin",
            "desktop_session",
        ]),
    ))
    .expect("desktop permissions and configuration must be valid");
}
