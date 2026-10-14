use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_ai::muse::{Connection, Runtime};

#[tokio::test]
async fn muse_prunes_obsolete_generation_keys_without_replacing_current_keys() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let minted = Arc::new(Mutex::new(BTreeMap::new()));
    let observed = minted.clone();
    let endpoint = base.clone();
    let server = tokio::spawn(async move {
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 2048];
            loop {
                let size = socket.read(&mut chunk).await.unwrap();
                assert_ne!(size, 0);
                bytes.extend_from_slice(&chunk[..size]);
                if let Some(end) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let length = String::from_utf8_lossy(&bytes[..end])
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            let token = request
                .lines()
                .find_map(|line| line.strip_prefix("authorization: Bearer "))
                .unwrap()
                .to_owned();
            *observed.lock().unwrap().entry(token.clone()).or_insert(0) += 1;
            let body = serde_json::json!({"api_key":format!("minted-{token}"),"base_url":endpoint})
                .to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let runtime = Runtime::new(format!("{base}/mint")).unwrap();
    let connection = |id: &str, token: &str| {
        Connection::oauth(
            runtime.clone(),
            id.into(),
            token.into(),
            9007199254740991,
            id.into(),
        )
    };
    let old = connection("profile:1", "old");
    let current = connection("profile:2", "current");
    let old_key = old.key_for(100).await.unwrap();
    let current_key = current.key_for(100).await.unwrap();
    runtime.retain_accounts(&["profile:2".into()]).unwrap();
    assert!(Arc::ptr_eq(
        &current_key,
        &current.key_for(101).await.unwrap()
    ));
    assert!(!Arc::ptr_eq(&old_key, &old.key_for(101).await.unwrap()));
    server.await.unwrap();
    assert_eq!(minted.lock().unwrap().get("current"), Some(&1));
    assert_eq!(minted.lock().unwrap().get("old"), Some(&2));
}
