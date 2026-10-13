#![cfg(unix)]
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use ycoding_core::platform::process::{
    self, Command, Input, KillOptions, KillSignal, Output, PipeOptions, PipeSource, RunOptions,
    StreamKind,
};

fn command(text: &str) -> Command {
    Command::new("/bin/sh", ["-c", text])
}

#[tokio::test]
async fn pipelines_preserve_stage_options_and_select_stdout_stderr_or_all() {
    let first = command("printf 'hello world'");
    let second = command("tr 'a-z' 'A-Z'");
    let last = command("tr ' ' '-'");
    let result = process::run(
        first
            .pipe_to(second, PipeOptions::default())
            .pipe_to(last, PipeOptions::default()),
        RunOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(result.stdout, b"HELLO-WORLD");
    for source in [PipeSource::Stderr, PipeSource::All] {
        let pipeline = command("printf stdout; printf stderr >&2").pipe_to(
            command("cat"),
            PipeOptions {
                from: source,
                to: 0,
            },
        );
        let result = process::run(pipeline, RunOptions::default()).await.unwrap();
        assert!(String::from_utf8_lossy(&result.stdout).contains("stderr"));
        assert_eq!(
            String::from_utf8_lossy(&result.stdout).contains("stdout"),
            source == PipeSource::All
        );
    }
    let pipeline = command("printf source").pipe_to(command("cat"), PipeOptions::default());
    assert!(
        process::run(
            pipeline,
            RunOptions {
                stdin: Some(Input::Bytes(vec![])),
                ..Default::default()
            }
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn stdin_streams_on_commands_and_run_options_and_propagates_input_failure() {
    for in_command in [true, false] {
        let (send, receive) = mpsc::channel(2);
        send.send(Ok(b"first".to_vec())).await.unwrap();
        send.send(Ok(b"second".to_vec())).await.unwrap();
        drop(send);
        let mut cmd = command("cat");
        let mut options = RunOptions::default();
        if in_command {
            cmd.stdin = Input::Stream(receive);
        } else {
            options.stdin = Some(Input::Stream(receive));
        }
        assert_eq!(
            process::run(cmd, options).await.unwrap().stdout,
            b"firstsecond"
        );
    }
    let (send, receive) = mpsc::channel(1);
    send.send(Err(std::io::Error::other("input fixture failed")))
        .await
        .unwrap();
    drop(send);
    let error = process::run(
        command("cat"),
        RunOptions {
            stdin: Some(Input::Stream(receive)),
            ..Default::default()
        },
    )
    .await
    .err()
    .unwrap();
    assert!(error.to_string().contains("input fixture failed"));
}

#[tokio::test]
async fn cancellation_is_owned_preaborted_and_stream_safe() {
    let marker = std::env::temp_dir().join(format!("ycoding-wp009-cancel-{}", std::process::id()));
    let (cancel, signal) = watch::channel(true);
    let result = process::run(
        command(&format!("printf forbidden > '{}'", marker.display())),
        RunOptions {
            signal: Some(signal),
            ..Default::default()
        },
    )
    .await;
    let spawned = marker.exists();
    if spawned {
        std::fs::remove_file(&marker).unwrap();
    }
    assert!(result.is_err());
    assert!(!spawned, "preaborted work was spawned");
    drop(cancel);
    let (cancel, signal) = watch::channel(false);
    let worker = tokio::spawn(process::run(
        command(&format!(
            "printf '%s' $$ > '{}'; exec tail -f /dev/null",
            marker.display()
        )),
        RunOptions {
            signal: Some(signal),
            timeout: Some(Duration::from_secs(10)),
            ..Default::default()
        },
    ));
    let pid = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(&marker)
                && let Ok(pid) = text.parse::<u32>()
            {
                break pid;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    std::fs::remove_file(&marker).unwrap();
    assert!(process::is_alive(pid).unwrap());
    cancel.send(true).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(!process::is_alive(pid).unwrap());
    let (cancel, signal) = watch::channel(false);
    let mut stream = process::run_stream(
        command("printf 'READY\n'; exec tail -f /dev/null"),
        process::StreamOptions {
            signal: Some(signal),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(stream.next().await.unwrap(), Some("READY".into()));
    let pid = stream.control().pid();
    cancel.send(true).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .is_err()
    );
    assert!(!process::is_alive(pid).unwrap());
}
#[tokio::test]
async fn shell_routing_descriptions_and_graceful_early_exit_are_observable() {
    let mut cmd = Command::new("printf", ["routed"]);
    cmd.shell = Some(process::ShellRoute::System);
    let result = process::run(cmd, RunOptions::default()).await.unwrap();
    assert_eq!(result.command, "printf routed");
    assert_eq!(result.stdout, b"routed");
    let mut child = process::spawn(command(
        "trap 'printf TERM; exit 0' TERM; /bin/sh -c 'printf READY; exec tail -f /dev/null' & wait",
    ))
    .await
    .unwrap();
    let mut output = child.take_output().unwrap();
    assert_eq!(output.recv().await.unwrap().bytes, b"READY");
    let started = tokio::time::Instant::now();
    let exit = child.shutdown(Duration::from_millis(500)).await.unwrap();
    let mut text = Vec::new();
    while let Some(chunk) = output.recv().await {
        text.extend(chunk.bytes);
    }
    assert_eq!(text, b"TERM");
    assert_eq!(exit.code, Some(0));
    assert_eq!(exit.reason, process::Termination::Killed);
    assert!(started.elapsed() < Duration::from_millis(400));
}

#[tokio::test]
async fn per_command_detach_and_kill_overrides_and_stdio_modes() {
    let mut cmd = command("printf READY; exec tail -f /dev/null");
    cmd.detached = false;
    cmd.kill = KillOptions {
        signal: KillSignal::Kill,
        force_kill_after: None,
    };
    let mut child = process::spawn(cmd).await.unwrap();
    let pid = child.pid() as i32;
    let mut output = child.take_output().unwrap();
    assert_eq!(output.recv().await.unwrap().bytes, b"READY");
    assert_ne!(unsafe { libc::getsid(pid) }, pid);
    child.terminate(process::Termination::Killed).await.unwrap();
    assert_eq!(child.wait().await.unwrap().signal, Some(libc::SIGKILL));
    let mut cmd = command("printf hidden; printf hidden >&2");
    cmd.stdin = Input::Inherit;
    cmd.stdout = Output::Ignore;
    cmd.stderr = Output::Inherit;
    let result = process::run(cmd, RunOptions::default()).await.unwrap();
    assert!(result.stdout.is_empty());
    assert!(result.stderr.is_empty());
}

#[tokio::test]
async fn extra_fds_are_writable_readable_sparse_and_pipeline_targets() {
    let mut cmd = command("read value <&3; printf '%s' \"$value\" >&5; printf ignored >&4");
    cmd.additional_fds.insert(3, process::FdDirection::Input);
    cmd.additional_fds.insert(5, process::FdDirection::Output);
    let mut child = process::spawn(cmd).await.unwrap();
    let mut output = child.take_output().unwrap();
    child
        .control()
        .write_fd(3, b"extra\n".to_vec())
        .await
        .unwrap();
    child.control().close_fd(3).await.unwrap();
    let mut extra = Vec::new();
    while let Some(chunk) = output.recv().await {
        if chunk.kind == StreamKind::Fd(5) {
            extra.extend(chunk.bytes);
        }
    }
    assert_eq!(child.wait().await.unwrap().code, Some(0));
    assert_eq!(extra, b"extra");
    let mut head = command("printf pipe >&3");
    head.additional_fds.insert(3, process::FdDirection::Output);
    let mut tail = command("cat <&4");
    tail.additional_fds.insert(4, process::FdDirection::Input);
    let result = process::run(
        head.pipe_to(
            tail,
            PipeOptions {
                from: PipeSource::Fd(3),
                to: 4,
            },
        ),
        RunOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(result.stdout, b"pipe");
}
