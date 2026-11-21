use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::config::{Configuration, Entry, LoadOptions, Roots};
use ycoding_schema::{
    JsonValue, LosslessString,
    coordination::{RequestKind, Settings},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

const ALL: [RequestKind; 3] = [
    RequestKind::Question,
    RequestKind::Permission,
    RequestKind::Review,
];

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-config-coordination-{}-{}",
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

    fn settings(&self) -> Settings {
        self.config(None).coordination_settings().unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn policy(body: &str) -> String {
    format!(r#"{{"coordination":{{"delegated_decisions":{body}}}}}"#)
}

fn defaults() -> Settings {
    Settings {
        enabled: true,
        categories: ALL.to_vec(),
        actions: None,
        resources: None,
        expires_at: None,
    }
}

fn disabled() -> Settings {
    Settings {
        enabled: false,
        ..defaults()
    }
}

fn strings(values: &[&str]) -> Option<Vec<LosslessString>> {
    Some(values.iter().map(|value| (*value).into()).collect())
}

#[test]
fn absent_or_unrelated_global_configuration_enables_every_category_without_limits() {
    let fixture = Fixture::new();
    assert_eq!(fixture.settings(), defaults());
    for document in [
        "{}",
        r#"{"coordination":{}}"#,
        r#"{"coordination":{"delegated_decisions":{}}}"#,
        r#"{"dots":{"enabled":false}}"#,
    ] {
        fixture.global(Some(document), None);
        assert_eq!(fixture.settings(), defaults(), "{document}");
    }
}

#[test]
fn configured_policy_fields_map_to_settings() {
    let fixture = Fixture::new();
    fixture.global(
        Some(&policy(
            r#"{"enabled":true,"categories":["question","review"],"actions":["read","edit*"],"resources":["src/*"],"expires_at":1800000000000}"#,
        )),
        None,
    );
    let settings = fixture.settings();
    assert!(settings.enabled);
    assert_eq!(
        settings.categories,
        [RequestKind::Question, RequestKind::Review]
    );
    assert_eq!(settings.actions, strings(&["read", "edit*"]));
    assert_eq!(settings.resources, strings(&["src/*"]));
    assert_eq!(
        settings.expires_at.map(|value| value.get()),
        Some(1_800_000_000_000)
    );

    fixture.global(Some(&policy(r#"{"enabled":false}"#)), None);
    assert_eq!(fixture.settings(), disabled());
    fixture.global(Some(&policy(r#"{"categories":[]}"#)), None);
    assert_eq!(
        fixture.settings(),
        Settings {
            categories: Vec::new(),
            ..defaults()
        }
    );
}

#[test]
fn later_global_files_override_earlier_fields_and_keep_the_rest() {
    let fixture = Fixture::new();
    fixture.global(
        Some(&policy(r#"{"enabled":false,"actions":["read"]}"#)),
        Some(&policy(
            r#"{"categories":["question"],"actions":["write"]}"#,
        )),
    );
    assert_eq!(
        fixture.settings(),
        Settings {
            enabled: false,
            categories: vec![RequestKind::Question],
            actions: strings(&["write"]),
            ..defaults()
        }
    );
    fixture.write(
        "global/ycoding/.ycoding/ycoding.json",
        &policy(r#"{"enabled":true}"#),
    );
    assert_eq!(
        fixture.settings(),
        Settings {
            categories: vec![RequestKind::Question],
            actions: strings(&["write"]),
            ..defaults()
        }
    );
}

#[test]
fn project_and_inline_configuration_never_set_the_policy() {
    let fixture = Fixture::new();
    fixture.write("repo/ycoding.json", &policy(r#"{"enabled":false}"#));
    fixture.write(
        "repo/.ycoding/ycoding.json",
        &policy(r#"{"categories":[]}"#),
    );
    let inline = policy(r#"{"enabled":false,"actions":["none"]}"#);
    let config = fixture.config(Some(&inline));
    assert!(
        config
            .entries
            .iter()
            .any(|entry| matches!(entry, Entry::Document { path: None, .. })),
        "inline document is loaded"
    );
    assert_eq!(config.coordination_settings().unwrap(), defaults());

    fixture.global(Some(&policy(r#"{"enabled":false}"#)), None);
    fixture.write("repo/ycoding.json", &policy(r#"{"enabled":true}"#));
    let inline = policy(r#"{"enabled":true}"#);
    assert_eq!(
        fixture
            .config(Some(&inline))
            .coordination_settings()
            .unwrap(),
        disabled()
    );
}

#[test]
fn every_call_rereads_global_files_from_disk() {
    let fixture = Fixture::new();
    let config = fixture.config(None);
    assert_eq!(config.coordination_settings().unwrap(), defaults());
    fixture.global(Some(&policy(r#"{"enabled":false}"#)), None);
    assert_eq!(config.coordination_settings().unwrap(), disabled());
    fixture.global(None, Some(&policy(r#"{"categories":["question"]}"#)));
    assert_eq!(
        config.coordination_settings().unwrap(),
        Settings {
            enabled: false,
            categories: vec![RequestKind::Question],
            ..defaults()
        }
    );
    fixture.global(Some(&policy(r#"{"enabled":"yes"}"#)), None);
    assert!(!config.coordination_settings().unwrap().enabled);
    fixture.global(Some("{"), None);
    assert_eq!(config.coordination_settings().unwrap(), disabled());
    fixture.global(Some("{}"), Some("{}"));
    assert_eq!(config.coordination_settings().unwrap(), defaults());
}

#[test]
fn malformed_policy_disables_delegated_decisions_instead_of_widening_them() {
    let many = format!("[{}]", vec![r#""*""#; 33].join(","));
    let long = format!(r#"["{}"]"#, "a".repeat(513));
    let invalid = [
        r#"{"enabled":1}"#.to_owned(),
        r#"{"enabled":"false"}"#.to_owned(),
        r#"{"enabled":null}"#.to_owned(),
        r#"{"categories":["hard-review"]}"#.to_owned(),
        r#"{"categories":["question","permission","review","question"]}"#.to_owned(),
        r#"{"categories":"question"}"#.to_owned(),
        r#"{"actions":[""]}"#.to_owned(),
        r#"{"actions":[7]}"#.to_owned(),
        format!(r#"{{"resources":{many}}}"#),
        format!(r#"{{"actions":{long}}}"#),
        r#"{"expires_at":-1}"#.to_owned(),
        r#"{"expires_at":1.5}"#.to_owned(),
        r#"{"expires_at":"10"}"#.to_owned(),
        r#"{"unknown":true}"#.to_owned(),
        r#"{"enabled":true,"expiresAt":10}"#.to_owned(),
        "null".to_owned(),
        "[]".to_owned(),
    ];
    for delegated_decisions in &invalid {
        let fixture = Fixture::new();
        fixture.global(Some(&policy(delegated_decisions)), None);
        assert_eq!(fixture.settings(), disabled(), "{delegated_decisions}");
    }
    for coordination in [
        "null",
        "true",
        "[]",
        r#"{"unknown":true}"#,
        r#"{"delegated_decisions":{"enabled":true},"extra":1}"#,
    ] {
        let fixture = Fixture::new();
        fixture.global(Some(&format!(r#"{{"coordination":{coordination}}}"#)), None);
        assert_eq!(fixture.settings(), disabled(), "{coordination}");
    }
}

#[test]
fn malformed_policy_is_reported_fail_closed_and_loaded_as_disabled() {
    let fixture = Fixture::new();
    fixture.global(
        Some(&policy(r#"{"enabled":true,"categories":["hard-review"]}"#)),
        None,
    );
    let config = fixture.config(None);
    let diagnostic = config
        .diagnostics
        .iter()
        .find(|diagnostic| {
            diagnostic
                .json_path
                .as_ref()
                .and_then(LosslessString::as_str)
                == Some("$.coordination")
        })
        .expect("coordination diagnostic");
    assert_eq!(diagnostic.reason.0.as_str(), Some("invalid-values"));
    assert_eq!(diagnostic.fail_closed, Some(true));
    let loaded = config
        .latest("coordination")
        .expect("repaired coordination");
    let JsonValue::Object(loaded) = loaded else {
        panic!("coordination is an object")
    };
    let Some(JsonValue::Object(decisions)) = loaded.get(&"delegated_decisions".into()) else {
        panic!("delegated decisions are an object")
    };
    assert_eq!(
        decisions.get(&"enabled".into()),
        Some(&JsonValue::Bool(false))
    );
    assert_eq!(decisions.len(), 1);
}
