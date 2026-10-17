#![cfg(unix)]
mod shell_queue_support;

use serde_json::Value;
use shell_queue_support::{Family, Host, Temp, until};
use std::{
    fs,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use ycoding_core::{
    platform::shell::{
        EnqueueError, Event, MemoryProbe, Shell,
        memory::Peak,
        queue::{Admission, Queue},
    },
    resources::config::{Configuration, LoadOptions, Roots},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue,
    shell::{CreateInput, Id, Info, Status},
};
use ycoding_store::{KeyPart, resources::ShellTable, tuple_key};

#[derive(Debug, Default)]
struct Probe {
    enabled: AtomicBool,
    factor: AtomicU64,
    sampled: Mutex<Vec<u64>>,
}
impl Probe {
    fn set(&self, factor: u64) {
        self.factor.store(factor, Ordering::SeqCst);
    }
    fn seen(&self, factor: u64) -> bool {
        self.sampled.lock().unwrap().contains(&factor)
    }
}
impl MemoryProbe for Probe {
    fn sample(
        &self,
        pid: u32,
    ) -> Pin<Box<dyn Future<Output = io::Result<Option<(String, u64)>>> + Send + '_>> {
        Box::pin(async move {
            if !self.enabled.load(Ordering::SeqCst) {
                return Ok(None);
            }
            let factor = self.factor.load(Ordering::SeqCst).max(1);
            self.sampled.lock().unwrap().push(factor);
            Ok(Some((format!("probe-{pid}"), 7 * 1024 * factor)))
        })
    }
}

struct World {
    dir: Temp,
    store: Option<ycoding_store::Store>,
    shell: Arc<Shell>,
    queue: Queue,
    probe: Arc<Probe>,
    config: Configuration,
}
impl World {
    async fn new() -> Self {
        Self::with_queue_config(r#""shell_queue":{"max_running":1}"#).await
    }
    async fn with_queue_config(queue_config: &str) -> Self {
        let dir = Temp::new("shell-queued");
        let roots = Roots::development(dir.path()).unwrap();
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
            ycoding_store::Metadata::new([9; 16], 1),
        )
        .unwrap();
        let config = Configuration::load(LoadOptions {
            directory: dir.path().to_path_buf(),
            roots: roots.clone(),
            project: false,
            content: Some(format!(
                r#"{{"shell":"/bin/sh","shell_sandbox":"disabled",{queue_config}}}"#
            )),
            file: None,
            env: Default::default(),
        })
        .unwrap();
        let host = Host::new(1_000_000.0, 0.0);
        let queue = Queue::open(host.options(&dir.path().join("queue")))
            .await
            .unwrap();
        let probe = Arc::new(Probe::default());
        let shell = Arc::new(
            Shell::new(&roots, dir.path().to_path_buf(), "project", store.client())
                .await
                .unwrap()
                .with_queue(queue.clone())
                .with_memory_probe(probe.clone()),
        );
        Self {
            dir,
            store: Some(store),
            shell,
            queue,
            probe,
            config,
        }
    }
    fn history(&self) -> PathBuf {
        self.dir.path().join("queue").join("memory.json")
    }
    fn input(&self, command: &str, timeout: u64, memory: Option<u64>) -> CreateInput {
        let mut value = ycoding_schema::JsonObject::new();
        value.insert("command".into(), JsonValue::String(command.into()));
        value.insert("timeout".into(), JsonValue::Number(timeout as f64));
        if let Some(memory) = memory {
            value.insert("memoryLimitMb".into(), JsonValue::Number(memory as f64));
        }
        CreateInput::decode(&JsonValue::Object(value)).unwrap()
    }
    async fn enqueue(
        &self,
        session: &str,
        command: &str,
        timeout: u64,
        memory: Option<u64>,
    ) -> Result<Info, EnqueueError> {
        self.enqueue_with(session, command, timeout, memory, None)
            .await
    }
    async fn enqueue_with(
        &self,
        session: &str,
        command: &str,
        timeout: u64,
        memory: Option<u64>,
        admission: Option<Arc<dyn Admission>>,
    ) -> Result<Info, EnqueueError> {
        let mut prepared = self
            .shell
            .prepare(self.input(command, timeout, memory), &self.config)
            .unwrap();
        self.shell.enqueue(&mut prepared, session, admission).await
    }
    async fn running(&self, id: &Id) {
        for _ in 0..250 {
            if self.shell.get(id).await.unwrap().status == Status::Running {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("shell {id:?} did not start");
    }
    fn stored(&self) -> Vec<(String, Vec<f64>)> {
        let Ok(text) = fs::read_to_string(self.history()) else {
            return Vec::new();
        };
        let Value::Array(entries) = serde_json::from_str(&text).unwrap() else {
            panic!("memory.json is not an array")
        };
        entries
            .iter()
            .map(|entry| {
                (
                    entry["key"].as_str().unwrap().to_owned(),
                    entry["peaks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|peak| peak.as_f64().unwrap())
                        .collect(),
                )
            })
            .collect()
    }
    async fn history_is(&self, expected: &[f64]) {
        until_async(
            || {
                self.stored()
                    .first()
                    .map(|entry| entry.1.clone())
                    .as_deref()
                    == Some(expected)
            },
            "the peak history did not reach the expected value",
        )
        .await;
    }
    fn seed(&self, command: &str, memory_limit_mb: u64, peak_mb: f64) {
        self.queue
            .record_peak(Peak {
                command: command.into(),
                cwd: self.dir.path().to_path_buf(),
                memory_limit_mb: Some(memory_limit_mb),
                reserve_mb: 2_048,
                peak_mb,
                can_lower: true,
            })
            .unwrap();
    }
    fn row(&self, id: &Id) -> bool {
        let JsonValue::String(id) = id.encode() else {
            unreachable!()
        };
        self.store
            .as_ref()
            .unwrap()
            .client()
            .snapshot()
            .unwrap()
            .get::<ShellTable>(&tuple_key(&[KeyPart::String(&id)]))
            .unwrap()
            .is_some()
    }
    async fn drained(&self) {
        until_async(
            || self.queue.entries().unwrap().is_empty(),
            "queue entries were not released",
        )
        .await;
    }
}

async fn until_async(mut probe: impl FnMut() -> bool, message: &str) {
    until(&mut probe, message).await;
}

fn text(id: &Id) -> String {
    let JsonValue::String(value) = id.encode() else {
        unreachable!()
    };
    value.to_utf8().unwrap()
}

fn position(info: &Info) -> Option<i64> {
    info.queue_position.map(|value| value.get())
}

fn release_command(release: &Path, exit: i32) -> String {
    format!(
        "while [ ! -e '{}' ]; do sleep 0.02; done; exit {exit}",
        release.display()
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn sampled_nonzero_exits_preserve_heavy_peaks_and_record_only_increases() {
    let world = World::new().await;
    world.probe.enabled.store(true, Ordering::SeqCst);
    let release = world.dir.path().join("failed-release");
    let command = release_command(&release, 7);
    world.seed(&command, 128, 64.0);
    for factor in [2, 2, 2, 2, 2, 14] {
        world.probe.set(1);
        let info = world
            .enqueue("ses_a", &command, 0, Some(128))
            .await
            .unwrap();
        world.running(&info.id).await;
        world.probe.set(factor);
        until_async(
            || world.probe.seen(factor),
            "the periodic sample did not run",
        )
        .await;
        fs::write(&release, "finish").unwrap();
        assert_eq!(
            world
                .shell
                .wait(&info.id)
                .await
                .unwrap()
                .exit
                .map(|exit| exit.get()),
            Some(7.0)
        );
        if factor == 14 {
            world.history_is(&[64.0, 98.0]).await;
        } else {
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(world.stored()[0].1, [64.0]);
        }
        fs::remove_file(&release).unwrap();
    }
    let history = world.stored();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].0.len(), 64);
}

#[tokio::test(flavor = "multi_thread")]
async fn fast_failed_exits_cannot_lower_or_evict_a_heavy_peak() {
    let world = World::new().await;
    world.probe.enabled.store(true, Ordering::SeqCst);
    world.seed("exit 7", 128, 64.0);
    for _ in 0..5 {
        let info = world
            .enqueue("ses_a", "exit 7", 0, Some(128))
            .await
            .unwrap();
        assert_eq!(
            world
                .shell
                .wait(&info.id)
                .await
                .unwrap()
                .exit
                .map(|exit| exit.get()),
            Some(7.0)
        );
        world.drained().await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let history = world.stored();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].1, [64.0]);
}

#[tokio::test(flavor = "multi_thread")]
async fn removed_and_timed_out_runs_record_only_requirement_increases() {
    for (outcome, factor, timeout, expected) in [
        ("removed-low", 1, 0, vec![20.0]),
        ("timeout-low", 1, 50, vec![20.0]),
        ("removed-high", 4, 0, vec![20.0, 28.0]),
    ] {
        let world = World::new().await;
        world.probe.enabled.store(true, Ordering::SeqCst);
        world.probe.set(factor);
        world.seed("sleep 60", 128, 20.0);
        let info = world
            .enqueue("ses_a", "sleep 60", timeout, Some(128))
            .await
            .unwrap();
        world.running(&info.id).await;
        until_async(|| world.probe.seen(factor), "no sample was taken").await;
        if outcome == "timeout-low" {
            assert_eq!(
                world.shell.wait(&info.id).await.unwrap().status,
                Status::Timeout
            );
        } else {
            world.shell.remove(&info.id).await.unwrap();
        }
        world.history_is(&expected).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_timeout_settles_and_releases_its_slot_and_family_before_a_contended_peak_write() {
    let world = World::new().await;
    world.probe.enabled.store(true, Ordering::SeqCst);
    world.seed("sleep 60", 128, 1.0);
    world.history_is(&[1.0]).await;
    fs::create_dir_all(world.dir.path().join("queue")).unwrap();
    let lock = fs::File::create(world.dir.path().join("queue").join("memory.lock")).unwrap();
    lock.lock().unwrap();
    let family = Family::new("ses_a", true);
    let info = world
        .enqueue_with("ses_a", "sleep 60", 0, Some(128), Some(family.clone()))
        .await
        .unwrap();
    until_async(
        || world.probe.seen(1),
        "the initial memory sample did not run",
    )
    .await;
    world.shell.timeout(&info.id, 50).await.unwrap();
    let settled = tokio::time::timeout(Duration::from_millis(1_500), world.shell.wait(&info.id))
        .await
        .expect("the timeout waited for the peak write")
        .unwrap();
    assert_eq!(settled.status, Status::Timeout);
    until_async(
        || family.released.load(Ordering::SeqCst) == 1,
        "the family reservation was not released",
    )
    .await;
    world.drained().await;
    assert_eq!(world.stored()[0].1, vec![1.0]);
    drop(lock);
    world.history_is(&[1.0, 7.0]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_successful_sampled_exit_records_the_highest_process_tree_sample() {
    let world = World::new().await;
    world.probe.enabled.store(true, Ordering::SeqCst);
    let release = world.dir.path().join("finish-peak");
    let command = release_command(&release, 0);
    let info = world
        .enqueue("ses_a", &command, 0, Some(128))
        .await
        .unwrap();
    world.running(&info.id).await;
    world.probe.set(3);
    until_async(|| world.probe.seen(3), "the high sample did not run").await;
    world.probe.set(2);
    until_async(|| world.probe.seen(2), "the low sample did not run").await;
    fs::write(&release, "finish").unwrap();
    assert_eq!(
        world
            .shell
            .wait(&info.id)
            .await
            .unwrap()
            .exit
            .map(|exit| exit.get()),
        Some(0.0)
    );
    world.history_is(&[21.0]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_and_normal_commands_retain_output_written_before_they_exit() {
    let world = World::new().await;
    let command = "printf hello; printf error >&2";
    let queued = world.enqueue("ses_a", command, 0, None).await.unwrap();
    world.shell.wait(&queued.id).await.unwrap();
    let page = world.shell.output(&queued.id, 0, 1024).await.unwrap();
    assert!(page.output.contains("hello") && page.output.contains("error"));
    let mut prepared = world
        .shell
        .prepare(world.input(command, 0, None), &world.config)
        .unwrap();
    let normal = world.shell.create(&mut prepared).await.unwrap();
    world.shell.wait(&normal.id).await.unwrap();
    let page = world.shell.output(&normal.id, 0, 1024).await.unwrap();
    assert!(page.output.contains("hello") && page.output.contains("error"));
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_commands_start_once_admitted_report_queue_updates_and_count_their_timeout_from_start()
 {
    let world = World::new().await;
    let mut events = world.shell.subscribe();
    let release = world.dir.path().join("release-first");
    let first = world
        .enqueue(
            "ses_a",
            &format!(
                "while [ ! -e '{}' ]; do sleep 0.02; done",
                release.display()
            ),
            0,
            None,
        )
        .await
        .unwrap();
    assert_eq!((first.status, position(&first)), (Status::Queued, Some(1)));
    world.running(&first.id).await;
    let second = world
        .enqueue("ses_b", "sleep 0.2; printf ok", 500, None)
        .await
        .unwrap();
    assert_eq!(
        (second.status, position(&second)),
        (Status::Queued, Some(1))
    );
    let listed: Vec<_> = world
        .shell
        .list()
        .iter()
        .map(|info| (info.id.clone(), info.status))
        .collect();
    assert_eq!(listed.len(), 2);
    assert!(listed.contains(&(first.id.clone(), Status::Running)));
    assert!(listed.contains(&(second.id.clone(), Status::Queued)));
    assert_eq!(
        world.shell.get(&second.id).await.unwrap().status,
        Status::Queued
    );
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(
        world.shell.get(&second.id).await.unwrap().status,
        Status::Queued
    );
    fs::write(&release, "").unwrap();
    let first_final = world.shell.wait(&first.id).await.unwrap();
    let second_final = world.shell.wait(&second.id).await.unwrap();
    assert_eq!(second_final.status, Status::Exited);
    assert_eq!(second_final.exit.map(|exit| exit.get()), Some(0.0));
    assert!(second_final.queue_position.is_none());
    assert_eq!(second_final.time.queued, Some(second.time.started));
    assert!(second_final.time.started.get() >= first_final.time.completed.unwrap().get());
    assert_eq!(
        world
            .shell
            .output(&second.id, 0, 1024)
            .await
            .unwrap()
            .output,
        "ok"
    );
    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        match event {
            Event::Created(info) if info.id == second.id => {
                seen.push(format!("created:{:?}", info.status))
            }
            Event::Updated(info) if info.id == second.id => {
                seen.push(format!("updated:{:?}", info.status))
            }
            Event::Exited(exited) if exited.id == second.id => {
                seen.push(format!("exited:{:?}", exited.status))
            }
            _ => {}
        }
    }
    assert_eq!(seen, ["created:Queued", "updated:Running", "exited:Exited"]);
    world.drained().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queued_commands_timeout_changed_before_start_applies_from_start() {
    let world = World::new().await;
    let release = world.dir.path().join("release-holder");
    let holder = world
        .enqueue("ses_a", &release_command(&release, 0), 0, None)
        .await
        .unwrap();
    world.running(&holder.id).await;
    let waiting = world.enqueue("ses_b", "sleep 30", 0, None).await.unwrap();
    world.shell.timeout(&waiting.id, 300).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        world.shell.get(&waiting.id).await.unwrap().status,
        Status::Queued
    );
    fs::write(&release, "").unwrap();
    let settled = world.shell.wait(&waiting.id).await.unwrap();
    assert_eq!(settled.status, Status::Timeout);
    let ran = settled.time.completed.unwrap().get() - settled.time.started.get();
    assert!((250.0..5_000.0).contains(&ran), "{ran}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_queued_command_is_killed_without_starting_and_releases_everything_it_held() {
    let world = World::new().await;
    let holder = world.enqueue("ses_a", "sleep 30", 0, None).await.unwrap();
    world.running(&holder.id).await;
    let marker = world.dir.path().join("marker");
    let removed = world
        .enqueue("ses_b", &format!("touch '{}'", marker.display()), 0, None)
        .await
        .unwrap();
    let other = world
        .enqueue("ses_c", "printf other", 0, None)
        .await
        .unwrap();
    assert_eq!(position(&other), Some(2));
    assert!(world.row(&removed.id));
    let before = world.queue.entries().unwrap().len();
    let waiting = tokio::spawn({
        let (shell, id) = (world.shell.clone(), removed.id.clone());
        async move { shell.wait(&id).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    world.shell.remove(&removed.id).await.unwrap();
    assert_eq!(waiting.await.unwrap().unwrap().status, Status::Killed);
    assert_eq!(
        world.shell.get(&removed.id).await.unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    let mut ids: Vec<_> = world
        .queue
        .entries()
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    ids.sort();
    assert_eq!(ids.len(), before - 1);
    assert!(!ids.contains(&text(&removed.id)));
    assert!(ids.contains(&text(&holder.id)) && ids.contains(&text(&other.id)));
    assert!(!Path::new(&removed.file.to_utf8().unwrap()).exists());
    assert!(!world.row(&removed.id));
    until_async(
        || {
            world
                .shell
                .list()
                .iter()
                .any(|info| info.id == other.id && position(info) == Some(1))
        },
        "the next entry did not move up",
    )
    .await;
    world.shell.remove(&holder.id).await.unwrap();
    assert_eq!(
        world.shell.wait(&other.id).await.unwrap().status,
        Status::Exited
    );
    assert!(!marker.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_queued_removes_a_command_only_while_it_is_still_queued() {
    let world = World::new().await;
    let holder = world.enqueue("ses_a", "sleep 30", 0, None).await.unwrap();
    world.running(&holder.id).await;
    let waiting = world
        .enqueue("ses_b", "printf waiting", 0, None)
        .await
        .unwrap();
    assert!(!world.shell.cancel_queued(&holder.id).await.unwrap());
    assert_eq!(
        world.shell.get(&holder.id).await.unwrap().status,
        Status::Running
    );
    let waited = tokio::spawn({
        let (shell, id) = (world.shell.clone(), waiting.id.clone());
        async move { shell.wait(&id).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(world.shell.cancel_queued(&waiting.id).await.unwrap());
    assert_eq!(waited.await.unwrap().unwrap().status, Status::Killed);
    assert!(!world.shell.cancel_queued(&waiting.id).await.unwrap());
    let unknown = Id::decode(&JsonValue::String("sh_unknown".into())).unwrap();
    assert!(!world.shell.cancel_queued(&unknown).await.unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_commands_keep_their_timeout_and_memory_limit_after_they_start() {
    let world = World::new().await;
    world.probe.enabled.store(true, Ordering::SeqCst);
    let timed = world.enqueue("ses_a", "sleep 30", 300, None).await.unwrap();
    let hog = world
        .enqueue("ses_b", "sleep 30", 0, Some(64))
        .await
        .unwrap();
    let last = world
        .enqueue("ses_c", "printf done", 0, None)
        .await
        .unwrap();
    assert_eq!(
        world.shell.wait(&timed.id).await.unwrap().status,
        Status::Timeout
    );
    world.running(&hog.id).await;
    world.probe.set(30);
    let hog_final = tokio::time::timeout(Duration::from_secs(20), world.shell.wait(&hog.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hog_final.status, Status::MemoryLimit);
    assert_eq!(
        world.shell.wait(&last.id).await.unwrap().status,
        Status::Exited
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_registration_leaves_no_observable_shell_and_no_queue_entry() {
    let mut world = World::new().await;
    let marker = world.dir.path().join("marker");
    world.store.take().unwrap().shutdown().unwrap();
    let failed = world
        .enqueue("ses_a", &format!("touch '{}'", marker.display()), 0, None)
        .await;
    assert!(failed.is_err());
    assert!(world.shell.list().is_empty());
    world.drained().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!marker.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queued_command_never_starts_after_the_shell_service_shuts_down() {
    let world = World::new().await;
    let holder = world.enqueue("ses_a", "sleep 30", 0, None).await.unwrap();
    world.running(&holder.id).await;
    let marker = world.dir.path().join("marker");
    let queued = world
        .enqueue("ses_b", &format!("touch '{}'", marker.display()), 0, None)
        .await
        .unwrap();
    world.shell.shutdown().await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!marker.exists());
    assert_ne!(
        world
            .shell
            .get(&queued.id)
            .await
            .map(|info| info.status)
            .ok(),
        Some(Status::Running)
    );
    world.drained().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_is_rejected_beyond_the_waiting_limit_and_may_queue_again_after_one_leaves() {
    let world = World::new().await;
    let holder = world.enqueue("ses_a", "sleep 30", 0, None).await.unwrap();
    world.running(&holder.id).await;
    let mut waiting = Vec::new();
    for _ in 0..16 {
        waiting.push(world.enqueue("ses_a", "sleep 30", 0, None).await.unwrap());
    }
    assert_eq!(position(waiting.last().unwrap()), Some(16));
    let error = world
        .enqueue("ses_a", "sleep 30", 0, None)
        .await
        .unwrap_err();
    let EnqueueError::Full(full) = error else {
        panic!("expected a full queue, got {error}");
    };
    assert_eq!(full.limit, 16);
    assert!(
        world
            .shell
            .cancel_queued(&waiting.pop().unwrap().id)
            .await
            .unwrap()
    );
    let replacement = world.enqueue("ses_a", "sleep 30", 0, None).await.unwrap();
    assert_eq!(replacement.status, Status::Queued);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_queued_command_has_no_process_until_it_starts() {
    let world = World::new().await;
    let release = world.dir.path().join("release");
    let holder = world
        .enqueue("ses_a", &release_command(&release, 0), 0, None)
        .await
        .unwrap();
    world.running(&holder.id).await;
    let queued = world.enqueue("ses_b", "printf ok", 0, None).await.unwrap();
    assert!(queued.pid.is_none() && queued.exit.is_none() && queued.time.completed.is_none());
    assert!(world.row(&queued.id));
    fs::write(&release, "").unwrap();
    let settled = world.shell.wait(&queued.id).await.unwrap();
    assert!(settled.pid.is_some());
}
