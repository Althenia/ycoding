use std::sync::{Arc, RwLock};

pub struct DomainState<T> {
    value: Arc<RwLock<Arc<T>>>,
}

impl<T> Clone for DomainState<T> {
    fn clone(&self) -> Self {
        Self {
            value: self.value.clone(),
        }
    }
}

impl<T> DomainState<T> {
    pub fn new(value: T) -> Self {
        Self {
            value: Arc::new(RwLock::new(Arc::new(value))),
        }
    }

    pub fn snapshot(&self) -> Arc<T> {
        self.value
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn publish(&self, value: T) {
        *self
            .value
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Arc::new(value);
    }
}
