use super::*;
use crate::{coordination, event_feed::Feed};
use ycoding_schema::{JsonObject, JsonValue, coordination as c, model};

async fn fixture() -> (
    ycoding_store::Store,
    Service,
    coordination::Service,
    coordination::Group,
) {
    let store = crate::test_support::store();
    let sessions = Service::new(store.client());
    let projects = coordination::Service::new(store.client(), Feed::attach(&store.client()));
    let group = projects
        .create(c::CreateInput {
            name: "Admission checks".into(),
            master_session_id: session::Id::new("ses_one").unwrap(),
            member_session_ids: vec![session::Id::new("ses_two").unwrap()],
        })
        .await
        .unwrap();
    (store, sessions, projects, group)
}

fn request(id: &str) -> Request {
    let mut metadata = JsonObject::new();
    metadata.insert("inputOrigin".into(), "direct".encode());
    metadata.insert("nativeSource".into(), "forged".encode());
    metadata.insert("sharedContext".into(), "forged".encode());
    metadata.insert("coordination".into(), "forged".encode());
    metadata.insert("syntheticLabel".into(), "kept".encode());
    Request {
        id: session_message::Id::new(id).unwrap(),
        session_id: session::Id::new("ses_two").unwrap(),
        input: session_pending::Message::User(session_pending::UserMessage {
            delivery: ycoding_schema::session_delivery::Delivery::Queue,
            data: session_pending::UserData {
                text: "Perform bounded work".into(),
                files: None,
                agents: None,
                metadata: Some(metadata),
            },
        }),
        event_id: super::super::projector::random_event_id().unwrap(),
        created: 2,
    }
}

fn admission(
    group: &coordination::Group,
    request: &Request,
    model: &str,
) -> coordination::Admission {
    coordination::Admission {
        group_id: group.id.clone(),
        master_session_id: group.master_session_id.clone(),
        sender_session_id: group.master_session_id.clone(),
        message_id: request.id.clone(),
        model: Some(
            model::Ref::decode(
                &ObjectEncoder::new()
                    .field("providerID", "demo")
                    .field("id", model)
                    .finish(),
            )
            .unwrap(),
        ),
    }
}

#[tokio::test]
async fn coordination_admission_stamps_once_and_reconciles_pinned_provenance() {
    let (_store, sessions, _projects, group) = fixture().await;
    let input = request("msg_coordination_first");
    let claim = admission(&group, &input, "first-model");
    let first = sessions
        .admit_input_checked(
            input.clone(),
            None,
            Some(CheckedAdmission::Coordination(Box::new(claim.clone()))),
        )
        .await
        .unwrap();
    assert!(first.fresh);
    let data = session_pending::UserData::decode(&first.pending.data).unwrap();
    let metadata = data.metadata.unwrap();
    assert_eq!(
        metadata.get(&"inputOrigin".into()),
        Some(&JsonValue::String("coordination".into()))
    );
    assert!(metadata.get(&"sharedContext".into()).is_none());
    assert!(metadata.get(&"nativeSource".into()).is_none());
    assert_eq!(
        metadata.get(&"syntheticLabel".into()),
        Some(&JsonValue::String("kept".into()))
    );
    let expected = ObjectEncoder::new()
        .field("groupID", &claim.group_id)
        .field("masterSessionID", &claim.master_session_id)
        .field("senderSessionID", &claim.sender_session_id)
        .field("messageID", &claim.message_id)
        .optional("model", &claim.model)
        .finish();
    assert_eq!(metadata.get(&"coordination".into()), Some(&expected));
    let changed = admission(&group, &input, "later-model");
    let retry = sessions
        .admit_input_checked(
            input,
            None,
            Some(CheckedAdmission::Coordination(Box::new(changed))),
        )
        .await
        .unwrap();
    assert!(!retry.fresh);
    assert_eq!(retry.pending.data, first.pending.data);
    assert_eq!(retry.pending.admitted_seq, first.pending.admitted_seq);
}

#[tokio::test]
async fn coordination_admission_rechecks_message_master_and_current_membership_in_writer() {
    let (_store, sessions, projects, group) = fixture().await;
    let input = request("msg_coordination_rejected");
    let mut claim = admission(&group, &input, "first-model");
    claim.message_id = session_message::Id::new("msg_other").unwrap();
    assert!(
        sessions
            .admit_input_checked(
                input.clone(),
                None,
                Some(CheckedAdmission::Coordination(Box::new(claim)))
            )
            .await
            .is_err()
    );
    let mut claim = admission(&group, &input, "first-model");
    claim.master_session_id = session::Id::new("ses_two").unwrap();
    assert!(
        sessions
            .admit_input_checked(
                input.clone(),
                None,
                Some(CheckedAdmission::Coordination(Box::new(claim)))
            )
            .await
            .is_err()
    );
    let claim = admission(&group, &input, "first-model");
    projects.delete(&group.id).await.unwrap();
    assert!(
        sessions
            .admit_input_checked(
                input.clone(),
                None,
                Some(CheckedAdmission::Coordination(Box::new(claim)))
            )
            .await
            .is_err()
    );
    assert!(sessions.pending(&input.id).unwrap().is_none());
    assert!(sessions.message(&input.id).unwrap().is_none());
}
