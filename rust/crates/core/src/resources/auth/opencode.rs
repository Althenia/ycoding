use super::{Client, DEVICE_GRANT, Error, Poll, Status, oauth_secret, string};
use serde_json::{Value, json};
use std::{fmt, sync::Arc};
use ycoding_schema::{JsonObject, JsonValue, credential};
use ycoding_store::resources::Secret;

#[derive(Clone)]
pub struct Console {
    client: Client,
}
impl fmt::Debug for Console {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OpenCodeConsole([redacted])")
    }
}
impl Console {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
    fn with_server(&self, server: &str) -> Result<Self, Error> {
        let mut client = Client::new(server, "auth")?;
        client.user_agent = self.client.user_agent.clone();
        Ok(Self::new(client))
    }
    pub async fn start(&self, time: i64) -> Result<Attempt, Error> {
        let (status, device) = self
            .client
            .send(
                self.client
                    .json("/auth/device/code", json!({"client_id":"opencode-cli"})),
            )
            .await?;
        if !status.is_success() {
            return Err(Error::Rejected);
        }
        let verification = string(&device, "verification_uri_complete")?;
        let url = match url::Url::parse(verification) {
            Ok(url) if matches!(url.scheme(), "http" | "https") => url.into(),
            Ok(_) => return Err(Error::Rejected),
            Err(_) => format!(
                "{}/{}",
                self.client.endpoint,
                verification.trim_start_matches('/')
            ),
        };
        let interval = device
            .get("interval")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or(Error::Rejected)?
            * 1000.0;
        Ok(Attempt {
            console: self.clone(),
            url,
            instructions: format!("Enter code: {}", string(&device, "user_code")?),
            code: string(&device, "device_code")?.into(),
            interval: interval as i64,
            next_poll: time.saturating_add(interval as i64),
            status: Status::Pending,
        })
    }
    pub async fn refresh(&self, value: credential::OAuth, time: i64) -> Result<Secret, Error> {
        let client = if let Some(JsonValue::String(server)) = value
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.get(&"server".into()))
        {
            self.with_server(server.as_str().ok_or(Error::InvalidCredential)?)?
                .client
        } else {
            self.client.clone()
        };
        let (status, token) = client.send(client.json("/auth/device/token",json!({"grant_type":"refresh_token","refresh_token":value.refresh.as_str().ok_or(Error::InvalidCredential)?,"client_id":"opencode-cli"}))).await?;
        if !status.is_success() {
            return Err(Error::Rejected);
        }
        oauth_secret(
            "device",
            string(&token, "access_token")?,
            string(&token, "refresh_token")?,
            expiry(&token, time)?,
            value.metadata,
        )
    }
    async fn enrich(&self, token: Value, time: i64) -> Result<Secret, Error> {
        let access = string(&token, "access_token")?;
        let user = self.get("/api/user", access);
        let orgs = self.get("/api/orgs", access);
        let (user, orgs) = tokio::try_join!(user, orgs)?;
        let mut orgs = orgs
            .as_array()
            .ok_or(Error::Rejected)?
            .iter()
            .map(|org| {
                Ok((
                    string(org, "id")?.to_owned(),
                    string(org, "name")?.to_owned(),
                ))
            })
            .collect::<Result<Vec<_>, Error>>()?;
        orgs.sort_by(|first, second| {
            locale_compare(&first.1, &second.1).then_with(|| locale_compare(&first.0, &second.0))
        });
        let mut metadata = JsonObject::new();
        metadata.insert(
            "server".into(),
            JsonValue::String(self.client.endpoint.clone().into()),
        );
        metadata.insert(
            "accountID".into(),
            JsonValue::String(string(&user, "id")?.into()),
        );
        metadata.insert(
            "email".into(),
            JsonValue::String(string(&user, "email")?.into()),
        );
        if let Some((id, name)) = orgs.first() {
            metadata.insert("orgID".into(), JsonValue::String(id.clone().into()));
            metadata.insert("orgName".into(), JsonValue::String(name.clone().into()));
        }
        oauth_secret(
            "device",
            access,
            string(&token, "refresh_token")?,
            expiry(&token, time)?,
            Some(metadata),
        )
    }
    async fn get(&self, path: &str, token: &str) -> Result<Value, Error> {
        let response = self
            .client
            .http
            .get(format!("{}{path}", self.client.endpoint))
            .header("Accept", "application/json")
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| Error::Rejected)?;
        if !response.status().is_success() {
            return Err(Error::Rejected);
        }
        serde_json::from_slice(&response.bytes().await.map_err(|_| Error::Rejected)?)
            .map_err(|_| Error::Rejected)
    }
    pub fn implementation(&self) -> super::integration::OAuthImplementation {
        let console = self.clone();
        let refresh = self.clone();
        super::integration::OAuthImplementation {
            integration: "opencode".into(),
            method: ycoding_schema::integration::OAuthMethod {
                id: ycoding_schema::integration_id::IntegrationMethodId::new("device")
                    .expect("method"),
                label: "OpenCode Console account".into(),
                prompts: None,
                remote: Some(true),
            },
            authorize: Arc::new(move |inputs| {
                let console = console.clone();
                Box::pin(async move {
                    let console = match inputs.0.get(&"server".into()) {
                        Some(JsonValue::String(server)) => {
                            console.with_server(server.as_str().ok_or(Error::Rejected)?)?
                        }
                        Some(_) => return Err(Error::Rejected),
                        None => console,
                    };
                    let mut attempt = console.start(super::now()?).await?;
                    let url = attempt.url.clone();
                    let instructions = attempt.instructions.clone();
                    Ok(super::integration::Authorization::automatic(
                        url,
                        instructions,
                        Box::pin(async move {
                            loop {
                                let time = super::now()?;
                                match attempt.poll(time).await? {
                                    Poll::Complete(value) => return Ok(value),
                                    Poll::WaitUntil(next) => {
                                        tokio::time::sleep(std::time::Duration::from_millis(
                                            next.saturating_sub(time).max(0) as u64,
                                        ))
                                        .await
                                    }
                                }
                            }
                        }),
                        None,
                        None,
                    ))
                })
            }),
            refresh: Some(Arc::new(move |value| {
                let console = refresh.clone();
                Box::pin(async move { console.refresh(value, super::now()?).await })
            })),
            label: Some(Arc::new(|value| {
                let credential::Value::OAuth(value) = value.domain().ok()? else {
                    return None;
                };
                let metadata = value.metadata?;
                let JsonValue::String(name) = metadata.get(&"orgName".into())? else {
                    return None;
                };
                Some(name.clone())
            })),
        }
    }
}
fn locale_compare(first: &str, second: &str) -> std::cmp::Ordering {
    let first = first.encode_utf16().collect::<Vec<_>>();
    let second = second.encode_utf16().collect::<Vec<_>>();
    crate::platform::filesystem::collation::compare(&first, &second)
}
fn expiry(token: &Value, time: i64) -> Result<i64, Error> {
    Ok(time.saturating_add(
        (token
            .get("expires_in")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or(Error::Rejected)?
            * 1000.0) as i64,
    ))
}
pub struct Attempt {
    console: Console,
    url: String,
    instructions: String,
    code: String,
    interval: i64,
    next_poll: i64,
    status: Status,
}
impl fmt::Debug for Attempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OpenCodeAttempt([redacted])")
    }
}
impl Attempt {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn instructions(&self) -> &str {
        &self.instructions
    }
    pub fn status(&self) -> Status {
        self.status
    }
    pub fn cancel(&mut self) {
        if self.status == Status::Pending {
            self.status = Status::Cancelled;
        }
    }
    pub async fn poll(&mut self, time: i64) -> Result<Poll, Error> {
        if self.status == Status::UnknownOutcome {
            return Err(Error::UnknownOutcome);
        }
        if self.status != Status::Pending {
            return Err(Error::Rejected);
        }
        if time < self.next_poll {
            return Ok(Poll::WaitUntil(self.next_poll));
        }
        self.status = Status::UnknownOutcome;
        let result = self.request(time).await;
        self.status = match &result {
            Ok(Poll::Complete(_)) => Status::Complete,
            Ok(Poll::WaitUntil(_)) => Status::Pending,
            Err(Error::UnknownOutcome) => Status::UnknownOutcome,
            Err(_) => Status::Failed,
        };
        result
    }
    async fn request(&mut self, time: i64) -> Result<Poll, Error> {
        let (_,token) = self.console.client.send(self.console.client.json("/auth/device/token",json!({"grant_type":DEVICE_GRANT,"device_code":self.code,"client_id":"opencode-cli"}))).await?;
        if token.get("access_token").is_some() {
            return Ok(Poll::Complete(self.console.enrich(token, time).await?));
        }
        match token.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => self.interval = self.interval.saturating_add(5000),
            _ => return Err(Error::Rejected),
        }
        self.next_poll = time.saturating_add(self.interval);
        Ok(Poll::WaitUntil(self.next_poll))
    }
}
