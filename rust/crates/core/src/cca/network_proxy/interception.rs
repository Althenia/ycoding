use super::*;
use crate::cca::mitm_ca::PrefixedStream;
use std::io;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio_rustls::TlsAcceptor;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BodyFraming {
    Length(u64),
    Chunked,
}

pub(super) struct RequestHead {
    pub method: String,
    pub target: String,
    pub version: String,
    pub headers: Vec<(LosslessString, LosslessString)>,
    pub rest: Vec<u8>,
    pub framing: BodyFraming,
}

fn token(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP framing")
}

fn header(line: &[u8]) -> Option<(LosslessString, LosslessString)> {
    let colon = line.iter().position(|byte| *byte == b':')?;
    if colon == 0 || !line[..colon].iter().all(|byte| token(*byte)) {
        return None;
    }
    let value = &line[colon + 1..];
    if value
        .iter()
        .any(|byte| (*byte < 32 && *byte != b'\t') || *byte == 127)
    {
        return None;
    }
    let start = value
        .iter()
        .position(|byte| !matches!(byte, b' ' | b'\t'))
        .unwrap_or(value.len());
    let end = value
        .iter()
        .rposition(|byte| !matches!(byte, b' ' | b'\t'))
        .map_or(start, |index| index + 1);
    Some((
        latin1(&line[..colon]).into(),
        latin1(&value[start..end]).into(),
    ))
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

pub(super) async fn read_request_head<S: AsyncRead + Unpin>(stream: &mut S) -> Option<RequestHead> {
    let mut buffer = vec![];
    let mut chunk = [0u8; 8192];
    loop {
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..count]);
        let Some(end) = buffer.windows(4).position(|part| part == b"\r\n\r\n") else {
            if buffer.len() > MAX_REQUEST_HEAD_BYTES {
                return None;
            }
            continue;
        };
        if end + 4 > MAX_REQUEST_HEAD_BYTES {
            return None;
        }
        let text = latin1(&buffer[..end]);
        let mut lines = text.split("\r\n");
        let first = lines.next()?.split(' ').collect::<Vec<_>>();
        if first.len() != 3
            || first[0].is_empty()
            || !first[0].bytes().all(token)
            || first[1].is_empty()
            || first[1].bytes().any(|byte| byte <= 32 || byte == 127)
            || !matches!(first[2], "HTTP/1.0" | "HTTP/1.1")
        {
            return None;
        }
        let mut headers = vec![];
        for line in lines {
            let bytes = line
                .chars()
                .map(|character| character as u8)
                .collect::<Vec<_>>();
            headers.push(header(&bytes)?);
        }
        for (_, value) in headers
            .iter()
            .filter(|(name, _)| header_is(name, "connection"))
        {
            if value.as_str()?.split(',').any(|field| {
                ["host", "content-length", "transfer-encoding"]
                    .iter()
                    .any(|name| field.trim().eq_ignore_ascii_case(name))
            }) {
                return None;
            }
        }
        let lengths = headers
            .iter()
            .filter(|(name, _)| header_is(name, "content-length"))
            .collect::<Vec<_>>();
        let transfers = headers
            .iter()
            .filter(|(name, _)| header_is(name, "transfer-encoding"))
            .collect::<Vec<_>>();
        if lengths.len() > 1
            || transfers.len() > 1
            || (!lengths.is_empty() && !transfers.is_empty())
        {
            return None;
        }
        let framing = if let Some((_, value)) = transfers.first() {
            if !value.as_str()?.eq_ignore_ascii_case("chunked") {
                return None;
            }
            BodyFraming::Chunked
        } else if let Some((_, value)) = lengths.first() {
            let value = value.as_str()?;
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            BodyFraming::Length(value.parse().ok()?)
        } else {
            BodyFraming::Length(0)
        };
        return Some(RequestHead {
            method: first[0].into(),
            target: first[1].into(),
            version: first[2].into(),
            headers,
            rest: buffer[end + 4..].to_vec(),
            framing,
        });
    }
}

async fn line<R: AsyncBufRead + Unpin>(source: &mut R) -> io::Result<Vec<u8>> {
    let mut output = vec![];
    loop {
        let available = source.fill_buf().await?;
        if available.is_empty() {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if output.len() + count > MAX_REQUEST_HEAD_BYTES {
            return Err(invalid());
        }
        output.extend_from_slice(&available[..count]);
        source.consume(count);
        if output.last() == Some(&b'\n') {
            if !output.ends_with(b"\r\n") {
                return Err(invalid());
            }
            return Ok(output);
        }
    }
}

async fn copy_length<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    source: &mut R,
    destination: &mut W,
    mut remaining: u64,
) -> io::Result<()> {
    let mut buffer = [0u8; 16 * 1024];
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let count = source.read(&mut buffer[..limit]).await?;
        if count == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        destination.write_all(&buffer[..count]).await?;
        remaining -= count as u64;
    }
    Ok(())
}

pub(super) async fn forward_body<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    source: &mut R,
    destination: &mut W,
    framing: BodyFraming,
) -> io::Result<()> {
    let BodyFraming::Chunked = framing else {
        let BodyFraming::Length(length) = framing else {
            unreachable!()
        };
        return copy_length(source, destination, length).await;
    };
    loop {
        let size_line = line(source).await?;
        let value = &size_line[..size_line.len() - 2];
        let end = value
            .iter()
            .position(|byte| *byte == b';')
            .unwrap_or(value.len());
        if end == 0
            || !value[..end].iter().all(|byte| byte.is_ascii_hexdigit())
            || value[end..].iter().any(|byte| *byte < 32 || *byte == 127)
        {
            return Err(invalid());
        }
        let text = std::str::from_utf8(&value[..end]).map_err(|_| invalid())?;
        let size = u64::from_str_radix(text, 16).map_err(|_| invalid())?;
        destination.write_all(&size_line).await?;
        if size == 0 {
            let mut bytes = 0usize;
            loop {
                let trailer = line(source).await?;
                bytes += trailer.len();
                if bytes > MAX_REQUEST_HEAD_BYTES {
                    return Err(invalid());
                }
                if trailer == b"\r\n" {
                    destination.write_all(&trailer).await?;
                    return Ok(());
                }
                let (name, _) = header(&trailer[..trailer.len() - 2]).ok_or_else(invalid)?;
                if [
                    "content-length",
                    "transfer-encoding",
                    "host",
                    "authorization",
                    "proxy-authorization",
                    "connection",
                ]
                .iter()
                .any(|field| header_is(&name, field))
                {
                    return Err(invalid());
                }
                destination.write_all(&trailer).await?;
            }
        }
        copy_length(source, destination, size).await?;
        let mut end = [0u8; 2];
        source.read_exact(&mut end).await?;
        if end != *b"\r\n" {
            return Err(invalid());
        }
        destination.write_all(&end).await?;
    }
}

pub(super) async fn forward_request<C, U>(
    shared: &Arc<Shared>,
    client: C,
    mut upstream: U,
    head: &RequestHead,
    target: &str,
    headers: &[(LosslessString, LosslessString)],
) where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    let mut bytes = format!("{} {} {}\r\n", head.method, target, head.version).into_bytes();
    for (name, value) in headers {
        let name = name.code_units().map(|unit| unit as u8).collect::<Vec<_>>();
        let value = value
            .code_units()
            .map(|unit| unit as u8)
            .collect::<Vec<_>>();
        if name.is_empty()
            || !name.iter().all(|byte| token(*byte))
            || value
                .iter()
                .any(|byte| (*byte < 32 && *byte != b'\t') || *byte == 127)
        {
            return;
        }
        bytes.extend_from_slice(&name);
        bytes.extend_from_slice(b": ");
        bytes.extend_from_slice(&value);
        bytes.extend_from_slice(b"\r\n");
    }
    bytes.extend_from_slice(b"Connection: close\r\n\r\n");
    if upstream.write_all(&bytes).await.is_err() {
        return;
    }
    let (client_read, mut client_write) = tokio::io::split(client);
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);
    let mut source = BufReader::new(PrefixedStream::new(head.rest.clone(), client_read));
    let upload = async {
        forward_body(&mut source, &mut upstream_write, head.framing).await?;
        upstream_write.flush().await
    };
    let download = async {
        let result = tokio::io::copy(&mut upstream_read, &mut client_write).await;
        let _ = client_write.shutdown().await;
        result
    };
    tokio::pin!(upload);
    tokio::pin!(download);
    let mut uploaded = false;
    loop {
        tokio::select! {
            _ = &mut download => break,
            result = &mut upload, if !uploaded => { if result.is_err() { break; } uploaded = true; },
            _ = shared.shutdown.cancelled() => break,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TunnelMode {
    Disabled,
    Enabled,
    Detect,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TunnelTransport {
    Opaque,
    Tls,
    Http,
    Reject,
}

pub(super) fn classify_tunnel(
    prefix: &[u8],
    mode: TunnelMode,
    protocols: BrokeredProtocols,
    network_mode: NetworkMode,
) -> TunnelTransport {
    if mode == TunnelMode::Disabled {
        return TunnelTransport::Opaque;
    }
    if mode == TunnelMode::Enabled || (prefix.first() == Some(&0x16) && protocols.tls) {
        return TunnelTransport::Tls;
    }
    if protocols.http
        && prefix
            .iter()
            .position(|byte| *byte == b' ')
            .is_some_and(|index| {
                (3..=10).contains(&index)
                    && prefix[..index].iter().all(|byte| byte.is_ascii_uppercase())
            })
    {
        return TunnelTransport::Http;
    }
    if network_mode == NetworkMode::Limited {
        TunnelTransport::Reject
    } else {
        TunnelTransport::Opaque
    }
}

pub(super) fn protocols_for(shared: &Shared, host: &str, port: u16) -> BrokeredProtocols {
    shared
        .broker
        .as_ref()
        .map_or_else(BrokeredProtocols::default, |entry| {
            entry.broker.interception(&host.into(), port)
        })
}

pub(super) fn tunnel_mode(shared: &Shared, host: &str, port: u16) -> TunnelMode {
    let protocols = protocols_for(shared, host, port);
    if shared.mode == NetworkMode::Limited && !protocols.http {
        TunnelMode::Enabled
    } else if protocols.tls || protocols.http {
        TunnelMode::Detect
    } else {
        TunnelMode::Disabled
    }
}

pub(super) fn raw_path_of(target: &str) -> LosslessString {
    let target = if let Some((scheme, rest)) = target.split_once("://") {
        if scheme
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic())
            && scheme
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"+.-".contains(&byte))
        {
            &rest[rest.find(['/', '?', '#']).unwrap_or(rest.len())..]
        } else {
            target
        }
    } else {
        target
    };
    let path = target.split(['?', '#']).next().unwrap_or("");
    if path.is_empty() {
        "/".into()
    } else {
        path.into()
    }
}

fn request_url(head: &RequestHead, scheme: &str, host: &str, port: u16) -> Option<url::Url> {
    let target = if head.target.starts_with('/') {
        format!("{scheme}://{}:{port}{}", url_host(host), head.target)
    } else {
        head.target.clone()
    };
    let url = url::Url::parse(&target).ok()?;
    if url.scheme() != scheme
        || normalize_host(url.host_str()?) != host
        || url.port_or_known_default()? != port
    {
        return None;
    }
    if head
        .headers
        .iter()
        .filter(|(name, _)| header_is(name, "host"))
        .count()
        > 1
    {
        return None;
    }
    for (_, value) in head
        .headers
        .iter()
        .filter(|(name, _)| header_is(name, "host"))
    {
        let parsed = url::Url::parse(&format!("{scheme}://{}", value.as_str()?)).ok()?;
        if normalize_host(parsed.host_str()?) != host
            || (scheme == "http" && parsed.port_or_known_default()? != port)
        {
            return None;
        }
    }
    Some(url)
}

async fn respond<S: AsyncWrite + Unpin>(stream: &mut S, response: String) {
    if stream.write_all(response.as_bytes()).await.is_ok() {
        let _ = stream.shutdown().await;
    }
}

async fn handle_intercepted<S: AsyncRead + AsyncWrite + Unpin>(
    shared: &Arc<Shared>,
    mut stream: S,
    scheme: &str,
    host: &str,
    port: u16,
) {
    let Some(head) = read_request_head(&mut stream).await else {
        respond(
            &mut stream,
            text_response(400, "Bad Request", "invalid request", &[]),
        )
        .await;
        return;
    };
    if head.method == "CONNECT" {
        respond(
            &mut stream,
            text_response(
                405,
                "Method Not Allowed",
                "CONNECT not supported inside MITM",
                &[],
            ),
        )
        .await;
        return;
    }
    let Some(url) = request_url(&head, scheme, host, port) else {
        respond(
            &mut stream,
            text_response(400, "Bad Request", "host mismatch", &[]),
        )
        .await;
        return;
    };
    if shared.mode == NetworkMode::Limited && !SAFE_METHODS.contains(&head.method.as_str()) {
        respond(&mut stream, blocked_response(REASON_METHOD_NOT_ALLOWED)).await;
        return;
    }
    let blocked = shared.policy.host_blocked(host, port, true).await;
    if blocked != HostBlockDecision::Allowed {
        respond(&mut stream, blocked_response(blocked.reason())).await;
        return;
    }
    let mut headers = forwarded_headers(&head);
    if !headers.iter().any(|(name, _)| header_is(name, "host")) {
        headers.insert(
            0,
            (
                "Host".into(),
                LosslessString::from(&url[url::Position::BeforeHost..url::Position::AfterPort]),
            ),
        );
    }
    if let Some(entry) = &shared.broker {
        headers = entry
            .broker
            .restore_request_headers(&url, &raw_path_of(&head.target), &headers);
    }
    let target = format!(
        "{}{}",
        url.path(),
        url.query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    );
    let Ok(upstream) = TcpStream::connect((host, port)).await else {
        respond(
            &mut stream,
            text_response(502, "Bad Gateway", "upstream connection failed", &[]),
        )
        .await;
        return;
    };
    if scheme == "https" {
        let Some(connector) = &shared.upstream_tls else {
            return;
        };
        match connector.connect(host, upstream).await {
            Ok(upstream) => {
                forward_request(shared, stream, upstream, &head, &target, &headers).await
            }
            Err(_) => {
                respond(
                    &mut stream,
                    text_response(502, "Bad Gateway", "upstream connection failed", &[]),
                )
                .await
            }
        }
    } else {
        forward_request(shared, stream, upstream, &head, &target, &headers).await;
    }
}

pub(super) async fn run_tunnel(
    shared: &Arc<Shared>,
    mut socket: TcpStream,
    mut prefix: Vec<u8>,
    host: &str,
    port: u16,
) {
    let mode = tunnel_mode(shared, host, port);
    if mode == TunnelMode::Disabled {
        forward_opaque(shared, socket, prefix, host, port).await;
        return;
    }
    while prefix.is_empty()
        || (prefix[0].is_ascii_uppercase() && !prefix.contains(&b' ') && prefix.len() < 11)
    {
        let mut buffer = [0u8; 8192];
        let Ok(count) = socket.read(&mut buffer).await else {
            return;
        };
        if count == 0 {
            return;
        }
        prefix.extend_from_slice(&buffer[..count]);
    }
    match classify_tunnel(
        &prefix,
        mode,
        protocols_for(shared, host, port),
        shared.mode,
    ) {
        TunnelTransport::Opaque => forward_opaque(shared, socket, prefix, host, port).await,
        TunnelTransport::Http => {
            handle_intercepted(
                shared,
                PrefixedStream::new(prefix, socket),
                "http",
                host,
                port,
            )
            .await
        }
        TunnelTransport::Tls => {
            let Some(authority) = &shared.authority else {
                return;
            };
            let Ok(config) = authority.server_config_for_host(host) else {
                return;
            };
            if let Ok(stream) = TlsAcceptor::from(config)
                .accept(PrefixedStream::new(prefix, socket))
                .await
            {
                handle_intercepted(shared, stream, "https", host, port).await;
            }
        }
        TunnelTransport::Reject => {}
    }
}
