use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::config::{
    Configuration, FullAccessExecutorBinding, LoadOptions, Roots,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

const WORK: &str = r#"{"dots":{"enabled":true,"profile":"work"}}"#;
const DISABLED: &str = r#"{"dots":{"enabled":false}}"#;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-config-dots-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("repo")).unwrap();
        Self(root)
    }

    fn write(&self, path: &str, text: &str) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn global(&self, json: Option<&str>, jsonc: Option<&str>) {
        if let Some(text) = json {
            self.write("global/ycoding/ycoding.json", text);
        }
        if let Some(text) = jsonc {
            self.write("global/ycoding/ycoding.jsonc", text);
        }
    }

    fn config(&self, content: Option<&str>) -> Configuration {
        Configuration::load(LoadOptions {
            directory: self.0.join("repo"),
            roots: Roots::runtime(
                &self.0.join("home"),
                &self.0.join("temp"),
                &BTreeMap::from([
                    (
                        "XDG_CONFIG_HOME".into(),
                        self.0.join("global").to_str().unwrap().into(),
                    ),
                    (
                        "XDG_DATA_HOME".into(),
                        self.0.join("data").to_str().unwrap().into(),
                    ),
                    (
                        "XDG_CACHE_HOME".into(),
                        self.0.join("cache").to_str().unwrap().into(),
                    ),
                    (
                        "XDG_STATE_HOME".into(),
                        self.0.join("state").to_str().unwrap().into(),
                    ),
                ]),
            )
            .unwrap(),
            project: true,
            file: None,
            content: content.map(str::to_owned),
            env: BTreeMap::new(),
        })
        .unwrap()
    }

    fn profile(&self) -> Option<String> {
        self.config(None).native_dots_profile().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn review_expiry_and_goal_stall_settings_default_and_merge_independently() {
    let fixture = Fixture::new();
    let config = fixture.config(None);
    assert_eq!(config.hard_review_expiry_minutes(), 1440);
    assert_eq!(config.stall_timeout_seconds(), 600);
    fixture.global(Some(r#"{"guardrails":{"hard_review_expiry_minutes":15},"goal":{"stall_timeout_seconds":45}}"#),Some(r#"{"guardrails":{"max_pending_reviews":8},"goal":{"stall_timeout_seconds":90}}"#));
    let config = fixture.config(None);
    assert_eq!(config.hard_review_expiry_minutes(), 15);
    assert_eq!(config.stall_timeout_seconds(), 90);
    let config = fixture.config(Some(r#"{"guardrails":{"hard_review_expiry_minutes":30}}"#));
    assert_eq!(config.hard_review_expiry_minutes(), 30);
    assert_eq!(config.stall_timeout_seconds(), 90);
}

#[test]
fn dots_need_an_enabled_flag_and_a_profile_in_the_last_trusted_global_file_naming_them() {
    let cases = &[
        ("no global file", None, None, None),
        ("empty document", Some("{}"), None, None),
        ("empty dots section", Some(r#"{"dots":{}}"#), None, None),
        ("disabled", Some(DISABLED), None, None),
        (
            "disabled with a profile",
            Some(r#"{"dots":{"enabled":false,"profile":"work"}}"#),
            None,
            None,
        ),
        (
            "profile without enabling",
            Some(r#"{"dots":{"profile":"work"}}"#),
            None,
            None,
        ),
        ("enabled with a profile", Some(WORK), None, Some("work")),
        (
            "enabled without a profile",
            Some(r#"{"dots":{"enabled":true}}"#),
            None,
            None,
        ),
        (
            "enabled with an empty profile",
            Some(r#"{"dots":{"enabled":true,"profile":""}}"#),
            None,
            None,
        ),
        (
            "enabled with a non-string profile",
            Some(r#"{"dots":{"enabled":true,"profile":7}}"#),
            None,
            None,
        ),
        (
            "string enabled flag",
            Some(r#"{"dots":{"enabled":"true","profile":"work"}}"#),
            None,
            None,
        ),
        (
            "non-object dots section",
            Some(r#"{"dots":true}"#),
            None,
            None,
        ),
        ("later file disables", Some(WORK), Some(DISABLED), None),
        (
            "later file enables",
            Some(DISABLED),
            Some(r#"{"dots":{"enabled":true,"profile":"later"}}"#),
            Some("later"),
        ),
        (
            "later file without dots",
            Some(WORK),
            Some("{}"),
            Some("work"),
        ),
        (
            "later empty dots section replaces the enabled one",
            Some(WORK),
            Some(r#"{"dots":{}}"#),
            None,
        ),
        (
            "later empty dots section after disabled",
            Some(DISABLED),
            Some(r#"{"dots":{}}"#),
            None,
        ),
        (
            "later file with other capabilities only",
            Some(WORK),
            Some(r#"{"capabilities":{"tools":{"enabled":false}}}"#),
            Some("work"),
        ),
        (
            "later string enabled flag replaces the enabled one",
            Some(WORK),
            Some(r#"{"dots":{"enabled":"false"}}"#),
            None,
        ),
    ];
    for (label, json, jsonc, expected) in cases {
        let fixture = Fixture::new();
        fixture.global(*json, *jsonc);
        assert_eq!(fixture.profile().as_deref(), *expected, "{label}");
    }
}

#[test]
fn only_the_trusted_global_top_level_dots_section_can_enable_dots() {
    for document in [
        r#"{"capabilities":{"dots":true}}"#,
        r#"{"capabilities":{"dots":{"enabled":true}}}"#,
        r#"{"capabilities":{"tools":{"allow":["dots_send"]}}}"#,
        r#"{"capabilities":{"plugins":{"enabled":true},"mcp":{"allow":["dots"]}}}"#,
    ] {
        let fixture = Fixture::new();
        fixture.global(Some(document), None);
        assert_eq!(fixture.profile(), None, "{document}");
        fixture.global(None, Some(DISABLED));
        assert_eq!(fixture.profile(), None, "{document}");
    }

    let fixture = Fixture::new();
    fixture.global(
        Some(
            r#"{"capabilities":{"tools":{"deny":["edit"]},"home_roots":false},"dots":{"enabled":true,"profile":"work"}}"#,
        ),
        None,
    );
    let other = fixture.config(None);
    assert_eq!(
        other.native_dots_profile().unwrap().as_deref(),
        Some("work")
    );
    assert_eq!(other.capabilities.tools.deny, Some(vec!["edit".into()]));
    assert_eq!(other.capabilities.home_roots, Some(false));

    let project_enabled = r#"{"dots":{"enabled":true,"profile":"project"}}"#;
    let inline_enabled = r#"{"dots":{"enabled":true,"profile":"inline"}}"#;

    let fixture = Fixture::new();
    fixture.write("repo/ycoding.json", project_enabled);
    assert_eq!(fixture.profile(), None, "a project file never enables Dots");

    let fixture = Fixture::new();
    fixture.global(Some(WORK), None);
    fixture.write("repo/ycoding.json", project_enabled);
    assert_eq!(
        fixture.profile().as_deref(),
        Some("work"),
        "a project profile never replaces the trusted one"
    );
    fixture.write("repo/ycoding.json", DISABLED);
    assert_eq!(
        fixture.profile().as_deref(),
        Some("work"),
        "a project file never disables trusted Dots"
    );

    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .config(Some(inline_enabled))
            .native_dots_profile()
            .unwrap(),
        None,
        "inline configuration never enables Dots"
    );
    fixture.global(Some(WORK), None);
    assert_eq!(
        fixture
            .config(Some(inline_enabled))
            .native_dots_profile()
            .unwrap()
            .as_deref(),
        Some("work"),
        "inline configuration never replaces the trusted profile"
    );

    let fixture = Fixture::new();
    fixture.global(
        Some(r#"{"dots":{"enabled":true,"profile":"first"}}"#),
        Some(r#"{"dots":{"enabled":true,"profile":"second"}}"#),
    );
    fixture.write("repo/ycoding.json", DISABLED);
    assert_eq!(
        fixture.profile().as_deref(),
        Some("second"),
        "a project layer between two trusted layers changes nothing"
    );
}

#[test]
fn dots_name_is_the_last_trusted_global_label_and_stays_apart_from_the_selection() {
    let name = |config: &Configuration| {
        config
            .native_dots_name()
            .unwrap()
            .map(|name| name.to_utf8().unwrap())
    };
    let fixture = Fixture::new();
    fixture.global(
        Some(r#"{"dots":{"enabled":true,"profile":"work","name":"Work Laptop"}}"#),
        None,
    );
    let config = fixture.config(None);
    assert_eq!(
        config.native_dots_profile().unwrap().as_deref(),
        Some("work")
    );
    assert_eq!(name(&config).as_deref(), Some("Work Laptop"));

    fixture.global(
        None,
        Some(r#"{"dots":{"enabled":true,"profile":"work","name":"Later"}}"#),
    );
    assert_eq!(name(&fixture.config(None)).as_deref(), Some("Later"));

    fixture.global(Some(WORK), Some(WORK));
    assert_eq!(name(&fixture.config(None)), None);

    let fixture = Fixture::new();
    fixture.global(Some(r#"{"dots":{"name":"Disabled Label"}}"#), None);
    let config = fixture.config(None);
    assert_eq!(config.native_dots_profile().unwrap(), None);
    assert_eq!(name(&config).as_deref(), Some("Disabled Label"));

    let fixture = Fixture::new();
    fixture.write(
        "repo/ycoding.json",
        r#"{"dots":{"enabled":true,"profile":"work","name":"Project Label"}}"#,
    );
    assert_eq!(
        name(&fixture.config(None)),
        None,
        "a project file never names the computer"
    );
    assert_eq!(
        name(&fixture.config(Some(r#"{"dots":{"name":"Inline Label"}}"#))),
        None,
        "inline configuration never names the computer"
    );
}

#[test]
fn dots_name_accepts_one_to_one_hundred_printable_ascii_units_without_edge_spaces() {
    let longest = "x".repeat(100);
    let inner = format!("a{}b", " ".repeat(98));
    for (name, valid) in [
        ("a".to_owned(), true),
        ("A b-c (1)".to_owned(), true),
        (longest, true),
        (inner, true),
        (String::new(), false),
        (" lead".to_owned(), false),
        ("trail ".to_owned(), false),
        (" ".to_owned(), false),
        ("caf\u{00e9}".to_owned(), false),
        ("tab\\there".to_owned(), false),
        ("x".repeat(101), false),
    ] {
        let fixture = Fixture::new();
        fixture.global(
            Some(&format!(
                r#"{{"dots":{{"enabled":true,"profile":"work","name":"{name}"}}}}"#
            )),
            None,
        );
        let config = fixture.config(None);
        let selected = config
            .native_dots_name()
            .unwrap()
            .map(|name| name.to_utf8().unwrap());
        let profile = config.native_dots_profile().unwrap();
        if valid {
            assert_eq!(selected.as_deref(), Some(name.as_str()), "{name:?}");
            assert_eq!(profile.as_deref(), Some("work"), "{name:?}");
        } else {
            assert_eq!((selected, profile), (None, None), "{name:?}");
        }
    }
}

#[test]
fn full_access_executor_is_trusted_exact_and_source_attributed() {
    let fixture = Fixture::new();
    let expected = fixture.0.join("global/ycoding/ycoding.json");
    assert_eq!(
        fixture
            .config(None)
            .native_dots_full_access_executor()
            .unwrap(),
        (expected.clone(), None)
    );
    let hash = "a".repeat(64);
    let binding = format!(
        r#"{{"dots":{{"fullAccessExecutor":{{"environmentId":"env-1","harnessKeySha256":"{hash}"}}}}}}"#
    );
    fixture.global(Some(&binding), None);
    assert_eq!(
        fixture
            .config(Some(r#"{"dots":{}}"#))
            .native_dots_full_access_executor()
            .unwrap(),
        (
            expected.clone(),
            Some(FullAccessExecutorBinding {
                environment_id: "env-1".into(),
                harness_key_sha256: hash.clone(),
            })
        )
    );
    fixture.global(None, Some(r#"{"dots":{}}"#));
    assert_eq!(
        fixture
            .config(None)
            .native_dots_full_access_executor()
            .unwrap(),
        (expected.with_file_name("ycoding.jsonc"), None)
    );
    fixture.global(
        None,
        Some(r#"{"dots":{"enabled":true,"profile":"work","name":"Desk","fullAccessExecutor":{"environmentId":"*","harnessKeySha256":"bad"}}}"#),
    );
    let config = fixture.config(None);
    assert_eq!(
        config.native_dots_profile().unwrap().as_deref(),
        Some("work")
    );
    assert_eq!(
        config.native_dots_name().unwrap().unwrap().as_str(),
        Some("Desk")
    );
    let error = config.native_dots_full_access_executor().unwrap_err();
    assert_eq!(
        error.source_path(),
        Some(fixture.0.join("global/ycoding/ycoding.jsonc").as_path())
    );
    fixture.global(
        Some(r#"{"dots":{"fullAccessExecutor":{"environmentId":"*","harnessKeySha256":"bad"}}}"#),
        Some(&binding),
    );
    assert_eq!(
        fixture
            .config(None)
            .native_dots_full_access_executor()
            .unwrap(),
        (
            expected.with_file_name("ycoding.jsonc"),
            Some(FullAccessExecutorBinding {
                environment_id: "env-1".into(),
                harness_key_sha256: hash,
            })
        )
    );
}
