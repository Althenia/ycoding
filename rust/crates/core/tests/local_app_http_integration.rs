pub mod local_app_support;

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::Request,
    http::{Response, StatusCode},
};
use flate2::{Compression, write::GzEncoder};
use local_app_support::{Fixture, failure, input, scope};
use std::{
    collections::BTreeMap,
    io::Write,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, task::JoinHandle};
use ycoding_core::{local_app::HttpTransport, mcp_events::Cancellation};
use ycoding_schema::local_app::{Category, Host, Method};

struct Seen {
    path: String,
    method: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
struct Server {
    port: u16,
    stop: Cancellation,
    task: Option<JoinHandle<()>>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    async fn start(host: &str, forbidden_port: u16, hits: Arc<AtomicUsize>) -> Self {
        let listener = TcpListener::bind((host, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let stop = Cancellation::default();
        let shutdown = stop.clone();
        let router=Router::new().fallback(move|request:Request|{let seen=captured.clone();let hits=hits.clone();async move {
            hits.fetch_add(1,Ordering::AcqRel);
            let method=request.method().as_str().to_owned();let path=request.uri().path_and_query().unwrap().as_str().to_owned();let headers=request.headers().iter().map(|(key,value)|(key.to_string(),value.to_str().unwrap().to_owned())).collect();let bytes=to_bytes(request.into_body(),256*1024+1).await.unwrap().to_vec();seen.lock().unwrap().push(Seen{path:path.clone(),method:method.clone(),headers,body:bytes.clone()});let route=path.split('?').next().unwrap();
            let response=Response::builder().header("connection","close");
            match route {
                "/app/index.html"=>response.header("content-type","text/html").header("content-security-policy","default-src 'self'").body(Body::from("<!doctype html><link rel=stylesheet href=style.css><script src=/app/app.js></script><img src=image.png>")),
                "/app/style.css"=>response.header("content-type","text/css").body(Body::from("body{color:navy}")),
                "/app/app.js"=>response.header("content-type","text/javascript").body(Body::from("fetch('./api')")),
                "/app/image.png"=>response.header("content-type","image/png").header("content-length","11").body(if method=="HEAD"{Body::empty()}else{Body::from(vec![137,80,78,71,13,10,26,10,0,255,1])}),
                "/app/api"=>response.status(201).header("content-type","application/octet-stream").header("set-cookie","private=synthetic").header("www-authenticate","Basic synthetic").body(Body::from(bytes)),
                "/app/range"=>response.status(206).header("content-range","bytes 1-3/11").header("accept-ranges","bytes").body(Body::from(vec![80,78,71])),
                "/app/empty"=>response.status(204).body(Body::empty()),
                "/app/cached"=>response.status(304).header("etag","\"v1\"").body(Body::empty()),
                "/app/error"=>response.status(422).body(Body::from("synthetic validation failure")),
                "/app/redirect"=>response.status(302).header("location","index.html?q=a%2Fb").body(Body::empty()),
                "/app/preserve"=>response.status(307).header("location","/app/api").body(Body::empty()),
                "/app/escape"=>response.status(302).header("location",format!("http://127.0.0.1:{forbidden_port}/private")).body(Body::empty()),
                "/app/event"=>response.header("content-type","text/event-stream").body(Body::from("data: synthetic\n\n")),
                "/app/compressed"|"/app/compressed-huge"|"/app/compressed-broken"=>{let mut encoder=GzEncoder::new(Vec::new(),Compression::default());let decoded=if route=="/app/compressed-huge"{vec![0;2*1024*1024+1]}else{b"decoded bytes".to_vec()};encoder.write_all(&decoded).unwrap();let mut packed=encoder.finish().unwrap();if route=="/app/compressed-broken"{packed.truncate(packed.len()-4);}response.header("content-type","application/octet-stream").header("content-encoding","gzip").header("content-length",packed.len()).body(Body::from(packed))},
                _=>response.status(StatusCode::NOT_FOUND).body(Body::from("missing")),
            }.unwrap()
        }});
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { shutdown.cancelled().await })
                .await
                .unwrap();
        });
        Self {
            port,
            stop,
            task: Some(task),
            seen,
        }
    }
    async fn close(&mut self) {
        self.stop.cancel();
        tokio::time::timeout(Duration::from_secs(2), self.task.take().unwrap())
            .await
            .unwrap()
            .unwrap();
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[tokio::test]
async fn real_loopback_preserves_pages_assets_binary_head_ranges_statuses_and_safe_redirects() {
    let forbidden_hits = Arc::new(AtomicUsize::new(0));
    let mut forbidden = Server::start("127.0.0.1", 0, forbidden_hits.clone()).await;
    let mut server =
        Server::start("127.0.0.1", forbidden.port, Arc::new(AtomicUsize::new(0))).await;
    let fixture = Fixture::with_transport(Arc::new(HttpTransport::new().unwrap()));
    let mut registration = input();
    registration.port = server.port;
    let app = fixture
        .service
        .register(registration, scope(), Cancellation::default())
        .await
        .unwrap();
    fixture
        .service
        .publish(
            &app.id,
            &app.generation,
            &scope(),
            Some("https://preview.example"),
        )
        .unwrap();
    let page = fixture.send(&app).await;
    assert!(
        String::from_utf8(page.body)
            .unwrap()
            .contains("href=style.css")
    );
    assert_eq!(page.headers["content-type"], "text/html");
    assert_eq!(
        page.headers["content-security-policy"],
        "default-src 'self'"
    );
    for (path, expected, kind) in [
        ("/app/style.css", "body{color:navy}", "text/css"),
        ("/app/app.js", "fetch('./api')", "text/javascript"),
    ] {
        let mut request = fixture.request(&app);
        request.path = path.into();
        let response = fixture
            .service
            .dispatch(request, Cancellation::default())
            .await
            .unwrap();
        assert_eq!(response.body, expected.as_bytes());
        assert_eq!(response.headers["content-type"], kind);
    }
    let png = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1];
    let mut image = fixture.request(&app);
    image.path = "/app/image.png".into();
    let response = fixture
        .service
        .dispatch(image, Cancellation::default())
        .await
        .unwrap();
    assert_eq!(response.body, png);
    assert_eq!(response.headers["content-length"], "11");
    let mut head = fixture.request(&app);
    head.path = "/app/image.png".into();
    head.method = Method::Head;
    let response = fixture
        .service
        .dispatch(head, Cancellation::default())
        .await
        .unwrap();
    assert!(response.body.is_empty());
    assert_eq!(response.headers["content-length"], "11");
    let mut post = fixture.request(&app);
    post.path = "/app/api?q=%E2%98%83&x=a%2Fb".into();
    post.method = Method::Post;
    post.body = Some(vec![0, 127, 128, 255, 42]);
    post.headers = BTreeMap::from([
        ("content-type".into(), "application/octet-stream".into()),
        ("origin".into(), "https://preview.example".into()),
        (
            "referer".into(),
            "https://preview.example/app/index.html".into(),
        ),
        ("cookie".into(), "synthetic=private".into()),
        ("authorization".into(), "Bearer synthetic".into()),
        ("proxy-authorization".into(), "synthetic".into()),
    ]);
    let response = fixture
        .service
        .dispatch(post, Cancellation::default())
        .await
        .unwrap();
    assert_eq!(response.status, 201);
    assert_eq!(response.body, [0, 127, 128, 255, 42]);
    assert!(!response.headers.contains_key("set-cookie"));
    assert!(!response.headers.contains_key("www-authenticate"));
    let mut range = fixture.request(&app);
    range.path = "/app/range".into();
    range.headers.insert("range".into(), "bytes=1-3".into());
    let response = fixture
        .service
        .dispatch(range, Cancellation::default())
        .await
        .unwrap();
    assert_eq!(response.status, 206);
    assert_eq!(response.body, [80, 78, 71]);
    assert_eq!(response.headers["content-range"], "bytes 1-3/11");
    for (method, name) in [
        (Method::Put, "PUT"),
        (Method::Patch, "PATCH"),
        (Method::Delete, "DELETE"),
        (Method::Options, "OPTIONS"),
    ] {
        let mut request = fixture.request(&app);
        request.path = "/app/api".into();
        request.method = method;
        request.body = Some(vec![0, 255]);
        let response = fixture
            .service
            .dispatch(request, Cancellation::default())
            .await
            .unwrap();
        assert_eq!(response.body, [0, 255]);
        assert_eq!(server.seen.lock().unwrap().last().unwrap().method, name);
    }
    for (path, status) in [
        ("empty", 204),
        ("cached", 304),
        ("missing", 404),
        ("error", 422),
    ] {
        let mut request = fixture.request(&app);
        request.path = format!("/app/{path}").into();
        let response = fixture
            .service
            .dispatch(request, Cancellation::default())
            .await
            .unwrap();
        assert_eq!(response.status, status);
        if [204, 304].contains(&status) {
            assert!(response.body.is_empty());
            assert!(!response.headers.contains_key("content-length"));
        }
    }
    let before = server.seen.lock().unwrap().len();
    for (path, method, status, location) in [
        ("redirect", Method::Get, 302, "/app/index.html?q=a%2Fb"),
        ("preserve", Method::Post, 307, "/app/api"),
    ] {
        let mut request = fixture.request(&app);
        request.path = format!("/app/{path}").into();
        request.method = method;
        let response = fixture
            .service
            .dispatch(request, Cancellation::default())
            .await
            .unwrap();
        assert_eq!(response.status, status);
        assert_eq!(response.headers["location"], location);
    }
    let mut escaped = fixture.request(&app);
    escaped.path = "/app/escape".into();
    let error = fixture
        .service
        .dispatch(escaped, Cancellation::default())
        .await
        .err()
        .unwrap();
    assert_eq!(error, failure(Category::RedirectRejected));
    assert_eq!(server.seen.lock().unwrap().len() - before, 3);
    assert_eq!(forbidden_hits.load(Ordering::Acquire), 0);
    {
        let seen = server.seen.lock().unwrap();
        let post = seen
            .iter()
            .find(|seen| seen.path.starts_with("/app/api?"))
            .unwrap();
        assert_eq!(post.method, "POST");
        assert_eq!(post.path, "/app/api?q=%E2%98%83&x=a%2Fb");
        assert_eq!(post.body, [0, 127, 128, 255, 42]);
        assert_eq!(
            post.headers["origin"],
            format!("http://127.0.0.1:{}", server.port)
        );
        assert_eq!(
            post.headers["referer"],
            format!("http://127.0.0.1:{}/app/index.html", server.port)
        );
        assert!(
            seen.iter()
                .all(|request| !request.headers.contains_key("cookie")
                    && !request.headers.contains_key("authorization")
                    && !request.headers.contains_key("proxy-authorization")
                    && request.headers["accept-encoding"] == "identity")
        );
    }
    fixture.service.close().await;
    server.close().await;
    forbidden.close().await;
}

#[tokio::test]
async fn real_gzip_is_decoded_bounded_and_validated_without_forwarding_encoding_or_old_length() {
    let mut server = Server::start("127.0.0.1", 0, Arc::new(AtomicUsize::new(0))).await;
    let fixture = Fixture::with_transport(Arc::new(HttpTransport::new().unwrap()));
    let mut registration = input();
    registration.port = server.port;
    let app = fixture
        .service
        .register(registration, scope(), Cancellation::default())
        .await
        .unwrap();
    fixture
        .service
        .publish(&app.id, &app.generation, &scope(), None)
        .unwrap();
    let mut request = fixture.request(&app);
    request.path = "/app/compressed".into();
    let response = fixture
        .service
        .dispatch(request, Cancellation::default())
        .await
        .unwrap();
    assert_eq!(response.body, b"decoded bytes");
    assert_eq!(response.headers["content-length"], "13");
    assert!(!response.headers.contains_key("content-encoding"));
    for (path, category) in [
        ("/app/compressed-huge", Category::TooLarge),
        ("/app/compressed-broken", Category::UpstreamUnavailable),
        ("/app/event", Category::UnsupportedStream),
    ] {
        let mut request = fixture.request(&app);
        request.path = path.into();
        let error = fixture
            .service
            .dispatch(request, Cancellation::default())
            .await
            .err()
            .unwrap();
        assert_eq!(error, failure(category));
    }
    fixture.service.close().await;
    server.close().await;
}

#[tokio::test]
async fn real_ipv6_literal_uses_the_registered_port_and_preserves_binary_response() {
    let mut server = Server::start("::1", 0, Arc::new(AtomicUsize::new(0))).await;
    let fixture = Fixture::with_transport(Arc::new(HttpTransport::new().unwrap()));
    let mut registration = input();
    registration.host = Host::V6;
    registration.port = server.port;
    let app = fixture
        .service
        .register(registration, scope(), Cancellation::default())
        .await
        .unwrap();
    fixture
        .service
        .publish(&app.id, &app.generation, &scope(), None)
        .unwrap();
    let mut request = fixture.request(&app);
    request.path = "/app/image.png".into();
    let response = fixture
        .service
        .dispatch(request, Cancellation::default())
        .await
        .unwrap();
    assert_eq!(response.body, [137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 1]);
    fixture.service.close().await;
    server.close().await;
}

#[tokio::test]
async fn proxy_environment_cannot_redirect_private_loopback_http() {
    let hits = Arc::new(AtomicUsize::new(0));
    let mut proxy = Server::start("127.0.0.1", 0, hits.clone()).await;
    let address = format!("http://127.0.0.1:{}", proxy.port);
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
    child.args([
        "--exact",
        "real_loopback_preserves_pages_assets_binary_head_ranges_statuses_and_safe_redirects",
        "--nocapture",
    ]);
    for key in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        child.env(key, &address);
    }
    child
        .env("NO_PROXY", "")
        .env("no_proxy", "")
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), child.output())
        .await
        .unwrap()
        .unwrap();
    proxy.close().await;
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(hits.load(Ordering::Acquire), 0);
}
