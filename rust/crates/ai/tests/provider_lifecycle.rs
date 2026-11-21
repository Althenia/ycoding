use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_ai::{
    auth::{Input, Secret},
    bedrock_auth,
    muse::{Connection, Runtime},
};

#[test]
fn mantle_and_converse_sign_distinct_services_with_the_same_credentials() {
    let credentials = || bedrock_auth::Credentials {
        region: "us-east-1".into(),
        access_key_id: Secret::new("fixture-key"),
        secret_access_key: Secret::new("fixture-secret"),
        session_token: None,
    };
    let sign = |service| {
        bedrock_auth::sigv4_service(Some(credentials()), service, || "20150830T123600Z".into())
            .apply(Input {
                method: "POST",
                url: "https://bedrock-mantle.us-east-1.api.aws/v1/responses",
                body: "{}",
                headers: Default::default(),
            })
            .unwrap()
    };
    let mantle = sign("bedrock-mantle");
    let converse = sign("bedrock");
    assert!(
        mantle["authorization"]
            .to_str()
            .unwrap()
            .contains("/us-east-1/bedrock-mantle/aws4_request")
    );
    assert!(
        converse["authorization"]
            .to_str()
            .unwrap()
            .contains("/us-east-1/bedrock/aws4_request")
    );
    assert_ne!(mantle["authorization"], converse["authorization"]);
    assert!(
        mantle["authorization"].to_str().unwrap().ends_with(
            "Signature=8188aae510b101a25785c83b3082d4d530a79e8e51361c45e9652e6020cb156a"
        )
    );
    assert!(
        converse["authorization"].to_str().unwrap().ends_with(
            "Signature=9ec1f924ef62f4967e7e940b61ed31f8d103f006e923cd27cc7fbd3f94eee0a1"
        )
    );
    assert!(mantle["authorization"].is_sensitive());
    let default = bedrock_auth::sigv4(Some(credentials()), || "20150830T123600Z".into())
        .apply(Input {
            method: "POST",
            url: "https://bedrock-mantle.us-east-1.api.aws/v1/responses",
            body: "{}",
            headers: Default::default(),
        })
        .unwrap();
    assert_eq!(converse, default);
}

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
