use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use ycoding_core::platform::{browser::cdp::Client, interaction::isolated::Page};
async fn request(server: &mut tokio::io::DuplexStream) -> Option<Value> {
    let mut bytes = vec![];
    loop {
        let byte = server.read_u8().await.ok()?;
        if byte == 0 {
            break;
        }
        bytes.push(byte);
    }
    serde_json::from_slice(&bytes).ok()
}
#[tokio::test]
async fn script_and_code_commands_stay_on_the_approved_top_frame_without_focus() {
    let (wire, mut server) = tokio::io::duplex(262144);
    let (read, write) = tokio::io::split(wire);
    let client = Arc::new(Client::connect(read, write, Duration::from_secs(1)));
    let peer = tokio::spawn(async move {
        let mut navigated = false;
        let mut scripts = 0;
        let mut worlds = 0;
        while let Some(command) = request(&mut server).await {
            let method = command["method"].as_str().unwrap();
            let params = &command["params"];
            assert!(
                !method.contains("Focus")
                    && !method.contains("activate")
                    && !method.contains("bringToFront")
            );
            if method.starts_with("Runtime.")
                || method.starts_with("Page.")
                || method.starts_with("Fetch.")
            {
                assert_eq!(command["sessionId"], "approved-session");
            }
            let result = match method {
                "Target.createBrowserContext" => json!({"browserContextId":"private-context"}),
                "Target.getTargets" => json!({"targetInfos":[]}),
                "Target.createTarget" => {
                    assert_eq!(params["background"], true);
                    json!({"targetId":"approved-target"})
                }
                "Target.attachToTarget" => {
                    assert_eq!(params["targetId"], "approved-target");
                    json!({"sessionId":"approved-session"})
                }
                "Page.getFrameTree" => {
                    json!({"frameTree":{"frame":{"id":"top-frame","loaderId":if navigated{"document"}else{"blank"},"securityOrigin":"https://example.test","url":if navigated{"https://example.test/"}else{"about:blank"}}}})
                }
                "Page.navigate" => {
                    assert_eq!(params["url"], "https://example.test/");
                    navigated = true;
                    json!({"loaderId":"document"})
                }
                "Page.createIsolatedWorld" => {
                    assert_eq!(params["frameId"], "top-frame");
                    assert_ne!(params["grantUniveralAccess"], true);
                    worlds += 1;
                    json!({"executionContextId":7})
                }
                "Page.addScriptToEvaluateOnNewDocument" => {
                    let harden = params["source"].as_str().unwrap();
                    assert!(harden.contains("SecurityError"));
                    assert!(harden.contains("BroadcastChannel"));
                    assert!(harden.contains("cookie"));
                    scripts += 1;
                    json!({"identifier":format!("hardening-{scripts}")})
                }
                "Runtime.evaluate"
                    if params["expression"]
                        .as_str()
                        .is_some_and(|s| s.contains("hardenWorld")) =>
                {
                    json!({"result":{"type":"function","objectId":"dispose-hardening"}})
                }
                "Runtime.evaluate" => {
                    assert_eq!(params["contextId"], 7);
                    assert_eq!(params["replMode"], true);
                    assert_eq!(params["userGesture"], false);
                    json!({"result":{"type":"number","value":42}})
                }
                "Runtime.callFunctionOn"
                    if params["functionDeclaration"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("async function")) =>
                {
                    assert_eq!(params["executionContextId"], 7);
                    assert_eq!(params["userGesture"], false);
                    json!({"result":{"type":"number","value":42}})
                }
                "Runtime.callFunctionOn" => {
                    let operation = &params["arguments"][0]["value"]["operation"];
                    json!({"result":{"value":if operation=="observe"{json!({"elements":[]})}else{json!({"verified":true})}}})
                }
                _ => json!({}),
            };
            server
                .write_all(format!("{}\0", json!({"id":command["id"],"result":result})).as_bytes())
                .await
                .unwrap();
            if method == "Page.navigate" {
                server.write_all(format!("{}\0",json!({"sessionId":"approved-session","method":"Page.lifecycleEvent","params":{"name":"DOMContentLoaded","loaderId":"document"}})).as_bytes()).await.unwrap();
            }
        }
        (scripts, worlds)
    });
    let (_signal, signal) = tokio::sync::watch::channel(false);
    let page = Page::attach(client.clone(), "https://example.test/", signal.clone())
        .await
        .unwrap();
    assert_eq!(page.observe(signal.clone()).await.unwrap()["revision"], 1);
    for mode in ["script", "code", "code"] {
        assert_eq!(
            page.run(
                "lease",
                &json!({"mode":mode,"source":"return 42","timeoutMs":1000}),
                signal.clone()
            )
            .await
            .unwrap()["value"],
            42
        );
    }
    page.close().await.unwrap();
    client.shutdown().await.unwrap();
    let (scripts, worlds) = peer.await.unwrap();
    assert_eq!(scripts, 2);
    assert_eq!(worlds, 3);
}
