use crate::harness::{
    Ceiling, Completion, Component, Controller, Execution, Outcome, Stage, Task, Version,
};
use std::{sync::Arc, time::Instant};
use ycoding_ai::llm;
use ycoding_schema::session;

#[derive(Clone)]
pub struct Hooks {
    pub controller: Arc<dyn Controller>,
    pub ceiling: Ceiling,
}

pub struct Run {
    pub version: Version,
    started: Instant,
    steps: u32,
    tokens: u64,
}

impl Run {
    pub fn observe(&mut self, tokens: Option<f64>) {
        self.steps += 1;
        self.tokens = self
            .tokens
            .saturating_add(tokens.map_or(0, |tokens| tokens.max(0.0) as u64));
    }
}

pub fn task(session: &session::Id, agent: &str, text: &str) -> Task {
    Task {
        session: session.clone(),
        agent: agent.to_owned(),
        text: text.to_owned(),
        domains: Vec::new(),
    }
}

pub async fn prepare(hooks: &Hooks, task: Task) -> Option<Run> {
    match hooks.controller.prepare(task, hooks.ceiling.clone()).await {
        Ok(prepared) => Some(Run {
            version: prepared.version,
            started: Instant::now(),
            steps: 0,
            tokens: 0,
        }),
        Err(error) => {
            tracing::warn!(%error, "harness preparation failed; running with the current harness");
            None
        }
    }
}

pub fn apply(system: &[llm::TextPart], version: &Version) -> Vec<llm::TextPart> {
    system
        .iter()
        .cloned()
        .chain(
            [Component::SystemPrompt, Component::ToolGuidance]
                .into_iter()
                .filter_map(|component| version.harness.items.get(&component))
                .flatten()
                .map(|item| llm::TextPart::from(item.content.as_str())),
        )
        .collect()
}

pub async fn reflect(hooks: &Hooks, task: Task, run: Run, outcome: Outcome) {
    let completion = Completion {
        version: run.version.id.clone(),
        execution: Execution {
            candidate: run.version.id.0.clone(),
            outcome,
            tokens: run.tokens,
            latency_ms: run.started.elapsed().as_millis() as u64,
            steps: run.steps,
            signals: Vec::new(),
            summary: String::new(),
        },
        reached: Stage::Adopt,
    };
    if let Err(error) = hooks.controller.reflect(task, completion).await {
        tracing::warn!(%error, "harness reflection failed");
    }
}
