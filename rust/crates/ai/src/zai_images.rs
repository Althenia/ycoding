use crate::{
    Error,
    image::{self, Config, Data, Generated, Kind, Model, Request, Response},
    json::{self, get},
    llm::HttpOptions,
    openai_shared::{pick, string, validate},
};
use ycoding_schema::{JsonValue, LosslessString};
pub const DEFAULT_BASE_URL: &str = "https://api.z.ai/api/paas/v4";
pub fn model(id: impl Into<LosslessString>, config: Config) -> Model {
    Model::new(id, Kind::Zai, config)
}
pub(crate) fn lower(request: &Request, http: &HttpOptions) -> Result<JsonValue, Error> {
    if !request.images.is_empty() {
        return Err(Error::invalid(
            "Z.ai hosted image generation does not support image inputs",
        ));
    }
    Ok(image::body(
        request,
        http,
        image::native(&request.options, &[("userID", "user_id")], &[]),
        json::empty(),
    ))
}
pub fn parse(payload: &JsonValue) -> Result<Response, Error> {
    let invalid = || Error::output("Z.ai Images returned an invalid response");
    if !validate(payload, &["id", "request_id"], &[], &["created"])
        || get(payload, "created")
            .and_then(json::number)
            .is_some_and(|value| {
                !value.is_finite() || value.fract() != 0.0 || value.abs() > 9_007_199_254_740_991.0
            })
    {
        return Err(invalid());
    }
    if let Some(filter) = get(payload, "content_filter")
        && !json::array(filter).is_some_and(|values| {
            values
                .iter()
                .all(|value| validate(value, &["role"], &[], &["level"]))
        })
    {
        return Err(invalid());
    }
    let data = get(payload, "data")
        .and_then(json::array)
        .ok_or_else(invalid)?;
    let images = data
        .iter()
        .map(|item| {
            Ok(Generated {
                media_type: "application/octet-stream".into(),
                data: Data::Url(string(item, "url").ok_or_else(invalid)?.clone()),
                provider_metadata: None,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    if images.is_empty() {
        return Err(Error::output("Z.ai Images returned no images"));
    }
    let mut metadata = pick(payload, &["created", "id"]);
    if let Some(value) = get(payload, "request_id") {
        json::set(&mut metadata, "requestID", value.clone());
    }
    if let Some(JsonValue::Array(values)) = get(payload, "content_filter") {
        json::set(
            &mut metadata,
            "contentFilter",
            JsonValue::Array(
                values
                    .iter()
                    .map(|value| pick(value, &["role", "level"]))
                    .collect(),
            ),
        );
    }
    Ok(Response {
        images,
        usage: None,
        provider_metadata: image::metadata("zai", metadata),
    })
}
