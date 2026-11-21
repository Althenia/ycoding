mod support;

use prost::Message;
use std::time::Duration;
use support::{Client, services, session_scope, start, world};
use ycoding_core::event_feed::{Data, Ephemeral};
use ycoding_core::ycoding_schema::{LosslessString, parse_json};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const ASSESSMENT: &str = r#"{"mode":"yolo","sourceSessionID":"ses_judge","fields":[{"key":"plan","status":"assessed","reason":"close \ud800","grades":[{"choice":"a","confidence":0.5,"evidence":"near"}],"recommendation":["a","b"],"confidence":0.75},{"key":"other","status":"not_assessed","reason":"skipped"}]}"#;
const ESCALATION: &str = r#"{"reasons":[{"sessionID":"ses_driver","reason":"outside \ud800 target"},{"sessionID":"ses_master","reason":"confirm"}]}"#;

fn global() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Global(v5::Empty {})),
    }
}

async fn subscribe(client: &mut Client, scope: v5::Scope) -> String {
    let request = client
        .send(
            "event.subscribe",
            global(),
            v5::EventSubscribeRequest {
                scope: scope.clone(),
            }
            .encode_to_vec(),
        )
        .await;
    client.subscribe_events(&request, scope).await
}

fn ephemeral(id: &str, name: &str, data: &str) -> Ephemeral {
    let data = Data::decode(name, &parse_json(data).unwrap()).unwrap();
    Ephemeral {
        id: LosslessString::from(id),
        created: 42,
        session: data.session().unwrap(),
        location: None,
        metadata: None,
        data,
    }
}

fn delivered(client: &Client, subscription: &str) -> Vec<v5::public_event::Kind> {
    client
        .batches
        .iter()
        .filter(|batch| batch.subscription_id == subscription)
        .flat_map(|batch| &batch.events)
        .filter(|record| record.durable.is_none())
        .map(|record| {
            v5::PublicEvent::decode(record.event.payload.as_slice())
                .unwrap()
                .kind
                .unwrap()
        })
        .collect()
}

#[test]
fn feed_data_decodes_the_new_events_with_their_session_and_optional_fields() {
    let assessed = Data::decode(
        "form.assessed",
        &parse_json(&format!(
            r#"{{"id":"frm_one","sessionID":"ses_prompt","assessment":{ASSESSMENT}}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(assessed.name(), "form.assessed");
    assert_eq!(
        assessed.session().unwrap().unwrap().as_lossless().as_str(),
        Some("ses_prompt")
    );
    let global = Data::decode(
        "form.assessed",
        &parse_json(&format!(
            r#"{{"id":"frm_one","sessionID":"global","assessment":{ASSESSMENT}}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    assert!(global.session().unwrap().is_none());
    let escalated = Data::decode(
        "coordination.request.escalated",
        &parse_json(&format!(
            r#"{{"sessionID":"ses_prompt","kind":"review","requestID":"grq_one","coordinationEscalation":{ESCALATION}}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(escalated.name(), "coordination.request.escalated");
    assert_eq!(
        escalated.session().unwrap().unwrap().as_lossless().as_str(),
        Some("ses_prompt")
    );
    assert!(
        Data::decode(
            "coordination.request.escalated",
            &parse_json(r#"{"sessionID":"ses_prompt","kind":"review","requestID":"grq_one"}"#)
                .unwrap()
        )
        .is_err()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assessment_and_escalation_events_cross_the_real_subscription_losslessly() {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(Duration::from_secs(60), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let everything = subscribe(&mut client, global()).await;
        let own = subscribe(&mut client, session_scope("ses_prompt")).await;
        let events = [
            ephemeral(
                "evt_assessed",
                "form.assessed",
                &format!(r#"{{"id":"frm_one","sessionID":"ses_prompt","assessment":{ASSESSMENT}}}"#),
            ),
            ephemeral(
                "evt_escalated_root",
                "coordination.request.escalated",
                &format!(
                    r#"{{"sessionID":"ses_prompt","rootSessionID":"ses_root","kind":"permission","requestID":"per_one","coordinationEscalation":{ESCALATION}}}"#
                ),
            ),
            ephemeral(
                "evt_escalated_plain",
                "coordination.request.escalated",
                &format!(
                    r#"{{"sessionID":"ses_prompt","kind":"review","requestID":"grq_one","coordinationEscalation":{ESCALATION}}}"#
                ),
            ),
            ephemeral(
                "evt_updated",
                "coordination.updated",
                r#"{"groupID":"cgrp_fixture","revision":3}"#,
            ),
        ];
        for event in &events {
            world().core.events.publish(event.clone());
        }
        loop {
            let count = |subscription: &str| {
                client
                    .batches
                    .iter()
                    .filter(|batch| batch.subscription_id == subscription)
                    .map(|batch| batch.events.len())
                    .sum::<usize>()
            };
            if count(&everything) == events.len() && count(&own) == 3 {
                break;
            }
            client.step().await;
        }
        let kinds = delivered(&client, &everything);
        let v5::public_event::Kind::FormAssessed(assessed) = &kinds[0] else {
            panic!("form.assessed expected")
        };
        assert_eq!(assessed.data.assessment.mode, 3);
        let plan = &assessed.data.assessment.fields.items[0];
        assert_eq!((plan.status, plan.confidence), (2, Some(0.75)));
        assert_eq!(plan.grades.as_ref().unwrap().items.len(), 1);
        assert_eq!(plan.recommendation.as_ref().unwrap().items.len(), 2);
        assert_eq!(
            ycoding_protocol::decode_lossless(&plan.reason, 1024).unwrap(),
            "close ".encode_utf16().chain([0xd800]).collect::<Vec<u16>>()
        );
        let skipped = &assessed.data.assessment.fields.items[1];
        assert_eq!(skipped.status, 4);
        assert!(
            skipped.grades.is_none()
                && skipped.recommendation.is_none()
                && skipped.confidence.is_none()
        );
        let v5::public_event::Kind::CoordinationRequestEscalated(with_root) = &kinds[1] else {
            panic!("coordination.request.escalated expected")
        };
        assert_eq!(with_root.data.kind, 2);
        assert!(with_root.data.root_session_id.is_some());
        let reasons = &with_root.data.coordination_escalation.reasons.items;
        assert_eq!(reasons.len(), 2);
        assert_eq!(
            ycoding_protocol::decode_lossless(&reasons[0].reason, 1024).unwrap(),
            "outside "
                .encode_utf16()
                .chain([0xd800])
                .chain(" target".encode_utf16())
                .collect::<Vec<u16>>()
        );
        let v5::public_event::Kind::CoordinationRequestEscalated(without_root) = &kinds[2] else {
            panic!("coordination.request.escalated expected")
        };
        assert_eq!(without_root.data.kind, 3);
        assert!(without_root.data.root_session_id.is_none());
        let v5::public_event::Kind::CoordinationUpdated(updated) = &kinds[3] else {
            panic!("coordination.updated expected")
        };
        assert_eq!(updated.data.revision, 3);
        assert_eq!(delivered(&client, &own).len(), 3);
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
