use ycoding_core::resources::image::{Content, Error, Limits, normalize};

#[test]
fn normalization_bytes_dimensions_metadata_and_errors_match_npm_photon() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../src/resources/image/corpus.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let input = &case["content"];
        let content = Content {
            uri: input["uri"].as_str().unwrap().into(),
            name: input["name"].as_str().map(String::from),
            content: input["content"].as_str().unwrap().into(),
            mime: input["mime"].as_str().unwrap().into(),
        };
        let l = &case["limits"];
        let limits = Limits {
            auto_resize: l["autoResize"].as_bool().unwrap(),
            max_width: l["maxWidth"].as_u64().unwrap(),
            max_height: l["maxHeight"].as_u64().unwrap(),
            max_base64_bytes: l["maxBase64Bytes"].as_u64().unwrap() as usize,
        };
        let result = normalize(&content.uri, &content, limits);
        if let Some(output) = case.get("output") {
            let result = result.unwrap();
            assert_eq!(
                result.content,
                output["content"].as_str().unwrap(),
                "{} {:?}",
                content.uri,
                limits
            );
            assert_eq!(result.mime, output["mime"].as_str().unwrap());
            assert_eq!(result.uri, content.uri);
            assert_eq!(result.name, content.name);
            let decoded = photon_rs::PhotonImage::new_from_base64(&result.content);
            assert_eq!(decoded.get_width() as u64, case["width"].as_u64().unwrap());
            assert_eq!(
                decoded.get_height() as u64,
                case["height"].as_u64().unwrap()
            );
        } else {
            match result.unwrap_err() {
                Error::Decode { resource } => {
                    assert_eq!(case["error"]["kind"], "decode");
                    assert_eq!(resource, content.uri);
                }
                Error::Size {
                    resource,
                    width,
                    height,
                    bytes,
                    max_width,
                    max_height,
                    max_bytes,
                } => {
                    assert_eq!(case["error"]["kind"], "size");
                    assert_eq!(resource, content.uri);
                    assert_eq!(
                        serde_json::json!([width, height, bytes, max_width, max_height, max_bytes]),
                        serde_json::json!([
                            case["error"]["width"],
                            case["error"]["height"],
                            case["error"]["bytes"],
                            case["error"]["maxWidth"],
                            case["error"]["maxHeight"],
                            case["error"]["maxBytes"]
                        ])
                    );
                }
            }
        }
    }
}
