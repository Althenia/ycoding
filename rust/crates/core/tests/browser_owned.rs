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

fn share_profile(bridge: &Bridge, id: &str) {
    receive(
        bridge,
        json!({"type":"shared","mode":"profile","tabID":id,
        "title":"Fixture","url":"https://example.test/","documentGeneration":1,
        "active":false,"groupID":0}),
    );
}

async fn observe_profile(
    bridge: &Arc<Bridge>,
    frames: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    session: &str,
    id: &str,
    call: &str,
) -> Value {
    let input = decode(json!({"sessionID":session,"tabID":id,"generation":1,"callID":call}));
    let task = tokio::spawn({
        let bridge = bridge.clone();
        async move { bridge.observe(input).await }
    });
    let frame = frames.recv().await.unwrap();
    assert_eq!(frame["controlSessionID"], session);
    assert!(
        frame["controlTabIDs"]
            .as_array()
            .unwrap()
            .contains(&json!(id))
    );
    receive(
        bridge,
        json!({"type":"observation","callID":call,"tabID":id,
        "generation":1,"documentGeneration":1,"revision":1,"title":"Fixture",
        "url":"https://example.test/","elements":[],"truncated":false}),
    );
    task.await.unwrap().unwrap();
    frame
}

fn group_action(kind: &str, ids: Value) -> Value {
    let mut action = json!({"type":kind,"tabIDs":ids});
    if kind == "group" {
        action["title"] = json!("Task");
    } else if kind == "ungroup" {
        action["groupID"] = json!(0);
    }
    action
}

#[tokio::test]
async fn group_actions_claim_every_member_or_none_and_updates_clear_group_identity() {
    for kind in ["group", "ungroup", "group_control"] {
        let (bridge, mut frames) = setup();
        receive(&bridge, json!({"type":"profile_access","enabled":true}));
        for id in ["btab_first", "btab_second", "btab_third"] {
            share_profile(&bridge, id);
        }
        let owner = SessionId::new("ses_owner").unwrap();
        let other = SessionId::new("ses_other").unwrap();
        assert!(
            bridge
                .list(&owner)
                .unwrap()
                .iter()
                .all(|tab| tab.group_id.unwrap().get() == 0)
        );
        observe_profile(&bridge, &mut frames, "ses_owner", "btab_first", "first").await;
        let observed =
            observe_profile(&bridge, &mut frames, "ses_other", "btab_second", "second").await;
        assert_eq!(observed["controlTabIDs"], json!(["btab_second"]));
        let input: browser::ActionInput = decode(json!({"sessionID":"ses_owner",
            "tabID":"btab_first","generation":1,"documentGeneration":1,
            "observationRevision":1,"callID":"group",
            "action":group_action(kind, json!(["btab_first","btab_third","btab_second"]))}));
        assert!(matches!(
            bridge.action(input.clone()).await,
            Err(ycoding_core::platform::browser::bridge::Error::Ownership(_))
        ));
        assert!(frames.try_recv().is_err());
        let unclaimed = bridge
            .list(&owner)
            .unwrap()
            .into_iter()
            .find(|tab| tab.id == decode(json!("btab_third")))
            .unwrap();
        assert_eq!(unclaimed.lease, None);
        let release = tokio::spawn({
            let bridge = bridge.clone();
            async move {
                bridge
                    .release(decode(
                        json!({"sessionID":"ses_other","tabID":"btab_second",
                    "generation":1,"callID":"release"}),
                    ))
                    .await
            }
        });
        assert_eq!(frames.recv().await.unwrap()["type"], "relinquish");
        receive(
            &bridge,
            json!({"type":"relinquished","callID":"release",
            "tabID":"btab_second","generation":1}),
        );
        release.await.unwrap().unwrap();
        let grouping = tokio::spawn({
            let bridge = bridge.clone();
            async move { bridge.action(input).await }
        });
        let frame = frames.recv().await.unwrap();
        assert_eq!(frame["controlSessionID"], "ses_owner");
        assert_eq!(
            frame["controlTabIDs"],
            json!(["btab_first", "btab_second", "btab_third"])
        );
        assert!(
            bridge
                .list(&other)
                .unwrap()
                .iter()
                .all(|tab| tab.lease == Some(browser::Lease::Other))
        );
        receive(
            &bridge,
            json!({"type":"result","callID":"group","tabID":"btab_first",
            "generation":1,"documentGeneration":1,"observationRevision":1,
            "status":"completed","title":"Fixture","url":"https://example.test/","groupID":0}),
        );
        assert_eq!(grouping.await.unwrap().unwrap().group_id.unwrap().get(), 0);
        receive(
            &bridge,
            json!({"type":"updated","tabID":"btab_first","title":"Fixture",
            "url":"https://example.test/","documentGeneration":1}),
        );
        let tabs = bridge.list(&owner).unwrap();
        assert_eq!(
            tabs.iter()
                .find(|tab| tab.id == decode(json!("btab_first")))
                .unwrap()
                .group_id,
            None
        );
        assert_eq!(
            tabs.iter()
                .find(|tab| tab.id == decode(json!("btab_second")))
                .unwrap()
                .group_id
                .unwrap()
                .get(),
            0
        );
    }
}

#[tokio::test]
async fn invalid_group_membership_and_failed_send_leave_unclaimed_members_free() {
    for kind in ["group", "ungroup", "group_control"] {
        let (bridge, mut frames) = setup();
        receive(&bridge, json!({"type":"profile_access","enabled":true}));
        share_profile(&bridge, "btab_first");
        share_profile(&bridge, "btab_second");
        observe_profile(&bridge, &mut frames, "ses_owner", "btab_first", "observe").await;
        for ids in [
            json!(["btab_first", "btab_first"]),
            json!(["btab_second"]),
            json!(["btab_first", "btab_missing"]),
        ] {
            let input = decode(json!({"sessionID":"ses_owner","tabID":"btab_first",
                "generation":1,"documentGeneration":1,"observationRevision":1,
                "callID":"invalid","action":group_action(kind, ids)}));
            assert!(matches!(
                bridge.action(input).await,
                Err(ycoding_core::platform::browser::bridge::Error::Ownership(_))
            ));
            assert!(frames.try_recv().is_err());
        }
        drop(frames);
        let input = decode(json!({"sessionID":"ses_owner","tabID":"btab_first",
            "generation":1,"documentGeneration":1,"observationRevision":1,
            "callID":"failed-send","action":group_action(kind, json!(["btab_first","btab_second"]))}));
        assert!(matches!(
            bridge.action(input).await,
            Err(ycoding_core::platform::browser::bridge::Error::Unavailable(
                _
            ))
        ));
        let owner = SessionId::new("ses_owner").unwrap();
        let tabs = bridge.list(&owner).unwrap();
        assert_eq!(
            tabs.iter()
                .find(|tab| tab.id == decode(json!("btab_first")))
                .unwrap()
                .lease,
            Some(browser::Lease::Self_)
        );
        assert_eq!(
            tabs.iter()
                .find(|tab| tab.id == decode(json!("btab_second")))
                .unwrap()
                .lease,
            None
        );
    }
}

#[tokio::test]
async fn an_extension_rejected_open_is_invalid_without_exposing_page_content_or_replaying() {
    let (bridge, mut frames) = setup();
    let input: browser::OpenInput = decode(
        json!({"sessionID":"ses_owner","generation":1,"url":"https://example.test/redirect","callID":"rejected-open"}),
    );
    let opening = tokio::spawn({
        let bridge = bridge.clone();
        let input = input.clone();
        async move { bridge.open(input).await }
    });
    let request = frames.recv().await.unwrap();
    receive(
        &bridge,
        json!({"type":"error","callID":request["callID"],"tabID":request["tabID"],"generation":request["generation"],"dispatched":false,"message":"synthetic-private-redirect-content"}),
    );
    let error = opening.await.unwrap().unwrap_err();
    assert!(matches!(
        error,
        ycoding_core::platform::browser::bridge::Error::InvalidFrame(_)
    ));
    assert!(
        !error
            .to_string()
            .contains("synthetic-private-redirect-content")
    );
    assert!(
        bridge
            .list(&SessionId::new("ses_owner").unwrap())
            .unwrap()
            .is_empty()
    );
    assert!(bridge.open(input).await.is_err());
    assert!(frames.try_recv().is_err());
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
