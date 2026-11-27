use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
use ycoding_core::{
    harness::{
        Applicability, Basis, Budget, Candidate, Ceiling, Change, Completion, Component,
        Composition, Contrast, Controller, Detail, Edit, Engine, Error, Event, Events, Execution,
        Experience, Experiences, FileVersions, Harness, MemoryExperiences, Mode, Op, Origin,
        Outcome, Parts, Pending, Prober, Proposer, Replay, Settings, Signal, Stage, Strategy, Task,
        Version, VersionId, Versions, rules,
    },
    resources::memory::{Limits, Options, Repository, Scope, Service},
};
use ycoding_schema::session;

struct Dir(PathBuf);

impl Dir {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-harness-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

struct Recorder(Mutex<Vec<Event>>);

impl Events for Recorder {
    fn emit(&self, event: Event) {
        self.0.lock().unwrap().push(event);
    }
}

impl Recorder {
    fn details(&self) -> Vec<Detail> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.detail.clone())
            .collect()
    }
    fn stages(&self) -> Vec<Stage> {
        self.0.lock().unwrap().iter().map(|e| e.stage).collect()
    }
}

struct Notes {
    recorded: Mutex<Vec<Experience>>,
    recall: Vec<Experience>,
}

impl Experiences for Notes {
    fn record(&self, experience: Experience) -> Pending<'_, ()> {
        Box::pin(async move {
            self.recorded.lock().unwrap().push(experience);
            Ok(())
        })
    }
    fn recall(&self, _task: &Task, _limit: usize) -> Pending<'_, Vec<Experience>> {
        let recall = self.recall.clone();
        Box::pin(async move { Ok(recall) })
    }
}

type Proposals = Box<dyn Fn(&Version) -> Vec<Candidate> + Send + Sync>;

struct Proposing {
    candidates: Proposals,
    reflection: Vec<Experience>,
    proposed: Mutex<Vec<(usize, usize)>>,
    reflected: AtomicUsize,
}

impl Proposer for Proposing {
    fn propose(
        &self,
        _task: &Task,
        base: &Version,
        _baseline: &Execution,
        lessons: &[Experience],
        count: usize,
    ) -> Pending<'_, Vec<Candidate>> {
        self.proposed.lock().unwrap().push((count, lessons.len()));
        let candidates = (self.candidates)(base);
        Box::pin(async move { Ok(candidates) })
    }
    fn compose(
        &self,
        _task: &Task,
        _base: &Version,
        _baseline: &Execution,
        _probes: &[Execution],
        candidates: &[Candidate],
    ) -> Pending<'_, Composition> {
        let edits = candidates
            .iter()
            .flat_map(|candidate| candidate.edits.clone())
            .collect::<Vec<_>>();
        Box::pin(async move { Ok(win(&edits)) })
    }
    fn reflect(
        &self,
        _task: &Task,
        _completion: &Completion,
        _composition: Option<&Composition>,
        _lessons: &[Experience],
    ) -> Pending<'_, Vec<Experience>> {
        self.reflected.fetch_add(1, Ordering::SeqCst);
        let reflection = self.reflection.clone();
        Box::pin(async move { Ok(reflection) })
    }
}

struct Probing {
    baseline: Execution,
    tokens: u64,
    baselines: AtomicUsize,
    probed: Mutex<Vec<(String, Budget)>>,
    in_flight: AtomicUsize,
    widest: AtomicUsize,
}

impl Prober for Probing {
    fn baseline(
        &self,
        _task: &Task,
        _harness: &Harness,
        _budget: Budget,
    ) -> Pending<'_, (Execution, Replay)> {
        self.baselines.fetch_add(1, Ordering::SeqCst);
        let baseline = self.baseline.clone();
        Box::pin(async move { Ok((baseline, Replay { performed: vec![] })) })
    }
    fn probe(
        &self,
        _task: &Task,
        candidate: &Candidate,
        _replay: &Replay,
        budget: Budget,
    ) -> Pending<'_, Execution> {
        let id = candidate.id.clone();
        self.probed.lock().unwrap().push((id.clone(), budget));
        Box::pin(async move {
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.widest.fetch_max(now, Ordering::SeqCst);
            tokio::task::yield_now().await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(execution(&id, Outcome::Completed, self.tokens, 10, vec![]))
        })
    }
}

struct Racing {
    inner: FileVersions,
    rival: Mutex<Option<Version>>,
}

impl Versions for Racing {
    fn current(&self) -> Pending<'_, Version> {
        self.inner.current()
    }
    fn get(&self, id: &VersionId) -> Pending<'_, Option<Version>> {
        self.inner.get(id)
    }
    fn publish(&self, version: Version, expected: &VersionId) -> Pending<'_, ()> {
        let rival = self.rival.lock().unwrap().take();
        let expected = expected.clone();
        Box::pin(async move {
            if let Some(rival) = rival {
                self.inner.publish(rival, &expected).await?;
            }
            self.inner.publish(version, &expected).await
        })
    }
}

fn session_id() -> session::Id {
    session::Id::new("ses_harness").unwrap()
}

fn task() -> Task {
    Task {
        session: session_id(),
        agent: "build".into(),
        text: "fix the flaky linker step".into(),
        domains: vec![],
    }
}

fn ceiling() -> Ceiling {
    Ceiling {
        skills: ["debug-tool".to_owned()].into(),
        agents: ["reviewer".to_owned()].into(),
        plugins: Default::default(),
        scripts: Default::default(),
        max_item_bytes: 200,
        max_items: 8,
    }
}

fn edit(component: Component, key: &str, content: &str) -> Edit {
    Edit {
        component,
        key: key.into(),
        op: Op::Set(content.into()),
        origin: Origin::General,
        rationale: "retries repeated on the same tool error".into(),
    }
}

fn removal(component: Component, key: &str) -> Edit {
    Edit {
        op: Op::Remove,
        ..edit(component, key, "")
    }
}

fn candidate(id: &str, base: &Version, edits: Vec<Edit>) -> Candidate {
    Candidate {
        id: id.into(),
        origin: Origin::General,
        base: base.id.clone(),
        harness: Harness::default(),
        edits,
    }
}

fn win(edits: &[Edit]) -> Composition {
    Composition {
        kept: edits.to_vec(),
        dropped: vec![],
        contrasts: edits
            .iter()
            .map(|edit| Contrast {
                edit: edit.clone(),
                better: vec!["probe".into()],
                worse: vec![],
                observation: "the tool error stopped repeating".into(),
            })
            .collect(),
    }
}

fn execution(
    candidate: &str,
    outcome: Outcome,
    tokens: u64,
    latency_ms: u64,
    signals: Vec<(Signal, u32)>,
) -> Execution {
    Execution {
        candidate: candidate.into(),
        outcome,
        tokens,
        latency_ms,
        steps: 3,
        signals,
        summary: String::new(),
    }
}

fn failing() -> Execution {
    execution(
        "baseline",
        Outcome::Failed("linker exited 1".into()),
        100,
        50,
        vec![(Signal::Retry, 3)],
    )
}

struct Rig {
    _dir: Dir,
    directory: PathBuf,
    engine: Engine,
    events: Arc<Recorder>,
    proposing: Arc<Proposing>,
    probing: Arc<Probing>,
    notes: Arc<Notes>,
    versions: Arc<dyn Versions>,
}

struct Setup {
    settings: Settings,
    baseline: Execution,
    tokens: u64,
    candidates: Proposals,
    reflection: Vec<Experience>,
    lessons: Vec<Experience>,
    rival: Option<Version>,
}

impl Setup {
    fn new(candidates: Proposals) -> Self {
        Self {
            settings: Settings::default(),
            baseline: failing(),
            tokens: 10,
            candidates,
            reflection: vec![],
            lessons: vec![],
            rival: None,
        }
    }

    fn rig(self) -> Rig {
        let dir = Dir::new();
        let directory = dir.0.join("versions");
        let events = Arc::new(Recorder(Mutex::default()));
        let proposing = Arc::new(Proposing {
            candidates: self.candidates,
            reflection: self.reflection,
            proposed: Mutex::default(),
            reflected: AtomicUsize::new(0),
        });
        let probing = Arc::new(Probing {
            baseline: self.baseline,
            tokens: self.tokens,
            baselines: AtomicUsize::new(0),
            probed: Mutex::default(),
            in_flight: AtomicUsize::new(0),
            widest: AtomicUsize::new(0),
        });
        let notes = Arc::new(Notes {
            recorded: Mutex::default(),
            recall: self.lessons,
        });
        let versions: Arc<dyn Versions> = match self.rival {
            Some(rival) => Arc::new(Racing {
                inner: FileVersions::new(&directory),
                rival: Mutex::new(Some(rival)),
            }),
            None => Arc::new(FileVersions::new(&directory)),
        };
        let engine = Engine::with_clock(
            self.settings,
            Parts {
                proposer: proposing.clone(),
                prober: probing.clone(),
                versions: versions.clone(),
                experiences: notes.clone(),
                events: events.clone(),
            },
            Box::new(|| 1_795_000_000_000),
        );
        Rig {
            _dir: dir,
            directory,
            engine,
            events,
            proposing,
            probing,
            notes,
            versions,
        }
    }
}

fn single(edits: Vec<Edit>) -> Proposals {
    Box::new(move |base| vec![candidate("c1", base, edits.clone())])
}

fn lesson() -> Experience {
    Experience {
        id: "linker-order".into(),
        strategy: Strategy::Success,
        cue: "linker fails with undefined symbols".into(),
        lesson: "Reorder the libraries before retrying.".into(),
        evidence: vec!["session ses_old step 4".into()],
        confidence: 0.8,
        basis: Basis::Observed,
        applicability: Applicability::default(),
        change: None,
    }
}

fn completion(outcome: Outcome) -> Completion {
    Completion {
        version: rules::genesis().id,
        execution: execution("final", outcome, 10, 10, vec![]),
        reached: Stage::Adopt,
    }
}

#[tokio::test]
async fn disabled_mode_returns_the_current_version_and_runs_nothing() {
    let mut setup = Setup::new(single(vec![edit(Component::SystemPrompt, "p", "x")]));
    setup.settings.mode = Mode::Disabled;
    setup.reflection = vec![lesson()];
    let rig = setup.rig();
    let prepared = rig.engine.prepare(task(), ceiling()).await.unwrap();
    assert_eq!(prepared.version, rules::genesis());
    assert!(prepared.adopted.is_empty() && prepared.baseline.is_none());
    assert_eq!(rig.probing.baselines.load(Ordering::SeqCst), 0);
    assert_eq!(rig.events.details(), [Detail::Skipped("disabled".into())]);
    let reflection = rig
        .engine
        .reflect(task(), completion(Outcome::Failed("x".into())))
        .await
        .unwrap();
    assert!(reflection.experiences.is_empty());
    assert_eq!(rig.proposing.reflected.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn zero_budget_is_refused() {
    let mut setup = Setup::new(single(vec![]));
    setup.settings.max_tokens = 0;
    let rig = setup.rig();
    assert!(matches!(
        rig.engine.prepare(task(), ceiling()).await,
        Err(Error::Budget(_))
    ));
}

#[tokio::test]
async fn adaptive_mode_skips_when_the_baseline_is_sufficient() {
    let mut setup = Setup::new(single(vec![edit(Component::SystemPrompt, "p", "x")]));
    setup.baseline = execution(
        "baseline",
        Outcome::Completed,
        100,
        50,
        vec![(Signal::Retry, 1)],
    );
    let rig = setup.rig();
    let prepared = rig.engine.prepare(task(), ceiling()).await.unwrap();
    assert_eq!(prepared.version, rules::genesis());
    assert!(prepared.baseline.is_some() && prepared.probes.is_empty());
    assert!(rig.proposing.proposed.lock().unwrap().is_empty());
    assert_eq!(
        rig.events.details(),
        [
            Detail::Baseline {
                signals: 1,
                insufficient: false
            },
            Detail::Skipped("baseline-sufficient".into())
        ]
    );
    let reflection = rig
        .engine
        .reflect(task(), completion(Outcome::Completed))
        .await
        .unwrap();
    assert!(reflection.experiences.is_empty());
    assert_eq!(rig.proposing.reflected.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn adaptive_mode_adopts_a_probed_improvement_as_a_persisted_child_version() {
    let edits = vec![edit(
        Component::SystemPrompt,
        "retry",
        "Stop repeating failing tools.",
    )];
    let mut setup = Setup::new(single(edits.clone()));
    setup.lessons = vec![lesson()];
    let rig = setup.rig();
    let genesis = rules::genesis();
    let prepared = rig.engine.prepare(task(), ceiling()).await.unwrap();
    assert_eq!(prepared.adopted, edits);
    assert_eq!(prepared.version.parent, Some(genesis.id.clone()));
    assert_eq!(prepared.version.edits, edits);
    assert_eq!(prepared.version.created_at, 1_795_000_000_000);
    assert_eq!(prepared.version.task.as_deref(), Some("ses_harness"));
    assert_eq!(
        prepared.version.harness.items[&Component::SystemPrompt][0].content,
        "Stop repeating failing tools."
    );
    assert_eq!(
        prepared.version.id,
        rules::identify(Some(&genesis.id), &prepared.version.harness)
    );
    assert_eq!(prepared.baseline, Some(failing()));
    assert_eq!(prepared.probes.len(), 1);
    assert_eq!(*rig.proposing.proposed.lock().unwrap(), [(1, 1)]);
    assert_eq!(
        rig.events.details(),
        [
            Detail::Baseline {
                signals: 3,
                insufficient: true
            },
            Detail::Proposed { candidates: 1 },
            Detail::Probed {
                candidate: "c1".into(),
                outcome: "completed".into(),
                tokens: 10,
                latency_ms: 10
            },
            Detail::Composed {
                kept: 1,
                dropped: 0
            },
            Detail::Adopted {
                version: prepared.version.id.clone(),
                parent: genesis.id.clone()
            },
        ]
    );
    assert_eq!(
        rig.events.stages(),
        [
            Stage::Baseline,
            Stage::Propose,
            Stage::Probe,
            Stage::Compose,
            Stage::Adopt
        ]
    );
    assert_eq!(rig.engine.current().await.unwrap(), prepared.version);
    let reopened = FileVersions::new(&rig.directory);
    assert_eq!(reopened.current().await.unwrap(), prepared.version);
    assert_eq!(
        reopened.get(&genesis.id).await.unwrap(),
        Some(genesis.clone())
    );
}

#[tokio::test]
async fn candidates_outside_the_ceiling_are_never_probed() {
    let mut setup = Setup::new(Box::new(|base| {
        vec![
            candidate(
                "ghost-skill",
                base,
                vec![edit(Component::Skills, "ghost", "x")],
            ),
            candidate(
                "missing",
                base,
                vec![removal(Component::ToolGuidance, "nothing")],
            ),
            candidate(
                "oversize",
                base,
                vec![edit(Component::Memory, "m", &"x".repeat(201))],
            ),
            candidate("unsafe", base, vec![removal(Component::Guardrails, "g")]),
            Candidate {
                base: VersionId("hv_other".into()),
                ..candidate("wrong-base", base, vec![edit(Component::Memory, "m", "x")])
            },
            candidate("empty", base, vec![]),
            candidate(
                "allowed",
                base,
                vec![edit(Component::Skills, "debug-tool", "Use it.")],
            ),
        ]
    }));
    setup.settings.steps = 7;
    setup.settings.max_concurrency = 7;
    let rig = setup.rig();
    let prepared = rig.engine.prepare(task(), ceiling()).await.unwrap();
    let probed = rig
        .probing
        .probed
        .lock()
        .unwrap()
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    assert_eq!(probed, ["allowed"]);
    assert_eq!(prepared.adopted.len(), 1);
    assert!(
        rig.events
            .details()
            .contains(&Detail::Proposed { candidates: 1 })
    );
}

#[tokio::test]
async fn proposals_beyond_the_step_count_are_truncated_before_probing() {
    let mut setup = Setup::new(Box::new(|base| {
        (0..3)
            .map(|n| {
                candidate(
                    &format!("c{n}"),
                    base,
                    vec![edit(Component::Memory, &format!("m{n}"), "x")],
                )
            })
            .collect()
    }));
    setup.settings.steps = 2;
    let rig = setup.rig();
    rig.engine.prepare(task(), ceiling()).await.unwrap();
    assert_eq!(*rig.proposing.proposed.lock().unwrap(), [(2, 0)]);
    assert_eq!(rig.probing.probed.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn only_authorized_edits_with_contrast_evidence_from_probed_candidates_are_kept() {
    struct Mixed(Proposing);
    impl Proposer for Mixed {
        fn propose(
            &self,
            task: &Task,
            base: &Version,
            baseline: &Execution,
            lessons: &[Experience],
            count: usize,
        ) -> Pending<'_, Vec<Candidate>> {
            self.0.propose(task, base, baseline, lessons, count)
        }
        fn compose(
            &self,
            _task: &Task,
            _base: &Version,
            _baseline: &Execution,
            _probes: &[Execution],
            candidates: &[Candidate],
        ) -> Pending<'_, Composition> {
            let probed = candidates[0].edits.clone();
            let unprobed = edit(Component::Memory, "unprobed", "x");
            let mut composition = win(&probed);
            composition.kept.push(unprobed);
            composition.contrasts[1].better.clear();
            Box::pin(async move { Ok(composition) })
        }
        fn reflect(
            &self,
            task: &Task,
            completion: &Completion,
            composition: Option<&Composition>,
            lessons: &[Experience],
        ) -> Pending<'_, Vec<Experience>> {
            self.0.reflect(task, completion, composition, lessons)
        }
    }
    let edits = vec![
        edit(Component::SystemPrompt, "good", "x"),
        edit(Component::ToolGuidance, "unproven", "x"),
    ];
    let setup = Setup::new(single(edits.clone()));
    let rig = setup.rig();
    let mixed = Arc::new(Mixed(Proposing {
        candidates: single(edits.clone()),
        reflection: vec![],
        proposed: Mutex::default(),
        reflected: AtomicUsize::new(0),
    }));
    let engine = Engine::new(
        Settings::default(),
        Parts {
            proposer: mixed,
            prober: rig.probing.clone(),
            versions: rig.versions.clone(),
            experiences: rig.notes.clone(),
            events: rig.events.clone(),
        },
    );
    let prepared = engine.prepare(task(), ceiling()).await.unwrap();
    assert_eq!(prepared.adopted, vec![edits[0].clone()]);
    assert!(rig.events.details().contains(&Detail::Composed {
        kept: 1,
        dropped: 2
    }));
}

#[tokio::test]
async fn guardrails_can_be_added_but_never_replaced_or_removed() {
    let setup = Setup::new(Box::new(|base| {
        let add = edit(Component::Guardrails, "no-force-push", "Never force-push.");
        let edits = if base.harness.items.is_empty() {
            vec![add]
        } else {
            vec![
                edit(
                    Component::Guardrails,
                    "no-force-push",
                    "Force-push is fine.",
                ),
                removal(Component::Guardrails, "no-force-push"),
            ]
        };
        edits
            .into_iter()
            .enumerate()
            .map(|(n, e)| candidate(&format!("g{n}"), base, vec![e]))
            .collect()
    }));
    let mut setup = setup;
    setup.settings.steps = 2;
    let rig = setup.rig();
    let first = rig.engine.prepare(task(), ceiling()).await.unwrap();
    assert_eq!(first.adopted.len(), 1);
    let second = rig.engine.prepare(task(), ceiling()).await.unwrap();
    assert!(second.adopted.is_empty());
    assert_eq!(second.version, first.version);
    assert_eq!(
        rig.events.details().last(),
        Some(&Detail::Skipped("no-candidates".into()))
    );
}

#[tokio::test]
async fn probes_run_concurrently_inside_the_token_budget() {
    let mut setup = Setup::new(Box::new(|base| {
        (0..4)
            .map(|n| {
                candidate(
                    &format!("c{n}"),
                    base,
                    vec![edit(Component::Memory, &format!("m{n}"), "x")],
                )
            })
            .collect()
    }));
    setup.settings.steps = 4;
    setup.settings.max_concurrency = 2;
    setup.settings.max_tokens = 1_000;
    setup.tokens = 450;
    let rig = setup.rig();
    let prepared = rig.engine.prepare(task(), ceiling()).await.unwrap();
    let probed = rig.probing.probed.lock().unwrap().clone();
    assert_eq!(probed.len(), 2);
    assert!(probed.iter().all(|(_, budget)| budget.tokens == 450));
    assert_eq!(rig.probing.widest.load(Ordering::SeqCst), 2);
    assert_eq!(prepared.probes.len(), 2);
    assert_eq!(prepared.adopted.len(), 2);
}

#[tokio::test]
async fn a_rival_publication_wins_and_the_session_continues_on_it() {
    let rival_harness = Harness {
        items: [(
            Component::Memory,
            vec![ycoding_core::harness::Item {
                key: "rival".into(),
                content: "x".into(),
            }],
        )]
        .into(),
    };
    let genesis = rules::genesis();
    let rival = Version {
        id: rules::identify(Some(&genesis.id), &rival_harness),
        parent: Some(genesis.id.clone()),
        harness: rival_harness,
        edits: vec![],
        created_at: 1,
        task: None,
    };
    let mut setup = Setup::new(single(vec![edit(Component::SystemPrompt, "p", "x")]));
    setup.rival = Some(rival.clone());
    let rig = setup.rig();
    let prepared = rig.engine.prepare(task(), ceiling()).await.unwrap();
    assert_eq!(prepared.version, rival);
    assert!(prepared.adopted.is_empty());
    assert!(matches!(
        rig.events.details().last(),
        Some(Detail::Skipped(reason)) if reason.starts_with("conflict")
    ));
    assert_eq!(rig.engine.current().await.unwrap(), rival);
}

#[tokio::test]
async fn sequential_mode_builds_on_each_round_and_publishes_once() {
    let mut setup = Setup::new(Box::new(|base| {
        let edit = if base.parent.is_none() {
            edit(Component::SystemPrompt, "first", "one")
        } else {
            edit(Component::ToolGuidance, "second", "two")
        };
        vec![candidate(
            &format!("round-{}", base.edits.len()),
            base,
            vec![edit],
        )]
    }));
    setup.settings.mode = Mode::Sequential;
    setup.settings.max_depth = 2;
    let rig = setup.rig();
    let genesis = rules::genesis();
    let prepared = rig.engine.prepare(task(), ceiling()).await.unwrap();
    assert_eq!(rig.probing.baselines.load(Ordering::SeqCst), 2);
    assert_eq!(prepared.version.parent, Some(genesis.id.clone()));
    assert_eq!(prepared.adopted.len(), 2);
    assert_eq!(prepared.version.edits, prepared.adopted);
    assert_eq!(prepared.version.harness.items.len(), 2);
    assert_eq!(
        fs::read_dir(rig.directory.join("versions"))
            .unwrap()
            .count(),
        1
    );
    let adoptions = rig
        .events
        .details()
        .into_iter()
        .filter(|detail| matches!(detail, Detail::Adopted { .. }))
        .count();
    assert_eq!(adoptions, 1);
}

#[tokio::test]
async fn rollback_repoints_to_a_stored_version_and_rejects_unknown_ones() {
    let rig = Setup::new(single(vec![edit(Component::SystemPrompt, "p", "x")])).rig();
    let genesis = rules::genesis();
    let adopted = rig.engine.prepare(task(), ceiling()).await.unwrap().version;
    let restored = rig.engine.rollback(genesis.id.clone()).await.unwrap();
    assert_eq!(restored, genesis);
    assert_eq!(rig.engine.current().await.unwrap(), genesis);
    assert_eq!(
        rig.events.details().last(),
        Some(&Detail::RolledBack {
            from: adopted.id.clone(),
            to: genesis.id.clone()
        })
    );
    assert_eq!(
        rig.engine.rollback(adopted.id.clone()).await.unwrap(),
        adopted
    );
    let unknown = VersionId(format!("hv_{}", "0".repeat(32)));
    assert!(matches!(
        rig.engine.rollback(unknown).await,
        Err(Error::Invalid(_))
    ));
}

#[tokio::test]
async fn reflection_records_only_supported_lessons_and_marks_guesses_as_assumed() {
    let mut observed = lesson();
    observed.id = "Linker Order!".into();
    observed.strategy = Strategy::Failure;
    let mut guess = lesson();
    guess.id = "guess".into();
    guess.strategy = Strategy::Failure;
    guess.evidence = vec![];
    guess.confidence = 0.9;
    let mut unsupported_success = lesson();
    unsupported_success.id = "unsupported".into();
    let mut failure = lesson();
    failure.id = "failure".into();
    failure.strategy = Strategy::Failure;
    failure.confidence = f32::NAN;
    failure.change = Some(Change {
        version: rules::genesis().id,
        edits: vec!["system-prompt retry".into()],
    });
    let mut empty = lesson();
    empty.lesson = "  ".into();
    let mut setup = Setup::new(single(vec![]));
    setup.reflection = vec![observed, guess, unsupported_success, failure, empty];
    let rig = setup.rig();
    let reflection = rig
        .engine
        .reflect(
            task(),
            completion(Outcome::Failed("linker exited 1".into())),
        )
        .await
        .unwrap();
    let recorded = rig.notes.recorded.lock().unwrap().clone();
    assert_eq!(recorded, reflection.experiences);
    let by_id = recorded
        .iter()
        .map(|e| (e.id.as_str(), e))
        .collect::<HashMap<_, _>>();
    assert_eq!(by_id.len(), 3);
    assert_eq!(by_id["guess"].basis, Basis::Assumed);
    assert_eq!(by_id["guess"].confidence, 0.5);
    assert_eq!(by_id["linker-order"].basis, Basis::Observed);
    assert_eq!(by_id["linker-order"].confidence, 0.8);
    assert_eq!(by_id["failure"].confidence, 0.0);
    assert!(!by_id.contains_key("empty"));
    assert_eq!(
        rig.events.details(),
        [Detail::Reflected {
            experiences: recorded.iter().map(|e| e.id.clone()).collect()
        }]
    );
}

struct Memory {
    _dir: Dir,
    service: Arc<Service>,
}

fn memory() -> Memory {
    let dir = Dir::new();
    fs::create_dir_all(dir.0.join("workspace/.git")).unwrap();
    let service = Service::with_clock(
        Options {
            directory: dir.0.join("workspace"),
            home: dir.0.clone(),
            data: dir.0.join("data"),
            repository: Some(Repository {
                directory: dir.0.join("workspace"),
                common_directory: dir.0.join("workspace/.git"),
                worktrees: vec![dir.0.join("workspace")],
            }),
            limits: Limits::default(),
        },
        Box::new(|| chrono::DateTime::from_timestamp(1_795_000_000, 0).unwrap()),
    )
    .unwrap();
    Memory {
        _dir: dir,
        service: Arc::new(service),
    }
}

#[tokio::test]
async fn experiences_round_trip_through_the_okf_memory_store() {
    let memory = memory();
    let notes = MemoryExperiences::new(memory.service.clone(), Scope::Repository);
    let mut observed = lesson();
    observed.applicability = Applicability {
        domains: vec!["rust".into()],
        components: vec![Component::ToolGuidance],
        agents: vec!["build".into()],
    };
    observed.change = Some(Change {
        version: rules::genesis().id,
        edits: vec!["tool-guidance linker".into()],
    });
    let mut guess = lesson();
    guess.id = "guess".into();
    guess.cue = "linker output is truncated by the terminal".into();
    guess.strategy = Strategy::Failure;
    guess.basis = Basis::Assumed;
    guess.evidence = vec![];
    guess.confidence = 0.4;
    notes.record(observed.clone()).await.unwrap();
    notes.record(guess.clone()).await.unwrap();
    notes.record(observed.clone()).await.unwrap();
    let mut asking = task();
    asking.text = "the linker fails with undefined symbols again".into();
    asking.domains = vec!["rust".into()];
    let recalled = notes.recall(&asking, 5).await.unwrap();
    assert!(recalled.contains(&observed));
    assert!(
        recalled
            .iter()
            .find(|e| e.id == "guess")
            .is_none_or(|e| *e == guess && e.basis == Basis::Assumed)
    );
    asking.agent = "reviewer".into();
    assert!(
        !notes
            .recall(&asking, 5)
            .await
            .unwrap()
            .iter()
            .any(|e| e.id == observed.id)
    );
    asking.text = "   ".into();
    assert!(notes.recall(&asking, 5).await.unwrap().is_empty());
}

#[tokio::test]
async fn the_version_store_refuses_stale_forged_and_malformed_publications() {
    let dir = Dir::new();
    let store = FileVersions::new(dir.0.join("store"));
    let genesis = rules::genesis();
    let harness = rules::apply(&Harness::default(), &[edit(Component::Memory, "m", "x")]);
    let child = Version {
        id: rules::identify(Some(&genesis.id), &harness),
        parent: Some(genesis.id.clone()),
        harness,
        edits: vec![edit(Component::Memory, "m", "x")],
        created_at: 5,
        task: None,
    };
    let stale = VersionId(format!("hv_{}", "1".repeat(32)));
    assert!(matches!(
        store.publish(child.clone(), &stale).await,
        Err(Error::Conflict(_))
    ));
    let forged = Version {
        id: VersionId(format!("hv_{}", "2".repeat(32))),
        ..child.clone()
    };
    assert!(matches!(
        store.publish(forged, &genesis.id).await,
        Err(Error::Invalid(_))
    ));
    let orphan = Version {
        parent: Some(stale),
        ..child.clone()
    };
    assert!(matches!(
        store.publish(orphan, &genesis.id).await,
        Err(Error::Invalid(_))
    ));
    assert!(matches!(
        store.get(&VersionId("../escape".into())).await,
        Err(Error::Invalid(_))
    ));
    store.publish(child.clone(), &genesis.id).await.unwrap();
    assert_eq!(store.current().await.unwrap(), child);
    assert!(matches!(
        store.publish(child, &genesis.id).await,
        Err(Error::Conflict(_))
    ));
}
