use crate::{
    Error,
    auth::{Auth, Credential},
    json,
    llm::{Defaults, Model, Request, Role},
    openai_responses::OpenAIResponses,
    route::{Protocol, Route, StreamParser},
};
use reqwest::header::{HeaderMap, HeaderValue};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, OnceLock},
};
use ycoding_schema::{JsonValue, LosslessString};

pub const BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
pub const ROUTE_ID: &str = "openai-codex-responses";
pub const WEBSOCKET_ROUTE_ID: &str = "openai-codex-websocket-responses";
const TURN_STATE: &str = "x-codex-turn-state";
type Key = (String, String, Option<String>);
#[derive(Default)]
pub struct TurnStates(Mutex<VecDeque<(Key, HeaderValue)>>);
static STATES: OnceLock<Arc<TurnStates>> = OnceLock::new();

pub struct Config {
    pub credential: Option<Credential>,
    pub account_id: Option<String>,
    pub websocket: bool,
    pub defaults: Defaults,
    pub turn_states: Arc<TurnStates>,
}
impl Config {
    pub fn new(credential: Credential) -> Self {
        Self {
            credential: Some(credential),
            account_id: None,
            websocket: false,
            defaults: Defaults::default(),
            turn_states: STATES
                .get_or_init(|| Arc::new(TurnStates::default()))
                .clone(),
        }
    }
}

pub fn model(id: impl Into<LosslessString>, config: Config) -> Result<Model, Error> {
    let mut route = if config.websocket {
        Route::openai_responses_websocket()
    } else {
        Route::openai_responses()
    };
    route.id = if config.websocket {
        WEBSOCKET_ROUTE_ID
    } else {
        ROUTE_ID
    }
    .into();
    route.endpoint.base_url = BASE_URL.into();
    route.protocol = Arc::new(Codex {
        account: config.account_id.clone(),
        websocket: config.websocket,
        states: config.turn_states,
    });
    route.auth = config.credential.map(Auth::bearer).unwrap_or(Auth::None);
    if let Some(account) = config.account_id {
        route.auth = route.auth.and_then(Auth::header(
            "chatgpt-account-id",
            Credential::value(account),
        ));
    }
    if config.websocket {
        route.headers.insert(
            "openai-beta".into(),
            "responses_websockets=2026-02-06".into(),
        );
    }
    let mut model = route.model(id);
    model.defaults = config.defaults;
    Ok(model)
}

struct Codex {
    account: Option<String>,
    websocket: bool,
    states: Arc<TurnStates>,
}
fn cache_key(request: &Request) -> Option<&str> {
    request
        .provider_options
        .as_ref()
        .and_then(|options| json::get(options, "openai"))
        .and_then(|options| json::get(options, "promptCacheKey"))
        .and_then(json::text)
}
impl Codex {
    fn key(&self, request: &Request) -> Option<Key> {
        let cache = cache_key(request).filter(|key| !key.is_empty())?;
        let user = request
            .messages
            .iter()
            .rev()
            .filter(|message| message.role == Role::User)
            .find_map(|message| message.id.as_ref().and_then(LosslessString::as_str))?;
        Some((cache.into(), user.into(), self.account.clone()))
    }
}
impl Protocol for Codex {
    fn id(&self) -> &'static str {
        "openai-responses"
    }
    fn lower(&self, request: &Request) -> Result<JsonValue, Error> {
        OpenAIResponses.lower(request)
    }
    fn parser(&self, request: &Request) -> Box<dyn StreamParser> {
        OpenAIResponses.parser(request)
    }
    fn terminal(&self, event: &JsonValue) -> bool {
        OpenAIResponses.terminal(event)
    }
    fn request_headers(
        &self,
        request: &Request,
        mut headers: HeaderMap,
    ) -> Result<HeaderMap, Error> {
        if let Some(cache) = cache_key(request) {
            let cache = HeaderValue::from_str(cache)
                .map_err(|_| Error::invalid("Invalid Codex affinity header"))?;
            for name in ["session-id", "thread-id", "x-client-request-id"] {
                headers.insert(name, cache.clone());
            }
        }
        if !self.websocket
            && let Some(key) = self.key(request)
        {
            let states =
                self.states.0.lock().map_err(|_| {
                    Error::transport("Codex turn-state store unavailable", "session")
                })?;
            if let Some((_, token)) = states.iter().find(|(known, _)| known == &key) {
                headers.insert(TURN_STATE, token.clone());
            }
        }
        Ok(headers)
    }
    fn response_headers(&self, request: &Request, headers: &HeaderMap) {
        if self.websocket {
            return;
        }
        let (Some(key), Some(token)) = (self.key(request), headers.get(TURN_STATE)) else {
            return;
        };
        if token.is_empty() || token.as_bytes().len() > 4096 {
            return;
        }
        let Ok(mut states) = self.states.0.lock() else {
            return;
        };
        if states.iter().any(|(known, _)| known == &key) {
            return;
        }
        if states.len() >= 512 {
            states.pop_front();
        }
        let mut token = token.clone();
        token.set_sensitive(true);
        states.push_back((key, token));
    }
}
