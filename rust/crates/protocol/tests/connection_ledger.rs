use ycoding_protocol::connection::{Ledger, LedgerError};

#[test]
fn ac_wire_008_send_never_consumes_credit() {
    let mut ledger = Ledger::new(100);
    assert_eq!(ledger.hand(60, 0), Ok(1));
    assert_eq!(ledger.available(), 40);
    assert_eq!(ledger.hand(41, 1), Err(LedgerError::Exhausted));
    assert_eq!(ledger.credit(1), Ok(60));
    assert_eq!(ledger.available(), 100);
}

#[test]
fn ac_wire_008_credit_prefix_never_crosses_owner() {
    for size in 1..=32 {
        let mut owner = Ledger::new(64);
        let mut other = Ledger::new(64);
        owner.hand(size, 0).unwrap();
        other.hand(size, 0).unwrap();
        assert_eq!(owner.credit(2), Err(LedgerError::Ordinal));
        assert_eq!(owner.credit(1), Ok(size));
        assert_eq!(owner.credit(1), Err(LedgerError::Ordinal));
        assert_eq!(other.available(), 64 - size);
    }
}

#[test]
fn ac_wire_008_table_credit_and_receipt_never_overgrant_or_go_negative() {
    for window in 1..=80 {
        for first in 1..=window {
            let mut ledger = Ledger::new(window);
            ledger.hand(first, 0).unwrap();
            let second = window - first;
            if second > 0 {
                ledger.hand(second, 1).unwrap();
            }
            assert_eq!(
                ledger.available(),
                if second > 0 { 0 } else { window - first }
            );
            assert_eq!(ledger.hand(1, 2), Err(LedgerError::Exhausted));
            assert_eq!(ledger.credit(0), Err(LedgerError::Ordinal));
            assert_eq!(ledger.credit(3), Err(LedgerError::Ordinal));
            assert_eq!(ledger.credit(1), Ok(first));
            assert_eq!(ledger.receipt(1), Ok(0));
            assert_eq!(ledger.receipt(0), Err(LedgerError::Ordinal));
            if second > 0 {
                assert_eq!(ledger.credit(2), Ok(second));
            }
            assert_eq!(ledger.available(), window);
            assert_eq!(ledger.outstanding_bytes(), 0);
        }
    }
}

#[test]
fn ac_wire_008_empty_records_cannot_bypass_the_byte_bound() {
    let mut ledger = Ledger::new(u64::MAX);
    assert_eq!(ledger.hand(0, 0), Err(LedgerError::Exhausted));
    assert_eq!(ledger.outstanding_count(), 0);
    assert_eq!(ledger.hand(u64::MAX, 0), Ok(1));
    assert_eq!(ledger.available(), 0);
    assert!(!ledger.expired(29999, 30000));
    assert!(ledger.expired(30000, 30000));
    assert_eq!(ledger.credit(1), Ok(u64::MAX));
}
