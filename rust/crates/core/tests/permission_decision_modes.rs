include!("policy_fixture.rs");

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use ycoding_core::{
    process::guardrails::decision::{EvaluateFuture, Evaluator},
    resources::decision::{self, Invocation},
    tools::policy::{Event, Publisher, permissions::Permissions},
};
use ycoding_schema::{DomainDecode, JsonValue, permission, project_id::ProjectId};

const BOUND: Duration = Duration::from_secs(10);

#[derive(Default)]
struct Counting(AtomicUsize);

impl Evaluator for Counting {
    fn evaluate<'a>(&'a self, _: JsonValue, _: Invocation<'a>) -> EvaluateFuture<'a> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Err(decision::Error::Unavailable) })
    }
}

fn ask_rule() -> permission::Rule {
    permission::Rule {
        action: "read".into(),
        resource: "*".into(),
        effect: permission::Effect("ask".into()),
    }
}

fn request(session: &ycoding_schema::session_id::SessionId) -> permission::Request {
    permission::Request {
        id: permission::Id::new("per_modes").unwrap(),
        session_id: session.clone(),
        action: "read".into(),
        resources: vec!["notes/plan.md".into()],
        save: None,
        metadata: None,
        source: None,
        escalation: None,
        coordination_escalation: None,
    }
}

struct Run {
    finished: bool,
    calls: usize,
    pending: usize,
    asked: Option<permission::Request>,
    emitted: Vec<String>,
    assessed: Vec<serde_json::Value>,
}

async fn settle(decide_reviews: bool, permissions: &str) -> Run {
    let fixture = Fixture::default();
    fixture.rules.lock().unwrap().push(ask_rule());
    let root = fixture.session_with(
        "ses_root",
        None,
        [permissions, "manual", "manual"],
        false,
        None,
    );
    let (sender, mut receiver) = mpsc::unbounded_channel::<Event>();
    let publish: Publisher = Arc::new(move |event| {
        let _ = sender.send(event);
        Ok(())
    });
    let helper = Arc::new(Counting::default());
    let service = Permissions::new(
        fixture.authority(),
        ProjectId::new("project").unwrap(),
        publish,
    )
    .with_decision(helper.clone(), decide_reviews);
    let waiting = tokio::spawn({
        let service = service.clone();
        let request = request(&root);
        async move { service.assert(request, None).await }
    });
    let mut emitted = Vec::new();
    if permissions == "auto" || permissions == "yolo" {
        let outcome = tokio::time::timeout(BOUND, waiting)
            .await
            .expect("an auto ask settles without a human")
            .unwrap();
        assert!(outcome.is_ok());
        while let Ok(event) = receiver.try_recv() {
            emitted.push(event.type_.to_string());
        }
        return Run {
            finished: true,
            calls: helper.0.load(Ordering::SeqCst),
            pending: service.list().len(),
            asked: None,
            emitted,
            assessed: fixture
                .store
                .snapshot()
                .unwrap()
                .scan::<ycoding_store::session::EventTable>(
                    std::ops::Bound::Unbounded,
                    std::ops::Bound::Unbounded,
                    100,
                )
                .unwrap()
                .into_iter()
                .filter(|event| event.type_.as_str() == Some("session.permission.assessed.1"))
                .map(|event| {
                    serde_json::from_str(&ycoding_schema::stringify_json(&event.data)).unwrap()
                })
                .collect(),
        };
    }
    let asked = tokio::time::timeout(BOUND, async {
        while let Some(event) = receiver.recv().await {
            emitted.push(event.type_.to_string());
            if event.type_ == "permission.asked" {
                return permission::Request::decode(&event.data).unwrap();
            }
        }
        panic!("the ask was never published")
    })
    .await
    .expect("the ask reaches a human");
    let run = Run {
        finished: waiting.is_finished(),
        calls: helper.0.load(Ordering::SeqCst),
        pending: service.list().len(),
        asked: Some(asked),
        emitted,
        assessed: vec![],
    };
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    run
}

#[tokio::test]
async fn manual_permissions_never_call_the_helper_even_when_reviews_are_decided() {
    for decide_reviews in [true, false] {
        let run = settle(decide_reviews, "manual").await;
        assert!(!run.finished, "the ask waits for a human");
        assert_eq!((run.calls, run.pending), (0, 1));
        assert!(run.asked.unwrap().escalation.is_none());
        assert_eq!(run.emitted, ["permission.asked"]);
    }
}

#[tokio::test]
async fn auto_permissions_approve_asks_by_rule_without_a_helper_call() {
    for decide_reviews in [true, false] {
        let run = settle(decide_reviews, "auto").await;
        assert_eq!((run.calls, run.pending), (0, 0));
        assert!(run.asked.is_none());
        assert!(!run.emitted.iter().any(|kind| kind == "permission.asked"));
    }
}

#[tokio::test]
async fn yolo_permissions_admit_without_a_helper_or_human_regardless_of_decide_reviews() {
    for decide_reviews in [true, false] {
        let run = settle(decide_reviews, "yolo").await;
        assert!(run.finished);
        assert_eq!((run.calls, run.pending), (0, 0));
        assert!(run.asked.is_none());
        assert_eq!(run.assessed.len(), 1);
        assert_eq!(run.assessed[0]["outcome"], "allow");
        assert_eq!(run.assessed[0]["via"], "yolo");
        assert_eq!(run.assessed[0]["reply"], "once");
        assert!(run.emitted.is_empty());
    }
}
