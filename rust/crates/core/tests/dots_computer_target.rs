use std::sync::{Arc, Mutex};
use ycoding_core::dots::access::{
    Access, Computer, ComputerAttach, ComputerDetach, ComputerFuture, ComputerProblem,
    ComputerRemove, ComputerState, ComputerStatus, ComputerTarget, ConfigurationStatus, Error,
    StatusFuture, Transport, TransportStatus,
};
use ycoding_schema::LosslessString;
use ycoding_store::{Metadata, Options, Store, native};

fn store() -> Store {
    Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([92; 16], 1),
    )
    .unwrap()
}

fn ready() -> ConfigurationStatus {
    ConfigurationStatus {
        ready: true,
        profile: Some("synthetic".into()),
        message: None,
    }
}

fn target(revision: &str) -> ComputerTarget {
    ComputerTarget {
        dot_id: "dot-synthetic".into(),
        thread_id: "thread-synthetic".into(),
        environment_id: "environment-synthetic".into(),
        revision: revision.into(),
    }
}

fn revision(digit: char) -> String {
    digit.to_string().repeat(64)
}

fn attached(target: ComputerTarget) -> ComputerStatus {
    ComputerStatus {
        state: ComputerState::Attached,
        problem: None,
        name: Some("Synthetic Computer".into()),
        target: Some(target),
        readiness: None,
        usable_for_tasks: None,
        dot_environment: None,
    }
}

fn input(replace_others: bool, expected_target: Option<ComputerTarget>) -> ComputerAttach {
    ComputerAttach {
        replace_others,
        expected_target,
    }
}

struct Recorder {
    requests: Mutex<Vec<ComputerAttach>>,
    computer: Mutex<Result<ComputerStatus, Error>>,
    attach: Mutex<Result<ComputerStatus, Error>>,
    connection_name: Mutex<Option<String>>,
    hold: bool,
    entered: tokio::sync::Notify,
    proceed: tokio::sync::Notify,
}
impl Recorder {
    fn new(hold: bool) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::default(),
            computer: Mutex::new(Ok(ComputerStatus::new(ComputerState::Detached, None))),
            attach: Mutex::new(Ok(attached(target(&revision('a'))))),
            connection_name: Mutex::default(),
            hold,
            entered: Default::default(),
            proceed: Default::default(),
        })
    }
    fn requests(&self) -> Vec<ComputerAttach> {
        self.requests.lock().unwrap().clone()
    }
}
impl Transport for Recorder {
    fn status(&self) -> StatusFuture<'_> {
        Box::pin(async {
            Ok(TransportStatus {
                state: "connected".into(),
                hostname: Some("Synthetic.local".into()),
                name: self.connection_name.lock().unwrap().clone(),
                problem: None,
            })
        })
    }
    fn computer(&self) -> ComputerFuture<'_> {
        Box::pin(async { self.computer.lock().unwrap().clone() })
    }
    fn attach_computer(&self, input: ComputerAttach) -> ComputerFuture<'_> {
        self.requests.lock().unwrap().push(input);
        Box::pin(async {
            if self.hold {
                self.entered.notify_one();
                self.proceed.notified().await;
            }
            self.attach.lock().unwrap().clone()
        })
    }
    fn detach_computer(&self, _: ComputerDetach) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
    fn remove_computer(&self, _: ComputerRemove) -> ComputerFuture<'_> {
        Box::pin(async { Ok(ComputerStatus::new(ComputerState::Detached, None)) })
    }
}

fn unavailable() -> Computer {
    Computer {
        state: ComputerState::Unavailable,
        message: None,
        name: None,
        target: None,
        readiness: None,
        usable_for_tasks: None,
        dot_environment: None,
    }
}

#[tokio::test]
async fn the_expected_target_reaches_the_transport_unchanged_and_absence_stays_absent() {
    let store = store();
    let service = Access::new(store.client(), Arc::new(|| Ok(ready())));
    service.set(true, 0).await.unwrap();
    let transport = Recorder::new(false);
    let _owner = service.attach_transport(transport.clone()).unwrap();
    let expected = target(&revision('a'));
    let status = service
        .attach_computer(input(false, Some(expected.clone())))
        .await
        .unwrap();
    service.attach_computer(input(true, None)).await.unwrap();
    assert_eq!(
        transport.requests(),
        vec![input(false, Some(expected.clone())), input(true, None)]
    );
    assert_eq!(
        status.computer,
        Some(Computer {
            state: ComputerState::Attached,
            message: None,
            name: Some("Synthetic Computer".into()),
            target: Some(expected),
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
}

#[tokio::test]
async fn a_target_mismatch_reported_by_the_transport_is_published_as_target_changed_without_a_target()
 {
    let store = store();
    let service = Access::new(store.client(), Arc::new(|| Ok(ready())));
    service.set(true, 0).await.unwrap();
    let transport = Recorder::new(false);
    *transport.attach.lock().unwrap() = Ok(ComputerStatus::new(
        ComputerState::Unavailable,
        Some(ComputerProblem::TargetChanged),
    ));
    let _owner = service.attach_transport(transport.clone()).unwrap();
    let status = service
        .attach_computer(input(false, Some(target(&revision('b')))))
        .await
        .unwrap();
    assert_eq!(
        status.computer,
        Some(Computer {
            state: ComputerState::Unavailable,
            message: Some(
                "The Dots computer or account changed. Refresh and confirm the current computer before changing it."
                    .into()
            ),
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
}

#[tokio::test]
async fn names_and_targets_round_trip_in_every_optional_combination() {
    let store = store();
    let service = Access::new(store.client(), Arc::new(|| Ok(ready())));
    service.set(true, 0).await.unwrap();
    let transport = Recorder::new(false);
    let _owner = service.attach_transport(transport.clone()).unwrap();
    let observed = target(&revision('c'));
    for (name, target) in [
        (None, None),
        (Some("Name only"), None),
        (None, Some(observed.clone())),
        (Some("Name and target"), Some(observed.clone())),
    ] {
        *transport.computer.lock().unwrap() = Ok(ComputerStatus {
            state: ComputerState::Detached,
            problem: None,
            name: name.map(LosslessString::from),
            target: target.clone(),
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        });
        for connection_name in [None, Some("Connection name".to_owned())] {
            *transport.connection_name.lock().unwrap() = connection_name.clone();
            let status = service.status().await.unwrap();
            assert_eq!(
                status.connection.name,
                connection_name.clone().map(LosslessString::from)
            );
            assert_eq!(
                status.computer,
                Some(Computer {
                    state: ComputerState::Detached,
                    message: None,
                    name: name.map(LosslessString::from),
                    target: target.clone(),
                    readiness: None,
                    usable_for_tasks: None,
                    dot_environment: None,
                })
            );
        }
    }
}

#[tokio::test]
async fn names_are_bounded_and_control_characters_are_replaced() {
    let store = store();
    let service = Access::new(store.client(), Arc::new(|| Ok(ready())));
    service.set(true, 0).await.unwrap();
    let transport = Recorder::new(false);
    *transport.computer.lock().unwrap() = Ok(ComputerStatus {
        name: Some(format!("a\u{0000}b\u{0085}{}", "n".repeat(400)).into()),
        ..ComputerStatus::new(ComputerState::Detached, None)
    });
    *transport.connection_name.lock().unwrap() = Some(format!("\n{}", "c".repeat(400)));
    let _owner = service.attach_transport(transport).unwrap();
    let status = service.status().await.unwrap();
    let name = status.computer.unwrap().name.unwrap();
    assert_eq!(name.len(), 256);
    assert_eq!(
        name,
        LosslessString::from(format!("a b {}", "n".repeat(252)))
    );
    assert_eq!(
        status.connection.name,
        Some(LosslessString::from("c".repeat(256)))
    );
}

#[tokio::test]
async fn a_malformed_transport_target_is_never_published() {
    let store = store();
    let service = Access::new(store.client(), Arc::new(|| Ok(ready())));
    service.set(true, 0).await.unwrap();
    let transport = Recorder::new(false);
    let _owner = service.attach_transport(transport.clone()).unwrap();
    let malformed = [
        target(&"A".repeat(64)),
        target(&"a".repeat(63)),
        target(&"a".repeat(65)),
        target(&"g".repeat(64)),
        ComputerTarget {
            dot_id: LosslessString::default(),
            ..target(&revision('a'))
        },
        ComputerTarget {
            thread_id: "t".repeat(257).into(),
            ..target(&revision('a'))
        },
        ComputerTarget {
            environment_id: LosslessString::default(),
            ..target(&revision('a'))
        },
    ];
    for target in malformed {
        *transport.computer.lock().unwrap() = Ok(attached(target.clone()));
        let status = service.status().await.unwrap();
        assert_eq!(
            status.computer,
            Some(Computer {
                state: ComputerState::Unavailable,
                message: Some("Your Dot's computers could not be read. Try again.".into()),
                name: None,
                target: None,
                readiness: None,
                usable_for_tasks: None,
                dot_environment: None,
            }),
            "{target:?}"
        );
    }
}

#[tokio::test]
async fn a_disabled_or_unready_access_never_reaches_the_transport_with_an_expected_target() {
    let store = store();
    let readiness = Arc::new(Mutex::new(ready()));
    let read = readiness.clone();
    let service = Access::new(
        store.client(),
        Arc::new(move || Ok(read.lock().unwrap().clone())),
    );
    let transport = Recorder::new(false);
    let _owner = service.attach_transport(transport.clone()).unwrap();
    let expected = Some(target(&revision('a')));
    let status = service
        .attach_computer(input(false, expected.clone()))
        .await
        .unwrap();
    assert_eq!(status.computer.unwrap().target, None);
    service.set(true, 0).await.unwrap();
    readiness.lock().unwrap().ready = false;
    let status = service
        .attach_computer(input(false, expected))
        .await
        .unwrap();
    assert_eq!(status.computer.unwrap().target, None);
    assert_eq!(transport.requests(), Vec::new());
}

#[tokio::test]
async fn a_failed_transport_completion_is_unavailable_and_never_a_confirmed_attach() {
    let store = store();
    let service = Access::new(store.client(), Arc::new(|| Ok(ready())));
    service.set(true, 0).await.unwrap();
    let transport = Recorder::new(false);
    *transport.attach.lock().unwrap() = Err(Error::Unavailable);
    let _owner = service.attach_transport(transport.clone()).unwrap();
    let status = service
        .attach_computer(input(false, Some(target(&revision('a')))))
        .await
        .unwrap();
    assert_eq!(
        status.computer,
        Some(Computer {
            state: ComputerState::Unavailable,
            message: Some("Your Dot's computers could not be read. Try again.".into()),
            name: None,
            target: None,
            readiness: None,
            usable_for_tasks: None,
            dot_environment: None,
        })
    );
}

#[tokio::test]
async fn a_completion_after_a_binding_change_cannot_publish_an_attached_computer() {
    for change in ["revoke", "revoke-and-restore", "profile", "owner"] {
        let store = store();
        let configuration = Arc::new(Mutex::new(ready()));
        let read = configuration.clone();
        let service = Access::new(
            store.client(),
            Arc::new(move || Ok(read.lock().unwrap().clone())),
        );
        service.set(true, 0).await.unwrap();
        let transport = Recorder::new(true);
        let owner = service.attach_transport(transport.clone()).unwrap();
        let attaching = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .attach_computer(input(false, Some(target(&revision('a')))))
                    .await
                    .unwrap()
            }
        });
        transport.entered.notified().await;
        match change {
            "revoke" => {
                service.set(false, 1).await.unwrap();
            }
            "revoke-and-restore" => {
                service.set(false, 1).await.unwrap();
                service.set(true, 2).await.unwrap();
            }
            "profile" => configuration.lock().unwrap().profile = Some("replacement".into()),
            _ => owner.release(),
        }
        transport.proceed.notify_one();
        let status = attaching.await.unwrap();
        assert_eq!(transport.requests().len(), 1, "{change}");
        match change {
            "owner" => {
                assert_eq!(status.computer, None);
                assert_eq!(status.connection.state, "unavailable");
            }
            _ => assert_eq!(status.computer, Some(unavailable()), "{change}"),
        }
    }
}

#[tokio::test]
async fn a_replacement_owner_does_not_inherit_the_previous_attach_result() {
    let store = store();
    let service = Access::new(store.client(), Arc::new(|| Ok(ready())));
    service.set(true, 0).await.unwrap();
    let first = Recorder::new(true);
    let owner = service.attach_transport(first.clone()).unwrap();
    let attaching = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .attach_computer(input(false, Some(target(&revision('a')))))
                .await
                .unwrap()
        }
    });
    first.entered.notified().await;
    owner.release();
    let second = Recorder::new(false);
    *second.computer.lock().unwrap() = Ok(ComputerStatus::new(ComputerState::Detached, None));
    let _replacement = service.attach_transport(second.clone()).unwrap();
    first.proceed.notify_one();
    let status = attaching.await.unwrap();
    assert_eq!(status.computer, None);
    assert_eq!(status.connection.state, "unavailable");
    assert_eq!(second.requests(), Vec::new());
}

struct Vector {
    access_revision: u64,
    profile: &'static str,
    credential_id: &'static str,
    account_id: &'static str,
    account_generation: i64,
    executor_id: &'static str,
    installation_id: &'static str,
    account_hash: &'static str,
    dot_id: &'static str,
    thread_id: &'static str,
    environment_id: &'static str,
    key: &'static str,
    revision: &'static str,
}

const VECTORS: [Vector; 2] = [
    Vector {
        access_revision: 3,
        profile: "selected",
        credential_id: "credential_selected",
        account_id: "synthetic-account",
        account_generation: 2,
        executor_id: "executor-synthetic",
        installation_id: "installation-synthetic",
        account_hash: "50a5ee17cb005388e7f31e1ed28043dda745bb3d2b65d8042afaead6fd4af575",
        dot_id: "dot-synthetic",
        thread_id: "thread-synthetic",
        environment_id: "executor-synthetic",
        key: "[{\"enabled\":true,\"accessRevision\":3,\"profile\":\"selected\",\"credentialID\":\"credential_selected\",\"accountID\":\"synthetic-account\",\"accountGeneration\":2},{\"executorID\":\"executor-synthetic\",\"installationID\":\"installation-synthetic\",\"accountHash\":\"50a5ee17cb005388e7f31e1ed28043dda745bb3d2b65d8042afaead6fd4af575\",\"status\":\"completed\"}]",
        revision: "751055fba13f60ff1ff771733b05b6e26e5abe5a46b5c02096828eccf3b4bbdb",
    },
    Vector {
        access_revision: 9007199254740991,
        profile: "pro\"file\\x",
        credential_id: "cred\u{a}id\u{9}\u{1}\u{1f}",
        account_id: "acc\u{7f}\u{85}\u{2028}\u{e9}\u{1f600}",
        account_generation: 0,
        executor_id: "exec\"utor",
        installation_id: "inst\\allation/\u{2029}",
        account_hash: "7181292393bdf68d6701ddfe4bfb4878bd2d83a1a5544094d2174f1d0fed5875",
        dot_id: "dot\"\\\u{a}",
        thread_id: "thread\u{0}\u{85}\u{1f600}",
        environment_id: "env\u{e9}\u{2028}",
        key: "[{\"enabled\":true,\"accessRevision\":9007199254740991,\"profile\":\"pro\\\"file\\\\x\",\"credentialID\":\"cred\\nid\\t\\u0001\\u001f\",\"accountID\":\"acc\u{7f}\u{85}\u{2028}\u{e9}\u{1f600}\",\"accountGeneration\":0},{\"executorID\":\"exec\\\"utor\",\"installationID\":\"inst\\\\allation/\u{2029}\",\"accountHash\":\"7181292393bdf68d6701ddfe4bfb4878bd2d83a1a5544094d2174f1d0fed5875\",\"status\":\"completed\"}]",
        revision: "ba1607a91014626e961602e0e1e3c667cfae20f9802a47b48188900918214b3f",
    },
];

#[test]
fn owner_keys_and_receipt_revisions_match_the_canonical_typescript_vectors() {
    for vector in &VECTORS {
        let key = ycoding_core::dots::computer::owner_key(
            vector.access_revision,
            vector.profile,
            vector.credential_id,
            vector.account_id,
            vector.account_generation,
            &vector.executor_id.into(),
            &vector.installation_id.into(),
            vector.account_hash,
            "completed",
        );
        assert_eq!(key, vector.key);
        assert_eq!(
            ycoding_core::dots::computer::receipt_revision(
                &key,
                &vector.dot_id.into(),
                &vector.thread_id.into(),
                &vector.environment_id.into()
            ),
            vector.revision
        );
    }
}

#[tokio::test]
async fn names_trim_like_javascript_and_slice_by_utf16_units() {
    let store = store();
    let service = Access::new(store.client(), Arc::new(|| Ok(ready())));
    service.set(true, 0).await.unwrap();
    let transport = Recorder::new(false);
    let _owner = service.attach_transport(transport.clone()).unwrap();
    let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
    let cut_pair = {
        let mut cut = units(&"b".repeat(255));
        cut.push(0xd83d);
        cut
    };
    for (name, expected) in [
        (
            units(&format!("\u{feff}\u{a0}{}\u{3000}\u{2029}", "a".repeat(10))),
            units(&"a".repeat(10)),
        ),
        (units("\u{85}x\u{85}y\u{85}"), units("x y")),
        (units(&format!("{}\u{1f600}", "b".repeat(255))), cut_pair),
        (
            units(&format!("{}\u{1f600}", "b".repeat(254))),
            units(&format!("{}\u{1f600}", "b".repeat(254))),
        ),
        (vec![0xd800, 0x20, 0xdc00], vec![0xd800, 0x20, 0xdc00]),
        (vec![0x20, 0xd800, 0x20], vec![0xd800]),
    ] {
        *transport.computer.lock().unwrap() = Ok(ComputerStatus {
            name: Some(LosslessString::from_utf16(name)),
            ..ComputerStatus::new(ComputerState::Detached, None)
        });
        let status = service.status().await.unwrap();
        assert_eq!(
            status.computer.unwrap().name,
            Some(LosslessString::from_utf16(expected))
        );
    }
}

#[test]
fn lone_surrogates_are_escaped_like_json_stringify_in_keys_and_hashes() {
    let executor = LosslessString::from_utf16(
        "exec"
            .encode_utf16()
            .chain([0xd800, 0x2d, 0xdc00])
            .collect(),
    );
    let installation = LosslessString::from_utf16("inst".encode_utf16().chain([0xdbff]).collect());
    let dot = LosslessString::from_utf16("dot".encode_utf16().chain([0xd83d]).collect());
    let thread = LosslessString::from_utf16(
        [0xdc00]
            .into_iter()
            .chain("thread".encode_utf16())
            .chain([0xd83d, 0xde00])
            .collect(),
    );
    let key = ycoding_core::dots::computer::owner_key(
        4,
        "selected",
        "credential_selected",
        "synthetic-account",
        1,
        &executor,
        &installation,
        "50a5ee17cb005388e7f31e1ed28043dda745bb3d2b65d8042afaead6fd4af575",
        "completed",
    );
    assert_eq!(
        key,
        "[{\"enabled\":true,\"accessRevision\":4,\"profile\":\"selected\",\"credentialID\":\"credential_selected\",\"accountID\":\"synthetic-account\",\"accountGeneration\":1},{\"executorID\":\"exec\\ud800-\\udc00\",\"installationID\":\"inst\\udbff\",\"accountHash\":\"50a5ee17cb005388e7f31e1ed28043dda745bb3d2b65d8042afaead6fd4af575\",\"status\":\"completed\"}]"
    );
    assert_eq!(
        ycoding_core::dots::computer::receipt_revision(&key, &dot, &thread, &executor),
        "2b57664b88dcf2d14152356fa8dc779953ea4d710ba4772bca9bc2b929acf03b"
    );
}

#[test]
fn targets_with_lone_surrogates_are_valid_and_compare_by_code_units() {
    let lone = LosslessString::from_utf16(vec![0xd800]);
    let first = ComputerTarget {
        dot_id: lone.clone(),
        ..target(&revision('a'))
    };
    assert!(first.is_valid());
    assert_eq!(first.clone(), first);
    assert_ne!(
        first,
        ComputerTarget {
            dot_id: LosslessString::from_utf16(vec![0xdc00]),
            ..first.clone()
        }
    );
    let long = LosslessString::from_utf16(vec![0xd800; 257]);
    assert!(
        !ComputerTarget {
            thread_id: long,
            ..first
        }
        .is_valid()
    );
}
