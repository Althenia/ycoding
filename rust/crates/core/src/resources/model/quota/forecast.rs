use super::Error;
use std::{collections::BTreeMap, ops::Bound};
use ycoding_schema::{
    JsonValue, LosslessString, location, model, money, provider,
    provider_request::CostCoverage,
    provider_usage::{Snapshot, Window},
    schema::NonNegativeInt,
    stringify_json, usage_forecast,
};
use ycoding_store::{Client, IndexOrder, IndexQuery, KeyPart, resources, tuple_key};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const HALF_LIFE: f64 = (15 * MINUTE) as f64;
const FRESHNESS: i64 = 10 * MINUTE;
const BIN_WIDTH: i64 = 5 * MINUTE;
const BUCKET: i64 = 15_000;
const PAGE: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Semantics {
    FixedReset,
    Balance,
    Unknown,
}

pub fn semantics(provider: &provider::Id, window: &Window) -> Semantics {
    if window.unlimited == Some(true)
        || (window.reset_at.is_none()
            && window.period_seconds.is_none()
            && (window.remaining.is_some() || window.limit.is_some()))
    {
        return Semantics::Balance;
    }
    if window.reset_at.is_none() {
        return Semantics::Unknown;
    }
    let provider = provider.0.as_str().unwrap_or("");
    let id = window.id.as_str().unwrap_or("");
    let percent = window.unit == "percent".into();
    let fixed = (percent
        && match provider {
            "anthropic" => {
                id == "five-hour"
                    || id
                        .strip_prefix("seven-day")
                        .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
            }
            "openai" => id.ends_with("-primary") || id.ends_with("-secondary"),
            "muse" => matches!(id, "window" | "weekly"),
            "zai" | "zai-coding-plan" => matches!(id, "session" | "weekly"),
            "cursor" => id == "included",
            _ => false,
        })
        || (matches!(provider, "zai" | "zai-coding-plan")
            && id == "web-searches"
            && window.unit == "count".into());
    if fixed {
        Semantics::FixedReset
    } else {
        Semantics::Unknown
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Estimate {
    pub state: &'static str,
    pub evidence: &'static str,
    pub method: Option<&'static str>,
    pub reason: Option<&'static str>,
    pub observed_from: Option<i64>,
    pub observed_to: Option<i64>,
    pub rate_per_hour: Option<f64>,
    pub exhaustion_at: Option<i64>,
    pub projected_used_at_reset: Option<f64>,
    pub source: LosslessString,
    pub stability: LosslessString,
    pub updated_at: i64,
}

pub struct QuotaRequest<'a> {
    pub account: Option<&'a LosslessString>,
    pub snapshot: &'a Snapshot,
    pub window: &'a Window,
    pub now: i64,
    pub semantics: Semantics,
    pub whole_window_mean: bool,
}

#[derive(Clone, Copy, PartialEq)]
struct Point {
    at: i64,
    value: f64,
    remaining: Option<f64>,
}

#[derive(Clone, PartialEq)]
struct Signature {
    unit: LosslessString,
    reset_at: Option<i64>,
    limit: Option<f64>,
    period_seconds: Option<i64>,
    unlimited: Option<bool>,
    used: bool,
    semantics: Semantics,
}

impl Signature {
    fn of(window: &Window, semantics: Semantics) -> Self {
        Self {
            unit: window.unit.clone(),
            reset_at: window.reset_at.map(NonNegativeInt::get),
            limit: window.limit,
            period_seconds: window.period_seconds.map(NonNegativeInt::get),
            unlimited: window.unlimited,
            used: window.used.is_some(),
            semantics,
        }
    }
}

#[derive(Clone)]
struct Series {
    account: LosslessString,
    provider_id: provider::Id,
    source: LosslessString,
    stability: LosslessString,
    updated_at: i64,
    window: Window,
    semantics: Semantics,
    signature: Signature,
    points: Vec<Point>,
    corrected: bool,
}

impl Series {
    fn matches(
        &self,
        account: &LosslessString,
        provider: &provider::Id,
        window: &LosslessString,
        source: &LosslessString,
    ) -> bool {
        &self.account == account
            && &self.provider_id == provider
            && &self.window.id == window
            && &self.source == source
    }
}

pub struct History {
    series: Vec<Series>,
    max_series: usize,
    max_observations: usize,
}

struct Calculation<'a> {
    account: Option<&'a LosslessString>,
    status: &'a LosslessString,
    window: &'a Window,
    at: i64,
    now: i64,
    semantics: Semantics,
    whole_window_mean: bool,
}

impl History {
    pub fn new(max_series: usize, max_observations: usize) -> Self {
        Self {
            series: Vec::new(),
            max_series: max_series.clamp(1, 256),
            max_observations: max_observations.clamp(3, 256),
        }
    }

    pub fn observe(
        &mut self,
        account: &LosslessString,
        snapshot: &Snapshot,
        window: &Window,
        semantics: Semantics,
    ) {
        if snapshot.status != "available".into() {
            return;
        }
        let Some(value) = amount(window).filter(|value| value.is_finite()) else {
            return;
        };
        let at = snapshot.updated_at.get();
        let index = self.series.iter().position(|series| {
            series.matches(account, &snapshot.provider_id, &window.id, &snapshot.source)
        });
        let current = index.map(|index| &self.series[index]);
        let latest = current.and_then(|series| series.points.last().copied());
        if latest.is_some_and(|latest| latest.at > at) {
            return;
        }
        let signature = Signature::of(window, semantics);
        if latest.is_some_and(|latest| {
            latest.at == at && latest.value == value && latest.remaining == window.remaining
        }) && current.is_some_and(|series| series.signature == signature)
        {
            return;
        }
        let corrected = latest.is_some_and(|latest| {
            value < latest.value
                || latest.at == at
                || matches!((latest.remaining, window.remaining), (Some(before), Some(after)) if after > before)
        });
        let comparable = current.is_some_and(|series| series.signature == signature) && !corrected;
        let mut points = if comparable {
            current.map_or_else(Vec::new, |series| {
                series
                    .points
                    .iter()
                    .copied()
                    .filter(|point| {
                        point.at >= at - HOUR
                            && point.at.div_euclid(BUCKET) != at.div_euclid(BUCKET)
                    })
                    .collect()
            })
        } else {
            Vec::new()
        };
        points.push(Point {
            at,
            value,
            remaining: window.remaining,
        });
        let excess = points.len().saturating_sub(self.max_observations);
        points.drain(..excess);
        let carried = comparable && current.is_some_and(|series| series.corrected);
        if let Some(index) = index {
            self.series.remove(index);
        }
        self.series.push(Series {
            account: account.clone(),
            provider_id: snapshot.provider_id.clone(),
            source: snapshot.source.clone(),
            stability: snapshot.stability.clone(),
            updated_at: at,
            window: window.clone(),
            semantics,
            signature,
            points,
            corrected: corrected || carried,
        });
        let excess = self.series.len().saturating_sub(self.max_series);
        self.series.drain(..excess);
    }

    pub fn quota(&self, request: QuotaRequest<'_>) -> Estimate {
        let account = request.account.filter(|account| !account.is_empty());
        let current = account.and_then(|account| {
            self.series.iter().find(|series| {
                series.matches(
                    account,
                    &request.snapshot.provider_id,
                    &request.window.id,
                    &request.snapshot.source,
                )
            })
        });
        let result = calculate(
            Calculation {
                account,
                status: &request.snapshot.status,
                window: request.window,
                at: request.snapshot.updated_at.get(),
                now: request.now,
                semantics: request.semantics,
                whole_window_mean: request.whole_window_mean,
            },
            current,
        );
        let available = request.snapshot.status == "available".into();
        let selected = account
            .filter(|_| !matches!(result.state, "exhausted" | "unlimited"))
            .and_then(|account| {
                let signature = Signature::of(request.window, request.semantics);
                let mut candidates = self
                    .series
                    .iter()
                    .filter(|series| {
                        &series.account == account
                            && series.provider_id == request.snapshot.provider_id
                            && series.window.id == request.window.id
                            && series.signature == signature
                            && (available || series.source != request.snapshot.source)
                    })
                    .collect::<Vec<_>>();
                candidates.sort_by_key(|series| std::cmp::Reverse(series.updated_at));
                candidates.into_iter().find_map(|series| {
                    let result = calculate(
                        Calculation {
                            account: Some(account),
                            status: &"available".into(),
                            window: &series.window,
                            at: series.updated_at,
                            now: request.now,
                            semantics: series.semantics,
                            whole_window_mean: request.whole_window_mean,
                        },
                        Some(series),
                    );
                    (result.state != "insufficient").then_some((series, result))
                })
            });
        let (source, stability, updated_at, estimate) = match selected {
            Some((series, estimate)) => (
                series.source.clone(),
                series.stability.clone(),
                series.updated_at,
                estimate,
            ),
            None => (
                request.snapshot.source.clone(),
                request.snapshot.stability.clone(),
                request.snapshot.updated_at.get(),
                result,
            ),
        };
        Estimate {
            source,
            stability,
            updated_at,
            ..estimate
        }
    }
}

fn amount(window: &Window) -> Option<f64> {
    window.used.or(window.remaining.map(|remaining| -remaining))
}

fn insufficient(reason: &'static str) -> Estimate {
    Estimate {
        state: "insufficient",
        evidence: "insufficient",
        method: None,
        reason: Some(reason),
        observed_from: None,
        observed_to: None,
        rate_per_hour: None,
        exhaustion_at: None,
        projected_used_at_reset: None,
        source: LosslessString::default(),
        stability: LosslessString::default(),
        updated_at: 0,
    }
}

fn settled(state: &'static str) -> Estimate {
    Estimate {
        state,
        evidence: "low",
        reason: None,
        ..insufficient("")
    }
}

fn calculate(request: Calculation<'_>, current: Option<&Series>) -> Estimate {
    let window = request.window;
    let at = request.at;
    if request.account.is_none() {
        return insufficient("Quota account is unbound");
    }
    if request.status != &"available".into() || request.now - at > FRESHNESS || at > request.now {
        return insufficient("Quota observations are stale");
    }
    if window
        .reset_at
        .is_some_and(|reset| reset.get() <= request.now)
    {
        return insufficient("Quota window has expired");
    }
    if window.unlimited == Some(true) {
        return settled("unlimited");
    }
    if window.unit == "percent".into() && window.used.is_some_and(|used| used >= 100.0) {
        return settled("exhausted");
    }
    if request.semantics == Semantics::Unknown {
        return insufficient("Quota window semantics do not support projection");
    }
    let remaining = window.remaining.or(match (window.limit, window.used) {
        (Some(limit), Some(used)) => Some((limit - used).max(0.0)),
        _ => None,
    });
    if remaining == Some(0.0) {
        return settled("exhausted");
    }
    let Some(current) =
        current.filter(|series| series.signature == Signature::of(window, request.semantics))
    else {
        return insufficient("Collecting observations");
    };
    let points = current
        .points
        .iter()
        .copied()
        .filter(|point| point.at >= request.now - HOUR && point.at <= at)
        .collect::<Vec<_>>();
    let resolution = if window.unit == "usd".into() {
        0.01
    } else {
        1.0
    };
    let (first, last) = (points.first().copied(), points.last().copied());
    let consumption = match (first, last) {
        (Some(first), Some(last)) => last.value - first.value,
        _ => 0.0,
    };
    let deltas = points
        .windows(2)
        .map(|pair| (pair[1].at - pair[0].at, pair[1].value - pair[0].value))
        .collect::<Vec<_>>();
    let span = match (first, last) {
        (Some(first), Some(last)) => last.at - first.at,
        _ => 0,
    };
    let sufficient = points.len() >= 3 && span >= 10 * MINUTE && consumption >= resolution;
    let mean_start = match (window.reset_at, window.period_seconds) {
        (Some(reset), Some(period)) if period.get() != 0 => Some(reset.get() - period.get() * 1000),
        _ => None,
    };
    let mean = request.whole_window_mean
        && request.semantics == Semantics::FixedReset
        && !current.corrected
        && (points.len() < 3 || span < 10 * MINUTE)
        && mean_start.is_some_and(|start| start >= 0 && at - start >= 10 * MINUTE)
        && window.used.is_some_and(|used| used >= resolution);
    if !sufficient && !mean {
        if points.len() < 3 || span < 10 * MINUTE {
            return insufficient("Collecting observations");
        }
        return insufficient(if consumption == 0.0 {
            "No increase observed"
        } else {
            "Consumption below reporting resolution"
        });
    }
    let rate_per_hour = if sufficient {
        deltas
            .iter()
            .enumerate()
            .fold(0.0, |rate, (index, (duration, consumed))| {
                let next = consumed * HOUR as f64 / *duration as f64;
                if index == 0 {
                    next
                } else {
                    rate + (next - rate) * (1.0 - 2f64.powf(-(*duration as f64) / HALF_LIFE))
                }
            })
    } else {
        let start = mean_start.expect("a window mean has a start");
        window.used.expect("a window mean has usage") * HOUR as f64 / (at - start) as f64
    };
    if !rate_per_hour.is_finite() || rate_per_hour <= 0.0 {
        return insufficient("No increase observed");
    }
    let exhaustion_at = remaining
        .map(|remaining| at as f64 + remaining * HOUR as f64 / rate_per_hour)
        .filter(|value| {
            value.is_finite()
                && window
                    .reset_at
                    .is_none_or(|reset| *value < reset.get() as f64)
        })
        .map(|value| value.trunc() as i64);
    let used = window.used.or(match (window.limit, window.remaining) {
        (Some(limit), Some(remaining)) => Some((limit - remaining).max(0.0)),
        _ => None,
    });
    let projected_used_at_reset = match (request.semantics, window.reset_at, used) {
        (Semantics::FixedReset, Some(reset), Some(used)) => {
            Some(used + rate_per_hour * (reset.get() - at) as f64 / HOUR as f64)
        }
        _ => None,
    }
    .filter(|value| value.is_finite());
    Estimate {
        state: "estimated",
        evidence: if sufficient
            && deltas
                .iter()
                .filter(|(_, consumed)| *consumed > 0.0)
                .count()
                >= 2
        {
            "medium"
        } else {
            "low"
        },
        method: Some(if sufficient {
            "quota-delta-ema"
        } else {
            "window-mean"
        }),
        reason: None,
        observed_from: if sufficient {
            first.map(|first| first.at)
        } else {
            mean_start
        },
        observed_to: Some(at),
        rate_per_hour: Some(rate_per_hour),
        exhaustion_at,
        projected_used_at_reset,
        ..insufficient("")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LocalBin {
    pub start: i64,
    pub tokens: f64,
    pub known_usd: Option<f64>,
    pub priced_requests: u64,
    pub unpriced_requests: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rates {
    pub observed_from: i64,
    pub observed_to: i64,
    pub tokens_per_minute: f64,
    pub tokens_per_minute5: f64,
    pub tokens_per_minute60: f64,
    pub estimated_usd_per_hour: Option<f64>,
    pub priced_requests: u64,
    pub unpriced_requests: u64,
}

#[derive(Clone, Copy)]
struct Bin {
    tokens: f64,
    known_usd: f64,
    cost_reported: bool,
    priced_requests: u64,
    unpriced_requests: u64,
}

pub fn local_rates(bins: &[LocalBin], as_of: i64) -> Rates {
    let observed_from = as_of - HOUR;
    let values = (0..12)
        .map(|index| {
            let start = observed_from + index * BIN_WIDTH;
            bins.iter()
                .filter(|bin| bin.start >= start && bin.start < start + BIN_WIDTH)
                .fold(
                    Bin {
                        tokens: 0.0,
                        known_usd: 0.0,
                        cost_reported: true,
                        priced_requests: 0,
                        unpriced_requests: 0,
                    },
                    |total, bin| Bin {
                        tokens: total.tokens + bin.tokens,
                        known_usd: total.known_usd + bin.known_usd.unwrap_or(0.0),
                        cost_reported: total.cost_reported
                            && (bin.known_usd.is_some()
                                || bin.priced_requests + bin.unpriced_requests == 0),
                        priced_requests: total.priced_requests + bin.priced_requests,
                        unpriced_requests: total.unpriced_requests + bin.unpriced_requests,
                    },
                )
        })
        .collect::<Vec<_>>();
    let priced_requests = values.iter().map(|bin| bin.priced_requests).sum::<u64>();
    let unpriced_requests = values.iter().map(|bin| bin.unpriced_requests).sum::<u64>();
    let weights = (0..12)
        .map(|index| 2f64.powf(-((11 - index) * BIN_WIDTH) as f64 / HALF_LIFE))
        .collect::<Vec<_>>();
    let weight = weights.iter().sum::<f64>();
    let weighted = |value: fn(&Bin) -> f64| {
        values
            .iter()
            .zip(&weights)
            .map(|(bin, weight)| value(bin) * weight)
            .sum::<f64>()
            / weight
    };
    Rates {
        observed_from,
        observed_to: as_of,
        tokens_per_minute5: values[11].tokens / 5.0,
        tokens_per_minute60: values.iter().map(|bin| bin.tokens).sum::<f64>() / 60.0,
        tokens_per_minute: weighted(|bin| bin.tokens / 5.0),
        estimated_usd_per_hour: (unpriced_requests == 0
            && priced_requests > 0
            && values.iter().all(|bin| bin.cost_reported))
        .then(|| weighted(|bin| bin.known_usd * 12.0)),
        priced_requests,
        unpriced_requests,
    }
}

struct Group {
    provider_id: provider::Id,
    profile: Option<model::ProfileName>,
    model_id: model::Id,
    bins: Vec<LocalBin>,
}

pub(super) fn local_usage(
    store: &Client,
    location: Option<&location::Ref>,
    as_of: i64,
) -> Result<Vec<usage_forecast::LocalRate>, Error> {
    let from = as_of - HOUR;
    let snapshot = store.snapshot().map_err(|_| Error::Storage)?;
    let lower = tuple_key(&[KeyPart::I64(from)]);
    let upper = tuple_key(&[KeyPart::I64(as_of)]);
    let mut groups = BTreeMap::<LosslessString, Group>::new();
    let mut after = None;
    loop {
        let page = snapshot
            .index_range::<resources::UsageAnalyticsRequestTable>(
                "usage_analytics_request_time_created_id_idx",
                IndexQuery {
                    lower: Bound::Included(&lower),
                    upper: Bound::Excluded(&upper),
                    prefix: None,
                    order: IndexOrder::Ascending,
                    after: after.as_ref(),
                    limit: PAGE,
                },
            )
            .map_err(|_| Error::Storage)?;
        let full = page.len() == PAGE;
        after = page.last().map(|entry| entry.cursor.clone());
        for entry in page {
            let fact = entry.record;
            if fact.time_created < from || fact.time_created >= as_of {
                continue;
            }
            if let Some(location) = location
                && (&fact.directory != location.directory.as_lossless()
                    || fact.workspace_id.as_ref()
                        != location.workspace_id.as_ref().map(|id| id.as_lossless()))
            {
                continue;
            }
            let model = fact.model.domain().map_err(|_| Error::Storage)?;
            let tokens = fact.tokens.domain().map_err(|_| Error::Storage)?;
            let key = stringify_json(&JsonValue::Array(vec![
                JsonValue::String(model.provider_id.0.clone()),
                model.profile.as_ref().map_or(JsonValue::Null, |profile| {
                    JsonValue::String(profile.0.clone())
                }),
                JsonValue::String(model.id.clone()),
            ]))
            .into();
            let group = groups.entry(key).or_insert_with(|| Group {
                provider_id: model.provider_id.clone(),
                profile: model.profile.clone(),
                model_id: model.id.clone(),
                bins: (0..12)
                    .map(|index| LocalBin {
                        start: from + index * BIN_WIDTH,
                        tokens: 0.0,
                        known_usd: None,
                        priced_requests: 0,
                        unpriced_requests: 0,
                    })
                    .collect(),
            });
            let bin = &mut group.bins[((fact.time_created - from) / BIN_WIDTH) as usize];
            bin.tokens += tokens.input.get()
                + tokens.output.get()
                + tokens.reasoning.get()
                + tokens.cache.read.get()
                + tokens.cache.write.get();
            match fact.cost.filter(|cost| cost.is_finite() && *cost >= 0.0) {
                Some(cost) => {
                    bin.known_usd = Some(bin.known_usd.unwrap_or(0.0) + cost);
                    bin.priced_requests += 1;
                }
                None => bin.unpriced_requests += 1,
            }
        }
        if !full {
            break;
        }
    }
    groups
        .into_values()
        .map(|group| {
            let rates = local_rates(&group.bins, as_of);
            Ok(usage_forecast::LocalRate {
                provider_id: group.provider_id,
                profile: group.profile,
                model_id: Some(group.model_id),
                observed_from: count(rates.observed_from)?,
                observed_to: count(rates.observed_to)?,
                tokens_per_minute: rates.tokens_per_minute,
                tokens_per_minute5: Some(rates.tokens_per_minute5),
                tokens_per_minute60: Some(rates.tokens_per_minute60),
                estimated_usd_per_hour: rates
                    .estimated_usd_per_hour
                    .map(money::Usd::new)
                    .transpose()
                    .map_err(|_| Error::InvalidResponse)?,
                coverage: CostCoverage {
                    priced_requests: count(rates.priced_requests as i64)?,
                    unpriced_requests: count(rates.unpriced_requests as i64)?,
                },
            })
        })
        .collect()
}

fn count(value: i64) -> Result<NonNegativeInt, Error> {
    NonNegativeInt::new(value).map_err(|_| Error::InvalidResponse)
}
