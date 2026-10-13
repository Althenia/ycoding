use super::{Factory, unavailable};
use crate::{dispatch::Failure, locations::ServiceSet};
use std::{
    path::PathBuf,
    sync::Arc,
};
use ycoding_core::{
    platform::{
        filesystem::{collation, mutation},
        shell,
    },
    process::guardrails::{CustomLayer, CustomLayers},
    resources::{config, discovery::markdown, image, memory, tool_output_store},
    tools::{
        builtin::{
            edit::Edit,
            filesystem::Paths,
            memory::Memory,
            patch::Patch,
            project_artifact::ProjectArtifact,
            read::Read,
            search::{Kind, Search},
            shell::{AUTO_BACKGROUND, ShellTool},
            webfetch::WebFetch,
            websearch,
            worktree::Worktree,
            write::Write,
        },
        context::{Context, policy::LeafPolicy},
        registry::{self, Registration, Registry, Tool, ToolFuture},
    },
    ycoding_ai::llm::ToolDefinition,
    ycoding_schema::{DomainDecode, JsonValue, guardrail},
};

pub(super) fn compose(
    factory: &Factory,
    services: &ServiceSet,
    configuration: Arc<config::Configuration>,
    memory: Arc<memory::Service>,
    platform: &crate::services::PlatformServices,
) -> Result<(Arc<Registry>, Registration), Failure> {
    let directory = std::fs::canonicalize(PathBuf::from(
        services
            .info
            .directory
            .as_lossless()
            .to_utf8()
            .map_err(|_| unavailable("Location directory"))?,
    ))
    .map_err(|_| unavailable("Location directory"))?;
    let paths = Arc::new(Paths {
        directory: directory.clone(),
        data: factory.options.roots.data.clone(),
        git: factory.git.clone(),
    });
    let policy = Arc::new(LeafPolicy {
        permissions: services.permissions.clone(),
        guardrails: services.guardrails.clone(),
    });
    let files = Arc::new(mutation::Service::default());
    let collator: Arc<ycoding_core::tools::code_mode::Collation> = Arc::new(collation::compare);
    let registry = Arc::new(Registry::new(
        Arc::new(tool_output_store::Store::new(&factory.options.roots)),
        Some(configuration.clone()),
        image::Limits::from_configuration(&configuration),
        collator.clone(),
    ));
    let search = platform.search.clone();
    let entries: Vec<(String, Arc<dyn Tool>)> = vec![
        (
            "shell".into(),
            Arc::new(Shell {
                shell: platform.shell.clone(),
                configuration: configuration.clone(),
                paths: paths.clone(),
                policy: policy.clone(),
                tool: tokio::sync::OnceCell::new(),
            }),
        ),
        (
            "read".into(),
            Arc::new(Read {
                paths: paths.clone(),
                policy: policy.clone(),
                instructions: Arc::new(ycoding_core::session::read_instructions::Service::new(
                    ycoding_core::session::store::Service::new(factory.client.clone()),
                    std::fs::canonicalize(PathBuf::from(
                        services
                            .info
                            .project
                            .directory
                            .as_lossless()
                            .to_utf8()
                            .map_err(|_| unavailable("Project directory"))?,
                    ))
                    .map_err(|_| unavailable("Project directory"))?,
                    configuration.clone(),
                )),
                collator,
            }),
        ),
        (
            "write".into(),
            Arc::new(Write {
                paths: paths.clone(),
                files: files.clone(),
                policy: policy.clone(),
            }),
        ),
        (
            "edit".into(),
            Arc::new(Edit {
                paths: paths.clone(),
                files: files.clone(),
                policy: policy.clone(),
            }),
        ),
        (
            "patch".into(),
            Arc::new(Patch {
                paths: paths.clone(),
                files,
                policy: policy.clone(),
            }),
        ),
        (
            "memory".into(),
            Arc::new(Memory {
                service: memory,
                policy: policy.clone(),
            }),
        ),
        (
            "worktree".into(),
            Arc::new(Worktree {
                paths: paths.clone(),
                policy: policy.clone(),
            }),
        ),
        (
            "glob".into(),
            Arc::new(AcquiredSearch { binary: factory.globals.ripgrep.clone(), tool: Search {
                kind: Kind::Glob,
                directory: paths.directory.clone(),
                data: paths.data.clone(),
                service: search.clone(),
                ripgrep: factory.ripgrep.clone(),
                policy: policy.clone(),
            }}),
        ),
        (
            "grep".into(),
            Arc::new(AcquiredSearch { binary: factory.globals.ripgrep.clone(), tool: Search {
                kind: Kind::Grep,
                directory: paths.directory.clone(),
                data: paths.data.clone(),
                service: search,
                ripgrep: factory.ripgrep.clone(),
                policy: policy.clone(),
            }}),
        ),
        (
            "webfetch".into(),
            Arc::new(WebFetch {
                policy: policy.clone(),
            }),
        ),
        (
            "websearch".into(),
            Arc::new(
                websearch::WebSearch::new(
                    websearch::Config::from_environment(&factory.options.env),
                    policy.clone(),
                    env!("CARGO_PKG_VERSION").into(),
                )
                .map_err(|_| unavailable("web search"))?,
            ),
        ),
        (
            "project_artifact".into(),
            Arc::new(ProjectArtifact {
                store: Arc::new(factory.globals.artifacts.clone()),
                project_id: ycoding_core::ycoding_schema::project::Id::new(
                    services.info.project.id.as_lossless().clone(),
                )
                .map_err(|_| unavailable("Project identity"))?,
                policy,
            }),
        ),
    ];
    let registration = registry
        .register(entries, registry::Options::direct())
        .map_err(|_| unavailable("built-in tool registration"))?;
    Ok((registry, registration))
}

struct Shell {
    shell: Arc<shell::Shell>,
    configuration: Arc<config::Configuration>,
    paths: Arc<Paths>,
    policy: Arc<LeafPolicy>,
    tool: tokio::sync::OnceCell<ShellTool>,
}

struct AcquiredSearch {
    binary: Arc<ycoding_core::platform::ripgrep_binary::Service>,
    tool: Search,
}
impl Tool for AcquiredSearch {
    fn definition(&self, name: &str) -> ToolDefinition { self.tool.definition(name) }
    fn permission(&self) -> Option<&str> { self.tool.permission() }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let ripgrep = self.binary.filepath().await.map_err(|_| registry::Failure::message("ripgrep acquisition failed"))?;
            Search { kind: self.tool.kind, directory: self.tool.directory.clone(), data: self.tool.data.clone(), service: self.tool.service.clone(), ripgrep, policy: self.tool.policy.clone() }.settle(input, context).await
        })
    }
}

impl Tool for Shell {
    fn definition(&self, name: &str) -> ToolDefinition {
        ShellTool::tool_definition(name)
    }
    fn permission(&self) -> Option<&str> {
        Some("shell")
    }
    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let tool = self
                .tool
                .get_or_try_init(|| async {
                    let execution = ycoding_core::session::execution::Execution::global()
                        .ok_or_else(|| {
                            registry::Failure::Defect("Session execution is not installed".into())
                        })?;
                    Ok::<_, registry::Failure>(ShellTool {
                        shell: self.shell.clone(),
                        configuration: self.configuration.clone(),
                        paths: self.paths.clone(),
                        policy: self.policy.clone(),
                        jobs: Arc::new(execution.job_shells()),
                        auto_background: AUTO_BACKGROUND,
                    })
                })
                .await?;
            tool.settle(input, context).await
        })
    }
}

pub(super) fn guardrails(configuration: &config::Configuration) -> CustomLayers {
    let directories = configuration
        .entries
        .iter()
        .filter_map(|entry| match entry {
            config::Entry::Directory(path) => Some(path.join("guardrails")),
            _ => None,
        })
        .rev()
        .collect::<Vec<_>>();
    Arc::new(move || {
        directories
            .iter()
            .map(|directory| {
                let mut layer = CustomLayer::default();
                let mut files = std::fs::read_dir(directory)
                    .into_iter()
                    .flatten()
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        entry.file_type().is_ok_and(|kind| kind.is_file())
                            && entry
                                .path()
                                .extension()
                                .is_some_and(|extension| extension == "md")
                    })
                    .map(|entry| entry.path())
                    .collect::<Vec<_>>();
                files.sort();
                for file in files {
                    let rule = std::fs::read_to_string(&file)
                        .ok()
                        .and_then(|content| markdown::parse(&content).ok())
                        .and_then(|markdown| {
                            if markdown.data.get("enabled") == Some(&markdown::Value::Bool(false)) {
                                return Some(Ok(None));
                            }
                            let mut rule = markdown
                                .data
                                .fields(&[
                                    "id",
                                    "decision",
                                    "actions",
                                    "resources",
                                    "reason",
                                    "priority",
                                ])
                                .ok()?;
                            rule.insert("source".into(), JsonValue::String("custom".into()));
                            if rule.get(&"priority".into()).is_none() {
                                rule.insert("priority".into(), JsonValue::Number(0.0));
                            }
                            Some(guardrail::Rule::decode(&JsonValue::Object(rule)).map(Some))
                        });
                    match rule {
                        Some(Ok(Some(rule))) => layer.rules.push(rule),
                        Some(Ok(None)) => {}
                        _ => layer
                            .invalid_files
                            .push(file.to_string_lossy().as_ref().into()),
                    }
                }
                layer
            })
            .collect()
    })
}
