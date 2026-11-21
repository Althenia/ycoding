use crate::{Error, provider_error::Reason};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::{collections::BTreeMap, fmt, sync::Arc};
use ycoding_schema::credential;

#[derive(Clone)]
pub struct Secret(String);
impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}
#[derive(Clone)]
pub struct Credential {
    pub id: Option<credential::Id>,
    secret: Secret,
}
impl Credential {
    pub fn resolved(id: Option<credential::Id>, secret: Secret) -> Self {
        Self { id, secret }
    }
    pub fn value(secret: impl Into<String>) -> Self {
        Self::resolved(None, Secret::new(secret))
    }
}
impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Credential(<redacted>)")
    }
}
pub struct Input<'a> {
    pub method: &'static str,
    pub url: &'a str,
    pub body: &'a str,
    pub headers: HeaderMap,
}
type Apply = Arc<dyn for<'a> Fn(Input<'a>) -> Result<HeaderMap, Error> + Send + Sync>;
#[derive(Clone)]
pub enum Auth {
    None,
    Header {
        name: String,
        credential: Credential,
        bearer: bool,
    },
    Headers(BTreeMap<String, Secret>),
    Remove(String),
    AndThen(Box<Auth>, Box<Auth>),
    OrElse(Box<Auth>, Box<Auth>),
    Custom(Apply),
}
impl fmt::Debug for Auth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Auth(<redacted>)")
    }
}
impl Auth {
    pub fn bearer(credential: Credential) -> Self {
        Self::Header {
            name: "authorization".into(),
            credential,
            bearer: true,
        }
    }
    pub fn header(name: impl Into<String>, credential: Credential) -> Self {
        Self::Header {
            name: name.into(),
            credential,
            bearer: false,
        }
    }
    pub fn custom(
        apply: impl for<'a> Fn(Input<'a>) -> Result<HeaderMap, Error> + Send + Sync + 'static,
    ) -> Self {
        Self::Custom(Arc::new(apply))
    }
    pub fn and_then(self, next: Self) -> Self {
        Self::AndThen(Box::new(self), Box::new(next))
    }
    pub fn or_else(self, next: Self) -> Self {
        Self::OrElse(Box::new(self), Box::new(next))
    }
    pub fn apply(&self, input: Input<'_>) -> Result<HeaderMap, Error> {
        match self {
            Self::None => Ok(input.headers),
            Self::Remove(name) => {
                let mut headers = input.headers;
                headers.remove(name);
                Ok(headers)
            }
            Self::Header {
                name,
                credential,
                bearer,
            } => {
                if credential.secret.expose().is_empty() {
                    return Err(Error {
                        authentication_kind: Some(
                            crate::provider_error::AuthenticationKind::Missing,
                        ),
                        ..Error::new(Reason::Authentication, "Missing auth credential")
                    });
                }
                let mut headers = input.headers;
                let value = if *bearer {
                    format!("Bearer {}", credential.secret.expose())
                } else {
                    credential.secret.expose().into()
                };
                let mut value = HeaderValue::from_str(&value)
                    .map_err(|_| Error::invalid("Invalid authentication header value"))?;
                value.set_sensitive(true);
                headers.insert(
                    HeaderName::from_bytes(name.as_bytes())
                        .map_err(|_| Error::invalid("Invalid authentication header name"))?,
                    value,
                );
                Ok(headers)
            }
            Self::Headers(values) => {
                let mut headers = input.headers;
                for (name, value) in values {
                    let mut value = HeaderValue::from_str(value.expose())
                        .map_err(|_| Error::invalid("Invalid authentication header value"))?;
                    value.set_sensitive(true);
                    headers.insert(
                        HeaderName::from_bytes(name.as_bytes())
                            .map_err(|_| Error::invalid("Invalid authentication header name"))?,
                        value,
                    );
                }
                Ok(headers)
            }
            Self::AndThen(first, second) => {
                let headers = first.apply(Input {
                    method: input.method,
                    url: input.url,
                    body: input.body,
                    headers: input.headers,
                })?;
                second.apply(Input {
                    method: input.method,
                    url: input.url,
                    body: input.body,
                    headers,
                })
            }
            Self::OrElse(first, second) => {
                let original = Input {
                    method: input.method,
                    url: input.url,
                    body: input.body,
                    headers: input.headers.clone(),
                };
                first.apply(input).or_else(|_| second.apply(original))
            }
            Self::Custom(apply) => apply(input),
        }
    }
}
#[derive(Clone)]
pub enum ProviderAuth {
    ApiKey(Credential),
    Bearer(Credential),
    Override(Auth),
}
impl ProviderAuth {
    pub fn apply(self) -> Auth {
        match self {
            Self::ApiKey(credential) => Auth::header("x-api-key", credential),
            Self::Bearer(credential) => Auth::bearer(credential),
            Self::Override(auth) => auth,
        }
    }
}
