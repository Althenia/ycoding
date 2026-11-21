use serde_json::Value;
use std::fmt;
use std::time::Duration;

const MAX_BODY: usize = 1_048_576;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientError(pub String);

impl fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ClientError {}

pub async fn send_control(url: &str, token: &str, input: &Value) -> Result<Value, ClientError> {
    let port = url
        .strip_prefix("http://127.0.0.1:")
        .map(|rest| rest.strip_suffix('/').unwrap_or(rest))
        .filter(|port| {
            !port.is_empty()
                && port.len() <= 5
                && !port.starts_with('0')
                && port.bytes().all(|byte| byte.is_ascii_digit())
                && port.parse::<u32>().is_ok_and(|port| port <= 65535)
        })
        .ok_or_else(|| ClientError("Invalid bridge URL".into()))?;
    if !(32..=256).contains(&token.len())
        || !token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(ClientError("Invalid controller credential".into()));
    }
    let body = input.to_string();
    if body.len() > MAX_BODY {
        return Err(ClientError("Invalid control payload".into()));
    }
    let unknown = || ClientError("Bridge request failed or timed out; outcome unknown".into());
    let response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| unknown())?
        .post(format!("http://127.0.0.1:{port}/control"))
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| unknown())?;
    if !response.status().is_success() {
        return Err(ClientError(format!(
            "Bridge control rejected ({})",
            response.status().as_u16()
        )));
    }
    let invalid = || ClientError("Invalid bridge response; outcome unknown".into());
    serde_json::from_slice(&response.bytes().await.map_err(|_| invalid())?).map_err(|_| invalid())
}
