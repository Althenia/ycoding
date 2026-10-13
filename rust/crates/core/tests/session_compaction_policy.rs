use ycoding_ai::llm;
use ycoding_core::session::{
    compaction_constraints,
    compaction_policy::{Advisory, Info, admission_digest, resolve},
    context_pressure::{self, Capabilities, Level, Usage},
    prompt_cache::sha256,
};
use ycoding_schema::{DomainDecode, parse_json};

fn info(json: &str) -> Result<Info, ycoding_schema::DecodeError> {
    Info::decode(&parse_json(json).unwrap())
}

#[test]
fn later_policy_documents_override_field_by_field_and_advisory_can_be_disabled() {
    let first = info(r#"{"keep_recent_messages":5,"advisory":{"consider_percent":50,"strongly_advised_percent":80}}"#).unwrap();
    let second = info(r#"{"timeout_seconds":9}"#).unwrap();
    let resolved = resolve(&[first.clone(), second]);
    assert_eq!(resolved.keep_recent_messages, 5);
    assert_eq!(resolved.timeout_seconds, 9);
    assert_eq!(resolved.max_manifest_bytes, 65_536);
    assert_eq!(
        resolved.advisory,
        Advisory::Thresholds {
            consider_percent: 50,
            strongly_advised_percent: 80
        }
    );
    let disabled = resolve(&[first, info(r#"{"advisory":false}"#).unwrap()]);
    assert_eq!(disabled.advisory, Advisory::Disabled);
    assert_eq!(resolve(&[]).context_safety_margin_tokens, 4_096);
}

#[test]
fn policy_decoding_rejects_out_of_range_and_inverted_advisory_thresholds() {
    assert!(info(r#"{"advisory":{"consider_percent":0,"strongly_advised_percent":50}}"#).is_err());
    assert!(
        info(r#"{"advisory":{"consider_percent":50,"strongly_advised_percent":100}}"#).is_err()
    );
    assert!(info(r#"{"advisory":{"consider_percent":80,"strongly_advised_percent":80}}"#).is_err());
    assert!(info(r#"{"advisory":{"consider_percent":90,"strongly_advised_percent":70}}"#).is_err());
    assert!(info(r#"{"keep_recent_messages":-1}"#).is_err());
    assert!(info(r#"{"timeout_seconds":1.5}"#).is_err());
}

#[test]
fn the_admission_digest_hashes_the_revision_and_ordered_policy() {
    let defaults = resolve(&[]);
    assert_eq!(
        admission_digest(&defaults),
        sha256(
            r#"{"revision":4,"policy":{"keepRecentMessages":20,"reservedOutputTokens":0,"contextSafetyMarginTokens":4096,"timeoutSeconds":60,"maxOutputTokens":0,"maxManifestBytes":65536,"maxInternalPasses":8,"advisory":{"considerPercent":70,"stronglyAdvisedPercent":90}}}"#
        )
    );
    let disabled = resolve(&[info(r#"{"advisory":false}"#).unwrap()]);
    assert_eq!(
        admission_digest(&disabled),
        sha256(
            r#"{"revision":4,"policy":{"keepRecentMessages":20,"reservedOutputTokens":0,"contextSafetyMarginTokens":4096,"timeoutSeconds":60,"maxOutputTokens":0,"maxManifestBytes":65536,"maxInternalPasses":8,"advisory":false}}"#
        )
    );
    assert_ne!(admission_digest(&defaults), admission_digest(&disabled));
}

#[test]
fn constraints_keep_whole_blocks_and_replace_the_overflow_with_one_digest_notice() {
    let parts = [Some("alpha"), None, Some("  "), Some("beta"), Some("gamma")];
    assert_eq!(
        compaction_constraints::assemble(&parts, 1_000),
        vec!["alpha", "beta", "gamma"]
    );
    assert!(compaction_constraints::assemble(&parts, 0).is_empty());
    let long = "x".repeat(300);
    let notice = |count: usize, bytes: usize, text: &str| {
        format!(
            "[Omitted {count} compaction constraint block(s), {bytes} UTF-8 bytes; sha256={}. Reload source rules after compaction if needed.]",
            sha256(text)
        )
    };
    let result = compaction_constraints::assemble(&[Some("keep"), Some(long.as_str())], 250);
    assert_eq!(result, vec!["keep".to_string(), notice(1, 300, &long)]);
    let both = notice(2, 304, &format!("{long}\0tail"));
    let displaced =
        compaction_constraints::assemble(&[Some(long.as_str()), Some("tail")], both.len() + 2);
    assert_eq!(displaced, vec![both.clone()]);
    assert!(compaction_constraints::assemble(&[Some(long.as_str())], both.len() - 10).is_empty());
}

#[test]
fn pressure_levels_follow_the_advisory_thresholds_and_the_hard_input_cap() {
    let capabilities = Capabilities {
        context_window_tokens: 1000,
        max_output_tokens: 100,
        context_safety_margin_tokens: 50,
    };
    let policy = resolve(&[]);
    assert_eq!(context_pressure::hard_input_cap_tokens(&capabilities), 950);
    for (estimate, expected) in [
        (699, Level::Normal),
        (700, Level::Consider),
        (899, Level::Consider),
        (900, Level::Advised),
        (949, Level::Advised),
        (950, Level::Mandatory),
    ] {
        assert_eq!(
            context_pressure::level(&capabilities, &policy, estimate),
            expected,
            "estimate {estimate}"
        );
    }
    let disabled = resolve(&[info(r#"{"advisory":false}"#).unwrap()]);
    assert_eq!(
        context_pressure::level(&capabilities, &disabled, 949),
        Level::Normal
    );
    assert_eq!(
        context_pressure::level(&capabilities, &disabled, 950),
        Level::Mandatory
    );
    let no_room = Capabilities {
        context_safety_margin_tokens: 1000,
        ..capabilities
    };
    assert_eq!(
        context_pressure::level(&no_room, &policy, 0),
        Level::Mandatory
    );
}

#[test]
fn estimates_round_characters_over_four_and_ignore_inline_media() {
    assert_eq!(context_pressure::estimate(""), 0);
    assert_eq!(context_pressure::estimate("ab"), 1);
    assert_eq!(context_pressure::estimate("abcde"), 1);
    assert_eq!(context_pressure::estimate("abcdef"), 2);
    let system = [llm::TextPart::from("x".repeat(400).as_str())];
    let plain = [llm::Message::user("hello")];
    let base = context_pressure::estimated_input_tokens(Usage {
        system: &system,
        tools: &[],
        messages: &plain,
    });
    assert!(base >= 100);
    let media = [llm::Message::new(
        llm::Role::User,
        vec![llm::Part::Media(llm::Media {
            mime: "image/png".into(),
            data: llm::MediaData::Encoded("A".repeat(50_000).as_str().into()),
            filename: None,
        })],
    )];
    let with_media = context_pressure::estimated_input_tokens(Usage {
        system: &system,
        tools: &[],
        messages: &media,
    });
    assert!(
        with_media < base + 40,
        "inline media must not inflate the estimate: {with_media}"
    );
    let breakdown = context_pressure::breakdown(Usage {
        system: &system,
        tools: &[],
        messages: &plain,
    });
    assert_eq!(breakdown.system, 100);
    assert!(breakdown.user > 0 && breakdown.assistant == 0 && breakdown.tools == 0);
}
