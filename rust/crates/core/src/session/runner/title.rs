use super::{Local, TitleTask};
use crate::{
    session::{
        run_coordinator::{Cancellation, Error, Outcome},
        title::Service,
    },
    tools::code_mode,
};
use std::{collections::btree_map::Entry, sync::Arc};
use ycoding_schema::session;

impl Local {
    pub(super) fn start_title(
        &self,
        title: Arc<Service>,
        session: session::Info,
        mut drain: Cancellation,
        owner: Option<Arc<dyn Send + Sync>>,
    ) {
        let mut titles = self
            .0
            .titles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Entry::Vacant(entry) = titles.entry(session.id.clone()) else {
            return;
        };
        let cancellation = code_mode::Cancellation::default();
        let cancel = cancellation.clone();
        let (completed, done) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let _owner = owner;
            let generation = title.generate_for_first_prompt(&session, &cancel);
            tokio::pin!(generation);
            let result = tokio::select! {
                biased;
                _ = drain.cancelled() => { cancel.cancel(); generation.await }
                result = &mut generation => result,
            };
            completed.send_replace(true);
            result
        });
        entry.insert(TitleTask {
            cancellation,
            done,
            task,
        });
    }

    pub(super) async fn wait_title(&self, id: &session::Id) {
        let done = self
            .0
            .titles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .map(|title| title.done.clone());
        if let Some(mut done) = done {
            while !*done.borrow_and_update() {
                if done.changed().await.is_err() {
                    return;
                }
            }
        }
    }

    pub(super) async fn settle_title(&self, id: &session::Id, failed: bool) -> Outcome {
        let title = self
            .0
            .titles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id);
        let Some(title) = title else {
            return Ok(());
        };
        if failed {
            title.cancellation.cancel();
        }
        match title.task.await {
            Err(_) => Err(Error::Panicked),
            Ok(Err(_)) => {
                tracing::warn!("Session title generation failed");
                Ok(())
            }
            Ok(Ok(())) => Ok(()),
        }
    }
}
