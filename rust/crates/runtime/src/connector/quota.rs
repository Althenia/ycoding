use prost::Message;
use ycoding_core::{
    event_feed::{Data, Item, Payload},
    ycoding_schema::provider_usage::QuotaPaceAlert,
};
use ycoding_protocol::{encode_lossless, v5};

pub(super) const TYPES: &[&str] = &["provider.quota.pace"];
const CAPACITY: usize = 64;

type Key = (Vec<u16>, Vec<u16>, i32, u64);

struct Entry {
    key: Key,
    quota: v5::QuotaPace,
    sent: Option<u64>,
}

#[derive(Default)]
pub(super) struct Quota {
    entries: Vec<Entry>,
}

impl Quota {
    pub(super) fn offer_item(&mut self, item: &Item, now: u64) {
        if let Payload::Ephemeral(event) = &item.payload
            && let Data::ProviderQuotaPace(alert) = &event.data
        {
            self.offer(alert, now);
        }
    }

    pub(super) fn offer(&mut self, alert: &QuotaPaceAlert, now: u64) {
        let Some(quota) = convert(alert) else {
            return;
        };
        if quota.reset_at <= now {
            return;
        }
        let key = key(&quota);
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.key == key) {
            entry.quota = quota;
            entry.sent = None;
            return;
        }
        if self.entries.len() == CAPACITY {
            self.entries.remove(0);
        }
        self.entries.push(Entry {
            key,
            quota,
            sent: None,
        });
    }

    pub(super) fn next(&mut self, connection: u64, now: u64) -> Option<v5::QuotaPace> {
        self.entries.retain(|entry| entry.quota.reset_at > now);
        self.entries
            .iter()
            .find(|entry| entry.sent != Some(connection))
            .map(|entry| entry.quota.clone())
    }

    pub(super) fn sent(&mut self, quota: &v5::QuotaPace, connection: u64) {
        let key = key(quota);
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.key == key) {
            entry.sent = Some(connection);
        }
    }

    pub(super) fn settle(&mut self, result: &v5::QuotaPaceResult) {
        if result.status == v5::QuotaPaceStatus::Settled as i32 {
            let key = key(&result.quota);
            self.entries.retain(|entry| entry.key != key);
        }
    }
}

fn convert(alert: &QuotaPaceAlert) -> Option<v5::QuotaPace> {
    let milestone = match alert.milestone.0.to_utf8().ok()?.as_str() {
        "almost-out" => v5::QuotaPaceMilestone::AlmostOut,
        "cutting-it-close" => v5::QuotaPaceMilestone::CuttingItClose,
        "will-run-out" => v5::QuotaPaceMilestone::WillRunOut,
        _ => return None,
    };
    let quota = v5::QuotaPace {
        provider_id: encode_lossless(&alert.provider_id.0.code_units().collect::<Vec<_>>()),
        window_id: encode_lossless(&alert.window_id.code_units().collect::<Vec<_>>()),
        milestone: milestone as i32,
        reset_at: u64::try_from(alert.reset_at.get()).ok()?,
    };
    (quota.reset_at >= 1
        && quota.reset_at <= 9_007_199_254_740_991
        && ycoding_protocol::validate_binary("ycoding.v5.QuotaPace", &quota.encode_to_vec())
            .is_ok())
    .then_some(quota)
}

fn key(quota: &v5::QuotaPace) -> Key {
    let units = |value: &v5::LosslessString| {
        ycoding_protocol::decode_lossless(value, 64).unwrap_or_default()
    };
    (
        units(&quota.provider_id),
        units(&quota.window_id),
        quota.milestone,
        (quota.reset_at + 30_000) / 60_000,
    )
}

#[cfg(test)]
mod tests {
    use super::{CAPACITY, Quota, key};
    use ycoding_core::ycoding_schema::{
        DomainDecode, JsonValue,
        provider_usage::{PaceMilestone, QuotaPaceAlert},
        schema::NonNegativeInt,
    };

    fn alert(window: &str, milestone: &str, reset_at: i64) -> QuotaPaceAlert {
        QuotaPaceAlert {
            provider_id: DomainDecode::decode(&JsonValue::String("openai".into())).unwrap(),
            window_id: window.into(),
            milestone: PaceMilestone(milestone.into()),
            reset_at: NonNegativeInt::new(reset_at).unwrap(),
            title: "Fixed title".into(),
            body: "Fixed body".into(),
        }
    }

    #[test]
    fn identity_rounds_reset_to_the_minute_and_keeps_milestones_distinct() {
        let mut quota = Quota::default();
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        quota.offer(&alert("weekly", "almost-out", 129_999), 0);
        quota.offer(&alert("weekly", "will-run-out", 120_000), 0);
        quota.offer(&alert("weekly", "almost-out", 180_000), 0);
        assert_eq!(quota.entries.len(), 3);
        assert_eq!(quota.entries[0].quota.reset_at, 129_999);
        assert_eq!(key(&quota.entries[0].quota).3, 2);
    }

    #[test]
    fn invalid_expired_and_overflowing_alerts_are_bounded() {
        let mut quota = Quota::default();
        quota.offer(&alert("", "almost-out", 120_000), 0);
        quota.offer(&alert(" weekly", "almost-out", 120_000), 0);
        quota.offer(&alert(&"w".repeat(65), "almost-out", 120_000), 0);
        quota.offer(&alert("weekly", "healthy", 120_000), 0);
        quota.offer(&alert("weekly", "almost-out", 0), 0);
        quota.offer(&alert("weekly", "almost-out", 1_000), 1_000);
        assert!(quota.entries.is_empty());
        for index in 0..=CAPACITY {
            quota.offer(&alert(&format!("w{index}"), "almost-out", 120_000), 0);
        }
        assert_eq!(quota.entries.len(), CAPACITY);
        assert_eq!(quota.next(1, 0).unwrap().reset_at, 120_000);
        assert!(quota.next(1, 120_000).is_none());
        assert!(quota.entries.is_empty());
    }

    #[test]
    fn delivery_is_once_per_connection_until_refreshed_or_settled() {
        let mut quota = Quota::default();
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        let first = quota.next(1, 0).unwrap();
        quota.sent(&first, 1);
        assert!(quota.next(1, 0).is_none());
        quota.settle(&ycoding_protocol::v5::QuotaPaceResult {
            quota: first.clone(),
            status: ycoding_protocol::v5::QuotaPaceStatus::Pending as i32,
        });
        assert!(quota.next(1, 0).is_none());
        assert_eq!(quota.next(2, 0), Some(first.clone()));
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        assert_eq!(quota.next(1, 0), Some(first.clone()));
        quota.settle(&ycoding_protocol::v5::QuotaPaceResult {
            quota: first,
            status: ycoding_protocol::v5::QuotaPaceStatus::Settled as i32,
        });
        assert!(quota.next(3, 0).is_none());
    }
}
