use super::Mode;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settings {
    pub mode: Mode,
    pub steps: usize,
    pub max_concurrency: usize,
    pub max_depth: u8,
    pub max_tokens: u64,
    pub max_latency_ms: u64,
    pub min_signals: usize,
    pub recall_limit: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: Mode::Adaptive,
            steps: 1,
            max_concurrency: 2,
            max_depth: 1,
            max_tokens: 200_000,
            max_latency_ms: 600_000,
            min_signals: 2,
            recall_limit: 5,
        }
    }
}
