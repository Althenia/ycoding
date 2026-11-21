use super::support::Harness;
use ycoding_core::session::autonomy;

impl Harness {
    pub fn autonomy(&self) -> autonomy::Service {
        autonomy::Service::new(self.fixture.store.client())
    }
}
