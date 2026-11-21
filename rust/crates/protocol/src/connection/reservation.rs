use super::ProtocolError;
use std::{cell::RefCell, rc::Rc};

pub type SharedReservation = Rc<RefCell<ReservationBudget>>;

#[derive(Debug)]
pub struct ReservationBudget {
    limit: u64,
    used: u64,
}

impl ReservationBudget {
    pub fn new(limit: u64) -> Result<Self, ProtocolError> {
        if limit == 0 {
            return Err(ProtocolError::Limit);
        }
        Ok(Self { limit, used: 0 })
    }

    pub fn limit(&self) -> u64 {
        self.limit
    }
    pub fn used(&self) -> u64 {
        self.used
    }
    pub fn reserve(&mut self, bytes: u64) -> bool {
        if bytes > self.limit - self.used {
            return false;
        }
        self.used += bytes;
        true
    }
    pub fn release(&mut self, bytes: u64) -> Result<(), ProtocolError> {
        if bytes > self.used {
            return Err(ProtocolError::Limit);
        }
        self.used -= bytes;
        Ok(())
    }
}
