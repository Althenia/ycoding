mod support;

use futures_util::{SinkExt, StreamExt};
use std::{sync::Arc, time::Duration};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{self, Message, client::IntoClientRequest},
};
use ycoding_core::{
    platform::browser::{admission::Admission, protocol, service},
    resources::credential,
    ycoding_schema::{
        DomainEncode, JsonPath, LosslessString, ObjectDecoder, ObjectEncoder, browser,
        session_id::SessionId,
    },
    ycoding_store::{Metadata, Options, Store, import},
};
use ycoding_runtime::{LocalAuth, Server, standard};

const OWNER: &str = "ses_get";
const EXTENSION: &str = "abcdefghijklmnopabcdefghijklmnop";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Harness {
    _store: Store,
    browser: Arc<service::Service>,
    server: Server,
}

impl Harness {
    async fn start() -> Self {
        let store = Store::disposable(
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
            Metadata::new([93; 16], 1),
        )
        .unwrap();
        let browser = service::Service::new(
            credential::Service::new(store.client()),
            Arc::new(Admission::default()),
            Arc::new(|id| id.as_lossless().as_str() == Some(OWNER)),
            service::Options::default(),
        );
        let mut services =
            support::services(LocalAuth::with_password("synthetic-local-password"), true);
        services.core.as_mut().unwrap().browser = Some(browser.clone());
        Self {
            _store: store,
            browser,
            server: support::start(services, standard().unwrap()).await,
        }
    }

    async fn connect(&self, origin: Option<&str>) -> Result<Socket, u16> {
        let mut request = format!("ws://{}/api/browser/connect", self.server.address())
            .into_client_request()
            .unwrap();
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("origin", origin.parse().unwrap());
        }
        match tokio::time::timeout(support::WAIT, connect_async(request))
            .await
            .unwrap()
        {
            Ok((socket, _)) => Ok(socket),
            Err(tungstenite::Error::Http(response)) => Err(response.status().as_u16()),
            Err(error) => panic!("extension socket upgrade failed: {error}"),
        }
    }

    async fn pair(&self) -> Socket {
        let pairing = self.browser.start(&owner()).await.unwrap();
        let mut socket = self
            .connect(Some(&format!("chrome-extension://{EXTENSION}")))
            .await
            .unwrap();
        let hello = ObjectEncoder::new()
            .field("type", "pair")
            .field("version", &f64::from(protocol::VERSION))
            .field("extensionID", EXTENSION)
            .field("secret", &pairing.secret)
            .finish();
        socket
            .send(Message::Text(protocol::encode_server(&hello).into()))
            .await
            .unwrap();
        let Message::Text(message) = next(&mut socket).await else {
            panic!("missing paired reply")
        };
        let value = ycoding_core::ycoding_schema::parse_json(&message).unwrap();
        let path = JsonPath::default();
        let paired = ObjectDecoder::new(&value, &path).unwrap();
        assert_eq!(
            paired.field::<LosslessString>("type").unwrap(),
            "paired".into()
        );
        assert!(paired.field::<LosslessString>("credential").unwrap().len() >= 32);
        socket
    }
}

fn owner() -> SessionId {
    SessionId::new(OWNER).unwrap()
}

async fn next(socket: &mut Socket) -> Message {
    tokio::time::timeout(support::WAIT, socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

async fn closed(socket: &mut Socket, expected: u16) {
    loop {
        if let Message::Close(frame) = next(socket).await {
            assert_eq!(u16::from(frame.unwrap().code), expected);
            return;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn extension_upgrade_requires_an_exact_chrome_origin() {
    let harness = Harness::start().await;
    for origin in [
        None,
        Some("https://example.invalid"),
        Some("chrome-extension://short"),
        Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop/path"),
    ] {
        assert!(matches!(harness.connect(origin).await, Err(403)));
    }
    harness.server.shutdown().await.unwrap();
    harness.browser.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn extension_pairing_authenticates_without_the_local_api_password_and_shutdown_detaches() {
    let harness = Harness::start().await;
    let mut socket = harness.pair().await;
    socket
        .send(Message::Text(
            r#"{"type":"profile_access","enabled":true}"#.into(),
        ))
        .await
        .unwrap();
    socket.send(Message::Text(r#"{"type":"shared","tabID":"btab_native_socket","mode":"profile","title":"Fixture","url":"https://example.test/form?private=synthetic","documentGeneration":1,"active":false}"#.into())).await.unwrap();
    socket.send(Message::Ping(vec![1].into())).await.unwrap();
    assert!(matches!(next(&mut socket).await, Message::Pong(bytes) if bytes.as_ref() == [1]));
    let status = harness.browser.status(&owner()).unwrap();
    assert_eq!(status.state, browser::BridgeState::Connected);
    assert_eq!(status.profile_granted, Some(true));
    let tabs = harness.browser.list(&owner()).unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].page.path, "/form".into());
    assert!(!protocol::encode_server(&tabs[0].encode()).contains("private=synthetic"));
    let shutdown = tokio::spawn(harness.server.shutdown());
    closed(&mut socket, 1012).await;
    tokio::time::timeout(Duration::from_secs(5), shutdown)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        harness.browser.status(&owner()).unwrap().state,
        browser::BridgeState::Unavailable
    );
    harness.browser.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn extension_handshake_and_later_frames_are_validated() {
    let harness = Harness::start().await;
    let origin = format!("chrome-extension://{EXTENSION}");
    let mut socket = harness.connect(Some(&origin)).await.unwrap();
    socket.send(Message::Text("not-json".into())).await.unwrap();
    closed(&mut socket, 4400).await;
    let mut socket = harness.connect(Some(&origin)).await.unwrap();
    let invalid = ObjectEncoder::new()
        .field("type", "pair")
        .field("version", &f64::from(protocol::VERSION))
        .field("extensionID", EXTENSION)
        .field("secret", &LosslessString::from("x".repeat(64)))
        .finish();
    socket
        .send(Message::Text(protocol::encode_server(&invalid).into()))
        .await
        .unwrap();
    closed(&mut socket, 4403).await;
    let mut socket = harness.pair().await;
    socket
        .send(Message::Text(protocol::encode_server(&invalid).into()))
        .await
        .unwrap();
    closed(&mut socket, 4400).await;
    harness.server.shutdown().await.unwrap();
    harness.browser.shutdown();
}
