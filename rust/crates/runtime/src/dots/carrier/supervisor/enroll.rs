use super::{Shared, diagnostic::Diagnostic};
use crate::dots::carrier::executor;
use std::sync::Arc;
use tokio::sync::watch;
use ycoding_core::{
    dots::{access, enrollment::registry, native},
    ycoding_schema::LosslessString,
};

pub(super) const LABEL_UNITS: usize = 100;

pub(super) struct Fence {
    configuration: native::Configuration,
    profile: String,
    credential_id: String,
    account_id: String,
    account_generation: i64,
}

impl Fence {
    pub(super) fn new(configuration: native::Configuration) -> Option<Self> {
        let native::Configuration::Enabled {
            profile,
            credential_id,
            account_id,
            account_generation,
            ..
        } = configuration.clone()
        else {
            return None;
        };
        Some(Self {
            configuration,
            profile,
            credential_id,
            account_id,
            account_generation,
        })
    }

    pub(super) fn profile(&self) -> &str {
        &self.profile
    }

    pub(super) fn admits(&self, credential: &native::ResolvedCredential) -> bool {
        credential.profile == self.profile
            && credential.credential_id == self.credential_id
            && credential.account_id == self.account_id
            && credential.account_generation == self.account_generation
    }

    pub(super) fn current(&self, shared: &Shared) -> bool {
        (shared.source.configuration)().is_ok_and(|current| current == self.configuration)
    }
}

pub(super) enum Failure {
    Stopped,
    Retry(Diagnostic),
    Rejected(Diagnostic),
}

fn refreshed(
    shared: &Arc<Shared>,
    fence: &Arc<Fence>,
    rejected: String,
) -> native::NativeFuture<'static, Option<Arc<native::ResolvedCredential>>> {
    let (shared, fence) = (shared.clone(), fence.clone());
    Box::pin(async move {
        let next = (shared.source.credential)(fence.profile().to_owned(), Some(rejected))
            .await
            .ok()
            .flatten();
        Ok::<_, access::Error>(next.filter(|next| fence.admits(next)).map(Arc::new))
    })
}

pub(super) fn executor_refresh(shared: &Arc<Shared>, fence: &Arc<Fence>) -> executor::Refresh {
    let (shared, fence) = (shared.clone(), fence.clone());
    Arc::new(move |rejected| {
        let next = refreshed(&shared, &fence, rejected);
        Box::pin(async move { next.await.ok().flatten() })
    })
}

pub(super) fn registry_refresh(shared: &Arc<Shared>, fence: &Arc<Fence>) -> registry::Refresh {
    let (shared, fence) = (shared.clone(), fence.clone());
    Arc::new(move |rejected| refreshed(&shared, &fence, rejected))
}

pub(super) fn label_units(label: &LosslessString) -> Vec<u16> {
    let units = label.code_units().collect::<Vec<_>>();
    let trimmed = access::trim_units(&units);
    trimmed[..trimmed.len().min(LABEL_UNITS)].to_vec()
}

pub(super) async fn resolve(
    shared: &Shared,
    credential: &Arc<native::ResolvedCredential>,
    configured: Option<&LosslessString>,
    refresh: &executor::Refresh,
    label_synced: &mut bool,
    reconciled: &mut bool,
    cancel: &mut watch::Receiver<bool>,
) -> Result<executor::Resolved, Failure> {
    let ctx = executor::Context {
        path: &shared.state_path,
        post: &shared.post,
        clock: &*shared.ambient.clock,
        refresh: Some(refresh),
    };
    let resolved = match executor::resolve(
        &ctx,
        credential,
        executor::EnrollmentInput {
            hostname: &shared.hostname,
            configured_name: configured,
            roots: &shared.roots,
            installation: &shared.installation,
        },
        reconciled,
        cancel,
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(executor::Problem::Cancelled) => return Err(Failure::Stopped),
        Err(executor::Problem::Retry) => return Err(Failure::Retry(Diagnostic::EnrollmentFailed)),
        Err(executor::Problem::Rejected(category)) => {
            return Err(Failure::Rejected(Diagnostic::rejection(category)));
        }
    };
    if resolved.roots_changed {
        *label_synced = true;
    }
    for note in &resolved.notes {
        if let Some(diagnostic) = Diagnostic::note(note) {
            shared.diagnostics.report(diagnostic);
        }
    }
    Ok(resolved)
}

pub(super) async fn sync_label(
    shared: &Shared,
    credential: &Arc<native::ResolvedCredential>,
    record: &executor::Record,
    configured: Option<&LosslessString>,
    label_synced: &mut bool,
    cancel: &mut watch::Receiver<bool>,
) -> Option<LosslessString> {
    let Some(configured) = configured else {
        return record.executor_id.clone();
    };
    let label = label_units(configured);
    if label.is_empty() || *label_synced {
        return record.executor_id.clone();
    }
    *label_synced = true;
    let current = record
        .custom_display_name
        .clone()
        .or_else(|| record.display_name.clone())
        .unwrap_or_else(|| LosslessString::from(shared.hostname.as_str()));
    let label = LosslessString::from_utf16(label);
    if label == LosslessString::from_utf16(label_units(&current))
        || record
            .rename_declined
            .as_ref()
            .is_some_and(|declined| declined.label == label)
    {
        return record.executor_id.clone();
    }
    let ctx = executor::Context {
        path: &shared.state_path,
        post: &shared.post,
        clock: &*shared.ambient.clock,
        refresh: None,
    };
    let Ok(renamed) = executor::rename(&ctx, credential, record, &label, cancel).await else {
        return record.executor_id.clone();
    };
    if *cancel.borrow() {
        return record.executor_id.clone();
    }
    if renamed.outcome == executor::Rename::Unrecorded || !renamed.persisted {
        shared
            .diagnostics
            .report(Diagnostic::RegistrationUpdateFailed);
    }
    match renamed.outcome {
        executor::Rename::ExecutorChanged => shared
            .diagnostics
            .report(Diagnostic::RegistrationRenameExecutorChanged),
        executor::Rename::Unconfirmed | executor::Rename::Uncertain => shared
            .diagnostics
            .report(Diagnostic::RegistrationRenameUnconfirmed),
        executor::Rename::Confirmed | executor::Rename::Unrecorded => {}
    }
    renamed.record.executor_id
}
