use crate::server::Shared;
use axum::{
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, watch};
use ycoding_core::{
    platform::browser::{bridge::Transport, protocol, service},
    ycoding_schema::{JsonPath, JsonValue, LosslessString, ObjectDecoder},
};

const QUEUE: usize = 128;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(1);

enum Outbound {
    Data(String),
    Close(u16, String),
}

struct Extension {
    outbound: mpsc::Sender<Outbound>,
    overflow: watch::Sender<bool>,
}

impl Transport for Extension {
    fn send(&self, message: JsonValue) -> bool {
        let message = protocol::encode_server(&message);
        if message.len() <= protocol::MAX_FRAME_BYTES
            && self.outbound.try_send(Outbound::Data(message)).is_ok()
        {
            return true;
        }
        self.overflow.send_replace(true);
        false
    }

    fn close(&self, code: u16, reason: &str) {
        if self
            .outbound
            .try_send(Outbound::Close(code, reason.into()))
            .is_err()
        {
            self.overflow.send_replace(true);
        }
    }
}

pub async fn upgrade(
    State(shared): State<Arc<Shared>>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(origin) = headers
        .get("origin")
        .and_then(|origin| origin.to_str().ok())
    else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if protocol::extension_id_from_origin(origin).is_none() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(browser) = shared
        .environment
        .services
        .core
        .as_ref()
        .and_then(|core| core.browser.clone())
    else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let origin = origin.to_owned();
    upgrade
        .max_message_size(protocol::MAX_FRAME_BYTES)
        .max_frame_size(protocol::MAX_FRAME_BYTES)
        .on_upgrade(move |socket| run(socket, shared, browser, origin))
}

async fn run(
    mut socket: WebSocket,
    shared: Arc<Shared>,
    browser: Arc<service::Service>,
    origin: String,
) {
    let mut stopped = shared.shutdown.subscribe();
    let first = tokio::select! {
        _ = async { let _ = stopped.wait_for(|stopped| *stopped).await; } => {
            close(&mut socket, 1012, "service shutdown").await;
            return;
        }
        message = tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.recv()) => message.ok().flatten().and_then(Result::ok),
    };
    let Some(handshake) = first.as_ref().and_then(decode).filter(|message| {
        matches!(
            message.kind,
            protocol::Kind::Pair | protocol::Kind::Authenticate
        ) && ObjectDecoder::new(&message.value, &JsonPath::default())
            .and_then(|object| object.field::<LosslessString>("extensionID"))
            .ok()
            .and_then(|extension| extension.to_utf8().ok())
            == protocol::extension_id_from_origin(&origin)
    }) else {
        close(&mut socket, 4400, "authentication required").await;
        return;
    };
    let (outbound, mut incoming) = mpsc::channel(QUEUE);
    let (overflow, mut overflowed) = watch::channel(false);
    let transport = Arc::new(Extension { outbound, overflow });
    let attachment = match browser.attach(&origin, handshake, transport.clone()).await {
        Ok(attachment) => attachment,
        Err(error) => {
            let code = if matches!(
                error,
                ycoding_core::platform::browser::bridge::Error::Busy(_)
            ) {
                4409
            } else {
                4403
            };
            close(&mut socket, code, "authentication rejected").await;
            return;
        }
    };
    loop {
        tokio::select! {
            _ = async { let _ = stopped.wait_for(|stopped| *stopped).await; } => {
                close(&mut socket, 1012, "service shutdown").await;
                break;
            }
            _ = async { let _ = overflowed.wait_for(|overflow| *overflow).await; } => {
                close(&mut socket, 4408, "output overflow").await;
                break;
            }
            outgoing = incoming.recv() => {
                match outgoing {
                    Some(Outbound::Data(message)) => {
                        if !write(&mut socket, Message::Text(message.into())).await { break; }
                    }
                    Some(Outbound::Close(code, reason)) => {
                        close(&mut socket, code, &reason).await;
                        break;
                    }
                    None => break,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Ping(bytes))) => {
                        if !write(&mut socket, Message::Pong(bytes)).await { break; }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                        let valid = decode(&message).filter(|message| !matches!(message.kind, protocol::Kind::Pair | protocol::Kind::Authenticate));
                        if let Some(message) = valid
                            && attachment.receive(message).await.is_ok() {
                            continue;
                        }
                        close(&mut socket, 4400, "invalid frame").await;
                        break;
                    }
                    _ => break,
                }
            }
        }
    }
    attachment.detach();
}

fn decode(message: &Message) -> Option<protocol::ClientMessage> {
    match message {
        Message::Text(text) => protocol::decode_client(text.as_bytes()),
        Message::Binary(bytes) => protocol::decode_client(bytes),
        _ => None,
    }
}

async fn write(socket: &mut WebSocket, message: Message) -> bool {
    tokio::time::timeout(WRITE_TIMEOUT, socket.send(message))
        .await
        .is_ok_and(|result| result.is_ok())
}

async fn close(socket: &mut WebSocket, code: u16, reason: &str) {
    write(
        socket,
        Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_owned().into(),
        })),
    )
    .await;
}
