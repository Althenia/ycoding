#![cfg(unix)]
use std::{
    fs, io,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use ycoding_core::{
    platform::{
        process::{self, GroupSystem, KillSignal, Member, NativeGroupSystem},
        shell::Shell,
    },
    resources::config::{Configuration, LoadOptions, Roots},
};
use ycoding_schema::{
    DomainDecode, JsonValue,
    shell::{CreateInput, Info, Status},
};

const LEADERLESS: u32 = u32::MAX - 1;
const REPLACEMENT_MEMBER: u32 = u32::MAX - 2;
const PHANTOM: u32 = u32::MAX - 3;

#[derive(Clone, Copy, Debug, PartialEq)]
enum View {
    Native,
    LeaderlessUntilTerm,
    EmptyThenReused,
    Replaced,
    Phantom,
}

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

#[derive(Debug)]
struct Scripted {
    leader: AtomicU32,
    owned: Mutex<Option<Owned>>,
    view: Mutex<View>,
    reads: AtomicUsize,
    signals: Mutex<Vec<(i32, KillSignal, Instant)>>,
}

impl Scripted {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            leader: AtomicU32::new(0),
            owned: Mutex::new(None),
            view: Mutex::new(View::Native),
            reads: AtomicUsize::new(0),
            signals: Mutex::new(Vec::new()),
        })
    }

    fn observe(&self, info: &Info, view: View) {
        *self.owned.lock().unwrap() = Some(Owned::capture(info));
        *self.view.lock().unwrap() = view;
        self.leader
            .store(info.pid.unwrap().get() as u32, Ordering::SeqCst);
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    fn switch(&self, view: View) {
        *self.view.lock().unwrap() = view;
    }

    fn signals(&self) -> Vec<(i32, KillSignal)> {
        self.signals
            .lock()
            .unwrap()
            .iter()
            .map(|(target, signal, _)| (*target, *signal))
            .collect()
    }

    fn sent(&self, signal: KillSignal) -> Option<Instant> {
        self.signals
            .lock()
            .unwrap()
            .iter()
            .find(|(_, sent, _)| *sent == signal)
            .map(|(_, _, at)| *at)
    }
}

impl GroupSystem for Scripted {
    fn read(&self) -> process::Members<'_> {
        Box::pin(async move {
            let leader = self.leader.load(Ordering::SeqCst);
            let view = *self.view.lock().unwrap();
            if leader == 0 || view == View::Native {
                return NativeGroupSystem.read().await;
            }
            let read = self.reads.fetch_add(1, Ordering::SeqCst);
            let member = |pid, started: &str| Member {
                pid,
                pgid: leader,
                started: started.into(),
            };
            Ok(match view {
                View::Native => unreachable!(),
                View::LeaderlessUntilTerm => {
                    if self.sent(KillSignal::Term).is_some() {
                        Vec::new()
                    } else {
                        vec![member(LEADERLESS, "leaderless member")]
                    }
                }
                View::EmptyThenReused => {
                    if read == 0 {
                        Vec::new()
                    } else {
                        vec![member(LEADERLESS, "reused group member")]
                    }
                }
                View::Replaced => vec![
                    member(leader, "replacement leader"),
                    member(REPLACEMENT_MEMBER, "replacement member"),
                ],
                View::Phantom => {
                    let mut members = NativeGroupSystem.read().await?;
                    members.push(member(PHANTOM, "phantom member"));
                    members
                }
            })
        })
    }

    fn signal(&self, target: i32, signal: KillSignal) -> io::Result<()> {
        self.signals
            .lock()
            .unwrap()
            .push((target, signal, Instant::now()));
        let owned = *self.owned.lock().unwrap();
        if signal == KillSignal::Term && owned.is_some_and(|owned| owned.holds(target)) {
            return NativeGroupSystem.signal(target, signal);
        }
        Ok(())
    }
}

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    _store: ycoding_store::Store,
    system: Arc<Scripted>,
    shell: Arc<Shell>,
    configuration: Configuration,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-w50-group-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
            ycoding_store::Metadata::new([50; 16], 1),
        )
        .unwrap();
        let roots = Roots::development(&root).unwrap();
        let system = Scripted::new();
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
            _store: store,
            system,
            shell,
            configuration,
        }
    }

    async fn create(&self, command: &str) -> Info {
        let mut value = ycoding_schema::JsonObject::new();
        value.insert("command".into(), JsonValue::String(command.into()));
        value.insert("timeout".into(), JsonValue::Number(0.0));
        let input = CreateInput::decode(&JsonValue::Object(value)).unwrap();
        self.shell
            .create(&mut self.shell.prepare(input, &self.configuration).unwrap())
            .await
            .unwrap()
    }

    fn gate(&self) -> (PathBuf, String) {
        let gate = self.root.join("gate");
        let wait = format!("while [ ! -e '{}' ]; do sleep 0.01; done", gate.display());
        (gate, wait)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct Escaped {
    marker: PathBuf,
    owned: Mutex<Option<(i32, i32)>>,
}

impl Escaped {
    fn new(marker: PathBuf) -> Self {
        Self {
            marker,
            owned: Mutex::new(None),
        }
    }

    fn launch(&self) -> String {
        format!(
            "perl -e 'setpgrp(0,0); exec @ARGV' /bin/sh -c \"echo \\$\\$ > '{}'; while :; do printf x; sleep 0.02; done\" & while [ ! -s '{}' ]; do sleep 0.01; done",
            self.marker.display(),
            self.marker.display()
        )
    }

    async fn adopt(&self, leader: &Info) {
        let writer = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(text) = fs::read_to_string(&self.marker)
                    && let Ok(pid) = text.trim().parse::<i32>()
                {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the escaped writer never started");
        let (group, session) = unsafe { (libc::getpgid(writer), libc::getsid(writer)) };
        if group == -1 || session == -1 {
            return;
        }
        assert_eq!(group, writer, "the escaped writer must lead its own group");
        assert_eq!(
            session,
            leader.pid.unwrap().get() as i32,
            "the escaped writer must stay in the spawned shell's session"
        );
        *self.owned.lock().unwrap() = Some((writer, session));
    }
}

impl Drop for Escaped {
    fn drop(&mut self) {
        if let Some((writer, session)) = *self.owned.lock().unwrap()
            && unsafe { libc::getpgid(writer) } == writer
            && unsafe { libc::getsid(writer) } == session
        {
            unsafe {
                libc::kill(-writer, libc::SIGKILL);
            }
        }
    }
}

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("group cleanup exceeded its bound")
}

#[tokio::test]
async fn members_left_by_an_exited_leader_receive_the_group_signal_until_the_group_empties() {
    let fixture = Fixture::new().await;
    let (gate, wait) = fixture.gate();
    let info = fixture.create(&format!("{wait}; exit 0")).await;
    fixture.system.observe(&info, View::LeaderlessUntilTerm);
    fs::write(&gate, "").unwrap();
    let settled = bounded(fixture.shell.wait(&info.id)).await.unwrap();
    assert_eq!(settled.status, Status::Exited);
    assert_eq!(settled.exit.unwrap().get(), 0.0);
    assert_eq!(
        fixture.system.signals(),
        vec![(-(info.pid.unwrap().get() as i32), KillSignal::Term)]
    );
    fixture.shell.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_observed_empty_group_or_replacement_leader_permanently_ends_signalling_ownership() {
    for first in [View::EmptyThenReused, View::Replaced] {
        let fixture = Fixture::new().await;
        let (gate, wait) = fixture.gate();
        let escaped = Escaped::new(fixture.root.join("escaped-writer"));
        let info = fixture
            .create(&format!("{}; {wait}; exit 0", escaped.launch()))
            .await;
        escaped.adopt(&info).await;
        fixture.system.observe(&info, first);
        fs::write(&gate, "").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.system.reads() == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the leader's normal exit never ran group cleanup");
        fixture.system.switch(View::LeaderlessUntilTerm);
        bounded(fixture.shell.remove(&info.id)).await.unwrap();
        assert!(
            fixture.system.signals().is_empty(),
            "{first:?}: a group was signalled after ownership ended: {:?}",
            fixture.system.signals()
        );
        drop(escaped);
        fixture.shell.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn kill_confirmation_fails_within_one_second_after_sigkill_and_a_retry_settles_the_command() {
    let fixture = Fixture::new().await;
    let info = fixture.create("exec tail -f /dev/null").await;
    let leader = info.pid.unwrap().get() as i32;
    fixture.system.observe(&info, View::Phantom);
    let failed = bounded(fixture.shell.remove(&info.id)).await;
    let returned = Instant::now();
    assert!(
        failed.is_err(),
        "removal reported success while a member survived SIGKILL"
    );
    let killed = fixture
        .system
        .sent(KillSignal::Kill)
        .expect("cleanup never escalated to SIGKILL");
    assert!(
        returned.duration_since(killed) < Duration::from_millis(1_500),
        "confirmation after SIGKILL exceeded its one-second bound: {:?}",
        returned.duration_since(killed)
    );
    assert!(
        fixture
            .system
            .signals()
            .starts_with(&[(-leader, KillSignal::Term)])
    );
    assert!(!process::is_alive(leader as u32).unwrap());

    fixture.system.switch(View::Native);
    bounded(fixture.shell.remove(&info.id)).await.unwrap();
    assert!(fixture.shell.get(&info.id).await.is_err());
    fixture.shell.shutdown().await.unwrap();
}
