include!("policy_fixture.rs");
mod filesystem_fixture;
use ycoding_core::process::guardrails::{Guardrails, Input, Limits, Paths, Settings};
use ycoding_core::tools::policy::Effect;
use ycoding_schema::{DomainEncode, JsonObject, JsonValue, LosslessString, guardrail, permission};

fn settings() -> Settings {
    Settings {
        paths: Paths {
            workdir: "/workspace/project".into(),
            project: "/workspace/project".into(),
            home: "/home/operator".into(),
            tmpdir: None,
            trusted_paths: vec![],
        },
        global_roots: vec!["/home/operator/.config/ycoding".into()],
        custom: std::sync::Arc::new(Vec::new),
        enabled: true,
        limits: Limits::default(),
    }
}
#[test]
fn default_limits_wait_sixty_seconds_for_a_shell_slot() {
    let limits = Limits::default();
    assert_eq!(
        (
            limits.shells,
            limits.subagents,
            limits.reviews,
            limits.shell_wait
        ),
        (8, 8, 16, std::time::Duration::from_secs(60))
    );
}
fn input(session: &ycoding_schema::session_id::SessionId, command: &str) -> Input {
    Input {
        session_id: session.clone(),
        action: "shell".into(),
        resources: vec![command.into()],
        metadata: None,
        skip_review: false,
        holder: None,
    }
}

#[tokio::test]
async fn hard_reviews_never_use_yolo_goal_always_or_exemptions() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 3, true, None);
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "external_directory".into(),
        resource: "*".into(),
        effect: permission::Effect("allow".into()),
    });
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(),
        fixture.publisher(),
    );
    let admission = service.assert(input(&root, "rm -rf ~/notes")).unwrap();
    let request = admission.request.unwrap();
    assert_eq!(admission.effect, Effect::Ask);
    assert_eq!(request.hard_review, Some(true));
    service
        .reply(&root, &request.id, guardrail::Reply::Always)
        .unwrap();
    assert!(admission.wait.unwrap().await.unwrap().is_err());
    let next = service.assert(input(&root, "rm -rf ~/notes")).unwrap();
    let request = next.request.unwrap();
    service
        .reply(&root, &request.id, guardrail::Reply::Once)
        .unwrap();
    let reservation = next.wait.unwrap().await.unwrap().unwrap();
    reservation.release();
    assert_eq!(
        service
            .assert(input(&root, "rm -rf ~/notes"))
            .unwrap()
            .effect,
        Effect::Ask
    );
    let mut skip = input(&root, "rm -rf ~/notes");
    skip.skip_review = true;
    assert_eq!(service.assert(skip).unwrap().effect, Effect::Allow);
    let mut deny = input(&root, "rm -rf /");
    deny.skip_review = true;
    assert!(service.assert(deny).is_err());
}

fn file(session: &ycoding_schema::session_id::SessionId, path: &str) -> Input {
    Input {
        action: "file_mutation".into(),
        ..input(session, path)
    }
}
fn at(mut input: Input, workdir: &str) -> Input {
    let mut metadata = JsonObject::new();
    metadata.insert("workdir".into(), JsonValue::String(workdir.into()));
    input.metadata = Some(metadata);
    input
}
fn multiple(session: &ycoding_schema::session_id::SessionId, commands: &[&str]) -> Input {
    Input {
        resources: commands.iter().map(|command| (*command).into()).collect(),
        ..input(session, "")
    }
}
fn assert_admitted(service: &Guardrails, input: Input) {
    let admission = service.assert(input.clone()).unwrap();
    assert_eq!(admission.effect, Effect::Allow, "{:?}", input.resources);
    admission.reservation.unwrap().release();
}
fn assert_reviewed(service: &Guardrails, input: Input) {
    let result = service.evaluate(&input).unwrap();
    assert_eq!(result.effect, Effect::Ask, "{:?}", input.resources);
    assert!(!result.hard_review, "{:?}", input.resources);
    assert_eq!(
        result.rule_ids,
        vec![LosslessString::from("standard.review.outside-repo")],
        "{:?}",
        input.resources
    );
}
fn approved_events(
    fixture: &Fixture,
    session: &ycoding_schema::session_id::SessionId,
) -> Vec<JsonValue> {
    let prefix = ycoding_store::tuple_key(&[
        ycoding_store::KeyPart::String(session.as_lossless()),
        ycoding_store::KeyPart::String(&"session.guardrail.approved.1".into()),
    ]);
    fixture
        .store
        .snapshot()
        .unwrap()
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_type_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 128,
            },
        )
        .unwrap()
        .into_iter()
        .map(|row| row.record.data)
        .collect()
}

#[tokio::test]
async fn always_approves_every_reviewed_outside_directory_for_the_root_family() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let child = fixture.session("ses_child", Some("ses_root"), 0, false, None);
    let other = fixture.session("ses_other", None, 0, false, None);
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(),
        fixture.publisher(),
    );
    let reviewed = at(
        multiple(&root, &["touch /outside/file", "ordered context"]),
        "/repo",
    );
    let admission = service.assert(reviewed.clone()).unwrap();
    let request = admission.request.unwrap();
    assert_eq!(
        request.rule_ids,
        vec![LosslessString::from("standard.review.outside-repo")]
    );
    assert_eq!(request.hard_review, None);
    assert!(
        service
            .reply(&other, &request.id, guardrail::Reply::Always)
            .is_err()
    );
    service
        .reply(&child, &request.id, guardrail::Reply::Always)
        .unwrap();
    admission.wait.unwrap().await.unwrap().unwrap().release();
    for admitted in [
        Input {
            session_id: child.clone(),
            ..reviewed.clone()
        },
        at(
            multiple(&root, &["ordered context", "touch /outside/file"]),
            "/repo",
        ),
        file(&root, "/outside/new/file"),
        at(input(&root, "cp /repo/a /outside/b"), "/repo"),
        at(input(&root, "task-runner /outside/nested/other"), "/repo"),
    ] {
        assert_admitted(&service, admitted);
    }
    assert!(service.for_session(&root).unwrap().is_empty());
    for reviewed in [
        at(input(&root, "touch /outside/file"), "/other"),
        input(&root, "touch /outside/file /elsewhere/file"),
        input(&other, "touch /outside/file"),
    ] {
        assert_reviewed(&service, reviewed);
    }
    assert!(
        service
            .evaluate(&at(input(&root, "git reset --hard HEAD~2"), "/repo"))
            .unwrap()
            .hard_review
    );
    let mut directories = approved_events(&fixture, &root)
        .iter()
        .flat_map(|data| match data {
            JsonValue::Object(object) => match object.get(&"directories".into()) {
                Some(JsonValue::Array(items)) => items.clone(),
                _ => vec![],
            },
            _ => vec![],
        })
        .collect::<Vec<_>>();
    directories.sort_by_key(ycoding_schema::stringify_json);
    assert_eq!(
        directories,
        vec![
            JsonValue::String("/outside".into()),
            JsonValue::String("/repo".into())
        ]
    );
    assert!(approved_events(&fixture, &child).is_empty());
}

#[tokio::test]
async fn durable_always_survives_restart_and_never_settles_hard_reviews() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let child = fixture.session("ses_child", Some("ses_root"), 0, false, None);
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(),
        fixture.publisher(),
    );
    let admission = service
        .assert(file(&root, "/home/operator/x/a.txt"))
        .unwrap();
    let request = admission.request.unwrap();
    assert_eq!(request.hard_review, None);
    service
        .reply(&root, &request.id, guardrail::Reply::Always)
        .unwrap();
    admission.wait.unwrap().await.unwrap().unwrap().release();
    for admitted in [
        file(&root, "/home/operator/x/b.txt"),
        file(&child, "/home/operator/x/nested/c.txt"),
        input(&child, "touch ~/x/d.txt"),
    ] {
        let result = service.evaluate(&admitted).unwrap();
        assert_eq!(result.effect, Effect::Allow, "{:?}", admitted.resources);
        assert!(result.rule_ids.is_empty());
        assert_admitted(&service, admitted);
    }
    assert!(service.for_session(&root).unwrap().is_empty());
    assert_reviewed(&service, file(&root, "/home/operator/y/a.txt"));
    assert_reviewed(&service, file(&child, "/home/operator/xy/a.txt"));
    let hard = service.assert(input(&child, "rm -rf ~/x")).unwrap();
    let request = hard.request.unwrap();
    assert_eq!(request.hard_review, Some(true));
    service
        .reply(&child, &request.id, guardrail::Reply::Always)
        .unwrap();
    assert!(hard.wait.unwrap().await.unwrap().is_err());
    assert_eq!(approved_events(&fixture, &root).len(), 1);

    service.shutdown();
    let restarted = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(),
        fixture.publisher(),
    );
    assert_eq!(
        restarted
            .evaluate(&file(&child, "/home/operator/x/e.txt"))
            .unwrap()
            .effect,
        Effect::Allow
    );
    assert_reviewed(&restarted, file(&root, "/home/operator/y/a.txt"));
    let hard = restarted.evaluate(&input(&child, "rm -rf ~/x")).unwrap();
    assert_eq!(hard.effect, Effect::Ask);
    assert!(hard.hard_review);
}

#[test]
fn ycoding_global_directories_skip_outside_review_but_not_hard_review() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let mut config = settings();
    config.global_roots = [
        "/global",
        "/ycoding/data",
        "/ycoding/cache",
        "/ycoding/state",
    ]
    .into_iter()
    .map(LosslessString::from)
    .collect();
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        config,
        fixture.publisher(),
    );
    for path in [
        "/global",
        "/global/settings.json",
        "/global/nested/settings.json",
        "/ycoding/data/db",
        "/ycoding/data/repos/example",
        "/ycoding/cache/bin/tool",
        "/ycoding/state/session",
    ] {
        let result = service.evaluate(&file(&root, path)).unwrap();
        assert_eq!(result.effect, Effect::Allow, "{path}");
        assert!(result.rule_ids.is_empty(), "{path}");
    }
    assert_reviewed(
        &service,
        input(&root, "touch /global/settings.json /outside/file"),
    );
    let hard = service
        .evaluate(&at(input(&root, "git reset --hard"), "/ycoding/data"))
        .unwrap();
    assert!(hard.hard_review);
    assert_eq!(
        hard.rule_ids,
        vec![LosslessString::from("standard.review.git-destructive")]
    );
}

#[test]
fn ycoding_managed_tool_operations_are_admitted_without_a_review_request() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let mut config = settings();
    config.global_roots = vec!["/ycoding/data".into()];
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        config,
        fixture.publisher(),
    );
    let operation = |action: &str, resource: &str, key: &str, value: &str| {
        let mut metadata = JsonObject::new();
        metadata.insert(key.into(), JsonValue::String(value.into()));
        Input {
            action: action.into(),
            metadata: Some(metadata),
            ..input(&root, resource)
        }
    };
    for admitted in [
        operation(
            "file_mutation",
            "/ycoding/data/worktrees/repo_abc/feature",
            "operation",
            "create_git_worktree",
        ),
        operation(
            "file_mutation",
            "/ycoding/data/memory/repo_abc",
            "memoryAction",
            "write",
        ),
        operation(
            "file_mutation",
            "/ycoding/data/memory/knowledge",
            "memoryAction",
            "delete",
        ),
        operation(
            "project_artifact_mutation",
            "skill/example",
            "operation",
            "automatic_write",
        ),
        operation("subagent", "build", "description", "task"),
        operation("mcp_execute", "server/tool", "operation", "call"),
        input(&root, "git worktree add -b feature .worktrees/feature"),
        input(
            &root,
            "mkdir -p .worktrees && git worktree add -b feature .worktrees/feature",
        ),
        input(
            &root,
            "git -C /ycoding/data/worktrees/repo_abc/feature add -A",
        ),
    ] {
        let result = service.evaluate(&admitted).unwrap();
        assert_eq!(result.effect, Effect::Allow, "{:?}", admitted.resources);
        assert!(result.rule_ids.is_empty(), "{:?}", admitted.resources);
        assert_admitted(&service, admitted);
    }
    assert!(service.for_session(&root).unwrap().is_empty());
}

#[test]
fn external_directory_allow_alone_exempts_outside_paths_and_never_hard_reviews() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let rule = |effect: &str| {
        ycoding_core::tools::policy::expand_permissions(
            &[permission::Rule {
                action: "external_directory".into(),
                resource: "~/Downloads/**".into(),
                effect: permission::Effect(effect.into()),
            }],
            &"/home/operator".into(),
        )
    };
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(),
        fixture.publisher(),
    );
    *fixture.rules.lock().unwrap() = rule("allow");
    for allowed in [
        file(&root, "/home/operator/Downloads/a/b.txt"),
        input(&root, "cd ~/Downloads && echo ok"),
        input(&root, "touch ~/Downloads/a/b.txt"),
    ] {
        let result = service.evaluate(&allowed).unwrap();
        assert_eq!(result.effect, Effect::Allow, "{:?}", allowed.resources);
        assert!(result.rule_ids.is_empty());
    }
    let hard = service
        .evaluate(&input(&root, "rm -rf ~/Downloads"))
        .unwrap();
    assert_eq!(hard.effect, Effect::Ask);
    assert!(hard.hard_review);
    assert_eq!(
        hard.rule_ids,
        vec![LosslessString::from("standard.review.home-child")]
    );
    assert_reviewed(
        &service,
        input(&root, "touch ~/Downloads/a/b.txt /outside/file"),
    );
    assert_reviewed(
        &service,
        input(
            &root,
            "touch /home/operator/.config/ycoding/settings.json /outside/file",
        ),
    );
    for effect in ["ask", "deny"] {
        *fixture.rules.lock().unwrap() = rule(effect);
        assert_reviewed(&service, file(&root, "/home/operator/Downloads/a/b.txt"));
    }
    *fixture.rules.lock().unwrap() = vec![];
    assert_reviewed(&service, file(&root, "/home/operator/Downloads/a/b.txt"));
}

#[test]
fn saved_external_directory_always_counts_as_inside() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    ycoding_core::tools::policy::permissions::SavedPermissions {
        store: fixture.store.client(),
    }
    .add(
        &ycoding_schema::project_id::ProjectId::new("project").unwrap(),
        &"external_directory".into(),
        &["/outside/repo/*".into()],
    )
    .unwrap();
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(),
        fixture.publisher(),
    );
    for allowed in [
        file(&root, "/outside/repo/src/a.ts"),
        input(&root, "touch /outside/repo/src/a.ts"),
    ] {
        let result = service.evaluate(&allowed).unwrap();
        assert_eq!(result.effect, Effect::Allow, "{:?}", allowed.resources);
        assert!(result.rule_ids.is_empty());
    }
    assert_reviewed(&service, file(&root, "/outside/elsewhere/a.ts"));
}

#[test]
fn exemptions_only_remove_ordinary_outside_review_and_never_hide_mixed_paths() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, true, None);
    *fixture.rules.lock().unwrap() = vec![permission::Rule {
        action: "external_directory".into(),
        resource: "/trusted/*".into(),
        effect: permission::Effect("allow".into()),
    }];
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(),
        fixture.publisher(),
    );
    for command in [
        "touch /trusted/file",
        "cd /trusted && touch file",
        "touch /home/operator/.config/ycoding/file",
    ] {
        assert_eq!(
            service.evaluate(&input(&root, command)).unwrap().effect,
            Effect::Allow,
            "{command}"
        );
    }
    assert_eq!(
        service
            .evaluate(&input(&root, "touch /trusted/file /untrusted/file"))
            .unwrap()
            .effect,
        Effect::Ask
    );
    assert_eq!(
        service
            .assert(input(&root, "touch /untrusted/file"))
            .unwrap()
            .effect,
        Effect::Ask
    );
    assert!(
        service
            .evaluate(&input(&root, "rm -rf /home/operator/.config"))
            .unwrap()
            .hard_review
    );
    let denied = vec![permission::Rule {
        action: "external_directory".into(),
        resource: "/trusted/*".into(),
        effect: permission::Effect("deny".into()),
    }];
    let child = fixture.session("ses_child", Some("ses_root"), 0, false, Some(denied));
    assert_eq!(
        service
            .evaluate(&input(&child, "touch /trusted/file"))
            .unwrap()
            .effect,
        Effect::Ask
    );
}

#[tokio::test]
async fn review_and_shell_reservations_are_family_scoped_and_release_once() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 1, false, None);
    let child = fixture.session("ses_child", Some("ses_root"), 0, false, None);
    let mut config = settings();
    config.limits.shells = 1;
    config.limits.reviews = 1;
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        config,
        fixture.publisher(),
    );
    let admission = service.assert(input(&child, "touch /other/file")).unwrap();
    let reservation = admission.reservation.unwrap();
    let queued = service.assert(input(&root, "echo ready")).unwrap();
    assert!(queued.reservation.is_none() && queued.wait.is_some());
    drop(queued);
    assert_eq!(shells(&service, &root), 1);
    reservation.release();
    reservation.release();
    let before = service.snapshot(&root).unwrap();
    let review = service.assert(input(&root, "git reset --hard")).unwrap();
    let during = service.snapshot(&root).unwrap();
    assert!(during.sequence > before.sequence);
    assert_ne!(during.digest, before.digest);
    assert_eq!(service.for_session(&child).unwrap().len(), 1);
    assert!(service.assert(input(&child, "git reset --hard")).is_err());
    drop(review);
    assert!(service.for_session(&root).unwrap().is_empty());
    let after = service.snapshot(&root).unwrap();
    assert!(after.sequence > before.sequence);
    assert_eq!(after.digest, before.digest);
    assert_eq!(
        service.status(&root).unwrap().encode(),
        service.status(&child).unwrap().encode()
    );
    assert!(
        fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.type_ == "guardrail.asked")
    );
    let _ = LosslessString::from("bounded");
}

#[tokio::test]
async fn always_without_outside_directories_approves_only_the_attempt_and_fresh_rules_harden() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let decision = std::sync::Arc::new(std::sync::Mutex::new(guardrail::RuleDecision::Ask));
    let selected = decision.clone();
    let mut config = settings();
    config.custom = std::sync::Arc::new(move || {
        vec![ycoding_core::process::guardrails::CustomLayer {
            rules: vec![guardrail::Rule {
                id: "policy".into(),
                source: guardrail::RuleSource::Custom,
                decision: *selected.lock().unwrap(),
                actions: vec!["file_mutation".into()],
                resources: vec!["*".into()],
                reason: "Review".into(),
                priority: ycoding_schema::schema::Int::new(0).unwrap(),
            }],
            invalid_files: vec![],
        }]
    });
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        config,
        fixture.publisher(),
    );
    let mut operation = input(&root, "ignored");
    operation.action = "file_mutation".into();
    operation.resources = vec!["/other/file".into()];
    let admission = service.assert(operation.clone()).unwrap();
    let request = admission.request.unwrap();
    service
        .reply(&root, &request.id, guardrail::Reply::Always)
        .unwrap();
    admission.wait.unwrap().await.unwrap().unwrap().release();
    let again = service.assert(operation.clone()).unwrap();
    assert_eq!(again.effect, Effect::Ask);
    assert_eq!(
        again.request.unwrap().rule_ids,
        vec![LosslessString::from("policy")]
    );
    drop(again.wait);
    assert!(approved_events(&fixture, &root).is_empty());
    *decision.lock().unwrap() = guardrail::RuleDecision::HardReview;
    let hardened = service.assert(operation).unwrap();
    assert_eq!(hardened.effect, Effect::Ask);
    assert_eq!(hardened.request.unwrap().hard_review, Some(true));
}

fn shells(service: &Guardrails, session: &ycoding_schema::session_id::SessionId) -> i64 {
    service
        .status(session)
        .unwrap()
        .counters
        .iter()
        .find(|counter| counter.id.as_str() == Some("shells"))
        .unwrap()
        .current
        .get()
}
fn held(session: &ycoding_schema::session_id::SessionId, command: &str, holder: &str) -> Input {
    Input {
        holder: Some(holder.into()),
        ..input(session, command)
    }
}
fn limited(fixture: &Fixture, shells: u64, wait: std::time::Duration) -> Guardrails {
    let mut config = settings();
    config.limits.shells = shells;
    config.limits.subagents = 1;
    config.limits.shell_wait = wait;
    Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        config,
        fixture.publisher(),
    )
}
async fn pending<F: std::future::Future + Unpin>(future: &mut F) -> bool {
    tokio::time::timeout(std::time::Duration::from_millis(100), future)
        .await
        .is_err()
}

#[tokio::test]
async fn a_shell_over_the_family_limit_waits_for_a_running_shell_and_then_runs() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let child = fixture.session("ses_child", Some("ses_root"), 0, false, None);
    let service = limited(&fixture, 1, std::time::Duration::from_secs(5));
    let running = service
        .assert(held(&root, "task-runner build", "call-running"))
        .unwrap()
        .reservation
        .unwrap();
    let waiting = service
        .assert(held(&child, "task-runner build", "call-waiting"))
        .unwrap();
    assert_eq!(waiting.effect, Effect::Allow);
    assert!(waiting.request.is_none() && waiting.reservation.is_none());
    let mut wait = waiting.wait.unwrap();
    assert!(pending(&mut wait).await);
    assert_eq!(shells(&service, &root), 1);
    running.release();
    let granted = wait.await.unwrap().unwrap();
    assert_eq!(shells(&service, &root), 1);
    granted.release();
    assert_eq!(shells(&service, &root), 0);
    assert!(service.for_session(&root).unwrap().is_empty());
}

#[tokio::test]
async fn a_waiting_shell_fails_after_the_configured_wait_with_the_limit_holders_and_setting() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = limited(&fixture, 2, std::time::Duration::from_secs(1));
    let first = service
        .assert(held(&root, "task-runner build", "call-a"))
        .unwrap()
        .reservation
        .unwrap();
    let second = service
        .assert(held(&root, "task-runner build", "call-b"))
        .unwrap()
        .reservation
        .unwrap();
    let mut wait = service
        .assert(held(&root, "task-runner build", "call-c"))
        .unwrap()
        .wait
        .unwrap();
    assert!(pending(&mut wait).await);
    let error = wait.await.unwrap().err().unwrap();
    let ycoding_core::process::guardrails::Error::CapExceeded {
        counter,
        current,
        limit,
        holders,
        waited_ms,
        ..
    } = &error
    else {
        panic!("expected the shell limit, got {error:?}")
    };
    assert_eq!(
        (*counter, *current, *limit, *waited_ms),
        ("shells", 2, 2, 1000)
    );
    assert_eq!(
        holders,
        &vec![
            LosslessString::from("call-a"),
            LosslessString::from("call-b")
        ]
    );
    assert_eq!(
        error.capacity_message().unwrap(),
        "Shell limit reached: 2/2 shells running in this session family (call-a, call-b); waited 1s. Wait for or stop a running shell, or raise guardrails.max_concurrent_shells."
    );
    assert_eq!(shells(&service, &root), 2);
    first.release();
    second.release();
    assert_eq!(shells(&service, &root), 0);
}

#[tokio::test]
async fn dropping_a_waiting_shell_leaves_the_running_count_unchanged_and_the_slot_reusable() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = limited(&fixture, 1, std::time::Duration::from_secs(5));
    let running = service
        .assert(held(&root, "task-runner build", "call-running"))
        .unwrap()
        .reservation
        .unwrap();
    let mut wait = service
        .assert(held(&root, "task-runner build", "call-waiting"))
        .unwrap()
        .wait
        .unwrap();
    assert!(pending(&mut wait).await);
    drop(wait);
    assert_eq!(shells(&service, &root), 1);
    running.release();
    assert_eq!(shells(&service, &root), 0);
    let next = service
        .assert(held(&root, "task-runner build", "call-next"))
        .unwrap();
    next.reservation.unwrap().release();
    assert_eq!(shells(&service, &root), 0);
}

#[tokio::test]
async fn a_slot_granted_before_the_wait_is_polled_is_handed_over_and_never_leaked() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = limited(&fixture, 1, std::time::Duration::from_secs(5));
    let running = service
        .assert(held(&root, "task-runner build", "call-running"))
        .unwrap()
        .reservation
        .unwrap();
    let wait = service
        .assert(held(&root, "task-runner build", "call-waiting"))
        .unwrap()
        .wait
        .unwrap();
    running.release();
    assert_eq!(shells(&service, &root), 1);
    let granted = wait.await.unwrap().unwrap();
    assert_eq!(shells(&service, &root), 1);
    granted.release();
    assert_eq!(shells(&service, &root), 0);

    let running = service
        .assert(held(&root, "task-runner build", "call-running"))
        .unwrap()
        .reservation
        .unwrap();
    let unpolled = service
        .assert(held(&root, "task-runner build", "call-dropped"))
        .unwrap()
        .wait
        .unwrap();
    running.release();
    assert_eq!(shells(&service, &root), 1);
    drop(unpolled);
    assert_eq!(shells(&service, &root), 0);
}

#[tokio::test]
async fn released_shell_slots_go_to_waiting_shells_in_arrival_order() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = limited(&fixture, 1, std::time::Duration::from_secs(5));
    let running = service
        .assert(held(&root, "task-runner build", "call-running"))
        .unwrap()
        .reservation
        .unwrap();
    let mut first = service
        .assert(held(&root, "task-runner build", "call-first"))
        .unwrap()
        .wait
        .unwrap();
    let mut second = service
        .assert(held(&root, "task-runner build", "call-second"))
        .unwrap()
        .wait
        .unwrap();
    assert!(pending(&mut first).await && pending(&mut second).await);
    running.release();
    let first = first.await.unwrap().unwrap();
    assert!(pending(&mut second).await);
    first.release();
    let second = second.await.unwrap().unwrap();
    assert_eq!(shells(&service, &root), 1);
    second.release();
    assert_eq!(shells(&service, &root), 0);
}

#[test]
fn an_immediate_subagent_limit_names_the_limit_and_its_setting() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = limited(&fixture, 1, std::time::Duration::from_secs(5));
    let subagent = |holder: &str| Input {
        action: "subagent".into(),
        ..held(&root, "build", holder)
    };
    let running = service.assert(subagent("call-running")).unwrap();
    let error = service.assert(subagent("call-next")).err().unwrap();
    assert_eq!(
        error.capacity_message().unwrap(),
        "Subagent limit reached: 1/1 subagents running in this session family (call-running). Wait for or stop a running subagent, or raise guardrails.max_concurrent_subagents."
    );
    running.reservation.unwrap().release();
}

#[test]
fn real_repository_checkouts_are_inside_through_canonical_paths_and_fresh_git_lists() {
    use ycoding_core::platform::{git, worktree};
    let main = filesystem_fixture::Fixture::new();
    main.repository();
    let base = filesystem_fixture::Fixture::new();
    let other = filesystem_fixture::Fixture::new();
    other.repository();
    let git = git::Service::new(16 * 1024 * 1024);
    let repository = git.discover(&main.0).unwrap().unwrap();
    let current =
        worktree::create(&git, &repository, &base.0.join("current"), Some("current")).unwrap();
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let mut config = settings();
    config.paths.workdir = current.worktree.to_str().unwrap().into();
    config.paths.project = config.paths.workdir.clone();
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        config,
        fixture.publisher(),
    );
    let sibling =
        worktree::create(&git, &repository, &base.0.join("sibling"), Some("sibling")).unwrap();
    for checkout in [&main.0, &current.worktree, &sibling.worktree] {
        let path = checkout.to_str().unwrap();
        for allowed in [
            file(&root, &format!("{path}/src/new.ts")),
            input(&root, &format!("touch {path}/src/new.ts")),
            at(input(&root, "task-runner execute"), path),
        ] {
            assert_admitted(&service, allowed);
        }
    }
    for path in [&other.0, &base.0, &base.0.join("sibling-prefix")] {
        assert_reviewed(&service, file(&root, &format!("{}/new.ts", path.display())));
    }
    assert_reviewed(
        &service,
        input(
            &root,
            &format!("cp {}/a {}/a", main.0.display(), other.0.display(),),
        ),
    );
    assert!(
        service
            .evaluate(&at(
                input(&root, "git reset --hard"),
                main.0.to_str().unwrap()
            ))
            .unwrap()
            .hard_review
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&current.worktree, base.0.join("link")).unwrap();
        std::os::unix::fs::symlink(&other.0, sibling.worktree.join("escape")).unwrap();
        assert_admitted(
            &service,
            file(&root, &format!("{}/link/src/new.ts", base.0.display())),
        );
        assert_reviewed(
            &service,
            file(
                &root,
                &format!("{}/escape/new.ts", sibling.worktree.display()),
            ),
        );
    }
    base.write("sibling/file", "not a directory");
    assert_reviewed(
        &service,
        file(
            &root,
            &format!("{}/file/new.ts", sibling.worktree.display()),
        ),
    );
    let git_file = std::fs::read(sibling.worktree.join(".git")).unwrap();
    base.write(
        "sibling/.git",
        format!("gitdir: {}\n", other.0.join(".git").display()),
    );
    assert_reviewed(
        &service,
        file(&root, &format!("{}/new.ts", sibling.worktree.display())),
    );
    base.write("sibling/.git", git_file);
    let plain = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        Settings {
            paths: Paths {
                workdir: base.0.to_str().unwrap().into(),
                project: base.0.to_str().unwrap().into(),
                ..settings().paths
            },
            ..settings()
        },
        fixture.publisher(),
    );
    assert_reviewed(&plain, file(&root, &format!("{}/new.ts", main.0.display())));
}

#[tokio::test]
async fn an_approved_shell_review_waits_for_a_slot_and_cancelling_it_leaves_no_waiter() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = limited(&fixture, 1, std::time::Duration::from_secs(5));
    let running = service
        .assert(held(&root, "task-runner build", "call-running"))
        .unwrap()
        .reservation
        .unwrap();
    for _ in 0..2 {
        let reviewed = service
            .assert(held(&root, "touch /other/file", "call-reviewed"))
            .unwrap();
        let request = reviewed.request.unwrap();
        service
            .reply(&root, &request.id, guardrail::Reply::Once)
            .unwrap();
        let mut wait = reviewed.wait.unwrap();
        assert!(pending(&mut wait).await);
        drop(wait);
    }
    running.release();
    assert_eq!(shells(&service, &root), 0);
    let running = service
        .assert(held(&root, "task-runner build", "call-running"))
        .unwrap()
        .reservation
        .unwrap();
    let reviewed = service
        .assert(held(&root, "touch /other/file", "call-reviewed"))
        .unwrap();
    service
        .reply(&root, &reviewed.request.unwrap().id, guardrail::Reply::Once)
        .unwrap();
    let mut wait = reviewed.wait.unwrap();
    assert!(pending(&mut wait).await);
    running.release();
    let granted = wait.await.unwrap().unwrap();
    assert_eq!(shells(&service, &root), 1);
    granted.release();
    assert_eq!(shells(&service, &root), 0);
}
