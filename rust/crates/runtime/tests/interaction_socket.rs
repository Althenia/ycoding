mod support;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{self, Message, client::IntoClientRequest},
};
use ycoding_core::platform::interaction::{Authority, Options, chrome};
use ycoding_runtime::{LocalAuth, standard};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chrome_socket_uses_the_bound_origin_and_exact_extension_admission() {
    let authority = Authority::new(Options::default());
    let profiles = std::env::temp_dir().join(format!(
        "interaction-socket-{}.json",
        ycoding_core::meeting::store::uuid().unwrap()
    ));
    authority
        .mount_platforms(None, profiles.clone())
        .await
        .unwrap();
    let mut services =
        support::services(LocalAuth::with_password("synthetic-local-password"), true);
    services.core.as_mut().unwrap().interaction = Some(authority.clone());
    let server = support::start(services, standard().unwrap()).await;
    let origin = format!("http://{}", server.address());
    let transport = authority.bind_chrome(&origin).unwrap().unwrap();
    assert!(transport.admit(
        &format!("{origin}{}", chrome::CONNECT_PATH),
        &format!("chrome-extension://{}", chrome::EXTENSION_ID),
        "127.0.0.1"
    ));
    assert!(authority.bind_chrome("http://127.0.0.1:1").is_err());
    for origin in [
        None,
        Some("https://example.test"),
        Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop"),
    ] {
        let mut request = format!("ws://{}{}", server.address(), chrome::CONNECT_PATH)
            .into_client_request()
            .unwrap();
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
        }
        let Err(tungstenite::Error::Http(response)) = connect_async(request).await else {
            panic!("forbidden socket expected");
        };
        assert_eq!(response.status().as_u16(), 403);
    }
    let mut request = format!("ws://{}{}", server.address(), chrome::CONNECT_PATH)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "origin",
        format!("chrome-extension://{}", chrome::EXTENSION_ID)
            .parse()
            .unwrap(),
    );
    request
        .headers_mut()
        .insert("x-forwarded-for", "203.0.113.1".parse().unwrap());
    let (mut socket, response) = connect_async(request).await.unwrap();
    assert_eq!(response.status().as_u16(), 101);
    socket.send(Message::Text("{}".into())).await.unwrap();
    let message = tokio::time::timeout(support::WAIT, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Close(Some(frame)) = message else {
        panic!("invalid message must close the channel");
    };
    assert_eq!(u16::from(frame.code), 1008);
    drop(socket);
    server.shutdown().await.unwrap();
    authority.shutdown().await.unwrap();
    assert!(!transport.admit(
        chrome::CONNECT_PATH,
        &format!("chrome-extension://{}", chrome::EXTENSION_ID),
        "127.0.0.1"
    ));
    assert!(!profiles.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn absent_native_helper_never_grants_isolated_consent() {
    let (changes, mut changed) = tokio::sync::mpsc::unbounded_channel();
    let authority = Authority::new(Options {
        changed: Arc::new(move |_, _| {
            let _ = changes.send(());
        }),
        ..Options::default()
    });
    authority
        .mount_platforms(
            None,
            std::env::temp_dir().join("interaction-no-helper-profiles.json"),
        )
        .await
        .unwrap();
    let status = authority
        .request(
            "ses_native_absent",
            ycoding_core::platform::interaction::from_domain(
                &ycoding_core::ycoding_schema::parse_json(
                    r#"{"platform":"chrome","mode":"isolated","url":"https://example.test"}"#,
                )
                .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
    let generation = status["generation"].as_str().unwrap().to_owned();
    tokio::time::timeout(support::WAIT, async {
        loop {
            changed.recv().await.unwrap();
            if authority.status("ses_native_absent")["state"] == "stopped" {
                break;
            }
        }
    })
    .await
    .unwrap();
    authority.shutdown().await.unwrap();
    assert_ne!(authority.status("ses_native_absent")["state"], "active");
    assert!(!generation.is_empty());
}
