use ycoding_core::session::context_manifest::{
    Candidate, ContextItem, ContextItemKind, CoveredThrough, Exclusion, IssueCode, Manifest,
    MessageSelector, ModelTokens, PackCandidate, PackInput, ProviderLinkEvidence, RemoteInput,
    RetainedItem, RollingSummary, RuntimeEvidence, TargetSelector, ValidationInput,
    decode_candidate, manifest_digest, manifest_json, pack_candidates, payload_digest, remote,
    selector, target_key, validate,
};
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, parse_json, schema::NonNegativeInt};

fn message_id(id: &str) -> ycoding_schema::session_message::Id {
    ycoding_schema::session_message::Id::new(id).unwrap()
}

fn covered(message: &str, seq: i64) -> CoveredThrough {
    CoveredThrough {
        message_id: message_id(message),
        seq: NonNegativeInt::new(seq).unwrap(),
    }
}

fn message_item(
    message: &str,
    position: i64,
    seq: i64,
    payload: &JsonValue,
    tokens: i64,
) -> ContextItem {
    ContextItem {
        message_id: message_id(message),
        position,
        terminal_seq: seq,
        input_kind: "user".into(),
        payload: payload.clone(),
        tokens,
        dependency_group: None,
        tool_call: None,
        kind: ContextItemKind::Message,
        ordinal: 0,
        part_kind: String::new(),
        execution_group: String::new(),
        intermediate_kind: None,
    }
}

fn message_selector(message: &str, digest: &str) -> TargetSelector {
    TargetSelector::Message(MessageSelector {
        message_id: message_id(message),
        digest: digest.into(),
    })
}

#[test]
fn canonical_digests_match_typescript() {
    let value = parse_json(r#"{"b":1,"a":[3,2],"c":{"y":"x","a":null}}"#).unwrap();
    assert_eq!(
        ycoding_core::session::prompt_cache::canonical_json(&value),
        r#"{"a":[3,2],"b":1,"c":{"a":null,"y":"x"}}"#
    );
    assert_eq!(
        payload_digest(&parse_json(r#"{"a":1}"#).unwrap()),
        "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"
    );
}

#[test]
fn selectors_hash_payloads_and_target_keys_hash_selectors() {
    let item = message_item(
        "msg_a",
        0,
        5,
        &parse_json(r#"{"type":"user","text":"hi"}"#).unwrap(),
        3,
    );
    let selected = selector(&item);
    assert_eq!(
        selected,
        message_selector(
            "msg_a",
            "76b9fb4a2966f27468a059fd6fd3b4b1213099abdbd50594ab1c785e48b1f83f"
        )
    );
    assert_eq!(
        target_key(&selected.encode()),
        "dc3698894cd7def3090c5641f4bba8524665d8c24671757cb3caa28b9c915014"
    );
}

fn duplicate_evidence() -> (JsonValue, RuntimeEvidence, Candidate) {
    let dup = parse_json(r#"{"type":"user","text":"same"}"#).unwrap();
    let digest: ycoding_schema::LosslessString =
        "ab29f5d08652f52dffb8b6fd1ac17ea2f3d2f38bca17bdc7235abcbb0cf56ea6".into();
    let _ = digest;
    let evidence = RuntimeEvidence {
        base_context_revision: 0,
        covered_through: covered("msg_b", 7),
        items: vec![
            message_item("msg_a", 0, 5, &dup, 10),
            message_item("msg_b", 1, 7, &dup, 10),
        ],
        settlements: Vec::new(),
        authorities: Vec::new(),
        resource_authorities: Vec::new(),
        tool_results: Vec::new(),
        recent_tail: Vec::new(),
        protected_targets: Vec::new(),
        provider_links: vec![ProviderLinkEvidence {
            message_id: message_id("msg_a"),
            ordinal: 0,
            part_kind: "text".into(),
            digest: payload_digest(&dup).into(),
            terminal_seq: 5,
        }],
        protected_state: Vec::new(),
    };
    let candidate = Candidate {
        base_context_revision: NonNegativeInt::new(0).unwrap(),
        covered_through: covered("msg_b", 7),
        protected_state: Vec::new(),
        exclusions: vec![Exclusion::ExactDuplicate {
            target: message_selector("msg_a", &payload_digest(&dup)),
            evidence: message_selector("msg_b", &payload_digest(&dup)),
        }],
    };
    (dup, evidence, candidate)
}

#[test]
fn validation_builds_manifest_with_ordered_exclusions() {
    let (_, evidence, candidate) = duplicate_evidence();
    let manifest = validate(&ValidationInput {
        candidate,
        evidence,
        summary: None,
        model_tokens: Some(ModelTokens {
            before: 25,
            after: 12,
        }),
    })
    .expect("candidate is valid");
    assert_eq!(manifest.input_tokens, 25);
    assert_eq!(manifest.retained_tokens, 12);
    assert_eq!(manifest.exclusions.len(), 2);
    assert_eq!(
        manifest.exclusions[0].target_key(),
        "eca4c4dcb34bb05f08b54aee5bb87db54d45ff79fdc333a4241ab885ba0ad59c"
    );
    assert_eq!(
        manifest.exclusions[1].target_key(),
        "5c05650268e618a646f114ca5bb0c01b0c26993e72d8b45c56e3903b6e4396f4"
    );
    assert_eq!(manifest.exclusions[0].reason(), "exact_duplicate");
    assert_eq!(manifest.exclusions[1].reason(), "provider_rebase");
    assert_eq!(
        manifest_digest(&manifest),
        "a7d267e9f2e8e1106d785bfc0aed4b0754a14e325f7376dfd92bd31c02758963"
    );
    let roundtrip = Manifest::decode(&parse_json(&manifest_json(&manifest)).unwrap()).unwrap();
    assert_eq!(roundtrip.covered_through, manifest.covered_through);
    assert_eq!(roundtrip.exclusions.len(), 2);
    assert_eq!(roundtrip.input_tokens, 25);
}

#[test]
fn validation_requires_a_strict_token_reduction() {
    let (_, evidence, mut candidate) = duplicate_evidence();
    candidate.exclusions.clear();
    let issues = validate(&ValidationInput {
        candidate,
        evidence,
        summary: None,
        model_tokens: Some(ModelTokens {
            before: 20,
            after: 20,
        }),
    })
    .expect_err("equal tokens are not a reduction");
    assert!(
        issues
            .iter()
            .any(|issue| issue.code == IssueCode::NoTokenReduction)
    );
}

#[test]
fn validation_rejects_mismatched_duplicate_payloads() {
    let (dup, mut evidence, mut candidate) = duplicate_evidence();
    evidence.items[1].payload = parse_json(r#"{"type":"user","text":"other"}"#).unwrap();
    let _ = dup;
    candidate.exclusions = vec![Exclusion::ExactDuplicate {
        target: message_selector("msg_a", &payload_digest(&evidence.items[0].payload)),
        evidence: message_selector("msg_b", &payload_digest(&evidence.items[1].payload)),
    }];
    let issues = validate(&ValidationInput {
        candidate,
        evidence,
        summary: None,
        model_tokens: None,
    })
    .expect_err("payloads differ");
    assert!(
        issues
            .iter()
            .any(|issue| issue.code == IssueCode::InvalidExactDuplicate)
    );
}

#[test]
fn candidates_decode_strictly_and_summaries_cover_history() {
    let candidate = decode_candidate(
        r#"{"schemaVersion":1,"baseContextRevision":2,"coveredThrough":{"messageID":"msg_m","seq":3},"protectedState":[{"source":"todos","revision":1,"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],"exclusions":[]}"#,
    )
    .unwrap();
    assert_eq!(candidate.base_context_revision.get(), 2);
    assert!(decode_candidate(
        r#"{"schemaVersion":1,"baseContextRevision":2,"coveredThrough":{"messageID":"msg_m","seq":3},"protectedState":[],"exclusions":[],"extra":1}"#,
    )
    .is_err());
    assert!(decode_candidate(
        r#"{"schemaVersion":2,"baseContextRevision":2,"coveredThrough":{"messageID":"msg_m","seq":3},"protectedState":[],"exclusions":[]}"#,
    )
    .is_err());
    let (_, evidence, mut candidate) = duplicate_evidence();
    candidate.exclusions.clear();
    let summary = RollingSummary {
        text: "summary text".into(),
        covered_through: covered("msg_a", 5),
        digest: payload_digest(&evidence.items[0].payload).into(),
    };
    let manifest = validate(&ValidationInput {
        candidate,
        evidence,
        summary: Some(summary),
        model_tokens: Some(ModelTokens {
            before: 30,
            after: 12,
        }),
    })
    .expect("summary covers msg_a");
    assert!(manifest.summary.is_some());
    assert_eq!(manifest.exclusions.len(), 1);
    assert_eq!(manifest.exclusions[0].reason(), "provider_rebase");
}

#[test]
fn pack_candidates_groups_dependencies_and_fills_budgets() {
    let batches = pack_candidates(&PackInput {
        candidates: vec![
            PackCandidate {
                dependency_group: "g1".into(),
                order: 0,
                tokens: 5,
                content: parse_json(r#"{"a":1}"#).unwrap(),
            },
            PackCandidate {
                dependency_group: "g1".into(),
                order: 1,
                tokens: 6,
                content: parse_json(r#"{"b":2}"#).unwrap(),
            },
            PackCandidate {
                dependency_group: "g2".into(),
                order: 2,
                tokens: 3,
                content: parse_json(r#"{"c":3}"#).unwrap(),
            },
        ],
        max_input_tokens: 20,
        fixed_input_tokens: 2,
    })
    .unwrap();
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].input_tokens, 16);
    assert_eq!(batches[0].candidates.len(), 3);
    assert!(
        pack_candidates(&PackInput {
            candidates: Vec::new(),
            max_input_tokens: 0,
            fixed_input_tokens: 0,
        })
        .is_err()
    );
}

#[test]
fn remote_manifests_wrap_codex_items() {
    let manifest = remote(RemoteInput {
        base_context_revision: NonNegativeInt::new(0).unwrap(),
        covered_through: covered("msg_b", 7),
        protected_state: Vec::new(),
        retained: vec![RetainedItem {
            message_id: message_id("msg_b"),
            seq: NonNegativeInt::new(7).unwrap(),
            digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
        }],
        provider: "openai".into(),
        model_id: "gpt-1".into(),
        variant: None,
        input_tokens: 20,
        retained_tokens: 9,
        item: parse_json(r#"{"type":"compaction","id":"res_1","encrypted_content":"zz"}"#).unwrap(),
    })
    .unwrap();
    let stored = manifest.remote.as_ref().expect("remote is stored");
    assert_eq!(stored.item_id.as_str(), Some("res_1"));
    assert_eq!(
        stored.digest.as_str(),
        Some("a0405047d0dba9f4f24abc9ab63f02b2b06e8cefad93d598b8cc98c804eb6635")
    );
    assert!(manifest_json(&manifest).contains("\"remote\""));
    assert!(
        remote(RemoteInput {
            base_context_revision: NonNegativeInt::new(0).unwrap(),
            covered_through: covered("msg_b", 7),
            protected_state: Vec::new(),
            retained: Vec::new(),
            provider: "openai".into(),
            model_id: "gpt-1".into(),
            variant: None,
            input_tokens: 20,
            retained_tokens: 9,
            item: parse_json(r#"{"type":"other","id":"res_1","encrypted_content":"zz"}"#).unwrap(),
        })
        .is_err()
    );
}
