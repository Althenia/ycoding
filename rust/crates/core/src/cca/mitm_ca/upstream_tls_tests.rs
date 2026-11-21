use super::*;
use rustls::{
    ServerConfig,
    version::{TLS12, TLS13},
};
use x509_cert::der::asn1::PrintableStringRef;
use x509_cert::ext::pkix::{NameConstraints, constraints::name::GeneralSubtree};

fn dn(parts: &[(&str, &str)]) -> Name {
    let rdns = parts
        .iter()
        .map(|(oid, value)| {
            let oid = ObjectIdentifier::new_unwrap(oid);
            let value = if oid == ObjectIdentifier::new_unwrap("2.5.4.6") {
                Any::encode_from(&PrintableStringRef::new(value).unwrap()).unwrap()
            } else {
                Any::encode_from(&Utf8StringRef::new(value).unwrap()).unwrap()
            };
            RelativeDistinguishedName(
                SetOfVec::try_from(vec![AttributeTypeAndValue { oid, value }]).unwrap(),
            )
        })
        .collect();
    RdnSequence(rdns)
}

fn synthetic_dn() -> Name {
    dn(&[("2.5.4.6", "US"), ("2.5.4.10", "Synthetic")])
}

fn leaf_dn(organization: &str) -> Name {
    dn(&[
        ("2.5.4.6", "US"),
        ("2.5.4.10", organization),
        ("2.5.4.3", "service.example.test"),
    ])
}

struct Root {
    der: Vec<u8>,
    pem: String,
    signer: RsaSigner,
    subject: Name,
}

fn issue_root(permitted: Option<Name>, excluded: Option<Name>) -> Root {
    let key = generate_key().unwrap();
    let subject = dn(&[
        ("2.5.4.6", "US"),
        ("2.5.4.10", "Synthetic"),
        ("2.5.4.3", "Synthetic Root"),
    ]);
    let mut builder = CertificateBuilder::new(
        Profile::Manual { issuer: None },
        serial().unwrap(),
        validity(DAY, DAY * 30).unwrap(),
        subject.clone(),
        key.spki.clone(),
        &key.signer,
    )
    .unwrap();
    builder
        .add_extension(&BasicConstraints {
            ca: true,
            path_len_constraint: None,
        })
        .unwrap();
    builder
        .add_extension(&KeyUsage(
            KeyUsages::KeyCertSign | KeyUsages::DigitalSignature,
        ))
        .unwrap();
    if permitted.is_some() || excluded.is_some() {
        let subtree = |base: Name| GeneralSubtree {
            base: GeneralName::DirectoryName(base),
            minimum: 0,
            maximum: None,
        };
        builder
            .add_extension(&NameConstraints {
                permitted_subtrees: permitted.map(|base| vec![subtree(base)]),
                excluded_subtrees: excluded.map(|base| vec![subtree(base)]),
            })
            .unwrap();
    }
    let certificate = builder.build::<RsaSignature>().unwrap();
    let der = certificate.to_der().unwrap();
    Root {
        pem: certificate_pem(&der).unwrap(),
        der,
        signer: key.signer,
        subject,
    }
}

struct Leaf {
    der: Vec<u8>,
    pkcs8: Vec<u8>,
}

fn issue_synthetic_leaf(root: &Root, subject: Name, sans: Vec<GeneralName>) -> Leaf {
    let key = generate_key().unwrap();
    let mut builder = CertificateBuilder::new(
        Profile::Manual {
            issuer: Some(root.subject.clone()),
        },
        serial().unwrap(),
        validity(DAY, DAY * 30).unwrap(),
        subject,
        key.spki.clone(),
        &root.signer,
    )
    .unwrap();
    builder
        .add_extension(&Noncritical(BasicConstraints {
            ca: false,
            path_len_constraint: None,
        }))
        .unwrap();
    builder
        .add_extension(&KeyUsage(
            KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment,
        ))
        .unwrap();
    builder
        .add_extension(&Noncritical(ExtendedKeyUsage(vec![
            ObjectIdentifier::new_unwrap(SERVER_AUTH_OID),
        ])))
        .unwrap();
    if !sans.is_empty() {
        builder.add_extension(&SubjectAltName(sans)).unwrap();
    }
    let certificate = builder.build::<RsaSignature>().unwrap();
    Leaf {
        der: certificate.to_der().unwrap(),
        pkcs8: key.pkcs8,
    }
}

#[derive(Clone, Copy)]
struct RawSanExtension<'a>(&'a [u8]);

impl x509_cert::der::oid::AssociatedOid for RawSanExtension<'_> {
    const OID: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.5.29.17");
}

impl x509_cert::der::FixedTag for RawSanExtension<'_> {
    const TAG: x509_cert::der::Tag = x509_cert::der::Tag::Sequence;
}

impl x509_cert::der::EncodeValue for RawSanExtension<'_> {
    fn value_len(&self) -> x509_cert::der::Result<x509_cert::der::Length> {
        x509_cert::der::Length::try_from(self.0.len())
    }
    fn encode_value(&self, writer: &mut impl x509_cert::der::Writer) -> x509_cert::der::Result<()> {
        writer.write(self.0)
    }
}

impl AsExtension for RawSanExtension<'_> {
    fn critical(&self, _: &Name, _: &[x509_cert::ext::Extension]) -> bool {
        false
    }
}

fn issue_synthetic_leaf_with_raw_san(
    root: &Root,
    subject: Name,
    raw_san_inner: &'static [u8],
) -> Leaf {
    let key = generate_key().unwrap();
    let mut builder = CertificateBuilder::new(
        Profile::Manual {
            issuer: Some(root.subject.clone()),
        },
        serial().unwrap(),
        validity(DAY, DAY * 30).unwrap(),
        subject,
        key.spki.clone(),
        &root.signer,
    )
    .unwrap();
    builder
        .add_extension(&Noncritical(BasicConstraints {
            ca: false,
            path_len_constraint: None,
        }))
        .unwrap();
    builder
        .add_extension(&KeyUsage(
            KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment,
        ))
        .unwrap();
    builder
        .add_extension(&Noncritical(ExtendedKeyUsage(vec![
            ObjectIdentifier::new_unwrap(SERVER_AUTH_OID),
        ])))
        .unwrap();
    builder
        .add_extension(&RawSanExtension(raw_san_inner))
        .unwrap();
    let certificate = builder.build::<RsaSignature>().unwrap();
    Leaf {
        der: certificate.to_der().unwrap(),
        pkcs8: key.pkcs8,
    }
}

fn dns(name: &str) -> GeneralName {
    GeneralName::DnsName(Ia5String::new(name).unwrap())
}

fn server_config(
    root: &Root,
    leaf: Leaf,
    versions: &[&'static rustls::SupportedProtocolVersion],
) -> Arc<ServerConfig> {
    let mut config = ServerConfig::builder_with_provider(crypto_provider())
        .with_protocol_versions(versions)
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![
                CertificateDer::from(leaf.der),
                CertificateDer::from(root.der.clone()),
            ],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf.pkcs8)),
        )
        .unwrap();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

async fn handshake(root: &Root, host: &str, config: Arc<ServerConfig>) -> bool {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let acceptor = tokio_rustls::TlsAcceptor::from(config);

    let (server_result, client_result) =
        tokio::join!(async { acceptor.accept(server_io).await }, async {
            connect_upstream(root, host, client_io).await
        },);

    let client_ok = match &client_result {
        Ok(_) => true,
        Err(err) => {
            eprintln!("[handshake client error host={host}]: {err:?}");
            false
        }
    };
    let server_ok = match &server_result {
        Ok(_) => true,
        Err(err) => {
            eprintln!("[handshake server error host={host}]: {err:?}");
            false
        }
    };

    let success = client_ok && server_ok;
    drop(client_result);
    drop(server_result);
    success
}

async fn connect_upstream(
    root: &Root,
    host: &str,
    stream: tokio::io::DuplexStream,
) -> Result<tokio_openssl::SslStream<tokio::io::DuplexStream>, MitmError> {
    let connector = upstream_openssl_connector(std::slice::from_ref(&root.pem))?;
    connector.connect(host, stream).await
}

#[tokio::test]
async fn permitted_directory_name_accepts_matching_leaf() {
    let root = issue_root(Some(synthetic_dn()), None);
    let leaf = issue_synthetic_leaf(
        &root,
        leaf_dn("Synthetic"),
        vec![dns("service.example.test")],
    );
    assert!(
        handshake(
            &root,
            "service.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
}

#[tokio::test]
async fn permitted_directory_name_rejects_outside_leaf() {
    let root = issue_root(Some(synthetic_dn()), None);
    let leaf = issue_synthetic_leaf(&root, leaf_dn("Other"), vec![dns("service.example.test")]);
    assert!(
        !handshake(
            &root,
            "service.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
}

#[tokio::test]
async fn excluded_directory_name_rejects_matching_leaf() {
    let root = issue_root(None, Some(synthetic_dn()));
    let leaf = issue_synthetic_leaf(
        &root,
        leaf_dn("Synthetic"),
        vec![dns("service.example.test")],
    );
    assert!(
        !handshake(
            &root,
            "service.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
}

#[tokio::test]
async fn permitted_directory_name_accepts_on_tls12_and_tls13() {
    let root = issue_root(Some(synthetic_dn()), None);
    for versions in [&[&TLS12][..], &[&TLS13][..]] {
        let leaf = issue_synthetic_leaf(
            &root,
            leaf_dn("Synthetic"),
            vec![dns("service.example.test")],
        );
        assert!(
            handshake(
                &root,
                "service.example.test",
                server_config(&root, leaf, versions)
            )
            .await
        );
    }
}

#[tokio::test]
async fn unconstrained_root_identity_cases() {
    let root = issue_root(None, None);
    let sans = || {
        vec![
            dns("service.example.test"),
            GeneralName::IpAddress(OctetString::new(vec![127, 0, 0, 1]).unwrap()),
        ]
    };
    for (host, succeeds) in [
        ("service.example.test", true),
        ("other.example.test", false),
        ("127.0.0.1", true),
        ("127.0.0.2", false),
    ] {
        let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), sans());
        assert_eq!(
            handshake(
                &root,
                host,
                server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
            )
            .await,
            succeeds,
            "host {host}"
        );
    }
    let unrelated = issue_root(None, None);
    let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), sans());
    assert!(
        !handshake(
            &unrelated,
            "service.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
}

#[tokio::test]
async fn wildcard_dns_san_matches_one_label_only() {
    let root = issue_root(None, None);
    for (host, succeeds) in [
        ("a.example.test", true),
        ("a.b.example.test", false),
        ("example.test", false),
    ] {
        let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), vec![dns("*.example.test")]);
        assert_eq!(
            handshake(
                &root,
                host,
                server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
            )
            .await,
            succeeds,
            "host {host}"
        );
    }
}

#[tokio::test]
async fn partial_wildcard_dns_san_matches_subdomain() {
    let root = issue_root(None, None);
    for (host, succeeds) in [
        ("foo.example.test", true),
        ("f.o.example.test", false),
        ("bar.example.test", false),
    ] {
        let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), vec![dns("f*o.example.test")]);
        assert_eq!(
            handshake(
                &root,
                host,
                server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
            )
            .await,
            succeeds,
            "host {host}"
        );
    }
}

#[tokio::test]
async fn common_name_fallback_without_san() {
    let root = issue_root(None, None);
    let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), vec![]);
    assert!(
        handshake(
            &root,
            "service.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
    let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), vec![]);
    assert!(
        !handshake(
            &root,
            "other.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
}

#[tokio::test]
async fn common_name_fallback_with_ip_only_san() {
    let root = issue_root(None, None);
    let ip_san = GeneralName::IpAddress(OctetString::new(vec![127, 0, 0, 1]).unwrap());
    let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), vec![ip_san]);
    assert!(
        handshake(
            &root,
            "service.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
}

#[tokio::test]
async fn common_name_fallback_with_uri_only_san() {
    let root = issue_root(None, None);
    let uri_san = GeneralName::UniformResourceIdentifier(
        Ia5String::new("http://service.example.test").unwrap(),
    );
    let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), vec![uri_san]);
    assert!(
        handshake(
            &root,
            "service.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
}

#[tokio::test]
async fn dns_san_present_disables_common_name_fallback() {
    let root = issue_root(None, None);
    let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), vec![dns("other.example.test")]);
    assert!(
        !handshake(
            &root,
            "service.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
    let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), vec![dns("other.example.test")]);
    assert!(
        handshake(
            &root,
            "other.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
}

#[tokio::test]
async fn malformed_dns_san_fails_closed_without_common_name_fallback() {
    let root = issue_root(None, None);
    let leaf = issue_synthetic_leaf_with_raw_san(&root, leaf_dn("Synthetic"), &[0x82, 0x01, 0xff]);
    assert!(
        !handshake(
            &root,
            "service.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
    let leaf = issue_synthetic_leaf_with_raw_san(&root, leaf_dn("Synthetic"), &[0x82, 0x01, 0xff]);
    let cert = openssl::x509::X509::from_der(&leaf.der).unwrap();
    let result = check_server_identity("service.example.test", &cert);
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("not in cert altnames"));
}

#[tokio::test]
async fn embedded_wildcard_under_untrusted_root_is_rejected() {
    let root = issue_root(None, None);
    let untrusted = issue_root(None, None);
    let leaf = issue_synthetic_leaf(&root, leaf_dn("Synthetic"), vec![dns("f*o.example.test")]);
    assert!(
        !handshake(
            &untrusted,
            "foo.example.test",
            server_config(&root, leaf, rustls::DEFAULT_VERSIONS)
        )
        .await
    );
}

#[test]
fn ssl_connector_protocol_contract() {
    let root = issue_root(None, None);
    let connector = upstream_openssl_connector(&[root.pem]).unwrap();
    assert_eq!(
        connector.min_proto_version(),
        Some(openssl::ssl::SslVersion::TLS1_2)
    );
    assert_eq!(
        connector.max_proto_version(),
        Some(openssl::ssl::SslVersion::TLS1_3)
    );
}

#[test]
fn linked_openssl_runtime_version() {
    let version = openssl::version::version();
    assert!(
        version.starts_with("OpenSSL 3.5.7"),
        "expected OpenSSL 3.5.7, got {version}"
    );
    let number = openssl::version::number();
    assert!(
        number >= 0x30500070,
        "expected OpenSSL 3.5.7+ version number, got 0x{number:x}"
    );
}
