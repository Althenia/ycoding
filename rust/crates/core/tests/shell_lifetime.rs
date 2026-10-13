#![cfg(unix)]
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use ycoding_core::{
    platform::shell::{Event, Shell},
    resources::config::{Configuration, LoadOptions, Roots},
};
use ycoding_schema::{
    DomainDecode, parse_json,
    shell::{CreateInput, Status},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf, ycoding_store::Store);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-wp009-shell-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(
            root,
            ycoding_store::Store::disposable(
                ycoding_store::Options::core(),
                ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
                ycoding_store::Metadata::new([7; 16], 1),
            )
            .unwrap(),
        )
    }
    fn configuration(&self, text: &str) -> Configuration {
        Configuration::load(LoadOptions {
            directory: self.0.clone(),
            roots: Roots::development(&self.0).unwrap(),
            project: false,
            content: Some(text.into()),
            file: None,
            env: Default::default(),
        })
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn input(command: &str, timeout: u64, memory: Option<u64>) -> CreateInput {
    let mut value = ycoding_schema::JsonObject::new();
    value.insert(
        "command".into(),
        ycoding_schema::JsonValue::String(command.into()),
    );
    value.insert(
        "timeout".into(),
        ycoding_schema::JsonValue::Number(timeout as f64),
    );
    if let Some(memory) = memory {
        value.insert(
            "memoryLimitMb".into(),
            ycoding_schema::JsonValue::Number(memory as f64),
        );
    }
    CreateInput::decode(&ycoding_schema::JsonValue::Object(value)).unwrap()
}

#[tokio::test]
async fn fast_capture_wait_event_order_remove_and_single_use_preparation() {
    let fixture = Fixture::new();
    let config = fixture.configuration("{\"shell\":\"/bin/sh\"}");
    let shell = Shell::new(
        &Roots::development(&fixture.0).unwrap(),
        fixture.0.clone(),
        "project",
        fixture.1.client(),
    )
    .await
    .unwrap();
    let mut events = shell.subscribe();
    let mut prepared = shell
        .prepare(
            input("printf 'é€😀'; printf err >&2; exit 9", 0, None),
            &config,
        )
        .unwrap();
    let created = shell.create(&mut prepared).await.unwrap();
    assert!(shell.create(&mut prepared).await.is_err());
    assert!(matches!(events.recv().await.unwrap(), Event::Created(_)));
    let final_info = tokio::time::timeout(Duration::from_secs(5), shell.wait(&created.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(final_info.status, Status::Exited);
    assert_eq!(final_info.exit.unwrap().get(), 9.0);
    assert!(matches!(events.recv().await.unwrap(), Event::Exited(_)));
    assert!(shell.list().is_empty());
    let mut joined = String::new();
    let mut cursor = 0;
    loop {
        let page = shell.output(&created.id, cursor, 1).await.unwrap();
        joined.push_str(&page.output);
        if page.cursor == page.size {
            break;
        }
        cursor = page.cursor;
    }
    assert!(joined.contains("é€😀") && joined.contains("err"));
    assert_eq!(shell.wait(&created.id).await.unwrap(), final_info);
    shell.remove(&created.id).await.unwrap();
    assert!(!PathBuf::from(created.file.to_utf8().unwrap()).exists());
    assert!(shell.get(&created.id).await.is_err());
    shell.shutdown().await.unwrap();
}

#[tokio::test]
async fn timeout_memory_and_optional_required_sandbox_modes() {
    let fixture = Fixture::new();
    let config = fixture.configuration("{\"shell\":\"/bin/sh\",\"shell_sandbox\":\"optional\"}");
    let shell = Shell::new(
        &Roots::development(&fixture.0).unwrap(),
        fixture.0.clone(),
        "project",
        fixture.1.client(),
    )
    .await
    .unwrap();
    let mut prepared = shell
        .prepare(input("exec tail -f /dev/null", 50, None), &config)
        .unwrap();
    assert_eq!(prepared.warnings.len(), 1);
    let created = shell.create(&mut prepared).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(8), shell.wait(&created.id))
            .await
            .unwrap()
            .unwrap()
            .status,
        Status::Timeout
    );
    let mut prepared = shell
        .prepare(input("exec tail -f /dev/null", 5000, Some(1)), &config)
        .unwrap();
    prepared.memory_limit_mb = None;
    let created = shell.create(&mut prepared).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(8), shell.wait(&created.id))
            .await
            .unwrap()
            .unwrap()
            .status,
        Status::MemoryLimit
    );
    let required = fixture.configuration("{\"shell_sandbox\":\"required\"}");
    assert!(
        shell
            .prepare(input("printf forbidden", 0, None), &required)
            .is_err()
    );
    shell.shutdown().await.unwrap();
}

#[tokio::test]
async fn exited_retention_evicts_oldest_after_flushed_settlement() {
    let fixture = Fixture::new();
    let config = fixture.configuration("{\"shell\":\"/bin/sh\"}");
    let shell = Shell::new(
        &Roots::development(&fixture.0).unwrap(),
        fixture.0.clone(),
        "project",
        fixture.1.client(),
    )
    .await
    .unwrap();
    let mut events = shell.subscribe();
    let mut first = None;
    for _ in 0..26 {
        let mut prepared = shell
            .prepare(input("printf retained", 0, None), &config)
            .unwrap();
        let created = shell.create(&mut prepared).await.unwrap();
        if first.is_none() {
            first = Some(created.clone());
        }
        shell.wait(&created.id).await.unwrap();
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(events.recv().await.unwrap(), Event::Deleted(_)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    let first = first.unwrap();
    assert!(shell.get(&first.id).await.is_err());
    assert!(!PathBuf::from(first.file.to_utf8().unwrap()).exists());
    shell.shutdown().await.unwrap();
}

#[tokio::test]
async fn timeout_replacement_zero_clears_and_shutdown_reaps() {
    let fixture = Fixture::new();
    let config = fixture.configuration("{\"shell\":\"/bin/sh\",\"shell_memory_limit_mb\":1}");
    let shell = Shell::new(
        &Roots::development(&fixture.0).unwrap(),
        fixture.0.clone(),
        "project",
        fixture.1.client(),
    )
    .await
    .unwrap();
    let mut prepared = shell
        .prepare(input("exec tail -f /dev/null", 5000, Some(0)), &config)
        .unwrap();
    assert_eq!(prepared.memory_limit_mb, None);
    let created = shell.create(&mut prepared).await.unwrap();
    shell.timeout(&created.id, 0).await.unwrap();
    assert_eq!(
        shell.get(&created.id).await.unwrap().status,
        Status::Running
    );
    let pid = created.pid.unwrap().get() as u32;
    shell.shutdown().await.unwrap();
    assert!(!ycoding_core::platform::process::is_alive(pid).unwrap());
}

#[test]
fn schema_input_is_the_boundary() {
    assert!(
        CreateInput::decode(&parse_json("{\"command\":\"x\",\"timeout\":-1}").unwrap()).is_err()
    );
}

#[tokio::test]
async fn timeout_does_not_report_a_trapped_success_exit() {
    let fixture = Fixture::new();
    let config = fixture.configuration("{\"shell\":\"/bin/sh\"}");
    let shell = Shell::new(
        &Roots::development(&fixture.0).unwrap(),
        fixture.0.clone(),
        "project",
        fixture.1.client(),
    )
    .await
    .unwrap();
    let mut prepared = shell
        .prepare(
            input(
                "trap 'exit 0' TERM; printf READY; while :; do :; done",
                5000,
                None,
            ),
            &config,
        )
        .unwrap();
    let created = shell.create(&mut prepared).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if shell
                .output(&created.id, 0, 65536)
                .await
                .unwrap()
                .output
                .contains("READY")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    shell.timeout(&created.id, 1).await.unwrap();
    let info = shell.wait(&created.id).await.unwrap();
    assert_eq!(info.status, Status::Timeout);
    assert_eq!(info.exit, None);
    shell.shutdown().await.unwrap();
}

#[tokio::test]
async fn removal_fails_waiters_instead_of_overwriting_them_with_settlement() {
    let fixture = Fixture::new();
    let config = fixture.configuration("{\"shell\":\"/bin/sh\"}");
    let shell = std::sync::Arc::new(
        Shell::new(
            &Roots::development(&fixture.0).unwrap(),
            fixture.0.clone(),
            "project",
            fixture.1.client(),
        )
        .await
        .unwrap(),
    );
    let mut prepared = shell
        .prepare(input("exec tail -f /dev/null", 5000, None), &config)
        .unwrap();
    let created = shell.create(&mut prepared).await.unwrap();
    let waiting_shell = shell.clone();
    let id = created.id.clone();
    let waiter = tokio::spawn(async move { waiting_shell.wait(&id).await });
    shell.remove(&created.id).await.unwrap();
    let result = waiter.await.unwrap();
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    shell.shutdown().await.unwrap();
}
#[tokio::test]
async fn ledger_records_process_but_does_not_trust_session_metadata() {
    use ycoding_store::{
        Catalog, Metadata, Options, Store,
        resources::{ShellTable, TABLES},
    };
    let fixture = Fixture::new();
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, TABLES),
        Metadata::new([9; 16], 1),
    )
    .unwrap();
    let config = fixture.configuration("{\"shell\":\"/bin/sh\"}");
    let shell = Shell::new(
        &Roots::development(&fixture.0).unwrap(),
        fixture.0.clone(),
        "project",
        store.client(),
    )
    .await
    .unwrap();
    let mut request = input("exec tail -f /dev/null", 0, None);
    let mut metadata = ycoding_schema::JsonObject::new();
    metadata.insert(
        "sessionID".into(),
        ycoding_schema::JsonValue::String("ses_untrusted".into()),
    );
    request.metadata = Some(metadata);
    let info = shell
        .create(&mut shell.prepare(request, &config).unwrap())
        .await
        .unwrap();
    let record = store
        .client()
        .snapshot()
        .unwrap()
        .scan::<ShellTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 1)
        .unwrap()
        .pop();
    assert!(
        record.is_some(),
        "shell was never persisted in the real ShellTable"
    );
    let record = record.unwrap();
    assert!(record.session_id.is_none());
    assert_eq!(record.pid, info.pid.unwrap().get());
    shell
        .notice_owed(
            &info.id,
            ycoding_schema::session_id::SessionId::new("ses_trusted").unwrap(),
        )
        .await
        .unwrap();
    shell.remove(&info.id).await.unwrap();
    let record = store
        .client()
        .snapshot()
        .unwrap()
        .scan::<ShellTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 1)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(record.session_id, Some("ses_trusted".into()));
    assert_eq!(record.notice_pending, 1);
    shell.notice_admitted(&info.id).await.unwrap();
    assert!(
        store
            .client()
            .snapshot()
            .unwrap()
            .scan::<ShellTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 1)
            .unwrap()
            .is_empty()
    );
    shell.shutdown().await.unwrap();
}
#[tokio::test]
async fn failed_ledger_record_joins_the_process_and_removes_its_capture() {
    let fixture = Fixture::new();
    let roots = Roots::development(&fixture.0).unwrap();
    let store = ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
        ycoding_store::Metadata::new([22; 16], 1),
    )
    .unwrap();
    let shell = Shell::new(&roots, fixture.0.clone(), "project", store.client())
        .await
        .unwrap();
    store.shutdown().unwrap();
    let marker = fixture.0.join("failed-ledger-pid");
    let config = fixture.configuration("{\"shell\":\"/bin/sh\"}");
    let command = format!(
        "printf '%s' $$ > '{}'; exec yes wp009-ledger-record-failure",
        marker.display()
    );
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        shell.create(&mut shell.prepare(input(&command, 0, None), &config).unwrap()),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    assert!(shell.list().is_empty());
    assert_eq!(
        fs::read_dir(roots.data.join("shell/project"))
            .unwrap()
            .count(),
        0
    );
    if let Ok(pid) = fs::read_to_string(marker) {
        assert!(!ycoding_core::platform::process::is_alive(pid.parse().unwrap()).unwrap());
    }
    shell.shutdown().await.unwrap();
}
