use super::models::{PACKAGE_NAME, PROVIDER_ID};
use crate::resources::{
    catalog::{Catalog, ProviderRecord, object},
    credential,
};
use std::future::Future;
use ycoding_ai::cursor::models::Info;
use ycoding_schema::{DomainDecode, DomainEncode, model, provider};

pub const RECONCILE_INTERVAL_SECONDS: u64 = 60;

pub struct Connection {
    pub credential: Option<credential::Info>,
    pub token: String,
}

#[derive(Clone, PartialEq)]
pub struct Account {
    pub credential: Option<credential::Info>,
    pub models: Vec<model::Info>,
}

pub struct Loaded {
    pub accounts: Vec<Account>,
    pub source: Option<String>,
}

pub async fn load<F, Fut, E>(
    previous: &[Account],
    connections: Vec<Connection>,
    source: String,
    discover: F,
) -> Loaded
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Result<Vec<Info>, E>>,
{
    let mut failed = false;
    let mut accounts = Vec::new();
    for connection in connections {
        let models = match discover(connection.token).await {
            Ok(models) => super::models::from_cursor(&models),
            Err(_) => {
                failed = true;
                previous
                    .iter()
                    .find(|account| same_account(&account.credential, &connection.credential))
                    .map_or_else(Vec::new, |account| account.models.clone())
            }
        };
        accounts.push(Account {
            credential: connection.credential,
            models,
        });
    }
    Loaded {
        accounts,
        source: (!failed).then_some(source),
    }
}

pub fn source(credentials: &[credential::Info], env_key: Option<&str>) -> String {
    ycoding_schema::stringify_json(&object(&[
        (
            "credentials",
            ycoding_schema::JsonValue::Array(
                credentials
                    .iter()
                    .map(|credential| {
                        object(&[
                            ("id", credential.id().encode()),
                            ("generation", (credential.generation() as f64).encode()),
                            (
                                "accountGeneration",
                                (credential.account_generation() as f64).encode(),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "env",
            env_key.map_or(ycoding_schema::JsonValue::Null, |key| key.encode()),
        ),
    ]))
}

pub fn publish(catalog: &mut Catalog, accounts: &[Account]) {
    let mut models = Vec::<model::Info>::new();
    for model in accounts.iter().flat_map(|account| &account.models) {
        match models.iter_mut().find(|existing| existing.id == model.id) {
            Some(existing) => *existing = model.clone(),
            None => models.push(model.clone()),
        }
    }
    sync(catalog, models);
    let id = provider::Id(PROVIDER_ID.into());
    catalog.account_clear(&id);
    for account in accounts {
        if let Some(credential) = &account.credential {
            catalog.account_update(credential, id.clone(), account.models.clone());
        }
    }
}

pub fn sync(catalog: &mut Catalog, models: Vec<model::Info>) {
    let id = provider::Id(PROVIDER_ID.into());
    let package = format!("aisdk:{PACKAGE_NAME}");
    let info = provider::Info::decode(&object(&[
        ("id", id.encode()),
        ("name", "Cursor".encode()),
        ("integrationID", PROVIDER_ID.encode()),
        ("package", package.as_str().encode()),
    ]))
    .expect("static Cursor provider is valid");
    match catalog
        .providers
        .iter_mut()
        .find(|record| record.provider.id == id)
    {
        Some(record) => {
            record.provider.name = info.name;
            record.provider.package = info.package;
            record.provider.integration_id = info.integration_id;
            record.models = models;
        }
        None => catalog.providers.push(ProviderRecord {
            provider: info,
            models,
            environment: vec![],
        }),
    }
}

fn same_account(left: &Option<credential::Info>, right: &Option<credential::Info>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => {
            left.id() == right.id() && left.account_generation() == right.account_generation()
        }
        (None, None) => true,
        _ => false,
    }
}
