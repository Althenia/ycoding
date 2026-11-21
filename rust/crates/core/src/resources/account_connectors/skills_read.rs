use crate::{
    cca::error::BoxFuture,
    resources::{auth::integration::Registry, config},
    tools::policy::permissions::{self, Permissions},
};
use std::{fmt, sync::Arc, time::Duration};
use ycoding_schema::{
    JsonObject, JsonValue, LosslessString, connection, credential, parse_json, permission, session,
};

const BASE: &str = "https://chatgpt.com/backend-api";
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);

pub(super) type Exchange = Arc<
    dyn Fn(reqwest::Request) -> BoxFuture<'static, Result<reqwest::Response, ()>> + Send + Sync,
>;

pub struct Reader {
    configuration: Arc<config::Configuration>,
    integration: Registry,
    permissions: Permissions,
    client: reqwest::Client,
    exchange: Exchange,
}

pub struct Input {
    pub session_id: session::Id,
    pub agent: LosslessString,
    pub profile: Option<LosslessString>,
    pub id: Option<LosslessString>,
}

#[derive(Debug, PartialEq)]
pub struct Proof {
    pub status: u16,
    pub keys: Vec<LosslessString>,
    pub count: usize,
    pub has_next: bool,
    pub pagination_keys: Vec<LosslessString>,
    pub detail: Option<DetailProof>,
}

#[derive(Debug, PartialEq)]
pub struct DetailProof {
    pub status: u16,
    pub keys: Vec<LosslessString>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Kind {
    Configuration,
    Permission,
    Read,
    UnlistedId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Reason {
    Message(&'static str),
    Rejected(u16),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Error {
    kind: Kind,
    reason: Reason,
}

impl Error {
    pub fn kind(&self) -> &'static str {
        match self.kind {
            Kind::Configuration => "account_skills_configuration",
            Kind::Permission => "permission_denied",
            Kind::Read => "account_skills_read",
            Kind::UnlistedId => "unlisted_skill_id",
        }
    }

    fn message(kind: Kind, message: &'static str) -> Self {
        Self {
            kind,
            reason: Reason::Message(message),
        }
    }

    fn invalid_response() -> Self {
        Self::message(
            Kind::Read,
            "ChatGPT account skills returned an invalid response",
        )
    }

    fn request_failed() -> Self {
        Self::message(Kind::Read, "ChatGPT account skills read request failed")
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.reason {
            Reason::Message(message) => formatter.write_str(message),
            Reason::Rejected(status) => write!(
                formatter,
                "ChatGPT account skills request rejected (HTTP {status})"
            ),
        }
    }
}

impl std::error::Error for Error {}

struct Selected {
    credential: LosslessString,
    generation: i64,
    label: LosslessString,
    account: String,
    access: String,
}

impl Reader {
    pub fn new(
        configuration: Arc<config::Configuration>,
        integration: Registry,
        permissions: Permissions,
    ) -> Result<Self, Error> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .https_only(true)
            .timeout(TIMEOUT)
            .build()
            .map_err(|_| Error::request_failed())?;
        let http = client.clone();
        Ok(Self {
            configuration,
            integration,
            permissions,
            client,
            exchange: Arc::new(move |request| {
                let http = http.clone();
                Box::pin(async move { http.execute(request).await.map_err(|_| ()) })
            }),
        })
    }

    #[cfg(test)]
    pub(super) fn with_exchange(
        configuration: Arc<config::Configuration>,
        integration: Registry,
        permissions: Permissions,
        exchange: Exchange,
    ) -> Result<Self, Error> {
        let mut reader = Self::new(configuration, integration, permissions)?;
        reader.exchange = exchange;
        Ok(reader)
    }

    async fn select(&self, profile: Option<&LosslessString>) -> Result<Selected, &'static str> {
        let configuration = self
            .configuration
            .snapshot()
            .map_err(|_| "ChatGPT account skills configuration is unavailable")?;
        let settings = configuration
            .chatgpt_connector()
            .filter(|value| value.enabled)
            .ok_or("ChatGPT account skills read is disabled by configuration")?;
        let integration = self.integration.get(&"openai".into())
            .map_err(|_| "ChatGPT account skills integration is unavailable")?
            .ok_or("ChatGPT connectors require a connected ChatGPT profile. Select the profile in account_connectors.chatgpt.profile.")?;
        let active = integration
            .connections
            .iter()
            .find_map(|value| match value {
                connection::Info::Credential(value) if value.active => Some(value.label.clone()),
                _ => None,
            });
        let effective = settings.profile.or(active);
        if profile
            .zip(effective.as_ref())
            .is_some_and(|(requested, effective)| requested != effective)
        {
            return Err(
                "The requested ChatGPT profile conflicts with the effective account profile",
            );
        }
        let selected = effective.as_ref().or(profile);
        let info = integration.connections.into_iter().find_map(|value| match value {
            connection::Info::Credential(value) if selected.map_or(value.active, |label| label == &value.label) => Some(value),
            _ => None,
        }).ok_or("ChatGPT connectors require a connected ChatGPT profile. Select the profile in account_connectors.chatgpt.profile.")?;
        let (expected, label) = (info.id.0.clone(), info.label.clone());
        let snapshot = self
            .integration
            .snapshot(
                connection::Info::Credential(info),
                chrono::Utc::now().timestamp_millis(),
            )
            .await
            .map_err(
                |_| "The selected ChatGPT profile is unavailable. Select the profile again.",
            )?;
        let stored = snapshot.credential.ok_or("ChatGPT connectors require ChatGPT OAuth; API keys and other accounts are not supported.")?;
        if stored.id() != &expected || stored.integration_id() != &LosslessString::from("openai") {
            return Err("The selected ChatGPT profile is unavailable. Select the profile again.");
        }
        let value = snapshot.value.ok_or("ChatGPT connectors require ChatGPT OAuth; API keys and other accounts are not supported.")?;
        let credential::Value::OAuth(value) =
            value.domain().map_err(|_| "Invalid ChatGPT credential")?
        else {
            return Err(
                "ChatGPT connectors require ChatGPT OAuth; API keys and other accounts are not supported.",
            );
        };
        if !matches!(
            value.method_id.as_lossless().as_str(),
            Some("chatgpt-browser" | "chatgpt-headless")
        ) {
            return Err(
                "ChatGPT connectors require ChatGPT OAuth; API keys and other accounts are not supported.",
            );
        }
        let account = match value
            .metadata
            .as_ref()
            .and_then(|value| value.get(&"accountID".into()))
        {
            Some(JsonValue::String(account)) if !account.is_empty() => account
                .to_utf8()
                .map_err(|_| "Invalid ChatGPT account identity")?,
            _ => {
                return Err(
                    "The selected ChatGPT profile has no account identity. Reconnect that profile.",
                );
            }
        };
        let access = value
            .access
            .to_utf8()
            .map_err(|_| "Invalid ChatGPT credential")?;
        if access.is_empty() {
            return Err("Invalid ChatGPT credential");
        }
        Ok(Selected {
            credential: expected,
            generation: stored.account_generation(),
            label,
            account,
            access,
        })
    }

    async fn current(&self, input: &Input, selected: &Selected) -> Result<Selected, Error> {
        let current = self
            .select(input.profile.as_ref())
            .await
            .map_err(|message| Error::message(Kind::Read, message))?;
        if current.credential != selected.credential
            || current.generation != selected.generation
            || current.account != selected.account
        {
            return Err(Error::message(
                Kind::Read,
                "The ChatGPT account skills profile changed; refresh the tool catalog",
            ));
        }
        Ok(current)
    }

    async fn json(
        &self,
        input: &Input,
        selected: &Selected,
        route: &str,
        detail: bool,
    ) -> Result<(u16, JsonObject), Error> {
        self.current(input, selected).await?;
        let mut metadata = JsonObject::new();
        metadata.insert("profile".into(), JsonValue::String(selected.label.clone()));
        metadata.insert(
            "accountID".into(),
            JsonValue::String(selected.account.as_str().into()),
        );
        self.permissions
            .assert(
                permission::Request {
                    id: permission::Id::new(format!("per_{}", crate::cca::encoding::uuid_v4()))
                        .map_err(|_| Error::request_failed())?,
                    session_id: input.session_id.clone(),
                    action: "chatgpt_account_skills_read".into(),
                    resources: vec![selected.credential.clone()],
                    metadata: Some(metadata),
                    save: None,
                    source: None,
                    escalation: None,
                    coordination_escalation: None,
                },
                Some(input.agent.clone()),
            )
            .await
            .map_err(|error| match error {
                permissions::Error::Blocked { .. } | permissions::Error::Declined => {
                    Error::message(
                        if detail { Kind::Read } else { Kind::Permission },
                        "Permission denied for ChatGPT account skills read",
                    )
                }
                _ => Error::message(
                    Kind::Read,
                    "ChatGPT account skills permission is unavailable",
                ),
            })?;
        let prepared = self.current(input, selected).await?;
        let mut request = self
            .client
            .get(format!("{BASE}{route}"))
            .timeout(TIMEOUT)
            .bearer_auth(&prepared.access)
            .header("ChatGPT-Account-Id", &prepared.account)
            .header("content-type", "application/json");
        for (name, value) in ycoding_ai::openai_codex::headers() {
            request = request.header(name, value);
        }
        let request = request.build().map_err(|_| Error::request_failed())?;
        let mut response = (self.exchange)(request)
            .await
            .map_err(|_| Error::request_failed())?;
        self.current(input, selected).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error {
                kind: Kind::Read,
                reason: Reason::Rejected(status.as_u16()),
            });
        }
        let declared = response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        if declared
            .or(response.content_length())
            .is_some_and(|size| size > RESPONSE_LIMIT as u64)
        {
            return Err(Error::invalid_response());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Error::invalid_response())?
        {
            if chunk.len() > RESPONSE_LIMIT - bytes.len() {
                return Err(Error::invalid_response());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value =
            parse_json(&String::from_utf8_lossy(&bytes)).map_err(|_| Error::invalid_response())?;
        self.current(input, selected).await?;
        let JsonValue::Object(value) = value else {
            return Err(Error::invalid_response());
        };
        Ok((status.as_u16(), value))
    }

    pub async fn read(&self, input: Input) -> Result<Proof, Error> {
        let selected = self
            .select(input.profile.as_ref())
            .await
            .map_err(|message| Error::message(Kind::Configuration, message))?;
        let (status, list) = self
            .json(
                &input,
                &selected,
                "/hazelnuts?scope=installed&include_permissions=true",
                false,
            )
            .await?;
        let Some(JsonValue::Array(items)) = list.get(&"hazelnuts".into()) else {
            return Err(Error::invalid_response());
        };
        let ids = items
            .iter()
            .map(|item| match item {
                JsonValue::Object(item) => match item.get(&"id".into()) {
                    Some(JsonValue::String(id)) if !id.is_empty() => Ok(id.clone()),
                    _ => Err(Error::invalid_response()),
                },
                _ => Err(Error::invalid_response()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let detail_id = match input.id.as_ref() {
            Some(id) if !ids.contains(id) => {
                return Err(Error::message(
                    Kind::UnlistedId,
                    "Requested skill ID was not returned by account skills list",
                ));
            }
            Some(id) => Some(id),
            None => ids.first(),
        };
        let detail = if let Some(id) = detail_id {
            let encoded = encode_id(id)?;
            let (status, value) = self
                .json(
                    &input,
                    &selected,
                    &format!("/hazelnuts/{encoded}?include_permissions=true"),
                    true,
                )
                .await?;
            if value.get(&"id".into()) != Some(&JsonValue::String(id.clone())) {
                return Err(Error::invalid_response());
            }
            Some(DetailProof {
                status,
                keys: keys(&value),
            })
        } else {
            None
        };
        Ok(Proof {
            status,
            keys: keys(&list),
            count: ids.len(),
            has_next: list.get(&"has_more".into()) == Some(&JsonValue::Bool(true))
                || matches!(list.get(&"next_cursor".into()), Some(JsonValue::String(value)) if !value.is_empty()),
            pagination_keys: ["has_more", "next_cursor", "cursor"]
                .into_iter()
                .filter(|key| list.get(&(*key).into()).is_some())
                .map(Into::into)
                .collect(),
            detail,
        })
    }
}

fn keys(object: &JsonObject) -> Vec<LosslessString> {
    let mut keys = object
        .iter()
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    keys.sort();
    keys
}

fn encode_id(id: &LosslessString) -> Result<String, Error> {
    if id.is_empty() || matches!(id.as_str(), Some("uploads" | "draft" | "." | "..")) {
        return Err(Error::message(
            Kind::Read,
            "Unsupported ChatGPT account skill identifier",
        ));
    }
    let id = id
        .to_utf8()
        .map_err(|_| Error::message(Kind::Read, "Unsupported ChatGPT account skill identifier"))?;
    let mut encoded = String::new();
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 15)]));
        }
    }
    Ok(encoded)
}
