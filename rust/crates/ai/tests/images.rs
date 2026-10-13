use ycoding_ai::{
    auth::{Auth, Credential},
    image::{Config, Data, Input, Kind, Model, Request},
    image_providers,
    provider_error::Reason,
};
use ycoding_schema::{JsonValue, parse_json};

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
    let prepared = request.model.prepare(&request).unwrap();
    assert_eq!(
        String::from_utf8(prepared.body).unwrap(),
        r#"{"model":"future-model","prompt":"Draw a circle","output_format":"webp","output_compression":50,"n":2,"size":"2048x2048","quality":"future-quality","background":"opaque","future_option":"http"}"#
    );
    let response=request.model.parse(&request,&parse_json(r#"{"data":[{"b64_json":"AQID","url":"ignored","revised_prompt":"revised"},{"url":"https://example.test/image"}],"usage":{"input_tokens":0,"total_tokens":0}}"#).unwrap()).unwrap();
    assert_eq!(response.images[0].data, Data::Bytes(vec![1, 2, 3]));
    assert_eq!(response.images[0].media_type, "image/webp".into());
    assert_eq!(
        response.images[1].data,
        Data::Url("https://example.test/image".into())
    );
    assert_eq!(response.usage.as_ref().unwrap().input_tokens, Some(0.0));
    assert_eq!(response.usage.as_ref().unwrap().output_tokens, None);
    assert_eq!(response.usage.as_ref().unwrap().total_tokens, Some(0.0));
}

#[test]
fn base64_accepts_crlf_and_keeps_other_whitespace_invalid() {
    let request = request(Kind::OpenAI);
    let response = request
        .model
        .parse(
            &request,
            &parse_json(r#"{"data":[{"b64_json":"AQ\r\nID"}]}"#).unwrap(),
        )
        .unwrap();
    assert_eq!(response.images[0].data, Data::Bytes(vec![1, 2, 3]));
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
fn lossless_image_references_and_data_url_mime_types_survive_lowering() {
    let mut request = request(Kind::OpenAI);
    request.images = vec![Input::Url(ycoding_schema::LosslessString::from_utf16(
        "https://example.test/"
            .encode_utf16()
            .chain([0xd800])
            .collect(),
    ))];
    let body = request.model.prepare(&request).unwrap().body;
    assert!(
        std::str::from_utf8(&body)
            .unwrap()
            .contains(r#"https://example.test/\ud800"#)
    );
    request.model.kind = Kind::Google;
    request.images = vec![Input::Url(ycoding_schema::LosslessString::from_utf16(
        "data:image/"
            .encode_utf16()
            .chain([0xd800])
            .chain(";base64,AQID".encode_utf16())
            .collect(),
    ))];
    let body = request.model.prepare(&request).unwrap().body;
    assert!(
        std::str::from_utf8(&body)
            .unwrap()
            .contains(r#""mimeType":"image/\ud800","data":"AQID""#)
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
fn google_edit_parts_preserve_order_bytes_data_urls_and_file_uris() {
    let mut request = request(Kind::Google);
    request.images = vec![
        Input::Bytes {
            data: vec![1, 2, 3],
            media_type: "image/png".into(),
        },
        Input::Url("data:image/jpeg;base64,BA\r\nUG".into()),
        Input::FileUri {
            uri: "https://generativelanguage.googleapis.com/v1beta/files/123".into(),
            media_type: "image/webp".into(),
        },
    ];
    assert_eq!(
        std::str::from_utf8(&request.model.prepare(&request).unwrap().body).unwrap(),
        r#"{"contents":[{"role":"user","parts":[{"text":"Draw a circle"},{"inlineData":{"mimeType":"image/png","data":"AQID"}},{"inlineData":{"mimeType":"image/jpeg","data":"BAUG"}},{"fileData":{"mimeType":"image/webp","fileUri":"https://generativelanguage.googleapis.com/v1beta/files/123"}}]}],"generationConfig":{"responseModalities":["IMAGE"]}}"#
    );
}

#[test]
fn google_image_model_paths_use_url_usv_string_conversion() {
    let mut request = request(Kind::Google);
    request.model.id = ycoding_schema::LosslessString::from_utf16(
        "model-".encode_utf16().chain([0xd800]).collect(),
    );
    assert_eq!(
        request.model.prepare(&request).unwrap().url.path(),
        "/v1beta/models/model-%EF%BF%BD:generateContent"
    );
}

#[test]
fn image_inputs_are_ordered_and_provider_specific() {
    let mut request = request(Kind::Xai);
    request.images = vec![
        Input::Bytes {
            data: vec![1, 2, 3],
            media_type: "image/png".into(),
        },
        Input::Url("https://example.test/source".into()),
        Input::FileId("file_1".into()),
    ];
    request.options=parse_json(r#"{"aspectRatio":"16:9","aspect_ratio":"4:3","responseFormat":"url","response_format":"b64_json","resolution":"2k"}"#).unwrap();
    let prepared = request.model.prepare(&request).unwrap();
    assert_eq!(
        String::from_utf8(prepared.body).unwrap(),
        r#"{"model":"future-model","prompt":"Draw a circle","images":[{"url":"data:image/png;base64,AQID","type":"image_url"},{"url":"https://example.test/source","type":"image_url"},{"file_id":"file_1"}],"aspect_ratio":"4:3","response_format":"b64_json","resolution":"2k"}"#
    );
    request.images.truncate(1);
    let prepared = request.model.prepare(&request).unwrap();
    let body = parse_json(std::str::from_utf8(&prepared.body).unwrap()).unwrap();
    let JsonValue::Object(body) = body else {
        panic!()
    };
    assert!(body.get(&"image".into()).is_some());
    assert!(body.get(&"images".into()).is_none());
    request.model.kind = Kind::Zai;
    assert_eq!(
        request.model.prepare(&request).unwrap_err().reason,
        Reason::InvalidRequest
    );
    request.model.kind = Kind::Google;
    request.images = vec![Input::Url("https://example.test/source".into())];
    assert_eq!(
        request.model.prepare(&request).unwrap_err().reason,
        Reason::InvalidRequest
    );
    request.images = vec![Input::FileId("file_1".into())];
    assert_eq!(
        request.model.prepare(&request).unwrap_err().reason,
        Reason::InvalidRequest
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
fn google_nested_options_final_images_metadata_and_inclusive_usage() {
    let mut request = request(Kind::Google);
    request.options=parse_json(r#"{"aspectRatio":"16:9","imageSize":"2K","seed":42,"thinkingLevel":"HIGH","includeThoughts":true,"imageConfig":{"aspectRatio":"4:3","native":true}}"#).unwrap();
    request.http.body=Some(parse_json(r#"{"generationConfig":{"imageConfig":{"aspectRatio":"3:2"},"thinkingConfig":{"includeThoughts":false}}}"#).unwrap());
    let prepared = request.model.prepare(&request).unwrap();
    assert_eq!(
        String::from_utf8(prepared.body).unwrap(),
        r#"{"contents":[{"role":"user","parts":[{"text":"Draw a circle"}]}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":{"aspectRatio":"3:2","imageSize":"2K","native":true},"seed":42,"thinkingConfig":{"thinkingLevel":"HIGH","includeThoughts":false}}}"#
    );
    let response=request.model.parse(&request,&parse_json(r#"{"candidates":[{"index":7,"finishReason":"STOP","content":{"parts":[{"text":"planning","thought":true},{"inlineData":{"mimeType":"image/png","data":"BAD"},"thought":true},{"inlineData":{"mimeType":"image/jpeg","data":"AQID"},"thoughtSignature":"signature"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":7,"thoughtsTokenCount":3,"cachedContentTokenCount":8,"totalTokenCount":15,"serviceTier":"STANDARD"}}"#).unwrap()).unwrap();
    assert_eq!(response.images.len(), 1);
    assert_eq!(response.images[0].media_type, "image/jpeg".into());
    let usage = response.usage.unwrap();
    assert_eq!(usage.output_tokens, Some(10.0));
    assert_eq!(usage.cache_read_input_tokens, Some(8.0));
    assert_eq!(usage.non_cached_input_tokens, Some(0.0));
    assert_eq!(usage.total_tokens, Some(15.0));
    assert_eq!(response.images[0].provider_metadata,Some(parse_json(r#"{"google":{"candidateIndex":7,"partIndex":2,"finishReason":"STOP","thoughtSignature":"signature"}}"#).unwrap()));
    let error=request.model.parse(&request,&parse_json(r#"{"candidates":[{"finishReason":"IMAGE_SAFETY","content":{"parts":[{"text":"blocked"}]}}],"promptFeedback":{"blockReason":"SAFETY"}}"#).unwrap()).unwrap_err();
    assert_eq!(error.reason, Reason::InvalidProviderOutput);
    assert!(error.message.contains("finish reasons: IMAGE_SAFETY"));
    assert!(error.provider_metadata.is_some());
}

#[test]
fn response_schema_errors_and_unknown_usage_are_not_success_or_zero() {
    for kind in [Kind::OpenAI, Kind::Xai, Kind::Zai, Kind::Google] {
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
    let xai = request(Kind::Xai);
    for usage in ["null", "[]", "42"] {
        let response=xai.model.parse(&xai,&parse_json(&format!(r#"{{"data":[{{"url":"https://example.test/image","b64_json":null,"mime_type":null}}],"usage":{usage}}}"#)).unwrap()).unwrap();
        assert!(response.usage.is_none());
        assert_eq!(
            response.images[0].media_type,
            "application/octet-stream".into()
        );
    }
    let response=xai.model.parse(&xai,&parse_json(r#"{"data":[{"b64_json":"AQID","mime_type":"image/png","revised_prompt":null}],"usage":{"num_images":2}}"#).unwrap()).unwrap();
    assert_eq!(response.usage.unwrap().input_tokens, None);
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
fn resolved_provider_facades_preserve_auth_endpoint_and_http() {
    let config = Config::new(Auth::bearer(Credential::value("fixture")));
    let zai = image_providers::zai("glm-image", config.clone());
    assert_eq!(zai.provider.0.as_str(), Some("zai"));
    let request = Request::new(zai, "test");
    assert_eq!(
        request.model.prepare(&request).unwrap().url.as_str(),
        "https://api.z.ai/api/paas/v4/images/generations"
    );
    let openai = image_providers::openai("model", config.clone());
    assert_eq!(openai.kind, Kind::OpenAI);
    assert_eq!(
        image_providers::google("model", config.clone()).kind,
        Kind::Google
    );
    assert_eq!(image_providers::xai("model", config).kind, Kind::Xai);
}

#[test]
fn zai_created_is_a_safe_integer_and_metadata_is_schema_projected() {
    let request = request(Kind::Zai);
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
