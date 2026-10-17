include!("policy_fixture.rs");
mod code_mode_regexp_fixture;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use ycoding_core::{
    process::guardrails::{Guardrails, Input, Limits, Paths, Settings},
    tools::{
        code_mode::{
            Cancellation, ExecutionLimits, Runtime, ToolDescription, ToolFailure, ToolFuture,
            ToolHost,
        },
        policy::{Publisher, permissions::Permissions},
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, LosslessString, guardrail, permission, project_id::ProjectId,
    session_id::SessionId,
};

struct Host {
    permissions: Permissions,
    guardrails: Guardrails,
    session: SessionId,
    invoked: AtomicUsize,
}
impl ToolHost for Host {
    fn catalog(&self) -> Vec<ToolDescription> {
        ["read", "shell"]
            .into_iter()
            .map(|name| ToolDescription {
                path: format!("leaf.{name}").into(),
                description: name.into(),
                signature: format!("tools.leaf.{name}(input: string): Promise<string>"),
                input_properties: Vec::new(),
            })
            .collect()
    }
    fn decode_input(
        &self,
        _: &LosslessString,
        input: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        match input {
            Some(JsonValue::String(_)) => Ok(input),
            _ => Err(ToolFailure::InvalidInput("Expected resource".into())),
        }
    }
    fn invoke(
        &self,
        path: LosslessString,
        input: Option<JsonValue>,
        cancellation: Cancellation,
    ) -> ToolFuture<'_> {
        Box::pin(async move {
            let Some(JsonValue::String(resource)) = input else {
                return Err(ToolFailure::Internal);
            };
            let action = path
                .to_utf8()
                .unwrap()
                .strip_prefix("leaf.")
                .unwrap()
                .to_owned();
            let run = async {
                self.permissions
                    .assert(
                        permission::Request {
                            id: permission::Id::new("per_code_mode").unwrap(),
                            session_id: self.session.clone(),
                            action: action.as_str().into(),
                            resources: vec![resource.clone()],
                            save: None,
                            metadata: None,
                            source: Some(permission::Source {
                                message_id: "msg_assistant".into(),
                                call_id: "call_execute".into(),
                            }),
                        },
                        Some("test".into()),
                    )
                    .await
                    .map_err(|_| ToolFailure::Safe("Permission denied".into()))?;
                let admission = self
                    .guardrails
                    .assert(Input {
                        session_id: self.session.clone(),
                        action,
                        resources: vec![resource.clone()],
                        metadata: None,
                        skip_review: false,
                        holder: None,
                        defer_shell: false,
                        source: None,
                    })
                    .map_err(|_| ToolFailure::Safe("Guardrail denied".into()))?;
                let _reservation = match admission.wait {
                    Some(wait) => Some(
                        wait.await
                            .map_err(|_| ToolFailure::Internal)?
                            .map_err(|_| ToolFailure::Safe("Guardrail denied".into()))?,
                    ),
                    None => admission.reservation,
                };
                self.invoked.fetch_add(1, Ordering::AcqRel);
                Ok(Some(JsonValue::String(resource)))
            };
            tokio::select! { biased; _ = cancellation.cancelled() => Err(ToolFailure::Cancelled), result = run => result }
        })
    }
    fn decode_output(
        &self,
        _: &LosslessString,
        output: Option<JsonValue>,
    ) -> Result<Option<JsonValue>, ToolFailure> {
        Ok(output)
    }
}

fn host(fixture: &Fixture, session: SessionId, publisher: Publisher) -> Arc<Host> {
    let permissions = Permissions::new(
        fixture.authority(),
        ProjectId::new("project").unwrap(),
        publisher.clone(),
    );
    Arc::new(Host {
        guardrails: Guardrails::new(
            fixture.authority(),
            permissions.clone(),
            Settings {
                paths: Paths {
                    workdir: "/workspace/project".into(),
                    project: "/workspace/project".into(),
                    home: "/home/operator".into(),
                    tmpdir: None,
                    trusted_paths: Vec::new(),
                },
                global_roots: Vec::new(),
                custom: Arc::new(Vec::new),
                enabled: true,
                limits: Limits::default(),
                decide_reviews: false,
                decide_hard_reviews: true,
            },
            publisher,
        ),
        permissions,
        session,
        invoked: AtomicUsize::new(0),
    })
}
fn runtime(host: Arc<Host>) -> Runtime {
    Runtime::new(
        host,
        ExecutionLimits {
            timeout_ms: Some(1_000),
            ..ExecutionLimits::default()
        },
        Arc::new(ycoding_core::tools::code_mode::regexp::NativeRegExpEngine),
        code_mode_regexp_fixture::collation(),
    )
    .unwrap()
}
fn publisher() -> (
    Publisher,
    tokio::sync::mpsc::UnboundedReceiver<ycoding_core::tools::policy::Event>,
) {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    (
        Arc::new(move |event| {
            sender
                .send(event)
                .map_err(|_| "Closed test observer".into())
        }),
        receiver,
    )
}

#[tokio::test]
async fn captured_leaves_enforce_real_session_permission_ceiling_before_side_effects() {
    let fixture = Fixture::default();
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "*".into(),
        resource: "*".into(),
        effect: permission::Effect("allow".into()),
    });
    let session = fixture.session(
        "ses_denied",
        None,
        3,
        true,
        Some(vec![permission::Rule {
            action: "read".into(),
            resource: "*".into(),
            effect: permission::Effect("deny".into()),
        }]),
    );
    let host = host(&fixture, session, fixture.publisher());
    let result = runtime(host.clone()).execute("try {await tools.leaf.read('/workspace/project/file')} catch(error) {return error.message}", Cancellation::default()).await;
    assert_eq!(
        result.value,
        Ok(JsonValue::String("Permission denied".into()))
    );
    assert_eq!(host.invoked.load(Ordering::Acquire), 0);
    assert!(host.permissions.list().is_empty());
}

#[tokio::test]
async fn code_mode_permission_asks_preserve_outer_source_and_rejection_does_not_invoke() {
    let fixture = Fixture::default();
    let session = fixture.session("ses_ask", None, 0, false, None);
    let (publisher, mut events) = publisher();
    let host = host(&fixture, session, publisher);
    let execution_host = host.clone();
    let execution = tokio::spawn(async move {
        runtime(execution_host)
            .execute(
                "return await tools.leaf.read('/workspace/project/file')",
                Cancellation::default(),
            )
            .await
    });
    let event = events.recv().await.unwrap();
    let request = permission::Request::decode(&event.data).unwrap();
    assert_eq!(
        request.source,
        Some(permission::Source {
            message_id: "msg_assistant".into(),
            call_id: "call_execute".into()
        })
    );
    host.permissions
        .reply(&request.id, permission::Reply("reject".into()), None)
        .unwrap();
    assert!(execution.await.unwrap().value.is_err());
    assert_eq!(host.invoked.load(Ordering::Acquire), 0);
    assert!(host.permissions.list().is_empty());
}

#[tokio::test]
async fn hard_guardrail_review_is_not_bypassed_by_goal_or_yolo_code_mode_execution() {
    let fixture = Fixture::default();
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "*".into(),
        resource: "*".into(),
        effect: permission::Effect("allow".into()),
    });
    let session = fixture.session("ses_hard", None, 2, true, None);
    let (publisher, mut events) = publisher();
    let host = host(&fixture, session.clone(), publisher);
    let execution_host = host.clone();
    let execution = tokio::spawn(async move {
        runtime(execution_host)
            .execute(
                "return await tools.leaf.shell('rm -rf ~/notes')",
                Cancellation::default(),
            )
            .await
    });
    let event = events.recv().await.unwrap();
    let request = guardrail::Request::decode(&event.data).unwrap();
    assert_eq!(request.hard_review, Some(true));
    assert_eq!(host.invoked.load(Ordering::Acquire), 0);
    host.guardrails
        .reply(&session, &request.id, guardrail::Reply::Once)
        .unwrap();
    assert_eq!(
        execution.await.unwrap().value,
        Ok(JsonValue::String("rm -rf ~/notes".into()))
    );
    assert_eq!(host.invoked.load(Ordering::Acquire), 1);
}

#[tokio::test]
async fn cancelling_a_code_mode_permission_wait_removes_the_real_pending_request() {
    let fixture = Fixture::default();
    let session = fixture.session("ses_cancel", None, 0, false, None);
    let (publisher, mut events) = publisher();
    let host = host(&fixture, session, publisher);
    let cancellation = Cancellation::default();
    let cancel_execution = cancellation.clone();
    let execution_host = host.clone();
    let execution = tokio::spawn(async move {
        runtime(execution_host)
            .execute(
                "return await tools.leaf.read('/workspace/project/file')",
                cancel_execution,
            )
            .await
    });
    events.recv().await.unwrap();
    assert_eq!(host.permissions.list().len(), 1);
    cancellation.cancel();
    assert!(execution.await.unwrap().value.is_err());
    assert!(host.permissions.list().is_empty());
    assert_eq!(host.invoked.load(Ordering::Acquire), 0);
}
