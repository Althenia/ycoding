use std::{collections::VecDeque, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
};

pub struct Reply {
    pub method: &'static str,
    pub path: &'static str,
    pub status: u16,
    pub content_type: &'static str,
    pub headers: &'static str,
    pub body: String,
}

impl Reply {
    pub fn stream(path: &'static str, body: impl Into<String>) -> Self {
        Self {
            method: "POST",
            path,
            status: 200,
            content_type: "text/event-stream",
            headers: "",
            body: body.into(),
        }
    }

    pub fn json(method: &'static str, path: &'static str, status: u16, body: &str) -> Self {
        Self {
            method,
            path,
            status,
            content_type: "application/json",
            headers: "",
            body: body.into(),
        }
    }
}

#[derive(Debug)]
pub struct Captured {
    pub headers: String,
    pub body: String,
}

pub struct Replay {
    pub base: String,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Vec<Captured>>>,
}

impl Replay {
    pub async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let origin = base.clone();
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut replies = VecDeque::from(replies);
            let mut captured = Vec::new();
            loop {
                let (mut socket, _) = tokio::select! {
                    biased;
                    accepted = listener.accept() => accepted.unwrap(),
                    _ = &mut stopped => break,
                };
                let observed = tokio::time::timeout(Duration::from_secs(15), async {
                    let mut bytes = Vec::new();
                    let mut buffer = [0; 4096];
                    let boundary = loop {
                        let count = socket.read(&mut buffer).await.unwrap();
                        assert_ne!(count, 0, "request headers truncated");
                        bytes.extend_from_slice(&buffer[..count]);
                        assert!(bytes.len() <= 4 * 1024 * 1024, "unbounded request");
                        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                            break end + 4;
                        }
                    };
                    let headers = std::str::from_utf8(&bytes[..boundary]).unwrap().to_owned();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    assert!(length <= 4 * 1024 * 1024);
                    while bytes.len() - boundary < length {
                        let count = socket.read(&mut buffer).await.unwrap();
                        assert_ne!(count, 0, "request body truncated");
                        bytes.extend_from_slice(&buffer[..count]);
                    }
                    Captured {
                        headers,
                        body: std::str::from_utf8(&bytes[boundary..boundary + length])
                            .unwrap()
                            .into(),
                    }
                })
                .await
                .unwrap();
                let reply = replies.pop_front().expect("unplanned provider request");
                let line = observed.headers.lines().next().unwrap();
                assert!(
                    line == format!("{} {} HTTP/1.1", reply.method, reply.path)
                        || line == format!("{} {origin}{} HTTP/1.1", reply.method, reply.path),
                    "unplanned provider URL or method: {line}"
                );
                assert!(
                    observed.headers.lines().any(|line| {
                        line.split_once(':').is_some_and(|(name, value)| {
                            name.eq_ignore_ascii_case("host") && value.trim() == &origin[7..]
                        })
                    }),
                    "unplanned provider authority"
                );
                socket.write_all(format!(
                    "HTTP/1.1 {} Replay\r\nContent-Type: {}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
                    reply.status, reply.content_type, reply.body.len(), reply.headers,
                ).as_bytes()).await.unwrap();
                for chunk in reply.body.as_bytes().chunks(7) {
                    socket.write_all(chunk).await.unwrap();
                }
                socket.shutdown().await.unwrap();
                captured.push(observed);
            }
            assert!(
                replies.is_empty(),
                "planned provider requests were not consumed"
            );
            captured
        });
        Self {
            base,
            stop: Some(stop),
            task: Some(task),
        }
    }

    pub fn client(&self) -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(&self.base).unwrap())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap()
    }

    pub async fn finish(mut self) -> Vec<Captured> {
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(15), self.task.take().unwrap())
            .await
            .unwrap()
            .unwrap()
    }
}

impl Drop for Replay {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
