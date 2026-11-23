use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU16, Ordering},
    },
    time::Duration,
};
use ycoding_core::platform::interaction::{
    Authority, Options,
    chrome::{CONNECT_PATH, EXTENSION_ID, Peer, Transport},
};
async fn next(receiver: &mut tokio::sync::mpsc::UnboundedReceiver<String>, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame: Value = serde_json::from_str(&receiver.recv().await.unwrap()).unwrap();
            if frame["type"] == kind {
                return frame;
            }
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn enrolled_extension_is_confined_to_the_consented_lease_and_pauses_on_focus_loss() {
    let directory = std::env::temp_dir().join(format!(
        "ycoding-interaction-{}",
        ycoding_core::platform::interaction::uuid().unwrap()
    ));
    let profiles = directory.join("profiles.json");
    let authority = Authority::new(Options::default());
    let confirmations = Arc::new(Mutex::new(Vec::new()));
    let transport = Transport::new(
        &authority,
        "http://127.0.0.1:32123",
        profiles.clone(),
        Arc::new({
            let confirmations = confirmations.clone();
            move |profile, _| {
                confirmations.lock().unwrap().push(profile);
                Box::pin(async { true })
            }
        }),
    )
    .unwrap();
    assert!(!transport.admit(
        CONNECT_PATH,
        &format!("chrome-extension://{EXTENSION_ID}"),
        "192.0.2.1"
    ));
    assert!(!transport.admit(CONNECT_PATH, "https://example.test", "127.0.0.1"));
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let closed = Arc::new(AtomicU16::new(0));
    let marker = closed.clone();
    let channel = Arc::new(
        transport
            .connect(Peer {
                url: CONNECT_PATH.into(),
                origin: format!("chrome-extension://{EXTENSION_ID}"),
                address: "127.0.0.1".into(),
                send: Arc::new(move |frame| send.send(frame).is_ok()),
                close: Arc::new(move |code| {
                    marker.store(code, Ordering::SeqCst);
                }),
            })
            .unwrap(),
    );
    channel
        .receive(
            &json!({"type":"enroll","version":1,"profileID":"P".repeat(43),"profileLabel":"Chrome 152"})
                .to_string(),
        )
        .await;
    let authenticated = next(&mut receive, "authenticated").await;
    assert_eq!(
        *confirmations.lock().unwrap(),
        [json!({"profileLabel":"Chrome 152","matchCode":"MPTP-QR4T"})]
    );
    assert_eq!(authenticated["version"], 1);
    let stored = tokio::fs::read_to_string(&profiles).await.unwrap();
    assert!(!stored.contains(authenticated["credential"].as_str().unwrap()));
    let status = authority
        .request("ses_chrome", json!({"platform":"chrome"}))
        .unwrap();
    let generation = status["generation"].as_str().unwrap();
    let candidate = next(&mut receive, "pending").await["input"].clone();
    let inventory = next(&mut receive, "request").await;
    assert_eq!(inventory["op"], "inventory");
    let target = "10000000-0000-4000-8000-000000000001";
    let lease = "10000000-0000-4000-8000-000000000002";
    channel.receive(&json!({"type":"result","id":inventory["id"],"result":[{"kind":"chrome-tab","id":target,"label":"Fixture","origin":"https://example.test","pathname":"/safe"}]}).to_string()).await;
    tokio::task::yield_now().await;
    let approved = json!({"type":"approved","proof":{"candidateID":candidate["candidateID"],"sessionID":"ses_chrome","targetID":target,"authorization":"native-fixture-proof"}});
    let consent = tokio::spawn({
        let channel = channel.clone();
        async move {
            channel.receive(&approved.to_string()).await;
        }
    });
    let attach = next(&mut receive, "request").await;
    assert_eq!(attach["op"], "attach");
    channel.receive(&json!({"type":"result","id":attach["id"],"result":{"leaseID":lease,"sessionID":"ses_chrome","targetID":target,"pathname":"/safe","epoch":1,"revision":1}}).to_string()).await;
    consent.await.unwrap();
    assert_eq!(authority.status("ses_chrome")["state"], "active");
    let observing = tokio::spawn({
        let authority = authority.clone();
        let generation = generation.to_owned();
        async move { authority.observe("ses_chrome", &generation).await }
    });
    let observation = next(&mut receive, "request").await;
    assert_eq!(observation["input"]["leaseID"], lease);
    assert_eq!(observation["input"]["sessionID"], "ses_chrome");
    assert_eq!(observation["input"]["pathname"], "/safe");
    channel.receive(&json!({"type":"result","id":observation["id"],"result":{"revision":2,"pathname":"/safe","elements":[]}}).to_string()).await;
    assert_eq!(observing.await.unwrap().unwrap()["revision"], 2);
    channel
        .receive(
            &json!({"type":"paused","leaseID":lease,"epoch":1,"reason":"foreground_required"})
                .to_string(),
        )
        .await;
    assert_eq!(authority.status("ses_chrome")["state"], "paused");
    channel
        .receive(&json!({"type":"resumed","leaseID":lease,"epoch":1}).to_string())
        .await;
    assert_eq!(authority.status("ses_chrome")["state"], "active");
    channel.disconnect();
    assert_eq!(authority.status("ses_chrome")["state"], "stopped");
    assert_eq!(closed.load(Ordering::SeqCst), 1008);
    channel.shutdown().await.unwrap();
    transport.close();
    authority.shutdown().await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
