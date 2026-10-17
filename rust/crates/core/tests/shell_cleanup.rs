#![cfg(unix)]
use std::{
    fs, io,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use ycoding_core::{
    platform::{
        process::{self, GroupSystem, KillSignal, NativeGroupSystem},
        shell::Shell,
    },
    resources::config::{Configuration, LoadOptions, Roots},
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue,
    shell::{CreateInput, Id, Info, Status},
};
use ycoding_store::{KeyPart, resources::ShellTable, tuple_key};

const HEALTHY: u8 = 0;
const UNREADABLE: u8 = 1;
const UNSIGNALLABLE: u8 = 2;

#[derive(Clone, Copy, Debug)]
struct Owned {
    leader: i32,
    session: i32,
}

impl Owned {
    fn capture(info: &Info) -> Self {
        let leader = info.pid.unwrap().get() as i32;
        let (session, group) = unsafe { (libc::getsid(leader), libc::getpgid(leader)) };
        assert_eq!(
            (session, group),
            (leader, leader),
            "a spawned shell must lead its own session and process group"
        );
        Self { leader, session }
    }

    fn holds(&self, target: i32) -> bool {
        target == -self.leader
            && unsafe { libc::getpgid(self.leader) } == self.leader
            && unsafe { libc::getsid(self.leader) } == self.session
    }
}

#[derive(Debug, Default)]
struct Faulty {
    failure: AtomicU8,
    owned: Mutex<Vec<Owned>>,
}

impl Faulty {
    fn set(&self, failure: u8) {
        self.failure.store(failure, Ordering::SeqCst);
    }

    fn holds(&self, target: i32) -> bool {
        self.owned
            .lock()
            .unwrap()
            .iter()
            .any(|owned| owned.holds(target))
    }
}

impl GroupSystem for Faulty {
    fn read(&self) -> process::Members<'_> {
        Box::pin(async move {
            if self.failure.load(Ordering::SeqCst) == UNREADABLE {
                return Err(io::Error::other("process listing unavailable"));
            }
            NativeGroupSystem.read().await
        })
    }
    fn signal(&self, target: i32, signal: KillSignal) -> io::Result<()> {
        if self.failure.load(Ordering::SeqCst) == UNSIGNALLABLE {
            return Err(io::Error::from_raw_os_error(libc::EPERM));
        }
        if !self.holds(target) {
            return Err(io::Error::other(format!(
                "refusing to signal unmanaged target {target}"
            )));
        }
        NativeGroupSystem.signal(target, signal)
    }
}

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    store: ycoding_store::Store,
    system: Arc<Faulty>,
    shell: Arc<Shell>,
    configuration: Configuration,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-w51-cleanup-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
            ycoding_store::Metadata::new([51; 16], 1),
        )
        .unwrap();
        let roots = Roots::development(&root).unwrap();
        let system = Arc::new(Faulty::default());
        let shell = Arc::new(
            Shell::new(&roots, root.clone(), "project", store.client())
                .await
                .unwrap()
                .with_process_system(system.clone()),
        );
        let configuration = Configuration::load(LoadOptions {
            directory: root.clone(),
            roots,
            project: false,
            content: Some("{\"shell\":\"/bin/sh\"}".into()),
            file: None,
            env: Default::default(),
        })
        .unwrap();
        Self {
            root,
            store,
            system,
            shell,
            configuration,
        }
    }

    async fn create(&self, command: &str, memory: Option<u64>) -> Info {
        let mut value = ycoding_schema::JsonObject::new();
        value.insert("command".into(), JsonValue::String(command.into()));
        value.insert("timeout".into(), JsonValue::Number(0.0));
        if let Some(memory) = memory {
            value.insert("memoryLimitMb".into(), JsonValue::Number(memory as f64));
        }
        let input = CreateInput::decode(&JsonValue::Object(value)).unwrap();
        let info = self
            .shell
            .create(&mut self.shell.prepare(input, &self.configuration).unwrap())
            .await
            .unwrap();
        self.system
            .owned
            .lock()
            .unwrap()
            .push(Owned::capture(&info));
        info
    }

    fn row(&self, id: &Id) -> Option<ycoding_store::resources::Shell> {
        let JsonValue::String(id) = id.encode() else {
            unreachable!()
        };
        self.store
            .client()
            .snapshot()
            .unwrap()
            .get::<ShellTable>(&tuple_key(&[KeyPart::String(&id)]))
            .unwrap()
    }

    fn waiter(&self, id: &Id) -> tokio::task::JoinHandle<io::Result<Info>> {
        let (shell, id) = (self.shell.clone(), id.clone());
        tokio::spawn(async move { shell.wait(&id).await })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for owned in self.system.owned.lock().unwrap().iter() {
            if owned.holds(-owned.leader) {
                unsafe {
                    libc::kill(-owned.leader, libc::SIGKILL);
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("shell cleanup exceeded its bound")
}

fn pid(info: &Info) -> u32 {
    info.pid.unwrap().get() as u32
}

#[tokio::test]
async fn failed_removal_cleanup_keeps_the_live_command_tracked_and_a_retry_settles_it_killed() {
    for failure in [UNREADABLE, UNSIGNALLABLE] {
        let fixture = Fixture::new().await;
        let info = fixture.create("exec tail -f /dev/null", None).await;
        let file = PathBuf::from(info.file.to_utf8().unwrap());
        let first = fixture.waiter(&info.id);
        fixture.system.set(failure);
        assert!(
            bounded(fixture.shell.remove(&info.id)).await.is_err(),
            "removal reported success while cleanup failed ({failure})"
        );
        let failed = bounded(first).await.unwrap();
        assert!(
            failed
                .as_ref()
                .is_err_and(|error| error.kind() != io::ErrorKind::NotFound),
            "an existing waiter must fail with the cleanup error, got {failed:?}"
        );
        assert_eq!(
            fixture.shell.get(&info.id).await.unwrap().status,
            Status::Running
        );
        assert!(fixture.row(&info.id).is_some());
        assert!(file.exists());
        assert!(process::is_alive(pid(&info)).unwrap());

        fixture.system.set(HEALTHY);
        let second = fixture.waiter(&info.id);
        bounded(fixture.shell.remove(&info.id)).await.unwrap();
        let settled = bounded(second).await.unwrap().unwrap();
        assert_eq!(settled.status, Status::Killed);
        assert_eq!(settled.exit, None);
        assert!(!process::is_alive(pid(&info)).unwrap());
        assert!(!file.exists());
        assert!(fixture.row(&info.id).is_none());
        assert!(fixture.shell.get(&info.id).await.is_err());
    }
}

#[tokio::test]
async fn enforcement_cleanup_failure_leaves_the_command_live_and_reports_an_error() {
    for memory in [None, Some(20)] {
        let fixture = Fixture::new().await;
        let command = if memory.is_some() {
            "exec perl -e '$x = \"a\" x 50_000_000; sleep 60'"
        } else {
            "exec tail -f /dev/null"
        };
        let info = fixture.create(command, memory).await;
        fixture.system.set(UNSIGNALLABLE);
        let waiting = fixture.waiter(&info.id);
        if memory.is_none() {
            fixture.shell.timeout(&info.id, 1).await.unwrap();
        }
        assert!(
            bounded(waiting).await.unwrap().is_err(),
            "enforcement reported a terminal status while cleanup failed"
        );
        assert_eq!(
            fixture.shell.get(&info.id).await.unwrap().status,
            Status::Running
        );
        assert!(process::is_alive(pid(&info)).unwrap());
        assert!(fixture.row(&info.id).is_some());

        fixture.system.set(HEALTHY);
        bounded(fixture.shell.remove(&info.id)).await.unwrap();
        assert!(!process::is_alive(pid(&info)).unwrap());
    }
}

#[tokio::test]
async fn teardown_reports_cleanup_failures_and_retains_process_identity_rows() {
    let fixture = Fixture::new().await;
    let info = fixture.create("exec tail -f /dev/null", None).await;
    fixture.system.set(UNSIGNALLABLE);
    assert!(bounded(fixture.shell.shutdown()).await.is_err());
    assert!(fixture.row(&info.id).is_some());
    assert!(process::is_alive(pid(&info)).unwrap());
    fixture.system.set(HEALTHY);
}

async fn output_reaches(fixture: &Fixture, id: &Id, needle: &str) -> bool {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(page) = fixture.shell.output(id, 0, 4096).await
                && page.output.contains(needle)
            {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn failed_removal_cleanup_keeps_capturing_output_and_the_command_alive_until_a_retry_settles_it()
 {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    for failure in [UNREADABLE, UNSIGNALLABLE] {
        let fixture = Fixture::new().await;
        let fifo = fixture.root.join("go");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let _reader = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
            .unwrap();
        let mut writer = fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
            .unwrap();
        let command = format!(
            "printf before; read line < '{}'; printf after; exec tail -f /dev/null",
            fifo.display()
        );
        let info = fixture.create(&command, None).await;
        let file = PathBuf::from(info.file.to_utf8().unwrap());
        assert!(
            output_reaches(&fixture, &info.id, "before").await,
            "the command never produced its first output ({failure})"
        );
        let first = fixture.waiter(&info.id);
        fixture.system.set(failure);
        assert!(
            bounded(fixture.shell.remove(&info.id)).await.is_err(),
            "removal reported success while cleanup failed ({failure})"
        );
        let failed = bounded(first).await.unwrap();
        assert!(
            failed
                .as_ref()
                .is_err_and(|error| error.kind() != io::ErrorKind::NotFound),
            "an existing waiter must fail with the cleanup error, got {failed:?}"
        );

        writer.write_all(b"go\n").unwrap();
        assert!(
            output_reaches(&fixture, &info.id, "after").await,
            "output written after the failed removal was lost ({failure})"
        );
        let page = fixture.shell.output(&info.id, 0, 4096).await.unwrap();
        assert_eq!(page.output, "beforeafter");
        assert!(
            process::is_alive(pid(&info)).unwrap(),
            "the command died after the failed removal ({failure})"
        );
        assert_eq!(
            fixture.shell.get(&info.id).await.unwrap().status,
            Status::Running
        );
        assert!(fixture.row(&info.id).is_some());
        assert!(file.exists());

        fixture.system.set(HEALTHY);
        let second = fixture.waiter(&info.id);
        bounded(fixture.shell.remove(&info.id)).await.unwrap();
        let settled = bounded(second).await.unwrap().unwrap();
        assert_eq!(settled.status, Status::Killed);
        assert_eq!(settled.exit, None);
        assert!(!process::is_alive(pid(&info)).unwrap());
        assert!(!file.exists());
        assert!(fixture.row(&info.id).is_none());
        assert!(fixture.shell.get(&info.id).await.is_err());
    }
}
