use crate::{
    event_feed::{Feed, Payload, Scope as FeedScope},
    process::guardrails::is_whitespace,
    regexp::{Budget, RegExp},
    resources::{
        agent,
        memory::{self, Scope},
    },
    session::store::Service as SessionStore,
    tools::{
        code_mode::Cancellation,
        policy::{Effect, helper::Role, permissions::Permissions},
    },
};
use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{sync::Notify, task::JoinHandle};
use ycoding_schema::{JsonValue, LosslessString, ObjectEncoder, location, session};

pub const RECENT_USER_UNITS: usize = 2_000;
pub const RECENT_ASSISTANT_UNITS: usize = 4_000;
const SNIPPET_LIMIT: usize = 3;
const TITLE_UNITS: usize = 200;
const SNIPPET_UNITS: usize = 600;

pub struct Request<'a> {
    pub session: &'a session::Info,
    pub role: Role,
    pub source: &'static str,
    pub agent: &'a ycoding_schema::agent::Info,
    pub user: String,
    pub character_limit: usize,
    pub cancellation: &'a Cancellation,
    pub attribution: crate::session::usage_attribution::Attribution,
}

pub type Generation<'a> = Pin<Box<dyn Future<Output = Option<String>> + Send + 'a>>;

pub trait Generate: Send + Sync {
    fn resolves(
        &self,
        session: &session::Info,
        role: Role,
        agent: &ycoding_schema::agent::Info,
    ) -> bool;

    fn generate<'a>(&'a self, request: Request<'a>) -> Generation<'a>;
}

#[derive(Clone)]
pub struct Dependencies {
    pub store: SessionStore,
    pub agents: Arc<agent::Service>,
    pub generate: Arc<dyn Generate>,
    pub memory: Arc<memory::Service>,
    pub permissions: Permissions,
    pub feed: Feed,
    pub location: location::Ref,
}

#[derive(Clone, Default)]
pub struct Active(Arc<Registry>);

#[derive(Default)]
struct Registry {
    next: AtomicU64,
    entries: Mutex<BTreeMap<session::Id, (u64, Cancellation)>>,
}

pub struct Ticket {
    registry: Arc<Registry>,
    session: session::Id,
    serial: u64,
    pub cancellation: Cancellation,
    watcher: JoinHandle<()>,
}

impl Active {
    pub fn begin(
        &self,
        feed: &Feed,
        session: &session::Id,
        cancelling_events: &'static [&'static str],
    ) -> Ticket {
        let serial = self.0.next.fetch_add(1, Ordering::Relaxed);
        let cancellation = Cancellation::default();
        let prior = self
            .0
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.clone(), (serial, cancellation.clone()));
        if let Some((_, prior)) = prior {
            prior.cancel();
        }
        Ticket {
            registry: self.0.clone(),
            session: session.clone(),
            serial,
            watcher: watch(feed, session, cancelling_events, cancellation.clone()),
            cancellation,
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        self.watcher.abort();
        let mut entries = self
            .registry
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if entries
            .get(&self.session)
            .is_some_and(|(serial, _)| *serial == self.serial)
        {
            entries.remove(&self.session);
        }
    }
}

fn watch(
    feed: &Feed,
    session: &session::Id,
    cancelling_events: &'static [&'static str],
    cancellation: Cancellation,
) -> JoinHandle<()> {
    let wake = Arc::new(Notify::new());
    let signal = wake.clone();
    let subscriber = feed.subscribe(FeedScope::Session(session.clone()), None, move || {
        signal.notify_one()
    });
    tokio::spawn(async move {
        let Ok(subscriber) = subscriber else {
            cancellation.cancel();
            return;
        };
        loop {
            wake.notified().await;
            loop {
                match subscriber.next() {
                    Err(_) => return cancellation.cancel(),
                    Ok(None) => break,
                    Ok(Some(item)) => {
                        if let Payload::Durable(event) = &item.payload
                            && cancelling_events
                                .contains(&event_name(&event.type_.to_utf8().unwrap_or_default()))
                        {
                            return cancellation.cancel();
                        }
                    }
                }
            }
        }
    })
}

fn event_name(versioned: &str) -> &str {
    match versioned.rsplit_once('.') {
        Some((name, version)) if version.bytes().all(|byte| byte.is_ascii_digit()) => name,
        _ => versioned,
    }
}

pub fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

pub fn head(value: &str, limit: usize) -> String {
    String::from_utf16_lossy(&units(value)[..units(value).len().min(limit)])
}

pub fn tail(value: &str, limit: usize) -> String {
    let units = units(value);
    String::from_utf16_lossy(&units[units.len().saturating_sub(limit)..])
}

pub fn trim(value: &str) -> String {
    let units = units(value);
    let start = units
        .iter()
        .position(|unit| !is_whitespace(*unit))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|unit| !is_whitespace(*unit))
        .map_or(start, |index| index + 1);
    String::from_utf16_lossy(&units[start..end])
}

pub fn matches(pattern: &str, flags: &str, text: &str) -> bool {
    RegExp::new(&units(pattern), flags)
        .and_then(|mut expression| expression.test(&units(text), &mut Budget::unlimited()))
        .expect("static helper pattern evaluates")
}

pub fn assistant_text(content: &[ycoding_schema::session_message::AssistantContent]) -> String {
    content
        .iter()
        .filter_map(|part| match part {
            ycoding_schema::session_message::AssistantContent::Text(text) => {
                Some(text.text.to_utf8().unwrap_or_default())
            }
            _ => None,
        })
        .collect()
}

pub fn snippets(
    dependencies: &Dependencies,
    session: &session::Id,
    acting_agent: Option<&LosslessString>,
    scopes: &[Scope],
    query: &str,
) -> Vec<JsonValue> {
    scopes
        .iter()
        .flat_map(|scope| scope_snippets(dependencies, session, acting_agent, *scope, query))
        .collect()
}

fn scope_snippets(
    dependencies: &Dependencies,
    session: &session::Id,
    acting_agent: Option<&LosslessString>,
    scope: Scope,
    query: &str,
) -> Vec<JsonValue> {
    let Ok(status) = dependencies.memory.status(scope) else {
        return Vec::new();
    };
    if !status.enabled {
        return Vec::new();
    }
    let resource = LosslessString::from(status.root.to_string_lossy().as_ref());
    let Ok(access) = dependencies.permissions.evaluate_effective(
        session,
        acting_agent,
        &"memory_read".into(),
        &resource,
    ) else {
        return Vec::new();
    };
    if access == Effect::Deny {
        return Vec::new();
    }
    let Ok(result) = dependencies.memory.search(
        scope,
        memory::Search {
            query,
            limit: Some(SNIPPET_LIMIT),
            type_: None,
            tag: None,
        },
    ) else {
        return Vec::new();
    };
    result
        .hits
        .iter()
        .take(SNIPPET_LIMIT)
        .map(|hit| {
            ObjectEncoder::new()
                .field(
                    "scope",
                    match scope {
                        Scope::Repository => "repository",
                        Scope::Knowledge => "knowledge",
                    },
                )
                .field("id", hit.summary.id.as_str())
                .optional(
                    "title",
                    &hit.summary.title.as_ref().map(|title| {
                        LosslessString::from(
                            head(&title.to_utf8().unwrap_or_default(), TITLE_UNITS).as_str(),
                        )
                    }),
                )
                .field(
                    "snippet",
                    head(&hit.snippet.to_utf8().unwrap_or_default(), SNIPPET_UNITS).as_str(),
                )
                .finish()
        })
        .collect()
}
