use super::corpus::Query;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const CUTOFF: usize = 5;

#[derive(Default)]
pub struct Tally {
    pub queries: usize,
    pub positives: usize,
    pub recall: f64,
    pub precision: f64,
    pub reciprocal_rank: f64,
    pub ndcg: f64,
    pub negatives: usize,
    pub abstained: usize,
    pub activation_correct: usize,
}

pub fn score(tally: &mut Tally, query: &Query, returned: &[String]) {
    tally.queries += 1;
    if query.relevant.is_empty() {
        tally.negatives += 1;
        tally.abstained += usize::from(returned.is_empty());
        tally.activation_correct += usize::from(returned.is_empty());
        return;
    }
    tally.positives += 1;
    let top = &returned[..returned.len().min(CUTOFF)];
    let found = top
        .iter()
        .filter(|id| query.relevant.contains_key(*id))
        .count();
    tally.recall += found as f64 / query.relevant.len() as f64;
    tally.precision += if top.is_empty() {
        0.
    } else {
        found as f64 / top.len() as f64
    };
    tally.reciprocal_rank += returned
        .iter()
        .take(10)
        .position(|id| query.relevant.contains_key(id))
        .map_or(0., |i| 1. / (i + 1) as f64);
    let gain =
        |rank: usize, grade: u32| f64::from((1u32 << grade) - 1) / ((rank + 2) as f64).log2();
    let dcg: f64 = top
        .iter()
        .enumerate()
        .map(|(i, id)| gain(i, query.relevant.get(id).copied().unwrap_or(0)))
        .sum();
    let mut ideal: Vec<u32> = query.relevant.values().copied().collect();
    ideal.sort_unstable_by(|a, b| b.cmp(a));
    let best: f64 = ideal
        .iter()
        .take(CUTOFF)
        .enumerate()
        .map(|(i, g)| gain(i, *g))
        .sum();
    tally.ndcg += dcg / best;
    tally.activation_correct += usize::from(
        returned
            .first()
            .is_some_and(|id| query.relevant.contains_key(id)),
    );
}

impl Tally {
    pub fn json(&self) -> Value {
        let positives = self.positives.max(1) as f64;
        json!({
            "queries": self.queries,
            "positives": self.positives,
            "recall_at_5": round(self.recall / positives),
            "precision_at_5": round(self.precision / positives),
            "mrr": round(self.reciprocal_rank / positives),
            "ndcg_at_5": round(self.ndcg / positives),
            "negatives": self.negatives,
            "abstention": [self.abstained, self.negatives],
            "activation_accuracy": round(self.activation_correct as f64 / self.queries.max(1) as f64),
        })
    }
}

fn round(value: f64) -> f64 {
    (value * 10_000.).round() / 10_000.
}

pub fn summarize<'a>(rows: impl Iterator<Item = (&'a Query, &'a Vec<String>)>) -> Value {
    let mut groups: BTreeMap<String, Tally> = BTreeMap::new();
    for (query, returned) in rows {
        for key in [
            "all".to_owned(),
            format!(
                "{}/{}",
                if query.skill { "skill" } else { "concept" },
                "all"
            ),
            format!(
                "{}/{}",
                if query.skill { "skill" } else { "concept" },
                query.category
            ),
            format!(
                "split/{}",
                if query.holdout {
                    "holdout"
                } else {
                    "development"
                }
            ),
        ] {
            score(groups.entry(key).or_default(), query, returned);
        }
    }
    Value::Object(groups.into_iter().map(|(k, v)| (k, v.json())).collect())
}

pub fn percentile(sorted: &[u128], pct: usize) -> u128 {
    sorted[(sorted.len() * pct).div_ceil(100).max(1) - 1]
}

pub struct Usage {
    pub cpu_ms: u128,
    pub peak_rss_bytes: u64,
}

pub fn usage() -> Usage {
    let mut raw: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut raw) };
    let ms = |t: libc::timeval| t.tv_sec as u128 * 1000 + t.tv_usec as u128 / 1000;
    let scale = if cfg!(target_os = "macos") { 1 } else { 1024 };
    Usage {
        cpu_ms: ms(raw.ru_utime) + ms(raw.ru_stime),
        peak_rss_bytes: raw.ru_maxrss as u64 * scale,
    }
}

pub fn directory_bytes(path: &std::path::Path) -> u64 {
    std::fs::read_dir(path).map_or(0, |entries| {
        entries
            .flatten()
            .map(|entry| match entry.metadata() {
                Ok(m) if m.is_dir() => directory_bytes(&entry.path()),
                Ok(m) => m.len(),
                Err(_) => 0,
            })
            .sum()
    })
}
