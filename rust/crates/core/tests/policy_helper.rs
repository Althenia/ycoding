use ycoding_core::tools::policy::helper::{
    CompactionScope, ModelSelection, Role, Settings, local_title, select_helper_model,
};
use ycoding_schema::{DomainDecode, LosslessString, model, parse_json};

fn model(id: &str) -> model::Ref {
    model::Ref::decode(&parse_json(&format!("{{\"id\":\"{id}\",\"providerID\":\"fixture\",\"variant\":\"high\",\"profile\":\"Owner\"}}")).unwrap()).unwrap()
}

#[test]
fn helper_selection_preserves_role_and_compaction_scope_precedence() {
    let agent = model("agent");
    let session = model("session");
    let configured = model("configured");
    assert_eq!(
        select_helper_model(
            Some(&agent),
            Some(&ModelSelection::Model(configured.clone())),
            Some(&session)
        ),
        Some(&agent)
    );
    assert_eq!(
        select_helper_model(None, Some(&ModelSelection::Session), Some(&session)),
        Some(&session)
    );
    let mut settings = Settings::default();
    settings
        .models
        .insert(Role::Decision, ModelSelection::Model(configured.clone()));
    settings.compaction_scopes.insert(
        CompactionScope::Main,
        ModelSelection::Model(configured.clone()),
    );
    assert_eq!(
        settings.select(
            Role::Decision,
            CompactionScope::Main,
            Some(&agent),
            Some(&session)
        ),
        Some(&agent)
    );
    assert_eq!(
        settings.select(
            Role::Compaction,
            CompactionScope::Main,
            Some(&agent),
            Some(&session)
        ),
        Some(&configured)
    );
    assert_eq!(
        settings.select(
            Role::Compaction,
            CompactionScope::Subagent,
            Some(&agent),
            Some(&session)
        ),
        Some(&agent)
    );
    assert!(
        settings
            .resolve::<(), ()>(
                Role::Decision,
                CompactionScope::Main,
                None,
                Some(&session),
                |_| Err(())
            )
            .is_none()
    );
}

#[test]
fn local_titles_strip_terminal_controls_markdown_and_truncate_unicode_characters() {
    for (input, expected) in [
        (
            "  # Fix the migration\nIgnore this line  ",
            "Fix the migration",
        ),
        ("\0>   Repair   the   build\x07", "Repair the build"),
        ("\x1b[31m## Repair migration\x1b[0m", "Repair migration"),
        ("   ", "New session"),
        ("\x1b]0;title\x07- Work", "Work"),
    ] {
        assert_eq!(local_title(&input.into()), LosslessString::from(expected));
    }
    assert_eq!(
        local_title(&"界".repeat(60).into()),
        LosslessString::from(format!("{}...", "界".repeat(47)))
    );
    assert_eq!(
        local_title(&"😀".repeat(60).into()),
        LosslessString::from(format!("{}...", "😀".repeat(47)))
    );
}

#[test]
fn helper_settings_use_validated_latest_efficiency_document() {
    use std::{collections::BTreeMap, path::Path};
    use ycoding_core::resources::config::{Configuration, LoadOptions, Roots};
    let config=Configuration::load(LoadOptions { directory: "/tmp/ycoding-authority-helper/project".into(),roots:Roots::development(Path::new("/tmp/ycoding-authority-helper")).unwrap(),project:false,file:None,content:Some(r#"{"efficiency":{"title":"model","helper_models":{"goal":"session","prompt":"session","prediction":"Owner#fixture/selected#high","decision":"Owner#fixture/selected#high","compaction":{"main":"fixture/main"}}}}"#.into()),env:BTreeMap::new() }).unwrap();
    let settings = Settings::from_configuration(&config).unwrap();
    assert_eq!(
        settings.title_mode,
        ycoding_core::tools::policy::helper::TitleMode::Model
    );
    assert_eq!(
        settings.models.get(&Role::Goal),
        Some(&ModelSelection::Session)
    );
    assert_eq!(
        settings.models.get(&Role::Decision),
        Some(&ModelSelection::Model(model("selected")))
    );
    assert_eq!(
        settings.models.get(&Role::Prompt),
        Some(&ModelSelection::Session)
    );
    assert_eq!(
        settings.models.get(&Role::Prediction),
        Some(&ModelSelection::Model(model("selected")))
    );
    assert_eq!(settings.compaction_scopes.len(), 1);
}
