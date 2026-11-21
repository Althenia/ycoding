pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::{sync::Arc, time::Duration};
use ycoding_core::platform::{
    filesystem::{Location, fuzzy},
    process::{self, Command},
};

fn corpus() -> serde_json::Value {
    serde_json::from_str(include_str!("platform-parity.json")).unwrap()
}

#[test]
fn listing_matches_committed_ts_bun_default_collation() {
    let fixture = Fixture::new();
    let corpus = corpus();
    for name in corpus["listing"]["names"].as_array().unwrap() {
        fixture.write(name.as_str().unwrap(), "");
    }
    let actual: Vec<_> = Location::new(&fixture.0)
        .unwrap()
        .list(None)
        .unwrap()
        .into_iter()
        .map(|entry| entry.path.into_lossless().to_utf8().unwrap())
        .collect();
    let expected: Vec<_> = corpus["listing"]["expected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap().to_string())
        .collect();
    assert_eq!(actual, expected);
}

#[test]
fn fuzzy_queries_use_ecmascript_trim_not_unicode_white_space() {
    for case in corpus()["trim"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let expected = case["expected"].as_str().unwrap();
        assert_eq!(
            ycoding_core::platform::filesystem::trim(input),
            expected,
            "{input:?}"
        );
        let expected: Vec<_> = case["fuzzy"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            fuzzy::find(input, &["needle".into()], 50),
            expected,
            "{input:?}"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn process_running_tracks_exit_without_waiting_for_output_drain() {
    let mut child = process::spawn(Command::new(
        "/bin/sh",
        ["-c", "read value; printf '%s' \"$value\""],
    ))
    .await
    .unwrap();
    let mut output = child.take_output().unwrap();
    assert!(child.is_running());
    child.write(b"done\n".to_vec()).await.unwrap();
    assert_eq!(output.recv().await.unwrap().bytes, b"done");
    child.wait().await.unwrap();
    assert!(!child.is_running());
    assert!(!child.control().is_running());
}

#[cfg(unix)]
#[tokio::test]
async fn graceful_shutdown_without_escalation_returns_while_term_resistant_child_lives() {
    let mut child = process::spawn(Command::new(
        "/bin/sh",
        [
            "-c",
            "trap '' TERM; printf READY; read value; printf EOF; exec tail -f /dev/null",
        ],
    ))
    .await
    .unwrap();
    let mut output = child.take_output().unwrap();
    assert_eq!(output.recv().await.unwrap().bytes, b"READY");
    let started = tokio::time::Instant::now();
    assert!(
        child
            .shutdown_gracefully(Duration::from_millis(100))
            .await
            .unwrap()
            .is_none()
    );
    assert!(started.elapsed() < Duration::from_millis(400));
    assert!(child.is_running());
    assert_eq!(output.recv().await.unwrap().bytes, b"EOF");
    child
        .kill(process::KillOptions {
            signal: process::KillSignal::Kill,
            force_kill_after: None,
        })
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn exited_root_can_be_released_while_descendant_holds_output_open() {
    let mut child = process::spawn(Command::new(
        "/bin/sh",
        ["-c", "sleep 30 & printf READY; exit 0"],
    ))
    .await
    .unwrap();
    let pid = child.pid();
    let control = child.control();
    let mut output = child.take_output().unwrap();
    assert_eq!(output.recv().await.unwrap().bytes, b"READY");
    tokio::time::timeout(Duration::from_secs(2), async {
        while control.is_running() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        child
            .shutdown_gracefully(Duration::from_millis(20))
            .await
            .unwrap()
            .is_none()
    );
    let released = tokio::time::timeout(Duration::from_millis(200), child.release()).await;
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    tokio::time::timeout(Duration::from_secs(2), async {
        while output.recv().await.is_some() {}
    })
    .await
    .unwrap();
    released.unwrap().unwrap();
}

#[tokio::test]
async fn code_mode_default_collation_matches_bun_pairs_including_canonical_equivalence() {
    use ycoding_core::tools::code_mode::{
        Cancellation, ExecutionLimits, Runtime, ToolDescription, ToolFailure, ToolFuture, ToolHost,
        regexp::NativeRegExpEngine,
    };
    use ycoding_schema::{JsonValue, LosslessString};
    struct Host;
    impl ToolHost for Host {
        fn catalog(&self) -> Vec<ToolDescription> {
            vec![]
        }
        fn decode_input(
            &self,
            _: &LosslessString,
            input: Option<JsonValue>,
        ) -> Result<Option<JsonValue>, ToolFailure> {
            Ok(input)
        }
        fn invoke(
            &self,
            _: LosslessString,
            _: Option<JsonValue>,
            _: Cancellation,
        ) -> ToolFuture<'_> {
            Box::pin(async { Err(ToolFailure::Internal) })
        }
        fn decode_output(
            &self,
            _: &LosslessString,
            output: Option<JsonValue>,
        ) -> Result<Option<JsonValue>, ToolFailure> {
            Ok(output)
        }
    }
    let corpus = corpus();
    let runtime = Runtime::with_default_collation(
        Arc::new(Host),
        ExecutionLimits::default(),
        Arc::new(NativeRegExpEngine),
    )
    .unwrap();
    let code = format!(
        "return {}.map(p => Math.sign(p.a.localeCompare(p.b)))",
        corpus["comparisons"]
    );
    let actual = runtime
        .execute(code, Cancellation::default())
        .await
        .value
        .unwrap();
    let expected = serde_json::Value::Array(
        corpus["comparisons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|case| case["result"].clone())
            .collect(),
    );
    assert_eq!(
        actual,
        ycoding_schema::parse_json(&expected.to_string()).unwrap()
    );
}
