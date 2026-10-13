use crate::{
    Error,
    image::{self, Config, Data, Generated, Input, Kind, Model, Request, Response},
    json::{self, get, s},
    llm::{HttpOptions, Usage},
    openai_shared::{pick, string, validate},
    route::sum_tokens,
};
use ycoding_schema::{JsonValue, LosslessString};
pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub fn model(id: impl Into<LosslessString>, config: Config) -> Model {
    Model::new(id, Kind::Google, config)
}
pub(crate) fn lower(request: &Request, http: &HttpOptions) -> Result<JsonValue, Error> {
    let mut parts = vec![json::object([("text", s(request.prompt.clone()))])];
    for input in &request.images {
        let part = match input {
            Input::Bytes { data, media_type } => json::object([(
                "inlineData",
                json::object([
                    ("mimeType", s(media_type.clone())),
                    ("data", s(crate::media::encode(data))),
                ]),
            )]),
            Input::FileUri { uri, media_type } => json::object([(
                "fileData",
                json::object([
                    ("mimeType", s(media_type.clone())),
                    ("fileUri", s(uri.clone())),
                ]),
            )]),
            Input::Url(url) => {
                let (mime,data)=image::decode_url(url)?.ok_or_else(||Error::invalid("Google generateContent does not fetch public image URLs; use bytes, a data URL, or a Gemini file URI"))?;
                json::object([(
                    "inlineData",
                    json::object([
                        ("mimeType", s(mime)),
                        ("data", s(crate::media::encode(&data))),
                    ]),
                )])
            }
            Input::FileId(_) => {
                return Err(Error::invalid(
                    "Google generateContent requires Gemini file URIs rather than provider file IDs",
                ));
            }
        };
        parts.push(part);
    }
    let mut config = json::object([("responseModalities", JsonValue::Array(vec![s("IMAGE")]))]);
    for (key, keys) in [
        ("imageConfig", &["aspectRatio", "imageSize"][..]),
        ("thinkingConfig", &["thinkingLevel", "includeThoughts"][..]),
    ] {
        let value = pick(&request.options, keys);
        if let JsonValue::Object(fields) = &value
            && !fields.is_empty()
        {
            json::set(&mut config, key, value);
        }
        if key == "imageConfig"
            && let Some(seed) = get(&request.options, "seed")
        {
            json::set(&mut config, "seed", seed.clone());
        }
    }
    let config = json::merge(
        &config,
        &json::remove(
            &request.options,
            &[
                "aspectRatio",
                "imageSize",
                "seed",
                "thinkingLevel",
                "includeThoughts",
            ],
        ),
    );
    Ok(json::merge(
        &json::object([
            (
                "contents",
                JsonValue::Array(vec![json::object([
                    ("role", s("user")),
                    ("parts", JsonValue::Array(parts)),
                ])]),
            ),
            ("generationConfig", config),
        ]),
        http.body.as_ref().unwrap_or(&json::empty()),
    ))
}
pub fn parse(payload: &JsonValue) -> Result<Response, Error> {
    let invalid = || Error::output("Google Images returned an invalid response");
    if !validate(payload, &["modelVersion", "responseId"], &[], &[]) {
        return Err(invalid());
    }
    let candidates = match get(payload, "candidates") {
        Some(value) => json::array(value).ok_or_else(invalid)?,
        None => &[],
    };
    let raw = get(payload, "usageMetadata");
    if raw.is_some_and(|raw| {
        !validate(
            raw,
            &[],
            &[],
            &[
                "cachedContentTokenCount",
                "thoughtsTokenCount",
                "promptTokenCount",
                "candidatesTokenCount",
                "totalTokenCount",
            ],
        )
    }) {
        return Err(invalid());
    }
    let mut images = Vec::new();
    let mut details = Vec::new();
    for (candidate_index, candidate) in candidates.iter().enumerate() {
        if !validate(
            candidate,
            &["finishReason", "finishMessage"],
            &[],
            &["index"],
        ) {
            return Err(invalid());
        }
        let parts = match get(candidate, "content") {
            Some(content) => get(content, "parts")
                .and_then(json::array)
                .ok_or_else(invalid)?,
            None => &[],
        };
        let index = get(candidate, "index")
            .cloned()
            .unwrap_or(JsonValue::Number(candidate_index as f64));
        let mut candidate_metadata = json::object([("index", index.clone())]);
        image::copy(
            &mut candidate_metadata,
            candidate,
            &[
                "finishReason",
                "finishMessage",
                "safetyRatings",
                "citationMetadata",
                "groundingMetadata",
            ],
        );
        let mut part_metadata = Vec::new();
        for (part_index, part) in parts.iter().enumerate() {
            if !validate(part, &["text", "thoughtSignature"], &[], &[])
                || get(part, "thought")
                    .is_some_and(|thought| !matches!(thought, JsonValue::Bool(_)))
            {
                return Err(invalid());
            }
            let mut metadata = if let Some(inline) = get(part, "inlineData") {
                if string(inline, "mimeType").is_none() || string(inline, "data").is_none() {
                    return Err(invalid());
                }
                json::object([
                    ("type", s("inlineData")),
                    (
                        "mediaType",
                        get(inline, "mimeType").cloned().ok_or_else(invalid)?,
                    ),
                ])
            } else {
                let mut metadata = json::object([("type", s("text"))]);
                image::copy(&mut metadata, part, &["text"]);
                metadata
            };
            image::copy(&mut metadata, part, &["thought", "thoughtSignature"]);
            part_metadata.push(metadata);
            let Some(inline) = get(part, "inlineData") else {
                continue;
            };
            if get(part, "thought") == Some(&JsonValue::Bool(true)) {
                continue;
            }
            let data = image::decoded(
                string(inline, "data").ok_or_else(invalid)?,
                format!(
                    "Google Images candidate {candidate_index} part {part_index} contains invalid base64 data"
                ),
            )?;
            let mut metadata = json::object([
                ("candidateIndex", index.clone()),
                ("partIndex", JsonValue::Number(part_index as f64)),
            ]);
            image::copy(
                &mut metadata,
                candidate,
                &[
                    "finishReason",
                    "safetyRatings",
                    "citationMetadata",
                    "groundingMetadata",
                ],
            );
            image::copy(&mut metadata, part, &["thoughtSignature"]);
            images.push(Generated {
                media_type: string(inline, "mimeType").ok_or_else(invalid)?.clone(),
                data: Data::Bytes(data),
                provider_metadata: image::metadata("google", metadata),
            });
        }
        json::set(
            &mut candidate_metadata,
            "parts",
            JsonValue::Array(part_metadata),
        );
        details.push(candidate_metadata);
    }
    let mut metadata = pick(payload, &["modelVersion", "responseId", "promptFeedback"]);
    json::set(
        &mut metadata,
        "candidates",
        JsonValue::Array(details.clone()),
    );
    if images.is_empty() {
        let reasons = candidates
            .iter()
            .filter_map(|candidate| string(candidate, "finishReason"))
            .map(|reason| reason.as_str().unwrap_or(""))
            .collect::<Vec<_>>();
        let reasons = if reasons.is_empty() {
            String::new()
        } else {
            format!(" (finish reasons: {})", reasons.join(", "))
        };
        let mut error = Error::output(format!(
            "Google Images returned no final images{reasons}; inspect reason.providerMetadata.google for prompt feedback and candidate details"
        ));
        let mut metadata = pick(payload, &["promptFeedback"]);
        json::set(&mut metadata, "candidates", JsonValue::Array(details));
        error.provider_metadata = image::metadata("google", metadata).map(Box::new);
        return Err(error);
    }
    let usage = raw.map(|raw| {
        let count = |key| get(raw, key).and_then(json::number);
        let input = count("promptTokenCount");
        let reasoning = count("thoughtsTokenCount");
        let output = count("candidatesTokenCount").map(|output| output + reasoning.unwrap_or(0.0));
        Usage {
            input_tokens: input,
            output_tokens: output,
            non_cached_input_tokens: input
                .map(|input| (input - count("cachedContentTokenCount").unwrap_or(0.0)).max(0.0)),
            cache_read_input_tokens: count("cachedContentTokenCount"),
            reasoning_tokens: reasoning,
            total_tokens: count("totalTokenCount").or_else(|| sum_tokens(&[input, output])),
            provider_metadata: image::metadata("google", raw.clone()),
            ..Usage::default()
        }
    });
    Ok(Response {
        images,
        usage,
        provider_metadata: image::metadata("google", metadata),
    })
}
