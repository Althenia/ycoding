use ycoding_protocol::connection::{ProtocolError, ReservationBudget};

#[test]
fn ac_wire_007_shared_reservation_retains_exact_bytes_until_release() {
    let mut budget = ReservationBudget::new(100).unwrap();
    assert!(budget.reserve(60));
    assert_eq!(budget.used(), 60);
    assert!(!budget.reserve(41));
    assert_eq!(budget.used(), 60);
    budget.release(60).unwrap();
    assert_eq!(budget.used(), 0);
}

#[test]
fn ac_wire_007_reservation_table_cannot_overrun_underflow_or_overflow() {
    for limit in [1, 64, 1048576, u64::MAX] {
        let mut budget = ReservationBudget::new(limit).unwrap();
        assert!(budget.reserve(limit));
        assert!(!budget.reserve(1));
        assert_eq!(budget.release(limit), Ok(()));
        assert_eq!(budget.release(1), Err(ProtocolError::Limit));
        assert_eq!(budget.used(), 0);
    }
}
