use reqwest::header::{HeaderMap, HeaderValue};
use ycoding_ai::{
    Error,
    auth::{Auth, Credential, Input, Secret},
};

#[test]
fn auth_composition_and_fallback_retains_input() {
    let auth = Auth::header("x-api-key", Credential::value("")).or_else(Auth::custom(|input| {
        assert_eq!(input.url, "https://fixture.invalid/v1/messages");
        assert_eq!(input.body, "{}");
        assert_eq!(input.headers["x-existing"], "present");
        Ok(input.headers)
    }));
    let headers = auth
        .apply(Input {
            method: "POST",
            url: "https://fixture.invalid/v1/messages",
            body: "{}",
            headers: HeaderMap::from_iter([(
                "x-existing".parse().unwrap(),
                HeaderValue::from_static("present"),
            )]),
        })
        .unwrap();
    assert_eq!(headers["x-existing"], "present");
    let auth = Auth::bearer(Credential::value("private-fixture-token"))
        .and_then(Auth::Remove("authorization".into()))
        .and_then(Auth::header(
            "x-api-key",
            Credential::value("private-fixture-key"),
        ));
    let headers = auth
        .apply(Input {
            method: "POST",
            url: "https://fixture.invalid",
            body: "{}",
            headers: HeaderMap::new(),
        })
        .unwrap();
    assert!(!headers.contains_key("authorization"));
    assert_eq!(headers["x-api-key"], "private-fixture-key");
    assert!(headers["x-api-key"].is_sensitive());
    let error = Auth::header("x-key", Credential::value("private\nfixture-key"))
        .apply(Input {
            method: "POST",
            url: "https://fixture.invalid",
            body: "{}",
            headers: HeaderMap::new(),
        })
        .unwrap_err();
    assert!(!format!("{error:?} {error}").contains("private"));
    assert!(
        !format!(
            "{:?} {:?}",
            Secret::new("private-fixture-key"),
            Credential::value("private-fixture-key")
        )
        .contains("private-fixture-key")
    );
    let custom = Auth::custom(|_| Err(Error::invalid("signer refused")));
    assert_eq!(
        custom
            .apply(Input {
                method: "POST",
                url: "https://fixture.invalid",
                body: "{}",
                headers: HeaderMap::new()
            })
            .unwrap_err()
            .message,
        "signer refused"
    );
}
