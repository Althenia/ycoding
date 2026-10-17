include!("policy_fixture.rs");
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use ycoding_core::{
    process::guardrails::{Guardrails, Input, Limits, Paths, Settings},
    tools::policy::Effect,
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

fn shell(session: &SessionId, command: &str, deferred: bool, holder: &str) -> Input {
    Input {
        session_id: session.clone(),
        action: "shell".into(),
        resources: vec![command.into()],
        metadata: None,
        skip_review: false,
        holder: Some(holder.into()),
        defer_shell: deferred,
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

fn counter() -> (Arc<AtomicUsize>, Arc<dyn Fn() + Send + Sync>) {
    let count = Arc::new(AtomicUsize::new(0));
    let wake = {
        let count = count.clone();
        Arc::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
        }) as Arc<dyn Fn() + Send + Sync>
    };
    (count, wake)
}

#[tokio::test]
async fn a_deferred_shell_is_admitted_without_a_slot_waiter_or_cap_error_while_the_pool_is_full() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = guardrails(&fixture, 1);
    let running = service
        .assert(shell(&root, "pwd", false, "call_running"))
        .unwrap();
    let running = running
        .reservation
        .expect("ordinary shell reserves the only slot");
    assert!(running.shell_admission().is_none());

    let queued = service
        .assert(shell(&root, "pwd", true, "call_queued"))
        .unwrap();
    assert_eq!(queued.effect, Effect::Allow);
    assert!(queued.wait.is_none());
    let reservation = queued
        .reservation
        .expect("deferred shell returns a reservation immediately");
    let admission = reservation
        .shell_admission()
        .expect("deferred shell exposes queue admission");
    assert_eq!(admission.family(), "ses_root");
    assert!(admission.acquire().is_none());

    let ordinary = service
        .assert(shell(&root, "pwd", false, "call_ordinary"))
        .unwrap();
    assert!(ordinary.reservation.is_none());
    assert!(ordinary.wait.is_some());
    drop(ordinary);
    running.release();
    reservation.release();
    reservation.release();
}

#[tokio::test]
async fn queue_acquisition_claims_and_commits_one_family_slot_and_the_outer_release_returns_it() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let child = fixture.session("ses_child", Some("ses_root"), 0, false, None);
    let service = guardrails(&fixture, 1);
    let reservation = service
        .assert(shell(&child, "pwd", true, "call_queued"))
        .unwrap()
        .reservation
        .unwrap();
    let admission = reservation.shell_admission().unwrap();
    assert_eq!(admission.family(), "ses_root");
    let claim = admission
        .acquire()
        .expect("an empty family pool grants the claim");
    assert!(admission.acquire().is_none());
    let blocked = service
        .assert(shell(&root, "pwd", false, "call_blocked"))
        .unwrap();
    assert!(blocked.wait.is_some());
    drop(blocked);
    claim.commit();
    assert!(admission.acquire().is_none());
    reservation.release();
    let next = service
        .assert(shell(&root, "pwd", false, "call_next"))
        .unwrap();
    next.reservation
        .expect("the outer release returned the committed slot")
        .release();
    reservation.release();
}

#[tokio::test]
async fn releasing_an_uncommitted_claim_frees_the_slot_without_waking_subscribers() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = guardrails(&fixture, 1);
    let reservation = service
        .assert(shell(&root, "pwd", true, "call_queued"))
        .unwrap()
        .reservation
        .unwrap();
    let admission = reservation.shell_admission().unwrap();
    let (woken, wake) = counter();
    let unsubscribe = admission.subscribe(wake);
    let claim = admission.acquire().unwrap();
    claim.release();
    assert_eq!(woken.load(Ordering::SeqCst), 0);
    admission
        .acquire()
        .expect("an uncommitted release frees the slot")
        .release();
    assert_eq!(woken.load(Ordering::SeqCst), 0);
    unsubscribe();
    reservation.release();
}

#[tokio::test]
async fn claim_commit_and_release_are_idempotent_and_never_free_a_slot_twice() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = guardrails(&fixture, 2);
    let held = service
        .assert(shell(&root, "pwd", false, "call_held"))
        .unwrap()
        .reservation
        .unwrap();
    let reservation = service
        .assert(shell(&root, "pwd", true, "call_queued"))
        .unwrap()
        .reservation
        .unwrap();
    let admission = reservation.shell_admission().unwrap();
    let (woken, wake) = counter();
    let unsubscribe = admission.subscribe(wake);

    let failed = admission.acquire().unwrap();
    failed.release();
    failed.release();
    failed.commit();
    assert_eq!(woken.load(Ordering::SeqCst), 0);

    let claim = admission.acquire().unwrap();
    claim.commit();
    claim.commit();
    assert!(admission.acquire().is_none());
    claim.release();
    reservation.release();
    claim.release();
    reservation.release();
    assert_eq!(woken.load(Ordering::SeqCst), 1);

    let refill = service
        .assert(shell(&root, "pwd", false, "call_refill"))
        .unwrap()
        .reservation
        .expect("the committed slot returned exactly once");
    let full = service
        .assert(shell(&root, "pwd", false, "call_full"))
        .unwrap();
    assert!(
        full.reservation.is_none() && full.wait.is_some(),
        "a double release must not leave a phantom free slot"
    );
    drop(full);
    refill.release();
    held.release();
    unsubscribe();
}

#[tokio::test]
async fn a_running_slot_release_wakes_subscribers_outside_the_state_lock_after_ordinary_waiters() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = guardrails(&fixture, 1);
    let running = service
        .assert(shell(&root, "pwd", false, "call_running"))
        .unwrap()
        .reservation
        .unwrap();
    let ordinary = service
        .assert(shell(&root, "pwd", false, "call_waiting"))
        .unwrap();
    let ordinary = ordinary
        .wait
        .expect("the ordinary shell waits for the full pool");
    let reservation = service
        .assert(shell(&root, "pwd", true, "call_queued"))
        .unwrap()
        .reservation
        .unwrap();
    let admission = reservation.shell_admission().unwrap();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let wake = {
        let admission = admission.clone();
        let observed = observed.clone();
        Arc::new(move || {
            let claim = admission.acquire();
            observed.lock().unwrap().push(claim.is_some());
            if let Some(claim) = claim {
                claim.release();
            }
        }) as Arc<dyn Fn() + Send + Sync>
    };
    let unsubscribe = admission.subscribe(wake);
    tokio::time::timeout(Duration::from_secs(5), async { running.release() })
        .await
        .expect("a wake that acquires must not deadlock on the state lock");
    let granted = tokio::time::timeout(Duration::from_secs(5), ordinary)
        .await
        .unwrap()
        .unwrap()
        .expect("the ordinary waiter keeps priority for the released slot");
    assert_eq!(*observed.lock().unwrap(), [false]);
    granted.release();
    assert_eq!(*observed.lock().unwrap(), [false, true]);
    unsubscribe();
    let (woken, wake) = counter();
    let unsubscribe = admission.subscribe(wake);
    unsubscribe();
    let again = service
        .assert(shell(&root, "pwd", false, "call_again"))
        .unwrap()
        .reservation
        .unwrap();
    again.release();
    assert_eq!(woken.load(Ordering::SeqCst), 0);
    assert_eq!(observed.lock().unwrap().len(), 2);
    reservation.release();
}

#[tokio::test]
async fn an_approved_deferred_shell_review_yields_a_queue_reservation_even_while_the_pool_is_full()
{
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    let service = guardrails(&fixture, 1);
    let running = service
        .assert(shell(&root, "pwd", false, "call_running"))
        .unwrap()
        .reservation
        .unwrap();
    let reviewed = service
        .assert(shell(&root, "touch /outside/queued", true, "call_reviewed"))
        .unwrap();
    assert_eq!(reviewed.effect, Effect::Ask);
    let request = reviewed.request.unwrap();
    service
        .reply(&root, &request.id, guardrail::Reply::Once)
        .unwrap();
    let reservation = tokio::time::timeout(Duration::from_secs(5), reviewed.wait.unwrap())
        .await
        .expect("approval must not wait for a shell slot")
        .unwrap()
        .unwrap();
    let admission = reservation
        .shell_admission()
        .expect("approval yields a deferred reservation");
    assert!(admission.acquire().is_none());
    running.release();
    admission
        .acquire()
        .expect("the released slot is claimable")
        .commit();
    reservation.release();
}
