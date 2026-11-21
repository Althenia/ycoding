use super::{Binding, Error, Info, Service, identity, transaction_rows};
use ycoding_schema::{
    DomainEncode, JsonObject, JsonValue, LosslessString, schema::NonNegativeInt, session_event,
};
use ycoding_store::session::{Document, NewEvent, SessionTable, append};

impl Binding {
    pub fn domain(&self) -> Result<session_event::ProfileBinding, Error> {
        Ok(session_event::ProfileBinding {
            provider_id: ycoding_schema::provider::Id(self.provider.clone()),
            integration_id: ycoding_schema::integration_id::IntegrationId::new(
                self.integration.clone(),
            )
            .map_err(|_| Error::ProfileUnavailable)?,
            profile: ycoding_schema::model::ProfileName(self.profile.clone()),
            credential_id: ycoding_schema::credential::Id(self.credential.clone()),
            account_generation: NonNegativeInt::new(self.account_generation)
                .map_err(|_| Error::ProfileUnavailable)?,
        })
    }
    pub fn from_domain(binding: session_event::ProfileBinding) -> Self {
        Self {
            provider: binding.provider_id.0,
            integration: binding.integration_id.as_lossless().clone(),
            profile: binding.profile.0,
            credential: binding.credential_id.0,
            account_generation: binding.account_generation.get(),
        }
    }
}
impl Service {
    pub fn resolve_session(
        &self,
        session_id: &LosslessString,
        integration: &LosslessString,
        rebind: bool,
    ) -> Result<Option<(Info, Binding)>, Error> {
        let session = self
            .0
            .store
            .snapshot()?
            .get::<SessionTable>(&identity(session_id))?
            .ok_or(Error::ProfileUnavailable)?;
        let Some(model) = session.model.map(|model| model.domain()).transpose()? else {
            return Ok(None);
        };
        let Some(profile) = model.profile else {
            return Ok(None);
        };
        let binding = self.bind(model.provider_id.0, integration.clone(), profile.0.clone())?;
        if !rebind && let Some(saved) = session.profile_binding {
            let saved = Binding::from_domain(saved.domain()?);
            if saved.provider == binding.provider && saved.profile == binding.profile {
                let value =
                    self.resolve_selection(&binding.provider, integration, &profile.0, &saved)?;
                return Ok(Some((value, saved)));
            }
        }
        Ok(Some((self.resolve_binding(&binding)?, binding)))
    }
    pub async fn publish_binding(
        &self,
        session_id: LosslessString,
        event_id: LosslessString,
        binding: Option<Binding>,
        time: i64,
    ) -> Result<(), Error> {
        self.0
            .store
            .submit(move |tx| {
                let mut session =
                    tx.get::<SessionTable>(&identity(&session_id))?
                        .ok_or_else(|| {
                            tx.reject(ycoding_store::Error::Rejected(
                                "Session profile is unavailable",
                            ))
                        })?;
                if let Some(binding) = &binding {
                    let matching = transaction_rows(tx)?
                        .into_iter()
                        .filter(|row| {
                            row.integration_id.as_ref() == Some(&binding.integration)
                                && row.label == binding.profile
                        })
                        .collect::<Vec<_>>();
                    if matching.len() != 1
                        || matching[0].id != binding.credential
                        || matching[0].account_generation != binding.account_generation
                    {
                        return Err(tx.reject(ycoding_store::Error::Rejected(
                            "Session profile is unavailable",
                        )));
                    }
                    let model = session.model.as_ref().map(Document::domain).transpose()?;
                    if !model.is_some_and(|model| {
                        model.provider_id.0 == binding.provider
                            && model
                                .profile
                                .is_some_and(|profile| profile.0 == binding.profile)
                    }) {
                        return Err(tx.reject(ycoding_store::Error::Rejected(
                            "Session profile is unavailable",
                        )));
                    }
                }
                let binding = binding
                    .map(|binding| binding.domain())
                    .transpose()
                    .map_err(|_| {
                        tx.reject(ycoding_store::Error::Rejected(
                            "Session profile is unavailable",
                        ))
                    })?;
                let mut data = JsonObject::new();
                data.insert("sessionID".into(), JsonValue::String(session_id.clone()));
                if let Some(binding) = &binding {
                    data.insert("binding".into(), binding.encode());
                }
                append(
                    tx,
                    &NewEvent {
                        id: event_id,
                        aggregate_id: session_id,
                        created: time,
                        type_: "session.profile.bound".into(),
                        data: JsonValue::Object(data),
                    },
                    None,
                )?;
                session.profile_binding =
                    binding.as_ref().map(Document::from_domain).transpose()?;
                SessionTable::put(tx, &session)
            })?
            .await
            .map_err(Error::from)
    }
}
