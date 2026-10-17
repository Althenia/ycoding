use std::collections::BTreeMap;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_core::resources::{
    credential,
    model::{
        account_identity,
        quota::{
            Endpoints, Service,
            forecast::{
                Estimate, History, LocalBin, QuotaRequest, Semantics, local_rates, semantics,
            },
        },
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString, location, parse_json, provider, provider_usage,
    schema::NonNegativeInt, stringify_json, usage_forecast,
};
use ycoding_store::{Metadata, Options, Store, import, resources, session::Document};

const MINUTE: i64 = 60_000;
const ORIGIN: i64 = 1_800_000_000_000;

#[derive(Clone, Default)]
struct Extra {
    unit: Option<&'static str>,
    limit: Option<f64>,
    remaining: Option<f64>,
    unlimited: Option<bool>,
    reset_at: Option<i64>,
    period_seconds: Option<i64>,
}

fn window(used: Option<f64>, extra: &Extra) -> provider_usage::Window {
    provider_usage::Window {
        id: "quota".into(),
        label: "Quota".into(),
        unit: extra.unit.unwrap_or("tokens").into(),
        used,
        limit: extra.limit,
        remaining: extra.remaining,
        unlimited: extra.unlimited,
        reset_at: extra
            .reset_at
            .map(|value| NonNegativeInt::new(value).unwrap()),
        period_seconds: extra
            .period_seconds
            .map(|value| NonNegativeInt::new(value).unwrap()),
    }
}

fn snapshot(
    at: i64,
    value: provider_usage::Window,
    source: &str,
    stability: &str,
) -> provider_usage::Snapshot {
    provider_usage::Snapshot {
        provider_id: provider::Id("fixture".into()),
        label: "Fixture".into(),
        profile: None,
        status: "available".into(),
        source: source.into(),
        stability: stability.into(),
        updated_at: NonNegativeInt::new(ORIGIN + at).unwrap(),
        windows: vec![value],
        message: None,
    }
}

fn request<'a>(
    account: Option<&'a LosslessString>,
    value: &'a provider_usage::Snapshot,
    now: i64,
) -> QuotaRequest<'a> {
    QuotaRequest {
        account,
        snapshot: value,
        window: &value.windows[0],
        now,
        semantics: Semantics::FixedReset,
        whole_window_mean: false,
    }
}

fn observe_as(
    history: &mut History,
    at: i64,
    used: Option<f64>,
    extra: &Extra,
    account: &str,
) -> Estimate {
    let value = snapshot(at, window(used, extra), "provider_api", "stable");
    let account = LosslessString::from(account);
    history.observe(&account, &value, &value.windows[0], Semantics::FixedReset);
    history.quota(request(Some(&account), &value, value.updated_at.get()))
}

fn observe(history: &mut History, minutes: i64, used: f64) -> Estimate {
    observe_as(
        history,
        minutes * MINUTE,
        Some(used),
        &Extra::default(),
        "account-generation-1",
    )
}

fn observe_with(history: &mut History, minutes: i64, used: Option<f64>, extra: &Extra) -> Estimate {
    observe_as(
        history,
        minutes * MINUTE,
        used,
        extra,
        "account-generation-1",
    )
}

fn close(actual: Option<f64>, expected: f64, tolerance: f64) {
    let actual = actual.expect("a rate");
    assert!(
        (actual - expected).abs() < tolerance,
        "{actual} is not within {tolerance} of {expected}"
    );
}

fn numberless(estimate: &Estimate) {
    assert_eq!(estimate.state, "insufficient");
    assert_eq!(estimate.rate_per_hour, None);
    assert_eq!(estimate.exhaustion_at, None);
    assert_eq!(estimate.projected_used_at_reset, None);
}

#[test]
fn warms_up_deduplicates_and_requires_ten_minutes_and_material_consumption() {
    let mut history = History::new(256, 256);
    assert_eq!(
        observe(&mut history, 0, 10.0).reason,
        Some("Collecting observations")
    );
    for _ in 0..10 {
        observe(&mut history, 0, 10.0);
    }
    assert_eq!(observe(&mut history, 10, 20.0).state, "insufficient");
    let estimated = observe(&mut history, 11, 21.0);
    assert_eq!(estimated.state, "estimated");
    assert_eq!(estimated.evidence, "medium");
    assert_eq!(estimated.method, Some("quota-delta-ema"));

    let mut flat = History::new(256, 256);
    observe(&mut flat, 0, 10.0);
    observe(&mut flat, 5, 10.0);
    let flat = observe(&mut flat, 10, 10.0);
    numberless(&flat);
    assert_eq!(flat.reason, Some("No increase observed"));

    let percent = Extra {
        unit: Some("percent"),
        ..Extra::default()
    };
    let mut tiny = History::new(256, 256);
    observe_with(&mut tiny, 0, Some(10.0), &percent);
    observe_with(&mut tiny, 5, Some(10.1), &percent);
    assert_eq!(
        observe_with(&mut tiny, 10, Some(10.2), &percent).reason,
        Some("Consumption below reporting resolution")
    );
}

#[test]
fn smooths_irregular_deltas_with_a_fifteen_minute_half_life() {
    let mut history = History::new(256, 256);
    observe(&mut history, 0, 0.0);
    observe(&mut history, 10, 10.0);
    let value = observe(&mut history, 25, 40.0);
    close(value.rate_per_hour, 90.0, 1e-9);
    assert_eq!(value.observed_from, Some(ORIGIN));
    assert_eq!(value.observed_to, Some(ORIGIN + 25 * MINUTE));
    close(observe(&mut history, 40, 40.0).rate_per_hour, 45.0, 1e-9);
}

#[test]
fn labels_coarse_evidence_low_and_two_consuming_deltas_medium() {
    let mut history = History::new(256, 256);
    observe(&mut history, 0, 10.0);
    observe(&mut history, 5, 10.0);
    let coarse = observe(&mut history, 10, 20.0);
    assert_eq!((coarse.state, coarse.evidence), ("estimated", "low"));
    let percent = Extra {
        unit: Some("percent"),
        ..Extra::default()
    };
    let mut fractional = History::new(256, 256);
    observe_with(&mut fractional, 0, Some(10.0), &percent);
    observe_with(&mut fractional, 5, Some(10.5), &percent);
    let value = observe_with(&mut fractional, 10, Some(11.0), &percent);
    assert_eq!((value.state, value.evidence), ("estimated", "medium"));
    close(value.rate_per_hour, 6.0, 1e-9);
}

#[test]
fn breaks_the_comparable_series_on_correction_reset_unit_limit_account_and_period() {
    for change in ["correction", "reset", "unit", "limit", "account", "period"] {
        let mut history = History::new(256, 256);
        let extra = Extra {
            limit: Some(100.0),
            reset_at: Some(ORIGIN + 60 * MINUTE),
            period_seconds: Some(3600),
            ..Extra::default()
        };
        observe_with(&mut history, 0, Some(10.0), &extra);
        observe_with(&mut history, 5, Some(20.0), &extra);
        assert_eq!(
            observe_with(&mut history, 10, Some(30.0), &extra).state,
            "estimated",
            "{change}"
        );
        let changed = Extra {
            reset_at: (change == "reset")
                .then_some(ORIGIN + 120 * MINUTE)
                .or(extra.reset_at),
            unit: (change == "unit").then_some("requests"),
            limit: Some(if change == "limit" { 200.0 } else { 100.0 }),
            period_seconds: Some(if change == "period" { 7200 } else { 3600 }),
            ..Extra::default()
        };
        let value = observe_as(
            &mut history,
            15 * MINUTE,
            Some(if change == "correction" { 5.0 } else { 40.0 }),
            &changed,
            if change == "account" {
                "account-generation-2"
            } else {
                "account-generation-1"
            },
        );
        assert_eq!(value.state, "insufficient", "{change}");
        assert_eq!(value.rate_per_hour, None, "{change}");
    }
}

#[test]
fn keeps_each_source_and_selects_the_freshest_sufficient_comparable_series() {
    let mut history = History::new(256, 256);
    let account = LosslessString::from("private-account");
    for at in [0, 5, 10] {
        let headers = snapshot(
            at * MINUTE,
            window(Some(10.0 + at as f64), &Extra::default()),
            "response_headers",
            "observed",
        );
        history.observe(
            &account,
            &headers,
            &headers.windows[0],
            Semantics::FixedReset,
        );
        let internal = snapshot(
            (at + 1) * MINUTE,
            window(Some(80.0), &Extra::default()),
            "provider_internal_api",
            "best_effort",
        );
        history.observe(
            &account,
            &internal,
            &internal.windows[0],
            Semantics::FixedReset,
        );
    }
    let poll = snapshot(
        11 * MINUTE,
        window(Some(80.0), &Extra::default()),
        "provider_internal_api",
        "best_effort",
    );
    let value = history.quota(request(Some(&account), &poll, poll.updated_at.get()));
    assert_eq!(value.state, "estimated");
    close(value.rate_per_hour, 60.0, 1e-9);
    assert_eq!(value.source, "response_headers".into());
    assert_eq!(value.stability, "observed".into());
    assert_eq!(value.updated_at, ORIGIN + 10 * MINUTE);

    let fresh = snapshot(
        12 * MINUTE,
        window(Some(22.0), &Extra::default()),
        "response_headers",
        "observed",
    );
    history.observe(&account, &fresh, &fresh.windows[0], Semantics::FixedReset);
    let value = history.quota(request(Some(&account), &fresh, fresh.updated_at.get()));
    assert_eq!(value.state, "estimated");
    assert_eq!(value.observed_from, Some(ORIGIN));
    assert_eq!(value.source, "response_headers".into());
    assert_eq!(value.updated_at, fresh.updated_at.get());

    for at in [16, 21] {
        let internal = snapshot(
            at * MINUTE,
            window(Some(80.0 + (at - 11) as f64), &Extra::default()),
            "provider_internal_api",
            "best_effort",
        );
        history.observe(
            &account,
            &internal,
            &internal.windows[0],
            Semantics::FixedReset,
        );
    }
    let value = history.quota(request(Some(&account), &fresh, ORIGIN + 21 * MINUTE));
    assert_eq!(value.state, "estimated");
    assert_eq!(value.source, "provider_internal_api".into());
    assert_eq!(value.stability, "best_effort".into());
    assert_eq!(value.updated_at, ORIGIN + 21 * MINUTE);
    assert_eq!(value.observed_from, Some(ORIGIN + MINUTE));
}

#[test]
fn reports_exhausted_percent_usage_without_inventing_numbers() {
    for used in [100.0, 101.0] {
        let value = observe_with(
            &mut History::new(256, 256),
            0,
            Some(used),
            &Extra {
                unit: Some("percent"),
                ..Extra::default()
            },
        );
        assert_eq!(value.state, "exhausted");
        assert_eq!(value.rate_per_hour, None);
        assert_eq!(value.exhaustion_at, None);
        assert_eq!(value.projected_used_at_reset, None);
    }
}

#[test]
fn ignores_out_of_order_observations_and_invalidates_same_time_corrections() {
    let mut history = History::new(256, 256);
    observe(&mut history, 0, 10.0);
    observe(&mut history, 5, 20.0);
    let value = snapshot(
        10 * MINUTE,
        window(Some(30.0), &Extra::default()),
        "provider_api",
        "stable",
    );
    observe(&mut history, 10, 30.0);
    observe(&mut history, 4, 500.0);
    let account = LosslessString::from("account-generation-1");
    close(
        history
            .quota(request(Some(&account), &value, value.updated_at.get()))
            .rate_per_hour,
        120.0,
        0.005,
    );
    assert_eq!(observe(&mut history, 10, 35.0).state, "insufficient");
}

#[test]
fn breaks_on_replenishment_even_when_a_used_counter_stays_monotonic() {
    let mut history = History::new(256, 256);
    let remaining = |value| Extra {
        remaining: Some(value),
        ..Extra::default()
    };
    observe_with(&mut history, 0, Some(10.0), &remaining(90.0));
    observe_with(&mut history, 5, Some(20.0), &remaining(80.0));
    assert_eq!(
        observe_with(&mut history, 10, Some(30.0), &remaining(70.0)).state,
        "estimated"
    );
    assert_eq!(
        observe_with(&mut history, 15, Some(40.0), &remaining(85.0)).state,
        "insufficient"
    );
}

#[test]
fn rejects_stale_future_expired_unbound_unsupported_and_unavailable_evidence_without_numbers() {
    let mut history = History::new(256, 256);
    let extra = Extra {
        reset_at: Some(ORIGIN + 30 * MINUTE),
        limit: Some(100.0),
        ..Extra::default()
    };
    observe_with(&mut history, 0, Some(0.0), &extra);
    observe_with(&mut history, 5, Some(10.0), &extra);
    observe_with(&mut history, 10, Some(20.0), &extra);
    let value = snapshot(
        10 * MINUTE,
        window(Some(20.0), &extra),
        "provider_api",
        "stable",
    );
    let account = LosslessString::from("account-generation-1");
    let mut stale = value.clone();
    stale.status = "stale".into();
    let expired = snapshot(
        10 * MINUTE,
        window(
            Some(20.0),
            &Extra {
                reset_at: Some(ORIGIN + 10 * MINUTE),
                ..extra.clone()
            },
        ),
        "provider_api",
        "stable",
    );
    let cases = [
        (
            Some(&account),
            &value,
            ORIGIN + 21 * MINUTE,
            Semantics::FixedReset,
            "Quota observations are stale",
        ),
        (
            Some(&account),
            &value,
            ORIGIN + 9 * MINUTE,
            Semantics::FixedReset,
            "Quota observations are stale",
        ),
        (
            Some(&account),
            &value,
            ORIGIN + 30 * MINUTE,
            Semantics::FixedReset,
            "Quota observations are stale",
        ),
        (
            Some(&account),
            &expired,
            ORIGIN + 10 * MINUTE,
            Semantics::FixedReset,
            "Quota window has expired",
        ),
        (
            None,
            &value,
            ORIGIN + 10 * MINUTE,
            Semantics::FixedReset,
            "Quota account is unbound",
        ),
        (
            Some(&account),
            &value,
            ORIGIN + 10 * MINUTE,
            Semantics::Unknown,
            "Quota window semantics do not support projection",
        ),
        (
            Some(&account),
            &stale,
            ORIGIN + 10 * MINUTE,
            Semantics::FixedReset,
            "Quota observations are stale",
        ),
    ];
    for (account, snapshot, now, semantics, reason) in cases {
        let result = history.quota(QuotaRequest {
            account,
            snapshot,
            window: &snapshot.windows[0],
            now,
            semantics,
            whole_window_mean: false,
        });
        numberless(&result);
        assert_eq!(result.reason, Some(reason));
    }
    let empty = LosslessString::from("");
    assert_eq!(
        history
            .quota(request(Some(&empty), &value, value.updated_at.get()))
            .reason,
        Some("Quota account is unbound")
    );
}

#[test]
fn projects_only_to_the_next_reported_reset_and_suppresses_eta_at_or_after_it() {
    let extra = Extra {
        reset_at: Some(ORIGIN + 30 * MINUTE),
        limit: Some(100.0),
        ..Extra::default()
    };
    let mut history = History::new(256, 256);
    observe_with(&mut history, 0, Some(0.0), &extra);
    observe_with(&mut history, 5, Some(10.0), &extra);
    let result = observe_with(&mut history, 10, Some(20.0), &extra);
    close(result.projected_used_at_reset, 60.0, 0.005);
    assert_eq!(result.exhaustion_at, None);
    let mut fast = History::new(256, 256);
    observe_with(&mut fast, 0, Some(60.0), &extra);
    observe_with(&mut fast, 5, Some(70.0), &extra);
    assert_eq!(
        observe_with(&mut fast, 10, Some(80.0), &extra).exhaustion_at,
        Some(ORIGIN + 20 * MINUTE)
    );
    let mut at_reset = History::new(256, 256);
    observe_with(&mut at_reset, 0, Some(40.0), &extra);
    observe_with(&mut at_reset, 5, Some(50.0), &extra);
    assert_eq!(
        observe_with(&mut at_reset, 10, Some(60.0), &extra).exhaustion_at,
        None
    );
}

#[test]
fn keeps_absent_limits_absent_and_never_converts_percentages_into_tokens() {
    let extra = Extra {
        unit: Some("percent"),
        reset_at: Some(ORIGIN + 30 * MINUTE),
        ..Extra::default()
    };
    let mut history = History::new(256, 256);
    observe_with(&mut history, 0, Some(10.0), &extra);
    observe_with(&mut history, 5, Some(20.0), &extra);
    let result = observe_with(&mut history, 10, Some(30.0), &extra);
    close(result.rate_per_hour, 120.0, 0.005);
    close(result.projected_used_at_reset, 70.0, 0.005);
    assert_eq!(result.exhaustion_at, None);
}

#[test]
fn supports_remaining_only_balances_with_an_eta_but_no_reset_projection() {
    let remaining = |value| Extra {
        remaining: Some(value),
        ..Extra::default()
    };
    let mut history = History::new(256, 256);
    observe_with(&mut history, 0, None, &remaining(40.0));
    observe_with(&mut history, 5, None, &remaining(30.0));
    let result = observe_with(&mut history, 10, None, &remaining(20.0));
    close(result.rate_per_hour, 120.0, 0.005);
    assert_eq!(result.exhaustion_at, Some(ORIGIN + 20 * MINUTE));
    assert_eq!(result.projected_used_at_reset, None);
    assert_eq!(
        observe_with(&mut history, 15, None, &remaining(0.0)).state,
        "exhausted"
    );
    assert_eq!(
        observe_with(
            &mut history,
            20,
            None,
            &Extra {
                unlimited: Some(true),
                ..Extra::default()
            }
        )
        .state,
        "unlimited"
    );
}

#[test]
fn emits_whole_window_means_only_when_enabled_for_complete_window_semantics() {
    let mut history = History::new(256, 256);
    let account = LosslessString::from("private");
    let extra = Extra {
        reset_at: Some(ORIGIN + 60 * MINUTE),
        period_seconds: Some(3600),
        ..Extra::default()
    };
    let value = snapshot(
        30 * MINUTE,
        window(Some(60.0), &extra),
        "provider_api",
        "stable",
    );
    history.observe(&account, &value, &value.windows[0], Semantics::FixedReset);
    assert_eq!(
        history
            .quota(request(Some(&account), &value, value.updated_at.get()))
            .state,
        "insufficient"
    );
    let mean = history.quota(QuotaRequest {
        whole_window_mean: true,
        ..request(Some(&account), &value, value.updated_at.get())
    });
    assert_eq!(mean.state, "estimated");
    assert_eq!(mean.method, Some("window-mean"));
    assert_eq!(mean.evidence, "low");
    close(mean.rate_per_hour, 120.0, 1e-9);
    assert_eq!(mean.observed_from, Some(ORIGIN));
    assert_eq!(mean.observed_to, Some(value.updated_at.get()));
    close(mean.projected_used_at_reset, 120.0, 1e-9);
    for at in [35, 40] {
        let next = snapshot(
            at * MINUTE,
            value.windows[0].clone(),
            "provider_api",
            "stable",
        );
        history.observe(&account, &next, &next.windows[0], Semantics::FixedReset);
        if at == 40 {
            let result = history.quota(QuotaRequest {
                whole_window_mean: true,
                ..request(Some(&account), &next, next.updated_at.get())
            });
            assert_eq!(result.reason, Some("No increase observed"));
        }
    }
}

#[test]
fn bounds_series_and_observations_and_drops_observations_older_than_one_hour() {
    let mut history = History::new(2, 3);
    let none = Extra::default();
    for (at, used) in [(0, 10.0), (5, 20.0), (10, 30.0), (15, 40.0)] {
        observe_as(&mut history, at * MINUTE, Some(used), &none, "a");
    }
    assert_eq!(
        observe_as(&mut history, 20 * MINUTE, Some(50.0), &none, "a").observed_from,
        Some(ORIGIN + 10 * MINUTE)
    );
    observe_as(&mut history, 20 * MINUTE, Some(50.0), &none, "b");
    observe_as(&mut history, 20 * MINUTE, Some(50.0), &none, "c");
    assert_eq!(
        observe_as(&mut history, 25 * MINUTE, Some(60.0), &none, "a").state,
        "insufficient"
    );
    let mut horizon = History::new(256, 256);
    observe(&mut horizon, 0, 0.0);
    observe(&mut horizon, 5, 10.0);
    observe(&mut horizon, 10, 20.0);
    assert_eq!(observe(&mut horizon, 71, 100.0).state, "insufficient");
}

#[test]
fn clamps_history_bounds_to_the_contract_limits() {
    let mut history = History::new(0, 0);
    let none = Extra::default();
    for (at, used) in [(0, 10.0), (5, 20.0), (10, 30.0)] {
        observe_as(&mut history, at * MINUTE, Some(used), &none, "a");
    }
    assert_eq!(
        observe_as(&mut history, 15 * MINUTE, Some(40.0), &none, "a").observed_from,
        Some(ORIGIN + 5 * MINUTE)
    );
    observe_as(&mut history, 15 * MINUTE, Some(40.0), &none, "b");
    assert_eq!(
        observe_as(&mut history, 20 * MINUTE, Some(50.0), &none, "a").reason,
        Some("Collecting observations")
    );
}

#[test]
fn keeps_the_evidence_span_under_high_frequency_observations() {
    let mut history = History::new(256, 256);
    let none = Extra::default();
    for second in 0..15 * 60 {
        observe_as(
            &mut history,
            second * 1000,
            Some(second as f64),
            &none,
            "account-generation-1",
        );
    }
    let result = observe(&mut history, 15, 900.0);
    assert_eq!(result.state, "estimated");
    close(result.rate_per_hour, 3600.0, 0.005);
    assert!(result.observed_from.unwrap() <= ORIGIN + MINUTE);
}

#[test]
fn local_rates_use_five_minute_bins_distinct_wall_clock_rates_and_half_life_smoothing() {
    let rates = local_rates(
        &[
            LocalBin {
                start: ORIGIN,
                tokens: 300.0,
                known_usd: Some(0.6),
                priced_requests: 1,
                unpriced_requests: 0,
            },
            LocalBin {
                start: ORIGIN + 55 * MINUTE,
                tokens: 600.0,
                known_usd: Some(1.2),
                priced_requests: 1,
                unpriced_requests: 0,
            },
        ],
        ORIGIN + 60 * MINUTE,
    );
    assert_eq!(rates.tokens_per_minute5, 120.0);
    assert_eq!(rates.tokens_per_minute60, 15.0);
    assert!(rates.tokens_per_minute > 15.0 && rates.tokens_per_minute < 120.0);
    assert!(rates.estimated_usd_per_hour.unwrap() > 1.8);
    assert_eq!(rates.observed_from, ORIGIN);
    assert_eq!(rates.observed_to, ORIGIN + 60 * MINUTE);
    assert_eq!((rates.priced_requests, rates.unpriced_requests), (2, 0));
}

#[test]
fn local_rates_keep_partial_pricing_absent_measured_zero_explicit_and_ignore_other_horizons() {
    let rates = local_rates(
        &[
            LocalBin {
                start: ORIGIN - 5 * MINUTE,
                tokens: 9999.0,
                known_usd: Some(999.0),
                priced_requests: 1,
                unpriced_requests: 0,
            },
            LocalBin {
                start: ORIGIN + 55 * MINUTE,
                tokens: 0.0,
                known_usd: Some(0.0),
                priced_requests: 0,
                unpriced_requests: 1,
            },
        ],
        ORIGIN + 60 * MINUTE,
    );
    assert_eq!(rates.tokens_per_minute, 0.0);
    assert_eq!(rates.estimated_usd_per_hour, None);
    assert_eq!((rates.priced_requests, rates.unpriced_requests), (0, 1));
    assert_eq!(
        local_rates(&[], ORIGIN + 60 * MINUTE).tokens_per_minute,
        0.0
    );
    assert_eq!(
        local_rates(
            &[LocalBin {
                start: ORIGIN + 55 * MINUTE,
                tokens: 1.0,
                known_usd: None,
                priced_requests: 1,
                unpriced_requests: 0,
            }],
            ORIGIN + 60 * MINUTE,
        )
        .estimated_usd_per_hour,
        None
    );
    assert_eq!(
        local_rates(
            &[LocalBin {
                start: ORIGIN + 55 * MINUTE,
                tokens: 10.0,
                known_usd: Some(0.0),
                priced_requests: 1,
                unpriced_requests: 0,
            }],
            ORIGIN + 60 * MINUTE,
        )
        .estimated_usd_per_hour,
        Some(0.0)
    );
}

#[test]
fn classifies_window_semantics_for_the_kept_providers() {
    let quota = |provider: &str, id: &str, unit: &'static str, extra: Extra| {
        let mut value = window(
            None,
            &Extra {
                unit: Some(unit),
                ..extra
            },
        );
        value.id = id.into();
        semantics(&provider::Id(provider.into()), &value)
    };
    let reset = || Extra {
        reset_at: Some(ORIGIN),
        ..Extra::default()
    };
    for (provider, id, unit) in [
        ("anthropic", "five-hour", "percent"),
        ("anthropic", "seven-day", "percent"),
        ("anthropic", "seven-day-opus", "percent"),
        ("openai", "codex-primary", "percent"),
        ("openai", "codex-secondary", "percent"),
        ("muse", "window", "percent"),
        ("muse", "weekly", "percent"),
        ("zai", "session", "percent"),
        ("zai-coding-plan", "weekly", "percent"),
        ("zai", "web-searches", "count"),
        ("cursor", "included", "percent"),
    ] {
        assert_eq!(
            quota(provider, id, unit, reset()),
            Semantics::FixedReset,
            "{provider}/{id}"
        );
    }
    for (provider, id, unit) in [
        ("anthropic", "seven-dayish", "percent"),
        ("anthropic", "five-hour", "tokens"),
        ("openai", "codex-tertiary", "percent"),
        ("zai", "web-searches", "percent"),
        ("openrouter", "daily", "usd"),
    ] {
        assert_eq!(
            quota(provider, id, unit, reset()),
            Semantics::Unknown,
            "{provider}/{id}"
        );
    }
    assert_eq!(
        quota(
            "openrouter",
            "key",
            "usd",
            Extra {
                limit: Some(10.0),
                ..Extra::default()
            }
        ),
        Semantics::Balance
    );
    assert_eq!(
        quota(
            "anthropic",
            "five-hour",
            "percent",
            Extra {
                unlimited: Some(true),
                ..reset()
            }
        ),
        Semantics::Balance
    );
    assert_eq!(
        quota("anthropic", "five-hour", "percent", Extra::default()),
        Semantics::Unknown
    );
    assert_eq!(
        quota(
            "openrouter",
            "key",
            "usd",
            Extra {
                limit: Some(10.0),
                period_seconds: Some(60),
                ..Extra::default()
            }
        ),
        Semantics::Unknown
    );
}

#[test]
fn forecast_documents_round_trip_and_reject_invalid_values() {
    let encoded = parse_json(
        r#"{"asOf":5,"localScope":"location","localRates":[{"providerID":"anthropic","profile":"Work","modelID":"m","observedFrom":1,"observedTo":5,"tokensPerMinute":2.5,"tokensPerMinute5":0,"tokensPerMinute60":1,"estimatedUSDPerHour":0,"coverage":{"pricedRequests":1,"unpricedRequests":0}}],"quotas":[{"providerID":"openai","windowID":"codex-primary","unit":"percent","source":"provider_api","stability":"stable","updatedAt":4,"state":"estimated","method":"window-mean","evidence":"low","observedFrom":1,"observedTo":4,"ratePerHour":3,"exhaustionAt":9,"projectedUsedAtReset":7.5}]}"#,
    )
    .unwrap();
    let decoded = usage_forecast::Info::decode(&encoded).unwrap();
    assert_eq!(stringify_json(&decoded.encode()), stringify_json(&encoded));
    let minimal = parse_json(r#"{"asOf":0,"localScope":"backend"}"#).unwrap();
    assert_eq!(
        stringify_json(&usage_forecast::Info::decode(&minimal).unwrap().encode()),
        stringify_json(&minimal)
    );
    for invalid in [
        r#"{"asOf":0,"localScope":"machine"}"#,
        r#"{"asOf":-1,"localScope":"backend"}"#,
        r#"{"asOf":0,"localScope":"backend","quotas":[{"providerID":"openai","windowID":"w","unit":"percent","source":"provider_api","stability":"stable","updatedAt":4,"state":"guessed","evidence":"low"}]}"#,
        r#"{"asOf":0,"localScope":"backend","quotas":[{"providerID":"openai","windowID":"w","unit":"percent","source":"provider_api","stability":"stable","updatedAt":4,"state":"estimated","evidence":"low","ratePerHour":-1}]}"#,
        r#"{"asOf":0,"localScope":"backend","localRates":[{"providerID":"a","observedFrom":0,"observedTo":0,"tokensPerMinute":1,"coverage":{"pricedRequests":-1,"unpricedRequests":0}}]}"#,
    ] {
        assert!(
            usage_forecast::Info::decode(&parse_json(invalid).unwrap()).is_err(),
            "{invalid}"
        );
    }
}

async fn credentials_with_key(store: &Store) -> credential::Service {
    let credentials = credential::Service::new(store.client());
    add_key(&credentials, "forecast-key", "synthetic-forecast-key").await;
    credentials
}

async fn add_key(credentials: &credential::Service, label: &str, key: &str) {
    credentials
        .create(
            label.into(),
            "openrouter".into(),
            None,
            resources::Secret::new(
                ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
                    key: key.into(),
                    metadata: None,
                })
                .encode(),
            )
            .unwrap(),
            0,
        )
        .await
        .unwrap();
}

async fn openrouter_server(
    limit: f64,
    remaining: Vec<f64>,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = tokio::spawn(async move {
        for value in remaining {
            for (path, status, body) in [
                (
                    "/key",
                    200,
                    format!(r#"{{"data":{{"limit":{limit},"limit_remaining":{value}}}}}"#),
                ),
                ("/credits", 403, "{}".to_string()),
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 4096];
                let size = socket.read(&mut bytes).await.unwrap();
                let request = String::from_utf8(bytes[..size].to_vec()).unwrap();
                assert!(request.starts_with(&format!("GET {path} HTTP/1.1")));
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        }
    });
    (endpoint, worker)
}

fn core_store() -> Store {
    Store::disposable(
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
        Metadata::new([31; 16], 1),
    )
    .unwrap()
}

#[tokio::test]
async fn forecast_projects_a_bound_account_quota_without_exposing_account_identity() {
    let store = core_store();
    let credentials = credentials_with_key(&store).await;
    let saved = credentials
        .list(&LosslessString::from("openrouter"))
        .unwrap();
    let account = account_identity(&saved[0]);
    let credential_id = saved[0].id().clone();
    let (endpoint, worker) = openrouter_server(10.0, vec![9.0, 8.0, 7.0]).await;
    let usage = Service::new(
        credentials,
        Endpoints(BTreeMap::from([("openrouter".into(), endpoint)])),
    )
    .unwrap();
    let openrouter = provider::Id("openrouter".into());
    for minutes in [0, 5, 10] {
        usage
            .get(openrouter.clone(), None, true, ORIGIN + minutes * MINUTE)
            .await;
    }
    worker.await.unwrap();
    let forecast = usage
        .forecast(
            std::slice::from_ref(&openrouter),
            None,
            NonNegativeInt::new(ORIGIN + 10 * MINUTE).unwrap(),
        )
        .await;
    assert_eq!(forecast.as_of.get(), ORIGIN + 10 * MINUTE);
    assert_eq!(forecast.local_scope.0, "backend".into());
    assert_eq!(forecast.local_rates.as_ref().map(Vec::len), Some(0));
    let quotas = forecast.quotas.clone().unwrap();
    let key = quotas
        .iter()
        .find(|quota| quota.window_id == "key".into())
        .unwrap();
    assert_eq!(key.provider_id, openrouter);
    assert_eq!(key.unit.0, "usd".into());
    assert_eq!(key.state.0, "estimated".into());
    assert_eq!(key.evidence.0, "medium".into());
    assert_eq!(
        key.method.as_ref().map(|method| method.0.clone()),
        Some("quota-delta-ema".into())
    );
    close(key.rate_per_hour, 12.0, 1e-9);
    assert_eq!(
        key.exhaustion_at.map(NonNegativeInt::get),
        Some(ORIGIN + 45 * MINUTE)
    );
    assert_eq!(key.projected_used_at_reset, None);
    assert_eq!(key.source.0, "provider_api".into());
    assert_eq!(key.updated_at.get(), ORIGIN + 10 * MINUTE);
    assert_eq!(key.observed_from.map(NonNegativeInt::get), Some(ORIGIN));
    let encoded = stringify_json(&forecast.encode());
    for private in [
        account.to_utf8().unwrap(),
        credential_id.to_utf8().unwrap(),
        "synthetic-forecast-key".to_string(),
    ] {
        assert!(!encoded.contains(&private), "{private}");
    }
    usage.shutdown().await.unwrap();
}

#[tokio::test]
async fn forecast_keeps_an_unbound_observation_insufficient() {
    let store = core_store();
    let usage = Service::new(
        credential::Service::new(store.client()),
        Endpoints::provider(),
    )
    .unwrap();
    let observed = |at: i64, remaining: f64| provider_usage::Observation {
        provider_id: provider::Id("openrouter".into()),
        label: "OpenRouter".into(),
        source: "response_stream".into(),
        stability: "observed".into(),
        observed_at: NonNegativeInt::new(ORIGIN + at).unwrap(),
        windows: vec![provider_usage::Window {
            id: "key".into(),
            label: "Key".into(),
            unit: "usd".into(),
            used: Some(10.0 - remaining),
            limit: Some(10.0),
            remaining: Some(remaining),
            unlimited: None,
            reset_at: None,
            period_seconds: None,
        }],
    };
    for (at, remaining) in [(0, 9.0), (5 * MINUTE, 8.0), (10 * MINUTE, 7.0)] {
        usage.observe(observed(at, remaining), None).unwrap();
    }
    let forecast = usage
        .forecast(
            &[provider::Id("openrouter".into())],
            None,
            NonNegativeInt::new(ORIGIN + 10 * MINUTE).unwrap(),
        )
        .await;
    let quotas = forecast.quotas.unwrap();
    assert_eq!(quotas.len(), 1);
    assert_eq!(quotas[0].state.0, "insufficient".into());
    assert_eq!(quotas[0].reason, Some("Quota account is unbound".into()));
    assert_eq!(quotas[0].rate_per_hour, None);
    assert_eq!(quotas[0].exhaustion_at, None);
    usage.shutdown().await.unwrap();
}

fn fact(
    id: &str,
    directory: &str,
    model: &str,
    tokens: &str,
    cost: Option<f64>,
    time: i64,
) -> resources::UsageAnalyticsRequest {
    resources::UsageAnalyticsRequest {
        id: id.into(),
        session_id: "ses_forecast".into(),
        project_id: "prj_forecast".into(),
        directory: directory.into(),
        workspace_id: None,
        session_updated: time,
        agent: "build".into(),
        source: "step".into(),
        model: Document::new(parse_json(model).unwrap()).unwrap(),
        usage_anchor: None,
        task_path: Document::new(parse_json("[]").unwrap()).unwrap(),
        request: 1,
        attempts: 1,
        continuation: "full".into(),
        invalidation: "first-request".into(),
        prompt_cache_key: "abcdefgh".into(),
        cache_read_reported: None,
        tokens: Document::new(parse_json(tokens).unwrap()).unwrap(),
        cost,
        timing: Some(
            Document::new(
                parse_json(r#"{"generatedTokens":9000,"generationDurationNs":1000000000}"#)
                    .unwrap(),
            )
            .unwrap(),
        ),
        time_created: time,
    }
}

fn tokens(total: u64) -> String {
    format!(r#"{{"input":{total},"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}}"#)
}

#[tokio::test]
async fn forecast_reads_recorded_local_rates_by_scope_with_exact_horizon_and_cost_coverage() {
    let store = core_store();
    let as_of = ORIGIN + 60 * MINUTE;
    let claude = r#"{"providerID":"anthropic","id":"claude-test"}"#;
    let work = r#"{"providerID":"openai","id":"gpt-test","profile":"Work"}"#;
    let facts = [
        fact(
            "fact_first",
            "/workspace/a",
            claude,
            &tokens(100),
            Some(0.5),
            ORIGIN,
        ),
        fact(
            "fact_last",
            "/workspace/a",
            claude,
            r#"{"input":300,"output":200,"reasoning":50,"cache":{"read":30,"write":20}}"#,
            None,
            as_of - 1,
        ),
        fact(
            "fact_other",
            "/workspace/b",
            claude,
            &tokens(1000),
            Some(1.0),
            ORIGIN + 30 * MINUTE,
        ),
        fact(
            "fact_at_now",
            "/workspace/a",
            claude,
            &tokens(5000),
            Some(9.0),
            as_of,
        ),
        fact(
            "fact_too_old",
            "/workspace/a",
            claude,
            &tokens(7000),
            Some(9.0),
            ORIGIN - 1,
        ),
        fact(
            "fact_zero",
            "/workspace/a",
            work,
            &tokens(50),
            Some(0.0),
            as_of - 2 * MINUTE,
        ),
    ];
    store
        .submit(move |tx| {
            facts
                .iter()
                .try_for_each(|row| resources::UsageAnalyticsRequestTable::insert(tx, row))
        })
        .unwrap()
        .wait()
        .unwrap();
    let usage = Service::new(
        credential::Service::new(store.client()),
        Endpoints::provider(),
    )
    .unwrap()
    .with_store(store.client());
    let location =
        location::Ref::decode(&parse_json(r#"{"directory":"/workspace/a"}"#).unwrap()).unwrap();

    let local = usage
        .forecast(&[], Some(&location), NonNegativeInt::new(as_of).unwrap())
        .await;
    assert_eq!(local.local_scope.0, "location".into());
    assert_eq!(local.quotas.as_ref().map(Vec::len), Some(0));
    let rates = local.local_rates.unwrap();
    assert_eq!(rates.len(), 2);
    let claude_rate = &rates[0];
    assert_eq!(claude_rate.provider_id, provider::Id("anthropic".into()));
    assert_eq!(claude_rate.model_id, Some("claude-test".into()));
    assert_eq!(claude_rate.profile, None);
    assert_eq!(claude_rate.observed_from.get(), ORIGIN);
    assert_eq!(claude_rate.observed_to.get(), as_of);
    assert_eq!(claude_rate.tokens_per_minute5, Some(120.0));
    close(claude_rate.tokens_per_minute60, 700.0 / 60.0, 1e-9);
    assert_eq!(claude_rate.estimated_usd_per_hour, None);
    assert_eq!(
        (
            claude_rate.coverage.priced_requests.get(),
            claude_rate.coverage.unpriced_requests.get()
        ),
        (1, 1)
    );
    let work_rate = &rates[1];
    assert_eq!(work_rate.provider_id, provider::Id("openai".into()));
    assert_eq!(
        work_rate.profile.as_ref().map(|profile| profile.0.clone()),
        Some("Work".into())
    );
    assert_eq!(
        work_rate.estimated_usd_per_hour.map(|usd| usd.get()),
        Some(0.0)
    );
    assert_eq!(
        (
            work_rate.coverage.priced_requests.get(),
            work_rate.coverage.unpriced_requests.get()
        ),
        (1, 0)
    );

    let backend = usage
        .forecast(&[], None, NonNegativeInt::new(as_of).unwrap())
        .await;
    assert_eq!(backend.local_scope.0, "backend".into());
    let rates = backend.local_rates.unwrap();
    close(rates[0].tokens_per_minute60, 1700.0 / 60.0, 1e-9);
    assert_eq!(
        (
            rates[0].coverage.priced_requests.get(),
            rates[0].coverage.unpriced_requests.get()
        ),
        (2, 1)
    );
    usage.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_unreadable_fact_store_leaves_rates_unavailable_without_hiding_quotas() {
    let credentials_store = core_store();
    let facts = core_store();
    let usage = Service::new(
        credential::Service::new(credentials_store.client()),
        Endpoints::provider(),
    )
    .unwrap()
    .with_store(facts.client());
    facts.shutdown().unwrap();
    let forecast = usage
        .forecast(&[], None, NonNegativeInt::new(ORIGIN).unwrap())
        .await;
    assert!(forecast.local_rates.is_none());
    assert_eq!(forecast.quotas.map(|quotas| quotas.len()), Some(0));
    usage.shutdown().await.unwrap();
}

fn key_quota(forecast: &usage_forecast::Info) -> usage_forecast::Quota {
    forecast
        .quotas
        .as_ref()
        .unwrap()
        .iter()
        .find(|quota| quota.window_id == "key".into())
        .unwrap()
        .clone()
}

#[tokio::test]
async fn cached_get_and_list_reads_cannot_manufacture_a_new_observation() {
    let store = core_store();
    let credentials = credentials_with_key(&store).await;
    let (endpoint, worker) = openrouter_server(10.0, vec![9.0, 8.0]).await;
    let usage = Service::new(
        credentials,
        Endpoints(BTreeMap::from([("openrouter".into(), endpoint)])),
    )
    .unwrap();
    let openrouter = provider::Id("openrouter".into());
    for minutes in [0, 10] {
        usage
            .get(openrouter.clone(), None, true, ORIGIN + minutes * MINUTE)
            .await;
    }
    worker.await.unwrap();
    let cached = usage
        .get(
            openrouter.clone(),
            None,
            false,
            ORIGIN + 10 * MINUTE + 30_000,
        )
        .await;
    assert_eq!(cached.status, "available".into());
    assert_eq!(cached.updated_at.get(), ORIGIN + 10 * MINUTE);
    let listed = usage
        .list(
            std::slice::from_ref(&openrouter),
            false,
            ORIGIN + 10 * MINUTE + 45_000,
        )
        .await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].status, "available".into());
    assert_eq!(listed[0].updated_at.get(), ORIGIN + 10 * MINUTE);
    let forecast = usage
        .forecast(
            std::slice::from_ref(&openrouter),
            None,
            NonNegativeInt::new(ORIGIN + 10 * MINUTE + 50_000).unwrap(),
        )
        .await;
    let quota = key_quota(&forecast);
    assert_eq!(quota.state.0, "insufficient".into());
    assert_eq!(quota.reason, Some("Collecting observations".into()));
    assert_eq!(quota.rate_per_hour, None);
    assert_eq!(quota.updated_at.get(), ORIGIN + 10 * MINUTE);
    usage.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_replacement_credential_does_not_reuse_the_previous_account_history() {
    let store = core_store();
    let credentials = credentials_with_key(&store).await;
    let previous = credentials
        .list(&LosslessString::from("openrouter"))
        .unwrap()
        .remove(0);
    let (endpoint, worker) = openrouter_server(10.0, vec![9.0, 8.0, 7.0]).await;
    let usage = Service::new(
        credentials.clone(),
        Endpoints(BTreeMap::from([("openrouter".into(), endpoint)])),
    )
    .unwrap();
    let openrouter = provider::Id("openrouter".into());
    for minutes in [0, 5] {
        usage
            .get(openrouter.clone(), None, true, ORIGIN + minutes * MINUTE)
            .await;
    }
    credentials
        .remove(previous.id().clone(), ORIGIN + 6 * MINUTE)
        .await
        .unwrap();
    add_key(&credentials, "replacement-key", "synthetic-replacement-key").await;
    let replacement = credentials
        .list(&LosslessString::from("openrouter"))
        .unwrap()
        .remove(0);
    assert_ne!(replacement.id(), previous.id());
    let refreshed = usage
        .get(openrouter.clone(), None, true, ORIGIN + 10 * MINUTE)
        .await;
    worker.await.unwrap();
    assert_eq!(refreshed.status, "available".into());
    assert_eq!(refreshed.updated_at.get(), ORIGIN + 10 * MINUTE);
    let forecast = usage
        .forecast(
            std::slice::from_ref(&openrouter),
            None,
            NonNegativeInt::new(ORIGIN + 10 * MINUTE).unwrap(),
        )
        .await;
    let quota = key_quota(&forecast);
    assert_eq!(quota.state.0, "insufficient".into());
    assert_eq!(quota.reason, Some("Collecting observations".into()));
    assert_eq!(quota.rate_per_hour, None);
    assert_eq!(quota.exhaustion_at, None);
    let encoded = stringify_json(&forecast.encode());
    for private in [account_identity(&previous), account_identity(&replacement)] {
        assert!(!encoded.contains(&private.to_utf8().unwrap()));
    }
    usage.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_eta_beyond_the_contract_integer_range_is_omitted_and_the_forecast_stays_valid() {
    let store = core_store();
    let credentials = credentials_with_key(&store).await;
    let (endpoint, worker) = openrouter_server(
        1_000_000_000.0,
        vec![999_999_999.99, 999_999_999.98, 999_999_999.97],
    )
    .await;
    let usage = Service::new(
        credentials,
        Endpoints(BTreeMap::from([("openrouter".into(), endpoint)])),
    )
    .unwrap();
    let openrouter = provider::Id("openrouter".into());
    for minutes in [0, 5, 10] {
        usage
            .get(openrouter.clone(), None, true, ORIGIN + minutes * MINUTE)
            .await;
    }
    worker.await.unwrap();
    let forecast = usage
        .forecast(
            std::slice::from_ref(&openrouter),
            None,
            NonNegativeInt::new(ORIGIN + 10 * MINUTE).unwrap(),
        )
        .await;
    let quota = key_quota(&forecast);
    assert_eq!(quota.state.0, "estimated".into());
    let rate = quota.rate_per_hour.unwrap();
    assert!(rate > 0.0 && rate.is_finite());
    assert!(
        (ORIGIN + 10 * MINUTE) as f64 + 999_999_999.97 * 3_600_000.0 / rate
            > 9_007_199_254_740_991.0
    );
    assert_eq!(quota.exhaustion_at, None);
    let encoded = forecast.encode();
    assert_eq!(usage_forecast::Info::decode(&encoded).unwrap(), forecast);
    usage.shutdown().await.unwrap();
}
