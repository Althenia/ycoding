use crate::{
    Error,
    auth::Auth,
    json::{self, get, s},
    llm::{Model, Part, Request},
    providers::{self, Api},
    route::Route,
};
use reqwest::header::HeaderValue;
use std::sync::Arc;
use ycoding_schema::{JsonValue, LosslessString, parse_json};

pub struct Config {
    pub common: providers::Config,
    pub api: Option<Api>,
    pub user_agent: String,
}

pub fn model(id: impl Into<LosslessString>, config: Config) -> Result<Model, Error> {
    let id = id.into();
    let base_url = config
        .common
        .base_url
        .as_ref()
        .filter(|url| !url.is_empty())
        .ok_or_else(|| Error::invalid("GitHub Copilot requires a baseURL"))?;
    let user_agent = HeaderValue::from_str(&config.user_agent)
        .map_err(|_| Error::invalid("Invalid Copilot user-agent"))?;
    let mut route = if providers::copilot_uses_responses(&id, config.api) {
        let mut route = Route::openai_responses();
        route.protocol = Arc::new(crate::github_copilot_responses::Responses);
        route.defaults.provider_options = None;
        route
    } else {
        let mut route = Route::openai_chat();
        route.protocol = Arc::new(crate::github_copilot_chat::Chat);
        route
    };
    route.id = "ai-sdk:@ai-sdk/github-copilot".into();
    route.provider = ycoding_schema::provider::Id("github-copilot".into());
    route.provider_metadata_key = Some("copilot".into());
    route.endpoint.base_url = base_url.clone();
    route.endpoint.query = config.common.query;
    route.auth = Auth::Remove("x-api-key".into())
        .and_then(config.common.auth)
        .and_then(Auth::custom(move |input| {
            let mut headers = input.headers;
            headers.insert("user-agent", user_agent.clone());
            headers.insert(
                "openai-intent",
                HeaderValue::from_static("conversation-edits"),
            );
            headers.insert(
                "x-github-api-version",
                HeaderValue::from_static("2026-06-01"),
            );
            let body = parse_json(input.body)
                .map_err(|_| Error::invalid("Invalid Copilot request body"))?;
            let messages = get(&body, "input")
                .or_else(|| get(&body, "messages"))
                .and_then(json::array)
                .unwrap_or(&[]);
            let agent = messages
                .last()
                .and_then(|item| get(item, "role"))
                .and_then(json::text)
                != Some("user");
            headers.insert(
                "x-initiator",
                HeaderValue::from_static(if agent { "agent" } else { "user" }),
            );
            let vision = messages.iter().any(|item| {
                get(item, "content")
                    .and_then(json::array)
                    .is_some_and(|parts| {
                        parts.iter().any(|part| {
                            matches!(
                                get(part, "type").and_then(json::text),
                                Some("input_image" | "image_url")
                            )
                        })
                    })
            });
            if vision {
                headers.insert("copilot-vision-request", HeaderValue::from_static("true"));
            }
            Ok(headers)
        }));
    let mut model = route.model(id);
    model.defaults = config.common.defaults;
    Ok(model)
}

pub(crate) fn options(request: &Request) -> JsonValue {
    let options = request.provider_options.as_ref();
    json::merge(
        options
            .and_then(|value| get(value, "openai"))
            .unwrap_or(&json::empty()),
        options
            .and_then(|value| get(value, "copilot"))
            .unwrap_or(&json::empty()),
    )
}

pub(crate) fn part_metadata(part: &Part) -> Option<&JsonValue> {
    match part {
        Part::Text(part) => part.provider_metadata.as_ref(),
        Part::Reasoning(part) => part.provider_metadata.as_ref(),
        Part::ToolCall(part) => part.provider_metadata.as_ref(),
        Part::ToolResult(part) => part.provider_metadata.as_ref(),
        Part::Media(_) => None,
    }
    .and_then(|value| get(value, "copilot"))
}

pub(crate) fn metadata(value: JsonValue) -> Option<JsonValue> {
    Some(json::object([("copilot", value)]))
}

pub(crate) fn resolved(request: &Request) -> Request {
    let mut request = request.clone();
    request.provider_options = Some(json::object([("openai", options(&request))]));
    if request
        .model
        .id
        .as_str()
        .is_some_and(|id| id.contains("gpt"))
    {
        request.generation.max_tokens = None;
    }
    request
}

pub(crate) fn opaque(value: &JsonValue) -> Option<&JsonValue> {
    get(value, "opaqueCompactionItem").filter(|item| {
        get(item, "type").and_then(json::text) == Some("compaction")
            && get(item, "id").and_then(json::string).is_some()
            && get(item, "encrypted_content")
                .and_then(json::string)
                .is_some()
    })
}

pub(crate) fn image(part: &crate::llm::Media, responses: bool) -> Result<JsonValue, Error> {
    let mime = part.mime.as_str().unwrap_or("");
    if !mime.starts_with("image/") && !(responses && mime == "application/pdf") {
        return Err(Error::invalid(format!(
            "Unsupported file part media type {mime}"
        )));
    }
    let url = match &part.data {
        crate::llm::MediaData::Encoded(data)
            if data.as_str().is_some_and(|data| {
                data.starts_with("https://") || data.starts_with("http://")
            }) =>
        {
            data.clone()
        }
        crate::llm::MediaData::Bytes(bytes) => format!(
            "data:{};base64,{}",
            if mime == "image/*" {
                "image/jpeg"
            } else {
                mime
            },
            crate::media::encode(bytes)
        )
        .into(),
        crate::llm::MediaData::Encoded(data) => format!(
            "data:{};base64,{}",
            if mime == "image/*" {
                "image/jpeg"
            } else {
                mime
            },
            data.as_str()
                .ok_or_else(|| Error::invalid("Invalid Copilot base64 data"))?
        )
        .into(),
    };
    if mime == "application/pdf" {
        let remote = url.as_str().is_some_and(|url| url.starts_with("http"));
        let mut item = json::object([("type", s("input_file"))]);
        if !remote {
            json::set(
                &mut item,
                "filename",
                s(part.filename.clone().unwrap_or_else(|| "part-0.pdf".into())),
            );
        }
        json::set(
            &mut item,
            if remote { "file_url" } else { "file_data" },
            s(url),
        );
        return Ok(item);
    }
    Ok(if responses {
        json::object([("type", s("input_image")), ("image_url", s(url))])
    } else {
        json::object([
            ("type", s("image_url")),
            ("image_url", json::object([("url", s(url))])),
        ])
    })
}
