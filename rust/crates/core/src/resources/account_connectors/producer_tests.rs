use super::*;
use crate::{
    cca::library::{LibraryFactory, LibraryOpenInput, LibraryProcess},
    resources::{
        config::{LoadOptions, Roots},
        credential,
    },
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering},
    },
};
use tokio::sync::{Notify, oneshot};
use ycoding_schema::parse_json;

pub(super) struct Fixture {
    pub root: PathBuf,
    pub factory: Arc<Factory>,
    pub attachments: Arc<attachment_store::Store>,
    pub source: Arc<Mutex<Vec<u8>>>,
    pub releases: Arc<AtomicUsize>,
    pub denied: Arc<AtomicBool>,
    pub live: Arc<AtomicBool>,
    pub status: Arc<AtomicU16>,
    pub failure: Arc<Mutex<String>>,
    pub entered: Arc<Notify>,
    pub release_entered: Arc<Notify>,
    pub release_failure: Arc<AtomicBool>,
    pub authorization_entered: Arc<Notify>,
    pub authorization_gate: Arc<Mutex<Option<oneshot::Receiver<()>>>>,
    requests: Arc<Mutex<Vec<reqwest::Request>>>,
    registry: auth::integration::Registry,
    credentials: credential::Service,
    store: ycoding_store::Store,
    registration: auth::integration::Registration,
}

struct Authorization {
    releases: Arc<AtomicUsize>,
    denied: Arc<AtomicBool>,
    release_entered: Arc<Notify>,
    release_failure: Arc<AtomicBool>,
    entered: Arc<Notify>,
    gate: Arc<Mutex<Option<oneshot::Receiver<()>>>>,
}
impl crate::cca::error::Authorize for Authorization {
    fn authorize(
        &self,
        input: crate::cca::error::AuthorizationInput,
    ) -> crate::cca::error::BoxFuture<
        'static,
        Result<crate::cca::error::Grant, crate::cca::error::AuthorizationDenied>,
    > {
        let releases = self.releases.clone();
        let denied = self.denied.load(Ordering::Acquire);
        let release_entered = self.release_entered.clone();
        let release_failure = self.release_failure.clone();
        let entered = self.entered.clone();
        let gate = self.gate.lock().unwrap().take();
        assert_eq!(input.action, "chatgpt_library_upload");
        assert_eq!(input.guardrail_action.as_deref(), Some("mcp_execute"));
        assert_eq!(input.resources, vec![LosslessString::from("report.txt")]);
        assert!(
            input
                .metadata
                .unwrap()
                .get(&"operationDigest".into())
                .is_some()
        );
        Box::pin(async move {
            entered.notify_one();
            if let Some(gate) = gate {
                gate.await.unwrap();
            }
            if denied {
                return Err(Default::default());
            }
            Ok(crate::cca::error::Grant::new(vec![], move || {
                Box::pin(async move {
                    releases.fetch_add(1, Ordering::AcqRel);
                    release_entered.notify_one();
                    if release_failure.load(Ordering::Acquire) {
                        Err(())
                    } else {
                        Ok(())
                    }
                })
            }))
        })
    }
}

impl Fixture {
    pub async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-native-library-{}",
            crate::cca::encoding::uuid_v4()
        ));
        std::fs::create_dir_all(root.join("project")).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let configuration = Arc::new(
            config::Configuration::load(LoadOptions {
                directory: root.join("project"),
                roots: Roots::development(&root).unwrap(),
                project: true,
                file: None,
                content: None,
                env: BTreeMap::new(),
            })
            .unwrap(),
        );
        std::fs::write(
            root.join("project/ycoding.json"),
            r#"{"account_connectors":{"chatgpt":{"enabled":true,"profile":"work"}}}"#,
        )
        .unwrap();
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
            ycoding_store::Metadata::new([76; 16], 1),
        )
        .unwrap();
        let credentials = credential::Service::new(store.client());
        let selected = credentials.create("credential-library".into(), "openai".into(), Some("work".into()), ycoding_store::resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-access","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{"accountID":"synthetic-account"}}"#).unwrap()).unwrap(), 1).await.unwrap();
        let registry = auth::integration::Registry::new(credentials.clone(), BTreeMap::new());
        let registration = registry
            .transform(|draft| draft.update("openai".into(), |_| {}))
            .unwrap();
        let attachments = Arc::new(attachment_store::Store::new(root.join("data")).unwrap());
        let source = Arc::new(Mutex::new(b"synthetic report\n".to_vec()));
        let releases = Arc::new(AtomicUsize::new(0));
        let denied = Arc::new(AtomicBool::new(false));
        let live = Arc::new(AtomicBool::new(true));
        let status = Arc::new(AtomicU16::new(200));
        let failure = Arc::new(Mutex::new(String::new()));
        let requests = Arc::new(Mutex::new(vec![]));
        let entered = Arc::new(Notify::new());
        let release_entered = Arc::new(Notify::new());
        let release_failure = Arc::new(AtomicBool::new(false));
        let authorization_entered = Arc::new(Notify::new());
        let authorization_gate = Arc::new(Mutex::new(None));
        let exchange = {
            let (requests, status, failure, entered, live) = (
                requests.clone(),
                status.clone(),
                failure.clone(),
                entered.clone(),
                live.clone(),
            );
            Arc::new(move |request: reqwest::Request| {
                let route = request.url().path().to_owned();
                let phase = failure.lock().unwrap().clone();
                let status = status.load(Ordering::Acquire);
                requests.lock().unwrap().push(request);
                let entered = entered.clone();
                let live = live.clone();
                Box::pin(async move {
                    if route == "/content" && phase == "blocked" {
                        entered.notify_one();
                        std::future::pending::<()>().await;
                    }
                    if route == "/content" && phase == "transfer" {
                        return Err(());
                    }
                    if (route == "/backend-api/files" && phase == "retire-create")
                        || (route == "/content" && phase == "retire-transfer")
                        || (route == "/backend-api/files/process_upload_stream"
                            && phase == "retire-finalize")
                    {
                        live.store(false, Ordering::Release);
                    }
                    let mut status = status;
                    let body = if route == "/backend-api/files" {
                        if phase == "redirect" {
                            status = 302;
                        }
                        if phase == "oversize" {
                            vec![b' '; library::RESPONSE_LIMIT + 1]
                        } else if phase == "headers" {
                            br#"{"file_id":"file-one","upload_url":"https://synthetic.blob.core.windows.net/content","upload_headers":{"authorization":"synthetic-forbidden"}}"#.to_vec()
                        } else if phase == "destination" {
                            br#"{"file_id":"file-one","upload_url":"https://evil.invalid/content"}"#
                                .to_vec()
                        } else if phase == "estuary" {
                            br#"{"file_id":"file-one","upload_url":"/backend-api/estuary/upload_content_bytes?upload_url=https%3A%2F%2Fsynthetic.blob.core.windows.net%2Fcontent%3Fsig%3Dsynthetic"}"#.to_vec()
                        } else if phase == "aws" {
                            br#"{"file_id":"file-one","upload_url":"https://synthetic.s3.amazonaws.com/content?X-Amz-Algorithm=synthetic","upload_headers":{"x-amz-meta-synthetic":"allowed"}}"#.to_vec()
                        } else {
                            br#"{"file_id":"file-one","upload_url":"https://synthetic.blob.core.windows.net/content?sig=synthetic"}"#.to_vec()
                        }
                    } else if route == "/backend-api/files/process_upload_stream" {
                        if phase == "completion" {
                            b"{\"event\":\"file.processing.completed\",\"file_id\":\"other\"}"
                                .to_vec()
                        } else {
                            b"{\"event\":\"file.indexing.completed\",\"file_id\":\"file-one\",\"extra\":{\"metadata_object_id\":\"library-one\"}}\n{\"event\":\"file.processing.completed\",\"file_id\":\"file-one\"}".to_vec()
                        }
                    } else {
                        vec![]
                    };
                    Ok(reqwest::Response::from(
                        axum::http::Response::builder()
                            .status(status)
                            .body(body)
                            .unwrap(),
                    ))
                })
                    as crate::cca::error::BoxFuture<'static, Result<reqwest::Response, ()>>
            }) as library::Exchange
        };
        let check = live.clone();
        let scope = crate::dots::native::executor_scope::LibraryScope {
            session_id: ycoding_schema::session::Id::new("ses_library").unwrap(),
            principal: crate::dots::native::executor_scope::LibraryPrincipal {
                profile: "work".into(),
                credential_id: "credential-library".into(),
                account_id: "synthetic-account".into(),
                account_generation: selected.account_generation(),
                access_revision: 1,
            },
            roots: vec![root.join("project").to_str().unwrap().into()],
            current: Arc::new(move || {
                let check = check.clone();
                Box::pin(async move {
                    if check.load(Ordering::Acquire) {
                        Ok(())
                    } else {
                        Err(crate::cca::error::ExecutorError::session_closed())
                    }
                })
            }),
            authorize: Arc::new(Authorization {
                releases: releases.clone(),
                denied: denied.clone(),
                release_entered: release_entered.clone(),
                release_failure: release_failure.clone(),
                entered: authorization_entered.clone(),
                gate: authorization_gate.clone(),
            }),
        };
        let input = LibraryInput {
            scope,
            configuration,
            integration: registry.clone(),
            attachments: attachments.clone(),
        };
        let factory = Arc::new(
            Factory::new(input, library::Transport::with_exchange(exchange))
                .await
                .unwrap(),
        );
        Self {
            root,
            factory,
            attachments,
            source,
            releases,
            denied,
            live,
            status,
            failure,
            entered,
            release_entered,
            release_failure,
            authorization_entered,
            authorization_gate,
            requests,
            registry,
            credentials,
            store,
            registration,
        }
    }
    pub fn cwd(&self) -> String {
        self.root.join("project").to_str().unwrap().into()
    }
    pub fn owner(&self, label: &str) -> LibraryOpenInput {
        let source = self.source.clone();
        LibraryOpenInput {
            process_id: label.into(),
            cwd: self.cwd(),
            read_file: Arc::new(move |path| {
                let source = source.clone();
                Box::pin(async move { Ok((path, source.lock().unwrap().clone())) })
            }),
        }
    }
    pub async fn open(&self, label: &str) -> Arc<dyn LibraryProcess> {
        self.factory.open(self.owner(label)).await.unwrap()
    }
    pub fn item(&self) -> Value {
        object([
            (
                "workspace_path",
                Value::String(format!("{}/report.txt", self.cwd()).into()),
            ),
            ("file_name", Value::String("report.txt".into())),
            ("purpose", Value::String("create_library_file".into())),
            ("mime_type", Value::String("text/plain".into())),
            ("file_size_bytes", Value::Number(17.0)),
        ])
    }
    pub fn prepare(&self) -> Value {
        object([("uploads", Value::Array(vec![self.item()]))])
    }
    pub fn routes(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| format!("{} {}", request.method(), request.url().path()))
            .collect()
    }
    pub fn input(&self) -> LibraryInput {
        let input = &self.factory.context.input;
        LibraryInput {
            scope: crate::dots::native::executor_scope::LibraryScope {
                session_id: input.scope.session_id.clone(),
                principal: input.scope.principal.clone(),
                roots: input.scope.roots.clone(),
                current: input.scope.current.clone(),
                authorize: input.scope.authorize.clone(),
            },
            configuration: input.configuration.clone(),
            integration: input.integration.clone(),
            attachments: input.attachments.clone(),
        }
    }
    pub async fn finish(self) {
        self.registration.dispose().unwrap();
        self.registry.shutdown().await.unwrap();
        self.credentials.shutdown().await.unwrap();
        self.store.shutdown().unwrap();
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn absent_disabled_profile_or_scope_replacement_rejects_existing_factory_before_file_io() {
    for content in [
        "{}",
        r#"{"account_connectors":{"chatgpt":{"enabled":false}}}"#,
        r#"{"account_connectors":{"chatgpt":{"enabled":true,"profile":"other"}}}"#,
        r#"{"account_connectors":{"chatgpt":{"enabled":true,"profile":"work","connectors":{"mail":"deny"}}}}"#,
    ] {
        let f = Fixture::new().await;
        std::fs::write(f.root.join("project/ycoding.json"), content).unwrap();
        assert!(f.factory.open(f.owner("retired")).await.is_err());
        assert!(library_factory(f.input()).await.is_err());
        assert!(f.routes().is_empty());
        f.finish().await;
    }
    let f = Fixture::new().await;
    let process = f.open("one").await;
    f.live.store(false, Ordering::Release);
    assert!(
        process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await
            .is_err()
    );
    process.close().await.unwrap();
    assert!(f.routes().is_empty());
    f.finish().await;
}

#[tokio::test]
async fn credential_replacement_with_same_label_or_foreign_account_never_dispatches_file_writes() {
    for account in ["synthetic-account", "synthetic-other"] {
        let f = Fixture::new().await;
        let secret = format!(
            r#"{{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-new","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{{"accountID":"{account}"}}}}"#
        );
        f.credentials
            .create(
                "credential-library".into(),
                "openai".into(),
                Some("work".into()),
                ycoding_store::resources::Secret::new(parse_json(&secret).unwrap()).unwrap(),
                2,
            )
            .await
            .unwrap();
        assert!(f.factory.open(f.owner("replaced")).await.is_err());
        assert!(f.routes().is_empty());
        f.finish().await;
    }
}

#[tokio::test]
async fn authenticated_create_and_signed_transfer_never_share_account_headers() {
    let f = Fixture::new().await;
    let process = f.open("one").await;
    process
        .call("ycoding_library.prepare_uploads", f.prepare())
        .await
        .unwrap();
    {
        let requests = f.requests.lock().unwrap();
        assert_eq!(
            requests[0].headers()["authorization"],
            "Bearer synthetic-access"
        );
        assert_eq!(
            requests[0].headers()["chatgpt-account-id"],
            "synthetic-account"
        );
        assert_eq!(requests[0].headers()["originator"], "Codex Desktop");
        assert!(!format!("{:?}", requests[0]).contains("synthetic-access"));
        assert!(!format!("{:?}", requests[0]).contains("synthetic-account"));
        for header in [
            "authorization",
            "chatgpt-account-id",
            "cookie",
            "originator",
            "user-agent",
        ] {
            assert!(!requests[1].headers().contains_key(header));
        }
        assert_eq!(requests[1].headers()["x-ms-blob-type"], "BlockBlob");
        assert_eq!(
            requests[1].body().unwrap().as_bytes().unwrap(),
            b"synthetic report\n"
        );
    }
    process.close().await.unwrap();
    f.finish().await;
}

#[tokio::test]
async fn retirement_after_each_transport_await_withholds_results_and_releases_grants() {
    for phase in ["retire-create", "retire-transfer", "retire-finalize"] {
        let f = Fixture::new().await;
        *f.failure.lock().unwrap() = phase.into();
        let process = f.open("one").await;
        let prepared = process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await;
        if phase == "retire-finalize" {
            assert!(
                process
                    .call("ycoding_library.finalize_uploads", prepared.unwrap())
                    .await
                    .is_err()
            );
        } else {
            assert!(prepared.is_err());
        }
        assert_eq!(
            f.routes().len(),
            match phase {
                "retire-create" => 1,
                "retire-transfer" => 2,
                _ => 3,
            }
        );
        process.close().await.unwrap();
        assert_eq!(f.releases.load(Ordering::Acquire), 1);
        f.finish().await;
    }
}

#[tokio::test]
async fn retirement_during_the_process_reader_prevents_attachment_import_and_authorization() {
    let f = Fixture::new().await;
    let live = f.live.clone();
    let process = f
        .factory
        .open(LibraryOpenInput {
            process_id: "retiring-reader".into(),
            cwd: f.cwd(),
            read_file: Arc::new(move |path| {
                let live = live.clone();
                Box::pin(async move {
                    live.store(false, Ordering::Release);
                    Ok((path, b"synthetic report\n".to_vec()))
                })
            }),
        })
        .await
        .unwrap();
    assert!(
        process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await
            .is_err()
    );
    assert!(f.routes().is_empty());
    assert!(!f.root.join("data/attachments").exists());
    process.close().await.unwrap();
    f.finish().await;
}

#[tokio::test]
async fn wrong_credential_account_and_generation_are_rejected_at_factory_admission() {
    for field in ["credential", "account", "generation"] {
        let f = Fixture::new().await;
        let mut input = f.input();
        match field {
            "credential" => input.scope.principal.credential_id = "not-selected".into(),
            "account" => input.scope.principal.account_id = "not-selected".into(),
            _ => input.scope.principal.account_generation += 1,
        }
        assert!(library_factory(input).await.is_err());
        assert!(f.routes().is_empty());
        f.finish().await;
    }
}

#[tokio::test]
async fn estuary_multipart_and_aws_put_keep_the_exact_transport_boundary() {
    for phase in ["estuary", "aws"] {
        let f = Fixture::new().await;
        *f.failure.lock().unwrap() = phase.into();
        let process = f.open("one").await;
        process
            .call("ycoding_library.prepare_uploads", f.prepare())
            .await
            .unwrap();
        {
            let requests = f.requests.lock().unwrap();
            let request = &requests[1];
            if phase == "estuary" {
                assert_eq!(request.method(), reqwest::Method::POST);
                assert_eq!(request.url().host_str(), Some("chatgpt.com"));
                assert_eq!(
                    request.url().path(),
                    "/backend-api/estuary/upload_content_bytes"
                );
                assert_eq!(
                    request.headers()["authorization"],
                    "Bearer synthetic-access"
                );
                let content_type = request.headers()["content-type"].to_str().unwrap();
                assert!(content_type.starts_with("multipart/form-data; boundary="));
                let boundary = content_type.split_once("boundary=").unwrap().1;
                let body = String::from_utf8(request.body().unwrap().as_bytes().unwrap().to_vec())
                    .unwrap();
                assert!(body.starts_with(&format!("--{boundary}\r\n")));
                assert!(body.contains("name=\"file\"; filename=\"report.txt\"\r\nContent-Type: text/plain\r\n\r\nsynthetic report\n"));
                assert!(body.contains("name=\"upload_url\"\r\n\r\nhttps://synthetic.blob.core.windows.net/content?sig=synthetic"));
                assert!(body.ends_with(&format!("--{boundary}--\r\n")));
            } else {
                assert_eq!(request.method(), reqwest::Method::PUT);
                assert_eq!(request.url().host_str(), Some("synthetic.s3.amazonaws.com"));
                assert_eq!(request.headers()["x-amz-meta-synthetic"], "allowed");
                assert!(!request.headers().contains_key("x-ms-blob-type"));
                assert!(!request.headers().contains_key("authorization"));
            }
        }
        process.close().await.unwrap();
        f.finish().await;
    }
}

#[tokio::test]
async fn cancelling_factory_open_before_publication_owns_no_upload_or_worker_cleanup() {
    let f = Fixture::new().await;
    let mut input = f.input();
    let block = Arc::new(AtomicBool::new(false));
    let entered = Arc::new(Notify::new());
    let (blocked, signalled) = (block.clone(), entered.clone());
    input.scope.current = Arc::new(move || {
        let (blocked, signalled) = (blocked.clone(), signalled.clone());
        Box::pin(async move {
            if blocked.load(Ordering::Acquire) {
                signalled.notify_one();
                std::future::pending::<()>().await;
            }
            Ok(())
        })
    });
    let factory = Arc::new(
        Factory::new(
            input,
            library::Transport::with_exchange(Arc::new(|_| Box::pin(async { Err(()) }))),
        )
        .await
        .unwrap(),
    );
    block.store(true, Ordering::Release);
    let owner = f.owner("never-published");
    let opening = tokio::spawn(async move { factory.open(owner).await });
    entered.notified().await;
    opening.abort();
    assert!(opening.await.is_err_and(|error| error.is_cancelled()));
    assert_eq!(f.releases.load(Ordering::Acquire), 0);
    assert!(f.routes().is_empty());
    f.finish().await;
}

#[tokio::test]
async fn omitted_connector_profile_uses_only_the_scope_pin_not_the_active_account() {
    let f = Fixture::new().await;
    std::fs::write(
        f.root.join("project/ycoding.json"),
        r#"{"account_connectors":{"chatgpt":{"enabled":true}}}"#,
    )
    .unwrap();
    f.credentials.create("credential-other".into(), "openai".into(), Some("other".into()), ycoding_store::resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-browser","access":"synthetic-other","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{"accountID":"synthetic-other"}}"#).unwrap()).unwrap(), 2).await.unwrap();
    let factory = library_factory(f.input()).await.unwrap();
    let process = factory.open(f.owner("pinned")).await.unwrap();
    process.check().await.unwrap();
    process.close().await.unwrap();
    assert!(f.routes().is_empty());
    f.finish().await;
}

#[tokio::test]
async fn keys_and_non_chatgpt_oauth_cannot_be_used_by_the_private_factory() {
    for secret in [
        r#"{"type":"key","key":"synthetic-key"}"#,
        r#"{"type":"oauth","methodID":"unrelated","access":"synthetic-access","refresh":"synthetic-refresh","expires":9007199254740000,"metadata":{"accountID":"synthetic-account"}}"#,
    ] {
        let f = Fixture::new().await;
        let selected = f
            .credentials
            .create(
                "credential-library".into(),
                "openai".into(),
                Some("work".into()),
                ycoding_store::resources::Secret::new(parse_json(secret).unwrap()).unwrap(),
                2,
            )
            .await
            .unwrap();
        let mut input = f.input();
        input.scope.principal.account_generation = selected.account_generation();
        assert!(library_factory(input).await.is_err());
        assert!(f.routes().is_empty());
        f.finish().await;
    }
}
