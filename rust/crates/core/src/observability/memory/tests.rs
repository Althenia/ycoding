use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

fn sample(timestamp_ms: Option<u64>, rss: Reading, peak_rss: Reading) -> Value {
    RuntimeSample {
        timestamp_ms,
        rss,
        resources: ResourceSummary {
            peak_rss,
            minor_faults: Reading::Unsupported,
            major_faults: Reading::Unsupported,
        },
    }
    .value()
}

#[test]
fn disabled_sampling_creates_no_worker_and_does_not_collect_or_wait() {
    let mut sampler = start_with(
        false,
        || panic!("disabled collector called"),
        |_, _| panic!("disabled emitter called"),
        |_, _| panic!("disabled timer called"),
    )
    .unwrap();
    assert!(sampler.worker.is_none());
    assert!(sampler.stop.is_none());
    sampler.close().unwrap();
}

#[test]
fn debug_filter_is_exact_and_uses_the_existing_log_level_parser() {
    for level in [Some("DEBUG"), Some("debug")] {
        assert_eq!(super::super::config::minimum(level), tracing::Level::DEBUG);
    }
    for level in [
        None,
        Some("INFO"),
        Some("WARN"),
        Some("ERROR"),
        Some("TRACE"),
    ] {
        assert_ne!(super::super::config::minimum(level), tracing::Level::DEBUG);
    }
}

#[test]
fn first_sample_is_immediate_then_119_thirty_second_waits_end_the_run() {
    let clock = Arc::new(AtomicU64::new(0));
    let reads = Arc::new(AtomicUsize::new(0));
    let source_clock = clock.clone();
    let source_reads = reads.clone();
    let timer_clock = clock.clone();
    let (sent, received) = mpsc::channel();
    let mut sampler = start_with(
        true,
        move || {
            source_reads.fetch_add(1, Ordering::SeqCst);
            sample(
                Some(source_clock.load(Ordering::SeqCst)),
                Reading::Available(500),
                Reading::Available(900),
            )
        },
        move |sequence, value| sent.send((sequence, value)).unwrap(),
        move |_, interval| {
            assert_eq!(interval, Duration::from_secs(30));
            timer_clock.fetch_add(interval.as_millis() as u64, Ordering::SeqCst);
            true
        },
    )
    .unwrap();
    for sequence in 1..=120 {
        let (actual, value) = received.recv().unwrap();
        assert_eq!(actual, sequence);
        assert_eq!(
            value["timestampMs"],
            json!(u64::from(sequence - 1) * 30_000)
        );
        assert_eq!(value["rss"]["value"], json!(500));
    }
    sampler.close().unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 120);
    assert_eq!(clock.load(Ordering::SeqCst), 3_570_000);
    assert!(matches!(
        received.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
}

#[test]
fn scope_close_and_drop_cancel_and_join_before_another_collection() {
    for explicit_close in [true, false] {
        let reads = Arc::new(AtomicUsize::new(0));
        let source_reads = reads.clone();
        let (waiting, entered) = mpsc::sync_channel(1);
        let mut sampler = start_with(
            true,
            move || {
                source_reads.fetch_add(1, Ordering::SeqCst);
                sample(Some(0), Reading::Unsupported, Reading::Unsupported)
            },
            |_, _| {},
            move |stopped, interval| {
                waiting.send(()).unwrap();
                wait(stopped, interval)
            },
        )
        .unwrap();
        entered.recv().unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        if explicit_close {
            sampler.close().unwrap();
            sampler.close().unwrap();
        }
        drop(sampler);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert!(matches!(
            entered.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
    }
}

#[test]
fn byte_conversion_and_linux_fields_reject_missing_invalid_and_unreported_readings() {
    assert_eq!(bytes(2, 1), Reading::Available(2));
    assert_eq!(bytes(2, 1024), Reading::Available(2048));
    assert_eq!(bytes(0, 1024), Reading::Unavailable("not-reported"));
    assert_eq!(bytes(u64::MAX, 1024), Reading::Error("invalid-reading"));
    assert_eq!(
        proc_rss("Name: unrelated\nVmRSS:\t42 kB\nVmHWM:\t100 kB\n"),
        Reading::Available(43_008)
    );
    assert_eq!(
        proc_rss("VmHWM: 100 kB\n"),
        Reading::Unavailable("no-reading")
    );
    assert_eq!(
        proc_rss("VmRSS: 0 kB\n"),
        Reading::Unavailable("not-reported")
    );
    for invalid in [
        "VmRSS: -1 kB",
        "VmRSS: 1.5 kB",
        "VmRSS: 5 bytes",
        "VmRSS: 2 kB extra",
        "VmRSS: 18446744073709551615 kB",
    ] {
        assert_eq!(proc_rss(invalid), Reading::Error("invalid-reading"));
    }
}

#[test]
fn metrics_keep_bytes_sources_basis_and_unavailable_values_explicit() {
    assert_eq!(
        metric(Reading::Available(1024), "fixture", "current", "bytes"),
        json!({
            "value": 1024, "status": "available", "source": "fixture", "basis": "current", "unit": "bytes",
        })
    );
    for (reading, status, reason) in [
        (Reading::Unsupported, "unsupported", "api-unavailable"),
        (
            Reading::Unavailable("no-reading"),
            "unavailable",
            "no-reading",
        ),
        (Reading::Error("read-failed"), "error", "read-failed"),
    ] {
        assert_eq!(
            metric(reading, "fixture", "current", "bytes"),
            json!({
                "status": status, "reason": reason, "source": "fixture", "basis": "current", "unit": "bytes",
            })
        );
    }
    let value = sample(None, Reading::Unsupported, Reading::Unsupported);
    assert_eq!(value["timestampMs"], Value::Null);
    assert_eq!(value["timestampStatus"], "unavailable");
    assert_eq!(value["runtime"]["name"], "rust");
    assert_eq!(value["runtime"]["version"], "unknown");
    assert_eq!(value["rss"]["basis"], "current");
    assert_eq!(value["peakRss"]["basis"], "process-lifetime-peak");
    assert_eq!(
        value["rss"]["source"],
        if cfg!(target_os = "linux") {
            "/proc/self/status:VmRSS"
        } else {
            "none"
        }
    );
    assert_eq!(
        value["peakRss"]["source"],
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            "getrusage(RUSAGE_SELF).ru_maxrss"
        } else {
            "none"
        }
    );
    for field in ["current", "peak"] {
        assert_eq!(value["commit"][field]["status"], "unsupported");
        assert!(value["commit"][field].get("value").is_none());
    }
    for field in ["minor", "major"] {
        assert_eq!(value["pageFaults"][field]["status"], "unsupported");
        assert!(value["pageFaults"][field].get("value").is_none());
    }
    for field in ["size", "capacity", "external"] {
        assert_eq!(value["heap"][field]["status"], "unsupported");
        assert!(value["heap"][field].get("value").is_none());
    }
    for field in ["nativeAllocations", "allocatorRetained"] {
        assert_eq!(value[field]["status"], "unavailable");
        assert_eq!(value[field]["reason"], "not-measured");
        assert!(value[field].get("value").is_none());
    }
}

#[test]
fn collector_emits_only_aggregate_metrics_into_existing_tracing() {
    use super::super::{Command, Shared, format, layer};
    use std::{collections::BTreeMap, sync::Mutex};
    use tracing_subscriber::layer::SubscriberExt;

    let (sent, received) = mpsc::sync_channel(8);
    let shared = Arc::new(Shared {
        sender: Mutex::new(Some(sent)),
        minimum: tracing::Level::DEBUG,
        redactor: format::Redactor::new(&BTreeMap::new()),
    });
    let subscriber = tracing_subscriber::registry().with(layer::Diagnostics { shared });
    tracing::subscriber::with_default(subscriber, || {
        let mut sampler = start_with(
            true,
            || sample(Some(1234), Reading::Available(500), Reading::Available(900)),
            emit,
            |stopped, _| {
                let _ = stopped.recv();
                false
            },
        )
        .unwrap();
        sampler.close().unwrap();
    });
    let Command::Log(record) = received.recv().unwrap() else {
        panic!("expected a diagnostic log record");
    };
    assert_eq!(record.level, tracing::Level::DEBUG);
    assert_eq!(record.message, json!("memory sample"));
    assert!(record.spans.is_empty());
    assert!(record.annotations.is_empty());
    assert!(record.trace.is_none());
    let fields = record.fields.into_iter().collect::<BTreeMap<_, _>>();
    assert_eq!(fields.len(), 4);
    assert_eq!(fields["component"], json!("memory"));
    assert_eq!(fields["role"], json!("server"));
    assert_eq!(fields["sequence"], json!(1));
    let value = &fields["sample"];
    assert_eq!(value["timestampMs"], json!(1234));
    assert_eq!(value["rss"]["value"], json!(500));
    assert_eq!(value["peakRss"]["value"], json!(900));
    let mut keys = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "allocatorRetained",
            "commit",
            "heap",
            "nativeAllocations",
            "pageFaults",
            "peakRss",
            "rss",
            "runtime",
            "timestampMs",
            "timestampStatus"
        ]
    );
    assert!(value.get("payload").is_none());
    assert!(matches!(
        received.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
}

#[test]
fn resource_summaries_keep_counts_separate_and_isolate_invalid_or_failed_readings() {
    let resources = ResourceSummary::from_raw(2, 17, 0);
    let value = RuntimeSample {
        timestamp_ms: Some(7),
        rss: Reading::Available(500),
        resources,
    }
    .value();
    assert_eq!(
        value["peakRss"]["value"],
        json!(if cfg!(target_os = "macos") { 2 } else { 2048 })
    );
    assert_eq!(
        value["pageFaults"]["minor"],
        metric(
            Reading::Available(17),
            if cfg!(any(target_os = "linux", target_os = "macos")) {
                "getrusage(RUSAGE_SELF).ru_minflt"
            } else {
                "none"
            },
            "process-lifetime-counter",
            "count"
        )
    );
    assert_eq!(value["pageFaults"]["major"]["value"], json!(0));
    assert_eq!(value["pageFaults"]["major"]["unit"], "count");
    let value = RuntimeSample {
        timestamp_ms: Some(8),
        rss: Reading::Error("read-failed"),
        resources: ResourceSummary::from_raw(0, -1, 0),
    }
    .value();
    assert_eq!(value["rss"]["status"], "error");
    assert_eq!(value["peakRss"]["reason"], "not-reported");
    assert_eq!(value["pageFaults"]["minor"]["status"], "error");
    assert_eq!(value["pageFaults"]["minor"]["reason"], "invalid-reading");
    assert!(value["pageFaults"]["minor"].get("value").is_none());
    assert_eq!(value["pageFaults"]["major"]["value"], json!(0));
    for (reading, status, reason) in [
        (Reading::Error("read-failed"), "error", "read-failed"),
        (
            Reading::Unavailable("no-reading"),
            "unavailable",
            "no-reading",
        ),
        (Reading::Unsupported, "unsupported", "api-unavailable"),
    ] {
        let value = RuntimeSample {
            timestamp_ms: None,
            rss: Reading::Available(500),
            resources: ResourceSummary::unavailable(reading),
        }
        .value();
        assert_eq!(value["rss"]["value"], json!(500));
        for metric in [
            &value["peakRss"],
            &value["pageFaults"]["minor"],
            &value["pageFaults"]["major"],
        ] {
            assert_eq!(metric["status"], status);
            assert_eq!(metric["reason"], reason);
            assert!(metric.get("value").is_none());
        }
        assert_eq!(value["commit"]["current"]["status"], "unsupported");
    }
    assert_eq!(
        counter(std::ffi::c_long::MAX),
        Reading::Available(std::ffi::c_long::MAX as u64)
    );
    assert_eq!(counter(-1), Reading::Error("invalid-reading"));
}

#[test]
fn periodic_summaries_keep_info_thresholds_activity_counts_and_read_failure_recovery() {
    use super::super::{Command, Shared, format, layer};
    use std::{collections::BTreeMap, sync::Mutex};
    use tracing_subscriber::layer::SubscriberExt;

    let (sent, received) = mpsc::sync_channel(16);
    let shared = Arc::new(Shared {
        sender: Mutex::new(Some(sent)),
        minimum: tracing::Level::DEBUG,
        redactor: format::Redactor::new(&BTreeMap::new()),
    });
    let subscriber = tracing_subscriber::registry().with(layer::Diagnostics { shared });
    let mib = 1024 * 1024;
    tracing::subscriber::with_default(subscriber, || {
        let mut telemetry = Telemetry::default();
        for (index, rss) in [256, 255, 192, 255, 256, 257, 257].into_iter().enumerate() {
            telemetry.record(
                (1, 1, 1),
                2,
                RuntimeSample {
                    timestamp_ms: Some(index as u64 * 60_000),
                    rss: Reading::Available(rss * mib),
                    resources: ResourceSummary::from_raw(300, 19, 0),
                },
            );
        }
        telemetry.record(
            (0, 0, 0),
            0,
            RuntimeSample {
                timestamp_ms: Some(420_000),
                rss: Reading::Error("read-failed"),
                resources: ResourceSummary::from_raw(300, 20, 0),
            },
        );
        telemetry.record(
            (0, 0, 0),
            0,
            RuntimeSample {
                timestamp_ms: Some(480_000),
                rss: Reading::Available(257 * mib),
                resources: ResourceSummary::unavailable(Reading::Error("read-failed")),
            },
        );
    });
    let records = received
        .try_iter()
        .map(|command| match command {
            Command::Log(record) => record,
            _ => panic!("expected a memory log"),
        })
        .collect::<Vec<_>>();
    assert_eq!(
        records
            .iter()
            .map(|record| record.level)
            .collect::<Vec<_>>(),
        vec![
            tracing::Level::INFO,
            tracing::Level::DEBUG,
            tracing::Level::INFO,
            tracing::Level::DEBUG,
            tracing::Level::INFO,
            tracing::Level::INFO,
            tracing::Level::DEBUG,
            tracing::Level::DEBUG,
            tracing::Level::DEBUG,
        ]
    );
    for (index, record) in records.into_iter().enumerate() {
        assert_eq!(record.message, json!("runtime memory telemetry"));
        let fields = record.fields.into_iter().collect::<BTreeMap<_, _>>();
        assert_eq!(fields["timestamp_ms"], json!(index as u64 * 60_000));
        assert_eq!(
            fields["runtime_memory"]["timestampMs"],
            fields["timestamp_ms"]
        );
        assert_eq!(
            fields["active_generations"],
            json!(if index < 7 { 2 } else { 0 })
        );
        assert_eq!(
            fields["loaded_locations"],
            json!(if index < 7 { 2 } else { 0 })
        );
        assert_eq!(
            fields["runtime_memory"]["commit"]["current"]["status"],
            "unsupported"
        );
        if index == 7 {
            assert_eq!(fields["runtime_memory"]["rss"]["reason"], "read-failed");
            assert_eq!(
                fields["runtime_memory"]["pageFaults"]["minor"]["value"],
                json!(20)
            );
        } else if index == 8 {
            assert_eq!(fields["runtime_memory"]["rss"]["status"], "available");
            assert_eq!(
                fields["runtime_memory"]["pageFaults"]["minor"]["reason"],
                "read-failed"
            );
        }
        assert!(!fields.contains_key("session"));
        assert!(!fields.contains_key("model"));
        assert!(!fields.contains_key("payload"));
    }
}

#[test]
fn linux_rss_read_keeps_the_self_status_byte_cap() {
    let source = include_str!("../memory.rs");
    assert!(source.contains("std::fs::File::open(\"/proc/self/status\")"));
    assert!(source.contains("file.take(65_537)"));
    assert!(source.contains("contents.len() > 65_536"));
}
