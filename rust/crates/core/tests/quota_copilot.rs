use std::sync::{Arc, Mutex};
use ycoding_core::resources::model::quota::{Error, load_copilot, normalize_copilot_billing};
use ycoding_schema::{parse_json, provider};

#[test]
fn billing_filters_products_preserves_reported_zero_and_omits_unknown_quantity() {
    let response = parse_json(r#"{"usageItems":[{"product":"Actions","unitType":"ai-units","grossQuantity":500,"netAmount":5},{"product":"Copilot","unitType":"seats","grossQuantity":20,"netAmount":400},{"product":"Copilot","unitType":"ai-units","grossQuantity":10.5,"netAmount":0},{"product":"Copilot","unitType":"ai-credits","grossQuantity":3,"netAmount":0.03}]}"#).unwrap();
    let result = normalize_copilot_billing(
        provider::Id("github-copilot".into()),
        "Copilot",
        100,
        &response,
    )
    .unwrap();
    assert!(result.matched);
    assert_eq!(result.snapshot.windows[0].used, Some(13.5));
    assert_eq!(result.snapshot.windows[1].used, Some(0.03));
    assert_eq!(result.snapshot.source, "provider_api".into());
    let only_spend = normalize_copilot_billing(
        provider::Id("github-copilot".into()),
        "Copilot",
        100,
        &parse_json(
            r#"{"usageItems":[{"product":"Copilot","unitType":"ai-credits","netAmount":0}]}"#,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(only_spend.snapshot.windows.len(), 1);
    assert_eq!(only_spend.snapshot.windows[0].id, "org-spend".into());
    assert_eq!(only_spend.snapshot.windows[0].used, Some(0.0));
    assert!(normalize_copilot_billing(provider::Id("github-copilot".into()),"Copilot",100,&parse_json(r#"{"usageItems":[{"product":"Copilot","unitType":"ai-credits","grossQuantity":"unknown"}]}"#).unwrap()).is_err());
}

#[tokio::test]
async fn org_discovery_remembers_matching_org_and_rediscovers_after_rejection() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let observed = calls.clone();
    let result = load_copilot(provider::Id("github-copilot".into()),"Copilot",100,Some("old"),move |path| { observed.lock().unwrap().push(path.clone()); async move { match path.as_str() {
        "/copilot_internal/user" => Ok(parse_json(r#"{"token_based_billing":true}"#).unwrap()),
        "/user/orgs" => Ok(parse_json(r#"[{"login":"old"},{"login":"non-copilot"},{"login":"work org"}]"#).unwrap()),
        "/orgs/old/settings/billing/usage/summary" => Err(Error::Request(Some(404))),
        "/orgs/non-copilot/settings/billing/usage/summary" => Ok(parse_json(r#"{"usageItems":[{"product":"Actions","unitType":"Minutes","grossQuantity":5}]}"#).unwrap()),
        "/orgs/work%20org/settings/billing/usage/summary" => Ok(parse_json(r#"{"usageItems":[{"product":"Copilot","unitType":"ai-units","grossQuantity":77,"netAmount":0.77}]}"#).unwrap()),
        _ => panic!("unexpected request"),
    } }}).await.unwrap();
    assert_eq!(result.matched_org.as_deref(), Some("work org"));
    assert_eq!(result.snapshot.windows[0].used, Some(77.0));
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        [
            "/copilot_internal/user",
            "/orgs/old/settings/billing/usage/summary",
            "/user/orgs",
            "/orgs/non-copilot/settings/billing/usage/summary",
            "/orgs/work%20org/settings/billing/usage/summary"
        ]
    );
    let remembered = load_copilot(provider::Id("github-copilot".into()),"Copilot",100,Some("work org"),|path| async move { match path.as_str() { "/copilot_internal/user" => Ok(parse_json(r#"{"token_based_billing":true,"quota_snapshots":{"premium_interactions":{"entitlement":0,"credits_used":0}}}"#).unwrap()),"/orgs/work%20org/settings/billing/usage/summary" => Ok(parse_json(r#"{"usageItems":[{"product":"Copilot","unitType":"ai-credits","netAmount":0}]}"#).unwrap()),_ => panic!("must skip org rediscovery") } }).await.unwrap();
    assert_eq!(remembered.snapshot.windows.len(), 2);
    assert_eq!(remembered.snapshot.windows[0].id, "credits".into());
    assert_eq!(remembered.snapshot.source, "provider_internal_api".into());
}

#[tokio::test]
async fn optional_org_failure_preserves_personal_counts_and_required_status_error_propagates() {
    let result = load_copilot(provider::Id("github-copilot".into()),"Copilot",100,None,|path| async move { if path == "/copilot_internal/user" { return Ok(parse_json(r#"{"token_based_billing":true,"quota_snapshots":{"premium_interactions":{"entitlement":0,"credits_used":12}}}"#).unwrap()); } Err(Error::Request(Some(403))) }).await.unwrap();
    assert_eq!(result.snapshot.windows.len(), 1);
    assert_eq!(result.snapshot.windows[0].used, Some(12.0));
    assert!(result.matched_org.is_none());
    assert_eq!(
        load_copilot(
            provider::Id("github-copilot".into()),
            "Copilot",
            100,
            None,
            |_| async { Err(Error::Request(Some(401))) }
        )
        .await
        .unwrap_err(),
        Error::Request(Some(401))
    );
}

#[tokio::test]
async fn quota_snapshot_flags_must_be_booleans() {
    for flag in ["unlimited", "overage_permitted"] {
        let body = format!(
            r#"{{"quota_snapshots":{{"premium_interactions":{{"entitlement":10,"remaining":5,"{flag}":"yes"}}}}}}"#
        );
        let result = load_copilot(
            provider::Id("github-copilot".into()),
            "Copilot",
            100,
            None,
            move |_| {
                let body = body.clone();
                async move { Ok(parse_json(&body).unwrap()) }
            },
        )
        .await;
        assert_eq!(result.unwrap_err(), Error::InvalidResponse, "{flag}");
    }
}

#[tokio::test]
async fn negative_measured_org_billing_is_an_error_not_optional_discovery() {
    let result = load_copilot(provider::Id("github-copilot".into()),"Copilot",100,None,|path| async move { match path.as_str() { "/copilot_internal/user" => Ok(parse_json(r#"{"token_based_billing":true}"#).unwrap()),"/user/orgs" => Ok(parse_json(r#"[{"login":"bad"}]"#).unwrap()),_ => Ok(parse_json(r#"{"usageItems":[{"product":"Copilot","unitType":"ai-units","grossQuantity":-1}]}"#).unwrap()) } }).await;
    assert_eq!(result.unwrap_err(), Error::InvalidResponse);
}
