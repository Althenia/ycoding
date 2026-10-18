use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::config::capabilities::{ConfigCapabilities, WebsearchProvider};
use ycoding_core::resources::config::{
    Configuration, Entry, LoadOptions, MissingFile, ParseSource, Roots, substitute,
};
use ycoding_schema::{JsonValue, parse_json};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-config-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn write(&self, path: &str, text: &str) -> PathBuf {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }

    fn options(&self, directory: &str) -> LoadOptions {
        LoadOptions {
            directory: self.0.join(directory),
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
            content: None,
            env: BTreeMap::new(),
        }
    }

    fn is_fixture_directory(&self, path: &Path) -> bool {
        if path.starts_with(&self.0) {
            return true;
        }
        // Runtime discovery also visits directories above the isolated fixture.
        assert!(
            path.file_name().is_some_and(|name| {
                name == ".ycoding" || name == ".claude" || name == ".agents"
            }) && path.parent().is_some_and(|parent| {
                self.0
                    .ancestors()
                    .skip(1)
                    .any(|ancestor| ancestor == parent)
            }),
            "unexpected non-ancestor discovery: {}",
            path.display()
        );
        false
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn resolved_sources_validate_and_failed_reload_preserves_prior_sources_and_entries() {
    use ycoding_core::resources::config::Source;
    let fixture = Fixture::new();
    fixture.write("project/ycoding.json", r#"{"username":"project"}"#);
    let source = Source {
        origin: "https://config.example.test".into(),
        info: parse_json(
            r#"{"username":"resolved","capabilities":{"tools":{"enabled":false}},"unknown":true}"#,
        )
        .unwrap(),
    };
    let mut config =
        Configuration::load_with_sources(fixture.options("project"), vec![source]).unwrap();
    assert_eq!(
        config.latest("username"),
        Some(&parse_json(r#""resolved""#).unwrap())
    );
    assert_eq!(config.diagnostics.len(), 1);
    assert_eq!(
        config.diagnostics[0].path,
        "https://config.example.test".into()
    );
    assert!(!config.capabilities.allows_tool(&"read".into()));
    let entries = config.entries.clone();
    let failed = config.reload_with_sources(vec![Source {
        origin: "https://config.example.test".into(),
        info: parse_json(r#"{"username":"{file:missing}"}"#).unwrap(),
    }]);
    assert!(failed.is_err());
    assert_eq!(config.entries, entries);
    assert_eq!(config.snapshot().unwrap().entries, entries);
    config.reload_with_sources(Vec::new()).unwrap();
    assert_eq!(
        config.latest("username"),
        Some(&parse_json(r#""project""#).unwrap())
    );
    assert!(config.capabilities.allows_tool(&"read".into()));
    assert!(config.diagnostics.is_empty());
}

fn strings(config: &Configuration, key: &str) -> Vec<String> {
    config
        .entries
        .iter()
        .filter_map(|entry| {
            let Entry::Document {
                info: JsonValue::Object(info),
                ..
            } = entry
            else {
                return None;
            };
            let Some(JsonValue::String(value)) = info.get(&key.into()) else {
                return None;
            };
            Some(value.to_utf8().unwrap())
        })
        .collect()
}

#[test]
fn ordered_discovery_crosses_repository_boundary_and_keeps_ecosystem_sources() {
    let fixture = Fixture::new();
    for (path, name) in [
        ("global/ycoding/ycoding.json", "global-json"),
        ("global/ycoding/ycoding.jsonc", "global-jsonc"),
        ("custom.json", "explicit"),
        ("ycoding.json", "outside"),
        ("repository/ycoding.json", "root-json"),
        ("repository/ycoding.jsonc", "root-jsonc"),
        ("repository/parent/ycoding.jsonc", "parent"),
        ("repository/parent/project/ycoding.json", "directory"),
        ("repository/.ycoding/ycoding.json", "root-dot"),
        (
            "repository/parent/project/.ycoding/ycoding.jsonc",
            "directory-dot",
        ),
    ] {
        fixture.write(path, &format!(r#"{{"$schema":"{name}"}}"#));
    }
    for directory in [
        "home/.claude",
        "home/.agents",
        "repository/.claude",
        "repository/.agents",
        "repository/parent/project/.claude",
        "repository/parent/project/.agents",
        "repository/.git",
    ] {
        fs::create_dir_all(fixture.0.join(directory)).unwrap();
    }
    let mut options = fixture.options("repository/parent/project");
    options.file = Some(fixture.0.join("custom.json"));
    options.content = Some(r#"{"$schema":"content"}"#.into());
    let config = Configuration::load(options).unwrap();
    assert_eq!(
        strings(&config, "$schema"),
        [
            "global-json",
            "global-jsonc",
            "explicit",
            "outside",
            "root-json",
            "root-jsonc",
            "parent",
            "directory",
            "root-dot",
            "directory-dot",
            "content"
        ]
    );
    assert_eq!(
        config.latest("$schema"),
        Some(&JsonValue::String("content".into()))
    );
    let directories = config
        .entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::Directory(path) if fixture.is_fixture_directory(path) => Some(path.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        directories,
        [
            fixture.0.join("global/ycoding"),
            fixture.0.join("repository/.ycoding"),
            fixture.0.join("repository/parent/project/.ycoding")
        ]
    );
    let claude = config
        .entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::ClaudeDirectory(path) if fixture.is_fixture_directory(path) => {
                Some(path.clone())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        claude,
        [
            fixture.0.join("home/.claude"),
            fixture.0.join("repository/parent/project/.claude"),
            fixture.0.join("repository/.claude")
        ]
    );
    let agents = config
        .entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::AgentsDirectory(path) if fixture.is_fixture_directory(path) => {
                Some(path.clone())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        agents,
        [
            fixture.0.join("home/.agents"),
            fixture.0.join("repository/parent/project/.agents"),
            fixture.0.join("repository/.agents")
        ]
    );
    assert!(matches!(&config.entries[0], Entry::ClaudeDirectory(_)));
    assert!(config.diagnostics.is_empty());
}

#[test]
fn project_opt_out_global_location_missing_files_and_legacy_names() {
    let fixture = Fixture::new();
    fixture.write("global/ycoding/ycoding.json", r#"{"shell":"global"}"#);
    fixture.write("home/.agents/agent.md", "unused");
    fixture.write("project/ycoding.json", r#"{"shell":"project"}"#);
    fixture.write("project/config.json", r#"{"shell":"legacy"}"#);
    let mut options = fixture.options("project");
    options.project = false;
    let config = Configuration::load(options).unwrap();
    assert_eq!(strings(&config, "shell"), ["global"]);
    assert!(
        config
            .entries
            .iter()
            .any(|entry| matches!(entry, Entry::AgentsDirectory(_)))
    );
    let config = Configuration::load(fixture.options("global/ycoding")).unwrap();
    assert_eq!(strings(&config, "shell"), ["global"]);
    let mut options = fixture.options("project");
    options.project = false;
    options.file = Some(fixture.0.join("does-not-exist.json"));
    let config = Configuration::load(options).unwrap();
    assert!(
        config.entries.iter().any(
            |entry| matches!(entry, Entry::File(path) if path.ends_with("does-not-exist.json"))
        )
    );
}

#[test]
fn home_roots_false_excludes_exact_home_roots_even_from_ancestors() {
    let fixture = Fixture::new();
    let global = fixture.write(
        "global/ycoding/ycoding.json",
        r#"{"shell":"global","capabilities":{"home_roots":false}}"#,
    );
    for directory in [
        "home/.claude",
        "home/.agents",
        "home/repo/.claude",
        "home/repo/.agents",
        "home/repo/app/.agents",
    ] {
        fs::create_dir_all(fixture.0.join(directory)).unwrap();
    }
    let ecosystem = |config: &Configuration| {
        config
            .entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::AgentsDirectory(path) | Entry::ClaudeDirectory(path)
                    if fixture.is_fixture_directory(path) =>
                {
                    Some(path.clone())
                }
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let mut options = fixture.options("home/repo/app");
    options.roots.home = fixture.0.join("home/repo/..");
    let mut config = Configuration::load(options).unwrap();
    assert_eq!(
        ecosystem(&config),
        [
            fixture.0.join("home/repo/.claude"),
            fixture.0.join("home/repo/app/.agents"),
            fixture.0.join("home/repo/.agents"),
        ]
    );
    assert_eq!(strings(&config, "shell"), ["global"]);
    assert!(config.diagnostics.is_empty());
    assert_eq!(
        fs::read_to_string(&global).unwrap(),
        r#"{"shell":"global","capabilities":{"home_roots":false}}"#
    );
    fixture.write(
        "home/repo/app/ycoding.json",
        r#"{"capabilities":{"home_roots":true}}"#,
    );
    config.reload().unwrap();
    assert_eq!(ecosystem(&config).len(), 7);
    assert_eq!(strings(&config, "shell"), ["global"]);
    fs::write(&global, r#"{"shell":"global"}"#).unwrap();
    fs::write(
        fixture.0.join("home/repo/app/ycoding.json"),
        r#"{"capabilities":{"home_roots":false}}"#,
    )
    .unwrap();
    config.reload().unwrap();
    assert_eq!(ecosystem(&config).len(), 3);
}

#[test]
fn latest_is_a_whole_defined_field_and_ordered_documents_preserve_merge_inputs() {
    let fixture = Fixture::new();
    fixture.write("global/ycoding/ycoding.json", r#"{"shell":"global","providers":{"base":{"name":"base"}},"permissions":[{"action":"read","resource":"*","effect":"ask"}]}"#);
    fixture.write("project/ycoding.json", r#"{"providers":{"last":{"name":"last"}},"permissions":[{"action":"edit","resource":"*","effect":"allow"}]}"#);
    let config = Configuration::load(fixture.options("project")).unwrap();
    assert_eq!(
        config.latest("shell"),
        Some(&JsonValue::String("global".into()))
    );
    assert_eq!(config.latest("default_agent"), None);
    assert_eq!(
        config.latest("providers"),
        Some(&parse_json(r#"{"last":{"name":"last"}}"#).unwrap())
    );
    assert_eq!(
        config.values("permissions").collect::<Vec<_>>(),
        [
            &parse_json(r#"[{"action":"read","resource":"*","effect":"ask"}]"#).unwrap(),
            &parse_json(r#"[{"action":"edit","resource":"*","effect":"allow"}]"#).unwrap()
        ]
    );
    assert_eq!(config.values("providers").count(), 2);
}

#[test]
fn capabilities_merge_each_leaf_and_replace_lists() {
    let fixture = Fixture::new();
    fixture.write(
        "global/ycoding/ycoding.json",
        r#"{"capabilities":{"instructions":{"global":false,"project":true,"exclude":["global"]},"builtin_instructions":{"enabled":false,"allow":["date"],"deny":["memory"]},"skills":{"enabled":false,"allow":["global"],"deny":["private"]},"tools":{"deny":["shell"],"allow":["shell"]},"mcp":{"enabled":false,"allow":["global"],"deny":["private"]},"plugins":{"enabled":false,"allow":["global"],"deny":["private"]},"home_roots":false,"project_artifacts":false,"websearch_provider":"exa"}}"#,
    );
    fixture.write(
        "explicit.json",
        r#"{"capabilities":{"instructions":{"exclude":["explicit"]},"skills":{"allow":["explicit"]},"tools":{"allow":["explicit"]},"plugins":{"allow":[]}}}"#,
    );
    fixture.write(
        "repo/ycoding.json",
        r#"{"capabilities":{"instructions":{"project":false},"builtin_instructions":{"enabled":true,"allow":["environment","date"]},"skills":{"allow":["project"]},"mcp":{"allow":["project"]}}}"#,
    );
    fixture.write(
        "repo/app/.ycoding/ycoding.json",
        r#"{"capabilities":{"tools":{"enabled":false},"plugins":{"deny":[]}}}"#,
    );
    fixture.write(
        "repo/app/.agents/ycoding.json",
        r#"{"capabilities":{"home_roots":true,"tools":{"deny":["*"]}}}"#,
    );
    let mut options = fixture.options("repo/app");
    options.file = Some(fixture.0.join("explicit.json"));
    options.content = Some(r#"{"capabilities":{"instructions":{"global":true,"exclude":[]},"skills":{"enabled":true},"tools":{"enabled":true,"allow":["read"]},"mcp":{"deny":[]},"websearch_provider":"parallel"}}"#.into());
    let mut config = Configuration::load(options).unwrap();
    assert!(config.diagnostics.is_empty());
    assert_eq!(config.values("capabilities").count(), 5);
    assert_eq!(config.capabilities.instructions.global, Some(true));
    assert_eq!(config.capabilities.instructions.project, Some(false));
    assert_eq!(config.capabilities.instructions.exclude, Some(vec![]));
    assert_eq!(config.capabilities.builtin_instructions.enabled, Some(true));
    assert_eq!(
        config.capabilities.builtin_instructions.allow,
        Some(vec!["environment".into(), "date".into()])
    );
    assert_eq!(
        config.capabilities.builtin_instructions.deny,
        Some(vec!["memory".into()])
    );
    assert_eq!(config.capabilities.skills.enabled, Some(true));
    assert_eq!(
        config.capabilities.skills.allow,
        Some(vec!["project".into()])
    );
    assert_eq!(
        config.capabilities.skills.deny,
        Some(vec!["private".into()])
    );
    assert_eq!(config.capabilities.tools.enabled, Some(true));
    assert_eq!(config.capabilities.tools.allow, Some(vec!["read".into()]));
    assert_eq!(config.capabilities.tools.deny, Some(vec!["shell".into()]));
    assert_eq!(config.capabilities.mcp.enabled, Some(false));
    assert_eq!(config.capabilities.mcp.allow, Some(vec!["project".into()]));
    assert_eq!(config.capabilities.mcp.deny, Some(vec![]));
    assert_eq!(config.capabilities.plugins.enabled, Some(false));
    assert_eq!(config.capabilities.plugins.allow, Some(vec![]));
    assert_eq!(config.capabilities.plugins.deny, Some(vec![]));
    assert_eq!(config.capabilities.home_roots, Some(false));
    assert_eq!(config.capabilities.project_artifacts, Some(false));
    assert_eq!(
        config.capabilities.websearch_provider,
        Some(WebsearchProvider::Parallel)
    );
    assert_eq!(
        ConfigCapabilities::resolve(&config.entries),
        config.capabilities
    );
    fixture.write(
        "global/ycoding/ycoding.json",
        r#"{"capabilities":{"tools":{"deny":["edit"]},"websearch_provider":"exa"}}"#,
    );
    config.reload().unwrap();
    assert_eq!(config.capabilities.tools.deny, Some(vec!["edit".into()]));
    assert_eq!(config.capabilities.tools.allow, Some(vec!["read".into()]));
    assert_eq!(config.capabilities.home_roots, None);
    assert_eq!(config.capabilities.project_artifacts, None);
    assert_eq!(config.capabilities.plugins.enabled, None);
    assert_eq!(
        config.capabilities.websearch_provider,
        Some(WebsearchProvider::Parallel)
    );
}

#[test]
fn absent_capabilities_are_permissive_and_failed_reload_preserves_policy() {
    let fixture = Fixture::new();
    let source = fixture.write("project/ycoding.json", r#"{"shell":"kept"}"#);
    let mut config = Configuration::load(fixture.options("project")).unwrap();
    assert_eq!(config.capabilities, ConfigCapabilities::default());
    for selection in [
        &config.capabilities.builtin_instructions,
        &config.capabilities.skills,
        &config.capabilities.tools,
        &config.capabilities.mcp,
        &config.capabilities.plugins,
    ] {
        assert!(selection.allows(&"anything".into()));
    }
    assert!(config.capabilities.allows_tool(&"skill".into()));
    assert!(config.capabilities.allows_tool(&"project_artifact".into()));
    fs::write(&source, r#"{"capabilities":{"tools":{"enabled":false}}}"#).unwrap();
    config.reload().unwrap();
    assert_eq!(config.capabilities.tools.enabled, Some(false));
    fs::write(
        &source,
        r#"{"username":"{file:missing.txt}","capabilities":{"tools":{"enabled":true}}}"#,
    )
    .unwrap();
    assert!(config.reload().is_err());
    assert_eq!(config.capabilities.tools.enabled, Some(false));
    assert!(!config.capabilities.allows_tool(&"read".into()));
}

#[test]
fn snapshot_reloads_new_files_and_replaces_diagnostics_without_writing_sources() {
    let fixture = Fixture::new();
    let source = fixture.write(
        "project/ycoding.json",
        r#"{"snapshot":false,"shell":"first"}"#,
    );
    let invalid = fixture.write("project/ycoding.jsonc", "{ invalid");
    let mut config = Configuration::load(fixture.options("project")).unwrap();
    assert_eq!(config.diagnostics.len(), 2);
    fs::write(&invalid, r#"{"shell":"second"}"#).unwrap();
    assert_eq!(
        config.latest("shell"),
        Some(&JsonValue::String("first".into()))
    );
    config.reload().unwrap();
    assert_eq!(
        config.latest("shell"),
        Some(&JsonValue::String("second".into()))
    );
    assert_eq!(config.diagnostics.len(), 1);
    assert_eq!(
        config.diagnostics[0].json_path.as_ref().unwrap().as_str(),
        Some("$.snapshot")
    );
    assert_eq!(
        fs::read_to_string(source).unwrap(),
        r#"{"snapshot":false,"shell":"first"}"#
    );
    fixture.write(
        "project/.ycoding/ycoding.json",
        r#"{"shell":"new-directory"}"#,
    );
    config.reload().unwrap();
    assert_eq!(
        config.latest("shell"),
        Some(&JsonValue::String("new-directory".into()))
    );
}

#[test]
fn environment_and_file_substitutions_flow_into_loaded_configuration() {
    let fixture = Fixture::new();
    fixture.write("project/text.txt", " \u{feff}file\n\"value\"\n ");
    fixture.write("project/ycoding.jsonc", "{\n // Ignored reference: {file:missing.txt}\n \"username\": \"user-{env:MISSING}\", \"agents\": {\"reviewer\": {\"system\": \"{file:text.txt}\", \"description\": \"{env:VALUE}\"}} }");
    let mut options = fixture.options("project");
    options.env.insert("VALUE".into(), "configured".into());
    let config = Configuration::load(options).unwrap();
    assert_eq!(
        config.latest("username"),
        Some(&JsonValue::String("user-".into()))
    );
    assert_eq!(
        config.latest("agents"),
        Some(
            &parse_json(r#"{"reviewer":{"system":"file\n\"value\"","description":"configured"}}"#)
                .unwrap()
        )
    );
    let mut options = fixture.options("project");
    options.content = Some(r#"{"username":"{file:text.txt}"}"#.into());
    let config = Configuration::load(options).unwrap();
    assert_eq!(
        config.latest("username"),
        Some(&JsonValue::String("file\n\"value\"".into()))
    );
}

#[test]
fn substitution_keeps_raw_environment_values_honors_overrides_and_reports_file_errors() {
    let fixture = Fixture::new();
    let path = fixture.write("config.json", "{}");
    fixture.write("home/text.txt", " home text ");
    let source = ParseSource::Path(&path);
    let env = BTreeMap::from([
        ("VALUE".into(), "\"quoted\"".into()),
        ("REFERENCE".into(), "{file:~/text.txt}".into()),
    ]);
    assert_eq!(
        substitute(
            "{env:VALUE}/{env:MISSING}/{env:REFERENCE}",
            source,
            &fixture.0.join("home"),
            &env,
            MissingFile::Error
        )
        .unwrap(),
        "\"quoted\"//home text"
    );
    assert_eq!(
        substitute(
            "{file:missing.txt}",
            source,
            &fixture.0.join("home"),
            &env,
            MissingFile::Empty
        )
        .unwrap(),
        ""
    );
    let error = substitute(
        "{file:missing.txt}",
        source,
        &fixture.0.join("home"),
        &env,
        MissingFile::Error,
    )
    .unwrap_err();
    assert_eq!(error.source_path(), Some(path.as_path()));
    assert!(
        error
            .to_string()
            .contains("bad file reference: \"{file:missing.txt}\"")
    );
    assert!(error.to_string().contains("does not exist"));
    assert_eq!(
        substitute(
            " // {file:missing.txt}\n\"{file:missing.txt}\"",
            source,
            &fixture.0.join("home"),
            &env,
            MissingFile::Empty
        )
        .unwrap(),
        " // {file:missing.txt}\n\"\""
    );
}

#[test]
fn a_failed_reload_retains_the_previous_complete_snapshot() {
    let fixture = Fixture::new();
    let source = fixture.write("project/ycoding.json", r#"{"username":"before"}"#);
    let mut config = Configuration::load(fixture.options("project")).unwrap();
    fs::write(source, r#"{"username":"{file:missing.txt}"}"#).unwrap();
    assert!(config.reload().is_err());
    assert_eq!(
        config.latest("username"),
        Some(&JsonValue::String("before".into()))
    );
}

#[test]
fn runtime_roots_match_xdg_defaults_overrides_and_test_home_does_not_move_data() {
    let fixture = Fixture::new();
    let home = fixture.0.join("home");
    let temp = fixture.0.join("temp");
    let roots = Roots::runtime(&home, &temp, &BTreeMap::new()).unwrap();
    assert_eq!(roots.data, home.join(".local/share/ycoding"));
    assert_eq!(roots.config, home.join(".config/ycoding"));
    assert_eq!(roots.cache, home.join(".cache/ycoding"));
    assert_eq!(roots.state, home.join(".local/state/ycoding"));
    assert_eq!(roots.tmp, temp.join("ycoding"));
    assert_eq!(roots.bin, roots.cache.join("bin"));
    assert_eq!(roots.log, roots.data.join("log"));
    assert_eq!(roots.repos, roots.data.join("repos"));
    let override_config = fixture.0.join("explicit");
    let roots = Roots::runtime(
        &home,
        &temp,
        &BTreeMap::from([
            (
                "YCODING_TEST_HOME".into(),
                fixture.0.join("test-home").to_str().unwrap().into(),
            ),
            (
                "YCODING_CONFIG_DIR".into(),
                override_config.to_str().unwrap().into(),
            ),
            (
                "XDG_DATA_HOME".into(),
                fixture.0.join("xdg-data").to_str().unwrap().into(),
            ),
            ("XDG_CACHE_HOME".into(), "relative-cache".into()),
        ]),
    )
    .unwrap();
    assert_eq!(roots.home, fixture.0.join("test-home"));
    assert_eq!(roots.os_home, home);
    assert_eq!(roots.data, fixture.0.join("xdg-data/ycoding"));
    assert_eq!(roots.cache, home.join(".cache/ycoding"));
    assert_eq!(roots.config, override_config);
}

#[test]
fn development_roots_and_discovery_never_read_or_modify_normal_roots() {
    let fixture = Fixture::new();
    let sentinel = fixture.write("ycoding.json", r#"{"username":"outside-must-not-load"}"#);
    fixture.write(
        "normal/config/ycoding/ycoding.json",
        r#"{"username":"normal"}"#,
    );
    fixture.write(
        "development/config/ycoding/ycoding.json",
        r#"{"shell":"development"}"#,
    );
    fixture.write(
        "development/project/ycoding.json",
        r#"{"username":"isolated"}"#,
    );
    let roots = Roots::development(&fixture.0.join("development")).unwrap();
    for path in [
        &roots.home,
        &roots.os_home,
        &roots.config,
        &roots.data,
        &roots.cache,
        &roots.state,
        &roots.tmp,
        &roots.log,
        &roots.bin,
        &roots.repos,
    ] {
        assert!(path.starts_with(fixture.0.join("development")));
    }
    let config = Configuration::load(LoadOptions {
        directory: fixture.0.join("development/project"),
        roots,
        project: true,
        file: None,
        content: None,
        env: BTreeMap::new(),
    })
    .unwrap();
    assert_eq!(strings(&config, "username"), ["isolated"]);
    assert_eq!(strings(&config, "shell"), ["development"]);
    assert_eq!(
        fs::read_to_string(sentinel).unwrap(),
        r#"{"username":"outside-must-not-load"}"#
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("normal/config/ycoding/ycoding.json")).unwrap(),
        r#"{"username":"normal"}"#
    );
}

#[test]
fn development_rejects_explicit_files_and_file_substitution_that_escape_its_root() {
    let fixture = Fixture::new();
    let outside = fixture.write("outside.json", r#"{"username":"outside"}"#);
    fixture.write(
        "development/project/ycoding.json",
        r#"{"username":"inside"}"#,
    );
    let options = || LoadOptions {
        directory: fixture.0.join("development/project"),
        roots: Roots::development(&fixture.0.join("development")).unwrap(),
        project: true,
        file: None,
        content: None,
        env: BTreeMap::new(),
    };
    let mut explicit = options();
    explicit.file = Some(outside.clone());
    assert!(
        Configuration::load(explicit)
            .unwrap_err()
            .to_string()
            .contains("development root")
    );
    let mut content = options();
    content.content = Some(r#"{"username":"{file:../../outside.json}"}"#.into());
    assert!(
        Configuration::load(content)
            .unwrap_err()
            .to_string()
            .contains("development root")
    );
    let mut directory = options();
    directory.directory = fixture.0.join("outside-project");
    assert!(
        Configuration::load(directory)
            .unwrap_err()
            .to_string()
            .contains("development root")
    );
    assert_eq!(
        fs::read_to_string(outside).unwrap(),
        r#"{"username":"outside"}"#
    );
}

#[cfg(unix)]
#[test]
fn development_rejects_symlink_escapes_before_any_configuration_read() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = fixture.write("normal.json", r#"{"username":"normal"}"#);
    fs::create_dir_all(fixture.0.join("development/project")).unwrap();
    symlink(outside, fixture.0.join("development/project/ycoding.json")).unwrap();
    let options = LoadOptions {
        directory: fixture.0.join("development/project"),
        roots: Roots::development(&fixture.0.join("development")).unwrap(),
        project: true,
        file: None,
        content: None,
        env: BTreeMap::new(),
    };
    assert!(
        Configuration::load(options)
            .unwrap_err()
            .to_string()
            .contains("development root")
    );
}

#[test]
fn runtime_root_initialization_creates_owned_paths_and_private_log_directory() {
    let fixture = Fixture::new();
    let roots = Roots::development(&fixture.0.join("development")).unwrap();
    roots.initialize().unwrap();
    for path in [
        &roots.data,
        &roots.config,
        &roots.cache,
        &roots.state,
        &roots.tmp,
        &roots.log,
        &roots.bin,
        &roots.repos,
    ] {
        assert!(path.is_dir());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&roots.log).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert!(!Path::new(&fixture.0.join("normal")).exists());
}

#[test]
fn nonmissing_nonpermission_file_errors_propagate_instead_of_being_ignored() {
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("project/ycoding.json")).unwrap();
    let result = Configuration::load(fixture.options("project"));
    assert!(result.is_err());
    assert_eq!(
        result.unwrap_err().source_path(),
        Some(fixture.0.join("project/ycoding.json").as_path())
    );
}

#[test]
fn filesystem_text_decoding_matches_effect_text_decoder_before_jsonc_and_substitution() {
    let fixture = Fixture::new();
    let source = fixture.write("project/ycoding.json", "{}");
    let mut bytes = b"\xef\xbb\xbf{\"username\":\"".to_vec();
    bytes.push(0xff);
    bytes.extend_from_slice(b"\"}");
    fs::write(&source, bytes).unwrap();
    let config = Configuration::load(fixture.options("project")).unwrap();
    assert_eq!(
        config.latest("username"),
        Some(&JsonValue::String("\u{fffd}".into()))
    );
    let file = fixture.write("project/content.txt", "");
    fs::write(file, [0xef, 0xbb, 0xbf, 0xff]).unwrap();
    fs::write(source, r#"{"username":"{file:content.txt}"}"#).unwrap();
    let config = Configuration::load(fixture.options("project")).unwrap();
    assert_eq!(
        config.latest("username"),
        Some(&JsonValue::String("\u{fffd}".into()))
    );
}

#[test]
fn virtual_file_reference_failures_retain_the_virtual_source_name() {
    let fixture = Fixture::new();
    let error = substitute(
        "{file:missing.txt}",
        ParseSource::Virtual {
            source: "fixture.virtual",
            directory: &fixture.0,
        },
        &fixture.0,
        &BTreeMap::new(),
        MissingFile::Error,
    )
    .unwrap_err();
    assert_eq!(error.source_name(), Some("fixture.virtual"));
    assert!(error.source_path().is_none());
}

#[test]
fn explicit_global_overrides_retain_ts_relative_path_metadata() {
    let fixture = Fixture::new();
    let roots = Roots::runtime(
        &fixture.0.join("home"),
        &fixture.0.join("temp"),
        &BTreeMap::from([
            ("YCODING_CONFIG_DIR".into(), "relative-config".into()),
            ("YCODING_TEST_HOME".into(), "relative-home".into()),
        ]),
    )
    .unwrap();
    assert_eq!(roots.config, PathBuf::from("relative-config"));
    assert_eq!(roots.home, PathBuf::from("relative-home"));
    let roots = Roots::runtime(
        &fixture.0.join("home"),
        &fixture.0.join("temp"),
        &BTreeMap::from([("YCODING_CONFIG_DIR".into(), "".into())]),
    )
    .unwrap();
    assert_eq!(roots.config, PathBuf::new());
}
