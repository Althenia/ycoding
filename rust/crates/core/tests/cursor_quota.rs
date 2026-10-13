use ycoding_core::resources::model::quota::normalize_cursor;
use ycoding_schema::{parse_json, provider};

const USAGE: &str = r#"{"billingCycleStart":"1790828591000","billingCycleEnd":"1793506991000","planUsage":{"remaining":1500,"limit":2000,"remainingBonus":false,"autoPercentUsed":10,"apiPercentUsed":5,"totalPercentUsed":25},"enabled":true}"#;

fn normalize(
    usage: &str,
    plan: Option<&str>,
) -> Result<ycoding_schema::provider_usage::Snapshot, ()> {
    normalize_cursor(
        provider::Id("cursor".into()),
        "Cursor",
        100,
        &parse_json(usage).unwrap(),
        plan.map(|plan| parse_json(plan).unwrap()).as_ref(),
    )
    .map_err(|_| ())
}

#[test]
fn plan_usage_maps_to_included_auto_and_api_windows() {
    let snapshot = normalize(USAGE, None).unwrap();
    assert_eq!(snapshot.label.as_str(), Some("Cursor"));
    assert_eq!(snapshot.status.as_str(), Some("available"));
    assert_eq!(snapshot.source.as_str(), Some("provider_internal_api"));
    assert_eq!(snapshot.stability.as_str(), Some("best_effort"));
    let windows = snapshot
        .windows
        .iter()
        .map(|window| {
            (
                window.id.as_str().unwrap(),
                window.unit.as_str().unwrap(),
                window.used,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        windows,
        [
            ("included", "percent", Some(25.0)),
            ("auto", "percent", Some(10.0)),
            ("api", "percent", Some(5.0))
        ]
    );
    assert_eq!(
        snapshot.windows[0].reset_at.unwrap().get(),
        1_793_506_991_000
    );
    assert_eq!(snapshot.windows[0].period_seconds.unwrap().get(), 2_678_400);
    for window in &snapshot.windows {
        assert!(window.limit.is_none() && window.remaining.is_none());
    }
    for window in &snapshot.windows[1..] {
        assert!(window.reset_at.is_none() && window.period_seconds.is_none());
    }
}

#[test]
fn plan_name_labels_the_snapshot_only_when_nonblank() {
    let label = |plan| normalize(USAGE, Some(plan)).unwrap().label;
    assert_eq!(
        label(r#"{"planInfo":{"planName":"Pro"}}"#).as_str(),
        Some("Cursor Pro")
    );
    assert_eq!(
        label(r#"{"planInfo":{"planName":" "}}"#).as_str(),
        Some("Cursor")
    );
    assert_eq!(label(r#""garbage""#).as_str(), Some("Cursor"));
}

#[test]
fn unknown_values_are_omitted_instead_of_reported_as_zero() {
    let snapshot = normalize(
        r#"{"planUsage":{"totalPercentUsed":40,"autoPercentUsed":"x"}}"#,
        None,
    )
    .unwrap();
    assert_eq!(snapshot.windows.len(), 1);
    let window = &snapshot.windows[0];
    assert_eq!(
        (window.id.as_str(), window.used),
        (Some("included"), Some(40.0))
    );
    assert!(window.limit.is_none() && window.reset_at.is_none() && window.period_seconds.is_none());
}

#[test]
fn payload_without_plan_usage_is_rejected() {
    assert!(normalize(r#"{"enabled":true}"#, None).is_err());
    assert!(normalize("null", None).is_err());
}
