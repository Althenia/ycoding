use super::{
    Client, CursorAttempt, Error, Poll,
    integration::{Authorization, Draft, OAuthImplementation},
    jwt, now, string,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fmt,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};
use ycoding_schema::{LosslessString, integration, integration_id::IntegrationMethodId};
use ycoding_store::resources::Secret;

const INTEGRATION: &str = "cursor";

pub fn register(draft: &mut Draft, client: Client, website: String) {
    let id = LosslessString::from(INTEGRATION);
    draft.update(id.clone(), |reference| reference.name = "Cursor".into());
    let login = client.clone();
    draft.oauth(OAuthImplementation {
        integration: id.clone(),
        method: integration::OAuthMethod {
            id: IntegrationMethodId::new("browser").expect("static method ID"),
            label: "Cursor account (browser login)".into(),
            prompts: None,
            remote: Some(true),
        },
        authorize: Arc::new(move |_| {
            let client = login.clone();
            let website = website.clone();
            Box::pin(async move {
                let attempt = client.start_cursor(&website, now()?)?;
                Ok(Authorization::automatic(
                    attempt.url().to_owned(),
                    "Complete sign-in to Cursor in your browser.".into(),
                    Box::pin(poll_until_complete(attempt)),
                    None,
                    None,
                ))
            })
        }),
        refresh: Some(Arc::new(move |value| {
            let client = client.clone();
            Box::pin(async move { client.refresh(INTEGRATION, value, now()?).await })
        })),
        label: None,
    });
    draft.method(
        id.clone(),
        integration::Method::Key(integration::KeyMethod {
            label: Some("Cursor API key (crsr_…)".into()),
        }),
    );
    draft.method(
        id,
        integration::Method::Env(integration::EnvMethod {
            names: vec!["CURSOR_API_KEY".into()],
        }),
    );
}

async fn poll_until_complete(mut attempt: CursorAttempt) -> Result<Secret, Error> {
    loop {
        let time = now()?;
        match attempt.poll(time).await? {
            Poll::Complete(secret) => return Ok(secret),
            Poll::WaitUntil(until) => {
                tokio::time::sleep(Duration::from_millis(
                    until.saturating_sub(time).max(0) as u64
                ))
                .await
            }
        }
    }
}

#[derive(Clone)]
struct Pair {
    access: String,
    refresh: String,
}
type Resolution = Result<String, Error>;
struct State {
    closed: bool,
    cache: BTreeMap<String, Pair>,
    pending: BTreeMap<String, watch::Receiver<Option<Resolution>>>,
    tasks: Vec<JoinHandle<()>>,
}
struct Inner {
    client: Client,
    state: Mutex<State>,
}
#[derive(Clone)]
pub struct Store(Arc<Inner>);
impl fmt::Debug for Store {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CursorAuth([redacted])")
    }
}
impl Store {
    pub fn new(client: Client) -> Self {
        Self(Arc::new(Inner {
            client,
            state: Mutex::new(State {
                closed: false,
                cache: BTreeMap::new(),
                pending: BTreeMap::new(),
                tasks: Vec::new(),
            }),
        }))
    }
    pub async fn resolve(&self, access: Option<&str>, key: Option<&str>, time: i64) -> Resolution {
        let finished = self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .tasks
            .extract_if(.., |task| task.is_finished())
            .collect();
        super::join_finished(finished).await?;
        if let Some(access) = access.filter(|value| !value.is_empty()) {
            return Ok(access.into());
        }
        let key = key
            .filter(|value| !value.is_empty())
            .ok_or(Error::InvalidCredential)?;
        if !key.starts_with("crsr_") {
            return Ok(key.into());
        }
        let mut receiver = {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            if state.closed {
                return Err(Error::Closed);
            }
            if let Some(pair) = state.cache.get(key)
                && jwt(&pair.access)
                    .and_then(|value| value.get("exp").and_then(serde_json::Value::as_f64))
                    .is_some_and(|expires| {
                        expires.is_finite() && expires * 1000.0 - time as f64 >= 300_000.0
                    })
            {
                return Ok(pair.access.clone());
            }
            if let Some(receiver) = state.pending.get(key) {
                receiver.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                state.pending.insert(key.into(), receiver.clone());
                let cached = state.cache.get(key).cloned();
                let key = key.to_owned();
                let store = self.clone();
                state.tasks.push(tokio::spawn(async move {
                    let pair = store.refresh_or_exchange(&key, cached).await;
                    let result = pair
                        .as_ref()
                        .map(|pair| pair.access.clone())
                        .map_err(|error| *error);
                    if let Ok(pair) = pair
                        && let Ok(mut state) = store.0.state.lock()
                    {
                        state.cache.insert(key.clone(), pair);
                    }
                    sender.send_replace(Some(result.clone()));
                    if result != Err(Error::UnknownOutcome)
                        && let Ok(mut state) = store.0.state.lock()
                    {
                        state.pending.remove(&key);
                    }
                }));
                receiver
            }
        };
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result;
            }
            receiver
                .changed()
                .await
                .map_err(|_| Error::UnknownOutcome)?;
        }
    }
    async fn refresh_or_exchange(&self, key: &str, cached: Option<Pair>) -> Result<Pair, Error> {
        if let Some(cached) = cached {
            match self
                .request(
                    self.0
                        .client
                        .json("/auth/token", json!({"refreshToken":cached.refresh})),
                )
                .await
            {
                Ok(pair) => return Ok(pair),
                Err(Error::UnknownOutcome) => return Err(Error::UnknownOutcome),
                Err(_) => {}
            }
        }
        self.request(
            self.0
                .client
                .json("/auth/exchange_user_api_key", json!({}))
                .bearer_auth(key),
        )
        .await
    }
    async fn request(&self, request: reqwest::RequestBuilder) -> Result<Pair, Error> {
        let (status, value) = self
            .0
            .client
            .send(request.timeout(Duration::from_secs(5)))
            .await?;
        if !status.is_success() {
            return Err(Error::Rejected);
        }
        Ok(Pair {
            access: string(&value, "accessToken")
                .map_err(|_| Error::UnknownOutcome)?
                .into(),
            refresh: value
                .get("refreshToken")
                .and_then(serde_json::Value::as_str)
                .ok_or(Error::UnknownOutcome)?
                .into(),
        })
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        let tasks = {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            state.closed = true;
            std::mem::take(&mut state.tasks)
        };
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            if task.await.is_err_and(|error| !error.is_cancelled()) {
                return Err(Error::UnknownOutcome);
            }
        }
        Ok(())
    }
}
