use super::skills::encode_base64;
use crate::resources::credential::{Info, Service};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fmt,
    future::Future,
    sync::{Arc, Mutex, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{net::TcpListener, sync::OnceCell};
use url::Url;
use ycoding_schema::{
    DomainEncode, LosslessString, credential,
    mcp::{OAuth, OAuthConfig, RemoteConfig},
    parse_json, stringify_json,
};
use ycoding_store::resources::Secret;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Disabled,
    InvalidConfiguration,
    Discovery,
    Registration,
    InvalidTokens,
    NeedsAuth,
    Rejected,
    StateMismatch,
    IssuerMismatch,
    CodeRequired,
    Callback,
    Storage,
    Random,
}
impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "MCP OAuth failed: {self:?}")
    }
}
impl std::error::Error for Error {}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis().min(i64::MAX as u128) as i64)
}

pub fn integration_id(name: &str, server_url: &LosslessString) -> Result<LosslessString, Error> {
    let input = format!(
        "{name}\0{}",
        server_url
            .to_utf8()
            .map_err(|_| Error::InvalidConfiguration)?
    );
    let hash = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, input.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("mcp_{}", &hash[..16]).into())
}

pub fn to_credential(
    method_id: &LosslessString,
    server_url: &LosslessString,
    tokens: &Value,
    client: Option<&Value>,
    now: i64,
) -> Result<Secret, Error> {
    validate_tokens(tokens)?;
    let seconds = tokens
        .get("expires_in")
        .map(expires_in)
        .transpose()?
        .unwrap_or(0.0);
    let expires = if seconds == 0.0 {
        0.0
    } else {
        now as f64 + seconds * 1000.0
    };
    let mut metadata = json!({"serverUrl":server_url.to_utf8().map_err(|_| Error::InvalidConfiguration)?,"tokenType":tokens["token_type"]});
    if let Some(scope) = tokens["scope"].as_str().filter(|value| !value.is_empty()) {
        metadata["scope"] = json!(scope);
    }
    if let Some(issuer) = tokens["issuer"].as_str().filter(|value| !value.is_empty()) {
        metadata["issuer"] = json!(issuer);
    }
    if let Some(client) = client {
        metadata["client"] = client.clone();
    }
    let value = json!({"type":"oauth","methodID":method_id.to_utf8().map_err(|_| Error::InvalidConfiguration)?,"access":tokens["access_token"],"refresh":tokens["refresh_token"].as_str().unwrap_or(""),"expires":expires,"metadata":metadata});
    Secret::new(parse_json(&value.to_string()).map_err(|_| Error::InvalidTokens)?)
        .map_err(|_| Error::InvalidTokens)
}

pub fn to_tokens(credential: &credential::OAuth, now: i64) -> Result<Value, Error> {
    let metadata = credential
        .metadata
        .as_ref()
        .map(|value| serde_json::from_str::<Value>(&stringify_json(&value.encode())))
        .transpose()
        .map_err(|_| Error::InvalidTokens)?
        .unwrap_or_else(|| json!({}));
    let mut tokens = json!({"access_token":credential.access.to_utf8().map_err(|_| Error::InvalidTokens)?,"token_type":metadata["tokenType"].as_str().unwrap_or("Bearer")});
    if !credential.refresh.is_empty() {
        tokens["refresh_token"] = json!(
            credential
                .refresh
                .to_utf8()
                .map_err(|_| Error::InvalidTokens)?
        );
    }
    if credential.expires.get() != 0 {
        tokens["expires_in"] = json!(credential.expires.get().saturating_sub(now).max(0) / 1000);
    }
    if let Some(scope) = metadata["scope"].as_str() {
        tokens["scope"] = json!(scope);
    }
    if let Some(issuer) = metadata["issuer"].as_str() {
        tokens["issuer"] = json!(issuer);
    }
    Ok(tokens)
}

fn validate_tokens(tokens: &Value) -> Result<(), Error> {
    if tokens["access_token"].as_str().is_none()
        || tokens["token_type"].as_str().is_none()
        || tokens
            .get("refresh_token")
            .is_some_and(|value| !value.is_string())
        || tokens.get("scope").is_some_and(|value| !value.is_string())
    {
        return Err(Error::InvalidTokens);
    }
    Ok(())
}

fn expires_in(value: &Value) -> Result<f64, Error> {
    let number = match value {
        Value::Null => 0.0,
        Value::Bool(value) => u8::from(*value) as f64,
        Value::Number(value) => value.as_f64().ok_or(Error::InvalidTokens)?,
        Value::Array(values) if values.is_empty() => 0.0,
        Value::Array(values) if values.len() == 1 && !values[0].is_boolean() => {
            expires_in(&values[0])?
        }
        Value::String(value) => {
            let text = crate::resources::discovery::trim(value);
            if text.is_empty() {
                return Ok(0.0);
            }
            if let Some((digits, radix)) = [
                ("0x", 16),
                ("0X", 16),
                ("0b", 2),
                ("0B", 2),
                ("0o", 8),
                ("0O", 8),
            ]
            .into_iter()
            .find_map(|(prefix, radix)| text.strip_prefix(prefix).map(|digits| (digits, radix)))
            {
                if digits.is_empty() {
                    return Err(Error::InvalidTokens);
                }
                digits.chars().try_fold(0.0, |number, digit| {
                    Ok(number * radix as f64
                        + digit.to_digit(radix).ok_or(Error::InvalidTokens)? as f64)
                })?
            } else {
                text.parse().map_err(|_| Error::InvalidTokens)?
            }
        }
        _ => return Err(Error::InvalidTokens),
    };
    if !number.is_finite() {
        return Err(Error::InvalidTokens);
    }
    Ok(number)
}

struct Discovery {
    server: Url,
    metadata: Option<Value>,
    resource: Option<Url>,
    scope: Option<String>,
}

impl Discovery {
    fn issuer(&self) -> &str {
        self.metadata
            .as_ref()
            .and_then(|metadata| metadata["issuer"].as_str())
            .unwrap_or(self.server.as_str())
    }
}

fn http() -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .build()
        .map_err(|_| Error::Discovery)
}

fn options(config: &RemoteConfig) -> Result<Option<&OAuthConfig>, Error> {
    match &config.oauth {
        Some(OAuth::Disabled) => Err(Error::Disabled),
        Some(OAuth::Config(config)) => Ok(Some(config)),
        None => Ok(None),
    }
}

fn string(value: Option<&LosslessString>) -> Result<Option<String>, Error> {
    value
        .map(LosslessString::to_utf8)
        .transpose()
        .map_err(|_| Error::InvalidConfiguration)
}

async fn discover(config: &RemoteConfig, challenge: Option<&str>) -> Result<Discovery, Error> {
    let client = http()?;
    let server_url = Url::parse(
        &config
            .url
            .to_utf8()
            .map_err(|_| Error::InvalidConfiguration)?,
    )
    .map_err(|_| Error::InvalidConfiguration)?;
    if !["http", "https"].contains(&server_url.scheme()) {
        return Err(Error::InvalidConfiguration);
    }
    let protected = protected_metadata(&client, &server_url, challenge)
        .await
        .ok();
    let server = if let Some(issuer) = protected
        .as_ref()
        .and_then(|metadata| metadata["authorization_servers"].as_array())
        .and_then(|servers| servers.first())
        .and_then(Value::as_str)
    {
        Url::parse(issuer).map_err(|_| Error::Discovery)?
    } else {
        server_url.join("/").map_err(|_| Error::Discovery)?
    };
    let resource = protected
        .as_ref()
        .map(|metadata| {
            let resource = Url::parse(metadata["resource"].as_str().ok_or(Error::Discovery)?)
                .map_err(|_| Error::Discovery)?;
            if resource.origin() != server_url.origin()
                || !(resource.path() == "/"
                    || server_url.path() == resource.path()
                    || server_url
                        .path()
                        .starts_with(&format!("{}/", resource.path().trim_end_matches('/'))))
            {
                return Err(Error::Discovery);
            }
            Ok(resource)
        })
        .transpose()?;
    let path = server.path().trim_end_matches('/');
    let paths = if path.is_empty() {
        vec![
            ("/.well-known/oauth-authorization-server".to_owned(), false),
            ("/.well-known/openid-configuration".to_owned(), true),
        ]
    } else {
        vec![
            (
                format!("/.well-known/oauth-authorization-server{path}"),
                false,
            ),
            (format!("/.well-known/openid-configuration{path}"), true),
            (format!("{path}/.well-known/openid-configuration"), true),
        ]
    };
    let mut metadata = None;
    for (path, oidc) in paths {
        let response = client
            .get(server.join(&path).map_err(|_| Error::Discovery)?)
            .header("MCP-Protocol-Version", "2025-11-25")
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| Error::Discovery)?;
        if response.status().is_client_error() {
            continue;
        }
        if !response.status().is_success() {
            return Err(Error::Discovery);
        }
        let value = response
            .json::<Value>()
            .await
            .map_err(|_| Error::Discovery)?;
        super::validation::authorization(&value, oidc)?;
        metadata = Some(value);
        break;
    }
    let configured = string(options(config)?.and_then(|options| options.scope.as_ref()))?
        .filter(|scope| !scope.is_empty());
    let resource_scope = protected
        .as_ref()
        .and_then(|metadata| metadata["scopes_supported"].as_array())
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|scope| !scope.is_empty());
    let mut scope = if let Some(challenge) = challenge {
        header_field(challenge, "scope")
            .filter(|scope| !scope.is_empty())
            .map(str::to_owned)
            .or(resource_scope)
            .or(configured)
    } else {
        configured.or(resource_scope)
    };
    if let Some(scope) = &mut scope
        && metadata
            .as_ref()
            .and_then(|metadata| metadata["scopes_supported"].as_array())
            .is_some_and(|scopes| scopes.iter().any(|scope| scope == "offline_access"))
        && !scope.split(' ').any(|scope| scope == "offline_access")
    {
        scope.push_str(" offline_access");
    }
    Ok(Discovery {
        server,
        metadata,
        resource,
        scope,
    })
}

async fn protected_metadata(
    client: &reqwest::Client,
    server_url: &Url,
    challenge: Option<&str>,
) -> Result<Value, Error> {
    let path = server_url.path().trim_end_matches('/');
    let advertised = challenge
        .and_then(|challenge| header_field(challenge, "resource_metadata"))
        .and_then(|value| Url::parse(value).ok());
    let mut metadata_url = server_url
        .join(&format!("/.well-known/oauth-protected-resource{path}"))
        .map_err(|_| Error::Discovery)?;
    metadata_url.set_query(server_url.query());
    let metadata_url = advertised.clone().unwrap_or(metadata_url);
    let mut response = client
        .get(metadata_url)
        .header("MCP-Protocol-Version", "2025-11-25")
        .send()
        .await
        .map_err(|_| Error::Discovery)?;
    if advertised.is_none() && response.status().is_client_error() && !path.is_empty() {
        response = client
            .get(
                server_url
                    .join("/.well-known/oauth-protected-resource")
                    .map_err(|_| Error::Discovery)?,
            )
            .header("MCP-Protocol-Version", "2025-11-25")
            .send()
            .await
            .map_err(|_| Error::Discovery)?;
    }
    if response.status().is_success() {
        let value = response
            .json::<Value>()
            .await
            .map_err(|_| Error::Discovery)?;
        super::validation::protected(&value)?;
        Ok(value)
    } else {
        Err(Error::Discovery)
    }
}

pub(crate) fn header_field<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header
        .split_once(&format!("{name}=\""))
        .and_then(|(_, value)| value.split_once('"').map(|(value, _)| value))
}

pub(crate) async fn prepare_authorization(
    config: &RemoteConfig,
    challenge: &str,
    current: Option<&Info>,
) -> Result<(), Error> {
    let discovery = discover(config, Some(challenge)).await?;
    let known_client=current.map(|info|info.secret().domain().map_err(|_|Error::InvalidTokens)).transpose()?.is_some_and(|value|matches!(value,credential::Value::OAuth(value) if value.metadata.as_ref().is_some_and(|metadata|metadata.get(&"client".into()).is_some())));
    if static_client(config)?.is_none() && !known_client {
        let redirect = string(options(config)?.and_then(|options| options.redirect_uri.as_ref()))?
            .unwrap_or_else(|| "http://127.0.0.1/callback".into());
        register(&discovery, &redirect).await?;
    }
    Ok(())
}

fn endpoint(discovery: &Discovery, field: &str, fallback: &str) -> Result<Url, Error> {
    match &discovery.metadata {
        Some(metadata) => {
            super::validation::safe_url(metadata[field].as_str().ok_or(Error::Discovery)?)
        }
        None => discovery
            .server
            .join(fallback)
            .map_err(|_| Error::Discovery),
    }
}

fn static_client(config: &RemoteConfig) -> Result<Option<Value>, Error> {
    let options = options(config)?;
    let Some(id) =
        string(options.and_then(|options| options.client_id.as_ref()))?.filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let mut client = json!({"client_id":id});
    if let Some(secret) = string(options.and_then(|options| options.client_secret.as_ref()))? {
        client["client_secret"] = json!(secret);
    }
    Ok(Some(client))
}

async fn register(discovery: &Discovery, redirect: &str) -> Result<Value, Error> {
    let mut metadata = json!({"client_name":"ycoding","redirect_uris":[redirect],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"});
    metadata["application_type"] = json!(if super::validation::loopback_redirect(redirect) {
        "native"
    } else {
        "web"
    });
    if let Some(scope) = &discovery.scope {
        metadata["scope"] = json!(scope);
    }
    let response = http()?
        .post(endpoint(discovery, "registration_endpoint", "/register")?)
        .header("Content-Type", "application/json")
        .body(metadata.to_string())
        .send()
        .await
        .map_err(|_| Error::Registration)?;
    if !response.status().is_success() {
        return Err(Error::Registration);
    }
    let client = response
        .json::<Value>()
        .await
        .map_err(|_| Error::Registration)?;
    let mut client = super::validation::client(client)?;
    client["issuer"] = json!(discovery.issuer());
    Ok(client)
}

fn auth_method<'a>(client: &'a Value, discovery: &Discovery) -> &'a str {
    let supported = discovery
        .metadata
        .as_ref()
        .and_then(|metadata| metadata["token_endpoint_auth_methods_supported"].as_array());
    let supports =
        |method: &str| supported.is_some_and(|methods| methods.iter().any(|value| value == method));
    let empty = supported.is_none_or(Vec::is_empty);
    if let Some(method) = client["token_endpoint_auth_method"].as_str()
        && ["client_secret_basic", "client_secret_post", "none"].contains(&method)
        && (empty || supports(method))
    {
        return method;
    }
    let has_secret = client.get("client_secret").is_some();
    if empty {
        return if has_secret {
            "client_secret_basic"
        } else {
            "none"
        };
    }
    if has_secret && supports("client_secret_basic") {
        return "client_secret_basic";
    }
    if has_secret && supports("client_secret_post") {
        return "client_secret_post";
    }
    if supports("none") {
        return "none";
    }
    if has_secret {
        "client_secret_post"
    } else {
        "none"
    }
}

async fn token(
    discovery: &Discovery,
    client: &Value,
    mut fields: Vec<(String, String)>,
) -> Result<Value, Error> {
    let id = client["client_id"]
        .as_str()
        .ok_or(Error::InvalidConfiguration)?;
    let endpoint = endpoint(discovery, "token_endpoint", "/token")?;
    let mut authorization = None;
    match auth_method(client, discovery) {
        "client_secret_basic" => {
            let secret = client["client_secret"]
                .as_str()
                .filter(|secret| !secret.is_empty())
                .ok_or(Error::InvalidConfiguration)?;
            authorization = Some(format!(
                "Basic {}",
                encode_base64(format!("{id}:{secret}").as_bytes(), false)
            ));
        }
        "client_secret_post" => {
            fields.push(("client_id".into(), id.into()));
            if let Some(secret) = client["client_secret"]
                .as_str()
                .filter(|secret| !secret.is_empty())
            {
                fields.push(("client_secret".into(), secret.into()));
            }
        }
        _ => fields.push(("client_id".into(), id.into())),
    }
    if let Some(resource) = &discovery.resource {
        fields.push(("resource".into(), resource.to_string()));
    }
    let refresh = fields
        .iter()
        .find(|(name, value)| name == "grant_type" && value == "refresh_token")
        .and_then(|_| fields.iter().find(|(name, _)| name == "refresh_token"))
        .map(|(_, value)| value.clone());
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields)
        .finish();
    let key = format!(
        "{endpoint}\0{}\0{body}",
        authorization.as_deref().unwrap_or("")
    );

    let send = async {
        let mut request = http()?
            .post(endpoint.clone())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json");
        if let Some(authorization) = authorization {
            request = request.header("Authorization", authorization);
        }
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|_| Error::Rejected)?;
        let status = response.status();
        let mut value = response
            .json::<Value>()
            .await
            .map_err(|_| Error::InvalidTokens)?;
        if !status.is_success() {
            return Err(
                if ["invalid_grant", "invalid_client", "unauthorized_client"]
                    .contains(&value["error"].as_str().unwrap_or(""))
                {
                    Error::NeedsAuth
                } else {
                    Error::Rejected
                },
            );
        }
        validate_tokens(&value)?;
        value["issuer"] = json!(discovery.issuer());
        Ok(value)
    };
    match refresh {
        Some(refresh) => shared_exchange(endpoint.as_str(), key, &refresh, send).await,
        None => send.await,
    }
}

type Exchange = Arc<OnceCell<Result<Value, Error>>>;
struct Exchanges {
    pending: BTreeMap<String, Exchange>,
    rotations: BTreeMap<String, String>,
}
static EXCHANGES: Mutex<Exchanges> = Mutex::new(Exchanges {
    pending: BTreeMap::new(),
    rotations: BTreeMap::new(),
});

/// Exchanges a refresh token once per process. Identical in-flight requests share one exchange, and
/// a response that rotated the token stays reusable until a request presents the rotated token,
/// because a single-use token a sibling connection already spent would otherwise be rejected.
async fn shared_exchange(
    endpoint: &str,
    key: String,
    refresh: &str,
    send: impl Future<Output = Result<Value, Error>>,
) -> Result<Value, Error> {
    let exchange = {
        let mut exchanges = EXCHANGES.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(superseded) = exchanges
            .rotations
            .remove(&format!("{endpoint}\0{refresh}"))
        {
            exchanges.pending.remove(&superseded);
        }
        exchanges.pending.entry(key.clone()).or_default().clone()
    };
    exchange
        .get_or_init(|| async {
            let result = send.await;
            let rotated = result
                .as_ref()
                .ok()
                .and_then(|tokens| tokens["refresh_token"].as_str())
                .filter(|rotated| *rotated != refresh);
            let mut exchanges = EXCHANGES.lock().unwrap_or_else(PoisonError::into_inner);
            match rotated {
                Some(rotated) => {
                    exchanges
                        .rotations
                        .insert(format!("{endpoint}\0{rotated}"), key);
                }
                None => {
                    if exchanges
                        .pending
                        .get(&key)
                        .is_some_and(|pending| Arc::ptr_eq(pending, &exchange))
                    {
                        exchanges.pending.remove(&key);
                    }
                }
            }
            result
        })
        .await
        .clone()
}

pub struct Attempt {
    url: String,
    callback: super::callback::Callback,
    redirect: Url,
    verifier: String,
    discovery: Discovery,
    client: Value,
    registered: bool,
    method: LosslessString,
    server_url: LosslessString,
}
impl fmt::Debug for Attempt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("McpOAuthAttempt([redacted])")
    }
}
impl Attempt {
    pub fn url(&self) -> &str {
        &self.url
    }
    pub async fn finish(mut self) -> Result<Secret, Error> {
        let result = async {
            let code = self.callback.wait().await?;
            let tokens = token(
                &self.discovery,
                &self.client,
                vec![
                    ("grant_type".into(), "authorization_code".into()),
                    ("code".into(), code),
                    ("code_verifier".into(), self.verifier.clone()),
                    ("redirect_uri".into(), self.redirect.to_string()),
                ],
            )
            .await?;
            to_credential(
                &self.method,
                &self.server_url,
                &tokens,
                self.registered.then_some(&self.client),
                now(),
            )
        }
        .await;
        self.callback.close().await?;
        result
    }
    pub async fn cancel(mut self) -> Result<(), Error> {
        self.callback.close().await
    }
}

pub async fn authorize(name: &str, config: &RemoteConfig) -> Result<Attempt, Error> {
    let options = options(config)?;
    let configured_redirect = string(options.and_then(|config| config.redirect_uri.as_ref()))?
        .map(|value| Url::parse(&value).map_err(|_| Error::InvalidConfiguration))
        .transpose()?;
    let port = options
        .and_then(|config| config.callback_port)
        .map(|port| port.get() as u16)
        .or_else(|| configured_redirect.as_ref().and_then(Url::port))
        .unwrap_or(0);
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| Error::Callback)?;
    let redirect = match configured_redirect {
        Some(redirect) => redirect,
        None => Url::parse(&format!(
            "http://127.0.0.1:{}/callback",
            listener.local_addr().map_err(|_| Error::Callback)?.port()
        ))
        .map_err(|_| Error::Callback)?,
    };
    let discovery = discover(config, None).await?;
    let configured_client = static_client(config)?;
    let registered = configured_client.is_none();
    let client = if let Some(client) = configured_client {
        client
    } else {
        register(&discovery, redirect.as_str()).await?
    };
    if let Some(metadata) = &discovery.metadata
        && (!metadata["response_types_supported"]
            .as_array()
            .is_some_and(|values| values.iter().any(|value| value == "code"))
            || metadata
                .get("code_challenge_methods_supported")
                .is_some_and(|methods| {
                    !methods
                        .as_array()
                        .is_some_and(|methods| methods.iter().any(|method| method == "S256"))
                }))
    {
        return Err(Error::Discovery);
    }
    let mut random = [0; 32];
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| Error::Random)?;
    let state = encode_base64(&random, true);
    SystemRandom::new()
        .fill(&mut random)
        .map_err(|_| Error::Random)?;
    let verifier = encode_base64(&random, true);
    let challenge = encode_base64(
        ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()).as_ref(),
        true,
    );
    let mut url = endpoint(&discovery, "authorization_endpoint", "/authorize")?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair(
            "client_id",
            client["client_id"].as_str().ok_or(Error::Registration)?,
        )
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("redirect_uri", redirect.as_str())
        .append_pair("state", &state);
    if let Some(scope) = &discovery.scope {
        url.query_pairs_mut().append_pair("scope", scope);
        if scope.split(' ').any(|scope| scope == "offline_access") {
            url.query_pairs_mut().append_pair("prompt", "consent");
        }
    }
    if let Some(resource) = &discovery.resource {
        url.query_pairs_mut()
            .append_pair("resource", resource.as_str());
    }
    Ok(Attempt {
        url: url.into(),
        callback: super::callback::Callback::new(
            listener,
            redirect.clone(),
            state,
            name.into(),
            discovery.metadata.clone(),
        ),
        redirect,
        verifier,
        discovery,
        client,
        registered,
        method: integration_id(name, &config.url)?,
        server_url: config.url.clone(),
    })
}

pub fn stored(service: &Service, name: &str, config: &RemoteConfig) -> Result<Option<Info>, Error> {
    options(config)?;
    Ok(service
        .active(&integration_id(name, &config.url)?)
        .map_err(|_| Error::Storage)?
        .filter(|info| matches!(info.secret().domain(), Ok(credential::Value::OAuth(_)))))
}

pub async fn refresh(service: &Service, info: &Info, config: &RemoteConfig) -> Result<Info, Error> {
    renew(service, info, config, None).await
}

/// Refreshes the stored credential. A rejected refresh token removes the credential only while it is
/// still the stored one; when another holder already replaced it, the replacement is refreshed once instead.
pub(crate) async fn renew(
    service: &Service,
    info: &Info,
    config: &RemoteConfig,
    challenge: Option<&str>,
) -> Result<Info, Error> {
    let mut current = info.clone();
    let mut replaced = false;
    loop {
        if refresh_token(&current)?.is_empty() {
            return Err(Error::NeedsAuth);
        }
        match exchange_refresh(service, &current, config, challenge).await {
            Err(Error::IssuerMismatch) => return Err(Error::NeedsAuth),
            Err(Error::NeedsAuth) => {
                let Some(latest) = service.get(current.id()).map_err(|_| Error::Storage)? else {
                    return Err(Error::NeedsAuth);
                };
                if refresh_token(&latest)? == refresh_token(&current)? {
                    service
                        .remove(current.id().clone(), now())
                        .await
                        .map_err(|_| Error::Storage)?;
                    return Err(Error::NeedsAuth);
                }
                if replaced {
                    return Err(Error::NeedsAuth);
                }
                replaced = true;
                current = latest;
            }
            result => return result,
        }
    }
}

fn refresh_token(info: &Info) -> Result<String, Error> {
    let credential::Value::OAuth(value) =
        info.secret().domain().map_err(|_| Error::InvalidTokens)?
    else {
        return Err(Error::InvalidTokens);
    };
    value.refresh.to_utf8().map_err(|_| Error::InvalidTokens)
}

async fn exchange_refresh(
    service: &Service,
    info: &Info,
    config: &RemoteConfig,
    challenge: Option<&str>,
) -> Result<Info, Error> {
    let credential::Value::OAuth(current) =
        info.secret().domain().map_err(|_| Error::InvalidTokens)?
    else {
        return Err(Error::InvalidTokens);
    };
    let discovery = discover(config, challenge).await?;
    let metadata = current
        .metadata
        .as_ref()
        .map(|value| serde_json::from_str::<Value>(&stringify_json(&value.encode())))
        .transpose()
        .map_err(|_| Error::InvalidTokens)?
        .unwrap_or_else(|| json!({}));
    if metadata["issuer"]
        .as_str()
        .is_some_and(|issuer| !issuer_matches(issuer, discovery.issuer()))
    {
        return Err(Error::IssuerMismatch);
    }
    let configured = static_client(config)?;
    if configured.is_none()
        && metadata
            .get("client")
            .is_some_and(|client| !client.is_object())
    {
        return Err(Error::InvalidConfiguration);
    }
    let registered = configured.is_none();
    let mut client = match configured.or_else(|| {
        metadata
            .get("client")
            .filter(|client| {
                client["issuer"]
                    .as_str()
                    .is_none_or(|issuer| issuer_matches(issuer, discovery.issuer()))
            })
            .cloned()
    }) {
        Some(client) => client,
        None => {
            let redirect =
                string(options(config)?.and_then(|options| options.redirect_uri.as_ref()))?
                    .unwrap_or_else(|| "http://127.0.0.1/callback".into());
            register(&discovery, &redirect).await?
        }
    };
    client["issuer"] = json!(discovery.issuer());
    let mut tokens = token(
        &discovery,
        &client,
        vec![
            ("grant_type".into(), "refresh_token".into()),
            (
                "refresh_token".into(),
                current
                    .refresh
                    .to_utf8()
                    .map_err(|_| Error::InvalidTokens)?,
            ),
        ],
    )
    .await?;
    if tokens.get("refresh_token").is_none() {
        tokens["refresh_token"] = json!(
            current
                .refresh
                .to_utf8()
                .map_err(|_| Error::InvalidTokens)?
        );
    }
    let value = to_credential(
        current.method_id.as_lossless(),
        &config.url,
        &tokens,
        registered.then_some(&client),
        now(),
    )?;
    service
        .update(info.id().clone(), None, Some(value), now())
        .await
        .map_err(|_| Error::Storage)?;
    service
        .get(info.id())
        .map_err(|_| Error::Storage)?
        .ok_or(Error::Storage)
}

fn issuer_matches(recorded: &str, current: &str) -> bool {
    recorded == current
        || recorded.strip_suffix('/') == Some(current)
        || current.strip_suffix('/') == Some(recorded)
}
