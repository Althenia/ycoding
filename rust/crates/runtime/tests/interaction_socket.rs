mod support;
#[cfg(unix)]
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
#[cfg(unix)]
use std::{net::Ipv4Addr, os::unix::fs::PermissionsExt, path::Path};
#[cfg(unix)]
use tokio::net::TcpListener;
#[cfg(unix)]
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{self, client::IntoClientRequest},
};
#[cfg(unix)]
use ycoding_core::platform::interaction::macos;
use ycoding_core::platform::interaction::{Authority, Options, chrome};
use ycoding_runtime::{LocalAuth, standard};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chrome_socket_is_unavailable_without_native_helper() {
    let authority = Authority::new(Options::default());
    let profiles = std::env::temp_dir().join(format!(
        "interaction-socket-{}.json",
        ycoding_core::meeting::store::uuid().unwrap()
    ));
    authority.mount_platforms(None, profiles).await.unwrap();
    let mut services = support::services(LocalAuth::disabled(), true);
    services.core.as_mut().unwrap().interaction = Some(authority.clone());
    let server = support::start(services, standard().unwrap()).await;
    let mut request = format!("ws://{}{}", server.address(), chrome::CONNECT_PATH)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "origin",
        format!("chrome-extension://{}", chrome::EXTENSION_ID)
            .parse()
            .unwrap(),
    );
    let status = match connect_async(request).await {
        Ok((_, response)) => response.status().as_u16(),
        Err(tungstenite::Error::Http(response)) => response.status().as_u16(),
        Err(error) => panic!("expected an HTTP response: {error}"),
    };
    server.shutdown().await.unwrap();
    authority.shutdown().await.unwrap();
    assert_eq!(status, 503);
}

#[cfg(unix)]
fn synthetic_helper(directory: &Path, ready: bool) -> Arc<macos::Adapter> {
    std::fs::create_dir(directory).unwrap();
    let executable = directory.join("helper");
    std::fs::write(
        &executable,
        r#"#!/bin/sh
while IFS= read -r line; do
    case "$line" in *'"operation":"hello"'*) ;; *) exit 1;; esac
    id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\([0-9]*\).*/\1/p')
    generation=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"generation":"\([^"]*\)".*/\1/p')
    : > "${0%/*}/hello-received" || exit 1
    printf '{"id":%s,"generation":"%s",HELLO_REPLY}\n' "$id" "$generation"
done
"#
        .replace(
            "HELLO_REPLY",
            if ready {
                r#""state":"ok""#
            } else {
                r#""state":"refused","code":"unavailable""#
            },
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    macos::Adapter::new(macos::Options {
        application: directory.join(macos::APPLICATION),
        executable,
        verify: Arc::new(|_, _| Box::pin(async { true })),
    })
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chrome_socket_is_unavailable_when_native_helper_refuses_hello() {
    let authority = Authority::new(Options::default());
    let directory = std::env::temp_dir().join(format!(
        "interaction-socket-{}",
        ycoding_core::meeting::store::uuid().unwrap()
    ));
    let profiles = directory.join("profiles.json");
    let helper = synthetic_helper(&directory, false);
    authority
        .mount_platforms(Some(helper), profiles.clone())
        .await
        .unwrap();
    let mut services = support::services(LocalAuth::disabled(), true);
    services.core.as_mut().unwrap().interaction = Some(authority.clone());
    let server = support::start(services, standard().unwrap()).await;
    let mut request = format!("ws://{}{}", server.address(), chrome::CONNECT_PATH)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "origin",
        format!("chrome-extension://{}", chrome::EXTENSION_ID)
            .parse()
            .unwrap(),
    );
    let status = match connect_async(request).await {
        Ok((_, response)) => response.status().as_u16(),
        Err(tungstenite::Error::Http(response)) => response.status().as_u16(),
        Err(error) => panic!("expected an HTTP response: {error}"),
    };
    server.shutdown().await.unwrap();
    authority.shutdown().await.unwrap();
    let hello_received = directory.join("hello-received").is_file();
    assert!(!profiles.exists());
    std::fs::remove_dir_all(&directory).unwrap();
    assert!(hello_received, "the unready helper must receive hello");
    assert_eq!(status, 503);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chrome_socket_uses_the_bound_origin_and_exact_extension_admission() {
    let authority = Authority::new(Options::default());
    let directory = std::env::temp_dir().join(format!(
        "interaction-socket-{}",
        ycoding_core::meeting::store::uuid().unwrap()
    ));
    let profiles = directory.join("profiles.json");
    let helper = synthetic_helper(&directory, true);
    authority
        .mount_platforms(Some(helper), profiles.clone())
        .await
        .unwrap();
    let mut services =
        support::services(LocalAuth::with_password("synthetic-local-password"), true);
    services.core.as_mut().unwrap().interaction = Some(authority.clone());
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let non_loopback = ycoding_runtime::serve(listener, services.clone())
        .await
        .unwrap();
    let mut request = format!("ws://127.0.0.1:{port}{}", chrome::CONNECT_PATH)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "origin",
        format!("chrome-extension://{}", chrome::EXTENSION_ID)
            .parse()
            .unwrap(),
    );
    let Err(tungstenite::Error::Http(response)) = connect_async(request).await else {
        panic!("the extension route must not mount on a non-loopback listener");
    };
    assert_eq!(response.status().as_u16(), 503);
    non_loopback.shutdown().await.unwrap();
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
    std::fs::remove_dir_all(directory).unwrap();
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
    if !cfg!(unix) {
        assert_eq!(status["state"], "unavailable");
        authority.shutdown().await.unwrap();
        return;
    }
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
