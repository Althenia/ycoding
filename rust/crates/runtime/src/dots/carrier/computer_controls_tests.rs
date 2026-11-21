use super::test_support::HostFixture;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_core::{
    dots::{
        access::{
            ComputerAttach, ComputerDetach, ComputerProblem, ComputerRemove, ComputerState,
            ComputerStatus, ComputerTarget, Readiness,
        },
        computer::{self, Base, Control, Dispatch, Method, Request, Response},
    },
    session::prompt_cache::sha256,
    ycoding_schema::{JsonValue, parse_json},
};

const DOT: &str = "dot-synthetic";
const THREAD: &str = "thread-synthetic";
const EXECUTOR: &str = "executor-synthetic";

#[derive(Clone, Debug)]
struct Seen {
    method: Method,
    base: Base,
    path: String,
    query: Vec<(String, String)>,
}

struct Change {
    status: Option<u16>,
    effect: bool,
}

struct Fake {
    seen: Mutex<Vec<Seen>>,
    listed: Mutex<bool>,
    list_status: Mutex<u16>,
    attached: Mutex<bool>,
    can_disconnect: Mutex<Option<bool>>,
    can_delete: Mutex<Option<bool>>,
    usable: Mutex<Option<String>>,
    readiness: Mutex<Option<(u16, String)>>,
    environment: Mutex<Option<(u16, String)>>,
    changes: Mutex<VecDeque<Change>>,
}

impl Fake {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            listed: Mutex::new(true),
            list_status: Mutex::new(200),
            attached: Mutex::new(true),
            can_disconnect: Mutex::new(Some(true)),
            can_delete: Mutex::new(Some(true)),
            usable: Mutex::new(None),
            readiness: Mutex::new(None),
            environment: Mutex::new(None),
            changes: Mutex::new(VecDeque::new()),
        })
    }

    fn dispatch(self: &Arc<Self>) -> Dispatch {
        let this = self.clone();
        Arc::new(move |request| {
            let this = this.clone();
            Box::pin(async move { Ok(this.respond(request).await) })
        })
    }

    fn requests(&self, method: Method) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.method == method)
            .cloned()
            .collect()
    }

    fn queue(&self, status: Option<u16>, effect: bool) {
        self.changes
            .lock()
            .unwrap()
            .push_back(Change { status, effect });
    }

    async fn respond(&self, request: Request) -> Response {
        self.seen.lock().unwrap().push(Seen {
            method: request.method,
            base: request.base,
            path: request.path.clone(),
            query: request.query.clone(),
        });
        let json = |body: String| Response { status: 200, body };
        let empty = |status| Response {
            status,
            body: String::new(),
        };
        let disconnect = format!("/tbo/{DOT}/computers/{EXECUTOR}/disconnect");
        let delete = format!("/computers/{EXECUTOR}");
        match (request.method, request.path.as_str()) {
            (Method::Get, "/tbo") => json(format!(
                r#"{{"items":[{{"id":"{DOT}","status":"active"}}],"cursor":null}}"#
            )),
            (Method::Get, path) if path == format!("/tbo/{DOT}/root-thread") => {
                json(format!(r#"{{"root_thread_id":"{THREAD}"}}"#))
            }
            (Method::Get, path) if path == format!("/tbo/{DOT}/computers") => {
                let status = *self.list_status.lock().unwrap();
                if status != 200 {
                    return empty(status);
                }
                let mut fields = vec![
                    format!(r#""environment_id":"{EXECUTOR}""#),
                    r#""display_name":"Synthetic Mac""#.to_owned(),
                    format!(r#""is_attached":{}"#, *self.attached.lock().unwrap()),
                    r#""can_connect":true"#.to_owned(),
                ];
                if let Some(value) = *self.can_disconnect.lock().unwrap() {
                    fields.push(format!(r#""can_disconnect":{value}"#));
                }
                if let Some(value) = *self.can_delete.lock().unwrap() {
                    fields.push(format!(r#""can_delete":{value}"#));
                }
                if let Some(value) = self.usable.lock().unwrap().clone() {
                    fields.push(format!(r#""can_use_for_tasks":{value}"#));
                }
                let rows = if *self.listed.lock().unwrap() {
                    format!(
                        r#"[{{"environment_id":"other-executor","is_attached":true,"can_connect":true,"can_disconnect":true,"can_delete":true}},{{{}}}]"#,
                        fields.join(",")
                    )
                } else {
                    "[]".to_owned()
                };
                json(format!(
                    r#"{{"thread_id":"{THREAD}","computers":{rows},"local_computer_access_disabled_by_admin":false}}"#
                ))
            }
            (Method::Get, path) if path == format!("/cloud/environment/{EXECUTOR}/status") => {
                match self.readiness.lock().unwrap().clone() {
                    Some((status, body)) => Response { status, body },
                    None => empty(404),
                }
            }
            (Method::Get, path) if path == format!("/tbo/{DOT}/environment/status") => {
                match self.environment.lock().unwrap().clone() {
                    Some((status, body)) => Response { status, body },
                    None => empty(404),
                }
            }
            (Method::Post, path) if path == disconnect => {
                self.change(|fake| *fake.attached.lock().unwrap() = false)
            }
            (Method::Delete, path) if path == delete => {
                self.change(|fake| *fake.listed.lock().unwrap() = false)
            }
            _ => empty(404),
        }
    }

    fn change(&self, apply: impl Fn(&Fake)) -> Response {
        let change = self.changes.lock().unwrap().pop_front();
        let Some(change) = change else {
            apply(self);
            return Response {
                status: 204,
                body: String::new(),
            };
        };
        if change.effect {
            apply(self);
        }
        match change.status {
            Some(status) => Response {
                status,
                body: String::new(),
            },
            None => Response {
                status: 0,
                body: String::new(),
            },
        }
    }
}

fn write_executor(fixture: &HostFixture) {
    std::fs::write(
        fixture.state_path().with_file_name("cca-executor.json"),
        format!(
            r#"{{"installationID":"installation-synthetic","status":"completed","accountHash":"{}","executorID":"{EXECUTOR}","createdAt":"1","updatedAt":"1"}}"#,
            sha256("synthetic-account")
        ),
    )
    .unwrap();
}

fn stored(fixture: &HostFixture) -> String {
    std::fs::read_to_string(fixture.state_path().with_file_name("cca-executor.json")).unwrap()
}

fn control(fixture: &HostFixture, fake: &Arc<Fake>) -> Control {
    let dispatch = fake.dispatch();
    let failing: Dispatch = Arc::new(move |request| {
        let dispatch = dispatch.clone();
        Box::pin(async move {
            let response = dispatch(request).await?;
            if response.status == 0 {
                Err(ycoding_core::dots::access::Error::Unavailable)
            } else {
                Ok(response)
            }
        })
    });
    Control::new(computer::Settings {
        host: fixture.host.clone(),
        state_path: fixture.state_path().with_file_name("cca-executor.json"),
        dispatch: failing,
        now: Arc::new(|| 0),
        observe: Duration::from_secs(5),
        connect: Duration::from_secs(5),
        supplement: Duration::from_secs(5),
        diagnostic: Arc::new(|_| {}),
    })
}

async fn arrange() -> (HostFixture, Arc<Fake>, Control) {
    let fixture = HostFixture::new().await;
    write_executor(&fixture);
    let fake = Fake::new();
    let control = control(&fixture, &fake);
    (fixture, fake, control)
}

fn detach(expected_target: Option<ComputerTarget>) -> ComputerDetach {
    ComputerDetach { expected_target }
}

fn remove(expected_target: Option<ComputerTarget>) -> ComputerRemove {
    ComputerRemove { expected_target }
}

fn receipt(status: &ComputerStatus) -> ComputerTarget {
    status.target.clone().expect("observed target")
}

fn unavailable(problem: ComputerProblem) -> (ComputerState, Option<ComputerProblem>) {
    (ComputerState::Unavailable, Some(problem))
}

fn outcome(status: &ComputerStatus) -> (ComputerState, Option<ComputerProblem>) {
    (status.state, status.problem)
}

const READY: &str = r#"{"environment_id":"executor-synthetic","status":"connected"}"#;
const ENVIRONMENT: &str = r#"{"environmentId":"env_cloud_1","status":"offline","capabilities":[{"type":"remote_desktop","status":"ready"}]}"#;

#[tokio::test]
async fn status_reads_cloud_readiness_task_usability_and_the_dot_environment_for_the_listed_row() {
    let (_fixture, fake, control) = arrange().await;
    *fake.usable.lock().unwrap() = Some("true".into());
    *fake.readiness.lock().unwrap() = Some((200, READY.into()));
    *fake.environment.lock().unwrap() = Some((200, ENVIRONMENT.into()));
    let status = control.computer().await;
    assert_eq!(status.state, ComputerState::Attached);
    assert_eq!(status.problem, None);
    assert_eq!(status.readiness, Some(Readiness::Connected));
    assert_eq!(status.usable_for_tasks, Some(true));
    let environment = status.dot_environment.clone().unwrap();
    assert_eq!(environment.status, "offline");
    assert_eq!(
        environment.capabilities,
        vec![("remote_desktop".to_owned(), "ready".to_owned())]
    );
    let gets = fake.requests(Method::Get);
    let readiness = gets
        .iter()
        .find(|seen| seen.path == format!("/cloud/environment/{EXECUTOR}/status"))
        .unwrap();
    assert_eq!(readiness.base, Base::Registry);
    assert!(readiness.query.is_empty());
    let supplement = gets
        .iter()
        .find(|seen| seen.path == format!("/tbo/{DOT}/environment/status"))
        .unwrap();
    assert_eq!(supplement.base, Base::Backend);
    assert_eq!(
        supplement.query,
        vec![("thread_id".to_owned(), THREAD.to_owned())]
    );
    assert_eq!(gets.len(), 5);
}

#[tokio::test]
async fn status_reports_false_task_usability_an_offline_readiness_and_an_empty_environment() {
    let (_fixture, fake, control) = arrange().await;
    *fake.attached.lock().unwrap() = false;
    *fake.usable.lock().unwrap() = Some("false".into());
    *fake.readiness.lock().unwrap() = Some((
        200,
        r#"{"environment_id":"executor-synthetic","status":"offline"}"#.into(),
    ));
    *fake.environment.lock().unwrap() = Some((
        200,
        r#"{"environmentId":null,"status":"unknown","capabilities":[]}"#.into(),
    ));
    let status = control.computer().await;
    assert_eq!(status.state, ComputerState::Detached);
    assert_eq!(status.readiness, Some(Readiness::Offline));
    assert_eq!(status.usable_for_tasks, Some(false));
    let environment = status.dot_environment.unwrap();
    assert_eq!(environment.status, "unknown");
    assert!(environment.capabilities.is_empty());
}

#[tokio::test]
async fn readiness_is_omitted_unless_the_response_names_this_executor_with_a_known_status() {
    for reply in [
        Some((200, r#"{"environment_id":"other","status":"connected"}"#)),
        Some((
            200,
            r#"{"environment_id":"executor-synthetic","status":"ready"}"#,
        )),
        Some((200, r#"{"status":"connected"}"#)),
        Some((200, r#"{"environment_id":"executor-synthetic"}"#)),
        Some((200, "[]")),
        Some((200, "not json")),
        Some((500, "{}")),
        Some((401, "{}")),
        None,
    ] {
        let (_fixture, fake, control) = arrange().await;
        *fake.readiness.lock().unwrap() = reply.map(|(status, body)| (status, body.to_owned()));
        let status = control.computer().await;
        assert_eq!(status.state, ComputerState::Attached, "{reply:?}");
        assert_eq!(status.readiness, None, "{reply:?}");
    }
}

#[tokio::test]
async fn task_usability_is_omitted_unless_can_use_for_tasks_is_a_boolean() {
    for value in [r#""true""#, "1", "null"] {
        let (_fixture, fake, control) = arrange().await;
        *fake.usable.lock().unwrap() = Some(value.into());
        assert_eq!(control.computer().await.usable_for_tasks, None, "{value}");
    }
}

#[tokio::test]
async fn the_dot_environment_is_omitted_unless_it_decodes_strictly() {
    let too_many = format!(
        r#"{{"environmentId":"e","status":"offline","capabilities":[{}]}}"#,
        vec![r#"{"type":"a","status":"ready"}"#; 17].join(",")
    );
    for body in [
        r#"{"environmentId":"e","status":1,"capabilities":[]}"#,
        r#"{"environmentId":"e","status":"Off Line","capabilities":[]}"#,
        r#"{"environmentId":7,"status":"offline","capabilities":[]}"#,
        r#"{"environmentId":null,"status":"offline"}"#,
        r#"{"environmentId":"e","status":"offline","capabilities":"none"}"#,
        r#"{"environmentId":"e","status":"offline","capabilities":[{"type":"remote_desktop"}]}"#,
        r#"{"environmentId":"e","status":"offline","capabilities":[{"type":"","status":"ready"}]}"#,
        r#"{"environmentId":"e","status":"offline","capabilities":[null]}"#,
        too_many.as_str(),
        "not json",
    ] {
        let (_fixture, fake, control) = arrange().await;
        *fake.environment.lock().unwrap() = Some((200, body.to_owned()));
        assert_eq!(control.computer().await.dot_environment, None, "{body}");
    }
    let (_fixture, fake, control) = arrange().await;
    *fake.environment.lock().unwrap() = Some((404, "{}".into()));
    assert_eq!(control.computer().await.dot_environment, None);
}

#[tokio::test]
async fn supplementary_status_is_not_read_for_an_unlisted_executor_or_a_failed_list() {
    for (listed, list_status) in [(false, 200), (true, 503)] {
        let (_fixture, fake, control) = arrange().await;
        *fake.listed.lock().unwrap() = listed;
        *fake.list_status.lock().unwrap() = list_status;
        *fake.readiness.lock().unwrap() = Some((200, READY.into()));
        *fake.environment.lock().unwrap() = Some((200, ENVIRONMENT.into()));
        assert_eq!(control.computer().await.state, ComputerState::Unavailable);
        assert!(fake.requests(Method::Get).iter().all(|seen| {
            !seen.path.contains("/cloud/environment/") && !seen.path.contains("/environment/status")
        }));
    }
}

#[tokio::test]
async fn detach_posts_disconnect_once_with_the_thread_query_and_returns_the_re_read_state() {
    let (_fixture, fake, control) = arrange().await;
    let status = control.detach(detach(None)).await;
    assert_eq!(status.state, ComputerState::Detached);
    assert_eq!(status.problem, None);
    let posts = fake.requests(Method::Post);
    assert_eq!(posts.len(), 1);
    assert_eq!(
        posts[0].path,
        format!("/tbo/{DOT}/computers/{EXECUTOR}/disconnect")
    );
    assert_eq!(
        posts[0].query,
        vec![("expected_thread_id".to_owned(), THREAD.to_owned())]
    );
    assert_eq!(posts[0].base, Base::Backend);
    assert_eq!(control.computer().await.state, ComputerState::Detached);
    assert_eq!(fake.requests(Method::Post).len(), 1);
}

#[tokio::test]
async fn an_attached_computer_that_cannot_be_disconnected_is_reported_without_posting() {
    for can_disconnect in [Some(false), None] {
        let (_fixture, fake, control) = arrange().await;
        *fake.can_disconnect.lock().unwrap() = can_disconnect;
        assert_eq!(
            outcome(&control.computer().await),
            (
                ComputerState::Attached,
                Some(ComputerProblem::NotDisconnectable)
            )
        );
        assert_eq!(
            outcome(&control.detach(detach(None)).await),
            (
                ComputerState::Attached,
                Some(ComputerProblem::NotDisconnectable)
            )
        );
        assert!(fake.requests(Method::Post).is_empty());
    }
}

#[tokio::test]
async fn detach_does_not_post_when_already_detached_unlisted_or_unreadable() {
    for (attached, listed, list_status, expected) in [
        (false, true, 200, (ComputerState::Detached, None)),
        (true, false, 200, unavailable(ComputerProblem::NotListed)),
        (true, true, 503, unavailable(ComputerProblem::Connection)),
    ] {
        let (_fixture, fake, control) = arrange().await;
        *fake.attached.lock().unwrap() = attached;
        *fake.listed.lock().unwrap() = listed;
        *fake.list_status.lock().unwrap() = list_status;
        assert_eq!(outcome(&control.detach(detach(None)).await), expected);
        assert!(fake.requests(Method::Post).is_empty());
    }
}

#[tokio::test]
async fn a_stale_target_receipt_reports_target_changed_without_posting_and_the_exact_receipt_is_accepted()
 {
    let (_fixture, fake, control) = arrange().await;
    let observed = receipt(&control.computer().await);
    let stale = ComputerTarget {
        revision: "b".repeat(64),
        ..observed.clone()
    };
    assert_eq!(
        outcome(&control.detach(detach(Some(stale))).await),
        unavailable(ComputerProblem::TargetChanged)
    );
    assert!(fake.requests(Method::Post).is_empty());
    assert_eq!(
        control.detach(detach(Some(observed))).await.state,
        ComputerState::Detached
    );
    assert_eq!(fake.requests(Method::Post).len(), 1);
}

#[tokio::test]
async fn a_refused_detach_is_not_retried_and_reports_the_re_read_state() {
    let (_fixture, fake, control) = arrange().await;
    fake.queue(Some(409), false);
    assert_eq!(
        outcome(&control.detach(detach(None)).await),
        (ComputerState::Attached, Some(ComputerProblem::Rejected))
    );
    assert_eq!(fake.requests(Method::Post).len(), 1);
}

#[tokio::test]
async fn only_the_re_read_is_trusted_after_an_uncertain_or_unconfirmed_detach() {
    for reply in [None, Some(500), Some(408), Some(429), Some(204)] {
        let (_fixture, fake, control) = arrange().await;
        fake.queue(reply, false);
        assert_eq!(
            outcome(&control.detach(detach(None)).await),
            (ComputerState::Attached, Some(ComputerProblem::Unconfirmed)),
            "{reply:?}"
        );
        assert_eq!(fake.requests(Method::Post).len(), 1);
    }
    let (_fixture, fake, control) = arrange().await;
    fake.queue(None, true);
    assert_eq!(
        control.detach(detach(None)).await.state,
        ComputerState::Detached
    );
}

#[tokio::test]
async fn concurrent_detaches_share_one_post_and_attach_never_shares_with_detach() {
    let (_fixture, fake, control) = arrange().await;
    let (first, second) = tokio::join!(control.detach(detach(None)), control.detach(detach(None)));
    assert_eq!(first.state, ComputerState::Detached);
    assert_eq!(second, first);
    assert_eq!(fake.requests(Method::Post).len(), 1);

    let (_fixture, fake, control) = arrange().await;
    let (attached, detached) = tokio::join!(
        control.attach(ComputerAttach {
            replace_others: false,
            expected_target: None,
        }),
        control.detach(detach(None))
    );
    assert_eq!(attached.state, ComputerState::Attached);
    assert_eq!(detached.state, ComputerState::Detached);
    let posts = fake.requests(Method::Post);
    assert_eq!(posts.len(), 1);
    assert!(posts[0].path.ends_with("/disconnect"));
}

#[tokio::test]
async fn remove_deletes_only_this_executor_once_and_marks_the_enrollment_removed_after_the_row_disappears()
 {
    let (fixture, fake, control) = arrange().await;
    let status = control.remove(remove(None)).await;
    assert_eq!(status.state, ComputerState::Removed);
    assert_eq!(status.problem, None);
    assert_eq!(status.target, None);
    let deletes = fake.requests(Method::Delete);
    assert_eq!(deletes.len(), 1);
    assert_eq!(deletes[0].path, format!("/computers/{EXECUTOR}"));
    assert!(deletes[0].query.is_empty());
    assert_eq!(deletes[0].base, Base::Backend);
    let JsonValue::Object(state) = parse_json(&stored(&fixture)).unwrap() else {
        panic!("state object")
    };
    let field = |name: &str| state.get(&name.into()).cloned();
    let text = |value: &str| Some(JsonValue::String(value.into()));
    assert_eq!(field("status"), text("removed"));
    assert_eq!(field("installationID"), text("installation-synthetic"));
    assert_eq!(field("accountHash"), text(&sha256("synthetic-account")));
    assert_eq!(field("createdAt"), text("1"));
    assert!(matches!(field("updatedAt"), Some(JsonValue::String(_))));
    assert_eq!(field("executorID"), None);
    assert_eq!(
        outcome(&control.computer().await),
        unavailable(ComputerProblem::Enrollment)
    );
}

#[tokio::test]
async fn a_computer_that_cannot_be_deleted_is_reported_without_deleting() {
    for attached in [true, false] {
        for can_delete in [Some(false), None] {
            let (fixture, fake, control) = arrange().await;
            *fake.attached.lock().unwrap() = attached;
            *fake.can_delete.lock().unwrap() = can_delete;
            let status = control.remove(remove(None)).await;
            assert_eq!(
                outcome(&status),
                (
                    if attached {
                        ComputerState::Attached
                    } else {
                        ComputerState::Detached
                    },
                    Some(ComputerProblem::NotDeletable)
                )
            );
            assert!(status.target.is_some());
            assert!(fake.requests(Method::Delete).is_empty());
            assert!(stored(&fixture).contains(r#""status":"completed""#));
        }
    }
}

#[tokio::test]
async fn remove_does_not_delete_when_unlisted_unreadable_or_for_a_stale_target_receipt() {
    for (listed, list_status, expected) in [
        (false, 200, unavailable(ComputerProblem::NotListed)),
        (true, 503, unavailable(ComputerProblem::Connection)),
    ] {
        let (_fixture, fake, control) = arrange().await;
        *fake.listed.lock().unwrap() = listed;
        *fake.list_status.lock().unwrap() = list_status;
        assert_eq!(outcome(&control.remove(remove(None)).await), expected);
        assert!(fake.requests(Method::Delete).is_empty());
    }
    let (_fixture, fake, control) = arrange().await;
    let stale = ComputerTarget {
        revision: "b".repeat(64),
        ..receipt(&control.computer().await)
    };
    assert_eq!(
        outcome(&control.remove(remove(Some(stale))).await),
        unavailable(ComputerProblem::TargetChanged)
    );
    assert!(fake.requests(Method::Delete).is_empty());
}

#[tokio::test]
async fn a_refused_removal_is_not_retried_and_keeps_the_enrollment_when_the_row_is_still_listed() {
    let (fixture, fake, control) = arrange().await;
    fake.queue(Some(409), false);
    assert_eq!(
        outcome(&control.remove(remove(None)).await),
        (ComputerState::Attached, Some(ComputerProblem::Rejected))
    );
    assert_eq!(fake.requests(Method::Delete).len(), 1);
    assert!(stored(&fixture).contains(r#""status":"completed""#));
}

#[tokio::test]
async fn only_the_re_read_is_trusted_after_an_uncertain_or_unconfirmed_removal() {
    for reply in [None, Some(500), Some(408), Some(429), Some(204)] {
        let (fixture, fake, control) = arrange().await;
        fake.queue(reply, false);
        assert_eq!(
            outcome(&control.remove(remove(None)).await),
            (ComputerState::Attached, Some(ComputerProblem::Unconfirmed)),
            "{reply:?}"
        );
        assert_eq!(fake.requests(Method::Delete).len(), 1);
        assert!(stored(&fixture).contains(r#""status":"completed""#));
    }
    let (fixture, fake, control) = arrange().await;
    fake.queue(None, true);
    assert_eq!(
        control.remove(remove(None)).await.state,
        ComputerState::Removed
    );
    assert!(stored(&fixture).contains(r#""status":"removed""#));
}

#[tokio::test]
async fn concurrent_removals_share_one_delete() {
    let (_fixture, fake, control) = arrange().await;
    let (first, second) = tokio::join!(control.remove(remove(None)), control.remove(remove(None)));
    assert_eq!(first.state, ComputerState::Removed);
    assert_eq!(second, first);
    assert_eq!(fake.requests(Method::Delete).len(), 1);
}

#[tokio::test]
async fn detach_and_removal_without_an_enrollment_never_call_chatgpt() {
    let fixture = HostFixture::new().await;
    let fake = Fake::new();
    let control = control(&fixture, &fake);
    assert_eq!(
        outcome(&control.remove(remove(None)).await),
        unavailable(ComputerProblem::Enrollment)
    );
    assert_eq!(
        outcome(&control.detach(detach(None)).await),
        unavailable(ComputerProblem::Enrollment)
    );
    assert!(fake.seen.lock().unwrap().is_empty());
}
