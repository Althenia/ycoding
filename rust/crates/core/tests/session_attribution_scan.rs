use ycoding_core::session::{
    compaction_job::AdmitInput,
    pending::{Promotion, Request},
    provider_request::Begin,
    store::Service,
    usage_attribution::Attribution,
};
use ycoding_schema::{
    DomainDecode, model, parse_json, schema::NonNegativeInt, session, session_compaction,
    session_message, session_pending, usage_anchor,
};
use ycoding_store::{
    KeyPart, Store,
    session::{ContextState, ContextStateTable, MessageTable, Revision, RevisionTable},
    tuple_key,
};

#[path = "session_support/mod.rs"]
mod support;

const SESSION: &str = "ses_one";
const USER: &str = "msg_scan_user";
const GOAL_CONTINUATIONS: usize = 360;

fn ses(id: &str) -> session::Id {
    session::Id::new(id).unwrap()
}

fn msg(id: &str) -> session_message::Id {
    session_message::Id::new(id).unwrap()
}

fn anchor(session: &str, input: &str) -> usage_anchor::Ref {
    usage_anchor::Ref {
        session_id: ses(session),
        input_id: msg(input),
    }
}

fn message(json: &str) -> session_pending::Message {
    session_pending::Message::decode(&parse_json(json).unwrap()).unwrap()
}

async fn promoted(service: &Service, id: &str, input: session_pending::Message, created: i64) {
    service
        .admit(Request {
            id: msg(id),
            session_id: ses(SESSION),
            input,
            event_id: ycoding_schema::event::Id::new(format!("evt_{id}")).unwrap(),
            created,
        })
        .await
        .unwrap();
    assert_eq!(
        service
            .promote_input(&ses(SESSION), msg(id).as_lossless(), created + 1)
            .await
            .unwrap(),
        Promotion::Promoted,
        "{id}"
    );
}

async fn long_goal_run() -> (Store, Service, i64) {
    let store = support::store();
    store
        .submit(|tx| {
            RevisionTable::insert(
                tx,
                &Revision {
                    session_id: SESSION.into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            ContextStateTable::insert(
                tx,
                &ContextState {
                    session_id: SESSION.into(),
                    status: "active".into(),
                    revision: 0,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activated_event_id: None,
                    time_activated: None,
                    error_code: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    promoted(
        &service,
        USER,
        message(r#"{"type":"user","data":{"text":"Reach the goal"},"delivery":"steer"}"#),
        10,
    )
    .await;
    for iteration in 0..GOAL_CONTINUATIONS {
        promoted(
            &service,
            &format!("msg_scan_goal_{iteration:03}"),
            message(&format!(
                r#"{{"type":"synthetic","data":{{"text":"Continue toward the goal.","description":"Goal · steer","metadata":{{"autonomy":{{"yolo":0,"goal":true,"iteration":{iteration}}}}}}},"delivery":"steer"}}"#
            )),
            20 + 2 * iteration as i64,
        )
        .await;
    }
    let seq = store
        .snapshot()
        .unwrap()
        .get::<MessageTable>(&tuple_key(&[KeyPart::String(&USER.into())]))
        .unwrap()
        .unwrap()
        .seq;
    (store, service, seq)
}

fn begin() -> Begin {
    Begin {
        session: ses(SESSION),
        model: model::Ref::decode(&parse_json(r#"{"providerID":"openai","id":"gpt"}"#).unwrap())
            .unwrap(),
        route_id: "openai-responses".into(),
        connection_identity_digest: None,
        prompt_cache_key: "a".repeat(64),
        system_digest: "b".repeat(64),
        tool_digest: "c".repeat(64),
    }
}

fn admission(seq: i64) -> AdmitInput {
    AdmitInput {
        id: None,
        session: ses(SESSION),
        trigger: session_compaction::Trigger::Mandatory,
        requested_through_message: msg(USER),
        requested_through_seq: seq,
        base_context_revision: 0,
        target_max_input_tokens: 1000,
        config_digest: "c".repeat(64),
        pressure: Some(session_compaction::Pressure {
            estimated_input_tokens: NonNegativeInt::new(900).unwrap(),
            safe_input_tokens: NonNegativeInt::new(800).unwrap(),
        }),
    }
}

#[tokio::test]
async fn a_step_request_after_a_long_goal_run_begins_attributed_to_the_original_user_prompt() {
    let (_store, service, _) = long_goal_run().await;
    let pending = service
        .begin_provider_request(&begin())
        .await
        .expect("a step request begins after a long run of goal continuations");
    assert_eq!(pending.usage_anchor, Some(anchor(SESSION, USER)));
}

#[tokio::test]
async fn compaction_admitted_after_a_long_goal_run_is_attributed_to_the_original_user_prompt() {
    let (_store, service, seq) = long_goal_run().await;
    let job = service
        .compaction_admit(admission(seq), 10_000)
        .await
        .expect("compaction is admitted after a long run of goal continuations");
    assert_eq!(
        job.usage_anchor
            .as_ref()
            .map(|anchor| anchor.domain().unwrap()),
        Some(anchor(SESSION, USER))
    );
}

#[tokio::test]
async fn explicit_attribution_is_kept_verbatim_after_a_long_goal_run() {
    let (_store, service, seq) = long_goal_run().await;
    let foreign = anchor("ses_two", "msg_scan_elsewhere");
    let unanchored = service
        .begin_provider_request_attributed(&begin(), Attribution::Unanchored)
        .await
        .unwrap();
    assert_eq!(unanchored.usage_anchor, None);
    let anchored = service
        .begin_provider_request_attributed(&begin(), Attribution::Anchored(foreign.clone()))
        .await
        .unwrap();
    assert_eq!(anchored.usage_anchor, Some(foreign.clone()));
    let job = service
        .compaction_admit_attributed(
            admission(seq),
            10_000,
            Attribution::Anchored(foreign.clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        job.usage_anchor
            .as_ref()
            .map(|anchor| anchor.domain().unwrap()),
        Some(foreign)
    );
}
