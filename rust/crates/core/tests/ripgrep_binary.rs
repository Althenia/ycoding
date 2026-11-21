pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::{
    future::Future,
    io::{Cursor, Write},
    path::Path,
    pin::Pin,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::platform::ripgrep_binary::{
    Download, Error, HttpDownload, Service, Target, VERSION,
};

#[test]
fn target_mapping_version_filenames_and_release_urls_match_typescript() {
    assert_eq!(VERSION, "15.1.0");
    for (key, triple, extension) in [
        ("arm64-darwin", "aarch64-apple-darwin", "tar.gz"),
        ("arm64-linux", "aarch64-unknown-linux-gnu", "tar.gz"),
        ("x64-darwin", "x86_64-apple-darwin", "tar.gz"),
        ("x64-linux", "x86_64-unknown-linux-musl", "tar.gz"),
        ("arm64-win32", "aarch64-pc-windows-msvc", "zip"),
        ("ia32-win32", "i686-pc-windows-msvc", "zip"),
        ("x64-win32", "x86_64-pc-windows-msvc", "zip"),
    ] {
        let target = Target::for_key(key).unwrap();
        assert_eq!(target.triple, triple);
        assert_eq!(target.extension, extension);
        assert_eq!(
            target.filename(),
            format!("ripgrep-15.1.0-{triple}.{extension}")
        );
        assert_eq!(
            target.url(),
            format!(
                "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-{triple}.{extension}"
            )
        );
    }
    assert_eq!(
        Target::for_key("riscv64-linux").unwrap_err().message,
        "unsupported platform for ripgrep: riscv64-linux"
    );
}

fn run(case: &str) {
    let working = Fixture::new();
    if case == "cache" {
        executable(
            &working.0.join("rg"),
            b"must not search the working directory",
        );
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "acquisition_child", "--nocapture"])
        .current_dir(&working.0)
        .env("YCODING_RG_CASE", case)
        .env("PATH", "")
        .env_remove("Path")
        .env("PATHEXT", ".EXE;.CMD;.BAT;.COM")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn system_path_precedes_cached_binary_and_cached_result_survives_removal() {
    run("system");
}
#[test]
fn cache_file_is_used_without_execute_permission_or_supported_target() {
    run("cache");
}
#[test]
fn tar_download_is_single_flight_pinned_executable_and_cleans_up_archives() {
    run("tar");
}
#[test]
fn zip_download_extracts_rg_exe_for_windows() {
    run("zip");
}
#[test]
fn windows_discovery_checks_cwd_and_pathext_before_the_cache() {
    run("windows-discovery");
}
#[test]
fn cancelling_a_waiter_keeps_the_single_shared_acquisition_running() {
    run("cancel");
}
#[test]
fn empty_download_is_rejected_and_failure_is_cached() {
    run("empty");
}
#[test]
fn status_and_transport_failures_are_cached_and_do_not_write_archives() {
    run("http-error");
}
#[test]
fn malformed_and_missing_executable_archives_fail_and_remove_temporary_directories() {
    run("archive-error");
}
#[test]
fn unsupported_target_is_lazy_and_does_not_download() {
    run("unsupported");
}
#[test]
fn standard_transport_rejects_plain_http_before_contacting_standin() {
    run("https");
}

fn executable(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

struct Standin {
    endpoint: String,
    requests: Arc<AtomicUsize>,
    urls: Mutex<Vec<String>>,
    http: reqwest::Client,
}

struct HeldDownload {
    http: Arc<Standin>,
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
    attempts: AtomicUsize,
}
impl Download for HeldDownload {
    fn get<'a>(
        &'a self,
        url: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, Error>> + Send + 'a>> {
        Box::pin(async move {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            self.started.notify_one();
            self.release.notified().await;
            self.http.get(url).await
        })
    }
}
impl Download for Standin {
    fn get<'a>(
        &'a self,
        url: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, Error>> + Send + 'a>> {
        Box::pin(async move {
            self.urls.lock().unwrap().push(url.into());
            let parsed = url::Url::parse(url).unwrap();
            assert_eq!(parsed.scheme(), "https");
            assert_eq!(parsed.host_str(), Some("github.com"));
            let response = self
                .http
                .get(format!("{}{}", self.endpoint, parsed.path()))
                .send()
                .await
                .map_err(|e| Error {
                    message: e.to_string(),
                })?;
            if !response.status().is_success() {
                return Err(Error {
                    message: format!("HTTP status {} for {url}", response.status().as_u16()),
                });
            }
            response
                .bytes()
                .await
                .map(|bytes| bytes.to_vec())
                .map_err(|e| Error {
                    message: e.to_string(),
                })
        })
    }
}

async fn standin(bytes: Vec<u8>, status: u16) -> (Arc<Standin>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let app =
        axum::Router::new().fallback(move |request: axum::http::Request<axum::body::Body>| {
            let bytes = bytes.clone();
            let count = count.clone();
            async move {
                assert_eq!(request.method(), axum::http::Method::GET);
                assert!(
                    request.uri().path().starts_with(
                        "/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-"
                    )
                );
                count.fetch_add(1, Ordering::SeqCst);
                (axum::http::StatusCode::from_u16(status).unwrap(), bytes)
            }
        });
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (
        Arc::new(Standin {
            endpoint,
            requests,
            urls: Mutex::new(Vec::new()),
            http: reqwest::Client::builder()
                .no_proxy()
                .retry(reqwest::retry::never())
                .build()
                .unwrap(),
        }),
        task,
    )
}

fn archive(key: &str, name: &str, bytes: &[u8]) -> Vec<u8> {
    let target = Target::for_key(key).unwrap();
    let path = format!("ripgrep-15.1.0-{}/{name}", target.triple);
    if target.extension == "zip" {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(
            path,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
        return zip.finish().unwrap().into_inner();
    }
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, path, bytes).unwrap();
    tar.into_inner().unwrap().finish().unwrap()
}

#[tokio::test]
async fn acquisition_child() {
    let Ok(case) = std::env::var("YCODING_RG_CASE") else {
        return;
    };
    let fixture = Fixture::new();
    let bin = fixture.0.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let windows = matches!(case.as_str(), "zip" | "windows-discovery");
    let key = if windows { "x64-win32" } else { "x64-linux" };
    let name = if windows { "rg.exe" } else { "rg" };
    let target = bin.join(name);
    if case == "system" {
        let system = fixture.0.join("system");
        std::fs::create_dir(&system).unwrap();
        executable(
            &system.join(if cfg!(windows) { "rg.exe" } else { "rg" }),
            b"system",
        );
        executable(&target, b"cached");
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "system_path_child", "--nocapture"])
            .env("YCODING_RG_SYSTEM", &system)
            .env("YCODING_RG_BIN", &bin)
            .env("PATH", format!("\"{}\"", system.display()))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        return;
    }
    let bytes = match case.as_str() {
        "empty" | "https" | "unsupported" | "http-error" => Vec::new(),
        "archive-error" => b"invalid archive".to_vec(),
        _ => archive(key, name, b"downloaded-binary"),
    };
    let (http, server) = standin(bytes, if case == "http-error" { 503 } else { 200 }).await;
    if case == "cache" {
        std::fs::write(&target, "cached").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
    }
    let service = Arc::new(Service::with_download(
        bin.clone(),
        if matches!(case.as_str(), "unsupported" | "cache") {
            "riscv64-linux".into()
        } else {
            key.into()
        },
        http.clone(),
    ));
    match case.as_str() {
        "windows-discovery" => {
            let working = std::env::current_dir().unwrap();
            let expected = working.join("rg.exe.CMD");
            executable(&expected, b"windows system");
            executable(&target, b"cached");
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "windows_path_child", "--nocapture"])
                .env("YCODING_RG_BIN", &bin)
                .env("PATHEXT", ".CMD")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(http.requests.load(Ordering::SeqCst), 0);
        }
        "cancel" => {
            let held = Arc::new(HeldDownload {
                http: http.clone(),
                started: tokio::sync::Notify::new(),
                release: tokio::sync::Notify::new(),
                attempts: AtomicUsize::new(0),
            });
            let service = Arc::new(Service::with_download(
                bin.clone(),
                key.into(),
                held.clone(),
            ));
            let first = service.clone();
            let first = tokio::spawn(async move { first.filepath().await });
            held.started.notified().await;
            first.abort();
            assert!(first.await.unwrap_err().is_cancelled());
            held.release.notify_one();
            assert_eq!(service.filepath().await.unwrap(), target);
            assert_eq!(held.attempts.load(Ordering::SeqCst), 1);
            assert_eq!(http.requests.load(Ordering::SeqCst), 1);
        }
        "tar" | "zip" => {
            let mut callers = tokio::task::JoinSet::new();
            for _ in 0..16 {
                let service = service.clone();
                callers.spawn(async move { service.filepath().await });
            }
            while let Some(result) = callers.join_next().await {
                assert_eq!(result.unwrap().unwrap(), target);
            }
            assert_eq!(std::fs::read(&target).unwrap(), b"downloaded-binary");
            assert_eq!(http.requests.load(Ordering::SeqCst), 1);
            assert_eq!(
                *http.urls.lock().unwrap(),
                [Target::for_key(key).unwrap().url()]
            );
            assert!(!bin.join(Target::for_key(key).unwrap().filename()).exists());
            assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 1);
            #[cfg(unix)]
            if !windows {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    target.metadata().unwrap().permissions().mode() & 0o777,
                    0o755
                );
            }
            std::fs::remove_file(&target).unwrap();
            assert_eq!(service.filepath().await.unwrap(), target);
            assert_eq!(http.requests.load(Ordering::SeqCst), 1);
        }
        "cache" => {
            assert_eq!(service.filepath().await.unwrap(), target);
            assert_eq!(http.requests.load(Ordering::SeqCst), 0);
        }
        "unsupported" => {
            assert_eq!(
                service.filepath().await.unwrap_err().message,
                "unsupported platform for ripgrep: riscv64-linux"
            );
            assert_eq!(http.requests.load(Ordering::SeqCst), 0);
        }
        "empty" | "http-error" => {
            let mut callers = tokio::task::JoinSet::new();
            for _ in 0..16 {
                let service = service.clone();
                callers.spawn(async move { service.filepath().await.unwrap_err() });
            }
            let first = callers.join_next().await.unwrap().unwrap();
            while let Some(result) = callers.join_next().await {
                assert_eq!(result.unwrap(), first);
            }
            assert_eq!(
                first.message,
                if case == "empty" {
                    format!(
                        "failed to download ripgrep from {}",
                        Target::for_key(key).unwrap().url()
                    )
                } else {
                    format!(
                        "HTTP status 503 for {}",
                        Target::for_key(key).unwrap().url()
                    )
                }
            );
            executable(&target, b"new cache");
            assert_eq!(service.filepath().await.unwrap_err(), first);
            assert_eq!(http.requests.load(Ordering::SeqCst), 1);
            assert!(!bin.join(Target::for_key(key).unwrap().filename()).exists());
            let offline = Service::with_download(
                fixture.0.join("offline"),
                key.into(),
                Arc::new(Standin {
                    endpoint: "http://127.0.0.1:0".into(),
                    requests: http.requests.clone(),
                    urls: Mutex::new(Vec::new()),
                    http: reqwest::Client::builder().no_proxy().build().unwrap(),
                }),
            );
            let error = offline.filepath().await.unwrap_err();
            assert!(!error.message.is_empty());
            assert_eq!(offline.filepath().await.unwrap_err(), error);
            assert_eq!(
                std::fs::read_dir(fixture.0.join("offline"))
                    .unwrap()
                    .count(),
                0
            );
        }
        "archive-error" => {
            assert!(!service.filepath().await.unwrap_err().message.is_empty());
            assert!(!target.exists());
            assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 1);
            for key in ["x64-linux", "x64-win32"] {
                let name = if key.ends_with("win32") {
                    "rg.exe"
                } else {
                    "rg"
                };
                let (missing, task) = standin(archive(key, "README.md", b"no binary"), 200).await;
                let missing_bin = bin.join(key);
                let missing = Service::with_download(missing_bin.clone(), key.into(), missing);
                let error = missing.filepath().await.unwrap_err();
                assert!(
                    error
                        .message
                        .starts_with("ripgrep archive did not contain executable: ")
                );
                assert!(error.message.ends_with(name));
                assert!(!missing_bin.join(name).exists());
                assert_eq!(std::fs::read_dir(&missing_bin).unwrap().count(), 1);
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            }
        }
        "https" => {
            assert!(
                !HttpDownload::new()
                    .unwrap()
                    .get(&http.endpoint)
                    .await
                    .unwrap_err()
                    .message
                    .is_empty()
            );
            assert_eq!(http.requests.load(Ordering::SeqCst), 0);
        }
        _ => panic!("Unknown case"),
    }
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn system_path_child() {
    let Some(system) = std::env::var_os("YCODING_RG_SYSTEM") else {
        return;
    };
    let bin = std::env::var_os("YCODING_RG_BIN").unwrap();
    let service = Service::new(bin.into()).unwrap();
    let expected = Path::new(&system).join(if cfg!(windows) { "rg.exe" } else { "rg" });
    assert_eq!(service.filepath().await.unwrap(), expected);
    std::fs::remove_file(&expected).unwrap();
    assert_eq!(service.filepath().await.unwrap(), expected);
}

#[tokio::test]
async fn windows_path_child() {
    let Some(bin) = std::env::var_os("YCODING_RG_BIN") else {
        return;
    };
    if std::env::var("PATHEXT").unwrap_or_default() != ".CMD" {
        return;
    }
    let http = Arc::new(Standin {
        endpoint: "http://127.0.0.1:0".into(),
        requests: Arc::new(AtomicUsize::new(0)),
        urls: Mutex::new(Vec::new()),
        http: reqwest::Client::builder().no_proxy().build().unwrap(),
    });
    let service = Service::with_download(bin.into(), "x64-win32".into(), http);
    assert_eq!(
        service.filepath().await.unwrap(),
        std::env::current_dir().unwrap().join("rg.exe.CMD")
    );
}
