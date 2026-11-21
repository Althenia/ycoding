#![cfg(unix)]
use std::{collections::BTreeMap, path::PathBuf, time::Duration};
use ycoding_core::platform::{
    process::{self, Command, RunOptions, StreamKind, Termination},
    sandbox::{Mode, Selection},
};

fn command(text: &str) -> Command {
    {
        let mut command = Command::new("/bin/sh", ["-c", text]);
        command.kill.force_kill_after = Some(Duration::from_secs(3));
        command
    }
}

#[tokio::test]
async fn exits_stdin_environment_and_bounded_output() {
    let mut cmd = command("read x; printf '%s:%s' \"$x\" \"$WP009_TEST\"; printf err >&2; exit 7");
    cmd.env = BTreeMap::from([("WP009_TEST".into(), "value".into())]);
    let result = process::run(
        cmd,
        RunOptions {
            stdin: Some(process::Input::Bytes(b"input\n".to_vec())),
            max_output_bytes: Some(5),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(result.exit.code, Some(7));
    assert_eq!(result.stdout, b"input");
    assert_eq!(result.stderr, b"err");
    assert!(result.stdout_truncated);
    assert!(result.require_success().is_err());
    assert!(result.require_exit_in(&[7]).is_ok());
}

#[tokio::test]
async fn signal_settlement_is_not_a_successful_exit() {
    let mut child = process::spawn(command("kill -TERM $$")).await.unwrap();
    assert_eq!(child.wait().await.unwrap().signal, Some(libc::SIGTERM));
    assert!(
        process::run(command("kill -TERM $$"), RunOptions::default())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn line_stream_filters_empty_lines_preserves_utf8_and_checks_only_explicit_exit_codes() {
    let mut stream = process::run_stream(
        command("printf 'é\\r\\n\\nline\\ntail'; printf why >&2; exit 7"),
        process::StreamOptions::default(),
    )
    .await
    .unwrap();
    let mut lines = Vec::new();
    while let Some(line) = stream.next().await.unwrap() {
        lines.push(line);
    }
    assert_eq!(lines, ["é", "line", "tail"]);
    let mut stream = process::run_stream(
        command("printf 'line\\n'; printf why >&2; exit 7"),
        process::StreamOptions {
            ok_exit_codes: Some(vec![0]),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(stream.next().await.unwrap(), Some("line".into()));
    assert!(stream.next().await.unwrap_err().to_string().contains("why"));
    let result = process::run(
        command("exec tail -f /dev/null"),
        RunOptions {
            timeout: Some(Duration::from_millis(10)),
            ..Default::default()
        },
    )
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn streaming_interleave_cancellation_and_tree_kill() {
    let mut child = process::spawn(command(
        "printf out; read x; printf err >&2; read x; printf end; read x",
    ))
    .await
    .unwrap();
    let mut output = child.take_output().unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap()
            .kind,
        StreamKind::Stdout
    );
    child.write(b"one\n".to_vec()).await.unwrap();
    let chunk = tokio::time::timeout(Duration::from_secs(5), output.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (chunk.kind, chunk.bytes.as_slice()),
        (StreamKind::Stderr, b"err".as_slice())
    );
    child.write(b"two\n".to_vec()).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap()
            .bytes,
        b"end"
    );
    child.terminate(Termination::Cancelled).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .reason,
        Termination::Cancelled
    );
    assert!(process::identity(child.pid()).await.unwrap().is_none());

    let mut child = process::spawn(command("trap '' TERM; /bin/sh -c 'trap \"\" TERM; /bin/sh -c \"trap \\\"\\\" TERM; echo grand:\\$\\$; exec tail -f /dev/null\" & echo child:$$; wait' & wait")).await.unwrap();
    let mut output = child.take_output().unwrap();
    let mut text = String::new();
    let mut pids = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while pids.len() < 2 {
            text.push_str(&String::from_utf8_lossy(
                &output.recv().await.unwrap().bytes,
            ));
            pids = text
                .lines()
                .filter_map(|line| {
                    line.split_once(':')
                        .and_then(|(_, pid)| pid.parse::<u32>().ok())
                })
                .collect();
        }
    })
    .await
    .unwrap();
    child.set_timeout(Duration::from_millis(1)).await.unwrap();
    let exit = tokio::time::timeout(Duration::from_secs(8), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(exit.reason, Termination::Timeout);
    for pid in pids {
        assert!(
            !process::is_alive(pid).unwrap(),
            "descendant {pid} survived tree kill"
        );
    }
}

#[tokio::test]
async fn spawn_failure_and_cwd_error_are_reported() {
    assert!(
        process::spawn(Command::new("/definitely-missing-wp009", [] as [&str; 0]))
            .await
            .is_err()
    );
    let mut cmd = command("printf unreachable");
    cmd.cwd = Some(PathBuf::from("/definitely-missing-wp009"));
    assert!(process::spawn(cmd).await.is_err());
}

#[tokio::test]
async fn spawned_process_owns_a_detached_session_and_group() {
    let mut child = process::spawn(command("exec tail -f /dev/null"))
        .await
        .unwrap();
    let pid = child.pid() as i32;
    let (sid, pgid) = unsafe { (libc::getsid(pid), libc::getpgid(pid)) };
    child.terminate(Termination::Killed).await.unwrap();
    child.wait().await.unwrap();
    assert_eq!(pgid, pid);
    assert_eq!(sid, pid);
}

#[test]
fn sandbox_required_unavailable_rejects_before_spawning() {
    assert!(Selection::prepare(command("printf forbidden"), Mode::Required).is_err());
    let optional = Selection::prepare(command("printf optional"), Mode::Optional).unwrap();
    assert_eq!(optional.warnings.len(), 1);
    let disabled = Selection::prepare(command("printf disabled"), Mode::Disabled).unwrap();
    assert!(disabled.warnings.is_empty());
}

#[tokio::test]
async fn output_backpressure_does_not_prevent_timeout_tree_cleanup() {
    let mut cmd = command("yes wp009-output-pressure");
    cmd.timeout = Duration::from_millis(100);
    let mut child = process::spawn(cmd).await.unwrap();
    let mut output = child.take_output().unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), output.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(!first.bytes.is_empty());
    let identity = process::identity(child.pid()).await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if process::identity(child.pid()).await.unwrap().as_ref() != Some(&identity) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("timeout must reap the root even when output delivery is backpressured");
    while output.recv().await.is_some() {}
    assert_eq!(child.wait().await.unwrap().reason, Termination::Timeout);
}

#[tokio::test]
async fn blocked_stdin_write_does_not_prevent_cancellation() {
    let mut child = process::spawn(command("printf READY; exec tail -f /dev/null"))
        .await
        .unwrap();
    let mut output = child.take_output().unwrap();
    assert_eq!(output.recv().await.unwrap().bytes, b"READY");
    let control = child.control();
    let writer = tokio::spawn(async move { control.write(vec![b'x'; 2 * 1024 * 1024]).await });
    child.set_timeout(Duration::from_millis(10)).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    drop(child);
    let write_result = tokio::time::timeout(Duration::from_secs(5), writer)
        .await
        .unwrap()
        .unwrap();
    assert!(write_result.is_err());
    assert_eq!(
        result
            .expect("blocked stdin must not hold timeout settlement")
            .unwrap()
            .reason,
        Termination::Timeout
    );
}
#[tokio::test]
async fn run_keeps_command_timeout_when_no_run_override_is_supplied() {
    let mut cmd = command("printf ready; exec tail -f /dev/null");
    cmd.timeout = Duration::from_millis(20);
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        process::run(cmd, RunOptions::default()),
    )
    .await;
    assert!(result.is_ok(), "run discarded the command deadline");
    assert!(result.unwrap().is_err());
}
#[tokio::test]
async fn configurable_codex_shutdown_terms_waits_half_second_and_forces_stubborn_child() {
    let mut child = process::spawn(command(
        "trap '' TERM; printf READY; exec tail -f /dev/null",
    ))
    .await
    .unwrap();
    let mut output = child.take_output().unwrap();
    assert_eq!(output.recv().await.unwrap().bytes, b"READY");
    let started = tokio::time::Instant::now();
    let exit = child.shutdown(Duration::from_millis(500)).await.unwrap();
    assert_eq!(exit.signal, Some(libc::SIGKILL));
    assert!(started.elapsed() >= Duration::from_millis(450));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "Codex shutdown used the shell's three-second grace"
    );
}
#[tokio::test]
async fn termination_grants_the_grace_to_group_members_after_the_leader_exits_first() {
    let marker = std::env::temp_dir().join(format!(
        "ycoding-w50-grace-{}-{}",
        std::process::id(),
        line!()
    ));
    let _ = std::fs::remove_file(&marker);
    let mut child = process::spawn(command(&format!(
        "/bin/sh -c \"trap 'sleep 0.5; printf graceful > {}; exit 0' TERM; printf READY; while :; do sleep 0.05; done\" & wait",
        marker.display()
    )))
    .await
    .unwrap();
    let mut output = child.take_output().unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), output.recv())
            .await
            .unwrap()
            .unwrap()
            .bytes,
        b"READY"
    );
    let started = tokio::time::Instant::now();
    child.terminate(Termination::Killed).await.unwrap();
    let exit = tokio::time::timeout(Duration::from_secs(8), child.wait())
        .await
        .unwrap();
    let written = std::fs::read_to_string(&marker);
    let _ = std::fs::remove_file(&marker);
    assert_eq!(exit.unwrap().reason, Termination::Killed);
    assert_eq!(
        written.ok().as_deref(),
        Some("graceful"),
        "a member still handling SIGTERM was killed before the three-second grace"
    );
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn line_stream_strips_only_the_initial_decoder_bom() {
    let mut stream = process::run_stream(
        command(r"printf '\357\273\277first\n\357\273\277second\n'"),
        process::StreamOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(stream.next().await.unwrap(), Some("first".into()));
    assert_eq!(stream.next().await.unwrap(), Some("\u{feff}second".into()));
    assert_eq!(stream.next().await.unwrap(), None);
}
