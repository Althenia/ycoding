pub mod authorization;
pub mod capture;
pub mod delivery;
pub mod identity;
pub mod protected_http;
pub mod secret_box;

use crate::event_feed::{Feed, Payload as FeedPayload, Scope, Subscriber};
pub use crate::tools::code_mode::Cancellation;
use std::ops::Bound;
use std::{
    collections::BTreeMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, Presence,
    mcp_events::{
        self, Failure, FailureCategory, FailureReason, Principal, RequestContext, Subscribe,
        Subscription, Unsubscribe,
    },
};
use ycoding_store::{
    Client, IndexOrder, IndexQuery, KeyPart, TableSpec,
    mcp_events::{OutboxTable, SubscriptionTable},
    session::SessionTable,
    tuple_key,
};

pub type ResultFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, Failure>> + Send + 'a>>;
pub struct Grant {
    pub grant_id: LosslessString,
    pub expires_at: i64,
}
pub struct Permit {
    pub expires_at: i64,
    pub cancellation: Cancellation,
}
pub trait Authorization: Send + Sync {
    fn capabilities(&self, cancellation: Cancellation) -> ResultFuture<'_, bool>;
    fn resolve(
        &self,
        context: RequestContext,
        cancellation: Cancellation,
    ) -> ResultFuture<'_, Grant>;
    fn check(&self, principal: Principal, cancellation: Cancellation) -> ResultFuture<'_, Permit>;
}
#[derive(Clone)]
pub struct HttpRequest {
    pub url: String,
    pub body: String,
    pub headers: BTreeMap<String, String>,
    pub timeout_ms: u64,
}
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}
pub trait Transport: Send + Sync {
    fn send(
        &self,
        request: HttpRequest,
        cancellation: Cancellation,
    ) -> ResultFuture<'_, HttpResponse>;
}
pub enum Secrets {
    Memory(Arc<secret_box::SecretBox>),
    File(PathBuf),
}
pub struct Dependencies {
    pub store: Client,
    pub authorization: Arc<dyn Authorization>,
    pub transport: Arc<dyn Transport>,
    pub secrets: Secrets,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}
pub struct EventInput {
    pub event_type: LosslessString,
    pub id: LosslessString,
    pub created: i64,
    pub data: JsonValue,
}
pub struct Service {
    deps: Dependencies,
    loaded: OnceLock<Result<Arc<secret_box::SecretBox>, Failure>>,
    mutations: tokio::sync::Mutex<()>,
    capture_gate: tokio::sync::Mutex<()>,
    dispatch_gate: tokio::sync::Mutex<()>,
    handoff: tokio::sync::Mutex<()>,
    verified: Mutex<BTreeMap<String, i64>>,
    inflight: Mutex<BTreeMap<LosslessString, Cancellation>>,
    capture_failed: AtomicBool,
    delivery_failed: AtomicBool,
    stop: Cancellation,
    worker: Mutex<Option<tokio::task::JoinHandle<Result<(), Failure>>>>,
}

impl Service {
    pub fn new(deps: Dependencies) -> Self {
        Self {
            deps,
            loaded: OnceLock::new(),
            mutations: tokio::sync::Mutex::new(()),
            capture_gate: tokio::sync::Mutex::new(()),
            dispatch_gate: tokio::sync::Mutex::new(()),
            handoff: tokio::sync::Mutex::new(()),
            verified: Mutex::new(BTreeMap::new()),
            inflight: Mutex::new(BTreeMap::new()),
            capture_failed: AtomicBool::new(false),
            delivery_failed: AtomicBool::new(false),
            stop: Cancellation::default(),
            worker: Mutex::new(None),
        }
    }

    pub async fn status(&self) -> bool {
        if self.stop.is_cancelled()
            || self.capture_failed.load(Ordering::Acquire)
            || self.delivery_failed.load(Ordering::Acquire)
        {
            return false;
        }
        matches!(
            self.deps
                .authorization
                .capabilities(self.stop.clone())
                .await,
            Ok(true)
        ) && self.secret_box().is_ok()
    }
    pub fn list(&self) -> mcp_events::ListResult {
        mcp_events::definitions()
    }

    fn secret_box(&self) -> Result<Arc<secret_box::SecretBox>, Failure> {
        match &self.deps.secrets {
            Secrets::Memory(value) => Ok(value.clone()),
            Secrets::File(path) => self
                .loaded
                .get_or_init(|| {
                    secret_box::SecretBox::load_or_create(path)
                        .map(Arc::new)
                        .map_err(|_| secure_storage())
                })
                .clone(),
        }
    }

    pub async fn subscribe(
        &self,
        context: RequestContext,
        input: Subscribe,
        cancellation: Cancellation,
    ) -> Result<Subscription, Failure> {
        let _mutation = self.mutations.lock().await;
        let input = Subscribe::decode(&input.encode()).map_err(|_| {
            failure(
                FailureCategory::InvalidParams,
                FailureReason::InvalidArguments,
            )
        })?;
        let context = RequestContext::decode(&context.encode()).map_err(|_| {
            failure(
                FailureCategory::Unauthorized,
                FailureReason::UnauthorizedPrincipal,
            )
        })?;
        self.require_active(&cancellation)?;
        if !self
            .deps
            .authorization
            .capabilities(cancellation.clone())
            .await?
        {
            return Err(authorization_unavailable());
        }
        let key = tuple_key(&[KeyPart::String(input.arguments.session_id.as_lossless())]);
        if self
            .deps
            .store
            .snapshot()
            .map_err(storage)?
            .get::<SessionTable>(&key)
            .map_err(storage)?
            .is_none()
        {
            return Err(failure(
                FailureCategory::InvalidParams,
                FailureReason::SessionNotFound,
            ));
        }
        let url = utf8(&input.delivery.url)?;
        if protected_http::callback_url(&url).is_err() {
            return Err(failure(
                FailureCategory::InvalidParams,
                FailureReason::InvalidDelivery,
            ));
        }
        let secret = secret_box::decode_secret(&utf8(&input.delivery.secret)?)
            .map_err(|_| failure(FailureCategory::InvalidParams, FailureReason::InvalidSecret))?;
        let now = (self.deps.clock)();
        let grant = self
            .deps
            .authorization
            .resolve(context.clone(), cancellation.clone())
            .await?;
        if grant.expires_at <= now {
            return Err(failure(
                FailureCategory::Unauthorized,
                FailureReason::GrantExpired,
            ));
        }
        let principal = Principal {
            owner_id: context.principal.owner_id,
            device_id: context.principal.device_id,
            client_id: context.principal.client_id,
            grant_id: grant.grant_id,
            epoch: context.epoch,
        };
        let identity = identity::subscription(
            &principal,
            &input.delivery.url,
            input.name,
            &input.arguments,
        );
        let box_ = self.secret_box()?;
        let replay = match &input.cursor {
            Presence::Value(cursor) => {
                if !identity::replayable(input.name) {
                    return Err(invalid_cursor());
                }
                Some(
                    box_.decode_cursor(&utf8(&identity.hash)?, &utf8(cursor)?)
                        .ok_or_else(invalid_cursor)?,
                )
            }
            _ => None,
        };
        let ttl = match input.ttl_ms {
            Presence::Value(ttl) => Some(ttl.get()),
            _ => None,
        };
        let expires = identity::ttl(now, ttl, grant.expires_at);
        if expires <= now {
            return Err(failure(
                FailureCategory::Unauthorized,
                FailureReason::GrantExpired,
            ));
        }
        self.verify(
            &principal,
            &identity,
            &url,
            &secret,
            &box_,
            cancellation.clone(),
        )
        .await?;
        let permit = self
            .deps
            .authorization
            .check(principal.clone(), cancellation.clone())
            .await?;
        self.require_active(&cancellation)?;
        let confirmed = (self.deps.clock)();
        if permit.cancellation.is_cancelled()
            || permit.expires_at <= confirmed
            || expires <= confirmed
        {
            return Err(failure(
                FailureCategory::Unauthorized,
                FailureReason::GrantExpired,
            ));
        }
        let fingerprint = box_.fingerprint(&secret);
        let encrypted = box_.encrypt(&secret).map_err(|_| secure_storage())?;
        let name = input.name.as_str();
        let id = identity.id.clone();
        let scope = identity.hash.clone();
        self.deps
            .store
            .submit(move |tx| {
                let old = tx.get::<SubscriptionTable>(&tuple_key(&[KeyPart::String(&id)]))?;
                if old.as_ref().is_some_and(|row| row.identity_hash != scope) {
                    return Err(tx.reject(ycoding_store::Error::Rejected(
                        "MCP Events subscription identity mismatch",
                    )));
                }
                let rotated = old.as_ref().is_some_and(|old| {
                    old.secret_fingerprint.as_str() != Some(fingerprint.as_str())
                });
                let previous = if rotated {
                    old.as_ref().map(|row| row.secret_ciphertext.clone())
                } else {
                    old.as_ref()
                        .and_then(|row| row.previous_secret_ciphertext.clone())
                };
                let previous_until = if rotated {
                    Some(confirmed.saturating_add(120_000))
                } else {
                    old.as_ref().and_then(|row| row.previous_secret_until)
                };
                SubscriptionTable::put(
                    tx,
                    &ycoding_store::mcp_events::Subscription {
                        id,
                        identity_hash: scope,
                        owner_id: principal.owner_id,
                        device_id: principal.device_id,
                        client_id: principal.client_id,
                        grant_id: principal.grant_id,
                        epoch: principal.epoch,
                        name: name.into(),
                        session_id: input.arguments.session_id.into_lossless(),
                        include_descendants: i64::from(input.arguments.include_descendants),
                        callback_url: input.delivery.url,
                        secret_ciphertext: encrypted.into(),
                        secret_fingerprint: fingerprint.into(),
                        previous_secret_ciphertext: previous,
                        previous_secret_until: previous_until,
                        expires_at: expires.min(permit.expires_at),
                        disabled: 0,
                        pruned_through: old.as_ref().map_or(0, |row| row.pruned_through),
                        time_created: old.as_ref().map_or(now, |row| row.time_created),
                        time_updated: confirmed,
                    },
                )
            })
            .map_err(storage)?
            .await
            .map_err(storage)?;
        if let Some(after) = replay {
            self.replay(&identity.id, after, confirmed).await?;
        }
        let (watermark, pruned) = self.watermark(&identity.id).await?;
        Ok(Subscription {
            id: identity.id,
            refresh_before: Some(timestamp(expires.min(permit.expires_at))?.into()),
            cursor: if identity::replayable(input.name) {
                Some(
                    box_.encode_cursor(&utf8(&identity.hash)?, watermark)
                        .ok_or_else(invalid_cursor)?
                        .into(),
                )
            } else {
                None
            },
            truncated: replay.is_some_and(|cursor| cursor < pruned),
        })
    }

    async fn verify(
        &self,
        principal: &Principal,
        identity: &identity::Identity,
        url: &str,
        secret: &[u8],
        box_: &secret_box::SecretBox,
        cancellation: Cancellation,
    ) -> Result<(), Failure> {
        let cache = ObjectEncoder::new()
            .field("principal", principal)
            .field("url", url)
            .finish();
        let cache = format!(
            "{}:{}",
            box_.fingerprint(identity::canonical_json(&cache).as_bytes()),
            box_.fingerprint(secret)
        );
        let now = (self.deps.clock)();
        {
            let mut verified = self
                .verified
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            verified.retain(|_, expires| *expires > now);
            if verified.get(&cache).is_some_and(|expires| *expires > now) {
                return Ok(());
            }
        }
        let challenge = crate::resources::mcp::skills::encode_base64(
            &crate::platform::random::<24>().map_err(|_| unavailable())?,
            true,
        );
        let body = ycoding_schema::stringify_json(
            &ObjectEncoder::new()
                .field("type", "verification")
                .field("challenge", challenge.as_str())
                .finish(),
        );
        let id = random_id("msg_verification_")?;
        let timestamp = now / 1000;
        let response = self
            .send(
                HttpRequest {
                    url: url.to_owned(),
                    body: body.clone(),
                    headers: delivery::headers(
                        &utf8(&id)?,
                        timestamp,
                        &body,
                        &[secret],
                        &utf8(&identity.id)?,
                    ),
                    timeout_ms: 10_000,
                },
                cancellation.clone(),
                None,
            )
            .await?;
        if !(200..300).contains(&response.status) {
            return Err(failure(
                FailureCategory::CallbackEndpoint,
                FailureReason::ChallengeFailed,
            ));
        }
        let parsed = ycoding_schema::parse_json(&response.body).ok();
        let actual = parsed
            .as_ref()
            .and_then(|value| match value {
                JsonValue::Object(object) => object.get(&"challenge".into()),
                _ => None,
            })
            .and_then(|value| match value {
                JsonValue::String(value) => value.as_str(),
                _ => None,
            })
            .ok_or_else(|| {
                failure(
                    FailureCategory::CallbackEndpoint,
                    FailureReason::ChallengeFailed,
                )
            })?;
        let comparison = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, challenge.as_bytes());
        let expected = ring::hmac::sign(&comparison, challenge.as_bytes());
        if actual.len() != challenge.len()
            || ring::hmac::verify(&comparison, actual.as_bytes(), expected.as_ref()).is_err()
        {
            return Err(failure(
                FailureCategory::CallbackEndpoint,
                FailureReason::ChallengeFailed,
            ));
        }
        self.require_active(&cancellation)?;
        self.verified
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(cache, now.saturating_add(300_000));
        Ok(())
    }

    pub async fn unsubscribe(
        &self,
        context: RequestContext,
        input: Unsubscribe,
        cancellation: Cancellation,
    ) -> Result<(), Failure> {
        let _mutation = self.mutations.lock().await;
        self.require_active(&cancellation)?;
        let context = RequestContext::decode(&context.encode()).map_err(|_| {
            failure(
                FailureCategory::Unauthorized,
                FailureReason::UnauthorizedPrincipal,
            )
        })?;
        let input = Unsubscribe::decode(&input.encode()).map_err(|_| {
            failure(
                FailureCategory::InvalidParams,
                FailureReason::InvalidArguments,
            )
        })?;
        if !self
            .deps
            .authorization
            .capabilities(cancellation.clone())
            .await?
        {
            return Err(authorization_unavailable());
        }
        let grant = self
            .deps
            .authorization
            .resolve(context.clone(), cancellation.clone())
            .await?;
        if grant.expires_at <= (self.deps.clock)() {
            return Err(failure(
                FailureCategory::Unauthorized,
                FailureReason::GrantExpired,
            ));
        }
        let principal = Principal {
            owner_id: context.principal.owner_id,
            device_id: context.principal.device_id,
            client_id: context.principal.client_id,
            grant_id: grant.grant_id,
            epoch: context.epoch,
        };
        let id = identity::subscription(
            &principal,
            &input.delivery.url,
            input.name,
            &input.arguments,
        )
        .id;
        let handoff = self.handoff.lock().await;
        self.abort_subscription(&id);
        let now = (self.deps.clock)();
        let saved = id.clone();
        self.deps
            .store
            .submit(move |tx| {
                let key = tuple_key(&[KeyPart::String(&saved)]);
                if let Some(mut row) = tx.get::<SubscriptionTable>(&key)? {
                    row.disabled = 1;
                    row.time_updated = now;
                    SubscriptionTable::put(tx, &row)?;
                }
                Ok(())
            })
            .map_err(storage)?
            .await
            .map_err(storage)?;
        drop(handoff);
        let mut after = None;
        loop {
            let prefix = tuple_key(&[KeyPart::String(&id)]);
            let rows = self
                .deps
                .store
                .snapshot()
                .map_err(storage)?
                .index_range::<OutboxTable>(
                    "mcp_event_outbox_subscription_seq_idx",
                    IndexQuery {
                        lower: Bound::Unbounded,
                        upper: Bound::Unbounded,
                        prefix: Some(&prefix),
                        order: IndexOrder::Ascending,
                        after: after.as_ref(),
                        limit: 100,
                    },
                )
                .map_err(storage)?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(|entry| entry.cursor.clone());
            self.deps
                .store
                .submit(move |tx| {
                    for entry in rows {
                        if let Some(mut row) =
                            tx.get::<OutboxTable>(&OutboxTable::primary_key(&entry.record))?
                        {
                            row.dead = 1;
                            OutboxTable::put(tx, &row)?;
                        }
                    }
                    Ok(())
                })
                .map_err(storage)?
                .await
                .map_err(storage)?;
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    fn require_active(&self, cancellation: &Cancellation) -> Result<(), Failure> {
        if self.capture_failed.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        if self.stop.is_cancelled() || cancellation.is_cancelled() {
            return Err(authorization_unavailable());
        }
        Ok(())
    }
    fn abort_subscription(&self, id: &LosslessString) {
        if let Some(token) = self
            .inflight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
        {
            token.cancel();
        }
    }
    pub fn close(&self) {
        self.stop.cancel();
        for token in self
            .inflight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
        {
            token.cancel();
        }
    }
    pub async fn shutdown(&self) -> Result<(), Failure> {
        self.close();
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            worker.await.map_err(|_| unavailable())??;
        }
        Ok(())
    }

    pub fn start(self: &Arc<Self>, feed: Feed) -> Result<(), Failure> {
        let notify = Arc::new(tokio::sync::Notify::new());
        let wake = notify.clone();
        let subscriber = feed
            .subscribe_types(Scope::Global, capture::TYPES, move || wake.notify_one())
            .map_err(|_| unavailable())?;
        let mut owner = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if owner.is_some() {
            return Err(unavailable());
        }
        let weak = Arc::downgrade(self);
        let stop = self.stop.clone();
        *owner = Some(tokio::spawn(async move {
            if let Some(service) = weak.upgrade()
                && let Err(error) = service.reconcile().await
            {
                service.capture_failed.store(true, Ordering::Release);
                return Err(error);
            }
            let mut capture = tokio::spawn({
                let weak = weak.clone();
                let stop = stop.clone();
                async move {
                    loop {
                        tokio::select! {biased;_=stop.cancelled()=>{if let Some(service)=weak.upgrade(){service.consume(&subscriber).await?;}return Ok::<_,Failure>(());},_=notify.notified()=>{}}
                        let Some(service) = weak.upgrade() else {
                            return Ok(());
                        };
                        if let Err(error) = service.consume(&subscriber).await {
                            service.capture_failed.store(true, Ordering::Release);
                            tracing::error!("MCP Events capture is unavailable");
                            return Err(error);
                        }
                    }
                }
            });
            let mut delivery = tokio::spawn({
                let weak = weak.clone();
                let stop = stop.clone();
                async move {
                    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
                    loop {
                        tokio::select! {biased;_=stop.cancelled()=>return Ok::<_,Failure>(()),_=tick.tick()=>{}}
                        let Some(service) = weak.upgrade() else {
                            return Ok(());
                        };
                        let failed = service.dispatch_once(stop.clone()).await.is_err();
                        if stop.is_cancelled() {
                            return Ok(());
                        }
                        let old = service.delivery_failed.swap(failed, Ordering::AcqRel);
                        if failed && !old {
                            tracing::error!("MCP Events delivery is unavailable");
                        }
                    }
                }
            });
            tokio::select! {
                result=&mut capture=>{stop.cancel();delivery.await.map_err(|_|unavailable())??;result.map_err(|_|unavailable())?},
                result=&mut delivery=>{stop.cancel();capture.await.map_err(|_|unavailable())??;result.map_err(|_|unavailable())?},
            }
        }));
        Ok(())
    }

    pub async fn consume(&self, subscriber: &Subscriber) -> Result<(), Failure> {
        loop {
            let item = match subscriber.next() {
                Ok(Some(item)) => item,
                Ok(None) => return Ok(()),
                Err(_) => {
                    self.capture_failed.store(true, Ordering::Release);
                    return Err(unavailable());
                }
            };
            let input = match &item.payload {
                FeedPayload::Durable(event) => EventInput {
                    event_type: event.type_.clone(),
                    id: event.id.clone(),
                    created: event.created,
                    data: event.data.clone(),
                },
                FeedPayload::Ephemeral(event) => EventInput {
                    event_type: event.data.name().into(),
                    id: event.id.clone(),
                    created: event.created,
                    data: event.data.encode(),
                },
            };
            if let Err(error) = self.capture(input).await {
                self.capture_failed.store(true, Ordering::Release);
                return Err(error);
            }
        }
    }

    async fn send(
        &self,
        request: HttpRequest,
        cancellation: Cancellation,
        authority: Option<Cancellation>,
    ) -> Result<HttpResponse, Failure> {
        let combined = Cancellation::default();
        let authority = authority.unwrap_or_default();
        self.require_active(&cancellation)?;
        if authority.is_cancelled() {
            return Err(failure(
                FailureCategory::Unauthorized,
                FailureReason::GrantRevoked,
            ));
        }
        let timeout = std::time::Duration::from_millis(request.timeout_ms.min(10_000));
        tokio::select! {
            biased;
            _=self.stop.cancelled()=>{combined.cancel();Err(authorization_unavailable())},
            _=cancellation.cancelled()=>{combined.cancel();Err(authorization_unavailable())},
            _=authority.cancelled()=>{combined.cancel();Err(failure(FailureCategory::Unauthorized,FailureReason::GrantRevoked))},
            result=tokio::time::timeout(timeout,self.deps.transport.send(request,combined.clone()))=>{combined.cancel();result.map_err(|_|failure(FailureCategory::CallbackEndpoint,FailureReason::Timeout))?},
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(worker) = self
            .worker
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            worker.abort();
        }
    }
}
pub(crate) fn failure(category: FailureCategory, reason: FailureReason) -> Failure {
    Failure { category, reason }
}
pub(crate) fn unavailable() -> Failure {
    failure(
        FailureCategory::Unavailable,
        FailureReason::ServiceUnavailable,
    )
}
pub(crate) fn authorization_unavailable() -> Failure {
    failure(
        FailureCategory::Unavailable,
        FailureReason::AuthorizationUnavailable,
    )
}
fn secure_storage() -> Failure {
    failure(
        FailureCategory::Unavailable,
        FailureReason::SecureStorageUnavailable,
    )
}
fn invalid_cursor() -> Failure {
    failure(FailureCategory::InvalidParams, FailureReason::InvalidCursor)
}
pub(crate) fn storage(_: ycoding_store::Error) -> Failure {
    unavailable()
}
pub(crate) fn utf8(value: &LosslessString) -> Result<String, Failure> {
    value.to_utf8().map_err(|_| unavailable())
}
pub(crate) fn random_id(prefix: &str) -> Result<LosslessString, Failure> {
    Ok(format!(
        "{prefix}{}",
        crate::platform::random::<16>()
            .map_err(|_| unavailable())?
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
    .into())
}
pub(crate) fn timestamp(value: i64) -> Result<String, Failure> {
    chrono::DateTime::from_timestamp_millis(value)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(unavailable)
}
