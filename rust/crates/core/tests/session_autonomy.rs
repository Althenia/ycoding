use ycoding_core::session::autonomy::{
    DecisionMode, Error, Goal, GoalChange, GoalStatus, Service, State,
};
use ycoding_schema::{parse_json, session};

#[path = "decision_support/mod.rs"]
mod modes;
#[path = "autonomy_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn goal(text: &str) -> Goal {
    Goal::new(text, None, None)
}

#[test]
fn extended_goal_state_survives_a_persistence_round_trip() {
    let value = parse_json(r#"{"mode":"normal","permissions":"manual","guardrails":"manual","answers":"manual","goal":{"text":"Ship it","rawText":"Ship it","status":"active","iteration":2,"noProgress":1,"maxNoProgress":3,"phase":"stalled","rework":4,"reworkOpen":[{"unit":"parser","reason":"check failed"}],"stalls":2,"failure":{"fingerprint":"tool.stalled:tool/shell","class":"tool.stalled","unit":"tool/shell","count":2,"recovering":false},"recovery":{"condition":"input-1","seen":[{"fingerprint":"tool.stalled:tool/shell","count":2}]}}}"#).unwrap();
    assert_eq!(State::read(Some(&value)).encode(), value);
}

#[tokio::test]
async fn failures_recover_once_per_fingerprint_and_condition_without_spending_retries() {
    use ycoding_core::session::autonomy::{FailureCause, GoalPhase, GoalWait};
    let store = support::store();
    let service = Service::new(store.client());
    let id = id("ses_one");
    service.set_goal(&id, goal("Ship it")).await.unwrap();
    let cause = || FailureCause {
        fingerprint: "provider.invalid-request:model/fake/model".into(),
        class: "provider.invalid-request".into(),
        unit: "model/fake/model".into(),
    };
    for (condition, expected_count, recovering, rework) in [
        ("input-1", 1, true, 1),
        ("input-1", 2, false, 1),
        ("input-2", 1, true, 2),
    ] {
        let sequence = service.snapshot(&id).unwrap().sequence;
        let applied = service
            .record_failure(&id, sequence, cause(), condition.into())
            .await
            .unwrap();
        let goal = applied.state.goal.unwrap();
        let failure = goal.failure.as_ref().unwrap();
        assert_eq!(
            (failure.count, failure.recovering),
            (expected_count, recovering)
        );
        assert_eq!(
            (goal.rework, goal.no_progress, goal.iteration),
            (Some(rework), 0, 0)
        );
        assert_eq!(
            goal.phase(),
            if recovering {
                GoalPhase::Rework
            } else {
                GoalPhase::Stalled
            }
        );
    }
    let sequence = service.snapshot(&id).unwrap().sequence;
    assert!(
        !service
            .record_failure(&id, sequence - 1, cause(), "stale".into())
            .await
            .unwrap()
            .applied
    );
    service
        .record_wait(&id, sequence, GoalWait::Shell)
        .await
        .unwrap();
    let waiting = service.get(&id).unwrap().goal.unwrap();
    assert_eq!(waiting.phase(), GoalPhase::Waiting);
    assert!(waiting.failure.is_none());
    service.advance(&id).await.unwrap();
    assert!(service.get(&id).unwrap().goal.unwrap().wait.is_none());
    service.record_stall(&id, Some(cause())).await.unwrap();
    service.stop(&id).await.unwrap();
    service.change(&id, GoalChange::Resume).await.unwrap();
    let resumed = service.get(&id).unwrap().goal.unwrap();
    assert!(resumed.failure.is_none() && resumed.recovery.is_none() && resumed.phase.is_none());
    assert_eq!(resumed.stalls, Some(1));
}

#[tokio::test]
async fn rework_keeps_the_latest_sixteen_open_units_without_limiting_rework_count() {
    let store = support::store();
    let service = Service::new(store.client());
    let id = id("ses_one");
    service.set_goal(&id, goal("Ship it")).await.unwrap();
    for index in 0..20 {
        service
            .rework(&id, format!("unit-{index}"), "check failed".into(), true)
            .await
            .unwrap();
    }
    let goal = service.get(&id).unwrap().goal.unwrap();
    assert_eq!(
        (
            goal.rework,
            goal.no_progress,
            goal.rework_open.as_ref().unwrap().len()
        ),
        (Some(20), 0, 16)
    );
    assert_eq!(goal.rework_open.unwrap()[0].unit.as_str(), Some("unit-4"));
}

#[tokio::test]
async fn an_active_goal_grants_no_permission_answer_or_review_authority() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .set_goal(&id("ses_one"), goal("Finish safely"))
        .await
        .unwrap();
    let effective = service.effective(&id("ses_one")).unwrap();
    assert!(effective.goal_active);
    assert!(!effective.can_auto_answer() && !effective.can_yolo_answer());
    assert!(!effective.can_auto_permission() && !effective.can_yolo_permission());
    assert!(!effective.can_auto_guardrail() && !effective.can_yolo_guardrail());
}

#[tokio::test]
async fn snapshot_fences_with_a_revision_and_canonical_digest() {
    let store = support::store();
    let service = Service::new(store.client());
    let initial = service.snapshot(&id("ses_one")).unwrap();
    assert_eq!(initial.state, State::default());
    assert_eq!(initial.sequence, 0);
    assert_eq!(
        initial.digest,
        "da796d527c5b5af9ddb781550beb8caaa302aaeb838f74bb374253f6544dfae3"
    );

    assert_eq!(service.report(&id("ses_one")).await.unwrap(), initial.state);
    assert_eq!(service.snapshot(&id("ses_one")).unwrap(), initial);

    modes::permissions(&service, &id("ses_one"), DecisionMode::Yolo).await;
    let changed = service.snapshot(&id("ses_one")).unwrap();
    assert_eq!(changed.sequence, 1);
    assert_ne!(changed.digest, initial.digest);

    modes::permissions(&service, &id("ses_one"), DecisionMode::Manual).await;
    let back = service.snapshot(&id("ses_one")).unwrap();
    assert_eq!((back.sequence, back.digest), (2, initial.digest));
}

#[tokio::test]
async fn every_report_spends_one_no_progress_attempt_and_advance_neither_spends_nor_resets() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .set_goal(&id("ses_one"), Goal::new("Ship the fix", None, Some(3)))
        .await
        .unwrap();
    let first = service.report(&id("ses_one")).await.unwrap().goal.unwrap();
    assert_eq!(
        (first.status, first.no_progress, first.iteration),
        (GoalStatus::Active, 1, 0)
    );
    let advanced = service.advance(&id("ses_one")).await.unwrap().goal.unwrap();
    assert_eq!((advanced.no_progress, advanced.iteration), (1, 1));
    let second = service.report(&id("ses_one")).await.unwrap().goal.unwrap();
    assert_eq!((second.status, second.no_progress), (GoalStatus::Active, 2));
    let exhausted = service.report(&id("ses_one")).await.unwrap().goal.unwrap();
    assert_eq!(
        (exhausted.status, exhausted.no_progress, exhausted.iteration),
        (GoalStatus::Exhausted, 3, 1)
    );
    let after = service.snapshot(&id("ses_one")).unwrap();
    assert_eq!(service.report(&id("ses_one")).await.unwrap(), after.state);
    assert_eq!(service.complete(&id("ses_one")).await.unwrap(), after.state);
    assert_eq!(
        service.snapshot(&id("ses_one")).unwrap().sequence,
        after.sequence
    );
}

#[tokio::test]
async fn concurrent_reports_serialize_without_losing_an_attempt() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .set_goal(&id("ses_one"), goal("Ship the fix"))
        .await
        .unwrap();
    let session = id("ses_one");
    let (left, right) = tokio::join!(service.report(&session), service.report(&session));
    left.unwrap();
    right.unwrap();
    let snapshot = service.snapshot(&id("ses_one")).unwrap();
    let goal = snapshot.state.goal.unwrap();
    assert_eq!(
        (goal.no_progress, goal.status, snapshot.sequence),
        (2, GoalStatus::Active, 3)
    );
}

#[tokio::test]
async fn terminal_goals_are_retained_through_mode_changes_and_reactivated_only_by_replacement_or_resume()
 {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .set_goal(&id("ses_one"), goal("Ship it"))
        .await
        .unwrap();
    service.complete(&id("ses_one")).await.unwrap();
    let state = modes::permissions(&service, &id("ses_one"), DecisionMode::Yolo).await;
    assert_eq!(state.goal.as_ref().unwrap().status, GoalStatus::Completed);

    let stopped = service.stop(&id("ses_one")).await.unwrap();
    assert_eq!(stopped.goal.as_ref().unwrap().status, GoalStatus::Stopped);
    assert_eq!(
        stopped.goal.as_ref().unwrap().text.as_str(),
        Some("Ship it")
    );

    let resumed = service
        .change(&id("ses_one"), GoalChange::Resume)
        .await
        .unwrap();
    assert_eq!(resumed.goal.as_ref().unwrap().status, GoalStatus::Active);
    assert_eq!(resumed.permissions, DecisionMode::Yolo);

    let replaced = service
        .change(
            &id("ses_one"),
            GoalChange::Replace {
                text: " Ship the follow-up ".into(),
                raw_text: Some("raw".into()),
                max_no_progress: Some(0),
            },
        )
        .await
        .unwrap()
        .goal
        .unwrap();
    assert_eq!(replaced.text.as_str(), Some("Ship the follow-up"));
    assert_eq!(replaced.raw_text.unwrap().as_str(), Some("raw"));
    assert_eq!(
        (
            replaced.iteration,
            replaced.no_progress,
            replaced.max_no_progress
        ),
        (0, 0, 1)
    );
}

#[tokio::test]
async fn resume_without_a_retained_goal_and_unchanged_active_replacement_write_nothing() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .change(&id("ses_one"), GoalChange::Resume)
        .await
        .unwrap();
    assert_eq!(service.snapshot(&id("ses_one")).unwrap().sequence, 0);

    service
        .set_goal(&id("ses_one"), goal("Ship the fix"))
        .await
        .unwrap();
    let before = service.snapshot(&id("ses_one")).unwrap();
    service
        .change(
            &id("ses_one"),
            GoalChange::Replace {
                text: "Ship the fix".into(),
                raw_text: None,
                max_no_progress: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(service.snapshot(&id("ses_one")).unwrap(), before);
}

#[tokio::test]
async fn guarded_calculations_apply_only_at_the_expected_revision_and_stop_fences_a_missing_goal() {
    let store = support::store();
    let service = Service::new(store.client());
    let first = service.snapshot(&id("ses_one")).unwrap();
    let applied = service
        .set_goal_if_current(&id("ses_one"), first.sequence, goal("Calculated"))
        .await
        .unwrap();
    assert!(applied.applied);

    let current = service.snapshot(&id("ses_one")).unwrap();
    service.stop(&id("ses_one")).await.unwrap();
    let stale = service
        .set_goal_if_current(&id("ses_one"), current.sequence, goal("Late"))
        .await
        .unwrap();
    assert!(!stale.applied);
    assert_eq!(stale.state.goal.unwrap().status, GoalStatus::Stopped);

    let other = support::store();
    let fresh = Service::new(other.client());
    let before = fresh.snapshot(&id("ses_one")).unwrap();
    fresh
        .change(&id("ses_one"), GoalChange::Stop)
        .await
        .unwrap();
    let late = fresh
        .set_goal_if_current(&id("ses_one"), before.sequence, goal("Late first goal"))
        .await
        .unwrap();
    assert!(!late.applied);
    assert_eq!(fresh.get(&id("ses_one")).unwrap(), State::default());

    let resumed = service
        .resume_goal_if_current(
            &id("ses_one"),
            service.snapshot(&id("ses_one")).unwrap().sequence,
        )
        .await
        .unwrap();
    assert!(resumed.applied);
    assert_eq!(resumed.state.goal.unwrap().status, GoalStatus::Active);
    assert!(
        !service
            .advance_if_current(&id("ses_one"), 0)
            .await
            .unwrap()
            .applied
    );
}

#[tokio::test]
async fn goal_progress_survives_fifty_one_iterations() {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .set_goal(&id("ses_one"), goal("Ship the fix"))
        .await
        .unwrap();
    for _ in 0..51 {
        service.advance(&id("ses_one")).await.unwrap();
    }
    let goal = service.get(&id("ses_one")).unwrap().goal.unwrap();
    assert_eq!(
        (goal.status, goal.iteration, goal.no_progress),
        (GoalStatus::Active, 51, 0)
    );
}

#[tokio::test]
async fn unknown_sessions_are_not_found_and_corrupt_columns_read_as_the_default_state() {
    let store = support::store();
    let service = Service::new(store.client());
    assert!(matches!(
        service.get(&id("ses_missing")),
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        service.report(&id("ses_missing")).await,
        Err(Error::NotFound(_))
    ));

    for corrupt in [
        r#"{"mode":"normal","yolo":7}"#,
        r#"{"mode":"normal","yolo":true,"autoAnswer":true}"#,
        r#"{"mode":"yolo","permissions":"auto","guardrails":"auto","answers":"auto"}"#,
        r#"{"mode":"normal","permissions":"auto","guardrails":"auto","answers":"auto","goal":{"text":"x","status":"paused","iteration":0,"noProgress":0,"maxNoProgress":3}}"#,
        r#"{"mode":"normal","permissions":"auto","guardrails":"auto","answers":"auto","goal":{"text":"x","status":"active","iteration":0,"noProgress":0,"maxNoProgress":0}}"#,
    ] {
        assert_eq!(
            State::read(Some(&parse_json(corrupt).unwrap())),
            State::default(),
            "{corrupt}"
        );
    }
    assert_eq!(State::read(None), State::default());
}

#[test]
fn terminal_and_active_goals_render_visible_reminders() {
    let state = |status: GoalStatus| State {
        goal: Some(Goal {
            status,
            iteration: 2,
            no_progress: 1,
            ..goal("Finish the bounded task")
        }),
        ..State::default()
    };
    assert_eq!(
        [
            GoalStatus::Completed,
            GoalStatus::Stopped,
            GoalStatus::Exhausted
        ]
        .map(|status| state(status).goal_reminder().unwrap()),
        [
            "Autonomous goal is completed: Finish the bounded task",
            "Autonomous goal is stopped: Finish the bounded task",
            "Autonomous goal is exhausted: Finish the bounded task",
        ]
    );
    let active = state(GoalStatus::Active).goal_reminder().unwrap();
    let lines = active.lines().collect::<Vec<_>>();
    assert_eq!(
        lines[0],
        "Active autonomous goal (iteration 2, noProgress 1/3): Finish the bounded task"
    );
    assert!(lines.contains(&"Automatic answering is disabled for this Session. Resolve choices that need no user input yourself; explicit decisions and required human approval remain manual, and the active goal loop may answer pending routine questions with the Goal agent."));
    assert!(State::default().goal_reminder().is_none());
}

mod continuation {
    use super::{DecisionMode, goal, id, modes, support};
    use std::sync::Mutex;
    use ycoding_core::session::{
        autonomy::{Goal, GoalStatus, Service, Steer, SteerFuture, SteerRequest, continue_goal},
        prompt_cache::sha256,
        store,
    };
    use ycoding_schema::{session_message, stringify_json};

    struct Fixed {
        text: Option<&'static str>,
        stop_during: Option<Service>,
        requests: Mutex<Vec<(u64, Option<String>)>>,
    }

    impl Steer for Fixed {
        fn steer(&self, request: SteerRequest) -> SteerFuture<'_> {
            Box::pin(async move {
                self.requests.lock().unwrap().push((
                    request.goal.iteration,
                    request.latest_assistant_text.clone(),
                ));
                if let Some(service) = &self.stop_during {
                    service.stop(&request.session_id).await.unwrap();
                }
                self.text.map(str::to_owned)
            })
        }
    }

    fn fixed(text: Option<&'static str>) -> Fixed {
        Fixed {
            text,
            stop_during: None,
            requests: Mutex::default(),
        }
    }

    #[tokio::test]
    async fn an_active_goal_admits_one_deterministic_steer_per_iteration_and_advances() {
        let store = support::store();
        let autonomy = Service::new(store.client());
        let sessions = store::Service::new(store.client());
        modes::permissions(&autonomy, &id("ses_one"), DecisionMode::Auto).await;
        autonomy
            .set_goal(&id("ses_one"), goal("Ship it"))
            .await
            .unwrap();
        let steer = fixed(Some("Run the tests next."));

        let first = continue_goal(
            &autonomy,
            &sessions,
            &steer,
            &id("ses_one"),
            Some("Done so far".into()),
            false,
        )
        .await
        .unwrap()
        .unwrap();
        assert!(first.wake);
        let first = first.pending;
        let expected = format!("msg_goal_{}", &sha256("ses_one\u{0}1")[..24]);
        assert_eq!(first.id.as_str(), Some(expected.as_str()));
        assert_eq!(first.type_.as_str(), Some("synthetic"));
        assert_eq!(
            first.delivery.as_ref().and_then(|value| value.as_str()),
            Some("steer")
        );
        let data = stringify_json(&first.data);
        assert!(data.contains("Run the tests next.") && data.contains("Goal · steer"));
        assert!(
            data.contains(r#""autonomy":{"goal":true,"iteration":1}"#),
            "{data}"
        );
        assert_eq!(
            autonomy
                .get(&id("ses_one"))
                .unwrap()
                .goal
                .unwrap()
                .iteration,
            1
        );
        assert!(
            sessions
                .pending(&session_message::Id::new(expected).unwrap())
                .unwrap()
                .is_some()
        );

        let second = continue_goal(&autonomy, &sessions, &steer, &id("ses_one"), None, false)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(second.pending.id, first.id);
        assert_eq!(
            *steer.requests.lock().unwrap(),
            [(0, Some("Done so far".to_owned())), (1, None)]
        );
    }

    #[tokio::test]
    async fn an_open_review_item_pauses_goal_continuation_without_spending_the_budget() {
        let store = support::store();
        let autonomy = Service::new(store.client());
        let sessions = store::Service::new(store.client());
        autonomy
            .set_goal(&id("ses_one"), goal("Ship it"))
            .await
            .unwrap();
        let before = autonomy.get(&id("ses_one")).unwrap();
        store
            .submit(|tx| {
                ycoding_store::session::append(
                    tx,
                    &ycoding_store::session::NewEvent {
                        id: "evt_goal_review_gate".into(),
                        aggregate_id: "ses_one".into(),
                        created: 40,
                        type_: "session.review.deferred.1".into(),
                        data: ycoding_schema::parse_json(
                            r#"{"sessionID":"ses_one","itemID":"rvw_goal_gate","kind":"question","reason":"free_text","origin":{"requestID":"frm_goal_gate"},"payload":{"type":"form","title":"Plan","fields":[{"key":"plan","type":"string","required":true}]}}"#,
                        )
                        .unwrap(),
                    },
                    None,
                )
                .map(|_| ())
            })
            .unwrap()
            .wait()
            .unwrap();
        let steer = fixed(Some("Run the tests next."));

        let held = continue_goal(&autonomy, &sessions, &steer, &id("ses_one"), None, false)
            .await
            .unwrap();

        assert!(held.is_none());
        assert!(steer.requests.lock().unwrap().is_empty());
        assert!(sessions.pending_list(&id("ses_one")).unwrap().is_empty());
        let mut expected = before;
        let goal = expected.goal.as_mut().unwrap();
        goal.phase = Some(ycoding_core::session::autonomy::GoalPhase::Waiting);
        goal.wait = Some(ycoding_core::session::autonomy::GoalWait::Review);
        assert_eq!(autonomy.get(&id("ses_one")).unwrap(), expected);
    }

    #[tokio::test]
    async fn a_goal_steer_is_held_behind_a_staged_revert_without_waking() {
        let store = support::store();
        let autonomy = Service::new(store.client());
        let sessions = store::Service::new(store.client());
        autonomy
            .set_goal(&id("ses_one"), goal("Ship it"))
            .await
            .unwrap();
        support::stage_revert(&sessions, "ses_one").await;
        let steer = fixed(Some("Run the tests next."));

        let held = continue_goal(&autonomy, &sessions, &steer, &id("ses_one"), None, false)
            .await
            .unwrap()
            .unwrap();

        assert!(!held.wake);
        assert!(
            sessions
                .get(&id("ses_one"))
                .unwrap()
                .unwrap()
                .revert
                .is_some()
        );
        assert_eq!(sessions.pending_list(&id("ses_one")).unwrap().len(), 1);
        assert_eq!(
            autonomy
                .get(&id("ses_one"))
                .unwrap()
                .goal
                .unwrap()
                .iteration,
            1
        );
    }

    #[tokio::test]
    async fn continuation_is_skipped_without_an_active_goal_idle_shells_and_a_steer() {
        let store = support::store();
        let autonomy = Service::new(store.client());
        let sessions = store::Service::new(store.client());
        let steer = fixed(Some("next"));
        assert!(
            continue_goal(&autonomy, &sessions, &steer, &id("ses_one"), None, false)
                .await
                .unwrap()
                .is_none()
        );

        autonomy
            .set_goal(&id("ses_one"), goal("Ship it"))
            .await
            .unwrap();
        assert!(
            continue_goal(&autonomy, &sessions, &steer, &id("ses_one"), None, true)
                .await
                .unwrap()
                .is_none()
        );
        assert!(steer.requests.lock().unwrap().is_empty());

        let silent = fixed(None);
        assert!(
            continue_goal(&autonomy, &sessions, &silent, &id("ses_one"), None, false)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            autonomy
                .get(&id("ses_one"))
                .unwrap()
                .goal
                .unwrap()
                .iteration,
            0
        );

        autonomy.complete(&id("ses_one")).await.unwrap();
        assert!(
            continue_goal(&autonomy, &sessions, &steer, &id("ses_one"), None, false)
                .await
                .unwrap()
                .is_none()
        );
        assert!(steer.requests.lock().unwrap().is_empty());
        assert!(sessions.pending_list(&id("ses_one")).unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_goal_stopped_while_the_steer_was_calculated_is_never_continued() {
        let store = support::store();
        let autonomy = Service::new(store.client());
        let sessions = store::Service::new(store.client());
        autonomy
            .set_goal(&id("ses_one"), Goal::new("Ship it", None, None))
            .await
            .unwrap();
        let steer = Fixed {
            text: Some("next"),
            stop_during: Some(autonomy.clone()),
            requests: Mutex::default(),
        };
        assert!(
            continue_goal(&autonomy, &sessions, &steer, &id("ses_one"), None, false)
                .await
                .unwrap()
                .is_none()
        );
        let state = autonomy.get(&id("ses_one")).unwrap().goal.unwrap();
        assert_eq!((state.status, state.iteration), (GoalStatus::Stopped, 0));
        assert!(sessions.pending_list(&id("ses_one")).unwrap().is_empty());
    }
}
