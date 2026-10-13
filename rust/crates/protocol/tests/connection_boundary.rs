use std::{cell::RefCell, collections::BTreeSet, rc::Rc};
use ycoding_protocol::connection::{
    Budgets, Config, Connection, Decision, ProtocolError, ReservationBudget,
};
use ycoding_protocol::{OPERATIONS, limits, v5};

fn connection(budget: Rc<RefCell<ReservationBudget>>) -> Connection {
    Connection::new(
        Config {
            local_role: v5::PeerRole::LocalClient,
            peer_role: v5::PeerRole::Server,
            source_epoch: "source".into(),
            connection_epoch: "epoch".into(),
            budgets: Budgets::default(),
            authorized_sessions: BTreeSet::new(),
            authorized_workspaces: BTreeSet::new(),
            reservation: Some(budget),
            event_types: BTreeSet::new(),
        },
        OPERATIONS.clone(),
        0,
    )
    .unwrap()
}

#[test]
fn oversize_admission_refuses_before_decode_and_retains_nothing() {
    let budget = Rc::new(RefCell::new(ReservationBudget::new(10000000).unwrap()));
    let mut machine = connection(budget.clone());
    let mut decoded = false;
    if let Some(token) = machine.admit_incoming(limits::SERVER_FRAME_BYTES + 1) {
        decoded = true;
        machine.reject_incoming(&token).unwrap();
    }
    assert!(!decoded);
    assert_eq!(budget.borrow().used(), 0);
    assert!(
        machine.take_decisions().iter().any(
            |d| matches!(d, Decision::Closed(close) if close.category == ProtocolError::Limit)
        )
    );
}

#[test]
fn decoding_failure_releases_exact_admission_reservation() {
    let budget = Rc::new(RefCell::new(ReservationBudget::new(10000000).unwrap()));
    let mut machine = connection(budget.clone());
    let token = machine.admit_incoming(100).unwrap();
    assert_eq!(budget.borrow().used(), 100);
    assert!(
        machine
            .reject_incoming(&token)
            .unwrap()
            .iter()
            .any(|d| matches!(d, Decision::Closed(_)))
    );
    assert_eq!(budget.borrow().used(), 0);
}

#[test]
fn preparing_a_frame_neither_transmits_nor_releases_queue_reservation() {
    let budget = Rc::new(RefCell::new(ReservationBudget::new(10000000).unwrap()));
    let mut machine = connection(budget.clone());
    machine.start(0).unwrap();
    assert_eq!(budget.borrow().used(), limits::HANDSHAKE_BYTES);
    let prepared = machine.prepare_handoff(0).unwrap();
    assert!(prepared.frame().delivery_ordinal.is_none());
    assert_eq!(budget.borrow().used(), limits::HANDSHAKE_BYTES);
    machine.abort_prepared(prepared).unwrap();
    assert_eq!(budget.borrow().used(), limits::HANDSHAKE_BYTES);
}

#[test]
fn aggregate_refusal_releases_only_the_failing_connections_ownership() {
    let budget = Rc::new(RefCell::new(ReservationBudget::new(150).unwrap()));
    let mut first = connection(budget.clone());
    let mut second = connection(budget.clone());
    let token = first.admit_incoming(80).unwrap();
    assert!(second.admit_incoming(80).is_none());
    assert_eq!(budget.borrow().used(), 80);
    first.reject_incoming(&token).unwrap();
    assert_eq!(budget.borrow().used(), 0);
}

#[test]
fn foreign_and_used_tokens_cannot_release_another_admission() {
    let budget = Rc::new(RefCell::new(ReservationBudget::new(150).unwrap()));
    let mut first = connection(budget.clone());
    let mut second = connection(budget.clone());
    let token = first.admit_incoming(80).unwrap();
    assert_eq!(second.reject_incoming(&token), Err(ProtocolError::Unknown));
    assert_eq!(budget.borrow().used(), 80);
    first.reject_incoming(&token).unwrap();
    assert_eq!(first.reject_incoming(&token), Err(ProtocolError::Unknown));
    assert_eq!(budget.borrow().used(), 0);
}

#[test]
fn rejected_decoded_frames_and_stale_authority_release_all_owned_admissions() {
    for stale in [false, true] {
        let budget = Rc::new(RefCell::new(ReservationBudget::new(150).unwrap()));
        let mut machine = connection(budget.clone());
        let token = machine.admit_incoming(80).unwrap();
        machine.admit_incoming(30).unwrap();
        if stale {
            machine.update_authority(1, true, 0, 4403).unwrap();
        }
        let decisions = machine
            .accept_incoming(&token, v5::Frame::default(), 0)
            .unwrap();
        assert!(decisions.iter().any(|d| matches!(d, Decision::Closed(_))));
        assert_eq!(budget.borrow().used(), 0);
        assert_eq!(machine.stats().admitted_bytes, 0);
        assert_eq!(machine.stats().retained_bytes, 0);
    }
}

#[test]
fn dropping_a_connection_releases_its_reservations_without_refunding_other_owners() {
    let budget = Rc::new(RefCell::new(ReservationBudget::new(150).unwrap()));
    let mut first = connection(budget.clone());
    let mut second = connection(budget.clone());
    first.admit_incoming(80).unwrap();
    let token = second.admit_incoming(30).unwrap();
    drop(first);
    assert_eq!(budget.borrow().used(), 30);
    second.reject_incoming(&token).unwrap();
    assert_eq!(budget.borrow().used(), 0);
}

#[test]
fn oversize_handoff_and_expired_preparation_release_all_owned_bytes() {
    for expired in [false, true] {
        let budget = Rc::new(RefCell::new(ReservationBudget::new(100000).unwrap()));
        let mut machine = connection(budget.clone());
        machine.start(0).unwrap();
        let token = machine.prepare_handoff(0).unwrap();
        let decisions = machine
            .handoff(
                token,
                limits::HANDSHAKE_BYTES + 1,
                if expired { 5000 } else { 0 },
            )
            .unwrap();
        assert!(decisions.iter().any(|d| matches!(d, Decision::Closed(_))));
        assert_eq!(budget.borrow().used(), 0);
        assert_eq!(machine.stats().prepared_bytes, 0);
        assert_eq!(machine.stats().queued_bytes, [0; 4]);
    }
}
