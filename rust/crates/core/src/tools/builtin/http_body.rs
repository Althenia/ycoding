#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    TooLarge,
    Network,
}

pub fn declared_size(header: &str) -> Option<usize> {
    let header = crate::resources::discovery::trim(header);
    let negative = header.starts_with('-');
    let header = header.strip_prefix(['+', '-']).unwrap_or(header);
    let digits = header.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let value = header[..digits].parse::<f64>().ok()?;
    if value > 9_007_199_254_740_991.0 || !value.is_finite() || (negative && value != 0.0) {
        return None;
    }
    Some(value as usize)
}

pub async fn collect(mut response: reqwest::Response, maximum: usize) -> Result<Vec<u8>, Error> {
    let declared = response
        .headers()
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .and_then(declared_size);
    if declared.is_some_and(|size| size > maximum) {
        return Err(Error::TooLarge);
    }
    let mut body =
        Vec::with_capacity(maximum.min(declared.filter(|size| *size > 0).unwrap_or(64 * 1024)));
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Network)? {
        if chunk.len() > maximum.saturating_sub(body.len()) {
            return Err(Error::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
