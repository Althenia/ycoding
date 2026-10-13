use ycoding_core::session::summary_toon::{
    Confidence, Decision, DecisionStatus, Fact, Memory, ParseError, ParseOptions, encode, parse,
    retain_required_texts,
};

const OPTIONS: ParseOptions = ParseOptions {
    through_sequence: 42,
};

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn sample() -> Memory {
    Memory {
        through_sequence: 42,
        objective: "Fix the \"quote\" bug: done, mostly".into(),
        in_progress: strings(&["Regression reproduced"]),
        pending: strings(&["review", "Don't stop now"]),
        blocked: vec![],
        decision: vec![
            Decision {
                text: "Keep snake_case".into(),
                status: DecisionStatus::Accepted,
            },
            Decision {
                text: "Drop legacy".into(),
                status: DecisionStatus::Superseded,
            },
        ],
        skill: strings(&["typescript-developer"]),
        requirements: strings(&["Preserve exact protected state"]),
        acceptance_criteria: strings(&["Focused tests pass"]),
        current_state: "In progress\nwith a second line".into(),
        facts: vec![
            Fact {
                text: "Uses TOON, with \"quotes\" and \\backslash".into(),
                confidence: Confidence::Confirmed,
            },
            Fact {
                text: "日本語 émojis ✓ and 中文".into(),
                confidence: Confidence::Uncertain,
            },
            Fact {
                text: "Third".into(),
                confidence: Confidence::Likely,
            },
        ],
        preferences: strings(&["drafts: on", "wip"]),
        constraints: strings(&["no new deps"]),
        completed: strings(&["module", "tests"]),
        unresolved: strings(&["cache eviction"]),
        important_identifiers: strings(&["sum-1"]),
        continuation: "Next: write docs. Then ship.".into(),
    }
}

fn without(encoded: &str, needle: &str) -> String {
    encoded
        .split('\n')
        .filter(|line| !line.contains(needle))
        .collect::<Vec<_>>()
        .join("\n")
}

fn empty_document(preferences: &str) -> String {
    [
        "conversation_memory:",
        "  version: 2",
        "  through_sequence: 42",
        "  objective: \"o\"",
        "  in_progress: []",
        "  pending: []",
        "  blocked: []",
        "  decision: []",
        "  skill: []",
        "  requirements: []",
        "  acceptance_criteria: []",
        "  current_state: \"s\"",
        "  facts: []",
        preferences,
        "  constraints: []",
        "  completed: []",
        "  unresolved: []",
        "  important_identifiers: []",
        "  continuation: \"c\"",
    ]
    .join("\n")
}

#[test]
fn encodes_the_exact_canonical_toon_version_two_document() {
    let encoded = encode(&sample());
    assert_eq!(
        encoded,
        [
            "conversation_memory:",
            "  version: 2",
            "  through_sequence: 42",
            "  objective: \"Fix the \\\"quote\\\" bug: done, mostly\"",
            "  in_progress[1]: Regression reproduced",
            "  pending[2]: review,Don't stop now",
            "  blocked: []",
            "  decision[2]{text,status}:",
            "    Keep snake_case,accepted",
            "    Drop legacy,superseded",
            "  skill[1]: typescript-developer",
            "  requirements[1]: Preserve exact protected state",
            "  acceptance_criteria[1]: Focused tests pass",
            "  current_state: \"In progress\\nwith a second line\"",
            "  facts[3]{text,confidence}:",
            "    \"Uses TOON, with \\\"quotes\\\" and \\\\backslash\",confirmed",
            "    日本語 émojis ✓ and 中文,uncertain",
            "    Third,likely",
            "  preferences[2]: \"drafts: on\",wip",
            "  constraints[1]: no new deps",
            "  completed[2]: module,tests",
            "  unresolved[1]: cache eviction",
            "  important_identifiers[1]: sum-1",
            "  continuation: \"Next: write docs. Then ship.\"",
        ]
        .join("\n")
    );
}

#[test]
fn round_trips_a_full_memory_through_encode_and_parse() {
    assert_eq!(parse(&encode(&sample()), &OPTIONS), Ok(sample()));
}

#[test]
fn quotes_values_that_would_read_back_as_other_types() {
    let mut memory = sample();
    memory.pending = strings(&[
        "true", "null", "42", "-3.5e2", "-dash", "#hash", " padded", "",
    ]);
    memory.current_state = "Inspect this source:\n```ts\nconst value = 1\n```".into();
    let encoded = encode(&memory);
    assert!(encoded.contains(
        "pending[8]: \"true\",\"null\",\"42\",\"-3.5e2\",\"-dash\",\"#hash\",\" padded\",\"\""
    ));
    assert_eq!(parse(&encoded, &OPTIONS), Ok(memory));
}

#[test]
fn requires_the_advisor_checkpoint_sections() {
    let input = without(&encode(&sample()), "acceptance_criteria");
    let Err(ParseError::MissingField(fields)) = parse(&input, &OPTIONS) else {
        panic!("expected a missing field")
    };
    assert!(fields.contains(&"acceptance_criteria".to_string()));
    let input = without(&encode(&sample()), "objective");
    let Err(ParseError::MissingField(fields)) = parse(&input, &OPTIONS) else {
        panic!("expected a missing field")
    };
    assert!(fields.contains(&"objective".to_string()));
}

#[test]
fn rejects_invalid_toon_wrong_roots_versions_and_boundaries() {
    assert!(matches!(
        parse(
            "conversation_memory:\n  objective: \"unterminated",
            &OPTIONS
        ),
        Err(ParseError::InvalidToon(_))
    ));
    assert!(matches!(
        parse("memory:\n  version: 2", &OPTIONS),
        Err(ParseError::WrongRoot(_))
    ));
    assert_eq!(
        parse(
            &encode(&sample()).replace("version: 2", "version: 3"),
            &OPTIONS
        ),
        Err(ParseError::UnsupportedVersion("3".into()))
    );
    assert_eq!(
        parse(
            &encode(&sample()),
            &ParseOptions {
                through_sequence: 43
            }
        ),
        Err(ParseError::SequenceMismatch {
            expected: "43".into(),
            actual: "42".into()
        })
    );
}

#[test]
fn rejects_collection_fields_with_wrong_element_types() {
    assert!(matches!(
        parse(&empty_document("  preferences[2]: 1,2"), &OPTIONS),
        Err(ParseError::InvalidElement(_))
    ));
    assert!(matches!(
        parse(&empty_document("  preferences[3]: a,b"), &OPTIONS),
        Err(ParseError::InvalidToon(_))
    ));
}

#[test]
fn rejects_a_document_with_no_meaningful_content() {
    let input = [
        "conversation_memory:",
        "  version: 2",
        "  through_sequence: 42",
        "  objective: \"\"",
        "  in_progress: []",
        "  pending: []",
        "  blocked: []",
        "  decision: []",
        "  skill: []",
        "  requirements: []",
        "  acceptance_criteria: []",
        "  current_state: \"\"",
        "  facts: []",
        "  preferences: []",
        "  constraints: []",
        "  completed: []",
        "  unresolved: []",
        "  important_identifiers: []",
        "  continuation: \"\"",
    ]
    .join("\n");
    assert_eq!(parse(&input, &OPTIONS), Err(ParseError::EmptySummary));
}

#[test]
fn rejects_fences_and_prose_but_accepts_comments() {
    let encoded = encode(&sample());
    assert_eq!(
        parse(&format!("```\n{encoded}\n```"), &OPTIONS),
        Err(ParseError::CodeFence)
    );
    assert_eq!(
        parse(
            &format!("Here is the conversation memory:\n{encoded}"),
            &OPTIONS
        ),
        Err(ParseError::Prose(1))
    );
    assert_eq!(
        parse(&format!("{encoded}\nThat's all folks"), &OPTIONS),
        Err(ParseError::Prose(encoded.split('\n').count() + 1))
    );
    assert_eq!(
        parse(&format!("# durable checkpoint\n{encoded}"), &OPTIONS),
        Ok(sample())
    );
}

#[test]
fn decodes_list_form_arrays_and_quoted_keys_a_model_may_emit() {
    let input = [
        "conversation_memory:",
        "  version: 2",
        "  through_sequence: 42",
        "  objective: o",
        "  in_progress[2]:",
        "    - one",
        "    - \"two, with comma\"",
        "  pending: []",
        "  blocked: []",
        "  decision[1]:",
        "    - text: Keep it",
        "      status: accepted",
        "  skill: []",
        "  requirements: []",
        "  acceptance_criteria: []",
        "  current_state: s",
        "  facts: []",
        "  preferences: []",
        "  constraints: []",
        "  completed: []",
        "  unresolved: []",
        "  important_identifiers: []",
        "  continuation: c",
    ]
    .join("\n");
    let memory = parse(&input, &OPTIONS).unwrap();
    assert_eq!(memory.in_progress, strings(&["one", "two, with comma"]));
    assert_eq!(
        memory.decision,
        vec![Decision {
            text: "Keep it".into(),
            status: DecisionStatus::Accepted
        }]
    );
}

fn empty() -> Memory {
    Memory {
        through_sequence: 1,
        objective: "objective".into(),
        in_progress: vec![],
        pending: vec![],
        blocked: vec![],
        decision: vec![],
        skill: vec![],
        requirements: vec![],
        acceptance_criteria: vec![],
        current_state: "state".into(),
        facts: vec![],
        preferences: vec![],
        constraints: vec![],
        completed: vec![],
        unresolved: vec![],
        important_identifiers: vec![],
        continuation: "continue".into(),
    }
}

const AUTHORITY: &str = "Authoritative current Session state (JSON):";

fn authority(yolo: u8, status: &str) -> String {
    format!(
        "{AUTHORITY}\n{{\"todos\":[{{\"content\":\"ship it\",\"status\":\"{status}\",\"priority\":\"high\"}}],\"autonomy\":{{\"mode\":\"normal\",\"yolo\":{yolo}}}}}"
    )
}

fn supersedes(existing: &str, incoming: &str) -> bool {
    existing.starts_with(AUTHORITY) && incoming.starts_with(AUTHORITY)
}

fn authoritative(memory: &Memory) -> Vec<String> {
    let mut texts = vec![memory.objective.clone()];
    texts.extend(memory.requirements.clone());
    texts.extend(memory.acceptance_criteria.clone());
    texts.extend(memory.in_progress.clone());
    texts.push(memory.current_state.clone());
    texts.push(memory.continuation.clone());
    texts.extend(memory.facts.iter().map(|fact| fact.text.clone()));
    texts.extend(memory.decision.iter().map(|decision| decision.text.clone()));
    texts.extend(memory.preferences.clone());
    texts.extend(memory.constraints.clone());
    texts.extend(memory.completed.clone());
    texts.extend(memory.pending.clone());
    texts.extend(memory.blocked.clone());
    texts.extend(memory.skill.clone());
    texts.extend(memory.unresolved.clone());
    texts.extend(memory.important_identifiers.clone());
    texts
        .into_iter()
        .filter(|text| text.starts_with("Authoritative current Session state"))
        .collect()
}

#[test]
fn a_refreshed_authoritative_value_supersedes_the_stale_one_in_whichever_field_held_it() {
    let stale = authority(0, "pending");
    let fresh = authority(1, "completed");
    let seeded = retain_required_texts(empty(), std::slice::from_ref(&stale), Some(&supersedes));
    assert_eq!(authoritative(&seeded), vec![stale.clone()]);
    let refreshed = retain_required_texts(seeded, std::slice::from_ref(&fresh), Some(&supersedes));
    assert_eq!(authoritative(&refreshed), vec![fresh.clone()]);

    let mut seeded = empty();
    seeded.in_progress = vec![fresh.clone()];
    seeded.pending = vec![stale.clone()];
    let refreshed = retain_required_texts(seeded, std::slice::from_ref(&fresh), Some(&supersedes));
    assert_eq!(authoritative(&refreshed), vec![fresh]);
}

#[test]
fn only_the_authoritative_prefix_is_superseded_and_ordinary_facts_stay() {
    let stale = authority(0, "pending");
    let fresh = authority(1, "completed");
    let mut seeded = empty();
    seeded.facts = vec![
        Fact {
            text: format!("user note: {AUTHORITY} appeared in logs"),
            confidence: Confidence::Confirmed,
        },
        Fact {
            text: "ordinary user fact".into(),
            confidence: Confidence::Confirmed,
        },
        Fact {
            text: stale,
            confidence: Confidence::Confirmed,
        },
    ];
    let refreshed = retain_required_texts(seeded, std::slice::from_ref(&fresh), Some(&supersedes));
    assert_eq!(
        refreshed
            .facts
            .iter()
            .map(|fact| fact.text.as_str())
            .take(2)
            .collect::<Vec<_>>(),
        vec![
            format!("user note: {AUTHORITY} appeared in logs").as_str(),
            "ordinary user fact"
        ]
    );
    assert_eq!(authoritative(&refreshed), vec![fresh]);
}

#[test]
fn authority_is_superseded_in_every_scalar_while_ordinary_scalar_text_stays() {
    let stale = authority(0, "pending");
    let fresh = authority(1, "completed");
    for scalar in ["objective", "current_state", "continuation"] {
        let mut seeded = empty();
        match scalar {
            "objective" => seeded.objective = stale.clone(),
            "current_state" => seeded.current_state = stale.clone(),
            _ => seeded.continuation = stale.clone(),
        }
        let refreshed =
            retain_required_texts(seeded, std::slice::from_ref(&fresh), Some(&supersedes));
        assert_eq!(authoritative(&refreshed), vec![fresh.clone()]);
        assert_eq!(
            refreshed.objective,
            if scalar == "objective" {
                ""
            } else {
                "objective"
            }
        );
        assert_eq!(
            refreshed.current_state,
            if scalar == "current_state" {
                ""
            } else {
                "state"
            }
        );
        assert_eq!(
            refreshed.continuation,
            if scalar == "continuation" {
                ""
            } else {
                "continue"
            }
        );
    }
}

#[test]
fn every_incoming_text_is_retained_when_no_supersede_predicate_is_supplied() {
    let mut seeded = empty();
    seeded.facts = vec![Fact {
        text: "older fact".into(),
        confidence: Confidence::Confirmed,
    }];
    let refreshed = retain_required_texts(seeded, &["newer fact".into()], None);
    assert_eq!(
        refreshed
            .facts
            .iter()
            .map(|fact| fact.text.as_str())
            .collect::<Vec<_>>(),
        vec!["older fact", "newer fact"]
    );
}
