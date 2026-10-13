use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    net::TcpListener,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use ycoding_core::{
    event_feed::{Data, Ephemeral, Feed},
    observability::{self, Options},
    resources::config::Roots,
};
use ycoding_schema::parse_json;
use ycoding_store::{Catalog, Metadata, Store};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ycoding-observability-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join("data/ycoding/log").join(name)
    }
    fn run(&self, case: &str, env: &[(&str, &str)]) -> Output {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "bootstrap_child", "--nocapture"])
            .env_clear()
            .env("OBSERVABILITY_CHILD", case)
            .env("OBSERVABILITY_ROOT", &self.0)
            .envs(env.iter().copied())
            .output()
            .unwrap();
        assert!(output.status.success(), "child failed: {output:?}");
        output
    }
    fn text(&self, name: &str) -> String {
        fs::read_to_string(self.file(name)).unwrap()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn bootstrap_child() {
    let Ok(case) = std::env::var("OBSERVABILITY_CHILD") else {
        return;
    };
    let roots =
        Roots::development(&PathBuf::from(std::env::var("OBSERVABILITY_ROOT").unwrap())).unwrap();
    let mut options = Options::new(&roots, "fixture-version", "next /β", case == "local");
    if case == "file-error" {
        fs::create_dir_all(&roots.log).unwrap();
        options.log_directory = roots.log.join("not-a-directory");
        fs::write(&options.log_directory, "fixture").unwrap();
        assert!(matches!(
            observability::install(options),
            Err(observability::Error::File)
        ));
        options = Options::new(&roots, "fixture-version", "next /β", false);
    }
    let store = Store::disposable(
        ycoding_store::Options::core(),
        Catalog::new(1, &[]),
        Metadata::new([7; 16], 1),
    )
    .unwrap();
    let client = store.client();
    let feed = Feed::attach(&client);
    if case == "events" {
        options.events = Some(feed.clone());
    }
    let mut guard = observability::install(options).unwrap();
    match case.as_str() {
        "levels" => {
            tracing::debug!("debug entry");
            tracing::info!("info entry");
            tracing::warn!("warn entry");
            tracing::error!("error entry");
        }
        "format" => {
            let span = tracing::info_span!("request", session = %json!({"id":"session-1"}));
            let _entered = span.enter();
            tracing::info!(
                request = %json!({"method":"GET","timing":{"duration":42}}),
                tags = %json!(["api","test"]),
                empty = %json!({}),
                cause = "fixture cause",
                "request complete"
            );
        }
        "concurrent" => {
            let workers: Vec<_> = (0..4)
                .map(|worker| {
                    thread::spawn(move || {
                        for index in 0..50 {
                            tracing::info!(worker, index, "entry");
                        }
                    })
                })
                .collect();
            for worker in workers {
                worker.join().unwrap();
            }
        }
        "events" => {
            for kind in [
                "agent.updated",
                "catalog.updated",
                "command.updated",
                "config.updated",
                "mcp.status.changed",
                "skill.updated",
            ] {
                feed.publish(Ephemeral {
                    id: format!("event-{kind}").into(),
                    created: 7,
                    session: None,
                    location: None,
                    metadata: None,
                    data: Data::decode(
                        kind,
                        &parse_json(if kind == "mcp.status.changed" {
                            r#"{"server":"fixture"}"#
                        } else {
                            "{}"
                        })
                        .unwrap(),
                    )
                    .unwrap(),
                });
            }
        }
        "otlp" => {
            let parent = tracing::debug_span!("parent", request_id = "request-1");
            let entered = parent.enter();
            {
                let child = tracing::info_span!("child", answer = 42);
                child.record("answer", 43);
                let _child = child.enter();
                tracing::info!(component = "fixture", "export me");
            }
            drop(entered);
            {
                let explicit = tracing::info_span!(parent: &parent,"explicit");
                explicit.follows_from(&parent);
            }
            drop(parent);
        }
        "redact" => {
            let span = tracing::info_span!("safe span", authorization = "Bearer fixture-auth", credentials = %json!({"token":"fixture-nested"}));
            let _entered = span.enter();
            tracing::info!(
                headers = %json!({"Authorization":"fixture-header"}),
                request = %json!({"method":"GET","token":"fixture-token","accessToken":"fixture-access-token","rawResponse":"fixture-raw-response"}),
                payload = %json!({"provider":"fixture-raw"}),
                credential_id = "fixture-id",
                "transport fixture-otlp-header fixture-overridden-header"
            );
        }
        "closed" => {
            tracing::info!("before close");
            guard.close().unwrap();
            guard.close().unwrap();
            tracing::info!("after close");
        }
        "duplicate" => {
            let result =
                observability::install(Options::new(&roots, "fixture-version", "next", false));
            assert!(matches!(
                result,
                Err(observability::Error::AlreadyInstalled)
            ));
            tracing::info!("original sink retained");
        }
        _ => tracing::info!("secure"),
    }
    drop(guard);
    if case == "events" {
        assert_eq!(feed.subscribers(), 0);
    }
}

#[test]
fn naming_permissions_and_append_match_ts() {
    let dir = Directory::new();
    fs::create_dir_all(dir.file("ycoding.log").parent().unwrap()).unwrap();
    fs::write(dir.file("ycoding.log"), "existing\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir.file("ycoding.log"), fs::Permissions::from_mode(0o644)).unwrap();
    }
    dir.run("default", &[]);
    dir.run("local", &[]);
    assert!(dir.text("ycoding.log").starts_with("existing\ntimestamp="));
    assert!(dir.text("ycoding-next---.log").contains("message=secure"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in ["ycoding.log", "ycoding-next---.log"] {
            assert_eq!(
                fs::metadata(dir.file(file)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn level_partitions_and_exact_stderr_toggle() {
    for (level, count) in [
        (None, 3),
        (Some("debug"), 4),
        (Some("INFO"), 3),
        (Some("WaRn"), 2),
        (Some("ERROR"), 1),
        (Some("TRACE"), 3),
        (Some(" debug "), 3),
        (Some(""), 3),
    ] {
        let dir = Directory::new();
        let env: Vec<_> = level
            .map(|level| ("YCODING_LOG_LEVEL", level))
            .into_iter()
            .collect();
        let output = dir.run("levels", &env);
        assert!(output.stderr.is_empty());
        assert_eq!(dir.text("ycoding.log").lines().count(), count);
    }
    for (toggle, printed) in [("1", true), ("true", false), ("0", false)] {
        let dir = Directory::new();
        let output = dir.run(
            "levels",
            &[
                ("YCODING_PRINT_LOGS", toggle),
                ("YCODING_LOG_LEVEL", "WARN"),
            ],
        );
        assert_eq!(!output.stderr.is_empty(), printed);
        if printed {
            assert_eq!(
                String::from_utf8(output.stderr).unwrap(),
                dir.text("ycoding.log")
            );
        }
    }
}

#[test]
fn structured_format_flattens_messages_annotations_and_spans() {
    let dir = Directory::new();
    dir.run("format", &[]);
    let line = dir.text("ycoding.log");
    assert!(line.starts_with("timestamp="));
    for expected in [
        " level=INFO ",
        " run=",
        "message=\"request complete\"",
        "request.method=GET",
        "request.timing.duration=42",
        "tags=\"[\\\"api\\\",\\\"test\\\"]\"",
        "session.id=session-1",
        "empty={}",
        "cause=\"fixture cause\"",
        "request=",
    ] {
        assert!(line.contains(expected), "missing {expected}: {line}");
    }
    assert!(!line.contains("fiber="));
    assert!(!line.contains("request={"));
    let run = line
        .split(" run=")
        .nth(1)
        .unwrap()
        .split(' ')
        .next()
        .unwrap();
    assert_eq!(run.len(), 8);
    assert!(
        run.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
}

#[test]
fn concurrent_processes_append_complete_records_and_distinct_runs() {
    let dir = Directory::new();
    thread::scope(|scope| {
        scope.spawn(|| {
            dir.run("concurrent", &[]);
        });
        scope.spawn(|| {
            dir.run("concurrent", &[]);
        });
    });
    let text = dir.text("ycoding.log");
    let mut runs = BTreeMap::new();
    for line in text.lines() {
        assert!(line.starts_with("timestamp=") && line.contains(" level=INFO "));
        assert!(line.contains("worker=") && line.contains("index="));
        let run = line
            .split(" run=")
            .nth(1)
            .unwrap()
            .split(' ')
            .next()
            .unwrap();
        *runs.entry(run).or_insert(0) += 1;
    }
    assert_eq!(runs.len(), 2);
    assert_eq!(runs.values().copied().collect::<Vec<_>>(), vec![200, 200]);
}

#[test]
fn listed_events_are_observed_and_listener_is_released() {
    let dir = Directory::new();
    dir.run("events", &[]);
    let text = dir.text("ycoding.log");
    assert_eq!(text.lines().count(), 4);
    for kind in [
        "agent.updated",
        "catalog.updated",
        "command.updated",
        "config.updated",
    ] {
        assert!(text.contains(&format!("event.type={kind}")));
    }
    assert!(
        text.lines()
            .all(|line| line.contains("message=event") && line.contains("event.data={}"))
    );
    assert!(
        text.lines()
            .all(|line| line.contains("event.created=DateTime.Utc(1970-01-01T00:00:00.007Z)"))
    );
    assert!(!text.contains("mcp.status.changed") && !text.contains("skill.updated"));
}

#[test]
fn close_is_idempotent_and_duplicate_install_does_not_replace_sink() {
    let dir = Directory::new();
    dir.run("closed", &[]);
    assert!(dir.text("ycoding.log").contains("before close"));
    assert!(!dir.text("ycoding.log").contains("after close"));
    dir.run("duplicate", &[]);
    assert!(dir.text("ycoding.log").contains("original sink retained"));
    dir.run("file-error", &[]);
    assert!(dir.text("ycoding.log").contains("message=secure"));
}

fn receiver(status: u16) -> (String, thread::JoinHandle<Vec<(String, String, Value)>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let task = thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let mut requests = Vec::new();
        for _ in 0..2 {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(15), listener.accept()).await.expect("missing OTLP request").unwrap();
            let mut raw = Vec::new();
            let mut buffer = [0; 4096];
            let end = loop {
                let len = tokio::time::timeout(Duration::from_secs(10),stream.read(&mut buffer)).await.unwrap().unwrap(); assert_ne!(len, 0);
                raw.extend_from_slice(&buffer[..len]);
                if let Some(end) = raw.windows(4).position(|x| x == b"\r\n\r\n") { break end + 4; }
            };
            let headers = String::from_utf8(raw[..end].to_vec()).unwrap();
            let len: usize = headers.lines().find_map(|line| {
                let (key,value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
            }).unwrap();
            while raw.len() < end + len {
                let n = tokio::time::timeout(Duration::from_secs(10),stream.read(&mut buffer)).await.unwrap().unwrap(); assert_ne!(n, 0); raw.extend_from_slice(&buffer[..n]);
            }
            let path = headers.split_whitespace().nth(1).unwrap().to_owned();
            requests.push((path, headers, serde_json::from_slice(&raw[end..end+len]).unwrap()));
            stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").as_bytes()).await.unwrap();
        }
        requests
        })
    });
    (url, task)
}

fn attributes(resource: &Value) -> BTreeMap<String, String> {
    resource["attributes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|attr| {
            (
                attr["key"].as_str().unwrap().into(),
                attr["value"]["stringValue"].as_str().unwrap().into(),
            )
        })
        .collect()
}

#[test]
fn otlp_http_json_headers_resources_and_parent_log_correlation() {
    let dir = Directory::new();
    let (url, task) = receiver(200);
    dir.run("otlp", &[
        ("OTEL_EXPORTER_OTLP_ENDPOINT", &url),
        ("OTEL_EXPORTER_OTLP_HEADERS", "x-fixture=one=two,x-fixture=last,authorization=fixture-otlp-header"),
        ("YCODING_CLIENT", "web"),
        ("OTEL_RESOURCE_ATTRIBUTES", "service.namespace=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here,ycoding.client=override,service.instance.id=override,service.name=override"),
    ]);
    let requests = task.join().unwrap();
    let logs = &requests.iter().find(|x| x.0 == "/v1/logs").unwrap().2["resourceLogs"][0];
    let traces = &requests.iter().find(|x| x.0 == "/v1/traces").unwrap().2["resourceSpans"][0];
    assert!(requests.iter().all(|x| x.1.contains("x-fixture: last")
        && x.1.contains("authorization: fixture-otlp-header")
        && x.1.contains("content-type: application/json")));
    let attrs = attributes(&logs["resource"]);
    assert_eq!(attrs, attributes(&traces["resource"]));
    for (key, value) in [
        ("service.name", "ycoding"),
        ("service.version", "fixture-version"),
        ("service.namespace", "anomalyco"),
        ("team", "platform,observability"),
        ("label", "hello=world"),
        ("key/name", "value here"),
        ("ycoding.client", "web"),
        ("deployment.environment.name", "next /β"),
    ] {
        assert_eq!(attrs.get(key).map(String::as_str), Some(value));
    }
    assert_eq!(attrs["ycoding.run"], attrs["service.instance.id"]);
    assert_ne!(attrs["ycoding.run"], "override");
    assert!(
        dir.text("ycoding.log")
            .contains(&format!("run={}", attrs["ycoding.run"]))
    );
    let record = &logs["scopeLogs"][0]["logRecords"][0];
    assert_eq!(record["severityNumber"], 9);
    assert_eq!(record["severityText"], "Info");
    assert_eq!(
        record["body"]["arrayValue"]["values"][0]["stringValue"],
        "export me"
    );
    assert_eq!(
        record["body"]["arrayValue"]["values"][1]["stringValue"],
        r#"{"component":"fixture"}"#
    );
    assert_eq!(record["timeUnixNano"], record["observedTimeUnixNano"]);
    let spans = traces["scopeSpans"][0]["spans"].as_array().unwrap();
    assert_eq!(spans.len(), 3);
    let parent = spans.iter().find(|span| span["name"] == "parent").unwrap();
    let child = spans.iter().find(|span| span["name"] == "child").unwrap();
    assert_eq!(child["parentSpanId"], parent["spanId"]);
    assert_eq!(child["traceId"], parent["traceId"]);
    assert_eq!(record["traceId"], child["traceId"]);
    assert_eq!(record["spanId"], child["spanId"]);
    assert_eq!(child["traceId"].as_str().unwrap().len(), 32);
    assert_eq!(child["spanId"].as_str().unwrap().len(), 16);
    assert!(
        child["attributes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field["key"] == "answer" && field["value"]["intValue"] == "43")
    );
    let explicit = spans
        .iter()
        .find(|span| span["name"] == "explicit")
        .unwrap();
    assert_eq!(explicit["parentSpanId"], parent["spanId"]);
    assert_eq!(explicit["links"][0]["spanId"], parent["spanId"]);
}

#[test]
fn invalid_otlp_configuration_and_transport_failure_keep_local_sink() {
    for env in [
        vec![("OTEL_EXPORTER_OTLP_ENDPOINT", "://invalid")],
        vec![("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")],
        vec![
            ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1"),
            ("OTEL_EXPORTER_OTLP_HEADERS", "bad header=value"),
        ],
    ] {
        let dir = Directory::new();
        let output = dir.run("default", &env);
        assert!(output.stderr.is_empty());
        assert!(dir.text("ycoding.log").contains("message=secure"));
    }
    let dir = Directory::new();
    let (url, task) = receiver(503);
    let output = dir.run("otlp", &[("OTEL_EXPORTER_OTLP_ENDPOINT", &url)]);
    assert!(output.stderr.is_empty());
    assert_eq!(task.join().unwrap().len(), 2);
    assert!(dir.text("ycoding.log").contains("export me"));
}

#[test]
fn all_or_nothing_resource_decode_and_redaction_cover_every_sink() {
    for resource in [
        "service.namespace=anomalyco,broken",
        "service.namespace=anomalyco,label=%GG",
        "service.namespace=anomalyco,label=%FF",
    ] {
        let dir = Directory::new();
        let (url, task) = receiver(200);
        dir.run(
            "otlp",
            &[
                ("OTEL_EXPORTER_OTLP_ENDPOINT", &url),
                ("OTEL_RESOURCE_ATTRIBUTES", resource),
            ],
        );
        for (_, _, body) in task.join().unwrap() {
            let resource = body
                .get("resourceLogs")
                .or_else(|| body.get("resourceSpans"))
                .unwrap()[0]["resource"]
                .clone();
            assert!(!attributes(&resource).contains_key("service.namespace"));
            assert_eq!(attributes(&resource)["ycoding.client"], "cli");
        }
    }
    let dir = Directory::new();
    let (url, task) = receiver(200);
    let output = dir.run(
        "redact",
        &[
            ("OTEL_EXPORTER_OTLP_ENDPOINT", &url),
            (
                "OTEL_EXPORTER_OTLP_HEADERS",
                "authorization=fixture-overridden-header,authorization=fixture-otlp-header",
            ),
            ("YCODING_PRINT_LOGS", "1"),
            ("OTEL_RESOURCE_ATTRIBUTES", "auth.token=fixture-resource"),
        ],
    );
    let requests = task.join().unwrap();
    let material = format!(
        "{}{}{}",
        dir.text("ycoding.log"),
        String::from_utf8(output.stderr).unwrap(),
        serde_json::to_string(&requests.iter().map(|x| &x.2).collect::<Vec<_>>()).unwrap()
    );
    for secret in [
        "fixture-auth",
        "fixture-nested",
        "fixture-header",
        "fixture-token",
        "fixture-access-token",
        "fixture-raw-response",
        "fixture-raw",
        "fixture-id",
        "fixture-otlp-header",
        "fixture-overridden-header",
        "fixture-resource",
    ] {
        assert!(!material.contains(secret), "leaked {secret}");
    }
    assert!(material.contains("GET") && material.contains("[REDACTED]"));
}
