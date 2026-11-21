use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_core::resources::auth::bedrock::{
    Credentials, Options, region, resolve, resolve_local,
};
use ycoding_schema::DomainDecode;

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(25), work)
        .await
        .expect("bedrock chain test exceeded 25 seconds")
}

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).into(), (*value).into()))
        .collect()
}

fn offline() -> Options {
    Options {
        imds_endpoint: Some("http://127.0.0.1:1".into()),
        timeout: Duration::from_millis(300),
        ..Options::default()
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

fn scratch(prefix: &str) -> std::path::PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "ycoding-bedrock-chain-{}-{}-{}",
        prefix,
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn home_with(prefix: &str, credentials: &str, config: &str) -> std::path::PathBuf {
    let home = scratch(prefix);
    let dot = home.join(".aws");
    std::fs::create_dir_all(&dot).unwrap();
    std::fs::write(dot.join("credentials"), credentials).unwrap();
    std::fs::write(dot.join("config"), config).unwrap();
    home
}

#[derive(Clone, Debug)]
struct Captured {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

async fn loopback(
    script: Vec<(u16, String)>,
    seen: Arc<Mutex<Vec<Captured>>>,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        for (status, payload) in script {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let boundary = loop {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
                if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break boundary + 4;
                }
            };
            let length = {
                let header = std::str::from_utf8(&request[..boundary]).unwrap();
                header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0)
            };
            while request.len() - boundary < length {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            let header = std::str::from_utf8(&request[..boundary])
                .unwrap()
                .to_owned();
            let mut parts = header.lines();
            let start = parts.next().unwrap();
            let mut method = start.split_whitespace();
            let captured = Captured {
                method: method.next().unwrap().into(),
                path: method.next().unwrap().into(),
                headers: parts
                    .filter_map(|line| {
                        line.split_once(':').map(|(key, value)| {
                            (key.trim().to_ascii_lowercase(), value.trim().into())
                        })
                    })
                    .collect(),
                body: std::str::from_utf8(&request[boundary..boundary + length])
                    .unwrap()
                    .into(),
            };
            seen.lock().unwrap().push(captured);
            let response = format!(
                "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (address, task)
}

fn seen() -> Arc<Mutex<Vec<Captured>>> {
    Arc::new(Mutex::new(Vec::new()))
}

fn access(credentials: &Credentials) -> (&str, Option<&str>) {
    (
        &credentials.access_key_id,
        credentials.session_token.as_deref(),
    )
}

#[tokio::test]
async fn static_env_credentials_win_with_session_token() {
    bounded(async {
        let credentials = resolve(
            &env(&[
                ("AWS_ACCESS_KEY_ID", "ENVK"),
                ("AWS_SECRET_ACCESS_KEY", "ENVS"),
                ("AWS_SESSION_TOKEN", "ENVT"),
                ("AWS_PROFILE", "poison"),
            ]),
            &offline(),
            &http(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(access(&credentials), ("ENVK", Some("ENVT")));
        assert_eq!(credentials.secret_access_key, "ENVS");
    })
    .await;
}

#[tokio::test]
async fn partial_env_falls_through_to_nothing_offline() {
    bounded(async {
        let home = scratch("partial-env");
        let options = Options {
            home: Some(home.clone()),
            ..offline()
        };
        assert!(
            resolve(&env(&[("AWS_ACCESS_KEY_ID", "lonely")]), &options, &http())
                .await
                .unwrap()
                .is_none()
        );
        std::fs::remove_dir_all(&home).unwrap();
    })
    .await;
}

#[tokio::test]
async fn shared_ini_profile_supplies_static_credentials() {
    bounded(async {
        let home = home_with(
            "ini",
            "[default]\naws_access_key_id = DEFAULTK\naws_secret_access_key = DEFAULTS\n[myprofile]\naws_access_key_id = FILEK\naws_secret_access_key = FILES\n",
            "",
        );
        let options = Options {
            home: Some(home.clone()),
            ..offline()
        };
        let credentials = resolve(&env(&[("AWS_PROFILE", "myprofile")]), &options, &http())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(access(&credentials), ("FILEK", None));
        let fallback = resolve(&env(&[]), &options, &http())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(access(&fallback), ("DEFAULTK", None));
        std::fs::remove_dir_all(&home).unwrap();
    })
    .await;
}

#[tokio::test]
async fn config_file_profile_prefix_and_region_override_work() {
    bounded(async {
        let home = home_with(
            "config-prefix",
            "",
            "[profile myprofile]\naws_access_key_id = CONFK\naws_secret_access_key = CONFS\nregion = eu-west-1\n",
        );
        let options = Options {
            home: Some(home.clone()),
            ..offline()
        };
        let credentials = resolve_local(&env(&[("AWS_PROFILE", "myprofile")]), &options)
            .unwrap()
            .unwrap();
        assert_eq!(access(&credentials), ("CONFK", None));
        assert_eq!(region(None, &env(&[]), "https://bedrock-runtime.eu-west-1.amazonaws.com"), "eu-west-1");
        std::fs::remove_dir_all(&home).unwrap();
    })
    .await;
}

#[tokio::test]
async fn credential_process_output_is_parsed_locally() {
    bounded(async {
        let home = home_with(
            "process",
            "[process]\ncredential_process = printf '{\"AccessKeyId\":\"PROCK\",\"SecretAccessKey\":\"PROCS\",\"SessionToken\":\"PROCT\",\"Expiration\":\"2030-01-01T00:00:00Z\"}'\n",
            "",
        );
        let options = Options {
            home: Some(home.clone()),
            ..offline()
        };
        let credentials = resolve_local(&env(&[("AWS_PROFILE", "process")]), &options)
            .unwrap()
            .unwrap();
        assert_eq!(access(&credentials), ("PROCK", Some("PROCT")));
        assert!(credentials.expires_at.is_some());
        std::fs::remove_dir_all(&home).unwrap();
    })
    .await;
}

#[tokio::test]
async fn container_full_uri_forwards_its_authorization_token() {
    bounded(async {
        let seen = seen();
        let (endpoint, task) = loopback(
            vec![(
                200,
                r#"{"AccessKeyId":"CONTK","SecretAccessKey":"CONTS","Token":"CONTT","Expiration":"2030-01-01T00:00:00Z"}"#.into(),
            )],
            seen.clone(),
        )
        .await;
        let credentials = resolve(
            &env(&[
                ("AWS_CONTAINER_CREDENTIALS_FULL_URI", &endpoint),
                ("AWS_CONTAINER_AUTHORIZATION_TOKEN", "container-secret"),
            ]),
            &Options {
                timeout: Duration::from_secs(5),
                ..Options::default()
            },
            &http(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(access(&credentials), ("CONTK", Some("CONTT")));
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].headers["authorization"], "container-secret");
        task.await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn imdsv2_token_is_fetched_before_role_credentials() {
    bounded(async {
        let seen = seen();
        let (endpoint, task) = loopback(
            vec![
                (200, "imds-token".into()),
                (200, "analysis-role".into()),
                (
                    200,
                    r#"{"AccessKeyId":"IMDSK","SecretAccessKey":"IMDSS","Token":"IMDST"}"#.into(),
                ),
            ],
            seen.clone(),
        )
        .await;
        let credentials = resolve(
            &env(&[]),
            &Options {
                home: None,
                imds_endpoint: Some(endpoint),
                timeout: Duration::from_secs(5),
                ..Options::default()
            },
            &http(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(access(&credentials), ("IMDSK", Some("IMDST")));
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].method, "PUT");
        assert_eq!(
            requests[0].headers["x-aws-ec2-metadata-token-ttl-seconds"],
            "21600"
        );
        assert_eq!(
            requests[1].path,
            "/latest/meta-data/iam/security-credentials/"
        );
        assert_eq!(
            requests[2].headers["x-aws-ec2-metadata-token"],
            "imds-token"
        );
        task.await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn web_identity_assumes_its_role_through_sts() {
    bounded(async {
        let token = scratch("wit-token");
        std::fs::write(token.join("token"), "web-identity-jwt").unwrap();
        let seen_requests = seen();
        let (endpoint, task) = loopback(
            vec![(
                200,
                "<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>WIK</AccessKeyId><SecretAccessKey>WIS</SecretAccessKey><SessionToken>WIT</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>".into(),
            )],
            seen_requests.clone(),
        )
        .await;
        let credentials = resolve(
            &env(&[
                ("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/analysis"),
                ("AWS_WEB_IDENTITY_TOKEN_FILE", token.join("token").to_str().unwrap()),
            ]),
            &Options {
                sts_endpoint: Some(endpoint),
                timeout: Duration::from_secs(5),
                ..Options::default()
            },
            &http(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(access(&credentials), ("WIK", Some("WIT")));
        let requests = seen_requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].body.contains("AssumeRoleWithWebIdentity"));
        assert!(requests[0].body.contains("web-identity-jwt"));
        task.await.unwrap();
        std::fs::remove_dir_all(&token).unwrap();
    })
    .await;
}

#[tokio::test]
async fn sso_profile_reads_the_cached_token_and_calls_get_role_credentials() {
    bounded(async {
        let home = home_with(
            "sso",
            "",
            "[sso-session myss]\nsso_start_url = https://example.awsapps.com/start\nsso_region = us-east-1\n[profile ssoprofile]\nsso_session = myss\nsso_account_id = 123456789012\nsso_role_name = AnalysisRole\n",
        );
        let cache = home.join(".aws/sso/cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(
            cache.join(format!(
                "{}.json",
                ycoding_core::resources::auth::bedrock::sso_cache_name(
                    "https://example.awsapps.com/start"
                )
            )),
            r#"{"accessToken":"sso-token","expiresAt":"2030-01-01T00:00:00Z"}"#,
        )
        .unwrap();
        let seen_requests = seen();
        let (endpoint, task) = loopback(
            vec![(
                200,
                r#"{"roleCredentials":{"accessKeyId":"SSOK","secretAccessKey":"SSOS","sessionToken":"SSOT","expiration":1893456000000}}"#.into(),
            )],
            seen_requests.clone(),
        )
        .await;
        let credentials = resolve(
            &env(&[("AWS_PROFILE", "ssoprofile")]),
            &Options {
                home: Some(home.clone()),
                sso_endpoint: Some(endpoint),
                timeout: Duration::from_secs(5),
                ..Options::default()
            },
            &http(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(access(&credentials), ("SSOK", Some("SSOT")));
        let requests = seen_requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].headers["x-amz-sso_bearer_token"], "sso-token");
        task.await.unwrap();
        std::fs::remove_dir_all(&home).unwrap();
    })
    .await;
}

#[tokio::test]
async fn region_prefers_setting_then_env_then_endpoint_then_default() {
    bounded(async {
        assert_eq!(
            region(
                Some("ap-south-1"),
                &env(&[]),
                "https://bedrock-runtime.us-east-1.amazonaws.com"
            ),
            "ap-south-1"
        );
        assert_eq!(
            region(
                None,
                &env(&[("AWS_REGION", "eu-central-1")]),
                "https://bedrock-runtime.us-east-1.amazonaws.com"
            ),
            "eu-central-1"
        );
        assert_eq!(
            region(
                None,
                &env(&[]),
                "https://bedrock-runtime.eu-west-1.amazonaws.com"
            ),
            "eu-west-1"
        );
        assert_eq!(
            region(
                None,
                &env(&[]),
                "https://bedrock-runtime.us-east-1.amazonaws.com"
            ),
            "us-east-1"
        );
        assert_eq!(
            region(None, &env(&[]), "https://proxy.example"),
            "us-east-1"
        );
    })
    .await;
}

const SCRUBBED: [&str; 15] = [
    "HOME",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
];

#[test]
fn route_signs_with_shared_file_credentials_when_no_key_is_configured() {
    struct Restore(Vec<(String, Option<String>)>);
    impl Drop for Restore {
        fn drop(&mut self) {
            for (key, value) in &self.0 {
                match value {
                    Some(value) => unsafe { std::env::set_var(key, value) },
                    None => unsafe { std::env::remove_var(key) },
                }
            }
        }
    }
    let restore = Restore(
        SCRUBBED
            .iter()
            .map(|key| ((*key).into(), std::env::var(key).ok()))
            .collect(),
    );
    let home = home_with(
        "route",
        "[default]\naws_access_key_id = FILEK\naws_secret_access_key = FILES\n",
        "",
    );
    for key in SCRUBBED {
        unsafe { std::env::remove_var(key) };
    }
    unsafe { std::env::set_var("HOME", &home) };
    let mut model = ycoding_core::resources::catalog::models_dev::normalize(
        &ycoding_schema::parse_json(include_str!(
            "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
        ))
        .unwrap(),
    )
    .unwrap()[0]
        .models[0]
        .clone();
    model.package = Some("@ycoding-ai/ai/providers/amazon-bedrock".into());
    model.model_id = "claude".into();
    model.provider_id = ycoding_schema::provider::Id("fixture".into());
    model.settings = Some(
        ycoding_schema::provider::Settings::decode(
            &ycoding_schema::parse_json(r#"{"baseURL":"http://127.0.0.1:1","region":"us-west-2"}"#)
                .unwrap(),
        )
        .unwrap(),
    );
    let resolved = ycoding_core::resources::model::from_catalog_model(&model, None).unwrap();
    let headers = resolved
        .route
        .auth
        .apply(ycoding_ai::auth::Input {
            method: "POST",
            url: "http://127.0.0.1:1/model/claude/converse-stream",
            body: "{}",
            headers: reqwest::header::HeaderMap::new(),
        })
        .unwrap();
    let header = headers["authorization"].to_str().unwrap().to_owned();
    drop(restore);
    std::fs::remove_dir_all(&home).unwrap();
    assert!(header.starts_with("AWS4-HMAC-SHA256 Credential=FILEK/"));
    assert!(header.contains("/us-west-2/bedrock/aws4_request"));
}
