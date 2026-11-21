use futures_util::{Sink, SinkExt, StreamExt};
use std::{future::poll_fn, pin::Pin, sync::Arc};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{self, Message},
};
use ycoding_core::dots::conversation::{Connect, ConnectError, Socket, SocketError, SocketFuture};

struct Wire(WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>);
impl Socket for Wire {
    fn ready(&mut self) -> SocketFuture<'_, Result<(), SocketError>> {
        Box::pin(poll_fn(move |context| {
            Pin::new(&mut self.0)
                .poll_ready(context)
                .map(|result| result.map_err(|_| SocketError::Write))
        }))
    }
    fn start_send(&mut self, message: Message) -> Result<(), SocketError> {
        Pin::new(&mut self.0)
            .start_send(message)
            .map_err(|_| SocketError::Write)
    }
    fn flush(&mut self) -> SocketFuture<'_, Result<(), SocketError>> {
        Box::pin(async move { self.0.flush().await.map_err(|_| SocketError::Write) })
    }
    fn next(&mut self) -> SocketFuture<'_, Option<Result<Message, SocketError>>> {
        Box::pin(async move {
            self.0
                .next()
                .await
                .map(|message| message.map_err(|_| SocketError::Read))
        })
    }
}

pub(super) fn connect() -> Connect {
    Arc::new(|request| {
        Box::pin(async move {
            let mut options = tungstenite::protocol::WebSocketConfig::default();
            options.max_message_size = Some(100 * 1024 * 1024);
            options.max_frame_size = Some(100 * 1024 * 1024);
            match tokio_tungstenite::connect_async_with_config(request, Some(options), false).await
            {
                Ok((socket, _)) => Ok(Box::new(Wire(socket)) as Box<dyn Socket>),
                Err(tungstenite::Error::Http(response)) => Err(ConnectError {
                    status: Some(response.status().as_u16()),
                }),
                Err(_) => Err(ConnectError { status: None }),
            }
        })
    })
}
