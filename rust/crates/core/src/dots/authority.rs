use super::{
    access,
    native::{Configuration, Pins},
};
use crate::{
    resources::config,
    session::{key, projector},
};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};
use ycoding_schema::{
    DomainEncode, JsonValue, LosslessString, ObjectEncoder, credential, form, session,
};
use ycoding_store::{
    Client, Write,
    resources::CredentialTable,
    session::{NewEvent, SequenceTable, SessionTable},
};

pub(crate) struct Lifetime {
    pub(crate) active: bool,
    pub(crate) stops: Vec<Box<dyn FnOnce() + Send>>,
}
impl Lifetime {
    pub(crate) fn new() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self {
            active: true,
            stops: Vec::new(),
        }))
    }
    pub(crate) fn retire(lifetime: &Arc<Mutex<Self>>) {
        let stops = {
            let mut lifetime = lifetime.lock().unwrap_or_else(|error| error.into_inner());
            if !lifetime.active {
                return;
            }
            lifetime.active = false;
            std::mem::take(&mut lifetime.stops)
        };
        for stop in stops {
            stop();
        }
    }
}

#[derive(Clone)]
pub(crate) struct Gate {
    pub(crate) configuration: Configuration,
    pub(crate) global: Arc<config::Configuration>,
    pub(crate) pins: Pins,
    pub(crate) lifetimes: Vec<Arc<Mutex<Lifetime>>>,
    pub(crate) root: Option<session::Id>,
    pub(crate) source: Option<form::NativeReplySource>,
    pub(crate) current: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}
impl Gate {
    pub(crate) fn with<T>(
        &self,
        tx: &mut Write<'_>,
        owner: Option<&session::Id>,
        apply: impl FnOnce(&mut Write<'_>) -> Result<T, ycoding_store::Error>,
    ) -> Result<T, ycoding_store::Error> {
        let lifetimes = self
            .lifetimes
            .iter()
            .map(|lifetime| lifetime.lock().unwrap_or_else(|error| error.into_inner()))
            .collect::<Vec<_>>();
        if lifetimes.iter().any(|lifetime| !lifetime.active) || !(self.pins.is_current)() {
            return Err(unavailable());
        }
        if self.current.as_ref().is_some_and(|current| !current()) {
            return Err(unavailable());
        }
        let Configuration::Enabled {
            access_revision,
            profile,
            credential_id,
            account_id,
            account_generation,
        } = &self.configuration
        else {
            return Err(unavailable());
        };
        let preference = access::read_in(tx).map_err(|_| unavailable())?;
        if !preference.enabled
            || preference.revision != *access_revision
            || self
                .global
                .native_dots_profile()
                .map_err(|_| unavailable())?
                .as_deref()
                != Some(profile)
        {
            return Err(unavailable());
        }
        let stored = tx
            .get::<CredentialTable>(&key(&credential_id.as_str().into()))?
            .ok_or_else(unavailable)?;
        if stored
            .integration_id
            .as_ref()
            .and_then(|value| value.as_str())
            != Some("openai")
            || stored.label.as_str() != Some(profile)
            || stored.account_generation != *account_generation
        {
            return Err(unavailable());
        }
        let credential::Value::OAuth(value) = stored.value.domain()? else {
            return Err(unavailable());
        };
        if account(&value).as_deref() != Some(account_id) {
            return Err(unavailable());
        }
        let mut seen = BTreeSet::new();
        let rows = tx.scan::<CredentialTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            usize::MAX,
        )?;
        if rows
            .iter()
            .filter(|row| {
                row.integration_id.as_ref().and_then(|value| value.as_str()) == Some("openai")
                    && row.label.as_str() == Some(profile)
            })
            .count()
            != 1
        {
            return Err(unavailable());
        }
        if let Some(owner) = owner {
            let mut id = owner.as_lossless().clone();
            loop {
                if seen.len() >= 64 || !seen.insert(id.clone()) {
                    return Err(unavailable());
                }
                let row = tx.get::<SessionTable>(&key(&id))?.ok_or_else(unavailable)?;
                if row.time_archived.is_some()
                    || tx
                        .get::<SequenceTable>(&key(&id))?
                        .is_some_and(|sequence| sequence.owner_id.is_some())
                {
                    return Err(unavailable());
                }
                match row.parent_id.filter(|value| !value.is_empty()) {
                    Some(parent) => id = parent,
                    None => {
                        if self.root.as_ref().map(session::Id::as_lossless) != Some(&id) {
                            return Err(unavailable());
                        }
                        break;
                    }
                }
            }
        }
        apply(tx)
    }
    pub(crate) fn append_receipt(
        &self,
        tx: &mut Write<'_>,
        owner: &session::Id,
        target: JsonValue,
        reply: Option<&str>,
    ) -> Result<(), ycoding_store::Error> {
        let source = self.source.as_ref().ok_or_else(unavailable)?;
        projector::append(
            tx,
            &NewEvent {
                id: projector::random_event_id()?.as_lossless().clone(),
                aggregate_id: owner.as_lossless().clone(),
                created: chrono::Utc::now().timestamp_millis(),
                type_: "session.dots.decision.settled.1".into(),
                data: ObjectEncoder::new()
                    .field("sessionID", owner)
                    .field("source", source)
                    .field("target", &target)
                    .optional("reply", &reply.map(LosslessString::from))
                    .finish(),
            },
        )
        .map(|_| ())
    }
    pub(crate) fn receipt(
        &self,
        client: &Client,
        owner: &session::Id,
        target: JsonValue,
        reply: Option<&str>,
    ) -> Result<(), ycoding_store::Error> {
        self.receipt_checked(client, owner, target, reply, || Ok(true))
    }
    pub(crate) fn receipt_checked(
        &self,
        client: &Client,
        owner: &session::Id,
        target: JsonValue,
        reply: Option<&str>,
        eligible: impl FnOnce() -> Result<bool, String> + Send + 'static,
    ) -> Result<(), ycoding_store::Error> {
        let gate = self.clone();
        let owner = owner.clone();
        let source = self.source.clone().ok_or_else(unavailable)?;
        let reply = reply.map(str::to_owned);
        client
            .submit(move |tx| {
                gate.with(tx, Some(&owner), |tx| {
                    if !eligible().map_err(|_| unavailable())? {
                        return Err(unavailable());
                    }
                    projector::append(
                        tx,
                        &NewEvent {
                            id: projector::random_event_id()?.as_lossless().clone(),
                            aggregate_id: owner.as_lossless().clone(),
                            created: chrono::Utc::now().timestamp_millis(),
                            type_: "session.dots.decision.settled.1".into(),
                            data: ObjectEncoder::new()
                                .field("sessionID", &owner)
                                .field("source", &source)
                                .field("target", &target)
                                .optional("reply", &reply.as_deref().map(LosslessString::from))
                                .finish(),
                        },
                    )
                    .map(|_| ())
                })
            })?
            .wait()
    }
}

pub(crate) fn account(value: &credential::OAuth) -> Option<String> {
    if !matches!(
        value.method_id.as_lossless().as_str(),
        Some("chatgpt-browser" | "chatgpt-headless")
    ) {
        return None;
    }
    value
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get(&"accountID".into()))
        .and_then(|value| match value {
            JsonValue::String(value) => value
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            _ => None,
        })
}
pub(crate) fn unavailable() -> ycoding_store::Error {
    ycoding_store::Error::Domain {
        kind: "dots_unavailable",
        message: "Native Session access is unavailable",
    }
}
pub(crate) fn fingerprint(value: &impl DomainEncode) -> String {
    crate::session::prompt_cache::sha256(&crate::session::prompt_cache::canonical_json(
        &value.encode(),
    ))
}

#[derive(Clone)]
pub struct Admission {
    pub(crate) gate: Gate,
}
impl Admission {
    pub async fn admit_input(
        &self,
        store: &crate::session::store::Service,
        mut request: crate::session::pending::Request,
    ) -> Result<crate::session::pending::Admitted, ycoding_store::Error> {
        self.validate(store, Some(&request.session_id))?;
        if let ycoding_schema::session_pending::Message::User(user) = &mut request.input {
            let previous = user.data.metadata.take().unwrap_or_default();
            let mut metadata = ycoding_schema::JsonObject::new();
            for (key, value) in previous
                .iter()
                .filter(|(key, _)| key.as_str() != Some("nativeSource"))
            {
                metadata.insert(key.clone(), value.clone());
            }
            metadata.insert("inputOrigin".into(), "direct".encode());
            if let Some(source) = self.source() {
                metadata.insert("nativeSource".into(), source.encode());
            }
            user.data.metadata = Some(metadata);
        }
        store
            .admit_input_checked(
                request,
                None,
                Some(crate::session::pending::CheckedAdmission::Native(Box::new(
                    self.clone(),
                ))),
            )
            .await
    }
    pub fn validate(
        &self,
        store: &crate::session::store::Service,
        owner: Option<&session::Id>,
    ) -> Result<(), ycoding_store::Error> {
        let admission = self.clone();
        let owner = owner.cloned();
        store
            .client
            .submit(move |tx| admission.validate_in(tx, owner.as_ref()))?
            .wait()
    }
    pub fn validate_in(
        &self,
        tx: &mut Write<'_>,
        owner: Option<&session::Id>,
    ) -> Result<(), ycoding_store::Error> {
        self.gate.with(tx, owner, |_| Ok(()))
    }
    pub fn source(&self) -> Option<&form::NativeReplySource> {
        self.gate.source.as_ref()
    }
}
