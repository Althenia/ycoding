use std::{sync::mpsc, time::Instant};
use ycoding_core::session::{model_history, store::Service};
use ycoding_schema::{DomainEncode, ObjectEncoder, session, session_message};
use ycoding_store::{
    KeyPart,
    session::{
        ContextState, ContextStateTable, Document, Manifest, ManifestTable, Message, MessageTable,
        Revision, RevisionTable, SessionTable,
    },
    tuple_key,
};

#[path = "../tests/session_support/mod.rs"]
mod support;

fn data(index: usize, bytes: usize) -> ycoding_schema::JsonValue {
    ObjectEncoder::new()
        .field("text", format!("{index}:{}", "x".repeat(bytes)).as_str())
        .field(
            "time",
            &ObjectEncoder::new()
                .field("created", &(index as f64))
                .finish(),
        )
        .finish()
}

fn stats(mut samples: Vec<f64>) -> serde_json::Value {
    samples.sort_by(f64::total_cmp);
    serde_json::json!({"median": samples[15], "p95": samples[28], "max": samples[29]})
}

fn rss() -> f64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse::<f64>()
        .unwrap()
        / 1024.0
}

fn main() {
    let args = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with("--"))
        .collect::<Vec<_>>();
    let count = args
        .first()
        .map_or(10000, |arg| arg.parse::<usize>().unwrap());
    let bytes = args
        .get(1)
        .map_or(4096, |arg| arg.parse::<usize>().unwrap());
    assert!((12..=10000).contains(&count));
    assert!((1..=16384).contains(&bytes));
    assert!(count * bytes <= 64 * 1024 * 1024);
    let before_fixture = rss();
    let store = support::store();
    let covered = count - 11;
    store
        .submit(move |tx| {
            for index in 0..count {
                MessageTable::insert(
                    tx,
                    &Message {
                        id: format!("msg_history_pruning_{index}").into(),
                        session_id: "ses_one".into(),
                        type_: "synthetic".into(),
                        seq: index as i64,
                        time_created: index as i64,
                        time_updated: index as i64,
                        data: data(index, bytes),
                    },
                )?;
            }
            let content = ObjectEncoder::new()
                .field(
                    "summary",
                    &ObjectEncoder::new()
                        .field("text", "Earlier history checkpoint")
                        .field(
                            "coveredThrough",
                            &ObjectEncoder::new()
                                .field(
                                    "messageID",
                                    format!("msg_history_pruning_{covered}").as_str(),
                                )
                                .field("seq", &(covered as f64))
                                .finish(),
                        )
                        .field(
                            "digest",
                            &ycoding_core::instructions::hash(&data(covered, bytes)).encode(),
                        )
                        .finish(),
                )
                .finish();
            let ycoding_schema::JsonValue::String(digest) =
                ycoding_core::instructions::hash(&content).encode()
            else {
                unreachable!()
            };
            ManifestTable::insert(
                tx,
                &Manifest {
                    digest: digest.clone(),
                    schema_version: 1,
                    content: Document::new(content)?,
                    input_tokens: 10000,
                    retained_tokens: 100,
                    time_created: 0,
                },
            )?;
            for revision in 0..=1 {
                RevisionTable::insert(
                    tx,
                    &Revision {
                        session_id: "ses_one".into(),
                        revision,
                        parent_revision: (revision == 1).then_some(0),
                        manifest_digest: (revision == 1).then(|| digest.clone()),
                        covered_through_message_id: (revision == 1)
                            .then(|| format!("msg_history_pruning_{covered}").into()),
                        covered_through_seq: (revision == 1).then_some(covered as i64),
                        activation_event_id: (revision == 1).then(|| "evt_history_pruning".into()),
                        activation_sequence: (revision == 1).then_some(count as i64),
                        time_created: 0,
                    },
                )?;
            }
            ContextStateTable::insert(
                tx,
                &ContextState {
                    session_id: "ses_one".into(),
                    status: "active".into(),
                    revision: 1,
                    manifest_digest: Some(digest),
                    covered_through_message_id: Some(
                        format!("msg_history_pruning_{covered}").into(),
                    ),
                    covered_through_seq: Some(covered as i64),
                    activated_event_id: Some("evt_history_pruning".into()),
                    time_activated: Some(0),
                    error_code: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let after_fixture = rss();
    let id = session::Id::new("ses_one").unwrap();
    let service = Service::new(store.client());
    let verify = |entries: &[ycoding_core::session::history::Entry]| {
        assert_eq!(entries.len(), 11);
        assert!(
            matches!(&entries[0].message, session_message::Info::Synthetic(summary) if summary.text.to_utf8().unwrap().contains("Earlier history checkpoint"))
        );
        for (entry, index) in entries[1..].iter().zip(covered + 1..count) {
            assert_eq!(entry.seq, index as i64);
            assert!(
                matches!(&entry.message, session_message::Info::Synthetic(message) if message.id.as_lossless().as_str() == Some(format!("msg_history_pruning_{index}").as_str()) && message.text.as_str() == Some(format!("{index}:{}", "x".repeat(bytes)).as_str()))
            );
        }
    };
    for _ in 0..3 {
        verify(&service.model_history(&id).unwrap());
    }
    let mut duration = Vec::new();
    let mut other_read = Vec::new();
    let mut transient_rss = Vec::new();
    for _ in 0..30 {
        let before = rss();
        let (entered, enter) = mpsc::sync_channel(0);
        let (queued, queue) = mpsc::sync_channel(0);
        let client = store.client();
        let reader = std::thread::spawn(move || {
            enter.recv().unwrap();
            let start = Instant::now();
            queued.send(()).unwrap();
            let row = client
                .snapshot()
                .unwrap()
                .get::<SessionTable>(&tuple_key(&[KeyPart::String(&"ses_two".into())]))
                .unwrap()
                .unwrap();
            assert_eq!(row.id.as_str(), Some("ses_two"));
            start.elapsed().as_secs_f64() * 1000.0
        });
        let start = Instant::now();
        let snapshot = store.snapshot().unwrap();
        entered.send(()).unwrap();
        queue.recv().unwrap();
        let assembled = model_history::select(&snapshot, &id).unwrap();
        duration.push(start.elapsed().as_secs_f64() * 1000.0);
        transient_rss.push(rss() - before);
        verify(&assembled);
        other_read.push(reader.join().unwrap());
    }
    let after_samples = rss();
    store.shutdown().unwrap();
    println!(
        "{}",
        serde_json::json!({
            "environment": {"platform": std::env::consts::OS, "arch": std::env::consts::ARCH},
            "count": count, "bytes": bytes, "warmups": 3, "samples": 30, "modelEntries": 11,
            "beforeFixtureRssMiB": before_fixture, "afterFixtureRssMiB": after_fixture, "afterSamplesRssMiB": after_samples, "afterScopeRssMiB": rss(),
            "assemblyMs": stats(duration), "otherReadMs": stats(other_read), "sampledTransientRssMiB": stats(transient_rss),
            "heapMiB": null,
            "boundary": "disposable file-backed redb; concurrent independent Session lookup, not SQLite SELECT 1; no allocator telemetry or forced GC"
        })
    );
}
