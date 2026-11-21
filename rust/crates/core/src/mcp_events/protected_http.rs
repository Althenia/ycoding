use super::{Cancellation, HttpRequest, HttpResponse, ResultFuture, Transport, failure};
use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use ycoding_schema::mcp_events::{Failure, FailureCategory, FailureReason};

#[derive(Clone)]
pub struct Connect {
    pub hostname: String,
    pub servername: String,
    pub address: IpAddr,
    pub port: u16,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
    pub timeout_ms: u64,
}
pub trait Network: Send + Sync {
    fn resolve(
        &self,
        hostname: String,
        cancellation: Cancellation,
    ) -> ResultFuture<'_, Vec<IpAddr>>;
    fn connect(&self, input: Connect, cancellation: Cancellation)
    -> ResultFuture<'_, HttpResponse>;
}
pub struct ProtectedHttp {
    network: Arc<dyn Network>,
}
impl Default for ProtectedHttp {
    fn default() -> Self {
        Self::new()
    }
}
impl ProtectedHttp {
    pub fn new() -> Self {
        Self {
            network: Arc::new(SystemNetwork),
        }
    }
    pub fn with_network(network: Arc<dyn Network>) -> Self {
        Self { network }
    }
}

pub fn callback_url(value: &str) -> Result<url::Url, Failure> {
    let url = url::Url::parse(value).map_err(|_| rejected())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(rejected());
    }
    Ok(url)
}

pub fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let value = u32::from(address);
            ![
                (Ipv4Addr::new(0, 0, 0, 0), 8),
                (Ipv4Addr::new(10, 0, 0, 0), 8),
                (Ipv4Addr::new(100, 64, 0, 0), 10),
                (Ipv4Addr::new(127, 0, 0, 0), 8),
                (Ipv4Addr::new(169, 254, 0, 0), 16),
                (Ipv4Addr::new(172, 16, 0, 0), 12),
                (Ipv4Addr::new(192, 0, 0, 0), 24),
                (Ipv4Addr::new(192, 0, 2, 0), 24),
                (Ipv4Addr::new(192, 31, 196, 0), 24),
                (Ipv4Addr::new(192, 52, 193, 0), 24),
                (Ipv4Addr::new(192, 88, 99, 0), 24),
                (Ipv4Addr::new(192, 168, 0, 0), 16),
                (Ipv4Addr::new(192, 175, 48, 0), 24),
                (Ipv4Addr::new(198, 18, 0, 0), 15),
                (Ipv4Addr::new(198, 51, 100, 0), 24),
                (Ipv4Addr::new(203, 0, 113, 0), 24),
                (Ipv4Addr::new(224, 0, 0, 0), 4),
                (Ipv4Addr::new(240, 0, 0, 0), 4),
            ]
            .iter()
            .any(|(base, bits)| {
                let mask = u32::MAX << (32 - bits);
                value & mask == u32::from(*base) & mask
            })
        }
        IpAddr::V6(address) => {
            let groups = address.segments();
            (groups[0] & 0xe000) == 0x2000
                && !(groups[0] == 0x2001
                    && (groups[1] == 0x0db8
                        || groups[1] == 0
                        || (groups[1] & 0xfff0) == 0x10
                        || (groups[1] & 0xfff0) == 0x20))
                && groups[0] != 0x5f00
                && !(groups[0] == 0x64 && groups[1] == 0xff9b)
        }
    }
}

impl Transport for ProtectedHttp {
    fn send(
        &self,
        request: HttpRequest,
        cancellation: Cancellation,
    ) -> ResultFuture<'_, HttpResponse> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(unreachable_endpoint());
            }
            let timeout = Duration::from_millis(request.timeout_ms.min(10_000));
            let work = async {
                if request.body.len() > 262_144 {
                    return Err(payload_too_large());
                }
                let url = callback_url(&request.url)?;
                let hostname = url
                    .host_str()
                    .ok_or_else(rejected)?
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .to_owned();
                let addresses = if let Ok(address) = hostname.parse::<IpAddr>() {
                    vec![address]
                } else {
                    self.network
                        .resolve(hostname.clone(), cancellation.clone())
                        .await?
                };
                if addresses.is_empty()
                    || addresses.iter().any(|address| !is_public_address(*address))
                {
                    return Err(rejected());
                }
                let path = match url.query() {
                    Some(query) => format!("{}?{query}", url.path()),
                    None => url.path().to_owned(),
                };
                let response = self
                    .network
                    .connect(
                        Connect {
                            servername: hostname.clone(),
                            hostname,
                            address: addresses[0],
                            port: url.port_or_known_default().ok_or_else(rejected)?,
                            path,
                            headers: request.headers,
                            body: request.body,
                            timeout_ms: request.timeout_ms.min(10_000),
                        },
                        cancellation.clone(),
                    )
                    .await?;
                if response.body.len() > 262_144 {
                    return Err(payload_too_large());
                }
                Ok(response)
            };
            tokio::select! {biased;_=cancellation.cancelled()=>Err(unreachable_endpoint()),result=tokio::time::timeout(timeout,work)=>result.map_err(|_|failure(FailureCategory::CallbackEndpoint,FailureReason::Timeout))?}
        })
    }
}

struct SystemNetwork;
impl Network for SystemNetwork {
    fn resolve(&self, hostname: String, _: Cancellation) -> ResultFuture<'_, Vec<IpAddr>> {
        Box::pin(async move {
            tokio::net::lookup_host((hostname.as_str(), 0))
                .await
                .map(|addresses| addresses.map(|address| address.ip()).collect())
                .map_err(|_| unreachable_endpoint())
        })
    }
    fn connect(&self, input: Connect, _: Cancellation) -> ResultFuture<'_, HttpResponse> {
        Box::pin(async move {
            if input.hostname != input.servername || !is_public_address(input.address) {
                return Err(rejected());
            }
            let client = reqwest::Client::builder()
                .no_proxy()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_millis(input.timeout_ms.min(10_000)))
                .resolve_to_addrs(
                    &input.hostname,
                    &[SocketAddr::new(input.address, input.port)],
                )
                .build()
                .map_err(|_| unreachable_endpoint())?;
            let hostname = if input.hostname.contains(':') {
                format!("[{}]", input.hostname)
            } else {
                input.hostname
            };
            let mut request =
                client.post(format!("https://{hostname}:{}{}", input.port, input.path));
            for (name, value) in input.headers {
                request = request.header(name, value);
            }
            let response = request
                .body(input.body)
                .send()
                .await
                .map_err(|_| unreachable_endpoint())?;
            read_response(response).await
        })
    }
}

async fn read_response(mut response: reqwest::Response) -> Result<HttpResponse, Failure> {
    let status = response.status().as_u16();
    if matches!(status, 410 | 413) {
        return Ok(HttpResponse {
            status,
            body: String::new(),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > 262_144)
    {
        return Err(payload_too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unreachable_endpoint())? {
        if bytes.len().saturating_add(chunk.len()) > 262_144 {
            return Err(payload_too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(HttpResponse {
        status,
        body: String::from_utf8(bytes).map_err(|_| unreachable_endpoint())?,
    })
}

fn rejected() -> Failure {
    failure(
        FailureCategory::CallbackEndpoint,
        FailureReason::EndpointRejected,
    )
}
fn unreachable_endpoint() -> Failure {
    failure(
        FailureCategory::CallbackEndpoint,
        FailureReason::EndpointUnreachable,
    )
}
fn payload_too_large() -> Failure {
    failure(
        FailureCategory::CallbackEndpoint,
        FailureReason::PayloadTooLarge,
    )
}

#[cfg(test)]
mod response_tests {
    use super::read_response;
    use ycoding_schema::mcp_events::FailureReason;

    fn response(status: u16, length: Option<usize>, body: Vec<u8>) -> reqwest::Response {
        let builder = axum::http::Response::builder().status(status);
        let builder = match length {
            Some(length) => builder.header("content-length", length.to_string()),
            None => builder,
        };
        builder.body(reqwest::Body::from(body)).unwrap().into()
    }

    #[tokio::test]
    async fn terminal_status_survives_oversized_or_non_utf8_response_bodies() {
        for status in [410, 413] {
            for (length, body) in [(Some(262_145), vec![b'x'; 262_145]), (None, vec![0xff])] {
                let result = read_response(response(status, length, body)).await.unwrap();
                assert_eq!(result.status, status);
                assert!(result.body.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn nonterminal_responses_keep_body_limits_and_utf8_failures() {
        for status in [200, 503] {
            let oversized = read_response(response(status, Some(262_145), vec![b'x'; 262_145]))
                .await
                .err()
                .expect("oversized response rejected");
            assert_eq!(oversized.reason, FailureReason::PayloadTooLarge);
            let invalid = read_response(response(status, None, vec![0xff]))
                .await
                .err()
                .expect("invalid UTF-8 rejected");
            assert_eq!(invalid.reason, FailureReason::EndpointUnreachable);
            let exact = read_response(response(status, Some(262_144), vec![b'x'; 262_144]))
                .await
                .unwrap();
            assert_eq!(exact.status, status);
            assert_eq!(exact.body.len(), 262_144);
        }
    }

    #[tokio::test]
    async fn bounded_nonterminal_error_and_redirect_bodies_remain_available() {
        for status in [302, 503] {
            let result = read_response(response(status, Some(9), b"synthetic".to_vec()))
                .await
                .unwrap();
            assert_eq!(result.status, status);
            assert_eq!(result.body, "synthetic");
        }
    }
}
