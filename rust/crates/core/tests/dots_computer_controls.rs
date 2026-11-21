use std::sync::{Arc, Mutex};
use ycoding_core::dots::access::{
    Access, Computer, ComputerAttach, ComputerDetach, ComputerFuture, ComputerProblem,
    ComputerRemove, ComputerState, ComputerStatus, ComputerTarget, ConfigurationStatus,
    DotEnvironment, Error, Readiness, StatusFuture, Transport, TransportStatus,
};
use ycoding_store::{Metadata, Options, Store, native};

const CONFIGURATION: &str =
    "Turn on Dots access with a ready ChatGPT profile to attach this computer.";

fn store() -> Store {
    Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([92; 16], 1),
    )
    .unwrap()
}

fn service(store: &Store) -> Access {
    Access::new(
        store.client(),
        Arc::new(|| {
            Ok(ConfigurationStatus {
                ready: true,
                profile: Some("synthetic".into()),
                message: None,
            })
        }),
    )
}

fn target() -> ComputerTarget {
    ComputerTarget {
        dot_id: "dot-a".into(),
        thread_id: "thread-a".into(),
        environment_id: "env-a".into(),
        revision: "a".repeat(64),
    }
}

fn plain(state: ComputerState) -> Computer {
    Computer {
        state,
        message: None,
        name: None,
        target: None,
        readiness: None,
        usable_for_tasks: None,
        dot_environment: None,
    }
}

struct Machine {
    computer: Mutex<ComputerStatus>,
    detach: Mutex<ComputerStatus>,
    remove: Mutex<ComputerStatus>,
    detaches: Mutex<Vec<ComputerDetach>>,
    removals: Mutex<Vec<ComputerRemove>>,
    turn_off_during_remove: Mutex<Option<(Access, u64)>>,
}
impl Machine {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            computer: Mutex::new(ComputerStatus::new(ComputerState::Attached, None)),
            detach: Mutex::new(ComputerStatus::new(ComputerState::Detached, None)),
            remove: Mutex::new(ComputerStatus::new(ComputerState::Attached, None)),
            detaches: Mutex::new(Vec::new()),
            removals: Mutex::new(Vec::new()),
            turn_off_during_remove: Mutex::new(None),
        })
    }
}
impl Transport for Machine {
    fn status(&self) -> StatusFuture<'_> {
        Box::pin(async { Ok(TransportStatus::connected("Synthetic.local")) })
    }
    fn computer(&self) -> ComputerFuture<'_> {
        Box::pin(async { Ok(self.computer.lock().unwrap().clone()) })
    }
    fn attach_computer(&self, _: ComputerAttach) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Attached, None)) })
    }
    fn detach_computer(&self, input: ComputerDetach) -> ComputerFuture<'_> {
        self.detaches.lock().unwrap().push(input);
        Box::pin(async { Ok(self.detach.lock().unwrap().clone()) })
    }
    fn remove_computer(&self, input: ComputerRemove) -> ComputerFuture<'_> {
        self.removals.lock().unwrap().push(input);
        Box::pin(async {
            let racing = self.turn_off_during_remove.lock().unwrap().take();
            if let Some((access, revision)) = racing {
                access.set(false, revision).await.unwrap();
            }
            Ok(self.remove.lock().unwrap().clone())
        })
    }
}

#[tokio::test]
async fn status_exposes_readiness_task_usability_and_the_dot_environment_and_omits_them_when_absent()
 {
    let store = store();
    let access = service(&store);
    access.set(true, 0).await.unwrap();
    let machine = Machine::new();
    let _attached = access.attach_transport(machine.clone()).unwrap();
    let environment = DotEnvironment {
        status: "offline".into(),
        capabilities: vec![("remote_desktop".into(), "starting".into())],
    };
    *machine.computer.lock().unwrap() = ComputerStatus {
        readiness: Some(Readiness::Connected),
        usable_for_tasks: Some(true),
        dot_environment: Some(environment.clone()),
        ..ComputerStatus::new(ComputerState::Attached, None)
    };
    assert_eq!(
        access.status().await.unwrap().computer,
        Some(Computer {
            readiness: Some(Readiness::Connected),
            usable_for_tasks: Some(true),
            dot_environment: Some(environment),
            ..plain(ComputerState::Attached)
        })
    );
    *machine.computer.lock().unwrap() = ComputerStatus {
        usable_for_tasks: Some(false),
        ..ComputerStatus::new(ComputerState::Attached, None)
    };
    assert_eq!(
        access.status().await.unwrap().computer,
        Some(Computer {
            usable_for_tasks: Some(false),
            ..plain(ComputerState::Attached)
        })
    );
    *machine.computer.lock().unwrap() = ComputerStatus::new(ComputerState::Attached, None);
    assert_eq!(
        access.status().await.unwrap().computer,
        Some(plain(ComputerState::Attached))
    );
}

#[tokio::test]
async fn detaching_needs_a_transport_and_enabled_access_forwards_the_target_and_reports_fixed_guidance()
 {
    let store = store();
    let access = service(&store);
    assert_eq!(
        access
            .detach_computer(ComputerDetach {
                expected_target: None
            })
            .await,
        Err(Error::Unavailable)
    );
    let machine = Machine::new();
    let _attached = access.attach_transport(machine.clone()).unwrap();
    *machine.detach.lock().unwrap() = ComputerStatus::new(
        ComputerState::Attached,
        Some(ComputerProblem::NotDisconnectable),
    );
    let off = access
        .detach_computer(ComputerDetach {
            expected_target: None,
        })
        .await
        .unwrap();
    assert_eq!(
        off.computer,
        Some(Computer {
            message: Some(CONFIGURATION.into()),
            ..plain(ComputerState::Unavailable)
        })
    );
    assert!(machine.detaches.lock().unwrap().is_empty());
    access.set(true, 0).await.unwrap();
    for (problem, message) in [
        (
            ComputerProblem::NotDisconnectable,
            "ChatGPT does not allow detaching this computer right now.",
        ),
        (ComputerProblem::Rejected, "ChatGPT refused the request."),
        (
            ComputerProblem::Unconfirmed,
            "The outcome is unconfirmed. Do not repeat the request; refresh status and confirm the current computer before any new attempt.",
        ),
        (
            ComputerProblem::TargetChanged,
            "The Dots computer or account changed. Refresh and confirm the current computer before changing it.",
        ),
    ] {
        *machine.detach.lock().unwrap() =
            ComputerStatus::new(ComputerState::Attached, Some(problem));
        let status = access
            .detach_computer(ComputerDetach {
                expected_target: Some(target()),
            })
            .await
            .unwrap();
        assert_eq!(
            status.computer,
            Some(Computer {
                message: Some(message.into()),
                ..plain(ComputerState::Attached)
            }),
            "{problem:?}"
        );
    }
    *machine.detach.lock().unwrap() = ComputerStatus::new(ComputerState::Detached, None);
    let detached = access
        .detach_computer(ComputerDetach {
            expected_target: None,
        })
        .await
        .unwrap();
    assert_eq!(detached.computer, Some(plain(ComputerState::Detached)));
    assert_eq!(detached.connection.state, "connected");
    assert_eq!(
        *machine.detaches.lock().unwrap(),
        vec![
            ComputerDetach {
                expected_target: Some(target())
            };
            4
        ]
        .into_iter()
        .chain([ComputerDetach {
            expected_target: None
        }])
        .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn removal_turns_access_off_only_after_a_confirmed_removal_and_reports_the_removed_state() {
    let store = store();
    let access = service(&store);
    assert_eq!(
        access
            .remove_computer(ComputerRemove {
                expected_target: None
            })
            .await,
        Err(Error::Unavailable)
    );
    let machine = Machine::new();
    let _attached = access.attach_transport(machine.clone()).unwrap();
    *machine.remove.lock().unwrap() =
        ComputerStatus::new(ComputerState::Attached, Some(ComputerProblem::NotDeletable));
    let off = access
        .remove_computer(ComputerRemove {
            expected_target: None,
        })
        .await
        .unwrap();
    assert_eq!(
        off.computer.map(|computer| computer.state),
        Some(ComputerState::Unavailable)
    );
    assert!(machine.removals.lock().unwrap().is_empty());
    access.set(true, 0).await.unwrap();
    let refused = access
        .remove_computer(ComputerRemove {
            expected_target: None,
        })
        .await
        .unwrap();
    assert_eq!(
        refused.computer,
        Some(Computer {
            message: Some("ChatGPT does not allow removing this computer right now.".into()),
            ..plain(ComputerState::Attached)
        })
    );
    *machine.remove.lock().unwrap() =
        ComputerStatus::new(ComputerState::Detached, Some(ComputerProblem::Unconfirmed));
    let unconfirmed = access
        .remove_computer(ComputerRemove {
            expected_target: None,
        })
        .await
        .unwrap();
    assert!(unconfirmed.access.enabled);
    assert_eq!(unconfirmed.access.revision, 1);
    *machine.remove.lock().unwrap() = ComputerStatus::new(ComputerState::Removed, None);
    let removed = access
        .remove_computer(ComputerRemove {
            expected_target: None,
        })
        .await
        .unwrap();
    assert!(!removed.access.enabled);
    assert_eq!(removed.access.revision, 2);
    assert_eq!(
        removed.computer,
        Some(Computer {
            message: Some(
                "This computer was removed from your ChatGPT account and Dots access is off. Turn Dots access on to enroll it again."
                    .into()
            ),
            ..plain(ComputerState::Removed)
        })
    );
    assert_eq!(access.get().unwrap().revision, 2);
    assert!(!access.get().unwrap().enabled);
    assert_eq!(machine.removals.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn removal_reports_the_removed_state_without_another_write_when_access_was_turned_off_concurrently()
 {
    let store = store();
    let access = service(&store);
    access.set(true, 0).await.unwrap();
    let machine = Machine::new();
    let _attached = access.attach_transport(machine.clone()).unwrap();
    *machine.remove.lock().unwrap() = ComputerStatus::new(ComputerState::Removed, None);
    *machine.turn_off_during_remove.lock().unwrap() = Some((access.clone(), 1));
    let removed = access
        .remove_computer(ComputerRemove {
            expected_target: None,
        })
        .await
        .unwrap();
    assert_eq!(removed.access.revision, 2);
    assert!(!removed.access.enabled);
    assert_eq!(
        removed.computer.map(|computer| computer.state),
        Some(ComputerState::Removed)
    );
}
