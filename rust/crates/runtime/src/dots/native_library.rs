use crate::locations::{LocationServices, WeakLocations};
use crate::production::owner::{Context, Handle, OwnerFailure, Report, Resource};
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, Ordering},
};
use ycoding_core::{
    cca::{
        error::{BoxFuture, ExecutorError},
        library::{
            LibraryCallError, LibraryFactory, LibraryOpenInput, LibraryProcess, LibraryTool,
        },
        value::{Value, concat},
    },
    dots::native::executor_scope::{CurrentCheck, LibraryProvider, LibraryScope},
    resources::account_connectors,
    session::store::Service as SessionStore,
    ycoding_schema::session,
};

#[derive(Clone)]
pub(super) struct Options {
    pub locations: WeakLocations,
    pub sessions: SessionStore,
    pub owner: Handle,
}

pub(super) fn provider(options: Options) -> Arc<dyn LibraryProvider> {
    Arc::new(Provider(options))
}

struct Provider(Options);

fn unavailable() -> ExecutorError {
    ExecutorError::new(-32603, "Native Library Session or Location retired")
}

fn same_session(expected: &session::Info, actual: &session::Info) -> bool {
    expected.id == actual.id
        && expected.time.created == actual.time.created
        && expected.project_id == actual.project_id
        && expected.location == actual.location
        && expected.subpath == actual.subpath
        && expected.parent_id.is_none()
        && actual.parent_id.is_none()
        && expected.time.archived.is_none()
        && actual.time.archived.is_none()
}

fn stored_session(sessions: &SessionStore, expected: &session::Info) -> Result<(), ExecutorError> {
    match sessions.get(&expected.id) {
        Ok(Some(actual)) if same_session(expected, &actual) => Ok(()),
        _ => Err(unavailable()),
    }
}

fn combined(primary: ExecutorError, secondary: ExecutorError) -> ExecutorError {
    ExecutorError {
        code: primary.code,
        message: concat(&[
            &primary.message,
            &"; additional Library failure: ".into(),
            &secondary.message,
        ]),
        refusal: primary.refusal.or(secondary.refusal),
    }
}

fn settled<T>(
    result: Result<T, ExecutorError>,
    checked: Result<(), ExecutorError>,
) -> Result<T, ExecutorError> {
    match (result, checked) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(combined(primary, secondary)),
    }
}

#[derive(Clone)]
struct Fence {
    locations: WeakLocations,
    sessions: SessionStore,
    expected: session::Info,
    lease: Weak<LocationServices>,
    original: CurrentCheck,
}

impl Fence {
    fn local(&self) -> Result<(), ExecutorError> {
        stored_session(&self.sessions, &self.expected)?;
        let locations = self.locations.upgrade().ok_or_else(unavailable)?;
        let lease = self.lease.upgrade().ok_or_else(unavailable)?;
        if !locations.is_current(&lease)
            || lease.info.directory != self.expected.location.directory
            || lease.info.workspace_id != self.expected.location.workspace_id
            || lease.info.project.id != self.expected.project_id
        {
            return Err(unavailable());
        }
        Ok(())
    }

    async fn check(&self) -> Result<(), ExecutorError> {
        self.local()?;
        let checked = (self.original)().await;
        settled(checked, self.local())
    }
}

fn checked_scope(mut scope: LibraryScope, fence: Fence) -> LibraryScope {
    scope.current = Arc::new(move || {
        let fence = fence.clone();
        Box::pin(async move { fence.check().await })
    });
    scope
}

fn library_input(
    scope: LibraryScope,
    lease: &LocationServices,
    fence: Fence,
) -> Result<account_connectors::LibraryInput, ExecutorError> {
    let production = lease.production.as_ref().ok_or_else(unavailable)?;
    Ok(account_connectors::LibraryInput {
        scope: checked_scope(scope, fence),
        configuration: production.configuration.clone(),
        integration: production.integrations.clone(),
        attachments: production.session_generate.attachments.clone(),
    })
}

fn cleanup_result(report: Report) -> Result<(), ExecutorError> {
    let mut failures = report.failures.into_iter().map(|failure| match failure {
        OwnerFailure::Library(error) => error,
        OwnerFailure::Runtime(_) => unavailable(),
        OwnerFailure::Join(stage) => ExecutorError::new(-32603, stage),
    });
    match failures.next() {
        None => Ok(()),
        Some(first) => Err(failures.fold(first, combined)),
    }
}

async fn abandon_factory(result: Result<Arc<Factory>, ExecutorError>) -> Report {
    match result {
        Ok(factory) => {
            drop(factory.resource.close().await);
            Report::default()
        }
        Err(_) => Report::default(),
    }
}

async fn abandon_process(result: Result<Arc<dyn LibraryProcess>, ExecutorError>) -> Report {
    match result {
        Ok(process) => {
            drop(process.close().await);
            Report::default()
        }
        Err(_) => Report::default(),
    }
}

impl LibraryProvider for Provider {
    fn factory(
        &self,
        scope: LibraryScope,
        supplied: &session::Info,
    ) -> BoxFuture<'_, Result<Arc<dyn LibraryFactory>, ExecutorError>> {
        let expected = supplied.clone();
        let options = self.0.clone();
        let request = self.0.owner.register(
            move |context| {
                Box::pin(async move {
                    if !options.owner.admitting() {
                        return Err(unavailable());
                    }
                    if scope.session_id != expected.id || !same_session(&expected, &expected) {
                        return Err(unavailable());
                    }
                    stored_session(&options.sessions, &expected)?;
                    let checked = (scope.current)().await;
                    settled(checked, stored_session(&options.sessions, &expected))?;
                    let lease = {
                        let locations = options.locations.upgrade().ok_or_else(unavailable)?;
                        let (actual, lease) = locations
                            .session(&scope.session_id)
                            .map_err(|_| unavailable())?;
                        if !same_session(&expected, &actual) || !locations.is_current(&lease) {
                            return Err(unavailable());
                        }
                        lease
                    };
                    let fence = Fence {
                        locations: options.locations.clone(),
                        sessions: options.sessions.clone(),
                        expected,
                        lease: Arc::downgrade(&lease),
                        original: scope.current.clone(),
                    };
                    fence.check().await?;
                    let input = library_input(scope, &lease, fence.clone())?;
                    let acquired = account_connectors::library_factory(input).await;
                    let factory = acquired.map(|backend| {
                        Arc::new(Factory::new(
                            &context,
                            backend,
                            lease.clone(),
                            fence.clone(),
                        ))
                    });
                    let checked = fence.check().await;
                    match (factory, checked) {
                        (Ok(factory), Ok(())) if !factory.resource.is_retired() => Ok(factory),
                        (Ok(factory), checked) => {
                            let failure = checked.err().unwrap_or_else(unavailable);
                            let released = cleanup_result(factory.resource.close().await);
                            settled(Err(failure), released)
                        }
                        (Err(error), checked) => settled(Err(error), checked),
                    }
                })
            },
            |result| Box::pin(abandon_factory(result)),
        );
        Box::pin(async move {
            request
                .map_err(|_| unavailable())?
                .await
                .map_err(|_| unavailable())?
                .map(|factory| factory as Arc<dyn LibraryFactory>)
        })
    }
}

struct Factory {
    state: Weak<FactoryState>,
    resource: Resource,
    fence: Fence,
    owner: Handle,
    retiring: Arc<AtomicBool>,
}

struct FactoryState {
    backend: Arc<dyn LibraryFactory>,
    lease: Arc<LocationServices>,
}

impl Factory {
    fn new(
        context: &Context,
        backend: Arc<dyn LibraryFactory>,
        lease: Arc<LocationServices>,
        fence: Fence,
    ) -> Self {
        let state = Arc::new(FactoryState { backend, lease });
        let weak = Arc::downgrade(&state);
        let retiring = Arc::new(AtomicBool::new(false));
        let retired = retiring.clone();
        let resource = context.retain(
            Box::new(move || {
                retired.store(true, Ordering::Release);
            }),
            Box::pin(async move {
                drop(state);
                Report::default()
            }),
        );
        Self {
            state: weak,
            resource,
            fence,
            owner: context.handle(),
            retiring,
        }
    }
}

impl LibraryFactory for Factory {
    fn open(
        &self,
        input: LibraryOpenInput,
    ) -> BoxFuture<'_, Result<Arc<dyn LibraryProcess>, ExecutorError>> {
        let state = self.state.upgrade();
        let (resource, fence, retiring) = (
            self.resource.clone(),
            self.fence.clone(),
            self.retiring.clone(),
        );
        let request = self.owner.register(
            move |context| {
                Box::pin(async move {
                    if retiring.load(Ordering::Acquire)
                        || resource.is_retired()
                        || !context.handle().admitting()
                    {
                        return Err(unavailable());
                    }
                    let state = state.ok_or_else(unavailable)?;
                    fence.check().await?;
                    if resource.is_retired() {
                        return Err(unavailable());
                    }
                    let opened = state.backend.open(input).await;
                    let process = opened.map(|backend| {
                        Arc::new(Process::new(
                            &context,
                            backend,
                            state.lease.clone(),
                            fence.clone(),
                        ))
                    });
                    let checked = fence.check().await;
                    match (process, checked) {
                        (Ok(process), Ok(()))
                            if !resource.is_retired() && !process.resource.is_retired() =>
                        {
                            Ok(process as Arc<dyn LibraryProcess>)
                        }
                        (Ok(process), checked) => {
                            let error = checked.err().unwrap_or_else(unavailable);
                            let released = process.close().await;
                            settled(Err(error), released)
                        }
                        (Err(error), checked) => settled(Err(error), checked),
                    }
                })
            },
            |result| Box::pin(abandon_process(result)),
        );
        Box::pin(async move {
            request
                .map_err(|_| unavailable())?
                .await
                .map_err(|_| unavailable())?
        })
    }
}

struct Process {
    backend: Weak<dyn LibraryProcess>,
    resource: Resource,
    fence: Fence,
    retiring: Arc<AtomicBool>,
    owner: Handle,
}

impl Process {
    fn new(
        context: &Context,
        backend: Arc<dyn LibraryProcess>,
        lease: Arc<LocationServices>,
        fence: Fence,
    ) -> Self {
        let weak = Arc::downgrade(&backend);
        let retiring = Arc::new(AtomicBool::new(false));
        let retired = retiring.clone();
        let resource = context.retain(
            Box::new(move || {
                retired.store(true, Ordering::Release);
            }),
            Box::pin(async move {
                let outcome = backend.close().await;
                drop(lease);
                Report::library(outcome)
            }),
        );
        Self {
            backend: weak,
            resource,
            fence,
            retiring,
            owner: context.handle(),
        }
    }

    async fn current(&self) -> Result<(), ExecutorError> {
        if self.retiring.load(Ordering::Acquire)
            || self.resource.is_retired()
            || !self.owner.admitting()
        {
            return Err(unavailable());
        }
        self.fence.check().await?;
        if self.retiring.load(Ordering::Acquire)
            || self.resource.is_retired()
            || !self.owner.admitting()
        {
            Err(unavailable())
        } else {
            Ok(())
        }
    }
}

impl LibraryProcess for Process {
    fn check(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        Box::pin(async move {
            self.current().await?;
            let backend = self.backend.upgrade().ok_or_else(unavailable)?;
            let result = backend.check().await;
            let checked = self.current().await;
            settled(result, checked)
        })
    }

    fn tools(&self) -> Vec<LibraryTool> {
        if self.retiring.load(Ordering::Acquire)
            || self.resource.is_retired()
            || !self.owner.admitting()
            || self.fence.local().is_err()
        {
            return vec![];
        }
        self.backend
            .upgrade()
            .map(|backend| backend.tools())
            .unwrap_or_default()
    }

    fn call(&self, name: &str, arguments: Value) -> BoxFuture<'_, Result<Value, LibraryCallError>> {
        let name = name.to_owned();
        Box::pin(async move {
            self.current().await.map_err(|_| LibraryCallError::Failed)?;
            let backend = self.backend.upgrade().ok_or(LibraryCallError::Failed)?;
            let result = backend.call(&name, arguments).await;
            let checked = self.current().await;
            match result {
                Err(error) => Err(error),
                Ok(value) => checked.map(|_| value).map_err(|_| LibraryCallError::Failed),
            }
        })
    }

    fn close(&self) -> BoxFuture<'_, Result<(), ExecutorError>> {
        let closed = self.resource.close();
        Box::pin(async move { cleanup_result(closed.await) })
    }
}

#[cfg(test)]
mod tests {
    include!("native_library_tests.rs");
}
