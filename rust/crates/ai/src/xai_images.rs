use crate::{
    Error,
    image::{self, Config, Data, Generated, Input, Kind, Model, Request, Response},
    json::{self, get, s},
    llm::{HttpOptions, Usage},
    openai_shared::{string, validate},
};
use ycoding_schema::{JsonValue, LosslessString};
pub const DEFAULT_BASE_URL: &str = "https://api.x.ai/v1";
pub fn model(id: impl Into<LosslessString>, config: Config) -> Model {
    Model::new(id, Kind::Xai, config)
}
pub(crate) fn lower(request: &Request, http: &HttpOptions) -> Result<JsonValue, Error> {
    let references = request
        .images
        .iter()
        .map(|input| match input {
            Input::Bytes { .. } => Ok(json::object([
                (
                    "url",
                    s(image::data_url(input)
                        .ok_or_else(|| Error::invalid("Invalid image bytes"))?),
                ),
                ("type", s("image_url")),
            ])),
            Input::Url(url) => Ok(json::object([
                ("url", s(url.clone())),
                ("type", s("image_url")),
            ])),
            Input::FileId(id) => Ok(json::object([("file_id", s(id.clone()))])),
            Input::FileUri { .. } => Err(Error::invalid(
                "xAI Images accepts image URLs, data URLs, bytes, and file IDs",
            )),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let fields = match references.len() {
        0 => json::empty(),
        1 => json::object([("image", references[0].clone())]),
        _ => json::object([("images", JsonValue::Array(references))]),
    };
    Ok(image::body(
        request,
        http,
        image::native(
            &request.options,
            &[
                ("aspectRatio", "aspect_ratio"),
                ("responseFormat", "response_format"),
            ],
            &[],
        ),
        fields,
    ))
}
pub fn parse(payload: &JsonValue) -> Result<Response, Error> {
    let invalid = || Error::output("xAI Images returned an invalid response");
    let data = get(payload, "data")
        .and_then(json::array)
        .ok_or_else(invalid)?;
    let images = data
        .iter()
        .enumerate()
        .map(|(index, item)| {
            if !validate(
                item,
                &[],
                &["b64_json", "url", "revised_prompt", "mime_type"],
                &[],
            ) {
                return Err(invalid());
            }
            let data = if let Some(data) = string(item, "b64_json").filter(|text| !text.is_empty())
            {
                Data::Bytes(image::decoded(
                    data,
                    format!("xAI Images result {index} contains invalid base64 data"),
                )?)
            } else if let Some(url) = string(item, "url").filter(|text| !text.is_empty()) {
                Data::Url(url.clone())
            } else {
                return Err(Error::output(format!(
                    "xAI Images result {index} has neither image data nor a URL"
                )));
            };
            Ok(Generated {
                media_type: string(item, "mime_type")
                    .cloned()
                    .unwrap_or_else(|| "application/octet-stream".into()),
                data,
                provider_metadata: string(item, "revised_prompt").map(|text| {
                    json::object([("xai", json::object([("revisedPrompt", s(text.clone()))]))])
                }),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if images.is_empty() {
        return Err(Error::output("xAI Images returned no images"));
    }
    let usage = get(payload, "usage").filter(|raw| matches!(raw, JsonValue::Object(_)));
    Ok(Response {
        images,
        usage: usage.map(|raw| Usage {
            provider_metadata: image::metadata("xai", raw.clone()),
            ..Usage::default()
        }),
        provider_metadata: usage
            .and_then(|raw| image::metadata("xai", json::object([("usage", raw.clone())]))),
    })
}
