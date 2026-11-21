use ycoding_core::resources::{
    catalog::{Catalog, models_dev},
    model::{Error, Resolver},
};
use ycoding_schema::{DomainDecode, model, parse_json, provider};

fn catalog(doc: &str) -> Catalog {
    let mut result = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    result.configure(&[parse_json(doc).unwrap()]).unwrap();
    result
}
fn selection(id: &str, variant: Option<&str>) -> model::Ref {
    model::Ref {
        provider_id: provider::Id("openai".into()),
        id: id.into(),
        variant: variant.map(Into::into),
        profile: None,
    }
}

#[test]
fn location_specific_resolution_and_variant_errors() {
    let first = Resolver::new(catalog(
        r#"{"providers":{"openai":{"settings":{"apiKey":"fixture","baseURL":"http://127.0.0.1:1/first"}}}}"#,
    ));
    let second = Resolver::new(catalog(
        r#"{"providers":{"openai":{"settings":{"apiKey":"fixture","baseURL":"http://127.0.0.1:1/second"}}}}"#,
    ));
    let resolved = first
        .resolve(&selection("gpt-reasoning", Some("high")), &[], None)
        .unwrap();
    assert_eq!(
        resolved.info.settings.unwrap().0.get(&"baseURL".into()),
        Some(&parse_json(r#""http://127.0.0.1:1/first""#).unwrap())
    );
    let other = second
        .resolve(&selection("gpt-reasoning", None), &[], None)
        .unwrap();
    assert_eq!(
        other.info.settings.unwrap().0.get(&"baseURL".into()),
        Some(&parse_json(r#""http://127.0.0.1:1/second""#).unwrap())
    );
    assert_eq!(
        first
            .resolve(&selection("missing", None), &[], None)
            .unwrap_err(),
        Error::ModelUnavailable
    );
    assert_eq!(
        first
            .resolve(&selection("gpt-reasoning", Some("missing")), &[], None)
            .unwrap_err(),
        Error::VariantUnavailable
    );
}

#[test]
fn configured_default_and_disabled_provider_do_not_execute() {
    let mut catalog = catalog(
        r#"{"model":{"providerID":"openai","model":"gpt-reasoning","variant":"high"},"providers":{"openai":{"settings":{"apiKey":"fixture"}}}}"#,
    );
    assert_eq!(
        catalog.default_selection(&[]).unwrap(),
        selection("gpt-reasoning", Some("high"))
    );
    catalog.set_disabled(&provider::Id("openai".into()), true);
    assert!(catalog.default_selection(&[]).is_none());
    assert_eq!(
        Resolver::new(catalog)
            .resolve(&selection("gpt-reasoning", None), &[], None)
            .unwrap_err(),
        Error::ModelUnavailable
    );
    assert!(
        model::Ref::decode(&parse_json(r#"{"providerID":1,"id":"invalid"}"#).unwrap()).is_err()
    );
}
