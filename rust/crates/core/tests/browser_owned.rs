use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use ycoding_core::platform::browser::{
    admission::Admission,
    bridge::{Bridge, Transport},
    protocol,
};
use ycoding_schema::{
    DomainDecode, JsonValue, browser, parse_json, session_id::SessionId, stringify_json,
};

struct Extension(tokio::sync::mpsc::UnboundedSender<Value>);
impl Transport for Extension {
    fn send(&self, value: JsonValue) -> bool {
        self.0
            .send(serde_json::from_str(&stringify_json(&value)).unwrap())
            .is_ok()
    }
    fn close(&self, _code: u16, _reason: &str) {}
}
fn decode<T: DomainDecode>(value: Value) -> T {
    T::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
}
fn receive(bridge: &Bridge, value: Value) {
    bridge
        .receive(protocol::decode_client(value.to_string().as_bytes()).unwrap())
        .unwrap();
}
fn setup() -> (Arc<Bridge>, tokio::sync::mpsc::UnboundedReceiver<Value>) {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    (
        Bridge::new(
            decode(json!(1)),
            SessionId::new("ses_bootstrap").unwrap(),
            Arc::new(Extension(sender)),
            Arc::new(Admission::default()),
            Arc::new(|_| true),
            Duration::from_secs(1),
        ),
        receiver,
    )
}

#[tokio::test]
async fn fenced_open_and_close_are_session_owned_and_never_reuse_call_identity() {
    let (bridge, mut frames) = setup();
    let open: browser::OpenInput = decode(
        json!({"sessionID":"ses_owner","generation":1,"url":"https://example.test/form","callID":"create"}),
    );
    let task = tokio::spawn({
        let bridge = bridge.clone();
        let input = open.clone();
        async move { bridge.open(input).await }
    });
    let frame = frames.recv().await.unwrap();
    assert_eq!(frame["type"], "open");
    receive(
        &bridge,
        json!({"type":"opened","callID":frame["callID"],"tabID":frame["tabID"],"generation":frame["generation"],"documentGeneration":1,"title":"Owned","url":"https://example.test/form?not-projected=secret","active":false}),
    );
    let tab = task.await.unwrap().unwrap();
    assert_eq!(tab.mode, Some(browser::Mode::Owned));
    assert!(
        bridge
            .list(&SessionId::new("ses_other").unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(bridge.open(open).await.is_err());
    let foreign: browser::CloseInput = decode(
        json!({"sessionID":"ses_other","tabID":frame["tabID"],"generation":1,"callID":"foreign-close"}),
    );
    assert!(bridge.close(foreign).await.is_err());
    let close: browser::CloseInput = decode(
        json!({"sessionID":"ses_owner","tabID":frame["tabID"],"generation":1,"callID":"close"}),
    );
    let task = tokio::spawn({
        let bridge = bridge.clone();
        let input = close.clone();
        async move { bridge.close(input).await }
    });
    let frame = frames.recv().await.unwrap();
    assert_eq!(frame["type"], "close");
    receive(
        &bridge,
        json!({"type":"closed","callID":frame["callID"],"tabID":frame["tabID"],"generation":frame["generation"]}),
    );
    task.await.unwrap().unwrap();
    assert!(
        bridge
            .list(&SessionId::new("ses_owner").unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(bridge.close(close).await.is_err());
    assert!(frames.try_recv().is_err());
}

#[tokio::test]
async fn profile_relinquish_retains_the_lease_until_ack_then_invalidates_refs() {
    let (bridge, mut frames) = setup();
    receive(&bridge, json!({"type":"profile_access","enabled":true}));
    receive(
        &bridge,
        json!({"type":"shared","mode":"profile","tabID":"btab_profile","title":"Profile","url":"https://example.test/","documentGeneration":1,"active":true}),
    );
    let session = SessionId::new("ses_owner").unwrap();
    let observing = tokio::spawn({
        let bridge = bridge.clone();
        async move {
            bridge.observe(decode(json!({"sessionID":"ses_owner","tabID":"btab_profile","generation":1,"callID":"observe"}))).await
        }
    });
    frames.recv().await.unwrap();
    receive(
        &bridge,
        json!({"type":"observation","callID":"observe","tabID":"btab_profile","generation":1,"documentGeneration":1,"revision":1,"title":"Profile","url":"https://example.test/","elements":[{"ref":"b1","role":"button","name":"Go"}],"truncated":false}),
    );
    observing.await.unwrap().unwrap();
    let input: browser::ReleaseInput = decode(
        json!({"sessionID":"ses_owner","tabID":"btab_profile","generation":1,"callID":"release"}),
    );
    let releasing = tokio::spawn({
        let bridge = bridge.clone();
        let input = input.clone();
        async move { bridge.release(input).await }
    });
    let frame = frames.recv().await.unwrap();
    assert_eq!(frame["type"], "relinquish");
    assert_eq!(
        bridge.list(&session).unwrap()[0].lease,
        Some(browser::Lease::Self_)
    );
    assert_eq!(
        bridge.list(&session).unwrap()[0].observation_revision.get(),
        1
    );
    receive(
        &bridge,
        json!({"type":"relinquished","callID":"release","tabID":"btab_profile","generation":1}),
    );
    releasing.await.unwrap().unwrap();
    let tabs = bridge.list(&session).unwrap();
    assert_eq!(tabs[0].lease, None);
    assert_eq!(tabs[0].observation_revision.get(), 0);
    bridge.release(input).await.unwrap();
    assert!(frames.try_recv().is_err());
}
