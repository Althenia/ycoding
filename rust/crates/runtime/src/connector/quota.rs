use prost::Message;
use std::collections::VecDeque;
use ycoding_core::{
    event_feed::{Data, Item, Payload},
    ycoding_schema::provider_usage::QuotaPaceAlert,
};
use ycoding_protocol::{encode_lossless, v5};

pub(super) const TYPES: &[&str] = &["provider.quota.pace"];
const CAPACITY: usize = 256;
const SETTLED_LIMIT: usize = 256;
const SETTLED_GRACE_MS: u64 = 60_000;

type Key = (Vec<u16>, Vec<u16>, i32, u64);

struct Entry {
    key: Key,
    quota: v5::QuotaPace,
    sent: Option<u64>,
}

#[derive(Default)]
pub(super) struct Quota {
    entries: Vec<Entry>,
    settled: VecDeque<(Key, u64)>,
    pass: bool,
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
        self.settled.retain(|(_, expires)| *expires > now);
        if self.settled.iter().any(|(settled, _)| *settled == key)
            || self.entries.iter().any(|entry| entry.key == key)
            || self.entries.len() >= CAPACITY
        {
            return;
        }
        self.entries.push(Entry {
            key,
            quota,
            sent: None,
        });
        self.pass = true;
    }

    pub(super) fn begin(&mut self) {
        self.pass = true;
    }

    pub(super) fn refresh(&mut self) {
        self.entries.iter_mut().for_each(|entry| entry.sent = None);
        self.pass = true;
    }

    pub(super) fn next(&mut self, connection: u64, now: u64) -> Option<v5::QuotaPace> {
        self.entries.retain(|entry| entry.quota.reset_at > now);
        if !self.pass {
            return None;
        }
        let next = self
            .entries
            .iter()
            .find(|entry| entry.sent != Some(connection))
            .map(|entry| entry.quota.clone());
        self.pass = next.is_some();
        next
    }

    pub(super) fn sent(&mut self, quota: &v5::QuotaPace, connection: u64) {
        let key = key(quota);
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.key == key) {
            entry.sent = Some(connection);
        }
    }

    pub(super) fn settle(&mut self, result: &v5::QuotaPaceResult) {
        let key = key(&result.quota);
        let Some(index) = self.entries.iter().position(|entry| entry.key == key) else {
            return;
        };
        self.entries[index].sent = None;
        if result.status != v5::QuotaPaceStatus::Settled as i32 {
            return;
        }
        let entry = self.entries.remove(index);
        self.settled
            .push_back((key, entry.quota.reset_at + SETTLED_GRACE_MS));
        while self.settled.len() > SETTLED_LIMIT {
            self.settled.pop_front();
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
    use super::{CAPACITY, Quota, SETTLED_LIMIT, key};
    use ycoding_core::ycoding_schema::{
        DomainDecode, JsonValue,
        provider_usage::{PaceMilestone, QuotaPaceAlert},
        schema::NonNegativeInt,
    };
    use ycoding_protocol::v5::{QuotaPace, QuotaPaceResult, QuotaPaceStatus};

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

    fn result(quota: &QuotaPace, status: QuotaPaceStatus) -> QuotaPaceResult {
        QuotaPaceResult {
            quota: quota.clone(),
            status: status as i32,
        }
    }

    fn drain(quota: &mut Quota, connection: u64, now: u64) -> Vec<QuotaPace> {
        let mut sent = Vec::new();
        while let Some(next) = quota.next(connection, now) {
            quota.sent(&next, connection);
            sent.push(next);
        }
        sent
    }

    #[test]
    fn identity_rounds_reset_to_the_minute_and_keeps_milestones_distinct() {
        let mut quota = Quota::default();
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        quota.offer(&alert("weekly", "almost-out", 129_999), 0);
        quota.offer(&alert("weekly", "will-run-out", 120_000), 0);
        quota.offer(&alert("weekly", "almost-out", 180_000), 0);
        assert_eq!(quota.entries.len(), 3);
        assert_eq!(quota.entries[0].quota.reset_at, 120_000);
        assert_eq!(key(&quota.entries[0].quota).3, 2);
    }

    #[test]
    fn invalid_and_expired_alerts_never_enter_the_queue() {
        let mut quota = Quota::default();
        quota.offer(&alert("", "almost-out", 120_000), 0);
        quota.offer(&alert(" weekly", "almost-out", 120_000), 0);
        quota.offer(&alert(&"w".repeat(65), "almost-out", 120_000), 0);
        quota.offer(&alert("weekly", "healthy", 120_000), 0);
        quota.offer(&alert("weekly", "almost-out", 0), 0);
        quota.offer(&alert("weekly", "almost-out", 1_000), 1_000);
        assert!(quota.entries.is_empty());
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        assert_eq!(drain(&mut quota, 1, 0).len(), 1);
        assert!(quota.next(1, 120_000).is_none());
        assert!(quota.entries.is_empty());
    }

    #[test]
    fn a_new_identity_is_dropped_while_the_pending_bound_is_full() {
        let mut quota = Quota::default();
        for index in 0..=CAPACITY {
            quota.offer(&alert(&format!("w{index}"), "almost-out", 120_000), 0);
        }
        assert_eq!(CAPACITY, 256);
        assert_eq!(quota.entries.len(), CAPACITY);
        let sent = drain(&mut quota, 1, 0);
        assert_eq!(sent.len(), CAPACITY);
        quota.settle(&result(&sent[0], QuotaPaceStatus::Settled));
        quota.offer(&alert(&format!("w{CAPACITY}"), "almost-out", 120_000), 1);
        assert_eq!(quota.entries.len(), CAPACITY);
        assert_eq!(drain(&mut quota, 1, 1).len(), 1);
    }

    #[test]
    fn repeated_events_for_one_identity_send_one_frame_per_connection() {
        let mut quota = Quota::default();
        for _ in 0..100 {
            quota.offer(&alert("weekly", "will-run-out", 120_000), 0);
        }
        assert_eq!(drain(&mut quota, 1, 0).len(), 1);
        for _ in 0..100 {
            quota.offer(&alert("weekly", "will-run-out", 120_000), 0);
        }
        assert!(drain(&mut quota, 1, 0).is_empty());
        quota.begin();
        assert_eq!(drain(&mut quota, 2, 0).len(), 1);
    }

    #[test]
    fn a_pending_result_retries_on_refresh_or_a_new_identity_and_a_settled_result_stops_retries() {
        let mut quota = Quota::default();
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        let first = drain(&mut quota, 1, 0).remove(0);
        quota.settle(&result(&first, QuotaPaceStatus::Pending));
        assert!(drain(&mut quota, 1, 0).is_empty());
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        assert!(drain(&mut quota, 1, 0).is_empty());
        quota.refresh();
        assert_eq!(drain(&mut quota, 1, 0), vec![first.clone()]);
        quota.settle(&result(&first, QuotaPaceStatus::Pending));
        quota.offer(&alert("weekly", "will-run-out", 120_000), 0);
        let retried = drain(&mut quota, 1, 0);
        assert_eq!(retried.len(), 2);
        assert_eq!(retried[0], first);
        quota.settle(&result(&first, QuotaPaceStatus::Settled));
        quota.refresh();
        quota.offer(&alert("weekly", "almost-out", 120_000), 1);
        assert_eq!(drain(&mut quota, 1, 1).len(), 1);
        assert!(quota.next(1, 1).is_none());
    }

    #[test]
    fn pending_quotas_resend_on_a_replacement_connection_and_settled_ones_do_not() {
        let mut quota = Quota::default();
        quota.offer(&alert("weekly", "will-run-out", 120_000), 0);
        let first = drain(&mut quota, 1, 0).remove(0);
        quota.begin();
        assert_eq!(drain(&mut quota, 2, 0), vec![first.clone()]);
        quota.settle(&result(&first, QuotaPaceStatus::Settled));
        quota.refresh();
        assert!(drain(&mut quota, 2, 0).is_empty());
        quota.begin();
        assert!(drain(&mut quota, 3, 0).is_empty());
    }

    #[test]
    fn a_result_for_an_unknown_identity_changes_nothing() {
        let mut quota = Quota::default();
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        let first = drain(&mut quota, 1, 0).remove(0);
        let mut other = first.clone();
        other.milestone += 1;
        quota.settle(&result(&other, QuotaPaceStatus::Settled));
        assert!(quota.settled.is_empty());
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        assert!(drain(&mut quota, 1, 0).is_empty());
    }

    #[test]
    fn a_settled_identity_is_not_offered_again_within_its_reset_minute() {
        let mut quota = Quota::default();
        quota.offer(&alert("weekly", "almost-out", 120_000), 0);
        let first = drain(&mut quota, 1, 0).remove(0);
        quota.settle(&result(&first, QuotaPaceStatus::Settled));
        quota.offer(&alert("weekly", "almost-out", 120_000), 1);
        quota.offer(&alert("weekly", "almost-out", 129_999), 1);
        assert!(quota.next(2, 1).is_none());
        quota.offer(&alert("weekly", "will-run-out", 120_000), 1);
        quota.offer(&alert("weekly", "almost-out", 180_000), 1);
        assert_eq!(quota.entries.len(), 2);
    }

    #[test]
    fn settled_identities_are_bounded_and_the_oldest_is_forgotten_first() {
        let mut quota = Quota::default();
        for index in 0..=SETTLED_LIMIT {
            quota.offer(&alert(&format!("w{index}"), "almost-out", 120_000), 0);
            let next = drain(&mut quota, 1, 0).remove(0);
            quota.settle(&result(&next, QuotaPaceStatus::Settled));
        }
        assert_eq!(quota.settled.len(), SETTLED_LIMIT);
        quota.offer(&alert("w0", "almost-out", 120_000), 1);
        assert_eq!(quota.entries.len(), 1);
        quota.offer(
            &alert(&format!("w{SETTLED_LIMIT}"), "almost-out", 120_000),
            1,
        );
        assert_eq!(quota.entries.len(), 1);
    }
}
