use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_core::platform::browser::{
    admission::Admission,
    bridge::{Bridge, Transport},
    protocol,
};
use ycoding_schema::{DomainDecode, JsonValue, browser, parse_json, session_id::SessionId};

#[derive(Default)]
struct Extension {
    frames: Mutex<Vec<JsonValue>>,
    sent: tokio::sync::Notify,
}
impl Transport for Extension {
    fn send(&self, frame: JsonValue) -> bool {
        self.frames.lock().unwrap().push(frame);
        self.sent.notify_one();
        true
    }
    fn close(&self, _code: u16, _reason: &str) {}
}
fn decode<T: DomainDecode>(value: serde_json::Value) -> T {
    T::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
}
fn receive(bridge: &Bridge, value: serde_json::Value) {
    bridge
        .receive(protocol::decode_client(value.to_string().as_bytes()).unwrap())
        .unwrap();
}
#[tokio::test]
async fn shared_control_does_not_claim_a_new_sessions_browser_mode_and_detach_invalidates_observation()
 {
    let admission = Arc::new(Admission::default());
    let extension = Arc::new(Extension::default());
    let bridge = Bridge::new(
        decode(json!(1)),
        SessionId::new("ses_bootstrap").unwrap(),
        extension.clone(),
        admission.clone(),
        Arc::new(|_| true),
        Duration::from_secs(1),
    );
    receive(&bridge, json!({"type":"profile_access","enabled":true}));
    receive(
        &bridge,
        json!({"type":"shared","mode":"profile","tabID":"btab_test","title":"Fixture","url":"https://example.test/","documentGeneration":1,"active":true}),
    );
    let session = SessionId::new("ses_other").unwrap();
    let observation = tokio::spawn({
        let bridge = bridge.clone();
        async move {
            bridge.observe(decode(json!({"sessionID":"ses_other","tabID":"btab_test","generation":1,"callID":"observe"}))).await
        }
    });
    extension.sent.notified().await;
    receive(
        &bridge,
        json!({"type":"observation","callID":"observe","tabID":"btab_test","generation":1,"documentGeneration":1,"revision":1,"title":"Fixture","url":"https://example.test/","elements":[{"ref":"b1","role":"button","name":"Submit"}],"truncated":false}),
    );
    observation.await.unwrap().unwrap();
    assert_eq!(admission.current("ses_other"), None);
    bridge.detach();
    let tab = &bridge.list(&session).unwrap()[0];
    assert_eq!(tab.status, browser::TabStatus::Unavailable);
    assert_eq!(tab.observation_revision.get(), 0);
}
