#[path = "session_support/mod.rs"]
mod support;

use std::{ops::Bound, sync::Arc};
use ycoding_core::session::{
    autonomy::Origin,
    execution::{Execution, Locations, Runner},
    pending::{Control, Request},
    projector, run_coordinator,
    store::Service,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, ObjectEncoder, parse_json, session, session_message,
    session_pending,
};
use ycoding_store::{
    Error,
    session::{EventTable, NewEvent},
};

fn request(name: &str, input: &str) -> Request {
    Request {
        id: session_message::Id::new(format!("msg_{name}")).unwrap(),
        session_id: session::Id::new("ses_one").unwrap(),
        input: session_pending::Message::decode(&parse_json(input).unwrap()).unwrap(),
        event_id: ycoding_schema::event::Id::new(format!("evt_{name}")).unwrap(),
        created: 10,
    }
}

async fn admit(service: &Service, name: &str, input: &str) -> session_message::Id {
    let request = request(name, input);
    let id = request.id.clone();
    service.admit(request).await.unwrap();
    id
}

fn user(service: &Service, id: &session_message::Id) -> session_message::User {
    let (_, session_message::Info::User(user)) = service.message(id).unwrap().unwrap() else {
        panic!("expected a user message");
    };
    user
}

fn assert_refused(result: Result<(), Error>, expected: &str) {
    assert!(
        matches!(result, Err(Error::Domain { kind, .. }) if kind == expected),
        "expected {expected}, got {result:?}"
    );
}

struct UnusedLocations;

impl Locations for UnusedLocations {
    fn get(&self, _: &session::Info) -> Result<Arc<dyn Runner>, run_coordinator::Error> {
        panic!("admit-only delivery must not start the runner");
    }
}

#[tokio::test]
async fn sent_deletion_projects_and_replays_once_with_only_trusted_direct_ownership() {
    let store = support::store();
    let service = Service::new(store.client());
    let one = session::Id::new("ses_one").unwrap();
    let execution = Execution::install(
        service.clone(),
        Arc::new(UnusedLocations),
        ycoding_core::job::Jobs::new(),
        None,
    )
    .unwrap();
    let direct = request(
        "direct",
        r#"{"type":"user","data":{"text":"original","metadata":{"inputOrigin":"plugin"}},"delivery":"queue"}"#,
    );
    let plugin = request(
        "plugin",
        r#"{"type":"user","data":{"text":"plugin input","metadata":{"inputOrigin":"direct"}},"delivery":"steer"}"#,
    );
    let original = execution.prompt(direct.clone(), Some(false)).await.unwrap();
    execution
        .prompt_with_origin(plugin.clone(), Some(false), Origin::Plugin)
        .await
        .unwrap();
    assert!(service.promote_next_queued(&one, 20).await.unwrap());
    assert_eq!(service.promote_steers(&one, 21).await.unwrap(), 1);
    for (id, origin) in [(&direct.id, "direct"), (&plugin.id, "plugin")] {
        let metadata = user(&service, id).metadata.unwrap();
        assert_eq!(metadata.get(&"inputOrigin".into()), Some(&origin.encode()));
    }
    let plugin_message = service.message(&plugin.id).unwrap();
    let before = service.log(&one, None, 20).unwrap();
    assert_refused(
        service.delete_message(&one, &plugin.id, 22).await,
        "message_not_owned",
    );
    assert_eq!(service.log(&one, None, 20).unwrap(), before);
    assert_eq!(service.message(&plugin.id).unwrap(), plugin_message);

    service.delete_message(&one, &direct.id, 23).await.unwrap();
    assert!(service.message(&direct.id).unwrap().is_none());
    assert_eq!(service.message(&plugin.id).unwrap(), plugin_message);
    let deleted = service.log(&one, before.watermark, 20).unwrap();
    assert_eq!(deleted.events.len(), 1);
    let receipt = &deleted.events[0];
    assert_eq!(receipt.version, 1);
    assert_eq!(
        receipt.event.0.event_type.as_str(),
        Some("session.input.deleted")
    );
    assert_eq!(receipt.event.0.created.epoch_millis(), 23);
    assert_eq!(
        receipt.event.0.data.encode(),
        ObjectEncoder::new()
            .field("sessionID", &one)
            .field("inputID", &direct.id)
            .finish()
    );
    let retry = request(
        "direct",
        r#"{"type":"user","data":{"text":"retry"},"delivery":"steer"}"#,
    );
    let retried = execution.prompt(retry, Some(false)).await.unwrap();
    assert_eq!(retried, original);
    assert!(service.pending_list(&one).unwrap().is_empty());
    assert!(service.message(&direct.id).unwrap().is_none());
    assert_refused(
        service.delete_message(&one, &direct.id, 24).await,
        "message_not_found",
    );
    assert_eq!(service.log(&one, before.watermark, 20).unwrap(), deleted);

    let mut history = store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 20)
        .unwrap();
    history.sort_by_key(|event| event.seq);
    let rebuilt = support::store();
    rebuilt
        .submit(move |tx| {
            for event in history {
                projector::fold(tx, &event)?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let replay = Service::new(rebuilt.client());
    assert!(replay.message(&direct.id).unwrap().is_none());
    assert!(replay.pending_list(&one).unwrap().is_empty());
    assert_eq!(replay.message(&plugin.id).unwrap(), plugin_message);
}

#[tokio::test]
async fn sent_deletion_refusals_leave_the_transcript_inbox_and_log_unchanged() {
    let store = support::store();
    let service = Service::new(store.client());
    let one = session::Id::new("ses_one").unwrap();
    let two = session::Id::new("ses_two").unwrap();
    let missing = session::Id::new("ses_missing").unwrap();
    let direct = admit(
        &service,
        "will_be_read",
        r#"{"type":"user","data":{"text":"direct","metadata":{"inputOrigin":"direct"}},"delivery":"steer"}"#,
    )
    .await;
    let no_origin = admit(
        &service,
        "unattributed",
        r#"{"type":"user","data":{"text":"unattributed"},"delivery":"steer"}"#,
    )
    .await;
    let synthetic = admit(
        &service,
        "synthetic_forged",
        r#"{"type":"synthetic","data":{"text":"internal","metadata":{"inputOrigin":"direct"}},"delivery":"steer"}"#,
    )
    .await;
    assert_eq!(service.promote_steers(&one, 20).await.unwrap(), 3);
    let pending = admit(
        &service,
        "pending_separate_control",
        r#"{"type":"user","data":{"text":"pending","metadata":{"inputOrigin":"direct"}},"delivery":"queue"}"#,
    )
    .await;
    let stale = user(&service, &direct);
    assert!(stale.time.consumed.is_none());
    service
        .publish(NewEvent {
            id: "evt_consumed".into(),
            aggregate_id: one.as_lossless().clone(),
            created: 30,
            type_: "session.input.consumed.1".into(),
            data: ObjectEncoder::new()
                .field("sessionID", &one)
                .field("inputIDs", &vec![direct.clone()])
                .finish(),
        })
        .await
        .unwrap();
    let consumed = user(&service, &direct);
    assert_eq!(consumed.time.consumed.unwrap().epoch_millis(), 30);
    assert!(stale.time.consumed.is_none());
    let one_log = service.log(&one, None, 20).unwrap();
    let two_log = service.log(&two, None, 20).unwrap();
    let pending_row = service.pending(&pending).unwrap();
    let synthetic_row = service.message(&synthetic).unwrap();
    let unattributed_row = service.message(&no_origin).unwrap();
    for (session, id, expected) in [
        (&missing, &direct, "not_found"),
        (&two, &direct, "message_not_found"),
        (&one, &pending, "message_not_found"),
        (&one, &direct, "message_read"),
        (&one, &synthetic, "message_not_owned"),
        (&one, &no_origin, "message_not_owned"),
    ] {
        assert_refused(service.delete_message(session, id, 40).await, expected);
    }
    assert_eq!(service.log(&one, None, 20).unwrap(), one_log);
    assert_eq!(service.log(&two, None, 20).unwrap(), two_log);
    assert_eq!(user(&service, &direct), consumed);
    assert_eq!(service.message(&synthetic).unwrap(), synthetic_row);
    assert_eq!(service.message(&no_origin).unwrap(), unattributed_row);
    assert_eq!(service.pending(&pending).unwrap(), pending_row);
    assert!(service.message(&pending).unwrap().is_none());
    assert!(
        service
            .control_pending(&one, &pending, Control::Remove, 41)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn removal_and_steering_change_only_unconsumed_user_inputs() {
    let store = support::store();
    let service = Service::new(store.client());
    let one = session::Id::new("ses_one").unwrap();
    let two = session::Id::new("ses_two").unwrap();
    let id = admit(
        &service,
        "user",
        r#"{"type":"user","data":{"text":"queued"},"delivery":"queue"}"#,
    )
    .await;
    assert!(matches!(
        service
            .control_pending(&two, &id, Control::Remove, 20)
            .await,
        Err(ycoding_store::Error::Domain {
            kind: "pending_input_not_found",
            ..
        })
    ));
    assert!(
        service
            .control_pending(&one, &id, Control::Steer, 20)
            .await
            .unwrap()
    );
    assert!(
        !service
            .control_pending(&one, &id, Control::Steer, 21)
            .await
            .unwrap()
    );
    let pending = service.pending_list(&one).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].delivery, Some("steer".into()));
    assert!(
        service
            .control_pending(&one, &id, Control::Remove, 22)
            .await
            .unwrap()
    );
    assert!(service.pending_list(&one).unwrap().is_empty());
    assert!(matches!(
        service
            .control_pending(&one, &id, Control::Remove, 23)
            .await,
        Err(ycoding_store::Error::Domain {
            kind: "pending_input_not_found",
            ..
        })
    ));
    let id = admit(
        &service,
        "promoted",
        r#"{"type":"user","data":{"text":"promoted"},"delivery":"queue"}"#,
    )
    .await;
    assert!(service.promote_next_queued(&one, 30).await.unwrap());
    assert!(matches!(
        service.control_pending(&one, &id, Control::Steer, 31).await,
        Err(ycoding_store::Error::Domain {
            kind: "pending_input_not_found",
            ..
        })
    ));
    let id = admit(
        &service,
        "synthetic",
        r#"{"type":"synthetic","data":{"text":"internal"},"delivery":"queue"}"#,
    )
    .await;
    for control in [Control::Remove, Control::Steer] {
        assert!(matches!(
            service.control_pending(&one, &id, control, 40).await,
            Err(ycoding_store::Error::Domain {
                kind: "pending_input_invalid",
                ..
            })
        ));
    }
}

#[tokio::test]
async fn withdrawal_and_promotion_share_one_inbox_lock() {
    let store = support::store();
    let service = Service::new(store.client());
    let one = session::Id::new("ses_one").unwrap();
    let id = admit(
        &service,
        "race",
        r#"{"type":"user","data":{"text":"race"},"delivery":"queue"}"#,
    )
    .await;
    let (removed, promoted) = tokio::join!(
        service.control_pending(&one, &id, Control::Remove, 20),
        service.promote_next_queued(&one, 21)
    );
    match (removed, promoted.unwrap()) {
        (Ok(true), false) => {}
        (
            Err(ycoding_store::Error::Domain {
                kind: "pending_input_not_found",
                ..
            }),
            true,
        ) => {}
        result => panic!("inconsistent withdrawal/promotion: {result:?}"),
    }
    assert!(service.pending_list(&one).unwrap().is_empty());
}
