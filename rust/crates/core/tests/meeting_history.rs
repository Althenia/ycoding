use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use ycoding_core::meeting::BoxFuture;
use ycoding_core::meeting::config::{MeetingConfig, TranscriptionConfig};
use ycoding_core::meeting::history;
use ycoding_core::meeting::pcm::AudioChunk;
use ycoding_core::meeting::runtime::ProviderFactory;
use ycoding_core::meeting::service::{MeetingService, ServiceOptions};
use ycoding_core::meeting::store::{MeetingDatabase, from_store, to_store};
use ycoding_core::meeting::transcription::{
    Health, TranscribeContext, Transcript, TranscriptionError, TranscriptionProvider,
};
use ycoding_core::resources::{config::Roots, tool_output_store::Store};
use ycoding_core::tools::{context::Context, registry::Registry};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Silent;

impl TranscriptionProvider for Silent {
    fn id(&self) -> &str {
        "huggingface"
    }
    fn initialize<'a>(
        &'a self,
        _: &'a TranscriptionConfig,
    ) -> BoxFuture<'a, Result<(), TranscriptionError>> {
        Box::pin(async { Ok(()) })
    }
    fn transcribe<'a>(
        &'a self,
        _: &'a AudioChunk,
        _: TranscribeContext,
    ) -> BoxFuture<'a, Result<Vec<Transcript>, TranscriptionError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn health_check(&self) -> BoxFuture<'_, Result<Health, TranscriptionError>> {
        Box::pin(async {
            Ok(Health {
                healthy: true,
                initialized: true,
                metrics: None,
            })
        })
    }
    fn dispose(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

fn registry(root: &std::path::Path) -> Registry {
    Registry::new(
        Arc::new(Store::new(&Roots::development(root).unwrap())),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    )
}

async fn call(registry: &Registry, input: Value) -> Result<Value, String> {
    let settlement = registry
        .materialize(&[])
        .invoke(
            history::NAME,
            to_store(&input).unwrap(),
            Context::new("ses_history", "build", "msg_history", "call-history").unwrap(),
        )
        .await
        .map_err(|error| format!("{error:?}"))?;
    if let Some(error) = settlement.error {
        return Err(format!("{error:?}"));
    }
    let output = settlement.output.ok_or("missing output")?;
    Ok(from_store(&output.structured).unwrap())
}

#[tokio::test]
async fn meeting_history_is_registered_through_the_core_registry_and_reads_retained_evidence() {
    let root = std::env::temp_dir().join(format!(
        "ycoding-meeting-history-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    let database = MeetingDatabase::open(&root.join("meetings.redb")).unwrap();
    for (id, title) in [("one", "Design review"), ("two", "Budget")] {
        database.create_meeting(id, title, "session").await.unwrap();
    }
    for sequence in 1..=3u64 {
        database
            .put_segment(&json!({
                "id": format!("s{sequence}"), "meetingID": "one", "sequence": sequence, "source": "remote",
                "speakerID": "remote-unknown", "startMs": 0, "endMs": 900, "rawText": "text", "text": "text",
                "state": "final", "model": "m", "createdAt": "2026-10-12T00:00:00.000Z",
            }))
            .await
            .unwrap();
    }
    database
        .put_checkpoint(&json!({
            "id": "c", "meetingID": "one", "throughSequence": 3, "summary": "Summary", "final": true,
            "createdAt": "2026-10-12T00:00:00.000Z", "latencyMs": 1,
        }))
        .await
        .unwrap();
    let registry = registry(&root);
    let registration = history::register(&registry, database.clone()).unwrap();

    let definitions = registry.materialize(&[]).definitions;
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].name.as_str(), Some(history::NAME));
    assert!(
        definitions[0]
            .description
            .as_str()
            .unwrap()
            .contains("No capture, model download, approval")
    );

    let listed = call(&registry, json!({})).await.unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let filtered = call(&registry, json!({ "query": "BUDGET" })).await.unwrap();
    assert_eq!(filtered[0]["id"], "two");
    let detail = call(&registry, json!({ "meetingID": "one" }))
        .await
        .unwrap();
    assert_eq!(detail["meeting"]["title"], "Design review");
    assert_eq!(detail["segments"].as_array().unwrap().len(), 3);
    assert_eq!(detail["summary"]["summary"], "Summary");
    assert_eq!(detail["findings"], json!([]));
    let paged = call(&registry, json!({ "meetingID": "one", "after": 2 }))
        .await
        .unwrap();
    assert_eq!(paged["segments"].as_array().unwrap().len(), 1);
    let unknown = call(&registry, json!({ "meetingID": "missing" }))
        .await
        .unwrap();
    assert!(unknown.get("meeting").is_none() && unknown.get("summary").is_none());
    for invalid in [
        json!({ "extra": 1 }),
        json!({ "after": -1 }),
        json!({ "query": "x".repeat(201) }),
        json!({ "meetingID": 5 }),
    ] {
        assert!(call(&registry, invalid.clone()).await.is_err(), "{invalid}");
    }

    drop(registration);
    assert!(registry.materialize(&[]).definitions.is_empty());
    database.close().await.unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn the_service_registers_the_tool_and_disposes_it_on_shutdown() {
    let root = std::env::temp_dir().join(format!(
        "ycoding-meeting-history-service-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let factory: ProviderFactory =
        Arc::new(|_| Ok(Arc::new(Silent) as Arc<dyn TranscriptionProvider>));
    let mut options = ServiceOptions::new(
        root.join("meeting"),
        MeetingConfig::parse(&json!({})).unwrap(),
        Arc::new(|_, _| Box::pin(async { Ok("session".to_owned()) })),
    );
    options.provider_factory = Some(factory);
    let service = MeetingService::start(options).await.unwrap();
    let registry = registry(&root);
    service.register_history(&registry).unwrap();
    assert_eq!(registry.materialize(&[]).definitions.len(), 1);
    assert!(service.register_history(&registry).is_ok());
    tokio::time::timeout(Duration::from_secs(20), service.shutdown())
        .await
        .expect("shutdown exceeded 20 seconds")
        .unwrap();
    assert!(registry.materialize(&[]).definitions.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}
