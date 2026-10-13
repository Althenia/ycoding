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
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, browser, parse_json, session_id::SessionId,
    stringify_json,
};

struct Extension {
    outbox: Mutex<Vec<JsonValue>>,
    notice: tokio::sync::Notify,
}
impl Transport for Extension {
    fn send(&self, message: JsonValue) -> bool {
        self.outbox.lock().unwrap().push(message);
        self.notice.notify_one();
        true
    }
    fn close(&self, _code: u16, _reason: &str) {}
}
fn decode<T: DomainDecode>(value: serde_json::Value) -> T {
    T::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
}
fn setup(timeout: Duration) -> (Arc<Bridge>, Arc<Extension>) {
    let extension = Arc::new(Extension {
        outbox: Mutex::new(Vec::new()),
        notice: tokio::sync::Notify::new(),
    });
    let bridge = Bridge::new(
        decode(json!(1)),
        SessionId::new("ses_bootstrap").unwrap(),
        extension.clone(),
        Arc::new(Admission::default()),
        Arc::new(|_| true),
        timeout,
    );
    bridge
        .receive(
            protocol::decode_client(
                json!({"type":"profile_access","enabled":true})
                    .to_string()
                    .as_bytes(),
            )
            .unwrap(),
        )
        .unwrap();
    bridge.receive(protocol::decode_client(json!({"type":"shared","mode":"profile","tabID":"btab_test","title":"Fixture","url":"https://example.test/form?secret=hidden","documentGeneration":1,"active":true}).to_string().as_bytes()).unwrap()).unwrap();
    (bridge, extension)
}
fn observe(session: &str, call: &str) -> browser::ObserveInput {
    decode(json!({"sessionID":session,"tabID":"btab_test","generation":1,"callID":call}))
}
fn click(session: &str, call: &str) -> browser::ActionInput {
    decode(
        json!({"sessionID":session,"tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":1,"callID":call,"action":{"type":"click","ref":"b1"}}),
    )
}
async fn observation(bridge: &Arc<Bridge>, extension: &Arc<Extension>, session: &str, call: &str) {
    let task = tokio::spawn({
        let bridge = bridge.clone();
        let input = observe(session, call);
        async move { bridge.observe(input).await }
    });
    extension.notice.notified().await;
    bridge.receive(protocol::decode_client(json!({"type":"observation","callID":call,"tabID":"btab_test","generation":1,"documentGeneration":1,"revision":1,"title":"Fixture","url":"https://example.test/form?hidden=value","elements":[{"ref":"b1","role":"link","name":"Go","destination":"https://other.test/arrive?secret=hidden"}],"truncated":false}).to_string().as_bytes()).unwrap()).unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn tab_lease_and_every_fence_are_checked_before_transport_dispatch() {
    let (bridge, extension) = setup(Duration::from_secs(1));
    observation(&bridge, &extension, "ses_a", "observe").await;
    assert_eq!(
        bridge.list(&SessionId::new("ses_b").unwrap()).unwrap()[0].lease,
        Some(browser::Lease::Other)
    );
    assert!(bridge.observe(observe("ses_b", "foreign")).await.is_err());
    for field in ["generation", "documentGeneration", "observationRevision"] {
        let mut input = json!({"sessionID":"ses_a","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":1,"callID":field,"action":{"type":"click","ref":"b1"}});
        input[field] = json!(2);
        assert!(bridge.action(decode(input)).await.is_err());
    }
    assert_eq!(extension.outbox.lock().unwrap().len(), 1);
    assert!(
        !stringify_json(&bridge.list(&SessionId::new("ses_a").unwrap()).unwrap()[0].encode())
            .contains("secret")
    );
}

#[tokio::test]
async fn successful_action_invalidates_semantic_refs_and_exact_retry_never_replays() {
    let (bridge, extension) = setup(Duration::from_secs(1));
    observation(&bridge, &extension, "ses_a", "observe").await;
    let input = click("ses_a", "click");
    let task = tokio::spawn({
        let bridge = bridge.clone();
        let input = input.clone();
        async move { bridge.action(input).await }
    });
    extension.notice.notified().await;
    bridge.receive(protocol::decode_client(json!({"type":"result","callID":"click","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":1,"status":"completed","title":"Fixture","url":"https://example.test/form"}).to_string().as_bytes()).unwrap()).unwrap();
    let result = task.await.unwrap().unwrap();
    assert_eq!(result.status, browser::ResultStatus::Completed);
    assert!(!stringify_json(&result.encode()).contains("\"input\""));
    assert_eq!(bridge.action(input.clone()).await.unwrap(), result);
    assert!(bridge.action(click("ses_a", "new-click")).await.is_err());
    let mut conflict = input;
    conflict.action = decode(json!({"type":"scroll","deltaY":120}));
    assert!(bridge.action(conflict).await.is_err());
    assert_eq!(extension.outbox.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn timed_out_mutation_is_uncertain_and_cannot_be_replayed_or_resumed_pending() {
    let (bridge, extension) = setup(Duration::from_millis(1));
    observation(&bridge, &extension, "ses_a", "observe").await;
    let input = click("ses_a", "lost");
    let result = bridge.action(input.clone()).await.unwrap();
    assert_eq!(result.status, browser::ResultStatus::Uncertain);
    assert_eq!(
        bridge.action(input).await.unwrap().status,
        browser::ResultStatus::Uncertain
    );
    assert!(
        bridge
            .control(&SessionId::new("ses_a").unwrap(), true)
            .is_err()
    );
    assert_eq!(extension.outbox.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn predispatch_rejection_releases_new_lease_and_dispatched_error_remains_uncertain() {
    for dispatched in [false, true] {
        let (bridge, extension) = setup(Duration::from_secs(1));
        observation(&bridge, &extension, "ses_a", "observe").await;
        let input: browser::ActionInput = decode(
            json!({"sessionID":"ses_a","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":1,"callID":"scroll","action":{"type":"navigate","url":"https://example.test/next"}}),
        );
        let task = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.action(input).await }
        });
        extension.notice.notified().await;
        bridge.receive(protocol::decode_client(json!({"type":"error","callID":"scroll","tabID":"btab_test","generation":1,"dispatched":dispatched,"message":"failure"}).to_string().as_bytes()).unwrap()).unwrap();
        assert_eq!(
            task.await.unwrap().unwrap().status,
            if dispatched {
                browser::ResultStatus::Uncertain
            } else {
                browser::ResultStatus::Rejected
            }
        );
    }
}

#[tokio::test]
async fn group_and_ungroup_claim_all_members_or_none() {
    for action in [
        json!({"type":"group","tabIDs":["btab_test","btab_second"],"title":"Docs"}),
        json!({"type":"ungroup","tabIDs":["btab_test","btab_second"],"groupID":17}),
    ] {
        let (bridge, extension) = setup(Duration::from_secs(1));
        bridge.receive(protocol::decode_client(json!({"type":"shared","mode":"profile","tabID":"btab_second","title":"Second","url":"https://example.test/second","documentGeneration":1,"active":false}).to_string().as_bytes()).unwrap()).unwrap();
        let observing = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge.observe(decode(json!({"sessionID":"ses_b","tabID":"btab_second","generation":1,"callID":"observe-second"}))).await
            }
        });
        extension.notice.notified().await;
        bridge.receive(protocol::decode_client(json!({"type":"observation","callID":"observe-second","tabID":"btab_second","generation":1,"documentGeneration":1,"revision":1,"title":"Second","url":"https://example.test/second","elements":[],"truncated":false}).to_string().as_bytes()).unwrap()).unwrap();
        observing.await.unwrap().unwrap();
        let input: browser::ActionInput = decode(
            json!({"sessionID":"ses_a","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":0,"callID":"group","action":action}),
        );
        assert!(matches!(
            bridge.action(input.clone()).await,
            Err(ycoding_core::platform::browser::bridge::Error::Ownership(_))
        ));
        let tabs = bridge.list(&SessionId::new("ses_a").unwrap()).unwrap();
        assert_eq!(
            tabs.iter()
                .find(|tab| tab.id == input.tab_id)
                .unwrap()
                .lease,
            None
        );
        assert_eq!(extension.outbox.lock().unwrap().len(), 1);
        let releasing = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge.release(decode(json!({"sessionID":"ses_b","tabID":"btab_second","generation":1,"callID":"release-second"}))).await
            }
        });
        extension.notice.notified().await;
        bridge.receive(protocol::decode_client(json!({"type":"relinquished","callID":"release-second","tabID":"btab_second","generation":1}).to_string().as_bytes()).unwrap()).unwrap();
        releasing.await.unwrap().unwrap();
        let grouping = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.action(input).await }
        });
        extension.notice.notified().await;
        assert!(
            bridge
                .list(&SessionId::new("ses_b").unwrap())
                .unwrap()
                .iter()
                .all(|tab| tab.lease == Some(browser::Lease::Other))
        );
        bridge.receive(protocol::decode_client(json!({"type":"result","callID":"group","tabID":"btab_test","generation":1,"documentGeneration":1,"observationRevision":0,"status":"completed","title":"Fixture","url":"https://example.test/form","groupID":17}).to_string().as_bytes()).unwrap()).unwrap();
        assert_eq!(grouping.await.unwrap().unwrap().group_id.unwrap().get(), 17);
    }
}
