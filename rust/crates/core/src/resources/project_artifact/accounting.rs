use ring::hmac;
use std::collections::{BTreeMap, BTreeSet};

const DAY: f64 = 86_400_000.0;
mod persistence;
pub use persistence::{
    CohortInput, CohortResult, CohortScope, DecideResult, ObserveInput, Service,
};
#[derive(Clone, Copy)]
pub struct Outcome<'a> {
    pub active_artifact_count: f64,
    pub standard_invocation_count: f64,
    pub external_confounded: bool,
    pub terminal_outcome: &'a str,
    pub goal_status: &'a str,
}
pub fn eligible(input: &Outcome<'_>) -> bool {
    input.active_artifact_count == 1.0
        && input.standard_invocation_count == 0.0
        && !input.external_confounded
        && input.terminal_outcome != "interrupted"
        && input.goal_status != "stopped"
}
pub fn reward(terminal_outcome: &str, goal_status: &str, repeat_fix: bool) -> f64 {
    if terminal_outcome == "interrupted" || goal_status == "stopped" {
        return 0.0;
    }
    let base: f64 = if terminal_outcome == "failed" || goal_status == "exhausted" {
        -1.0
    } else if goal_status == "completed" {
        1.0
    } else {
        0.25
    };
    (base - if repeat_fix { 0.5 } else { 0.0 }).max(-1.0)
}
pub fn penalty(action: &str) -> f64 {
    match action {
        "disable" => 4.0,
        "revert" => 5.0,
        "delete" => 6.0,
        _ => 0.0,
    }
}
pub fn score(reward_units: f64, penalty_units: f64) -> f64 {
    if !reward_units.is_finite()
        || !penalty_units.is_finite()
        || reward_units < 0.0
        || penalty_units < 0.0
    {
        return 0.0;
    }
    (reward_units - penalty_units) / (reward_units + penalty_units).max(1.0)
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Interval {
    pub lower_bound: f64,
    pub upper_bound: f64,
}
pub fn wilson(sample_count: f64, success_count: f64) -> Interval {
    if !valid_sample_counts(SampleCounts {
        sample_count,
        success_count,
    }) || sample_count == 0.0
    {
        return Interval {
            lower_bound: 0.0,
            upper_bound: 1.0,
        };
    }
    let z = 1.96;
    let ratio = success_count / sample_count;
    let denominator = 1.0 + (z * z) / sample_count;
    let center = ratio + (z * z) / (2.0 * sample_count);
    let margin =
        z * ((ratio * (1.0 - ratio) + (z * z) / (4.0 * sample_count)) / sample_count).sqrt();
    Interval {
        lower_bound: (center - margin) / denominator,
        upper_bound: (center + margin) / denominator,
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ProjectBucketSample {
    pub sample_id: String,
    pub bucket_id: String,
}
#[derive(Debug, PartialEq)]
pub struct ProjectBucketTotal {
    pub bucket_id: String,
    pub eligible_total: usize,
}
pub fn project_bucket(key: &str, project_id: &str) -> String {
    hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes()),
        project_id.as_bytes(),
    )
    .as_ref()
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect()
}
pub fn project_bucket_totals(samples: &[ProjectBucketSample]) -> Vec<ProjectBucketTotal> {
    let mut totals = BTreeMap::new();
    for sample in samples {
        *totals.entry(sample.bucket_id.clone()).or_insert(0) += 1;
    }
    totals
        .into_iter()
        .map(|(bucket_id, eligible_total)| ProjectBucketTotal {
            bucket_id,
            eligible_total,
        })
        .collect()
}
pub fn global_confidence(candidate_sample_count: f64, samples: &[ProjectBucketSample]) -> bool {
    if !candidate_sample_count.is_finite()
        || candidate_sample_count.fract() != 0.0
        || candidate_sample_count < 30.0
        || samples.len() as f64 != candidate_sample_count
    {
        return false;
    }
    if samples
        .iter()
        .any(|sample| sample.sample_id.is_empty() || sample.bucket_id.is_empty())
        || samples
            .iter()
            .map(|sample| &sample.sample_id)
            .collect::<BTreeSet<_>>()
            .len()
            != samples.len()
    {
        return false;
    }
    let buckets = project_bucket_totals(samples);
    buckets.len() >= 3
        && buckets
            .iter()
            .map(|bucket| bucket.eligible_total)
            .max()
            .is_some_and(|total| total as f64 / candidate_sample_count <= 0.5)
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GovernorState {
    pub first_qualified_at: Option<f64>,
}
#[derive(Debug, PartialEq)]
pub struct GovernorTransition {
    pub action: &'static str,
    pub state: GovernorState,
}
pub struct GovernorTransitionInput<'a> {
    pub stage: &'a str,
    pub created_at: f64,
    pub last_transition_at: f64,
    pub restored_at: Option<f64>,
    pub state: GovernorState,
    pub now: f64,
    pub qualifies: bool,
    pub action: &'static str,
}
pub fn governor_transition(input: &GovernorTransitionInput<'_>) -> GovernorTransition {
    if !input.qualifies
        || input.now - input.created_at < 7.0 * DAY
        || input
            .restored_at
            .is_some_and(|at| input.now - at < 7.0 * DAY)
        || (input.action == "degrade" && input.now - input.last_transition_at < 7.0 * DAY)
    {
        return none();
    }
    let Some(first) = input.state.first_qualified_at else {
        return GovernorTransition {
            action: "none",
            state: GovernorState {
                first_qualified_at: Some(input.now),
            },
        };
    };
    if input.now - first < DAY {
        return GovernorTransition {
            action: "none",
            state: input.state,
        };
    }
    GovernorTransition {
        action: input.action,
        state: GovernorState {
            first_qualified_at: None,
        },
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SampleCounts {
    pub sample_count: f64,
    pub success_count: f64,
}
#[derive(Clone, Copy)]
pub struct DecisionInput<'a> {
    pub stage: &'a str,
    pub created_at: f64,
    pub last_transition_at: f64,
    pub restored_at: Option<f64>,
    pub state: GovernorState,
    pub now: f64,
    pub candidate: SampleCounts,
    pub baseline: Option<SampleCounts>,
    pub explicit_negative: bool,
    pub global: bool,
    pub global_samples: &'a [ProjectBucketSample],
}
pub fn decision(input: &DecisionInput<'_>) -> GovernorTransition {
    let minimum_samples = if input.global && input.stage == "active" {
        30.0
    } else {
        20.0
    };
    if input.explicit_negative
        || !valid_sample_counts(input.candidate)
        || input.candidate.sample_count < minimum_samples
        || input
            .baseline
            .is_some_and(|baseline| !valid_sample_counts(baseline))
    {
        return none();
    }
    let candidate = wilson(input.candidate.sample_count, input.candidate.success_count);
    let baseline = input
        .baseline
        .filter(|baseline| baseline.sample_count >= 30.0)
        .map(|baseline| wilson(baseline.sample_count, baseline.success_count));
    let boundary = GovernorTransitionInput {
        stage: input.stage,
        created_at: input.created_at,
        last_transition_at: input.last_transition_at,
        restored_at: input.restored_at,
        state: input.state,
        now: input.now,
        qualifies: true,
        action: "degrade",
    };
    if baseline.is_some_and(|baseline| {
        input.candidate.sample_count - input.candidate.success_count >= 5.0
            && candidate.upper_bound + 0.1 < baseline.lower_bound
            && (!input.global
                || global_confidence(input.candidate.sample_count, input.global_samples))
    }) {
        return governor_transition(&boundary);
    }
    if input.stage == "active" {
        return none();
    }
    governor_transition(&GovernorTransitionInput {
        qualifies: candidate.lower_bound >= 0.6
            && baseline.is_none_or(|baseline| candidate.lower_bound + 0.1 >= baseline.lower_bound),
        action: "activate",
        ..boundary
    })
}
fn valid_sample_counts(input: SampleCounts) -> bool {
    input.sample_count.is_finite()
        && input.success_count.is_finite()
        && input.sample_count.fract() == 0.0
        && input.success_count.fract() == 0.0
        && input.sample_count >= 0.0
        && input.success_count >= 0.0
        && input.success_count <= input.sample_count
}
fn none() -> GovernorTransition {
    GovernorTransition {
        action: "none",
        state: GovernorState {
            first_qualified_at: None,
        },
    }
}
