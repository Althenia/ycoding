use serde_json::{Value, json};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
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
async fn setup() -> (Arc<Bridge>, tokio::sync::mpsc::UnboundedReceiver<Value>) {
    let (send, mut frames) = tokio::sync::mpsc::unbounded_channel();
    let bridge = Bridge::new(
        decode(json!(1)),
        SessionId::new("ses_owner").unwrap(),
        Arc::new(Extension(send)),
        Arc::new(Admission::default()),
        Arc::new(|_| true),
        Duration::from_secs(1),
    );
    receive(&bridge, json!({"type":"profile_access","enabled":true}));
    receive(
        &bridge,
        json!({"type":"shared","mode":"profile","tabID":"btab_profile","title":"Profile","url":"https://example.test/","documentGeneration":1,"active":false}),
    );
    let observing = tokio::spawn({
        let bridge = bridge.clone();
        async move {
            bridge.observe(decode(json!({"sessionID":"ses_owner","tabID":"btab_profile","generation":1,"callID":"observe"}))).await
        }
    });
    frames.recv().await.unwrap();
    receive(
        &bridge,
        json!({"type":"observation","callID":"observe","tabID":"btab_profile","generation":1,"documentGeneration":1,"revision":1,"title":"Profile","url":"https://example.test/","elements":[],"truncated":false}),
    );
    observing.await.unwrap().unwrap();
    (bridge, frames)
}
#[tokio::test]
async fn execution_end_waits_for_mutation_then_relinquishes_after_acknowledgement() {
    let (bridge, mut frames) = setup().await;
    let action = tokio::spawn({
        let bridge = bridge.clone();
        async move {
            bridge.action(decode(json!({"sessionID":"ses_owner","tabID":"btab_profile","generation":1,"documentGeneration":1,"observationRevision":1,"callID":"navigate","action":{"type":"navigate","url":"https://example.test/next"}}))).await
        }
    });
    assert_eq!(frames.recv().await.unwrap()["type"], "action");
    let session = SessionId::new("ses_owner").unwrap();
    let mut ending = Box::pin(bridge.relinquish_session(&session));
    std::future::poll_fn(|cx| {
        assert!(ending.as_mut().poll(cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    assert!(frames.try_recv().is_err());
    receive(
        &bridge,
        json!({"type":"result","callID":"navigate","tabID":"btab_profile","generation":1,"documentGeneration":2,"observationRevision":0,"status":"completed","title":"Profile","url":"https://example.test/next"}),
    );
    action.await.unwrap().unwrap();
    let (result, ()) = tokio::join!(ending, async {
        let release = frames.recv().await.unwrap();
        assert_eq!(release["type"], "relinquish");
        assert_eq!(
            bridge.list(&session).unwrap()[0].lease,
            Some(browser::Lease::Self_)
        );
        receive(
            &bridge,
            json!({"type":"relinquished","callID":release["callID"],"tabID":"btab_profile","generation":1}),
        );
    });
    result.unwrap();
    assert_eq!(
        bridge.list(&SessionId::new("ses_owner").unwrap()).unwrap()[0].lease,
        None
    );
}
#[tokio::test]
async fn ownership_end_releases_archived_profile_owner_without_rechecking_session_and_keeps_foreign_tabs()
 {
    let active = Arc::new(Mutex::new(true));
    let (send, mut frames) = tokio::sync::mpsc::unbounded_channel();
    let bridge = Bridge::new(
        decode(json!(1)),
        SessionId::new("ses_owner").unwrap(),
        Arc::new(Extension(send)),
        Arc::new(Admission::default()),
        Arc::new({
            let active = active.clone();
            move |session| {
                session.as_lossless().as_str() != Some("ses_owner") || *active.lock().unwrap()
            }
        }),
        Duration::from_secs(1),
    );
    receive(&bridge, json!({"type":"profile_access","enabled":true}));
    receive(
        &bridge,
        json!({"type":"shared","mode":"profile","tabID":"btab_profile","title":"Profile","url":"https://example.test/","documentGeneration":1,"active":true}),
    );
    let observing = tokio::spawn({
        let bridge = bridge.clone();
        async move {
            bridge.observe(decode(json!({"sessionID":"ses_owner","tabID":"btab_profile","generation":1,"callID":"observe"}))).await
        }
    });
    frames.recv().await.unwrap();
    receive(
        &bridge,
        json!({"type":"observation","callID":"observe","tabID":"btab_profile","generation":1,"documentGeneration":1,"revision":1,"title":"Profile","url":"https://example.test/","elements":[],"truncated":false}),
    );
    observing.await.unwrap().unwrap();
    *active.lock().unwrap() = false;
    bridge
        .release_session(&SessionId::new("ses_owner").unwrap())
        .unwrap();
    let ending = tokio::spawn({
        let bridge = bridge.clone();
        async move {
            bridge
                .relinquish_session(&SessionId::new("ses_owner").unwrap())
                .await
        }
    });
    let release = frames.recv().await.unwrap();
    receive(
        &bridge,
        json!({"type":"relinquished","callID":release["callID"],"tabID":"btab_profile","generation":1}),
    );
    ending.await.unwrap().unwrap();
    assert_eq!(
        bridge.list(&SessionId::new("ses_other").unwrap()).unwrap()[0].lease,
        None
    );
}
