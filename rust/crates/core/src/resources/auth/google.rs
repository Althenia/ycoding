use super::{Client, Error, base64, decode_base64, string};
use ring::{
    rand::SystemRandom,
    signature::{RSA_PKCS1_SHA256, RsaKeyPair},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fmt,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, task::JoinHandle};

const SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

#[derive(Clone)]
pub enum Credentials {
    AuthorizedUser {
        client_id: String,
        client_secret: String,
        refresh_token: String,
    },
    ServiceAccount {
        client_email: String,
        private_key: String,
        private_key_id: Option<String>,
    },
    Metadata,
}
impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GoogleCredentials([redacted])")
    }
}
impl Credentials {
    pub fn parse(raw: &str) -> Result<Self, Error> {
        let value: Value = serde_json::from_str(raw).map_err(|_| Error::InvalidCredential)?;
        match value.get("type").and_then(Value::as_str) {
            Some("authorized_user") => Ok(Self::AuthorizedUser {
                client_id: string(&value, "client_id")?.into(),
                client_secret: string(&value, "client_secret")?.into(),
                refresh_token: string(&value, "refresh_token")?.into(),
            }),
            Some("service_account") => Ok(Self::ServiceAccount {
                client_email: string(&value, "client_email")?.into(),
                private_key: string(&value, "private_key")?.into(),
                private_key_id: value
                    .get("private_key_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }),
            _ => Err(Error::InvalidCredential),
        }
    }
}

pub async fn discover(
    home: &Path,
    env: &BTreeMap<String, String>,
    windows: bool,
) -> Result<Credentials, Error> {
    let explicit = env
        .get("GOOGLE_APPLICATION_CREDENTIALS")
        .filter(|value| !value.is_empty())
        .or_else(|| {
            env.get("google_application_credentials")
                .filter(|value| !value.is_empty())
        });
    if let Some(file) = explicit {
        return Credentials::parse(
            &tokio::fs::read_to_string(file)
                .await
                .map_err(|_| Error::InvalidCredential)?,
        );
    }
    let directory = if windows {
        env.get("APPDATA")
            .map(|directory| std::path::PathBuf::from(directory).join("gcloud"))
    } else {
        Some(home.join(".config/gcloud"))
    };
    let Some(directory) = directory else {
        return Ok(Credentials::Metadata);
    };
    match tokio::fs::read_to_string(directory.join("application_default_credentials.json")).await {
        Ok(raw) => Credentials::parse(&raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Credentials::Metadata),
        Err(_) => Err(Error::InvalidCredential),
    }
}

#[derive(Clone)]
struct Token {
    access: String,
    expires: i64,
}
type Resolution = Result<Token, Error>;
struct State {
    closed: bool,
    token: Option<Token>,
    pending: Option<watch::Receiver<Option<Resolution>>>,
    tasks: Vec<JoinHandle<()>>,
}
struct Inner {
    credentials: Credentials,
    client: Client,
    metadata_endpoint: String,
    state: Mutex<State>,
}
#[derive(Clone)]
pub struct Store(Arc<Inner>);
impl fmt::Debug for Store {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GoogleAuth([redacted])")
    }
}
impl Store {
    pub fn new(
        credentials: Credentials,
        client: Client,
        metadata_endpoint: &str,
    ) -> Result<Self, Error> {
        let endpoint = url::Url::parse(metadata_endpoint).map_err(|_| Error::Rejected)?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            return Err(Error::Rejected);
        }
        Ok(Self(Arc::new(Inner {
            credentials,
            client,
            metadata_endpoint: endpoint.as_str().trim_end_matches('/').into(),
            state: Mutex::new(State {
                closed: false,
                token: None,
                pending: None,
                tasks: Vec::new(),
            }),
        })))
    }
    pub fn system(
        credentials: Credentials,
        version: &str,
        env: &BTreeMap<String, String>,
    ) -> Result<Self, Error> {
        let host = env
            .get("GCE_METADATA_HOST")
            .or_else(|| env.get("GCE_METADATA_IP"))
            .map_or("169.254.169.254", String::as_str);
        Self::new(
            credentials,
            Client::new("https://oauth2.googleapis.com", version)?,
            &format!("http://{host}"),
        )
    }
    pub async fn token(&self, time: i64) -> Result<String, Error> {
        let finished = self
            .0
            .state
            .lock()
            .map_err(|_| Error::Closed)?
            .tasks
            .extract_if(.., |task| task.is_finished())
            .collect();
        super::join_finished(finished).await?;
        let mut receiver = {
            let mut state = self.0.state.lock().map_err(|_| Error::Closed)?;
            if state.closed {
                return Err(Error::Closed);
            }
            if let Some(token) = &state.token
                && token.expires > time.saturating_add(300_000)
            {
                return Ok(token.access.clone());
            }
            if let Some(receiver) = &state.pending {
                receiver.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                state.pending = Some(receiver.clone());
                let store = self.clone();
                state.tasks.push(tokio::spawn(async move {
                    let result = store.exchange(time).await;
                    if let Ok(token) = &result
                        && let Ok(mut state) = store.0.state.lock()
                    {
                        state.token = Some(token.clone());
                    }
                    sender.send_replace(Some(result.clone()));
                    if !matches!(result, Err(Error::UnknownOutcome))
                        && let Ok(mut state) = store.0.state.lock()
                    {
                        state.pending = None;
                    }
                }));
                receiver
            }
        };
        loop {
            if let Some(result) = receiver.borrow_and_update().clone() {
                return result.map(|token| token.access);
            }
            receiver
                .changed()
                .await
                .map_err(|_| Error::UnknownOutcome)?;
        }
    }
    pub async fn prepare(&self, time: i64) -> Result<ycoding_ai::auth::Auth, Error> {
        Ok(ycoding_ai::auth::Auth::bearer(
            ycoding_ai::auth::Credential::value(self.token(time).await?),
        ))
    }
    async fn exchange(&self, time: i64) -> Resolution {
        let request = match &self.0.credentials {
            Credentials::AuthorizedUser {
                client_id,
                client_secret,
                refresh_token,
            } => self.0.client.form(
                "/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", client_id),
                    ("client_secret", client_secret),
                    ("refresh_token", refresh_token),
                ],
            ),
            Credentials::ServiceAccount {
                client_email,
                private_key,
                private_key_id,
            } => {
                let assertion =
                    assertion(client_email, private_key, private_key_id.as_deref(), time)?;
                self.0.client.form(
                    "/token",
                    &[
                        ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                        ("assertion", &assertion),
                    ],
                )
            }
            Credentials::Metadata => self
                .0
                .client
                .http
                .get(format!(
                    "{}/computeMetadata/v1/instance/service-accounts/default/token",
                    self.0.metadata_endpoint
                ))
                .header("Metadata-Flavor", "Google"),
        };
        let failure = if matches!(self.0.credentials, Credentials::Metadata) {
            Error::Rejected
        } else {
            Error::UnknownOutcome
        };
        let response = request
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|_| failure)?;
        if !response.status().is_success() {
            return Err(Error::Rejected);
        }
        if matches!(self.0.credentials, Credentials::Metadata)
            && response
                .headers()
                .get("metadata-flavor")
                .and_then(|value| value.to_str().ok())
                != Some("Google")
        {
            return Err(Error::Rejected);
        }
        let bytes = response.bytes().await.map_err(|_| failure)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| failure)?;
        Ok(Token {
            access: string(&value, "access_token")
                .map_err(|_| Error::UnknownOutcome)?
                .into(),
            expires: time.saturating_add(
                (value
                    .get("expires_in")
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite())
                    .ok_or(Error::UnknownOutcome)?
                    * 1000.0) as i64,
            ),
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

pub fn assertion(
    email: &str,
    private_key: &str,
    key_id: Option<&str>,
    time: i64,
) -> Result<String, Error> {
    let mut header = json!({"alg":"RS256","typ":"JWT"});
    if let Some(key_id) = key_id {
        header["kid"] = key_id.into();
    }
    let claims = json!({"iss":email,"scope":SCOPE,"aud":TOKEN_URL,"iat":time / 1000,"exp":time / 1000 + 3600});
    let message = format!(
        "{}.{}",
        base64(header.to_string().as_bytes()),
        base64(claims.to_string().as_bytes())
    );
    let der = decode_base64(
        &private_key
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>(),
    )
    .ok_or(Error::InvalidCredential)?;
    let key = if private_key.starts_with("-----BEGIN RSA PRIVATE KEY-----") {
        RsaKeyPair::from_der(&der)
    } else {
        RsaKeyPair::from_pkcs8(&der)
    }
    .map_err(|_| Error::InvalidCredential)?;
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        message.as_bytes(),
        &mut signature,
    )
    .map_err(|_| Error::InvalidCredential)?;
    Ok(format!("{message}.{}", base64(&signature)))
}
