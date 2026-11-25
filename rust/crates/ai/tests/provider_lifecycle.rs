use ycoding_ai::{
    auth::{Input, Secret},
    bedrock_auth,
};

#[test]
fn mantle_and_converse_sign_distinct_services_with_the_same_credentials() {
    let credentials = || bedrock_auth::Credentials {
        region: "us-east-1".into(),
        access_key_id: Secret::new("fixture-key"),
        secret_access_key: Secret::new("fixture-secret"),
        session_token: None,
    };
    let sign = |service| {
        bedrock_auth::sigv4_service(Some(credentials()), service, || "20150830T123600Z".into())
            .apply(Input {
                method: "POST",
                url: "https://bedrock-mantle.us-east-1.api.aws/v1/responses",
                body: "{}",
                headers: Default::default(),
            })
            .unwrap()
    };
    let mantle = sign("bedrock-mantle");
    let converse = sign("bedrock");
    assert!(
        mantle["authorization"]
            .to_str()
            .unwrap()
            .contains("/us-east-1/bedrock-mantle/aws4_request")
    );
    assert!(
        converse["authorization"]
            .to_str()
            .unwrap()
            .contains("/us-east-1/bedrock/aws4_request")
    );
    assert_ne!(mantle["authorization"], converse["authorization"]);
    assert!(
        mantle["authorization"].to_str().unwrap().ends_with(
            "Signature=8188aae510b101a25785c83b3082d4d530a79e8e51361c45e9652e6020cb156a"
        )
    );
    assert!(
        converse["authorization"].to_str().unwrap().ends_with(
            "Signature=9ec1f924ef62f4967e7e940b61ed31f8d103f006e923cd27cc7fbd3f94eee0a1"
        )
    );
    assert!(mantle["authorization"].is_sensitive());
    let default = bedrock_auth::sigv4(Some(credentials()), || "20150830T123600Z".into())
        .apply(Input {
            method: "POST",
            url: "https://bedrock-mantle.us-east-1.api.aws/v1/responses",
            body: "{}",
            headers: Default::default(),
        })
        .unwrap();
    assert_eq!(converse, default);
}
