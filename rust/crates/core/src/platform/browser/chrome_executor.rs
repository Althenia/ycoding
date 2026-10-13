use super::{
    chrome,
    chrome_process::{Options, Owned, error},
    isolated::{ActionOutput, Availability, Executor, ExecutorError, Launch, Runtime, Snapshot},
};
use crate::platform::computer::Future;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::watch;
use ycoding_schema::browser;

pub struct IsolatedChrome {
    options: Options,
}

impl IsolatedChrome {
    pub fn installed() -> Self {
        let (platform, architecture) = chrome::current_placement();
        Self {
            options: Options {
                executable: PathBuf::from(chrome::INSTALLED_CHROME),
                temporary_directory: std::env::temp_dir(),
                url: String::new(),
                platform: platform.into(),
                architecture: architecture.into(),
                startup_timeout: Duration::from_secs(15),
                command_timeout: Duration::from_secs(5),
                close_timeout: Duration::from_secs(5),
                exit_grace: Duration::from_millis(500),
                destruction_timeout: Duration::from_secs(2),
                settle: Duration::from_millis(150),
            },
        }
    }
    #[cfg(test)]
    pub(super) fn with(options: Options) -> Self {
        Self { options }
    }
}

impl Executor for IsolatedChrome {
    fn availability(&self) -> Future<'_, Availability> {
        Box::pin(chrome::availability(
            &self.options.executable,
            &self.options.platform,
            &self.options.architecture,
        ))
    }
    fn launch(
        &self,
        input: Launch,
        cancel: watch::Receiver<bool>,
    ) -> Future<'_, Result<Arc<dyn Runtime>, ExecutorError>> {
        let mut options = self.options.clone();
        Box::pin(async move {
            options.url = input
                .url
                .to_utf8()
                .map_err(|_| error("Only credential-free HTTP and HTTPS pages are supported"))?;
            let (owned, started) = Owned::begin(options, Some(cancel))?;
            let owned = owned.ready(started).await?;
            Ok(Arc::new(ChromeRuntime { owned }) as Arc<dyn Runtime>)
        })
    }
}

struct ChromeRuntime {
    owned: Owned,
}

impl Runtime for ChromeRuntime {
    fn observe(&self) -> Future<'_, Result<Snapshot, ExecutorError>> {
        Box::pin(self.owned.page().observe())
    }
    fn action<'a>(
        &'a self,
        action: browser::Action,
        origins: Vec<String>,
        cancel: watch::Receiver<bool>,
    ) -> Future<'a, Result<ActionOutput, ExecutorError>> {
        Box::pin(self.owned.page().act(action, origins, cancel))
    }
    fn pause(&self) -> Future<'_, Result<(), ExecutorError>> {
        Box::pin(async {
            self.owned.page().pause();
            Ok(())
        })
    }
    fn resume(&self) -> Future<'_, Result<(), ExecutorError>> {
        Box::pin(async { self.owned.page().resume() })
    }
    fn close(&self) -> Future<'_, Result<(), ExecutorError>> {
        Box::pin(self.owned.shutdown())
    }
    fn closed(&self) -> Future<'_, ()> {
        Box::pin(self.owned.closed())
    }
}
