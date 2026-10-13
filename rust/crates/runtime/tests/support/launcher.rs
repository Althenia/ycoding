use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use ycoding_core::ycoding_schema::{JsonValue, parse_json};
use ycoding_runtime::launch::service_filename;

static NEXT: AtomicU64 = AtomicU64::new(0);

pub struct Directory(pub PathBuf);

impl Directory {
    pub fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "launcher-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    pub fn command(&self, version: &str, channel: &str) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ycoding-runtime"));
        command
            .env("HOME", self.0.join("home"))
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_DATA_HOME", self.0.join("data"))
            .env("XDG_STATE_HOME", self.0.join("state"))
            .env("XDG_CACHE_HOME", self.0.join("cache"))
            .env("TMPDIR", self.0.join("tmp"))
            .env("YCODING_VERSION", version)
            .env("YCODING_CHANNEL", channel)
            .env("YCODING_DISABLE_MODELS_FETCH", "true")
            .env("YCODING_CONFIG_PROJECT_DISABLE", "true")
            .env_remove("YCODING_CONFIG_DIR")
            .env_remove("YCODING_CONFIG")
            .env_remove("YCODING_CONFIG_CONTENT")
            .env_remove("YCODING_TEST_HOME")
            .env_remove("YCODING_MODELS_PATH")
            .env_remove("YCODING_MODELS_URL")
            .env_remove("YCODING_PASSWORD")
            .env_remove("YCODING_SERVER_PASSWORD")
            .env_remove("YCODING_SERVICE_STARTUP_ERROR_FILE")
            .env_remove("OTEL_EXPORTER_OTLP_ENDPOINT");
        std::fs::create_dir_all(self.0.join("home")).unwrap();
        command
    }

    pub fn registration(&self, channel: &str) -> PathBuf {
        self.0
            .join("state")
            .join(ycoding_runtime::launch::namespace(channel))
            .join(service_filename(channel))
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct Runtime {
    pub child: Child,
    lines: std::sync::mpsc::Receiver<String>,
    reader: Option<std::thread::JoinHandle<()>>,
}

impl Runtime {
    pub fn spawn(mut command: Command, args: &[&str]) -> Self {
        let mut child = command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, lines) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            lines,
            reader: Some(reader),
        }
    }

    pub fn ready(&self) -> String {
        self.lines
            .recv_timeout(Duration::from_secs(30))
            .expect("runtime did not publish readiness")
    }

    pub fn wait(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "runtime did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn signal(&self, signal: &str) {
        assert!(
            Command::new("kill")
                .args([signal, &self.child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

pub fn read(path: &std::path::Path) -> JsonValue {
    parse_json(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn string(value: &JsonValue, key: &str) -> String {
    let JsonValue::Object(object) = value else {
        panic!("expected object");
    };
    let Some(JsonValue::String(value)) = object.get(&key.into()) else {
        panic!("missing {key}");
    };
    value.to_utf8().unwrap()
}
