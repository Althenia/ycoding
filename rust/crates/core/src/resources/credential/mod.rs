use std::{
    collections::BTreeMap,
    fmt,
    future::Future,
    ops::Bound,
    sync::{Arc, Mutex},
};
use tokio::{sync::watch, task::JoinHandle};
use ycoding_schema::{LosslessString, credential};
use ycoding_store::{
    Client, KeyPart, TableSpec, Write,
    resources::{Credential, CredentialTable, Secret},
    tuple_key,
};

mod session;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Storage,
    UnknownOutcome,
    ProfileUnavailable,
    InvalidCredential,
    Rejected,
    CodeRequired,
    Closed,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Storage => "Credential storage failed",
            Self::UnknownOutcome => "Authentication outcome is unknown; reconcile before retrying",
            Self::ProfileUnavailable => "Selected profile is unavailable; select the profile again",
            Self::InvalidCredential => "Invalid credential",
            Self::Rejected => "Authorization failed",
            Self::CodeRequired => "Authorization code is required",
            Self::Closed => "Credential service is closed",
        })
    }
}
impl std::error::Error for Error {}
impl From<ycoding_store::Error> for Error {
    fn from(error: ycoding_store::Error) -> Self {
        match error {
            ycoding_store::Error::CommitUncertain(_) => Self::UnknownOutcome,
            _ => Self::Storage,
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct Info(Credential);
impl Info {
    pub fn id(&self) -> &LosslessString {
        &self.0.id
    }
    pub fn integration_id(&self) -> &LosslessString {
        self.0
            .integration_id
            .as_ref()
            .expect("validated integration")
    }
    pub fn label(&self) -> &LosslessString {
        &self.0.label
    }
    pub fn secret(&self) -> &Secret {
        &self.0.value
    }
    pub fn generation(&self) -> i64 {
        self.0.generation
    }
    pub fn account_generation(&self) -> i64 {
        self.0.account_generation
    }
    pub fn active(&self) -> bool {
        self.0.active == Some(1)
    }
    pub fn needs_refresh(&self, now: i64) -> Result<bool, Error> {
        Ok(
            matches!(self.0.value.domain().map_err(|_| Error::InvalidCredential)?, credential::Value::OAuth(value) if value.expires.get() <= now.saturating_add(300_000)),
        )
    }
}
impl fmt::Debug for Info {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credential([redacted])")
    }
}
impl fmt::Display for Info {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct Binding {
    provider: LosslessString,
    integration: LosslessString,
    profile: LosslessString,
    credential: LosslessString,
    account_generation: i64,
}
impl fmt::Debug for Binding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProfileBinding([redacted])")
    }
}
impl fmt::Display for Binding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

type RefreshKey = (LosslessString, i64, i64);
type RefreshResult = Result<Option<Info>, Error>;
struct Refreshes {
    closed: bool,
    pending: BTreeMap<RefreshKey, watch::Receiver<Option<RefreshResult>>>,
    tasks: Vec<JoinHandle<()>>,
}
struct Inner {
    store: Client,
    refreshes: Mutex<Refreshes>,
}
#[derive(Clone)]
pub struct Service(Arc<Inner>);
impl Service {
    pub fn new(store: Client) -> Self {
        Self(Arc::new(Inner {
            store,
            refreshes: Mutex::new(Refreshes {
                closed: false,
                pending: BTreeMap::new(),
                tasks: Vec::new(),
            }),
        }))
    }

    pub fn all(&self) -> Result<Vec<Info>, Error> {
        let snapshot = self.0.store.snapshot()?;
        let mut rows = Vec::new();
        let mut cursor = None;
        loop {
            let page = snapshot.scan::<CredentialTable>(
                cursor.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                128,
            )?;
            let last = page.last().map(CredentialTable::primary_key);
            rows.extend(
                page.into_iter()
                    .filter(|row| row.integration_id.as_ref().is_some_and(|id| !id.is_empty()))
                    .map(Info),
            );
            if last.is_none() {
                break;
            }
            cursor = last;
        }
        rows.sort_by_key(|row| row.0.time_created);
        Ok(rows)
    }
    pub fn list(&self, integration: &LosslessString) -> Result<Vec<Info>, Error> {
        Ok(self
            .all()?
            .into_iter()
            .filter(|row| row.integration_id() == integration)
            .collect())
    }
    pub fn get(&self, id: &LosslessString) -> Result<Option<Info>, Error> {
        Ok(self
            .0
            .store
            .snapshot()?
            .get::<CredentialTable>(&identity(id))?
            .filter(|row| row.integration_id.as_ref().is_some_and(|id| !id.is_empty()))
            .map(Info))
    }
    pub fn active(&self, integration: &LosslessString) -> Result<Option<Info>, Error> {
        let rows = self.list(integration)?;
        Ok(rows
            .iter()
            .rev()
            .find(|row| row.active())
            .cloned()
            .or_else(|| rows.last().cloned()))
    }
    pub fn current_account(&self, expected: &Info) -> Result<Info, Error> {
        let current = self.get(expected.id())?.ok_or(Error::ProfileUnavailable)?;
        if current.integration_id() != expected.integration_id()
            || current.account_generation() != expected.account_generation()
        {
            return Err(Error::ProfileUnavailable);
        }
        Ok(current)
    }
    pub fn bind(
        &self,
        provider: LosslessString,
        integration: LosslessString,
        profile: LosslessString,
    ) -> Result<Binding, Error> {
        let matching: Vec<_> = self
            .list(&integration)?
            .into_iter()
            .filter(|row| row.label() == &profile)
            .collect();
        if matching.len() != 1 {
            return Err(Error::ProfileUnavailable);
        }
        Ok(Binding {
            provider,
            integration,
            profile,
            credential: matching[0].id().clone(),
            account_generation: matching[0].account_generation(),
        })
    }
    pub fn resolve_binding(&self, binding: &Binding) -> Result<Info, Error> {
        let matching: Vec<_> = self
            .list(&binding.integration)?
            .into_iter()
            .filter(|row| row.label() == &binding.profile)
            .collect();
        if matching.len() != 1
            || matching[0].id() != &binding.credential
            || matching[0].account_generation() != binding.account_generation
        {
            return Err(Error::ProfileUnavailable);
        }
        Ok(matching.into_iter().next().expect("one matching profile"))
    }
    pub fn resolve_selection(
        &self,
        provider: &LosslessString,
        integration: &LosslessString,
        profile: &LosslessString,
        binding: &Binding,
    ) -> Result<Info, Error> {
        if provider != &binding.provider
            || integration != &binding.integration
            || profile != &binding.profile
        {
            return Err(Error::ProfileUnavailable);
        }
        self.resolve_binding(binding)
    }
    pub async fn create(
        &self,
        id: LosslessString,
        integration: LosslessString,
        label: Option<LosslessString>,
        value: Secret,
        now: i64,
    ) -> Result<Info, Error> {
        Ok(self
            .0
            .store
            .submit(move |tx| {
                let label = label.unwrap_or_else(|| "default".into());
                let rows = transaction_rows(tx)?;
                let existing = rows
                    .iter()
                    .find(|row| {
                        row.integration_id.as_ref() == Some(&integration) && row.label == label
                    })
                    .cloned();
                for mut row in rows
                    .into_iter()
                    .filter(|row| row.integration_id.as_ref() == Some(&integration))
                {
                    row.active = Some(0);
                    row.time_updated = now;
                    CredentialTable::put(tx, &row)?;
                }
                let row = match existing {
                    Some(mut row) => {
                        if row.value != value {
                            row.generation = increment(tx, row.generation)?;
                        }
                        row.account_generation = increment(tx, row.account_generation)?;
                        row.value = value;
                        row.active = Some(1);
                        row.time_updated = now;
                        CredentialTable::put(tx, &row)?;
                        row
                    }
                    None => {
                        let row = Credential {
                            id,
                            integration_id: Some(integration),
                            label,
                            value,
                            connector_id: None,
                            method_id: None,
                            active: Some(1),
                            generation: 0,
                            account_generation: 0,
                            time_created: now,
                            time_updated: now,
                        };
                        CredentialTable::insert(tx, &row)?;
                        row
                    }
                };
                Ok(Info(row))
            })?
            .await?)
    }
    pub async fn update(
        &self,
        id: LosslessString,
        label: Option<LosslessString>,
        value: Option<Secret>,
        now: i64,
    ) -> Result<(), Error> {
        if label.is_none() && value.is_none() {
            return Ok(());
        }
        Ok(self
            .0
            .store
            .submit(move |tx| {
                let Some(mut row) = tx.get::<CredentialTable>(&identity(&id))? else {
                    return Ok(());
                };
                if let Some(label) = label {
                    row.label = label;
                }
                if let Some(value) = value {
                    if row.value != value {
                        row.generation = increment(tx, row.generation)?;
                        row.account_generation = increment(tx, row.account_generation)?;
                    }
                    row.value = value;
                }
                row.time_updated = now;
                CredentialTable::put(tx, &row)
            })?
            .await?)
    }
    pub async fn activate(&self, id: LosslessString, now: i64) -> Result<(), Error> {
        Ok(self
            .0
            .store
            .submit(move |tx| {
                let Some(selected) = tx.get::<CredentialTable>(&identity(&id))? else {
                    return Ok(());
                };
                let Some(integration) = selected.integration_id else {
                    return Ok(());
                };
                if integration.is_empty() {
                    return Ok(());
                }
                for mut row in transaction_rows(tx)?
                    .into_iter()
                    .filter(|row| row.integration_id.as_ref() == Some(&integration))
                {
                    row.active = Some(i64::from(row.id == id));
                    row.time_updated = now;
                    CredentialTable::put(tx, &row)?;
                }
                Ok(())
            })?
            .await?)
    }
    pub async fn remove(&self, id: LosslessString, now: i64) -> Result<(), Error> {
        Ok(self
            .0
            .store
            .submit(move |tx| {
                let Some(selected) = tx.get::<CredentialTable>(&identity(&id))? else {
                    return Ok(());
                };
                tx.delete::<CredentialTable>(&identity(&id))?;
                if selected.integration_id.is_none() || selected.active != Some(1) {
                    return Ok(());
                }
                if let Some(mut remaining) = transaction_rows(tx)?
                    .into_iter()
                    .filter(|row| row.integration_id == selected.integration_id)
                    .max_by_key(|row| row.time_created)
                {
                    remaining.active = Some(1);
                    remaining.time_updated = now;
                    CredentialTable::put(tx, &remaining)?;
                }
                Ok(())
            })?
            .await?)
    }

    pub async fn refresh(
        &self,
        expected: Info,
        now: i64,
        refresh: impl Future<Output = Result<Secret, Error>> + Send + 'static,
    ) -> RefreshResult {
        let finished: Vec<_> = {
            let mut state = self.0.refreshes.lock().map_err(|_| Error::Closed)?;
            state
                .tasks
                .extract_if(.., |task| task.is_finished())
                .collect()
        };
        for task in finished {
            task.await.map_err(|_| Error::UnknownOutcome)?;
        }
        let key = (
            expected.id().clone(),
            expected.generation(),
            expected.account_generation(),
        );
        let mut receiver = {
            let mut state = self.0.refreshes.lock().map_err(|_| Error::Closed)?;
            if state.closed {
                return Err(Error::Closed);
            }
            if let Some(pending) = state.pending.get(&key) {
                pending.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                state.pending.insert(key.clone(), receiver.clone());
                let service = self.clone();
                state.tasks.push(tokio::spawn(async move {
                    let result = service.perform_refresh(expected, now, refresh).await;
                    sender.send_replace(Some(result.clone()));
                    if result != Err(Error::UnknownOutcome)
                        && let Ok(mut state) = service.0.refreshes.lock()
                    {
                        state.pending.remove(&key);
                    }
                }));
                receiver
            }
        };
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result;
            }
            receiver
                .changed()
                .await
                .map_err(|_| Error::UnknownOutcome)?;
        }
    }
    async fn perform_refresh(
        &self,
        expected: Info,
        now: i64,
        refresh: impl Future<Output = Result<Secret, Error>>,
    ) -> RefreshResult {
        let before = self.get(expected.id())?;
        if !before.as_ref().is_some_and(|row| {
            row.generation() == expected.generation()
                && row.account_generation() == expected.account_generation()
        }) {
            return self.rotated(&expected, now);
        }
        let value = match refresh.await {
            Ok(value) => value,
            Err(error) => {
                return self
                    .rotated(&expected, now)?
                    .map_or(Err(error), |row| Ok(Some(row)));
            }
        };
        if !matches!(
            value.domain().map_err(|_| Error::InvalidCredential)?,
            credential::Value::OAuth(_)
        ) {
            return Err(Error::InvalidCredential);
        }
        let compare = expected.clone();
        let updated = self
            .0
            .store
            .submit(move |tx| {
                let Some(mut row) = tx.get::<CredentialTable>(&identity(compare.id()))? else {
                    return Ok(None);
                };
                if row.generation != compare.generation()
                    || row.account_generation != compare.account_generation()
                {
                    return Ok(None);
                }
                row.value = value;
                row.generation = increment(tx, row.generation)?;
                row.time_updated = now;
                CredentialTable::put(tx, &row)?;
                Ok(Some(Info(row)))
            })?
            .await?;
        if updated.is_some() {
            return Ok(updated);
        }
        self.rotated(&expected, now)
    }
    fn rotated(&self, expected: &Info, now: i64) -> RefreshResult {
        let Some(row) = self.get(expected.id())? else {
            return Ok(None);
        };
        if row.integration_id() != expected.integration_id()
            || row.account_generation() != expected.account_generation()
            || row.generation() <= expected.generation()
        {
            return Ok(None);
        }
        let current = row
            .secret()
            .domain()
            .map_err(|_| Error::InvalidCredential)?;
        let old = expected
            .secret()
            .domain()
            .map_err(|_| Error::InvalidCredential)?;
        if matches!((current, old), (credential::Value::OAuth(current), credential::Value::OAuth(old)) if current.method_id == old.method_id && current.expires.get() > now.saturating_add(300_000))
        {
            return Ok(Some(row));
        }
        Ok(None)
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        let tasks = {
            let mut state = self.0.refreshes.lock().map_err(|_| Error::Closed)?;
            state.closed = true;
            std::mem::take(&mut state.tasks)
        };
        for task in &tasks {
            task.abort();
        }
        let mut failed = false;
        for task in tasks {
            failed |= task.await.is_err_and(|error| !error.is_cancelled());
        }
        if failed {
            return Err(Error::UnknownOutcome);
        }
        Ok(())
    }
}

fn identity(id: &LosslessString) -> Vec<u8> {
    tuple_key(&[KeyPart::String(id)])
}
fn increment(tx: &mut Write<'_>, value: i64) -> Result<i64, ycoding_store::Error> {
    value.checked_add(1).ok_or_else(|| {
        tx.reject(ycoding_store::Error::Rejected(
            "credential generation exhausted",
        ))
    })
}
fn transaction_rows(tx: &mut Write<'_>) -> Result<Vec<Credential>, ycoding_store::Error> {
    let mut rows = Vec::new();
    let mut cursor = None;
    loop {
        let page = tx.scan::<CredentialTable>(
            cursor.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
            Bound::Unbounded,
            128,
        )?;
        let last = page.last().map(CredentialTable::primary_key);
        rows.extend(page);
        if last.is_none() {
            break;
        }
        cursor = last;
    }
    Ok(rows)
}
