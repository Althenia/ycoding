use super::Factory;
use std::sync::{Arc, Mutex, PoisonError};
use ycoding_core::{
    extension::SessionServices,
    session::{run_coordinator, runner},
    ycoding_schema::location,
};

pub(super) struct ScopeView {
    location: location::Ref,
    generation: u64,
    state: Mutex<ScopeState>,
    changed: tokio::sync::Notify,
}

struct ScopeState {
    phase: Phase,
    services: Option<SessionServices>,
    leases: usize,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Initializing,
    Published,
    Retired,
}

impl ScopeView {
    pub(super) fn new(location: location::Ref, generation: u64) -> Self {
        Self {
            location,
            generation,
            state: Mutex::new(ScopeState {
                phase: Phase::Initializing,
                services: None,
                leases: 0,
            }),
            changed: tokio::sync::Notify::new(),
        }
    }

    pub(super) fn bind(
        &self,
        services: SessionServices,
    ) -> Result<(), ycoding_core::extension::Error> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.phase != Phase::Initializing
            || state.services.is_some()
            || services.runner.location() != &self.location
            || services.generate.location != self.location
        {
            return Err(ycoding_core::extension::Error::Stopped);
        }
        state.services = Some(services);
        Ok(())
    }

    pub(super) fn published(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.phase == Phase::Initializing {
            state.phase = Phase::Published;
        }
    }

    pub(super) fn retire(&self) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .phase = Phase::Retired;
    }

    pub(super) fn clear(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.phase = Phase::Retired;
        state.services = None;
    }

    pub(super) async fn drain(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .leases
                == 0
            {
                return;
            }
            changed.await;
        }
    }

    fn services(
        self: &Arc<Self>,
        published: bool,
    ) -> Result<Option<(SessionServices, Arc<Lease>)>, run_coordinator::Error> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if published && state.phase == Phase::Initializing {
            state.phase = Phase::Published;
        }
        let services = state
            .services
            .as_ref()
            .ok_or(run_coordinator::Error::Closed)?
            .clone();
        match state.phase {
            Phase::Initializing => {
                state.leases += 1;
                Ok(Some((services, Arc::new(Lease(self.clone())))))
            }
            Phase::Published => Ok(None),
            Phase::Retired => Err(run_coordinator::Error::Closed),
        }
    }
}

struct Lease(Arc<ScopeView>);

impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.leases -= 1;
        drop(state);
        self.0.changed.notify_waiters();
    }
}

impl Factory {
    pub(super) fn refresh(
        &self,
        info: location::Info,
        scope: &Arc<ScopeView>,
    ) -> Option<runner::Refresh> {
        let locations = self.locations.get()?.clone();
        let scope = Arc::downgrade(scope);
        Some(Arc::new(move || {
            let locations = locations.clone();
            let info = info.clone();
            let scope = scope.clone();
            Box::pin(async move {
                tokio::task::spawn_blocking(move || {
                    let scope = scope.upgrade().ok_or(run_coordinator::Error::Closed)?;
                    let locations = locations.upgrade().ok_or(run_coordinator::Error::Closed)?;
                    let published = locations.loaded_groups().iter().flatten().any(|services| {
                        services.info.directory == scope.location.directory
                            && services.info.workspace_id == scope.location.workspace_id
                            && services.production.as_ref().is_some_and(|composed| {
                                composed.generation == scope.generation
                                    && Arc::ptr_eq(&composed.scope_view, &scope)
                                    && !composed.closed.load(std::sync::atomic::Ordering::Acquire)
                            })
                    });
                    if let Some((services, lease)) = scope.services(published)? {
                        return Ok(runner::Refreshed {
                            runner: services.runner,
                            generate: services.generate,
                            owner: lease,
                        });
                    }
                    let current = locations
                        .location(
                            info.directory.as_lossless(),
                            info.workspace_id.as_ref().map(|id| id.as_lossless()),
                        )
                        .map_err(|_| run_coordinator::Error::Closed)?;
                    let composed = current
                        .production
                        .as_ref()
                        .ok_or(run_coordinator::Error::Closed)?;
                    let configuration = composed.configuration.snapshot().map_err(|_| {
                        configuration_error("Location configuration could not be read")
                    })?;
                    if configuration.entries != composed.configuration.entries {
                        locations
                            .reload_generation(&info, composed.generation)
                            .map_err(|_| {
                                configuration_error("Location configuration could not be reloaded")
                            })?;
                    }
                    let current = locations
                        .location(
                            info.directory.as_lossless(),
                            info.workspace_id.as_ref().map(|id| id.as_lossless()),
                        )
                        .map_err(|_| run_coordinator::Error::Closed)?;
                    let composed = current
                        .production
                        .as_ref()
                        .ok_or(run_coordinator::Error::Closed)?;
                    Ok(runner::Refreshed {
                        runner: composed.runner.clone(),
                        generate: composed.session_generate.clone(),
                        owner: current,
                    })
                })
                .await
                .map_err(|_| run_coordinator::Error::Closed)?
            })
        }))
    }
}

fn configuration_error(message: &str) -> run_coordinator::Error {
    run_coordinator::Error::Runner(ycoding_core::ycoding_schema::session_error::Error {
        r#type: "configuration".into(),
        message: message.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn private_view_requires_completed_services_and_never_reopens_after_retirement() {
        let fixture = super::super::tests::fixture("{}", "{}");
        let locations = fixture.locations();
        let location = fixture.services(&locations);
        let composed = location.production.as_ref().unwrap();
        let bound = composed
            .scope_view
            .state
            .lock()
            .unwrap()
            .services
            .clone()
            .unwrap();
        let view = Arc::new(ScopeView::new(
            bound.generate.location.clone(),
            composed.generation,
        ));
        assert!(matches!(
            view.services(false),
            Err(run_coordinator::Error::Closed)
        ));
        view.bind(bound.clone()).unwrap();
        let (private, lease) = view.services(false).unwrap().unwrap();
        assert_eq!(private.runner.location(), bound.runner.location());
        assert!(Arc::ptr_eq(&private.generate, &bound.generate));
        view.published();
        assert!(view.services(false).unwrap().is_none());
        view.retire();
        view.published();
        assert!(matches!(
            view.services(false),
            Err(run_coordinator::Error::Closed)
        ));
        assert!(matches!(
            view.services(true),
            Err(run_coordinator::Error::Closed)
        ));
        assert!(view.bind(bound).is_err());
        let mut drained = Box::pin(view.drain());
        assert!(futures_util::poll!(drained.as_mut()).is_pending());
        drop(lease);
        drained.await;
        view.clear();
        assert!(matches!(
            view.services(false),
            Err(run_coordinator::Error::Closed)
        ));
        locations.close().unwrap();
    }

    #[tokio::test]
    async fn published_refresh_uses_current_location_and_retired_refresh_fails_closed() {
        let fixture = super::super::tests::fixture("{}", "{}");
        let locations = fixture.locations();
        let location = fixture.services(&locations);
        let composed = location.production.as_ref().unwrap();
        let refresh = composed.session_generate.refresh.clone().unwrap();
        let current = refresh().await.unwrap();
        assert_eq!(current.runner.location(), composed.runner.location());
        assert!(Arc::ptr_eq(&current.generate, &composed.session_generate));
        locations.close().unwrap();
        assert!(matches!(
            refresh().await,
            Err(run_coordinator::Error::Closed)
        ));
    }
}
