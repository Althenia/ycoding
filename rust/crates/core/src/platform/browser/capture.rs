use super::{Error, cdp::Client};
use serde_json::{Value, json};
use tokio::sync::watch;

const INCOMPLETE: &str = "Capture is disabled because the page could not be completely inspected";
const PROTECTED: &str = "Capture is disabled while password fields are present";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture {
    pub data: String,
    pub bytes: usize,
    pub media_type: &'static str,
}

pub async fn capture_page(
    cdp: &Client,
    session_id: &str,
    cancellation: Option<watch::Receiver<bool>>,
) -> Result<Capture, Error> {
    let document = cdp
        .send(
            "DOM.getDocument",
            json!({"depth":32,"pierce":true}),
            Some(session_id),
            cancellation.clone(),
            None,
        )
        .await?;
    assert_safe(document.get("root").unwrap_or(&Value::Null))?;
    let response = cdp
        .send(
            "Page.captureScreenshot",
            json!({"format":"png","fromSurface":true}),
            Some(session_id),
            cancellation,
            None,
        )
        .await?;
    let data = response
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("Chrome returned an invalid response"))?;
    let bytes = data.len() * 3 / 4;
    if bytes > ycoding_schema::browser::MAX_CAPTURE_BYTES {
        return Err(Error::new("Capture exceeds the 1 MiB limit"));
    }
    Ok(Capture {
        data: data.into(),
        bytes,
        media_type: "image/png",
    })
}

pub fn assert_safe(root: &Value) -> Result<(), Error> {
    let mut pending = vec![(root, 0)];
    let mut inspected = 0;
    while let Some((node, depth)) = pending.pop() {
        let node = node.as_object().ok_or_else(|| Error::new(INCOMPLETE))?;
        inspected += 1;
        if inspected > 10_000 {
            return Err(Error::new(INCOMPLETE));
        }
        let name = node.get("nodeName").and_then(Value::as_str).unwrap_or("");
        if name.eq_ignore_ascii_case("input")
            && node
                .get("attributes")
                .and_then(Value::as_array)
                .is_some_and(|attrs| {
                    attrs.as_chunks::<2>().0.iter().any(|pair| {
                        pair[0]
                            .as_str()
                            .is_some_and(|s| s.eq_ignore_ascii_case("type"))
                            && pair[1]
                                .as_str()
                                .is_some_and(|s| s.eq_ignore_ascii_case("password"))
                    })
                })
        {
            return Err(Error::new(PROTECTED));
        }
        let children = match node.get("children") {
            Some(value) => value
                .as_array()
                .ok_or_else(|| Error::new(INCOMPLETE))?
                .as_slice(),
            None => &[],
        };
        let shadows = match node.get("shadowRoots") {
            Some(value) => value
                .as_array()
                .ok_or_else(|| Error::new(INCOMPLETE))?
                .as_slice(),
            None => &[],
        };
        let content = node.get("contentDocument");
        if node
            .get("childNodeCount")
            .and_then(Value::as_f64)
            .is_some_and(|count| count > children.len() as f64)
            || (name.eq_ignore_ascii_case("iframe") && content.is_none())
        {
            return Err(Error::new(INCOMPLETE));
        }
        if depth >= 32 && (!children.is_empty() || !shadows.is_empty() || content.is_some()) {
            return Err(Error::new(INCOMPLETE));
        }
        pending.extend(
            children
                .iter()
                .chain(shadows)
                .chain(content)
                .map(|node| (node, depth + 1)),
        );
    }
    Ok(())
}
