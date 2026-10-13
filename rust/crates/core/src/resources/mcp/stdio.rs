use crate::platform::process::{self, Chunk, Process, StreamKind};
use rmcp::{
    RoleClient,
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    transport::Transport,
};
use std::{io, time::Duration};
use tokio::sync::mpsc;

pub(crate) struct Stdio {
    process: Process,
    output: mpsc::Receiver<Chunk>,
    buffer: Vec<u8>,
}

impl Stdio {
    pub(crate) async fn spawn(command: process::Command) -> io::Result<Self> {
        let mut process = process::spawn(command).await?;
        let output = process
            .take_output()
            .ok_or_else(|| io::Error::other("MCP process has no output pipe"))?;
        Ok(Self {
            process,
            output,
            buffer: Vec::new(),
        })
    }
    pub(crate) fn pid(&self) -> u32 {
        self.process.pid()
    }
}

impl Transport<RoleClient> for Stdio {
    type Error = io::Error;
    fn send(
        &mut self,
        message: ClientJsonRpcMessage,
    ) -> impl Future<Output = io::Result<()>> + Send + 'static {
        let control = self.process.control();
        let bytes = serde_json::to_vec(&message).map(|mut bytes| {
            bytes.push(b'\n');
            bytes
        });
        async move { control.write(bytes.map_err(io::Error::other)?).await }
    }
    async fn receive(&mut self) -> Option<ServerJsonRpcMessage> {
        loop {
            if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let line = self.buffer.drain(..=end).collect::<Vec<_>>();
                if let Ok(message) = serde_json::from_str(&String::from_utf8_lossy(&line)) {
                    return Some(message);
                }
                continue;
            }
            let chunk = self.output.recv().await?;
            if chunk.kind == StreamKind::Stdout {
                self.buffer.extend(chunk.bytes);
            }
        }
    }
    async fn close(&mut self) -> io::Result<()> {
        self.process
            .shutdown(Duration::from_secs(2))
            .await
            .map(|_| ())
    }
}
