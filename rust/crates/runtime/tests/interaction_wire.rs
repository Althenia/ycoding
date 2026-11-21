mod support;
use prost::{Message, Name};
use std::sync::Arc;
use tokio::sync::watch;
use ycoding_core::{
    platform::{
        computer::Future,
        interaction::{Authority, Driver, Error, Operation, Options, Value, from_domain},
    },
    ycoding_schema::{JsonValue, parse_json},
};
use ycoding_protocol::{domain_json, limits, v5};
use ycoding_runtime::{Dispatcher, Environment, LocalAuth, Settled, standard};
fn value(text: &str) -> Value {
    from_domain(&parse_json(text).unwrap()).unwrap()
}
struct Chrome;
impl Driver for Chrome {
    fn platform(&self) -> &'static str {
        "chrome"
    }
    fn call(
        &self,
        operation: Operation,
        _: Value,
        _: watch::Receiver<bool>,
    ) -> Future<'_, Result<Value, Error>> {
        Box::pin(async move {
            Ok(value(match operation {
                Operation::Inventory => {
                    r#"[{"kind":"chrome-tab","id":"10000000-0000-4000-8000-000000000001","label":"Fixture","origin":"https://example.test","pathname":"/"}]"#
                }
                Operation::Attach => r#"{"id":"10000000-0000-4000-8000-000000000002"}"#,
                Operation::Resume => "true",
                _ => "null",
            }))
        })
    }
}
async fn invoke(
    dispatcher: &Dispatcher,
    environment: Arc<Environment>,
    name: &str,
    input: &str,
) -> v5::TypedPayload {
    let operation = dispatcher
        .descriptors()
        .into_iter()
        .find(|o| o.diagnostic_name == name)
        .unwrap();
    fn domain(value: &JsonValue) -> domain_json::Domain {
        match value {
            JsonValue::Null => domain_json::Domain::Null,
            JsonValue::Bool(v) => domain_json::Domain::Bool(*v),
            JsonValue::Number(v) => domain_json::Domain::Number(*v),
            JsonValue::String(v) => domain_json::Domain::Text(v.code_units().collect()),
            JsonValue::Array(v) => domain_json::Domain::List(v.iter().map(domain).collect()),
            JsonValue::Object(v) => domain_json::Domain::Object(
                v.iter()
                    .map(|(k, v)| (k.code_units().collect(), domain(v)))
                    .collect(),
            ),
        }
    }
    let payload = domain_json::encode(
        &operation.request_type,
        &domain(&parse_json(input).unwrap()),
        limits::INLINE_BODY_BYTES as usize,
    )
    .unwrap();
    let Some(Settled::Result(result)) = dispatcher
        .invoke(
            environment,
            "interaction-fixture".into(),
            v5::Request {
                request_id: "interaction-fixture".into(),
                operation_id: operation.operation_id,
                scope: support::session_scope("ses_get"),
                payload,
            },
        )
        .await
    else {
        panic!("inline settlement")
    };
    match result.outcome.unwrap() {
        v5::result::Outcome::Success(payload) | v5::result::Outcome::Error(payload) => payload,
        _ => panic!("inline payload"),
    }
}
#[tokio::test]
async fn session_operations_require_consent_and_exact_generation_without_network() {
    let authority = Authority::new(Options::default());
    let native = authority.register("chrome", Arc::new(Chrome)).unwrap();
    let mut services = support::services(LocalAuth::disabled(), true);
    services.core.as_mut().unwrap().interaction = Some(authority.clone());
    let environment = Arc::new(Environment {
        services,
        urls: vec![],
        subscriptions: Default::default(),
        uploads: Default::default(),
    });
    let dispatcher = standard().unwrap();
    let status = invoke(
        &dispatcher,
        environment.clone(),
        "session.interaction.status",
        r#"{"params":{"sessionID":"ses_get"}}"#,
    )
    .await;
    assert_eq!(
        status.type_name,
        v5::SessionInteractionStatusResult::full_name()
    );
    let status = v5::SessionInteractionStatusResult::decode(status.payload.as_slice()).unwrap();
    assert!(matches!(
        status.data.kind,
        Some(v5::interaction_status::Kind::Value1(_))
    ));
    let requested = invoke(
        &dispatcher,
        environment.clone(),
        "session.interaction.request",
        r#"{"params":{"sessionID":"ses_get"},"payload":{"platform":"chrome"}}"#,
    )
    .await;
    assert_eq!(
        requested.type_name,
        v5::SessionInteractionRequestResult::full_name()
    );
    let generation = authority.status("ses_get")["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let candidate = native.pending()[0].clone();
    native
        .inventory(candidate["candidateID"].as_str().unwrap())
        .await;
    let proof = format!(
        r#"{{"candidateID":{},"sessionID":"ses_get","targetID":"10000000-0000-4000-8000-000000000001","authorization":"fixture-consent"}}"#,
        candidate["candidateID"]
    );
    assert!(native.approve(value(&proof)).await);
    let wrong = "10000000-0000-4000-8000-000000000099";
    let input = |generation: &str| {
        format!(
            r#"{{"params":{{"sessionID":"ses_get"}},"payload":{{"generation":"{generation}"}}}}"#
        )
    };
    let stopped = invoke(
        &dispatcher,
        environment.clone(),
        "session.interaction.stop",
        &input(wrong),
    )
    .await;
    assert_eq!(stopped.type_name, v5::ConflictError::full_name());
    let preview = invoke(
        &dispatcher,
        environment.clone(),
        "session.interaction.preview",
        &format!(r#"{{"params":{{"sessionID":"ses_get"}},"query":{{"generation":"{wrong}"}}}}"#),
    )
    .await;
    assert_eq!(
        preview.type_name,
        v5::SessionInteractionPreviewResult::full_name()
    );
    assert!(matches!(
        v5::SessionInteractionPreviewResult::decode(preview.payload.as_slice())
            .unwrap()
            .data
            .kind,
        Some(v5::interaction_preview::Kind::Value1(_))
    ));
    assert!(native.pause(
        "10000000-0000-4000-8000-000000000002",
        "foreground_required"
    ));
    let resumed = invoke(
        &dispatcher,
        environment.clone(),
        "session.interaction.resume",
        &input(&generation),
    )
    .await;
    assert_eq!(
        resumed.type_name,
        v5::SessionInteractionResumeResult::full_name()
    );
    assert_eq!(authority.status("ses_get")["state"], "active");
    let stopped = invoke(
        &dispatcher,
        environment.clone(),
        "session.interaction.stop",
        &input(&generation),
    )
    .await;
    assert_eq!(
        stopped.type_name,
        v5::SessionInteractionStopResult::full_name()
    );
    assert_eq!(authority.status("ses_get")["state"], "stopped");
    authority.shutdown().await.unwrap();
}
#[tokio::test]
async fn unsupported_host_and_session_scope_mismatch_refuse_before_platform_calls() {
    let environment = Arc::new(Environment {
        services: support::services(LocalAuth::disabled(), true),
        urls: vec![],
        subscriptions: Default::default(),
        uploads: Default::default(),
    });
    let dispatcher = standard().unwrap();
    let unavailable = invoke(
        &dispatcher,
        environment.clone(),
        "session.interaction.status",
        r#"{"params":{"sessionID":"ses_get"}}"#,
    )
    .await;
    assert_eq!(unavailable.type_name, v5::InvalidRequestError::full_name());
    assert_eq!(
        v5::InvalidRequestError::decode(unavailable.payload.as_slice())
            .unwrap()
            .kind,
        Some(support::text("unavailable"))
    );
    let mismatch = invoke(
        &dispatcher,
        environment,
        "session.interaction.status",
        r#"{"params":{"sessionID":"ses_other"}}"#,
    )
    .await;
    assert_ne!(
        mismatch.type_name,
        v5::SessionInteractionStatusResult::full_name()
    );
}
