use crate::{
    convert,
    dispatch::{Failure, Invocation},
};
use prost::Message;
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, JsonObject, JsonValue, LosslessString, usage_dashboard,
};
use ycoding_protocol::{
    domain_json::{self, Domain},
    v5,
};

pub async fn read(
    invocation: Invocation,
    request: v5::UsageDashboardRequest,
) -> Result<v5::UsageDashboardResult, Failure> {
    let core = invocation.core()?;
    let service = core.usage_dashboard.as_ref().ok_or_else(unavailable)?;
    let input = domain_json::decode(
        "ycoding.v5.UsageDashboard_Input",
        &request.payload.encode_to_vec(),
    )
    .map_err(|_| Failure::Invalid("Invalid Usage dashboard input".into()))?;
    let input = usage_dashboard::Input::decode(&json(input)?)
        .map_err(|_| Failure::Invalid("Invalid Usage dashboard input".into()))?;
    let mut prepared_input = input.clone();
    prepared_input.refresh = None;
    let mut data = service.read(usage_dashboard::Quota::Preparing, &prepared_input);
    if let usage_dashboard::Info::Ready(ready) = &mut data {
        let (quota, selected) =
            crate::provider_usage::dashboard(&invocation, input.refresh.unwrap_or(false));
        ready.quota = quota;
        if selected.is_some_and(|selected| {
            !accounting_matches(&ready.revision, selected.accounting_revision.as_ref())
                || !crate::provider_usage::current(&invocation, &selected)
        }) {
            data = usage_dashboard::Info::Preparing;
        }
    }
    if input.refresh.unwrap_or(false) {
        data = service.read(usage_dashboard::Quota::Preparing, &input);
    }
    Ok(v5::UsageDashboardResult { data: wire(&data)? })
}

fn accounting_matches(revision: &LosslessString, selected: Option<&LosslessString>) -> bool {
    selected == Some(revision)
}

fn wire(value: &usage_dashboard::Info) -> Result<v5::UsageDashboardInfo, Failure> {
    let bytes = domain_json::encode(
        "ycoding.v5.UsageDashboard_Info",
        &convert::json_domain(&value.encode()),
        16 * 1024 * 1024,
    )
    .map_err(|_| unavailable())?;
    v5::UsageDashboardInfo::decode(bytes.as_slice()).map_err(|_| unavailable())
}

fn unavailable() -> Failure {
    Failure::Unavailable("Prepared Usage dashboard is not representable on the wire".into())
}

fn json(value: Domain) -> Result<JsonValue, Failure> {
    Ok(match value {
        Domain::Null => JsonValue::Null,
        Domain::Bool(value) => JsonValue::Bool(value),
        Domain::Number(value) => JsonValue::Number(value),
        Domain::Text(value) => JsonValue::String(LosslessString::from_utf16(value)),
        Domain::List(values) => {
            JsonValue::Array(values.into_iter().map(json).collect::<Result<_, _>>()?)
        }
        Domain::Object(values) => {
            let mut object = JsonObject::new();
            for (key, value) in values {
                object.insert(LosslessString::from_utf16(key), json(value)?);
            }
            JsonValue::Object(object)
        }
        Domain::Bytes(_) => {
            return Err(Failure::Invalid(
                "Unexpected bytes in Usage dashboard input".into(),
            ));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dashboard_statuses_roundtrip_through_current_contract() {
        for source in [
            r#"{"status":"preparing"}"#,
            r#"{"status":"error","message":"Synthetic preparation failed"}"#,
        ] {
            let value = usage_dashboard::Info::decode(
                &ycoding_core::ycoding_schema::parse_json(source).unwrap(),
            )
            .unwrap();
            let encoded = wire(&value).unwrap().encode_to_vec();
            let decoded =
                json(domain_json::decode("ycoding.v5.UsageDashboard_Info", &encoded).unwrap())
                    .unwrap();
            assert_eq!(usage_dashboard::Info::decode(&decoded).unwrap(), value);
        }
    }

    const TOKENS: &str =
        r#"{"input":123456.5,"output":7890,"reasoning":0.25,"cache":{"read":4096,"write":0}}"#;
    const MODEL: &str =
        r#"{"id":"gpt-5.6","providerID":"openai","variant":"high","profile":"work"}"#;
    const SPEED: &str = r#"{"generationSamples":12,"generationP50TokensPerSecond":41.5,"generationP90TokensPerSecond":55,"generationP95TokensPerSecond":0,"meanTokensPerSecond":43.25,"providerTimedSamples":7,"observedSamples":5,"firstOutputP50Ms":310,"firstOutputP95Ms":900,"firstOutputP99Ms":0,"totalP50Ms":2100,"totalP95Ms":6400,"totalP99Ms":9007199254740991,"outputTokensPerSecond":40.125,"samples":15}"#;
    const METRICS: &str = r#""logical":3,"physical":4,"helpers":1,"continued":2,"fallback":0,"costCoverage":{"pricedRequests":3,"unpricedRequests":0},"tokens":$T,"cost":1.5,"costProvenance":"current_catalog","cacheReadReported":false,"outcomes":{"completed":2,"failed":1,"cancelled":0}"#;

    fn ready(reports: &str) -> String {
        let source = format!(
            r#"{{"status":"ready","asOf":9007199254740991,"revision":"rev-ready-1",
"summary":{{"logical":120,"physical":134,"helpers":9,"continued":4,"fallback":1,"cacheReadReported":false,"cost":12.375,
"models":[{{"model":{MODEL},"requests":90,"tokens":$T,"cacheReadReported":true,"cost":9.5,"costProvenance":"recorded"}},{{"model":{{"id":"local","providerID":"ollama"}},"requests":44,"tokens":$T}}],
"tokens":$T,"latestInvalidation":"stable-hit","latestNamespace":"ab12cd34",
"latestTiming":{{"firstOutputMs":0,"totalMs":2500,"retryWaitMs":120,"promptEvalDurationNs":1000000,"generationDurationNs":2000000,"observedGenerationDurationNs":2100000,"generatedTokens":64,"estimatedTokens":70,"estimatedGenerationDurationNs":2200000,"receivedOutput":{{"estimatedTokens":66,"durationNs":2150000}},"loadDurationNs":0}}}},
"quota":{{"status":"ready","providers":[
{{"providerID":"openai","label":"OpenAI","profile":"work","status":"available","source":"provider_api","stability":"stable","updatedAt":1790000000000,
"windows":[{{"id":"five-hour","label":"5 hours","group":"codex","unit":"percent","used":42.5,"limit":100,"remaining":57.5,"unlimited":false,"resetAt":1790000018000,"periodSeconds":18000}},{{"id":"credits","label":"Credits","unit":"usd","used":0,"unlimited":true}}],"message":"Synthetic snapshot"}},
{{"providerID":"anthropic","label":"Anthropic","status":"error","source":"local_session","stability":"best_effort","updatedAt":0,"windows":[]}}],
"forecast":{{"asOf":4,"localScope":"location",
"localRates":[{{"providerID":"openai","profile":"work","modelID":"gpt-5.6","observedFrom":1,"observedTo":9007199254740991,"tokensPerMinute":1234.5,"tokensPerMinute5":0,"tokensPerMinute60":999.25,"estimatedUSDPerHour":0.5,"coverage":{{"pricedRequests":3,"unpricedRequests":0}}}},{{"providerID":"ollama","observedFrom":0,"observedTo":0,"tokensPerMinute":0,"coverage":{{"pricedRequests":0,"unpricedRequests":4}}}}],
"quotas":[{{"providerID":"openai","profile":"work","windowID":"five-hour","unit":"percent","source":"provider_api","stability":"stable","updatedAt":3,"state":"estimated","method":"quota-delta-ema","evidence":"medium","reason":"Synthetic pace","observedFrom":1,"observedTo":2,"ratePerHour":3.5,"exhaustionAt":9,"projectedUsedAtReset":88.75,"pace":{{"verdict":"cutting-it-close","projectedUsedAtReset":88.75,"exhaustionAt":0}}}},{{"providerID":"anthropic","windowID":"weekly","unit":"tokens","source":"response_headers","stability":"observed","updatedAt":0,"state":"insufficient","evidence":"insufficient"}}]}}}},
"live":{{"asOf":9,"active":2,"streaming":1,"outputTokensPerSecond":42.5,"models":[{{"model":{MODEL},"active":2,"streaming":1,"outputTokensPerSecond":0}},{{"model":{{"id":"local","providerID":"ollama"}},"active":0,"streaming":0}}],"history":[{{"at":5,"active":1,"outputTokensPerSecond":0}},{{"at":10,"active":2}}]}}{reports}}}"#
        );
        source.replace("$T", TOKENS)
    }

    fn reports() -> String {
        let metrics = METRICS.replace("$T", TOKENS);
        format!(
            r#","daily":{{"group":"day","rows":[{{"key":"2026-10-30","label":"Oct 30","model":{MODEL},{metrics},"speed":{SPEED},"concurrency":1.5}}],"total":{{{metrics}}},"rowCount":3,"nextOffset":1,"speed":{SPEED}}},"monthly":{{"group":"month","rows":[],"total":{{"logical":0,"physical":0,"helpers":0,"continued":0,"fallback":0,"tokens":{TOKENS}}},"rowCount":0,"nextOffset":0}},"breakdown":{{"group":"provider-model","rows":[{{"key":"openai/gpt-5.6","label":"OpenAI gpt-5.6","dimensions":{{"group":"provider-model","providerID":"openai","modelID":"gpt-5.6"}},{metrics},"concurrency":0}}],"total":{{{metrics}}},"rowCount":1}}"#
        )
    }

    fn read(source: &str) -> (usage_dashboard::Info, v5::UsageDashboardReady) {
        let value = usage_dashboard::Info::decode(
            &ycoding_core::ycoding_schema::parse_json(source).unwrap(),
        )
        .unwrap();
        let usage_dashboard::Info::Ready(held) = &value else {
            panic!("ready dashboard expected")
        };
        assert_eq!(held.revision, "rev-ready-1".into());
        let bytes = wire(&value).unwrap().encode_to_vec();
        let decoded =
            json(domain_json::decode("ycoding.v5.UsageDashboard_Info", &bytes).unwrap()).unwrap();
        assert_eq!(usage_dashboard::Info::decode(&decoded).unwrap(), value);
        let Some(v5::usage_dashboard_info::Kind::Value3(typed)) =
            v5::UsageDashboardInfo::decode(bytes.as_slice())
                .unwrap()
                .kind
        else {
            panic!("ready wire branch expected")
        };
        (value, typed)
    }

    #[test]
    fn ready_dashboard_without_reports_roundtrips_every_section_and_omits_the_absent_reports() {
        let (value, typed) = read(&ready(""));
        let usage_dashboard::Info::Ready(held) = &value else {
            unreachable!()
        };
        assert!(held.daily.is_none() && held.monthly.is_none() && held.breakdown.is_none());
        assert!(typed.daily.is_none() && typed.monthly.is_none() && typed.breakdown.is_none());
        let JsonValue::Object(encoded) = value.encode() else {
            panic!("object expected")
        };
        for key in ["daily", "monthly", "breakdown"] {
            assert!(encoded.get(&key.into()).is_none(), "{key}");
        }
        assert_eq!(typed.as_of, 9_007_199_254_740_991);
        assert_eq!(
            convert::domain(&typed.revision).unwrap(),
            "rev-ready-1".into()
        );
        assert_eq!(typed.summary.logical, 120);
        assert_eq!(typed.summary.cache_read_reported, Some(false));
        assert_eq!(typed.summary.cost, Some(12.375));
        assert_eq!(typed.summary.tokens.input, 123_456.5);
        assert_eq!(typed.summary.tokens.reasoning, 0.25);
        assert_eq!(typed.summary.models.as_ref().unwrap().items.len(), 2);
        assert_eq!(typed.summary.models.as_ref().unwrap().items[1].cost, None);
        let timing = typed.summary.latest_timing.as_ref().unwrap();
        assert_eq!(
            (timing.first_output_ms, timing.load_duration_ns),
            (Some(0), Some(0))
        );
        assert_eq!(
            timing.received_output.as_ref().unwrap().duration_ns,
            2_150_000
        );
        let Some(v5::usage_dashboard_quota::Kind::Value2(quota)) = typed.quota.kind else {
            panic!("ready quota expected")
        };
        assert_eq!(quota.providers.items.len(), 2);
        assert_eq!(quota.providers.items[0].windows.items.len(), 2);
        assert_eq!(quota.providers.items[0].windows.items[1].used, Some(0.0));
        assert_eq!(quota.providers.items[0].windows.items[1].limit, None);
        assert_eq!(
            quota.providers.items[0].windows.items[0].reset_at,
            Some(1_790_000_018_000)
        );
        assert!(
            quota.providers.items[1].profile.is_none()
                && quota.providers.items[1].message.is_none()
        );
        assert_eq!(quota.forecast.as_of, 4);
        let rates = quota.forecast.local_rates.as_ref().unwrap();
        assert_eq!(rates.items[0].tokens_per_minute5, Some(0.0));
        assert_eq!(rates.items[0].observed_to, 9_007_199_254_740_991);
        assert_eq!(rates.items[1].tokens_per_minute5, None);
        let quotas = quota.forecast.quotas.as_ref().unwrap();
        assert_eq!(
            quotas.items[0].pace.as_ref().unwrap().exhaustion_at,
            Some(0)
        );
        assert!(quotas.items[1].pace.is_none() && quotas.items[1].method.is_none());
        assert_eq!(typed.live.output_tokens_per_second, Some(42.5));
        assert_eq!(
            typed.live.models.items[0].output_tokens_per_second,
            Some(0.0)
        );
        assert_eq!(typed.live.models.items[1].output_tokens_per_second, None);
        assert_eq!(
            typed.live.history.items[0].output_tokens_per_second,
            Some(0.0)
        );
        assert_eq!(typed.live.history.items[1].output_tokens_per_second, None);
    }

    #[test]
    fn ready_dashboard_with_all_reports_roundtrips_rows_dimensions_and_zero_versus_absent_values() {
        let (value, typed) = read(&ready(&reports()));
        let usage_dashboard::Info::Ready(held) = &value else {
            unreachable!()
        };
        assert!(held.daily.is_some() && held.monthly.is_some() && held.breakdown.is_some());
        let daily = typed.daily.as_ref().unwrap();
        assert_eq!((daily.row_count, daily.next_offset), (3, Some(1)));
        assert_eq!(daily.rows.items.len(), 1);
        assert!(daily.rows.items[0].model.is_some() && daily.rows.items[0].dimensions.is_none());
        assert_eq!(daily.rows.items[0].concurrency, Some(1.5));
        assert_eq!(daily.rows.items[0].cache_read_reported, Some(false));
        assert_eq!(daily.rows.items[0].cost, Some(1.5));
        assert_eq!(
            daily.rows.items[0]
                .cost_coverage
                .as_ref()
                .unwrap()
                .unpriced_requests,
            0
        );
        assert_eq!(daily.rows.items[0].outcomes.as_ref().unwrap().cancelled, 0);
        let speed = daily.speed.as_ref().unwrap();
        assert_eq!(speed.generation_p95_tokens_per_second, Some(0.0));
        assert_eq!(speed.first_output_p99_ms, Some(0));
        assert_eq!(speed.total_p99_ms, Some(9_007_199_254_740_991));
        assert_eq!(daily.rows.items[0].speed.as_ref().unwrap().samples, 15);
        let monthly = typed.monthly.as_ref().unwrap();
        assert_eq!((monthly.row_count, monthly.next_offset), (0, Some(0)));
        assert!(monthly.rows.items.is_empty() && monthly.speed.is_none());
        assert_eq!(monthly.total.cost, None);
        let breakdown = typed.breakdown.as_ref().unwrap();
        assert_eq!(breakdown.next_offset, None);
        assert_eq!(breakdown.rows.items[0].concurrency, Some(0.0));
        assert!(
            breakdown.rows.items[0].dimensions.is_some() && breakdown.rows.items[0].model.is_none()
        );
        assert!(breakdown.speed.is_none() && breakdown.rows.items[0].speed.is_none());
    }

    #[test]
    fn ready_dashboard_rejects_incomplete_or_inconsistent_sections_before_the_wire() {
        let good = ready("");
        let decode = |source: &str| {
            usage_dashboard::Info::decode(
                &ycoding_core::ycoding_schema::parse_json(source).unwrap(),
            )
        };
        assert!(decode(&good).is_ok());
        for broken in [
            good.replace(r#""revision":"rev-ready-1","#, ""),
            good.replacen(
                r#""status":"ready","providers""#,
                r#""status":"ready","unknown""#,
                1,
            ),
            good.replace(
                r#""latestNamespace":"ab12cd34""#,
                r#""latestNamespace":"short""#,
            ),
            good.replace(r#""cost":9.5,"costProvenance":"recorded""#, r#""cost":9.5"#),
            good.replace(
                r#""active":2,"streaming":1,"outputTokensPerSecond":0}"#,
                r#""active":2,"streaming":1,"outputTokensPerSecond":-1}"#,
            ),
            ready(
                r#","daily":{"group":"provider","rows":[{"key":"k","label":"l","logical":0,"physical":0,"helpers":0,"continued":0,"fallback":0,"tokens":$T}],"total":{"logical":0,"physical":0,"helpers":0,"continued":0,"fallback":0,"tokens":$T},"rowCount":1}"#,
            ),
        ] {
            assert!(decode(&broken.replace("$T", TOKENS)).is_err(), "{broken}");
        }
    }

    #[test]
    fn selected_accounting_revision_must_exist_and_match_exactly() {
        let revision: LosslessString = "accounting-current".into();
        let previous: LosslessString = "accounting-previous".into();
        assert!(!accounting_matches(&revision, None));
        assert!(!accounting_matches(&revision, Some(&previous)));
        assert!(accounting_matches(&revision, Some(&revision)));
    }
}
