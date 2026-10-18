mod local_app_support;

use local_app_support::{
    Fixture, NOW, decode, encoded, failure, future_body, incoming, input, scope,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::sync::Notify;
use ycoding_core::{local_app::Incoming, mcp_events::Cancellation};
use ycoding_schema::DomainDecode;
use ycoding_schema::local_app::{Category, Failure, Host, Method, Register, Scope};

fn assert_category<T>(result: Result<T, Failure>, category: Category) {
    assert!(matches!(result,Err(error) if error.category==category));
}

async fn joined<T>(task: tokio::task::JoinHandle<T>) -> T {
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn registration_requires_backend_session_and_returns_detached_safe_metadata() {
    let fixture = Fixture::new();
    let app = fixture.register().await;
    let value = encoded(&app);
    assert_eq!(app.expires_at, NOW + 900_000);
    assert_eq!(
        value["allowedMethods"],
        json!(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    );
    for (key, prefix, length) in [("id", "app_", 36), ("generation", "generation_", 43)] {
        let value = value[key].as_str().unwrap();
        assert_eq!(value.len(), length);
        assert!(
            value
                .strip_prefix(prefix)
                .unwrap()
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
    }
    assert!(!value.to_string().contains("43210"));
    for key in [
        "host", "port", "origin", "ownerID", "clientID", "grantID", "epoch",
    ] {
        assert!(value.get(key).is_none());
    }
    let mut detached = app.clone();
    detached.entry_path = "/altered".into();
    detached.routes.clear();
    assert_eq!(fixture.service.list(&scope()).unwrap(), vec![app.clone()]);
    assert_category(
        fixture
            .service
            .dispatch(fixture.request(&app), Cancellation::default())
            .await,
        Category::Forbidden,
    );
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
    fixture.sessions.allowed.store(false, Ordering::Release);
    assert_category(
        fixture
            .service
            .register(input(), scope(), Cancellation::default())
            .await,
        Category::InvalidRegistration,
    );
    fixture.sessions.allowed.store(true, Ordering::Release);
    fixture.sessions.failed.store(true, Ordering::Release);
    assert_category(
        fixture
            .service
            .register(input(), scope(), Cancellation::default())
            .await,
        Category::InvalidRegistration,
    );
    fixture.sessions.failed.store(false, Ordering::Release);
    let verified = fixture.sessions.gate.calls.load(Ordering::Acquire);
    let mut wrong = input();
    wrong.session_id = decode(json!("ses_other"));
    assert_category(
        fixture
            .service
            .register(wrong, scope(), Cancellation::default())
            .await,
        Category::InvalidRegistration,
    );
    assert_eq!(fixture.service.list(&scope()).unwrap().len(), 1);
    assert_eq!(
        fixture.sessions.gate.calls.load(Ordering::Acquire),
        verified
    );
}

#[tokio::test]
async fn committed_registry_capacity_is_shared_across_sessions_and_released_by_revocation() {
    let fixture = Fixture::new();
    let mut retained = Vec::new();
    for index in 0..64 {
        let mut owner = scope();
        owner.session_id = decode(json!(format!("ses_group{}", index / 16)));
        let mut registration = input();
        registration.session_id = owner.session_id.clone();
        let app = fixture
            .service
            .register(registration, owner.clone(), Cancellation::default())
            .await
            .unwrap();
        retained.push((app, owner));
    }
    assert_category(
        fixture
            .service
            .register(input(), scope(), Cancellation::default())
            .await,
        Category::Busy,
    );
    fixture
        .service
        .revoke(&retained[0].0.id, &retained[0].1)
        .unwrap();
    fixture.register().await;
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn route_validation_precedes_session_verification_and_rejects_ambiguous_paths() {
    let fixture = Fixture::new();
    for raw in [
        "/app/../private",
        "/app/%252e%252e/private",
        "/app/%25252fprivate",
        "/app/%c0%af",
        "/app/%ed%a0%80",
        "//other.invalid/app",
        "/app/*",
        "/app?query=1",
        "/app/\\child",
        "/app/%",
    ] {
        let mut value = encoded(&input());
        value["routes"][0]["path"] = json!(raw);
        let input = Register::decode(&ycoding_schema::parse_json(&value.to_string()).unwrap());
        if let Ok(input) = input {
            assert_category(
                fixture
                    .service
                    .register(input, scope(), Cancellation::default())
                    .await,
                Category::InvalidRegistration,
            );
        }
    }
    for entry in ["/not-registered", "/app-other", "/app/../private"] {
        let mut input = input();
        input.entry_path = entry.into();
        assert_category(
            fixture
                .service
                .register(input, scope(), Cancellation::default())
                .await,
            Category::InvalidRegistration,
        );
    }
    let mut no_get = input();
    no_get.routes[0].methods = vec![Method::Post];
    assert_category(
        fixture
            .service
            .register(no_get, scope(), Cancellation::default())
            .await,
        Category::InvalidRegistration,
    );
    let mut zero_port = input();
    zero_port.port = 0;
    assert_category(
        fixture
            .service
            .register(zero_port, scope(), Cancellation::default())
            .await,
        Category::InvalidRegistration,
    );
    for count in [0, 65] {
        let mut invalid = input();
        invalid.routes = vec![invalid.routes[0].clone(); count];
        assert_category(
            fixture
                .service
                .register(invalid, scope(), Cancellation::default())
                .await,
            Category::InvalidRegistration,
        );
    }
    assert_eq!(fixture.sessions.gate.calls.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn all_scope_dimensions_and_generation_are_checked_before_contact() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    for field in [
        "ownerID",
        "deviceID",
        "sessionID",
        "clientID",
        "grantID",
        "epoch",
    ] {
        let mut value = encoded(&scope());
        value[field] = json!(if field == "sessionID" {
            "ses_other"
        } else {
            "other_synthetic"
        });
        let other: Scope = decode(value);
        assert!(fixture.service.list(&other).unwrap().is_empty());
        assert_category(
            fixture
                .service
                .publish(&app.id, &app.generation, &other, None),
            Category::Forbidden,
        );
        assert_category(fixture.service.revoke(&app.id, &other), Category::Forbidden);
        let mut request = fixture.request(&app);
        request.scope = other;
        assert_category(
            fixture
                .service
                .dispatch(request, Cancellation::default())
                .await,
            Category::Forbidden,
        );
    }
    let wrong = "generation_00000000000000000000000000000000".into();
    assert_category(
        fixture.service.publish(&app.id, &wrong, &scope(), None),
        Category::Forbidden,
    );
    let mut request = fixture.request(&app);
    request.generation = wrong;
    assert_category(
        fixture
            .service
            .dispatch(request, Cancellation::default())
            .await,
        Category::Forbidden,
    );
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
    fixture.send(&app).await;
    assert_eq!(fixture.transport.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn ttl_sweep_revoke_clear_and_close_never_restore_old_exposure() {
    let fixture = Fixture::new();
    for ttl in [1, 3_600_000] {
        let mut input = input();
        input.ttl_ms = Some(ttl);
        let app = fixture
            .service
            .register(input, scope(), Cancellation::default())
            .await
            .unwrap();
        assert_eq!(app.expires_at, NOW + ttl as i64);
        fixture.service.revoke(&app.id, &scope()).unwrap();
    }
    let first = fixture.add().await;
    fixture.clock.store(first.expires_at, Ordering::Release);
    assert_category(
        fixture
            .service
            .dispatch(fixture.request(&first), Cancellation::default())
            .await,
        Category::Expired,
    );
    assert!(fixture.service.list(&scope()).unwrap().is_empty());
    fixture.clock.store(NOW, Ordering::Release);
    let second = fixture.add().await;
    fixture.service.revoke(&second.id, &scope()).unwrap();
    assert_category(
        fixture
            .service
            .dispatch(fixture.request(&second), Cancellation::default())
            .await,
        Category::NotFound,
    );
    let third = fixture.add().await;
    fixture.service.clear().await;
    assert_category(
        fixture
            .service
            .dispatch(fixture.request(&third), Cancellation::default())
            .await,
        Category::NotFound,
    );
    let fourth = fixture.add().await;
    assert_ne!(fourth.id, third.id);
    assert_ne!(fourth.generation, third.generation);
    fixture.service.close().await;
    assert!(fixture.service.list(&scope()).unwrap().is_empty());
    assert_category(
        fixture
            .service
            .register(input(), scope(), Cancellation::default())
            .await,
        Category::NotFound,
    );
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn registry_capacity_includes_pending_verifications_and_is_released_on_clear() {
    let fixture = Fixture::new();
    fixture.sessions.held.store(true, Ordering::Release);
    let mut pending = Vec::new();
    for index in 0..64 {
        let service = fixture.service.clone();
        let mut owner = scope();
        owner.session_id = decode(json!(format!("ses_group{}", index / 16)));
        let mut input = input();
        input.session_id = owner.session_id.clone();
        pending.push(tokio::spawn(async move {
            service
                .register(input, owner, Cancellation::default())
                .await
        }));
    }
    fixture.sessions.gate.wait(64).await;
    assert_category(
        fixture
            .service
            .register(input(), scope(), Cancellation::default())
            .await,
        Category::Busy,
    );
    tokio::time::timeout(Duration::from_secs(2), fixture.service.clear())
        .await
        .unwrap();
    for task in pending {
        assert_category(joined(task).await, Category::NotFound);
    }
    fixture.sessions.gate.release.cancel();
    assert!(fixture.service.list(&scope()).unwrap().is_empty());
    fixture.register().await;
    let fixture = Fixture::new();
    fixture.sessions.held.store(true, Ordering::Release);
    let mut pending = Vec::new();
    for _ in 0..16 {
        let service = fixture.service.clone();
        pending.push(tokio::spawn(async move {
            service
                .register(input(), scope(), Cancellation::default())
                .await
        }));
    }
    fixture.sessions.gate.wait(16).await;
    assert_category(
        fixture
            .service
            .register(input(), scope(), Cancellation::default())
            .await,
        Category::Busy,
    );
    fixture.sessions.gate.release.cancel();
    for task in pending {
        joined(task).await.unwrap();
    }
    assert_eq!(fixture.service.list(&scope()).unwrap().len(), 16);
    assert_category(
        fixture
            .service
            .register(input(), scope(), Cancellation::default())
            .await,
        Category::Busy,
    );
}

#[tokio::test]
async fn cancellation_releases_a_pending_registration_without_late_commit() {
    let fixture = Fixture::new();
    fixture.sessions.held.store(true, Ordering::Release);
    let cancellation = Cancellation::default();
    let signal = cancellation.clone();
    let service = fixture.service.clone();
    let task = tokio::spawn(async move { service.register(input(), scope(), signal).await });
    fixture.sessions.gate.wait(1).await;
    cancellation.cancel();
    assert_category(joined(task).await, Category::UpstreamUnavailable);
    fixture.sessions.gate.release.cancel();
    assert!(fixture.service.list(&scope()).unwrap().is_empty());
    fixture.register().await;
}

#[tokio::test]
async fn requests_validate_raw_paths_before_normalization_and_match_route_segments() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    for path in [
        "http://evil.invalid/app",
        "//evil.invalid/app",
        "/\\evil/app",
        "/app/../private",
        "/app/./x",
        "/app/%2e%2e/private",
        "/app/%252e%252e/private",
        "/app/%25252fprivate",
        "/app/%5cprivate",
        "/app/a%2Fb",
        "/app/%00",
        "/app/%250a",
        "/app/%",
        "/app/%zz",
        "/app/#x",
        "/app/\nx",
        "/app/%c0%afprivate",
        "/app/%25c0%25afprivate",
        "/app/%ed%a0%80",
        "/app-other",
        "/APP",
        "/app?x=%0d%0aInjected",
        "/app?x=%2500",
        "/app?x=%",
        "/app?x=#fragment",
    ] {
        let mut request = fixture.request(&app);
        request.path = path.into();
        assert_category(
            fixture
                .service
                .dispatch(request, Cancellation::default())
                .await,
            Category::Forbidden,
        );
    }
    let mut oversized = fixture.request(&app);
    oversized.path = format!("/app?x={}", "a".repeat(4096)).into();
    assert_category(
        fixture
            .service
            .dispatch(oversized, Cancellation::default())
            .await,
        Category::Forbidden,
    );
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
    let mut request = fixture.request(&app);
    request.path = "/app/%E2%98%83?q=a%2Fb&x=%E2%98%83&x=1+2".into();
    fixture
        .service
        .dispatch(request, Cancellation::default())
        .await
        .unwrap();
    assert_eq!(
        fixture.transport.requests.lock().unwrap()[0].url,
        "http://127.0.0.1:43210/app/%E2%98%83?q=a%2Fb&x=%E2%98%83&x=1+2"
    );
    let mut exact = input();
    exact.routes[0].match_kind = ycoding_schema::local_app::RouteMatch::Exact;
    exact.routes[0].path = "/app/index.html".into();
    exact.routes[0].methods = vec![Method::Get];
    let exact = fixture
        .service
        .register(exact, scope(), Cancellation::default())
        .await
        .unwrap();
    fixture
        .service
        .publish(&exact.id, &exact.generation, &scope(), None)
        .unwrap();
    let mut child = fixture.request(&exact);
    child.path = "/app/index.html/child".into();
    assert_category(
        fixture
            .service
            .dispatch(child, Cancellation::default())
            .await,
        Category::Forbidden,
    );
    let mut wrong_method = fixture.request(&exact);
    wrong_method.method = Method::Post;
    assert_category(
        fixture
            .service
            .dispatch(wrong_method, Cancellation::default())
            .await,
        Category::Forbidden,
    );
    let mut query = fixture.request(&exact);
    query.path = "/app/index.html?ok=1".into();
    fixture
        .service
        .dispatch(query, Cancellation::default())
        .await
        .unwrap();
}

#[tokio::test]
async fn grant_authorization_is_checked_at_both_boundaries_and_never_exposes_denial_details() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    fixture.authority.allowed.store(false, Ordering::Release);
    assert_category(
        fixture
            .service
            .dispatch(fixture.request(&app), Cancellation::default())
            .await,
        Category::UpstreamUnavailable,
    );
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
    fixture.authority.allowed.store(true, Ordering::Release);
    let authority = fixture.authority.clone();
    fixture
        .transport
        .replies
        .lock()
        .unwrap()
        .push_back(Incoming {
            status: 200,
            headers: BTreeMap::new(),
            body: future_body(async move {
                authority.allowed.store(false, Ordering::Release);
                Ok(b"private response".to_vec())
            }),
        });
    let before = fixture.authority.gate.calls.load(Ordering::Acquire);
    assert_category(
        fixture
            .service
            .dispatch(fixture.request(&app), Cancellation::default())
            .await,
        Category::UpstreamUnavailable,
    );
    assert_eq!(
        fixture.authority.gate.calls.load(Ordering::Acquire) - before,
        2
    );
    assert_eq!(fixture.transport.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn only_pinned_request_headers_and_verified_preview_origin_reach_upstream() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    fixture
        .service
        .publish(
            &app.id,
            &app.generation,
            &scope(),
            Some("https://preview.example"),
        )
        .unwrap();
    fixture
        .service
        .publish(&app.id, &app.generation, &scope(), None)
        .unwrap();
    assert_category(
        fixture.service.publish(
            &app.id,
            &app.generation,
            &scope(),
            Some("https://other.example"),
        ),
        Category::Forbidden,
    );
    for origin in [
        "https://preview.example/path",
        "https://user@preview.example",
        "http://public.example",
        "javascript:bad",
    ] {
        let other = fixture.register().await;
        assert_category(
            fixture
                .service
                .publish(&other.id, &other.generation, &scope(), Some(origin)),
            Category::Forbidden,
        );
    }
    let mut request = fixture.request(&app);
    request.method = Method::Post;
    request.body = Some(vec![0, 255, 137, 10]);
    request.headers = BTreeMap::from([
        ("Accept".into(), "image/png".into()),
        ("Accept-Language".into(), "en".into()),
        ("Content-Type".into(), "application/octet-stream".into()),
        ("Range".into(), "bytes=0-3".into()),
        ("If-Range".into(), "\"v0\"".into()),
        ("Origin".into(), "https://preview.example".into()),
        (
            "Referer".into(),
            "https://preview.example/app/index.html?q=1".into(),
        ),
        ("Authorization".into(), "Bearer synthetic".into()),
        ("Cookie".into(), "synthetic=1".into()),
        ("Host".into(), "elsewhere.invalid".into()),
        ("Forwarded".into(), "synthetic".into()),
        ("Proxy-Authorization".into(), "synthetic".into()),
        ("Connection".into(), "keep-alive".into()),
        ("X-Secret".into(), "synthetic".into()),
    ]);
    fixture
        .service
        .dispatch(request, Cancellation::default())
        .await
        .unwrap();
    assert_eq!(
        fixture.transport.requests.lock().unwrap()[0].headers,
        BTreeMap::from([
            ("accept".into(), "image/png".into()),
            ("accept-language".into(), "en".into()),
            ("content-type".into(), "application/octet-stream".into()),
            ("range".into(), "bytes=0-3".into()),
            ("if-range".into(), "\"v0\"".into()),
            ("origin".into(), "http://127.0.0.1:43210".into()),
            (
                "referer".into(),
                "http://127.0.0.1:43210/app/index.html?q=1".into()
            ),
            ("accept-encoding".into(), "identity".into())
        ])
    );
    let mut untrusted = fixture.request(&app);
    untrusted.headers = BTreeMap::from([
        ("origin".into(), "https://other.example".into()),
        (
            "referer".into(),
            "https://preview.example.evil.invalid/app".into(),
        ),
    ]);
    fixture
        .service
        .dispatch(untrusted, Cancellation::default())
        .await
        .unwrap();
    assert_eq!(
        fixture.transport.requests.lock().unwrap()[1].headers,
        BTreeMap::from([("accept-encoding".into(), "identity".into())])
    );
}

#[tokio::test]
async fn response_filtering_preserves_binary_security_and_representation_metadata() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    let preserved = BTreeMap::from([
        ("content-type".into(), "image/png".into()),
        ("cache-control".into(), "no-cache".into()),
        ("etag".into(), "\"v1\"".into()),
        (
            "last-modified".into(),
            "Wed, 01 Jan 2025 00:00:00 GMT".into(),
        ),
        ("accept-ranges".into(), "bytes".into()),
        ("content-range".into(), "bytes 0-3/4".into()),
        ("vary".into(), "Accept".into()),
        (
            "content-disposition".into(),
            "inline; filename=\"picture.png\"".into(),
        ),
        (
            "content-security-policy".into(),
            "default-src 'none'".into(),
        ),
        (
            "content-security-policy-report-only".into(),
            "default-src 'none'".into(),
        ),
        ("x-frame-options".into(), "DENY".into()),
        ("x-content-type-options".into(), "nosniff".into()),
        ("referrer-policy".into(), "no-referrer".into()),
        ("permissions-policy".into(), "camera=()".into()),
    ]);
    let mut headers = preserved.clone();
    headers.extend(BTreeMap::from([
        ("set-cookie".into(), "synthetic=1".into()),
        ("www-authenticate".into(), "Basic synthetic".into()),
        ("server".into(), "private".into()),
        ("x-powered-by".into(), "private".into()),
        ("connection".into(), "close".into()),
        ("x-secret".into(), "private".into()),
    ]));
    fixture
        .transport
        .replies
        .lock()
        .unwrap()
        .push_back(incoming(206, headers, vec![Ok(vec![0, 255, 137, 10])]));
    let response = fixture.send(&app).await;
    assert_eq!(response.status, 206);
    assert_eq!(response.body, [0, 255, 137, 10]);
    let mut expected = preserved;
    expected.insert("content-length".into(), "4".into());
    assert_eq!(response.headers, expected);
    fixture
        .transport
        .replies
        .lock()
        .unwrap()
        .push_back(incoming(
            200,
            BTreeMap::from([(
                "content-disposition".into(),
                "attachment; filename=\"../private\"".into(),
            )]),
            vec![],
        ));
    assert!(
        !fixture
            .send(&app)
            .await
            .headers
            .contains_key("content-disposition")
    );
}

#[tokio::test]
async fn head_and_empty_statuses_preserve_only_valid_unencoded_representation_lengths() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    for (status, encoding, length, expected) in [
        (200, false, "37", Some("37")),
        (200, true, "37", None),
        (204, false, "37", None),
        (205, false, "37", None),
        (200, false, "01", None),
    ] {
        let mut headers = BTreeMap::from([("content-length".into(), length.into())]);
        if encoding {
            headers.insert("content-encoding".into(), "gzip".into());
        }
        fixture
            .transport
            .replies
            .lock()
            .unwrap()
            .push_back(incoming(status, headers, vec![]));
        let mut request = fixture.request(&app);
        request.method = Method::Head;
        let response = fixture
            .service
            .dispatch(request, Cancellation::default())
            .await
            .unwrap();
        assert!(response.body.is_empty());
        assert_eq!(
            response.headers.get("content-length").map(String::as_str),
            expected
        );
    }
    for status in [204, 304] {
        fixture
            .transport
            .replies
            .lock()
            .unwrap()
            .push_back(incoming(status, BTreeMap::new(), vec![]));
        let response = fixture.send(&app).await;
        assert_eq!(response.status, status);
        assert!(!response.headers.contains_key("content-length"));
    }
}

#[tokio::test]
async fn redirects_are_filtered_by_registered_origin_path_and_effective_method() {
    let fixture = Fixture::new();
    let mut registration = input();
    registration.routes[0].methods = vec![Method::Get, Method::Head];
    let app = fixture
        .service
        .register(registration, scope(), Cancellation::default())
        .await
        .unwrap();
    fixture
        .service
        .publish(&app.id, &app.generation, &scope(), None)
        .unwrap();
    for (status, location, expected) in [
        (302, "index.html?q=a%2Fb", Some("/app/index.html?q=a%2Fb")),
        (307, "http://127.0.0.1:43210/app/api", Some("/app/api")),
        (302, "http://127.0.0.1:43211/app/api", None),
        (302, "//elsewhere.invalid/app", None),
        (302, "/private", None),
        (302, "/app/%2e%2e/private", None),
        (302, "https://elsewhere.invalid/app", None),
        (302, "/app/#fragment", None),
    ] {
        fixture
            .transport
            .replies
            .lock()
            .unwrap()
            .push_back(incoming(
                status,
                BTreeMap::from([("location".into(), location.into())]),
                vec![],
            ));
        let result = fixture
            .service
            .dispatch(fixture.request(&app), Cancellation::default())
            .await;
        if let Some(expected) = expected {
            assert_eq!(result.unwrap().headers["location"], expected);
        } else {
            assert_category(result, Category::RedirectRejected);
        }
    }
    let mut registration = input();
    registration.routes = decode(
        json!([{"path":"/app/index.html","match":"exact","methods":["POST"]},{"path":"/app/target","match":"exact","methods":["GET"]}]),
    );
    registration.entry_path = "/app/target".into();
    let app = fixture
        .service
        .register(registration, scope(), Cancellation::default())
        .await
        .unwrap();
    fixture
        .service
        .publish(&app.id, &app.generation, &scope(), None)
        .unwrap();
    for status in [301, 302, 303, 307, 308] {
        fixture
            .transport
            .replies
            .lock()
            .unwrap()
            .push_back(incoming(
                status,
                BTreeMap::from([("location".into(), "/app/target".into())]),
                vec![],
            ));
        let mut request = fixture.request(&app);
        request.method = Method::Post;
        let result = fixture
            .service
            .dispatch(request, Cancellation::default())
            .await;
        if [301, 302, 303].contains(&status) {
            assert_eq!(result.unwrap().headers["location"], "/app/target");
        } else {
            assert_category(result, Category::RedirectRejected);
        }
    }
}

#[tokio::test]
async fn request_response_stream_and_upgrade_limits_fail_without_truncation() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    for method in [Method::Get, Method::Head] {
        let mut request = fixture.request(&app);
        request.method = method;
        request.body = Some(vec![]);
        assert_category(
            fixture
                .service
                .dispatch(request, Cancellation::default())
                .await,
            Category::Forbidden,
        );
    }
    let mut oversized = fixture.request(&app);
    oversized.method = Method::Post;
    oversized.body = Some(vec![0; 256 * 1024 + 1]);
    assert_category(
        fixture
            .service
            .dispatch(oversized, Cancellation::default())
            .await,
        Category::TooLarge,
    );
    for (key, value) in [
        ("upgrade", "websocket"),
        ("connection", "keep-alive, Upgrade"),
    ] {
        let mut request = fixture.request(&app);
        request.headers.insert(key.into(), value.into());
        assert_category(
            fixture
                .service
                .dispatch(request, Cancellation::default())
                .await,
            Category::UnsupportedStream,
        );
    }
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
    for (key, value) in [("bad key", "value"), ("x-extra", "value\r\nInjected: true")] {
        let mut request = fixture.request(&app);
        request.headers.insert(key.into(), value.into());
        assert_category(
            fixture
                .service
                .dispatch(request, Cancellation::default())
                .await,
            Category::Forbidden,
        );
    }
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
    for (status, headers, chunks, category) in [
        (101, BTreeMap::new(), vec![], Category::UnsupportedStream),
        (
            200,
            BTreeMap::from([(
                "content-type".into(),
                " Text/Event-Stream ; charset=utf-8".into(),
            )]),
            vec![],
            Category::UnsupportedStream,
        ),
        (
            200,
            BTreeMap::from([("content-length".into(), (2 * 1024 * 1024 + 1).to_string())]),
            vec![],
            Category::TooLarge,
        ),
        (
            200,
            BTreeMap::new(),
            vec![Ok(vec![0; 2 * 1024 * 1024]), Ok(vec![1])],
            Category::TooLarge,
        ),
        (
            200,
            BTreeMap::new(),
            vec![Err(failure(Category::UpstreamUnavailable))],
            Category::UpstreamUnavailable,
        ),
    ] {
        fixture
            .transport
            .replies
            .lock()
            .unwrap()
            .push_back(incoming(status, headers, chunks));
        assert_category(
            fixture
                .service
                .dispatch(fixture.request(&app), Cancellation::default())
                .await,
            category,
        );
    }
    fixture
        .transport
        .replies
        .lock()
        .unwrap()
        .push_back(incoming(
            200,
            BTreeMap::new(),
            vec![Ok(vec![255; 2 * 1024 * 1024])],
        ));
    let mut exact = fixture.request(&app);
    exact.method = Method::Post;
    exact.body = Some(vec![137; 256 * 1024]);
    let response = fixture
        .service
        .dispatch(exact, Cancellation::default())
        .await
        .unwrap();
    assert_eq!(response.body.len(), 2 * 1024 * 1024);
    assert_eq!(
        fixture
            .transport
            .requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .body
            .as_ref()
            .unwrap()
            .len(),
        256 * 1024
    );
    fixture.transport.failed.store(true, Ordering::Release);
    let before = fixture.transport.requests.lock().unwrap().len();
    let mut post = fixture.request(&app);
    post.method = Method::Post;
    assert_category(
        fixture
            .service
            .dispatch(post, Cancellation::default())
            .await,
        Category::UpstreamUnavailable,
    );
    assert_eq!(fixture.transport.requests.lock().unwrap().len(), before + 1);
}

#[tokio::test]
async fn concurrency_limits_fail_busy_without_queueing_and_recover_after_cancellation() {
    let fixture = Fixture::new();
    fixture.transport.held.store(true, Ordering::Release);
    let apps = [
        fixture.add().await,
        fixture.add().await,
        fixture.add().await,
        fixture.add().await,
        fixture.add().await,
    ];
    let mut tasks = Vec::new();
    for app in &apps[..4] {
        for _ in 0..4 {
            let service = fixture.service.clone();
            let request = fixture.request(app);
            tasks.push(tokio::spawn(async move {
                service.dispatch(request, Cancellation::default()).await
            }));
        }
    }
    fixture.transport.gate.wait(16).await;
    for app in [&apps[0], &apps[4]] {
        assert_category(
            fixture
                .service
                .dispatch(fixture.request(app), Cancellation::default())
                .await,
            Category::Busy,
        );
    }
    assert_eq!(fixture.transport.requests.lock().unwrap().len(), 16);
    tokio::time::timeout(Duration::from_secs(2), fixture.service.clear())
        .await
        .unwrap();
    for task in tasks {
        assert_category(joined(task).await, Category::UpstreamUnavailable);
    }
    fixture.transport.gate.release.cancel();
    fixture.send(&fixture.add().await).await;
}

#[tokio::test]
async fn per_app_capacity_covers_authorization_and_does_not_block_another_app() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    let other = fixture.add().await;
    fixture.authority.hold_at.store(1, Ordering::Release);
    fixture.transport.held.store(true, Ordering::Release);
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let service = fixture.service.clone();
        let request = fixture.request(&app);
        tasks.push(tokio::spawn(async move {
            service.dispatch(request, Cancellation::default()).await
        }));
    }
    fixture.authority.gate.wait(4).await;
    fixture.transport.gate.wait(3).await;
    assert_category(
        fixture
            .service
            .dispatch(fixture.request(&app), Cancellation::default())
            .await,
        Category::Busy,
    );
    assert_eq!(fixture.authority.gate.calls.load(Ordering::Acquire), 4);
    let service = fixture.service.clone();
    let request = fixture.request(&other);
    tasks.push(tokio::spawn(async move {
        service.dispatch(request, Cancellation::default()).await
    }));
    fixture.transport.gate.wait(4).await;
    tokio::time::timeout(Duration::from_secs(2), fixture.service.clear())
        .await
        .unwrap();
    for task in tasks {
        assert_category(joined(task).await, Category::UpstreamUnavailable);
    }
}

#[tokio::test]
async fn cancelled_authority_permit_aborts_an_inflight_body_without_a_second_contact() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    let entered = Arc::new(Notify::new());
    let notified = entered.clone();
    fixture
        .transport
        .replies
        .lock()
        .unwrap()
        .push_back(Incoming {
            status: 200,
            headers: BTreeMap::new(),
            body: future_body(async move {
                notified.notify_one();
                std::future::pending().await
            }),
        });
    let service = fixture.service.clone();
    let request = fixture.request(&app);
    let task =
        tokio::spawn(async move { service.dispatch(request, Cancellation::default()).await });
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    fixture.authority.permit.cancel();
    assert_category(joined(task).await, Category::UpstreamUnavailable);
    assert_eq!(fixture.transport.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn revoke_expiry_clear_close_and_caller_abort_cancel_stalled_body_reads() {
    for action in ["revoke", "expiry", "clear", "close", "caller"] {
        let fixture = Fixture::new();
        let app = fixture.add().await;
        let entered = Arc::new(Notify::new());
        let notified = entered.clone();
        fixture
            .transport
            .replies
            .lock()
            .unwrap()
            .push_back(Incoming {
                status: 200,
                headers: BTreeMap::new(),
                body: future_body(async move {
                    notified.notify_one();
                    std::future::pending().await
                }),
            });
        let service = fixture.service.clone();
        let request = fixture.request(&app);
        let cancellation = Cancellation::default();
        let signal = cancellation.clone();
        let task = tokio::spawn(async move { service.dispatch(request, signal).await });
        tokio::time::timeout(Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        match action {
            "revoke" => fixture.service.revoke(&app.id, &scope()).unwrap(),
            "expiry" => {
                fixture.clock.store(app.expires_at, Ordering::Release);
                fixture.service.sweep();
            }
            "clear" => fixture.service.clear().await,
            "close" => fixture.service.close().await,
            _ => cancellation.cancel(),
        };
        assert_category(joined(task).await, Category::UpstreamUnavailable);
    }
}

#[tokio::test]
async fn authority_stalls_and_expired_permits_are_cancellable_at_each_boundary() {
    for boundary in [1, 2] {
        let fixture = Fixture::new();
        let app = fixture.add().await;
        fixture.authority.hold_at.store(boundary, Ordering::Release);
        let signal = Cancellation::default();
        let caller = signal.clone();
        let service = fixture.service.clone();
        let request = fixture.request(&app);
        let task = tokio::spawn(async move { service.dispatch(request, signal).await });
        fixture.authority.gate.wait(boundary).await;
        caller.cancel();
        assert_category(joined(task).await, Category::UpstreamUnavailable);
        assert_eq!(
            fixture.transport.requests.lock().unwrap().len(),
            boundary - 1
        );
    }
    let fixture = Fixture::new();
    let app = fixture.add().await;
    fixture.authority.hold_at.store(1, Ordering::Release);
    let service = fixture.service.clone();
    let request = fixture.request(&app);
    let pending =
        tokio::spawn(async move { service.dispatch(request, Cancellation::default()).await });
    fixture.authority.gate.wait(1).await;
    fixture.clock.store(app.expires_at, Ordering::Release);
    fixture.authority.gate.release.cancel();
    assert_category(joined(pending).await, Category::UpstreamUnavailable);
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
    let fixture = Fixture::new();
    let app = fixture.add().await;
    fixture.authority.permit.cancel();
    assert_category(
        fixture
            .service
            .dispatch(fixture.request(&app), Cancellation::default())
            .await,
        Category::UpstreamUnavailable,
    );
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn remaining_registration_lifetime_bounds_noncooperative_authorization() {
    let fixture = Fixture::new();
    let mut registration = input();
    registration.ttl_ms = Some(20);
    let app = fixture
        .service
        .register(registration, scope(), Cancellation::default())
        .await
        .unwrap();
    fixture
        .service
        .publish(&app.id, &app.generation, &scope(), None)
        .unwrap();
    fixture.authority.hold_at.store(1, Ordering::Release);
    assert_category(
        tokio::time::timeout(
            Duration::from_secs(2),
            fixture
                .service
                .dispatch(fixture.request(&app), Cancellation::default()),
        )
        .await
        .unwrap(),
        Category::UpstreamUnavailable,
    );
    assert!(fixture.transport.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn literal_ipv6_uses_a_bracketed_loopback_origin_without_resolving_a_hostname() {
    let fixture = Fixture::new();
    let mut registration = input();
    registration.host = Host::V6;
    let app = fixture
        .service
        .register(registration, scope(), Cancellation::default())
        .await
        .unwrap();
    fixture
        .service
        .publish(&app.id, &app.generation, &scope(), None)
        .unwrap();
    fixture.send(&app).await;
    assert_eq!(
        fixture.transport.requests.lock().unwrap()[0].url,
        "http://[::1]:43210/app/index.html"
    );
}

#[tokio::test]
async fn constructing_close_revokes_access_and_cancels_work_before_the_future_is_polled() {
    let fixture = Fixture::new();
    let app = fixture.add().await;
    fixture.transport.held.store(true, Ordering::Release);
    let service = fixture.service.clone();
    let request = fixture.request(&app);
    let task =
        tokio::spawn(async move { service.dispatch(request, Cancellation::default()).await });
    fixture.transport.gate.wait(1).await;
    let closing = fixture.service.close();
    assert!(fixture.service.list(&scope()).unwrap().is_empty());
    assert_category(
        fixture
            .service
            .publish(&app.id, &app.generation, &scope(), None),
        Category::NotFound,
    );
    assert_category(
        fixture
            .service
            .register(input(), scope(), Cancellation::default())
            .await,
        Category::NotFound,
    );
    assert_category(
        fixture
            .service
            .dispatch(fixture.request(&app), Cancellation::default())
            .await,
        Category::NotFound,
    );
    assert_category(joined(task).await, Category::UpstreamUnavailable);
    tokio::time::timeout(Duration::from_secs(2), closing)
        .await
        .unwrap();
}
