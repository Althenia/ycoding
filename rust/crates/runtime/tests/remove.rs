mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::*;
use tokio::time::timeout;
use ycoding_core::ycoding_schema::{parse_json, session};
use ycoding_core::ycoding_store::session::NewEvent;
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

fn remove_request(session: &str) -> Vec<u8> {
    v5::SessionRemoveRequest {
        params: v5::SessionRemoveRequestParams {
            session_id: text(session),
        },
    }
    .encode_to_vec()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_remove_deletes_the_family_and_reports_unknown_sessions() {
    timeout(Duration::from_secs(60), async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let sessions = &world().core.sessions;
        sessions
            .create(NewEvent {
                id: "evt_create_doomed_kid".into(),
                aggregate_id: "ses_doomed_kid".into(),
                created: 5,
                type_: "session.created.2".into(),
                data: parse_json(
                    r#"{"sessionID":"ses_doomed_kid","projectID":"prj_one","location":{"directory":"/project"},"title":"Kid","created":5,"parentID":"ses_doomed"}"#,
                )
                .unwrap(),
            })
            .await
            .unwrap();
        let id = |value: &str| session::Id::new(value).unwrap();

        let removed: v5::SessionRemoveResult = success(
            client
                .call(
                    "session.remove",
                    session_scope("ses_doomed"),
                    remove_request("ses_doomed"),
                )
                .await,
        );
        assert_eq!(removed.data, v5::Empty {});
        assert!(sessions.get(&id("ses_doomed")).unwrap().is_none());
        assert!(sessions.get(&id("ses_doomed_kid")).unwrap().is_none());
        assert!(sessions.get(&id("ses_doomed_two")).unwrap().is_some());

        let again = rejected(
            client
                .call(
                    "session.remove",
                    session_scope("ses_doomed"),
                    remove_request("ses_doomed"),
                )
                .await,
        );
        assert_eq!(again.type_name, v5::SessionNotFoundError::full_name());
        assert!(
            operation("session.remove")
                .error_types
                .contains(&again.type_name)
        );
        server.shutdown().await.unwrap();
    })
    .await
    .expect("test exceeded its time bound");
}
