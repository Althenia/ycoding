use super::forecast::Semantics;
use ycoding_schema::provider_usage::Window;

const MINUTE: i64 = 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Verdict {
    Ahead,
    CuttingItClose,
    WillRunOut,
}
impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ahead => "ahead",
            Self::CuttingItClose => "cutting-it-close",
            Self::WillRunOut => "will-run-out",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pace {
    pub verdict: Verdict,
    pub projected_used_at_reset: f64,
    pub exhaustion_at: Option<i64>,
}

pub fn pace(window: &Window, semantics: Semantics, now: i64) -> Option<Pace> {
    if semantics != Semantics::FixedReset || window.unlimited == Some(true) {
        return None;
    }
    let used = window.used.filter(|used| used.is_finite() && *used > 0.0)?;
    let limit = window
        .limit
        .or_else(|| (window.unit == "percent".into()).then_some(100.0))
        .filter(|limit| limit.is_finite() && *limit > 0.0)?;
    let duration = window
        .period_seconds?
        .get()
        .checked_mul(1000)
        .filter(|duration| *duration > 0)?;
    let reset_at = window.reset_at?.get();
    if now >= reset_at {
        return None;
    }
    let elapsed = now.saturating_sub(reset_at.saturating_sub(duration)) as f64;
    let duration = duration as f64;
    if elapsed < (MINUTE as f64).max(duration * 0.01) {
        return None;
    }
    let projected_used_at_reset = used * (duration / elapsed);
    if !projected_used_at_reset.is_finite() {
        return None;
    }
    let verdict = if used >= limit || projected_used_at_reset > limit {
        Verdict::WillRunOut
    } else if projected_used_at_reset > limit * 0.9 {
        Verdict::CuttingItClose
    } else {
        Verdict::Ahead
    };
    let exhaustion_at = (now as f64 + (limit - used) / (used / elapsed)).trunc() as i64;
    Some(Pace {
        verdict,
        projected_used_at_reset,
        exhaustion_at: (verdict == Verdict::WillRunOut
            && exhaustion_at > now
            && exhaustion_at < reset_at)
            .then_some(exhaustion_at),
    })
}
