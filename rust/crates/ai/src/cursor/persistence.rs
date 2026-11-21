use super::provider::Snapshot;
use std::{future::Future, pin::Pin};
use ycoding_schema::LosslessString;

#[derive(Clone, Debug, PartialEq)]
pub enum Loaded {
    Restored(Snapshot),
    Missing,
    Expired,
    Invalid,
}
pub trait Store: Send + Sync {
    fn load<'a>(
        &'a self,
        session_key: &'a LosslessString,
    ) -> Pin<Box<dyn Future<Output = Loaded> + Send + 'a>>;
    fn save<'a>(
        &'a self,
        session_key: &'a LosslessString,
        snapshot: &'a Snapshot,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}
