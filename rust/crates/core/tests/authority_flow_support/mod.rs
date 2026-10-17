use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_schema::{permission, session_id::SessionId};
use ycoding_store::{Metadata, Options, Store};

pub struct Temp {
    pub root: PathBuf,
    pub repo_a: PathBuf,
    pub repo_b: PathBuf,
    pub home: PathBuf,
    pub outside: PathBuf,
    pub database: PathBuf,
}

impl Temp {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-authority-flow-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let temp = Self {
            repo_a: root.join("repo-a"),
            repo_b: root.join("repo-b"),
            home: root.join("home"),
            outside: root.join("outside"),
            database: root.join("store.redb"),
            root,
        };
        for directory in [&temp.repo_a, &temp.repo_b, &temp.home, &temp.outside] {
            std::fs::create_dir_all(directory).unwrap();
        }
        Self {
            repo_a: std::fs::canonicalize(&temp.repo_a).unwrap(),
            repo_b: std::fs::canonicalize(&temp.repo_b).unwrap(),
            home: std::fs::canonicalize(&temp.home).unwrap(),
            outside: std::fs::canonicalize(&temp.outside).unwrap(),
            ..temp
        }
    }

    pub fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

pub struct Fixture {
    pub temp: Temp,
    pub store: Option<Store>,
    pub events: Arc<Mutex<Vec<ycoding_core::tools::policy::Event>>>,
    pub rules: Arc<Mutex<permission::Ruleset>>,
}

fn catalog() -> ycoding_store::Catalog {
    ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core)
}

impl Fixture {
    pub fn new() -> Self {
        let temp = Temp::new();
        let store = Store::initialize(
            &temp.database,
            Options::core(),
            catalog(),
            Metadata::new([23; 16], 1),
        )
        .unwrap();
        let fixture = Self {
            temp,
            store: Some(store),
            events: Default::default(),
            rules: Default::default(),
        };
        for (project, worktree) in [
            ("prj_a", fixture.temp.repo_a.clone()),
            ("prj_b", fixture.temp.repo_b.clone()),
        ] {
            fixture
                .store()
                .submit(move |tx| {
                    tx.put::<ycoding_store::project::ProjectTable>(
                        &ycoding_store::project::Project {
                            id: project.into(),
                            worktree: worktree.to_string_lossy().as_ref().into(),
                            vcs: None,
                            name: None,
                            icon_url: None,
                            icon_url_override: None,
                            icon_color: None,
                            time_created: 1,
                            time_updated: 1,
                            time_initialized: None,
                            sandboxes: vec![],
                            commands: None,
                        },
                    )?;
                    Ok(())
                })
                .unwrap()
                .wait()
                .unwrap();
        }
        fixture
    }

    pub fn store(&self) -> &Store {
        self.store.as_ref().unwrap()
    }

    pub fn client(&self) -> ycoding_store::Client {
        self.store().client()
    }

    pub fn restart(&mut self) {
        let store = self.store.take().unwrap();
        store.shutdown().unwrap();
        self.store = Some(Store::open(&self.temp.database, Options::core(), catalog()).unwrap());
    }

    pub fn shutdown(&mut self) {
        if let Some(store) = self.store.take() {
            store.shutdown().unwrap();
        }
    }

    pub fn session(
        &self,
        name: &str,
        parent: Option<&str>,
        project: &str,
        directory: &std::path::Path,
        yolo: u8,
        ceiling: Option<permission::Ruleset>,
    ) -> SessionId {
        let id = SessionId::new(name).unwrap();
        let name = name.to_owned();
        let parent = parent.map(str::to_owned);
        let project = project.to_owned();
        let directory = directory.to_string_lossy().into_owned();
        self.store().submit(move |tx| {
            tx.put::<ycoding_store::session::SessionTable>(&ycoding_store::session::Session {
                id: name.into(), project_id: project.into(), workspace_id: None, parent_id: parent.map(Into::into), fork_session_id: None, fork_message_id: None, fork_seq: None, directory: directory.into(), path: None, title: "authority".into(), cost: 0.0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, revert: None, permission: ceiling.map(|rules| ycoding_store::session::Document::from_domain(&rules).unwrap()), autonomy: Some(ycoding_schema::parse_json(&format!("{{\"mode\":\"normal\",\"yolo\":{yolo},\"goal\":{{\"text\":\"Synthetic goal\",\"iteration\":0,\"noProgress\":0,\"maxNoProgress\":3,\"status\":\"completed\"}}}}")).unwrap()), autonomy_revision: 0, orchestration_revision: 0, agent: Some("build".into()), model: None, profile_binding: None, daybreak: None, time_created: 1, time_updated: 1, time_archived: None, time_active: None, time_pinned: None, time_suspended: None, usage_pruned_through: None,
            })?;
            Ok(())
        }).unwrap().wait().unwrap();
        id
    }

    pub fn authority(&self) -> ycoding_core::tools::policy::Authority {
        let rules = self.rules.clone();
        ycoding_core::tools::policy::Authority {
            store: self.client(),
            agents: Arc::new(move |agent| {
                Some((
                    agent.cloned().unwrap_or_else(|| "build".into()),
                    rules.lock().unwrap().clone(),
                ))
            }),
        }
    }

    pub fn publisher(&self) -> ycoding_core::tools::policy::Publisher {
        let events = self.events.clone();
        Arc::new(move |event| {
            events.lock().unwrap().push(event);
            Ok(())
        })
    }

    pub fn permissions(
        &self,
        project: &str,
    ) -> ycoding_core::tools::policy::permissions::Permissions {
        ycoding_core::tools::policy::permissions::Permissions::new(
            self.authority(),
            ycoding_schema::project_id::ProjectId::new(project).unwrap(),
            self.publisher(),
        )
    }

    pub fn guardrails(
        &self,
        project: &str,
        workdir: &std::path::Path,
        custom: ycoding_core::process::guardrails::CustomLayers,
        enabled: bool,
    ) -> ycoding_core::process::guardrails::Guardrails {
        ycoding_core::process::guardrails::Guardrails::new(
            self.authority(),
            self.permissions(project),
            ycoding_core::process::guardrails::Settings {
                paths: ycoding_core::process::guardrails::Paths {
                    workdir: workdir.to_string_lossy().as_ref().into(),
                    project: workdir.to_string_lossy().as_ref().into(),
                    home: self.temp.home.to_string_lossy().as_ref().into(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom,
                enabled,
                limits: ycoding_core::process::guardrails::Limits::default(),
                decide_reviews: false,
                decide_hard_reviews: true,
            },
            self.publisher(),
        )
    }

    pub fn leaf(
        &self,
        project: &str,
        workdir: &std::path::Path,
    ) -> Arc<ycoding_core::tools::context::policy::LeafPolicy> {
        Arc::new(ycoding_core::tools::context::policy::LeafPolicy {
            permissions: self.permissions(project),
            guardrails: self.guardrails(project, workdir, Arc::new(Vec::new), true),
        })
    }

    pub fn set_rules(&self, rules: permission::Ruleset) {
        *self.rules.lock().unwrap() = rules;
    }

    pub fn push_rule(&self, action: &str, resource: &str, effect: &str) {
        self.rules.lock().unwrap().push(permission::Rule {
            action: action.into(),
            resource: resource.into(),
            effect: permission::Effect(effect.into()),
        });
    }

    pub fn events_json(&self) -> String {
        self.events
            .lock()
            .unwrap()
            .iter()
            .map(|event| {
                format!(
                    "{} {}",
                    event.type_,
                    ycoding_schema::stringify_json(&event.data)
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Clone, Default)]
pub struct Logs(pub Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.shutdown();
        self.temp.cleanup();
    }
}

pub fn rule(action: &str, resource: &str, effect: &str) -> permission::Rule {
    permission::Rule {
        action: action.into(),
        resource: resource.into(),
        effect: permission::Effect(effect.into()),
    }
}

pub async fn until<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    for _ in 0..1000 {
        if let Some(value) = probe() {
            return value;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("condition not reached within 10 seconds")
}
