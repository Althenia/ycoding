#![cfg(unix)]
use std::{path::PathBuf, time::Duration};
use ycoding_core::platform::pty::{Delivery, Event, Pty};
use ycoding_schema::{
    DomainDecode, JsonValue, parse_json,
    pty::{self, Access, Actor, ControlAction, CreateInput, Size},
    schema::PositiveInt,
    session_id::SessionId,
};
fn session(id: &str) -> SessionId {
    SessionId::new(id).unwrap()
}
fn create(command: &str, retained: u64) -> CreateInput {
    let mut value = match parse_json("{\"sessionID\":\"ses_pty_test\",\"command\":\"/bin/sh\",\"cwd\":\"/tmp\",\"maxRuntimeSeconds\":10}").unwrap() { JsonValue::Object(value) => value, _ => unreachable!() };
    value.insert(
        "args".into(),
        JsonValue::Array(vec![
            JsonValue::String("-c".into()),
            JsonValue::String(command.into()),
        ]),
    );
    value.insert(
        "maxRetainedBytes".into(),
        JsonValue::Number(retained as f64),
    );
    CreateInput::decode(&JsonValue::Object(value)).unwrap()
}
async fn until(attachment: &mut ycoding_core::platform::pty::Attachment, needle: &str) -> String {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut text = String::from_utf8_lossy(&attachment.replay.data).into_owned();
        while !text.contains(needle) {
            let delivery = attachment.recv().await.unwrap();
            let Delivery::Chunk(chunk) = delivery else {
                panic!("terminal ended before {needle}")
            };
            text.push_str(&String::from_utf8_lossy(&chunk.data));
        }
        text
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn native_pty_input_resize_exit_and_ownership_fences() {
    let pty = Pty::new(PathBuf::from("/tmp"));
    let info = pty
        .create(
            create(
                "printf READY; read x; stty size; printf '\\nVALUE:%s\\n' \"$x\"",
                2 * 1024 * 1024,
            ),
            None,
        )
        .await
        .unwrap();
    let owner = session("ses_pty_test");
    assert!(pty.get(&info.id, &session("ses_other")).is_err());
    let mut attachment = pty
        .attach(&info.id, &owner, Some(1), 0, Access::Inspect, None)
        .unwrap();
    attachment.activate();
    until(&mut attachment, "READY").await;
    let size = Size {
        rows: PositiveInt::new(31).unwrap(),
        cols: PositiveInt::new(97).unwrap(),
    };
    pty.update(
        &info.id,
        pty::UpdateInput {
            session_id: owner.clone(),
            generation: PositiveInt::new(1).unwrap(),
            expected_fence: PositiveInt::new(1).unwrap(),
            actor: Actor::Agent,
            title: None,
            size: Some(size),
        },
    )
    .await
    .unwrap();
    pty.write(&info.id, &owner, 1, 1, Actor::Agent, "input\n")
        .await
        .unwrap();
    let text = until(&mut attachment, "VALUE:input").await;
    assert!(text.contains("31 97"));
    let final_info = tokio::time::timeout(Duration::from_secs(5), pty.wait(&info.id, &owner))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(final_info.status, pty::Status::Exited);
    assert_eq!(final_info.exit_code.unwrap().get(), 0);
    pty.remove(&info.id, &owner).await.unwrap();
    pty.shutdown().await.unwrap();
}

#[tokio::test]
async fn retained_replay_control_transitions_and_stale_writer_rejection() {
    let pty = Pty::new(PathBuf::from("/tmp"));
    let info = pty
        .create(
            create("printf 0123456789READY; read x; printf END; read x", 8),
            None,
        )
        .await
        .unwrap();
    let owner = session("ses_pty_test");
    let mut initial = pty
        .attach(&info.id, &owner, Some(1), 0, Access::Inspect, None)
        .unwrap();
    initial.activate();
    until(&mut initial, "READY").await;
    let current = pty.get(&info.id, &owner).unwrap();
    assert!(current.output.start_offset.get() > 0 && current.output.truncated);
    let replay = pty
        .attach(
            &info.id,
            &owner,
            Some(1),
            current.output.start_offset.get() as u64,
            Access::Inspect,
            None,
        )
        .unwrap();
    assert_eq!(replay.replay.data.len(), 8);
    let gap = pty
        .attach(&info.id, &owner, Some(1), 0, Access::Inspect, None)
        .unwrap();
    assert!(gap.replay.gap && gap.replay.data.is_empty());
    let input = |action, fence| pty::ControlInput {
        session_id: owner.clone(),
        generation: PositiveInt::new(1).unwrap(),
        expected_fence: PositiveInt::new(fence).unwrap(),
        action,
    };
    pty.control(&info.id, input(ControlAction::Take, 1))
        .unwrap();
    assert!(
        pty.write(&info.id, &owner, 1, 1, Actor::Agent, "forbidden")
            .await
            .is_err()
    );
    let mut writer = pty
        .attach(
            &info.id,
            &owner,
            Some(1),
            current.output.end_offset.get() as u64,
            Access::Control,
            Some(2),
        )
        .unwrap();
    writer.activate();
    assert!(writer.write("one\n").await.unwrap());
    until(&mut writer, "END").await;
    pty.control(&info.id, input(ControlAction::Pause, 2))
        .unwrap();
    assert!(!writer.write("forbidden").await.unwrap());
    pty.control(&info.id, input(ControlAction::Agent, 3))
        .unwrap();
    assert!(
        pty.control(&info.id, input(ControlAction::Agent, 4))
            .is_err()
    );
    assert!(
        pty.write(&info.id, &owner, 1, 4, Actor::Agent, &"x".repeat(65537))
            .await
            .is_err()
    );
    pty.remove(&info.id, &owner).await.unwrap();
    assert!(!ycoding_core::platform::process::is_alive(info.pid.get() as u32).unwrap());
    pty.shutdown().await.unwrap();
}

#[tokio::test]
async fn pty_runtime_limit_can_interrupt_a_backpressured_input_write() {
    let pty = Pty::new(PathBuf::from("/tmp"));
    let mut input = create(
        "stty -icanon -echo; printf READY; exec tail -f /dev/null",
        65536,
    );
    input.max_runtime_seconds = Some(PositiveInt::new(1).unwrap());
    let info = pty.create(input, None).await.unwrap();
    let owner = session("ses_pty_test");
    let mut attachment = pty
        .attach(&info.id, &owner, Some(1), 0, Access::Inspect, None)
        .unwrap();
    attachment.activate();
    until(&mut attachment, "READY").await;
    let result = tokio::time::timeout(
        Duration::from_secs(4),
        pty.write(&info.id, &owner, 1, 1, Actor::Agent, &"x".repeat(65536)),
    )
    .await;
    let exited = tokio::time::timeout(Duration::from_secs(5), pty.wait(&info.id, &owner)).await;
    let shutdown = tokio::time::timeout(Duration::from_secs(5), pty.shutdown()).await;
    assert!(
        result.is_ok(),
        "PTY runtime limit must not wait behind an input write"
    );
    let final_info = exited
        .expect("PTY runtime limit must settle the owned process")
        .unwrap();
    assert_eq!(final_info.status, pty::Status::Exited);
    assert_eq!(final_info.exit_reason, Some(pty::ExitReason::Timeout));
    shutdown
        .expect("PTY shutdown must settle after backpressured input")
        .unwrap();
}

#[tokio::test]
async fn removal_publishes_deleted_without_a_native_exit_notice() {
    let pty = Pty::new(PathBuf::from("/tmp"));
    let mut events = pty.subscribe();
    let info = pty
        .create(create("printf READY; exec tail -f /dev/null", 65536), None)
        .await
        .unwrap();
    let owner = session("ses_pty_test");
    let mut attachment = pty
        .attach(&info.id, &owner, Some(1), 0, Access::Inspect, None)
        .unwrap();
    attachment.activate();
    until(&mut attachment, "READY").await;
    pty.remove(&info.id, &owner).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            assert!(
                !matches!(event, Event::Exited(_)),
                "removal detaches native exit callbacks"
            );
            if matches!(event, Event::Deleted(_)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    pty.shutdown().await.unwrap();
}
