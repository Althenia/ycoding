use serde_json::json;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use ycoding_core::platform::{
    browser::{
        admission::Admission,
        isolated::{
            ActionOutput, Availability, Executor, ExecutorError, Launch, Options, Phase, Runtime,
            Service, Snapshot,
        },
    },
    computer::Future,
};
use ycoding_schema::{DomainDecode, browser, isolated_browser, parse_json, session_id::SessionId};
struct Native {
    actions: AtomicUsize,
    closes: AtomicUsize,
    phase: Mutex<Option<Phase>>,
    closed: tokio::sync::watch::Sender<bool>,
    held_observation: Mutex<Option<Arc<tokio::sync::Notify>>>,
    held_action: std::sync::atomic::AtomicBool,
    started: tokio::sync::Notify,
    element_count: AtomicUsize,
    observed_closed: tokio::sync::Notify,
}
fn decode<T: DomainDecode>(v: serde_json::Value) -> T {
    T::decode(&parse_json(&v.to_string()).unwrap()).unwrap()
}
fn snapshot() -> Snapshot {
    Snapshot {
        title: "Fixture".into(),
        url: "https://example.test/form?secret=not-projected".into(),
        document_generation: decode(json!(1)),
        revision: decode(json!(1)),
        elements: vec![decode(json!({"ref":"b1","role":"button","name":"Submit"}))],
        truncated: false,
    }
}
impl Runtime for Native {
    fn observe(&self) -> Future<'_, Result<Snapshot, ExecutorError>> {
        Box::pin(async move {
            let held = self.held_observation.lock().unwrap().clone();
            if let Some(held) = held {
                self.started.notify_one();
                held.notified().await;
            }
            let mut snapshot = snapshot();
            snapshot.elements=(1..=self.element_count.load(Ordering::Relaxed)).map(|index|decode(json!({"ref":format!("b{index}"),"role":"button","name":format!("Item {index}")}))).collect();
            Ok(snapshot)
        })
    }
    fn action<'a>(
        &'a self,
        _action: browser::Action,
        _origins: Vec<String>,
        _cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Future<'a, Result<ActionOutput, ExecutorError>> {
        Box::pin(async move {
            self.actions.fetch_add(1, Ordering::Relaxed);
            if self.held_action.load(Ordering::Relaxed) {
                self.started.notify_one();
                return std::future::pending().await;
            }
            if let Some(phase) = *self.phase.lock().unwrap() {
                return Err(ExecutorError {
                    message: "Injected failure".into(),
                    phase,
                });
            }
            let mut snapshot = snapshot();
            snapshot.revision = decode(json!(0));
            Ok(ActionOutput {
                snapshot,
                capture: None,
                rejected: None,
            })
        })
    }
    fn pause(&self) -> Future<'_, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn resume(&self) -> Future<'_, Result<(), ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn close(&self) -> Future<'_, Result<(), ExecutorError>> {
        Box::pin(async move {
            self.closes.fetch_add(1, Ordering::Relaxed);
            self.closed.send_replace(true);
            Ok(())
        })
    }
    fn closed(&self) -> Future<'_, ()> {
        Box::pin(async move {
            let mut closed = self.closed.subscribe();
            let _ = closed.wait_for(|v| *v).await;
            self.observed_closed.notify_one();
        })
    }
}
struct Factory(Arc<Native>);
impl Executor for Factory {
    fn availability(&self) -> Future<'_, Availability> {
        Box::pin(async {
            Availability {
                available: true,
                reason: None,
            }
        })
    }
    fn launch(
        &self,
        _input: Launch,
        _cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Future<'_, Result<Arc<dyn Runtime>, ExecutorError>> {
        Box::pin(async move { Ok(self.0.clone() as Arc<dyn Runtime>) })
    }
}
struct DelayedFactory {
    native: Arc<Native>,
    entered: tokio::sync::Notify,
    released: tokio::sync::Notify,
    available: bool,
    launches: AtomicUsize,
}
impl Executor for DelayedFactory {
    fn availability(&self) -> Future<'_, Availability> {
        Box::pin(async move {
            Availability {
                available: self.available,
                reason: (!self.available).then(|| "Missing Chrome fixture".into()),
            }
        })
    }
    fn launch(
        &self,
        _input: Launch,
        _cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Future<'_, Result<Arc<dyn Runtime>, ExecutorError>> {
        Box::pin(async move {
            self.launches.fetch_add(1, Ordering::Relaxed);
            self.entered.notify_one();
            self.released.notified().await;
            Ok(self.native.clone() as Arc<dyn Runtime>)
        })
    }
}
fn setup(limit: usize) -> (Arc<Service>, Arc<Native>) {
    let native = Arc::new(Native {
        actions: AtomicUsize::new(0),
        closes: AtomicUsize::new(0),
        phase: Mutex::new(None),
        closed: tokio::sync::watch::channel(false).0,
        held_observation: Mutex::new(None),
        held_action: std::sync::atomic::AtomicBool::new(false),
        started: tokio::sync::Notify::new(),
        element_count: AtomicUsize::new(1),
        observed_closed: tokio::sync::Notify::new(),
    });
    (
        Service::new(
            Arc::new(Factory(native.clone())),
            Arc::new(Admission::default()),
            Arc::new(|_| true),
            Options {
                operation_timeout: Duration::from_secs(1),
                settlement_limit: limit,
            },
        ),
        native,
    )
}
fn session() -> SessionId {
    SessionId::new("ses_owner").unwrap()
}
fn click(status: &isolated_browser::Status, call: &str) -> isolated_browser::ActionInput {
    let tab = status.tab.as_ref().unwrap();
    isolated_browser::ActionInput {
        session_id: session(),
        instance_id: status.instance_id.clone().unwrap(),
        tab_id: tab.id.clone(),
        generation: tab.generation,
        document_generation: tab.document_generation,
        observation_revision: tab.observation_revision,
        call_id: decode(json!(call)),
        action: browser::Action::decode(
            &parse_json("{\"type\":\"click\",\"ref\":\"b1\"}").unwrap(),
        )
        .unwrap(),
    }
}
#[tokio::test]
async fn start_fences_actions_retains_replay_identity_and_requires_stop_before_restart() {
    let (service, native) = setup(1);
    let status = service
        .start(
            &session(),
            decode(json!({"url":"https://example.test/form"})),
        )
        .await
        .unwrap();
    assert_eq!(status.state, isolated_browser::State::Ready);
    assert!(
        service
            .start(&session(), decode(json!({"url":"https://example.test/"})))
            .await
            .is_err()
    );
    let action = click(&status, "click");
    let result = service.action(action.clone()).await.unwrap();
    assert_eq!(result.status, isolated_browser::ActionStatus::Completed);
    assert_eq!(service.action(action.clone()).await.unwrap(), result);
    let mut conflict = action.clone();
    conflict.action = decode(json!({"type":"scroll","deltaY":120}));
    assert!(service.action(conflict).await.is_err());
    assert!(service.action(click(&status, "next")).await.is_err());
    assert_eq!(native.actions.load(Ordering::Relaxed), 1);
    assert_eq!(
        service.list(&session()).unwrap()[0].page.path.as_str(),
        Some("/form")
    );
    service.stop(&session()).await.unwrap();
    assert!(service.action(action).await.is_err());
    service.shutdown().await.unwrap();
}
#[tokio::test]
async fn postdispatch_failure_is_uncertain_closed_once_and_exact_retry_does_not_replay() {
    for phase in [Phase::Predispatch, Phase::Postdispatch] {
        let (service, native) = setup(256);
        *native.phase.lock().unwrap() = Some(phase);
        let status = service
            .start(
                &session(),
                decode(json!({"url":"https://example.test/form"})),
            )
            .await
            .unwrap();
        let input = click(&status, "failure");
        let result = service.action(input.clone()).await.unwrap();
        assert_eq!(
            result.status,
            if phase == Phase::Postdispatch {
                isolated_browser::ActionStatus::Uncertain
            } else {
                isolated_browser::ActionStatus::Rejected
            }
        );
        assert_eq!(service.action(input).await.unwrap(), result);
        assert_eq!(native.actions.load(Ordering::Relaxed), 1);
        if phase == Phase::Postdispatch {
            assert_eq!(native.closes.load(Ordering::Relaxed), 1);
        }
        service.shutdown().await.unwrap();
        assert_eq!(native.closes.load(Ordering::Relaxed), 1);
    }
}

#[tokio::test]
async fn stopping_during_startup_observation_never_publishes_ready_or_retains_admission() {
    let (service, native) = setup(256);
    let held = Arc::new(tokio::sync::Notify::new());
    *native.held_observation.lock().unwrap() = Some(held.clone());
    let starting = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .start(&session(), decode(json!({"url":"https://example.test/"})))
                .await
        }
    });
    native.started.notified().await;
    service.stop(&session()).await.unwrap();
    held.notify_one();
    assert!(starting.await.unwrap().is_err());
    assert!(service.list(&session()).unwrap().is_empty());
    assert_eq!(native.closes.load(Ordering::Relaxed), 1);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn stop_and_caller_cancellation_settle_once_and_prevent_late_replay() {
    for abort in [false, true] {
        let (service, native) = setup(256);
        native.held_action.store(true, Ordering::Relaxed);
        let status = service
            .start(
                &session(),
                decode(json!({"url":"https://example.test/form"})),
            )
            .await
            .unwrap();
        let input = click(&status, "pending");
        let running = tokio::spawn({
            let service = service.clone();
            let input = input.clone();
            async move { service.action(input).await }
        });
        native.started.notified().await;
        if abort {
            running.abort();
            assert!(running.await.unwrap_err().is_cancelled());
            let result = service.action(input).await.unwrap();
            assert_eq!(result.status, isolated_browser::ActionStatus::Uncertain);
        } else {
            service.stop(&session()).await.unwrap();
            assert_eq!(
                running.await.unwrap().unwrap().status,
                isolated_browser::ActionStatus::Uncertain
            );
        }
        service.shutdown().await.unwrap();
        assert_eq!(native.actions.load(Ordering::Relaxed), 1);
        assert_eq!(native.closes.load(Ordering::Relaxed), 1);
    }
}

#[tokio::test]
async fn foreign_instance_and_every_numeric_fence_fail_before_executor_dispatch() {
    let (service, native) = setup(256);
    let status = service
        .start(
            &session(),
            decode(json!({"url":"https://example.test/form"})),
        )
        .await
        .unwrap();
    for field in [
        "instanceID",
        "tabID",
        "generation",
        "documentGeneration",
        "observationRevision",
    ] {
        use ycoding_schema::DomainEncode;
        let mut value: serde_json::Value = serde_json::from_str(&ycoding_schema::stringify_json(
            &click(&status, field).encode(),
        ))
        .unwrap();
        value[field] = match field {
            "instanceID" => json!("ibrowser_foreign"),
            "tabID" => json!("btab_foreign"),
            _ => json!(2),
        };
        assert!(service.action(decode(value)).await.is_err());
    }
    assert_eq!(native.actions.load(Ordering::Relaxed), 0);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn observations_preserve_the_executor_semantic_element_order() {
    let (service, native) = setup(256);
    native
        .element_count
        .store(browser::MAX_OBSERVATION_ELEMENTS, Ordering::Relaxed);
    let status = service
        .start(
            &session(),
            decode(json!({"url":"https://example.test/form"})),
        )
        .await
        .unwrap();
    let tab = status.tab.unwrap();
    let observation = service
        .observe(isolated_browser::ObserveInput {
            session_id: session(),
            instance_id: status.instance_id.unwrap(),
            tab_id: tab.id,
            generation: tab.generation,
            call_id: decode(json!("observe")),
        })
        .await
        .unwrap();
    assert_eq!(
        observation
            .elements
            .iter()
            .map(|element| element.r#ref.as_str().unwrap())
            .collect::<Vec<_>>(),
        (1..=browser::MAX_OBSERVATION_ELEMENTS)
            .map(|index| format!("b{index}"))
            .collect::<Vec<_>>()
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn spontaneous_runtime_close_settles_pending_work_and_invalidates_control() {
    let (service, native) = setup(256);
    native.held_action.store(true, Ordering::Relaxed);
    let status = service
        .start(
            &session(),
            decode(json!({"url":"https://example.test/form"})),
        )
        .await
        .unwrap();
    let input = click(&status, "disconnected");
    let running = tokio::spawn({
        let service = service.clone();
        async move { service.action(input).await }
    });
    native.started.notified().await;
    native.closed.send_replace(true);
    native.observed_closed.notified().await;
    assert_eq!(
        running.await.unwrap().unwrap().status,
        isolated_browser::ActionStatus::Uncertain
    );
    assert_eq!(
        service.status(&session()).await.unwrap().state,
        isolated_browser::State::Unavailable
    );
    assert!(service.action(click(&status, "another")).await.is_err());
    service.shutdown().await.unwrap();
    assert_eq!(native.closes.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn a_late_launch_is_closed_after_stop_and_unavailability_never_launches() {
    for available in [false, true] {
        let (_, native) = setup(256);
        let factory = Arc::new(DelayedFactory {
            native: native.clone(),
            entered: tokio::sync::Notify::new(),
            released: tokio::sync::Notify::new(),
            available,
            launches: AtomicUsize::new(0),
        });
        let admission = Arc::new(Admission::default());
        let service = Service::new(
            factory.clone(),
            admission.clone(),
            Arc::new(|_| true),
            Options::default(),
        );
        if !available {
            assert!(
                service
                    .start(&session(), decode(json!({"url":"https://example.test/"})))
                    .await
                    .is_err()
            );
            assert_eq!(factory.launches.load(Ordering::Relaxed), 0);
            assert_eq!(admission.current("ses_owner"), None);
            service.shutdown().await.unwrap();
            continue;
        }
        let starting = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .start(&session(), decode(json!({"url":"https://example.test/"})))
                    .await
            }
        });
        factory.entered.notified().await;
        service.stop(&session()).await.unwrap();
        assert_eq!(admission.current("ses_owner"), None);
        factory.released.notify_one();
        assert!(starting.await.unwrap().is_err());
        service.shutdown().await.unwrap();
        assert_eq!(native.closes.load(Ordering::Relaxed), 1);
        assert!(service.list(&session()).is_err());
    }
}

#[tokio::test]
async fn cancellation_before_the_owned_worker_is_polled_never_dispatches_to_the_executor() {
    use std::future::Future;
    let (service, native) = setup(256);
    let status = service
        .start(
            &session(),
            decode(json!({"url":"https://example.test/form"})),
        )
        .await
        .unwrap();
    let mut action = Box::pin(service.action(click(&status, "cancel-before-dispatch")));
    std::future::poll_fn(|cx| {
        assert!(action.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    drop(action);
    service.shutdown().await.unwrap();
    assert_eq!(native.actions.load(Ordering::Relaxed), 0);
    assert_eq!(native.closes.load(Ordering::Relaxed), 1);
}
