use ycoding_core::session::autonomy::{
    Error, Goal, GoalChange, GoalStatus, ReviewKind, Service, State, YoloLevel,
};
use ycoding_schema::{JsonValue, parse_json, session};
use ycoding_store::session::SessionTable;

#[path = "autonomy_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn yolo(level: u8) -> YoloLevel {
    YoloLevel::new(level).unwrap()
}

fn goal(text: &str) -> Goal {
    Goal::new(text, None, None)
}

fn stored(store: &ycoding_store::Store) -> Option<JsonValue> {
    store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
        ]))
        .unwrap()
        .unwrap()
        .autonomy
}

#[tokio::test]
async fn yolo_ladder_grants_permissions_at_one_and_reviews_at_two_but_never_answers() {
    for level in 0..=2u8 {
        let store = support::store();
        let service = Service::new(store.client());
        let state = service.set_yolo(&id("ses_one"), yolo(level)).await.unwrap();
        let effective = state.effective();
        assert!(!effective.can_auto_answer(), "answer at {level}");
        assert_eq!(
            effective.can_auto_permission(),
            level >= 1,
            "permission at {level}"
        );
        assert_eq!(
            effective.can_auto_guardrail(),
            level >= 2,
            "guardrail at {level}"
        );
        let expected = parse_json(&format!(r#"{{"mode":"normal","yolo":{level}}}"#)).unwrap();
        assert_eq!(stored(&store), (level > 0).then_some(expected));
        assert_eq!(
            service.effective(&id("ses_one")).unwrap(),
            effective,
            "store-backed policy at {level}"
        );
    }
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
    assert!(!effective.can_auto_answer());
    assert!(!effective.can_auto_permission());
    assert!(!effective.can_auto_guardrail());
    assert!(!effective.can_auto_review(ReviewKind::Ordinary));
}

#[tokio::test]
async fn hard_reviews_stay_human_only_at_every_level_with_or_without_a_goal() {
    for level in 0..=2u8 {
        let state = State {
            yolo: yolo(level),
            goal: Some(goal("Ship")),
            sleep: false,
            auto_answer: Some(true),
        };
        assert!(
            !state.effective().can_auto_review(ReviewKind::Hard),
            "hard at {level}"
        );
        assert_eq!(
            state.effective().can_auto_review(ReviewKind::Ordinary),
            level >= 2,
            "ordinary at {level}"
        );
    }
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
        "7bca8b42480222ddfa0cf4adc95073d9b40726221d52a79b4c55ef354dec7b52"
    );

    assert_eq!(service.report(&id("ses_one")).await.unwrap(), initial.state);
    assert_eq!(service.snapshot(&id("ses_one")).unwrap(), initial);

    service.set_yolo(&id("ses_one"), yolo(2)).await.unwrap();
    let changed = service.snapshot(&id("ses_one")).unwrap();
    assert_eq!(changed.sequence, 1);
    assert_ne!(changed.digest, initial.digest);

    service.set_yolo(&id("ses_one"), yolo(0)).await.unwrap();
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
async fn terminal_goals_are_retained_through_yolo_changes_and_reactivated_only_by_replacement_or_resume()
 {
    let store = support::store();
    let service = Service::new(store.client());
    service
        .set_goal(&id("ses_one"), goal("Ship it"))
        .await
        .unwrap();
    service.complete(&id("ses_one")).await.unwrap();
    let state = service.set_yolo(&id("ses_one"), yolo(2)).await.unwrap();
    assert_eq!(state.goal.as_ref().unwrap().status, GoalStatus::Completed);

    let stopped = service.stop(&id("ses_one")).await.unwrap();
    assert_eq!(stopped.goal.as_ref().unwrap().status, GoalStatus::Stopped);
    assert_eq!(
        stopped.goal.as_ref().unwrap().text.as_str(),
        Some("Ship it")
    );

    let resumed = service
        .change(&id("ses_one"), None, Some(GoalChange::Resume))
        .await
        .unwrap();
    assert_eq!(resumed.goal.as_ref().unwrap().status, GoalStatus::Active);
    assert_eq!(resumed.yolo, yolo(2));

    let replaced = service
        .change(
            &id("ses_one"),
            None,
            Some(GoalChange::Replace {
                text: " Ship the follow-up ".into(),
                raw_text: Some("raw".into()),
                max_no_progress: Some(0),
            }),
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
        .change(&id("ses_one"), None, Some(GoalChange::Resume))
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
            None,
            Some(GoalChange::Replace {
                text: "Ship the fix".into(),
                raw_text: None,
                max_no_progress: None,
            }),
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
        .set_goal_if_current(
            &id("ses_one"),
            first.sequence,
            Some(yolo(1)),
            goal("Calculated"),
        )
        .await
        .unwrap();
    assert!(applied.applied);
    assert_eq!(applied.state.yolo, yolo(1));

    let current = service.snapshot(&id("ses_one")).unwrap();
    service.stop(&id("ses_one")).await.unwrap();
    let stale = service
        .set_goal_if_current(
            &id("ses_one"),
            current.sequence,
            Some(yolo(2)),
            goal("Late"),
        )
        .await
        .unwrap();
    assert!(!stale.applied);
    assert_eq!(stale.state.yolo, yolo(1));
    assert_eq!(stale.state.goal.unwrap().status, GoalStatus::Stopped);

    let other = support::store();
    let fresh = Service::new(other.client());
    let before = fresh.snapshot(&id("ses_one")).unwrap();
    fresh
        .change(&id("ses_one"), None, Some(GoalChange::Stop))
        .await
        .unwrap();
    let late = fresh
        .set_goal_if_current(
            &id("ses_one"),
            before.sequence,
            None,
            goal("Late first goal"),
        )
        .await
        .unwrap();
    assert!(!late.applied);
    assert_eq!(fresh.get(&id("ses_one")).unwrap(), State::default());

    let resumed = service
        .resume_goal_if_current(
            &id("ses_one"),
            service.snapshot(&id("ses_one")).unwrap().sequence,
            None,
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
        r#"{"mode":"yolo","yolo":1}"#,
        r#"{"mode":"normal","yolo":1,"goal":{"text":"x","status":"paused","iteration":0,"noProgress":0,"maxNoProgress":3}}"#,
        r#"{"mode":"normal","yolo":1,"goal":{"text":"x","status":"active","iteration":0,"noProgress":0,"maxNoProgress":0}}"#,
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
        yolo: yolo(0),
        goal: Some(Goal {
            status,
            iteration: 2,
            no_progress: 1,
            ..goal("Finish the bounded task")
        }),
        sleep: false,
        auto_answer: None,
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
    assert!(lines.contains(&"Automatic answering is disabled for this Session. Resolve choices that need no user input yourself; required answers and required human approval remain manual."));
    assert!(State::default().goal_reminder().is_none());
}

mod continuation {
    use super::{goal, id, support, yolo};
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
        autonomy.set_yolo(&id("ses_one"), yolo(1)).await.unwrap();
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
            data.contains(r#""autonomy":{"yolo":1,"goal":true,"iteration":1}"#),
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
        assert_eq!(autonomy.get(&id("ses_one")).unwrap(), before);
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
