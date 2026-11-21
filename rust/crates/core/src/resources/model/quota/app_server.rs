use super::{Error, normalize_codex};
use crate::platform::{filesystem::trim, process};
use crate::resources::catalog::{field, object};
use std::{path::PathBuf, time::Duration};
use ycoding_schema::{DomainEncode, JsonValue, provider, provider_usage::Snapshot};

#[derive(Clone)]
pub struct AppServerCommand {
    pub command: String,
    pub args: Vec<String>,
    pub timeout_ms: Option<f64>,
    pub cwd: Option<PathBuf>,
}
pub async fn load_app_server(
    input: &AppServerCommand,
    provider: provider::Id,
    label: &str,
    now: i64,
) -> Result<Snapshot, Error> {
    let timeout = input.timeout_ms.unwrap_or(5000.0);
    if !timeout.is_finite() {
        return Err(Error::InvalidResponse);
    }
    let timeout = Duration::from_millis(timeout.trunc().clamp(100.0, 30000.0) as u64);
    let mut command = process::Command::new(&input.command, input.args.iter());
    command.cwd = input.cwd.clone();
    command.detached = false;
    let mut child = process::spawn(command).await.map_err(|_| Error::Rpc)?;
    let output = child.take_output().ok_or(Error::Rpc)?;
    let mut process = Process {
        child,
        output,
        buffer: Vec::new(),
        next: 0,
    };
    let result = async {
        process
            .call(
                "initialize",
                Some(object(&[(
                    "clientInfo",
                    object(&[
                        ("name", "ycoding".encode()),
                        ("title", "YCoding".encode()),
                        ("version", "1".encode()),
                    ]),
                )])),
                timeout,
            )
            .await?;
        process
            .write(&object(&[("method", "initialized".encode())]))
            .await?;
        let result = process
            .call("account/rateLimits/read", None, timeout)
            .await?;
        normalize_codex(
            provider,
            label,
            now,
            &result,
            "local_client_rpc",
            "client_contract",
        )
    }
    .await;
    process.close().await?;
    result
}
struct Process {
    child: process::Process,
    output: tokio::sync::mpsc::Receiver<process::Chunk>,
    buffer: Vec<u8>,
    next: u64,
}
impl Process {
    async fn write(&mut self, message: &JsonValue) -> Result<(), Error> {
        self.child
            .write(format!("{}\n", ycoding_schema::stringify_json(message)).into_bytes())
            .await
            .map_err(|_| Error::Rpc)
    }
    async fn call(
        &mut self,
        method: &str,
        params: Option<JsonValue>,
        timeout: Duration,
    ) -> Result<JsonValue, Error> {
        let id = self.next;
        self.next += 1;
        let mut message = object(&[("method", method.encode()), ("id", (id as f64).encode())]);
        if let Some(params) = params {
            super::super::super::catalog::set(&mut message, "params", params);
        }
        tokio::time::timeout(timeout, async {
            self.write(&message).await?;
            loop {
                if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                    let line = self.buffer.drain(..=end).collect::<Vec<_>>();
                    let line = String::from_utf8_lossy(&line);
                    let Ok(message) = ycoding_schema::parse_json(trim(&line)) else {
                        continue;
                    };
                    if field(&message, "id") != Some(&JsonValue::Number(id as f64)) {
                        continue;
                    }
                    if field(&message, "error").is_some() {
                        return Err(Error::Rpc);
                    }
                    return Ok(field(&message, "result")
                        .cloned()
                        .unwrap_or(JsonValue::Null));
                }
                let chunk = self.output.recv().await.ok_or(Error::Rpc)?;
                if chunk.kind != process::StreamKind::Stdout {
                    continue;
                }
                self.buffer.extend_from_slice(&chunk.bytes);
                if String::from_utf8_lossy(&self.buffer).encode_utf16().count() > 1048576 {
                    return Err(Error::BufferLimit);
                }
            }
        })
        .await
        .map_err(|_| Error::Timeout)?
    }
    async fn close(mut self) -> Result<(), Error> {
        let exit = {
            let shutdown = self.child.shutdown_gracefully(Duration::from_millis(500));
            tokio::pin!(shutdown);
            loop {
                tokio::select! {
                    result = &mut shutdown => break result.map_err(|_| Error::Rpc)?,
                    chunk = self.output.recv() => {
                        if chunk.is_none() { break shutdown.await.map_err(|_| Error::Rpc)?; }
                    }
                }
            }
        };
        if exit.is_none() {
            self.child.release().await.map_err(|_| Error::Rpc)?;
        }
        Ok(())
    }
}
