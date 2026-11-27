use std::sync::{Arc, Mutex};
use ycoding_ai::llm::TextPart;
use ycoding_core::harness::{
    Ceiling, Completion, Component, Controller, Detail, Event, Harness, Item, Mode, Outcome,
    Pending, Prepared, Reflection, Stage, Task, Version, VersionId,
};
use ycoding_core::session::{harness_events, runner::harness_hooks};
use ycoding_schema::session;

fn id() -> session::Id {
    session::Id::new("ses_harness").unwrap()
}

fn version(items: &[(Component, &str)]) -> Version {
    let mut harness = Harness::default();
    for (component, content) in items {
        harness.items.entry(*component).or_default().push(Item {
            key: (*content).into(),
            content: (*content).into(),
        });
    }
    Version {
        id: VersionId("v1".into()),
        parent: None,
        harness,
        edits: Vec::new(),
        created_at: 0,
        task: None,
    }
}

struct Recording {
    prepared: Version,
    reflected: Mutex<Vec<Completion>>,
}

impl Controller for Recording {
    fn prepare(&self, _: Task, _: Ceiling) -> Pending<'_, Prepared> {
        let version = self.prepared.clone();
        Box::pin(async move {
            Ok(Prepared {
                version,
                adopted: Vec::new(),
                baseline: None,
                probes: Vec::new(),
            })
        })
    }
    fn reflect(&self, _: Task, completion: Completion) -> Pending<'_, Reflection> {
        self.reflected.lock().unwrap().push(completion);
        Box::pin(async {
            Ok(Reflection {
                experiences: Vec::new(),
            })
        })
    }
    fn current(&self) -> Pending<'_, Version> {
        let version = self.prepared.clone();
        Box::pin(async move { Ok(version) })
    }
    fn rollback(&self, _: VersionId) -> Pending<'_, Version> {
        let version = self.prepared.clone();
        Box::pin(async move { Ok(version) })
    }
}

#[tokio::test]
async fn prepared_version_extends_the_system_prompt_and_reflection_reports_the_run() {
    let controller = Arc::new(Recording {
        prepared: version(&[
            (Component::SystemPrompt, "Prefer small diffs."),
            (Component::Memory, "ignored here"),
            (Component::ToolGuidance, "Read before editing."),
        ]),
        reflected: Mutex::new(Vec::new()),
    });
    let hooks = harness_hooks::Hooks {
        controller: controller.clone(),
        ceiling: Ceiling::default(),
    };
    let task = harness_hooks::task(&id(), "build", "fix the bug");
    let mut run = harness_hooks::prepare(&hooks, task.clone()).await.unwrap();
    run.observe(Some(120.0));
    run.observe(None);
    let system = harness_hooks::apply(&[TextPart::from("base")], &run.version);
    assert_eq!(
        system
            .iter()
            .map(|part| part.text.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["base", "Prefer small diffs.", "Read before editing."]
    );
    harness_hooks::reflect(&hooks, task, run, Outcome::Completed).await;
    let reflected = controller.reflected.lock().unwrap();
    assert_eq!(reflected.len(), 1);
    assert_eq!(reflected[0].version, VersionId("v1".into()));
    assert_eq!(reflected[0].execution.steps, 2);
    assert_eq!(reflected[0].execution.tokens, 120);
    assert_eq!(reflected[0].execution.outcome, Outcome::Completed);
    assert_eq!(reflected[0].reached, Stage::Adopt);
}

fn event(detail: Detail) -> Event {
    Event {
        session: id(),
        stage: Stage::Probe,
        mode: Mode::Parallel,
        detail,
    }
}

#[test]
fn stage_details_map_to_one_record_each_and_unrecorded_stages_are_silent() {
    let kinds = [
        (
            Detail::Skipped("disabled".into()),
            Some("session.harness.evaluated.1"),
        ),
        (
            Detail::Baseline {
                signals: 3,
                insufficient: true,
            },
            Some("session.harness.evaluated.1"),
        ),
        (
            Detail::Probed {
                candidate: "c1".into(),
                outcome: "completed".into(),
                tokens: 9,
                latency_ms: 4,
            },
            Some("session.harness.probed.1"),
        ),
        (
            Detail::Adopted {
                version: VersionId("v2".into()),
                parent: VersionId("v1".into()),
            },
            Some("session.harness.adopted.1"),
        ),
        (
            Detail::RolledBack {
                from: VersionId("v2".into()),
                to: VersionId("v1".into()),
            },
            Some("session.harness.rolled-back.1"),
        ),
        (
            Detail::Reflected {
                experiences: vec!["e1".into()],
            },
            Some("session.harness.reflected.1"),
        ),
        (Detail::Proposed { candidates: 2 }, None),
        (
            Detail::Composed {
                kept: 1,
                dropped: 1,
            },
            None,
        ),
    ];
    for (detail, expected) in kinds {
        let mapped = harness_events::data(&event(detail)).unwrap();
        assert_eq!(mapped.map(|(name, _)| name), expected);
    }
}

#[test]
fn empty_identifiers_and_outcomes_are_rejected() {
    assert!(
        harness_events::data(&event(Detail::Probed {
            candidate: String::new(),
            outcome: "completed".into(),
            tokens: 0,
            latency_ms: 0,
        }))
        .is_err()
    );
    assert!(
        harness_events::data(&event(Detail::Probed {
            candidate: "c".into(),
            outcome: String::new(),
            tokens: 0,
            latency_ms: 0,
        }))
        .is_err()
    );
}
