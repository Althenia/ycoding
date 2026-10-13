include!("policy_fixture.rs");

pub struct ToolFixture {
    pub authority: Fixture,
    pub root: std::path::PathBuf,
    pub policy: std::sync::Arc<ycoding_core::tools::context::policy::LeafPolicy>,
}
impl Default for ToolFixture {
    fn default() -> Self {
        Self::new()
    }
}
impl ToolFixture {
    pub fn new() -> Self {
        let authority = Fixture::default();
        authority.session("ses_tool", None, 1, false, None);
        authority
            .rules
            .lock()
            .unwrap()
            .push(ycoding_schema::permission::Rule {
                action: "*".into(),
                resource: "*".into(),
                effect: ycoding_schema::permission::Effect("allow".into()),
            });
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "tool_fixture_{}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let policy = policy(
            &authority,
            &root,
            std::sync::Arc::new(Vec::new),
            Default::default(),
        );
        Self {
            authority,
            root,
            policy,
        }
    }
    pub fn with_guardrail_rule(
        mut self,
        decision: ycoding_schema::guardrail::RuleDecision,
        action: &str,
    ) -> Self {
        let action = action.to_owned();
        self.policy = policy(
            &self.authority,
            &self.root,
            std::sync::Arc::new(move || {
                vec![ycoding_core::process::guardrails::CustomLayer {
                    rules: vec![ycoding_schema::guardrail::Rule {
                        id: "policy".into(),
                        source: ycoding_schema::guardrail::RuleSource::Custom,
                        decision,
                        actions: vec![action.as_str().into()],
                        resources: vec!["*".into()],
                        reason: "Review".into(),
                        priority: ycoding_schema::schema::Int::new(0).unwrap(),
                    }],
                    invalid_files: vec![],
                }]
            }),
            Default::default(),
        );
        self
    }
    pub fn with_guardrail_limits(
        mut self,
        limits: ycoding_core::process::guardrails::Limits,
    ) -> Self {
        self.policy = policy(
            &self.authority,
            &self.root,
            std::sync::Arc::new(Vec::new),
            limits,
        );
        self
    }
    pub fn registry(&self) -> ycoding_core::tools::registry::Registry {
        ycoding_core::tools::registry::Registry::new(
            std::sync::Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                &ycoding_core::resources::config::Roots::development(&self.root).unwrap(),
            )),
            None,
            Default::default(),
            std::sync::Arc::new(|left, right| left.cmp(right)),
        )
    }
    pub fn context(&self) -> ycoding_core::tools::context::Context {
        ycoding_core::tools::context::Context::new("ses_tool", "test", "msg_tool", "call_tool")
            .unwrap()
    }
    pub fn paths(&self) -> std::sync::Arc<ycoding_core::tools::builtin::filesystem::Paths> {
        std::sync::Arc::new(ycoding_core::tools::builtin::filesystem::Paths {
            directory: self.root.clone(),
            data: self.root.join("data"),
            git: std::sync::Arc::new(ycoding_core::platform::git::Service::new(1024 * 1024)),
        })
    }
    pub fn deny(&self, action: &str, resource: &str) {
        self.authority
            .rules
            .lock()
            .unwrap()
            .push(ycoding_schema::permission::Rule {
                action: action.into(),
                resource: resource.into(),
                effect: ycoding_schema::permission::Effect("deny".into()),
            });
    }
    pub fn cleanup(self) {
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

fn policy(
    authority: &Fixture,
    root: &std::path::Path,
    custom: ycoding_core::process::guardrails::CustomLayers,
    limits: ycoding_core::process::guardrails::Limits,
) -> std::sync::Arc<ycoding_core::tools::context::policy::LeafPolicy> {
    std::sync::Arc::new(ycoding_core::tools::context::policy::LeafPolicy {
        permissions: authority.permissions(),
        guardrails: ycoding_core::process::guardrails::Guardrails::new(
            authority.authority(),
            authority.permissions(),
            ycoding_core::process::guardrails::Settings {
                paths: ycoding_core::process::guardrails::Paths {
                    workdir: root.to_string_lossy().as_ref().into(),
                    project: root.to_string_lossy().as_ref().into(),
                    home: root.to_string_lossy().as_ref().into(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom,
                enabled: true,
                limits,
            },
            authority.publisher(),
        ),
    })
}
