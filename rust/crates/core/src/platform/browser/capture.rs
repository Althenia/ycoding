use super::{Error, cdp::Client};
use serde_json::{Value, json};
use std::collections::HashSet;
use tokio::sync::watch;
use ycoding_schema::{JsonPath, JsonValue, LosslessString, ObjectDecoder};

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
    capture_frames(cdp, session_id, &[], cancellation).await
}

pub async fn capture_frames(
    cdp: &Client,
    session_id: &str,
    frame_sessions: &[(String, String)],
    cancellation: Option<watch::Receiver<bool>>,
) -> Result<Capture, Error> {
    capture_options(cdp, session_id, frame_sessions, cancellation, None, false).await
}

#[allow(clippy::too_many_arguments)]
pub async fn capture_options(
    cdp: &Client,
    session_id: &str,
    frame_sessions: &[(String, String)],
    cancellation: Option<watch::Receiver<bool>>,
    clip: Option<ycoding_schema::browser::Clip>,
    full_page: bool,
) -> Result<Capture, Error> {
    let allowed = frame_sessions
        .iter()
        .map(|(frame, _)| frame.as_str())
        .collect::<HashSet<_>>();
    let mut sessions = frame_sessions
        .iter()
        .map(|(_, session)| session.as_str())
        .collect::<HashSet<_>>();
    sessions.insert(session_id);
    for session in sessions {
        let document = cdp
            .send(
                "DOM.getDocument",
                super::cdp::Message::encode_message(&json!({"depth":32,"pierce":true}))?,
                Some(session),
                cancellation.clone(),
                None,
            )
            .await?;
        let path = JsonPath::default();
        let root: ObjectDecoder<'_> =
            ObjectDecoder::new(&document, &path).map_err(|_| Error::new(INCOMPLETE))?;
        assert_domain_safe(
            &root
                .field::<JsonValue>("root")
                .map_err(|_| Error::new(INCOMPLETE))?,
            &allowed,
        )?;
    }
    let mut parameters = json!({"format":"png","fromSurface":true});
    if let Some(clip) = &clip {
        parameters["clip"] = json!({
            "x": clip.x.get(),
            "y": clip.y.get(),
            "width": clip.width.get(),
            "height": clip.height.get(),
            "scale": 1,
        });
        parameters["captureBeyondViewport"] = json!(true);
        parameters["fromSurface"] = json!(false);
    } else if full_page {
        parameters["captureBeyondViewport"] = json!(true);
        parameters["fromSurface"] = json!(false);
    }
    let response = cdp
        .send(
            "Page.captureScreenshot",
            parameters,
            Some(session_id),
            cancellation,
            None,
        )
        .await?;
    let data = response
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("Chrome returned an invalid response"))?;
    let padding = data
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count();
    if data.len() % 4 != 0
        || padding > 2
        || !data[..data.len().saturating_sub(padding)]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
    {
        return Err(Error::new("Chrome returned invalid capture data"));
    }
    let bytes = data.len() * 3 / 4 - padding;
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
    assert_domain_safe(&super::cdp::Message::encode_message(root)?, &HashSet::new())
}
fn assert_domain_safe(root: &JsonValue, allowed: &HashSet<&str>) -> Result<(), Error> {
    let mut pending = vec![(root, 0)];
    let mut inspected = 0;
    while let Some((node, depth)) = pending.pop() {
        let JsonValue::Object(object) = node else {
            return Err(Error::new(INCOMPLETE));
        };
        inspected += 1;
        if inspected > 10_000 {
            return Err(Error::new(INCOMPLETE));
        }
        let get = |name: &str| object.get(&LosslessString::from(name));
        let name = match get("nodeName") {
            Some(JsonValue::String(name)) => name.as_str().unwrap_or(""),
            _ => "",
        };
        if name.eq_ignore_ascii_case("input")
            && matches!(get("attributes"),Some(JsonValue::Array(attrs)) if attrs.as_chunks::<2>().0.iter().any(|pair|matches!((&pair[0],&pair[1]),(JsonValue::String(name),JsonValue::String(value)) if name.as_str().is_some_and(|name|name.eq_ignore_ascii_case("type")) && value.as_str().is_some_and(|value|value.eq_ignore_ascii_case("password")))))
        {
            return Err(Error::new(PROTECTED));
        }
        let list = |name| match get(name) {
            Some(JsonValue::Array(items)) => Ok(items.as_slice()),
            None => Ok(&[][..]),
            _ => Err(Error::new(INCOMPLETE)),
        };
        let children = list("children")?;
        let shadows = list("shadowRoots")?;
        let content = get("contentDocument");
        let inspected_frame = matches!(get("frameId"),Some(JsonValue::String(id)) if id.as_str().is_some_and(|id|allowed.contains(id)));
        if matches!(get("childNodeCount"),Some(JsonValue::Number(count)) if *count>children.len() as f64)
            || (name.eq_ignore_ascii_case("iframe") && content.is_none() && !inspected_frame)
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
