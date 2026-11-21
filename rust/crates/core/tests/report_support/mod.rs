use std::sync::{Mutex, mpsc};
use ycoding_core::ycoding_store::{Client, analytics, usage_cells};

static OWNER: Mutex<()> = Mutex::new(());

pub struct Reports {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

pub fn start(client: Client) -> Reports {
    start_with(client, true)
}

pub fn start_with(client: Client, drain_cells: bool) -> Reports {
    let (ready, started) = mpsc::sync_channel(1);
    let (stop, stopped) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let _owner = OWNER.lock().unwrap_or_else(|error| error.into_inner());
        let directory = std::env::temp_dir().join(format!(
            "ycoding-domain-reports-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let drain = client.clone();
        let engine = analytics::reports::start(client, &directory).unwrap();
        while drain_cells && !usage_cells::ready(&drain.snapshot().unwrap()).unwrap() {
            usage_cells::maintain(&drain).unwrap();
        }
        ready.send(()).unwrap();
        stopped.recv().unwrap();
        engine.shutdown().unwrap();
        if directory.exists() {
            std::fs::remove_dir_all(directory).unwrap();
        }
    });
    started.recv().unwrap();
    Reports {
        stop: Some(stop),
        thread: Some(thread),
    }
}

impl Drop for Reports {
    fn drop(&mut self) {
        self.stop.take().unwrap().send(()).unwrap();
        self.thread.take().unwrap().join().unwrap();
    }
}
