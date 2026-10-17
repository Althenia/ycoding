use std::ops::Bound;
use std::sync::Arc;
use ycoding_core::{
    instructions::{self, Observation},
    model_incident::{
        Error, ModelKey, RecentInput, ReportInput, Service, guidance,
        record::{self, FallbackInput, GuardrailInput},
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, guardrail, model, model_incident, parse_json,
    provider, session, session_message_id,
};
use ycoding_store::{
    Metadata, Options, Store,
    import::{self, DatabaseKind},
    model_incident::{Incident, IncidentTable},
    project,
    session::{self as tables, Document},
};

const DAY: i64 = 86_400_000;
const NOW: i64 = 400 * DAY;
const WINDOW: i64 = 30 * DAY;

const HEADER: &str =
    "<model-guidance>\nPast guardrail reviews stopped some of this model's actions:";
const FOOTER: &str = "</model-guidance>";
const OUTSIDE: &str = "- Outside-repository changes (standard.review.outside-repo): Respect approved paths and required approval checks for outside-repository mutations.";
const GIT: &str = "- Destructive Git (standard.review.git-destructive): Prefer reversible Git commands and retain required approval checks.";
const FORCE: &str = "- Force push (standard.review.force-push): Do not force-push unless the task requires it; retain required approval checks.";
const HOME: &str = "- Home-directory deletion (standard.review.home-child): Confirm the target and pass required approval checks before deleting a direct child of the home directory.";
const DATABASE: &str = "- Destructive database statements (standard.review.database-destructive): Use scoped statements and pass required approval checks before destructive database changes.";
const CUSTOM: &str = "- Custom guardrail rules (custom): Review configured guardrail rules before repeating a blocked action.";
const CHANGED: &str = "Model guidance changed. It replaces the earlier <model-guidance> notes.\n";
const RETRACTION: &str = "Earlier <model-guidance> notes no longer apply.";

fn s(value: &str) -> LosslessString {
    value.into()
}

fn json(text: &str) -> JsonValue {
    parse_json(text).unwrap()
}

fn text(lines: &[&str]) -> String {
    [&[HEADER][..], lines, &[FOOTER]].concat().join("\n")
}

fn store() -> Store {
    let store = Store::disposable(
        Options::core(),
        import::catalog(DatabaseKind::Core),
        Metadata::new([4; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: s("prj_one"),
                    worktree: s("/project"),
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
            for id in ["ses_one", "ses_two"] {
                tables::SessionTable::insert(tx, &session_row(id))?;
            }
            for (id, session_id, type_, seq, data) in [
                (
                    "msg_assistant",
                    "ses_one",
                    "assistant",
                    1,
                    r#"{"agent":"plan","model":{"providerID":"anthropic","id":"claude","variant":"max","profile":"work"}}"#,
                ),
                ("msg_user", "ses_one", "user", 2, r#"{"agent":"plan","model":{"providerID":"anthropic","id":"claude"}}"#),
                ("msg_bare", "ses_one", "assistant", 3, r#"{"agent":"plan"}"#),
                (
                    "msg_other",
                    "ses_two",
                    "assistant",
                    1,
                    r#"{"agent":"build","model":{"providerID":"openai","id":"gpt"}}"#,
                ),
            ] {
                tables::MessageTable::insert(
                    tx,
                    &tables::Message {
                        id: s(id),
                        session_id: s(session_id),
                        type_: s(type_),
                        seq,
                        time_created: 1,
                        time_updated: 1,
                        data: json(data),
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

fn session_row(id: &str) -> tables::Session {
    tables::Session {
        id: s(id),
        project_id: s("prj_one"),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: s("/project"),
        path: None,
        title: s(id),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
    }
}

fn incidents(store: &Store) -> Vec<Incident> {
    store
        .snapshot()
        .unwrap()
        .scan::<IncidentTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
        .unwrap()
}

fn id(value: &str) -> model_incident::Id {
    model_incident::Id(s(value))
}

fn reference(provider: &str, id: &str, variant: Option<&str>) -> model::Ref {
    model::Ref {
        id: s(id),
        provider_id: provider::Id(s(provider)),
        variant: variant.map(s),
        profile: None,
    }
}

fn request_id(value: &str) -> guardrail::RequestId {
    guardrail::RequestId::decode(&JsonValue::String(s(value))).unwrap()
}

fn guardrail_input(
    session_id: &str,
    message: Option<&str>,
    rules: &[&str],
    hard: bool,
) -> GuardrailInput {
    GuardrailInput {
        session_id: session::Id::new(session_id).unwrap(),
        request_id: request_id("grq_one"),
        message_id: message.map(|value| session_message_id::Id::new(value).unwrap()),
        rule_ids: rules.iter().copied().map(s).collect(),
        hard_review: hard,
        time: 50,
    }
}

fn submit<F>(store: &Store, operation: F) -> bool
where
    F: FnOnce(&mut ycoding_store::Write<'_>) -> Result<bool, ycoding_store::Error> + Send + 'static,
{
    store.submit(operation).unwrap().wait().unwrap()
}

fn row(id: &str, kind: &str, time: i64, request: &str, rules: &[&str]) -> Incident {
    let guardrail = kind != "fallback";
    Incident {
        id: s(id),
        time_created: time,
        kind: s(kind),
        provider_id: s("openai"),
        model_id: s("gpt"),
        variant: None,
        profile: None,
        agent: s("build"),
        project_id: s("prj_one"),
        session_id: s("ses_one"),
        request_id: guardrail.then(|| s(request)),
        category: s(if guardrail { "ordinary" } else { "rate_limit" }),
        rule_ids: Document::new(JsonValue::Array(
            rules
                .iter()
                .map(|rule| JsonValue::String(s(rule)))
                .collect(),
        ))
        .unwrap(),
        target: (!guardrail)
            .then(|| Document::new(json(r#"{"id":"mini","providerID":"openai"}"#)).unwrap()),
        decided_by: (kind == "guardrail-rejected").then(|| s("human")),
    }
}

fn put(store: &Store, rows: Vec<Incident>) {
    for chunk in rows.chunks(1_000) {
        let chunk = chunk.to_vec();
        store
            .submit(move |tx| {
                chunk
                    .iter()
                    .try_for_each(|row| IncidentTable::insert(tx, row))
            })
            .unwrap()
            .wait()
            .unwrap();
    }
}

fn gpt() -> ModelKey {
    ModelKey {
        provider: provider::Id(s("openai")),
        model: s("gpt"),
    }
}

fn report_input(group: &str) -> ReportInput {
    ReportInput {
        group: model_incident::Group(s(group)),
        from: None,
        to: None,
        offset: None,
        limit: None,
    }
}

type Summary = (String, String, Option<String>, i64, i64, i64, i64);

fn summary(report: &model_incident::Report) -> Vec<Summary> {
    report
        .rows
        .iter()
        .map(|row| {
            (
                row.provider_id.0.as_str().unwrap().to_owned(),
                row.model_id.as_str().unwrap().to_owned(),
                row.agent
                    .as_ref()
                    .map(|agent| agent.as_str().unwrap().to_owned()),
                row.fallbacks.get(),
                row.escalated.get(),
                row.rejected.get(),
                row.last.get(),
            )
        })
        .collect()
}

fn owned(provider: &str, model: &str, agent: Option<&str>, counts: [i64; 4]) -> Summary {
    (
        provider.to_owned(),
        model.to_owned(),
        agent.map(str::to_owned),
        counts[0],
        counts[1],
        counts[2],
        counts[3],
    )
}

#[test]
fn a_fallback_is_attributed_to_the_model_it_left_with_a_bounded_category() {
    let store = store();
    let input = |category: &str| FallbackInput {
        session_id: session::Id::new("ses_one").unwrap(),
        agent: s("build"),
        from: model::Ref {
            profile: Some(model::ProfileName(s("work"))),
            ..reference("openai", "gpt", Some("high"))
        },
        to: reference("openai", "mini", None),
        category: s(category),
        time: 70,
    };
    let first = input("rate_limit");
    assert!(submit(&store, move |tx| record::fallback(
        tx,
        &id("inc_a"),
        &first
    )));
    let second = input("quota exceeded: /Users/me/.config secret");
    assert!(submit(&store, move |tx| record::fallback(
        tx,
        &id("inc_b"),
        &second
    )));
    let missing = FallbackInput {
        session_id: session::Id::new("ses_missing").unwrap(),
        ..input("rate_limit")
    };
    assert!(!submit(&store, move |tx| record::fallback(
        tx,
        &id("inc_c"),
        &missing
    )));
    assert_eq!(
        incidents(&store),
        [
            Incident {
                variant: Some(s("high")),
                profile: Some(s("work")),
                time_created: 70,
                ..row("inc_a", "fallback", 70, "", &[])
            },
            Incident {
                variant: Some(s("high")),
                profile: Some(s("work")),
                time_created: 70,
                category: s("unknown"),
                ..row("inc_b", "fallback", 70, "", &[])
            },
        ]
    );
}

#[test]
fn an_escalation_is_attributed_to_its_assistant_message_once_with_sanitized_rules() {
    let store = store();
    let input = guardrail_input(
        "ses_one",
        Some("msg_assistant"),
        &[
            "standard.review.force-push",
            "rm -rf /home/me",
            "Standard.Review",
            "standard.review.force-push",
            "team.rule-a",
        ],
        true,
    );
    let repeated = input.clone();
    assert!(submit(&store, move |tx| record::escalation(
        tx,
        &id("inc_a"),
        &input
    )));
    assert!(!submit(&store, move |tx| record::escalation(
        tx,
        &id("inc_b"),
        &repeated
    )));
    for (name, input) in [
        (
            "no message",
            guardrail_input("ses_one", None, &["custom"], false),
        ),
        (
            "user message",
            guardrail_input("ses_one", Some("msg_user"), &[], false),
        ),
        (
            "message without model",
            guardrail_input("ses_one", Some("msg_bare"), &[], false),
        ),
        (
            "other session message",
            guardrail_input("ses_one", Some("msg_other"), &[], false),
        ),
        (
            "unknown message",
            guardrail_input("ses_one", Some("msg_missing"), &[], false),
        ),
    ] {
        let input = GuardrailInput {
            request_id: request_id("grq_other"),
            ..input
        };
        assert!(
            !submit(&store, move |tx| record::escalation(
                tx,
                &id("inc_x"),
                &input
            )),
            "{name}"
        );
    }
    assert_eq!(
        incidents(&store),
        [Incident {
            id: s("inc_a"),
            time_created: 50,
            kind: s("guardrail-escalated"),
            provider_id: s("anthropic"),
            model_id: s("claude"),
            variant: Some(s("max")),
            profile: Some(s("work")),
            agent: s("plan"),
            project_id: s("prj_one"),
            session_id: s("ses_one"),
            request_id: Some(s("grq_one")),
            category: s("hard"),
            rule_ids: Document::new(json(
                r#"["standard.review.force-push","custom","team.rule-a"]"#
            ))
            .unwrap(),
            target: None,
            decided_by: None,
        }]
    );
}

#[test]
fn a_rejection_uses_its_message_or_the_earlier_escalation_and_otherwise_records_nothing() {
    let store = store();
    let decided = |value: &str| model_incident::DecidedBy(s(value));
    let escalation = guardrail_input("ses_one", Some("msg_assistant"), &["custom"], false);
    assert!(submit(&store, move |tx| record::escalation(
        tx,
        &id("inc_a"),
        &escalation
    )));
    let fallback_attribution = guardrail_input("ses_one", None, &["custom"], false);
    let repeated = fallback_attribution.clone();
    assert!(submit(&store, move |tx| record::rejection(
        tx,
        &id("inc_b"),
        &fallback_attribution,
        &decided("human")
    )));
    assert!(!submit(&store, move |tx| record::rejection(
        tx,
        &id("inc_c"),
        &repeated,
        &decided("decision-model")
    )));
    let direct = GuardrailInput {
        session_id: session::Id::new("ses_two").unwrap(),
        message_id: Some(session_message_id::Id::new("msg_other").unwrap()),
        request_id: request_id("grq_two"),
        ..guardrail_input("ses_one", None, &["standard.review.outside-repo"], false)
    };
    assert!(submit(&store, move |tx| record::rejection(
        tx,
        &id("inc_d"),
        &direct,
        &decided("decision-model")
    )));
    let orphan = GuardrailInput {
        request_id: request_id("grq_orphan"),
        ..guardrail_input("ses_one", None, &["custom"], false)
    };
    assert!(!submit(&store, move |tx| record::rejection(
        tx,
        &id("inc_e"),
        &orphan,
        &decided("human")
    )));
    let rows = incidents(&store);
    assert_eq!(
        rows.iter()
            .map(|row| (
                row.id.as_str().unwrap(),
                row.kind.as_str().unwrap(),
                row.agent.as_str().unwrap(),
                row.model_id.as_str().unwrap(),
                row.variant.as_ref().and_then(LosslessString::as_str),
                row.decided_by.as_ref().and_then(LosslessString::as_str),
            ))
            .collect::<Vec<_>>(),
        [
            (
                "inc_a",
                "guardrail-escalated",
                "plan",
                "claude",
                Some("max"),
                None
            ),
            (
                "inc_b",
                "guardrail-rejected",
                "plan",
                "claude",
                Some("max"),
                Some("human")
            ),
            (
                "inc_d",
                "guardrail-rejected",
                "build",
                "gpt",
                None,
                Some("decision-model")
            ),
        ]
    );
}

#[tokio::test]
async fn reports_group_filter_sort_and_page_exact_counts() {
    let store = store();
    let other =
        |id: &str, kind: &str, time: i64, provider: &str, model: &str, agent: &str| Incident {
            provider_id: s(provider),
            model_id: s(model),
            agent: s(agent),
            ..row(id, kind, time, &format!("grq_{id}"), &["custom"])
        };
    put(
        &store,
        vec![
            row("inc_01", "fallback", 10, "", &[]),
            row("inc_02", "fallback", 20, "", &[]),
            other("inc_03", "guardrail-escalated", 50, "openai", "gpt", "plan"),
            other(
                "inc_04",
                "guardrail-rejected",
                30,
                "anthropic",
                "claude",
                "build",
            ),
            other(
                "inc_05",
                "guardrail-rejected",
                40,
                "anthropic",
                "claude",
                "build",
            ),
            other(
                "inc_06",
                "guardrail-rejected",
                35,
                "anthropic",
                "claude",
                "plan",
            ),
            other(
                "inc_07",
                "guardrail-escalated",
                60,
                "google",
                "gemini",
                "build",
            ),
        ],
    );
    let service = Service::new(store.client());
    let by_model = service.report(report_input("model")).await.unwrap();
    assert_eq!(by_model.groups.get(), 3);
    assert_eq!(
        summary(&by_model),
        [
            owned("openai", "gpt", None, [2, 1, 0, 50]),
            owned("anthropic", "claude", None, [0, 0, 3, 40]),
            owned("google", "gemini", None, [0, 1, 0, 60]),
        ]
    );
    let by_agent = service.report(report_input("agent")).await.unwrap();
    assert_eq!(by_agent.groups.get(), 5);
    assert_eq!(
        summary(&by_agent),
        [
            owned("anthropic", "claude", Some("build"), [0, 0, 2, 40]),
            owned("openai", "gpt", Some("build"), [2, 0, 0, 20]),
            owned("google", "gemini", Some("build"), [0, 1, 0, 60]),
            owned("openai", "gpt", Some("plan"), [0, 1, 0, 50]),
            owned("anthropic", "claude", Some("plan"), [0, 0, 1, 35]),
        ]
    );
    let ranged = service
        .report(ReportInput {
            from: Some(20),
            to: Some(50),
            ..report_input("model")
        })
        .await
        .unwrap();
    assert_eq!(
        summary(&ranged),
        [
            owned("anthropic", "claude", None, [0, 0, 3, 40]),
            owned("openai", "gpt", None, [1, 0, 0, 20]),
        ]
    );
    let page = service
        .report(ReportInput {
            offset: Some(1),
            limit: Some(1),
            ..report_input("model")
        })
        .await
        .unwrap();
    assert_eq!(page.groups.get(), 3);
    assert_eq!(
        summary(&page),
        [owned("anthropic", "claude", None, [0, 0, 3, 40])]
    );
    let beyond = service
        .report(ReportInput {
            offset: Some(5),
            limit: Some(200),
            ..report_input("model")
        })
        .await
        .unwrap();
    assert!(beyond.rows.is_empty() && beyond.groups.get() == 3);
    for (name, input) in [
        (
            "negative offset",
            ReportInput {
                offset: Some(-1),
                ..report_input("model")
            },
        ),
        (
            "zero limit",
            ReportInput {
                limit: Some(0),
                ..report_input("model")
            },
        ),
        (
            "limit above 200",
            ReportInput {
                limit: Some(201),
                ..report_input("model")
            },
        ),
        (
            "negative from",
            ReportInput {
                from: Some(-1),
                ..report_input("model")
            },
        ),
        (
            "reversed range",
            ReportInput {
                from: Some(5),
                to: Some(4),
                ..report_input("model")
            },
        ),
    ] {
        assert!(
            matches!(service.report(input).await, Err(Error::InvalidInput(_))),
            "{name}"
        );
    }
}

#[tokio::test]
async fn recent_lists_one_model_newest_first_with_identifier_only_items() {
    let store = store();
    let mut rows = (0..30)
        .map(|index| Incident {
            agent: s(if index % 2 == 0 { "build" } else { "plan" }),
            ..row(
                &format!("inc_{index:02}"),
                "guardrail-escalated",
                100 + index / 2,
                &format!("grq_{index}"),
                &["custom"],
            )
        })
        .collect::<Vec<_>>();
    rows.push(Incident {
        model_id: s("mini"),
        ..row("inc_99", "guardrail-escalated", 999, "grq_99", &[])
    });
    rows.push(Incident {
        variant: Some(s("high")),
        profile: Some(s("work")),
        ..row("inc_98", "fallback", 998, "", &[])
    });
    put(&store, rows);
    let service = Service::new(store.client());
    let input = |agent: Option<&str>, limit: Option<i64>| RecentInput {
        provider: provider::Id(s("openai")),
        model: s("gpt"),
        agent: agent.map(s),
        limit,
    };
    let recent = service.recent(input(None, None)).await.unwrap();
    assert_eq!(recent.items.len(), 20);
    let ids = recent
        .items
        .iter()
        .map(|item| item.id.0.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(&ids[..4], ["inc_98", "inc_29", "inc_28", "inc_27"]);
    let first = &recent.items[0];
    assert_eq!(first.kind.0.as_str(), Some("fallback"));
    assert_eq!(first.time.get(), 998);
    assert_eq!(first.category.as_str(), Some("rate_limit"));
    assert!(first.rule_ids.is_empty());
    assert_eq!(
        first.variant.as_ref().and_then(LosslessString::as_str),
        Some("high")
    );
    assert_eq!(
        first
            .profile
            .as_ref()
            .and_then(|profile| profile.0.as_str()),
        Some("work")
    );
    assert_eq!(first.target, Some(reference("openai", "mini", None)));
    assert!(first.decided_by.is_none());
    assert_eq!(
        service
            .recent(input(None, Some(50)))
            .await
            .unwrap()
            .items
            .len(),
        31
    );
    let plan = service.recent(input(Some("plan"), Some(3))).await.unwrap();
    assert_eq!(
        plan.items
            .iter()
            .map(|item| item.id.0.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["inc_29", "inc_27", "inc_25"]
    );
    for limit in [0, 51] {
        assert!(
            matches!(
                service.recent(input(None, Some(limit))).await,
                Err(Error::InvalidInput(_))
            ),
            "{limit}"
        );
    }
}

#[tokio::test]
async fn guidance_renders_fixed_notes_for_repeated_rule_stops_within_the_window() {
    let store = store();
    let mut rows = Vec::new();
    let mut next = 0;
    let mut stop = |requests: &[&str], rule: &str, time: i64, rows: &mut Vec<Incident>| {
        for request in requests {
            next += 1;
            rows.push(row(
                &format!("inc_{next:03}"),
                "guardrail-escalated",
                time,
                request,
                &[rule],
            ));
        }
    };
    stop(
        &["r1", "r2", "r3", "r4"],
        "standard.review.database-destructive",
        NOW - DAY,
        &mut rows,
    );
    stop(
        &["r5", "r6", "r7"],
        "standard.review.home-child",
        NOW - DAY,
        &mut rows,
    );
    stop(
        &["r8", "r9", "r10"],
        "standard.review.force-push",
        NOW - DAY,
        &mut rows,
    );
    stop(&["r11"], "team.rule-a", NOW - DAY, &mut rows);
    stop(&["r12"], "team.rule-b", NOW - DAY, &mut rows);
    stop(
        &["r13", "r14"],
        "standard.review.git-destructive",
        NOW - WINDOW,
        &mut rows,
    );
    stop(
        &["r15", "r16"],
        "standard.review.outside-repo",
        NOW - DAY,
        &mut rows,
    );
    stop(
        &["r17", "r18"],
        "standard.review.project-deletion",
        NOW - DAY,
        &mut rows,
    );
    stop(
        &["r19", "r19"],
        "standard.review.git-destructive",
        NOW - DAY,
        &mut rows,
    );
    stop(
        &["r20", "r21"],
        "standard.review.home-child",
        NOW - WINDOW - 1,
        &mut rows,
    );
    stop(
        &["r22", "r23"],
        "standard.review.home-child",
        NOW + 1,
        &mut rows,
    );
    rows.push(Incident {
        decided_by: Some(s("human")),
        kind: s("guardrail-rejected"),
        ..row(
            "inc_900",
            "guardrail-escalated",
            NOW - DAY,
            "r19",
            &["standard.review.git-destructive"],
        )
    });
    rows.extend((0..5).map(|index| row(&format!("inc_f{index}"), "fallback", NOW - DAY, "", &[])));
    rows.extend(["r30", "r31"].map(|request| Incident {
        model_id: s("other"),
        ..row(
            &format!("inc_o{request}"),
            "guardrail-escalated",
            NOW - DAY,
            request,
            &["standard.review.outside-repo"],
        )
    }));
    put(&store, rows);
    let expected = text(&[DATABASE, FORCE, GIT, HOME, CUSTOM]);
    let service = Service::new(store.client());
    let guidance = service.guidance(gpt(), true, NOW).await.unwrap();
    assert_eq!(
        guidance.text.as_ref().and_then(LosslessString::as_str),
        Some(expected.as_str())
    );
    assert!(guidance.enabled && guidance.cleared_at.is_none());
    assert!(expected.len() <= 1_024);
    assert_eq!(service.guidance(gpt(), true, NOW).await.unwrap(), guidance);
    let disabled = service.guidance(gpt(), false, NOW).await.unwrap();
    assert!(!disabled.enabled);
    assert_eq!(disabled.text, guidance.text);
    let other = service
        .guidance(
            ModelKey {
                provider: provider::Id(s("openai")),
                model: s("other"),
            },
            true,
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(
        other.text.as_ref().and_then(LosslessString::as_str),
        Some(text(&[OUTSIDE]).as_str())
    );
    let elsewhere = service
        .guidance(
            ModelKey {
                provider: provider::Id(s("azure")),
                model: s("gpt"),
            },
            true,
            NOW,
        )
        .await
        .unwrap();
    assert!(elsewhere.text.is_none() && elsewhere.cleared_at.is_none());
}

#[tokio::test]
async fn clearing_moves_a_monotonic_watermark_without_deleting_incidents() {
    let store = store();
    put(
        &store,
        vec![
            row(
                "inc_1",
                "guardrail-escalated",
                NOW - 3 * DAY,
                "r1",
                &["custom"],
            ),
            row(
                "inc_2",
                "guardrail-escalated",
                NOW - 2 * DAY,
                "r2",
                &["custom"],
            ),
            row("inc_3", "guardrail-escalated", NOW - DAY, "r3", &["custom"]),
        ],
    );
    let service = Service::new(store.client());
    assert_eq!(
        service.clear(gpt(), NOW - 2 * DAY).await.unwrap(),
        NOW - 2 * DAY
    );
    let cleared = service.guidance(gpt(), true, NOW).await.unwrap();
    assert!(cleared.text.is_none());
    assert_eq!(cleared.cleared_at.map(|at| at.get()), Some(NOW - 2 * DAY));
    put(
        &store,
        vec![row(
            "inc_4",
            "guardrail-escalated",
            NOW - DAY / 2,
            "r4",
            &["custom"],
        )],
    );
    assert_eq!(
        service
            .guidance(gpt(), true, NOW)
            .await
            .unwrap()
            .text
            .as_ref()
            .and_then(LosslessString::as_str),
        Some(text(&[CUSTOM]).as_str())
    );
    assert_eq!(
        service.clear(gpt(), NOW - 5 * DAY).await.unwrap(),
        NOW - 2 * DAY
    );
    assert_eq!(service.clear(gpt(), NOW).await.unwrap(), NOW);
    assert!(
        service
            .guidance(gpt(), true, NOW)
            .await
            .unwrap()
            .text
            .is_none()
    );
    assert_eq!(incidents(&store).len(), 4);
    assert_eq!(
        summary(&service.report(report_input("model")).await.unwrap()),
        [owned("openai", "gpt", None, [0, 4, 0, NOW - DAY / 2])]
    );
}

#[tokio::test]
async fn guidance_scans_only_the_newest_ten_thousand_guardrail_rows_and_reports_count_every_row() {
    let store = store();
    let mut rows = (0..10_000)
        .map(|index| {
            row(
                &format!("inc_{index:05}"),
                "guardrail-escalated",
                NOW - DAY + index,
                "grq_bulk",
                &["standard.review.force-push"],
            )
        })
        .collect::<Vec<_>>();
    rows.extend(["r1", "r2"].map(|request| {
        row(
            &format!("inc_old_{request}"),
            "guardrail-escalated",
            NOW - 2 * DAY,
            request,
            &["custom"],
        )
    }));
    rows.extend((0..3).map(|index| row(&format!("inc_fb{index}"), "fallback", NOW, "", &[])));
    put(&store, rows);
    let service = Service::new(store.client());
    assert!(
        service
            .guidance(gpt(), true, NOW)
            .await
            .unwrap()
            .text
            .is_none()
    );
    assert_eq!(
        summary(&service.report(report_input("model")).await.unwrap()),
        [owned("openai", "gpt", None, [3, 10_002, 0, NOW])]
    );
}

#[tokio::test]
async fn the_guidance_instruction_source_renders_initial_changed_and_retracted_text() {
    let store = store();
    let now = Arc::new(std::sync::atomic::AtomicI64::new(NOW));
    let clock = now.clone();
    let source = guidance::source(
        store.client(),
        gpt(),
        Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst)),
    );
    assert_eq!(instructions::key(&source.key).as_str(), Some(guidance::KEY));
    assert_eq!(guidance::KEY, "core/model-guidance");
    assert_eq!((source.read)().await.unwrap(), Observation::Removed);
    put(
        &store,
        vec![
            row("inc_1", "guardrail-escalated", NOW - DAY, "r1", &["custom"]),
            row("inc_2", "guardrail-escalated", NOW - DAY, "r2", &["custom"]),
        ],
    );
    let Observation::Value(value) = (source.read)().await.unwrap() else {
        panic!("guidance value expected");
    };
    assert_eq!(value, JsonValue::String(s(&text(&[CUSTOM]))));
    assert_eq!(
        (source.initial)(&value)
            .as_ref()
            .and_then(LosslessString::as_str),
        Some(text(&[CUSTOM]).as_str())
    );
    assert_eq!(
        (source.changed)(&JsonValue::String(s("earlier")), &value)
            .as_ref()
            .and_then(LosslessString::as_str),
        Some(format!("{CHANGED}{}", text(&[CUSTOM])).as_str())
    );
    assert_eq!(
        source
            .removed
            .as_ref()
            .and_then(|removed| removed(&value))
            .as_ref()
            .and_then(LosslessString::as_str),
        Some(RETRACTION)
    );
    now.store(NOW + WINDOW, std::sync::atomic::Ordering::SeqCst);
    assert_eq!((source.read)().await.unwrap(), Observation::Removed);
}
