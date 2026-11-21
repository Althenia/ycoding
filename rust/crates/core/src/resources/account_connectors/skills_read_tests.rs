use super::skills_read::{self, Input, Reader};
use crate::resources::{auth, config, credential};
use crate::tools::policy::permissions::Permissions;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};
use ycoding_schema::{JsonValue, LosslessString, parse_json, permission};

mod policy_fixture {
    use crate as ycoding_core;
    include!("../../../tests/policy_fixture.rs");
}

const LIST: &str = r#"{"hazelnuts":[{"id":"skill fixture/1","private_instructions":"private-list-value"},{"id":"second-skill"}],"next_cursor":"private-cursor-value"}"#;
const DETAIL: &str = r#"{"id":"skill fixture/1","name":"private-detail-value","permissions":{}}"#;

struct Fixture {
    root: PathBuf,
    configuration: Arc<config::Configuration>,
    policy: policy_fixture::Fixture,
    permissions: Permissions,
    credentials: credential::Service,
    registry: auth::integration::Registry,
    registration: auth::integration::Registration,
    requests: Arc<Mutex<Vec<reqwest::Request>>>,
    first: credential::Info,
    second: credential::Info,
    session: ycoding_schema::session::Id,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-account-skills-{}",
            crate::cca::encoding::uuid_v4()
        ));
        std::fs::create_dir_all(root.join("project")).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let configuration = Arc::new(
            config::Configuration::load(config::LoadOptions {
                directory: root.join("project"),
                roots: config::Roots::development(&root).unwrap(),
                project: true,
                file: None,
                content: None,
                env: BTreeMap::new(),
            })
            .unwrap(),
        );
        let policy = policy_fixture::Fixture::default();
        policy.rules.lock().unwrap().push(permission::Rule {
            action: "chatgpt_account_skills_read".into(),
            resource: "*".into(),
            effect: permission::Effect("allow".into()),
        });
        let session = policy.session("ses_account_skills", None, 0, false, None);
        let permissions = policy.permissions();
        let credentials = credential::Service::new(policy.store.client());
        let first = credentials
            .create(
                "credential-skills-a".into(),
                "openai".into(),
                Some("fixture-a".into()),
                secret("synthetic-access-a", "synthetic-account-a"),
                1,
            )
            .await
            .unwrap();
        let second = credentials
            .create(
                "credential-skills-b".into(),
                "openai".into(),
                Some("fixture-b".into()),
                secret("synthetic-access-b", "synthetic-account-b"),
                2,
            )
            .await
            .unwrap();
        credentials.activate(first.id().clone(), 3).await.unwrap();
        let registry = auth::integration::Registry::new(credentials.clone(), BTreeMap::new());
        let registration = registry
            .transform(|draft| draft.update("openai".into(), |_| {}))
            .unwrap();
        let fixture = Self {
            root,
            configuration,
            policy,
            permissions,
            credentials,
            registry,
            registration,
            requests: Arc::new(Mutex::new(vec![])),
            first,
            second,
            session,
        };
        fixture.settings(r#"{"enabled":true,"profile":"fixture-a"}"#);
        fixture
    }

    fn settings(&self, settings: &str) {
        std::fs::write(
            self.root.join("project/ycoding.json"),
            format!(r#"{{"account_connectors":{{"chatgpt":{settings}}}}}"#),
        )
        .unwrap();
    }

    fn input(&self) -> Input {
        Input {
            session_id: self.session.clone(),
            agent: "test".into(),
            profile: Some("fixture-a".into()),
            id: None,
        }
    }

    fn reader(&self, exchange: skills_read::Exchange) -> Reader {
        Reader::with_exchange(
            self.configuration.clone(),
            self.registry.clone(),
            self.permissions.clone(),
            exchange,
        )
        .unwrap()
    }

    fn responses(&self, list: &str, detail: &str, status: u16) -> Reader {
        let requests = self.requests.clone();
        let (list, detail) = (list.to_owned(), detail.to_owned());
        self.reader(Arc::new(move |request| {
            let body = if request.url().path() == "/backend-api/hazelnuts" {
                list.clone()
            } else {
                detail.clone()
            };
            requests.lock().unwrap().push(request);
            Box::pin(async move { Ok(response(status, body.into_bytes())) })
        }))
    }

    fn calls(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    fn rule(&self, effect: &str) {
        self.policy.rules.lock().unwrap()[0].effect = permission::Effect(effect.into());
    }

    fn asking(&self) -> (Permissions, Arc<Notify>) {
        self.rule("ask");
        let asked = Arc::new(Notify::new());
        let publisher = self.policy.publisher();
        let notify = asked.clone();
        let permissions = Permissions::new(
            self.policy.authority(),
            ycoding_schema::project_id::ProjectId::new("project").unwrap(),
            Arc::new(move |event| {
                let is_asked = event.type_ == "permission.asked";
                publisher(event)?;
                if is_asked {
                    notify.notify_one();
                }
                Ok(())
            }),
        );
        (permissions, asked)
    }

    async fn finish(self) {
        self.permissions.shutdown();
        self.registration.dispose().unwrap();
        self.registry.shutdown().await.unwrap();
        self.credentials.shutdown().await.unwrap();
        self.policy.store.shutdown().unwrap();
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

fn secret(access: &str, account: &str) -> ycoding_store::resources::Secret {
    ycoding_store::resources::Secret::new(
        parse_json(&format!(
            r#"{{"type":"oauth","methodID":"chatgpt-browser","access":"{access}","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{{"accountID":"{account}"}}}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

fn response(status: u16, body: Vec<u8>) -> reqwest::Response {
    reqwest::Response::from(
        axum::http::Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(body)
            .unwrap(),
    )
}

fn strings(values: &[&str]) -> Vec<LosslessString> {
    values.iter().map(|value| (*value).into()).collect()
}

#[tokio::test]
async fn proof_uses_fixed_gets_identity_headers_encoded_id_and_no_private_values() {
    let fixture = Fixture::new().await;
    let proof = fixture
        .responses(LIST, DETAIL, 200)
        .read(fixture.input())
        .await
        .unwrap();
    assert_eq!(proof.status, 200);
    assert_eq!(proof.count, 2);
    assert!(proof.has_next);
    assert_eq!(proof.keys, strings(&["hazelnuts", "next_cursor"]));
    assert_eq!(proof.pagination_keys, strings(&["next_cursor"]));
    let detail = proof.detail.as_ref().unwrap();
    assert_eq!(detail.status, 200);
    assert_eq!(detail.keys, strings(&["id", "name", "permissions"]));
    let exposed = format!("{proof:?}");
    for private in [
        "skill fixture/1",
        "private-list-value",
        "private-detail-value",
        "private-cursor-value",
        "synthetic-account-a",
        "synthetic-access-a",
    ] {
        assert!(!exposed.contains(private));
    }
    {
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].url().as_str(),
            "https://chatgpt.com/backend-api/hazelnuts?scope=installed&include_permissions=true"
        );
        assert_eq!(
            requests[1].url().as_str(),
            "https://chatgpt.com/backend-api/hazelnuts/skill%20fixture%2F1?include_permissions=true"
        );
        for request in requests.iter() {
            assert_eq!(request.method(), reqwest::Method::GET);
            assert_eq!(
                request.headers()["authorization"],
                "Bearer synthetic-access-a"
            );
            assert_eq!(
                request.headers()["ChatGPT-Account-Id"],
                "synthetic-account-a"
            );
            for (name, value) in ycoding_ai::openai_codex::headers() {
                assert_eq!(request.headers()[name], value);
            }
            assert_eq!(request.timeout(), Some(&Duration::from_secs(30)));
        }
    }
    fixture.finish().await;
}

#[tokio::test]
async fn empty_list_and_precise_pagination_metadata_never_fetch_detail_or_cursor() {
    for (body, expected, keys) in [
        (r#"{"hazelnuts":[]}"#, false, vec![]),
        (
            r#"{"hazelnuts":[],"cursor":"private-cursor-value"}"#,
            false,
            vec!["cursor"],
        ),
        (
            r#"{"hazelnuts":[],"has_more":true,"next_cursor":"","cursor":"x"}"#,
            true,
            vec!["has_more", "next_cursor", "cursor"],
        ),
        (
            r#"{"hazelnuts":[],"has_more":false,"next_cursor":"private-cursor-value"}"#,
            true,
            vec!["has_more", "next_cursor"],
        ),
        (
            r#"{"hazelnuts":[],"has_more":"true","next_cursor":3}"#,
            false,
            vec!["has_more", "next_cursor"],
        ),
    ] {
        let fixture = Fixture::new().await;
        let proof = fixture
            .responses(body, DETAIL, 200)
            .read(fixture.input())
            .await
            .unwrap();
        assert_eq!(proof.count, 0);
        assert_eq!(proof.has_next, expected);
        assert_eq!(proof.pagination_keys, strings(&keys));
        assert!(proof.detail.is_none());
        assert_eq!(fixture.calls(), 1);
        assert!(!format!("{proof:?}").contains("private-cursor-value"));
        fixture.finish().await;
    }
}

#[tokio::test]
async fn explicit_id_must_be_listed_and_default_uses_the_first_returned_id() {
    let fixture = Fixture::new().await;
    let mut input = fixture.input();
    input.id = Some("not-listed".into());
    let error = fixture
        .responses(LIST, DETAIL, 200)
        .read(input)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), "unlisted_skill_id");
    assert_eq!(fixture.calls(), 1);
    let mut input = fixture.input();
    input.id = Some("second-skill".into());
    fixture
        .responses(LIST, r#"{"id":"second-skill"}"#, 200)
        .read(input)
        .await
        .unwrap();
    assert_eq!(
        fixture.requests.lock().unwrap()[2].url().path(),
        "/backend-api/hazelnuts/second-skill"
    );
    fixture.finish().await;
}

#[tokio::test]
async fn invalid_detail_ids_and_malformed_or_mismatched_payloads_are_sanitized() {
    for id in ["uploads", "draft", ".", ".."] {
        let fixture = Fixture::new().await;
        let list = format!(r#"{{"hazelnuts":[{{"id":"{id}"}}]}}"#);
        let error = fixture
            .responses(&list, DETAIL, 200)
            .read(fixture.input())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "account_skills_read");
        assert_eq!(fixture.calls(), 1);
        fixture.finish().await;
    }
    for body in [
        "private-not-json",
        "[]",
        r#"{"hazelnuts":{}}"#,
        r#"{"hazelnuts":[{"id":""}]}"#,
        r#"{"hazelnuts":[{}]}"#,
    ] {
        let fixture = Fixture::new().await;
        let error = fixture
            .responses(body, DETAIL, 200)
            .read(fixture.input())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "account_skills_read");
        assert!(!format!("{error:?}").contains("private-not-json"));
        assert_eq!(fixture.calls(), 1);
        fixture.finish().await;
    }
    let fixture = Fixture::new().await;
    let error = fixture
        .responses(LIST, r#"{"id":"private-other-id"}"#, 200)
        .read(fixture.input())
        .await
        .unwrap_err();
    assert_eq!(error.kind(), "account_skills_read");
    assert!(!format!("{error:?}").contains("private-other-id"));
    assert_eq!(fixture.calls(), 2);
    fixture.finish().await;
}

#[tokio::test]
async fn configuration_profile_and_oauth_failures_prevent_all_dispatch() {
    for settings in [
        r#"{}"#,
        r#"{"enabled":false}"#,
        r#"{"enabled":true,"profile":"fixture-b"}"#,
    ] {
        let fixture = Fixture::new().await;
        fixture.settings(settings);
        let error = fixture
            .responses(LIST, DETAIL, 200)
            .read(fixture.input())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "account_skills_configuration");
        assert_eq!(fixture.calls(), 0);
        fixture.finish().await;
    }
    for value in [
        r#"{"type":"key","key":"synthetic-key"}"#,
        r#"{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-access","refresh":"synthetic-refresh","expires":9007199254740000}"#,
    ] {
        let fixture = Fixture::new().await;
        fixture
            .credentials
            .update(
                fixture.first.id().clone(),
                None,
                Some(ycoding_store::resources::Secret::new(parse_json(value).unwrap()).unwrap()),
                4,
            )
            .await
            .unwrap();
        let error = fixture
            .responses(LIST, DETAIL, 200)
            .read(fixture.input())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "account_skills_configuration");
        assert_eq!(fixture.calls(), 0);
        assert!(!format!("{error:?}").contains("synthetic-key"));
        fixture.finish().await;
    }
}

#[tokio::test]
async fn inactive_query_profile_without_configured_profile_is_rejected_before_dispatch() {
    let fixture = Fixture::new().await;
    fixture.settings(r#"{"enabled":true}"#);
    let integration = fixture.registry.get(&"openai".into()).unwrap().unwrap();
    assert!(integration.connections.iter().any(|value| matches!(
        value,
        ycoding_schema::connection::Info::Credential(value)
            if &value.label == fixture.second.label() && !value.active
    )));
    let mut input = fixture.input();
    input.profile = Some(fixture.second.label().clone());
    let error = fixture
        .responses(LIST, DETAIL, 200)
        .read(input)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), "account_skills_configuration");
    assert_eq!(fixture.calls(), 0);
    fixture.finish().await;
}

#[tokio::test]
async fn configured_profile_wins_but_active_profile_and_generation_changes_fail_closed() {
    let fixture = Fixture::new().await;
    fixture
        .credentials
        .activate(fixture.second.id().clone(), 4)
        .await
        .unwrap();
    let mut input = fixture.input();
    input.profile = None;
    fixture
        .responses(LIST, DETAIL, 200)
        .read(input)
        .await
        .unwrap();
    assert_eq!(fixture.calls(), 2);
    fixture.finish().await;
    for change in [
        "active",
        "profile",
        "credential",
        "generation",
        "account",
        "disabled",
    ] {
        let fixture = Fixture::new().await;
        if change == "active" {
            fixture.settings(r#"{"enabled":true}"#);
        }
        let (credentials, first, second, path, requests) = (
            fixture.credentials.clone(),
            fixture.first.id().clone(),
            fixture.second.id().clone(),
            fixture.root.join("project/ycoding.json"),
            fixture.requests.clone(),
        );
        let reader = fixture.reader(Arc::new(move |request| {
            requests.lock().unwrap().push(request);
            let (credentials, first, second, path) = (credentials.clone(), first.clone(), second.clone(), path.clone());
            Box::pin(async move {
                match change {
                    "active" => credentials.activate(second, 4).await.unwrap(),
                    "credential" => {
                        credentials.remove(first, 4).await.unwrap();
                        credentials.create("credential-skills-replacement".into(), "openai".into(), Some("fixture-a".into()), secret("synthetic-access-a", "synthetic-account-a"), 5).await.unwrap();
                    }
                    "generation" => { credentials.create(first, "openai".into(), Some("fixture-a".into()), secret("synthetic-access-a", "synthetic-account-a"), 4).await.unwrap(); }
                    "account" => credentials.update(first, None, Some(secret("synthetic-access-a", "synthetic-other-account")), 4).await.unwrap(),
                    "disabled" => std::fs::write(path, r#"{"account_connectors":{"chatgpt":{"enabled":false}}}"#).unwrap(),
                    _ => std::fs::write(path, r#"{"account_connectors":{"chatgpt":{"enabled":true,"profile":"fixture-b"}}}"#).unwrap(),
                }
                Ok(response(200, LIST.as_bytes().to_vec()))
            })
        }));
        let mut input = fixture.input();
        if change == "active" {
            input.profile = None;
        }
        let error = reader.read(input).await.unwrap_err();
        assert_eq!(error.kind(), "account_skills_read", "{change}");
        assert_eq!(fixture.calls(), 1, "{change}");
        fixture.finish().await;
    }
}

#[tokio::test]
async fn every_get_uses_real_session_agent_resource_and_metadata_permission() {
    let fixture = Fixture::new().await;
    let (permissions, asked) = fixture.asking();
    let requests = fixture.requests.clone();
    let reader = Reader::with_exchange(
        fixture.configuration.clone(),
        fixture.registry.clone(),
        permissions.clone(),
        Arc::new(move |request| {
            let detail = request.url().path() != "/backend-api/hazelnuts";
            requests.lock().unwrap().push(request);
            Box::pin(async move {
                Ok(response(
                    200,
                    if detail { DETAIL } else { LIST }.as_bytes().to_vec(),
                ))
            })
        }),
    )
    .unwrap();
    let input = fixture.input();
    let reading = tokio::spawn(async move { reader.read(input).await });
    for dispatched in 0..2 {
        tokio::time::timeout(Duration::from_secs(5), asked.notified())
            .await
            .unwrap();
        assert_eq!(fixture.calls(), dispatched);
        let pending = permissions.list();
        assert_eq!(pending.len(), 1);
        let request = &pending[0];
        assert_eq!(request.session_id, fixture.session);
        assert_eq!(
            request.action,
            LosslessString::from("chatgpt_account_skills_read")
        );
        assert_eq!(request.resources, vec![fixture.first.id().clone()]);
        assert!(request.source.is_none());
        let metadata = request.metadata.as_ref().unwrap();
        assert_eq!(
            metadata.get(&"profile".into()),
            Some(&JsonValue::String("fixture-a".into()))
        );
        assert_eq!(
            metadata.get(&"accountID".into()),
            Some(&JsonValue::String("synthetic-account-a".into()))
        );
        permissions
            .reply(&request.id, permission::Reply("once".into()), None)
            .unwrap();
    }
    reading.await.unwrap().unwrap();
    assert!(permissions.list().is_empty());
    permissions.shutdown();
    fixture.finish().await;
}

#[tokio::test]
async fn changed_identity_or_configuration_and_cancellation_while_permission_waits_never_dispatch()
{
    for change in ["disabled", "generation", "account", "credential", "cancel"] {
        let fixture = Fixture::new().await;
        let (permissions, asked) = fixture.asking();
        let requests = fixture.requests.clone();
        let reader = Reader::with_exchange(
            fixture.configuration.clone(),
            fixture.registry.clone(),
            permissions.clone(),
            Arc::new(move |request| {
                requests.lock().unwrap().push(request);
                Box::pin(async { Ok(response(200, LIST.as_bytes().to_vec())) })
            }),
        )
        .unwrap();
        let input = fixture.input();
        let reading = tokio::spawn(async move { reader.read(input).await });
        tokio::time::timeout(Duration::from_secs(5), asked.notified())
            .await
            .unwrap();
        assert_eq!(permissions.list().len(), 1);
        match change {
            "disabled" => fixture.settings(r#"{"enabled":false}"#),
            "generation" => {
                fixture
                    .credentials
                    .create(
                        fixture.first.id().clone(),
                        "openai".into(),
                        Some("fixture-a".into()),
                        secret("synthetic-access-a", "synthetic-account-a"),
                        4,
                    )
                    .await
                    .unwrap();
            }
            "account" => fixture
                .credentials
                .update(
                    fixture.first.id().clone(),
                    None,
                    Some(secret("synthetic-access-a", "synthetic-other-account")),
                    4,
                )
                .await
                .unwrap(),
            "credential" => {
                fixture
                    .credentials
                    .remove(fixture.first.id().clone(), 4)
                    .await
                    .unwrap();
                fixture
                    .credentials
                    .create(
                        "credential-skills-replacement".into(),
                        "openai".into(),
                        Some("fixture-a".into()),
                        secret("synthetic-access-a", "synthetic-account-a"),
                        5,
                    )
                    .await
                    .unwrap();
            }
            _ => {}
        }
        if change == "cancel" {
            reading.abort();
            assert!(reading.await.unwrap_err().is_cancelled());
        } else {
            let request = permissions.list().pop().unwrap();
            permissions
                .reply(&request.id, permission::Reply("once".into()), None)
                .unwrap();
            assert_eq!(
                reading.await.unwrap().unwrap_err().kind(),
                "account_skills_read"
            );
        }
        assert_eq!(fixture.calls(), 0, "{change}");
        assert!(permissions.list().is_empty(), "{change}");
        permissions.shutdown();
        fixture.finish().await;
    }
}

#[tokio::test]
async fn permission_denial_prevents_dispatch_and_detail_preserves_its_read_error_kind() {
    let fixture = Fixture::new().await;
    fixture.rule("deny");
    let error = fixture
        .responses(LIST, DETAIL, 200)
        .read(fixture.input())
        .await
        .unwrap_err();
    assert_eq!(error.kind(), "permission_denied");
    assert_eq!(fixture.calls(), 0);
    fixture.rule("allow");
    let rules = fixture.policy.rules.clone();
    let requests = fixture.requests.clone();
    let reader = fixture.reader(Arc::new(move |request| {
        requests.lock().unwrap().push(request);
        rules.lock().unwrap()[0].effect = permission::Effect("deny".into());
        Box::pin(async { Ok(response(200, LIST.as_bytes().to_vec())) })
    }));
    let error = reader.read(fixture.input()).await.unwrap_err();
    assert_eq!(error.kind(), "account_skills_read");
    assert_eq!(fixture.calls(), 1);
    fixture.finish().await;
}

#[tokio::test]
async fn upstream_redirects_and_401_403_are_not_retried_or_exposed() {
    for status in [302, 401, 403] {
        let fixture = Fixture::new().await;
        let error = fixture
            .responses("private upstream body", DETAIL, status)
            .read(fixture.input())
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "account_skills_read");
        assert!(error.to_string().contains(&status.to_string()));
        assert!(!format!("{error:?}").contains("private upstream body"));
        assert_eq!(fixture.calls(), 1);
        fixture.finish().await;
    }
}

#[tokio::test]
async fn body_limit_is_four_mib_and_checks_declared_and_streamed_sizes() {
    for (size, declared, allowed) in [
        (4 * 1024 * 1024, None, true),
        (4 * 1024 * 1024 + 1, None, false),
        (18, Some(4 * 1024 * 1024 + 1), false),
    ] {
        let fixture = Fixture::new().await;
        let requests = fixture.requests.clone();
        let reader = fixture.reader(Arc::new(move |request| {
            requests.lock().unwrap().push(request);
            let mut body = br#"{"hazelnuts":[]}"#.to_vec();
            body.resize(size, b' ');
            Box::pin(async move {
                let mut response = response(200, body);
                if let Some(declared) = declared {
                    response
                        .headers_mut()
                        .insert("content-length", declared.to_string().parse().unwrap());
                }
                Ok(response)
            })
        }));
        let result = reader.read(fixture.input()).await;
        assert_eq!(result.is_ok(), allowed);
        assert_eq!(fixture.calls(), 1);
        fixture.finish().await;
    }
}

struct Cancelled(Arc<AtomicBool>);

impl Drop for Cancelled {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[tokio::test]
async fn cancellation_drops_a_blocked_exchange_without_retry_or_pending_permission() {
    let fixture = Fixture::new().await;
    let entered = Arc::new(Notify::new());
    let cancelled = Arc::new(AtomicBool::new(false));
    let (notify, dropped, requests) =
        (entered.clone(), cancelled.clone(), fixture.requests.clone());
    let reader = fixture.reader(Arc::new(move |request| {
        requests.lock().unwrap().push(request);
        let (notify, dropped) = (notify.clone(), dropped.clone());
        Box::pin(async move {
            let _cancelled = Cancelled(dropped);
            notify.notify_one();
            std::future::pending().await
        })
    }));
    let input = fixture.input();
    let reading = tokio::spawn(async move { reader.read(input).await });
    entered.notified().await;
    reading.abort();
    assert!(reading.await.unwrap_err().is_cancelled());
    assert!(cancelled.load(Ordering::Acquire));
    assert_eq!(fixture.calls(), 1);
    assert!(fixture.permissions.list().is_empty());
    fixture.finish().await;
}

#[tokio::test]
async fn body_completion_rechecks_configuration_and_body_cancellation_closes_the_stream() {
    for cancel in [false, true] {
        let fixture = Fixture::new().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let headers = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let released = release.clone();
        let upstream = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            if cancel {
                let mut byte = [0; 1];
                assert_eq!(socket.read(&mut byte).await.unwrap(), 0);
            } else {
                released.notified().await;
                socket.write_all(br#"{"hazelnuts":[]}"#).await.unwrap();
            }
        });
        let (notify, requests) = (headers.clone(), fixture.requests.clone());
        let http = reqwest::Client::new();
        let reader = fixture.reader(Arc::new(move |request| {
            requests.lock().unwrap().push(request);
            let (http, notify) = (http.clone(), notify.clone());
            Box::pin(async move {
                let response = http
                    .get(format!("http://{address}/synthetic"))
                    .send()
                    .await
                    .map_err(|_| ())?;
                notify.notify_one();
                Ok(response)
            })
        }));
        let input = fixture.input();
        let reading = tokio::spawn(async move { reader.read(input).await });
        headers.notified().await;
        if cancel {
            reading.abort();
            assert!(reading.await.unwrap_err().is_cancelled());
        } else {
            fixture.settings(r#"{"enabled":false}"#);
            release.notify_one();
            let error = reading.await.unwrap().unwrap_err();
            assert_eq!(error.kind(), "account_skills_read");
        }
        tokio::time::timeout(Duration::from_secs(5), upstream)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fixture.calls(), 1);
        fixture.finish().await;
    }
}
