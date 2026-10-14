use ycoding_core::resources::model::quota::{
    normalize_claude, normalize_codex, normalize_cursor, normalize_go, normalize_grok,
    normalize_openrouter, normalize_organization, normalize_zai,
};
use ycoding_schema::{parse_json, provider};

#[test]
fn claude_scoped_lanes_cents_and_reset_preserve_unknown_values() {
    let snapshot = normalize_claude(provider::Id("anthropic".into()),"Claude",100,&parse_json(r#"{"five_hour":{"utilization":0,"resets_at":1767225600},"seven_day":null,"extra_usage":{"is_enabled":true,"monthly_limit":1000},"limits":[{"kind":"weekly_scoped","scope":{"model":{"display_name":"Sonnet"}},"percent":20}]}"#).unwrap()).unwrap();
    assert_eq!(snapshot.source, "provider_internal_api".into());
    assert_eq!(snapshot.windows[0].used, Some(0.0));
    assert_eq!(snapshot.windows[0].reset_at.unwrap().get(), 1767225600000);
    assert_eq!(snapshot.windows[1].used, None);
    assert_eq!(snapshot.windows[1].limit, Some(10.0));
    assert_eq!(snapshot.windows[2].label, "Sonnet weekly".into());
}

#[test]
fn grok_weekly_clamps_over_limit_and_monthly_proto_zero_is_not_weekly() {
    let weekly = normalize_grok(provider::Id("xai".into()),"Grok",100,&parse_json(r#"{"config":{"creditUsagePercent":135,"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-09-21T00:00:00Z","end":"2026-09-28T00:00:00Z"},"onDemandCap":{"val":2500}}}"#).unwrap()).unwrap();
    assert_eq!(weekly.windows.len(), 2);
    assert_eq!(weekly.windows[0].used, Some(100.0));
    assert_eq!(weekly.windows[0].period_seconds.unwrap().get(), 604800);
    assert_eq!(weekly.windows[0].reset_at.unwrap().get(), 1790553600000);
    assert_eq!(weekly.windows[1].limit, Some(2500.0));
    let monthly = normalize_grok(provider::Id("xai".into()),"Grok",100,&parse_json(r#"{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_MONTHLY","start":"2026-09-01T00:00:00Z","end":"2026-10-01T00:00:00Z"}}}"#).unwrap()).unwrap();
    assert_eq!(monthly.windows.len(), 1);
    assert_eq!(monthly.windows[0].id, "extra-usage".into());
    assert_eq!(monthly.windows[0].limit, Some(0.0));
    for response in [
        r#"{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY"}}}"#,
        r#"{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-09-21T00:00:00Z","end":"2026-09-28T00:00:00Z"},"onDemandCap":"unknown"}}"#,
    ] {
        assert!(
            normalize_grok(
                provider::Id("xai".into()),
                "Grok",
                100,
                &parse_json(response).unwrap()
            )
            .is_err()
        );
    }
}

#[test]
fn go_three_windows_clamp_preserve_zero_and_ignore_invalid_reset() {
    let result = normalize_go(provider::Id("opencode-go".into()),"OpenCode Go",100,&parse_json(r#"{"usage":{"rolling":{"percent":130,"resetsAt":"2026-09-28T00:00:00Z"},"weekly":{"percent":0,"resetsAt":"invalid"},"monthly":{"percent":51}}}"#).unwrap()).unwrap();
    assert_eq!(
        result.windows.iter().map(|w| w.used).collect::<Vec<_>>(),
        vec![Some(100.0), Some(0.0), Some(51.0)]
    );
    assert_eq!(
        result
            .windows
            .iter()
            .map(|w| w.period_seconds.unwrap().get())
            .collect::<Vec<_>>(),
        vec![18000, 604800, 2592000]
    );
    assert_eq!(result.windows[0].reset_at.unwrap().get(), 1790553600000);
    assert!(result.windows[1].reset_at.is_none());
    assert!(
        normalize_go(
            provider::Id("opencode-go".into()),
            "Go",
            100,
            &parse_json(
                r#"{"usage":{"rolling":{},"weekly":{"percent":1},"monthly":{"percent":2}}}"#
            )
            .unwrap()
        )
        .is_err()
    );
}

#[test]
fn cursor_all_lanes_unknown_values_and_allowance_units_remain_separate() {
    let response = parse_json(r#"{"billingCycleStart":"1790828591000","billingCycleEnd":"1793506991000","planUsage":{"totalPercentUsed":125,"autoPercentUsed":10,"apiPercentUsed":0,"limit":2000,"remaining":1500}}"#).unwrap();
    let result = normalize_cursor(
        provider::Id("cursor".into()),
        "Cursor",
        100,
        &response,
        Some(&parse_json(r#"{"planInfo":{"planName":" Pro "}}"#).unwrap()),
    )
    .unwrap();
    assert_eq!(result.label, "Cursor Pro".into());
    assert_eq!(result.windows.len(), 3);
    assert_eq!(result.windows[0].used, Some(100.0));
    assert_eq!(result.windows[0].period_seconds.unwrap().get(), 2678400);
    assert_eq!(result.windows[2].used, Some(0.0));
    assert!(
        result
            .windows
            .iter()
            .all(|w| w.limit.is_none() && w.remaining.is_none())
    );
    let unknown = normalize_cursor(provider::Id("cursor".into()),"Cursor",100,&parse_json(r#"{"planUsage":{"totalPercentUsed":40,"autoPercentUsed":"x"},"billingCycleStart":10,"billingCycleEnd":5}"#).unwrap(),None).unwrap();
    assert_eq!(unknown.windows.len(), 1);
    assert!(unknown.windows[0].period_seconds.is_none());
    assert!(
        normalize_cursor(
            provider::Id("cursor".into()),
            "Cursor",
            100,
            &parse_json(r#"{"enabled":true}"#).unwrap(),
            None
        )
        .is_err()
    );
}

#[test]
fn openrouter_limits_credits_and_balance_are_distinct_and_zero_credit_total_has_only_balance() {
    let result = normalize_openrouter(provider::Id("openrouter".into()),"OpenRouter",100,&parse_json(r#"{"data":{"is_free_tier":true,"limit":20,"limit_remaining":5,"usage_daily":0,"usage_weekly":2,"usage_monthly":3}}"#).unwrap(),Some(&parse_json(r#"{"data":{"total_credits":100,"total_usage":120}}"#).unwrap())).unwrap();
    assert_eq!(result.label, "OpenRouter · Free tier".into());
    assert_eq!(result.windows.len(), 6);
    assert_eq!(result.windows[0].used, Some(15.0));
    assert_eq!(result.windows[4].remaining, Some(0.0));
    assert_eq!(result.windows[5].remaining, Some(0.0));
    let zero = normalize_openrouter(
        provider::Id("openrouter".into()),
        "OpenRouter",
        100,
        &parse_json(r#"{"data":{"limit":0}}"#).unwrap(),
        Some(&parse_json(r#"{"data":{"total_credits":0,"total_usage":0}}"#).unwrap()),
    )
    .unwrap();
    assert_eq!(zero.windows.len(), 1);
    assert_eq!(zero.windows[0].id, "balance".into());
    assert!(
        normalize_openrouter(
            provider::Id("openrouter".into()),
            "OpenRouter",
            100,
            &parse_json(r#"{"data":{}}"#).unwrap(),
            Some(&parse_json(r#"{"data":{"total_credits":1}}"#).unwrap())
        )
        .is_err()
    );
}

#[test]
fn codex_named_windows_and_missing_usage_are_not_zero() {
    let snapshot = normalize_codex(provider::Id("openai".into()),"Codex",100,&parse_json(r#"{"rate_limits":{"plan_type":"pro","primary_window":{"used_percent":0,"limit_window_seconds":18000,"reset_at":1767225600},"secondary_window":{}},"rate_limits_by_limit_id":{"codex_spark":{"secondary":{"usedPercent":15,"windowDurationMins":10080}}},"rate_limit_reset_credits":{"available_count":0}}"#).unwrap(),"provider_internal_api","best_effort").unwrap();
    assert_eq!(snapshot.label, "Codex Pro".into());
    assert_eq!(snapshot.windows.len(), 3);
    assert_eq!(snapshot.windows[0].used, Some(0.0));
    assert_eq!(snapshot.windows[1].label, "Spark weekly".into());
    assert_eq!(snapshot.windows[2].remaining, Some(0.0));
}

#[test]
fn organization_meta_unknown_bill_is_absent_and_openai_empty_bucket_is_zero() {
    let meta = normalize_organization(
        provider::Id("meta".into()),
        "Meta",
        100,
        (0.0, 0.0),
        &[],
        &[],
        true,
    )
    .unwrap();
    assert_eq!(meta.windows[0].used, None);
    let openai = normalize_organization(
        provider::Id("openai".into()),
        "Openai",
        100,
        (0.0, 0.0),
        &[],
        &[],
        false,
    )
    .unwrap();
    assert_eq!(openai.windows[0].used, Some(0.0));
    assert_eq!(openai.windows.len(), 6);
}

#[test]
fn zai_quota_periods_and_plan_name_do_not_publish_raw_payload() {
    let result = normalize_zai(provider::Id("zai".into()),"Z.ai",100,&parse_json(r#"{"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":120},{"type":"TIME_LIMIT","currentValue":0,"usage":100}]}}"#).unwrap(),Some(&parse_json(r#"{"data":[{"productName":" Max "}]}"#).unwrap())).unwrap();
    assert_eq!(result.label, "Z.ai Max".into());
    assert_eq!(result.windows[0].used, Some(100.0));
    assert_eq!(result.windows[0].period_seconds.unwrap().get(), 18000);
    assert_eq!(result.windows[1].used, Some(0.0));
}

#[test]
fn organization_nonempty_buckets_filter_periods_sum_tokens_and_bill_due_date() {
    let usage = [parse_json(r#"{"start_time":1790553600,"end_time":1790640000,"results":[{"num_model_requests":2,"input_tokens":10,"output_tokens":5},{"num_model_requests":0,"input_tokens":0,"output_tokens":0}]}"#).unwrap()];
    let costs = [parse_json(r#"{"start_time":1790553600,"end_time":1790640000,"results":[{"amount":{"currency":"usd","value":1.5}},{"amount":{"currency":"usd","value":0.5}}]}"#).unwrap()];
    let result = normalize_organization(
        provider::Id("openai".into()),
        "Openai",
        100,
        (1790640000.0, 1788220800.0),
        &usage,
        &costs,
        false,
    )
    .unwrap();
    assert_eq!(
        result.windows.iter().map(|w| w.used).collect::<Vec<_>>(),
        vec![
            Some(0.0),
            Some(2.0),
            Some(0.0),
            Some(2.0),
            Some(0.0),
            Some(15.0)
        ]
    );
    let meta_usage = [parse_json(r#"{"start_time":1790553600,"end_time":1790640000,"results":[{"num_requests":1,"prompt_tokens":12,"completion_tokens":3},{}]}"#).unwrap()];
    let meta = normalize_organization(
        provider::Id("meta".into()),
        "Meta",
        100,
        (1790553600.0, 1788220800.0),
        &meta_usage,
        &costs,
        true,
    )
    .unwrap();
    assert_eq!(meta.windows[0].used, Some(2.0));
    assert_eq!(meta.windows[0].reset_at.unwrap().get(), 1790812800000);
    assert_eq!(meta.windows[3].used, Some(15.0));
    assert!(
        normalize_organization(
            provider::Id("openai".into()),
            "Openai",
            100,
            (0.0, 0.0),
            &meta_usage,
            &costs,
            false
        )
        .is_err()
    );
    assert!(normalize_organization(provider::Id("openai".into()),"Openai",100,(0.0,0.0),&usage,&[parse_json(r#"{"start_time":0,"end_time":1,"results":[{"amount":{"currency":"eur","value":1}}]}"#).unwrap()],false).is_err());
}

#[test]
fn codex_credit_additional_monthly_and_status_branches_preserve_labels_and_absence() {
    let response = parse_json(r#"{"result":{"rateLimits":{"credits":{"hasCredits":true,"balance":"18.50"},"individualLimit":{"limit":"10","spent":"3.123"},"rateLimitReachedType":" weekly ","spendControlReached":true},"additionalRateLimits":[null,{"limitId":"unknown_feature","rateLimit":{"primary":{"usedPercent":"8","windowDurationMins":60},"credits":{"unlimited":true}}},{"primary":{"usedPercent":0}}],"rateLimitsByLimitId":{"other":{"credits":{"hasCredits":false,"balance":100}}}}}"#).unwrap();
    let result = normalize_codex(
        provider::Id("openai".into()),
        "Codex",
        100,
        &response,
        "local_client_rpc",
        "client_contract",
    )
    .unwrap();
    assert_eq!(result.windows.len(), 5);
    assert_eq!(result.windows[0].remaining, Some(18.5));
    assert_eq!(result.windows[1].remaining, Some(6.88));
    assert_eq!(result.windows[2].label, "Unknown Feature primary".into());
    assert_eq!(result.windows[3].unlimited, Some(true));
    assert!(result.windows[3].remaining.is_none());
    assert_eq!(result.windows[4].id, "additional-3-primary".into());
    assert_eq!(
        result.message,
        Some("Reached: weekly · Spend control reached".into())
    );
    assert!(
        normalize_codex(
            provider::Id("openai".into()),
            "Codex",
            100,
            &parse_json(r#"{"primary":{"usedPercent":101}}"#).unwrap(),
            "provider_internal_api",
            "best_effort"
        )
        .is_err()
    );
}

#[test]
fn claude_all_model_buckets_deduplicate_scoped_lanes_and_validate_numeric_inputs() {
    let response = parse_json(r#"{"five_hour":null,"seven_day":{"utilization":"12.345"},"seven_day_sonnet":{"utilization":20},"extra_usage":{"is_enabled":true,"used_credits":1200,"monthly_limit":1000},"limits":[{"kind":"weekly_scoped","scope":{"model":{"display_name":"Sonnet"}},"percent":99},{"kind":"other"},{"kind":"weekly_scoped","scope":{"model":{"display_name":" "}},"percent":10}]}"#).unwrap();
    let result =
        normalize_claude(provider::Id("anthropic".into()), "Claude", 100, &response).unwrap();
    assert_eq!(result.windows.len(), 3);
    assert_eq!(result.windows[0].label, "All models".into());
    assert_eq!(result.windows[0].used, Some(12.35));
    assert_eq!(result.windows[1].label, "Sonnet weekly".into());
    assert_eq!(result.windows[2].used, Some(12.0));
    assert_eq!(result.windows[2].remaining, Some(0.0));
    assert!(
        normalize_claude(
            provider::Id("anthropic".into()),
            "Claude",
            100,
            &parse_json(r#"{"seven_day":{"utilization":101}}"#).unwrap()
        )
        .is_err()
    );
    let empty = normalize_claude(
        provider::Id("anthropic".into()),
        "Claude",
        100,
        &parse_json(
            r#"{"extra_usage":{"is_enabled":false},"unknown":{"utilization":10},"seven_day":{}}"#,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(empty.windows.is_empty());
}

#[test]
fn zai_day_week_unit_unknown_type_and_reset_branches() {
    let response = parse_json(r#"{"limits":[{"name":"CREDIT_LIMIT","unit":4,"number":1,"percentage":0,"nextResetTime":1790553600000},{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":50},{"type":"TOKENS_LIMIT","unit":99,"number":1,"percentage":80},{"type":"OTHER"}]}"#).unwrap();
    let result = normalize_zai(provider::Id("zai".into()), "Z.ai", 100, &response, None).unwrap();
    assert_eq!(result.windows.len(), 2);
    assert_eq!(result.windows[0].id, "weekly".into());
    assert_eq!(result.windows[0].period_seconds.unwrap().get(), 86400);
    assert_eq!(result.windows[1].period_seconds.unwrap().get(), 604800);
    assert_eq!(result.windows[0].reset_at.unwrap().get(), 1790553600000);
    assert!(
        normalize_zai(
            provider::Id("zai".into()),
            "Z.ai",
            100,
            &parse_json(
                r#"{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":0,"percentage":10}]}"#
            )
            .unwrap(),
            None
        )
        .is_err()
    );
}
