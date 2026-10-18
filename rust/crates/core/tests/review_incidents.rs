include!("policy_fixture.rs");
use std::{ops::Bound, sync::Arc};
use ycoding_core::{
    process::guardrails::{Guardrails, Input, Limits, Paths, Settings},
    session::{
        review::{
            ChildAnswer, DecideInput, Delivery, DeliveryError, DeliveryFuture, OpenInput,
            RecoveryResolution, Service as ReviewService,
        },
        store,
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, guardrail, parse_json, session,
    session_id::SessionId,
    session_message_id,
    session_review::{Decision, Item},
};
use ycoding_store::{
    model_incident::{Incident, IncidentTable},
    session::{Message, MessageTable},
};

struct Quiet;

impl Delivery for Quiet {
    fn wake(&self, _: &session::Id) {}
    fn answer_child<'a>(&'a self, _: ChildAnswer) -> DeliveryFuture<'a> {
        Box::pin(async { Err(DeliveryError::Conflict("no child in this fixture".into())) })
    }
    fn resolve_recovery<'a>(&'a self, _: RecoveryResolution) -> DeliveryFuture<'a> {
        Box::pin(async {
            Err(DeliveryError::Conflict(
                "no recovery in this fixture".into(),
            ))
        })
    }
}

fn reviews(fixture: &Fixture) -> ReviewService {
    ReviewService::new(store::Service::new(fixture.store.client()), Arc::new(Quiet))
}

fn assistant(fixture: &Fixture, session: &str, message: &str) {
    let (session, message) = (session.to_owned(), message.to_owned());
    fixture
        .store
        .submit(move |tx| {
            MessageTable::insert(
                tx,
                &Message {
                    id: message.as_str().into(),
                    session_id: session.as_str().into(),
                    type_: "assistant".into(),
                    seq: 1,
                    time_created: 1,
                    time_updated: 1,
                    data: parse_json(
                        r#"{"agent":"build","model":{"providerID":"openai","id":"gpt-runtime"},"content":[],"time":{"created":1}}"#,
                    )
                    .unwrap(),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn incidents(fixture: &Fixture) -> Vec<Incident> {
    fixture
        .store
        .snapshot()
        .unwrap()
        .scan::<IncidentTable>(Bound::Unbounded, Bound::Unbounded, 100)
        .unwrap()
}

fn kinds(fixture: &Fixture) -> Vec<(String, Option<String>, Option<String>)> {
    incidents(fixture)
        .into_iter()
        .map(|incident| {
            (
                text(&incident.kind),
                incident.request_id.as_ref().map(text),
                incident.decided_by.as_ref().map(text),
            )
        })
        .collect()
}

fn text(value: &LosslessString) -> String {
    value.to_utf8().unwrap()
}

fn request_text(id: &guardrail::RequestId) -> String {
    match id.encode() {
        JsonValue::String(value) => text(&value),
        other => panic!("request IDs encode as strings, got {other:?}"),
    }
}

fn guardrail_item(session: &SessionId, reason: &str, request: &str, message: &str) -> OpenInput {
    let literal = |value: &str| JsonValue::String(value.into());
    OpenInput {
        session_id: session.clone(),
        kind: DomainDecode::decode(&literal("guardrail")).unwrap(),
        reason: DomainDecode::decode(&literal(reason)).unwrap(),
        choice: Some("escalate".into()),
        confidence: None,
        grades: None,
        origin: DomainDecode::decode(
            &parse_json(&format!(r#"{{"messageID":"{message}","callID":"call_{request}"}}"#)).unwrap(),
        )
        .unwrap(),
        payload: DomainDecode::decode(
            &parse_json(&format!(
                r#"{{"type":"guardrail","action":"shell","resources":["git reset --hard"],"ruleIDs":["standard.review.git-destructive"],"reason":"Review","hardReview":true,"directories":[],"fingerprint":"{}","requestID":"{request}"}}"#,
                "d".repeat(64)
            ))
            .unwrap(),
        )
        .unwrap(),
        limit: 16,
        conversion: reason == "sleep_entry",
        created: 10,
    }
}

async fn decide(service: &ReviewService, session: &SessionId, item: &Item, decision: &str) {
    service
        .decide(DecideInput {
            session_id: session.clone(),
            item_id: item.deferral.item_id.clone(),
            decision: Decision::decode(&parse_json(decision).unwrap()).unwrap(),
            now: 20,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn an_escalated_review_deferral_records_one_incident_but_disabled_and_sleep_entry_deferrals_do_not()
 {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    assistant(&fixture, "ses_root", "msg_guarded");
    let service = reviews(&fixture);
    service
        .open(guardrail_item(
            &root,
            "escalated",
            "grq_escalated",
            "msg_guarded",
        ))
        .await
        .unwrap();
    service
        .open(guardrail_item(
            &root,
            "disabled",
            "grq_disabled",
            "msg_guarded",
        ))
        .await
        .unwrap();
    service
        .open(guardrail_item(
            &root,
            "sleep_entry",
            "grq_converted",
            "msg_guarded",
        ))
        .await
        .unwrap();
    assert_eq!(
        kinds(&fixture),
        [(
            "guardrail-escalated".to_owned(),
            Some("grq_escalated".to_owned()),
            None
        )]
    );
    let incident = incidents(&fixture).remove(0);
    assert_eq!(text(&incident.session_id), "ses_root");
    assert_eq!(text(&incident.agent), "build");
    assert_eq!(text(&incident.model_id), "gpt-runtime");
    assert!(!format!("{incident:?}").contains("git reset --hard"));
}

#[tokio::test]
async fn a_human_review_rejection_records_a_human_incident_and_approvals_record_nothing() {
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    assistant(&fixture, "ses_root", "msg_guarded");
    let service = reviews(&fixture);
    let rejected = service
        .open(guardrail_item(
            &root,
            "disabled",
            "grq_rejected",
            "msg_guarded",
        ))
        .await
        .unwrap();
    let approved = service
        .open(guardrail_item(
            &root,
            "disabled",
            "grq_approved",
            "msg_guarded",
        ))
        .await
        .unwrap();
    decide(
        &service,
        &root,
        &rejected,
        r#"{"kind":"guardrail","reply":"reject"}"#,
    )
    .await;
    decide(
        &service,
        &root,
        &approved,
        r#"{"kind":"guardrail","reply":"once"}"#,
    )
    .await;
    assert_eq!(
        kinds(&fixture),
        [(
            "guardrail-rejected".to_owned(),
            Some("grq_rejected".to_owned()),
            Some("human".to_owned())
        )]
    );
}

fn settings() -> Settings {
    Settings {
        paths: Paths {
            workdir: "/workspace/project".into(),
            project: "/workspace/project".into(),
            home: "/home/operator".into(),
            tmpdir: None,
            trusted_paths: vec![],
        },
        global_roots: vec!["/home/operator/.config/ycoding".into()],
        custom: Arc::new(Vec::new),
        enabled: true,
        limits: Limits::default(),
        decide_reviews: false,
        decide_hard_reviews: true,
    }
}

fn shell(session: &SessionId, command: &str, source: Option<&str>) -> Input {
    Input {
        session_id: session.clone(),
        action: "shell".into(),
        resources: vec![command.into()],
        metadata: None,
        skip_review: false,
        holder: None,
        source: source.map(|message| guardrail::Source {
            message_id: session_message_id::Id::new(message).unwrap(),
            call_id: "call_awake".into(),
        }),
    }
}

#[tokio::test]
async fn an_awake_human_guardrail_rejection_records_its_canonical_source_and_once_records_nothing()
{
    let fixture = Fixture::default();
    let root = fixture.session("ses_root", None, 0, false, None);
    assistant(&fixture, "ses_root", "msg_awake");
    let guardrails = Guardrails::new(
        fixture.authority(),
        fixture.permissions(),
        settings(),
        fixture.publisher(),
    );
    let rejected = guardrails
        .assert(shell(&root, "git reset --hard", Some("msg_awake")))
        .unwrap();
    let rejected_id = rejected.request.as_ref().unwrap().id.clone();
    guardrails
        .reply(&root, &rejected_id, guardrail::Reply::Reject)
        .unwrap();
    assert!(rejected.wait.unwrap().await.unwrap().is_err());
    let approved = guardrails
        .assert(shell(&root, "git clean -fdx", Some("msg_awake")))
        .unwrap();
    guardrails
        .reply(
            &root,
            &approved.request.as_ref().unwrap().id,
            guardrail::Reply::Once,
        )
        .unwrap();
    approved.wait.unwrap().await.unwrap().unwrap().release();
    let unattributed = guardrails
        .assert(shell(&root, "git push --force", None))
        .unwrap();
    guardrails
        .reply(
            &root,
            &unattributed.request.as_ref().unwrap().id,
            guardrail::Reply::Reject,
        )
        .unwrap();
    assert_eq!(
        kinds(&fixture),
        [(
            "guardrail-rejected".to_owned(),
            Some(request_text(&rejected_id)),
            Some("human".to_owned())
        )]
    );
}
