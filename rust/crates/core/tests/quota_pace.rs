use ycoding_core::resources::model::quota::{
    forecast::Semantics,
    pace::{Pace, Verdict, pace},
};
use ycoding_schema::{provider_usage::Window, schema::NonNegativeInt};

const START: i64 = 1_800_000_000_000;
const PERIOD: i64 = 10_000_000;
const RESET: i64 = START + PERIOD;

fn integer(value: i64) -> NonNegativeInt {
    NonNegativeInt::new(value).unwrap()
}

fn window(used: Option<f64>) -> Window {
    Window {
        id: "fixed".into(),
        label: "Fixed quota".into(),
        unit: "tokens".into(),
        used,
        limit: Some(100.0),
        remaining: None,
        unlimited: None,
        reset_at: Some(integer(RESET)),
        period_seconds: Some(integer(PERIOD / 1000)),
    }
}

fn evaluate(window: &Window, elapsed: i64) -> Option<Pace> {
    pace(window, Semantics::FixedReset, START + elapsed)
}

fn half(used: f64) -> Option<Pace> {
    evaluate(&window(Some(used)), PERIOD / 2)
}

#[test]
fn omits_empty_unknown_invalid_early_and_expired_windows() {
    assert_eq!(half(0.0), None);
    assert_eq!(evaluate(&window(None), PERIOD / 2), None);
    assert_eq!(evaluate(&window(Some(1.0)), PERIOD / 100 - 1), None);
    assert!(evaluate(&window(Some(1.0)), PERIOD / 100).is_some());
    assert_eq!(evaluate(&window(Some(1.0)), -1), None);
    assert_eq!(evaluate(&window(Some(60.0)), PERIOD), None);
    assert_eq!(evaluate(&window(Some(60.0)), PERIOD + 1), None);
    let without_limit = Window {
        limit: None,
        ..window(Some(10.0))
    };
    assert_eq!(evaluate(&without_limit, PERIOD / 2), None);
    let without_reset = Window {
        reset_at: None,
        ..window(Some(10.0))
    };
    assert_eq!(evaluate(&without_reset, PERIOD / 2), None);
    let without_period = Window {
        period_seconds: None,
        ..window(Some(10.0))
    };
    assert_eq!(evaluate(&without_period, PERIOD / 2), None);
    let zero_limit = Window {
        limit: Some(0.0),
        ..window(Some(10.0))
    };
    assert_eq!(evaluate(&zero_limit, PERIOD / 2), None);
    let zero_period = Window {
        period_seconds: Some(integer(0)),
        ..window(Some(10.0))
    };
    assert_eq!(evaluate(&zero_period, PERIOD / 2), None);
    let unlimited = Window {
        unlimited: Some(true),
        ..window(Some(10.0))
    };
    assert_eq!(evaluate(&unlimited, PERIOD / 2), None);
}

#[test]
fn omits_non_finite_measures() {
    for used in [f64::NAN, f64::INFINITY] {
        assert_eq!(half(used), None);
    }
    let infinite_limit = Window {
        limit: Some(f64::INFINITY),
        ..window(Some(10.0))
    };
    assert_eq!(evaluate(&infinite_limit, PERIOD / 2), None);
}

#[test]
fn omits_balance_and_unknown_semantics() {
    for semantics in [Semantics::Balance, Semantics::Unknown] {
        assert_eq!(
            pace(&window(Some(90.0)), semantics, START + PERIOD / 2),
            None
        );
    }
}

#[test]
fn classifies_use_with_half_the_window_elapsed() {
    for (used, verdict, projected) in [
        (45.0, Verdict::Ahead, 90.0),
        (45.0001, Verdict::CuttingItClose, 90.0002),
        (50.0, Verdict::CuttingItClose, 100.0),
        (50.0001, Verdict::WillRunOut, 100.0002),
        (100.0, Verdict::WillRunOut, 200.0),
    ] {
        let result = half(used).unwrap();
        assert_eq!(result.verdict, verdict, "{used}");
        assert_eq!(result.projected_used_at_reset, projected, "{used}");
    }
}

#[test]
fn reports_exhaustion_only_for_a_future_run_out_before_reset() {
    assert_eq!(half(45.0).unwrap().exhaustion_at, None);
    assert_eq!(half(50.0).unwrap().exhaustion_at, None);
    let elapsed = (PERIOD / 2) as f64;
    assert_eq!(
        half(60.0).unwrap().exhaustion_at,
        Some((START as f64 + elapsed + 40.0 / (60.0 / elapsed)).trunc() as i64)
    );
    assert_eq!(half(100.0).unwrap().exhaustion_at, None);
    assert_eq!(half(110.0).unwrap().exhaustion_at, None);
}

#[test]
fn enforces_the_one_minute_floor_for_short_windows() {
    let short = Window {
        reset_at: Some(integer(START + 3_600_000)),
        period_seconds: Some(integer(3_600)),
        ..window(Some(1.0))
    };
    assert_eq!(evaluate(&short, 59_999), None);
    assert!(evaluate(&short, 60_000).is_some());
}

#[test]
fn percent_units_use_their_defined_denominator_without_a_reported_limit() {
    let percent = |used| Window {
        unit: "percent".into(),
        limit: None,
        ..window(Some(used))
    };
    let ahead = evaluate(&percent(45.0), PERIOD / 2).unwrap();
    assert_eq!(ahead.verdict, Verdict::Ahead);
    assert_eq!(ahead.projected_used_at_reset, 90.0);
    let over = evaluate(&percent(60.0), PERIOD / 2).unwrap();
    assert_eq!(over.verdict, Verdict::WillRunOut);
    assert_eq!(over.projected_used_at_reset, 120.0);
}

#[test]
fn claude_bucket_durations_produce_a_verdict_without_a_reported_limit() {
    let bucket = |used, period: i64, reset: i64| Window {
        id: "five-hour".into(),
        label: "Session".into(),
        unit: "percent".into(),
        used: Some(used),
        limit: None,
        remaining: None,
        unlimited: None,
        reset_at: Some(integer(reset)),
        period_seconds: Some(integer(period)),
    };
    for window in [
        bucket(45.0, 18_000, START + 9_000_000),
        bucket(25.0, 604_800, START + 302_400_000),
    ] {
        assert_eq!(
            pace(&window, Semantics::FixedReset, START).map(|pace| pace.verdict),
            Some(Verdict::Ahead)
        );
    }
}

#[test]
fn verdicts_name_their_wire_values_in_severity_order() {
    assert_eq!(
        [Verdict::Ahead, Verdict::CuttingItClose, Verdict::WillRunOut].map(Verdict::as_str),
        ["ahead", "cutting-it-close", "will-run-out"]
    );
    assert!(Verdict::Ahead < Verdict::CuttingItClose);
    assert!(Verdict::CuttingItClose < Verdict::WillRunOut);
}
