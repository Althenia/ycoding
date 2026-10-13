use ycoding_core::resources::project_artifact::accounting;

const DAY: f64 = 86_400_000.0;
fn decision(stage: &str) -> accounting::DecisionInput<'_> {
    accounting::DecisionInput {
        stage,
        created_at: 0.0,
        last_transition_at: 0.0,
        restored_at: None,
        state: accounting::GovernorState {
            first_qualified_at: None,
        },
        now: 30.0 * DAY,
        candidate: accounting::SampleCounts {
            sample_count: 30.0,
            success_count: 5.0,
        },
        baseline: Some(accounting::SampleCounts {
            sample_count: 40.0,
            success_count: 36.0,
        }),
        explicit_negative: false,
        global: false,
        global_samples: &[],
    }
}

#[test]
fn marks_multi_artifact_external_standard_interrupted_and_stopped_outcomes_confounded() {
    let base = accounting::Outcome {
        active_artifact_count: 1.0,
        standard_invocation_count: 0.0,
        external_confounded: false,
        terminal_outcome: "succeeded",
        goal_status: "completed",
    };
    assert!(accounting::eligible(&base));
    for outcome in [
        accounting::Outcome {
            active_artifact_count: 2.0,
            ..base
        },
        accounting::Outcome {
            external_confounded: true,
            ..base
        },
        accounting::Outcome {
            standard_invocation_count: 1.0,
            ..base
        },
        accounting::Outcome {
            terminal_outcome: "interrupted",
            ..base
        },
        accounting::Outcome {
            goal_status: "stopped",
            ..base
        },
    ] {
        assert!(!accounting::eligible(&outcome));
    }
}

#[test]
fn uses_bounded_observational_rewards_explicit_penalties_and_invalid_score_rules() {
    for (outcome, goal, repeat, expected) in [
        ("succeeded", "completed", false, 1.0),
        ("succeeded", "none", true, -0.25),
        ("failed", "none", true, -1.0),
        ("interrupted", "completed", false, 0.0),
        ("succeeded", "stopped", true, 0.0),
        ("succeeded", "exhausted", false, -1.0),
    ] {
        assert_eq!(accounting::reward(outcome, goal, repeat), expected);
    }
    assert_eq!(accounting::penalty("disable"), 4.0);
    assert_eq!(accounting::penalty("revert"), 5.0);
    assert_eq!(accounting::penalty("delete"), 6.0);
    for (rewards, penalties) in [
        (0.0, 0.0),
        (9_007_199_254_740_991.0, 9_007_199_254_740_991.0),
        (f64::INFINITY, 1.0),
        (-1.0, 1.0),
    ] {
        assert_eq!(accounting::score(rewards, penalties), 0.0);
    }
}

#[test]
fn calculates_wilson_zero_small_large_and_invalid_boundaries() {
    assert_eq!(
        accounting::wilson(0.0, 0.0),
        accounting::Interval {
            lower_bound: 0.0,
            upper_bound: 1.0
        }
    );
    assert!(accounting::wilson(1.0, 0.0).lower_bound.abs() < 1e-12);
    assert!((accounting::wilson(1.0, 1.0).upper_bound - 1.0).abs() < 1e-12);
    assert!(accounting::wilson(10_000.0, 10_000.0).lower_bound > 0.999);
    for (samples, successes) in [(-1.0, 0.0), (1.0, 2.0), (1.5, 1.0), (f64::NAN, 0.0)] {
        assert_eq!(
            accounting::wilson(samples, successes),
            accounting::Interval {
                lower_bound: 0.0,
                upper_bound: 1.0
            }
        );
    }
}

#[test]
fn requires_two_confidence_evaluations_and_a_powered_matched_baseline_for_degradation() {
    let base = decision("active");
    let first = accounting::decision(&base);
    assert_eq!(
        first,
        accounting::GovernorTransition {
            action: "none",
            state: accounting::GovernorState {
                first_qualified_at: Some(base.now)
            }
        }
    );
    assert_eq!(
        accounting::decision(&accounting::DecisionInput {
            state: accounting::GovernorState {
                first_qualified_at: Some(base.now - DAY)
            },
            ..base
        }),
        accounting::GovernorTransition {
            action: "degrade",
            state: accounting::GovernorState {
                first_qualified_at: None
            }
        }
    );
    assert_eq!(
        accounting::decision(&accounting::DecisionInput {
            baseline: None,
            state: accounting::GovernorState {
                first_qualified_at: Some(base.now - DAY)
            },
            ..base
        })
        .action,
        "none"
    );
}

#[test]
fn persists_governor_reset_and_exact_evaluation_restore_transition_cooldowns() {
    let base = accounting::DecisionInput {
        stage: "trial",
        now: 8.0 * DAY,
        candidate: accounting::SampleCounts {
            sample_count: 40.0,
            success_count: 40.0,
        },
        baseline: None,
        ..decision("trial")
    };
    let first = accounting::decision(&base);
    assert_eq!(first.state.first_qualified_at, Some(8.0 * DAY));
    assert_eq!(
        accounting::decision(&accounting::DecisionInput {
            now: 9.0 * DAY,
            candidate: accounting::SampleCounts {
                sample_count: 40.0,
                success_count: 0.0
            },
            state: first.state,
            ..base
        })
        .state
        .first_qualified_at,
        None
    );
    assert_eq!(
        accounting::decision(&accounting::DecisionInput {
            now: 11.0 * DAY - 1.0,
            state: accounting::GovernorState {
                first_qualified_at: Some(10.0 * DAY)
            },
            ..base
        })
        .action,
        "none"
    );
    assert_eq!(
        accounting::decision(&accounting::DecisionInput {
            now: 11.0 * DAY,
            state: accounting::GovernorState {
                first_qualified_at: Some(10.0 * DAY)
            },
            ..base
        })
        .action,
        "activate"
    );
    assert_eq!(
        accounting::decision(&accounting::DecisionInput {
            now: 15.0 * DAY,
            restored_at: Some(8.0 * DAY + 1.0),
            state: accounting::GovernorState {
                first_qualified_at: Some(14.0 * DAY)
            },
            ..base
        })
        .state
        .first_qualified_at,
        None
    );
    assert_eq!(
        accounting::decision(&accounting::DecisionInput {
            now: 15.0 * DAY,
            restored_at: Some(8.0 * DAY),
            state: accounting::GovernorState {
                first_qualified_at: Some(14.0 * DAY)
            },
            ..base
        })
        .action,
        "activate"
    );
    let degrade = accounting::DecisionInput {
        last_transition_at: 23.0 * DAY + 1.0,
        state: accounting::GovernorState {
            first_qualified_at: Some(29.0 * DAY),
        },
        ..decision("active")
    };
    assert_eq!(
        accounting::decision(&degrade).state.first_qualified_at,
        None
    );
    assert_eq!(
        accounting::decision(&accounting::DecisionInput {
            last_transition_at: 23.0 * DAY,
            ..degrade
        })
        .action,
        "degrade"
    );
}

#[test]
fn exact_global_sample_diversity_counts_and_hmac_buckets() {
    let samples = [
        ("s01", "a"),
        ("s02", "a"),
        ("s03", "a"),
        ("s04", "a"),
        ("s05", "a"),
        ("s06", "a"),
        ("s07", "a"),
        ("s08", "a"),
        ("s09", "a"),
        ("s10", "a"),
        ("s11", "b"),
        ("s12", "b"),
        ("s13", "b"),
        ("s14", "b"),
        ("s15", "b"),
        ("s16", "b"),
        ("s17", "b"),
        ("s18", "b"),
        ("s19", "b"),
        ("s20", "b"),
        ("s21", "c"),
        ("s22", "c"),
        ("s23", "c"),
        ("s24", "c"),
        ("s25", "c"),
        ("s26", "c"),
        ("s27", "c"),
        ("s28", "c"),
        ("s29", "c"),
        ("s30", "c"),
    ]
    .map(|(sample_id, bucket_id)| accounting::ProjectBucketSample {
        sample_id: sample_id.into(),
        bucket_id: bucket_id.into(),
    });
    assert!(accounting::global_confidence(30.0, &samples));
    assert!(!accounting::global_confidence(29.0, &samples[..29]));
    assert!(!accounting::global_confidence(30.0, &samples[..29]));
    let mut duplicate = samples.clone();
    duplicate[29] = samples[0].clone();
    assert!(!accounting::global_confidence(30.0, &duplicate));
    let mut dominant = samples.clone();
    for sample in &mut dominant[..16] {
        sample.bucket_id = "a".into();
    }
    assert!(!accounting::global_confidence(30.0, &dominant));
    let base = accounting::DecisionInput {
        global: true,
        global_samples: &samples,
        state: accounting::GovernorState {
            first_qualified_at: Some(29.0 * DAY),
        },
        ..decision("active")
    };
    assert_eq!(accounting::decision(&base).action, "degrade");
    assert_eq!(
        accounting::decision(&accounting::DecisionInput {
            global_samples: &duplicate,
            ..base
        })
        .action,
        "none"
    );
    assert_eq!(
        accounting::project_bucket("private-test-key", "project-a"),
        accounting::project_bucket("private-test-key", "project-a")
    );
    assert_ne!(
        accounting::project_bucket("private-test-key", "project-a"),
        accounting::project_bucket("private-test-key", "project-b")
    );
    assert!(!accounting::project_bucket("private-test-key", "project-a").contains("project-a"));
}

use ycoding_schema::{DomainDecode, JsonValue, parse_json, project_artifact};
use ycoding_store::{Metadata, Options, Store, artifacts, import};

fn database() -> Store {
    let store = Store::disposable(
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
        Metadata::new([47; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
                    id: "accounting-project".into(),
                    worktree: "/accounting-project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 0,
                    time_updated: 0,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            artifacts::ScopeTable::insert(
                tx,
                &artifacts::Scope {
                    id: "pas_project".into(),
                    type_: "project".into(),
                    storage_id: "11111111-1111-4111-8111-111111111111".into(),
                    time_created: 0,
                    time_updated: 0,
                },
            )?;
            artifacts::ProjectScopeTable::insert(
                tx,
                &artifacts::ProjectScope {
                    scope_id: "pas_project".into(),
                    project_id: "accounting-project".into(),
                },
            )?;
            artifacts::insert_artifact(
                tx,
                &artifacts::Artifact {
                    scope_id: "pas_project".into(),
                    kind: "skill".into(),
                    artifact_id: "review".into(),
                    revision: 1,
                    stage: "trial".into(),
                    current_version_id: "pav_project".into(),
                    fallback_version_id: None,
                    shadowed_scope_id: None,
                    last_used_at: None,
                    time_created: 0,
                    time_updated: 0,
                },
                &artifacts::Version {
                    id: "pav_project".into(),
                    scope_id: "pas_project".into(),
                    kind: "skill".into(),
                    artifact_id: "review".into(),
                    parent_version_id: None,
                    state: "trial".into(),
                    content_digest:
                        "0000000000000000000000000000000000000000000000000000000000000000".into(),
                    content_relpath: "SKILL.md".into(),
                    source: "agent".into(),
                    creator_agent_id: None,
                    creator_session_id: None,
                    insight_digest: None,
                    origin_scope_id: None,
                    origin_version_id: None,
                    origin_evidence_digest: None,
                    first_qualified_at: Some(1),
                    last_evaluated_at: None,
                    last_restored_at: None,
                    last_governor_transition_at: None,
                    time_created: 0,
                    time_state_changed: 0,
                },
            )?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}
fn activation() -> project_artifact::Activation {
    project_artifact::Activation::decode(&parse_json(r#"{"id":"paa_first","artifact":{"scopeID":"pas_project","kind":"skill","id":"review","versionID":"pav_project"},"projectID":"accounting-project","sessionID":"ses_first","source":"skill-tool","messageID":"message-first","callID":"call-first","boundarySeq":1,"activatedAt":1}"#).unwrap()).unwrap()
}
fn observation() -> accounting::ObserveInput {
    accounting::ObserveInput::decode(&parse_json(r#"{"projectID":"accounting-project","sessionID":"ses_first","terminalMessageID":"terminal-first","boundarySeq":2,"kind":"skill","modelID":"test/model","goalMode":false,"standardInvocationCount":0,"externalConfounded":false,"terminalOutcome":"succeeded","goalStatus":"completed","repeatFix":false,"observedAt":1000}"#).unwrap()).unwrap()
}

#[test]
fn real_redb_activation_retries_reject_identity_and_owner_conflicts() {
    let store = database();
    let service = accounting::Service::new(store.client(), "private-test-key".into());
    let first = activation();
    assert_eq!(service.activate(&first).unwrap(), first);
    assert_eq!(service.activate(&first).unwrap(), first);
    let mut conflicting = first.clone();
    conflicting.id =
        project_artifact::ActivationId::decode(&JsonValue::String("paa_conflict".into())).unwrap();
    assert!(service.activate(&conflicting).is_err());
    let mut absent = first.clone();
    absent.id =
        project_artifact::ActivationId::decode(&JsonValue::String("paa_absent".into())).unwrap();
    absent.session_id = None;
    absent.boundary_seq = project_artifact::Revision::decode(&JsonValue::Number(3.0)).unwrap();
    assert_eq!(service.activate(&absent).unwrap(), absent);
    assert_eq!(service.activate(&absent).unwrap(), absent);
    let mut wrong = first;
    wrong.id =
        project_artifact::ActivationId::decode(&JsonValue::String("paa_wrong".into())).unwrap();
    wrong.artifact.identity.id =
        project_artifact::Id::decode(&JsonValue::String("wrong".into())).unwrap();
    wrong.boundary_seq = project_artifact::Revision::decode(&JsonValue::Number(4.0)).unwrap();
    assert!(service.activate(&wrong).is_err());
}

#[test]
fn stores_exact_observations_metrics_feedback_and_transactional_resets() {
    let store = database();
    let service = accounting::Service::new(store.client(), "private-test-key".into());
    service.activate(&activation()).unwrap();
    let input = observation();
    let first = service.observe(&input).unwrap();
    assert_eq!(first.len(), 1);
    assert!(first[0].eligible);
    assert_eq!(first[0].active_artifact_count.get(), 1);
    assert_eq!(service.observe(&input).unwrap(), first);
    let mut conflict = input.clone();
    conflict.repeat_fix = true;
    assert!(service.observe(&conflict).is_err());
    let feedback=project_artifact::Feedback::decode(&parse_json(r#"{"artifact":{"scopeID":"pas_project","kind":"skill","id":"review","versionID":"pav_project"},"action":"disable","actor":"user","timeCreated":2}"#).unwrap()).unwrap();
    let cloned = service.clone();
    let value = feedback.clone();
    assert!(
        store
            .submit(move |tx| {
                cloned.feedback_in_transaction(tx, &value)?;
                Err::<(), _>(ycoding_store::Error::Rejected("rollback"))
            })
            .unwrap()
            .wait()
            .is_err()
    );
    assert_eq!(
        service
            .metrics(&feedback.artifact.version_id)
            .unwrap()
            .penalty_units,
        0.0
    );
    let id = service.feedback(&feedback).unwrap();
    assert_eq!(service.feedback(&feedback).unwrap(), id);
    let metrics = service.metrics(&feedback.artifact.version_id).unwrap();
    assert_eq!(metrics.confidence.sample_count.get(), 1);
    assert_eq!(metrics.confidence.success_count.get(), 1);
    assert_eq!(metrics.reward_units, 1.0);
    assert_eq!(metrics.penalty_units, 4.0);
    assert_eq!(metrics.score, -0.6);
    assert_eq!(
        service
            .deactivate_project(&input.session_id, &input.project_id, 3, 1001)
            .unwrap(),
        1
    );
    assert_eq!(
        service
            .deactivate_project(&input.session_id, &input.project_id, 3, 1001)
            .unwrap(),
        0
    );
}

#[test]
fn real_cohort_and_decision_persist_only_nonactionable_state_outside_owner_transaction() {
    let store = database();
    let service = accounting::Service::new(store.client(), "private-test-key".into());
    store
        .submit(|tx| {
            let mut version = tx
                .get::<artifacts::VersionTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&"pav_project".into()),
                ]))?
                .unwrap();
            version.first_qualified_at = None;
            artifacts::VersionTable::put(tx, &version)
        })
        .unwrap()
        .wait()
        .unwrap();
    for suffix in [
        "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15",
        "16", "17", "18", "19", "20",
    ] {
        let mut activation = activation();
        activation.id = project_artifact::ActivationId::decode(&JsonValue::String(
            format!("paa_case-{suffix}").as_str().into(),
        ))
        .unwrap();
        activation.session_id = Some(
            ycoding_schema::session::Id::decode(&JsonValue::String(
                format!("ses_case_{suffix}").as_str().into(),
            ))
            .unwrap(),
        );
        service.activate(&activation).unwrap();
        let mut input = observation();
        input.session_id = activation.session_id.unwrap();
        input.terminal_message_id = Some(
            project_artifact::NonEmptyText::decode(&JsonValue::String(
                format!("terminal-{suffix}").as_str().into(),
            ))
            .unwrap(),
        );
        service.observe(&input).unwrap();
    }
    let input = accounting::CohortInput {
        scope: accounting::CohortScope::Project(
            ycoding_schema::project::Id::decode(&JsonValue::String("accounting-project".into()))
                .unwrap(),
        ),
        version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_project".into()))
            .unwrap(),
        kind: project_artifact::Kind::decode(&JsonValue::String("skill".into())).unwrap(),
        agent_id: None,
        model_id: "test/model".into(),
        goal_mode: false,
        now: 8 * 86_400_000,
    };
    let cohort = service.cohort(&input).unwrap();
    assert_eq!(
        cohort.candidate,
        accounting::SampleCounts {
            sample_count: 20.0,
            success_count: 20.0
        }
    );
    assert_eq!(cohort.baseline.sample_count, 0.0);
    let first = service.decide(&input, false).unwrap();
    assert_eq!(first.transition.action, "none");
    assert_eq!(first.transition.state.first_qualified_at, Some(8.0 * DAY));
    let next = accounting::CohortInput {
        now: 9 * 86_400_000,
        ..input.clone()
    };
    assert!(service.decide(&next, false).is_err());
    let cloned = service.clone();
    let transition = store
        .submit(move |tx| cloned.decide_in_transaction(tx, &next, false))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(transition.transition.action, "activate");
    let wrong = accounting::CohortInput {
        scope: accounting::CohortScope::Global,
        ..input
    };
    assert!(service.cohort(&wrong).is_err());
}
