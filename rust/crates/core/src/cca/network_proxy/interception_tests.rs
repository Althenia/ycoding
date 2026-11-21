use super::interception::{
    BodyFraming, TunnelTransport, classify_tunnel, raw_path_of, read_request_head,
};
use super::*;
use crate::cca::credential_broker::{CredentialBrokerCache, CredentialBrokerKey};
use crate::cca::value::os_text;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn provider() -> CredentialProviderConfig {
    CredentialProviderConfig {
        env: vec!["VENDOR_TOKEN".into()],
        patterns: vec!["vendor_[a-z]{8}".into()],
        url_prefixes: vec!["http://127.0.0.1:8080/api".into()],
        url_prefix_from_env: None,
        auth: vec![CredentialAuthMethod::Header],
        header: Some("X-Vendor-Key".into()),
        prefix: Some("Key ".into()),
    }
}

fn test_rustls_client_config(roots: rustls::RootCertStore) -> Arc<rustls::ClientConfig> {
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

async fn parse(bytes: &[u8]) -> Option<interception::RequestHead> {
    let mut input = bytes;
    read_request_head(&mut input).await
}

#[tokio::test]
async fn parser_preserves_raw_order_latin1_and_preread_body() {
    let head = parse(b"POST /api?q=1 HTTP/1.1\r\nX-A: first\r\nx-a: second\r\nX-Byte: \xff\r\nContent-Length: 4\r\n\r\nbodyNEXT").await.unwrap();
    assert_eq!(head.headers[0], ("X-A".into(), "first".into()));
    assert_eq!(head.headers[1], ("x-a".into(), "second".into()));
    assert_eq!(
        head.headers[2].1.code_units().collect::<Vec<_>>(),
        vec![255]
    );
    assert_eq!(head.rest, b"bodyNEXT");
    assert_eq!(head.framing, BodyFraming::Length(4));
}

#[tokio::test]
async fn parser_rejects_ambiguous_framing_and_header_injection() {
    for bytes in [
        &b"POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n"[..],
        &b"POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n"[..],
        &b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked, gzip\r\n\r\n"[..],
        &b"POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n"[..],
        &b"POST / HTTP/1.1\r\nContent-Length: 4\r\nConnection: Content-Length\r\n\r\n"[..],
        &b"GET / HTTP/1.1\r\n Host: bad\r\n\r\n"[..],
        &b"GET / HTTP/1.1\r\nX: a\nb\r\n\r\n"[..],
    ] {
        assert!(parse(bytes).await.is_none());
    }
    let mut oversized = b"GET / HTTP/1.1\r\nX: ".to_vec();
    oversized.extend(vec![b'a'; MAX_REQUEST_HEAD_BYTES]);
    oversized.extend_from_slice(b"\r\n\r\n");
    assert!(parse(&oversized).await.is_none());
}

#[tokio::test]
async fn streaming_body_stops_before_pipelined_request() {
    for (framing, chunks, expected) in [
        (
            BodyFraming::Length(4),
            vec![b"bo".to_vec(), b"dyGET /next HTTP/1.1\r\n\r\n".to_vec()],
            b"body".to_vec(),
        ),
        (
            BodyFraming::Chunked,
            vec![
                b"4;ext=x\r\nbo".to_vec(),
                b"dy\r\n0\r\nX-End: yes\r\n\r\nGET /next HTTP/1.1\r\n\r\n".to_vec(),
            ],
            b"4;ext=x\r\nbody\r\n0\r\nX-End: yes\r\n\r\n".to_vec(),
        ),
    ] {
        let (mut sender, receiver) = tokio::io::duplex(4096);
        let (mut output, mut capture) = tokio::io::duplex(4096);
        let writer = tokio::spawn(async move {
            for chunk in chunks {
                sender.write_all(&chunk).await.unwrap();
            }
            sender.shutdown().await.unwrap();
        });
        interception::forward_body(
            &mut tokio::io::BufReader::new(receiver),
            &mut output,
            framing,
        )
        .await
        .unwrap();
        output.shutdown().await.unwrap();
        let mut actual = vec![];
        capture.read_to_end(&mut actual).await.unwrap();
        assert_eq!(actual, expected);
        writer.await.unwrap();
    }
}

#[tokio::test]
async fn truncated_and_forbidden_chunk_trailers_fail() {
    for bytes in [
        &b"4\r\nabc"[..],
        &b"0\r\nContent-Length: 8\r\n\r\n"[..],
        &b"z\r\n"[..],
    ] {
        let mut source = tokio::io::BufReader::new(bytes);
        assert!(
            interception::forward_body(&mut source, &mut tokio::io::sink(), BodyFraming::Chunked)
                .await
                .is_err()
        );
    }
}

#[test]
fn connect_and_socks_classification_preserves_opaque_and_limited_guards() {
    let both = BrokeredProtocols {
        tls: true,
        http: true,
    };
    assert_eq!(
        classify_tunnel(b"\x16\x03\x03", TunnelMode::Detect, both, NetworkMode::Full),
        TunnelTransport::Tls
    );
    assert_eq!(
        classify_tunnel(b"POST /api ", TunnelMode::Detect, both, NetworkMode::Full),
        TunnelTransport::Http
    );
    assert_eq!(
        classify_tunnel(b"SSH-2.0", TunnelMode::Detect, both, NetworkMode::Full),
        TunnelTransport::Opaque
    );
    assert_eq!(
        classify_tunnel(b"SSH-2.0", TunnelMode::Detect, both, NetworkMode::Limited),
        TunnelTransport::Reject
    );
    assert_eq!(
        classify_tunnel(b"GET /", TunnelMode::Disabled, both, NetworkMode::Full),
        TunnelTransport::Opaque
    );
}

#[test]
fn configured_headers_restore_only_raw_allowed_destinations_in_order() {
    let mut cache = CredentialBrokerCache::new();
    let entry = cache
        .broker_for(&CredentialBrokerKey {
            environment_id: Some(LosslessString::from_utf16(vec![0xd800])),
            conversation_id: None,
            providers: vec![("vendor".into(), provider())],
        })
        .unwrap();
    let masked = entry
        .broker
        .mask_environment(&[("VENDOR_TOKEN".into(), "vendor_abcdefgh".into())])
        .unwrap();
    let dummy = env_get(&masked.env, "VENDOR_TOKEN").unwrap();
    let headers = vec![
        ("X-Order".into(), "first".into()),
        ("X-Vendor-Key".into(), concat(&[&"Key ".into(), dummy])),
        ("X-Order".into(), "last".into()),
        ("Authorization".into(), concat(&[&"Bearer ".into(), dummy])),
    ];
    for (target, restored) in [
        ("http://127.0.0.1:8080/api/items", true),
        ("http://127.0.0.1:8080/other", false),
        ("http://127.0.0.1:8080/api/../other", false),
        ("http://127.0.0.1:8080/api%2fitems", false),
        ("http://127.0.0.1:8081/api/items", false),
        ("http://other.example:8080/api/items", false),
    ] {
        let actual = entry.broker.restore_request_headers(
            &url::Url::parse(target).unwrap(),
            &raw_path_of(target),
            &headers,
        );
        if restored {
            assert_eq!(
                actual,
                vec![
                    headers[0].clone(),
                    headers[2].clone(),
                    headers[3].clone(),
                    ("x-vendor-key".into(), "Key vendor_abcdefgh".into()),
                ]
            );
        } else {
            assert_eq!(actual, headers);
        }
    }
    assert_eq!(
        entry.broker.restore_environment(&masked.env),
        vec![("VENDOR_TOKEN".into(), "vendor_abcdefgh".into())]
    );
    let text = concat(&[
        &LosslessString::from_utf16(vec![0xd800]),
        &" vendor_abcdefgh".into(),
    ]);
    assert_eq!(
        entry.broker.restore_text(&entry.broker.mask_text(&text)),
        text
    );
}

#[test]
fn canonical_startup_selection_does_not_rewrite_commands() {
    let bash = NetworkProxyCommand {
        argv: vec!["/bin/bash".into(), "-c".into(), "true".into()],
        arg0: None,
        shell_snapshot_shell_name: None,
    };
    assert_eq!(
        masking_startup(Some(&bash), &[], Platform::Linux),
        CredentialMaskingState::Enabled
    );
    for key in ["BASH_ENV", "ENV", "SSH_CLIENT", "SSH2_CLIENT"] {
        assert_eq!(
            masking_startup(Some(&bash), &[(key.into(), "".into())], Platform::Linux),
            CredentialMaskingState::Unavailable
        );
    }
    let mut changed = bash.clone();
    changed.arg0 = Some(LosslessString::from_utf16(vec![0xd800]));
    assert_eq!(
        masking_startup(Some(&changed), &[], Platform::Linux),
        CredentialMaskingState::Unavailable
    );
    changed = bash;
    changed.argv[1] = "-lc".into();
    assert_eq!(
        masking_startup(Some(&changed), &[], Platform::Linux),
        CredentialMaskingState::Unavailable
    );
    let zsh = NetworkProxyCommand {
        argv: vec!["/bin/zsh".into(), "-lc".into(), "true".into()],
        arg0: None,
        shell_snapshot_shell_name: Some(("zsh".into(), "/bin/zsh".into())),
    };
    assert_eq!(
        masking_startup(Some(&zsh), &[], Platform::Darwin),
        CredentialMaskingState::Snapshot
    );
    assert_eq!(
        masking_startup(Some(&zsh), &[], Platform::Windows),
        CredentialMaskingState::Unavailable
    );
}

fn options(masking: bool) -> StartNetworkProxyOptions {
    StartNetworkProxyOptions {
        process_id: LosslessString::from_utf16(vec![112, 0xd800]),
        launch: RemoteNetworkProxyLaunchConfig {
            proxy: RemoteNetworkProxyConfig {
                enabled: true,
                credential_masking: masking,
                credential_providers: vec![],
                enable_socks5: true,
                enable_socks5_udp: false,
                allow_upstream_proxy: false,
                dangerously_allow_all_unix_sockets: false,
                mode: NetworkMode::Full,
                domains: Some(vec![("127.0.0.1".into(), DomainPermission::Allow)]),
                review_domains: vec![],
                unix_sockets: None,
                allow_local_binding: false,
            },
            audit_metadata: NetworkProxyAuditMetadata::default(),
            environment_id: Some(LosslessString::from_utf16(vec![101, 0xd800])),
            execution_id: None,
            policy_decision_timeout_ms: None,
        },
        env: vec![],
        authorize: Arc::new(|_| Box::pin(async { Ok(Grant::noop()) })),
        decider: None,
        on_policy_decision: None,
        ca_directory: None,
        upstream_trust: None,
        credential_brokers: Some(Arc::new(Mutex::new(CredentialBrokerCache::new()))),
        command: Some(NetworkProxyCommand {
            argv: vec!["/bin/bash".into(), "-c".into(), "true".into()],
            arg0: None,
            shell_snapshot_shell_name: None,
        }),
        lookup: None,
        platform: Platform::Linux,
    }
}

fn masking_options(
    roots: rustls::RootCertStore,
    certificates_pem: Vec<String>,
) -> (StartNetworkProxyOptions, std::path::PathBuf) {
    let mut options = options(true);
    let directory = std::env::temp_dir().join(format!(
        "ycoding-cca-interception-{}",
        crate::cca::encoding::uuid_v4()
    ));
    options.ca_directory = Some(directory.clone());
    options.upstream_trust = Some(NetworkProxyUpstreamTrust {
        authority: Arc::new(MitmAuthority::issue().unwrap()),
        roots,
        certificates_pem,
        startup_values: vec![],
    });
    (options, directory)
}

async fn roundtrip(port: u16, request: &[u8]) -> Vec<u8> {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket.write_all(request).await.unwrap();
    let mut bytes = vec![];
    socket.read_to_end(&mut bytes).await.unwrap();
    bytes
}

#[tokio::test]
async fn disabled_launch_preserves_credentials_trust_and_lossless_identity_metadata() {
    let upstream = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = upstream.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = upstream.accept().await.unwrap();
        let head = read_request_head(&mut socket).await.unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
        head.headers
    });
    let seen = Arc::new(Mutex::new(vec![]));
    let mut options = options(false);
    let identity = options.process_id.clone();
    options.env = vec![
        ("OPENAI_API_KEY".into(), "synthetic-unmasked".into()),
        ("SSL_CERT_FILE".into(), "/synthetic/original.pem".into()),
        (
            LosslessString::from_utf16(vec![0xd800]),
            LosslessString::from_utf16(vec![0xdc00]),
        ),
    ];
    let recorded = seen.clone();
    options.authorize = Arc::new(move |input| {
        recorded.lock().unwrap().push(input);
        Box::pin(async { Ok(Grant::noop()) })
    });
    let handle = start_network_proxy(options).await.unwrap();
    assert_eq!(handle.credential_masking, CredentialMaskingState::Disabled);
    assert_eq!(
        env_get(&handle.env, "OPENAI_API_KEY"),
        Some(&"synthetic-unmasked".into())
    );
    assert_eq!(
        env_get(&handle.env, "SSL_CERT_FILE"),
        Some(&"/synthetic/original.pem".into())
    );
    assert!(handle.env.contains(&(
        LosslessString::from_utf16(vec![0xd800]),
        LosslessString::from_utf16(vec![0xdc00])
    )));
    assert!(handle.child_trust.is_none());
    let response = roundtrip(
        handle.managed_network.loopback_ports[0],
        format!("GET http://127.0.0.1:{port}/api HTTP/1.1\r\nX-A: first\r\nX-A: last\r\n\r\n")
            .as_bytes(),
    )
    .await;
    assert!(response.starts_with(b"HTTP/1.1 200"));
    let headers = server.await.unwrap();
    assert_eq!(
        headers
            .iter()
            .filter(|(name, _)| header_is(name, "x-a"))
            .cloned()
            .collect::<Vec<_>>(),
        vec![
            ("X-A".into(), "first".into()),
            ("X-A".into(), "last".into())
        ]
    );
    let metadata = seen.lock().unwrap()[0].metadata.clone().unwrap();
    assert_eq!(
        metadata.get(&"processId".into()),
        Some(&Value::String(identity))
    );
    handle.close().await;
    handle.close().await;
    assert!(
        TcpStream::connect(("127.0.0.1", handle.managed_network.loopback_ports[0]))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn masking_missing_roots_is_explicit_and_does_not_downgrade() {
    let error = start_network_proxy(options(true)).await.err().unwrap();
    assert_eq!(error.code, -32603);
    assert_eq!(
        error.message,
        LosslessString::from(
            "credential masking requires an explicit broker cache, upstream roots and CA directory"
        )
    );
}

#[tokio::test]
async fn tls_connect_and_socks_restore_only_after_validated_upstream_handshake() {
    let upstream_ca = Arc::new(MitmAuthority::issue().unwrap());
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = upstream_ca.server_config_for_host("127.0.0.1").unwrap();
    let server = tokio::spawn(async move {
        let mut requests = vec![];
        for _ in 0..2 {
            let (socket, _) = listener.accept().await.unwrap();
            let mut secure = tokio_rustls::TlsAcceptor::from(config.clone())
                .accept(socket)
                .await
                .unwrap();
            let head = read_request_head(&mut secure).await.unwrap();
            requests.push(head.headers);
            secure
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
            secure.shutdown().await.unwrap();
        }
        requests
    });
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(
            upstream_ca.certificate_der().to_vec(),
        ))
        .unwrap();
    let (mut options, directory) =
        masking_options(roots, vec![upstream_ca.certificate_pem().into()]);
    let proxy_ca = options.upstream_trust.as_ref().unwrap().authority.clone();
    let mut configured = provider();
    configured.url_prefixes = vec![format!("https://127.0.0.1:{port}/api").into()];
    options.launch.proxy.credential_providers = vec![("vendor".into(), configured)];
    options.env = vec![("VENDOR_TOKEN".into(), "vendor_abcdefgh".into())];
    let handle = start_network_proxy(options).await.unwrap();
    let dummy = os_text(env_get(&handle.env, "VENDOR_TOKEN").unwrap());
    assert_ne!(dummy, "vendor_abcdefgh");
    assert_eq!(
        handle
            .shared
            .broker
            .as_ref()
            .unwrap()
            .broker
            .mask_text(&"vendor_abcdefgh".into()),
        LosslessString::from(dummy.clone())
    );
    let bundle = tokio::fs::read_to_string(&handle.child_trust.as_ref().unwrap().bundle_path)
        .await
        .unwrap();
    assert!(bundle.contains(upstream_ca.certificate_pem().trim()));
    assert!(bundle.contains(proxy_ca.certificate_pem().trim()));
    assert!(!bundle.contains("PRIVATE KEY"));
    for key in CUSTOM_CA_ENV_KEYS {
        assert_eq!(
            env_get(&handle.env, key).unwrap().as_str(),
            handle.child_trust.as_ref().unwrap().bundle_path.to_str()
        );
    }
    let mut client_roots = rustls::RootCertStore::empty();
    client_roots
        .add(rustls::pki_types::CertificateDer::from(
            proxy_ca.certificate_der().to_vec(),
        ))
        .unwrap();
    let connector = tokio_rustls::TlsConnector::from(test_rustls_client_config(client_roots));
    for socks in [false, true] {
        let proxy_port = handle.managed_network.loopback_ports[if socks { 1 } else { 0 }];
        let mut socket = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
        if socks {
            socket.write_all(&[5, 1, 0]).await.unwrap();
            let mut method = [0u8; 2];
            socket.read_exact(&mut method).await.unwrap();
            assert_eq!(method, [5, 0]);
            let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
            request.extend_from_slice(&port.to_be_bytes());
            socket.write_all(&request).await.unwrap();
            let mut reply = [0u8; 10];
            socket.read_exact(&mut reply).await.unwrap();
            assert_eq!(reply[1], 0);
        } else {
            socket
                .write_all(
                    format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
            let mut reply = vec![0u8; b"HTTP/1.1 200 Connection established\r\n\r\n".len()];
            socket.read_exact(&mut reply).await.unwrap();
            assert_eq!(reply, b"HTTP/1.1 200 Connection established\r\n\r\n");
        }
        let mut secure = connector
            .connect(
                crate::cca::mitm_ca::upstream_server_name("127.0.0.1").unwrap(),
                socket,
            )
            .await
            .unwrap();
        secure.write_all(format!("GET /api/items HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Vendor-Key: Key {dummy}\r\nAuthorization: Bearer {dummy}\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = vec![];
        secure.read_to_end(&mut response).await.unwrap();
        assert!(response.starts_with(b"HTTP/1.1 200"));
    }
    let requests = server.await.unwrap();
    for headers in requests {
        assert_eq!(
            headers
                .iter()
                .find(|(name, _)| header_is(name, "x-vendor-key"))
                .unwrap()
                .1,
            LosslessString::from("Key vendor_abcdefgh")
        );
        assert_eq!(
            headers
                .iter()
                .find(|(name, _)| header_is(name, "authorization"))
                .unwrap()
                .1,
            LosslessString::from(format!("Bearer {dummy}"))
        );
    }
    handle.close().await;
    tokio::fs::remove_dir_all(directory).await.unwrap();
}

#[tokio::test]
async fn upstream_validation_rejects_unknown_issuer_and_wrong_hostname() {
    let authority = MitmAuthority::issue().unwrap();
    let config = authority.server_config_for_host("allowed.example").unwrap();
    for (trusted, hostname, succeeds) in [
        (true, "allowed.example", true),
        (false, "allowed.example", false),
        (true, "other.example", false),
    ] {
        let mut roots = rustls::RootCertStore::empty();
        if trusted {
            roots
                .add(rustls::pki_types::CertificateDer::from(
                    authority.certificate_der().to_vec(),
                ))
                .unwrap();
        }
        let (client, server) = tokio::io::duplex(16 * 1024);
        let acceptor = tokio_rustls::TlsAcceptor::from(config.clone());
        let connector = tokio_rustls::TlsConnector::from(test_rustls_client_config(roots));
        let name = crate::cca::mitm_ca::upstream_server_name(hostname).unwrap();
        let (accepted, connected) =
            tokio::join!(acceptor.accept(server), connector.connect(name, client));
        assert_eq!(connected.is_ok(), succeeds);
        assert_eq!(accepted.is_ok(), succeeds);
    }
}

#[test]
fn child_ca_is_never_inserted_into_upstream_bundle() {
    let proxy = MitmAuthority::issue().unwrap();
    let upstream = MitmAuthority::issue().unwrap();
    let roots = vec![
        upstream.certificate_pem().replace('\n', "\r\n"),
        upstream.certificate_pem().into(),
    ];
    let original = roots.clone();
    let bundle = proxy.child_bundle_pem(&roots).unwrap();
    assert_eq!(roots, original);
    assert_eq!(bundle.matches("-----BEGIN CERTIFICATE-----").count(), 2);
    assert!(bundle.ends_with(proxy.certificate_pem()));
    assert!(
        proxy
            .child_bundle_pem(&[proxy.certificate_pem().into()])
            .is_err()
    );
}

#[tokio::test]
async fn denied_destinations_never_authorize_or_restore_headers() {
    let authorizations = Arc::new(AtomicUsize::new(0));
    let calls = authorizations.clone();
    let mut options = options(false);
    options.authorize = Arc::new(move |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(Grant::noop()) })
    });
    let handle = start_network_proxy(options).await.unwrap();
    let response = roundtrip(handle.managed_network.loopback_ports[0], b"GET http://denied.example/api HTTP/1.1\r\nAuthorization: Bearer synthetic-placeholder\r\n\r\n").await;
    assert!(response.starts_with(b"HTTP/1.1 403"));
    assert_eq!(authorizations.load(Ordering::SeqCst), 0);
    handle.close().await;
}

#[tokio::test]
async fn close_cancels_partial_heads_and_pending_authorization() {
    let started = Arc::new(Notify::new());
    let arrived = started.clone();
    let mut options = options(false);
    options.authorize = Arc::new(move |_| {
        let arrived = arrived.clone();
        Box::pin(async move {
            arrived.notify_one();
            std::future::pending().await
        })
    });
    let handle = start_network_proxy(options).await.unwrap();
    let port = handle.managed_network.loopback_ports[0];
    let mut incomplete = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    incomplete.write_all(b"GET ").await.unwrap();
    let mut pending = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    pending
        .write_all(b"CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n")
        .await
        .unwrap();
    started.notified().await;
    handle.close().await;
    let mut bytes = vec![];
    incomplete.read_to_end(&mut bytes).await.unwrap();
    pending.read_to_end(&mut bytes).await.unwrap();
    assert!(bytes.is_empty());
}

#[tokio::test]
async fn close_owns_and_waits_for_grant_release_once() {
    let upstream = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = upstream.local_addr().unwrap().port();
    let release_started = Arc::new(Notify::new());
    let release_continue = Arc::new(Notify::new());
    let releases = Arc::new(AtomicUsize::new(0));
    let (started, resume, count) = (
        release_started.clone(),
        release_continue.clone(),
        releases.clone(),
    );
    let mut options = options(false);
    options.authorize = Arc::new(move |_| {
        let (started, resume, count) = (started.clone(), resume.clone(), count.clone());
        Box::pin(async move {
            Ok(Grant::new(vec![], move || {
                Box::pin(async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    started.notify_one();
                    resume.notified().await;
                    Ok(())
                })
            }))
        })
    });
    let handle = Arc::new(start_network_proxy(options).await.unwrap());
    let mut client = TcpStream::connect(("127.0.0.1", handle.managed_network.loopback_ports[0]))
        .await
        .unwrap();
    client
        .write_all(format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut reply = vec![0; b"HTTP/1.1 200 Connection established\r\n\r\n".len()];
    client.read_exact(&mut reply).await.unwrap();
    let owner = handle.clone();
    let closing = tokio::spawn(async move {
        owner.close().await;
    });
    release_started.notified().await;
    assert!(!closing.is_finished());
    release_continue.notify_one();
    closing.await.unwrap();
    handle.close().await;
    assert_eq!(releases.load(Ordering::SeqCst), 1);
    drop(upstream);
}

#[tokio::test]
async fn plain_http_interception_preserves_placeholders_outside_raw_prefix() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let mut received = vec![];
        for _ in 0..3 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let head = read_request_head(&mut socket).await.unwrap();
            received.push(head.headers);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        }
        received
    });
    let upstream_ca = MitmAuthority::issue().unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(
            upstream_ca.certificate_der().to_vec(),
        ))
        .unwrap();
    let (mut options, directory) =
        masking_options(roots, vec![upstream_ca.certificate_pem().into()]);
    let mut configured = provider();
    configured.url_prefixes = vec![format!("http://127.0.0.1:{port}/api").into()];
    let mut invalid_provider = provider();
    invalid_provider.patterns = vec!["(?=x)".into()];
    let ignored_id = LosslessString::from_utf16(vec![0xd800]);
    options.launch.proxy.credential_providers = vec![
        ("vendor".into(), configured),
        (ignored_id.clone(), invalid_provider),
    ];
    options.env = vec![("VENDOR_TOKEN".into(), "vendor_abcdefgh".into())];
    let handle = start_network_proxy(options).await.unwrap();
    assert_eq!(handle.ignored_providers, vec![ignored_id]);
    let dummy = os_text(env_get(&handle.env, "VENDOR_TOKEN").unwrap());
    for path in ["/api/items", "/other", "/api/../other"] {
        let response = roundtrip(handle.managed_network.loopback_ports[0], format!("GET http://127.0.0.1:{port}{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Vendor-Key: Key {dummy}\r\nX-Order: first\r\nX-Order: last\r\n\r\n").as_bytes()).await;
        assert!(response.starts_with(b"HTTP/1.1 200"));
    }
    let received = server.await.unwrap();
    for (index, headers) in received.iter().enumerate() {
        let value = &headers
            .iter()
            .find(|(name, _)| header_is(name, "x-vendor-key"))
            .unwrap()
            .1;
        assert_eq!(
            value,
            &LosslessString::from(if index == 0 {
                "Key vendor_abcdefgh".into()
            } else {
                format!("Key {dummy}")
            })
        );
        assert_eq!(
            headers
                .iter()
                .filter(|(name, _)| header_is(name, "x-order"))
                .count(),
            2
        );
    }
    handle.close().await;
    tokio::fs::remove_dir_all(directory).await.unwrap();
}

#[tokio::test]
async fn proxy_parser_streams_preread_and_later_body_without_forwarding_a_pipeline() {
    for (framing, first, last, expected) in [
        (
            "Content-Length: 4",
            "bo",
            "dyGET /second HTTP/1.1\r\n\r\n",
            "body",
        ),
        (
            "Transfer-Encoding: chunked",
            "4\r\nbo",
            "dy\r\n0\r\nX-End: yes\r\n\r\nGET /second HTTP/1.1\r\n\r\n",
            "4\r\nbody\r\n0\r\nX-End: yes\r\n\r\n",
        ),
    ] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (ready, proceed) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let head = read_request_head(&mut socket).await.unwrap();
            ready.send(()).unwrap();
            let mut source = tokio::io::BufReader::new(crate::cca::mitm_ca::PrefixedStream::new(
                head.rest,
                &mut socket,
            ));
            let mut body = vec![];
            interception::forward_body(&mut source, &mut body, head.framing)
                .await
                .unwrap();
            drop(source);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            body
        });
        let handle = start_network_proxy(options(false)).await.unwrap();
        let mut socket =
            TcpStream::connect(("127.0.0.1", handle.managed_network.loopback_ports[0]))
                .await
                .unwrap();
        socket.write_all(format!("POST http://127.0.0.1:{port}/body HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{framing}\r\n\r\n{first}").as_bytes()).await.unwrap();
        proceed.await.unwrap();
        socket.write_all(last.as_bytes()).await.unwrap();
        let mut response = vec![];
        socket.read_to_end(&mut response).await.unwrap();
        assert!(response.starts_with(b"HTTP/1.1 200"));
        assert_eq!(server.await.unwrap(), expected.as_bytes());
        handle.close().await;
    }
}

#[tokio::test]
async fn intercepted_upstream_validation_failure_sends_no_credential_headers() {
    for wrong_hostname in [false, true] {
        let upstream_ca = MitmAuthority::issue().unwrap();
        let unrelated_ca = MitmAuthority::issue().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = upstream_ca
            .server_config_for_host(if wrong_hostname {
                "other.example"
            } else {
                "127.0.0.1"
            })
            .unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            match tokio_rustls::TlsAcceptor::from(config).accept(socket).await {
                Ok(mut stream) => {
                    let head = read_request_head(&mut stream).await;
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                    head.map(|head| head.headers)
                }
                Err(_) => None,
            }
        });
        let trusted = if wrong_hostname {
            &upstream_ca
        } else {
            &unrelated_ca
        };
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(rustls::pki_types::CertificateDer::from(
                trusted.certificate_der().to_vec(),
            ))
            .unwrap();
        let (mut options, directory) =
            masking_options(roots, vec![trusted.certificate_pem().into()]);
        let proxy_ca = options.upstream_trust.as_ref().unwrap().authority.clone();
        let mut configured = provider();
        configured.url_prefixes = vec![format!("https://127.0.0.1:{port}/api").into()];
        options.launch.proxy.credential_providers = vec![("vendor".into(), configured)];
        options.env = vec![("VENDOR_TOKEN".into(), "vendor_abcdefgh".into())];
        let handle = start_network_proxy(options).await.unwrap();
        let dummy = os_text(env_get(&handle.env, "VENDOR_TOKEN").unwrap());
        let mut socket =
            TcpStream::connect(("127.0.0.1", handle.managed_network.loopback_ports[0]))
                .await
                .unwrap();
        socket
            .write_all(format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut reply = vec![0; b"HTTP/1.1 200 Connection established\r\n\r\n".len()];
        socket.read_exact(&mut reply).await.unwrap();
        let mut client_roots = rustls::RootCertStore::empty();
        client_roots
            .add(rustls::pki_types::CertificateDer::from(
                proxy_ca.certificate_der().to_vec(),
            ))
            .unwrap();
        let connector = tokio_rustls::TlsConnector::from(test_rustls_client_config(client_roots));
        let mut secure = connector
            .connect(
                crate::cca::mitm_ca::upstream_server_name("127.0.0.1").unwrap(),
                socket,
            )
            .await
            .unwrap();
        secure.write_all(format!("GET /api HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Vendor-Key: Key {dummy}\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = vec![];
        secure.read_to_end(&mut response).await.unwrap();
        assert!(response.starts_with(b"HTTP/1.1 502"));
        assert!(server.await.unwrap().is_none());
        handle.close().await;
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}

#[tokio::test]
async fn upstream_validation_failure_sends_zero_http_bytes_and_zero_restored_credentials() {
    for (wrong_hostname, description) in [(false, "bad chain"), (true, "wrong identity")] {
        let upstream_ca = MitmAuthority::issue().unwrap();
        let unrelated_ca = MitmAuthority::issue().unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let config = upstream_ca
            .server_config_for_host(if wrong_hostname {
                "other.example"
            } else {
                "127.0.0.1"
            })
            .unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            match tokio_rustls::TlsAcceptor::from(config).accept(socket).await {
                Ok(mut stream) => {
                    let mut payload = vec![];
                    let _ = stream.read_to_end(&mut payload).await;
                    payload
                }
                Err(_) => vec![],
            }
        });
        let trusted = if wrong_hostname {
            &upstream_ca
        } else {
            &unrelated_ca
        };
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(rustls::pki_types::CertificateDer::from(
                trusted.certificate_der().to_vec(),
            ))
            .unwrap();
        let (mut options, directory) =
            masking_options(roots, vec![trusted.certificate_pem().into()]);
        let proxy_ca = options.upstream_trust.as_ref().unwrap().authority.clone();
        let mut configured = provider();
        configured.url_prefixes = vec![format!("https://127.0.0.1:{port}/api").into()];
        options.launch.proxy.credential_providers = vec![("vendor".into(), configured)];
        options.env = vec![("VENDOR_TOKEN".into(), "vendor_abcdefgh".into())];
        let handle = start_network_proxy(options).await.unwrap();
        let dummy = os_text(env_get(&handle.env, "VENDOR_TOKEN").unwrap());
        let mut socket =
            TcpStream::connect(("127.0.0.1", handle.managed_network.loopback_ports[0]))
                .await
                .unwrap();
        socket
            .write_all(format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut reply = vec![0; b"HTTP/1.1 200 Connection established\r\n\r\n".len()];
        socket.read_exact(&mut reply).await.unwrap();
        let mut client_roots = rustls::RootCertStore::empty();
        client_roots
            .add(rustls::pki_types::CertificateDer::from(
                proxy_ca.certificate_der().to_vec(),
            ))
            .unwrap();
        let connector = tokio_rustls::TlsConnector::from(test_rustls_client_config(client_roots));
        let mut secure = connector
            .connect(
                crate::cca::mitm_ca::upstream_server_name("127.0.0.1").unwrap(),
                socket,
            )
            .await
            .unwrap();
        secure.write_all(format!("GET /api HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Vendor-Key: Key {dummy}\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = vec![];
        secure.read_to_end(&mut response).await.unwrap();
        assert!(
            response.starts_with(b"HTTP/1.1 502"),
            "client must receive 502 on {description}"
        );
        let upstream_received = server.await.unwrap();
        assert!(
            upstream_received.is_empty(),
            "upstream must receive 0 HTTP bytes on {description}, got {:?}",
            upstream_received
        );
        assert!(
            !upstream_received
                .windows(15)
                .any(|w| w == b"vendor_abcdefgh"),
            "restored credential must never be sent on {description}"
        );
        handle.close().await;
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}

#[tokio::test]
async fn http_upstream_connection_failure_is_a_bad_gateway() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let handle = start_network_proxy(options(false)).await.unwrap();
    let response = roundtrip(
        handle.managed_network.loopback_ports[0],
        format!("GET http://127.0.0.1:{port}/ HTTP/1.1\r\n\r\n").as_bytes(),
    )
    .await;
    assert!(response.starts_with(b"HTTP/1.1 502"));
    handle.close().await;
}

async fn tls_proxy_request(
    handle: &NetworkProxyHandle,
    port: u16,
    config: Arc<rustls::ClientConfig>,
    request: &[u8],
) -> Vec<u8> {
    let mut socket = TcpStream::connect(("127.0.0.1", handle.managed_network.loopback_ports[0]))
        .await
        .unwrap();
    socket
        .write_all(format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut reply = vec![0; b"HTTP/1.1 200 Connection established\r\n\r\n".len()];
    socket.read_exact(&mut reply).await.unwrap();
    assert_eq!(reply, b"HTTP/1.1 200 Connection established\r\n\r\n");
    let mut secure = tokio_rustls::TlsConnector::from(config)
        .connect(
            crate::cca::mitm_ca::upstream_server_name("127.0.0.1").unwrap(),
            socket,
        )
        .await
        .unwrap();
    secure.write_all(request).await.unwrap();
    let mut response = vec![];
    secure.read_to_end(&mut response).await.unwrap();
    response
}

#[tokio::test]
async fn limited_tls_rejects_unsafe_methods_host_changes_and_nested_connect() {
    let upstream_ca = MitmAuthority::issue().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = upstream_ca.server_config_for_host("127.0.0.1").unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut secure = tokio_rustls::TlsAcceptor::from(config)
            .accept(socket)
            .await
            .unwrap();
        let head = read_request_head(&mut secure).await.unwrap();
        secure
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        secure.shutdown().await.unwrap();
        head.method
    });
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(
            upstream_ca.certificate_der().to_vec(),
        ))
        .unwrap();
    let (mut options, directory) =
        masking_options(roots, vec![upstream_ca.certificate_pem().into()]);
    options.launch.proxy.mode = NetworkMode::Limited;
    let proxy_ca = options.upstream_trust.as_ref().unwrap().authority.clone();
    let handle = start_network_proxy(options).await.unwrap();
    let mut client_roots = rustls::RootCertStore::empty();
    client_roots
        .add(rustls::pki_types::CertificateDer::from(
            proxy_ca.certificate_der().to_vec(),
        ))
        .unwrap();
    let client = test_rustls_client_config(client_roots);
    for (request, status) in [
        (
            format!("POST /write HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\n\r\n"),
            "HTTP/1.1 403",
        ),
        (
            "GET / HTTP/1.1\r\nHost: other.example\r\n\r\n".into(),
            "HTTP/1.1 400",
        ),
        (
            "CONNECT other.example:443 HTTP/1.1\r\n\r\n".into(),
            "HTTP/1.1 405",
        ),
        (
            format!("GET /read HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
            "HTTP/1.1 200",
        ),
    ] {
        let response = tls_proxy_request(&handle, port, client.clone(), request.as_bytes()).await;
        assert!(response.starts_with(status.as_bytes()));
    }
    assert_eq!(server.await.unwrap(), "GET");
    handle.close().await;
    tokio::fs::remove_dir_all(directory).await.unwrap();
}

#[tokio::test]
async fn launch_states_mask_or_restore_environment_and_handoff_only_canonical_snapshot() {
    let root = MitmAuthority::issue().unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(
            root.certificate_der().to_vec(),
        ))
        .unwrap();
    let real = LosslessString::from(format!("sk-proj-{}", "q".repeat(64)));
    for (program, flag, arg0, snapshot, expected) in [
        (
            "/bin/bash",
            "-c",
            None,
            None,
            CredentialMaskingState::Enabled,
        ),
        (
            "/bin/bash",
            "-lc",
            None,
            None,
            CredentialMaskingState::Unavailable,
        ),
        (
            "/bin/bash",
            "-c",
            Some("custom".into()),
            None,
            CredentialMaskingState::Unavailable,
        ),
        (
            "/bin/zsh",
            "-lc",
            None,
            Some(("zsh".into(), "/bin/zsh".into())),
            CredentialMaskingState::Snapshot,
        ),
    ] {
        let (mut options, directory) =
            masking_options(roots.clone(), vec![root.certificate_pem().into()]);
        options.env = vec![
            ("OPENAI_API_KEY".into(), real.clone()),
            ("COPY".into(), concat(&[&"prefix ".into(), &real])),
        ];
        options.command = Some(NetworkProxyCommand {
            argv: vec![program.into(), flag.into(), "true".into()],
            arg0,
            shell_snapshot_shell_name: snapshot,
        });
        let handle = start_network_proxy(options).await.unwrap();
        assert_eq!(handle.credential_masking, expected);
        assert_eq!(
            handle.credential_broker.is_some(),
            expected == CredentialMaskingState::Snapshot
        );
        assert_eq!(
            env_get(&handle.env, "OPENAI_API_KEY") == Some(&real),
            expected != CredentialMaskingState::Enabled
        );
        assert_eq!(
            env_get(&handle.env, "CODEX_NETWORK_PROXY_CREDENTIAL_BROKER_ACTIVE").is_some(),
            expected == CredentialMaskingState::Enabled
        );
        if expected == CredentialMaskingState::Unavailable {
            assert_eq!(
                handle.warnings,
                vec![LosslessString::from(CREDENTIAL_MASKING_UNAVAILABLE_WARNING)]
            );
        }
        handle.close().await;
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}

#[tokio::test]
async fn ca_export_reuses_content_and_exports_no_private_key() {
    let authority = MitmAuthority::issue().unwrap();
    let upstream = MitmAuthority::issue().unwrap();
    let directory = std::env::temp_dir().join(format!(
        "ycoding-cca-trust-{}",
        crate::cca::encoding::uuid_v4()
    ));
    let bundle = authority
        .export_child_trust(&directory, &[upstream.certificate_pem().into()])
        .await
        .unwrap();
    let reused = authority
        .export_child_trust(&directory, &[upstream.certificate_pem().into()])
        .await
        .unwrap();
    assert_eq!(bundle.bundle_path, reused.bundle_path);
    assert_eq!(bundle.certificate_path, reused.certificate_path);
    for path in [&bundle.certificate_path, &bundle.bundle_path] {
        let text = tokio::fs::read_to_string(path).await.unwrap();
        assert!(!text.contains("PRIVATE KEY"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                tokio::fs::metadata(path)
                    .await
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o644
            );
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            tokio::fs::metadata(&directory)
                .await
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    tokio::fs::remove_dir_all(directory).await.unwrap();
}

#[test]
fn managed_ca_paths_are_confined_to_the_resolved_directory() {
    use crate::cca::mitm_ca::is_managed_trust_bundle_path;
    let directory = std::env::temp_dir().join("synthetic-cca-ca");
    let name = format!("ca-bundle-{}.pem", "a".repeat(64));
    assert!(is_managed_trust_bundle_path(&directory, &directory.join(&name)).unwrap());
    assert!(
        is_managed_trust_bundle_path(&directory, &directory.join("nested/..").join(&name)).unwrap()
    );
    assert!(
        !is_managed_trust_bundle_path(&directory, &directory.join("../other").join(&name)).unwrap()
    );
    assert!(
        !is_managed_trust_bundle_path(&directory, &directory.join("ca-bundle-short.pem")).unwrap()
    );
}
