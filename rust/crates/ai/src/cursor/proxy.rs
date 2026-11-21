use crate::{Error, media};
use reqwest::Url;
use std::collections::BTreeMap;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};

pub fn resolve(host: &str, port: u16, environment: &BTreeMap<String, String>) -> Option<Url> {
    if host.is_empty()
        || host_matches_no_proxy(
            host,
            port,
            environment
                .get("NO_PROXY")
                .or_else(|| environment.get("no_proxy"))
                .map(String::as_str),
        )
    {
        return None;
    }
    let raw = environment
        .get("HTTPS_PROXY")
        .or_else(|| environment.get("https_proxy"))?
        .trim();
    if raw.is_empty() {
        return None;
    }
    let url = Url::parse(&if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    })
    .ok()?;
    (url.scheme() == "http" && url.host_str().is_some()).then_some(url)
}
pub fn host_matches_no_proxy(host: &str, port: u16, entries: Option<&str>) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host);
    if host.is_empty() {
        return false;
    }
    entries
        .unwrap_or("")
        .split(|character: char| character.is_whitespace() || character == ',')
        .any(|entry| {
            let entry = entry.trim().to_ascii_lowercase();
            if entry == "*" {
                return true;
            }
            let (name, specified) = if let Some(entry) = entry.strip_prefix('[') {
                if let Some((host, rest)) = entry.split_once(']') {
                    (
                        host,
                        rest.strip_prefix(':').filter(|value| !value.is_empty()),
                    )
                } else {
                    (entry, None)
                }
            } else if let Some((name, port)) = entry.rsplit_once(':')
                && !name.is_empty()
                && !port.is_empty()
                && port.bytes().all(|byte| byte.is_ascii_digit())
            {
                (name, Some(port))
            } else {
                (entry.as_str(), None)
            };
            let name = name.strip_prefix('.').unwrap_or(name);
            let name = name.strip_suffix('.').unwrap_or(name);
            !name.is_empty()
                && specified.is_none_or(|value| value.parse::<u16>().ok() == Some(port))
                && (host == name || host.ends_with(&format!(".{name}")))
        })
}
fn userinfo(value: &str) -> String {
    let mut bytes = Vec::new();
    let mut offset = 0;
    while offset < value.len() {
        if value.as_bytes()[offset] == b'%' {
            let Some(pair) = value.get(offset + 1..offset + 3) else {
                return value.to_owned();
            };
            let Ok(byte) = u8::from_str_radix(pair, 16) else {
                return value.to_owned();
            };
            bytes.push(byte);
            offset += 3;
        } else {
            bytes.push(value.as_bytes()[offset]);
            offset += 1;
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| value.to_owned())
}
pub async fn connect(proxy: &Url, target: &str, port: u16) -> Result<BufReader<TcpStream>, Error> {
    if proxy.scheme() != "http" {
        return Err(Error {
            code: Some("CURSOR_PROXY_UNSUPPORTED".into()),
            ..Error::invalid("Cursor HTTPS CONNECT requires an HTTP proxy")
        });
    }
    let host = proxy
        .host_str()
        .ok_or_else(|| Error::invalid("Cursor proxy has no host"))?;
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    let mut socket = BufReader::new(
        TcpStream::connect((host, proxy.port().unwrap_or(80)))
            .await
            .map_err(|_| Error {
                code: Some("CURSOR_PROXY_CONNECT_FAILED".into()),
                ..Error::transport("Cursor proxy TCP connection failed", "connect")
            })?,
    );
    let authority = format!("{target}:{port}");
    let authorization = if !proxy.username().is_empty()
        || proxy.password().is_some_and(|value| !value.is_empty())
    {
        format!(
            "Proxy-Authorization: Basic {}\r\n",
            media::encode(
                format!(
                    "{}:{}",
                    userinfo(proxy.username()),
                    userinfo(proxy.password().unwrap_or(""))
                )
                .as_bytes()
            )
        )
    } else {
        String::new()
    };
    socket.write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Connection: keep-alive\r\n{authorization}\r\n").as_bytes()).await
        .map_err(|_| Error::transport("Cursor proxy CONNECT write failed", "write"))?;
    socket
        .flush()
        .await
        .map_err(|_| Error::transport("Cursor proxy CONNECT flush failed", "write"))?;
    let mut headers = Vec::new();
    loop {
        let count = socket
            .read_until(b'\n', &mut headers)
            .await
            .map_err(|_| Error::transport("Cursor proxy CONNECT read failed", "read"))?;
        if count == 0 {
            return Err(Error::transport(
                "Cursor proxy closed before CONNECT response",
                "read",
            ));
        }
        if headers.ends_with(b"\r\n\r\n") {
            break;
        }
        if headers.len() > 64_000 {
            return Err(Error::transport(
                "Cursor proxy CONNECT headers exceed 64000 bytes",
                "read",
            ));
        }
    }
    let first = String::from_utf8_lossy(&headers)
        .lines()
        .next()
        .unwrap_or("")
        .to_owned();
    let status = first.split_whitespace().collect::<Vec<_>>();
    let code = status
        .first()
        .filter(|value| {
            value.len() == 8
                && value.starts_with("HTTP/")
                && value.as_bytes()[5].is_ascii_digit()
                && value.as_bytes()[6] == b'.'
                && value.as_bytes()[7].is_ascii_digit()
        })
        .and_then(|_| status.get(1))
        .filter(|value| value.len() == 3)
        .and_then(|value| value.parse::<u16>().ok());
    if code.is_none_or(|value| !(200..300).contains(&value)) {
        return Err(Error {
            code: Some("CURSOR_PROXY_CONNECT_REJECTED".into()),
            status: code,
            ..Error::transport("Cursor proxy rejected CONNECT", "connect")
        });
    }
    Ok(socket)
}
