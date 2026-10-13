use std::sync::Arc;
use ycoding_core::resources::{auth::integration, catalog::Catalog, credential, generate, model};
use ycoding_schema::{DomainEncode, credential::Value, model::Ref, parse_json, provider};
use ycoding_store::{Metadata, Options, Store, resources};

fn service(catalog: Catalog) -> (Store, generate::Service) {
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([32; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let service = generate::Service {
        models: Arc::new(model::Resolver::new(catalog)),
        integrations: integration::Registry::new(credentials.clone(), Default::default()),
        credentials,
        executor: Arc::new(generate::Executor::new(
            generate::Executor::http_client().unwrap(),
        )),
        cursor: None,
    };
    (store, service)
}

fn catalog() -> Catalog {
    let mut catalog = Catalog::default();
    catalog.configure(&[parse_json(r#"{"providers":{"fixture":{"package":"@ycoding-ai/ai/providers/openai-compatible","models":{"code":{"name":"Code","capabilities":{"input":["text"],"output":["text"]},"variants":[{"id":"high","body":{"temperature":0.2}}]}}}}}"#).unwrap()]).unwrap();
    catalog
}

fn input(profile: Option<&str>, variant: Option<&str>) -> generate::Input {
    generate::Input {
        prompt: "Write a short answer".into(),
        model: Some(Ref {
            provider_id: provider::Id("fixture".into()),
            id: "code".into(),
            profile: profile.map(|name| ycoding_schema::model::ProfileName(name.into())),
            variant: variant.map(Into::into),
        }),
    }
}

#[tokio::test]
async fn empty_and_missing_models_report_selection_errors_without_provider_traffic() {
    let (_store, service) = service(Catalog::default());
    assert_eq!(
        service
            .text(generate::Input {
                prompt: "p".into(),
                model: None
            })
            .await,
        Err(generate::Error::Selection(
            "No model specified and no supported model is available".into()
        ))
    );
    assert_eq!(
        service.text(input(None, None)).await,
        Err(generate::Error::Selection(
            "Model unavailable: fixture/code".into()
        ))
    );
}

#[tokio::test]
async fn explicit_profiles_and_variants_never_fall_back() {
    let (_store, service) = service(catalog());
    assert_eq!(
        service.text(input(Some("missing"), None)).await,
        Err(generate::Error::Selection(
            "Profile unavailable for fixture: missing".into()
        ))
    );
    assert_eq!(
        service.text(input(None, Some("missing"))).await,
        Err(generate::Error::Selection(
            "Variant unavailable for fixture/code: missing".into()
        ))
    );
}

#[tokio::test]
async fn unsupported_loading_uses_explicit_vs_implicit_error_contract() {
    let mut catalog = catalog();
    catalog.providers[0].provider.package = "unsupported-package".into();
    catalog.set_default(Some(input(None, None).model.unwrap()));
    let (_store, service) = service(catalog);
    assert_eq!(
        service.text(input(None, None)).await,
        Err(generate::Error::Selection(
            "Unsupported package for fixture/code: unsupported-package".into()
        ))
    );
    assert_eq!(
        service
            .text(generate::Input {
                prompt: "p".into(),
                model: None
            })
            .await,
        Err(generate::Error::Unavailable {
            message: "Unsupported package for fixture/code: unsupported-package".into(),
            service: Some("fixture".into())
        })
    );
}

#[tokio::test]
async fn duplicate_profile_labels_are_rejected_before_snapshot_or_execution() {
    let (store, service) = service(catalog());
    let secret = resources::Secret::new(
        Value::Key(ycoding_schema::credential::Key {
            key: "synthetic-key".into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    service
        .credentials
        .create(
            "one".into(),
            "fixture".into(),
            Some("Work".into()),
            secret.clone(),
            1,
        )
        .await
        .unwrap();
    store
        .client()
        .submit(move |tx| {
            resources::CredentialTable::insert(
                tx,
                &resources::Credential {
                    id: "two".into(),
                    integration_id: Some("fixture".into()),
                    label: "Work".into(),
                    value: secret,
                    connector_id: None,
                    method_id: None,
                    active: Some(0),
                    generation: 0,
                    account_generation: 0,
                    time_created: 2,
                    time_updated: 2,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    assert_eq!(
        service.text(input(Some("Work"), None)).await,
        Err(generate::Error::Selection(
            "Profile unavailable for fixture: Work".into()
        ))
    );
}
