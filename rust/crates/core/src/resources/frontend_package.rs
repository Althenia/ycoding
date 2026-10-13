use crate::platform::process;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};
use ycoding_schema::{JsonValue, parse_json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidPackage,
    PermissionDenied,
    InstallFailed,
    EntrypointMissing,
    IntegrityFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asset {
    pub path: String,
    pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Descriptor {
    pub name: String,
    pub version: String,
    pub digest: String,
    pub root: PathBuf,
    pub entrypoint: Asset,
}

pub struct Service {
    cache: PathBuf,
    npm: PathBuf,
    env: BTreeMap<String, String>,
    policy: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl Service {
    pub fn new(
        cache: PathBuf,
        npm: PathBuf,
        env: BTreeMap<String, String>,
        policy: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    ) -> Self {
        Self {
            cache,
            npm,
            env,
            policy,
        }
    }

    pub async fn resolve(&self, spec: &str) -> Result<Descriptor, Error> {
        let name = selector(spec)?;
        if !(self.policy)(spec) {
            return Err(Error::PermissionDenied);
        }
        let key = if cfg!(windows) {
            spec.chars()
                .map(|character| {
                    if character.is_control() || "<>:\"|?*".contains(character) {
                        '_'
                    } else {
                        character
                    }
                })
                .collect::<String>()
        } else {
            spec.to_owned()
        };
        let directory = self.cache.join("packages").join(key);
        let lock = package_lock(&directory)?;
        let _guard = lock.lock().await;
        fs::create_dir_all(&directory).map_err(|_| Error::InstallFailed)?;
        let owned_lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(directory.join(".npm-install.lock"))
            .map_err(|_| Error::InstallFailed)?;
        owned_lock.try_lock().map_err(|_| Error::InstallFailed)?;
        let archive = directory.join("distribution.tgz");
        let receipt = directory.join("frontend-package.json");
        if receipt.exists() {
            let stored: serde_json::Value =
                serde_json::from_slice(&fs::read(&receipt).map_err(|_| Error::IntegrityFailed)?)
                    .map_err(|_| Error::IntegrityFailed)?;
            let saved_name = stored["name"].as_str().ok_or(Error::IntegrityFailed)?;
            let saved_version = stored["version"].as_str().ok_or(Error::IntegrityFailed)?;
            let saved_digest = stored["digest"].as_str().ok_or(Error::IntegrityFailed)?;
            if saved_name != name || stored["spec"].as_str() != Some(spec) {
                return Err(Error::IntegrityFailed);
            }
            let name = saved_name.to_owned();
            let version = saved_version.to_owned();
            let digest = saved_digest.to_owned();
            let result = tokio::task::spawn_blocking(move || {
                verify(&directory, &archive, &name, &version, Some(&digest))
            })
            .await
            .map_err(|_| Error::InstallFailed)?;
            owned_lock.unlock().map_err(|_| Error::InstallFailed)?;
            return result;
        }
        let output = self
            .command(
                &directory,
                &[
                    "pack",
                    "--ignore-scripts",
                    "--json",
                    "--pack-destination",
                    ".",
                    "--",
                    spec,
                ],
            )
            .await?;
        let packed: serde_json::Value =
            serde_json::from_slice(&output).map_err(|_| Error::InstallFailed)?;
        let packed = packed
            .as_array()
            .and_then(|items| items.first())
            .ok_or(Error::InstallFailed)?;
        let packed_name = packed["name"].as_str().ok_or(Error::InstallFailed)?;
        let version = packed["version"].as_str().ok_or(Error::InstallFailed)?;
        if packed_name != name || !exact_version(version) {
            return Err(Error::IntegrityFailed);
        }
        let filename = packed["filename"].as_str().ok_or(Error::InstallFailed)?;
        let filename = contained(filename)?;
        if filename.components().count() != 1 {
            return Err(Error::IntegrityFailed);
        }
        let downloaded = directory.join(filename);
        let bytes = read_archive(&downloaded)?;
        let integrity = packed["integrity"].as_str().ok_or(Error::IntegrityFailed)?;
        if integrity != archive_integrity(&bytes) {
            return Err(Error::IntegrityFailed);
        }
        let verified_name = name.clone();
        let verified_version = version.to_owned();
        tokio::task::spawn_blocking(move || {
            distribution(&bytes, &verified_name, &verified_version)
        })
        .await
        .map_err(|_| Error::InstallFailed)??;
        if downloaded != archive {
            fs::rename(&downloaded, &archive).map_err(|_| Error::InstallFailed)?;
        }
        self.command(
            &directory,
            &[
                "install",
                "--ignore-scripts",
                "--save-prod",
                "--save-exact",
                "--bin-links=true",
                "--no-audit",
                "--no-fund",
                "--",
                archive.to_str().ok_or(Error::InstallFailed)?,
            ],
        )
        .await?;
        let version = version.to_owned();
        let descriptor = tokio::task::spawn_blocking(move || {
            verify(&directory, &archive, &name, &version, None)
        })
        .await
        .map_err(|_| Error::InstallFailed)??;
        let stored = serde_json::json!({"spec": spec, "name": descriptor.name, "version": descriptor.version, "digest": descriptor.digest});
        fs::write(
            receipt,
            serde_json::to_vec(&stored).map_err(|_| Error::InstallFailed)?,
        )
        .map_err(|_| Error::InstallFailed)?;
        owned_lock.unlock().map_err(|_| Error::InstallFailed)?;
        Ok(descriptor)
    }

    async fn command(&self, directory: &Path, args: &[&str]) -> Result<Vec<u8>, Error> {
        let mut command = process::Command::new(
            self.npm.to_str().ok_or(Error::InstallFailed)?,
            args.iter().copied(),
        );
        command.cwd = Some(directory.into());
        command.env = self.env.clone();
        command.stdin = process::Input::Ignore;
        let result = process::run(
            command,
            process::RunOptions {
                max_output_bytes: Some(1024 * 1024),
                max_error_bytes: Some(64 * 1024),
                timeout: Some(Duration::from_secs(120)),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| Error::InstallFailed)?;
        if result.exit.code != Some(0) || result.stdout_truncated {
            return Err(Error::InstallFailed);
        }
        Ok(result.stdout)
    }
}

type PackageLocks = Mutex<BTreeMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>;
fn package_lock(path: &Path) -> Result<Arc<tokio::sync::Mutex<()>>, Error> {
    static LOCKS: OnceLock<PackageLocks> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| Error::InstallFailed)?;
    locks.retain(|_, value| value.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(path.into(), Arc::downgrade(&lock));
    Ok(lock)
}

fn selector(spec: &str) -> Result<String, Error> {
    if spec.is_empty() || spec.encode_utf16().count() > 2048 || spec.trim() != spec {
        return Err(Error::InvalidPackage);
    }
    let separator = spec
        .char_indices()
        .skip(1)
        .find(|(_, character)| *character == '@')
        .map(|(index, _)| index);
    let name = separator.map_or(spec, |index| &spec[..index]);
    let parts = name
        .strip_prefix('@')
        .map_or_else(|| vec![name], |name| name.split('/').collect());
    if (name.starts_with('@') && parts.len() != 2)
        || (!name.starts_with('@') && name.contains('/'))
        || name.encode_utf16().count() > 256
        || parts.iter().any(|part| {
            part.is_empty()
                || part.starts_with(['.', '-'])
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return Err(Error::InvalidPackage);
    }
    if let Some(index) = separator {
        let version = &spec[index + 1..];
        if version.is_empty()
            || !version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b" .+-~^*<>=|".contains(&byte))
        {
            return Err(Error::InvalidPackage);
        }
    }
    Ok(name.to_owned())
}

fn exact_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 128
        && version.split(['-', '+']).next().is_some_and(|version| {
            let parts = version.split('.').collect::<Vec<_>>();
            parts.len() == 3
                && parts
                    .iter()
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        })
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

fn read_archive(path: &Path) -> Result<Vec<u8>, Error> {
    if fs::metadata(path)
        .map_err(|_| Error::IntegrityFailed)?
        .len()
        > 64 * 1024 * 1024
    {
        return Err(Error::IntegrityFailed);
    }
    fs::read(path).map_err(|_| Error::IntegrityFailed)
}

struct Distribution {
    files: Vec<(PathBuf, String)>,
    manifest: JsonValue,
}

fn distribution(bytes: &[u8], name: &str, version: &str) -> Result<Distribution, Error> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut files = Vec::new();
    let mut seen = BTreeSet::new();
    let mut manifest = None;
    let mut total = 0_u64;
    for entry in archive.entries().map_err(|_| Error::IntegrityFailed)? {
        let mut entry = entry.map_err(|_| Error::IntegrityFailed)?;
        let path = entry.path().map_err(|_| Error::IntegrityFailed)?;
        let path = path
            .strip_prefix("package")
            .map_err(|_| Error::IntegrityFailed)?;
        if path.as_os_str().is_empty() && entry.header().entry_type().is_dir() {
            continue;
        }
        let path = contained(path.to_str().ok_or(Error::IntegrityFailed)?)?;
        if entry.header().entry_type().is_dir() {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err(Error::IntegrityFailed);
        }
        total = total
            .checked_add(entry.size())
            .ok_or(Error::IntegrityFailed)?;
        if total > 256 * 1024 * 1024 || files.len() >= 65536 || !seen.insert(path.clone()) {
            return Err(Error::IntegrityFailed);
        }
        let mut content = Vec::new();
        entry
            .read_to_end(&mut content)
            .map_err(|_| Error::IntegrityFailed)?;
        if path == Path::new("package.json") {
            let value =
                parse_json(std::str::from_utf8(&content).map_err(|_| Error::IntegrityFailed)?)
                    .map_err(|_| Error::IntegrityFailed)?;
            if text(&value, "name") != Some(name) || text(&value, "version") != Some(version) {
                return Err(Error::IntegrityFailed);
            }
            manifest = Some(value);
        }
        files.push((path, digest(&content)));
    }
    Ok(Distribution {
        files,
        manifest: manifest.ok_or(Error::IntegrityFailed)?,
    })
}

fn verify(
    directory: &Path,
    archive: &Path,
    name: &str,
    version: &str,
    expected: Option<&str>,
) -> Result<Descriptor, Error> {
    if !exact_version(version) {
        return Err(Error::IntegrityFailed);
    }
    let bytes = read_archive(archive)?;
    let package_digest = digest(&bytes);
    if expected.is_some_and(|expected| expected != package_digest) {
        return Err(Error::IntegrityFailed);
    }
    let distribution = distribution(&bytes, name, version)?;
    let root = fs::canonicalize(directory.join("node_modules").join(name))
        .map_err(|_| Error::IntegrityFailed)?;
    let cache = fs::canonicalize(directory).map_err(|_| Error::IntegrityFailed)?;
    if !root.starts_with(cache.join("node_modules")) {
        return Err(Error::IntegrityFailed);
    }
    for (path, expected) in &distribution.files {
        let path = fs::canonicalize(root.join(path)).map_err(|_| Error::IntegrityFailed)?;
        if !path.starts_with(&root) || file_digest(&path)? != *expected {
            return Err(Error::IntegrityFailed);
        }
    }
    let entry = entrypoint(&distribution.manifest, &root)?;
    let canonical = fs::canonicalize(root.join(&entry)).map_err(|_| Error::EntrypointMissing)?;
    if !canonical.starts_with(&root) {
        return Err(Error::IntegrityFailed);
    }
    let entry_digest = file_digest(&canonical)?;
    if !distribution
        .files
        .iter()
        .any(|(path, digest)| path == &entry && digest == &entry_digest)
    {
        return Err(Error::IntegrityFailed);
    }
    if root
        .to_str()
        .is_none_or(|root| root.encode_utf16().count() > 8192)
    {
        return Err(Error::IntegrityFailed);
    }
    Ok(Descriptor {
        name: name.into(),
        version: version.into(),
        digest: package_digest,
        root,
        entrypoint: Asset {
            path: entry
                .to_str()
                .ok_or(Error::IntegrityFailed)?
                .replace('\\', "/"),
            digest: entry_digest,
        },
    })
}

fn entrypoint(manifest: &JsonValue, root: &Path) -> Result<PathBuf, Error> {
    if let Some(exports) =
        field(manifest, "exports").filter(|exports| !matches!(exports, JsonValue::Null))
    {
        let JsonValue::Object(exports) = exports else {
            return Err(Error::EntrypointMissing);
        };
        let target = exports
            .get(&"./tui".into())
            .map(|target| (target, String::new()))
            .or_else(|| {
                exports
                    .iter()
                    .filter_map(|(key, target)| {
                        let key = key.as_str()?;
                        let (prefix, suffix) = key.split_once('*')?;
                        let matched = "./tui".strip_prefix(prefix)?.strip_suffix(suffix)?;
                        Some((prefix.len(), suffix.len(), target, matched.to_owned()))
                    })
                    .max_by_key(|(prefix, suffix, _, _)| (*prefix, *suffix))
                    .map(|(_, _, target, matched)| (target, matched))
            })
            .ok_or(Error::EntrypointMissing)?;
        let target = export_target(target.0)
            .ok_or(Error::EntrypointMissing)?
            .replace('*', &target.1);
        return contained(target.strip_prefix("./").ok_or(Error::IntegrityFailed)?);
    }
    for path in ["tui", "tui.js", "tui.json", "tui.node"] {
        if root.join(path).is_file() {
            return contained(path);
        }
    }
    if root.join("tui/package.json").is_file() {
        let manifest = parse_json(
            &fs::read_to_string(root.join("tui/package.json"))
                .map_err(|_| Error::EntrypointMissing)?,
        )
        .map_err(|_| Error::EntrypointMissing)?;
        if let Some(main) = text(&manifest, "main") {
            let path = contained(&format!("tui/{main}"))?;
            if root.join(&path).is_file() {
                return Ok(path);
            }
        }
    }
    for path in ["tui/index.js", "tui/index.json", "tui/index.node"] {
        if root.join(path).is_file() {
            return contained(path);
        }
    }
    Err(Error::EntrypointMissing)
}

fn export_target(value: &JsonValue) -> Option<&str> {
    match value {
        JsonValue::String(value) => value.as_str(),
        JsonValue::Array(values) => values.iter().find_map(export_target),
        JsonValue::Object(values) => values
            .iter()
            .filter(|(condition, _)| {
                condition.as_str().is_some_and(|condition| {
                    ["node", "import", "module-sync", "node-addons", "default"].contains(&condition)
                })
            })
            .find_map(|(_, value)| export_target(value)),
        _ => None,
    }
}

fn contained(value: &str) -> Result<PathBuf, Error> {
    let path = Path::new(value);
    if value.is_empty()
        || value.encode_utf16().count() > 8192
        || value.contains(['\\', '\0'])
        || value.contains(':')
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(Error::IntegrityFailed);
    }
    Ok(path.components().collect())
}
fn digest(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn file_digest(path: &Path) -> Result<String, Error> {
    let mut file = fs::File::open(path)
        .map_err(|_| Error::IntegrityFailed)?
        .take(256 * 1024 * 1024 + 1);
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = [0_u8; 65536];
    let mut size = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|_| Error::IntegrityFailed)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > 256 * 1024 * 1024 {
            return Err(Error::IntegrityFailed);
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
fn archive_integrity(bytes: &[u8]) -> String {
    let hash = ring::digest::digest(&ring::digest::SHA512, bytes);
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let encoded: String = hash
        .as_ref()
        .chunks(3)
        .flat_map(|group| {
            let word = (u32::from(group[0]) << 16)
                | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
                | u32::from(*group.get(2).unwrap_or(&0));
            (0..4).map(move |index| {
                if index > group.len() {
                    '='
                } else {
                    alphabet[((word >> (18 - 6 * index)) & 63) as usize] as char
                }
            })
        })
        .collect();
    format!("sha512-{encoded}")
}
fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&key.into()),
        _ => None,
    }
}
fn text<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    match field(value, key) {
        Some(JsonValue::String(value)) => value.as_str(),
        _ => None,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        io::Write,
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        root: PathBuf,
        archive: PathBuf,
        metadata: PathBuf,
        npm: PathBuf,
    }
    impl Fixture {
        fn new(exports: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "frontend-package-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            let archive = root.join("fixture.tgz");
            let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
                Vec::new(),
                flate2::Compression::default(),
            ));
            let manifest = format!(
                r#"{{"name":"@fixture/presentation","version":"1.2.3","exports":{exports},"scripts":{{"postinstall":"touch SHOULD_NOT_RUN"}},"dependencies":{{"fixture-helper":"1.0.0"}},"bundledDependencies":["fixture-helper"],"bin":{{"fixture-presentation":"tui.js"}}}}"#
            );
            for (path, content) in [
                ("package/package.json", manifest.as_str()),
                ("package/tui.js", "export default 'fixture'\n"),
                (
                    "package/node_modules/fixture-helper/package.json",
                    "{\"name\":\"fixture-helper\",\"version\":\"1.0.0\",\"main\":\"index.js\"}",
                ),
                (
                    "package/node_modules/fixture-helper/index.js",
                    "module.exports = 'helper'\n",
                ),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                tar.append_data(&mut header, path, content.as_bytes())
                    .unwrap();
            }
            let bytes = tar.into_inner().unwrap().finish().unwrap();
            fs::write(&archive, &bytes).unwrap();
            let metadata = root.join("pack.json");
            let hash = ring::digest::digest(&ring::digest::SHA512, &bytes);
            fs::write(&metadata, serde_json::to_vec(&serde_json::json!([{"name":"@fixture/presentation","version":"1.2.3","filename":"fixture.tgz","integrity":format!("sha512-{}", crate::meeting::pcm::encode_base64(hash.as_ref()))}])).unwrap()).unwrap();
            let npm = root.join("npm-fixture");
            fs::write(&npm, "#!/bin/sh\nif [ \"$1\" = pack ]; then\n  printf 'pack\\n' >> \"$FIXTURE_CALLS\"\n  cp \"$FIXTURE_ARCHIVE\" fixture.tgz\n  cat \"$FIXTURE_METADATA\"\n  exit 0\nfi\nexec npm --offline --cache \"$FIXTURE_NPM_CACHE\" --userconfig \"$FIXTURE_NPM_CONFIG\" \"$@\"\n").unwrap();
            fs::set_permissions(&npm, fs::Permissions::from_mode(0o755)).unwrap();
            fs::write(root.join("empty.npmrc"), "").unwrap();
            Self {
                root,
                archive,
                metadata,
                npm,
            }
        }
        fn service(&self, allowed: bool) -> Service {
            Service::new(
                self.root.join("cache"),
                self.npm.clone(),
                BTreeMap::from([
                    (
                        "FIXTURE_ARCHIVE".into(),
                        self.archive.to_str().unwrap().into(),
                    ),
                    (
                        "FIXTURE_METADATA".into(),
                        self.metadata.to_str().unwrap().into(),
                    ),
                    (
                        "FIXTURE_CALLS".into(),
                        self.root.join("calls").to_str().unwrap().into(),
                    ),
                    (
                        "FIXTURE_NPM_CACHE".into(),
                        self.root.join("npm-cache").to_str().unwrap().into(),
                    ),
                    (
                        "FIXTURE_NPM_CONFIG".into(),
                        self.root.join("empty.npmrc").to_str().unwrap().into(),
                    ),
                    (
                        "npm_config_registry".into(),
                        "https://example.invalid".into(),
                    ),
                    ("npm_config_offline".into(), "true".into()),
                ]),
                Arc::new(move |_| allowed),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[tokio::test]
    async fn installs_scoped_fixture_with_dependencies_no_scripts_and_reuses_verified_cache() {
        let fixture = Fixture::new(
            r#"{"./tui":{"browser":"./missing.js","import":"./tui.js","default":"./missing.js"}}"#,
        );
        let service = fixture.service(true);
        let (first, concurrent) = tokio::join!(
            service.resolve("@fixture/presentation@^1.0.0"),
            service.resolve("@fixture/presentation@^1.0.0")
        );
        let first = first.unwrap();
        assert_eq!(concurrent.unwrap(), first);
        assert_eq!(first.name, "@fixture/presentation");
        assert_eq!(first.version, "1.2.3");
        assert_eq!(first.entrypoint.path, "tui.js");
        assert_eq!(
            first.digest,
            ring::digest::digest(&ring::digest::SHA256, &fs::read(&fixture.archive).unwrap())
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert_eq!(
            first.entrypoint.digest,
            ring::digest::digest(&ring::digest::SHA256, b"export default 'fixture'\n")
                .as_ref()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        assert!(first.root.is_absolute());
        assert!(
            first
                .root
                .join("node_modules/fixture-helper/index.js")
                .is_file()
        );
        assert!(!first.root.join("SHOULD_NOT_RUN").exists());
        assert_eq!(
            service
                .resolve("@fixture/presentation@^1.0.0")
                .await
                .unwrap(),
            first
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("calls")).unwrap(),
            "pack\n"
        );
        fs::write(first.root.join("tui.js"), "tampered").unwrap();
        assert_eq!(
            service.resolve("@fixture/presentation@^1.0.0").await,
            Err(Error::IntegrityFailed)
        );
    }

    #[tokio::test]
    async fn rejects_untrusted_packages_bad_selectors_missing_entrypoints_and_archive_integrity() {
        let fixture = Fixture::new(r#"{"./tui":"./absent.js"}"#);
        let denied = fixture.service(false);
        assert_eq!(
            denied.resolve("@fixture/presentation").await,
            Err(Error::PermissionDenied)
        );
        assert!(!fixture.root.join("cache").exists());
        for spec in [
            "",
            "file:/tmp/package",
            "../package",
            "https://example.invalid/package.tgz",
            "git+https://example.invalid/pkg",
            "--flag",
            "name@",
            "name@npm:alias",
            "@fixture/pkg/extra",
        ] {
            assert_eq!(
                denied.resolve(spec).await,
                Err(Error::InvalidPackage),
                "{spec}"
            );
        }
        assert_eq!(
            fixture.service(true).resolve("@fixture/presentation").await,
            Err(Error::EntrypointMissing)
        );
        let fixture = Fixture::new(r#"{"./tui":"../escape.js"}"#);
        assert_eq!(
            fixture.service(true).resolve("@fixture/presentation").await,
            Err(Error::IntegrityFailed)
        );
        let fixture = Fixture::new(r#"{"./tui":"./tui.js"}"#);
        fs::OpenOptions::new()
            .append(true)
            .open(&fixture.archive)
            .unwrap()
            .write_all(b"tamper")
            .unwrap();
        assert_eq!(
            fixture.service(true).resolve("@fixture/presentation").await,
            Err(Error::IntegrityFailed)
        );
        let fixture = Fixture::new(r#"{"./tui":"./tui.js"}"#);
        fs::write(&fixture.npm, "#!/bin/sh\nexit 1\n").unwrap();
        assert_eq!(
            fixture.service(true).resolve("@fixture/presentation").await,
            Err(Error::InstallFailed)
        );
    }

    #[test]
    fn package_paths_and_distribution_links_cannot_escape() {
        for path in [
            "../escape",
            "/escape",
            "tui/../../escape",
            "C:/escape",
            "tui\\escape",
        ] {
            assert_eq!(contained(path), Err(Error::IntegrityFailed));
        }
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_cksum();
        tar.append_link(&mut header, "package/tui.js", "../../escape")
            .unwrap();
        let archive = tar.into_inner().unwrap().finish().unwrap();
        assert!(matches!(
            distribution(&archive, "fixture", "1.0.0"),
            Err(Error::IntegrityFailed)
        ));
    }

    #[test]
    fn wildcard_conditions_and_unexported_tui_files_use_contained_paths() {
        let fixture = Fixture::new(r#"{"./t*":"./*.js"}"#);
        fs::write(fixture.root.join("tui.js"), "fixture").unwrap();
        let manifest = parse_json(
            r#"{"exports":{"./t*":{"node":{"import":"./t*.js"},"default":"./absent.js"}}}"#,
        )
        .unwrap();
        assert_eq!(
            entrypoint(&manifest, &fixture.root).unwrap(),
            PathBuf::from("tui.js")
        );
        for manifest in [
            r#"{"name":"fixture"}"#,
            r#"{"name":"fixture","exports":null}"#,
        ] {
            assert_eq!(
                entrypoint(&parse_json(manifest).unwrap(), &fixture.root).unwrap(),
                PathBuf::from("tui.js")
            );
        }
    }
}
