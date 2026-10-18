use prost::Message;
use ycoding_protocol::{
    decode_strict,
    domain_json::{self, Domain},
    v5,
};

#[test]
fn diagnostic_reasons_use_the_appended_escalation_field_without_other_judgments() {
    for (index, reason) in [
        "unavailable",
        "invalid-request",
        "provider-failed",
        "timeout",
        "input-too-large",
        "invalid-output",
        "refused",
        "truncated-output",
        "unsupported-output",
        "escalated",
        "low_confidence",
        "conflicting_grades",
    ]
    .iter()
    .enumerate()
    {
        let bytes = [0x20, (index + 1) as u8];
        let value = decode_strict::<v5::GuardrailEscalation>(&bytes).unwrap();
        assert_eq!(value.encode_to_vec(), bytes);
        assert_eq!(
            domain_json::decode("ycoding.v5.Guardrail_Escalation", &bytes).unwrap(),
            Domain::Object(vec![(
                "reason".encode_utf16().collect(),
                Domain::Text(reason.encode_utf16().collect())
            )]),
        );
    }
}

#[test]
fn review_reasons_keep_existing_numbers_and_append_failure_and_conflict_causes() {
    for reason in 1..=17 {
        assert!(
            v5::SessionReviewReason::try_from(reason).is_ok(),
            "{reason}"
        );
    }
    assert!(v5::SessionReviewReason::try_from(0).is_err());
    assert!(v5::SessionReviewReason::try_from(18).is_err());
}
