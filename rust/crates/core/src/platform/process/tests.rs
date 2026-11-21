use super::{Control, KillOptions, KillSignal, Request, Teardown, Termination, tree};
use std::{
    io,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
use tokio::sync::{Notify, mpsc, watch};

#[derive(Debug)]
struct Quiet;

impl tree::GroupSystem for Quiet {
    fn read(&self) -> tree::Members<'_> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn signal(&self, _target: i32, _signal: KillSignal) -> io::Result<()> {
        Err(io::Error::other("a synthetic group is never signalled"))
    }
}

#[derive(Clone, Copy, Debug)]
enum Operation {
    Terminate,
    Kill,
}

const OPERATIONS: [Operation; 2] = [Operation::Terminate, Operation::Kill];
const REFUSED: &str = "cleanup refused";

struct Harness {
    control: Control,
    requests: mpsc::Receiver<Request>,
    teardown: watch::Sender<Teardown>,
}

async fn harness() -> Harness {
    let (sender, requests) = mpsc::channel(16);
    let (teardown_sender, teardown) = watch::channel(Teardown::default());
    let group = tree::Group::new(Arc::new(Quiet), 1, false).await;
    Harness {
        control: Control {
            running: Arc::new(AtomicBool::new(true)),
            pid: 1,
            sender,
            group: Arc::new(tokio::sync::Mutex::new(group)),
            abandon: Arc::new(Notify::new()),
            teardown,
        },
        requests,
        teardown: teardown_sender,
    }
}

fn failed(attempt: u64) -> Teardown {
    Teardown {
        attempt,
        failure: Some((io::ErrorKind::PermissionDenied, REFUSED.into())),
    }
}

fn clean(attempt: u64) -> Teardown {
    Teardown {
        attempt,
        failure: None,
    }
}

async fn run(control: &Control, operation: Operation) -> io::Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        match operation {
            Operation::Terminate => control.terminate(Termination::Cancelled).await,
            Operation::Kill => control.kill(KillOptions::default()).await,
        }
    })
    .await
    .expect("a settled control operation must not wait for a missing supervisor")
}

async fn closed_sender(operation: Operation, states: Vec<Teardown>) -> io::Result<()> {
    let Harness {
        control,
        requests,
        teardown,
    } = harness().await;
    for state in states {
        teardown.send(state).unwrap();
    }
    drop(requests);
    run(&control, operation).await
}

async fn dropped_reply(operation: Operation, state: Option<Teardown>) -> io::Result<()> {
    let Harness {
        control,
        mut requests,
        teardown,
    } = harness().await;
    let supervisor = tokio::spawn(async move {
        let request = requests
            .recv()
            .await
            .expect("the operation sends a request");
        if let Some(state) = state {
            teardown.send(state).unwrap();
        }
        match request {
            Request::Terminate(_, reply) | Request::Kill(_, reply) => drop(reply),
            _ => unreachable!("only terminate and kill are issued"),
        }
    });
    let result = run(&control, operation).await;
    supervisor.await.unwrap();
    result
}

async fn replied(operation: Operation, error: Option<&'static str>) -> io::Result<()> {
    let Harness {
        control,
        mut requests,
        teardown: _teardown,
    } = harness().await;
    let supervisor = tokio::spawn(async move {
        let request = requests
            .recv()
            .await
            .expect("the operation sends a request");
        let outcome = match error {
            Some(message) => Err(io::Error::new(io::ErrorKind::PermissionDenied, message)),
            None => Ok(()),
        };
        match request {
            Request::Terminate(_, reply) | Request::Kill(_, reply) => {
                let _ = reply.send(outcome);
            }
            _ => unreachable!("only terminate and kill are issued"),
        }
    });
    let result = run(&control, operation).await;
    supervisor.await.unwrap();
    result
}

fn assert_cleanup_failure(result: io::Result<()>, operation: Operation) {
    let error = result.expect_err(&format!(
        "{operation:?} reported success while the teardown holds a failed cleanup"
    ));
    assert_eq!(
        error.kind(),
        io::ErrorKind::PermissionDenied,
        "{operation:?}"
    );
    assert!(
        error.to_string().contains(REFUSED),
        "{operation:?}: {error}"
    );
}

#[tokio::test]
async fn a_closed_supervisor_channel_reports_the_failed_cleanup_held_by_the_teardown() {
    for operation in OPERATIONS {
        assert_cleanup_failure(closed_sender(operation, vec![failed(1)]).await, operation);
    }
}

#[tokio::test]
async fn a_dropped_reply_reports_the_failed_cleanup_held_by_the_teardown() {
    for operation in OPERATIONS {
        assert_cleanup_failure(dropped_reply(operation, Some(failed(1))).await, operation);
    }
}

#[tokio::test]
async fn a_closed_supervisor_channel_with_a_clean_teardown_is_success() {
    for operation in OPERATIONS {
        closed_sender(operation, vec![]).await.unwrap();
        closed_sender(operation, vec![failed(1), clean(2)])
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn a_dropped_reply_with_a_clean_teardown_is_success() {
    for operation in OPERATIONS {
        dropped_reply(operation, None).await.unwrap();
        dropped_reply(operation, Some(clean(1))).await.unwrap();
    }
}

#[tokio::test]
async fn a_supervisor_reply_is_returned_unchanged() {
    for operation in OPERATIONS {
        replied(operation, None).await.unwrap();
        let error = replied(operation, Some(REFUSED)).await.unwrap_err();
        assert_eq!(
            error.kind(),
            io::ErrorKind::PermissionDenied,
            "{operation:?}"
        );
        assert!(
            error.to_string().contains(REFUSED),
            "{operation:?}: {error}"
        );
    }
}
