use ycoding_core::resources::model::quota::{
    forecast::Semantics,
    pace_alerts::{Alert, Delivery, Evaluator, MAX_DEFERRED, MAX_STATES, Milestone, Observation},
};
use ycoding_schema::{LosslessString, provider, provider_usage::Window, schema::NonNegativeInt};

const NOW: i64 = 1_800_000_000_000;
const RESET: i64 = NOW + 1_800_000;
const ACCOUNT: &str = "synthetic-account";

fn integer(value: i64) -> NonNegativeInt {
    NonNegativeInt::new(value).unwrap()
}

fn window(used: f64) -> Window {
    Window {
        id: "five-hour".into(),
        label: "Session".into(),
        unit: "percent".into(),
        used: Some(used),
        limit: Some(100.0),
        remaining: None,
        unlimited: None,
        reset_at: Some(integer(RESET)),
        period_seconds: Some(integer(3_600)),
    }
}

fn empty() -> Window {
    Window {
        id: "five-hour".into(),
        label: "Session".into(),
        unit: "percent".into(),
        used: None,
        limit: None,
        remaining: None,
        unlimited: None,
        reset_at: None,
        period_seconds: None,
    }
}

fn credits(unit: &str, limit: f64, remaining: f64, reset: Option<i64>) -> Window {
    Window {
        id: "credits".into(),
        label: "Credits".into(),
        unit: unit.into(),
        used: None,
        limit: Some(limit),
        remaining: Some(remaining),
        unlimited: None,
        reset_at: reset.map(integer),
        period_seconds: None,
    }
}

struct Options {
    account: String,
    updated_at: i64,
    at: i64,
    available: bool,
    semantics: Semantics,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            account: ACCOUNT.to_owned(),
            updated_at: NOW,
            at: NOW,
            available: true,
            semantics: Semantics::FixedReset,
        }
    }
}

fn input(window: Window) -> Observation {
    with(window, Options::default())
}

fn with(window: Window, options: Options) -> Observation {
    Observation {
        account: options.account.as_str().into(),
        provider_id: provider::Id("anthropic".into()),
        available: options.available,
        updated_at: options.updated_at,
        window,
        semantics: options.semantics,
        now: options.at,
    }
}

fn updated(updated_at: i64) -> Options {
    Options {
        updated_at,
        ..Options::default()
    }
}

fn balance(updated_at: i64) -> Options {
    Options {
        updated_at,
        semantics: Semantics::Balance,
        ..Options::default()
    }
}

fn account(account: &str) -> Options {
    Options {
        account: account.to_owned(),
        ..Options::default()
    }
}

struct Fixture {
    evaluator: Evaluator,
    alerts: Vec<Alert>,
    accept: bool,
}

impl Fixture {
    fn new() -> Self {
        Self {
            evaluator: Evaluator::new(),
            alerts: Vec::new(),
            accept: true,
        }
    }

    fn observe(&mut self, observation: Observation) {
        let deliveries = self.evaluator.observe(observation);
        self.settle(deliveries);
    }

    fn settle(&mut self, deliveries: Vec<Delivery>) {
        for delivery in deliveries {
            let alert = delivery.alert().clone();
            let next = delivery.settle(self.accept);
            if self.accept {
                self.alerts.push(alert);
            }
            self.settle(next);
        }
    }

    fn milestones(&self) -> Vec<Milestone> {
        self.alerts.iter().map(|alert| alert.milestone).collect()
    }
}

fn milestones(deliveries: &[Delivery]) -> Vec<Milestone> {
    deliveries
        .iter()
        .map(|delivery| delivery.alert().milestone)
        .collect()
}

#[test]
fn delivers_only_the_provider_window_milestone_and_reset() {
    let mut value = Fixture::new();
    value.observe(input(window(40.0)));
    value.observe(input(window(46.0)));
    assert_eq!(
        value.alerts,
        vec![Alert {
            provider_id: provider::Id("anthropic".into()),
            window_id: "five-hour".into(),
            milestone: Milestone::CuttingItClose,
            reset_at: RESET,
        }]
    );
    assert!(!format!("{:?}", value.alerts).contains(ACCOUNT));
}

#[test]
fn milestones_name_their_wire_values_and_generic_copy() {
    assert_eq!(
        [
            Milestone::AlmostOut,
            Milestone::CuttingItClose,
            Milestone::WillRunOut
        ]
        .map(|milestone| (milestone.as_str(), milestone.title(), milestone.body())),
        [
            (
                "almost-out",
                "Almost out",
                "Less than 10% of this quota remains."
            ),
            (
                "cutting-it-close",
                "Cutting it close",
                "Projected quota use exceeds 90% of its limit at reset."
            ),
            (
                "will-run-out",
                "Will run out",
                "Quota use is at its limit or projected to exceed it before reset."
            ),
        ]
    );
}

#[test]
fn an_unsettled_delivery_holds_later_observations_so_one_edge_never_fires_twice() {
    let evaluator = Evaluator::new();
    assert!(evaluator.observe(input(window(40.0))).is_empty());
    let mut first = evaluator.observe(input(window(46.0)));
    assert_eq!(milestones(&first), vec![Milestone::CuttingItClose]);
    assert!(evaluator.observe(input(window(47.0))).is_empty());
    assert!(first.pop().unwrap().settle(true).is_empty());
    assert!(evaluator.observe(input(window(48.0))).is_empty());
}

#[test]
fn a_refused_held_delivery_is_offered_again_by_the_held_observation() {
    let evaluator = Evaluator::new();
    assert!(evaluator.observe(input(window(40.0))).is_empty());
    let mut first = evaluator.observe(input(window(46.0)));
    assert!(evaluator.observe(input(window(47.0))).is_empty());
    let mut retry = first.pop().unwrap().settle(false);
    assert_eq!(milestones(&retry), vec![Milestone::CuttingItClose]);
    assert!(retry.pop().unwrap().settle(true).is_empty());
    assert!(evaluator.observe(input(window(48.0))).is_empty());
}

#[test]
fn held_observations_are_evaluated_in_order_when_the_delivery_settles() {
    let evaluator = Evaluator::new();
    assert!(evaluator.observe(input(window(40.0))).is_empty());
    let mut first = evaluator.observe(input(window(46.0)));
    assert!(evaluator.observe(input(window(60.0))).is_empty());
    let next = first.pop().unwrap().settle(true);
    assert_eq!(milestones(&next), vec![Milestone::WillRunOut]);
}

#[test]
fn held_observations_beyond_the_bound_are_dropped() {
    let evaluator = Evaluator::new();
    assert!(evaluator.observe(input(window(40.0))).is_empty());
    let mut first = evaluator.observe(input(window(46.0)));
    for index in 0..MAX_DEFERRED {
        assert!(
            evaluator
                .observe(input(window(46.1 + index as f64 * 0.1)))
                .is_empty()
        );
    }
    assert!(evaluator.observe(input(window(60.0))).is_empty());
    assert!(first.pop().unwrap().settle(true).is_empty());
    assert_eq!(
        milestones(&evaluator.observe(input(window(61.0)))),
        vec![Milestone::WillRunOut]
    );
}

#[test]
fn observing_never_waits_for_an_unsettled_delivery() {
    let evaluator = Evaluator::new();
    for name in ["left", "right"] {
        assert!(
            evaluator
                .observe(with(window(40.0), account(name)))
                .is_empty()
        );
    }
    let held = evaluator.observe(with(window(46.0), account("left")));
    assert_eq!(milestones(&held), vec![Milestone::CuttingItClose]);
    let other = evaluator.observe(with(window(46.0), account("right")));
    assert_eq!(milestones(&other), vec![Milestone::CuttingItClose]);
}

#[test]
fn a_pace_milestone_precedes_almost_out_in_one_observation() {
    let evaluator = Evaluator::new();
    assert!(evaluator.observe(input(window(40.0))).is_empty());
    assert_eq!(
        milestones(&evaluator.observe(input(window(96.0)))),
        vec![Milestone::WillRunOut, Milestone::AlmostOut]
    );
}

#[test]
fn an_older_observation_is_ignored() {
    let mut value = Fixture::new();
    value.observe(input(window(40.0)));
    value.observe(with(window(46.0), updated(NOW - 1)));
    assert_eq!(value.milestones(), vec![]);
    value.observe(input(window(46.0)));
    assert_eq!(value.milestones(), vec![Milestone::CuttingItClose]);
}

#[test]
fn an_identical_cached_snapshot_does_not_rearm_when_only_the_clock_advanced() {
    let mut value = Fixture::new();
    let later = NOW + 1_400_000;
    value.observe(input(window(40.0)));
    value.observe(input(window(46.0)));
    value.observe(with(
        window(46.0),
        Options {
            at: later,
            ..Options::default()
        },
    ));
    value.observe(with(
        window(85.0),
        Options {
            updated_at: later,
            at: later,
            ..Options::default()
        },
    ));
    assert_eq!(value.milestones(), vec![Milestone::CuttingItClose]);
}

#[test]
fn a_refused_delivery_is_retried_by_an_identical_observation_until_it_succeeds_once() {
    let mut value = Fixture::new();
    value.observe(input(window(40.0)));
    value.accept = false;
    value.observe(input(window(46.0)));
    value.observe(input(window(46.0)));
    assert_eq!(value.milestones(), vec![]);
    value.accept = true;
    value.observe(input(window(46.0)));
    value.observe(input(window(46.0)));
    assert_eq!(value.milestones(), vec![Milestone::CuttingItClose]);
}

#[test]
fn a_dropped_delivery_keeps_the_edge_pending() {
    let mut value = Fixture::new();
    value.observe(input(window(40.0)));
    let dropped = value.evaluator.observe(input(window(46.0)));
    assert_eq!(milestones(&dropped), vec![Milestone::CuttingItClose]);
    drop(dropped);
    value.observe(input(window(47.0)));
    assert_eq!(value.milestones(), vec![Milestone::CuttingItClose]);
}

#[test]
fn a_pending_cutting_it_close_edge_superseded_by_will_run_out_sends_only_will_run_out() {
    let mut value = Fixture::new();
    value.observe(input(window(40.0)));
    value.accept = false;
    value.observe(input(window(46.0)));
    value.accept = true;
    value.observe(input(window(60.0)));
    assert_eq!(value.milestones(), vec![Milestone::WillRunOut]);
}

#[test]
fn no_data_and_unavailable_observations_neither_prime_nor_disturb_signals() {
    let mut value = Fixture::new();
    value.observe(input(empty()));
    value.observe(with(
        window(95.0),
        Options {
            available: false,
            ..Options::default()
        },
    ));
    value.observe(input(window(95.0)));
    assert_eq!(value.milestones(), vec![]);
    value.observe(with(empty(), updated(NOW + 1)));
    value.observe(with(window(96.0), updated(NOW + 2)));
    assert_eq!(value.milestones(), vec![]);
    let mut gap = Fixture::new();
    gap.observe(input(window(40.0)));
    gap.observe(with(empty(), updated(NOW + 1)));
    gap.observe(with(window(46.0), updated(NOW + 2)));
    assert_eq!(gap.milestones(), vec![Milestone::CuttingItClose]);
}

#[test]
fn a_window_with_a_reset_but_no_period_alerts_under_ten_percent_remaining() {
    let mut value = Fixture::new();
    value.observe(with(
        credits("percent", 100.0, 20.0, Some(RESET)),
        balance(NOW),
    ));
    value.observe(with(
        credits("percent", 100.0, 10.0, Some(RESET)),
        balance(NOW + 1),
    ));
    assert_eq!(value.milestones(), vec![]);
    value.observe(with(
        credits("percent", 100.0, 9.9, Some(RESET)),
        balance(NOW + 2),
    ));
    value.observe(with(
        credits("percent", 100.0, 5.0, Some(RESET)),
        balance(NOW + 3),
    ));
    assert_eq!(value.milestones(), vec![Milestone::AlmostOut]);
}

#[test]
fn a_native_currency_window_alerts_below_exactly_ten_percent_and_not_at_it() {
    let mut value = Fixture::new();
    value.observe(with(credits("usd", 1.1, 0.5, Some(RESET)), balance(NOW)));
    value.observe(with(
        credits("usd", 1.1, 0.11, Some(RESET)),
        balance(NOW + 1),
    ));
    assert_eq!(value.milestones(), vec![]);
    value.observe(with(
        credits("usd", 1.1, 0.1099, Some(RESET)),
        balance(NOW + 2),
    ));
    assert_eq!(value.milestones(), vec![Milestone::AlmostOut]);
}

#[test]
fn windows_without_a_future_reset_never_alert_or_change_state() {
    let mut value = Fixture::new();
    let no_reset = |used| Window {
        reset_at: None,
        ..window(used)
    };
    value.observe(input(no_reset(40.0)));
    value.observe(with(window(95.0), updated(NOW + 1)));
    value.observe(with(no_reset(96.0), updated(NOW + 2)));
    value.observe(with(window(97.0), updated(NOW + 3)));
    assert_eq!(value.milestones(), vec![]);
    value.observe(with(credits("usd", 10.0, 0.5, None), balance(NOW)));
    value.observe(with(credits("usd", 10.0, 5.0, None), balance(NOW + 1)));
    value.observe(with(credits("usd", 10.0, 0.5, None), balance(NOW + 2)));
    assert_eq!(value.milestones(), vec![]);
}

#[test]
fn expired_resets_never_alert_or_change_state() {
    let mut value = Fixture::new();
    let expired = |reset| Window {
        reset_at: Some(integer(reset)),
        ..window(95.0)
    };
    value.observe(input(window(40.0)));
    value.observe(with(expired(NOW - 1), updated(NOW + 1)));
    value.observe(with(expired(NOW), updated(NOW + 2)));
    assert_eq!(value.milestones(), vec![]);
    value.observe(with(window(46.0), updated(NOW + 3)));
    assert_eq!(value.milestones(), vec![Milestone::CuttingItClose]);
}

#[test]
fn repeated_sub_second_reset_jitter_never_rearms_a_milestone() {
    let mut value = Fixture::new();
    value.observe(input(window(40.0)));
    value.observe(input(window(60.0)));
    for (index, offset) in [500, 1_000, 1_500, 2_000, 2_500].into_iter().enumerate() {
        value.observe(input(Window {
            reset_at: Some(integer(RESET + offset)),
            ..window(61.0 + index as f64)
        }));
    }
    assert_eq!(value.milestones(), vec![Milestone::WillRunOut]);
}

#[test]
fn a_reset_change_beyond_tolerance_rearms_milestones() {
    let mut value = Fixture::new();
    value.observe(input(window(40.0)));
    value.observe(input(window(60.0)));
    value.observe(input(Window {
        reset_at: Some(integer(RESET + 1_001)),
        ..window(61.0)
    }));
    assert_eq!(
        value.milestones(),
        vec![Milestone::WillRunOut, Milestone::WillRunOut]
    );
}

#[test]
fn recovery_rearms_pace_and_almost_out_milestones() {
    let mut value = Fixture::new();
    value.observe(input(window(40.0)));
    value.observe(input(window(95.0)));
    value.observe(input(window(50.0)));
    value.observe(input(window(95.0)));
    assert_eq!(
        value.milestones(),
        vec![
            Milestone::WillRunOut,
            Milestone::AlmostOut,
            Milestone::WillRunOut,
            Milestone::AlmostOut
        ]
    );
}

#[test]
fn accounts_and_windows_keep_independent_signals() {
    let mut value = Fixture::new();
    value.observe(with(window(40.0), account("left")));
    value.observe(with(window(40.0), account("right")));
    value.observe(with(window(46.0), account("left")));
    assert_eq!(value.milestones(), vec![Milestone::CuttingItClose]);
    value.observe(with(
        Window {
            id: LosslessString::from("weekly"),
            ..window(46.0)
        },
        account("right"),
    ));
    assert_eq!(value.milestones(), vec![Milestone::CuttingItClose]);
    value.observe(with(window(46.0), account("right")));
    assert_eq!(
        value.milestones(),
        vec![Milestone::CuttingItClose, Milestone::CuttingItClose]
    );
}

#[test]
fn clones_share_one_process_local_state() {
    let mut value = Fixture::new();
    value.observe(input(window(40.0)));
    let shared = value.evaluator.clone();
    assert_eq!(
        milestones(&shared.observe(input(window(46.0)))),
        vec![Milestone::CuttingItClose]
    );
}

#[test]
fn tracked_state_is_bounded_and_an_evicted_window_rebaselines_without_alerting() {
    let mut value = Fixture::new();
    value.observe(with(window(40.0), account("first")));
    for index in 0..MAX_STATES {
        value.observe(with(window(40.0), account(&format!("account-{index}"))));
    }
    value.observe(with(window(60.0), account("first")));
    assert_eq!(value.milestones(), vec![]);
    value.observe(with(window(95.0), account("first")));
    assert_eq!(value.milestones(), vec![Milestone::AlmostOut]);
}

#[test]
fn settling_after_eviction_is_a_no_op() {
    let evaluator = Evaluator::new();
    assert!(
        evaluator
            .observe(with(window(40.0), account("first")))
            .is_empty()
    );
    let mut held = evaluator.observe(with(window(46.0), account("first")));
    assert_eq!(milestones(&held), vec![Milestone::CuttingItClose]);
    for index in 0..MAX_STATES {
        assert!(
            evaluator
                .observe(with(window(40.0), account(&format!("account-{index}"))))
                .is_empty()
        );
    }
    assert!(held.pop().unwrap().settle(true).is_empty());
    assert!(
        evaluator
            .observe(with(window(60.0), account("first")))
            .is_empty()
    );
}
