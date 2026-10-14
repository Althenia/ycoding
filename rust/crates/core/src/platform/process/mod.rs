use std::{
    collections::BTreeMap,
    io,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::Instant,
};
#[cfg(unix)]
mod fds;
pub(crate) mod tree;
pub use tree::{identity, is_alive, process_group_memory};
#[derive(Debug)]
pub struct Command {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,
    pub extend_env: bool,
    pub stdin: Input,
    pub stdout: Output,
    pub stderr: Output,
    pub additional_fds: BTreeMap<u32, FdDirection>,
    pipe_from: Option<Box<(Command, PipeOptions)>>,
    pub timeout: Duration,
    pub detached: bool,
    pub kill: KillOptions,
    pub shell: Option<ShellRoute>,
}
impl Command {
    pub fn new(
        program: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: BTreeMap::new(),
            cwd: None,
            extend_env: true,
            stdin: Input::Pipe,
            stdout: Output::Pipe,
            stderr: Output::Pipe,
            additional_fds: BTreeMap::new(),
            pipe_from: None,
            timeout: Duration::ZERO,
            detached: cfg!(unix),
            kill: KillOptions::default(),
            shell: None,
        }
    }
    pub fn pipe_to(self, mut next: Self, options: PipeOptions) -> Self {
        next.pipe_from = Some(Box::new((self, options)));
        next
    }
    pub fn describe(&self) -> String {
        let current = if self.args.is_empty() {
            self.program.clone()
        } else {
            format!("{} {}", self.program, self.args.join(" "))
        };
        match &self.pipe_from {
            Some(left) => format!("{} | {current}", left.0.describe()),
            None => current,
        }
    }
}
#[derive(Debug)]
pub enum ShellRoute {
    System,
    Path(PathBuf),
}
#[derive(Debug, Default)]
pub enum Input {
    #[default]
    Pipe,
    Ignore,
    Inherit,
    Bytes(Vec<u8>),
    Stream(mpsc::Receiver<io::Result<Vec<u8>>>),
}
#[derive(Clone, Copy, Debug, Default)]
pub enum Output {
    #[default]
    Pipe,
    Ignore,
    Inherit,
}
#[derive(Clone, Copy, Debug)]
pub enum FdDirection {
    Input,
    Output,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PipeSource {
    #[default]
    Stdout,
    Stderr,
    All,
    Fd(u32),
}
#[derive(Clone, Copy, Debug, Default)]
pub struct PipeOptions {
    pub from: PipeSource,
    pub to: u32,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KillSignal {
    #[default]
    Term,
    Kill,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct KillOptions {
    pub signal: KillSignal,
    pub force_kill_after: Option<Duration>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    Stdout,
    Stderr,
    Fd(u32),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Termination {
    Exit,
    Timeout,
    MemoryLimit,
    Cancelled,
    Killed,
}
#[derive(Clone, Debug)]
pub struct Exit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub reason: Termination,
}
#[derive(Default)]
pub struct RunOptions {
    pub stdin: Option<Input>,
    pub signal: Option<tokio::sync::watch::Receiver<bool>>,
    pub max_output_bytes: Option<usize>,
    pub max_error_bytes: Option<usize>,
    pub combine_output: bool,
    pub timeout: Option<Duration>,
}
pub struct RunResult {
    pub command: String,
    pub exit: Exit,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub output: Option<Vec<u8>>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub output_truncated: Option<bool>,
}
impl RunResult {
    pub fn require_success(&self) -> std::io::Result<&Self> {
        self.require_exit_in(&[0])
    }
    pub fn require_exit_in(&self, codes: &[i32]) -> std::io::Result<&Self> {
        if self.exit.code.is_some_and(|code| codes.contains(&code)) {
            return Ok(self);
        }
        Err(std::io::Error::other(format!(
            "Command failed{}: {}{}",
            self.exit
                .code
                .map(|code| format!(" (exit {code})"))
                .unwrap_or_default(),
            self.command,
            if self.stderr.is_empty() {
                String::new()
            } else {
                format!(": {}", String::from_utf8_lossy(&self.stderr).trim())
            }
        )))
    }
}
pub struct Chunk {
    pub kind: StreamKind,
    pub bytes: Vec<u8>,
}
enum Request {
    Signal(KillSignal, oneshot::Sender<io::Result<()>>),
    Release(oneshot::Sender<()>),
    Write(Vec<u8>, oneshot::Sender<io::Result<()>>),
    CloseInput(oneshot::Sender<io::Result<()>>),
    Terminate(Termination),
    Timeout(Duration),
    Kill(KillOptions, oneshot::Sender<io::Result<()>>),
    WriteFd(u32, Vec<u8>, oneshot::Sender<io::Result<()>>),
    CloseFd(u32, oneshot::Sender<io::Result<()>>),
}
enum InputRequest {
    Write(u32, Vec<u8>, oneshot::Sender<io::Result<()>>),
    Close(u32, oneshot::Sender<io::Result<()>>),
}
#[derive(Clone)]
pub struct Control {
    running: Arc<AtomicBool>,
    pid: u32,
    sender: mpsc::Sender<Request>,
    detached: bool,
}
impl Control {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }
    pub async fn signal(&self, signal: KillSignal) -> io::Result<()> {
        if !self.is_running() {
            return Ok(());
        }
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Request::Signal(signal, send))
            .await
            .map_err(closed)?;
        receive.await.map_err(closed)?
    }
    pub fn pid(&self) -> u32 {
        self.pid
    }
    pub fn terminate_now(&self) {
        if self.sender.is_closed() {
            return;
        }
        if self
            .sender
            .try_send(Request::Terminate(Termination::Killed))
            .is_err()
        {
            tree::force(self.pid, self.detached);
        }
    }
    pub async fn write(&self, bytes: Vec<u8>) -> io::Result<()> {
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Request::Write(bytes, send))
            .await
            .map_err(closed)?;
        receive.await.map_err(closed)?
    }
    pub async fn close_input(&self) -> io::Result<()> {
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Request::CloseInput(send))
            .await
            .map_err(closed)?;
        receive.await.map_err(closed)?
    }
    pub async fn terminate(&self, reason: Termination) -> io::Result<()> {
        if self.sender.is_closed() {
            return Ok(());
        }
        self.sender
            .send(Request::Terminate(reason))
            .await
            .map_err(closed)
    }
    pub async fn set_timeout(&self, duration: Duration) -> io::Result<()> {
        self.sender
            .send(Request::Timeout(duration))
            .await
            .map_err(closed)
    }
    pub async fn kill(&self, options: KillOptions) -> io::Result<()> {
        if self.sender.is_closed() {
            return Ok(());
        }
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Request::Kill(options, send))
            .await
            .map_err(closed)?;
        receive.await.map_err(closed)?
    }
    pub async fn write_fd(&self, fd: u32, bytes: Vec<u8>) -> io::Result<()> {
        if fd == 0 {
            return self.write(bytes).await;
        }
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Request::WriteFd(fd, bytes, send))
            .await
            .map_err(closed)?;
        receive.await.map_err(closed)?
    }
    pub async fn close_fd(&self, fd: u32) -> io::Result<()> {
        if fd == 0 {
            return self.close_input().await;
        }
        let (send, receive) = oneshot::channel();
        self.sender
            .send(Request::CloseFd(fd, send))
            .await
            .map_err(closed)?;
        receive.await.map_err(closed)?
    }
}
pub struct Process {
    force_on_drop: bool,
    control: Control,
    output: Option<mpsc::Receiver<Chunk>>,
    task: Option<JoinHandle<io::Result<Exit>>>,
    exit: Option<Exit>,
    owned: Vec<Process>,
    pumps: Vec<JoinHandle<io::Result<()>>>,
    cancellation: Option<JoinHandle<()>>,
}
impl Process {
    pub fn is_running(&self) -> bool {
        self.control.is_running()
    }
    pub async fn shutdown_gracefully(&mut self, grace: Duration) -> io::Result<Option<Exit>> {
        if self.is_running() {
            match self.control.close_input().await {
                Ok(()) => (),
                Err(error) if !self.is_running() || error.kind() == io::ErrorKind::BrokenPipe => (),
                Err(error) => return Err(error),
            }
            self.control.signal(KillSignal::Term).await?;
        }
        match tokio::time::timeout(grace, self.wait()).await {
            Ok(exit) => exit.map(Some),
            Err(_) => Ok(None),
        }
    }
    // Reaps descendants a leader left behind after it exited and was joined.
    pub async fn reap_group(&self, grace: Duration) -> io::Result<()> {
        tree::sweep(self.control.pid, grace, self.control.detached).await
    }
    pub async fn release(mut self) -> io::Result<()> {
        if self.task.is_some() && !self.control.sender.is_closed() {
            let (send, receive) = oneshot::channel();
            self.control
                .sender
                .send(Request::Release(send))
                .await
                .map_err(closed)?;
            receive.await.map_err(closed)?;
        }
        self.force_on_drop = false;
        Ok(())
    }
    pub fn pid(&self) -> u32 {
        self.control.pid
    }
    pub fn control(&self) -> Control {
        self.control.clone()
    }
    pub fn take_output(&mut self) -> Option<tokio::sync::mpsc::Receiver<Chunk>> {
        self.output.take()
    }
    pub async fn write(&self, bytes: Vec<u8>) -> io::Result<()> {
        self.control.write(bytes).await
    }
    pub async fn terminate(&self, reason: Termination) -> io::Result<()> {
        self.control.terminate(reason).await
    }
    pub async fn set_timeout(&self, duration: Duration) -> io::Result<()> {
        self.control.set_timeout(duration).await
    }
    pub async fn kill(&mut self, options: KillOptions) -> io::Result<Exit> {
        self.control.kill(options).await?;
        self.wait().await
    }
    pub async fn shutdown(&mut self, grace: Duration) -> io::Result<Exit> {
        if !self.control.sender.is_closed() {
            self.control.close_input().await?;
        }
        self.kill(KillOptions {
            signal: KillSignal::Term,
            force_kill_after: Some(grace),
        })
        .await
    }
    pub async fn wait(&mut self) -> io::Result<Exit> {
        if let Some(exit) = &self.exit {
            return Ok(exit.clone());
        }
        let result = self
            .task
            .as_mut()
            .ok_or_else(|| io::Error::other("Process was already joined"))?
            .await
            .map_err(io::Error::other)?;
        self.task = None;
        let exit = result?;
        for child in &self.owned {
            child.control.terminate(Termination::Cancelled).await?;
        }
        for task in &mut self.pumps {
            if !task.is_finished() {
                task.abort();
            }
            match task.await {
                Ok(result) => result?,
                Err(error) if error.is_cancelled() => (),
                Err(error) => return Err(io::Error::other(error)),
            }
        }
        self.pumps.clear();
        for child in &mut self.owned {
            Box::pin(child.wait()).await?;
        }
        self.owned.clear();
        if let Some(task) = self.cancellation.take() {
            task.abort();
            let _ = task.await;
        }
        self.exit = Some(exit.clone());
        Ok(exit)
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        if let Some(task) = &self.cancellation {
            task.abort();
        }
        for task in &self.pumps {
            task.abort();
        }
        if self.task.is_some() && self.force_on_drop {
            tree::force(self.pid(), self.control.detached);
        }
    }
}

pub async fn spawn(mut command: Command) -> io::Result<Process> {
    let input = std::mem::take(&mut command.stdin);
    let upstream = command.pipe_from.take();
    let upstream = match upstream {
        Some(upstream) => Some((Box::pin(spawn(upstream.0)).await?, upstream.1)),
        None => None,
    };
    command.stdin = match input {
        Input::Ignore => Input::Ignore,
        Input::Inherit => Input::Inherit,
        _ => Input::Pipe,
    };
    if let Some((_, options)) = &upstream {
        if options.to == 0 {
            command.stdin = Input::Pipe;
        } else {
            command
                .additional_fds
                .insert(options.to, FdDirection::Input);
        }
    }
    let mut process = spawn_standard(command).await?;
    if let Some((mut upstream, options)) = upstream {
        let mut output = upstream
            .take_output()
            .ok_or_else(|| io::Error::other("Pipeline output already taken"))?;
        let control = process.control();
        process.pumps.push(tokio::spawn(async move {
            while let Some(chunk) = output.recv().await {
                let selected = match options.from {
                    PipeSource::Stdout => chunk.kind == StreamKind::Stdout,
                    PipeSource::Stderr => chunk.kind == StreamKind::Stderr,
                    PipeSource::All => {
                        matches!(chunk.kind, StreamKind::Stdout | StreamKind::Stderr)
                    }
                    PipeSource::Fd(fd) => chunk.kind == StreamKind::Fd(fd),
                };
                if selected && let Err(error) = control.write_fd(options.to, chunk.bytes).await {
                    if control.sender.is_closed() {
                        return Ok(());
                    }
                    return Err(error);
                }
            }
            if !control.sender.is_closed() {
                control.close_fd(options.to).await?;
            }
            Ok(())
        }));
        process.owned.push(upstream);
    } else if matches!(input, Input::Bytes(_) | Input::Stream(_)) {
        let control = process.control();
        process.pumps.push(tokio::spawn(async move {
            let feed = async {
                match input {
                    Input::Bytes(bytes) => control.write(bytes).await?,
                    Input::Stream(mut stream) => {
                        while let Some(bytes) = stream.recv().await {
                            control.write(bytes?).await?;
                        }
                    }
                    _ => unreachable!("stream input selected"),
                }
                control.close_input().await
            }
            .await;
            if feed.is_err() {
                control.terminate(Termination::Cancelled).await?;
            }
            feed
        }));
    }
    Ok(process)
}

async fn spawn_standard(command: Command) -> io::Result<Process> {
    #[cfg(unix)]
    let extra = fds::prepare(&command.additional_fds)?;
    #[cfg(windows)]
    if !command.additional_fds.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Additional process FDs are unavailable on Windows",
        ));
    }
    let routed = command.shell.as_ref().map(|route| {
        let shell = match route {
            ShellRoute::Path(path) => path.clone(),
            ShellRoute::System => {
                if cfg!(windows) {
                    command
                        .env
                        .get("COMSPEC")
                        .map(PathBuf::from)
                        .or_else(|| {
                            command
                                .extend_env
                                .then(|| std::env::var_os("COMSPEC").map(PathBuf::from))
                                .flatten()
                        })
                        .unwrap_or_else(|| "cmd.exe".into())
                } else {
                    "/bin/sh".into()
                }
            }
        };
        let args = if cfg!(windows)
            && shell
                .file_stem()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("cmd"))
        {
            vec!["/d".into(), "/s".into(), "/c".into(), command.describe()]
        } else {
            vec!["-c".into(), command.describe()]
        };
        (shell, args)
    });
    let mut cmd = tokio::process::Command::new(
        routed
            .as_ref()
            .map_or_else(|| PathBuf::from(&command.program), |route| route.0.clone()),
    );
    cmd.args(routed.as_ref().map_or(&command.args, |route| &route.1))
        .stdin(match command.stdin {
            Input::Inherit => Stdio::inherit(),
            Input::Ignore => Stdio::null(),
            _ => Stdio::piped(),
        })
        .stdout(stdio(command.stdout))
        .stderr(stdio(command.stderr));
    if !command.extend_env {
        cmd.env_clear();
    }
    cmd.envs(&command.env);
    if let Some(cwd) = &command.cwd {
        cmd.current_dir(cwd);
    }
    #[cfg(unix)]
    unsafe {
        let detached = command.detached;
        let child_fds = extra.child;
        cmd.pre_exec(move || {
            if detached && libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            use std::os::fd::AsRawFd;
            for (target, source) in &child_fds {
                if libc::dup2(source.as_raw_fd(), *target) == -1 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    #[cfg(windows)]
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    let mut child = cmd.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("Spawn returned no process ID"))?;
    let (sender, receiver) = mpsc::channel(16);
    let (output, receive) = mpsc::channel(16);
    let control = Control {
        running: Arc::new(AtomicBool::new(true)),
        pid,
        sender,
        detached: command.detached,
    };
    #[cfg(unix)]
    let parents = extra.parent;
    let mut inputs: BTreeMap<u32, Box<dyn tokio::io::AsyncWrite + Unpin + Send>> = BTreeMap::new();
    let mut readers: Vec<JoinHandle<io::Result<()>>> = Vec::new();
    #[cfg(unix)]
    for (fd, (direction, stream)) in parents {
        match direction {
            FdDirection::Input => {
                inputs.insert(fd, Box::new(stream));
            }
            FdDirection::Output => {
                let output = output.clone();
                let control = control.clone();
                readers.push(tokio::spawn(async move {
                    let result = read_fd(stream, fd, output).await;
                    if result.is_err() {
                        control.terminate(Termination::Cancelled).await?;
                    }
                    result
                }));
            }
        }
    }
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let running = control.running.clone();
    let task = tokio::spawn(async move {
        let root = supervise(
            child,
            Streams {
                stdin,
                stdout,
                stderr,
                inputs,
            },
            receiver,
            output,
            Settings {
                running,
                timeout: command.timeout,
                kill: command.kill,
                detached: command.detached,
            },
        );
        let extra = async {
            for task in readers {
                task.await.map_err(io::Error::other)??;
            }
            Ok::<_, io::Error>(())
        };
        let (root, extra) = tokio::join!(root, extra);
        extra?;
        root
    });
    Ok(Process {
        force_on_drop: true,
        control,
        output: Some(receive),
        task: Some(task),
        exit: None,
        owned: Vec::new(),
        pumps: Vec::new(),
        cancellation: None,
    })
}

struct Streams {
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    inputs: BTreeMap<u32, Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
}
struct Settings {
    running: Arc<AtomicBool>,
    timeout: Duration,
    kill: KillOptions,
    detached: bool,
}
async fn supervise(
    mut child: tokio::process::Child,
    streams: Streams,
    mut requests: mpsc::Receiver<Request>,
    output: mpsc::Sender<Chunk>,
    settings: Settings,
) -> io::Result<Exit> {
    let mut stdout = streams.stdout;
    let mut stderr = streams.stderr;
    let mut inputs = streams.inputs;
    if let Some(stdin) = streams.stdin {
        inputs.insert(0, Box::new(stdin));
    }
    let kill = settings.kill;
    let detached = settings.detached;
    let (input, mut input_requests) = mpsc::channel(16);
    let input_task = tokio::spawn(async move {
        while let Some(request) = input_requests.recv().await {
            match request {
                InputRequest::Write(fd, bytes, reply) => {
                    let result = match inputs.get_mut(&fd) {
                        Some(stdin) => stdin.write_all(&bytes).await,
                        None if fd != 0 => Ok(()),
                        None => Err(io::Error::new(
                            io::ErrorKind::BrokenPipe,
                            "Process input closed",
                        )),
                    };
                    let _ = reply.send(result);
                }
                InputRequest::Close(fd, reply) => {
                    let result = match inputs.remove(&fd) {
                        Some(mut stdin) => stdin.shutdown().await,
                        None => Ok(()),
                    };
                    let _ = reply.send(result);
                }
            }
        }
    });
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("Missing process ID"))?;
    let mut out = vec![0; 65536];
    let mut err = vec![0; 65536];
    let mut out_open = stdout.is_some();
    let mut err_open = stderr.is_some();
    let mut output = Some(output);
    let mut deadline = (!settings.timeout.is_zero()).then(|| Instant::now() + settings.timeout);
    let mut exit = None;
    let mut reason = Termination::Exit;
    let mut pending = None;
    let mut released = false;
    let result = async {
        while exit.is_none() || out_open || err_open {
            if !out_open && !err_open && pending.is_none() { output = None; }
            if exit.is_some() { settings.running.store(false, Ordering::Release); }
            tokio::select! {
                sent = async { output.as_ref().expect("pending output has a sender").reserve().await }, if pending.is_some() => {
                    match sent {
                        Ok(permit) => { permit.send(pending.take().expect("pending output selected")); }
                        Err(_) => { pending = None; if exit.is_none() && !released { reason = Termination::Cancelled; exit = Some(tree::terminate(&mut child, pid, kill, detached).await?); } }
                    }
                }
                read = async { stdout.as_mut().expect("open stdout").read(&mut out).await }, if out_open && pending.is_none() => {
                    let count = read?;
                    out_open = count != 0;
                    if count != 0 { pending = Some(Chunk { kind: StreamKind::Stdout, bytes: out[..count].to_vec() }); }
                }
                read = async { stderr.as_mut().expect("open stderr").read(&mut err).await }, if err_open && pending.is_none() => {
                    let count = read?;
                    err_open = count != 0;
                    if count != 0 { pending = Some(Chunk { kind: StreamKind::Stderr, bytes: err[..count].to_vec() }); }
                }
                status = child.wait(), if exit.is_none() => { exit = Some(status?); }
                request = requests.recv(), if !released => {
                    match request {
                        Some(Request::Release(reply)) => { released = true; let _ = reply.send(()); }
                        Some(Request::Signal(signal, reply)) => {
                            reason = Termination::Killed;
                            let result = if exit.is_none() { tree::send(pid, signal, detached) } else { Ok(()) };
                            let _ = reply.send(result);
                        }
                        Some(Request::Write(bytes, reply)) => {
                            if let Err(error) = input.try_send(InputRequest::Write(0, bytes, reply)) && let InputRequest::Write(_, _, reply) = error.into_inner() { let _ = reply.send(Err(io::Error::new(io::ErrorKind::WouldBlock, "Process input queue full or closed"))); }
                        }
                        Some(Request::CloseInput(reply)) => {
                            if let Err(error) = input.try_send(InputRequest::Close(0, reply)) && let InputRequest::Close(_, reply) = error.into_inner() { let _ = reply.send(Err(io::Error::new(io::ErrorKind::WouldBlock, "Process input queue full or closed"))); }
                        }
                        Some(Request::WriteFd(fd, bytes, reply)) => {
                            if let Err(error) = input.try_send(InputRequest::Write(fd, bytes, reply)) && let InputRequest::Write(_, _, reply) = error.into_inner() { let _ = reply.send(Err(io::Error::new(io::ErrorKind::WouldBlock, "Process input queue full or closed"))); }
                        }
                        Some(Request::CloseFd(fd, reply)) => {
                            if let Err(error) = input.try_send(InputRequest::Close(fd, reply)) && let InputRequest::Close(_, reply) = error.into_inner() { let _ = reply.send(Err(io::Error::new(io::ErrorKind::WouldBlock, "Process input queue full or closed"))); }
                        }
                        Some(Request::Timeout(duration)) => { deadline = (!duration.is_zero()).then(|| Instant::now() + duration); }
                        Some(Request::Terminate(termination)) => { if exit.is_none() { reason = termination; exit = Some(tree::terminate(&mut child, pid, kill, detached).await?); } }
                        Some(Request::Kill(options, reply)) => {
                            if exit.is_some() { let _ = reply.send(Ok(())); continue; }
                            reason = Termination::Killed;
                            match tree::terminate(&mut child, pid, options, detached).await {
                                Ok(status) => { exit = Some(status); let _ = reply.send(Ok(())); }
                                Err(error) => { let _ = reply.send(Err(io::Error::new(error.kind(), error.to_string()))); return Err(error); }
                            }
                        }
                        None => { if exit.is_none() { reason = Termination::Cancelled; exit = Some(tree::terminate(&mut child, pid, kill, detached).await?); } else { released = true; } }
                    }
                }
                () = async { match deadline { Some(deadline) => tokio::time::sleep_until(deadline).await, None => std::future::pending().await } }, if exit.is_none() => {
                    reason = Termination::Timeout;
                    exit = Some(tree::terminate(&mut child, pid, kill, detached).await?);
                }
            }
        }
        let status = exit.ok_or_else(|| io::Error::other("Missing exit settlement"))?;
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            Ok(Exit { code: status.code(), signal: status.signal(), reason })
        }
        #[cfg(windows)]
        Ok(Exit { code: status.code(), signal: None, reason })
    }.await;
    if result.is_err() && released {
        child.wait().await?;
    }
    if result.is_err() && !released {
        tree::terminate(
            &mut child,
            pid,
            KillOptions {
                signal: KillSignal::Kill,
                force_kill_after: Some(Duration::ZERO),
            },
            detached,
        )
        .await?;
    }
    settings.running.store(false, Ordering::Release);
    input_task.abort();
    if let Err(error) = input_task.await
        && !error.is_cancelled()
    {
        return Err(io::Error::other(error));
    }
    result
}

pub async fn run(mut command: Command, mut options: RunOptions) -> io::Result<RunResult> {
    let description = command.describe();
    if command.pipe_from.is_some() && options.stdin.is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "stdin option only supports a standard command",
        ));
    }
    if let Some(input) = options.stdin.take() {
        command.stdin = input;
    }
    if options
        .signal
        .as_ref()
        .is_some_and(|signal| *signal.borrow())
    {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "Aborted"));
    }
    command.timeout = options.timeout.unwrap_or(command.timeout);
    let mut process = spawn(command).await?;
    process.cancellation = options
        .signal
        .map(|signal| cancel_on(signal, process.control()));
    let mut output = process
        .take_output()
        .ok_or_else(|| io::Error::other("Output already taken"))?;
    let capture = async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut combined = Vec::new();
        let mut stdout_truncated = false;
        let mut stderr_truncated = false;
        let mut combined_truncated = false;
        while let Some(chunk) = output.recv().await {
            if options.combine_output {
                if matches!(chunk.kind, StreamKind::Fd(_)) {
                    continue;
                }
                collect(
                    &mut combined,
                    &chunk.bytes,
                    options.max_output_bytes,
                    &mut combined_truncated,
                );
                continue;
            }
            match chunk.kind {
                StreamKind::Stdout => collect(
                    &mut stdout,
                    &chunk.bytes,
                    options.max_output_bytes,
                    &mut stdout_truncated,
                ),
                StreamKind::Stderr => collect(
                    &mut stderr,
                    &chunk.bytes,
                    options.max_error_bytes,
                    &mut stderr_truncated,
                ),
                StreamKind::Fd(_) => (),
            }
        }
        (
            stdout,
            stderr,
            combined,
            stdout_truncated,
            stderr_truncated,
            combined_truncated,
        )
    };
    let capture = capture.await;
    let exit = process.wait().await?;
    if exit.signal.is_some() || exit.reason != Termination::Exit {
        return Err(io::Error::other(format!(
            "Command interrupted: {:?} (signal {:?})",
            exit.reason, exit.signal
        )));
    }
    Ok(RunResult {
        command: description,
        exit,
        stdout: capture.0,
        stderr: capture.1,
        output: options.combine_output.then_some(capture.2),
        stdout_truncated: capture.3,
        stderr_truncated: capture.4,
        output_truncated: options.combine_output.then_some(capture.5),
    })
}

fn collect(buffer: &mut Vec<u8>, bytes: &[u8], limit: Option<usize>, truncated: &mut bool) {
    let remaining = limit
        .map(|limit| limit.saturating_sub(buffer.len()))
        .unwrap_or(bytes.len());
    buffer.extend_from_slice(&bytes[..remaining.min(bytes.len())]);
    *truncated |= bytes.len() > remaining;
}
fn closed(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, error.to_string())
}

#[derive(Default)]
pub struct StreamOptions {
    pub include_stderr: bool,
    pub ok_exit_codes: Option<Vec<i32>>,
    pub max_error_bytes: Option<usize>,
    pub signal: Option<tokio::sync::watch::Receiver<bool>>,
}
pub struct TextStream {
    process: Process,
    output: mpsc::Receiver<Chunk>,
    options: StreamOptions,
    held: Vec<u8>,
    line: String,
    lines: std::collections::VecDeque<String>,
    stderr: Vec<u8>,
    stderr_truncated: bool,
    ended: bool,
    decoder_started: bool,
}
impl TextStream {
    pub fn control(&self) -> Control {
        self.process.control()
    }
    pub async fn next(&mut self) -> io::Result<Option<String>> {
        loop {
            if let Some(line) = self.lines.pop_front() {
                return Ok(Some(line));
            }
            if self.ended {
                let exit = self.process.wait().await?;
                if exit.signal.is_some() || exit.reason != Termination::Exit {
                    return Err(io::Error::other(format!(
                        "Command interrupted: {:?}",
                        exit.reason
                    )));
                }
                if self.options.ok_exit_codes.as_ref().is_some_and(|codes| {
                    !codes.is_empty() && !exit.code.is_some_and(|code| codes.contains(&code))
                }) {
                    return Err(io::Error::other(format!(
                        "Command failed (exit {:?}): {}",
                        exit.code,
                        String::from_utf8_lossy(&self.stderr)
                    )));
                }
                return Ok(None);
            }
            match self.output.recv().await {
                Some(chunk) => {
                    if matches!(chunk.kind, StreamKind::Fd(_)) {
                        continue;
                    }
                    if chunk.kind == StreamKind::Stderr {
                        collect(
                            &mut self.stderr,
                            &chunk.bytes,
                            self.options.max_error_bytes,
                            &mut self.stderr_truncated,
                        );
                        if !self.options.include_stderr {
                            continue;
                        }
                    }
                    self.held.extend(chunk.bytes);
                    let end = super::shell::paging::page_end(&self.held, self.held.len(), false);
                    let text = String::from_utf8_lossy(&self.held[..end]);
                    if !self.decoder_started && !text.is_empty() {
                        self.decoder_started = true;
                        self.line
                            .push_str(text.strip_prefix('\u{feff}').unwrap_or(&text));
                    } else {
                        self.line.push_str(&text);
                    }
                    self.held.drain(..end);
                    while let Some(end) = self.line.find('\n') {
                        let line = self.line[..end].trim_end_matches('\r').to_owned();
                        self.line.drain(..end + 1);
                        if !line.is_empty() {
                            self.lines.push_back(line);
                        }
                    }
                }
                None => {
                    self.ended = true;
                    self.line.push_str(&String::from_utf8_lossy(&self.held));
                    self.held.clear();
                    if !self.line.is_empty() {
                        self.lines.push_back(std::mem::take(&mut self.line));
                    }
                }
            }
        }
    }
}
pub async fn run_stream(command: Command, options: StreamOptions) -> io::Result<TextStream> {
    if options
        .signal
        .as_ref()
        .is_some_and(|signal| *signal.borrow())
    {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "Aborted"));
    }
    let mut process = spawn(command).await?;
    process.cancellation = options
        .signal
        .clone()
        .map(|signal| cancel_on(signal, process.control()));
    let output = process
        .take_output()
        .ok_or_else(|| io::Error::other("Process output already taken"))?;
    Ok(TextStream {
        process,
        output,
        options,
        held: Vec::new(),
        line: String::new(),
        lines: std::collections::VecDeque::new(),
        stderr: Vec::new(),
        stderr_truncated: false,
        ended: false,
        decoder_started: false,
    })
}
fn stdio(mode: Output) -> Stdio {
    match mode {
        Output::Pipe => Stdio::piped(),
        Output::Ignore => Stdio::null(),
        Output::Inherit => Stdio::inherit(),
    }
}
fn cancel_on(mut signal: tokio::sync::watch::Receiver<bool>, control: Control) -> JoinHandle<()> {
    tokio::spawn(async move {
        while !*signal.borrow() {
            if signal.changed().await.is_err() {
                return;
            }
        }
        let _ = control.terminate(Termination::Cancelled).await;
    })
}
#[cfg(unix)]
async fn read_fd(
    mut stream: tokio::net::UnixStream,
    fd: u32,
    output: mpsc::Sender<Chunk>,
) -> io::Result<()> {
    let mut bytes = vec![0; 65536];
    loop {
        let count = stream.read(&mut bytes).await?;
        if count == 0 {
            return Ok(());
        }
        if output
            .send(Chunk {
                kind: StreamKind::Fd(fd),
                bytes: bytes[..count].to_vec(),
            })
            .await
            .is_err()
        {
            return Ok(());
        }
    }
}
