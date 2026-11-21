include!("policy_fixture.rs");
use ycoding_core::session::{pending, store::Service};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, parse_json, session_message,
    session_pending,
};

#[tokio::test]
async fn retired_routine_and_delegated_inputs_are_rejected_once_at_both_promotion_boundaries() {
    for delivery in ["steer", "queue"] {
        for kind in ["routine", "delegated"] {
            let fixture = Fixture::default();
            let session = fixture.session("ses_native_root", None, 0, false, None);
            let service = Service::new(fixture.store.client());
            let receipt = if kind == "routine" {
                r#"{"routine":{"delegation":{"id":"delegation_fixture","revision":1},"taskInputID":"msg_task_fixture","instruction":{"operation":"continue"}}}"#
            } else {
                r#"{"delegated":{"delegation":{"id":"delegation_fixture","revision":1},"instruction":{"operation":"task","text":"Synthetic task"}}}"#
            };
            let JsonValue::Object(receipt) = parse_json(receipt).unwrap() else {
                unreachable!()
            };
            let mut association = receipt.clone();
            association.insert("sessionID".into(), session.encode());
            association.insert("exchangeID".into(), "exchange_fixture".encode());
            let input_id = session_message::Id::new("msg_retired_fixture").unwrap();
            let mut record = association.clone();
            record.insert("inputID".into(), input_id.encode());
            record.insert("targetSessionID".into(), session.encode());
            let aggregate = session.clone();
            fixture
                .store
                .submit(move |tx| {
                    ycoding_store::session::append(
                        tx,
                        &ycoding_store::session::NewEvent {
                            id: "evt_historical_exchange".into(),
                            aggregate_id: aggregate.as_lossless().clone(),
                            created: 1,
                            type_: "session.dots.exchange.created.1".into(),
                            data: JsonValue::Object(record),
                        },
                        None,
                    )
                    .map(|_| ())
                })
                .unwrap()
                .wait()
                .unwrap();
            let input = session_pending::Message::decode(
                &ObjectEncoder::new()
                    .field("type", "user")
                    .field("delivery", delivery)
                    .field(
                        "data",
                        &ObjectEncoder::new()
                            .field("text", "Synthetic retired instruction")
                            .field(
                                "metadata",
                                &ObjectEncoder::new()
                                    .field("inputOrigin", "plugin")
                                    .field("dotsExchange", &JsonValue::Object(association))
                                    .finish(),
                            )
                            .finish(),
                    )
                    .finish(),
            )
            .unwrap();
            service
                .admit(pending::Request {
                    id: input_id.clone(),
                    session_id: session.clone(),
                    input,
                    event_id: ycoding_schema::event::Id::new("evt_retired_admission").unwrap(),
                    created: 2,
                })
                .await
                .unwrap();
            for _ in 0..2 {
                if delivery == "steer" {
                    assert_eq!(service.promote_steers(&session, 3).await.unwrap(), 0);
                } else {
                    assert!(!service.promote_next_queued(&session, 3).await.unwrap());
                }
            }
            assert!(service.pending(&input_id).unwrap().is_none());
            assert!(service.message(&input_id).unwrap().is_none());
            let rows = fixture
                .store
                .snapshot()
                .unwrap()
                .scan::<ycoding_store::session::EventTable>(
                    std::ops::Bound::Unbounded,
                    std::ops::Bound::Unbounded,
                    100,
                )
                .unwrap();
            let rejected = rows
                .iter()
                .filter(|event| event.type_.as_str() == Some("session.dots.instruction.rejected.1"))
                .collect::<Vec<_>>();
            assert_eq!(rejected.len(), 1);
            assert_eq!(
                rejected[0].data,
                ObjectEncoder::new()
                    .field("sessionID", &session)
                    .field("inputID", &input_id)
                    .field("anchorSessionID", &session)
                    .field("exchangeID", "exchange_fixture")
                    .field("delegationID", "delegation_fixture")
                    .field("reason", "delegation_invalid")
                    .finish()
            );
            assert!(
                rows.iter()
                    .any(|event| event.type_.as_str() == Some("session.dots.exchange.created.1"))
            );
        }
    }
}
