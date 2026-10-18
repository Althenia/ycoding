use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    ops::Bound,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
};
use ycoding_core::mcp_events::{
    Authorization, Cancellation, Dependencies, EventInput, Grant, HttpRequest, HttpResponse,
    Permit, ResultFuture, Secrets, Service, Transport, secret_box::SecretBox,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, LosslessString,
    mcp_events::{Failure, Principal, RequestContext, Subscribe},
};
use ycoding_store::{
    Metadata, Options, Store,
    import::{self, DatabaseKind},
    mcp_events::{Outbox, OutboxTable, Subscription, SubscriptionTable},
    project, session,
};

pub const NOW: i64 = 1_800_000_000_000;
pub const DAY: i64 = 86_400_000;
pub const SECRET: &str = "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
pub const ROTATED: &str = "whsec_AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

pub fn decode<T: DomainDecode>(value: Value) -> T {
    T::decode(&ycoding_schema::parse_json(&value.to_string()).unwrap()).unwrap()
}

pub fn encoded<T: DomainEncode>(value: &T) -> Value {
    serde_json::from_str(&ycoding_schema::stringify_json(&value.encode())).unwrap()
}

pub fn failure(category: &str, reason: &str) -> Failure {
    decode(json!({"_tag":"McpEvents.Failure","category":category,"reason":reason}))
}

pub fn context() -> RequestContext {
    decode(
        json!({"requestID":"forwarded_synthetic","principal":{"ownerID":"owner_synthetic","deviceID":"device_synthetic","clientID":"client_synthetic"},"epoch":"epoch_synthetic"}),
    )
}

pub fn subscription(name: &str, descendants: bool) -> Subscribe {
    decode(
        json!({"name":name,"arguments":{"session_id":"ses_root","include_descendants":descendants},"delivery":{"mode":"webhook","url":"https://callback.invalid/events","secret":SECRET}}),
    )
}

pub fn event(kind: &str, id: &str, data: Value) -> EventInput {
    EventInput {
        event_type: kind.into(),
        id: id.into(),
        created: NOW,
        data: ycoding_schema::parse_json(&data.to_string()).unwrap(),
    }
}

pub struct Authority {
    pub available: AtomicI64,
    pub grant: Mutex<(LosslessString, i64)>,
    pub rejection: Mutex<Option<Failure>>,
    pub resolves: Mutex<Vec<RequestContext>>,
    pub checks: Mutex<Vec<Principal>>,
    pub generation: Mutex<Cancellation>,
}

impl Default for Authority {
    fn default() -> Self {
        Self {
            available: AtomicI64::new(1),
            grant: Mutex::new(("grant_synthetic".into(), NOW + 10 * DAY)),
            rejection: Mutex::new(None),
            resolves: Mutex::new(vec![]),
            checks: Mutex::new(vec![]),
            generation: Mutex::new(Cancellation::default()),
        }
    }
}

impl Authorization for Authority {
    fn capabilities(&self, cancelled: Cancellation) -> ResultFuture<'_, bool> {
        Box::pin(async move {
            Ok(!cancelled.is_cancelled() && self.available.load(Ordering::Acquire) == 1)
        })
    }
    fn resolve(&self, input: RequestContext, cancelled: Cancellation) -> ResultFuture<'_, Grant> {
        Box::pin(async move {
            if cancelled.is_cancelled() {
                return Err(failure("unavailable", "authorization_unavailable"));
            }
            self.resolves.lock().unwrap().push(input);
            if let Some(error) = self.rejection.lock().unwrap().clone() {
                return Err(error);
            }
            let grant = self.grant.lock().unwrap();
            Ok(Grant {
                grant_id: grant.0.clone(),
                expires_at: grant.1,
            })
        })
    }
    fn check(&self, principal: Principal, cancelled: Cancellation) -> ResultFuture<'_, Permit> {
        Box::pin(async move {
            self.checks.lock().unwrap().push(principal.clone());
            if cancelled.is_cancelled() {
                return Err(failure("unavailable", "authorization_unavailable"));
            }
            if let Some(error) = self.rejection.lock().unwrap().clone() {
                return Err(error);
            }
            let grant = self.grant.lock().unwrap();
            if principal.grant_id != grant.0 {
                return Err(failure("unauthorized", "grant_revoked"));
            }
            Ok(Permit {
                expires_at: grant.1,
                cancellation: self.generation.lock().unwrap().clone(),
            })
        })
    }
}

pub enum Reply {
    Status(u16),
    Failure(Failure),
    Wait(Arc<tokio::sync::Notify>),
}

#[derive(Default)]
pub struct Callback {
    pub requests: Mutex<Vec<HttpRequest>>,
    pub replies: Mutex<VecDeque<Reply>>,
    pub verification_replies: Mutex<VecDeque<HttpResponse>>,
    pub after_verification: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl Callback {
    pub fn deliveries(&self) -> Vec<HttpRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| !request.body.contains("\"verification\""))
            .cloned()
            .collect()
    }
}

impl Transport for Callback {
    fn send(
        &self,
        request: HttpRequest,
        cancellation: Cancellation,
    ) -> ResultFuture<'_, HttpResponse> {
        Box::pin(async move {
            let body: Value = serde_json::from_str(&request.body).unwrap();
            self.requests.lock().unwrap().push(request);
            if body["type"] == "verification" {
                if let Some(action) = self.after_verification.lock().unwrap().clone() {
                    action();
                }
                if let Some(response) = self.verification_replies.lock().unwrap().pop_front() {
                    return Ok(response);
                }
                return Ok(HttpResponse {
                    status: 200,
                    body: json!({"challenge":body["challenge"]}).to_string(),
                });
            }
            let reply = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Reply::Status(204));
            match reply {
                Reply::Status(status) => Ok(HttpResponse {
                    status,
                    body: String::new(),
                }),
                Reply::Failure(error) => Err(error),
                Reply::Wait(started) => {
                    started.notify_one();
                    cancellation.cancelled().await;
                    Err(failure("callback_endpoint", "endpoint_unreachable"))
                }
            }
        })
    }
}

pub struct Fixture {
    pub store: Store,
    pub service: Arc<Service>,
    pub authority: Arc<Authority>,
    pub callback: Arc<Callback>,
    pub clock: Arc<AtomicI64>,
}

impl Fixture {
    pub fn new() -> Self {
        let store = Store::disposable(
            Options::core(),
            import::catalog(DatabaseKind::Core),
            Metadata::new([91; 16], 1),
        )
        .unwrap();
        store
            .submit(|tx| {
                project::ProjectTable::insert(
                    tx,
                    &project::Project {
                        id: "prj_synthetic".into(),
                        worktree: "/synthetic-project".into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: NOW,
                        time_updated: NOW,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )?;
                for (id, parent) in [
                    ("ses_root", None),
                    ("ses_child", Some("ses_root")),
                    ("ses_grandchild", Some("ses_child")),
                    ("ses_other", None),
                ] {
                    session::SessionTable::insert(
                        tx,
                        &session::Session {
                            id: id.into(),
                            project_id: "prj_synthetic".into(),
                            workspace_id: None,
                            parent_id: parent.map(Into::into),
                            fork_session_id: None,
                            fork_message_id: None,
                            fork_seq: None,
                            directory: "/synthetic-project".into(),
                            path: None,
                            title: "synthetic".into(),
                            cost: 0.0,
                            tokens_input: 0,
                            tokens_output: 0,
                            tokens_reasoning: 0,
                            tokens_cache_read: 0,
                            tokens_cache_write: 0,
                            revert: None,
                            permission: None,
                            autonomy: None,
                            autonomy_revision: 0,
                            orchestration_revision: 0,
                            agent: None,
                            model: None,
                            profile_binding: None,
                            daybreak: None,
                            time_created: NOW,
                            time_updated: NOW,
                            time_archived: None,
                            time_active: None,
                            time_pinned: None,
                            time_suspended: None,
                            usage_pruned_through: None,
                        },
                    )?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
        let authority = Arc::new(Authority::default());
        let callback = Arc::new(Callback::default());
        let clock = Arc::new(AtomicI64::new(NOW));
        let service = Arc::new(Service::new(Dependencies {
            store: store.client(),
            authorization: authority.clone(),
            transport: callback.clone(),
            secrets: Secrets::Memory(Arc::new(SecretBox::new([92; 32]))),
            clock: {
                let clock = clock.clone();
                Arc::new(move || clock.load(Ordering::Acquire))
            },
        }));
        Self {
            store,
            service,
            authority,
            callback,
            clock,
        }
    }

    pub async fn subscribe(&self, name: &str) -> ycoding_schema::mcp_events::Subscription {
        self.service
            .subscribe(
                context(),
                subscription(name, false),
                Cancellation::default(),
            )
            .await
            .unwrap()
    }

    pub fn subscriptions(&self) -> Vec<Subscription> {
        self.store
            .snapshot()
            .unwrap()
            .scan::<SubscriptionTable>(Bound::Unbounded, Bound::Unbounded, 1000)
            .unwrap()
    }

    pub fn outbox(&self) -> Vec<Outbox> {
        self.store
            .snapshot()
            .unwrap()
            .scan::<OutboxTable>(Bound::Unbounded, Bound::Unbounded, 1000)
            .unwrap()
    }

    pub async fn capture(&self, kind: &str, id: &str, data: Value) {
        let mut input = event(kind, id, data);
        input.created = self.clock.load(Ordering::Acquire);
        self.service.capture(input).await.unwrap();
    }

    pub async fn dispatch(&self) {
        self.service
            .dispatch_once(Cancellation::default())
            .await
            .unwrap();
    }
}
