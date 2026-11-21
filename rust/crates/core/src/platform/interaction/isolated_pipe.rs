use super::{Error, uuid};
use crate::platform::{browser::cdp, process};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
    task::JoinHandle,
};

pub(super) struct Pipe {
    pub client: Arc<cdp::Client>,
    pub cancel: watch::Sender<bool>,
    settled: watch::Receiver<Option<Result<(), Error>>>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}
impl Pipe {
    pub async fn launch(
        executable: &Path,
        mut outer: watch::Receiver<bool>,
    ) -> Result<Arc<Self>, Error> {
        let root = std::env::temp_dir().join(format!("ycoding-interaction-chrome-{}", uuid()?));
        let mut directory = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(&root).map_err(|_| Error("unavailable"))?;
        let mut command = process::Command::new(
            executable.to_string_lossy(),
            [
                "--headless=new".into(),
                format!("--user-data-dir={}", root.display()),
                "--remote-debugging-pipe".into(),
                "--no-first-run".into(),
                "--no-default-browser-check".into(),
                "--disable-extensions".into(),
                "--disable-background-networking".into(),
                "--disable-component-update".into(),
                "--disable-sync".into(),
                "about:blank".into(),
            ],
        );
        command.stdin = process::Input::Ignore;
        command.stdout = process::Output::Ignore;
        command.stderr = process::Output::Ignore;
        command.detached = true;
        command
            .additional_fds
            .insert(3, process::FdDirection::Input);
        command
            .additional_fds
            .insert(4, process::FdDirection::Output);
        let child = process::spawn(command).await;
        let mut child = match child {
            Ok(child) => child,
            Err(_) => {
                tokio::fs::remove_dir_all(&root)
                    .await
                    .map_err(|_| Error("cleanup"))?;
                return Err(Error("unavailable"));
            }
        };
        let mut output = child.take_output().ok_or(Error("unavailable"))?;
        let control = child.control();
        let (wire, bridge) = tokio::io::duplex(8192);
        let (read, write) = tokio::io::split(wire);
        let client = Arc::new(cdp::Client::connect(read, write, Duration::from_secs(5)));
        let (mut outgoing, mut incoming) = tokio::io::split(bridge);
        let writer_control = control.clone();
        let writer = tokio::spawn(async move {
            let mut buffer = [0; 8192];
            loop {
                let count = outgoing.read(&mut buffer).await?;
                if count == 0 {
                    break;
                }
                writer_control.write_fd(3, buffer[..count].to_vec()).await?;
            }
            Ok::<(), std::io::Error>(())
        });
        let reader = tokio::spawn(async move {
            while let Some(chunk) = output.recv().await {
                if chunk.kind == process::StreamKind::Fd(4) {
                    incoming.write_all(&chunk.bytes).await?;
                }
            }
            incoming.shutdown().await
        });
        let (cancel, mut stop) = watch::channel(false);
        let (settle, settled) = watch::channel(None);
        let link = client.clone();
        let ended = cancel.clone();
        let task = tokio::spawn(async move {
            tokio::select! {_=async{let _=stop.wait_for(|v|*v).await;}=>{},_=async{let _=outer.wait_for(|v|*v).await;}=>{},_=link.closed()=>{},_=child.wait()=>{}}
            ended.send_replace(true);
            link.close();
            let mut failure = false;
            if child.is_running()
                && child
                    .kill(process::KillOptions {
                        signal: process::KillSignal::Term,
                        force_kill_after: Some(Duration::from_millis(900)),
                    })
                    .await
                    .is_err()
            {
                failure = true;
            }
            if child.wait().await.is_err()
                || child.reap_group(Duration::from_millis(900)).await.is_err()
            {
                failure = true;
            }
            let _ = control.close_fd(3).await;
            for pump in [reader, writer] {
                pump.abort();
                match pump.await {
                    Ok(Ok(())) => {}
                    Err(e) if e.is_cancelled() => {}
                    Ok(Err(e)) if e.kind() == std::io::ErrorKind::BrokenPipe => {}
                    _ => failure = true,
                }
            }
            if link.shutdown().await.is_err() {
                failure = true;
            }
            if !failure && tokio::fs::remove_dir_all(&root).await.is_err() {
                failure = true;
            }
            settle.send_replace(Some(if failure {
                Err(Error("cleanup"))
            } else {
                Ok(())
            }));
        });
        Ok(Arc::new(Self {
            client,
            cancel,
            settled,
            task: tokio::sync::Mutex::new(Some(task)),
        }))
    }
    pub async fn close(&self) -> Result<(), Error> {
        self.cancel.send_replace(true);
        let result = self
            .settled
            .clone()
            .wait_for(|r| r.is_some())
            .await
            .map_err(|_| Error("cleanup"))?
            .clone()
            .ok_or(Error("cleanup"))?;
        if let Some(task) = self.task.lock().await.take() {
            task.await.map_err(|_| Error("cleanup"))?;
        }
        result
    }
}
impl Drop for Pipe {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}
