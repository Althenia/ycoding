use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerError {
    Exhausted,
    Ordinal,
    Overflow,
}

pub struct Ledger {
    window: u64,
    handed: BTreeMap<u64, (u64, u64)>,
    next: u64,
    consumed: u64,
}

impl Ledger {
    pub fn new(window: u64) -> Self {
        Self {
            window,
            handed: BTreeMap::new(),
            next: 1,
            consumed: 0,
        }
    }

    pub fn hand(&mut self, bytes: u64, now_ms: u64) -> Result<u64, LedgerError> {
        if bytes == 0 || bytes > self.available() {
            return Err(LedgerError::Exhausted);
        }
        let ordinal = self.next;
        self.next = self.next.checked_add(1).ok_or(LedgerError::Overflow)?;
        self.handed.insert(ordinal, (bytes, now_ms));
        Ok(ordinal)
    }

    pub fn credit(&mut self, through: u64) -> Result<u64, LedgerError> {
        if through <= self.consumed || through >= self.next {
            return Err(LedgerError::Ordinal);
        }
        let freed = self
            .handed
            .range(..=through)
            .map(|(_, value)| value.0)
            .sum();
        self.handed.retain(|ordinal, _| *ordinal > through);
        self.consumed = through;
        Ok(freed)
    }

    pub fn available(&self) -> u64 {
        self.window - self.handed.values().map(|value| value.0).sum::<u64>()
    }

    pub fn next_ordinal(&self) -> u64 {
        self.next
    }

    pub fn outstanding_count(&self) -> usize {
        self.handed.len()
    }

    pub fn outstanding_bytes(&self) -> u64 {
        self.window - self.available()
    }

    pub fn expired(&self, now_ms: u64, timeout_ms: u64) -> bool {
        self.handed
            .first_key_value()
            .is_some_and(|(_, value)| now_ms.saturating_sub(value.1) >= timeout_ms)
    }

    pub fn receipt(&mut self, through: u64) -> Result<u64, LedgerError> {
        if through == self.consumed {
            return Ok(0);
        }
        self.credit(through)
    }
}
