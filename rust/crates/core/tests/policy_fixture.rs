pub struct Fixture {
    pub store: ycoding_store::Store,
    pub events: std::sync::Arc<std::sync::Mutex<Vec<ycoding_core::tools::policy::Event>>>,
    pub rules: std::sync::Arc<std::sync::Mutex<ycoding_schema::permission::Ruleset>>,
}

impl Default for Fixture {
    fn default() -> Self {
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core),
            ycoding_store::Metadata::new([19; 16], 1),
        )
        .unwrap();
        store
            .submit(|tx| {
                tx.put::<ycoding_store::project::ProjectTable>(&ycoding_store::project::Project {
                    id: "project".into(),
                    worktree: "/workspace/project".into(),
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
                })?;
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        Self {
            store,
            events: Default::default(),
            rules: Default::default(),
        }
    }
}

impl Fixture {
    pub fn session(
        &self,
        name: &str,
        parent: Option<&str>,
        yolo: u8,
        active_goal: bool,
        ceiling: Option<ycoding_schema::permission::Ruleset>,
    ) -> ycoding_schema::session_id::SessionId {
        let id = ycoding_schema::session_id::SessionId::new(name).unwrap();
        let name = name.to_owned();
        let parent = parent.map(str::to_owned);
        self.store.submit(move |tx| {
            tx.put::<ycoding_store::session::SessionTable>(&ycoding_store::session::Session {
                id: name.into(), project_id: "project".into(), workspace_id: None, parent_id: parent.map(Into::into), fork_session_id: None, fork_message_id: None, fork_seq: None, directory: "/workspace/project".into(), path: None, title: "authority".into(), cost: 0.0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, revert: None, permission: ceiling.map(|rules| ycoding_store::session::Document::from_domain(&rules).unwrap()), autonomy: Some(ycoding_schema::parse_json(&format!("{{\"mode\":\"normal\",\"yolo\":{yolo},\"goal\":{{\"text\":\"Synthetic goal\",\"iteration\":0,\"noProgress\":0,\"maxNoProgress\":3,\"status\":\"{}\"}}}}",if active_goal { "active" } else { "completed" })).unwrap()), autonomy_revision: 0, orchestration_revision: 0, agent: Some("test".into()), model: None, profile_binding: None, daybreak: None, time_created: 1, time_updated: 1, time_archived: None, time_active: None, time_pinned: None, time_suspended: None,
            })?;
            Ok(())
        }).unwrap().wait().unwrap();
        id
    }

    pub fn authority(&self) -> ycoding_core::tools::policy::Authority {
        let rules = self.rules.clone();
        ycoding_core::tools::policy::Authority {
            store: self.store.client(),
            agents: std::sync::Arc::new(move |agent| {
                (agent.is_none_or(|agent| agent.as_str() == Some("test")))
                    .then(|| ("test".into(), rules.lock().unwrap().clone()))
            }),
        }
    }

    pub fn publisher(&self) -> ycoding_core::tools::policy::Publisher {
        let events = self.events.clone();
        std::sync::Arc::new(move |event| {
            events.lock().unwrap().push(event);
            Ok(())
        })
    }

    pub fn permissions(&self) -> ycoding_core::tools::policy::permissions::Permissions {
        ycoding_core::tools::policy::permissions::Permissions::new(
            self.authority(),
            ycoding_schema::project_id::ProjectId::new("project").unwrap(),
            self.publisher(),
        )
    }
}
