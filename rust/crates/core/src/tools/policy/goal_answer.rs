use crate::coordination::decisions::{Gate, Source};
use ycoding_schema::LosslessString;

pub const GOAL_VIA: &str = "goal";

#[derive(Clone)]
pub struct GoalReconsider<T, A> {
    pub fingerprint: LosslessString,
    pub source: Source,
    pub answer: Option<A>,
    pub confidence: Option<f64>,
    pub gate: Gate<T>,
}
