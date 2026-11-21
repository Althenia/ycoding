include!("policy_fixture.rs");
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Waker},
    time::Duration,
};
use ycoding_core::{
    process::guardrails::{Error, Guardrails, Input, Limits, Paths, Reservation, Settings},
    tools::policy::{Effect, Wait},
};
use ycoding_schema::{guardrail, session_id::SessionId};

fn settings(shells: u64) -> Settings {
    Settings {
        paths: Paths {
            workdir: "/workspace/project".into(),
            project: "/workspace/project".into(),
            home: "/home/operator".into(),
            tmpdir: None,
            trusted_paths: vec![],
        },
        global_roots: vec!["/home/operator/.config/ycoding".into()],
        custom: Arc::new(Vec::new),
        enabled: true,
        limits: Limits {
            shells,
            ..Limits::default()
        },
        decide_reviews: false,
        decide_hard_reviews: true,
    }
}

fn shell(session: &SessionId, command: &str, holder: &str) -> Input {
    Input {
        session_id: session.clone(),
        action: "shell".into(),
        resources: vec![command.into()],
        metadata: None,
        skip_review: false,
        holder: Some(holder.into()),
        source: None,
    }
}

fn guardrails(fixture: &Fixture, shells: u64) -> Guardrails {
    Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(shells),
        fixture.publisher(),
    )
}

fn shells(service: &Guardrails, session: &SessionId) -> i64 {
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

fn assert_pending(wait: &mut (impl Future + Unpin)) {
    assert!(
        Pin::new(wait)
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
}

async fn granted(wait: Wait<Result<Reservation, Error>>) -> Reservation {
    tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .expect("the released shell slot must reach its waiter")
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn shell_admission_reserves_the_root_family_slot_and_waits_without_reserving_another() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let child = fixture.session("ses_child", Some("ses_root"), 0, false, None);
    let other = fixture.session("ses_other", None, 0, false, None);
    let service = guardrails(&fixture, 1);
    let running = service
        .assert(shell(&child, "pwd", "call_running"))
        .unwrap()
        .reservation
        .expect("a child reserves its root family's slot immediately");
    assert_eq!(shells(&service, &root), 1);
    let waiting = service.assert(shell(&root, "pwd", "call_waiting")).unwrap();
    assert_eq!(waiting.effect, Effect::Allow);
    assert!(waiting.request.is_none() && waiting.reservation.is_none());
    let mut wait = waiting.wait.unwrap();
    assert_pending(&mut wait);
    assert_eq!(shells(&service, &child), 1);
    let independent = service
        .assert(shell(&other, "pwd", "call_independent"))
        .unwrap()
        .reservation
        .expect("another root family has its own cap");
    running.release();
    let next = granted(wait).await;
    assert_eq!(shells(&service, &root), 1);
    next.release();
    assert_eq!(shells(&service, &root), 0);
    assert_eq!(shells(&service, &other), 1);
    independent.release();
}

#[tokio::test]
async fn cloned_reservations_release_once_and_drop_returns_only_the_owned_slot() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = guardrails(&fixture, 2);
    let held = service
        .assert(shell(&root, "pwd", "call_held"))
        .unwrap()
        .reservation
        .unwrap();
    let released = service
        .assert(shell(&root, "pwd", "call_released"))
        .unwrap()
        .reservation
        .unwrap();
    let clone = released.clone();
    released.release();
    released.release();
    clone.release();
    assert_eq!(shells(&service, &root), 1);
    let refill = service
        .assert(shell(&root, "pwd", "call_refill"))
        .unwrap()
        .reservation
        .unwrap();
    drop(released);
    drop(clone);
    assert_eq!(shells(&service, &root), 2);
    let mut wait = service
        .assert(shell(&root, "pwd", "call_waiting"))
        .unwrap()
        .wait
        .expect("repeated release cannot create a phantom free slot");
    let clone = refill.clone();
    drop(refill);
    assert_pending(&mut wait);
    drop(clone);
    let next = granted(wait).await;
    assert_eq!(shells(&service, &root), 2);
    drop(next);
    assert_eq!(shells(&service, &root), 1);
    held.release();
    assert_eq!(shells(&service, &root), 0);
}

#[tokio::test]
async fn cancelled_waiters_and_dropped_unpolled_grants_pass_the_slot_to_the_next_waiter() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = guardrails(&fixture, 1);
    let running = service
        .assert(shell(&root, "pwd", "call_running"))
        .unwrap()
        .reservation
        .unwrap();
    let cancelled = service
        .assert(shell(&root, "pwd", "call_cancelled"))
        .unwrap()
        .wait
        .unwrap();
    let unpolled = service
        .assert(shell(&root, "pwd", "call_unpolled"))
        .unwrap()
        .wait
        .unwrap();
    let mut last = service
        .assert(shell(&root, "pwd", "call_last"))
        .unwrap()
        .wait
        .unwrap();
    drop(cancelled);
    assert_eq!(shells(&service, &root), 1);
    running.release();
    assert_pending(&mut last);
    assert_eq!(shells(&service, &root), 1);
    drop(unpolled);
    let last = granted(last).await;
    assert_eq!(shells(&service, &root), 1);
    last.release();
    assert_eq!(shells(&service, &root), 0);
}

#[tokio::test]
async fn an_approved_shell_review_waits_for_capacity_and_only_its_family_can_approve_it() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let child = fixture.session("ses_child", Some("ses_root"), 0, false, None);
    let other = fixture.session("ses_other", None, 0, false, None);
    let service = guardrails(&fixture, 1);
    let running = service
        .assert(shell(&root, "pwd", "call_running"))
        .unwrap()
        .reservation
        .unwrap();
    let reviewed = service
        .assert(shell(&child, "touch /outside/file", "call_reviewed"))
        .unwrap();
    assert_eq!(reviewed.effect, Effect::Ask);
    let request = reviewed.request.unwrap();
    let mut wait = reviewed.wait.unwrap();
    assert!(matches!(
        service.reply(&other, &request.id, guardrail::Reply::Once),
        Err(Error::NotFound)
    ));
    assert_pending(&mut wait);
    assert_eq!(service.for_session(&root).unwrap().len(), 1);
    service
        .reply(&root, &request.id, guardrail::Reply::Once)
        .unwrap();
    assert_pending(&mut wait);
    assert!(service.for_session(&root).unwrap().is_empty());
    assert_eq!(shells(&service, &root), 1);
    running.release();
    let approved = granted(wait).await;
    assert_eq!(shells(&service, &root), 1);
    approved.release();
    assert_eq!(shells(&service, &root), 0);
}

#[tokio::test]
async fn cancelling_an_approved_review_waiter_preserves_the_running_slot_and_later_admission() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = guardrails(&fixture, 1);
    let running = service
        .assert(shell(&root, "pwd", "call_running"))
        .unwrap()
        .reservation
        .unwrap();
    let reviewed = service
        .assert(shell(&root, "touch /outside/file", "call_reviewed"))
        .unwrap();
    let request = reviewed.request.unwrap();
    let mut wait = reviewed.wait.unwrap();
    service
        .reply(&root, &request.id, guardrail::Reply::Once)
        .unwrap();
    assert_pending(&mut wait);
    service.cancel(&request.id);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .unwrap()
            .is_err()
    );
    assert_eq!(shells(&service, &root), 1);
    running.release();
    assert_eq!(shells(&service, &root), 0);
    service
        .assert(shell(&root, "pwd", "call_next"))
        .unwrap()
        .reservation
        .expect("cancelling review admission leaves no stale waiter")
        .release();
}

#[tokio::test]
async fn a_failed_admission_event_releases_the_reserved_shell_slot() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(1),
        Arc::new(|_| Err("event publication failed".into())),
    );
    for holder in ["call_first", "call_second"] {
        assert!(matches!(
            service.assert(shell(&root, "pwd", holder)),
            Err(Error::Publish(_))
        ));
        assert_eq!(shells(&service, &root), 0);
    }
}
