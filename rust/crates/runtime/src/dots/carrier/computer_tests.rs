use super::test_support::HostFixture;
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU16, AtomicUsize, Ordering},
    },
    time::Duration,
};
use ycoding_core::{
    dots::{
        access::{ComputerAttach, ComputerProblem, ComputerState, ComputerStatus, ComputerTarget},
        computer::{self, Control, Dispatch, Method, Request, Response},
    },
    session::prompt_cache::sha256,
    ycoding_schema::LosslessString,
};

type Hook = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
type Gate = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);

struct Upstream {
    gets: AtomicUsize,
    posts: AtomicUsize,
    thread: Mutex<String>,
    query_thread: Mutex<Option<String>>,
    dot: Mutex<String>,
    environment: Mutex<String>,
    listed: Mutex<bool>,
    admin_disabled: Mutex<bool>,
    attached: Mutex<bool>,
    peer_attached: Mutex<bool>,
    paths: Mutex<Vec<String>>,
    connect_status: AtomicU16,
    hook: Mutex<Option<Hook>>,
    gate: Mutex<Option<Gate>>,
}

impl Upstream {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            gets: 0.into(),
            posts: 0.into(),
            thread: Mutex::new("thread-synthetic".into()),
            query_thread: Mutex::new(None),
            dot: Mutex::new("dot-synthetic".into()),
            environment: Mutex::new("executor-synthetic".into()),
            listed: Mutex::new(true),
            admin_disabled: Mutex::new(false),
            attached: Mutex::new(false),
            peer_attached: Mutex::new(true),
            paths: Mutex::new(Vec::new()),
            connect_status: 200.into(),
            hook: Mutex::new(None),
            gate: Mutex::new(None),
        })
    }

    fn posts(&self) -> usize {
        self.posts.load(Ordering::SeqCst)
    }

    fn dispatch(self: &Arc<Self>) -> Dispatch {
        let this = self.clone();
        Arc::new(move |request| {
            let this = this.clone();
            Box::pin(async move { Ok(this.respond(request).await) })
        })
    }

    async fn respond(&self, request: Request) -> Response {
        let json = |body: String| Response { status: 200, body };
        let thread = self.thread.lock().unwrap().clone();
        let queried = self
            .query_thread
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| thread.clone());
        let dot = self.dot.lock().unwrap().clone();
        let environment = self.environment.lock().unwrap().clone();
        match (request.method, request.path.as_str()) {
            (Method::Get, "/tbo") => {
                self.gets.fetch_add(1, Ordering::SeqCst);
                assert_eq!(request.credential.account_id, "synthetic-account");
                json(format!(
                    r#"{{"items":[{{"id":"{dot}","status":"active"}},{{"id":"dot-archived","status":"archived"}}],"cursor":null}}"#
                ))
            }
            (Method::Get, "/tbo/dot-synthetic/root-thread") => {
                self.gets.fetch_add(1, Ordering::SeqCst);
                let hook = self.hook.lock().unwrap().take();
                if let Some(hook) = hook {
                    hook().await;
                }
                json(format!(r#"{{"root_thread_id":"{thread}"}}"#))
            }
            (Method::Get, "/tbo/dot-synthetic/computers") => {
                self.gets.fetch_add(1, Ordering::SeqCst);
                assert_eq!(
                    request.query,
                    vec![("expected_thread_id".to_owned(), queried)]
                );
                let rows = if *self.listed.lock().unwrap() {
                    format!(
                        r#"[{{"environment_id":"other-executor","display_name":"Other","is_attached":{},"can_connect":true,"can_disconnect":true}},{{"environment_id":"{environment}","display_name":"Synthetic\u0000 Mac","is_attached":{},"can_connect":true,"can_disconnect":true}}]"#,
                        *self.peer_attached.lock().unwrap(),
                        *self.attached.lock().unwrap()
                    )
                } else {
                    "[]".into()
                };
                json(format!(
                    r#"{{"thread_id":"{thread}","computers":{rows},"local_computer_access_disabled_by_admin":{}}}"#,
                    *self.admin_disabled.lock().unwrap()
                ))
            }
            (Method::Post, path)
                if path
                    == "/tbo/dot-synthetic/computers/executor-synthetic/connect-and-replace"
                    || path == "/tbo/dot-synthetic/computers/executor-synthetic/connect" =>
            {
                self.posts.fetch_add(1, Ordering::SeqCst);
                self.paths.lock().unwrap().push(path.to_owned());
                assert_eq!(
                    request.query,
                    vec![("expected_thread_id".to_owned(), queried)]
                );
                let gate = self.gate.lock().unwrap().take();
                if let Some((entered, release)) = gate {
                    let _ = entered.send(());
                    let _ = release.await;
                }
                let status = self.connect_status.load(Ordering::SeqCst);
                if (200..300).contains(&status) {
                    *self.attached.lock().unwrap() = true;
                    if path.ends_with("/connect-and-replace") {
                        *self.peer_attached.lock().unwrap() = false;
                    }
                }
                Response {
                    status,
                    body: String::new(),
                }
            }
            _ => Response {
                status: 404,
                body: String::new(),
            },
        }
    }
}

fn write_executor(fixture: &HostFixture, status: &str) {
    write_executor_as(fixture, status, " executor-synthetic ");
}

fn write_executor_as(fixture: &HostFixture, status: &str, executor: &str) {
    std::fs::write(
        fixture.state_path().with_file_name("cca-executor.json"),
        format!(
            r#"{{"installationID":"installation-synthetic","status":"{status}","accountHash":"{}","executorID":"{executor}","createdAt":"1","updatedAt":"1"}}"#,
            sha256("synthetic-account")
        ),
    )
    .unwrap();
}

fn control(fixture: &HostFixture, upstream: &Arc<Upstream>) -> Control {
    Control::new(computer::Settings {
        host: fixture.host.clone(),
        state_path: fixture.state_path().with_file_name("cca-executor.json"),
        dispatch: upstream.dispatch(),
        now: Arc::new(|| 0),
        observe: Duration::from_secs(5),
        connect: Duration::from_secs(5),
        supplement: Duration::from_secs(5),
        diagnostic: Arc::new(|_| {}),
    })
}

fn target(status: &ComputerStatus) -> ComputerTarget {
    status.target.clone().expect("observed target")
}

fn input(replace_others: bool, expected_target: Option<ComputerTarget>) -> ComputerAttach {
    ComputerAttach {
        replace_others,
        expected_target,
    }
}

#[tokio::test]
async fn observation_reports_name_and_target_without_any_attach_request() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let status = control(&fixture, &upstream).computer().await;
    assert_eq!(status.state, ComputerState::Detached);
    assert_eq!(status.problem, None);
    assert_eq!(status.name, Some(LosslessString::from("Synthetic  Mac")));
    let observed = target(&status);
    assert_eq!(observed.dot_id, LosslessString::from("dot-synthetic"));
    assert_eq!(observed.thread_id, LosslessString::from("thread-synthetic"));
    assert_eq!(
        observed.environment_id,
        LosslessString::from("executor-synthetic")
    );
    assert!(observed.is_valid());
    let ycoding_core::dots::native::Configuration::Enabled {
        access_revision,
        profile,
        credential_id,
        account_id,
        account_generation,
    } = fixture.host.configuration().unwrap()
    else {
        panic!("fixture access disabled")
    };
    let key = computer::owner_key(
        access_revision,
        &profile,
        &credential_id,
        &account_id,
        account_generation,
        &"executor-synthetic".into(),
        &"installation-synthetic".into(),
        &sha256("synthetic-account"),
        "completed",
    );
    assert_eq!(
        observed.revision,
        computer::receipt_revision(
            &key,
            &"dot-synthetic".into(),
            &"thread-synthetic".into(),
            &"executor-synthetic".into()
        )
    );
    assert_eq!(upstream.posts(), 0);
}

#[tokio::test]
async fn attach_without_an_expected_target_posts_once_and_reports_the_attached_computer() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let control = control(&fixture, &upstream);
    let before = target(&control.computer().await);
    let status = control.attach(input(true, None)).await;
    assert_eq!(status.state, ComputerState::Attached);
    assert_eq!(status.problem, None);
    assert_eq!(target(&status), before);
    assert_eq!(upstream.posts(), 1);
}

#[tokio::test]
async fn attach_with_the_observed_target_posts_once() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let control = control(&fixture, &upstream);
    let observed = target(&control.computer().await);
    let status = control.attach(input(true, Some(observed.clone()))).await;
    assert_eq!(status.state, ComputerState::Attached);
    assert_eq!(target(&status), observed);
    assert_eq!(upstream.posts(), 1);
}

#[tokio::test]
async fn every_mismatching_target_field_fails_before_any_attach_request() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let control = control(&fixture, &upstream);
    let observed = target(&control.computer().await);
    for expected in [
        ComputerTarget {
            dot_id: "dot-other".into(),
            ..observed.clone()
        },
        ComputerTarget {
            thread_id: "thread-other".into(),
            ..observed.clone()
        },
        ComputerTarget {
            environment_id: "environment-other".into(),
            ..observed.clone()
        },
        ComputerTarget {
            revision: "0".repeat(64),
            ..observed.clone()
        },
    ] {
        let status = control.attach(input(true, Some(expected))).await;
        assert_eq!(status.state, ComputerState::Unavailable);
        assert_eq!(status.problem, Some(ComputerProblem::TargetChanged));
        assert_eq!(status.target, None);
    }
    assert_eq!(upstream.posts(), 0);
}

#[tokio::test]
async fn a_root_thread_change_after_the_expected_target_was_read_fails_before_any_attach_request() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let control = control(&fixture, &upstream);
    let observed = target(&control.computer().await);
    *upstream.thread.lock().unwrap() = "thread-replaced".into();
    let status = control.attach(input(true, Some(observed))).await;
    assert_eq!(status.problem, Some(ComputerProblem::TargetChanged));
    assert_eq!(upstream.posts(), 0);
}

#[tokio::test]
async fn failed_and_uncertain_attach_responses_are_never_a_confirmed_attach() {
    for (code, problem) in [
        (403, ComputerProblem::Rejected),
        (500, ComputerProblem::Unconfirmed),
        (429, ComputerProblem::Unconfirmed),
    ] {
        let fixture = HostFixture::new().await;
        write_executor(&fixture, "completed");
        let upstream = Upstream::new();
        upstream.connect_status.store(code, Ordering::SeqCst);
        let status = control(&fixture, &upstream).attach(input(true, None)).await;
        assert_eq!(status.state, ComputerState::Detached, "{code}");
        assert_eq!(status.problem, Some(problem), "{code}");
        assert_eq!(upstream.posts(), 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_identical_attaches_share_one_request() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    *upstream.gate.lock().unwrap() = Some((entered, held));
    let control = control(&fixture, &upstream);
    let first = tokio::spawn({
        let control = control.clone();
        async move { control.attach(input(true, None)).await }
    });
    observed.await.unwrap();
    let second = tokio::spawn({
        let control = control.clone();
        async move { control.attach(input(true, None)).await }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    release.send(()).unwrap();
    let (first, second) = (first.await.unwrap(), second.await.unwrap());
    assert_eq!(first, second);
    assert_eq!(first.state, ComputerState::Attached);
    assert_eq!(upstream.posts(), 1);
}

#[tokio::test]
async fn missing_or_incomplete_enrollment_is_reported_before_any_request() {
    let fixture = HostFixture::new().await;
    let upstream = Upstream::new();
    let control = control(&fixture, &upstream);
    assert_eq!(
        control.computer().await.problem,
        Some(ComputerProblem::Enrollment)
    );
    write_executor(&fixture, "pending");
    assert_eq!(
        control.attach(input(true, None)).await.problem,
        Some(ComputerProblem::Enrollment)
    );
    assert_eq!(upstream.gets.load(Ordering::SeqCst), 0);
    assert_eq!(upstream.posts(), 0);
}

#[tokio::test]
async fn an_unlisted_or_admin_disabled_computer_never_reaches_the_attach_request() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let control = control(&fixture, &upstream);
    *upstream.admin_disabled.lock().unwrap() = true;
    let disabled = control.attach(input(true, None)).await;
    assert_eq!(disabled.state, ComputerState::Detached);
    assert_eq!(disabled.problem, Some(ComputerProblem::AdminDisabled));
    *upstream.admin_disabled.lock().unwrap() = false;
    *upstream.listed.lock().unwrap() = false;
    let unlisted = control.attach(input(true, None)).await;
    assert_eq!(unlisted.state, ComputerState::Unavailable);
    assert_eq!(unlisted.problem, Some(ComputerProblem::NotListed));
    assert_eq!(upstream.posts(), 0);
}

#[tokio::test]
async fn revoking_access_during_observation_fails_closed_without_an_attach_request() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let access = fixture.access.clone();
    let revision = access.get().unwrap().revision;
    *upstream.hook.lock().unwrap() = Some(Arc::new(move || {
        let access = access.clone();
        Box::pin(async move {
            access.set(false, revision).await.unwrap();
        })
    }));
    let status = control(&fixture, &upstream).attach(input(true, None)).await;
    assert_eq!(status.state, ComputerState::Unavailable);
    assert_eq!(status.problem, Some(ComputerProblem::Configuration));
    assert_eq!(status.target, None);
    assert_eq!(upstream.posts(), 0);
}

#[tokio::test]
async fn a_lone_surrogate_thread_is_a_valid_target_and_travels_as_a_replacement_character_in_queries()
 {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    *upstream.thread.lock().unwrap() = r"thread-\ud800".into();
    *upstream.query_thread.lock().unwrap() = Some("thread-\u{fffd}".into());
    let control = control(&fixture, &upstream);
    let observed = target(&control.computer().await);
    assert_eq!(
        observed.thread_id,
        LosslessString::from_utf16("thread-".encode_utf16().chain([0xd800]).collect())
    );
    assert!(observed.is_valid());
    let status = control.attach(input(true, Some(observed.clone()))).await;
    assert_eq!(status.state, ComputerState::Attached);
    assert_eq!(target(&status), observed);
    assert_eq!(upstream.posts(), 1);
}

#[tokio::test]
async fn a_lone_surrogate_dot_or_environment_fails_as_a_connection_problem_before_any_attach_request()
 {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    *upstream.dot.lock().unwrap() = r"dot-\ud800".into();
    let status = control(&fixture, &upstream).attach(input(true, None)).await;
    assert_eq!(status.state, ComputerState::Unavailable);
    assert_eq!(status.problem, Some(ComputerProblem::Connection));
    assert_eq!(upstream.gets.load(Ordering::SeqCst), 1);
    assert_eq!(upstream.posts(), 0);

    let fixture = HostFixture::new().await;
    write_executor_as(&fixture, "completed", r"executor-\ud800");
    let upstream = Upstream::new();
    *upstream.environment.lock().unwrap() = r"executor-\ud800".into();
    let control = control(&fixture, &upstream);
    let observed = control.computer().await;
    assert_eq!(observed.state, ComputerState::Detached);
    assert!(observed.target.is_some());
    let status = control.attach(input(true, None)).await;
    assert_eq!(status.state, ComputerState::Unavailable);
    assert_eq!(status.problem, Some(ComputerProblem::Connection));
    assert_eq!(upstream.posts(), 0);
}

#[tokio::test]
async fn a_non_replacing_attach_posts_connect_once_and_keeps_the_attached_peer() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let control = control(&fixture, &upstream);
    let observed = target(&control.computer().await);
    let status = control.attach(input(false, Some(observed.clone()))).await;
    assert_eq!(status.state, ComputerState::Attached);
    assert_eq!(target(&status), observed);
    assert_eq!(upstream.posts(), 1);
    assert_eq!(
        upstream.paths.lock().unwrap().clone(),
        ["/tbo/dot-synthetic/computers/executor-synthetic/connect"]
    );
    assert!(*upstream.peer_attached.lock().unwrap());
}

#[tokio::test]
async fn a_replacing_attach_posts_connect_and_replace_and_detaches_the_peer() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let control = control(&fixture, &upstream);
    let observed = target(&control.computer().await);
    let status = control.attach(input(true, Some(observed.clone()))).await;
    assert_eq!(status.state, ComputerState::Attached);
    assert_eq!(target(&status), observed);
    assert_eq!(upstream.posts(), 1);
    assert_eq!(
        upstream.paths.lock().unwrap().clone(),
        ["/tbo/dot-synthetic/computers/executor-synthetic/connect-and-replace"]
    );
    assert!(!*upstream.peer_attached.lock().unwrap());
}

#[tokio::test]
async fn a_refused_non_replacing_attach_posts_once_and_never_falls_back_to_replacement() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    upstream.connect_status.store(409, Ordering::SeqCst);
    let status = control(&fixture, &upstream)
        .attach(input(false, None))
        .await;
    assert_eq!(status.state, ComputerState::Detached);
    assert_eq!(status.problem, Some(ComputerProblem::Rejected));
    assert_eq!(upstream.posts(), 1);
    assert_eq!(
        upstream.paths.lock().unwrap().clone(),
        ["/tbo/dot-synthetic/computers/executor-synthetic/connect"]
    );
    assert!(*upstream.peer_attached.lock().unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replacing_and_non_replacing_attaches_with_the_same_target_post_separately() {
    let fixture = HostFixture::new().await;
    write_executor(&fixture, "completed");
    let upstream = Upstream::new();
    let (entered, observed) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    *upstream.gate.lock().unwrap() = Some((entered, held));
    let control = control(&fixture, &upstream);
    let first = tokio::spawn({
        let control = control.clone();
        async move { control.attach(input(false, None)).await }
    });
    observed.await.unwrap();
    let second = tokio::spawn({
        let control = control.clone();
        async move { control.attach(input(true, None)).await }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    release.send(()).unwrap();
    let (first, second) = (first.await.unwrap(), second.await.unwrap());
    assert_eq!(first.state, ComputerState::Attached);
    assert_eq!(second.state, ComputerState::Attached);
    assert_eq!(upstream.posts(), 2);
    let mut paths = upstream.paths.lock().unwrap().clone();
    paths.sort();
    assert_eq!(
        paths,
        [
            "/tbo/dot-synthetic/computers/executor-synthetic/connect",
            "/tbo/dot-synthetic/computers/executor-synthetic/connect-and-replace",
        ]
    );
}
