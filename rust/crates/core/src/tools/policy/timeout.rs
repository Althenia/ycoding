use ycoding_schema::JsonValue;

pub const DEFAULT_SECONDS: u64 = 300;
pub const MAX_SECONDS: u64 = 86_400;

pub fn seconds(configured: Option<&JsonValue>) -> u64 {
    match configured {
        Some(JsonValue::Number(value))
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= 0.0
                && *value <= MAX_SECONDS as f64 =>
        {
            *value as u64
        }
        _ => DEFAULT_SECONDS,
    }
}

pub(crate) struct Timer(tokio::task::AbortHandle);
impl Drop for Timer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) fn arm(seconds: u64, expire: impl FnOnce() + Send + 'static) -> Option<Timer> {
    if seconds == 0 {
        return None;
    }
    let runtime = tokio::runtime::Handle::try_current().ok()?;
    let task = runtime.spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
        expire();
    });
    Some(Timer(task.abort_handle()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_zero_and_bounded_configuration() {
        assert_eq!(seconds(None), 300);
        assert_eq!(seconds(Some(&JsonValue::Number(0.0))), 0);
        assert_eq!(seconds(Some(&JsonValue::Number(86_400.0))), 86_400);
        for value in [-1.0, 0.5, 86_401.0, f64::NAN] {
            assert_eq!(seconds(Some(&JsonValue::Number(value))), 300);
        }
    }
}
