use crate::{
    Error,
    auth::{Auth, Input, Secret},
};
use reqwest::{
    Url,
    header::{HeaderMap, HeaderValue},
};
use ring::{digest, hmac};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct Credentials {
    pub region: String,
    pub access_key_id: Secret,
    pub secret_access_key: Secret,
    pub session_token: Option<Secret>,
}

pub fn sigv4(
    credentials: Option<Credentials>,
    clock: impl Fn() -> String + Send + Sync + 'static,
) -> Auth {
    Auth::custom(move |input| {
        let credentials = credentials.as_ref().ok_or_else(|| Error::invalid("Bedrock Converse requires either route bearer auth or AWS credentials configured on the route"))?;
        sign(input, credentials, &clock())
    })
}

fn sign(input: Input<'_>, credentials: &Credentials, datetime: &str) -> Result<HeaderMap, Error> {
    if datetime.len() != 16
        || !datetime
            .bytes()
            .enumerate()
            .all(|(index, byte)| match index {
                8 => byte == b'T',
                15 => byte == b'Z',
                _ => byte.is_ascii_digit(),
            })
    {
        return Err(Error::invalid(
            "Bedrock Converse SigV4 clock must return YYYYMMDDTHHMMSSZ",
        ));
    }
    let url = Url::parse(input.url)
        .map_err(|_| Error::invalid("Bedrock Converse SigV4 signing failed: invalid URL"))?;
    let mut headers = HeaderMap::new();
    for name in input.headers.keys() {
        let value = input
            .headers
            .get_all(name)
            .iter()
            .map(|value| {
                value
                    .to_str()
                    .map(|value| value.trim_matches([' ', '\t']).to_owned())
                    .map_err(|_| {
                        Error::invalid("Bedrock Converse SigV4 signing failed: invalid header")
                    })
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        let mut value = HeaderValue::from_str(&value)
            .map_err(|_| Error::invalid("Bedrock Converse SigV4 signing failed: invalid header"))?;
        value.set_sensitive(
            input
                .headers
                .get_all(name)
                .iter()
                .any(HeaderValue::is_sensitive),
        );
        headers.insert(name.clone(), value);
    }
    headers.remove("host");
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert(
        "x-amz-date",
        HeaderValue::from_str(datetime)
            .map_err(|_| Error::invalid("Bedrock Converse SigV4 signing failed: invalid clock"))?,
    );
    if let Some(token) = credentials
        .session_token
        .as_ref()
        .filter(|token| !token.expose().is_empty())
    {
        let mut value = HeaderValue::from_str(token.expose()).map_err(|_| {
            Error::invalid("Bedrock Converse SigV4 signing failed: invalid session token")
        })?;
        value.set_sensitive(true);
        headers.insert("x-amz-security-token", value);
    }
    let (canonical, signed_headers) = canonical(input.method, &url, input.body, &headers)?;
    let scope = format!(
        "{}/{}/bedrock/aws4_request",
        &datetime[..8],
        credentials.region
    );
    let string_to_sign = string_to_sign(datetime, &scope, &canonical);
    let signature = signature(credentials, &datetime[..8], "bedrock", &string_to_sign);
    let mut authorization = HeaderValue::from_str(&format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}", credentials.access_key_id.expose())).map_err(|_| Error::invalid("Bedrock Converse SigV4 signing failed: invalid credentials"))?;
    authorization.set_sensitive(true);
    headers.insert("authorization", authorization);
    Ok(headers)
}

pub(crate) fn uri_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                return char::from(byte).to_string();
            }
            format!("%{byte:02X}")
        })
        .collect()
}
fn rfc3986(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if b"!'()*".contains(&byte) {
                return format!("%{byte:02X}");
            }
            char::from(byte).to_string()
        })
        .collect()
}
fn canonical(
    method: &str,
    url: &Url,
    body: &str,
    headers: &HeaderMap,
) -> Result<(String, String), Error> {
    let host = url
        .host_str()
        .ok_or_else(|| Error::invalid("Bedrock Converse SigV4 signing failed: missing host"))?;
    let host = url
        .port()
        .map(|port| format!("{host}:{port}"))
        .unwrap_or_else(|| host.into());
    let mut values = BTreeMap::from([("host".to_owned(), host)]);
    for name in headers.keys().filter(|name| {
        ![
            "host",
            "authorization",
            "content-type",
            "content-length",
            "user-agent",
            "presigned-expires",
            "expect",
            "x-amzn-trace-id",
            "range",
            "connection",
        ]
        .contains(&name.as_str())
    }) {
        values.insert(
            name.as_str().to_owned(),
            headers[name]
                .to_str()
                .map_err(|_| {
                    Error::invalid("Bedrock Converse SigV4 signing failed: invalid header")
                })?
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    let signed_headers = values.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_headers = values
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect::<String>();
    let mut query = url
        .query_pairs()
        .filter(|(key, _)| !key.is_empty())
        .map(|(key, value)| {
            (
                rfc3986(&uri_component(&key)),
                rfc3986(&uri_component(&value)),
            )
        })
        .collect::<Vec<_>>();
    query.sort();
    let query = query
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    let mut path = String::new();
    for byte in url.path().bytes() {
        if byte == b'/' && path.ends_with('/') {
            continue;
        }
        path.push(char::from(byte));
    }
    let path = rfc3986(&uri_component(&path).replace("%2F", "/"));
    let body_hash = headers
        .get("x-amz-content-sha256")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| hash(body));
    Ok((
        format!(
            "{}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{body_hash}",
            method.to_uppercase()
        ),
        signed_headers,
    ))
}
fn hash(value: &str) -> String {
    hex(digest::digest(&digest::SHA256, value.as_bytes()).as_ref())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn string_to_sign(datetime: &str, scope: &str, canonical: &str) -> String {
    format!("AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{}", hash(canonical))
}
fn signature(credentials: &Credentials, date: &str, service: &str, value: &str) -> String {
    let sign = |key: &[u8], value: &str| {
        hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), value.as_bytes())
    };
    let date_key = sign(
        format!("AWS4{}", credentials.secret_access_key.expose()).as_bytes(),
        date,
    );
    let region_key = sign(date_key.as_ref(), &credentials.region);
    let service_key = sign(region_key.as_ref(), service);
    let signing_key = sign(service_key.as_ref(), "aws4_request");
    hex(sign(signing_key.as_ref(), value).as_ref())
}

#[cfg(test)]
mod tests {
    use super::{Credentials, canonical, sign, signature, string_to_sign};
    use crate::auth::{Input, Secret};
    use reqwest::{
        Url,
        header::{HeaderMap, HeaderValue},
    };
    fn credentials() -> Credentials {
        Credentials {
            region: "us-east-1".into(),
            access_key_id: Secret::new("AKIDEXAMPLE"),
            secret_access_key: Secret::new("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"),
            session_token: None,
        }
    }

    #[test]
    fn aws_published_canonical_string_to_sign_signature_vectors() {
        let mut headers = HeaderMap::new();
        headers.insert("x-amz-date", HeaderValue::from_static("20150830T123600Z"));
        for (query, encoded, expected_hash, expected_signature) in [
            (
                "",
                "",
                "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
                "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
            ),
            (
                "?Param-3=Value3&Param=Value2&%E1%88%B4=Value1",
                "%E1%88%B4=Value1&Param=Value2&Param-3=Value3",
                "868294f5c38bd141c4972a373a76654f1418a8e4fc18b2e7903ae45e8ae0ec71",
                "371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac",
            ),
        ] {
            let url = Url::parse(&format!("https://example.amazonaws.com/{query}")).unwrap();
            let (canonical, signed) = canonical("GET", &url, "", &headers).unwrap();
            assert_eq!(
                canonical,
                format!(
                    "GET\n/\n{encoded}\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                )
            );
            assert_eq!(signed, "host;x-amz-date");
            let text = string_to_sign(
                "20150830T123600Z",
                "20150830/us-east-1/service/aws4_request",
                &canonical,
            );
            assert_eq!(
                text,
                format!(
                    "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n{expected_hash}"
                )
            );
            assert_eq!(
                signature(&credentials(), "20150830", "service", &text),
                expected_signature
            );
        }
    }

    #[test]
    fn ts_fixed_clock_canonical_and_string_to_sign() {
        let mut credentials = credentials();
        credentials.session_token = Some(Secret::new("test-token"));
        let mut headers = HeaderMap::new();
        headers.insert("x-zeta", HeaderValue::from_static("  a\t b  "));
        headers.insert("x-alpha", HeaderValue::from_static("first"));
        headers.insert("x-amzn-trace-id", HeaderValue::from_static("ignored"));
        let input = Input {
            method: "POST",
            url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v1%3A0/converse-stream?z=two+words&a=2&a=1&=ignored",
            body: r#"{"modelId":"anthropic.claude-v1:0","messages":[]}"#,
            headers,
        };
        let signed = sign(
            Input {
                method: input.method,
                url: input.url,
                body: input.body,
                headers: input.headers.clone(),
            },
            &credentials,
            "20150830T123600Z",
        )
        .unwrap();
        let (canonical, _) = canonical(
            input.method,
            &Url::parse(input.url).unwrap(),
            input.body,
            &signed,
        )
        .unwrap();
        assert_eq!(
            canonical,
            "POST\n/model/anthropic.claude-v1%253A0/converse-stream\na=1&a=2&z=two%20words\nhost:bedrock-runtime.us-east-1.amazonaws.com\nx-alpha:first\nx-amz-date:20150830T123600Z\nx-amz-security-token:test-token\nx-zeta:a b\n\nhost;x-alpha;x-amz-date;x-amz-security-token;x-zeta\n51cab1a1dfc085b66ece12f889aee86c3ad4a232860e1479126ce6885d696428"
        );
        assert_eq!(
            string_to_sign(
                "20150830T123600Z",
                "20150830/us-east-1/bedrock/aws4_request",
                &canonical
            ),
            "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/bedrock/aws4_request\n62324ceb476dbcacc98ef9eb4ebd5aba79ffa4fc3a9f5622a4b508e1d7029a8c"
        );
    }
}
