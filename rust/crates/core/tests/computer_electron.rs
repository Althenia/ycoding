use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio_tungstenite::tungstenite;
use ycoding_core::platform::computer::{
    electron::{self, Bridge, BridgeResult, Operation, Rect, Runtime, Window},
    types::{Action, Target},
};

struct Host {
    port: u16,
    fuse: Vec<u8>,
    signals: AtomicUsize,
}
impl Runtime for Host {
    fn app_path(&self, _pid: u32) -> Result<Option<std::path::PathBuf>, String> {
        Ok(Some("/fixture/Fixture.app".into()))
    }
    fn fuse_bytes(&self, _app: &std::path::Path) -> Result<Vec<u8>, String> {
        Ok(self.fuse.clone())
    }
    fn owned_ports(&self, _pid: u32) -> Result<Vec<u16>, String> {
        Ok(if self.port == 0 {
            Vec::new()
        } else {
            vec![self.port]
        })
    }
    fn signal(&self, _pid: u32) -> Result<(), String> {
        self.signals.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
    fn framework_exists(&self, _app: &std::path::Path) -> Result<bool, String> {
        Ok(true)
    }
}
fn target() -> Target {
    Target::Desktop {
        bundle_id: "com.example.electron".into(),
        pid: 4321,
        window_id: 73,
    }
}
fn window() -> Window {
    Window {
        id: 73,
        title: "Fixture".into(),
        bounds: Rect {
            x: 100.,
            y: 200.,
            width: 800.,
            height: 500.,
        },
        on_screen: false,
    }
}
struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    calls: Arc<Mutex<Vec<Value>>>,
    wrong: Arc<AtomicBool>,
    fail: Arc<AtomicBool>,
}
impl Server {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let wrong = Arc::new(AtomicBool::new(false));
        let fail = Arc::new(AtomicBool::new(false));
        let thread = std::thread::spawn({
            let stop = stop.clone();
            let calls = calls.clone();
            let wrong = wrong.clone();
            let fail = fail.clone();
            move || {
                let mut changed = false;
                for incoming in listener.incoming() {
                    let mut stream = incoming.unwrap();
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let mut peek = [0; 1024];
                    let count = stream.peek(&mut peek).unwrap();
                    let path = String::from_utf8_lossy(&peek[..count]);
                    if path.starts_with("GET /json/list") {
                        let mut header = Vec::new();
                        while !header.ends_with(b"\r\n\r\n") {
                            let mut byte = [0];
                            stream.read_exact(&mut byte).unwrap();
                            header.extend(byte);
                        }
                        let body=json!([{"type":"page","id":"page-1","title":if wrong.load(Ordering::Acquire){"Wrong"}else{"Fixture"},"webSocketDebuggerUrl":format!("ws://127.0.0.1:{port}/ws")}]).to_string();
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .unwrap();
                        continue;
                    }
                    let mut socket = tungstenite::accept(stream).unwrap();
                    while let Ok(message) = socket.read() {
                        if message.is_close() {
                            break;
                        }
                        if !message.is_text() {
                            continue;
                        }
                        let command: Value =
                            serde_json::from_str(message.to_text().unwrap()).unwrap();
                        calls.lock().unwrap().push(command.clone());
                        let method = command["method"].as_str().unwrap();
                        if method.starts_with("Input.") {
                            if fail.load(Ordering::Acquire) {
                                break;
                            }
                            changed = true;
                        }
                        let result = if method == "Runtime.evaluate" {
                            json!({"result":{"value":{"screenX":100,"screenY":200,"outerWidth":800,"outerHeight":500,"innerWidth":800,"innerHeight":478}}})
                        } else if method == "Page.captureScreenshot" {
                            let image = photon_rs::PhotonImage::new(
                                vec![if changed { 50 } else { 250 }, 0, 0, 255],
                                1,
                                1,
                            );
                            json!({"data":image.get_base64().split_once(',').unwrap().1})
                        } else {
                            json!({})
                        };
                        socket
                            .send(tungstenite::Message::Text(
                                json!({"id":command["id"],"result":result})
                                    .to_string()
                                    .into(),
                            ))
                            .unwrap();
                    }
                }
            }
        });
        Self {
            port,
            stop,
            thread: Some(thread),
            calls,
            wrong,
            fail,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        self.thread.take().unwrap().join().unwrap();
    }
}

#[tokio::test]
async fn pid_owned_renderer_capture_and_pixel_action_use_exact_window_and_never_signal_fuse_off() {
    let server = Server::new();
    let runtime = Arc::new(Host {
        port: server.port,
        fuse: b"binarydL7pKGdnNz796PbbjQWNKmHXBZaB9tsX\x01\x070000000".to_vec(),
        signals: AtomicUsize::new(0),
    });
    let bridge = Bridge::new(runtime.clone()).unwrap();
    assert!(matches!(
        bridge
            .perform(target(), window(), Operation::Capture, None)
            .await
            .unwrap(),
        Some(BridgeResult::Capture {
            width: 800,
            height: 500,
            ..
        })
    ));
    assert_eq!(
        bridge
            .perform(
                target(),
                window(),
                Operation::Action(Action::Click {
                    element: None,
                    x: Some(40),
                    y: Some(60),
                    button: None,
                    count: None
                }),
                None
            )
            .await
            .unwrap(),
        Some(BridgeResult::Action { changed: true })
    );
    assert_eq!(runtime.signals.load(Ordering::Acquire), 0);
    assert!(
        server
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|command| command["method"] == "Input.dispatchMouseEvent"
                && command["params"]["x"] == 40.
                && command["params"]["y"] == 38.)
    );
    server.wrong.store(true, Ordering::Release);
    assert_eq!(
        bridge
            .perform(target(), window(), Operation::Capture, None)
            .await
            .unwrap_err()
            .code,
        electron::Code::TargetNotFound
    );
}

#[tokio::test]
async fn dispatch_failure_is_unknown_and_cannot_fall_back_to_native_or_replay() {
    let server = Server::new();
    server.fail.store(true, Ordering::Release);
    let runtime = Arc::new(Host {
        port: server.port,
        fuse: vec![],
        signals: AtomicUsize::new(0),
    });
    let bridge = Bridge::new(runtime).unwrap();
    let failure = bridge
        .perform(
            target(),
            window(),
            Operation::Action(Action::Type {
                element: None,
                text: "hello".into(),
            }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(failure.code, electron::Code::UnknownOutcome);
    assert_eq!(
        server
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|command| command["method"] == "Input.insertText")
            .count(),
        1
    );
}

#[tokio::test]
async fn fuse_off_removed_and_absent_without_owned_endpoint_never_signal() {
    for flags in ["0000000", "000r000", ""] {
        let mut fuse = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".to_vec();
        fuse.extend_from_slice(&[1, flags.len() as u8]);
        fuse.extend_from_slice(flags.as_bytes());
        let runtime = Arc::new(Host {
            port: 0,
            fuse,
            signals: AtomicUsize::new(0),
        });
        let bridge = Bridge::new(runtime.clone()).unwrap();
        assert!(
            bridge
                .perform(target(), window(), Operation::Capture, None)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(runtime.signals.load(Ordering::Acquire), 0);
    }
}
