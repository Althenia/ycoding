use super::support::*;
use crate::dots::carrier::{
    executor_rpc::{
        core_adapter::{self, backend_features},
        readiness::{self, prepare},
        types::BackendFeatures,
    },
    supervisor::{Boxed, Prepare, PrepareError},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn operator(result: Result<(), &'static str>, calls: Arc<AtomicUsize>) -> Prepare {
    Box::new(move || {
        let future: Boxed<Result<(), PrepareError>> = Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            result.map_err(|reason| PrepareError::Held { reason })
        });
        future
    })
}

fn held_reason(error: PrepareError) -> &'static str {
    match error {
        PrepareError::Held { reason } => reason,
        PrepareError::Failed(error) => panic!("expected a hold, got a failure: {error:?}"),
    }
}

#[tokio::test]
async fn a_backed_executor_with_ready_prerequisites_may_be_served() {
    let calls = Arc::new(AtomicUsize::new(0));
    let ready = prepare(
        operator(Ok(()), calls.clone()),
        canonical_info(),
        full_features(),
    );
    assert!(ready().await.is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unready_operator_prerequisites_hold_before_any_capability_is_considered() {
    let calls = Arc::new(AtomicUsize::new(0));
    let held = prepare(
        operator(Err("operator skill provisioning is held"), calls.clone()),
        canonical_info(),
        BackendFeatures::default(),
    );
    assert_eq!(
        held_reason(held().await.unwrap_err()),
        "operator skill provisioning is held"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn every_advertised_capability_without_a_backend_holds_with_its_own_reason() {
    type MissingBackend = (&'static str, fn(&mut BackendFeatures));
    let cases: [MissingBackend; 6] = [
        ("networkProxyLaunch", |f| f.network_proxy = false),
        ("credentialMasking", |f| f.credential_masking = false),
        ("capabilityDiscoveryV2", |f| {
            f.capability_discovery_v2 = false
        }),
        ("environmentConfigRead", |f| {
            f.environment_config_read = false
        }),
        ("sandboxedFileStreaming", |f| f.file_streaming = false),
        ("shellSnapshotV2", |f| f.shell_snapshot = false),
    ];
    for (capability, unback) in cases {
        let mut features = full_features();
        unback(&mut features);
        let held = prepare(operator(Ok(()), Arc::default()), canonical_info(), features);
        assert_eq!(
            held_reason(held().await.unwrap_err()),
            format!("advertised capability {capability} is not backed"),
            "{capability}"
        );
    }
}

#[tokio::test]
async fn environment_config_read_advertised_and_backed_passes_readiness() {
    let mut info = canonical_info();
    info.capabilities.credential_masking = None;
    info.capabilities.credential_masking_custom_providers = None;
    assert_eq!(info.capabilities.environment_config_read, Some(true));
    let ready = prepare(operator(Ok(()), Arc::default()), info, backend_features());
    assert!(ready().await.is_ok());
}

#[tokio::test]
async fn core_backed_features_pass_readiness_for_all_canonical_capabilities() {
    assert!(
        prepare(
            operator(Ok(()), Arc::default()),
            canonical_info(),
            backend_features()
        )()
        .await
        .is_ok()
    );
}

#[test]
fn core_prepared_advertisement_passes_readiness_with_backend_features() {
    use std::collections::BTreeMap;
    use ycoding_core::cca::executor::{PrepareExecutorInput, prepare_executor};
    let directory = std::env::temp_dir().join(format!(
        "ycoding-readiness-core-prepared-{}",
        std::process::id()
    ));
    let home = directory.join("home");
    let data = directory.join("data");
    let ca = directory.join("ca");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    let startup = BTreeMap::from([("SHELL".into(), "/bin/zsh".into())]);
    let prepared = prepare_executor(PrepareExecutorInput {
        home_directory: &home,
        data_directory: &data,
        network_proxy_ca_directory: &ca,
        startup_environment: &startup,
    })
    .expect("core preparation succeeds");
    let advertised = core_adapter::environment_info(prepared.environment_info());
    assert!(readiness::check(&advertised, &backend_features()).is_ok());
    std::fs::remove_dir_all(&directory).unwrap();
}
