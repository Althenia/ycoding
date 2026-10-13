use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;
use ycoding_core::resources::model::quota::{Cache, Error, normalize_openrouter};
use ycoding_schema::{DomainEncode, parse_json, provider};

fn snapshot() -> ycoding_schema::provider_usage::Snapshot {
    normalize_openrouter(provider::Id("openrouter".into()), "OpenRouter", 100, &parse_json(r#"{"data":{"usage_daily":0,"limit":null,"limit_remaining":null,"is_free_tier":false}}"#).unwrap(), None).unwrap()
}

#[test]
fn quota_absent_is_not_zero_and_payload_is_not_exposed() {
    let result = snapshot();
    assert_eq!(result.windows.len(), 1);
    assert_eq!(result.windows[0].used, Some(0.0));
    assert_eq!(result.windows[0].limit, None);
    assert_eq!(result.windows[0].remaining, None);
    assert_eq!(result.source, "provider_api".into());
    assert_eq!(result.stability, "stable".into());
    let encoded = result.encode();
    assert!(!format!("{encoded:?}").contains("is_free_tier"));
    assert!(
        normalize_openrouter(
            provider::Id("openrouter".into()),
            "OpenRouter",
            100,
            &parse_json(r#"{"data":{"usage_daily":-1}}"#).unwrap(),
            None
        )
        .is_err()
    );
}

#[tokio::test]
async fn coalesces_refresh_and_preserves_stale_values_without_masking_initial_error() {
    let cache = Cache::new();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let first = {
        let cache = cache.clone();
        let entered = entered.clone();
        let release = release.clone();
        let calls = calls.clone();
        tokio::spawn(async move {
            cache
                .get("fixture".into(), 100, 60_000, false, move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    entered.notify_one();
                    release.notified().await;
                    Ok(snapshot())
                })
                .await
        })
    };
    entered.notified().await;
    let mut second = Box::pin({
        let cache = cache.clone();
        let calls = calls.clone();
        async move {
            cache
                .get("fixture".into(), 100, 60_000, true, move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(snapshot())
                })
                .await
        }
    });
    tokio::select! { biased; _ = &mut second => panic!("refresh must join pending load"), _ = std::future::ready(()) => {} }
    release.notify_one();
    assert_eq!(first.await.unwrap().unwrap().status, "available".into());
    assert_eq!(second.await.unwrap().status, "available".into());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let stale = cache
        .get("fixture".into(), 70_000, 60_000, true, || async {
            Err(Error::Request(Some(503)))
        })
        .await
        .unwrap();
    assert_eq!(stale.status, "stale".into());
    assert_eq!(stale.windows[0].used, Some(0.0));
    assert_eq!(stale.message, Some("Provider usage refresh failed".into()));
    assert_eq!(
        cache
            .get("empty".into(), 0, 60_000, false, || async {
                Err(Error::Request(Some(401)))
            })
            .await
            .unwrap_err(),
        Error::Request(Some(401))
    );
    cache.shutdown().await.unwrap();
}
