use ycoding_core::{resources::model::quota, session::store, usage_view};
use ycoding_schema::{location, provider, schema::NonNegativeInt};
use ycoding_store::Client;

pub async fn publish(
    client: &Client,
    usage: &quota::Service,
    providers: &[provider::Id],
    location: &location::Ref,
    now: i64,
) -> std::sync::Arc<quota::forecast::Publication> {
    let _reports = super::report_support::start(client.clone());
    let views = usage_view::Service::new(store::Service::new(client.clone()), None);
    super::prepared_support::publish(client, &views);
    assert!(
        usage
            .publish(
                &views,
                location,
                0,
                providers,
                NonNegativeInt::new(now).unwrap()
            )
            .await
            .unwrap()
    );
    usage.prepared(location, 0).unwrap().unwrap()
}
