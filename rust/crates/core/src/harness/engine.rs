use super::{
    Basis, Budget, Candidate, Ceiling, Completion, Composition, Controller, Detail, Edit, Error,
    Event, Events, Execution, Experience, Experiences, Mode, Outcome, Pending, Prepared, Prober,
    Proposer, Reflection, Replay, Settings, Stage, Strategy, Task, Version, VersionId, Versions,
    rules, service::effective,
};
use crate::resources::memory::format::sha256;
use std::{
    collections::{BTreeSet, HashMap},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::Poll,
};
use ycoding_schema::session;

const ASSUMED_CONFIDENCE: f32 = 0.5;
const ID_CHARS: usize = 60;

pub struct Parts {
    pub proposer: Arc<dyn Proposer>,
    pub prober: Arc<dyn Prober>,
    pub versions: Arc<dyn Versions>,
    pub experiences: Arc<dyn Experiences>,
    pub events: Arc<dyn Events>,
}

pub struct Engine {
    settings: Settings,
    parts: Parts,
    clock: Box<dyn Fn() -> i64 + Send + Sync>,
    compositions: Mutex<HashMap<session::Id, Composition>>,
}

#[derive(Clone, Copy, Default)]
struct Spent {
    tokens: u64,
    latency_ms: u64,
}

struct Run {
    task: Task,
    ceiling: Ceiling,
    lessons: Vec<Experience>,
    budget: Budget,
    spent: Spent,
    baseline: Option<Execution>,
    probes: Vec<Execution>,
    composition: Option<Composition>,
}

impl Run {
    fn left(&self) -> Budget {
        Budget {
            tokens: self.budget.tokens.saturating_sub(self.spent.tokens),
            latency_ms: self.budget.latency_ms.saturating_sub(self.spent.latency_ms),
            ..self.budget
        }
    }
}

enum Round {
    Kept(Vec<Edit>),
    Stopped(Stage, &'static str),
}

impl Engine {
    pub fn new(settings: Settings, parts: Parts) -> Self {
        Self::with_clock(
            settings,
            parts,
            Box::new(|| chrono::Utc::now().timestamp_millis()),
        )
    }

    pub fn with_clock(
        settings: Settings,
        parts: Parts,
        clock: Box<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            settings,
            parts,
            clock,
            compositions: Mutex::new(HashMap::new()),
        }
    }

    fn emit(&self, session: &session::Id, stage: Stage, detail: Detail) {
        self.parts.events.emit(Event {
            session: session.clone(),
            stage,
            mode: self.settings.mode,
            detail,
        });
    }

    fn skipped(
        &self,
        run: Option<Run>,
        task: &Task,
        stage: Stage,
        reason: impl Into<String>,
        version: Version,
    ) -> Prepared {
        self.emit(&task.session, stage, Detail::Skipped(reason.into()));
        Prepared {
            version,
            adopted: Vec::new(),
            baseline: run.as_ref().and_then(|run| run.baseline.clone()),
            probes: run.map(|run| run.probes).unwrap_or_default(),
        }
    }

    async fn run(&self, task: Task, ceiling: Ceiling) -> Result<Prepared, Error> {
        let origin = self.parts.versions.current().await?;
        if self.settings.mode == Mode::Disabled {
            return Ok(self.skipped(None, &task, Stage::Baseline, "disabled", origin));
        }
        let budget = effective(&self.settings);
        if exhausted(&budget) {
            return Err(Error::Budget("no tokens or latency are allowed".into()));
        }
        let lessons = self
            .parts
            .experiences
            .recall(&task, self.settings.recall_limit)
            .await
            .unwrap_or_default();
        let mut run = Run {
            task,
            ceiling,
            lessons,
            budget,
            spent: Spent::default(),
            baseline: None,
            probes: Vec::new(),
            composition: None,
        };
        let rounds = if self.settings.mode == Mode::Sequential {
            budget.depth.max(1)
        } else {
            1
        };
        let mut working = origin.clone();
        let mut adopted: Vec<Edit> = Vec::new();
        let mut stopped = (Stage::Compose, "no-improvement");
        for _ in 0..rounds {
            match self.round(&mut run, &working).await? {
                Round::Stopped(stage, reason) => {
                    stopped = (stage, reason);
                    break;
                }
                Round::Kept(edits) => {
                    let harness = rules::admit(&run.ceiling, &working.harness, &edits)?;
                    adopted.extend(edits);
                    working = Version {
                        id: rules::identify(Some(&origin.id), &harness),
                        parent: Some(origin.id.clone()),
                        harness,
                        edits: adopted.clone(),
                        created_at: (self.clock)(),
                        task: run.task.session.as_lossless().as_str().map(str::to_owned),
                    };
                }
            }
        }
        if let Some(composition) = run.composition.clone() {
            self.compositions
                .lock()
                .map_err(|_| Error::Unavailable("composition store poisoned".into()))?
                .insert(run.task.session.clone(), composition);
        }
        let task = run.task.clone();
        if adopted.is_empty() {
            return Ok(self.skipped(Some(run), &task, stopped.0, stopped.1, origin));
        }
        if working.harness == origin.harness {
            return Ok(self.skipped(Some(run), &task, Stage::Adopt, "no-change", origin));
        }
        match self
            .parts
            .versions
            .publish(working.clone(), &origin.id)
            .await
        {
            Ok(()) => {
                self.emit(
                    &task.session,
                    Stage::Adopt,
                    Detail::Adopted {
                        version: working.id.clone(),
                        parent: origin.id,
                    },
                );
                Ok(Prepared {
                    version: working,
                    adopted,
                    baseline: run.baseline,
                    probes: run.probes,
                })
            }
            Err(Error::Conflict(reason)) => {
                let current = self.parts.versions.current().await?;
                Ok(self.skipped(
                    Some(run),
                    &task,
                    Stage::Adopt,
                    format!("conflict: {reason}"),
                    current,
                ))
            }
            Err(error) => Err(error),
        }
    }

    async fn round(&self, run: &mut Run, base: &Version) -> Result<Round, Error> {
        let left = run.left();
        if exhausted(&left) {
            return Ok(Round::Stopped(Stage::Probe, "budget-exhausted"));
        }
        let (baseline, replay) = self
            .parts
            .prober
            .baseline(&run.task, &base.harness, left)
            .await?;
        run.spent.tokens += baseline.tokens;
        run.spent.latency_ms += baseline.latency_ms;
        let insufficient = self.insufficient(&baseline);
        self.emit(
            &run.task.session,
            Stage::Baseline,
            Detail::Baseline {
                signals: signals(&baseline),
                insufficient,
            },
        );
        run.baseline.get_or_insert_with(|| baseline.clone());
        if self.settings.mode == Mode::Adaptive && !insufficient {
            return Ok(Round::Stopped(Stage::Baseline, "baseline-sufficient"));
        }
        let proposed = self
            .parts
            .proposer
            .propose(
                &run.task,
                base,
                &baseline,
                &run.lessons,
                self.settings.steps,
            )
            .await?;
        let candidates = screen(proposed, base, &run.ceiling, self.settings.steps);
        self.emit(
            &run.task.session,
            Stage::Propose,
            Detail::Proposed {
                candidates: candidates.len(),
            },
        );
        if candidates.is_empty() {
            return Ok(Round::Stopped(Stage::Propose, "no-candidates"));
        }
        let (probed, executions) = self.probe(run, &replay, candidates).await;
        if executions.is_empty() {
            return Ok(Round::Stopped(Stage::Probe, "no-probe-results"));
        }
        run.probes.extend(executions.iter().cloned());
        let proposal = self
            .parts
            .proposer
            .compose(&run.task, base, &baseline, &executions, &probed)
            .await?;
        let (kept, dropped) = judge(&proposal, &probed, &run.ceiling, &base.harness);
        self.emit(
            &run.task.session,
            Stage::Compose,
            Detail::Composed {
                kept: kept.len(),
                dropped: dropped.len(),
            },
        );
        let composition = run.composition.get_or_insert_with(|| Composition {
            kept: Vec::new(),
            dropped: Vec::new(),
            contrasts: Vec::new(),
        });
        composition.kept.extend(kept.iter().cloned());
        composition.dropped.extend(dropped);
        composition.contrasts.extend(proposal.contrasts);
        Ok(if kept.is_empty() {
            Round::Stopped(Stage::Compose, "no-improvement")
        } else {
            Round::Kept(kept)
        })
    }

    async fn probe(
        &self,
        run: &mut Run,
        replay: &Replay,
        candidates: Vec<Candidate>,
    ) -> (Vec<Candidate>, Vec<Execution>) {
        let mut probed = Vec::new();
        let mut executions = Vec::new();
        for chunk in candidates.chunks(self.settings.max_concurrency.max(1)) {
            let left = run.left();
            let share = Budget {
                tokens: left.tokens / chunk.len() as u64,
                ..left
            };
            if share.tokens == 0 || left.latency_ms == 0 {
                break;
            }
            let results = join_all(
                chunk
                    .iter()
                    .map(|candidate| self.parts.prober.probe(&run.task, candidate, replay, share))
                    .collect(),
            )
            .await;
            let mut slowest = 0;
            for (candidate, result) in chunk.iter().zip(results) {
                let (outcome, tokens, latency_ms) = match &result {
                    Ok(execution) if execution.candidate == candidate.id => (
                        label(&execution.outcome),
                        execution.tokens,
                        execution.latency_ms,
                    ),
                    Ok(execution) => (
                        format!("mismatched-execution: {}", execution.candidate),
                        0,
                        0,
                    ),
                    Err(error) => (format!("error: {error}"), 0, 0),
                };
                self.emit(
                    &run.task.session,
                    Stage::Probe,
                    Detail::Probed {
                        candidate: candidate.id.clone(),
                        outcome,
                        tokens,
                        latency_ms,
                    },
                );
                if let Ok(execution) = result
                    && execution.candidate == candidate.id
                {
                    run.spent.tokens += execution.tokens;
                    slowest = slowest.max(execution.latency_ms);
                    probed.push(candidate.clone());
                    executions.push(execution);
                }
            }
            run.spent.latency_ms += slowest;
        }
        (probed, executions)
    }

    fn insufficient(&self, execution: &Execution) -> bool {
        !matches!(execution.outcome, Outcome::Completed)
            || signals(execution) as usize >= self.settings.min_signals
    }

    async fn learn(&self, task: Task, completion: Completion) -> Result<Reflection, Error> {
        let none = Reflection {
            experiences: Vec::new(),
        };
        if self.settings.mode == Mode::Disabled {
            return Ok(none);
        }
        let composition = self
            .compositions
            .lock()
            .map_err(|_| Error::Unavailable("composition store poisoned".into()))?
            .remove(&task.session);
        let completed = matches!(completion.execution.outcome, Outcome::Completed);
        if self.settings.mode == Mode::Adaptive && completed && composition.is_none() {
            return Ok(none);
        }
        let lessons = self
            .parts
            .experiences
            .recall(&task, self.settings.recall_limit)
            .await
            .unwrap_or_default();
        let drafts = self
            .parts
            .proposer
            .reflect(&task, &completion, composition.as_ref(), &lessons)
            .await?;
        let mut recorded = Vec::new();
        for draft in drafts {
            let Some(experience) = normalize(draft, completed) else {
                continue;
            };
            match self.parts.experiences.record(experience.clone()).await {
                Ok(()) => recorded.push(experience),
                Err(Error::Invalid(_)) => {}
                Err(error) => return Err(error),
            }
        }
        if !recorded.is_empty() {
            self.emit(
                &task.session,
                Stage::Adopt,
                Detail::Reflected {
                    experiences: recorded.iter().map(|e| e.id.clone()).collect(),
                },
            );
        }
        Ok(Reflection {
            experiences: recorded,
        })
    }

    async fn revert(&self, to: VersionId) -> Result<Version, Error> {
        let current = self.parts.versions.current().await?;
        if current.id == to {
            return Ok(current);
        }
        let target = self
            .parts
            .versions
            .get(&to)
            .await?
            .ok_or_else(|| Error::Invalid(format!("unknown version {}", to.0)))?;
        self.parts
            .versions
            .publish(target.clone(), &current.id)
            .await?;
        if let Some(session) = current
            .task
            .and_then(|task| session::Id::new(task.as_str()).ok())
        {
            self.emit(
                &session,
                Stage::Adopt,
                Detail::RolledBack {
                    from: current.id,
                    to: target.id.clone(),
                },
            );
        }
        Ok(target)
    }
}

impl Controller for Engine {
    fn prepare(&self, task: Task, ceiling: Ceiling) -> Pending<'_, Prepared> {
        Box::pin(self.run(task, ceiling))
    }

    fn reflect(&self, task: Task, completion: Completion) -> Pending<'_, Reflection> {
        Box::pin(self.learn(task, completion))
    }

    fn current(&self) -> Pending<'_, Version> {
        self.parts.versions.current()
    }

    fn rollback(&self, to: VersionId) -> Pending<'_, Version> {
        Box::pin(self.revert(to))
    }
}

fn exhausted(budget: &Budget) -> bool {
    budget.tokens == 0 || budget.latency_ms == 0
}

fn signals(execution: &Execution) -> u32 {
    execution
        .signals
        .iter()
        .fold(0, |total, (_, count)| total.saturating_add(*count))
}

fn label(outcome: &Outcome) -> String {
    match outcome {
        Outcome::Completed => "completed".into(),
        Outcome::Failed(reason) => format!("failed: {reason}"),
        Outcome::Abstained => "abstained".into(),
        Outcome::Exhausted => "exhausted".into(),
    }
}

fn screen(
    proposed: Vec<Candidate>,
    base: &Version,
    ceiling: &Ceiling,
    limit: usize,
) -> Vec<Candidate> {
    let mut seen = BTreeSet::new();
    proposed
        .into_iter()
        .take(limit)
        .filter(|candidate| {
            candidate.base == base.id
                && !candidate.edits.is_empty()
                && !candidate.id.trim().is_empty()
                && seen.insert(candidate.id.clone())
        })
        .filter_map(|mut candidate| {
            candidate.harness = rules::admit(ceiling, &base.harness, &candidate.edits).ok()?;
            Some(candidate)
        })
        .collect()
}

fn judge(
    proposal: &Composition,
    probed: &[Candidate],
    ceiling: &Ceiling,
    base: &super::Harness,
) -> (Vec<Edit>, Vec<(Edit, String)>) {
    let mut dropped = proposal.dropped.clone();
    let mut kept = Vec::new();
    let mut harness = base.clone();
    for edit in &proposal.kept {
        let refusal = if !probed
            .iter()
            .any(|candidate| candidate.edits.contains(edit))
        {
            Some("not-probed".to_owned())
        } else if !proposal.contrasts.iter().any(|contrast| {
            contrast.edit == *edit
                && !contrast.better.is_empty()
                && !contrast.observation.trim().is_empty()
        }) {
            Some("no-contrast-evidence".to_owned())
        } else {
            rules::authorize(ceiling, &harness, edit)
                .err()
                .map(|error| error.to_string())
        };
        match refusal {
            Some(reason) => dropped.push((edit.clone(), reason)),
            None => {
                harness = rules::apply(&harness, std::slice::from_ref(edit));
                kept.push(edit.clone());
            }
        }
    }
    if let Err(error) = rules::admit(ceiling, base, &kept) {
        dropped.extend(kept.drain(..).map(|edit| (edit, error.to_string())));
    }
    (kept, dropped)
}

fn slug(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(ID_CHARS)
        .collect::<String>()
        .trim_end_matches('-')
        .to_owned()
}

fn normalize(mut experience: Experience, completed: bool) -> Option<Experience> {
    experience.cue = experience.cue.trim().to_owned();
    experience.lesson = experience.lesson.trim().to_owned();
    if experience.cue.is_empty() || experience.lesson.is_empty() {
        return None;
    }
    if experience.strategy == Strategy::Success && !completed {
        return None;
    }
    let id = slug(&experience.id);
    experience.id = if id.is_empty() {
        format!("exp-{}", &sha256(&experience.cue)[..12])
    } else {
        id
    };
    let mut seen = BTreeSet::new();
    experience.evidence = experience
        .evidence
        .into_iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty() && seen.insert(item.clone()))
        .collect();
    experience.confidence = if experience.confidence.is_finite() {
        experience.confidence.clamp(0.0, 1.0)
    } else {
        0.0
    };
    if experience.evidence.is_empty() {
        experience.basis = Basis::Assumed;
    }
    if experience.basis == Basis::Assumed {
        experience.confidence = experience.confidence.min(ASSUMED_CONFIDENCE);
    }
    Some(experience)
}

async fn join_all<'a, T>(mut pending: Vec<Pending<'a, T>>) -> Vec<Result<T, Error>> {
    let mut done: Vec<Option<Result<T, Error>>> = pending.iter().map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut waiting = false;
        for (future, slot) in pending.iter_mut().zip(done.iter_mut()) {
            if slot.is_none() {
                match Pin::new(&mut *future).poll(cx) {
                    Poll::Ready(value) => *slot = Some(value),
                    Poll::Pending => waiting = true,
                }
            }
        }
        if waiting {
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    })
    .await;
    done.into_iter().flatten().collect()
}
