use ycoding_core::{coordination::runtime::TaskOptions, event_feed::Scope};

#[path = "session_support/coordination_admission.rs"]
mod support;
use support::{fixture, id, message, quiesce, send, send_to, trace};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn processing_project_settlement_dispatches_a_dependent_task_on_a_small_stack() {
    let fixture = fixture(["ses_alpha", "ses_next"]).await;
    fixture.coordination.activate(&fixture.group.id).unwrap();
    let runtime = fixture.runtime();
    let subscriber = fixture
        .feed
        .subscribe_types(Scope::Global, &["session.execution.succeeded.1"], || {})
        .unwrap();
    let master = id("ses_master");
    let alpha = id("ses_alpha");
    let next = id("ses_next");
    let dependent = message("msg_dependent");
    fixture
        .script
        .blocking
        .lock()
        .unwrap()
        .insert("ses_alpha".into());
    runtime
        .send_task(
            &master,
            send("Prepare", "msg_predecessor"),
            TaskOptions {
                title: "Prepare".into(),
                dependencies: vec![],
            },
        )
        .await
        .unwrap();
    fixture.script.wait_for_member_start().await;
    runtime
        .send_task(
            &master,
            send_to("ses_next", "Use the result", "msg_dependent"),
            TaskOptions {
                title: "Follow up".into(),
                dependencies: vec![message("msg_predecessor")],
            },
        )
        .await
        .unwrap();
    assert!(fixture.sessions.pending(&dependent).unwrap().is_none());

    fixture.script.release.add_permits(1);
    quiesce(fixture.execution, &alpha).await;
    let completed = subscriber.next().unwrap().expect("predecessor settles");
    let executor = tokio::runtime::Handle::current();
    std::thread::Builder::new()
        .stack_size(384 * 1024)
        .spawn(move || executor.block_on(runtime.handle(&completed.payload)))
        .unwrap()
        .join()
        .unwrap()
        .unwrap();

    quiesce(fixture.execution, &next).await;
    assert_eq!(
        trace(&fixture.sessions, &next),
        ["admitted:msg_dependent", "started", "succeeded"]
    );
    assert!(fixture.sessions.message(&dependent).unwrap().is_some());
    assert_eq!(fixture.script.drains("ses_next"), 1);
    fixture.execution.shutdown().await.unwrap();
}
