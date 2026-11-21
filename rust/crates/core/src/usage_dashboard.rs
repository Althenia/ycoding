use crate::{generation_activity, usage_view};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use ycoding_schema::{DomainDecode, usage_dashboard as domain};

#[derive(Clone)]
pub struct Service {
    views: usage_view::Service,
    activity: generation_activity::Service,
    clock: Arc<dyn Fn() -> (i64, u64) + Send + Sync>,
    closed: Arc<AtomicBool>,
}

impl Service {
    pub fn new(
        views: usage_view::Service,
        activity: generation_activity::Service,
        clock: Arc<dyn Fn() -> (i64, u64) + Send + Sync>,
    ) -> Self {
        Self {
            views,
            activity,
            clock,
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn read(&self, quota: domain::Quota, input: &domain::Input) -> domain::Info {
        if self.closed.load(Ordering::Acquire) {
            return failure();
        }
        let inputs = [&input.daily, &input.monthly, &input.breakdown]
            .into_iter()
            .filter_map(Clone::clone)
            .collect::<Vec<_>>();
        if input.refresh.unwrap_or(false) && self.views.refresh_prepared(&inputs).is_err() {
            return failure();
        }
        let prepared = match self.views.read_prepared(&inputs) {
            Ok(Some(prepared)) => prepared,
            Ok(None) => return domain::Info::Preparing,
            Err(_) => return failure(),
        };
        let live = match domain::Live::decode(&self.activity.snapshot((self.clock)().1)) {
            Ok(live) => live,
            Err(_) => return failure(),
        };
        let mut reports = prepared.reports.into_iter();
        if self.closed.load(Ordering::Acquire) {
            return failure();
        }
        domain::Info::Ready(Box::new(domain::Ready {
            as_of: prepared.as_of,
            revision: prepared.revision,
            summary: prepared.summary,
            quota,
            live,
            daily: input.daily.as_ref().and_then(|_| reports.next()),
            monthly: input.monthly.as_ref().and_then(|_| reports.next()),
            breakdown: input.breakdown.as_ref().and_then(|_| reports.next()),
        }))
    }

    pub async fn shutdown(&self) -> Result<(), tokio::task::JoinError> {
        self.closed.store(true, Ordering::Release);
        Ok(())
    }
}

fn failure() -> domain::Info {
    domain::Info::Error {
        message: "Usage dashboard preparation failed".into(),
    }
}
