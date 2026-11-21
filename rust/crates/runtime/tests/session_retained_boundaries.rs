mod support;

#[path = "../../core/tests/session_support/checkpoint.rs"]
mod checkpoint;

use support::{wire::*, *};
use ycoding_core::session::store::Service;
use ycoding_protocol::v5;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v5_fork_and_revert_roundtrip_history_pruned_error() {
    let store = world().store.clone();
    let sessions = Service::new(store.clone());
    let scenario = checkpoint::scenario(&store, &sessions, "ses_pruned_socket", 1).await;
    sessions
        .prune_compacted(&scenario.session, 2, Vec::new)
        .await
        .unwrap();
    let before = sessions.transcript(&scenario.session).unwrap();
    let (server, mut client) = open().await;
    for message in [
        &scenario.ids.first_user,
        &scenario.ids.covered_user,
        &scenario.ids.boundary,
        "msg_unknown",
    ] {
        let fork: v5::HistoryPrunedError = refuse(
            &mut client,
            "session.fork",
            session_scope("ses_pruned_socket"),
            v5::SessionForkRequest {
                params: v5::SessionForkRequestParams {
                    session_id: text("ses_pruned_socket"),
                },
                payload: v5::SessionForkRequestPayload {
                    message_id: Some(text(message)),
                },
            },
        )
        .await;
        let revert: v5::HistoryPrunedError = refuse(
            &mut client,
            "session.revert.stage",
            session_scope("ses_pruned_socket"),
            v5::SessionRevertStageRequest {
                params: v5::SessionRevertStageRequestParams {
                    session_id: text("ses_pruned_socket"),
                },
                payload: v5::SessionRevertStageRequestPayload {
                    message_id: text(message),
                    files: Some(true),
                },
            },
        )
        .await;
        assert_eq!(fork, revert);
        assert_eq!(fork.tag, 1);
        assert_eq!(units(&fork.session_id), "ses_pruned_socket");
        assert_eq!(units(&fork.message_id), *message);
        assert_eq!(
            units(&fork.message),
            format!(
                "Message {message} is not in the retained history of session ses_pruned_socket; history through the compaction checkpoint was removed"
            )
        );
        assert_eq!(sessions.transcript(&scenario.session).unwrap(), before);
        assert!(
            sessions
                .get(&scenario.session)
                .unwrap()
                .unwrap()
                .revert
                .is_none()
        );
    }
    let message = ycoding_protocol::encode_lossless(
        &"msg_".encode_utf16().chain([0xd800]).collect::<Vec<_>>(),
    );
    let fork: v5::HistoryPrunedError = refuse(
        &mut client,
        "session.fork",
        session_scope("ses_pruned_socket"),
        v5::SessionForkRequest {
            params: v5::SessionForkRequestParams {
                session_id: text("ses_pruned_socket"),
            },
            payload: v5::SessionForkRequestPayload {
                message_id: Some(message.clone()),
            },
        },
    )
    .await;
    let revert: v5::HistoryPrunedError = refuse(
        &mut client,
        "session.revert.stage",
        session_scope("ses_pruned_socket"),
        v5::SessionRevertStageRequest {
            params: v5::SessionRevertStageRequestParams {
                session_id: text("ses_pruned_socket"),
            },
            payload: v5::SessionRevertStageRequestPayload {
                message_id: message.clone(),
                files: Some(true),
            },
        },
    )
    .await;
    assert_eq!(fork, revert);
    assert_eq!(fork.message_id, message);
    assert_eq!(fork.message, ycoding_protocol::encode_lossless(&"Message msg_".encode_utf16().chain([0xd800]).chain(" is not in the retained history of session ses_pruned_socket; history through the compaction checkpoint was removed".encode_utf16()).collect::<Vec<_>>()));
    assert_eq!(sessions.transcript(&scenario.session).unwrap(), before);
    assert!(
        sessions
            .get(&scenario.session)
            .unwrap()
            .unwrap()
            .revert
            .is_none()
    );
    server.shutdown().await.unwrap();
}
