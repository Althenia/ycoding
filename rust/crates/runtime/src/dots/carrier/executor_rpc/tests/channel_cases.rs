use super::support::*;
use crate::dots::carrier::executor_rpc::{
    channel::{
        ChannelRpcError, DiagnosticEvent, DiagnosticFailed, DiagnosticObserver, DiagnosticPhase,
        DiagnosticRecord, RpcMethod, RpcOutcome, RunResult,
    },
    control::locked,
    handler::CallOptions,
    types::*,
};
use std::{
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use ycoding_core::ycoding_schema::{JsonValue, stringify_json};

const PID: &str = r#"{"processId":"p1"}"#;
const HANDSHAKE_FRAMES: usize = 3;

fn id_of(response: &JsonValue) -> i64 {
    num_of(at(response, "id")) as i64
}

async fn finished(run: Run) -> Result<RunResult, ChannelRpcError> {
    tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .expect("runner finished in time")
        .expect("runner did not panic")
}

fn records(served: &Served) -> Vec<DiagnosticRecord> {
    locked(&served.diagnostics).clone()
}

#[tokio::test]
async fn a_served_channel_answers_requests_and_reports_counts() {
    let mut served = serve(Backend::new());
    served.peer.handshake().await;
    served.peer.end_input();
    let result = finished(served.run).await.unwrap();
    assert_eq!(
        result,
        RunResult {
            requests: 3,
            responses: 2,
            notifications: 0
        }
    );
}

#[tokio::test]
async fn malformed_frames_do_not_end_the_channel() {
    let mut served = serve(Backend::new());
    served.peer.send_bytes(vec![0xff]);
    let rejected = served.peer.recv().await;
    assert_eq!(id_of(&rejected), -1);
    assert_eq!(error_message(&rejected), "Invalid UTF-8 framing");
    served.peer.handshake().await;
    served.peer.end_input();
    assert!(finished(served.run).await.is_ok());
}

#[tokio::test]
async fn control_requests_are_answered_while_an_ordinary_request_is_blocked() {
    let backend = Backend::new();
    let mut served = serve(backend.clone());
    served.peer.handshake().await;
    backend.gate_reads.store(true, Ordering::SeqCst);
    served.peer.send(&request(10, "process/read", PID));
    eventually(|| backend.reads_entered.load(Ordering::SeqCst) == 1).await;
    served.peer.send(&request(
        11,
        "process/signal",
        r#"{"processId":"p1","signal":"interrupt"}"#,
    ));
    assert_eq!(id_of(&served.peer.recv().await), 11);
    served.peer.send(&request(12, "environment/status", "{}"));
    assert_eq!(id_of(&served.peer.recv().await), 12);
    served.peer.recv_none().await;
    backend.read_gate.add_permits(1);
    assert_eq!(id_of(&served.peer.recv().await), 10);
    served.peer.end_input();
    assert!(finished(served.run).await.is_ok());
}

#[tokio::test]
async fn at_most_sixty_four_ordinary_requests_are_in_flight() {
    let backend = Backend::new();
    let mut served = serve(backend.clone());
    served.peer.handshake().await;
    backend.gate_reads.store(true, Ordering::SeqCst);
    for offset in 0..66 {
        served
            .peer
            .send(&request(100 + offset, "process/read", PID));
    }
    eventually(|| served.peer.consumed.load(Ordering::SeqCst) == HANDSHAKE_FRAMES + 65).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        served.peer.consumed.load(Ordering::SeqCst),
        HANDSHAKE_FRAMES + 65
    );
    assert_eq!(backend.reads_entered.load(Ordering::SeqCst), 1);

    backend.read_gate.add_permits(1);
    assert_eq!(id_of(&served.peer.recv().await), 100);
    eventually(|| served.peer.consumed.load(Ordering::SeqCst) == HANDSHAKE_FRAMES + 66).await;

    backend.read_gate.add_permits(100);
    for offset in 1..66 {
        assert_eq!(id_of(&served.peer.recv().await), 100 + offset);
    }
    served.peer.end_input();
    let result = finished(served.run).await.unwrap();
    assert_eq!(result.requests, (HANDSHAKE_FRAMES + 66) as u64);
    assert_eq!(result.responses, 2 + 66);
}

#[tokio::test]
async fn control_requests_have_their_own_sixty_four_request_cap() {
    let backend = Backend::new();
    let mut served = serve(backend.clone());
    served.peer.handshake().await;
    backend.gate_signals.store(true, Ordering::SeqCst);
    for offset in 0..64 {
        served.peer.send(&request(
            200 + offset,
            "process/signal",
            r#"{"processId":"p1","signal":"interrupt"}"#,
        ));
    }
    eventually(|| backend.signals_entered.load(Ordering::SeqCst) == 1).await;
    served.peer.send(&request(
        300,
        "fs/readFile",
        &format!(r#"{{"path":"{FILE}"}}"#),
    ));
    assert_eq!(id_of(&served.peer.recv().await), 300);
    served.peer.send(&request(
        264,
        "process/signal",
        r#"{"processId":"p1","signal":"interrupt"}"#,
    ));
    eventually(|| served.peer.consumed.load(Ordering::SeqCst) == HANDSHAKE_FRAMES + 64 + 1 + 1)
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(backend.signals_entered.load(Ordering::SeqCst), 1);

    backend.signal_gate.add_permits(65);
    for offset in 0..64 {
        assert_eq!(id_of(&served.peer.recv().await), 200 + offset);
    }
    assert_eq!(id_of(&served.peer.recv().await), 264);
    served.peer.end_input();
    assert!(finished(served.run).await.is_ok());
}

#[tokio::test]
async fn request_ids_may_be_reused_across_requests() {
    let mut served = serve(Backend::new());
    served.peer.handshake().await;
    for _ in 0..2 {
        served.peer.send(&request(5, "environment/status", "{}"));
        let response = served.peer.recv().await;
        assert_eq!(id_of(&response), 5);
        assert_eq!(
            stringify_json(at(&response, "result")),
            r#"{"status":"ready"}"#
        );
    }
    served.peer.end_input();
    assert!(finished(served.run).await.is_ok());
}

#[tokio::test]
async fn in_flight_requests_finish_before_a_closed_input_ends_the_run() {
    let backend = Backend::new();
    let mut served = serve(backend.clone());
    served.peer.handshake().await;
    backend.gate_reads.store(true, Ordering::SeqCst);
    served.peer.send(&request(10, "process/read", PID));
    eventually(|| backend.reads_entered.load(Ordering::SeqCst) == 1).await;
    served.peer.end_input();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!served.run.is_finished());
    backend.read_gate.add_permits(1);
    assert_eq!(id_of(&served.peer.recv().await), 10);
    assert!(finished(served.run).await.is_ok());
}

#[tokio::test]
async fn a_failed_send_ends_the_run_with_a_send_failure() {
    let mut served = serve(Backend::new());
    served.peer.handshake().await;
    served.peer.fail_sends.store(true, Ordering::SeqCst);
    served.peer.send(&request(7, "environment/status", "{}"));
    assert_eq!(
        finished_ref(&mut served).await,
        Err(ChannelRpcError::ChannelSendFailed)
    );
    assert!(
        records(&served)
            .iter()
            .any(|record| record.phase == DiagnosticPhase::Response
                && record.event == DiagnosticEvent::Failed
                && record.method == RpcMethod::EnvironmentStatus
                && record.outcome == Some(RpcOutcome::SendFailed))
    );
}

async fn finished_ref(served: &mut Served) -> Result<RunResult, ChannelRpcError> {
    tokio::time::timeout(Duration::from_secs(5), &mut served.run)
        .await
        .expect("runner finished in time")
        .expect("runner did not panic")
}

#[tokio::test]
async fn an_external_abort_stops_the_run_with_an_abort_error() {
    let backend = Backend::new();
    let mut served = serve(backend.clone());
    served.peer.handshake().await;
    backend.gate_reads.store(true, Ordering::SeqCst);
    served.peer.send(&request(10, "process/read", PID));
    eventually(|| backend.reads_entered.load(Ordering::SeqCst) == 1).await;
    served.external.abort();
    assert_eq!(
        finished_ref(&mut served).await,
        Err(ChannelRpcError::Aborted)
    );
}

#[tokio::test]
async fn a_closed_channel_stops_the_run_cleanly() {
    let backend = Backend::new();
    let mut served = serve(backend.clone());
    served.peer.handshake().await;
    backend.gate_reads.store(true, Ordering::SeqCst);
    served.peer.send(&request(10, "process/read", PID));
    eventually(|| backend.reads_entered.load(Ordering::SeqCst) == 1).await;
    served.peer.close_channel();
    assert!(finished_ref(&mut served).await.is_ok());
}

#[tokio::test]
async fn streamed_bodies_and_process_events_are_counted_as_notifications() {
    let backend = Backend::new();
    let mut served = serve(backend.clone());
    served.peer.handshake().await;
    served.peer.send(&request(
        5,
        "http/request",
        r#"{"method":"GET","url":"https://e.test/","requestId":"r1","streamResponse":true}"#,
    ));
    assert_eq!(id_of(&served.peer.recv().await), 5);
    for seq in 1..=2 {
        let delta = served.peer.recv().await;
        assert_eq!(str_of(at(&delta, "method")), "http/request/bodyDelta");
        assert!(!has(&delta, "id"));
        assert_eq!(num_of(at(at(&delta, "params"), "seq")) as i64, seq);
    }
    let notifier = locked(&backend.init_context).clone().unwrap().notifier;
    notifier
        .process_event(&ProcessEvent::Closed {
            process_id: "p1".into(),
            seq: 9,
        })
        .await
        .unwrap();
    let closed = served.peer.recv().await;
    assert_eq!(
        stringify_json(&closed),
        r#"{"method":"process/closed","params":{"processId":"p1","seq":9}}"#
    );
    served.peer.end_input();
    let result = finished(served.run).await;
    assert_eq!(
        result,
        Ok(RunResult {
            requests: 4,
            responses: 3,
            notifications: 3
        })
    );
}

#[tokio::test]
async fn diagnostics_describe_requests_responses_and_notifications() {
    let backend = Backend::new();
    let mut served = serve(backend.clone());
    served.peer.send(&request(
        1,
        "initialize",
        r#"{"clientName":"c","resumeSessionId":"gone"}"#,
    ));
    assert_eq!(error_code(&served.peer.recv().await), -32600);
    served
        .peer
        .send(&request(2, "initialize", r#"{"clientName":"c"}"#));
    served.peer.recv().await;
    served.peer.send(&notification("initialized"));
    served.peer.send(&request(3, "bogus/method", "{}"));
    assert_eq!(error_code(&served.peer.recv().await), -32601);
    served.peer.end_input();
    let diagnostics = served.diagnostics.clone();
    finished(served.run).await.unwrap();
    let records = locked(&diagnostics).clone();
    let received = |method: RpcMethod, resume: Option<bool>, requests: u64| DiagnosticRecord {
        phase: DiagnosticPhase::Received,
        event: DiagnosticEvent::Observed,
        method,
        outcome: None,
        resume_requested: resume,
        requests: Some(requests),
    };
    let responded = |method: RpcMethod, outcome: RpcOutcome, requests: u64| DiagnosticRecord {
        phase: DiagnosticPhase::Response,
        event: DiagnosticEvent::Completed,
        method,
        outcome: Some(outcome),
        resume_requested: None,
        requests: Some(requests),
    };
    for expected in [
        received(RpcMethod::Initialize, Some(true), 1),
        responded(RpcMethod::Initialize, RpcOutcome::InvalidRequest, 1),
        received(RpcMethod::Initialize, Some(false), 2),
        responded(RpcMethod::Initialize, RpcOutcome::Result, 2),
        received(RpcMethod::Initialized, None, 3),
        received(RpcMethod::Other, None, 4),
        responded(RpcMethod::Other, RpcOutcome::MethodNotFound, 4),
    ] {
        assert!(
            records.contains(&expected),
            "missing {expected:?} in {records:?}"
        );
    }
}

#[tokio::test]
async fn a_failing_diagnostic_observer_fails_the_run_after_it_completes() {
    let diagnostics = Arc::new(Mutex::new(Vec::new()));
    let observer: DiagnosticObserver = Arc::new(
        |_record: DiagnosticRecord| -> Result<(), DiagnosticFailed> { Err(DiagnosticFailed) },
    );
    let mut served = serve_observed(Backend::new(), Some(observer), diagnostics);
    served.peer.handshake().await;
    served.peer.end_input();
    assert_eq!(
        finished(served.run).await,
        Err(ChannelRpcError::ProofJournal)
    );
}

#[tokio::test]
async fn server_initiated_calls_complete_through_the_channel() {
    let backend = Backend::new();
    let mut served = serve(backend.clone());
    served.peer.handshake().await;
    let caller = locked(&backend.init_context).clone().unwrap().caller;
    let call = tokio::spawn(caller.call(
        "network/policyRequest",
        parse(r#"{"x":1}"#),
        CallOptions::default(),
    ));
    let outbound = served.peer.recv().await;
    assert_eq!(id_of(&outbound), 1);
    assert_eq!(str_of(at(&outbound, "method")), "network/policyRequest");
    served
        .peer
        .send(r#"{"id":1,"result":{"decision":{"type":"allow"}}}"#);
    let result = call.await.unwrap().unwrap();
    assert_eq!(stringify_json(&result), r#"{"decision":{"type":"allow"}}"#);
    served.peer.end_input();
    assert!(finished(served.run).await.is_ok());
}
