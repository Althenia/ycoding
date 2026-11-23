use super::{Error, SocketFuture, cursor, field, list, malformed, projection, string};
use crate::dots::{
    access::{ConversationProblem as Problem, UpstreamRejection},
    enrollment::cca_headers,
    native::{Configuration, Host, ResolvedCredential},
};
use reqwest::{Client, Method, Response};
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;
use ycoding_schema::{JsonValue, parse_json, stringify_json};

const BASE: &str = "https://chatgpt.com/backend-api";
const HISTORY: &str = "https://codex-cloud-backend.chatgpt.com";

pub type RestDriver = Arc<
    dyn Fn(Client, reqwest::Request) -> SocketFuture<'static, Result<Response, reqwest::Error>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub(super) struct Rest {
    pub host: Host,
    client: Client,
    driver: RestDriver,
    stopped: Arc<AtomicBool>,
    owner: Arc<dyn Fn() -> bool + Send + Sync>,
}

pub(super) struct Context {
    pub configuration: Configuration,
    pub credential: ResolvedCredential,
    pub dot: String,
    pub root: Option<String>,
    deadline: Instant,
}

#[derive(Clone, Copy)]
struct Request<'a> {
    path: &'a str,
    query: &'a [(String, String)],
    history: bool,
    body: Option<&'a JsonValue>,
    post: bool,
    deadline: Instant,
}

pub(super) fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

impl Rest {
    pub fn new(
        host: Host,
        stopped: Arc<AtomicBool>,
        owner: Arc<dyn Fn() -> bool + Send + Sync>,
        driver: RestDriver,
    ) -> Result<Self, Error> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| Error::new(Problem::Connection))?;
        Ok(Self {
            host,
            client,
            driver,
            stopped,
            owner,
        })
    }

    pub fn fence(&self, expected: &Configuration) -> Result<(), Error> {
        if self.stopped.load(Ordering::Acquire) || !(self.owner)() {
            return Err(Error::new(Problem::Connection));
        }
        if self.host.configuration().ok().as_ref() == Some(expected) {
            Ok(())
        } else {
            Err(Error::new(Problem::Configuration))
        }
    }

    async fn send(
        &self,
        owner: &Context,
        credential: &ResolvedCredential,
        request: Request<'_>,
    ) -> Result<(u16, Option<JsonValue>, Option<String>), Error> {
        let Request {
            path,
            query,
            history,
            body,
            post,
            deadline,
        } = request;
        self.fence(&owner.configuration)?;
        let timeout = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| Error::new(Problem::Connection))?
            .min(Duration::from_secs(15));
        let mut address =
            url::Url::parse(&format!("{}{path}", if history { HISTORY } else { BASE }))
                .map_err(|_| Error::new(Problem::Connection))?;
        if !query.is_empty() {
            address.query_pairs_mut().extend_pairs(
                query
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str())),
            );
        }
        let mut request = self
            .client
            .request(if post { Method::POST } else { Method::GET }, address)
            .bearer_auth(&credential.access_token)
            .header("ChatGPT-Account-Id", &credential.account_id)
            .header("originator", cca_headers::ORIGINATOR)
            .header("user-agent", cca_headers::user_agent())
            .header("content-type", "application/json")
            .timeout(timeout);
        if history {
            request = request.header("X-OpenAI-Product-Sku", "codex");
        }
        if let Some(body) = body {
            request = request
                .body(stringify_json(body))
                .header("content-type", "application/json");
        }
        let request = request
            .build()
            .map_err(|_| Error::new(Problem::Connection))?;
        let mut response = (self.driver)(self.client.clone(), request)
            .await
            .map_err(|_| Error::new(Problem::Connection))?;
        self.fence(&owner.configuration)?;
        let status = response.status().as_u16();
        if status == 401 || (!post && status == 403) {
            return Ok((status, None, None));
        }
        if response
            .content_length()
            .is_some_and(|length| length > 16 * 1024 * 1024)
        {
            return if post {
                Ok((status, None, None))
            } else {
                Err(malformed())
            };
        }
        let mut bytes = Vec::new();
        loop {
            let chunk = match response.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => {
                    return if post {
                        Ok((status, None, None))
                    } else {
                        Err(Error::new(Problem::Connection))
                    };
                }
            };
            if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
                return if post {
                    Ok((status, None, None))
                } else {
                    Err(malformed())
                };
            }
            bytes.extend_from_slice(&chunk);
        }
        self.fence(&owner.configuration)?;
        let text = std::str::from_utf8(&bytes).ok();
        let parsed = text.and_then(|text| parse_json(text).ok());
        let detail = text.map(|text| text.chars().take(1000).collect());
        Ok((status, parsed, detail))
    }

    async fn authenticated(
        &self,
        owner: &Context,
        request: Request<'_>,
    ) -> Result<(u16, Option<JsonValue>, Option<String>), Error> {
        let deadline = request.deadline;
        let reply = self.send(owner, &owner.credential, request).await?;
        if reply.0 != 401 {
            return Ok(reply);
        }
        self.fence(&owner.configuration)?;
        if deadline <= Instant::now() {
            return Err(Error::new(Problem::Authentication));
        }
        let Configuration::Enabled { profile, .. } = &owner.configuration else {
            return Err(Error::new(Problem::Configuration));
        };
        let credential = tokio::time::timeout_at(
            deadline,
            self.host
                .credential(profile, Some(owner.credential.access_token.clone())),
        )
        .await
        .map_err(|_| Error::new(Problem::Authentication))?
        .map_err(|_| Error::new(Problem::Authentication))?
        .ok_or_else(|| Error::new(Problem::Authentication))?;
        self.fence(&owner.configuration)?;
        if deadline <= Instant::now() {
            return Err(Error::new(Problem::Authentication));
        }
        if credential.profile != owner.credential.profile
            || credential.credential_id != owner.credential.credential_id
            || credential.account_id != owner.credential.account_id
            || credential.account_generation != owner.credential.account_generation
        {
            return Err(Error::new(Problem::Configuration));
        }
        self.send(owner, &credential, request).await
    }

    pub async fn get(
        &self,
        owner: &Context,
        path: &str,
        query: &[(String, String)],
        history: bool,
    ) -> Result<JsonValue, Error> {
        let (status, body, _) = self
            .authenticated(
                owner,
                Request {
                    path,
                    query,
                    history,
                    body: None,
                    post: false,
                    deadline: owner.deadline,
                },
            )
            .await?;
        if status == 401 || status == 403 {
            return Err(Error::new(Problem::Authentication));
        }
        if !(200..300).contains(&status) {
            return Err(Error::new(Problem::Connection));
        }
        body.filter(|value| matches!(value, JsonValue::Object(_)))
            .ok_or_else(malformed)
    }

    pub async fn post(
        &self,
        owner: &Context,
        path: &str,
        body: Option<&JsonValue>,
        resume: bool,
    ) -> Result<Option<JsonValue>, Error> {
        let deadline = if resume {
            Instant::now() + Duration::from_secs(15)
        } else {
            owner.deadline
        };
        let reply = self
            .authenticated(
                owner,
                Request {
                    path,
                    query: &[],
                    history: false,
                    body,
                    post: true,
                    deadline,
                },
            )
            .await;
        let (status, body, content) = match reply {
            Ok(value) => value,
            Err(error)
                if matches!(
                    error.problem,
                    Problem::Configuration | Problem::Authentication
                ) =>
            {
                return Err(error);
            }
            Err(_) => return Ok(None),
        };
        if status == 401 || (resume && status == 403) {
            return Err(Error::new(Problem::Authentication));
        }
        if status == 408 || status == 429 || status >= 500 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            let detail = body.as_ref().map(|value| field(value, "detail"));
            return Err(Error {
                problem: Problem::Rejected,
                rejection: Some(UpstreamRejection {
                    code: Some(f64::from(status)),
                    error_code: detail
                        .and_then(|value| string(value, "code"))
                        .map(str::to_owned),
                    message: detail
                        .and_then(|value| match value {
                            JsonValue::String(text) => text.as_str(),
                            _ => string(value, "message"),
                        })
                        .map(str::to_owned)
                        .or(content),
                    error_type: None,
                }),
            });
        }
        Ok(Some(body.unwrap_or(JsonValue::Null)))
    }

    pub async fn context(&self) -> Result<Context, Error> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let configuration = self
            .host
            .configuration()
            .map_err(|_| Error::new(Problem::Configuration))?;
        let Configuration::Enabled { profile, .. } = &configuration else {
            return Err(Error::new(Problem::Configuration));
        };
        let credential = self
            .host
            .credential(profile, None)
            .await
            .map_err(|_| Error::new(Problem::Authentication))?
            .ok_or_else(|| Error::new(Problem::Authentication))?;
        let mut owner = Context {
            configuration,
            credential,
            dot: String::new(),
            root: None,
            deadline,
        };
        let mut active = Vec::new();
        let mut next: Option<String> = None;
        let mut seen = BTreeSet::new();
        let mut complete = false;
        for _ in 0..40 {
            let mut query = vec![
                ("limit".into(), "25".into()),
                ("include_room_preview".into(), "false".into()),
            ];
            if let Some(cursor) = &next {
                query.push(("cursor".into(), cursor.clone()));
            }
            let body = self.get(&owner, "/tbo", &query, false).await?;
            let rows = list(&body, "items")?;
            if rows.len() > 25 {
                return Err(malformed());
            }
            for row in rows {
                if string(row, "status") == Some("active") {
                    active.push(projection::identity(field(row, "id"))?);
                }
            }
            next = cursor(&body, "cursor")?;
            let Some(cursor) = &next else {
                complete = true;
                break;
            };
            if !seen.insert(cursor.clone()) {
                return Err(malformed());
            }
        }
        if !complete {
            return Err(malformed());
        }
        owner.dot = if active.len() == 1 {
            active.remove(0)
        } else {
            if active.is_empty() {
                return Err(Error::new(Problem::DotUnavailable));
            }
            let body = self.get(&owner, "/tbo/primary", &[], false).await?;
            let profile = field(&body, "profile");
            if matches!(profile, JsonValue::Null) {
                return Err(Error::new(Problem::DotUnavailable));
            }
            let id = projection::identity(field(profile, "id"))?;
            if !active.contains(&id) {
                return Err(Error::new(Problem::DotUnavailable));
            }
            id
        };
        let root = self
            .get(
                &owner,
                &format!("/tbo/{}/root-thread", segment(&owner.dot)),
                &[],
                false,
            )
            .await?;
        owner.root = match field(&root, "root_thread_id") {
            JsonValue::Null => None,
            value => Some(projection::identity(value)?),
        };
        Ok(owner)
    }

    pub async fn members(&self, owner: &Context) -> Result<Vec<String>, Error> {
        let mut rows = owner.root.iter().cloned().collect::<Vec<_>>();
        let mut next: Option<String> = None;
        let mut seen = BTreeSet::new();
        for _ in 0..20 {
            let mut query = vec![
                ("limit".into(), "100".into()),
                ("include_hidden".into(), "false".into()),
            ];
            if let Some(cursor) = &next {
                query.push(("cursor".into(), cursor.clone()));
            }
            let body = self
                .get(
                    owner,
                    &format!("/tbo/{}/threads", segment(&owner.dot)),
                    &query,
                    false,
                )
                .await?;
            let items = list(&body, "items")?;
            if items.len() > 100 {
                return Err(malformed());
            }
            for item in items {
                let id = projection::identity(field(item, "thread_id"))?;
                if !rows.contains(&id) {
                    rows.push(id);
                }
            }
            if rows.len() > 2000 {
                return Err(malformed());
            }
            next = cursor(&body, "cursor")?;
            let Some(cursor) = &next else {
                return Ok(rows);
            };
            if !seen.insert(cursor.clone()) {
                return Err(malformed());
            }
        }
        Err(malformed())
    }

    pub async fn tasks(&self, owner: &Context) -> Result<Vec<JsonValue>, Error> {
        let mut rows = Vec::new();
        let mut next: Option<String> = None;
        let mut seen = BTreeSet::new();
        for _ in 0..10 {
            let mut query = vec![("limit".into(), "100".into())];
            if let Some(cursor) = &next {
                query.push(("cursor".into(), cursor.clone()));
            }
            let body = self
                .get(
                    owner,
                    &format!("/tbo/{}/tasks", segment(&owner.dot)),
                    &query,
                    false,
                )
                .await?;
            let items = list(&body, "data")?;
            if items.len() > 100 {
                return Err(malformed());
            }
            rows.extend(
                items
                    .iter()
                    .map(projection::task)
                    .collect::<Result<Vec<_>, _>>()?,
            );
            next = cursor(&body, "next_cursor")?;
            let Some(cursor) = &next else {
                return Ok(rows);
            };
            if !seen.insert(cursor.clone()) {
                return Err(malformed());
            }
        }
        Err(malformed())
    }
}
