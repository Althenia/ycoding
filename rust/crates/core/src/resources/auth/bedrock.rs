use super::super::credential::Error;
use ring::{
    digest,
    hmac::{self, Key},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fmt,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const IMDS_BASE: &str = "http://169.254.169.254";
const CONTAINER_BASE: &str = "http://169.254.170.2";
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Credentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    pub expires_at: Option<i64>,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BedrockCredentials([redacted])")
    }
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    pub profile: Option<String>,
    pub home: Option<PathBuf>,
    pub shared_credentials_file: Option<PathBuf>,
    pub config_file: Option<PathBuf>,
    pub region: Option<String>,
    pub imds_endpoint: Option<String>,
    pub container_base: Option<String>,
    pub sts_endpoint: Option<String>,
    pub sso_endpoint: Option<String>,
    pub timeout: Duration,
}

pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub fn sso_cache_name(start_url: &str) -> String {
    digest::digest(&digest::SHA1_FOR_LEGACY_USE_ONLY, start_url.as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn region(setting: Option<&str>, env: &BTreeMap<String, String>, endpoint: &str) -> String {
    if let Some(region) = setting.filter(|region| !region.is_empty()) {
        return region.into();
    }
    if let Some(region) = nonempty(env, "AWS_REGION") {
        return region;
    }
    if let Some(host) = endpoint
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
    {
        let mut parts = host.split('.');
        if parts.next() == Some("bedrock-runtime")
            && let Some(region) = parts.next()
            && !region.is_empty()
            && parts.next() == Some("amazonaws")
        {
            return region.into();
        }
    }
    "us-east-1".into()
}

fn nonempty(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    env.get(key).filter(|value| !value.is_empty()).cloned()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn fresh(expires_at: Option<i64>) -> bool {
    expires_at.is_none_or(|expires| expires > now() + 30)
}

fn parse_expiration(value: &Value) -> Result<Option<i64>, Error> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => chrono::DateTime::parse_from_rfc3339(text)
            .map(|time| Some(time.timestamp()))
            .map_err(|_| Error::InvalidCredential),
        Value::Number(number) => number
            .as_i64()
            .map(|millis| Some(millis / 1000))
            .ok_or(Error::InvalidCredential),
        _ => Err(Error::InvalidCredential),
    }
}

fn text(value: &Value, key: &str) -> Result<String, Error> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(Error::InvalidCredential)
}

fn keyed(mut credentials: Credentials) -> Option<Credentials> {
    if credentials.access_key_id.is_empty() || credentials.secret_access_key.is_empty() {
        return None;
    }
    if credentials
        .session_token
        .as_deref()
        .is_some_and(str::is_empty)
    {
        credentials.session_token = None;
    }
    fresh(credentials.expires_at).then_some(credentials)
}

fn static_credentials(
    section: &BTreeMap<String, String>,
    prefix: &str,
) -> Result<Option<Credentials>, Error> {
    let access = section.get(format!("{prefix}aws_access_key_id").as_str());
    let secret = section.get(format!("{prefix}aws_secret_access_key").as_str());
    if access.is_none() && secret.is_none() {
        return Ok(None);
    }
    let (Some(access), Some(secret)) = (access, secret) else {
        return Err(Error::InvalidCredential);
    };
    Ok(keyed(Credentials {
        access_key_id: access.clone(),
        secret_access_key: secret.clone(),
        session_token: section
            .get(format!("{prefix}aws_session_token").as_str())
            .cloned(),
        expires_at: None,
    }))
}

fn parse_ini(text: &str) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut sections = BTreeMap::new();
    let mut current = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }
        if line.starts_with('[')
            && let Some(end) = line.find(']')
        {
            current = line[1..end].trim().into();
            sections
                .entry(current.clone())
                .or_insert_with(BTreeMap::new);
            continue;
        }
        if current.is_empty() {
            continue;
        }
        if let Some((key, value)) = line.split_once('=')
            && !key.trim().is_empty()
        {
            sections
                .entry(current.clone())
                .or_insert_with(BTreeMap::new)
                .insert(
                    key.trim().to_ascii_lowercase(),
                    unquote(value.trim()).into(),
                );
        }
    }
    sections
}

fn unquote(value: &str) -> &str {
    if value.len() >= 2
        && let Some(quote) = value.chars().next()
        && (quote == '"' || quote == '\'')
        && value.ends_with(quote)
    {
        return &value[1..value.len() - 1];
    }
    value
}

fn profile_name(env: &BTreeMap<String, String>, explicit: Option<&str>) -> String {
    if let Some(profile) = explicit.filter(|profile| !profile.is_empty()) {
        return profile.into();
    }
    nonempty(env, "AWS_PROFILE").unwrap_or_else(|| "default".into())
}

fn credentials_path(env: &BTreeMap<String, String>, options: &Options) -> Option<PathBuf> {
    if let Some(path) = &options.shared_credentials_file {
        return Some(path.clone());
    }
    if let Some(path) = nonempty(env, "AWS_SHARED_CREDENTIALS_FILE") {
        return Some(path.into());
    }
    options
        .home
        .clone()
        .map(|home| home.join(".aws/credentials"))
}

fn config_path(env: &BTreeMap<String, String>, options: &Options) -> Option<PathBuf> {
    if let Some(path) = &options.config_file {
        return Some(path.clone());
    }
    if let Some(path) = nonempty(env, "AWS_CONFIG_FILE") {
        return Some(path.into());
    }
    options.home.clone().map(|home| home.join(".aws/config"))
}

fn read_section(path: Option<PathBuf>, name: &str) -> Result<BTreeMap<String, String>, Error> {
    let Some(path) = path else {
        return Ok(BTreeMap::new());
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err(Error::InvalidCredential),
    };
    let sections = parse_ini(&text);
    Ok(sections.get(name).cloned().unwrap_or_default())
}

fn profile_sections(
    env: &BTreeMap<String, String>,
    options: &Options,
    profile: &str,
) -> Result<BTreeMap<String, String>, Error> {
    let mut merged = read_section(config_path(env, options), &format!("profile {profile}"))?;
    if profile == "default" {
        for (key, value) in read_section(config_path(env, options), "default")? {
            merged.entry(key).or_insert(value);
        }
    }
    for (key, value) in read_section(credentials_path(env, options), profile)? {
        merged.insert(key, value);
    }
    Ok(merged)
}

fn form_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                return char::from(byte).to_string();
            }
            format!("%{byte:02X}")
        })
        .collect()
}

fn sign_sts(
    access_key_id: &str,
    secret_access_key: &str,
    session_token: Option<&str>,
    region: &str,
    host: &str,
    datetime: &str,
    body: &str,
) -> BTreeMap<String, String> {
    let scope = format!("{}/{region}/sts/aws4_request", &datetime[..8]);
    let hash = digest::digest(&digest::SHA256, body.as_bytes());
    let body_hash: String = hash
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut names = vec!["host", "x-amz-date"];
    if session_token.is_some() {
        names.push("x-amz-security-token");
    }
    let signed = names.join(";");
    let mut amz = String::from("host:");
    amz.push_str(host);
    amz.push_str("\nx-amz-date:");
    amz.push_str(datetime);
    amz.push('\n');
    if let Some(token) = session_token {
        amz.push_str("x-amz-security-token:");
        amz.push_str(token);
        amz.push('\n');
    }
    let canonical = format!("POST\n/\n\n{amz}\n{signed}\n{body_hash}");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{}",
        digest::digest(&digest::SHA256, canonical.as_bytes())
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let sign =
        |key: &[u8], value: &str| hmac::sign(&Key::new(hmac::HMAC_SHA256, key), value.as_bytes());
    let date_key = sign(
        format!("AWS4{secret_access_key}").as_bytes(),
        &datetime[..8],
    );
    let region_key = sign(date_key.as_ref(), region);
    let service_key = sign(region_key.as_ref(), "sts");
    let signing_key = sign(service_key.as_ref(), "aws4_request");
    let signature: String = sign(signing_key.as_ref(), &to_sign)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut headers = BTreeMap::from([
        ("x-amz-date".into(), datetime.into()),
        (
            "authorization".into(),
            format!(
                "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed}, Signature={signature}"
            ),
        ),
    ]);
    if let Some(token) = session_token {
        headers.insert("x-amz-security-token".into(), token.into());
    }
    headers
}

fn sts_host(endpoint: Option<&str>, region: &str) -> Result<(String, String), Error> {
    let fallback = format!("https://sts.{region}.amazonaws.com");
    let endpoint = endpoint.unwrap_or(&fallback);
    let url = reqwest::Url::parse(endpoint).map_err(|_| Error::InvalidCredential)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::Rejected);
    }
    let host: String = url.host_str().ok_or(Error::InvalidCredential)?.into();
    let sign = match url.port() {
        Some(port) if Some(port) != url.port_or_known_default() => format!("{host}:{port}"),
        _ => host.clone(),
    };
    let base = match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    };
    Ok((base, sign))
}

fn xml_tag(body: &str, name: &str) -> Result<String, Error> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = body.find(&open).ok_or(Error::InvalidCredential)? + open.len();
    let end = body[start..].find(&close).ok_or(Error::InvalidCredential)?;
    let value = body[start..start + end].trim();
    (!value.is_empty())
        .then(|| value.into())
        .ok_or(Error::InvalidCredential)
}

fn sts_credentials(body: &str) -> Result<Credentials, Error> {
    let credentials = Credentials {
        access_key_id: xml_tag(body, "AccessKeyId")?,
        secret_access_key: xml_tag(body, "SecretAccessKey")?,
        session_token: xml_tag(body, "SessionToken").ok(),
        expires_at: body
            .find("<Expiration>")
            .and_then(|_| xml_tag(body, "Expiration").ok())
            .and_then(|text| {
                chrono::DateTime::parse_from_rfc3339(&text)
                    .map(|time| time.timestamp())
                    .ok()
            }),
    };
    keyed(credentials).ok_or(Error::InvalidCredential)
}

fn split_command(command: &str) -> Result<(String, Vec<String>), Error> {
    let mut parts = command
        .split_whitespace()
        .map(|part| unquote(part).to_owned())
        .collect::<Vec<_>>();
    if parts.is_empty() || parts.iter().any(String::is_empty) {
        return Err(Error::InvalidCredential);
    }
    Ok((parts.remove(0), parts))
}

fn process_credentials(stdout: &str) -> Result<Credentials, Error> {
    let value: Value = serde_json::from_str(stdout).map_err(|_| Error::InvalidCredential)?;
    if let Some(version) = value.get("Version").and_then(Value::as_u64)
        && version != 1
    {
        return Err(Error::InvalidCredential);
    }
    let credentials = Credentials {
        access_key_id: text(&value, "AccessKeyId")?,
        secret_access_key: text(&value, "SecretAccessKey")?,
        session_token: value
            .get("SessionToken")
            .and_then(Value::as_str)
            .map(str::to_owned),
        expires_at: value
            .get("Expiration")
            .map(parse_expiration)
            .transpose()?
            .flatten(),
    };
    keyed(credentials).ok_or(Error::InvalidCredential)
}

struct Chain<'a> {
    env: &'a BTreeMap<String, String>,
    options: &'a Options,
    http: &'a reqwest::Client,
    region: String,
}

impl Chain<'_> {
    fn profile(&self) -> String {
        profile_name(self.env, self.options.profile.as_deref())
    }

    fn endpoint(&self, override_: Option<&str>, default: String) -> Result<String, Error> {
        let endpoint = override_
            .unwrap_or(&default)
            .trim_end_matches('/')
            .to_owned();
        let url = reqwest::Url::parse(&endpoint).map_err(|_| Error::InvalidCredential)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.username() != ""
            || url.password().is_some()
        {
            return Err(Error::Rejected);
        }
        Ok(endpoint)
    }

    fn env_credentials(&self) -> Result<Option<Credentials>, Error> {
        let access = nonempty(self.env, "AWS_ACCESS_KEY_ID");
        let secret = nonempty(self.env, "AWS_SECRET_ACCESS_KEY");
        if access.is_none() && secret.is_none() {
            return Ok(None);
        }
        let (Some(access), Some(secret)) = (access, secret) else {
            return Ok(None);
        };
        Ok(keyed(Credentials {
            access_key_id: access,
            secret_access_key: secret,
            session_token: nonempty(self.env, "AWS_SESSION_TOKEN"),
            expires_at: None,
        }))
    }

    async fn run_process(&self, command: &str) -> Result<Credentials, Error> {
        let (program, args) = split_command(command)?;
        let output = tokio::time::timeout(
            PROCESS_TIMEOUT,
            tokio::process::Command::new(program).args(args).output(),
        )
        .await
        .map_err(|_| Error::InvalidCredential)?
        .map_err(|_| Error::InvalidCredential)?;
        if !output.status.success() {
            return Err(Error::InvalidCredential);
        }
        process_credentials(
            std::str::from_utf8(&output.stdout).map_err(|_| Error::InvalidCredential)?,
        )
    }

    async fn sso_credentials(
        &self,
        section: &BTreeMap<String, String>,
    ) -> Result<Option<Credentials>, Error> {
        let (start_url, region, account, role) = if let Some(session) = section.get("sso_session") {
            let sessions = read_section(
                config_path(self.env, self.options),
                &format!("sso-session {session}"),
            )?;
            (
                sessions.get("sso_start_url").cloned(),
                sessions.get("sso_region").cloned(),
                section.get("sso_account_id").cloned(),
                section.get("sso_role_name").cloned(),
            )
        } else {
            (
                section.get("sso_start_url").cloned(),
                section.get("sso_region").cloned(),
                section.get("sso_account_id").cloned(),
                section.get("sso_role_name").cloned(),
            )
        };
        let (Some(start_url), Some(region), Some(account), Some(role)) =
            (start_url, region, account, role)
        else {
            return Ok(None);
        };
        let Some(home) = self.options.home.clone() else {
            return Err(Error::InvalidCredential);
        };
        let cached = home
            .join(".aws/sso/cache")
            .join(format!("{}.json", sso_cache_name(&start_url)));
        let token: Value = serde_json::from_str(
            &std::fs::read_to_string(&cached).map_err(|_| Error::InvalidCredential)?,
        )
        .map_err(|_| Error::InvalidCredential)?;
        let expired = token
            .get("expiresAt")
            .map(parse_expiration)
            .transpose()?
            .flatten()
            .is_none_or(|expires| expires <= now() + 30);
        if expired {
            return Err(Error::InvalidCredential);
        }
        let bearer = token
            .get("accessToken")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(Error::InvalidCredential)?;
        let endpoint = self.endpoint(
            self.options.sso_endpoint.as_deref(),
            format!("https://portal.sso.{region}.amazonaws.com"),
        )?;
        let response = self
            .http
            .get(format!(
                "{endpoint}/federation/credentials?role_name={}&account_id={}",
                form_encode(&role),
                form_encode(&account)
            ))
            .header("x-amz-sso_bearer_token", bearer)
            .send()
            .await
            .map_err(|_| Error::InvalidCredential)?;
        if !response.status().is_success() {
            return Err(Error::InvalidCredential);
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| Error::InvalidCredential)?;
        let role_credentials = body
            .get("roleCredentials")
            .ok_or(Error::InvalidCredential)?;
        let credentials = Credentials {
            access_key_id: text(role_credentials, "accessKeyId")?,
            secret_access_key: text(role_credentials, "secretAccessKey")?,
            session_token: role_credentials
                .get("sessionToken")
                .and_then(Value::as_str)
                .map(str::to_owned),
            expires_at: role_credentials
                .get("expiration")
                .map(parse_expiration)
                .transpose()?
                .flatten(),
        };
        keyed(credentials).ok_or(Error::InvalidCredential).map(Some)
    }

    async fn assume_role(
        &self,
        source: &Credentials,
        role_arn: &str,
        session_name: Option<&str>,
    ) -> Result<Credentials, Error> {
        let (base, host) = sts_host(self.options.sts_endpoint.as_deref(), &self.region)?;
        let session = session_name
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .or_else(|| nonempty(self.env, "AWS_ROLE_SESSION_NAME"))
            .unwrap_or_else(|| "ycoding".into());
        let params = [
            ("Action", "AssumeRole".to_owned()),
            ("RoleArn", role_arn.into()),
            ("RoleSessionName", session),
            ("Version", "2011-06-15".into()),
        ];
        let mut encoded = params
            .iter()
            .map(|(key, value)| format!("{}={}", form_encode(key), form_encode(value)))
            .collect::<Vec<_>>();
        encoded.sort();
        let body = encoded.join("&");
        let datetime = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let mut headers = sign_sts(
            &source.access_key_id,
            &source.secret_access_key,
            source.session_token.as_deref(),
            &self.region,
            &host,
            &datetime,
            &body,
        );
        headers.insert(
            "content-type".into(),
            "application/x-www-form-urlencoded".into(),
        );
        let mut request = self.http.post(format!("{base}/"));
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|_| Error::InvalidCredential)?;
        if !response.status().is_success() {
            return Err(Error::InvalidCredential);
        }
        sts_credentials(
            &response
                .text()
                .await
                .map_err(|_| Error::InvalidCredential)?,
        )
    }

    async fn web_identity(&self) -> Result<Option<Credentials>, Error> {
        let (Some(role), Some(token_file)) = (
            nonempty(self.env, "AWS_ROLE_ARN"),
            nonempty(self.env, "AWS_WEB_IDENTITY_TOKEN_FILE"),
        ) else {
            return Ok(None);
        };
        let token = std::fs::read_to_string(token_file)
            .map_err(|_| Error::InvalidCredential)?
            .trim()
            .to_owned();
        if token.is_empty() {
            return Err(Error::InvalidCredential);
        }
        self.assume_role_web_identity(&role, &token).await.map(Some)
    }

    async fn assume_role_web_identity(
        &self,
        role_arn: &str,
        token: &str,
    ) -> Result<Credentials, Error> {
        let (base, _) = sts_host(self.options.sts_endpoint.as_deref(), &self.region)?;
        let session =
            nonempty(self.env, "AWS_ROLE_SESSION_NAME").unwrap_or_else(|| "ycoding".into());
        let params = [
            ("Action", "AssumeRoleWithWebIdentity".to_owned()),
            ("RoleArn", role_arn.into()),
            ("RoleSessionName", session),
            ("WebIdentityToken", token.into()),
            ("Version", "2011-06-15".to_owned()),
        ];
        let mut encoded = params
            .iter()
            .map(|(key, value)| format!("{}={}", form_encode(key), form_encode(value)))
            .collect::<Vec<_>>();
        encoded.sort();
        let body = encoded.join("&");
        let response = self
            .http
            .post(format!("{base}/"))
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|_| Error::InvalidCredential)?;
        if !response.status().is_success() {
            return Err(Error::InvalidCredential);
        }
        sts_credentials(
            &response
                .text()
                .await
                .map_err(|_| Error::InvalidCredential)?,
        )
    }

    async fn profile_credentials(
        &self,
        profile: &str,
        depth: usize,
    ) -> Result<Option<Credentials>, Error> {
        if depth > 5 {
            return Err(Error::InvalidCredential);
        }
        let section = profile_sections(self.env, self.options, profile)?;
        if section.is_empty() {
            return Ok(None);
        }
        if let Some(credentials) = static_credentials(&section, "")? {
            return Ok(Some(credentials));
        }
        if let Some(command) = section.get("credential_process") {
            return self.run_process(command).await.map(Some);
        }
        if section.contains_key("sso_start_url")
            || section.contains_key("sso_session")
            || section.contains_key("sso_account_id")
        {
            return self.sso_credentials(&section).await;
        }
        if let Some(role) = section.get("role_arn") {
            if let (Some(token_file), None) = (
                section.get("web_identity_token_file"),
                section.get("source_profile"),
            ) {
                let token = std::fs::read_to_string(token_file)
                    .map_err(|_| Error::InvalidCredential)?
                    .trim()
                    .to_owned();
                return self.assume_role_web_identity(role, &token).await.map(Some);
            }
            let Some(source) = section.get("source_profile") else {
                return Err(Error::InvalidCredential);
            };
            let source = match source.as_str() {
                "Environment" => self.env_credentials()?.ok_or(Error::InvalidCredential)?,
                "Ec2Metadata" => self.imds().await?.ok_or(Error::InvalidCredential)?,
                "EcsMetadata" => self.container().await?.ok_or(Error::InvalidCredential)?,
                name => Box::pin(self.profile_credentials(name, depth + 1))
                    .await?
                    .ok_or(Error::InvalidCredential)?,
            };
            let session = section.get("role_session_name").map(String::as_str);
            return self.assume_role(&source, role, session).await.map(Some);
        }
        Ok(None)
    }

    async fn container(&self) -> Result<Option<Credentials>, Error> {
        if let Some(uri) = nonempty(self.env, "AWS_CONTAINER_CREDENTIALS_FULL_URI") {
            return self.container_credentials(&uri).await.map(Some);
        }
        let Some(relative) = nonempty(self.env, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") else {
            return Ok(None);
        };
        let base = self
            .options
            .container_base
            .clone()
            .unwrap_or_else(|| CONTAINER_BASE.into());
        self.container_credentials(&format!("{}{relative}", base.trim_end_matches('/')))
            .await
            .map(Some)
    }

    async fn container_credentials(&self, uri: &str) -> Result<Credentials, Error> {
        let url = reqwest::Url::parse(uri).map_err(|_| Error::InvalidCredential)?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Rejected);
        }
        let mut request = self.http.get(url);
        if let Some(token) = nonempty(self.env, "AWS_CONTAINER_AUTHORIZATION_TOKEN") {
            request = request.header("authorization", token);
        }
        let response = tokio::time::timeout(self.options.timeout_or_default(), request.send())
            .await
            .map_err(|_| Error::InvalidCredential)?
            .map_err(|_| Error::InvalidCredential)?;
        if !response.status().is_success() {
            return Err(Error::InvalidCredential);
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| Error::InvalidCredential)?;
        let credentials = Credentials {
            access_key_id: text(&body, "AccessKeyId")?,
            secret_access_key: text(&body, "SecretAccessKey")?,
            session_token: body
                .get("Token")
                .or_else(|| body.get("SessionToken"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            expires_at: body
                .get("Expiration")
                .map(parse_expiration)
                .transpose()?
                .flatten(),
        };
        keyed(credentials).ok_or(Error::InvalidCredential)
    }

    async fn imds(&self) -> Result<Option<Credentials>, Error> {
        let base = self
            .options
            .imds_endpoint
            .clone()
            .unwrap_or_else(|| IMDS_BASE.into());
        let base = base.trim_end_matches('/').to_owned();
        let timeout = self.options.timeout_or_default();
        let send = |request: reqwest::RequestBuilder| async move {
            tokio::time::timeout(timeout, request.send())
                .await
                .map_err(|_| Error::InvalidCredential)?
                .map_err(|_| Error::InvalidCredential)
        };
        let token = match send(
            self.http
                .put(format!("{base}/latest/api/token"))
                .header("x-aws-ec2-metadata-token-ttl-seconds", "21600"),
        )
        .await
        {
            Ok(response) if response.status().is_success() => Some(
                response
                    .text()
                    .await
                    .map_err(|_| Error::InvalidCredential)?,
            ),
            _ => None,
        };
        let token_header = token.clone();
        let mut role = self
            .http
            .get(format!("{base}/latest/meta-data/iam/security-credentials/"));
        if let Some(token) = token_header {
            role = role.header("x-aws-ec2-metadata-token", token);
        }
        let role = match send(role).await {
            Ok(role) => role,
            Err(_) => return Ok(None),
        };
        if !role.status().is_success() {
            return Ok(None);
        }
        let name = role
            .text()
            .await
            .map_err(|_| Error::InvalidCredential)?
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned();
        if name.is_empty() {
            return Ok(None);
        }
        let mut credentials = self.http.get(format!(
            "{base}/latest/meta-data/iam/security-credentials/{name}"
        ));
        if let Some(token) = token {
            credentials = credentials.header("x-aws-ec2-metadata-token", token);
        }
        let credentials = match send(credentials).await {
            Ok(credentials) => credentials,
            Err(_) => return Ok(None),
        };
        if !credentials.status().is_success() {
            return Ok(None);
        }
        let body: Value = credentials
            .json()
            .await
            .map_err(|_| Error::InvalidCredential)?;
        if body
            .get("Code")
            .and_then(Value::as_str)
            .is_some_and(|code| code != "Success")
        {
            return Err(Error::InvalidCredential);
        }
        let credentials = Credentials {
            access_key_id: text(&body, "AccessKeyId")?,
            secret_access_key: text(&body, "SecretAccessKey")?,
            session_token: body
                .get("Token")
                .or_else(|| body.get("SessionToken"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            expires_at: body
                .get("Expiration")
                .map(parse_expiration)
                .transpose()?
                .flatten(),
        };
        keyed(credentials).ok_or(Error::InvalidCredential).map(Some)
    }

    async fn ini(&self) -> Result<Option<Credentials>, Error> {
        self.profile_credentials(&self.profile(), 0).await
    }
}

impl Options {
    fn timeout_or_default(&self) -> Duration {
        if self.timeout.is_zero() {
            Duration::from_secs(1)
        } else {
            self.timeout
        }
    }
}

pub async fn resolve(
    env: &BTreeMap<String, String>,
    options: &Options,
    http: &reqwest::Client,
) -> Result<Option<Credentials>, Error> {
    let region = options
        .region
        .clone()
        .unwrap_or_else(|| region(None, env, ""));
    let chain = Chain {
        env,
        options,
        http,
        region,
    };
    if let Some(credentials) = chain.env_credentials()? {
        return Ok(Some(credentials));
    }
    if let Some(credentials) = chain.ini().await? {
        return Ok(Some(credentials));
    }
    if let Some(credentials) = chain.web_identity().await? {
        return Ok(Some(credentials));
    }
    if let Some(credentials) = chain.container().await? {
        return Ok(Some(credentials));
    }
    chain.imds().await
}

pub fn resolve_local(
    env: &BTreeMap<String, String>,
    options: &Options,
) -> Result<Option<Credentials>, Error> {
    if nonempty(env, "AWS_ACCESS_KEY_ID").is_some()
        || nonempty(env, "AWS_SECRET_ACCESS_KEY").is_some()
    {
        let access = nonempty(env, "AWS_ACCESS_KEY_ID");
        let secret = nonempty(env, "AWS_SECRET_ACCESS_KEY");
        if access.is_none() || secret.is_none() {
            return Ok(None);
        }
        return Ok(keyed(Credentials {
            access_key_id: access.unwrap_or_default(),
            secret_access_key: secret.unwrap_or_default(),
            session_token: nonempty(env, "AWS_SESSION_TOKEN"),
            expires_at: None,
        }));
    }
    let profile = profile_name(env, options.profile.as_deref());
    let section = profile_sections(env, options, &profile)?;
    if section.is_empty() {
        return Ok(None);
    }
    if let Some(credentials) = static_credentials(&section, "")? {
        return Ok(Some(credentials));
    }
    if let Some(command) = section.get("credential_process") {
        let (program, args) = split_command(command)?;
        let output = std::process::Command::new(program)
            .args(args)
            .output()
            .map_err(|_| Error::InvalidCredential)?;
        if !output.status.success() {
            return Err(Error::InvalidCredential);
        }
        return process_credentials(
            std::str::from_utf8(&output.stdout).map_err(|_| Error::InvalidCredential)?,
        )
        .map(Some);
    }
    Ok(None)
}

pub fn resolve_blocking(
    env: &BTreeMap<String, String>,
    options: &Options,
) -> Result<Option<Credentials>, Error> {
    let current = tokio::runtime::Handle::try_current().ok().filter(|handle| {
        matches!(
            handle.runtime_flavor(),
            tokio::runtime::RuntimeFlavor::MultiThread
        )
    });
    if let Some(handle) = current {
        let owned = env.clone();
        let options = options.clone();
        return tokio::task::block_in_place(|| {
            handle.block_on(async {
                let http = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|_| Error::Rejected)?;
                resolve(&owned, &options, &http).await
            })
        });
    }
    resolve_local(env, options)
}

#[cfg(test)]
mod tests {
    use super::{parse_ini, region, sso_cache_name, unquote};
    use std::collections::BTreeMap;

    #[test]
    fn ini_sections_split_keys_and_values_without_surprises() {
        let sections = parse_ini(
            "[default]\naws_access_key_id = KEY # trailing\n; comment\nquoted = \" spaced \"\nsingle = 'x'\n[profile other]\nregion=eu-west-1\n",
        );
        assert_eq!(sections["default"]["aws_access_key_id"], "KEY # trailing");
        assert_eq!(sections["default"]["quoted"], " spaced ");
        assert_eq!(sections["default"]["single"], "x");
        assert_eq!(sections["profile other"]["region"], "eu-west-1");
        assert_eq!(unquote("bare"), "bare");
    }

    #[test]
    fn region_resolution_order_matches_the_typescript_plugin() {
        let env = BTreeMap::from([("AWS_REGION".into(), "eu-central-1".into())]);
        assert_eq!(
            region(
                Some("ap-south-1"),
                &env,
                "https://bedrock-runtime.us-east-1.amazonaws.com"
            ),
            "ap-south-1"
        );
        assert_eq!(
            region(
                None,
                &env,
                "https://bedrock-runtime.us-east-1.amazonaws.com"
            ),
            "eu-central-1"
        );
        assert_eq!(
            region(None, &BTreeMap::new(), "https://proxy.example"),
            "us-east-1"
        );
    }

    #[test]
    fn sso_cache_names_hash_the_start_url() {
        assert_eq!(
            sso_cache_name("https://example.awsapps.com/start"),
            "e8be5486177c5b5392bd9aa76563515b29358e6e"
        );
    }
}
