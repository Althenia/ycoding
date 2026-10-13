use crate::{
    auth::origin_allowed, convert, dispatch::Invocation, platform_services, server::Shared,
};
use axum::{
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use std::{collections::HashMap, sync::Arc, time::Duration};
use ycoding_core::{
    platform::pty::{
        self,
        protocol::{self, ControlFrame},
        ticket,
    },
    ycoding_schema::{
        pty::{Access, Id},
        session_id::SessionId,
    },
};
use ycoding_protocol::v5;

pub async fn upgrade(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(query) = query(uri.query().unwrap_or("")) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let parsed = parse(&id, &query);
    let Some((mut scope, offset, token)) = parsed else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if scope.directory.is_none() {
        let Some(default) = shared
            .environment
            .services
            .core
            .as_ref()
            .and_then(|core| core.platform_default_location.as_ref())
        else {
            return StatusCode::FORBIDDEN.into_response();
        };
        scope.directory = Some(convert::readable(default.directory.as_lossless()));
        if scope.workspace_id.is_none() {
            scope.workspace_id = default
                .workspace_id
                .as_ref()
                .map(|workspace| convert::readable(workspace.as_lossless()));
        }
    }
    let Some(directory) = scope.directory.as_ref() else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let invocation = Invocation {
        environment: shared.environment.clone(),
        connection_id: shared.next_epoch(),
        scope: v5::Scope {
            target: Some(v5::scope::Target::Location(convert::text(directory))),
        },
        request_id: String::new(),
    };
    let directory = convert::text(directory);
    let workspace = scope.workspace_id.as_deref().map(convert::text);
    let Ok((location, services)) =
        platform_services::resolve(&invocation, Some(&directory), workspace.as_ref())
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    scope.directory = Some(convert::readable(location.directory.as_lossless()));
    scope.workspace_id = location
        .workspace_id
        .as_ref()
        .map(|workspace| convert::readable(workspace.as_lossless()));
    if services.pty.get(&scope.pty_id, &scope.session_id).is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !origin_allowed(&headers, &shared.environment.services.cors)
        || !services
            .tickets
            .lock()
            .is_ok_and(|mut tickets| tickets.consume(&token, &scope))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    upgrade.on_upgrade(move |socket| async move {
        let attachment = services.pty.attach(&scope.pty_id, &scope.session_id, Some(scope.generation), offset, scope.access, scope.fence);
        let mut stopped = shared.shutdown.subscribe();
        let mut socket = socket;
        let mut attachment = match attachment {
            Ok(attachment) => attachment,
            Err(error) => { let code = match error.kind() { std::io::ErrorKind::NotFound | std::io::ErrorKind::BrokenPipe => 4404, std::io::ErrorKind::OutOfMemory => 4408, std::io::ErrorKind::PermissionDenied if error.to_string().contains("fence") => 4409, _ => 4403 }; let _ = close(&mut socket, code).await; return; }
        };
        if replay(&mut socket, &attachment.replay).await.is_err() { return; }
        attachment.activate();
        loop {
            tokio::select! {
                _ = async { let _ = stopped.wait_for(|stopped| *stopped).await; } => {
                    let _ = send(&mut socket, protocol::control_frame(&ControlFrame::End { generation: scope.generation, reason: "service_shutdown".into(), exit_code: None })).await;
                    let _ = close(&mut socket, 1012).await;
                    return;
                }
                message = socket.recv() => {
                    let text = match message {
                        Some(Ok(Message::Binary(bytes))) => protocol::decode_input(&bytes),
                        Some(Ok(Message::Text(text))) => protocol::decode_text_input(&text),
                        Some(Ok(Message::Ping(bytes))) => { if socket.send(Message::Pong(bytes)).await.is_err() { return; } continue; }
                        Some(Ok(Message::Pong(_))) => continue,
                        _ => return,
                    };
                    if let Some(text) = text
                        && !attachment.write(&text).await.unwrap_or(false)
                    {
                        let _ = close(&mut socket, 4409).await; return;
                    }
                }
                delivery = attachment.recv() => {
                    match delivery {
                        Ok(pty::Delivery::Chunk(chunk)) => {
                            if send(&mut socket, protocol::control_frame(&ControlFrame::Chunk { generation: chunk.generation, start_offset: chunk.start_offset, end_offset: chunk.end_offset })).await.is_err() || send(&mut socket, protocol::data_frame(&chunk.data)).await.is_err() { return; }
                        }
                        Ok(pty::Delivery::End(end)) => {
                            let code = if end.reason == "service_shutdown" { 1012 } else if end.reason == "overflow" { 4408 } else { 1000 };
                            let _ = send(&mut socket, protocol::control_frame(&ControlFrame::End { generation: end.generation, reason: end.reason, exit_code: end.exit_code.map(|code| code as u64) })).await;
                            let _ = close(&mut socket, code).await;
                            return;
                        }
                        Err(_) => return,
                    }
                }
            }
        }
    })
}

async fn send(socket: &mut WebSocket, bytes: Vec<u8>) -> Result<(), ()> {
    tokio::time::timeout(
        Duration::from_secs(1),
        socket.send(Message::Binary(bytes.into())),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}
async fn close(socket: &mut WebSocket, code: u16) -> Result<(), ()> {
    tokio::time::timeout(
        Duration::from_secs(1),
        socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: "".into(),
        }))),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}
async fn replay(socket: &mut WebSocket, replay: &pty::Replay) -> Result<(), ()> {
    send(
        socket,
        protocol::control_frame(&ControlFrame::Replay {
            generation: replay.generation,
            start_offset: replay.start_offset,
            end_offset: replay.end_offset,
            gap: replay.gap,
        }),
    )
    .await?;
    for chunk in protocol::chunks(&replay.data, replay.start_offset) {
        send(
            socket,
            protocol::control_frame(&ControlFrame::Chunk {
                generation: replay.generation,
                start_offset: chunk.start_offset,
                end_offset: chunk.end_offset,
            }),
        )
        .await?;
        send(socket, protocol::data_frame(&chunk.data)).await?;
    }
    Ok(())
}

fn parse(id: &str, query: &HashMap<String, String>) -> Option<(ticket::Scope, u64, String)> {
    let pty_id: Id = convert::identifier(&convert::text(id)).ok()?;
    let session_id: SessionId =
        convert::identifier(&convert::text(query.get("sessionID")?)).ok()?;
    let number = |key: &str| {
        let text = query
            .get(key)?
            .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
        let value = if text.is_empty() {
            0.0
        } else if let Some(text) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
            u64::from_str_radix(text, 16).ok()? as f64
        } else if let Some(text) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
            u64::from_str_radix(text, 8).ok()? as f64
        } else if let Some(text) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
            u64::from_str_radix(text, 2).ok()? as f64
        } else {
            text.parse::<f64>().ok()?
        };
        (value.is_finite()
            && value.fract() == 0.0
            && (0.0..=9_007_199_254_740_991.0).contains(&value))
        .then_some(value as u64)
    };
    let generation = number("generation").filter(|value| *value > 0)?;
    let access = match query.get("access")?.as_str() {
        "inspect" => Access::Inspect,
        "control" => Access::Control,
        _ => return None,
    };
    let fence = if query.contains_key("fence") {
        Some(number("fence")?)
    } else {
        None
    };
    if access == Access::Control && fence.is_none_or(|fence| fence == 0) {
        return None;
    }
    let offset = if query.contains_key("offset") {
        number("offset")?
    } else {
        0
    };
    Some((
        ticket::Scope {
            pty_id,
            session_id,
            access,
            generation,
            fence,
            directory: query.get("location[directory]").cloned(),
            workspace_id: query.get("location[workspace]").cloned(),
        },
        offset,
        query.get("ticket")?.clone(),
    ))
}

fn query(input: &str) -> Option<HashMap<String, String>> {
    fn decode(input: &str) -> Option<String> {
        let mut bytes = input.bytes();
        let mut out = Vec::new();
        while let Some(byte) = bytes.next() {
            match byte {
                b'%' => {
                    let high = (bytes.next()? as char).to_digit(16)?;
                    let low = (bytes.next()? as char).to_digit(16)?;
                    out.push((high * 16 + low) as u8);
                }
                b'+' => out.push(b' '),
                byte => out.push(byte),
            }
        }
        String::from_utf8(out).ok()
    }
    let mut query = HashMap::new();
    for pair in input.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        query.entry(decode(key)?).or_insert(decode(value)?);
    }
    Some(query)
}
