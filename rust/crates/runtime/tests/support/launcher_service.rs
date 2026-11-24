include!("launcher.rs");

use ycoding_core::ycoding_schema::parse_json;
use ycoding_runtime::launch::{namespace, service_filename};

impl Directory {
    pub fn registration(&self, channel: &str) -> PathBuf {
        self.0
            .join("state")
            .join(namespace(channel))
            .join(service_filename(channel))
    }
}

impl Runtime {
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

pub fn read(path: &std::path::Path) -> JsonValue {
    parse_json(&std::fs::read_to_string(path).unwrap()).unwrap()
}
