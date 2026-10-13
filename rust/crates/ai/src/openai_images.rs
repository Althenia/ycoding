use crate::{
    Error,
    image::{self, Body, Config, Data, Generated, Input, Kind, Model, Request, Response},
    json::{self, get, s},
    llm::{HttpOptions, Usage},
    openai_shared::{pick, string, validate},
};
use ycoding_schema::{JsonValue, LosslessString, stringify_json};

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
pub fn model(id: impl Into<LosslessString>, config: Config) -> Model {
    Model::new(id, Kind::OpenAI, config)
}
fn options(request: &Request) -> JsonValue {
    image::native(
        &request.options,
        &[
            ("outputFormat", "output_format"),
            ("outputCompression", "output_compression"),
        ],
        &["mask"],
    )
}
fn reference(input: &Input) -> Option<JsonValue> {
    match input {
        Input::Bytes { .. } => {
            image::data_url(input).map(|url| json::object([("image_url", s(url))]))
        }
        Input::Url(url) => Some(json::object([("image_url", s(url.clone()))])),
        Input::FileId(id) => Some(json::object([("file_id", s(id.clone()))])),
        Input::FileUri { .. } => None,
    }
}
pub(crate) fn lower(request: &Request, http: &HttpOptions) -> Result<Body, Error> {
    if request.mask.is_some() && request.images.is_empty() {
        return Err(Error::invalid(
            "An OpenAI image mask requires at least one input image",
        ));
    }
    let images = request
        .images
        .iter()
        .map(image::bytes)
        .collect::<Result<Vec<_>, _>>()?;
    let mask = request
        .mask
        .as_ref()
        .map(image::bytes)
        .transpose()?
        .flatten();
    let path = if request.images.is_empty() {
        "/images/generations"
    } else {
        "/images/edits"
    };
    if !images.is_empty()
        && images.iter().all(Option::is_some)
        && (request.mask.is_none() || mask.is_some())
    {
        let mut random = [0u8; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut random)
            .map_err(|_| Error::transport("Failed to create image multipart boundary", "client"))?;
        let boundary = format!(
            "----WebKitFormBoundary{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let mut body = Vec::new();
        field(&mut body, &boundary, &"model".into(), &request.model.id);
        field(&mut body, &boundary, &"prompt".into(), &request.prompt);
        if let JsonValue::Object(fields) = json::merge(
            &options(request),
            http.body.as_ref().unwrap_or(&json::empty()),
        ) {
            for (key, value) in fields.iter() {
                if matches!(
                    key.as_str(),
                    Some("model" | "prompt" | "image" | "image[]" | "images" | "mask")
                ) {
                    continue;
                }
                field(
                    &mut body,
                    &boundary,
                    key,
                    &json::string(value)
                        .cloned()
                        .unwrap_or_else(|| stringify_json(value).into()),
                );
            }
        }
        for (index, image) in images.iter().enumerate() {
            if let Some((mime, data)) = image {
                file(
                    &mut body,
                    &boundary,
                    "image[]",
                    &format!("image-{index}"),
                    mime,
                    data,
                );
            }
        }
        if let Some((mime, data)) = mask {
            file(&mut body, &boundary, "mask", "mask", &mime, &data);
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        return Ok(Body {
            path: path.into(),
            bytes: body,
            content_type: format!("multipart/form-data; boundary={boundary}"),
            auth_body: "[multipart/form-data]".into(),
        });
    }
    let references = request
        .images
        .iter()
        .map(|input| {
            reference(input).ok_or_else(|| {
                Error::invalid("OpenAI Images accepts image URLs, data URLs, bytes, and file IDs")
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut fields = json::empty();
    if !references.is_empty() {
        json::set(&mut fields, "images", JsonValue::Array(references));
    }
    if let Some(mask) = &request.mask {
        json::set(
            &mut fields,
            "mask",
            reference(mask).ok_or_else(|| {
                Error::invalid("OpenAI Images accepts masks as URLs, data URLs, bytes, or file IDs")
            })?,
        );
    }
    Ok(Body::json(
        path,
        image::body(request, http, options(request), fields),
    ))
}
fn normalized(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n")
}
fn field(body: &mut Vec<u8>, boundary: &str, key: &LosslessString, value: &LosslessString) {
    let key = normalized(&image::usv_string(key))
        .replace('\r', "%0D")
        .replace('\n', "%0A")
        .replace('"', "%22");
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{}\r\n",
            normalized(&image::usv_string(value))
        )
        .as_bytes(),
    );
}
fn file(
    body: &mut Vec<u8>,
    boundary: &str,
    key: &str,
    name: &str,
    mime: &LosslessString,
    data: &[u8],
) {
    let mime = mime
        .as_str()
        .filter(|mime| !mime.is_empty() && mime.bytes().all(|byte| (32..=126).contains(&byte)))
        .unwrap_or("application/octet-stream")
        .to_ascii_lowercase();
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n");
}
pub fn parse(request: &Request, payload: &JsonValue) -> Result<Response, Error> {
    let invalid = || Error::output("OpenAI Images returned an invalid response");
    if !validate(payload, &["output_format"], &[], &[]) {
        return Err(invalid());
    }
    let data = get(payload, "data")
        .and_then(json::array)
        .ok_or_else(invalid)?;
    let raw = get(payload, "usage");
    if let Some(raw) = raw
        && (!validate(
            raw,
            &[],
            &[],
            &["input_tokens", "output_tokens", "total_tokens"],
        ) || ["input_tokens_details", "output_tokens_details"]
            .iter()
            .any(|key| get(raw, key).is_some_and(|value| !matches!(value, JsonValue::Object(_)))))
    {
        return Err(invalid());
    }
    let native = json::merge(
        &options(request),
        request
            .model
            .config
            .http
            .overlay(&request.http)
            .body
            .as_ref()
            .unwrap_or(&json::empty()),
    );
    let format = string(payload, "output_format")
        .or_else(|| string(&native, "output_format"))
        .cloned()
        .unwrap_or_else(|| "png".into());
    let mut media_type = "image/".into();
    json::concat(&mut media_type, &format);
    let images = data
        .iter()
        .enumerate()
        .map(|(index, item)| {
            if !validate(item, &["b64_json", "url", "revised_prompt"], &[], &[]) {
                return Err(invalid());
            }
            let data = if let Some(data) = string(item, "b64_json").filter(|text| !text.is_empty())
            {
                Data::Bytes(image::decoded(
                    data,
                    format!("OpenAI Images result {index} contains invalid base64 data"),
                )?)
            } else if let Some(url) = string(item, "url").filter(|text| !text.is_empty()) {
                Data::Url(url.clone())
            } else {
                return Err(Error::output(format!(
                    "OpenAI Images result {index} has neither image data nor a URL"
                )));
            };
            Ok(Generated {
                media_type: media_type.clone(),
                data,
                provider_metadata: string(item, "revised_prompt").map(|text| {
                    json::object([("openai", json::object([("revisedPrompt", s(text.clone()))]))])
                }),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if images.is_empty() {
        return Err(Error::output("OpenAI Images returned no images"));
    }
    Ok(Response {
        images,
        usage: raw.map(|raw| Usage {
            input_tokens: get(raw, "input_tokens").and_then(json::number),
            output_tokens: get(raw, "output_tokens").and_then(json::number),
            total_tokens: get(raw, "total_tokens").and_then(json::number),
            provider_metadata: image::metadata(
                "openai",
                pick(
                    raw,
                    &[
                        "input_tokens",
                        "output_tokens",
                        "total_tokens",
                        "input_tokens_details",
                        "output_tokens_details",
                    ],
                ),
            ),
            ..Usage::default()
        }),
        provider_metadata: image::metadata("openai", json::object([("outputFormat", s(format))])),
    })
}
