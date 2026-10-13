use serde_json::{Value, json};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{Notify, Semaphore};
use ycoding_core::meeting::BoxFuture;
use ycoding_core::meeting::config::KnowledgeBinding;
use ycoding_core::meeting::intelligence::{
    Generate, Intelligence, Mcp, McpResult, McpTool, Settings, assemble_context, parse_extraction,
    plan_prompt,
};
use ycoding_core::meeting::store::{MeetingDatabase, now};

static NEXT: AtomicU64 = AtomicU64::new(0);

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(25), work)
        .await
        .expect("intelligence test exceeded 25 seconds")
}

fn segment(id: &str, sequence: i64, text: &str) -> Value {
    json!({
        "id": id, "meetingID": "meeting", "sequence": sequence, "source": "remote",
        "speakerID": "remote-unknown", "startMs": sequence * 1000, "endMs": sequence * 1000 + 900,
        "rawText": text, "text": text, "state": "final", "model": "test-model",
        "createdAt": "2026-10-12T00:00:00.000Z",
    })
}

fn extraction(summary: &str, findings: Vec<Value>, proposals: Vec<Value>) -> String {
    json!({ "summary": summary, "findings": findings, "proposals": proposals }).to_string()
}

fn finding(overrides: Value) -> Value {
    let mut base = json!({
        "kind": "proposal", "summary": "Consider refactoring authentication",
        "sourceSegmentIds": ["seg-1"], "confidence": 0.8,
    });
    for (key, value) in overrides.as_object().unwrap() {
        base[key] = value.clone();
    }
    base
}

fn thai() -> Value {
    segment("seg-1", 1, "เราควร refactor authentication service")
}

fn parse(text: &str) -> Result<Value, String> {
    parse_extraction(text, &[thai()], &[], "meeting").map(|result| json!(result.findings))
}

#[test]
fn accepts_one_complete_json_fence_without_weakening_evidence_or_approval_validation() {
    let body = extraction("Discussed authentication", vec![finding(json!({}))], vec![]);
    let fenced = parse(&format!("```json\n{body}\n```")).unwrap();
    assert_eq!(fenced[0]["kind"], "proposal");
    assert_eq!(fenced[0]["status"], "unconfirmed");
    assert_eq!(fenced[0]["sourceSegmentIds"], json!(["seg-1"]));
    assert!(parse(&format!("```\n{body}\n```")).is_ok());
    assert!(parse(&format!("prose\n```json\n{body}\n```")).is_err());
    assert!(parse(&format!("```json\n{body}\n```\n```json\n{body}\n```")).is_err());
    let confirmed = extraction(
        "Discussed",
        vec![finding(json!({ "status": "confirmed" }))],
        vec![],
    );
    assert!(parse(&format!("```json\n{confirmed}\n```")).is_err());
    assert!(parse(&"x".repeat(100_001)).is_err());
}

#[test]
fn rejects_unknown_or_missing_evidence_and_invented_people() {
    let build = |overrides: Value| extraction("S", vec![finding(overrides)], vec![]);
    for rejected in [
        json!({ "sourceSegmentIds": ["invented"] }),
        json!({ "sourceSegmentIds": [] }),
        json!({ "status": "confirmed" }),
        json!({ "speakerId": "Alice" }),
        json!({ "owner": "Alice" }),
        json!({ "deadline": "Friday" }),
        json!({ "confidence": 2 }),
        json!({ "kind": "invented" }),
        json!({ "summary": "" }),
    ] {
        assert!(parse(&build(rejected.clone())).is_err(), "{rejected}");
    }
    let supported = parse(&build(
        json!({ "speakerId": "remote-unknown", "owner": "authentication" }),
    ))
    .unwrap();
    assert_eq!(supported[0]["owner"], "authentication");
    assert!(parse(&build(json!({}))).unwrap()[0].get("owner").is_none());
    let draft = Value::Object(Default::default());
    assert!(parse(&draft.to_string()).is_err());
    let mut temporary = thai();
    temporary["state"] = json!("temporary");
    assert!(
        parse_extraction(&build(json!({})), &[temporary], &[], "meeting").is_err(),
        "temporary evidence cannot support a finding"
    );
}

#[test]
fn finding_identity_is_stable_and_proposals_require_canonical_read_evidence() {
    let body = extraction("S", vec![finding(json!({}))], vec![]);
    assert_eq!(
        parse(&body).unwrap()[0]["id"],
        parse(&body).unwrap()[0]["id"]
    );
    let respaced = extraction(
        "S",
        vec![finding(
            json!({ "summary": "Consider   refactoring\nauthentication" }),
        )],
        vec![],
    );
    assert_eq!(
        parse(&body).unwrap()[0]["id"],
        parse(&respaced).unwrap()[0]["id"]
    );
    let proposal = json!({
        "server": "kb", "target": "invented", "suggestedContent": "overwrite",
        "explanation": "heard", "sourceSegmentIds": ["seg-1"], "confidence": 1,
    });
    let invented = extraction("S", vec![], vec![proposal.clone()]);
    assert!(parse_extraction(&invented, &[thai()], &[], "meeting").is_err());
    let reference = json!({
        "server": "kb", "target": "invented", "revision": "r1", "content": "old", "retrievedAt": now(),
    });
    let result = parse_extraction(&invented, &[thai()], &[reference], "meeting").unwrap();
    assert_eq!(result.proposals[0]["expectedRevision"], "r1");
    assert_eq!(result.proposals[0]["existingContent"], "old");
    assert_eq!(result.proposals[0]["status"], "pending");
    assert_eq!(result.proposals[0]["operation"], "replace");
}

#[test]
fn context_is_bounded_without_splitting_or_reinterpreting_transcript_evidence() {
    let inputs = (0..80)
        .map(|index| segment(&format!("seg-{index}"), index + 1, &"ก".repeat(500)))
        .collect::<Vec<_>>();
    let context = assemble_context(&inputs, "checkpoint", &[], 4000).unwrap();
    assert!(context.prompt.encode_utf16().count() <= 4000);
    assert!(!context.segments.is_empty() && context.segments.len() < 80);
    assert!(context.prompt.contains("untrusted"));
    assert_eq!(context.segments[0]["id"], "seg-0");
    assert!(assemble_context(&inputs, "checkpoint", &[], 100).is_err());
    let oversized = [segment("big", 1, &"ก".repeat(5000))];
    assert!(assemble_context(&oversized, "", &[], 4000).is_err());
}

#[test]
fn plans_only_confirmed_decisions_and_states_the_source_code_boundary() {
    let proposed = json!({ "id": "f", "kind": "proposal", "status": "unconfirmed" });
    let error = plan_prompt(&[proposed], &[], "").unwrap_err();
    assert!(error.contains("confirmed"));
    let confirmed = json!({ "id": "f", "kind": "decision", "status": "confirmed" });
    let prompt = plan_prompt(&[confirmed], &[], "").unwrap();
    assert!(prompt.contains("acceptance criteria"));
    assert!(prompt.contains("Do not modify source code"));
    assert!(prompt.contains("uninspected"));
}

struct Directory {
    path: PathBuf,
    database: MeetingDatabase,
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

async fn directory() -> Directory {
    let path = std::env::temp_dir().join(format!(
        "ycoding-meeting-intelligence-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    let database = MeetingDatabase::open(&path.join("meetings.redb")).unwrap();
    database
        .create_meeting("meeting", "Meeting", "analysis-session")
        .await
        .unwrap();
    Directory { path, database }
}

fn generator<F, Fut>(run: F) -> Generate
where
    F: Fn(String, String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<String, String>> + Send + 'static,
{
    Arc::new(move |session, prompt| Box::pin(run(session, prompt)))
}

fn settings(bindings: Vec<KnowledgeBinding>) -> Settings {
    Settings {
        bindings,
        max_characters: 32_000,
        retrieval_ttl: Duration::from_secs(300),
    }
}

fn analyzer(directory: &Directory, generate: Generate) -> Arc<Intelligence> {
    Intelligence::new(
        directory.database.clone(),
        Some(generate),
        None,
        settings(vec![]),
    )
}

#[tokio::test]
async fn changed_owner_or_deadline_requires_fresh_human_confirmation() {
    for (field, before, after) in [("owner", "Bob", "Alice"), ("deadline", "Monday", "Friday")] {
        bounded(async {
            let directory = directory().await;
            let current = Arc::new(Mutex::new(
                json!({ "sourceSegmentIds": ["first"], field: before }),
            ));
            let intelligence = analyzer(&directory, {
                let current = current.clone();
                generator(move |_, _| {
                    let current = current.lock().unwrap().clone();
                    async move {
                        let mut item = json!({
                            "kind": "decision", "summary": "Delivery assignment", "confidence": 1,
                        });
                        for (key, value) in current.as_object().unwrap() {
                            item[key] = value.clone();
                        }
                        Ok(extraction("Delivery", vec![item], vec![]))
                    }
                })
            });
            let database = &directory.database;
            database
                .put_segment(&segment(
                    "first",
                    1,
                    &format!("Delivery assignment {before}"),
                ))
                .await
                .unwrap();
            intelligence
                .analyze("meeting", false, false)
                .wait()
                .await
                .unwrap();
            let original = database.findings("meeting").unwrap().remove(0);
            let mut confirmed = original.clone();
            confirmed["status"] = json!("confirmed");
            database.put_finding(&confirmed).await.unwrap();
            database
                .put_approval(&json!({
                    "id": "confirmation", "meetingID": "meeting", "targetID": original["id"],
                    "decision": "approve", "detail": before, "createdAt": now(),
                }))
                .await
                .unwrap();
            database
                .put_segment(&segment(
                    "second",
                    2,
                    &format!("Delivery assignment {after}"),
                ))
                .await
                .unwrap();
            *current.lock().unwrap() = json!({ "sourceSegmentIds": ["second"], field: after });
            intelligence
                .analyze("meeting", false, false)
                .wait()
                .await
                .unwrap();
            let findings = database.findings("meeting").unwrap();
            let changed = findings.iter().find(|item| item[field] == after).unwrap();
            assert_eq!(changed["status"], "unconfirmed");
            let approvals = database.approvals("meeting").unwrap();
            assert_eq!(approvals.len(), 1);
            assert_eq!(
                (
                    approvals[0]["targetID"].clone(),
                    approvals[0]["detail"].clone()
                ),
                (original["id"].clone(), json!(before))
            );
            database.close().await.unwrap();
        })
        .await;
    }
}

#[tokio::test]
async fn a_coalesced_incremental_request_consumes_evidence_finalized_during_generation() {
    bounded(async {
        let directory = directory().await;
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let first = Arc::new(AtomicBool::new(true));
        let intelligence = analyzer(
            &directory,
            generator({
                let (entered, release, first) = (entered.clone(), release.clone(), first.clone());
                move |_, _| {
                    let (entered, release, first) =
                        (entered.clone(), release.clone(), first.clone());
                    async move {
                        if first.swap(false, Ordering::SeqCst) {
                            entered.notify_one();
                            release.acquire().await.unwrap().forget();
                            return Ok(extraction("First statement", vec![], vec![]));
                        }
                        Ok(extraction(
                            "First statement and second statement",
                            vec![],
                            vec![],
                        ))
                    }
                }
            }),
        );
        let database = &directory.database;
        database
            .put_segment(&segment("first", 1, "First statement"))
            .await
            .unwrap();
        let initial = intelligence.analyze("meeting", false, false);
        entered.notified().await;
        database
            .put_segment(&segment("second", 2, "Second statement"))
            .await
            .unwrap();
        let joined = intelligence.analyze("meeting", false, false);
        release.add_permits(8);
        initial.wait().await.unwrap();
        joined.wait().await.unwrap();
        let checkpoint = database.checkpoints("meeting").unwrap().pop().unwrap();
        assert_eq!(checkpoint["throughSequence"], 2);
        assert!(
            checkpoint["summary"]
                .as_str()
                .unwrap()
                .contains("second statement")
        );
        assert!(!intelligence.busy("meeting"));
        assert_eq!(intelligence.state("meeting")["status"], "idle");
        database.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn concurrent_final_requests_keep_one_generation_owner_and_settle_all_final_evidence() {
    bounded(async {
        let directory = directory().await;
        let initial_entered = Arc::new(Notify::new());
        let initial_release = Arc::new(Semaphore::new(0));
        let final_entered = Arc::new(Notify::new());
        let final_release = Arc::new(Semaphore::new(0));
        let calls = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let intelligence = analyzer(
            &directory,
            generator({
                let (ie, ir, fe, fr) = (
                    initial_entered.clone(),
                    initial_release.clone(),
                    final_entered.clone(),
                    final_release.clone(),
                );
                let (calls, active, maximum) = (calls.clone(), active.clone(), maximum.clone());
                move |_, _| {
                    let (ie, ir, fe, fr) = (ie.clone(), ir.clone(), fe.clone(), fr.clone());
                    let (calls, active, maximum) = (calls.clone(), active.clone(), maximum.clone());
                    async move {
                        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(now, Ordering::SeqCst);
                        let summary = if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            ie.notify_one();
                            ir.acquire().await.unwrap().forget();
                            "First statement"
                        } else {
                            fe.notify_one();
                            fr.acquire().await.unwrap().forget();
                            "Both statements"
                        };
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(extraction(summary, vec![], vec![]))
                    }
                }
            }),
        );
        let database = &directory.database;
        database
            .put_segment(&segment("first", 1, "First statement"))
            .await
            .unwrap();
        let pending = vec![intelligence.analyze("meeting", false, false)];
        initial_entered.notified().await;
        database
            .put_segment(&segment("second", 2, "Second statement"))
            .await
            .unwrap();
        let mut pending = pending;
        pending.push(intelligence.analyze("meeting", true, false));
        pending.push(intelligence.analyze("meeting", true, false));
        initial_release.add_permits(8);
        final_entered.notified().await;
        final_release.add_permits(8);
        for analysis in pending {
            analysis.wait().await.unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
        let checkpoint = database.checkpoints("meeting").unwrap().pop().unwrap();
        assert_eq!(
            (
                checkpoint["throughSequence"].clone(),
                checkpoint["final"].clone()
            ),
            (json!(2), json!(true))
        );
        database.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn a_final_request_without_any_speech_records_an_explicit_empty_checkpoint() {
    bounded(async {
        let directory = directory().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let intelligence = analyzer(
            &directory,
            generator({
                let calls = calls.clone();
                move |_, _| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    async { Ok(extraction("unused", vec![], vec![])) }
                }
            }),
        );
        intelligence
            .analyze("meeting", false, false)
            .wait()
            .await
            .unwrap();
        assert!(
            directory
                .database
                .checkpoints("meeting")
                .unwrap()
                .is_empty()
        );
        intelligence
            .analyze("meeting", true, false)
            .wait()
            .await
            .unwrap();
        let checkpoint = directory.database.checkpoints("meeting").unwrap().remove(0);
        assert_eq!(checkpoint["summary"], "No finalized speech was recorded.");
        assert_eq!(
            (
                checkpoint["final"].clone(),
                checkpoint["throughSequence"].clone()
            ),
            (json!(true), json!(0))
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        directory.database.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn failed_analysis_retains_evidence_records_a_failed_job_and_an_error_state() {
    bounded(async {
        let directory = directory().await;
        let failing = Arc::new(AtomicBool::new(true));
        let intelligence = analyzer(
            &directory,
            generator({
                let failing = failing.clone();
                move |_, _| {
                    let failing = failing.clone();
                    async move {
                        if failing.load(Ordering::SeqCst) {
                            return Err("provider unavailable".into());
                        }
                        Ok(extraction("Recovered", vec![], vec![]))
                    }
                }
            }),
        );
        let database = &directory.database;
        database
            .put_segment(&segment("first", 1, "First statement"))
            .await
            .unwrap();
        let error = intelligence
            .analyze("meeting", false, false)
            .wait()
            .await
            .unwrap_err();
        assert_eq!(error, "provider unavailable");
        let job = database.jobs("meeting").unwrap().remove(0);
        assert_eq!(
            (job["status"].clone(), job["attempts"].clone()),
            (json!("failed"), json!(1))
        );
        assert_eq!(
            job["error"],
            "Analysis failed; finalized evidence is retained. Retry summary."
        );
        assert_eq!(intelligence.state("meeting")["status"], "error");
        assert!(database.checkpoints("meeting").unwrap().is_empty());
        assert_eq!(database.segments("meeting", -1, 10).unwrap().len(), 1);
        failing.store(false, Ordering::SeqCst);
        intelligence
            .analyze("meeting", false, false)
            .wait()
            .await
            .unwrap();
        let job = database.jobs("meeting").unwrap().remove(0);
        assert_eq!(
            (job["status"].clone(), job["attempts"].clone()),
            (json!("done"), json!(2))
        );
        assert_eq!(intelligence.state("meeting")["status"], "idle");
        database.close().await.unwrap();
    })
    .await;
}

struct Wiki {
    revision: Mutex<u64>,
    content: Mutex<String>,
    writes: AtomicUsize,
    searches: AtomicUsize,
    schema: Value,
    write_fails: bool,
    write_is_lost: bool,
}

impl Wiki {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            revision: Mutex::new(1),
            content: Mutex::new("Canonical requirement".into()),
            writes: AtomicUsize::new(0),
            searches: AtomicUsize::new(0),
            schema: json!({
                "type": "object",
                "properties": { "id": {}, "content": {}, "expectedRevision": {} },
                "required": ["id", "content", "expectedRevision"],
            }),
            write_fails: false,
            write_is_lost: false,
        })
    }

    fn variant(change: impl FnOnce(&mut Self)) -> Arc<Self> {
        let mut wiki = Arc::into_inner(Self::new()).unwrap();
        change(&mut wiki);
        Arc::new(wiki)
    }

    fn drift(&self) {
        *self.revision.lock().unwrap() += 1;
        *self.content.lock().unwrap() = "Changed elsewhere".into();
    }
}

impl Mcp for Wiki {
    fn tools(&self) -> BoxFuture<'_, Result<Vec<McpTool>, String>> {
        Box::pin(async move {
            Ok(["search", "read", "write"]
                .iter()
                .map(|name| McpTool {
                    server: "wiki".into(),
                    name: (*name).into(),
                    input_schema: (*name == "write").then(|| self.schema.clone()),
                })
                .collect())
        })
    }

    fn call_tool(
        &self,
        _: &str,
        name: &str,
        args: Value,
    ) -> BoxFuture<'_, Result<McpResult, String>> {
        let name = name.to_owned();
        Box::pin(async move {
            let structured = match name.as_str() {
                "search" => {
                    self.searches.fetch_add(1, Ordering::SeqCst);
                    json!({ "documents": [{ "id": "page" }] })
                }
                "read" => json!({
                    "id": "page", "revision": format!("revision-{}", self.revision.lock().unwrap()),
                    "content": self.content.lock().unwrap().clone(),
                }),
                _ => {
                    if self.write_fails {
                        return Ok(McpResult {
                            is_error: true,
                            structured: None,
                            text: vec!["denied".into()],
                        });
                    }
                    self.writes.fetch_add(1, Ordering::SeqCst);
                    if !self.write_is_lost {
                        *self.content.lock().unwrap() =
                            args["content"].as_str().unwrap().to_owned();
                        *self.revision.lock().unwrap() += 1;
                    }
                    json!({ "ok": true })
                }
            };
            Ok(McpResult {
                is_error: false,
                structured: Some(structured),
                text: vec![],
            })
        })
    }
}

fn binding(write: bool) -> KnowledgeBinding {
    KnowledgeBinding {
        server: "wiki".into(),
        search: "search".into(),
        read: "read".into(),
        write: write.then(|| "write".into()),
    }
}

async fn proposed(wiki: Arc<Wiki>, write: bool) -> (Directory, Arc<Intelligence>, String) {
    let directory = directory().await;
    let intelligence = Intelligence::new(
        directory.database.clone(),
        Some(generator(|_, _| async {
            Ok(extraction(
                "Summary",
                vec![],
                vec![json!({
                    "server": "wiki", "target": "page", "suggestedContent": "New requirement",
                    "explanation": "Meeting decision", "sourceSegmentIds": ["first"], "confidence": 0.9,
                })],
            ))
        })),
        Some(wiki),
        settings(vec![binding(write)]),
    );
    directory
        .database
        .put_segment(&segment("first", 1, "Replace the requirement"))
        .await
        .unwrap();
    intelligence
        .analyze("meeting", false, false)
        .wait()
        .await
        .unwrap();
    let proposal = directory.database.proposals("meeting").unwrap().remove(0);
    assert_eq!(proposal["status"], "pending");
    assert_eq!(proposal["expectedRevision"], "revision-1");
    let id = proposal["id"].as_str().unwrap().to_owned();
    (directory, intelligence, id)
}

fn status(directory: &Directory, id: &str) -> Value {
    directory
        .database
        .proposals("meeting")
        .unwrap()
        .into_iter()
        .find(|item| item["id"] == id)
        .unwrap()
}

#[tokio::test]
async fn cached_canonical_references_persist_for_every_requesting_meeting_across_restart() {
    bounded(async {
        let directory = directory().await;
        directory
            .database
            .create_meeting("second", "Second", "second-session")
            .await
            .unwrap();
        let wiki = Wiki::new();
        let intelligence = Intelligence::new(
            directory.database.clone(),
            None,
            Some(wiki.clone()),
            settings(vec![binding(false)]),
        );
        let first = intelligence
            .retrieve("meeting", "same requirement")
            .await
            .unwrap();
        assert_eq!(
            intelligence
                .retrieve("second", "same requirement")
                .await
                .unwrap(),
            first
        );
        assert_eq!(wiki.searches.load(Ordering::SeqCst), 1);
        directory.database.close().await.unwrap();
        let reopened = MeetingDatabase::open(&directory.path.join("meetings.redb")).unwrap();
        assert_eq!(reopened.references("second").unwrap(), first);
        assert_eq!(reopened.references("meeting").unwrap(), first);
        assert!(reopened.proposals("second").unwrap().is_empty());
        reopened.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn retrieval_rejects_a_wrong_document_and_an_unavailable_capability() {
    bounded(async {
        struct Wrong;
        impl Mcp for Wrong {
            fn tools(&self) -> BoxFuture<'_, Result<Vec<McpTool>, String>> {
                Box::pin(async {
                    Ok(["search", "read"]
                        .iter()
                        .map(|name| McpTool {
                            server: "wiki".into(),
                            name: (*name).into(),
                            input_schema: None,
                        })
                        .collect())
                })
            }
            fn call_tool(
                &self,
                _: &str,
                name: &str,
                _: Value,
            ) -> BoxFuture<'_, Result<McpResult, String>> {
                let structured = if name == "search" {
                    json!({ "documents": [{ "id": "page" }] })
                } else {
                    json!({ "id": "other", "revision": "r", "content": "c" })
                };
                Box::pin(async move {
                    Ok(McpResult {
                        is_error: false,
                        structured: Some(structured),
                        text: vec![],
                    })
                })
            }
        }
        let directory = directory().await;
        let wrong = Intelligence::new(
            directory.database.clone(),
            None,
            Some(Arc::new(Wrong)),
            settings(vec![binding(false)]),
        );
        assert_eq!(
            wrong.retrieve("meeting", "q").await.unwrap_err(),
            "MCP returned the wrong document"
        );
        let missing = Intelligence::new(
            directory.database.clone(),
            None,
            Some(Wiki::new()),
            settings(vec![KnowledgeBinding {
                server: "wiki".into(),
                search: "absent".into(),
                read: "read".into(),
                write: None,
            }]),
        );
        assert_eq!(
            missing.retrieve("meeting", "q").await.unwrap_err(),
            "Configured MCP capability is unavailable"
        );
        let without = Intelligence::new(
            directory.database.clone(),
            None,
            None,
            settings(vec![binding(true)]),
        );
        assert!(without.retrieve("meeting", "q").await.unwrap().is_empty());
        assert!(directory.database.references("meeting").unwrap().is_empty());
        directory.database.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn an_approved_proposal_is_written_with_the_expected_revision_and_verified_by_read_back() {
    bounded(async {
        let wiki = Wiki::new();
        let (directory, intelligence, id) = proposed(wiki.clone(), true).await;
        intelligence.review("meeting", &id, true).await.unwrap();
        assert_eq!(status(&directory, &id)["status"], "applied");
        assert_eq!(wiki.writes.load(Ordering::SeqCst), 1);
        assert_eq!(*wiki.content.lock().unwrap(), "New requirement");
        let approvals = directory.database.approvals("meeting").unwrap();
        assert_eq!(
            (
                approvals[0]["decision"].clone(),
                approvals[0]["targetID"].clone()
            ),
            (json!("approve"), json!(id.clone()))
        );
        let references = directory.database.references("meeting").unwrap();
        assert_eq!(references[0]["revision"], "revision-2");
        assert_eq!(references[0]["content"], "New requirement");
        assert!(!intelligence.writing());
        let error = intelligence.review("meeting", &id, true).await.unwrap_err();
        assert_eq!(error, "Proposal is not awaiting review");
        assert_eq!(wiki.writes.load(Ordering::SeqCst), 1);
        directory.database.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn approval_degrades_to_manual_stale_uncertain_or_failed_and_never_replays_a_write() {
    bounded(async {
        let (directory, intelligence, id) = proposed(Wiki::new(), false).await;
        intelligence.review("meeting", &id, true).await.unwrap();
        assert_eq!(status(&directory, &id)["status"], "manual");
        directory.database.close().await.unwrap();

        let weak = Wiki::variant(|wiki| {
            wiki.schema =
                json!({ "type": "object", "properties": { "id": {} }, "required": ["id"] })
        });
        let (directory, intelligence, id) = proposed(weak.clone(), true).await;
        intelligence.review("meeting", &id, true).await.unwrap();
        let manual = status(&directory, &id);
        assert_eq!(manual["status"], "manual");
        assert_eq!(
            manual["error"],
            "The MCP writer does not advertise required revision-aware update fields"
        );
        assert_eq!(weak.writes.load(Ordering::SeqCst), 0);
        directory.database.close().await.unwrap();

        let wiki = Wiki::new();
        let (directory, intelligence, id) = proposed(wiki.clone(), true).await;
        wiki.drift();
        intelligence.review("meeting", &id, true).await.unwrap();
        let stale = status(&directory, &id);
        assert_eq!(stale["status"], "stale");
        assert_eq!(
            stale["error"],
            "Canonical document changed; reconcile and review a new proposal"
        );
        assert_eq!(wiki.writes.load(Ordering::SeqCst), 0);
        directory.database.close().await.unwrap();

        let refused = Wiki::variant(|wiki| wiki.write_fails = true);
        let (directory, intelligence, id) = proposed(refused.clone(), true).await;
        intelligence.review("meeting", &id, true).await.unwrap();
        let uncertain = status(&directory, &id);
        assert_eq!(uncertain["status"], "uncertain");
        assert!(
            uncertain["error"]
                .as_str()
                .unwrap()
                .contains("no automatic replay")
        );
        assert!(
            intelligence.review("meeting", &id, true).await.is_err(),
            "uncertain writes need inspection, not a retry"
        );
        directory.database.close().await.unwrap();

        let lost = Wiki::variant(|wiki| wiki.write_is_lost = true);
        let (directory, intelligence, id) = proposed(lost.clone(), true).await;
        intelligence.review("meeting", &id, true).await.unwrap();
        assert_eq!(status(&directory, &id)["status"], "uncertain");
        assert_eq!(lost.writes.load(Ordering::SeqCst), 1);
        directory.database.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn a_rejected_proposal_is_recorded_without_any_mcp_write_and_unknown_proposals_are_refused() {
    bounded(async {
        let wiki = Wiki::new();
        let (directory, intelligence, id) = proposed(wiki.clone(), true).await;
        intelligence.review("meeting", &id, false).await.unwrap();
        assert_eq!(status(&directory, &id)["status"], "rejected");
        assert_eq!(wiki.writes.load(Ordering::SeqCst), 0);
        let approvals = directory.database.approvals("meeting").unwrap();
        assert_eq!(approvals[0]["decision"], "reject");
        assert_eq!(
            intelligence
                .review("meeting", "missing", true)
                .await
                .unwrap_err(),
            "Proposal is not awaiting review"
        );
        directory.database.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn a_pre_write_verification_failure_marks_the_approved_proposal_failed_without_writing() {
    bounded(async {
        struct Broken(Arc<Wiki>, AtomicBool);
        impl Mcp for Broken {
            fn tools(&self) -> BoxFuture<'_, Result<Vec<McpTool>, String>> {
                self.0.tools()
            }
            fn call_tool(
                &self,
                server: &str,
                name: &str,
                args: Value,
            ) -> BoxFuture<'_, Result<McpResult, String>> {
                if name == "read" && self.1.load(Ordering::SeqCst) {
                    return Box::pin(async {
                        Ok(McpResult {
                            is_error: true,
                            structured: None,
                            text: vec![],
                        })
                    });
                }
                self.0.call_tool(server, name, args)
            }
        }
        let wiki = Wiki::new();
        let broken = Arc::new(Broken(wiki.clone(), AtomicBool::new(false)));
        let directory = directory().await;
        let intelligence = Intelligence::new(
            directory.database.clone(),
            Some(generator(|_, _| async {
                Ok(extraction(
                    "S",
                    vec![],
                    vec![json!({
                        "server": "wiki", "target": "page", "suggestedContent": "New requirement",
                        "explanation": "why", "sourceSegmentIds": ["first"], "confidence": 0.9,
                    })],
                ))
            })),
            Some(broken.clone()),
            settings(vec![binding(true)]),
        );
        directory
            .database
            .put_segment(&segment("first", 1, "Replace the requirement"))
            .await
            .unwrap();
        intelligence
            .analyze("meeting", false, false)
            .wait()
            .await
            .unwrap();
        let id = directory.database.proposals("meeting").unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        broken.1.store(true, Ordering::SeqCst);
        let error = intelligence.review("meeting", &id, true).await.unwrap_err();
        assert_eq!(error, "MCP knowledge operation failed");
        let failed = status(&directory, &id);
        assert_eq!(failed["status"], "failed");
        assert!(
            failed["error"]
                .as_str()
                .unwrap()
                .starts_with("Pre-write verification failed")
        );
        assert_eq!(wiki.writes.load(Ordering::SeqCst), 0);
        assert!(!intelligence.writing());
        broken.1.store(false, Ordering::SeqCst);
        intelligence.review("meeting", &id, true).await.unwrap();
        assert_eq!(status(&directory, &id)["status"], "applied");
        directory.database.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn stale_pending_proposals_are_marked_when_newer_canonical_knowledge_is_retrieved() {
    bounded(async {
        let wiki = Wiki::new();
        let (directory, intelligence, id) = proposed(wiki.clone(), true).await;
        wiki.drift();
        intelligence
            .analyze("meeting", false, true)
            .wait()
            .await
            .unwrap();
        let stale = status(&directory, &id);
        assert_eq!(stale["status"], "stale");
        assert_eq!(
            stale["error"],
            "Retrieved canonical knowledge has a newer revision"
        );
        directory.database.close().await.unwrap();
    })
    .await;
}

#[tokio::test]
async fn a_plan_needs_confirmed_evidence_and_is_discarded_when_that_evidence_changes_during_generation()
 {
    bounded(async {
        let directory = directory().await;
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let intelligence = analyzer(
            &directory,
            generator({
                let (entered, release) = (entered.clone(), release.clone());
                move |_, prompt| {
                    let (entered, release) = (entered.clone(), release.clone());
                    async move {
                        assert!(prompt.contains("Do not modify source code"));
                        entered.notify_one();
                        release.acquire().await.unwrap().forget();
                        Ok("Implement the approved release".to_owned())
                    }
                }
            }),
        );
        let database = &directory.database;
        assert!(intelligence.plan("meeting").await.unwrap_err().contains("confirmed"));
        database.put_segment(&segment("evidence", 1, "Approve release")).await.unwrap();
        let decision = json!({
            "id": "decision", "meetingID": "meeting", "kind": "decision", "summary": "Approve release",
            "sourceSegmentIds": ["evidence"], "confidence": 1, "status": "confirmed", "createdAt": now(),
        });
        database.put_finding(&decision).await.unwrap();
        let planning = tokio::spawn({
            let intelligence = intelligence.clone();
            async move { intelligence.plan("meeting").await }
        });
        entered.notified().await;
        database.correct_segment("evidence", "Reject release").await.unwrap();
        release.add_permits(8);
        let error = planning.await.unwrap().unwrap_err();
        assert_eq!(error, "Plan evidence or confirmation changed during generation; review and regenerate");
        assert!(database.plan("meeting").unwrap().is_none());

        release.add_permits(8);
        intelligence.plan("meeting").await.unwrap();
        let plan = database.plan("meeting").unwrap().unwrap();
        assert_eq!(plan["status"], "proposed");
        assert_eq!(plan["content"], "Implement the approved release");
        assert_eq!(plan["findingIds"], json!(["decision"]));
        assert_eq!(plan["sourceSegmentIds"], json!(["evidence"]));
        database.close().await.unwrap();
    })
    .await;
}
