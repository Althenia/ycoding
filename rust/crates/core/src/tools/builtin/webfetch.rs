use super::{
    filesystem::{object, utf8},
    http_body,
};
use crate::tools::{
    context::{Context, policy::LeafPolicy},
    registry::{Failure, Tool, ToolFuture},
};
use std::{sync::Arc, time::Duration};
use ycoding_ai::llm::{ToolDefinition, ToolOutput};
use ycoding_schema::{
    JsonValue, ObjectEncoder,
    llm::{ToolContent, ToolTextContent},
    parse_json,
};

pub const MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_SECONDS: f64 = 30.0;
pub const MAX_TIMEOUT_SECONDS: f64 = 120.0;
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

pub struct WebFetch {
    pub policy: Arc<LeafPolicy>,
}

impl Tool for WebFetch {
    fn definition(&self, name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.into(),
            description: "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Each HTTP redirect requires permission for its destination before it is followed, up to 10 redirects. Large text results may be replaced with a preview while the complete output is retained in managed storage.".into(),
            input_schema: parse_json(r#"{"type":"object","properties":{"url":{"type":"string","description":"The HTTP or HTTPS URL to fetch content from"},"format":{"anyOf":[{"type":"string","enum":["text","markdown","html"]},{"type":"null"}],"description":"The format to return the content in. Defaults to markdown."},"timeout":{"anyOf":[{"type":"number","allOf":[{"exclusiveMinimum":0},{"maximum":120}]},{"type":"null"}],"description":"Optional timeout in seconds (maximum: 120)"}},"required":["url"],"additionalProperties":false}"#).unwrap(),
            output_schema: Some(parse_json(r#"{"type":"object","properties":{"url":{"type":"string"},"contentType":{"type":"string"},"format":{"type":"string","enum":["text","markdown","html"]},"output":{"type":"string"}},"required":["url","contentType","format","output"],"additionalProperties":false}"#).unwrap()),
            cache: None,
            metadata: None,
            native: None,
        }
    }

    fn permission(&self) -> Option<&str> {
        None
    }

    fn settle(&self, input: JsonValue, context: Context) -> ToolFuture<'_> {
        Box::pin(async move {
            let input = object(&input)?;
            let url = utf8(input, "url")?;
            let format = match input.get(&"format".into()) {
                None | Some(JsonValue::Null) => "markdown",
                Some(JsonValue::String(value)) => value
                    .as_str()
                    .filter(|value| ["text", "markdown", "html"].contains(value))
                    .ok_or_else(|| Failure::message("Invalid tool input: Invalid format"))?,
                _ => return Err(Failure::message("Invalid tool input: Invalid format")),
            };
            let timeout = match input.get(&"timeout".into()) {
                None | Some(JsonValue::Null) => DEFAULT_TIMEOUT_SECONDS,
                Some(JsonValue::Number(value))
                    if value.is_finite() && *value > 0.0 && *value <= MAX_TIMEOUT_SECONDS =>
                {
                    *value
                }
                _ => return Err(Failure::message("Invalid tool input: Invalid timeout")),
            };
            let result = tokio::time::timeout(
                Duration::from_secs_f64(timeout),
                self.fetch(&url, format, input, &context),
            )
            .await
            .map_err(|_| Failure::message(format!("Unable to fetch {url}")))??;
            Ok(ToolOutput {
                structured: ObjectEncoder::new()
                    .field("url", url.as_str())
                    .field("contentType", result.content_type.as_str())
                    .field("format", format)
                    .field("output", result.output.as_str())
                    .finish(),
                content: vec![ToolContent::Text(ToolTextContent {
                    text: result.output.into(),
                })],
            })
        })
    }
}

struct Fetched {
    content_type: String,
    output: String,
}

impl WebFetch {
    async fn fetch(
        &self,
        initial: &str,
        format: &str,
        input: &ycoding_schema::JsonObject,
        context: &Context,
    ) -> Result<Fetched, Failure> {
        let mut url = reqwest::Url::parse(initial)
            .map_err(|_| Failure::message(format!("Unable to fetch {initial}")))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(Failure::message(format!("Unable to fetch {initial}")));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Failure::message(format!("Unable to fetch {initial}")))?;
        for redirects in 0..=10 {
            let mut metadata = input.clone();
            metadata.insert("url".into(), JsonValue::String(url.as_str().into()));
            self.policy
                .assert(
                    context,
                    "webfetch",
                    vec![url.as_str().into()],
                    vec!["*".into()],
                    Some(metadata),
                )
                .await
                .map_err(|error| match error {
                    Failure::Cancelled | Failure::Defect(_) => error,
                    _ => Failure::message(format!("Unable to fetch {initial}")),
                })?;
            let mut response = request(&client, &url, format, BROWSER_USER_AGENT)
                .send()
                .await
                .map_err(|_| Failure::message(format!("Unable to fetch {initial}")))?;
            if response.status() == reqwest::StatusCode::FORBIDDEN
                && response
                    .headers()
                    .get("cf-mitigated")
                    .is_some_and(|value| value == "challenge")
            {
                response = request(&client, &url, format, "ycoding")
                    .send()
                    .await
                    .map_err(|_| Failure::message(format!("Unable to fetch {initial}")))?;
            }
            if response.status().is_redirection()
                && let Some(location) = response.headers().get(reqwest::header::LOCATION)
            {
                if redirects == 10 {
                    return Err(Failure::message(format!("Unable to fetch {initial}")));
                }
                let location = location
                    .to_str()
                    .map_err(|_| Failure::message(format!("Unable to fetch {initial}")))?;
                url = url
                    .join(location)
                    .map_err(|_| Failure::message(format!("Unable to fetch {initial}")))?;
                if !matches!(url.scheme(), "http" | "https") {
                    return Err(Failure::message(format!("Unable to fetch {initial}")));
                }
                continue;
            }
            if !response.status().is_success() {
                return Err(Failure::message(format!("Unable to fetch {initial}")));
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_owned();
            let mime = content_type
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if mime.starts_with("image/")
                && mime != "image/svg+xml"
                && mime != "image/vnd.fastbidsheet"
            {
                return Err(Failure::message(format!("Unable to fetch {initial}")));
            }
            if !(mime.is_empty()
                || mime.starts_with("text/")
                || mime == "application/json"
                || mime.ends_with("+json")
                || mime == "application/xml"
                || mime.ends_with("+xml")
                || mime == "application/javascript"
                || mime == "application/x-javascript")
            {
                return Err(Failure::message(format!("Unable to fetch {initial}")));
            }
            let body = http_body::collect(response, MAX_RESPONSE_BYTES)
                .await
                .map_err(|_| Failure::message(format!("Unable to fetch {initial}")))?;
            let content = String::from_utf8_lossy(&body).into_owned();
            let output = if content_type.to_ascii_lowercase().contains("text/html") {
                match format {
                    "markdown" => convert_html_to_markdown(&content),
                    "text" => extract_text_from_html(&content),
                    _ => content,
                }
            } else {
                content
            };
            return Ok(Fetched {
                content_type,
                output,
            });
        }
        Err(Failure::message(format!("Unable to fetch {initial}")))
    }
}

fn request(
    client: &reqwest::Client,
    url: &reqwest::Url,
    format: &str,
    user_agent: &str,
) -> reqwest::RequestBuilder {
    client
        .get(url.clone())
        .header("User-Agent", user_agent)
        .header("Accept", accept_header(format))
        .header("Accept-Language", "en-US,en;q=0.9")
}

fn accept_header(format: &str) -> &'static str {
    match format {
        "markdown" => {
            "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
        }
        "text" => "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
        "html" => {
            "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
        }
        _ => "*/*",
    }
}

pub fn extract_text_from_html(html: &str) -> String {
    parse_html(html, false)
}

pub fn convert_html_to_markdown(html: &str) -> String {
    parse_html(html, true)
}

fn parse_html(html: &str, markdown: bool) -> String {
    let mut output = String::new();
    let mut cursor = 0;
    let mut skipped = 0usize;
    while cursor < html.len() {
        let rest = &html[cursor..];
        let Some(open) = rest.find('<') else {
            if skipped == 0 {
                output.push_str(&decode_entities(rest));
            }
            break;
        };
        if skipped == 0 {
            output.push_str(&decode_entities(&rest[..open]));
        }
        let tag_start = cursor + open;
        let Some(relative_end) = html[tag_start..].find('>') else {
            break;
        };
        let end = tag_start + relative_end;
        let raw_tag = &html[tag_start + 1..end];
        let (closing, name, self_closing) = parse_tag(raw_tag);
        if skipped > 0 {
            if closing {
                skipped = skipped.saturating_sub(1);
            } else if !self_closing {
                skipped += 1;
            }
        } else if !closing
            && (["script", "style", "noscript", "iframe", "object", "embed"]
                .contains(&name.as_str())
                || (markdown && ["meta", "link"].contains(&name.as_str())))
        {
            if !self_closing {
                skipped = 1;
            }
        } else if markdown {
            render_markdown_tag(&mut output, &name, closing);
        }
        cursor = end + 1;
    }
    output.trim().to_owned()
}

fn parse_tag(raw: &str) -> (bool, String, bool) {
    let raw = raw.trim();
    let closing = raw.starts_with('/');
    let name = raw
        .trim_start_matches('/')
        .split(|character: char| character.is_whitespace() || character == '/' || character == '>')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    (
        closing,
        name.clone(),
        raw.ends_with('/')
            || [
                "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
                "param", "source", "track", "wbr",
            ]
            .contains(&name.as_str()),
    )
}

fn render_markdown_tag(output: &mut String, name: &str, closing: bool) {
    if closing {
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "div" | "blockquote" | "ul" | "ol" => {
                output.push_str("\n\n")
            }
            "li" => output.push('\n'),
            "strong" | "b" => output.push_str("**"),
            "em" | "i" => output.push('*'),
            "del" | "s" | "strike" => output.push_str("~~"),
            "code" => output.push('`'),
            "br" => output.push('\n'),
            _ => {}
        }
        return;
    }
    match name {
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            block_separator(output);
            output.push_str(&"#".repeat(name[1..].parse::<usize>().unwrap_or(1)));
            output.push(' ');
        }
        "p" | "div" | "ul" | "ol" | "blockquote" => block_separator(output),
        "li" => {
            block_separator(output);
            output.push_str("- ");
        }
        "strong" | "b" => output.push_str("**"),
        "em" | "i" => output.push('*'),
        "del" | "s" | "strike" => output.push_str("~~"),
        "code" => output.push('`'),
        "br" => output.push('\n'),
        "hr" => output.push_str("\n\n---\n\n"),
        _ => {}
    }
}

fn block_separator(output: &mut String) {
    while output.ends_with(' ') {
        output.pop();
    }
    if !output.is_empty() && !output.ends_with("\n\n") {
        if output.ends_with('\n') {
            output.push('\n');
        } else {
            output.push_str("\n\n");
        }
    }
}

fn decode_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(start) = input[cursor..].find('&') {
        let start = cursor + start;
        output.push_str(&input[cursor..start]);
        let Some(end) = input[start..].find(';') else {
            output.push_str(&input[start..]);
            return output;
        };
        let end = start + end;
        let entity = &input[start + 1..end];
        let value = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|number| u32::from_str_radix(number, 16).ok())
                .or_else(|| {
                    entity
                        .strip_prefix('#')
                        .and_then(|number| number.parse().ok())
                })
                .and_then(char::from_u32),
        };
        if let Some(value) = value {
            output.push(value);
        } else {
            output.push_str(&input[start..=end]);
        }
        cursor = end + 1;
    }
    output.push_str(&input[cursor..]);
    output
}
