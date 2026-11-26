use super::*;
use crate::{
    dots::{carrier::test_support::HostFixture, native_library},
    production::{
        owner::{Context, ProductionOwner},
        tests::fixture,
    },
};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::atomic::{AtomicUsize, Ordering},
};
use ycoding_core::cca::executor::{
    PrepareExecutorError, PrepareExecutorInput, PreparedExecutor, prepare_executor,
};

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "ycoding-prepared-composition-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        std::fs::create_dir(directory.join("home")).unwrap();
        std::fs::create_dir(directory.join("data")).unwrap();
        Self(std::fs::canonicalize(directory).unwrap())
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

struct Fixture {
    host: HostFixture,
    locations: Locations,
    sessions: SessionStore,
    library: Arc<dyn LibraryProvider>,
    prepared: Arc<PreparedExecutor>,
    _production: crate::production::tests::Fixture,
    directory: Directory,
}

impl Fixture {
    async fn new(context: &Context) -> Self {
        let directory = Directory::new();
        let home = directory.0.join("home");
        let data = directory.0.join("data");
        let ca = directory.0.join("proxy-ca");
        let startup = BTreeMap::from([("SHELL".into(), "/bin/ycoding-prepared-test-shell".into())]);
        let prepared = match prepare_executor(PrepareExecutorInput {
            home_directory: &home,
            data_directory: &data,
            network_proxy_ca_directory: &ca,
            startup_environment: &startup,
        }) {
            Ok(prepared) => Arc::new(prepared),
            Err(PrepareExecutorError::Held { prerequisite, .. }) => {
                panic!("Core preparation held: {prerequisite}")
            }
            Err(PrepareExecutorError::Failed(error)) => {
                panic!("Core preparation failed: {error}")
            }
        };
        let production = fixture("{}", "{}");
        let locations = production.locations();
        let sessions = production.sessions();
        let library = native_library::provider(native_library::Options {
            locations: locations.downgrade(),
            sessions: sessions.clone(),
            owner: context.handle(),
        });
        Self {
            host: HostFixture::new().await,
            locations,
            sessions,
            library,
            prepared,
            _production: production,
            directory,
        }
    }

    fn composition(&self) -> Composition {
        Composition {
            host: self.host.host.clone(),
            locations: self.locations.clone(),
            sessions: self.sessions.clone(),
            git: Arc::new(git::Service::new(1024)),
            environment_id: "environment-fixture".into(),
            home: self.directory.0.join("home"),
            data: self.directory.0.join("data"),
            prepared: self.prepared.clone(),
            network_proxy_ca_directory: Some(self.directory.0.join("proxy-ca")),
            answer_process: None,
            library: Some(self.library.clone()),
            review_directories: None,
            authorization_timeout: None,
            codex_home_env: None,
            system_config_path: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.locations.close().unwrap();
    }
}

fn owned(test: impl FnOnce(Context) -> Pin<Box<dyn Future<Output = ()>>>) {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let joined = ProductionOwner::scope(&runtime, |owner| {
        let context = runtime
            .block_on(owner.production_context().unwrap())
            .unwrap();
        runtime.block_on(test(context));
    });
    joined
        .body
        .unwrap_or_else(|_| panic!("composition test body failed"));
    joined.cleanup.result().unwrap();
}

#[test]
fn native_preparation_does_not_read_proxy_certificate_files() {
    let directory = Directory::new();
    let ca = directory.0.join("invalid-ca.pem");
    std::fs::write(&ca, "not a certificate").unwrap();
    let prepared = ycoding_core::cca::executor::prepare_native_dots_executor(
        &directory.0,
        &directory.0,
        &BTreeMap::from([("SSL_CERT_FILE".to_owned(), ca.to_str().unwrap().to_owned())]),
    )
    .unwrap();
    assert!(
        prepared
            .environment_info()
            .capabilities
            .credential_masking
            .is_none()
    );
}

#[test]
fn advertised_metadata_is_the_frozen_core_snapshot_without_scope_effects() {
    owned(|context| {
        Box::pin(async move {
            let fixture = Fixture::new(&context).await;
            let baseline_subscriptions = fixture.host.subscriptions();
            assert_eq!(
                baseline_subscriptions, 1,
                "the native Host retains its backend event listener"
            );
            let expected = environment_info(fixture.prepared.environment_info());
            let composition = fixture.composition();
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            let serving = composition.into_serving().unwrap();
            assert_eq!(serving.advertised, expected);
            assert_eq!(
                serving.advertised.shell.path.as_str(),
                Some("/bin/ycoding-prepared-test-shell")
            );
            assert_eq!(
                serving.advertised.capabilities.environment_config_read,
                Some(true)
            );
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            assert_eq!(fixture.host.admission_counts(), (0, 0));
            assert!(!fixture.directory.0.join("proxy-ca").exists());
        })
    });
}

#[test]
fn each_session_factory_binding_preserves_prepared_metadata_and_independent_close() {
    owned(|context| {
        Box::pin(async move {
            let fixture = Fixture::new(&context).await;
            let baseline_subscriptions = fixture.host.subscriptions();
            assert_eq!(
                baseline_subscriptions, 1,
                "the native Host retains its backend event listener"
            );
            let expected = environment_info(fixture.prepared.environment_info());
            let composition = fixture.composition();
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            let (advertised, factory) = composition.into_session_factory().unwrap();
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            assert_eq!(advertised, expected);
            let first = factory().unwrap();
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            assert_eq!((first.environment_info)().await.unwrap(), expected);
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            (first.close)().await.unwrap();
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            let second = factory().unwrap();
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            assert_eq!((second.environment_info)().await.unwrap(), expected);
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            (second.close)().await.unwrap();
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            assert_eq!(fixture.host.admission_counts(), (0, 0));
            assert!(!fixture.directory.0.join("proxy-ca").exists());
        })
    });
}

#[test]
fn prepared_binding_mismatches_reach_the_session_factory_as_executor_errors() {
    owned(|context| {
        Box::pin(async move {
            let fixture = Fixture::new(&context).await;
            let baseline_subscriptions = fixture.host.subscriptions();
            assert_eq!(
                baseline_subscriptions, 1,
                "the native Host retains its backend event listener"
            );
            for field in ["home", "data", "ca"] {
                let mut composition = fixture.composition();
                assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
                match field {
                    "home" => composition.home.push("mismatch"),
                    "data" => composition.data.push("mismatch"),
                    "ca" => composition
                        .network_proxy_ca_directory
                        .as_mut()
                        .unwrap()
                        .push("mismatch"),
                    _ => unreachable!(),
                }
                let (_, factory) = composition.into_session_factory().unwrap();
                assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
                let error = factory()
                    .err()
                    .expect("mismatched prepared binding succeeded");
                assert!(
                    matches!(error, HandlerError::Executor { code: -32602, .. }),
                    "{field}: {error:?}"
                );
                assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            }
            assert_eq!(fixture.host.subscriptions(), baseline_subscriptions);
            assert_eq!(fixture.host.admission_counts(), (0, 0));
            assert!(!fixture.directory.0.join("proxy-ca").exists());
        })
    });
}
