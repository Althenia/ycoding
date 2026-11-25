use super::support::*;
use crate::dots::carrier::executor_rpc::{
    control::{Signal, locked},
    error::{CallError, HandlerError, RpcError, SendFailed},
    handler::*,
    service::{SessionBackend, SessionFactory, SupervisedHandler, environment_info_of, opener},
    types::*,
};
use crate::dots::carrier::{
    Clock,
    supervisor::{DETACHED_TTL_MS, Diagnostics, Sessions},
    test_support::{self, TestClock},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use ycoding_core::ycoding_schema::{JsonValue, stringify_json};

type Notes = Arc<Mutex<Vec<(String, JsonValue)>>>;

struct World {
    registry: Arc<Sessions>,
    clock: TestClock,
    armed: mpsc::UnboundedReceiver<u64>,
    backend: Arc<Backend>,
    closes: Arc<AtomicUsize>,
}

fn world(backend: Arc<Backend>) -> World {
    let (clock, armed) = test_support::clock();
    let shared: Arc<dyn Clock> = Arc::new(clock.clone());
    World {
        registry: Sessions::new(shared, DETACHED_TTL_MS, Diagnostics::new(Arc::new(|_| {}))),
        clock,
        armed,
        backend,
        closes: Arc::new(AtomicUsize::new(0)),
    }
}

impl World {
    fn factory(&self) -> SessionFactory {
        let (backend, closes) = (self.backend.clone(), self.closes.clone());
        Arc::new(move || {
            let closes = closes.clone();
            Ok(SessionBackend {
                handler: backend.clone(),
                environment_info: info_fn(),
                close: Box::new(move || {
                    let future: Boxed<'static, Result<(), ()>> = Box::pin(async move {
                        closes.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    });
                    future
                }),
            })
        })
    }

    fn handler(&self) -> Arc<SupervisedHandler> {
        Arc::new(SupervisedHandler::new(
            self.registry.connect(opener(self.factory())),
        ))
    }

    fn closed(&self) -> usize {
        self.closes.load(Ordering::SeqCst)
    }
}

fn link() -> (InitializeContext, Notes) {
    let notes: Notes = Arc::new(Mutex::new(Vec::new()));
    let sink = notes.clone();
    let notifier = Notifier::new(Arc::new(move |method, params| {
        locked(&sink).push((method, params));
        let future: Boxed<'static, Result<(), SendFailed>> = Box::pin(async { Ok(()) });
        future
    }));
    let caller = Caller::new(Arc::new(|_, _, _| {
        let future: Boxed<'static, Result<JsonValue, CallError>> =
            Box::pin(async { Ok(JsonValue::Null) });
        future
    }));
    (
        InitializeContext {
            signal: Signal::never(),
            notifier,
            caller,
        },
        notes,
    )
}

fn params() -> InitializeParams {
    InitializeParams {
        client_name: Text::from("test"),
    }
}

fn context() -> HandlerContext {
    HandlerContext {
        signal: Signal::never(),
        session_id: SESSION_ID.to_string(),
        authenticated_executor: None,
    }
}

fn exec() -> ExecParams {
    ExecParams {
        process_id: "p1".into(),
        argv: vec!["ls".into()],
        cwd: "file:///w".into(),
        env: Vec::new(),
        tty: false,
        pipe_stdin: false,
        arg0: None,
        metadata: None,
        env_policy: None,
        shell_snapshot: None,
        sandbox: None,
        enforce_managed_network: None,
        managed_network: None,
        network_proxy: None,
    }
}

fn detached() -> HandlerError {
    HandlerError::Rpc(RpcError::new(
        -32600,
        "session is no longer attached to this connection",
    ))
}

async fn attach(world: &World) -> (Arc<SupervisedHandler>, Notes) {
    let handler = world.handler();
    let (ctx, notes) = link();
    assert_eq!(
        handler.initialize(params(), ctx).await.unwrap().session_id,
        SESSION_ID
    );
    (handler, notes)
}

async fn resume(world: &World, id: Text) -> Result<(Arc<SupervisedHandler>, Notes), HandlerError> {
    let handler = world.handler();
    let (ctx, notes) = link();
    handler.resume(id, params(), ctx).await?;
    Ok((handler, notes))
}

fn backend_notifier(world: &World) -> Notifier {
    locked(&world.backend.init_context)
        .clone()
        .expect("backend initialized")
        .notifier
}

#[tokio::test]
async fn an_attached_connection_reaches_the_backend() {
    let world = world(Backend::new());
    let (handler, _) = attach(&world).await;
    assert_eq!(
        handler
            .start_process(exec(), context())
            .await
            .unwrap()
            .process_id,
        Text::from("p1")
    );
    assert_eq!(handler.features(), full_features());
    assert!(environment_info_of(&handler)().await.is_ok());
}

#[tokio::test]
async fn a_resumed_session_sends_its_notifications_to_the_new_connection_only() {
    let world = world(Backend::new());
    let (first, first_notes) = attach(&world).await;
    let notifier = backend_notifier(&world);
    notifier
        .notify("while-attached", JsonValue::Null)
        .await
        .unwrap();
    first.detach();
    notifier
        .notify("while-detached", JsonValue::Null)
        .await
        .unwrap();
    let (second, second_notes) = resume(&world, Text::from(SESSION_ID)).await.unwrap();
    notifier
        .notify("after-resume", JsonValue::Null)
        .await
        .unwrap();
    let names = |notes: &Notes| {
        locked(notes)
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&first_notes), ["while-attached"]);
    assert_eq!(names(&second_notes), ["after-resume"]);
    second.start_process(exec(), context()).await.unwrap();
    assert_eq!(world.closed(), 0);
}

#[tokio::test]
async fn resume_errors_keep_their_codes_and_echo_the_requested_id() {
    let world = world(Backend::new());
    let (_attached, _) = attach(&world).await;
    assert_eq!(
        resume(&world, Text::from(SESSION_ID)).await.err().unwrap(),
        HandlerError::Rpc(RpcError::new(
            -32010,
            "session session-1 is already attached to another connection"
        ))
    );
    assert_eq!(
        resume(&world, Text::from("nope")).await.err().unwrap(),
        HandlerError::Rpc(RpcError::new(-32600, "unknown session id nope"))
    );
    let lone = units("session-", &[0xd800], "");
    assert_eq!(
        resume(&world, lone.clone()).await.err().unwrap(),
        HandlerError::Rpc(RpcError::unknown_session(&lone))
    );
    assert_eq!(
        resume(&world, lone).await.err().unwrap(),
        HandlerError::Rpc(RpcError::new(
            -32600,
            units("unknown session id session-", &[0xd800], "")
        ))
    );
}

#[tokio::test]
async fn a_detached_connection_gets_no_further_service() {
    let world = world(Backend::new());
    let (handler, notes) = attach(&world).await;
    handler.detach();
    assert_eq!(
        handler.start_process(exec(), context()).await.unwrap_err(),
        detached()
    );
    assert_eq!(
        environment_info_of(&handler)().await.unwrap_err(),
        detached()
    );
    assert_eq!(handler.open_rpc_connection().err(), Some(detached()));
    assert_eq!(handler.features(), BackendFeatures::default());
    let backend = locked(&world.backend.init_context).clone().unwrap();
    backend
        .notifier
        .notify("late", JsonValue::Null)
        .await
        .unwrap();
    assert!(locked(&notes).is_empty());
    assert_eq!(
        backend
            .caller
            .call("late", JsonValue::Null, CallOptions::default())
            .await,
        Err(CallError::Closed)
    );
}

#[tokio::test]
async fn a_stale_detach_does_not_release_a_resumed_session() {
    let world = world(Backend::new());
    let (first, _) = attach(&world).await;
    first.detach();
    let (second, _) = resume(&world, Text::from(SESSION_ID)).await.unwrap();
    first.detach();
    world.clock.advance_to(DETACHED_TTL_MS * 2);
    tokio::time::sleep(Duration::from_millis(100)).await;
    second.start_process(exec(), context()).await.unwrap();
    assert_eq!(world.closed(), 0);
}

#[tokio::test]
async fn retiring_a_session_aborts_the_backend_signal_and_closes_the_backend() {
    let mut world = world(Backend::new());
    let (handler, _) = attach(&world).await;
    let signal = locked(&world.backend.init_context).clone().unwrap().signal;
    assert!(!signal.is_aborted());
    handler.detach();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), world.armed.recv())
            .await
            .unwrap(),
        Some(DETACHED_TTL_MS)
    );
    world.clock.advance_to(DETACHED_TTL_MS);
    eventually(|| world.closed() == 1).await;
    assert!(signal.is_aborted());
}

#[tokio::test]
async fn a_backend_initialize_failure_is_reported_and_releases_the_backend() {
    let backend = Backend::new();
    *locked(&backend.fail_initialize) = Some(HandlerError::Rpc(RpcError::new(-32603, "boom")));
    let world = world(backend);
    let handler = world.handler();
    let (ctx, _) = link();
    assert_eq!(
        handler.initialize(params(), ctx).await.unwrap_err(),
        HandlerError::Rpc(RpcError::new(-32603, "boom"))
    );
    assert_eq!(world.closed(), 1);
}

#[tokio::test]
async fn an_unopenable_backend_is_a_rejection_and_registers_nothing() {
    let world = world(Backend::new());
    let factory: SessionFactory = Arc::new(|| Err(HandlerError::Internal));
    let handler = SupervisedHandler::new(world.registry.connect(opener(factory)));
    let (ctx, _) = link();
    assert_eq!(
        handler.initialize(params(), ctx).await.unwrap_err(),
        HandlerError::Rpc(RpcError::new(-32603, "Internal error"))
    );
    assert_eq!(world.closed(), 0);
}

#[tokio::test]
async fn shutdown_closes_every_backend_and_refuses_new_sessions() {
    let world = world(Backend::new());
    let (_attached, _) = attach(&world).await;
    world.registry.shutdown().await.unwrap();
    assert_eq!(world.closed(), 1);
    let handler = world.handler();
    let (ctx, _) = link();
    assert_eq!(
        handler.initialize(params(), ctx).await.unwrap_err(),
        HandlerError::Rpc(RpcError::new(
            -32603,
            "Executor session registry is shut down"
        ))
    );
}

#[tokio::test]
async fn optional_methods_are_unsupported_when_the_backend_lacks_them() {
    let request = EnvironmentConfigReadParams {
        cwd: "file:///w".into(),
        config_paths: vec![],
        requirements_paths: vec![],
    };
    let full = world(Backend::new());
    let (handler, _) = attach(&full).await;
    assert!(
        handler
            .read_environment_config(request.clone(), context())
            .await
            .is_ok()
    );
    assert!(handler.open_rpc_connection().unwrap().is_some());

    let minimal = world(Backend::minimal());
    let (handler, _) = attach(&minimal).await;
    assert_eq!(
        handler
            .read_environment_config(request, context())
            .await
            .unwrap_err(),
        HandlerError::Rpc(RpcError::new(
            -32601,
            "Method not supported: environmentConfig/read"
        ))
    );
    assert_eq!(
        handler
            .discover_capability_roots(CapabilityRootsDiscoverParams { roots: vec![] }, context())
            .await
            .unwrap_err(),
        HandlerError::Rpc(RpcError::new(
            -32601,
            "Method not supported: capabilityRoots/discoverV1"
        ))
    );
    assert!(handler.open_rpc_connection().unwrap().is_none());
}

#[tokio::test]
async fn the_original_client_name_reaches_the_backend() {
    let world = world(Backend::new());
    let handler = world.handler();
    let (ctx, _) = link();
    let name = units("client-", &[0xd800], "");
    handler
        .initialize(
            InitializeParams {
                client_name: name.clone(),
            },
            ctx,
        )
        .await
        .unwrap();
    assert_eq!(locked(&world.backend.client_names).clone(), vec![name]);
}

#[tokio::test]
async fn a_core_error_with_an_unpaired_unit_reaches_the_initialize_response_unchanged() {
    let backend = Backend::new();
    *locked(&backend.fail_initialize) = Some(HandlerError::Executor {
        code: -32602,
        message: units("bad ", &[0xd800], " name"),
    });
    let world = world(backend);
    let harness = Harness::over(world.handler(), world.backend.clone(), info_fn(), None);
    let response = harness
        .one(&request(1, "initialize", r#"{"clientName":"c"}"#))
        .await;
    assert_eq!(error_code(&response), -32602);
    assert_eq!(
        stringify_json(at(at(&response, "error"), "message")),
        r#""bad \ud800 name""#
    );
    assert_eq!(world.closed(), 1);
}

#[tokio::test]
async fn an_opener_error_with_an_unpaired_unit_reaches_the_initialize_response_unchanged() {
    let world = world(Backend::new());
    let factory: SessionFactory = Arc::new(|| {
        Err(HandlerError::Executor {
            code: -32603,
            message: units("open ", &[0xdc00], ""),
        })
    });
    let handler = Arc::new(SupervisedHandler::new(
        world.registry.connect(opener(factory)),
    ));
    let harness = Harness::over(handler, world.backend.clone(), info_fn(), None);
    let response = harness
        .one(&request(1, "initialize", r#"{"clientName":"c"}"#))
        .await;
    assert_eq!(error_code(&response), -32603);
    assert_eq!(
        stringify_json(at(at(&response, "error"), "message")),
        r#""open \udc00""#
    );
    assert_eq!(world.closed(), 0);
}

#[tokio::test]
async fn ascii_initialize_errors_and_fixed_codes_are_unchanged_over_rpc() {
    let backend = Backend::new();
    *locked(&backend.fail_initialize) = Some(HandlerError::Rpc(RpcError::new(-32603, "boom")));
    let world = world(backend);
    let harness = Harness::over(world.handler(), world.backend.clone(), info_fn(), None);
    let response = harness
        .one(&request(1, "initialize", r#"{"clientName":"c"}"#))
        .await;
    assert_eq!(
        (error_code(&response), error_message(&response)),
        (-32603, "boom".to_string())
    );
    let unknown = Harness::over(world.handler(), world.backend.clone(), info_fn(), None);
    let missing = unknown
        .one(&request(
            2,
            "initialize",
            r#"{"clientName":"c","resumeSessionId":"nope"}"#,
        ))
        .await;
    assert_eq!(
        (error_code(&missing), error_message(&missing)),
        (-32600, "unknown session id nope".to_string())
    );
}
