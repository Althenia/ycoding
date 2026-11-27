use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_core::resources::config::{
    Configuration, LoadOptions, Mutation, MutationPolicy, Roots, Scope,
};
use ycoding_core::session::autonomy::{DecisionMode, Defaults, DefaultsChange, Refusal};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-autonomy-defaults-{}-{}",
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

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.0.join(path)).unwrap()
    }

    fn config(&self, project: Option<&str>) -> Configuration {
        let path = |name: &str| self.0.join(name).to_str().unwrap().to_owned();
        if let Some(text) = project {
            self.write("repo/ycoding.json", text);
        }
        Configuration::load(LoadOptions {
            directory: self.0.join("repo"),
            roots: Roots::runtime(
                &self.0.join("home"),
                &self.0.join("temp"),
                &BTreeMap::from([
                    ("XDG_CONFIG_HOME".into(), path("global")),
                    ("XDG_DATA_HOME".into(), path("data")),
                    ("XDG_CACHE_HOME".into(), path("cache")),
                    ("XDG_STATE_HOME".into(), path("state")),
                ]),
            )
            .unwrap(),
            project: true,
            file: None,
            content: None,
            env: BTreeMap::new(),
        })
        .unwrap()
        .with_mutation_policy(MutationPolicy(Arc::new(|mutation| {
            matches!(mutation, Mutation::Configuration(target) if target.scope == Scope::Global)
        })))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const GLOBAL: &str = "global/ycoding/ycoding.json";

fn change(
    permissions: Option<DecisionMode>,
    guardrails: Option<DecisionMode>,
    answers: Option<DecisionMode>,
    accept_yolo: bool,
) -> DefaultsChange {
    DefaultsChange {
        permissions,
        guardrails,
        answers,
        accept_yolo,
    }
}

#[test]
fn unset_defaults_are_manual_and_project_files_never_set_them() {
    let fixture = Fixture::new();
    let defaults = fixture
        .config(Some(
            r#"{"autonomy":{"defaults":{"permissions":"auto","yolo_accepted_at":{}}}}"#,
        ))
        .autonomy_defaults()
        .unwrap();
    assert_eq!(defaults, Defaults::default());
    assert_eq!(defaults.initial_decisions(), None);
}

#[test]
fn a_yolo_default_without_a_recorded_acceptance_reads_as_manual() {
    let fixture = Fixture::new();
    fixture.write(
        GLOBAL,
        r#"{"autonomy":{"defaults":{"permissions":"yolo","guardrails":"auto","answers":"yolo","yolo_accepted_at":{"answers":1790000000000}}}}"#,
    );
    let defaults = fixture.config(None).autonomy_defaults().unwrap();
    assert_eq!(defaults.permissions, DecisionMode::Manual);
    assert_eq!(defaults.guardrails, DecisionMode::Auto);
    assert_eq!(defaults.answers, DecisionMode::Yolo);
    assert_eq!(defaults.yolo_accepted_at.answers, Some(1790000000000));
    assert_eq!(defaults.yolo_accepted_at.permissions, None);
}

#[test]
fn saving_yolo_without_acceptance_is_refused_and_writes_nothing() {
    let fixture = Fixture::new();
    let original = r#"{"plugins":[]}"#;
    fixture.write(GLOBAL, original);
    let refused = fixture
        .config(None)
        .write_autonomy_defaults(change(Some(DecisionMode::Yolo), None, None, false), 5)
        .unwrap();
    assert_eq!(refused, Err(Refusal::RiskNotAccepted));
    assert_eq!(fixture.read(GLOBAL), original);
    let empty = fixture
        .config(None)
        .write_autonomy_defaults(change(None, None, None, true), 5)
        .unwrap();
    assert_eq!(empty, Err(Refusal::NoCategory));
    assert_eq!(fixture.read(GLOBAL), original);
}

#[test]
fn saving_yolo_with_acceptance_records_it_beside_the_default_and_keeps_comments() {
    let fixture = Fixture::new();
    fixture.write(GLOBAL, "{\n  // keep me\n  \"plugins\": []\n}\n");
    let saved = fixture
        .config(None)
        .write_autonomy_defaults(
            change(
                Some(DecisionMode::Yolo),
                Some(DecisionMode::Auto),
                None,
                true,
            ),
            1790000000000,
        )
        .unwrap()
        .unwrap();
    assert_eq!(saved.permissions, DecisionMode::Yolo);
    assert_eq!(saved.guardrails, DecisionMode::Auto);
    assert_eq!(saved.answers, DecisionMode::Manual);
    assert_eq!(saved.yolo_accepted_at.permissions, Some(1790000000000));
    assert_eq!(saved.yolo_accepted_at.guardrails, None);
    let text = fixture.read(GLOBAL);
    assert!(text.contains("// keep me"), "{text}");
    assert!(text.contains("\"yolo_accepted_at\""), "{text}");
    assert_eq!(fixture.config(None).autonomy_defaults().unwrap(), saved);
}

#[test]
fn an_accepted_yolo_default_stays_accepted_and_reset_to_manual_drops_the_acceptance() {
    let fixture = Fixture::new();
    fixture.write(GLOBAL, "{}");
    let config = fixture.config(None);
    config
        .write_autonomy_defaults(change(None, None, Some(DecisionMode::Yolo), true), 10)
        .unwrap()
        .unwrap();
    let kept = config
        .write_autonomy_defaults(
            change(
                Some(DecisionMode::Auto),
                None,
                Some(DecisionMode::Yolo),
                false,
            ),
            20,
        )
        .unwrap()
        .unwrap();
    assert_eq!(kept.answers, DecisionMode::Yolo);
    assert_eq!(kept.yolo_accepted_at.answers, Some(10));
    let reset = config
        .write_autonomy_defaults(change(None, None, Some(DecisionMode::Manual), false), 30)
        .unwrap()
        .unwrap();
    assert_eq!(reset.answers, DecisionMode::Manual);
    assert_eq!(reset.permissions, DecisionMode::Auto);
    assert_eq!(reset.yolo_accepted_at.answers, None);
    assert!(!fixture.read(GLOBAL).contains("yolo_accepted_at"));
}

#[test]
fn only_nonmanual_defaults_produce_initial_decisions() {
    let defaults = Defaults::default()
        .apply(change(Some(DecisionMode::Auto), None, None, false), 1)
        .unwrap();
    assert!(defaults.initial_decisions().is_some());
    assert!(Defaults::default().initial_decisions().is_none());
}
