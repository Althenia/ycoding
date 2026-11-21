mod support;

use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use ycoding_core::{
    platform::{
        browser::{admission::Admission, isolated},
        computer::Future,
    },
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, browser, parse_json,
        session_id::SessionId,
    },
};
use ycoding_protocol::{
    domain_json::{self, Domain},
    limits, v5,
};
use ycoding_runtime::{Dispatcher, Environment, LocalAuth, Settled, standard};

fn decode<T: DomainDecode>(source: &str) -> T {
    T::decode(&parse_json(source).unwrap()).unwrap()
}
fn domain(value: &JsonValue) -> Domain {
    match value {
        JsonValue::Null => Domain::Null,
        JsonValue::Bool(value) => Domain::Bool(*value),
        JsonValue::Number(value) => Domain::Number(*value),
        JsonValue::String(value) => Domain::Text(value.code_units().collect()),
        JsonValue::Array(values) => Domain::List(values.iter().map(domain).collect()),
        JsonValue::Object(values) => Domain::Object(
            values
                .iter()
                .map(|(key, value)| (key.code_units().collect(), domain(value)))
                .collect(),
        ),
    }
}
fn field<'a>(value: &'a Domain, name: &str) -> &'a Domain {
    let Domain::Object(fields) = value else {
        panic!("Expected object")
    };
    fields
        .iter()
        .find(|(key, _)| key == &name.encode_utf16().collect::<Vec<_>>())
        .map(|(_, value)| value)
        .unwrap_or_else(|| panic!("Missing {name}: {value:?}"))
}
fn payload(
    instance: Option<&(impl DomainEncode + ?Sized)>,
    tab: &(impl DomainEncode + ?Sized),
    action: &JsonValue,
) -> JsonValue {
    let mut object = ObjectEncoder::new();
    if let Some(instance) = instance {
        object = object.field("instanceID", instance);
    }
    object
        .field("tabID", tab)
        .field("generation", &1f64)
        .field("documentGeneration", &1f64)
        .field("observationRevision", &1f64)
        .field("callID", "parity")
        .field("action", action)
        .finish()
}
async fn invoke(
    dispatcher: &Dispatcher,
    environment: Arc<Environment>,
    name: &str,
    payload: JsonValue,
) -> v5::TypedPayload {
    let operation = dispatcher
        .descriptors()
        .into_iter()
        .find(|operation| operation.diagnostic_name == name)
        .unwrap();
    let body = ObjectEncoder::new()
        .field("params", &decode::<JsonValue>(r#"{"sessionID":"ses_get"}"#))
        .field("payload", &payload)
        .finish();
    let body = domain_json::encode(
        &operation.request_type,
        &domain(&body),
        limits::BULK_MESSAGE_BYTES as usize,
    )
    .unwrap();
    let settled = tokio::time::timeout(
        support::WAIT,
        dispatcher.invoke(
            environment,
            "browser-parity".into(),
            v5::Request {
                request_id: "parity".into(),
                operation_id: operation.operation_id,
                scope: support::session_scope("ses_get"),
                payload: body,
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let Settled::Result(result) = settled else {
        panic!("Expected inline result")
    };
    match result.outcome.unwrap() {
        v5::result::Outcome::Success(payload) | v5::result::Outcome::Error(payload) => payload,
        _ => panic!("Unexpected result kind"),
    }
}
fn actions() -> Vec<JsonValue> {
    decode(
        r#"[
        {"type":"navigate","url":"https://example.test/next"},
        {"type":"click","ref":"b1"},{"type":"type","ref":"b1","text":"Fixture"},
        {"type":"scroll","deltaY":120},{"type":"capture"},
        {"type":"group","tabIDs":["btab_parity"],"title":"Fixture"},
        {"type":"ungroup","tabIDs":["btab_parity"],"groupID":0},
        {"type":"back"},{"type":"forward"},{"type":"reload"},
        {"type":"key","key":"Enter","modifiers":["Control"]},
        {"type":"wait","ref":"b1","timeoutMs":0},{"type":"clipboard_read"},
        {"type":"clipboard_write","text":"Fixture"},
        {"type":"upload","ref":"b1","paths":["/synthetic/upload.txt"]},
        {"type":"download","timeoutMs":0},{"type":"logs","limit":1},
        {"type":"export"},{"type":"webmcp_list"},
        {"type":"webmcp_invoke","name":"fixture.echo","arguments":{"text":"hello"}}
    ]"#,
    )
}
fn environment() -> Arc<Environment> {
    Arc::new(Environment {
        services: support::services(LocalAuth::disabled(), true),
        urls: Vec::new(),
        subscriptions: Default::default(),
        uploads: Default::default(),
    })
}
#[tokio::test]
async fn twenty_actions_cross_both_runtime_decode_arms_before_backend_lookup() {
    use prost::Name;
    let dispatcher = standard().unwrap();
    let environment = environment();
    for name in ["browser.action", "isolatedBrowser.action"] {
        for action in actions() {
            let reply = invoke(
                &dispatcher,
                environment.clone(),
                name,
                payload(
                    (name == "isolatedBrowser.action").then_some("ibrowser_parity"),
                    "btab_parity",
                    &action,
                ),
            )
            .await;
            assert_eq!(
                reply.type_name,
                v5::ServiceUnavailableError::full_name(),
                "{name}: {action:?}"
            );
            let decoded = domain_json::decode(&reply.type_name, &reply.payload).unwrap();
            assert_eq!(
                field(&decoded, "message"),
                &domain(&JsonValue::String(if name == "browser.action" {
                    "Paired Chrome coordinator is not composed".into()
                } else {
                    "Location-scoped isolated browser resolver is not composed".into()
                }))
            );
        }
    }
}

fn snapshot() -> isolated::Snapshot {
    isolated::Snapshot {
        title: LosslessString::from_utf16(vec![0xd800]),
        url: "https://example.test/form?record=private#fragment".into(),
        document_generation: decode("1"),
        revision: decode("1"),
        elements: vec![decode(
            r#"{"ref":"b1","role":"button","name":"Submit","frame":{"origin":"https://child.test","path":"/frame"}}"#,
        )],
        texts: Some(vec![decode(
            r#"{"role":"heading","name":"Child heading","frame":{"origin":"https://child.test","path":"/frame"}}"#,
        )]),
        frames: Some(vec![decode(
            r#"{"page":{"origin":"https://child.test","path":"/frame"},"observed":true}"#,
        )]),
        truncated: false,
    }
}
struct Native {
    inputs: Mutex<Vec<JsonValue>>,
    closed: watch::Sender<bool>,
}
struct Factory(Arc<Native>);
impl isolated::Executor for Factory {
    fn availability(&self) -> Future<'_, isolated::Availability> {
        Box::pin(async {
            isolated::Availability {
                available: true,
                reason: None,
            }
        })
    }
    fn launch(
        &self,
        _: isolated::Launch,
        _: watch::Receiver<bool>,
    ) -> Future<'_, Result<Arc<dyn isolated::Runtime>, isolated::ExecutorError>> {
        Box::pin(async move { Ok(self.0.clone() as Arc<dyn isolated::Runtime>) })
    }
}
impl isolated::Runtime for Native {
    fn observe(&self) -> Future<'_, Result<isolated::Snapshot, isolated::ExecutorError>> {
        Box::pin(async { Ok(snapshot()) })
    }
    fn action<'a>(
        &'a self,
        action: browser::Action,
        _: Vec<String>,
        _: watch::Receiver<bool>,
    ) -> Future<'a, Result<isolated::ActionOutput, isolated::ExecutorError>> {
        Box::pin(async move {
            self.inputs.lock().unwrap().push(action.encode());
            Ok(isolated::ActionOutput {
                snapshot: snapshot(),
                capture: None,
                rejected: None,
                text: Some(LosslessString::from_utf16(vec![0xd800])),
                logs: Some(vec![decode(
                    r#"{"level":"info","text":"Frame log","frame":{"origin":"https://child.test","path":"/frame"}}"#,
                )]),
                data: None,
                webmcp_tools: Some(vec![decode(r#"{"name":"fixture.echo"}"#)]),
                dialog: None,
                control: None,
                frame: None,
                message: None,
            })
        })
    }
    fn pause(&self) -> Future<'_, Result<(), isolated::ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn resume(&self) -> Future<'_, Result<(), isolated::ExecutorError>> {
        Box::pin(async { Ok(()) })
    }
    fn close(&self) -> Future<'_, Result<(), isolated::ExecutorError>> {
        Box::pin(async move {
            self.closed.send_replace(true);
            Ok(())
        })
    }
    fn closed(&self) -> Future<'_, ()> {
        let mut closed = self.closed.subscribe();
        Box::pin(async move {
            let _ = closed.wait_for(|value| *value).await;
        })
    }
}
#[tokio::test]
async fn runtime_isolated_projection_preserves_frames_text_and_optional_outputs() {
    let native = Arc::new(Native {
        inputs: Mutex::new(Vec::new()),
        closed: watch::channel(false).0,
    });
    let isolated = isolated::Service::new(
        Arc::new(Factory(native.clone())),
        Arc::new(Admission::default()),
        Arc::new(|_| true),
        isolated::Options::default(),
    );
    let mut services = support::services(LocalAuth::disabled(), true);
    let resolve = isolated.clone();
    services.core.as_mut().unwrap().isolated_browser = Some(Arc::new(move |_| Ok(resolve.clone())));
    let environment = Arc::new(Environment {
        services,
        urls: Vec::new(),
        subscriptions: Default::default(),
        uploads: Default::default(),
    });
    let dispatcher = standard().unwrap();
    let ready = isolated
        .start(
            &SessionId::new("ses_get").unwrap(),
            decode(r#"{"url":"https://example.test/form"}"#),
        )
        .await
        .unwrap();
    let tab = ready.tab.unwrap();
    let instance = ready.instance_id.unwrap();
    let observe = ObjectEncoder::new()
        .field("instanceID", &instance)
        .field("tabID", &tab.id)
        .field("generation", &1f64)
        .field("callID", "observe")
        .finish();
    let reply = invoke(
        &dispatcher,
        environment.clone(),
        "isolatedBrowser.observe",
        observe,
    )
    .await;
    let observed = domain_json::decode(&reply.type_name, &reply.payload).unwrap();
    let observed = field(&observed, "data");
    assert_eq!(field(observed, "title"), &Domain::Text(vec![0xd800]));
    assert_eq!(
        field(observed, "texts"),
        &domain(&decode(
            r#"[{"role":"heading","name":"Child heading","frame":{"origin":"https://child.test","path":"/frame"}}]"#
        ))
    );
    assert_eq!(
        field(observed, "frames"),
        &domain(&decode(
            r#"[{"page":{"origin":"https://child.test","path":"/frame"},"observed":true}]"#
        ))
    );
    let action: JsonValue = decode(r#"{"type":"logs"}"#);
    let reply = invoke(
        &dispatcher,
        environment,
        "isolatedBrowser.action",
        payload(Some(&instance), &tab.id, &action),
    )
    .await;
    let output = domain_json::decode(&reply.type_name, &reply.payload).unwrap();
    let output = field(&output, "data");
    assert_eq!(native.inputs.lock().unwrap().last(), Some(&action));
    assert_eq!(field(output, "text"), &Domain::Text(vec![0xd800]));
    assert_eq!(
        field(output, "logs"),
        &domain(&decode(
            r#"[{"level":"info","text":"Frame log","frame":{"origin":"https://child.test","path":"/frame"}}]"#
        ))
    );
    assert_eq!(
        field(output, "webmcpTools"),
        &domain(&decode(r#"[{"name":"fixture.echo"}]"#))
    );
    let Domain::Object(fields) = output else {
        panic!("Expected action result")
    };
    for name in ["data", "savedFile", "download", "capture"] {
        assert!(
            !fields
                .iter()
                .any(|(key, _)| key == &name.encode_utf16().collect::<Vec<_>>())
        );
    }
    isolated.shutdown().await.unwrap();
}
