use super::executor::{
    Context, Declined, Failure, Problem, Record, Refresh, Rename, Root, Status, capability_roots,
    load, reconcile, register, rename, reregister, resolve, same_roots,
};
use super::test_support::{self, WALL_BASE};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;
use ycoding_core::{
    dots::{access, enrollment, native},
    session::prompt_cache::sha256,
    ycoding_schema::{JsonValue, LosslessString, parse_json},
};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-dots-executor-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn state(&self) -> PathBuf {
        self.0.join("cca-executor.json")
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

type Reply = Result<enrollment::ExecutorResponse, access::Error>;
struct Script {
    replies: Mutex<VecDeque<Reply>>,
    sent: Mutex<Vec<(String, String, String)>>,
}
impl Script {
    fn new(replies: Vec<Reply>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            sent: Mutex::new(Vec::new()),
        })
    }
    fn post(self: &Arc<Self>) -> enrollment::ExecutorPost {
        let script = self.clone();
        Arc::new(move |request| {
            script.sent.lock().unwrap().push((
                request.credential.access_token.clone(),
                request.credential.account_id.clone(),
                request.body.clone(),
            ));
            let reply = script
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unscripted executor request");
            Box::pin(async move { reply })
        })
    }
    fn count(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
    fn body(&self, index: usize) -> JsonValue {
        parse_json(&self.sent.lock().unwrap()[index].2).unwrap()
    }
}

fn reply(status: u16, body: &str) -> Reply {
    Ok(enrollment::ExecutorResponse {
        status,
        challenged: false,
        body: body.into(),
    })
}
fn completed(executor_id: &str) -> Reply {
    reply(200, &format!(r#"{{"executor_id":"{executor_id}"}}"#))
}

fn credential(access: &str, account: &str) -> Arc<native::ResolvedCredential> {
    Arc::new(native::ResolvedCredential {
        profile: "selected".into(),
        credential_id: "credential-fixture".into(),
        account_id: account.into(),
        account_generation: 1,
        access_token: access.into(),
    })
}

fn n(text: &str) -> LosslessString {
    LosslessString::from(text)
}
fn shown(value: &Option<LosslessString>) -> Option<String> {
    value.as_ref().and_then(|value| value.to_utf8().ok())
}
fn units(value: &JsonValue) -> Vec<u16> {
    let JsonValue::String(value) = value else {
        panic!("not a string: {value:?}")
    };
    value.code_units().collect()
}

fn roots() -> Vec<Root> {
    capability_roots(Path::new("/synthetic-home"), Path::new("/synthetic-data"))
}

fn object<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("not an object: {value:?}")
    };
    object.get(&name.into()).unwrap_or(&JsonValue::Null)
}
fn text(value: &JsonValue, name: &str) -> Option<String> {
    match object(value, name) {
        JsonValue::String(text) => text.to_utf8().ok(),
        _ => None,
    }
}
fn saved(path: &Path) -> JsonValue {
    parse_json(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn cancel() -> (watch::Sender<bool>, watch::Receiver<bool>) {
    watch::channel(false)
}

struct Fixture {
    directory: Directory,
    clock: test_support::TestClock,
    armed: tokio::sync::mpsc::UnboundedReceiver<u64>,
}
impl Fixture {
    fn new() -> Self {
        let (clock, armed) = test_support::clock();
        Self {
            directory: Directory::new(),
            clock,
            armed,
        }
    }
}
fn context<'a>(
    path: &'a Path,
    post: &'a enrollment::ExecutorPost,
    clock: &'a test_support::TestClock,
    refresh: Option<&'a Refresh>,
) -> Context<'a> {
    Context {
        path,
        post,
        clock,
        refresh,
    }
}

#[test]
fn capability_roots_are_the_codex_home_and_ycoding_dots_skill_directories_in_order() {
    let roots = roots();
    assert_eq!(roots.len(), 2);
    assert_eq!(roots[0].id, "codex-home-skills");
    assert_eq!(roots[0].path, "/synthetic-home/.agents/skills");
    assert_eq!(roots[1].id, "ycoding-dots-skills");
    assert_eq!(roots[1].path, "/synthetic-data/dots/skills");
    assert!(same_roots(Some(roots.as_slice()), &roots));
    assert!(!same_roots(None, &roots));
    assert!(!same_roots(Some(&roots[..1]), &roots));
    let mut reversed = roots.clone();
    reversed.reverse();
    assert!(!same_roots(Some(reversed.as_slice()), &roots));
    let mut moved = roots.clone();
    moved[1].path = "/elsewhere".into();
    assert!(!same_roots(Some(moved.as_slice()), &roots));
}

#[tokio::test]
async fn registration_reserves_privately_posts_the_canonical_body_and_completes() {
    let fixture = Fixture::new();
    let script = Script::new(vec![reply(
        200,
        r#"{"executor_id":"  exec-1  ","custom_display_name":"Renamed"}"#,
    )]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let record = register(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        "  inst-1  ",
        &n("  Synthetic Host (abc123)  "),
        &roots(),
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(record.status, Status::Completed);
    assert_eq!(shown(&record.executor_id).as_deref(), Some("exec-1"));
    assert_eq!(
        shown(&record.custom_display_name).as_deref(),
        Some("Renamed")
    );
    assert_eq!(
        shown(&record.display_name).as_deref(),
        Some("Synthetic Host (abc123)")
    );
    assert_eq!(record.installation_id, "inst-1");
    assert_eq!(record.account_hash, sha256("synthetic-account"));
    assert_eq!(record.roots.as_deref(), Some(roots().as_slice()));
    assert_eq!(script.count(), 1);
    assert_eq!(script.sent.lock().unwrap()[0].0, "synthetic-access");
    assert_eq!(script.sent.lock().unwrap()[0].1, "synthetic-account");
    let body = script.body(0);
    assert_eq!(
        text(&body, "displayName").as_deref(),
        Some("Synthetic Host (abc123)")
    );
    assert_eq!(text(&body, "installation_id").as_deref(), Some("inst-1"));
    let JsonValue::Array(sent_roots) = object(&body, "selected_capability_roots") else {
        panic!("roots are not an array")
    };
    assert_eq!(sent_roots.len(), 2);
    assert_eq!(
        text(&sent_roots[0], "id").as_deref(),
        Some("codex-home-skills")
    );
    assert_eq!(
        text(&sent_roots[1], "path").as_deref(),
        Some("/synthetic-data/dots/skills")
    );
    let JsonValue::Object(fields) = &body else {
        panic!()
    };
    assert_eq!(fields.iter().count(), 3);
    let file = saved(&fixture.directory.state());
    assert_eq!(text(&file, "status").as_deref(), Some("completed"));
    assert_eq!(text(&file, "executorID").as_deref(), Some("exec-1"));
    assert_eq!(text(&file, "installationID").as_deref(), Some("inst-1"));
    assert_eq!(
        text(&file, "accountHash").as_deref(),
        Some(sha256("synthetic-account").as_str())
    );
    assert_eq!(text(&file, "customDisplayName").as_deref(), Some("Renamed"));
    assert_eq!(
        text(&file, "displayName").as_deref(),
        Some("Synthetic Host (abc123)")
    );
    for field in ["createdAt", "updatedAt"] {
        let stamp = text(&file, field).unwrap();
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert!(
            stamp.starts_with("2026-10-31T10:00:00.000") && stamp.ends_with('Z'),
            "{stamp}"
        );
    }
    assert_eq!(
        load(&fixture.directory.state()).await.unwrap().unwrap(),
        record
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(fixture.directory.state())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[tokio::test]
async fn display_names_follow_javascript_trim_and_utf16_slice_semantics() {
    let fixture = Fixture::new();
    let script = Script::new(vec![completed("exec-1")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let name = format!("\u{feff}\u{a0}{}{}\u{3000}", "a".repeat(99), "😀😀");
    let record = register(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        "inst-1",
        &n(&name),
        &[],
        &mut stop,
    )
    .await
    .unwrap();
    let mut expected = vec![u16::from(b'a'); 99];
    expected.push(0xd83d);
    assert_eq!(units(object(&script.body(0), "displayName")), expected);
    assert_eq!(
        record
            .display_name
            .as_ref()
            .unwrap()
            .code_units()
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        units(object(&saved(&fixture.directory.state()), "displayName")),
        expected
    );
    assert_eq!(
        load(&fixture.directory.state()).await.unwrap().unwrap(),
        record
    );
    let JsonValue::Array(sent_roots) = object(&script.body(0), "selected_capability_roots").clone()
    else {
        panic!()
    };
    assert!(sent_roots.is_empty());
}

#[tokio::test]
async fn name_trimming_keeps_next_line_and_removes_only_javascript_whitespace() {
    let fixture = Fixture::new();
    let script = Script::new(vec![completed("exec-1")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    register(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        "inst-1",
        &n("\u{85}x\u{85}"),
        &[],
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(
        units(object(&script.body(0), "displayName")),
        vec![0x85, u16::from(b'x'), 0x85]
    );
}

#[tokio::test]
async fn an_existing_state_file_blocks_a_second_reservation_and_never_posts() {
    let fixture = Fixture::new();
    std::fs::write(fixture.directory.state(), "sentinel").unwrap();
    let script = Script::new(vec![]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let failure = register(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        "inst-1",
        &n("Host"),
        &roots(),
        &mut stop,
    )
    .await
    .unwrap_err();
    assert!(!failure.cancelled);
    assert_eq!(script.count(), 0);
    assert_eq!(
        std::fs::read_to_string(fixture.directory.state()).unwrap(),
        "sentinel"
    );
}

#[tokio::test]
async fn blank_inputs_fail_before_any_state_or_request_exists() {
    let fixture = Fixture::new();
    let script = Script::new(vec![]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    for (installation, name) in [("  ", "Host"), ("inst-1", "   "), ("", "")] {
        register(
            &context(&fixture.directory.state(), &post, &fixture.clock, None),
            &credential("synthetic-access", "synthetic-account"),
            installation,
            &n(name),
            &roots(),
            &mut stop,
        )
        .await
        .unwrap_err();
    }
    assert_eq!(script.count(), 0);
    assert!(!fixture.directory.state().exists());
}

#[tokio::test]
async fn retryable_failures_remove_the_reservation_and_definitive_ones_record_failed() {
    for (status, retryable) in [
        (401u16, true),
        (408, true),
        (429, true),
        (500, true),
        (503, true),
        (599, true),
        (400, false),
        (403, false),
        (404, false),
        (409, false),
        (422, false),
    ] {
        let fixture = Fixture::new();
        let script = Script::new(vec![reply(status, "{}")]);
        let post = script.post();
        let (_stop, mut stop) = cancel();
        let failure = register(
            &context(&fixture.directory.state(), &post, &fixture.clock, None),
            &credential("synthetic-access", "synthetic-account"),
            "inst-1",
            &n("Host"),
            &roots(),
            &mut stop,
        )
        .await
        .unwrap_err();
        assert_eq!(failure.retryable, retryable, "{status}");
        assert_eq!(failure.status, Some(status));
        if retryable {
            assert!(!fixture.directory.state().exists(), "{status}");
        } else {
            let file = saved(&fixture.directory.state());
            assert_eq!(text(&file, "status").as_deref(), Some("failed"), "{status}");
            assert_eq!(
                text(&file, "errorClassification").as_deref(),
                Some("failed")
            );
            assert_eq!(text(&file, "executorID"), None);
        }
    }
}

#[tokio::test]
async fn a_cloudflare_challenge_is_definitive_even_for_a_retryable_status() {
    let fixture = Fixture::new();
    let script = Script::new(vec![Ok(enrollment::ExecutorResponse {
        status: 503,
        challenged: true,
        body: String::new(),
    })]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let failure = register(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        "inst-1",
        &n("Host"),
        &roots(),
        &mut stop,
    )
    .await
    .unwrap_err();
    assert!(!failure.retryable);
    assert_eq!(failure.status, Some(503));
    assert_eq!(
        text(&saved(&fixture.directory.state()), "status").as_deref(),
        Some("failed")
    );
}

#[tokio::test]
async fn transport_errors_including_redirects_are_retryable_and_leave_no_state() {
    let fixture = Fixture::new();
    let script = Script::new(vec![Err(access::Error::Unavailable)]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let failure = register(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        "inst-1",
        &n("Host"),
        &roots(),
        &mut stop,
    )
    .await
    .unwrap_err();
    assert!(failure.retryable);
    assert_eq!(failure.status, None);
    assert!(!fixture.directory.state().exists());
}

#[tokio::test]
async fn invalid_success_payloads_are_definitive() {
    for body in [
        "",
        "not json",
        "[]",
        "{}",
        r#"{"executor_id":""}"#,
        r#"{"executor_id":"   "}"#,
        r#"{"executor_id":7}"#,
        r#"{"executor_id":"exec-1","custom_display_name":7}"#,
        r#"{"executor_id":"exec-1","custom_display_name":{}}"#,
    ] {
        let fixture = Fixture::new();
        let script = Script::new(vec![reply(200, body)]);
        let post = script.post();
        let (_stop, mut stop) = cancel();
        let failure = register(
            &context(&fixture.directory.state(), &post, &fixture.clock, None),
            &credential("synthetic-access", "synthetic-account"),
            "inst-1",
            &n("Host"),
            &roots(),
            &mut stop,
        )
        .await
        .unwrap_err();
        assert!(!failure.retryable, "{body}");
        assert_eq!(
            text(&saved(&fixture.directory.state()), "status").as_deref(),
            Some("failed"),
            "{body}"
        );
    }
    let fixture = Fixture::new();
    let script = Script::new(vec![reply(
        200,
        r#"{"executor_id":"exec-1","custom_display_name":null}"#,
    )]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let record = register(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        "inst-1",
        &n("Host"),
        &roots(),
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(record.custom_display_name, None);
}

#[tokio::test]
async fn unauthorized_refreshes_once_and_only_to_the_same_account() {
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let refresh_to = |next: Option<Arc<native::ResolvedCredential>>| -> Refresh {
        let seen = seen.clone();
        Arc::new(move |rejected| {
            seen.lock().unwrap().push(rejected);
            let next = next.clone();
            Box::pin(async move { next })
        })
    };
    {
        let fixture = Fixture::new();
        let script = Script::new(vec![reply(401, "{}"), completed("exec-1")]);
        let post = script.post();
        let refresh = refresh_to(Some(credential("renewed-access", "synthetic-account")));
        let (_stop, mut stop) = cancel();
        let record = register(
            &context(
                &fixture.directory.state(),
                &post,
                &fixture.clock,
                Some(&refresh),
            ),
            &credential("stale-access", "synthetic-account"),
            "inst-1",
            &n("Host"),
            &roots(),
            &mut stop,
        )
        .await
        .unwrap();
        assert_eq!(shown(&record.executor_id).as_deref(), Some("exec-1"));
        assert_eq!(script.sent.lock().unwrap()[0].0, "stale-access");
        assert_eq!(script.sent.lock().unwrap()[1].0, "renewed-access");
        assert_eq!(seen.lock().unwrap().as_slice(), ["stale-access"]);
    }
    for next in [None, Some(credential("other-access", "other-account"))] {
        let fixture = Fixture::new();
        let script = Script::new(vec![reply(401, "{}")]);
        let post = script.post();
        let refresh = refresh_to(next);
        let (_stop, mut stop) = cancel();
        let failure = register(
            &context(
                &fixture.directory.state(),
                &post,
                &fixture.clock,
                Some(&refresh),
            ),
            &credential("stale-access", "synthetic-account"),
            "inst-1",
            &n("Host"),
            &roots(),
            &mut stop,
        )
        .await
        .unwrap_err();
        assert!(failure.retryable);
        assert_eq!(failure.status, Some(401));
        assert_eq!(script.count(), 1);
        assert!(!fixture.directory.state().exists());
    }
    {
        let fixture = Fixture::new();
        let script = Script::new(vec![reply(401, "{}"), reply(401, "{}")]);
        let post = script.post();
        let refresh = refresh_to(Some(credential("renewed-access", "synthetic-account")));
        let (_stop, mut stop) = cancel();
        let failure = register(
            &context(
                &fixture.directory.state(),
                &post,
                &fixture.clock,
                Some(&refresh),
            ),
            &credential("stale-access", "synthetic-account"),
            "inst-1",
            &n("Host"),
            &roots(),
            &mut stop,
        )
        .await
        .unwrap_err();
        assert!(failure.retryable);
        assert_eq!(script.count(), 2);
    }
}

#[tokio::test]
async fn cancellation_during_the_post_removes_the_reservation() {
    let fixture = Fixture::new();
    let (entered, mut observed) = tokio::sync::mpsc::unbounded_channel::<()>();
    let post: enrollment::ExecutorPost = Arc::new(move |_| {
        let entered = entered.clone();
        Box::pin(async move {
            let _ = entered.send(());
            std::future::pending::<Reply>().await
        })
    });
    let (stop, mut stopped) = cancel();
    let path = fixture.directory.state();
    let clock = fixture.clock.clone();
    let task = tokio::spawn(async move {
        register(
            &context(&path, &post, &clock, None),
            &credential("synthetic-access", "synthetic-account"),
            "inst-1",
            &n("Host"),
            &roots(),
            &mut stopped,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), observed.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        text(&saved(&fixture.directory.state()), "status").as_deref(),
        Some("pending")
    );
    stop.send_replace(true);
    let failure: Failure = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(failure.cancelled);
    assert!(!fixture.directory.state().exists());
}

async fn seed(fixture: &Fixture, executor_id: &str, account: &str, roots: &[Root]) -> Record {
    let script = Script::new(vec![completed(executor_id)]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    register(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", account),
        "inst-1",
        &n("Stored Host"),
        roots,
        &mut stop,
    )
    .await
    .unwrap()
}

fn installation(value: Option<&'static str>) -> super::executor::Installation {
    Box::new(move || Box::pin(async move { value.map(str::to_owned) }))
}

#[tokio::test]
async fn reregistration_replaces_roots_name_and_executor_and_keeps_the_identity_fields() {
    let mut fixture = Fixture::new();
    let original = seed(&fixture, "exec-1", "synthetic-account", &[]).await;
    let script = Script::new(vec![
        reply(503, "{}"),
        reply(
            200,
            r#"{"executor_id":"exec-2","custom_display_name":null}"#,
        ),
    ]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let path = fixture.directory.state();
    let clock = fixture.clock.clone();
    let record = original.clone();
    let task = tokio::spawn(async move {
        reregister(
            &context(&path, &post, &clock, None),
            &credential("synthetic-access", "synthetic-account"),
            &record,
            &n("  Fresh Name  "),
            &roots(),
            &mut stop,
        )
        .await
    });
    let armed = tokio::time::timeout(Duration::from_secs(5), fixture.armed.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(armed, 1_000);
    fixture.clock.advance_to(1_000);
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(result.executor_changed);
    assert_eq!(script.count(), 2);
    assert_eq!(
        text(&script.body(1), "displayName").as_deref(),
        Some("Fresh Name")
    );
    assert_eq!(
        text(&script.body(1), "installation_id").as_deref(),
        Some("inst-1")
    );
    let record = result.record;
    assert_eq!(shown(&record.executor_id).as_deref(), Some("exec-2"));
    assert_eq!(shown(&record.display_name).as_deref(), Some("Fresh Name"));
    assert_eq!(record.custom_display_name, None);
    assert_eq!(record.roots.as_deref(), Some(roots().as_slice()));
    assert_eq!(record.created_at, original.created_at);
    assert_eq!(record.account_hash, original.account_hash);
    assert_eq!(record.status, Status::Completed);
    assert!(record.updated_at.as_str() >= original.updated_at.as_str());
    assert_eq!(
        load(&fixture.directory.state()).await.unwrap().unwrap(),
        record
    );
}

#[tokio::test]
async fn reregistration_stops_after_two_attempts_and_leaves_the_stored_record_untouched() {
    let mut fixture = Fixture::new();
    let original = seed(&fixture, "exec-1", "synthetic-account", &[]).await;
    let before = std::fs::read_to_string(fixture.directory.state()).unwrap();
    let script = Script::new(vec![reply(500, "{}"), reply(500, "{}"), completed("never")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let path = fixture.directory.state();
    let clock = fixture.clock.clone();
    let task = tokio::spawn(async move {
        reregister(
            &context(&path, &post, &clock, None),
            &credential("synthetic-access", "synthetic-account"),
            &original,
            &n("Fresh Name"),
            &roots(),
            &mut stop,
        )
        .await
    });
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), fixture.armed.recv())
            .await
            .unwrap(),
        Some(1_000)
    );
    fixture.clock.advance_to(1_000);
    let failure = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .err()
        .unwrap();
    assert!(failure.retryable);
    assert_eq!(script.count(), 2);
    assert_eq!(
        std::fs::read_to_string(fixture.directory.state()).unwrap(),
        before
    );
}

#[tokio::test]
async fn reregistration_does_not_retry_definitive_failures_or_blank_names() {
    let fixture = Fixture::new();
    let original = seed(&fixture, "exec-1", "synthetic-account", &[]).await;
    let script = Script::new(vec![reply(403, "{}")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let failure = reregister(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        &original,
        &n("Fresh Name"),
        &roots(),
        &mut stop,
    )
    .await
    .err()
    .unwrap();
    assert!(!failure.retryable);
    assert_eq!(script.count(), 1);
    reregister(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        &original,
        &n("   "),
        &roots(),
        &mut stop,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(script.count(), 1);
}

#[tokio::test]
async fn resolve_registers_once_on_first_run_with_the_default_label_and_reuses_the_record() {
    let fixture = Fixture::new();
    let script = Script::new(vec![completed("exec-1")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let mut reconciled = false;
    let resolved = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(Some("inst-1")),
        },
        &mut reconciled,
        &mut stop,
    )
    .await
    .unwrap();
    assert!(reconciled);
    assert_eq!(resolved.executor_id, LosslessString::from("exec-1"));
    assert!(resolved.notes.is_empty());
    let name = text(&script.body(0), "displayName").unwrap();
    assert!(
        name.starts_with("synthetic-host") && name.ends_with(')'),
        "{name}"
    );
    assert!(
        name.contains(&format!(" ({})", &sha256("inst-1")[..6])),
        "{name}"
    );
    let again = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(None),
        },
        &mut reconciled,
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(again.executor_id, LosslessString::from("exec-1"));
    assert_eq!(script.count(), 1);
}

#[tokio::test]
async fn resolve_classifies_stored_state_and_fails_closed() {
    let fixture = Fixture::new();
    let script = Script::new(vec![]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let run = |installation_id: super::executor::Installation| {
        let (path, post, clock) = (
            fixture.directory.state(),
            post.clone(),
            fixture.clock.clone(),
        );
        async move {
            let (_stop, mut stop) = cancel();
            resolve(
                &context(&path, &post, &clock, None),
                &credential("synthetic-access", "synthetic-account"),
                super::executor::EnrollmentInput {
                    hostname: "synthetic-host",
                    configured_name: None,
                    roots: &roots(),
                    installation: &installation_id,
                },
                &mut false,
                &mut stop,
            )
            .await
            .err()
            .unwrap()
        }
    };
    let state = |status: &str, extra: &str| {
        format!(
            r#"{{"installationID":"inst-1","accountHash":"{}","status":"{status}","createdAt":"2026-10-31T10:00:00.000Z","updatedAt":"2026-10-31T10:00:00.000Z"{extra}}}"#,
            sha256("synthetic-account")
        )
    };
    for (content, expected) in [
        (state("pending", ""), "enrollment-uncertain"),
        (state("uncertain", ""), "enrollment-uncertain"),
        (state("bogus", ""), "enrollment-unreadable"),
        (state("completed", ""), "enrollment-unreadable"),
        (
            state("completed", r#","executorID":"   ""#),
            "enrollment-unreadable",
        ),
        (
            state("completed", r#","executorID":7"#),
            "enrollment-unreadable",
        ),
        ("not json".into(), "enrollment-unreadable"),
        ("[]".into(), "enrollment-unreadable"),
        (r#"{"status":"completed"}"#.into(), "enrollment-unreadable"),
        (
            state("completed", r#","executorID":"exec-1""#)
                .replace(&sha256("synthetic-account"), "other-hash"),
            "enrollment-account-mismatch",
        ),
    ] {
        std::fs::write(fixture.directory.state(), &content).unwrap();
        match run(installation(Some("inst-1"))).await {
            Problem::Rejected(category) => assert_eq!(category, expected, "{content}"),
            other => panic!("{content}: {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(fixture.directory.state()).unwrap(),
            content
        );
    }
    assert_eq!(script.count(), 0);
    let _ = &mut stop;
}

#[tokio::test]
async fn resolve_discards_a_failed_record_and_registers_again() {
    let fixture = Fixture::new();
    std::fs::write(
        fixture.directory.state(),
        format!(
            r#"{{"installationID":"inst-1","accountHash":"{}","status":"failed","createdAt":"a","updatedAt":"b"}}"#,
            sha256("synthetic-account")
        ),
    )
    .unwrap();
    let script = Script::new(vec![completed("exec-9")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let resolved = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(Some("inst-1")),
        },
        &mut false,
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(resolved.executor_id, LosslessString::from("exec-9"));
    assert_eq!(script.count(), 1);
}

#[tokio::test]
async fn resolve_maps_registration_failures_to_retry_or_rejection() {
    let fixture = Fixture::new();
    let (_stop, mut stop) = cancel();
    let script = Script::new(vec![reply(503, "{}")]);
    let post = script.post();
    let outcome = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(Some("inst-1")),
        },
        &mut false,
        &mut stop,
    )
    .await
    .err()
    .unwrap();
    assert!(matches!(outcome, Problem::Retry), "{outcome:?}");
    assert!(!fixture.directory.state().exists());
    let script = Script::new(vec![reply(403, "{}")]);
    let post = script.post();
    let outcome = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(Some("inst-1")),
        },
        &mut false,
        &mut stop,
    )
    .await
    .err()
    .unwrap();
    assert!(
        matches!(outcome, Problem::Rejected("enrollment-rejected")),
        "{outcome:?}"
    );
    std::fs::remove_file(fixture.directory.state()).unwrap();
    let outcome = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(None),
        },
        &mut false,
        &mut stop,
    )
    .await
    .err()
    .unwrap();
    assert!(matches!(outcome, Problem::Retry), "{outcome:?}");
    assert!(!fixture.directory.state().exists());
}

#[tokio::test]
async fn resolve_reregisters_changed_roots_and_keeps_the_old_record_when_that_fails() {
    let mut fixture = Fixture::new();
    let stale = vec![Root {
        id: "codex-home-skills".into(),
        path: "/old".into(),
    }];
    seed(&fixture, "exec-1", "synthetic-account", &stale).await;
    let script = Script::new(vec![completed("exec-2")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let mut reconciled = false;
    let resolved = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(None),
        },
        &mut reconciled,
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(resolved.executor_id, LosslessString::from("exec-2"));
    assert_eq!(resolved.notes, ["registration-executor-changed"]);
    assert_eq!(
        text(&script.body(0), "displayName").as_deref(),
        Some("Stored Host")
    );
    assert_eq!(
        load(&fixture.directory.state())
            .await
            .unwrap()
            .unwrap()
            .roots
            .as_deref(),
        Some(roots().as_slice())
    );
    let unchanged = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(None),
        },
        &mut reconciled,
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(unchanged.executor_id, LosslessString::from("exec-2"));
    assert!(unchanged.notes.is_empty());
    assert_eq!(script.count(), 1);

    let again = vec![Root {
        id: "ycoding-dots-skills".into(),
        path: "/other".into(),
    }];
    std::fs::remove_file(fixture.directory.state()).unwrap();
    seed(&fixture, "exec-3", "synthetic-account", &again).await;
    let script = Script::new(vec![reply(403, "{}"), reply(403, "{}")]);
    let post = script.post();
    let before = std::fs::read_to_string(fixture.directory.state()).unwrap();
    let kept = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(None),
        },
        &mut false,
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(kept.executor_id, LosslessString::from("exec-3"));
    assert_eq!(
        kept.notes,
        ["registration-update-failed", "registration-update-failed"]
    );
    assert_eq!(script.count(), 2);
    assert_eq!(
        std::fs::read_to_string(fixture.directory.state()).unwrap(),
        before
    );
    assert!(fixture.armed.try_recv().is_err());
    assert_eq!(fixture.clock.wall(), WALL_BASE);
}

#[tokio::test]
async fn the_default_name_cuts_the_host_by_utf16_units_before_the_suffix() {
    let fixture = Fixture::new();
    let script = Script::new(vec![completed("exec-1")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let hostname = format!("{}😀", "a".repeat(90));
    resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: &hostname,
            configured_name: None,
            roots: &roots(),
            installation: &installation(Some("inst-1")),
        },
        &mut false,
        &mut stop,
    )
    .await
    .unwrap();
    let sent = units(object(&script.body(0), "displayName"));
    let suffix = format!(" ({})", &sha256("inst-1")[..6])
        .encode_utf16()
        .collect::<Vec<_>>();
    assert_eq!(sent.len(), 100);
    assert_eq!(sent[90], 0xd83d);
    assert!(sent[..90].iter().all(|unit| *unit == u16::from(b'a')));
    assert_eq!(&sent[91..], suffix.as_slice());
}

#[tokio::test]
async fn resolve_registers_with_the_configured_label_and_reregisters_with_it_over_the_stored_one() {
    let fixture = Fixture::new();
    let script = Script::new(vec![completed("exec-1")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let configured = n("  Configured Label  ");
    let resolved = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: Some(&configured),
            roots: &roots(),
            installation: &installation(Some("inst-1")),
        },
        &mut false,
        &mut stop,
    )
    .await
    .unwrap();
    assert!(!resolved.roots_changed);
    assert_eq!(
        text(&script.body(0), "displayName").as_deref(),
        Some("Configured Label")
    );

    let stale = Fixture::new();
    seed(&stale, "exec-1", "synthetic-account", &[]).await;
    for (label, expected) in [
        (Some(&configured), "Configured Label"),
        (None, "Stored Host"),
    ] {
        let script = Script::new(vec![completed("exec-1")]);
        let post = script.post();
        let before = std::fs::read_to_string(stale.directory.state()).unwrap();
        let resolved = resolve(
            &context(&stale.directory.state(), &post, &stale.clock, None),
            &credential("synthetic-access", "synthetic-account"),
            super::executor::EnrollmentInput {
                hostname: "synthetic-host",
                configured_name: label,
                roots: &roots(),
                installation: &installation(None),
            },
            &mut false,
            &mut stop,
        )
        .await
        .unwrap();
        assert!(!resolved.roots_changed);
        assert_eq!(
            text(&script.body(0), "displayName").as_deref(),
            Some(expected)
        );
        assert_eq!(resolved.record.roots.as_deref(), Some(roots().as_slice()));
        std::fs::write(stale.directory.state(), before).unwrap();
    }
}

async fn renamed(
    fixture: &Fixture,
    record: &Record,
    label: &str,
    replies: Vec<Reply>,
) -> (Result<super::executor::Renamed, Failure>, Arc<Script>) {
    let script = Script::new(replies);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let result = rename(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        record,
        &n(label),
        &mut stop,
    )
    .await;
    (result, script)
}

#[tokio::test]
async fn rename_confirms_posts_the_installation_and_label_and_clears_the_intent() {
    let fixture = Fixture::new();
    let record = seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let (result, script) = renamed(
        &fixture,
        &record,
        "  New Label  ",
        vec![reply(
            200,
            r#"{"executor_id":"exec-1","custom_display_name":"New Label"}"#,
        )],
    )
    .await;
    let result = result.unwrap();
    assert_eq!(
        (result.outcome, result.persisted),
        (Rename::Confirmed, true)
    );
    assert_eq!(
        text(&script.body(0), "installation_id").as_deref(),
        Some("inst-1")
    );
    assert_eq!(
        text(&script.body(0), "custom_display_name").as_deref(),
        Some("New Label")
    );
    let stored = load(&fixture.directory.state()).await.unwrap().unwrap();
    assert_eq!(
        shown(&stored.custom_display_name).as_deref(),
        Some("New Label")
    );
    assert_eq!(stored.rename_declined, None);
    assert_eq!(stored, result.record);
    assert_eq!(shown(&stored.executor_id).as_deref(), Some("exec-1"));
}

#[tokio::test]
async fn rename_answered_with_a_name_confirmed_replacement_adopts_it_without_a_decline() {
    let fixture = Fixture::new();
    let record = seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let (result, _) = renamed(
        &fixture,
        &record,
        "Label",
        vec![reply(
            200,
            r#"{"executor_id":"exec-2","custom_display_name":"Label"}"#,
        )],
    )
    .await;
    let result = result.unwrap();
    assert_eq!(
        (result.outcome, result.persisted),
        (Rename::ExecutorChanged, true)
    );
    let stored = load(&fixture.directory.state()).await.unwrap().unwrap();
    assert_eq!(stored, result.record);
    assert_eq!(shown(&stored.executor_id).as_deref(), Some("exec-2"));
    assert_eq!(shown(&stored.custom_display_name).as_deref(), Some("Label"));
    assert_eq!(stored.rename_declined, None);
    assert_eq!(
        object(&saved(&fixture.directory.state()), "renameDeclined"),
        &JsonValue::Null
    );
}

#[tokio::test]
async fn rename_that_the_service_answers_differently_is_remembered_as_declined() {
    let fixture = Fixture::new();
    let record = seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    for (reply_body, outcome, declined) in [
        (
            r#"{"executor_id":"exec-2","custom_display_name":"Other"}"#,
            Rename::Unconfirmed,
            Declined::Unconfirmed,
        ),
        (
            r#"{"executor_id":"exec-2","custom_display_name":null}"#,
            Rename::Unconfirmed,
            Declined::Unconfirmed,
        ),
        (
            r#"{"executor_id":"exec-1","custom_display_name":null}"#,
            Rename::Unconfirmed,
            Declined::Unconfirmed,
        ),
        (
            r#"{"executor_id":"exec-1","custom_display_name":"Other"}"#,
            Rename::Unconfirmed,
            Declined::Unconfirmed,
        ),
    ] {
        let (result, _) = renamed(&fixture, &record, "Label", vec![reply(200, reply_body)]).await;
        let result = result.unwrap();
        assert_eq!((result.outcome, result.persisted), (outcome, true));
        let stored = load(&fixture.directory.state()).await.unwrap().unwrap();
        let remembered = stored.rename_declined.clone().unwrap();
        assert_eq!(remembered.label, n("Label"));
        assert_eq!(remembered.outcome, declined);
        assert_eq!(
            object(
                object(&saved(&fixture.directory.state()), "renameDeclined"),
                "offeredExecutorID"
            ),
            &JsonValue::Null
        );
        assert_eq!(shown(&stored.executor_id).as_deref(), Some("exec-1"));
        assert_eq!(stored.custom_display_name, None);
    }
}

#[tokio::test]
async fn rename_after_a_dispatched_failure_is_uncertain_and_keeps_the_intent() {
    let fixture = Fixture::new();
    let record = seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let (result, script) = renamed(&fixture, &record, "Label", vec![reply(500, "{}")]).await;
    let result = result.unwrap();
    assert_eq!(
        (result.outcome, result.persisted),
        (Rename::Uncertain, true)
    );
    assert_eq!(script.count(), 1);
    let stored = load(&fixture.directory.state()).await.unwrap().unwrap();
    assert_eq!(stored.rename_declined.unwrap().outcome, Declined::Uncertain);
    assert_eq!(shown(&stored.executor_id).as_deref(), Some("exec-1"));
    assert_eq!(stored.installation_id, "inst-1");
}

#[tokio::test]
async fn rename_is_unrecorded_without_a_request_when_the_stored_identity_changed() {
    let fixture = Fixture::new();
    let record = seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let text = std::fs::read_to_string(fixture.directory.state()).unwrap();
    std::fs::write(fixture.directory.state(), text.replace("exec-1", "exec-9")).unwrap();
    let (result, script) = renamed(&fixture, &record, "Label", vec![]).await;
    let result = result.unwrap();
    assert_eq!(
        (result.outcome, result.persisted),
        (Rename::Unrecorded, false)
    );
    assert_eq!(script.count(), 0);
}

#[tokio::test]
async fn rename_keeps_at_most_one_hundred_utf16_units_and_rejects_a_blank_label() {
    let fixture = Fixture::new();
    let record = seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let long = "x".repeat(120);
    let (result, script) = renamed(&fixture, &record, &long, vec![reply(500, "{}")]).await;
    result.unwrap();
    assert_eq!(
        units(object(&script.body(0), "custom_display_name")).len(),
        100
    );
    let (blank, script) = renamed(&fixture, &record, "   ", vec![]).await;
    assert!(blank.is_err());
    assert_eq!(script.count(), 0);
}

#[tokio::test]
async fn reconcile_leaves_the_recorded_display_name_alone_without_server_confirmation() {
    let fixture = Fixture::new();
    let record = seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let script = Script::new(vec![reply(
        200,
        r#"{"executor_id":"exec-1","custom_display_name":null}"#,
    )]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let result = reconcile(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        &record,
        &n("Work"),
        &roots(),
        &mut stop,
    )
    .await
    .unwrap();
    assert!(!result.executor_changed);
    assert_eq!(
        shown(&result.record.display_name).as_deref(),
        Some("Stored Host")
    );
    assert_eq!(result.record.custom_display_name, None);
    assert_eq!(
        text(&saved(&fixture.directory.state()), "displayName").as_deref(),
        Some("Stored Host")
    );
    assert_eq!(
        load(&fixture.directory.state()).await.unwrap().unwrap(),
        result.record
    );
}

#[tokio::test]
async fn resolve_reconciles_once_per_run_and_adopts_the_confirmed_replacement_with_a_rename_pending()
 {
    let fixture = Fixture::new();
    seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let script = Script::new(vec![reply(
        200,
        r#"{"executor_id":"exec-2","custom_display_name":"Work"}"#,
    )]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let mut reconciled = false;
    let resolved = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: Some(&n("Work")),
            roots: &roots(),
            installation: &installation(None),
        },
        &mut reconciled,
        &mut stop,
    )
    .await
    .unwrap();
    assert!(reconciled);
    assert_eq!(resolved.executor_id, LosslessString::from("exec-2"));
    assert_eq!(resolved.notes, ["registration-executor-changed"]);
    assert_eq!(
        shown(&resolved.record.custom_display_name).as_deref(),
        Some("Work")
    );
    assert_eq!(
        shown(&resolved.record.display_name).as_deref(),
        Some("Work")
    );
    assert_eq!(resolved.record.rename_declined, None);
    assert_eq!(script.count(), 1);
    assert_eq!(
        text(&script.body(0), "displayName").as_deref(),
        Some("Work")
    );
    assert_eq!(
        text(&script.body(0), "installation_id").as_deref(),
        Some("inst-1")
    );
    assert!(matches!(
        object(&script.body(0), "selected_capability_roots"),
        JsonValue::Array(items) if items.len() == 2
    ));
    assert_eq!(
        object(&script.body(0), "custom_display_name"),
        &JsonValue::Null
    );
    let again = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: Some(&n("Work")),
            roots: &roots(),
            installation: &installation(None),
        },
        &mut reconciled,
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(again.executor_id, LosslessString::from("exec-2"));
    assert_eq!(script.count(), 1);
}

#[tokio::test]
async fn resolve_reconcile_without_confirmation_keeps_the_stored_label_so_the_rename_still_fires() {
    let fixture = Fixture::new();
    seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let script = Script::new(vec![reply(
        200,
        r#"{"executor_id":"exec-1","custom_display_name":null}"#,
    )]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let resolved = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: Some(&n("Work")),
            roots: &roots(),
            installation: &installation(None),
        },
        &mut false,
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(resolved.executor_id, LosslessString::from("exec-1"));
    assert!(resolved.notes.is_empty());
    assert_eq!(
        shown(&resolved.record.display_name).as_deref(),
        Some("Stored Host")
    );
    assert_eq!(resolved.record.custom_display_name, None);
    assert_eq!(script.count(), 1);
    assert_eq!(
        text(&script.body(0), "displayName").as_deref(),
        Some("Work")
    );
}

#[tokio::test]
async fn a_declined_label_does_not_block_reconcile_and_adoption_supersedes_the_decline() {
    let fixture = Fixture::new();
    let record = seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let (declined, _) = renamed(
        &fixture,
        &record,
        "Old Mac",
        vec![reply(
            200,
            r#"{"executor_id":"exec-1","custom_display_name":null}"#,
        )],
    )
    .await;
    assert_eq!(declined.unwrap().outcome, Rename::Unconfirmed);
    let stored = load(&fixture.directory.state()).await.unwrap().unwrap();
    assert_eq!(stored.rename_declined.as_ref().unwrap().label, n("Old Mac"));
    let script = Script::new(vec![reply(
        200,
        r#"{"executor_id":"exec-2","custom_display_name":"Work"}"#,
    )]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let resolved = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: Some(&n("Work")),
            roots: &roots(),
            installation: &installation(None),
        },
        &mut false,
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(resolved.executor_id, LosslessString::from("exec-2"));
    assert_eq!(resolved.record.rename_declined, None);
    assert_eq!(
        load(&fixture.directory.state())
            .await
            .unwrap()
            .unwrap()
            .rename_declined,
        None
    );
    assert_eq!(script.count(), 1);
}

#[tokio::test]
async fn a_failed_reconcile_keeps_the_stored_executor_and_record() {
    let fixture = Fixture::new();
    seed(&fixture, "exec-1", "synthetic-account", &roots()).await;
    let before = std::fs::read_to_string(fixture.directory.state()).unwrap();
    let script = Script::new(vec![reply(403, "{}")]);
    let post = script.post();
    let (_stop, mut stop) = cancel();
    let resolved = resolve(
        &context(&fixture.directory.state(), &post, &fixture.clock, None),
        &credential("synthetic-access", "synthetic-account"),
        super::executor::EnrollmentInput {
            hostname: "synthetic-host",
            configured_name: None,
            roots: &roots(),
            installation: &installation(None),
        },
        &mut false,
        &mut stop,
    )
    .await
    .unwrap();
    assert_eq!(resolved.executor_id, LosslessString::from("exec-1"));
    assert_eq!(resolved.notes, ["registration-update-failed"]);
    assert_eq!(
        std::fs::read_to_string(fixture.directory.state()).unwrap(),
        before
    );
    assert_eq!(script.count(), 1);
}
