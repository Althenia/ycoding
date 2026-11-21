use crate::dots::carrier::{Clock, Connect, SystemClock, connect_with, relay, rendezvous};
use std::{
    collections::hash_map::RandomState,
    future::Future,
    hash::{BuildHasher, Hasher},
    pin::Pin,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use ycoding_core::{
    dots::{access, enrollment::registry, native, noise},
    ycoding_schema::{JsonValue, LosslessString},
};

pub(crate) type Boxed<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub(crate) type Borrowed<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub(crate) type Name = Arc<dyn Fn() -> Option<LosslessString> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Source {
    pub configuration: Arc<dyn Fn() -> Result<native::Configuration, access::Error> + Send + Sync>,
    pub credential: Credential,
    pub name: Name,
    pub subscribe: Subscribe,
}

type Credential = Arc<
    dyn Fn(
            String,
            Option<String>,
        ) -> native::NativeFuture<'static, Option<native::ResolvedCredential>>
        + Send
        + Sync,
>;
type Subscribe = Arc<dyn Fn(Arc<dyn Fn() + Send + Sync>) -> native::Subscription + Send + Sync>;

impl Source {
    pub(crate) fn host(host: native::Host, name: Name) -> Self {
        let configuration = host.clone();
        let credential = host.clone();
        Self {
            configuration: Arc::new(move || configuration.configuration()),
            credential: Arc::new(move |profile, rejected| {
                let host = credential.clone();
                Box::pin(async move { host.credential(&profile, rejected).await })
            }),
            name,
            subscribe: Arc::new(move |listener| host.subscribe_configuration(listener)),
        }
    }
}

pub(crate) trait Registry: Send + Sync {
    fn register<'a>(
        &'a self,
        environment_id: &'a str,
        credential: &'a mut Arc<native::ResolvedCredential>,
        refresh: Option<&'a registry::Refresh>,
        executor_public_key: JsonValue,
    ) -> Borrowed<'a, Result<registry::Registered, registry::Error>>;

    #[allow(clippy::too_many_arguments)]
    fn validate<'a>(
        &'a self,
        environment_id: &'a str,
        credential: &'a mut Arc<native::ResolvedCredential>,
        refresh: Option<&'a registry::Refresh>,
        executor_registration_id: &'a str,
        harness_public_key: JsonValue,
        authorization: &'a str,
        stream_id: &'a str,
    ) -> Borrowed<'a, Result<(), registry::Error>>;
}

struct Network;
impl Registry for Network {
    fn register<'a>(
        &'a self,
        environment_id: &'a str,
        credential: &'a mut Arc<native::ResolvedCredential>,
        refresh: Option<&'a registry::Refresh>,
        executor_public_key: JsonValue,
    ) -> Borrowed<'a, Result<registry::Registered, registry::Error>> {
        Box::pin(registry::register(
            environment_id,
            credential,
            refresh,
            executor_public_key,
        ))
    }

    fn validate<'a>(
        &'a self,
        environment_id: &'a str,
        credential: &'a mut Arc<native::ResolvedCredential>,
        refresh: Option<&'a registry::Refresh>,
        executor_registration_id: &'a str,
        harness_public_key: JsonValue,
        authorization: &'a str,
        stream_id: &'a str,
    ) -> Borrowed<'a, Result<(), registry::Error>> {
        Box::pin(registry::validate(
            environment_id,
            credential,
            refresh,
            executor_registration_id,
            harness_public_key,
            authorization,
            stream_id,
        ))
    }
}

pub(crate) type Acceptors =
    Arc<dyn Fn(Arc<noise::Identity>, String, String) -> Arc<dyn relay::Acceptor> + Send + Sync>;

#[derive(Clone)]
pub(in crate::dots::carrier) struct Transport {
    pub connect: Connect,
    pub registry: Arc<dyn Registry>,
    pub acceptors: Acceptors,
}

impl Transport {
    pub(in crate::dots::carrier) fn production() -> Self {
        Self {
            connect: connect_with(Some(rendezvous::socket_config())),
            registry: Arc::new(Network),
            acceptors: Arc::new(|identity, environment_id, registration_id| {
                Arc::new(relay::NoiseAcceptor {
                    identity,
                    environment_id,
                    registration_id,
                })
            }),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Ambient {
    pub clock: Arc<dyn Clock>,
    pub random: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub entropy: Arc<dyn Fn() -> String + Send + Sync>,
}

fn word() -> u64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos()),
    );
    hasher.finish()
}

impl Ambient {
    pub(crate) fn system() -> Self {
        Self {
            clock: Arc::new(SystemClock(Instant::now())),
            random: Arc::new(|| (word() >> 11) as f64 / (1u64 << 53) as f64),
            entropy: Arc::new(|| format!("{:016x}{:016x}", word(), word())),
        }
    }
}
