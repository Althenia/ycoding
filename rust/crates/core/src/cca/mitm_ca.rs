use super::encoding::{random_bytes, sha256_hex};
use aws_lc_rs::{
    encoding::{AsDer, Pkcs8V1Der},
    rand::SystemRandom,
    rsa::{KeyPair, KeySize},
    signature::{KeyPair as _, RSA_PKCS1_SHA256},
};
use foreign_types::ForeignTypeRef;
use rustls::{
    ServerConfig,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName},
};
use std::{
    collections::VecDeque,
    io,
    net::IpAddr,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, SystemTime},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use x509_cert::{
    Certificate,
    attr::AttributeTypeAndValue,
    builder::{Builder, CertificateBuilder, Profile},
    der::{
        Decode, Document, Encode, Length, Writer,
        asn1::{Any, BitString, Ia5String, OctetString, SetOfVec, Utf8StringRef},
        oid::{AssociatedOid, ObjectIdentifier},
        referenced::OwnedToRef,
    },
    ext::{
        AsExtension, Extension,
        pkix::{
            BasicConstraints, ExtendedKeyUsage, KeyUsage, KeyUsages, SubjectAltName,
            SubjectKeyIdentifier, name::GeneralName,
        },
    },
    name::{Name, RdnSequence, RelativeDistinguishedName},
    serial_number::SerialNumber,
    spki::{
        AlgorithmIdentifierOwned, DynSignatureAlgorithmIdentifier, EncodePublicKey,
        SignatureBitStringEncoding, SubjectPublicKeyInfoOwned,
    },
    time::{Time, Validity},
};

pub const CA_COMMON_NAME: &str = "network_proxy MITM CA";
const MAX_CACHED_HOST_CONTEXTS: usize = 256;
const DAY: Duration = Duration::from_secs(86_400);
const SHA256_WITH_RSA_ENCRYPTION: &str = "1.2.840.113549.1.1.11";
const COMMON_NAME_OID: &str = "2.5.4.3";
const SERVER_AUTH_OID: &str = "1.3.6.1.5.5.7.3.1";

#[derive(Debug)]
pub struct MitmError(pub String);
impl std::fmt::Display for MitmError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for MitmError {}
fn failure(context: &str, error: impl std::fmt::Display) -> MitmError {
    MitmError(format!("{context}: {error}"))
}

#[derive(Clone)]
struct SpkiKey(Document);
impl EncodePublicKey for SpkiKey {
    fn to_public_key_der(&self) -> x509_cert::spki::Result<Document> {
        Ok(self.0.clone())
    }
}

struct RsaSignature(Vec<u8>);
impl SignatureBitStringEncoding for RsaSignature {
    fn to_bitstring(&self) -> x509_cert::der::Result<BitString> {
        BitString::from_bytes(&self.0)
    }
}

#[derive(Clone)]
struct RsaSigner {
    pair: Arc<KeyPair>,
    verifying: SpkiKey,
}
impl signature::Keypair for RsaSigner {
    type VerifyingKey = SpkiKey;
    fn verifying_key(&self) -> SpkiKey {
        self.verifying.clone()
    }
}
impl DynSignatureAlgorithmIdentifier for RsaSigner {
    fn signature_algorithm_identifier(&self) -> x509_cert::spki::Result<AlgorithmIdentifierOwned> {
        Ok(AlgorithmIdentifierOwned {
            oid: ObjectIdentifier::new_unwrap(SHA256_WITH_RSA_ENCRYPTION),
            parameters: Some(Any::null()),
        })
    }
}
impl signature::Signer<RsaSignature> for RsaSigner {
    fn try_sign(&self, message: &[u8]) -> Result<RsaSignature, signature::Error> {
        let mut output = vec![0u8; self.pair.public_modulus_len()];
        self.pair
            .sign(
                &RSA_PKCS1_SHA256,
                &SystemRandom::new(),
                message,
                &mut output,
            )
            .map_err(|_| signature::Error::new())?;
        Ok(RsaSignature(output))
    }
}

struct IssuedKey {
    signer: RsaSigner,
    pkcs8: Vec<u8>,
    spki: SubjectPublicKeyInfoOwned,
}
fn generate_key() -> Result<IssuedKey, MitmError> {
    let pair = KeyPair::generate(KeySize::Rsa2048)
        .map_err(|error| failure("rsa key generation", error))?;
    let public = pair
        .public_key()
        .as_der()
        .map_err(|error| failure("public key export", error))?;
    let public_der: &[u8] = public.as_ref();
    let spki = SubjectPublicKeyInfoOwned::from_der(public_der)
        .map_err(|error| failure("public key decode", error))?;
    let document =
        Document::try_from(public_der).map_err(|error| failure("public key document", error))?;
    let private = AsDer::<Pkcs8V1Der<'static>>::as_der(&pair)
        .map_err(|error| failure("private key export", error))?;
    let pkcs8 = private.as_ref().to_vec();
    Ok(IssuedKey {
        signer: RsaSigner {
            pair: Arc::new(pair),
            verifying: SpkiKey(document),
        },
        pkcs8,
        spki,
    })
}

struct Noncritical<T>(T);
impl<T: Encode> Encode for Noncritical<T> {
    fn encoded_len(&self) -> x509_cert::der::Result<Length> {
        self.0.encoded_len()
    }
    fn encode(&self, writer: &mut impl Writer) -> x509_cert::der::Result<()> {
        self.0.encode(writer)
    }
}
impl<T: AssociatedOid> AssociatedOid for Noncritical<T> {
    const OID: ObjectIdentifier = T::OID;
}
impl<T: AsExtension> AsExtension for Noncritical<T> {
    fn critical(&self, _subject: &Name, _extensions: &[Extension]) -> bool {
        false
    }
}

fn common_name(value: &str) -> Result<Name, MitmError> {
    let text = Utf8StringRef::new(value).map_err(|error| failure("common name", error))?;
    let attribute = AttributeTypeAndValue {
        oid: ObjectIdentifier::new_unwrap(COMMON_NAME_OID),
        value: Any::encode_from(&text).map_err(|error| failure("common name", error))?,
    };
    let set = SetOfVec::try_from(vec![attribute]).map_err(|error| failure("common name", error))?;
    Ok(RdnSequence(vec![RelativeDistinguishedName(set)]))
}
fn serial() -> Result<SerialNumber, MitmError> {
    let mut bytes = random_bytes(16);
    bytes[0] &= 0x7f;
    SerialNumber::new(&bytes).map_err(|error| failure("serial number", error))
}
fn validity(back: Duration, forward: Duration) -> Result<Validity, MitmError> {
    let now = SystemTime::now();
    Ok(Validity {
        not_before: Time::try_from(now - back).map_err(|error| failure("validity", error))?,
        not_after: Time::try_from(now + forward).map_err(|error| failure("validity", error))?,
    })
}
fn built(error: impl std::fmt::Display) -> MitmError {
    failure("certificate build", error)
}

fn issue_ca() -> Result<(Certificate, IssuedKey, Name), MitmError> {
    let key = generate_key()?;
    let subject = common_name(CA_COMMON_NAME)?;
    let mut builder = CertificateBuilder::new(
        Profile::Manual { issuer: None },
        serial()?,
        validity(DAY, DAY * 3650)?,
        subject.clone(),
        key.spki.clone(),
        &key.signer,
    )
    .map_err(built)?;
    builder
        .add_extension(&BasicConstraints {
            ca: true,
            path_len_constraint: None,
        })
        .map_err(built)?;
    builder
        .add_extension(&KeyUsage(
            KeyUsages::KeyCertSign | KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment,
        ))
        .map_err(built)?;
    let identifier = SubjectKeyIdentifier::try_from(key.spki.owned_to_ref()).map_err(built)?;
    builder.add_extension(&identifier).map_err(built)?;
    let certificate = builder.build::<RsaSignature>().map_err(built)?;
    Ok((certificate, key, subject))
}

pub struct IssuedLeaf {
    pub certificate_der: Vec<u8>,
    pub pkcs8: Vec<u8>,
}
fn issue_leaf(
    host: &str,
    ca_signer: &RsaSigner,
    ca_subject: &Name,
) -> Result<IssuedLeaf, MitmError> {
    let key = generate_key()?;
    let mut builder = CertificateBuilder::new(
        Profile::Manual {
            issuer: Some(ca_subject.clone()),
        },
        serial()?,
        validity(DAY, DAY * 365)?,
        common_name(host)?,
        key.spki.clone(),
        ca_signer,
    )
    .map_err(built)?;
    builder
        .add_extension(&Noncritical(BasicConstraints {
            ca: false,
            path_len_constraint: None,
        }))
        .map_err(built)?;
    builder
        .add_extension(&KeyUsage(
            KeyUsages::DigitalSignature | KeyUsages::KeyEncipherment,
        ))
        .map_err(built)?;
    builder
        .add_extension(&Noncritical(ExtendedKeyUsage(vec![
            ObjectIdentifier::new_unwrap(SERVER_AUTH_OID),
        ])))
        .map_err(built)?;
    let name = match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            GeneralName::IpAddress(OctetString::new(address.octets().to_vec()).map_err(built)?)
        }
        Ok(IpAddr::V6(address)) => {
            GeneralName::IpAddress(OctetString::new(address.octets().to_vec()).map_err(built)?)
        }
        Err(_) => GeneralName::DnsName(Ia5String::new(host).map_err(built)?),
    };
    builder
        .add_extension(&SubjectAltName(vec![name]))
        .map_err(built)?;
    let certificate = builder.build::<RsaSignature>().map_err(built)?;
    Ok(IssuedLeaf {
        certificate_der: certificate.to_der().map_err(built)?,
        pkcs8: key.pkcs8,
    })
}

pub fn certificate_pem(der: &[u8]) -> Result<String, MitmError> {
    pem_rfc7468::encode_string("CERTIFICATE", pem_rfc7468::LineEnding::LF, der)
        .map_err(|error| failure("certificate pem", error))
}
pub fn decode_certificate_pem_blocks(text: &str) -> Vec<Vec<u8>> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let mut blocks = vec![];
    let mut rest = text;
    while let Some(start) = rest.find(BEGIN) {
        let Some(end) = rest[start..].find(END) else {
            break;
        };
        let block = &rest[start..start + end + END.len()];
        if let Ok((label, der)) = pem_rfc7468::decode_vec(block.as_bytes())
            && label == "CERTIFICATE"
        {
            blocks.push(der);
        }
        rest = &rest[start + end + END.len()..];
    }
    blocks
}

fn crypto_provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

pub struct MitmAuthority {
    ca_der: Vec<u8>,
    ca_pem: String,
    signer: RsaSigner,
    subject: Name,
    contexts: Mutex<VecDeque<(String, Arc<ServerConfig>)>>,
}

#[derive(Clone, Debug)]
pub struct ChildTrustBundle {
    pub certificate_path: PathBuf,
    pub bundle_path: PathBuf,
}

pub fn is_managed_trust_bundle_path(directory: &Path, value: &Path) -> Result<bool, MitmError> {
    let resolve = |path: &Path| -> Result<PathBuf, MitmError> {
        let absolute =
            std::path::absolute(path).map_err(|error| failure("managed MITM CA path", error))?;
        let mut normalized = PathBuf::new();
        for component in absolute.components() {
            match component {
                std::path::Component::CurDir => {}
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                other => normalized.push(other.as_os_str()),
            }
        }
        Ok(normalized)
    };
    let directory = resolve(directory)?;
    let candidate = resolve(value)?;
    if candidate.parent() != Some(directory.as_path()) {
        return Ok(false);
    }
    let Some(name) = candidate.file_name().and_then(|name| name.to_str()) else {
        return Ok(false);
    };
    let Some(hash) = name
        .strip_prefix("ca-bundle-")
        .or_else(|| name.strip_prefix("ca-"))
        .and_then(|name| name.strip_suffix(".pem"))
    else {
        return Ok(false);
    };
    Ok(hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn normalized_pem(text: &str) -> String {
    format!("{}\n", text.trim().replace("\r\n", "\n"))
}

async fn write_artifact(
    directory: &Path,
    prefix: &str,
    contents: &str,
) -> Result<PathBuf, MitmError> {
    let target = directory.join(format!("{prefix}-{}.pem", sha256_hex(contents.as_bytes())));
    match tokio::fs::read(&target).await {
        Ok(existing) if existing == contents.as_bytes() => return Ok(target),
        Ok(_) => {
            return Err(MitmError(
                "managed MITM CA artifact exists with different contents".into(),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(failure("managed MITM CA artifact", error)),
    }
    let temporary = directory.join(format!("{prefix}.tmp.{}", super::encoding::random_hex(12)));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o644);
    let mut file = options
        .open(&temporary)
        .await
        .map_err(|error| failure("managed MITM CA artifact", error))?;
    let result = async {
        use tokio::io::AsyncWriteExt;
        file.write_all(contents.as_bytes()).await?;
        file.sync_all().await?;
        match tokio::fs::hard_link(&temporary, &target).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if tokio::fs::read(&target).await? == contents.as_bytes() {
                    Ok(())
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "managed MITM CA artifact exists with different contents",
                    ))
                }
            }
            Err(error) => Err(error),
        }
    }
    .await;
    drop(file);
    let removed = tokio::fs::remove_file(&temporary).await;
    result.map_err(|error| failure("managed MITM CA artifact", error))?;
    removed.map_err(|error| failure("managed MITM CA temporary artifact", error))?;
    Ok(target)
}

impl MitmAuthority {
    pub fn issue() -> Result<Self, MitmError> {
        let (certificate, key, subject) = issue_ca()?;
        let ca_der = certificate.to_der().map_err(built)?;
        Ok(Self {
            ca_pem: certificate_pem(&ca_der)?,
            ca_der,
            signer: key.signer,
            subject,
            contexts: Mutex::new(VecDeque::new()),
        })
    }
    pub fn certificate_der(&self) -> &[u8] {
        &self.ca_der
    }
    pub fn certificate_pem(&self) -> &str {
        &self.ca_pem
    }
    pub fn child_bundle_pem(&self, upstream_pem: &[String]) -> Result<String, MitmError> {
        let ca = normalized_pem(&self.ca_pem);
        let mut roots = Vec::new();
        for pem in upstream_pem {
            let pem = normalized_pem(pem);
            if pem == ca {
                return Err(MitmError(
                    "generated proxy CA cannot be an upstream root".into(),
                ));
            }
            if !roots.contains(&pem) {
                roots.push(pem);
            }
        }
        roots.push(ca);
        Ok(roots.join(""))
    }
    pub async fn export_child_trust(
        &self,
        directory: &Path,
        upstream_pem: &[String],
    ) -> Result<ChildTrustBundle, MitmError> {
        let bundle = self.child_bundle_pem(upstream_pem)?;
        let mut builder = tokio::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder
            .create(directory)
            .await
            .map_err(|error| failure("managed MITM CA directory", error))?;
        let certificate_path = write_artifact(directory, "ca", &self.ca_pem).await?;
        let bundle_path = write_artifact(directory, "ca-bundle", &bundle).await?;
        Ok(ChildTrustBundle {
            certificate_path,
            bundle_path,
        })
    }
    pub fn server_config_for_host(&self, host: &str) -> Result<Arc<ServerConfig>, MitmError> {
        {
            let mut contexts = self
                .contexts
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(index) = contexts.iter().position(|(candidate, _)| candidate == host) {
                let entry = contexts.remove(index).expect("cached context present");
                let config = entry.1.clone();
                contexts.push_back(entry);
                return Ok(config);
            }
        }
        let leaf = issue_leaf(host, &self.signer, &self.subject)?;
        let mut config = ServerConfig::builder_with_provider(crypto_provider())
            .with_safe_default_protocol_versions()
            .map_err(|error| failure("tls versions", error))?
            .with_no_client_auth()
            .with_single_cert(
                vec![
                    CertificateDer::from(leaf.certificate_der),
                    CertificateDer::from(self.ca_der.clone()),
                ],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf.pkcs8)),
            )
            .map_err(|error| failure("tls server config", error))?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let config = Arc::new(config);
        let mut contexts = self
            .contexts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        contexts.push_back((host.to_owned(), config.clone()));
        while contexts.len() > MAX_CACHED_HOST_CONTEXTS {
            contexts.pop_front();
        }
        Ok(config)
    }
}

pub const NODE_DEFAULT_TLS13_CIPHERSUITES: &str =
    "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256";

pub const NODE_DEFAULT_CIPHER_LIST: &str = "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";

pub fn upstream_server_name(host: &str) -> Result<ServerName<'static>, MitmError> {
    ServerName::try_from(host.to_owned()).map_err(|error| failure("server name", error))
}

#[derive(Clone)]
pub struct UpstreamTlsConnector {
    connector: openssl::ssl::SslConnector,
}

pub fn upstream_openssl_connector(
    ordered_pem: &[String],
) -> Result<Arc<UpstreamTlsConnector>, MitmError> {
    let mut builder = openssl::ssl::SslConnector::builder(openssl::ssl::SslMethod::tls_client())
        .map_err(|error| failure("ssl connector builder", error))?;

    builder
        .set_min_proto_version(Some(openssl::ssl::SslVersion::TLS1_2))
        .map_err(|error| failure("ssl min proto version", error))?;
    builder
        .set_max_proto_version(Some(openssl::ssl::SslVersion::TLS1_3))
        .map_err(|error| failure("ssl max proto version", error))?;
    builder
        .set_ciphersuites(NODE_DEFAULT_TLS13_CIPHERSUITES)
        .map_err(|error| failure("ssl ciphersuites", error))?;
    builder
        .set_cipher_list(NODE_DEFAULT_CIPHER_LIST)
        .map_err(|error| failure("ssl cipher list", error))?;
    builder.set_verify(openssl::ssl::SslVerifyMode::PEER);
    builder
        .set_alpn_protos(b"\x08http/1.1")
        .map_err(|error| failure("alpn protocols", error))?;

    let mut store_builder = openssl::x509::store::X509StoreBuilder::new()
        .map_err(|error| failure("x509 store builder", error))?;

    for (index, pem) in ordered_pem.iter().enumerate() {
        let der_blocks = decode_certificate_pem_blocks(pem);
        if der_blocks.is_empty() {
            return Err(failure(
                &format!("root certificate {index}"),
                "no CERTIFICATE block found",
            ));
        }
        for der in der_blocks {
            let cert = openssl::x509::X509::from_der(&der)
                .map_err(|error| failure(&format!("root certificate {index} der decode"), error))?;
            store_builder
                .add_cert(cert)
                .map_err(|error| failure(&format!("root certificate {index} store add"), error))?;
        }
    }

    let store = store_builder.build();
    builder.set_cert_store(store);

    Ok(Arc::new(UpstreamTlsConnector {
        connector: builder.build(),
    }))
}

impl UpstreamTlsConnector {
    pub fn min_proto_version(&self) -> Option<openssl::ssl::SslVersion> {
        let v = unsafe {
            openssl_sys::SSL_CTX_get_min_proto_version(self.connector.context().as_ptr())
        };
        match v {
            openssl_sys::TLS1_2_VERSION => Some(openssl::ssl::SslVersion::TLS1_2),
            openssl_sys::TLS1_3_VERSION => Some(openssl::ssl::SslVersion::TLS1_3),
            _ => None,
        }
    }

    pub fn max_proto_version(&self) -> Option<openssl::ssl::SslVersion> {
        let v = unsafe {
            openssl_sys::SSL_CTX_get_max_proto_version(self.connector.context().as_ptr())
        };
        match v {
            openssl_sys::TLS1_2_VERSION => Some(openssl::ssl::SslVersion::TLS1_2),
            openssl_sys::TLS1_3_VERSION => Some(openssl::ssl::SslVersion::TLS1_3),
            _ => None,
        }
    }

    pub async fn connect<S>(
        &self,
        host: &str,
        stream: S,
    ) -> Result<tokio_openssl::SslStream<S>, MitmError>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let ssl = self
            .connector
            .configure()
            .map_err(|error| failure("ssl configuration", error))?;
        let mut ssl = ssl
            .into_ssl(host)
            .map_err(|error| failure("ssl creation", error))?;

        let param = ssl.param_mut();
        param.set_hostflags(openssl::x509::verify::X509CheckFlags::empty());
        match host.parse::<IpAddr>() {
            Ok(ip) => {
                param
                    .set_ip(ip)
                    .map_err(|error| failure("verify ip param", error))?;
            }
            Err(_) => {
                param
                    .set_host(host)
                    .map_err(|error| failure("verify host param", error))?;
            }
        }

        if host.parse::<IpAddr>().is_err() {
            ssl.set_hostname(host)
                .map_err(|error| failure("sni hostname", error))?;
        }

        let identity_host = host.to_owned();
        ssl.set_verify_callback(
            openssl::ssl::SslVerifyMode::PEER,
            move |verified, context| {
                if verified {
                    return true;
                }
                if context.error_depth() != 0
                    || context.error().as_raw() != openssl_sys::X509_V_ERR_HOSTNAME_MISMATCH
                {
                    return false;
                }
                let Some(cert) = context.current_cert() else {
                    return false;
                };
                if check_server_identity(&identity_host, &cert.to_owned()).is_err() {
                    return false;
                }
                context.set_error(openssl::x509::X509VerifyResult::OK);
                true
            },
        );

        let mut stream = tokio_openssl::SslStream::new(ssl, stream)
            .map_err(|error| failure("ssl stream", error))?;

        Pin::new(&mut stream)
            .connect()
            .await
            .map_err(|error| failure("tls handshake", error))?;

        let verify_result = stream.ssl().verify_result();
        if verify_result != openssl::x509::X509VerifyResult::OK {
            return Err(failure(
                "certificate verification",
                verify_result.error_string(),
            ));
        }

        let peer_cert = stream
            .ssl()
            .peer_certificate()
            .ok_or_else(|| failure("server identity", "no peer certificate presented"))?;

        check_server_identity(host, &peer_cert)
            .map_err(|reason| failure("server identity", reason))?;

        Ok(stream)
    }
}

fn unfqdn(host: &str) -> &str {
    host.strip_suffix('.').unwrap_or(host)
}

fn split_host(host: &str) -> Vec<String> {
    unfqdn(host)
        .split('.')
        .map(|s| s.to_ascii_lowercase())
        .collect()
}

fn check_wildcard(host_parts: &[String], pattern: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    let pattern_parts = split_host(pattern);
    if host_parts.len() != pattern_parts.len() {
        return false;
    }
    if pattern_parts.iter().any(|part| part.is_empty()) {
        return false;
    }
    if pattern_parts.iter().any(|s| {
        s.chars()
            .any(|c| !c.is_ascii() || c.is_ascii_control() || c == ' ')
    }) {
        return false;
    }
    for i in (1..host_parts.len()).rev() {
        if host_parts[i] != pattern_parts[i] {
            return false;
        }
    }
    let host_subdomain = &host_parts[0];
    let pattern_subdomain = &pattern_parts[0];
    let sub_parts: Vec<&str> = pattern_subdomain.split('*').collect();
    if sub_parts.len() == 1 || pattern_subdomain.contains("xn--") {
        return host_subdomain == pattern_subdomain;
    }
    if sub_parts.len() > 2 {
        return false;
    }
    if pattern_parts.len() <= 2 {
        return false;
    }
    let (prefix, suffix) = (sub_parts[0], sub_parts[1]);
    if prefix.len() + suffix.len() > host_subdomain.len() {
        return false;
    }
    if !host_subdomain.starts_with(prefix) || !host_subdomain.ends_with(suffix) {
        return false;
    }
    true
}

#[inline]
fn general_name_type(name: &openssl::x509::GeneralNameRef) -> std::ffi::c_int {
    unsafe { (*ForeignTypeRef::as_ptr(name)).type_ }
}

pub fn check_server_identity(host: &str, cert: &openssl::x509::X509) -> Result<(), String> {
    let hostname_ascii = unfqdn(host).to_ascii_lowercase();

    let mut dns_names = Vec::new();
    let mut ips = Vec::new();
    let mut has_dns_san = false;
    let mut has_undecodable_dns = false;

    if let Some(sans) = cert.subject_alt_names() {
        for name in &sans {
            let raw_type = general_name_type(name);
            if raw_type == openssl_sys::GEN_DNS {
                has_dns_san = true;
                if let Some(dns) = name.dnsname() {
                    dns_names.push(dns.to_ascii_lowercase());
                } else {
                    has_undecodable_dns = true;
                }
            } else if let Some(ip) = name.ipaddress() {
                if ip.len() == 4 {
                    ips.push(IpAddr::V4(std::net::Ipv4Addr::new(
                        ip[0], ip[1], ip[2], ip[3],
                    )));
                } else if ip.len() == 16 {
                    let mut octets = [0u8; 16];
                    octets.copy_from_slice(ip);
                    ips.push(IpAddr::V6(std::net::Ipv6Addr::from(octets)));
                }
            }
        }
    }

    if let Ok(ip) = hostname_ascii.parse::<IpAddr>() {
        if ips.contains(&ip) {
            return Ok(());
        }
        return Err(format!("IP: {} is not in cert altnames: {:?}", host, ips));
    }

    if has_undecodable_dns {
        return Err(format!(
            "Host: {}. is not in cert altnames: undecodable DNS entry in subject alternative names",
            host
        ));
    }

    if has_dns_san {
        let host_parts = split_host(&hostname_ascii);
        if dns_names
            .iter()
            .any(|pattern| check_wildcard(&host_parts, pattern))
        {
            return Ok(());
        }
        return Err(format!(
            "Host: {}. is not in cert altnames: {:?}",
            host, dns_names
        ));
    }

    let subject = cert.subject_name();
    let mut cns = Vec::new();
    for entry in subject.entries_by_nid(openssl::nid::Nid::COMMONNAME) {
        if let Ok(data) = std::str::from_utf8(entry.data().as_slice()) {
            cns.push(data.to_string());
        }
    }

    if !cns.is_empty() {
        let host_parts = split_host(&hostname_ascii);
        if cns.iter().any(|cn| check_wildcard(&host_parts, cn)) {
            return Ok(());
        }
        return Err(format!("Host: {}. is not cert CN: {:?}", host, cns));
    }

    Err("Cert does not contain a DNS name".into())
}

pub struct PrefixedStream<S> {
    prefix: Vec<u8>,
    offset: usize,
    inner: S,
}
impl<S> PrefixedStream<S> {
    pub fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix,
            offset: 0,
            inner,
        }
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for PrefixedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.offset < self.prefix.len() {
            let available = &self.prefix[self.offset..];
            let count = available.len().min(buffer.remaining());
            buffer.put_slice(&available[..count]);
            self.offset += count;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(context, buffer)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(context, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(context)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(context)
    }
}

#[cfg(test)]
mod upstream_tls_tests;
