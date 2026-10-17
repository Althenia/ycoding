use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue,
    model_incident::{DecidedBy, Group, Guidance, Id, Item, Kind, Recent, Report, ReportRow},
    parse_json,
};

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn same(left: &JsonValue, right: &JsonValue) -> bool {
    match (left, right) {
        (JsonValue::Object(left), JsonValue::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same(value, other)))
        }
        (JsonValue::Array(left), JsonValue::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same(left, right))
        }
        _ => left == right,
    }
}

fn round_trip<T: DomainDecode + DomainEncode>(text: &str) -> T {
    let value = T::decode(&json(text)).unwrap();
    assert!(same(&value.encode(), &json(text)), "{text}");
    value
}

#[test]
fn identifiers_require_the_incident_prefix() {
    assert_eq!(
        round_trip::<Id>(r#""inc_01J00000000000000000000000""#)
            .0
            .as_str(),
        Some("inc_01J00000000000000000000000")
    );
    for bad in [r#""prq_one""#, r#""INC_one""#, "1", "null"] {
        assert!(Id::decode(&json(bad)).is_err(), "{bad}");
    }
}

#[test]
fn kinds_deciders_and_groups_are_closed_literals() {
    for kind in ["fallback", "guardrail-escalated", "guardrail-rejected"] {
        round_trip::<Kind>(&format!(r#""{kind}""#));
    }
    for decided in ["decision-model", "human"] {
        round_trip::<DecidedBy>(&format!(r#""{decided}""#));
    }
    for group in ["model", "agent"] {
        round_trip::<Group>(&format!(r#""{group}""#));
    }
    assert!(Kind::decode(&json(r#""guardrail""#)).is_err());
    assert!(DecidedBy::decode(&json(r#""model""#)).is_err());
    assert!(Group::decode(&json(r#""session""#)).is_err());
}

#[test]
fn a_report_carries_exact_counts_and_omits_the_agent_when_grouped_by_model() {
    let report = round_trip::<Report>(
        r#"{"rows":[{"providerID":"openai","modelID":"gpt","fallbacks":2,"escalated":1,"rejected":0,"last":42},{"providerID":"anthropic","modelID":"claude","agent":"build","fallbacks":0,"escalated":0,"rejected":3,"last":7}],"groups":5}"#,
    );
    assert_eq!(report.groups.get(), 5);
    assert_eq!(report.rows.len(), 2);
    let ReportRow {
        agent,
        fallbacks,
        last,
        ..
    } = &report.rows[0];
    assert!(agent.is_none());
    assert_eq!((fallbacks.get(), last.get()), (2, 42));
    assert_eq!(
        report.rows[1]
            .agent
            .as_ref()
            .and_then(|agent| agent.as_str()),
        Some("build")
    );
    for bad in [
        r#"{"rows":[{"providerID":"openai","modelID":"gpt","fallbacks":-1,"escalated":0,"rejected":0,"last":0}],"groups":1}"#,
        r#"{"rows":[{"providerID":"openai","modelID":"gpt","fallbacks":0,"escalated":0,"rejected":0}],"groups":1}"#,
        r#"{"rows":[],"groups":1.5}"#,
    ] {
        assert!(Report::decode(&json(bad)).is_err(), "{bad}");
    }
}

#[test]
fn recent_items_carry_identifiers_only_and_omit_absent_optionals() {
    let recent = round_trip::<Recent>(
        r#"{"items":[{"id":"inc_b","time":20,"kind":"fallback","category":"rate_limit","ruleIDs":[],"agent":"build","variant":"high","profile":"work","target":{"id":"mini","providerID":"openai"}},{"id":"inc_a","time":10,"kind":"guardrail-rejected","category":"hard","ruleIDs":["standard.review.force-push","custom"],"agent":"build","decidedBy":"human"}]}"#,
    );
    let [fallback, rejection]: [Item; 2] = recent.items.try_into().unwrap();
    assert_eq!(fallback.target.unwrap().id.as_str(), Some("mini"));
    assert!(fallback.decided_by.is_none());
    assert!(rejection.target.is_none() && rejection.variant.is_none());
    assert_eq!(
        rejection.decided_by.map(|decided| decided.0),
        Some("human".into())
    );
    assert!(
        Item::decode(&json(
            r#"{"id":"inc_a","time":10,"kind":"guardrail-rejected","category":"hard","ruleIDs":"custom","agent":"build"}"#
        ))
        .is_err()
    );
}

#[test]
fn guidance_reports_enablement_with_optional_text_and_watermark() {
    let guidance = round_trip::<Guidance>(
        r#"{"text":"<model-guidance>\n</model-guidance>","clearedAt":5,"enabled":true}"#,
    );
    assert_eq!(guidance.cleared_at.map(|at| at.get()), Some(5));
    let empty = round_trip::<Guidance>(r#"{"enabled":false}"#);
    assert!(empty.text.is_none() && empty.cleared_at.is_none() && !empty.enabled);
    assert!(Guidance::decode(&json(r#"{"text":"x"}"#)).is_err());
    assert!(Guidance::decode(&json(r#"{"clearedAt":-1,"enabled":true}"#)).is_err());
}
