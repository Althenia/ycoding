use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    sync::{LazyLock, Mutex, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};
use ycoding_core::ycoding_schema::{
    DecodeError, LosslessString, event, identifier::Generator, session,
};

static GENERATOR: LazyLock<Mutex<Generator>> = LazyLock::new(|| Mutex::new(Generator::default()));

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

pub fn event_id() -> Result<event::Id, DecodeError> {
    let mut generator = GENERATOR.lock().unwrap_or_else(PoisonError::into_inner);
    event::Id::create(&mut generator, now_millis() as f64, entropy())
}

pub fn session_id() -> Result<session::Id, DecodeError> {
    let mut generator = GENERATOR.lock().unwrap_or_else(PoisonError::into_inner);
    session::Id::create(&mut generator, now_millis() as f64, entropy())
}

pub fn prefixed(prefix: &str) -> Result<LosslessString, DecodeError> {
    let mut generator = GENERATOR.lock().unwrap_or_else(PoisonError::into_inner);
    let ordered = generator.ascending(now_millis() as f64, entropy())?;
    Ok(LosslessString::from(format!(
        "{prefix}{}",
        String::from_utf16_lossy(&ordered.code_units().collect::<Vec<_>>())
    )))
}

pub fn subscription_id() -> String {
    let mut generator = GENERATOR.lock().unwrap_or_else(PoisonError::into_inner);
    generator
        .ascending(now_millis() as f64, entropy())
        .ok()
        .and_then(|ordered| ordered.to_utf8().ok())
        .map(|id| format!("sub_{id}"))
        .unwrap_or_else(|| format!("sub-{}", now_millis()))
}

fn entropy() -> [u8; 14] {
    let mut bytes = [0u8; 14];
    for chunk in bytes.chunks_mut(8) {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u128(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |elapsed| elapsed.as_nanos()),
        );
        let random = hasher.finish().to_le_bytes();
        chunk.copy_from_slice(&random[..chunk.len()]);
    }
    bytes
}
