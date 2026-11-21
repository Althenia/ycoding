use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use ycoding_core::platform::browser::{
    capture,
    cdp::{Client, MAX_MESSAGE_BYTES},
};

async fn request(stream: &mut tokio::io::DuplexStream) -> Value {
    let mut bytes = Vec::new();
    loop {
        let byte = stream.read_u8().await.unwrap();
        if byte == 0 {
            break;
        }
        bytes.push(byte);
    }
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn lost_transport_closes_and_rejects_pending_and_future_commands() {
    let (client, mut server) = tokio::io::duplex(4096);
    let (read, write) = tokio::io::split(client);
    let cdp = Client::connect(read, write, Duration::from_secs(1));
    let pending = cdp.send("Browser.getVersion", json!({}), None, None, None);
    let result = tokio::join!(pending, async {
        request(&mut server).await;
        drop(server);
    });
    assert_eq!(result.0.unwrap_err().message, "Chrome control pipe closed");
    tokio::time::timeout(Duration::from_secs(1), cdp.closed())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), cdp.closed())
        .await
        .unwrap();
    assert_eq!(
        cdp.send("Browser.getVersion", json!({}), None, None, None)
            .await
            .unwrap_err()
            .message,
        "Chrome control pipe is closed"
    );
    cdp.shutdown().await.unwrap();
}

#[tokio::test]
async fn canceled_command_late_result_cannot_settle_the_next_command() {
    let (client, mut server) = tokio::io::duplex(4096);
    let (read, write) = tokio::io::split(client);
    let cdp = Client::connect(read, write, Duration::from_secs(1));
    let (cancel, signal) = tokio::sync::watch::channel(false);
    let first = cdp.send("Page.navigate", json!({}), Some("page"), Some(signal), None);
    let (first, id) = tokio::join!(first, async {
        let cmd = request(&mut server).await;
        cancel.send(true).unwrap();
        cmd["id"].clone()
    });
    assert!(first.unwrap_err().cancelled);
    let current = cdp.send("Target.getTargetInfo", json!({}), None, None, None);
    let (result, ()) = tokio::join!(current, async {
        server
            .write_all(format!("{}\0", json!({"id":id,"result":{"late":true}})).as_bytes())
            .await
            .unwrap();
        let next = request(&mut server).await;
        server
            .write_all(
                format!("{}\0", json!({"id":next["id"],"result":{"current":true}})).as_bytes(),
            )
            .await
            .unwrap();
    });
    assert_eq!(result.unwrap(), json!({"current":true}));
    cdp.shutdown().await.unwrap();
}

#[tokio::test]
async fn incomplete_frames_and_command_timeout_are_bounded() {
    let (client, mut server) = tokio::io::duplex(MAX_MESSAGE_BYTES + 1024);
    let (read, write) = tokio::io::split(client);
    let cdp = Client::connect(read, write, Duration::from_secs(1));
    let (result, ()) = tokio::join!(
        cdp.send("Accessibility.getFullAXTree", json!({}), None, None, None),
        async {
            request(&mut server).await;
            server
                .write_all(&vec![b'x'; MAX_MESSAGE_BYTES + 1])
                .await
                .unwrap();
        }
    );
    assert_eq!(
        result.unwrap_err().message,
        "Chrome control message exceeded the configured limit"
    );
    cdp.shutdown().await.unwrap();
    let (client, _server) = tokio::io::duplex(4096);
    let (read, write) = tokio::io::split(client);
    let timed = Client::connect(read, write, Duration::from_millis(1));
    assert_eq!(
        timed
            .send("Page.captureScreenshot", json!({}), None, None, None)
            .await
            .unwrap_err()
            .message,
        "Chrome command timed out: Page.captureScreenshot"
    );
    timed.shutdown().await.unwrap();
}

#[tokio::test]
async fn capture_uses_real_pipe_and_does_not_dispatch_a_password_screenshot() {
    for password in [false, true] {
        let (client, mut server) = tokio::io::duplex(4096);
        let (read, write) = tokio::io::split(client);
        let cdp = Client::connect(read, write, Duration::from_secs(1));
        let (result, count) = tokio::join!(capture::capture_page(&cdp, "page", None), async {
            let inspect = request(&mut server).await;
            assert_eq!(inspect["method"], "DOM.getDocument");
            assert_eq!(inspect["params"], json!({"depth":32,"pierce":true}));
            server.write_all(format!("{}\0", json!({"id":inspect["id"],"result":{"root":{"nodeName":"INPUT","attributes":["type",if password {"password"} else {"text"}]}}})).as_bytes()).await.unwrap();
            if password {
                return 1;
            }
            let screenshot = request(&mut server).await;
            assert_eq!(screenshot["method"], "Page.captureScreenshot");
            server
                .write_all(
                    format!(
                        "{}\0",
                        json!({"id":screenshot["id"],"result":{"data":"AAAA"}})
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            2
        });
        if password {
            assert!(result.is_err());
            assert_eq!(count, 1);
        } else {
            let capture = result.unwrap();
            assert_eq!(capture.data, "AAAA");
            assert_eq!(capture.bytes, 3);
        }
        cdp.shutdown().await.unwrap();
    }
}
