use ycoding_ai::{
    auth::{Auth, Credential},
    image::{Config, Data, Input, Kind, Model, Request},
    image_providers,
    provider_error::Reason,
};
use ycoding_schema::parse_json;
fn request(kind: Kind) -> Request {
    Request::new(
        Model::new(
            "future-model",
            kind,
            Config::new(Auth::bearer(Credential::value("fixture"))),
        ),
        "Draw a circle",
    )
}

#[test]
fn native_aliases_http_overlays_and_wire_order() {
    let mut request = request(Kind::OpenAI);
    request.options=parse_json(r#"{"n":2,"size":"2048x2048","quality":"future-quality","outputFormat":"jpeg","output_format":"avif","outputCompression":30,"output_compression":40,"background":"opaque","future_option":true}"#).unwrap();
    request.http.body = Some(
        parse_json(r#"{"output_format":"webp","output_compression":50,"future_option":"http"}"#)
            .unwrap(),
    );
    assert_eq!(
        String::from_utf8(request.model.prepare(&request).unwrap().body).unwrap(),
        r#"{"model":"future-model","prompt":"Draw a circle","output_format":"webp","output_compression":50,"n":2,"size":"2048x2048","quality":"future-quality","background":"opaque","future_option":"http"}"#
    );
    let response=request.model.parse(&request,&parse_json(r#"{"data":[{"b64_json":"AQID","url":"ignored","revised_prompt":"revised"},{"url":"https://example.test/image"}],"usage":{"input_tokens":0,"total_tokens":0}}"#).unwrap()).unwrap();
    assert_eq!(response.images[0].data, Data::Bytes(vec![1, 2, 3]));
    assert_eq!(response.images[0].media_type, "image/webp".into());
    assert_eq!(
        response.images[1].data,
        Data::Url("https://example.test/image".into())
    );
    let usage = response.usage.unwrap();
    assert_eq!(usage.input_tokens, Some(0.0));
    assert_eq!(usage.output_tokens, None);
    assert_eq!(usage.total_tokens, Some(0.0));
}

#[test]
fn base64_accepts_crlf_and_keeps_other_whitespace_invalid() {
    let request = request(Kind::OpenAI);
    assert_eq!(
        request
            .model
            .parse(
                &request,
                &parse_json(r#"{"data":[{"b64_json":"AQ\r\nID"}]}"#).unwrap()
            )
            .unwrap()
            .images[0]
            .data,
        Data::Bytes(vec![1, 2, 3])
    );
    assert_eq!(
        request
            .model
            .parse(
                &request,
                &parse_json(r#"{"data":[{"b64_json":"AQ ID"}]}"#).unwrap()
            )
            .unwrap_err()
            .reason,
        Reason::InvalidProviderOutput
    );
}

#[test]
fn lossless_image_references_survive_lowering() {
    let mut request = request(Kind::OpenAI);
    request.images = vec![Input::Url(ycoding_schema::LosslessString::from_utf16(
        "https://example.test/"
            .encode_utf16()
            .chain([0xd800])
            .collect(),
    ))];
    assert!(
        std::str::from_utf8(&request.model.prepare(&request).unwrap().body)
            .unwrap()
            .contains(r#"https://example.test/\ud800"#)
    );
}

#[test]
fn configured_and_request_http_auth_overlays_have_baseline_precedence() {
    let mut request = request(Kind::OpenAI);
    request.model.config.base_url = Some("https://example.test/v1/".into());
    request
        .model
        .config
        .headers
        .insert("x-default".into(), "configured".into());
    request
        .model
        .config
        .http
        .headers
        .insert("x-default".into(), "http-default".into());
    request.model.config.http.body =
        Some(parse_json(r#"{"labels":{"a":1},"quality":"configured"}"#).unwrap());
    request
        .model
        .config
        .http
        .query
        .insert("api-version".into(), "v1".into());
    request.http.query.insert("trace".into(), "1".into());
    request.http.body = Some(
        parse_json(
            r#"{"labels":{"b":2},"quality":"request","model":"deployment","prompt":"overlaid"}"#,
        )
        .unwrap(),
    );
    request
        .http
        .headers
        .insert("x-default".into(), "request".into());
    request.options = parse_json(r#"{"quality":"high"}"#).unwrap();
    request.model.config.auth = Auth::custom(|mut input| {
        assert_eq!(input.method, "POST");
        assert!(input.body.contains(r#""quality":"request""#));
        input.headers.insert(
            "x-custom-auth",
            reqwest::header::HeaderValue::from_static("custom"),
        );
        Ok(input.headers)
    });
    let prepared = request.model.prepare(&request).unwrap();
    assert_eq!(
        prepared.url.as_str(),
        "https://example.test/v1/images/generations?api-version=v1&trace=1"
    );
    assert_eq!(prepared.headers["x-default"], "request");
    assert_eq!(prepared.headers["x-custom-auth"], "custom");
    assert_eq!(
        std::str::from_utf8(&prepared.body).unwrap(),
        r#"{"model":"deployment","prompt":"overlaid","quality":"request","labels":{"a":1,"b":2}}"#
    );
}

#[test]
fn openai_json_edits_preserve_references_and_validate_masks() {
    let mut request = request(Kind::OpenAI);
    request.images = vec![
        Input::Url("https://example.test/source.png".into()),
        Input::FileId("file_123".into()),
    ];
    request.mask = Some(Input::FileId("file_mask".into()));
    let prepared = request.model.prepare(&request).unwrap();
    assert_eq!(prepared.url.path(), "/v1/images/edits");
    assert_eq!(
        std::str::from_utf8(&prepared.body).unwrap(),
        r#"{"model":"future-model","prompt":"Draw a circle","images":[{"image_url":"https://example.test/source.png"},{"file_id":"file_123"}],"mask":{"file_id":"file_mask"}}"#
    );
    request.images.clear();
    assert_eq!(
        request.model.prepare(&request).unwrap_err().message,
        "An OpenAI image mask requires at least one input image"
    );
    request.images = vec![Input::FileUri {
        uri: "uri".into(),
        media_type: "image/png".into(),
    }];
    request.mask = None;
    assert_eq!(
        request.model.prepare(&request).unwrap_err().reason,
        Reason::InvalidRequest
    );
    request.images = vec![Input::Bytes {
        data: vec![1, 2, 3],
        media_type: "image/png".into(),
    }];
    request.mask = Some(Input::FileUri {
        uri: "uri".into(),
        media_type: "image/png".into(),
    });
    assert_eq!(
        request.model.prepare(&request).unwrap_err().reason,
        Reason::InvalidRequest
    );
    request.mask = Some(Input::Url("data:image/png;base64,!bad".into()));
    assert_eq!(
        request.model.prepare(&request).unwrap_err().message,
        "Image data URL contains invalid base64 data"
    );
}

#[test]
fn multipart_edits_preserve_binary_inputs_and_protect_owned_fields() {
    let mut request = request(Kind::OpenAI);
    request.images = vec![
        Input::Bytes {
            data: vec![0, 255, 1],
            media_type: "image/png".into(),
        },
        Input::Url("data:image/jpeg;base64,BAUG".into()),
    ];
    request.mask = Some(Input::Bytes {
        data: vec![7, 8, 9],
        media_type: "image/png".into(),
    });
    request.options = parse_json(r#"{"quality":"high","future_option":true}"#).unwrap();
    request.http.body=Some(parse_json(r#"{"quality":"low","model":"corrupt","prompt":"corrupt","image":"corrupt","image[]":"corrupt","images":"corrupt","mask":"corrupt"}"#).unwrap());
    request
        .http
        .headers
        .insert("content-type".into(), "application/json".into());
    let prepared = request.model.prepare(&request).unwrap();
    assert!(prepared.url.path().ends_with("/images/edits"));
    assert!(
        prepared.headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("multipart/form-data; boundary=")
    );
    let text = String::from_utf8_lossy(&prepared.body);
    assert_eq!(text.matches("name=\"image[]\"").count(), 2);
    assert!(text.contains("name=\"mask\"; filename=\"mask\""));
    assert!(text.contains("name=\"quality\"\r\n\r\nlow"));
    assert!(!text.contains("corrupt"));
    assert!(prepared.body.windows(3).any(|bytes| bytes == [0, 255, 1]));
}

#[test]
fn response_schema_errors_and_unknown_usage_are_not_success_or_zero() {
    for kind in [Kind::OpenAI, Kind::Zai] {
        let request = request(kind);
        for payload in [r#"{}"#, r#"{"data":[]}"#, r#"{"data":[{"url":1}]}"#] {
            assert_eq!(
                request
                    .model
                    .parse(&request, &parse_json(payload).unwrap())
                    .unwrap_err()
                    .reason,
                Reason::InvalidProviderOutput
            );
        }
    }
    let request = request(Kind::OpenAI);
    for payload in [
        r#"{"data":[{"b64_json":"!bad"}]}"#,
        r#"{"data":[{}]}"#,
        r#"{"data":[{"url":null}]}"#,
        r#"{"data":[{"url":"x"}],"usage":{"input_tokens":null}}"#,
    ] {
        assert_eq!(
            request
                .model
                .parse(&request, &parse_json(payload).unwrap())
                .unwrap_err()
                .reason,
            Reason::InvalidProviderOutput
        );
    }
}

#[test]
fn resolved_provider_facades_and_zai_metadata_preserve_contracts() {
    let config = Config::new(Auth::bearer(Credential::value("fixture")));
    let zai = image_providers::zai("glm-image", config.clone());
    assert_eq!(zai.provider.0.as_str(), Some("zai"));
    let mut request = Request::new(zai, "test");
    assert_eq!(
        request.model.prepare(&request).unwrap().url.as_str(),
        "https://api.z.ai/api/paas/v4/images/generations"
    );
    assert_eq!(image_providers::openai("model", config).kind, Kind::OpenAI);
    request.images = vec![Input::Url("https://example.test/source".into())];
    assert_eq!(
        request.model.prepare(&request).unwrap_err().reason,
        Reason::InvalidRequest
    );
    request.images.clear();
    assert_eq!(
        request
            .model
            .parse(
                &request,
                &parse_json(r#"{"data":[{"url":"x"}],"created":9007199254740992}"#).unwrap()
            )
            .unwrap_err()
            .reason,
        Reason::InvalidProviderOutput
    );
    let response=request.model.parse(&request,&parse_json(r#"{"created":1760335349,"id":"generation-1","request_id":"request-1","data":[{"url":"x"}],"content_filter":[{"role":"future-role","level":4.5,"unknown":true}]}"#).unwrap()).unwrap();
    assert_eq!(response.provider_metadata,Some(parse_json(r#"{"zai":{"created":1760335349,"id":"generation-1","requestID":"request-1","contentFilter":[{"role":"future-role","level":4.5}]}}"#).unwrap()));
    assert!(response.usage.is_none());
}
