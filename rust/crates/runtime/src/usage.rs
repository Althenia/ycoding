use crate::{
    convert,
    dispatch::{Failure, Invocation},
    session_read_models,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Weak},
};
use ycoding_core::ycoding_store::Error;
use ycoding_core::{
    resources::{catalog::Catalog, credential},
    session::{
        prompt_cache,
        usage_read::{Pricing, PricingRef},
    },
    ycoding_schema::{JsonValue, LosslessString, ObjectEncoder},
};
use ycoding_protocol::v5;

#[derive(Default)]
pub(crate) struct PricingCache {
    locations: VecDeque<CachedLocation>,
}

struct CachedLocation {
    directory: ycoding_core::ycoding_schema::LosslessString,
    workspace: Option<ycoding_core::ycoding_schema::LosslessString>,
    catalog: Weak<Catalog>,
    accounts: String,
    entries: VecDeque<(PricingRef, Pricing)>,
}

impl PricingCache {
    pub(crate) fn get(
        &mut self,
        catalog: &Arc<Catalog>,
        accounts: &str,
        reference: &PricingRef,
    ) -> Option<Pricing> {
        let index = self.locations.iter().position(|location| {
            location.directory == reference.directory
                && location.workspace == reference.workspace_id
        })?;
        let mut location = self.locations.remove(index)?;
        if !location.catalog.ptr_eq(&Arc::downgrade(catalog)) || location.accounts != accounts {
            return None;
        }
        let value = location
            .entries
            .iter()
            .position(|(key, _)| key == reference)
            .and_then(|index| location.entries.remove(index));
        let result = value.as_ref().map(|(_, value)| value.clone());
        if let Some(value) = value {
            location.entries.push_back(value);
        }
        self.locations.push_back(location);
        result
    }

    pub(crate) fn store(
        &mut self,
        catalog: &Arc<Catalog>,
        accounts: &str,
        reference: &PricingRef,
        pricing: Pricing,
    ) {
        let existing = self
            .locations
            .iter()
            .position(|location| {
                location.directory == reference.directory
                    && location.workspace == reference.workspace_id
            })
            .and_then(|index| self.locations.remove(index))
            .filter(|location| {
                location.catalog.ptr_eq(&Arc::downgrade(catalog)) && location.accounts == accounts
            });
        let mut location = existing.unwrap_or_else(|| CachedLocation {
            directory: reference.directory.clone(),
            workspace: reference.workspace_id.clone(),
            catalog: Arc::downgrade(catalog),
            accounts: accounts.to_owned(),
            entries: VecDeque::new(),
        });
        location.entries.retain(|(key, _)| key != reference);
        location.entries.push_back((reference.clone(), pricing));
        if location.entries.len() > 256 {
            location.entries.pop_front();
        }
        self.locations.push_back(location);
        if self.locations.len() > 128 {
            self.locations.pop_front();
        }
    }
}

pub(crate) fn accounts_identity(saved: &[credential::Info]) -> String {
    prompt_cache::sha256(&prompt_cache::canonical_json(&JsonValue::Array(
        saved
            .iter()
            .map(|account| {
                ObjectEncoder::new()
                    .field("id", account.id())
                    .field("integration", account.integration_id())
                    .field(
                        "generation",
                        &LosslessString::from(account.account_generation().to_string()),
                    )
                    .field("profile", account.label())
                    .field("active", &account.active())
                    .finish()
            })
            .collect(),
    )))
}

pub async fn get(
    invocation: Invocation,
    _request: v5::UsageGetRequest,
) -> Result<v5::UsageGetResult, Failure> {
    let core = invocation.core()?;
    let sessions = core.sessions.clone();
    let pricer = core.usage_pricer.clone();
    let summary = tokio::task::spawn_blocking(move || {
        sessions.usage_all(pricer.as_deref().map(|pricer| pricer as &_))
    })
    .await
    .map_err(|_| Failure::Unavailable("Usage read worker unavailable".into()))?
    .map_err(failure)?;
    Ok(v5::UsageGetResult {
        data: convert::provider_summary(&summary).map_err(|_| {
            Failure::Unavailable("stored Session state is not representable on the wire".into())
        })?,
    })
}

pub async fn report(
    invocation: Invocation,
    request: v5::UsageReportRequest,
) -> Result<v5::UsageReportResult, Failure> {
    let core = invocation.core()?;
    let query = request.query;
    let input = session_read_models::report_input(&v5::SessionUsageReportRequestQuery {
        group: query.group,
        time_zone: query.time_zone,
        from: query.from,
        to: query.to,
        offset: query.offset,
        limit: query.limit,
        sort: query.sort,
        order: query.order,
    })?;
    let sessions = core.sessions.clone();
    let pricer = core.usage_pricer.clone();
    let report = tokio::task::spawn_blocking(move || {
        sessions.usage_report_all(&input, pricer.as_deref().map(|pricer| pricer as &_))
    })
    .await
    .map_err(|_| Failure::Unavailable("Usage read worker unavailable".into()))?
    .map_err(failure)?;
    Ok(v5::UsageReportResult {
        data: session_read_models::wire_report(&report)?,
    })
}

fn failure(error: Error) -> Failure {
    match error {
        Error::Rejected(message) => Failure::InvalidField {
            message: message.into(),
            field: "timeZone",
        },
        _ => Failure::Unavailable("Usage store unavailable".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::PricingCache;
    use ycoding_core::{
        resources::catalog::Catalog,
        session::usage_read::{Pricing, PricingRef},
    };

    fn reference(directory: &str, model: &str) -> PricingRef {
        PricingRef {
            directory: directory.into(),
            workspace_id: None,
            provider: "openai".into(),
            model: model.into(),
            profile: None,
        }
    }

    #[test]
    fn pricing_cache_follows_catalog_identity_and_bounds_locations_and_references() {
        let mut cache = PricingCache::default();
        let models = ycoding_core::resources::model::Resolver::new(Catalog::default());
        let catalog = models.catalog();
        models.replace(Catalog::default()).unwrap();
        let replacement = models.catalog();
        let key = reference("/project", "first");
        let price = || Pricing {
            provider: vec![],
            router: vec![],
        };
        assert!(cache.get(&catalog, "accounts", &key).is_none());
        cache.store(&catalog, "accounts", &key, price());
        assert!(cache.get(&catalog.clone(), "accounts", &key).is_some());
        assert!(cache.get(&catalog, "changed", &key).is_none());
        cache.store(&catalog, "accounts", &key, price());
        assert!(cache.get(&replacement, "accounts", &key).is_none());
        cache.store(&replacement, "accounts", &key, price());
        assert!(cache.get(&catalog, "accounts", &key).is_none());
        cache.store(&replacement, "accounts", &key, price());
        for index in 0..256 {
            cache.store(
                &replacement,
                "accounts",
                &reference("/project", &format!("model_{index}")),
                price(),
            );
        }
        assert!(cache.get(&replacement, "accounts", &key).is_none());
        assert!(
            cache
                .get(
                    &replacement,
                    "accounts",
                    &reference("/project", "model_255")
                )
                .is_some()
        );
        for index in 0..128 {
            cache.store(
                &replacement,
                "accounts",
                &reference(&format!("/project_{index}"), "model"),
                price(),
            );
        }
        assert!(
            cache
                .get(
                    &replacement,
                    "accounts",
                    &reference("/project", "model_255")
                )
                .is_none()
        );
        assert!(
            cache
                .get(
                    &replacement,
                    "accounts",
                    &reference("/project_127", "model")
                )
                .is_some()
        );
    }
}
